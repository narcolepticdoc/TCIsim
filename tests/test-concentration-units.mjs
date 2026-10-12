/**
 * test-concentration-units.mjs — mL figures follow the case's concentration.
 *
 * units.js converts mL and mL/h with `ctx.concentration`, and when a caller
 * passed none it used to fall back to the DRUG_DEFS default (propofol 10 mg/mL).
 * Ten call sites passed none — the keypad, event editor, history and Next Up
 * labels, drug-card rate, chart rate labels, planning titration, redose
 * button label — so a 2% propofol case read and wrote every mL figure at 1%:
 *
 *   - 50 mL/h typed into the keypad was simulated as 8.33 mg/min; a 2% pump at
 *     50 mL/h gives 16.67. A 10 mL bolus was recorded as 100 mg, not 200.
 *   - A TCI step the planner computed correctly (16.67 mg/min) was labelled
 *     "100 mL/h" — twice what the pump should be set to.
 *
 * The fallback is now the drug's live pump concentration, which the setup
 * screen installs for a new case and session.restore() for a saved one.
 */

globalThis.localStorage = {
  _d: {},
  getItem(k) { return this._d[k] ?? null; },
  setItem(k, v) { this._d[k] = String(v); },
  removeItem(k) { delete this._d[k]; },
};

const { setPumpSettings, resetPumpSettings, DRUG_DEFS } = await import('../js/util/constants.js');
const { toCanonical, fromCanonical } = await import('../js/util/units.js');
const { formatEventAction } = await import('../js/util/event-label.js');
const { fmtRateInline } = await import('../js/ui/drug-panel/formatters.js');

let passed = 0, failed = 0;
function near(actual, expected, msg, tol = 1e-9) {
  if (Math.abs(actual - expected) <= tol) { passed++; console.log('  ok   ' + msg); }
  else { failed++; console.log(`  FAIL ${msg}\n         got=${actual}\n        want=${expected}`); }
}
function eq(actual, expected, msg) {
  if (actual === expected) { passed++; console.log('  ok   ' + msg); }
  else { failed++; console.log(`  FAIL ${msg}\n         got=${actual}\n        want=${expected}`); }
}

const W = { weightKg: 70 };   // what the keypad and history pass: weight only

console.log('\n  default concentration — unchanged');
resetPumpSettings();
near(toCanonical(60, 'mL/h', 'propofol', 'rate', W).value, 10, '1%: 60 mL/h → 10 mg/min');
near(toCanonical(10, 'mL', 'propofol', 'bolus', W).value, 100, '1%: 10 mL → 100 mg');

console.log('\n  propofol 2% (20 mg/mL)');
setPumpSettings('propofol', { concentration: 20 });
near(toCanonical(50, 'mL/h', 'propofol', 'rate', W).value, 50 * 20 / 60,
     'keypad: 50 mL/h → 16.67 mg/min (was 8.33)');
near(toCanonical(10, 'mL', 'propofol', 'bolus', W).value, 200, 'keypad: 10 mL → 200 mg (was 100)');
near(fromCanonical(50 * 20 / 60, 'mL/h', 'propofol', 'rate', W), 50,
     'readout: 16.67 mg/min → 50 mL/h (was 100)');
near(fromCanonical(200, 'mL', 'propofol', 'bolus', W), 10, 'readout: 200 mg → 10 mL');
near(fromCanonical(toCanonical(37, 'mL/h', 'propofol', 'rate', W).value, 'mL/h', 'propofol', 'rate', W), 37,
     'mL/h round-trips at 2%');
near(toCanonical(50, 'mL/h', 'propofol', 'rate', { weightKg: 70, concentration: 10 }).value, 50 * 10 / 60,
     'an explicit ctx.concentration still wins (planner config, dose template)');
near(toCanonical(100, 'mcg/kg/min', 'propofol', 'rate', W).value, 7,
     'per-kg units do not depend on concentration');
eq(DRUG_DEFS.propofol.concentration, 10, 'DRUG_DEFS default is untouched');

console.log('\n  labels at 2% — history, Next Up, warning popups, drug card');
const tciStep = { type: 'rate', value: 50 * 20 / 60, source: 'tci' };
eq(formatEventAction(tciStep, 'propofol', { weightKg: 70 }), 'Rate → 50 mL/h',
   'warning-popup label for a TCI step reads 50 mL/h (was 100)');
eq(formatEventAction(tciStep, 'propofol', { weightKg: 70, variant: 'hud' }).value, '50 mL/h',
   'Next Up value reads 50 mL/h');
eq(formatEventAction({ type: 'bolus', value: 200, deliveryMode: 'pump' }, 'propofol', { weightKg: 70 }),
   'Bolus 200 mg', 'a bolus in its default mg unit is unaffected');
localStorage.setItem('tci-pref-bolusUnit-propofol', 'mL');
eq(formatEventAction({ type: 'bolus', value: 200, deliveryMode: 'pump' }, 'propofol', { weightKg: 70 }),
   'Bolus 10 mL', 'with mL as the working unit, a 200 mg bolus reads 10 mL (was 20)');
localStorage.removeItem('tci-pref-bolusUnit-propofol');
const card = { model: { getPatient: () => ({ weight: 70 }) } };
eq(fmtRateInline(card, 'propofol', 50 * 20 / 60), '50 mL/h', 'drug-card rate reads 50 mL/h outside a bolus (was 100)');
eq(fmtRateInline(card, 'propofol', 50 * 20 / 60, { bolusOverride: true }), '50 mL/h',
   'and agrees with the bolus-phase readout, which always used the pump concentration');

console.log('\n  fentanyl at 25 mcg/mL (setup option; default 50)');
resetPumpSettings();
setPumpSettings('fentanyl', { concentration: 0.025 });
near(toCanonical(6, 'mL/h', 'fentanyl', 'rate', W).value, 6 * 0.025 / 60, 'keypad: 6 mL/h → 2.5 mcg/min (was 5)');
near(toCanonical(2, 'mL', 'fentanyl', 'bolus', W).value, 0.05, 'keypad: 2 mL → 50 mcg (was 100)');
near(fromCanonical(0.05, 'mL', 'fentanyl', 'bolus', W), 2, 'readout: 50 mcg → 2 mL');

console.log('\n  ketamine at 10% (100 mg/mL, setup option; default 10)');
resetPumpSettings();
setPumpSettings('ketamine', { concentration: 100 });
near(toCanonical(0.5, 'mL', 'ketamine', 'bolus', W).value, 50, 'keypad: 0.5 mL → 50 mg (was 5)');
near(toCanonical(6, 'mL/h', 'ketamine', 'rate', W).value, 10, 'keypad: 6 mL/h → 10 mg/min (was 1)');
near(fromCanonical(10, 'mL/h', 'ketamine', 'rate', W), 6, 'readout: 10 mg/min → 6 mL/h (was 60)');

resetPumpSettings();
console.log(`\n  ${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
