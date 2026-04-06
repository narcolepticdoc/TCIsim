/**
 * units.js — Unit Conversion Layer
 * 
 * Pure functions for converting between display units and canonical
 * (engine) units. No DOM, no state. Used by keypad, drug panel,
 * history panel, chart labels — anywhere units are displayed or entered.
 * 
 * Canonical units (what the engine uses):
 *   bolus:    mg
 *   rate:     mg/min
 *   ceTarget: mcg/mL
 * 
 * Display units (what the clinician sees):
 *   Propofol bolus:  mg, mcg/kg, mL
 *   Propofol rate:   mL/h, mcg/kg/min, mg/min
 *   Fentanyl bolus:  mcg, mcg/kg, mL
 *   Fentanyl rate:   mcg/kg/min, mcg/h, mL/h
 *   etc. (configured in constants.js DRUG_TASK_UNITS)
 */

import { DRUG_TASK_UNITS, DRUG_DEFS } from './constants.js';

// ---- Public API ----

/**
 * Convert from a display unit to the canonical (engine) unit.
 * 
 * @param {number} value - Value in display units
 * @param {string} displayUnit - The display unit string
 * @param {string} drugId - e.g. 'propofol'
 * @param {string} task - 'bolus' | 'rate' | 'ceTarget'
 * @param {Object} ctx - { weightKg, concentration? }
 * @returns {{ value: number, unit: string }} Canonical value and unit
 */
export function toCanonical(value, displayUnit, drugId, task, ctx = {}) {
  const config = getConfig(drugId, task);
  checkAllowed(displayUnit, config, drugId, task);

  if (displayUnit === config.canonical) {
    return { value, unit: config.canonical };
  }

  const conc = ctx.concentration || DRUG_DEFS[drugId]?.concentration;
  const wt = ctx.weightKg;

  const result = convert(value, displayUnit, config.canonical, task, wt, conc);
  return { value: result, unit: config.canonical };
}

/**
 * Convert from canonical unit back to a display unit.
 * 
 * @param {number} value - Value in canonical units
 * @param {string} displayUnit - Desired display unit
 * @param {string} drugId
 * @param {string} task
 * @param {Object} ctx - { weightKg, concentration? }
 * @returns {number} Value in display units
 */
export function fromCanonical(value, displayUnit, drugId, task, ctx = {}) {
  const config = getConfig(drugId, task);
  checkAllowed(displayUnit, config, drugId, task);

  if (displayUnit === config.canonical) return value;

  const conc = ctx.concentration || DRUG_DEFS[drugId]?.concentration;
  const wt = ctx.weightKg;

  return convert(value, config.canonical, displayUnit, task, wt, conc);
}

/**
 * Get the canonical unit string for a drug/task.
 */
export function getCanonicalUnit(drugId, task) {
  return DRUG_TASK_UNITS[drugId]?.[task]?.canonical || null;
}

/**
 * Get the list of allowed display units for a drug/task.
 */
export function getAllowedUnits(drugId, task) {
  return DRUG_TASK_UNITS[drugId]?.[task]?.allowed || [];
}

/**
 * Get the default display unit for a drug/task.
 */
export function getDefaultUnit(drugId, task) {
  const cfg = DRUG_TASK_UNITS[drugId]?.[task];
  if (!cfg) return null;
  return cfg.defaultDisplay || cfg.allowed[0];
}

/**
 * Get the localStorage preference key for a drug/task's unit selection.
 */
export function getPrefKey(drugId, task) {
  return DRUG_TASK_UNITS[drugId]?.[task]?.prefKey || null;
}

/**
 * Format a value with appropriate decimal places for its unit.
 * 
 * @param {number} value
 * @param {string} unit
 * @returns {string}
 */
export function formatValue(value, unit) {
  if (unit === 'mL/h') return value.toFixed(1);
  if (unit === 'mcg/kg/min') return value.toFixed(1);
  if (unit === 'mcg/kg') return value.toFixed(1);
  if (unit === 'mg/min') return value.toFixed(2);
  if (unit === 'mg') return value.toFixed(1);
  if (unit === 'mcg') return value.toFixed(1);
  if (unit === 'mL') return value.toFixed(1);
  if (unit === 'mcg/mL') return value.toFixed(2);
  if (unit === 'ng/mL') return value.toFixed(1);
  if (unit === 'mcg/h') return value.toFixed(1);
  if (unit === 'mg/kg') return value.toFixed(2);
  if (unit === 'mg/kg/h') return value.toFixed(1);
  return value.toFixed(2);
}

// ---- Internal ----

function getConfig(drugId, task) {
  const config = DRUG_TASK_UNITS[drugId]?.[task];
  if (!config) throw new Error(`No unit config for ${drugId}/${task}`);
  return config;
}

function checkAllowed(unit, config, drugId, task) {
  if (!config.allowed.includes(unit)) {
    throw new Error(`Unit '${unit}' not allowed for ${drugId}/${task}. Allowed: ${config.allowed.join(', ')}`);
  }
}

/**
 * Core conversion between any two units for a given task.
 * Routes through canonical as intermediate if needed.
 * 
 * All conversions go: fromUnit → mg (or mg/min or mcg/mL) → toUnit
 */
function convert(value, fromUnit, toUnit, task, weightKg, concMgMl) {
  // Normalize to canonical first, then to target
  const canonical = toBase(value, fromUnit, task, weightKg, concMgMl);
  return fromBase(canonical, toUnit, task, weightKg, concMgMl);
}

/**
 * Convert any unit to the canonical base for its task.
 */
function toBase(value, unit, task, wt, conc) {
  // ---- Bolus: canonical = mg ----
  if (task === 'bolus') {
    if (unit === 'mg') return value;
    if (unit === 'mcg') return value / 1000;
    if (unit === 'mcg/kg') {
      if (!wt) throw new Error('weightKg required for mcg/kg conversion');
      return value * wt / 1000;
    }
    if (unit === 'mg/kg') {
      if (!wt) throw new Error('weightKg required for mg/kg conversion');
      return value * wt;
    }
    if (unit === 'mL') {
      if (!conc) throw new Error('concentration required for mL conversion');
      return value * conc;
    }
  }

  // ---- Rate: canonical = mg/min ----
  if (task === 'rate') {
    if (unit === 'mg/min') return value;
    if (unit === 'mcg/kg/min') {
      if (!wt) throw new Error('weightKg required for mcg/kg/min conversion');
      return value * wt / 1000;
    }
    if (unit === 'mL/h') {
      if (!conc) throw new Error('concentration required for mL/h conversion');
      return value * conc / 60;
    }
    if (unit === 'mcg/h') {
      return value / 1000 / 60; // mcg/h → mg/h → mg/min
    }
    if (unit === 'mg/kg/h') {
      if (!wt) throw new Error('weightKg required for mg/kg/h conversion');
      return value * wt / 60; // mg/kg/h → mg/h → mg/min
    }
  }

  // ---- Ce target: canonical = mcg/mL ----
  if (task === 'ceTarget') {
    if (unit === 'mcg/mL') return value;
    if (unit === 'ng/mL') return value / 1000;
  }

  throw new Error(`Cannot convert ${unit} to canonical for task ${task}`);
}

/**
 * Convert from canonical base to any display unit.
 */
function fromBase(value, unit, task, wt, conc) {
  // ---- Bolus: from mg ----
  if (task === 'bolus') {
    if (unit === 'mg') return value;
    if (unit === 'mcg') return value * 1000;
    if (unit === 'mcg/kg') {
      if (!wt) throw new Error('weightKg required for mcg/kg conversion');
      return value * 1000 / wt;
    }
    if (unit === 'mg/kg') {
      if (!wt) throw new Error('weightKg required for mg/kg conversion');
      return value / wt;
    }
    if (unit === 'mL') {
      if (!conc) throw new Error('concentration required for mL conversion');
      return value / conc;
    }
  }

  // ---- Rate: from mg/min ----
  if (task === 'rate') {
    if (unit === 'mg/min') return value;
    if (unit === 'mcg/kg/min') {
      if (!wt) throw new Error('weightKg required for mcg/kg/min conversion');
      return value * 1000 / wt;
    }
    if (unit === 'mL/h') {
      if (!conc) throw new Error('concentration required for mL/h conversion');
      return value * 60 / conc;
    }
    if (unit === 'mcg/h') {
      return value * 1000 * 60; // mg/min → mcg/min → mcg/h
    }
    if (unit === 'mg/kg/h') {
      if (!wt) throw new Error('weightKg required for mg/kg/h conversion');
      return value * 60 / wt; // mg/min → mg/h → mg/kg/h
    }
  }

  // ---- Ce target: from mcg/mL ----
  if (task === 'ceTarget') {
    if (unit === 'mcg/mL') return value;
    if (unit === 'ng/mL') return value * 1000;
  }

  throw new Error(`Cannot convert canonical to ${unit} for task ${task}`);
}
