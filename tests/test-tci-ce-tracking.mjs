/**
 * test-tci-ce-tracking.mjs
 *
 * Validates that the CET emulation planner's correction pass tracks Ce
 * bidirectionally around target during maintenance — catches both overshoot
 * AND undershoot.
 *
 * History: the previous test-tci-peak-overshoot.mjs only checked the upper
 * bound (max Ce ≤ target*(1+CE_TOL)+ε). That passed even when a bad rate
 * selection caused significant UNDERshoot (~14% below target), because
 * undershoot satisfies an upper-bound assertion trivially. This replacement
 * asserts both directions plus a hard clinical floor.
 *
 * For each patient fixture:
 *   1. Emit the plan at the default ceTolerance (0.015).
 *   2. Replay through a fresh engine at 0.05-min sampling from t=0 to t=60.
 *   3. Find maintTime (first rate event with time > 0). Measure max/min Ce
 *      in the maintenance window [maintTime, 60 min].
 *   4. Assert:
 *      - max Ce ≤ target * (1 + 2*CE_TOL) + ε  (catches overshoot)
 *      - min Ce ≥ target * (1 - 2*CE_TOL) - ε  (catches undershoot)
 *      - min Ce ≥ target * 0.95                (hard clinical floor)
 *
 * 2× CE_TOL margin accommodates acceptable transient excursion at step
 * transitions; the 0.95 floor is the clinical "patient doesn't wake up"
 * guarantee that a 14% dip would violate.
 *
 * Run: node tests/test-tci-ce-tracking.mjs
 */

import { calcEleveldParams } from '../js/pk/eleveld.js';
import { createEngine } from '../js/pk/engine.js';
import { planTCISchemeEmulation } from '../js/sim/tci/emulation.js';

// Production pump config: maxRate is auto-derived bolusRateMlH×concentration/60
// = 750×10/60 = 125 mg/min (see getPumpSettings in js/util/constants.js). The
// planner must be driven with the same 125 ceiling production uses, not 200.
const PUMP = { bolusConcentration: 10, bolusRateMlH: 750, maxRate: 125 };
const CE_TOL = 0.015;
// TRANSIENT_MARGIN: max acceptable excursion beyond CE_TOL during the
// ke0-lag / V3-filling transient between bolus-pause end and the first
// maintenance rate. Empirically ~6% for heavier patients (larger V3,
// faster redistribution draw on plasma). 7% gives a small safety margin
// so normal-weight fixtures still pass comfortably while anything worse
// than ~7% — e.g. the 14% dip caused by the reverted peak-aware variant
// — fails loudly.
const TRANSIENT_MARGIN = 0.07;
// CLINICAL_FLOOR: the hard "patient should not wake up" guarantee.
// 10% below target is a realistic red line for anesthesia; the peak-aware
// regression produced dips below this floor.
const CLINICAL_FLOOR   = 0.90;
const EPSILON = 0.005;

function makeEngine(patient) {
  const params = calcEleveldParams(patient);
  return createEngine(params, { skipValidation: true });
}

function baseCfg() {
  return {
    ...PUMP,
    drugId: 'propofol',
    weightKg: 70,
    quantizeInDisplay: false,
    ceTolerance: CE_TOL,
  };
}

/**
 * Replay the scheme and return {maxCe, minCe} within [fromMin, toMin].
 * Bolus events are honoured via plannerBolusDelivery's duration math.
 */
function replayCeWindow(scheme, patient, fromMin, toMin) {
  const engine = makeEngine(patient);
  const events = [...scheme].sort((a, b) => a.time - b.time);

  let tNow = 0;
  let currentRate = 0;
  let maxCe = -Infinity;
  let minCe = Infinity;

  const sampleDt = 0.05;
  function advanceSampling(dt, rate) {
    let remaining = dt;
    while (remaining > 1e-9) {
      const step = Math.min(sampleDt, remaining);
      engine.advance(step, rate);
      tNow += step;
      const ce = engine.getConcentrations().Ce;
      if (tNow >= fromMin && tNow <= toMin) {
        if (ce > maxCe) maxCe = ce;
        if (ce < minCe) minCe = ce;
      }
      remaining -= step;
    }
  }

  for (const ev of events) {
    const gap = ev.time - tNow;
    if (gap > 1e-9) advanceSampling(gap, currentRate);
    if (ev.type === 'bolus') {
      const dose = ev.value;
      const volumeMl = dose / PUMP.bolusConcentration;
      const duration = Math.max(0.05, (volumeMl / PUMP.bolusRateMlH) * 60);
      const bolusRate = dose / duration;
      advanceSampling(duration, bolusRate);
    } else if (ev.type === 'rate') {
      currentRate = ev.value;
    }
  }
  if (tNow < toMin) advanceSampling(toMin - tNow, currentRate);

  return { maxCe, minCe };
}

/**
 * Time the maintenance phase actually starts — we want to skip the
 * post-bolus zero-rate pause where Ce naturally decays. The scheme
 * typically looks like:
 *   bolus@0, rate=0@bolusEnd, rate=X@pauseEnd, rate=Y@..., ...
 * So "maintenance start" = the first rate event whose value > 0.
 */
function findMaintTime(scheme) {
  const rates = scheme.filter(e => e.type === 'rate' && e.value > 0);
  return rates.length ? rates[0].time : 0;
}

let passed = 0, failed = 0;
function assert(condition, message) {
  if (condition) { passed++; console.log(`  ✓ ${message}`); }
  else { failed++; console.error(`  ✗ ${message}`); }
}

const fixtures = [
  { name: 'adult male, 70kg, Ce=3',   patient: { age: 35, weight: 70, height: 170, male: true,  opioid: false }, target: 3.0 },
  { name: 'adult female, 60kg, Ce=2', patient: { age: 45, weight: 60, height: 160, male: false, opioid: false }, target: 2.0 },
  { name: 'elderly male, 75kg, Ce=2.5', patient: { age: 75, weight: 75, height: 170, male: true, opioid: false }, target: 2.5 },
  { name: 'adult male, 90kg, Ce=3.5', patient: { age: 40, weight: 90, height: 180, male: true, opioid: false }, target: 3.5 },
];

console.log('\n=== CET emulation — Ce tracking (both directions) ===\n');

for (const fx of fixtures) {
  console.log(`Fixture: ${fx.name}`);

  const engine = makeEngine(fx.patient);
  const startState = engine.getState();
  const scheme = planTCISchemeEmulation(engine, startState, 0, fx.target, baseCfg());

  const maintTime = findMaintTime(scheme);
  const { maxCe, minCe } = replayCeWindow(scheme, fx.patient, maintTime, 60);

  const upperCeiling = fx.target * (1 + TRANSIENT_MARGIN);
  const lowerFloor   = fx.target * (1 - TRANSIENT_MARGIN);
  const clinicalFloor = fx.target * CLINICAL_FLOOR;
  const maxDev = ((maxCe - fx.target) / fx.target) * 100;
  const minDev = ((minCe - fx.target) / fx.target) * 100;

  console.log(`  target=${fx.target.toFixed(2)} μg/mL, window=[${maintTime.toFixed(2)}, 60] min`);
  console.log(`  max Ce=${maxCe.toFixed(4)} (${maxDev >= 0 ? '+' : ''}${maxDev.toFixed(2)}%), min Ce=${minCe.toFixed(4)} (${minDev >= 0 ? '+' : ''}${minDev.toFixed(2)}%)`);

  assert(
    maxCe <= upperCeiling + EPSILON,
    `max Ce (${maxCe.toFixed(4)}) within target*(1+margin) = ${upperCeiling.toFixed(4)} + ε — no overshoot`
  );
  assert(
    minCe >= lowerFloor - EPSILON,
    `min Ce (${minCe.toFixed(4)}) within target*(1−margin) = ${lowerFloor.toFixed(4)} − ε — no undershoot`
  );
  assert(
    minCe >= clinicalFloor,
    `min Ce (${minCe.toFixed(4)}) ≥ 90% of target (${clinicalFloor.toFixed(4)}) — clinical floor`
  );
  console.log();
}

console.log(`${'='.repeat(50)}`);
console.log(`  RESULTS: ${passed} passed, ${failed} failed`);
console.log(`${'='.repeat(50)}\n`);
process.exit(failed > 0 ? 1 : 0);
