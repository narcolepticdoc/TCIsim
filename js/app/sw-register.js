/**
 * sw-register.js — Service worker registration, version polling, status display.
 *
 * Two reload triggers, both ending in a single location.reload():
 *   1. The browser's normal SW update lifecycle: when sw.js bytes change,
 *      a new worker installs in the background; we post SKIP_WAITING to it,
 *      it activates, controllerchange fires, we reload.
 *   2. A periodic poll of js/version.js (network-only via the SW's
 *      network-first path). If the server's VERSION constant differs from
 *      the running APP_VERSION, we kick registration.update() to drag the
 *      lifecycle along, so trigger #1 fires.
 *
 * Status display: writes a short status line into #app-status-tag (sits
 * under #app-version-tag in the setup-screen brand panel). Shows whether
 * the page was loaded from cache, current connectivity, and transient
 * "updating…" / "✓ updated to vX" messages around the SW update flow.
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
let reloading = false;

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

  const registration = await navigator.serviceWorker.register('sw.js');

  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!updateTriggered) {
      // First-install claim — no reload, just refresh the status (we're now
      // controlled and future loads will be served from cache).
      refreshConnectivityStatus();
      return;
    }
    if (reloading) return;
    reloading = true;
    try { sessionStorage.setItem(SS_JUST_UPDATED, '1'); } catch (_) {}
    location.reload();
  });

  registration.addEventListener('updatefound', () => {
    const installing = registration.installing;
    if (!installing) return;
    installing.addEventListener('statechange', () => {
      if (installing.state === 'installed' && navigator.serviceWorker.controller) {
        // A new worker is parked in `waiting` because this page already has
        // a controller. Hand it the baton — skipWaiting → activate →
        // controllerchange → reload.
        updateTriggered = true;
        setStatus('updating', 'updating to latest…');
        installing.postMessage('SKIP_WAITING');
      }
    });
  });

  const poll = () => checkServerVersion(registration).catch(() => {});
  poll();
  setInterval(poll, POLL_INTERVAL_MS);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') poll();
  });
}

async function checkServerVersion(registration) {
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
