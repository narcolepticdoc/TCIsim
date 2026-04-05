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
let intermittentThresholds = {}; // { drugId: number } — Ce redose threshold for intermittent mode
let onModeChange = null;

/** Drugs that support TCI (Ce targeting). All others use intermittent/manual only. */
const TCI_CAPABLE_DRUGS = new Set(['propofol', 'remifentanil']);

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
  if (newMode !== 'intermittent') intermittentThresholds[drugId] = 0;
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
 * Get the Ce redose threshold for intermittent mode.
 */
export function getIntermittentThreshold(drugId) {
  return intermittentThresholds[drugId] || 0;
}

/**
 * Set the Ce redose threshold for intermittent mode.
 */
export function setIntermittentThreshold(drugId, ce) {
  intermittentThresholds[drugId] = ce;
}

/**
 * Reset all mode state.
 */
export function reset() {
  for (const k of Object.keys(modes)) modes[k] = 'none';
  for (const k of Object.keys(ceTargets)) ceTargets[k] = 0;
  for (const k of Object.keys(intermittentThresholds)) intermittentThresholds[k] = 0;
  updateModeUI();
}

/**
 * Refresh the mode UI for a given drug (call when switching drug cards).
 */
export function refreshUI(drugId) {
  updateModeUI(drugId);
}

/**
 * Update the mode label and button highlights.
 * Handles both TCI-capable drugs (propofol) and intermittent-only drugs
 * (fentanyl, ketamine).
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

  // Default: show btn-rate (may be hidden below for intermittent)
  br.style.display = '';

  const resolvedDrug = drugId || 'propofol';
  const m = modes[resolvedDrug] || 'none';
  const isTci = TCI_CAPABLE_DRUGS.has(resolvedDrug);

  if (isTci) {
    // TCI-capable drug (propofol, remifentanil)
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
  } else {
    // Non-TCI drug (fentanyl, ketamine): two separate modes — intermittent or infusion
    if (m === 'intermittent') {
      // Bolus-only mode: no pump, hide rate button entirely
      br.style.display = 'none';
      ml.textContent = 'INTERMITTENT';
      ml.className = 'mode-label target-mode';
      bt.textContent = 'Change Threshold';
      bt.classList.add('active-mode');
    } else if (m === 'manual') {
      ml.textContent = 'INFUSION';
      ml.className = 'mode-label manual-mode';
      bt.textContent = 'Intermittent';
      br.classList.add('active-mode');
      bb.classList.add('active-mode');
    } else {
      ml.textContent = 'NO MODE';
      ml.className = 'mode-label no-mode';
      bt.textContent = 'Intermittent';
    }
  }
}
