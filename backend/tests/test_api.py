from .conftest import register


def make_deck(client, auth, name="Немецкий"):
    r = client.post("/api/decks", json={"name": name, "lang_code": "de-DE"}, headers=auth)
    assert r.status_code == 201
    return r.json()["id"]


def test_register_login_and_me(client):
    register(client, "boris", "password1")
    assert client.post("/api/auth/register", json={"username": "BORIS", "password": "password1"}).status_code == 409
    assert client.post("/api/auth/login", json={"username": "boris", "password": "wrong!!"}).status_code == 401

    token = client.post("/api/auth/login", json={"username": "boris", "password": "password1"}).json()["access_token"]
    me = client.get("/api/auth/me", headers={"Authorization": f"Bearer {token}"})
    assert me.json()["username"] == "boris"


def test_api_requires_login(client):
    assert client.get("/api/decks").status_code == 401
    assert client.get("/api/decks", headers={"Authorization": "Bearer garbage"}).status_code == 401


def test_bulk_add_and_stats(client, auth):
    deck_id = make_deck(client, auth)
    r = client.post(
        f"/api/decks/{deck_id}/cards/bulk",
        json={"text": "der Hund - собака\ndie Katze - кошка - Die Katze schläft.\nder hund - пёс\nfoo"},
        headers=auth,
    )
    assert r.json() == {"added": 2, "skipped_duplicates": ["der hund"], "errors": ["foo"]}

    stats = client.get(f"/api/decks/{deck_id}", headers=auth).json()["stats"]
    assert stats["total"] == 2 and stats["new"] == 2 and stats["due"] == 2


def test_review_flow(client, auth):
    deck_id = make_deck(client, auth)
    client.post(f"/api/decks/{deck_id}/cards/bulk", json={"text": "a - а\nb - б"}, headers=auth)
    cards = client.get(f"/api/decks/{deck_id}/study", headers=auth).json()
    assert len(cards) == 2

    known, forgot = cards
    r = client.post(f"/api/cards/{known['id']}/review", json={"known": True}, headers=auth).json()
    assert (r["box"], r["status"]) == (1, "learning")
    r = client.post(f"/api/cards/{forgot['id']}/review", json={"known": False}, headers=auth).json()
    assert (r["box"], r["status"]) == (1, "forgotten")

    # The known word is not due until tomorrow, the forgotten one is due again now.
    due = client.get(f"/api/decks/{deck_id}/study", headers=auth).json()
    assert [c["id"] for c in due] == [forgot["id"]]

    only_forgotten = client.get(f"/api/decks/{deck_id}/study?mode=forgotten", headers=auth).json()
    assert [c["id"] for c in only_forgotten] == [forgot["id"]]

    stats = client.get(f"/api/decks/{deck_id}", headers=auth).json()["stats"]
    assert (stats["learning"], stats["forgotten"], stats["due"]) == (1, 1, 1)


def test_word_becomes_learned_after_five_correct_answers(client, auth):
    deck_id = make_deck(client, auth)
    card = client.post(f"/api/decks/{deck_id}/cards", json={"front": "Hallo", "back": "привет"}, headers=auth).json()
    for _ in range(5):
        r = client.post(f"/api/cards/{card['id']}/review", json={"known": True}, headers=auth).json()
    assert r["status"] == "learned"
    learned = client.get(f"/api/decks/{deck_id}/study?mode=learned", headers=auth).json()
    assert [c["id"] for c in learned] == [card["id"]]


def test_edit_and_delete_card(client, auth):
    deck_id = make_deck(client, auth)
    card = client.post(
        f"/api/decks/{deck_id}/cards", json={"front": "Haus", "back": "дом", "example": "x"}, headers=auth
    ).json()
    r = client.patch(f"/api/cards/{card['id']}", json={"back": "дом, здание", "example": ""}, headers=auth).json()
    assert r["back"] == "дом, здание" and r["example"] is None and r["front"] == "Haus"
    assert client.delete(f"/api/cards/{card['id']}", headers=auth).status_code == 204
    assert client.get(f"/api/decks/{deck_id}/cards", headers=auth).json() == []


def test_users_cannot_see_each_others_decks(client, auth):
    deck_id = make_deck(client, auth)
    card = client.post(f"/api/decks/{deck_id}/cards", json={"front": "a", "back": "б"}, headers=auth).json()
    other = register(client, "intruder", "password2")

    assert client.get("/api/decks", headers=other).json() == []
    assert client.get(f"/api/decks/{deck_id}", headers=other).status_code == 404
    assert client.get(f"/api/decks/{deck_id}/study", headers=other).status_code == 404
    assert client.post(f"/api/cards/{card['id']}/review", json={"known": True}, headers=other).status_code == 404
    assert client.delete(f"/api/decks/{deck_id}", headers=other).status_code == 404


def test_delete_deck_removes_its_cards(client, auth):
    deck_id = make_deck(client, auth)
    card = client.post(f"/api/decks/{deck_id}/cards", json={"front": "a", "back": "б"}, headers=auth).json()
    assert client.delete(f"/api/decks/{deck_id}", headers=auth).status_code == 204
    assert client.patch(f"/api/cards/{card['id']}", json={"back": "в"}, headers=auth).status_code == 404


def test_bulk_add_saves_example_translation(client, auth):
    deck_id = make_deck(client, auth)
    client.post(
        f"/api/decks/{deck_id}/cards/bulk",
        json={"text": "der Hund - собака\n-- Der Hund schläft.\n... Собака спит."},
        headers=auth,
    )
    [card] = client.get(f"/api/decks/{deck_id}/cards", headers=auth).json()
    assert (card["example"], card["example_translation"]) == ("Der Hund schläft.", "Собака спит.")


def test_old_database_gets_new_column(tmp_path, monkeypatch):
    """A database made by the first version (no example_translation) is upgraded on start."""
    import sqlite3

    from app import main
    from app.database import make_engine

    path = tmp_path / "old.db"
    con = sqlite3.connect(path)
    con.execute("CREATE TABLE cards (id INTEGER PRIMARY KEY, deck_id INTEGER, front TEXT, back TEXT, example TEXT)")
    con.execute("INSERT INTO cards (deck_id, front, back) VALUES (1, 'Hund', 'собака')")
    con.commit()
    con.close()

    monkeypatch.setattr(main, "engine", make_engine(f"sqlite:///{path}"))
    main.add_missing_columns()

    con = sqlite3.connect(path)
    cols = {row[1] for row in con.execute("PRAGMA table_info(cards)")}
    assert {"example_translation", "uid", "updated_at"} <= cols
    front, card_uid = con.execute("SELECT front, uid FROM cards").fetchone()
    assert front == "Hund" and len(card_uid) == 36
    con.close()
