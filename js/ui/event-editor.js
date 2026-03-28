/**
 * event-editor.js — Unified Event Editor Modal
 * 
 * Single modal for adding, editing, and deleting events.
 * Combines type selector, time picker (case/real), value keypad,
 * and pause duration into one interface.
 * 
 * Opened by:
 *   - Edit button on history rows → pre-filled with event data
 *   - "+ Add Event" button → blank with defaults
 * 
 * TCI conflict rules (2a/2b/3a/3b/4/5) apply on confirm/delete.
 */

import { toCanonical, fromCanonical, getAllowedUnits, getDefaultUnit, getPrefKey, formatValue }
  from '../util/units.js';

const $ = id => document.getElementById(id);

let _model = null;
let _mode = null;
let _timer = null;
let _controls = null;
let _selectedDrug = 'propofol';
let _refreshChart = null;
let _getPatient = null;

let _isEditMode = false;
let _editEvtId = null;
let _editOrigTime = null;
let _currentType = 'bolus';
let _buffer = '';
let _currentUnit = 'mg';
let _pauseMode = 'until';
let _timeUnit = 'case';

// ---- Init ----

export function init(opts) {
  _model = opts.model;
  _mode = opts.mode;
  _timer = opts.timer;
  _controls = opts.controls;
  _refreshChart = opts.refreshChart;
  _getPatient = opts.getPatient || (() => ({ weight: 70 }));

  // Type selector
  document.querySelectorAll('#ee-type-row .ee-type').forEach(btn => {
    btn.addEventListener('click', () => {
      if (btn.disabled) return;
      setType(btn.dataset.type);
    });
  });

  // Time unit toggle
  document.querySelectorAll('#ee-time-unit .tp-unit').forEach(btn => {
    btn.addEventListener('click', () => {
      if (btn.disabled) return;
      setTimeUnit(btn.dataset.unit);
    });
  });

  // Keypad keys
  document.querySelectorAll('#modal-evt-editor .ee-key').forEach(btn => {
    btn.addEventListener('click', () => handleKey(btn.textContent));
  });

  // Pause mode toggle
  document.querySelectorAll('.ee-pause-mode').forEach(btn => {
    btn.addEventListener('click', () => {
      _pauseMode = btn.dataset.mode;
      document.querySelectorAll('.ee-pause-mode').forEach(b =>
        b.classList.toggle('active', b.dataset.mode === _pauseMode));
      $('ee-pause-dur').style.display = _pauseMode === 'timed' ? '' : 'none';
      if (_pauseMode === 'timed') {
        populatePauseDuration();
      }
    });
  });

  // Action buttons
  $('ee-cancel')?.addEventListener('click', close);
  $('ee-confirm')?.addEventListener('click', () => doConfirm('pump'));
  $('ee-push-btn')?.addEventListener('click', () => doConfirm('push'));
  $('ee-delete')?.addEventListener('click', handleDelete);
  $('ee-delete-after')?.addEventListener('click', handleDeleteAfter);
  $('btn-add-event')?.addEventListener('click', () => openAdd());

  // TCI warning
  $('tci-warn-cancel')?.addEventListener('click', () => closeModal('modal-tci-warn'));
  $('tci-warn-confirm')?.addEventListener('click', confirmTciWarn);
}

export function setDrug(drugId) { _selectedDrug = drugId; }

// ---- Open for editing ----

export function openEdit(evtId) {
  const events = _model.getEvents(_selectedDrug);
  const evt = events.find(e => e.id === evtId);
  if (!evt) return;

  _isEditMode = true;
  _editEvtId = evtId;
  _editOrigTime = evt.time;

  $('evt-editor-title').textContent = 'Edit Event';
  $('ee-delete-row').style.display = 'flex';

  const isTci = evt.source === 'tci';
  document.querySelectorAll('#ee-type-row .ee-type').forEach(btn => {
    btn.disabled = isTci;
  });

  setType(evt.type);
  setTimeFromMinutes(evt.time);

  if (evt.type === 'bolus' || evt.type === 'rate') {
    const task = evt.type === 'bolus' ? 'bolus' : 'rate';
    const patient = _getPatient();
    const ctx = { weightKg: patient?.weight || 70 };
    try {
      const displayVal = fromCanonical(evt.value, _currentUnit, _selectedDrug, task, ctx);
      _buffer = formatValue(displayVal, _currentUnit);
    } catch (e) {
      _buffer = String(evt.value);
    }
  } else {
    _buffer = '';
  }

  updateDisplay();
  openModal('modal-evt-editor');
}

// ---- Open for adding ----

export function openAdd() {
  _isEditMode = false;
  _editEvtId = null;
  _editOrigTime = null;

  $('evt-editor-title').textContent = 'Add Event';
  $('ee-delete-row').style.display = 'none';

  document.querySelectorAll('#ee-type-row .ee-type').forEach(btn => {
    btn.disabled = false;
  });

  setType('bolus');
  const now = _controls.isCaseStarted() ? _timer.getElapsedMinutes() : 0;
  setTimeFromMinutes(now);

  _buffer = '';
  _pauseMode = 'until';
  document.querySelectorAll('.ee-pause-mode').forEach(b =>
    b.classList.toggle('active', b.dataset.mode === 'until'));
  $('ee-pause-dur').style.display = 'none';

  updateDisplay();
  openModal('modal-evt-editor');
}

// ---- Type selector ----

function setType(type) {
  _currentType = type;
  document.querySelectorAll('#ee-type-row .ee-type').forEach(btn =>
    btn.classList.toggle('active', btn.dataset.type === type));

  $('ee-value-section').style.display = type === 'pause' ? 'none' : '';
  $('ee-pause-section').style.display = type === 'pause' ? '' : 'none';
  $('ee-push-btn').style.display = type === 'bolus' ? '' : 'none';
  const valLabel = $('ee-value-label');
  if (valLabel) valLabel.textContent = type === 'bolus' ? 'Dose' : 'Rate';

  const btn = $('ee-confirm');
  if (type === 'bolus') {
    btn.textContent = _isEditMode ? 'Save Bolus' : 'Give Bolus';
    btn.className = 'modal-btn-confirm-bolus';
  } else if (type === 'rate') {
    btn.textContent = _isEditMode ? 'Save Rate' : 'Set Rate';
    btn.className = 'modal-btn-confirm-rate';
  } else {
    btn.textContent = _isEditMode ? 'Save Pause' : 'Set Pause';
    btn.className = 'modal-btn-confirm-rate';
  }

  if (type !== 'pause') {
    const task = type === 'bolus' ? 'bolus' : 'rate';
    const allowed = getAllowedUnits(_selectedDrug, task);
    const prefKey = getPrefKey(_selectedDrug, task);
    let savedUnit = null;
    if (prefKey) {
      try { savedUnit = localStorage.getItem(prefKey); } catch (e) {}
    }
    _currentUnit = (savedUnit && allowed.includes(savedUnit))
      ? savedUnit : (getDefaultUnit(_selectedDrug, task) || allowed[0]);
    renderUnitToggle(allowed);
    _buffer = '';
  }
  updateDisplay();
}

// ---- Unit toggle ----

function renderUnitToggle(allowed) {
  const container = $('ee-units');
  if (!container) return;
  container.innerHTML = '';
  allowed.forEach(u => {
    const btn = document.createElement('button');
    btn.textContent = u;
    btn.className = u === _currentUnit ? 'active' : '';
    btn.addEventListener('click', () => {
      _currentUnit = u;
      const prefKey = getPrefKey(_selectedDrug, _currentType === 'bolus' ? 'bolus' : 'rate');
      if (prefKey) {
        try { localStorage.setItem(prefKey, u); } catch (e) {}
      }
      container.querySelectorAll('button').forEach(b =>
        b.classList.toggle('active', b.textContent === u));
      _buffer = '';
      updateDisplay();
    });
    container.appendChild(btn);
  });
}

// ---- Keypad ----

function handleKey(k) {
  if (k === 'C') { _buffer = ''; }
  else if (k === '⌫') { _buffer = _buffer.slice(0, -1); }
  else if (k === '.') { if (!_buffer.includes('.')) _buffer += _buffer ? '.' : '0.'; }
  else { if (_buffer.length < 8) _buffer += k; }
  updateDisplay();
}

function updateDisplay() {
  const el = $('ee-value');
  if (el) {
    el.textContent = _buffer || '0';
    el.classList.toggle('empty', !_buffer);
  }

  const cv = $('ee-conversion');
  if (!cv) return;
  if (_currentType === 'pause') { cv.textContent = ''; return; }

  const v = parseFloat(_buffer);
  const patient = _getPatient();
  if (isNaN(v) || v <= 0 || !patient) { cv.textContent = ''; return; }

  const task = _currentType === 'bolus' ? 'bolus' : 'rate';
  try {
    const ctx = { weightKg: patient.weight };
    const canonical = toCanonical(v, _currentUnit, _selectedDrug, task, ctx);
    const allowed = getAllowedUnits(_selectedDrug, task);
    const others = allowed.filter(u => u !== _currentUnit);
    const parts = others.map(u => {
      const dv = fromCanonical(canonical.value, u, _selectedDrug, task, ctx);
      return `${formatValue(dv, u)} ${u}`;
    });
    if (_currentUnit !== canonical.unit && !others.includes(canonical.unit)) {
      parts.unshift(`${formatValue(canonical.value, canonical.unit)} ${canonical.unit}`);
    }
    cv.textContent = parts.length > 0 ? '= ' + parts.join(' · ') : '';
  } catch (e) {
    cv.textContent = '';
  }
}

// ---- Time picker ----

function setTimeFromMinutes(minutes) {
  _timeUnit = 'case';
  const h = Math.floor(minutes / 60);
  const m = Math.round(minutes % 60);
  buildSelect($('ee-hours'), 24, 2, h);
  buildSelect($('ee-minutes'), 60, 2, m);
  const isRunning = _controls.isCaseStarted();
  document.querySelectorAll('#ee-time-unit .tp-unit').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.unit === 'case');
    if (btn.dataset.unit === 'real') btn.disabled = !isRunning;
  });
  updateTimeConversion();
}

function getSelectedCaseMinutes() {
  if (_timeUnit === 'case') {
    return getSelectVal('ee-hours') * 60 + getSelectVal('ee-minutes');
  }
  const realH = getSelectVal('ee-hours');
  const realM = getSelectVal('ee-minutes');
  const wallStart = _timer.getWallClockStart ? _timer.getWallClockStart() : null;
  if (!wallStart) return realH * 60 + realM;
  const target = new Date(wallStart);
  target.setHours(realH, realM, 0, 0);
  return Math.max(0, (target - wallStart) / 60000);
}

function setTimeUnit(unit) {
  const caseMin = getSelectedCaseMinutes();
  _timeUnit = unit;
  document.querySelectorAll('#ee-time-unit .tp-unit').forEach(btn =>
    btn.classList.toggle('active', btn.dataset.unit === unit));

  if (unit === 'case') {
    buildSelect($('ee-hours'), 24, 2, Math.floor(caseMin / 60));
    buildSelect($('ee-minutes'), 60, 2, Math.round(caseMin % 60));
  } else {
    const wallStart = _timer.getWallClockStart ? _timer.getWallClockStart() : null;
    if (wallStart) {
      const realDate = new Date(wallStart.getTime() + caseMin * 60000);
      buildSelect($('ee-hours'), 24, 2, realDate.getHours());
      buildSelect($('ee-minutes'), 60, 2, realDate.getMinutes());
    }
  }
  updateTimeConversion();
}

function updateTimeConversion() {
  const cv = $('ee-time-conversion');
  if (!cv) return;
  const isRunning = _controls.isCaseStarted();
  const wallStart = _timer.getWallClockStart ? _timer.getWallClockStart() : null;

  if (_timeUnit === 'case') {
    const caseMin = getSelectVal('ee-hours') * 60 + getSelectVal('ee-minutes');
    if (isRunning && wallStart) {
      const rd = new Date(wallStart.getTime() + caseMin * 60000);
      const h = rd.getHours();
      const m = String(rd.getMinutes()).padStart(2, '0');
      cv.textContent = `= RT ${h}:${m}`;
    } else { cv.textContent = ''; }
  } else {
    if (wallStart) {
      const target = new Date(wallStart);
      target.setHours(getSelectVal('ee-hours'), getSelectVal('ee-minutes'), 0, 0);
      const caseMin = Math.max(0, (target - wallStart) / 60000);
      const h = Math.floor(caseMin / 60);
      const m = String(Math.round(caseMin % 60)).padStart(2, '0');
      cv.textContent = `= ET ${h}:${m}`;
    } else { cv.textContent = ''; }
  }
}

// ---- Select builder ----

function buildSelect(selectEl, count, padLen, selectedVal) {
  if (!selectEl) return;
  selectEl.innerHTML = '';
  for (let i = 0; i < count; i++) {
    const opt = document.createElement('option');
    opt.value = i;
    opt.textContent = String(i).padStart(padLen, '0');
    if (i === selectedVal) opt.selected = true;
    selectEl.appendChild(opt);
  }
  selectEl.onchange = updateTimeConversion;
}

function getSelectVal(id) {
  const el = $(id);
  return el ? parseInt(el.value) || 0 : 0;
}

/**
 * Populate pause duration selects.
 * Always 0-10 hours, 0-59 minutes. Duration validation
 * happens on confirm — if it reaches the next event,
 * treated as "until next event" (no rate-restore).
 */
function populatePauseDuration() {
  buildSelect($('ee-pause-hours'), 11, 1, 0);
  buildSelect($('ee-pause-minutes'), 60, 2, 10);
}

// ---- Confirm ----

function doConfirm(deliveryMode) {
  const time = getSelectedCaseMinutes();
  const drug = _selectedDrug;

  if (_currentType === 'pause') {
    applyWithRules(time, () => {
      // Capture the active rate BEFORE inserting the pause
      const priorRate = _model.getRateAtTime(drug, time);
      
      if (_isEditMode && _editEvtId) _model.deleteEvent(_editEvtId);
      _model.addPause(drug, time, 'Pause');
      if (_pauseMode === 'timed') {
        const dur = getSelectVal('ee-pause-hours') * 60 + getSelectVal('ee-pause-minutes');
        if (dur > 0) {
          // Check if duration reaches or passes the next event
          const events = _model.getEvents(drug);
          let nextEvtTime = Infinity;
          for (const e of events) {
            if (e.time > time && e.source !== 'system' && e.type !== 'pause') {
              nextEvtTime = e.time;
              break;
            }
          }
          if (time + dur < nextEvtTime) {
            // Safe — insert rate-restore with the pre-pause rate
            _model.addRate(drug, time + dur, priorRate,
              `Rate ${priorRate.toFixed(1)} mg/min restored after timed pause`,
              { source: 'system' });
          }
          // else: duration reaches next event — silently treat as "until next event"
        }
      }
    });
    return;
  }

  const v = parseFloat(_buffer);
  if (isNaN(v) || v <= 0) return;

  const task = _currentType === 'bolus' ? 'bolus' : 'rate';
  const patient = _getPatient();
  const ctx = { weightKg: patient?.weight || 70 };
  let canonicalValue;
  try { canonicalValue = toCanonical(v, _currentUnit, drug, task, ctx).value; }
  catch (e) { return; }

  applyWithRules(time, () => {
    if (_isEditMode && _editEvtId) {
      const events = _model.getEvents(drug);
      const oldEvt = events.find(e => e.id === _editEvtId);
      if (oldEvt && oldEvt.type !== _currentType) {
        // Type changed — delete old, create new
        _model.deleteEvent(_editEvtId);
        if (_currentType === 'bolus') {
          _model.addBolus(drug, time, canonicalValue, `Bolus ${canonicalValue.toFixed(1)} mg`, { deliveryMode });
        } else {
          _model.addRate(drug, time, canonicalValue, `Rate ${canonicalValue.toFixed(1)} mg/min`);
        }
      } else if (oldEvt) {
        const changes = { value: canonicalValue };
        if (Math.abs(time - oldEvt.time) > 0.001) changes.time = time;
        // Edited TCI events become manual — user took ownership
        if (oldEvt.source === 'tci') changes.source = 'manual';
        _model.editEvent(_editEvtId, changes);
      }
    } else {
      if (_currentType === 'bolus') {
        _model.addBolus(drug, time, canonicalValue, `Bolus ${canonicalValue.toFixed(1)} mg`, { deliveryMode });
      } else {
        _model.addRate(drug, time, canonicalValue, `Rate ${canonicalValue.toFixed(1)} mg/min`);
      }
    }
  });
}

// ---- Delete ----

function handleDelete() {
  if (!_editEvtId) return;
  const evt = _model.getEvents(_selectedDrug).find(e => e.id === _editEvtId);
  if (!evt) return;
  applyWithRules(evt.time, () => { _model.deleteEvent(_editEvtId); });
}

function handleDeleteAfter() {
  if (!_editEvtId) return;
  const evt = _model.getEvents(_selectedDrug).find(e => e.id === _editEvtId);
  if (!evt) return;
  applyWithRules(evt.time, () => { _model.deleteEventAndAfter(_editEvtId); });
}

// ---- TCI Rule Engine ----

let _pendingRuleAction = null;

function applyWithRules(eventTime, action) {
  const drug = _selectedDrug;
  const events = _model.getEvents(drug);
  const isRunning = _controls.isCaseStarted();
  const now = isRunning ? _timer.getElapsedMinutes() : Infinity;

  const tciAfter = events.filter(e => e.source === 'tci' && e.time >= eventTime);
  const allTci = events.filter(e => e.source === 'tci');
  const tciStart = allTci.length > 0 ? Math.min(...allTci.map(e => e.time)) : Infinity;
  const ceTarget = _mode.getCeTarget(drug);

  if (tciAfter.length === 0) {
    action();
    close();
    _refreshChart();
    return;
  }

  if (isRunning && eventTime < now) {
    _pendingRuleAction = () => {
      action();
      _model.clearAfter(drug, now);
      _mode.set(drug, 'manual', 'Dropped to manual — past event edited');
      close();
      _refreshChart();
    };
    showTciWarning('Editing a past event will cancel TCI control and clear all future events.');
  } else if (!isRunning && eventTime < tciStart) {
    _pendingRuleAction = () => {
      action();
      for (const e of allTci) { try { _model.deleteEvent(e.id); } catch (x) {} }
      if (ceTarget > 0) _model.planTCI(drug, tciStart, ceTarget);
      close();
      _refreshChart();
    };
    showTciWarning('The TCI plan will be recalculated to account for this change.');
  } else {
    _pendingRuleAction = () => {
      action();
      _model.clearAfter(drug, eventTime);
      _mode.set(drug, 'manual', 'Dropped to manual — event in TCI space');
      close();
      _refreshChart();
    };
    showTciWarning('This will cancel TCI control and clear all events from this point forward.');
  }
}

function showTciWarning(text) {
  $('tci-warn-text').textContent = text;
  openModal('modal-tci-warn');
}

function confirmTciWarn() {
  closeModal('modal-tci-warn');
  if (_pendingRuleAction) { _pendingRuleAction(); _pendingRuleAction = null; }
}

// ---- Modal helpers ----

function openModal(id) { $(id)?.classList.add('open'); }
function closeModal(id) { $(id)?.classList.remove('open'); }

function close() {
  closeModal('modal-evt-editor');
  _editEvtId = null;
  _editOrigTime = null;
  _buffer = '';
}
