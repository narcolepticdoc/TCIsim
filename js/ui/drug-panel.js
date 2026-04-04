/**
 * drug-panel.js — Drug Panel Live Display
 * 
 * Updates the drug card with live values from the model:
 * Ce, Cp, rate, BIS, status. Runs on requestAnimationFrame
 * when the case is started.
 */

import { fromCanonical, formatValue, getAllowedUnits, getDefaultUnit, getPrefKey } from '../util/units.js';
import { DRUG_DEFS } from '../util/constants.js';

const $ = id => document.getElementById(id);

let model = null;
let timer = null;
let getMode = null;       // () => mode string
let getCeTarget = null;   // () => Ce target number
let getDrugId = null;     // () => selected drug id
let rafId = null;
let onFrame = null;        // callback: (elapsedMinutes) => void

/**
 * Initialize the drug panel.
 * @param {Object} opts
 * @param {Object} opts.model - simulation model
 * @param {Object} opts.timer - timer module
 * @param {Function} opts.getMode - () => current mode for selected drug
 * @param {Function} opts.getCeTarget - () => current Ce target
 * @param {Function} opts.getDrugId - () => selected drug id
 * @param {Function} [opts.onFrame] - called each rAF with elapsed minutes
 */
export function init(opts = {}) {
  model = opts.model;
  timer = opts.timer;
  getMode = opts.getMode || (() => 'none');
  getCeTarget = opts.getCeTarget || (() => 0);
  getDrugId = opts.getDrugId || (() => 'propofol');
  onFrame = opts.onFrame || null;

  // Start the animation loop
  loop();
}

/**
 * Stop the animation loop (for cleanup).
 */
export function stop() {
  if (rafId) {
    cancelAnimationFrame(rafId);
    rafId = null;
  }
}

function loop() {
  update();
  rafId = requestAnimationFrame(loop);
}

function update() {
  if (!model || !timer) return;

  const drugId = getDrugId();
  const t = timer.getElapsedMinutes();
  const m = getMode();
  const ceTarget = getCeTarget();
  const caseStarted = timer.isRunning() || t > 0;

  // Query model for live concentrations
  let Cp = 0, Ce = 0, rate = 0, bis = null;
  if (caseStarted && t > 0) {
    try {
      const conc = model.getConcentrationsAt(drugId, t);
      Cp = conc.Cp;
      Ce = conc.Ce;
      rate = conc.rate; // mg/min from model

      bis = model.predictBIS(drugId, t);
    } catch (e) {
      // Model may not have events yet
    }
  }

  // ---- Update DOM ----

  // Ce display
  const ceEl = $(drugId + '-ce');
  if (ceEl) ceEl.textContent = Ce.toFixed(2);

  // Cp display
  const cpEl = $(drugId + '-cp');
  if (cpEl) cpEl.textContent = Cp.toFixed(2);

  // Target display
  const targetEl = $(drugId + '-target-disp');
  if (targetEl) {
    targetEl.textContent = (m === 'tci' && ceTarget > 0)
      ? '→ ' + ceTarget.toFixed(1)
      : '';
  }

  // Rate display — convert from mg/min to user's preferred display unit
  const rateEl = $(drugId + '-rate');
  if (rateEl) {
    if (rate > 0 && caseStarted) {
      try {
        const ctx = { weightKg: model.getPatient().weight };
        // Get user's preferred rate unit (falls back to default)
        const prefKey = getPrefKey(drugId, 'rate');
        let displayUnit = getDefaultUnit(drugId, 'rate');
        if (prefKey) {
          try {
            const saved = localStorage.getItem(prefKey);
            const allowed = getAllowedUnits(drugId, 'rate');
            if (saved && allowed.includes(saved)) displayUnit = saved;
          } catch (e) {}
        }
        const displayVal = fromCanonical(rate, displayUnit, drugId, 'rate', ctx);
        rateEl.textContent = `Rate: ${formatValue(displayVal, displayUnit)} ${displayUnit}`;
      } catch (e) {
        rateEl.textContent = `Rate: ${rate.toFixed(2)} mg/min`;
      }
    } else if (rate === 0 && caseStarted && m !== 'none') {
      rateEl.textContent = 'Rate: 0';
    } else {
      rateEl.textContent = '';
    }
  }

  // Status display
  const statusEl = $(drugId + '-status');
  if (statusEl) {
    if (!caseStarted || m === 'none') {
      statusEl.textContent = 'Stopped';
      statusEl.className = 'drug-status stopped';
    } else if (m === 'tci') {
      if (rate === 0) {
        // TCI-scheduled pause (no manual intervention — future events exist)
        statusEl.textContent = 'Paused';
        statusEl.className = 'drug-status paused';
      } else {
        const isBolusPhase = rate > 50; // crude heuristic
        statusEl.textContent = isBolusPhase ? 'Bolus' : 'Infusing';
        statusEl.className = 'drug-status ' + (isBolusPhase ? 'bolus' : 'infusing');
      }
    } else if (m === 'manual') {
      if (rate === 0) {
        // Manual pump stop — no further TCI instructions
        statusEl.textContent = 'Pump Stopped';
        statusEl.className = 'drug-status stopped';
      } else {
        statusEl.textContent = 'Manual';
        statusEl.className = 'drug-status manual';
      }
    } else {
      statusEl.textContent = m;
      statusEl.className = 'drug-status';
    }
  }

  // BIS display
  const bisEl = $(drugId + '-bis');
  if (bisEl) {
    if (bis !== null && caseStarted && t > 0) {
      bisEl.textContent = `BIS: ${bis.toFixed(0)}`;
    } else {
      bisEl.textContent = '';
    }
  }

  // Notify app.js for chart cursor update
  if (onFrame) onFrame(t);
}

/**
 * Force an immediate update (after a model mutation).
 */
export function forceUpdate() {
  update();
}
