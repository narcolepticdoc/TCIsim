/**
 * steady-state-predictor.js — Analytical steady-state + slope-reversal plateau.
 *
 * Two independent predictors for manual-mode constant infusion:
 *
 * 1. Analytical Steady State — computes true Ce_ss via −A⁻¹·B·rate,
 *    then forward-simulates to find time to reach 95% of Ce_ss.
 *    Strategic: "where is this infusion taking me?"
 *
 * 2. Plateau Detection — slope-based entry (sustained low-slope window)
 *    with mandatory slope reversal. A plateau is a true local equilibrium
 *    where forces temporarily balance and then reverse. Monotonic approach
 *    to steady state is NOT a plateau.
 *    Tactical: "Ce has temporarily stabilized — how long?"
 *
 * Time units: minutes (matching the rest of the codebase). slopeTol is a
 * dimensionless per-minute relative slope (e.g. 0.0010 = 0.10 %/min).
 * exitBandPct is a fractional band width (e.g. 0.05 = ±5%).
 */

import { inv4, mulVec4 } from '../util/math.js';

/** Fraction of Ce_ss at which we declare "reached steady state". */
const SS_FRACTION = 0.95;

/**
 * Compute the true analytical Ce at steady state under constant infusion.
 *
 *   x_ss = −A⁻¹ · B · rate   →   Ce_ss = x_ss[3]
 *
 * Pure matrix math — no state mutation, no simulation.
 *
 * @param {Object} engine - PK engine instance (for getSystemMatrix)
 * @param {number} rate   - Constant infusion rate (mg/min)
 * @returns {number|null}   Ce_ss (mcg/mL), or null if rate ≤ 0 or A is singular
 */
export function predictSteadyStateCe(engine, rate) {
  if (rate <= 0) return null;

  const A = engine.getSystemMatrix();
  const Ainv = inv4(A);
  if (!Ainv) return null;

  // B = [1, 0, 0, 0]ᵀ — column 0 of −A⁻¹ times rate
  // x_ss[i] = −Ainv[i][0] * rate
  const ceSS = -Ainv[3 * 4 + 0] * rate;
  return ceSS > 0 ? ceSS : null;
}

/**
 * Predict time to reach 95% of analytical steady-state Ce under constant
 * infusion. Forward-simulates at 1-min resolution.
 *
 * @param {Object} engine         PK engine instance
 * @param {Float64Array} startState Engine state to start from
 * @param {number} rate           Constant infusion rate (mg/min)
 * @param {Object} [opts]
 * @param {number} [opts.step=1]      Sample step in minutes
 * @param {number} [opts.horizon=360] Max minutes to simulate
 * @returns {Object|null}
 *   null if rate ≤ 0 or Ce_ss cannot be computed.
 *   { ceSS, timeToSsMin, reachable }
 *     - ceSS: analytical Ce_ss (mcg/mL)
 *     - timeToSsMin: minutes until |Ce − Ce_ss|/Ce_ss ≤ 0.05 (0 if already there)
 *     - reachable: true if reached within horizon
 */
export function predictTimeToSteadyState(engine, startState, rate, opts = {}) {
  const ceSS = predictSteadyStateCe(engine, rate);
  if (ceSS === null) return null;

  const STEP    = opts.step    ?? 1;
  const HORIZON = opts.horizon ?? 360;
  const TOL     = 1 - SS_FRACTION;   // 0.05

  const savedState = engine.getState();
  try {
    engine.setState(startState);

    // Pre-compute Ce at each minute
    const ce = new Float64Array(HORIZON + 1);
    ce[0] = engine.getConcentrations().Ce;
    for (let i = 1; i <= HORIZON; i++) {
      engine.advance(STEP, rate);
      ce[i] = engine.getConcentrations().Ce;
    }

    // Find the last minute that's OUTSIDE the 5% band.
    // The minute after that is when Ce truly settles at SS.
    // This avoids false positives from transient crossings
    // (e.g. Ce passing through the band on its way down,
    // undershooting, then slowly climbing back).
    let lastOutside = -1;
    for (let i = HORIZON; i >= 0; i--) {
      if (Math.abs(ce[i] - ceSS) / ceSS > TOL) {
        lastOutside = i;
        break;
      }
    }

    if (lastOutside === -1) {
      // Ce was inside the band for the entire horizon
      return { ceSS, timeToSsMin: 0, reachable: true };
    }

    if (lastOutside === HORIZON) {
      // Ce never settled — still outside at the end
      return { ceSS, timeToSsMin: null, reachable: false };
    }

    // Ce settled at lastOutside + 1
    return { ceSS, timeToSsMin: lastOutside + 1, reachable: true };
  } finally {
    engine.setState(savedState);
  }
}

/**
 * Predict when Ce will enter (and optionally exit) a local plateau with
 * slope reversal under a constant infusion rate.
 *
 * A plateau requires:
 *   1. Entry: sustained low-slope window (SUSTAIN consecutive minutes with
 *      per-minute relative slope below slopeTol). Entry is marked at the
 *      START of the sustained window.
 *   2. Slope reversal: the direction of Ce change before entry must differ
 *      from the direction after the sustained window.
 *   3. Exit: Ce departs a ±exitBandPct band around the entry Ce.
 *
 * If no slope reversal is detected (Ce is just monotonically approaching
 * steady state), noPlateau is true.
 *
 * @param {Object} engine          PK engine instance
 * @param {Float64Array} startState Engine state to start from
 * @param {number} rate            Constant infusion rate (mg/min)
 * @param {number} slopeTol        Per-minute relative slope threshold
 * @param {Object} [opts]
 * @param {number} [opts.step=1]          Sample step in minutes
 * @param {number} [opts.horizon=360]     Max plateau-start minute to report
 * @param {number} [opts.sustain=15]      Required flat-run length in minutes
 * @param {number} [opts.exitHorizon=360] Minutes past entry to scan for exit
 * @param {number} [opts.exitBandPct=0.05] Fractional ± band for exit
 * @returns {Object|null}
 *   null if rate ≤ 0 or slopeTol is out of range.
 *   { plateauCe, entryMin, exitMin, bandLow, bandHigh, noPlateau }
 */
export function predictPlateau(engine, startState, rate, slopeTol, opts = {}) {
  if (rate <= 0) return null;
  if (!(slopeTol > 0 && slopeTol < 1)) return null;

  const STEP          = opts.step         ?? 1;
  const HORIZON       = opts.horizon      ?? 360;
  const SUSTAIN       = opts.sustain      ?? 15;
  const EXIT_HORIZON  = opts.exitHorizon  ?? HORIZON;
  const EXIT_BAND_PCT = opts.exitBandPct  ?? 0.05;
  const N             = HORIZON + EXIT_HORIZON + SUSTAIN;

  const noPlateauResult = {
    plateauCe: null, entryMin: null, exitMin: null,
    bandLow: null, bandHigh: null, noPlateau: true,
  };

  const savedState = engine.getState();
  try {
    engine.setState(startState);
    const ce = new Float64Array(N + 1);
    ce[0] = engine.getConcentrations().Ce;
    for (let i = 1; i <= N; i++) {
      engine.advance(STEP, rate);
      ce[i] = engine.getConcentrations().Ce;
    }

    const EPS = 1e-9;

    // Entry scan: earliest minute i in [0, HORIZON] where the per-minute
    // relative slope stays < slopeTol for SUSTAIN consecutive minutes.
    // entryIdx is the START of the sustained window.
    let entryIdx = -1;
    outer:
    for (let i = 0; i <= HORIZON; i++) {
      for (let k = 0; k < SUSTAIN; k++) {
        const base = Math.max(ce[i + k], EPS);
        const rel  = Math.abs(ce[i + k + 1] - ce[i + k]) / base;
        if (rel >= slopeTol) continue outer;
      }
      entryIdx = i;
      break;
    }

    if (entryIdx < 0) return noPlateauResult;

    // Slope reversal check: compare direction before entry vs after the
    // sustained window. If no reversal, this is just monotonic SS approach.
    //
    // Pre-entry: direction of approach into the flat window.
    const lookback = Math.max(0, entryIdx - SUSTAIN);
    const preDirection  = ce[entryIdx] - ce[lookback];

    // Post-entry: scan past the sustained window for the first minute
    // where Ce moves in the opposite direction from pre-entry.
    // The reversal may occur gradually (V3 equilibration causes a slow
    // turnaround), so we scan up to EXIT_HORIZON minutes past entry.
    const postStart = entryIdx + SUSTAIN;
    let hasReversal = false;
    const DIR_EPS = EPS;
    if (Math.abs(preDirection) > DIR_EPS) {
      const preRising = preDirection > 0;
      for (let j = postStart + 1; j <= Math.min(postStart + EXIT_HORIZON, N); j++) {
        const delta = ce[j] - ce[postStart];
        if (Math.abs(delta) <= DIR_EPS) continue;
        if ((preRising && delta < -DIR_EPS) || (!preRising && delta > DIR_EPS)) {
          hasReversal = true;
          break;
        }
        // If delta is in the same direction as pre, no reversal yet but
        // keep scanning — the turnaround might happen later.
      }
    }

    if (!hasReversal) return noPlateauResult;

    // Exit scan: first minute Ce departs the ±exitBandPct band.
    const pCe     = ce[entryIdx];
    const bandLow  = pCe * (1 - EXIT_BAND_PCT);
    const bandHigh = pCe * (1 + EXIT_BAND_PCT);
    let exitIdx = -1;
    for (let j = entryIdx + SUSTAIN; j <= N; j++) {
      if (ce[j] < bandLow || ce[j] > bandHigh) {
        exitIdx = j;
        break;
      }
    }

    return {
      plateauCe: pCe,
      entryMin:  entryIdx,
      exitMin:   exitIdx >= 0 ? exitIdx : null,
      bandLow,
      bandHigh,
      noPlateau: false,
    };
  } finally {
    engine.setState(savedState);
  }
}
