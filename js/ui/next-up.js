/**
 * next-up.js — "Next Up" interventions heads-up display.
 *
 * The forward-looking half of the Events panel. Where history.js answers
 * "what happened", this answers "what do I have to do, and how long have I
 * got" — a full-width countdown clock over a short, curated, cross-drug list.
 *
 * Escalation reuses the drug-card warning thresholds (`prepSec` / `alertSec`
 * in js/ui/settings.js) so the panel, the card pulse, and the popups never
 * disagree:
 *
 *   > prepSec        quiet
 *   <= prepSec       amber pulse   ("get ready")
 *   <= 0             red pulse     ("do it now")
 *
 * Tapping anywhere silences the current alarm; a *newly* escalating item
 * re-arms it. Items that elapse without acknowledgement stay listed and
 * dimmed until tapped. Acknowledging a warning popup ("Got it") clears the
 * matching row here too — see the onDismiss wiring in js/app.js.
 *
 * Nothing here is ever written back to the model: acknowledgement state is
 * UI-side Sets, exactly as js/ui/settings.js does it.
 */

import { DRUG_DEFS } from '../util/constants.js';
import { inkOnWhite } from '../util/color.js';
import { formatEventAction } from '../util/event-label.js';
import { collectUpcoming, liveKeys } from '../sim/upcoming.js';
import { getSettings, displayedSecToEvent, getBelowSince,
         getRedoseGeneration, isRedoseSettling } from './settings.js';
import { fmtCountdown, fmtCeSmart } from './drug-panel/formatters.js';
import { getMilestones, getEmergenceArrival } from './drug-panel.js';

const $ = id => document.getElementById(id);

let _model            = null;
let _getPatient       = null;
let _getDrugIds       = null;
let _getWallClockStart = null;
let _getElapsedMinutes = null;

/** Live clock, falling back to the last rebuild rather than to zero. */
function _now() {
  if (_getElapsedMinutes) {
    try {
      const t = _getElapsedMinutes();
      if (typeof t === 'number' && isFinite(t)) return t;
    } catch (e) {}
  }
  return _lastRebuild > -1e8 ? _lastRebuild : 0;
}
let _active           = false;  // is the Next Up sub-view the visible one?

// Time display for the list only — the clock above it is always a countdown.
const ROW_TIME_MODES = ['countdown', 'et', 'rt'];
const ROW_TIME_KEY   = 'tci-pref-nextup-time-mode';
let _rowTimeMode = 'countdown';

// Acknowledgement state — UI-side only, cleared on new case.
const _clearedKeys = new Set();  // rows the user has dismissed
const _alarmMuted  = new Set();  // keys whose alarm has been silenced
const _seenFuture  = new Set();  // keys that were pending on an earlier pass —
                                 // only these can later be reported as missed
let _alarmingKeys  = new Set();  // keys at prep/due level right now

let _items       = [];    // last collected list
let _milestones  = [];    // last milestone candidates (for key pruning)
let _alarmLevel  = 'none';
let _lastRebuild = -1e9;  // sim-minutes timestamp of the last list rebuild
let _lastRenderedSig = '';

const REBUILD_INTERVAL_MIN = 500 / 60000;   // 500 ms, matching the chart cursor

/** How each item kind reads on the panel. */
const KIND_META = {
  bolus:         { verb: 'Bolus',        cls: 'nu-k-bolus',   actionable: true  },
  rate:          { verb: 'Set rate',     cls: 'nu-k-rate',    actionable: true  },
  resume:        { verb: 'Restart pump', cls: 'nu-k-resume',  actionable: true  },
  stop:          { verb: 'Pause pump',   cls: 'nu-k-stop',    actionable: true  },
  redose:        { verb: 'Redose due',   cls: 'nu-k-redose',  actionable: true  },
  emergence:     { verb: 'Emergence',    cls: 'nu-k-emerge',  actionable: false },
  target:        { verb: 'At target',    cls: 'nu-k-target',  actionable: false },
  ss:            { verb: 'Steady state', cls: 'nu-k-ss',      actionable: false },
  'plateau-in':  { verb: 'Plateau',      cls: 'nu-k-plat',    actionable: false },
  'plateau-out': { verb: 'Leaves plateau', cls: 'nu-k-plat',  actionable: false },
};

// ── Lifecycle ─────────────────────────────────────────────────────────────────

/**
 * @param {Object} opts
 * @param {Object} opts.model — simulation facade
 * @param {Function} opts.getPatient — () => patient
 * @param {Function} opts.getDrugIds — () => string[]
 */
export function init(opts = {}) {
  _model      = opts.model || null;
  _getPatient = opts.getPatient || (() => null);
  _getDrugIds = opts.getDrugIds || (() => []);
  _getWallClockStart = opts.getWallClockStart || (() => null);
  _getElapsedMinutes = opts.getElapsedMinutes || null;

  try {
    const saved = localStorage.getItem(ROW_TIME_KEY);
    if (saved && ROW_TIME_MODES.includes(saved)) _rowTimeMode = saved;
  } catch (e) {}
  _syncTimeButton();

  const btnTime = $('btn-nu-time');
  if (btnTime) {
    btnTime.addEventListener('click', (e) => {
      // Its own control — must not double as the tap-to-silence target.
      e.stopPropagation();
      cycleRowTimeMode();
    });
  }

  const view = $('hv-view-next');
  if (view) {
    // Panel-level tap silences the alarm. A tap that lands on a row is handled
    // by the row listener below, which stops propagation.
    view.addEventListener('click', silenceAlarm);
  }

  const list = $('nu-list');
  if (list) {
    list.addEventListener('click', (e) => {
      const row = e.target.closest('.nu-row');
      if (!row || !row.dataset.key) return;
      // Only elapsed rows are dismissible — a future item has nothing to ack yet.
      if (row.classList.contains('nu-elapsed')) {
        e.stopPropagation();
        markCleared(row.dataset.key);
        render();
      }
    });
  }
}

/** Clear all state — call on new case, alongside settings.reset(). */
export function reset() {
  _clearedKeys.clear();
  _alarmMuted.clear();
  _seenFuture.clear();
  _alarmingKeys = new Set();
  _items = [];
  _milestones = [];
  _alarmLevel = 'none';
  _lastRebuild = -1e9;
  _lastRenderedSig = '';
  _applyAlarmClasses('none');
  _syncTimeButton();
  const list = $('nu-list');
  if (list) list.innerHTML = '';
  const clock = $('nu-clock');
  if (clock) clock.textContent = '--:--';
  const label = $('nu-clock-label');
  if (label) label.textContent = '';
}

/** Tell the module whether its view is the visible one (skips DOM work if not). */
export function setActive(active) {
  if (_active === active) return;
  _active = active;
  if (_active) { _lastRebuild = -1e9; _lastRenderedSig = ''; }
}

export function isActive() { return _active; }

/** Mark an item key acknowledged — also called when a warning popup is dismissed. */
export function markCleared(key) {
  if (!key) return;
  _clearedKeys.add(key);
  _alarmMuted.add(key);
}

/** Current panel alarm level: 'none' | 'prep' | 'due'. */
export function getAlarmLevel() { return _alarmLevel; }

/**
 * Cycle the list's time display: countdown → case time → real time.
 * The clock above the list is always a countdown — that is the whole point of
 * it — so this only affects the rows.
 */
export function cycleRowTimeMode() {
  const i = ROW_TIME_MODES.indexOf(_rowTimeMode);
  _rowTimeMode = ROW_TIME_MODES[(i + 1) % ROW_TIME_MODES.length];
  try { localStorage.setItem(ROW_TIME_KEY, _rowTimeMode); } catch (e) {}
  _syncTimeButton();
  return _rowTimeMode;
}

export function getRowTimeMode() { return _rowTimeMode; }

function _syncTimeButton() {
  const btn = $('btn-nu-time');
  if (!btn) return;
  const map = { countdown: 'nu-t-cd', et: 'nu-t-et', rt: 'nu-t-rt' };
  for (const [mode, cls] of Object.entries(map)) {
    const el = btn.querySelector('.' + cls);
    if (el) el.classList.toggle('active', mode === _rowTimeMode);
  }
}

// ── Per-frame driver ──────────────────────────────────────────────────────────

/**
 * Called every rAF frame from chart-bridge's onFrame.
 *
 * The list is rebuilt on a 500 ms throttle (and on model mutation via
 * render()); the countdown re-renders every frame from the cached item times,
 * the same cache-and-tick pattern approach.js uses. No per-frame model calls.
 */
export function onFrame(t) {
  if (!_model) return;

  if (t - _lastRebuild >= REBUILD_INTERVAL_MIN) {
    _lastRebuild = t;
    _rebuild(t);
  }

  _updateAlarm(t);
  if (_active) {
    _renderClock(t);
    _renderRowTimes(t);
  }
}

/**
 * Rebuild the list now — call after a model mutation (from refreshChart).
 *
 * `t` defaults to the live clock, never to 0. A rebuild against a zero clock
 * makes every event in the case look pending, which poisons `_seenFuture` and
 * brings already-performed actions back as "missed".
 *
 * @param {number} [t] — current elapsed minutes.
 */
export function render(t = _now()) {
  if (!_model) return;
  _lastRebuild = t;
  _rebuild(t);
  _updateAlarm(t);
  if (_active) { _renderList(); _renderClock(t); }
}

// ── Collection ────────────────────────────────────────────────────────────────

function _rebuild(t) {
  let events = [];
  try { events = _model.getEvents() || []; } catch (e) { events = []; }

  _milestones = _collectMilestones(t);

  // Prune acknowledgement state for keys that no longer exist — a replan or a
  // deleted event must not leave entries behind for the length of the case.
  const live = liveKeys(events, _milestones);
  for (const k of [..._clearedKeys]) if (!live.has(k)) _clearedKeys.delete(k);
  for (const k of [..._alarmMuted])  if (!live.has(k)) _alarmMuted.delete(k);
  for (const k of [..._seenFuture])  if (!live.has(k)) _seenFuture.delete(k);

  _items = collectUpcoming({
    events,
    now: t,
    milestones: _milestones,
    cleared: _clearedKeys,
    seenFuture: _seenFuture,
  });

  // Remember what is still pending, so the *next* pass can tell a genuinely
  // missed intervention from an event the user just performed at the clock.
  for (const e of events) {
    if (e.source !== 'system' && e.time > t && e.id) _seenFuture.add(e.id);
  }

  if (_active) _renderList();
}

/**
 * Gather the clinical forecasts the drug panel has already computed this frame.
 *
 * Emergence is only offered when the pump is actually stopped — while it runs,
 * the exit readout answers a counter-factual ("if you stopped now"), which
 * would be a lie on a list of things that are going to happen.
 */
function _collectMilestones(t) {
  const out = [];
  // KIND_META is the single source of truth for whether a kind demands action;
  // the collector reads it off each milestone so the alarm cannot disagree.
  const push = (drugId, kind, time, ce, latched = false, occurrence = null) => out.push({
    drugId, kind, time, ce, latched, occurrence,
    actionable: KIND_META[kind]?.actionable === true,
  });

  // Redose is the one recurring milestone, so its acknowledgement state has to be
  // scoped to the occurrence. The token is the crossing generation plus whether
  // this is the crossing itself or the approach to the next one — four distinct
  // states, none of which can inherit a stale mute from another.
  const redoseOccurrence = (drugId, latched) =>
    `${getRedoseGeneration(drugId)}${latched ? 'c' : 'p'}`;

  for (const drugId of _getDrugIds()) {
    let ms, em;
    try { ms = getMilestones(drugId); } catch (e) { continue; }
    try { em = getEmergenceArrival(drugId); } catch (e) { em = null; }

    // Redose threshold already crossed. Latched at the moment of the crossing so
    // the row persists and keeps alarming — the crossing is something that
    // happened *to* the patient, not an action the user took, so it must not
    // self-acknowledge the way an event they created at the clock does. Only a
    // bolus (handled in collectUpcoming) or a tap clears it.
    if (ms.belowThreshold) {
      // Quiet while Ce may still be on its way up to the threshold — a dose
      // taking effect, or a threshold armed mid-climb. settings fires the alert
      // once Ce turns over still under the threshold, so neither an inadequate
      // dose nor a mid-climb arming can silence it for good.
      if (!isRedoseSettling(drugId)) {
        const since = getBelowSince(drugId);
        // No recorded crossing (e.g. a case restored already below threshold):
        // latch from now rather than dropping the alarm entirely.
        push(drugId, 'redose', since !== null ? since : t, ms.ce, true,
             redoseOccurrence(drugId, true));
      }
    } else if (ms.kind && ms.arrivalMin !== null && ms.arrivalMin > t) {
      // Still approaching: redose threshold, TCI target, or default emergence.
      push(drugId, ms.kind, ms.arrivalMin, ms.ce, false,
           ms.kind === 'redose' ? redoseOccurrence(drugId, false) : null);
    }
    if (ms.ssArrivalMin !== null && ms.ssArrivalMin > t) {
      push(drugId, 'ss', ms.ssArrivalMin, ms.ssCe);
    }
    if (ms.platKind && ms.platArrivalMin !== null && ms.platArrivalMin > t) {
      push(drugId, ms.platKind, ms.platArrivalMin, ms.platCe);
    }
    // User-configured Emerge threshold, pump stopped only.
    if (em && em.isIdle && em.arrivalMin !== null && em.arrivalMin > t
        && !out.some(o => o.drugId === drugId && o.kind === 'emergence')) {
      push(drugId, 'emergence', em.arrivalMin, em.exitCe);
    }
  }
  return out;
}

// ── Alarm state machine ───────────────────────────────────────────────────────

/** Seconds until an item is due, biased for TCI reaction delay where relevant. */
function _remSec(item, t, reactionDelaySec) {
  if (item.evt) return displayedSecToEvent(item.evt, t, reactionDelaySec);
  return (item.time - t) * 60;
}

function _updateAlarm(t) {
  const { prepSec, reactionDelaySec } = getSettings();

  let level = 'none';
  let anyUnmuted = false;
  const alarming = new Set();

  for (const item of _items) {
    if (!_isActionable(item)) continue;   // forecasts inform, they never alarm
    const rem = _remSec(item, t, reactionDelaySec);
    let itemLevel = 'none';
    if (rem <= 0)            itemLevel = 'due';
    else if (rem <= prepSec) itemLevel = 'prep';
    if (itemLevel === 'none') continue;

    alarming.add(item.key);
    if (itemLevel === 'due') level = 'due';
    else if (level !== 'due') level = 'prep';

    if (!_alarmMuted.has(item.key)) anyUnmuted = true;
  }
  _alarmingKeys = alarming;

  // Everything currently alarming has been silenced — hold quiet until
  // something new escalates.
  const effective = anyUnmuted ? level : 'none';
  if (effective !== _alarmLevel) {
    _alarmLevel = effective;
    _applyAlarmClasses(effective);
  }
}

function _isActionable(item) {
  const meta = KIND_META[item.kind];
  return meta ? meta.actionable : !!item.actionable;
}

/**
 * Silence the alarm that is currently sounding.
 *
 * Only the keys actually at prep/due level are muted. Muting the whole list
 * would pre-silence items that have not escalated yet, so the next
 * intervention would arrive with no alarm at all.
 */
export function silenceAlarm() {
  if (_alarmLevel === 'none') return;
  for (const key of _alarmingKeys) _alarmMuted.add(key);
  _alarmLevel = 'none';
  _applyAlarmClasses('none');
}

function _applyAlarmClasses(level) {
  const view = $('hv-view-next');
  if (view) {
    view.classList.toggle('nu-alarm-prep', level === 'prep');
    view.classList.toggle('nu-alarm-due',  level === 'due');
  }
  // Badge the sub-tab and the panel tab so an alarm is visible from the Log
  // view or the Chart tab, where the pulsing panel isn't on screen.
  for (const id of ['hv-tab-next', 'view-history']) {
    const el = $(id);
    if (!el) continue;
    el.classList.toggle('nu-badge-prep', level === 'prep');
    el.classList.toggle('nu-badge-due',  level === 'due');
  }
}

// ── Rendering ─────────────────────────────────────────────────────────────────

function _renderClock(t) {
  const clockEl = $('nu-clock');
  const labelEl = $('nu-clock-label');
  if (!clockEl) return;

  const { reactionDelaySec } = getSettings();

  // An outstanding item owns the clock and counts *up*. Skipping ahead to the
  // next thing while the panel pulses red made the alarm look like it belonged
  // to that next item — the clock and the alarm have to name the same thing.
  // `collectUpcoming` returns elapsed items first in ascending time order, so
  // this picks the oldest, i.e. the most overdue.
  // Acknowledging the alarm (muting) hands the clock back to the forward view;
  // the dimmed row stays as the reminder, so an unacknowledged-but-uncleared row
  // can't hold the clock for the rest of the case.
  const overdue = _items.find(i =>
    i.elapsed && _isActionable(i) && !_alarmMuted.has(i.key));

  // Otherwise: the next thing needing a human, falling back to the head forecast
  // so the panel isn't blank.
  const head = overdue
            || _items.find(i => _isActionable(i) && !i.elapsed)
            || _items.find(i => !i.elapsed)
            || null;

  if (!head) {
    if (clockEl.textContent !== '--:--') clockEl.textContent = '--:--';
    clockEl.classList.remove('nu-clock-due');
    _setClockLen(clockEl, '--:--');
    if (labelEl && labelEl.textContent !== 'Nothing scheduled') {
      labelEl.textContent = 'Nothing scheduled';
    }
    return;
  }

  let txt, due;
  if (head === overdue) {
    // Raw elapsed, deliberately NOT _remSec: that routes pump events through
    // displayedSecToEvent, which floors at 0 for TCI events once a reaction
    // delay is configured — a count-up built on it freezes at -0:00.
    txt = '-' + fmtHudCountdown(Math.max(0, t - head.time));
    due = true;
  } else {
    const rem = _remSec(head, t, reactionDelaySec);
    txt = rem > 0 ? fmtHudCountdown(rem / 60) : 'NOW';
    due = rem <= 0;
  }
  if (clockEl.textContent !== txt) clockEl.textContent = txt;
  clockEl.classList.toggle('nu-clock-due', due);
  // Publish the glyph count so CSS can pick the largest size that still fits the
  // column — the clock is monospaced with tabular figures, so width is exactly
  // proportional to length. See the .nu-clock width budget in index.html.
  _setClockLen(clockEl, txt);

  if (labelEl) {
    // "MISSED" only for a scheduled step the user didn't perform. A latched
    // threshold crossing is not a failure to act — the patient crossed a line —
    // and its verb ("Redose due") already reads correctly beside a count-up.
    const missed = head === overdue && head.evt;
    const lbl = (missed ? 'MISSED · ' : '')
              + `${_drugName(head.drugId)} — ${_verbFor(head)}`;
    if (labelEl.textContent !== lbl) labelEl.textContent = lbl;
  }
}

function _renderList() {
  const list = $('nu-list');
  if (!list) return;

  if (!_items.length) {
    const html = '<div class="nu-empty">No interventions scheduled.</div>';
    if (list.innerHTML !== html) list.innerHTML = html;
    _lastRenderedSig = '';
    return;
  }

  // Rebuild only when the set of rows changes — the times inside them are
  // patched every frame by _renderRowTimes().
  const sig = _items.map(i => `${i.key}:${i.elapsed ? 1 : 0}`).join('|');
  if (sig === _lastRenderedSig) return;
  _lastRenderedSig = sig;

  list.innerHTML = _items.map(_buildRow).join('');
}

function _buildRow(item) {
  const meta  = KIND_META[item.kind] || { cls: '' };
  const cls   = ['nu-row', meta.cls, item.elapsed ? 'nu-elapsed' : '',
                 item.latched ? 'nu-latched' : '',
                 _isActionable(item) ? 'nu-act' : 'nu-info'].filter(Boolean).join(' ');
  // Two inks per row: the palette colour for the dark UI it was tuned for, and a
  // darkened one for the light theme. Both are emitted so a runtime theme switch
  // is picked up by CSS alone — the list only re-renders when its rows change.
  const color = DRUG_DEFS[item.drugId]?.color || null;
  const vars = color
    ? `--nu-drug:${_esc(color)};--nu-drug-ink:${_esc(inkOnWhite(color))}`
    : '';

  return `<div class="${cls}" data-key="${_esc(item.key)}" style="${vars}">` +
           `<div class="nu-main">` +
             `<span class="nu-drug">${_esc(_drugName(item.drugId))}</span>` +
             `<span class="nu-verb">${_esc(_verbFor(item))}</span>` +
           `</div>` +
           `<div class="nu-side">` +
             `<span class="nu-value">${_esc(_valueFor(item))}</span>` +
             `<span class="nu-time" data-key="${_esc(item.key)}"></span>` +
           `</div>` +
         `</div>`;
}

/**
 * Countdown for the HUD.
 *
 * `fmtCountdown` renders bare minutes, which is right for a pump step a few
 * minutes out but reads as "300:00" for a ketamine redose threshold five hours
 * away. Past the hour, switch to `5h 02m`.
 *
 * Seconds are dropped deliberately, not just for width: a five-hour prediction
 * does not carry second-level precision, and a ticking seconds field claims it
 * does. It also bounds the string at 7 characters (`12h 05m`), which the clock's
 * width budget depends on — see the .nu-clock rules in index.html.
 *
 * Kept local rather than changed in formatters.js, where the drug cards rely on
 * the existing form.
 */
function fmtHudCountdown(minutes) {
  if (!isFinite(minutes) || minutes <= 0) return '0:00';
  if (minutes < 60) return fmtCountdown(minutes);
  const totalMin = Math.round(minutes);
  const h = Math.floor(totalMin / 60);
  const m = String(totalMin % 60).padStart(2, '0');
  return `${h}h ${m}m`;
}

/**
 * Publish the clock's glyph count as `data-len`, clamped to the range the CSS
 * defines a fit factor for. CSS cannot count characters, and the clock's width
 * is exactly `glyphs × advance` because the face is monospaced with tabular
 * figures — so the glyph count is all CSS needs to pick a size that fills the
 * column without overflowing it.
 */
function _setClockLen(el, txt) {
  const n = Math.max(3, Math.min(8, String(txt).length));
  if (el.dataset.len !== String(n)) el.dataset.len = String(n);
}

/** Elapsed case time of an absolute event time, as H:MM:SS. */
function fmtCaseTime(minutes) {
  const totalSec = Math.max(0, Math.round(minutes * 60));
  const h = Math.floor(totalSec / 3600);
  const m = String(Math.floor((totalSec % 3600) / 60)).padStart(2, '0');
  const s = String(totalSec % 60).padStart(2, '0');
  return `${h}:${m}:${s}`;
}

/** Wall-clock time of an absolute event time, as H:MM:SS. Null without a start. */
function fmtRealTime(minutes) {
  const start = _getWallClockStart ? _getWallClockStart() : null;
  if (!start) return null;
  const d = new Date(start.getTime() + minutes * 60000);
  return `${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}` +
         `:${String(d.getSeconds()).padStart(2, '0')}`;
}

/**
 * Patch per-row state in place every frame — no innerHTML churn.
 *
 * Covers the time column and the acknowledged flag. The flag has to live here
 * rather than in _buildRow: muting an alarm does not change the row *set*, so
 * _renderList's signature guard would skip the rebuild.
 */
function _renderRowTimes(t) {
  const { reactionDelaySec } = getSettings();
  const list = $('nu-list');
  if (!list) return;
  for (const row of list.querySelectorAll('.nu-row')) {
    const key  = row.dataset.key;
    const item = _items.find(i => i.key === key);
    if (!item) continue;
    row.classList.toggle('nu-acked', _alarmMuted.has(key));
    const el = row.querySelector('.nu-time');
    if (!el) continue;
    const txt = _rowTimeText(item, t, reactionDelaySec);
    if (el.textContent !== txt) el.textContent = txt;
  }
}

function _rowTimeText(item, t, reactionDelaySec) {
  if (_rowTimeMode === 'et') return fmtCaseTime(item.time);
  if (_rowTimeMode === 'rt') {
    // No wall-clock start (pre-case) — fall back rather than blank the column.
    const rt = fmtRealTime(item.time);
    if (rt) return rt;
  }
  // Anything outstanding counts *up*: how long it has been waiting. Matches the
  // clock, which tracks the oldest overdue item in the same form. (The two used
  // to disagree — a latched crossing counted up while a missed pump step said
  // "missed", so the clock could show -2:14 for a row reading "missed".)
  if (item.elapsed) return '-' + fmtHudCountdown(Math.max(0, t - item.time));
  const rem = _remSec(item, t, reactionDelaySec);
  return rem > 0 ? fmtHudCountdown(rem / 60) : 'now';
}

// ── Label helpers ─────────────────────────────────────────────────────────────

function _drugName(drugId) {
  return DRUG_DEFS[drugId]?.name
      || (drugId ? drugId.charAt(0).toUpperCase() + drugId.slice(1) : '');
}

function _verbFor(item) {
  // A pause, and the rate step that ends one, read better as pump actions than
  // as "Set rate 0" / "Set rate 12" — the value still shows alongside.
  if (item.kind === 'resume' || item.kind === 'stop') return KIND_META[item.kind].verb;
  if (item.evt) {
    const parts = _eventParts(item);
    if (parts && parts.verb) return parts.verb;
  }
  return KIND_META[item.kind]?.verb || 'Event';
}

function _valueFor(item) {
  if (item.evt) {
    const parts = _eventParts(item);
    return (parts && parts.value) || '';
  }
  const ce = item.milestone ? item.milestone.ce : null;
  return (ce != null && ce > 0) ? fmtCeSmart(ce, item.drugId) : '';
}

function _eventParts(item) {
  const patient = _getPatient ? _getPatient() : null;
  return formatEventAction(item.evt, item.drugId, {
    weightKg: patient ? patient.weight : undefined,
    variant: 'hud',
  });
}

/** Minimal HTML escaping for dynamic content inserted via innerHTML. */
function _esc(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
