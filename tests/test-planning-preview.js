/**
 * test-planning-preview.js — Planning-mode dose projection (js/sim/preview.js).
 *
 * Planning mode's whole promise is that the curve you drag to is the curve you
 * get when you hit Confirm. These tests pin the three things that promise rests
 * on:
 *
 *   1. The clone is a faithful copy of the case (every drug, not just the one
 *      being dosed).
 *   2. Projecting never mutates the source — the user can type all day.
 *   3. The projected curve equals the curve the same mutations produce when
 *      actually applied.
 *
 * Plus the sampling contract (cached engine steps only — see the FINE_STEP /
 * COARSE_STEP note in preview.js) and the drag back-solver.
 *
 * SCOPE NOTE: `applyAction` mirrors the commit path in `app.js onConfirm`,
 * which cannot be imported here (it needs a live DOM). These tests pin
 * applyAction's own semantics — clearAfter out of TCI, planTCI from the delay,
 * the pre-case rewind to t=0 — so a regression in preview.js is caught; a
 * change to app.js that drifts away from them is not. The two must be read
 * together when either changes.
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

// ---- Global stubs (before any dynamic import) ----
const _store = new Map();
global.localStorage = {
  getItem: k => (_store.has(k) ? _store.get(k) : null),
  setItem: (k, v) => { _store.set(k, String(v)); },
  removeItem: k => { _store.delete(k); },
  clear: () => { _store.clear(); },
};

const u = (...p) => pathToFileURL(path.join(__dirname, '..', ...p)).href;

const PATIENT = { age: 45, weight: 80, height: 175, male: true, opioid: false };
const TCI_CFG = { tciMode: 'cet-emulation', ceTolerance: 0.015 };

/** A case with a full propofol TCI plan plus a fentanyl push. */
function buildCase(createModel) {
  const m = createModel({ primaryDrug: 'propofol' });
  m.setPatient(PATIENT);
  m.planTCI('propofol', 0, 3.0, TCI_CFG);
  m.addBolus('fentanyl', 0.5, 0.1, 'induction', { deliveryMode: 'push' });
  m.addRate('ketamine', 2, 3, 'infusion');
  return m;
}

/** Largest |ΔCe| between a model and a list of {time, Ce} points. */
function maxCeGap(model, drugId, points) {
  let worst = 0;
  for (const p of points) {
    const c = model.getConcentrationsAt(drugId, p.time);
    worst = Math.max(worst, Math.abs(c.Ce - p.Ce));
  }
  return worst;
}

/** Stable fingerprint of a drug's event list. */
function fingerprint(model, drugId) {
  return model.getEvents(drugId)
    .map(e => `${e.id}:${e.type}:${e.time.toFixed(9)}:${e.value.toFixed(9)}:${e.source}:${e.deliveryMode}`)
    .join('|');
}

(async () => {
  const { createModel } = await import(u('js/sim/simulation.js'));
  const {
    createPreview, cloneModel, applyAction, sampleCurve, anchorPoint,
    FINE_STEP, COARSE_STEP, FINE_WINDOW, RATE_PROBE_MIN,
  } = await import(u('js/sim/preview.js'));
  const { getSettings, setSettings } = await import(u('js/ui/settings.js'));

  const preview = createPreview();

  // ── 1. Clone fidelity ────────────────────────────────────────────────────
  console.log('\n── Clone fidelity ──');
  {
    const src = buildCase(createModel);
    const clone = cloneModel(src);

    for (const drugId of ['propofol', 'fentanyl', 'ketamine']) {
      let worst = 0;
      for (let t = 0; t <= 360; t += 1) {
        const a = src.getConcentrationsAt(drugId, t);
        const b = clone.getConcentrationsAt(drugId, t);
        worst = Math.max(worst, Math.abs(a.Ce - b.Ce), Math.abs(a.Cp - b.Cp));
      }
      ok(worst === 0, `${drugId}: clone matches source exactly over 0–360 min (gap ${worst})`);
    }

    ok(clone.getEvents('propofol').length === src.getEvents('propofol').length,
      'clone carries the same propofol event count');
    ok(clone.getPatient().weight === PATIENT.weight, 'clone carries the patient');

    // Isolation: the clone has its own engines.
    clone.addBolus('propofol', 10, 200, '', { deliveryMode: 'push' });
    let drift = 0;
    for (let t = 0; t <= 60; t += 1) {
      drift = Math.max(drift, Math.abs(src.getConcentrationsAt('propofol', t).Ce
                                     - buildCase(createModel).getConcentrationsAt('propofol', t).Ce));
    }
    ok(drift === 0, 'mutating the clone leaves the source curve untouched');
  }

  // ── 2. Projecting is non-destructive ─────────────────────────────────────
  console.log('\n── Non-destructive ──');
  {
    const src = buildCase(createModel);
    const before = fingerprint(src, 'propofol');
    const beforeCurve = src.computeCurve('propofol', 0, 120, 1).map(p => p.Ce);

    for (let i = 0; i < 25; i++) {
      preview.project(src, 'propofol', 20,
        { type: 'bolus', value: 20 + i, wasTci: true, deliveryMode: 'pump' }, { endTime: 380 });
    }
    preview.project(src, 'propofol', 20, { type: 'rate', value: 9, wasTci: true }, { endTime: 380 });
    preview.project(src, 'propofol', 20, {
      type: 'ceTarget', value: 4.5, caseStarted: true, tciDelayMin: 10 / 60, tciConfig: TCI_CFG,
    }, { endTime: 380 });
    preview.solveDose(src, 'propofol', 20,
      { type: 'bolus', wasTci: true, deliveryMode: 'pump' }, 5.0, { seed: 50 });

    ok(fingerprint(src, 'propofol') === before,
      'source event list is byte-identical after 25 projections, a plan and a solve');
    const afterCurve = src.computeCurve('propofol', 0, 120, 1).map(p => p.Ce);
    ok(afterCurve.every((v, i) => v === beforeCurve[i]),
      'source curve is byte-identical afterwards');
  }

  // ── 3. Preview equals commit ─────────────────────────────────────────────
  console.log('\n── Preview equals commit ──');
  {
    // (a) Pump bolus out of a running TCI plan.
    const src = buildCase(createModel);
    const proj = preview.project(src, 'propofol', 20,
      { type: 'bolus', value: 50, wasTci: true, deliveryMode: 'pump' }, { endTime: 380 });

    const committed = buildCase(createModel);
    committed.clearAfter('propofol', 20);
    committed.addBolus('propofol', 20, 50, '', { deliveryMode: 'pump' });
    ok(maxCeGap(committed, 'propofol', proj.points) < 1e-9,
      'pump bolus out of TCI: projected curve matches the committed one');

    // (b) IV push — a different delivery duration, so a real distinction.
    const pushProj = preview.project(src, 'propofol', 20,
      { type: 'bolus', value: 50, wasTci: true, deliveryMode: 'push' }, { endTime: 380 });
    const pushCommit = buildCase(createModel);
    pushCommit.clearAfter('propofol', 20);
    pushCommit.addBolus('propofol', 20, 50, '', { deliveryMode: 'push' });
    ok(maxCeGap(pushCommit, 'propofol', pushProj.points) < 1e-9,
      'IV push: projected curve matches the committed one');
    ok(pushProj.anchor.Ce !== proj.anchor.Ce,
      'push and pump delivery give genuinely different peaks');

    // (c) Manual rate out of TCI.
    const rateProj = preview.project(src, 'propofol', 20,
      { type: 'rate', value: 9, wasTci: true }, { endTime: 380 });
    const rateCommit = buildCase(createModel);
    rateCommit.clearAfter('propofol', 20);
    rateCommit.addRate('propofol', 20, 9, '');
    ok(maxCeGap(rateCommit, 'propofol', rateProj.points) < 1e-9,
      'manual rate out of TCI: projected curve matches the committed one');

    // (d) TCI retarget on a running case, from the delay offset.
    const delayMin = 10 / 60;
    const tciProj = preview.project(src, 'propofol', 20, {
      type: 'ceTarget', value: 4.5, caseStarted: true, tciDelayMin: delayMin, tciConfig: TCI_CFG,
    }, { endTime: 380 });
    const tciCommit = buildCase(createModel);
    tciCommit.planTCI('propofol', 20 + delayMin, 4.5, TCI_CFG);
    ok(maxCeGap(tciCommit, 'propofol', tciProj.points) < 1e-9,
      'TCI retarget: projected curve matches the committed one');

    // (e) Pre-case target wipes the prior plan and starts at the origin.
    const preProj = preview.project(src, 'propofol', 12, {
      type: 'ceTarget', value: 2.5, caseStarted: false, tciConfig: TCI_CFG,
    }, { endTime: 380 });
    ok(preProj.startTime === 0, 'pre-case target rewinds the projection to t=0');
    const preCommit = buildCase(createModel);
    preCommit.clearFrom('propofol', 0);
    preCommit.planTCI('propofol', 0, 2.5, TCI_CFG);
    ok(maxCeGap(preCommit, 'propofol', preProj.points) < 1e-9,
      'pre-case target: projected curve matches the committed one');
  }

  // ── 4. applyAction semantics ─────────────────────────────────────────────
  console.log('\n── applyAction semantics ──');
  {
    const src = buildCase(createModel);

    // Out of TCI, the forward plan is wiped; still in manual, it is not.
    const wiped = cloneModel(src);
    applyAction(wiped, 'propofol', 20, { type: 'bolus', value: 40, wasTci: true, deliveryMode: 'pump' });
    ok(!wiped.getEvents('propofol').some(e => e.time > 20 && e.source === 'tci'),
      'wasTci: TCI events after the entry time are cleared');

    const kept = cloneModel(src);
    const futureTciBefore = kept.getEvents('propofol').filter(e => e.time > 20 && e.source === 'tci').length;
    applyAction(kept, 'propofol', 20, { type: 'bolus', value: 40, wasTci: false, deliveryMode: 'pump' });
    ok(futureTciBefore > 0, 'the fixture really does have queued TCI steps to protect');
    ok(kept.getEvents('propofol').filter(e => e.time > 20 && e.source === 'tci').length === futureTciBefore,
      'wasTci false: queued TCI steps survive');

    // A bolus lands at the entry time.
    ok(wiped.getEvents('propofol').some(e => e.type === 'bolus' && Math.abs(e.time - 20) < 1e-9),
      'the bolus is inserted at the entry time');

    // Only the dosed drug is touched.
    const other = cloneModel(src);
    const fentBefore = fingerprint(other, 'fentanyl');
    applyAction(other, 'propofol', 20, { type: 'rate', value: 5, wasTci: true });
    ok(fingerprint(other, 'fentanyl') === fentBefore, 'other drugs are untouched by an action');
  }

  // ── 5. Sampling contract ─────────────────────────────────────────────────
  console.log('\n── Sampling ──');
  {
    const src = buildCase(createModel);
    const pts = sampleCurve(src, 'propofol', 20, 380);

    ok(pts.length > 0 && Math.abs(pts[0].time - 20) < 1e-9, 'sampling starts at startTime');
    ok(pts[pts.length - 1].time <= 380 + 1e-9, 'sampling stops at endTime');

    // Every gap must be one of the engine's cached steps, or the preview pays
    // ~11× per sample for an uncached matrix exponential.
    const CACHED = [FINE_STEP, COARSE_STEP];
    let uncached = 0;
    for (let i = 1; i < pts.length; i++) {
      const dt = pts[i].time - pts[i - 1].time;
      if (!CACHED.some(c => Math.abs(dt - c) < 1e-6)) uncached++;
    }
    ok(uncached === 0, `every sample gap is a cached engine step (${uncached} were not)`);

    // Fine window first, then coarse.
    const fineGaps = [], coarseGaps = [];
    for (let i = 1; i < pts.length; i++) {
      const dt = pts[i].time - pts[i - 1].time;
      (pts[i].time <= 20 + FINE_WINDOW + 1e-9 ? fineGaps : coarseGaps).push(dt);
    }
    ok(fineGaps.length > 0 && fineGaps.every(g => Math.abs(g - FINE_STEP) < 1e-6),
      `the first ${FINE_WINDOW} min are sampled at ${FINE_STEP} min`);
    ok(coarseGaps.length > 0 && coarseGaps.every(g => Math.abs(g - COARSE_STEP) < 1e-6),
      `beyond that, sampling is at ${COARSE_STEP} min`);

    // The two segments share a boundary sample — it must appear once.
    const atBoundary = pts.filter(p => Math.abs(p.time - (20 + FINE_WINDOW)) < 1e-9);
    ok(atBoundary.length === 1, 'the segment boundary sample is not duplicated');

    // Times must be strictly increasing across the join.
    let monotone = true;
    for (let i = 1; i < pts.length; i++) if (!(pts[i].time > pts[i - 1].time)) monotone = false;
    ok(monotone, 'sample times are strictly increasing');

    ok(sampleCurve(src, 'propofol', 20, 20).length === 0, 'an empty window returns no samples');
  }

  // ── 6. Handle anchor ─────────────────────────────────────────────────────
  console.log('\n── Handle anchor ──');
  {
    const src = buildCase(createModel);

    // The fixture leaves propofol infusing, so the GLOBAL max sits at the far
    // end of the horizon. The handle must track the dose's own peak instead —
    // this is the distinction the anchor exists to make.
    const proj = preview.project(src, 'propofol', 20,
      { type: 'bolus', value: 50, wasTci: true, deliveryMode: 'pump' }, { endTime: 380 });
    ok(proj.anchor.time <= 20 + FINE_WINDOW,
      'bolus anchor is inside the fine window, not the far end of the horizon');
    ok(proj.anchor.time > 20, 'bolus anchor is after the dose');
    ok(proj.peak.time > 20 + FINE_WINDOW,
      'the fixture really does peak globally outside the window (so the two differ)');
    ok(proj.anchor.Ce < proj.peak.Ce, 'anchor and global peak are distinct values');

    const rateProj = preview.project(src, 'propofol', 20,
      { type: 'rate', value: 9, wasTci: true }, { endTime: 380 });
    ok(Math.abs(rateProj.anchor.time - (20 + RATE_PROBE_MIN)) < 1e-6,
      `rate anchor sits at +${RATE_PROBE_MIN} min`);

    ok(anchorPoint([], { type: 'bolus' }, 0) === null, 'no points → no anchor');
    ok(anchorPoint(rateProj.points, { type: 'ceTarget' }, 20) === null,
      'ceTarget has no curve anchor (the handle rides its target line)');
  }

  // ── 7. Back-solve ────────────────────────────────────────────────────────
  console.log('\n── Back-solve ──');
  {
    const src = buildCase(createModel);
    const bolusAction = { type: 'bolus', wasTci: true, deliveryMode: 'pump' };

    for (const target of [4.5, 5.5, 7.0]) {
      const dose = preview.solveDose(src, 'propofol', 20, bolusAction, target, { seed: 50 });
      const check = preview.project(src, 'propofol', 20,
        { ...bolusAction, value: dose }, { endTime: 100 });
      const err = Math.abs(check.anchor.Ce - target) / target;
      ok(err <= 0.005, `bolus solve for Ce ${target}: ${dose.toFixed(1)} mg lands within 0.5% (${(err * 100).toFixed(3)}%)`);
    }

    // Monotonic: a higher target must never want a smaller dose.
    const d1 = preview.solveDose(src, 'propofol', 20, bolusAction, 4.5, { seed: 50 });
    const d2 = preview.solveDose(src, 'propofol', 20, bolusAction, 6.0, { seed: 50 });
    ok(d2 > d1, 'a higher target Ce solves to a larger dose');

    const rateAction = { type: 'rate', wasTci: true };
    const rate = preview.solveDose(src, 'propofol', 20, rateAction, 4.0, { seed: 8 });
    const rateClone = cloneModel(src);
    applyAction(rateClone, 'propofol', 20, { ...rateAction, value: rate });
    const got = rateClone.getConcentrationsAt('propofol', 20 + RATE_PROBE_MIN).Ce;
    ok(Math.abs(got - 4.0) / 4.0 <= 0.005,
      `rate solve: ${rate.toFixed(2)} mg/min gives Ce ${got.toFixed(3)} at +${RATE_PROBE_MIN} min`);

    // Below what the case already delivers → no dose can get there.
    const belowBaseline = src.getConcentrationsAt('propofol', 20).Ce * 0.25;
    ok(preview.solveDose(src, 'propofol', 20, bolusAction, belowBaseline, { seed: 50 }) === 0,
      'a target under the running baseline solves to zero');

    // Beyond reach → clamped at the cap rather than diverging.
    ok(preview.solveDose(src, 'propofol', 20, bolusAction, 1e6, { seed: 50, cap: 4000 }) === 4000,
      'an unreachable target clamps to the cap');

    ok(preview.solveDose(src, 'propofol', 20, bolusAction, 0, { seed: 50 }) === null,
      'a non-positive target is rejected');
  }

  // ── 8. Line tasks never touch the model ──────────────────────────────────
  console.log('\n── Line tasks ──');
  {
    const src = buildCase(createModel);
    const before = fingerprint(src, 'propofol');

    for (const type of ['exitCe', 'intermittent']) {
      ok(preview.project(src, 'propofol', 20, { type, value: 1.5 }) === null,
        `${type}: project returns null (nothing about the curve changes)`);
      ok(preview.solveDose(src, 'propofol', 20, { type }, 1.5) === null,
        `${type}: no dose to back-solve`);
    }
    ok(preview.solveDose(src, 'propofol', 20, { type: 'ceTarget' }, 3.0) === null,
      'ceTarget: no dose to back-solve (the dragged value is the target)');
    ok(fingerprint(src, 'propofol') === before, 'line tasks leave the source untouched');
  }

  // ── 9. Guards ────────────────────────────────────────────────────────────
  console.log('\n── Guards ──');
  {
    const src = buildCase(createModel);
    const action = { type: 'bolus', wasTci: true, deliveryMode: 'pump' };
    ok(preview.project(null, 'propofol', 20, { ...action, value: 10 }) === null, 'no model → null');
    ok(preview.project(src, 'propofol', 20, null) === null, 'no action → null');
    ok(preview.project(src, 'propofol', 20, { ...action, value: NaN }) === null, 'NaN dose → null');
    ok(preview.project(src, 'propofol', 20, { ...action, value: -5 }) === null, 'negative dose → null');
    ok(preview.solveDose(src, 'propofol', 20, action, NaN) === null, 'NaN target → null');

    // Zero is NOT a missing value: dragging the handle to the floor solves to
    // zero, and the projection has to keep drawing (and keep an anchor) or
    // the handle vanishes and the user cannot drag back up.
    const zero = preview.project(src, 'propofol', 20, { ...action, value: 0 }, { endTime: 120 });
    ok(zero !== null && zero.points.length > 0, 'zero dose still projects a baseline curve');
    ok(zero.anchor !== null, 'zero dose still yields a handle anchor');

    const zeroClone = cloneModel(src);
    applyAction(zeroClone, 'propofol', 20, { ...action, value: 0 });
    ok(!zeroClone.getEvents('propofol').some(e => e.type === 'bolus' && Math.abs(e.time - 20) < 1e-9),
      'no 0 mg bolus event is fabricated');

    // The zero-dose projection is exactly "TCI stopped here, nothing given".
    const stopped = buildCase(createModel);
    stopped.clearAfter('propofol', 20);
    ok(maxCeGap(stopped, 'propofol', zero.points) < 1e-9,
      'zero dose projects the plain post-clear baseline');

    // A zero RATE is a real instruction (pump off) and must insert an event.
    const zeroRate = preview.project(src, 'propofol', 20,
      { type: 'rate', value: 0, wasTci: true }, { endTime: 120 });
    const offCommit = buildCase(createModel);
    offCommit.clearAfter('propofol', 20);
    offCommit.addRate('propofol', 20, 0, '');
    ok(maxCeGap(offCommit, 'propofol', zeroRate.points) < 1e-9,
      'zero rate projects a stopped pump');
  }

  // ── 10. planningModeDefault setting ──────────────────────────────────────
  console.log('\n── Setting ──');
  {
    _store.clear();
    ok(getSettings().planningModeDefault === false, 'defaults to off');

    const base = getSettings();
    setSettings({ ...base, planningModeDefault: true });
    ok(getSettings().planningModeDefault === true, 'round-trips through localStorage');

    // A junk value must fall back to the default rather than leak through.
    _store.set('tci-warn-settings', JSON.stringify({ ...base, planningModeDefault: 'yes' }));
    ok(getSettings().planningModeDefault === false, 'a non-boolean falls back to the default');

    // And it must not disturb its neighbours.
    _store.clear();
    setSettings({ ...base, planningModeDefault: true, ceTolerance: 0.02 });
    ok(getSettings().ceTolerance === 0.02, 'neighbouring settings still round-trip');
  }

  summary();
})().catch(e => { console.error(e); process.exit(1); });
