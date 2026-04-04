# TCI Sim — Session History

Detailed session-by-session development log. For current project state, see DEVELOPMENT.md.

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

*CET planner:* New planTCISchemeCET function — SimTIVA-style Ce-targeting. Calculates CET bolus where peak Ce (after pump-rate delivery + zero-rate pause) = target. ~2.5× larger bolus than stepped planner (141mg vs 57mg for Ce=3.0). Reaches 99% of target in 3.1 min vs >30 min. Activated via `{ tciMode: 'cet' }` in planTCI config. Target decreases use same decay-wait logic as stepped planner.

*SimTIVA reference module:* Ported SimTIVA's UDF calculation, rate_corr_factor, and CET bolus formula to simtiva-reference.js. Validated against SimTIVA screenshot: our calculation gives 126mg vs SimTIVA's 128mg (1.3% difference). SimTIVA intentionally under-doses by ~9% via rate_corr_factor (0.915 at 700 mL/h) — deliberate design choice for gentler hemodynamics. Module exports computeSimTIVACETBolus, computeRawCETBolus, computeUDFs for testing/comparison.

262 tests, all passing.

**Session 8 (2026-04-02 to 2026-04-04):** TCI planner refinement and CET Emulation mode.

*CET/CET(C) improvements:* Analytical pause timing from UDF peak time (within 1 second). Conservative mode step-up bug fixed (now uses binary search + correction ratio for existing drug). Small adjustment threshold removed for emulation mode. No spurious pauses in maintenance. `findMaintenanceRate` dual-constraint search. ke0-derived lookahead.

*CET Emulation planner (4th mode):* Direct port of SimTIVA's `deliver_cpt` algorithm. First pass: 180 × 120s intervals, analytical Cp-targeting formula. Second pass: 8% threshold + 0.667 weighted average + 1 mL/h rounding + wait_peak averaging. Dynamic threshold/avgfactor based on early maintenance rate.

*Eigenstate decomposition:* Cp 3×3 Cramér's rule for maintenance; Ce 4×4 Gaussian elimination for step-up bolus. Both exact (zero error at sample points). Replaces rough proportional split.

*CET step-up algorithm (ported from SimTIVA):* `trialDose = (target - vmCe(e_state, peak)) / e_udf[peak]`, iterative find_peak, rate correction applied. 0% overshoot, <1 min to 95% on step-ups.

*Bug fixes:* p_udf extended to 21600s; bolus rounding Math.round; dynamic threshold/avgfactor; eigenstate replay in integer seconds.

Final performance (35y M, 1000 mL/h, 0→3.0): RMSE 7.4% vs SimTIVA's 1.5%, gap entirely in first 2-3 steps.

262 tests, all passing.

**Session 9 (2026-04-04):** Four fixes from Rev 6 external handoff analysis, validated by quantitative comparison across 6 patients × 4 Ce targets × 3 pump rates (n=72).

*Fix 1 — `computeRateCorrFactor` mechanistic replacement:* Old linear formula produced mean Ce peak error −8.4%, worst case −21.6% (120 kg patient, Ce=5, 700 mL/h). Replaced with patient-specific UDF simulation: second-by-second Ce simulation during delivery, binary search for the duration where peak Ce matches target. New mean error −1.9%, worst case −7.2%. Function signature changed — now takes `e_coef[]` and `lambda[]`; call site in `computeSimTIVACETBolus` updated.

*Fix 2 — `eudf` peak search ceiling 1000 → 3600:* No impact for propofol (peak_time 163–194s). Future-proofs for slow ke0 drugs.

*Fix 3 — Ce-boost eigenstate sync in emulation planner:* `ps1/ps2/ps3` was not updated after Ce-boost engine advances. Extracted `refitEigenstate()` inner function (Cramér's rule 3-sample refit); called after each Ce-boost interval. Without fix: first Cp-targeting step overestimated by ~10–15 mL/h.

*Fix 4 — Bolus rounding mL-first:* Old code rounded to nearest 1 mg. New code rounds to nearest mL then converts (nearest 10 mg at 10 mg/mL). Differences 6–67 mg across patients. Matches SimTIVA line 4702.

262 tests, all passing.

**Session 10 (2026-04-04):** UI polish, bug fixes, and chart improvements. Version 0.4.1.

*Bug fixes:*
- Zoom snap-back fixed — `setCurveData` now writes `chart.options.scales.x.min/max = viewMin/viewMax` before each `chart.update()` so a pinch-zoomed view survives data refreshes.
- Manual pump stop during TCI pause — the guard `if (conc.rate === 0) return` was blocking the Stop Pump button when TCI had a scheduled `rate=0` interval. Changed to `if (conc.rate === 0 && mode !== 'tci') return`; button now correctly clears all future TCI events and stops the pump.

*Chart improvements:*
- Ce Target annotation label relocated to right margin (added `layout: { padding: { right: 65 } }` to chart options; changed annotation `position: 'start'` → `'end'` with `xAdjust: 5`). Label appears in the margin, not over active curve data.
- BIS nomogram completely rewritten. Previous bands had inverted `ceMin/ceMax` (ceForBIS returns a Ce value; lower BIS = more drug = higher Ce, so ce20 > ce40 > ce60 > ce85 numerically — the old `{ ceMin:0, ceMax:ce20 }` "Deep Anesthesia" band spanned the entire clinical Ce range and obscured everything else). New bands use correct Ce thresholds: Red (Light Sedation BIS 80–90), Orange (Deep Sedation 60–80), Yellow (GA 40–60), Green (Deep Anesthesia 20–40). Alpha increased from hex `18` to `30` (9% → 19%) for visual distinction.
- Tooltip: added `Rate: X.X mcg/kg/min` line between Ce/Cp values and BIS. Chart gains `setPatientWeight(kg)` method for the conversion; weight is supplied from `initSimScreen`.

*UI labels:*
- Pump control button: "Pause Pump" → "Stop Pump".
- Drug panel status: TCI with `rate=0` → "Paused" (future TCI events pending); manual `rate=0` → "Pump Stopped" (no further instructions).
- History panel: TCI `rate=0` events → "Paused [TCI badge]"; `pause`-type events → "Pump Stopped".

307 tests across 10 suites, all passing.
