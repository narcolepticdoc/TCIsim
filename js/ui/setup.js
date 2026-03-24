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
  ['input-age', 'input-height', 'input-weight', 'input-sex'].forEach(id => {
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

  // Wire unit toggle buttons
  const btnMetric = $('btn-metric');
  const btnImperial = $('btn-imperial');
  if (btnMetric) btnMetric.addEventListener('click', () => setUnits('metric'));
  if (btnImperial) btnImperial.addEventListener('click', () => setUnits('imperial'));

  // Wire confirm button
  const btnConfirm = $('btn-confirm');
  if (btnConfirm) btnConfirm.addEventListener('click', confirmPatient);
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
  const a = parseInt($('input-age').value);
  const s = $('input-sex').value;
  const h = getHeightCm();
  const w = getWeightKg();

  if (!isNaN(a) && a > 0 && s && !isNaN(h) && h > 30 && !isNaN(w) && w > 0) {
    const male = s === 'male';
    const bmi = w / Math.pow(h / 100, 2);
    const ffm = fatFreeMass(w, h, a, male);

    // Use the real Eleveld params to get Ce50 (not the old inline formula)
    const params = calcEleveldParams({ age: a, weight: w, height: h, male, opioid: false });

    $('derived-bmi').textContent = bmi.toFixed(1);
    $('derived-ffm').textContent = ffm.toFixed(1) + ' kg';
    $('derived-ce50').textContent = params.Ce50.toFixed(2) + ' μg/mL';
    $('derived-bar').style.display = 'flex';
  } else {
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
  if (!validate()) return;

  const patient = {
    age: parseInt($('input-age').value),
    weight: Math.round(getWeightKg() * 10) / 10,
    height: Math.round(getHeightCm() * 10) / 10,
    male: $('input-sex').value === 'male',
    opioid: false,
  };

  if (onConfirm) onConfirm(patient);
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
