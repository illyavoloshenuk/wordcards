from datetime import datetime, timezone


def utcnow() -> datetime:
    """Current UTC time without tzinfo (SQLite stores naive datetimes)."""
    return datetime.now(timezone.utc).replace(tzinfo=None)
