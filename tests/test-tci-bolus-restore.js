/**
 * test-tci-bolus-restore.js — TCI boluses skip the system rate-restore.
 *
 * Unlike most test-*.js files (which inline a reimplementation), this one
 * imports the REAL js/sim/simulation.js so it exercises the actual addBolus /
 * planTCI code path. A TCI-sourced bolus must NOT generate a
 * `source:'system'` "Rate restored after bolus" row — planTCI inserts its own
 * rate steps that define post-bolus delivery, and the restore is a functional
 * no-op (replay never changes currentRate across a bolus). Manual boluses keep
 * their restore marker.
 */

let passed = 0, failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log(`  ✓ ${msg}`); }
  else { failed++; console.log(`  ✗ ${msg}`); }
}

(async () => {
  const { createModel } = await import('../js/sim/simulation.js');

  console.log('\n===== TCI bolus skips system rate-restore =====\n');

  // --- A TCI plan with a loading bolus emits no system rate-restore ---
  {
    const model = createModel();
    model.planTCI('propofol', 0, 3.0);
    const ev = model.getEvents('propofol');
    const bolus = ev.find(e => e.type === 'bolus');
    ok(bolus !== undefined && bolus.source === 'tci', 'planTCI inserts a TCI-sourced loading bolus');
    const sys = ev.filter(e => e.source === 'system');
    ok(sys.length === 0, `TCI bolus produces no system rate-restore (got ${sys.length})`);
  }

  // --- A manual bolus still produces exactly one restore at the prior rate ---
  {
    const model = createModel();
    model.addRate('propofol', 0, 5.0);          // mg/min
    model.addBolus('propofol', 2, 50, 'Manual bolus'); // defaults to source:'manual'
    const sys = model.getEvents('propofol').filter(e => e.source === 'system' && e.type === 'rate');
    ok(sys.length === 1, `Manual bolus still creates one rate-restore (got ${sys.length})`);
    if (sys.length === 1) ok(sys[0].value === 5.0, `Manual restore returns to prior rate 5.0 (got ${sys[0].value})`);
  }

  // --- Delivery sanity: removing the restore must not break the plan. The
  //     loading bolus delivers, maintenance keeps Ce climbing toward target,
  //     and there's no runaway (which a stuck bolus rate would cause). ---
  {
    const m = createModel();
    m.planTCI('propofol', 0, 3.0);
    const c5 = m.getConcentrationsAt('propofol', 5);
    const c30 = m.getConcentrationsAt('propofol', 30);
    ok(c5.Cp > 0 && c5.Ce > 0.5, `Bolus delivered after suppression (Cp=${c5.Cp.toFixed(2)}, Ce=${c5.Ce.toFixed(2)})`);
    ok(c30.Ce > c5.Ce, `Maintenance keeps delivering — Ce climbs (${c5.Ce.toFixed(2)} -> ${c30.Ce.toFixed(2)})`);
    ok(c30.Ce < 3.0, `No runaway from a stuck bolus rate — Ce stays under target (${c30.Ce.toFixed(2)})`);
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch(err => {
  console.error(err);
  console.log(`\n${passed} passed, ${failed + 1} failed`);
  process.exit(1);
});
