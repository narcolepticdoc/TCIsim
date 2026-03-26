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

import { DRUG_DEFS, bolusDeliveryMinutes } from '../util/constants.js';
import { fromCanonical, getPrefKey, getDefaultUnit, formatValue }
  from '../util/units.js';

const $ = id => document.getElementById(id);

let _model = null;
let _getElapsedMinutes = null;
let _getPatient = null;
let _selectedDrug = 'propofol';
let _onEventTap = null;

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

  // Delegate click on history list
  const list = $('history-list');
  if (list) {
    list.addEventListener('click', (e) => {
      const row = e.target.closest('.history-row');
      if (!row || !_onEventTap) return;
      const evtId = row.dataset.evtId;
      if (evtId) _onEventTap(evtId);
    });
  }
}

/**
 * Set the currently selected drug (for display unit preferences).
 */
export function setDrug(drugId) {
  _selectedDrug = drugId;
}

// ---- Formatting helpers ----

function fmtTime(minutes) {
  const totalSec = Math.round(minutes * 60);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return String(m).padStart(3, '0') + ':' + String(s).padStart(2, '0');
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

function fmtBolusDelivery(evt) {
  if (evt.deliveryMode === 'push') {
    return '10 sec push';
  }
  const durMin = bolusDeliveryMinutes(evt.value, evt.drug);
  if (durMin < 1) {
    return Math.round(durMin * 60) + ' sec';
  }
  return durMin.toFixed(1) + ' min';
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

  const events = _model.getEvents(drug);
  // Filter out system events (rate-restore after bolus)
  const visible = events.filter(e => e.source !== 'system');

  if (visible.length === 0) {
    empty.style.display = 'block';
    list.innerHTML = '';
    return;
  }

  empty.style.display = 'none';

  const now = _getElapsedMinutes ? _getElapsedMinutes() : Infinity;

  // Build HTML
  const rows = [];
  for (let i = 0; i < visible.length; i++) {
    const evt = visible[i];
    const isPast = evt.time <= now;
    const dimClass = isPast ? '' : ' h-future';
    const tc = typeClass(evt);
    const badge = sourceBadge(evt.source);

    let desc = '';
    if (evt.type === 'bolus') {
      const dose = fmtBolusDose(evt.value, evt.drug);
      const delivery = fmtBolusDelivery(evt);
      const modeLabel = evt.deliveryMode === 'push' ? 'Push' : 'Bolus';
      desc = `${badge}${modeLabel} <strong>${dose}</strong> <span class="h-detail">${delivery}</span>`;
    } else if (evt.type === 'rate') {
      const rate = fmtRate(evt.value, evt.drug);
      desc = `${badge}Rate <strong>${rate}</strong>`;
    } else if (evt.type === 'pause') {
      desc = `${badge}Pump paused`;
    }

    rows.push(
      `<div class="history-row ${tc}${dimClass}" data-evt-id="${evt.id}" data-evt-time="${evt.time}">` +
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
