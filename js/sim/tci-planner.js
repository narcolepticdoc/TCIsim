/**
 * tci-planner.js — Clinician-Feasible TCI Scheme Generator
 * 
 * Instead of generating continuous 10-second rate updates like a real
 * TCI pump, this planner produces a practical scheme that a clinician
 * can execute with a standard syringe pump:
 * 
 *   1. A loading bolus to rapidly approach the target Ce
 *   2. A small number of stepped infusion rates (typically 3-5)
 *      that maintain Ce within a configurable tolerance band
 * 
 * The algorithm:
 *   - Calculate loading bolus using the effect-site overshoot method
 *   - Set an initial high rate and run forward until Ce drifts above
 *     the upper tolerance bound
 *   - Find the rate that keeps Ce at target, run until it drifts below
 *     the lower bound
 *   - Repeat, converging toward the maintenance rate
 *   - Stop when the rate is stable (maintenance reached)
 * 
 * Output: array of { type:'bolus'|'rate', time, value } events
 */

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
};

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

  // ---- Step 1: Loading bolus ----
  // If current Ce is below the lower bound, calculate a loading dose.
  // The bolus should overshoot Cp so that Ce rises to near the target.
  if (currentCe < lowerBound) {
    const bolusMg = calculateLoadingBolus(engine, ceTarget, cfg);

    if (bolusMg > 0) {
      scheme.push({ type: 'bolus', time: simTime, value: bolusMg });

      // Apply the bolus to the engine (delivered over 3 seconds)
      engine.advance(0.05, bolusMg / 0.05);
      simTime += 0.05;
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

    // Give bolus and find peak Ce
    engine.setState(saved);
    engine.advance(0.05, mid / 0.05);

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
function findMaintenanceRate(engine, ceTarget, cfg, stepNum = 0) {
  const saved = engine.getState();
  // Adaptive lookahead: 5 min for step 0, up to 60 min for later steps
  const lookAhead = Math.min(5 + stepNum * 5, 60);

  let lo = 0;
  let hi = cfg.maxRate;

  for (let i = 0; i < cfg.rateSearchIter; i++) {
    const mid = (lo + hi) / 2;

    engine.setState(saved);
    engine.advance(lookAhead, mid);
    const ce = engine.getConcentrations().Ce;

    if (Math.abs(ce - ceTarget) < 0.001) {
      engine.setState(saved);
      return mid;
    }

    if (ce < ceTarget) lo = mid;
    else hi = mid;
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
