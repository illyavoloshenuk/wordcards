"""Database tables: users, decks (one per language) and cards (words)."""
import uuid
from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, Integer, String, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column, relationship

from .database import Base
from .timeutil import utcnow


def new_uid() -> str:
    return str(uuid.uuid4())


class User(Base):
    __tablename__ = "users"

    id: Mapped[int] = mapped_column(primary_key=True)
    username: Mapped[str] = mapped_column(String(50), unique=True, index=True)
    password_hash: Mapped[str] = mapped_column(String(255))
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)

    decks: Mapped[list["Deck"]] = relationship(
        back_populates="owner", cascade="all, delete-orphan"
    )


class Deck(Base):
    """A folder of words, usually one language (German, English, Chinese...)."""

    __tablename__ = "decks"

    id: Mapped[int] = mapped_column(primary_key=True)
    # Public ID. The phone creates it itself, so folders can be made offline.
    uid: Mapped[str | None] = mapped_column(String(36), unique=True, index=True, default=new_uid)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    name: Mapped[str] = mapped_column(String(80))
    # BCP-47 code used for pronunciation in the browser, e.g. "de-DE".
    lang_code: Mapped[str | None] = mapped_column(String(16), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)
    # Changes on every edit, so sync can send only what changed (see routers/sync.py).
    updated_at: Mapped[datetime | None] = mapped_column(DateTime, default=utcnow, onupdate=utcnow, index=True)

    owner: Mapped[User] = relationship(back_populates="decks")
    cards: Mapped[list["Card"]] = relationship(
        back_populates="deck", cascade="all, delete-orphan"
    )


class Card(Base):
    """One word: the foreign word, its translation and an optional example."""

    __tablename__ = "cards"

    id: Mapped[int] = mapped_column(primary_key=True)
    uid: Mapped[str | None] = mapped_column(String(36), unique=True, index=True, default=new_uid)
    deck_id: Mapped[int] = mapped_column(ForeignKey("decks.id", ondelete="CASCADE"), index=True)
    front: Mapped[str] = mapped_column(String(200))  # word in the foreign language
    back: Mapped[str] = mapped_column(String(200))  # translation
    example: Mapped[str | None] = mapped_column(Text, nullable=True)
    example_translation: Mapped[str | None] = mapped_column(Text, nullable=True)

    # Spaced-repetition state, see srs.py
    box: Mapped[int] = mapped_column(Integer, default=0)
    status: Mapped[str] = mapped_column(String(16), default="new", index=True)
    due_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, index=True)
    last_reviewed_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    times_correct: Mapped[int] = mapped_column(Integer, default=0)
    times_wrong: Mapped[int] = mapped_column(Integer, default=0)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)
    updated_at: Mapped[datetime | None] = mapped_column(DateTime, default=utcnow, onupdate=utcnow, index=True)

    deck: Mapped[Deck] = relationship(back_populates="cards")


class AppliedOp(Base):
    """Changes from the phone that were already saved.

    If the phone sends the same change twice (the answer got lost on a bad
    connection), it is skipped instead of counted again.
    """

    __tablename__ = "applied_ops"
    __table_args__ = (UniqueConstraint("user_id", "op_id"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    op_id: Mapped[str] = mapped_column(String(64))
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, index=True)


class Deletion(Base):
    """A note that a folder or word was deleted.

    Sync sends only what changed; for deleted things there is no row left,
    so this note tells the other devices to remove them too.
    """

    __tablename__ = "deletions"

    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    kind: Mapped[str] = mapped_column(String(8))  # "deck" or "card"
    uid: Mapped[str] = mapped_column(String(36))
    deleted_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, index=True)


def record_deletion(db, user_id: int, kind: str, uid: str | None) -> None:
    if uid:
        db.add(Deletion(user_id=user_id, kind=kind, uid=uid))
