# TCI Sim — Session History

Detailed session-by-session development log. For current project state, see DEVELOPMENT.md.

---

**Session 19 (2026-04-06):** Ce overshoot fix for CET Emulation planner — mid-range step-ups. Version 0.5.4. Two targeted changes to `planTCISchemeEmulation` in `js/sim/tci-planner.js`. Fix 1 (`cpOvershoot` guard): when a bolus was delivered and `cpAtMaint > ceTarget × 1.02` at maintenance start, use 2 Ce-boost intervals before Cp-targeting. Root cause: the `correctionRatio` inflates the bolus beyond what the analytical pause duration accounts for, leaving Cp above ceTarget at maintenance start; the Cp-targeting eigenstate then schedules infusion while Ce is still equilibrating upward, producing a ~4.125 peak at ~1 hour on a 3.5→4.0 step-up. The Ce-boost intervals directly constrain Ce via binary search, preventing the overshoot. Fix 2 (dynamic `stepMagnitude` threshold): for step-ups where `(ceTarget − Ce₀) / ceTarget ≤ 0.20` (small steps, e.g. 3.5→4.0), use 5% threshold / 0.62 avgfactor in the second-pass step extraction even when early maintenance rate ≥ 30 mL/h. The 8% threshold missed the slow V3-equilibration decline (4–6% over hours), causing Ce to drift to ~4.155 by 4 hours. Uses existing `currentCe` (captured at plan start) — no new variable needed. All 359 tests pass. Branch: `claude/fix-ce-overshoot-DdsF1`.

---

**Session 18 (2026-04-06):** Drug card polish and intermittent UX. Version 0.5.3. Fix: event editor `setDrug()` not called on drug card switch — edit buttons silently failed for fentanyl/ketamine. Fentanyl mcg precision: `toFixed(0)` → `toFixed(1)`, allowing 12.5 mcg to round-trip without display rounding. Non-selected drug card approach line generalised to all modes: added `_computeApproachFromCurve()` and `_nonSelectedApproachCache` so TCI countdowns, emergence timers, and manual steady-state lines now appear on deselected cards; added `getCeTargetForDrug` callback. "Redose now" renamed "Below Threshold" with amber pulsing animation; one-shot chime on above→below transition via `warnings.checkBelowThreshold()`; new `redoseSound` pref in settings modal. Intermittent countdown moved from approach line to step-bar-countdown (matching TCI step-bar style); approach line reserved for "Below Threshold" flash only. `_intermittentBarPct()` helper fills step-bar from last-bolus to predicted threshold-crossing (was hardcoded 0%). Bug fix: `_nonSelectedCache` now includes `threshold` in key — changing redose threshold without adding events no longer returns stale countdown. Visual hierarchy: approach line and step-bar-countdown promoted from `text-muted` to `text-secondary`; `.step-bar-countdown .appr-time` amber rule added. 359 tests across 12 suites, all passing.

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

*Follow-up fixes (same session, version 0.4.2):*
- Pinch-zoom triggered `recenter()` on finger lift — a pinch fires two `touchend` events (one per finger) within <50ms; the second was being treated as a double-tap. Fixed with `wasMultiTouch` flag: skips double-tap detection after any multi-touch gesture; `lastTap` is not updated on pinch-end so the window stays anchored to the last genuine single tap.
- Auto-scroll fired mid-pinch — `onZoomStart` callback added to set `autoScroll = false` immediately when the pinch begins, before any animation-frame `setCursorTime` call could fire `zoomScale` with stale `viewMin/viewMax`. `onPanStart` and `onPanComplete` also extended to sync `viewMin/viewMax`.
- Ce target label clipped — annotation plugin labels are clipped to the chart area; replaced with an `afterDraw` canvas plugin that draws directly to the 2D context in the 65px right-margin padding.
- Nomogram bands in wrong order — `ceForBIS(N)` returns the Ce concentration required to achieve BIS=N; because more drug lowers BIS, `ce20 > ce40 > ce60 > ce90`. Bands reordered to ascending Ce: `[ce90→ce80]` Red (Light Sedation), `[ce80→ce60]` Orange (Deep Sedation), `[ce60→ce40]` Yellow (GA), `[ce40→ce20]` Green (Deep Anesthesia).
- Syntax error from inline `plugins` array added at wrong indentation level inside Chart constructor config object.
- Extracted `APP_VERSION` to `js/version.js` — single source of truth; `constants.js` re-exports it. Only `version.js` needs updating on future releases.

**Session 12 (2026-04-05):** Drug panel redesign. Version 0.4.11.

*Drug color strip:* Active card left border uses `--drug-color` CSS variable. Propofol/Ketamine = yellow; Fentanyl/Remifentanil = blue. Step bar inherits drug color.

*Combined Cp/Ce row:* Ce (22px) and Cp (11px) merged onto one baseline row, separated by a dim `|`. Removed `drug-cp-row` and `ce-target-display` span.

*Status + rate inline:* Four pump-state labels only — `Infusing` (green), `Bolus` (green + step-blink), `Paused` (amber), `Stopped` (red). Rate shown inline to the right; standalone `drug-rate` div removed. Bolus detection uses event list `type === 'bolus'` first, rate-heuristic fallback.

*Approach/countdown line:* New `drug-approach` element (throttled to 500ms). TCI running → time to reach target via 30-min curve scan. TCI at target → "At Target". Manual infusion → steady state Ce and time (see below). Pump stopped → "Emergence Ce 1.5 in m:ss" via `model.predictTrough`. Emergence threshold named constant `EMERGENCE_CE = 1.5`.

*BIS color coding:* Dynamic color per reading, matching chart nomogram bands exactly: >90 muted (awake), 80–90 `#ef4444` red (Light Sedation), 60–80 `#f97316` orange (Deep Sedation), 40–60 `#eab308` yellow (GA), 20–40 `#22c55e` green (Deep Anesthesia), <20 `#a855f7` purple (Very Deep). Initial commit had mismatched colors; corrected in follow-up.

*Step bar + countdown:* `step-bar-countdown` text element (m:ss, right-aligned) above bar. `updateStepBar` scans event list each frame for prev/next events, computes fill %, shows remaining time.

*Steady state definition (follow-up fix):* Initial approach (95% of Ce at 150 min) could fire immediately if Ce was already near its plateau. Replaced with rate-of-change criterion: first point where Ce changes < 0.05 mcg/mL over a 5-minute window. Clinically: "the number has stopped moving".

*Approach line update architecture (follow-up fix):* Baked-HTML approach caused the countdown to freeze between 500ms recomputes. Refactored: `computeApproachData` returns `{ prefix, arrivalMin, staticText }`; `updateApproachLine` computes `arrivalMin − t` live every rAF frame so the countdown ticks smoothly. Expensive recompute throttled to 5 s; invalidated immediately on mode/rate/target change and on threshold crossing.

*Steady state display Ce stability fix:* During rapid Ce changes, 5 s recomputes hit different engine states, shifting the 150-min `ssCe` projection and causing the label to jump. Fixed with `lockedSsCe` in the cache: the display Ce value is only reset on mode/rate/target change or `forceUpdate`, never on the time-based recompute. Countdown still updates every 5 s.

*Steady state Ce value corrected to stability point:* `ssCe` was taken from `curve[last].Ce` (Ce at t+150 min — long-term PK equilibrium), while `ssMin` was the time to first local stability by the rate-of-change criterion (typically a few minutes). Mismatched values produced displays like "Steady state ≈ 4.7 in 1:58" when Ce would actually be ≈ 3.8 at the 2-minute mark. Fixed: `ssCe` now uses `curve[i].Ce` at the stability point itself — a coherent statement.

*Approach line rewritten to scan precomputed chart curve (v0.4.11):* `estimateSteadyState` and `estimateTimeToTarget` previously each called `model.computeCurve` independently on every recompute. Now `app.js` passes the same curve computed by `refreshChart` to `drugPanel.setCurveData`. Both functions scan `_sharedCurve` directly — pure array iteration, no model calls. Cache invalidates on curve version change or pump-state change; no time-based throttle needed. Stability criterion made explicit: `SS_DRIFT_THRESHOLD = 0.1 mcg/mL` over `SS_WINDOW_MIN = 10 min` (60 samples at 10s resolution). This is the Ce the clinician will observe stabilizing on the monitor, not a distant PK equilibrium.

*eBIS moved into Ce/Cp row (v0.4.12):* BIS promoted from a standalone div below the status row into the `drug-conc-row` flex line. Renamed "BIS" → "eBIS" to clarify PD-model origin. Label + separator hidden when not active. Label/value split to match Ce/Cp pattern (9px muted label, 11px mono value). Row gap and separator margins tightened.

307 tests, all passing.

**Session 11 (2026-04-04):** Ce undershoot on target decrease — fixed in all planners. Version 0.4.4.

*Bug 1 — `findMaintenanceRate` peak constraint (stepped / CET / CET-conservative):* When dropping to a lower Ce target, the planner pauses until Ce decays to `upperBound` (e.g. 3.605 for target 3.5 with 3% CET tolerance). At that moment Ce > target, so the peak-constraint binary search finds `peakRate ≈ 0` (any rate pushes peak Ce above target). `min(endpointRate, ~0) = ~0`; maintenance rate was effectively zero and Ce free-fell to ~3.32 (5.1% below target). The existing `1.05×` bypass only fired for Ce 5%+ above target, missing the common 0–5% zone. Fix: changed to `currentCe >= ceTarget` — whenever Ce is at or above target, use endpoint rate only.

*Bug 2 — Emulation step extraction, decremental case:* SimTIVA's step extraction skips `cptRates[0]` (the high rate needed to bring Cp up quickly after a target decrease) and emits `cptRates[1]` from `maintTime`. SimTIVA re-plans every 2 min so this corrects itself; our one-shot planner does not. Fix: start from interval 0 (not 1) in the decremental branch.

307 tests, all passing.

**Session 14 (2026-04-05):** Fentanyl and ketamine drug support. Version 0.5.0.

*Fentanyl PK model (`js/pk/fentanyl.js`):* Shafer 1990 3-compartment model. PK parameters (V1=12.7 L, V2=462.7 L, V3=238.1 L, CL=0.599 L/min, Q2=2.05 L/min, Q3=0.076 L/min) with weight scaling for V1 and CL. ke0 from Scott 1985 (0.114/min, t½ke0≈6.1 min). Unit: ng/mL (×1000 from canonical mcg/mL). 18 tests.

*Ketamine PK model (`js/pk/ketamine.js`):* Domino 1982 / Clements 1982 parameters. 3-compartment with weight-scaled V1 and CL. ke0 fitted to clinical onset. Clinical range 200–4000 ng/mL (canonical 0.2–4 mcg/mL). Unit: ng/mL. 20 tests.

*Engine registration (`js/sim/simulation.js`):* Both drugs get their own matrix-exponential engine instances, registered at init and rebuilt on `setPatient`. `predictTrough` and all model operations work drug-agnostically.

*Intermittent bolus mode (`js/ui/mode.js`, `js/ui/keypad.js`, `js/ui/history.js`, `js/app.js`):* New mode (beside Manual and TCI). IV-push only — no pump involved. User sets a Ce redose threshold via the Intermittent keypad type. History filtered to bolus events only while in this mode. btn-rate shows "Set Infusion Rate" to transition back to infusion. Bolus keypad shows single "Administer" button (no pump/push choice). Approach line shows "Redose in M:SS" / "Redose now".

*Threshold chart line (`js/ui/chart.js`):* Amber (#f59e0b) dashed horizontal annotation at the redose Ce threshold. Right-margin label drawn via `afterDraw` canvas plugin alongside the TCI target label. `setThresholdLine(ce)` public method; cleared on drug switch.

*Per-drug chart config (`js/app.js`):* `CHART_DRUG_CONFIG` maps each drug to yScale/yLabel/yDefault. Fentanyl and ketamine curves scaled ×1000 before passing to chart; drug-panel receives canonical values. `chart.switchDrug(drugId, yLabel, suggestedMax, yScale)` persists/restores yMax per drug from localStorage.

*Redose countdown via matrix engine (`js/ui/drug-panel.js`):* `computeApproachData` intermittent case replaced `estimateTimeToThreshold` (chart-curve scan, ~120 min limit) with `model.predictTrough(drugId, t, ceTarget)` — unlimited lookahead via matrix exponential, correct for ketamine's 200–600 min Ce decay.

*All-tile live updates (`js/ui/drug-panel.js`, `js/app.js`):* Background rAF loop now updates Ce/Cp, status label, and step-bar for every drug tile every frame, not just the selected one. `getModeForDrug` and `getIntermittentThresholdForDrug` callbacks enable per-drug status and countdown logic for non-selected tiles.

*Step-bar inversion (`index.html`):* Container background → drug color; fill bar → dark. Bar depletes from full orange (ready) to dark (time's up) as the interval elapses. Non-selected intermittent tiles show "Redose in M:SS" via `predictTrough` in the background loop.

*Per-drug pre-start clock (`js/app.js`):* `preStartClock` changed from a scalar to a `{}` map with `getPreStartClock(drugId)` / `advancePreStartClock(drugId, by)` helpers. Queuing a propofol bolus pre-start no longer delays fentanyl/ketamine events — each drug's clock advances independently.

346 tests across 11 suites, all passing.

**Session 15 (2026-04-06):** PK model corrections and bug fixes for fentanyl and ketamine. Version 0.5.1.

*Fentanyl PK corrected (`js/pk/fentanyl.js`):* Shafer 1990 parameters replaced with authoritative values: V1=7.35 L, V2=33.94 L, V3=275.62 L, CL=36.47 L/h, Q2=207.71 L/h, Q3=99.22 L/h, ke0=0.1195 /min. Weight scaling via Shibutani 2004 pharmacokinetic mass, now requiring both TBW ≥ 85 kg AND BMI > 30 (the actual inclusion criteria from the derivation study). Previous threshold (TBW > 80 with no BMI gate) incorrectly applied the correction to tall lean patients and created a non-physiological discontinuity at the boundary. `pkMass(tbw, bmi)` now takes both arguments; `calcFentanylParams` computes BMI from `patient.height`. 28 tests (+4 boundary cases).

*Ketamine PK corrected (`js/pk/ketamine.js`):* Replaced with Domino/Navarrete parameterization using fixed population micro-constants (K10=0.4381, K12=0.5921, K21=0.2470, K13=0.5900, K31=0.0146 /min; ke0=0.238 /min). V1=0.063×weight; V2, V3, CL, Q2, Q3 all derived from V1 and the fixed Kij. Model label updated to "Domino/Navarrete". 23 tests.

*Non-selected tile approach line frozen (`js/ui/drug-panel.js`):* `$(dId + '-approach')` was only ever written by `updateApproachLine()` which only runs for the selected drug. Deselecting a tile left its approach line showing stale HTML that never counted down. Fixed: non-selected loop now also writes the approach line element.

*Non-selected `predictTrough` called 60×/sec (`js/ui/drug-panel.js`):* The selected drug avoids calling `predictTrough` every frame by caching `arrivalMin` and using `arrivalMin − t` per frame. Non-selected drugs had no equivalent cache — `predictTrough` (~1000 engine advances internally) was fired at rAF rate. Fixed with `_nonSelectedCache` keyed by event count; `predictTrough` is now called once per bolus.

*Fentanyl/ketamine events not saved (`js/app.js`):* `eventsByDrug` serialisation loop was `for (const drugId of ['propofol'])` with a `// extend for multi-drug` comment. Fentanyl/ketamine events were never written to the save blob. Modes and thresholds also only covered propofol. Fixed: all three drugs saved and restored, including `intermittentThresholds` which was a new saved field.

359 tests across 12 suites, all passing.

**Session 13 (2026-04-05):** eBIS opioid correction toggle. Version 0.4.6.

*Bug:* eBIS reported ~24 vs SimTIVA's ~42 for a standard opioid patient (35M 170cm 70kg, Ce=3.5). Root cause: `eleveld.js` always applied the Eleveld 2018 paper's Ce50 opioid correction (`× exp(−0.567)`), halving Ce50 from 3.08 → 1.75 μg/mL. SimTIVA does not implement this correction.

*Fix:* Ce50 opioid correction is now opt-in. New `ce50OpioidCorrection` field on the patient object (default `false` = SimTIVA behaviour). New checkbox in the setup UI — shown only when "With opioid" is selected, persisted to localStorage. With toggle off (default): Ce50=3.08, eBIS≈42 at Ce=3.5. With toggle on: Ce50=1.75, eBIS≈24 (Eleveld paper formula). The opioid flag continues to affect PK parameters (V3, CL) in both modes.

*Files changed:* `js/pk/eleveld.js`, `index.html`, `js/ui/setup.js`, `js/sim/simulation.js`, `tests/test-pk.js` (44 tests), `tests/test-integration.js`.

308 tests across 10 suites, all passing.

**Session 16 (2026-04-06):** Large Ce undershoot on target decrease fixed in emulation planner. Version 0.5.2.

*Root cause:* For large target drops (e.g., 4.5→2.5), the decay pause runs 9+ minutes at rate=0. Cp falls far faster than Ce (Cp=3.06 vs Ce=4.38 just 1 minute into the pause). When Ce finally reaches upperBound (2.625), Cp is ~1.5. ke0 equilibration immediately pulls Ce toward Cp, and the Cp-targeting maintenance rate can't raise Cp fast enough — Ce dips to 2.27 (9.2% below target).

*Fix:* Extended the existing `ceBoostIntervals` mechanism (Ce-targeting binary search, already used for rate-only step-ups) to also activate when Cp is >10% below target at maintenance start. Number of intervals: `ceil(cpGap / (ceTarget × 0.1))`, capped at 8. Each interval finds the rate where `engine.advance(5, rate)` → Ce at +5min = target, advances the engine 2 min, then refits the eigenstate. By interval 4 (8 min): Ce ≈ 2.50, Cp ≈ 2.35; Cp-targeting takes over with a small gap, ke0 equilibration no longer drives Ce out of band.

359 tests, all passing.
