/**
 * constants.js — Drug properties, unit conversions, and display constants
 */

export const APP_VERSION = '0.4.0';

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

/**
 * Compute bolus delivery duration in minutes.
 * Based on pump max bolus rate and drug concentration.
 * 
 * @param {number} doseMg - bolus dose in mg
 * @param {string} drugId - drug identifier
 * @returns {number} delivery time in minutes
 */
export function bolusDeliveryMinutes(doseMg, drugId) {
  const drug = DRUG_DEFS[drugId];
  if (!drug) return 0.05; // fallback
  const volumeMl = doseMg / drug.concentration;
  const durationMin = volumeMl / drug.bolusRateMlH * 60;
  return Math.max(0.05, durationMin); // minimum 3 seconds
}

// ---- Per-drug, per-task unit configuration ----
// canonical = what the engine uses (mg, mg/min, mcg/mL)
// allowed = what the keypad can display

export const DRUG_TASK_UNITS = {
  propofol: {
    bolus: {
      canonical: 'mg',
      allowed: ['mg', 'mcg/kg', 'mL'],
    },
    rate: {
      canonical: 'mg/min',
      allowed: ['mL/h', 'mcg/kg/min', 'mg/min'],
      defaultDisplay: 'mL/h',
      prefKey: 'tci-pref-rateUnit-propofol',
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
    },
    rate: {
      canonical: 'mg/min',
      allowed: ['mcg/kg/min', 'mcg/h', 'mL/h'],
      defaultDisplay: 'mcg/kg/min',
      prefKey: 'tci-pref-rateUnit-fentanyl',
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
    },
    rate: {
      canonical: 'mg/min',
      allowed: ['mcg/kg/min', 'mL/h'],
      defaultDisplay: 'mcg/kg/min',
      prefKey: 'tci-pref-rateUnit-remifentanil',
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
    },
    rate: {
      canonical: 'mg/min',
      allowed: ['mg/kg/h', 'mL/h', 'mg/min'],
      defaultDisplay: 'mg/kg/h',
      prefKey: 'tci-pref-rateUnit-ketamine',
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
