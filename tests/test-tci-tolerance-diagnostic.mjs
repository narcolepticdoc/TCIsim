/**
 * test-tci-tolerance-diagnostic.mjs
 *
 * Diagnostic: is the "TCI target tolerance" slider (#set-tci-fraction,
 * persisted as tciFraction in settings) actually reaching the CET emulation
 * planner and changing its output?
 *
 * Loop A — "UI path": build the exact cfg that simulation.js passes today
 * (no tolerancePct). Call the planner across a sweep of tciFraction values
 * the way a naive "slider is wired through" assumption would. Compare plans
 * to baseline. If byte-identical, the slider is dead on arrival.
 *
 * Loop B — "Direct knob": bypass the UI path and pass tolerancePct directly
 * into the planner cfg. Report the shape of the resulting plans so we can
 * see whether wiring the slider would even matter.
 *
 * Imports the real ES-module source tree (unlike the existing
 * tests/test-tci-scheme.js which inlines all of the PK math). Run with:
 *   node tests/test-tci-tolerance-diagnostic.mjs
 */

import { calcEleveldParams } from '../js/pk/eleveld.js';
import { createEngine } from '../js/pk/engine.js';
import { planTCISchemeEmulation } from '../js/sim/tci/emulation.js';

// ---------- Fixture ----------
const PATIENT = { age: 35, weight: 70, height: 170, male: true, opioid: false };
const CE_TARGET = 3.0;
const PUMP = { bolusConcentration: 10, bolusRateMlH: 750, maxRate: 200 };

function makeEngine() {
  const params = calcEleveldParams(PATIENT);
  return { engine: createEngine(params, { skipValidation: true }), params };
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
  const { engine } = makeEngine();
  const startState = engine.getState();
  return planTCISchemeEmulation(engine, startState, 0, CE_TARGET, cfg);
}

// ---------- Replay: walk scheme events through a fresh engine ----------
// Honors plannerBolusDelivery math from js/sim/tci/shared.js.
function replayScheme(scheme, horizonMin = 60) {
  const { engine } = makeEngine();
  const events = [...scheme].sort((a, b) => a.time - b.time);

  let tNow = 0;
  let currentRate = 0;
  let totalMg = 0;
  let timeToTarget95 = null;
  const target95 = CE_TARGET * 0.95;

  // Sample in small steps so we can find time-to-target accurately.
  const sampleDt = 0.05;
  function advanceSampling(dt, rate) {
    let remaining = dt;
    while (remaining > 1e-9) {
      const step = Math.min(sampleDt, remaining);
      engine.advance(step, rate);
      tNow += step;
      totalMg += rate * step;
      if (timeToTarget95 == null && engine.getConcentrations().Ce >= target95) {
        timeToTarget95 = tNow;
      }
      remaining -= step;
    }
  }

  for (const ev of events) {
    // Advance from tNow up to ev.time at current rate
    const gap = ev.time - tNow;
    if (gap > 1e-9) advanceSampling(gap, currentRate);

    if (ev.type === 'bolus') {
      const dose = ev.value;
      const volumeMl = dose / PUMP.bolusConcentration;
      const duration = Math.max(0.05, (volumeMl / PUMP.bolusRateMlH) * 60);
      const bolusRate = dose / duration;
      advanceSampling(duration, bolusRate);
      // Scheme typically emits a rate=0 event at tNow; leave currentRate alone
      // and let the next event set it.
    } else if (ev.type === 'rate') {
      currentRate = ev.value;
    }
  }

  if (tNow < horizonMin) advanceSampling(horizonMin - tNow, currentRate);
  const finalCe = engine.getConcentrations().Ce;

  return { finalCe, totalMg, timeToTarget95 };
}

// ---------- Helpers ----------
function schemeFingerprint(scheme) {
  return scheme
    .map(e => `${e.type}@${e.time.toFixed(6)}=${e.value.toFixed(6)}`)
    .join('|');
}

function summarizePlan(scheme) {
  const bolus = scheme.filter(e => e.type === 'bolus');
  const rates = scheme.filter(e => e.type === 'rate');
  const bolusMg = bolus.reduce((s, e) => s + e.value, 0);
  const nonZeroRates = rates.filter(e => e.value > 0);
  return {
    nEvents: scheme.length,
    nBolus: bolus.length,
    bolusMg: +bolusMg.toFixed(3),
    nRateSteps: rates.length,
    initialRate: nonZeroRates.length ? +nonZeroRates[0].value.toFixed(4) : 0,
    maintenanceRate: rates.length ? +rates[rates.length - 1].value.toFixed(4) : 0,
  };
}

function fmt(x, d = 3) {
  if (x == null) return '   —  ';
  return Number(x).toFixed(d).padStart(6);
}

// ---------- Loop A: UI path ----------
console.log('\n==============================================================');
console.log(' Loop A — UI path: does tciFraction reach the planner?');
console.log('==============================================================');
console.log(' Patient: 35 y, 70 kg, 170 cm, M, no opioid.');
console.log(` Ce target: ${CE_TARGET} μg/mL.  Planner: cet-emulation.\n`);

const baseline = runPlanner(baseCfg());
const baselineFp = schemeFingerprint(baseline);
console.log(' Baseline plan (no tciFraction in cfg):');
console.log('  ', summarizePlan(baseline));
console.log(`   fingerprint length: ${baselineFp.length} chars, nEvents=${baseline.length}\n`);

const fractions = [0.90, 0.92, 0.95, 0.97, 0.99];
let loopAFail = 0;
console.log(' Sweep — cfg spread with { tciFraction: f } as if slider were wired:');
for (const f of fractions) {
  const scheme = runPlanner(baseCfg({ tciFraction: f }));
  const fp = schemeFingerprint(scheme);
  const identical = fp === baselineFp;
  if (!identical) loopAFail++;
  console.log(`   tciFraction=${f.toFixed(2)}  nEvents=${String(scheme.length).padStart(3)}   ${identical ? 'IDENTICAL to baseline' : 'DIFFERENT'}`);
}

console.log();
if (loopAFail === 0) {
  console.log(' Loop A verdict: PASS — every plan identical to baseline.');
  console.log(' This CONFIRMS the slider value never reaches planTCISchemeEmulation.');
  console.log(' (tolerancePct stays at the hardcoded DEFAULT_SCHEME_CONFIG = 0.05.)');
} else {
  console.log(` Loop A verdict: FAIL — ${loopAFail}/${fractions.length} plans diverged from baseline.`);
  console.log(' This would mean tciFraction IS being read somewhere — investigate.');
}

// ---------- Loop B: direct tolerancePct sweep ----------
console.log('\n==============================================================');
console.log(' Loop B — direct tolerancePct sweep (what wiring would unlock)');
console.log('==============================================================');
console.log(' Bypasses the UI path and passes tolerancePct straight into cfg.\n');

const tolerances = [0.01, 0.02, 0.05, 0.10, 0.15];
const header =
  '  tolPct | nEv | nBol | bolusMg | nRate | initRate | maintR |  t→95% |  Ce@60 | mg@60';
console.log(header);
console.log('  ' + '-'.repeat(header.length - 2));
const rows = [];
for (const tol of tolerances) {
  const scheme = runPlanner(baseCfg({ tolerancePct: tol }));
  const sum = summarizePlan(scheme);
  const replay = replayScheme(scheme, 60);
  rows.push({ tol, sum, replay });
  console.log(
    `  ${tol.toFixed(2).padStart(5)}  |`
    + ` ${String(sum.nEvents).padStart(3)} |`
    + ` ${String(sum.nBolus).padStart(4)} |`
    + ` ${fmt(sum.bolusMg, 2)}  |`
    + ` ${String(sum.nRateSteps).padStart(5)} |`
    + ` ${fmt(sum.initialRate, 3)}  |`
    + ` ${fmt(sum.maintenanceRate, 3)} |`
    + ` ${fmt(replay.timeToTarget95, 2)} |`
    + ` ${fmt(replay.finalCe, 3)} |`
    + ` ${fmt(replay.totalMg, 2)}`
  );
}

// Diff the first bolus across tolerances so shifts are easy to see at a glance.
console.log('\n First bolus value across the sweep:');
for (const r of rows) {
  console.log(`   tolPct=${r.tol.toFixed(2)}  bolusMg=${r.sum.bolusMg.toFixed(3)}`);
}

// Simple "did anything move" check — compare extremes.
const fpLoose = schemeFingerprint(runPlanner(baseCfg({ tolerancePct: 0.15 })));
const fpTight = schemeFingerprint(runPlanner(baseCfg({ tolerancePct: 0.01 })));
const knobMovesPlan = fpLoose !== fpTight;

console.log('\n Loop B verdict:');
console.log(
  `   tolerancePct knob moves plan (0.01 vs 0.15): ${knobMovesPlan ? 'YES' : 'NO'}`
);
if (knobMovesPlan) {
  console.log('   → Wiring tciFraction → tolerancePct in simulation.js would give');
  console.log('     the slider real effect.');
} else {
  console.log('   → The CET emulation planner is effectively insensitive to');
  console.log('     tolerancePct for this scenario. Inspection of emulation.js:');
  console.log('       • line 42  upperBound = ceTarget*(1+tol)  — only consulted');
  console.log('         in the target-decrease branch, which is skipped from Ce=0.');
  console.log('       • line 49  needsBolus = currentCe < ceTarget*(1-tol) — true');
  console.log('         for every tol in [0.01..0.15] when currentCe = 0.');
  console.log('       • maintenance loop uses SimTIVA\'s cpt_threshold / cpt_avgfactor,');
  console.log('         NOT tolerancePct — so rate-step extraction is unchanged.');
  console.log('     Wiring the slider to tolerancePct would have no visible effect');
  console.log('     on from-zero plans (the common "plan a case" path).');
}

// ---------- Summary ----------
console.log('\n==============================================================');
console.log(' Summary');
console.log('==============================================================');
const passed = loopAFail === 0 ? 1 : 0;
const failed = loopAFail === 0 ? 0 : 1;
console.log(`  ${passed} passed, ${failed} failed`);
console.log('==============================================================\n');

process.exit(failed > 0 ? 1 : 0);
