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

import { toCanonical, fromCanonical, getAllowedUnits, getDefaultUnit, getPrefKey, getQuantStep,
         formatValue, formatValueEntry, getQuantizeConfig }
  from '../util/units.js';
import { isPumpEnabled } from '../util/constants.js';
import { applyBufferKey, convertBufferUnit, bolusTimeText } from './keypad-buffer.js';
import { makeTimePicker, buildTimeSelect, getSelectInt } from './time-picker.js';

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
let _prefilled = false;
let _picker = null; // shared case/real time picker (created in init)

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

  // Time picker (case/real) — shared factory; the RT label is prefixed
  // (`= RT h:mm`) and the "real" tab enables once the case has started.
  _picker = makeTimePicker({
    hoursId: 'ee-hours',
    minutesId: 'ee-minutes',
    unitRowSel: '#ee-time-unit .tp-unit',
    conversionId: 'ee-time-conversion',
    getWallClockStart: () => (_timer.getWallClockStart ? _timer.getWallClockStart() : null),
    isRunning: () => _controls.isCaseStarted(),
    labelStyle: 'prefix',
  });
  _picker.wireUnitButtons();

  // Keypad keys — pointerdown (not click) so rapid taps register reliably;
  // synthesized click events can be coalesced or dropped under fast touch input.
  document.querySelectorAll('#modal-evt-editor .ee-key').forEach(btn => {
    btn.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      handleKey(btn.textContent);
    });
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
  $('tci-warn-cancel')?.addEventListener('click', () => {
    // Always clear the pending action on cancel — otherwise a stale lambda
    // from a previous open could fire when the modal is reopened by another
    // caller (reconcile-modal also reuses this dialog).
    _pendingRuleAction = null;
    closeModal('modal-tci-warn');
  });
  $('tci-warn-confirm')?.addEventListener('click', confirmTciWarn);
}

export function setDrug(drugId) { _selectedDrug = drugId; }

/**
 * Open the shared TCI warning modal with `text`. The provided
 * `onConfirm` callback runs only if the user clicks Continue; if they
 * click Cancel, nothing happens.
 *
 * Exposed so other modules (currently reconcile-modal.js) can route
 * through the same warning dialog instead of duplicating UI.
 */
export function showTciWarning(text, onConfirm) {
  _pendingRuleAction = onConfirm || null;
  $('tci-warn-text').textContent = text;
  openModal('modal-tci-warn');
}

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
  _picker.setCaseMinutes(evt.time);

  if (evt.type === 'bolus' || evt.type === 'rate') {
    const task = evt.type === 'bolus' ? 'bolus' : 'rate';
    const patient = _getPatient();
    const ctx = { weightKg: patient?.weight || 70 };
    try {
      const displayVal = fromCanonical(evt.value, _currentUnit, _selectedDrug, task, ctx);
      // formatValueEntry: this buffer can be saved back unchanged, so it may
      // not round the event's own value away (a 0.03 mcg/kg/min fentanyl rate
      // came back as 0 under the unit's display cap).
      _buffer = formatValueEntry(displayVal, _currentUnit,
        getQuantStep(_selectedDrug, task, _currentUnit));
      _prefilled = true;
    } catch (e) {
      _buffer = String(evt.value);
      _prefilled = true;
    }
  } else {
    _buffer = ''; _prefilled = false;
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

  const pumpOn = isPumpEnabled(_selectedDrug);
  document.querySelectorAll('#ee-type-row .ee-type').forEach(btn => {
    const isInfusionType = btn.dataset.type === 'rate' || btn.dataset.type === 'pause';
    btn.disabled = !pumpOn && isInfusionType;
    btn.style.display = (!pumpOn && isInfusionType) ? 'none' : '';
  });

  setType('bolus');
  const now = _controls.isCaseStarted() ? _timer.getElapsedMinutes() : 0;
  _picker.setCaseMinutes(now);

  _buffer = ''; _prefilled = false;
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
  const pumpOn = isPumpEnabled(_selectedDrug);
  // No pump → boluses are always IV push; hide the separate push button
  $('ee-push-btn').style.display = (type === 'bolus' && pumpOn) ? '' : 'none';

  const btn = $('ee-confirm');
  if (type === 'bolus') {
    btn.textContent = _isEditMode ? 'Save Bolus' : (pumpOn ? 'Pump Bolus' : 'Administer');
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
    _buffer = ''; _prefilled = false;
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
      const prev = _currentUnit;
      _currentUnit = u;
      const task = _currentType === 'bolus' ? 'bolus' : 'rate';
      const prefKey = getPrefKey(_selectedDrug, task);
      if (prefKey) {
        try { localStorage.setItem(prefKey, u); } catch (e) {}
      }
      container.querySelectorAll('button').forEach(b =>
        b.classList.toggle('active', b.textContent === u));
      // Convert the current buffer value from the previous unit to the new
      // unit, preserving the user's entry and re-arming prefilled so the next
      // keypress overwrites. Leave empty buffer empty.
      const patient = _getPatient();
      const converted = convertBufferUnit(_buffer, prev, u, _selectedDrug, task,
        { weightKg: patient?.weight || 70 });
      if (converted) ({ buffer: _buffer, prefilled: _prefilled } = converted);
      updateDisplay();
    });
    container.appendChild(btn);
  });
}

// ---- Keypad ----

function handleKey(k) {
  const key = k === 'C' ? 'clear' : k === '⌫' ? 'back' : k;
  ({ buffer: _buffer, prefilled: _prefilled } = applyBufferKey({ buffer: _buffer, prefilled: _prefilled }, key));
  updateDisplay();
}

function updateDisplay() {
  const el = $('ee-value');
  if (el) {
    el.textContent = _buffer || '0';
    el.classList.toggle('empty', !_buffer);
  }

  const bt = $('ee-bolus-time');
  if (bt) bt.textContent = '';

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

    // For bolus, show how long the dose will be delivered over (canonical = mg).
    if (_currentType === 'bolus') updateBolusTime(canonical.value);
  } catch (e) {
    cv.textContent = '';
  }
}

/**
 * Populate the bolus-time line with the estimated delivery duration(s).
 * Push-only when the pump is disabled for the drug.
 * @param {number} doseMg - bolus dose in canonical mg
 */
function updateBolusTime(doseMg) {
  const bt = $('ee-bolus-time');
  if (!bt) return;
  bt.textContent = bolusTimeText(doseMg, _selectedDrug, { pushOnly: !isPumpEnabled(_selectedDrug) });
}

/**
 * Populate pause duration selects.
 * Always 0-10 hours, 0-59 minutes. Duration validation
 * happens on confirm — if it reaches the next event,
 * treated as "until next event" (no rate-restore).
 */
function populatePauseDuration() {
  buildTimeSelect($('ee-pause-hours'), 11, 1, 0, _picker.handleSelectChange);
  buildTimeSelect($('ee-pause-minutes'), 60, 2, 10, _picker.handleSelectChange);
}

// ---- Confirm ----

function doConfirm(deliveryMode) {
  const time = _picker.getCaseMinutes();
  const drug = _selectedDrug;
  // Force IV push when pump is disabled
  if (!isPumpEnabled(drug)) deliveryMode = 'push';

  if (_currentType === 'pause') {
    applyWithRules(time, () => {
      // Capture the active rate BEFORE inserting the pause
      const priorRate = _model.getRateAtTime(drug, time);
      
      if (_isEditMode && _editEvtId) _model.deleteEvent(_editEvtId);
      _model.addPause(drug, time, 'Pause');
      if (_pauseMode === 'timed') {
        const dur = getSelectInt('ee-pause-hours') * 60 + getSelectInt('ee-pause-minutes');
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
        if (oldEvt.source === 'tci') changes.source = 'manual';
        if (oldEvt.type === 'bolus') changes.deliveryMode = deliveryMode;
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
    showTciWarning('Editing a past event will cancel TCI control and clear all future events.', () => {
      action();
      _model.clearAfter(drug, now);
      _mode.set(drug, 'manual', 'Dropped to manual — past event edited');
      close();
      _refreshChart();
    });
  } else if (!isRunning && eventTime < tciStart) {
    showTciWarning('The TCI plan will be recalculated to account for this change.', () => {
      action();
      for (const e of allTci) { try { _model.deleteEvent(e.id); } catch (x) {} }
      if (ceTarget > 0) _model.planTCI(drug, tciStart, ceTarget, getQuantizeConfig(drug));
      close();
      _refreshChart();
    });
  } else {
    showTciWarning('This will cancel TCI control and clear all events from this point forward.', () => {
      action();
      _model.clearAfter(drug, eventTime);
      _mode.set(drug, 'manual', 'Dropped to manual — event in TCI space');
      close();
      _refreshChart();
    });
  }
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
  _buffer = ''; _prefilled = false;
}
