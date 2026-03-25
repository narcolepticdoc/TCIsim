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
  const m = Math.floor(t / 60);
  const s = t % 60;
  el.textContent = String(m).padStart(3, '0') + ':' + String(s).padStart(2, '0');
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

  // Pre-fill with current wall clock start
  const input = $('input-start-time');
  if (wallClockStart) {
    input.value = String(wallClockStart.getHours()).padStart(2, '0') + ':' +
                  String(wallClockStart.getMinutes()).padStart(2, '0');
  } else {
    const now = new Date();
    input.value = String(now.getHours()).padStart(2, '0') + ':' +
                  String(now.getMinutes()).padStart(2, '0');
  }
  updatePopoverInfo();
  pop.classList.add('open');
}

function closePopover() {
  const pop = $('timer-popover');
  if (pop) pop.classList.remove('open');
}

function updatePopoverInfo() {
  const val = $('input-start-time').value;
  const info = $('tp-info');
  if (!val || !info) { if (info) info.textContent = ''; return; }

  const [h, m] = val.split(':').map(Number);
  const proposed = new Date();
  proposed.setHours(h, m, 0, 0);
  const now = new Date();
  const diffMs = now.getTime() - proposed.getTime();

  if (diffMs > 0) {
    const diffMin = Math.floor(diffMs / 60000);
    info.textContent = 'Elapsed would become ' +
      String(Math.floor(diffMin / 60)).padStart(1, '0') + 'h ' +
      String(diffMin % 60).padStart(2, '0') + 'm';
  } else {
    info.textContent = 'Start time is in the future';
  }
}

function applyStartTime() {
  const val = $('input-start-time').value;
  if (!val) return;

  const [h, m] = val.split(':').map(Number);
  const newStart = new Date();
  newStart.setHours(h, m, 0, 0);

  const now = new Date();
  const newElapsedMs = now.getTime() - newStart.getTime();
  if (newElapsedMs < 0) { closePopover(); return; } // future start not allowed

  wallClockStart = newStart;
  elapsedMs = newElapsedMs;
  if (realStartTime != null) realStartTime = Date.now() - elapsedMs;

  renderDisplay();
  updateWallHint();
  closePopover();

  return { hours: h, minutes: m }; // caller can log annotation
}

function applyNow() {
  wallClockStart = new Date();
  elapsedMs = 0;
  if (realStartTime != null) realStartTime = Date.now();

  renderDisplay();
  updateWallHint();
  closePopover();
}
