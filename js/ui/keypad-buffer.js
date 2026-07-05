/**
 * keypad-buffer.js — Shared keypad-buffer semantics for the numeric modals.
 *
 * Pure, DOM-free helpers extracted from keypad.js / event-editor.js /
 * patient-modal.js / reconcile-modal.js, which each carried their own copy.
 * The semantics here are load-bearing (see CLAUDE.md invariants):
 *
 *   - Prefilled buffers replace on first keypress: a pre-populated buffer is
 *     flagged `prefilled`; the first digit/decimal/backspace CLEARS it
 *     instead of appending/deleting, and the flag then disarms.
 *   - Unit toggles convert, they don't clear: the buffer round-trips through
 *     toCanonical → fromCanonical and re-arms `prefilled = true` so the next
 *     keypress overwrites.
 *
 * Callers keep their own module state and DOM writes; these helpers only
 * transform values.
 */

import { toCanonical, fromCanonical, formatValue } from '../util/units.js';
import { bolusDeliveryMinutes, pushDeliveryMinutes } from '../util/constants.js';

/**
 * Apply one keypad key to a {buffer, prefilled} state. Returns the new state
 * (never mutates the input).
 *
 * @param {{buffer: string, prefilled: boolean}} state
 * @param {string} key - normalized: 'clear' | 'back' | '.' | a digit '0'-'9'
 * @param {{maxLen?: number, allowDecimal?: boolean}} [opts]
 * @returns {{buffer: string, prefilled: boolean}}
 */
export function applyBufferKey(state, key, opts = {}) {
  const maxLen = opts.maxLen ?? 8;
  const allowDecimal = opts.allowDecimal ?? true;
  let { buffer, prefilled } = state;

  if (key === 'clear') {
    return { buffer: '', prefilled: false };
  }
  if (key === 'back') {
    if (prefilled) return { buffer: '', prefilled: false };
    return { buffer: buffer.slice(0, -1), prefilled };
  }
  // Digit or decimal point: a prefilled buffer is replaced, not appended to
  if (prefilled) { buffer = ''; prefilled = false; }
  if (key === '.') {
    if (allowDecimal && !buffer.includes('.')) buffer += buffer ? '.' : '0.';
  } else if (/^[0-9]$/.test(key) && buffer.length < maxLen) {
    buffer += key;
  }
  return { buffer, prefilled };
}

/**
 * Convert a typed buffer between display units via the canonical round-trip
 * (drug-dose units only — metric/imperial demographics live in setup.js).
 *
 * @returns {{buffer: string, prefilled: true} | null}
 *          null = no-op (empty/NaN buffer, same unit, or conversion error) —
 *          the caller leaves its buffer alone.
 */
export function convertBufferUnit(buffer, prevUnit, newUnit, drugId, task, ctx) {
  const v = parseFloat(buffer);
  if (isNaN(v) || !prevUnit || prevUnit === newUnit) return null;
  try {
    const canonical = toCanonical(v, prevUnit, drugId, task, ctx);
    const displayVal = fromCanonical(canonical.value, newUnit, drugId, task, ctx);
    return { buffer: formatValue(displayVal, newUnit), prefilled: true };
  } catch (e) {
    return null; // leave buffer alone on conversion errors
  }
}

/**
 * Format a delivery duration (minutes) as "Ns" under a minute or "M:SS" above.
 */
export function fmtDeliveryTime(minutes) {
  const sec = Math.max(1, Math.round(minutes * 60));
  if (sec < 60) return `${sec}s`;
  return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
}

/**
 * Estimated bolus delivery line. The caller decides `pushOnly` (keypad: no
 * pump OR redose threshold set outside manual mode; event editor: pump off)
 * and writes the returned string to its own element.
 *
 * @param {number} doseMg - canonical mg
 * @param {string} drugId
 * @param {{pushOnly: boolean}} opts
 * @returns {string} '' when doseMg is not positive
 */
export function bolusTimeText(doseMg, drugId, { pushOnly }) {
  if (!(doseMg > 0)) return '';
  const pushT = fmtDeliveryTime(pushDeliveryMinutes(doseMg, drugId));
  if (pushOnly) return `Given over ~${pushT}`;
  const pumpT = fmtDeliveryTime(bolusDeliveryMinutes(doseMg, drugId));
  return `Given over ~${pumpT} pump · ~${pushT} push`;
}
