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
  // Invalidate approach cache so next frame rescans with fresh data
  _approachCache.computedVersion = -1;
  _approachCache.lockedSsCe      = null;
}

// ──────────────────────────────────────────────────────────────────
// Stability criteria (for "Steady state" display)
// ──────────────────────────────────────────────────────────────────

// Ce must change less than SS_DRIFT_THRESHOLD over a SS_WINDOW_MIN window.
// At 10-second chart resolution, SS_WINDOW_MIN = 10 min → 60 samples.
// A 0.1 mcg/mL change over 10 minutes (0.01 mcg/mL/min) is below the
// noise floor of any clinical monitor and below clinical significance
// for moment-to-moment dosing decisions.
const SS_DRIFT_THRESHOLD = 0.1;   // mcg/mL
const SS_WINDOW_MIN      = 10;    // minutes

// Emergence Ce level (mcg/mL). Could become a user setting later.
const EMERGENCE_CE = 1.5;

// ──────────────────────────────────────────────────────────────────
// Approach line cache (selected drug)
//   prefix          — HTML label ending with "in " when countdown follows
//   arrivalMin      — absolute elapsed-minutes of arrival (null = no countdown)
//   staticText      — full HTML for no-countdown states
//   lockedSsCe      — Ce shown in label; only reset on pump-state change
//                     (mode/rate/target), not on curve updates, so the
//                     value stays stable while Ce is rapidly changing.
//   computedVersion — _curveVersion at last compute; mismatch → rescan
//   mode/rate/target — pump-state snapshot at last compute
// ──────────────────────────────────────────────────────────────────
let _approachCache = {
  prefix: '', arrivalMin: null, staticText: '',
  lockedSsCe: null,
  computedVersion: -1,
  mode: '', rate: 0, target: 0,
};

// Per-drug cache for non-selected intermittent approach/bar countdown.
// Avoids calling predictTrough every rAF frame — invalidates only when
// the event count changes (i.e. after a new bolus or a reset).
// Format: { [drugId]: { arrivalMin: number|null, eventCount: number } }
const _nonSelectedCache = {};

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
 * Find when Ce first comes within 0.05 of ceTarget by scanning _sharedCurve.
 * Returns delta-minutes from t, or null if not found.
 */
function estimateTimeToTarget(t, Ce, ceTarget) {
  if (!_sharedCurve) return null;
  const approaching = Ce < ceTarget;
  for (const pt of _sharedCurve) {
    if (pt.time <= t) continue;
    if (approaching  && pt.Ce >= ceTarget - 0.05) return pt.time - t;
    if (!approaching && pt.Ce <= ceTarget + 0.05) return pt.time - t;
  }
  return null;
}

/**
 * Find when Ce first drops AT OR BELOW ceTarget by scanning _sharedCurve.
 * Used for intermittent mode where Ce is always above threshold when counting
 * down — avoids the fixed ±0.05 tolerance that breaks for small fentanyl values.
 * Returns delta-minutes from t, or null if not found.
 */
function estimateTimeToThreshold(t, ceTarget) {
  if (!_sharedCurve) return null;
  for (const pt of _sharedCurve) {
    if (pt.time <= t) continue;
    if (pt.Ce <= ceTarget) return pt.time - t;
  }
  return null;
}

/**
 * Find when Ce stabilises by scanning _sharedCurve from current time.
 *
 * Stability: Ce changes < SS_DRIFT_THRESHOLD (0.1 mcg/mL) over a
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
function estimateSteadyState(t) {
  if (!_sharedCurve || _sharedCurve.length < 2) return null;

  const stepMin     = _sharedCurve[1].time - _sharedCurve[0].time;
  const windowSteps = Math.max(1, Math.round(SS_WINDOW_MIN / stepMin));

  // Find start index: first sample at or after t
  let startIdx = 0;
  while (startIdx < _sharedCurve.length && _sharedCurve[startIdx].time < t) startIdx++;

  for (let i = startIdx; i + windowSteps < _sharedCurve.length; i++) {
    const drift = Math.abs(_sharedCurve[i + windowSteps].Ce - _sharedCurve[i].Ce);
    if (drift < SS_DRIFT_THRESHOLD) {
      return { ssCe: _sharedCurve[i].Ce, ssMin: _sharedCurve[i].time - t };
    }
  }
  return null;
}

/**
 * Compute approach line data by scanning the shared curve.
 * Pure array operations — no model calls except predictTrough for emergence.
 *
 * lockedSsCe: if non-null, use this Ce for the steady-state label instead
 *   of the freshly scanned value. Released on pump-state change.
 *
 * Returns { prefix, arrivalMin, staticText, newLockedSsCe }.
 */
function computeApproachData(drugId, t, m, Ce, ceTarget, rate, lockedSsCe) {
  const noData = { prefix: '', arrivalMin: null, staticText: '', newLockedSsCe: null };

  // Intermittent bolus mode — countdown to redose threshold
  if (m === 'intermittent' && ceTarget > 0) {
    if (Ce <= ceTarget) {
      return { prefix: '', arrivalMin: null, staticText: 'Redose now', newLockedSsCe: null };
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
    const dt = estimateTimeToTarget(t, Ce, ceTarget);
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
    const ss = estimateSteadyState(t);
    if (ss) {
      // lockedSsCe keeps the displayed Ce stable across curve refreshes that
      // occur while Ce is still changing (e.g. during/after a bolus).
      // Released on any pump-state change so the value stays clinically current.
      const displayCe = (lockedSsCe !== null) ? lockedSsCe : ss.ssCe;
      const ceStr = `<span class="appr-val">${displayCe.toFixed(1)}</span>`;
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
    const dt = estimateTimeToTarget(t, Ce, ceTarget);
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
 * Update approach line.
 *
 * Rescans the shared curve when:
 *   a) a new curve has arrived (_curveVersion changed), or
 *   b) the pump state changed (mode / rate / target).
 *
 * The countdown renders live every rAF frame from the cached arrivalMin.
 * lockedSsCe is only released on pump-state change, keeping the displayed
 * Ce stable across curve refreshes that occur mid-bolus.
 */
function updateApproachLine(drugId, t, m, Ce, ceTarget, rate) {
  const displayChanged =
    _approachCache.mode   !== m ||
    Math.abs(_approachCache.rate   - rate)     > 0.01 ||
    Math.abs(_approachCache.target - ceTarget) > 0.01;

  const curveChanged = _approachCache.computedVersion !== _curveVersion;

  if (displayChanged || curveChanged) {
    const lockToPass = displayChanged ? null : _approachCache.lockedSsCe;
    const data = computeApproachData(drugId, t, m, Ce, ceTarget, rate, lockToPass);

    _approachCache.prefix          = data.prefix;
    _approachCache.arrivalMin      = data.arrivalMin;
    _approachCache.staticText      = data.staticText;
    _approachCache.computedVersion = _curveVersion;
    _approachCache.mode            = m;
    _approachCache.rate            = rate;
    _approachCache.target          = ceTarget;

    if (displayChanged) _approachCache.lockedSsCe = data.newLockedSsCe;
  }

  // Render countdown live every frame
  let html = '';
  if (_approachCache.arrivalMin !== null) {
    const remaining = _approachCache.arrivalMin - t;
    if (remaining > 0) {
      html = _approachCache.prefix +
        `<span class="appr-time">${fmtCountdown(remaining)}</span>`;
    } else {
      // Crossed threshold — next curve refresh will trigger a rescan
      _approachCache.computedVersion = -1;
    }
  } else {
    html = _approachCache.staticText;
  }

  const el = $(drugId + '-approach');
  if (el && el.innerHTML !== html) el.innerHTML = html;
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

    barEl.style.width       = pct + '%';
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

  const drugId      = getDrugId();
  const t           = timer.getElapsedMinutes();
  const m           = getMode();
  const ceTarget    = getCeTarget();
  const caseStarted = timer.isRunning() || t > 0;

  // ── Update ALL drug tiles (not just selected) ───────────────────
  // Non-selected tiles get Ce/Cp, status label, and step-bar updates
  // so they stay live when a case starts without requiring a click.
  const allDrugs = getDrugIds ? getDrugIds() : [drugId];
  for (const dId of allDrugs) {
    if (dId === drugId) continue;  // selected drug gets full update below
    const ceEl2    = $(dId + '-ce');
    const cpEl2    = $(dId + '-cp');
    const statusEl2 = $(dId + '-status');
    if (!ceEl2 && !cpEl2 && !statusEl2) continue;

    if (!caseStarted || t <= 0) {
      if (ceEl2) ceEl2.textContent = fmtCe(0, dId);
      if (cpEl2) cpEl2.textContent = fmtCe(0, dId);
      if (statusEl2) { statusEl2.textContent = 'Stopped'; statusEl2.className = 'drug-status stopped'; }
      continue;
    }
    try {
      const conc  = model.getConcentrationsAt(dId, t);
      if (ceEl2) ceEl2.textContent = fmtCe(conc.Ce, dId);
      if (cpEl2) cpEl2.textContent = fmtCe(conc.Cp, dId);

      // Status label
      const dMode = getModeForDrug ? getModeForDrug(dId) : 'none';
      const dRate = conc.rate;
      let dLabel = 'Stopped', dCls = 'stopped';
      if (dMode === 'none') {
        dLabel = 'Stopped'; dCls = 'stopped';
      } else if (dMode === 'intermittent') {
        if (isInBolusPhase(dId, t) || dRate > 50) { dLabel = 'Bolus'; dCls = 'bolus'; }
        else { dLabel = ''; dCls = ''; }
      } else if (dRate === 0) {
        dLabel = 'Paused'; dCls = 'paused';
      } else if (isInBolusPhase(dId, t) || dRate > 50) {
        dLabel = 'Bolus'; dCls = 'bolus';
      } else {
        dLabel = 'Infusing'; dCls = 'infusing';
      }
      if (statusEl2) { statusEl2.textContent = dLabel; statusEl2.className = 'drug-status ' + dCls; }

      // Step-bar + approach line for non-selected drug
      const approachEl2 = $(dId + '-approach');
      if (dMode !== 'intermittent') {
        updateStepBar(dId, t);
        if (approachEl2 && approachEl2.innerHTML !== '') approachEl2.innerHTML = '';
      } else {
        // Intermittent: show bolus progress or redose countdown
        const barEl2 = $(dId + '-bar');
        const cntEl2 = $(dId + '-bar-countdown');
        let hasNextEvt2 = false;
        let evtCount2 = 0;
        try {
          const evts2 = model.getEvents(dId);
          evtCount2 = evts2.length;
          hasNextEvt2 = evts2.some(e => e.time > t + 0.0001);
        } catch (e2) {}

        if (hasNextEvt2) {
          updateStepBar(dId, t);
          if (approachEl2 && approachEl2.innerHTML !== '') approachEl2.innerHTML = '';
        } else {
          if (barEl2) barEl2.style.width = '0%';
          let cntText = '';
          let approachHtml = '';
          if (getIntermittentThresholdForDrug) {
            const thr = getIntermittentThresholdForDrug(dId);
            if (thr > 0) {
              if (conc.Ce <= thr) {
                cntText = 'Redose now';
                approachHtml = 'Redose now';
              } else {
                // Use cached arrivalMin to avoid calling predictTrough every frame.
                // Invalidate only when the event list changes (new bolus, reset, etc.).
                const cached = _nonSelectedCache[dId];
                let arrivalMin = null;
                if (cached && cached.eventCount === evtCount2 &&
                    cached.arrivalMin !== null && cached.arrivalMin > t) {
                  arrivalMin = cached.arrivalMin;
                } else {
                  try {
                    const res = model.predictTrough(dId, t, thr);
                    if (res && res.time > t) arrivalMin = res.time;
                  } catch (e2) {}
                  _nonSelectedCache[dId] = { arrivalMin, eventCount: evtCount2 };
                }
                if (arrivalMin !== null) {
                  const rem = arrivalMin - t;
                  if (rem > 0) {
                    const fmtd = fmtCountdown(rem);
                    cntText = fmtd;
                    approachHtml = `Redose in <span class="appr-time">${fmtd}</span>`;
                  }
                }
              }
            }
          }
          if (cntEl2) cntEl2.textContent = cntText;
          if (approachEl2 && approachEl2.innerHTML !== approachHtml) approachEl2.innerHTML = approachHtml;
        }
      }
    } catch (e) {}
  }

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

  // ── Ce display (unit-aware: ng/mL for fentanyl, mcg/mL otherwise) ─
  const ceEl = $(drugId + '-ce');
  if (ceEl) ceEl.textContent = fmtCe(Ce, drugId);

  // ── Cp display ──────────────────────────────────────────────────
  const cpEl = $(drugId + '-cp');
  if (cpEl) cpEl.textContent = fmtCe(Cp, drugId);

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
    } else if (m === 'intermittent') {
      // Intermittent (bolus-only) mode: show only during active bolus, blank otherwise
      if (isInBolusPhase(drugId, t) || rate > 50) {
        label = 'Bolus'; cls = 'bolus';
      } else {
        label = ''; cls = '';
      }
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
    // Never show rate in intermittent mode — no pump
    rateEl.textContent = (caseStarted && rate > 0 && m !== 'intermittent') ? fmtRateInline(drugId, rate) : '';
  }

  // ── eBIS ─────────────────────────────────────────────────────────
  const bisEl    = $(drugId + '-bis');
  const bisLabel = $(drugId + '-bis-label');
  const bisSep   = $(drugId + '-bis-sep');
  const bisVis   = bis !== null && caseStarted && t > 0;
  if (bisEl) {
    bisEl.textContent  = bisVis ? bis.toFixed(0) : '';
    bisEl.style.color  = bisVis ? bisColor(bis) : '';
  }
  if (bisLabel) bisLabel.style.display = bisVis ? '' : 'none';
  if (bisSep)   bisSep.style.display   = bisVis ? '' : 'none';

  // ── Step bar + countdown ────────────────────────────────────────
  if (caseStarted) {
    if (m !== 'intermittent') {
      updateStepBar(drugId, t);
    } else {
      // Intermittent mode: during bolus delivery show progress normally;
      // after delivery show the redose countdown from the approach cache.
      const barEl = $(drugId + '-bar');
      const cntEl = $(drugId + '-bar-countdown');
      let hasNextEvt = false;
      try {
        const evts = model.getEvents(drugId);
        hasNextEvt = evts.some(e => e.time > t + 0.0001);
      } catch (e) {}

      if (hasNextEvt) {
        updateStepBar(drugId, t);                     // bolus delivery in progress
      } else if (_approachCache.arrivalMin !== null) {
        const rem = _approachCache.arrivalMin - t;
        if (barEl) barEl.style.width = '0%';
        if (cntEl) cntEl.textContent = rem > 0 ? fmtCountdown(rem) : '';
      } else {
        if (barEl) barEl.style.width = '0%';
        if (cntEl) cntEl.textContent = '';
      }
    }
  }

  // ── Notify app.js for chart cursor ─────────────────────────────
  if (onFrame) onFrame(t);
}

/** Force an immediate update (after a model mutation). */
export function forceUpdate() {
  _approachCache.computedVersion = -1;
  _approachCache.lockedSsCe      = null;
  update();
}
