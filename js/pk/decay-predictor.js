/**
 * decay-predictor.js — Predicts when Ce will decay to a threshold
 *
 * Given an engine state and a current infusion rate (typically 0 for
 * intermittent bolus mode), finds the elapsed time at which Ce drops
 * to a specified trough concentration.
 *
 * Uses a simple forward search with bisection refinement — Ce decay
 * is monotonic when rate=0, so this is straightforward.
 */

import { predictSteadyStateCe } from './steady-state-predictor.js';

/**
 * Find the time (minutes from startTime) at which Ce decays to the
 * trough threshold.
 * 
 * @param {Object} engine     - PK engine instance
 * @param {Float64Array} startState - Engine state to start from
 * @param {number} startTime  - Current elapsed time (minutes)
 * @param {number} troughCe   - Target trough Ce concentration (μg/mL)
 * @param {number} currentRate - Current infusion rate (mg/min), typically 0
 * @param {Object} [opts]     - Options
 * @param {number} [opts.maxLookahead=480] - Max minutes to search ahead
 * @param {number} [opts.coarseStep=0.5]   - Coarse search step (minutes)
 * @param {number} [opts.tolerance=0.01]   - Bisection tolerance (minutes)
 * @returns {Object} { time: number|null, ceAtTime: number }
 *   time = elapsed minutes when Ce hits trough, or null if never within lookahead
 */
export function predictTroughTime(engine, startState, startTime, troughCe, currentRate, opts = {}) {
  const maxLookahead = opts.maxLookahead ?? 480;
  const coarseStep = opts.coarseStep ?? 0.5;
  const tolerance = opts.tolerance ?? 0.01;

  // Save engine state
  const savedState = engine.getState();
  engine.setState(startState);

  const startCe = engine.getConcentrations().Ce;

  // Scan forward looking for Ce to cross the trough from ABOVE.
  // Ce may start below trough (post-bolus, Ce hasn't peaked yet),
  // rise above it, then decay back down through it. We want that
  // downward crossing, not the initial "already below" state.
  engine.setState(startState);
  let prevCe = startCe;
  let hasBeenAbove = (startCe > troughCe);
  let crossStart = null;
  let crossEnd = null;

  for (let t = coarseStep; t <= maxLookahead; t += coarseStep) {
    engine.advance(coarseStep, currentRate);
    const ce = engine.getConcentrations().Ce;

    if (ce > troughCe) hasBeenAbove = true;

    // Look for downward crossing: Ce was above trough, now at or below
    if (hasBeenAbove && prevCe > troughCe && ce <= troughCe) {
      crossStart = startTime + (t - coarseStep);
      crossEnd = startTime + t;
      break;
    }
    prevCe = ce;
  }

  // If Ce never went above trough at all, it truly is already below
  if (!hasBeenAbove && crossStart === null) {
    engine.setState(savedState);
    return { time: startTime, ceAtTime: startCe };
  }

  if (crossStart === null) {
    // Ce went above trough but never came back down within lookahead
    engine.setState(savedState);
    return { time: null, ceAtTime: prevCe };
  }

  // Bisection refinement within [crossStart, crossEnd]
  let loOffset = crossStart - startTime;
  let hiOffset = crossEnd - startTime;

  // Concentration-space early exit, scaled to the target. An absolute band
  // (this was 1e-4 µg/mL) means something different for every drug: 0.01% of a
  // propofol emergence target, 0.33% of ketamine's, and 33% of fentanyl's. At
  // that width bisection bailed on its first probe, so the answer collapsed
  // onto the 0.5 min coarse grid — the fentanyl and ketamine countdowns sat
  // still for ~30 s and then jumped 30 s. Relative makes the fast path
  // drug-independent; the time tolerance below still governs convergence.
  const ceTol = Math.max(Math.abs(troughCe) * 1e-4, 1e-12);

  for (let iter = 0; iter < 40; iter++) {
    const midOffset = (loOffset + hiOffset) / 2;

    engine.setState(startState);
    engine.advance(midOffset, currentRate);
    const midCe = engine.getConcentrations().Ce;

    if (Math.abs(midCe - troughCe) < ceTol) {
      engine.setState(savedState);
      return { time: startTime + midOffset, ceAtTime: midCe };
    }

    if (midCe > troughCe) {
      loOffset = midOffset;
    } else {
      hiOffset = midOffset;
    }

    if ((hiOffset - loOffset) < tolerance) break;
  }

  const resultOffset = (loOffset + hiOffset) / 2;
  
  // Get final Ce at the result time
  engine.setState(startState);
  engine.advance(resultOffset, currentRate);
  const finalCe = engine.getConcentrations().Ce;

  // Restore engine state
  engine.setState(savedState);

  return { time: startTime + resultOffset, ceAtTime: finalCe };
}


/**
 * Predict trough time accounting for an ongoing infusion rate.
 * 
 * In some scenarios (e.g., ketamine with a background infusion),
 * Ce might not actually decay to the trough if the infusion rate
 * maintains it above threshold. This function handles that case
 * by returning null if Ce stabilises above the trough.
 * 
 * @param {Object} engine
 * @param {Float64Array} startState
 * @param {number} startTime
 * @param {number} troughCe
 * @param {number} currentRate
 * @returns {Object} { time, ceAtTime, willReach: boolean }
 */
export function predictTroughWithRate(engine, startState, startTime, troughCe, currentRate) {
  // If rate > 0, check if steady-state Ce is above trough
  // Steady-state Ce at a given rate can be estimated by running far forward
  if (currentRate > 0) {
    // Analytical steady-state — exact, no simulation needed
    const steadyCe = predictSteadyStateCe(engine, currentRate);
    if (steadyCe != null && steadyCe > troughCe) {
      // Infusion maintains Ce above trough — will never reach it
      return { time: null, ceAtTime: steadyCe, willReach: false };
    }
  }

  const result = predictTroughTime(engine, startState, startTime, troughCe, currentRate);
  return { ...result, willReach: result.time !== null };
}
