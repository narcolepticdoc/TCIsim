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
