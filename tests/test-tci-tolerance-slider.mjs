/**
 * test-tci-tolerance-slider.mjs
 *
 * (Formerly test-tci-tolerance-diagnostic — renamed to reflect what it is now:
 * a focused contract test, not the ~200-line diagnostic printer it started as.)
 *
 * Contract test: the "TCI target tolerance" slider (#set-tci-fraction,
 * persisted as tciFraction) is bound to the planner's `ceTolerance` cfg key
 * and actually reaches the correction pass (emulation.js reads it via cfg).
 *
 * History: this started life as a ~200-line diagnostic that printed a full
 * plan table for a ceTolerance sweep plus a legacy `tolerancePct` sweep, but
 * carried only one real assertion. It has been trimmed to that assertion:
 *   1. Sweep `ceTolerance` across realistic values (0.005 … 0.030).
 *   2. Every plan must still reach the target (sanity — a mis-wired knob
 *      could otherwise "differ" by producing a broken plan).
 *   3. The plans must not all be identical — tighter tolerance ⇒ more
 *      maintenance correction, so ≥2 distinct fingerprints proves the knob
 *      is wired through to the planner rather than silently ignored.
 *
 * The old Loop B (`tolerancePct` from Ce=0, which by design has no effect on
 * maintenance) was documentary only and has been removed; its finding lives
 * in TCI-TOLERANCE-ANALYSIS.md §1.
 *
 * Run with: node tests/test-tci-tolerance-slider.mjs
 */

import { calcEleveldParams } from '../js/pk/eleveld.js';
import { createEngine } from '../js/pk/engine.js';
import { planTCISchemeEmulation } from '../js/sim/tci/emulation.js';

const PATIENT = { age: 35, weight: 70, height: 170, male: true, opioid: false };
const CE_TARGET = 3.0;
// Production maxRate = bolusRateMlH×concentration/60 = 750×10/60 = 125 mg/min
// (getPumpSettings, js/util/constants.js). Drive the planner as production does.
const PUMP = { bolusConcentration: 10, bolusRateMlH: 750, maxRate: 125 };

function makeEngine() {
  return createEngine(calcEleveldParams(PATIENT), { skipValidation: true });
}

function baseCfg(extra = {}) {
  return {
    ...PUMP,
    drugId: 'propofol',
    weightKg: PATIENT.weight,
    quantizeInDisplay: false,
    bolusDisplayUnit: null,
    rateDisplayUnit: null,
    ...extra,
  };
}

function runPlanner(cfg) {
  const engine = makeEngine();
  return planTCISchemeEmulation(engine, engine.getState(), 0, CE_TARGET, cfg);
}

/** Replay the scheme to 30 min and return the final Ce. */
function replayFinalCe(scheme, horizonMin = 30) {
  const engine = makeEngine();
  const events = [...scheme].sort((a, b) => a.time - b.time);
  let tNow = 0, currentRate = 0;
  const advance = (dt, rate) => {
    let remaining = dt;
    while (remaining > 1e-9) {
      const step = Math.min(0.05, remaining);
      engine.advance(step, rate);
      tNow += step;
      remaining -= step;
    }
  };
  for (const ev of events) {
    const gap = ev.time - tNow;
    if (gap > 1e-9) advance(gap, currentRate);
    if (ev.type === 'bolus') {
      const duration = Math.max(0.05, (ev.value / PUMP.bolusConcentration / PUMP.bolusRateMlH) * 60);
      advance(duration, ev.value / duration);
    } else if (ev.type === 'rate') {
      currentRate = ev.value;
    }
  }
  if (tNow < horizonMin) advance(horizonMin - tNow, currentRate);
  return engine.getConcentrations().Ce;
}

function fingerprint(scheme) {
  return scheme.map(e => `${e.type}@${e.time.toFixed(6)}=${e.value.toFixed(6)}`).join('|');
}

let passed = 0, failed = 0;
function assert(condition, message) {
  if (condition) { passed++; console.log(`  ✓ ${message}`); }
  else { failed++; console.error(`  ✗ ${message}`); }
}

console.log('\n=== CET emulation — ceTolerance slider wiring ===\n');
console.log(' Patient: 35 y, 70 kg, 170 cm, M, no opioid; Ce target 3.0 μg/mL.\n');

const ceTolerances = [0.005, 0.010, 0.015, 0.020, 0.030];
const fingerprints = new Set();
for (const tol of ceTolerances) {
  const scheme = runPlanner(baseCfg({ ceTolerance: tol }));
  fingerprints.add(fingerprint(scheme));
  const finalCe = replayFinalCe(scheme, 30);
  assert(
    finalCe >= CE_TARGET * 0.95 && finalCe <= CE_TARGET * 1.05,
    `ceTolerance=${tol.toFixed(3)}: plan reaches target (Ce@30=${finalCe.toFixed(3)}, ±5%)`
  );
}

assert(
  fingerprints.size >= 2,
  `ceTolerance changes the plan — ${fingerprints.size} distinct fingerprints across ${ceTolerances.length} tolerances (slider is wired)`
);

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
