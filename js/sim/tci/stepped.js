/**
 * tci/stepped.js — Stepped TCI planner.
 *
 * Conservative gradual approach. Small bolus targeting peak Ce = target,
 * then stepped maintenance rates. Slow onset (~8-10 min to 95%) but low
 * Cp overshoot.
 */

import {
  DEFAULT_SCHEME_CONFIG,
  makeQuantizers,
  plannerBolusDelivery,
  appendTerminalRates,
  findMaintenanceRate,
} from './shared.js';

/**
 * Generate a clinician-feasible TCI scheme.
 *
 * @param {Object} engine      - PK engine instance
 * @param {Float64Array} startState - Engine state to start from
 * @param {number} startTime   - Simulation time (minutes)
 * @param {number} ceTarget    - Desired effect-site concentration (μg/mL)
 * @param {import('./shared.js').TCISchemeConfig} [config] - Scheme configuration
 * @returns {Array<{type:string, time:number, value:number}>}
 *          Scheme events: bolus + rate steps
 */
export function planTCIScheme(engine, startState, startTime, ceTarget, config = {}) {
  const cfg = {
    ...DEFAULT_SCHEME_CONFIG,
    maxPlanTime: 480,   // 8 hours (default was 120 min) — allows re-evaluation past V3 equilibration
    maxSteps: 12,       // more steps for the longer horizon (default was 8)
    ...config,
  };
  const { qBolus, qRate } = makeQuantizers(cfg);
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
    const bolusMg = qBolus(calculateLoadingBolus(engine, ceTarget, cfg));

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
    let optimalRate = qRate(findMaintenanceRate(engine, ceTarget, cfg, step));

    // Maintenance should never pause — if rate search returns ~0 but Ce
    // is still substantial, use a minimal rate and let the next step correct
    if (optimalRate < 0.001 && engine.getConcentrations().Ce > ceTarget * 0.5) {
      optimalRate = qRate(0.001);
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

  // Append terminal rates for long-term V3 equilibration
  appendTerminalRates(engine, ceTarget, simTime, scheme, cfg);

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
