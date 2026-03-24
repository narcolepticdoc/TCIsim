/**
 * constants.js — Drug properties, unit conversions, and display constants
 */

export const APP_VERSION = '0.1.0.0';

export const PROPOFOL = {
  name: 'Propofol',
  concentration: 10,        // mg/mL (1% propofol = 10 mg/mL)
  maxInfusionRate: 1200,    // mL/h (clinical max)
  maxInfusionRateMgMin: 200,// mg/min (= 1200 mL/h ÷ 60 × 10)
  unit: 'μg/mL',
  doseUnit: 'mg',
  rateUnit: 'mL/h',
  
  // Standard target ranges
  inductionCe: { min: 3.0, max: 6.0 },  // μg/mL typical induction
  maintenanceCe: { min: 2.0, max: 4.0 }, // μg/mL typical maintenance
  sedationCe: { min: 1.0, max: 2.5 },    // μg/mL sedation
};

export const BIS = {
  awake: { min: 85, max: 100 },
  sedation: { min: 60, max: 85 },
  generalAnaesthesia: { min: 40, max: 60 },
  deep: { min: 0, max: 40 },
  targetBand: { min: 40, max: 60 },       // Standard clinical target
};

export const SIM = {
  dt: 1 / 60,              // 1 second in minutes
  tciInterval: 10 / 60,    // 10 seconds in minutes
  chartUpdateHz: 1,
  maxSimTime: 480,          // 8 hours in minutes
};

/** Color tokens for concentration curves */
export const COLORS = {
  cp: '#3b82f6',     // Blue — plasma
  ce: '#ef4444',     // Red — effect-site
  c2: '#9ca3af',     // Grey — fast peripheral
  c3: '#6b7280',     // Dark grey — slow peripheral
  bis: '#22c55e',    // Green — BIS
  bisWarn: '#f59e0b', // Amber — BIS outside target
  rate: '#8b5cf6',   // Purple — infusion rate
  target: '#f97316',  // Orange — target line
  dose: '#06b6d4',   // Cyan — cumulative dose
};

/** Unit conversion helpers */
export const UNITS = {
  /** mg/min → mL/h for given drug concentration (mg/mL) */
  mgMinToMLh(mgMin, concMgMl = PROPOFOL.concentration) {
    return (mgMin / concMgMl) * 60;
  },
  
  /** mL/h → mg/min */
  mlhToMgMin(mlh, concMgMl = PROPOFOL.concentration) {
    return (mlh * concMgMl) / 60;
  },
  
  /** mg/min → mg/kg/h */
  mgMinToMgKgH(mgMin, weightKg) {
    return (mgMin * 60) / weightKg;
  },
  
  /** mg → mg/kg */
  mgToMgKg(mg, weightKg) {
    return mg / weightKg;
  },
  
  /** minutes → "H:MM:SS" */
  formatDuration(minutes) {
    const totalSec = Math.round(minutes * 60);
    const h = Math.floor(totalSec / 3600);
    const m = Math.floor((totalSec % 3600) / 60);
    const s = totalSec % 60;
    if (h > 0) {
      return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    }
    return `${m}:${String(s).padStart(2, '0')}`;
  },
};
