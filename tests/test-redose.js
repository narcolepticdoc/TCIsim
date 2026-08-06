/**
 * test-redose.js — One-touch redose dose selection (js/sim/redose.js).
 *
 * The Redose button repeats a dose without showing it to the user first, so
 * *which* dose it picks is the whole safety surface. These tests pin that
 * choice against a real event list built by the real model.
 *
 * The button's visibility rule (hidden in TCI mode) and its label formatting
 * live in `mode.js` / `app.js`, which need a DOM and are covered by the
 * browser pass instead — see DEVELOPMENT.md.
 */

const path = require('path');
const { pathToFileURL } = require('url');

let passed = 0, failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log(`  ✓ ${msg}`); }
  else { failed++; console.error(`  ✗ ${msg}`); }
}
function summary() {
  console.log(`\n${'='.repeat(50)}`);
  console.log(`  TOTAL: ${passed} passed, ${failed} failed`);
  console.log(`${'='.repeat(50)}\n`);
  process.exit(failed ? 1 : 0);
}

const _store = new Map();
global.localStorage = {
  getItem: k => (_store.has(k) ? _store.get(k) : null),
  setItem: (k, v) => { _store.set(k, String(v)); },
  removeItem: k => { _store.delete(k); },
  clear: () => { _store.clear(); },
};

const u = (...p) => pathToFileURL(path.join(__dirname, '..', ...p)).href;
const PATIENT = { age: 45, weight: 80, height: 175, male: true, opioid: false };

(async () => {
  const { createModel } = await import(u('js/sim/simulation.js'));
  const { findRedoseBolus } = await import(u('js/sim/redose.js'));
  const { getWorkingUnit, getPrefKey, getDefaultUnit } = await import(u('js/util/units.js'));

  const fresh = () => {
    const m = createModel({ primaryDrug: 'propofol' });
    m.setPatient(PATIENT);
    return m;
  };

  // ── Picking the dose ─────────────────────────────────────────────────────
  console.log('\n── Dose selection ──');
  {
    const m = fresh();
    ok(findRedoseBolus(m.getEvents('fentanyl')) === null,
      'no boluses yet → nothing to redose');

    m.addBolus('fentanyl', 1, 0.1, 'IV Push 100 mcg', { deliveryMode: 'push' });
    let r = findRedoseBolus(m.getEvents('fentanyl'));
    ok(r !== null && Math.abs(r.value - 0.1) < 1e-12, 'picks the only bolus (0.1 mg)');
    ok(r.deliveryMode === 'push', 'carries its delivery mode');

    m.addBolus('fentanyl', 10, 0.05, 'IV Push 50 mcg', { deliveryMode: 'push' });
    r = findRedoseBolus(m.getEvents('fentanyl'));
    ok(Math.abs(r.value - 0.05) < 1e-12, 'picks the LAST bolus, not the first');
    ok(Math.abs(r.time - 10) < 1e-9, 'reports when it was given');

    // A later bolus on another drug must not leak across.
    m.addBolus('ketamine', 20, 30, 'IV Push 30 mg', { deliveryMode: 'push' });
    ok(Math.abs(findRedoseBolus(m.getEvents('fentanyl')).value - 0.05) < 1e-12,
      'another drug\'s bolus does not leak in');
  }

  // ── TCI-sourced boluses are skipped ──────────────────────────────────────
  console.log('\n── TCI loading doses ──');
  {
    const m = fresh();
    m.planTCI('propofol', 0, 3.0, { tciMode: 'cet-emulation', ceTolerance: 0.015 });
    const tciBoluses = m.getEvents('propofol').filter(e => e.type === 'bolus' && e.source === 'tci');
    ok(tciBoluses.length > 0, 'the plan really did emit a loading bolus');
    ok(findRedoseBolus(m.getEvents('propofol')) === null,
      'a TCI loading bolus is never offered as a redose');

    // A hand-entered bolus afterwards IS offered — and the earlier TCI dose,
    // though larger and later in nothing but source, must not win.
    m.clearAfter('propofol', 20);
    m.addBolus('propofol', 20, 40, 'Pump Bolus 40 mg', { deliveryMode: 'pump' });
    const r = findRedoseBolus(m.getEvents('propofol'));
    ok(r !== null && Math.abs(r.value - 40) < 1e-12,
      'the manual bolus after a TCI plan is the one offered');
    ok(r.deliveryMode === 'pump', 'pump delivery is carried over');
    ok(r.value !== tciBoluses[0].value, 'and it is not the planner\'s loading dose');
  }

  // ── System events and malformed input ────────────────────────────────────
  console.log('\n── Guards ──');
  {
    const m = fresh();
    m.addBolus('propofol', 5, 50, 'Pump Bolus 50 mg', { deliveryMode: 'pump' });
    // addBolus generates a system rate-restore; it is not a bolus and must not match.
    ok(m.getEvents('propofol').some(e => e.source === 'system'),
      'the fixture really does contain a system event');
    ok(Math.abs(findRedoseBolus(m.getEvents('propofol')).value - 50) < 1e-12,
      'system rate-restores are skipped');

    ok(findRedoseBolus([]) === null, 'empty list → null');
    ok(findRedoseBolus(null) === null, 'null → null');
    ok(findRedoseBolus(undefined) === null, 'undefined → null');
    ok(findRedoseBolus([{ type: 'rate', value: 5, source: 'manual' }]) === null,
      'a rate event is not a bolus');
    ok(findRedoseBolus([{ type: 'bolus', value: 0, source: 'manual' }]) === null,
      'a zero-dose bolus is not offered');
    ok(findRedoseBolus([{ type: 'bolus', value: NaN, source: 'manual' }]) === null,
      'a NaN dose is not offered');
    ok(findRedoseBolus([{ type: 'bolus', value: 10, source: 'manual' }]).deliveryMode === 'pump',
      'a missing deliveryMode defaults to pump');
  }

  // ── Redose reproduces the dose exactly ───────────────────────────────────
  console.log('\n── Redose reproduces the dose ──');
  {
    const m = fresh();
    m.addBolus('fentanyl', 5, 0.1, 'IV Push 100 mcg', { deliveryMode: 'push' });
    const r = findRedoseBolus(m.getEvents('fentanyl'));

    // What the button does: same dose, same delivery, at a later time.
    m.addBolus('fentanyl', 25, r.value, 'IV Push 100 mcg', { deliveryMode: r.deliveryMode });
    const boluses = m.getEvents('fentanyl').filter(e => e.type === 'bolus');
    ok(boluses.length === 2, 'the redose is a second event, not a merge');
    ok(boluses[0].value === boluses[1].value, 'both boluses carry the identical dose');
    ok(boluses[0].deliveryMode === boluses[1].deliveryMode, 'and the identical delivery mode');

    // And the redose is now what a further redose would repeat.
    ok(Math.abs(findRedoseBolus(m.getEvents('fentanyl')).time - 25) < 1e-9,
      'a subsequent redose repeats the most recent one');
  }

  // ── getWorkingUnit (the label's unit source) ─────────────────────────────
  console.log('\n── Working unit ──');
  {
    _store.clear();
    ok(getWorkingUnit('fentanyl', 'bolus') === getDefaultUnit('fentanyl', 'bolus'),
      'no saved preference → the static default');

    const key = getPrefKey('fentanyl', 'bolus');
    _store.set(key, 'mcg/kg');
    ok(getWorkingUnit('fentanyl', 'bolus') === 'mcg/kg', 'a valid saved unit is used');

    _store.set(key, 'furlongs');
    ok(getWorkingUnit('fentanyl', 'bolus') === getDefaultUnit('fentanyl', 'bolus'),
      'a unit that is not allowed for the task falls back to the default');

    _store.set(key, '');
    ok(getWorkingUnit('fentanyl', 'bolus') === getDefaultUnit('fentanyl', 'bolus'),
      'an empty stored unit falls back');

    // A throwing localStorage must degrade, not break a render.
    _store.clear();
    const realStorage = global.localStorage;
    global.localStorage = { getItem() { throw new Error('denied'); } };
    ok(getWorkingUnit('propofol', 'rate') === getDefaultUnit('propofol', 'rate'),
      'a throwing localStorage falls back instead of propagating');
    global.localStorage = realStorage;

    ok(getWorkingUnit('propofol', 'ceTarget') === 'mcg/mL', 'works for tasks with one allowed unit');
  }

  summary();
})().catch(e => { console.error(e); process.exit(1); });
