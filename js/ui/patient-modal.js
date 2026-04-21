/**
 * patient-modal.js — Patient Demographics modal with built-in numeric keypad.
 *
 * Collapses the four setup inputs (age / sex / height / weight) into one
 * "Tap to edit" summary on the main setup screen; this modal owns the
 * in-app numeric keypad so iPadOS never shows its own keyboard for these
 * fields.
 *
 * Flow:
 *   open()  -> seeds from the hidden #input-* fields, selects the first empty
 *              numeric field, opens the overlay.
 *   confirm() -> validates, writes to hidden inputs, dispatches 'input' events
 *              so the existing setup.js pipeline runs, closes the modal, and
 *              calls the onConfirm() callback so setup.js can update the
 *              summary row.
 */

import { _convertLength, _convertWeight } from './setup.js';

const $ = id => document.getElementById(id);

let _onConfirm = null;
let _getUnits  = () => 'metric';
let _setUnits  = null;

// Modal-local state (display-unit values, not canonical)
let _values = { age: '', sex: '', height: '', weight: '' };
// Per-field "prefilled" flag — true when the buffer came from an external source
// (hidden inputs at open, or a unit conversion) and hasn't been typed into yet.
// The first digit / decimal keypress replaces the buffer instead of appending.
let _prefilled = { age: false, height: false, weight: false };
let _active = 'age'; // 'age' | 'height' | 'weight' — sex is toggle-only
let _lastUnits = 'metric'; // tracks the unit that _values.height / _values.weight are in

const FIELDS = ['age', 'sex', 'height', 'weight'];

/**
 * Initialize the modal. Idempotent.
 *
 * @param {Object} opts
 * @param {Function} opts.onConfirm - () => void, called after the hidden inputs
 *   have been written and their 'input' events dispatched. setup.js uses this to
 *   re-render the summary row.
 * @param {Function} opts.getUnits  - () => 'metric' | 'imperial'
 * @param {Function} opts.setUnits  - (u) => void, the shared units setter in
 *   setup.js. Called when the user taps Metric/Imperial inside the modal.
 */
export function init(opts = {}) {
  _onConfirm = opts.onConfirm || null;
  _getUnits  = opts.getUnits || (() => 'metric');
  _setUnits  = opts.setUnits || null;

  _wireFieldTaps();
  _wireSexToggle();
  _wireKeypad();
  _wireUnitToggle();
  _wireActions();
}

/** Open the modal, seeding values from the hidden inputs. */
export function open() {
  _values = {
    age:    ($('input-age')?.value || '').trim(),
    sex:    ($('input-sex')?.value || '').trim(),
    height: ($('input-height')?.value || '').trim(),
    weight: ($('input-weight')?.value || '').trim(),
  };
  // Any non-empty field is prefilled — first keypress on it replaces.
  _prefilled = {
    age:    !!_values.age,
    height: !!_values.height,
    weight: !!_values.weight,
  };
  _lastUnits = _getUnits();
  _syncUnitToggle();
  _applyUnitLabels();
  _render();
  _selectFirstEmpty();
  $('pm-error').textContent = '';
  $('modal-patient').classList.add('open');
}

/** Close without saving. */
export function close() {
  $('modal-patient').classList.remove('open');
  $('pm-error').textContent = '';
}

/** Called by setup.js when units change externally or via the modal's own toggle. */
export function onUnitsChanged() {
  const newU = _getUnits();
  if (!$('modal-patient').classList.contains('open')) {
    // Keep tracker in sync even when closed so the next open reflects the right unit.
    _lastUnits = newU;
    return;
  }
  // Convert the modal's buffers between the previous and new unit so the user's
  // in-progress entry is preserved across a unit flip. Mark the converted
  // values as prefilled so the next keypress replaces rather than appends.
  if (_lastUnits !== newU) {
    if (_values.height) {
      _values.height = _convertLength(_values.height, _lastUnits, newU);
      _prefilled.height = true;
    }
    if (_values.weight) {
      _values.weight = _convertWeight(_values.weight, _lastUnits, newU);
      _prefilled.weight = true;
    }
  }
  _lastUnits = newU;
  _syncUnitToggle();
  _applyUnitLabels();
  _render();
}

// ---- Wiring ----------------------------------------------------------------

function _wireFieldTaps() {
  document.querySelectorAll('.pm-field[data-field]').forEach(row => {
    const f = row.dataset.field;
    if (f === 'sex') return;
    row.addEventListener('click', () => _setActive(f));
  });
}

function _wireSexToggle() {
  document.querySelectorAll('.pm-sex-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      _values.sex = btn.dataset.sex;
      _render();
      document.querySelector('.pm-field-sex')?.classList.remove('error');
    });
  });
}

function _wireKeypad() {
  document.querySelectorAll('.pm-key').forEach(btn => {
    btn.addEventListener('click', () => _handleKey(btn.dataset.key));
  });
}

function _wireUnitToggle() {
  const metricBtn = $('pm-metric');
  const imperialBtn = $('pm-imperial');
  if (metricBtn) metricBtn.addEventListener('click', () => {
    if (_setUnits) _setUnits('metric');
  });
  if (imperialBtn) imperialBtn.addEventListener('click', () => {
    if (_setUnits) _setUnits('imperial');
  });
}

function _wireActions() {
  const cancel = $('pm-cancel');
  const confirm = $('pm-confirm');
  if (cancel) cancel.addEventListener('click', close);
  if (confirm) confirm.addEventListener('click', _confirm);

  // Click-outside to close
  const overlay = $('modal-patient');
  if (overlay) overlay.addEventListener('click', (e) => {
    if (e.target === overlay) close();
  });
}

// ---- Active field + keypad -------------------------------------------------

function _setActive(field) {
  if (!FIELDS.includes(field) || field === 'sex') return;
  if (_active === field) return;            // re-tapping the same field is a no-op
  _active = field;
  // Tapping a different field with existing data arms "replace on first keypress" —
  // matches the user's mental model of tapping to edit.
  if (_values[field]) _prefilled[field] = true;
  document.querySelectorAll('.pm-field').forEach(el =>
    el.classList.toggle('active', el.dataset.field === field));
  // Age is integer-only
  const dot = document.querySelector('.pm-key-dot');
  if (dot) dot.toggleAttribute('disabled', field === 'age');
  // Clear field-level error when user returns
  const row = document.querySelector(`.pm-field[data-field="${field}"]`);
  if (row) row.classList.remove('error');
}

function _selectFirstEmpty() {
  for (const f of ['age', 'height', 'weight']) {
    if (!_values[f]) { _setActive(f); return; }
  }
  _setActive('age');
}

function _handleKey(key) {
  const f = _active;
  let v = _values[f] || '';
  if (key === 'clear') {
    v = '';
    _prefilled[f] = false;
  } else if (key === 'back') {
    // If the field is still prefilled, one backspace clears the whole value —
    // matches the existing keypad.js behavior for pre-populated buffers.
    if (_prefilled[f]) {
      v = '';
      _prefilled[f] = false;
    } else {
      v = v.slice(0, -1);
    }
  } else if (key === '.') {
    if (f === 'age') return;
    if (_prefilled[f]) { v = ''; _prefilled[f] = false; }
    if (v.includes('.')) return;
    v = v === '' ? '0.' : v + '.';
  } else if (/^[0-9]$/.test(key)) {
    // First digit on a prefilled field replaces rather than appends.
    if (_prefilled[f]) { v = ''; _prefilled[f] = false; }
    if (v.length >= 6) return; // guard against runaway input
    v = v + key;
  } else {
    return;
  }
  _values[f] = v;
  _render();
}

// ---- Rendering -------------------------------------------------------------

function _render() {
  // Value cells
  const setCell = (id, val) => {
    const el = $(id);
    if (!el) return;
    if (val === '' || val == null) {
      el.textContent = '—';   // em dash
      el.classList.add('empty');
    } else {
      el.textContent = val;
      el.classList.remove('empty');
    }
  };
  setCell('pm-age-val',    _values.age);
  setCell('pm-height-val', _values.height);
  setCell('pm-weight-val', _values.weight);

  // Sex toggle
  document.querySelectorAll('.pm-sex-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.sex === _values.sex);
  });
}

function _applyUnitLabels() {
  const u = _getUnits();
  const hu = $('pm-height-unit');
  const wu = $('pm-weight-unit');
  if (hu) hu.textContent = u === 'imperial' ? '(inches)' : '(cm)';
  if (wu) wu.textContent = u === 'imperial' ? '(lbs)'    : '(kg)';
}

function _syncUnitToggle() {
  const u = _getUnits();
  $('pm-metric')?.classList.toggle('active', u === 'metric');
  $('pm-imperial')?.classList.toggle('active', u === 'imperial');
}

// ---- Confirm ---------------------------------------------------------------

function _confirm() {
  const err = $('pm-error');
  err.textContent = '';
  document.querySelectorAll('.pm-field').forEach(r => r.classList.remove('error'));

  // Validate age
  const ageStr = _values.age.trim();
  const age    = parseInt(ageStr, 10);
  if (!ageStr || isNaN(age) || age < 1 || age > 100) {
    err.textContent = 'Enter age (1–100).';
    _markError('age');
    _setActive('age');
    return;
  }

  // Validate sex
  if (_values.sex !== 'male' && _values.sex !== 'female') {
    err.textContent = 'Select a sex to continue.';
    _markError('sex');
    return;
  }

  // Validate height (display unit -> cm)
  const u = _getUnits();
  const hStr = _values.height.trim();
  const hDisp = parseFloat(hStr);
  const hCm   = !isNaN(hDisp) ? (u === 'imperial' ? hDisp * 2.54 : hDisp) : NaN;
  if (!hStr || isNaN(hCm) || hCm < 30 || hCm > 250) {
    err.textContent = u === 'imperial'
      ? 'Enter height (12–98 in).'
      : 'Enter height (30–250 cm).';
    _markError('height');
    _setActive('height');
    return;
  }

  // Validate weight
  const wStr = _values.weight.trim();
  const wDisp = parseFloat(wStr);
  const wKg   = !isNaN(wDisp) ? (u === 'imperial' ? wDisp * 0.453592 : wDisp) : NaN;
  if (!wStr || isNaN(wKg) || wKg < 0.5 || wKg > 300) {
    err.textContent = u === 'imperial'
      ? 'Enter weight (1–660 lbs).'
      : 'Enter weight (0.5–300 kg).';
    _markError('weight');
    _setActive('weight');
    return;
  }

  // Write to hidden inputs and dispatch 'input' events so setup.js downstream
  // (updatePreviews / updateDerived / validate) sees the new values.
  _writeHidden('input-age',    ageStr);
  _writeHidden('input-sex',    _values.sex);
  _writeHidden('input-height', hStr);
  _writeHidden('input-weight', wStr);

  close();
  if (_onConfirm) _onConfirm();
}

function _markError(field) {
  const row = document.querySelector(`.pm-field[data-field="${field}"]`);
  if (row) row.classList.add('error');
}

function _writeHidden(id, value) {
  const el = $(id);
  if (!el) return;
  el.value = value;
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
}
