# TCI Tolerance & "Lazy/Accurate" Presets — Analysis

Reference notes for future work on the "TCI target tolerance" slider, the
CET emulation planner's internal drift-control knobs, and SimTIVA's
`auto / lazy / accurate` presets. Generated on branch
`claude/test-tci-tolerance-slider-bqElU`.

---

## 1. The "TCI target tolerance" slider is disconnected from the planner

### The slider

- **DOM:** `index.html:1341` — `<input type="range" id="set-tci-fraction" min="90" max="99" step="1" value="95">` with label "TCI target tolerance (% of target)".
- **Setting key:** `tciFraction` (0.90–0.99, default 0.95). Stored under `'tci-warn-settings'` in localStorage.
- **Storage/retrieval:** `js/ui/settings.js:25` (default) and the get/set helpers therein.
- **UI wiring:** `js/app/settings-ui.js:61-62, 89-90, 114-115, 131, 138, 147`.

### What it actually drives

Only the drug-panel "time to target" readout: `js/app.js:451`

```js
getTciFraction: () => settings.getSettings().tciFraction,
```

### What it does NOT drive

The TCI planner. The invocation at `js/app.js:338` is:

```js
model.planTCI(selectedDrug, t, canonicalValue, { tciMode, ...getQuantizeConfig(selectedDrug) });
```

`tciFraction` is absent from `tciConfig`. The facade at `js/sim/simulation.js:234-246`
builds `planConfig` from `tciConfig` plus pump/quantize keys — it never maps
`tciFraction → tolerancePct`.

Inside the planner (`js/sim/tci/emulation.js:29`):

```js
const cfg = { ...DEFAULT_SCHEME_CONFIG, ...config };
```

So `cfg.tolerancePct` always falls back to the hardcoded
`DEFAULT_SCHEME_CONFIG.tolerancePct = 0.05` at `js/sim/tci/shared.js:26`.

### Diagnostic

`tests/test-tci-tolerance-diagnostic.mjs` — standalone, run with
`node tests/test-tci-tolerance-diagnostic.mjs`. Two loops:

- **Loop A (UI path):** sweeps `tciFraction ∈ {0.90, 0.92, 0.95, 0.97, 0.99}`
  through cfg the way a naive "slider is wired" assumption would. Result:
  all 5 plans byte-identical to baseline. Confirms the slider is dead.
- **Loop B (direct knob):** sweeps `tolerancePct ∈ {0.01, 0.02, 0.05, 0.10, 0.15}`
  directly into cfg. Result: also byte-identical. Even the underlying
  `tolerancePct` knob has no effect on CET emulation plans from Ce = 0
  because (a) `needsBolus = 0 < 3*(1-tol)` is true for every tol in range,
  (b) the `upperBound = ceTarget*(1+tol)` target-decrease branch isn't
  entered from Ce = 0, and (c) the maintenance loop doesn't consult
  `tolerancePct` at all.

### Where `tolerancePct` is used in the emulation planner

- `js/sim/tci/emulation.js:42` — `upperBound = ceTarget * (1 + cfg.tolerancePct)` — only consulted in the target-decrease branch (`if (currentCe > upperBound)` at line 197).
- `js/sim/tci/emulation.js:49` — `needsBolus = currentCe < ceTarget * (1 - cfg.tolerancePct)` — loading-bolus gate.

Neither controls maintenance-phase drift. So even if the slider were wired,
it wouldn't change plan shape for typical from-zero cases.

---

## 2. Where the real drift-tolerance knobs live

The CET emulation planner's **post-extraction Ce correction pass** at
`js/sim/tci/emulation.js:454-521` is what actually decides how far Ce is
allowed to drift before a new rate step is emitted. Three constants:

| Constant | File:line | Default | Role |
|---|---|---|---|
| `CE_TOL` | `js/sim/tci/emulation.js:457` | **0.015** (1.5%) | Max fractional Ce deviation before the current step is abandoned and a new one is emitted. **The primary drift-tolerance knob.** Smaller → more steps, tighter control; larger → fewer steps, more drift. |
| `PROBE` | `js/sim/tci/emulation.js:455` | 15 min | Binary-search lookahead + step-extension increment. Effective floor on step duration. |
| `MAX_DUR` | `js/sim/tci/emulation.js:456` | 90 min | Hard cap on any single step's duration. |

The relevant loop (`emulation.js:490-519`): binary-search the rate that hits
target at +`PROBE` minutes, then keep extending the step in `PROBE`-minute
increments as long as `|Ce − target| / target ≤ CE_TOL`. First excursion
outside that band closes the step and starts a new one.

### Secondary knobs (first-pass, upstream of `CE_TOL`)

- **`cptThreshold`** — `js/sim/tci/emulation.js:353` — 0.05 or 0.08, dynamically selected. Threshold for emitting a new step during SimTIVA's first-pass step extraction.
- **`cptAvgFactor`** — `js/sim/tci/emulation.js:354` — 0.62 or 0.667. Weights each emitted step's value toward the prior rate.
- **`cptInterval`** — `js/sim/tci/emulation.js:214` — 120 sec. Resolution of the first-pass Cp-targeting loop.
- **`rf` (rounding factor)** — `js/sim/tci/emulation.js:355` — 360. Rounds rates to nearest 1 mL/h (for 10 mg/mL).

These affect the rates fed into the `CE_TOL` correction pass, but because
that pass deletes and regenerates everything at `maintTime` onward
(`emulation.js:480-519`), their visible effect on the final scheme is damped.

### Not a tolerance knob

- `DEFAULT_SCHEME_CONFIG.tolerancePct` — only gates the loading bolus and
  target-decrease pause (section 1 above). Don't mistake it for maintenance
  tolerance.
- `cfg.rateStablePct` — declared in `DEFAULT_SCHEME_CONFIG` but used by the
  stepped planner, not emulation.

---

## 3. SimTIVA's "auto / lazy / accurate" presets

Source: `luktinghin/simtiva` on GitHub, `pharmacology.js` ≈ lines 1950-2003.
**GPL-3.0 — reference only, do not import or copy code.** Mechanics below
are described, not lifted, for the purpose of informing our own design.

The presets toggle two constants — `cpt_threshold` (rate-change emission
threshold) and `cpt_avgfactor` (weighting toward the prior rate). The
mapping is **per-drug**, and not every drug has all three modes.

### Per-drug table (threshold / avgfactor)

| Drug | Lazy | Accurate | Auto (rate-dependent) |
|---|---|---|---|
| **Propofol** | *(no override)* | *(no override)* | `cpt_rates[5]*360 ≥ 30 mL/h` → 0.08 / 0.667, else 0.05 / 0.62 |
| **Dexmedetomidine** | 0.25 / 0.50 | 0.15 / 0.75 | `>10 μg/kg/min` → 0.25 / 0.50, else 0.15 / 0.75 |
| **Ketamine** | 0.15 / 0.52 | 0.10 / 0.65 | `>5 μg/kg/min` → 0.15 / 0.52, else 0.10 / 0.65 |
| **Alfentanil** | *(no override)* | *(no override)* | `>100 μg/kg/min` → 0.15 / 0.63, else 0.25 / 0.44 |

Pattern for dexmed/ketamine: **lazy = the auto high-rate branch**,
**accurate = the auto low-rate branch**. The user-facing toggle just
forces the branch auto would have picked.

### Our port's status

`js/sim/tci/emulation.js:349-354` already mirrors SimTIVA's propofol auto
logic verbatim:

```js
// SimTIVA lines 1250-1259: propofol with cpt_rates[5]*360 >= 30 uses 0.08/0.667,
// lower rates use 0.05/0.62
const earlyRateMlH = (cptRates[5] || cptRates[0]) * 3600 / concentration;
const stepMagnitude = currentCe > 0 ? (ceTarget - currentCe) / ceTarget : 1;
const cptThreshold = (earlyRateMlH >= 30 && stepMagnitude > 0.20) ? 0.08 : 0.05;
const cptAvgFactor = (earlyRateMlH >= 30 && stepMagnitude > 0.20) ? 0.667 : 0.62;
```

The `stepMagnitude > 0.20` guard is ours (not in SimTIVA); everything else
matches. So we currently implement propofol-auto by default and there is no
lazy/accurate analogue — **consistent with SimTIVA's choice not to expose
those presets for propofol**.

### Semantic caveat

SimTIVA's lazy/accurate is a **rate-change** threshold (emit a new step
when computed rate differs from prior by >threshold). Our `CE_TOL` is a
**Ce deviation** threshold (emit when Ce drifts outside ±band). They
operate at different levels:

- `cpt_threshold` acts during first-pass step extraction.
- `CE_TOL` acts in our post-extraction pass — which SimTIVA has no
  equivalent of, because it replans every 2 min during a live case
  (SimTIVA lines 1287-1492 pattern detection; the replan cadence is
  structural to SimTIVA's UI loop, not a tunable).

For a propofol TCI where clinicians should actually *feel* "lazy vs
accurate", `CE_TOL` is the more direct binding. For strict SimTIVA
faithfulness, expose `cptThreshold`/`cptAvgFactor` and match the per-drug
design (no toggle for propofol or alfentanil, toggle only for dexmed and
ketamine).

---

## 4. Design options if we ever wire a real tolerance toggle

### Option A — relabel, do nothing to the planner

The current slider drives only the time-to-target readout. Rename the
label to reflect that. No planner change. Zero-risk.

- Edit the label at `index.html:1341`.
- Keep `tciFraction` key name (in-use by the readout already).

### Option B — wire `tciFraction → tolerancePct` (SimTIVA-unlike)

Cheapest wiring, but as the diagnostic shows, it only affects the loading
bolus + target-decrease branches — not maintenance. Clinically near-
invisible for from-zero plans. **Not recommended without also addressing
maintenance.**

- Add `tolerancePct: 1 - tciFraction` to `planConfig` in
  `js/sim/simulation.js:234-246`.
- Pull `tciFraction` from `settings.getSettings()` in `js/app.js:338`.

### Option C — expose `CE_TOL` as a three-way preset (recommended if clinicians want to feel it)

New setting, e.g. `ceTolerance ∈ { accurate: 0.005, auto: 0.015, lazy: 0.030 }`.

- Add a segmented control to `index.html` Behavior tab + wire in `js/app/settings-ui.js` and `js/ui/settings.js`.
- Replace the hardcoded `const CE_TOL = 0.015` at `js/sim/tci/emulation.js:457` with `cfg.ceTolerance ?? 0.015`.
- Add `ceTolerance` to `planConfig` in `js/sim/simulation.js:234-246`.

Optional companion adjustments to keep the three presets distinct:
- `accurate`: also tighten `PROBE` (15 → 10) and/or `MAX_DUR` (90 → 60).
- `lazy`: loosen `PROBE` (15 → 30), `MAX_DUR` (90 → 180).

### Option D — SimTIVA-faithful per-drug `cptThreshold`/`cptAvgFactor` toggle

For **dexmed and ketamine only** (matching SimTIVA's choice), add a
three-way `cet-preset` per drug. Propofol and alfentanil stay on auto.
Replace the dynamic selectors at `js/sim/tci/emulation.js:353-354` with
the table in section 3.

This is the "strict port" choice. Cleanest if the goal is to advertise
SimTIVA fidelity. But: only matters for dexmed/ketamine, and our ketamine
model is `Domino 1982 / Navarrete 2000` (see CLAUDE.md header) — check
that the SimTIVA auto-branch thresholds make sense for our ke0 before
importing those constants wholesale.

---

## 5. Quick references

| Symbol | Location | Value |
|---|---|---|
| `#set-tci-fraction` slider | `index.html:1341` | 90..99, default 95 |
| `tciFraction` default | `js/ui/settings.js:25` (via DEFAULTS) | 0.95 |
| `DEFAULT_SCHEME_CONFIG.tolerancePct` | `js/sim/tci/shared.js:26` | 0.05 |
| `planTCI` call site | `js/app.js:338` | (tciConfig excludes `tolerancePct`) |
| `planConfig` assembly | `js/sim/simulation.js:234-246` | spreads tciConfig + pump + quantize |
| `upperBound` (target-decrease) | `js/sim/tci/emulation.js:42,197` | uses `tolerancePct` |
| `needsBolus` gate | `js/sim/tci/emulation.js:49` | uses `tolerancePct` |
| `cptInterval` | `js/sim/tci/emulation.js:214` | 120 sec |
| `cptIntervalCount` | `js/sim/tci/emulation.js:281` | 360 intervals (720 min) |
| `cptThreshold` (auto) | `js/sim/tci/emulation.js:353` | 0.08 or 0.05 |
| `cptAvgFactor` (auto) | `js/sim/tci/emulation.js:354` | 0.667 or 0.62 |
| `rf` (rounding factor) | `js/sim/tci/emulation.js:355` | 360 |
| `PROBE` | `js/sim/tci/emulation.js:455` | 15 min |
| `MAX_DUR` | `js/sim/tci/emulation.js:456` | 90 min |
| `CE_TOL` | `js/sim/tci/emulation.js:457` | 0.015 (1.5%) |
| Diagnostic script | `tests/test-tci-tolerance-diagnostic.mjs` | Loop A + Loop B |

SimTIVA reference (read-only, GPL-3.0, not to be imported):
- `pharmacology.js` ≈ lines 1950-2003 — the per-drug `cpt_threshold` /
  `cpt_avgfactor` preset logic.
- Upstream repo: `https://github.com/luktinghin/simtiva`.
