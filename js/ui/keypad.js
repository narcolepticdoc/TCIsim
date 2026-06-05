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

import { toCanonical, fromCanonical, getAllowedUnits, getDefaultUnit, getPrefKey, formatValue, getRoundingNoteText }
  from '../util/units.js';
import { DRUG_DEFS, bolusDeliveryMinutes, pushDeliveryMinutes } from '../util/constants.js';

const $ = id => document.getElementById(id);

let buffer = '';
let currentType = 'ceTarget';  // 'ceTarget' | 'rate' | 'bolus' | 'intermittent' | 'exitCe'
let currentDrug = 'propofol';
let currentUnit = 'mcg/mL';
let onConfirm = null;          // (type, canonicalValue, displayText, deliveryMode) => void
let oneShotConfirm = null;     // one-shot callback for edit mode — overrides onConfirm
let getPatient = null;         // () => { weight, ... }
let getMode = null;            // () => mode string
let getCeTarget = null;        // () => current Ce target
let isTciDrug = null;          // () => bool — does the selected drug support TCI?
let getExitCe = null;          // () => current Exit Ce for selected drug
let getIntermittentThreshold = null; // () => current redose threshold for selected drug
let isPumpEnabled = null;      // () => bool — is an infusion pump enabled for the selected drug?
let prefilled = false;         // true when buffer is pre-populated, clears on first keypress
let currentRoundOverride = null; // bool when ceTarget modal exposes the round-in-display
                                 // override checkbox; null otherwise (= use global setting).

const TITLES = {
  ceTarget: 'Set Ce Target',
  rate: 'Set Manual Rate',
  bolus: 'Add Bolus',
  intermittent: 'Set Redose Threshold',
  exitCe: 'Set Emergence',
};

const CONFIRM_LABELS = {
  ceTarget: { label: 'Set Target', cls: 'modal-btn-confirm-target' },
  rate: { label: 'Set Rate', cls: 'modal-btn-confirm-rate' },
  bolus: { label: 'Pump Bolus', cls: 'modal-btn-confirm-bolus' },
  intermittent: { label: 'Set Threshold', cls: 'modal-btn-confirm-target' },
  exitCe: { label: 'Set Emergence', cls: 'modal-btn-confirm-exit' },
};

/**
 * Initialize keypad module.
 * @param {Object} opts
 * @param {Function} opts.onConfirm - (type, canonicalValue, displayText) => void
 * @param {Function} opts.getPatient - () => patient object
 * @param {Function} opts.getMode - () => current mode string
 * @param {Function} opts.getCeTarget - () => current Ce target
 * @param {Function} [opts.isTciDrug] - () => bool, true if selected drug supports TCI
 */
export function init(opts = {}) {
  onConfirm = opts.onConfirm || null;
  getPatient = opts.getPatient || (() => ({ weight: 70 }));
  getMode = opts.getMode || (() => 'none');
  getCeTarget = opts.getCeTarget || (() => 0);
  isTciDrug = opts.isTciDrug || (() => true);
  getExitCe = opts.getExitCe || (() => 0);
  getIntermittentThreshold = opts.getIntermittentThreshold || (() => 0);
  isPumpEnabled = opts.isPumpEnabled || (() => true);

  // Wire keypad buttons (numeric keys).
  // pointerdown (not click) so rapid taps register reliably — synthesized
  // click events can be coalesced or dropped under fast touch input.
  document.querySelectorAll('#modal-keypad .key').forEach(btn => {
    btn.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      handleKey(btn.textContent);
    });
  });

  // Wire control buttons
  const btnTarget = $('btn-target');
  const btnRate = $('btn-rate');
  const btnBolus = $('btn-bolus');
  const btnCancel = $('keypad-cancel-btn');
  const btnConfirm = $('keypad-confirm-btn');

  if (btnTarget) btnTarget.addEventListener('click', () => {
    if (isTciDrug()) show('ceTarget');
    else show('intermittent');
  });
  if (btnRate) btnRate.addEventListener('click', () => show('rate'));
  if (btnBolus) btnBolus.addEventListener('click', () => show('bolus'));
  if (btnCancel) btnCancel.addEventListener('click', close);
  if (btnConfirm) btnConfirm.addEventListener('click', () => confirm('pump'));

  const btnPush = $('keypad-push-btn');
  if (btnPush) btnPush.addEventListener('click', () => confirm('push'));

  const btnExit = $('btn-exit');
  if (btnExit) btnExit.addEventListener('click', () => show('exitCe'));

  const btnClear = $('keypad-clear-btn');
  if (btnClear) btnClear.addEventListener('click', () => {
    close();
    if (onConfirm) onConfirm(currentType, 0, '', 'clear');
  });

  const roundCb = $('keypad-round-in-display');
  if (roundCb) roundCb.addEventListener('change', () => {
    currentRoundOverride = roundCb.checked;
    updateRoundNote();
  });
}

function updateRoundNote() {
  const note = $('keypad-round-note');
  if (!note) return;
  const enabled = !!currentRoundOverride;
  note.textContent = getRoundingNoteText(currentDrug, enabled);
  note.classList.toggle('active', enabled);
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
  } else if (type === 'intermittent' && getIntermittentThreshold() > 0) {
    title = 'Change Redose Threshold';
  } else if (type === 'exitCe' && getExitCe() > 0) {
    title = 'Change Emergence';
  }
  $('keypad-title').textContent = title;

  // Restore preferred unit or use default
  // 'intermittent' and 'exitCe' use the same Ce units as 'ceTarget' for the selected drug
  const unitTask = (type === 'intermittent' || type === 'exitCe') ? 'ceTarget' : type;
  const allowed = getAllowedUnits(currentDrug, unitTask);
  const prefKey = getPrefKey(currentDrug, unitTask);
  let savedUnit = null;
  if (prefKey) {
    try { savedUnit = localStorage.getItem(prefKey); } catch (e) {}
  }
  currentUnit = (savedUnit && allowed.includes(savedUnit))
    ? savedUnit
    : (getDefaultUnit(currentDrug, unitTask) || allowed[0]);

  // Build unit toggle buttons (hide for exitCe — no unit conversion needed)
  if (type === 'exitCe') {
    const container = $('keypad-units');
    if (container) { container.innerHTML = ''; container.style.display = 'none'; }
  } else {
    renderUnitToggle(allowed);
  }

  // No pump, or threshold set + no infusion → bolus is always IV Push ("Administer" button)
  const isIntermittentBolus = (type === 'bolus') && (
    !isPumpEnabled() || (getIntermittentThreshold() > 0 && getMode() !== 'manual')
  );

  // Confirm button style
  const cc = CONFIRM_LABELS[type];
  const confirmBtn = $('keypad-confirm-btn');
  confirmBtn.textContent = isIntermittentBolus ? 'Administer' : cc.label;
  confirmBtn.className = isIntermittentBolus ? 'modal-btn-confirm-bolus' : cc.cls;

  // Show "IV Push" button only for bolus type when NOT in intermittent mode
  const pushBtn = $('keypad-push-btn');
  if (pushBtn) pushBtn.style.display = (type === 'bolus' && !isIntermittentBolus) ? '' : 'none';

  // Show "Clear" button for exitCe or intermittent when a value is already set
  const clearBtn = $('keypad-clear-btn');
  if (clearBtn) clearBtn.style.display =
    (type === 'exitCe' && getExitCe() > 0) ||
    (type === 'intermittent' && getIntermittentThreshold() > 0)
      ? '' : 'none';

  // Per-target rounding override: only relevant for ceTarget (TCI plan).
  // Defaults to the global config value each time the modal opens; toggles
  // are one-shot (not persisted) and apply only to the plan being confirmed.
  const roundRow = $('keypad-round-row');
  const roundCb  = $('keypad-round-in-display');
  if (type === 'ceTarget' && roundRow && roundCb) {
    let globalRound = false;
    try { globalRound = localStorage.getItem('tci-pref-quantizeInDisplay') === 'true'; }
    catch (e) {}
    roundCb.checked = globalRound;
    currentRoundOverride = globalRound;
    roundRow.style.display = '';
    updateRoundNote();
  } else {
    if (roundRow) roundRow.style.display = 'none';
    currentRoundOverride = null;
  }

  // Pre-fill if changing existing target
  if (type === 'ceTarget' && getMode() === 'tci' && getCeTarget() > 0) {
    buffer = getCeTarget().toString();
    prefilled = true;
  }

  // Pre-fill if changing existing Exit Ce (convert canonical → display unit)
  if (type === 'exitCe' && getExitCe() > 0) {
    const patient = getPatient();
    const ctx = { weightKg: patient?.weight || 70 };
    const displayVal = fromCanonical(getExitCe(), currentUnit, currentDrug, 'ceTarget', ctx);
    buffer = formatValue(displayVal, currentUnit);
    prefilled = true;
  }

  // Pre-fill if changing existing redose threshold
  if (type === 'intermittent' && getIntermittentThreshold() > 0) {
    const patient = getPatient();
    const ctx = { weightKg: patient?.weight || 70 };
    const displayVal = fromCanonical(getIntermittentThreshold(), currentUnit, currentDrug, 'ceTarget', ctx);
    buffer = formatValue(displayVal, currentUnit);
    prefilled = true;
  }

  // Pre-fill last rate for this drug (stored in canonical mg/min, converted to display unit)
  if (type === 'rate') {
    try {
      const lastMgMin = localStorage.getItem(`tci_lastRate_${currentDrug}`);
      if (lastMgMin) {
        const patient = getPatient();
        const ctx = { weightKg: patient?.weight || 70 };
        const displayVal = fromCanonical(parseFloat(lastMgMin), currentUnit, currentDrug, 'rate', ctx);
        buffer = formatValue(displayVal, currentUnit);
        prefilled = true;
      }
    } catch (e) {}
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
  const prev = currentUnit;
  currentUnit = u;
  const unitTask = (currentType === 'intermittent' || currentType === 'exitCe') ? 'ceTarget' : currentType;
  const convTask = (currentType === 'intermittent' || currentType === 'exitCe') ? 'ceTarget' : currentType;
  const prefKey = getPrefKey(currentDrug, unitTask);
  if (prefKey) {
    try { localStorage.setItem(prefKey, u); } catch (e) {}
  }
  // Update toggle button highlighting
  document.querySelectorAll('#keypad-units button').forEach(btn => {
    btn.classList.toggle('active', btn.textContent === u);
  });
  // Default behavior: convert the current buffer value from the previous unit
  // to the new unit. Preserves what the user typed (or what was pre-filled) and
  // re-arms `prefilled` so the next keypress overwrites.
  const v = parseFloat(buffer);
  if (!isNaN(v) && prev && prev !== u) {
    try {
      const patient = getPatient();
      const ctx = { weightKg: patient?.weight || 70 };
      const canonical = toCanonical(v, prev, currentDrug, convTask, ctx);
      const displayVal = fromCanonical(canonical.value, u, currentDrug, convTask, ctx);
      buffer = formatValue(displayVal, u);
      prefilled = true;
    } catch (e) { /* ignore conversion errors — leave buffer alone */ }
  } else if (buffer === '' && currentType === 'bolus') {
    // Nothing typed yet: reload the last saved bolus so the default reflects
    // recent drug practice in the new unit.
    try {
      const lastMg = localStorage.getItem(`tci_lastBolus_${currentDrug}`);
      if (lastMg) {
        const patient = getPatient();
        const ctx = { weightKg: patient?.weight || 70 };
        const displayVal = fromCanonical(parseFloat(lastMg), u, currentDrug, 'bolus', ctx);
        buffer = formatValue(displayVal, u);
        prefilled = true;
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

  // Estimated bolus delivery time — cleared here, populated below for bolus
  const bt = $('keypad-bolus-time');
  if (bt) bt.textContent = '';

  // Conversion preview (skip for exitCe — no unit conversion)
  const cv = $('keypad-conversion');
  if (!cv) return;
  if (currentType === 'exitCe') { cv.textContent = ''; return; }

  const v = parseFloat(buffer);
  const patient = getPatient();
  if (isNaN(v) || v <= 0 || !patient) { cv.textContent = ''; return; }

  try {
    const ctx = { weightKg: patient.weight };
    // 'intermittent' and 'exitCe' use ceTarget units for conversion
    const convTask = (currentType === 'intermittent' || currentType === 'exitCe') ? 'ceTarget' : currentType;
    const canonical = toCanonical(v, currentUnit, currentDrug, convTask, ctx);

    // Show conversion to other allowed units
    const allowed = getAllowedUnits(currentDrug, convTask);
    const others = allowed.filter(u => u !== currentUnit);

    const parts = others.map(u => {
      const displayVal = fromCanonical(canonical.value, u, currentDrug, convTask, ctx);
      return `${formatValue(displayVal, u)} ${u}`;
    });

    // If current unit isn't canonical, also show canonical
    if (currentUnit !== canonical.unit && !others.includes(canonical.unit)) {
      parts.unshift(`${formatValue(canonical.value, canonical.unit)} ${canonical.unit}`);
    }

    cv.textContent = parts.length > 0 ? '= ' + parts.join(' · ') : '';

    // For bolus, show how long the dose will be delivered over (canonical = mg).
    if (currentType === 'bolus') updateBolusTime(canonical.value);
  } catch (e) {
    cv.textContent = '';
  }
}

/**
 * Format a delivery duration (minutes) as "Ns" under a minute or "M:SS" above.
 */
function fmtDeliveryTime(minutes) {
  const sec = Math.max(1, Math.round(minutes * 60));
  if (sec < 60) return `${sec}s`;
  return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
}

/**
 * Populate the bolus-time line with the estimated delivery duration(s).
 * Shows both pump and push times when an infusion pump is available for the
 * dose, or just the push time when the bolus can only be given by hand.
 * @param {number} doseMg - bolus dose in canonical mg
 */
function updateBolusTime(doseMg) {
  const bt = $('keypad-bolus-time');
  if (!bt) return;
  if (!(doseMg > 0)) { bt.textContent = ''; return; }

  // Same condition as show(): no pump, or a redose threshold is set while not
  // in manual mode → the bolus is always an IV push.
  const isIntermittentBolus =
    !isPumpEnabled() || (getIntermittentThreshold() > 0 && getMode() !== 'manual');

  const pushT = fmtDeliveryTime(pushDeliveryMinutes(doseMg, currentDrug));
  if (isIntermittentBolus) {
    bt.textContent = `Given over ~${pushT}`;
  } else {
    const pumpT = fmtDeliveryTime(bolusDeliveryMinutes(doseMg, currentDrug));
    bt.textContent = `Given over ~${pumpT} pump · ~${pushT} push`;
  }
}

function confirm(deliveryMode) {
  const v = parseFloat(buffer);
  if (isNaN(v) || v < 0) return;

  const patient = getPatient();
  if (!patient) return;

  try {
    const ctx = { weightKg: patient.weight };
    // 'intermittent' and 'exitCe' use ceTarget units for conversion
    const convTask = (currentType === 'intermittent' || currentType === 'exitCe') ? 'ceTarget' : currentType;
    const canonical = toCanonical(v, currentUnit, currentDrug, convTask, ctx);

    // Build a human-readable display string for the annotation
    let displayText = `${buffer} ${currentUnit}`;
    if (currentUnit !== canonical.unit) {
      displayText += ` (${formatValue(canonical.value, canonical.unit)} ${canonical.unit})`;
    }

    // Remember bolus dose in canonical mg for quick re-dose
    if (currentType === 'bolus') {
      try { localStorage.setItem(`tci_lastBolus_${currentDrug}`, String(canonical.value)); } catch (e) {}
    }

    // Remember rate in canonical mg/min for quick resume
    if (currentType === 'rate') {
      try { localStorage.setItem(`tci_lastRate_${currentDrug}`, String(canonical.value)); } catch (e) {}
    }

    // Capture one-shot callback before close() clears it
    const oneShot = oneShotConfirm;
    oneShotConfirm = null;

    const extras = {
      roundOverride: currentType === 'ceTarget' ? currentRoundOverride : null,
    };

    close();
    if (oneShot) {
      oneShot(currentType, canonical.value, displayText, deliveryMode, extras);
    } else if (onConfirm) {
      onConfirm(currentType, canonical.value, displayText, deliveryMode, extras);
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
