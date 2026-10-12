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

resetPumpSettings();
console.log(`\n  ${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
