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

import { computeSimTIVACETBolus, computeUDFs } from './simtiva-reference.js';

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
    let optimalRate = findMaintenanceRate(engine, ceTarget, cfg, step);

    // Maintenance should never pause — if rate search returns ~0 but Ce
    // is still substantial, use a minimal rate and let the next step correct
    if (optimalRate < 0.001 && engine.getConcentrations().Ce > ceTarget * 0.5) {
      optimalRate = 0.001;
    }

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
 */
function findMaintenanceRate(engine, ceTarget, cfg, stepNum = 0) {
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

  // If Ce is above target, endpoint-only (bring it back down gradually)
  // Otherwise, use both constraints (endpoint + peak prevention)
  if (currentCe > ceTarget * 1.05) {
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
    maxSteps: 10,
    rateStablePct: 0.01,       // 1% final convergence
    tolerancePct: 0.03,        // ±3% Ce band for drift detection
    rateChangeThreshold: 0.08, // 8% rate change to trigger new step (SimTIVA uses 5-8%)
    minStepDuration: 2.0,      // 2 min minimum per step
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

  // ---- Target increase ----
  // Large deficit (Ce < 80% of target): bolus → pause → maintenance
  // Small deficit (Ce 80-95% of target): skip bolus, just adjust rate
  const ceDeficitRatio = currentCe / ceTarget;
  const needsBolus = currentCe < lowerBound && ceDeficitRatio < 0.8;

  if (needsBolus) {
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

  // ---- Maintenance: rate-change threshold scanning ----
  // Advance in 1-minute intervals checking the optimal rate.
  // Emit a new step only when the rate has changed by > rateChangeThreshold.
  // This matches SimTIVA's approach and produces 5-7 steps over hours.

  const rateChangeThresh = cfg.rateChangeThreshold || 0.08;
  const checkInterval = 1.0; // check every minute

  // Find initial maintenance rate
  let currentRate = findMaintenanceRate(engine, ceTarget, cfg, 0);
  if (currentRate < 0.001 && engine.getConcentrations().Ce > ceTarget * 0.5) {
    currentRate = 0.001;
  }
  scheme.push({ type: 'rate', time: simTime, value: currentRate });

  let stepCount = 1;
  let checkNum = 0;

  while (simTime < startTime + cfg.maxPlanTime && stepCount < cfg.maxSteps) {
    engine.advance(checkInterval, currentRate);
    simTime += checkInterval;
    checkNum++;

    // Check optimal rate every minute, but only use growing lookAhead
    const stepIdx = Math.min(checkNum, 20); // cap growth
    const optimalNow = findMaintenanceRate(engine, ceTarget, cfg, stepIdx);

    const rateChange = currentRate > 0.001
      ? Math.abs(optimalNow - currentRate) / currentRate
      : (optimalNow > 0.001 ? 1 : 0);

    if (rateChange > rateChangeThresh) {
      currentRate = optimalNow > 0.001 ? optimalNow : 0.001;
      scheme.push({ type: 'rate', time: simTime, value: currentRate });
      stepCount++;
    } else if (rateChange < cfg.rateStablePct) {
      const lastEmitted = scheme[scheme.length - 1];
      if (Math.abs(optimalNow - lastEmitted.value) / lastEmitted.value > 0.005) {
        scheme.push({ type: 'rate', time: simTime, value: optimalNow });
      }
      break;
    }
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
 * CET Emulation planner — ported from SimTIVA's algorithm.
 *
 * Uses SimTIVA's two-pass approach:
 * 1. First pass: compute optimal Cp-targeting rate at each 2-minute interval
 *    for 6 hours (180 intervals). Each rate is the amount needed to bring Cp
 *    to target over the next interval, given current state.
 * 2. Second pass: extract clinician-feasible steps by scanning the rate array
 *    and emitting a new step when the rate changes by >cpt_threshold (8%).
 *    Step rates are weighted averages (cpt_avgfactor).
 *
 * Loading: uses CET bolus + pause (same as CET Conservative).
 * Maintenance: SimTIVA's per-interval Cp targeting → step extraction.
 *
 * @param {Object} engine
 * @param {Float64Array} startState
 * @param {number} startTime
 * @param {number} ceTarget
 * @param {Object} [config]
 * @returns {Array<{type:string, time:number, value:number}>}
 */
export function planTCISchemeEmulation(engine, startState, startTime, ceTarget, config = {}) {
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

  let simTime = startTime;

  // ---- Loading: CET bolus + pause (same as conservative) ----
  // SimTIVA always gives a bolus for any CET target increase (no threshold).
  // The bolus size is computed accounting for existing drug.
  const needsBolus = currentCe < ceTarget * (1 - cfg.tolerancePct);

  if (needsBolus) {
    let bolusMg, pauseDurationMin = null;
    const pkParams = engine.params;

    if (currentCe < 0.1) {
      const simtiva = computeSimTIVACETBolus(pkParams, ceTarget, {
        maxRateMlH: cfg.bolusRateMlH || 750,
        concentration: cfg.bolusConcentration || 10,
      });
      bolusMg = simtiva.bolusMg;
      pauseDurationMin = Math.max(0, (simtiva.peakTimeSec - simtiva.durationSec) / 60);
    } else {
      // SimTIVA CET step-up algorithm (lines 3762-3779):
      // 1. Decompose Ce into eigenstates
      // 2. trial_rate = (desired - vmCe(e_state, peak)) / e_udf[peak]  (gives dose in mg with deltaSec=1)
      // 3. find_peak: adjust peak_time for this dose
      // 4. Iterate until converged
      // 5. Apply rate correction factor

      const { e_udf, e_coef, lambda: lam } = computeUDFs(pkParams, 1);
      const peakTime0 = e_udf.findIndex((v, i) => i > 1 && v < e_udf[i - 1]) - 1 || 175;

      // Decompose Ce eigenstate via 4x4 Gaussian elimination
      const saved2 = engine.getState();
      const tSamples = [5, 30, 120, 600];
      const ceSamples = [];
      for (const ts of tSamples) {
        engine.setState(saved2);
        engine.advance(ts / 60, 0);
        ceSamples.push(engine.getConcentrations().Ce);
      }
      engine.setState(saved2);

      // Solve 4x4 system
      const N = 4;
      const A = [];
      for (let i = 0; i < N; i++) {
        const row = [];
        for (let j = 0; j < N; j++) row.push(Math.exp(-lam[j + 1] * tSamples[i]));
        row.push(ceSamples[i]);
        A.push(row);
      }
      for (let col = 0; col < N; col++) {
        let maxRow = col, maxVal = Math.abs(A[col][col]);
        for (let row = col + 1; row < N; row++) {
          if (Math.abs(A[row][col]) > maxVal) { maxVal = Math.abs(A[row][col]); maxRow = row; }
        }
        [A[col], A[maxRow]] = [A[maxRow], A[col]];
        for (let row = col + 1; row < N; row++) {
          const f = A[row][col] / A[col][col];
          for (let j = col; j <= N; j++) A[row][j] -= f * A[col][j];
        }
      }
      const es = new Array(N);
      for (let i = N - 1; i >= 0; i--) {
        es[i] = A[i][N];
        for (let j = i + 1; j < N; j++) es[i] -= A[i][j] * es[j];
        es[i] /= A[i][i];
      }

      // vmCe: predict Ce at t seconds from eigenstate at rate=0
      function vmCe(t) {
        let c = 0;
        for (let j = 0; j < 4; j++) c += es[j] * Math.exp(-lam[j + 1] * t);
        return c;
      }

      // Iterative trial_rate + find_peak (SimTIVA lines 3762-3779)
      let tempPeak = peakTime0;
      let trialDose, current;
      const minDif = 0.005;

      for (let iter = 0; iter < 20; iter++) {
        // trial_rate with deltaSec=1 gives dose in mg
        trialDose = (ceTarget - vmCe(tempPeak)) / e_udf[tempPeak];

        // find_peak: scan for actual peak Ce = vmCe(t) + e_udf[t] * trialDose
        let peakVal = vmCe(tempPeak) + e_udf[tempPeak] * trialDose;
        // Search forward
        while (tempPeak < e_udf.length - 2) {
          const next = vmCe(tempPeak + 1) + (e_udf[tempPeak + 1] || 0) * trialDose;
          if (next <= peakVal) break;
          peakVal = next;
          tempPeak++;
        }
        // Search backward
        while (tempPeak > 1) {
          const prev = vmCe(tempPeak - 1) + e_udf[tempPeak - 1] * trialDose;
          if (prev <= peakVal) break;
          peakVal = prev;
          tempPeak--;
        }

        current = vmCe(tempPeak) + e_udf[tempPeak] * trialDose;
        if (Math.abs(current - ceTarget) < minDif) break;
      }

      // trialDose is the raw bolus. Apply rate correction.
      const simtiva = computeSimTIVACETBolus(pkParams, ceTarget, {
        maxRateMlH: cfg.bolusRateMlH || 750,
        concentration: cfg.bolusConcentration || 10,
      });
      const correctionRatio = simtiva.rawBolusMg > 0 ? simtiva.bolusMg / simtiva.rawBolusMg : 1;
      bolusMg = trialDose * correctionRatio;

      // Pause duration: from bolus end to peak time
      const maxRateMlH = cfg.bolusRateMlH || 750;
      const concentration = cfg.bolusConcentration || 10;
      const bolusDurSec = Math.round((Math.ceil(bolusMg) / concentration) / maxRateMlH * 3600);
      if (tempPeak > bolusDurSec) {
        pauseDurationMin = (tempPeak - bolusDurSec) / 60;
      }
    }

    if (bolusMg > 0) {
      // SimTIVA CET rounding: ceil to nearest 1mg
      bolusMg = Math.ceil(bolusMg);
      scheme.push({ type: 'bolus', time: simTime, value: bolusMg });
      const { duration, rate } = plannerBolusDelivery(bolusMg, cfg);
      engine.advance(duration, rate);
      simTime += duration;

      scheme.push({ type: 'rate', time: simTime, value: 0 });
      if (pauseDurationMin != null && pauseDurationMin > 0) {
        engine.advance(pauseDurationMin, 0);
        simTime += pauseDurationMin;
      } else {
        const pauseStep = 1 / 60;
        let cePeak = 0, cePrior = 0;
        while (simTime < startTime + cfg.maxPlanTime) {
          engine.advance(pauseStep, 0);
          simTime += pauseStep;
          const ce = engine.getConcentrations().Ce;
          if (ce > cePeak) { cePeak = ce; cePrior = ce; }
          else if (ce < cePrior - 0.0005) break;
          cePrior = ce;
        }
      }
    }
  }

  // ---- Target decrease: pause until Ce decays ----
  if (currentCe > upperBound) {
    scheme.push({ type: 'rate', time: simTime, value: 0 });
    while (simTime < startTime + cfg.maxPlanTime) {
      engine.advance(cfg.simStep, 0);
      simTime += cfg.simStep;
      if (engine.getConcentrations().Ce <= upperBound) break;
    }
  }

  // ==== Maintenance: SimTIVA deliver_cpt — direct port ====
  // All rate computation uses SimTIVA's eigenstate math (per-second).
  // Rates in cptRates[] are in mg/sec. Converted to mg/min for our events.

  const pkParams = engine.params;
  const { p_udf, p_coef, lambda } = computeUDFs(pkParams);
  const concentration = cfg.bolusConcentration || 10;

  const cptInterval = 120;
  const look_l1 = Math.exp(-lambda[1] * cptInterval);
  const look_l2 = Math.exp(-lambda[2] * cptInterval);
  const look_l3 = Math.exp(-lambda[3] * cptInterval);
  const l1s = Math.exp(-lambda[1]);
  const l2s = Math.exp(-lambda[2]);
  const l3s = Math.exp(-lambda[3]);

  // Build eigenstate at maintenance start.
  // Use Cramer's rule decomposition: sample Cp at 3 future times at rate=0,
  // solve the 3×3 system to get exact eigenstate coefficients.
  // This works for ALL cases: from-zero (engine advanced through bolus+pause),
  // target step-up (engine has existing drug + new bolus), and target decrease
  // (engine has existing drug after decay).
  let ps1 = 0, ps2 = 0, ps3 = 0;

  /**
   * Refit ps1/ps2/ps3 from the current engine state using Cramér's rule.
   * Call this whenever the engine has been advanced and the eigenstate
   * needs to be re-synced to engine reality.
   */
  function refitEigenstate() {
    if (engine.getConcentrations().Cp <= 0.001) {
      ps1 = 0; ps2 = 0; ps3 = 0;
      return;
    }
    const saved2 = engine.getState();
    const t1 = 10, t2 = 60, t3 = 300; // seconds
    engine.advance(t1 / 60, 0); const cp1 = engine.getConcentrations().Cp;
    engine.setState(saved2);
    engine.advance(t2 / 60, 0); const cp2 = engine.getConcentrations().Cp;
    engine.setState(saved2);
    engine.advance(t3 / 60, 0); const cp3 = engine.getConcentrations().Cp;
    engine.setState(saved2);

    const e11 = Math.exp(-lambda[1] * t1), e12 = Math.exp(-lambda[2] * t1), e13 = Math.exp(-lambda[3] * t1);
    const e21 = Math.exp(-lambda[1] * t2), e22 = Math.exp(-lambda[2] * t2), e23 = Math.exp(-lambda[3] * t2);
    const e31 = Math.exp(-lambda[1] * t3), e32 = Math.exp(-lambda[2] * t3), e33 = Math.exp(-lambda[3] * t3);

    const det = e11 * (e22 * e33 - e23 * e32) - e12 * (e21 * e33 - e23 * e31) + e13 * (e21 * e32 - e22 * e31);
    if (Math.abs(det) > 1e-20) {
      ps1 = (cp1 * (e22 * e33 - e23 * e32) - e12 * (cp2 * e33 - cp3 * e23) + e13 * (cp2 * e32 - cp3 * e22)) / det;
      ps2 = (e11 * (cp2 * e33 - cp3 * e23) - cp1 * (e21 * e33 - e23 * e31) + e13 * (e21 * cp3 - cp2 * e31)) / det;
      ps3 = (e11 * (e22 * cp3 - cp2 * e32) - e12 * (e21 * cp3 - cp2 * e31) + cp1 * (e21 * e32 - e22 * e31)) / det;
    } else {
      ps1 = 0; ps2 = 0; ps3 = 0;
    }
  }

  // Initial eigenstate fit at maintenance start
  refitEigenstate();

  const maintTime = simTime;

  // virtual_model: predict Cp at t seconds from eigenstate at zero rate
  function vm(s1, s2, s3, t) {
    const f1 = lambda[1] * t > 100 ? 0 : Math.exp(-lambda[1] * t);
    const f2 = lambda[2] * t > 100 ? 0 : Math.exp(-lambda[2] * t);
    const f3 = lambda[3] * t > 100 ? 0 : Math.exp(-lambda[3] * t);
    return s1 * f1 + s2 * f2 + s3 * f3;
  }

  // First pass: 180 intervals (SimTIVA lines 2035-2081)
  const cptRates = [];
  let testRate = 0;

  // Check if Ce is below target at maintenance start (rate-only step-up)
  const ceAtMaint = engine.getConcentrations().Ce;
  const needsCeBoost = ceAtMaint < ceTarget * 0.95 && !scheme.find(e => e.type === 'bolus');
  // Number of Ce-targeting intervals: enough to get Ce close to target
  const ceBoostIntervals = needsCeBoost ? 3 : 0; // 3 intervals = 6 min of Ce-targeting

  for (let i = 0; i < 180; i++) {
    if (ps1 === 0 && ps2 === 0 && ps3 === 0) {
      testRate = ceTarget / p_udf[cptInterval];
    } else if (i < ceBoostIntervals) {
      // Ce-targeting: find rate where Ce at +5min = target
      // Shorter lookahead than from-zero case for faster approach
      const savedEng = engine.getState();
      let lo = 0, hi = cfg.maxRate;
      for (let iter = 0; iter < 30; iter++) {
        const mid = (lo + hi) / 2;
        engine.setState(savedEng);
        engine.advance(5, mid); // 5-minute Ce-targeting lookahead
        const ce = engine.getConcentrations().Ce;
        if (ce < ceTarget) lo = mid; else hi = mid;
      }
      engine.setState(savedEng);
      // Convert mg/min (engine) → mg/sec (eigenstate)
      testRate = Math.max(0, (lo + hi) / 2) / 60;
      // Advance the engine to keep it in sync for subsequent Ce searches
      engine.advance(cptInterval / 60, testRate * 60);
      // FIX #3: Refit ps1/ps2/ps3 from the engine after each Ce-boost interval.
      // Without this, the eigenstate diverges from engine reality and Cp predictions
      // are wrong for all subsequent Cp-targeting intervals.
      refitEigenstate();
    } else {
      // Cp-targeting: advance 1 sec at testRate, predict Cp at +interval at zero
      const ts1 = ps1 * l1s + p_coef[1] * testRate * (1 - l1s);
      const ts2 = ps2 * l2s + p_coef[2] * testRate * (1 - l2s);
      const ts3 = ps3 * l3s + p_coef[3] * testRate * (1 - l3s);
      const trialCp = vm(ts1, ts2, ts3, cptInterval);
      testRate = ceTarget > trialCp ? (ceTarget - trialCp) / p_udf[cptInterval] : 0;
    }
    cptRates.push(testRate);
    // Advance eigenstate by interval at testRate
    ps1 = ps1 * look_l1 + p_coef[1] * testRate * (1 - look_l1);
    ps2 = ps2 * look_l2 + p_coef[2] * testRate * (1 - look_l2);
    ps3 = ps3 * look_l3 + p_coef[3] * testRate * (1 - look_l3);
  }

  // Second pass: step extraction (SimTIVA lines 1275-1544)
  // Propofol: threshold=0.08, avgfactor=0.667, roundingfactor=360
  // Dynamic threshold/avgfactor based on early maintenance rate magnitude
  // SimTIVA lines 1250-1259: propofol with cpt_rates[5]*360 >= 30 uses 0.08/0.667,
  // lower rates use 0.05/0.62
  const earlyRateMlH = (cptRates[5] || cptRates[0]) * 3600 / concentration;
  const cptThreshold = earlyRateMlH >= 30 ? 0.08 : 0.05;
  const cptAvgFactor = earlyRateMlH >= 30 ? 0.667 : 0.62;
  const rf = 360; // round mg/sec to nearest 1 mL/h
  const rnd = (r) => Math.round(r * rf) / rf;

  let priorTestRate;
  const cptTimes = [];
  let waitPeak = 0;

  // Detect rate pattern: decremental or rise-then-fall (SimTIVA lines 1287-1492)
  if (cptRates[0] > 0 && cptRates[0] >= cptRates[1]) {
    // Decremental: start from interval 1
    priorTestRate = cptRates[1];
    cptTimes.push(1);
    scheme.push({ type: 'rate', time: maintTime, value: rnd(cptRates[1]) * 60 });
  } else if (cptRates[0] > 0 && cptRates[1] > cptRates[0]) {
    // Possible rise-then-fall: find peak
    for (let k = 1; k < 60; k++) {
      if (cptRates[k] > cptRates[k - 1]) {
        waitPeak = k;
      } else {
        break;
      }
    }

    if (waitPeak <= 1) {
      // Very short rise (1 interval) — treat as near-flat, use interval 1
      priorTestRate = cptRates[1];
      cptTimes.push(1);
      scheme.push({ type: 'rate', time: maintTime, value: rnd(cptRates[1]) * 60 });
    } else {
      // Genuine rise-then-fall: average of rates[1] and rates[waitPeak]
      const avgRate = rnd((cptRates[waitPeak] + cptRates[1]) / 2);
      priorTestRate = cptRates[waitPeak];
      cptTimes.push(waitPeak);
      scheme.push({ type: 'rate', time: maintTime, value: avgRate * 60 });
    }
  } else {
    // Flat or zero start
    priorTestRate = cptRates[0];
    cptTimes.push(0);
    scheme.push({ type: 'rate', time: maintTime, value: rnd(cptRates[0]) * 60 });
  }

  // Scan intervals after waitPeak for step changes
  for (let j = Math.max(2, waitPeak + 1); j < 60; j++) {
    if (priorTestRate <= 0) continue;
    const change = (priorTestRate - cptRates[j]) / priorTestRate;

    if (change > cptThreshold) {
      const lastIdx = cptTimes[cptTimes.length - 1];
      const avgRate = (cptRates[lastIdx] - cptRates[j]) * cptAvgFactor + cptRates[j];
      const rounded = rnd(avgRate);
      // Rate starts at the time corresponding to the last emitted interval
      // This is SimTIVA line 1513: relativetime = working_clock + cpt_times[last]*120
      const stepTimeMin = maintTime + lastIdx * cptInterval / 60;
      const prevVal = scheme[scheme.length - 1]?.value || 0;
      // Replace the previous step's rate if same timestamp, otherwise add new
      if (Math.abs(stepTimeMin - (scheme[scheme.length - 1]?.time || 0)) < 0.01) {
        scheme[scheme.length - 1].value = rounded * 60;
      } else if (Math.abs(rounded * 60 - prevVal) > 0.01) {
        scheme.push({ type: 'rate', time: stepTimeMin, value: rounded * 60 });
      }
      cptTimes.push(j);
      priorTestRate = cptRates[j];
    }
  }

  // Final step at j=59
  {
    const lastIdx = cptTimes[cptTimes.length - 1];
    const j = 59;
    const avgRate = (cptRates[lastIdx] - cptRates[j]) * cptAvgFactor + cptRates[j];
    const rounded = rnd(avgRate);
    const stepTimeMin = maintTime + lastIdx * cptInterval / 60;
    const lastVal = scheme[scheme.length - 1]?.value || 0;
    if (Math.abs(rounded * 60 - lastVal) > 0.01) {
      scheme.push({ type: 'rate', time: stepTimeMin, value: rounded * 60 });
    }
  }

  engine.setState(saved);
  return scheme;
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
