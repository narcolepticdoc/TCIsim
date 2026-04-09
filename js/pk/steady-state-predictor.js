/**
 * steady-state-predictor.js — Slope-based plateau detector.
 *
 * Mechanism:
 *   1. Simulate Ce forward from the current engine state at 1-min resolution
 *      for HORIZON + SUSTAIN minutes under a constant infusion rate.
 *   2. At each minute i in [0, HORIZON], check whether the per-minute
 *      relative slope |Ce[i+k+1] − Ce[i+k]| / Ce[i+k] stays below slopeTol
 *      for SUSTAIN consecutive minutes.
 *   3. Return the earliest such i as the time to steady state, with
 *      plateauCe = Ce[i] (the Ce at the start of the flat run).
 *
 * The 15-min sustained window guards against inflection-point false
 * positives (post-bolus overshoot, V2 refill trough). Under constant input
 * the 4-compartment linear system has negative-real eigenvalues, so once a
 * 15-min flat run appears the slope stays bounded by its envelope
 * thereafter — the first sustained run is well-defined.
 *
 * Time units: minutes (matching the rest of the codebase). slopeTol is a
 * dimensionless per-minute relative slope (e.g. 0.0010 = 0.10 %/min).
 */

/**
 * Predict when Ce will enter a sustained low-slope plateau under a constant
 * infusion rate.
 *
 * @param {Object} engine          PK engine instance
 * @param {Float64Array} startState Engine state to start from
 * @param {number} startTime       Current elapsed time (minutes) — unused in
 *                                 computation; kept for API symmetry.
 * @param {number} rate            Constant infusion rate (mg/min)
 * @param {number} slopeTol        Per-minute relative slope threshold
 *                                 (e.g. 0.0010 = 0.10 %/min)
 * @param {Object} [opts]
 * @param {number} [opts.step=1]      Sample step in minutes
 * @param {number} [opts.horizon=360] Max plateau-start minute to report
 * @param {number} [opts.sustain=15]  Required flat-run length in minutes
 * @returns {Object|null}
 *   null if rate <= 0 or slopeTol is out of range.
 *   { plateauCe, timeToSsMin, noSteadyState: false } on success.
 *   { plateauCe: null, timeToSsMin: null, noSteadyState: true } if no
 *   sustained flat run is found within the horizon.
 */
export function predictSteadyState(engine, startState, startTime, rate, slopeTol, opts = {}) {
  if (rate <= 0) return null;
  if (!(slopeTol > 0 && slopeTol < 1)) return null;

  const STEP    = opts.step    ?? 1;    // minutes
  const HORIZON = opts.horizon ?? 360;  // latest plateau start we report
  const SUSTAIN = opts.sustain ?? 15;   // required flat-run length
  const N       = HORIZON + SUSTAIN;    // 375 samples after ce[0]

  // Save engine state up front; restore in finally.
  const savedState = engine.getState();

  try {
    engine.setState(startState);
    const ce = new Float64Array(N + 1);
    ce[0] = engine.getConcentrations().Ce;
    for (let i = 1; i <= N; i++) {
      engine.advance(STEP, rate);        // expm(A·STEP) is cached after first call
      ce[i] = engine.getConcentrations().Ce;
    }

    const EPS = 1e-9;
    // Scan for the earliest minute i in [0, HORIZON] where the per-minute
    // relative slope stays < slopeTol for SUSTAIN consecutive minutes.
    outer:
    for (let i = 0; i <= HORIZON; i++) {
      for (let k = 0; k < SUSTAIN; k++) {
        const base = Math.max(ce[i + k], EPS);
        const rel  = Math.abs(ce[i + k + 1] - ce[i + k]) / base;
        if (rel >= slopeTol) continue outer;
      }
      return { plateauCe: ce[i], timeToSsMin: i, noSteadyState: false };
    }
    return { plateauCe: null, timeToSsMin: null, noSteadyState: true };
  } finally {
    engine.setState(savedState);
  }
}
