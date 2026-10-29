"""Sync for offline mode.

The phone keeps its own copy of all folders and words and records every
change in a queue. When it is online it sends the queue here; the server
applies the changes in order and answers with what changed since the
phone's last sync (or everything, the first time).

    phone -> {ops: [...], since: <cursor>}
    server -> {changed decks/cards, deleted uids, cursor: <new cursor>}
"""
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends
from sqlalchemy import delete, select
from sqlalchemy.orm import Session

from .. import srs
from ..database import get_db
from ..models import AppliedOp, Card, Deck, Deletion, User, record_deletion
from ..schemas import RejectedOp, SyncCard, SyncDeck, SyncIn, SyncOp, SyncOut
from ..security import get_current_user
from ..timeutil import utcnow

router = APIRouter(tags=["sync"])

KEEP_HISTORY_DAYS = 90  # applied ops and deletions are kept this long
# Look a bit further back than the cursor: a request from another device that
# started earlier may have saved its changes after our cursor was taken.
SAFETY_WINDOW = timedelta(seconds=30)


class OpError(Exception):
    """A change that can't be applied. It is reported back and dropped."""


def iso(dt: datetime) -> str:
    """Naive UTC datetime -> '2026-10-29T10:00:00.000Z' that every browser parses."""
    return dt.isoformat(timespec="milliseconds") + "Z"


def to_utc(dt: datetime | None, now: datetime) -> datetime:
    if dt is None:
        return now
    if dt.tzinfo is not None:
        dt = dt.astimezone(timezone.utc).replace(tzinfo=None)
    return min(dt, now)  # a phone clock in the future must not push words far ahead


def clean(value: str | None, max_len: int, field: str, required: bool = True) -> str | None:
    value = (value or "").strip()
    if not value:
        if required:
            raise OpError(f"{field} is empty")
        return None
    if len(value) > max_len:
        raise OpError(f"{field} is too long")
    return value


def find_deck(db: Session, user: User, uid: str | None) -> Deck | None:
    deck = db.scalar(select(Deck).where(Deck.uid == uid)) if uid else None
    if deck is not None and deck.user_id != user.id:
        raise OpError("folder belongs to another user")
    return deck


def find_card(db: Session, user: User, uid: str) -> Card | None:
    card = db.scalar(select(Card).where(Card.uid == uid))
    if card is not None and card.deck.user_id != user.id:
        raise OpError("word belongs to another user")
    return card


def apply_op(db: Session, user: User, op: SyncOp, now: datetime) -> None:
    at = to_utc(op.at, now)

    if op.type == "deck_upsert":
        name = clean(op.name, 80, "name")
        deck = find_deck(db, user, op.uid)
        if deck is None:
            db.add(Deck(uid=op.uid, user_id=user.id, name=name, lang_code=op.lang_code or None, created_at=at))
        else:
            deck.name, deck.lang_code = name, op.lang_code or None

    elif op.type == "deck_delete":
        deck = find_deck(db, user, op.uid)
        if deck is not None:
            record_deletion(db, user.id, "deck", deck.uid)
            db.delete(deck)

    elif op.type == "card_upsert":
        front = clean(op.front, 200, "word")
        back = clean(op.back, 200, "translation")
        example = clean(op.example, 1000, "example", required=False)
        example_tr = clean(op.example_translation, 1000, "example translation", required=False)
        card = find_card(db, user, op.uid)
        if card is None:
            deck = find_deck(db, user, op.deck_uid)
            if deck is None:
                raise OpError("folder was deleted")
            db.add(
                Card(
                    uid=op.uid, deck_id=deck.id, front=front, back=back, example=example,
                    example_translation=example_tr, created_at=at, due_at=at,
                )
            )
        else:
            card.front, card.back = front, back
            card.example, card.example_translation = example, example_tr

    elif op.type == "card_delete":
        card = find_card(db, user, op.uid)
        if card is not None:
            record_deletion(db, user.id, "card", card.uid)
            db.delete(card)

    elif op.type == "card_review":
        if op.known is None:
            raise OpError("answer is missing")
        card = find_card(db, user, op.uid)
        if card is None:
            return  # word deleted on another device - nothing to do
        result = srs.review(card.box, op.known, at)
        card.box, card.status, card.due_at = result.box, result.status, result.due_at
        card.last_reviewed_at = at
        if op.known:
            card.times_correct += 1
        else:
            card.times_wrong += 1

    elif op.type == "card_reset":
        card = find_card(db, user, op.uid)
        if card is not None:
            card.box, card.status, card.due_at = 0, srs.NEW, at


def deck_out(d: Deck) -> SyncDeck:
    return SyncDeck(uid=d.uid, name=d.name, lang_code=d.lang_code, created_at=iso(d.created_at))


def card_out(c: Card, deck_uid: str) -> SyncCard:
    return SyncCard(
        uid=c.uid, deck_uid=deck_uid, front=c.front, back=c.back, example=c.example,
        example_translation=c.example_translation, box=c.box, status=c.status, due_at=iso(c.due_at),
        times_correct=c.times_correct, times_wrong=c.times_wrong, created_at=iso(c.created_at),
    )


def changes_since(db: Session, user: User, since: datetime | None):
    """Folders and words changed after `since` (everything if None), plus deletions."""
    deck_q = select(Deck).where(Deck.user_id == user.id)
    card_q = select(Card, Deck.uid).join(Deck).where(Deck.user_id == user.id)
    deleted_decks: list[str] = []
    deleted_cards: list[str] = []
    if since is not None:
        deck_q = deck_q.where(Deck.updated_at >= since)
        card_q = card_q.where(Card.updated_at >= since)
        for kind, uid in db.execute(
            select(Deletion.kind, Deletion.uid).where(Deletion.user_id == user.id, Deletion.deleted_at >= since)
        ):
            (deleted_decks if kind == "deck" else deleted_cards).append(uid)

    decks = [deck_out(d) for d in db.scalars(deck_q.order_by(Deck.created_at, Deck.id))]
    cards = [card_out(c, deck_uid) for c, deck_uid in db.execute(card_q.order_by(Card.created_at, Card.id))]
    return decks, cards, deleted_decks, deleted_cards


@router.post("/sync", response_model=SyncOut)
def sync(data: SyncIn, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    now = utcnow()  # taken before any change, becomes the next cursor
    op_ids = [op.op_id for op in data.ops]
    done = set(
        db.scalars(select(AppliedOp.op_id).where(AppliedOp.user_id == user.id, AppliedOp.op_id.in_(op_ids)))
    ) if op_ids else set()

    rejected: list[RejectedOp] = []
    for op in data.ops:
        if op.op_id in done:
            continue
        try:
            # apply_op checks everything first and only then changes data,
            # so a rejected change leaves nothing half-done.
            apply_op(db, user, op, now)
        except OpError as e:
            rejected.append(RejectedOp(op_id=op.op_id, reason=str(e)))
        db.add(AppliedOp(user_id=user.id, op_id=op.op_id))
        done.add(op.op_id)
        db.flush()  # later changes in this batch must see this one

    history_start = now - timedelta(days=KEEP_HISTORY_DAYS)
    db.execute(delete(AppliedOp).where(AppliedOp.user_id == user.id, AppliedOp.created_at < history_start))
    db.execute(delete(Deletion).where(Deletion.user_id == user.id, Deletion.deleted_at < history_start))
    db.commit()

    since = to_utc(data.since, now) - SAFETY_WINDOW if data.since else None
    full = since is None or since < history_start  # deletions that old are forgotten: send everything
    decks, cards, deleted_decks, deleted_cards = changes_since(db, user, None if full else since)
    return SyncOut(
        full=full, decks=decks, cards=cards, deleted_decks=deleted_decks, deleted_cards=deleted_cards,
        rejected=rejected, cursor=iso(now),
    )
