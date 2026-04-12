/**
 * drug-panel/formatters.js — Display formatting helpers.
 *
 * Pure-ish helpers for formatting Ce, rate, BIS color, countdown
 * strings, and bolus-phase detection. Used by approach, step-bar,
 * exit-readout, and the main update loop.
 */

import { fromCanonical, formatValue, getAllowedUnits, getDefaultUnit, getPrefKey } from '../../util/units.js';

// Emergence Ce level (mcg/mL). Could become a user setting later.
export const EMERGENCE_CE = 1.5;

// Fallback values when no getter is wired. Match the DEFAULTS in
// settings.js (tciFraction: 0.95, ssSlopeTol: 0.0010).
export const TCI_FRACTION_DEFAULT = 0.95;
export const SS_SLOPE_DEFAULT     = 0.0010;
export const EXIT_BAND_DEFAULT    = 0.05;

/** Format minutes as m:ss  (e.g. 125.4s → "2:05") */
export function fmtCountdown(minutes) {
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
export function bisColor(bis) {
  if (bis > 90) return 'var(--text-muted)';
  if (bis > 80) return '#ef4444';
  if (bis > 60) return '#f97316';
  if (bis > 40) return '#eab308';
  if (bis > 20) return '#22c55e';
  return '#a855f7';
}

/** Returns true when the most recent event at/before t is a bolus. */
export function isInBolusPhase(ctx, drugId, t) {
  try {
    const events = ctx.model.getEvents(drugId);
    for (let i = events.length - 1; i >= 0; i--) {
      if (events[i].time <= t) return events[i].type === 'bolus';
    }
  } catch (e) {}
  return false;
}

/**
 * Format Ce (or Cp) for display in the drug card.
 * Fentanyl Ce is tiny in mcg/mL — display in ng/mL instead (×1000).
 * dp controls decimal places for mcg/mL drugs (default 2 for live readout, 1 for labels).
 */
export function fmtCe(ceMcgMl, drugId, dp = 2) {
  const allowed = getAllowedUnits(drugId, 'ceTarget');
  if (allowed && allowed[0] === 'ng/mL') {
    return (ceMcgMl * 1000).toFixed(1);
  }
  return ceMcgMl.toFixed(dp);
}

/** Format rate for inline display next to status label. Returns '' if no rate. */
export function fmtRateInline(ctx, drugId, rate) {
  if (!rate || rate <= 0) return '';
  try {
    const weight = ctx.model.getPatient().weight;
    const prefKey = getPrefKey(drugId, 'rate');
    let displayUnit = getDefaultUnit(drugId, 'rate');
    if (prefKey) {
      try {
        const saved = localStorage.getItem(prefKey);
        const allowed = getAllowedUnits(drugId, 'rate');
        if (saved && allowed.includes(saved)) displayUnit = saved;
      } catch (e) {}
    }
    const displayVal = fromCanonical(rate, displayUnit, drugId, 'rate', { weightKg: weight });
    return `${formatValue(displayVal, displayUnit)} ${displayUnit}`;
  } catch (e) {
    return `${rate.toFixed(2)} mg/min`;
  }
}
