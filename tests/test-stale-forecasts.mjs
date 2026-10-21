/**
 * test-stale-forecasts.mjs — Next Up must not show the previous case's forecasts.
 *
 * Reported from use: the app was left open overnight, New Case the next
 * morning, and Next Up listed "Emergence" rows for ketamine and fentanyl with
 * targets nobody had set on this case — yesterday's targets, at yesterday's
 * arrival minutes read against today's clock.
 *
 * Next Up reads its forecasts out of two module-level, per-drug caches it does
 * not own: exit-readout.js (getEmergenceArrival) and approach.js
 * (getMilestones). Both survived New Case.
 *
 *  1. exit-readout: with no emergence target set, updateExitReadout blanked the
 *     card and returned early, leaving the last forecast in its cache — so the
 *     new case's Next Up kept it. The same early return kept a target the user
 *     *cleared* mid-case on the list.
 *  2. approach: updateApproachLine only runs once the case is started, but Next
 *     Up renders before that, so between confirming a patient and Start the
 *     previous case's redose and target forecasts were on the list.
 *
 * Driven through the real modules against a mini DOM.
 */

import { installMiniDom } from './helpers/mini-dom.mjs';

const dom = installMiniDom(['nu-list', 'nu-clock', 'nu-clock-label', 'hv-view-next',
                            'hv-tab-next', 'view-history', 'btn-nu-time']);

const { createModel } = await import('../js/sim/simulation.js');
const { resetPumpSettings } = await import('../js/util/constants.js');
const approach = await import('../js/ui/drug-panel/approach.js');
const exitReadout = await import('../js/ui/drug-panel/exit-readout.js');
const nextUp = await import('../js/ui/next-up.js');

let passed = 0, failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log('  ok   ' + msg); }
  else      { failed++; console.log('  FAIL ' + msg); }
}

const PATIENT = { age: 51, weight: 50.3, height: 152.4, male: false, opioid: true };
const K = 'ketamine', F = 'fentanyl';

// Fake wall clock for the readout's 1 s / 5 s throttles.
let fakeMs = 1_700_000_000_000;
Date.now = () => fakeMs;

function freshModel() {
  resetPumpSettings();
  const m = createModel();
  m.setPatient(PATIENT);
  return m;
}

/** One drug-panel pass for the exit readout, as drug-panel/index.js runs it. */
function exitFrame(model, drug, t, exitCe, caseStarted = true) {
  const el = { innerHTML: '' };
  const ctx = { $: () => el, model, getExitCeForDrug: () => exitCe, getExitCeLabelForDrug: () => `${exitCe}` };
  const Ce = caseStarted && t > 0 ? model.getConcentrationsAt(drug, t).Ce : 0;
  exitReadout.updateExitReadout(ctx, drug, t, Ce, caseStarted);
  return el.innerHTML;
}

/** Tick the readout once a simulated second over [from, to] minutes. */
function runExit(model, drug, from, to, exitCe) {
  for (let s = Math.round(from * 60); s <= Math.round(to * 60); s++) {
    fakeMs += 1000;
    exitFrame(model, drug, s / 60, exitCe);
  }
}

/** One drug-panel pass for the approach line (redose threshold). */
function approachFrame(model, drug, t, threshold) {
  approach.setCurveData(model.computeCurve(drug, 0, 600, 10 / 60));
  const { Ce, rate } = model.getConcentrationsAt(drug, t);
  const ctx = {
    $: () => null, model, getDrugId: () => drug,
    getIntermittentThresholdForDrug: () => threshold, getExitCeForDrug: () => 0,
    getSsSlopeTol: () => 0.01, getTciFraction: () => 0.95, getSsExitBand: () => 0.05,
  };
  approach.updateApproachLine(ctx, drug, t, 'none', Ce, threshold, rate);
}

function showNextUp(model, drugs, t) {
  nextUp.reset();
  nextUp.init({ model, getPatient: () => PATIENT, getDrugIds: () => drugs, getElapsedMinutes: () => t });
  nextUp.setActive(true);
  nextUp.render(t);
  return dom.rows();
}
const emergenceRows = rows => rows.filter(r => r.verb === 'Emergence');

// ── Case A (yesterday): ketamine pushed, an emergence target set ──────────────
console.log('\n  yesterday\'s case leaves an emergence forecast');
const A = freshModel();
A.addBolus(K, 0, 50, 'IV push 50 mg', { deliveryMode: 'push', source: 'manual' });
const exitA = A.getConcentrationsAt(K, 30).Ce / 2;       // reached well after ET 30
runExit(A, K, 20, 30, exitA);
const emA = exitReadout.getEmergenceArrival(K);
ok(emA.isIdle && emA.arrivalMin > 30 && emA.exitCe === exitA,
   `case A forecasts ketamine emergence at ET ${emA.arrivalMin?.toFixed(1)}`);
ok(emergenceRows(showNextUp(A, [K], 30)).length === 1, 'case A: Next Up lists it (as it should)');

// ── Case B (this morning): ketamine pushed again, no emergence target ────────
console.log('\n  this morning\'s case has no target');
const B = freshModel();
B.addBolus(K, 0, 50, 'IV push 50 mg', { deliveryMode: 'push', source: 'manual' });
// No New Case reset here on purpose: this pins the readout's own early return.
runExit(B, K, 5, 10, 0);
const emB = exitReadout.getEmergenceArrival(K);
ok(emB.arrivalMin === null && emB.exitCe === 0,
   `no target → no forecast (was ${emA.exitCe.toFixed(4)} at ET ${emA.arrivalMin.toFixed(1)}, yesterday's)`);
ok(emergenceRows(showNextUp(B, [K], 10)).length === 0,
   'case B: Next Up shows no Emergence row for a target nobody set');

// ── New Case resets the caches outright ───────────────────────────────────────
console.log('\n  New Case clears the caches');
runExit(A, K, 20, 30, exitA);
ok(exitReadout.getEmergenceArrival(K).arrivalMin !== null, 'precondition: a forecast is cached');
exitReadout.resetAll();
const emR = exitReadout.getEmergenceArrival(K);
ok(emR.arrivalMin === null && emR.exitCe === 0 && emR.isIdle === false,
   'resetAll(): getEmergenceArrival is empty before any frame runs');

// ── Before Start: the approach cache (redose forecasts) ──────────────────────
console.log('\n  before Start, no previous-case redose rows');
const C = freshModel();
C.addBolus(F, 0, 0.1, 'IV push 100 mcg', { deliveryMode: 'push', source: 'manual' });
const thrC = C.getConcentrationsAt(F, 20).Ce * 0.6;
approachFrame(C, F, 20, thrC);
const msC = approach.getMilestones(F);
ok(msC.kind === 'redose' && msC.arrivalMin > 20, `case C forecasts a fentanyl redose at ET ${msC.arrivalMin?.toFixed(1)}`);
// New case confirmed, not yet started: updateApproachLine does not run, but
// Next Up renders (t = 0).
const D = freshModel();
ok(showNextUp(D, [F], 0).some(r => r.verb === 'Redose due'),
   'precondition: without a reset, the pre-Start list shows case C\'s redose');
approach.resetAll();
ok(approach.getMilestones(F).kind === null, 'resetAll(): getMilestones is empty');
ok(!showNextUp(D, [F], 0).some(r => r.verb === 'Redose due'),
   'after the reset, the pre-Start list is clean');

// ── Mid-case: clearing a target removes its row ───────────────────────────────
console.log('\n  clearing the target mid-case');
exitReadout.resetAll();
runExit(A, K, 20, 30, exitA);
ok(emergenceRows(showNextUp(A, [K], 30)).length === 1, 'target set: the row is there');
runExit(A, K, 30, 30.1, 0);                    // the user clears it
ok(emergenceRows(showNextUp(A, [K], 30.1)).length === 0, 'target cleared: the row goes');

// ── Reached: nothing left to arrive at ────────────────────────────────────────
console.log('\n  emergence reached');
exitReadout.resetAll();
runExit(A, K, 20, 30, exitA);
const ceNow = A.getConcentrationsAt(K, 30).Ce;
exitFrame(A, K, 30, ceNow * 1.5);              // a target above Ce: reached
ok(exitReadout.getEmergenceArrival(K).arrivalMin === null, 'reached → no forecast');

// ── The wiring: drug-panel reset() is exported and resets both ───────────────
console.log('\n  drug-panel reset()');
const fs = await import('node:fs');
const shim = fs.readFileSync(new URL('../js/ui/drug-panel.js', import.meta.url), 'utf8');
const app = fs.readFileSync(new URL('../js/app.js', import.meta.url), 'utf8');
const index = fs.readFileSync(new URL('../js/ui/drug-panel/index.js', import.meta.url), 'utf8');
ok(/\breset,/.test(shim), 'the drug-panel shim re-exports reset');
ok(/export function reset\(\)\s*\{\s*resetApproach\(\);\s*resetExitReadout\(\);/.test(index), 'reset() clears both caches');
const initSim = app.slice(app.indexOf('function initSimScreen'), app.indexOf('function initSimScreen') + 4000);
ok(/drugPanel\.reset\(\)/.test(initSim), 'initSimScreen (every case entry) calls drugPanel.reset()');

console.log(`\n  ${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
