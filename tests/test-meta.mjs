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

console.log(`\n${'='.repeat(50)}`);
console.log(`  TOTAL: ${passed} passed, ${failed} failed`);
console.log(`${'='.repeat(50)}\n`);
process.exit(failed ? 1 : 0);
