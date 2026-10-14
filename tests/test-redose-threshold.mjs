/**
 * test-redose-threshold.mjs — a redose threshold is intermittent dosing only.
 *
 * The user's rule (v0.6.5.2): "Redose threshold should not be set on a drug
 * running TCI or rate based infusions since it is a setting for intermittent
 * bolus mode." v0.5.17 had made the two independent (the INF + REDOSE state);
 * this reverses that, without the two failures that motivated it: the clear
 * is annotated, never silent, and nothing hides the rate display.
 *
 *  1. sim/redose-threshold.js decides "runs TCI or a rate" from the event
 *     list, not the mode: the event editor adds rates without a mode change,
 *     and a keypad rate of 0 is 'manual' with nothing running. A rate
 *     scheduled for later counts, so the clock can't start one under a
 *     threshold. Driven against a real model.
 *  2. redoseThresholdFixes — what app.js applies at the head of every chart
 *     refresh, including a restored older save that holds both.
 *  3. The control bar (mode.js): no Set Threshold while the drug delivers, no
 *     INF + REDOSE, and the shared button comes back for every other drug.
 *  4. The wiring in app.js / chart-bridge / keypad / drug panel / planning.
 */

// A stub DOM for mode.js: every id resolves to a recorded element.
function makeEl() {
  const cls = new Set();
  return {
    textContent: '', className: '', style: {},
    classList: {
      add: (...c) => c.forEach(x => cls.add(x)), remove: (...c) => c.forEach(x => cls.delete(x)),
      contains: c => cls.has(c),
      toggle: (c, on) => { if (on === undefined) on = !cls.has(c); on ? cls.add(c) : cls.delete(c); },
    },
  };
}
const els = new Map();
const el = id => { if (!els.has(id)) els.set(id, makeEl()); return els.get(id); };
globalThis.document = { getElementById: el, querySelector: () => el('.ctrl-divider'), querySelectorAll: () => [] };
globalThis.localStorage = {
  _d: {}, getItem(k) { return this._d[k] ?? null; },
  setItem(k, v) { this._d[k] = String(v); }, removeItem(k) { delete this._d[k]; },
};

const fs = await import('node:fs');
const { createModel } = await import('../js/sim/simulation.js');
const { setPumpSettings, resetPumpSettings } = await import('../js/util/constants.js');
const { redoseThresholdBlock, redoseThresholdFixes, REDOSE_BLOCK_NOTE } =
  await import('../js/sim/redose-threshold.js');
const mode = await import('../js/ui/mode.js');

let passed = 0, failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log('  ok   ' + msg); }
  else      { failed++; console.log('  FAIL ' + msg); }
}

const PATIENT = { age: 51, weight: 70, height: 170, male: true, opioid: true };
const F = 'fentanyl', P = 'propofol', K = 'ketamine';
const RATE = 0.0008;        // fentanyl mg/min ≈ 48 mcg/h
const THR  = 0.0006;        // fentanyl mcg/mL = 0.6 ng/mL

function freshModel() {
  resetPumpSettings();
  const m = createModel();
  m.setPatient(PATIENT);
  return m;
}
const block = (m, drug, md, t) => redoseThresholdBlock(md, m.getEvents(drug), t);

// ── 1. Runs TCI or a rate — from the event list ──────────────────────────────
console.log('\n  runs TCI or a rate?');
{
  const m = freshModel();
  ok(block(m, F, 'none', 5) === null, 'no events: free to hold a threshold');
  m.addBolus(F, 0, 0.1, 'IV push 100 mcg', { deliveryMode: 'push', source: 'manual' });
  ok(block(m, F, 'none', 5) === null,
     'boluses never count — they are intermittent dosing (incl. any rate-restore at 0)');
  ok(block(freshModel(), P, 'tci', 5) === 'tci', 'TCI mode blocks, whatever the events');

  m.addRate(F, 10, RATE, 'Rate');
  ok(block(m, F, 'none', 5) === 'scheduled', 'a rate starting later: scheduled (the clock cannot start it under a threshold)');
  ok(block(m, F, 'none', 10) === 'running', 'at its start: running');
  ok(block(m, F, 'manual', 20) === 'running', 'while it runs: running');
  ok(block(m, F, 'none', 20) === 'running',
     'mode is not the test: an event-editor rate leaves the mode at none and still runs');

  m.addPause(F, 30, 'Stop Pump');
  ok(block(m, F, 'none', 25) === 'running', 'before Stop Pump: still running');
  ok(block(m, F, 'none', 40) === null, 'after Stop Pump: free again (a past infusion is not one)');

  const z = freshModel();
  z.addRate(F, 5, 0, 'Rate 0');
  ok(block(z, F, 'manual', 10) === null, "a rate of 0: 'manual' with nothing running is not an infusion");
  ok(block(z, F, 'manual', 1) === null, 'nor is a 0 rate scheduled for later');
}

// ── 2. What app.js applies after every change ─────────────────────────────────
console.log('\n  the fixes applied at every refresh');
function fixesFor(m, state, t) {
  return redoseThresholdFixes(Object.keys(state), {
    getMode: d => state[d].mode,
    getThreshold: d => state[d].thr,
    getEvents: d => m.getEvents(d),
  }, t);
}
{
  // Intermittent fentanyl, then Set Rate (mode → manual, rate running).
  const m = freshModel();
  m.addBolus(F, 0, 0.1, 'IV push 100 mcg', { deliveryMode: 'push', source: 'manual' });
  ok(fixesFor(m, { [F]: { mode: 'none', thr: THR } }, 20).length === 0,
     'intermittent fentanyl keeps its threshold');
  m.addRate(F, 20, RATE, 'Rate');
  const f1 = fixesFor(m, { [F]: { mode: 'manual', thr: THR } }, 20);
  ok(f1.length === 1 && f1[0].action === 'clear' && f1[0].reason === 'running',
     'Set Rate: the threshold is cleared (Infusion Running)');
  ok(fixesFor(m, { [F]: { mode: 'none', thr: THR } }, 20)[0]?.reason === 'running',
     'an event-editor rate (mode still none): cleared as well');

  // Scheduled for later.
  const s = freshModel();
  s.addRate(F, 60, RATE, 'Rate');
  ok(fixesFor(s, { [F]: { mode: 'none', thr: THR } }, 20)[0]?.reason === 'scheduled',
     'a rate scheduled for later: cleared now (Infusion Scheduled)');

  // An older save restored with both — the restore's own refresh fixes it.
  const legacy = freshModel();
  legacy.addRate(F, 0, RATE, 'Rate');
  const fl = fixesFor(legacy, { [F]: { mode: 'manual', thr: THR } }, 45);
  ok(fl.length === 1 && fl[0].action === 'clear', 'restored INF + REDOSE save: the threshold goes, with a note');
  const tci = freshModel();
  ok(fixesFor(tci, { [P]: { mode: 'tci', thr: 1.5 } }, 10)[0]?.reason === 'tci',
     'a threshold on a drug in TCI (only an old save can make one): cleared (TCI Running)');

  // Rate 0 in manual: nothing runs, so the threshold stays and the drug is intermittent.
  const z = freshModel();
  z.addRate(F, 5, 0, 'Rate 0');
  const fz = fixesFor(z, { [F]: { mode: 'manual', thr: THR } }, 10);
  ok(fz.length === 1 && fz[0].action === 'leaveManual',
     "a threshold on 'manual' at rate 0 is kept, and the drug goes back to 'none'");

  // Per drug: propofol's TCI says nothing about fentanyl's threshold.
  const both = freshModel();
  both.addRate(P, 0, 5, 'TCI step', { source: 'tci' });
  both.addBolus(F, 0, 0.1, 'IV push 100 mcg', { deliveryMode: 'push', source: 'manual' });
  ok(fixesFor(both, { [P]: { mode: 'tci', thr: 0 }, [F]: { mode: 'none', thr: THR } }, 10).length === 0,
     'propofol in TCI + intermittent fentanyl: nothing to fix (each drug on its own events)');

  ok(['tci', 'running', 'scheduled'].every(r => typeof REDOSE_BLOCK_NOTE[r] === 'string' && REDOSE_BLOCK_NOTE[r]),
     'every reason has a notation');
}

// ── 3. The control bar ────────────────────────────────────────────────────────
console.log('\n  the control bar');
{
  resetPumpSettings();
  setPumpSettings(F, { pumpEnabled: true });
  setPumpSettings(K, { pumpEnabled: false });
  const blocks = {};
  mode.init({ getRedoseBlock: d => blocks[d] || null, getRedoseDose: () => null });
  mode.reset();
  const bt = el('btn-target'), ml = el('mode-label'), br = el('btn-rate');

  mode.refreshUI(F);
  ok(bt.style.display === '' && bt.textContent === 'Set Threshold' && ml.textContent === 'NO MODE',
     'pump-on fentanyl, nothing running: Set Threshold offered');
  mode.setIntermittentThreshold(F, THR);
  mode.refreshUI(F);
  ok(bt.style.display === '' && bt.textContent === 'Change Threshold' && ml.textContent === 'INTERMITTENT',
     'with a threshold: INTERMITTENT, Change Threshold');

  blocks[F] = 'running';
  mode.set(F, 'manual');                       // threshold not cleared yet: the old combined state
  ok(bt.style.display === 'none', 'running a rate: no threshold control');
  ok(ml.textContent === 'INFUSION', `labelled INFUSION — never INF + REDOSE (got ${ml.textContent})`);
  ok(br.style.display === '' && br.textContent === 'Change Rate', 'the rate control is untouched');

  mode.refreshUI(P);
  ok(bt.style.display === '' && bt.textContent === 'Set Target',
     'switching to propofol brings the shared button back as Set Target');
  mode.refreshUI(K);
  ok(bt.style.display === '' && bt.textContent === 'Set Threshold' && br.style.display === 'none',
     'push-only ketamine: Set Threshold offered, no rate control');

  mode.set(F, 'none');
  blocks[F] = 'scheduled';
  mode.refreshUI(F);
  ok(bt.style.display === 'none', 'a rate scheduled for later hides it too');
  blocks[F] = null;
  mode.refreshUI(F);
  ok(bt.style.display === '', 'after Stop Pump it is back');
  resetPumpSettings();
}

// ── 4. Wiring ─────────────────────────────────────────────────────────────────
console.log('\n  wiring');
const read = rel => fs.readFileSync(new URL(rel, import.meta.url), 'utf8');
const app = read('../js/app.js');
const bridge = read('../js/app/chart-bridge.js');
const modeSrc = read('../js/ui/mode.js');
const keypadSrc = read('../js/ui/keypad.js');
const approachSrc = read('../js/ui/drug-panel/approach.js');
const panelSrc = read('../js/ui/drug-panel/index.js');
const planningSrc = read('../js/app/planning.js');

ok(/function refresh\(\) \{\s*if \(beforeRefresh\) beforeRefresh\(\);/.test(bridge),
   'chart-bridge refresh() runs beforeRefresh first, before anything renders');
ok(/beforeRefresh: enforceRedoseThresholdRule/.test(app), 'app.js hands it the rule');
const enforce = app.slice(app.indexOf('function enforceRedoseThresholdRule'), app.indexOf('function enforceRedoseThresholdRule') + 1200);
ok(/redoseThresholdFixes\(DRUG_IDS/.test(enforce) &&
   /addAnnotation\(\{ heading: 'Redose Threshold Cleared', sub: REDOSE_BLOCK_NOTE\[reason\] \}/.test(enforce),
   'the rule clears through redoseThresholdFixes, with a notation (never silent)');
ok(/if \(redoseBlock\(selectedDrug\)\) return;\s*mode\.setIntermittentThreshold/.test(app),
   'the keypad commit refuses a threshold while the drug delivers (planning mode included)');
ok(/getRedoseBlock: redoseBlock/.test(app) && /getRedoseBlock = opts\.getRedoseBlock/.test(modeSrc),
   'the control bar is told when the drug delivers');
ok(!/INF \+ REDOSE'/.test(modeSrc), "mode.js has no 'INF + REDOSE' label");
ok(!/getMode\(\) !== 'manual'/.test(keypadSrc), 'keypad push-only rule: no pump, or a threshold');
ok(!/willBeManual/.test(app), 'resolveBolusDeliveryMode: a threshold means push');
ok(!/!\(m === 'manual' && rate > 0\)/.test(approachSrc) && !/Combined \(infusion \+ threshold\)/.test(approachSrc),
   'approach.js: a threshold returns the redose line alone (no infusion + threshold fall-through)');
ok(!/Combined state \(infusion \+ threshold\)/.test(panelSrc), 'drug panel step bar: no combined branch');
ok(/clearsThreshold = thr > 0 && entry\.type === 'rate' && entry\.canonical > 0/.test(planningSrc),
   'planning a rate previews the threshold clear');

console.log(`\n  ${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
