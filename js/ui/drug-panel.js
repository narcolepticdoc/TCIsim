/**
 * drug-panel.js — Drug Panel Live Display
 *
 * Updates the drug card with live values from the model:
 * Ce, Cp, approach countdown, status+rate, BIS, step-bar. Runs on rAF.
 */

import { fromCanonical, formatValue, getAllowedUnits, getDefaultUnit, getPrefKey } from '../util/units.js';

const $ = id => document.getElementById(id);

let model      = null;
let timer      = null;
let getMode    = null;   // () => mode string
let getCeTarget = null;  // () => Ce target number
let getDrugId  = null;   // () => selected drug id
let rafId      = null;
let onFrame    = null;   // callback: (elapsedMinutes) => void

// Emergence Ce level (mcg/mL). Could become a user setting later.
const EMERGENCE_CE = 1.5;

// Approach line cache — recomputed at most every 500ms wall-clock time
let _approachCache = { text: '', computedAt: -Infinity, mode: '', rate: 0, target: 0 };

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
  model      = opts.model;
  timer      = opts.timer;
  getMode    = opts.getMode    || (() => 'none');
  getCeTarget = opts.getCeTarget || (() => 0);
  getDrugId  = opts.getDrugId  || (() => 'propofol');
  onFrame    = opts.onFrame    || null;
  loop();
}

/** Stop the animation loop (for cleanup). */
export function stop() {
  if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
}

function loop() {
  update();
  rafId = requestAnimationFrame(loop);
}

// ──────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────

/**
 * Format minutes as m:ss  (e.g. 125.4s → "2:05")
 */
function fmtCountdown(minutes) {
  if (!isFinite(minutes) || minutes <= 0) return '0:00';
  const totalSec = Math.round(minutes * 60);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

/**
 * BIS → color matching the chart nomogram bands:
 *   > 90  muted       (awake, no band)
 *  80-90  #ef4444 red    Light Sedation
 *  60-80  #f97316 orange Deep Sedation
 *  40-60  #eab308 yellow GA
 *  20-40  #22c55e green  Deep Anesthesia
 *   < 20  #a855f7 purple Very Deep
 */
function bisColor(bis) {
  if (bis > 90) return 'var(--text-muted)';
  if (bis > 80) return '#ef4444';
  if (bis > 60) return '#f97316';
  if (bis > 40) return '#eab308';
  if (bis > 20) return '#22c55e';
  return '#a855f7';
}

/**
 * Check if current time is inside an active bolus event.
 * Returns true when the most recent event at/before t is a 'bolus' type.
 */
function isInBolusPhase(drugId, t) {
  try {
    const events = model.getEvents(drugId);
    // Walk backwards to find last event at or before t
    let last = null;
    for (let i = events.length - 1; i >= 0; i--) {
      if (events[i].time <= t) { last = events[i]; break; }
    }
    if (last && last.type === 'bolus') {
      // Still in bolus if t hasn't reached bolus end time
      // We can't compute end time here without pump settings,
      // but if the current rate from the model is very high (>50 mg/min)
      // and source is bolus, treat it as bolus phase.
      return true;
    }
  } catch (e) {}
  return false;
}

/**
 * Format rate for inline display next to status label.
 * Returns '' if no rate.
 */
function fmtRateInline(drugId, rate) {
  if (!rate || rate <= 0) return '';
  try {
    const ctx = { weightKg: model.getPatient().weight };
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
    return `${formatValue(displayVal, displayUnit)} ${displayUnit}`;
  } catch (e) {
    return `${rate.toFixed(2)} mg/min`;
  }
}

// ──────────────────────────────────────────────────────────────────
// Approach line computation (throttled to 500ms)
// ──────────────────────────────────────────────────────────────────

/**
 * Find when Ce first comes within 0.05 of ceTarget scanning forward.
 * Returns delta-minutes from t, or null if not found within 30 min.
 */
function estimateTimeToTarget(drugId, t, Ce, ceTarget) {
  try {
    const curve = model.computeCurve(drugId, t, t + 30, 0.1);
    const approaching = Ce < ceTarget;
    for (const pt of curve) {
      if (approaching && pt.Ce >= ceTarget - 0.05) return pt.time - t;
      if (!approaching && pt.Ce <= ceTarget + 0.05) return pt.time - t;
    }
  } catch (e) {}
  return null;
}

/**
 * Find steady-state Ce and time to reach it (for manual infusion).
 * "Steady state" = when Ce changes by less than 0.05 mcg/mL over any
 * 5-minute window — the number has stopped moving meaningfully.
 * Returns { ssCe, ssMin } or null.
 */
function estimateSteadyState(drugId, t) {
  try {
    const curve = model.computeCurve(drugId, t, t + 150, 1.0);
    if (curve.length < 6) return null;
    const ssCe = curve[curve.length - 1].Ce; // best asymptote estimate at 150 min
    // Find first index where the 5-min change drops below 0.05 mcg/mL
    for (let i = 0; i + 5 < curve.length; i++) {
      if (Math.abs(curve[i + 5].Ce - curve[i].Ce) < 0.05) {
        return { ssCe, ssMin: curve[i].time - t };
      }
    }
    return { ssCe, ssMin: null };
  } catch (e) { return null; }
}

/**
 * Build the HTML for the approach line. Uses span elements for color.
 * Returns HTML string.
 */
function computeApproachHTML(drugId, t, m, Ce, ceTarget, rate) {
  // Pump fully stopped (no mode) — show emergence countdown
  if (m === 'none' || (rate === 0 && m !== 'tci')) {
    if (Ce <= EMERGENCE_CE + 0.05) return ''; // already below or at emergence
    try {
      const result = model.predictTrough(drugId, t, EMERGENCE_CE);
      if (result && result.time !== null) {
        const dt = result.time - t;
        if (dt > 0) {
          return `Emergence Ce <span class="appr-val">${EMERGENCE_CE.toFixed(1)}</span> in <span class="appr-time">${fmtCountdown(dt)}</span>`;
        }
      }
    } catch (e) {}
    return '';
  }

  // TCI mode — approaching target
  if (m === 'tci' && ceTarget > 0) {
    if (Math.abs(Ce - ceTarget) < 0.05) {
      return `At Target <span class="appr-val">${ceTarget.toFixed(1)} mcg/mL</span>`;
    }
    const dt = estimateTimeToTarget(drugId, t, Ce, ceTarget);
    const dirLabel = Ce < ceTarget ? 'Approaching' : 'Approaching';
    if (dt !== null && dt > 0) {
      return `${dirLabel} Target → <span class="appr-val">${ceTarget.toFixed(1)}</span> in <span class="appr-time">${fmtCountdown(dt)}</span>`;
    }
    return `Target Ce <span class="appr-val">${ceTarget.toFixed(1)} mcg/mL</span>`;
  }

  // Manual infusion — show steady state estimate
  if (m === 'manual' && rate > 0) {
    const ss = estimateSteadyState(drugId, t);
    if (ss) {
      const ceStr = `<span class="appr-val">${ss.ssCe.toFixed(1)} mcg/mL</span>`;
      if (ss.ssMin !== null && ss.ssMin > 0.5) {
        return `Steady state ≈ ${ceStr} in <span class="appr-time">${fmtCountdown(ss.ssMin)}</span>`;
      }
      return `Steady state ≈ ${ceStr}`;
    }
  }

  // TCI paused — show emergence or target depending on which is relevant
  if (m === 'tci' && rate === 0 && ceTarget > 0) {
    // Approaching target (resumed) or decaying?
    if (Ce > ceTarget + 0.1) {
      // Decaying toward target, show when it'll arrive
      const dt = estimateTimeToTarget(drugId, t, Ce, ceTarget);
      if (dt !== null && dt > 0) {
        return `Returning to Target → <span class="appr-val">${ceTarget.toFixed(1)}</span> in <span class="appr-time">${fmtCountdown(dt)}</span>`;
      }
    }
  }

  return '';
}

/**
 * Update approach line, throttled to ~500ms.
 */
function updateApproachLine(drugId, t, m, Ce, ceTarget, rate) {
  const now = Date.now();
  const cacheValid =
    now - _approachCache.computedAt < 500 &&
    _approachCache.mode === m &&
    Math.abs(_approachCache.rate - rate) < 0.01 &&
    Math.abs(_approachCache.target - ceTarget) < 0.01;

  if (!cacheValid) {
    _approachCache.text       = computeApproachHTML(drugId, t, m, Ce, ceTarget, rate);
    _approachCache.computedAt = now;
    _approachCache.mode       = m;
    _approachCache.rate       = rate;
    _approachCache.target     = ceTarget;
  }

  const el = $(drugId + '-approach');
  if (el && el.innerHTML !== _approachCache.text) {
    el.innerHTML = _approachCache.text;
  }
}

// ──────────────────────────────────────────────────────────────────
// Step bar + countdown
// ──────────────────────────────────────────────────────────────────

function updateStepBar(drugId, t) {
  const barEl       = $(drugId + '-bar');
  const countdownEl = $(drugId + '-bar-countdown');
  if (!barEl || !countdownEl) return;

  try {
    const events = model.getEvents(drugId);
    // Find next event strictly after t
    let nextEvt = null;
    for (const e of events) {
      if (e.time > t + 0.0001) { nextEvt = e; break; }
    }
    if (!nextEvt) {
      barEl.style.width = '0%';
      countdownEl.textContent = '';
      return;
    }

    // Find last event at or before t
    let prevTime = 0;
    for (let i = events.length - 1; i >= 0; i--) {
      if (events[i].time <= t + 0.0001) { prevTime = events[i].time; break; }
    }

    const span = nextEvt.time - prevTime;
    const elapsed = t - prevTime;
    const pct = span > 0 ? Math.min(100, Math.max(0, (elapsed / span) * 100)) : 0;
    const remaining = nextEvt.time - t;

    barEl.style.width = pct + '%';
    countdownEl.textContent = remaining > 0 ? fmtCountdown(remaining) : '';
  } catch (e) {
    barEl.style.width = '0%';
    if (countdownEl) countdownEl.textContent = '';
  }
}

// ──────────────────────────────────────────────────────────────────
// Main update
// ──────────────────────────────────────────────────────────────────

function update() {
  if (!model || !timer) return;

  const drugId    = getDrugId();
  const t         = timer.getElapsedMinutes();
  const m         = getMode();
  const ceTarget  = getCeTarget();
  const caseStarted = timer.isRunning() || t > 0;

  let Cp = 0, Ce = 0, rate = 0, bis = null;
  if (caseStarted && t > 0) {
    try {
      const conc = model.getConcentrationsAt(drugId, t);
      Cp   = conc.Cp;
      Ce   = conc.Ce;
      rate = conc.rate;
      bis  = model.predictBIS(drugId, t);
    } catch (e) {}
  }

  // ── Ce display ──────────────────────────────────────────────────
  const ceEl = $(drugId + '-ce');
  if (ceEl) ceEl.textContent = Ce.toFixed(2);

  // ── Cp display ──────────────────────────────────────────────────
  const cpEl = $(drugId + '-cp');
  if (cpEl) cpEl.textContent = Cp.toFixed(2);

  // ── Approach line ───────────────────────────────────────────────
  if (caseStarted) {
    updateApproachLine(drugId, t, m, Ce, ceTarget, rate);
  } else {
    const el = $(drugId + '-approach');
    if (el) el.innerHTML = '';
  }

  // ── Status + rate ───────────────────────────────────────────────
  const statusEl = $(drugId + '-status');
  const rateEl   = $(drugId + '-rate');

  if (statusEl) {
    let label = 'Stopped', cls = 'stopped';

    if (!caseStarted || m === 'none') {
      label = 'Stopped'; cls = 'stopped';
    } else if (rate === 0) {
      label = 'Paused'; cls = 'paused';
    } else if (isInBolusPhase(drugId, t) || rate > 50) {
      label = 'Bolus'; cls = 'bolus';
    } else {
      label = 'Infusing'; cls = 'infusing';
    }

    statusEl.textContent = label;
    statusEl.className   = 'drug-status ' + cls;
  }

  if (rateEl) {
    const showRate = caseStarted && rate > 0;
    rateEl.textContent = showRate ? fmtRateInline(drugId, rate) : '';
  }

  // ── BIS ─────────────────────────────────────────────────────────
  const bisEl = $(drugId + '-bis');
  if (bisEl) {
    if (bis !== null && caseStarted && t > 0) {
      bisEl.textContent = `BIS ${bis.toFixed(0)}`;
      bisEl.style.color = bisColor(bis);
    } else {
      bisEl.textContent = '';
    }
  }

  // ── Step bar + countdown ────────────────────────────────────────
  if (caseStarted) {
    updateStepBar(drugId, t);
  }

  // ── Notify app.js for chart cursor ─────────────────────────────
  if (onFrame) onFrame(t);
}

/** Force an immediate update (after a model mutation). */
export function forceUpdate() {
  _approachCache.computedAt = -Infinity; // force recompute
  update();
}
