/**
 * sw-register.js — Service worker registration + version polling.
 *
 * Two reload triggers, both ending in a single location.reload():
 *   1. The browser's normal SW update lifecycle: when sw.js bytes change,
 *      a new worker installs in the background; we tell it to skipWaiting,
 *      then reload on `controllerchange`.
 *   2. A periodic poll of js/version.js (network-only via the SW's
 *      network-first path). If the server's VERSION constant differs from
 *      the running APP_VERSION, we kick registration.update() to drag the
 *      lifecycle along, so trigger #1 fires.
 */

import { APP_VERSION } from '../util/constants.js';

const POLL_INTERVAL_MS = 60_000;
const VERSION_RE = /VERSION\s*=\s*['"]([^'"]+)['"]/;

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => { init().catch(() => {}); });
}

async function init() {
  const registration = await navigator.serviceWorker.register('sw.js');

  let reloading = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (reloading) return;
    reloading = true;
    location.reload();
  });

  registration.addEventListener('updatefound', () => {
    const installing = registration.installing;
    if (!installing) return;
    installing.addEventListener('statechange', () => {
      if (installing.state === 'installed' && navigator.serviceWorker.controller) {
        // New worker is parked in `waiting` because the page already has a
        // controller. Hand it the baton — skipWaiting → activate →
        // controllerchange → reload.
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
    // Drag the SW update lifecycle. The new sw.js (whose embedded VERSION
    // bumps in lockstep) will install, the updatefound listener above will
    // post SKIP_WAITING, and controllerchange will reload the page.
    try { await registration.update(); } catch (_) {}
  }
}
