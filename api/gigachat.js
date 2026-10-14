'use strict';

const crypto = require('crypto');

const OAUTH_URL = 'https://ngw.devices.sberbank.ru:9443/api/v2/oauth';
const CHAT_URL = 'https://gigachat.devices.sberbank.ru/api/v1/chat/completions';

const MAX_TEXT = 1000;          // максимум символов на входе
const TIMEOUT_MS = 12000;       // таймаут одной попытки
const MAX_ATTEMPTS = 3;         // попыток на запрос
const BACKOFF_BASE_MS = 400;
const BACKOFF_CAP_MS = 4000;
const RL_CAPACITY = 5;          // token bucket: ёмкость
const RL_REFILL_MS = 6000;      // 1 токен / 6 с на IP

const PROMPTS = {
  friend:
    'Ты тёплый, заботливый друг. Пользователь присылает обидное, злое или токсичное сообщение, ' +
    'которое он получил или которое его гнетёт. Перескажи его так, как мягко пересказал бы близкий друг: ' +
    'убери агрессию, оскорбления и сарказм, оставь только суть по делу, добавь поддержку и напомни, что дело не в нём. ' +
    'Отвечай по-русски, 3-6 предложений, без списков и без вступлений вроде "Вот пересказ".',
  opponent:
    'Ты спокойный психолог-наблюдатель. Пользователь присылает негативное сообщение от другого человека. ' +
    'Предположи (осторожно, словами "возможно", "похоже"), что могло стоять за ним у автора: личная усталость, страх, ' +
    'давление дедлайнов или чужие ожидания. Цель: чтобы пользователь перестал винить себя. ' +
    'Не оправдывай грубость и не утверждай ничего наверняка. Отвечай по-русски, 3-6 предложений, без списков.'
};

class HttpError extends Error {
  constructor(status, message, retryAfter) { super(message); this.status = status; this.retryAfter = retryAfter; }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Экспоненциальный backoff с «полным» jitter: U(0, min(cap, base * 2^attempt))
const backoff = (attempt) => Math.random() * Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** attempt);

/* fetch с таймаутом и повторами только для транзиентных ошибок (сеть, 429, 5xx) */
async function fetchRetry(url, opts) {
  let lastErr;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(url, { ...opts, signal: ctrl.signal });
      if (res.status !== 429 && res.status < 500) return res;       // успех или нетранзиентная ошибка
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

/* Кэш access_token + дедупликация одновременных запросов за токеном (один in-flight промис) */
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

async function chat(text, mode, retryOnAuth = true) {
  const token = await getToken();
  const res = await fetchRetry(CHAT_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({
      model: 'GigaChat',
      temperature: 0.7,
      max_tokens: 400,
      messages: [{ role: 'system', content: PROMPTS[mode] }, { role: 'user', content: text }]
    })
  });
  if (res.status === 401 && retryOnAuth) {       // токен протух раньше срока: обновляем один раз
    cache = { token: null, exp: 0 };
    await getToken(true);
    return chat(text, mode, false);
  }
  if (!res.ok) throw new HttpError(502, 'GigaChat сейчас недоступен.');
  const data = await res.json();
  const answer = data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
  if (!answer) throw new HttpError(502, 'GigaChat вернул пустой ответ.');
  return String(answer).trim();
}

/* Token bucket на IP (память инстанса; для строгого лимита нужен общий стор, но по ТЗ БД нет) */
const buckets = new Map();
function takeToken(key) {
  const now = Date.now();
  if (buckets.size > 2000) {                      // защита памяти: выселяем давно не активных
    for (const [k, b] of buckets) if (now - b.ts > RL_REFILL_MS * RL_CAPACITY) buckets.delete(k);
  }
  const b = buckets.get(key) || { tokens: RL_CAPACITY, ts: now };
  b.tokens = Math.min(RL_CAPACITY, b.tokens + (now - b.ts) / RL_REFILL_MS);
  b.ts = now;
  buckets.set(key, b);
  if (b.tokens >= 1) { b.tokens -= 1; return 0; }
  return Math.ceil((1 - b.tokens) * RL_REFILL_MS / 1000);
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  const send = (status, body) => res.status(status).json(body);
  try {
    if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return send(405, { error: 'Только POST.' }); }

    const ip = String(req.headers['x-forwarded-for'] || (req.socket && req.socket.remoteAddress) || 'anon').split(',')[0].trim();
    const wait = takeToken(ip);
    if (wait) { res.setHeader('Retry-After', String(wait)); return send(429, { error: `Слишком много запросов. Подожди ${wait} с.` }); }

    let body = req.body;
    if (typeof body === 'string') { try { body = JSON.parse(body); } catch (_) { body = null; } }
    const text = body && typeof body.text === 'string' ? body.text.trim() : '';
    const mode = body && body.mode;
    if (!text) return send(400, { error: 'Пустой текст.' });
    if (text.length > MAX_TEXT) return send(413, { error: `Слишком длинно: максимум ${MAX_TEXT} символов.` });
    if (!Object.prototype.hasOwnProperty.call(PROMPTS, mode)) return send(400, { error: 'Неизвестный режим.' });

    return send(200, { answer: await chat(text, mode) });
  } catch (e) {
    if (e instanceof HttpError) {
      if (e.retryAfter) res.setHeader('Retry-After', String(e.retryAfter));
      return send(e.status, { error: e.status === 504 ? 'GigaChat слишком долго отвечает.' : e.message });
    }
    console.error('gigachat handler:', e);
    return send(500, { error: 'Внутренняя ошибка сервера.' });
  }
};
