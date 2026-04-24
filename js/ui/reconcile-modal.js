/**
 * reconcile-modal.js — Catch-up dose reconciliation modal.
 *
 * Lets the user bring the simulation back into agreement with reality
 * when they've lost track of pump rate changes or manual boluses during
 * a busy case. The comparison is total case dose (simulation) vs. the
 * pump's cumulative display (plus any non-pump boluses given) — not a
 * windowed gap, since the user typically doesn't know when the drift
 * started.
 *
 * On confirm, we insert a single correction bolus at a user-specified
 * past time (default = now). The PK system is linear time-invariant:
 * the final state after a few intermediate half-lives depends only on
 * the cumulative dose delivered, not on when within the case it was
 * delivered. Placing the correction in the past lets the sim redistribute
 * most of the correction before the cursor, shrinking the visible
 * forward transient.
 *
 * The chart marks `[T_insert, T_insert + window]` as an amber-hashed
 * untrustworthy region; window is `3 × t½_intermediate`, computed
 * per-patient from the 3-compartment eigenvalues in js/pk/eigenvalues.js.
 * The drug card pulses amber while the window is active. Both clear
 * automatically once case time passes the window end.
 */

import { DRUG_DEFS, DRUG_IDS } from '../util/constants.js';
import { getCumulativeDose } from '../sim/events/query.js';
import { getConvergenceWindow } from '../pk/eigenvalues.js';
import { fmtTotalMass } from './history.js';

const $ = id => document.getElementById(id);

// ---- Module state ----

let _model = null;
let _timer = null;
let _refreshChart = null;
let _addAnnotation = null;

let _drugId = null;        // selected drug
let _actualBuf = '';       // raw input buffer in display unit (mg or mcg)
let _simTotalMg = 0;       // simulated total in canonical mg
let _deltaMg = 0;          // actual_mg - simulated_mg
let _timeUnit = 'case';    // 'case' | 'real'
let _defaultInsertMin = 0; // default insert time (sim-now at open)

// Total-delivered is always shown in the drug's native mass unit.
// Matches the mapping in js/ui/history.js fmtTotalMass.
const NATIVE_MASS_UNIT = {
  propofol:     'mg',
  fentanyl:     'mcg',
  ketamine:     'mg',
  remifentanil: 'mcg',
};

function nativeUnit(drugId) { return NATIVE_MASS_UNIT[drugId] || 'mg'; }

function mgToNative(mg, drugId) {
  return nativeUnit(drugId) === 'mcg' ? mg * 1000 : mg;
}
function nativeToMg(val, drugId) {
  return nativeUnit(drugId) === 'mcg' ? val / 1000 : val;
}

// ---- Init ----

/**
 * Initialize the modal. Idempotent.
 *
 * @param {Object} opts
 * @param {Object} opts.model     - simulation model
 * @param {Object} opts.timer     - { getElapsedMinutes, getWallClockStart }
 * @param {Function} opts.refreshChart - () => void, call after confirm
 * @param {Function} opts.addAnnotation - (text) => void, audit trail
 */
export function init(opts = {}) {
  _model = opts.model;
  _timer = opts.timer;
  _refreshChart = opts.refreshChart || (() => {});
  _addAnnotation = opts.addAnnotation || (() => {});

  _wireKeypad();
  _wireTimePicker();
  _wireDrugPicker();
  _wireActions();
}

/**
 * Open the modal. If `drugId` is provided and that drug is currently
 * active in the event list, it's pre-selected; otherwise the drug picker
 * is shown (or auto-selected when only one drug has any events).
 */
export function open(drugId) {
  if (!_model || !_timer) return;

  const active = _activeDrugs();
  if (active.length === 0) {
    // Nothing to reconcile — fall back to propofol silently (user may be
    // trying this out pre-case; modal still opens so the flow is learnable).
    _drugId = 'propofol';
  } else if (drugId && active.includes(drugId)) {
    _drugId = drugId;
  } else if (active.length === 1) {
    _drugId = active[0];
  } else {
    _drugId = active[0];
  }

  _actualBuf = '';
  // Default to case start (T_insert = 0): mathematically optimal for forward
  // accuracy. The forward error after a correction at T_insert decays as
  // e^{A·(t − T_insert)}, so the larger the gap between T_insert and t, the
  // smaller the residual. Placing at 0 maximizes the decay time available
  // before `now`, leaving the forward curve nearly correct from the cursor on.
  // The cost is a fully retrospective curve perturbation; users who want
  // narrative fidelity can drag the picker forward.
  _defaultInsertMin = 0;
  _timeUnit = 'case';
  _setInsertTime(_defaultInsertMin);
  _renderDrugPicker(active);
  _computeSimTotal();
  _render();
  $('rm-error').textContent = '';
  $('modal-reconcile').classList.add('open');
}

export function close() {
  const overlay = $('modal-reconcile');
  if (overlay) overlay.classList.remove('open');
}

// ---- Helpers ----

function _activeDrugs() {
  if (!_model) return [];
  const out = [];
  for (const id of DRUG_IDS) {
    try {
      const events = _model.getEvents(id);
      if (events && events.length > 0) out.push(id);
    } catch (e) {}
  }
  return out;
}

function _computeSimTotal() {
  const now = _timer.getElapsedMinutes();
  const events = _model.getEvents(_drugId);
  _simTotalMg = getCumulativeDose(events, _drugId, now).totalMg;
}

function _computeDelta() {
  const actualDisp = parseFloat(_actualBuf);
  if (!isFinite(actualDisp)) { _deltaMg = 0; return; }
  const actualMg = nativeToMg(actualDisp, _drugId);
  _deltaMg = actualMg - _simTotalMg;
}

// ---- Drug picker ----

function _renderDrugPicker(active) {
  const picker = $('rm-drug-picker');
  const row = $('rm-drug-row');
  if (!picker || !row) return;
  // Hide entire row when only one active drug — no picker needed.
  if (active.length < 2) { picker.style.display = 'none'; row.innerHTML = ''; return; }
  picker.style.display = '';
  row.innerHTML = '';
  for (const id of active) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'rm-drug-btn' + (id === _drugId ? ' active' : '');
    btn.dataset.drug = id;
    btn.textContent = DRUG_DEFS[id]?.name || id;
    row.appendChild(btn);
  }
}

function _wireDrugPicker() {
  const row = $('rm-drug-row');
  if (!row) return;
  row.addEventListener('click', (e) => {
    const btn = e.target.closest('.rm-drug-btn');
    if (!btn) return;
    const id = btn.dataset.drug;
    if (!id || id === _drugId) return;
    _drugId = id;
    _actualBuf = '';
    _computeSimTotal();
    row.querySelectorAll('.rm-drug-btn').forEach(b => b.classList.toggle('active', b.dataset.drug === id));
    _render();
  });
}

// ---- Keypad ----

function _wireKeypad() {
  document.querySelectorAll('.rm-key').forEach(btn => {
    btn.addEventListener('click', () => _handleKey(btn.dataset.key));
  });
}

function _handleKey(key) {
  let v = _actualBuf;
  if (key === 'clear') {
    v = '';
  } else if (key === 'back') {
    v = v.slice(0, -1);
  } else if (key === '.') {
    if (v.includes('.')) return;
    v = v === '' ? '0.' : v + '.';
  } else if (/^[0-9]$/.test(key)) {
    if (v.length >= 9) return;
    v = v + key;
  } else {
    return;
  }
  _actualBuf = v;
  _render();
}

// ---- Time picker ----

function _setInsertTime(caseMin) {
  const h = Math.floor(caseMin / 60);
  const m = Math.round(caseMin % 60);
  _buildSelect($('rm-hours'), 24, 2, h);
  _buildSelect($('rm-minutes'), 60, 2, m);
  _syncTimeUnitButtons();
  _updateTimeConversion();
}

function _buildSelect(sel, count, pad, selected) {
  if (!sel) return;
  sel.innerHTML = '';
  for (let i = 0; i < count; i++) {
    const opt = document.createElement('option');
    opt.value = i;
    opt.textContent = String(i).padStart(pad, '0');
    if (i === selected) opt.selected = true;
    sel.appendChild(opt);
  }
  sel.onchange = _onTimeChanged;
}

function _getSelVal(id) {
  const el = $(id);
  return el ? parseInt(el.value, 10) || 0 : 0;
}

function _wireTimePicker() {
  document.querySelectorAll('#rm-time-unit .tp-unit').forEach(btn => {
    btn.addEventListener('click', () => _setTimeUnit(btn.dataset.unit));
  });
}

function _setTimeUnit(unit) {
  if (unit === _timeUnit) return;
  // Round-trip buffer through case-start conversion so the user's
  // in-progress selection is preserved across the toggle (matches
  // CLAUDE.md keypad-round-trip invariant for other unit flips).
  const caseMin = _currentCaseMinutes();
  _timeUnit = unit;
  _syncTimeUnitButtons();
  if (unit === 'case') {
    _buildSelect($('rm-hours'), 24, 2, Math.floor(caseMin / 60));
    _buildSelect($('rm-minutes'), 60, 2, Math.round(caseMin % 60));
  } else {
    const wallStart = _timer.getWallClockStart && _timer.getWallClockStart();
    if (wallStart) {
      const realDate = new Date(wallStart.getTime() + caseMin * 60000);
      _buildSelect($('rm-hours'), 24, 2, realDate.getHours());
      _buildSelect($('rm-minutes'), 60, 2, realDate.getMinutes());
    }
  }
  _updateTimeConversion();
  _render();
}

function _syncTimeUnitButtons() {
  const isRunning = !!(_timer.getWallClockStart && _timer.getWallClockStart());
  document.querySelectorAll('#rm-time-unit .tp-unit').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.unit === _timeUnit);
    if (btn.dataset.unit === 'real') btn.disabled = !isRunning;
  });
}

function _currentCaseMinutes() {
  if (_timeUnit === 'case') {
    return _getSelVal('rm-hours') * 60 + _getSelVal('rm-minutes');
  }
  const wallStart = _timer.getWallClockStart && _timer.getWallClockStart();
  if (!wallStart) return _getSelVal('rm-hours') * 60 + _getSelVal('rm-minutes');
  const target = new Date(wallStart);
  target.setHours(_getSelVal('rm-hours'), _getSelVal('rm-minutes'), 0, 0);
  return Math.max(0, (target - wallStart) / 60000);
}

function _onTimeChanged() {
  _updateTimeConversion();
  _render();
}

function _updateTimeConversion() {
  const cv = $('rm-time-conversion');
  if (!cv) return;
  const wallStart = _timer.getWallClockStart && _timer.getWallClockStart();
  if (_timeUnit === 'case') {
    const caseMin = _getSelVal('rm-hours') * 60 + _getSelVal('rm-minutes');
    if (wallStart) {
      const rd = new Date(wallStart.getTime() + caseMin * 60000);
      const h = rd.getHours();
      const m = String(rd.getMinutes()).padStart(2, '0');
      cv.textContent = `= ${h}:${m} RT`;
    } else { cv.textContent = ''; }
  } else if (wallStart) {
    const caseMin = _currentCaseMinutes();
    const h = Math.floor(caseMin / 60);
    const m = String(Math.round(caseMin % 60)).padStart(2, '0');
    cv.textContent = `= ${h}:${m} ET`;
  } else { cv.textContent = ''; }
}

// ---- Rendering ----

function _render() {
  // Simulated total (display unit)
  const simEl = $('rm-sim-total');
  if (simEl) simEl.textContent = _simTotalMg > 0 ? fmtTotalMass(_simTotalMg, _drugId) : `0 ${nativeUnit(_drugId)}`;

  // Actual input
  const actEl = $('rm-actual-display');
  if (actEl) {
    if (_actualBuf === '') {
      actEl.textContent = '—';
      actEl.classList.add('empty');
    } else {
      actEl.textContent = _actualBuf;
      actEl.classList.remove('empty');
    }
  }
  const unitEl = $('rm-actual-unit');
  if (unitEl) unitEl.textContent = nativeUnit(_drugId);

  // Delta
  _computeDelta();
  const dEl = $('rm-delta');
  if (dEl) {
    if (_actualBuf === '' || !isFinite(parseFloat(_actualBuf))) {
      dEl.textContent = '—';
      dEl.className = 'rm-value rm-value-delta zero';
    } else if (Math.abs(_deltaMg) < 1e-6) {
      dEl.textContent = '0';
      dEl.className = 'rm-value rm-value-delta zero';
    } else {
      const sign = _deltaMg > 0 ? '+' : '−'; // en dash for negative
      const mag  = fmtTotalMass(Math.abs(_deltaMg), _drugId);
      dEl.textContent = `${sign} ${mag}`;
      dEl.className = 'rm-value rm-value-delta ' + (_deltaMg > 0 ? 'positive' : 'negative');
    }
  }

  _renderSummary();

  // Confirm enabled only when we have a valid, non-zero, in-case delta
  const confirmBtn = $('rm-confirm');
  if (confirmBtn) {
    const validActual = _actualBuf !== '' && isFinite(parseFloat(_actualBuf));
    const nonZero = Math.abs(_deltaMg) > 1e-6;
    confirmBtn.disabled = !(validActual && nonZero);
  }
}

function _renderSummary() {
  const el = $('rm-summary');
  if (!el) return;
  const confirmBtn = $('rm-confirm');
  if (!_drugId || _actualBuf === '' || !isFinite(parseFloat(_actualBuf))) {
    el.textContent = '';
    if (confirmBtn) confirmBtn.disabled = true;
    return;
  }
  if (Math.abs(_deltaMg) < 1e-6) {
    el.textContent = 'No correction needed — totals match.';
    return;
  }
  const caseMin = _currentCaseMinutes();
  const now = _timer.getElapsedMinutes();
  const patient = _model.getPatient ? _model.getPatient() : { weight: 70, height: 170, age: 40, male: true };
  const windowMin = getConvergenceWindow(_drugId, patient);
  const fmtMin = (m) => {
    const h = Math.floor(m / 60);
    const r = Math.round(m % 60);
    return h > 0 ? `${h}h ${String(r).padStart(2, '0')}m` : `${r}m`;
  };
  const sign = _deltaMg > 0 ? '+' : '−';
  const mag = fmtTotalMass(Math.abs(_deltaMg), _drugId);
  const isPast = caseMin < now - 0.1;
  const isFuture = caseMin > now + 0.1;
  let whenText;
  if (isPast) whenText = `at ET ${fmtMin(caseMin)} (${fmtMin(now - caseMin)} ago)`;
  else if (isFuture) whenText = 'at now (future time clamped)';
  else whenText = 'at the current sim time';
  const endMin = caseMin + windowMin;
  const endRel = endMin > now
    ? `through ET ${fmtMin(endMin)} (${fmtMin(endMin - now)} from now)`
    : 'ending in the past (already converged by now)';
  let caution = '';
  if (_deltaMg < 0) {
    caution = ' Expect a brief Cp dip at the insert point; the region will relax back.';
  }
  el.textContent =
    `A ${sign}${mag} correction will be added ${whenText}. Chart marked reconciling ${endRel}. Convergence window ~${Math.round(windowMin)} min (3 × intermediate t½).${caution}`;
}

// ---- Confirm ----

function _wireActions() {
  $('rm-cancel')?.addEventListener('click', close);
  $('rm-confirm')?.addEventListener('click', _confirm);
  // Click-outside to close
  const overlay = $('modal-reconcile');
  if (overlay) overlay.addEventListener('click', (e) => {
    if (e.target === overlay) close();
  });
}

function _confirm() {
  const err = $('rm-error');
  if (err) err.textContent = '';
  if (!_model || !_drugId) return;
  if (_actualBuf === '' || !isFinite(parseFloat(_actualBuf))) {
    if (err) err.textContent = 'Enter the actual total delivered.';
    return;
  }
  _computeDelta();
  if (Math.abs(_deltaMg) < 1e-6) {
    if (err) err.textContent = 'Totals match — nothing to reconcile.';
    return;
  }
  const now = _timer.getElapsedMinutes();
  let insertMin = _currentCaseMinutes();
  // Clamp to [0, now]. User can't reconcile forward in time.
  insertMin = Math.max(0, Math.min(now, insertMin));

  const patient = _model.getPatient ? _model.getPatient() : null;
  const windowMin = patient ? getConvergenceWindow(_drugId, patient) : 45;
  const endMin = insertMin + windowMin;

  try {
    const sign = _deltaMg > 0 ? '+' : '-';
    const annot = `Dose reconciliation ${sign}${fmtTotalMass(Math.abs(_deltaMg), _drugId)}`;
    // Snapshot the pre-correction Ce so the chart can render a ghost
    // curve for visual comparison. Sample at the same step the chart
    // uses (10/60 = 1/6 min). Do this BEFORE addBolus mutates state.
    let ghostPoints = null;
    if (_model.computeCurve && now > 0) {
      try {
        const raw = _model.computeCurve(_drugId, 0, now, 10 / 60);
        ghostPoints = raw.map(p => ({ time: p.time, Ce: p.Ce }));
      } catch (e) { /* non-fatal — proceed without ghost */ }
    }
    _model.addBolus(_drugId, insertMin, _deltaMg, annot, { deliveryMode: 'push', source: 'manual' });
    if (_model.setReconciliationWindow) {
      _model.setReconciliationWindow(_drugId, insertMin, endMin);
    }
    if (_model.setReconciliationGhost && ghostPoints) {
      _model.setReconciliationGhost(_drugId, { capturedAt: now, points: ghostPoints });
    }
    _addAnnotation(`Reconciled ${_drugId}: ${annot} @ ET ${Math.round(insertMin)}m`);
    _refreshChart();
    close();
  } catch (e) {
    if (err) err.textContent = 'Failed to apply correction: ' + (e.message || e);
  }
}
