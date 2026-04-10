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
let exitCeTargets = {}; // { drugId: number } — Ce threshold for emergence / exit (persists across modes)
let exitCeLabels = {};  // { drugId: string } — display label for the button (e.g. "0.2 ng/mL")
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
 * Get the Exit Ce threshold for a drug (0 if not set).
 */
export function getExitCe(drugId) {
  return exitCeTargets[drugId] || 0;
}

/**
 * Set the Exit Ce threshold for a drug.
 * @param {string} drugId
 * @param {number} ce - canonical mcg/mL
 * @param {string} [label] - short display label for button (e.g. "0.2 ng/mL")
 */
export function setExitCe(drugId, ce, label) {
  exitCeTargets[drugId] = ce;
  exitCeLabels[drugId] = label || '';
  updateExitButton(drugId);
}

/**
 * Clear the Exit Ce threshold for a drug.
 */
export function clearExitCe(drugId) {
  exitCeTargets[drugId] = 0;
  exitCeLabels[drugId] = '';
  updateExitButton(drugId);
}

/**
 * Update the Exit Ce button label to reflect the current value.
 */
function updateExitButton(drugId) {
  const be = $('btn-exit');
  if (!be) return;
  const val = exitCeTargets[drugId] || 0;
  const label = exitCeLabels[drugId] || '';
  be.textContent = (val > 0 && label) ? `Exit ${label}` : (val > 0 ? `Exit ${val}` : 'Exit Ce');
}

/**
 * Reset all mode state.
 */
export function reset() {
  for (const k of Object.keys(modes)) modes[k] = 'none';
  for (const k of Object.keys(ceTargets)) ceTargets[k] = 0;
  for (const k of Object.keys(intermittentThresholds)) intermittentThresholds[k] = 0;
  for (const k of Object.keys(exitCeTargets)) exitCeTargets[k] = 0;
  for (const k of Object.keys(exitCeLabels)) exitCeLabels[k] = '';
  updateModeUI();
}

/**
 * Refresh the mode UI for a given drug (call when switching drug cards).
 */
export function refreshUI(drugId) {
  updateModeUI(drugId);
  updateExitButton(drugId);
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
      // Bolus-only mode; btn-rate visible as a clear "switch to infusion" action
      ml.textContent = 'INTERMITTENT';
      ml.className = 'mode-label target-mode';
      bt.textContent = 'Change Threshold';
      bt.classList.add('active-mode');
      br.textContent = 'Set Infusion Rate';  // label makes intent clear
    } else if (m === 'manual') {
      ml.textContent = 'INFUSION';
      ml.className = 'mode-label manual-mode';
      bt.textContent = 'Intermittent';
      br.textContent = 'Manual Rate';        // restore default label
      br.classList.add('active-mode');
      bb.classList.add('active-mode');
    } else {
      ml.textContent = 'NO MODE';
      ml.className = 'mode-label no-mode';
      bt.textContent = 'Intermittent';
      br.textContent = 'Manual Rate';        // restore default label
    }
  }
}
