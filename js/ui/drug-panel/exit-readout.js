/**
 * drug-panel/exit-readout.js — "Time to Exit Ce if stopped now" readout.
 *
 * Shown in the upper-right of the drug card when an Exit Ce threshold
 * is configured. Mirrors the approach.js cache pattern: re-predicts only
 * when the exit Ce changes or the model curve version bumps; renders the
 * countdown live every frame from the cached `arrivalMin`.
 */

import { fmtCountdown, smartDecimal } from './formatters.js';
import { getCurveVersion } from './approach.js';

const _exitReadoutCache = {};   // { drugId: { exitCe, computedVersion, arrivalMin, prefixHtml } }

function _getCache(drugId) {
  if (!_exitReadoutCache[drugId]) {
    _exitReadoutCache[drugId] = {
      exitCe: 0, computedVersion: -1, arrivalMin: null, prefixHtml: '',
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

  // Re-predict only when inputs change (user-set exit Ce or model state)
  if (cache.exitCe !== exitCe || cache.computedVersion !== curveVersion) {
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
