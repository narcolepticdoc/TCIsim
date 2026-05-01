/**
 * sw-register.js — Service worker registration, version polling, status display.
 *
 * Hard rule: nothing that could swap the running app's modules out from
 * under it ever fires while a case is in progress. All three failure
 * modes for that — version polling, SKIP_WAITING posts, and the
 * controllerchange→reload chain — are gated on `isOnSetupScreen()`.
 *
 * If an update is detected (or a previous SKIP_WAITING already activated)
 * while the user is on the sim/analysis screen, we park the new worker
 * in `waiting` (or hold a `pendingReload` flag) and apply it the next
 * time the user returns to the setup screen — driven by the
 * `tcisim:screenchange` event dispatched from `app.js#showScreen`.
 *
 * Status display: writes a status line into #app-status-tag (sits under
 * #app-version-tag in the setup-screen brand panel). Steady states show
 * the timestamp of the currently-cached version:
 *   • just-updated → "✓ New update installed. Last update <ts>."
 *                    (sticky for the whole session — survives
 *                     online/offline transitions)
 *   • online       → "No new version available. Last update <ts>."
 *   • offline      → "Offline. Cached version last updated <ts>."
 * Transient states ("Update available (vX)…", "Updating to latest…",
 * "↻ Update queued · applies at next case start.") wrap around the SW
 * update flow. The install timestamp is persisted in localStorage and
 * re-stamped whenever the stored version no longer matches the running
 * APP_VERSION (which is exactly when an update has just been applied).
 */

import { APP_VERSION } from '../util/constants.js';

const POLL_INTERVAL_MS = 60_000;
const VERSION_RE = /VERSION\s*=\s*['"]([^'"]+)['"]/;
const STATUS_EL_ID = 'app-status-tag';
const SS_JUST_UPDATED = 'tcisim:justUpdated';
const LS_INSTALLED_VERSION = 'tcisim:installedVersion';
const LS_INSTALLED_AT = 'tcisim:installedAt';

const supportsServiceWorker = 'serviceWorker' in navigator;
const installedAt = stampInstallTimeIfNeeded();
const justUpdated = consumeJustUpdatedFlag();
let updateTriggered = false;
let pendingReload = false;
let reloading = false;
let registration = null;

if (supportsServiceWorker) {
  window.addEventListener('load', () => { init().catch(() => {}); });
} else {
  // No SW support — still surface online/offline + last-update timestamp
  // so the user has the same readout as the SW path. Wait for
  // DOMContentLoaded so the status element exists.
  document.addEventListener('DOMContentLoaded', () => {
    refreshConnectivityStatus();
    window.addEventListener('online', refreshConnectivityStatus);
    window.addEventListener('offline', refreshConnectivityStatus);
  });
}

async function init() {
  refreshConnectivityStatus();
  window.addEventListener('online', refreshConnectivityStatus);
  window.addEventListener('offline', refreshConnectivityStatus);
  attachVersionTagHandler();

  registration = await navigator.serviceWorker.register('sw.js');

  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!updateTriggered) {
      // First-install claim — no reload, just refresh the status (we're now
      // controlled and future loads will be served from cache).
      refreshConnectivityStatus();
      return;
    }
    if (reloading) return;
    if (!isOnSetupScreen()) {
      // Update activated mid-case. Hold the reload until the user returns
      // to setup — handled by the screenchange listener below.
      pendingReload = true;
      setStatus('updated', '↻ Update queued · applies at next case start.');
      return;
    }
    triggerReload();
  });

  registration.addEventListener('updatefound', () => {
    const installing = registration.installing;
    if (!installing) return;
    installing.addEventListener('statechange', () => {
      if (installing.state !== 'installed') return;
      if (!navigator.serviceWorker.controller) return;
      if (!isOnSetupScreen()) {
        // New worker is parked in `waiting`. Don't activate during a sim;
        // we'll post SKIP_WAITING the next time the user enters setup.
        setStatus('updated', '↻ Update queued · applies at next case start.');
        return;
      }
      activateWaitingWorker(installing);
    });
  });

  document.addEventListener('tcisim:screenchange', onScreenChange);

  const poll = () => checkServerVersion().catch(() => {});
  poll();
  setInterval(poll, POLL_INTERVAL_MS);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') poll();
  });
}

function onScreenChange(event) {
  const id = event && event.detail && event.detail.id;
  if (id !== 'setup-screen') return;
  if (pendingReload && !reloading) {
    triggerReload();
    return;
  }
  if (registration && registration.waiting) {
    activateWaitingWorker(registration.waiting);
    return;
  }
  checkServerVersion().catch(() => {});
}

function activateWaitingWorker(worker) {
  updateTriggered = true;
  setStatus('updating', 'Updating to latest…');
  worker.postMessage('SKIP_WAITING');
}

function triggerReload() {
  if (reloading) return;
  reloading = true;
  try { sessionStorage.setItem(SS_JUST_UPDATED, '1'); } catch (_) {}
  location.reload();
}

async function checkServerVersion() {
  if (!registration) return false;
  if (!isOnSetupScreen()) return false;

  let res;
  try {
    res = await fetch(`js/version.js?_=${Date.now()}`, { cache: 'no-store' });
  } catch (_) {
    return false;
  }
  if (!res.ok) return false;
  const text = await res.text();
  const match = text.match(VERSION_RE);
  if (!match) return false;
  const serverVersion = match[1];
  if (serverVersion !== APP_VERSION) {
    setStatus('updating', `Update available (v${serverVersion})…`);
    try { await registration.update(); } catch (_) {}
    return true;
  }
  return false;
}

let manualCheckInFlight = false;

async function manualCheck() {
  if (manualCheckInFlight) return;
  if (!registration || !isOnSetupScreen()) return;
  manualCheckInFlight = true;
  setStatus('updating', 'Checking for updates…');
  try {
    const found = await checkServerVersion();
    // checkServerVersion already paints "Update available (vX)…" when it
    // finds something, and the SW lifecycle takes over from there. For
    // the no-update path, fall back to the steady-state status.
    if (!found) refreshConnectivityStatus();
  } finally {
    manualCheckInFlight = false;
  }
}

function isOnSetupScreen() {
  const el = document.getElementById('setup-screen');
  return !!(el && el.classList.contains('active'));
}

// Stamp the install time the first ever boot, and re-stamp on the boot
// right after an update (when stored version no longer matches APP_VERSION).
function stampInstallTimeIfNeeded() {
  let storedVersion = null;
  let storedAt = null;
  try {
    storedVersion = localStorage.getItem(LS_INSTALLED_VERSION);
    storedAt = localStorage.getItem(LS_INSTALLED_AT);
  } catch (_) { /* private mode etc. */ }

  if (storedVersion !== APP_VERSION || !storedAt) {
    const nowIso = new Date().toISOString();
    try {
      localStorage.setItem(LS_INSTALLED_VERSION, APP_VERSION);
      localStorage.setItem(LS_INSTALLED_AT, nowIso);
    } catch (_) {}
    return new Date(nowIso);
  }
  const parsed = new Date(storedAt);
  return isNaN(parsed.getTime()) ? new Date() : parsed;
}

function formatTimestamp(date) {
  try {
    return date.toLocaleString(undefined, {
      year: 'numeric', month: 'short', day: 'numeric',
      hour: '2-digit', minute: '2-digit',
    });
  } catch (_) {
    return date.toISOString().replace('T', ' ').slice(0, 16);
  }
}

function refreshConnectivityStatus() {
  const ts = formatTimestamp(installedAt);
  // The just-updated state is sticky for the whole session — once an update
  // has been applied, "✓ New update installed." stays the active message
  // (regardless of connectivity) until the user reloads without an update.
  if (justUpdated) {
    setStatus('updated', `✓ New update installed. Last update ${ts}.`);
    return;
  }
  const online = navigator.onLine !== false;
  if (online) {
    setStatus('online', `No new version available. Last update ${ts}.`);
  } else {
    setStatus('offline', `Offline. Cached version last updated ${ts}.`);
  }
}

// Read and clear the sessionStorage flag set just before the post-update
// reload. Returns true once per just-updated boot; subsequent reads are
// false (sessionStorage entry is removed on first read).
function consumeJustUpdatedFlag() {
  let flag = null;
  try { flag = sessionStorage.getItem(SS_JUST_UPDATED); } catch (_) {}
  if (flag !== '1') return false;
  try { sessionStorage.removeItem(SS_JUST_UPDATED); } catch (_) {}
  return true;
}

function attachVersionTagHandler() {
  const tag = document.getElementById('app-version-tag');
  if (!tag) return;
  tag.addEventListener('click', () => { manualCheck(); });
  tag.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      manualCheck();
    }
  });
}

function setStatus(kind, label) {
  const el = document.getElementById(STATUS_EL_ID);
  if (!el) return;
  el.className = 'status-tag ' + kind;
  el.textContent = '';
  const dot = document.createElement('span');
  dot.className = 'dot';
  const text = document.createElement('span');
  text.className = 'text';
  text.textContent = label;
  el.appendChild(dot);
  el.appendChild(text);
}
