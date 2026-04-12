/**
 * constants.js — Drug properties, unit conversions, and display constants
 */

export { VERSION as APP_VERSION } from '../version.js';

// ---- Drug definitions ----

export const DRUG_DEFS = {
  propofol: {
    name: 'Propofol',
    concentration: 10,        // mg/mL (1% propofol)
    color: '#0099ff',
    maxRate: 200,              // mg/min clinical max
    bolusRateMlH: 750,        // mL/h pump bolus delivery rate
  },
  fentanyl: {
    name: 'Fentanyl',
    concentration: 0.05,      // mg/mL (50 mcg/mL)
    color: '#ff6b35',
    maxRate: 0.01,             // mg/min
    bolusRateMlH: 750,
  },
  remifentanil: {
    name: 'Remifentanil',
    concentration: 0.05,      // mg/mL (50 mcg/mL typical reconstitution)
    color: '#f7b801',
    maxRate: 0.05,             // mg/min
    bolusRateMlH: 750,
  },
  ketamine: {
    name: 'Ketamine',
    concentration: 10,        // mg/mL (typical 1%)
    color: '#a855f7',
    maxRate: 10,               // mg/min
    bolusRateMlH: 750,
  },
};

// Active drug IDs — single source of truth for iteration.
// remifentanil is defined in DRUG_DEFS but has no PK model yet.
export const DRUG_IDS = ['propofol', 'fentanyl', 'ketamine'];

// ---- Runtime pump settings (user-configurable) ----
// Falls back to DRUG_DEFS defaults. Updated from setup screen.

const _pumpSettings = {};

/**
 * Get effective pump settings for a drug.
 * Returns { concentration, bolusRateMlH, maxRate }.
 * User overrides take precedence over DRUG_DEFS defaults.
 */
export function getPumpSettings(drugId) {
  const def = DRUG_DEFS[drugId] || {};
  const user = _pumpSettings[drugId] || {};
  return {
    concentration: user.concentration ?? def.concentration ?? 10,
    bolusRateMlH: user.bolusRateMlH ?? def.bolusRateMlH ?? 750,
    maxRate: user.maxRate ?? def.maxRate ?? 200,
  };
}

/**
 * Update pump settings for a drug. Partial updates supported.
 * @param {string} drugId
 * @param {Object} settings - { concentration?, bolusRateMlH? }
 */
export function setPumpSettings(drugId, settings) {
  if (!_pumpSettings[drugId]) _pumpSettings[drugId] = {};
  // Write fields first, then derive maxRate once — avoids stale intermediate
  // values when both concentration and bolusRateMlH are updated together.
  if (settings.concentration != null) _pumpSettings[drugId].concentration = settings.concentration;
  if (settings.bolusRateMlH  != null) _pumpSettings[drugId].bolusRateMlH  = settings.bolusRateMlH;
  const ps = getPumpSettings(drugId);
  _pumpSettings[drugId].maxRate = ps.bolusRateMlH * ps.concentration / 60;
}

/**
 * Reset pump settings to defaults for a drug (or all drugs).
 */
export function resetPumpSettings(drugId) {
  if (drugId) {
    delete _pumpSettings[drugId];
  } else {
    Object.keys(_pumpSettings).forEach(k => delete _pumpSettings[k]);
  }
}

/**
 * Get all user-modified pump settings (for persistence).
 */
export function getAllPumpSettings() {
  return JSON.parse(JSON.stringify(_pumpSettings));
}

/**
 * Restore pump settings from saved state (for persistence).
 */
export function restorePumpSettings(saved) {
  Object.keys(_pumpSettings).forEach(k => delete _pumpSettings[k]);
  if (saved) Object.assign(_pumpSettings, saved);
}

/**
 * Compute bolus delivery duration in minutes.
 * Uses effective pump settings (user overrides or DRUG_DEFS defaults).
 * 
 * @param {number} doseMg - bolus dose in mg
 * @param {string} drugId - drug identifier
 * @returns {number} delivery time in minutes
 */
export function bolusDeliveryMinutes(doseMg, drugId) {
  const ps = getPumpSettings(drugId);
  const volumeMl = doseMg / ps.concentration;
  const durationMin = volumeMl / ps.bolusRateMlH * 60;
  return Math.max(0.05, durationMin); // minimum 3 seconds
}

// Rapid IV push: 3600 mL/h (1 mL/s), minimum 1 second.
// Mirrors PUSH_RATE_MLH in events.js — must stay in sync.
const _PUSH_RATE_MLH = 3600;
export function pushDeliveryMinutes(doseMg, drugId) {
  const ps = getPumpSettings(drugId);
  const volumeMl = doseMg / ps.concentration;
  return Math.max(1 / 60, volumeMl / _PUSH_RATE_MLH * 60);
}

// ---- Per-drug, per-task unit configuration ----
// canonical = what the engine uses (mg, mg/min, mcg/mL)
// allowed = what the keypad can display
// quantSteps = rounding increment for the TCI planner when "round in display
//   units" is enabled. The step is in the display unit itself. Missing entries
//   fall back to no quantization for that unit.

export const DRUG_TASK_UNITS = {
  propofol: {
    bolus: {
      canonical: 'mg',
      allowed: ['mg', 'mcg/kg', 'mL'],
      defaultDisplay: 'mg',
      prefKey: 'tci-pref-bolusUnit-propofol',
      quantSteps: { 'mg': 1, 'mcg/kg': 10, 'mL': 0.1 },
    },
    rate: {
      canonical: 'mg/min',
      allowed: ['mL/h', 'mcg/kg/min', 'mg/min'],
      defaultDisplay: 'mL/h',
      prefKey: 'tci-pref-rateUnit-propofol',
      quantSteps: { 'mL/h': 1, 'mcg/kg/min': 5, 'mg/min': 0.1 },
    },
    ceTarget: {
      canonical: 'mcg/mL',
      allowed: ['mcg/mL'],
    },
  },
  fentanyl: {
    bolus: {
      canonical: 'mg',
      allowed: ['mcg', 'mcg/kg', 'mL'],
      defaultDisplay: 'mcg',
      prefKey: 'tci-pref-bolusUnit-fentanyl',
      quantSteps: { 'mcg': 5, 'mcg/kg': 0.25, 'mL': 0.1 },
    },
    rate: {
      canonical: 'mg/min',
      allowed: ['mcg/kg/min', 'mcg/h', 'mL/h'],
      defaultDisplay: 'mcg/kg/min',
      prefKey: 'tci-pref-rateUnit-fentanyl',
      quantSteps: { 'mcg/kg/min': 0.01, 'mcg/h': 5, 'mL/h': 1 },
    },
    ceTarget: {
      canonical: 'mcg/mL',
      allowed: ['ng/mL'],
    },
  },
  remifentanil: {
    bolus: {
      canonical: 'mg',
      allowed: ['mcg', 'mcg/kg'],
      defaultDisplay: 'mcg',
      prefKey: 'tci-pref-bolusUnit-remifentanil',
      quantSteps: { 'mcg': 5, 'mcg/kg': 0.1 },
    },
    rate: {
      canonical: 'mg/min',
      allowed: ['mcg/kg/min', 'mL/h'],
      defaultDisplay: 'mcg/kg/min',
      prefKey: 'tci-pref-rateUnit-remifentanil',
      quantSteps: { 'mcg/kg/min': 0.01, 'mL/h': 1 },
    },
    ceTarget: {
      canonical: 'mcg/mL',
      allowed: ['ng/mL'],
    },
  },
  ketamine: {
    bolus: {
      canonical: 'mg',
      allowed: ['mg', 'mg/kg', 'mL'],
      defaultDisplay: 'mg',
      prefKey: 'tci-pref-bolusUnit-ketamine',
      quantSteps: { 'mg': 5, 'mg/kg': 0.1, 'mL': 0.1 },
    },
    rate: {
      canonical: 'mg/min',
      allowed: ['mg/kg/h', 'mL/h', 'mg/min'],
      defaultDisplay: 'mg/kg/h',
      prefKey: 'tci-pref-rateUnit-ketamine',
      quantSteps: { 'mg/kg/h': 0.1, 'mL/h': 1, 'mg/min': 0.1 },
    },
    ceTarget: {
      canonical: 'mcg/mL',
      allowed: ['ng/mL'],
    },
  },
};

// ---- Legacy propofol config (kept for backward compatibility) ----

export const PROPOFOL = {
  name: 'Propofol',
  concentration: 10,
  maxInfusionRate: 1200,
  maxInfusionRateMgMin: 200,
  unit: 'μg/mL',
  doseUnit: 'mg',
  rateUnit: 'mL/h',
  inductionCe: { min: 3.0, max: 6.0 },
  maintenanceCe: { min: 2.0, max: 4.0 },
  sedationCe: { min: 1.0, max: 2.5 },
};

export const BIS = {
  awake: { min: 85, max: 100 },
  sedation: { min: 60, max: 85 },
  generalAnaesthesia: { min: 40, max: 60 },
  deep: { min: 0, max: 40 },
  targetBand: { min: 40, max: 60 },
};

export const SIM = {
  dt: 1 / 60,
  tciInterval: 10 / 60,
  chartUpdateHz: 1,
  maxSimTime: 480,
};

export const COLORS = {
  cp: '#ef4444',     // Red — plasma (blood compartment)
  ce: '#3b82f6',     // Blue — effect-site
  c2: '#9ca3af',
  c3: '#6b7280',
  bis: '#22c55e',
  bisWarn: '#f59e0b',
  rate: '#8b5cf6',
  target: '#f97316',
  dose: '#06b6d4',
};

/** Legacy unit conversion helpers (kept for backward compatibility) */
export const UNITS = {
  mgMinToMLh(mgMin, concMgMl = PROPOFOL.concentration) {
    return (mgMin / concMgMl) * 60;
  },
  mlhToMgMin(mlh, concMgMl = PROPOFOL.concentration) {
    return (mlh * concMgMl) / 60;
  },
  mgMinToMgKgH(mgMin, weightKg) {
    return (mgMin * 60) / weightKg;
  },
  mgToMgKg(mg, weightKg) {
    return mg / weightKg;
  },
  formatDuration(minutes) {
    const totalSec = Math.round(minutes * 60);
    const h = Math.floor(totalSec / 3600);
    const m = Math.floor((totalSec % 3600) / 60);
    const s = totalSec % 60;
    if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    return `${m}:${String(s).padStart(2, '0')}`;
  },
};
