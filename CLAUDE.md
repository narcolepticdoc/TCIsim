# TCI Sim — Claude Code Reference

Mobile-first PWA for anesthesia training. Simulates propofol pharmacokinetics using the Eleveld 2018 model with Target Controlled Infusion (TCI) planning.

## Key Files

```
js/version.js             APP_VERSION — single source of truth, edit here to bump the version
js/pk/eleveld.js          Eleveld 2018 PK-PD parameter calculator
js/pk/engine.js           Matrix-exponential PK engine (4×4, arbitrary time steps)
js/sim/events.js          Event list — source of truth for all pump commands
js/sim/simulation.js      Stateless facade: setPatient, planTCI, getConcentrationsAt
js/sim/tci-planner.js     Four TCI planners (stepped, CET, CET-conservative, emulation)
js/sim/simtiva-reference.js  SimTIVA eigenvalue math (clean-room, no GPL code)
js/util/constants.js      DRUG_DEFS, pump settings (getPumpSettings/setPumpSettings)
js/util/units.js          Bidirectional unit conversion
js/ui/warnings.js         Two-tier event warning system (prep pulse + alert popup)
js/ui/alert-sound.js      Persistent AudioContext; unlockAudio() + playAlert(level)
js/app.js                 Entry point, wires all modules
```

## Architecture in One Paragraph

The engine stores compartment amounts as a `Float64Array[5]` and advances via matrix exponential — any step size, no accumulation error. The event list (bolus/rate/pause) is the source of truth; concentrations at any time are computed by replaying events through the engine. `simulation.js` is a pure command/query facade — no internal clock or state machine. The UI owns time display and playback. TCI planners generate arrays of `{type, time, value}` events that get inserted into the event list.

## Invariants — Do Not Break

- **Engine time unit is minutes.** `simtiva-reference.js` converts internally to seconds; everything else in the codebase uses minutes. Do not change this.
- **`findActiveBolus` uses strict less-than boundaries.** Boundary-collision bugs (e.g. a rate change at the exact end of a bolus) require explicit scans in `addRate`/`addPause` — do not rely on `findActiveBolus` alone.
- **Cramér's rule is the eigenstate pattern.** When syncing SimTIVA eigenstate (`ps1/ps2/ps3`) to engine reality, use the 3-sample Cramér's rule refit (`refitEigenstate()`). Do not use second-by-second replay.
- **System events must stay visible.** Rate-restore events (`source: 'system'`) are shown in history as dimmed italic rows. Do not filter them from the UI — users need to see and delete them.
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
getPumpSettings('propofol')   // { concentration, bolusRateMlH, maxRate }
setPumpSettings('propofol', { concentration: 10, bolusRateMlH: 750 })
```

`maxRate` is auto-derived as `bolusRateMlH * concentration / 60` mg/min. Persisted to localStorage. Always read pump settings from `getPumpSettings` — never hardcode 750 or 10.

## Running Tests

```bash
node tests/run-tests.js
```

Test files live in `tests/test-*.js`. The runner executes all of them and prints a pass/fail summary. 359 tests across 12 files, all passing. Cross-validation against SimTIVA at 0.0000% Cp deviation.

## Docs

- `ARCHITECTURE.md` — engine, event system, module responsibilities
- `TCI-PLANNERS.md` — planner algorithms, validation data, remaining gaps
- `DEVELOPMENT.md` — complete session log, known issues, roadmap (single source of truth)
- `LICENSE-NOTES.md` — clean-room implementation notes, file audit
