# Changelog

## Versioning Scheme

| Format | Meaning |
|--------|---------|
| `1.0` | Reserved for public release |
| `0.x` | Major updates — new features, architectural changes |
| `0.x.x` | Minor updates — incremental improvements, additions |
| `0.x.x.x` | Bug fixes |

---

## [0.4.2] — 2026-04-04

Follow-up bug fixes to 0.4.1.

**Bug fixes:**
- Pinch-zoom snapped to current time on finger lift: the two `touchend` events fired when releasing a pinch were being interpreted as a double-tap, calling `recenter()`. Fixed by tracking `wasMultiTouch` and skipping the double-tap logic after any multi-touch gesture.
- Auto-scroll fought pinch-zoom mid-gesture: `onZoomStart` callback now disables auto-scroll immediately when the pinch begins, preventing `setCursorTime` from calling `zoomScale` with stale range before `onZoomComplete` fires.
- Ce target label cut off / overlapping nomogram bands: replaced the annotation plugin label (which is clipped to the chart area) with an `afterDraw` canvas plugin that draws the label directly in the 65px right-margin padding.
- BIS nomogram bands in wrong order: `ceForBIS(N)` returns the Ce needed to achieve BIS=N, so lower BIS = higher Ce; bands were reversed. Corrected to `[ce90→ce80]` Red, `[ce80→ce60]` Orange, `[ce60→ce40]` Yellow, `[ce40→ce20]` Green.
- Pump control button renamed "Pause Pump" → "Stop Pump".
- Syntax error from bad indentation of inline Chart.js `plugins` array.

**Housekeeping:**
- Extracted `APP_VERSION` into `js/version.js` — the single source of truth for the version number. `constants.js` re-exports it as `APP_VERSION` so no other files need changing on future releases.

---

## [0.4.1] — 2026-04-04

UI polish, bug fixes, and chart improvements.

**Bug fixes:**
- Zoom snap-back: chart now holds its pinch-zoomed position across data refreshes (syncs `scales.x.min/max` to tracked `viewMin/viewMax` before each update)
- Manual pump stop during TCI pause: the duplicate-pause guard was blocking the stop button when TCI had scheduled a `rate=0` interval; now correctly clears all future TCI events and stops the pump

**Chart:**
- Ce Target annotation label moved to the right margin (65px layout padding + `position:'end'`) so it no longer covers active data
- BIS nomogram: 4 correctly-ordered bands — Red (Light Sedation BIS 80–90), Orange (Deep Sedation 60–80), Yellow (GA 40–60), Green (Deep Anesthesia 20–40); alpha raised from 9% → 19% for visual distinction; previous bands were in wrong Ce order (lower BIS = more drug = higher Ce)
- Hover/tap tooltip now shows `Rate: X.X mcg/kg/min` between the Ce/Cp lines and BIS

**UI labels:**
- Pump control button renamed "Pause Pump" → "Stop Pump"
- Drug panel: TCI-scheduled `rate=0` shows "Paused"; manual pump stop shows "Pump Stopped"
- History panel: TCI `rate=0` events render as "Paused [TCI]"; `pause`-type events render as "Pump Stopped"

---

## [0.4.0] — 2026-04-04

Initial versioned release. Core simulation complete and cross-validated.

- Eleveld 2018 PK-PD model (propofol)
- Matrix-exponential engine — arbitrary time steps, no accumulation error
- Four TCI planners: stepped, CET, CET-conservative, emulation
- SimTIVA cross-validation at 0.0000% Cp deviation (262 tests passing)
- PWA with mobile-first landscape UI
- Event history with edit/delete, system events preserved
- Multi-drug support: propofol, fentanyl, remifentanil, ketamine
- Configurable pump settings persisted to localStorage
- App version displayed on setup screen
