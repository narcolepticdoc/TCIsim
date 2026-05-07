/**
 * drug-panel/exit-readout.js — "Time to Exit Ce if stopped now" readout.
 *
 * Shown in the upper-right of the drug card when an Exit Ce threshold
 * is configured. Re-predicts on user input changes (exit Ce, model
 * curve version) AND on a 1 s wall-clock interval so the prediction
 * tracks Ce drift between event mutations. Renders the countdown live
 * every frame from the cached `arrivalMin`.
 */

import { fmtCountdown, smartDecimal } from './formatters.js';
import { getCurveVersion } from './approach.js';

const _exitReadoutCache = {};   // { drugId: { exitCe, computedVersion, arrivalMin, prefixHtml, lastPredictMs } }

const PREDICTION_REFRESH_MS = 1000;   // re-predict at most once per second to track Ce drift

function _getCache(drugId) {
  if (!_exitReadoutCache[drugId]) {
    _exitReadoutCache[drugId] = {
      exitCe: 0, computedVersion: -1, arrivalMin: null, prefixHtml: '',
      lastPredictMs: 0,
    };
  }
  return _exitReadoutCache[drugId];
}

export function updateExitReadout(ctx, drugId, t, Ce, caseStarted) {
  const el = ctx.$(drugId + '-exit');
  if (!el) return;

  const exitCe = ctx.getExitCeForDrug ? ctx.getExitCeForDrug(drugId) : 0;
  if (!exitCe || exitCe <= 0 || !caseStarted || t <= 0) {
    if (el.innerHTML !== '') el.innerHTML = '';
    return;
  }

  // Ce already at or below exit threshold — emergence reached
  if (Ce <= exitCe) {
    const html = '<span style="color:var(--green)">Emergence Reached</span>';
    if (el.innerHTML !== html) el.innerHTML = html;
    return;
  }

  const cache = _getCache(drugId);
  const curveVersion = getCurveVersion();
  const now = Date.now();
  const stale = (now - cache.lastPredictMs) >= PREDICTION_REFRESH_MS;

  // Re-predict on user input changes, model mutation, or periodic refresh
  // (so the "if you stopped now" answer keeps up with Ce drift between events).
  if (cache.exitCe !== exitCe || cache.computedVersion !== curveVersion || stale) {
    const result = ctx.model.predictDecayTo(drugId, t, exitCe);
    if (result && result.time !== null && result.time > t) {
      const lbl = ctx.getExitCeLabelForDrug ? ctx.getExitCeLabelForDrug(drugId) : '';
      const numPart = lbl ? smartDecimal(parseFloat(lbl.split(' ')[0])) : '';
      const ceSpan = numPart ? ` <span style="color:var(--cyan)">${numPart}</span>` : '';
      cache.arrivalMin = result.time;
      cache.prefixHtml = `Emerge &rarr;${ceSpan} in `;
    } else {
      cache.arrivalMin = null;
      cache.prefixHtml = '';
    }
    cache.exitCe          = exitCe;
    cache.computedVersion = curveVersion;
    cache.lastPredictMs   = now;
  }

  // Render countdown live every frame from cached arrivalMin
  let html = '';
  if (cache.arrivalMin !== null) {
    const rem = cache.arrivalMin - t;
    if (rem > 0) {
      html = cache.prefixHtml + `<span class="appr-time">${fmtCountdown(rem)}</span>`;
    } else {
      // Arrival elapsed but Ce still > exitCe — force re-predict next frame
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
