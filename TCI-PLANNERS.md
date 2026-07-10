# TCI Planner Modes

Four TCI planning algorithms are available, selected on the setup screen. All share the same event system and PK engine — they differ only in how the loading bolus, pause timing, and maintenance rate schedule are computed.

## 1. Stepped (`planTCIScheme`)

The simplest approach. Independent of SimTIVA's algorithms.

**Loading:** Binary search for bolus dose where Ce at a ke0-derived lookahead = target. Produces a moderate bolus (~57mg for Ce=3.0) that doesn't overshoot Ce.

**Maintenance:** Binary search at each step for the rate that holds Ce at target. `runUntilDrift` advances until Ce leaves the ±5% band, then recalculates. `appendTerminalRates()` adds a long-lookahead binary-search rate (accounting for actual V3 level) and the analytical SS rate for asymptotic convergence.

**Characteristics:**
- Slowest onset (~8-10 min to reach target)
- Lowest Cp overshoot
- Fewest rate steps (simplest scheme)
- RMSE: ~20% (from-zero)

## 2. CET (`planTCISchemeCET`)

Ce-targeting bolus with peak matching.

**Loading:** Binary search for the bolus where peak Ce (after pump-rate delivery + zero-rate pause) = target. Produces a larger bolus (~141mg for Ce=3.0) that reaches target in ~3 min.

**Pause:** Forward scan at 1-second resolution to detect Ce peak. Maintenance starts when Ce begins falling.

**Maintenance:** Same as Stepped — binary search + drift detection + terminal rates. Uses ke0-derived lookahead and dual-constraint search (endpoint + peak prevention).

**Characteristics:**
- Fast onset (~2-3 min)
- Higher Cp overshoot during bolus phase
- RMSE: ~17% (from-zero)

## 3. CET Conservative (`planTCISchemeCETConservative`)

SimTIVA-style rate-corrected CET.

**Loading:** Uses `computeRateCorrFactor` (mechanistic UDF simulation, see below) to reduce the CET bolus. From zero: uses analytical UDF formula for bolus dose and peak time. From existing drug: uses binary search + correction ratio.

**Pause:** Analytical pause duration from SimTIVA's `peakTimeSec` calculation. Matches SimTIVA within 1 second.

**Maintenance:** Same as CET.

**Characteristics:**
- Slightly slower onset than CET (~3-4 min)
- Gentler hemodynamics (smaller Cp spike)
- RMSE: ~17% (from-zero)
- Bolus matches SimTIVA within 1-2mg

## 4. CET Emulation (`planTCISchemeEmulation`)

Direct port of SimTIVA's `deliver_cpt` maintenance algorithm running in eigenstate math space. Best accuracy.

### Loading

Same CET bolus + analytical pause as Conservative mode. Bolus rounded up to nearest 1mg (`Math.ceil`, matching SimTIVA).

For target step-ups with existing drug: uses SimTIVA's Ce-eigenstate formula:
1. Decompose Ce into 4 eigenstates via 4×4 Gaussian elimination (exact, zero error)
2. `trialDose = (target - vmCe(e_state, peak)) / e_udf[peak]` — accounts for existing drug
3. Iterative `find_peak` adjusts peak time
4. Apply rate correction factor

### Maintenance (SimTIVA deliver_cpt port)

**First pass:** 180 intervals × 120 seconds (6 hours). At each interval, compute the optimal Cp-targeting infusion rate using SimTIVA's analytical formula:
```
trialCp = virtualModel(eigenstate advanced 1s at current rate, projected +120s at zero)
testRate = (target - trialCp) / p_udf[120]
```
Eigenstate is advanced by 120 seconds at the computed rate. Produces a 180-element rate array.

**Ce-boost phase:** Three cases activate Ce-targeting intervals at maintenance start instead of immediately using the Cp-targeting formula:
- **No bolus, Ce below target** (`needsCeBoost`): 3 intervals of 5-minute Ce-targeting binary search
- **Large target decrease** (`needsCpLift`): Cp may be far below target after decay; 1–8 intervals hold Ce near target while Cp recovers
- **Post-bolus Cp overshoot** (`cpOvershoot`): when a bolus was delivered and `cpAtMaint > ceTarget × 1.02`, 2 intervals of Ce-targeting prevent the Cp-eigenstate lag from driving Ce above target

After each Ce-boost interval, `refitEigenstate()` resyncs `ps1/ps2/ps3` from the engine via Cramér's rule. Without this refit, the first Cp-targeting step is overestimated by ~10–15 mL/h.

**Second pass:** Step extraction scanning the rate array:
- Dynamic threshold and avgfactor based on early maintenance rate AND step magnitude:
  - `earlyRateMlH ≥ 30 AND stepMagnitude > 20%` → 8% threshold, 0.667 avgfactor (SimTIVA default for high-rate large step-ups)
  - Otherwise → 5% threshold, 0.62 avgfactor (catches subtle V3-equilibration corrections missed by 8%)
- `stepMagnitude = (ceTarget − Ce₀) / ceTarget` using Ce at plan start; small step-ups (<20% Ce increase, e.g. 3.5→4.0) use the tighter threshold even at high early rates
- 1 mL/h rounding (`roundingfactor = 360`)
- `wait_peak` handling for initial rate oscillation after CET bolus-pause

### Post-Extraction Correction Pass

The step extraction's `cptAvgFactor` averaging biases rates HIGH — SimTIVA compensates by replanning every 2 min, but our one-shot planner holds each rate for 30-120+ min. A correction pass replaces all SimTIVA maintenance rates (except the zero-rate pause after bolus) with binary-search-corrected steps:

1. **Adaptive spacing:** Each step targets Ce = target at a 15-min lookahead via binary search, then probes forward at 15-min increments while Ce stays within ±1.5% of target. Produces 15-min steps early (fast V3 equilibration) widening to 90-min steps late (near steady state). Typically ~19 rate events total.

2. **Analytical SS tail:** Appends the steady-state rate (`computeSteadyStateRate` from `steady-state-predictor.js`) beyond the correction horizon for t → ∞ convergence.

Result: Ce within ±1.5% across 900+ min, vs +4% drift at t=230 with the uncorrected SimTIVA extraction.

### Eigenstate Reconstruction

When maintenance starts from a non-zero state (second target change), the current engine state is decomposed into SimTIVA eigenstates via:

**Cp eigenstate (3×3 Cramér's rule):** Sample Cp at +10s, +60s, +300s at rate=0. Solve:
```
Cp(t_i) = s1·exp(-λ1·t_i) + s2·exp(-λ2·t_i) + s3·exp(-λ3·t_i)
```

**Ce eigenstate (4×4 Gaussian elimination):** Sample Ce at +5s, +30s, +120s, +600s at rate=0. Solve the 4×4 system including the ke0 eigenvalue.

Both give exact results (verified zero error at all sample points).

### Characteristics
- Fastest onset for step-ups (<1 min to 95%)
- Most accurate maintenance: Ce within ±1.5% across 900+ min (adaptive correction pass)
- Best target change handling (0% overshoot on step-ups)
- ~19 rate events with adaptive spacing (15 min early → 90 min late)
- Rapid target change: Ce=4.51 at t=30 for target 4.5 (vs 4.07-4.15 for other modes)

## Quantize In Display Units (opt-in)

When `cfg.quantizeInDisplay` is set (via the "Round TCI plan in display units" checkbox in the setup panel), every bolus and rate the planner emits is snapped to the clinician's chosen display-unit grid (e.g. nearest mL/h, nearest 10 mcg/kg, nearest 0.01 mcg/kg/min) **before** being fed back into `engine.advance`. The step sizes live in `DRUG_TASK_UNITS[drug][task].quantSteps[displayUnit]` in `js/util/constants.js`.

**Critical design point:** quantization happens *inside* the planning loop, not after. If the final scheme were rounded post-hoc, each iteration of the maintenance loop would have advanced the engine with the un-rounded value, so rounding error would stack across steps. Quantizing inside the loop means every `engine.advance()` call uses the value the pump will actually deliver, and the next iteration corrects from that true state.

`makeQuantizers(cfg)` in `js/sim/tci/shared.js` produces `qBolus`/`qRate` closures that resolve to identity functions when the flag is off (so all four planners' default behaviour is unchanged). When on, the closures call `quantizeInDisplay()` from `js/util/units.js` using the drug's stored `tci-pref-{task}Unit-{drug}` preference. Applied throughout the four planners in `js/sim/tci/stepped.js`, `cet.js`, `cet-conservative.js`, and `emulation.js`:

- **Stepped, CET:** `qBolus` on loading bolus, `qRate` on every maintenance-rate binary search result (initial + in-loop iterations + the 0.001 mg/min minimum-rate fallback).
- **CET Conservative:** `qBolus` on both the analytical zero-Ce path and the existing-drug rate-corrected bolus. Rate-side quantization happens via delegation to CET, which already quantizes — but the pre-quantized `bolusOverrideMg` bypasses CET's own bolus quantization to avoid double-snapping.
- **CET Emulation:** `qBolus` on zero-Ce and trial-dose boluses; `bolusDurSec` uses `cfg.quantizeInDisplay ? bolusMg : Math.ceil(bolusMg)`; legacy `Math.ceil(bolusMg)` is gated behind `!cfg.quantizeInDisplay`; the `rnd` closure (previously hard-coded nearest 1 mL/h at 10 mg/mL) becomes `(r) => qRate(r*60)/60`; in the post-extraction adaptive correction pass `rate` is quantized **before** the forward-probe extension loop so probe duration matches the delivered rate; the final SS rate is quantized before being appended.
- **appendTerminalRates:** the long-lookahead binary-search rate and the analytical SS rate are both quantized before being pushed.

The flag defaults off and is opt-in. All 426 pre-existing tests keep passing (closures are no-ops) plus 29 new tests covering the quantization math and stacking-error regression.

### Two-tier tail grid — steady-state oscillation fix (v0.5.44.4)

Rounding every maintenance step to the display grid produces a **quantized-actuator limit cycle** on very long cases. Once V3 saturates (k31 ≈ 0.0048/min, t½ ≈ 144 min for the reference adult), the required rate barely changes between probes and the true steady-state rate lands *between* two grid points. The memoryless per-probe re-rounding then flip-flops between the two brackets (e.g. 90 ↔ 95 mcg/kg/min every ~`PROBE` ≈ 14 min), sawtoothing Ce within its ±`CE_TOL` band. Because Ce_ss is exactly linear in rate, the settled Ce gap between adjacent grid rates = grid-step / operating-rate; in mcg/kg/min (step 5) that is ~5.3% of a 3.5 target — larger than the ±1.5% band, so no grid rate can hold and the loop can never settle. It is worst in mcg/kg/min (coarsest unit) and at low targets (steeper PD, lower rate); mg/min (step 0.1) barely oscillates.

The correction pass uses a **two-tier grid**. Through induction and active maintenance it snaps on the normal grid — a clean descending staircase (…105, 100, 95) that deliberately rides the upper `CE_TOL` band (the accepted loading-phase overshoot). Only near steady state does it latch to a `TAIL_GRID_DIVISOR = 10` finer grid via `qRateFine` (0.5 mcg/kg/min / 0.1 mL/h / 0.01 mg/min). The ÷10 grid keeps the worst-case ½-step settled-Ce offset under `CE_TOL` for every unit and realistic target (coarsest case, Ce 1.0 in mcg/kg/min: 9.2% → 0.9%), so the extend-loop reaches `MAX_DUR` and the rate settles instead of hunting — Ce tail amplitude drops ~10–35× (to <0.05 µg/mL) and tail markers thin from ~1/`PROBE` to ~1/90 min. The fine grid is a clean pump-programmable number at/above the pump's own ~0.1 mL/h resolution, so `displayed == delivered` holds; a hard freeze to the analytical SS rate was rejected because it undershoots during residual V3 loading (a downward Ce sag ≈ 20.8% × (1 − V3 saturation)).

**Trigger = proximity to the steady-state rate (v0.5.44.6).** The switch latches once the *exact* (pre-round) rate is within `SS_PROXIMITY_STEPS = 3` coarse grid steps of the analytic steady-state rate: `computeSteadyStateRate(engine, ceTarget)` (state-independent, computed once). Keying off the SS rate — not the per-step decline, which the extend-loop makes small even while the rate is still far above SS (the original `FINE_TRIGGER_FRAC` per-step trigger engaged the fine grid at V3 ~20–32%, ~45–85 min in) — defers the fine grid to genuine near-saturation (≈V3 65–85%), so the coarse descending staircase runs the whole realistic case. `K=3` gives margin: for a SS rate near a grid midpoint the coarse grid cannot hold, so fine must engage a few steps early to pre-empt coarse hunting (fundamental to a coarse actuator). The terminal SS-rate append matches whichever grid the loop ended on. Because the planner is a pure function replanned from the current loaded state, a target change starts far from its new SS rate → coarse rounding resumes → re-converges (self-re-arming). Helpers live in `js/sim/tci/shared.js` (`TAIL_GRID_DIVISOR`, `qRateFine`, `rateGridStepMgMin`); `quantizeInDisplay` in `js/util/units.js` gained a `stepOverride` param. Inert when rounding is off. Regression coverage: `tests/test-tci-scheme.mjs` TEST 15 (tail amplitude, SS convergence, target-change) and TEST 16 (no premature coarse oscillation; fine engages near the SS rate).

## Rate Correction Factor

`computeRateCorrFactor` in `simtiva-reference.js` calculates the fraction by which bolus delivery duration is shortened to prevent Ce overshoot during pump delivery.

**Previous approach (linear approximation):** Tuned for a typical patient near 750 mL/h. Produced mean Ce peak error −8.4%, worst case −21.6% for large patients.

**Current approach (mechanistic UDF simulation):** Simulates Ce second-by-second during delivery using `e_coef`/`lambda`. Binary search finds the duration where the Ce peak matches the target. Patient-specific and drug-agnostic. Mean error reduced to −1.9%, worst case −7.2% (n=72 across 6 patients × 4 targets × 3 pump rates).

Typical factors: ~0.92 at 700–750 mL/h, ~0.97–0.99 at 1200 mL/h.

## Validation Summary

**35y M, 70kg, 170cm, Ce=3.0, 1000 mL/h:**

| Mode | Bolus | Steps | RMSE | Peak |
|---|---|---|---|---|
| Stepped | 57mg | 2 | 19.9% | +31% |
| CET | 141mg | 1 | 17.0% | +29% |
| CET(C) | 131mg | 1 | 17.3% | +29% |
| **Emulation** | **131mg** | **6** | **7.4%** | **+15%** |
| SimTIVA exact* | 128mg | 7 | 1.5% | +4% |

*SimTIVA's exact scheme run through our validated PK engine.

**3.5→4.0 step-up at 1000 mL/h:**

| Mode | Bolus | Time to 95% | Ce at +60 min | Ce at +240 min |
|---|---|---|---|---|
| Stepped | 75mg | 2.0 min | ≤4.05 | ≤4.05 |
| CET | 57mg | 1.0 min | ≤4.05 | ≤4.05 |
| CET(C) | 55mg | 1.3 min | ≤4.05 | ≤4.05 |
| **Emulation** | **38mg** | **0.8 min** | **≤4.05** | **≤4.05** |
| SimTIVA | 33mg | ~1 min | ~4.0 | ~4.0 |

## Remaining Gap vs SimTIVA

Long-term maintenance drift is solved — the post-extraction correction pass keeps Ce within ±1.5% indefinitely. The remaining gap is in the **loading bolus**: a ~2 mL/h first-rate difference traces to a 1mg bolus rounding difference (131 vs 128mg from-zero, 38 vs 33mg step-up). Both produce clinically equivalent Ce curves.

Closing this gap fully would require porting SimTIVA's `delta_seconds` handling for the step-up UDF computation and the exact `scheme_bolusadmin` rate correction for non-zero-state cases.
