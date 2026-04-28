/**
 * drug-panel/exit-readout.js — "Time to Exit Ce if stopped now" readout.
 *
 * Shown in the upper-right of the drug card when an Exit Ce threshold
 * is configured. Throttled to one model.predictDecayTo call every 3 s.
 */

import { fmtCountdown, smartDecimal } from './formatters.js';

const _exitReadoutCache = {};   // { drugId: { lastUpdate, html } }

export function updateExitReadout(ctx, drugId, t, Ce, caseStarted) {
  const el = ctx.$(drugId + '-exit');
  if (!el) return;

  const exitCe = ctx.getExitCeForDrug ? ctx.getExitCeForDrug(drugId) : 0;
  if (!exitCe || exitCe <= 0 || !caseStarted || t <= 0) {
    if (el.innerHTML !== '') el.innerHTML = '';
    return;
  }

  // Ce already at or below exit threshold
  if (Ce <= exitCe) {
    const html = '<span style="color:var(--green)">Emergence Reached</span>';
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
  const result = ctx.model.predictDecayTo(drugId, t, exitCe);
  let html = '';
  if (result && result.time !== null && result.time > t) {
    const rem = result.time - t;
    const lbl = ctx.getExitCeLabelForDrug ? ctx.getExitCeLabelForDrug(drugId) : '';
    const numPart = lbl ? smartDecimal(parseFloat(lbl.split(' ')[0])) : '';
    const ceSpan = numPart ? ` <span style="color:var(--cyan)">${numPart}</span>` : '';
    html = `Emerge &rarr;${ceSpan} in <span class="appr-time">${fmtCountdown(rem)}</span>`;
  }
  cache.lastUpdate = now;
  cache.html = html;
  if (el.innerHTML !== html) el.innerHTML = html;
}
