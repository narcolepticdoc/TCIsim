/**
 * test-tci-peak-overshoot.mjs
 *
 * Validates the peak-aware rate selection added to the CET emulation
 * planner's correction pass (emulation.js:494-534).
 *
 * The correction pass now runs a dual-constraint binary search:
 *   1. Endpoint: rate for Ce = target at +PROBE min.
 *   2. Peak-bounded: rate where max Ce over MAX_DUR ≤ target * (1 + CE_TOL).
 *   3. Returns min(endpoint, peak).
 *
 * This test replays each emitted plan through a fresh engine and asserts
 * that the maximum Ce during maintenance never exceeds target*(1+CE_TOL)
 * by more than a small numerical epsilon. Before the change, early
 * maintenance steps could overshoot by a few percent; after, the peak
 * search bounds it.
 */

import { calcEleveldParams } from '../js/pk/eleveld.js';
import { createEngine } from '../js/pk/engine.js';
import { planTCISchemeEmulation } from '../js/sim/tci/emulation.js';

const PUMP = { bolusConcentration: 10, bolusRateMlH: 750, maxRate: 200 };
const CE_TOL = 0.015;
// Slack accounts for: (a) 1-min granularity of the planner's peak search
// vs 0.05-min granularity of our replay, (b) rate quantization, (c) bolus
// pause timing at sub-CE_TOL precision. The planner's internal ceiling is
// strict; the observed continuous max can be marginally above it.
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
  };
}

function replayMaxCe(scheme, patient, horizonMin) {
  const engine = makeEngine(patient);
  const events = [...scheme].sort((a, b) => a.time - b.time);

  let tNow = 0;
  let currentRate = 0;
  let maxCe = 0;

  const sampleDt = 0.05;
  function advanceSampling(dt, rate) {
    let remaining = dt;
    while (remaining > 1e-9) {
      const step = Math.min(sampleDt, remaining);
      engine.advance(step, rate);
      tNow += step;
      const ce = engine.getConcentrations().Ce;
      if (ce > maxCe) maxCe = ce;
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

  if (tNow < horizonMin) advanceSampling(horizonMin - tNow, currentRate);
  return maxCe;
}

let passed = 0, failed = 0;
function assert(condition, message) {
  if (condition) { passed++; console.log(`  ✓ ${message}`); }
  else { failed++; console.error(`  ✗ ${message}`); }
}

const fixtures = [
  { name: 'adult male, 70kg, Ce=3', patient: { age: 35, weight: 70, height: 170, male: true, opioid: false }, target: 3.0 },
  { name: 'adult female, 60kg, Ce=2', patient: { age: 45, weight: 60, height: 160, male: false, opioid: false }, target: 2.0 },
  { name: 'elderly male, 75kg, Ce=2.5', patient: { age: 75, weight: 75, height: 170, male: true, opioid: false }, target: 2.5 },
  { name: 'adult male, 90kg, Ce=4', patient: { age: 40, weight: 90, height: 180, male: true, opioid: false }, target: 4.0 },
];

console.log('\n=== Peak-aware correction pass — overshoot check ===\n');

for (const fx of fixtures) {
  console.log(`Fixture: ${fx.name}`);
  const engine = makeEngine(fx.patient);
  const startState = engine.getState();
  const scheme = planTCISchemeEmulation(engine, startState, 0, fx.target, baseCfg());

  const maxCe = replayMaxCe(scheme, fx.patient, 120);
  const ceiling = fx.target * (1 + CE_TOL);
  const overshoot = maxCe - fx.target;
  const overshootPct = (overshoot / fx.target) * 100;

  console.log(`  target=${fx.target.toFixed(2)} μg/mL, ceiling=${ceiling.toFixed(4)} μg/mL, observed max Ce=${maxCe.toFixed(4)}`);
  console.log(`  overshoot: ${overshoot >= 0 ? '+' : ''}${overshoot.toFixed(4)} μg/mL (${overshootPct.toFixed(2)}%)`);

  assert(
    maxCe <= ceiling + EPSILON,
    `max Ce (${maxCe.toFixed(4)}) within ceiling (${ceiling.toFixed(4)}) + ε`
  );
  console.log();
}

console.log(`${'='.repeat(50)}`);
console.log(`  RESULTS: ${passed} passed, ${failed} failed`);
console.log(`${'='.repeat(50)}\n`);
process.exit(failed > 0 ? 1 : 0);
