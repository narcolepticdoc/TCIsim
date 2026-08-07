# Architecture

## PK Engine (`js/pk/engine.js`)

The engine uses **matrix-exponential** state advancement, not SimTIVA's per-second eigenvalue stepping. This allows arbitrary time steps with no accumulation error.

### State Representation

The engine stores a `Float64Array` of 5 values: `[A1, A2, A3, Ae, tTotal]` where:
- `A1, A2, A3` = drug amount in compartments 1 (central), 2 (fast peripheral), 3 (slow peripheral)
- `Ae` = effect-site amount (virtual compartment)
- `tTotal` = cumulative time in minutes

Concentrations are derived: `Cp = A1 / V1`, `Ce = Ae * ke0 / V1` (normalized).

### Advancement

`engine.advance(durationMin, rateMgPerMin)` computes the exact state at `t + dt` using the 4×4 matrix exponential of the rate constant matrix. This is accurate for any step size — 0.1 minutes or 60 minutes give identical results.

### How This Differs From SimTIVA

SimTIVA uses per-second eigenvalue decomposition: it decomposes the 3-compartment system into eigenstates (`p_state[1..3]`, `e_state[1..4]`) and advances each component by `s_i *= exp(-λ_i)` per second. This is mathematically equivalent but tied to 1-second steps.

Our engine uses the full 4×4 system matrix (including effect site) and computes the matrix exponential directly. The Eleveld parameters are validated to produce **0.0000% Cp deviation** from SimTIVA across all patient archetypes.

## Eleveld 2018 Parameters (`js/pk/eleveld.js`)

Computes all PK-PD parameters from patient demographics: age, weight, height, sex, opioid co-administration. Outputs: V1, V2, V3, CL, Q2, Q3, ke0, Ce50, γ (Hill coefficient), E0, Emax.

Key implementation details:
- Age-maturation sigmoid function for pediatric patients
- Opioid flag affects CL (×1.37) and Ce50 (significantly reduced)
- Fat-free mass calculation per the Al-Sallami equation

## Event System (`js/sim/events/`)

Events are the source of truth. The event list stores time-ordered events (bolus, rate change, pause) and replays them through the PK engine to compute concentrations at any time.

### Event Types

- **bolus** — Pump bolus (delivered at max pump rate) or IV push (instantaneous)
- **rate** — Infusion rate change (mg/min)
- **pause** — Rate set to 0 with optional timed resume

### Bolus Delivery Model

Boluses are delivered as constant-rate infusions at the pump's max rate. A 128mg bolus at 1000 mL/h (10 mg/mL) takes `128/10/1000*3600 = 46 seconds`. The engine advances through this delivery period, producing realistic Cp spikes.

System rate-restore events are automatically inserted after timed boluses and pauses, flagged with `source: 'system'`. These are visible in the history panel as dimmed italic rows with a ↩ prefix but can be edited and deleted like any event.

### Overlap and Boundary Rules

`findActiveBolus` uses strict less-than boundary checks. When a manual rate change or pause event falls at the exact time a bolus ends, `addRate` and `addPause` explicitly scan and remove any system rate-restore at that exact time before inserting the new event. Do not rely on `findActiveBolus` alone for boundary collision detection.

### TCI Conflict Rules

When a TCI scheme is planned, the planner clears future TCI events and inserts the new scheme. Manual events (rate changes, boluses) interrupt TCI mode.

## Simulation Facade (`js/sim/simulation.js`)

`createModel()` returns a stateless facade that wraps the event list and PK engine. Key methods:

- `setPatient(demographics)` — configures Eleveld parameters
- `planTCI(drugId, time, ceTarget, { tciMode })` — generates and inserts a TCI scheme
- `getConcentrationsAt(drugId, time)` — replays events to get Cp, Ce, rate at any time
- `getEvents(drugId)` — returns the event list
- `predictSteadyState(drugId, time, rate, opts)` — analytical Ce_ss + time to 95%
- `predictPlateau(drugId, time, rate, slopeTol, opts)` — slope-reversal plateau detection

The facade selects the planner based on `tciMode`: `stepped`, `cet`, `cet-conservative`, or `cet-emulation`.

## Steady-State Predictor (`js/pk/steady-state-predictor.js`)

Two independent predictors for manual-mode constant infusion:

### Analytical Steady State

Computes `Ce_ss = (−A⁻¹ · B · rate)[3]` analytically via matrix inverse — pure math, no simulation. All eigenvalues of the 4-compartment system are negative, so steady state always exists for rate > 0. At true steady state, Ce_ss = Cp_ss (the effect site equilibrates with plasma).

Time to 95% of Ce_ss is found by forward-simulating at 1-min resolution and scanning **backward** from the horizon to find the last minute Ce was outside the 5% band. The backward scan rejects transient crossings where Ce passes through the band on the way down (e.g. after a rate reduction) then undershoots before recovering.

### Plateau Detection

Detects local transient equilibria (Ce temporarily stabilizes then reverses), distinct from monotonic steady-state approach.

1. **Entry:** first minute where per-minute relative slope stays below `slopeTol` for 15 consecutive minutes. Entry is the START of the sustained window.
2. **Slope reversal:** pre-entry direction (sign of `ce[entry] − ce[lookback]`) must differ from post-entry direction (any opposite-sign movement scanned up to EXIT_HORIZON minutes past sustain end).
3. **Exit:** first minute Ce departs a ±exitBandPct band around the entry Ce.

If no reversal is found, returns `noPlateau: true`. This prevents monotonic approach to steady state from being flagged as a plateau.

## Pump Settings (`js/util/constants.js`)

Runtime-configurable pump parameters:
- `concentration` — 10 mg/mL (1%) or 20 mg/mL (2%)
- `bolusRateMlH` — max pump rate: 750, 1000, or 1200 mL/h
- `maxRate` — derived: `bolusRateMlH * concentration / 60` (mg/min)

Persisted to localStorage. Accessed via `getPumpSettings(drugId)` / `setPumpSettings(drugId, opts)`.

## Unit Conversion (`js/util/units.js`)

Bidirectional conversion between canonical engine units (mg, mg/min, mcg/mL) and display units (mL/h, mcg/kg/min, ng/mL, mcg/kg, etc.), driven by the `DRUG_TASK_UNITS` table in `constants.js`.

- `toCanonical(value, unit, drug, task, ctx)` / `fromCanonical(...)` — round-trip conversion using patient weight and drug concentration from `ctx`.
- `getAllowedUnits(drug, task)` / `getDefaultUnit(drug, task)` / `getPrefKey(drug, task)` — look up the keypad-allowed list, default display, and localStorage key for the per-drug per-task unit preference.
- `quantizeInDisplay(canonicalValue, displayUnit, drug, task, ctx)` — snaps a canonical value to the nearest step defined in `DRUG_TASK_UNITS[drug][task].quantSteps[displayUnit]`, then returns the result in canonical units. Used by the TCI planner for the opt-in "Round TCI plan in display units" mode. No-op when no step is defined for that unit.
- `getQuantStep(drug, task, displayUnit)` / `getQuantizeConfig(drug)` — table lookup and localStorage-backed config reader used by the setup panel and all three `planTCI()` call sites.

## SimTIVA Reference Module (`js/sim/simtiva-reference.js`)

Clean-room reimplementation of SimTIVA's eigenvalue-based computations, used by the CET planners:

- `computeUDFs(pkParams, deltaSec)` — eigenvalue decomposition via `cube()` solver, produces `p_udf` (Cp unit dose function, 21600 entries), `e_udf` (Ce unit dose function, peak search ceiling 3600s), `p_coef`, `e_coef`, `lambda` arrays
- `computeSimTIVACETBolus(pkParams, ceTarget, opts)` — CET bolus with mechanistic rate correction factor; rounds in mL then converts to mg (matching SimTIVA)
- `computeRateCorrFactor(rawBolusMg, peakTimeSec, maxRateMgSec, e_coef, lambda)` — patient-specific UDF simulation replaces previous linear approximation; reduces mean Ce peak error from −8.4% to −1.9% across patient range

**This module does NOT import SimTIVA's GPL-3.0 code.** It is a mathematical reimplementation of the same pharmacokinetic algorithms.

### Key Implementation Details

- `e_udf` peak search ceiling is 3600s (not 1000s) to correctly handle drugs with slow ke0
- Bolus rounding is done in mL (`Math.round(durationSec * maxRateMgSec / concentration)`) then converted back to mg, matching SimTIVA line 4702
- `computeRateCorrFactor` takes `e_coef[]` and `lambda[]` (not pump-rate scalars) and simulates the Ce trajectory during delivery to find the mechanistically correct correction duration

## TCI Planners (`js/sim/tci/`)

Four planning modes, split into separate modules under `js/sim/tci/` (shared helpers in `shared.js`, one file per planner; `js/sim/tci-planner.js` is a thin re-export shim). See TCI-PLANNERS.md for full detail.

All planners share:
- `plannerBolusDelivery(doseMg, cfg)` — computes duration and rate for bolus delivery, matching `events.js getBolusDelivery()`
- Decay-wait phase for target decreases: when Ce > upperBound, rate=0 and advance until Ce decays to tolerance band before entering maintenance search
- `refitEigenstate()` pattern for syncing SimTIVA eigenstate to engine reality after any engine advance
- `makeQuantizers(cfg)` — when `cfg.quantizeInDisplay` is set, produces `qBolus`/`qRate` closures that snap canonical values to the clinician's chosen display-unit grid via `quantizeInDisplay()` from `js/util/units.js`. Applied **inside** the planning loop (before every `engine.advance()`) so stacking errors don't accumulate. When the flag is off, the closures are identity functions and default behaviour is unchanged.

### Emulation Planner Eigenstate Sync

`planTCISchemeEmulation` maintains a parallel `ps1/ps2/ps3` eigenstate alongside the engine for the SimTIVA Cp-targeting math. After each Ce-boost interval (where the engine is advanced directly), `refitEigenstate()` is called to resync this eigenstate from the engine via Cramér's rule. Without this, the eigenstate diverges at the Ce→Cp transition, producing wrong first maintenance step rates.

## UI Architecture

Single-page app with two screens (setup and simulation), no framework. All UI modules are ES modules that export `init()` functions called from `app.js`.

- Setup screen: patient demographics, pump configuration, TCI mode selection
- Sim screen: drug panel (Ce/Cp display), chart (Chart.js), history panel, keypad modal, event editor modal
- Timer: elapsed time with optional wall-clock sync, dual-mode popover (Start Time / Elapsed Time)
- History: all events visible including system events (dimmed italic with ↩ prefix), tappable timestamps toggle ET/RT

### App Entry Point (`js/app.js` + `js/app/`)

`app.js` is the entry point loaded via `<script type="module">`. It owns core application state (model, patient, selected drug, chart instance) and wires all UI modules via `boot()`. Domain concerns are split into sub-modules under `js/app/`:

| Module | Factory | Responsibility |
|--------|---------|----------------|
| `settings-ui.js` | `initSettingsUI()` | Settings modal DOM wiring (sliders, checkboxes, tabs) |
| `tci-modal.js` | `createTciModal()` | TCI delay selection + first-step countdown modals |
| `session.js` | `createSession()` | Case save / restore / new case lifecycle |
| `chart-bridge.js` | `createChartBridge()` | Chart refresh cycle, BIS overlay bands, per-frame updates |

Each sub-module receives dependencies via a factory options object (getter functions for mutable state, direct references for stable modules). Late-binding closures resolve circular dependencies between chart-bridge (calls `session.save()`) and session (calls `chartBridge.refresh()`).

## Event Warning System (`js/ui/settings.js`, `js/ui/alert-sound.js`)

Two-tier advance warnings for upcoming pump events (`source:'tci'` and `source:'manual'`). `source:'system'` events are excluded — they are automatically applied and require no human action.

**Prep stage** (configurable, default 30s before event):
- Inset amber border glow on the relevant drug card (`.warn-prep` CSS class). Inset box-shadow is required because `.drug-panel` has `overflow-y: auto`, which clips outward shadows on all sides.
- Amber background pulse on `.sim-topbar` (`.warn-header` CSS class) — full-width, always visible.
- Optional chime (`playAlert('info')`), off by default.

**Alert stage** (configurable, default 10s before event):
- Three-tone chime (`playAlert('warning')`) if sound is enabled (on by default).
- Persistent popup appended to `#warnings-container` (fixed position, stacked above bottom controls). Shows drug name, event description in display units, live countdown. Requires manual "Got it" to dismiss.

**Per-frame check:** `settings.check(t)` is called every rAF frame from the `onFrame` callback in `js/app/chart-bridge.js`. Prep visual (card class + topbar class) is toggled each frame based on current `remSec <= prepSec`. Alert and prep-sound are one-shot per event ID, guarded by `_alertFired` and `_prepSoundFired` Sets. Both sets clear on `reset()` (called on new case).

**Audio:** `alert-sound.js` holds a single persistent `AudioContext`. `unlockAudio()` is registered as a one-shot `click` listener in `settings.init()` to satisfy browser autoplay policy. Three levels: `info` (single 880 Hz), `warning` (880/880/1100 Hz), `urgent` (alternating 1200/900 Hz).

**Settings:** Stored in localStorage under `'tci-warn-settings'`. Four fields: `prepSec` (default 30), `prepSound` (default false), `alertSec` (default 10), `alertSound` (default true). Accessible via the ⚙ gear button in the topbar.

**Acknowledgement fan-out:** `settings.init()` accepts an optional `onDismiss(evtId)`, fired from `dismiss()`. `js/app.js` wires it to `nextUp.markCleared` so pressing "Got it" also clears that row from the Next Up panel. Acknowledgement is never written back to the model — it lives only in UI-side `Set`s.

## Events Panel — two views (`js/ui/history.js`, `js/ui/next-up.js`)

`#panel-history` holds a sub-toggle (`.hv-toggle`) over two `.hv-view` containers, mirroring the `.content-view` idiom one level down. Nesting rather than adding a third `.content-view` avoids the three separate layout regimes (`setView`'s `<1020px` guard, the `≥1020px` blanket `.content-view{display:flex}`, and the portrait-≥700px `display:contents` grid) that a peer panel would each need handling for.

**Log** (`history.js`) — the retrospective record, one drug at a time, plus the Add Event / Edit / notes / ET-RT action bar.

**Next Up** (`next-up.js`) — a prospective, cross-drug heads-up display: a countdown clock over a curated list of interventions.

- **Curation** is `collectUpcoming()` in `js/sim/upcoming.js` — pure, DOM-free and unit-tested (`tests/test-upcoming.mjs`). It selects and orders items and returns raw event objects; all label formatting stays in the view via `js/util/event-label.js`. Defaults: 20 min horizon, 6 future rows, 3 elapsed rows, and a 2 min group window that keeps a cluster intact across the horizon so a pause never appears without its restart.
- **Milestones** are not predicted here. `approach.js getMilestones()` and `exit-readout.js getEmergenceArrival()` read caches the drug-panel rAF loop already fills for every drug in `DRUG_IDS`, so the forecasts cost no extra engine work.
- **Two honesty guards** (see CLAUDE.md invariants): Emergence only when the pump is idle, and no milestone that a scheduled pump event would preempt.
- **Alarm** reuses `prepSec` / `alertSec` and `displayedSecToEvent`, so the panel, the drug-card pulse and the popups never disagree. Amber at prep, red when due; a tap mutes only the keys currently alarming, so the next item to escalate re-arms the pulse.
- **Cadence:** list rebuild on a 500 ms throttle plus every model mutation (`refreshChart`); the countdown renders each frame from cached arrival times — the same cache-and-tick pattern `approach.js` uses. No per-frame model calls.
- `classifyFutureEvents` lives in `js/sim/upcoming.js` and is re-exported from `chart-bridge.js` for its historical import path, so the chart's event flags and the panel's rows share one rate-direction rule.
