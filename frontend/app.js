/* WordCards frontend — plain JavaScript, no build step.

   Offline first: all folders and words live in a copy on this device
   (IndexedDB). Every change is applied to that copy right away and put
   into a queue ("outbox"). When the server is reachable, the queue is sent
   to POST /api/sync and the server answers with the fresh full state.

   Screens are switched by the part of the URL after "#":
     #/login                         login / sign up
     #/                              language folders
     #/deck/<uid>                    one folder
     #/deck/<uid>/add                add words
     #/deck/<uid>/words              word list
     #/deck/<uid>/study/due          lesson (due | forgotten | learned | all)
     #/deck/<uid>/game/choose/all    game "pick the translation" (forgotten | all)
     #/deck/<uid>/game/type/all      game "type the word"
*/
"use strict";

// How many cards later a forgotten word comes back inside one lesson.
const REQUEUE_GAP = 5;
const MAX_REPEATS = 3;
const LESSON_SIZE = 20;
const SYNC_EVERY_MS = 60_000;

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

const store = {
  user: null,
  decks: [],
  cards: [],
  outbox: [], // changes not yet saved on the server
  lastSync: null,

  async load(user) {
    let saved = null;
    try { saved = await idb.get("data"); } catch { /* private mode: work from memory */ }
    if (saved && saved.user === user) Object.assign(this, saved);
    else Object.assign(this, { user, decks: [], cards: [], outbox: [], lastSync: null });
  },

  async save() {
    const { user, decks, cards, outbox, lastSync } = this;
    try {
      await idb.set("data", { user, decks, cards, outbox, lastSync });
    } catch {
      toast("Не получилось сохранить на устройстве");
    }
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
    scheduleSync(1500);
    renderSyncStatus();
  },

  deck(uid) {
    const deck = this.decks.find((d) => d.uid === uid);
    if (!deck) throw new Error("Папка не найдена");
    return deck;
  },
  cardsOf(deckUid) {
    return this.cards.filter((c) => c.deck_uid === deckUid);
  },
  stats(deckUid) {
    return WC.deckStats(this.cards, deckUid);
  },
};

// ---------------- sync ----------------
let syncing = false;
let syncTimer = null;
let syncProblem = null; // null | "offline" | "server"

function scheduleSync(delay = 0) {
  clearTimeout(syncTimer);
  syncTimer = setTimeout(syncNow, delay);
}

async function syncNow() {
  if (syncing || !auth.token) return;
  syncing = true;
  renderSyncStatus();
  try {
    do {
      const sending = store.outbox.slice(0, 500);
      const res = await api("/sync", { method: "POST", body: { ops: sending } });
      // Changes made while we waited for the answer stay in the queue
      // and are applied again on top of the fresh state from the server.
      store.outbox.splice(0, sending.length);
      store.decks = res.decks;
      store.cards = res.cards;
      for (const op of store.outbox) WC.applyOp(store, op);
      store.lastSync = new Date().toISOString();
      await store.save();
      if (res.rejected.length) toast(`Сервер не принял ${changesCount(res.rejected.length)}`);
    } while (store.outbox.length);
    syncProblem = null;
    if (currentView === "home" || currentView === "deck") router();
  } catch (e) {
    if (e.status === 401) {
      // Login expired: keep the words and the queue, just ask to log in again.
      auth.dropToken();
      toast("Войди снова, чтобы сохранить изменения на сервере");
      location.hash = "#/login";
    }
    syncProblem = e.status ? "server" : "offline";
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
document.addEventListener("visibilitychange", () => { if (!document.hidden) scheduleSync(); });
setInterval(() => scheduleSync(), SYNC_EVERY_MS);

// ---------------- router ----------------
const routes = [
  [/^\/login$/, viewLogin, "login"],
  [/^\/$/, viewHome, "home"],
  [/^\/deck\/([\w-]+)$/, viewDeck, "deck"],
  [/^\/deck\/([\w-]+)\/add$/, viewAdd, "add"],
  [/^\/deck\/([\w-]+)\/words$/, viewWords, "words"],
  [/^\/deck\/([\w-]+)\/study\/(due|forgotten|learned|all)$/, viewStudy, "study"],
  [/^\/deck\/([\w-]+)\/game\/(choose|type)\/(forgotten|all)$/, viewGame, "game"],
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
  const decks = store.decks.map((d) => ({ ...d, stats: store.stats(d.uid) }));
  const list = decks.length
    ? `<div class="folders">${decks.map((d) => `
        <a class="folder" href="#/deck/${d.uid}">
          <div class="folder-head">
            <span class="folder-flag" aria-hidden="true">${flagFor(d.lang_code)}</span>
            <span class="folder-name">${esc(d.name)}</span>
            ${d.stats.due ? `<span class="due-badge" title="Пора повторить">${d.stats.due}</span>` : ""}
          </div>
          <div class="folder-meta">${statusBar(d.stats)}
            <p class="small muted" style="margin-top:8px">${wordsCount(d.stats.total)} · выучено ${d.stats.learned}</p>
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
    Object.assign(store, { user: null, decks: [], cards: [], outbox: [], lastSync: null });
    store.save();
    location.hash = "#/login";
  };
  app.querySelector("#new-deck").onclick = () => deckDialog();
}

function deckDialog(deck = null) {
  const dlg = document.createElement("dialog");
  const options = LANGUAGES.map(
    (l) => `<option value="${l.code}" ${deck && deck.lang_code === l.code ? "selected" : ""}>${l.flag} ${l.name}</option>`
  ).join("");
  dlg.innerHTML = `
    <form method="dialog">
      <h2>${deck ? "Настройки папки" : "Новая папка"}</h2>
      <div><label for="lang">Язык</label><select id="lang" name="lang">${options}</select></div>
      <div><label for="name">Название</label>
        <input id="name" name="name" maxlength="80" required value="${esc(deck?.name || "")}" placeholder="Немецкий"></div>
      <p class="small muted">Язык нужен, чтобы приложение могло произносить слова вслух.</p>
      <div class="dialog-btns">
        <button class="btn" value="cancel" formnovalidate>Отмена</button>
        <button class="btn btn-primary" value="save">${deck ? "Сохранить" : "Создать"}</button>
      </div>
      ${deck ? `<button class="btn btn-danger btn-block" value="delete" formnovalidate>Удалить папку со всеми словами</button>` : ""}
    </form>`;
  document.body.append(dlg);
  const name = dlg.querySelector("#name");
  const lang = dlg.querySelector("#lang");
  // Fill the name from the chosen language, until the user types their own.
  let touched = !!deck;
  name.addEventListener("input", () => (touched = true));
  lang.addEventListener("change", () => {
    if (!touched) name.value = lang.value ? LANGUAGES.find((l) => l.code === lang.value).name : "";
  });
  if (!deck) name.value = LANGUAGES[0].name;

  dlg.addEventListener("close", () => {
    const action = dlg.returnValue;
    dlg.remove();
    if (action === "save" && name.value.trim()) {
      const uid = deck ? deck.uid : WC.uuid();
      store.commit({ type: "deck_upsert", uid, name: name.value.trim().slice(0, 80), lang_code: lang.value || null });
      if (deck) router();
      else location.hash = `#/deck/${uid}/add`;
    } else if (action === "delete" && confirm(`Удалить «${deck.name}» и все слова в ней?`)) {
      store.commit({ type: "deck_delete", uid: deck.uid });
      toast("Папка удалена");
      location.hash = "#/";
    }
  });
  dlg.showModal();
}

// ---------------- one folder ----------------
function viewDeck(id) {
  const deck = store.deck(id);
  const s = store.stats(id);
  const gear = `<button class="icon-btn" id="settings" aria-label="Настройки папки">⋯</button>`;
  const off = (n) => (n ? "" : 'aria-disabled="true" tabindex="-1"');

  if (!s.total) {
    app.innerHTML = `
      ${topbar(`${flagFor(deck.lang_code)} ${deck.name}`, "#/", gear)}
      <div class="empty stack"><div class="stack-of-cards" aria-hidden="true">Aa</div>
        <p>В папке пока нет слов.</p>
        <a class="btn btn-primary btn-block" href="#/deck/${id}/add">Добавить слова</a></div>`;
    app.querySelector("#settings").onclick = () => deckDialog(deck);
    return;
  }

  const lessonCount = Math.min(s.due, LESSON_SIZE);
  app.innerHTML = `
    ${topbar(`${flagFor(deck.lang_code)} ${deck.name}`, "#/", gear)}
    <div class="stack">
      <div>${statusBar(s)}${legend(s)}</div>

      ${lessonCount
        ? `<a class="btn btn-primary btn-block btn-big" href="#/deck/${id}/study/due">Начать урок · ${wordsCount(lessonCount)}</a>`
        : `<div class="section"><h2>На сегодня всё</h2>
            <p class="muted small">Новых слов нет, а выученные вернутся, когда придёт время. Можно добавить слова или пройти все карточки.</p>
            <div class="btns"><a class="btn" href="#/deck/${id}/study/all">Пройти все слова</a></div></div>`}

      <label class="row small muted" style="font-weight:500;cursor:pointer">
        <input type="checkbox" id="reverse" style="width:20px;min-height:20px" ${settings.reverse ? "checked" : ""}>
        Показывать сначала перевод, а слово вспоминать
      </label>

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
        <h2>Игры со всеми словами</h2>
        <div class="btns">
          <a class="btn" href="#/deck/${id}/game/choose/all">Выбери перевод</a>
          <a class="btn" href="#/deck/${id}/game/type/all">Напиши слово</a>
        </div>
      </section>

      <div class="row">
        <a class="btn grow" href="#/deck/${id}/add">＋ Добавить слова</a>
        <a class="btn grow" href="#/deck/${id}/words">Все слова · ${s.total}</a>
      </div>
      <div class="foot">${syncLine}</div>
    </div>`;

  app.querySelector("#settings").onclick = () => deckDialog(deck);
  app.querySelector("#reverse").onchange = (e) => (settings.reverse = e.target.checked);
}

// ---------------- add words ----------------
function viewAdd(id) {
  const deck = store.deck(id);
  app.innerHTML = `
    ${topbar("Добавить слова", `#/deck/${id}`)}
    <form class="stack" id="add-form">
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
      <button class="btn btn-primary btn-block" id="save">Добавить в «${esc(deck.name)}»</button>
    </form>`;

  const form = app.querySelector("#add-form");
  const result = app.querySelector("#result");
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const text = form.text.value;
    if (!text.trim()) { result.innerHTML = `<p class="error-text">Напиши хотя бы одно слово</p>`; return; }

    const parsed = WC.parseWordList(text);
    const existing = new Set(store.cardsOf(id).map((c) => c.front.toLowerCase()));
    const skipped = [];
    const changes = [];
    for (const w of parsed.words) {
      const key = w.front.toLowerCase();
      if (existing.has(key)) { skipped.push(w.front); continue; }
      existing.add(key);
      changes.push({ type: "card_upsert", uid: WC.uuid(), deck_uid: id, ...w });
    }
    if (changes.length) store.commit(...changes);

    const parts = [];
    if (skipped.length) parts.push(`<p class="small muted">Уже были в папке: ${esc(skipped.join(", "))}</p>`);
    if (parsed.errors.length) {
      parts.push(`<p class="error-text">Не понял эти строки. У слова нужен перевод через « - », а строка с -- или ... должна идти под словом:</p>`);
      form.text.value = parsed.errors.join("\n");
    } else {
      form.text.value = "";
    }
    result.innerHTML = `<div class="section"><p><b>Добавлено: ${wordsCount(changes.length)}</b></p>${parts.join("")}
      <div class="btns"><a class="btn btn-primary" href="#/deck/${id}">К папке</a></div></div>`;
    if (changes.length) toast(`Добавлено: ${wordsCount(changes.length)}`);
  });
}

// ---------------- word list ----------------
function viewWords(id) {
  store.deck(id); // throws if the folder is gone
  let filter = "all";
  let query = "";

  app.innerHTML = `
    ${topbar("Все слова", `#/deck/${id}`)}
    <div class="stack">
      <input type="search" id="q" placeholder="Поиск" aria-label="Поиск слова">
      <div class="chips" role="group" aria-label="Фильтр">
        <button class="chip" data-f="all" aria-pressed="true">Все</button>
        ${Object.entries(STATUS_NAMES).map(([k, v]) => `<button class="chip" data-f="${k}" aria-pressed="false">${v}</button>`).join("")}
      </div>
      <ul class="words" id="list"></ul>
    </div>`;

  const list = app.querySelector("#list");
  function draw() {
    const q = query.toLowerCase();
    const shown = store.cardsOf(id)
      .filter((c) => (filter === "all" || c.status === filter) && (!q || c.front.toLowerCase().includes(q) || c.back.toLowerCase().includes(q)))
      .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
    list.innerHTML = shown.length
      ? shown.map((c) => `
          <li><button class="word-row" data-uid="${c.uid}">
            <span class="dot ${c.status}" title="${STATUS_NAMES[c.status]}"></span>
            <span class="grow"><span class="w">${esc(c.front)}</span><br><span class="t">${esc(c.back)}</span></span>
          </button></li>`).join("")
      : `<li class="empty muted">Ничего не найдено</li>`;
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
  list.addEventListener("click", (e) => {
    const row = e.target.closest(".word-row");
    const card = row && store.cards.find((c) => c.uid === row.dataset.uid);
    if (card) editDialog(card, draw);
  });
}

function editDialog(card, onChange) {
  const dlg = document.createElement("dialog");
  dlg.innerHTML = `
    <form method="dialog">
      <h2>Изменить слово</h2>
      <div><label for="f">Слово</label><input id="f" maxlength="200" required value="${esc(card.front)}"></div>
      <div><label for="b">Перевод</label><input id="b" maxlength="200" required value="${esc(card.back)}"></div>
      <div><label for="ex">Пример</label><textarea id="ex" class="short" maxlength="1000">${esc(card.example || "")}</textarea></div>
      <div><label for="ext">Перевод примера</label><textarea id="ext" class="short" maxlength="1000">${esc(card.example_translation || "")}</textarea></div>
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
    dlg.remove();
    if (action === "save" && values.front && values.back) {
      store.commit({ type: "card_upsert", uid: card.uid, deck_uid: card.deck_uid, ...values });
      toast("Сохранено");
    } else if (action === "reset") {
      store.commit({ type: "card_reset", uid: card.uid });
      toast("Слово снова новое");
    } else if (action === "delete" && confirm(`Удалить «${card.front}»?`)) {
      store.commit({ type: "card_delete", uid: card.uid });
      toast("Слово удалено");
    } else return;
    onChange();
  });
  dlg.showModal();
}

// ---------------- lesson with cards ----------------
const LESSON_TITLES = { due: "Урок", forgotten: "Забытые слова", learned: "Выученные слова", all: "Все слова" };

function viewStudy(id, mode) {
  const deck = store.deck(id);
  const cards = WC.studyCards(store.cards, id, mode, LESSON_SIZE);
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
    const speakBtn = deck.lang_code && "speechSynthesis" in window
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
  app.querySelector("#know").onclick = () => answer(true);
  app.querySelector("#forgot").onclick = () => answer(false);
  cardEl.addEventListener("click", (e) => {
    if (e.target.closest("[data-speak]")) { e.stopPropagation(); speak(queue[pos].front, deck.lang_code); return; }
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

function viewGame(id, type, mode) {
  const deck = store.deck(id);
  const all = store.cardsOf(id).map((c) => ({ ...c }));
  const pool = mode === "forgotten" ? all.filter((c) => c.status === "forgotten") : all;
  const title = type === "choose" ? "Выбери перевод" : "Напиши слово";
  const back = `#/deck/${id}`;

  if (!pool.length || (type === "choose" && all.length < 2)) {
    app.innerHTML = `${topbar(title, back)}<div class="empty stack">
      <p>${type === "choose" ? "Для этой игры нужно хотя бы 2 слова в папке." : "Здесь пока нет слов."}</p>
      <a class="btn" href="${back}">К папке</a></div>`;
    return;
  }

  const queue = WC.shuffle(pool).slice(0, LESSON_SIZE);
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
    const others = WC.shuffle(all.filter((x) => x.uid !== c.uid && normalize(x.back) !== normalize(c.back))).slice(0, 3);
    const options = WC.shuffle([c, ...others]);
    game.innerHTML = `${header(c, c.front, "Выбери правильный перевод")}
      <div class="options">${options.map((o) => `<button class="btn option" data-uid="${o.uid}">${esc(o.back)}</button>`).join("")}</div>`;
    if (deck.lang_code) speak(c.front, deck.lang_code);
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

    async function resolve(ok) {
      if (done) return;
      done = true;
      input.disabled = true;
      game.querySelectorAll("button").forEach((b) => (b.disabled = true));
      fb.innerHTML = ok
        ? `<span class="right">Верно!</span>`
        : `<span class="wrong">Правильно: ${esc(c.front)}</span>${c.example ? `<br><span class="small muted">${esc(c.example)}</span>` : ""}${c.example_translation ? `<br><span class="small muted">${esc(c.example_translation)}</span>` : ""}`;
      if (deck.lang_code) speak(c.front, deck.lang_code);
      record(c, ok);
      await sleep(ok ? 800 : 2400);
      next();
    }
    game.querySelector("#tf").addEventListener("submit", (e) => {
      e.preventDefault();
      if (!input.value.trim()) { input.focus(); return; }
      resolve(normalize(input.value) === normalize(c.front));
    });
    game.querySelector("#skip").onclick = () => resolve(false);
  }

  const draw = type === "choose" ? drawChoose : drawType;
  draw();
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
