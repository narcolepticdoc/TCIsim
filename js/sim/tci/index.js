/**
 * tci/index.js — TCI planner module barrel.
 *
 * Re-exports the four planner variants plus the convenience wrapper
 * planTCIFromEvents. Consumers should prefer importing from
 * '../sim/tci-planner.js' which is a thin shim over this module and
 * preserves the historical import path.
 *
 * Planner quick reference (see CLAUDE.md):
 *   stepped           — planTCIScheme                 (conservative, binary search)
 *   cet               — planTCISchemeCET              (fast onset, peak-matched bolus)
 *   cet-conservative  — planTCISchemeCETConservative  (SimTIVA-style, rate-corrected bolus)
 *   cet-emulation     — planTCISchemeEmulation        (SimTIVA deliver_cpt port, best accuracy)
 */

export { planTCIScheme } from './stepped.js';
export { planTCISchemeCET } from './cet.js';
export { planTCISchemeCETConservative } from './cet-conservative.js';
export { planTCISchemeEmulation } from './emulation.js';

import { planTCIScheme } from './stepped.js';

/**
 * Convenience: plan a TCI scheme from a given event list state.
 * Gets the last executed state for the drug and plans from there.
 *
 * Note: this wrapper always uses the Stepped planner. Callers that
 * want a different planner variant should call the specific
 * planTCIScheme{CET,CETConservative,Emulation} function directly.
 *
 * @param {Object} eventList - EventList instance
 * @param {string} drugId    - Drug ID
 * @param {number} ceTarget  - Target Ce (μg/mL)
 * @param {Object} [config]  - Scheme configuration
 * @returns {Array} Scheme events
 */
export function planTCIFromEvents(eventList, drugId, ceTarget, config = {}) {
  const engine = eventList.getEngine(drugId);
  if (!engine) return [];

  const { state, time } = eventList.getStateAtLastEvent(drugId);
  return planTCIScheme(engine, state, time, ceTarget, config);
}
