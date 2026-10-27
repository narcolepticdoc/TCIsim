/**
 * case-totals.js — Totals view of the Events panel: what each drug has given.
 *
 * A case-time line, then one card per drug that has delivered anything, in
 * DRUG_IDS order:
 *
 *   - Case time is global, one span for every drug: the first time any drug
 *     was given to the last time any was given (or now while something still
 *     is), gaps included (sim/case-stats.js computeCaseStats).
 *   - Total: everything delivered so far, in the drug's mass unit and mL — the
 *     same number as the Log's "Total delivered" strip (both come from the
 *     getCumulativeDose walk).
 *   - Avg rate: the drug's total ÷ the case time — an overall requirement per
 *     unit time, not the rate while its pump ran (the user's definition).
 *     Fentanyl and ketamine read in fixed hourly units (mcg/kg/h over mcg/h,
 *     mg/kg/h over mg/h). Other drugs read in their working rate unit with
 *     one companion under it. Shown once the case has a span to average
 *     over: an infusion, or two doses.
 *   - The split: infusion, pump boluses, IV pushes, and any dose
 *     reconciliation correction, so the lines always add up to the total.
 *
 * Amounts grow while a pump runs, so the view re-renders about once a second
 * while it is the active tab (onFrame), and at once after any mutation
 * (render, from chart-bridge refresh). It touches the DOM only when its text
 * changed. Nothing runs while another tab is showing.
 */

import { DRUG_DEFS, isPumpEnabled } from '../util/constants.js';
import { inkOnWhite } from '../util/color.js';
import { fromCanonical, formatValue, formatValueFixed, getWorkingUnit, getAllowedUnits, getReportUnits }
  from '../util/units.js';
import { computeCaseStats } from '../sim/case-stats.js';
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
 * The statistics the view shows, as data (computeCaseStats' shape), or null
 * without a model. Exported for tests and for anything else that wants the
 * same numbers (a future case summary).
 */
export function collectTotals(t = _getElapsedMinutes()) {
  if (!_model) return null;
  const list = _model.getEventList ? _model.getEventList() : null;
  if (!list || !list.getBolusDelivery) return null;
  return computeCaseStats(
    _getDrugIds().map(drugId => [drugId, _model.getEvents(drugId)]),
    t,
    (evt) => list.getBolusDelivery(evt).duration);
}

function buildHtml(t) {
  const c = collectTotals(t);
  if (!c || !c.drugs.length) return `<div class="tot-empty">Nothing given yet.</div>`;
  const weightKg = _getPatient()?.weight || 70;
  // One case time for every drug, above the cards.
  const head = c.hasSpan
    ? `<div class="tot-case">${lineInner('Case time', fmtCaseTime(c))}</div>`
    : '';
  return head + c.drugs.map(r => buildCard(r, weightKg)).join('');
}

function buildCard(r, weightKg) {
  const def = DRUG_DEFS[r.drugId] || {};
  const lines = [];

  // Over the global case time; null until the case has a span (see
  // computeCaseStats).
  if (r.avgRateMgMin != null) {
    lines.push(line('Avg rate', fmtAvgRate(r.avgRateMgMin, r.drugId, weightKg)));
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
  // A dose reconciliation that took drug away: in the total, never a dose.
  if (r.correctionMg !== 0) lines.push(line('Correction', fmtTotalMass(r.correctionMg, r.drugId)));

  // Light theme reads the drug name in contrast-corrected ink, as Next Up does.
  const style = def.color
    ? `--tot-drug:${esc(def.color)};--tot-drug-ink:${esc(inkOnWhite(def.color))}`
    : '';
  return `<div class="tot-card" style="${style}">` +
    `<div class="tot-head">` +
      `<span class="tot-drug">${esc(def.name || r.drugId)}</span>` +
      `<span class="tot-total"><span class="tot-nb">${fmtTotalMass(r.totalMg, r.drugId)}</span>` +
        // The break between mass and mL sits outside the no-wrap parts, so a
        // 4-digit total can drop its mL to the next line in a narrow column.
        `<span class="tot-ml"> · <span class="tot-nb">${fmtMl(r.totalMg, r.drugId)}</span></span></span>` +
    `</div>` +
    lines.join('') +
  `</div>`;
}

function line(label, value) {
  return `<div class="tot-line">${lineInner(label, value)}</div>`;
}

function lineInner(label, value) {
  return `<span class="tot-label">${label}</span><span class="tot-value">${value}</span>`;
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
 * The average in the drug's report units where it has them (fentanyl mcg/kg/h
 * over mcg/h, ketamine mg/kg/h over mg/h, the user's choice), whatever the
 * keypad or pump shows. Otherwise the working rate unit over one companion.
 */
function fmtAvgRate(mgMin, drugId, weightKg) {
  const parts = [];
  for (const unit of getReportUnits(drugId, 'rate') || workingUnitPair(drugId)) {
    if (!unit) continue;
    try {
      const v = fromCanonical(mgMin, unit, drugId, 'rate', { weightKg });
      parts.push(`${fmtAverage(v, unit)} ${unit}`);
    } catch (e) { /* unit not convertible here — skip it */ }
  }
  return stackParts(parts);
}

/**
 * The working rate unit — what the drug card and Log show — and one
 * companion: per-kg when the working unit is not, otherwise mL/h.
 */
function workingUnitPair(drugId) {
  const allowed = getAllowedUnits(drugId, 'rate');
  const pumpOn = isPumpEnabled(drugId);
  const perKg = allowed.find(u => u.includes('/kg/'));
  // mL/h only means something for a drug on a pump — as the companion, and as
  // the lead unit too: a working unit of mL/h can survive from a setup default
  // chosen before the pump was switched off.
  let primary = getWorkingUnit(drugId, 'rate');
  if (!pumpOn && primary === 'mL/h') primary = perKg || primary;
  // A push-only drug's companion is an absolute mass rate where it has one.
  const absolute = pumpOn && allowed.includes('mL/h')
    ? 'mL/h'
    : allowed.find(u => !u.includes('/kg/') && u !== 'mL/h') || null;
  const companion = primary.includes('/kg/') ? absolute : perKg || null;
  return [primary, companion];
}

/**
 * A computed average, not a set value, and a live one, so its width must hold
 * still: the unit's readout precision with trailing zeros kept from 1 up
 * (propofol 131.0 mcg/kg/min, not 131), two significant figures below it
 * (ketamine 0.50 mg/kg/h). formatValue drops trailing zeros, so the line
 * grew and shrank by two characters as the average moved; and its one-decimal
 * cap put a fentanyl infusion's average on the card as "0" back when it read
 * in mcg/kg/min (≈0.02).
 */
function fmtAverage(v, unit) {
  if (!(v > 0)) return formatValue(v, unit);
  return v >= 1 ? formatValueFixed(v, unit) : v.toPrecision(2);
}

function fmtCaseTime(c) {
  const span = `${fmtClock(c.firstGiven)} → ${c.givingNow ? 'now' : fmtClock(c.lastGiven)}`;
  return joinParts([fmtDuration(c.caseTimeMin), span]);
}

/**
 * Join value parts with ' · ', each part unbreakable: in the narrow column
 * beside the chart a line may wrap between "1 h 05 min" and "ET 0:00 → now",
 * never inside a part.
 */
function joinParts(parts) {
  return parts.map(p => `<span class="tot-nb">${p}</span>`).join(' · ');
}

/**
 * One part per row, right-aligned, as the Log's "Total delivered" strip
 * stacks mass over mL. For a value that repaints as it moves (the average
 * rates): joined inline, its width decided whether the second part fit, and
 * in the iPad mini's side column "55.1 mL/h" dropped onto a row of its own
 * and came back as the digits changed. Stacked, the layout no longer depends
 * on the numbers.
 */
function stackParts(parts) {
  return `<span class="tot-stack">${parts.map(p => `<span class="tot-part">${p}</span>`).join('')}</span>`;
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
