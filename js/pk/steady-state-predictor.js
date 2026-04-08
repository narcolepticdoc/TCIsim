/**
 * steady-state-predictor.js — Predicts time to approach steady-state Ce
 * under a constant infusion rate.
 *
 * Mechanism:
 *   1. Simulate the engine forward until Ce converges to its asymptote.
 *   2. Define a symmetric tolerance band |Ce − asymp| / asymp ≤ (1 − fraction)
 *      around the asymptote.
 *   3. Forward-scan at 0.5-min resolution and return the first time after
 *      which Ce stays inside the band for the remainder of the scan.
 *
 * Works regardless of whether Ce starts below, above, or transiently
 * overshoots the asymptote — a 4-compartment linear system with negative
 * real eigenvalues always eventually settles into the band and stays there.
 *
 * Time units: minutes (matching the rest of the codebase).
 */

/**
 * Predict when Ce will settle into a (1 − fraction) tolerance band around
 * the asymptotic Ce under a constant infusion rate.
 *
 * @param {Object} engine          PK engine instance
 * @param {Float64Array} startState Engine state to start from
 * @param {number} startTime       Current elapsed time (minutes)
 * @param {number} rate            Constant infusion rate (mg/min)
 * @param {number} fraction        0.9–0.99 — "X% of target" tolerance
 * @param {Object} [opts]
 * @param {number} [opts.scanStep=0.5]      Forward-scan step in minutes
 * @param {number} [opts.maxScanMin=2880]   Hard cap on forward-scan horizon (48 h
 *                                          covers 99% for propofol's slow V3)
 * @param {number} [opts.asympHorizon=60]   Initial horizon for asymptote search (min)
 * @param {number} [opts.asympDoublings=10] Max horizon doublings
 * @param {number} [opts.asympRelTol=1e-6]  Relative tolerance for asymptote convergence
 * @returns {Object|null}
 *   null if rate <= 0 or if an asymptote < epsilon is found (e.g. rate so
 *   small that "steady state" is indistinguishable from zero).
 *   Otherwise: { ssCeAsymptote, timeToSsMin }
 */
export function predictSteadyState(engine, startState, startTime, rate, fraction, opts = {}) {
  if (rate <= 0) return null;
  if (!(fraction > 0 && fraction < 1)) return null;

  const scanStep       = opts.scanStep       ?? 0.5;
  const maxScanMin     = opts.maxScanMin     ?? 2880;
  const asympHorizon0  = opts.asympHorizon   ?? 60;
  const asympDoublings = opts.asympDoublings ?? 10;
  const asympRelTol    = opts.asympRelTol    ?? 1e-6;

  // Save engine state up front; restore in finally.
  const savedState = engine.getState();

  try {
    // ── Step 1: compute asymptotic Ce by doubling the horizon until it stops moving.
    engine.setState(startState);
    let horizon = asympHorizon0;
    engine.advance(horizon, rate);
    let prevCe = engine.getConcentrations().Ce;
    let ssCeAsymptote = prevCe;

    for (let k = 0; k < asympDoublings; k++) {
      engine.advance(horizon, rate);          // advance by another `horizon` minutes
      horizon *= 2;                           // doubling lives in the next iteration
      const ce = engine.getConcentrations().Ce;
      const rel = Math.abs(ce - prevCe) / Math.max(Math.abs(ce), 1e-9);
      prevCe = ce;
      ssCeAsymptote = ce;
      if (rel < asympRelTol) break;
    }

    // Guard: asymptote too small to meaningfully define a band.
    if (ssCeAsymptote <= 1e-9) return null;

    // ── Step 2: define the tolerance band.
    const tolerance = 1 - fraction;
    const band = tolerance * ssCeAsymptote;

    // ── Step 3: already-inside-band check at t = startTime.
    engine.setState(startState);
    const startCe = engine.getConcentrations().Ce;
    if (Math.abs(startCe - ssCeAsymptote) <= band) {
      return { ssCeAsymptote, timeToSsMin: 0 };
    }

    // ── Step 4: forward scan. Record the greatest index where Ce was outside
    //           the band. "Time to SS" = (lastOutside + 1) * scanStep, i.e.
    //           the first sample after which Ce stays inside the band.
    engine.setState(startState);
    let lastOutside = -1;
    const nSteps = Math.floor(maxScanMin / scanStep);
    for (let i = 1; i <= nSteps; i++) {
      engine.advance(scanStep, rate);
      const ce = engine.getConcentrations().Ce;
      if (Math.abs(ce - ssCeAsymptote) > band) {
        lastOutside = i;
      }
    }

    if (lastOutside < 0) {
      // Never outside the band — already there.
      return { ssCeAsymptote, timeToSsMin: 0 };
    }

    const lastOutsideTime = lastOutside * scanStep;
    if (lastOutsideTime >= maxScanMin - scanStep) {
      // Horizon exhausted; Ce is still outside the band at the last sample.
      // Report the scan horizon as a lower bound.
      return { ssCeAsymptote, timeToSsMin: maxScanMin };
    }

    return { ssCeAsymptote, timeToSsMin: (lastOutside + 1) * scanStep };
  } finally {
    engine.setState(savedState);
  }
}
