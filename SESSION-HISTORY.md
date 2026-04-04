# TCI Sim — Session History

Detailed session-by-session development log. For current project state, see HANDOFF.md.

---

**Session 1 (2026-03-19):** Initial architecture design, PK engine implementation (math.js, eleveld.js, engine.js, pd.js), simulation state machine, history logger, UI shell (index.html), 27 PK tests + 17 sim tests passing. Began cross-validation against SimTIVA — discovered 5 parameter discrepancies.

**Session 2 (2026-03-20, first context):** Deep dive into SimTIVA's pharmacology.js. Designed and built event-driven architecture (events.js), multi-drug support, TCI scheme planner (tci-planner.js), decay predictor (decay-predictor.js), intermittent bolus mode. Detailed parameter-level discrepancy analysis. 27 event tests + 15 decay tests + 16 scheme tests passing. Began writing cross-validation test file.

**Session 3 (2026-03-20, second context):** Completed cross-validation (test-vs-simtiva.js). Parameters match at 0.0000%, concentration curves within 1.31% (bolus) and 0.000% (infusion). Added t=0 edge case tests (40 tests), unit safety tests with parameter validator (18 tests). Rewrote simulation.js from tick-based to event-driven architecture with all three administration modes. Made simulation controller drug-agnostic (primaryDrug config instead of hardcoded propofol). Renamed tci.js → tci-legacy.js, test-sim.js → test-sim-legacy.js. Created handoff journal and updated architecture doc. 212 tests across 8 suites, all passing.

**Session 4 (2026-03-21):** Fixed two critical PD bugs via cross-validation against TivaTrainer DiY4 and Eleveld 2018 paper: (1) Ce50 aging coefficient -0.0517 → -0.00635, (2) gamma split swapped 1.47/1.89 → 1.89/1.47. Fixed test-suite V3 opioid formula bug. Refactored to stateless architecture: removed tick loop, state machine, and event status from simulation.js and events.js. Events are now pure pump commands with `clearAfter(drugId, time)` replacing `clearPlanned()`. simulation.js provides `createModel()` — a pure command/query interface. Mode tracking, display timer, and annotations move to app.js (Phase 2). Added PD validation tests, model tests, and end-to-end integration tests (setPatient → planTCI → computeCurve → curve shape validation). Moved legacy files to `_legacy/` directory. Marked history.js as dead code (superseded by computeCurve). Fixed stale PD equations in architecture doc Section 4.5. Rewrote Sections 6, 9, 11, 12, 14 of architecture doc and Sections 3, 7, 8, 9 of handoff to reflect stateless design. 223 active tests across 8 suites, all passing.

**Session 5 (2026-03-24):** Phase 2 UI integration — completed Steps 1 through 4. Step 1: app.js entry point + setup.js (replaced inline calcCe50/calcFFM with real eleveld.js, fixed select change event, fixed duplicate DOM IDs). Step 2: timer.js + controls.js (timer never pauses — "Pause" means pause pump, not time). Step 3: units.js (pure bidirectional conversion, 39 tests, all drugs), keypad.js (using units.js), mode.js (per-drug mode tracking), constants.js extended with DRUG_DEFS and DRUG_TASK_UNITS. Shim eliminated — zero inline onclick handlers remain. Step 4: drug-panel.js (rAF loop reading live Ce/rate/BIS from model). Deployed to Vercel throughout, debugged module loading and DOM issues. 262 active tests across 9 suites, all passing. Chart integration (Step 5) next.

**Session 5 continued (2026-03-25):** Step 5: chart.js — reusable TciChart component with Cp (red) / Ce (blue) curves, BIS nomogram overlay, X pinch zoom, Y finger-drag scaling, cursor, target line, tooltip toggle, double-tap recenter, reset button. CDN: Chart.js 4, annotation 3, zoom 2, Hammer.js 2. persist.js — auto-save to localStorage after every model mutation, restore last case from setup screen. Pre-start plan mode with execution-time-based offsets (bolus offset = delivery duration at 750 mL/h pump rate). Keypad redesign: double-width 0, C/⌫ separated row, no OK. Drug panel: Cp (red, smaller) below Ce, rate uses preferred unit, BIS shown. Duplicate pause guard. "Now" button in timer popover. Forward calculation 120 min buffer. bolusDeliveryMinutes() helper in constants.js. Architecture doc updated to v0.6.0. 262 tests across 9 suites, all passing.

**Session 6 (2026-03-26):** Realistic bolus delivery model — complete implementation. events.js: replaced all 10 hardcoded 0.05 min references with `advanceBolus()`/`getBolusDelivery()`. Added `drugConfigs` registry (`registerDrugConfig`), `PUSH_DURATION` constant (10 sec). `addBolus()` accepts `deliveryMode: 'pump'|'push'` and `source`. tci-planner.js: replaced 3 hardcoded 0.05 refs with `plannerBolusDelivery()`. `calculateLoadingBolus()` binary search now delivers at pump rate. simulation.js: imports DRUG_DEFS, registers drug config on init/setPatient, passes bolus config to planner, marks TCI boluses `source:'tci'`. Curve rendering rewrite: `computeCurve()` tracks active bolus delivery state, steps through at sample resolution. `getConcentrationsAt()` handles mid-delivery queries. Bolus overlap handling: `findActiveBolus()` with deferral, merge, and rate-restore recomputation. Push Bolus UI button. Bolus unit persistence and dose memory (canonical mg in localStorage). 262 tests, all passing.

**Session 6 continued (2026-03-26 to 2026-03-30):** Phase 4 event history panel — complete implementation. history.js: renders all events including dimmed system events, ET/RT timestamp toggle, edit buttons. event-editor.js: unified modal for add/edit/delete with type selector, H:MM time selects (Case/Real), built-in keypad, pause duration, TCI conflict rule engine (Rules 2a/2b/3a/3b/4/5). Keypad: unified 4-column grid (C/⌫ left of 1 and 0), prefill-override behavior, oneShotConfirm mechanism. Bolus labels: "Pump Bolus" (#7c3aed) and "IV Push" (#a78bfa). Event overlap: addRate/addPause remove system rate-restores at exact bolus end time. Timed pause: captures pre-pause rate, system-flagged restore, overflow handled silently. editEvent: supports source and deliveryMode changes. Time standardization: H:MM:SS display, H:MM editing. Timer popover: dual Start Time / Elapsed Time mode with getWallClockStart() export. 262 tests, all passing.

**Session 7 (2026-03-30):** UI polish and TCI planner work.

*UI fixes:* Event editor keypad layout unified with main keypad (4-column grid, C/⌫ next to 1 and 0). Pause duration selects populated; overflow silently treated as "until next event". System events (rate-restores) visible in history as dimmed italic rows with ↩ prefix, all events editable. Timed pause rate-restore captures pre-pause rate before inserting pause, flagged as system. addRate/addPause remove system rate-restores at exact bolus end time (boundary collision fix). editEvent supports deliveryMode field changes. Bolus labels: "Pump Bolus" (#7c3aed) / "IV Push" (#a78bfa). Keypad prefill-override: typing on pre-filled value clears it first. Time standardization: H:MM:SS display, H:MM editing. Timer popover dual mode (Start Time / Elapsed Time).

*Pump settings:* Runtime pump settings system in constants.js (getPumpSettings/setPumpSettings with auto-derived maxRate). Setup screen Pump Configuration section with concentration (1%/2%) and max pump rate (750/1000/1200 mL/h) selects. Settings persist in localStorage, used by simulation.js init/setPatient/planTCI and events.js drug config.

*TCI planner — target decrease fix:* Added "decay wait" phase to planTCIScheme. When Ce > upperBound, sets rate=0 and advances until Ce decays to tolerance band before entering maintenance rate search. Fixes: 4.5→2.0 now reaches target in ~15 min (was 30+ and drifting); 3.0→1.0 now catches and holds (was decaying to zero).

*CET planner:* New planTCISchemeCET function — SimTIVA-style Ce-targeting. Calculates CET bolus where peak Ce (after pump-rate delivery + zero-rate pause) = target. ~2.5× larger bolus than stepped planner (141mg vs 57mg for Ce=3.0). Reaches 99% of target in 3.1 min vs >30 min. Activated via { tciMode: 'cet' } in planTCI config. Target decreases use same decay-wait logic as stepped planner.

*SimTIVA reference module:* Ported SimTIVA's UDF calculation, rate_corr_factor, and CET bolus formula to simtiva-reference.js. Validated against SimTIVA screenshot: our calculation gives 126mg vs SimTIVA's 128mg (1.3% difference). SimTIVA intentionally under-doses by ~9% via rate_corr_factor (0.915 at 700 mL/h) — deliberate design choice for gentler hemodynamics. Module exports computeSimTIVACETBolus, computeRawCETBolus, computeUDFs for testing/comparison.

*Performance comparison:* Three-way analysis (Stepped vs CET vs SimTIVA) documented in TCI-PLANNER-COMPARISON.md. CET matches SimTIVA onset curves exactly through 3.5 min. Key difference is SimTIVA's rate correction producing ~9% smaller bolus.

262 tests, all passing.

## Session 8 — TCI Planner Refinement & CET Emulation

### CET Planner Improvements
- **Analytical pause timing**: CET(C) mode now uses SimTIVA's UDF-derived peak time instead of forward-scanning. Pause timing matches SimTIVA within 1 second.
- **First maintenance rate match**: Initial rate now matches SimTIVA within 1-2 mL/h (70 vs 71 for 60y F case).
- **Target step-up bug fixed**: Conservative mode was computing bolus from zero state via UDF formula — now uses binary search for existing drug + rate correction ratio.
- **Small adjustment threshold**: When Ce ≥ 80% of new target, skips bolus-pause and does rate-only adjustment.
- **No spurious pauses**: Maintenance loop never emits rate=0. Drift above band → lower rate (not pause).
- **findMaintenanceRate dual-constraint**: Endpoint search + peak search, returns min. When Ce > target, uses endpoint-only to bring Ce back down.
- **ke0-derived lookahead**: `3 × ln(2) / ke0` replaces empirical constant. 13-16 min for propofol.

### CET Emulation Planner (4th mode)
Ported SimTIVA's two-pass algorithm:
- **First pass**: 180 intervals × 120 seconds (6 hours). First interval uses Ce-targeting binary search (matching SimTIVA's CET→CPT handoff). Subsequent intervals use SimTIVA's analytical Cp-targeting formula: `rate = (target - trialCp) / p_udf[120] × 60`.
- **Second pass**: Step extraction via 8% rate-change threshold + 0.667 weighted average + 1 mL/h rounding. Minimum 10-minute step spacing.
- **Loading**: Same CET bolus + analytical pause as CET(C).
- **p_udf**: Added to `computeUDFs` in `simtiva-reference.js`.

### Results (CET Emulation vs SimTIVA)
60y F, 70kg, 145cm, opioid, Ce=4.5, 700 mL/h:
- First rate: 71 vs 70 mL/h ✓
- Step count: 10 vs 5 (more granular)
- Ce max overshoot: +8.3%
- Ce min undershoot: -14.9%

35y M, 70kg, 170cm, Ce=3.0, 700 mL/h:
- First rate: 64 vs 62 mL/h ✓
- Step timing at 12m: 62 vs 56 mL/h
- Late rates converge: 40 @ 5h12m vs 40 @ 5h10m ✓

### Session 8 (continued) — CET Emulation Planner Fixes

#### Eigenstate Decomposition (Cramer's Rule)
- **Cp eigenstate** (3×3): sample Cp at 3 future times at rate=0, solve via Cramer's rule. Zero error. Used for maintenance rate computation.
- **Ce eigenstate** (4×4): sample Ce at 4 future times, solve via Gaussian elimination with partial pivoting. Zero error. Used for CET step-up bolus computation.
- Replaces rough proportional split (50/35/15%) that caused massive errors on second target changes.

#### CET Step-Up Bolus Algorithm (ported from SimTIVA)
- Uses Ce eigenstate decomposition to predict where Ce will decay to at peak_time
- `trialDose = (target - vmCe(e_state, peak)) / e_udf[peak]` — accounts for existing drug
- Iterative `find_peak` adjusts peak_time for the computed dose
- Applies rate correction factor from `computeSimTIVACETBolus`
- Result: 3.5→4.0 gives 38mg bolus (SimTIVA: 33mg), reaches 95% in 0.8 min, 0% overshoot

#### No Bolus Threshold for Emulation Mode
- SimTIVA ALWAYS gives a bolus for CET target increases — no 80% threshold
- Emulation planner now matches: `needsBolus = currentCe < ceTarget * (1 - tolerancePct)`
- Eliminates the slow 20-minute rate-only approach for small step-ups

#### Ce-Targeting Boost for Rate-Only Step-Ups (other planners)
- First 3 intervals use 5-minute Ce-targeting binary search
- Falls back to Cp-targeting after 6 minutes
- Reduces time to 95% from 20 min to 8 min for CET/CET(C) modes

#### Bug Fixes from External Analysis
1. p_udf extended to 21600 seconds (was 1000)
2. Bolus rounding: Math.round to match SimTIVA line 4702
3. Dynamic threshold/avgfactor based on early maintenance rate
4. Eigenstate replay in integer seconds (no minute/second mixing)

#### Final Performance (35y M, @1000 mL/h)
| Scenario | Steps | RMSE | Peak Overshoot |
|---|---|---|---|
| 0→3.0 | 6 | 7.4% | +15% |
| 3.5→4.0 step-up | 5 | — | +0% |
| 3.5→4.5 step-up | 5 | — | +0% |
| 3→4→3→4.5 rapid | — | — | Ce@30m=4.51 |
