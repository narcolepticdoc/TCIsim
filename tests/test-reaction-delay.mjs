/**
 * test-reaction-delay.mjs — Reaction-time presentation offset.
 *
 * Verifies the REAL `displayedSecToEvent` (js/ui/settings.js). The helper
 * biases the *displayed* seconds-to-next-event earlier by reactionDelaySec for
 * TCI-scheduled user-action events, leaving the underlying event time
 * (history, chart markers, engine firing) untouched.
 *
 * Previously this file inlined a copy of displayedSecToEvent "kept in lockstep"
 * — the exact drift risk the suite audit removed elsewhere. It now imports the
 * shipping function. The reactionDelaySec clamp/snap it also mirrored is now
 * tested against the real getSettings in test-settings-validation.mjs.
 */

import { displayedSecToEvent } from '../js/ui/settings.js';

let passed = 0, failed = 0;
function eq(actual, expected, msg) {
  const ok = Math.abs(actual - expected) < 1e-9;
  if (ok) { passed++; console.log('  ok   ' + msg); }
  else    { failed++; console.log(`  FAIL ${msg}  got=${actual}  want=${expected}`); }
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

console.log(`\n  ${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
