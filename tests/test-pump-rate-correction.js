/**
 * test-pump-rate-correction.js — Card (getConcentrationsAt) vs graph
 * (computeCurve) consistency, and whole-timeline re-anchoring of bolus
 * deliveries when the global pump max rate is corrected mid-case.
 *
 * Imports the REAL js/sim/simulation.js so it exercises the actual
 * planTCI / addBolus / computeCurve / reanchorBolusDeliveries code paths.
 *
 * Background: a bolus's delivery duration depends on the global pump bolus
 * rate, and a TCI plan anchors its first rate step to the bolus-end time.
 * Changing the rate mid-case used to leave a rate step stranded inside a
 * bolus window, which the point query (card) and the curve sampler (graph)
 * resolved differently — the propofol Ce card/graph divergence. The fixes:
 *   1. computeCurve splits every advance at the bolus-end boundary so it is
 *      bit-identical to replayDrug/getConcentrationsAt.
 *   2. A pump-rate correction re-anchors every bolus's following step to the
 *      recomputed bolus-end (whole-timeline), preserving the bolus dose (mg).
 */

let passed = 0, failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log(`  ✓ ${msg}`); }
  else { failed++; console.log(`  ✗ ${msg}`); }
}

(async () => {
  const { createModel } = await import('../js/sim/simulation.js');
  const { setPumpSettings, resetPumpSettings } = await import('../js/util/constants.js');

  const PATIENT = { age: 23, weight: 77.1, height: 172.7, male: false, opioid: true };

  // Linear-interpolated curve read, matching the chart/readout panel.
  function curveReader(curve) {
    return (t, key = 'Ce') => {
      let lo = curve[0];
      for (let i = 1; i < curve.length; i++) {
        if (curve[i].time >= t) {
          const hi = curve[i];
          const f = (t - lo.time) / (hi.time - lo.time);
          return lo[key] + f * (hi[key] - lo[key]);
        }
        lo = curve[i];
      }
      return lo[key];
    };
  }

  // Max |card - graph| at the curve's exact sample times. Both paths are
  // exact at a sample point, so this isolates engine-path equivalence (the
  // fix) from chart interpolation granularity between samples. Restricted to
  // [t0, t1].
  function maxCardGraphDiff(m, drug, t0, t1) {
    const curve = m.computeCurve(drug, 0, t1 + 1, 10 / 60);
    let mx = 0, at = 0;
    for (const pt of curve) {
      if (pt.time < t0 || pt.time > t1) continue;
      const d = Math.abs(m.getConcentrationsAt(drug, pt.time).Ce - pt.Ce);
      if (d > mx) { mx = d; at = pt.time; }
    }
    return { mx, at };
  }

  // Independent brute-force reference: micro-step integrator. A bolus is an
  // atomic infusion over [t, t+dur]; a rate/pause whose time lands inside an
  // active bolus window defers to the bolus end. Restores the engine after.
  function bruteCe(m, drug, tEnd) {
    const el = m.getEventList();
    const engine = el.getEngine(drug);
    const evs = m.getEvents(drug).slice().sort((a, b) => a.time - b.time);
    const bo = evs.filter(e => e.type === 'bolus').map(b => {
      const d = el.getBolusDelivery(b);
      return { start: b.time, end: b.time + d.duration, rate: d.rate };
    });
    const st = evs.filter(e => e.type === 'rate' || e.type === 'pause')
      .map(e => ({ time: e.time, rate: e.type === 'pause' ? 0 : e.value, applied: false }));
    const bAt = (tt) => { for (const b of bo) { if (tt >= b.start && tt < b.end) return b; } return null; };
    engine.reset();
    const dt = 0.0005;
    let cr = 0, t = 0;
    while (t < tEnd - 1e-9) {
      for (const s of st) {
        if (s.applied) continue;
        if (t + 1e-9 >= s.time) {
          const b = bAt(s.time);
          if (b) { if (t + 1e-9 >= b.end) { cr = s.rate; s.applied = true; } }
          else { cr = s.rate; s.applied = true; }
        }
      }
      const b = bAt(t);
      engine.advance(dt, b ? b.rate : cr);
      t += dt;
    }
    const ce = engine.getConcentrations().Ce;
    el.replayDrug(drug); // restore real engine/snapshots
    return ce;
  }

  console.log('\n===== Pump rate correction & card/graph consistency =====\n');

  // --- 1. Clean single plans: card == graph to <1e-3 (no collisions) ---
  {
    resetPumpSettings();
    for (const mode of ['cet-emulation', 'cet', 'stepped']) {
      const m = createModel();
      m.setPatient(PATIENT);
      m.planTCI('propofol', 0, 3.5, { tciMode: mode });
      const { mx } = maxCardGraphDiff(m, 'propofol', 0.2, 30);
      ok(mx < 1e-3, `[${mode}] clean plan: card == graph (max diff ${mx.toFixed(5)})`);
    }
  }

  // --- 2. The bug scenario: mid-case rate correction without re-anchor.
  //        computeCurve must no longer overshoot the brute reference. ---
  {
    setPumpSettings('propofol', { concentration: 8.33, bolusRateMlH: 750 });
    const m = createModel();
    m.setPatient(PATIENT);
    m.planTCI('propofol', 0, 3.0, { tciMode: 'cet-emulation' });
    setPumpSettings('propofol', { bolusRateMlH: 1000 }); // raw correction, planner/engine split
    m.planTCI('propofol', 9, 3.5, { tciMode: 'cet-emulation' });

    const cAt = curveReader(m.computeCurve('propofol', 0, 40, 10 / 60));
    let maxGraphErr = 0;
    for (const t of [10.5, 11, 12, 13, 14.4, 16, 20, 25]) {
      maxGraphErr = Math.max(maxGraphErr, Math.abs(cAt(t) - bruteCe(m, 'propofol', t)));
    }
    ok(maxGraphErr < 0.02, `graph no longer overshoots reference after the boundary (max err ${maxGraphErr.toFixed(4)})`);
  }

  // --- 3. Full correction path: refreshDrugConfig + reanchor ⇒ card == graph
  //        across the whole timeline, every step sits at its bolus-end, and
  //        bolus dose (mg) is preserved. ---
  {
    setPumpSettings('propofol', { concentration: 8.33, bolusRateMlH: 750 });
    const m = createModel();
    m.setPatient(PATIENT);
    m.planTCI('propofol', 0, 3.0, { tciMode: 'cet-emulation' });
    const doseBefore = m.getEvents('propofol').filter(e => e.type === 'bolus')
      .reduce((s, b) => s + b.value, 0);

    // Correction 750 -> 1000, exactly as the app wiring does it.
    setPumpSettings('propofol', { bolusRateMlH: 1000 });
    m.refreshDrugConfig('propofol');
    const moved = m.reanchorBolusDeliveries('propofol', 750, 1000);
    ok(moved >= 1, `re-anchor moved at least one bolus-following step (${moved})`);

    m.planTCI('propofol', 9, 3.5, { tciMode: 'cet-emulation' });

    const { mx, at } = maxCardGraphDiff(m, 'propofol', 0.2, 30);
    ok(mx < 1e-6, `whole-timeline card == graph after correction (max ${mx.toFixed(5)} @t=${at.toFixed(1)})`);

    // Every pump bolus's immediately-following step sits at its bolus-end.
    const el = m.getEventList();
    const evs = m.getEvents('propofol');
    let aligned = true;
    for (const b of evs.filter(e => e.type === 'bolus' && e.deliveryMode !== 'push')) {
      const end = b.time + el.getBolusDelivery(b).duration;
      const next = evs.filter(e => (e.type === 'rate' || e.type === 'pause') && e.time > b.time + 1e-9)
        .sort((a, c) => a.time - c.time)[0];
      if (next && Math.abs(next.time - end) > 1e-3) aligned = false;
    }
    ok(aligned, 'every bolus-following step sits exactly at its recomputed bolus-end');

    const doseAfter = m.getEvents('propofol').filter(e => e.type === 'bolus' && e.time < 9)
      .reduce((s, b) => s + b.value, 0);
    ok(Math.abs(doseAfter - doseBefore) < 1e-9, `re-anchor preserves bolus dose mg (${doseBefore.toFixed(1)} -> ${doseAfter.toFixed(1)})`);
  }

  // --- 4. Reload: case saved at 750, global later corrected to 1000.
  //        Restore rebuilds at 1000 then re-anchors saved->current. ---
  {
    setPumpSettings('propofol', { concentration: 8.33, bolusRateMlH: 750 });
    const live = createModel();
    live.setPatient(PATIENT);
    live.planTCI('propofol', 0, 3.5, { tciMode: 'cet-emulation' });
    const saved = live.getEvents('propofol').map(e => ({
      time: e.time, type: e.type, value: e.value, source: e.source, deliveryMode: e.deliveryMode,
    }));
    const savedRate = 750;

    // Reload under the corrected global rate, the way session.restore() does.
    setPumpSettings('propofol', { concentration: 8.33, bolusRateMlH: 1000 });
    const reload = createModel();
    reload.setPatient(PATIENT);
    for (const e of saved) {
      if (e.source === 'system') continue;
      if (e.type === 'rate') reload.addRate('propofol', e.time, e.value, '', { source: e.source || 'manual' });
      else if (e.type === 'bolus') reload.addBolus('propofol', e.time, e.value, '', { deliveryMode: e.deliveryMode || 'pump', source: e.source || 'manual' });
      else if (e.type === 'pause') reload.addPause('propofol', e.time, '');
    }
    reload.reanchorBolusDeliveries('propofol', savedRate, 1000);

    const el = reload.getEventList();
    const b = reload.getEvents('propofol').find(e => e.type === 'bolus');
    const step = reload.getEvents('propofol').find(e => e.type !== 'bolus' && e.time > 0.01);
    const end = b.time + el.getBolusDelivery(b).duration;
    ok(Math.abs(step.time - end) < 1e-3, `reloaded bolus step re-anchored to current-rate bolus-end (${step.time.toFixed(3)} == ${end.toFixed(3)})`);

    const { mx } = maxCardGraphDiff(reload, 'propofol', 0.2, 30);
    ok(mx < 1e-6, `reloaded case is card == graph consistent (max ${mx.toFixed(5)})`);
  }

  // --- 5. Pre-fix saved case (no stored rate, in-window collision): Fix 1
  //        alone keeps card == graph after the delivery window. ---
  {
    setPumpSettings('propofol', { concentration: 8.33, bolusRateMlH: 750 });
    const m = createModel();
    m.setPatient(PATIENT);
    m.planTCI('propofol', 0, 3.0, { tciMode: 'cet-emulation' });
    setPumpSettings('propofol', { bolusRateMlH: 1000 });
    m.planTCI('propofol', 9, 3.5, { tciMode: 'cet-emulation' });
    // No re-anchor at all (simulating a pre-fix payload). Past the brief
    // unaligned bolus window the card and graph must still agree.
    const { mx } = maxCardGraphDiff(m, 'propofol', 11, 30);
    ok(mx < 1e-6, `Fix 1 keeps card == graph post-delivery even with an unaligned bolus (max ${mx.toFixed(5)})`);
    resetPumpSettings();
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch(err => {
  console.error(err);
  console.log(`\n${passed} passed, ${failed + 1} failed`);
  process.exit(1);
});
