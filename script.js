'use strict';

/* ==========================================================================
   Привал Яндексоида: чат у костра
   Секции: конфиг, структуры данных, хранилище, сцена, листья, тема, чат
   ========================================================================== */

/* ---------- Конфиг ---------- */
// Для GitHub Pages укажите полный адрес Vercel, например 'https://privat.vercel.app/api/gigachat'
const API_URL = '/api/gigachat';
const STORAGE_KEY = 'privat.chat.v1';
const THEME_KEY = 'privat-theme';
const HISTORY_LIMIT = 10;      // ограниченная очередь: максимум сообщений в контексте
const MAX_INPUT = 1000;
const MAX_STORED = 2000;       // длина одного сообщения при чтении из хранилища
const REQUEST_TIMEOUT_MS = 30000;
const IMG_ORIGIN = /^https:\/\/images\.unsplash\.com\//;

const MODES = {
  chat: 'обычный чат',
  friend: 'как друг',
  opponent: 'взгляд оппонента'
};
const PLACEHOLDERS = {
  chat: '* Расскажи, что случилось…',
  friend: '* Вставь обидное сообщение, перескажу как друг…',
  opponent: '* Вставь сообщение, посмотрим глазами его автора…'
};
const PHRASES = [
  'Даже если ты сделал неправильный выбор, он привёл тебя сюда, к костру. Здесь можно выдохнуть.',
  'Каждое твоё решение верное: ты принимал его с теми силами и знаниями, что были тогда.',
  'Shit happens. Но все shit проходит, а ты остаёшься.',
  'Отмены случаются не из-за тебя. Ты уже сделал достаточно.',
  'Сегодня можно ничего не доказывать. Просто посиди: огонь потрескивает, всё хорошо.'
];
const CATS = [
  'https://images.unsplash.com/photo-1514888286974-6c03e2ca1dba?w=640&q=70',
  'https://images.unsplash.com/photo-1543852786-1cf6624b9987?w=640&q=70',
  'https://images.unsplash.com/photo-1573865526739-10659fec78a5?w=640&q=70',
  'https://images.unsplash.com/photo-1533738363-b7f9aef128ce?w=640&q=70',
  'https://images.unsplash.com/photo-1495360010541-f48722b34f7d?w=640&q=70'
];
const CAT_CAPTION = '🐈 (показан фото котика)';

const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
const $ = (id) => document.getElementById(id);

/* ==========================================================================
   Структуры данных (CLRS)
   ========================================================================== */

/** Ограниченная очередь на кольцевом буфере (CLRS 10.1). enqueue и вытеснение FIFO: O(1). */
class BoundedQueue {
  constructor(capacity) {
    this.capacity = capacity;
    this.buffer = new Array(capacity);
    this.head = 0;
    this.size = 0;
  }
  enqueue(item) {
    const tail = (this.head + this.size) % this.capacity;
    this.buffer[tail] = item;
    if (this.size === this.capacity) this.head = (this.head + 1) % this.capacity; // вытесняем самый старый
    else this.size += 1;
  }
  toArray() {
    const out = [];
    for (let i = 0; i < this.size; i++) out.push(this.buffer[(this.head + i) % this.capacity]);
    return out;
  }
  clear() { this.buffer = new Array(this.capacity); this.head = 0; this.size = 0; }
}

/** Token bucket: ленивый пересчёт, O(1). Возвращает 0 при успехе или секунды ожидания. */
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

/** «Мешок»: перемешивание Фишера-Йейтса, O(n), без повторов подряд. */
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
   Хранилище (localStorage с защитой от сбоев и подмены данных)
   ========================================================================== */

/** Приводит запись из хранилища к безопасной форме или возвращает null. */
function sanitizeMessage(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const role = raw.role === 'user' || raw.role === 'assistant' ? raw.role : null;
  const content = typeof raw.content === 'string' ? raw.content.slice(0, MAX_STORED) : '';
  if (!role || !content) return null;
  const msg = { role, content };
  if (raw.kind === 'cat' && typeof raw.image === 'string' && IMG_ORIGIN.test(raw.image)) {
    msg.kind = 'cat';
    msg.image = raw.image;
  }
  return msg;
}

const storage = {
  load() {
    try {
      const data = JSON.parse(localStorage.getItem(STORAGE_KEY));
      const messages = Array.isArray(data && data.messages) ? data.messages.map(sanitizeMessage).filter(Boolean) : [];
      const mode = data && Object.prototype.hasOwnProperty.call(MODES, data.mode) ? data.mode : 'chat';
      return { messages: messages.slice(-HISTORY_LIMIT), mode };
    } catch (_) {
      return { messages: [], mode: 'chat' };
    }
  },
  save(messages, mode) {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify({ v: 1, mode, messages })); } catch (_) { /* квота или приватный режим */ }
  },
  clear() {
    try { localStorage.removeItem(STORAGE_KEY); } catch (_) { /* ignore */ }
  }
};

/* ==========================================================================
   Сцена привала: ASCII-карта -> CSS box-shadow
   ========================================================================== */

const SPRITES = {
  // Рыцарь в закрытом шлеме и бесформенных латах: по нему не понять пол. Одинаков в обеих темах.
  knight: {
    pal: { A: '#c9ced8', '#': '#15151c', B: '#7a8aa6', Y: '#ffd800', D: '#4a5468' },
    rows: [
      '....AAAA....',
      '...AAAAAA...',
      '...A####A...',
      '...AAAAAA...',
      '..BBBBBBBB..',
      '.BBBYYYYBBB.',
      '.BBBBBBBBBB.',
      '.BBBBBBBBBB.',
      '..BBBBBBBB..',
      '..DDD..DDD..',
      '.DDDD..DDDD.'
    ]
  },
  tree: {
    pal: { G: '#2f6b3a', g: '#4a9a4e', T: '#6b4226' },
    px: 10,
    rows: [
      '......GGGGGG......',
      '....GGGggGGGGG....',
      '..GGGGGGGGgGGGG...',
      '.GGgGGGGGGGGGGGG..',
      '.GGGGGGgGGGGGGGGG.',
      '..GGGGGGGGGGGGGG..',
      '....GGGGGGGGGG....',
      '.......TTTT.......',
      '.......TTTT.......',
      '.......TTTT.......',
      '......TTTTTT......',
      '......TTTTTT......'
    ]
  },
  flame: {
    pal: { r: '#d1301c', O: '#ff8a1f', Y: '#ffe14a' },
    rows: ['...r...', '..rOr..', '.rOYOr.', '.rOYOr.', 'rOOYOOr', 'rOYYYOr']
  },
  logs: {
    pal: { b: '#6b4226', d: '#3d2514' },
    rows: ['.bbbbbbb.', 'bddbbbddb']
  }
};

/** Один проход O(строки * столбцы); тени собираются массивом и join'ом. */
function paintSprite(el, { rows, pal, px = 6 }) {
  const shadows = [];
  let cols = 0;
  rows.forEach((row, y) => {
    cols = Math.max(cols, row.length);
    for (let x = 0; x < row.length; x++) {
      const color = pal[row[x]];
      if (color) shadows.push(`${x * px}px ${y * px}px 0 ${color}`);
    }
  });
  el.style.setProperty('--sh', shadows.join(','));
  el.style.setProperty('--px', `${px}px`);
  el.style.width = `${cols * px}px`;
  el.style.height = `${rows.length * px}px`;
}
Object.entries(SPRITES).forEach(([id, spec]) => paintSprite($(id), spec));

function fitScene() {
  document.documentElement.style.setProperty('--s', Math.min(1, (innerWidth - 8) / 540).toFixed(3));
}
fitScene();
addEventListener('resize', fitScene, { passive: true });

/* Высота композера определяет, где стоит сцена (она «сидит» на нём) */
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
const LEAF_COLORS = ['#e0a030', '#c8601c', '#b5381f', '#8aa83c', '#d9822b'];

function createLeaf(index) {
  const duration = 9 + Math.random() * 9;
  const leaf = document.createElement('div');
  leaf.className = 'leaf';
  leaf.style.cssText =
    `--x:${(Math.random() * 100).toFixed(1)}%;--size:${(18 + Math.random() * 16).toFixed(0)}px;` +
    `--d:${duration.toFixed(1)}s;--delay:-${(Math.random() * duration).toFixed(1)}s;` +
    `--sw:${(15 + Math.random() * 35).toFixed(0)}px;--sw-d:${(2 + Math.random() * 2).toFixed(1)}s;` +
    `--lc:${LEAF_COLORS[index % LEAF_COLORS.length]}`;
  const shape = index % 3 === 0 ? 'oval' : 'maple';   // шаблоны статичны и доверенные
  leaf.innerHTML =
    `<span class="leaf__sway"><svg class="leaf__svg" viewBox="0 0 24 24" aria-hidden="true">${LEAF_SHAPES[shape]}</svg></span>`;
  return leaf;
}

if (!reduceMotion) {
  const fragment = document.createDocumentFragment();
  const count = innerWidth < 600 ? 10 : 18;
  for (let i = 0; i < count; i++) fragment.appendChild(createLeaf(i));
  $('leaves').appendChild(fragment);
}

/* ==========================================================================
   Тема
   ========================================================================== */

const themeToggle = $('themeToggle');
function setTheme(theme) {
  document.documentElement.dataset.theme = theme;
  themeToggle.textContent = theme === 'dark' ? '☾' : '☀';
  try { localStorage.setItem(THEME_KEY, theme); } catch (_) { /* ignore */ }
}
let savedTheme = null;
try { savedTheme = localStorage.getItem(THEME_KEY); } catch (_) { /* ignore */ }
setTheme(savedTheme === 'light' ? 'light' : 'dark');
themeToggle.addEventListener('click', () => setTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'));

/* ==========================================================================
   Чат
   ========================================================================== */

const els = {
  chat: $('chat'), form: $('form'), input: $('input'),
  send: document.querySelector('.composer__send'), modeChip: $('modeChip'), clear: $('clearBtn')
};
const contextQueue = new BoundedQueue(HISTORY_LIMIT);
const bucket = new TokenBucket(3, 5000);
const phraseBag = new ShuffleBag(PHRASES);
const catBag = new ShuffleBag(CATS);
const state = { mode: 'chat', busy: false, started: false };

/* --- вспомогательные --- */
const persist = () => storage.save(contextQueue.toArray(), state.mode);

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;   // только textContent: защита от XSS
  return node;
}

function scrollToEnd() {
  els.chat.scrollTo({ top: els.chat.scrollHeight, behavior: reduceMotion ? 'auto' : 'smooth' });
}

function resizeInput() {
  els.input.style.height = 'auto';
  els.input.style.height = `${Math.min(els.input.scrollHeight, 160)}px`;
}

function setStarted(value) {
  state.started = value;
  document.body.classList.toggle('page--started', value);
}

function setMode(mode) {
  state.mode = mode;
  els.modeChip.textContent = `Режим: ${MODES[mode]} ↻`;
  els.modeChip.setAttribute('aria-label', `Режим: ${MODES[mode]}. Нажмите, чтобы сменить`);
  els.input.placeholder = PLACEHOLDERS[mode];
  persist();
}

function setBusy(value) {
  state.busy = value;
  els.send.disabled = value;
}

/* --- рендер (одна функция на все типы сообщений) --- */
function renderMessage(msg, { error = false } = {}) {
  const item = el('li', `message message--${msg.role}`);
  if (error) item.classList.add('message--error');
  const bubble = el('div', 'message__bubble');

  if (msg.kind === 'cat') {
    item.classList.add('message--cat');
    const img = el('img', 'message__image');
    img.alt = 'Милый котик';
    img.decoding = 'async';
    img.addEventListener('load', scrollToEnd);
    img.addEventListener('error', () => { img.replaceWith(el('p', 'message__text', 'Котик спрятался, но он рядом.')); });
    img.src = msg.image;
    bubble.appendChild(img);
  } else {
    bubble.appendChild(el('p', 'message__text', msg.content));
  }
  item.appendChild(bubble);
  return item;
}

function appendToDom(msg, options) {
  const node = renderMessage(msg, options);
  els.chat.appendChild(node);
  scrollToEnd();
  return node;
}

/** Сообщение попадает в очередь, в localStorage и на экран. */
function pushMessage(msg) {
  contextQueue.enqueue(msg);
  persist();
  appendToDom(msg);
}

function showTyping() {
  const item = el('li', 'message message--assistant typing');
  const bubble = el('div', 'message__bubble');
  bubble.appendChild(el('span', 'message__text', 'ИИ думает'));
  for (let i = 0; i < 3; i++) bubble.appendChild(el('span', 'typing__dot'));
  item.appendChild(bubble);
  els.chat.appendChild(item);
  scrollToEnd();
  return item;
}

const showError = (text) => { setStarted(true); appendToDom({ role: 'assistant', content: text }, { error: true }); };

/* --- запрос к серверу: передаётся вся накопленная история (до 10 сообщений) --- */
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
  if (state.busy) return;                                  // single-flight
  const text = els.input.value.trim();
  if (!text) return;
  if (!navigator.onLine) { showError('Нет сети. Сообщение не отправлено: проверь подключение.'); return; }
  const wait = bucket.take();
  if (wait) { showError(`Не так быстро, воин. Подожди ещё ${wait} с.`); return; }

  setStarted(true);
  pushMessage({ role: 'user', content: text });
  els.input.value = '';
  resizeInput();
  setBusy(true);
  const typing = showTyping();
  try {
    pushMessage({ role: 'assistant', content: await requestAnswer() });
  } catch (e) {
    showError(e.name === 'AbortError' ? 'ИИ слишком долго думает. Попробуй ещё раз.' : e.message);
  } finally {
    typing.remove();
    setBusy(false);
    els.input.focus();
  }
}

/* --- действия подсказок (DRY: таблица обработчиков) --- */
const ACTIONS = {
  friend: () => startMode('friend'),
  opponent: () => startMode('opponent'),
  tired: () => { setStarted(true); pushMessage({ role: 'assistant', content: phraseBag.draw() }); },
  cat: () => { setStarted(true); pushMessage({ role: 'assistant', content: CAT_CAPTION, kind: 'cat', image: catBag.draw() }); }
};
function startMode(mode) {
  setMode(mode);
  setStarted(true);
  els.input.focus();
}
const instantActions = { tired: throttle(ACTIONS.tired, 600), cat: throttle(ACTIONS.cat, 800) };

document.querySelectorAll('[data-action]').forEach((btn) => {
  const name = btn.dataset.action;
  btn.addEventListener('click', instantActions[name] || ACTIONS[name]);
});

/* --- события --- */
els.form.addEventListener('submit', (e) => { e.preventDefault(); sendMessage(); });
els.input.addEventListener('input', resizeInput);
els.input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); els.form.requestSubmit(); }
});
els.modeChip.addEventListener('click', () => {
  const order = Object.keys(MODES);
  setMode(order[(order.indexOf(state.mode) + 1) % order.length]);
  els.input.focus();
});
els.clear.addEventListener('click', () => {
  if (!confirm('Начать новый привал? История чата будет удалена.')) return;
  contextQueue.clear();
  storage.clear();
  els.chat.replaceChildren();
  setStarted(false);
  setMode('chat');
});

/* --- восстановление истории после перезагрузки --- */
(function restore() {
  const saved = storage.load();
  saved.messages.forEach((msg) => { contextQueue.enqueue(msg); els.chat.appendChild(renderMessage(msg)); });
  setMode(saved.mode);
  if (saved.messages.length) {
    setStarted(true);
    requestAnimationFrame(() => { els.chat.scrollTop = els.chat.scrollHeight; });
  }
})();
