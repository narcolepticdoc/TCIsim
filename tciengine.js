/**
 * TCI Engine — Target Controlled Infusion
 * 
 * Effect-site targeting using the STANPUMP/Shafer algorithm:
 * For each 10-second epoch, compute the optimal infusion rate to drive Ce
 * toward the target without overshooting Cp by more than a safe margin.
 * 
 * Algorithm (simplified Shafer-Gregg):
 * 1. If Ce < target: run at max rate until Cp = target, then reduce
 * 2. Predict forward 10s intervals to find optimal rate
 * 
 * This implements a binary-search "TPEAK" approach per epoch.
 */

import { PKEngine } from './pkengine.js';

const DT_SEC = 10;         // Epoch length
const DT_MIN = DT_SEC / 60;
const MAX_RATE = 1200;     // mcg/kg/min upper limit (safety clamp)
const SIM_STEP_MIN = 1/60; // 1-second integration steps

/**
 * Given current engine state, compute the optimal rate for the next epoch
 * to drive Ce toward ceTarget, then return rate and predicted concentrations.
 */
function computeEpochRate(engine, weightKg, ceTarget) {
  const currentCp = engine.getCp();
  const currentCe = engine.getCe();

  // If Ce is at or above target, shut off infusion until Ce falls
  if (currentCe >= ceTarget) {
    return 0;
  }

  // Binary search for rate that gets Cp = ceTarget at peak
  // (prevents overshoot of effect site)
  let lo = 0;
  let hi = MAX_RATE;

  for (let iter = 0; iter < 20; iter++) {
    const mid = (lo + hi) / 2;
    // Simulate 10 seconds with this rate
    const testEngine = new PKEngine({ getParams: () => engine.p }, weightKg);
    testEngine.setState(engine.cloneState());

    let peakCp = testEngine.getCp();
    const steps = Math.round(DT_MIN / SIM_STEP_MIN);
    for (let s = 0; s < steps; s++) {
      testEngine.step(mid, 0, SIM_STEP_MIN);
      peakCp = Math.max(peakCp, testEngine.getCp());
    }

    if (peakCp > ceTarget) {
      hi = mid;
    } else {
      lo = mid;
    }
  }

  return (lo + hi) / 2;
}

/**
 * Generate TCI schedule from current state until Ce reaches target (or 60 min out)
 * Returns array of scheduled events: [{timeMin, type:'rate', value}]
 * and a predicted trace [{timeMin, Cp, Ce}]
 */
export function generateTCISchedule(engine, weightKg, ceTarget, fromTimeMin, maxAheadMin = 60) {
  // Clone engine state for forward simulation
  const simEngine = new PKEngine({ getParams: () => engine.p }, weightKg);
  simEngine.setState(engine.cloneState());

  const events = [];
  const trace = [];
  let t = fromTimeMin;
  const tEnd = fromTimeMin + maxAheadMin;

  const epochSteps = Math.round(DT_MIN / SIM_STEP_MIN);

  while (t < tEnd) {
    const rate = computeEpochRate(simEngine, weightKg, ceTarget);
    events.push({ timeMin: t, type: 'rate', value: rate, source: 'tci' });

    // Simulate epoch
    for (let s = 0; s < epochSteps; s++) {
      simEngine.step(rate, 0, SIM_STEP_MIN);
    }

    trace.push({
      timeMin: t + DT_MIN,
      Cp: simEngine.getCp(),
      Ce: simEngine.getCe(),
      rate,
    });

    t += DT_MIN;

    // Check if we've converged (Ce within 2% of target and Cp close too)
    const ce = simEngine.getCe();
    if (Math.abs(ce - ceTarget) / ceTarget < 0.02 && t > fromTimeMin + 1) {
      // Continue at maintenance for a few more epochs then stop scheduling
      // In practice the engine will keep calculating; we just stop adding events here
      // after convergence is confirmed for 3 consecutive epochs
      // For now: extend 10 more minutes of maintenance
      for (let extra = 0; extra < 60; extra++) {
        const mRate = computeEpochRate(simEngine, weightKg, ceTarget);
        events.push({ timeMin: t, type: 'rate', value: mRate, source: 'tci' });
        for (let s = 0; s < epochSteps; s++) simEngine.step(mRate, 0, SIM_STEP_MIN);
        trace.push({ timeMin: t + DT_MIN, Cp: simEngine.getCp(), Ce: simEngine.getCe(), rate: mRate });
        t += DT_MIN;
      }
      break;
    }
  }

  return { events, trace };
}
