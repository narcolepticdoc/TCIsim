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
 * Save the current case state.
 * Called after every model mutation.
 * 
 * @param {Object} state
 * @param {Object} state.patient - { age, weight, height, male, opioid }
 * @param {Object} state.events - { drugId: [event, ...] }
 * @param {string|null} state.wallClockStart - ISO string of case start time
 * @param {Object} state.modes - { drugId: modeString }
 * @param {Object} state.ceTargets - { drugId: number }
 * @param {Array} state.annotations - [{ time, text }]
 * @param {string} state.primaryDrug
 */
export function saveCase(state) {
  try {
    const json = JSON.stringify({
      v: 1, // schema version
      savedAt: new Date().toISOString(),
      ...state,
    });
    localStorage.setItem(STORAGE_KEY, json);
  } catch (e) {
    console.warn('[TCI Sim] Failed to save case:', e.message);
  }
}

/**
 * Load the last saved case, or null if none exists.
 * @returns {Object|null}
 */
export function loadCase() {
  try {
    const json = localStorage.getItem(STORAGE_KEY);
    if (!json) return null;
    const data = JSON.parse(json);
    if (!data || !data.patient || !data.events) return null;
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
 * Clear the saved case.
 */
export function clearSavedCase() {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch (e) {}
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
