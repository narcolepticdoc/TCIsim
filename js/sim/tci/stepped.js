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
  searchPeakBolus,
  waitForDecay,
  floorMaintenanceRate,
} from './shared.js';

// Tuning for the shared peak-matched bolus search (see shared.js).
const STEPPED_BOLUS_SEARCH = { upperMult: 3, scanHorizon: 15, scanStep: 0.25, tol: 0.01 };

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
    const bolusMg = qBolus(searchPeakBolus(engine, ceTarget, cfg, STEPPED_BOLUS_SEARCH));

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
    simTime = waitForDecay(engine, upperBound, simTime, startTime, scheme, cfg);
  }

  // ---- Step 2: Generate rate steps ----
  // Find the rate that would maintain Ce at target from the current state,
  // run forward, and when Ce drifts out of bounds, recalculate.

  let prevRate = -1;

  for (let step = 0; step < cfg.maxSteps; step++) {
    if (simTime >= startTime + cfg.maxPlanTime) break;

    // Find the rate that holds Ce at target over the next period
    const optimalRate = floorMaintenanceRate(
      qRate(findMaintenanceRate(engine, ceTarget, cfg, step)),
      engine, ceTarget, qRate);

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
