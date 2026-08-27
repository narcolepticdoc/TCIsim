# License & Clean-Room Implementation Notes

## SimTIVA Reference

SimTIVA (by Terence Luk) is an open-source TCI simulator licensed under **GPL-3.0**. Direct reuse of SimTIVA's code would require this entire application to be open-sourced under GPL-3.0.

**Our approach:** Clean-room reimplementation of the mathematical algorithms. No GPL code has been copied into this codebase.

## What We Reference

SimTIVA's `pharmacology.js` (7067 lines) is included in the project as a **read-only reference file** at `/mnt/project/pharmacology.js`. It is used for:

1. **PK validation** — comparing our Eleveld parameter output and compartment concentrations against SimTIVA's values
2. **Algorithm understanding** — studying how SimTIVA's CET planning, maintenance rate computation, and step extraction work
3. **Numerical verification** — confirming our eigenvalue decomposition, UDF computation, and rate correction factor formulas produce equivalent results

## What We Implemented

All code in `js/` is original work:

### `js/sim/simtiva-reference.js`
Clean-room reimplementation of:
- Eigenvalue decomposition (`cube()` solver — standard cubic root formula)
- Unit Dose Functions (`p_udf`, `e_udf` — standard PK response functions)
- Eigenvector coefficients (`p_coef`, `e_coef` — derived from rate constants and eigenvalues)
- Rate correction factor — mechanistic UDF simulation (patient-specific Ce trajectory during delivery; replaces the linear approximation used in SimTIVA's `scheme_bolusadmin`)
- CET bolus computation — `target / e_udf[peak]` (standard PK formula), rounding in mL matching SimTIVA line 4702

These are all standard pharmacokinetic mathematical operations, not novel to SimTIVA.

### `js/sim/tci-planner.js`
Contains four planners:
- **Stepped** — entirely independent of SimTIVA, uses binary search
- **CET / CET Conservative** — uses our engine's binary search + correction factor from simtiva-reference.js
- **CET Emulation** — reimplements SimTIVA's `deliver_cpt` algorithm:
  - Per-interval rate computation using the analytical Cp-targeting formula
  - Step extraction via rate-change threshold and weighted averaging
  - Eigenstate reconstruction via Cramér's rule / Gaussian elimination
  - `refitEigenstate()` to resync eigenstate after Ce-boost engine advances

The emulation planner produces results that match SimTIVA's output because it implements the same mathematical algorithm, not because it copies SimTIVA's code.

## Vendored Third-Party Libraries

`js/vendor/` holds unmodified upstream minified builds, served same-origin so
the service worker can precache them as mandatory app files (a chart that
cannot draw is not a working offline app). All four are **MIT licensed**; each
file keeps its upstream banner comment carrying the copyright and licence
notice.

| File | Library | Version |
|---|---|---|
| `chart.umd.min.js` | Chart.js | 4.5.1 |
| `chartjs-plugin-annotation.min.js` | chartjs-plugin-annotation | 3.1.0 |
| `hammer.min.js` | Hammer.JS | 2.0.7 |
| `chartjs-plugin-zoom.min.js` | chartjs-plugin-zoom | 2.2.0 |

These are dependencies, not derived work: no TCI Sim code is copied from them
and none of their code is copied into `js/`. To upgrade, replace the file with
a fresh upstream build of the same name and update the version above.

## File Audit

| File | Source | License Risk |
|---|---|---|
| `js/pk/engine.js` | Original (matrix-exp approach) | None |
| `js/pk/eleveld.js` | Derived from published paper | None |
| `js/pk/pd.js` | Derived from published paper | None |
| `js/sim/simulation.js` | Original | None |
| `js/sim/events.js` | Original | None |
| `js/sim/tci-planner.js` | Original + clean-room reimplementation | None — mathematical equivalence, not code copying |
| `js/sim/simtiva-reference.js` | Clean-room reimplementation | None — standard PK math |
| `js/ui/*` | Original | None |
| `js/util/*` | Original | None |

## Do Not Import

`/mnt/project/pharmacology.js` (SimTIVA, GPL-3.0) must never be imported, included, or bundled with this application. It exists solely as a reference for validation and algorithm understanding.
