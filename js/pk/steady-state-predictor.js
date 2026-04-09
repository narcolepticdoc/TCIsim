/**
 * steady-state-predictor.js — Slope-based plateau detector.
 *
 * Mechanism:
 *   1. Simulate Ce forward from the current engine state at 1-min resolution
 *      for HORIZON + EXIT_HORIZON + SUSTAIN minutes under a constant infusion
 *      rate.
 *   2. At each minute i in [0, HORIZON], check whether the per-minute
 *      relative slope |Ce[i+k+1] − Ce[i+k]| / Ce[i+k] stays below slopeTol
 *      for SUSTAIN consecutive minutes.
 *   3. Return the earliest such i as the time to plateau entry, with
 *      plateauCe = Ce[i] (the Ce at the start of the flat run).
 *   4. After entry, scan forward for the first slope >= slopeTol beyond the
 *      sustained entry window. This is the plateau exit (local plateau).
 *      If no exit is found within the buffer, the plateau is permanent.
 *
 * The 15-min sustained window guards against inflection-point false
 * positives (post-bolus overshoot, V2 refill trough). Under constant input
 * the 4-compartment linear system has negative-real eigenvalues, so once a
 * 15-min flat run appears the slope stays bounded by its envelope
 * thereafter — the first sustained run is well-defined.
 *
 * Exit detection uses single-sample threshold crossing: the PK model's
 * monotone eigenvalue envelopes make single-sample detection reliable,
 * unlike entry where inflection-point false positives require the 15-min
 * sustained guard.
 *
 * Time units: minutes (matching the rest of the codebase). slopeTol is a
 * dimensionless per-minute relative slope (e.g. 0.0010 = 0.10 %/min).
 */

/**
 * Predict when Ce will enter (and optionally exit) a sustained low-slope
 * plateau under a constant infusion rate.
 *
 * @param {Object} engine          PK engine instance
 * @param {Float64Array} startState Engine state to start from
 * @param {number} startTime       Current elapsed time (minutes) — unused in
 *                                 computation; kept for API symmetry.
 * @param {number} rate            Constant infusion rate (mg/min)
 * @param {number} slopeTol        Per-minute relative slope threshold
 *                                 (e.g. 0.0010 = 0.10 %/min)
 * @param {Object} [opts]
 * @param {number} [opts.step=1]         Sample step in minutes
 * @param {number} [opts.horizon=360]    Max plateau-start minute to report
 * @param {number} [opts.sustain=15]     Required flat-run length in minutes
 * @param {number} [opts.exitHorizon=360] Minutes past entry to scan for exit
 * @returns {Object|null}
 *   null if rate <= 0 or slopeTol is out of range.
 *   On success (plateau found):
 *     { plateauCe, timeToSsMin, exitMin, plateauCeMin, plateauCeMax,
 *       noSteadyState: false }
 *     - exitMin: minutes from scan start when plateau ends (null = permanent)
 *     - plateauCeMin/Max: Ce range during the plateau (for chart bounding box)
 *   On failure (no plateau within horizon):
 *     { plateauCe: null, timeToSsMin: null, exitMin: null,
 *       plateauCeMin: null, plateauCeMax: null, noSteadyState: true }
 */
export function predictSteadyState(engine, startState, startTime, rate, slopeTol, opts = {}) {
  if (rate <= 0) return null;
  if (!(slopeTol > 0 && slopeTol < 1)) return null;

  const STEP         = opts.step        ?? 1;    // minutes
  const HORIZON      = opts.horizon     ?? 360;  // latest plateau start we report
  const SUSTAIN      = opts.sustain     ?? 15;   // required flat-run length
  const EXIT_HORIZON = opts.exitHorizon ?? HORIZON; // exit scan range past entry
  const N            = HORIZON + EXIT_HORIZON + SUSTAIN;

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

    if (entryIdx < 0) {
      return {
        plateauCe: null, timeToSsMin: null, exitMin: null,
        plateauCeMin: null, plateauCeMax: null, noSteadyState: true,
      };
    }

    // Exit scan: first slope >= slopeTol after the sustained entry window.
    let exitIdx = -1;
    let ceMin = ce[entryIdx], ceMax = ce[entryIdx];
    for (let j = entryIdx; j < N; j++) {
      ceMin = Math.min(ceMin, ce[j]);
      ceMax = Math.max(ceMax, ce[j]);
      if (j >= entryIdx + SUSTAIN) {
        const base = Math.max(ce[j], EPS);
        const rel  = Math.abs(ce[j + 1] - ce[j]) / base;
        if (rel >= slopeTol) { exitIdx = j; break; }
      }
    }

    return {
      plateauCe:    ce[entryIdx],
      timeToSsMin:  entryIdx,
      exitMin:      exitIdx >= 0 ? exitIdx : null,
      plateauCeMin: ceMin,
      plateauCeMax: ceMax,
      noSteadyState: false,
    };
  } finally {
    engine.setState(savedState);
  }
}
