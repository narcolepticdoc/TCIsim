/**
 * drug-panel/approach.js — Approach line computation & rendering.
 *
 * Manages the approach cache, computes approach data for all modes
 * (TCI countdown, manual SS + plateau, intermittent redose, emergence),
 * and renders the live countdown into the DOM.
 *
 * Also owns the shared curve store (setCurveData) since approach is
 * the only consumer that writes it.
 */

import { fmtCountdown, fmtCe, fmtCeSmart, smartDecimal, EMERGENCE_CE } from './formatters.js';

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
// Per-drug approach cache
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
      ceAboveTarget: null,  // tracks Ce vs ceTarget to invalidate on threshold crossing
      ssSlopeTol: 0, tciFraction: 0, exitBandPct: 0,
      curve: null,
    };
  }
  return _approachCache[drugId];
}

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

function computeApproachData(ctx, drugId, t, m, Ce, ceTarget, rate, lockedSsCeSS, lockedPlateauCe, lockedExitMin, curve, ssSlopeTol, tciFraction, exitBandPct) {
  const noData = { prefix: '', arrivalMin: null, staticText: '',
    ssPrefix: '', ssArrivalMin: null, ssStaticText: '',
    newLockedSsCeSS: null, ssLine: null,
    platPrefix: '', platArrivalMin: null, platStaticText: '',
    newLockedPlateauCe: null, newLockedExitMin: null, plateauRegion: null };

  // Redose threshold — compute countdown whenever threshold is set.
  // For threshold-only (no infusion): return single-line redose data.
  // For combined (infusion + threshold): store redose in prefix/arrivalMin
  // and fall through to the manual SS/plateau analysis.
  const threshold = ctx.getIntermittentThresholdForDrug ? ctx.getIntermittentThresholdForDrug(drugId) : 0;
  if (threshold > 0 && ceTarget > 0) {
    let redose = null;
    if (Ce <= ceTarget) {
      const ceStr = `<span class="appr-val">${fmtCeSmart(ceTarget, drugId)}</span>`;
      redose = { staticText: `<span class="appr-below">Below Redose Threshold ${ceStr}</span>` };
    } else {
      try {
        const result = ctx.model.predictTrough(drugId, t, ceTarget);
        if (result && result.time !== null && result.time > t) {
          const ceStr = `<span class="appr-val">${fmtCeSmart(ceTarget, drugId)}</span>`;
          redose = { prefix: `Redose Threshold ${ceStr} in `, arrivalMin: result.time };
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

  // Pump stopped — emergence countdown.
  // When the user has configured an exit Ce, exit-readout.js owns this readout
  // (renders into a dedicated slot with the canonical "Emerge →" label).
  if ((m === 'none' || (rate === 0 && m !== 'tci')) && threshold === 0) {
    if (ctx.getExitCeForDrug && ctx.getExitCeForDrug(drugId) > 0) return noData;
    if (Ce <= EMERGENCE_CE + 0.05) return noData;
    try {
      const result = ctx.model.predictTrough(drugId, t, EMERGENCE_CE);
      if (result && result.time !== null && result.time > t) {
        return { ...noData,
          prefix: `Emergence <span class="appr-val">${smartDecimal(EMERGENCE_CE)}</span> in `,
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
        staticText: `At Target <span class="appr-val">${smartDecimal(ceTarget)}</span>` };
    }
    const dt = _estimateTimeToTarget(curve, t, Ce, ceTarget, tciFraction);
    if (dt !== null && dt > 0) {
      return { ...noData,
        prefix: `Target → <span class="appr-val">${smartDecimal(ceTarget)}</span> in `,
        arrivalMin: t + dt,
      };
    }
    return { ...noData,
      staticText: `Target <span class="appr-val">${smartDecimal(ceTarget)}</span>` };
  }

  // Manual infusion — two independent analyses: SS + plateau
  if (m === 'manual' && rate > 0) {
    const result = { ...noData };

    // ── Line 1: Analytical Steady State ──
    let ssResult = null;
    try { ssResult = ctx.model.predictSteadyState(drugId, t, rate); } catch (e) {}
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
    try { platResult = ctx.model.predictPlateau(drugId, t, rate, ssSlopeTol, { exitBandPct }); } catch (e) {}
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
        prefix: `Target → <span class="appr-val">${smartDecimal(ceTarget)}</span> in `,
        arrivalMin: t + dt,
      };
    }
  }

  return noData;
}

export function updateApproachLine(ctx, drugId, t, m, Ce, ceTarget, rate) {
  const cache = _getApproachCache(drugId);
  const ssSlopeTol  = ctx.getSsSlopeTol();
  const tciFraction = ctx.getTciFraction();
  const exitBandPct = ctx.getSsExitBand();

  // Track whether Ce is above the target/threshold — invalidate cache on crossing
  // so "Below Redose Threshold" ↔ countdown transitions aren't stale
  const ceAboveTarget = ceTarget > 0 ? (Ce > ceTarget) : null;

  const displayChanged =
    cache.mode   !== m ||
    Math.abs(cache.rate   - rate)     > 0.01 ||
    Math.abs(cache.target - ceTarget) > 0.01 ||
    (ceAboveTarget !== null && cache.ceAboveTarget !== ceAboveTarget) ||
    Math.abs(cache.ssSlopeTol  - ssSlopeTol)  > 1e-7 ||
    Math.abs(cache.tciFraction - tciFraction) > 1e-6 ||
    Math.abs((cache.exitBandPct || 0) - exitBandPct) > 1e-6;

  const curveChanged = cache.computedVersion !== _curveVersion;

  if (displayChanged || curveChanged) {
    // Resolve the PK curve for this drug.
    let curve;
    const isSelected = drugId === (ctx.getDrugId ? ctx.getDrugId() : null);
    if (isSelected) {
      curve = _sharedCurve;
    } else if (m === 'tci') {
      const endTime = Math.max(360, t + 360);
      try { cache.curve = ctx.model.computeCurve(drugId, 0, endTime, 1 / 6); } catch (e) { cache.curve = null; }
      curve = cache.curve;
    } else {
      curve = null;
    }

    const lockSsCeToPass   = displayChanged ? null : cache.lockedSsCeSS;
    const lockPlatCeToPass = displayChanged ? null : cache.lockedPlateauCe;
    const lockExitToPass   = displayChanged ? null : cache.lockedExitMin;
    const data = computeApproachData(ctx, drugId, t, m, Ce, ceTarget, rate,
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
    cache.ceAboveTarget   = ceAboveTarget;
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
  const _threshold = ctx.getIntermittentThresholdForDrug ? ctx.getIntermittentThresholdForDrug(drugId) : 0;
  if (_threshold > 0 && cache.arrivalMin !== null && !(m === 'manual' && rate > 0)) html = '';

  const el = ctx.$(drugId + '-approach');
  if (el && el.innerHTML !== html) el.innerHTML = html;
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

/** Force-invalidate all approach caches (called after model mutation). */
export function invalidateAll() {
  for (const cache of Object.values(_approachCache)) {
    cache.computedVersion  = -1;
    cache.lockedSsCeSS     = null;
    cache.lockedPlateauCe  = null;
    cache.lockedExitMin    = null;
  }
}

/** Expose the approach cache getter so step-bar can read arrivalMin. */
export { _getApproachCache };
