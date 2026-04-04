# Development History & Roadmap

## Session History

### Sessions 1-6 (2026-03-25 to 2026-03-30)

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
- System events visible in history (rate-restores as dimmed italic rows)
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
- Cp: 3×3 Cramer's rule — exact decomposition for maintenance rate computation
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

## Known Issues

### Emulation Planner

1. **First maintenance rate ~2 mL/h lower than SimTIVA** — from 1mg bolus rounding difference (131 vs 128mg). Cascades through eigenstate into maintenance rates. Clinically insignificant.

2. **Step-up bolus ~5mg larger than SimTIVA** — from different `scheme_bolusadmin` correction computation for non-zero-state cases. Both produce 0% Ce overshoot.

3. **From-zero RMSE 7.4% vs SimTIVA's 1.5%** — the gap is entirely in the first 2-3 rate steps. From step 3 onward, rates and timing match exactly.

### Other Planners

4. **CET/CET(C) maintenance RMSE ~17%** — these modes produce 1 maintenance rate step (from the ke0-derived lookahead approach). The emulation planner's per-interval computation is significantly more accurate.

5. **Stepped planner slow onset** — by design (conservative). Takes 8-10 min to reach target.

## Roadmap

### Near-term

- [ ] Close the 1mg bolus rounding gap (port SimTIVA's `delta_seconds` handling)
- [ ] Port `scheme_bolusadmin` rate correction for non-zero-state step-ups
- [ ] Add Emulation mode test coverage to test suite

### Medium-term

- [ ] PWA polish: service worker, offline support, app icons, portrait overlay
- [ ] Disclaimer/about screen
- [ ] Intermittent bolus mode (model support exists, needs UI workflow)

### Long-term

- [ ] Fentanyl PK model (tracking only, not TCI)
- [ ] Ketamine PK model (tracking only, not TCI)
- [ ] Remifentanil TCI support
- [ ] Multi-drug interaction display

## Test Suites

| Suite | Tests | Coverage |
|---|---|---|
| `test-pk.js` | 43 | Eleveld params, matrix-exp, compartment dynamics |
| `test-model.js` | 42 | Simulation facade, event handling, concentrations |
| `test-decay.js` | 15 | Decay prediction, context-sensitive times |
| `test-tci-scheme.js` | 16 | TCI planner output validation |
| `test-vs-simtiva.js` | 24 | Cross-validation against SimTIVA values |
| `test-integration.js` | 25 | End-to-end event scenarios |
| `test-units.js` | 39 | Unit conversion, display formatting |
| **Total** | **204+** | |

All tests passing as of 2026-04-04.
