/**
 * test-settings-validation.mjs — Real getSettings/setSettings validation.
 *
 * Imports the REAL js/ui/settings.js and exercises its localStorage-backed
 * clamp/validate logic (previously untested; the DEFAULTS object there is the
 * authoritative key/default/range list per CLAUDE.md). A localStorage Map shim
 * lets getSettings/setSettings run under bare Node.
 *
 * getSettings is the guard between an arbitrary stored JSON blob (which a cloud
 * prefs-pull, a hand-edited localStorage, or a older/newer app version could
 * produce) and the running app: every field is range/type-checked and falls
 * back to its default, so a garbage value can never reach the chart, engine, or
 * alert system.
 */

// localStorage shim — set BEFORE importing settings.js (getSettings/setSettings
// read it lazily, but be safe).
const _store = new Map();
global.localStorage = {
  getItem: (k) => (_store.has(k) ? _store.get(k) : null),
  setItem: (k, v) => _store.set(k, String(v)),
  removeItem: (k) => _store.delete(k),
  clear: () => _store.clear(),
};

const { getSettings, setSettings } = await import('../js/ui/settings.js');

let passed = 0, failed = 0;
function ok(c, m) { if (c) { passed++; console.log(`  ✓ ${m}`); } else { failed++; console.error(`  ✗ ${m}`); } }
function put(obj) { _store.set('tci-warn-settings', JSON.stringify(obj)); }

console.log('\n=== settings.js getSettings/setSettings validation ===\n');

// ── Empty store → defaults ──────────────────────────────────────────────────
{
  _store.clear();
  const s = getSettings();
  ok(s.prepSec === 30 && s.alertSec === 10, 'No stored blob → prep/alert defaults (30/10 s)');
  ok(s.ceTolerance === 0.015, 'No stored blob → ceTolerance default 0.015');
  ok(s.textSize === 'normal' && s.theme === 'dark', 'No stored blob → textSize/theme defaults');
}

// ── Corrupt JSON → defaults (try/catch) ─────────────────────────────────────
{
  _store.set('tci-warn-settings', '{not valid json');
  const s = getSettings();
  ok(s.prepSec === 30 && s.ceTolerance === 0.015, 'Corrupt JSON → falls back to defaults');
}

// ── Valid in-range blob round-trips verbatim ────────────────────────────────
{
  put({ prepSec: 45, prepSound: true, alertSec: 5, alertSound: false, ceTolerance: 0.020,
        cpOpacity: 0.6, eventMarkerSize: 10, textSize: 'large', theme: 'light', showCeBand: true });
  const s = getSettings();
  ok(s.prepSec === 45 && s.alertSec === 5, 'Valid prep/alert seconds preserved');
  ok(s.prepSound === true && s.alertSound === false, 'Valid booleans preserved');
  ok(s.ceTolerance === 0.020 && s.cpOpacity === 0.6, 'Valid ceTolerance/opacity preserved');
  ok(s.eventMarkerSize === 10 && s.textSize === 'large' && s.theme === 'light', 'Valid marker/text/theme preserved');
  ok(s.showCeBand === true, 'Valid boolean showCeBand preserved');
}

// ── Out-of-range numerics → snap back to defaults ───────────────────────────
{
  put({ ceTolerance: 0.5, ssSlopeTol: 5, exitBandPct: 0.9, cpOpacity: 5,
        nomogramOpacity: -1, overlayOpacity: 99, ghostOpacity: 0, eventMarkerSize: 100 });
  const s = getSettings();
  ok(s.ceTolerance === 0.015, 'ceTolerance 0.5 (out of 0.005–0.030) → default 0.015');
  ok(s.ssSlopeTol === 0.0010, 'ssSlopeTol 5 (out of range) → default 0.0010');
  ok(s.exitBandPct === 0.05, 'exitBandPct 0.9 (out of 0.01–0.20) → default 0.05');
  ok(s.cpOpacity === 1.0, 'cpOpacity 5 (out of 0.1–1.0) → default 1.0');
  ok(s.nomogramOpacity === 1.0 && s.overlayOpacity === 1.0, 'nomogram/overlay opacity out of range → default 1.0');
  ok(s.ghostOpacity === 0.5, 'ghostOpacity 0 (below 0.1 floor) → default 0.5');
  ok(s.eventMarkerSize === 7, 'eventMarkerSize 100 (out of 4–16) → default 7');
}

// ── Legacy ssFraction values (0.50–0.95) fall outside the new window ─────────
{
  put({ ssSlopeTol: 0.70 });
  ok(getSettings().ssSlopeTol === 0.0010, 'Legacy ssFraction 0.70 → slope default 0.0010');
}

// ── Enum fields reject unknown values ───────────────────────────────────────
{
  put({ textSize: 'gigantic', theme: 'ultraviolet' });
  const s = getSettings();
  ok(s.textSize === 'normal', "Unknown textSize 'gigantic' → default 'normal'");
  ok(s.theme === 'dark', "Unknown theme 'ultraviolet' → default 'dark'");
}

// ── Wrong-typed fields → defaults ───────────────────────────────────────────
{
  put({ prepSec: 'lots', prepSound: 'yes', eventMarkerSize: null, showCeBand: 1 });
  const s = getSettings();
  ok(s.prepSec === 30, "prepSec 'lots' (string) → default 30");
  ok(s.prepSound === false, "prepSound 'yes' (string) → default false");
  ok(s.eventMarkerSize === 7, 'eventMarkerSize null → default 7');
  ok(s.showCeBand === false, 'showCeBand 1 (number, not boolean) → default false');
}

// ── Negative prep/alert seconds rejected (must be ≥ 0) ───────────────────────
{
  put({ prepSec: -5, alertSec: -1, statusWarnMinutes: -3 });
  const s = getSettings();
  ok(s.prepSec === 30 && s.alertSec === 10, 'Negative prep/alert seconds → defaults');
  ok(s.statusWarnMinutes === 2, 'Negative statusWarnMinutes → default 2');
}

// ── reactionDelaySec: clamp to [0,2] and snap to a 0.5 s grid ────────────────
{
  const cases = [[-1, 0], [0, 0], [0.3, 0.5], [1.0, 1.0], [1.3, 1.5], [2.0, 2.0], [5, 2.0]];
  for (const [input, want] of cases) {
    put({ reactionDelaySec: input });
    ok(getSettings().reactionDelaySec === want, `reactionDelaySec ${input} → ${want} (clamp+snap)`);
  }
  put({ reactionDelaySec: 'x' });
  ok(getSettings().reactionDelaySec === 0, "reactionDelaySec 'x' (non-number) → 0");
}

// ── setSettings → getSettings round-trip via the real store ─────────────────
{
  _store.clear();
  setSettings({ prepSec: 20, prepSound: false, alertSec: 8, alertSound: true, redoseSound: false,
    statusWarnMinutes: 3, reactionDelaySec: 1.5, ceTolerance: 0.010, ssSlopeTol: 0.0006,
    exitBandPct: 0.10, cpOpacity: 0.8, nomogramOpacity: 0.7, overlayOpacity: 0.9, ghostOpacity: 0.4,
    ghostTracesEnabled: true, eventMarkerSize: 12, textSize: 'xl', theme: 'light', showCeBand: true });
  const s = getSettings();
  ok(s.prepSec === 20 && s.reactionDelaySec === 1.5 && s.ceTolerance === 0.010, 'setSettings persists then getSettings reads back');
  ok(s.textSize === 'xl' && s.ghostTracesEnabled === true, 'setSettings round-trips enum + boolean fields');
}

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
