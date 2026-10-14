/**
 * test-module-state-reset.mjs — module state that used to outlive a case.
 *
 * Found by the audit that followed the stale-Emergence report (v0.6.5.1): the
 * same root cause, module-level state nothing reset on New Case, in four more
 * places. (The fifth, the setup-screen template keypad, is pinned in
 * test-template-keypad-concentration.mjs; localStorage carry-over — units and
 * last-dose memory — in test-case-carryover.mjs.)
 *
 *  1. Next Up's clock: reset() blanked the text but left an overdue item's red
 *     `nu-clock-due` styling and its glyph-count sizing on the new case's
 *     "--:--", with no "Nothing scheduled" label.
 *  2. The steady-state line and plateau box: chart-bridge cached the last value
 *     it pushed, and the cache outlived the chart. New Case → Restore recreates
 *     the chart; the restored case has the same steady state, so the new chart
 *     was never told and the line went missing.
 *  3. The Log's bolus-only filter (history.js) was only re-derived on a drug
 *     card tap, a mode change or a threshold edit — never on case entry. And
 *     the threshold-edit path used its own rule, so clearing a threshold on a
 *     TCI drug kept its rate steps hidden.
 *  4. The setup screen's cloud status lines ("Pulled — updated 3 min ago")
 *     survived New Case beside a form New Case had cleared.
 */

import { installMiniDom } from './helpers/mini-dom.mjs';

const dom = installMiniDom(['nu-list', 'nu-clock', 'nu-clock-label', 'hv-view-next',
                            'hv-tab-next', 'view-history', 'btn-nu-time']);
globalThis.document.addEventListener = () => {};

const fs = await import('node:fs');
const { createModel } = await import('../js/sim/simulation.js');
const { resetPumpSettings } = await import('../js/util/constants.js');
const nextUp = await import('../js/ui/next-up.js');
const { createChartBridge } = await import('../js/app/chart-bridge.js');

let passed = 0, failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log('  ok   ' + msg); }
  else      { failed++; console.log('  FAIL ' + msg); }
}

const PATIENT = { age: 51, weight: 50.3, height: 152.4, male: false, opioid: true };
const read = rel => fs.readFileSync(new URL(rel, import.meta.url), 'utf8');

// ── 1. Next Up: reset() restores the whole idle clock ────────────────────────
console.log('\n  Next Up clock after New Case');
resetPumpSettings();
const A = createModel();
A.setPatient(PATIENT);
A.addRate('propofol', 10, 5, 'Rate', { source: 'manual' });   // scheduled, then missed
let now = 5;
nextUp.reset();
nextUp.init({ model: A, getPatient: () => PATIENT, getDrugIds: () => ['propofol'],
              getElapsedMinutes: () => now });
nextUp.setActive(true);
nextUp.render(now); nextUp.onFrame(now);
now = 14;                                                      // 4 min overdue
nextUp.render(now); nextUp.onFrame(now);
const clock = dom.el('nu-clock'), label = dom.el('nu-clock-label');
ok(clock.textContent === '-4:00' && clock.classList.contains('nu-clock-due'),
   `precondition: a missed step owns the clock in red (${clock.textContent})`);
ok(/^MISSED/.test(label.textContent), `precondition: labelled "${label.textContent}"`);

nextUp.reset();
ok(clock.textContent === '--:--', 'reset(): the clock reads --:--');
ok(!clock.classList.contains('nu-clock-due'), 'reset(): the red overdue styling is gone');
ok(label.textContent === 'Nothing scheduled', 'reset(): labelled as an empty list is');

// The clock's font size keys off its glyph count (data-len): a long countdown
// left the next case's "--:--" at the wrong size.
const B = createModel();
B.setPatient(PATIENT);
B.addRate('propofol', 100, 5, 'Rate', { source: 'manual' });  // 95 min out
now = 5;
nextUp.init({ model: B, getPatient: () => PATIENT, getDrugIds: () => ['propofol'],
              getElapsedMinutes: () => now });
nextUp.render(now); nextUp.onFrame(now);
ok(clock.dataset.len === String(clock.textContent.length) && clock.dataset.len !== '5',
   `precondition: "${clock.textContent}" sized for ${clock.dataset.len} glyphs`);
nextUp.reset();
ok(clock.dataset.len === '5', 'reset(): sized for "--:--", not the old countdown');

// ── 2. The steady-state line and plateau box reach a recreated chart ─────────
console.log('\n  steady-state line after New Case → Restore');

/** A chart that records every setter call (and has every setter). */
function recordingChart() {
  const target = { calls: [], eventAnnotationsEnabled: false, ghostTracesEnabled: false };
  return new Proxy(target, {
    get(t, p) {
      if (p in t) return t[p];
      return (...args) => { t.calls.push([p, ...args]); };
    },
  });
}
const lastCall = (chart, name) => {
  const hits = chart.calls.filter(c => c[0] === name);
  return hits.length ? hits[hits.length - 1] : null;
};

const SS = 3.2;
const PLATEAU = { startMin: 2, endMin: 40, ceMin: 3.0, ceMax: 3.4 };
let liveChart = recordingChart();
const bridge = createChartBridge({
  getChart: () => liveChart,
  getModel: () => ({
    getEvents: () => [], getActiveReconciliationWindow: () => null,
    getActiveReconciliationGhost: () => null, getConcentrationsAt: () => ({ Ce: 0 }),
    getRateAtTime: () => 0,
  }),
  timer: { getWallClockStart: () => null },
  getSelectedDrug: () => 'propofol',
  mode: { get: () => 'manual', getExitCe: () => 0, getIntermittentThreshold: () => 0 },
  drugPanel: { getSteadyStateCe: () => SS, getPlateauRegion: () => PLATEAU },
  history: { updateDimming() {}, setTimeFormat() {} },
  settings: { getSettings: () => ({}), check() {} },
  nextUp: null, caseTotals: null, save() {},
});
const ys = bridge.getConfig('propofol').yScale;

bridge.onFrame(30);
const chartA = liveChart;
ok(lastCall(chartA, 'setSteadyStateLine')?.[1] === SS * ys, 'case A: its chart gets the line');
ok(lastCall(chartA, 'setPlateauRegion')?.[1]?.ceMax === PLATEAU.ceMax * ys, 'case A: and the plateau box');

// New Case destroys the chart; Restore builds a new one for the same case.
liveChart = recordingChart();
bridge.onFrame(30);
ok(lastCall(liveChart, 'setSteadyStateLine')?.[1] === SS * ys,
   'restored case: the new chart gets the same line (the cache used to swallow it)');
ok(lastCall(liveChart, 'setPlateauRegion')?.[1]?.ceMax === PLATEAU.ceMax * ys,
   'restored case: and the same plateau box');

// The setters must therefore be idempotent on the chart side (the invariant
// the bridge relies on for every other overlay).
const chartSrc = read('../js/ui/chart/index.js');
const body = name => chartSrc.slice(chartSrc.indexOf(`function ${name}(`),
                                    chartSrc.indexOf(`function ${name}(`) + 700);
ok(/if \(s\.steadyStateCe === next\) return;/.test(body('setSteadyStateLine')),
   'setSteadyStateLine early-returns on an unchanged value');
ok(/if \(prev === next\) return;[\s\S]*?\) return;\s*s\.plateauRegion = next;/.test(body('setPlateauRegion')),
   'setPlateauRegion early-returns on an unchanged region');
const bridgeSrc = read('../js/app/chart-bridge.js');
ok(!/lastSsCe|lastPlateauRegion/.test(bridgeSrc), 'chart-bridge keeps no last-value cache for them');

// ── 3. The Log's bolus-only filter: one rule, applied on case entry ─────────
console.log('\n  the Log\'s bolus-only filter');
const app = read('../js/app.js');
const calls = app.match(/history\.setBolusOnly\(/g) || [];
ok(calls.length === 1, `one call site sets it (found ${calls.length})`);
const helper = app.slice(app.indexOf('function syncHistoryFilter('), app.indexOf('function syncHistoryFilter(') + 400);
ok(/history\.setBolusOnly\(!isPumpEnabled\(drugId\) \|\| \(hasThreshold && mode\.get\(drugId\) !== 'manual'\)\)/.test(helper),
   'and it is syncHistoryFilter: no pump, or a threshold outside a manual infusion');
const initSim = app.slice(app.indexOf('function initSimScreen'), app.indexOf('function initSimScreen') + 4000);
ok(/mode\.reset\(\);[\s\S]*syncHistoryFilter\('propofol'\)/.test(initSim),
   'initSimScreen re-derives it after mode.reset() (every case entry)');
ok(!/isInfusing/.test(app), 'the threshold edit no longer applies its own rule');
ok((app.match(/syncHistoryFilter\(/g) || []).length >= 5,
   'drug card, mode change, threshold edit and case entry all use it');

// ── 4. The setup cloud status lines clear on New Case ───────────────────────
console.log('\n  setup cloud status lines');
ok(/const clearSetupSyncStatus = \(\) => \{ setPullStatus\(''\); setCaseStatus\(''\); setTemplateStatus\(''\); \};/.test(app),
   'clearSetupSyncStatus clears all three lines');
ok(/session\.newCase\(\);\s*clearSetupSyncStatus\(\);/.test(app),
   'New Case clears them as it returns to setup');

console.log(`\n  ${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
