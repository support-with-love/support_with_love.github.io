'use strict';

/* ---------- Спрайты: ASCII-карта -> CSS box-shadow (1 символ = 1 "пиксель") ---------- */
const PX = 6;
const SPRITES = {
  // Рыцарь: закрытый шлем и бесформенные латы, без различимого пола. Одинаков в обеих темах.
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
    ],
    px: 10
  },
  flame: {
    pal: { r: '#d1301c', O: '#ff8a1f', Y: '#ffe14a' },
    rows: [
      '...r...',
      '..rOr..',
      '.rOYOr.',
      '.rOYOr.',
      'rOOYOOr',
      'rOYYYOr'
    ]
  },
  logs: {
    pal: { b: '#6b4226', d: '#3d2514' },
    rows: [
      '.bbbbbbb.',
      'bddbbbddb'
    ]
  }
};

/* Один проход O(rows*cols): строка box-shadow собирается массивом и join'ом, а не конкатенацией. */
function paint(el, { rows, pal, px = PX }) {
  const shadows = [];
  let cols = 0;
  rows.forEach((row, y) => {
    cols = Math.max(cols, row.length);
    for (let x = 0; x < row.length; x++) {
      const c = pal[row[x]];
      if (c) shadows.push(`${x * px}px ${y * px}px 0 ${c}`);
    }
  });
  el.style.setProperty('--sh', shadows.join(','));
  el.style.setProperty('--px', `${px}px`);
  el.style.width = `${cols * px}px`;
  el.style.height = `${rows.length * px}px`;
}
for (const [id, spec] of Object.entries(SPRITES)) paint(document.getElementById(id), spec);

function fitScene() {
  const s = Math.min(1, (window.innerWidth - 8) / 540);
  document.documentElement.style.setProperty('--s', s.toFixed(3));
}
fitScene();
window.addEventListener('resize', fitScene, { passive: true });

/* ---------- Листья (анимация целиком в CSS, JS только создаёт узлы) ---------- */
(function leaves() {
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const colors = ['#e0a030', '#c8601c', '#8aa83c', '#ffd800'];
  const frag = document.createDocumentFragment();
  const n = innerWidth < 600 ? 10 : 18;
  for (let i = 0; i < n; i++) {
    const leaf = document.createElement('div');
    leaf.className = 'leaf';
    const d = 9 + Math.random() * 9;
    leaf.style.cssText =
      `--x:${(Math.random() * 100).toFixed(1)}%;--d:${d.toFixed(1)}s;--delay:-${(Math.random() * d).toFixed(1)}s;` +
      `--sw:${(15 + Math.random() * 35).toFixed(0)}px;--sw-d:${(2 + Math.random() * 2).toFixed(1)}s;` +
      `--lc:${colors[i % colors.length]}`;
    leaf.appendChild(document.createElement('i'));
    frag.appendChild(leaf);
  }
  document.getElementById('leaves').appendChild(frag);
})();

/* ---------- Тема (светлая / тёмная) ---------- */
const root = document.documentElement;
const themeBtn = document.getElementById('themeToggle');
function setTheme(t) {
  root.dataset.theme = t;
  themeBtn.textContent = t === 'dark' ? '☾' : '☀';
  try { localStorage.setItem('privat-theme', t); } catch (_) { /* приватный режим: игнорируем */ }
}
let saved = null;
try { saved = localStorage.getItem('privat-theme'); } catch (_) {}
setTheme(saved === 'light' || saved === 'dark' ? saved : 'dark');
themeBtn.addEventListener('click', () => setTheme(root.dataset.theme === 'dark' ? 'light' : 'dark'));

/* ---------- Алгоритмическая надёжность ---------- */

// Token bucket: ёмкость 3, пополнение 1 токен / 5 с. Ленивый пересчёт, O(1) на вызов.
class TokenBucket {
  constructor(capacity, refillMs) { this.cap = capacity; this.refillMs = refillMs; this.tokens = capacity; this.ts = Date.now(); }
  take() {
    const now = Date.now();
    this.tokens = Math.min(this.cap, this.tokens + (now - this.ts) / this.refillMs);
    this.ts = now;
    if (this.tokens >= 1) { this.tokens -= 1; return 0; }
    return Math.ceil((1 - this.tokens) * this.refillMs / 1000); // секунд до следующего токена
  }
}

// «Мешок» для случайных фраз/картинок: перемешивание Фишера-Йейтса, O(n), без повторов подряд.
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

// Троттлинг: не чаще одного вызова за ms.
function throttle(fn, ms) {
  let last = 0;
  return (...args) => { const n = Date.now(); if (n - last >= ms) { last = n; fn(...args); } };
}

/* ---------- Данные ---------- */
const PHRASES = new ShuffleBag([
  'Даже если ты сделал неправильный выбор, он привёл тебя сюда, к костру. Здесь можно выдохнуть.',
  'Каждое твоё решение верное: ты принимал его с теми силами и знаниями, что были тогда.',
  'Shit happens. Но все shit проходит, а ты остаёшься.',
  'Отмены случаются не из-за тебя. Ты уже сделал достаточно.',
  'Сегодня можно ничего не доказывать. Просто посиди, потрескивает огонь, всё хорошо.'
]);
const CATS = new ShuffleBag([
  'https://images.unsplash.com/photo-1514888286974-6c03e2ca1dba?w=640&q=70',
  'https://images.unsplash.com/photo-1543852786-1cf6624b9987?w=640&q=70',
  'https://images.unsplash.com/photo-1573865526739-10659fec78a5?w=640&q=70',
  'https://images.unsplash.com/photo-1533738363-b7f9aef128ce?w=640&q=70',
  'https://images.unsplash.com/photo-1495360010541-f48722b34f7d?w=640&q=70'
]);

/* ---------- UI ---------- */
const $ = (id) => document.getElementById(id);
const input = $('userText'), out = $('out'), counter = $('counter');
const aiButtons = [...document.querySelectorAll('[data-ai]')];
const bucket = new TokenBucket(3, 5000);
const COOLDOWN_MS = 3000, TIMEOUT_MS = 25000, TYPE_MS = 22;
let busy = false, typer = null;
const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;

input.addEventListener('input', () => { counter.textContent = `${input.value.length} / 1000`; });

function reveal() {
  out.hidden = false;
  requestAnimationFrame(() => out.classList.add('show'));
}

function showText(text, { instant = false } = {}) {
  clearInterval(typer);
  out.classList.remove('is-img');
  out.textContent = '';
  reveal();
  if (instant || reduced) { out.textContent = text; return; }
  let i = 0;
  typer = setInterval(() => {
    i = Math.min(text.length, i + 1);
    out.textContent = text.slice(0, i);   // textContent: безопасно от XSS
    if (i >= text.length) clearInterval(typer);
  }, TYPE_MS);
  out.onclick = () => { clearInterval(typer); out.textContent = text; };
}

function showCat() {
  clearInterval(typer);
  out.textContent = '';
  out.classList.add('is-img');
  const img = new Image();
  let tries = 0;
  img.alt = 'Милый котик';
  img.decoding = 'async';
  img.onerror = () => { if (++tries < 5) img.src = CATS.draw(); else showText('Котик спрятался. Но он всё равно рядом.', { instant: true }); };
  img.src = CATS.draw();
  out.appendChild(img);
  reveal();
}

function setBusy(v) {
  busy = v;
  aiButtons.forEach((b) => { b.disabled = v; });
}

async function ask(mode) {
  if (busy) return;                                   // single-flight
  const text = input.value.trim();
  if (!text) { showText('Сначала напиши, что случилось. Я подожду.', { instant: true }); return; }
  const wait = bucket.take();
  if (wait) { showText(`Не так быстро, воин. Подожди ещё ${wait} с.`, { instant: true }); return; }

  setBusy(true);
  showText('Огонь трещит… я думаю…', { instant: true });
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch('/api/gigachat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, mode }),
      signal: ctrl.signal
    });
    let data = {};
    try { data = await res.json(); } catch (_) { /* не JSON */ }
    if (!res.ok) {
      if (res.status === 429) {
        const ra = Number(res.headers.get('Retry-After')) || 10;
        throw new Error(`Слишком много запросов. Попробуй через ${ra} с.`);
      }
      throw new Error(data.error || 'ИИ сейчас недоступен. Попробуй чуть позже.');
    }
    if (!data.answer) throw new Error('ИИ ответил пустотой. Попробуй ещё раз.');
    showText(data.answer);
  } catch (e) {
    showText(e.name === 'AbortError' ? 'ИИ слишком долго думает. Попробуй ещё раз.' : e.message, { instant: true });
  } finally {
    clearTimeout(timer);
    setTimeout(() => setBusy(false), COOLDOWN_MS);   // кулдаун после запроса
  }
}

aiButtons.forEach((b) => b.addEventListener('click', () => ask(b.dataset.mode)));
$('tiredBtn').addEventListener('click', throttle(() => showText(PHRASES.draw()), 600));
$('catBtn').addEventListener('click', throttle(showCat, 800));
