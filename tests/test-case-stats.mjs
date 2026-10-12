/**
 * test-case-stats.mjs — the Totals view: per-drug totals and average pump rate.
 *
 * Definitions under test (sim/case-stats.js, ui/case-totals.js):
 *   - Total = everything delivered by `now`; it must equal getCumulativeDose,
 *     which the Log's "Total delivered" strip and the reconcile baseline use.
 *   - Pump window = first pump delivery (pump bolus or non-zero rate) → last
 *     stop, or `now` while the pump runs. Pauses inside it are not subtracted.
 *   - Average pump rate = (infusion + pump boluses) ÷ window. IV pushes never
 *     count. Shown only once the drug has infused.
 *
 * Cases are built through the real model, so delivery durations and the
 * system rate-restore events after manual boluses are the production ones.
 */

globalThis.localStorage = {
  _d: {},
  getItem(k) { return this._d[k] ?? null; },
  setItem(k, v) { this._d[k] = String(v); },
  removeItem(k) { delete this._d[k]; },
};
const els = new Map();
globalThis.document = {
  getElementById: id => { if (!els.has(id)) els.set(id, { innerHTML: '' }); return els.get(id); },
  querySelectorAll: () => [],
};

const { createModel } = await import('../js/sim/simulation.js');
const { getCumulativeDose } = await import('../js/sim/events/query.js');
const { computeDrugStats } = await import('../js/sim/case-stats.js');
const { setPumpSettings, resetPumpSettings, DRUG_IDS } = await import('../js/util/constants.js');
const { formatValue } = await import('../js/util/units.js');
const caseTotals = await import('../js/ui/case-totals.js');

let passed = 0, failed = 0;
function near(actual, expected, msg, tol = 1e-6) {
  if (actual != null && Math.abs(actual - expected) <= tol) { passed++; console.log('  ok   ' + msg); }
  else { failed++; console.log(`  FAIL ${msg}\n         got=${actual}\n        want=${expected}`); }
}
function eq(actual, expected, msg) {
  if (actual === expected) { passed++; console.log('  ok   ' + msg); }
  else { failed++; console.log(`  FAIL ${msg}\n         got=${actual}\n        want=${expected}`); }
}
function ok(cond, msg) { eq(!!cond, true, msg); }

const PATIENT = { age: 45, weight: 70, height: 175, male: true, opioid: false };
const P = 'propofol';

function freshModel() {
  resetPumpSettings();
  const m = createModel();
  m.setPatient(PATIENT);
  return m;
}
const dur = (m) => (evt) => m.getEventList().getBolusDelivery(evt).duration;
const stats = (m, drug, now) => computeDrugStats(m.getEvents(drug), now, dur(m));
const cumulative = (m, drug, now) => getCumulativeDose(m.getEvents(drug), drug, now, dur(m)).totalMg;

// ---- A manual propofol case ----
//   0    pump bolus 100 mg (then a system rate-restore to 0 at its end)
//   1    rate 10 mg/min
//   20   pause
//   30   rate 8 mg/min
//   50   IV push 20 mg (infusion suspended for the push, then restored)
//   60   pause — the last stop
function manualCase() {
  const m = freshModel();
  m.addBolus(P, 0, 100, 'Bolus 100 mg', { deliveryMode: 'pump', source: 'manual' });
  m.addRate(P, 1, 10, 'Rate 10');
  m.addPause(P, 20, 'Pause');
  m.addRate(P, 30, 8, 'Rate 8');
  m.addBolus(P, 50, 20, 'IV push 20 mg', { deliveryMode: 'push', source: 'manual' });
  m.addPause(P, 60, 'Pause');
  return m;
}

console.log('\n  manual propofol case, pump stopped at ET 60, now ET 90');
{
  const m = manualCase();
  const pushEvt = m.getEvents(P).find(e => e.type === 'bolus' && e.deliveryMode === 'push');
  const pushDur = dur(m)(pushEvt);
  const s = stats(m, P, 90);
  const infusion = 19 * 10 + 20 * 8 + (10 - pushDur) * 8;
  near(s.totalMg, cumulative(m, P, 90), 'total equals getCumulativeDose (the Log total)');
  near(s.totalMg, 100 + 20 + infusion, 'total = pump bolus + push + infusion');
  near(s.infusionMg, infusion, 'infusion excludes the push interval, as the replay does');
  eq(s.pumpBolusCount, 1, 'one pump bolus');
  near(s.pumpBolusMg, 100, 'pump bolus 100 mg');
  eq(s.pushCount, 1, 'one IV push');
  near(s.pushMg, 20, 'push 20 mg');
  near(s.pumpStart, 0, 'pump window starts at the pump bolus (ET 0)');
  near(s.pumpEnd, 60, 'pump window ends at the last stop (ET 60)');
  eq(s.pumpRunning, false, 'pump not running');
  near(s.pumpWindowMin, 60, 'pauses (0.8–1, 20–30) are not subtracted from the window');
  near(s.avgPumpRateMgMin, (100 + infusion) / 60, 'avg = (infusion + pump bolus) ÷ window; the push is excluded');
}

console.log('\n  the same case while it is still running');
{
  const m = manualCase();
  const s = stats(m, P, 55);
  eq(s.pumpRunning, true, 'at ET 55 the pump is running');
  near(s.pumpEnd, 55, 'window runs to now');
  near(s.totalMg, cumulative(m, P, 55), 'total equals getCumulativeDose');
  near(s.avgPumpRateMgMin, (s.infusionMg + s.pumpBolusMg) / 55, 'avg over the window so far');

  const pushEvt = m.getEvents(P).find(e => e.type === 'bolus' && e.deliveryMode === 'push');
  const mid = 50 + dur(m)(pushEvt) / 2;
  const sp = stats(m, P, mid);
  eq(sp.pumpRunning, true, 'during an IV push the infusion pump still counts as running');
  near(sp.pumpEnd, mid, '…and the window runs to now, not to the push');
  near(sp.pushMg, 10, 'half of a push in progress counts half');
  near(sp.totalMg, cumulative(m, P, mid), 'total equals getCumulativeDose mid-push');

  const sb = stats(m, P, 0.4);
  eq(sb.pumpRunning, true, 'a pump bolus in progress is the pump running');
  near(sb.pumpBolusMg, 50, 'half-delivered pump bolus counts 50 mg');
  near(sb.totalMg, cumulative(m, P, 0.4), 'total equals getCumulativeDose mid-bolus');
}

console.log('\n  paused at now (pause at 20, now 25)');
{
  const m = manualCase();
  const s = stats(m, P, 25);
  eq(s.pumpRunning, false, 'paused → not running');
  near(s.pumpEnd, 20, 'window ends at the pause (the last stop so far)');
  near(s.avgPumpRateMgMin, (100 + 190) / 20, 'avg over ET 0 → 20');
}

console.log('\n  future events are ignored');
{
  const m = freshModel();
  m.addRate(P, 0, 5, 'Rate 5');
  m.addRate(P, 30, 50, 'Rate 50 (future)');
  const s = stats(m, P, 10);
  near(s.totalMg, 50, '10 min at 5 mg/min; the ET 30 step has not happened');
  near(s.avgPumpRateMgMin, 5, 'avg 5 mg/min');
}

console.log('\n  IV push only (fentanyl, pump off)');
{
  const m = freshModel();
  m.addBolus('fentanyl', 0, 0.1, 'IV push 100 mcg', { deliveryMode: 'push', source: 'manual' });
  m.addBolus('fentanyl', 30, 0.05, 'IV push 50 mcg', { deliveryMode: 'push', source: 'manual' });
  const s = stats(m, 'fentanyl', 60);
  near(s.totalMg, 0.15, 'total 150 mcg');
  eq(s.pushCount, 2, 'two pushes');
  eq(s.pumpStart, null, 'no pump window');
  eq(s.avgPumpRateMgMin, null, 'no average rate');
  near(s.totalMg, cumulative(m, 'fentanyl', 60), 'total equals getCumulativeDose');
}

console.log('\n  a TCI plan');
{
  const m = freshModel();
  m.planTCI(P, 0, 3);
  const s = stats(m, P, 30);
  near(s.totalMg, cumulative(m, P, 30), 'total equals getCumulativeDose');
  ok(s.pumpBolusCount >= 1, `the plan's induction bolus counts as a pump bolus (${s.pumpBolusCount})`);
  near(s.pumpStart, 0, 'pump window starts at ET 0');
  eq(s.pumpRunning, true, 'pump running at ET 30');
  near(s.avgPumpRateMgMin, s.totalMg / 30, 'avg = everything the pump gave ÷ 30 min (no pushes)');
}

// ---- The view ----

console.log('\n  Totals view');
{
  const m = manualCase();
  m.addBolus('fentanyl', 5, 0.1, 'IV push 100 mcg', { deliveryMode: 'push', source: 'manual' });
  let now = 90;
  let timeMode = 'et';
  caseTotals.init({
    model: m,
    getPatient: () => PATIENT,
    getDrugIds: () => DRUG_IDS,
    getElapsedMinutes: () => now,
    getTimeMode: () => timeMode,
    getWallClockStart: () => new Date(2026, 9, 5, 23, 10),
  });
  eq(document.getElementById('ct-list').innerHTML, '', 'nothing renders while the tab is hidden');
  caseTotals.setActive(true);
  const html = () => document.getElementById('ct-list').innerHTML;
  // Unwrap the no-wrap value parts first, then mark every other tag boundary.
  const text = () => html().replace(/<span class="ct-nb">([^<]*)<\/span>/g, '$1')
    .replace(/<[^>]+>/g, '|').replace(/\|+/g, '|');

  const s = stats(m, P, 90);
  const mlh = formatValue(s.avgPumpRateMgMin * 60 / 10, 'mL/h');
  const kg = formatValue(s.avgPumpRateMgMin * 1000 / 70, 'mcg/kg/min');
  ok(text().includes('Propofol'), 'propofol card');
  ok(text().includes(`Avg pump rate|${mlh} mL/h · ${kg} mcg/kg/min`),
     `avg rate in the working unit (mL/h) and per-kg: ${mlh} mL/h · ${kg} mcg/kg/min`);
  ok(text().includes('Pump time|1 h 00 min · ET 0:00 → ET 1:00'), 'pump time 1 h, ET 0:00 → ET 1:00');
  ok(text().includes('Pump bolus|1 · 100.0 mg'), 'pump bolus line');
  ok(text().includes('IV push|1 · 20.0 mg'), 'IV push line');
  ok(/Fentanyl\|100 mcg\| · 2\.00 mL/.test(text()), 'fentanyl card: 100 mcg · 2.00 mL');
  const fent = text().split('Fentanyl')[1];
  ok(!fent.includes('Avg pump rate'), 'a push-only drug shows no average rate');
  ok(text().indexOf('Propofol') < text().indexOf('Fentanyl'), 'cards follow DRUG_IDS order');

  now = 55;
  caseTotals.render();
  ok(text().includes('→ now'), 'a running pump reads "→ now"');

  timeMode = 'rt';
  caseTotals.render();
  ok(text().includes('RT 23:10 → now'), 'with the Log on RT, the window reads in clock time');

  setPumpSettings(P, { concentration: 20 });
  timeMode = 'et';
  now = 90;
  caseTotals.render();
  const s20 = stats(m, P, 90);
  ok(text().includes(`${formatValue(s20.avgPumpRateMgMin * 60 / 20, 'mL/h')} mL/h`),
     'mL/h follows the case concentration (2%)');
  resetPumpSettings();

  caseTotals.setActive(false);
  now = 1;
  caseTotals.onFrame(1);
  ok(text().includes('Pump time'), 'hidden tab: onFrame does not repaint');
}

console.log('\n  empty case');
{
  const m = freshModel();
  caseTotals.init({ model: m, getPatient: () => PATIENT, getDrugIds: () => DRUG_IDS, getElapsedMinutes: () => 10 });
  caseTotals.setActive(true);
  ok(document.getElementById('ct-list').innerHTML.includes('Nothing given yet'), 'empty state');
  caseTotals.setActive(false);
}

console.log(`\n  ${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
