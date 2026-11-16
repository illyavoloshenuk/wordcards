/* WordCards frontend — plain JavaScript, no build step.

   Offline first: all folders and words live on this device (IndexedDB):
     base    - the copy the server has confirmed
     outbox  - changes made here that the server hasn't seen yet
     view    - base + outbox, what the screens show
   A sync sends the outbox and the "cursor" of the last sync to
   POST /api/sync; the server answers with only what changed since then.
   Sync runs when something changes, when the app opens and when the
   internet comes back - never on a timer, so the free database can sleep.

   Screens are switched by the part of the URL after "#":
     #/login                         login / sign up
     #/                              language folders
     #/deck/<uid>                    one folder: a language (with its topics) or one topic
     #/deck/<uid>/add                add words
     #/deck/<uid>/words              word list
     #/deck/<uid>/study/due          lesson (due | forgotten | learned | favorite | all)
     #/deck/<uid>/game/choose/all    game "pick the translation" (forgotten | favorite | all)
     #/deck/<uid>/game/type/all      game "type the word"
     #/deck/<uid>/game/article/all   game "der, die or das" (German nouns)
*/
"use strict";

// How many cards later a forgotten word comes back inside one lesson.
const REQUEUE_GAP = 5;
const MAX_REPEATS = 3;
const LESSON_SIZES = [10, 20, 30, 50, 0]; // 0 = all words
const ALL_WORDS = 100_000;
const SYNC_AFTER_CHANGE_MS = 4000; // gathers the answers of a lesson into one request
const REFRESH_AFTER_MS = 2 * 60_000; // pull other devices' changes when the app comes back after this

const LANGUAGES = [
  { code: "de-DE", name: "Немецкий", flag: "🇩🇪" },
  { code: "en-GB", name: "Английский", flag: "🇬🇧" },
  { code: "zh-CN", name: "Китайский", flag: "🇨🇳" },
  { code: "es-ES", name: "Испанский", flag: "🇪🇸" },
  { code: "fr-FR", name: "Французский", flag: "🇫🇷" },
  { code: "it-IT", name: "Итальянский", flag: "🇮🇹" },
  { code: "pl-PL", name: "Польский", flag: "🇵🇱" },
  { code: "ja-JP", name: "Японский", flag: "🇯🇵" },
  { code: "", name: "Другой язык", flag: "📁" },
];
const STATUS_NAMES = { new: "Новые", learning: "Учу", forgotten: "Забытые", learned: "Выучены" };

const app = document.getElementById("app");
let cleanup = null; // removes keyboard listeners of the current screen
let currentView = null; // name of the screen on display

// ---------------- helpers ----------------
function esc(text) {
  return String(text ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}
function flagFor(code) {
  return (LANGUAGES.find((l) => l.code === code) || LANGUAGES[LANGUAGES.length - 1]).flag;
}
function wordsCount(n) {
  const m10 = n % 10, m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return `${n} слово`;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return `${n} слова`;
  return `${n} слов`;
}
function changesCount(n) {
  const m10 = n % 10, m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return `${n} изменение`;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return `${n} изменения`;
  return `${n} изменений`;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const reducedMotion = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

let toastTimer;
function toast(message) {
  const el = document.getElementById("toast");
  el.textContent = message;
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), 2600);
}

function speak(text, lang) {
  if (!lang || !("speechSynthesis" in window)) return;
  speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text);
  u.lang = lang;
  speechSynthesis.speak(u);
}

/** Put a forgotten card back into the lesson a few cards later. */
function requeue(queue, position, card) {
  const at = Math.min(position + 1 + REQUEUE_GAP, queue.length);
  queue.splice(at, 0, card);
}

// Settings stored on this device only
const settings = {
  get reverse() { return localStorage.getItem("wc.reverse") === "1"; },
  set reverse(v) { localStorage.setItem("wc.reverse", v ? "1" : "0"); },
  /** How many words in one lesson or game: 10, 20, 30, 50 or 0 (= all). */
  get lessonSize() {
    const n = Number(localStorage.getItem("wc.size") ?? 20);
    return LESSON_SIZES.includes(n) ? n : 20;
  },
  set lessonSize(n) { localStorage.setItem("wc.size", String(n)); },
  get limit() { return this.lessonSize || ALL_WORDS; },
};

// ---------------- talking to the server ----------------
const auth = {
  get token() { return localStorage.getItem("wc.token"); },
  get username() { return localStorage.getItem("wc.user"); },
  save(data) { localStorage.setItem("wc.token", data.access_token); localStorage.setItem("wc.user", data.username); },
  dropToken() { localStorage.removeItem("wc.token"); },
  clear() { localStorage.removeItem("wc.token"); localStorage.removeItem("wc.user"); },
};

class ApiError extends Error {
  constructor(message, status) { super(message); this.status = status; }
}

async function api(path, { method = "GET", body } = {}) {
  const headers = {};
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (auth.token) headers.Authorization = `Bearer ${auth.token}`;
  let res;
  try {
    res = await fetch(`/api${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  } catch {
    throw new ApiError("Нет связи с сервером. Проверь интернет.", 0);
  }
  const data = res.status === 204 ? null : await res.json().catch(() => null);
  if (!res.ok) {
    let msg = data?.detail;
    if (Array.isArray(msg)) msg = "Проверь, правильно ли заполнены поля";
    throw new ApiError(msg || `Ошибка сервера (${res.status})`, res.status);
  }
  return data;
}

// ---------------- the copy on this device ----------------
const idb = {
  db: null,
  open() {
    if (this.db) return Promise.resolve(this.db);
    return new Promise((resolve, reject) => {
      const req = indexedDB.open("wordcards", 1);
      req.onupgradeneeded = () => req.result.createObjectStore("kv");
      req.onsuccess = () => resolve((this.db = req.result));
      req.onerror = () => reject(req.error);
    });
  },
  async get(key) {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const req = db.transaction("kv").objectStore("kv").get(key);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  },
  async set(key, value) {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction("kv", "readwrite");
      tx.objectStore("kv").put(value, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  },
};

const EMPTY = () => ({ user: null, base: { decks: [], cards: [] }, decks: [], cards: [], outbox: [], cursor: null, lastSync: null });

const store = {
  ...EMPTY(),

  async load(user) {
    let saved = null;
    try { saved = await idb.get("data"); } catch { /* private mode: work from memory */ }
    Object.assign(this, EMPTY(), { user });
    if (!saved || saved.user !== user) return;
    if (saved.base) {
      Object.assign(this, { base: saved.base, outbox: saved.outbox, cursor: saved.cursor, lastSync: saved.lastSync });
      this.rebuild();
    } else {
      // Saved by the first offline version: no confirmed copy yet. Show it as it is;
      // the cursor stays empty, so the next sync brings everything fresh.
      Object.assign(this, { base: { decks: saved.decks, cards: saved.cards }, decks: saved.decks, cards: saved.cards, outbox: saved.outbox });
    }
  },

  async save() {
    const { user, base, outbox, cursor, lastSync } = this;
    try {
      await idb.set("data", { user, base, outbox, cursor, lastSync });
    } catch {
      toast("Не получилось сохранить на устройстве");
    }
  },

  rebuild() {
    const view = WC.withPending(this.base, this.outbox);
    this.decks = view.decks;
    this.cards = view.cards;
  },

  /** Make changes: apply them here right away and queue them for the server. */
  commit(...changes) {
    const at = new Date().toISOString();
    for (const change of changes) {
      const op = { op_id: WC.uuid(), at, ...change };
      WC.applyOp(this, op);
      this.outbox.push(op);
    }
    this.save();
    scheduleSync(SYNC_AFTER_CHANGE_MS);
    renderSyncStatus();
  },

  deck(uid) {
    const deck = this.decks.find((d) => d.uid === uid);
    if (!deck) throw new Error("Папка не найдена");
    return deck;
  },
  /** The language folder: the folder itself, or the one a topic is in. */
  root(deck) {
    return (deck.parent_uid && this.decks.find((d) => d.uid === deck.parent_uid)) || deck;
  },
  lang(deck) {
    return deck.lang_code || this.root(deck).lang_code || null;
  },
  languages() {
    return this.decks.filter((d) => !d.parent_uid);
  },
  topicsOf(uid) {
    return this.decks.filter((d) => d.parent_uid === uid);
  },
  /** A language folder means itself + its topics; a topic only itself. */
  scope(uid) {
    return WC.scopeUids(this.decks, uid);
  },
  /** Words of exactly this folder (without its topics). */
  cardsOf(uid) {
    return this.cards.filter((c) => c.deck_uid === uid);
  },
  cardsIn(uid) {
    const scope = new Set(this.scope(uid));
    return this.cards.filter((c) => scope.has(c.deck_uid));
  },
  stats(uid) {
    return WC.deckStats(this.cards, this.scope(uid));
  },
  title(deck) {
    const root = this.root(deck);
    const flag = flagFor(this.lang(deck));
    return root === deck ? `${flag} ${deck.name}` : `${flag} ${root.name} › ${deck.name}`;
  },
};

// ---------------- sync ----------------
let syncing = false;
let syncTimer = null;
let syncProblem = null; // null | "offline" | "server"
let retryDelay = 30_000;

function scheduleSync(delay = 0) {
  clearTimeout(syncTimer);
  syncTimer = setTimeout(syncNow, delay);
}

async function syncNow() {
  if (syncing || !auth.token) return;
  syncing = true;
  renderSyncStatus();
  try {
    let changed = false;
    do {
      const sending = store.outbox.slice(0, 500);
      const res = await api("/sync", { method: "POST", body: { ops: sending, since: store.cursor } });
      // The sent changes are now part of the server's answer. Changes made
      // while we waited stay in the queue and are shown on top of it.
      store.outbox.splice(0, sending.length);
      store.base = WC.mergeChanges(store.base, res);
      store.cursor = res.cursor;
      store.rebuild();
      store.lastSync = new Date().toISOString();
      await store.save();
      changed ||= res.full || res.decks.length + res.cards.length + res.deleted_decks.length + res.deleted_cards.length > 0;
      if (res.rejected.length) toast(`Сервер не принял ${changesCount(res.rejected.length)}`);
    } while (store.outbox.length);
    syncProblem = null;
    retryDelay = 30_000;
    if (changed && (currentView === "home" || currentView === "deck")) router();
  } catch (e) {
    if (e.status === 401) {
      // Login expired: keep the words and the queue, just ask to log in again.
      auth.dropToken();
      toast("Войди снова, чтобы сохранить изменения на сервере");
      location.hash = "#/login";
    }
    syncProblem = e.status ? "server" : "offline";
    // Unsent changes: try again later, waiting longer each time (max 5 min).
    if (store.outbox.length && auth.token) {
      scheduleSync(retryDelay);
      retryDelay = Math.min(retryDelay * 2, 5 * 60_000);
    }
  } finally {
    syncing = false;
    renderSyncStatus();
  }
}

function renderSyncStatus() {
  const el = document.getElementById("sync-status");
  if (!el) return;
  const waiting = store.outbox.length;
  let text, cls;
  if (syncing) { text = "Сохраняю на сервере…"; cls = ""; }
  else if (syncProblem && waiting) {
    text = `Нет связи с сервером. ${changesCount(waiting)} на телефоне — отправлю, когда появится интернет.`;
    cls = "warn";
  } else if (syncProblem) { text = "Работаю без интернета"; cls = "warn"; }
  else if (waiting) { text = `Ждут отправки: ${changesCount(waiting)}`; cls = ""; }
  else { text = "✓ Всё сохранено на сервере"; cls = "ok"; }
  el.textContent = text;
  el.className = `sync-status small ${cls}`;
}

window.addEventListener("online", () => scheduleSync());
document.addEventListener("visibilitychange", () => {
  if (document.hidden) return;
  const stale = !store.lastSync || Date.now() - Date.parse(store.lastSync) > REFRESH_AFTER_MS;
  if (store.outbox.length || stale) scheduleSync();
});

// ---------------- router ----------------
const routes = [
  [/^\/login$/, viewLogin, "login"],
  [/^\/$/, viewHome, "home"],
  [/^\/deck\/([\w-]+)$/, viewDeck, "deck"],
  [/^\/deck\/([\w-]+)\/add$/, viewAdd, "add"],
  [/^\/deck\/([\w-]+)\/words$/, viewWords, "words"],
  [/^\/deck\/([\w-]+)\/study\/(due|forgotten|learned|favorite|all)$/, viewStudy, "study"],
  [/^\/deck\/([\w-]+)\/game\/(choose|type)\/(forgotten|favorite|all)$/, viewGame, "game"],
  [/^\/deck\/([\w-]+)\/game\/article\/(favorite|all)$/, viewArticles, "game"],
];

async function router() {
  if (cleanup) { cleanup(); cleanup = null; }
  const path = location.hash.replace(/^#/, "") || "/";
  if (!auth.token && path !== "/login") { location.hash = "#/login"; return; }
  for (const [pattern, view, name] of routes) {
    const m = path.match(pattern);
    if (m) {
      currentView = name;
      try {
        await view(...m.slice(1));
      } catch (e) {
        app.innerHTML = `<div class="empty stack"><p>${esc(e.message)}</p><a class="btn" href="#/">На главную</a></div>`;
      }
      renderSyncStatus();
      return;
    }
  }
  location.hash = "#/";
}
window.addEventListener("hashchange", () => { router(); window.scrollTo(0, 0); });

function topbar(title, backHref, extra = "") {
  const back = backHref ? `<a class="icon-btn" href="${backHref}" aria-label="Назад">←</a>` : "";
  return `<header class="topbar">${back}<h1>${esc(title)}</h1>${extra}</header>`;
}

function statusBar(s) {
  if (!s.total) return `<div class="bar"></div>`;
  const part = (k) => `<span class="s-${k}" style="width:${(s[k] / s.total) * 100}%"></span>`;
  return `<div class="bar" aria-hidden="true">${part("learned")}${part("learning")}${part("forgotten")}${part("new")}</div>`;
}
function legend(s) {
  const item = (k, color) => `<span><i style="background:var(--${color})"></i>${STATUS_NAMES[k]} ${s[k]}</span>`;
  return `<div class="legend">${item("learned", "know")}${item("learning", "learning")}${item("forgotten", "forgot")}${item("new", "line")}</div>`;
}
const syncLine = `<p id="sync-status" class="sync-status small" role="status"></p>`;

// ---------------- login ----------------
function viewLogin() {
  if (auth.token) { location.hash = "#/"; return; }
  let mode = "login";
  const returning = auth.username;
  app.innerHTML = `
    <section class="login stack">
      <div>
        <p class="brand">WordCards</p>
        <p class="muted">Карточки, чтобы выучить слова любого языка.</p>
      </div>
      <div class="tabs" role="tablist">
        <button role="tab" data-mode="login" aria-selected="true">Вход</button>
        <button role="tab" data-mode="register" aria-selected="false">Регистрация</button>
      </div>
      <form id="auth-form" class="stack" novalidate>
        <div><label for="u">Имя пользователя</label>
          <input id="u" name="username" autocomplete="username" autocapitalize="off" required minlength="3" value="${esc(returning || "")}"></div>
        <div><label for="p">Пароль</label>
          <input id="p" name="password" type="password" autocomplete="current-password" required minlength="6"></div>
        <p class="error-text" id="err"></p>
        <button class="btn btn-primary btn-block" id="submit">Войти</button>
      </form>
      <p class="small muted">Войти нужно один раз, с интернетом. Потом приложение работает и без него.</p>
    </section>`;

  const submit = app.querySelector("#submit");
  app.querySelectorAll("[role=tab]").forEach((tab) =>
    tab.addEventListener("click", () => {
      mode = tab.dataset.mode;
      app.querySelectorAll("[role=tab]").forEach((t) => t.setAttribute("aria-selected", t === tab));
      submit.textContent = mode === "login" ? "Войти" : "Создать аккаунт";
      app.querySelector("#p").autocomplete = mode === "login" ? "current-password" : "new-password";
      app.querySelector("#err").textContent = "";
    })
  );

  app.querySelector("#auth-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const username = e.target.username.value.trim();
    const password = e.target.password.value;
    const err = app.querySelector("#err");
    if (!/^[A-Za-z0-9_.-]{3,50}$/.test(username)) {
      err.textContent = "Имя: от 3 символов, латинские буквы, цифры, точка, _ или -";
      return;
    }
    if (password.length < 6) { err.textContent = "Пароль: минимум 6 символов"; return; }
    submit.disabled = true;
    try {
      const data = await api(`/auth/${mode}`, { method: "POST", body: { username, password } });
      auth.save(data);
      await store.load(data.username); // keeps unsent changes if it's the same user
      submit.textContent = "Загружаю слова…";
      await syncNow();
      location.hash = "#/";
    } catch (ex) {
      err.textContent = ex.message;
    } finally {
      submit.disabled = false;
    }
  });
}

// ---------------- home: language folders ----------------
function viewHome() {
  const menu = `<button class="text-btn" id="logout">Выйти</button>`;
  const decks = store.languages().map((d) => ({ ...d, stats: store.stats(d.uid), topics: store.topicsOf(d.uid).length }));
  const list = decks.length
    ? `<div class="folders">${decks.map((d) => `
        <a class="folder" href="#/deck/${d.uid}">
          <div class="folder-head">
            <span class="folder-flag" aria-hidden="true">${flagFor(d.lang_code)}</span>
            <span class="folder-name">${esc(d.name)}</span>
            ${d.stats.due ? `<span class="due-badge" title="Пора повторить">${d.stats.due}</span>` : ""}
          </div>
          <div class="folder-meta">${statusBar(d.stats)}
            <p class="small muted" style="margin-top:8px">${wordsCount(d.stats.total)} · выучено ${d.stats.learned}${d.topics ? ` · тем: ${d.topics}` : ""}</p>
          </div>
        </a>`).join("")}</div>`
    : `<div class="empty stack"><div class="stack-of-cards" aria-hidden="true">Aa</div>
        <p>Создай первую папку — например «Немецкий». Потом добавишь в неё слова.</p></div>`;

  app.innerHTML = `
    ${topbar("Мои языки", null, menu)}
    <div class="stack">
      ${list}
      <button class="btn btn-primary btn-block" id="new-deck">＋ Новая папка</button>
      <div class="foot">${syncLine}<p class="small muted">Вы вошли как ${esc(auth.username)}</p></div>
    </div>`;

  app.querySelector("#logout").onclick = () => {
    const waiting = store.outbox.length;
    const warning = waiting
      ? `${changesCount(waiting)} ещё не отправлены на сервер и пропадут. Всё равно выйти?`
      : "Выйти из аккаунта?";
    if (!confirm(warning)) return;
    auth.clear();
    Object.assign(store, EMPTY());
    store.save();
    location.hash = "#/login";
  };
  app.querySelector("#new-deck").onclick = () => deckDialog();
}

/** Create or edit a language folder, or (with a parent) a topic inside it. */
function deckDialog(deck = null, parent = null) {
  parent = parent || (deck?.parent_uid ? store.deck(deck.parent_uid) : null);
  const isTopic = !!parent;
  const dlg = document.createElement("dialog");
  const options = LANGUAGES.map(
    (l) => `<option value="${l.code}" ${deck && deck.lang_code === l.code ? "selected" : ""}>${l.flag} ${l.name}</option>`
  ).join("");
  const title = isTopic ? (deck ? "Настройки темы" : `Новая тема в «${parent.name}»`) : deck ? "Настройки папки" : "Новая папка";
  dlg.innerHTML = `
    <form method="dialog">
      <h2>${esc(title)}</h2>
      ${isTopic
        ? `<p class="small muted">Тема — это отдельная папка внутри языка, например «Кошки» или «Работа». Её можно учить отдельно, а урок всего языка берёт слова и из тем.</p>`
        : `<div><label for="lang">Язык</label><select id="lang" name="lang">${options}</select></div>`}
      <div><label for="name">Название</label>
        <input id="name" name="name" maxlength="80" required value="${esc(deck?.name || "")}" placeholder="${isTopic ? "Кошки" : "Немецкий"}"></div>
      ${isTopic ? "" : `<p class="small muted">Язык нужен, чтобы приложение могло произносить слова вслух.</p>`}
      <div class="dialog-btns">
        <button class="btn" value="cancel" formnovalidate>Отмена</button>
        <button class="btn btn-primary" value="save">${deck ? "Сохранить" : "Создать"}</button>
      </div>
      ${deck && isTopic ? `<button class="btn btn-danger btn-block" value="delete" formnovalidate>Удалить тему, слова оставить</button>
        <p class="small muted">Слова перейдут в «${esc(parent.name)}».</p>
        <button class="btn btn-danger btn-block" value="delete-all" formnovalidate>Удалить тему вместе со словами</button>` : ""}
      ${deck && !isTopic ? `<button class="btn btn-danger btn-block" value="delete" formnovalidate>Удалить папку со всеми словами</button>` : ""}
    </form>`;
  document.body.append(dlg);
  const name = dlg.querySelector("#name");
  const lang = dlg.querySelector("#lang");
  if (lang) {
    // Fill the name from the chosen language, until the user types their own.
    let touched = !!deck;
    name.addEventListener("input", () => (touched = true));
    lang.addEventListener("change", () => {
      if (!touched) name.value = lang.value ? LANGUAGES.find((l) => l.code === lang.value).name : "";
    });
    if (!deck) name.value = LANGUAGES[0].name;
  }

  dlg.addEventListener("close", () => {
    const action = dlg.returnValue;
    dlg.remove();
    if (action === "save" && name.value.trim()) {
      const uid = deck ? deck.uid : WC.uuid();
      store.commit({
        type: "deck_upsert",
        uid,
        name: name.value.trim().slice(0, 80),
        lang_code: isTopic ? parent.lang_code || null : lang.value || null,
        parent_uid: isTopic ? parent.uid : null,
      });
      if (deck) router();
      else location.hash = `#/deck/${uid}/add`;
    } else if (action === "delete" && isTopic) {
      if (!confirm(`Удалить тему «${deck.name}»? Её слова перейдут в «${parent.name}».`)) return;
      const moves = store.cardsOf(deck.uid).map((c) => moveOp(c, parent.uid));
      store.commit(...moves, { type: "deck_delete", uid: deck.uid });
      toast("Тема удалена, слова сохранены");
      location.hash = `#/deck/${parent.uid}`;
    } else if (action === "delete-all" && isTopic) {
      deleteTopicWithWords(deck, parent);
    } else if (action === "delete" && confirm(`Удалить «${deck.name}» со всеми темами и словами?`)) {
      store.commit({ type: "deck_delete", uid: deck.uid });
      toast("Папка удалена");
      location.hash = "#/";
    }
  });
  dlg.showModal();
}

/** Delete a topic and every word in it, after asking. */
function deleteTopicWithWords(topic, parent) {
  const n = store.cardsOf(topic.uid).length;
  if (!confirm(`Удалить тему «${topic.name}» и ${wordsCount(n)} в ней? Это нельзя отменить.`)) return;
  store.commit({ type: "deck_delete", uid: topic.uid });
  toast(`Тема удалена вместе со словами: ${wordsCount(n)}`);
  location.hash = `#/deck/${parent.uid}`;
}

/** A small window that asks for a name. Resolves with the text, or null on cancel. */
function askName(title, placeholder = "") {
  return new Promise((resolve) => {
    const dlg = document.createElement("dialog");
    dlg.innerHTML = `
      <form method="dialog">
        <h2>${esc(title)}</h2>
        <div><label for="nm">Название</label><input id="nm" maxlength="80" required placeholder="${esc(placeholder)}"></div>
        <div class="dialog-btns">
          <button class="btn" value="cancel" formnovalidate>Отмена</button>
          <button class="btn btn-primary" value="ok">Создать</button>
        </div>
      </form>`;
    document.body.append(dlg);
    dlg.addEventListener("close", () => {
      const value = dlg.querySelector("#nm").value.trim().slice(0, 80);
      dlg.remove();
      resolve(dlg.returnValue === "ok" && value ? value : null);
    });
    dlg.showModal();
  });
}

/** Change for a new topic inside a language folder. */
function newTopicOp(root, name) {
  return { type: "deck_upsert", uid: WC.uuid(), name, lang_code: root.lang_code || null, parent_uid: root.uid };
}

/** Is this folder German? Then the der/die/das game makes sense. */
const isGerman = (lang) => !!lang && lang.toLowerCase().startsWith("de");

/** Move a word to another folder of the same language; its progress stays. */
function moveOp(card, deckUid) {
  const { uid, front, back, example, example_translation } = card;
  return { type: "card_upsert", uid, deck_uid: deckUid, front, back, example, example_translation };
}

/** <select> with the language folder and its topics. */
function topicSelect(root, selected, id = "topic") {
  const opts = [root, ...store.topicsOf(root.uid)].map(
    (d) => `<option value="${d.uid}" ${d.uid === selected ? "selected" : ""}>${d === root ? `Без темы (просто «${esc(root.name)}»)` : esc(d.name)}</option>`
  );
  return `<select id="${id}">${opts.join("")}</select>`;
}

// ---------------- one folder ----------------
function viewDeck(id) {
  const deck = store.deck(id);
  const root = store.root(deck);
  const isTopic = root !== deck;
  const s = store.stats(id);
  const topics = isTopic ? [] : store.topicsOf(id);
  const back = isTopic ? `#/deck/${root.uid}` : "#/";
  const gear = `<button class="icon-btn" id="settings" aria-label="Настройки">⋯</button>`;
  const off = (n) => (n ? "" : 'aria-disabled="true" tabindex="-1"');

  const topicsSection = isTopic ? "" : `
    <section class="section">
      <h2>Темы <span class="count">${topics.length}</span></h2>
      <p class="muted small">${topics.length
        ? "Учи тему отдельно — или весь язык сразу: урок выше берёт слова и из всех тем."
        : "Разложи слова по темам, например «Кошки» или «Работа», и учи их отдельно."}</p>
      ${topics.length ? `<ul class="topics">${topics.map((t) => {
        const ts = store.stats(t.uid);
        return `<li><a class="topic-row" href="#/deck/${t.uid}">
          <span class="grow"><span class="topic-name">${esc(t.name)}</span>
            <span class="small muted">${wordsCount(ts.total)} · выучено ${ts.learned}</span></span>
          ${ts.due ? `<span class="due-badge" title="Пора повторить">${ts.due}</span>` : ""}
          <span aria-hidden="true" class="muted">›</span></a></li>`;
      }).join("")}</ul>` : ""}
      <div class="btns"><button class="btn" id="new-topic">＋ Новая тема</button></div>
    </section>`;

  if (!s.total) {
    app.innerHTML = `
      ${topbar(store.title(deck), back, gear)}
      <div class="stack">
        <div class="empty stack"><div class="stack-of-cards" aria-hidden="true">Aa</div>
          <p>${isTopic ? "В теме пока нет слов." : "В папке пока нет слов."}</p>
          <a class="btn btn-primary btn-block" href="#/deck/${id}/add">Добавить слова</a></div>
        ${topicsSection}
      </div>`;
    app.querySelector("#settings").onclick = () => deckDialog(deck);
    app.querySelector("#new-topic")?.addEventListener("click", () => deckDialog(null, deck));
    return;
  }

  const german = isGerman(store.lang(deck));
  const size = settings.lessonSize;
  const lessonCount = Math.min(s.due, settings.limit);
  const sizeChips = LESSON_SIZES.map(
    (n) => `<button class="chip" data-size="${n}" aria-pressed="${n === size}">${n || "Все"}</button>`
  ).join("");

  app.innerHTML = `
    ${topbar(store.title(deck), back, gear)}
    <div class="stack">
      <div>${statusBar(s)}${legend(s)}</div>

      <div>
        <p class="small muted" id="size-label" style="margin-bottom:6px">Слов за один урок</p>
        <div class="chips" role="group" aria-labelledby="size-label">${sizeChips}</div>
      </div>

      ${lessonCount
        ? `<a class="btn btn-primary btn-block btn-big" href="#/deck/${id}/study/due">Начать урок · ${wordsCount(lessonCount)}</a>`
        : `<div class="section"><h2>На сегодня всё</h2>
            <p class="muted small">Новых слов нет, а выученные вернутся, когда придёт время. Можно добавить слова или пройти все карточки.</p></div>`}
      <a class="btn btn-block" href="#/deck/${id}/study/all">Все слова вразброс · ${wordsCount(Math.min(s.total, settings.limit))}</a>

      <label class="row small muted" style="font-weight:500;cursor:pointer">
        <input type="checkbox" id="reverse" style="width:20px;min-height:20px" ${settings.reverse ? "checked" : ""}>
        Показывать сначала перевод, а слово вспоминать
      </label>

      ${topicsSection}

      <section class="section">
        <h2>★ Избранное <span class="count">${s.favorite}</span></h2>
        <p class="muted small">${s.favorite
          ? "Слова, которые для тебя сейчас важнее всего."
          : "Отмечай важные слова звёздочкой ☆ прямо во время урока или в «Все слова» — они соберутся здесь."}</p>
        <div class="btns">
          <a class="btn" href="#/deck/${id}/study/favorite" ${off(s.favorite)}>Карточки</a>
          <a class="btn" href="#/deck/${id}/game/choose/favorite" ${off(s.favorite)}>Выбери перевод</a>
          <a class="btn" href="#/deck/${id}/game/type/favorite" ${off(s.favorite)}>Напиши слово</a>
          ${german ? `<a class="btn" href="#/deck/${id}/game/article/favorite" ${off(s.favorite)}>der · die · das</a>` : ""}
        </div>
      </section>

      <section class="section">
        <h2>Забытые <span class="count">${s.forgotten}</span></h2>
        <p class="muted small">Слова, на которых ты нажал «Не помню». Повтори их, пока не запомнишь.</p>
        <div class="btns">
          <a class="btn" href="#/deck/${id}/study/forgotten" ${off(s.forgotten)}>Карточки</a>
          <a class="btn" href="#/deck/${id}/game/choose/forgotten" ${off(s.forgotten)}>Выбери перевод</a>
          <a class="btn" href="#/deck/${id}/game/type/forgotten" ${off(s.forgotten)}>Напиши слово</a>
        </div>
      </section>

      <section class="section">
        <h2>Выученные <span class="count">${s.learned}</span></h2>
        <p class="muted small">Слово считается выученным, когда ты 5 раз подряд вспомнил его с перерывами в несколько дней.</p>
        <div class="btns">
          <a class="btn" href="#/deck/${id}/study/learned" ${off(s.learned)}>Повторить выученные</a>
        </div>
      </section>

      <section class="section">
        <h2>Игры ${isTopic ? "со словами темы" : "со всеми словами"}</h2>
        <div class="btns">
          <a class="btn" href="#/deck/${id}/game/choose/all">Выбери перевод</a>
          <a class="btn" href="#/deck/${id}/game/type/all">Напиши слово</a>
          ${german ? `<a class="btn" href="#/deck/${id}/game/article/all">der · die · das</a>` : ""}
        </div>
      </section>

      <div class="row">
        <a class="btn grow" href="#/deck/${id}/add">＋ Добавить слова</a>
        <a class="btn grow" href="#/deck/${id}/words">Все слова · ${s.total}</a>
      </div>
      <div class="foot">${syncLine}</div>
    </div>`;

  app.querySelector("#settings").onclick = () => deckDialog(deck);
  app.querySelector("#new-topic")?.addEventListener("click", () => deckDialog(null, deck));
  app.querySelector("#reverse").onchange = (e) => (settings.reverse = e.target.checked);
  app.querySelectorAll("[data-size]").forEach((chip) =>
    chip.addEventListener("click", () => { settings.lessonSize = Number(chip.dataset.size); router(); })
  );
}

// ---------------- add words ----------------
function viewAdd(id) {
  const deck = store.deck(id);
  const root = store.root(deck);
  const hasTopics = store.topicsOf(root.uid).length > 0;
  app.innerHTML = `
    ${topbar("Добавить слова", `#/deck/${id}`)}
    <form class="stack" id="add-form">
      ${hasTopics ? `<div><label for="topic">Куда добавить</label>${topicSelect(root, id)}</div>` : ""}
      <div>
        <label for="text">Список слов</label>
        <div class="format-hint small">
          <p>Одно слово на строку: <b>слово - перевод</b>.</p>
          <p>Под словом можно добавить пример:<br>
            строка с <code>--</code> — пример,<br>
            строка с <code>...</code> — перевод примера.</p>
        </div>
        <textarea id="text" name="text" spellcheck="false" placeholder="der Hund - собака
-- Der Hund schläft im Garten.
... Собака спит в саду.
laufen - бегать
die Straße - улица"></textarea>
      </div>
      <div id="result"></div>
      <button class="btn btn-primary btn-block" id="save">Добавить</button>
    </form>`;

  const form = app.querySelector("#add-form");
  const result = app.querySelector("#result");
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const text = form.text.value;
    if (!text.trim()) { result.innerHTML = `<p class="error-text">Напиши хотя бы одно слово</p>`; return; }

    const target = app.querySelector("#topic")?.value || id;
    const parsed = WC.parseWordList(text);
    // The same word twice in one language makes no sense, whatever the topic.
    const existing = new Set(store.cardsIn(root.uid).map((c) => c.front.toLowerCase()));
    const skipped = [];
    const changes = [];
    for (const w of parsed.words) {
      const key = w.front.toLowerCase();
      if (existing.has(key)) { skipped.push(w.front); continue; }
      existing.add(key);
      changes.push({ type: "card_upsert", uid: WC.uuid(), deck_uid: target, ...w });
    }
    if (changes.length) store.commit(...changes);

    const parts = [];
    if (skipped.length) parts.push(`<p class="small muted">Уже были в «${esc(root.name)}»: ${esc(skipped.join(", "))}. Перенести слово в тему можно в «Все слова».</p>`);
    if (parsed.errors.length) {
      parts.push(`<p class="error-text">Не понял эти строки. У слова нужен перевод через « - », а строка с -- или ... должна идти под словом:</p>`);
      form.text.value = parsed.errors.join("\n");
    } else {
      form.text.value = "";
    }
    result.innerHTML = `<div class="section"><p><b>Добавлено: ${wordsCount(changes.length)}</b></p>${parts.join("")}
      <div class="btns"><a class="btn btn-primary" href="#/deck/${target}">Открыть «${esc(store.deck(target).name)}»</a></div></div>`;
    if (changes.length) toast(`Добавлено: ${wordsCount(changes.length)}`);
  });
}

// ---------------- word list ----------------
const NEW_TOPIC = "__new__";

function viewWords(id) {
  const deck = store.deck(id);
  const root = store.root(deck);
  const isTopic = root !== deck;
  let filter = "all";
  let query = "";
  let selecting = false;
  let shown = [];
  const selected = new Set();

  const filters = { all: "Все", favorite: "★ Избранное", ...STATUS_NAMES };
  app.innerHTML = `
    ${topbar(isTopic ? `Все слова · ${deck.name}` : "Все слова", `#/deck/${id}`, `<button class="text-btn" id="select">Выбрать</button>`)}
    <div class="stack">
      <input type="search" id="q" placeholder="Поиск" aria-label="Поиск слова">
      <div class="chips" role="group" aria-label="Фильтр">
        ${Object.entries(filters).map(([k, v]) => `<button class="chip" data-f="${k}" aria-pressed="${k === "all"}">${v}</button>`).join("")}
      </div>
      <ul class="words" id="list"></ul>
      ${isTopic ? `<button class="btn btn-danger btn-block" id="delete-topic">Удалить тему «${esc(deck.name)}» со всеми словами</button>` : ""}
    </div>
    <div class="move-bar" id="move-bar" hidden>
      <div class="row">
        <span id="move-count" class="small grow"></span>
        <button class="text-btn" id="select-all">Выбрать все</button>
      </div>
      <div class="row">
        <select id="move-to" aria-label="Куда перенести"></select>
        <button class="btn btn-primary" id="move">Перенести</button>
      </div>
      <div class="row">
        <button class="btn grow" id="fav-selected">★ В избранное</button>
        <button class="btn btn-danger grow" id="delete-selected">Удалить</button>
      </div>
    </div>`;

  const list = app.querySelector("#list");
  const bar = app.querySelector("#move-bar");
  const moveTo = app.querySelector("#move-to");
  const topicName = (c) => (c.deck_uid !== root.uid && c.deck_uid !== id ? store.decks.find((d) => d.uid === c.deck_uid)?.name : "");

  function fillTopics(selectedUid = root.uid) {
    const opts = [root, ...store.topicsOf(root.uid)].map(
      (d) => `<option value="${d.uid}" ${d.uid === selectedUid ? "selected" : ""}>${d === root ? `Без темы («${esc(root.name)}»)` : esc(d.name)}</option>`
    );
    opts.push(`<option value="${NEW_TOPIC}">＋ Новая тема…</option>`);
    moveTo.innerHTML = opts.join("");
  }
  fillTopics();

  function chosen() {
    return store.cards.filter((c) => selected.has(c.uid));
  }

  function draw() {
    // Words deleted meanwhile (here or by a sync) can't stay selected.
    const existing = new Set(store.cards.map((c) => c.uid));
    for (const uid of selected) if (!existing.has(uid)) selected.delete(uid);

    const q = query.toLowerCase();
    shown = store.cardsIn(id)
      .filter((c) => filter === "all" || (filter === "favorite" ? c.favorite : c.status === filter))
      .filter((c) => !q || c.front.toLowerCase().includes(q) || c.back.toLowerCase().includes(q))
      .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
    list.innerHTML = shown.length
      ? shown.map((c) => `
          <li><button class="word-row" data-uid="${c.uid}" aria-pressed="${selected.has(c.uid)}">
            ${selecting ? `<span class="tick" aria-hidden="true">${selected.has(c.uid) ? "✓" : ""}</span>` : ""}
            <span class="dot ${c.status}" title="${STATUS_NAMES[c.status]}"></span>
            <span class="grow"><span class="w">${esc(c.front)}</span><br><span class="t">${esc(c.back)}</span></span>
            ${c.favorite ? `<span class="star-mark" title="В избранном">★</span>` : ""}
            ${topicName(c) ? `<span class="tag">${esc(topicName(c))}</span>` : ""}
          </button></li>`).join("")
      : `<li class="empty muted">Ничего не найдено</li>`;

    bar.hidden = !selecting;
    const picked = chosen();
    app.querySelector("#move-count").textContent = `Выбрано: ${wordsCount(picked.length)}`;
    const allShown = shown.length > 0 && shown.every((c) => selected.has(c.uid));
    app.querySelector("#select-all").textContent = allShown ? "Снять выбор" : "Выбрать все";
    const allFav = picked.length > 0 && picked.every((c) => c.favorite);
    app.querySelector("#fav-selected").textContent = allFav ? "☆ Убрать из избранного" : "★ В избранное";
    for (const b of ["#move", "#fav-selected", "#delete-selected"]) app.querySelector(b).disabled = !picked.length;
  }

  function stopSelecting() {
    selecting = false;
    selected.clear();
    app.querySelector("#select").textContent = "Выбрать";
    draw();
  }

  draw();

  app.querySelector("#q").addEventListener("input", (e) => { query = e.target.value.trim(); draw(); });
  app.querySelectorAll(".chip").forEach((chip) =>
    chip.addEventListener("click", () => {
      filter = chip.dataset.f;
      app.querySelectorAll(".chip").forEach((c) => c.setAttribute("aria-pressed", c === chip));
      draw();
    })
  );
  app.querySelector("#select").addEventListener("click", (e) => {
    if (selecting) { stopSelecting(); return; }
    selecting = true;
    e.target.textContent = "Отмена";
    draw();
  });
  app.querySelector("#select-all").addEventListener("click", () => {
    const allShown = shown.every((c) => selected.has(c.uid));
    for (const c of shown) allShown ? selected.delete(c.uid) : selected.add(c.uid);
    draw();
  });

  app.querySelector("#move").addEventListener("click", async () => {
    const picked = chosen();
    if (!picked.length) return;
    let to = moveTo.value;
    const changes = [];
    if (to === NEW_TOPIC) {
      const name = await askName(`Новая тема в «${root.name}»`, "Кошки");
      if (!name) { fillTopics(); return; }
      const topic = newTopicOp(root, name);
      changes.push(topic);
      to = topic.uid;
    }
    changes.push(...picked.filter((c) => c.deck_uid !== to).map((c) => moveOp(c, to)));
    if (changes.length) store.commit(...changes);
    toast(`Перенесено в «${store.deck(to).name}»: ${wordsCount(picked.length)}`);
    fillTopics();
    stopSelecting();
  });

  app.querySelector("#fav-selected").addEventListener("click", () => {
    const picked = chosen();
    const favorite = !picked.every((c) => c.favorite);
    const changes = picked.filter((c) => !!c.favorite !== favorite).map((c) => ({ type: "card_favorite", uid: c.uid, favorite }));
    if (changes.length) store.commit(...changes);
    toast(favorite ? `В избранном: ${wordsCount(picked.length)}` : `Убрано из избранного: ${wordsCount(picked.length)}`);
    stopSelecting();
  });

  app.querySelector("#delete-selected").addEventListener("click", () => {
    const picked = chosen();
    if (!picked.length) return;
    const names = picked.slice(0, 5).map((c) => c.front).join(", ") + (picked.length > 5 ? "…" : "");
    if (!confirm(`Удалить ${wordsCount(picked.length)}? (${names})\nЭто нельзя отменить.`)) return;
    store.commit(...picked.map((c) => ({ type: "card_delete", uid: c.uid })));
    toast(`Удалено: ${wordsCount(picked.length)}`);
    stopSelecting();
  });

  app.querySelector("#delete-topic")?.addEventListener("click", () => deleteTopicWithWords(deck, root));

  list.addEventListener("click", (e) => {
    const row = e.target.closest(".word-row");
    const card = row && store.cards.find((c) => c.uid === row.dataset.uid);
    if (!card) return;
    if (selecting) {
      if (selected.has(card.uid)) selected.delete(card.uid);
      else selected.add(card.uid);
      draw();
    } else {
      editDialog(card, draw);
    }
  });
}

function editDialog(card, onChange) {
  const root = store.root(store.deck(card.deck_uid));
  const dlg = document.createElement("dialog");
  dlg.innerHTML = `
    <form method="dialog">
      <h2>Изменить слово</h2>
      <div><label for="f">Слово</label><input id="f" maxlength="200" required value="${esc(card.front)}"></div>
      <div><label for="b">Перевод</label><input id="b" maxlength="200" required value="${esc(card.back)}"></div>
      <div><label for="ex">Пример</label><textarea id="ex" class="short" maxlength="1000">${esc(card.example || "")}</textarea></div>
      <div><label for="ext">Перевод примера</label><textarea id="ext" class="short" maxlength="1000">${esc(card.example_translation || "")}</textarea></div>
      ${store.topicsOf(root.uid).length ? `<div><label for="topic">Тема</label>${topicSelect(root, card.deck_uid)}</div>` : ""}
      <label class="row" style="font-weight:500;cursor:pointer">
        <input type="checkbox" id="fav" style="width:20px;min-height:20px" ${card.favorite ? "checked" : ""}> ★ В избранном
      </label>
      <p class="small muted">${STATUS_NAMES[card.status]} · вспомнил ${card.times_correct}, забыл ${card.times_wrong}</p>
      <div class="dialog-btns">
        <button class="btn" value="cancel" formnovalidate>Отмена</button>
        <button class="btn btn-primary" value="save">Сохранить</button>
      </div>
      <div class="dialog-btns">
        <button class="btn" value="reset" formnovalidate>Учить заново</button>
        <button class="btn btn-danger" value="delete" formnovalidate>Удалить</button>
      </div>
    </form>`;
  document.body.append(dlg);
  dlg.addEventListener("close", () => {
    const action = dlg.returnValue;
    const v = (sel) => dlg.querySelector(sel).value.trim();
    const values = { front: v("#f"), back: v("#b"), example: v("#ex") || null, example_translation: v("#ext") || null };
    const deckUid = dlg.querySelector("#topic")?.value || card.deck_uid;
    const favorite = dlg.querySelector("#fav").checked;
    dlg.remove();
    if (action === "save" && values.front && values.back) {
      const changes = [{ type: "card_upsert", uid: card.uid, deck_uid: deckUid, ...values }];
      if (favorite !== !!card.favorite) changes.push({ type: "card_favorite", uid: card.uid, favorite });
      store.commit(...changes);
      toast("Сохранено");
    } else if (action === "reset") {
      store.commit({ type: "card_reset", uid: card.uid });
      toast("Слово снова новое");
    } else if (action === "delete" && confirm(`Удалить слово «${card.front}»? Это нельзя отменить.`)) {
      store.commit({ type: "card_delete", uid: card.uid });
      toast("Слово удалено");
    } else return;
    onChange();
  });
  dlg.showModal();
}

// ---------------- lesson with cards ----------------
const LESSON_TITLES = { due: "Урок", forgotten: "Забытые слова", learned: "Выученные слова", favorite: "Избранное", all: "Все слова" };

function viewStudy(id, mode) {
  const deck = store.deck(id);
  const lang = store.lang(deck);
  const cards = WC.studyCards(store.cards, store.scope(id), mode, settings.limit);
  if (!cards.length) {
    app.innerHTML = `${topbar(LESSON_TITLES[mode], `#/deck/${id}`)}
      <div class="empty stack"><p>Здесь пока нет слов.</p><a class="btn" href="#/deck/${id}">К папке</a></div>`;
    return;
  }

  const reverse = settings.reverse;
  const queue = cards.map((c) => ({ ...c })); // a snapshot, so a sync in the middle doesn't disturb the lesson
  const firstAnswer = new Map(); // card uid -> true/false, only the first answer is saved
  const repeats = new Map();
  let pos = 0;
  let busy = false;

  app.innerHTML = `
    <div class="lesson-top">
      <a class="icon-btn" href="#/deck/${id}" aria-label="Закончить урок">✕</a>
      <div class="progress"><span id="prog" style="width:0"></span></div>
      <span class="small muted" id="counter"></span>
      <button class="icon-btn star-btn" id="fav" aria-pressed="false" aria-label="В избранное">☆</button>
      <button class="icon-btn" id="del" aria-label="Удалить слово">🗑</button>
    </div>
    <div class="card-scene"><div class="card" id="card" tabindex="0" aria-label="Карточка, нажми чтобы перевернуть"></div></div>
    <div class="answer-btns">
      <button class="btn btn-forgot" id="forgot"><b>✕</b>Не помню</button>
      <button class="btn" id="flip"><b>↻</b>Перевернуть</button>
      <button class="btn btn-know" id="know"><b>✓</b>Помню</button>
    </div>
    <p class="keys-hint small muted">Клавиши: ← не помню · пробел перевернуть · → помню</p>`;

  const cardEl = app.querySelector("#card");

  function render() {
    const c = queue[pos];
    const word = reverse ? c.back : c.front;
    const answer = reverse ? c.front : c.back;
    const dots = Array.from({ length: 5 }, (_, i) => `<i class="${i < c.box ? "on" : ""}"></i>`).join("");
    const again = repeats.get(c.uid) ? `<span class="card-tag">ещё раз</span>` : "";
    const speakBtn = lang && "speechSynthesis" in window
      ? `<button class="icon-btn speak" data-speak aria-label="Произнести">🔊</button>` : "";
    cardEl.className = "card";
    cardEl.innerHTML = `
      <div class="face front">${again}<span class="box-dots" title="Коробка ${c.box} из 5">${dots}</span>
        <p class="card-word">${esc(word)}</p>
        <p class="card-hint">Вспомни перевод</p>
        ${reverse ? "" : speakBtn}
      </div>
      <div class="face back"><span class="box-dots">${dots}</span>
        <p class="card-word">${esc(answer)}</p>
        <p class="card-sub">${esc(word)}</p>
        ${c.example ? `<p class="card-example">${esc(c.example)}</p>` : ""}
        ${c.example && c.example_translation ? `<p class="card-example-tr">${esc(c.example_translation)}</p>` : ""}
        ${speakBtn}
      </div>`;
    app.querySelector("#counter").textContent = `${Math.min(pos + 1, queue.length)} / ${queue.length}`;
    app.querySelector("#prog").style.width = `${(pos / queue.length) * 100}%`;
    drawStar();
  }

  function drawStar() {
    const on = !!queue[pos].favorite;
    const btn = app.querySelector("#fav");
    btn.textContent = on ? "★" : "☆";
    btn.setAttribute("aria-pressed", on);
    btn.setAttribute("aria-label", on ? "Убрать из избранного" : "В избранное");
  }

  function toggleFavorite() {
    const c = queue[pos];
    const favorite = !c.favorite;
    for (const q of queue) if (q.uid === c.uid) q.favorite = favorite; // the word can be in the queue twice
    store.commit({ type: "card_favorite", uid: c.uid, favorite });
    drawStar();
    toast(favorite ? "★ Добавлено в избранное" : "Убрано из избранного");
  }

  function deleteCurrent() {
    if (busy) return;
    const c = queue[pos];
    if (!confirm(`Удалить слово «${c.front}»? Это нельзя отменить.`)) return;
    store.commit({ type: "card_delete", uid: c.uid });
    firstAnswer.delete(c.uid);
    // Take it out of the rest of the lesson too (a forgotten word comes back later).
    for (let i = queue.length - 1; i >= pos; i--) if (queue[i].uid === c.uid) queue.splice(i, 1);
    toast("Слово удалено");
    if (pos >= queue.length) { finish(); return; }
    cardEl.style.transition = "none";
    render();
    void cardEl.offsetWidth;
    cardEl.style.transition = "";
  }

  function flip() { if (!busy) cardEl.classList.toggle("flipped"); }

  async function answer(known) {
    if (busy) return;
    busy = true;
    const c = queue[pos];
    const wasFlipped = cardEl.classList.contains("flipped");

    if (!firstAnswer.has(c.uid)) {
      firstAnswer.set(c.uid, known);
      store.commit({ type: "card_review", uid: c.uid, known });
    }
    if (!known && (repeats.get(c.uid) || 0) < MAX_REPEATS) {
      repeats.set(c.uid, (repeats.get(c.uid) || 0) + 1);
      requeue(queue, pos, c);
    }

    // Show the answer for a moment, then move on.
    cardEl.classList.add("flipped", known ? "result-know" : "result-forgot");
    await sleep(wasFlipped ? 450 : reducedMotion() ? 1200 : 1500);
    if (currentView !== "study") return; // left the lesson meanwhile
    pos += 1;
    if (pos >= queue.length) { finish(); return; }
    cardEl.style.transition = "none";
    render();
    void cardEl.offsetWidth; // apply the reset before animations come back
    cardEl.style.transition = "";
    busy = false;
  }

  function finish() {
    const answers = [...firstAnswer.values()];
    if (!answers.length) { location.hash = `#/deck/${id}`; return; }
    const knew = answers.filter(Boolean).length;
    app.innerHTML = `
      <section class="summary stack">
        <p class="big">${knew} / ${answers.length}</p>
        <p class="muted">${knew === answers.length ? "Все слова вспомнил с первого раза." : "Забытые слова уже ждут тебя в разделе «Забытые»."}</p>
        <div class="pair"><div><b>${knew}</b>помню</div><div><b>${answers.length - knew}</b>не помню</div></div>
        <a class="btn btn-primary btn-block" href="#/deck/${id}">Готово</a>
      </section>`;
  }

  app.querySelector("#flip").onclick = flip;
  app.querySelector("#fav").onclick = toggleFavorite;
  app.querySelector("#del").onclick = deleteCurrent;
  app.querySelector("#know").onclick = () => answer(true);
  app.querySelector("#forgot").onclick = () => answer(false);
  cardEl.addEventListener("click", (e) => {
    if (e.target.closest("[data-speak]")) { e.stopPropagation(); speak(queue[pos].front, lang); return; }
    flip();
  });
  const onKey = (e) => {
    if (e.target.matches("input, textarea")) return;
    if (e.key === " " || e.key === "Enter") { e.preventDefault(); flip(); }
    else if (e.key === "ArrowRight") answer(true);
    else if (e.key === "ArrowLeft") answer(false);
  };
  document.addEventListener("keydown", onKey);
  cleanup = () => document.removeEventListener("keydown", onKey);

  render();
}

// ---------------- games ----------------
function normalize(text) {
  return text.toLowerCase().normalize("NFC").replace(/[.,!?;:"'«»()]/g, "").replace(/\s+/g, " ").trim();
}

const answerParts = (c) =>
  `${c.example ? `<br><span class="small muted">${esc(c.example)}</span>` : ""}${c.example_translation ? `<br><span class="small muted">${esc(c.example_translation)}</span>` : ""}`;

function viewGame(id, type, mode) {
  const deck = store.deck(id);
  const lang = store.lang(deck);
  const all = store.cardsIn(id).map((c) => ({ ...c }));
  // Wrong answers to choose from: the whole language, so a small topic still works.
  const distractors = store.cardsIn(store.root(deck).uid);
  const pool = mode === "forgotten" ? all.filter((c) => c.status === "forgotten")
    : mode === "favorite" ? all.filter((c) => c.favorite)
    : all;
  const title = type === "choose" ? "Выбери перевод" : "Напиши слово";
  const back = `#/deck/${id}`;

  if (!pool.length || (type === "choose" && distractors.length < 2)) {
    app.innerHTML = `${topbar(title, back)}<div class="empty stack">
      <p>${type === "choose" ? "Для этой игры нужно хотя бы 2 слова в папке." : "Здесь пока нет слов."}</p>
      <a class="btn" href="${back}">К папке</a></div>`;
    return;
  }

  const queue = WC.shuffle(pool).slice(0, settings.limit);
  const firstAnswer = new Map();
  const repeats = new Map();
  let pos = 0;

  app.innerHTML = `
    <div class="lesson-top">
      <a class="icon-btn" href="${back}" aria-label="Закончить игру">✕</a>
      <div class="progress"><span id="prog" style="width:0"></span></div>
      <span class="small muted" id="counter"></span>
    </div>
    <div id="game"></div>`;
  const game = app.querySelector("#game");

  function record(c, known) {
    if (!firstAnswer.has(c.uid)) {
      firstAnswer.set(c.uid, known);
      store.commit({ type: "card_review", uid: c.uid, known });
    }
    if (!known && (repeats.get(c.uid) || 0) < MAX_REPEATS) {
      repeats.set(c.uid, (repeats.get(c.uid) || 0) + 1);
      requeue(queue, pos, c);
    }
  }

  function next() {
    if (currentView !== "game") return;
    pos += 1;
    if (pos >= queue.length) {
      const answers = [...firstAnswer.values()];
      const right = answers.filter(Boolean).length;
      app.innerHTML = `
        <section class="summary stack">
          <p class="big">${right} / ${answers.length}</p>
          <p class="muted">правильных ответов с первой попытки</p>
          <a class="btn btn-primary btn-block" href="#/deck/${id}/game/${type}/${mode}" id="again">Сыграть ещё</a>
          <a class="btn btn-block" href="${back}">К папке</a>
        </section>`;
      app.querySelector("#again").onclick = (e) => { e.preventDefault(); router(); };
      return;
    }
    draw();
  }

  function header(c, word, hint) {
    app.querySelector("#counter").textContent = `${pos + 1} / ${queue.length}`;
    app.querySelector("#prog").style.width = `${(pos / queue.length) * 100}%`;
    return `<div class="card-scene"><div class="card" style="height:auto;min-height:180px;cursor:default">
      <div class="face front" style="position:relative;min-height:180px">
        ${repeats.get(c.uid) ? `<span class="card-tag">ещё раз</span>` : ""}
        <p class="card-word">${esc(word)}</p><p class="card-hint">${hint}</p></div></div></div>`;
  }

  function drawChoose() {
    const c = queue[pos];
    const others = WC.shuffle(distractors.filter((x) => x.uid !== c.uid && normalize(x.back) !== normalize(c.back))).slice(0, 3);
    const options = WC.shuffle([c, ...others]);
    game.innerHTML = `${header(c, c.front, "Выбери правильный перевод")}
      <div class="options">${options.map((o) => `<button class="btn option" data-uid="${o.uid}">${esc(o.back)}</button>`).join("")}</div>`;
    if (lang) speak(c.front, lang);
    game.querySelector(".options").addEventListener("click", async (e) => {
      const btn = e.target.closest(".option");
      if (!btn || game.dataset.locked) return;
      game.dataset.locked = "1";
      const ok = btn.dataset.uid === c.uid;
      game.querySelectorAll(".option").forEach((b) => {
        if (b.dataset.uid === c.uid) b.classList.add("correct");
        else if (b === btn) b.classList.add("wrong");
        b.disabled = true;
      });
      record(c, ok);
      await sleep(ok ? 700 : 1600);
      delete game.dataset.locked;
      next();
    });
  }

  function drawType() {
    const c = queue[pos];
    game.innerHTML = `${header(c, c.back, "Напиши это слово на изучаемом языке")}
      <form id="tf" class="stack" autocomplete="off">
        <input id="ans" autocapitalize="off" autocorrect="off" spellcheck="false" aria-label="Твой ответ" placeholder="Ответ">
        <p class="type-feedback" id="fb"></p>
        <div class="row"><button type="button" class="btn grow" id="skip">Не знаю</button>
          <button class="btn btn-primary grow" id="check">Проверить</button></div>
      </form>`;
    const input = game.querySelector("#ans");
    const fb = game.querySelector("#fb");
    input.focus();
    let done = false;

    // result: "exact" | "close" (right word, article/sich/preposition/typo missing) | "wrong"
    async function resolve(result) {
      if (done) return;
      done = true;
      input.disabled = true;
      game.querySelectorAll("button").forEach((b) => (b.disabled = true));
      const ok = result !== "wrong";
      fb.innerHTML =
        result === "exact" ? `<span class="right">Верно!</span>`
        : result === "close" ? `<span class="right">Засчитано!</span> Полностью: <b>${esc(c.front)}</b>${answerParts(c)}`
        : `<span class="wrong">Правильно: ${esc(c.front)}</span>${answerParts(c)}`;
      if (lang) speak(c.front, lang);
      record(c, ok);
      await sleep(result === "exact" ? 800 : result === "close" ? 2200 : 2600);
      next();
    }
    game.querySelector("#tf").addEventListener("submit", (e) => {
      e.preventDefault();
      if (!input.value.trim()) { input.focus(); return; }
      resolve(WC.checkAnswer(input.value, c.front));
    });
    game.querySelector("#skip").onclick = () => resolve("wrong");
  }

  const draw = type === "choose" ? drawChoose : drawType;
  draw();
}

// ---------------- game: der, die or das ----------------
function viewArticles(id, mode) {
  const deck = store.deck(id);
  const lang = store.lang(deck);
  const back = `#/deck/${id}`;
  const nouns = store.cardsIn(id)
    .filter((c) => mode !== "favorite" || c.favorite)
    .map((c) => ({ ...c, art: WC.splitArticle(c.front) }))
    .filter((c) => c.art);

  if (!nouns.length) {
    app.innerHTML = `${topbar("der · die · das", back)}<div class="empty stack">
      <p>Для этой игры нужны существительные с артиклем, например «der Hund» или «die Katze».</p>
      <a class="btn" href="${back}">К папке</a></div>`;
    return;
  }

  const queue = WC.shuffle(nouns).slice(0, settings.limit);
  const firstAnswer = new Map();
  const repeats = new Map();
  let pos = 0;
  let locked = false;

  app.innerHTML = `
    <div class="lesson-top">
      <a class="icon-btn" href="${back}" aria-label="Закончить игру">✕</a>
      <div class="progress"><span id="prog" style="width:0"></span></div>
      <span class="small muted" id="counter"></span>
    </div>
    <p class="small muted center">Перетащи слово на правильный артикль — или просто нажми на артикль.</p>
    <div class="art-stage">
      <div class="art-card" id="art-card" role="img"></div>
    </div>
    <div class="art-zones">
      ${WC.ARTICLES.map((a) => `<button class="art-zone art-${a}" data-art="${a}">${a}</button>`).join("")}
    </div>
    <p class="type-feedback" id="fb"></p>`;

  const cardEl = app.querySelector("#art-card");
  const fb = app.querySelector("#fb");

  function render() {
    const c = queue[pos];
    cardEl.innerHTML = `${repeats.get(c.uid) ? `<span class="card-tag">ещё раз</span>` : ""}
      <p class="card-word">${esc(c.art.noun)}</p><p class="card-sub">${esc(c.back)}</p>`;
    cardEl.className = "art-card";
    cardEl.style.transform = "";
    fb.innerHTML = "";
    app.querySelectorAll(".art-zone").forEach((z) => z.classList.remove("correct", "wrong", "hover"));
    app.querySelector("#counter").textContent = `${pos + 1} / ${queue.length}`;
    app.querySelector("#prog").style.width = `${(pos / queue.length) * 100}%`;
  }

  async function choose(article) {
    if (locked) return;
    locked = true;
    const c = queue[pos];
    const ok = article === c.art.article;
    app.querySelectorAll(".art-zone").forEach((z) => {
      if (z.dataset.art === c.art.article) z.classList.add("correct");
      else if (z.dataset.art === article) z.classList.add("wrong");
    });
    cardEl.classList.add(ok ? "result-know" : "result-forgot");
    fb.innerHTML = ok
      ? `<span class="right">Верно: ${esc(c.front)}</span>`
      : `<span class="wrong">Правильно: ${esc(c.front)}</span>`;
    if (lang) speak(c.front, lang);
    if (!firstAnswer.has(c.uid)) firstAnswer.set(c.uid, ok);
    if (!ok && (repeats.get(c.uid) || 0) < MAX_REPEATS) {
      repeats.set(c.uid, (repeats.get(c.uid) || 0) + 1);
      requeue(queue, pos, c);
    }
    await sleep(ok ? 900 : 2000);
    if (currentView !== "game") return;
    pos += 1;
    locked = false;
    if (pos >= queue.length) { finish(); return; }
    render();
  }

  function finish() {
    const answers = [...firstAnswer.values()];
    const right = answers.filter(Boolean).length;
    app.innerHTML = `
      <section class="summary stack">
        <p class="big">${right} / ${answers.length}</p>
        <p class="muted">правильных артиклей с первой попытки</p>
        <a class="btn btn-primary btn-block" href="${location.hash}" id="again">Сыграть ещё</a>
        <a class="btn btn-block" href="${back}">К папке</a>
      </section>`;
    app.querySelector("#again").onclick = (e) => { e.preventDefault(); router(); };
  }

  // Drag the word with a finger or the mouse; drop it on a zone.
  let drag = null;
  const zoneAt = (x, y) => document.elementsFromPoint(x, y).find((el) => el.classList?.contains("art-zone"));
  cardEl.addEventListener("pointerdown", (e) => {
    if (locked) return;
    drag = { x: e.clientX, y: e.clientY };
    cardEl.setPointerCapture(e.pointerId);
    cardEl.classList.add("dragging");
  });
  cardEl.addEventListener("pointermove", (e) => {
    if (!drag) return;
    cardEl.style.transform = `translate(${e.clientX - drag.x}px, ${e.clientY - drag.y}px) scale(0.92)`;
    const zone = zoneAt(e.clientX, e.clientY);
    app.querySelectorAll(".art-zone").forEach((z) => z.classList.toggle("hover", z === zone));
  });
  const drop = (e) => {
    if (!drag) return;
    drag = null;
    cardEl.classList.remove("dragging");
    const zone = e.type === "pointerup" ? zoneAt(e.clientX, e.clientY) : null;
    app.querySelectorAll(".art-zone").forEach((z) => z.classList.remove("hover"));
    cardEl.style.transform = "";
    if (zone) choose(zone.dataset.art);
  };
  cardEl.addEventListener("pointerup", drop);
  cardEl.addEventListener("pointercancel", drop);
  app.querySelector(".art-zones").addEventListener("click", (e) => {
    const zone = e.target.closest(".art-zone");
    if (zone) choose(zone.dataset.art);
  });
  const onKey = (e) => {
    const i = ["1", "2", "3"].indexOf(e.key);
    if (i !== -1) choose(WC.ARTICLES[i]);
  };
  document.addEventListener("keydown", onKey);
  cleanup = () => document.removeEventListener("keydown", onKey);

  render();
}

// ---------------- start ----------------
async function start() {
  if (auth.username) await store.load(auth.username);
  await router();
  if (auth.token) syncNow();
}

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => navigator.serviceWorker.register("sw.js").catch(() => {}));
}
start();
