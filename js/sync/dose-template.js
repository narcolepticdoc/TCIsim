/**
 * dose-template.js — Starting-dose template (single default, local-first).
 *
 * A template holds an optional starting bolus and/or infusion rate per drug,
 * stored in display units (so "100 mcg/kg" scales with the patient). When the
 * arming checkbox is on, app.js applies the template at t=0 the moment the
 * Start button is pressed — never on case restore.
 *
 * Lives in localStorage; the same JSON shape is pushed/pulled to the cloud
 * scratch area (kind 'template' in cloud-sync.js) so a second device can
 * fetch it. Schema:
 *
 *   { v: 1, updatedAt: <epoch ms>, drugs: {
 *       propofol: { bolus: {value,unit}|null, rate: {value,unit}|null },
 *       fentanyl: null, ... } }
 *
 * The pure functions (normalizeTemplate, isTemplateEmpty, buildTemplateDoses)
 * are DOM-free and unit-tested in tests/test-dose-template.js.
 */

import { DRUG_IDS } from '../util/constants.js';
import { toCanonical, getAllowedUnits, formatValue } from '../util/units.js';

export const TEMPLATE_STORAGE_KEY = 'tci-dose-template';
export const TEMPLATE_ARMED_KEY = 'tci-dose-template-armed';

// ---- Pure: schema normalization ----

/**
 * Normalize a raw template (from localStorage or a cloud pull) into the
 * canonical shape. Unknown drugs are dropped; entries with a non-finite or
 * non-positive value, or a unit outside the drug/task's allowed list, are
 * dropped. Never throws.
 *
 * @returns {{v:number, updatedAt:number, drugs:Object}}
 */
export function normalizeTemplate(raw) {
  const out = { v: 1, updatedAt: 0, drugs: {} };
  if (!raw || typeof raw !== 'object') return out;
  if (typeof raw.updatedAt === 'number' && isFinite(raw.updatedAt)) out.updatedAt = raw.updatedAt;
  const drugs = raw.drugs && typeof raw.drugs === 'object' ? raw.drugs : {};
  for (const drugId of DRUG_IDS) {
    const entry = drugs[drugId];
    if (!entry || typeof entry !== 'object') continue;
    const norm = {};
    for (const task of ['bolus', 'rate']) {
      const d = entry[task];
      if (!d || typeof d !== 'object') continue;
      const value = d.value;
      const unit = d.unit;
      if (typeof value !== 'number' || !isFinite(value) || value <= 0) continue;
      if (typeof unit !== 'string' || !getAllowedUnits(drugId, task).includes(unit)) continue;
      norm[task] = { value, unit };
    }
    if (norm.bolus || norm.rate) {
      out.drugs[drugId] = { bolus: norm.bolus || null, rate: norm.rate || null };
    }
  }
  return out;
}

/** True when the template defines no doses at all. */
export function isTemplateEmpty(template) {
  const t = template && template.drugs ? template.drugs : {};
  return !Object.values(t).some(e => e && (e.bolus || e.rate));
}

// ---- Pure: dose planning ----

/**
 * Expand a normalized template into an ordered list of dose items ready for
 * model.addRate / model.addBolus. Per drug the rate is ordered before the
 * bolus — same as the manual keypad flow, so the bolus's system rate-restore
 * resumes the template rate after delivery.
 *
 * Items that can't be delivered carry an `error` instead of a canonical
 * value and must be skipped (and surfaced) by the caller:
 *   'rate-needs-pump'    — infusion requested but the drug's pump is off
 *   'conversion-failed'  — unit conversion threw (e.g. missing weight)
 *
 * @param {Object} template  normalized template
 * @param {Object} ctx       { weightKg, pump: {drugId: {concentration, pumpEnabled}},
 *                             noTciDrugs: Set<string> }
 * @returns {Array<{drugId:string, type:'bolus'|'rate', canonicalValue?:number,
 *                  displayText:string, deliveryMode?:string,
 *                  setManualMode:boolean, error?:string}>}
 */
export function buildTemplateDoses(template, ctx = {}) {
  const items = [];
  const drugs = template && template.drugs ? template.drugs : {};
  const noTci = ctx.noTciDrugs || new Set();
  for (const drugId of DRUG_IDS) {
    const entry = drugs[drugId];
    if (!entry) continue;
    const pump = (ctx.pump && ctx.pump[drugId]) || {};
    const pumpOn = !!pump.pumpEnabled;
    const convCtx = { weightKg: ctx.weightKg, concentration: pump.concentration };

    for (const task of ['rate', 'bolus']) {
      const d = entry[task];
      if (!d) continue;
      const displayText = `${formatValue(d.value, d.unit)} ${d.unit}`;
      if (task === 'rate' && !pumpOn) {
        items.push({ drugId, type: 'rate', displayText, setManualMode: false, error: 'rate-needs-pump' });
        continue;
      }
      let canonicalValue;
      try {
        canonicalValue = toCanonical(d.value, d.unit, drugId, task, convCtx).value;
      } catch (e) {
        items.push({ drugId, type: task, displayText, setManualMode: false, error: 'conversion-failed' });
        continue;
      }
      if (task === 'rate') {
        items.push({ drugId, type: 'rate', canonicalValue, displayText, setManualMode: true });
      } else {
        items.push({
          drugId,
          type: 'bolus',
          canonicalValue,
          displayText,
          deliveryMode: pumpOn ? 'pump' : 'push',
          // Mirrors the keypad: a bolus on a TCI-capable pump drug implies
          // manual mode; push-only drugs stay in 'none' (intermittent UI).
          setManualMode: pumpOn && !noTci.has(drugId),
        });
      }
    }
  }
  return items;
}

// ---- Persistence (localStorage) ----

/** Load + normalize the stored template. Always returns a valid shape. */
export function loadTemplate() {
  try {
    const json = localStorage.getItem(TEMPLATE_STORAGE_KEY);
    return normalizeTemplate(json ? JSON.parse(json) : null);
  } catch (e) {
    return normalizeTemplate(null);
  }
}

/** Persist a template (normalized first). Returns the stored shape. */
export function saveTemplate(template) {
  const t = normalizeTemplate(template);
  try { localStorage.setItem(TEMPLATE_STORAGE_KEY, JSON.stringify(t)); } catch (e) {}
  return t;
}

export function clearTemplate() {
  try { localStorage.removeItem(TEMPLATE_STORAGE_KEY); } catch (e) {}
}

/** True when "Give starting doses on Start" is armed. */
export function isArmed() {
  try { return localStorage.getItem(TEMPLATE_ARMED_KEY) === 'true'; } catch (e) { return false; }
}

export function setArmed(on) {
  try { localStorage.setItem(TEMPLATE_ARMED_KEY, on ? 'true' : 'false'); } catch (e) {}
}
