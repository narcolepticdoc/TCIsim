/**
 * test-sync-skipped-steps.mjs — a Pump Total sync does not raise MISSED rows.
 *
 * Next Up reports a pump step as missed when it was pending on an earlier pass
 * (`_seenFuture`) and the clock has since passed it. A Sync jumps the clock
 * forward over every step between the old and new time, and its premise is
 * that the pump ran them, so it calls nextUp.forgetPassed(t) before the
 * refresh. A plain jump (Apply, Now) does not, and keeps reporting them.
 *
 * Driven through the real module against the mini DOM, so the rows asserted
 * are the rows that would be on screen.
 */

import { installMiniDom } from './helpers/mini-dom.mjs';

const dom = installMiniDom(['nu-list', 'nu-clock', 'nu-clock-label', 'hv-view-next',
                            'hv-tab-next', 'view-history', 'btn-nu-time']);

const { createModel } = await import('../js/sim/simulation.js');
const nextUp = await import('../js/ui/next-up.js');

let passed = 0, failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log('  ok   ' + msg); }
  else      { failed++; console.log('  FAIL ' + msg); }
}

const PATIENT = { age: 45, weight: 70, height: 175, male: true, opioid: false };
const P = 'propofol';

const model = createModel();
model.setPatient(PATIENT);
model.addRate(P, 0, 10, 'Rate 10');
const step5  = model.addRate(P, 5, 8, 'Rate 8');
const step8  = model.addRate(P, 8, 6, 'Rate 6');
model.addRate(P, 30, 4, 'Rate 4');
const id = e => (e && e.id) || e;

let now = 1;
nextUp.init({ model, getDrugIds: () => [P], getElapsedMinutes: () => now });
nextUp.setActive(true);

function jumpTo(t, { synced }) {
  nextUp.reset();
  now = 1;
  nextUp.render(now);                     // the steps at 5 and 8 min are seen pending
  now = t;
  if (synced) nextUp.forgetPassed(now);   // what Sync's afterJump does
  nextUp.render(now);
  return dom.rows().map(r => r.key);
}

console.log('\n===== A Sync does not turn skipped pump steps into MISSED rows =====\n');

ok(id(step5) && id(step8), 'the model returns the scheduled steps');

const plain = jumpTo(12, { synced: false });
ok(plain.includes(id(step5)) && plain.includes(id(step8)),
   `a plain jump 1 → 12 min still reports the skipped steps (rows: ${plain.join(', ')})`);
ok(nextUp.getAlarmLevel() === 'due', '… and alarms');

const synced = jumpTo(12, { synced: true });
ok(!synced.includes(id(step5)) && !synced.includes(id(step8)),
   `after a Sync 1 → 12 min the skipped steps are gone (rows: ${synced.join(', ')})`);
ok(nextUp.getAlarmLevel() !== 'due', '… and nothing alarms');
ok(synced.length > 0, '… while the step still ahead (30 min) stays listed');

console.log(`\n  ${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
