/**
 * test-exit-readout.mjs — Emergence countdown ("Emerge → X in M:SS").
 *
 * Drives the real js/ui/drug-panel/exit-readout.js against the real model and
 * compares what the card WOULD DISPLAY against ground truth from
 * predictDecayTo at the same instant.
 *
 * The regression this pins: `isIdle` used to mean "pump rate is 0", and the
 * idle branch then ticked the countdown down 1 sec/sec on the assumption that
 * Ce was decaying. `getRateAtTime` walks rate/pause events only — boluses are
 * invisible to it — so a bolus given with no infusion running read as rate 0
 * for its whole delivery and the effect-site rise after it. Through that
 * window the true time-to-emergence climbs steeply while the display counted
 * DOWN, resyncing with a visible upward jump every 5 s: 76 s of error on a
 * propofol bolus, ~52 min on a ketamine IV push.
 *
 * Idle now means "Ce is falling", so the tick-down only runs where it is valid.
 */

globalThis.localStorage = {
  _d: {},
  getItem(k) { return this._d[k] ?? null; },
  setItem(k, v) { this._d[k] = String(v); },
  removeItem(k) { delete this._d[k]; },
};

const { createModel } = await import('../js/sim/simulation.js');
const { setPumpSettings, resetPumpSettings } = await import('../js/util/constants.js');
const { updateExitReadout } = await import('../js/ui/drug-panel/exit-readout.js');
const { setCurveData } = await import('../js/ui/drug-panel/approach.js');

let passed = 0, failed = 0;
function ok(c, m) { if (c) { passed++; console.log(`  ✓ ${m}`); } else { failed++; console.error(`  ✗ ${m}`); } }

const PATIENT = { age: 66, weight: 65.8, height: 167.6, male: true, opioid: true };

/**
 * Run a scripted case, ticking the readout once per simulated second with a
 * fake wall clock locked to sim time (1 sim-minute = 1 wall-minute, as in a
 * live case, so the module's 1 s / 5 s throttles behave normally).
 *
 * @returns {{worstErrSec, wrongWay, blanks, samples}}
 */
function drive({ drug, exitCe, concentration, build, actions = {}, endMin, fromMin = 0, every = 3 }) {
  resetPumpSettings();
  setPumpSettings(drug, { concentration, bolusRateMlH: 750 });
  const model = createModel();
  model.setPatient(PATIENT);

  const el = { innerHTML: '' };
  const ctx = {
    $: () => el,
    model,
    getExitCeForDrug: () => exitCe,
    getExitCeLabelForDrug: () => `${exitCe}`,
  };
  let fakeMs = 1_700_000_000_000;
  const realNow = Date.now;
  Date.now = () => fakeMs;

  const recurve = () => setCurveData(model.computeCurve(drug, 0, 600, 0.25));
  try {
    build(model);
    recurve();

    let worstErrSec = 0, wrongWay = 0, blanks = 0, samples = 0, prevShown = null, prevTruth = null;
    for (let k = 1; k <= Math.round(endMin * 60); k++) {
      const t = k / 60;
      if (actions[k]) { actions[k](model); recurve(); }
      fakeMs += 1000;
      const { Ce } = model.getConcentrationsAt(drug, t);
      updateExitReadout(ctx, drug, t, Ce, true);
      if (t < fromMin || Ce <= exitCe) { prevShown = null; prevTruth = null; continue; }
      if (k % every !== 0) continue;

      const m = el.innerHTML.match(/>(\d+):(\d\d)</);
      const r = model.predictDecayTo(drug, t, exitCe);
      if (!r || r.time === null || r.time <= t) { prevShown = null; prevTruth = null; continue; }
      if (!m) { blanks++; prevShown = null; prevTruth = null; continue; }

      const shown = (+m[1]) + (+m[2]) / 60;
      const err = Math.abs(shown - (r.time - t)) * 60;
      if (err > worstErrSec) worstErrSec = err;
      // The visible face of the bug: the display ticking DOWN while the true
      // time-to-emergence climbs. A display that rises with a rising truth is
      // correct, so direction disagreement — not upward motion — is the test.
      if (prevShown !== null && prevTruth !== null
          && shown < prevShown && (r.time - t) - prevTruth > 5 / 60) wrongWay++;
      prevShown = shown;
      prevTruth = r.time - t;
      samples++;
    }
    return { worstErrSec, wrongWay, blanks, samples };
  } finally {
    Date.now = realNow;
  }
}

// The deadband is 1.5 s and the display rounds to the second, so ~2 s is the
// floor for "tracks truth". Anything above that is the readout being wrong.
const TRACKING_SEC = 2.5;

console.log('\n===== Bolus with the pump at zero (the regression) =====\n');

{
  // Propofol: infusion stopped at 20 min, 100 mg bolus at 25 min. Rate reads 0
  // throughout delivery and the ~1.5 min effect-site rise that follows.
  const r = drive({
    drug: 'propofol', exitCe: 1.5, concentration: 10, endMin: 30, fromMin: 25.02,
    build: (m) => {
      m.addRate('propofol', 0, 6.0, 'Rate');
      m.addRate('propofol', 20, 0, 'Stop pump');
      m.addBolus('propofol', 25, 100, 'Bolus 100 mg');
    },
  });
  ok(r.samples > 90, `propofol post-bolus window sampled (${r.samples} points)`);
  ok(r.worstErrSec < TRACKING_SEC,
    `propofol bolus at rate 0: countdown tracks truth (worst ${r.worstErrSec.toFixed(1)} s, was 76.3 s)`);
  ok(r.wrongWay === 0,
    `propofol bolus at rate 0: countdown never walks against a rising truth (${r.wrongWay})`);
}

{
  // Ketamine by IV push — pump never on, so the old rule called the entire
  // case idle. Worst error was ~52 minutes.
  const r = drive({
    drug: 'ketamine', exitCe: 0.030, concentration: 10, endMin: 12, fromMin: 5.02,
    build: (m) => m.addBolus('ketamine', 5, 50, 'IV push 50 mg'),
  });
  ok(r.samples > 90, `ketamine push window sampled (${r.samples} points)`);
  ok(r.worstErrSec < TRACKING_SEC,
    `ketamine IV push: countdown tracks truth (worst ${r.worstErrSec.toFixed(1)} s, was 3094 s)`);
  ok(r.wrongWay === 0,
    `ketamine IV push: countdown never walks against a rising truth (${r.wrongWay})`);
}

console.log('\n===== Cases that already worked, and must keep working =====\n');

{
  // One run covering the induction (the plan leaves rate at 0 between the
  // loading bolus and the first maintenance step — the same trap in miniature,
  // 48.7 s before the fix) and the TCI → manual → bolus → stop path the report
  // asked about, which was already correct because an infusion is running.
  // Included so the fix is pinned as not having disturbed it.
  const r = drive({
    drug: 'propofol', exitCe: 1.5, concentration: 10, endMin: 60, fromMin: 0.1,
    build: (m) => m.planTCI('propofol', 0, 4.5, { tciMode: 'cet-emulation' }),
    actions: {
      1800: (m) => { m.clearAfter('propofol', 30); m.addRate('propofol', 30, 7.0, 'Manual rate'); },
      2700: (m) => m.addBolus('propofol', 45, 40, 'Bolus 40 mg'),
      3300: (m) => m.addRate('propofol', 55, 0, 'Stop pump'),
    },
  });
  ok(r.worstErrSec < TRACKING_SEC,
    `TCI induction → manual → bolus → stop: tracks truth (worst ${r.worstErrSec.toFixed(1)} s, induction was 48.7 s)`);
  ok(r.wrongWay === 0, `TCI induction → manual → bolus → stop: never walks against a rising truth (${r.wrongWay})`);
  ok(r.blanks === 0, `TCI induction → manual → bolus → stop: never blanks while Ce > target`);
}

console.log(`\n${'='.repeat(50)}`);
console.log(`  TOTAL: ${passed} passed, ${failed} failed`);
console.log(`${'='.repeat(50)}\n`);
process.exit(failed ? 1 : 0);
