import uuid

from .conftest import register


def uid():
    return str(uuid.uuid4())


def op(type_, **fields):
    return {"op_id": uid(), "type": type_, **fields}


def sync(client, auth, *ops):
    r = client.post("/api/sync", json={"ops": list(ops)}, headers=auth)
    assert r.status_code == 200, r.text
    return r.json()


def test_offline_changes_are_saved(client, auth):
    deck, card = uid(), uid()
    state = sync(
        client, auth,
        op("deck_upsert", uid=deck, name="Немецкий", lang_code="de-DE"),
        op("card_upsert", uid=card, deck_uid=deck, front="der Hund", back="собака",
           example="Der Hund schläft.", example_translation="Собака спит."),
        op("card_review", uid=card, known=True, at="2026-10-01T10:00:00Z"),
    )
    assert [d["uid"] for d in state["decks"]] == [deck]
    [c] = state["cards"]
    assert (c["uid"], c["deck_uid"], c["box"], c["status"]) == (card, deck, 1, "learning")
    # the review happened at 10:00 on the phone, so the word is due one day later
    assert c["due_at"] == "2026-10-02T10:00:00.000Z"
    assert c["example_translation"] == "Собака спит."
    assert state["rejected"] == []


def test_same_change_sent_twice_counts_once(client, auth):
    deck, card = uid(), uid()
    sync(client, auth, op("deck_upsert", uid=deck, name="EN"), op("card_upsert", uid=card, deck_uid=deck, front="a", back="б"))
    review = op("card_review", uid=card, known=True)
    sync(client, auth, review)
    state = sync(client, auth, review)  # retry after a lost answer
    assert state["cards"][0]["box"] == 1
    assert state["cards"][0]["times_correct"] == 1


def test_edit_and_delete(client, auth):
    deck, card = uid(), uid()
    sync(client, auth, op("deck_upsert", uid=deck, name="EN"), op("card_upsert", uid=card, deck_uid=deck, front="a", back="б"))
    state = sync(client, auth, op("card_upsert", uid=card, deck_uid=deck, front="a", back="в", example=""))
    assert state["cards"][0]["back"] == "в"
    state = sync(client, auth, op("card_delete", uid=card))
    assert state["cards"] == []
    state = sync(client, auth, op("deck_delete", uid=deck))
    assert state["decks"] == []


def test_bad_change_is_rejected_but_rest_is_saved(client, auth):
    deck = uid()
    bad = op("card_upsert", uid=uid(), deck_uid=uid(), front="x", back="y")  # folder doesn't exist
    empty = op("card_upsert", uid=uid(), deck_uid=deck, front="  ", back="y")
    state = sync(client, auth, op("deck_upsert", uid=deck, name="EN"), bad, empty)
    assert len(state["decks"]) == 1 and state["cards"] == []
    assert {r["op_id"] for r in state["rejected"]} == {bad["op_id"], empty["op_id"]}


def test_review_of_deleted_word_is_ignored(client, auth):
    state = sync(client, auth, op("card_review", uid=uid(), known=False))
    assert state["rejected"] == [] and state["cards"] == []


def test_cannot_touch_other_users_data(client, auth):
    deck, card = uid(), uid()
    sync(client, auth, op("deck_upsert", uid=deck, name="mine"), op("card_upsert", uid=card, deck_uid=deck, front="a", back="б"))
    other = register(client, "intruder", "password2")
    state = sync(
        client, other,
        op("deck_upsert", uid=deck, name="stolen"),
        op("card_delete", uid=card),
        op("card_upsert", uid=uid(), deck_uid=deck, front="x", back="y"),
    )
    assert state["decks"] == [] and state["cards"] == [] and len(state["rejected"]) == 3
    mine = sync(client, auth)
    assert mine["decks"][0]["name"] == "mine" and len(mine["cards"]) == 1


def test_phone_clock_in_future_is_capped(client, auth):
    deck, card = uid(), uid()
    state = sync(
        client, auth,
        op("deck_upsert", uid=deck, name="EN"),
        op("card_upsert", uid=card, deck_uid=deck, front="a", back="б"),
        op("card_review", uid=card, known=True, at="2099-01-01T00:00:00Z"),
    )
    assert state["cards"][0]["due_at"] < "2030"


def test_words_from_old_api_appear_in_sync(client, auth):
    r = client.post("/api/decks", json={"name": "DE"}, headers=auth).json()
    client.post(f"/api/decks/{r['id']}/cards", json={"front": "Haus", "back": "дом"}, headers=auth)
    state = sync(client, auth)
    assert state["decks"][0]["uid"] and state["cards"][0]["deck_uid"] == state["decks"][0]["uid"]


# ---- only changes since the last sync ----
def test_second_sync_sends_only_changes(client, auth):
    deck, a, b = uid(), uid(), uid()
    first = sync(
        client, auth,
        op("deck_upsert", uid=deck, name="EN"),
        op("card_upsert", uid=a, deck_uid=deck, front="a", back="а"),
        op("card_upsert", uid=b, deck_uid=deck, front="b", back="б"),
    )
    assert first["full"] is True and len(first["cards"]) == 2

    # pretend the first sync was long ago, so the safety window doesn't re-send everything
    from datetime import datetime, timedelta, timezone
    from app.models import Card
    from app.database import get_db
    from app.main import app
    db = next(app.dependency_overrides[get_db]())
    old = datetime.now(timezone.utc).replace(tzinfo=None) - timedelta(hours=1)
    for c in db.query(Card).all():
        c.updated_at = old
    db.commit()
    from app.models import Deck
    for d in db.query(Deck).all():
        d.updated_at = old
    db.commit()
    since = (old + timedelta(minutes=30)).isoformat() + "Z"

    r = client.post("/api/sync", json={"since": since, "ops": [op("card_review", uid=a, known=True)]}, headers=auth).json()
    assert r["full"] is False
    assert [c["uid"] for c in r["cards"]] == [a]  # only the answered word comes back
    assert r["decks"] == []

    r = client.post("/api/sync", json={"since": since, "ops": [op("card_delete", uid=b)]}, headers=auth).json()
    assert r["deleted_cards"] == [b]

    r = client.post("/api/sync", json={"since": since, "ops": [op("deck_delete", uid=deck)]}, headers=auth).json()
    assert r["deleted_decks"] == [deck]


def test_very_old_cursor_gets_everything(client, auth):
    deck = uid()
    sync(client, auth, op("deck_upsert", uid=deck, name="EN"))
    r = client.post("/api/sync", json={"since": "2020-01-01T00:00:00Z", "ops": []}, headers=auth).json()
    assert r["full"] is True and len(r["decks"]) == 1


def test_deleting_through_old_api_reaches_sync(client, auth):
    deck = client.post("/api/decks", json={"name": "DE"}, headers=auth).json()
    card = client.post(f"/api/decks/{deck['id']}/cards", json={"front": "Haus", "back": "дом"}, headers=auth).json()
    first = sync(client, auth)
    client.delete(f"/api/cards/{card['id']}", headers=auth)
    r = client.post("/api/sync", json={"since": first["cursor"], "ops": []}, headers=auth).json()
    assert r["deleted_cards"] == [first["cards"][0]["uid"]]


def test_big_answers_are_compressed(client, auth):
    deck = uid()
    ops = [op("deck_upsert", uid=deck, name="EN")] + [
        op("card_upsert", uid=uid(), deck_uid=deck, front=f"word {i}", back=f"слово {i}") for i in range(50)
    ]
    r = client.post("/api/sync", json={"ops": ops}, headers={**auth, "Accept-Encoding": "gzip"})
    assert r.headers.get("content-encoding") == "gzip"


# ---- topics inside a language folder ----
def test_topics_and_moving_words(client, auth):
    de, cats, work, word = uid(), uid(), uid(), uid()
    state = sync(
        client, auth,
        op("deck_upsert", uid=de, name="Немецкий", lang_code="de-DE"),
        op("card_upsert", uid=word, deck_uid=de, front="die Katze", back="кошка"),
        op("deck_upsert", uid=cats, parent_uid=de, name="Кошки", lang_code="de-DE"),
        op("deck_upsert", uid=work, parent_uid=de, name="Работа", lang_code="de-DE"),
        op("card_upsert", uid=word, deck_uid=cats, front="die Katze", back="кошка"),  # move into the topic
        op("card_review", uid=word, known=True),
    )
    assert state["rejected"] == []
    parents = {d["uid"]: d["parent_uid"] for d in state["decks"]}
    assert parents == {de: None, cats: de, work: de}
    [card] = state["cards"]
    assert card["deck_uid"] == cats and card["box"] == 1  # progress kept after moving


def test_old_app_rename_keeps_topic(client, auth):
    de, cats = uid(), uid()
    sync(client, auth, op("deck_upsert", uid=de, name="DE"), op("deck_upsert", uid=cats, parent_uid=de, name="Кошки"))
    # an older app version sends no parent_uid at all
    state = sync(client, auth, op("deck_upsert", uid=cats, name="Котики"))
    topic = next(d for d in state["decks"] if d["uid"] == cats)
    assert (topic["name"], topic["parent_uid"]) == ("Котики", de)


def test_topic_rules(client, auth):
    de, cats, deep = uid(), uid(), uid()
    sync(client, auth, op("deck_upsert", uid=de, name="DE"), op("deck_upsert", uid=cats, parent_uid=de, name="Кошки"))
    bad = [
        op("deck_upsert", uid=deep, parent_uid=cats, name="Тема в теме"),
        op("deck_upsert", uid=uid(), parent_uid=uid(), name="Нет родителя"),
        op("deck_upsert", uid=de, parent_uid=de, name="Сам в себе"),
    ]
    state = sync(client, auth, *bad)
    assert len(state["rejected"]) == 3


def test_deleting_language_deletes_its_topics_and_words(client, auth):
    de, cats, w1, w2 = uid(), uid(), uid(), uid()
    first = sync(
        client, auth,
        op("deck_upsert", uid=de, name="DE"),
        op("deck_upsert", uid=cats, parent_uid=de, name="Кошки"),
        op("card_upsert", uid=w1, deck_uid=de, front="a", back="а"),
        op("card_upsert", uid=w2, deck_uid=cats, front="b", back="б"),
    )
    r = client.post("/api/sync", json={"since": first["cursor"], "ops": [op("deck_delete", uid=de)]}, headers=auth).json()
    assert set(r["deleted_decks"]) == {de, cats}
    assert sync(client, auth)["cards"] == []
