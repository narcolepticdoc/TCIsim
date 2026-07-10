/**
 * tci/shared.js — Shared helpers used across all TCI planners.
 *
 * Contains the default scheme config, the quantize-in-display closures,
 * bolus-delivery math, terminal-rate appending for V3 equilibration,
 * and findMaintenanceRate — a binary-search helper used by both the
 * Stepped and CET planners.
 */

import { computeSteadyStateRate } from '../../pk/steady-state-predictor.js';
import { quantizeInDisplay, getQuantStep, toCanonical } from '../../util/units.js';

/**
 * @typedef {Object} TCISchemeConfig
 * @property {number} tolerancePct   - Ce tolerance band (fraction, e.g., 0.05 = ±5%)
 * @property {number} maxRate        - Maximum infusion rate (mg/min)
 * @property {number} maxSteps       - Maximum number of rate steps to generate
 * @property {number} maxPlanTime    - Maximum planning horizon (minutes)
 * @property {number} simStep        - Simulation step for forward scanning (minutes)
 * @property {number} rateSearchIter - Binary search iterations for rate finding
 * @property {number} minStepDuration - Minimum duration of a rate step (minutes)
 * @property {number} rateStablePct  - Rate considered stable if change < this fraction
 */

export const DEFAULT_SCHEME_CONFIG = {
  // tolerancePct: ±band around target used by the planners' BINARY decision
  // gates — the loading-bolus threshold and the target-decrease pause cap.
  // NOT a maintenance-phase drift tolerance. For the CET emulation planner,
  // the continuous drift knob is cfg.ceTolerance (user-facing slider, read
  // at emulation.js:457). See TCI-TOLERANCE-ANALYSIS.md §6 Option B vs §8
  // for why these stay separate.
  tolerancePct: 0.05,       // ±5% of target Ce
  maxRate: 200,             // mg/min (1200 mL/h for 10 mg/mL propofol)
  maxSteps: 8,              // max rate steps (excluding bolus)
  maxPlanTime: 120,         // plan up to 2 hours ahead
  simStep: 0.1,             // 6-second simulation steps for scanning
  rateSearchIter: 35,       // binary search iterations
  minStepDuration: 3.0,     // minimum 3 minutes per rate step
  rateStablePct: 0.05,      // rate stable if <5% change from previous
  bolusDeficitThreshold: 0.9, // Ce must be < 90% of target to trigger loading bolus
  // Bolus delivery config (set from drug config by simulation.js)
  bolusConcentration: 10,   // mg/mL
  bolusRateMlH: 750,        // mL/h pump bolus delivery rate
};

/**
 * Build quantization closures for a planner run. These snap bolus/rate
 * values to the clinician's chosen display-unit step BEFORE they are
 * fed back into engine.advance — so subsequent iterations see the value
 * the pump will actually deliver, preventing stacking errors from
 * post-hoc rounding. No-ops when cfg.quantizeInDisplay is false or the
 * display unit has no defined step, so all existing call paths remain
 * unchanged for the default (non-quantized) mode.
 */
export function makeQuantizers(cfg) {
  const qBolus = (mg) => {
    if (!cfg.quantizeInDisplay || !cfg.bolusDisplayUnit || !cfg.drugId) return mg;
    return quantizeInDisplay(mg, cfg.bolusDisplayUnit, cfg.drugId, 'bolus',
      { weightKg: cfg.weightKg, concentration: cfg.bolusConcentration });
  };
  const qRate = (mgMin) => {
    if (!cfg.quantizeInDisplay || !cfg.rateDisplayUnit || !cfg.drugId) return mgMin;
    return quantizeInDisplay(mgMin, cfg.rateDisplayUnit, cfg.drugId, 'rate',
      { weightKg: cfg.weightKg, concentration: cfg.bolusConcentration });
  };
  // Parameterized rate quantizer: same unit/context path as qRate, but snaps on
  // (normal display step ÷ divisor) — the tier machinery for the emulation
  // planner's progressive multi-tier grid. No-op (like qRate) when quantization
  // is off or the unit has no defined step. divisor = 1 is exactly qRate.
  const qRateDiv = (mgMin, divisor) => {
    if (!cfg.quantizeInDisplay || !cfg.rateDisplayUnit || !cfg.drugId) return mgMin;
    const step = getQuantStep(cfg.drugId, 'rate', cfg.rateDisplayUnit);
    if (!step) return mgMin;
    return quantizeInDisplay(mgMin, cfg.rateDisplayUnit, cfg.drugId, 'rate',
      { weightKg: cfg.weightKg, concentration: cfg.bolusConcentration },
      step / divisor);
  };
  return { qBolus, qRate, qRateDiv };
}

/**
 * Current rate grid step, expressed in canonical mg/min. Returns 0 when
 * quantization is off or the active display unit has no defined step (in which
 * case the emulation correction loop stays on tier 0 = un-quantized). Rate
 * conversions are linear through zero, so one display-unit step maps to
 * toCanonical(step).
 */
export function rateGridStepMgMin(cfg) {
  if (!cfg.quantizeInDisplay || !cfg.rateDisplayUnit || !cfg.drugId) return 0;
  const step = getQuantStep(cfg.drugId, 'rate', cfg.rateDisplayUnit);
  if (!step) return 0;
  return toCanonical(step, cfg.rateDisplayUnit, cfg.drugId, 'rate',
    { weightKg: cfg.weightKg, concentration: cfg.bolusConcentration }).value;
}

/**
 * Compute bolus delivery duration and infusion rate for the planner.
 * Matches the logic in events.js getBolusDelivery().
 */
export function plannerBolusDelivery(doseMg, cfg) {
  const volumeMl = doseMg / cfg.bolusConcentration;
  const durationMin = volumeMl / cfg.bolusRateMlH * 60;
  const duration = Math.max(0.05, durationMin);
  return { duration, rate: doseMg / duration };
}

/**
 * Binary-search the loading bolus whose PEAK Ce (delivery at pump rate,
 * then zero-rate scan) matches the target. One body serves both the
 * Stepped and CET planners — they differ only in these tuning constants:
 *
 *   Stepped: { upperMult: 3, scanHorizon: 15, scanStep: 0.25, tol: 0.01 }
 *   CET:     { upperMult: 8, scanHorizon: 20, scanStep: 0.1,  tol: 0.005 }
 *
 * Quantization-free by design: callers apply qBolus (cet-conservative.js
 * needs the raw unquantized value). Restores engine state before returning.
 */
export function searchPeakBolus(engine, ceTarget, cfg, { upperMult, scanHorizon, scanStep, tol }) {
  const saved = engine.getState();

  let lo = 0;
  let hi = ceTarget * engine.params.V1 * upperMult; // generous upper bound

  for (let i = 0; i < cfg.rateSearchIter; i++) {
    const mid = (lo + hi) / 2;

    // Deliver bolus at pump rate
    engine.setState(saved);
    const { duration, rate } = plannerBolusDelivery(mid, cfg);
    engine.advance(duration, rate);

    // Scan forward with zero rate to find peak Ce
    let peakCe = 0;
    for (let t = 0; t < scanHorizon; t += scanStep) {
      engine.advance(scanStep, 0);
      const ce = engine.getConcentrations().Ce;
      if (ce > peakCe) peakCe = ce;
      else if (ce < peakCe - 0.001) break; // past peak
    }

    if (Math.abs(peakCe - ceTarget) < tol) {
      engine.setState(saved);
      return mid;
    }

    if (peakCe < ceTarget) lo = mid;
    else hi = mid;
  }

  engine.setState(saved);
  return (lo + hi) / 2;
}

/**
 * Target-decrease decay wait: emit a rate-0 step and advance at zero rate
 * until Ce falls to `upperBound` (or the plan horizon runs out). Pushes the
 * pause step into `scheme` and returns the updated simTime. Shared by the
 * Stepped, CET, and Emulation planners.
 */
export function waitForDecay(engine, upperBound, simTime, startTime, scheme, cfg) {
  scheme.push({ type: 'rate', time: simTime, value: 0 });
  const maxWait = startTime + cfg.maxPlanTime;
  while (simTime < maxWait) {
    engine.advance(cfg.simStep, 0);
    simTime += cfg.simStep;
    if (engine.getConcentrations().Ce <= upperBound) break;
  }
  return simTime;
}

/**
 * Maintenance rate floor: the rate search may return ~0 while Ce is still
 * substantial (redistribution covering the target for now) — but maintenance
 * should never pause. Use a minimal rate and let the next step correct.
 */
export function floorMaintenanceRate(rate, engine, ceTarget, qRate) {
  if (rate < 0.001 && engine.getConcentrations().Ce > ceTarget * 0.5) {
    return qRate(0.001);
  }
  return rate;
}

/**
 * Append terminal rate events to account for V3 equilibration beyond
 * the maintenance loop's planning window.
 *
 * Two-stage approach:
 * 1. Long-lookahead rate (at simTime): binary search for the rate where
 *    Ce at +300 min from the current engine state = ceTarget. This accounts
 *    for V3's actual equilibration level at loop exit.
 * 2. Analytical SS rate (at simTime + 300): the true asymptotic rate
 *    (Ce → ceTarget as t → ∞). Takes over once V3 is nearly equilibrated.
 *
 * @param {Object} engine - PK engine (at the state where the loop exited)
 * @param {number} ceTarget - Target Ce
 * @param {number} simTime - Current simulation time
 * @param {Array} scheme - Scheme array to append to (mutated in place)
 * @param {Object} cfg - Planner config (for maxRate, rateSearchIter)
 */
export function appendTerminalRates(engine, ceTarget, simTime, scheme, cfg) {
  if (ceTarget <= 0 || scheme.length === 0) return;
  const lastRate = scheme[scheme.length - 1];
  if (lastRate.type !== 'rate') return;

  const { qRate } = makeQuantizers(cfg);
  const LONG_LA = 300; // 5 hours lookahead
  const finalState = engine.getState();

  // Stage 1: long-lookahead rate from current state
  let lo = 0, hi = cfg.maxRate;
  for (let i = 0; i < 30; i++) {
    const mid = (lo + hi) / 2;
    engine.setState(finalState);
    engine.advance(LONG_LA, mid);
    if (engine.getConcentrations().Ce < ceTarget) lo = mid; else hi = mid;
  }
  engine.setState(finalState);
  const longTermRate = qRate((lo + hi) / 2);

  // Relative-difference test with a denominator floor: a 0-value last step
  // (e.g. a target-decrease pause tail) must not make this 0/0 → NaN and
  // silently drop the terminal rate.
  const relDiff = (a, b) => Math.abs(a - b) / Math.max(Math.abs(b), 1e-9);
  if (relDiff(longTermRate, lastRate.value) > 0.005) {
    scheme.push({ type: 'rate', time: simTime, value: longTermRate });
  }

  // Stage 2: analytical SS rate at simTime + LONG_LA
  const ssRateRaw = computeSteadyStateRate(engine, ceTarget);
  const ssRate = ssRateRaw != null ? qRate(ssRateRaw) : null;
  const currentLast = scheme[scheme.length - 1];
  if (ssRate != null && relDiff(ssRate, currentLast.value) > 0.005) {
    scheme.push({ type: 'rate', time: simTime + LONG_LA, value: ssRate });
  }
}

/**
 * Find the infusion rate that maintains Ce at the target.
 *
 * Dual-constraint search:
 * 1. Endpoint: rate where Ce at t + lookAhead = target
 * 2. Peak: rate where max Ce over window ≤ target (prevents overshoot)
 * Returns the lower of the two.
 *
 * When Ce is currently ABOVE target (drift correction), only the
 * endpoint search is used — the peak constraint would force rate=0
 * since Ce is already above target.
 *
 * Used by both the Stepped and CET planners.
 */
export function findMaintenanceRate(engine, ceTarget, cfg, stepNum = 0) {
  const saved = engine.getState();
  const currentCe = engine.getConcentrations().Ce;
  const initialLA = cfg.initialLookAhead || 5;
  const lookAhead = Math.min(initialLA + stepNum * 5, 60);

  // Search 1: rate where endpoint Ce = target
  let lo1 = 0, hi1 = cfg.maxRate;
  for (let i = 0; i < cfg.rateSearchIter; i++) {
    const mid = (lo1 + hi1) / 2;
    engine.setState(saved);
    engine.advance(lookAhead, mid);
    const ce = engine.getConcentrations().Ce;
    if (ce < ceTarget) lo1 = mid; else hi1 = mid;
  }
  const endpointRate = (lo1 + hi1) / 2;

  // If Ce is at or above target, endpoint-only.
  // The peak constraint would return ~0 when Ce > target (since Ce already
  // exceeds the cap), causing min(endpointRate, ~0) = ~0 and a free-fall.
  if (currentCe >= ceTarget) {
    // Well above target — just find the rate to bring Ce down
    engine.setState(saved);
    return Math.max(0, endpointRate);
  }

  // Search 2: rate where peak Ce over LONG window ≤ target
  // Use 60 minutes regardless of step — catches slow redistribution overshoot
  const peakWindow = 60;
  const peakSteps = Math.ceil(peakWindow / cfg.simStep);
  let lo2 = 0, hi2 = cfg.maxRate;
  for (let i = 0; i < cfg.rateSearchIter; i++) {
    const mid = (lo2 + hi2) / 2;
    engine.setState(saved);
    let maxCe = 0;
    for (let s = 0; s < peakSteps; s++) {
      engine.advance(cfg.simStep, mid);
      const ce = engine.getConcentrations().Ce;
      if (ce > maxCe) maxCe = ce;
    }
    if (maxCe > ceTarget) hi2 = mid; else lo2 = mid;
  }
  const peakRate = (lo2 + hi2) / 2;

  engine.setState(saved);
  return Math.min(endpointRate, peakRate);
}
