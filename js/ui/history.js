/**
 * history.js — Event History Panel
 * 
 * Renders the model's event list into the history panel.
 * Shows pump commands (rate, bolus, pause) with timing and
 * delivery details, interleaved with editorial notations.
 *
 * Categories are differentiated on three independent channels, so no row
 * ever has to be faded to read as secondary:
 *   - border colour + label text = what the event is (bolus, rate, hold, stop, note)
 *   - badge chip                 = who commanded it (TCI, AUTO, MAN)
 *   - row surface                = commanded (filled card) vs. derived (hairline)
 *
 * The value line is never category-coloured, so the dose/rate number keeps full
 * contrast. Red carries a single meaning: the pump is not delivering.
 *
 * Opacity is reserved for one thing only: the panel divides events into past
 * (before current time) and future (after current time, dimmed).
 */

import {
  DRUG_DEFS, getPumpSettings,
} from '../util/constants.js';
import { fromCanonical, getPrefKey, getDefaultUnit, formatValueUnit }
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
let _getAnnotations = null;   // () => annotations[]  (editorial notations)
let _onNotationDelete = null; // (annotId) => void
let _notationsVisible = true; // Notes show/hide toggle (persisted)

const NOTES_PREF_KEY = 'tci-pref-history-show-notations';

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
  _getAnnotations = opts.getAnnotations || (() => []);
  _onNotationDelete = opts.onNotationDelete || null;

  // Seed notation visibility from the persisted preference.
  try {
    const saved = localStorage.getItem(NOTES_PREF_KEY);
    if (saved !== null) _notationsVisible = saved !== 'false';
  } catch (e) {}

  // Delegate click: in edit mode, the notation ✕ deletes a note, and any
  // event row click opens the event editor.
  const list = $('history-list');
  if (list) {
    list.addEventListener('click', (e) => {
      if (!document.body.classList.contains('edit-history-mode')) return;
      // Notation delete affordance
      const delBtn = e.target.closest('.h-note-del');
      if (delBtn) {
        e.stopPropagation();
        const annotId = delBtn.dataset.annotId;
        if (annotId && _onNotationDelete) _onNotationDelete(annotId);
        return;
      }
      const row = e.target.closest('.history-row');
      if (!row || !_onEventTap) return;
      const evtId = row.dataset.evtId;
      if (!evtId) return; // notation rows have no evtId — body taps are inert
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

/**
 * Set the time-format display: 'et' (elapsed) or 'rt' (real/clock time).
 * Driven by the shared `timeAxisMode` setting via chart-bridge, so the history
 * log tracks the chart x-axis. Idempotent — the bridge calls this every frame,
 * so it only re-renders when the format actually changes.
 */
export function setTimeFormat(fmt) {
  const next = fmt === 'rt' ? 'rt' : 'et';
  if (next === _timeFormat) return;
  _timeFormat = next;
  render(_selectedDrug);
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

/** Toggle notation rows on/off (persisted). Returns the new visible state. */
export function toggleNotations() {
  _notationsVisible = !_notationsVisible;
  try { localStorage.setItem(NOTES_PREF_KEY, String(_notationsVisible)); } catch (e) {}
  render(_selectedDrug);
  return _notationsVisible;
}

/** Whether notation rows are currently shown. */
export function getNotationsVisible() {
  return _notationsVisible;
}

// ---- Formatting helpers ----

/** Minimal HTML escape for user/notation text rendered via innerHTML join. */
function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

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
    return formatValueUnit(val, unit);
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
    return formatValueUnit(val, unit);
  } catch (e) {
    return mg.toFixed(1) + ' mg';
  }
}

// ---- Totals ----

function computeTotalsForDrug(drugId, now) {
  if (!_model) return { bolusMg: 0, rateMg: 0, totalMg: 0 };
  // Use the event list's snapshot-based delivery duration so totals agree
  // with the curve replay when a restored case runs at a concentration
  // different from the live global pump settings.
  const getBolusDelivery = _model.getEventList().getBolusDelivery;
  return getCumulativeDose(_model.getEvents(drugId), drugId, now,
    (evt) => getBolusDelivery(evt).duration);
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

/**
 * Chip marking who commanded the event. Every event carries one, so the label
 * column stays aligned: TCI (a plan step), AUTO (machine-derived), MAN (a human
 * acted). Manual is the fallback — createEvent defaults `source` to 'manual',
 * so an unset source lands there too.
 */
function sourceBadge(source) {
  if (source === 'tci') return '<span class="h-badge h-badge-tci">TCI</span>';
  if (source === 'system') return '<span class="h-badge h-badge-auto">AUTO</span>';
  return '<span class="h-badge h-badge-man">MAN</span>';
}

// ---- Type icon / class ----

/**
 * Category class driving the row's border and label colour. A TCI zero-rate step
 * is a scheduled hold, not a rate command, so it gets its own class — it shares
 * the red of a manual stop (neither is delivering), and the TCI chip is what
 * distinguishes a planned hold from a user-initiated one.
 */
function typeClass(evt) {
  if (evt.type === 'bolus') return 'h-evt-bolus';
  if (evt.type === 'rate') {
    return (evt.value === 0 && evt.source === 'tci') ? 'h-evt-hold' : 'h-evt-rate';
  }
  if (evt.type === 'pause') return 'h-evt-pause';
  return '';
}

// ---- Main render ----

/**
 * Build the HTML for one pump-command (event) row.
 *
 * Labels are kept short — BOLUS / IV PUSH / RATE / RESUMED / STOPPED / PAUSED.
 * The chip and the category colour already say "pump", and the label shares its
 * line with a source chip, so anything longer wraps once the history panel is at
 * its 200–240px working width (it is flex:1 of .sim-content, min-width 200px).
 */
function buildEventRow(evt, now) {
  const isPast = evt.time <= now;
  const isSystem = evt.source === 'system';
  const dimClass = isPast ? '' : ' h-future';
  const sysClass = isSystem ? ' h-system' : '';
  const tc = typeClass(evt);
  const badge = sourceBadge(evt.source);

  let desc = '';
  if (evt.type === 'bolus') {
    const dose = fmtBolusDose(evt.value, evt.drug);
    const modeLabel = evt.deliveryMode === 'push' ? 'IV Push' : 'Bolus';
    desc = `<span class="h-type">${badge}${modeLabel}</span>` +
           `<span class="h-value"><strong>${dose}</strong></span>`;
  } else if (evt.type === 'rate') {
    if (evt.value === 0 && evt.source === 'tci') {
      // TCI-scheduled pause (pump holds until next TCI step)
      desc = `<span class="h-type">${badge}Paused</span>`;
    } else {
      const rate = fmtRate(evt.value, evt.drug);
      // A system rate event is the post-bolus restore. The AUTO chip already
      // says it was machine-generated, so the label just names what happened.
      const label = isSystem ? 'Resumed' : 'Rate';
      desc = `<span class="h-type">${badge}${label}</span>` +
             `<span class="h-value"><strong>${rate}</strong></span>`;
    }
  } else if (evt.type === 'pause') {
    desc = `<span class="h-type">${badge}Stopped</span>`;
  }

  return `<div class="history-row ${tc}${dimClass}${sysClass}" data-evt-id="${evt.id}" data-evt-time="${evt.time}">` +
           `<span class="h-time">${fmtTime(evt.time)}</span>` +
           desc +
         `</div>`;
}

/** Build the HTML for one notation row (two-line heading + sub). */
function buildNoteRow(a, now) {
  const tMin = a.timeMin || 0;
  const dimClass = tMin <= now ? '' : ' h-future';
  const sub = a.sub ? `<span class="h-note-sub">${esc(a.sub)}</span>` : '';
  return `<div class="history-row h-note${dimClass}" data-annot-id="${esc(a.id)}" data-annot-time="${tMin}">` +
           `<span class="h-time">${fmtTime(tMin)}</span>` +
           `<span class="h-type">Note</span>` +
           `<span class="h-note-head">${esc(a.heading)}</span>` +
           sub +
           `<button class="h-note-del" data-annot-id="${esc(a.id)}" title="Delete note">✕</button>` +
         `</div>`;
}

/**
 * Render the event history for the selected drug — pump-command rows plus
 * editorial notation rows, merged and sorted chronologically.
 * Call after every model mutation or time change.
 */
export function render(drugId) {
  const drug = drugId || _selectedDrug;
  const list = $('history-list');
  const empty = $('history-empty');
  if (!list || !empty || !_model) return;

  let events = _model.getEvents(drug);
  if (_bolusOnly) events = events.filter(e => e.type === 'bolus');

  // Notations for this drug: drug-tagged ones for this drug, plus globals.
  let notes = [];
  if (_notationsVisible && _getAnnotations) {
    notes = (_getAnnotations() || []).filter(a => a.drug == null || a.drug === drug);
  }

  if (events.length === 0 && notes.length === 0) {
    empty.style.display = 'block';
    list.innerHTML = '';
    renderTotals(drug);
    return;
  }

  empty.style.display = 'none';

  const now = _getElapsedMinutes ? _getElapsedMinutes() : Infinity;

  // Merge into a single time-sorted list. Events rank before notations at the
  // same timestamp so a notation reads as a caption under the event it narrates.
  // Notations flagged `pre` invert that — they announce what follows (e.g.
  // "Starting Doses Queued") and rank before same-timestamp events instead.
  // Array.sort is stable, so same-(time,rank) items keep insertion order.
  const items = [];
  for (let i = 0; i < events.length; i++) {
    items.push({ time: events[i].time, rank: 0, html: buildEventRow(events[i], now) });
  }
  for (let i = 0; i < notes.length; i++) {
    items.push({ time: notes[i].timeMin || 0, rank: notes[i].pre ? -1 : 1, html: buildNoteRow(notes[i], now) });
  }
  items.sort((x, y) => (x.time - y.time) || (x.rank - y.rank));

  list.innerHTML = items.map(it => it.html).join('');
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
    const raw = rows[i].dataset.evtTime !== undefined
      ? rows[i].dataset.evtTime
      : rows[i].dataset.annotTime;
    const t = parseFloat(raw);
    if (isNaN(t)) continue;
    rows[i].classList.toggle('h-future', t > now);
  }
  // Totals are time-dependent (integrate rate segments to `now`) so they
  // need to refresh on the same 2s cadence the bridge uses for dimming.
  renderTotals(_selectedDrug);
}

/**
 * Scroll the history list to the "now" boundary so the most recent past event
 * and the upcoming future events are in view. Call after a drug swap — NOT from
 * the render cadence, so the scroll is never yanked while the user is reading.
 */
export function scrollToNow() {
  const list = $('history-list');
  const area = list && list.parentElement; // .history-area (overflow-y:auto)
  if (!list || !area || list.children.length === 0) return;

  const now = _getElapsedMinutes ? _getElapsedMinutes() : Infinity;
  const rows = list.children;
  let target = null;
  for (let i = 0; i < rows.length; i++) {
    const raw = rows[i].dataset.evtTime !== undefined
      ? rows[i].dataset.evtTime
      : rows[i].dataset.annotTime;
    const t = parseFloat(raw);
    if (!isNaN(t) && t > now) { target = rows[i]; break; }
  }

  if (target) {
    // Land the first future row just below the top, keeping the last past
    // row(s) visible above for context. Rect-based so it's independent of
    // offsetParent.
    const areaRect = area.getBoundingClientRect();
    const rowRect = target.getBoundingClientRect();
    const lead = Math.min(48, area.clientHeight * 0.25);
    area.scrollTop += (rowRect.top - areaRect.top) - lead;
  } else {
    // All events are in the past — show the latest at the bottom.
    area.scrollTop = area.scrollHeight;
  }
}
