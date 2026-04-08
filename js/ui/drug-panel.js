/**
 * drug-panel.js — Drug Panel Live Display
 *
 * Updates the drug card with live values from the model:
 * Ce, Cp, approach countdown, status+rate, BIS, step-bar. Runs on rAF.
 *
 * Approach line stability detection uses the precomputed chart curve
 * (supplied via setCurveData) rather than calling model.computeCurve
 * independently. Scanning an array is essentially free, so no throttle
 * is needed — the cache invalidates when a new curve arrives or when
 * the pump state changes.
 */

import { fromCanonical, formatValue, getAllowedUnits, getDefaultUnit, getPrefKey } from '../util/units.js';
import * as warnings from './warnings.js';

const $ = id => document.getElementById(id);

let model                    = null;
let timer                    = null;
let getMode                  = null;   // () => mode string
let getCeTarget              = null;   // () => Ce target number
let getIntermittentThreshold = null;   // () => intermittent redose threshold (mcg/mL canonical)
let getDrugId                = null;   // () => selected drug id
let getDrugIds                        = null;   // () => string[] all drug ids with cards
let getModeForDrug                    = null;   // (drugId) => mode string for any drug
let getIntermittentThresholdForDrug   = null;   // (drugId) => canonical mcg/mL threshold
let getCeTargetForDrug                = null;   // (drugId) => TCI Ce target (mcg/mL canonical)
let rafId                    = null;
let onFrame                  = null;   // callback: (elapsedMinutes) => void

// ──────────────────────────────────────────────────────────────────
// Shared curve store — set by app.js after every refreshChart()
// ──────────────────────────────────────────────────────────────────

// Precomputed chart curve. Array of { time, Cp, Ce, C2, C3, rate }
// at 10-second resolution, from t=0 to endTime.
let _sharedCurve  = null;
let _curveVersion = 0;   // incremented on every setCurveData call

/**
 * Receive the precomputed chart curve from app.js.
 * Called once per model mutation (after refreshChart).
 */
export function setCurveData(curve) {
  _sharedCurve  = curve;
  _curveVersion++;
  // Invalidate all per-drug approach caches so next frame rescans with fresh data
  for (const cache of Object.values(_approachCache)) {
    cache.computedVersion = -1;
    cache.lockedSsCe      = null;
  }
}

// ──────────────────────────────────────────────────────────────────
// Stability criteria (for "Steady state" display)
// ──────────────────────────────────────────────────────────────────

// Ce must change less than the per-drug drift threshold over a
// SS_WINDOW_MIN window. At 10-second chart resolution, SS_WINDOW_MIN
// = 10 min → 60 samples.
//
// Thresholds are expressed in canonical mcg/mL and chosen to be below
// clinical significance for each drug's therapeutic range:
//   propofol     0.1   mcg/mL  ≈  3% of a typical 3 mcg/mL target
//   fentanyl     0.0001 mcg/mL = 0.1 ng/mL  (range 1–5 ng/mL)
//   remifentanil 0.0001 mcg/mL = 0.1 ng/mL  (range 1–8 ng/mL)
//   ketamine     0.005  mcg/mL = 5   ng/mL  (range 100–4000 ng/mL)
//
// A single absolute threshold (the old 0.1 mcg/mL) latches the very
// first scan sample as "steady state" for fentanyl and ketamine
// because their entire therapeutic Ce range is below that threshold,
// which shows up in the UI as "Steady state ≈ 0.0".
const SS_DRIFT_BY_DRUG = {
  propofol:     0.1,
  fentanyl:     0.0001,
  remifentanil: 0.0001,
  ketamine:     0.005,
};
const SS_DRIFT_DEFAULT = 0.1;     // mcg/mL — fallback for unknown drugs
const SS_WINDOW_MIN    = 10;      // minutes

// Emergence Ce level (mcg/mL). Could become a user setting later.
const EMERGENCE_CE = 1.5;

// ──────────────────────────────────────────────────────────────────
// Per-drug approach cache — keyed by drugId, same shape for every drug.
//   prefix          — HTML label ending with "in " when countdown follows
//   arrivalMin      — absolute elapsed-minutes of arrival (null = no countdown)
//   staticText      — full HTML for no-countdown states
//   lockedSsCe      — Ce shown in label; only reset on pump-state change
//                     (mode/rate/target), not on curve updates, so the
//                     value stays stable while Ce is rapidly changing.
//   computedVersion — _curveVersion at last compute; mismatch → rescan
//   mode/rate/target — pump-state snapshot at last compute
//   curve           — cached PK curve for non-selected drugs (null for selected)
// ──────────────────────────────────────────────────────────────────
const _approachCache = {};

function _getApproachCache(drugId) {
  if (!_approachCache[drugId]) {
    _approachCache[drugId] = {
      prefix: '', arrivalMin: null, staticText: '',
      lockedSsCe: null, computedVersion: -1,
      mode: '', rate: 0, target: 0,
      curve: null,
    };
  }
  return _approachCache[drugId];
}

// ──────────────────────────────────────────────────────────────────
// Init / lifecycle
// ──────────────────────────────────────────────────────────────────

export function init(opts = {}) {
  model                    = opts.model;
  timer                    = opts.timer;
  getMode                  = opts.getMode    || (() => 'none');
  getCeTarget              = opts.getCeTarget || (() => 0);
  getIntermittentThreshold = opts.getIntermittentThreshold || (() => 0);
  getDrugId                = opts.getDrugId      || (() => 'propofol');
  getDrugIds               = opts.getDrugIds     || (() => ['propofol', 'fentanyl', 'ketamine']);
  getModeForDrug                  = opts.getModeForDrug                  || null;
  getIntermittentThresholdForDrug = opts.getIntermittentThresholdForDrug || null;
  getCeTargetForDrug              = opts.getCeTargetForDrug              || null;
  onFrame                         = opts.onFrame                         || null;
  loop();
}

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

/** Format minutes as m:ss  (e.g. 125.4s → "2:05") */
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

/** Returns true when the most recent event at/before t is a bolus. */
function isInBolusPhase(drugId, t) {
  try {
    const events = model.getEvents(drugId);
    for (let i = events.length - 1; i >= 0; i--) {
      if (events[i].time <= t) return events[i].type === 'bolus';
    }
  } catch (e) {}
  return false;
}

/**
 * Format Ce (or Cp) for display in the drug card.
 * Fentanyl Ce is tiny in mcg/mL — display in ng/mL instead (×1000).
 */
function fmtCe(ceMcgMl, drugId) {
  const allowed = getAllowedUnits(drugId, 'ceTarget');
  if (allowed && allowed[0] === 'ng/mL') {
    return (ceMcgMl * 1000).toFixed(1);
  }
  return ceMcgMl.toFixed(2);
}

/** Format rate for inline display next to status label. Returns '' if no rate. */
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
// Curve scanning — approach line computation
// ──────────────────────────────────────────────────────────────────

/**
 * Find when Ce first comes within 0.05 of ceTarget by scanning the given curve.
 * Returns delta-minutes from t, or null if not found.
 */
function _estimateTimeToTarget(curve, t, Ce, ceTarget) {
  if (!curve) return null;
  const approaching = Ce < ceTarget;
  for (const pt of curve) {
    if (pt.time <= t) continue;
    if (approaching  && pt.Ce >= ceTarget - 0.05) return pt.time - t;
    if (!approaching && pt.Ce <= ceTarget + 0.05) return pt.time - t;
  }
  return null;
}

/**
 * Find when Ce stabilises by scanning a curve from the current time.
 *
 * Stability: Ce changes < the per-drug drift threshold over a
 * SS_WINDOW_MIN (10 min) window. At 10-second chart resolution that
 * is 60 samples per window.
 *
 * ssCe is the Ce value AT the stability point — not the distant
 * 2-hour equilibrium. Ce will continue drifting slowly after this
 * point as V3 fills (τ ≈ 246 min for propofol), but at a rate below
 * the threshold and below clinical significance.
 *
 * Returns { ssCe, ssMin } or null.
 */
function _scanSteadyState(curve, t, drugId) {
  if (!curve || curve.length < 2) return null;

  const threshold   = SS_DRIFT_BY_DRUG[drugId] ?? SS_DRIFT_DEFAULT;
  const stepMin     = curve[1].time - curve[0].time;
  const windowSteps = Math.max(1, Math.round(SS_WINDOW_MIN / stepMin));

  // Find start index: first sample at or after t
  let startIdx = 0;
  while (startIdx < curve.length && curve[startIdx].time < t) startIdx++;

  for (let i = startIdx; i + windowSteps < curve.length; i++) {
    const drift = Math.abs(curve[i + windowSteps].Ce - curve[i].Ce);
    if (drift < threshold) {
      return { ssCe: curve[i].Ce, ssMin: curve[i].time - t };
    }
  }
  return null;
}

/**
 * Compute approach line data by scanning the provided curve.
 * Pure array operations — no model calls except predictTrough for emergence/intermittent.
 *
 * curve:       precomputed PK curve for this drug (may be null for modes that don't need it)
 * lockedSsCe: if non-null, use this Ce for the steady-state label instead
 *              of the freshly scanned value. Released on pump-state change.
 *
 * Returns { prefix, arrivalMin, staticText, newLockedSsCe }.
 */
function computeApproachData(drugId, t, m, Ce, ceTarget, rate, lockedSsCe, curve) {
  const noData = { prefix: '', arrivalMin: null, staticText: '', newLockedSsCe: null };

  // Intermittent bolus mode — countdown to redose threshold
  if (m === 'intermittent' && ceTarget > 0) {
    if (Ce <= ceTarget) {
      return { prefix: '', arrivalMin: null, staticText: '<span class="appr-below">Below Threshold</span>', newLockedSsCe: null };
    }
    // Use predictTrough for unlimited lookahead — not limited by chart curve length.
    // Essential for ketamine where Ce decay can extend far beyond the 120-min curve.
    try {
      const result = model.predictTrough(drugId, t, ceTarget);
      if (result && result.time !== null && result.time > t) {
        return { prefix: 'Redose in ', arrivalMin: result.time, staticText: '', newLockedSsCe: null };
      }
    } catch (e) {}
    return { prefix: '', arrivalMin: null, staticText: '', newLockedSsCe: null };
  }

  // Pump stopped — emergence countdown (uses predictTrough; no curve scan needed)
  if (m === 'none' || (rate === 0 && m !== 'tci' && m !== 'intermittent')) {
    if (Ce <= EMERGENCE_CE + 0.05) return noData;
    try {
      const result = model.predictTrough(drugId, t, EMERGENCE_CE);
      if (result && result.time !== null && result.time > t) {
        return {
          prefix: `Emergence <span class="appr-val">${EMERGENCE_CE.toFixed(1)}</span> in `,
          arrivalMin: result.time,
          staticText: '', newLockedSsCe: null,
        };
      }
    } catch (e) {}
    return noData;
  }

  // TCI mode — time to reach target
  if (m === 'tci' && ceTarget > 0) {
    if (Math.abs(Ce - ceTarget) < 0.05) {
      return { prefix: '', arrivalMin: null, newLockedSsCe: null,
        staticText: `At Target <span class="appr-val">${ceTarget.toFixed(1)}</span>` };
    }
    const dt = _estimateTimeToTarget(curve, t, Ce, ceTarget);
    if (dt !== null && dt > 0) {
      return {
        prefix: `Target → <span class="appr-val">${ceTarget.toFixed(1)}</span> in `,
        arrivalMin: t + dt, staticText: '', newLockedSsCe: null,
      };
    }
    return { prefix: '', arrivalMin: null, newLockedSsCe: null,
      staticText: `Target <span class="appr-val">${ceTarget.toFixed(1)}</span>` };
  }

  // Manual infusion — time to steady state
  if (m === 'manual' && rate > 0) {
    const ss = _scanSteadyState(curve, t, drugId);
    if (ss) {
      // lockedSsCe keeps the displayed Ce stable across curve refreshes that
      // occur while Ce is still changing (e.g. during/after a bolus).
      // Released on any pump-state change so the value stays clinically current.
      const displayCe = (lockedSsCe !== null) ? lockedSsCe : ss.ssCe;
      // fmtCe handles per-drug unit conversion (e.g. mcg/mL → ng/mL for
      // fentanyl/ketamine); a raw .toFixed(1) on canonical mcg/mL would
      // display "0.0" for any ng/mL drug.
      const ceStr = `<span class="appr-val">${fmtCe(displayCe, drugId)}</span>`;
      if (ss.ssMin > 0.5) {
        return {
          prefix: `Steady state ≈ ${ceStr} in `,
          arrivalMin: t + ss.ssMin,
          staticText: '', newLockedSsCe: ss.ssCe,
        };
      }
      return { prefix: '', arrivalMin: null, newLockedSsCe: ss.ssCe,
        staticText: `Steady state ≈ ${ceStr}` };
    }
  }

  // TCI paused, Ce above target — time to decay to target
  if (m === 'tci' && rate === 0 && ceTarget > 0 && Ce > ceTarget + 0.1) {
    const dt = _estimateTimeToTarget(curve, t, Ce, ceTarget);
    if (dt !== null && dt > 0) {
      return {
        prefix: `Target → <span class="appr-val">${ceTarget.toFixed(1)}</span> in `,
        arrivalMin: t + dt, staticText: '', newLockedSsCe: null,
      };
    }
  }

  return noData;
}

/**
 * Update approach line for any drug.
 *
 * Rescans when:
 *   a) a new curve has arrived (_curveVersion changed), or
 *   b) the pump state changed (mode / rate / target).
 *
 * For the selected drug the shared chart curve is used. For non-selected
 * drugs in TCI/manual mode a drug-specific curve is computed and cached
 * so that approach estimates reflect that drug's own PK.
 *
 * The countdown renders live every rAF frame from the cached arrivalMin.
 * lockedSsCe is only released on pump-state change, keeping the displayed
 * Ce stable across curve refreshes that occur mid-bolus.
 */
function updateApproachLine(drugId, t, m, Ce, ceTarget, rate) {
  const cache = _getApproachCache(drugId);

  const displayChanged =
    cache.mode   !== m ||
    Math.abs(cache.rate   - rate)     > 0.01 ||
    Math.abs(cache.target - ceTarget) > 0.01;

  const curveChanged = cache.computedVersion !== _curveVersion;

  if (displayChanged || curveChanged) {
    // Resolve the PK curve for this drug.
    // Selected drug uses the precomputed shared curve (free — already computed for chart).
    // Non-selected drugs in TCI/manual mode need their own curve; compute and cache it.
    let curve;
    const isSelected = drugId === (getDrugId ? getDrugId() : null);
    if (isSelected) {
      curve = _sharedCurve;
    } else if (m === 'tci' || m === 'manual') {
      // Extend to at least t + 120 so the steady-state scan has enough
      // forward lookahead at any elapsed time (mirrors the shared chart
      // curve's endTime in refreshChart).
      const endTime = Math.max(120, t + 120);
      try { cache.curve = model.computeCurve(drugId, 0, endTime, 1 / 6); } catch (e) { cache.curve = null; }
      curve = cache.curve;
    } else {
      curve = null;  // emergence / intermittent use predictTrough, no curve needed
    }

    const lockToPass = displayChanged ? null : cache.lockedSsCe;
    const data = computeApproachData(drugId, t, m, Ce, ceTarget, rate, lockToPass, curve);

    cache.prefix          = data.prefix;
    cache.arrivalMin      = data.arrivalMin;
    cache.staticText      = data.staticText;
    cache.computedVersion = _curveVersion;
    cache.mode            = m;
    cache.rate            = rate;
    cache.target          = ceTarget;

    if (displayChanged) cache.lockedSsCe = data.newLockedSsCe;
  }

  // Render countdown live every frame
  let html = '';
  if (cache.arrivalMin !== null) {
    const remaining = cache.arrivalMin - t;
    if (remaining > 0) {
      html = cache.prefix + `<span class="appr-time">${fmtCountdown(remaining)}</span>`;
    } else {
      // Crossed threshold — next curve refresh will trigger a rescan
      cache.computedVersion = -1;
    }
  } else {
    html = cache.staticText;
  }

  // Intermittent countdown is shown in the step-bar row instead
  if (m === 'intermittent' && cache.arrivalMin !== null) html = '';

  const el = $(drugId + '-approach');
  if (el && el.innerHTML !== html) el.innerHTML = html;
}

// ──────────────────────────────────────────────────────────────────
// Step bar + countdown
// ──────────────────────────────────────────────────────────────────

/**
 * Format a short description for the next event shown in the step bar.
 * Returns null for system events (bare countdown only) or on error.
 * Respects the user's persisted unit preference (same as fmtRateInline).
 */
function fmtNextEvtLabel(evt, drugId) {
  if (!evt || evt.source === 'system') return null;
  try {
    if (evt.type === 'pause' || (evt.type === 'rate' && evt.value === 0)) {
      return 'Pause';
    }
    const ctx = { weightKg: model.getPatient().weight };
    if (evt.type === 'rate') {
      const prefKey = getPrefKey(drugId, 'rate');
      let unit = getDefaultUnit(drugId, 'rate');
      if (prefKey) {
        try {
          const saved = localStorage.getItem(prefKey);
          const allowed = getAllowedUnits(drugId, 'rate');
          if (saved && allowed.includes(saved)) unit = saved;
        } catch (e) {}
      }
      const v = fromCanonical(evt.value, unit, drugId, 'rate', ctx);
      return `Rate \u2192 ${formatValue(v, unit)} ${unit}`;
    }
    if (evt.type === 'bolus') {
      const prefKey = getPrefKey(drugId, 'bolus');
      let unit = getDefaultUnit(drugId, 'bolus');
      if (prefKey) {
        try {
          const saved = localStorage.getItem(prefKey);
          const allowed = getAllowedUnits(drugId, 'bolus');
          if (saved && allowed.includes(saved)) unit = saved;
        } catch (e) {}
      }
      const v = fromCanonical(evt.value, unit, drugId, 'bolus', ctx);
      const label = evt.deliveryMode === 'push' ? 'IV Push' : 'Bolus';
      return `${label} ${formatValue(v, unit)} ${unit}`;
    }
  } catch (e) {}
  return null;
}

/**
 * Bar fill % for intermittent redose countdown.
 * Counts from the last bolus time (0%) to the predicted threshold crossing (100%).
 */
function _intermittentBarPct(drugId, t, arrivalMin) {
  if (!arrivalMin || arrivalMin <= t) return 100;
  let prevTime = 0;
  try {
    const evts = model.getEvents(drugId);
    for (let i = evts.length - 1; i >= 0; i--) {
      if (evts[i].time <= t + 0.0001) { prevTime = evts[i].time; break; }
    }
  } catch(e) {}
  const total = arrivalMin - prevTime;
  const elapsed = t - prevTime;
  return total > 0 ? Math.min(100, Math.max(0, (elapsed / total) * 100)) : 0;
}

function updateStepBar(drugId, t) {
  const barEl       = $(drugId + '-bar');
  const countdownEl = $(drugId + '-bar-countdown');
  if (!barEl || !countdownEl) return;

  try {
    const events = model.getEvents(drugId);
    let nextEvt = null;
    for (const e of events) {
      if (e.time > t + 0.0001) { nextEvt = e; break; }
    }
    if (!nextEvt) {
      barEl.style.width = '0%';
      countdownEl.textContent = '';
      return;
    }

    let prevTime = 0;
    for (let i = events.length - 1; i >= 0; i--) {
      if (events[i].time <= t + 0.0001) { prevTime = events[i].time; break; }
    }

    const span      = nextEvt.time - prevTime;
    const elapsed   = t - prevTime;
    const pct       = span > 0 ? Math.min(100, Math.max(0, (elapsed / span) * 100)) : 0;
    const remaining = nextEvt.time - t;

    barEl.style.width = pct + '%';
    if (remaining > 0) {
      const label = fmtNextEvtLabel(nextEvt, drugId);
      const timeStr = `<span class="appr-time">${fmtCountdown(remaining)}</span>`;
      const html = label ? `${label} in ${timeStr}` : timeStr;
      if (countdownEl.innerHTML !== html) countdownEl.innerHTML = html;
    } else {
      if (countdownEl.innerHTML !== '') countdownEl.innerHTML = '';
    }
  } catch (e) {
    barEl.style.width = '0%';
    if (countdownEl) countdownEl.innerHTML = '';
  }
}

// ──────────────────────────────────────────────────────────────────
// Main update
// ──────────────────────────────────────────────────────────────────

function update() {
  if (!model || !timer) return;

  const t           = timer.getElapsedMinutes();
  const caseStarted = timer.isRunning() || t > 0;
  const allDrugs    = getDrugIds ? getDrugIds() : [getDrugId()];

  for (const dId of allDrugs) {
    const m        = getModeForDrug ? getModeForDrug(dId) : 'none';
    // For the approach line and warnings, ceTarget is the TCI target or the
    // intermittent redose threshold, whichever is active for this drug.
    const ceTarget = m === 'intermittent'
      ? (getIntermittentThresholdForDrug ? getIntermittentThresholdForDrug(dId) : 0)
      : (getCeTargetForDrug              ? getCeTargetForDrug(dId)              : 0);

    let Ce = 0, Cp = 0, rate = 0, bis = null;
    if (caseStarted && t > 0) {
      try {
        const conc = model.getConcentrationsAt(dId, t);
        Ce = conc.Ce; Cp = conc.Cp; rate = conc.rate;
        try { bis = model.predictBIS(dId, t); } catch (e) {}
      } catch (e) {}
    }

    // ── Ce / Cp ──────────────────────────────────────────────────
    const ceEl = $(dId + '-ce');
    const cpEl = $(dId + '-cp');
    if (ceEl) ceEl.textContent = fmtCe(Ce, dId);
    if (cpEl) cpEl.textContent = fmtCe(Cp, dId);

    // ── Approach line ─────────────────────────────────────────────
    if (caseStarted) {
      updateApproachLine(dId, t, m, Ce, ceTarget, rate);
      warnings.checkBelowThreshold(dId, m === 'intermittent' && ceTarget > 0 && Ce <= ceTarget);
    } else {
      const el = $(dId + '-approach');
      if (el) el.innerHTML = '';
    }

    // ── Status + rate ─────────────────────────────────────────────
    const statusEl = $(dId + '-status');
    const rateEl   = $(dId + '-rate');

    if (statusEl) {
      let label = 'Stopped', cls = 'stopped';
      if (!caseStarted || m === 'none') {
        label = 'Stopped'; cls = 'stopped';
      } else if (m === 'intermittent') {
        if (isInBolusPhase(dId, t) || rate > 50) { label = 'Bolus'; cls = 'bolus'; }
        else { label = ''; cls = ''; }
      } else if (rate === 0) {
        label = 'Paused'; cls = 'paused';
      } else if (isInBolusPhase(dId, t) || rate > 50) {
        label = 'Bolus'; cls = 'bolus';
      } else {
        label = 'Infusing'; cls = 'infusing';
      }
      statusEl.textContent = label;
      statusEl.className   = 'drug-status ' + cls;
    }

    if (rateEl) {
      rateEl.textContent = (caseStarted && rate > 0 && m !== 'intermittent')
        ? fmtRateInline(dId, rate) : '';
    }

    // ── eBIS (propofol-only DOM elements; null for other drugs) ──
    const bisEl    = $(dId + '-bis');
    const bisLabel = $(dId + '-bis-label');
    const bisSep   = $(dId + '-bis-sep');
    if (bisEl) {
      const bisVis = bis !== null && caseStarted && t > 0;
      bisEl.textContent = bisVis ? bis.toFixed(0) : '';
      bisEl.style.color = bisVis ? bisColor(bis) : '';
      if (bisLabel) bisLabel.style.display = bisVis ? '' : 'none';
      if (bisSep)   bisSep.style.display   = bisVis ? '' : 'none';
    }

    // ── Step bar ──────────────────────────────────────────────────
    if (caseStarted) {
      if (m !== 'intermittent') {
        updateStepBar(dId, t);
      } else {
        // Intermittent: during bolus delivery show progress normally;
        // after delivery show the redose countdown from the approach cache.
        const barEl = $(dId + '-bar');
        const cntEl = $(dId + '-bar-countdown');
        let hasNextEvt = false;
        try { hasNextEvt = model.getEvents(dId).some(e => e.time > t + 0.0001); } catch (e) {}

        const cache = _getApproachCache(dId);
        if (hasNextEvt) {
          updateStepBar(dId, t);
          barEl?.parentElement?.classList.remove('step-bar-below');
        } else if (cache.arrivalMin !== null) {
          const rem = cache.arrivalMin - t;
          barEl?.parentElement?.classList.remove('step-bar-below');
          if (barEl) barEl.style.width = _intermittentBarPct(dId, t, cache.arrivalMin) + '%';
          if (cntEl) {
            const newHtml = rem > 0
              ? `Redose in <span class="appr-time">${fmtCountdown(rem)}</span>` : '';
            if (cntEl.innerHTML !== newHtml) cntEl.innerHTML = newHtml;
          }
        } else {
          barEl?.parentElement?.classList.add('step-bar-below');
          if (barEl) barEl.style.width = '0%';
          if (cntEl && cntEl.innerHTML !== '') cntEl.innerHTML = '';
        }
      }
    }

    // ── Right-side status indicator ───────────────────────────────
    const cardEl = document.getElementById('drug-' + dId);
    if (cardEl) {
      let status = 'off';
      if (caseStarted && m !== 'none') {
        if (m === 'intermittent' && ceTarget > 0 && Ce <= ceTarget) {
          status = 'alert';                      // below redose threshold
        } else if (rate === 0 && m !== 'intermittent') {
          status = 'alert';                      // pump paused / stopped
        } else {
          const warnMin = warnings.getSettings().statusWarnMinutes ?? 2;
          let isWarn = false;
          // Next scheduled manual event (rate change, bolus, pause, TCI step)
          try {
            const evts    = model.getEvents(dId);
            const nextEvt = evts.find(e => e.time > t + 0.0001 && e.source !== 'system');
            if (nextEvt && (nextEvt.time - t) <= warnMin) isWarn = true;
          } catch (e) {}
          // Intermittent redose due within warn window
          if (!isWarn && m === 'intermittent') {
            const cache = _getApproachCache(dId);
            if (cache.arrivalMin !== null && (cache.arrivalMin - t) <= warnMin) isWarn = true;
          }
          status = isWarn ? 'warn' : 'ok';
        }
      }
      if (cardEl.dataset.status !== status) cardEl.dataset.status = status;
    }
  }

  // ── Notify app.js for chart cursor ─────────────────────────────
  if (onFrame) onFrame(t);
}

/** Force an immediate update (after a model mutation). */
export function forceUpdate() {
  for (const cache of Object.values(_approachCache)) {
    cache.computedVersion = -1;
    cache.lockedSsCe      = null;
  }
  update();
}
