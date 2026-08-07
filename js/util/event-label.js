/**
 * event-label.js — Shared "what the user must do" event formatter.
 *
 * One implementation of the phrase that describes a pump event in the
 * user's working display units. Three surfaces need it and each wants a
 * slightly different length:
 *
 *   'long'  — warning popups (js/ui/settings.js). "Pause pump", "Bolus 120 mg".
 *   'short' — drug-card step bar (js/ui/drug-panel/step-bar.js). "Pause",
 *             "Rate → 12.0 mg/min". Returns null for source:'system' events
 *             so the step bar shows a bare countdown.
 *   'hud'   — the Next Up panel (js/ui/next-up.js). Returns the verb and the
 *             value as separate fields so the panel can typeset them at
 *             different sizes.
 *
 * The three variants existed as two near-duplicate private functions before
 * the HUD needed a third copy. Output strings are unchanged.
 *
 * Pure — no DOM, no module state.
 */

import { fromCanonical, formatValue, getWorkingUnit } from './units.js';

/**
 * Describe the action an event requires.
 *
 * @param {Object} evt — event object (.type, .value, .source, .deliveryMode)
 * @param {string} drugId
 * @param {Object} [opts]
 * @param {number} [opts.weightKg] — needed for per-kg display units
 * @param {string} [opts.variant='long'] — 'long' | 'short' | 'hud'
 * @returns {string|{verb: string, value: string}|null}
 *   'long'/'short' → a single string ('short' returns null for system events
 *   and on error); 'hud' → { verb, value } with value possibly ''.
 */
export function formatEventAction(evt, drugId, opts = {}) {
  const { weightKg, variant = 'long' } = opts;
  const hud = variant === 'hud';

  if (!evt) return hud ? { verb: 'Event', value: '' } : (variant === 'short' ? null : 'Event');

  // The step bar deliberately shows a bare countdown for auto rate-restores.
  if (variant === 'short' && evt.source === 'system') return null;

  try {
    if (evt.type === 'pause' || (evt.type === 'rate' && evt.value === 0)) {
      if (hud)     return { verb: 'Pause pump', value: '' };
      if (variant === 'short') return 'Pause';
      return 'Pause pump';
    }

    const ctx = (weightKg != null) ? { weightKg } : {};

    if (evt.type === 'rate') {
      const unit = getWorkingUnit(drugId, 'rate');
      const val  = `${formatValue(fromCanonical(evt.value, unit, drugId, 'rate', ctx), unit)} ${unit}`;
      if (hud) return { verb: 'Set rate', value: val };
      return `Rate → ${val}`;
    }

    if (evt.type === 'bolus') {
      const unit  = getWorkingUnit(drugId, 'bolus');
      const val   = `${formatValue(fromCanonical(evt.value, unit, drugId, 'bolus', ctx), unit)} ${unit}`;
      const label = evt.deliveryMode === 'push' ? 'IV Push' : 'Bolus';
      if (hud) return { verb: label, value: val };
      return `${label} ${val}`;
    }
  } catch (e) {}

  if (variant === 'short') return null;
  if (hud) return { verb: evt.annotation || 'Event', value: '' };
  return evt.annotation || 'Event';
}
