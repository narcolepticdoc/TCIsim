# TCI Sim — Claude Code Reference

Mobile-first PWA for anesthesia training. Simulates propofol (Eleveld 2018), fentanyl (Shafer 1990 + Shibutani 2004), and ketamine (Domino 1982 / Navarrete 2000) pharmacokinetics with Target Controlled Infusion (TCI) planning. Current version: **0.5.24.22** (see `js/version.js`).

## Quick Start

No build step — pure ES modules served as static files.

```bash
# Serve locally (any static server works)
python3 -m http.server 8080
# or
npx serve .

# Run the test suite (485 tests, 13 suites)
node tests/run-tests.js
```

`index.html` is the single-page entry point; `<script type="module" src="js/app.js">` boots everything. The PWA `manifest.json` enables home-screen install.

## Key Files

```
js/version.js             APP_VERSION — single source of truth, edit here to bump the version
js/pk/eleveld.js          Eleveld 2018 PK-PD parameter calculator (propofol, exports MODEL_NAME)
js/pk/fentanyl.js         Shafer 1990 + Shibutani 2004 weight correction (TBW≥85 & BMI>30)
js/pk/ketamine.js         Domino 1982 / Navarrete 2000 micro-constant model
js/pk/pd.js               PD model — BIS prediction via sigmoid Emax (`ceForBIS(N, params)`)
js/pk/decay-predictor.js  Trough/redose-time prediction via matrix engine
js/pk/engine.js           Matrix-exponential PK engine (4×4, arbitrary time steps)
js/sim/events.js          Thin re-export shim over js/sim/events/
js/sim/events/index.js    Event list orchestrator — state + facade assembly
js/sim/events/delivery.js Bolus delivery math (pump rate, push rate)
js/sim/events/replay.js   Per-drug engine replay, getRateAtTime, getActiveRateForDrug
js/sim/events/list-ops.js CRUD: insert/remove/getById/getAll/getByDrug/clearAfter/clearFrom/clearAll
js/sim/events/query.js    getConcentrationsAt, computeCurve, getStateAtLastEvent, getStateAtTime
js/sim/events/actions.js  findActiveBolus + addRate/addBolus/addPause/editEvent/deleteEvent
js/sim/simulation.js      Stateless facade: setPatient, planTCI, getConcentrationsAt
js/sim/tci-planner.js     Thin re-export shim over js/sim/tci/
js/sim/tci/shared.js      Shared helpers: DEFAULT_SCHEME_CONFIG, makeQuantizers, appendTerminalRates, findMaintenanceRate
js/sim/tci/stepped.js     planTCIScheme — conservative, binary-search bolus
js/sim/tci/cet.js         planTCISchemeCET + calculateCETBolus — fast onset, peak-matched
js/sim/tci/cet-conservative.js  planTCISchemeCETConservative — rate-corrected bolus
js/sim/tci/emulation.js   planTCISchemeEmulation — SimTIVA deliver_cpt port
js/sim/tci/index.js       Barrel re-export + planTCIFromEvents convenience wrapper
js/sim/simtiva-reference.js  SimTIVA eigenvalue math (clean-room, no GPL code)
js/util/constants.js      DRUG_DEFS, DRUG_IDS, DRUG_TASK_UNITS (incl. quantSteps), pump settings + isPumpEnabled, PUMP_MANDATORY
js/util/units.js          Bidirectional unit conversion + quantizeInDisplay + getQuantizeConfig
js/util/math.js           Matrix-exp, eigenvalue utilities (cube solver)
js/pk/steady-state-predictor.js  Analytical SS + slope-reversal plateau detection
js/ui/drug-panel.js       Thin re-export shim over js/ui/drug-panel/
js/ui/drug-panel/index.js Drug panel orchestrator — rAF loop, update(), public getters
js/ui/drug-panel/approach.js  Approach line: cache (incl. ceAboveTarget), computeApproachData
js/ui/drug-panel/step-bar.js  Step bar progress + next-event countdown
js/ui/drug-panel/exit-readout.js  Emergence ("Emerge → X in Y") countdown line
js/ui/drug-panel/formatters.js   fmtCountdown, bisColor, fmtCe, fmtRateInline
js/ui/chart.js            Thin re-export shim over js/ui/chart/
js/ui/chart/index.js      Chart.js wrapper — curves, cursor dots, target/threshold/SS lines, plateau region, BIS bands, opacity + font-scale setters (all idempotent)
js/ui/chart/annotations.js  Annotation rebuild — bands, target lines, plateau region, inspect cursor
js/ui/chart/gestures.js   Canvas touch/mouse handlers — Y-axis drag, double-tap recenter, inspect-handle drag (capture-phase on parent + pan-disable while active)
js/ui/chart/plugins/      afterDraw plugins — target-label, cursor-dots, inspect-dots, inspect-handle (draggable pill), readout-panel, event-markers
js/ui/settings.js         Event warnings (prep + alert) + persisted user prefs (opacity, redose, plateau bands, textSize, eventMarkerSize)
js/ui/alert-sound.js      Persistent AudioContext; unlockAudio() + playAlert('info'|'warning'|'urgent'|'redose')
js/ui/mode.js             Per-drug mode tracking (none/tci/manual/intermittent) + button dim/bright state
js/ui/keypad.js           Numeric keypad modal (target / rate / bolus / emergence / redose); unit toggle round-trips values through canonical
js/ui/event-editor.js     Unified event editor modal (rate/pause options hidden when pump off); unit toggle converts buffer
js/ui/patient-modal.js    Patient Demographics modal with built-in 3×5 numeric keypad, Male/Female toggle, Metric/Imperial toggle (shared with setup.setUnits)
js/ui/setup.js            Setup screen — clickable patient-summary row opens patient-modal; pump settings; delivery method; rounding controls; exports _convertLength / _convertWeight
js/ui/history.js          Event history panel (grid row: time+type on line 1, value centered on line 2; edit-mode via Edit button; ET/RT toggle)
js/ui/timer.js            Elapsed time / wall clock — single-line [Case start HH:MM | ET H:MM:SS] button with popover
js/ui/controls.js         Start/pause case controls
js/ui/persist.js          LocalStorage case save/restore primitives
js/app.js                 Entry point, wires all modules
js/app/settings-ui.js     Settings modal DOM wiring (sliders, tabs, Appearance tab incl. textSize segmented control)
js/app/tci-modal.js       TCI delay + first-step countdown modals
js/app/session.js         Case save / restore / new case (incl. pumpEnabled map)
js/app/chart-bridge.js    Chart refresh, BIS overlay, per-frame updates, settings propagation (calls idempotent setters unconditionally)
js/app/portrait-layout.js Dynamic grid-row sizing for portrait tablet layout via ResizeObserver + matchMedia
```

## Architecture in One Paragraph

The engine stores compartment amounts as a `Float64Array[5]` and advances via matrix exponential — any step size, no accumulation error. The event list (bolus/rate/pause) is the source of truth; concentrations at any time are computed by replaying events through the engine. `simulation.js` is a pure command/query facade — no internal clock or state machine. The UI owns time display and playback. TCI planners generate arrays of `{type, time, value}` events that get inserted into the event list.

## Invariants — Do Not Break

- **Engine time unit is minutes.** `simtiva-reference.js` converts internally to seconds; everything else in the codebase uses minutes. Do not change this.
- **`findActiveBolus` uses strict less-than boundaries.** Boundary-collision bugs (e.g. a rate change at the exact end of a bolus) require explicit scans in `addRate`/`addPause` — do not rely on `findActiveBolus` alone.
- **Cramér's rule is the eigenstate pattern.** When syncing SimTIVA eigenstate (`ps1/ps2/ps3`) to engine reality, use the 3-sample Cramér's rule refit (`refitEigenstate()`). Do not use second-by-second replay.
- **System events must stay visible.** Rate-restore events (`source: 'system'`) are shown in history as dimmed italic rows. Do not filter them from the UI — users need to see and delete them.
- **Quantize inside the planning loop, not after.** When `cfg.quantizeInDisplay` is set, `qBolus`/`qRate` (from `makeQuantizers`) must be applied **before** every `engine.advance()` call. Rounding the planner's output as a final pass introduces stacking error because each iteration of the maintenance loop sees the un-rounded value.
- **DRUG_IDS is the iteration source of truth.** When adding a drug, update `DRUG_IDS` in `js/util/constants.js` — the multi-drug loops in `app.js`, `session.js`, and `chart-bridge.js` consume it. `remifentanil` is in `DRUG_DEFS` but absent from `DRUG_IDS` because it has no PK model yet.
- **Chart setters are idempotent, bridge calls them unconditionally.** `setCpOpacity`, `setNomogramOpacity`, `setOverlayOpacity`, `setEventMarkerSize`, `setFontScale` all early-return when the incoming value matches chart state. `chart-bridge.js onFrame` reads settings every frame and pushes without a cache. This makes chart recreation (New Case) self-healing: fresh chart defaults differ from user settings, so the first post-recreate frame applies them. Do not reintroduce bridge-level `last*` caches on these setters — they cause settings to silently not re-apply on new case.
- **Keypad unit toggles convert, they don't clear.** `keypad.js`, `event-editor.js`, and `patient-modal.js` all round-trip the current buffer through `toCanonical → fromCanonical` on unit change and re-arm `prefilled = true` so the next keypress overwrites. Do not revert to clearing the buffer on unit change.
- **`pharmacology.js` is GPL-3.0.** Never import, bundle, or copy code from `/mnt/project/pharmacology.js`. Reference only.

## TCI Planner Quick Reference

| Mode | Key characteristic | Main file function |
|---|---|---|
| `stepped` | Conservative, binary search | `planTCIScheme` |
| `cet` | Fast onset, peak-matched bolus | `planTCISchemeCET` |
| `cet-conservative` | SimTIVA-style, rate-corrected bolus | `planTCISchemeCETConservative` |
| `cet-emulation` | SimTIVA deliver_cpt port, best accuracy | `planTCISchemeEmulation` |

The emulation planner maintains a parallel SimTIVA eigenstate (`ps1/ps2/ps3`). After any Ce-boost engine advance, call `refitEigenstate()` to keep it in sync before the Cp-targeting pass.

`computeRateCorrFactor` in `simtiva-reference.js` takes `(rawBolusMg, peakTimeSec, maxRateMgSec, e_coef, lambda)` — not pump-rate scalars. It simulates Ce second-by-second to find the mechanistically correct correction duration.

## Pump Settings

```js
getPumpSettings('propofol')   // { concentration, bolusRateMlH, maxRate, pumpEnabled }
setPumpSettings('propofol', { concentration: 10, bolusRateMlH: 750 })
isPumpEnabled('propofol')     // true (mandatory)
isPumpEnabled('fentanyl')     // false by default (opt-in via setup screen)
```

`maxRate` is auto-derived as `bolusRateMlH * concentration / 60` mg/min. Persisted to localStorage. Always read pump settings from `getPumpSettings` — never hardcode 750 or 10.

`pumpEnabled` controls per-drug delivery method. Propofol is always pump-mandatory (`PUMP_MANDATORY` set). Fentanyl and ketamine default to manual (bolus only) — when pump is OFF, `updateModeUI()` in `mode.js` hides Set Rate / Stop Pump buttons and the UI locks to intermittent bolus mode with IV Push delivery. The toggle lives on the setup screen per-drug tab and is persisted to `tci-pump-enabled-{drugId}` in localStorage and in case save/restore.

## Settings & LocalStorage Keys

Settings live in `js/ui/settings.js` (`getSettings()` / `setSettings()`); UI wiring is `js/app/settings-ui.js` (Warnings, Behavior, Appearance tabs). All keys are stored under `'tci-warn-settings'` as a single JSON blob.

| Key | Default | Range | Purpose |
|---|---|---|---|
| `prepSec` | 30 | ≥0 | Visual amber pulse lead time |
| `prepSound` | false | bool | One-shot info chime at prep |
| `alertSec` | 10 | ≥0 | Persistent popup + warning chime lead time |
| `alertSound` | true | bool | Three-tone warning chime |
| `redoseSound` | true | bool | One-shot chime on Ce → below-redose-threshold transition |
| `statusWarnMinutes` | 2 | ≥0 | Drug card status warning threshold |
| `tciFraction` | 0.95 | 0.90–0.99 | TCI "time to target" fraction |
| `ssSlopeTol` | 0.0010 | 0.0001–0.0100 | Plateau detector slope tolerance (per-min relative) |
| `exitBandPct` | 0.05 | 0.01–0.20 | Plateau exit ±% band |
| `cpOpacity` | 1.0 | 0.1–1.0 | Cp curve alpha (Appearance tab) |
| `nomogramOpacity` | 1.0 | 0.1–1.0 | BIS band + label alpha multiplier |
| `overlayOpacity` | 1.0 | 0.1–1.0 | Threshold/target/SS/exit lines + plateau alpha (pill labels stay full opacity) |
| `eventMarkerSize` | 7 | 4–16 | Future-event marker radius (px) |
| `textSize` | `'normal'` | `normal` \| `large` \| `xl` \| `xxl` | Four-position segmented control on Appearance tab. Scales drug-panel, history, topbar, bottom-controls, and chart font-sizes. `body.text-{lg,xl,xxl}` CSS class + chart `fontScale` (1.0 / 1.15 / 1.30 / 1.45). XXL gated to ≥1020px viewports. |

Other persisted keys (separate from the warnings blob):

- `tci-pref-quantizeInDisplay` — opt-in "Round TCI plan in display units" flag.
- `tci-pref-{bolus|rate}Unit-{drug}` — per-drug per-task default display unit.
- `tci-pump-enabled-{drugId}` — per-drug pump on/off (fentanyl/ketamine only).
- Pump settings (concentration, bolusRateMlH) and saved cases under their own keys via `js/ui/persist.js`.

## UI Conventions

- **Dim/bright control buttons** (`js/ui/mode.js`): Target/threshold, emergence, rate, and bolus buttons use muted translucent backgrounds by default. Full color + glow ring appears only when `active-mode` is set on the button. Stop Pump uses `is-idle` (muted red) when no pump is active and `is-running` (bright red) only during TCI/manual.
- **Emergence naming** (user-facing, since 0.5.24.3): the "time until Ce decays to a target" concept is labelled **Emerge → / Emergence** everywhere users see it. Drug card reads `Emerge → 3.0 in 3:44`, button toggles between `Set Emergence` / `Change Emergence`, keypad modal title matches, reached state shows `Emergence Reached`. Internal symbols (`exitCe`, `setExitLine`, `getExitCeForDrug`, `.btn-ctrl-exit`, `.exit-readout`, `#<drug>-exit`) kept as-is to avoid churn.
- **Threshold dialog clear option** (`js/ui/keypad.js`): mirrors emergence — Clear button when value is set, pre-fill current value, title swaps to "Change Redose Threshold".
- **Rate keypad pre-fill**: opens with the last-used rate per drug for quick post-pause resume (stored in localStorage).
- **Keypad prefilled → replace on first keypress**: `js/ui/keypad.js`, `js/ui/event-editor.js`, `js/ui/patient-modal.js` all flag pre-populated buffers as `prefilled`. First digit/decimal/backspace clears instead of appending. Tapping into a different field re-arms the flag.
- **Active drug card** (`.drug-card.active`): background brightens + `border-left: 6px solid var(--drug-color)` + `inset 0 0 0 2px var(--drug-color)` crisp frame. Clinical look, no halos or transforms. eBIS value shows right-justified in the card header row (`.drug-bis-header`), label muted + small, value colored via `bisColor()`.
- **History panel** (`js/ui/history.js`): grid row layout — `[time | type]` on line 1, `[value centered]` on line 2. Bottom bar: `[ET / RT]` time-format toggle, `+ Add Event`, `Edit`. Edit toggles `body.edit-history-mode` which dims/blurs non-history surface and highlights rows amber; tapping a row opens the event editor. Click-outside (on the dimmed area) exits edit mode. Modal backdrop is transparent while in edit mode so the selected row stays visible.
- **Per-frame chart updates** (`js/app/chart-bridge.js onFrame`): cursor throttled 500 ms, history dimming 2 s. All settings-driven setters (`setCpOpacity`, `setNomogramOpacity`, `setOverlayOpacity`, `setEventMarkerSize`, `setFontScale`) are idempotent inside the chart — bridge calls them every frame unconditionally. Chart recreation on new case self-heals.
- **Cursor dots**: a custom `cursorDots` Chart.js plugin draws filled Ce/Cp circles where the current-time cursor crosses each curve (binary search + linear interp on dataset points).
- **Draggable inspect cursor** (`js/ui/chart/plugins/inspect-handle.js`): when inspect mode is on and a cursor is set, a horizontal pill with `<` `>` chevrons renders at `chartArea.bottom - 14`. `gestures.js` binds handle-drag listeners on `canvas.parentElement` in capture phase so they run before Chart.js's hammer listeners on the canvas target; during an active handle drag, `chart.options.plugins.zoom.pan.enabled = false` to prevent pan hijacking on iPad. `touch-action: none` on the canvas belt-and-suspenders.
- **Patient entry via modal** (`js/ui/patient-modal.js`): the main setup screen shows a single clickable summary row (`[Tap to edit patient demographics ✎]` / `[35y · M · 170 cm · 70 kg ✎]`). Tapping opens a modal with four field cells, a Male/Female toggle, a Metric/Imperial toggle (shares state with `setup.setUnits`), and an in-app 3×5 numeric keypad. The four original `<input>` elements are kept as `type="hidden"` so `validate()`, `getHeightCm()`, `getWeightKg()`, `updateDerived()`, `confirmPatient()`, and session restore keep working unchanged; the modal writes values and dispatches `input` events. Unit toggle converts values via `_convertLength` / `_convertWeight` instead of clearing.
- **Portrait tablet dynamic row sizing** (`js/app/portrait-layout.js`): on `@media (orientation:portrait) and (min-width:700px)`, `ResizeObserver` on `.drug-panel` + `matchMedia` gate set `grid-template-rows: 1fr <measured>px` on `.sim-main`. Measures via summing children `getBoundingClientRect().height` (not `scrollHeight`, which lies when content fits inside a larger container). Cap at 55% of window height so chart keeps space. No-ops outside the portrait-tablet media query.

## Running Tests

```bash
node tests/run-tests.js
```

Test files live in `tests/test-*.js`. The runner executes all of them and prints a pass/fail summary. 485 tests across 13 files, all passing. Cross-validation against SimTIVA at 0.0000% Cp deviation.

## Versioning Scheme

`js/version.js` is the single source of truth. The scheme is:

- **`1.0`** — reserved for release.
- **`0.x`** — major revisions or feature additions.
- **`0.x.x`** — minor revisions and feature changes.
- **`0.x.x.x`** — bug fixes and tweaks of existing code.

Patch numbers may go into multiple digits as necessary. `0.3.14.15` is a
perfectly valid version number. **Never bump a higher-level version
because a lower level looks "full".** `0.5.9` → `0.5.10` → `0.5.11` is
correct; `0.5.9` → `0.6.0` for a routine patch is not.

## Common Workflows

- **Adding a feature.** Bump `js/version.js`, add an entry at the top of `CHANGELOG.md` and a matching "Interim" block at the top of `DEVELOPMENT.md`. Confirm `node tests/run-tests.js` is green before committing.
- **Adding a drug.** Implement `js/pk/<drug>.js` with `MODEL_NAME`, `MODEL_DESCRIPTION`, `calc<Drug>Params(patient)` exports; register it in `DRUG_DEFS`, `DRUG_IDS`, and `DRUG_TASK_UNITS` in `js/util/constants.js`; wire model name in `simulation.js modelNames`; add a chart-config entry in `js/app/chart-bridge.js CHART_DRUG_CONFIG`; add the setup tab + drug card markup in `index.html`.
- **Editing a TCI planner.** Always thread `cfg` through and call `makeQuantizers(cfg)` so the planner participates in display-unit rounding when enabled. After any direct `engine.advance()` in the emulation planner, call `refitEigenstate()` before resuming Cp-targeting.
- **Touching the chart.** New visual overlays (lines, regions, bands) get a setter on `js/ui/chart.js` and a value-change-guarded propagation step in `chart-bridge.js onFrame`. If the overlay should be user-dimmable, plumb it through `_overlayAlpha`/`_nomogramOpacity` in chart scope so it survives annotation rebuilds (zoom/pan/cursor move).
- **Adding a setting.** Extend the `DEFAULTS` object + validator in `js/ui/settings.js getSettings()`, add a `<input>` to the matching tab in `index.html`, and wire the slider/checkbox in `js/app/settings-ui.js`.

## Docs

- `ARCHITECTURE.md` — engine, event system, module responsibilities
- `TCI-PLANNERS.md` — planner algorithms, validation data, remaining gaps
- `DEVELOPMENT.md` — complete session log, known issues, roadmap (single source of truth)
- `CHANGELOG.md` — versioned release notes
- `LICENSE-NOTES.md` — clean-room implementation notes, file audit
- `README.md` — public-facing overview and project structure
