'use strict';

/* Чат с ИИ: вся переписка живёт здесь. Зависимости приходят из script.js, глобалей не читаем. */
window.PrivalChat = function PrivalChat({ $, el, safe, showToast, showPhrase, reduceMotion, onHistory, onActivity }) {
const els = {
  log: $('log'), form: $('form'), input: $('input'), send: $('sendBtn'), modeHint: $('modeHint'),
  modeButtons: [...document.querySelectorAll('[data-mode]')]
};

// Для GitHub Pages укажите полный адрес Vercel, например 'https://privat.vercel.app/api/reply'
const API_URL = '/api/reply';
const STORAGE_KEY = 'privat.chat.v1';
const HISTORY_LIMIT = 10;       // максимум сообщений в контексте ИИ
const MAX_STORED = 2000;
const REQUEST_TIMEOUT_MS = 30000;
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
const contextQueue = new BoundedQueue(HISTORY_LIMIT);
const bucket = new TokenBucket(3, 5000);
const state = { mode: 'chat', busy: false };
/* ==========================================================================
   Переписка с ИИ
   ========================================================================== */

const persist = () => chatStore.save(contextQueue.toArray(), state.mode);

function updateChatting() {
  const has = els.log.children.length > 0;
  els.log.hidden = !has;
  onHistory(has);
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
$('clearBtn').addEventListener('click', resetCamp);
els.form.addEventListener('submit', (e) => { e.preventDefault(); sendMessage(); });
els.input.addEventListener('input', () => { resizeInput(); onActivity(); });
els.input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); els.form.requestSubmit(); }
});
els.modeButtons.forEach((btn) => btn.addEventListener('click', () => {
  setMode(btn.dataset.mode);
  els.input.focus();
}));
(function restore() {
  const saved = chatStore.load();
  saved.messages.forEach((msg) => { contextQueue.enqueue(msg); els.log.appendChild(renderMessage(msg)); });
  setMode(saved.mode, { save: false });
  updateChatting();
  if (saved.messages.length) requestAnimationFrame(() => { els.log.scrollTop = els.log.scrollHeight; });
})();

return { scrollToEnd: scrollLogToEnd };
};
