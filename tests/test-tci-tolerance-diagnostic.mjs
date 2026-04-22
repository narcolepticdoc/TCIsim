/**
 * test-tci-tolerance-diagnostic.mjs
 *
 * Tolerance diagnostic for the CET emulation planner.
 *
 * History: this started as a check that the "TCI target tolerance" slider
 * (#set-tci-fraction, persisted as tciFraction) was NOT reaching the
 * planner. That was correct at the time — see TCI-TOLERANCE-ANALYSIS.md §1.
 * The slider has since been rebound to `ceTolerance`, which the correction
 * pass at emulation.js:457 reads via cfg.
 *
 * Loop A — sweeps `ceTolerance` through the planner's cfg across realistic
 * values (0.005 / 0.010 / 0.015 / 0.020 / 0.030). Plans should DIFFER — the
 * tighter the tolerance, the more maintenance steps. Asserts plans are not
 * all identical.
 *
 * Loop B — legacy sweep of `tolerancePct`. This knob gates the loading
 * bolus and target-decrease pause (emulation.js:42, 49), not maintenance.
 * From Ce=0 it has no effect; kept as documentation of the original finding.
 *
 * Run with: node tests/test-tci-tolerance-diagnostic.mjs
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

// ---------- Replay ----------
function replayScheme(scheme, horizonMin = 60) {
  const { engine } = makeEngine();
  const events = [...scheme].sort((a, b) => a.time - b.time);

  let tNow = 0;
  let currentRate = 0;
  let totalMg = 0;
  let timeToTarget95 = null;
  const target95 = CE_TARGET * 0.95;

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
  return { finalCe: engine.getConcentrations().Ce, totalMg, timeToTarget95 };
}

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

// ---------- Loop A: ceTolerance sweep ----------
console.log('\n==============================================================');
console.log(' Loop A — ceTolerance sweep (the Ce drift tolerance slider)');
console.log('==============================================================');
console.log(' Patient: 35 y, 70 kg, 170 cm, M, no opioid.');
console.log(` Ce target: ${CE_TARGET} μg/mL.  Planner: cet-emulation.\n`);

const ceTolerances = [0.005, 0.010, 0.015, 0.020, 0.030];
const rowsA = [];
const header =
  '  ceTol | nEv | nBol | bolusMg | nRate | initRate | maintR |  t→95% |  Ce@60 | mg@60';
console.log(header);
console.log('  ' + '-'.repeat(header.length - 2));
for (const tol of ceTolerances) {
  const scheme = runPlanner(baseCfg({ ceTolerance: tol }));
  const sum = summarizePlan(scheme);
  const replay = replayScheme(scheme, 60);
  rowsA.push({ tol, sum, replay, fp: schemeFingerprint(scheme) });
  console.log(
    `  ${tol.toFixed(3).padStart(5)} |`
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

const uniqueFps = new Set(rowsA.map(r => r.fp));
const loopAPass = uniqueFps.size >= 2;
console.log('\n Loop A verdict:');
console.log(`   Unique plan fingerprints across ${ceTolerances.length} tolerances: ${uniqueFps.size}`);
if (loopAPass) {
  console.log('   PASS — ceTolerance actually moves the plan. Slider is wired.');
} else {
  console.log('   FAIL — all plans identical. Slider is NOT reaching the planner.');
}

// ---------- Loop B: legacy tolerancePct sweep ----------
console.log('\n==============================================================');
console.log(' Loop B — legacy tolerancePct sweep (historical / documentary)');
console.log('==============================================================');
console.log(' tolerancePct gates the loading-bolus + target-decrease-pause branches.');
console.log(' Expected result from Ce=0: no effect on maintenance. This is by');
console.log(' design; kept as documentation of the original diagnostic finding.\n');

const tolerances = [0.01, 0.02, 0.05, 0.10, 0.15];
const fps = new Set();
for (const tol of tolerances) {
  const fp = schemeFingerprint(runPlanner(baseCfg({ tolerancePct: tol })));
  fps.add(fp);
  console.log(`   tolerancePct=${tol.toFixed(2)}  nEvents fingerprint ${fp.length} chars`);
}
console.log(`\n   Unique fingerprints: ${fps.size} (expected 1 for from-zero case).`);

// ---------- Summary ----------
console.log('\n==============================================================');
console.log(' Summary');
console.log('==============================================================');
const passed = loopAPass ? 1 : 0;
const failed = loopAPass ? 0 : 1;
console.log(`  ${passed} passed, ${failed} failed`);
console.log('==============================================================\n');

process.exit(failed > 0 ? 1 : 0);
