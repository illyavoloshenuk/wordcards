"""Entry point: the API under /api and the PWA frontend under /."""
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.staticfiles import StaticFiles
from sqlalchemy import inspect, text

from .config import FRONTEND_DIR
from .database import Base, engine
from .models import new_uid
from .routers import auth, cards, decks, sync


def add_missing_columns() -> None:
    """Add columns that newer versions introduced to an existing database.

    create_all() only creates missing tables, not missing columns.
    """
    inspector = inspect(engine)
    for table in Base.metadata.sorted_tables:
        if not inspector.has_table(table.name):
            continue
        existing = {col["name"] for col in inspector.get_columns(table.name)}
        for column in table.columns:
            if column.name not in existing and column.nullable:
                col_type = column.type.compile(engine.dialect)
                with engine.begin() as conn:
                    conn.execute(text(f'ALTER TABLE "{table.name}" ADD COLUMN "{column.name}" {col_type}'))
                if column.index and column.name != "uid":
                    with engine.begin() as conn:
                        conn.execute(
                            text(f'CREATE INDEX IF NOT EXISTS "ix_{table.name}_{column.name}" ON "{table.name}" ({column.name})')
                        )
                if column.name == "updated_at":
                    source = "created_at" if "created_at" in existing else "CURRENT_TIMESTAMP"
                    with engine.begin() as conn:
                        conn.execute(text(f'UPDATE "{table.name}" SET updated_at = {source} WHERE updated_at IS NULL'))
                if column.name == "uid":
                    fill_uids(table.name)
                    with engine.begin() as conn:
                        conn.execute(
                            text(f'CREATE UNIQUE INDEX IF NOT EXISTS "ix_{table.name}_uid" ON "{table.name}" (uid)')
                        )


def fill_uids(table_name: str) -> None:
    """Give rows from an older version their public uid."""
    with engine.begin() as conn:
        ids = conn.execute(text(f'SELECT id FROM "{table_name}" WHERE uid IS NULL')).scalars().all()
        for row_id in ids:
            conn.execute(text(f'UPDATE "{table_name}" SET uid = :uid WHERE id = :id'), {"uid": new_uid(), "id": row_id})


@asynccontextmanager
async def lifespan(_: FastAPI):
    Base.metadata.create_all(engine)
    add_missing_columns()
    yield


app = FastAPI(title="WordCards API", version="1.1.0", lifespan=lifespan)
app.add_middleware(GZipMiddleware, minimum_size=1000)  # word lists compress ~5x

for router in (auth.router, decks.router, cards.router, sync.router):
    app.include_router(router, prefix="/api")


@app.get("/api/health", tags=["meta"])
def health():
    return {"status": "ok"}


# Must come last: everything that is not /api/... is the frontend.
if FRONTEND_DIR.exists():
    app.mount("/", StaticFiles(directory=FRONTEND_DIR, html=True), name="frontend")
