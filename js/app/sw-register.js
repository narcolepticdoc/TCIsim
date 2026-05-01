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
 * Status display: writes a short status line into #app-status-tag (sits
 * under #app-version-tag in the setup-screen brand panel). Shows whether
 * the page was loaded from cache, current connectivity, and transient
 * "updating…" / "✓ updated to vX" / "↻ update queued" messages around
 * the SW update flow.
 */

import { APP_VERSION } from '../util/constants.js';

const POLL_INTERVAL_MS = 60_000;
const VERSION_RE = /VERSION\s*=\s*['"]([^'"]+)['"]/;
const STATUS_EL_ID = 'app-status-tag';
const SS_JUST_UPDATED = 'tcisim:justUpdated';
const UPDATED_TOAST_MS = 6000;

const supportsServiceWorker = 'serviceWorker' in navigator;
let loadSource = detectLoadSource();
let updateTriggered = false;
let pendingReload = false;
let reloading = false;
let registration = null;

if (supportsServiceWorker) {
  window.addEventListener('load', () => { init().catch(() => {}); });
} else {
  // No SW support — still surface online/offline in the status tag so the
  // user knows network state. Wait for DOMContentLoaded so the element exists.
  document.addEventListener('DOMContentLoaded', () => {
    loadSource = 'live';
    refreshConnectivityStatus();
    window.addEventListener('online', refreshConnectivityStatus);
    window.addEventListener('offline', refreshConnectivityStatus);
  });
}

async function init() {
  showJustUpdatedToastIfPending();
  refreshConnectivityStatus();
  window.addEventListener('online', refreshConnectivityStatus);
  window.addEventListener('offline', refreshConnectivityStatus);

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
      setStatus('updated', '↻ update queued · applies at next case start');
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
        setStatus('updated', '↻ update queued · applies at next case start');
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
  // Returning to setup — apply anything that was queued during the case.
  if (pendingReload && !reloading) {
    triggerReload();
    return;
  }
  // A waiting worker (either ours or one the browser found via its own
  // background update check) gets activated now.
  if (registration && registration.waiting) {
    activateWaitingWorker(registration.waiting);
    return;
  }
  // And run a fresh poll, since we suppressed them during the case.
  checkServerVersion().catch(() => {});
}

function activateWaitingWorker(worker) {
  updateTriggered = true;
  setStatus('updating', 'updating to latest…');
  worker.postMessage('SKIP_WAITING');
}

function triggerReload() {
  if (reloading) return;
  reloading = true;
  try { sessionStorage.setItem(SS_JUST_UPDATED, '1'); } catch (_) {}
  location.reload();
}

async function checkServerVersion() {
  if (!registration) return;
  // Hard gate: never poll while a case is running. We don't want to find
  // out about a new version (and trigger registration.update()) until the
  // user is back on setup.
  if (!isOnSetupScreen()) return;

  const res = await fetch(`js/version.js?_=${Date.now()}`, { cache: 'no-store' });
  if (!res.ok) return;
  const text = await res.text();
  const match = text.match(VERSION_RE);
  if (!match) return;
  const serverVersion = match[1];
  if (serverVersion !== APP_VERSION) {
    setStatus('updating', `update available (v${serverVersion})…`);
    // Drag the SW update lifecycle. The new sw.js (whose embedded VERSION
    // bumps in lockstep) will install, the updatefound listener above
    // posts SKIP_WAITING, and controllerchange reloads the page.
    try { await registration.update(); } catch (_) {}
  }
}

function isOnSetupScreen() {
  const el = document.getElementById('setup-screen');
  return !!(el && el.classList.contains('active'));
}

function detectLoadSource() {
  // transferSize === 0 on the navigation entry means the document body did
  // not come over the wire — i.e. it was served from a cache (SW cache or
  // HTTP cache). On the very first visit (no SW yet) this is > 0 → "live".
  try {
    const nav = performance.getEntriesByType('navigation')[0];
    if (nav && typeof nav.transferSize === 'number' && nav.transferSize === 0) {
      return 'cached';
    }
  } catch (_) { /* fall through */ }
  return 'live';
}

function refreshConnectivityStatus() {
  const online = navigator.onLine !== false;
  const kind = online ? 'online' : 'offline';
  setStatus(kind, `${kind} · ${loadSource}`);
}

function showJustUpdatedToastIfPending() {
  let flag = null;
  try { flag = sessionStorage.getItem(SS_JUST_UPDATED); } catch (_) {}
  if (flag !== '1') return;
  try { sessionStorage.removeItem(SS_JUST_UPDATED); } catch (_) {}
  setStatus('updated', `✓ updated to v${APP_VERSION}`);
  setTimeout(refreshConnectivityStatus, UPDATED_TOAST_MS);
}

function setStatus(kind, label) {
  const el = document.getElementById(STATUS_EL_ID);
  if (!el) return;
  el.className = 'status-tag ' + kind;
  el.textContent = '';
  const dot = document.createElement('span');
  dot.className = 'dot';
  const text = document.createElement('span');
  text.textContent = label;
  el.appendChild(dot);
  el.appendChild(text);
}
