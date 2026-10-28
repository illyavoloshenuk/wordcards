// Run with: node --test "frontend/tests/*.test.js"
// The same cases as the Python tests, so phone and server never disagree.
const test = require("node:test");
const assert = require("node:assert/strict");
const WC = require("../logic.js");

const AT = "2026-01-01T12:00:00.000Z";
const days = (iso) => (Date.parse(iso) - Date.parse(AT)) / 86400000;

test("intervals grow until the word is learned", () => {
  let box = 0, r;
  const seen = [];
  for (let i = 0; i < 5; i++) { r = WC.review(box, true, AT); box = r.box; seen.push(days(r.due_at)); }
  assert.deepEqual(seen, [1, 3, 7, 14, 30]);
  assert.equal(r.status, "learned");
});

test("forgotten word drops to box 1 and is due now", () => {
  assert.deepEqual(WC.review(4, false, AT), { box: 1, status: "forgotten", due_at: AT });
});

test("parser: separators and old 3-part examples", () => {
  const r = WC.parseWordList(
    "der Hund - собака\nlaufen — бегать — Ich laufe jeden Morgen.\nhello = привет\ndie E-Mail\tписьмо\n\nпросто строка без перевода\n"
  );
  assert.deepEqual(r.words.map((w) => [w.front, w.back]), [
    ["der Hund", "собака"], ["laufen", "бегать"], ["hello", "привет"], ["die E-Mail", "письмо"],
  ]);
  assert.equal(r.words[1].example, "Ich laufe jeden Morgen.");
  assert.deepEqual(r.errors, ["просто строка без перевода"]);
});

test("parser: example lines belong to the word above", () => {
  const r = WC.parseWordList(
    "der Hund - собака\n-- Der Hund schläft im Garten.\n... Собака спит в саду.\n" +
    "laufen - бегать\n— Ich laufe jeden Morgen.\n… Я бегаю каждое утро.\ndie Straße - улица\n"
  );
  assert.deepEqual(r.words.map((w) => [w.front, w.back, w.example, w.example_translation]), [
    ["der Hund", "собака", "Der Hund schläft im Garten.", "Собака спит в саду."],
    ["laufen", "бегать", "Ich laufe jeden Morgen.", "Я бегаю каждое утро."],
    ["die Straße", "улица", null, null],
  ]);
  assert.deepEqual(r.errors, []);
});

test("parser: example on the same line, and stray example lines", () => {
  const [w] = WC.parseWordList("das Haus - дом -- Das Haus ist groß. ... Дом большой.").words;
  assert.deepEqual([w.example, w.example_translation], ["Das Haus ist groß.", "Дом большой."]);
  assert.equal(WC.parseWordList("-- Ein Satz.\n... Перевод.").errors.length, 2);
  assert.equal(WC.parseWordList("warten - ждать\n-- Ich warte... und warte.").words[0].example, "Ich warte... und warte.");
});

test("applyOp: create, review, edit, delete", () => {
  const s = { decks: [], cards: [] };
  WC.applyOp(s, { type: "deck_upsert", uid: "d1", name: "DE", lang_code: "de-DE", at: AT });
  WC.applyOp(s, { type: "card_upsert", uid: "c1", deck_uid: "d1", front: "Hund", back: "собака", at: AT });
  WC.applyOp(s, { type: "card_upsert", uid: "c2", deck_uid: "nope", front: "x", back: "y", at: AT }); // no folder
  assert.equal(s.cards.length, 1);

  WC.applyOp(s, { type: "card_review", uid: "c1", known: false, at: AT });
  assert.equal(s.cards[0].status, "forgotten");
  assert.equal(WC.deckStats(s.cards, "d1", Date.parse(AT)).forgotten, 1);

  WC.applyOp(s, { type: "card_upsert", uid: "c1", deck_uid: "d1", front: "Hund", back: "пёс", at: AT });
  assert.equal(s.cards[0].back, "пёс");
  assert.equal(s.cards[0].status, "forgotten"); // editing keeps the progress

  WC.applyOp(s, { type: "deck_delete", uid: "d1", at: AT });
  assert.deepEqual(s, { decks: [], cards: [] });
});

test("study: due cards come forgotten first, then learning, then new", () => {
  const now = Date.parse("2026-01-10T00:00:00Z");
  const card = (uid, status, due) => ({ uid, deck_uid: "d", status, due_at: due, created_at: AT, box: 0 });
  const cards = [
    card("new", "new", AT),
    card("later", "learning", "2026-02-01T00:00:00.000Z"),
    card("learning", "learning", AT),
    card("forgot", "forgotten", AT),
  ];
  assert.deepEqual(WC.studyCards(cards, "d", "due", 20, now).map((c) => c.uid), ["forgot", "learning", "new"]);
});

test("uuid looks like a uuid", () => {
  assert.match(WC.uuid(), /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});
