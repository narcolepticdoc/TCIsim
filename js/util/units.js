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
 * Get the quantization step size for a drug/task/display-unit.
 * Returns null when no step is defined for that unit.
 */
export function getQuantStep(drugId, task, displayUnit) {
  return DRUG_TASK_UNITS[drugId]?.[task]?.quantSteps?.[displayUnit] ?? null;
}

/**
 * Quantize a canonical value by rounding it to the nearest step defined
 * for the given display unit, then converting back to canonical.
 *
 * The TCI planner uses this inside its iteration loops so that every
 * subsequent engine.advance() call sees the value the pump will actually
 * deliver — preventing the stacking errors that would result from
 * post-hoc rounding of the planner's final output.
 *
 * When no step is defined (or the input is non-finite), the canonical
 * value is returned unchanged — callers can invoke this unconditionally.
 *
 * @param {number} canonicalValue - value in canonical units (mg, mg/min, ...)
 * @param {string} displayUnit    - target display unit (e.g. 'mL/h')
 * @param {string} drugId
 * @param {string} task           - 'bolus' | 'rate'
 * @param {Object} ctx            - { weightKg, concentration }
 * @returns {number} canonical value snapped to the display-unit grid
 */
export function quantizeInDisplay(canonicalValue, displayUnit, drugId, task, ctx = {}) {
  const step = getQuantStep(drugId, task, displayUnit);
  if (!step || !Number.isFinite(canonicalValue)) return canonicalValue;
  const displayVal = fromCanonical(canonicalValue, displayUnit, drugId, task, ctx);
  const snapped = Math.round(displayVal / step) * step;
  if (!Number.isFinite(snapped)) return canonicalValue;
  return toCanonical(snapped, displayUnit, drugId, task, ctx).value;
}

/**
 * Read the current quantize-in-display configuration for a drug from
 * localStorage. Falls back to defaults when no preference is stored or
 * the stored unit is no longer in the allowed list.
 *
 * Pass an explicit boolean as `enabledOverride` to bypass the localStorage
 * read — used by the Set Target modal so a per-plan override can flip the
 * rounding flag without touching the persisted global setting.
 *
 * @param {string} drugId
 * @param {boolean} [enabledOverride] - if a boolean, overrides the global flag
 * @returns {Object} { quantizeInDisplay, bolusDisplayUnit?, rateDisplayUnit? }
 */
export function getQuantizeConfig(drugId, enabledOverride) {
  let enabled;
  if (typeof enabledOverride === 'boolean') {
    enabled = enabledOverride;
  } else {
    enabled = false;
    try { enabled = localStorage.getItem('tci-pref-quantizeInDisplay') === 'true'; }
    catch (e) { /* ignore */ }
  }
  if (!enabled) return { quantizeInDisplay: false };

  const bolusKey = getPrefKey(drugId, 'bolus');
  const rateKey  = getPrefKey(drugId, 'rate');
  let bolusDisplayUnit = null, rateDisplayUnit = null;
  try {
    if (bolusKey) bolusDisplayUnit = localStorage.getItem(bolusKey);
    if (rateKey)  rateDisplayUnit  = localStorage.getItem(rateKey);
  } catch (e) { /* ignore */ }

  const bolusAllowed = getAllowedUnits(drugId, 'bolus');
  const rateAllowed  = getAllowedUnits(drugId, 'rate');
  if (!bolusDisplayUnit || !bolusAllowed.includes(bolusDisplayUnit))
    bolusDisplayUnit = getDefaultUnit(drugId, 'bolus');
  if (!rateDisplayUnit || !rateAllowed.includes(rateDisplayUnit))
    rateDisplayUnit = getDefaultUnit(drugId, 'rate');

  return { quantizeInDisplay: true, bolusDisplayUnit, rateDisplayUnit };
}

/**
 * Format the rounding-note line shown next to the "Round in display units"
 * checkbox. Mirrors the setup-screen note so the keypad modal and setup
 * screen describe the same grid using the same wording.
 *
 * @param {string} drugId
 * @param {boolean} enabled - the live checkbox state
 * @param {Object} [opts]
 * @param {string} [opts.bolusUnit] - override the resolved bolus display unit
 * @param {string} [opts.rateUnit]  - override the resolved rate display unit
 * @returns {string}
 */
export function getRoundingNoteText(drugId, enabled, opts = {}) {
  if (!enabled) {
    return 'Planner rounds in engine-canonical units (mg / mg/min). ' +
      'Enable rounding to align with your selected display units.';
  }
  const cfg = getQuantizeConfig(drugId, true);
  const bolusUnit = opts.bolusUnit || cfg.bolusDisplayUnit || getDefaultUnit(drugId, 'bolus');
  const rateUnit  = opts.rateUnit  || cfg.rateDisplayUnit  || getDefaultUnit(drugId, 'rate');
  const bolusStep = getQuantStep(drugId, 'bolus', bolusUnit);
  const rateStep  = getQuantStep(drugId, 'rate',  rateUnit);
  const fmt = (s) => Number.isInteger(s) ? String(s) : String(parseFloat(s.toFixed(4)));
  const bolusPart = bolusStep != null
    ? `bolus → nearest ${fmt(bolusStep)} ${bolusUnit}`
    : `bolus → ${bolusUnit} (no rounding)`;
  const ratePart = rateStep != null
    ? `rate → nearest ${fmt(rateStep)} ${rateUnit}`
    : `rate → ${rateUnit} (no rounding)`;
  return `Plan rounds to: ${bolusPart}, ${ratePart}`;
}

/**
 * Format a value with appropriate decimal places for its unit.
 * 
 * @param {number} value
 * @param {string} unit
 * @returns {string}
 */
// Display precision cap per unit. Trailing zeros are stripped after rounding
// (25.0 → 25, 0.10 → 0.1) so the cap bounds noise without forcing decimals.
const UNIT_DECIMALS = {
  'mL/h': 1, 'mcg/kg/min': 1, 'mcg/kg': 1, 'mg/min': 2, 'mg': 1, 'mcg': 1,
  'mL': 1, 'mcg/mL': 2, 'ng/mL': 1, 'mcg/h': 1, 'mg/kg': 2, 'mg/kg/h': 1,
};

export function formatValue(value, unit) {
  const dp = UNIT_DECIMALS[unit] ?? 2;
  // Round to the unit's precision, then drop trailing zeros: 25.0 → 25,
  // 0.10 → 0.1, 25.50 → 25.5. parseFloat→String is the codebase idiom.
  return parseFloat(value.toFixed(dp)).toString();
}

/**
 * Format a value with its unit as a single token that never wraps between the
 * number and the unit (non-breaking space). Use anywhere a "value unit" pair
 * is displayed in flowing text — e.g. the event-log notations.
 */
export function formatValueUnit(value, unit) {
  return `${formatValue(value, unit)}\u00A0${unit}`;
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
