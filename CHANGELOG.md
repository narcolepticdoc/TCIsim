# Changelog

## Versioning Scheme

| Format | Meaning |
|--------|---------|
| `1.0` | Reserved for public release |
| `0.x` | Major updates — new features, architectural changes |
| `0.x.x` | Minor updates — incremental improvements, additions |
| `0.x.x.x` | Bug fixes |

---

## [0.5.24.4] — 2026-04-21

History UX + layout polish.

**History** — removed the illegible pencil column and the hidden tap-on-time-cell gesture, replaced with explicit bottom-bar buttons:

```
[ ET ]  [ + Add Event ]  [ Edit ]
```

- `ET` flips to `RT` on tap (wall-clock mode); no longer hides behind a timestamp tap.
- `Edit` toggles a panel-wide `body.edit-history-mode` — while on, every history row gets an amber outline + pointer cursor and becomes tappable (opens the event editor). The button itself gains an amber `.active` state to mirror the other mode toggles.
- Row markup simplified: `[time] | [type] / [value centered]`. Dropped the pump-bolus and IV-push duration detail (troubleshooting cruft), the `.h-detail` span, and the `.h-edit-btn` pencil entirely. Row padding tightened from 7px to 5px vertical.

**Drug panel widths** bumped on tablet breakpoints to give the cards more horizontal room — the Ce/Cp row no longer clips `μg/mL` at XXL:

- `@media (min-width:1020px)`: 250px → 280px.
- `@media (min-width:1200px)`: 285px → 320px.
- Portrait tablet grid column (`@media (orientation:portrait) and (min-width:700px)`): 250px → 280px.

**Portrait dynamic row sizing** — new module `js/app/portrait-layout.js` measures the drug panel's `scrollHeight` and sets `grid-template-rows: 1fr <measured>px` on `.sim-main`, so the chart takes all slack when drug cards are compact. ResizeObserver on the drug panel + `matchMedia` gating so the dynamic sizing only applies in the portrait-tablet layout; on phones/landscape the `.sim-main` inline style is cleared and the base CSS template takes over. Capped at 50% of window height so a pathologically tall drug panel never starves the chart.

Re-synced on text-size change via `applyTextSize()` in `js/app/settings-ui.js`.

**Files changed:** `js/version.js`, `index.html`, `js/ui/history.js`, `js/app.js`, `js/app/settings-ui.js`, `js/app/portrait-layout.js` (new), `CHANGELOG.md`, `DEVELOPMENT.md`.

---

## [0.5.24.3] — 2026-04-21

Drug-card layout reshuffle and rename `Exit Ce` → `Emerge / Emergence` throughout the UI.

**Layout changes driven by XXL iPad Mini screenshots** where eBIS was clipped, the Exit Ce banner was squeezed against the drug name, and the Cp → At Target narrative was at risk of being interrupted by a new eBIS row.

- **eBIS moves to the drug-name row** as a new right-justified header element (`.drug-bis-header`), color-coded via `bisColor()`. Header-level prominence matches how clinicians scan for depth-of-anesthesia; `:empty { display:none }` collapses the element on non-propofol cards and pre-case.
- **Emergence line moves to bottom of card** between the status row and the step-bar area, in the existing red color. Preserves the Cp / At Target visual adjacency (they're now vertically next to each other with nothing between them).
- **Propofol gets units back:** `Ce 3.48 │ Cp 3.45 μg/mL` — single trailing unit (shared between Ce and Cp). Fentanyl/ketamine updated to match the shared-unit style for consistency.
- **Rename in user-facing text:**
  - Drug-card readout: `Exit Ce 3.0 in 3:39` → `Emerge → 3.0 in 3:39` (parallels the existing `Rate → …` line).
  - Reached state: `Exit Ce Reached` → `Emergence Reached`.
  - Button: `Set Exit Ce` / `Change Exit Ce` → `Set Emergence` / `Change Emergence`.
  - Keypad modal title + confirm button: `Set Emergence` / `Change Emergence` (dynamic title swap when a value is already set, mirroring the intermittent-threshold flow).
  - Internal symbols unchanged (`.btn-ctrl-exit`, `.exit-readout`, `setExitLine`, `getExitCeForDrug`, `exitCe` state field) — renaming those would balloon the diff for no user benefit.

**Mechanics:**

- `.exit-readout` dropped from absolutely-positioned top-right floater to an inline block child of `.drug-card`. Line-height bumped slightly so wrapping (when it occurs on compact layouts) reads cleanly.
- `.drug-header-row` uses `display:flex; justify-content:space-between; align-items:baseline` so drug-name and bis-header align at the baseline regardless of their font sizes.
- `.drug-bis-header` large-type bumps: Normal 13 → Large 15 → XL 17 → XXL 19; active-card variant 17 → 20 → 23.
- Compact media queries (`max-width:900 and max-height:420`, phone portrait `max-width:500`) hide the bis-header and fall back to `white-space:normal` on `.exit-readout` so the emerge line wraps rather than overflows on tight screens.

**Files changed:** `js/version.js`, `index.html`, `js/ui/drug-panel/index.js`, `js/ui/drug-panel/exit-readout.js`, `js/ui/mode.js`, `js/ui/keypad.js`, `CHANGELOG.md`, `DEVELOPMENT.md`.

---

## [0.5.24.2] — 2026-04-21

Adds a fourth "XXL" option to the Text size segmented control, and renames the Appearance-tab label from "Text size (drug panel & history)" to just "Text size" (accurate now that the scope is global).

**XXL ladder:** ~+45% from base. Examples — `.drug-name` 13 → 19px, `.drug-name.active` 17 → 25px, `.ce-current` 22 → 32px, `.ce-current.active` 27 → 39px, `.history-row` 11 → 16px, `.btn-ctrl` 12 → 17.5px, `.elapsed-timer` 16 → 23px, chart fontScale 1.45.

**Gated behind `@media (min-width:1020px)`** — only applies when the drug panel widens to 250px+ at the existing desktop breakpoint. On narrower screens (phones, iPad Mini portrait) the `.text-xxl` body class is still set but the CSS rules do not match, so the layout falls back to base sizes and avoids wrapping the Ce row. Chart fontScale still applies since it is pushed through JS.

**Files changed:** `js/version.js`, `js/ui/settings.js` (TEXT_SIZES adds `xxl`), `js/app/settings-ui.js` (`applyTextSize` handles `text-xxl`), `js/app/chart-bridge.js` (TEXT_SCALE adds `xxl: 1.45`), `index.html` (new XXL button + CSS block + label rename), `CHANGELOG.md`, `DEVELOPMENT.md`.

---

## [0.5.24.1] — 2026-04-21

Expands "Large type" from drug-panel + history to every small-text element on the sim screen — based on iPad Mini screenshots showing plenty of unused space and several glaring misses at the previous scope (big Ce readout, chart text, topbar, bottom controls, and a step-bar countdown that was disappearing into ellipsis at XL).

**Added to the large-type CSS block** (`index.html`, already gated behind `@media (min-width:601px) and (min-height:421px)`):

- `.ce-current` and `.ce-current.active` now scale (22 → 25 → 28; active 27 → 30 → 34). These were intentionally excluded in 0.5.24 to protect the fixed-width Ce row from wrapping — bumps are modest and verified to fit on a 210px panel.
- Topbar: `.app-name`, `.patient-summary`, `.elapsed-timer`, `.btn-new-case`, `.btn-settings` (gear).
- Bottom controls: `.btn-ctrl` (Change Target / Change Exit Ce / Set Rate / Add Bolus / Stop Pump) and the `.mode-label` pill.
- `.step-bar-countdown` gets `white-space:normal; text-overflow:clip; min-height:0` when large-type is on, so the rate + countdown line ("Rate → 110.0 mcg/kg/min in 1:12") wraps to two lines instead of truncating to "Rate → 110.0 mcg/kg/min in ...". Actionable info no longer disappears at XL.

**Chart.js text scaling** (doesn't read CSS):

- New `setFontScale(scale)` on the chart controller in `js/ui/chart/index.js`. Stores `s.fontScale` in chart state and rescales `chart.options.scales.{x,y,yRate}.{ticks,title}.font.size`, `chart.options.plugins.legend.labels.font.size`, then rebuilds annotations. Base sizes are held in a `BASE_FONTS` constant so the scale multiplier always applies to the canonical base, not a previously-scaled value. Internal early-return on same-scale keeps it idempotent and self-synces a freshly-created chart after `initSimScreen`.
- Canvas-drawing plugins now multiply their hardcoded font sizes by `s.fontScale`:
  - `js/ui/chart/plugins/target-label.js` — target/threshold/SS/exit pill labels (base 10px).
  - `js/ui/chart/plugins/readout-panel.js` — inspect-mode time/Ce/Cp/eBIS/Rate panel (base 11px, line-height 14px also scales).
  - `js/ui/chart/annotations.js` — BIS band labels (base 9px) in `buildAnnotations`.
- `js/app/chart-bridge.js onFrame` pushes the mapped scale (`normal → 1.0`, `large → 1.15`, `xl → 1.30`) into `chart.setFontScale()` every frame. The idempotent guard lives on the chart side so chart recreation (new case) picks up the scale on the first frame without needing a bridge-level reset.

**Files changed:** `js/version.js`, `index.html`, `js/ui/chart/index.js`, `js/ui/chart/state.js`, `js/ui/chart/annotations.js`, `js/ui/chart/plugins/target-label.js`, `js/ui/chart/plugins/readout-panel.js`, `js/app/chart-bridge.js`, `CHANGELOG.md`, `DEVELOPMENT.md`.

---

## [0.5.24] — 2026-04-20

"Large type" option in the Appearance settings tab. Segmented control with three levels — Normal / Large / XL — that bumps drug-panel and history informational text by roughly +15% and +30%. The `.ce-current` and `.cp-current` readouts are deliberately left alone since they are already large, so the Ce row stays on one line.

**Implementation:**

- New `textSize` setting (`'normal' | 'large' | 'xl'`) in `js/ui/settings.js` with validator and persistence.
- `body.text-lg` / `body.text-xl` CSS classes in `index.html` override `font-size` on targeted drug-panel selectors (`.drug-name`, `.drug-approach`, `.drug-status`, `.drug-rate`, `.drug-bis`, `.drug-model`, labels, `.cp-current`, `.step-bar-countdown`) and history selectors (`.history-row`, `.h-time`, `.h-type`, `.h-detail`, `.history-empty`).
- Overrides are wrapped in `@media (min-width:601px) and (min-height:421px)` so they do not fight the compact-layout rules on phone landscape (`max-width:900 and max-height:420`) or small portrait phones (`max-width:500`). The cards grow taller, not wider; the drug panel is already `overflow-y:auto` so the extra height simply scrolls.
- Segmented-control UI in the Appearance pane, styled with new `.seg-group` / `.seg-btn` classes. `js/app/settings-ui.js` applies the body class on load and on change, persisting via `setSettings`.

**Files changed:** `js/version.js`, `js/ui/settings.js`, `js/app/settings-ui.js`, `index.html`, `CHANGELOG.md`, `DEVELOPMENT.md`.

---

## [0.5.23.1] — 2026-04-20

Fix chart-control button state at the start of a new case. The chart's internal toggles (`inspectEnabled`, `eventAnnotationsEnabled`) reset to `false` whenever `initSimScreen` destroys and recreates the chart, but the `.active` CSS class on the tooltip and event-markers buttons persisted across case boundaries — leaving the buttons lit while the chart showed neither inspect panel nor future-event markers. The expand button's glyph/`.active` class and the `sim-content.chart-expanded` layout class had the same problem. `initSimScreen` now clears all four button states (tooltip, events, expand glyph + class, and the expanded-layout class) before creating the new chart so the DOM matches the fresh chart state.

---

## [0.5.19] — 2026-04-11

Opt-in "Round TCI plan in display units" mode. Makes every bolus and rate emitted by the planner line up with pump-enterable numbers in the clinician's chosen display units (e.g. integer mL/h, multiples of 10 mcg/kg).

**Design principle — quantize inside the loop, not after:**

The naive fix (rounding the planner's final output to display units) introduces stacking errors because each iteration of the maintenance loop advances the engine with the *un-rounded* canonical value, so rounding error compounds. The correct fix is to quantize **inside** the planning loop — every `engine.advance()` call uses the already-quantized value the pump will actually deliver.

**Implementation:**

- New `quantSteps` tables in `DRUG_TASK_UNITS` (`js/util/constants.js`) define per-drug per-display-unit step sizes (propofol mL/h: 1, mcg/kg: 10, mcg/kg/min: 5; fentanyl mcg: 5, mcg/kg/min: 0.01; ketamine mg: 5, mg/kg: 0.1, etc.).
- `quantizeInDisplay(canonicalValue, displayUnit, drugId, task, ctx)` in `js/util/units.js` snaps a canonical value to the nearest step in the display grid and returns it in canonical units. No-op when no step is defined for that unit.
- `getQuantizeConfig(drugId)` reads `tci-pref-quantizeInDisplay` + the drug's stored `tci-pref-{task}Unit-{drug}` keys and returns a config object the planner threads through.
- `makeQuantizers(cfg)` in `js/sim/tci/shared.js` produces `qBolus`/`qRate` closures applied inside all four planners (`js/sim/tci/stepped.js`, `cet.js`, `cet-conservative.js`, `emulation.js`) *and* in `appendTerminalRates()` (`shared.js`). Closures are no-ops when the flag is off, so all 426 existing tests remain green.
- Emulation planner's legacy `Math.ceil(bolusMg)` and `rnd(r) = Math.round(r*360)/360` paths are gated behind `!cfg.quantizeInDisplay`; when quantize is on the `rnd` closure snaps through the user's chosen display unit (`qRate(r*60)/60`), and the adaptive-correction pass quantizes `rate` before the forward-probe extension loop so probe duration matches the rate the pump will actually deliver.
- Conservative→CET delegation passes the already-quantized bolus as `bolusOverrideMg` so it isn't double-snapped.
- Terminal rates (long-lookahead binary-search + analytical SS) are quantized before being appended.

**UI (opt-in):**

- New checkbox "Round TCI plan in display units" in the propofol setup panel (index.html). Flag is drug-agnostic — one checkbox governs every drug, since the planner reads each drug's own stored display-unit pref.
- Live-updating rounding-note line under every drug's unit selectors showing exactly what grid the planner will use, e.g. "Plan rounds to: bolus → nearest 10 mcg/kg, rate → nearest 1 mL/h". Note dims when the checkbox is off and reads "Planner rounds in engine-canonical units (mg / mg/min)."
- `populateRoundingControls()` in `js/ui/setup.js` wires listeners on the checkbox and all six unit selectors so the note reflects current selection in real time.
- Preference persisted under `tci-pref-quantizeInDisplay` in localStorage; re-saved on confirm in `applyPumpSettings()`.

**Tests:**

- 25 new quantization tests in `tests/test-units.js` covering every drug/unit grid, idempotence, round-to-nearest semantics, weight-dependent snapping, zero/NaN passthrough, null-step fallback.
- 4 new stacking-error regression tests in `tests/test-tci-scheme.js` using an inline quantize-in-loop planner variant. Proves (a) every rate in the scheme is an integer mL/h value, (b) Ce at 30 min stays within ±8% of target, (c) bolus is a whole mg, (d) engine state is preserved.
- **455 tests across 13 suites, all passing.**

---

## [0.5.18] — 2026-04-11

Per-drug default unit selectors and PK model provenance display on the setup screen.

**Model info display:**

Each drug setup panel now shows a `.model-info` block listing the PK/PD model provenance under the drug selection tabs — e.g. "Eleveld 2018" for propofol, "Shafer 1990 with Shibutani 2004 weight correction" for fentanyl, "Domino 1982 / Navarrete 2000" for ketamine. Names and descriptions come from exported `MODEL_NAME` / `MODEL_DESCRIPTION` constants in each `js/pk/<drug>.js`.

**Default unit selectors:**

Every drug gained per-task default unit dropdowns in its setup panel (bolus unit + rate unit, populated from the drug's `DRUG_TASK_UNITS.allowed` list). Persisted to localStorage under `tci-pref-{task}Unit-{drug}` and consulted by the keypad and drug panel on every open — so a clinician who prefers mcg/kg/min over mL/h sees that unit pre-selected everywhere, without having to flip it each time. Existing runtime unit overrides still work and still persist per-task.

---

## [0.5.14] — 2026-04-09

Split manual-mode infusion analysis into two independent systems: analytical steady state and slope-reversal plateau detection.

**Analytical Steady State:**

- Compute true Ce_ss via `−A⁻¹·B·rate` (pure matrix math, no simulation needed)
- Forward-simulate at 1-min resolution to find time to reach 95% of Ce_ss
- Backward scan from horizon end rejects transient band crossings (e.g. Ce passing through band on the way down after rate reduction)
- Green dashed line on chart at Ce_ss with "SS" right-margin label
- "Steady State X.XX in M:SS" countdown in drug card text

**Slope-Reversal Plateau Detection:**

- Entry: sustained low-slope window (15 consecutive minutes below slope tolerance)
- Mandatory slope reversal: pre-entry direction must differ from post-entry direction
- Monotonic approach to steady state is NOT a plateau — returns `noPlateau: true`
- Scan-based reversal detection catches slow V3 turnarounds up to EXIT_HORIZON minutes past sustain end
- Plateau entry marked at START of 15-minute sustained window
- Amber bounding box on chart + separate "Plateau" text line in drug card

**Bug fix:**

- Time-to-SS detection: changed from forward scan (first entry into 95% band) to backward scan (last exit from band). Fixes false positive where Ce transiently crosses the band while decaying through it, undershoots, then slowly recovers from below.

**421 tests across 13 suites, all passing.**

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
