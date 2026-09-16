/**
 * test-next-up-refresh.mjs — the Next Up panel must repaint on the edit that
 * caused it.
 *
 * Reported from use: "changed drug redose threshold in intermittent mode; the
 * Next Up countdown did not update until I left the panel and reloaded it."
 * Two independent staleness bugs produced that, and both are pinned here.
 *
 *  1. Ordering. Clinical forecasts are not recomputed by next-up.js — it reads
 *     them out of the drug-panel approach caches, which the rAF pass refills.
 *     chart-bridge's refresh() invalidates those caches and then calls
 *     nextUp.render() in the same synchronous pass, so the milestones it
 *     collects are the pre-edit ones. The 500 ms rebuild throttle was the only
 *     thing that ever corrected it, and the throttle is measured in *sim*
 *     minutes — a paused clock never crosses it, so the stale snapshot stood
 *     until setActive() forced a rebuild. Hence "left the panel and came back".
 *
 *  2. The row-set signature. _renderList() rebuilds the list HTML only when the
 *     signature changes, and the signature was `key:elapsed`. A redose row's key
 *     is drug + kind + crossing generation — none of which a threshold edit
 *     touches — so the row kept rendering the old threshold value.
 *
 * Driven through the real module against a mini DOM, so what is asserted is
 * what would be on screen.
 */

import { installMiniDom } from './helpers/mini-dom.mjs';

const dom = installMiniDom(['nu-list', 'nu-clock', 'nu-clock-label', 'hv-view-next',
                            'hv-tab-next', 'view-history', 'btn-nu-time']);

const { createModel } = await import('../js/sim/simulation.js');
const { setCurveData, updateApproachLine } = await import('../js/ui/drug-panel/approach.js');
const nextUp = await import('../js/ui/next-up.js');

let passed = 0, failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log('  ok   ' + msg); }
  else      { failed++; console.log('  FAIL ' + msg); }
}
function eq(actual, expected, msg) {
  if (actual === expected) { passed++; console.log('  ok   ' + msg); }
  else { failed++; console.log(`  FAIL ${msg}\n         got=${actual}\n        want=${expected}`); }
}

const PATIENT = { age: 45, weight: 80, height: 178, male: true, opioid: false };
const DRUG = 'fentanyl';
const NOW  = 20;           // elapsed minutes — held still, as a paused clock would
const NG   = 1 / 1000;     // ng/mL → canonical mcg/mL

const model = createModel();
model.setPatient(PATIENT);
model.addBolus(DRUG, 0, 0.2, 'IV push 200 mcg');   // canonical mg

let threshold = 1.2 * NG;   // Ce is ~1.50 ng/mL at NOW, so every threshold here is a forecast

/** One drug-panel rAF pass: what index.js update() does for this drug. */
function drugPanelFrame(t) {
  const { Ce, rate } = model.getConcentrationsAt(DRUG, t);
  const ctx = {
    $: () => null,
    model,
    getDrugId: () => DRUG,
    getIntermittentThresholdForDrug: () => threshold,
    getExitCeForDrug: () => 0,
    getSsSlopeTol: () => 0.01,
    getTciFraction: () => 0.95,
    getSsExitBand: () => 0.05,
  };
  updateApproachLine(ctx, DRUG, t, 'none', Ce, threshold, rate);
}

/** What chart-bridge refresh() does, in its order. */
function refreshChart(t) {
  setCurveData(model.computeCurve(DRUG, 0, 600, 10 / 60));
  nextUp.render(t);
}

nextUp.init({
  model,
  getPatient: () => PATIENT,
  getDrugIds: () => [DRUG],
  getElapsedMinutes: () => NOW,
});
nextUp.setActive(true);

console.log('\n===== Next Up repaints on the edit that caused it =====\n');

// ── Baseline: a redose countdown against the first threshold ──────────────────
drugPanelFrame(NOW);
refreshChart(NOW);
nextUp.onFrame(NOW);

const before = dom.rows();
eq(before.length, 1, 'one row: the fentanyl redose forecast');
eq(before[0].verb, 'Redose due', 'row reads "Redose due"');
eq(before[0].value, '1.2', 'row shows the threshold it is counting down to');
ok(parseCountdown(before[0].time) > 0, `countdown is live (${before[0].time})`);

// ── The edit ──────────────────────────────────────────────────────────────────
// A lower threshold sits further down the decay curve, so the countdown must
// get longer. The clock does not move: this is the paused-clock case, which is
// what made the old throttle unable to recover.
threshold = 0.8 * NG;
refreshChart(NOW);                 // invalidates the caches, renders off the old ones
const midEdit = dom.rows();

drugPanelFrame(NOW);               // the rAF pass that refills them
nextUp.onFrame(NOW);               // ...and the frame that must pick them up

const after = dom.rows();
eq(after.length, 1, 'still one row after the edit');
eq(after[0].value, '0.8', 'row shows the NEW threshold');
ok(after[0].time !== midEdit[0].time,
   `countdown moved off the pre-edit value (${midEdit[0].time} → ${after[0].time})`);
ok(parseCountdown(after[0].time) > parseCountdown(before[0].time),
   'a lower threshold sits further down the decay curve, and the countdown grew');

// Ground truth: the row must agree with the predictor it claims to report.
const truth = model.predictTrough(DRUG, NOW, threshold);
ok(truth && truth.time !== null, 'predictTrough has an answer to compare against');
const shownMin = parseCountdown(after[0].time);
const wantMin  = truth.time - NOW;
ok(Math.abs(shownMin - wantMin) <= 1,
   `countdown matches predictTrough (shown ${after[0].time}, want ${wantMin.toFixed(1)} min)`);

// ── Raising it again, to prove it is not a one-way flush ──────────────────────
threshold = 1.0 * NG;
refreshChart(NOW);
drugPanelFrame(NOW);
nextUp.onFrame(NOW);

const raised = dom.rows();
eq(raised[0].value, '1.0', 'row follows the threshold back up');
ok(parseCountdown(raised[0].time) < shownMin,
   'a higher threshold is reached sooner, and the countdown says so');

// ── The clock above the list tracks it too ────────────────────────────────────
eq(dom.el('nu-clock-label').textContent, 'Fentanyl — Redose due',
   'the HUD clock names the same milestone');

/** "12:34" or "2h 05m" → minutes. */
function parseCountdown(txt) {
  const h = /^(\d+)h (\d+)m$/.exec(txt);
  if (h) return Number(h[1]) * 60 + Number(h[2]);
  const m = /^(\d+):(\d+)$/.exec(txt);
  if (m) return Number(m[1]) + Number(m[2]) / 60;
  return NaN;
}

console.log(`\n  ${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
