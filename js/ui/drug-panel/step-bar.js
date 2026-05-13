/**
 * drug-panel/step-bar.js — Step bar progress + countdown.
 *
 * Shows a progress bar and countdown label for the next scheduled
 * pump event. In intermittent threshold mode, shows the redose
 * countdown sourced from the approach cache instead.
 */

import { fromCanonical, formatValue, getAllowedUnits, getDefaultUnit, getPrefKey } from '../../util/units.js';
import { fmtCountdown } from './formatters.js';
import { getSettings, displayedSecToEvent } from '../settings.js';

/**
 * Format a short description for the next event shown in the step bar.
 * Returns null for system events (bare countdown only) or on error.
 * Respects the user's persisted unit preference (same as fmtRateInline).
 */
function fmtNextEvtLabel(ctx, evt, drugId) {
  if (!evt || evt.source === 'system') return null;
  try {
    if (evt.type === 'pause' || (evt.type === 'rate' && evt.value === 0)) {
      return 'Pause';
    }
    const weight = ctx.model.getPatient().weight;
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
      const v = fromCanonical(evt.value, unit, drugId, 'rate', { weightKg: weight });
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
      const v = fromCanonical(evt.value, unit, drugId, 'bolus', { weightKg: weight });
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
export function _intermittentBarPct(ctx, drugId, t, arrivalMin) {
  if (!arrivalMin || arrivalMin <= t) return 100;
  let prevTime = 0;
  try {
    const evts = ctx.model.getEvents(drugId);
    for (let i = evts.length - 1; i >= 0; i--) {
      if (evts[i].time <= t + 0.0001) { prevTime = evts[i].time; break; }
    }
  } catch(e) {}
  const total = arrivalMin - prevTime;
  const elapsed = t - prevTime;
  return total > 0 ? Math.min(100, Math.max(0, (elapsed / total) * 100)) : 0;
}

export function updateStepBar(ctx, drugId, t) {
  const barEl       = ctx.$(drugId + '-bar');
  const countdownEl = ctx.$(drugId + '-bar-countdown');
  if (!barEl || !countdownEl) return;

  try {
    const events = ctx.model.getEvents(drugId);
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

    // Reaction-delay bias: for TCI-scheduled events, present the countdown and
    // bar fill as if the event were `reactionDelaySec` earlier. Underlying
    // event time is unchanged.
    const reactionDelaySec = getSettings().reactionDelaySec || 0;
    const offsetMin = (nextEvt.source === 'tci' && reactionDelaySec > 0)
      ? reactionDelaySec / 60 : 0;
    const displayedTime = nextEvt.time - offsetMin;

    const span      = displayedTime - prevTime;
    const elapsed   = t - prevTime;
    const pct       = span > 0 ? Math.min(100, Math.max(0, (elapsed / span) * 100)) : 100;
    const remaining = displayedSecToEvent(nextEvt, t, reactionDelaySec) / 60;

    barEl.style.width = pct + '%';
    if (remaining > 0) {
      const label = fmtNextEvtLabel(ctx, nextEvt, drugId);
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
