# WordCards

Flashcard app for learning foreign-language vocabulary with spaced repetition.
Works in the browser and installs on a phone as an app (PWA). **Works offline**:
lessons, games and adding words all work without internet and sync later.

**Backend:** Python, FastAPI, SQLAlchemy 2.0, PostgreSQL (SQLite locally), JWT auth
**Frontend:** plain HTML/CSS/JavaScript, no build step, installable offline-first PWA (Service Worker + IndexedDB)

## Features

- Accounts with login (passwords hashed with PBKDF2, JWT tokens)
- Folders per language (German, English, Chinese, …)
- Add many words at once by pasting a list: `word - translation - example`
- Lessons with flip cards: **Не помню / Перевернуть / Помню**
- Back side shows the translation and an example sentence
- Spaced repetition (Leitner system, 5 boxes): known words come back after 1, 3, 7, 14, 30 days
- Forgotten words come back again 5 cards later in the same lesson
- Separate sections for forgotten and learned words
- Two games: pick the translation, type the word
- Reverse mode (see the translation, recall the word)
- Pronunciation through the browser's speech synthesis
- Offline first: works without internet, syncs automatically when back online
- Light and dark theme, works on phones

## How the repetition works

Every word sits in a box from 0 (new) to 5 (learned).

| Answer | What happens |
|---|---|
| "Помню" | word moves one box up and comes back later: box 1 → 1 day, 2 → 3 days, 3 → 7, 4 → 14, 5 → 30 |
| "Не помню" | word drops to box 1, is marked *forgotten*, and is due again right away |

The logic is in [`backend/app/srs.py`](backend/app/srs.py) and covered by tests.

## How offline mode works

```
 phone                                        server
 ─────                                        ──────
 IndexedDB: full copy of folders and words
 every change ──► applied locally at once
              └─► queued in the "outbox"
                         │  when online
                         ▼
                   POST /api/sync {ops: [...]} ──► applied in order
                                                   (each op has an id, repeats are skipped)
 local copy  ◄──────────── full fresh state ◄────┘
 + changes made while waiting are replayed on top
```

- Folders and words get a UUID created on the phone, so they can be made offline.
- Each review carries the time it happened, so the server schedules it exactly as the phone did.
- The same logic exists twice — [`frontend/logic.js`](frontend/logic.js) and the Python backend — and both are tested with the same cases.

## Run locally

```bash
cd backend
python -m venv .venv
source .venv/bin/activate          # Windows: .venv\Scripts\activate
pip install -r requirements.txt
uvicorn app.main:app --reload
```

Open http://localhost:8000. API docs: http://localhost:8000/docs

Run tests:

```bash
pip install -r requirements-dev.txt
pytest                                   # backend, from the backend folder
node --test "frontend/tests/*.test.js"   # offline logic, from the project root
```

## Settings

| Variable | Default | Meaning |
|---|---|---|
| `SECRET_KEY` | dev key (insecure) | key that signs login tokens — **set it in production** |
| `DATABASE_URL` | `sqlite:///backend/wordcards.db` | `postgresql://...` from Neon, or any SQLAlchemy URL |
| `TOKEN_LIFETIME_DAYS` | `365` | how long a login lasts (long, because the app is used offline) |

## Deploy (free): Render + Neon

1. Create a free PostgreSQL database on [Neon](https://neon.com) and copy its connection string.
2. On [Render](https://render.com): **New → Blueprint**, pick this repository. Render reads
   [`render.yaml`](render.yaml) and asks for `DATABASE_URL` — paste the Neon string.
3. Open the `https://...onrender.com` link on the phone:
   iPhone Safari → Share → *Add to Home Screen*; Android Chrome → menu → *Install app*.

Render's free filesystem is wiped on every restart, which is why the data lives in Neon.

## Project structure

```
backend/
  app/
    main.py          FastAPI app, serves the API and the frontend
    models.py        tables: users, decks, cards
    srs.py           spaced repetition (Leitner boxes)
    word_parser.py   turns a pasted word list into cards
    security.py      passwords and JWT
    routers/         auth, decks, cards, sync endpoints
  tests/             pytest tests
frontend/
  index.html, app.js, style.css
  logic.js         offline logic: repetition, word parser, applying changes
  manifest.json, sw.js   PWA files
  tests/           node tests for logic.js
render.yaml        one-click deploy on Render
```

## API overview

| Method | Path | |
|---|---|---|
| POST | `/api/auth/register`, `/api/auth/login` | get a token |
| GET/POST | `/api/decks` | list / create folders |
| GET/PUT/DELETE | `/api/decks/{id}` | one folder with statistics |
| GET/POST | `/api/decks/{id}/cards` | list / add a word |
| POST | `/api/decks/{id}/cards/bulk` | add many words from text |
| GET | `/api/decks/{id}/study?mode=due\|forgotten\|learned\|all` | cards for a lesson |
| POST | `/api/cards/{id}/review` | `{"known": true}` — save an answer |
| PATCH/DELETE | `/api/cards/{id}` | edit / delete a word |
| POST | `/api/sync` | send offline changes, get the full fresh state |

---

## Коротко по-русски

**Запуск:** открой терминал в папке `backend`, выполни команды из раздела *Run locally*, потом открой http://localhost:8000.

**Как добавить слова:** создай папку → «Добавить слова» → вставь список, одно слово на строку:

```
der Hund - собака - Der Hund schläft.
laufen - бегать
```

**На телефоне:** выложи приложение на Render + Neon (раздел *Deploy*), открой ссылку на телефоне и нажми «На экран Домой». Войти нужно один раз с интернетом, дальше приложение работает и без него, а когда интернет появляется, само сохраняет всё на сервере.
