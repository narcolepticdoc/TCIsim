/**
 * sw.js — TCI Sim service worker.
 *
 * Offline-first: precaches the full app on install (HTML, every JS module
 * under js/, the manifest, the jsdelivr Chart.js stack, and the Google
 * Fonts CSS). Each version of the app gets its own cache, keyed by the
 * VERSION constant below.
 *
 * Server-version check: VERSION must be kept in lockstep with
 * js/version.js. When the deployed sw.js bytes change, the browser detects
 * an update on the next navigation (or on registration.update() from the
 * client poller in js/app/sw-register.js), installs the new SW, wipes old
 * caches, and the page reloads onto the new version.
 */

const VERSION = '0.5.37';
const CACHE_NAME = `tcisim-v${VERSION}`;

const PRECACHE_URLS = [
  './',
  'index.html',
  'manifest.json',

  'js/version.js',
  'js/app.js',
  'js/app/chart-bridge.js',
  'js/app/portrait-layout.js',
  'js/app/session.js',
  'js/app/settings-ui.js',
  'js/app/sw-register.js',
  'js/app/tci-modal.js',

  'js/pk/decay-predictor.js',
  'js/pk/eigenvalues.js',
  'js/pk/eleveld.js',
  'js/pk/engine.js',
  'js/pk/fentanyl.js',
  'js/pk/ketamine.js',
  'js/pk/pd.js',
  'js/pk/steady-state-predictor.js',

  'js/sim/events.js',
  'js/sim/events/actions.js',
  'js/sim/events/delivery.js',
  'js/sim/events/index.js',
  'js/sim/events/list-ops.js',
  'js/sim/events/query.js',
  'js/sim/events/replay.js',
  'js/sim/simtiva-reference.js',
  'js/sim/simulation.js',
  'js/sim/tci-planner.js',
  'js/sim/tci/cet-conservative.js',
  'js/sim/tci/cet.js',
  'js/sim/tci/emulation.js',
  'js/sim/tci/index.js',
  'js/sim/tci/shared.js',
  'js/sim/tci/stepped.js',

  'js/ui/alert-sound.js',
  'js/ui/chart.js',
  'js/ui/chart/annotations.js',
  'js/ui/chart/gestures.js',
  'js/ui/chart/index.js',
  'js/ui/chart/interpolation.js',
  'js/ui/chart/plugins/cursor-dots.js',
  'js/ui/chart/plugins/event-markers.js',
  'js/ui/chart/plugins/inspect-dots.js',
  'js/ui/chart/plugins/inspect-handle.js',
  'js/ui/chart/plugins/readout-panel.js',
  'js/ui/chart/plugins/target-label.js',
  'js/ui/chart/rate-format.js',
  'js/ui/chart/shapes.js',
  'js/ui/chart/state.js',
  'js/ui/compartment-viz.js',
  'js/ui/controls.js',
  'js/ui/drug-panel.js',
  'js/ui/drug-panel/approach.js',
  'js/ui/drug-panel/exit-readout.js',
  'js/ui/drug-panel/formatters.js',
  'js/ui/drug-panel/index.js',
  'js/ui/drug-panel/step-bar.js',
  'js/ui/event-editor.js',
  'js/ui/history.js',
  'js/ui/keypad.js',
  'js/ui/mode.js',
  'js/ui/patient-modal.js',
  'js/ui/persist.js',
  'js/ui/reconcile-modal.js',
  'js/ui/settings.js',
  'js/ui/setup.js',
  'js/ui/timer.js',

  'js/sync/patient-sync.js',

  'js/util/color.js',
  'js/util/constants.js',
  'js/util/math.js',
  'js/util/units.js',

  'https://cdn.jsdelivr.net/npm/chart.js@4/dist/chart.umd.min.js',
  'https://cdn.jsdelivr.net/npm/chartjs-plugin-annotation@3/dist/chartjs-plugin-annotation.min.js',
  'https://cdn.jsdelivr.net/npm/hammerjs@2.0.8/hammer.min.js',
  'https://cdn.jsdelivr.net/npm/chartjs-plugin-zoom@2/dist/chartjs-plugin-zoom.min.js',
  'https://fonts.googleapis.com/css2?family=DM+Mono:wght@400;500&family=Outfit:wght@300;400;500;600;700&display=swap',
];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    // addAll is atomic — one bad URL aborts the whole install. Do it per-URL
    // so a flaky CDN doesn't take down offline support for the whole app.
    await Promise.all(PRECACHE_URLS.map(async (url) => {
      try {
        const res = await fetch(url, { cache: 'reload' });
        if (res.ok || res.type === 'opaque') await cache.put(url, res);
      } catch (_) { /* swallow — runtime fetch handler will retry later */ }
    }));
    self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(
      keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))
    );
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  // Never cache or intercept the serverless sync API — always hit the network
  // so the cloud patient pull returns live data (and never serves stale/offline
  // responses). Lets the browser handle it normally.
  if (url.pathname.startsWith('/api/')) return;

  // Network-first for js/version.js so the client-side version poller always
  // sees fresh server bytes when online; falls back to cache when offline.
  if (url.pathname.endsWith('/js/version.js')) {
    event.respondWith((async () => {
      try {
        const fresh = await fetch(req, { cache: 'no-store' });
        const cache = await caches.open(CACHE_NAME);
        cache.put(req, fresh.clone());
        return fresh;
      } catch (err) {
        const cached = await caches.match(req, { ignoreSearch: true });
        if (cached) return cached;
        throw err;
      }
    })());
    return;
  }

  // Cache-first for everything else. On miss, fetch + opportunistically cache
  // (covers Google Fonts woff2 files pulled in at runtime by the cached CSS).
  event.respondWith((async () => {
    const cached = await caches.match(req);
    if (cached) return cached;
    try {
      const fresh = await fetch(req);
      if (fresh && (fresh.ok || fresh.type === 'opaque')) {
        const cache = await caches.open(CACHE_NAME);
        cache.put(req, fresh.clone());
      }
      return fresh;
    } catch (err) {
      if (req.mode === 'navigate') {
        const fallback = await caches.match('index.html');
        if (fallback) return fallback;
      }
      throw err;
    }
  })());
});

self.addEventListener('message', (event) => {
  const data = event.data;
  if (data === 'SKIP_WAITING') {
    self.skipWaiting();
    return;
  }
  if (data === 'GET_VERSION') {
    if (event.source) event.source.postMessage({ type: 'VERSION', version: VERSION });
  }
});
