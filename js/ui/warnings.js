/**
 * warnings.js — Event Warning System
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
const DEFAULTS     = { prepSec: 30, alertSec: 10 };

const DRUG_NAMES = {
  propofol:     'Propofol',
  fentanyl:     'Fentanyl',
  ketamine:     'Ketamine',
  remifentanil: 'Remifentanil',
};

let _model      = null;
let _getDrugIds = null;
let _getPatient = null;

// One-shot guards — sets of event IDs that have already fired
const _alertFired = new Set();

// Active popups — eventId → HTMLElement
const _activePopups = new Map();

// ── Settings ──────────────────────────────────────────────────────────────────

export function getSettings() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const p = JSON.parse(raw);
      return {
        prepSec:  (typeof p.prepSec  === 'number' && p.prepSec  >= 0) ? p.prepSec  : DEFAULTS.prepSec,
        alertSec: (typeof p.alertSec === 'number' && p.alertSec >= 0) ? p.alertSec : DEFAULTS.alertSec,
      };
    }
  } catch (e) {}
  return { ...DEFAULTS };
}

export function setSettings({ prepSec, alertSec }) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify({ prepSec, alertSec })); } catch (e) {}
}

// ── Lifecycle ─────────────────────────────────────────────────────────────────

export function init(opts = {}) {
  _model      = opts.model;
  _getDrugIds = opts.getDrugIds || (() => ['propofol', 'fentanyl', 'ketamine']);
  _getPatient = opts.getPatient || (() => null);
  _ensureContainer();
  // Unlock AudioContext on first user gesture anywhere in the document
  document.addEventListener('click', unlockAudio, { once: true });
}

/** Clear all state and dismiss popups — call on new case. */
export function reset() {
  for (const el of _activePopups.values()) el.remove();
  _activePopups.clear();
  _alertFired.clear();
  document.querySelectorAll('.drug-card.warn-prep').forEach(el => el.classList.remove('warn-prep'));
}

// ── Per-frame check (call every rAF frame) ────────────────────────────────────

export function check(t) {
  if (!_model) return;
  const { prepSec, alertSec } = getSettings();

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

      const remSec = (nextEvt.time - t) * 60;

      // ── Prep: visual pulse (set/clear every frame based on current state) ──
      if (cardEl) cardEl.classList.toggle('warn-prep', remSec <= prepSec);

      // ── Alert: one-shot per event ID ──────────────────────────────────────
      if (remSec <= alertSec && !_alertFired.has(nextEvt.id)) {
        _alertFired.add(nextEvt.id);
        playAlert('warning');
        _showPopup(drugId, nextEvt, t);
      }

      // ── Update live countdown in the active popup for this event ──────────
      if (_activePopups.has(nextEvt.id)) {
        const cntEl = document.getElementById('wc-' + nextEvt.id);
        if (cntEl) {
          const rem = nextEvt.time - t;
          cntEl.textContent = rem > 0 ? 'in ' + _fmtCountdown(rem) : 'now';
        }
      }
    } catch (e) {}
  }
}

// ── Dismiss ───────────────────────────────────────────────────────────────────

export function dismiss(evtId) {
  const el = _activePopups.get(evtId);
  if (el) { el.remove(); _activePopups.delete(evtId); }
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
  const remMin   = evt.time - t;

  const el = document.createElement('div');
  el.className = 'warn-popup';
  el.dataset.evtId = evt.id;
  el.innerHTML =
    `<div class="warn-drug">${_esc(drugName)}</div>` +
    `<div class="warn-desc">${_esc(desc)}</div>` +
    `<div class="warn-countdown" id="wc-${_esc(evt.id)}">${remMin > 0 ? 'in ' + _fmtCountdown(remMin) : 'now'}</div>` +
    `<button class="warn-dismiss">Got it</button>`;

  el.querySelector('.warn-dismiss').addEventListener('click', () => dismiss(evt.id));
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

/** Minimal HTML escaping for dynamic content inserted via innerHTML. */
function _esc(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
