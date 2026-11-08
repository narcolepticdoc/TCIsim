/**
 * test-pump-sync.mjs — the clock popover's Pump Total mode, end to end.
 *
 * Scenario: the infusion is running but nobody pressed Start. The clinician
 * types the pump's total delivered; Sync moves the clock so the sim has
 * delivered exactly that much, starting the case if it hadn't been.
 *
 *  1. js/ui/pump-sync.js against the real model: which units are offered, that
 *     mL is the default and converts at the case's live concentration (a 2%
 *     propofol case is not a 1% one), that switching unit converts the typed
 *     value instead of clearing it, and that resolve() lands where the Log's
 *     "Total delivered" equals the entry.
 *  2. js/ui/timer.js with that pane plugged in: Sync relabels Apply and hides
 *     Now; it starts the case before moving the clock, runs afterJump after it,
 *     and calls onAdjust exactly once; with no answer the clock is untouched
 *     and the popover stays open on the reason.
 */

// ---- A DOM with just what pump-sync.js and timer.js touch ----
class El {
  constructor(id = '') {
    this.id = id; this.children = []; this.parent = null;
    this.dataset = {}; this.style = {}; this.value = ''; this.disabled = false;
    this.textContent = ''; this.focused = false; this._cls = new Set(); this._l = {};
    const cls = this._cls;
    this.classList = {
      add: c => cls.add(c), remove: c => cls.delete(c), contains: c => cls.has(c),
      toggle: (c, on) => { if (on === undefined) on = !cls.has(c); on ? cls.add(c) : cls.delete(c); },
    };
  }
  get className() { return [...this._cls].join(' '); }
  set className(v) { this._cls.clear(); for (const c of String(v).split(/\s+/).filter(Boolean)) this._cls.add(c); }
  get innerHTML() { return ''; }
  set innerHTML(v) { if (v !== '') throw new Error('test DOM: innerHTML may only clear'); this.children = []; }
  get parentElement() { return this.parent || { style: {} }; }
  appendChild(c) { c.parent = this; this.children.push(c); return c; }
  querySelectorAll(sel) {
    const m = /^\[data-(\w+)\]$/.exec(sel);
    return m ? this.children.filter(c => c.dataset[m[1]] != null) : [];
  }
  closest(sel) {
    const m = /^\[data-(\w+)\]$/.exec(sel);
    for (let n = this; n; n = n.parent) if (m && n.dataset[m[1]] != null) return n;
    return null;
  }
  addEventListener(t, f) { (this._l[t] ||= []).push(f); }
  fire(t, evt = {}) { for (const f of this._l[t] || []) f({ target: this, preventDefault() {}, ...evt }); }
  focus() { this.focused = true; }
}
const els = new Map();
const IDS = ['elapsed-timer', 'tp-btn-apply', 'tp-btn-now', 'tp-btn-cancel', 'input-start-time',
             'tp-mode-start', 'tp-mode-elapsed', 'tp-mode-sync', 'timer-wrap', 'timer-popover',
             'tp-elapsed-row', 'tp-elapsed-h', 'tp-elapsed-m', 'tp-info', 'elapsed-time-val',
             'case-start-val', 'tp-sync-pane', 'tp-sync-drugs', 'tp-sync-input', 'tp-sync-units'];
for (const id of IDS) els.set(id, new El(id));
globalThis.document = {
  getElementById: id => els.get(id) || null,
  createElement: () => new El(),
  querySelectorAll: () => [],
  addEventListener() {},
};
globalThis.localStorage = {
  _d: {},
  getItem(k) { return this._d[k] ?? null; },
  setItem(k, v) { this._d[k] = String(v); },
  removeItem(k) { delete this._d[k]; },
};

const { createModel } = await import('../js/sim/simulation.js');
const { getCumulativeDose } = await import('../js/sim/events/query.js');
const { setPumpSettings, resetPumpSettings } = await import('../js/util/constants.js');
const pumpSync = await import('../js/ui/pump-sync.js');
const timer = await import('../js/ui/timer.js');

let passed = 0, failed = 0;
function eq(actual, expected, msg) {
  if (actual === expected) { passed++; console.log('  ok   ' + msg); }
  else { failed++; console.log(`  FAIL ${msg}\n         got=${actual}\n        want=${expected}`); }
}
function near(actual, expected, msg, tol = 1e-6) {
  if (actual != null && Math.abs(actual - expected) <= tol) { passed++; console.log('  ok   ' + msg); }
  else { failed++; console.log(`  FAIL ${msg}\n         got=${actual}\n        want=${expected}`); }
}
function ok(cond, msg) { eq(!!cond, true, msg); }

const PATIENT = { age: 45, weight: 70, height: 175, male: true, opioid: false };
const P = 'propofol', F = 'fentanyl';
const el = id => els.get(id);
const input = el('tp-sync-input');
const unitButtons = () => el('tp-sync-units').children.map(b => b.dataset.unit);
const activeUnit = () => el('tp-sync-units').children.find(b => b.classList.contains('active'))?.dataset.unit;
const type = v => { input.value = v; input.fire('input'); };

// ---- The case: propofol at 10 mg/min from ET 0, never started ----
resetPumpSettings();
setPumpSettings(P, { concentration: 20 });            // 2% propofol
const model = createModel();
model.setPatient(PATIENT);
model.addRate(P, 0, 10, 'Rate 10 mg/min');
const dur = evt => model.getEventList().getBolusDelivery(evt).duration;
const logTotal = (drug, now) => getCumulativeDose(model.getEvents(drug), drug, now, dur).totalMg;

let selected = P;
let nowMin = 0;
pumpSync.init({ model, getSelectedDrug: () => selected, getNowMinutes: () => nowMin });

console.log('\n── 1. pump-sync.js ──');
eq(JSON.stringify(pumpSync.syncUnits(P)), '["mL","mg"]', 'propofol (pump): mL or mg');
eq(JSON.stringify(pumpSync.syncUnits(F)), '["mcg"]', 'fentanyl without a pump: mcg only');
setPumpSettings(F, { pumpEnabled: true });
eq(JSON.stringify(pumpSync.syncUnits(F)), '["mL","mcg"]', 'fentanyl on a pump: mL or mcg (never per-kg)');
setPumpSettings(F, { pumpEnabled: false });

pumpSync.onShow();
eq(pumpSync.getDrug(), P, 'the only drug with events is chosen');
eq(el('tp-sync-drugs').children.length, 0, 'one drug: no drug buttons');
eq(activeUnit(), 'mL', 'mL is the default unit');
ok(input.focused, 'the entry is focused on show');

// 2% propofol: 20 mg/mL. 23.5 mL = 470 mg = 47 min at 10 mg/mL — not 23.5 min.
type('23.5');
let r = pumpSync.resolve(0);
ok(r, '23.5 mL resolves');
near(r.elapsedMs / 60000, 47, '23.5 mL at 2% is 470 mg: 47 min of infusion (not 23.5 at 1%)', 1e-6);
near(logTotal(P, r.elapsedMs / 60000), 470, 'the Log reads 470 mg there');
eq(r.label, 'Propofol pump total 23.5 mL', 'label states the entry as typed');
ok(/Start → \d\d:\d\d:\d\d.* · ET 0:47:00/.test(pumpSync.info()), `preview: ${pumpSync.info().split('\n')[1]}`);

const mgBtn = el('tp-sync-units').children.find(b => b.dataset.unit === 'mg');
el('tp-sync-units').fire('click', { target: mgBtn });
eq(activeUnit(), 'mg', 'switching to mg');
// The popover closes on a click whose target is outside it; a re-rendered
// (detached) button reads as outside, so the tapped one must survive.
ok(el('tp-sync-units').children.includes(mgBtn), '… keeps the tapped button in the DOM (the popover stays open)');
eq(input.value, '470', '… converts the entry (23.5 mL → 470 mg), it does not clear it');
near(pumpSync.resolve(0).elapsedMs / 60000, 47, '… and resolves to the same time');

// The unit choice holds for the session, across re-opens.
pumpSync.onShow();
eq(activeUnit(), 'mg', 'mg is remembered the next time the pane opens');
eq(input.value, '', 'the entry starts empty each time');
pumpSync.setUnit('mL');

// A second drug: a picker appears, and switching drug clears the entry.
model.addBolus(F, 0, 0.1, 'IV push 100 mcg', { deliveryMode: 'push', source: 'manual' });
selected = F;
pumpSync.onShow();
eq(pumpSync.getDrug(), F, 'the selected drug card is preselected');
eq(el('tp-sync-drugs').children.length, 2, 'two drugs: a button each');
eq(JSON.stringify(unitButtons()), '["mcg"]', 'fentanyl without a pump: mcg only');
type('100');
near(pumpSync.resolve(0).elapsedMs / 60000, dur(model.getEvents(F)[0]),
     '100 mcg: the end of the 100 mcg push');
el('tp-sync-drugs').fire('click', { target: el('tp-sync-drugs').children.find(b => b.dataset.drug === P) });
eq(pumpSync.getDrug(), P, 'tapping Propofol switches drug');
eq(input.value, '', '… and clears the entry (a total from one pump says nothing about another)');
eq(activeUnit(), 'mL', '… back in mL for a pump drug');

// No answer.
model.addPause(P, 60, 'Pause');
type('31');                                               // 620 mg; the case stops at 600 mg
eq(pumpSync.resolve(0), null, 'more than the case delivers before its pause: no answer');
ok(/More than the sim ever delivers \(max 30\.0 mL\)/.test(pumpSync.info()),
   `the preview says why: ${pumpSync.info().split('\n')[1]}`);
type('abc');
eq(pumpSync.resolve(0), null, 'not a number: no answer');
type('0');
eq(pumpSync.resolve(0), null, 'zero: no answer');

console.log('\n── 2. timer.js popover ──');
selected = P;
const calls = [];
timer.init({
  onAdjust: () => calls.push('adjust'),
  sync: pumpSync,
  syncHooks: {
    beforeJump: () => { calls.push('before'); if (!timer.isRunning()) timer.start(); },
    afterJump: res => calls.push(`after:${res.fromMin.toFixed(2)}→${res.toMin.toFixed(2)}`),
  },
});
eq(el('tp-mode-sync').style.display, '', 'with a pane plugged in, the Pump Total mode is offered');

el('elapsed-timer').fire('click');
ok(el('timer-popover').classList.contains('open'), 'the popover opens');
eq(el('tp-btn-apply').textContent, 'Apply', 'opens in Start Time mode, with Apply');
el('tp-mode-sync').fire('click');
eq(el('tp-btn-apply').textContent, 'Sync', 'Pump Total: Apply reads Sync');
eq(el('tp-btn-now').style.display, 'none', '… and Now is hidden');
eq(el('tp-sync-pane').style.display, '', '… and the pane shows');

// A failed solve leaves everything alone.
type('31');
el('tp-btn-apply').fire('click');
eq(calls.length, 0, 'no answer: nothing runs');
ok(!timer.isRunning() && timer.getElapsedMs() === 0, '… the clock is untouched and the case not started');
ok(el('timer-popover').classList.contains('open'), '… and the popover stays open on the reason');

// 12 mL at 2% = 240 mg = 24 min. Sync starts the case, then moves the clock.
type('12');
el('tp-btn-apply').fire('click');
eq(calls.join(' | '), 'before | after:0.00→24.00 | adjust',
   'Sync: start the case, move the clock, afterJump, then one refresh');
ok(timer.isRunning(), 'the case is running');
near(timer.getElapsedMinutes(), 24, 'the clock reads ET 24:00', 0.01);
near(logTotal(P, timer.getElapsedMinutes()), 240, 'the Log reads the pump\'s 240 mg', 0.2);
near(Date.now() - timer.getWallClockStart().getTime(), 24 * 60000, 'the case start moved 24 min back', 1000);
ok(!el('timer-popover').classList.contains('open'), 'the popover closes');

// Enter in the entry syncs too, and a smaller total moves the clock back.
calls.length = 0;
el('elapsed-timer').fire('click');
el('tp-mode-sync').fire('click');
type('5');
input.fire('keydown', { key: 'Enter' });
near(timer.getElapsedMinutes(), 10, 'Enter syncs: 5 mL moves the clock back to ET 10:00', 0.01);
eq(calls.filter(c => c === 'adjust').length, 1, 'one refresh');

// Re-opening resets to Start Time mode.
el('elapsed-timer').fire('click');
eq(el('tp-btn-apply').textContent, 'Apply', 'the popover reopens in Start Time mode');
eq(el('tp-btn-now').style.display, '', '… with Now back');
eq(el('tp-sync-pane').style.display, 'none', '… and the pane hidden');
el('tp-btn-cancel').fire('click');

timer.reset();

console.log(`\n  ${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
