"""Decks (language folders), the words inside them, and lessons."""
from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import case, func, select
from sqlalchemy.orm import Session

from .. import srs
from ..database import get_db
from ..models import Card, Deck, User
from ..schemas import BulkIn, BulkOut, CardIn, CardOut, DeckIn, DeckOut, DeckStats, StudyMode
from ..security import get_current_user
from ..timeutil import utcnow
from ..word_parser import parse_word_list

router = APIRouter(prefix="/decks", tags=["decks"])


def get_own_deck(deck_id: int, user: User, db: Session) -> Deck:
    deck = db.get(Deck, deck_id)
    if deck is None or deck.user_id != user.id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Папка не найдена")
    return deck


def stats_for(db: Session, deck_ids: list[int]) -> dict[int, DeckStats]:
    """Count words per status for each deck in a single query."""
    stats = {deck_id: DeckStats() for deck_id in deck_ids}
    if not deck_ids:
        return stats
    now = utcnow()
    rows = db.execute(
        select(
            Card.deck_id,
            Card.status,
            func.count(),
            func.sum(case((Card.due_at <= now, 1), else_=0)),
        )
        .where(Card.deck_id.in_(deck_ids))
        .group_by(Card.deck_id, Card.status)
    )
    for deck_id, card_status, count, due in rows:
        s = stats[deck_id]
        setattr(s, card_status, count)
        s.total += count
        s.due += due or 0
    return stats


def to_out(deck: Deck, stats: DeckStats) -> DeckOut:
    return DeckOut(id=deck.id, name=deck.name, lang_code=deck.lang_code, stats=stats)


# ---- decks ----
@router.get("", response_model=list[DeckOut])
def list_decks(user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    decks = db.scalars(select(Deck).where(Deck.user_id == user.id).order_by(Deck.created_at)).all()
    stats = stats_for(db, [d.id for d in decks])
    return [to_out(d, stats[d.id]) for d in decks]


@router.post("", response_model=DeckOut, status_code=status.HTTP_201_CREATED)
def create_deck(data: DeckIn, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    deck = Deck(user_id=user.id, name=data.name, lang_code=data.lang_code or None)
    db.add(deck)
    db.commit()
    return to_out(deck, DeckStats())


@router.get("/{deck_id}", response_model=DeckOut)
def get_deck(deck_id: int, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    deck = get_own_deck(deck_id, user, db)
    return to_out(deck, stats_for(db, [deck.id])[deck.id])


@router.put("/{deck_id}", response_model=DeckOut)
def update_deck(
    deck_id: int, data: DeckIn, user: User = Depends(get_current_user), db: Session = Depends(get_db)
):
    deck = get_own_deck(deck_id, user, db)
    deck.name = data.name
    deck.lang_code = data.lang_code or None
    db.commit()
    return to_out(deck, stats_for(db, [deck.id])[deck.id])


@router.delete("/{deck_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_deck(deck_id: int, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    db.delete(get_own_deck(deck_id, user, db))
    db.commit()


# ---- words inside a deck ----
@router.get("/{deck_id}/cards", response_model=list[CardOut])
def list_cards(
    deck_id: int,
    card_status: str | None = Query(default=None, alias="status"),
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    get_own_deck(deck_id, user, db)
    query = select(Card).where(Card.deck_id == deck_id)
    if card_status:
        if card_status not in srs.STATUSES:
            raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "Неизвестный статус")
        query = query.where(Card.status == card_status)
    return db.scalars(query.order_by(Card.created_at.desc(), Card.id.desc())).all()


@router.post("/{deck_id}/cards", response_model=CardOut, status_code=status.HTTP_201_CREATED)
def add_card(
    deck_id: int, data: CardIn, user: User = Depends(get_current_user), db: Session = Depends(get_db)
):
    get_own_deck(deck_id, user, db)
    card = Card(
        deck_id=deck_id,
        front=data.front,
        back=data.back,
        example=data.example or None,
        example_translation=data.example_translation or None,
    )
    db.add(card)
    db.commit()
    return card


@router.post("/{deck_id}/cards/bulk", response_model=BulkOut)
def add_cards_bulk(
    deck_id: int, data: BulkIn, user: User = Depends(get_current_user), db: Session = Depends(get_db)
):
    """Add many words at once from a pasted list (see word_parser.py)."""
    get_own_deck(deck_id, user, db)
    parsed = parse_word_list(data.text)

    existing = {f.lower() for f in db.scalars(select(Card.front).where(Card.deck_id == deck_id))}
    skipped: list[str] = []
    added = 0
    for word in parsed.words:
        key = word.front.lower()
        if key in existing:
            skipped.append(word.front)
            continue
        existing.add(key)
        db.add(
            Card(
                deck_id=deck_id,
                front=word.front,
                back=word.back,
                example=word.example,
                example_translation=word.example_translation,
            )
        )
        added += 1
    db.commit()
    return BulkOut(added=added, skipped_duplicates=skipped, errors=parsed.errors)


# ---- lessons ----
@router.get("/{deck_id}/study", response_model=list[CardOut])
def study(
    deck_id: int,
    mode: StudyMode = "due",
    limit: int = Query(default=20, ge=1, le=200),
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Cards for one lesson.

    due        words whose time has come (forgotten first, then learning, then new)
    forgotten  only words the user forgot
    learned    words already learned, shuffled - to refresh them
    all        every word, shuffled
    """
    get_own_deck(deck_id, user, db)
    query = select(Card).where(Card.deck_id == deck_id)

    if mode == "due":
        priority = case(
            (Card.status == srs.FORGOTTEN, 0),
            (Card.status == srs.LEARNING, 1),
            (Card.status == srs.LEARNED, 2),
            else_=3,
        )
        query = query.where(Card.due_at <= utcnow()).order_by(priority, Card.due_at, Card.id)
    elif mode in (srs.FORGOTTEN, srs.LEARNED):
        query = query.where(Card.status == mode).order_by(func.random())
    else:
        query = query.order_by(func.random())

    return db.scalars(query.limit(limit)).all()
