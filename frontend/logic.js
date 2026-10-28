/* Logic that has to work on the phone without internet.
   It mirrors the server (backend/app/srs.py, word_parser.py, routers/sync.py),
   so the phone and the server always come to the same result.
   Works in the browser (window.WC) and in Node for tests (require). */
(function (root) {
  "use strict";

  // ---------- spaced repetition (Leitner boxes), same as srs.py ----------
  const LEARNED_BOX = 5;
  const INTERVAL_DAYS = { 1: 1, 2: 3, 3: 7, 4: 14, 5: 30 };
  const DAY_MS = 24 * 60 * 60 * 1000;

  function review(box, known, atIso) {
    const at = Date.parse(atIso);
    if (!known) return { box: 1, status: "forgotten", due_at: new Date(at).toISOString() };
    const newBox = Math.min(box + 1, LEARNED_BOX);
    return {
      box: newBox,
      status: newBox === LEARNED_BOX ? "learned" : "learning",
      due_at: new Date(at + INTERVAL_DAYS[newBox] * DAY_MS).toISOString(),
    };
  }

  // ---------- word list parser, same as word_parser.py ----------
  const SEPARATOR = /\s+[-–—=]\s+|\t|\s*;\s*/g;
  const EXAMPLE_LINE = /^(?:-{2,}|[—–])\s*(.+)$/;
  const EXAMPLE_TRANSLATION_LINE = /^(?:\.{3,}|…)\s*(.+)$/;
  const INLINE_EXAMPLE = /\s+-{2,}\s+/g;
  const INLINE_TRANSLATION = /\s+(?:\.{3,}|…)\s+/g;

  /** Like Python's re.split(pattern, text, maxsplit). */
  function splitMax(text, pattern, maxsplit) {
    const re = new RegExp(pattern.source, "g");
    const parts = [];
    let last = 0;
    let m;
    while (parts.length < maxsplit && (m = re.exec(text)) !== null) {
      if (m[0] === "") { re.lastIndex++; continue; }
      parts.push(text.slice(last, m.index));
      last = m.index + m[0].length;
    }
    parts.push(text.slice(last));
    return parts;
  }

  const addLine = (current, extra) => (current ? `${current}\n${extra}` : extra);

  function splitExample(text) {
    const parts = splitMax(text, INLINE_TRANSLATION, 1);
    const translation = parts.length === 2 && parts[1].trim() ? parts[1].trim() : null;
    return [parts[0].trim(), translation];
  }

  function parseWordList(text) {
    const words = [];
    const errors = [];
    let last = null;

    for (const raw of text.split(/\r?\n/)) {
      const line = raw.trim();
      if (!line) continue;

      let m = line.match(EXAMPLE_LINE);
      if (m) {
        if (!last) { errors.push(line); continue; }
        const [example, translation] = splitExample(m[1]);
        last.example = addLine(last.example, example);
        if (translation) last.example_translation = addLine(last.example_translation, translation);
        continue;
      }

      m = line.match(EXAMPLE_TRANSLATION_LINE);
      if (m) {
        if (!last || !last.example) { errors.push(line); continue; }
        last.example_translation = addLine(last.example_translation, m[1].trim());
        continue;
      }

      const [main, ...rest] = splitMax(line, INLINE_EXAMPLE, 1);
      const parts = splitMax(main, SEPARATOR, 2).map((p) => p.trim());
      if (parts.length < 2 || !parts[0] || !parts[1]) {
        errors.push(line);
        last = null;
        continue;
      }
      const word = { front: parts[0].slice(0, 200), back: parts[1].slice(0, 200), example: null, example_translation: null };
      const exampleText = rest.length ? rest[0].trim() : parts.length === 3 ? parts[2] : "";
      if (exampleText) [word.example, word.example_translation] = splitExample(exampleText);
      words.push(word);
      last = word;
    }
    return { words, errors };
  }

  // ---------- applying a change to the local copy, same as routers/sync.py ----------
  function applyOp(state, op) {
    const deckIdx = state.decks.findIndex((d) => d.uid === op.uid);
    const card = op.type.startsWith("card_") ? state.cards.find((c) => c.uid === op.uid) : null;

    switch (op.type) {
      case "deck_upsert":
        if (deckIdx === -1) state.decks.push({ uid: op.uid, name: op.name, lang_code: op.lang_code || null, created_at: op.at });
        else Object.assign(state.decks[deckIdx], { name: op.name, lang_code: op.lang_code || null });
        break;
      case "deck_delete":
        if (deckIdx !== -1) state.decks.splice(deckIdx, 1);
        state.cards = state.cards.filter((c) => c.deck_uid !== op.uid);
        break;
      case "card_upsert": {
        const content = {
          front: op.front, back: op.back,
          example: op.example || null, example_translation: op.example_translation || null,
        };
        if (card) Object.assign(card, content);
        else if (state.decks.some((d) => d.uid === op.deck_uid)) {
          state.cards.push({
            uid: op.uid, deck_uid: op.deck_uid, ...content,
            box: 0, status: "new", due_at: op.at, times_correct: 0, times_wrong: 0, created_at: op.at,
          });
        }
        break;
      }
      case "card_delete":
        state.cards = state.cards.filter((c) => c.uid !== op.uid);
        break;
      case "card_review":
        if (card) {
          Object.assign(card, review(card.box, op.known, op.at));
          if (op.known) card.times_correct += 1;
          else card.times_wrong += 1;
        }
        break;
      case "card_reset":
        if (card) Object.assign(card, { box: 0, status: "new", due_at: op.at });
        break;
    }
  }

  // ---------- reading ----------
  function deckStats(cards, deckUid, now = Date.now()) {
    const s = { total: 0, new: 0, learning: 0, forgotten: 0, learned: 0, due: 0 };
    for (const c of cards) {
      if (c.deck_uid !== deckUid) continue;
      s.total += 1;
      s[c.status] += 1;
      if (Date.parse(c.due_at) <= now) s.due += 1;
    }
    return s;
  }

  function shuffle(list, rand = Math.random) {
    const a = [...list];
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  const PRIORITY = { forgotten: 0, learning: 1, learned: 2, new: 3 };

  /** Cards for one lesson: due | forgotten | learned | all. Same rules as the server. */
  function studyCards(cards, deckUid, mode, limit, now = Date.now()) {
    const own = cards.filter((c) => c.deck_uid === deckUid);
    let picked;
    if (mode === "due") {
      picked = own
        .filter((c) => Date.parse(c.due_at) <= now)
        .sort((a, b) =>
          PRIORITY[a.status] - PRIORITY[b.status] ||
          Date.parse(a.due_at) - Date.parse(b.due_at) ||
          Date.parse(a.created_at) - Date.parse(b.created_at)
        );
    } else if (mode === "forgotten" || mode === "learned") {
      picked = shuffle(own.filter((c) => c.status === mode));
    } else {
      picked = shuffle(own);
    }
    return picked.slice(0, limit);
  }

  function uuid() {
    if (root.crypto && typeof root.crypto.randomUUID === "function") return root.crypto.randomUUID();
    // Fallback for pages opened over plain http (randomUUID needs https).
    const b = new Uint8Array(16);
    root.crypto.getRandomValues(b);
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    const h = [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
  }

  const api = { review, parseWordList, applyOp, deckStats, studyCards, shuffle, uuid, INTERVAL_DAYS };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.WC = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
