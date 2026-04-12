/**
 * tci/cet.js — CET (Ce-targeting) TCI planner.
 *
 * SimTIVA-style fast-onset planner with exact Ce targeting.
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
 */

import {
  DEFAULT_SCHEME_CONFIG,
  makeQuantizers,
  plannerBolusDelivery,
  appendTerminalRates,
  findMaintenanceRate,
} from './shared.js';

/**
 * Output: same format as planTCIScheme — array of {type, time, value} events.
 *
 * @param {Object} engine      - PK engine instance
 * @param {Float64Array} startState - Engine state to start from
 * @param {number} startTime   - Simulation time (minutes)
 * @param {number} ceTarget    - Desired effect-site concentration (μg/mL)
 * @param {import('./shared.js').TCISchemeConfig} [config] - Scheme configuration
 * @param {number|null} [bolusOverrideMg] - Pre-computed bolus (e.g. from CET-Conservative)
 * @param {number|null} [pauseDurationMin] - Pre-computed pause (analytical)
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
    rateStablePct: 0.001,      // 0.1% — prevents premature break before V3 equilibrates (was 1%)
    tolerancePct: 0.03,        // ±3% Ce band for drift detection
    rateChangeThreshold: 0.08, // 8% rate change to trigger new step (SimTIVA uses 5-8%)
    minStepDuration: 2.0,      // 2 min minimum per step
    maxPlanTime: 720,          // 12 hours (was 360 min) — covers V3 equilibration
    initialLookAhead: derivedLookAhead,
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

  // ---- Target increase ----
  // Large deficit (Ce < 80% of target): bolus → pause → maintenance
  // Small deficit (Ce 80-95% of target): skip bolus, just adjust rate
  const ceDeficitRatio = currentCe / ceTarget;
  const needsBolus = currentCe < lowerBound && ceDeficitRatio < 0.8;

  if (needsBolus) {
    // When delegated from CET-Conservative, bolusOverrideMg is already
    // quantized — don't double-quantize. Otherwise snap here.
    const bolusMg = bolusOverrideMg != null
      ? bolusOverrideMg
      : qBolus(calculateCETBolus(engine, ceTarget, cfg));

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
  let currentRate = qRate(findMaintenanceRate(engine, ceTarget, cfg, 0));
  if (currentRate < 0.001 && engine.getConcentrations().Ce > ceTarget * 0.5) {
    currentRate = qRate(0.001);
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
    const optimalNow = qRate(findMaintenanceRate(engine, ceTarget, cfg, stepIdx));

    const rateChange = currentRate > 0.001
      ? Math.abs(optimalNow - currentRate) / currentRate
      : (optimalNow > 0.001 ? 1 : 0);

    if (rateChange > rateChangeThresh) {
      currentRate = optimalNow > 0.001 ? optimalNow : qRate(0.001);
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

  // Append terminal rates for long-term V3 equilibration
  appendTerminalRates(engine, ceTarget, simTime, scheme, cfg);

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
 *
 * Exported so cet-conservative.js can call it for the "existing drug"
 * branch where an analytical formula isn't available.
 */
export function calculateCETBolus(engine, ceTarget, cfg) {
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
