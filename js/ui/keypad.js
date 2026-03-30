/**
 * keypad.js — Keypad Modal Controller
 * 
 * Handles the numeric keypad modal for entering targets, rates, and
 * bolus doses. Uses units.js for all conversions. Keeps the existing
 * HTML/CSS keypad structure — no dynamic DOM generation.
 * 
 * On confirm, calls the provided callback with canonical values.
 * The keypad never touches the model directly.
 */

import { toCanonical, fromCanonical, getAllowedUnits, getDefaultUnit, getPrefKey, formatValue }
  from '../util/units.js';
import { DRUG_DEFS } from '../util/constants.js';

const $ = id => document.getElementById(id);

let buffer = '';
let currentType = 'ceTarget';  // 'ceTarget' | 'rate' | 'bolus'
let currentDrug = 'propofol';
let currentUnit = 'mcg/mL';
let onConfirm = null;          // (type, canonicalValue, displayText, deliveryMode) => void
let oneShotConfirm = null;     // one-shot callback for edit mode — overrides onConfirm
let getPatient = null;         // () => { weight, ... }
let getMode = null;            // () => mode string
let getCeTarget = null;        // () => current Ce target
let prefilled = false;         // true when buffer is pre-populated, clears on first keypress

const TITLES = {
  ceTarget: 'Set Ce Target',
  rate: 'Set Manual Rate',
  bolus: 'Add Bolus',
};

const CONFIRM_LABELS = {
  ceTarget: { label: 'Set Target', cls: 'modal-btn-confirm-target' },
  rate: { label: 'Set Rate', cls: 'modal-btn-confirm-rate' },
  bolus: { label: 'Pump Bolus', cls: 'modal-btn-confirm-bolus' },
};

/**
 * Initialize keypad module.
 * @param {Object} opts
 * @param {Function} opts.onConfirm - (type, canonicalValue, displayText) => void
 * @param {Function} opts.getPatient - () => patient object
 * @param {Function} opts.getMode - () => current mode string
 * @param {Function} opts.getCeTarget - () => current Ce target
 */
export function init(opts = {}) {
  onConfirm = opts.onConfirm || null;
  getPatient = opts.getPatient || (() => ({ weight: 70 }));
  getMode = opts.getMode || (() => 'none');
  getCeTarget = opts.getCeTarget || (() => 0);

  // Wire keypad buttons (numeric keys)
  document.querySelectorAll('#modal-keypad .key').forEach(btn => {
    btn.addEventListener('click', () => {
      const k = btn.textContent;
      handleKey(k);
    });
  });

  // Wire control buttons
  const btnTarget = $('btn-target');
  const btnRate = $('btn-rate');
  const btnBolus = $('btn-bolus');
  const btnCancel = $('keypad-cancel-btn');
  const btnConfirm = $('keypad-confirm-btn');

  if (btnTarget) btnTarget.addEventListener('click', () => show('ceTarget'));
  if (btnRate) btnRate.addEventListener('click', () => show('rate'));
  if (btnBolus) btnBolus.addEventListener('click', () => show('bolus'));
  if (btnCancel) btnCancel.addEventListener('click', close);
  if (btnConfirm) btnConfirm.addEventListener('click', () => confirm('pump'));

  const btnPush = $('keypad-push-btn');
  if (btnPush) btnPush.addEventListener('click', () => confirm('push'));
}

/**
 * Show the keypad modal for a given type.
 */
export function show(type) {
  currentType = type;
  buffer = '';

  // Determine title
  let title = TITLES[type] || 'Enter Value';
  if (type === 'ceTarget' && getMode() === 'tci' && getCeTarget() > 0) {
    title = 'Change Ce Target';
  }
  $('keypad-title').textContent = title;

  // Restore preferred unit or use default
  const allowed = getAllowedUnits(currentDrug, type);
  const prefKey = getPrefKey(currentDrug, type);
  let savedUnit = null;
  if (prefKey) {
    try { savedUnit = localStorage.getItem(prefKey); } catch (e) {}
  }
  currentUnit = (savedUnit && allowed.includes(savedUnit))
    ? savedUnit
    : (getDefaultUnit(currentDrug, type) || allowed[0]);

  // Build unit toggle buttons
  renderUnitToggle(allowed);

  // Confirm button style
  const cc = CONFIRM_LABELS[type];
  const confirmBtn = $('keypad-confirm-btn');
  confirmBtn.textContent = cc.label;
  confirmBtn.className = cc.cls;

  // Show "Push Bolus" button only for bolus type
  const pushBtn = $('keypad-push-btn');
  if (pushBtn) pushBtn.style.display = (type === 'bolus') ? '' : 'none';

  // Pre-fill if changing existing target
  if (type === 'ceTarget' && getMode() === 'tci' && getCeTarget() > 0) {
    buffer = getCeTarget().toString();
    prefilled = true;
  }

  // Pre-fill last bolus dose for this drug (stored in canonical mg, converted to display unit)
  if (type === 'bolus') {
    try {
      const lastMg = localStorage.getItem(`tci_lastBolus_${currentDrug}`);
      if (lastMg) {
        const patient = getPatient();
        const ctx = { weightKg: patient?.weight || 70 };
        const displayVal = fromCanonical(parseFloat(lastMg), currentUnit, currentDrug, 'bolus', ctx);
        buffer = formatValue(displayVal, currentUnit);
        prefilled = true;
      }
    } catch (e) {}
  }

  updateDisplay();
  $('modal-keypad').classList.add('open');
}

function close() {
  $('modal-keypad').classList.remove('open');
  oneShotConfirm = null; // clear one-shot if user cancels
}

function handleKey(k) {
  if (k === 'C') { buffer = ''; prefilled = false; }
  else if (k === '⌫') { if (prefilled) { buffer = ''; prefilled = false; } else { buffer = buffer.slice(0, -1); } }
  else {
    if (prefilled) { buffer = ''; prefilled = false; }
    if (k === '.') { if (!buffer.includes('.')) buffer += buffer ? '.' : '0.'; }
    else { if (buffer.length < 8) buffer += k; }
  }
  updateDisplay();
}

function setUnit(u) {
  currentUnit = u;
  const prefKey = getPrefKey(currentDrug, currentType);
  if (prefKey) {
    try { localStorage.setItem(prefKey, u); } catch (e) {}
  }
  // Update toggle button highlighting
  document.querySelectorAll('#keypad-units button').forEach(btn => {
    btn.classList.toggle('active', btn.textContent === u);
  });
  // Reload last bolus dose converted to new unit (if switching units in bolus mode)
  if (currentType === 'bolus') {
    try {
      const lastMg = localStorage.getItem(`tci_lastBolus_${currentDrug}`);
      if (lastMg) {
        const patient = getPatient();
        const ctx = { weightKg: patient?.weight || 70 };
        const displayVal = fromCanonical(parseFloat(lastMg), u, currentDrug, 'bolus', ctx);
        buffer = formatValue(displayVal, u);
        prefilled = true;
      } else {
        buffer = '';
        prefilled = false;
      }
    } catch (e) {}
  }
  updateDisplay();
}

function renderUnitToggle(allowed) {
  const container = $('keypad-units');
  if (!container) return;
  container.innerHTML = '';
  container.style.display = 'flex';
  allowed.forEach(u => {
    const btn = document.createElement('button');
    btn.textContent = u;
    btn.className = u === currentUnit ? 'active' : '';
    btn.addEventListener('click', () => setUnit(u));
    container.appendChild(btn);
  });
}

function updateDisplay() {
  // Main value display
  const el = $('keypad-value');
  if (el) {
    el.textContent = buffer || '0';
    el.classList.toggle('empty', !buffer);
  }

  // Conversion preview
  const cv = $('keypad-conversion');
  if (!cv) return;

  const v = parseFloat(buffer);
  const patient = getPatient();
  if (isNaN(v) || v <= 0 || !patient) { cv.textContent = ''; return; }

  try {
    const ctx = { weightKg: patient.weight };
    const canonical = toCanonical(v, currentUnit, currentDrug, currentType, ctx);

    // Show conversion to other allowed units
    const allowed = getAllowedUnits(currentDrug, currentType);
    const others = allowed.filter(u => u !== currentUnit);

    const parts = others.map(u => {
      const displayVal = fromCanonical(canonical.value, u, currentDrug, currentType, ctx);
      return `${formatValue(displayVal, u)} ${u}`;
    });

    // If current unit isn't canonical, also show canonical
    if (currentUnit !== canonical.unit && !others.includes(canonical.unit)) {
      parts.unshift(`${formatValue(canonical.value, canonical.unit)} ${canonical.unit}`);
    }

    cv.textContent = parts.length > 0 ? '= ' + parts.join(' · ') : '';
  } catch (e) {
    cv.textContent = '';
  }
}

function confirm(deliveryMode) {
  const v = parseFloat(buffer);
  if (isNaN(v) || v < 0) return;

  const patient = getPatient();
  if (!patient) return;

  try {
    const ctx = { weightKg: patient.weight };
    const canonical = toCanonical(v, currentUnit, currentDrug, currentType, ctx);

    // Build a human-readable display string for the annotation
    let displayText = `${buffer} ${currentUnit}`;
    if (currentUnit !== canonical.unit) {
      displayText += ` (${formatValue(canonical.value, canonical.unit)} ${canonical.unit})`;
    }

    // Remember bolus dose in canonical mg for quick re-dose
    if (currentType === 'bolus') {
      try { localStorage.setItem(`tci_lastBolus_${currentDrug}`, String(canonical.value)); } catch (e) {}
    }

    // Capture one-shot callback before close() clears it
    const oneShot = oneShotConfirm;
    oneShotConfirm = null;

    close();
    if (oneShot) {
      oneShot(currentType, canonical.value, displayText, deliveryMode);
    } else if (onConfirm) {
      onConfirm(currentType, canonical.value, displayText, deliveryMode);
    }
  } catch (e) {
    console.error('[TCI Sim] Keypad confirm error:', e);
  }
}

/**
 * Set a one-shot confirm callback for edit mode.
 * Overrides the normal onConfirm for the next confirm only.
 * Cleared on close if not used.
 */
export function setOneShotConfirm(cb) {
  oneShotConfirm = cb;
}

/**
 * Set the active drug for the keypad.
 */
export function setDrug(drugId) {
  currentDrug = drugId;
}
