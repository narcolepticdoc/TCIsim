/**
 * history.js — Event History Panel
 * 
 * Renders the model's event list into the history panel.
 * Shows pump commands (rate, bolus, pause) with timing and
 * delivery details. System events (rate-restore after bolus)
 * are hidden. Events are colour-coded by source (manual, TCI).
 * 
 * The panel divides events into past (before current time)
 * and future (after current time, dimmed).
 */

import { DRUG_DEFS } from '../util/constants.js';
import { fromCanonical, getPrefKey, getDefaultUnit, formatValue }
  from '../util/units.js';

const $ = id => document.getElementById(id);

let _model = null;
let _getElapsedMinutes = null;
let _getPatient = null;
let _selectedDrug = 'propofol';
let _onEventTap = null;
let _timeFormat = 'et'; // 'et' = elapsed time, 'rt' = real time
let _getWallClockStart = null;
let _bolusOnly = false;  // When true, only bolus events are shown (intermittent mode)

/**
 * Initialize the history module.
 * @param {Object} opts
 * @param {Object} opts.model - simulation model
 * @param {Function} opts.getElapsedMinutes - () => number
 * @param {Function} opts.getPatient - () => patient object
 * @param {Function} [opts.onEventTap] - (evtId) => void
 */
export function init(opts) {
  _model = opts.model;
  _getElapsedMinutes = opts.getElapsedMinutes;
  _getPatient = opts.getPatient || (() => ({ weight: 70 }));
  _onEventTap = opts.onEventTap || null;
  _getWallClockStart = opts.getWallClockStart || null;

  // Delegate click: in edit mode, any row click opens the event editor.
  const list = $('history-list');
  if (list) {
    list.addEventListener('click', (e) => {
      if (!document.body.classList.contains('edit-history-mode')) return;
      const row = e.target.closest('.history-row');
      if (!row || !_onEventTap) return;
      const evtId = row.dataset.evtId;
      if (evtId) _onEventTap(evtId);
    });
  }
}

/** Toggle edit mode on the history panel. Returns the new state (true = on). */
export function toggleEditMode() {
  return document.body.classList.toggle('edit-history-mode');
}

/** Toggle the time-format display between elapsed (ET) and real-time (RT). */
export function toggleTimeFormat() {
  _timeFormat = _timeFormat === 'et' ? 'rt' : 'et';
  render(_selectedDrug);
  return _timeFormat;
}

/**
 * Set the currently selected drug (for display unit preferences).
 */
export function setDrug(drugId) {
  _selectedDrug = drugId;
}

/**
 * When true, render() shows only bolus events (used in intermittent mode).
 */
export function setBolusOnly(v) {
  _bolusOnly = !!v;
}

// ---- Formatting helpers ----

function fmtTime(minutes) {
  if (_timeFormat === 'rt' && _getWallClockStart) {
    const wallStart = _getWallClockStart();
    if (wallStart) {
      const realDate = new Date(wallStart.getTime() + minutes * 60000);
      const h = realDate.getHours();
      const m = String(realDate.getMinutes()).padStart(2, '0');
      const s = String(realDate.getSeconds()).padStart(2, '0');
      return `RT ${h}:${m}:${s}`;
    }
  }
  const totalSec = Math.round(minutes * 60);
  const h = Math.floor(totalSec / 3600);
  const m = String(Math.floor((totalSec % 3600) / 60)).padStart(2, '0');
  const s = String(totalSec % 60).padStart(2, '0');
  return `ET ${h}:${m}:${s}`;
}

function getPreferredRateUnit(drugId) {
  const prefKey = getPrefKey(drugId, 'rate');
  if (prefKey) {
    try {
      const saved = localStorage.getItem(prefKey);
      if (saved) return saved;
    } catch (e) {}
  }
  return getDefaultUnit(drugId, 'rate') || 'mg/min';
}

function getPreferredBolusUnit(drugId) {
  const prefKey = getPrefKey(drugId, 'bolus');
  if (prefKey) {
    try {
      const saved = localStorage.getItem(prefKey);
      if (saved) return saved;
    } catch (e) {}
  }
  return getDefaultUnit(drugId, 'bolus') || 'mg';
}

function fmtRate(mgPerMin, drugId) {
  const unit = getPreferredRateUnit(drugId);
  const patient = _getPatient();
  const ctx = { weightKg: patient?.weight || 70 };
  try {
    const val = fromCanonical(mgPerMin, unit, drugId, 'rate', ctx);
    return formatValue(val, unit) + ' ' + unit;
  } catch (e) {
    return mgPerMin.toFixed(1) + ' mg/min';
  }
}

function fmtBolusDose(mg, drugId) {
  const unit = getPreferredBolusUnit(drugId);
  const patient = _getPatient();
  const ctx = { weightKg: patient?.weight || 70 };
  try {
    const val = fromCanonical(mg, unit, drugId, 'bolus', ctx);
    return formatValue(val, unit) + ' ' + unit;
  } catch (e) {
    return mg.toFixed(1) + ' mg';
  }
}

// ---- Source badge ----

function sourceBadge(source) {
  if (source === 'tci') return '<span class="h-badge h-badge-tci">TCI</span>';
  return '';
}

// ---- Type icon / class ----

function typeClass(evt) {
  if (evt.type === 'bolus') return 'h-evt-bolus';
  if (evt.type === 'rate') return 'h-evt-rate';
  if (evt.type === 'pause') return 'h-evt-pause';
  return '';
}

// ---- Main render ----

/**
 * Render the event history for the selected drug.
 * Call after every model mutation or time change.
 */
export function render(drugId) {
  const drug = drugId || _selectedDrug;
  const list = $('history-list');
  const empty = $('history-empty');
  if (!list || !empty || !_model) return;

  let events = _model.getEvents(drug);
  if (_bolusOnly) events = events.filter(e => e.type === 'bolus');

  if (events.length === 0) {
    empty.style.display = 'block';
    list.innerHTML = '';
    return;
  }

  empty.style.display = 'none';

  const now = _getElapsedMinutes ? _getElapsedMinutes() : Infinity;

  // Build HTML
  const rows = [];
  for (let i = 0; i < events.length; i++) {
    const evt = events[i];
    const isPast = evt.time <= now;
    const isSystem = evt.source === 'system';
    const dimClass = isPast ? '' : ' h-future';
    const sysClass = isSystem ? ' h-system' : '';
    const tc = typeClass(evt);
    const badge = sourceBadge(evt.source);

    let desc = '';
    if (evt.type === 'bolus') {
      const dose = fmtBolusDose(evt.value, evt.drug);
      const modeLabel = evt.deliveryMode === 'push' ? 'IV Push' : 'Pump Bolus';
      desc = `<span class="h-type">${badge}${modeLabel}</span>` +
             `<span class="h-value"><strong>${dose}</strong></span>`;
    } else if (evt.type === 'rate') {
      if (evt.value === 0 && evt.source === 'tci') {
        // TCI-scheduled pause (pump holds until next TCI step)
        desc = `<span class="h-type">${badge}Paused</span>`;
      } else {
        const rate = fmtRate(evt.value, evt.drug);
        const prefix = isSystem ? '↩ ' : '';
        desc = `<span class="h-type">${badge}${prefix}Rate</span>` +
               `<span class="h-value"><strong>${rate}</strong></span>`;
      }
    } else if (evt.type === 'pause') {
      desc = `<span class="h-type">${badge}Pump Stopped</span>`;
    }

    rows.push(
      `<div class="history-row ${tc}${dimClass}${sysClass}" data-evt-id="${evt.id}" data-evt-time="${evt.time}">` +
        `<span class="h-time">${fmtTime(evt.time)}</span>` +
        `<span class="h-desc">${desc}</span>` +
      `</div>`
    );
  }

  list.innerHTML = rows.join('');
}

/**
 * Lightweight update: toggle past/future dimming on existing rows.
 * Call from rAF loop — no DOM rebuild, just class toggles.
 */
export function updateDimming() {
  const list = $('history-list');
  if (!list) return;
  const now = _getElapsedMinutes ? _getElapsedMinutes() : Infinity;
  const rows = list.children;
  for (let i = 0; i < rows.length; i++) {
    const t = parseFloat(rows[i].dataset.evtTime);
    if (isNaN(t)) continue;
    rows[i].classList.toggle('h-future', t > now);
  }
}
