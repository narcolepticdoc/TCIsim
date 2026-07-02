/**
 * test-setting-persistence.js — Setting-persistence helpers.
 *
 * Exercises the pure exports that back three persistence fixes:
 *  - isStickyPropofolConc (constants.js): nonstandard concentrations (8.33)
 *    must not persist as the setup default.
 *  - getDefaultPrefKey / getSetupDefaultUnit (units.js): the setup-screen
 *    default display unit is stored under a key separate from the in-case
 *    working key, so a mid-case unit swap never overwrites the setup default.
 *
 * The DOM-bound save/restore wiring in session.js/setup.js is not imported
 * here (it needs a browser); these are the pure predicates it relies on.
 */

const path = require('path');
const { pathToFileURL } = require('url');

let passed = 0, failed = 0;
function ok(c, m) { if (c) { passed++; console.log(`  ✓ ${m}`); } else { failed++; console.error(`  ✗ ${m}`); } }

function summary() {
  console.log(`\n${'='.repeat(50)}`);
  console.log(`  TOTAL: ${passed} passed, ${failed} failed`);
  console.log(`${'='.repeat(50)}\n`);
  process.exit(failed ? 1 : 0);
}

// Minimal localStorage shim so units.js getSetupDefaultUnit can read/write.
const _store = new Map();
global.localStorage = {
  getItem: k => (_store.has(k) ? _store.get(k) : null),
  setItem: (k, v) => { _store.set(k, String(v)); },
  removeItem: k => { _store.delete(k); },
  clear: () => { _store.clear(); },
};

(async () => {
  const constUrl = pathToFileURL(path.join(__dirname, '..', 'js', 'util', 'constants.js')).href;
  const unitsUrl = pathToFileURL(path.join(__dirname, '..', 'js', 'util', 'units.js')).href;
  const { isStickyPropofolConc } = await import(constUrl);
  const { getPrefKey, getDefaultPrefKey, getSetupDefaultUnit, getDefaultUnit } = await import(unitsUrl);

  // ---- isStickyPropofolConc ----
  ok(isStickyPropofolConc(10) === true, 'standard 10 mg/mL is sticky');
  ok(isStickyPropofolConc('10') === true, 'string "10" is sticky');
  ok(isStickyPropofolConc(20) === true, 'standard 20 mg/mL (2%) is sticky');
  ok(isStickyPropofolConc(8.33) === false, 'nonstandard 8.33 is NOT sticky');
  ok(isStickyPropofolConc('8.33') === false, 'string "8.33" is NOT sticky');
  ok(isStickyPropofolConc(8.333) === false, '8.333 within tolerance of 8.33 is NOT sticky');
  ok(isStickyPropofolConc(8.34) === true, '8.34 outside tolerance is sticky');
  ok(isStickyPropofolConc(NaN) === false, 'NaN is not sticky');
  ok(isStickyPropofolConc('') === false, 'empty string is not sticky');
  ok(isStickyPropofolConc(undefined) === false, 'undefined is not sticky');

  // ---- getDefaultPrefKey ----
  ok(getDefaultPrefKey('propofol', 'rate') === `${getPrefKey('propofol', 'rate')}-default`,
    'default key is working key + "-default"');
  ok(getDefaultPrefKey('propofol', 'rate') === 'tci-pref-rateUnit-propofol-default',
    'propofol rate default key resolves to expected string');
  ok(getDefaultPrefKey('propofol', 'ceTarget') === null,
    'task without a prefKey has no default key');

  // ---- getSetupDefaultUnit ----
  _store.clear();
  ok(getSetupDefaultUnit('propofol', 'rate') === getDefaultUnit('propofol', 'rate'),
    'unset default falls back to static default (mL/h)');

  // A valid saved default is used.
  localStorage.setItem(getDefaultPrefKey('propofol', 'rate'), 'mcg/kg/min');
  ok(getSetupDefaultUnit('propofol', 'rate') === 'mcg/kg/min',
    'valid saved default is returned');

  // An invalid saved default falls back to the static default.
  localStorage.setItem(getDefaultPrefKey('propofol', 'rate'), 'furlongs/fortnight');
  ok(getSetupDefaultUnit('propofol', 'rate') === getDefaultUnit('propofol', 'rate'),
    'invalid saved default falls back to static default');

  // Crucially: a mid-case swap of the WORKING key must not change the setup default.
  _store.clear();
  localStorage.setItem(getDefaultPrefKey('propofol', 'rate'), 'mcg/kg/min'); // setup default
  localStorage.setItem(getPrefKey('propofol', 'rate'), 'mL/h');              // mid-case swap
  ok(getSetupDefaultUnit('propofol', 'rate') === 'mcg/kg/min',
    'working-key swap does not affect the setup default (keys decoupled)');

  summary();
})();
