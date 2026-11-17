/**
 * test-meta.mjs — Release-hygiene meta-tests.
 *
 * Automates two checks that were previously done by hand on every release:
 *   1. Version lockstep — js/version.js VERSION must equal sw.js VERSION
 *      (the service-worker reload keys off both; a mismatch ships a stale SW).
 *   2. Precache ↔ disk — sw.js PRECACHE_URLS must list exactly the js/**.js
 *      modules on disk plus the fixed top-level assets. A module added to the
 *      tree but not the precache list is invisible offline; a stale entry
 *      404s the whole precache install.
 */

import { readFileSync, readdirSync, statSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');
const read = (p) => readFileSync(path.join(root, p), 'utf8');

let passed = 0, failed = 0;
function ok(c, m) { if (c) { passed++; console.log(`  ✓ ${m}`); } else { failed++; console.error(`  ✗ ${m}`); } }

console.log('\n===== Release-hygiene meta-tests =====\n');

// ---- 1. Version lockstep ----
const versionJs = read('js/version.js').match(/VERSION\s*=\s*['"]([^'"]+)['"]/);
const swJs = read('sw.js').match(/const\s+VERSION\s*=\s*['"]([^'"]+)['"]/);
ok(versionJs && swJs, 'both files declare a VERSION');
ok(versionJs && swJs && versionJs[1] === swJs[1],
  `js/version.js (${versionJs?.[1]}) === sw.js (${swJs?.[1]})`);

// ---- 2. Precache ↔ disk ----
// Parse the PRECACHE_URLS array literal from sw.js.
const swSrc = read('sw.js');
const arrMatch = swSrc.match(/PRECACHE_URLS\s*=\s*\[([\s\S]*?)\]/);
ok(!!arrMatch, 'PRECACHE_URLS array found in sw.js');
const precache = new Set(
  [...arrMatch[1].matchAll(/['"]([^'"]+)['"]/g)].map(m => m[1])
);

// Every js/**/*.js on disk (the code that must be cached to run offline).
function walkJs(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walkJs(full));
    else if (name.endsWith('.js')) out.push(path.relative(root, full));
  }
  return out;
}
const diskJs = walkJs(path.join(root, 'js'));

const missing = diskJs.filter(f => !precache.has(f));
ok(missing.length === 0,
  missing.length ? `js modules NOT in precache: ${missing.join(', ')}` : 'every js/**/*.js is precached');

// Every precached js/ entry must exist on disk (no stale 404 entries).
const diskSet = new Set(diskJs);
const stale = [...precache].filter(u => u.startsWith('js/') && !diskSet.has(u));
ok(stale.length === 0,
  stale.length ? `precache entries with no file on disk: ${stale.join(', ')}` : 'no stale js/ precache entries');

// Fixed top-level assets that must always be present.
for (const asset of ['index.html', 'manifest.json', 'sw.js']) {
  if (asset === 'sw.js') continue; // sw.js is never in its own precache list
  ok(precache.has(asset), `${asset} is precached`);
}

// ---- 3. One version per cache ----
// A cache that mixed an old model module into a new UI logged every Stop Pump
// as one more pause (v0.6.6.1). The install must fetch each same-origin file
// under a version query, check that version.js — cached and on the server —
// is this sw.js's VERSION, and the fetch handler must read only its own cache.
const swCode = swSrc.split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n');
ok(/fetch\(sameOrigin \? versioned\(url\) : url, \{ cache: 'reload' \}\)/.test(swCode) &&
   /await cache\.put\(url, res\)/.test(swCode),
   'precache fetches url?v=VERSION and stores it under the plain URL');
ok(/cachedVersion !== VERSION \|\| serverVersion !== VERSION/.test(swCode),
   'install aborts unless cached and server version.js both match VERSION');
ok(!/caches\.match\(/.test(swCode),
   'no caches.match(): lookups go through this version\'s cache only');

// ---- 4. iOS status bar ----
// Since iOS/iPadOS 26.1 (still in 27) the system draws a dark gradient over
// Home Screen apps that use black-translucent; it fell across the top bar as
// a drop shadow (v0.6.7.1). The bar is solid instead, coloured by theme-color,
// which must equal each theme's --bg-card so it continues the top bar. iPadOS
// 27 has painted a solid bar white over a page with no color-scheme.
const html = read('index.html');
const statusStyle = html.match(/<meta\s+name="apple-mobile-web-app-status-bar-style"\s+content="([^"]+)"/);
ok(statusStyle && statusStyle[1] === 'default',
  `status-bar-style is "default", not black-translucent (got ${statusStyle?.[1]})`);
const block = (sel) => {
  const i = html.indexOf(sel + '{');
  return i < 0 ? '' : html.slice(i, html.indexOf('}', i));
};
const darkRoot = block('    :root');
const lightRoot = block(':root[data-theme="light"]');
const cardOf = (b) => b.match(/--bg-card:(#[0-9a-fA-F]{3,8})/)?.[1]?.toLowerCase();
const settingsUi = read('js/app/settings-ui.js');
const metaColors = settingsUi.match(/THEME_META_COLORS\s*=\s*\{\s*dark:\s*'([^']+)',\s*light:\s*'([^']+)'\s*\}/);
const staticMeta = html.match(/<meta\s+name="theme-color"\s+content="([^"]+)"/)?.[1];
const manifestColor = JSON.parse(read('manifest.json')).theme_color;
ok(!!(cardOf(darkRoot) && cardOf(lightRoot) && metaColors), 'found both themes\' --bg-card and THEME_META_COLORS');
ok(metaColors && metaColors[1].toLowerCase() === cardOf(darkRoot) && metaColors[2].toLowerCase() === cardOf(lightRoot),
  `THEME_META_COLORS (${metaColors?.[1]}, ${metaColors?.[2]}) = each theme's --bg-card (${cardOf(darkRoot)}, ${cardOf(lightRoot)})`);
ok(metaColors && staticMeta?.toLowerCase() === metaColors[1].toLowerCase() &&
   manifestColor.toLowerCase() === metaColors[1].toLowerCase(),
  `static theme-color (${staticMeta}) and manifest theme_color (${manifestColor}) = the dark theme's`);
ok(/color-scheme:dark;/.test(darkRoot) && /color-scheme:light;/.test(lightRoot),
  ':root declares color-scheme per theme');

// ---- 5. iPad top clearance ----
// On iPad the gradient survived a clean reinstall with `default` (iPadOS 27,
// v0.6.7.2): it darkens the top ~35 px of the page. The <head> script flags
// the iPad Home Screen app, and only it, so the body starts below the band.
const clearSrc = html.match(/<script id="ios-top-clear">([\s\S]*?)<\/script>/)?.[1];
ok(!!clearSrc, '<head> has the ios-top-clear script');
ok(html.indexOf('id="ios-top-clear"') < html.indexOf('<body'), 'ios-top-clear runs in <head>, before first paint');
const MAC = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/27.0 Safari/605.1.15';
const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 27_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/27.0 Mobile/15E148 Safari/604.1';
const ANDROID = 'Mozilla/5.0 (Linux; Android 15; Pixel Tablet) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36';
function flagged({ ua, touch, standalone, displayMode = false }) {
  const classes = new Set();
  const window = {
    navigator: { userAgent: ua, maxTouchPoints: touch, ...(standalone === undefined ? {} : { standalone }) },
    matchMedia: (q) => ({ matches: q === '(display-mode: standalone)' && displayMode }),
  };
  const document = { documentElement: { classList: { add: (c) => classes.add(c) } } };
  new Function('window', 'document', clearSrc)(window, document);
  return classes.has('ios-top-clear');
}
if (clearSrc) {
  ok(flagged({ ua: MAC, touch: 5, standalone: true }), 'flags the iPad Home Screen app');
  ok(flagged({ ua: MAC, touch: 5, displayMode: true }), 'flags it from display-mode: standalone too');
  ok(!flagged({ ua: MAC, touch: 5, standalone: false }), 'not iPad Safari (a tab, not the Home Screen app)');
  ok(!flagged({ ua: MAC, touch: 0, displayMode: true }), 'not a Mac web app (no touch points)');
  ok(!flagged({ ua: IPHONE, touch: 5, standalone: true }), 'not the iPhone Home Screen app');
  ok(!flagged({ ua: ANDROID, touch: 10, displayMode: true }), 'not an installed Android tablet app');
}
ok(/html\.ios-top-clear body\{padding-top:\d+px\}/.test(html), 'html.ios-top-clear body gets a top padding');

console.log(`\n${'='.repeat(50)}`);
console.log(`  TOTAL: ${passed} passed, ${failed} failed`);
console.log(`${'='.repeat(50)}\n`);
process.exit(failed ? 1 : 0);
