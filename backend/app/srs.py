"""Spaced repetition - the Leitner box system.

Every word sits in a "box" from 0 to 5:

    box 0      new word, never answered
    box 1..4   being learned; the higher the box, the longer the pause
    box 5      learned

Answer "I know it"  -> the word moves one box up and comes back later.
Answer "I forgot"   -> the word drops back to box 1 and is marked "forgotten".

Inside a single lesson, forgotten words are also shown again a few cards
later - that part lives in the frontend (see frontend/app.js, requeue()).
"""
from dataclasses import dataclass
from datetime import datetime, timedelta

LEARNED_BOX = 5

# How many days to wait before showing a word again, per box.
INTERVAL_DAYS = {1: 1, 2: 3, 3: 7, 4: 14, 5: 30}

NEW, LEARNING, FORGOTTEN, LEARNED = "new", "learning", "forgotten", "learned"
STATUSES = (NEW, LEARNING, FORGOTTEN, LEARNED)


@dataclass(frozen=True)
class ReviewResult:
    box: int
    status: str
    due_at: datetime


def review(box: int, known: bool, now: datetime) -> ReviewResult:
    """Return the new state of a word after the user answered it."""
    if not known:
        # Forgotten: start again, but it is due right away so it shows up
        # in the next lesson instead of waiting a day.
        return ReviewResult(box=1, status=FORGOTTEN, due_at=now)

    new_box = min(box + 1, LEARNED_BOX)
    status = LEARNED if new_box == LEARNED_BOX else LEARNING
    return ReviewResult(box=new_box, status=status, due_at=now + timedelta(days=INTERVAL_DAYS[new_box]))
