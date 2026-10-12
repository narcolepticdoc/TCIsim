/**
 * test-midnight-clock.mjs — typed clock times in a case that crosses midnight.
 *
 * Every clock time the user enters is HH:MM with no date. Two places pinned
 * that HH:MM to a fixed calendar day, and both failed silently once a case ran
 * past midnight:
 *
 *  1. Timer popover, "Start time" tab (timer.js). The HH:MM went on *today*, so
 *     at 00:40 a 23:15 start was tonight — "Start time is in the future" — and
 *     Apply closed the popover without changing anything.
 *
 *  2. RT event times (time-picker.js — event editor and reconcile modal). The
 *     HH:MM went on the *case start's* day, so in a case started at 23:00 an
 *     event at RT 00:30 resolved 22.5 h before the start and was clamped onto
 *     ET 0:00. Toggling ET → RT → ET did the same to an existing event.
 *
 * Also pinned here, because the round-trip depends on it: the selects split
 * case minutes as floor(min/60) : round(min % 60), so 59.6 became 0:60, which
 * matches no option — the browser falls back to the first, and it read 0:00.
 *
 * The resolver is checked in several time zones (including a half-hour offset)
 * and across both US DST changes; the picker and the timer popover are driven
 * through their real modules against stub selects that fall back to the first
 * option the way a browser does.
 */

process.env.TZ = 'America/New_York';

let passed = 0, failed = 0;
function eq(actual, expected, msg) {
  if (actual === expected) { passed++; console.log('  ok   ' + msg); }
  else { failed++; console.log(`  FAIL ${msg}\n         got=${actual}\n        want=${expected}`); }
}

// ---- Fake clock: `new Date()` / Date.now() read `fakeNowMs` when set ----
const RealDate = Date;
let fakeNowMs = null;
class FakeDate extends RealDate {
  constructor(...a) {
    if (a.length === 0 && fakeNowMs != null) super(fakeNowMs);
    else super(...a);
  }
  static now() { return fakeNowMs != null ? fakeNowMs : RealDate.now(); }
}
globalThis.Date = FakeDate;

// ---- Mini DOM: just what time-picker.js and timer.js touch ----
function makeEl() {
  const listeners = {};
  const cls = new Set();
  return {
    textContent: '', value: '', disabled: false, dataset: {}, style: {},
    parentElement: { style: {} },
    classList: {
      add: c => cls.add(c), remove: c => cls.delete(c), contains: c => cls.has(c),
      toggle: (c, on) => { if (on === undefined) on = !cls.has(c); on ? cls.add(c) : cls.delete(c); },
    },
    addEventListener(t, f) { (listeners[t] ||= []).push(f); },
    fire(t) { for (const f of listeners[t] || []) f({ target: this }); },
    contains: () => true,
  };
}
/** A <select>: with no option `selected`, its value is the first option's. */
function makeSelect() {
  return {
    options: [], _value: null, onchange: null, style: {},
    set innerHTML(_) { this.options = []; this._value = null; },
    get innerHTML() { return ''; },
    appendChild(o) { this.options.push(o); if (o.selected) this._value = String(o.value); },
    get value() { return this._value ?? (this.options.length ? String(this.options[0].value) : ''); },
    set value(v) {
      const s = String(v);
      this._value = this.options.some(o => String(o.value) === s) ? s : '';
    },
  };
}
const els = new Map();
for (const id of ['ee-hours', 'ee-minutes', 'tp-elapsed-h', 'tp-elapsed-m']) els.set(id, makeSelect());
for (const id of ['ee-conv', 'elapsed-timer', 'tp-btn-apply', 'tp-btn-now', 'tp-btn-cancel',
                  'input-start-time', 'tp-mode-start', 'tp-mode-elapsed', 'timer-wrap',
                  'timer-popover', 'tp-elapsed-row', 'tp-info', 'elapsed-time-val',
                  'case-start-val']) els.set(id, makeEl());
globalThis.document = {
  getElementById: id => els.get(id) || null,
  createElement: () => ({}),
  querySelectorAll: () => [],
  addEventListener() {},
};

const { resolveStartTime, resolveCaseClockTime } = await import('../js/util/clock-time.js');
const { makeTimePicker } = await import('../js/ui/time-picker.js');
const timer = await import('../js/ui/timer.js');

const at = (mo, d, h, m, s = 0) => new Date(2026, mo - 1, d, h, m, s);
const mins = (a, b) => Math.round((a - b) / 6000) / 10;   // b → a, in minutes (0.1)
const hm = d => d ? `${d.getMonth() + 1}/${d.getDate()} ${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}` : 'null';

// ---- 1. The resolvers, in several zones ----

for (const tz of ['America/New_York', 'Europe/London', 'Asia/Kolkata', 'Australia/Sydney', 'UTC']) {
  process.env.TZ = tz;
  console.log(`\n  resolveStartTime — ${tz}`);
  const lateNight = at(10, 6, 0, 40);
  eq(hm(resolveStartTime(23, 15, lateNight)), '10/5 23:15', '00:40, typed 23:15 → last night');
  eq(hm(resolveStartTime(0, 10, lateNight)), '10/6 0:10', '00:40, typed 00:10 → today, as before');
  eq(hm(resolveStartTime(0, 40, at(10, 6, 0, 40, 30))), '10/6 0:40', 'the current minute is not the future');
  eq(resolveStartTime(10, 5, at(10, 6, 10, 4)), null, '10:04, typed 10:05 → future, not 23 h 59 min ago');
  eq(hm(resolveStartTime(7, 0, at(10, 6, 23, 30))), '10/6 7:00', 'a 16.5 h day case keeps its same-day start');
  eq(hm(resolveStartTime(13, 0, lateNight)), '10/5 13:00', '00:40, typed 13:00 → yesterday (nearer than 12 h 20 ahead)');
  eq(resolveStartTime(12, 0, lateNight), null, '00:40, typed 12:00 → future (yesterday would be 12 h 40 ago)');

  console.log(`\n  resolveCaseClockTime — ${tz}`);
  const start = at(10, 5, 23, 0), now = at(10, 6, 0, 40);
  eq(mins(resolveCaseClockTime(0, 30, start, now), start), 90, 'started 23:00, now 00:40: 00:30 → ET 1:30');
  eq(mins(resolveCaseClockTime(23, 45, start, now), start), 45, '23:45 → ET 0:45');
  eq(mins(resolveCaseClockTime(2, 0, start, now), start), 180, '02:00 (planned) → ET 3:00');
  eq(mins(resolveCaseClockTime(22, 55, start, now), start), -5, '22:55 → just before the start, not tomorrow night');
  eq(mins(resolveCaseClockTime(23, 0, start, now), start), 0, 'the start minute → ET 0:00');
  const startSec = at(10, 5, 23, 0, 40);
  eq(mins(resolveCaseClockTime(23, 0, startSec, now), startSec), -0.7,
     'start at 23:00:40, pick 23:00 → the start (clamps to 0), not 24 h later');
  const day = at(10, 6, 8, 0), dayNow = at(10, 6, 10, 0);
  eq(mins(resolveCaseClockTime(9, 15, day, dayNow), day), 75, 'day case: 09:15 → ET 1:15, as before');
  eq(mins(resolveCaseClockTime(7, 0, day, dayNow), day), -60, 'day case: 07:00 → before the start, as before');
  eq(mins(resolveCaseClockTime(19, 30, day, at(10, 6, 8, 20)), day), 690,
     'day case: same-day 19:30 planned 11 h ahead stays same-day, as before');
  const longNow = at(10, 6, 13, 0);
  eq(mins(resolveCaseClockTime(10, 0, start, longNow), start), 660, '14 h overnight case: 10:00 → ET 11:00');
  eq(mins(resolveCaseClockTime(22, 0, start, longNow), start), -60, '14 h overnight case: 22:00 → before the start');
  eq(mins(resolveCaseClockTime(0, 30, start), start), 90, 'no `now` given: reads relative to the start');
  // The live `now` decides it: 13:00 is 10 h before a 23:00 start but, 10 h into
  // the case (now 09:00), only 4 h ahead. Read against the start alone it would
  // be the pre-start reading; a fixed 12 h cut-off would say the same.
  eq(mins(resolveCaseClockTime(13, 0, start, at(10, 6, 9, 0)), start), 840,
     '10 h into the case: 13:00 → ET 14:00 (4 h ahead), not before the start');
  eq(mins(resolveCaseClockTime(13, 0, start), start), -600, 'at the start itself, 13:00 is 10 h before it');
}

process.env.TZ = 'America/New_York';
console.log('\n  DST — America/New_York');
// 2026-11-01 02:00 EDT → 01:00 EST: 23:00 → 03:00 is five real hours.
const fbStart = at(10, 31, 23, 0);
eq(mins(resolveCaseClockTime(3, 0, fbStart, at(11, 1, 4, 0)), fbStart), 300,
   'fall back: started 23:00, RT 03:00 → ET 5:00 (real elapsed)');
eq(hm(resolveStartTime(23, 0, at(11, 1, 3, 0))), '10/31 23:00', 'fall back: start 23:00 typed at 03:00 → last night');
// 2026-03-08 02:00 EST → 03:00 EDT: 23:00 → 04:00 is four real hours.
const sfStart = at(3, 7, 23, 0);
eq(mins(resolveCaseClockTime(4, 0, sfStart, at(3, 8, 4, 30)), sfStart), 240,
   'spring forward: started 23:00, RT 04:00 → ET 4:00 (real elapsed)');

// ---- 2. The time picker, through the real module ----

console.log('\n  time-picker.js — case started 23:00, now 00:40');
let ws = at(10, 5, 23, 0);
let nowMin = 100;
const picker = makeTimePicker({
  hoursId: 'ee-hours', minutesId: 'ee-minutes', unitRowSel: '#none', conversionId: 'ee-conv',
  getWallClockStart: () => ws, getNowMinutes: () => nowMin,
  isRunning: () => true, labelStyle: 'prefix',
});
const sel = () => `${els.get('ee-hours').value}:${els.get('ee-minutes').value.padStart(2, '0')}`;

picker.setCaseMinutes(nowMin);
picker.setUnit('real');
eq(sel(), '0:40', 'Add Event at now, switched to RT, shows 00:40');
els.get('ee-hours').value = 0; els.get('ee-minutes').value = 30;
eq(picker.getCaseMinutes(), 90, 'RT 00:30 → ET 1:30 (was clamped to 0:00)');
picker.refreshConversion();
eq(els.get('ee-conv').textContent, '= ET 1:30', 'conversion label reads ET 1:30');
els.get('ee-hours').value = 22; els.get('ee-minutes').value = 55;
eq(picker.getCaseMinutes(), 0, 'RT 22:55 (before the start) still clamps to ET 0:00');
els.get('ee-hours').value = 2; els.get('ee-minutes').value = 0;
eq(picker.getCaseMinutes(), 180, 'RT 02:00 (planned) → ET 3:00');

picker.setCaseMinutes(60);
picker.setUnit('real');
eq(sel(), '0:00', 'existing event at ET 1:00 shows RT 00:00');
picker.setUnit('case');
eq(sel(), '1:00', 'ET → RT → ET round trip keeps ET 1:00 (was 0:00)');

console.log('\n  time-picker.js — minute carry');
ws = at(10, 5, 23, 0, 15);
picker.setCaseMinutes(60);
picker.setUnit('real');
picker.setUnit('case');
eq(sel(), '1:00', 'start 23:00:15: ET 1:00 round trip (59.75 min) reads 1:00, not 0:00');
picker.setCaseMinutes(59.7);
eq(sel(), '1:00', 'Add Event at 59.7 min opens at 1:00, not 0:00');
picker.setCaseMinutes(119.5);
eq(sel(), '2:00', '119.5 min opens at 2:00, not 1:00');
picker.setCaseMinutes(30.2);
eq(sel(), '0:30', '30.2 min opens at 0:30');
picker.setUnit('real');
els.get('ee-hours').value = 0; els.get('ee-minutes').value = 0;
picker.refreshConversion();
eq(els.get('ee-conv').textContent, '= ET 1:00', 'start 23:00:15, RT 00:00 (59.75 min) labels ET 1:00, not 0:60');

console.log('\n  time-picker.js — the live case clock decides');
ws = at(10, 5, 23, 0);
nowMin = 600;                                   // 09:00 the next morning
picker.setCaseMinutes(nowMin);
picker.setUnit('real');
els.get('ee-hours').value = 13; els.get('ee-minutes').value = 0;
eq(picker.getCaseMinutes(), 840, '10 h into a 23:00 case, RT 13:00 → ET 14:00 (uses getNowMinutes)');

console.log('\n  time-picker.js — cases past 24 h');
ws = at(10, 3, 8, 0);
nowMin = 3000;                                  // a restored case, 50 h in
picker.setCaseMinutes(1500);
eq(sel(), '25:00', 'an event at ET 25:00 opens at 25:00 (was 00:00 — no option for hour 25)');
eq(picker.getCaseMinutes(), 1500, '…and saves back at ET 25:00, not ET 0:00');
picker.setCaseMinutes(nowMin);
eq(sel(), '50:00', 'Add Event 50 h in opens at 50:00');
picker.setCaseMinutes(1439.6);
eq(sel(), '24:00', '1439.6 min rounds to 24:00 (was 00:00)');
picker.setCaseMinutes(90);
eq(els.get('ee-hours').options.length, 24, 'a short case still offers hours 0–23');

console.log('\n  time-picker.js — same-day case unchanged');
ws = at(10, 6, 8, 0);
nowMin = 120;
picker.setCaseMinutes(0);
picker.setUnit('real');
els.get('ee-hours').value = 9; els.get('ee-minutes').value = 15;
eq(picker.getCaseMinutes(), 75, 'started 08:00: RT 09:15 → ET 1:15');
els.get('ee-hours').value = 7; els.get('ee-minutes').value = 30;
eq(picker.getCaseMinutes(), 0, 'started 08:00: RT 07:30 clamps to ET 0:00');

// ---- 3. The timer popover, through the real module ----

console.log('\n  timer.js — start-time popover');
timer.init({});
const input = els.get('input-start-time');
const info = els.get('tp-info');
function setStart(val) {
  els.get('elapsed-timer').fire('click');   // open: prefills, mode = start
  input.value = val;
  input.fire('input');
  const shown = info.textContent;
  els.get('tp-btn-apply').fire('click');
  return shown;
}

fakeNowMs = at(10, 6, 0, 40).getTime();
eq(setStart('23:15'), 'Elapsed: 1:25:00 (yesterday)', 'at 00:40, 23:15 previews 1:25 elapsed (was "in the future")');
eq(hm(timer.getWallClockStart()), '10/5 23:15', 'Apply sets the start to last night (was a no-op)');
eq(timer.getElapsedMinutes(), 85, 'elapsed is 85 min');
eq(timer.formatWallClock(), '00:40', 'wall clock reads 00:40');

eq(setStart('00:41'), 'Start time is in the future', '00:41 typed at 00:40 is still the future');
eq(hm(timer.getWallClockStart()), '10/5 23:15', '…and Apply leaves the start alone');

fakeNowMs = at(10, 6, 14, 0).getTime();
eq(setStart('09:30'), 'Elapsed: 4:30:00', 'same-day start: no "(yesterday)"');
eq(timer.getElapsedMinutes(), 270, 'same-day start: 4:30 elapsed, as before');
els.get('elapsed-timer').fire('click');
eq(els.get('tp-elapsed-h').options.length, 24, 'at 4:30 the Elapsed tab still offers hours 0–23');
els.get('tp-btn-cancel').fire('click');

console.log('\n  timer.js — Elapsed tab past 24 h');
fakeNowMs = at(10, 6, 14, 0).getTime();
timer.setWallClockStart(new Date(fakeNowMs - (30 * 60 + 15) * 60000));   // a restored case, 30:15 in
els.get('elapsed-timer').fire('click');
els.get('tp-mode-elapsed').fire('click');
eq(`${els.get('tp-elapsed-h').value}:${els.get('tp-elapsed-m').value}`, '30:15',
   'the Elapsed tab opens at 30:15 (was 0:15 — no option for hour 30)');
els.get('tp-btn-apply').fire('click');
eq(timer.getElapsedMinutes(), 30 * 60 + 15, 'Apply without changes keeps 30:15 (was rewound to 0:15)');

console.log(`\n  ${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
