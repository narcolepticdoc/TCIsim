/**
 * simtiva-reference.js — SimTIVA CET Algorithm Reference Implementation
 * 
 * Implements SimTIVA's CET (Ce-targeting) bolus calculation, including
 * the rate_corr_factor that reduces the bolus dose to account for
 * redistribution during pump-rate delivery.
 * 
 * This produces boluses ~9% smaller than the mathematically exact
 * peak-Ce-matching approach (our calculateCETBolus). SimTIVA relies
 * on the maintenance infusion to close the remaining gap.
 * 
 * Reference: SimTIVA pharmacology.js (Terence Luk)
 *   - calculate_udfs() lines 5483-5583
 *   - scheme_bolusadmin() lines 4643-4720
 *   - deliver_cet_real() lines 3467-3580
 * 
 * Usage:
 *   import { computeSimTIVACETBolus } from './simtiva-reference.js';
 *   const result = computeSimTIVACETBolus(params, ceTarget, { maxRateMlH: 700, concentration: 10 });
 *   // result = { bolusMg, bolusVolMl, durationSec, peakTime, rawBolusMg, rateCorrFactor, peakCe }
 */

/**
 * Compute eigenvalues of the 3-compartment PK system.
 * Ported from SimTIVA's cube() function.
 * 
 * @param {number} k10 - elimination rate (per second)
 * @param {number} k12 - transfer 1→2 (per second)
 * @param {number} k21 - transfer 2→1 (per second)
 * @param {number} k13 - transfer 1→3 (per second)
 * @param {number} k31 - transfer 3→1 (per second)
 * @returns {number[]} [0, lambda1, lambda2, lambda3] (1-indexed)
 */
function cube(k10, k12, k21, k13, k31) {
  const a0 = k10 * k21 * k31;
  const a1 = k10 * k31 + k21 * k31 + k21 * k13 + k10 * k21 + k31 * k12;
  const a2 = k10 + k12 + k13 + k21 + k31;
  const p = a1 - (a2 * a2 / 3.0);
  const q = (2.0 * a2 * a2 * a2 / 27.0) - (a1 * a2 / 3.0) + a0;
  const r1 = Math.sqrt(-(p * p * p) / 27.0);
  const phi = Math.acos((-q / 2.0) / r1) / 3.0;
  const rc = Math.pow(r1, 1.0 / 3.0);
  return [
    0,
    -(Math.cos(phi) * 2.0 * rc - a2 / 3.0),
    -(Math.cos(phi + 2.0 * Math.PI / 3.0) * 2.0 * rc - a2 / 3.0),
    -(Math.cos(phi + 4.0 * Math.PI / 3.0) * 2.0 * rc - a2 / 3.0),
  ];
}

/**
 * Compute SimTIVA-style UDFs (unit disposition functions) and find peak time.
 * 
 * UDFs represent the concentration response to a continuous 1-unit/sec
 * infusion running for delta_seconds, then stopping.
 * 
 * For CET: e_udf[peak_time] gives the peak Ce for that infusion.
 * Bolus dose = target / e_udf[peak_time] gives the required rate,
 * and rate × delta_seconds gives the total dose.
 * 
 * @param {Object} pkParams - { V1, CL, Q2, Q3, V2, V3, ke0 }
 * @param {number} deltaSec - infusion duration in seconds (use 1 for unit impulse)
 * @returns {{ e_udf: number[], peak_time: number, p_coef: number[], e_coef: number[], lambda: number[] }}
 */
function computeUDFs(pkParams, deltaSec = 1) {
  const { V1, CL, Q2, Q3, V2, V3, ke0 } = pkParams;

  // Convert to per-second rate constants (SimTIVA works in seconds)
  const k10 = CL / V1 / 60;
  const k12 = Q2 / V1 / 60;
  const k13 = Q3 / V1 / 60;
  const k21 = Q2 / V2 / 60;
  const k31 = Q3 / V3 / 60;
  const k41 = ke0 / 60;

  const lambda = cube(k10, k12, k21, k13, k31);
  lambda[4] = k41;

  const vc = V1;

  // Infusion UDF coefficients (p_coef includes /lambda[i] divisor)
  const p_coef = [0,
    (k21 - lambda[1]) * (k31 - lambda[1]) / (lambda[1] - lambda[2]) / (lambda[1] - lambda[3]) / vc / lambda[1],
    (k21 - lambda[2]) * (k31 - lambda[2]) / (lambda[2] - lambda[1]) / (lambda[2] - lambda[3]) / vc / lambda[2],
    (k21 - lambda[3]) * (k31 - lambda[3]) / (lambda[3] - lambda[2]) / (lambda[3] - lambda[1]) / vc / lambda[3],
  ];

  // Effect-site coefficients
  const e_coef = [0,
    p_coef[1] / (k41 - lambda[1]) * k41,
    p_coef[2] / (k41 - lambda[2]) * k41,
    p_coef[3] / (k41 - lambda[3]) * k41,
    (k41 - k21) * (k41 - k31) / (lambda[1] - k41) / (lambda[2] - k41) / (lambda[3] - k41) / vc,
  ];

  const l1 = Math.exp(-lambda[1]);
  const l2 = Math.exp(-lambda[2]);
  const l3 = Math.exp(-lambda[3]);
  const l4 = Math.exp(-lambda[4]);

  // Compute p_udf per-second (cumulative Cp response to unit infusion)
  const p_udf = [0];
  let pt1 = 0, pt2 = 0, pt3 = 0;
  for (let i = 1; i <= 1000; i++) {
    pt1 = pt1 * l1 + p_coef[1] * (1 - l1);
    pt2 = pt2 * l2 + p_coef[2] * (1 - l2);
    pt3 = pt3 * l3 + p_coef[3] * (1 - l3);
    p_udf[i] = pt1 + pt2 + pt3;
  }

  // Compute e_udf per-second
  const e_udf = [0];
  let t1 = 0, t2 = 0, t3 = 0, t4 = 0;

  // Phase 1: infusion running for deltaSec seconds
  for (let i = 1; i <= deltaSec; i++) {
    t1 = t1 * l1 + e_coef[1] * (1 - l1);
    t2 = t2 * l2 + e_coef[2] * (1 - l2);
    t3 = t3 * l3 + e_coef[3] * (1 - l3);
    t4 = t4 * l4 + e_coef[4] * (1 - l4);
    e_udf[i] = t1 + t2 + t3 + t4;
  }

  // Phase 2: no infusion — decay only, find peak
  let peak_time = deltaSec;
  let prior = e_udf[deltaSec];
  for (let i = deltaSec + 1; i < 1000; i++) {
    t1 *= l1; t2 *= l2; t3 *= l3; t4 *= l4;
    e_udf[i] = t1 + t2 + t3 + t4;
    if (prior >= e_udf[i]) {
      peak_time = i - 1;
      break;
    }
    prior = e_udf[i];
  }

  return { e_udf, p_udf, peak_time, p_coef, e_coef, lambda };
}

/**
 * Compute SimTIVA's rate correction factor.
 * 
 * This factor reduces the bolus duration to prevent Ce overshoot
 * caused by redistribution during slow pump delivery. Slower pumps
 * get a larger discount (smaller bolus).
 * 
 * For 700 mL/h propofol: factor ≈ 0.915 (−8.5%)
 * For 750 mL/h propofol: factor ≈ 0.921 (−7.9%)
 * For 1200 mL/h: factor = 0.97 (−3%)
 * For RSI mode: factor = 1.0 (no correction)
 * 
 * @param {number} rawBolusMg - uncorrected bolus dose (mg)
 * @param {number} peakTimeSec - time of peak Ce (seconds)
 * @param {number} maxRateMgSec - pump max rate (mg/sec)
 * @param {number} maxRateMlH - pump max rate (mL/h)
 * @param {number} concentrationMgMl - drug concentration (mg/mL)
 * @returns {number} correction factor (0.8 to 0.97)
 */
function computeRateCorrFactor(rawBolusMg, peakTimeSec, maxRateMgSec, maxRateMlH, concentrationMgMl) {
  const max_1200 = 1200 * concentrationMgMl / 3600; // mg/sec at 1200 mL/h
  const min_rate = rawBolusMg / peakTimeSec; // minimum rate to deliver by peak time

  if (min_rate > maxRateMgSec) {
    // Pump can't deliver fast enough — heavy discount
    return 0.8;
  } else if (maxRateMlH > 1200) {
    return 0.97;
  } else {
    return 0.97 - (Math.abs(max_1200 - maxRateMgSec) / (max_1200 - min_rate)) * 0.1;
  }
}

/**
 * Compute the SimTIVA-style CET bolus with rate correction.
 * 
 * @param {Object} pkParams - Eleveld PK parameters { V1, V2, V3, CL, Q2, Q3, ke0 }
 * @param {number} ceTarget - target Ce (μg/mL)
 * @param {Object} [opts] - { maxRateMlH: 700, concentration: 10, rsi: false }
 * @returns {Object} { bolusMg, bolusVolMl, durationSec, peakTimeSec, rawBolusMg, rateCorrFactor, estimatedPeakCe }
 */
export function computeSimTIVACETBolus(pkParams, ceTarget, opts = {}) {
  const maxRateMlH = opts.maxRateMlH || 750;
  const concentration = opts.concentration || 10;
  const rsi = opts.rsi || false;

  const maxRateMgSec = maxRateMlH * concentration / 3600;

  // Compute UDFs with delta_seconds = 1 (unit impulse)
  const { e_udf, peak_time } = computeUDFs(pkParams, 1);

  // Raw bolus: target / e_udf[peak_time]
  const rawBolusMg = ceTarget / e_udf[peak_time];

  // Rate correction factor
  let rateCorrFactor;
  if (rsi) {
    rateCorrFactor = 1.0; // No correction for RSI — maximum speed
  } else {
    rateCorrFactor = computeRateCorrFactor(rawBolusMg, peak_time, maxRateMgSec, maxRateMlH, concentration);
  }

  // Effective bolus: floor(rawDose / maxRate * corrFactor) seconds of infusion
  const durationSec = Math.floor(rawBolusMg / maxRateMgSec * rateCorrFactor);
  const bolusMg = durationSec * maxRateMgSec;
  const bolusVolMl = bolusMg / concentration;

  // Estimated peak Ce (will be below target due to correction)
  const estimatedPeakCe = ceTarget * (bolusMg / rawBolusMg);

  return {
    bolusMg,
    bolusVolMl,
    durationSec,
    peakTimeSec: peak_time,
    rawBolusMg,
    rateCorrFactor,
    estimatedPeakCe,
  };
}

/**
 * For reference/testing: compute the raw (uncorrected) CET bolus.
 * This matches our calculateCETBolus() result.
 */
export function computeRawCETBolus(pkParams, ceTarget) {
  const { e_udf, peak_time } = computeUDFs(pkParams, 1);
  return {
    bolusMg: ceTarget / e_udf[peak_time],
    peakTimeSec: peak_time,
    e_udf_at_peak: e_udf[peak_time],
  };
}

/**
 * Expose UDF computation for testing and validation.
 */
export { computeUDFs, computeRateCorrFactor, cube };
