/**
 * timer.js — Display Timer & Wall-Clock Sync
 * 
 * Manages the elapsed time display and wall-clock anchor.
 * This is pure UI — it has no dependency on the simulation model.
 * The model doesn't track time; the timer provides the "current time"
 * that app.js uses when calling model commands.
 */

const $ = id => document.getElementById(id);

let elapsedMs = 0;
let wallClockStart = null;   // Date when sim "started" (actual or user-adjusted)
let realStartTime = null;    // Date.now() when Start was pressed
let intervalId = null;
let running = false;

let onTick = null; // callback: (elapsedMs) => void, called every 500ms

/**
 * Initialize the timer module.
 * @param {Object} opts
 * @param {Function} [opts.onTick] - called every 500ms with elapsed ms
 */
export function init(opts = {}) {
  onTick = opts.onTick || null;

  // Wire timer click → popover toggle
  const timerEl = $('elapsed-timer');
  if (timerEl) timerEl.addEventListener('click', togglePopover);

  // Wire popover buttons
  const btnApply = $('tp-btn-apply');
  if (btnApply) btnApply.addEventListener('click', applyStartTime);

  const btnNow = $('tp-btn-now');
  if (btnNow) btnNow.addEventListener('click', applyNow);

  const btnCancel = $('tp-btn-cancel');
  if (btnCancel) btnCancel.addEventListener('click', closePopover);

  // Wire time input for live preview
  const inputTime = $('input-start-time');
  if (inputTime) inputTime.addEventListener('input', updatePopoverInfo);

  // Wire mode toggle
  $('tp-mode-start')?.addEventListener('click', () => setPopoverMode('start'));
  $('tp-mode-elapsed')?.addEventListener('click', () => setPopoverMode('elapsed'));

  // Close popover on outside click
  document.addEventListener('click', e => {
    const wrap = $('timer-wrap');
    if (wrap && !wrap.contains(e.target)) closePopover();
  });
}

// ---- Start / Pause / Resume ----

export function start() {
  if (running) return;
  if (!wallClockStart) wallClockStart = new Date();
  realStartTime = Date.now() - elapsedMs;
  running = true;
  intervalId = setInterval(tick, 500);
  updateWallHint();
}

export function pause() {
  if (!running) return;
  elapsedMs = Date.now() - realStartTime;
  running = false;
  if (intervalId) { clearInterval(intervalId); intervalId = null; }
}

export function resume() {
  start(); // same logic — recalculates realStartTime from current elapsedMs
}

export function reset() {
  if (intervalId) { clearInterval(intervalId); intervalId = null; }
  running = false;
  elapsedMs = 0;
  wallClockStart = null;
  realStartTime = null;
  renderDisplay();
  updateWallHint();
  closePopover();
}

/**
 * Set wall clock start externally (for case restore).
 * @param {Date} startDate
 */
export function setWallClockStart(startDate) {
  wallClockStart = startDate;
  elapsedMs = Date.now() - startDate.getTime();
  if (running) realStartTime = Date.now() - elapsedMs;
  renderDisplay();
  updateWallHint();
}

// ---- Queries ----

export function isRunning() { return running; }

/** Get the wall clock start Date, or null if not set. */
export function getWallClockStart() { return wallClockStart; }

/** Get elapsed time in milliseconds. */
export function getElapsedMs() {
  if (running && realStartTime != null) {
    return Date.now() - realStartTime;
  }
  return elapsedMs;
}

/** Get elapsed time in minutes (what the model uses). */
export function getElapsedMinutes() {
  return getElapsedMs() / 60000;
}

/** Get wall-clock Date for current sim time, or null. */
export function getWallClock() {
  if (!wallClockStart) return null;
  return new Date(wallClockStart.getTime() + getElapsedMs());
}

/** Format wall clock as HH:MM. */
export function formatWallClock() {
  const d = getWallClock();
  if (!d) return '--:--';
  return String(d.getHours()).padStart(2, '0') + ':' +
         String(d.getMinutes()).padStart(2, '0');
}

// ---- Internal ----

function tick() {
  if (realStartTime == null) return;
  elapsedMs = Date.now() - realStartTime;
  renderDisplay();
  if (onTick) onTick(elapsedMs);
}

function renderDisplay() {
  const el = $('elapsed-timer');
  if (!el) return;
  const t = Math.floor(getElapsedMs() / 1000);
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = t % 60;
  el.textContent = h + ':' + String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
}

function updateWallHint() {
  const el = $('timer-wall-hint');
  if (!el) return;
  if (wallClockStart) {
    const h = String(wallClockStart.getHours()).padStart(2, '0');
    const m = String(wallClockStart.getMinutes()).padStart(2, '0');
    el.textContent = 'start ' + h + ':' + m;
  } else {
    el.textContent = '';
  }
}

// ---- Popover ----

function togglePopover() {
  const pop = $('timer-popover');
  if (!pop) return;
  if (pop.classList.contains('open')) { closePopover(); return; }

  _popoverMode = 'start';
  $('tp-mode-start')?.classList.add('active');
  $('tp-mode-elapsed')?.classList.remove('active');
  $('input-start-time').parentElement.style.display = '';
  $('tp-elapsed-row').style.display = 'none';

  // Pre-fill start time
  const input = $('input-start-time');
  if (wallClockStart) {
    input.value = String(wallClockStart.getHours()).padStart(2, '0') + ':' +
                  String(wallClockStart.getMinutes()).padStart(2, '0');
  } else {
    const now = new Date();
    input.value = String(now.getHours()).padStart(2, '0') + ':' +
                  String(now.getMinutes()).padStart(2, '0');
  }

  // Pre-fill elapsed selects
  populateElapsedSelects();

  updatePopoverInfo();
  pop.classList.add('open');
}

let _popoverMode = 'start'; // 'start' | 'elapsed'

function setPopoverMode(mode) {
  _popoverMode = mode;
  $('tp-mode-start')?.classList.toggle('active', mode === 'start');
  $('tp-mode-elapsed')?.classList.toggle('active', mode === 'elapsed');
  $('input-start-time').parentElement.style.display = mode === 'start' ? '' : 'none';
  $('tp-elapsed-row').style.display = mode === 'elapsed' ? '' : 'none';
  updatePopoverInfo();
}

function populateElapsedSelects() {
  const elH = $('tp-elapsed-h');
  const elM = $('tp-elapsed-m');
  if (!elH || !elM) return;

  const currentMin = Math.floor(getElapsedMs() / 60000);
  const h = Math.floor(currentMin / 60);
  const m = currentMin % 60;

  elH.innerHTML = '';
  for (let i = 0; i < 24; i++) {
    const opt = document.createElement('option');
    opt.value = i;
    opt.textContent = String(i).padStart(2, '0');
    if (i === h) opt.selected = true;
    elH.appendChild(opt);
  }

  elM.innerHTML = '';
  for (let i = 0; i < 60; i++) {
    const opt = document.createElement('option');
    opt.value = i;
    opt.textContent = String(i).padStart(2, '0');
    if (i === m) opt.selected = true;
    elM.appendChild(opt);
  }

  elH.onchange = updatePopoverInfo;
  elM.onchange = updatePopoverInfo;
}

function closePopover() {
  const pop = $('timer-popover');
  if (pop) pop.classList.remove('open');
}

function updatePopoverInfo() {
  const info = $('tp-info');
  if (!info) return;

  if (_popoverMode === 'start') {
    const val = $('input-start-time').value;
    if (!val) { info.textContent = ''; return; }
    const [h, m] = val.split(':').map(Number);
    const proposed = new Date();
    proposed.setHours(h, m, 0, 0);
    const now = new Date();
    const diffMs = now.getTime() - proposed.getTime();
    if (diffMs > 0) {
      const diffSec = Math.floor(diffMs / 1000);
      const eh = Math.floor(diffSec / 3600);
      const em = Math.floor((diffSec % 3600) / 60);
      const es = diffSec % 60;
      info.textContent = `Elapsed: ${eh}:${String(em).padStart(2, '0')}:${String(es).padStart(2, '0')}`;
    } else {
      info.textContent = 'Start time is in the future';
    }
  } else {
    // Elapsed mode — show what start time would be
    const h = parseInt($('tp-elapsed-h')?.value) || 0;
    const m = parseInt($('tp-elapsed-m')?.value) || 0;
    const elapsedMs = (h * 60 + m) * 60000;
    const startDate = new Date(Date.now() - elapsedMs);
    info.textContent = `Case started at ${String(startDate.getHours()).padStart(2, '0')}:${String(startDate.getMinutes()).padStart(2, '0')}`;
  }
}

function applyStartTime() {
  if (_popoverMode === 'start') {
    const val = $('input-start-time').value;
    if (!val) return;
    const [h, m] = val.split(':').map(Number);
    const newStart = new Date();
    newStart.setHours(h, m, 0, 0);
    const now = new Date();
    const newElapsedMs = now.getTime() - newStart.getTime();
    if (newElapsedMs < 0) { closePopover(); return; }

    wallClockStart = newStart;
    elapsedMs = newElapsedMs;
    if (realStartTime != null) realStartTime = Date.now() - elapsedMs;
  } else {
    // Elapsed mode
    const h = parseInt($('tp-elapsed-h')?.value) || 0;
    const m = parseInt($('tp-elapsed-m')?.value) || 0;
    const newElapsedMs = (h * 60 + m) * 60000;
    wallClockStart = new Date(Date.now() - newElapsedMs);
    elapsedMs = newElapsedMs;
    if (realStartTime != null) realStartTime = Date.now() - elapsedMs;
  }

  renderDisplay();
  updateWallHint();
  closePopover();
}

function applyNow() {
  wallClockStart = new Date();
  elapsedMs = 0;
  if (realStartTime != null) realStartTime = Date.now();

  renderDisplay();
  updateWallHint();
  closePopover();
}
