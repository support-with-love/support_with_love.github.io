'use strict';

/* ==========================================================================
   Привал Яндексоида
   Секции: конфиг, структуры данных, хранилище, сцена, листья, тема,
   карточка и мемы, переписка с ИИ, очистка, интро
   ========================================================================== */

/* ---------- Конфиг ---------- */
// Для GitHub Pages укажите полный адрес Vercel, например 'https://privat.vercel.app/api/reply'
const API_URL = '/api/reply';
const VISITED_KEY = 'visited';
const STORAGE_KEY = 'privat.chat.v1';
const THEME_KEY = 'privat-theme';
const HISTORY_LIMIT = 10;       // максимум сообщений в контексте ИИ
const MAX_STORED = 2000;
const REQUEST_TIMEOUT_MS = 30000;
const TOAST_MS = 3800;

/* Режимы названы по результату, а не по роли: человек сразу понимает, что получит. */
const MODES = {
  chat: {
    hint: 'Просто напиши, что на душе. Я отвечу тепло и без непрошеных советов.',
    placeholder: 'Если хочется выговориться, напиши сюда…'
  },
  friend: {
    hint: 'Вставь резкое или обидное сообщение. Я перескажу его спокойно, как друг: суть останется, яд уйдёт.',
    placeholder: 'Вставь сообщение, которое тебя задело…'
  },
  opponent: {
    hint: 'Вставь сообщение, которое задело. Я предположу, что могло стоять за ним у автора, чтобы ты не принимал это на свой счёт.',
    placeholder: 'Вставь сообщение, и посмотрим, почему оно могло так прозвучать…'
  }
};

/* Тексты лежат в phrases.js: пополняйте его, script.js трогать не нужно. */
const CONTENT = window.PRIVAL_CONTENT || {};
const isText = (v) => typeof v === 'string' && v.trim().length > 0;
const PHRASES = [...new Set(Object.values(CONTENT.phrases || {}).flat().filter(isText).map((s) => s.trim()))];
const MEMES = (CONTENT.memes || []).filter((m) => m && isText(m.top) && isText(m.bottom));
if (!PHRASES.length) PHRASES.push('Выдохни. Ты здесь, и этого сейчас достаточно.');
if (!MEMES.length) MEMES.push({ emoji: '🐈', top: 'Мемы закончились', bottom: 'Зато котик рядом.' });

const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
const $ = (id) => document.getElementById(id);

/* ==========================================================================
   Структуры данных (CLRS)
   ========================================================================== */

/** Ограниченная очередь на кольцевом буфере (CLRS 10.1): enqueue и вытеснение FIFO за O(1). */
class BoundedQueue {
  constructor(capacity) { this.capacity = capacity; this.clear(); }
  enqueue(item) {
    this.buffer[(this.head + this.size) % this.capacity] = item;
    if (this.size === this.capacity) this.head = (this.head + 1) % this.capacity;   // вытесняем самый старый
    else this.size += 1;
  }
  toArray() {
    const out = [];
    for (let i = 0; i < this.size; i++) out.push(this.buffer[(this.head + i) % this.capacity]);
    return out;
  }
  clear() { this.buffer = new Array(this.capacity); this.head = 0; this.size = 0; }
}

/** Token bucket: ленивый пересчёт, O(1). Возвращает 0 или число секунд ожидания. */
class TokenBucket {
  constructor(capacity, refillMs) { this.capacity = capacity; this.refillMs = refillMs; this.tokens = capacity; this.ts = Date.now(); }
  take() {
    const now = Date.now();
    this.tokens = Math.min(this.capacity, this.tokens + (now - this.ts) / this.refillMs);
    this.ts = now;
    if (this.tokens >= 1) { this.tokens -= 1; return 0; }
    return Math.ceil((1 - this.tokens) * this.refillMs / 1000);
  }
}

/** «Мешок» (перемешивание Фишера-Йейтса, O(n)): без повторов подряд. */
class ShuffleBag {
  constructor(items) { this.items = items; this.queue = []; this.last = null; }
  draw() {
    if (!this.queue.length) {
      const a = this.items.slice();
      for (let i = a.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [a[i], a[j]] = [a[j], a[i]];
      }
      if (a.length > 1 && a[a.length - 1] === this.last) [a[0], a[a.length - 1]] = [a[a.length - 1], a[0]];
      this.queue = a;
    }
    this.last = this.queue.pop();
    return this.last;
  }
}

const throttle = (fn, ms) => {
  let last = 0;
  return (...args) => { const now = Date.now(); if (now - last >= ms) { last = now; fn(...args); } };
};

/* ==========================================================================
   Хранилище (безопасные обёртки над localStorage)
   ========================================================================== */

const safe = {
  get(key) { try { return localStorage.getItem(key); } catch (_) { return null; } },
  set(key, value) { try { localStorage.setItem(key, value); } catch (_) { /* квота или приватный режим */ } },
  remove(key) { try { localStorage.removeItem(key); } catch (_) { /* ignore */ } }
};

function sanitizeMessage(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const role = raw.role === 'user' || raw.role === 'assistant' ? raw.role : null;
  const content = typeof raw.content === 'string' ? raw.content.slice(0, MAX_STORED) : '';
  return role && content ? { role, content } : null;
}

const chatStore = {
  load() {
    try {
      const data = JSON.parse(safe.get(STORAGE_KEY));
      const messages = Array.isArray(data && data.messages) ? data.messages.map(sanitizeMessage).filter(Boolean) : [];
      const mode = data && Object.prototype.hasOwnProperty.call(MODES, data.mode) ? data.mode : 'chat';
      return { messages: messages.slice(-HISTORY_LIMIT), mode };
    } catch (_) {
      return { messages: [], mode: 'chat' };
    }
  },
  save(messages, mode) { safe.set(STORAGE_KEY, JSON.stringify({ v: 1, mode, messages })); },
  clear() { safe.remove(STORAGE_KEY); }
};

/* ==========================================================================
   Сцена привала: ASCII-карта -> CSS box-shadow
   ========================================================================== */

const SPRITES = {
  // Рыцарь сидит под деревом с кружкой чая. Закрытый шлем с узкой прорезью и бесформенные латы:
  // ни пола, ни возраста не видно. Одинаков в обеих темах.
  knight: {
    pal: { A: '#c9ced8', '#': '#15151c', B: '#7a8aa6', Y: '#ffd800', D: '#4a5468', G: '#aab3c6', c: '#e8dcc0', t: '#8a4b1f' },
    px: 5,
    rows: [
      '....AAAAAA....', '...AAAAAAAA...', '...AA####AA...', '...AAAAAAAA...', '....AAAAAA....',
      '..BBBBBBBBBB..', '.BBBBBcttcBBB.', '.BBBBGccccGBB.', '.BBBBBccccBBB.', '.BBBBBBBBBBBB.',
      '.BBBYYYYYYBBB.', '..BBBBBBBBBB..', '.BBBBB..BBBBB.', '.DDDDD..DDDDD.'
    ]
  },
  // Большая осенняя крона и толстый ствол с корнями (26 x 22 клетки по 9px). Рыцарь ростом примерно в треть дерева.
  tree: {
    pal: { G: '#a8461e', g: '#d98a2b', y: '#e2b43c', R: '#8c2f1b', T: '#6b4226', t: '#4a2d18', u: '#3d2514' },
    px: 9,
    rows: [
      '........gGgyGgGGgG........',
      '.....GGGGggggyGGGGGGg.....',
      '...GggGGGyggGGGggGGGygg...',
      '..GGgGgGgGgGyGGgGgGgGgGy..',
      '.GgGGGgGGRyGGgGGGgGGRyGGg.',
      'GGGGGGGGGGGGGGGGGGGGGGGGGG',
      'gGGGgGGyRGGgGGGgGGyRGGgGGG',
      '.GGGGyGgGgGRGGGGyGgGgGRGG.',
      '.RgGGGGgyGGGRgGGGGgyGGGRg.',
      '..GGyggRGGGTTTtyggRGGGGG..',
      '...G.G.TGgGTTTt.G.TGgG....',
      '.....g.GTTGTTTt.TTGgG.....',
      '..........TTuTtt..........',
      '..........TTTTut..........',
      '..........TTuTtt..........',
      '..........TTTTut..........',
      '..........TTTTTt..........',
      '..........TTTTTt..........',
      '..........TTuTTt..........',
      '.........TTTTTTtt.........',
      '........TTTTTTTttt........',
      '.......TTt.TTtt.tTt.......'
    ]
  },
  steam: { pal: { s: '#dfe3ef' }, rows: ['..s.', '.s..', '..s.', '.s..'] }
};

/** Один проход O(строки * столбцы); тени собираются массивом и join'ом. */
function paintSprite(el, { rows, pal, px = 6 }) {
  const shadows = [];
  let cols = 0;
  rows.forEach((row, y) => {
    cols = Math.max(cols, row.length);
    for (let x = 0; x < row.length; x++) {
      if (pal[row[x]]) shadows.push(`${x * px}px ${y * px}px 0 ${pal[row[x]]}`);
    }
  });
  el.style.setProperty('--sh', shadows.join(','));
  el.style.setProperty('--px', `${px}px`);
  el.style.width = `${cols * px}px`;
  el.style.height = `${rows.length * px}px`;
}
Object.entries(SPRITES).forEach(([id, spec]) => { const node = $(id); if (node) paintSprite(node, spec); });

function fitScene() {
  const scale = Math.min(1, (innerWidth - 8) / 540, innerHeight / 820);
  document.documentElement.style.setProperty('--s', scale.toFixed(3));
}
fitScene();
addEventListener('resize', fitScene, { passive: true });

const composer = $('composer');
if ('ResizeObserver' in window) {
  new ResizeObserver(() => {
    document.documentElement.style.setProperty('--composer-h', `${composer.offsetHeight}px`);
  }).observe(composer);
}

/* ==========================================================================
   Осенние листья: сглаженные SVG-силуэты (клён и овальный лист)
   ========================================================================== */

const LEAF_SHAPES = {
  maple:
    '<path d="M12 2 13.6 6.2 16 5 15.4 9.4 19.6 8.2 18 11.4 22 12.6 18.4 15 19.4 17.6 13 16.6 12.8 22H11.2L11 16.6 4.6 17.6 5.6 15 2 12.6 6 11.4 4.4 8.2 8.6 9.4 8 5 10.4 6.2Z" ' +
    'fill="currentColor" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/>' +
    '<path d="M12 8v14" stroke="#000" stroke-opacity=".25" stroke-width=".8" fill="none"/>',
  oval:
    '<path d="M12 2C19 6 20 15 12 22 4 15 5 6 12 2Z" fill="currentColor" stroke="currentColor" stroke-width="1" stroke-linejoin="round"/>' +
    '<path d="M12 5v17M12 11l3-2M12 14l-3-2M12 17l3-2" stroke="#000" stroke-opacity=".25" stroke-width=".8" fill="none"/>'
};
// Область кроны в координатах сцены (px) и высота сцены: согласованы с .scene__leaves и .scene__inner в style.css.
const TREE_CROWN = { x: 24, y: 40, w: 200, h: 60 };
const SCENE_H = 200;
const LEAF_COLORS = ['#e0a030', '#c8601c', '#b5381f', '#8aa83c', '#d9822b', '#e2b43c'];

function createLeaf(index, tree = false) {
  const duration = tree ? 6 + Math.random() * 5 : 9 + Math.random() * 9;
  const leaf = document.createElement('div');
  leaf.className = tree ? 'leaf leaf--tree' : 'leaf';
  const size = tree ? 12 + Math.random() * 7 : 18 + Math.random() * 16;
  const sway = tree ? 6 + Math.random() * 14 : 15 + Math.random() * 35;
  let place = `--x:${(Math.random() * 100).toFixed(1)}%;`;
  if (tree) {
    // Лист стартует внутри кроны и падает ровно до земли: путь считается в координатах сцены.
    const y = TREE_CROWN.y + Math.random() * TREE_CROWN.h;
    place = `--x:${(TREE_CROWN.x + Math.random() * TREE_CROWN.w).toFixed(0)}px;--y:${y.toFixed(0)}px;` +
      `--fall:${Math.max(20, SCENE_H - y - size).toFixed(0)}px;`;
  }
  leaf.style.cssText =
    place + `--size:${size.toFixed(0)}px;` +
    `--d:${duration.toFixed(1)}s;--delay:-${(Math.random() * duration).toFixed(1)}s;` +
    `--sw:${sway.toFixed(0)}px;--sw-d:${(2 + Math.random() * 2).toFixed(1)}s;` +
    `--lc:${LEAF_COLORS[index % LEAF_COLORS.length]}`;
  const shape = index % 3 === 0 ? 'oval' : 'maple';   // шаблоны статичны и доверенные
  leaf.innerHTML = `<span class="leaf__sway"><svg class="leaf__svg" viewBox="0 0 24 24" aria-hidden="true">${LEAF_SHAPES[shape]}</svg></span>`;
  return leaf;
}

if (!reduceMotion) {
  const fragment = document.createDocumentFragment();
  const count = innerWidth < 600 ? 10 : 18;
  for (let i = 0; i < count; i++) fragment.appendChild(createLeaf(i));
  $('leaves').appendChild(fragment);

  const treeFragment = document.createDocumentFragment();
  const treeCount = innerWidth < 600 ? 5 : 8;
  for (let i = 0; i < treeCount; i++) treeFragment.appendChild(createLeaf(i, true));
  const treeBox = $('treeLeaves');
  if (treeBox) treeBox.appendChild(treeFragment);
}

/* ==========================================================================
   Тема
   ========================================================================== */

const themeToggle = $('themeToggle');
function setTheme(theme) {
  document.documentElement.dataset.theme = theme;
  themeToggle.textContent = theme === 'dark' ? '☾' : '☀';
  safe.set(THEME_KEY, theme);
}
setTheme(safe.get(THEME_KEY) === 'light' ? 'light' : 'dark');
themeToggle.addEventListener('click', () => setTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'));

/* ==========================================================================
   Общие хелперы интерфейса
   ========================================================================== */

const els = {
  card: $('card'), log: $('log'), form: $('form'), input: $('input'),
  send: $('sendBtn'), toast: $('toast'), modeHint: $('modeHint'), modeButtons: [...document.querySelectorAll('[data-mode]')]
};
const contextQueue = new BoundedQueue(HISTORY_LIMIT);
const bucket = new TokenBucket(3, 5000);
const phraseBag = new ShuffleBag(PHRASES);
const memeBag = new ShuffleBag(MEMES);
const state = { mode: 'chat', busy: false };

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;   // только textContent: защита от XSS
  return node;
}

let toastTimer = 0;
function showToast(text) {
  els.toast.textContent = text;
  els.toast.classList.add('toast--visible');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => els.toast.classList.remove('toast--visible'), TOAST_MS);
}

/* ==========================================================================
   Карточка поддержки (Zero-Input) и мемы
   ========================================================================== */

function showCard(content, { meme = false } = {}) {
  els.card.classList.toggle('card--meme', meme);
  els.card.replaceChildren(content);   // новый узел заново запускает fade-in
}

function showPhrase() {
  const wrap = el('div', 'card__content');
  wrap.appendChild(el('p', 'card__text', phraseBag.draw()));
  showCard(wrap);
}

function showMeme() {
  const meme = memeBag.draw();
  const wrap = el('div', 'card__content card__meme');
  const emoji = el('p', 'card__emoji', meme.emoji);
  emoji.setAttribute('aria-hidden', 'true');
  wrap.append(el('p', 'card__caption', meme.top), emoji, el('p', 'card__caption', meme.bottom));
  showCard(wrap, { meme: true });
}

/* ==========================================================================
   Переписка с ИИ
   ========================================================================== */

const persist = () => chatStore.save(contextQueue.toArray(), state.mode);

function updateChatting() {
  const has = els.log.children.length > 0;
  els.log.hidden = !has;
  document.body.classList.toggle('page--chatting', has);
}

function scrollLogToEnd() {
  els.log.scrollTo({ top: els.log.scrollHeight, behavior: reduceMotion ? 'auto' : 'smooth' });
}

function resizeInput() {
  els.input.style.height = 'auto';
  els.input.style.height = `${Math.min(els.input.scrollHeight, 140)}px`;
}

function setMode(mode, { save = true } = {}) {
  state.mode = mode;
  els.modeButtons.forEach((btn) => btn.setAttribute('aria-pressed', String(btn.dataset.mode === mode)));
  els.modeHint.textContent = MODES[mode].hint;
  els.input.placeholder = MODES[mode].placeholder;
  if (save) persist();
}

function renderMessage(msg, { error = false } = {}) {
  const item = el('li', `message message--${msg.role}`);
  if (error) item.classList.add('message--error');
  const bubble = el('div', 'message__bubble');
  bubble.appendChild(el('p', 'message__text', msg.content));
  item.appendChild(bubble);
  return item;
}

function appendToLog(msg, options) {
  els.log.appendChild(renderMessage(msg, options));
  updateChatting();
  scrollLogToEnd();
}

/** Сообщение попадает в очередь (FIFO, максимум 10), в localStorage и на экран. */
function pushMessage(msg) {
  contextQueue.enqueue(msg);
  persist();
  appendToLog(msg);
}

function showTyping() {
  const item = el('li', 'message message--assistant typing');
  const bubble = el('div', 'message__bubble');
  bubble.appendChild(el('span', 'message__text', 'ИИ думает'));
  for (let i = 0; i < 3; i++) bubble.appendChild(el('span', 'typing__dot'));
  item.appendChild(bubble);
  els.log.appendChild(item);
  updateChatting();
  scrollLogToEnd();
  return item;
}

const showError = (text) => appendToLog({ role: 'assistant', content: text }, { error: true });

async function requestAnswer() {
  const messages = contextQueue.toArray().map(({ role, content }) => ({ role, content }));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: state.mode, messages }),
      signal: controller.signal
    });
    let data = {};
    try { data = await res.json(); } catch (_) { /* не JSON */ }
    if (!res.ok) {
      if (res.status === 429) throw new Error(`Слишком много запросов. Попробуй через ${Number(res.headers.get('Retry-After')) || 10} с.`);
      throw new Error(data.error || 'ИИ сейчас недоступен. Попробуй чуть позже.');
    }
    if (!data.answer) throw new Error('ИИ ответил пустотой. Попробуй ещё раз.');
    return data.answer;
  } finally {
    clearTimeout(timer);
  }
}

async function sendMessage() {
  if (state.busy) return;                                   // single-flight
  const text = els.input.value.trim();
  if (!text) return;
  if (!navigator.onLine) { showError('Нет сети. Сообщение не отправлено: проверь подключение.'); return; }
  const wait = bucket.take();
  if (wait) { showError(`Не так быстро, воин. Подожди ещё ${wait} с.`); return; }

  pushMessage({ role: 'user', content: text });
  els.input.value = '';
  resizeInput();
  state.busy = true;
  els.send.disabled = true;
  const typing = showTyping();
  try {
    pushMessage({ role: 'assistant', content: await requestAnswer() });
  } catch (e) {
    showError(e.name === 'AbortError' ? 'ИИ слишком долго думает. Попробуй ещё раз.' : e.message);
  } finally {
    typing.remove();
    state.busy = false;
    els.send.disabled = false;
    els.input.focus();
  }
}

/* ==========================================================================
   Очистка («Новый привал»)
   ========================================================================== */

/* Удаляем только ключи самого приложения (а не localStorage.clear()): на github.io origin общий
   для всех проектов пользователя, плюс остаются тема и метка о показанном интро. */
function resetCamp() {
  contextQueue.clear();
  chatStore.clear();
  els.log.replaceChildren();
  updateChatting();
  setMode('chat', { save: false });
  els.input.value = '';
  resizeInput();
  showPhrase();
  showToast('Память привала очищена. Твоя приватность под защитой.');
}

/* ==========================================================================
   События
   ========================================================================== */

$('memeBtn').addEventListener('click', throttle(showMeme, 400));
$('warmBtn').addEventListener('click', throttle(showPhrase, 400));
$('clearBtn').addEventListener('click', resetCamp);

els.form.addEventListener('submit', (e) => { e.preventDefault(); sendMessage(); });
els.input.addEventListener('input', resizeInput);
els.input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); els.form.requestSubmit(); }
});
els.modeButtons.forEach((btn) => btn.addEventListener('click', () => {
  setMode(btn.dataset.mode);
  els.input.focus();
}));

/* Письмо: кнопка 💌 рядом с переключателем темы */
(function letter() {
  const dialog = $('letter');
  const open = () => {
    if (typeof dialog.showModal === 'function') dialog.showModal();
    else dialog.setAttribute('open', '');
    dialog.scrollTop = 0;
  };
  const close = () => {
    if (typeof dialog.close === 'function') dialog.close();
    else dialog.removeAttribute('open');
  };
  $('letterBtn').addEventListener('click', open);
  $('letterX').addEventListener('click', close);
  $('letterClose').addEventListener('click', close);
  dialog.addEventListener('click', (e) => { if (e.target === dialog) close(); });   // клик по затемнению
})();

/* ==========================================================================
   Запуск: восстановление истории и интро
   ========================================================================== */

(function restore() {
  const saved = chatStore.load();
  saved.messages.forEach((msg) => { contextQueue.enqueue(msg); els.log.appendChild(renderMessage(msg)); });
  setMode(saved.mode, { save: false });
  updateChatting();
  if (saved.messages.length) requestAnimationFrame(() => { els.log.scrollTop = els.log.scrollHeight; });
})();

(function intro() {
  const dialog = $('intro');
  const closeIntro = () => {
    if (typeof dialog.close === 'function') dialog.close();
    else { dialog.removeAttribute('open'); dialog.dispatchEvent(new Event('close')); }
  };
  if (safe.get(VISITED_KEY)) { showPhrase(); return; }          // повторный вход: тепло сразу
  dialog.addEventListener('close', () => { safe.set(VISITED_KEY, '1'); showPhrase(); }, { once: true });
  $('introClose').addEventListener('click', closeIntro);
  if (typeof dialog.showModal === 'function') dialog.showModal();
  else dialog.setAttribute('open', '');
})();
