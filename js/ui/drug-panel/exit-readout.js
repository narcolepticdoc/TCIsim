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
 *   Idle (rate == 0): Ce is actually decaying. Snapshot decay-from-now
 *   at the Active->Idle transition; render every frame as
 *   `idleStartDecayMin - (t - idleStartT)` for a smooth 1 sec/sec
 *   countdown driven by the simulator clock. Periodic sanity re-predict
 *   re-baselines if cumulative drift exceeds hysteresis.
 *
 * Forced invalidations (exit-Ce change, _curveVersion bump from a bolus
 * or event edit) re-predict immediately in the current mode.
 */

import { fmtCountdown, smartDecimal } from './formatters.js';
import { getCurveVersion } from './approach.js';

const _exitReadoutCache = {};

const PREDICTION_REFRESH_MS = 1000;
const IDLE_SANITY_MS = 5000;
const HYSTERESIS_MIN = 1.5 / 60;   // 1.5 sec — swallows bisection jitter (~0.3 s)
                                    // and the half-second rounding boundary.

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

  const cache = _getCache(drugId);
  const curveVersion = getCurveVersion();
  const now = Date.now();

  const currentRate = ctx.model.getRateAtTime
    ? ctx.model.getRateAtTime(drugId, t)
    : 0;
  const isIdle = !(currentRate > 0);

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

/** Force-invalidate all exit readout caches (called after model mutation). */
export function invalidateAll() {
  for (const k of Object.keys(_exitReadoutCache)) {
    _exitReadoutCache[k].computedVersion = -1;
  }
}
