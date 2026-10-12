/**
 * test-case-stats.mjs — the Totals view: per-drug totals and average rate.
 *
 * Definitions under test (sim/case-stats.js, ui/case-totals.js), as the user
 * set them:
 *   - Total = everything delivered by `now`; it must equal getCumulativeDose,
 *     which the Log's "Total delivered" strip and the reconcile baseline use.
 *   - Case time is global: the first time any drug was given, by any route,
 *     to the last time any drug was given (the end of the last delivery), or
 *     `now` while something is still being given. Gaps are not subtracted.
 *   - Each drug's average rate = its total ÷ that one case time. Shown once
 *     the case has a span: an infusion of any drug, or two doses between them.
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
const { computeDrugStats, computeCaseStats } = await import('../js/sim/case-stats.js');
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
const caseOf = (m, now, drugs = DRUG_IDS) =>
  computeCaseStats(drugs.map(d => [d, m.getEvents(d)]), now, dur(m));
const avgOf = (c, drug) => c.drugs.find(d => d.drugId === drug)?.avgRateMgMin ?? null;
const pushOf = (m, drug, time) => m.getEvents(drug).find(e => e.type === 'bolus' && e.time === time);

// ---- A manual propofol case ----
//   0    pump bolus 100 mg (then a system rate-restore to 0 at its end)
//   1    rate 10 mg/min
//   20   pause
//   30   rate 8 mg/min
//   50   IV push 20 mg (infusion suspended for the push, then restored)
//   60   pause — the last time drug was given
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

console.log('\n  manual propofol case, last given ET 60, now ET 90');
{
  const m = manualCase();
  const pushDur = dur(m)(pushOf(m, P, 50));
  const s = stats(m, P, 90);
  const infusion = 19 * 10 + 20 * 8 + (10 - pushDur) * 8;
  near(s.totalMg, cumulative(m, P, 90), 'total equals getCumulativeDose (the Log total)');
  near(s.totalMg, 100 + 20 + infusion, 'total = pump bolus + push + infusion');
  near(s.infusionMg, infusion, 'infusion excludes the push interval, as the replay does');
  eq(s.pumpBolusCount, 1, 'one pump bolus');
  near(s.pumpBolusMg, 100, 'pump bolus 100 mg');
  eq(s.pushCount, 1, 'one IV push');
  near(s.pushMg, 20, 'push 20 mg');
  near(s.firstGiven, 0, 'first given at ET 0 (the pump bolus)');
  near(s.lastGiven, 60, 'last given at ET 60 (the infusion stopped)');
  eq(s.givingNow, false, 'not being given at ET 90');
  const c = caseOf(m, 90);
  near(c.caseTimeMin, 60, 'case time 60 min; the gaps (0.8–1, 20–30) are not subtracted');
  near(avgOf(c, P), s.totalMg / 60, 'avg = total ÷ case time');
}

console.log('\n  the same case while it is still being given');
{
  const m = manualCase();
  const s = stats(m, P, 55);
  eq(s.givingNow, true, 'at ET 55 the infusion is running');
  near(s.lastGiven, 55, 'case time runs to now');
  near(s.totalMg, cumulative(m, P, 55), 'total equals getCumulativeDose');
  near(avgOf(caseOf(m, 55), P), s.totalMg / 55, 'avg = total so far ÷ case time so far');

  const mid = 50 + dur(m)(pushOf(m, P, 50)) / 2;
  const sp = stats(m, P, mid);
  eq(sp.givingNow, true, 'during an IV push the drug is being given');
  near(sp.lastGiven, mid, '…and the case time runs to now');
  near(sp.pushMg, 10, 'half of a push in progress counts half');
  near(sp.totalMg, cumulative(m, P, mid), 'total equals getCumulativeDose mid-push');

  const sb = stats(m, P, 0.4);
  eq(sb.givingNow, true, 'a pump bolus in progress is being given');
  near(sb.pumpBolusMg, 50, 'half-delivered pump bolus counts 50 mg');
  near(sb.totalMg, cumulative(m, P, 0.4), 'total equals getCumulativeDose mid-bolus');
}

console.log('\n  paused at now (pause at 20, now 25)');
{
  const m = manualCase();
  const s = stats(m, P, 25);
  eq(s.givingNow, false, 'paused → not being given');
  near(s.lastGiven, 20, 'last given at the pause');
  near(avgOf(caseOf(m, 25), P), (100 + 190) / 20, 'avg over ET 0 → 20');
  near(s.totalMg, cumulative(m, P, 25), 'total equals getCumulativeDose');
}

console.log('\n  IV pushes before the pump and after it stopped');
{
  // An induction push at ET 0 starts the case time; a push after the pump
  // stopped extends it. Pump ET 10–90 with a pause 40–60.
  const m = freshModel();
  m.addBolus(P, 0, 50, 'IV push 50 mg', { deliveryMode: 'push', source: 'manual' });
  m.addRate(P, 10, 10, 'Rate 10');
  m.addPause(P, 40, 'Pause');
  m.addRate(P, 60, 10, 'Rate 10');
  m.addPause(P, 90, 'Stop');
  m.addBolus(P, 100, 20, 'IV push 20 mg', { deliveryMode: 'push', source: 'manual' });
  const lateEnd = 100 + dur(m)(pushOf(m, P, 100));
  const s = stats(m, P, 120);
  near(s.firstGiven, 0, 'first given at the induction push, before the pump');
  near(s.lastGiven, lateEnd, 'last given at the end of the push after the stop');
  near(caseOf(m, 120).caseTimeMin, lateEnd, 'case time ET 0 → that push, pause included');
  near(s.pushMg, 70, 'both pushes counted');
  near(avgOf(caseOf(m, 120), P), s.totalMg / lateEnd, 'avg = total (pushes included) ÷ case time');
  near(s.totalMg, cumulative(m, P, 120), 'total equals getCumulativeDose');
}

console.log('\n  future events are ignored');
{
  const m = freshModel();
  m.addRate(P, 0, 5, 'Rate 5');
  m.addRate(P, 30, 50, 'Rate 50 (future)');
  const s = stats(m, P, 10);
  near(s.totalMg, 50, '10 min at 5 mg/min; the ET 30 step has not happened');
  near(avgOf(caseOf(m, 10), P), 5, 'avg 5 mg/min');
  near(s.totalMg, cumulative(m, P, 10), 'total equals getCumulativeDose');
}

console.log('\n  "last time given" is delivery, not pump state');
{
  // A TCI step-down: the plan holds at 0 (the Log's "Paused"), then resumes.
  const m = freshModel();
  m.planTCI(P, 0, 4);
  m.planTCI(P, 30, 2);
  const hold = m.getEvents(P).find(e => e.type === 'rate' && e.source === 'tci' && e.value === 0 && e.time >= 30);
  const resume = m.getEvents(P).find(e => e.type === 'rate' && e.value > 0 && e.time > hold.time);
  ok(hold && resume, `the step-down holds at ET ${hold?.time.toFixed(1)} and resumes at ET ${resume?.time.toFixed(1)}`);
  const mid = (hold.time + resume.time) / 2;
  const h = stats(m, P, mid);
  eq(h.givingNow, false, 'during a TCI hold nothing is being given');
  near(h.lastGiven, hold.time, '…so the case time ends where delivery paused');
  near(h.totalMg, cumulative(m, P, mid), 'total equals getCumulativeDose in the hold');
  const after = stats(m, P, resume.time + 5);
  near(after.lastGiven, resume.time + 5, 'once delivery resumes, the case time runs to now, the hold included');

  // Stop pressed during the hold: the last time drug was given is still the
  // start of the hold.
  m.addPause(P, mid, 'Pump stopped');
  m.clearAfter(P, mid);
  const st = stats(m, P, mid + 15);
  near(st.lastGiven, hold.time, 'a Stop does not move the last time drug was given');
  near(avgOf(caseOf(m, mid + 15), P), st.totalMg / hold.time, 'avg over ET 0 → the last delivery');
  near(st.totalMg, cumulative(m, P, mid + 15), 'total equals getCumulativeDose after Stop');
}
{
  // A pump bolus during a hold is drug given.
  const m = freshModel();
  m.addRate(P, 0, 10, 'Rate 10', { source: 'tci' });
  m.addRate(P, 20, 0, 'TCI hold', { source: 'tci' });
  m.addRate(P, 40, 8, 'TCI resume', { source: 'tci' });
  m.addBolus(P, 25, 20, 'Bolus 20 mg', { deliveryMode: 'pump', source: 'manual' });
  const s = stats(m, P, 35);
  near(s.lastGiven, 25 + dur(m)(pushOf(m, P, 25)), 'a bolus inside the hold is the last time given');
  near(s.totalMg, cumulative(m, P, 35), 'total equals getCumulativeDose');
}

console.log('\n  IV push only (fentanyl, pump off)');
{
  const m = freshModel();
  m.addBolus('fentanyl', 0, 0.1, 'IV push 100 mcg', { deliveryMode: 'push', source: 'manual' });
  m.addBolus('fentanyl', 30, 0.05, 'IV push 50 mcg', { deliveryMode: 'push', source: 'manual' });
  const end = 30 + dur(m)(pushOf(m, 'fentanyl', 30));
  const s = stats(m, 'fentanyl', 60);
  near(s.totalMg, 0.15, 'total 150 mcg');
  eq(s.pushCount, 2, 'two pushes');
  near(s.lastGiven - s.firstGiven, end, 'given from the first push to the end of the last');
  near(avgOf(caseOf(m, 60), 'fentanyl'), 0.15 / end, 'avg = 150 mcg ÷ case time');
  near(s.totalMg, cumulative(m, 'fentanyl', 60), 'total equals getCumulativeDose');
}

console.log('\n  a TCI plan');
{
  const m = freshModel();
  m.planTCI(P, 0, 3);
  const s = stats(m, P, 30);
  near(s.totalMg, cumulative(m, P, 30), 'total equals getCumulativeDose');
  ok(s.pumpBolusCount >= 1, `the plan's induction bolus counts as a pump bolus (${s.pumpBolusCount})`);
  near(s.firstGiven, 0, 'first given at ET 0');
  eq(s.givingNow, true, 'infusing at ET 30');
  near(avgOf(caseOf(m, 30), P), s.totalMg / 30, 'avg = everything given ÷ 30 min');
}

console.log('\n  one case time for every drug');
{
  // Propofol infused ET 10–60; fentanyl pushed at ET 0 and ET 90.
  const m = freshModel();
  m.addBolus('fentanyl', 0, 0.1, 'IV push 100 mcg', { deliveryMode: 'push', source: 'manual' });
  m.addRate(P, 10, 10, 'Rate 10');
  m.addPause(P, 60, 'Stop');
  m.addBolus('fentanyl', 90, 0.05, 'IV push 50 mcg', { deliveryMode: 'push', source: 'manual' });
  const end = 90 + dur(m)(pushOf(m, 'fentanyl', 90));
  const c = caseOf(m, 120);
  near(c.firstGiven, 0, 'the case starts at the first drug given (fentanyl, ET 0)');
  near(c.lastGiven, end, 'and ends at the last drug given (fentanyl, ET 90)');
  near(c.caseTimeMin, end, 'one case time');
  near(avgOf(c, P), 500 / end, 'propofol: its 500 mg ÷ the case time, not ÷ its own 50 min');
  near(avgOf(c, 'fentanyl'), 0.15 / end, 'fentanyl: its 150 mcg ÷ the same case time');
  eq(c.drugs.map(d => d.drugId).join(','), 'propofol,fentanyl', 'drugs in DRUG_IDS order; ketamine (nothing given) left out');
  eq(c.hasSpan, true, 'an infusion gives the case a span');
}
{
  // Anything still being given keeps the case open.
  const m = freshModel();
  m.addRate(P, 0, 10, 'Rate 10');
  m.addPause(P, 30, 'Stop');
  m.addRate('ketamine', 20, 0.5, 'Rate 0.5');
  const c = caseOf(m, 50);
  eq(c.givingNow, true, 'ketamine still running → the case is still going');
  near(c.lastGiven, 50, 'case time runs to now');
  near(avgOf(c, P), 300 / 50, 'propofol stopped at 30 but averages over the whole 50 min');
}
{
  const m = freshModel();
  m.addBolus('fentanyl', 0, 0.1, 'IV push 100 mcg', { deliveryMode: 'push', source: 'manual' });
  const one = caseOf(m, 20);
  eq(one.hasSpan, false, 'a single dose in the whole case: no span');
  eq(avgOf(one, 'fentanyl'), null, '…and no average');
  m.addBolus('ketamine', 30, 20, 'IV push 20 mg', { deliveryMode: 'push', source: 'manual' });
  const two = caseOf(m, 40);
  eq(two.hasSpan, true, 'two doses, even of different drugs, give the case a span');
  const end = 30 + dur(m)(pushOf(m, 'ketamine', 30));
  near(avgOf(two, 'fentanyl'), 0.1 / end, 'fentanyl averages over the global case time');
  near(avgOf(two, 'ketamine'), 20 / end, 'ketamine too, though it was given once');
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
  eq(document.getElementById('tot-list').innerHTML, '', 'nothing renders while the tab is hidden');
  caseTotals.setActive(true);
  const html = () => document.getElementById('tot-list').innerHTML;
  // Unwrap the no-wrap value parts first, then mark every other tag boundary.
  const text = () => html().replace(/<span class="tot-nb">([^<]*)<\/span>/g, '$1')
    .replace(/<[^>]+>/g, '|').replace(/\|+/g, '|');

  const avgP = avgOf(caseOf(m, 90), P);
  const mlh = formatValue(avgP * 60 / 10, 'mL/h');
  const kg = formatValue(avgP * 1000 / 70, 'mcg/kg/min');
  ok(text().includes('Propofol'), 'propofol card');
  ok(text().includes(`Avg rate|${mlh} mL/h · ${kg} mcg/kg/min`),
     `avg rate in the working unit (mL/h) and per-kg: ${mlh} mL/h · ${kg} mcg/kg/min`);
  ok(text().startsWith('|Case time|1 h 00 min · ET 0:00 → ET 1:00|'), 'one case-time line, above the cards: 1 h, ET 0:00 → ET 1:00');
  eq(text().split('Case time').length - 1, 1, 'the case time appears once, not per card');
  ok(text().includes('Pump bolus|1 · 100.0 mg'), 'pump bolus line');
  ok(text().includes('IV push|1 · 20.0 mg'), 'IV push line');
  ok(/Fentanyl\|100 mcg\| · 2\.00 mL/.test(text()), 'fentanyl card: 100 mcg · 2.00 mL');
  const fent = text().split('Fentanyl')[1];
  ok(fent.includes('Avg rate'), 'fentanyl, pushed once, still averages over the global case time');
  ok(text().indexOf('Propofol') < text().indexOf('Fentanyl'), 'cards follow DRUG_IDS order');

  now = 55;
  caseTotals.render();
  ok(text().includes('→ now'), 'a drug still being given reads "→ now"');

  timeMode = 'rt';
  caseTotals.render();
  ok(text().includes('RT 23:10 → now'), 'with the Log on RT, the window reads in clock time');

  setPumpSettings(P, { concentration: 20 });
  timeMode = 'et';
  now = 90;
  caseTotals.render();
  ok(text().includes(`${formatValue(avgOf(caseOf(m, 90), P) * 60 / 20, 'mL/h')} mL/h`),
     'mL/h follows the case concentration (2%)');
  resetPumpSettings();

  // While hidden, neither render() nor onFrame() touches the DOM — even past
  // the 1 s throttle and with the case changing underneath.
  caseTotals.setActive(false);
  const before = html();
  now = 1;
  caseTotals.render();
  eq(html(), before, 'hidden tab: render() does not repaint');
  const realNow = Date.now;
  Date.now = () => realNow() + 5000;
  caseTotals.onFrame(1);
  Date.now = realNow;
  eq(html(), before, 'hidden tab: onFrame() does not repaint, even past the throttle');
  caseTotals.setActive(true);
  ok(html() !== before, 'showing the tab repaints at once');
  // Visible: onFrame repaints once the throttle has passed, and not before.
  now = 55;
  caseTotals.onFrame(55);
  eq(text().includes('→ now'), false, 'visible: onFrame inside the 1 s throttle does not repaint');
  Date.now = () => realNow() + 5000;
  caseTotals.onFrame(55);
  Date.now = realNow;
  ok(text().includes('→ now'), 'visible: onFrame past the throttle repaints');
  caseTotals.setActive(false);
}

console.log('\n  view details');
{
  const m = freshModel();
  m.addBolus(P, 0, 100, 'Bolus 100 mg', { deliveryMode: 'pump', source: 'manual' });
  m.addRate('fentanyl', 0, 0.0014, 'Rate 0.02 mcg/kg/min');   // 0.02 mcg/kg/min at 70 kg
  caseTotals.init({ model: m, getPatient: () => PATIENT, getDrugIds: () => DRUG_IDS, getElapsedMinutes: () => 30 });
  caseTotals.setActive(true);
  const t = document.getElementById('tot-list').innerHTML
    .replace(/<span class="tot-nb">([^<]*)<\/span>/g, '$1').replace(/<[^>]+>/g, '|').replace(/\|+/g, '|');
  const prop = t.split('Fentanyl')[0];
  ok(prop.includes('Avg rate'), 'with fentanyl infusing, propofol (one pump bolus) has an average over the case time');
  ok(prop.includes('Pump bolus|1 · 100.0 mg'), '…and the bolus is listed');
  ok(t.includes('Avg rate|0.02 mcg/kg/min · 84 mcg/h'), 'a fentanyl average reads 0.02 mcg/kg/min, not 0; pump off → mcg/h companion, not mL/h');
  setPumpSettings('fentanyl', { pumpEnabled: true });
  caseTotals.render();
  ok(document.getElementById('tot-list').innerHTML.includes('0.02 mcg/kg/min</span> · <span class="tot-nb">1.7 mL/h'),
     'pump on → the companion is mL/h (84 mcg/h at 50 mcg/mL)');
  m.addBolus(P, 20, 50, 'IV push 50 mg', { deliveryMode: 'push', source: 'manual' });
  setPumpSettings(P, { concentration: 20 });
  caseTotals.render();
  ok(document.getElementById('tot-list').innerHTML.includes('>7.50 mL<'), 'total mL follows the case concentration (150 mg at 2% = 7.5 mL)');
  resetPumpSettings();
  caseTotals.setActive(false);
}

console.log('\n  doses given together are not a span');
{
  // An induction template at ET 0: fentanyl and ketamine pushed together, and
  // a propofol pump bolus. By the definition that is a case time of 0.
  const m = freshModel();
  m.addBolus('fentanyl', 0, 0.1, 'IV push 100 mcg', { deliveryMode: 'push', source: 'manual' });
  m.addBolus('ketamine', 0, 30, 'IV push 30 mg', { deliveryMode: 'push', source: 'manual' });
  m.addBolus(P, 0, 150, 'Bolus 150 mg', { deliveryMode: 'pump', source: 'manual' });
  const c = caseOf(m, 3);
  eq(c.hasSpan, false, 'three doses at ET 0 overlap: no span');
  eq(avgOf(c, P), null, '…so no average (it would read the pump\'s bolus rate, 750 mL/h)');
  eq(avgOf(c, 'ketamine'), null, '…for any drug');
  // A dose that starts after another has finished opens a real span.
  m.addBolus('fentanyl', 15, 0.05, 'IV push 50 mcg', { deliveryMode: 'push', source: 'manual' });
  const c2 = caseOf(m, 20);
  eq(c2.hasSpan, true, 'a later dose gives the case a span');
  near(avgOf(c2, P), 150 / c2.caseTimeMin, 'propofol averages over ET 0 → that dose');
}

console.log('\n  dose reconciliations');
{
  // A downward single-bolus correction (reconcile-modal: a negative push at
  // the default ET 0) is in the total but is not a time drug was given.
  const m = freshModel();
  m.addBolus('fentanyl', 5, 0.1, 'IV push 100 mcg', { deliveryMode: 'push', source: 'manual' });
  m.addRate(P, 5, 10, 'Rate 10');
  const before = caseOf(m, 65);
  m.addBolus(P, 0, -50, 'Dose reconciliation −50 mg', { deliveryMode: 'push', source: 'manual' });
  const after = caseOf(m, 65);
  const sp = after.drugs.find(d => d.drugId === P);
  near(sp.totalMg, cumulative(m, P, 65), 'total (with the correction) equals getCumulativeDose');
  near(sp.correctionMg, -50, 'the −50 mg is a correction');
  eq(sp.pushCount, 0, '…not an IV push');
  near(sp.infusionMg + sp.pumpBolusMg + sp.pushMg + sp.correctionMg, sp.totalMg, 'the split adds up to the total');
  near(after.firstGiven, before.firstGiven, 'the case still starts at ET 5, not at the correction');
  near(avgOf(after, 'fentanyl'), avgOf(before, 'fentanyl'), 'other drugs\' averages unchanged');
}
{
  // A correction does not make a lone dose into a span.
  const m = freshModel();
  m.addBolus(P, 10, 100, 'Bolus 100 mg', { deliveryMode: 'pump', source: 'manual' });
  m.addBolus(P, 0, -20, 'Dose reconciliation −20 mg', { deliveryMode: 'push', source: 'manual' });
  eq(caseOf(m, 40).hasSpan, false, 'one dose plus a correction: still no span');
}
{
  // A drug corrected back to nothing has no card and no say in the case time.
  const m = freshModel();
  m.addRate(P, 10, 10, 'Rate 10');
  m.addPause(P, 60, 'Stop');
  m.addBolus('fentanyl', 90, 0.1, 'IV push 100 mcg', { deliveryMode: 'push', source: 'manual' });
  m.addBolus('fentanyl', 0, -0.1, 'Dose reconciliation −100 mcg', { deliveryMode: 'push', source: 'manual' });
  const c = caseOf(m, 120);
  eq(c.drugs.map(d => d.drugId).join(','), 'propofol', 'fentanyl (net 0) has no card');
  near(c.caseTimeMin, 50, 'and the case time is propofol\'s ET 10 → 60, not stretched to ET 90');
}
{
  // A downward spread correction on a push-only drug: a negative rate.
  const m = freshModel();
  m.addBolus('fentanyl', 5, 0.1, 'IV push 100 mcg', { deliveryMode: 'push', source: 'manual' });
  m.addBolus('fentanyl', 40, 0.05, 'IV push 50 mcg', { deliveryMode: 'push', source: 'manual' });
  m.applyRateAugmentation('fentanyl', 0, 65, -0.05 / 65);
  const f = caseOf(m, 70).drugs.find(d => d.drugId === 'fentanyl');
  near(f.totalMg, cumulative(m, 'fentanyl', 70), 'total equals getCumulativeDose');
  ok(f.correctionMg < 0 && f.infusionMg === 0, 'the negative spread is a correction, not infusion');
  near(f.infusionMg + f.pumpBolusMg + f.pushMg + f.correctionMg, f.totalMg, 'the split adds up to the total');
  caseTotals.init({ model: m, getPatient: () => PATIENT, getDrugIds: () => DRUG_IDS, getElapsedMinutes: () => 70 });
  caseTotals.setActive(true);
  const t = document.getElementById('tot-list').innerHTML
    .replace(/<span class="tot-nb">([^<]*)<\/span>/g, '$1').replace(/<[^>]+>/g, '|').replace(/\|+/g, '|');
  ok(/Correction\|-50(\.0)? mcg/.test(t), `the card shows the correction line (${t.match(/Correction\|[^|]*/)?.[0]})`);
  caseTotals.setActive(false);
}

console.log('\n  a push-only drug never leads with mL/h');
{
  // A working rate unit of mL/h can survive from a setup default chosen while
  // the pump was on.
  const m = freshModel();
  m.addBolus('fentanyl', 1, 0.1, 'IV push 100 mcg', { deliveryMode: 'push', source: 'manual' });
  m.addBolus('fentanyl', 30, 0.05, 'IV push 50 mcg', { deliveryMode: 'push', source: 'manual' });
  localStorage.setItem('tci-pref-rateUnit-fentanyl', 'mL/h');
  caseTotals.init({ model: m, getPatient: () => PATIENT, getDrugIds: () => DRUG_IDS, getElapsedMinutes: () => 40 });
  caseTotals.setActive(true);
  const h = document.getElementById('tot-list').innerHTML;
  ok(!h.includes('mL/h') && h.includes('mcg/kg/min'), 'pump off: per-kg leads and no mL/h appears');
  caseTotals.setActive(false);
  localStorage.removeItem('tci-pref-rateUnit-fentanyl');
}

console.log('\n  a single dose in the whole case');
{
  const m = freshModel();
  m.addBolus(P, 0, 100, 'IV push 100 mg', { deliveryMode: 'push', source: 'manual' });
  caseTotals.init({ model: m, getPatient: () => PATIENT, getDrugIds: () => DRUG_IDS, getElapsedMinutes: () => 10 });
  caseTotals.setActive(true);
  const h = document.getElementById('tot-list').innerHTML;
  ok(h.includes('100.0 mg'), 'the dose is listed');
  ok(!h.includes('Case time') && !h.includes('Avg rate'), 'no case time and no average from one dose');
  caseTotals.setActive(false);
}

console.log('\n  empty case');
{
  const m = freshModel();
  caseTotals.init({ model: m, getPatient: () => PATIENT, getDrugIds: () => DRUG_IDS, getElapsedMinutes: () => 10 });
  caseTotals.setActive(true);
  ok(document.getElementById('tot-list').innerHTML.includes('Nothing given yet'), 'empty state');
  caseTotals.setActive(false);
}

console.log(`\n  ${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
