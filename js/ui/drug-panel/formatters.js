/**
 * drug-panel/formatters.js — Display formatting helpers.
 *
 * Pure-ish helpers for formatting Ce, rate, BIS color, countdown
 * strings, and bolus-phase detection. Used by approach, step-bar,
 * exit-readout, and the main update loop.
 */

import { fromCanonical, formatValue, getAllowedUnits, getDefaultUnit, getPrefKey } from '../../util/units.js';
import { getPumpSettings } from '../../util/constants.js';

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
 * BIS → color matching the chart nomogram bands. Returns CSS variable refs
 * so the eBIS readout adapts to the active theme — the dark-tuned hex
 * values (#eab308 yellow in particular) are invisible against a light
 * background, so the per-theme `--bis-*` blocks darken them.
 *   > 90  --text-muted   (awake, no band)
 *  80-90  --bis-mild     red    Light Sedation
 *  60-80  --bis-moderate orange Deep Sedation
 *  40-60  --bis-deep     yellow GA
 *  20-40  --bis-deeper   green  Deep Anesthesia
 *   < 20  --bis-very-deep purple Very Deep
 */
export function bisColor(bis) {
  if (bis > 90) return 'var(--text-muted)';
  if (bis > 80) return 'var(--bis-mild)';
  if (bis > 60) return 'var(--bis-moderate)';
  if (bis > 40) return 'var(--bis-deep)';
  if (bis > 20) return 'var(--bis-deeper)';
  return 'var(--bis-very-deep)';
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

/**
 * Smart decimal formatter for user-set Ce set points (target / redose threshold /
 * emergence). Shows two decimals when the hundredths digit is non-zero, otherwise
 * one decimal. Examples: 3.0 → "3.0", 3.05 → "3.05", 3.097 → "3.1".
 */
export function smartDecimal(value, fallbackDp = 1) {
  if (!isFinite(value)) return String(value);
  const t2 = value.toFixed(2);
  return t2.endsWith('0') ? value.toFixed(fallbackDp) : t2;
}

/**
 * Smart Ce formatter — mirrors fmtCe's ng/mL handling but routes through
 * smartDecimal so user-set values like 1.55 ng/mL aren't rounded to 1.6.
 */
export function fmtCeSmart(ceMcgMl, drugId) {
  const allowed = getAllowedUnits(drugId, 'ceTarget');
  const v = (allowed && allowed[0] === 'ng/mL') ? ceMcgMl * 1000 : ceMcgMl;
  return smartDecimal(v);
}

/**
 * Format Ce/Cp for the prominent drug-card readout. Returns HTML with
 * the hundredths digit wrapped in `.ce-frac` so it can render smaller
 * via CSS. Always two decimals, regardless of drug — the unit (mcg/mL
 * vs ng/mL) is selected per drug, but the visual precision is uniform.
 */
export function fmtCeHTML(ceMcgMl, drugId) {
  const allowed = getAllowedUnits(drugId, 'ceTarget');
  const v = (allowed && allowed[0] === 'ng/mL') ? ceMcgMl * 1000 : ceMcgMl;
  const fixed = v.toFixed(2);
  return `${fixed.slice(0, -1)}<span class="ce-frac">${fixed.slice(-1)}</span>`;
}

/**
 * Format rate for inline display next to status label. Returns '' if no rate.
 *
 * During pump-bolus delivery (`opts.bolusOverride === true`), the display
 * forces mL/h with the pump's currently-configured concentration, mirroring
 * what a real infusion pump shows on its screen. Removes the conversion
 * mismatch trainees would otherwise see between the sim's preferred unit
 * (e.g. mcg/kg/min) and the pump's mL/h readout.
 */
export function fmtRateInline(ctx, drugId, rate, opts = {}) {
  if (!rate || rate <= 0) return '';
  try {
    const weight = ctx.model.getPatient().weight;
    let displayUnit;
    let concentration;
    if (opts.bolusOverride) {
      displayUnit = 'mL/h';
      try { concentration = getPumpSettings(drugId).concentration; } catch (e) {}
    } else {
      const prefKey = getPrefKey(drugId, 'rate');
      displayUnit = getDefaultUnit(drugId, 'rate');
      if (prefKey) {
        try {
          const saved = localStorage.getItem(prefKey);
          const allowed = getAllowedUnits(drugId, 'rate');
          if (saved && allowed.includes(saved)) displayUnit = saved;
        } catch (e) {}
      }
    }
    const conv = { weightKg: weight };
    if (concentration) conv.concentration = concentration;
    const displayVal = fromCanonical(rate, displayUnit, drugId, 'rate', conv);
    return `${formatValue(displayVal, displayUnit)} ${displayUnit}`;
  } catch (e) {
    return `${rate.toFixed(2)} mg/min`;
  }
}
