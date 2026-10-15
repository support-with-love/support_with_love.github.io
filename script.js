'use strict';

/* ==========================================================================
   Привал Яндексоида
   Секции: конфиг, структуры данных, хранилище, сцена, листья, тема,
   карточка и мемы, переписка с ИИ, очистка, интро
   ========================================================================== */

/* ---------- Конфиг ---------- */
const VISITED_KEY = 'visited';
const THEME_KEY = 'privat-theme';
const TOAST_MS = 3800;


/* Тексты лежат в phrases.js: пополняйте его, script.js трогать не нужно. */
const CONTENT = window.PRIVAL_CONTENT || {};
const isText = (v) => typeof v === 'string' && v.trim().length > 0;
const PHRASES = [...new Set(Object.values(CONTENT.phrases || {}).flat().filter(isText).map((s) => s.trim()))];
const MEMES = (CONTENT.memes || []).filter((m) => m && isText(m.top) && isText(m.bottom));
/* Картинки-мемы: имя файла без пути, только безопасные форматы. Объект { src, alt } или просто строка. */
const IMAGE_DIR = 'images/';
const IMAGE_SHARE = 0.5;          // доля картинок среди мемов, если они есть
const IMAGE_TIMEOUT_MS = 8000;
const IMAGES = [...(CONTENT.images || []), ...(window.PRIVAL_IMAGES || [])]   // ручной список + автосписок images.js
  .map((i) => (typeof i === 'string' ? { src: i } : i))
  .filter((i) => i && isText(i.src) && /\.(avif|webp|png|jpe?g|gif|svg)$/i.test(i.src.trim()) && !/[\\/]/.test(i.src) && !i.src.trim().startsWith('.'))
  .map((i) => ({ src: i.src.trim(), alt: isText(i.alt) ? i.alt.trim() : 'Мем-картинка' }));
if (!PHRASES.length) PHRASES.push('Выдохни. Ты здесь, и этого сейчас достаточно.');
if (!MEMES.length) MEMES.push({ emoji: '🐈', top: 'Мемы закончились', bottom: 'Зато котик рядом.' });

const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
const $ = (id) => document.getElementById(id);

/* ==========================================================================
   Структуры данных (CLRS)
   ========================================================================== */


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

const els = { card: $('card'), toast: $('toast') };
const phraseBag = new ShuffleBag(PHRASES);
const memeBag = new ShuffleBag(MEMES);
const imageBag = new ShuffleBag(IMAGES);
const brokenImages = new Set();

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
  const photo = content.classList.contains('card__photo');
  els.card.classList.remove('card--loading');
  els.card.classList.toggle('card--meme', meme);
  els.card.classList.toggle('card--photo', photo);      // раскладка под картинку
  document.body.classList.toggle('page--photo', photo);  // сцена уступает место фото
  els.card.replaceChildren(content);   // новый узел заново запускает fade-in
}

function showPhrase() {
  const wrap = el('div', 'card__content');
  wrap.appendChild(el('p', 'card__text', phraseBag.draw()));
  showCard(wrap);
}

function showTextMeme() {
  const meme = memeBag.draw();
  const wrap = el('div', 'card__content card__meme');
  const emoji = el('p', 'card__emoji', meme.emoji);
  emoji.setAttribute('aria-hidden', 'true');
  wrap.append(el('p', 'card__caption', meme.top), emoji, el('p', 'card__caption', meme.bottom));
  showCard(wrap, { meme: true });
}

/* Картинка грузится и декодируется заранее, и только потом попадает в карточку: рамка не прыгает. */
function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const timer = setTimeout(() => { img.onload = img.onerror = null; reject(new Error('timeout')); }, IMAGE_TIMEOUT_MS);
    img.onload = () => { clearTimeout(timer); resolve(img); };
    img.onerror = () => { clearTimeout(timer); reject(new Error('load')); };
    img.decoding = 'async';
    img.src = IMAGE_DIR + encodeURIComponent(src);
  });
}

function drawImage() {
  for (let i = 0; i < IMAGES.length; i++) {
    const item = imageBag.draw();
    if (!brokenImages.has(item)) return item;
  }
  return null;
}

/* Просмотр на весь экран: картинка вписывается в окно браузера целиком (object-fit: contain). */
let lightbox = null;
function openLightbox(src, alt) {
  if (typeof HTMLDialogElement === 'undefined') return;
  if (!lightbox) {
    lightbox = el('dialog', 'lightbox');
    lightbox.setAttribute('aria-label', 'Просмотр картинки');
    const close = el('button', 'btn btn--icon lightbox__close', '✕');
    close.type = 'button';
    close.setAttribute('aria-label', 'Закрыть');
    lightbox.append(el('img', 'lightbox__img'), close);
    lightbox.addEventListener('click', () => lightbox.close());   // тап в любом месте закрывает; Esc работает нативно
    document.body.appendChild(lightbox);
  }
  const big = lightbox.querySelector('.lightbox__img');
  big.src = src;
  big.alt = alt;
  lightbox.showModal();
}

let memeSeq = 0;   // защита от гонки: показываем результат только последнего клика
async function showMeme() {
  const seq = ++memeSeq;
  const item = IMAGES.length && Math.random() < IMAGE_SHARE ? drawImage() : null;
  if (item) {
    els.card.classList.add('card--loading');
    try {
      const img = await loadImage(item.src);
      if (img.decode) await img.decode().catch(() => {});
      if (seq !== memeSeq) return;
      img.className = 'card__photo-img';
      img.alt = item.alt;
      img.tabIndex = 0;                                   // тап или Enter открывают фото на весь экран
      img.setAttribute('role', 'button');
      img.setAttribute('aria-label', `${item.alt}. Нажми, чтобы увеличить`);
      img.addEventListener('click', () => openLightbox(img.src, item.alt));
      img.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openLightbox(img.src, item.alt); } });
      if (img.naturalWidth && img.naturalHeight) { img.width = img.naturalWidth; img.height = img.naturalHeight; }   // резерв пропорций
      const figure = el('figure', 'card__content card__photo');
      figure.appendChild(img);
      showCard(figure, { meme: true });
      return;
    } catch (_) {
      brokenImages.add(item);          // битый файл больше не выпадает
      if (seq !== memeSeq) return;
    }
  }
  showTextMeme();
}


/* ==========================================================================
   События
   ========================================================================== */

/* «Тапалки» показывают карточку и сворачивают чат на узких экранах */
const tap = (fn) => throttle(() => { fn(); setView('cards'); }, 400);
$('memeBtn').addEventListener('click', tap(showMeme));
$('warmBtn').addEventListener('click', tap(showPhrase));



/* ==========================================================================
   Запуск: восстановление истории и интро
   ========================================================================== */

/* ---------- Вид: «тапалки» и чат взаимно сворачиваются на узких экранах (<900px, см. style.css) ---------- */
const chatToggle = $('chatToggle');
const tapToggle = $('tapToggle');
const wide = matchMedia('(min-width: 900px)');
const view = { mode: 'both', history: false };   // both | cards | chat
function applyView() {
  const cls = document.body.classList;
  cls.toggle('view-cards', view.mode === 'cards');
  cls.toggle('view-chat', view.mode === 'chat');
  cls.toggle('page--chatting', view.history && (view.mode !== 'cards' || wide.matches));
  chatToggle.hidden = view.mode !== 'cards';   // чат свёрнут: показываем иконку 💬
  tapToggle.hidden = view.mode !== 'chat';     // «тапалки» свёрнуты: показываем иконку 🎁
  chatToggle.classList.toggle('has-dot', view.history);
}
function setView(mode) {
  if (view.mode === mode) return;
  view.mode = mode;
  applyView();
  if (mode === 'chat') requestAnimationFrame(() => chat.scrollToEnd());
}
chatToggle.addEventListener('click', () => setView('chat'));
tapToggle.addEventListener('click', () => setView('cards'));
wide.addEventListener('change', applyView);
const chat = PrivalChat({
  $, el, safe, showToast, showPhrase, reduceMotion,
  onHistory(has) { view.history = has; applyView(); },
  onActivity() { if (view.mode === 'both') setView('chat'); }   // человек начал писать ИИ
});


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

/* ==========================================================================
   Запасной путь для картинок: если images.js пуст, а сайт на GitHub Pages,
   спрашиваем содержимое папки images/ у GitHub API (лимит 60 запросов/час на IP, поэтому кэш на 10 минут).
   Работает для адресов вида user.github.io/repo/ и user.github.io.
   ========================================================================== */

(async function discoverImages() {
  if (!IMAGES.length && /\.github\.io$/i.test(location.hostname)) {
    const owner = location.hostname.split('.')[0];
    const first = location.pathname.split('/')[1] || '';
    const repo = first && !first.includes('.') ? first : location.hostname;
    const key = `privat.images.${owner}/${repo}`;
    let names = null;
    try {
      const cached = JSON.parse(safe.get(key));
      if (cached && Date.now() - cached.ts < 600000) names = cached.names;
    } catch (_) { /* нет кэша */ }
    if (!names) {
      try {
        const res = await fetch(`https://api.github.com/repos/${owner}/${repo}/contents/${IMAGE_DIR.replace(/\/$/, '')}`, { headers: { Accept: 'application/vnd.github+json' } });
        if (res.ok) {
          const list = await res.json();
          names = Array.isArray(list) ? list.filter((f) => f && f.type === 'file').map((f) => String(f.name)) : [];
          safe.set(key, JSON.stringify({ ts: Date.now(), names }));
        }
      } catch (_) { /* офлайн или лимит API: останутся текстовые мемы */ }
    }
    (names || [])
      .filter((n) => /\.(avif|webp|png|jpe?g|gif|svg)$/i.test(n) && !n.startsWith('.'))
      .forEach((n) => IMAGES.push({ src: n, alt: 'Мем-картинка' }));
  }
  console.info(`Привал: картинок для мемов — ${IMAGES.length}`);
})();
