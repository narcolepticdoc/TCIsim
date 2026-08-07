/**
 * test-redose-latch.mjs — Redose-threshold occurrence state machine.
 *
 * Exercises the real functions in js/ui/settings.js: checkBelowThreshold,
 * noteRedoseDose, getBelowSince, getRedoseGeneration, isRedoseDoseSettling.
 * They are DOM-free (playAlert no-ops without an unlocked AudioContext), so the
 * lifecycle can be driven directly here.
 *
 * This is the logic behind two shipped bugs, both reported from real use:
 *
 *  1. "Cleared for good" — a redose too small to lift Ce back above the
 *     threshold silenced the panel for the rest of the case, while the drug card
 *     still read "Below Redose Threshold". The alert must come back once Ce turns
 *     over and is still under.
 *  2. Acknowledgement keys were a per-drug slot, so one tap silenced that drug's
 *     redose forever. Generations scope them to the occurrence.
 */

import { checkBelowThreshold, noteRedoseDose, getBelowSince,
         getRedoseGeneration, isRedoseDoseSettling } from '../js/ui/settings.js';

let passed = 0, failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log('  ok   ' + msg); }
  else      { failed++; console.log('  FAIL ' + msg); }
}
function eq(actual, expected, msg) {
  if (actual === expected) { passed++; console.log('  ok   ' + msg); }
  else { failed++; console.log(`  FAIL ${msg}  got=${actual} want=${expected}`); }
}

/** Distinct drug id per block — module state is global and there is no DOM-free reset. */
let _n = 0;
const drug = () => `testdrug${++_n}`;

console.log('\n===== Redose latch lifecycle (js/ui/settings.js) =====\n');

// ── The crossing ──────────────────────────────────────────────────────────────
{
  const d = drug();
  eq(getBelowSince(d), null, 'no crossing recorded before Ce drops');
  eq(getRedoseGeneration(d), 0, 'generation starts at 0');
  checkBelowThreshold(d, true, 20, 0.9);
  eq(getBelowSince(d), 20, 'the crossing stamps its time');
  eq(getRedoseGeneration(d), 1, 'and increments the generation');
  ok(!isRedoseDoseSettling(d), 'nothing is settling yet');
}

{
  const d = drug();
  checkBelowThreshold(d, true, 20, 0.9);
  checkBelowThreshold(d, true, 21, 0.85);   // still below, no dose
  eq(getBelowSince(d), 20, 'staying below does not move the stamp');
}

// ── A dose silences it while it takes effect ───────────────────────────────────
{
  const d = drug();
  checkBelowThreshold(d, true, 20, 0.9);
  eq(noteRedoseDose(d, 22), true, 'a dose below threshold is recorded');
  ok(isRedoseDoseSettling(d), 'the alert goes quiet while the dose acts');
}

{
  const d = drug();
  eq(noteRedoseDose(d, 5), false, 'a dose given while ABOVE threshold is a no-op');
  ok(!isRedoseDoseSettling(d), 'and nothing is marked settling');
}

// ── Re-arm once Ce turns over, still under threshold (bug 1) ──────────────────
{
  const d = drug();
  checkBelowThreshold(d, true, 20, 0.90);
  noteRedoseDose(d, 22);
  // Ce climbing after the dose — must stay quiet throughout.
  checkBelowThreshold(d, true, 22.5, 0.94);
  ok(isRedoseDoseSettling(d), 'still quiet while Ce is rising');
  checkBelowThreshold(d, true, 23.0, 0.97);
  checkBelowThreshold(d, true, 23.5, 0.99);
  ok(isRedoseDoseSettling(d), 'still quiet at the peak');
  // Ce turns over while STILL below the threshold: that dose was not enough.
  checkBelowThreshold(d, true, 24.0, 0.96);
  ok(!isRedoseDoseSettling(d), 'Ce falling away from the peak re-arms the alert');
  eq(getBelowSince(d), 22, 'and the count-up measures from that dose, not the crossing');
  eq(getRedoseGeneration(d), 1, 'a re-arm is the same occurrence, not a new one');
}

{
  const d = drug();
  checkBelowThreshold(d, true, 20, 0.90);
  noteRedoseDose(d, 22);
  // A dip smaller than REARM_DROP (0.5%) must not count as turning over.
  checkBelowThreshold(d, true, 22.5, 1.00);
  checkBelowThreshold(d, true, 23.0, 0.999);
  ok(isRedoseDoseSettling(d), 'a sub-threshold wobble does not re-arm');
  checkBelowThreshold(d, true, 23.5, 0.99);
  ok(!isRedoseDoseSettling(d), 'a real 1% drop does');
}

{
  const d = drug();
  checkBelowThreshold(d, true, 20, 0.90);
  noteRedoseDose(d, 22);
  checkBelowThreshold(d, true, 23, 0.95);
  checkBelowThreshold(d, true, 24, 0.90);   // re-armed, since = 22
  eq(getBelowSince(d), 22, 're-armed from the first dose');
  // A second, still-inadequate dose repeats the cycle from its own time.
  noteRedoseDose(d, 25);
  ok(isRedoseDoseSettling(d), 'the second dose quiets it again');
  checkBelowThreshold(d, true, 26, 0.94);
  checkBelowThreshold(d, true, 27, 0.89);
  ok(!isRedoseDoseSettling(d), 'and it re-arms again');
  eq(getBelowSince(d), 25, 'now counting from the SECOND dose');
}

// ── An adequate dose ends the occurrence ──────────────────────────────────────
{
  const d = drug();
  checkBelowThreshold(d, true, 20, 0.90);
  noteRedoseDose(d, 22);
  // Ce climbs back above the threshold — the caller reports isBelow=false.
  checkBelowThreshold(d, false, 23, 1.4);
  eq(getBelowSince(d), null, 'rising above the threshold clears the state');
  ok(!isRedoseDoseSettling(d), 'and nothing is settling');
  eq(getRedoseGeneration(d), 1, 'the generation persists while above');
  // The next drop is a NEW occurrence, with its own generation.
  checkBelowThreshold(d, true, 40, 0.9);
  eq(getRedoseGeneration(d), 2, 'the next crossing increments the generation (bug 2)');
  eq(getBelowSince(d), 40, 'and stamps the new crossing time');
}

// ── Robustness ────────────────────────────────────────────────────────────────
{
  const d = drug();
  // No Ce supplied (a caller that has not wired it): must not re-arm blindly,
  // and must not throw.
  checkBelowThreshold(d, true, 20);
  noteRedoseDose(d, 22);
  checkBelowThreshold(d, true, 23);
  checkBelowThreshold(d, true, 24);
  ok(isRedoseDoseSettling(d), 'without Ce samples the dose stays settling rather than flapping');
}

{
  const d = drug();
  checkBelowThreshold(d, true, NaN, 0.9);
  eq(getBelowSince(d), 0, 'a non-finite time falls back to 0 rather than NaN');
}

console.log(`\n  ${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
