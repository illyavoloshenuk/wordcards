"""Edit, delete and answer single cards."""
from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session

from .. import srs
from ..database import get_db
from ..models import Card, Deck, User
from ..schemas import CardOut, CardUpdate, ReviewIn
from ..security import get_current_user
from ..timeutil import utcnow

router = APIRouter(prefix="/cards", tags=["cards"])


def get_own_card(card_id: int, user: User, db: Session) -> Card:
    card = db.get(Card, card_id)
    if card is None or db.get(Deck, card.deck_id).user_id != user.id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Слово не найдено")
    return card


@router.patch("/{card_id}", response_model=CardOut)
def update_card(
    card_id: int, data: CardUpdate, user: User = Depends(get_current_user), db: Session = Depends(get_db)
):
    card = get_own_card(card_id, user, db)
    changes = data.model_dump(exclude_unset=True)
    for field in ("front", "back"):
        if changes.get(field):
            setattr(card, field, changes[field])
    for field in ("example", "example_translation"):
        if field in changes:
            setattr(card, field, changes[field] or None)  # empty text removes it
    db.commit()
    return card


@router.delete("/{card_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_card(card_id: int, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    db.delete(get_own_card(card_id, user, db))
    db.commit()


@router.post("/{card_id}/review", response_model=CardOut)
def review_card(
    card_id: int, data: ReviewIn, user: User = Depends(get_current_user), db: Session = Depends(get_db)
):
    """The user answered "I know it" or "I forgot" - move the word to its next box."""
    card = get_own_card(card_id, user, db)
    now = utcnow()
    result = srs.review(card.box, data.known, now)

    card.box, card.status, card.due_at = result.box, result.status, result.due_at
    card.last_reviewed_at = now
    if data.known:
        card.times_correct += 1
    else:
        card.times_wrong += 1
    db.commit()
    return card


@router.post("/{card_id}/reset", response_model=CardOut)
def reset_card(card_id: int, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    """Start learning a word from scratch."""
    card = get_own_card(card_id, user, db)
    card.box, card.status, card.due_at = 0, srs.NEW, utcnow()
    db.commit()
    return card
