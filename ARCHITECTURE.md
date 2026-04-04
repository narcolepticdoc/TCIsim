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

System rate-restore events are automatically inserted after timed boluses and pauses, flagged with `source: 'system'`.

### TCI Conflict Rules

When a TCI scheme is planned, the planner clears future TCI events and inserts the new scheme. Manual events (rate changes, boluses) interrupt TCI mode.

## Simulation Facade (`js/sim/simulation.js`)

`createModel()` returns a stateless facade that wraps the event list and PK engine. Key methods:

- `setPatient(demographics)` — configures Eleveld parameters
- `planTCI(drugId, time, ceTarget, { tciMode })` — generates and inserts a TCI scheme
- `getConcentrationsAt(drugId, time)` — replays events to get Cp, Ce, rate at any time
- `getEvents(drugId)` — returns the event list

The facade selects the planner based on `tciMode`: stepped, cet, cet-conservative, or cet-emulation.

## Pump Settings (`js/util/constants.js`)

Runtime-configurable pump parameters:
- `concentration` — 10 mg/mL (1%) or 20 mg/mL (2%)
- `bolusRateMlH` — max pump rate: 750, 1000, or 1200 mL/h
- `maxRate` — derived: `bolusRateMlH * concentration / 60` (mg/min)

Persisted to localStorage. Accessed via `getPumpSettings(drugId)` / `setPumpSettings(drugId, opts)`.

## SimTIVA Reference Module (`js/sim/simtiva-reference.js`)

Clean-room reimplementation of SimTIVA's eigenvalue-based computations, used by the CET planners:

- `computeUDFs(pkParams, deltaSec)` — eigenvalue decomposition via `cube()` solver, produces `p_udf` (Cp unit dose function, 21600 entries), `e_udf` (Ce unit dose function), `p_coef`, `e_coef`, `lambda` arrays
- `computeSimTIVACETBolus(pkParams, ceTarget, opts)` — CET bolus with rate correction factor
- `computeRateCorrFactor()` — SimTIVA's `scheme_bolusadmin` correction formula

**This module does NOT import SimTIVA's GPL-3.0 code.** It is a mathematical reimplementation of the same pharmacokinetic algorithms.

## UI Architecture

Single-page app with two screens (setup and simulation), no framework. All UI modules are ES modules that export `init()` functions called from `app.js`.

- Setup screen: patient demographics, pump configuration, TCI mode selection
- Sim screen: drug panel (Ce/Cp display), chart (Chart.js), history panel, keypad modal, event editor modal
- Timer: elapsed time with optional wall-clock sync, dual-mode popover
- History: all events visible including system events (dimmed italic), tappable timestamps toggle ET/RT
