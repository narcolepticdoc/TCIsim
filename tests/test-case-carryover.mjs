/**
 * test-case-carryover.mjs — localStorage state that must not cross a case.
 *
 * The regression: the reset lived only inside session.newCase(), i.e. it ran
 * only when the New Case *button* was pressed. On a cold start — a fresh page
 * load, or the automatic reload after a service-worker version update — the
 * app boots straight to the setup screen, `newCase()` never runs, and
 * confirming a patient started a case still carrying the previous one's
 * working display units and last-dose keypad memory. Reported as default
 * values sitting in the Add Bolus keypad on the first bolus of a new case.
 *
 * resetCaseCarryOver() is now module-level and called from BOTH entry points.
 */

const store = {};
globalThis.localStorage = {
  getItem(k) { return Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null; },
  setItem(k, v) { store[k] = String(v); },
  removeItem(k) { delete store[k]; },
};
// session.js reaches for the DOM at module scope only through a helper, but
// importing it must not require a document.
globalThis.document = { getElementById: () => null };

const { resetCaseCarryOver } = await import('../js/app/session.js');
const { DRUG_IDS } = await import('../js/util/constants.js');
const { getPrefKey, getDefaultPrefKey, getSetupDefaultUnit, getAllowedUnits } =
  await import('../js/util/units.js');

let passed = 0, failed = 0;
function ok(c, m) { if (c) { passed++; console.log(`  ✓ ${m}`); } else { failed++; console.error(`  ✗ ${m}`); } }

console.log('\n===== Last-dose memory =====\n');

{
  for (const d of DRUG_IDS) {
    localStorage.setItem(`tci_lastBolus_${d}`, '123.4');
    localStorage.setItem(`tci_lastRate_${d}`, '5.6');
  }
  resetCaseCarryOver();
  const leftBolus = DRUG_IDS.filter(d => localStorage.getItem(`tci_lastBolus_${d}`) !== null);
  const leftRate  = DRUG_IDS.filter(d => localStorage.getItem(`tci_lastRate_${d}`) !== null);
  ok(leftBolus.length === 0, `last bolus cleared for every drug (${DRUG_IDS.join(', ')})`);
  ok(leftRate.length === 0, 'last rate cleared for every drug');
  resetCaseCarryOver();
  ok(true, 'idempotent — a second call on already-clear keys does not throw');
}

console.log('\n===== Working display units =====\n');

{
  // A mid-case swap writes the working key; the setup default is a separate
  // key the setup screen owns. The reset reseeds working from setup default.
  const drug = 'propofol';
  const allowed = getAllowedUnits(drug, 'bolus');
  const setupDefault = allowed[allowed.length - 1];      // something not the static default
  const midCaseSwap = allowed[0];
  localStorage.setItem(getDefaultPrefKey(drug, 'bolus'), setupDefault);
  localStorage.setItem(getPrefKey(drug, 'bolus'), midCaseSwap);
  ok(getSetupDefaultUnit(drug, 'bolus') === setupDefault, `setup default is ${setupDefault}`);

  resetCaseCarryOver();
  ok(localStorage.getItem(getPrefKey(drug, 'bolus')) === setupDefault,
    `working unit reseeded from the setup default (${midCaseSwap} → ${setupDefault})`);
  ok(localStorage.getItem(getDefaultPrefKey(drug, 'bolus')) === setupDefault,
    'the setup default itself is left alone');
}

console.log('\n===== Keys it must NOT touch =====\n');

{
  // Cross-case state that persists deliberately. The starting-dose template in
  // particular is the sanctioned way to carry doses between cases, and is the
  // alternative the last-dose memory is being removed in favour of.
  const keep = {
    'tci-dose-template': '{"drugs":{}}',
    'tci-dose-template-armed': 'true',
    'tci-pref-quantizeInDisplay': 'true',
    'tci-pump-max-rate': '1000',
    'tci-sync-code': 'ABC123',
    'tci-warn-settings': '{"prepSec":30}',
    'tci-pump-enabled-fentanyl': 'true',
  };
  for (const [k, v] of Object.entries(keep)) localStorage.setItem(k, v);
  resetCaseCarryOver();
  const clobbered = Object.entries(keep).filter(([k, v]) => localStorage.getItem(k) !== v);
  ok(clobbered.length === 0,
    `cross-case keys untouched${clobbered.length ? ' — clobbered: ' + clobbered.map(x => x[0]).join(', ') : ''}`);
}

console.log(`\n${'='.repeat(50)}`);
console.log(`  TOTAL: ${passed} passed, ${failed} failed`);
console.log(`${'='.repeat(50)}\n`);
process.exit(failed ? 1 : 0);
