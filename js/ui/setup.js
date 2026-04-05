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

import { calcEleveldParams, fatFreeMass } from '../pk/eleveld.js';
import { setPumpSettings, getPumpSettings } from '../util/constants.js';

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

  // Wire pump settings (propofol)
  const concEl = $('input-concentration');
  const rateEl = $('input-pump-rate');
  const tciModeEl = $('input-tci-mode');
  const opioidEl = $('input-opioid');
  if (concEl) concEl.addEventListener('change', updatePumpDerived);
  if (rateEl) rateEl.addEventListener('change', updatePumpDerived);
  if (opioidEl) opioidEl.addEventListener('change', () => {
    updateDerived();
    updateCe50CorrectionVisibility();
  });

  // Wire pump settings (fentanyl)
  const fentConcEl = $('input-fentanyl-concentration');
  const fentRateEl = $('input-fentanyl-pump-rate');
  if (fentConcEl) fentConcEl.addEventListener('change', updatePumpDerivedFentanyl);
  if (fentRateEl) fentRateEl.addEventListener('change', updatePumpDerivedFentanyl);

  // Wire pump settings (ketamine)
  const ketConcEl = $('input-ketamine-concentration');
  const ketRateEl = $('input-ketamine-pump-rate');
  if (ketConcEl) ketConcEl.addEventListener('change', updatePumpDerivedKetamine);
  if (ketRateEl) ketRateEl.addEventListener('change', updatePumpDerivedKetamine);

  // Wire Ce50 opioid correction checkbox
  const ce50CorrEl = $('input-ce50-correction');
  if (ce50CorrEl) ce50CorrEl.addEventListener('change', () => { updateDerived(); });

  // Set initial visibility based on restored opioid value
  updateCe50CorrectionVisibility();

  // Restore saved pump settings
  restorePumpSettingsUI();
  updatePumpDerived();
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
  const rateEl = $('input-pump-rate');
  const tciModeEl = $('input-tci-mode');
  const opioidEl = $('input-opioid');
  if (!concEl || !rateEl) return;

  const concentration = parseFloat(concEl.value) || 10;
  const bolusRateMlH = parseFloat(rateEl.value) || 750;

  setPumpSettings('propofol', { concentration, bolusRateMlH });

  // Fentanyl settings
  const fentConcEl = $('input-fentanyl-concentration');
  const fentRateEl = $('input-fentanyl-pump-rate');
  if (fentConcEl && fentRateEl) {
    const fConc = parseFloat(fentConcEl.value) || 0.05;
    const fRate = parseFloat(fentRateEl.value) || 750;
    setPumpSettings('fentanyl', { concentration: fConc, bolusRateMlH: fRate });
    try {
      localStorage.setItem('tci-pump-concentration-fentanyl', String(fConc));
      localStorage.setItem('tci-pump-rate-fentanyl', String(fRate));
    } catch (e) {}
  }

  // Ketamine settings
  const ketConcEl = $('input-ketamine-concentration');
  const ketRateEl = $('input-ketamine-pump-rate');
  if (ketConcEl && ketRateEl) {
    const kConc = parseFloat(ketConcEl.value) || 10;
    const kRate = parseFloat(ketRateEl.value) || 750;
    setPumpSettings('ketamine', { concentration: kConc, bolusRateMlH: kRate });
    try {
      localStorage.setItem('tci-pump-concentration-ketamine', String(kConc));
      localStorage.setItem('tci-pump-rate-ketamine', String(kRate));
    } catch (e) {}
  }

  // Save propofol-specific settings to localStorage
  try {
    localStorage.setItem('tci-pump-concentration', String(concentration));
    localStorage.setItem('tci-pump-rate', String(bolusRateMlH));
    if (tciModeEl) localStorage.setItem('tci-mode', tciModeEl.value);
    if (opioidEl) localStorage.setItem('tci-opioid', opioidEl.value);
    const ce50CorrEl2 = $('input-ce50-correction');
    if (ce50CorrEl2) localStorage.setItem('tci-ce50-correction', ce50CorrEl2.checked ? 'true' : 'false');
  } catch (e) {}
}

function restorePumpSettingsUI() {
  try {
    const savedConc = localStorage.getItem('tci-pump-concentration');
    const savedRate = localStorage.getItem('tci-pump-rate');
    const savedMode = localStorage.getItem('tci-mode');
    const savedOpioid = localStorage.getItem('tci-opioid');

    if (savedConc) { const el = $('input-concentration'); if (el) el.value = savedConc; }
    if (savedRate) { const el = $('input-pump-rate'); if (el) el.value = savedRate; }
    if (savedMode) { const el = $('input-tci-mode'); if (el) el.value = savedMode; }
    if (savedOpioid) { const el = $('input-opioid'); if (el) el.value = savedOpioid; }
    const savedCe50Corr = localStorage.getItem('tci-ce50-correction');
    if (savedCe50Corr) { const el = $('input-ce50-correction'); if (el) el.checked = savedCe50Corr === 'true'; }
  } catch (e) {}

  // Restore fentanyl settings
  try {
    const fc = localStorage.getItem('tci-pump-concentration-fentanyl');
    const fr = localStorage.getItem('tci-pump-rate-fentanyl');
    if (fc) { const el = $('input-fentanyl-concentration'); if (el) el.value = fc; }
    if (fr) { const el = $('input-fentanyl-pump-rate'); if (el) el.value = fr; }
  } catch (e) {}

  // Restore ketamine settings
  try {
    const kc = localStorage.getItem('tci-pump-concentration-ketamine');
    const kr = localStorage.getItem('tci-pump-rate-ketamine');
    if (kc) { const el = $('input-ketamine-concentration'); if (el) el.value = kc; }
    if (kr) { const el = $('input-ketamine-pump-rate'); if (el) el.value = kr; }
  } catch (e) {}

  updatePumpDerivedFentanyl();
  updatePumpDerivedKetamine();
}

// ---- Drug setup tab switching ----

function switchDrugTab(drugId) {
  document.querySelectorAll('.drug-setup-tab').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('.drug-setup-panel').forEach(p => p.classList.remove('active'));
  $(`setup-tab-${drugId}`)?.classList.add('active');
  $(`setup-panel-${drugId}`)?.classList.add('active');
}

// ---- Pump derived displays ----

function updatePumpDerived() {
  const el = $('pump-derived');
  if (!el) return;

  const conc = parseFloat($('input-concentration')?.value) || 10;
  const rateMlH = parseFloat($('input-pump-rate')?.value) || 750;

  const bolusRateMgMin = rateMlH * conc / 60;

  el.textContent = `Max bolus rate: ${bolusRateMgMin.toFixed(1)} mg/min`;
}

function updatePumpDerivedFentanyl() {
  const el = $('pump-derived-fentanyl');
  if (!el) return;
  const conc = parseFloat($('input-fentanyl-concentration')?.value) || 0.05;
  const rateMlH = parseFloat($('input-fentanyl-pump-rate')?.value) || 750;
  const bolusRateMcgMin = rateMlH * conc * 1000 / 60; // convert mg→mcg for display
  el.textContent = `Max bolus rate: ${bolusRateMcgMin.toFixed(1)} mcg/min`;
}

function updatePumpDerivedKetamine() {
  const el = $('pump-derived-ketamine');
  if (!el) return;
  const conc = parseFloat($('input-ketamine-concentration')?.value) || 10;
  const rateMlH = parseFloat($('input-ketamine-pump-rate')?.value) || 750;
  const bolusRateMgMin = rateMlH * conc / 60;
  el.textContent = `Max bolus rate: ${bolusRateMgMin.toFixed(1)} mg/min`;
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
