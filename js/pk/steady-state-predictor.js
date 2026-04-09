/**
 * steady-state-predictor.js — Slope-based plateau detector with band exit.
 *
 * Entry detection (slope-based):
 *   1. Simulate Ce forward from the current engine state at 1-min resolution
 *      under a constant infusion rate.
 *   2. At each minute i in [0, HORIZON], check whether the per-minute
 *      relative slope |Ce[i+k+1] − Ce[i+k]| / Ce[i+k] stays below slopeTol
 *      for SUSTAIN consecutive minutes.
 *   3. The earliest such i is the plateau entry. plateauCe = Ce[i].
 *
 * Exit detection (band-based):
 *   4. After entry + SUSTAIN, scan forward for the first minute where
 *      Ce departs a ±exitBandPct band around plateauCe:
 *        |Ce[j] − plateauCe| / plateauCe > exitBandPct
 *      This is drift-proof: no matter how slowly Ce creeps, once it
 *      exceeds the band the plateau is over.
 *
 * The 15-min sustained window guards against inflection-point false
 * positives (post-bolus overshoot, V2 refill trough). The exit scan
 * skips the SUSTAIN window (already validated as flat at entry).
 *
 * Time units: minutes (matching the rest of the codebase). slopeTol is a
 * dimensionless per-minute relative slope (e.g. 0.0010 = 0.10 %/min).
 * exitBandPct is a fractional band width (e.g. 0.05 = ±5%).
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
 * @param {number} slopeTol        Per-minute relative slope threshold for
 *                                 entry detection (e.g. 0.0010 = 0.10 %/min)
 * @param {Object} [opts]
 * @param {number} [opts.step=1]          Sample step in minutes
 * @param {number} [opts.horizon=360]     Max plateau-start minute to report
 * @param {number} [opts.sustain=15]      Required flat-run length in minutes
 * @param {number} [opts.exitHorizon=360] Minutes past entry to scan for exit
 * @param {number} [opts.exitBandPct=0.05] Fractional ± band for exit (0.05 = ±5%)
 * @returns {Object|null}
 *   null if rate <= 0 or slopeTol is out of range.
 *   On success (plateau found):
 *     { plateauCe, timeToSsMin, exitMin, bandLow, bandHigh,
 *       noSteadyState: false }
 *     - exitMin: minutes from scan start when Ce leaves the band (null = permanent)
 *     - bandLow/bandHigh: the ± band bounds (plateauCe × (1 ∓ exitBandPct))
 *   On failure (no plateau within horizon):
 *     { plateauCe: null, timeToSsMin: null, exitMin: null,
 *       bandLow: null, bandHigh: null, noSteadyState: true }
 */
export function predictSteadyState(engine, startState, startTime, rate, slopeTol, opts = {}) {
  if (rate <= 0) return null;
  if (!(slopeTol > 0 && slopeTol < 1)) return null;

  const STEP          = opts.step         ?? 1;     // minutes
  const HORIZON       = opts.horizon      ?? 360;   // latest plateau start we report
  const SUSTAIN       = opts.sustain      ?? 15;    // required flat-run length
  const EXIT_HORIZON  = opts.exitHorizon  ?? HORIZON;
  const EXIT_BAND_PCT = opts.exitBandPct  ?? 0.05;  // ±5% default
  const N             = HORIZON + EXIT_HORIZON + SUSTAIN;

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
    // Entry scan: earliest minute i in [0, HORIZON] where the per-minute
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
        bandLow: null, bandHigh: null, noSteadyState: true,
      };
    }

    // Exit scan: first minute Ce departs the ±exitBandPct band around plateauCe.
    // Starts after the sustained entry window (already validated as flat).
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
      plateauCe:   pCe,
      timeToSsMin: entryIdx,
      exitMin:     exitIdx >= 0 ? exitIdx : null,
      bandLow,
      bandHigh,
      noSteadyState: false,
    };
  } finally {
    engine.setState(savedState);
  }
}
