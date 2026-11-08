/**
 * pump-sync.js — the clock popover's Pump Total mode.
 *
 * A clinician who started the infusion but forgot to press Start knows only
 * what the pump says it has delivered. They type that total here, and Sync
 * moves the clock to the case time at which the sim had delivered exactly that
 * much — the same thing as moving the case start, without the trial and error.
 * It assumes the rates in the sim are the ones the pump has been running.
 *
 * This module owns the pane's controls (drug, value, unit) and does the solve
 * (sim/dose-sync.js). timer.js owns the popover and the clock, and stays free
 * of the model: it reads this module through the adapter below.
 *
 *   bind({ onChange, onSubmit })  timer.js's callbacks: repaint the preview, Sync
 *   onShow()                      the popover switched to Pump Total
 *   info()                        preview text for #tp-info
 *   resolve(nowMin)               { drugId, elapsedMs, label } or null
 */

import { DRUG_DEFS, DRUG_IDS, getPumpSettings, isPumpEnabled } from '../util/constants.js';
import { getAllowedUnits, toCanonical, fromCanonical, formatValue, formatValueEntry,
         getQuantStep } from '../util/units.js';
import { getCumulativeDose } from '../sim/events/query.js';
import { solveElapsedForTotal } from '../sim/dose-sync.js';
import { fmtTotalMass, fmtTotalVolume } from './history.js';

const $ = id => document.getElementById(id);

let _model = null;
let _getSelectedDrug = () => null;
let _getNowMinutes = () => 0;
let _onChange = () => {};
let _onSubmit = () => {};

let _drugId = null;
// The unit last chosen, kept for the rest of the session: 'mL' (what pumps
// show as volume infused — the default) or 'mass' (mg, or mcg for fentanyl).
let _unitPref = 'mL';

/**
 * @param {Object} opts
 * @param {Object} opts.model
 * @param {Function} opts.getSelectedDrug - () => the drug card in focus
 * @param {Function} opts.getNowMinutes - () => the case clock, minutes
 */
export function init(opts = {}) {
  _model = opts.model || null;
  _getSelectedDrug = opts.getSelectedDrug || (() => null);
  _getNowMinutes = opts.getNowMinutes || (() => 0);

  // The popover closes on any click whose target is outside it, so these
  // handlers only toggle classes on the buttons they were given — a clicked
  // button that was re-rendered away would read as outside and close it.
  $('tp-sync-drugs')?.addEventListener('click', e => {
    const btn = e.target.closest?.('[data-drug]');
    if (!btn || btn.dataset.drug === _drugId) return;
    _drugId = btn.dataset.drug;
    for (const b of $('tp-sync-drugs').querySelectorAll('[data-drug]')) {
      b.classList.toggle('active', b.dataset.drug === _drugId);
    }
    // A total read off one pump says nothing about another drug.
    const input = $('tp-sync-input');
    if (input) input.value = '';
    _renderUnits();
    _onChange();
  });
  $('tp-sync-units')?.addEventListener('click', e => {
    const btn = e.target.closest?.('[data-unit]');
    if (!btn) return;
    setUnit(btn.dataset.unit);
  });
  const input = $('tp-sync-input');
  input?.addEventListener('input', () => _onChange());
  input?.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); _onSubmit(); }
  });
}

/** timer.js's callbacks. */
export function bind({ onChange, onSubmit } = {}) {
  _onChange = onChange || (() => {});
  _onSubmit = onSubmit || (() => {});
}

// ---- Drugs and units ----

/** Drugs with anything in the event list — the only ones there is a total for. */
export function syncDrugs() {
  if (!_model) return [];
  return DRUG_IDS.filter(id => {
    try { return (_model.getEvents(id) || []).length > 0; } catch (e) { return false; }
  });
}

/**
 * Units a pump total can be typed in: the drug's mass unit, and mL when it
 * runs on a pump with a known concentration. Per-kg units are left out — no
 * pump reports a total that way.
 */
export function syncUnits(drugId) {
  const mass = getAllowedUnits(drugId, 'bolus').filter(u => u !== 'mL' && !u.includes('/kg'));
  let pump = false;
  try { pump = isPumpEnabled(drugId) && getPumpSettings(drugId).concentration > 0; } catch (e) {}
  return pump ? ['mL', ...mass] : mass;
}

function _unit() {
  const units = syncUnits(_drugId);
  if (_unitPref === 'mL' && units.includes('mL')) return 'mL';
  return units.find(u => u !== 'mL') || units[0];
}

/** The unit currently in use for the selected drug. */
export function getUnit() { return _drugId ? _unit() : null; }

/**
 * Switch unit. The typed value is converted, not cleared — the keypad rule.
 * mL converts at the live pump concentration (units.js's default).
 */
export function setUnit(unit) {
  if (!_drugId || !syncUnits(_drugId).includes(unit)) return;
  const from = _unit();
  if (unit === from) return;
  const input = $('tp-sync-input');
  const v = _parse(input?.value);
  _unitPref = unit === 'mL' ? 'mL' : 'mass';
  if (input && v != null) {
    const mg = toCanonical(v, from, _drugId, 'bolus').value;
    const shown = fromCanonical(mg, unit, _drugId, 'bolus');
    input.value = formatValueEntry(shown, unit, getQuantStep(_drugId, 'bolus', unit));
  }
  // Mark, don't re-render: the tapped button must stay in the DOM (see init).
  for (const b of $('tp-sync-units')?.querySelectorAll('[data-unit]') || []) {
    b.classList.toggle('active', b.dataset.unit === unit);
  }
  _onChange();
}

function _renderUnits() {
  const row = $('tp-sync-units');
  if (!row) return;
  const current = _unit();
  row.innerHTML = '';
  for (const u of _drugId ? syncUnits(_drugId) : []) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'tp-unit' + (u === current ? ' active' : '');
    b.dataset.unit = u;
    b.textContent = u;
    row.appendChild(b);
  }
}

function _renderDrugs(drugs) {
  const row = $('tp-sync-drugs');
  if (!row) return;
  row.innerHTML = '';
  if (drugs.length < 2) return; // :empty hides the row
  for (const id of drugs) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'tp-sync-drug' + (id === _drugId ? ' active' : '');
    b.dataset.drug = id;
    b.textContent = DRUG_DEFS[id]?.name || id;
    row.appendChild(b);
  }
}

// ---- Popover adapter ----

/** The popover switched to Pump Total: pick the drug, clear the entry. */
export function onShow() {
  const drugs = syncDrugs();
  const selected = _getSelectedDrug();
  _drugId = drugs.includes(selected) ? selected : (drugs[0] || null);
  _renderDrugs(drugs);
  _renderUnits();
  const input = $('tp-sync-input');
  if (input) {
    input.value = '';
    input.disabled = !_drugId;
    if (_drugId) input.focus?.();
  }
}

/** The drug the pane is syncing to. */
export function getDrug() { return _drugId; }

function _parse(str) {
  if (typeof str !== 'string') return null;
  const s = str.trim().replace(',', '.');
  if (!/^(\d+\.?\d*|\.\d+)$/.test(s)) return null;
  const v = Number(s);
  return Number.isFinite(v) ? v : null;
}

function _simTotalMg(drugId, now) {
  const getBolusDelivery = _model.getEventList().getBolusDelivery;
  return getCumulativeDose(_model.getEvents(drugId), drugId, now,
    evt => getBolusDelivery(evt).duration).totalMg;
}

function _solve(nowMin) {
  const unit = _unit();
  const v = _parse($('tp-sync-input')?.value);
  if (v == null) return { empty: true };
  const mg = toCanonical(v, unit, _drugId, 'bolus').value;
  const getBolusDelivery = _model.getEventList().getBolusDelivery;
  const res = solveElapsedForTotal(_model.getEvents(_drugId), _drugId, mg, {
    getDeliveryMinutes: evt => getBolusDelivery(evt).duration,
    nearMin: nowMin,
  });
  return { ...res, v, unit };
}

const pad = n => String(n).padStart(2, '0');
function _fmtElapsed(min) {
  const t = Math.round(min * 60);
  return `${Math.floor(t / 3600)}:${pad(Math.floor((t % 3600) / 60))}:${pad(t % 60)}`;
}

function _fmtIn(mg, unit) {
  if (unit === 'mL') return fmtTotalVolume(mg, _drugId);
  return `${formatValue(fromCanonical(mg, unit, _drugId, 'bolus'), unit)} ${unit}`;
}

/** Preview for #tp-info: what the sim has delivered, and where Sync would land. */
export function info() {
  if (!_model || !_drugId) return 'Nothing given yet to sync to.';
  const now = _getNowMinutes();
  const name = DRUG_DEFS[_drugId]?.name || _drugId;
  const simMg = _simTotalMg(_drugId, now);
  const lines = [`${name} sim now: ${fmtTotalMass(simMg, _drugId)} · ${fmtTotalVolume(simMg, _drugId)}`];

  const r = _solve(now);
  if (r.empty) {
    lines.push('Enter the pump\'s total delivered.');
  } else if (r.ok) {
    const nowDate = new Date();
    const start = new Date(nowDate.getTime() - r.minutes * 60000);
    const yesterday = start.toDateString() !== nowDate.toDateString() ? ' (yesterday)' : '';
    lines.push(`Start → ${pad(start.getHours())}:${pad(start.getMinutes())}:${pad(start.getSeconds())}` +
               `${yesterday} · ET ${_fmtElapsed(r.minutes)}`);
  } else if (r.reason === 'unreachable') {
    lines.push(`More than the sim ever delivers (max ${_fmtIn(r.maxMg, r.unit)}).`);
  } else if (r.reason === 'nothing') {
    lines.push(`No ${name} delivery in the sim to sync to.`);
  } else {
    lines.push('Enter a total above 0.');
  }
  return lines.join('\n');
}

/**
 * Where Sync moves the clock, or null when there is no answer.
 * @param {number} nowMin - the clock now; among several answers (a pause, a
 *   negative reconciliation) the nearest wins
 * @returns {{ drugId: string, elapsedMs: number, label: string } | null}
 */
export function resolve(nowMin = _getNowMinutes()) {
  if (!_model || !_drugId) return null;
  const r = _solve(nowMin);
  if (!r.ok) return null;
  const name = DRUG_DEFS[_drugId]?.name || _drugId;
  const shown = formatValueEntry(r.v, r.unit, getQuantStep(_drugId, 'bolus', r.unit));
  return {
    drugId: _drugId,
    elapsedMs: r.minutes * 60000,
    label: `${name} pump total ${shown} ${r.unit}`,
  };
}
