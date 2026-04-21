/**
 * portrait-layout.js — Dynamic grid-row sizing for portrait tablet layout.
 *
 * At `@media (orientation:portrait) and (min-width:700px)` the .sim-main grid
 * splits vertically 1fr/1fr (chart top, drug panel + history bottom). When the
 * drug cards are short, the bottom row wastes space the chart could use.
 *
 * This module measures the drug panel's scrollHeight and sets
 * `grid-template-rows: 1fr <measured>px` so the chart takes all slack. Capped
 * at 50% of window height so a pathologically tall drug panel can never
 * starve the chart.
 *
 * No-op on other layouts — `matchMedia` mismatches clear the inline style and
 * the base CSS takes over.
 */

let _ro = null;
let _mql = null;
let _wired = false;

/**
 * Wire the dynamic row sizing. Idempotent — safe to call multiple times.
 * Requires the .sim-main and .drug-panel elements to exist in the DOM.
 */
export function initPortraitLayout() {
  if (_wired) { sync(); return; }
  const drugPanel = document.querySelector('.drug-panel');
  if (!drugPanel) return;

  _mql = typeof window.matchMedia === 'function'
    ? window.matchMedia('(orientation:portrait) and (min-width:700px)')
    : null;
  if (_mql && typeof _mql.addEventListener === 'function') {
    _mql.addEventListener('change', sync);
  }

  if (typeof window.ResizeObserver === 'function') {
    _ro = new ResizeObserver(sync);
    _ro.observe(drugPanel);
  }

  window.addEventListener('resize', sync);
  window.addEventListener('orientationchange', sync);

  _wired = true;
  sync();
}

/** Force a re-sync — call after text-size change or other layout-affecting event. */
export function syncPortraitLayout() { sync(); }

/**
 * Measure the drug panel's intrinsic content height. `scrollHeight` returns
 * `clientHeight` when content fits without scrolling — so if the grid has
 * already sized the panel larger than its content, scrollHeight lies.
 * Sum the children's own heights instead.
 */
function measureContentHeight(drugPanel) {
  const cards = drugPanel.querySelectorAll('.drug-card');
  if (!cards.length) return 0;
  let h = 0;
  for (const card of cards) h += card.getBoundingClientRect().height;
  const style = getComputedStyle(drugPanel);
  const gap = parseFloat(style.rowGap || style.gap || '0') || 0;
  h += gap * Math.max(0, cards.length - 1);
  return Math.ceil(h);
}

function sync() {
  const simMain = document.querySelector('.sim-main');
  const drugPanel = document.querySelector('.drug-panel');
  if (!simMain || !drugPanel) return;

  if (!_mql || !_mql.matches) {
    simMain.style.gridTemplateRows = '';
    return;
  }

  const content = measureContentHeight(drugPanel);
  if (!content) return; // DOM not ready — will re-fire on the next observer tick

  const cap = Math.round(window.innerHeight * 0.55);
  const needed = Math.min(content + 8, cap);
  simMain.style.gridTemplateRows = `1fr ${needed}px`;
}
