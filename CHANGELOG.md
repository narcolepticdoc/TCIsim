# Changelog

## Versioning Scheme

| Format | Meaning |
|--------|---------|
| `1.0` | Reserved for public release |
| `0.x` | Major updates — new features, architectural changes |
| `0.x.x` | Minor updates — incremental improvements, additions |
| `0.x.x.x` | Bug fixes |

---

## [0.5.6] — 2026-04-06

Responsive tablet layout, drug panel readability improvements, history panel restructure, and chart label enhancement.

**Responsive layout (iPad support):**

- **Split chart + history on tablet (≥1020px):** At iPad widths (iPad 10th gen 1080px, iPad mini 7th gen 1133px, and larger), the chart and history panels are shown side by side instead of tab-switching. Chart takes ~2/3 width, history takes ~1/3 with independent scrolling. Breakpoint chosen to be safely above iPhone 17 landscape width (932px) so phone behaviour is unchanged.
- **Chart expand toggle:** New `⤢` button in chart controls (tablet only) collapses the history column and gives the chart full width; click `⤡` to restore the split view.
- **Larger fonts and wider drug panel at ≥1020px and ≥1200px:** Drug panel widens (210→250→285px), Ce font 22→26→30px, topbar height 34→42px, form inputs/buttons scale proportionally. Content tabs hidden on tablet (redundant with split view).

**Drug panel readability:**

- Base font sizes increased across all screen sizes: `drug-name` 12→13px, approach 9.5→10.5px, status/rate 10→11px, step-bar-countdown 9→10px, Cp value 11→12px, Ce/Cp/BIS labels 9→10px.
- Further increases at tablet breakpoints (≥1020px: approach 11.5px, status/rate 12px, countdown 11px; ≥1200px: approach 12px, countdown 12px, drug-name 15px).
- Step-bar countdown right-justified (`text-align: right`) so elapsed times align vertically across all drug tiles.
- Step bar turns red (`var(--red)`) when Ce falls below the intermittent redose threshold; reverts to drug color when counting down or during bolus delivery. Applied to both selected and non-selected tiles.

**History panel:**

- Timestamps changed from `text-muted` to `text-secondary` for better readability.
- Event rows restructured into two lines: event type (small/muted, e.g. "IV Push", "Rate") on the first line; dose or rate value (bold) on the second line. Consistent across bolus, rate, and pause events.
- IV push delivery time was hardcoded to "10 sec push" regardless of dose; now computed from actual volume at 3600 mL/h (1 mL/s) with a 1-second minimum. Added `pushDeliveryMinutes()` to `js/util/constants.js`.

**Chart:**

- Threshold line label now two lines: "Threshold" on top, the numeric Ce value (to 2 d.p.) underneath. `drawRightLabel()` extended with an optional `label2` parameter to support multi-line right-margin labels.

**Bug fix:**

- Non-selected drug tiles: step bar was not turning red when below intermittent threshold. The non-selected code path set `barPct = 100` (meaning the dark inner fill covered the entire bar), hiding the red wrap background. Fixed to `barPct = 0`.

**359 tests across 12 suites, all passing.**

---

## [0.5.1] — 2026-04-06

Bug fixes and PK model corrections for fentanyl and ketamine.

**PK model corrections:**

- **Fentanyl — Shafer 1990 parameters corrected**: V1=7.35 L, V2=33.94 L, V3=275.62 L, CL=36.47 L/h, Q2=207.71 L/h, Q3=99.22 L/h, ke0=0.1195 /min. Previous values were incorrect.
- **Fentanyl — Shibutani 2004 inclusion criteria fixed**: PK mass formula now applies only when TBW ≥ 85 kg **and** BMI > 30 — the actual entry criteria from the 2004 derivation study. Previous threshold (TBW > 80 kg, no BMI check) incorrectly triggered the correction for tall lean patients and created a non-physiological discontinuity at the boundary. `pkMass()` now accepts `(tbw, bmi)`; `calcFentanylParams()` computes BMI from `patient.height`.
- **Ketamine — Domino/Navarrete parameterization**: Fixed population micro-constants (K10=0.4381, K12=0.5921, K21=0.2470, K13=0.5900, K31=0.0146 /min; ke0=0.238 /min); V1=0.063×weight, all other volumes and clearances derived from V1 and fixed Kij. Previous model was based on Domino 1982 alone with different scaling.

**Bug fixes:**

- **Non-selected tile approach line frozen**: `$(dId + '-approach')` was never written for non-selected drugs — it kept the last rendered HTML from when the drug was selected. Now updated every frame via `_nonSelectedCache`.
- **Non-selected tile `predictTrough` called 60×/sec**: No cache existed for non-selected intermittent drugs, causing up to ~2000 engine advances per frame. Added `_nonSelectedCache` keyed by event count: `predictTrough` is called once per bolus, then `arrivalMin − t` is used for the live countdown (matching the selected-drug behaviour).
- **Fentanyl/ketamine not restored from saved state (events)**: `eventsByDrug` serialisation loop was restricted to `['propofol']` with a `// extend for multi-drug` comment. Fentanyl and ketamine events were never written to the save blob.
- **Fentanyl/ketamine not restored from saved state (mode/threshold)**: Mode and `ceTarget` collection likewise only covered `['propofol']`. Intermittent thresholds were also not saved at all. All three drugs' modes and thresholds are now saved and restored.

**359 tests across 12 suites, all passing.**

---

## [0.5.0] — 2026-04-05

Multi-drug tracking: fentanyl and ketamine with intermittent bolus mode.

**New features:**

- **Fentanyl PK model** (Shafer 1990, 3-compartment, ke0 from Scott 1985): live Ce/Cp tracking in ng/mL, separate drug card, IV-push–only administration
- **Ketamine PK model** (Domino 1982 / Clements 1982, 3-compartment): live Ce/Cp tracking in ng/mL, separate drug card
- **Intermittent bolus mode**: new mode selectable per drug (via "Intermittent" button). No infusion pump — IV-push boluses only. User sets a Ce redose threshold; approach line shows "Redose in M:SS" or "Redose now". History filtered to bolus events only. Mode-switch button relabeled "Set Infusion Rate" to transition back to infusion.
- **Threshold line on chart**: amber dashed horizontal line at the redose Ce threshold, with right-margin label, analogous to TCI's orange target line
- **Per-drug chart y-axis**: fentanyl and ketamine display in ng/mL (×1000 scaling); y-axis range and label persist to localStorage per drug; propofol unchanged in μg/mL
- **Redose countdown via matrix engine**: `predictTrough()` used for unlimited-lookahead redose timing — not limited by chart curve length, essential for ketamine's slow Ce decay (200–600 min)

**UI improvements:**

- All drug tiles update Ce/Cp, status label, and step-bar every frame from case start — no longer requires clicking each tile to wake it up
- Step-bar colors inverted: container shows drug color (full = ready), dark fill grows left-to-right as time elapses (depletes to dark as the interval expires)
- Non-selected intermittent tiles show "Redose in M:SS" countdown via `predictTrough()` even when not the active tile
- Pre-start clock is now per-drug — queuing a propofol bolus no longer delays fentanyl/ketamine events; all induction drugs can be stamped at t=0 simultaneously
- BIS nomogram bands clear when switching to fentanyl or ketamine (no validated PD model)

**346 tests across 11 suites, all passing.**

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
