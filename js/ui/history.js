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

import {
  DRUG_DEFS, getPumpSettings,
} from '../util/constants.js';
import { fromCanonical, getPrefKey, getDefaultUnit, formatValue }
  from '../util/units.js';
import { getCumulativeDose } from '../sim/events/query.js';

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
      if (!evtId) return;
      // Clear any prior selection, mark this row as the one being edited.
      list.querySelectorAll('.history-row.h-row-selected').forEach(el => el.classList.remove('h-row-selected'));
      row.classList.add('h-row-selected');
      _onEventTap(evtId);
    });
  }
  _watchEditorModal();
  _wireOutsideClickToExit();
}

/**
 * While edit mode is active, a click anywhere outside the history panel
 * (and outside any open modal) exits edit mode. Lets the user dismiss the
 * focus state by tapping the dimmed surrounding area.
 */
function _wireOutsideClickToExit() {
  document.addEventListener('click', (e) => {
    if (!document.body.classList.contains('edit-history-mode')) return;
    const historyPanel = document.getElementById('panel-history');
    if (historyPanel && historyPanel.contains(e.target)) return;
    // Respect any open modal — don't exit while the editor is up.
    const modal = document.getElementById('modal-evt-editor');
    if (modal && modal.classList.contains('open') && modal.contains(e.target)) return;
    // Any other modal backdrop is also respected
    const anyOpenModal = document.querySelector('.modal-overlay.open');
    if (anyOpenModal && anyOpenModal.contains(e.target)) return;
    exitEditMode();
    const btn = document.getElementById('btn-history-edit');
    if (btn) btn.classList.remove('active');
  }, true);
}

/** Clear the highlighted-row marker. Called when the event editor closes. */
export function clearSelectedRow() {
  document.querySelectorAll('.history-row.h-row-selected').forEach(el => el.classList.remove('h-row-selected'));
}

/**
 * Watch the event-editor modal so the highlighted row clears when the modal closes.
 * Decouples history from event-editor — we just observe the known DOM id.
 */
function _watchEditorModal() {
  const modal = document.getElementById('modal-evt-editor');
  if (!modal || typeof MutationObserver === 'undefined') return;
  new MutationObserver(() => {
    if (!modal.classList.contains('open')) clearSelectedRow();
  }).observe(modal, { attributes: true, attributeFilter: ['class'] });
}

/** Toggle edit mode on the history panel. Returns the new state (true = on). */
export function toggleEditMode() {
  const on = document.body.classList.toggle('edit-history-mode');
  if (!on) clearSelectedRow();
  return on;
}

/** Force-exit edit mode. Returns true if state changed. */
export function exitEditMode() {
  const was = document.body.classList.contains('edit-history-mode');
  document.body.classList.remove('edit-history-mode');
  clearSelectedRow();
  return was;
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

// ---- Totals ----

function computeTotalsForDrug(drugId, now) {
  if (!_model) return { bolusMg: 0, rateMg: 0, totalMg: 0 };
  return getCumulativeDose(_model.getEvents(drugId), drugId, now);
}

// Total-delivered is always shown in absolute mass units and mL —
// per-kg or volumetric bolus prefs don't make sense for a cumulative
// dose readout. Per-drug native mass unit:
const TOTAL_MASS_UNIT = {
  propofol: 'mg',
  fentanyl: 'mcg',
  remifentanil: 'mcg',
  ketamine: 'mg',
};

/**
 * Format a total mg in the drug's native mass unit (mg or mcg).
 */
export function fmtTotalMass(mg, drugId) {
  const unit = TOTAL_MASS_UNIT[drugId] || 'mg';
  if (unit === 'mcg') {
    const mcg = mg * 1000;
    const val = mcg >= 100 ? Math.round(mcg) : mcg.toFixed(1);
    return `${val} mcg`;
  }
  const val = mg >= 10 ? mg.toFixed(1) : mg.toFixed(2);
  return `${val} mg`;
}

/**
 * Render the totals strip for the selected drug. Hidden when no events
 * or total is zero. Shows native mass unit + mL (concentration is known
 * per-drug even when no infusion pump is configured).
 */
export function renderTotals(drugId) {
  const drug = drugId || _selectedDrug;
  const el = $('history-totals');
  if (!el) return;
  const now = _getElapsedMinutes ? _getElapsedMinutes() : 0;
  const { totalMg } = computeTotalsForDrug(drug, now);
  if (!(totalMg > 0)) {
    el.hidden = true;
    el.innerHTML = '';
    return;
  }
  const massStr = fmtTotalMass(totalMg, drug);
  const ps = getPumpSettings(drug);
  const ml = totalMg / (ps.concentration || 10);
  const mlStr = ml >= 10 ? ml.toFixed(1) : ml.toFixed(2);
  el.hidden = false;
  el.innerHTML =
    `<span class="ht-label">Total delivered</span>` +
    `<span class="ht-values">` +
      `<span class="ht-value">${massStr}</span>` +
      `<span class="ht-value">${mlStr} mL</span>` +
    `</span>`;
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
    renderTotals(drug);
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
      const isPush = evt.deliveryMode === 'push';
      const modeLabel = isPush ? 'IV Push' : 'Pump Bolus';
      // For pump-delivered boluses, append the pump's running mL/h rate —
      // that's what shows on the real pump's screen during delivery.
      let valueStr = dose;
      if (!isPush) {
        try {
          const ps = getPumpSettings(evt.drug);
          if (ps && ps.bolusRateMlH) {
            valueStr = `${dose} @ ${Math.round(ps.bolusRateMlH)} mL/h`;
          }
        } catch (e) { /* fall back to dose only */ }
      }
      desc = `<span class="h-type">${badge}${modeLabel}</span>` +
             `<span class="h-value"><strong>${valueStr}</strong></span>`;
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
        desc +
      `</div>`
    );
  }

  list.innerHTML = rows.join('');
  renderTotals(drug);
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
  // Totals are time-dependent (integrate rate segments to `now`) so they
  // need to refresh on the same 2s cadence the bridge uses for dimming.
  renderTotals(_selectedDrug);
}
