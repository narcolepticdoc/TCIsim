/**
 * event-editor.js — Event Editing & Creation
 * 
 * Handles the action sheet (tap event → edit/delete), time picker,
 * add-event flow, and TCI conflict rules.
 * 
 * Rules:
 *   1. Replay is automatic (events.js handles it).
 *   2. TCI conflict:
 *      2a. Planning + event before TCI start → warn, clear TCI, re-plan. Stay TCI.
 *      2b. Event at/after TCI start → warn, clear from t onward, drop to manual.
 *   3. Past edits while running:
 *      3a. TCI exists at/after t → clear after now, drop to manual.
 *      3b. No TCI → replay silently.
 *   4. TCI target in the past → major warning, wipe from t forward, re-plan.
 *   5. No TCI involvement → replay silently.
 */

const $ = id => document.getElementById(id);

let _model = null;
let _mode = null;
let _timer = null;
let _controls = null;
let _selectedDrug = 'propofol';
let _refreshChart = null;
let _openKeypadForEdit = null; // (type, prefill, callback) => void

// State for pending operations
let _pendingEvtId = null;
let _pendingAction = null; // 'editValue' | 'editTime' | 'delete' | 'deleteAfter'
let _pendingAddType = null; // 'bolus' | 'rate' | 'pause'
let _pendingAddTime = null;

/**
 * Initialize the event editor.
 */
export function init(opts) {
  _model = opts.model;
  _mode = opts.mode;
  _timer = opts.timer;
  _controls = opts.controls;
  _refreshChart = opts.refreshChart;
  _openKeypadForEdit = opts.openKeypadForEdit;

  // Action sheet cancel
  $('evt-actions-cancel')?.addEventListener('click', () => closeModal('modal-evt-actions'));

  // Time picker
  $('time-picker-cancel')?.addEventListener('click', () => closeModal('modal-time-picker'));
  $('time-picker-confirm')?.addEventListener('click', confirmTimePicker);

  // Add event
  $('btn-add-event')?.addEventListener('click', openAddEvent);
  $('add-evt-cancel')?.addEventListener('click', () => closeModal('modal-add-event'));
  $('add-evt-confirm')?.addEventListener('click', confirmAddEvent);

  // Add event type buttons
  document.querySelectorAll('.add-evt-type').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.add-evt-type').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      _pendingAddType = btn.dataset.type;
      // Update confirm button text
      const confirmBtn = $('add-evt-confirm');
      if (confirmBtn) {
        confirmBtn.textContent = _pendingAddType === 'pause' ? 'Add Pause' : 'Next: Set Value';
      }
    });
  });

  // TCI warning
  $('tci-warn-cancel')?.addEventListener('click', () => closeModal('modal-tci-warn'));
  $('tci-warn-confirm')?.addEventListener('click', confirmTciWarn);
}

export function setDrug(drugId) {
  _selectedDrug = drugId;
}

// ---- Modal helpers ----

function openModal(id) { $(id)?.classList.add('open'); }
function closeModal(id) { $(id)?.classList.remove('open'); }

// ---- Action Sheet ----

/**
 * Open the action sheet for an event.
 * Called from history.js when a row is tapped.
 */
export function openActionSheet(evtId) {
  const events = _model.getEvents(_selectedDrug);
  const evt = events.find(e => e.id === evtId);
  if (!evt) return;

  _pendingEvtId = evtId;

  // Title and description
  const title = $('evt-actions-title');
  const desc = $('evt-actions-desc');
  const list = $('evt-actions-list');

  const timeStr = fmtTime(evt.time);
  if (evt.type === 'bolus') {
    title.textContent = 'Bolus Event';
    desc.textContent = `${evt.value.toFixed(1)} mg at ${timeStr}`;
  } else if (evt.type === 'rate') {
    title.textContent = 'Rate Event';
    desc.textContent = `${evt.value.toFixed(1)} mg/min at ${timeStr}`;
  } else if (evt.type === 'pause') {
    title.textContent = 'Pause Event';
    desc.textContent = `Pump paused at ${timeStr}`;
  }

  // Build action buttons
  const actions = [];
  if (evt.source !== 'tci') {
    if (evt.type !== 'pause') {
      actions.push({ label: 'Edit Value', action: 'editValue' });
    }
    actions.push({ label: 'Edit Time', action: 'editTime' });
    actions.push({ label: 'Delete', action: 'delete', cls: 'danger' });
  }
  actions.push({ label: 'Delete This & All After', action: 'deleteAfter', cls: 'danger' });

  list.innerHTML = '';
  for (const a of actions) {
    const btn = document.createElement('button');
    btn.className = 'evt-action-btn' + (a.cls ? ' ' + a.cls : '');
    btn.textContent = a.label;
    btn.addEventListener('click', () => {
      closeModal('modal-evt-actions');
      handleAction(a.action, evt);
    });
    list.appendChild(btn);
  }

  openModal('modal-evt-actions');
}

function handleAction(action, evt) {
  if (action === 'editValue') {
    // Open keypad pre-filled with current value
    const type = evt.type === 'bolus' ? 'bolus' : 'rate';
    _pendingAction = 'editValue';
    _openKeypadForEdit(type, evt.value, (canonicalValue) => {
      applyWithRules(evt.time, () => {
        _model.editEvent(evt.id, { value: canonicalValue });
      });
    });
  } else if (action === 'editTime') {
    _pendingAction = 'editTime';
    openTimePicker(evt.time, (newMinutes) => {
      applyWithRules(Math.min(evt.time, newMinutes), () => {
        _model.editEvent(evt.id, { time: newMinutes });
      });
    });
  } else if (action === 'delete') {
    applyWithRules(evt.time, () => {
      _model.deleteEvent(evt.id);
    });
  } else if (action === 'deleteAfter') {
    applyWithRules(evt.time, () => {
      _model.deleteEventAndAfter(evt.id);
    });
  }
}

// ---- Time Picker ----

let _timePickerCallback = null;

function minutesToTimeStr(minutes) {
  const h = Math.floor(minutes / 60);
  const m = Math.round(minutes % 60);
  return String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0');
}

function timeStrToMinutes(str) {
  const parts = (str || '').split(':');
  const h = parseInt(parts[0]) || 0;
  const m = parseInt(parts[1]) || 0;
  return h * 60 + m;
}

function openTimePicker(currentMinutes, callback) {
  _timePickerCallback = callback;
  const input = $('time-picker-input');
  if (input) {
    input.value = minutesToTimeStr(currentMinutes);
  }
  openModal('modal-time-picker');
  if (input) input.focus();
}

function confirmTimePicker() {
  const input = $('time-picker-input');
  const minutes = timeStrToMinutes(input?.value);
  closeModal('modal-time-picker');
  if (_timePickerCallback) {
    _timePickerCallback(minutes);
    _timePickerCallback = null;
  }
}

// ---- Add Event ----

function openAddEvent() {
  _pendingAddType = 'bolus';
  // Reset type buttons
  document.querySelectorAll('.add-evt-type').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.type === 'bolus');
  });
  // Default time to now
  const now = _controls.isCaseStarted() ? _timer.getElapsedMinutes() : 0;
  const input = $('add-evt-time');
  if (input) input.value = minutesToTimeStr(now);
  $('add-evt-confirm').textContent = 'Next: Set Value';
  openModal('modal-add-event');
}

function confirmAddEvent() {
  const input = $('add-evt-time');
  const time = timeStrToMinutes(input?.value);
  _pendingAddTime = time;
  closeModal('modal-add-event');

  if (_pendingAddType === 'pause') {
    // Pause has no value — insert directly
    applyWithRules(time, () => {
      _model.addPause(_selectedDrug, time, 'Pause (added from history)');
    });
  } else {
    // Open keypad for value entry
    const type = _pendingAddType; // 'bolus' or 'rate'
    _openKeypadForEdit(type, null, (canonicalValue) => {
      applyWithRules(time, () => {
        if (type === 'bolus') {
          _model.addBolus(_selectedDrug, time, canonicalValue,
            `Bolus ${canonicalValue.toFixed(1)} mg (added from history)`);
        } else {
          _model.addRate(_selectedDrug, time, canonicalValue,
            `Rate ${canonicalValue.toFixed(1)} mg/min (added from history)`);
        }
      });
    });
  }
}

// ---- TCI Conflict Rule Engine ----

let _pendingRuleAction = null;
let _pendingRuleContext = null;

/**
 * Apply an edit/add/delete action with TCI conflict rules.
 * @param {number} eventTime - time of the affected event
 * @param {Function} action - the mutation to perform
 */
function applyWithRules(eventTime, action) {
  const drug = _selectedDrug;
  const events = _model.getEvents(drug);
  const isRunning = _controls.isCaseStarted();
  const now = isRunning ? _timer.getElapsedMinutes() : Infinity;

  // Find TCI events at or after eventTime
  const tciEvents = events.filter(e => e.source === 'tci' && e.time >= eventTime);
  const hasTci = tciEvents.length > 0;

  // Find the TCI target start time (earliest TCI event)
  const allTciEvents = events.filter(e => e.source === 'tci');
  const tciStartTime = allTciEvents.length > 0
    ? Math.min(...allTciEvents.map(e => e.time))
    : Infinity;

  // Get current TCI target (if in TCI mode)
  const currentMode = _mode.get(drug);
  const ceTarget = _mode.getCeTarget(drug);

  if (!hasTci) {
    // Rule 5: No TCI involvement — just do it
    action();
    _refreshChart();
    return;
  }

  // TCI is involved — determine which rule applies
  if (isRunning && eventTime < now) {
    // Rule 3a: Past edit while running, TCI exists
    _pendingRuleAction = () => {
      action();
      // Clear all events after now
      _model.clearAfter(drug, now);
      _mode.set(drug, 'manual', 'Dropped to manual — past event edited');
      _refreshChart();
    };
    showTciWarning('Editing a past event will cancel TCI control and clear all future events.');
  } else if (!isRunning && eventTime < tciStartTime) {
    // Rule 2a: Planning mode, event before TCI start — re-plan
    _pendingRuleAction = () => {
      action();
      // Clear all TCI events
      const tciIds = allTciEvents.map(e => e.id);
      for (const id of tciIds) {
        try { _model.deleteEvent(id); } catch (e) {}
      }
      // Re-plan same target
      if (ceTarget > 0) {
        _model.planTCI(drug, tciStartTime, ceTarget);
      }
      _refreshChart();
    };
    showTciWarning('The TCI plan will be recalculated to account for this change.');
  } else {
    // Rule 2b: Event at or after TCI start
    _pendingRuleAction = () => {
      action();
      // Clear from eventTime onward
      _model.clearAfter(drug, eventTime);
      _mode.set(drug, 'manual', 'Dropped to manual — event added/edited in TCI space');
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
  if (_pendingRuleAction) {
    _pendingRuleAction();
    _pendingRuleAction = null;
  }
}

// ---- Helpers ----

function fmtTime(minutes) {
  const totalSec = Math.round(minutes * 60);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return String(m).padStart(3, '0') + ':' + String(s).padStart(2, '0');
}
