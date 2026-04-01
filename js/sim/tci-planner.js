/**
 * tci-planner.js — TCI Scheme Generators
 * 
 * Three planning modes:
 * 
 * 1. planTCIScheme (Stepped) — Conservative gradual approach.
 *    Small bolus targeting peak Ce = target, then stepped maintenance rates.
 *    Slow onset (~8-10 min to 95%) but low Cp overshoot.
 * 
 * 2. planTCISchemeCET (CET) — Fast onset with exact Ce targeting.
 *    Large bolus where peak Ce after pump-rate delivery + pause = target.
 *    Fast onset (~2.5 min to 95%) but high transient Cp overshoot.
 * 
 * 3. planTCISchemeCETConservative (CET Conservative) — SimTIVA-style.
 *    Same as CET but with rate-correction factor that reduces bolus ~9%.
 *    Slightly slower onset than CET but gentler hemodynamics.
 *    Validated against SimTIVA output (within 1.3%).
 * 
 * All three handle target decreases identically: pause until Ce decays
 * to tolerance band, then stepped maintenance.
 * 
 * Output: array of { type:'bolus'|'rate', time, value } events
 */

import { computeSimTIVACETBolus } from './simtiva-reference.js';

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

const DEFAULT_SCHEME_CONFIG = {
  tolerancePct: 0.05,       // ±5% of target Ce
  maxRate: 200,             // mg/min (1200 mL/h for 10 mg/mL propofol)
  maxSteps: 8,              // max rate steps (excluding bolus)
  maxPlanTime: 120,         // plan up to 2 hours ahead
  simStep: 0.1,             // 6-second simulation steps for scanning
  rateSearchIter: 35,       // binary search iterations
  minStepDuration: 3.0,     // minimum 3 minutes per rate step
  rateStablePct: 0.05,      // rate stable if <5% change from previous
  // Bolus delivery config (set from drug config by simulation.js)
  bolusConcentration: 10,   // mg/mL
  bolusRateMlH: 750,        // mL/h pump bolus delivery rate
};

/**
 * Compute bolus delivery duration and infusion rate for the planner.
 * Matches the logic in events.js getBolusDelivery().
 */
function plannerBolusDelivery(doseMg, cfg) {
  const volumeMl = doseMg / cfg.bolusConcentration;
  const durationMin = volumeMl / cfg.bolusRateMlH * 60;
  const duration = Math.max(0.05, durationMin);
  return { duration, rate: doseMg / duration };
}

/**
 * Generate a clinician-feasible TCI scheme.
 * 
 * @param {Object} engine      - PK engine instance
 * @param {Float64Array} startState - Engine state to start from
 * @param {number} startTime   - Simulation time (minutes)
 * @param {number} ceTarget    - Desired effect-site concentration (μg/mL)
 * @param {TCISchemeConfig} [config] - Scheme configuration
 * @returns {Array<{type:string, time:number, value:number}>}
 *          Scheme events: bolus + rate steps
 */
export function planTCIScheme(engine, startState, startTime, ceTarget, config = {}) {
  const cfg = { ...DEFAULT_SCHEME_CONFIG, ...config };
  const scheme = [];

  if (ceTarget <= 0) {
    scheme.push({ type: 'rate', time: startTime, value: 0 });
    return scheme;
  }

  const saved = engine.getState();
  engine.setState(startState);

  const currentCe = engine.getConcentrations().Ce;
  const upperBound = ceTarget * (1 + cfg.tolerancePct);
  const lowerBound = ceTarget * (1 - cfg.tolerancePct);

  let simTime = startTime;

  // ---- Step 1a: Loading bolus (target increase) ----
  // If current Ce is below the lower bound, calculate a loading dose.
  if (currentCe < lowerBound) {
    const bolusMg = calculateLoadingBolus(engine, ceTarget, cfg);

    if (bolusMg > 0) {
      scheme.push({ type: 'bolus', time: simTime, value: bolusMg });

      // Apply the bolus to the engine at the pump's bolus delivery rate
      const { duration, rate } = plannerBolusDelivery(bolusMg, cfg);
      engine.advance(duration, rate);
      simTime += duration;
    }
  }

  // ---- Step 1b: Decay wait (target decrease) ----
  // If current Ce is above the upper bound, pause and wait for Ce
  // to decay down to the upper bound before starting maintenance.
  if (currentCe > upperBound) {
    scheme.push({ type: 'rate', time: simTime, value: 0 });

    // Advance with rate=0 until Ce drops to upperBound or timeout
    const maxWait = startTime + cfg.maxPlanTime;
    while (simTime < maxWait) {
      engine.advance(cfg.simStep, 0);
      simTime += cfg.simStep;
      const ce = engine.getConcentrations().Ce;
      if (ce <= upperBound) break;
    }
  }

  // ---- Step 2: Generate rate steps ----
  // Find the rate that would maintain Ce at target from the current state,
  // run forward, and when Ce drifts out of bounds, recalculate.

  let prevRate = -1;

  for (let step = 0; step < cfg.maxSteps; step++) {
    if (simTime >= startTime + cfg.maxPlanTime) break;

    // Find the rate that holds Ce at target over the next period
    const optimalRate = findMaintenanceRate(engine, ceTarget, cfg, step);

    // Check if rate has stabilised (converged to maintenance)
    if (prevRate > 0 && Math.abs(optimalRate - prevRate) / prevRate < cfg.rateStablePct) {
      // Rate is stable — emit final maintenance rate and stop
      scheme.push({ type: 'rate', time: simTime, value: optimalRate });
      break;
    }

    scheme.push({ type: 'rate', time: simTime, value: optimalRate });
    prevRate = optimalRate;

    // Run forward at this rate until Ce leaves the tolerance band
    // or we hit max plan time
    const stepEnd = runUntilDrift(engine, ceTarget, optimalRate, simTime, cfg);
    simTime = stepEnd;

    if (simTime >= startTime + cfg.maxPlanTime) break;
  }

  // If we ran out of steps, emit the last calculated rate as maintenance
  if (scheme.length > 0 && scheme[scheme.length - 1].type === 'rate') {
    // Already have a final rate — good
  }

  engine.setState(saved);
  return scheme;
}

/**
 * Calculate the loading bolus dose using binary search.
 * Finds the bolus that, after distribution and equilibration,
 * brings Ce closest to the target.
 * 
 * We search for the bolus where the PEAK Ce (which occurs several
 * minutes after the bolus due to ke0 lag) matches the target.
 */
function calculateLoadingBolus(engine, ceTarget, cfg) {
  const saved = engine.getState();

  let lo = 0;
  let hi = ceTarget * engine.params.V1 * 3; // generous upper bound

  for (let i = 0; i < cfg.rateSearchIter; i++) {
    const mid = (lo + hi) / 2;

    // Give bolus at pump rate and find peak Ce
    engine.setState(saved);
    const { duration, rate } = plannerBolusDelivery(mid, cfg);
    engine.advance(duration, rate);

    // Scan forward to find peak Ce (no further infusion)
    let peakCe = 0;
    for (let t = 0; t < 15; t += 0.25) {
      engine.advance(0.25, 0);
      const ce = engine.getConcentrations().Ce;
      if (ce > peakCe) peakCe = ce;
      else if (ce < peakCe - 0.001) break; // past peak
    }

    if (Math.abs(peakCe - ceTarget) < 0.01) {
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
 * Find the infusion rate that maintains Ce at the target from
 * the current engine state.
 * 
 * Uses adaptive lookahead: short for early steps (compensating for
 * redistribution), progressively longer for later steps to converge
 * on the true maintenance rate.
 */
/**
 * Find the infusion rate that maintains Ce at the target.
 * 
 * Uses binary search. For each candidate rate, simulates forward
 * over the lookahead window and finds the PEAK Ce deviation from
 * target. The optimal rate minimizes this peak deviation.
 * 
 * This approach prevents overshoot — it finds the rate where Ce
 * stays closest to target throughout the window, not just at the end.
 */
function findMaintenanceRate(engine, ceTarget, cfg, stepNum = 0) {
  const saved = engine.getState();
  const initialLA = cfg.initialLookAhead || 5;
  const lookAhead = Math.min(initialLA + stepNum * 5, 60);

  let lo = 0;
  let hi = cfg.maxRate;

  for (let i = 0; i < cfg.rateSearchIter; i++) {
    const mid = (lo + hi) / 2;

    engine.setState(saved);

    // Simulate forward and find max Ce over the window
    let maxCe = 0;
    const steps = Math.ceil(lookAhead / cfg.simStep);
    for (let s = 0; s < steps; s++) {
      engine.advance(cfg.simStep, mid);
      const ce = engine.getConcentrations().Ce;
      if (ce > maxCe) maxCe = ce;
    }

    if (Math.abs(maxCe - ceTarget) < 0.001) {
      engine.setState(saved);
      return mid;
    }

    // If peak Ce overshoots target, rate is too high
    if (maxCe > ceTarget) hi = mid;
    else lo = mid;
  }

  engine.setState(saved);
  return (lo + hi) / 2;
}

/**
 * Run the engine forward at a fixed rate until Ce drifts outside
 * the tolerance band. Returns the time at which drift occurred.
 * Also enforces a minimum step duration.
 */
function runUntilDrift(engine, ceTarget, rate, fromTime, cfg) {
  const upper = ceTarget * (1 + cfg.tolerancePct);
  const lower = ceTarget * (1 - cfg.tolerancePct);
  const maxTime = fromTime + cfg.maxPlanTime;
  let t = fromTime;
  let minTimeReached = false;

  while (t < maxTime) {
    engine.advance(cfg.simStep, rate);
    t += cfg.simStep;

    if (t - fromTime >= cfg.minStepDuration) minTimeReached = true;

    if (minTimeReached) {
      const ce = engine.getConcentrations().Ce;
      if (ce > upper || ce < lower) {
        return t;
      }
    }
  }

  return t; // reached max plan time without drift — maintenance rate
}

/**
 * SimTIVA-style CET (Ce-targeting) planner.
 * 
 * Differs from the stepped planner in the loading phase:
 *   - Calculates a larger bolus that, when delivered at pump rate then
 *     followed by a PAUSE (rate=0), produces peak Ce = target.
 *   - Waits during the pause for Ce to reach target, then starts maintenance.
 *   - Produces faster onset than the stepped planner (~2-3 min vs ~8-10 min).
 *   - Cp overshoots significantly during the bolus phase (clinical trade-off).
 * 
 * For target decreases, behavior is identical to the stepped planner:
 *   pause until Ce decays to target, then maintenance.
 * 
 * Output: same format as planTCIScheme — array of {type, time, value} events.
 * 
 * @param {Object} engine      - PK engine instance
 * @param {Float64Array} startState - Engine state to start from
 * @param {number} startTime   - Simulation time (minutes)
 * @param {number} ceTarget    - Desired effect-site concentration (μg/mL)
 * @param {TCISchemeConfig} [config] - Scheme configuration
 * @returns {Array<{type:string, time:number, value:number}>}
 */
export function planTCISchemeCET(engine, startState, startTime, ceTarget, config = {}, bolusOverrideMg = null, pauseDurationMin = null) {
  // Derive initial lookahead from ke0: 3 × half-life ≈ 87.5% equilibration
  const ke0 = engine.params?.ke0 || 0.146;
  const ke0HalfLife = Math.log(2) / ke0; // minutes
  const derivedLookAhead = Math.round(3 * ke0HalfLife);

  const cfg = {
    ...DEFAULT_SCHEME_CONFIG,
    maxSteps: 12,
    rateStablePct: 0.02,
    maxPlanTime: 360,
    initialLookAhead: derivedLookAhead,
    ...config,
  };
  const scheme = [];

  if (ceTarget <= 0) {
    scheme.push({ type: 'rate', time: startTime, value: 0 });
    return scheme;
  }

  const saved = engine.getState();
  engine.setState(startState);

  const currentCe = engine.getConcentrations().Ce;
  const upperBound = ceTarget * (1 + cfg.tolerancePct);
  const lowerBound = ceTarget * (1 - cfg.tolerancePct);

  let simTime = startTime;

  // ---- Target increase: bolus → pause → maintenance ----
  if (currentCe < lowerBound) {
    const bolusMg = bolusOverrideMg != null
      ? bolusOverrideMg
      : calculateCETBolus(engine, ceTarget, cfg);

    if (bolusMg > 0) {
      scheme.push({ type: 'bolus', time: simTime, value: bolusMg });

      // Deliver bolus at pump rate
      const { duration, rate } = plannerBolusDelivery(bolusMg, cfg);
      engine.advance(duration, rate);
      simTime += duration;

      // Pause — advance with rate=0 until Ce peaks.
      // If pauseDurationMin is provided (from analytical calculation),
      // use it directly. Otherwise scan forward to detect peak.
      scheme.push({ type: 'rate', time: simTime, value: 0 });

      if (pauseDurationMin != null && pauseDurationMin > 0) {
        // Analytical pause duration (SimTIVA-style)
        engine.advance(pauseDurationMin, 0);
        simTime += pauseDurationMin;
      } else {
        // Forward scan to detect Ce peak (1-second resolution)
        const pauseStep = 1 / 60;
        let cePeak = 0;
        let cePrior = 0;
        const maxWait = startTime + cfg.maxPlanTime;

        while (simTime < maxWait) {
          engine.advance(pauseStep, 0);
          simTime += pauseStep;
          const ce = engine.getConcentrations().Ce;

          if (ce > cePeak) {
            cePeak = ce;
            cePrior = ce;
          } else if (ce < cePrior - 0.0005) {
            // Ce has started falling — peak was reached
            break;
          }
          cePrior = ce;
        }
      }
    }
  }

  // ---- Target decrease: pause → wait for decay → maintenance ----
  if (currentCe > upperBound) {
    scheme.push({ type: 'rate', time: simTime, value: 0 });

    const maxWait = startTime + cfg.maxPlanTime;
    while (simTime < maxWait) {
      engine.advance(cfg.simStep, 0);
      simTime += cfg.simStep;
      const ce = engine.getConcentrations().Ce;
      if (ce <= upperBound) break;
    }
  }

  // ---- Maintenance: find the rate that holds Ce at target ----
  // At this point Ce should be near the target (either from bolus-pause
  // approach or decay wait). Find and emit maintenance rate steps.

  let prevRate = -1;

  for (let step = 0; step < cfg.maxSteps; step++) {
    if (simTime >= startTime + cfg.maxPlanTime) break;

    const optimalRate = findMaintenanceRate(engine, ceTarget, cfg, step);

    // Convergence check
    if (prevRate > 0 && Math.abs(optimalRate - prevRate) / prevRate < cfg.rateStablePct) {
      scheme.push({ type: 'rate', time: simTime, value: optimalRate });
      break;
    }

    scheme.push({ type: 'rate', time: simTime, value: optimalRate });
    prevRate = optimalRate;

    const stepEnd = runUntilDrift(engine, ceTarget, optimalRate, simTime, cfg);
    simTime = stepEnd;

    if (simTime >= startTime + cfg.maxPlanTime) break;
  }

  engine.setState(saved);
  return scheme;
}

/**
 * Calculate the CET loading bolus — the dose where the PEAK Ce
 * (after bolus delivery at pump rate, then zero-rate decay) equals
 * the target. This is a larger dose than the stepped planner's bolus
 * because it accounts for the redistribution-driven Ce peak.
 * 
 * SimTIVA equivalent: the bolus in CET mode where Ce(T_peak) = target.
 */
function calculateCETBolus(engine, ceTarget, cfg) {
  const saved = engine.getState();

  let lo = 0;
  let hi = ceTarget * engine.params.V1 * 8; // generous upper bound for CET

  for (let i = 0; i < cfg.rateSearchIter; i++) {
    const mid = (lo + hi) / 2;

    // Deliver bolus at pump rate
    engine.setState(saved);
    const { duration, rate } = plannerBolusDelivery(mid, cfg);
    engine.advance(duration, rate);

    // Scan forward with zero rate to find peak Ce
    let peakCe = 0;
    for (let t = 0; t < 20; t += 0.1) {
      engine.advance(0.1, 0);
      const ce = engine.getConcentrations().Ce;
      if (ce > peakCe) peakCe = ce;
      else if (ce < peakCe - 0.001) break; // past peak
    }

    if (Math.abs(peakCe - ceTarget) < 0.005) {
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
 * CET Conservative (SimTIVA-style) planner.
 * 
 * Uses SimTIVA's rate_corr_factor to reduce the bolus by ~9%,
 * and SimTIVA's analytical peak time to determine when to start
 * maintenance. Produces gentler hemodynamics at the cost of
 * slightly slower onset.
 * 
 * Validated against SimTIVA output within 1.3%.
 */
export function planTCISchemeCETConservative(engine, startState, startTime, ceTarget, config = {}) {
  const cfg = { ...DEFAULT_SCHEME_CONFIG, ...config };

  const pkParams = engine.params;

  // Check if there's existing drug in the system
  engine.setState(startState);
  const currentCe = engine.getConcentrations().Ce;

  let bolusMg, pauseDurationMin;

  if (currentCe < 0.1) {
    // Starting from zero — use SimTIVA's analytical UDF formula
    const simtiva = computeSimTIVACETBolus(pkParams, ceTarget, {
      maxRateMlH: cfg.bolusRateMlH || 750,
      concentration: cfg.bolusConcentration || 10,
    });
    bolusMg = simtiva.bolusMg;
    const bolusEndMin = simtiva.durationSec / 60;
    const peakMin = simtiva.peakTimeSec / 60;
    pauseDurationMin = Math.max(0, peakMin - bolusEndMin);
  } else {
    // Existing drug — use binary search (accounts for current state)
    // then apply rate correction factor for conservative dosing
    const exactBolus = calculateCETBolus(engine, ceTarget, cfg);
    const simtiva = computeSimTIVACETBolus(pkParams, ceTarget, {
      maxRateMlH: cfg.bolusRateMlH || 750,
      concentration: cfg.bolusConcentration || 10,
    });
    // Apply the same proportional reduction as SimTIVA would
    const correctionRatio = simtiva.rawBolusMg > 0
      ? simtiva.bolusMg / simtiva.rawBolusMg
      : 1;
    bolusMg = exactBolus * correctionRatio;
    pauseDurationMin = null; // use forward scan (peak time differs with existing drug)
  }

  engine.setState(startState); // restore before passing to CET planner
  return planTCISchemeCET(engine, startState, startTime, ceTarget, config,
    bolusMg, pauseDurationMin);
}

/**
 * Convenience: plan a TCI scheme from a given event list state.
 * Gets the last executed state for the drug and plans from there.
 * 
 * @param {Object} eventList - EventList instance
 * @param {string} drugId    - Drug ID
 * @param {number} ceTarget  - Target Ce (μg/mL)
 * @param {Object} [config]  - Scheme configuration
 * @returns {Array} Scheme events
 */
export function planTCIFromEvents(eventList, drugId, ceTarget, config = {}) {
  const engine = eventList.getEngine(drugId);
  if (!engine) return [];

  const { state, time } = eventList.getLastExecutedState(drugId);
  return planTCIScheme(engine, state, time, ceTarget, config);
}
