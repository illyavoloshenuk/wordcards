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
      case "deck_upsert": {
        const fields = { name: op.name, lang_code: op.lang_code || null };
        if ("parent_uid" in op) fields.parent_uid = op.parent_uid || null;
        if (deckIdx === -1) state.decks.push({ uid: op.uid, parent_uid: null, created_at: op.at, ...fields });
        else Object.assign(state.decks[deckIdx], fields);
        break;
      }
      case "deck_delete": {
        // A language folder takes its topics and all their words with it.
        const gone = new Set([op.uid, ...state.decks.filter((d) => d.parent_uid === op.uid).map((d) => d.uid)]);
        state.decks = state.decks.filter((d) => !gone.has(d.uid));
        state.cards = state.cards.filter((c) => !gone.has(c.deck_uid));
        break;
      }
      case "card_upsert": {
        const content = {
          front: op.front, back: op.back,
          example: op.example || null, example_translation: op.example_translation || null,
        };
        if (card) {
          Object.assign(card, content);
          // Moved to another topic of the same language.
          if (op.deck_uid && state.decks.some((d) => d.uid === op.deck_uid)) card.deck_uid = op.deck_uid;
        } else if (state.decks.some((d) => d.uid === op.deck_uid)) {
          state.cards.push({
            uid: op.uid, deck_uid: op.deck_uid, ...content,
            box: 0, status: "new", due_at: op.at, times_correct: 0, times_wrong: 0, created_at: op.at, favorite: false,
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
      case "card_favorite":
        if (card) card.favorite = !!op.favorite;
        break;
    }
  }

  // ---------- merging what the server sent ----------
  /** Apply a sync answer to the server-confirmed copy. Returns the new copy. */
  function mergeChanges(base, res) {
    if (res.full) return { decks: res.decks, cards: res.cards };
    const decks = new Map(base.decks.map((d) => [d.uid, d]));
    const cards = new Map(base.cards.map((c) => [c.uid, c]));
    for (const d of res.decks) decks.set(d.uid, d);
    for (const c of res.cards) cards.set(c.uid, c);
    for (const uid of res.deleted_decks) decks.delete(uid);
    for (const uid of res.deleted_cards) cards.delete(uid);
    return {
      decks: [...decks.values()].sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at)),
      cards: [...cards.values()].filter((c) => decks.has(c.deck_uid)), // words of deleted folders go too
    };
  }

  /** What the user sees: the confirmed copy plus changes still waiting to be sent. */
  function withPending(base, outbox) {
    const view = JSON.parse(JSON.stringify(base));
    for (const op of outbox) applyOp(view, op);
    return view;
  }

  // ---------- reading ----------
  /** One folder uid or a list of them (a language with its topics). */
  const asSet = (uids) => new Set(Array.isArray(uids) ? uids : [uids]);

  /** A language folder means itself plus all its topics; a topic means only itself. */
  function scopeUids(decks, uid) {
    return [uid, ...decks.filter((d) => d.parent_uid === uid).map((d) => d.uid)];
  }

  function deckStats(cards, deckUids, now = Date.now()) {
    const scope = asSet(deckUids);
    const s = { total: 0, new: 0, learning: 0, forgotten: 0, learned: 0, due: 0, favorite: 0 };
    for (const c of cards) {
      if (!scope.has(c.deck_uid)) continue;
      s.total += 1;
      s[c.status] += 1;
      if (c.favorite) s.favorite += 1;
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

  /** Cards for one lesson, always in random order.
      due        words whose time has come; forgotten ones are picked first, then learning, then new
      forgotten  only forgotten words
      learned    only learned words
      favorite   only words marked with a star
      all        every word */
  function studyCards(cards, deckUids, mode, limit, now = Date.now()) {
    const scope = asSet(deckUids);
    const own = cards.filter((c) => scope.has(c.deck_uid));
    if (mode === "due") {
      // Which words: the most urgent ones (shuffled inside each group, so the
      // same new words aren't always first). Then the lesson itself is shuffled.
      const urgent = shuffle(own.filter((c) => Date.parse(c.due_at) <= now))
        .sort((a, b) => PRIORITY[a.status] - PRIORITY[b.status]);
      return shuffle(urgent.slice(0, limit));
    }
    const picked =
      mode === "favorite" ? own.filter((c) => c.favorite)
      : mode === "forgotten" || mode === "learned" ? own.filter((c) => c.status === mode)
      : own;
    return shuffle(picked).slice(0, limit);
  }

  // ---------- checking a typed answer ----------
  // Words you may leave out: articles, "sich", "etwas"/"jemanden", prepositions.
  // So "kümmern" counts for "sich um etwas kümmern" and "Hund" for "der Hund".
  const OPTIONAL_WORDS = new Set(
    (
      "der die das den dem des ein eine einen einem einer eines " +
      "sich etwas etw jemanden jemandem jemand jmdn jmdm jmd jdn jdm " +
      "um an auf aus bei fuer mit nach ueber unter von vor zu zum zur in im gegen ohne durch " +
      "to the a an sb sth somebody something someone of for with at on by from about"
    ).split(" ")
  );

  /** Lowercase, ä->ae ö->oe ü->ue ß->ss, no punctuation. */
  function loose(text) {
    return String(text)
      .toLowerCase()
      .normalize("NFC")
      .replace(/ä/g, "ae").replace(/ö/g, "oe").replace(/ü/g, "ue").replace(/ß/g, "ss")
      .replace(/[.,!?;:"'«»„“”()[\]…]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  const coreOf = (text) => loose(text).split(" ").filter((w) => w && !OPTIONAL_WORDS.has(w)).join(" ");

  /** "kümmern (sich) / sorgen" -> ["kümmern sich", "kümmern", "sorgen"] */
  function answerVariants(expected) {
    const out = [];
    for (const part of String(expected).split(/[\/;,]|\s+oder\s+|\s+or\s+/)) {
      if (!part.trim()) continue;
      out.push(part.replace(/[()]/g, " "));
      if (/\(.*\)/.test(part)) out.push(part.replace(/\([^)]*\)/g, " "));
    }
    return out.length ? out : [String(expected)];
  }

  function editDistance(a, b) {
    const row = Array.from({ length: b.length + 1 }, (_, j) => j);
    for (let i = 1; i <= a.length; i++) {
      let prev = row[0];
      row[0] = i;
      for (let j = 1; j <= b.length; j++) {
        const tmp = row[j];
        row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
        prev = tmp;
      }
    }
    return row[b.length];
  }

  /** "exact" - written exactly; "close" - right word, small things missing
      (article, sich, preposition, umlaut, one typo) - counts as right;
      "wrong" - wrong. */
  function checkAnswer(input, expected) {
    const given = loose(input);
    if (!given) return "wrong";
    const givenCore = coreOf(input);
    let close = false;
    for (const variant of answerVariants(expected)) {
      if (given === loose(variant)) return "exact";
      const core = coreOf(variant);
      if (!core || !givenCore) continue;
      if (givenCore === core) close = true;
      else if (core.length >= 5 && editDistance(givenCore, core) <= 1) close = true;
    }
    return close ? "close" : "wrong";
  }

  // ---------- German articles ----------
  const ARTICLES = ["der", "die", "das"];

  /** "der Hund" -> { article: "der", noun: "Hund" }; a word without der/die/das -> null.
      "die Straße, -n" keeps the plural note: noun "Straße, -n". */
  function splitArticle(front) {
    const m = String(front).trim().match(/^(der|die|das)\s+(\S.*)$/i);
    return m ? { article: m[1].toLowerCase(), noun: m[2] } : null;
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

  const api = {
    review, parseWordList, applyOp, mergeChanges, withPending, scopeUids, deckStats, studyCards, checkAnswer,
    shuffle, uuid, splitArticle, INTERVAL_DAYS, ARTICLES,
  };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.WC = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
