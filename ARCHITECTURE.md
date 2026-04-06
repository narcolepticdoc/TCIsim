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

## Event System (`js/sim/events.js`)

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

The facade selects the planner based on `tciMode`: `stepped`, `cet`, `cet-conservative`, or `cet-emulation`.

## Pump Settings (`js/util/constants.js`)

Runtime-configurable pump parameters:
- `concentration` — 10 mg/mL (1%) or 20 mg/mL (2%)
- `bolusRateMlH` — max pump rate: 750, 1000, or 1200 mL/h
- `maxRate` — derived: `bolusRateMlH * concentration / 60` (mg/min)

Persisted to localStorage. Accessed via `getPumpSettings(drugId)` / `setPumpSettings(drugId, opts)`.

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

## TCI Planners (`js/sim/tci-planner.js`)

Four planning modes. See TCI-PLANNERS.md for full detail.

All planners share:
- `plannerBolusDelivery(doseMg, cfg)` — computes duration and rate for bolus delivery, matching `events.js getBolusDelivery()`
- Decay-wait phase for target decreases: when Ce > upperBound, rate=0 and advance until Ce decays to tolerance band before entering maintenance search
- `refitEigenstate()` pattern for syncing SimTIVA eigenstate to engine reality after any engine advance

### Emulation Planner Eigenstate Sync

`planTCISchemeEmulation` maintains a parallel `ps1/ps2/ps3` eigenstate alongside the engine for the SimTIVA Cp-targeting math. After each Ce-boost interval (where the engine is advanced directly), `refitEigenstate()` is called to resync this eigenstate from the engine via Cramér's rule. Without this, the eigenstate diverges at the Ce→Cp transition, producing wrong first maintenance step rates.

## UI Architecture

Single-page app with two screens (setup and simulation), no framework. All UI modules are ES modules that export `init()` functions called from `app.js`.

- Setup screen: patient demographics, pump configuration, TCI mode selection
- Sim screen: drug panel (Ce/Cp display), chart (Chart.js), history panel, keypad modal, event editor modal
- Timer: elapsed time with optional wall-clock sync, dual-mode popover (Start Time / Elapsed Time)
- History: all events visible including system events (dimmed italic with ↩ prefix), tappable timestamps toggle ET/RT

## Event Warning System (`js/ui/warnings.js`, `js/ui/alert-sound.js`)

Two-tier advance warnings for upcoming pump events (`source:'tci'` and `source:'manual'`). `source:'system'` events are excluded — they are automatically applied and require no human action.

**Prep stage** (configurable, default 30s before event):
- Inset amber border glow on the relevant drug card (`.warn-prep` CSS class). Inset box-shadow is required because `.drug-panel` has `overflow-y: auto`, which clips outward shadows on all sides.
- Amber background pulse on `.sim-topbar` (`.warn-header` CSS class) — full-width, always visible.
- Optional chime (`playAlert('info')`), off by default.

**Alert stage** (configurable, default 10s before event):
- Three-tone chime (`playAlert('warning')`) if sound is enabled (on by default).
- Persistent popup appended to `#warnings-container` (fixed position, stacked above bottom controls). Shows drug name, event description in display units, live countdown. Requires manual "Got it" to dismiss.

**Per-frame check:** `warnings.check(t)` is called every rAF frame from the `onFrame` callback in `app.js`. Prep visual (card class + topbar class) is toggled each frame based on current `remSec <= prepSec`. Alert and prep-sound are one-shot per event ID, guarded by `_alertFired` and `_prepSoundFired` Sets. Both sets clear on `reset()` (called on new case).

**Audio:** `alert-sound.js` holds a single persistent `AudioContext`. `unlockAudio()` is registered as a one-shot `click` listener in `warnings.init()` to satisfy browser autoplay policy. Three levels: `info` (single 880 Hz), `warning` (880/880/1100 Hz), `urgent` (alternating 1200/900 Hz).

**Settings:** Stored in localStorage under `'tci-warn-settings'`. Four fields: `prepSec` (default 30), `prepSound` (default false), `alertSec` (default 10), `alertSound` (default true). Accessible via the ⚙ gear button in the topbar.
