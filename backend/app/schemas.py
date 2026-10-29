"""Request and response shapes for the API."""
from datetime import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator


def _strip(v: str | None) -> str | None:
    return v.strip() if isinstance(v, str) else v


# ---- auth ----
class Credentials(BaseModel):
    username: str = Field(min_length=3, max_length=50, pattern=r"^[A-Za-z0-9_.-]+$")
    password: str = Field(min_length=6, max_length=128)

    _s = field_validator("username", mode="before")(_strip)


class TokenOut(BaseModel):
    access_token: str
    token_type: str = "bearer"
    username: str


class UserOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    username: str


# ---- decks ----
class DeckIn(BaseModel):
    name: str = Field(min_length=1, max_length=80)
    lang_code: str | None = Field(default=None, max_length=16)

    _s = field_validator("name", "lang_code", mode="before")(_strip)


class DeckStats(BaseModel):
    total: int = 0
    new: int = 0
    learning: int = 0
    forgotten: int = 0
    learned: int = 0
    due: int = 0


class DeckOut(BaseModel):
    id: int
    name: str
    lang_code: str | None
    stats: DeckStats


# ---- cards ----
class CardIn(BaseModel):
    front: str = Field(min_length=1, max_length=200)
    back: str = Field(min_length=1, max_length=200)
    example: str | None = Field(default=None, max_length=1000)
    example_translation: str | None = Field(default=None, max_length=1000)

    _s = field_validator("front", "back", "example", "example_translation", mode="before")(_strip)


class CardUpdate(BaseModel):
    front: str | None = Field(default=None, min_length=1, max_length=200)
    back: str | None = Field(default=None, min_length=1, max_length=200)
    example: str | None = Field(default=None, max_length=1000)
    example_translation: str | None = Field(default=None, max_length=1000)

    _s = field_validator("front", "back", "example", "example_translation", mode="before")(_strip)


class CardOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    deck_id: int
    front: str
    back: str
    example: str | None
    example_translation: str | None
    box: int
    status: str
    due_at: datetime
    times_correct: int
    times_wrong: int


class BulkIn(BaseModel):
    text: str = Field(max_length=100_000)


class BulkOut(BaseModel):
    added: int
    skipped_duplicates: list[str]
    errors: list[str]


class ReviewIn(BaseModel):
    known: bool


StudyMode = Literal["due", "forgotten", "learned", "all"]


# ---- sync (offline mode) ----
OpType = Literal["deck_upsert", "deck_delete", "card_upsert", "card_delete", "card_review", "card_reset"]


class SyncOp(BaseModel):
    """One change made on the phone, maybe while offline."""

    op_id: str = Field(min_length=8, max_length=64)  # unique per change, to skip repeats
    type: OpType
    at: datetime | None = None  # when it happened on the phone
    uid: str = Field(min_length=8, max_length=36)  # the folder or word it is about
    deck_uid: str | None = Field(default=None, max_length=36)
    name: str | None = Field(default=None, max_length=200)
    lang_code: str | None = Field(default=None, max_length=16)
    front: str | None = Field(default=None, max_length=1000)
    back: str | None = Field(default=None, max_length=1000)
    example: str | None = Field(default=None, max_length=1000)
    example_translation: str | None = Field(default=None, max_length=1000)
    known: bool | None = None


class SyncIn(BaseModel):
    ops: list[SyncOp] = Field(default_factory=list, max_length=2000)
    # The "cursor" from the previous sync. Empty = send everything.
    since: datetime | None = None


class SyncDeck(BaseModel):
    uid: str
    name: str
    lang_code: str | None
    created_at: str


class SyncCard(BaseModel):
    uid: str
    deck_uid: str
    front: str
    back: str
    example: str | None
    example_translation: str | None
    box: int
    status: str
    due_at: str
    times_correct: int
    times_wrong: int
    created_at: str


class RejectedOp(BaseModel):
    op_id: str
    reason: str


class SyncOut(BaseModel):
    full: bool  # true = this is everything, replace the local copy; false = only changes
    decks: list[SyncDeck]
    cards: list[SyncCard]
    deleted_decks: list[str]
    deleted_cards: list[str]
    rejected: list[RejectedOp]
    cursor: str  # send it back as "since" next time
