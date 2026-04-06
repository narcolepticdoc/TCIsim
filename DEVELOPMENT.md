# Development History & Roadmap

## Session History

### Session 19 (2026-04-06) — Emulation Planner Ce Overshoot Fix (v0.5.3 → v0.5.4)

Two targeted changes to `planTCISchemeEmulation` in `js/sim/tci-planner.js`:

**Fix 1 — `cpOvershoot` guard:**
For mid-range step-ups (e.g. 3.5→4.0), a bolus is delivered and `hadBolus=true` makes
`needsCeBoost=false`, so `ceBoostIntervals=0` and Cp-targeting starts immediately. The
`correctionRatio` inflates the bolus beyond what the analytical pause duration accounts
for, leaving `cpAtMaint > ceTarget` at maintenance start. The Cp-targeting eigenstate then
schedules infusion while Ce is still equilibrating upward — producing a ~4.125 Ce peak at
~1 hour (3% overshoot within the 5% clinical band but measurable).

Fix: when `hadBolus && cpAtMaint > ceTarget × 1.02`, use 2 Ce-boost intervals before
entering Cp-targeting. Ce-boost does binary search targeting Ce directly, preventing the
lag-driven overshoot. Inserted as a third case in `ceBoostIntervals` computation:
`needsCeBoost ? 3 : cpLiftIntervals > 0 ? cpLiftIntervals : cpOvershoot ? 2 : 0`.

**Fix 2 — Dynamic threshold with `stepMagnitude`:**
For small step-ups (<20% Ce increase), the long-term V3-equilibration rate correction is a
gradual 4–6% decline over hours — below the 8% `cptThreshold` and therefore silently
skipped. Ce drifts to ~4.155 by 4 hours. Fix: compute
`stepMagnitude = (ceTarget − currentCe) / ceTarget`; if `earlyRateMlH ≥ 30 AND
stepMagnitude > 0.20`, use original 8%/0.667 values; otherwise use 5%/0.62 to catch the
subtle correction. Uses existing `currentCe` (captured right after `engine.setState(startState)`)
— no new variable needed.

359 tests across 12 suites, all passing.

---

### Sessions 1-6 (2026-03-19 to 2026-03-30)

Built the core application:
- Matrix-exponential PK engine with Eleveld 2018 parameter computation
- Validated Cp against SimTIVA to 0.0000% across all patient archetypes
- Event-driven architecture (bolus, rate, pause events)
- Realistic bolus delivery at configurable pump rates
- TCI scheme planner (stepped mode)
- Event history panel with unified editor (add/edit/delete)
- TCI conflict rules for manual event interaction
- Time standardization (H:MM:SS display, H:MM editing)
- Timer with dual Start Time / Elapsed Time modes
- Keypad with prefill-override behavior
- 262 tests across 9 suites, all passing

### Session 7 (2026-03-30)

UI polish and pump settings:
- Keypad unification (4-column grid, both keypads)
- System events visible in history (rate-restores as dimmed italic rows with ↩ prefix)
- Bolus labels: "Pump Bolus" / "IV Push" with purple scheme
- Pause duration selects, overflow handling
- Event overlap boundary fix
- Pump settings system: concentration, max pump rate, opioid toggle, TCI mode
- Pump configuration persisted to localStorage

### Session 8 (2026-04-02 to 2026-04-04)

TCI planner refinement and CET Emulation mode:

**CET/CET(C) improvements:**
- Analytical pause timing from SimTIVA UDF peak time (within 1 second)
- Target step-up bug fixed — conservative mode no longer ignores existing drug
- Small adjustment threshold removed for emulation mode (always bolus, matching SimTIVA)
- No spurious pauses in maintenance — drift above band triggers rate reduction, not pause
- `findMaintenanceRate` dual-constraint search (endpoint + peak prevention)
- ke0-derived lookahead (`3 × ln(2) / ke0`) replaces empirical constants

**CET Emulation planner (new):**
- Direct port of SimTIVA's `deliver_cpt` algorithm in eigenstate math space
- First pass: 180 intervals × 120s with SimTIVA's analytical Cp-targeting formula
- Second pass: 8% threshold + 0.667 weighted average + 1 mL/h rounding
- `wait_peak` averaging for initial rate oscillation
- Dynamic threshold/avgfactor based on early maintenance rate magnitude

**Eigenstate decomposition:**
- Cp: 3×3 Cramér's rule — exact decomposition for maintenance rate computation
- Ce: 4×4 Gaussian elimination with partial pivoting — exact decomposition for step-up bolus
- Replaces rough proportional approximation that caused major errors on second target changes

**CET step-up algorithm (ported from SimTIVA):**
- `trialDose = (target - vmCe(e_state, peak)) / e_udf[peak]` — accounts for existing drug
- Iterative `find_peak` adjusts peak time
- Rate correction factor applied
- Result: 0% overshoot, <1 min to 95% target on step-ups

**Bug fixes from external analysis:**
1. `p_udf` extended to 21600 seconds (was 1000 — silent undefined risk)
2. Bolus rounding: `Math.round` to match SimTIVA
3. Dynamic threshold/avgfactor based on early maintenance rate
4. Eigenstate replay in integer seconds (eliminates minute/second mixing drift)

### Session 9 (2026-04-04) — TCI Planner Fixes (Rev 6 Handoff)

Applied four fixes from external analysis in `TCI_Planner_Port___Handoff_Notes__Rev_6_.md`:

**Fix 1 — `computeRateCorrFactor` mechanistic replacement (`simtiva-reference.js`):**
The linear approximation (`0.97 - abs(max1200 - maxRate) / (max1200 - minRate) * 0.1`) was tuned for a typical patient near 750 mL/h and produced systematic Ce underdosing — mean error −8.4%, worst case −21.6% for a 120 kg patient at Ce=5. Replaced with a patient-specific UDF simulation: Ce trajectory is simulated second-by-second during delivery using `e_coef`/`lambda`, binary search finds the duration where peak Ce matches the target. Mean error reduced to −1.9%, worst case −7.2%. Function signature changed — now takes `e_coef[]` and `lambda[]` instead of pump-rate scalars; call site in `computeSimTIVACETBolus` updated accordingly.

**Fix 2 — `eudf` peak search ceiling raised from 1000 to 3600 (`simtiva-reference.js`):**
All propofol patients have peak_time 163–194s, so no current impact. Fix future-proofs for drugs with slow ke0 (opioids, dexmedetomidine) whose Ce peak can exceed 1000s and would have been silently truncated.

**Fix 3 — Ce-boost eigenstate sync (`tci-planner.js`):**
In `planTCISchemeEmulation`, after each Ce-boost interval the engine was advanced but the parallel `ps1/ps2/ps3` eigenstate was not updated. At the Ce→Cp transition, the eigenstate diverged from engine reality, producing wrong first maintenance step rates (~10–15 mL/h overestimate). Fixed by extracting the Cramér's rule refit into `refitEigenstate()` and calling it after each Ce-boost `engine.advance()`.

**Fix 4 — Bolus rounding in mL not mg (`simtiva-reference.js`):**
Old code: `bolusMg = Math.round(durationSec * maxRateMgSec)` (rounds to nearest 1 mg). New code: `bolusVolMl = Math.round(durationSec * maxRateMgSec / concentration); bolusMg = bolusVolMl * concentration` (rounds to nearest mL = nearest 10 mg at 10 mg/mL). Matches SimTIVA line 4702. Differences of 6–67 mg observed across patient range.

### Session 11 (2026-04-04) — Emulation Planner Overshoot & Long-term Drift (v0.4.2 → v0.4.3)

**Root causes fixed:**

1. **Initial Ce overshoot (~4.6 for Ce=4.5 target) — mL rounding in `computeSimTIVACETBolus` (`simtiva-reference.js`):**
   `Math.round(durationSec × maxRateMgSec / concentration)` rounds to nearest 1 mL = 10 mg. For a typical bolus (18.54 mL → 19 mL) this added ~4.6 mg excess after the rate-correction factor was already applied, producing a 2.5% Ce overshoot. Fixed: `bolusMg = durationSec * maxRateMgSec` (exact for integer-second delivery, no mL rounding). The emulation planner's own `Math.ceil` at line 725 still applies ≤1 mg rounding — acceptable.

2. **Long-term Ce drift (4.78 at 200+ min) — second-pass scan limit `j < 60` (`tci-planner.js`):**
   The first pass computes 180 intervals × 120 sec (360 min of rates). The second pass extracted steps only for `j = 0..59` (120 min) — intervals 60–179 were silently discarded. The final emitted scheme step sat at ~90 min maintenance time; after that, Ce drifted upward as V3 (τ ≈ 246 min) filled and the fixed rate became too high. Fixed: scan loop changed to `j < cptRates.length`; hardcoded `j = 59` final-step block updated to `j = cptRates.length - 1`.

3. **First-pass horizon extended 180 → 360 intervals (`tci-planner.js`):**
   360 × 120 sec = 720 min. V3 is ~95% equilibrated at 720 min vs ~77% at 360 min. The loop is pure eigenstate arithmetic (no `engine.advance`) — computationally free. Named constant `cptIntervalCount = 360` introduced.

4. **Stepped and CET planner horizons extended (`tci-planner.js`):**
   - Stepped: `maxPlanTime` 120 → 480 min, `maxSteps` 8 → 12.
   - CET/CET(C): `maxPlanTime` 360 → 720 min, `rateStablePct` 1% → 0.1% (prevents premature stability break before V3 equilibrates).

307 tests across 10 suites, all passing.

---

### Session 12 (2026-04-05) — Drug Panel Redesign (v0.4.4 → v0.4.11)

Denser, more information-rich drug panel layout. All changes in `index.html` (CSS + HTML) and `js/ui/drug-panel.js`.

**Drug color strip:** Active card left border now uses a per-drug `--drug-color` CSS variable. Propofol and Ketamine (hypnotics) = yellow (`#f59e0b`); Fentanyl and Remifentanil (narcotics) = blue (`#3b82f6`). Step bar also inherits drug color.

**Combined Cp/Ce row:** Ce and Cp merged onto one baseline-aligned flex row. Ce is 22px/600-weight (was 18px), Cp is 11px, separated by a dim `|`. Removes the separate `drug-cp-row` and the `ce-target-display` arrow span.

**Pump status label:** Simplified to four pump-state labels only — no more "Manual" or "Pump Stopped". States: `Infusing` (green), `Bolus` (green + CSS step-blink animation), `Paused` (amber), `Stopped` (red). Infusion rate is now shown inline to the right of the status label; the separate `drug-rate` div is removed. Bolus detection checks the event list for an active `type === 'bolus'` event (falling back to `rate > 50` heuristic).

**Approach / countdown line:** New `drug-approach` element below the concentration row. Content depends on pump state — computed via `model.computeCurve` or `model.predictTrough`, throttled to 500ms to avoid excessive work per frame:
- *TCI mode, running:* `Approaching Target → X.X in m:ss` (scans 30-min curve for Ce crossing target ±0.05).
- *TCI mode, at target (|Ce − target| < 0.05):* `At Target X.X mcg/mL`.
- *TCI mode, paused, Ce above target:* `Returning to Target → X.X in m:ss`.
- *Manual infusion:* `Steady state ≈ X.X mcg/mL in m:ss` — see steady state definition below.
- *Pump stopped (no mode):* `Emergence Ce 1.5 in m:ss` (calls `model.predictTrough` with threshold 1.5 mcg/mL; threshold is a named constant `EMERGENCE_CE` for future configurability).

**BIS color coding:** BIS value color is set dynamically per reading, matching the chart nomogram bands exactly: > 90 muted (awake, no band), 80–90 `#ef4444` red (Light Sedation), 60–80 `#f97316` orange (Deep Sedation), 40–60 `#eab308` yellow (GA), 20–40 `#22c55e` green (Deep Anesthesia), < 20 `#a855f7` purple (Very Deep). Static `color: var(--green)` CSS rule removed. Initial implementation had mismatched colors; corrected to nomogram values in follow-up commit.

**Step bar + live countdown:** `step-bar-area` now contains a small `step-bar-countdown` text element (9px mono, right-aligned, format `m:ss`) above the progress bar. `updateStepBar` scans `model.getEvents(drugId)` each frame to find the previous and next events around the current time, computes fill percentage, and shows the time remaining until the next event. Bar is hidden (0% width, blank countdown) when no future events exist.

**Steady state definition (follow-up fix):** Initial approach used 5% of the 150-min Ce value as the threshold, which could fire immediately if Ce was already near its plateau. Replaced with rate-of-change criterion: "steady state" = first point in the 150-min curve where Ce changes less than 0.05 mcg/mL over a 5-minute window. This maps to the clinical reality of "the number has stopped moving" regardless of where Ce started.

**Approach line update architecture (follow-up fix):** Initial implementation baked the countdown value into a static HTML string and recomputed the whole string every 500ms — the countdown did not tick between recomputes. Refactored to separate concerns: `computeApproachData` runs the expensive `computeCurve`/`predictTrough` calls and returns `{ prefix, arrivalMin, staticText }`, where `arrivalMin` is an absolute elapsed-minute timestamp. `updateApproachLine` (called every rAF frame) builds the final HTML live as `arrivalMin − t`, so the countdown ticks smoothly every frame. The expensive recompute is throttled to 5 seconds (up from 500ms), with immediate invalidation on mode/rate/target changes and after threshold crossing.

**Steady state display Ce stability fix:** During rapid Ce changes (e.g. mid-bolus), each 5-second recompute starts from a different engine state, causing the 150-min projection endpoint (`ssCe`) to shift slightly each time. This produced visible jumps in the displayed steady-state Ce value and an abrupt transition to "At steady state" with a different number. Fixed by locking `ssCe` separately from the countdown: `_approachCache.lockedSsCe` is only reset when mode, rate, or target changes (or on a `forceUpdate` after a model mutation) — never on the time-based 5 s recompute. `computeApproachData` accepts `lockedSsCe` and uses it for the label; the countdown (`arrivalMin`) continues to update every 5 s for accuracy. The lock is released immediately on any pump-state change so the value stays clinically current.

**Steady state Ce value corrected to stability point (follow-up fix):** `ssCe` was previously taken from `curve[last].Ce` — Ce at t+150 min, the long-term pharmacokinetic equilibrium as all compartments (including the slow V3, τ ≈ 246 min) approach steady state. `ssMin` is computed from the rate-of-change criterion and typically fires within a few minutes of a constant infusion. The two values were therefore from completely different points on the curve, producing misleading displays such as "Steady state ≈ 4.7 in 1:58" when Ce would actually be ≈ 3.8 at the 2-minute mark.

Fixed: `ssCe` now uses `curve[i].Ce` — the Ce value **at the stability point itself** — so the display reads as a single coherent statement: "in N minutes, Ce will have stabilized at approximately X." This is the clinically actionable number (what the monitor will show), not the theoretical 2-hour equilibrium. Ce will continue drifting slowly upward after this point as V3 fills, but that drift is below the threshold and below clinical significance for moment-to-moment dosing decisions.

**Approach line rewritten to use precomputed chart curve (v0.4.11):** `estimateSteadyState` and `estimateTimeToTarget` previously each called `model.computeCurve` independently (150-min and 30-min projections respectively) on every recompute cycle. This was redundant — `app.js` already calls `model.computeCurve(selectedDrug, 0, endTime, 10/60)` on every model mutation in `refreshChart()` and sends that curve to the chart.

New approach: `app.js` now also calls `drugPanel.setCurveData(curve)` after `chart.setCurveData(curve)`. `drug-panel.js` stores the curve in `_sharedCurve` and increments `_curveVersion`. Both `estimateSteadyState` and `estimateTimeToTarget` scan `_sharedCurve` directly — pure array iteration, no model calls. The approach cache invalidates on `_curveVersion` change or pump-state change (mode/rate/target); no time-based throttle is needed since scanning an array costs microseconds.

**Stability criterion made explicit:** Two named constants define what "steady state" means for display purposes: `SS_DRIFT_THRESHOLD = 0.1` mcg/mL and `SS_WINDOW_MIN = 10` minutes. The first point in the curve where Ce changes less than 0.1 mcg/mL over the next 10 minutes is declared stable. At 10-second chart resolution that is a 60-sample window. This is more conservative than the previous 0.05/5-min criterion and better reflects the clinical reality that Ce drifts slowly upward for hours — the displayed value is the Ce the clinician will observe on the monitor stabilizing, not a distant pharmacokinetic equilibrium.

**eBIS moved into Ce/Cp row (v0.4.12):** The BIS value was previously rendered in a standalone `<div class="drug-bis">` below the status row. Moved into the `drug-conc-row` flex layout as a third group, separated from Cp by an additional `|`. Renamed from "BIS" to "eBIS" (effect-site BIS) to clarify that this is a PD model prediction, not a measured monitor value. Separator and label are hidden via `display:none` when eBIS is not active (case not started or t=0), so the row stays clean before induction. Label ("eBIS") rendered as a 9px muted `<span>` matching the Ce/Cp label pattern; value rendered as 11px mono matching Cp. Row gap tightened (4px → 3px), separator margin tightened (2px → 1px each side).

308 tests across 10 suites, all passing.

---

### Session 10 (2026-04-04) — UI Polish & Bug Fixes (v0.4.1 → v0.4.2)

**Bug fixes (v0.4.1):**
- Zoom snap-back: `setCurveData` now syncs `chart.options.scales.x.min/max` to `viewMin/viewMax` before each update — zoomed position is preserved across data refreshes.
- Stop Pump during TCI pause: guard changed from `if (rate === 0) return` to `if (rate === 0 && mode !== 'tci') return` — allows the button to clear future TCI events even when TCI has paused the pump.

**Chart (v0.4.1):**
- Ce Target label moved to right margin (65px layout padding + annotation `position:'end'`).
- BIS nomogram rewritten with correct Ce ordering and 4 bands: Red (Light Sedation BIS 80–90), Orange (Deep Sedation 60–80), Yellow (GA 40–60), Green (Deep Anesthesia 20–40). Alpha raised from 9% → 19%.

**Follow-up bug fixes (v0.4.2):**
- Pinch-zoom triggered `recenter()` on finger release: two `touchend` events from a pinch were misread as a double-tap. Fixed with `wasMultiTouch` guard.
- Auto-scroll fired mid-pinch: `onZoomStart` now sets `autoScroll = false` immediately, before animation frames can call `zoomScale` with stale range. Pan callbacks also sync `viewMin/viewMax`.
- Ce target label switched from annotation label (clipped to chart area) to `afterDraw` canvas plugin, rendering fully in the right-margin padding.
- Nomogram bands had inverted Ce ordering (`ceForBIS(20) > ceForBIS(40)` numerically); corrected to ascending Ce from bottom to top of Y axis.
- Syntax error from `plugins` array at wrong indentation inside Chart constructor.
- `APP_VERSION` extracted to `js/version.js` — only this file needs editing on future releases.
- Tooltip shows `Rate: X.X mcg/kg/min` between Ce/Cp and BIS.

**UI labels:**
- "Pause Pump" → "Stop Pump" on pump control button.
- Drug panel + history: "Paused" for TCI-scheduled `rate=0`; "Pump Stopped" for manual stop.

307 tests across 10 suites, all passing.

### Session 11 (2026-04-04)

Ce out-of-band undershoot on target decrease — fixed in all planners. Version 0.4.4.

*Bug 1 — `findMaintenanceRate` peak constraint (stepped / CET / CET-conservative):*
After the decay pause, Ce sits at `upperBound` (e.g. 3.605 for a 3.5 target with 3% CET
tolerance). The peak-constraint binary search asks "what rate keeps max Ce over 60 min ≤ target?" — but Ce already starts above target, so even rate=0 violates the cap; the search converges to `peakRate ≈ 0`. `min(endpointRate, ~0) = ~0`, so the maintenance rate was effectively zero and Ce free-fell to ~3.32 (5% below a 3.5 target). The existing 1.05× bypass threshold only fired when Ce was well above target, missing the 0–5% zone. Fix: changed threshold to `currentCe >= ceTarget` — whenever Ce is at or above target, skip the peak constraint and use endpoint rate only.

*Bug 2 — Emulation step extraction, decremental case:*
SimTIVA's `deliver_cpt` step extraction skips `cptRates[0]` (the high initial rate needed to bring Cp back up quickly after a target decrease) and starts from `cptRates[1]`. SimTIVA re-plans every 2 minutes so this self-corrects; our one-shot planner does not. Fix: start from interval 0, not interval 1, in the decremental branch.

307 tests, all passing.

### Session 13 (2026-04-05) — eBIS Opioid Correction Toggle (v0.4.5 → v0.4.6)

**Bug:** eBIS reported ~24 vs SimTIVA's ~42 for a standard opioid patient (35M 170cm 70kg, Ce=3.5).

**Root cause:** `eleveld.js` always applied the Eleveld 2018 paper's Ce50 opioid correction (`× exp(−0.567) ≈ 0.567`), halving Ce50 from 3.08 → 1.75 μg/mL. SimTIVA does not implement this correction, so its BIS calculations use Ce50=3.08 regardless of opioid status.

**Fix:** Ce50 opioid correction is now opt-in via a new `ce50OpioidCorrection` field on the patient object (default `false` = SimTIVA behaviour). A "Ce50 opioid correction" checkbox is added to the setup form, visible only when "With opioid" is selected. Toggling it on applies the Eleveld paper formula for users who prefer strict pharmacological accuracy.

- `js/pk/eleveld.js` — `ce50OpioidFlag` gated on `opioid && ce50OpioidCorrection`
- `index.html` — new checkbox row (shown/hidden by JS based on opioid select)
- `js/ui/setup.js` — wires checkbox, show/hide logic, localStorage persistence (`tci-ce50-correction`)
- `js/sim/simulation.js` — default patient includes `ce50OpioidCorrection: false`
- Tests updated: `test-pk.js` (44 tests), `test-integration.js` — opioid Ce50 assertions updated; new test confirms correction-on behavior

308 tests across 10 suites, all passing.

### Session 14 (2026-04-05) — Fentanyl & Ketamine Drug Support (v0.5.0)

**Fentanyl PK model (`js/pk/fentanyl.js`):** Shafer 1990 3-compartment. Parameters corrected in v0.5.1 — see Session 15. ke0=0.1195 /min. Display unit: ng/mL.

**Ketamine PK model (`js/pk/ketamine.js`):** Domino/Navarrete 3-compartment with fixed population micro-constants. Parameters corrected in v0.5.1 — see Session 15. ke0=0.238 /min. Display unit: ng/mL.

**Intermittent bolus mode:** New per-drug mode alongside Manual and TCI. IV-push–only — no pump events generated. Threshold keypad type sets the Ce redose threshold. History filtered to boluses only in this mode. Approach line uses `model.predictTrough()` for unlimited-lookahead redose countdown (essential for ketamine, whose Ce can take 200–600 min to decay). Step-bar shows delivery progress during bolus, then shows "Redose in M:SS" countdown text.

**All-tile live updates:** Background rAF loop now updates Ce/Cp, status label, and step-bar for every drug card every frame. `getModeForDrug` and `getIntermittentThresholdForDrug` callbacks supply per-drug context for non-selected tiles.

**Per-drug chart config:** `CHART_DRUG_CONFIG` in `app.js` maps each drug to `{ yScale, yLabel, yDefault }`. Fentanyl/ketamine curves scaled ×1000 (mcg/mL → ng/mL) before charting; drug-panel receives canonical values. y-axis max persists per drug to localStorage.

**Step-bar inversion:** Container background swapped to drug color; fill bar is now dark. Full container = ready to dose; dark fill grows left-to-right as interval elapses.

**Per-drug pre-start clock:** `preStartClock` refactored from scalar to `{ [drugId]: minutes }` map. Propofol bolus delivery no longer delays fentanyl/ketamine pre-start events.

**BIS bands cleared on drug switch:** `computeEffectOverlay()` called inside `refreshChart()` (was only called at chart init); fentanyl/ketamine have no PD model so bands clear automatically.

346 tests across 11 suites, all passing.

---

### Session 15 (2026-04-06) — PK Model Corrections and Bug Fixes (v0.5.1)

**Fentanyl PK model corrected (`js/pk/fentanyl.js`):**
- Shafer 1990 parameters: V1=7.35 L, V2=33.94 L, V3=275.62 L, CL=36.47 L/h, Q2=207.71 L/h, Q3=99.22 L/h, ke0=0.1195 /min
- Shibutani 2004 inclusion criteria: `pkMass(tbw, bmi)` applies only when TBW ≥ 85 kg AND BMI > 30. Previous threshold (TBW > 80 kg, no BMI check) incorrectly triggered for tall lean patients and created a non-physiological discontinuity at the boundary. BMI computed from `patient.height` in `calcFentanylParams`.

**Ketamine PK model corrected (`js/pk/ketamine.js`):**
- Domino/Navarrete fixed-Kij parameterization: K10=0.4381, K12=0.5921, K21=0.2470, K13=0.5900, K31=0.0146 /min; ke0=0.238 /min; V1=0.063×weight; all other volumes and clearances derived from V1 and fixed micro-constants.

**Non-selected tile freeze fixed (`js/ui/drug-panel.js`):**
1. Approach line element (`$(dId + '-approach')`) was never written for non-selected drugs — it kept stale HTML from when the drug was last selected.
2. `predictTrough` was called every rAF frame (~60×/sec) for each non-selected intermittent drug, causing ~2000 engine advances per frame per drug. Added `_nonSelectedCache` keyed by event count; `predictTrough` is called once per bolus, then `arrivalMin − t` computes the live countdown (same pattern as selected-drug `_approachCache`). Both the approach line and the bar countdown are now updated each frame.

**Save/restore fixed (`js/app.js`):**
- `eventsByDrug` serialisation loop was `for (const drugId of ['propofol'])` — fentanyl/ketamine events were never saved.
- Mode and `ceTarget` collection likewise only covered `['propofol']`; `intermittentThresholds` was not saved at all.
- All three drugs are now included in `eventsByDrug`, `modes`, `ceTargets`, and the new `intermittentThresholds` field. Restore applies all four.

359 tests across 12 suites, all passing.

### Session 16 (2026-04-06) — Ce Undershoot on Target Decrease (v0.5.2)

**Ce out-of-band undershoot on target decrease — two-part fix.**

*Session 11 fix (v0.4.4):* Fixed `findMaintenanceRate` peak-constraint threshold (`ceTarget * 1.05` → `ceTarget`) and emulation step extraction to start from interval 0 instead of 1 in the decremental case. These resolved moderate target drops (e.g., 4.5→3.5, dip from 3.32 to within band).

*This session (v0.5.2):* Large target drops (e.g., 4.5→2.5) still caused Ce to dip to 2.27 (9.2% below target). Root cause: the 9+ minute pause at rate=0 lets Cp fall much faster than Ce (screenshot: Cp=3.06 just 1 min into a pause from 4.5). By the time Ce reaches `upperBound` (2.625), Cp is ~1.5. ke0 equilibration pulls Ce toward Cp faster than the Cp-targeting maintenance rate can raise Cp.

**Fix:** Activate Ce-targeting intervals (the existing `ceBoostIntervals` mechanism, used for rate-only step-ups) when Cp is >10% below target at maintenance start. The number of intervals scales with the Cp gap: `ceil(cpGap / (ceTarget × 0.1))`, capped at 8. For a 4.5→2.5 drop with Cp≈1.5: 4 intervals (8 min) of Ce-targeting, each finding the rate to hold Ce at target over the next 5 minutes. By the time Cp-targeting takes over, the Cp–Ce gap is small and ke0 no longer drives Ce out of band.

359 tests across 12 suites, all passing.

---

### Session 17 (2026-04-06) — Event Warning System (v0.5.3)

Advance warnings for upcoming TCI and manually-planned pump events. Fires for `source:'tci'` and `source:'manual'` events; `source:'system'` rate-restores are excluded (auto-applied, no human action needed).

**Descriptive step bar labels (`js/ui/drug-panel.js`):**
`updateStepBar()` now formats a human-readable description for the next upcoming event — e.g. `"Rate → 140 mcg/kg/min in 1:30"` — with the countdown highlighted in amber. Value is converted using the user's persisted unit preference (same lookup as the keypad). System events retain a bare countdown. CSS updated to `text-align: left` + `text-overflow: ellipsis` so descriptions are readable at the card's narrow width.

**Two-tier warning system (`js/ui/warnings.js`, new file):**

- **Prep stage** (default 30s before event): inset amber border glow on the drug card + amber background pulse on the topbar. Inset box-shadow is used because `.drug-panel` has `overflow-y: auto`, which clips outward shadows. Optional chime (`playAlert('info')`) disabled by default.
- **Alert stage** (default 10s before event): three-tone chime (`playAlert('warning')` — 880/880/1100 Hz) + a persistent popup stacked above the bottom controls. Popup shows drug name, event description, live countdown, and requires "Got it" to dismiss. Multiple concurrent popups stack per-drug. Optional chime enabled by default.

State: `_prepSoundFired` and `_alertFired` sets guard one-shot triggers per event ID. Both sets clear on `reset()`. The prep visual (card class + topbar class) is set/cleared every rAF frame based on current state, not as a one-shot.

**Audio (`js/ui/alert-sound.js`, new file):**
Persistent `AudioContext` created on first user gesture (`unlockAudio()`, registered as a one-shot `click` listener in `warnings.init()`). Fixes silent alerts caused by browser autoplay policy. Three severity levels: `info` (single soft tone), `warning` (two 880 Hz + 1100 Hz), `urgent` (alternating 1200/900 Hz pattern).

**Settings (⚙ gear button in topbar → modal):**
- Prep threshold slider: 5–120s (default 30s)
- Prep sound checkbox: off by default
- Alert threshold slider: 5–60s (default 10s)
- Alert sound checkbox: on by default

All four values persist to localStorage under `'tci-warn-settings'`.

359 tests across 12 suites, all passing.

---

### Session 18 (2026-04-06) — Drug Card Polish & Intermittent UX (v0.5.3)

**Bug fix — event editor broken for non-propofol drugs (`js/app.js`):**
`eventEditor.setDrug()` was never called when switching drug cards, so `_selectedDrug` in `event-editor.js` stayed `'propofol'`. `openEdit()` looked up the event ID in the wrong drug's event list, found nothing, and returned silently. Fix: call `eventEditor.setDrug(drugId)` alongside the existing `keypad.setDrug()` and `history.setDrug()` calls in the drug-card click handler.

**Fentanyl mcg display precision (`js/util/units.js`):**
`formatValue` for `'mcg'` changed from `toFixed(0)` to `toFixed(1)`, allowing doses like 12.5 mcg to round-trip through the event editor without being displayed as 13.

**Non-selected drug card approach line (`js/ui/drug-panel.js`):**
The background rAF loop previously cleared the approach line element for all non-selected, non-intermittent drugs. Approach lines now render for all modes:

- Extracted `_estimateTimeToTarget(curve, t, Ce, ceTarget)` helper (takes any curve, not just `_sharedCurve`).
- Added `_computeApproachFromCurve(drugId, t, m, Ce, ceTarget, rate, curve)` — mirrors the selected-drug `computeApproachData` logic (TCI target, emergence, manual steady state) using an explicit curve instead of the shared one.
- Added `_nonSelectedApproachCache` keyed on `{eventCount, mode, ceTarget, rate}`. On stale: computes a 120-min per-drug curve and stores `arrivalMin`; live countdown rendered from the cache each frame. Emergence uses `predictTrough` directly (no curve needed).
- `getCeTargetForDrug` callback added to `drugPanel.init` (wired in `app.js`) to read TCI targets for non-selected drugs.

| Mode (non-selected) | Approach line |
|---|---|
| TCI approaching target | `Target → X.X in M:SS` |
| TCI at target | `At Target X.X` |
| Manual + infusing | `Steady state ≈ X.X in M:SS` |
| Stopped / Ce above emergence | `Emergence 1.5 in M:SS` |
| Intermittent | `Redose in M:SS` / `Below Threshold` |

**Intermittent UX — "Below Threshold" indicator:**
- Renamed "Redose now" → `<span class="appr-below">Below Threshold</span>` with amber pulsing animation (`below-thresh-pulse`, 1.4s fade).
- `warnings.checkBelowThreshold(drugId, isBelow)` — fires a one-shot `'info'` chime on the above→below transition; resets on recovery so each new dip re-fires.
- New `redoseSound` setting (default `true`) in `warnings.js` with corresponding checkbox in the settings modal ("Intermittent — below-threshold chime"). Stored alongside the existing four TCI warning prefs.

**Intermittent UX — redose countdown in step-bar row:**
- "Redose in M:SS" moved from the approach line to the step-bar-countdown, matching TCI's "Rate → x in M:SS" position. Approach line is now reserved for "Below Threshold" only.
- Selected drug: `updateApproachLine` suppresses output when `m === 'intermittent' && arrivalMin !== null`; the step-bar block renders "Redose in `<appr-time>`M:SS`</appr-time>`" via `innerHTML`.
- Non-selected: same split — step-bar-countdown gets the labeled countdown HTML, approach line gets the "Below Threshold" flash.

**Intermittent progress bar (`js/ui/drug-panel.js`):**
`_intermittentBarPct(drugId, t, arrivalMin)` fills the bar from 0% (at last bolus time) to 100% (at predicted threshold crossing), giving the same countdown-style progress as the TCI step-bar. Below-threshold state pins bar at 100%.

**Bug fix — non-selected intermittent cache stale on threshold change:**
`_nonSelectedCache` was keyed on `{eventCount}` only. Changing the redose threshold (without adding events) left the old `arrivalMin` cached. Added `threshold` to the cache key; any threshold change triggers a `predictTrough` recompute.

**Visual hierarchy corrections (`index.html`):**
`.drug-approach` and `.step-bar-countdown` both promoted from `var(--text-muted)` to `var(--text-secondary)` to match the inline rate display. Added `.step-bar-countdown .appr-time { color: var(--amber) }` — the amber timer rule previously only covered spans inside `.drug-approach`.

359 tests across 12 suites, all passing.

---

## Known Issues

### Emulation Planner

1. **First maintenance rate ~2 mL/h lower than SimTIVA** — from bolus rounding difference (emulation uses `Math.ceil` to nearest 1 mg; SimTIVA rounds to nearest 1 mL). Cascades through eigenstate into first maintenance rate. Clinically insignificant.

2. **Step-up bolus ~5mg larger than SimTIVA** — from different `scheme_bolusadmin` correction computation for non-zero-state cases. Both produce 0% Ce overshoot.

3. **From-zero RMSE ~7% vs SimTIVA's 1.5%** — the gap is entirely in the first 2-3 rate steps. From step 3 onward, rates and timing match exactly.

### Other Planners

4. **CET/CET(C) maintenance RMSE ~17%** — these modes produce 1 maintenance rate step (from the ke0-derived lookahead approach). The emulation planner's per-interval computation is significantly more accurate.

5. **Stepped planner slow onset** — by design (conservative). Takes 8-10 min to reach target.

## Roadmap

### Near-term

- [ ] Close the remaining bolus gap — port SimTIVA's `delta_seconds` handling and exact `scheme_bolusadmin` correction for step-up UDF computation (closes ~5mg step-up gap, ~2 mL/h first-rate gap)
- [ ] Add Session 9 fixes to test suite (mechanistic rate correction, eigenstate sync)

### Medium-term

- [ ] PWA polish: service worker, offline support, app icons, portrait overlay
- [ ] Disclaimer/about screen
- [ ] Remifentanil TCI support
- [ ] Multi-drug interaction display

### Completed

- [x] Fentanyl PK model — Shafer 1990, ng/mL display (v0.5.0)
- [x] Ketamine PK model — Domino/Clements 1982, ng/mL display (v0.5.0)
- [x] Intermittent bolus mode — IV-push only, redose threshold, countdown (v0.5.0)

## Test Suites

| Suite | Tests | Coverage |
|---|---|---|
| `test-pk.js` | 44 | Eleveld params, matrix-exp, compartment dynamics |
| `test-model.js` | 42 | Simulation facade, event handling, concentrations |
| `test-decay.js` | 15 | Decay prediction, context-sensitive times |
| `test-tci-scheme.js` | 16 | TCI planner output validation |
| `test-vs-simtiva.js` | 24 | Cross-validation against SimTIVA values |
| `test-integration.js` | 25 | End-to-end event scenarios |
| `test-sim-v2.js` | 45 | Simulation v2 stateless facade |
| `test-t0-edge.js` | 40 | t=0 boundary and edge cases |
| `test-unit-safety.js` | 18 | Unit parameter validation |
| `test-units.js` | 39 | Unit conversion, display formatting |
| `test-fentanyl-pk.js` | 28 | Shafer 1990 parameters, Shibutani 2004 pkMass, BMI criteria |
| `test-ketamine-pk.js` | 23 | Domino/Navarrete fixed-Kij parameters, V1 scaling |
| **Total** | **359** | |

All tests passing as of 2026-04-06 (v0.5.3).
