/**
 * prefs-sync.js — Preferences cloud sync (kind 'prefs').
 *
 * Collects the user's persistent configuration (visual appearance, unit
 * defaults, pump setup, chart scales) into a versioned blob keyed to the
 * same 6-char pairing code as patient/case/template sync, so a fresh
 * install (e.g. after an iOS PWA reinstall wipes localStorage) can be
 * restored with: enter code → pull preferences.
 *
 * The manifest below is the SINGLE list of synced keys. Everything else in
 * localStorage is deliberately excluded:
 *   - tci-sync-code           (circular — the code retrieves this blob)
 *   - tci-sim-last-case       (has its own case sync, 24 h kind)
 *   - tci-dose-template(+-armed) (has its own template sync, 30 d kind)
 *   - working unit-pref keys  (in-case state, reseeded from -default on New Case)
 *   - tci_lastBolus_/lastRate_ (transient per-device dose memory)
 *
 * applyPrefs is manifest-filtered in BOTH directions: unknown keys in a
 * pulled blob are ignored (a cloud payload must never write arbitrary
 * localStorage), and manifest keys absent from the blob are removed so the
 * device fully mirrors the pushing device.
 */

import { DRUG_IDS } from '../util/constants.js';
import { getDefaultPrefKey } from '../util/units.js';

/** Bump ONLY on breaking format changes; additive keys stay v1. */
export const PREFS_SCHEMA_VERSION = 1;

/**
 * The authoritative list of synced preference keys.
 * @returns {string[]}
 */
export function prefsManifest() {
  const keys = [
    'tci-warn-settings',                // settings blob: theme, text size, sounds, opacities, tolerances
    'tci-pref-quantizeInDisplay',       // round-TCI-plan-in-display-units flag
    'tci-pump-max-rate',                // global pump bolus rate (mL/h)
    'tci-pref-history-show-notations',  // history notations toggle
    'tci-pref-nextup-time-mode',        // Next Up list time display: countdown / ET / RT
    'tci-sim-units',                    // metric / imperial
    'tci-mode',                         // setup default TCI planning mode
    'tci-opioid',                       // setup opioid co-administration default
  ];
  for (const drug of DRUG_IDS) {
    // Setup-default display units (never the in-case working keys)
    for (const task of ['bolus', 'rate']) {
      const k = getDefaultPrefKey(drug, task);
      if (k) keys.push(k);
    }
    // Pump concentration defaults (propofol uses the unsuffixed legacy key)
    keys.push(drug === 'propofol' ? 'tci-pump-concentration' : `tci-pump-concentration-${drug}`);
    // Pump delivery method (propofol is pump-mandatory — no stored flag)
    if (drug !== 'propofol') keys.push(`tci-pump-enabled-${drug}`);
    // Chart y-axis scale
    keys.push(`chart-ymax-${drug}`);
  }
  return keys;
}

/**
 * Snapshot the current preferences into a pushable payload.
 * Values are verbatim localStorage strings; absent keys are omitted.
 * @returns {{v: number, updatedAt: number, prefs: Object}}
 */
export function collectPrefs() {
  const prefs = {};
  for (const key of prefsManifest()) {
    try {
      const val = localStorage.getItem(key);
      if (val !== null) prefs[key] = val;
    } catch (e) {}
  }
  return { v: PREFS_SCHEMA_VERSION, updatedAt: Date.now(), prefs };
}

/** True when a payload carries no preference values worth pushing/applying. */
export function isPrefsEmpty(payload) {
  return !payload || typeof payload.prefs !== 'object' || payload.prefs === null ||
    Object.keys(payload.prefs).length === 0;
}

/**
 * True when a pulled blob was saved by a NEWER schema than this build
 * understands — the caller should show an "update this device" message.
 */
export function isNewerPrefsSchema(payload) {
  return !!payload && typeof payload === 'object' &&
    typeof payload.v === 'number' && payload.v > PREFS_SCHEMA_VERSION;
}

/**
 * Apply a pulled preferences payload. Only manifest keys are written; keys
 * missing from the payload are removed so this device mirrors the pusher.
 * The caller should reload the app afterwards — modules read these keys at
 * init and a reload is the one robust way to re-apply everything.
 *
 * @returns {number|null} count of keys written, or null when the payload
 *          is invalid or from a newer schema.
 */
export function applyPrefs(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  if (typeof payload.v !== 'number' || !isFinite(payload.v)) return null;
  if (payload.v > PREFS_SCHEMA_VERSION) return null; // newer schema — never half-apply
  if (!payload.prefs || typeof payload.prefs !== 'object' || Array.isArray(payload.prefs)) return null;

  let applied = 0;
  for (const key of prefsManifest()) {
    try {
      const val = payload.prefs[key];
      if (typeof val === 'string') {
        localStorage.setItem(key, val);
        applied++;
      } else {
        localStorage.removeItem(key);
      }
    } catch (e) {}
  }
  return applied;
}
