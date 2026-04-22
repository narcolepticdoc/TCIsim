/**
 * tci/shared.js — Shared helpers used across all TCI planners.
 *
 * Contains the default scheme config, the quantize-in-display closures,
 * bolus-delivery math, terminal-rate appending for V3 equilibration,
 * and findMaintenanceRate — a binary-search helper used by both the
 * Stepped and CET planners.
 */

import { computeSteadyStateRate } from '../../pk/steady-state-predictor.js';
import { quantizeInDisplay } from '../../util/units.js';

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
  return { qBolus, qRate };
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

  if (Math.abs(longTermRate - lastRate.value) / lastRate.value > 0.005) {
    scheme.push({ type: 'rate', time: simTime, value: longTermRate });
  }

  // Stage 2: analytical SS rate at simTime + LONG_LA
  const ssRateRaw = computeSteadyStateRate(engine, ceTarget);
  const ssRate = ssRateRaw != null ? qRate(ssRateRaw) : null;
  const currentLast = scheme[scheme.length - 1];
  if (ssRate != null && Math.abs(ssRate - currentLast.value) / currentLast.value > 0.005) {
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
