/**
 * test-template-keypad-concentration.mjs — the setup screen's starting-dose
 * keypad converts mL at the concentration selected on the setup screen.
 *
 * Since v0.6.4.17 units.js falls back to the live pump concentration, which is
 * right in a case. On the setup screen it is wrong: the live setting still
 * holds the *previous* case's until Confirm installs the new one, and the setup
 * <select> can differ (8.33 mg/mL is never persisted, so after an 8.33 case
 * the select comes back at 1%; or the user changes it). A template entry typed
 * as 10 mL and toggled to mg was stored at the old case's concentration —
 * 83.3 mg instead of 100 at 1%, or 200 mg after a 2% case.
 *
 * The keypad's custom session now carries the caller's concentration
 * (`getConcentration`), and setup.js passes its own <select>. Driven through
 * the real keypad module against a stub DOM.
 *
 * The same holds for the bolus-time line under the entry (v0.6.5.1): whether
 * the dose is a push or a pump bolus, and how long it takes, came from the
 * previous case's live pump on/off and Max Pump Rate. The session now carries
 * `isPumpEnabled` and `getBolusRateMlH` too, from the setup screen's own
 * controls.
 */

globalThis.localStorage = {
  _d: {},
  getItem(k) { return this._d[k] ?? null; },
  setItem(k, v) { this._d[k] = String(v); },
  removeItem(k) { delete this._d[k]; },
};

function makeEl() {
  const listeners = {};
  const cls = new Set();
  return {
    textContent: '', className: '', style: {}, children: [],
    set innerHTML(_) { this.children = []; },
    get innerHTML() { return ''; },
    classList: {
      add: c => cls.add(c), remove: c => cls.delete(c), contains: c => cls.has(c),
      toggle: (c, on) => { if (on === undefined) on = !cls.has(c); on ? cls.add(c) : cls.delete(c); },
    },
    appendChild(c) { this.children.push(c); },
    addEventListener(t, f) { (listeners[t] ||= []).push(f); },
    click() { for (const f of listeners.click || []) f({}); },
  };
}
const els = new Map();
globalThis.document = {
  getElementById: id => { if (!els.has(id)) els.set(id, makeEl()); return els.get(id); },
  createElement: () => makeEl(),
  querySelectorAll: sel => (sel === '#keypad-units button' ? document.getElementById('keypad-units').children : []),
  querySelector: () => makeEl(),
};

const { setPumpSettings, resetPumpSettings } = await import('../js/util/constants.js');
const keypad = await import('../js/ui/keypad.js');

let passed = 0, failed = 0;
function eq(actual, expected, msg) {
  if (actual === expected) { passed++; console.log('  ok   ' + msg); }
  else { failed++; console.log(`  FAIL ${msg}\n         got=${actual}\n        want=${expected}`); }
}

const unitBtn = u => document.getElementById('keypad-units').children.find(b => b.textContent === u);
const shown = () => document.getElementById('keypad-value').textContent;
const preview = () => document.getElementById('keypad-conversion').textContent;

/** Open a propofol starting-bolus entry of 10 mL, as setup.js does, and toggle to mg. */
function tenMlToMg(getConcentration) {
  keypad.showCustom({
    drugId: 'propofol', task: 'bolus', title: 'Propofol starting bolus',
    value: 10, unit: 'mL', getWeightKg: () => 70, getConcentration,
    onDone: () => {},
  });
  const before = preview();
  unitBtn('mg').click();
  return { before, after: shown() };
}

console.log('\n  previous case at 8.33 mg/mL, setup select back at 1%');
resetPumpSettings();
setPumpSettings('propofol', { concentration: 8.33 });   // the live (previous case) setting
let r = tenMlToMg(() => 10);
eq(r.before.split(' · ')[0], '= 100 mg', 'preview: 10 mL = 100 mg at the selected 1% (was 83.3)');
eq(r.after, '100', 'toggling to mg stores 100 mg (was 83.3)');

console.log('\n  previous case at 2%, setup select changed to 1%');
setPumpSettings('propofol', { concentration: 20 });
r = tenMlToMg(() => 10);
eq(r.after, '100', 'toggling to mg stores 100 mg (was 200 — 20 mL of 1% delivered)');

console.log('\n  setup select at 2%');
setPumpSettings('propofol', { concentration: 10 });
r = tenMlToMg(() => 20);
eq(r.after, '200', '10 mL at the selected 2% stores 200 mg');

console.log('\n  no getter: in-case behaviour (live pump concentration)');
setPumpSettings('propofol', { concentration: 20 });
r = tenMlToMg(undefined);
eq(r.after, '200', 'without getConcentration the live setting is used, as in a case');

// ---- The bolus-time line: push-or-pump, and the delivery rate ----
const bolusTime = () => document.getElementById('keypad-bolus-time').textContent;

/** Open a starting-bolus entry the way setup.js does, with the given pump. */
function openBolus(drugId, value, unit, pump) {
  keypad.showCustom({
    drugId, task: 'bolus', title: 'starting bolus', value, unit,
    getWeightKg: () => 70, getConcentration: () => pump.conc,
    isPumpEnabled: pump.on === undefined ? undefined : () => pump.on,
    getBolusRateMlH: pump.rate === undefined ? undefined : () => pump.rate,
    onDone: () => {},
  });
  return bolusTime();
}

console.log('\n  fentanyl pump on in the last case, off on this setup screen');
resetPumpSettings();
setPumpSettings('fentanyl', { pumpEnabled: true });            // the live (previous case) setting
eq(openBolus('fentanyl', 100, 'mcg', { conc: 0.05, on: false }).includes('pump'), false,
   'a push-only drug offers no pump time (was "… pump · … push")');
eq(/^Given over ~/.test(bolusTime()), true, 'push time only');

console.log('\n  fentanyl pump off in the last case, on here');
setPumpSettings('fentanyl', { pumpEnabled: false });
eq(/ pump · .* push$/.test(openBolus('fentanyl', 100, 'mcg', { conc: 0.05, on: true })), true,
   'a pumped drug shows both times (was push only)');

console.log('\n  Max Pump Rate changed on the setup screen (live still 750 mL/h)');
resetPumpSettings();
setPumpSettings('propofol', { bolusRateMlH: 750 });
// 200 mg of 1% = 20 mL: 96 s at 750 mL/h, 60 s at 1200 mL/h.
const at750  = openBolus('propofol', 200, 'mg', { conc: 10, on: true, rate: 750 });
const at1200 = openBolus('propofol', 200, 'mg', { conc: 10, on: true, rate: 1200 });
eq(at1200 !== at750, true, `the selected 1200 mL/h times the dose ("${at1200}" vs "${at750}")`);
eq(at1200.split(' pump')[0], 'Given over ~1:00', '20 mL at 1200 mL/h is 60 s (1:36 at the live 750)');

console.log('\n  concentration changed on the setup screen (live 1%)');
setPumpSettings('propofol', { concentration: 10, bolusRateMlH: 750 });
// 200 mg of 2% = 10 mL: 48 s at 750 mL/h, where 1% would be 96 s.
eq(openBolus('propofol', 200, 'mg', { conc: 20, on: true, rate: 750 }).split(' pump')[0],
   'Given over ~48s', '200 mg at the selected 2% is 10 mL, 48 s (was 96 s at the live 1%)');

console.log('\n  no getters: in-case behaviour (live pump settings)');
setPumpSettings('fentanyl', { pumpEnabled: false });
eq(openBolus('fentanyl', 100, 'mcg', { conc: undefined }).includes('pump'), false,
   'without isPumpEnabled the live setting decides');

resetPumpSettings();
console.log(`\n  ${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
