/**
 * settings.js — Settings & Event Warning System
 *
 * Two-tier advance warnings for upcoming pump events requiring intervention:
 *
 *   Prep  (default 30s): visual amber pulse on the drug card
 *   Alert (default 10s): two-pulse beep + persistent popup requiring "Got it"
 *
 * Fires for source:'tci' and source:'manual' events.
 * Skips source:'system' events (auto rate-restore — no human action needed).
 *
 * Settings stored in localStorage under 'tci-warn-settings'.
 * Call reset() on new case to clear state and dismiss all popups.
 */

import { formatEventAction } from '../util/event-label.js';
import { unlockAudio, playAlert } from './alert-sound.js';

const STORAGE_KEY = 'tci-warn-settings';
const DEFAULTS     = {
  prepSec: 30, prepSound: false,
  alertSec: 10, alertSound: true,
  redoseSound: true,
  statusWarnMinutes: 2,
  reactionDelaySec: 0, // 0–2 s; offsets countdowns/alerts earlier for TCI events
                       // so the trainee's natural reaction lag lands at the
                       // planned event time. Engine/history/chart are untouched.
  ceTolerance: 0.015,  // CET emulation post-extraction drift tolerance (0.005–0.030)
  ssSlopeTol:  0.0010, // Manual-mode plateau slope — per-minute relative (0.10 %/min)
  exitBandPct: 0.025,  // Plateau exit ±% band (0.025 = ±2.5%; range 0.01–0.05)
  cpOpacity:   1.0,    // Cp line opacity (0.1–1.0)
  nomogramOpacity: 1.0, // BIS nomogram band opacity (0.1–1.0, applied as multiplier)
  overlayOpacity:  1.0, // Threshold/target line opacity (0.1–1.0)
  alarmFlashBg: 0.08,  // Next Up alarm — peak background tint (0–0.30). The
                       // inset border is unaffected, so 0 leaves a border-only
                       // flash. The red "due" flash uses 1.25× this.
  ghostOpacity:    0.5, // Per-drug ghost Ce trace opacity (0.1–1.0)
  ghostTracesEnabled: false, // Show ghost Ce traces of non-selected drugs
  eventMarkerSize: 7,   // Future-event marker radius in px (4–16)
  textSize:    'normal',// Text scale: 'normal' | 'large' | 'xl' | 'xxl'
  theme:       'dark',  // App color scheme: 'dark' | 'light'
  showCeBand:  false,   // Show the Ce drift tolerance band around target lines
  timeAxisMode: 'min',  // Chart x-axis scale: 'min' | 'hmin' | 'rt' (real time)
  planningModeDefault: false, // Open dose entry straight into planning mode
  crossoverTimeLabels: false, // Label threshold-crossing dots with the crossing time
};

const TEXT_SIZES = ['normal', 'large', 'xl', 'xxl'];
const THEMES     = ['dark', 'light'];
const TIME_AXIS_MODES = ['min', 'hmin', 'rt'];

const DRUG_NAMES = {
  propofol:     'Propofol',
  fentanyl:     'Fentanyl',
  ketamine:     'Ketamine',
  remifentanil: 'Remifentanil',
};

let _model                = null;
let _getDrugIds           = null;
let _getPatient           = null;
let _timer                = null;
let _onMissedRecalculate  = null;
let _onDismiss            = null;

// One-shot guards — sets of event IDs that have already fired
const _prepSoundFired = new Set();
const _alertFired     = new Set();
const _zeroChimeFired = new Set();

// Active popups — eventId → HTMLElement
const _activePopups = new Map();

// Redose-threshold state, per drug. Present only while Ce is at or below the
// threshold; deleted when Ce climbs back above it.
//
//   since   — elapsed minutes the "redose due" count-up measures from: the
//             crossing, or the most recent dose once one has been given.
//   gen     — how many times this drug has crossed. Folded into the Next Up
//             item key so acknowledging one crossing cannot silence the next.
//   dosedAt — minutes of a dose given while still below threshold, else null.
//             While set, the panel stays quiet: the dose is still taking effect.
//   peakCe  — highest Ce seen since that dose. Once Ce falls away from the peak
//             and we are *still* under the threshold, the dose was not enough
//             and the alert re-arms. Tracking the peak rather than the previous
//             sample is what makes this work at any decay rate — a per-frame
//             delta on a slow decay is far too small to detect reliably.
const _belowThreshold = new Map();

// Survives the above→below delete, so generations keep increasing across a case.
const _redoseGen = new Map();

// Fraction below the post-dose peak that counts as "Ce has turned over".
const REARM_DROP = 0.005;

const _num = v => (typeof v === 'number' && isFinite(v)) ? v : null;

// ── Settings ──────────────────────────────────────────────────────────────────

export function getSettings() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const p = JSON.parse(raw);

      const ceTolerance = (typeof p.ceTolerance === 'number'
                           && p.ceTolerance >= 0.005 && p.ceTolerance <= 0.030)
        ? p.ceTolerance : DEFAULTS.ceTolerance;

      // Legacy `ssFraction` values (0.50–0.95) fall outside this window and
      // are silently replaced with the slope-based default — the old
      // asymptote-band semantic no longer exists.
      const ssSlopeTol = (typeof p.ssSlopeTol === 'number'
                          && p.ssSlopeTol >= 0.0001 && p.ssSlopeTol <= 0.0100)
        ? p.ssSlopeTol : DEFAULTS.ssSlopeTol;

      const exitBandPct = (typeof p.exitBandPct === 'number'
                           && p.exitBandPct >= 0.01 && p.exitBandPct <= 0.05)
        ? p.exitBandPct : DEFAULTS.exitBandPct;

      const cpOpacity = (typeof p.cpOpacity === 'number'
                        && p.cpOpacity >= 0.1 && p.cpOpacity <= 1.0)
        ? p.cpOpacity : DEFAULTS.cpOpacity;

      const nomogramOpacity = (typeof p.nomogramOpacity === 'number'
                               && p.nomogramOpacity >= 0.1 && p.nomogramOpacity <= 1.0)
        ? p.nomogramOpacity : DEFAULTS.nomogramOpacity;

      const overlayOpacity = (typeof p.overlayOpacity === 'number'
                              && p.overlayOpacity >= 0.1 && p.overlayOpacity <= 1.0)
        ? p.overlayOpacity : DEFAULTS.overlayOpacity;

      const alarmFlashBg = (typeof p.alarmFlashBg === 'number'
                            && p.alarmFlashBg >= 0 && p.alarmFlashBg <= 0.30)
        ? p.alarmFlashBg : DEFAULTS.alarmFlashBg;

      const ghostOpacity = (typeof p.ghostOpacity === 'number'
                            && p.ghostOpacity >= 0.1 && p.ghostOpacity <= 1.0)
        ? p.ghostOpacity : DEFAULTS.ghostOpacity;

      const ghostTracesEnabled = (typeof p.ghostTracesEnabled === 'boolean')
        ? p.ghostTracesEnabled : DEFAULTS.ghostTracesEnabled;

      const eventMarkerSize = (typeof p.eventMarkerSize === 'number'
                               && p.eventMarkerSize >= 4 && p.eventMarkerSize <= 16)
        ? p.eventMarkerSize : DEFAULTS.eventMarkerSize;

      const textSize = (typeof p.textSize === 'string' && TEXT_SIZES.includes(p.textSize))
        ? p.textSize : DEFAULTS.textSize;

      const theme = (typeof p.theme === 'string' && THEMES.includes(p.theme))
        ? p.theme : DEFAULTS.theme;

      const showCeBand = (typeof p.showCeBand === 'boolean')
        ? p.showCeBand : DEFAULTS.showCeBand;

      const timeAxisMode = (typeof p.timeAxisMode === 'string' && TIME_AXIS_MODES.includes(p.timeAxisMode))
        ? p.timeAxisMode : DEFAULTS.timeAxisMode;

      const planningModeDefault = (typeof p.planningModeDefault === 'boolean')
        ? p.planningModeDefault : DEFAULTS.planningModeDefault;

      const crossoverTimeLabels = (typeof p.crossoverTimeLabels === 'boolean')
        ? p.crossoverTimeLabels : DEFAULTS.crossoverTimeLabels;

      // Clamp to [0, 2] and snap to a 0.5 s grid.
      const reactionDelaySec = (typeof p.reactionDelaySec === 'number' && isFinite(p.reactionDelaySec))
        ? Math.round(Math.max(0, Math.min(2, p.reactionDelaySec)) * 2) / 2
        : DEFAULTS.reactionDelaySec;

      return {
        prepSec:           (typeof p.prepSec           === 'number'  && p.prepSec  >= 0) ? p.prepSec           : DEFAULTS.prepSec,
        prepSound:         (typeof p.prepSound         === 'boolean')                    ? p.prepSound          : DEFAULTS.prepSound,
        alertSec:          (typeof p.alertSec          === 'number'  && p.alertSec >= 0) ? p.alertSec          : DEFAULTS.alertSec,
        alertSound:        (typeof p.alertSound        === 'boolean')                    ? p.alertSound         : DEFAULTS.alertSound,
        redoseSound:       (typeof p.redoseSound       === 'boolean')                    ? p.redoseSound        : DEFAULTS.redoseSound,
        statusWarnMinutes: (typeof p.statusWarnMinutes === 'number'  && p.statusWarnMinutes >= 0) ? p.statusWarnMinutes : DEFAULTS.statusWarnMinutes,
        reactionDelaySec,
        ceTolerance,
        ssSlopeTol,
        exitBandPct,
        cpOpacity,
        nomogramOpacity,
        overlayOpacity,
        alarmFlashBg,
        ghostOpacity,
        ghostTracesEnabled,
        eventMarkerSize,
        textSize,
        theme,
        showCeBand,
        timeAxisMode,
        planningModeDefault,
        crossoverTimeLabels,
      };
    }
  } catch (e) {}
  return { ...DEFAULTS };
}

export function setSettings({ prepSec, prepSound, alertSec, alertSound, redoseSound, statusWarnMinutes, reactionDelaySec, ceTolerance, ssSlopeTol, exitBandPct, cpOpacity, nomogramOpacity, overlayOpacity, alarmFlashBg, ghostOpacity, ghostTracesEnabled, eventMarkerSize, textSize, theme, showCeBand, timeAxisMode, planningModeDefault, crossoverTimeLabels }) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify({ prepSec, prepSound, alertSec, alertSound, redoseSound, statusWarnMinutes, reactionDelaySec, ceTolerance, ssSlopeTol, exitBandPct, cpOpacity, nomogramOpacity, overlayOpacity, alarmFlashBg, ghostOpacity, ghostTracesEnabled, eventMarkerSize, textSize, theme, showCeBand, timeAxisMode, planningModeDefault, crossoverTimeLabels })); } catch (e) {}
}

/**
 * Compute the displayed "seconds to event" used by countdowns and alert
 * thresholds. For TCI-scheduled events that require a human at the pump
 * (`source: 'tci'`, type bolus/rate/pause), the value is biased earlier by
 * `reactionDelaySec` so the trainee's natural reaction lag lands them at the
 * planner's intended event time. The underlying event time is unchanged —
 * history, chart markers, and engine firing remain ground truth.
 *
 * Manual and system events return raw seconds-to-event unchanged.
 *
 * @param {Object} evt — event object with .time (min), .type, .source
 * @param {number} currentMin — current elapsed minutes
 * @param {number} [reactionDelaySec=0] — offset in seconds
 * @returns {number} displayed seconds-to-event (floored at 0 for TCI events)
 */
export function displayedSecToEvent(evt, currentMin, reactionDelaySec = 0) {
  const rawSec = (evt.time - currentMin) * 60;
  if (!evt || evt.source !== 'tci') return rawSec;
  if (evt.type !== 'bolus' && evt.type !== 'rate' && evt.type !== 'pause') return rawSec;
  if (!(reactionDelaySec > 0)) return rawSec;
  return Math.max(0, rawSec - reactionDelaySec);
}

// ── Lifecycle ─────────────────────────────────────────────────────────────────

export function init(opts = {}) {
  _model               = opts.model;
  _getDrugIds          = opts.getDrugIds || (() => ['propofol', 'fentanyl', 'ketamine']);
  _getPatient          = opts.getPatient || (() => null);
  _timer               = opts.timer || null;
  _onMissedRecalculate = opts.onMissedRecalculate || null;
  _onDismiss           = opts.onDismiss || null;
  _ensureContainer();
  // Unlock AudioContext on first user gesture anywhere in the document
  document.addEventListener('click', unlockAudio, { once: true });
}

/** Clear all state and dismiss popups — call on new case. */
export function reset() {
  for (const el of _activePopups.values()) el.remove();
  _activePopups.clear();
  _prepSoundFired.clear();
  _alertFired.clear();
  _zeroChimeFired.clear();
  _belowThreshold.clear();
  _redoseGen.clear();
  document.querySelectorAll('.drug-card.warn-prep').forEach(el => el.classList.remove('warn-prep'));
  const topbar = document.querySelector('.sim-topbar');
  if (topbar) topbar.classList.remove('warn-header');
}

/**
 * Call each frame for each intermittent drug.
 *
 * Owns the whole redose-threshold lifecycle:
 *   above→below   — new occurrence, stamp the crossing, chime once.
 *   below→above   — clear; the next drop starts a fresh occurrence.
 *   still below   — if a dose has been given, watch for Ce to turn over. Once it
 *                   falls away from its post-dose peak while still under the
 *                   threshold, that dose was not enough: re-arm, counting from
 *                   the dose, and chime again.
 *
 * The re-arm is the whole point. "A dose clears it for good" meant an
 * inadequate top-up silenced the panel for the rest of the case while the
 * patient sat under the threshold — the app knew (the drug card still said
 * "Below Redose Threshold") but the alert had gone.
 *
 * @param {string} drugId
 * @param {boolean} isBelow — Ce is at or below the redose threshold
 * @param {number} [t] — current elapsed minutes, stamped on the transition
 * @param {number} [ce] — current Ce, for post-dose peak detection
 */
export function checkBelowThreshold(drugId, isBelow, t, ce) {
  const now = _num(t) ?? 0;
  const s = _belowThreshold.get(drugId);

  if (!isBelow) {
    if (s) _belowThreshold.delete(drugId);
    return;
  }

  if (!s) {
    const gen = (_redoseGen.get(drugId) || 0) + 1;
    _redoseGen.set(drugId, gen);
    _belowThreshold.set(drugId,
      { since: now, gen, dosedAt: null, peakCe: null });
    if (getSettings().redoseSound) playAlert('redose');
    return;
  }

  // Still below, with a dose settling: has Ce peaked and started back down?
  if (s.dosedAt !== null) {
    const c = _num(ce);
    if (c !== null) {
      if (s.peakCe === null || c > s.peakCe) {
        s.peakCe = c;
      } else if (c < s.peakCe * (1 - REARM_DROP)) {
        s.since = s.dosedAt;
        s.dosedAt = null;
        s.peakCe = null;
        if (getSettings().redoseSound) playAlert('redose');
      }
    }
  }
}

/**
 * Record a dose given for a drug that is currently below its redose threshold.
 * Silences the "redose due" alert while the dose takes effect;
 * `checkBelowThreshold` re-arms it if Ce turns over still under the threshold.
 *
 * No-op (returns false) when the drug is not below threshold — an ordinary
 * bolus has nothing to acknowledge.
 */
export function noteRedoseDose(drugId, t) {
  const s = _belowThreshold.get(drugId);
  if (!s) return false;
  s.dosedAt = _num(t) ?? 0;
  s.peakCe = null;
  return true;
}

/**
 * Elapsed minutes the "redose due" count-up should measure from — the crossing,
 * or the most recent dose once one has been given. Null when the drug is above
 * its threshold.
 */
export function getBelowSince(drugId) {
  const s = _belowThreshold.get(drugId);
  return s ? s.since : null;
}

/**
 * How many times this drug has crossed below its threshold this case. Folded
 * into the Next Up item key so an acknowledgement cannot leak across
 * occurrences — the key is otherwise a per-drug slot that never goes away, so
 * `liveKeys` pruning can never release it.
 */
export function getRedoseGeneration(drugId) {
  return _redoseGen.get(drugId) || 0;
}

/** True while a dose is still taking effect, so the alert stays quiet. */
export function isRedoseDoseSettling(drugId) {
  const s = _belowThreshold.get(drugId);
  return !!(s && s.dosedAt !== null);
}

// ── Per-frame check (call every rAF frame) ────────────────────────────────────

export function check(t) {
  if (!_model) return;
  const { prepSec, prepSound, alertSec, alertSound, reactionDelaySec } = getSettings();
  let anyPrep = false;

  for (const drugId of _getDrugIds()) {
    try {
      const events = _model.getEvents(drugId);

      // Next future event that requires human intervention
      let nextEvt = null;
      for (const e of events) {
        if (e.time > t + 0.0001 && e.source !== 'system') { nextEvt = e; break; }
      }

      const cardEl = document.getElementById('drug-' + drugId);

      if (!nextEvt) {
        if (cardEl) cardEl.classList.remove('warn-prep');
        continue;
      }

      // Bias the displayed seconds-to-event earlier for TCI events so the
      // visual pulse, popup, and chimes fire `reactionDelaySec` ahead of the
      // event's real time. Manual events use raw seconds.
      const remSec = displayedSecToEvent(nextEvt, t, reactionDelaySec);
      const inPrep = remSec <= prepSec;

      // ── Prep: visual pulse + optional one-shot chime ──────────────────────
      if (cardEl) cardEl.classList.toggle('warn-prep', inPrep);
      if (inPrep) {
        anyPrep = true;
        if (prepSound && !_prepSoundFired.has(nextEvt.id)) {
          _prepSoundFired.add(nextEvt.id);
          playAlert('info');
        }
      }

      // ── Alert: one-shot popup + optional chime ────────────────────────────
      if (remSec <= alertSec && !_alertFired.has(nextEvt.id)) {
        _alertFired.add(nextEvt.id);
        if (alertSound) playAlert('warning');
        _showPopup(drugId, nextEvt, t);
      }

      // ── Update live countdown in the active popup for this event ──────────
      if (_activePopups.has(nextEvt.id)) {
        const cntEl = document.getElementById('wc-' + nextEvt.id);
        if (cntEl) {
          const remSec2 = displayedSecToEvent(nextEvt, t, reactionDelaySec);
          if (remSec2 > 0) {
            cntEl.textContent = 'in ' + _fmtCountdown(remSec2 / 60);
          } else {
            const wc = _timer && _timer.getWallClock();
            cntEl.textContent = wc ? `now (${_fmtWallClock(wc)} RT)` : 'now';
          }
        }
      }
    } catch (e) {}
  }

  // ── Zero-chime: fire once when an active popup's displayed countdown reaches zero.
  // For TCI events that's `reactionDelaySec` ahead of the real event time, so the
  // ding aligns with the popup's "now".
  for (const [evtId, el] of _activePopups) {
    const evtTime = Number(el.dataset.evtTime);
    const offsetMin = (el.dataset.evtSource === 'tci' && reactionDelaySec > 0)
      ? reactionDelaySec / 60 : 0;
    if (t >= evtTime - offsetMin && !_zeroChimeFired.has(evtId)) {
      _zeroChimeFired.add(evtId);
      const cntEl = document.getElementById('wc-' + evtId);
      if (cntEl) {
        const wc = _timer && _timer.getWallClock();
        cntEl.textContent = wc ? `now (${_fmtWallClock(wc)} RT)` : 'now';
      }
      playAlert('info');
    }
  }

  // ── Topbar header flash: active whenever any drug has a prep warning ──────
  const topbar = document.querySelector('.sim-topbar');
  if (topbar) topbar.classList.toggle('warn-header', anyPrep);
}

// ── Dismiss ───────────────────────────────────────────────────────────────────

export function dismiss(evtId) {
  const el = _activePopups.get(evtId);
  if (el) { el.remove(); _activePopups.delete(evtId); }
  // Acknowledging here is an acknowledgement everywhere — the Next Up panel
  // clears its matching row rather than making the user tap twice.
  if (_onDismiss) { try { _onDismiss(evtId); } catch (e) {} }
}

/** Dismiss all active popups for a specific drug (call after recalculate). */
export function dismissForDrug(drugId) {
  for (const [evtId, el] of _activePopups) {
    if (el.dataset.evtDrug === drugId) dismiss(evtId);
  }
}

// ── Internal helpers ──────────────────────────────────────────────────────────

function _ensureContainer() {
  if (!document.getElementById('warnings-container')) {
    const div = document.createElement('div');
    div.id = 'warnings-container';
    document.body.appendChild(div);
  }
}

function _showPopup(drugId, evt, t) {
  _ensureContainer();
  const container = document.getElementById('warnings-container');
  if (!container) return;

  const drugName = DRUG_NAMES[drugId] || (drugId.charAt(0).toUpperCase() + drugId.slice(1));
  const desc     = _fmtEventDesc(evt, drugId);
  const remSec   = displayedSecToEvent(evt, t, getSettings().reactionDelaySec);

  const isTci = evt.source === 'tci';

  const el = document.createElement('div');
  el.className = 'warn-popup';
  el.dataset.evtId    = evt.id;
  el.dataset.evtTime  = evt.time;
  el.dataset.evtSource = evt.source || '';
  el.dataset.evtDrug  = drugId;
  const initCountdown = remSec > 0 ? 'in ' + _fmtCountdown(remSec / 60) : (() => {
    const wc = _timer && _timer.getWallClock();
    return wc ? `now (${_fmtWallClock(wc)} RT)` : 'now';
  })();
  el.innerHTML =
    `<div class="warn-drug">${_esc(drugName)}</div>` +
    `<div class="warn-desc">${_esc(desc)}</div>` +
    `<div class="warn-countdown" id="wc-${_esc(evt.id)}">${initCountdown}</div>` +
    `<div class="warn-buttons">` +
      (isTci ? `<button class="warn-missed">Missed it — Recalculate</button>` : '') +
      `<button class="warn-dismiss">Got it</button>` +
    `</div>` +
    (isTci
      ? `<div class="warn-confirm" style="display:none">` +
          `<p class="warn-confirm-text">` +
            `TCI events from the missed <b>${_esc(drugName)}</b> step will be cleared ` +
            `and the target will be recalculated from now.` +
          `</p>` +
          `<div class="warn-confirm-buttons">` +
            `<button class="warn-confirm-no">No — Go back</button>` +
            `<button class="warn-confirm-yes">Yes, Recalculate</button>` +
          `</div>` +
        `</div>`
      : '');

  el.querySelector('.warn-dismiss').addEventListener('click', () => dismiss(evt.id));
  if (isTci) {
    el.querySelector('.warn-missed').addEventListener('click', () => {
      el.querySelector('.warn-buttons').style.display = 'none';
      el.querySelector('.warn-confirm').style.display = '';
    });
    el.querySelector('.warn-confirm-no').addEventListener('click', () => {
      el.querySelector('.warn-confirm').style.display = 'none';
      el.querySelector('.warn-buttons').style.display = '';
    });
    el.querySelector('.warn-confirm-yes').addEventListener('click', () => {
      dismiss(evt.id);
      if (_onMissedRecalculate) _onMissedRecalculate(drugId, evt.time);
    });
  }
  container.appendChild(el);
  _activePopups.set(evt.id, el);
}

function _fmtEventDesc(evt, drugId) {
  const patient = _getPatient ? _getPatient() : null;
  return formatEventAction(evt, drugId, {
    weightKg: patient ? patient.weight : undefined,
    variant: 'long',
  });
}


function _fmtCountdown(minutes) {
  if (!isFinite(minutes) || minutes <= 0) return '0:00';
  const totalSec = Math.round(minutes * 60);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function _fmtWallClock(d) {
  return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
}

/** Minimal HTML escaping for dynamic content inserted via innerHTML. */
function _esc(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
