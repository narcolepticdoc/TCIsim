/**
 * test-integration.mjs — End-to-end PK/PD curve-shape sanity through the REAL
 * production model.
 *
 * Drives the actual `createModel()` facade (js/sim/simulation.js) with the
 * production cet-emulation planner and real pump settings, then inspects the
 * concentration + BIS curves for correct pharmacological SHAPE — the property
 * that `test-tci-plan-fidelity` (which asserts the endpoint: reaches + holds
 * target) does not check:
 *   - Ce lags Cp early (effect-site equilibration),
 *   - Cp redistributes down after the loading bolus,
 *   - rate steps decrease from loading toward maintenance,
 *   - BIS tracks Ce into the anaesthetic range,
 *   - computeCurve agrees across sampling resolutions.
 *
 * History: this file used to inline its own event list + planner + model +
 * PD, and tested those copies. It now imports the real chain — the inline
 * fossils are gone. The engine-mechanics scaffolding still lives in
 * tests/helpers/mini-event-list.mjs for the lower-level event-ordering tests
 * (test-model / test-t0-edge); this file no longer needs it.
 */

import { createModel } from '../js/sim/simulation.js';
import { setPumpSettings, resetPumpSettings } from '../js/util/constants.js';

// Production pump config (derives maxRate = 750×10/60 = 125), installed the way
// the setup screen does on every case. cet-emulation is the production planner.
function freshModel(patient) {
  resetPumpSettings();
  setPumpSettings('propofol', { concentration: 10, bolusRateMlH: 750 });
  const m = createModel();
  if (patient) m.setPatient(patient);
  return m;
}
const TCI = { tciMode: 'cet-emulation' };

let passed = 0, failed = 0;
function ok(c, m) { if (c) { passed++; console.log(`  ✓ ${m}`); } else { failed++; console.error(`  ✗ ${m}`); } }

console.log('\n===== 1. Full Chain: setPatient → planTCI → computeCurve =====\n');

{
  const model = freshModel({ age: 50, weight: 80, height: 175, male: true, opioid: true });

  const params = model.getParams();
  ok(params.V1 > 0, `Params computed: V1=${params.V1.toFixed(2)}`);
  ok(params.Ce50 > 0, `Ce50=${params.Ce50.toFixed(3)}`);

  const { scheme } = model.planTCI('propofol', 0, 3.0, TCI);
  ok(scheme.length >= 2, `TCI scheme has ${scheme.length} steps (bolus + rates)`);

  const bolus = scheme.find(s => s.type === 'bolus');
  ok(bolus !== undefined, `Scheme includes a loading bolus`);
  ok(bolus.value > 50 && bolus.value < 300, `Bolus dose reasonable: ${bolus.value.toFixed(1)} mg`);

  const curve = model.computeCurve('propofol', 0, 30, 10 / 60);
  ok(curve.length > 100, `Curve has ${curve.length} points (30 min @ 10s)`);
}

console.log('\n===== 2. Curve Shape: PK Pharmacology =====\n');

{
  const model = freshModel();
  const { scheme } = model.planTCI('propofol', 0, 3.0, TCI);
  const curve = model.computeCurve('propofol', 0, 30, 10 / 60);

  // Peak Cp should be a good fraction of the naive dose/V1 estimate.
  const params = model.getParams();
  const bolus = scheme.find(s => s.type === 'bolus');
  const expectedPeakCp = bolus ? bolus.value / params.V1 : 0;
  const actualPeakCp = Math.max(...curve.map(p => p.Cp));
  ok(actualPeakCp > expectedPeakCp * 0.5, `Peak Cp (${actualPeakCp.toFixed(1)}) reasonable vs dose/V1 (${expectedPeakCp.toFixed(1)})`);

  // Ce lags Cp early.
  const early = curve.find(p => p.time >= 0.5);
  ok(early.Cp > early.Ce, `At t=0.5 min: Cp (${early.Cp.toFixed(2)}) > Ce (${early.Ce.toFixed(2)}) — Ce lags`);

  // Ce reaches target band by 15 min.
  const at15 = curve.find(p => p.time >= 15);
  ok(Math.abs(at15.Ce - 3.0) < 0.5, `At t=15 min: Ce (${at15.Ce.toFixed(2)}) near target 3.0`);

  // Cp redistributes down after the bolus.
  const at1 = curve.find(p => p.time >= 1);
  const at5 = curve.find(p => p.time >= 5);
  ok(at5.Cp < at1.Cp, `Cp at 5 min (${at5.Cp.toFixed(2)}) < Cp at 1 min (${at1.Cp.toFixed(2)}) — redistribution`);

  // Rate steps down from loading toward maintenance.
  const significantRates = curve.filter(p => p.rate > 1.0).map(p => p.rate);
  const firstSignificantRate = significantRates[0];
  const lastSignificantRate = significantRates[significantRates.length - 1];
  ok(lastSignificantRate < firstSignificantRate, `Rate decreases: first=${firstSignificantRate.toFixed(1)} → last=${lastSignificantRate.toFixed(1)} mg/min`);
}

console.log('\n===== 3. BIS Prediction Along Curve =====\n');

{
  const model = freshModel();
  model.planTCI('propofol', 0, 3.0, TCI);

  const bis0 = model.predictBIS('propofol', 0);
  ok(bis0 > 90, `BIS at t=0: ${bis0.toFixed(1)} (near baseline 93)`);

  const bis10 = model.predictBIS('propofol', 10);
  ok(bis10 < 60, `BIS at t=10 min: ${bis10.toFixed(1)} (anaesthetic range)`);

  const bis15 = model.predictBIS('propofol', 15);
  ok(bis15 > 20 && bis15 < 60, `BIS at t=15 min: ${bis15.toFixed(1)} (in clinical range 20-60)`);
}

console.log('\n===== 4. Target Change Mid-Case =====\n');

{
  const model = freshModel();
  model.planTCI('propofol', 0, 3.0, TCI);

  const c10 = model.getConcentrationsAt('propofol', 10);

  // Raise the target to 4.0 at t=10.
  model.planTCI('propofol', 10, 4.0, TCI);

  const curve = model.computeCurve('propofol', 10, 30, 10 / 60);
  const at25 = curve.find(p => p.time >= 25);
  ok(at25.Ce > c10.Ce, `After target increase: Ce at 25 min (${at25.Ce.toFixed(2)}) > Ce at 10 min (${c10.Ce.toFixed(2)})`);
  ok(Math.abs(at25.Ce - 4.0) < 1.0, `Ce approaching new target 4.0 (got ${at25.Ce.toFixed(2)})`);
}

console.log('\n===== 5. Manual Bolus During TCI =====\n');

{
  const model = freshModel();
  model.planTCI('propofol', 0, 3.0, TCI);

  const ceBefore = model.getConcentrationsAt('propofol', 5).Ce;

  // Manual rescue bolus at t=5 on top of the running TCI plan. A manual bolus
  // generates a rate-restore at its (realistic) delivery end that resumes the
  // active TCI rate; a TCI-sourced bolus deliberately would not (CLAUDE.md).
  model.addBolus('propofol', 5, 50, 'Manual rescue bolus', { deliveryMode: 'pump', source: 'manual' });

  const ceAfter = model.getConcentrationsAt('propofol', 6).Ce;
  ok(ceAfter > ceBefore, `Manual bolus at t=5 raises Ce: before=${ceBefore.toFixed(2)} (t=5), after=${ceAfter.toFixed(2)} (t=6)`);

  const events = model.getEvents('propofol');
  const restore = events.find(e => e.source === 'system' && e.time > 5);
  ok(restore !== undefined, 'Rate-restore event exists after manual bolus');
  ok(restore && restore.value > 0, `Restored rate resumes the active TCI rate: ${restore ? restore.value.toFixed(2) : 'n/a'} mg/min (not zero)`);
}

console.log('\n===== 6. Elderly Patient — Age-Adjusted PD =====\n');

{
  const model = freshModel({ age: 75, weight: 60, height: 165, male: false, opioid: true });

  const params = model.getParams();
  // Ce50 decreases with age (elderly ≈ 2.39 for 75y).
  ok(params.Ce50 < 2.6, `Elderly Ce50=${params.Ce50.toFixed(3)} (should be <2.6 due to aging)`);

  model.planTCI('propofol', 0, 2.0, TCI);

  const bis = model.predictBIS('propofol', 15);
  ok(bis > 20 && bis < 60, `Elderly BIS at t=15: ${bis.toFixed(1)} (anaesthetic range)`);

  const events = model.getEvents('propofol');
  const bolus = events.find(e => e.type === 'bolus');
  ok(bolus.value < 150, `Elderly bolus dose: ${bolus.value.toFixed(1)} mg (should be modest for a 60 kg elderly patient)`);
}

console.log('\n===== 7. computeCurve Resolution Check =====\n');

{
  const model = freshModel();
  model.planTCI('propofol', 0, 3.0, TCI);

  const curve10s = model.computeCurve('propofol', 0, 30, 10 / 60);
  ok(curve10s.length >= 180, `10s step: ${curve10s.length} points for 30 min`);

  const curve1m = model.computeCurve('propofol', 0, 30, 1.0);
  ok(curve1m.length === 31, `1 min step: ${curve1m.length} points for 30 min`);

  // Both resolutions sample the same underlying replay → agree at t=15.
  const ce10s = curve10s.find(p => Math.abs(p.time - 15) < 0.1);
  const ce1m = curve1m.find(p => p.time === 15);
  const diff = Math.abs(ce10s.Ce - ce1m.Ce);
  ok(diff < 0.05, `Ce at t=15 agrees between resolutions: diff=${diff.toFixed(4)}`);
}

resetPumpSettings();

// ===== SUMMARY =====
console.log(`\n${'='.repeat(50)}`);
console.log(`  TOTAL: ${passed} passed, ${failed} failed`);
console.log(`${'='.repeat(50)}\n`);
process.exit(failed ? 1 : 0);
