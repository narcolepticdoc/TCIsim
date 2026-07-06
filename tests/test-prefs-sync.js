/**
 * test-prefs-sync.js — Preferences cloud-sync blob (js/sync/prefs-sync.js).
 *
 * Pins the security- and correctness-critical properties:
 *   - collect → apply round-trips every manifest key verbatim
 *   - applyPrefs is manifest-filtered: unknown keys in a pulled blob are
 *     NEVER written (a cloud payload must not touch arbitrary localStorage)
 *   - manifest keys absent from the blob are removed (device mirrors pusher)
 *   - excluded state (sync code, saved case, dose template) is never
 *     collected and never clobbered on apply
 *   - newer-schema blobs are refused outright (no half-apply)
 */

const path = require('path');
const { pathToFileURL } = require('url');

let passed = 0, failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log(`  ✓ ${msg}`); }
  else { failed++; console.error(`  ✗ ${msg}`); }
}
function summary() {
  console.log(`\n${'='.repeat(50)}`);
  console.log(`  TOTAL: ${passed} passed, ${failed} failed`);
  console.log(`${'='.repeat(50)}\n`);
  process.exit(failed ? 1 : 0);
}

const _store = new Map();
global.localStorage = {
  getItem: k => (_store.has(k) ? _store.get(k) : null),
  setItem: (k, v) => { _store.set(k, String(v)); },
  removeItem: k => { _store.delete(k); },
  clear: () => { _store.clear(); },
};

const u = (...p) => pathToFileURL(path.join(__dirname, '..', ...p)).href;

(async () => {
  const { prefsManifest, collectPrefs, applyPrefs, isPrefsEmpty, isNewerPrefsSchema, PREFS_SCHEMA_VERSION } =
    await import(u('js', 'sync', 'prefs-sync.js'));

  console.log('\n===== Preferences sync blob =====\n');

  // ---- manifest shape ----
  const manifest = prefsManifest();
  ok(manifest.includes('tci-warn-settings'), 'manifest includes the settings blob');
  ok(manifest.includes('tci-pref-rateUnit-propofol-default'), 'manifest includes setup-default unit keys');
  ok(manifest.includes('tci-pump-concentration') && manifest.includes('tci-pump-concentration-fentanyl'),
    'manifest includes pump concentrations (propofol unsuffixed)');
  ok(manifest.includes('tci-pump-enabled-fentanyl') && !manifest.includes('tci-pump-enabled-propofol'),
    'pump-enabled synced for optional drugs only (propofol is pump-mandatory)');
  ok(manifest.includes('chart-ymax-ketamine'), 'manifest includes chart y-max keys');
  for (const excluded of ['tci-sync-code', 'tci-sim-last-case', 'tci-dose-template', 'tci-dose-template-armed']) {
    ok(!manifest.includes(excluded), `manifest excludes ${excluded}`);
  }
  ok(!manifest.some(k => /^tci-pref-(bolus|rate)Unit-[a-z]+$/.test(k)),
    'manifest excludes in-case working unit keys');
  ok(manifest.length <= 64, `manifest fits the server's 64-key cap (${manifest.length} keys)`);

  // ---- collect → apply round-trip ----
  {
    _store.clear();
    _store.set('tci-warn-settings', '{"theme":"light","textSize":"xl"}');
    _store.set('tci-pref-rateUnit-propofol-default', 'mcg/kg/min');
    _store.set('tci-pump-max-rate', '500');
    _store.set('tci-sync-code', 'ABC234');        // excluded
    _store.set('tci-dose-template', '{"v":1}');   // excluded
    const blob = collectPrefs();
    ok(blob.v === PREFS_SCHEMA_VERSION && typeof blob.updatedAt === 'number', 'blob carries v + updatedAt');
    ok(blob.prefs['tci-warn-settings'] === '{"theme":"light","textSize":"xl"}', 'settings blob collected verbatim');
    ok(!('tci-sync-code' in blob.prefs) && !('tci-dose-template' in blob.prefs), 'excluded keys not collected');
    ok(isPrefsEmpty(blob) === false, 'non-empty blob detected');

    // Fresh device: apply
    _store.clear();
    _store.set('tci-sync-code', 'ABC234'); // pairing code survives apply
    const applied = applyPrefs(blob);
    ok(applied === 3, `apply writes exactly the collected keys (${applied})`);
    ok(_store.get('tci-warn-settings') === '{"theme":"light","textSize":"xl"}', 'settings blob round-trips');
    ok(_store.get('tci-pump-max-rate') === '500', 'pump rate round-trips');
    ok(_store.get('tci-sync-code') === 'ABC234', 'sync code untouched by apply');
  }

  // ---- manifest filtering on apply ----
  {
    _store.clear();
    const evil = {
      v: 1, updatedAt: Date.now(),
      prefs: {
        'tci-warn-settings': '{}',
        'tci-sim-last-case': '{"patient":{}}',   // not in manifest
        'evil-arbitrary-key': 'x',               // not in manifest
        'tci-sync-code': 'HACKED',               // not in manifest
      },
    };
    const applied = applyPrefs(evil);
    ok(applied === 1, 'only manifest keys written');
    ok(!_store.has('evil-arbitrary-key') && !_store.has('tci-sim-last-case') && !_store.has('tci-sync-code'),
      'non-manifest payload keys are never written');
  }

  // ---- mirror semantics: absent manifest keys are removed ----
  {
    _store.clear();
    _store.set('tci-pref-quantizeInDisplay', 'true');   // set locally, absent from blob
    _store.set('tci-dose-template', '{"v":1}');         // excluded key must survive
    applyPrefs({ v: 1, updatedAt: 1, prefs: { 'tci-warn-settings': '{}' } });
    ok(!_store.has('tci-pref-quantizeInDisplay'), 'manifest key absent from blob is removed (mirror)');
    ok(_store.has('tci-dose-template'), 'excluded keys survive apply untouched');
  }

  // ---- invalid / newer-schema payloads ----
  ok(applyPrefs(null) === null, 'null payload rejected');
  ok(applyPrefs({ v: 1 }) === null, 'missing prefs object rejected');
  ok(applyPrefs({ v: 1, prefs: [1, 2] }) === null, 'array prefs rejected');
  ok(applyPrefs({ v: 2, prefs: { 'tci-warn-settings': '{}' } }) === null, 'newer schema refused (no half-apply)');
  ok(isNewerPrefsSchema({ v: 2, prefs: {} }) === true, 'isNewerPrefsSchema flags v:2');
  ok(isNewerPrefsSchema({ v: 1, prefs: {} }) === false, 'isNewerPrefsSchema passes v:1');
  ok(isPrefsEmpty({ v: 1, prefs: {} }) === true, 'empty prefs detected');
  ok(isPrefsEmpty(null) === true, 'null payload counts as empty');

  summary();
})().catch(err => {
  console.error('FATAL:', err);
  failed++;
  summary();
});
