/**
 * setup.js — Setup Screen Controller
 * 
 * Handles patient demographics form: unit toggle (metric/imperial),
 * input validation, derived values display (BMI, FFM, Ce50),
 * and patient confirmation.
 * 
 * Replaces the inline calcFFM() and calcCe50() from index.html
 * with calls to the real eleveld.js functions. The inline calcCe50
 * had the wrong coefficient (-0.0517); this module uses the correct
 * value via calcEleveldParams().
 */

import {
  calcEleveldParams,
  fatFreeMass,
  MODEL_NAME as ELEVELD_MODEL_NAME,
  MODEL_DESCRIPTION as ELEVELD_MODEL_DESCRIPTION,
} from '../pk/eleveld.js';
import {
  MODEL_NAME as FENTANYL_MODEL_NAME,
  MODEL_DESCRIPTION as FENTANYL_MODEL_DESCRIPTION,
} from '../pk/fentanyl.js';
import {
  MODEL_NAME as KETAMINE_MODEL_NAME,
  MODEL_DESCRIPTION as KETAMINE_MODEL_DESCRIPTION,
} from '../pk/ketamine.js';
import { setPumpSettings, getPumpSettings } from '../util/constants.js';
import { getAllowedUnits, getDefaultUnit, getPrefKey, getQuantStep } from '../util/units.js';

// Drugs that have a tabbed setup panel. Remifentanil has no PK model yet.
const SETUP_DRUGS = ['propofol', 'fentanyl', 'ketamine'];

// Model display metadata for the setup-screen info block, keyed by drug id.
// Imported directly from each PK module so the setup screen shows accurate
// provenance without needing a live model instance (model is only created
// on confirmPatient()).
const MODEL_INFO = {
  propofol: { name: ELEVELD_MODEL_NAME,  description: ELEVELD_MODEL_DESCRIPTION  },
  fentanyl: { name: FENTANYL_MODEL_NAME, description: FENTANYL_MODEL_DESCRIPTION },
  ketamine: { name: KETAMINE_MODEL_NAME, description: KETAMINE_MODEL_DESCRIPTION },
};

const $ = id => document.getElementById(id);

let currentUnits = 'metric';
let onConfirm = null; // callback: (patient) => void

/**
 * Initialize the setup screen.
 * @param {Object} opts
 * @param {Function} opts.onConfirm - called with patient object when confirmed
 */
export function init(opts = {}) {
  onConfirm = opts.onConfirm || null;

  // Restore saved unit preference
  restoreUnits();

  // Wire input listeners for live validation and derived values
  ['input-age', 'input-height', 'input-weight'].forEach(id => {
    const el = $(id);
    if (el) {
      el.addEventListener('input', () => {
        updatePreviews();
        updateDerived();
        const row = el.closest('.form-row');
        if (row) row.classList.remove('error');
      });
    }
  });

  // Select fires 'change', not 'input'
  const sexEl = $('input-sex');
  if (sexEl) {
    sexEl.addEventListener('change', () => {
      updatePreviews();
      updateDerived();
      const row = sexEl.closest('.form-row');
      if (row) row.classList.remove('error');
    });
  }

  // Wire unit toggle buttons
  const btnMetric = $('btn-metric');
  const btnImperial = $('btn-imperial');
  if (btnMetric) btnMetric.addEventListener('click', () => setUnits('metric'));
  if (btnImperial) btnImperial.addEventListener('click', () => setUnits('imperial'));

  // Wire confirm button
  const btnConfirm = $('btn-confirm');
  if (btnConfirm) btnConfirm.addEventListener('click', confirmPatient);

  // Wire drug setup tabs
  ['propofol', 'fentanyl', 'ketamine'].forEach(d => {
    const tab = $(`setup-tab-${d}`);
    if (tab) tab.addEventListener('click', () => switchDrugTab(d));
  });

  // Wire global Max Pump Rate — single control that drives all three drugs
  const maxRateEl = $('input-max-pump-rate');
  if (maxRateEl) maxRateEl.addEventListener('change', updateAllPumpDerived);

  // Wire pump settings (propofol)
  const concEl = $('input-concentration');
  const tciModeEl = $('input-tci-mode');
  const opioidEl = $('input-opioid');
  if (concEl) concEl.addEventListener('change', updatePumpDerived);
  if (opioidEl) opioidEl.addEventListener('change', () => {
    updateDerived();
    updateCe50CorrectionVisibility();
  });

  // Wire pump settings (fentanyl)
  const fentConcEl = $('input-fentanyl-concentration');
  if (fentConcEl) fentConcEl.addEventListener('change', updatePumpDerivedFentanyl);

  // Wire pump settings (ketamine)
  const ketConcEl = $('input-ketamine-concentration');
  if (ketConcEl) ketConcEl.addEventListener('change', updatePumpDerivedKetamine);

  // Wire Ce50 opioid correction checkbox
  const ce50CorrEl = $('input-ce50-correction');
  if (ce50CorrEl) ce50CorrEl.addEventListener('change', () => { updateDerived(); });

  // Set initial visibility based on restored opioid value
  updateCe50CorrectionVisibility();

  // Populate model info blocks and default-unit selectors for each drug panel
  populateModelInfo();
  populateUnitSelectors();

  // Wire the "round in display units" checkbox + per-drug rounding-note line
  populateRoundingControls();

  // Restore saved pump settings
  restorePumpSettingsUI();
  updateAllPumpDerived();
}

// ---- Model info block ----

function populateModelInfo() {
  for (const drugId of SETUP_DRUGS) {
    const info = MODEL_INFO[drugId];
    if (!info) continue;
    const nameEl = $(`model-info-name-${drugId}`);
    const descEl = $(`model-info-desc-${drugId}`);
    if (nameEl) nameEl.textContent = info.name;
    if (descEl) descEl.textContent = info.description;
  }
}

// ---- Default unit selectors ----

/**
 * Build the bolus/rate unit <select> options for each drug panel and
 * preselect the saved preference (or the hardcoded default).
 *
 * Reads from the same `prefKey` localStorage keys that drug-panel.js and
 * the keypad use at runtime, so mid-case overrides and setup defaults
 * share a single source of truth.
 */
function populateUnitSelectors() {
  for (const drugId of SETUP_DRUGS) {
    for (const task of ['bolus', 'rate']) {
      const sel = $(`input-${drugId}-${task}-unit`);
      if (!sel) continue;

      const allowed = getAllowedUnits(drugId, task) || [];
      sel.innerHTML = '';
      for (const unit of allowed) {
        const opt = document.createElement('option');
        opt.value = unit;
        opt.textContent = unit;
        sel.appendChild(opt);
      }

      // Preselect from localStorage prefKey, falling back to the static default.
      let current = getDefaultUnit(drugId, task);
      const key = getPrefKey(drugId, task);
      if (key) {
        try {
          const saved = localStorage.getItem(key);
          if (saved && allowed.includes(saved)) current = saved;
        } catch (e) {}
      }
      if (current && allowed.includes(current)) sel.value = current;
    }
  }
}

// ---- Round TCI plan in display units (opt-in) ----

/**
 * Wire the "round in display units" checkbox and the per-drug rounding-note
 * lines. The checkbox state is persisted under `tci-pref-quantizeInDisplay`,
 * which simulation.js reads via getQuantizeConfig() on every plan call.
 *
 * The rounding-note under each drug's unit selectors updates live whenever
 * the user changes a unit selector or toggles the checkbox, so the clinician
 * can see exactly what grid the planner is going to use.
 */
function populateRoundingControls() {
  const cb = $('input-round-in-display');

  // Restore saved checkbox state
  if (cb) {
    try {
      const saved = localStorage.getItem('tci-pref-quantizeInDisplay');
      cb.checked = saved === 'true';
    } catch (e) {}

    cb.addEventListener('change', () => {
      try {
        localStorage.setItem('tci-pref-quantizeInDisplay',
          cb.checked ? 'true' : 'false');
      } catch (e) {}
      updateAllRoundingNotes();
    });
  }

  // Listen on every unit selector so the note reflects the current selection
  for (const drugId of SETUP_DRUGS) {
    for (const task of ['bolus', 'rate']) {
      const sel = $(`input-${drugId}-${task}-unit`);
      if (sel) sel.addEventListener('change', () => updateRoundingNote(drugId));
    }
  }

  updateAllRoundingNotes();
}

function updateAllRoundingNotes() {
  for (const drugId of SETUP_DRUGS) updateRoundingNote(drugId);
}

/**
 * Write the rounding-note line for a single drug. Shows the current grid
 * (e.g., "bolus → nearest 10 mcg/kg, rate → nearest 1 mL/h") when the
 * checkbox is on, or an off-state hint explaining how to enable it.
 */
function updateRoundingNote(drugId) {
  const note = $(`rounding-note-${drugId}`);
  if (!note) return;

  const cb = $('input-round-in-display');
  const enabled = !!(cb && cb.checked);
  note.classList.toggle('active', enabled);

  if (!enabled) {
    note.textContent =
      'Planner rounds in engine-canonical units (mg / mg/min). ' +
      'Enable "Round TCI plan in display units" to align with your selected units.';
    return;
  }

  const bolusSel = $(`input-${drugId}-bolus-unit`);
  const rateSel  = $(`input-${drugId}-rate-unit`);
  const bolusUnit = bolusSel?.value || getDefaultUnit(drugId, 'bolus');
  const rateUnit  = rateSel?.value  || getDefaultUnit(drugId, 'rate');
  const bolusStep = getQuantStep(drugId, 'bolus', bolusUnit);
  const rateStep  = getQuantStep(drugId, 'rate',  rateUnit);

  const bolusPart = bolusStep != null
    ? `bolus → nearest ${formatStep(bolusStep)} ${bolusUnit}`
    : `bolus → ${bolusUnit} (no rounding)`;
  const ratePart = rateStep != null
    ? `rate → nearest ${formatStep(rateStep)} ${rateUnit}`
    : `rate → ${rateUnit} (no rounding)`;

  note.textContent = `Plan rounds to: ${bolusPart}, ${ratePart}`;
}

/** Strip trailing zeros from a step size (0.10 → 0.1, 1 → 1, 0.25 → 0.25). */
function formatStep(step) {
  return Number.isInteger(step) ? String(step) : String(parseFloat(step.toFixed(4)));
}

// ---- Ce50 opioid correction visibility ----

function updateCe50CorrectionVisibility() {
  const opioidEl = $('input-opioid');
  const row = $('ce50-correction-row');
  if (!row) return;
  const withOpioid = opioidEl ? opioidEl.value === 'true' : false;
  row.style.display = withOpioid ? '' : 'none';
  if (!withOpioid) {
    const cb = $('input-ce50-correction');
    if (cb) cb.checked = false;
  }
}

// ---- Units ----

function setUnits(u) {
  currentUnits = u;
  try { localStorage.setItem('tci-sim-units', u); } catch (e) {}

  $('btn-metric').classList.toggle('active', u === 'metric');
  $('btn-imperial').classList.toggle('active', u === 'imperial');

  if (u === 'imperial') {
    $('hint-height').textContent = '(inches)';
    $('hint-weight').textContent = '(lbs)';
    $('input-height').placeholder = '67';
    $('input-weight').placeholder = '154';
  } else {
    $('hint-height').textContent = '(cm)';
    $('hint-weight').textContent = '(kg)';
    $('input-height').placeholder = '170';
    $('input-weight').placeholder = '70';
  }

  // Clear values when switching units to avoid confusion
  $('input-height').value = '';
  $('input-weight').value = '';
  updatePreviews();
  updateDerived();
}

function restoreUnits() {
  try {
    const s = localStorage.getItem('tci-sim-units');
    if (s === 'imperial' || s === 'metric') { setUnits(s); return; }
  } catch (e) {}
  setUnits('metric');
}

export function getUnits() { return currentUnits; }

// ---- Unit conversion ----

function getHeightCm() {
  const r = parseFloat($('input-height').value);
  return isNaN(r) ? NaN : currentUnits === 'imperial' ? r * 2.54 : r;
}

function getWeightKg() {
  const r = parseFloat($('input-weight').value);
  return isNaN(r) ? NaN : currentUnits === 'imperial' ? r * 0.453592 : r;
}

// ---- Metric previews (shown when imperial units selected) ----

function updatePreviews() {
  const hp = $('preview-height'), wp = $('preview-weight');
  if (currentUnits === 'imperial') {
    const h = getHeightCm(), w = getWeightKg();
    if (!isNaN(h) && h > 0) {
      hp.textContent = `→ ${h.toFixed(1)} cm`;
      hp.classList.remove('hidden');
    } else hp.classList.add('hidden');
    if (!isNaN(w) && w > 0) {
      wp.textContent = `→ ${w.toFixed(1)} kg`;
      wp.classList.remove('hidden');
    } else wp.classList.add('hidden');
  } else {
    hp.classList.add('hidden');
    wp.classList.add('hidden');
  }
}

// ---- Derived values (BMI, FFM, Ce50) ----

function updateDerived() {
  try {
    const a = parseInt($('input-age').value);
    const s = $('input-sex').value;
    const h = getHeightCm();
    const w = getWeightKg();

    if (!isNaN(a) && a > 0 && s && !isNaN(h) && h > 30 && !isNaN(w) && w > 0) {
      const male = s === 'male';
      const bmi = w / Math.pow(h / 100, 2);
      const ffm = fatFreeMass(w, h, a, male);

      // Use the real Eleveld params to get Ce50 (not the old inline formula)
      const opioidEl = $('input-opioid');
      const opioid = opioidEl ? opioidEl.value === 'true' : false;
      const ce50OpioidCorrection = $('input-ce50-correction')?.checked ?? false;
      const params = calcEleveldParams({ age: a, weight: w, height: h, male, opioid, ce50OpioidCorrection });

      $('derived-bmi').textContent = bmi.toFixed(1);
      $('derived-ffm').textContent = ffm.toFixed(1) + ' kg';
      $('derived-ce50').textContent = params.Ce50.toFixed(2) + ' μg/mL';
      $('derived-bar').style.display = 'flex';
    } else {
      $('derived-bar').style.display = 'none';
    }
  } catch (err) {
    console.error('[TCI Sim] updateDerived error:', err);
    $('derived-bar').style.display = 'none';
  }
}

// ---- Validation ----

function validate() {
  let ok = true;

  const a = parseInt($('input-age').value);
  if (isNaN(a) || a < 1 || a > 100) {
    $('err-age').textContent = $('input-age').value !== '' ? '1–100' : '';
    $('row-age').classList.toggle('error', $('input-age').value !== '');
    ok = false;
  } else {
    $('err-age').textContent = '';
    $('row-age').classList.remove('error');
  }

  if (!$('input-sex').value) ok = false;

  const h = getHeightCm();
  if (isNaN(h) || h < 30 || h > 250) {
    if ($('input-height').value !== '') {
      $('err-height').textContent = 'Valid height required';
      $('row-height').classList.add('error');
    }
    ok = false;
  } else {
    $('err-height').textContent = '';
    $('row-height').classList.remove('error');
  }

  const w = getWeightKg();
  if (isNaN(w) || w < 0.5 || w > 300) {
    if ($('input-weight').value !== '') {
      $('err-weight').textContent = 'Valid weight required';
      $('row-weight').classList.add('error');
    }
    ok = false;
  } else {
    $('err-weight').textContent = '';
    $('row-weight').classList.remove('error');
  }

  return ok;
}

// ---- Confirm ----

function confirmPatient() {
  try {
    if (!validate()) return;

    const opioidEl = $('input-opioid');
    const patient = {
      age: parseInt($('input-age').value),
      weight: Math.round(getWeightKg() * 10) / 10,
      height: Math.round(getHeightCm() * 10) / 10,
      male: $('input-sex').value === 'male',
      opioid: opioidEl ? opioidEl.value === 'true' : false,
      ce50OpioidCorrection: $('input-ce50-correction')?.checked ?? false,
    };

    // Apply pump settings before confirming
    applyPumpSettings();

    if (onConfirm) onConfirm(patient);
  } catch (err) {
    console.error('[TCI Sim] confirmPatient error:', err);
  }
}

// ---- Pump settings ----

function applyPumpSettings() {
  const concEl = $('input-concentration');
  const maxRateEl = $('input-max-pump-rate');
  const tciModeEl = $('input-tci-mode');
  const opioidEl = $('input-opioid');
  if (!concEl || !maxRateEl) return;

  const concentration = parseFloat(concEl.value) || 10;
  const bolusRateMlH = parseFloat(maxRateEl.value) || 750;

  setPumpSettings('propofol', { concentration, bolusRateMlH });

  // Fentanyl settings — same global rate, per-drug concentration
  const fentConcEl = $('input-fentanyl-concentration');
  if (fentConcEl) {
    const fConc = parseFloat(fentConcEl.value) || 0.05;
    setPumpSettings('fentanyl', { concentration: fConc, bolusRateMlH });
    try {
      localStorage.setItem('tci-pump-concentration-fentanyl', String(fConc));
    } catch (e) {}
  }

  // Ketamine settings — same global rate, per-drug concentration
  const ketConcEl = $('input-ketamine-concentration');
  if (ketConcEl) {
    const kConc = parseFloat(ketConcEl.value) || 10;
    setPumpSettings('ketamine', { concentration: kConc, bolusRateMlH });
    try {
      localStorage.setItem('tci-pump-concentration-ketamine', String(kConc));
    } catch (e) {}
  }

  // Save propofol concentration + global pump rate + mode/opioid to localStorage
  try {
    localStorage.setItem('tci-pump-concentration', String(concentration));
    localStorage.setItem('tci-pump-max-rate', String(bolusRateMlH));
    if (tciModeEl) localStorage.setItem('tci-mode', tciModeEl.value);
    if (opioidEl) localStorage.setItem('tci-opioid', opioidEl.value);
    const ce50CorrEl2 = $('input-ce50-correction');
    if (ce50CorrEl2) localStorage.setItem('tci-ce50-correction', ce50CorrEl2.checked ? 'true' : 'false');
  } catch (e) {}

  // Persist default-unit selections to the same prefKey localStorage keys
  // that drug-panel.js and the keypad read at runtime. Skip silently on
  // invalid values so the existing runtime preference survives.
  for (const drugId of SETUP_DRUGS) {
    for (const task of ['bolus', 'rate']) {
      const el = $(`input-${drugId}-${task}-unit`);
      if (!el || !el.value) continue;
      const allowed = getAllowedUnits(drugId, task) || [];
      if (!allowed.includes(el.value)) continue;
      const key = getPrefKey(drugId, task);
      if (!key) continue;
      try { localStorage.setItem(key, el.value); } catch (e) {}
    }
  }

  // Persist "round TCI plan in display units" opt-in (redundant with the
  // change listener in populateRoundingControls, but mirrors the existing
  // on-confirm pattern for the other unit preferences).
  const roundEl = $('input-round-in-display');
  if (roundEl) {
    try {
      localStorage.setItem('tci-pref-quantizeInDisplay',
        roundEl.checked ? 'true' : 'false');
    } catch (e) {}
  }
}

function restorePumpSettingsUI() {
  try {
    const savedConc = localStorage.getItem('tci-pump-concentration');
    // Read the new global key first, falling back to the legacy per-propofol
    // `tci-pump-rate` key for one-shot silent migration from pre-0.5.19.1.
    const savedRate = localStorage.getItem('tci-pump-max-rate')
                   ?? localStorage.getItem('tci-pump-rate');
    const savedMode = localStorage.getItem('tci-mode');
    const savedOpioid = localStorage.getItem('tci-opioid');

    if (savedConc) { const el = $('input-concentration'); if (el) el.value = savedConc; }
    if (savedRate) { const el = $('input-max-pump-rate'); if (el) el.value = savedRate; }
    if (savedMode) { const el = $('input-tci-mode'); if (el) el.value = savedMode; }
    if (savedOpioid) { const el = $('input-opioid'); if (el) el.value = savedOpioid; }
    const savedCe50Corr = localStorage.getItem('tci-ce50-correction');
    if (savedCe50Corr) { const el = $('input-ce50-correction'); if (el) el.checked = savedCe50Corr === 'true'; }
  } catch (e) {}

  // Restore fentanyl concentration
  try {
    const fc = localStorage.getItem('tci-pump-concentration-fentanyl');
    if (fc) { const el = $('input-fentanyl-concentration'); if (el) el.value = fc; }
  } catch (e) {}

  // Restore ketamine concentration
  try {
    const kc = localStorage.getItem('tci-pump-concentration-ketamine');
    if (kc) { const el = $('input-ketamine-concentration'); if (el) el.value = kc; }
  } catch (e) {}
}

// ---- Drug setup tab switching ----

function switchDrugTab(drugId) {
  document.querySelectorAll('.drug-setup-tab').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('.drug-setup-panel').forEach(p => p.classList.remove('active'));
  $(`setup-tab-${drugId}`)?.classList.add('active');
  $(`setup-panel-${drugId}`)?.classList.add('active');
}

// ---- Pump derived displays ----

/**
 * Read the shared global Max Pump Rate in mL/h. Falls back to 750 if the
 * element is missing or unparseable.
 */
function getGlobalPumpRateMlH() {
  return parseFloat($('input-max-pump-rate')?.value) || 750;
}

function updatePumpDerived() {
  const el = $('pump-derived');
  if (!el) return;

  const conc = parseFloat($('input-concentration')?.value) || 10;
  const rateMlH = getGlobalPumpRateMlH();

  const bolusRateMgMin = rateMlH * conc / 60;

  el.textContent = `Max bolus rate: ${bolusRateMgMin.toFixed(1)} mg/min`;
}

function updatePumpDerivedFentanyl() {
  const el = $('pump-derived-fentanyl');
  if (!el) return;
  const conc = parseFloat($('input-fentanyl-concentration')?.value) || 0.05;
  const rateMlH = getGlobalPumpRateMlH();
  const bolusRateMcgMin = rateMlH * conc * 1000 / 60; // convert mg→mcg for display
  el.textContent = `Max bolus rate: ${bolusRateMcgMin.toFixed(1)} mcg/min`;
}

function updatePumpDerivedKetamine() {
  const el = $('pump-derived-ketamine');
  if (!el) return;
  const conc = parseFloat($('input-ketamine-concentration')?.value) || 10;
  const rateMlH = getGlobalPumpRateMlH();
  const bolusRateMgMin = rateMlH * conc / 60;
  el.textContent = `Max bolus rate: ${bolusRateMgMin.toFixed(1)} mg/min`;
}

/**
 * Refresh all three drug panels' pump-derived lines. Called when the
 * global Max Pump Rate changes — every drug's max bolus rate depends on it.
 */
function updateAllPumpDerived() {
  updatePumpDerived();
  updatePumpDerivedFentanyl();
  updatePumpDerivedKetamine();
}

/**
 * Get the currently selected TCI planning mode.
 * @returns {string} 'stepped' | 'cet' | 'cet-conservative'
 */
export function getTciMode() {
  const el = $('input-tci-mode');
  return el ? el.value : 'stepped';
}

/**
 * Reset the setup form to default state.
 */
export function reset() {
  $('input-age').value = '';
  $('input-sex').value = '';
  $('input-height').value = '';
  $('input-weight').value = '';
  $('derived-bar').style.display = 'none';
  ['row-age', 'row-height', 'row-weight'].forEach(id => {
    $(id).classList.remove('error');
  });
  ['err-age', 'err-height', 'err-weight'].forEach(id => {
    $(id).textContent = '';
  });
  updatePreviews();
}
