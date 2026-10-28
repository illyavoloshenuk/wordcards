"""App settings, read from environment variables (see .env.example)."""
import os
import warnings
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent.parent  # backend/
PROJECT_DIR = BASE_DIR.parent  # repo root
FRONTEND_DIR = PROJECT_DIR / "frontend"

DATABASE_URL = os.getenv("DATABASE_URL", f"sqlite:///{BASE_DIR / 'wordcards.db'}")
# Hosts like Neon give "postgresql://..." - tell SQLAlchemy to use the psycopg 3 driver.
for _prefix in ("postgres://", "postgresql://"):
    if DATABASE_URL.startswith(_prefix):
        DATABASE_URL = "postgresql+psycopg://" + DATABASE_URL[len(_prefix):]

_DEV_SECRET = "dev-secret-change-me"
SECRET_KEY = os.getenv("SECRET_KEY", _DEV_SECRET)
if SECRET_KEY == _DEV_SECRET:
    warnings.warn("SECRET_KEY is not set - using an insecure development key.", stacklevel=1)

JWT_ALGORITHM = "HS256"
# Long, because the app is used offline for days and needs the token to sync later.
TOKEN_LIFETIME_DAYS = int(os.getenv("TOKEN_LIFETIME_DAYS", "365"))
