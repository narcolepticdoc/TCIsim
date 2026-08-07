/**
 * test-upcoming.mjs — Next Up panel curation + event classification.
 *
 * Exercises the real js/sim/upcoming.js. The module is deliberately free of
 * DOM, display-unit and localStorage reads so the curation rules — which are
 * what make the panel a heads-up display rather than a second event log — can
 * be tested directly in Node.
 *
 * Also pins classifyFutureEvents, which moved here from chart-bridge.js so the
 * chart's event flags and the panel's rows share one rate-direction rule.
 */

import { collectUpcoming, classifyFutureEvents, liveKeys, DEFAULT_HUD_CFG }
  from '../js/sim/upcoming.js';

let passed = 0, failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log('  ok   ' + msg); }
  else      { failed++; console.log('  FAIL ' + msg); }
}
function eqArr(actual, expected, msg) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { passed++; console.log('  ok   ' + msg); }
  else { failed++; console.log(`  FAIL ${msg}\n         got=${a}\n        want=${e}`); }
}

let _seq = 0;
/** Build an event the way js/sim/events/index.js createEvent() does. */
function ev(drug, time, type, value, source = 'tci', extra = {}) {
  return { id: `e${++_seq}`, drug, time, type, value, source,
           deliveryMode: 'pump', annotation: '', snapshot: null, ...extra };
}
const keys  = items => items.map(i => i.key);
const kinds = items => items.map(i => i.kind);

console.log('\n===== Next Up curation (js/sim/upcoming.js) =====\n');

// ── System events are never interventions ─────────────────────────────────────
{
  const bolus   = ev('propofol', 5, 'bolus', 100, 'manual');
  const restore = ev('propofol', 5.2, 'rate', 8, 'system',
                     { annotation: 'Rate restored after bolus' });
  const step    = ev('propofol', 7, 'rate', 6, 'tci');
  const items = collectUpcoming({ events: [bolus, restore, step], now: 1 });
  eqArr(keys(items), [bolus.id, step.id],
    'auto rate-restore (source:system) is excluded, manual + tci kept');
}

// ── Cross-drug, time-ordered ──────────────────────────────────────────────────
{
  const p = ev('propofol', 9, 'rate', 6);
  const f = ev('fentanyl', 3, 'bolus', 0.05, 'manual');
  const k = ev('ketamine', 6, 'bolus', 20, 'manual');
  const items = collectUpcoming({ events: [p, f, k], now: 1 });
  eqArr(items.map(i => i.drugId), ['fentanyl', 'ketamine', 'propofol'],
    'items from all drugs interleave in time order');
}

// ── Rate classification: resume vs. a plain rate change ───────────────────────
{
  const r1 = ev('propofol', 1, 'rate', 10);
  const st = ev('propofol', 5, 'rate', 0);      // pause via zero rate
  const r2 = ev('propofol', 6, 'rate', 10);     // back to the pre-pause level
  const r3 = ev('propofol', 8, 'rate', 4);      // a genuine decrease
  const items = collectUpcoming({ events: [r1, st, r2, r3], now: 0 });
  eqArr(kinds(items), ['resume', 'stop', 'resume', 'rate'],
    'first rate and post-pause return read as resume; a level change reads as rate');
}

{
  // A rate event equal to the running rate with no intervening pause is a no-op
  // and must not produce a row.
  const r1 = ev('propofol', 1, 'rate', 10);
  const r2 = ev('propofol', 4, 'rate', 10);
  const items = collectUpcoming({ events: [r1, r2], now: 0 });
  eqArr(keys(items), [r1.id], 'a redundant rate event produces no row');
}

// ── Horizon + grouping ────────────────────────────────────────────────────────
{
  const near = ev('propofol', 5, 'rate', 6);
  const far  = ev('propofol', 90, 'rate', 4);
  const items = collectUpcoming({ events: [near, far], now: 0 });
  eqArr(keys(items), [near.id], 'an event beyond the 20 min horizon is dropped');
}

{
  // The case the group window exists for: a pause just inside the horizon whose
  // restart falls just outside it. Showing the pause alone would be misleading.
  const hold   = ev('propofol', 19.5, 'rate', 0);
  const resume = ev('propofol', 21,   'rate', 8);
  const items = collectUpcoming({ events: [hold, resume], now: 0 });
  eqArr(keys(items), [hold.id, resume.id],
    'a pause→restart pair straddling the horizon stays intact');
}

{
  // …but the group window only bridges tight clusters, not arbitrary gaps.
  const hold   = ev('propofol', 19.5, 'rate', 0);
  const resume = ev('propofol', 25,   'rate', 8);
  const items = collectUpcoming({ events: [hold, resume], now: 0 });
  eqArr(keys(items), [hold.id],
    'a restart more than groupWindowMin past the horizon is still dropped');
}

{
  // Chained grouping: each kept item extends the window from itself.
  const a = ev('propofol', 19, 'rate', 0);
  const b = ev('propofol', 20.5, 'rate', 8);
  const c = ev('propofol', 22, 'bolus', 20);
  const items = collectUpcoming({ events: [a, b, c], now: 0 });
  eqArr(keys(items), [a.id, b.id, c.id], 'grouping chains through a cluster');
}

// ── maxItems cap ──────────────────────────────────────────────────────────────
{
  const evts = [];
  for (let i = 1; i <= 10; i++) evts.push(ev('propofol', i, 'bolus', 10 * i, 'manual'));
  const items = collectUpcoming({ events: evts, now: 0 });
  ok(items.length === DEFAULT_HUD_CFG.maxItems,
    `future rows are capped at maxItems (${DEFAULT_HUD_CFG.maxItems}), got ${items.length}`);
  eqArr(keys(items), evts.slice(0, 6).map(e => e.id), 'the cap keeps the soonest items');
}

{
  // The cap must also bound a cluster — grouping bypasses the horizon, not the cap.
  const evts = [];
  for (let i = 0; i < 10; i++) evts.push(ev('propofol', 19 + i * 0.5, 'bolus', 10, 'manual'));
  const items = collectUpcoming({ events: evts, now: 0 });
  ok(items.length === DEFAULT_HUD_CFG.maxItems,
    'grouping cannot grow the list past maxItems');
}

// ── Elapsed-but-unacknowledged ────────────────────────────────────────────────
{
  const past   = ev('propofol', 8, 'bolus', 100, 'manual');
  const future = ev('propofol', 12, 'rate', 6);
  const items = collectUpcoming({ events: [past, future], now: 10 });
  eqArr(keys(items), [past.id, future.id], 'an elapsed uncleared item pins above the future list');
  ok(items[0].elapsed === true && items[1].elapsed === false, 'elapsed flags are set');
}

{
  const stale  = ev('propofol', 1, 'bolus', 100, 'manual');   // 29 min ago
  const items = collectUpcoming({ events: [stale], now: 30 });
  eqArr(keys(items), [], 'an item older than elapsedLookbackMin is dropped');
}

{
  const evts = [];
  for (let i = 1; i <= 6; i++) evts.push(ev('propofol', 20 + i, 'bolus', 10, 'manual'));
  const items = collectUpcoming({ events: evts, now: 30 });
  ok(items.length === DEFAULT_HUD_CFG.maxElapsed,
    `elapsed rows are capped at maxElapsed (${DEFAULT_HUD_CFG.maxElapsed}), got ${items.length}`);
  eqArr(keys(items), evts.slice(-3).map(e => e.id),
    'the elapsed cap keeps the most recent misses');
}

// ── Elapsed ordering is a contract, not an accident ───────────────────────────
// js/ui/next-up.js picks the clock's overdue head with a plain `.find()` over the
// returned list, so "the oldest overdue item owns the clock" depends on elapsed
// items leading, ascending. Pin it here rather than leaving it to sort order.
{
  const a = ev('propofol', 22, 'rate', 6, 'tci');   // oldest miss
  const b = ev('fentanyl', 26, 'bolus', 0.1, 'tci');
  const c = ev('ketamine', 28, 'bolus', 20, 'tci');
  const future = ev('propofol', 35, 'rate', 5, 'tci');
  const seen = new Set([a.id, b.id, c.id, future.id]);
  // Deliberately unsorted input, and not in drug order either.
  const items = collectUpcoming({
    events: [c, future, a, b], now: 30, seenFuture: seen,
  });
  eqArr(keys(items), [a.id, b.id, c.id, future.id],
    'elapsed items lead in ascending time order, then the future ones');
  ok(items[0].elapsed === true && items[0].time === 22,
    'the first item is the OLDEST elapsed one — the clock relies on this');
}

{
  // Same guarantee when a latched crossing is mixed in with pump misses.
  const miss = ev('propofol', 26, 'rate', 6, 'tci');
  const ms = { drugId: 'ketamine', kind: 'redose', time: 21, ce: 0.3,
               actionable: true, latched: true };
  const items = collectUpcoming({
    events: [miss], now: 30, milestones: [ms], seenFuture: new Set([miss.id]),
  });
  eqArr(items.map(i => i.time), [21, 26],
    'a latched crossing sorts among the misses by time, oldest first');
}

// ── Only genuinely-pending items can be reported as missed ────────────────────
{
  // The user presses Stop Pump: a pause is written at the clock. It was never
  // pending, so it must not come back as something they failed to do.
  const justDone = ev('propofol', 10, 'rate', 0, 'manual');
  const items = collectUpcoming({
    events: [justDone], now: 10, seenFuture: new Set(),
  });
  eqArr(keys(items), [], 'an event created at the clock is not reported as missed');
}

{
  // The same event, but it *was* pending on an earlier pass — a real miss.
  const missed = ev('propofol', 9, 'rate', 6, 'tci');
  const items = collectUpcoming({
    events: [missed], now: 10, seenFuture: new Set([missed.id]),
  });
  eqArr(keys(items), [missed.id], 'an item seen pending earlier is reported as missed');
  ok(items[0].elapsed === true, 'and it is flagged elapsed');
}

{
  // seenFuture never gates future items.
  const future = ev('propofol', 12, 'rate', 6, 'tci');
  const items = collectUpcoming({ events: [future], now: 10, seenFuture: new Set() });
  eqArr(keys(items), [future.id], 'seenFuture does not filter future items');
}

// ── Cleared keys ──────────────────────────────────────────────────────────────
{
  const a = ev('propofol', 4, 'bolus', 100, 'manual');
  const b = ev('propofol', 6, 'rate', 6);
  const items = collectUpcoming({ events: [a, b], now: 0, cleared: new Set([a.id]) });
  eqArr(keys(items), [b.id], 'a cleared key is excluded entirely');
}

// ── Milestones ────────────────────────────────────────────────────────────────
{
  const ms = { drugId: 'propofol', kind: 'ss', time: 12, ce: 3.2 };
  const items = collectUpcoming({ events: [], now: 0, milestones: [ms] });
  eqArr(keys(items), ['propofol:ss'], 'a milestone with no pump events is kept');
  ok(items[0].actionable === false,
    'a milestone without an explicit actionable flag only informs');
}

{
  // A forecast that assumes the current rate holds is void once a scheduled
  // step lands before it.
  const step = ev('propofol', 6, 'rate', 4);
  const ms   = { drugId: 'propofol', kind: 'ss', time: 12, ce: 3.2 };
  const items = collectUpcoming({ events: [step], now: 0, milestones: [ms] });
  eqArr(keys(items), [step.id], 'a milestone preempted by a scheduled event is dropped');
}

{
  // A step *after* the milestone does not invalidate it.
  const step = ev('propofol', 15, 'rate', 4);
  const ms   = { drugId: 'propofol', kind: 'ss', time: 12, ce: 3.2 };
  const items = collectUpcoming({ events: [step], now: 0, milestones: [ms] });
  eqArr(keys(items), ['propofol:ss', step.id], 'a later step leaves the milestone standing');
}

{
  // A system event is not a human intervention and must not preempt a forecast.
  const restore = ev('propofol', 6, 'rate', 8, 'system',
                     { annotation: 'Rate restored after bolus' });
  const ms = { drugId: 'propofol', kind: 'plateau-in', time: 12, ce: 3.2 };
  const items = collectUpcoming({ events: [restore], now: 0, milestones: [ms] });
  eqArr(keys(items), ['propofol:plateau-in'],
    'an auto rate-restore does not preempt a milestone');
}

{
  // Another drug's step is irrelevant to this drug's forecast.
  const step = ev('fentanyl', 6, 'rate', 0.002);
  const ms   = { drugId: 'propofol', kind: 'ss', time: 12, ce: 3.2 };
  const items = collectUpcoming({ events: [step], now: 0, milestones: [ms] });
  eqArr(keys(items), [step.id, 'propofol:ss'],
    'preemption is per drug, not global');
}

{
  const past = { drugId: 'propofol', kind: 'ss', time: 4, ce: 3.2 };
  const items = collectUpcoming({ events: [], now: 10, milestones: [past] });
  eqArr(keys(items), [], 'an already-arrived milestone is not listed');
}

{
  const ms = { drugId: 'ketamine', kind: 'redose', time: 300, ce: 0.5, actionable: true };
  const items = collectUpcoming({ events: [], now: 0, milestones: [ms] });
  ok(items.length === 1 && items[0].actionable === true,
    'a milestone marked actionable is reported actionable');
}

// ── Milestones are selected under their own horizon ───────────────────────────
// Regression: v0.6.3 applied the 20 min pump horizon to forecasts too, so
// fentanyl and ketamine redose-threshold crossings — which sit hundreds of
// minutes out because their Ce decay is that slow — never appeared at all.
{
  const ms = { drugId: 'ketamine', kind: 'redose', time: 300, ce: 0.5, actionable: true };
  const items = collectUpcoming({ events: [], now: 0, milestones: [ms] });
  eqArr(keys(items), ['ketamine:redose'],
    'a forecast 300 min out is kept despite the 20 min pump horizon');
}

{
  // The bug as reported: propofol's dense plan plus two distant threshold
  // crossings. Every drug must be represented.
  const evts = [];
  for (let i = 1; i <= 4; i++) evts.push(ev('propofol', i * 5, 'rate', 8 - i * 0.2, 'tci'));
  evts.push(ev('propofol', 173, 'rate', 7.5, 'tci'));   // beyond the horizon
  const milestones = [
    { drugId: 'fentanyl', kind: 'redose', time: 95,  ce: 0.8, actionable: true },
    { drugId: 'ketamine', kind: 'redose', time: 310, ce: 0.5, actionable: true },
  ];
  const items = collectUpcoming({ events: evts, now: 0, milestones });
  const drugs = [...new Set(items.map(i => i.drugId))].sort();
  eqArr(drugs, ['fentanyl', 'ketamine', 'propofol'],
    'all three drugs appear when two have only distant threshold crossings');
  eqArr(items.map(i => i.time), [5, 10, 15, 20, 95, 310],
    'the merged list stays time-sorted across events and forecasts');
}

{
  // Independent selection: a pump event stopping at the horizon does not stop
  // the forecast scan. Different drugs, so the preemption guard is not in play.
  const near = ev('propofol', 19.5, 'rate', 6, 'tci');
  const far  = ev('propofol', 60,   'rate', 5, 'tci');   // past the pump horizon
  const ms   = { drugId: 'ketamine', kind: 'redose', time: 90, ce: 0.5, actionable: true };
  const items = collectUpcoming({ events: [near, far], now: 0, milestones: [ms] });
  eqArr(keys(items), [near.id, 'ketamine:redose'],
    'the pump horizon drops a distant event but not a more distant forecast');
}

{
  const milestones = [];
  for (let i = 0; i < 8; i++) {
    milestones.push({ drugId: 'propofol', kind: 'k' + i, time: 30 + i, ce: 1 });
  }
  const items = collectUpcoming({ events: [], now: 0, milestones });
  ok(items.length === DEFAULT_HUD_CFG.maxMilestones,
    `forecasts are capped at maxMilestones (${DEFAULT_HUD_CFG.maxMilestones}), got ${items.length}`);
}

{
  // maxItems bounds pump events only — a full event list must not squeeze the
  // forecasts out, or the reported bug comes back whenever a plan is dense.
  const evts = [];
  for (let i = 1; i <= 10; i++) evts.push(ev('propofol', i, 'bolus', 10, 'manual'));
  const ms = { drugId: 'ketamine', kind: 'redose', time: 300, ce: 0.5, actionable: true };
  const items = collectUpcoming({ events: evts, now: 0, milestones: [ms] });
  ok(items.length === DEFAULT_HUD_CFG.maxItems + 1,
    'a saturated event list still leaves room for forecasts');
  ok(items[items.length - 1].key === 'ketamine:redose',
    'and the distant forecast sorts to the end');
}

// ── Latched crossings persist until dealt with ────────────────────────────────
// Regression: a crossed redose threshold used to vanish from the panel at the
// exact moment the chime fired for it. A crossing happens *to* the patient, so
// it must not self-acknowledge the way an event the user creates at the clock does.
{
  const ms = { drugId: 'ketamine', kind: 'redose', time: 20, ce: 0.3,
               actionable: true, latched: true };
  const items = collectUpcoming({ events: [], now: 35, milestones: [ms] });
  eqArr(keys(items), ['ketamine:redose'], 'a latched crossing in the past is kept');
  ok(items[0].elapsed === true && items[0].latched === true,
    'and it is flagged elapsed + latched');
  ok(items[0].actionable === true, 'a latched redose is actionable, so it alarms');
}

{
  const ms = { drugId: 'ketamine', kind: 'redose', time: 20, ce: 0.3 };
  const items = collectUpcoming({ events: [], now: 35, milestones: [ms] });
  eqArr(keys(items), [], 'a NON-latched milestone in the past is still dropped');
}

{
  // Surviving the elapsed lookback matters: a crossing 40 min old is still
  // outstanding, whereas a pump step missed 40 min ago is water under the bridge.
  const ms = { drugId: 'ketamine', kind: 'redose', time: 5, ce: 0.3,
               actionable: true, latched: true };
  const items = collectUpcoming({ events: [], now: 45, milestones: [ms] });
  eqArr(keys(items), ['ketamine:redose'],
    'a latched crossing is exempt from elapsedLookbackMin');
}

{
  // …and must not be evicted by a full complement of pump misses.
  const evts = [];
  for (let i = 1; i <= 5; i++) evts.push(ev('propofol', 30 + i, 'bolus', 10, 'tci'));
  const seen = new Set(evts.map(e => e.id));
  const ms = { drugId: 'ketamine', kind: 'redose', time: 32, ce: 0.3,
               actionable: true, latched: true };
  const items = collectUpcoming({
    events: evts, now: 40, milestones: [ms], seenFuture: seen,
  });
  ok(keys(items).includes('ketamine:redose'),
    'a latched crossing survives a full maxElapsed of pump misses');
  ok(items.filter(i => !i.latched).length === DEFAULT_HUD_CFG.maxElapsed,
    'and the pump misses are still capped at maxElapsed independently');
  eqArr(items.map(i => i.time), [32, 33, 34, 35],
    'elapsed rows, latched included, are time-sorted');
}

// ── Whether a dose dealt with it is NOT the collector's call ──────────────────
// "Was that dose enough?" needs Ce's direction, which an event list cannot
// answer. js/ui/settings.js owns it and stops passing the milestone while a dose
// settles — see tests/test-redose-latch.mjs. The collector must therefore emit a
// latched milestone regardless of what boluses exist.
{
  const ms = { drugId: 'ketamine', kind: 'redose', time: 20, ce: 0.3,
               actionable: true, latched: true };
  const dose = ev('ketamine', 22, 'bolus', 50, 'manual');
  const items = collectUpcoming({
    events: [dose], now: 25, milestones: [ms], seenFuture: new Set(),
  });
  eqArr(keys(items), ['ketamine:redose'],
    'a latched crossing is emitted even with a later bolus — settings decides, not the collector');
}

// ── Acknowledgement keys are scoped to the occurrence ────────────────────────
// Regression: `drugId:kind` is a per-drug slot that never leaves liveKeys, so a
// cleared/muted entry against it could never be pruned and one tap silenced that
// drug's redose for the rest of the case.
{
  const ms = { drugId: 'fentanyl', kind: 'redose', time: 20, ce: 0.001,
               actionable: true, latched: true, occurrence: '2c' };
  const items = collectUpcoming({ events: [], now: 25, milestones: [ms] });
  eqArr(keys(items), ['fentanyl:redose#2c'], 'an occurrence token is folded into the key');
}

{
  // A stale acknowledgement from an earlier occurrence must not suppress this one.
  const ms = { drugId: 'fentanyl', kind: 'redose', time: 20, ce: 0.001,
               actionable: true, latched: true, occurrence: '2c' };
  const items = collectUpcoming({
    events: [], now: 25, milestones: [ms],
    cleared: new Set(['fentanyl:redose#1c', 'fentanyl:redose']),
  });
  eqArr(keys(items), ['fentanyl:redose#2c'],
    'clearing occurrence 1 does not suppress occurrence 2');
}

{
  const ms = { drugId: 'fentanyl', kind: 'redose', time: 20, ce: 0.001,
               actionable: true, latched: true, occurrence: '2c' };
  const items = collectUpcoming({
    events: [], now: 25, milestones: [ms], cleared: new Set(['fentanyl:redose#2c']),
  });
  eqArr(keys(items), [], 'clearing THIS occurrence does suppress it');
}

{
  // liveKeys must agree with the key the collector builds, or pruning misfires.
  const live = liveKeys([], [{ drugId: 'fentanyl', kind: 'redose', occurrence: '2c' }]);
  ok(live.has('fentanyl:redose#2c') && !live.has('fentanyl:redose'),
    'liveKeys uses the same occurrence-scoped key');
}

{
  const ms = { drugId: 'ketamine', kind: 'redose', time: 20, ce: 0.3,
               actionable: true, latched: true };
  const items = collectUpcoming({
    events: [], now: 25, milestones: [ms], cleared: new Set(['ketamine:redose']),
  });
  eqArr(keys(items), [], 'tapping the row (cleared) removes a latched crossing');
}

{
  // Latched rows sort ahead of anything still upcoming.
  const step = ev('propofol', 30, 'rate', 6, 'tci');
  const ms = { drugId: 'ketamine', kind: 'redose', time: 20, ce: 0.3,
               actionable: true, latched: true };
  const items = collectUpcoming({ events: [step], now: 25, milestones: [ms] });
  eqArr(keys(items), ['ketamine:redose', step.id],
    'latched crossings lead, future items follow');
}

{
  // The horizon is still honoured when a caller sets a finite one.
  const ms = { drugId: 'ketamine', kind: 'redose', time: 300, ce: 0.5 };
  const items = collectUpcoming({
    events: [], now: 0, milestones: [ms], cfg: { milestoneHorizonMin: 120 },
  });
  eqArr(keys(items), [], 'a finite milestoneHorizonMin still filters');
}

// ── Unsorted input ────────────────────────────────────────────────────────────
{
  const a = ev('propofol', 8, 'rate', 4);
  const b = ev('propofol', 2, 'rate', 10);
  // Reversed input: rate direction depends on walk order, so the collector must
  // sort per drug before classifying.
  const items = collectUpcoming({ events: [a, b], now: 0 });
  eqArr(kinds(items), ['resume', 'rate'],
    'events are sorted per drug before rate direction is derived');
}

// ── liveKeys ──────────────────────────────────────────────────────────────────
{
  const a = ev('propofol', 4, 'rate', 6);
  const live = liveKeys([a], [{ drugId: 'propofol', kind: 'ss' }]);
  ok(live.has(a.id) && live.has('propofol:ss') && live.size === 2,
    'liveKeys covers both event ids and milestone keys');
}

// ── classifyFutureEvents parity ───────────────────────────────────────────────
console.log('\n===== classifyFutureEvents (moved from chart-bridge.js) =====\n');
{
  const evts = [
    ev('propofol', 1, 'rate', 10),
    ev('propofol', 2, 'bolus', 50),
    ev('propofol', 2.2, 'rate', 10, 'system', { annotation: 'Rate restored after bolus' }),
    ev('propofol', 4, 'rate', 14),
    ev('propofol', 6, 'rate', 0),
    ev('propofol', 7, 'rate', 14),
    ev('propofol', 9, 'rate', 8),
  ];
  const markers = classifyFutureEvents(evts, 5);
  eqArr(markers.map(m => m.kind),
    ['resume', 'bolus', 'increase', 'stop', 'resume', 'decrease'],
    'chart marker kinds keep the increase/decrease/resume/stop/bolus vocabulary');
  eqArr(markers.map(m => m.past), [true, true, true, false, false, false],
    'markers are tagged past/future against now, not filtered');
  eqArr(markers.map(m => m.time), [1, 2, 4, 6, 7, 9], 'marker times are preserved');
}

console.log(`\n  ${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
