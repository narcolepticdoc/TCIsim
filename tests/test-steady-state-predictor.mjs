/**
 * test-steady-state-predictor.js — Analytical steady-state + plateau predictors.
 *
 * Imports the REAL js/pk/steady-state-predictor.js (predictSteadyStateCe,
 * predictTimeToSteadyState, predictPlateau) against the real engine and real
 * Eleveld/Fentanyl/Ketamine params. Previously inlined faithful-but-drifted
 * copies (the inline Eleveld used base CL 1.89 vs production 1.79, and the
 * inline ketamine was an entirely different volume model).
 *
 * Two kinds of numeric assertion, deliberately treated differently:
 *   - Ce_ss VALUES (steady-state concentration for a rate) are locked exactly
 *     (±1e-4). Ce_ss = rate·(sum of tissue partition terms) is an analytic
 *     property of the model, cross-checked in TEST 1 against an independent
 *     matrix solve — an exact lock here catches a real PK regression.
 *   - TIMING magnitudes (time-to-95%-SS, plateau entry/exit MINUTE) are checked
 *     with a tight tolerance window (`nearMin`), NOT exact equality. The minute
 *     a slope reversal is detected is a function of the sampling grid and the
 *     slope-tolerance knob, so an exact-integer lock over-specifies incidental
 *     scheduling and would red-fail on benign predictor retuning. The window is
 *     small enough (±a few min) to still catch a genuine "detection broke"
 *     regression (which moves the minute by tens of min or to null).
 * Contracts stay exact: `=== 0` (already at SS), `=== null` (unreachable / no
 * plateau / bad input). Surrounding behavioral assertions (plateau
 * present/absent, entry<exit, band ordering) validate structure independently.
 *
 * A compact inv4 is kept inline ONLY for TEST 1's independent matrix-solve
 * cross-check of Ce_ss vs Cp_ss — that is deliberately not production code.
 */

import { calcEleveldParams } from '../js/pk/eleveld.js';
import { calcFentanylParams } from '../js/pk/fentanyl.js';
import { calcKetamineParams } from '../js/pk/ketamine.js';
import { createEngine } from '../js/pk/engine.js';
import { predictSteadyStateCe, predictTimeToSteadyState, predictPlateau } from '../js/pk/steady-state-predictor.js';

// Compact 4×4 inverse — test-side math for the TEST 1 matrix cross-check only.
function inv4(M){
  const N=4, a=new Float64Array(32);
  for(let i=0;i<N;i++){for(let j=0;j<N;j++)a[i*8+j]=M[i*N+j];a[i*8+(N+i)]=1}
  for(let col=0;col<N;col++){
    let mv=Math.abs(a[col*8+col]),mr=col;
    for(let r=col+1;r<N;r++){const v=Math.abs(a[r*8+col]);if(v>mv){mv=v;mr=r}}
    if(mv<1e-15)return null;
    if(mr!==col)for(let j=0;j<8;j++){const t=a[col*8+j];a[col*8+j]=a[mr*8+j];a[mr*8+j]=t}
    const p=a[col*8+col];for(let j=0;j<8;j++)a[col*8+j]/=p;
    for(let r=0;r<N;r++){if(r===col)continue;const f=a[r*8+col];for(let j=0;j<8;j++)a[r*8+j]-=f*a[col*8+j]}
  }
  const inv=new Float64Array(16);for(let i=0;i<N;i++)for(let j=0;j<N;j++)inv[i*N+j]=a[i*8+(N+j)];return inv;
}


// Test-side time-to-target scan over a precomputed Ce curve (used by the
// synthetic-curve TCI tests below — not a production export).
function estimateTimeToTarget(curve, t, Ce, ceTarget, fraction) {
  if (!curve) return null;
  if (!(ceTarget > 0)) return null;
  const tol = (1 - fraction) * ceTarget;
  const approaching = Ce < ceTarget;
  for (const pt of curve) {
    if (pt.time <= t) continue;
    if (approaching  && pt.Ce >= ceTarget - tol) return pt.time - t;
    if (!approaching && pt.Ce <= ceTarget + tol) return pt.time - t;
  }
  return null;
}

// ============ TEST HARNESS ============
let passed = 0, failed = 0;
function assert(c, m) {
  if (c) { passed++; console.log('  ✓ ' + m); }
  else   { failed++; console.error('  ✗ ' + m); }
}
// Tolerance-window check for TIMING magnitudes (minutes). A regression that
// breaks detection moves the value by tens of minutes or to null; a benign
// retune shifts it by ≤ a grid step. `tol` is absolute minutes.
function nearMin(actual, expected, tol, m) {
  assert(actual !== null && Math.abs(actual - expected) <= tol,
    `${m} (got ${actual}, expected ${expected} ± ${tol})`);
}

const patient = { age: 35, weight: 70, height: 170, male: true, opioid: false };
const propParams = calcEleveldParams(patient);

// Test tolerance levels (per-minute relative slope).
const TOL_STRICTEST = 0.0002;
const TOL_STRICT    = 0.0006;
const TOL_STD       = 0.0010;
const TOL_LOOSE     = 0.0014;
const TOL_LOOSEST   = 0.0018;

// ============ ANALYTICAL STEADY STATE TESTS ============

console.log('\n=== TEST 1: Propofol Ce_ss analytical computation (regression lock) ===');
{
  const eng = createEngine(propParams);
  const rate = 5.4;
  const ceSS = predictSteadyStateCe(eng, rate);
  assert(ceSS !== null, 'Ce_ss computed');
  assert(Math.abs(ceSS - 3.016760) < 1e-4,
    `Ce_ss = 3.016760 (got ${ceSS.toFixed(6)})`);

  // Ce_ss should equal Cp_ss at true steady state
  const A = eng.getSystemMatrix();
  const Ainv = inv4(A);
  const cpSS = (-Ainv[0] * rate) / propParams.V1;
  assert(Math.abs(ceSS - cpSS) < 1e-10,
    `Ce_ss equals Cp_ss (diff ${Math.abs(ceSS - cpSS).toExponential(2)})`);
}

console.log('\n=== TEST 2: Propofol time to 95% of Ce_ss from zero (not reachable in 6h) ===');
{
  const eng = createEngine(propParams);
  const rate = 5.4;
  const result = predictTimeToSteadyState(eng, eng.getState(), rate);
  assert(result !== null, 'Result returned');
  assert(result.reachable === false,
    'Not reachable within 6h (propofol V3 time constant too slow)');
  assert(Math.abs(result.ceSS - 3.016760) < 1e-4,
    `ceSS reported correctly (${result.ceSS.toFixed(6)})`);
  assert(result.timeToSsMin === null,
    'timeToSsMin is null when not reachable');
}

console.log('\n=== TEST 3: Propofol with extended horizon reaches 95% ===');
{
  const eng = createEngine(propParams);
  const result = predictTimeToSteadyState(eng, eng.getState(), 5.4, { horizon: 1000 });
  assert(result !== null && result.reachable === true,
    'Reachable within 1000 min');
  nearMin(result.timeToSsMin, 856, 20,
    'Time to 95% ≈ 856 min');
}

console.log('\n=== TEST 4: Pre-advanced state (at SS) → timeToSsMin = 0 ===');
{
  const eng = createEngine(propParams);
  const rate = 5.4;
  eng.advance(2000, rate);   // 33+ hours — well past SS
  const deepState = eng.getState();
  const result = predictTimeToSteadyState(eng, deepState, rate);
  assert(result !== null && result.reachable === true, 'Reachable');
  assert(result.timeToSsMin === 0,
    `Already at SS → timeToSsMin = 0 (got ${result.timeToSsMin})`);
}

console.log('\n=== TEST 4b: Transient crossing rejected — rate lowered, Ce passes through band ===');
{
  // Start with Ce well above Ce_ss. Ce decays, passes through the 95% band
  // transiently on the way down, undershoots, then slowly climbs back.
  // The predictor must NOT report the transient crossing as "at SS".
  const eng = createEngine(propParams);
  eng.advance(0.05, 150 / 0.05);  // loading bolus
  eng.advance(30, 10.0);          // 30 min at high rate
  const highState = eng.getState();
  const lowRate = 2.0;

  const result = predictTimeToSteadyState(eng, highState, lowRate);
  assert(result !== null, 'Result returned');
  // Ce_ss ≈ 1.058 for 2.0 mg/min propofol. Ce starts at ~3.26, decays through
  // the 95% band (~1.00-1.11), undershoots to ~0.92, then climbs back.
  // At 360 min horizon, Ce hasn't re-entered the band → not reachable.
  assert(result.reachable === false,
    'Transient band crossing rejected — Ce undershoots then does not re-enter within 6h');
  assert(result.ceSS > 1.11 && result.ceSS < 1.13,
    `Ce_ss correct (${result.ceSS.toFixed(4)})`);
}

console.log('\n=== TEST 5: Fentanyl Ce_ss analytical computation ===');
{
  const fentParams = calcFentanylParams(patient);
  const eng = createEngine(fentParams);
  const rate = 0.1 / 60;   // 100 mcg/h
  const ceSS = predictSteadyStateCe(eng, rate);
  assert(ceSS !== null, 'Ce_ss computed');
  assert(ceSS > 0.002 && ceSS < 0.003,
    `Fentanyl Ce_ss in expected ng-scale range (${ceSS.toExponential(3)} mcg/mL)`);
}

console.log('\n=== TEST 6: Ketamine Ce_ss analytical computation ===');
{
  const ketParams = calcKetamineParams({ weight: 70 });
  const eng = createEngine(ketParams);
  const rate = 1.5;
  const ceSS = predictSteadyStateCe(eng, rate);
  assert(ceSS !== null, 'Ce_ss computed');
  assert(Math.abs(ceSS - 0.776380) < 1e-4,
    `Ketamine Ce_ss = 0.776380 (got ${ceSS.toFixed(4)})`);
}

console.log('\n=== TEST 7: Rate ≤ 0 returns null ===');
{
  const eng = createEngine(propParams);
  assert(predictSteadyStateCe(eng, 0) === null, 'Rate = 0 → null');
  assert(predictSteadyStateCe(eng, -1) === null, 'Rate < 0 → null');
  assert(predictTimeToSteadyState(eng, eng.getState(), 0) === null, 'TimeToSS rate=0 → null');
}

console.log('\n=== TEST 8: Engine state restoration (analytical SS) ===');
{
  const eng = createEngine(propParams);
  eng.advance(7, 5.4);
  const beforeState = eng.getState();
  predictTimeToSteadyState(eng, eng.getState(), 5.4);
  const afterState = eng.getState();
  let identical = true;
  for (let i = 0; i < 4; i++) if (beforeState[i] !== afterState[i]) identical = false;
  assert(identical, 'Engine state byte-identical after predictTimeToSteadyState');
}

// ============ PLATEAU (SLOPE REVERSAL) TESTS ============

console.log('\n=== TEST 9: Propofol from zero — NO plateau (monotonic rise, no reversal) ===');
{
  const eng = createEngine(propParams);
  const result = predictPlateau(eng, eng.getState(), 5.4, TOL_STD);
  assert(result !== null, 'Result returned');
  assert(result.noPlateau === true,
    'Propofol from zero has no plateau (monotonic rise to SS)');
  assert(result.plateauCe === null, 'plateauCe is null');
  assert(result.entryMin === null, 'entryMin is null');
}

console.log('\n=== TEST 10: Fentanyl bolus + infusion — local plateau with reversal ===');
{
  const fentParams = calcFentanylParams(patient);
  const eng = createEngine(fentParams);
  eng.advance(0.5, 0.1 / 0.5);   // 100 mcg bolus over 30 sec
  eng.advance(5, 0);              // 5 min gap
  const state = eng.getState();
  const rate = 0.1 / 60;          // 100 mcg/h

  const result = predictPlateau(eng, state, rate, TOL_LOOSEST);
  assert(result !== null && result.noPlateau === false,
    'Plateau found (slope reversal: falling → rising)');
  nearMin(result.entryMin, 40, 5, 'Entry ≈ 40 min');
  nearMin(result.exitMin, 98, 5, 'Exit ≈ 98 min');
  assert(result.bandLow < result.bandHigh,
    'Non-degenerate band');
}

console.log('\n=== TEST 11: Post-bolus propofol → plateau found ===');
{
  const eng = createEngine(propParams);
  eng.advance(0.5, 80 / 0.5);   // 80 mg loading bolus
  const postBolusState = eng.getState();
  const mainRate = 1.5;

  // At TOL_STD, the Ce curve peaks from the bolus, declines, hits a local
  // flat (post-bolus decline balances maintenance fill), then resumes
  // approach to steady state.
  const result = predictPlateau(eng, postBolusState, mainRate, TOL_STD);
  assert(result !== null && result.noPlateau === false,
    'Post-bolus propofol has a local plateau (overshoot → flat → reversal)');
  nearMin(result.entryMin, 60, 5, 'Entry ≈ 60 min');
}

console.log('\n=== TEST 12: Rate lowered from high — falling → flat → reversal ===');
{
  const eng = createEngine(propParams);
  eng.advance(0.05, 150 / 0.05);  // loading bolus
  eng.advance(30, 10.0);          // 30 min at high rate
  const highState = eng.getState();
  const startCe = eng.getConcentrations().Ce;
  const lowRate = 2.0;

  const result = predictPlateau(eng, highState, lowRate, TOL_STD);
  assert(result !== null && result.noPlateau === false,
    'Plateau found after rate lowered');
  assert(result.plateauCe < startCe,
    `plateauCe (${result.plateauCe.toFixed(3)}) < startCe (${startCe.toFixed(3)})`);
  nearMin(result.entryMin, 87, 5, 'Rate-lowered entry ≈ 87 min');
}

console.log('\n=== TEST 13: Plateau detection — bad input returns null ===');
{
  const eng = createEngine(propParams);
  assert(predictPlateau(eng, eng.getState(), 0, TOL_STD) === null, 'Rate = 0 → null');
  assert(predictPlateau(eng, eng.getState(), -1, TOL_STD) === null, 'Rate < 0 → null');
  assert(predictPlateau(eng, eng.getState(), 5.4, 0) === null, 'slopeTol = 0 → null');
  assert(predictPlateau(eng, eng.getState(), 5.4, 1) === null, 'slopeTol = 1 → null');
}

console.log('\n=== TEST 14: Engine state restoration (plateau) ===');
{
  const eng = createEngine(propParams);
  eng.advance(7, 5.4);
  const beforeState = eng.getState();
  predictPlateau(eng, eng.getState(), 5.4, TOL_STD);
  const afterState = eng.getState();
  let identical = true;
  for (let i = 0; i < 4; i++) if (beforeState[i] !== afterState[i]) identical = false;
  assert(identical, 'Engine state byte-identical after predictPlateau');
}

console.log('\n=== TEST 15: Fentanyl from zero — no plateau at default threshold ===');
{
  const fentParams = calcFentanylParams(patient);
  const eng = createEngine(fentParams);
  const result = predictPlateau(eng, eng.getState(), 0.0018, TOL_STD);
  assert(result !== null, 'Result returned');
  assert(result.noPlateau === true,
    'Fentanyl from zero at default threshold: no plateau (no reversal)');
}

console.log('\n=== TEST 16: Ketamine from zero — no plateau (monotonic rise) ===');
{
  const ketParams = calcKetamineParams({ weight: 70 });
  const eng = createEngine(ketParams);
  const result = predictPlateau(eng, eng.getState(), 1.5, TOL_STD);
  assert(result !== null && result.noPlateau === true,
    'Ketamine from zero: no plateau (monotonic rise)');
}

console.log('\n=== TEST 17: Exit band width monotonicity — wider band → later exit ===');
{
  // Use fentanyl bolus + infusion which has a real plateau with reversal
  const fentParams = calcFentanylParams(patient);
  const eng = createEngine(fentParams);
  eng.advance(0.5, 0.1 / 0.5);
  eng.advance(5, 0);
  const state = eng.getState();
  const rate = 0.1 / 60;

  const r2  = predictPlateau(eng, state, rate, TOL_LOOSEST, { exitBandPct: 0.02 });
  const r5  = predictPlateau(eng, state, rate, TOL_LOOSEST, { exitBandPct: 0.05 });
  const r10 = predictPlateau(eng, state, rate, TOL_LOOSEST, { exitBandPct: 0.10 });

  assert(!r2.noPlateau && !r5.noPlateau && !r10.noPlateau,
    'All three have plateaus');
  assert(r2.exitMin < r5.exitMin && r5.exitMin < r10.exitMin,
    `Wider band → later exit: ±2%=${r2.exitMin}, ±5%=${r5.exitMin}, ±10%=${r10.exitMin}`);
  // Entry time unchanged (slope-based, not affected by band)
  assert(r2.entryMin === r5.entryMin && r5.entryMin === r10.entryMin,
    'Entry time independent of exit band');
}

console.log('\n=== TEST 18: Band bounds are exactly ±exitBandPct of plateauCe ===');
{
  const fentParams = calcFentanylParams(patient);
  const eng = createEngine(fentParams);
  eng.advance(0.5, 0.1 / 0.5);
  eng.advance(5, 0);
  const state = eng.getState();
  const result = predictPlateau(eng, state, 0.1/60, TOL_LOOSEST);
  assert(!result.noPlateau, 'Plateau found');
  assert(Math.abs(result.bandLow - result.plateauCe * 0.95) < 1e-15,
    'bandLow = plateauCe × 0.95');
  assert(Math.abs(result.bandHigh - result.plateauCe * 1.05) < 1e-15,
    'bandHigh = plateauCe × 1.05');
}

console.log('\n=== TEST 19: Both predictors agree on propofol from zero (no plateau, SS exists) ===');
{
  const eng = createEngine(propParams);
  const rate = 5.4;
  const state = eng.getState();

  const ss = predictTimeToSteadyState(eng, state, rate);
  const plat = predictPlateau(eng, state, rate, TOL_STD);

  assert(ss !== null && ss.ceSS > 0, 'SS exists');
  assert(ss.reachable === false, 'SS not reachable in 6h');
  assert(plat !== null && plat.noPlateau === true, 'No plateau (monotonic)');
  // Both predictors should agree: this is a monotonic approach to SS
}

// ============ TCI TIME-TO-TARGET TESTS ============

console.log('\n=== TEST 20: Propofol TCI tolerance at default 95% ===');
{
  const curve = [];
  for (let t = 0; t <= 20; t += 0.5) curve.push({ time: t, Ce: 3.5 * (t / 20) });
  const target = 3.0;
  const dt = estimateTimeToTarget(curve, 0, 0, target, 0.95);
  assert(dt !== null, 'Result returned');
  assert(Math.abs(dt - 16.5) < 1e-6, `First crossing at t = 16.5 (got ${dt})`);
}

console.log('\n=== TEST 21: Fentanyl-scale target does not latch at sample 0 ===');
{
  const curve = [];
  for (let t = 0; t <= 30; t += 0.5) {
    curve.push({ time: t, Ce: 0.0001 + (0.005 - 0.0001) * (t / 30) });
  }
  const target = 0.003;
  const dt = estimateTimeToTarget(curve, 0, 0.0001, target, 0.95);
  assert(dt !== null, 'Result returned');
  assert(dt > 0, `Does not latch at sample 0 (dt = ${dt})`);
  assert(Math.abs(dt - 17.0) < 1e-6, `First crossing at t ≈ 17.0 (got ${dt})`);
}

console.log('\n=== TEST 22: Approach from above (Ce > target) ===');
{
  const curve = [];
  for (let t = 0; t <= 30; t += 0.5) {
    curve.push({ time: t, Ce: 5.0 - (5.0 - 2.9) * (t / 30) });
  }
  const target = 3.0;
  const dt = estimateTimeToTarget(curve, 0, 5.0, target, 0.95);
  assert(dt !== null, 'Result returned');
  assert(Math.abs(dt - 26.5) < 1e-6, `First crossing from above at t ≈ 26.5 (got ${dt})`);
}

console.log('\n=== TEST 23: TCI fraction monotonicity ===');
{
  const curve = [];
  for (let t = 0; t <= 40; t += 0.5) curve.push({ time: t, Ce: 4.0 * (t / 40) });
  const target = 3.0;
  const t90 = estimateTimeToTarget(curve, 0, 0, target, 0.90);
  const t95 = estimateTimeToTarget(curve, 0, 0, target, 0.95);
  const t99 = estimateTimeToTarget(curve, 0, 0, target, 0.99);
  assert(t90 <= t95, `t(0.90)=${t90} ≤ t(0.95)=${t95}`);
  assert(t95 <= t99, `t(0.95)=${t95} ≤ t(0.99)=${t99}`);
  assert(t90 > 0 && t99 > 0, 'All crossings positive');
}

// ============ SUMMARY ============
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
