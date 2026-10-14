'use strict';

const crypto = require('crypto');

const OAUTH_URL = 'https://ngw.devices.sberbank.ru:9443/api/v2/oauth';
const CHAT_URL = 'https://gigachat.devices.sberbank.ru/api/v1/chat/completions';

const MAX_HISTORY = 10;          // сообщений контекста
const MAX_MESSAGE = 2000;        // символов в одном сообщении
const MAX_TOTAL = 12000;         // символов во всём контексте
const TIMEOUT_MS = 12000;        // таймаут одной попытки
const MAX_ATTEMPTS = 3;
const BACKOFF_BASE_MS = 400;
const BACKOFF_CAP_MS = 4000;
const RL_CAPACITY = 5;           // token bucket на IP
const RL_REFILL_MS = 6000;

const BASE_RULES = ' Отвечай по-русски, тепло и по делу, 3-6 предложений, без списков. ' +
  'Если в сообщениях есть признаки тяжёлого кризиса, мягко предложи обратиться к близким или специалисту.';
const SYSTEM_PROMPTS = {
  chat:
    'Ты тёплый собеседник у ночного костра. Поддерживаешь человека, у которого сорвались важные рабочие мероприятия: ' +
    'слушаешь, не обесцениваешь, не даёшь давления и не ставишь диагнозы.' + BASE_RULES,
  friend:
    'Ты заботливый друг. Пользователь присылает обидное, злое или токсичное сообщение. Перескажи его так, как мягко ' +
    'пересказал бы близкий друг: убери агрессию, оскорбления и сарказм, оставь суть по делу, добавь поддержку и напомни, ' +
    'что дело не в нём. Дальше продолжай диалог в том же духе.' + BASE_RULES,
  opponent:
    'Ты спокойный психолог-наблюдатель. Пользователь присылает негативное сообщение от другого человека. Предположи ' +
    '(осторожно, словами "возможно", "похоже"), что могло стоять за ним у автора: личная усталость, страх, давление ' +
    'дедлайнов. Цель: чтобы пользователь перестал винить себя. Не оправдывай грубость и не утверждай ничего наверняка. ' +
    'Дальше продолжай диалог в том же духе.' + BASE_RULES
};

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Экспоненциальный backoff с полным jitter: U(0, min(cap, base * 2^attempt))
const backoff = (attempt) => Math.random() * Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** attempt);

/* fetch с таймаутом и повторами только для транзиентных ошибок (сеть, 429, 5xx) */
async function fetchRetry(url, opts) {
  let lastErr;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(url, { ...opts, signal: ctrl.signal });
      if (res.status !== 429 && res.status < 500) return res;
      lastErr = new HttpError(res.status === 429 ? 429 : 502, 'upstream ' + res.status);
      if (attempt < MAX_ATTEMPTS - 1) {
        const ra = Number(res.headers.get('retry-after'));
        await sleep(ra > 0 ? Math.min(ra * 1000, BACKOFF_CAP_MS) : backoff(attempt));
      }
    } catch (e) {
      lastErr = new HttpError(e.name === 'AbortError' ? 504 : 502, e.name === 'AbortError' ? 'timeout' : 'network');
      if (attempt < MAX_ATTEMPTS - 1) await sleep(backoff(attempt));
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr;
}

/* Кэш access_token и дедупликация одновременных запросов за токеном */
let cache = { token: null, exp: 0 };
let pending = null;

function getToken(force = false) {
  if (!force && cache.token && Date.now() < cache.exp - 60000) return Promise.resolve(cache.token);
  if (pending) return pending;
  pending = (async () => {
    const creds = String(process.env.GIGACHAT_CREDENTIALS || '').replace(/^Basic\s+/i, '').trim();
    if (!creds) throw new HttpError(500, 'Сервер не настроен: нет GIGACHAT_CREDENTIALS.');
    const res = await fetchRetry(OAUTH_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
        RqUID: crypto.randomUUID(),
        Authorization: `Basic ${creds}`
      },
      body: new URLSearchParams({ scope: 'GIGACHAT_API_PERS' }).toString()
    });
    if (!res.ok) throw new HttpError(502, 'Не удалось авторизоваться в GigaChat.');
    const data = await res.json();
    if (!data.access_token) throw new HttpError(502, 'GigaChat не вернул токен.');
    cache = { token: data.access_token, exp: Number(data.expires_at) || Date.now() + 25 * 60000 };
    return cache.token;
  })().finally(() => { pending = null; });
  return pending;
}

/**
 * Проверяет и нормализует историю. Системные сообщения от клиента отбрасываются:
 * system-промпт добавляет только сервер.
 */
function sanitizeMessages(raw) {
  if (!Array.isArray(raw)) throw new HttpError(400, 'messages должен быть массивом.');
  let list = [];
  for (const m of raw.slice(-MAX_HISTORY)) {
    if (!m || typeof m !== 'object' || (m.role !== 'user' && m.role !== 'assistant') || typeof m.content !== 'string') continue;
    const content = m.content.trim();
    if (!content) continue;
    if (content.length > MAX_MESSAGE) throw new HttpError(413, `Сообщение длиннее ${MAX_MESSAGE} символов.`);
    list.push({ role: m.role, content });
  }
  while (list.length && list[0].role === 'assistant') list.shift();      // диалог начинается с user
  if (!list.length || list[list.length - 1].role !== 'user') throw new HttpError(400, 'Последним должно быть сообщение пользователя.');
  while (list.length > 1 && list.reduce((n, m) => n + m.content.length, 0) > MAX_TOTAL) list.shift(); // режем самые старые
  return list;
}

async function chat(messages, mode, retryOnAuth = true) {
  const token = await getToken();
  const res = await fetchRetry(CHAT_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({
      model: 'GigaChat',
      temperature: 0.7,
      max_tokens: 500,
      messages: [{ role: 'system', content: SYSTEM_PROMPTS[mode] }, ...messages]   // system невидимо подмешан в начало
    })
  });
  if (res.status === 401 && retryOnAuth) {
    cache = { token: null, exp: 0 };
    await getToken(true);
    return chat(messages, mode, false);
  }
  if (!res.ok) throw new HttpError(502, 'GigaChat сейчас недоступен.');
  const data = await res.json();
  const answer = data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
  if (!answer) throw new HttpError(502, 'GigaChat вернул пустой ответ.');
  return String(answer).trim();
}

/* Token bucket на IP (память инстанса; без общей БД лимит приблизительный) */
const buckets = new Map();
function takeToken(key) {
  const now = Date.now();
  if (buckets.size > 2000) {
    for (const [k, b] of buckets) if (now - b.ts > RL_REFILL_MS * RL_CAPACITY) buckets.delete(k);
  }
  const b = buckets.get(key) || { tokens: RL_CAPACITY, ts: now };
  b.tokens = Math.min(RL_CAPACITY, b.tokens + (now - b.ts) / RL_REFILL_MS);
  b.ts = now;
  buckets.set(key, b);
  if (b.tokens >= 1) { b.tokens -= 1; return 0; }
  return Math.ceil((1 - b.tokens) * RL_REFILL_MS / 1000);
}

/* CORS нужен, только если фронтенд на GitHub Pages, а функция на Vercel.
   ALLOWED_ORIGIN: список через запятую, например https://lexa-support.github.io */
function applyCors(req, res) {
  const allowed = String(process.env.ALLOWED_ORIGIN || '').split(',').map((s) => s.trim()).filter(Boolean);
  const origin = req.headers.origin;
  if (!allowed.length || !origin) return;
  if (allowed.includes('*') || allowed.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', allowed.includes('*') ? '*' : origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Access-Control-Expose-Headers', 'Retry-After');
  }
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  applyCors(req, res);
  const send = (status, body) => res.status(status).json(body);
  try {
    if (req.method === 'OPTIONS') return res.status(204).end();
    if (req.method !== 'POST') { res.setHeader('Allow', 'POST, OPTIONS'); return send(405, { error: 'Только POST.' }); }

    const ip = String(req.headers['x-forwarded-for'] || (req.socket && req.socket.remoteAddress) || 'anon').split(',')[0].trim();
    const wait = takeToken(ip);
    if (wait) { res.setHeader('Retry-After', String(wait)); return send(429, { error: `Слишком много запросов. Подожди ${wait} с.` }); }

    let body = req.body;
    if (typeof body === 'string') { try { body = JSON.parse(body); } catch (_) { body = null; } }
    if (!body || typeof body !== 'object') return send(400, { error: 'Некорректное тело запроса.' });

    const mode = Object.prototype.hasOwnProperty.call(SYSTEM_PROMPTS, body.mode) ? body.mode : 'chat';
    const messages = sanitizeMessages(body.messages);
    return send(200, { answer: await chat(messages, mode) });
  } catch (e) {
    if (e instanceof HttpError) return send(e.status, { error: e.status === 504 ? 'GigaChat слишком долго отвечает.' : e.message });
    console.error('gigachat handler:', e);
    return send(500, { error: 'Внутренняя ошибка сервера.' });
  }
};
