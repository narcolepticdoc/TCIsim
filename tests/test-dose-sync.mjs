/**
 * test-dose-sync.mjs — the clock popover's Pump Total solve.
 *
 * sim/dose-sync.js solveElapsedForTotal answers "at what case time had the sim
 * delivered X?". Every answer is checked against getCumulativeDose — the Log's
 * "Total delivered" — because the point of the sync is that the Log then reads
 * the number the clinician typed. Cases are built through the real model so
 * delivery durations and rate-restore events are the production ones.
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
const { solveElapsedForTotal } = await import('../js/sim/dose-sync.js');
const { resetPumpSettings } = await import('../js/util/constants.js');

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
const total = (m, now, drug = P) => getCumulativeDose(m.getEvents(drug), drug, now, dur(m)).totalMg;
const solve = (m, mg, nearMin = 0, drug = P) =>
  solveElapsedForTotal(m.getEvents(drug), drug, mg, { getDeliveryMinutes: dur(m), nearMin });

// The Log must read the typed total at the solved time.
function roundTrips(m, mg, msg, nearMin = 0) {
  const r = solve(m, mg, nearMin);
  ok(r.ok, `${msg}: solved`);
  if (r.ok) near(total(m, r.minutes), mg, `${msg}: Log total at the solved time = ${mg} mg`, Math.max(1e-6, mg * 1e-6));
  return r;
}

// ---- A manual rate from case start ----
console.log('\n── manual rate ──');
{
  const m = freshModel();
  m.addRate(P, 0, 10, 'Rate 10 mg/min');
  const r = roundTrips(m, 235, 'rate 10 mg/min, 235 mg');
  near(r.minutes, 23.5, '… is 23.5 min of infusion');
  near(solve(m, 235, 50).minutes, 23.5, 'nearMin does not move a unique answer');
}

// ---- Induction bolus, then a rate (a starting-dose template) ----
console.log('\n── bolus + rate ──');
{
  const m = freshModel();
  m.addBolus(P, 0, 140, 'Bolus 140 mg', { deliveryMode: 'pump', source: 'manual' });
  const bolusEnd = dur(m)(m.getEvents(P).find(e => e.type === 'bolus'));
  ok(bolusEnd > 0.05, `the pump bolus takes time to deliver (${(bolusEnd * 60).toFixed(1)} s)`);
  m.addRate(P, bolusEnd, 8, 'Rate 8 mg/min');
  const mid = roundTrips(m, 70, 'half the bolus, still being delivered');
  ok(mid.minutes > 0 && mid.minutes < bolusEnd, '… lands inside the bolus delivery');
  near(mid.minutes, bolusEnd / 2, '… at its midpoint (the pump delivers it at a constant rate)');
  const after = roundTrips(m, 140 + 8 * 30, 'bolus + 30 min at 8 mg/min');
  near(after.minutes, bolusEnd + 30, '… is 30 min after the bolus ends');
}

// ---- A TCI plan from t = 0 ----
console.log('\n── TCI plan ──');
{
  const m = freshModel();
  m.planTCI(P, 0, 3, { tciMode: 'cet-emulation' });
  const evts = m.getEvents(P);
  const lastT = evts[evts.length - 1].time;
  ok(evts.length > 10, `the plan has many steps (${evts.length}), ending at ${lastT.toFixed(1)} min`);
  for (const t of [0.4, 7.3, 15, 42, 90]) {
    const mg = total(m, t);
    const r = roundTrips(m, mg, `plan total at ${t} min (${mg.toFixed(1)} mg)`);
    if (r.ok) near(r.minutes, t, `… is ${t} min`, 1e-4);
  }
  // After its bolus the plan holds the pump at 0 while Ce catches up, so the
  // total is flat there and every time in the hold fits. The clock's own
  // position decides: no move when it is already in the hold.
  const bolus = evts.find(e => e.type === 'bolus');
  const holdStart = bolus.time + dur(m)(bolus);
  const holdMg = total(m, 2);
  near(total(m, holdStart), holdMg, `the plan holds from ${holdStart.toFixed(2)} min to past 2 min`);
  near(solve(m, holdMg, 2).minutes, 2, 'in the hold, with the clock in it: no move');
  near(solve(m, holdMg, 0).minutes, holdStart, 'in the hold, with the clock before it: the hold\'s start', 1e-6);
  // Past the last step the terminal rate keeps going: any larger total is reachable.
  const beyond = total(m, lastT + 60);
  const r = roundTrips(m, beyond, 'a total past the plan\'s last step');
  if (r.ok) near(r.minutes, lastT + 60, '… solves on the terminal rate', 1e-4);
}

// ---- A pause plateau, and a ceiling ----
console.log('\n── pause plateau ──');
{
  const m = freshModel();
  m.addRate(P, 0, 10, 'Rate 10');
  m.addPause(P, 20, 'Pause');
  m.addRate(P, 30, 10, 'Rate 10');
  m.addPause(P, 40, 'Pause');
  // 200 mg holds from 20 to 30 min.
  near(solve(m, 200, 25).minutes, 25, 'on the plateau the clock already sits on: no move');
  near(solve(m, 200, 5).minutes, 20, 'from before it: the plateau\'s near end');
  near(solve(m, 200, 35).minutes, 30, 'from after it: the plateau\'s far end');
  // The final plateau is 300 mg, and nothing runs after it.
  near(solve(m, 300, 60).minutes, 60, 'on the final plateau: no move');
  const over = solve(m, 350, 10);
  eq(over.ok, false, 'more than the case ever delivers: no answer');
  eq(over.reason, 'unreachable', '… reported as unreachable');
  near(over.maxMg, 300, '… with the ceiling (300 mg)');
}

// ---- A negative dose reconciliation makes the total non-monotone ----
console.log('\n── negative reconciliation ──');
{
  const m = freshModel();
  m.addRate(P, 0, 10, 'Rate 10');
  // −50 mg at 10 min: 100 → 50, then rising again; 80 mg is reached at 8 min
  // and again at 13 min.
  m.addBolus(P, 10, -50, 'Dose reconciliation −50 mg', { deliveryMode: 'push', source: 'manual' });
  const a = roundTrips(m, 80, 'from early in the case', 2);
  near(a.minutes, 8, '… the earlier crossing (8 min)', 1e-3);
  const b = roundTrips(m, 80, 'from later in the case', 20);
  ok(b.minutes > 10 && b.minutes < 15, `… the later crossing (${b.minutes.toFixed(3)} min)`);
}

// ---- Nothing to sync to, and bad input ----
console.log('\n── edge cases ──');
{
  const m = freshModel();
  eq(solve(m, 100).reason, 'nothing', 'no events: nothing to sync to');
  m.addRate(P, 0, 0, 'Rate 0');
  eq(solve(m, 100).reason, 'nothing', 'a rate of 0: nothing to sync to');
  const m2 = freshModel();
  m2.addRate(P, 0, 10, 'Rate 10');
  eq(solve(m2, 0).reason, 'invalid', 'a total of 0 is invalid');
  eq(solve(m2, -5).reason, 'invalid', 'a negative total is invalid');
  eq(solve(m2, NaN).reason, 'invalid', 'NaN is invalid');
}

console.log(`\n  ${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
