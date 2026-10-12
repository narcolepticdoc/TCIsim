/**
 * case-totals.js — Totals view of the Events panel: what each drug has given.
 *
 * One card per drug that has delivered anything, in DRUG_IDS order:
 *
 *   - Total: everything delivered so far, in the drug's mass unit and mL — the
 *     same number as the Log's "Total delivered" strip (both come from the
 *     getCumulativeDose walk; see sim/case-stats.js).
 *   - Avg pump rate: everything the pump delivered — infusion and pump boluses —
 *     over the pump window, first start to last stop (or now). Pauses inside
 *     the window are not subtracted. IV pushes never count. Shown in the drug's
 *     working rate unit plus one companion unit, and only once the drug has
 *     infused at all.
 *   - Pump time, and the split: infusion, pump boluses, IV pushes.
 *
 * Amounts grow while a pump runs, so the view re-renders about once a second
 * while it is the active tab (onFrame), and at once after any mutation
 * (render, from chart-bridge refresh). It touches the DOM only when its text
 * changed. Nothing runs while another tab is showing.
 */

import { DRUG_DEFS } from '../util/constants.js';
import { inkOnWhite } from '../util/color.js';
import { fromCanonical, formatValue, getWorkingUnit, getAllowedUnits } from '../util/units.js';
import { computeDrugStats } from '../sim/case-stats.js';
import { fmtTotalMass } from './history.js';

const $ = id => document.getElementById(id);

const RENDER_INTERVAL_MS = 1000;

let _model = null;
let _getPatient = () => null;
let _getDrugIds = () => [];
let _getElapsedMinutes = () => 0;
let _getTimeMode = () => 'et';
let _getWallClockStart = () => null;

let _active = false;
let _lastRenderMs = 0;
let _lastHtml = null;

/**
 * @param {Object} opts
 * @param {Object} opts.model
 * @param {Function} opts.getPatient        - () => { weight, ... } | null
 * @param {Function} opts.getDrugIds        - () => DRUG_IDS
 * @param {Function} opts.getElapsedMinutes - () => live case time (min)
 * @param {Function} [opts.getTimeMode]     - () => 'et' | 'rt' (the Log's ET/RT setting)
 * @param {Function} [opts.getWallClockStart] - () => Date | null
 */
export function init(opts = {}) {
  _model = opts.model || null;
  _getPatient = opts.getPatient || (() => null);
  _getDrugIds = opts.getDrugIds || (() => []);
  _getElapsedMinutes = opts.getElapsedMinutes || (() => 0);
  _getTimeMode = opts.getTimeMode || (() => 'et');
  _getWallClockStart = opts.getWallClockStart || (() => null);
}

export function setActive(active) {
  _active = !!active;
  if (_active) { _lastHtml = null; render(); }
}

export function isActive() { return _active; }

/** Repaint now — after a mutation, or when the tab is opened. */
export function render(t = _getElapsedMinutes()) {
  if (!_active) return;
  _lastRenderMs = Date.now();
  const el = $('tot-list');
  if (!el) return;
  const html = buildHtml(t);
  if (html !== _lastHtml) {
    el.innerHTML = html;
    _lastHtml = html;
  }
}

/** Per-frame hook: amounts grow while a pump runs, so repaint ~1/s. */
export function onFrame(t) {
  if (!_active) return;
  if (Date.now() - _lastRenderMs < RENDER_INTERVAL_MS) return;
  render(t);
}

// ---- Building the view ----

/**
 * The per-drug statistics the view shows, as data. Exported for tests and for
 * anything else that wants the same numbers (a future case summary).
 */
export function collectTotals(t = _getElapsedMinutes()) {
  if (!_model) return [];
  const list = _model.getEventList ? _model.getEventList() : null;
  const delivery = list && list.getBolusDelivery
    ? (evt) => list.getBolusDelivery(evt).duration
    : null;
  if (!delivery) return [];
  const out = [];
  for (const drugId of _getDrugIds()) {
    const stats = computeDrugStats(_model.getEvents(drugId), t, delivery);
    if (stats.totalMg > 0) out.push({ drugId, ...stats });
  }
  return out;
}

function buildHtml(t) {
  const rows = collectTotals(t);
  if (!rows.length) return `<div class="tot-empty">Nothing given yet.</div>`;
  const weightKg = _getPatient()?.weight || 70;
  return rows.map(r => buildCard(r, weightKg)).join('');
}

function buildCard(r, weightKg) {
  const def = DRUG_DEFS[r.drugId] || {};
  const lines = [];

  // Only a drug that has infused has an average rate. Pump boluses alone
  // would average out at the pump's bolus rate, which says nothing.
  if (r.infusionMg > 0 && r.avgPumpRateMgMin != null) {
    lines.push(line('Avg pump rate', fmtAvgRate(r.avgPumpRateMgMin, r.drugId, weightKg)));
    lines.push(line('Pump time', fmtPumpTime(r)));
  }
  if (r.infusionMg > 0) lines.push(line('Infusion', fmtTotalMass(r.infusionMg, r.drugId)));
  if (r.pumpBolusCount > 0) {
    lines.push(line(r.pumpBolusCount === 1 ? 'Pump bolus' : 'Pump boluses',
      `${r.pumpBolusCount} · ${fmtTotalMass(r.pumpBolusMg, r.drugId)}`));
  }
  if (r.pushCount > 0) {
    lines.push(line(r.pushCount === 1 ? 'IV push' : 'IV pushes',
      `${r.pushCount} · ${fmtTotalMass(r.pushMg, r.drugId)}`));
  }

  // Light theme reads the drug name in contrast-corrected ink, as Next Up does.
  const style = def.color
    ? `--tot-drug:${esc(def.color)};--tot-drug-ink:${esc(inkOnWhite(def.color))}`
    : '';
  return `<div class="tot-card" style="${style}">` +
    `<div class="tot-head">` +
      `<span class="tot-drug">${esc(def.name || r.drugId)}</span>` +
      `<span class="tot-total"><span class="tot-nb">${fmtTotalMass(r.totalMg, r.drugId)}</span>` +
        `<span class="tot-ml"> · ${fmtMl(r.totalMg, r.drugId)}</span></span>` +
    `</div>` +
    lines.join('') +
  `</div>`;
}

function line(label, value) {
  return `<div class="tot-line"><span class="tot-label">${label}</span>` +
         `<span class="tot-value">${value}</span></div>`;
}

/** mL at the live pump concentration — the case's own (units.js invariant). */
function fmtMl(mg, drugId) {
  try {
    const ml = fromCanonical(mg, 'mL', drugId, 'bolus', {});
    return `${ml >= 10 ? ml.toFixed(1) : ml.toFixed(2)} mL`;
  } catch (e) {
    return '';
  }
}

/**
 * The average in the drug's working rate unit — what the drug card and Log
 * show — plus one companion: per-kg when the working unit is not, otherwise mL/h.
 */
function fmtAvgRate(mgMin, drugId, weightKg) {
  const allowed = getAllowedUnits(drugId, 'rate');
  const primary = getWorkingUnit(drugId, 'rate');
  const perKg = allowed.find(u => u.includes('/kg/'));
  const companion = primary.includes('/kg/')
    ? (allowed.includes('mL/h') ? 'mL/h' : null)
    : perKg || null;
  const parts = [];
  for (const unit of [primary, companion]) {
    if (!unit) continue;
    try {
      const v = fromCanonical(mgMin, unit, drugId, 'rate', { weightKg });
      parts.push(`${fmtAverage(v, unit)} ${unit}`);
    } catch (e) { /* unit not convertible here — skip it */ }
  }
  return joinParts(parts);
}

/**
 * A computed average, not a set value: the unit's readout precision from 1 up
 * (propofol 131.1 mcg/kg/min), two significant figures below it. formatValue
 * alone caps mcg/kg/min at one decimal, which put a fentanyl infusion's
 * average (≈0.02 mcg/kg/min) on the card as "0".
 */
function fmtAverage(v, unit) {
  if (!(v > 0) || v >= 1) return formatValue(v, unit);
  return parseFloat(v.toPrecision(2)).toString();
}

function fmtPumpTime(r) {
  const span = `${fmtClock(r.pumpStart)} → ${r.pumpRunning ? 'now' : fmtClock(r.pumpEnd)}`;
  return joinParts([fmtDuration(r.pumpWindowMin), span]);
}

/**
 * Join value parts with ' · ', each part unbreakable: in the narrow column
 * beside the chart a line may wrap between "55.1 mL/h" and "131.1 mcg/kg/min",
 * never between a number and its unit.
 */
function joinParts(parts) {
  return parts.map(p => `<span class="tot-nb">${p}</span>`).join(' · ');
}

/**
 * A case time as ET h:mm, or RT h:mm when the Log is showing real time. Both
 * truncate to the minute, as the Log's h:mm:ss reads (ET 0:59:40 → 0:59).
 */
function fmtClock(min) {
  const ws = _getTimeMode() === 'rt' ? _getWallClockStart() : null;
  if (ws) {
    const d = new Date(ws.getTime() + min * 60000);
    return `RT ${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`;
  }
  const total = Math.floor(min + 1e-9);
  return `ET ${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

function fmtDuration(min) {
  const total = Math.round(min);
  if (total < 60) return `${total} min`;
  return `${Math.floor(total / 60)} h ${String(total % 60).padStart(2, '0')} min`;
}

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
