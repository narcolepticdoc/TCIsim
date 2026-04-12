/**
 * tci/cet-conservative.js — CET Conservative (SimTIVA-style) planner.
 *
 * Uses SimTIVA's rate_corr_factor to reduce the bolus by ~9%,
 * and SimTIVA's analytical peak time to determine when to start
 * maintenance. Produces gentler hemodynamics at the cost of
 * slightly slower onset.
 *
 * Validated against SimTIVA output within 1.3%.
 */

import { computeSimTIVACETBolus } from '../simtiva-reference.js';
import { DEFAULT_SCHEME_CONFIG, makeQuantizers } from './shared.js';
import { planTCISchemeCET, calculateCETBolus } from './cet.js';

export function planTCISchemeCETConservative(engine, startState, startTime, ceTarget, config = {}) {
  const cfg = { ...DEFAULT_SCHEME_CONFIG, ...config };
  const { qBolus } = makeQuantizers(cfg);

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
    bolusMg = qBolus(simtiva.bolusMg);
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
    bolusMg = qBolus(exactBolus * correctionRatio);
    pauseDurationMin = null; // use forward scan (peak time differs with existing drug)
  }

  engine.setState(startState); // restore before passing to CET planner
  return planTCISchemeCET(engine, startState, startTime, ceTarget, config,
    bolusMg, pauseDurationMin);
}
