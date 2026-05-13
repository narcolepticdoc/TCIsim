/**
 * test-reaction-delay.js — Reaction-time presentation offset
 *
 * Verifies the `displayedSecToEvent` helper in js/ui/settings.js. The helper
 * biases the *displayed* seconds-to-next-event earlier by reactionDelaySec
 * for TCI-scheduled user-action events, leaving the underlying event time
 * (history, chart markers, engine firing) untouched.
 *
 * Inlined here to keep the test runnable under plain Node without a DOM /
 * localStorage shim.
 */

let passed = 0, failed = 0;
function eq(actual, expected, msg) {
  const ok = Math.abs(actual - expected) < 1e-9;
  if (ok) { passed++; console.log('  ok   ' + msg); }
  else    { failed++; console.log(`  FAIL ${msg}  got=${actual}  want=${expected}`); }
}
function isStrictEq(actual, expected, msg) {
  const ok = actual === expected;
  if (ok) { passed++; console.log('  ok   ' + msg); }
  else    { failed++; console.log(`  FAIL ${msg}  got=${actual}  want=${expected}`); }
}

// Helper — mirrors js/ui/settings.js displayedSecToEvent. Kept in lockstep
// with the production code; if you change one, change both.
function displayedSecToEvent(evt, currentMin, reactionDelaySec = 0) {
  const rawSec = (evt.time - currentMin) * 60;
  if (!evt || evt.source !== 'tci') return rawSec;
  if (evt.type !== 'bolus' && evt.type !== 'rate' && evt.type !== 'pause') return rawSec;
  if (!(reactionDelaySec > 0)) return rawSec;
  return Math.max(0, rawSec - reactionDelaySec);
}

console.log('\n  displayedSecToEvent — reaction-delay presentation offset\n');

// ── Default (reactionDelaySec = 0): identity ────────────────────────────────
{
  const evt = { time: 5.0, type: 'bolus', source: 'tci', id: 'a' };
  eq(displayedSecToEvent(evt, 4.9, 0), 6, 'tci/bolus, delay=0 → raw 6 s');
  eq(displayedSecToEvent(evt, 4.9), 6,    'tci/bolus, delay omitted → raw 6 s');
}

// ── TCI events shift earlier by exactly reactionDelaySec ─────────────────────
{
  const bolus = { time: 5.0, type: 'bolus', source: 'tci' };
  const rate  = { time: 5.0, type: 'rate',  source: 'tci', value: 2.5 };
  const pause = { time: 5.0, type: 'pause', source: 'tci' };
  eq(displayedSecToEvent(bolus, 4.9, 2), 4, 'tci/bolus 6 s away, delay=2 → 4 s');
  eq(displayedSecToEvent(rate,  4.9, 2), 4, 'tci/rate  6 s away, delay=2 → 4 s');
  eq(displayedSecToEvent(pause, 4.9, 2), 4, 'tci/pause 6 s away, delay=2 → 4 s');
}

// ── Floor at zero — does not go negative ─────────────────────────────────────
{
  const evt = { time: 5.0, type: 'bolus', source: 'tci' };
  eq(displayedSecToEvent(evt, 5.0 - 1/60, 2), 0, 'tci/bolus 1 s away, delay=2 → floored to 0');
  eq(displayedSecToEvent(evt, 5.0, 2),       0, 'tci/bolus at t, delay=2 → 0');
}

// ── System events are NEVER offset ───────────────────────────────────────────
{
  const sys = { time: 5.0, type: 'rate', source: 'system' };
  eq(displayedSecToEvent(sys, 4.9, 2), 6, 'system/rate 6 s away, delay=2 → unchanged 6 s');
  eq(displayedSecToEvent(sys, 5.0 - 0.5/60, 2), 0.5, 'system at t+0.5 s, delay=2 → 0.5 s (no floor)');
}

// ── Manual events are NEVER offset ──────────────────────────────────────────
{
  const manual = { time: 5.0, type: 'bolus', source: 'manual' };
  eq(displayedSecToEvent(manual, 4.9, 2), 6, 'manual/bolus 6 s away, delay=2 → unchanged 6 s');
}

// ── Non-actionable event types are NEVER offset, even if source=tci ─────────
{
  const weird = { time: 5.0, type: 'note', source: 'tci' };
  eq(displayedSecToEvent(weird, 4.9, 2), 6, 'tci/note 6 s away, delay=2 → unchanged 6 s');
}

// ── Setting validator clamps + 0.5-step snap (mirrors getSettings) ──────────
function snapReactionDelay(value) {
  if (typeof value !== 'number' || !isFinite(value)) return 0;
  return Math.round(Math.max(0, Math.min(2, value)) * 2) / 2;
}
isStrictEq(snapReactionDelay(-1),    0,   'snap: -1 → 0');
isStrictEq(snapReactionDelay(0),     0,   'snap: 0 → 0');
isStrictEq(snapReactionDelay(0.3),   0.5, 'snap: 0.3 → 0.5');
isStrictEq(snapReactionDelay(1.0),   1.0, 'snap: 1.0 → 1.0');
isStrictEq(snapReactionDelay(1.3),   1.5, 'snap: 1.3 → 1.5');
isStrictEq(snapReactionDelay(2.0),   2.0, 'snap: 2.0 → 2.0');
isStrictEq(snapReactionDelay(5),     2.0, 'snap: 5 → clamped to 2.0');
isStrictEq(snapReactionDelay(NaN),   0,   'snap: NaN → 0');

console.log(`\n  ${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
