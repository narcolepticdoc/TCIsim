/**
 * persist.js — Case State Persistence
 * 
 * Saves the minimum state needed to restore a case:
 * - Patient demographics
 * - All pump events (the event list)
 * - Wall clock start time
 * - Mode per drug
 * - Ce targets per drug
 * - Annotations
 * 
 * The model is deterministic — given patient + events, all
 * concentrations are reproducible. No need to save computed state.
 */

const STORAGE_KEY = 'tci-sim-last-case';

/**
 * Saved-case schema version. Bump ONLY on a BREAKING format change (fields
 * restructured or reinterpreted). Additive fields keep the version — the
 * restore path handles those with field-level fallbacks (e.g.
 * `evt.deliveryMode || 'pump'`). Both loadCase() and cloud-sync's
 * validateIncomingCase() refuse blobs from a NEWER schema than this build
 * understands, so a v2 case can never silently half-restore on a v1 app.
 */
export const CASE_SCHEMA_VERSION = 1;

/**
 * Save the current case state.
 * Called after every model mutation.
 *
 * @param {Object} state
 * @param {Object} state.patient - { age, weight, height, male, opioid }
 * @param {Object} state.events - { drugId: [event, ...] }
 * @param {string|null} state.wallClockStart - ISO string of case start time
 * @param {Object} state.modes - { drugId: modeString }
 * @param {Object} state.ceTargets - { drugId: number }
 * @param {Array} state.annotations - notations: [{ id, timeMin, time, heading, sub, drug }]
 * @param {string} state.primaryDrug
 */
export function saveCase(state) {
  try {
    const json = JSON.stringify({
      v: CASE_SCHEMA_VERSION,
      savedAt: new Date().toISOString(),
      // A pulled cloud blob carries its own v/savedAt, which survive this
      // spread — a v1 blob stays v1 rather than being re-stamped.
      ...state,
    });
    localStorage.setItem(STORAGE_KEY, json);
  } catch (e) {
    console.warn('[TCI Sim] Failed to save case:', e.message);
  }
}

/**
 * Load the last saved case, or null if none exists (or the blob is from a
 * newer schema than this build understands).
 * @returns {Object|null}
 */
export function loadCase() {
  try {
    const json = localStorage.getItem(STORAGE_KEY);
    if (!json) return null;
    const data = JSON.parse(json);
    if (!data || !data.patient || !data.events) return null;
    if (typeof data.v === 'number' && data.v > CASE_SCHEMA_VERSION) {
      console.warn(`[TCI Sim] Saved case is schema v${data.v}; this build understands v${CASE_SCHEMA_VERSION}. Refusing to half-restore.`);
      return null;
    }
    return data;
  } catch (e) {
    console.warn('[TCI Sim] Failed to load case:', e.message);
    return null;
  }
}

/**
 * Check if a saved case exists.
 * @returns {boolean}
 */
export function hasSavedCase() {
  try {
    return !!localStorage.getItem(STORAGE_KEY);
  } catch (e) {
    return false;
  }
}

/**
 * Get a brief summary of the saved case for display.
 * @returns {string|null}
 */
export function getSavedCaseSummary() {
  const data = loadCase();
  if (!data) return null;
  const p = data.patient;
  const eventCount = Object.values(data.events || {}).reduce((sum, arr) => sum + arr.length, 0);
  const savedAt = data.savedAt ? new Date(data.savedAt) : null;
  const timeStr = savedAt 
    ? savedAt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : '??';
  return `${p.age}y ${p.male ? 'M' : 'F'} ${p.weight}kg · ${eventCount} events · saved ${timeStr}`;
}
