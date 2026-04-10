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
import * as settings from './settings.js';

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
let getExitCeForDrug                  = null;   // (drugId) => Exit Ce threshold (mcg/mL canonical)
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
    cache.computedVersion  = -1;
    cache.lockedSsCeSS     = null;
    cache.lockedPlateauCe  = null;
  }
}

// ──────────────────────────────────────────────────────────────────
// Convergence tolerance (for "Steady state" and "Target → X" labels)
// ──────────────────────────────────────────────────────────────────
//
// Manual mode uses two independent analyses:
//   1. Analytical SS: true Ce_ss via −A⁻¹·B·rate, time to reach 95%
//   2. Plateau: slope-based entry + slope reversal + band-based exit
//
// TCI mode uses a relative-tolerance curve scan for "Target → X".
// The two tolerances are split because the modes operate on completely
// different timescales.

// Emergence Ce level (mcg/mL). Could become a user setting later.
const EMERGENCE_CE = 1.5;

// Fallback values when no getter is wired. Match the DEFAULTS in
// settings.js (tciFraction: 0.95, ssSlopeTol: 0.0010).
const TCI_FRACTION_DEFAULT = 0.95;
const SS_SLOPE_DEFAULT     = 0.0010;
const EXIT_BAND_DEFAULT    = 0.05;

let getTciFraction = () => TCI_FRACTION_DEFAULT;
let getSsSlopeTol  = () => SS_SLOPE_DEFAULT;
let getSsExitBand  = () => EXIT_BAND_DEFAULT;

// ──────────────────────────────────────────────────────────────────
// Per-drug approach cache — keyed by drugId, same shape for every drug.
//
// Manual mode stores TWO independent results:
//   ssPrefix/ssArrivalMin/ssStaticText   — analytical steady-state line
//   platPrefix/platArrivalMin/platStaticText — plateau line (slope reversal)
//
// TCI/intermittent modes use a single prefix/arrivalMin/staticText as before.
//
// lockedSsCeSS   — locked Ce_ss for SS line (released on pump-state change)
// lockedPlateauCe — locked plateau Ce for plateau line (same pattern)
// lockedExitMin  — locked exit time for plateau exit countdown
// ssLine         — Ce_ss value for chart horizontal SS line annotation
// ──────────────────────────────────────────────────────────────────
const _approachCache = {};

function _getApproachCache(drugId) {
  if (!_approachCache[drugId]) {
    _approachCache[drugId] = {
      // Single-line modes (TCI, intermittent, emergence)
      prefix: '', arrivalMin: null, staticText: '',
      // Manual mode: SS line (line 1)
      ssPrefix: '', ssArrivalMin: null, ssStaticText: '',
      lockedSsCeSS: null,
      ssLine: null,   // Ce_ss for chart annotation
      // Manual mode: plateau line (line 2)
      platPrefix: '', platArrivalMin: null, platStaticText: '',
      lockedPlateauCe: null, lockedExitMin: null,
      plateauRegion: null,
      // Cache invalidation
      computedVersion: -1,
      mode: '', rate: 0, target: 0,
      ssSlopeTol: 0, tciFraction: 0, exitBandPct: 0,
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
  getExitCeForDrug                = opts.getExitCeForDrug                || (() => 0);
  onFrame                         = opts.onFrame                         || null;
  getTciFraction                  = opts.getTciFraction                  || (() => TCI_FRACTION_DEFAULT);
  getSsSlopeTol                   = opts.getSsSlopeTol                   || (() => SS_SLOPE_DEFAULT);
  getSsExitBand                   = opts.getSsExitBand                   || (() => EXIT_BAND_DEFAULT);
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
 * Find when Ce first enters a (1 − fraction) tolerance band around ceTarget
 * by scanning the given curve. Returns delta-minutes from t, or null if not
 * found within the curve. Exported for tests.
 *
 * The tolerance is relative, so the same fraction value works for
 * mcg/mL-scale drugs (propofol) and ng/mL-scale drugs (fentanyl,
 * remifentanil) without a drug-specific magic number.
 */
export function _estimateTimeToTarget(curve, t, Ce, ceTarget, fraction) {
  if (!curve) return null;
  if (!(ceTarget > 0)) return null;
  const tol = (1 - fraction) * ceTarget;
  const approaching = Ce < ceTarget;
  for (const pt of curve) {
    if (pt.time <= t) continue;
    if (approaching  && pt.Ce >= ceTarget - tol) return pt.time - t;
    if (!approaching && pt.Ce <= ceTarget + tol) return pt.time - t;
  }
  return null;
}

/**
 * Compute approach line data.
 *
 * For manual mode, returns TWO independent results (SS + plateau).
 * For TCI/intermittent/emergence, returns a single-line result in prefix/arrivalMin/staticText.
 *
 * Returns { prefix, arrivalMin, staticText,
 *           ssPrefix, ssArrivalMin, ssStaticText, newLockedSsCeSS, ssLine,
 *           platPrefix, platArrivalMin, platStaticText, newLockedPlateauCe, newLockedExitMin, plateauRegion }.
 */
function computeApproachData(drugId, t, m, Ce, ceTarget, rate, lockedSsCeSS, lockedPlateauCe, lockedExitMin, curve, ssSlopeTol, tciFraction, exitBandPct) {
  const noData = { prefix: '', arrivalMin: null, staticText: '',
    ssPrefix: '', ssArrivalMin: null, ssStaticText: '',
    newLockedSsCeSS: null, ssLine: null,
    platPrefix: '', platArrivalMin: null, platStaticText: '',
    newLockedPlateauCe: null, newLockedExitMin: null, plateauRegion: null };

  // Redose threshold — compute countdown whenever threshold is set.
  // For threshold-only (no infusion): return single-line redose data.
  // For combined (infusion + threshold): store redose in prefix/arrivalMin
  // and fall through to the manual SS/plateau analysis.
  const threshold = getIntermittentThresholdForDrug ? getIntermittentThresholdForDrug(drugId) : 0;
  if (threshold > 0 && ceTarget > 0) {
    let redose = null;
    if (Ce <= ceTarget) {
      const ceStr = `<span class="appr-val">${fmtCe(ceTarget, drugId)}</span>`;
      redose = { staticText: `<span class="appr-below">Below Threshold ${ceStr}</span>` };
    } else {
      try {
        const result = model.predictTrough(drugId, t, ceTarget);
        if (result && result.time !== null && result.time > t) {
          const ceStr = `<span class="appr-val">${fmtCe(ceTarget, drugId)}</span>`;
          redose = { prefix: `Threshold ${ceStr} in `, arrivalMin: result.time };
        }
      } catch (e) {}
    }
    // Threshold-only (no infusion running): return redose as the sole result
    if (!(m === 'manual' && rate > 0)) {
      return { ...noData, ...(redose || {}) };
    }
    // Combined (infusion + threshold): attach redose data, then fall through
    // to SS/plateau analysis which populates ss*/plat* fields
    if (redose) {
      noData.prefix = redose.prefix || '';
      noData.arrivalMin = redose.arrivalMin || null;
      noData.staticText = redose.staticText || '';
    }
  }

  // Pump stopped — emergence countdown (uses predictTrough; no curve scan needed)
  if ((m === 'none' || (rate === 0 && m !== 'tci')) && threshold === 0) {
    const emergenceCe = (getExitCeForDrug && getExitCeForDrug(drugId) > 0)
      ? getExitCeForDrug(drugId) : EMERGENCE_CE;
    if (Ce <= emergenceCe + 0.05) return noData;
    try {
      const result = model.predictTrough(drugId, t, emergenceCe);
      if (result && result.time !== null && result.time > t) {
        const label = (getExitCeForDrug && getExitCeForDrug(drugId) > 0) ? 'Exit' : 'Emergence';
        return { ...noData,
          prefix: `${label} <span class="appr-val">${emergenceCe.toFixed(1)}</span> in `,
          arrivalMin: result.time,
        };
      }
    } catch (e) {}
    return noData;
  }

  // TCI mode — time to reach target. Tolerance is relative to target so
  // ng/mL-scale drugs don't latch the first sample as "at target".
  if (m === 'tci' && ceTarget > 0) {
    const relDev = Math.abs(Ce - ceTarget) / ceTarget;
    if (relDev <= (1 - tciFraction)) {
      return { ...noData,
        staticText: `At Target <span class="appr-val">${ceTarget.toFixed(1)}</span>` };
    }
    const dt = _estimateTimeToTarget(curve, t, Ce, ceTarget, tciFraction);
    if (dt !== null && dt > 0) {
      return { ...noData,
        prefix: `Target → <span class="appr-val">${ceTarget.toFixed(1)}</span> in `,
        arrivalMin: t + dt,
      };
    }
    return { ...noData,
      staticText: `Target <span class="appr-val">${ceTarget.toFixed(1)}</span>` };
  }

  // Manual infusion — two independent analyses: SS + plateau
  if (m === 'manual' && rate > 0) {
    const result = { ...noData };

    // ── Line 1: Analytical Steady State ──
    let ssResult = null;
    try { ssResult = model.predictSteadyState(drugId, t, rate); } catch (e) {}
    if (ssResult) {
      const displayCe = (lockedSsCeSS !== null) ? lockedSsCeSS : ssResult.ceSS;
      const ceStr = `<span class="appr-val">${fmtCe(displayCe, drugId)}</span>`;
      result.ssLine = ssResult.ceSS;
      result.newLockedSsCeSS = ssResult.ceSS;

      if (!ssResult.reachable) {
        result.ssStaticText = `Steady State ${ceStr} &gt;6h`;
      } else if (ssResult.timeToSsMin > 0.5) {
        result.ssPrefix = `Steady State ${ceStr} in `;
        result.ssArrivalMin = t + ssResult.timeToSsMin;
      } else {
        result.ssStaticText = `Steady State ${ceStr}`;
      }
    }

    // ── Line 2: Plateau (requires slope reversal) ──
    let platResult = null;
    try { platResult = model.predictPlateau(drugId, t, rate, ssSlopeTol, { exitBandPct }); } catch (e) {}
    if (platResult && !platResult.noPlateau) {
      const displayCe = (lockedPlateauCe !== null) ? lockedPlateauCe : platResult.plateauCe;
      const ceStr = `<span class="appr-val">${fmtCe(displayCe, drugId)}</span>`;
      result.newLockedPlateauCe = platResult.plateauCe;

      // Build chart plateau region (Ce values in canonical mcg/mL)
      const region = {
        startMin: t + platResult.entryMin,
        endMin:   platResult.exitMin !== null ? t + platResult.exitMin : null,
        ceMin:    platResult.bandLow,
        ceMax:    platResult.bandHigh,
      };
      result.plateauRegion = region;

      if (platResult.entryMin > 0.5) {
        result.platPrefix = `Plateau ≈ ${ceStr} in `;
        result.platArrivalMin = t + platResult.entryMin;
      } else if (platResult.exitMin !== null && platResult.exitMin > 0.5) {
        const exitAbs = lockedExitMin !== null ? lockedExitMin : t + platResult.exitMin;
        result.platPrefix = 'Exit Plateau in ';
        result.platArrivalMin = exitAbs;
        result.newLockedExitMin = t + platResult.exitMin;
      } else {
        result.platStaticText = `Plateau ≈ ${ceStr}`;
      }
    }

    return result;
  }

  // TCI paused, Ce above target — time to decay to target
  if (m === 'tci' && rate === 0 && ceTarget > 0 && Ce > ceTarget * (1 + (1 - tciFraction))) {
    const dt = _estimateTimeToTarget(curve, t, Ce, ceTarget, tciFraction);
    if (dt !== null && dt > 0) {
      return { ...noData,
        prefix: `Target → <span class="appr-val">${ceTarget.toFixed(1)}</span> in `,
        arrivalMin: t + dt,
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
  const ssSlopeTol  = getSsSlopeTol();
  const tciFraction = getTciFraction();
  const exitBandPct = getSsExitBand();

  const displayChanged =
    cache.mode   !== m ||
    Math.abs(cache.rate   - rate)     > 0.01 ||
    Math.abs(cache.target - ceTarget) > 0.01 ||
    Math.abs(cache.ssSlopeTol  - ssSlopeTol)  > 1e-7 ||
    Math.abs(cache.tciFraction - tciFraction) > 1e-6 ||
    Math.abs((cache.exitBandPct || 0) - exitBandPct) > 1e-6;

  const curveChanged = cache.computedVersion !== _curveVersion;

  if (displayChanged || curveChanged) {
    // Resolve the PK curve for this drug.
    let curve;
    const isSelected = drugId === (getDrugId ? getDrugId() : null);
    if (isSelected) {
      curve = _sharedCurve;
    } else if (m === 'tci') {
      const endTime = Math.max(360, t + 360);
      try { cache.curve = model.computeCurve(drugId, 0, endTime, 1 / 6); } catch (e) { cache.curve = null; }
      curve = cache.curve;
    } else {
      curve = null;
    }

    const lockSsCeToPass   = displayChanged ? null : cache.lockedSsCeSS;
    const lockPlatCeToPass = displayChanged ? null : cache.lockedPlateauCe;
    const lockExitToPass   = displayChanged ? null : cache.lockedExitMin;
    const data = computeApproachData(drugId, t, m, Ce, ceTarget, rate,
      lockSsCeToPass, lockPlatCeToPass, lockExitToPass, curve, ssSlopeTol, tciFraction, exitBandPct);

    // Single-line modes (TCI, intermittent, emergence)
    cache.prefix          = data.prefix;
    cache.arrivalMin      = data.arrivalMin;
    cache.staticText      = data.staticText;

    // Manual mode: SS line
    cache.ssPrefix        = data.ssPrefix;
    cache.ssArrivalMin    = data.ssArrivalMin;
    cache.ssStaticText    = data.ssStaticText;
    cache.ssLine          = data.ssLine;

    // Manual mode: plateau line
    cache.platPrefix      = data.platPrefix;
    cache.platArrivalMin  = data.platArrivalMin;
    cache.platStaticText  = data.platStaticText;
    cache.plateauRegion   = data.plateauRegion;

    cache.computedVersion = _curveVersion;
    cache.mode            = m;
    cache.rate            = rate;
    cache.target          = ceTarget;
    cache.ssSlopeTol      = ssSlopeTol;
    cache.tciFraction     = tciFraction;
    cache.exitBandPct     = exitBandPct;

    if (displayChanged) {
      cache.lockedSsCeSS    = data.newLockedSsCeSS;
      cache.lockedPlateauCe = data.newLockedPlateauCe;
      cache.lockedExitMin   = data.newLockedExitMin ?? null;
    }
  }

  // Render countdown live every frame
  let html = '';

  if (m === 'manual' && rate > 0) {
    // Two-line display: SS (line 1) + Plateau (line 2)
    let ssHtml = '';
    if (cache.ssArrivalMin !== null) {
      const rem = cache.ssArrivalMin - t;
      if (rem > 0) {
        ssHtml = cache.ssPrefix + `<span class="appr-time">${fmtCountdown(rem)}</span>`;
      } else {
        cache.computedVersion = -1;
      }
    } else {
      ssHtml = cache.ssStaticText;
    }

    let platHtml = '';
    if (cache.platArrivalMin !== null) {
      const rem = cache.platArrivalMin - t;
      if (rem > 0) {
        platHtml = cache.platPrefix + `<span class="appr-time">${fmtCountdown(rem)}</span>`;
      } else {
        cache.computedVersion = -1;
      }
    } else {
      platHtml = cache.platStaticText;
    }

    if (ssHtml && platHtml) {
      html = ssHtml + '<br>' + platHtml;
    } else {
      html = ssHtml || platHtml;
    }
  } else {
    // Single-line modes
    if (cache.arrivalMin !== null) {
      const remaining = cache.arrivalMin - t;
      if (remaining > 0) {
        html = cache.prefix + `<span class="appr-time">${fmtCountdown(remaining)}</span>`;
      } else {
        cache.computedVersion = -1;
      }
    } else {
      html = cache.staticText;
    }
  }

  // Redose countdown is shown in the step-bar row instead (suppress from approach area)
  // Exception: combined state (infusion + threshold) shows SS/plateau in approach area
  const _threshold = getIntermittentThresholdForDrug ? getIntermittentThresholdForDrug(drugId) : 0;
  if (_threshold > 0 && cache.arrivalMin !== null && !(m === 'manual' && rate > 0)) html = '';

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
// Exit readout — "time to Exit Ce if stopped now"
// ──────────────────────────────────────────────────────────────────

const _exitReadoutCache = {};   // { drugId: { lastUpdate, html } }

function updateExitReadout(drugId, t, Ce, caseStarted) {
  const el = $(drugId + '-exit');
  if (!el) return;

  const exitCe = getExitCeForDrug ? getExitCeForDrug(drugId) : 0;
  if (!exitCe || exitCe <= 0 || !caseStarted || t <= 0) {
    if (el.innerHTML !== '') el.innerHTML = '';
    return;
  }

  // Ce already at or below exit threshold
  if (Ce <= exitCe) {
    const html = '<span style="color:var(--green)">Exit reached</span>';
    if (el.innerHTML !== html) el.innerHTML = html;
    return;
  }

  // Throttle prediction to every 3 seconds
  const now = Date.now();
  const cache = _exitReadoutCache[drugId] || (_exitReadoutCache[drugId] = { lastUpdate: 0, html: '' });
  if (now - cache.lastUpdate < 3000) {
    if (el.innerHTML !== cache.html) el.innerHTML = cache.html;
    return;
  }

  // Predict decay time assuming rate=0
  const result = model.predictDecayTo(drugId, t, exitCe);
  let html = '';
  if (result && result.time !== null && result.time > t) {
    const rem = result.time - t;
    html = `Exit <span class="appr-time">${fmtCountdown(rem)}</span>`;
  }
  cache.lastUpdate = now;
  cache.html = html;
  if (el.innerHTML !== html) el.innerHTML = html;
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
    const threshold = getIntermittentThresholdForDrug ? getIntermittentThresholdForDrug(dId) : 0;
    // For the approach line and warnings, ceTarget is the TCI target or the
    // redose threshold, depending on drug type.
    const ceTarget = (threshold > 0 && m !== 'tci')
      ? threshold
      : (getCeTargetForDrug ? getCeTargetForDrug(dId) : 0);

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
      settings.checkBelowThreshold(dId, threshold > 0 && Ce <= ceTarget);
    } else {
      const el = $(dId + '-approach');
      if (el) el.innerHTML = '';
    }

    // ── Exit Ce readout (upper-right of drug card) ─────────────────
    updateExitReadout(dId, t, Ce, caseStarted);

    // ── Status + rate ─────────────────────────────────────────────
    const statusEl = $(dId + '-status');
    const rateEl   = $(dId + '-rate');

    if (statusEl) {
      let label = 'Stopped', cls = 'stopped';
      if (!caseStarted || m === 'none') {
        label = 'Stopped'; cls = 'stopped';
      } else if (threshold > 0 && m !== 'manual') {
        // Threshold-only (no infusion): show bolus status during delivery, blank otherwise
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
      rateEl.textContent = (caseStarted && rate > 0) ? fmtRateInline(dId, rate) : '';
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
      if (threshold === 0) {
        updateStepBar(dId, t);
      } else {
        // Threshold set: during bolus delivery show progress normally;
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
            const ceStr = fmtCe(ceTarget, dId);
            const newHtml = rem > 0
              ? `Threshold <span class="appr-val">${ceStr}</span> in <span class="appr-time">${fmtCountdown(rem)}</span>` : '';
            if (cntEl.innerHTML !== newHtml) cntEl.innerHTML = newHtml;
          }
        } else if (m === 'manual') {
          // Combined state (infusion + threshold) with no redose needed —
          // the infusion keeps Ce above threshold. Show normal step bar.
          updateStepBar(dId, t);
          barEl?.parentElement?.classList.remove('step-bar-below');
          if (cntEl && cntEl.innerHTML !== '') cntEl.innerHTML = '';
        } else {
          // Threshold-only, Ce below threshold — red "below" indicator
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
      if (caseStarted && (m !== 'none' || threshold > 0)) {
        if (threshold > 0 && ceTarget > 0 && Ce <= ceTarget) {
          status = 'alert';                      // below redose threshold
        } else if (rate === 0 && threshold === 0) {
          status = 'alert';                      // pump paused / stopped (no threshold)
        } else {
          const warnMin = settings.getSettings().statusWarnMinutes ?? 2;
          let isWarn = false;
          // Next scheduled manual event (rate change, bolus, pause, TCI step)
          try {
            const evts    = model.getEvents(dId);
            const nextEvt = evts.find(e => e.time > t + 0.0001 && e.source !== 'system');
            if (nextEvt && (nextEvt.time - t) <= warnMin) isWarn = true;
          } catch (e) {}
          // Redose due within warn window (whenever threshold is set)
          if (!isWarn && threshold > 0) {
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

/** Return the current plateau region for a drug (for chart highlight). */
export function getPlateauRegion(drugId) {
  const c = _approachCache[drugId];
  return c ? c.plateauRegion : null;
}

/** Return the analytical steady-state Ce for a drug (for chart SS line). */
export function getSteadyStateCe(drugId) {
  const c = _approachCache[drugId];
  return c ? c.ssLine : null;
}

/** Force an immediate update (after a model mutation). */
export function forceUpdate() {
  for (const cache of Object.values(_approachCache)) {
    cache.computedVersion  = -1;
    cache.lockedSsCeSS     = null;
    cache.lockedPlateauCe  = null;
    cache.lockedExitMin    = null;
  }
  update();
}
