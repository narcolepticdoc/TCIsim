/**
 * controls.js — Case & Pump Controls
 * 
 * Clinical semantics:
 * - "Start" begins the case. The timer starts and never stops.
 *   Time is always running because time is always running.
 * - "Pause Pump" sets the infusion rate to zero for the selected drug.
 *   The timer keeps running. This is equivalent to the clinician
 *   pressing pause on the physical pump.
 * - "Resume Pump" is not automatic — the clinician must set a new
 *   rate or target via the keypad.
 */

const $ = id => document.getElementById(id);

let caseStarted = false;
let timer = null;
let onCaseStart = null;   // callback: () => void
let onPumpPause = null;   // callback: (drugId) => void

/**
 * Initialize controls.
 * @param {Object} opts
 * @param {Object} opts.timer - timer module
 * @param {Function} [opts.onCaseStart] - called when case begins
 * @param {Function} [opts.onPumpPause] - called when pump is paused
 */
export function init(opts = {}) {
  timer = opts.timer;
  onCaseStart = opts.onCaseStart || null;
  onPumpPause = opts.onPumpPause || null;

  const btn = $('btn-pause');
  if (btn) btn.addEventListener('click', handleButton);
}

function handleButton() {
  if (!caseStarted) {
    // Start the case — timer begins, never stops
    caseStarted = true;
    timer.start();
    updateButton();
    if (onCaseStart) onCaseStart();
  } else {
    // Pause the pump — timer keeps running
    if (onPumpPause) onPumpPause();
  }
}

export function isCaseStarted() { return caseStarted; }

/**
 * Ensure the case is started (auto-start if not yet).
 * Called on case restore. Passes opts through to onCaseStart so callers
 * can suppress side effects (e.g. the "Case Started" annotation on restore).
 * @param {Object} [opts] - forwarded to onCaseStart (e.g. { restored: true })
 * @returns {boolean} true if case was just started
 */
export function ensureStarted(opts) {
  if (caseStarted) return false;
  caseStarted = true;
  timer.start();
  updateButton();
  if (onCaseStart) onCaseStart(opts);
  return true;
}

export function reset() {
  caseStarted = false;
  timer.reset();
  updateButton();
}

function updateButton() {
  const btn = $('btn-pause');
  if (!btn) return;

  if (!caseStarted) {
    btn.textContent = 'Start';
    btn.className = 'btn-ctrl btn-ctrl-pause is-stopped';
  } else {
    btn.textContent = 'Stop Pump';
    btn.className = 'btn-ctrl btn-ctrl-pause is-running';
  }
}
