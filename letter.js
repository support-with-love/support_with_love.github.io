'use strict';
/* Письмо читается постранично: scroll-snap, кнопки «Назад/Дальше», прогресс.
   Без JS остаётся обычный длинный текст. BREAKS: с какого абзаца начинается страница. */
(function () {
  const BREAKS = [0, 3, 9, 16, 21, 27, 33];
  const dialog = document.getElementById('letter');
  const source = dialog.querySelector('.letter__text');
  const closeBtn = document.getElementById('letterClose');
  const paras = [...source.children];
  const last = BREAKS.length - 1;
  const behavior = () => (matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth');
  const make = (tag, cls, text) => { const n = document.createElement(tag); n.className = cls; if (text) n.textContent = text; return n; };

  const pager = make('div', 'letter__pager');
  pager.tabIndex = 0;
  pager.setAttribute('role', 'region');
  pager.setAttribute('aria-label', 'Письмо');
  BREAKS.forEach((from, i) => {
    const page = make('section', 'letter__page');
    page.setAttribute('aria-label', `Страница ${i + 1} из ${BREAKS.length}`);
    page.append(...paras.slice(from, BREAKS[i + 1] ?? paras.length));
    pager.appendChild(page);
  });
  source.replaceWith(pager);

  const fill = document.createElement('span');
  const bar = make('div', 'letter__bar');
  bar.setAttribute('aria-hidden', 'true');
  bar.appendChild(fill);
  const prev = make('button', 'btn', 'Назад');
  const next = make('button', 'btn btn--primary');
  prev.type = next.type = 'button';
  const status = make('span', 'letter__status');
  status.setAttribute('aria-live', 'polite');
  const nav = make('div', 'letter__nav');
  nav.append(prev, status, next);
  closeBtn.replaceWith(bar, nav);

  let current = 0;
  function render() {
    status.textContent = `${current + 1} из ${BREAKS.length}`;
    fill.style.width = `${((current + 1) / BREAKS.length) * 100}%`;
    prev.disabled = current === 0;
    next.textContent = current === last ? 'Закрыть письмо' : 'Дальше';
  }
  function go(i, instant) {
    current = Math.min(last, Math.max(0, i));
    pager.scrollTo({ left: current * pager.clientWidth, behavior: instant ? 'auto' : behavior() });
    render();
  }
  let raf = 0;
  pager.addEventListener('scroll', () => {          // свайп пальцем тоже обновляет прогресс
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(() => {
      const i = Math.round(pager.scrollLeft / (pager.clientWidth || 1));
      if (i !== current) { current = i; render(); pager.children[i].scrollTop = 0; }
    });
  }, { passive: true });

  const close = () => (dialog.close ? dialog.close() : dialog.removeAttribute('open'));
  const open = () => {
    if (dialog.showModal) dialog.showModal(); else dialog.setAttribute('open', '');
    go(0, true);
  };
  prev.addEventListener('click', () => go(current - 1));
  next.addEventListener('click', () => (current === last ? close() : go(current + 1)));
  dialog.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowRight') go(current + 1);
    if (e.key === 'ArrowLeft') go(current - 1);
  });
  addEventListener('resize', () => go(current, true));
  document.getElementById('letterBtn').addEventListener('click', open);
  document.getElementById('letterX').addEventListener('click', close);
  dialog.addEventListener('click', (e) => { if (e.target === dialog) close(); });   // клик по затемнению
  render();
})();
