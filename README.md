# TCI Sim

A mobile-first progressive web app for anesthesia training, focused on pharmacokinetic/pharmacodynamic simulation of propofol Target-Controlled Infusion (TCI).

**⚠️ Simulation only — not a medical device. Do not use to guide clinical drug administration.**

## Features

- **Eleveld 2018 propofol PK-PD model** (BJA 120(5):942-959 + corrigendum BJA 121(2):519)
- **Four TCI planning modes:**
  - Stepped — conservative rate-stepping approach
  - CET — exact peak Ce-matching bolus
  - CET (Conservative) — SimTIVA-style rate-corrected bolus
  - CET (Emulation) — ported SimTIVA `deliver_cpt` algorithm with eigenstate-based maintenance
- **Realistic pump delivery** simulation (configurable max rate 750-1200 mL/h)
- **Event history** with add/edit/delete, TCI conflict rules, manual rate and bolus support
- **Real-time chart** with Cp, Ce, and BIS curves
- **Opioid co-administration** toggle (affects Eleveld PK and PD parameters)
- **BIS prediction** via Eleveld PD model (Ce50, sigmoid Emax)
- **Pump configuration:** concentration (1%/2%), max pump rate, opioid toggle

## Getting Started

No build step required. Serve the project directory with any static file server:

```bash
# Python
python3 -m http.server 8080

# Node
npx serve .
```

Open `http://localhost:8080` on a mobile device or browser.

## Running Tests

```bash
node tests/run-tests.js
```

## Project Structure

```
tci-sim/
├── index.html                    # Single-page app (setup + sim screens)
├── manifest.json                 # PWA manifest
├── js/
│   ├── app.js                    # Main application controller
│   ├── app/
│   │   ├── settings-ui.js        # Settings modal DOM wiring
│   │   ├── tci-modal.js          # TCI delay + first-step countdown modals
│   │   ├── session.js            # Case save / restore / new case
│   │   └── chart-bridge.js       # Chart refresh, BIS overlay, per-frame updates
│   ├── version.js                # APP_VERSION — single source of truth
│   ├── pk/
│   │   ├── eleveld.js            # Eleveld 2018 parameter calculation
│   │   ├── engine.js             # Matrix-exponential PK engine
│   │   ├── pd.js                 # PD model (BIS prediction)
│   │   ├── decay-predictor.js    # Context-sensitive decrement times
│   │   ├── fentanyl.js           # Fentanyl PK parameters
│   │   ├── ketamine.js           # Ketamine PK parameters
│   │   └── steady-state-predictor.js # Analytical SS + plateau detection
│   ├── sim/
│   │   ├── simulation.js         # Stateless model facade
│   │   ├── events.js             # Re-export shim → events/
│   │   ├── events/
│   │   │   ├── index.js          # Event list orchestrator + facade
│   │   │   ├── delivery.js       # Bolus delivery math
│   │   │   ├── replay.js         # Per-drug engine replay
│   │   │   ├── list-ops.js       # CRUD + clear operations
│   │   │   ├── query.js          # Concentration queries + curve sampling
│   │   │   └── actions.js        # findActiveBolus + add/edit/delete
│   │   ├── tci-planner.js        # Re-export shim → tci/
│   │   ├── tci/
│   │   │   ├── index.js          # Barrel re-export + planTCIFromEvents
│   │   │   ├── shared.js         # Config, quantizers, findMaintenanceRate
│   │   │   ├── stepped.js        # Stepped planner (conservative)
│   │   │   ├── cet.js            # CET planner (fast onset)
│   │   │   ├── cet-conservative.js # CET Conservative (rate-corrected)
│   │   │   └── emulation.js      # CET Emulation (SimTIVA port)
│   │   └── simtiva-reference.js  # UDF computation, rate correction
│   ├── ui/
│   │   ├── setup.js              # Patient/pump configuration screen
│   │   ├── patient-modal.js      # Patient demographics modal + inline keypad
│   │   ├── chart.js              # Re-export shim → chart/
│   │   ├── chart/
│   │   │   ├── index.js          # Chart.js wrapper — curves, overlays, setters
│   │   │   ├── annotations.js    # Annotation rebuild (bands, lines, cursor)
│   │   │   ├── gestures.js       # Touch/mouse: Y-drag, dbl-tap, inspect-handle drag
│   │   │   ├── state.js          # Shared chart state object
│   │   │   └── plugins/          # afterDraw plugins (target-label, cursor-dots,
│   │   │                         #   inspect-dots, inspect-handle, readout-panel,
│   │   │                         #   event-markers)
│   │   ├── history.js            # Event history panel
│   │   ├── event-editor.js       # Unified event editor modal
│   │   ├── keypad.js             # Numeric keypad modal
│   │   ├── timer.js              # Elapsed time / wall clock
│   │   ├── controls.js           # Start/pause pump controls
│   │   ├── mode.js               # TCI/manual mode tracking
│   │   ├── drug-panel.js         # Re-export shim → drug-panel/
│   │   ├── drug-panel/
│   │   │   ├── index.js          # rAF loop, update(), public getters
│   │   │   ├── approach.js       # Approach line computation + rendering
│   │   │   ├── step-bar.js       # Step bar progress + countdown
│   │   │   ├── exit-readout.js   # Emergence countdown line
│   │   │   └── formatters.js     # Display formatting helpers
│   │   ├── settings.js           # Settings & event warning system
│   │   ├── alert-sound.js        # AudioContext; playAlert(level)
│   │   └── persist.js            # LocalStorage case save/restore
│   ├── app/
│   │   ├── settings-ui.js        # Settings modal wiring
│   │   ├── tci-modal.js          # TCI delay + first-step countdown modals
│   │   ├── session.js            # Case save / restore / new case
│   │   ├── chart-bridge.js       # Chart refresh + per-frame settings push
│   │   └── portrait-layout.js    # Dynamic grid-row sizing on portrait tablet
│   └── util/
│       ├── constants.js          # Drug config, DRUG_IDS, pump settings
│       ├── math.js               # Matrix-exp, eigenvalue utilities
│       └── units.js              # Unit conversion helpers
├── tests/
│   ├── run-tests.js              # Test runner (512 tests, 15 suites)
│   └── test-*.js                 # Test suites
└── _legacy/                      # Archived legacy code
```

## Documentation

- [ARCHITECTURE.md](ARCHITECTURE.md) — PK engine, event system, planner architecture
- [TCI-PLANNERS.md](TCI-PLANNERS.md) — Four planner modes explained with validation data
- [DEVELOPMENT.md](DEVELOPMENT.md) — Session history, known issues, roadmap
- [LICENSE-NOTES.md](LICENSE-NOTES.md) — GPL/clean-room implementation notes

## Validation

PK engine validated against SimTIVA (by Terence Luk) to **0.0000% Cp deviation** across all Eleveld patient archetypes. PD model validated against published Eleveld 2018 Ce50 values and TivaTrainer DiY4 spreadsheet.

The CET Emulation planner produces maintenance rate schemes that match SimTIVA's step values and timing from interval 2 onward (56, 51, 47 mL/h at identical time points for the reference 35y M patient).

## Credits

- **Eleveld 2018 model:** Eleveld DJ, et al. BJA 2018;120(5):942-959
- **SimTIVA:** Terence Luk — used as PK validation reference only (GPL-3.0, not imported)
- **TivaTrainer DiY4:** PD validation reference
