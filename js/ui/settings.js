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

import { fromCanonical, formatValue, getDefaultUnit, getAllowedUnits, getPrefKey } from '../util/units.js';
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
  ghostOpacity:    0.5, // Per-drug ghost Ce trace opacity (0.1–1.0)
  ghostTracesEnabled: false, // Show ghost Ce traces of non-selected drugs
  eventMarkerSize: 7,   // Future-event marker radius in px (4–16)
  textSize:    'normal',// Text scale: 'normal' | 'large' | 'xl' | 'xxl'
  theme:       'dark',  // App color scheme: 'dark' | 'light'
  showCeBand:  false,   // Show the Ce drift tolerance band around target lines
  timeAxisMode: 'min',  // Chart x-axis scale: 'min' | 'hmin' | 'rt' (real time)
  planningModeDefault: false, // Open dose entry straight into planning mode
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

// One-shot guards — sets of event IDs that have already fired
const _prepSoundFired = new Set();
const _alertFired     = new Set();
const _zeroChimeFired = new Set();

// Active popups — eventId → HTMLElement
const _activePopups = new Map();

// Tracks which drugIds are currently below their intermittent redose threshold.
// Used to fire the chime once on the above→below transition.
const _belowThresholdActive = new Set();

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
        ghostOpacity,
        ghostTracesEnabled,
        eventMarkerSize,
        textSize,
        theme,
        showCeBand,
        timeAxisMode,
        planningModeDefault,
      };
    }
  } catch (e) {}
  return { ...DEFAULTS };
}

export function setSettings({ prepSec, prepSound, alertSec, alertSound, redoseSound, statusWarnMinutes, reactionDelaySec, ceTolerance, ssSlopeTol, exitBandPct, cpOpacity, nomogramOpacity, overlayOpacity, ghostOpacity, ghostTracesEnabled, eventMarkerSize, textSize, theme, showCeBand, timeAxisMode, planningModeDefault }) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify({ prepSec, prepSound, alertSec, alertSound, redoseSound, statusWarnMinutes, reactionDelaySec, ceTolerance, ssSlopeTol, exitBandPct, cpOpacity, nomogramOpacity, overlayOpacity, ghostOpacity, ghostTracesEnabled, eventMarkerSize, textSize, theme, showCeBand, timeAxisMode, planningModeDefault })); } catch (e) {}
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
  _belowThresholdActive.clear();
  document.querySelectorAll('.drug-card.warn-prep').forEach(el => el.classList.remove('warn-prep'));
  const topbar = document.querySelector('.sim-topbar');
  if (topbar) topbar.classList.remove('warn-header');
}

/**
 * Call each frame for each intermittent drug.
 * Fires a one-shot chime on the above→below threshold transition.
 * Clears state on the below→above transition so the next drop re-fires.
 */
export function checkBelowThreshold(drugId, isBelow) {
  const wasBelow = _belowThresholdActive.has(drugId);
  if (isBelow && !wasBelow) {
    _belowThresholdActive.add(drugId);
    if (getSettings().redoseSound) playAlert('redose');
  } else if (!isBelow && wasBelow) {
    _belowThresholdActive.delete(drugId);
  }
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
  try {
    if (evt.type === 'pause' || (evt.type === 'rate' && evt.value === 0)) {
      return 'Pause pump';
    }

    const patient = _getPatient ? _getPatient() : null;
    const ctx     = patient ? { weightKg: patient.weight } : {};

    if (evt.type === 'rate') {
      const unit       = _getPreferredUnit(drugId, 'rate');
      const displayVal = fromCanonical(evt.value, unit, drugId, 'rate', ctx);
      return `Rate → ${formatValue(displayVal, unit)} ${unit}`;
    }

    if (evt.type === 'bolus') {
      const unit       = _getPreferredUnit(drugId, 'bolus');
      const displayVal = fromCanonical(evt.value, unit, drugId, 'bolus', ctx);
      const label      = evt.deliveryMode === 'push' ? 'IV Push' : 'Bolus';
      return `${label} ${formatValue(displayVal, unit)} ${unit}`;
    }
  } catch (e) {}

  return evt.annotation || 'Event';
}

/** Read the user's persisted unit preference, falling back to default. */
function _getPreferredUnit(drugId, task) {
  const prefKey = getPrefKey(drugId, task);
  if (prefKey) {
    try {
      const saved   = localStorage.getItem(prefKey);
      const allowed = getAllowedUnits(drugId, task);
      if (saved && allowed.includes(saved)) return saved;
    } catch (e) {}
  }
  return getDefaultUnit(drugId, task);
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
