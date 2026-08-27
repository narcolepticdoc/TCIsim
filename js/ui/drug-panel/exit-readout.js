/**
 * drug-panel/exit-readout.js — "Time to Exit Ce if stopped now" readout.
 *
 * Two-mode state machine driven by the current infusion rate:
 *
 *   Active (rate > 0): the answer is a counter-factual. Re-predict on a
 *   1 s wall clock with small symmetric hysteresis so bisection jitter
 *   and sub-second wobble don't flip the rounded display. Render
 *   directly from the cached decay-from-now — no per-frame `t`
 *   subtraction, so the display is truly stable at SS.
 *
 *   Idle (Ce decaying): the countdown IS the decay. Snapshot
 *   decay-from-now at the Active->Idle transition; render every frame as
 *   `idleStartDecayMin - (t - idleStartT)` for a smooth 1 sec/sec
 *   countdown driven by the simulator clock. Periodic sanity re-predict
 *   re-baselines if cumulative drift exceeds hysteresis.
 *
 * Idle is decided by Ce's DIRECTION, not by the pump rate — see `rising`
 * below. A zero rate does not mean Ce is falling: after a bolus given with
 * no infusion running, Ce climbs for a minute or more at rate 0, and the
 * 1 sec/sec tick-down would count the wrong way through exactly that window.
 *
 * Forced invalidations (exit-Ce change, _curveVersion bump from a bolus
 * or event edit) re-predict immediately in the current mode.
 */

import { fmtCountdown, smartDecimal, isInBolusPhase } from './formatters.js';
import { getCurveVersion } from './approach.js';

const _exitReadoutCache = {};

const PREDICTION_REFRESH_MS = 1000;
const IDLE_SANITY_MS = 5000;
const HYSTERESIS_MIN = 1.5 / 60;   // 1.5 sec — swallows bisection jitter (~0.3 s)
                                    // and the half-second rounding boundary.
const CE_RISE_EPS = 1e-9;          // relative; ignores float-level jitter while
                                    // still catching a real rise (~1e-3 µg/mL
                                    // per frame during post-bolus equilibration).

function _getCache(drugId) {
  if (!_exitReadoutCache[drugId]) {
    _exitReadoutCache[drugId] = {
      exitCe: 0,
      computedVersion: -1,
      prefixHtml: '',
      // Active-mode cache
      displayedDecayMin: null,
      lastPredictMs: 0,
      // Idle-mode cache
      idleStartT: 0,
      idleStartDecayMin: null,
      lastIdleSanityMs: 0,
      // Mode tracking
      lastIsIdle: null,
      lastCe: null,       // previous frame's Ce — gives the direction of travel
    };
  }
  return _exitReadoutCache[drugId];
}

function _buildPrefix(ctx, drugId) {
  const lbl = ctx.getExitCeLabelForDrug ? ctx.getExitCeLabelForDrug(drugId) : '';
  const numPart = lbl ? smartDecimal(parseFloat(lbl.split(' ')[0])) : '';
  const ceSpan = numPart ? ` <span style="color:var(--cyan)">${numPart}</span>` : '';
  return `Emerge &rarr;${ceSpan} in `;
}

export function updateExitReadout(ctx, drugId, t, Ce, caseStarted) {
  const el = ctx.$(drugId + '-exit');
  if (!el) return;

  const cache = _getCache(drugId);
  // Sampled on every call, including the early returns below, so a readout
  // that blanks (target cleared, emergence reached) and later comes back never
  // resumes from a stale direction sample.
  const prevCe = cache.lastCe;
  cache.lastCe = Ce;

  const exitCe = ctx.getExitCeForDrug ? ctx.getExitCeForDrug(drugId) : 0;
  if (!exitCe || exitCe <= 0 || !caseStarted || t <= 0) {
    if (el.innerHTML !== '') el.innerHTML = '';
    return;
  }

  if (Ce <= exitCe) {
    const html = '<span style="color:var(--green)">Emergence Reached</span>';
    if (el.innerHTML !== html) el.innerHTML = html;
    return;
  }

  const curveVersion = getCurveVersion();
  const now = Date.now();

  const currentRate = ctx.model.getRateAtTime
    ? ctx.model.getRateAtTime(drugId, t)
    : 0;
  // A zero pump rate is NOT the same as a falling Ce, and only a falling Ce
  // makes the idle tick-down valid. `getRateAtTime` walks rate/pause events
  // only — boluses are invisible to it — so a bolus given with no infusion
  // running reads as rate 0 for its whole delivery AND the effect-site rise
  // that follows. Through that window the true time-to-emergence climbs
  // steeply while a 1 sec/sec tick-down counts down, resyncing with a visible
  // upward jump every IDLE_SANITY_MS. Direction decides, the same rule
  // `settings.checkBelowThreshold` and `decay-predictor`'s `hasBeenAbove`
  // already apply to the redose threshold.
  // Ce's own direction misses the first seconds of a bolus: the plasma is
  // already loaded while the effect site is still coasting down, so Ce falls
  // for a moment even though the answer has jumped. isInBolusPhase covers
  // exactly that lag; `rising` then carries the rest of the climb to the peak.
  const rising = prevCe !== null && (Ce - prevCe) > Math.abs(prevCe) * CE_RISE_EPS;
  const isIdle = !(currentRate > 0) && !rising && !isInBolusPhase(ctx, drugId, t);

  const exitCeChanged = (cache.exitCe !== exitCe);
  const versionChanged = (cache.computedVersion !== curveVersion);
  const modeChanged = (cache.lastIsIdle !== null && cache.lastIsIdle !== isIdle);
  const forced = exitCeChanged || versionChanged || modeChanged || cache.lastIsIdle === null;

  if (isIdle) {
    const sanityDue = (now - cache.lastIdleSanityMs) >= IDLE_SANITY_MS;
    if (forced || sanityDue) {
      const result = ctx.model.predictDecayTo(drugId, t, exitCe);
      if (result && result.time !== null && result.time > t) {
        const freshDecayMin = result.time - t;
        if (forced || cache.idleStartDecayMin === null) {
          cache.idleStartT = t;
          cache.idleStartDecayMin = freshDecayMin;
          cache.prefixHtml = _buildPrefix(ctx, drugId);
        } else {
          const tickedRem = cache.idleStartDecayMin - (t - cache.idleStartT);
          if (Math.abs(freshDecayMin - tickedRem) >= HYSTERESIS_MIN) {
            cache.idleStartT = t;
            cache.idleStartDecayMin = freshDecayMin;
          }
        }
      } else {
        cache.idleStartT = t;
        cache.idleStartDecayMin = null;
        cache.prefixHtml = '';
      }
      cache.lastIdleSanityMs = now;
      cache.exitCe = exitCe;
      cache.computedVersion = curveVersion;
      cache.displayedDecayMin = null;
      cache.lastPredictMs = 0;
    }
  } else {
    const stale = (now - cache.lastPredictMs) >= PREDICTION_REFRESH_MS;
    if (forced || stale) {
      const result = ctx.model.predictDecayTo(drugId, t, exitCe);
      if (result && result.time !== null && result.time > t) {
        const freshDecayMin = result.time - t;
        const accept = forced
          || cache.displayedDecayMin === null
          || Math.abs(freshDecayMin - cache.displayedDecayMin) >= HYSTERESIS_MIN;
        if (accept) {
          cache.displayedDecayMin = freshDecayMin;
          cache.prefixHtml = _buildPrefix(ctx, drugId);
        }
      } else {
        cache.displayedDecayMin = null;
        cache.prefixHtml = '';
      }
      cache.lastPredictMs = now;
      cache.exitCe = exitCe;
      cache.computedVersion = curveVersion;
      cache.idleStartDecayMin = null;
    }
  }

  cache.lastIsIdle = isIdle;

  let html = '';
  if (isIdle) {
    if (cache.idleStartDecayMin !== null) {
      const rem = cache.idleStartDecayMin - (t - cache.idleStartT);
      if (rem > 0) {
        html = cache.prefixHtml + `<span class="appr-time">${fmtCountdown(rem)}</span>`;
      } else {
        cache.computedVersion = -1;
      }
    }
  } else {
    if (cache.displayedDecayMin !== null && cache.displayedDecayMin > 0) {
      html = cache.prefixHtml + `<span class="appr-time">${fmtCountdown(cache.displayedDecayMin)}</span>`;
    } else if (cache.displayedDecayMin !== null) {
      cache.computedVersion = -1;
    }
  }

  if (el.innerHTML !== html) el.innerHTML = html;
}

/**
 * Emergence arrival for the Next Up panel.
 *
 * `isIdle` matters: with the pump running this readout is a **counter-factual**
 * ("if you stopped now"), which is honest on a drug card but would be a lie on a
 * list of things that are going to happen. Callers that promise future events
 * must require `isIdle === true`.
 *
 * @returns {{arrivalMin: ?number, exitCe: number, isIdle: boolean}}
 */
export function getEmergenceArrival(drugId) {
  const c = _exitReadoutCache[drugId];
  if (!c) return { arrivalMin: null, exitCe: 0, isIdle: false };
  const isIdle = c.lastIsIdle === true;
  let arrivalMin = null;
  if (isIdle && c.idleStartDecayMin !== null) {
    arrivalMin = c.idleStartT + c.idleStartDecayMin;
  } else if (!isIdle && c.displayedDecayMin !== null) {
    // Counter-factual — exposed so callers can label it, never as a forecast.
    arrivalMin = null;
  }
  return { arrivalMin, exitCe: c.exitCe || 0, isIdle };
}

/** Force-invalidate all exit readout caches (called after model mutation). */
export function invalidateAll() {
  for (const k of Object.keys(_exitReadoutCache)) {
    _exitReadoutCache[k].computedVersion = -1;
  }
}
