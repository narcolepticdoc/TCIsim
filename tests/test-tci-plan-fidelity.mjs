/**
 * test-tci-plan-fidelity.mjs — clinical-outcome baseline for the production
 * TCI path.
 *
 * WHAT THIS TESTS, AND WHY IT IS DIFFERENT FROM THE OTHER TCI TESTS
 * ----------------------------------------------------------------
 * Every other planner test calls a planner function (planTCISchemeEmulation)
 * directly and replays the returned scheme through a hand-rolled sampler. That
 * validates the algorithm, but it does NOT drive the real production entry
 * point: `createModel().planTCI()`, which is what the app actually calls. That
 * facade layer reads live pump settings (getPumpSettings → the derived
 * maxRate), inserts the bolus + rate events into the real event list, and
 * answers `getConcentrationsAt()` by replaying those events through the
 * SimTIVA-validated matrix engine — the exact code path behind the on-screen
 * Ce card. A bug that lives in the facade wiring (e.g. the maxRate the planner
 * is handed, event insertion, or the replay) is invisible to a
 * planner-function test but caught here.
 *
 * This is a *clinical-outcome* baseline, not a golden-value lock: instead of
 * pinning byte-exact plan fingerprints (which change legitimately whenever the
 * planner is tuned), it asserts the property that actually matters to a
 * clinician — the plan drives Ce to the requested target and holds it there —
 * across a matrix of representative patients and targets. It stays green
 * through planner refinements and goes red only if a change breaks the
 * therapeutic result.
 *
 * Pump config mirrors production exactly: setPumpSettings(10 mg/mL, 750 mL/h)
 * derives maxRate = 750×10/60 = 125 mg/min (see getPumpSettings in
 * js/util/constants.js), the same value the setup screen installs on every
 * case start.
 *
 * For each (patient × Ce target):
 *   - onset:          Ce reaches ≥ 95% of target within ONSET_LIMIT minutes.
 *   - maintenance:    across [10, 120] min, Ce stays within ±HOLD_BAND of
 *                     target (no sustained under- or over-shoot).
 *   - clinical floor: from onset onward, Ce never falls below 90% of target
 *                     (the "patient stays anaesthetised" red line).
 *
 * Run: node tests/test-tci-plan-fidelity.mjs
 */

const { createModel } = await import('../js/sim/simulation.js');
const { setPumpSettings, resetPumpSettings, getPumpSettings } =
  await import('../js/util/constants.js');

const ONSET_LIMIT = 6.0;   // min — real path settles by ~3.6 min; 6 leaves margin
const HOLD_BAND    = 0.05;  // ±5% maintenance band (real spread is ≤ ±1.6%)
const CLINICAL_FLOOR = 0.90; // hard "does not wake up" floor
const HORIZON = 120;        // min
const DT = 0.25;            // sampling step

const PATIENTS = [
  { name: 'young M 70kg',    patient: { age: 25, weight: 70,  height: 178, male: true,  opioid: false } },
  { name: 'reference M 70kg', patient: { age: 35, weight: 70,  height: 170, male: true,  opioid: false } },
  { name: 'elderly F 60kg',  patient: { age: 78, weight: 60,  height: 158, male: false, opioid: false } },
  { name: 'obese M 120kg',   patient: { age: 45, weight: 120, height: 175, male: true,  opioid: true  } },
  { name: 'light F 50kg',    patient: { age: 30, weight: 50,  height: 160, male: false, opioid: false } },
];
const TARGETS = [2.0, 3.0, 4.5];

let passed = 0, failed = 0;
function assert(cond, msg) {
  if (cond) { passed++; console.log(`  ✓ ${msg}`); }
  else { failed++; console.error(`  ✗ ${msg}`); }
}

console.log('\n=== Production planTCI clinical-outcome fidelity (cet-emulation) ===\n');

for (const { name, patient } of PATIENTS) {
  for (const target of TARGETS) {
    // Install production pump config, then drive the real facade.
    resetPumpSettings();
    setPumpSettings('propofol', { concentration: 10, bolusRateMlH: 750 });
    const maxRate = getPumpSettings('propofol').maxRate;

    const m = createModel();
    m.setPatient(patient);
    const { scheme } = m.planTCI('propofol', 0, target, { tciMode: 'cet-emulation' });

    // Sample Ce along the real event replay (the on-screen card path).
    let onset = null;
    let minMaint = Infinity, maxMaint = -Infinity;
    let floorViolation = null;
    for (let t = DT; t <= HORIZON + 1e-9; t += DT) {
      const ce = m.getConcentrationsAt('propofol', t).Ce;
      if (onset === null && ce >= 0.95 * target) onset = t;
      if (onset !== null && ce < CLINICAL_FLOOR * target && floorViolation === null) {
        floorViolation = { t, ce };
      }
      if (t >= 10 && t <= HORIZON) {
        if (ce < minMaint) minMaint = ce;
        if (ce > maxMaint) maxMaint = ce;
      }
    }

    const tag = `[${name}, Ce=${target}]`;
    const hasBolus = scheme.some(s => s.type === 'bolus');
    const hasRate = scheme.some(s => s.type === 'rate');

    assert(hasBolus && hasRate,
      `${tag} plan has a loading bolus + maintenance rate steps (maxRate=${maxRate.toFixed(0)})`);

    assert(onset !== null && onset <= ONSET_LIMIT,
      `${tag} onset ≤ ${ONSET_LIMIT} min (reached 95% target at ${onset ? onset.toFixed(1) : 'NEVER'} min)`);

    const minDev = ((minMaint - target) / target * 100);
    const maxDev = ((maxMaint - target) / target * 100);
    assert(
      minMaint >= target * (1 - HOLD_BAND) && maxMaint <= target * (1 + HOLD_BAND),
      `${tag} holds ±${(HOLD_BAND * 100).toFixed(0)}% over [10,120] min ` +
      `(min ${minDev >= 0 ? '+' : ''}${minDev.toFixed(1)}%, max ${maxDev >= 0 ? '+' : ''}${maxDev.toFixed(1)}%)`
    );

    assert(floorViolation === null,
      `${tag} Ce never drops below ${(CLINICAL_FLOOR * 100).toFixed(0)}% of target after onset` +
      (floorViolation ? ` (violated: Ce=${floorViolation.ce.toFixed(3)} @ ${floorViolation.t.toFixed(1)} min)` : ''));
  }
}

resetPumpSettings();
console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
