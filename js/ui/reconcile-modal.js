/**
 * reconcile-modal.js — Catch-up dose reconciliation modal.
 *
 * Two strategies for bringing the sim back into agreement with reality:
 *
 *   Spread across case (default) — adds the missing dose as a constant
 *     rate offset across [0, NOW]. Reconstructs sustained rate-logging
 *     errors exactly (zero Ce error at every horizon). Approximate for
 *     sharp one-off missed events but converges within ~1 % by NOW+120.
 *
 *   Single bolus — inserts one correction at a user-chosen past time.
 *     Exact reconstruction when the user knows the actual event time.
 *     Case-start default is ≤1.5 % off for any sharp event older than
 *     90 min.
 *
 * See js/sim/simulation.js::applyRateAugmentation for the spread primitive
 * and the empirical findings in CHANGELOG 0.5.28.0 for the "which mode
 * when" decision tree.
 */

import { DRUG_DEFS, DRUG_IDS, getPumpSettings, isPumpEnabled } from '../util/constants.js';
import { getCumulativeDose } from '../sim/events/query.js';
import { getConvergenceWindow } from '../pk/eigenvalues.js';
import { fmtTotalMass } from './history.js';
import { showTciWarning } from './event-editor.js';
import { set as setMode } from './mode.js';

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
let _mode = 'single';      // 'spread' | 'single' (set from open())
let _inputMode = 'dose';   // 'dose' | 'volume' (set from open() based on pump availability)
// 5-minute forward band shown after a spread correction. Spread-mode error
// is theoretically zero past NOW; the stub is purely a visual cue that the
// correction happened.
const SPREAD_FORWARD_TAIL_MIN = 5;

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

// ---- Display-unit helpers (dose vs. volume) ----

// Volume mode is offered only when the drug has a pump enabled. Pump
// concentration is stored canonically in mg/mL.
function _volumeAvailable(drugId) {
  if (!drugId) return false;
  try {
    if (!isPumpEnabled(drugId)) return false;
    const ps = getPumpSettings(drugId);
    return !!(ps && ps.concentration > 0);
  } catch (e) { return false; }
}

function _displayUnit() {
  if (_inputMode === 'volume') return 'mL';
  return nativeUnit(_drugId);
}

// canonical mg → display value (mg, mcg, or mL)
function _mgToDisplay(mg) {
  if (_inputMode === 'volume') {
    const ps = getPumpSettings(_drugId);
    return ps.concentration > 0 ? mg / ps.concentration : 0;
  }
  return mgToNative(mg, _drugId);
}

// display value (mg, mcg, or mL) → canonical mg
function _displayToMg(val) {
  if (_inputMode === 'volume') {
    const ps = getPumpSettings(_drugId);
    return val * (ps.concentration || 0);
  }
  return nativeToMg(val, _drugId);
}

// Format a positive canonical mg amount in the current display unit.
function _fmtDisplay(mg) {
  if (_inputMode === 'volume') {
    const ml = _mgToDisplay(mg);
    const dec = ml >= 100 ? 0 : (ml >= 10 ? 1 : 2);
    return `${ml.toFixed(dec)} mL`;
  }
  return fmtTotalMass(mg, _drugId);
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
  _wireModeToggle();
  _wireInputModeToggle();
  _wireInfoPopup();
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
  _mode = 'single';  // Single-bolus default — the common scenario failure is a
                     // missed sharp event (stopcock push, etc.), which has a
                     // simpler mental model and no forward-rebuild caveat.
                     // Spread mode is the right tool for sustained rate drift,
                     // but that's the rarer case.
  // Default input unit: dose. Volume mode is offered for pump-enabled drugs
  // since pumps display infused volume (mL); easier than mental-mathing it
  // back to mg.
  _inputMode = 'dose';
  // Single-bolus default time = case start. Fast forward convergence and
  // ≤1.5 % Ce error at NOW for any sharp event older than 90 min.
  _defaultInsertMin = 0;
  _timeUnit = 'case';
  _setInsertTime(_defaultInsertMin);
  _syncModeUI();
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
  const actualMg = _displayToMg(actualDisp);
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
    // If the new drug doesn't support volume entry, drop back to dose mode
    // so the unit label and toggle stay in sync.
    if (_inputMode === 'volume' && !_volumeAvailable(_drugId)) {
      _inputMode = 'dose';
    }
    _computeSimTotal();
    row.querySelectorAll('.rm-drug-btn').forEach(b => b.classList.toggle('active', b.dataset.drug === id));
    _render();
  });
}

// ---- Keypad ----

// ---- Mode toggle (spread vs single bolus) ----

function _wireModeToggle() {
  document.querySelectorAll('.rm-mode-opt').forEach(btn => {
    btn.addEventListener('click', () => {
      const m = btn.dataset.mode;
      if (m !== 'spread' && m !== 'single') return;
      if (m === _mode) return;
      _mode = m;
      _syncModeUI();
      _render();
    });
  });
}

function _syncModeUI() {
  document.querySelectorAll('.rm-mode-opt').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.mode === _mode);
  });
  // Show the time-picker row only for single-bolus mode.
  const tpRow = document.querySelector('.rm-time-row');
  if (tpRow) tpRow.style.display = (_mode === 'single') ? '' : 'none';
}

// ---- Input-mode toggle (dose vs volume) ----

function _wireInputModeToggle() {
  document.querySelectorAll('.rm-input-mode-opt').forEach(btn => {
    btn.addEventListener('click', () => {
      const m = btn.dataset.inputMode;
      if (m !== 'dose' && m !== 'volume') return;
      if (m === _inputMode) return;
      // If switching to volume but no pump/concentration is available, ignore.
      if (m === 'volume' && !_volumeAvailable(_drugId)) return;
      // Convert the current buffer through canonical mg so the displayed
      // number matches the new unit. (e.g. "247" mg → "24.7" mL.)
      const buf = parseFloat(_actualBuf);
      if (isFinite(buf)) {
        const canonicalMg = _displayToMg(buf);
        _inputMode = m;
        const newDisp = _mgToDisplay(canonicalMg);
        // Use a sensible decimal count for the new unit
        const dec = _inputMode === 'volume'
          ? (newDisp >= 100 ? 0 : (newDisp >= 10 ? 1 : 2))
          : (Math.abs(newDisp - Math.round(newDisp)) < 1e-6 ? 0 : 2);
        _actualBuf = newDisp.toFixed(dec).replace(/\.?0+$/, '');
      } else {
        _inputMode = m;
      }
      _render();
    });
  });
}

// ---- Info popup ----

function _wireInfoPopup() {
  const openBtn = $('rm-info-open');
  if (openBtn) openBtn.addEventListener('click', () => {
    const overlay = $('modal-reconcile-info');
    if (overlay) overlay.classList.add('open');
  });
  const closeBtn = $('rm-info-close');
  if (closeBtn) closeBtn.addEventListener('click', () => {
    $('modal-reconcile-info')?.classList.remove('open');
  });
  const overlay = $('modal-reconcile-info');
  if (overlay) overlay.addEventListener('click', (e) => {
    if (e.target === overlay) overlay.classList.remove('open');
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
  // Input-mode toggle visibility (only for pump-enabled drugs)
  const inputToggle = document.querySelector('.rm-input-mode-toggle');
  if (inputToggle) {
    inputToggle.style.display = _volumeAvailable(_drugId) ? '' : 'none';
  }
  document.querySelectorAll('.rm-input-mode-opt').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.inputMode === _inputMode);
  });

  // Simulated total in current display unit
  const simEl = $('rm-sim-total');
  if (simEl) simEl.textContent = _simTotalMg > 0 ? _fmtDisplay(_simTotalMg) : `0 ${_displayUnit()}`;

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
  if (unitEl) unitEl.textContent = _displayUnit();

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
      const mag  = _fmtDisplay(Math.abs(_deltaMg));
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
  const now = _timer.getElapsedMinutes();
  const fmtMin = (m) => {
    const h = Math.floor(m / 60);
    const r = Math.round(m % 60);
    return h > 0 ? `${h}h ${String(r).padStart(2, '0')}m` : `${r}m`;
  };
  const sign = _deltaMg > 0 ? '+' : '−';
  const mag = fmtTotalMass(Math.abs(_deltaMg), _drugId);

  if (_mode === 'spread') {
    const ratePerMin = _deltaMg / Math.max(now, 1e-6);
    const rateStr = (Math.abs(ratePerMin) >= 0.01 ? ratePerMin.toFixed(3) : ratePerMin.toExponential(2));
    const direction = _deltaMg > 0 ? 'higher' : 'lower';
    el.textContent =
      `A ${sign}${mag} correction will be spread evenly across the case ` +
      `(${rateStr} mg/min for ${fmtMin(now)}). ` +
      `Reconstructs sustained rate errors exactly — no convergence wait. ` +
      `Past curves will shift to reflect the corrected dose history. ` +
      `Note: forward of NOW the sim returns to the un-augmented rate. ` +
      `If the actual pump is still running ${direction} than the sim, ` +
      `the drift will rebuild — adjust your set rate to match reality.`;
    return;
  }

  // single-bolus mode
  const caseMin = _currentCaseMinutes();
  const patient = _model.getPatient ? _model.getPatient() : { weight: 70, height: 170, age: 40, male: true };
  const windowMin = getConvergenceWindow(_drugId, patient);
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
  const caution = (_deltaMg < 0)
    ? ' Expect a brief Cp dip at the insert point; the region will relax back.'
    : '';
  el.textContent =
    `A ${sign}${mag} correction will be added ${whenText}. ` +
    `Chart marked reconciling ${endRel}. ` +
    `Convergence window ~${Math.round(windowMin)} min (3 × intermediate t½).${caution}`;
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
  if (!(now > 0)) {
    if (err) err.textContent = 'Case has not started yet.';
    return;
  }

  // TCI conflict check — mirrors event-editor.js applyWithRules. If the
  // drug has any future TCI events, the reconcile mutation invalidates
  // the plan: future events were scheduled assuming a different
  // compartment state. Clear them and drop to manual so the user
  // re-engages TCI on their own beat. No auto-replan — that would kick
  // off bolus / rate-change prompts immediately, which is the wrong
  // moment.
  const futureTci = _model.getEvents(_drugId).filter(e =>
    e.source === 'tci' && e.time >= now,
  );
  if (futureTci.length > 0) {
    showTciWarning(
      'This will cancel TCI control and clear all future events from this point forward.',
      () => {
        _model.clearAfter(_drugId, now);
        setMode(_drugId, 'manual', 'Dropped to manual — dose reconciled');
        _doReconcile(now);
      },
    );
    return;
  }

  _doReconcile(now);
}

// Apply the reconcile mutation. Called either directly (no TCI conflict)
// or from the warning's onConfirm (after the future plan has been
// cleared). `now` is captured up-front so a slow user clicking through
// the warning doesn't shift the case-clock baseline.
function _doReconcile(now) {
  const err = $('rm-error');
  const patient = _model.getPatient ? _model.getPatient() : null;
  try {
    const sign = _deltaMg > 0 ? '+' : '-';
    const magStr = fmtTotalMass(Math.abs(_deltaMg), _drugId);

    // Snapshot the pre-correction Ce so the chart can render a ghost curve
    // for visual comparison. Done in BOTH modes, BEFORE the mutation, so
    // the ghost reflects the un-corrected state.
    let ghostPoints = null;
    if (_model.computeCurve) {
      try {
        const raw = _model.computeCurve(_drugId, 0, now, 10 / 60);
        ghostPoints = raw.map(p => ({ time: p.time, Ce: p.Ce }));
      } catch (e) { /* non-fatal */ }
    }

    let windowStart, windowEnd, annotMsg;

    if (_mode === 'spread') {
      const ratePerMin = _deltaMg / now;
      _model.applyRateAugmentation(_drugId, 0, now, ratePerMin);
      windowStart = 0;
      windowEnd = now + SPREAD_FORWARD_TAIL_MIN;
      annotMsg = `Reconciliation ${sign}${magStr} spread across case (${ratePerMin.toFixed(3)} mg/min × ${now.toFixed(0)} min)`;
    } else {
      let insertMin = _currentCaseMinutes();
      insertMin = Math.max(0, Math.min(now, insertMin));
      const winMin = patient ? getConvergenceWindow(_drugId, patient) : 45;
      _model.addBolus(_drugId, insertMin, _deltaMg, `Dose reconciliation ${sign}${magStr}`,
        { deliveryMode: 'push', source: 'manual' });
      windowStart = insertMin;
      windowEnd = insertMin + winMin;
      annotMsg = `Reconciliation ${sign}${magStr} as bolus @ ET ${Math.round(insertMin)}m`;
    }

    if (_model.setReconciliationWindow) {
      _model.setReconciliationWindow(_drugId, windowStart, windowEnd);
    }
    if (_model.setReconciliationGhost && ghostPoints) {
      _model.setReconciliationGhost(_drugId, { capturedAt: now, points: ghostPoints });
    }
    _addAnnotation(`Reconciled ${_drugId}: ${annotMsg}`);
    _refreshChart();
    close();
  } catch (e) {
    if (err) err.textContent = 'Failed to apply correction: ' + (e.message || e);
  }
}
