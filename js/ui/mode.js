/**
 * mode.js — Drug Mode Tracking
 * 
 * Tracks the current administration mode per drug: 'none', 'tci',
 * 'manual', or 'intermittent'. This is a UI concern — the model
 * layer just sees pump commands.
 * 
 * Mode transitions are reported via a callback so app.js can
 * annotate and update the UI.
 */

const $ = id => document.getElementById(id);

const modes = {};  // { drugId: 'none' | 'tci' | 'manual' | 'intermittent' }
let ceTargets = {}; // { drugId: number } — current Ce target per drug
let onModeChange = null;

/**
 * Initialize mode tracking.
 * @param {Object} opts
 * @param {Function} [opts.onModeChange] - (drugId, newMode, oldMode, detail) => void
 */
export function init(opts = {}) {
  onModeChange = opts.onModeChange || null;
}

/**
 * Get current mode for a drug.
 */
export function get(drugId) {
  return modes[drugId] || 'none';
}

/**
 * Set mode for a drug. Fires onModeChange callback.
 * @param {string} drugId
 * @param {string} newMode - 'none' | 'tci' | 'manual' | 'intermittent'
 * @param {string} [detail] - reason for the change
 */
export function set(drugId, newMode, detail) {
  const oldMode = modes[drugId] || 'none';
  modes[drugId] = newMode;
  if (newMode !== 'tci') ceTargets[drugId] = 0;
  if (onModeChange) onModeChange(drugId, newMode, oldMode, detail);
  updateModeUI(drugId);
}

/**
 * Get the current Ce target for a drug (0 if not in TCI).
 */
export function getCeTarget(drugId) {
  return ceTargets[drugId] || 0;
}

/**
 * Set the Ce target (called when entering TCI mode).
 */
export function setCeTarget(drugId, ce) {
  ceTargets[drugId] = ce;
}

/**
 * Reset all mode state.
 */
export function reset() {
  for (const k of Object.keys(modes)) modes[k] = 'none';
  for (const k of Object.keys(ceTargets)) ceTargets[k] = 0;
  updateModeUI();
}

/**
 * Update the mode label and button highlights.
 * Currently propofol-specific DOM; will generalize with multi-drug UI.
 */
function updateModeUI(drugId) {
  const ml = $('mode-label');
  const bt = $('btn-target');
  const br = $('btn-rate');
  const bb = $('btn-bolus');
  if (!ml || !bt || !br || !bb) return;

  bt.classList.remove('active-mode');
  br.classList.remove('active-mode');
  bb.classList.remove('active-mode');

  const m = modes[drugId || 'propofol'] || 'none';
  const ce = ceTargets[drugId || 'propofol'] || 0;

  if (m === 'tci') {
    ml.textContent = 'TARGET';
    ml.className = 'mode-label target-mode';
    bt.textContent = 'Change Target';
    bt.classList.add('active-mode');
  } else if (m === 'manual') {
    ml.textContent = 'MANUAL';
    ml.className = 'mode-label manual-mode';
    bt.textContent = 'Set Target';
    br.classList.add('active-mode');
    bb.classList.add('active-mode');
  } else {
    ml.textContent = 'NO MODE';
    ml.className = 'mode-label no-mode';
    bt.textContent = 'Set Target';
  }
}
