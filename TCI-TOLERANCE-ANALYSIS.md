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

## 2. How our planner works (plain-English walkthrough)

### The problem

A TCI pump runs at one rate at a time. To hold a patient's effect-site
drug level (Ce) at a target, we need a sequence of rate steps — a handful
per case is tolerable, every 30 seconds is unworkable.

The catch: the "correct" rate isn't constant. It starts high (to fill up
peripheral tissues) and decreases over minutes to hours (as those tissues
equilibrate). A flat rate either overshoots late or undershoots early.

### The mental picture — three linked buckets

- **Plasma** — what you pour drug into; the liver slowly clears it.
- **Fast tissue (muscle)** — slowly absorbs from plasma, slowly returns.
- **Slow tissue (fat)** — very slowly absorbs, very slowly returns.

You want a steady level in the plasma bucket. Pour fast and plasma fills
AND the side-buckets start filling. Once the side-buckets approach
equilibrium, you can maintain plasma with a trickle. The ideal pour rate
**declines** over time.

A fourth compartment, **effect site** (Ce), lags plasma slightly. For this
walkthrough, treat Ce as "basically plasma, delayed a bit".

### SimTIVA's strategy — continuous replanning

SimTIVA is a live training simulator (see §5). Its `deliver_cpt`:
1. Right now, compute the ideal rate that would bring plasma back to
   target over the next 2 min.
2. Hold that rate.
3. As simulated time advances (`runinfusion2` tick, every ~1 s of
   sim-time), re-run the whole computation with fresh state.
4. The pump only sees a new setting when the newly computed ideal has
   drifted more than `cpt_threshold` from the last programmed rate.

Between pump changes, the actual pump rate and SimTIVA's ideal drift
apart — but SimTIVA absorbs the drift by replanning so frequently that it
never accumulates.

### Our strategy — one-shot plan with built-in drift-checking

We run the whole planner once, at the start. No live replanning. So the
plan has to stay accurate for hours, not just a few minutes. Three
phases:

**Phase 1 — SimTIVA's forward ideal-rate scan** (`emulation.js:307-344`).
Walk forward in 2-min slots for 12 hours (360 slots; SimTIVA itself does
6 hours in `deliver_cpt`). At each slot, compute the ideal Cp-targeting
rate using pure eigenstate arithmetic. Store all 360 ideal rates in
`cptRates[]`. Ported verbatim from SimTIVA.

**Phase 2 — SimTIVA's step extraction** (`emulation.js:367-441`). Scan
`cptRates[]` and emit a new pump step when consecutive ideals differ by
more than `cptThreshold`. The emitted value is a weighted blend of old
and new ideal rates (`cptAvgFactor`, biased toward the old — the smoothing
lag we've discussed elsewhere). Ported verbatim.

If we stopped here, the first 10-20 minutes would track target Ce very
well (SimTIVA's ideal computation is accurate at short range), but by 30
min and beyond, Ce would drift off target. SimTIVA never experiences that
drift because it replans continuously. We would.

**Phase 3 — our correction pass** (`emulation.js:454-521`). The part
SimTIVA doesn't have. Walk the phase-2 plan forward through a simulated
engine and break steps wherever Ce would actually drift outside ±`CE_TOL`.
Detailed below in §3.

### Why the trade-off works

SimTIVA does **frequent soft replans with lag-smoothing**. We do **one
plan with active drift-checking**. Both converge on similar Ce
trajectories. Theirs is a live tool; ours is a static schedule a
clinician can print and follow.

### Knobs, in plain English

- **`CE_TOL` (1.5%)** — how far Ce is allowed to drift before we break
  the current step. Smaller = more steps, tighter tracking; larger =
  fewer steps, more wander.
- **`PROBE` (15 min)** — how far ahead we look AND the step-extension
  increment. Effective floor on step duration.
- **`MAX_DUR` (90 min)** — hard cap on any single step's duration, so
  even at perfect steady state a rate refresh gets issued.

### Why "lazy / accurate" should bind to `CE_TOL`, not `cpt_threshold`

SimTIVA's lazy/accurate toggle fires during phase 2 — the step extraction.
Our phase 3 then deletes and regenerates everything from `maintTime`
onward based on `CE_TOL`. So moving `cpt_threshold` in our port has a
muted effect (phase 3 rewrites most of what it did). `CE_TOL` is where
our plan actually reacts to drift, and where a clinician would feel the
difference.

---

## 3. Our correction pass in detail

Lives in `js/sim/tci/emulation.js:454-521`. Its job: replace phase 2's
SimTIVA-style maintenance steps (weighted averages held for 30–120+ min)
with steps produced by actually simulating the plan forward and breaking
wherever Ce would drift past tolerance.

### Setup (lines 455-457)

```js
const PROBE      = 15;    // min
const MAX_DUR    = 90;    // min
const CE_TOL     = 0.015; // 1.5%
```

Three constants govern everything.

### Identify `corrStart` (lines 462-463)

```js
const rateSteps = scheme.filter(s => s.type === 'rate');
const firstCorrIdx = rateSteps.findIndex(s => s.time >= maintTime);
```

Scheme events before `maintTime` — the loading bolus delivery window, the
zero-rate pause while the bolus peaks — are preserved untouched. They
represent the bolus phase; SimTIVA handles that correctly, and they're
already baked into `maintState` (the engine state snapshot taken at line
267 before phase 2 ran).

`corrStart` is the time of the first maintenance-phase rate event.
Everything at or after it gets regenerated.

### Horizon (line 467)

```js
const corrEnd = maintTime + cptIntervalCount * cptInterval / 60 + 180;
```

With `cptIntervalCount = 360` and `cptInterval = 120 sec`, that's
`maintTime + 720 + 180 = maintTime + 15 hours`. Long enough to plan
through full V3 equilibration (fat takes 4-6 h to fill).

### Re-position the engine at `corrStart` (lines 472-478)

Replay any uncorrected rate steps between `maintTime` and `corrStart`
through the engine, so we know the true compartment state at `corrStart`.
In practice `firstCorrIdx` is usually 0 or 1, so this loop runs rarely.

### Delete what we're about to regenerate (lines 481-485)

```js
for (let i = scheme.length - 1; i >= 0; i--) {
  if (scheme[i].type === 'rate' && scheme[i].time >= corrStart) {
    scheme.splice(i, 1);
  }
}
```

Wipe all rate events at or after `corrStart`. Bolus events and
pre-`corrStart` rates stay.

### The main loop (lines 490-519) — the heart of the correction pass

```js
for (let t = corrStart; t < corrEnd; ) {
  const state = engine.getState();

  // Binary search: rate where Ce = ceTarget after PROBE minutes
  let lo = 0, hi = cfg.maxRate;
  for (let iter = 0; iter < 25; iter++) {
    const mid = (lo + hi) / 2;
    engine.setState(state);
    engine.advance(PROBE, mid);
    if (engine.getConcentrations().Ce < ceTarget) lo = mid; else hi = mid;
  }
  const rate = qRate((lo + hi) / 2);

  // Probe forward: extend this rate while Ce stays within tolerance
  let dur = PROBE;
  while (dur + PROBE <= MAX_DUR && t + dur + PROBE <= corrEnd) {
    engine.setState(state);
    engine.advance(dur + PROBE, rate);
    if (Math.abs(engine.getConcentrations().Ce - ceTarget) / ceTarget > CE_TOL) break;
    dur += PROBE;
  }

  scheme.push({ type: 'rate', time: t, value: rate });
  engine.setState(state);
  engine.advance(dur, rate);
  t += dur;
}
```

Five substeps per iteration:

**(A) Snapshot engine state at `t`.** Needed so the forthcoming probes
can each start clean.

**(B) Binary-search the rate hitting Ce = target at `t + PROBE`**
(25 iterations over `[0, cfg.maxRate]`). 2²⁵-fold precision — effectively
exact. Monotonic: higher rate → higher Ce, no local traps.

**(C) Quantize with `qRate` BEFORE the extension loop** (line 504).
Critical: we need to probe with the rate the pump will actually deliver,
not an idealized fractional rate. Quantizing after would make extension
stop too early or too late under rounding.

**(D) Extension loop** (lines 507-513). Probe: "if we held this rate for
`dur + PROBE` minutes, would `|Ce - target| / target` exceed `CE_TOL`?"
Reset engine to `state` between each probe. Stop when the answer becomes
yes — current `dur` is the longest hold.

**(E) Commit the step** (lines 515-518). Push `{type: 'rate', time: t,
value: rate}`, advance the engine `dur` minutes at `rate`, jump `t` by
`dur`. Repeat.

### Emergent adaptive step spacing

The comment at lines 450-453 says it well:

> This gives tight control when V3 equilibrates fast (~15-30 min steps
> early) and relaxed control when the rate barely changes (~60-90 min
> steps late).

Why it happens:
- **Early in maintenance**, V3 is still filling. The rate needed to hold
  Ce at target is declining noticeably over 15-30 min windows. The
  binary-search rate at minute 20 is already wrong 30 minutes later, so
  the extension loop bails after one or two extensions. Short steps.
- **Late in maintenance**, V3 is near-equilibrium. The rate needed
  changes slowly. The binary-searched rate holds Ce within 1.5% for a
  long time. Extension succeeds up to the `MAX_DUR` cap. Long steps.

No explicit "early vs late" logic. It falls out of physics + `CE_TOL`.

### What makes this different from SimTIVA

SimTIVA's step extraction (phase 2) asks: *"has the ideal rate changed
enough to warrant a new pump setting?"* (`cpt_threshold`,
`cpt_avgfactor`). A heuristic comparing consecutive ideal-rate values.

Our correction pass asks: *"if I held this rate, would Ce actually drift
outside tolerance?"* A simulation of the plan's real behaviour.

Both arrive at similar places for the first few minutes (where V3 is
filling fast), but diverge later — where SimTIVA's heuristic emits huge
steps that look fine by rate-change metrics but would accumulate Ce drift
under a non-replanning model, and ours catches the drift by direct
simulation.

### One caveat worth knowing

This pass is why TCIsim tracks Ce very tightly but can emit more steps
than SimTIVA over the same plan horizon. If a clinician compares
"SimTIVA shows 4 rate steps, TCIsim shows 8" and complains about
clutter, the correct response is: TCIsim's extra steps each correct real
drift that SimTIVA would also correct — SimTIVA just hides them by
replanning continuously instead of showing the full plan upfront.

---

## 4. Where the real drift-tolerance knobs live

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

## 5. SimTIVA — live-sim architecture and preset semantics

Source: `luktinghin/simtiva` on GitHub. **GPL-3.0 — reference only, do
not import or copy code.** Mechanics below are described, not lifted,
for the purpose of informing our own design.

### Live-sim architecture

SimTIVA is a live training simulator, not a one-shot planner. This matters
for interpreting every claim elsewhere in this doc about "SimTIVA does X".

**Wall-clock-driven advancement with a `simspeed` multiplier** (`main.js`):

```js
var now = Date.now();
time += (now - offset) * simspeed;
offset = now;
time_in_s = time / 1000;
```

`simspeed = 1` by default (1:1 real time); setting it higher accelerates
the simulator (e.g. `simspeed = 10` runs 10 sim-seconds per wall-clock
second). Standard training-sim time-compression pattern.

**Three parallel `setInterval` loops** (`main.js`):

```js
loop1 = setInterval(update, 500);         // UI refresh @ 500 ms
loop2 = setInterval(runinfusion2, refresh_interval);  // PK tick (~1 s)
loop3 = setInterval(updatechart, 5000);   // Chart render @ 5 s
```

Each loop reads the `simspeed`-scaled `time_in_s`, so acceleration works
across all of them without per-loop special-casing.

**Separate time axes:**
- `time_in_s` — simulated elapsed seconds, the PK engine's time axis.
- `working_clock` — integer timestamp used as an array index into
  per-second precomputed values. Matches the 1-sec eigenstate stepping
  from ARCHITECTURE.md:22.
- `offset` — wall-clock reference point for computing deltas between
  ticks.

**`deliver_cpt` replanning is event-driven, not strictly periodic.**
Target changes trigger an immediate call:

```js
deliver_cpt(parse_historyarray[count][3], 0, 0, 0);  // immediate on target change
```

Plus it's invoked periodically by `runinfusion2` to keep the plan fresh
as sim-time advances. The `cpt_interval = 120 sec` value that appears
inside `deliver_cpt` is the **internal forward-scan grain** within one
call, **not the replan cadence**. The actual replan cadence is
continuous at the `runinfusion2` tick rate (~1 s), plus on events.

> **Correction to earlier notes in this doc and in code comments:**
> Several places (including `emulation.js:443-448`) describe SimTIVA as
> "replanning every 2 min". That's inaccurate. SimTIVA replans
> continuously; "2 min" is the internal forward-scan interval within
> `deliver_cpt`. A future comment cleanup could restate this as:
> "SimTIVA replans continuously as sim-time advances; our one-shot
> planner substitutes that with an active drift-checking pass."

**Pause / jump / suspend:**
- `drug_sets[ind].running` — per-drug pause flag.
- `timeFxSuspend()` / `timeFxResume()` — time-freeze utilities.
- `jump()` — fast-forward through periods. The `sendtoreanimate` /
  `sendtowakeup` flows accept duration parameters, so users can skip
  ahead to emergence or wakeup.

### The "auto / lazy / accurate" presets

Located in `pharmacology.js` ≈ lines 1950-2003. The presets toggle two
constants — `cpt_threshold` (rate-change emission threshold) and
`cpt_avgfactor` (weighting toward the prior rate). The mapping is
**per-drug**, and not every drug has all three modes.

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

## 6. Design options if we ever wire a real tolerance toggle

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

## 7. Quick references

### Our codebase

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
| Phase 1 (forward ideal scan) | `js/sim/tci/emulation.js:307-344` | 360-slot eigenstate scan |
| Phase 2 (step extraction) | `js/sim/tci/emulation.js:367-441` | `cptThreshold`/`cptAvgFactor` logic |
| Phase 3 (correction pass) | `js/sim/tci/emulation.js:454-521` | `CE_TOL` drift-checking |
| `cptThreshold` (auto) | `js/sim/tci/emulation.js:353` | 0.08 or 0.05 |
| `cptAvgFactor` (auto) | `js/sim/tci/emulation.js:354` | 0.667 or 0.62 |
| `rf` (rounding factor) | `js/sim/tci/emulation.js:355` | 360 |
| `PROBE` | `js/sim/tci/emulation.js:455` | 15 min |
| `MAX_DUR` | `js/sim/tci/emulation.js:456` | 90 min |
| `CE_TOL` | `js/sim/tci/emulation.js:457` | 0.015 (1.5%) |
| Correction horizon | `js/sim/tci/emulation.js:467` | `maintTime + 15h` |
| Binary-search iterations | `js/sim/tci/emulation.js:495` | 25 |
| Diagnostic script | `tests/test-tci-tolerance-diagnostic.mjs` | Loop A + Loop B |

### SimTIVA (read-only, GPL-3.0, not to be imported)

| Symbol | Location | Value |
|---|---|---|
| `simspeed` | `main.js` | time multiplier, default 1 |
| `time_in_s` | `main.js` | simulated seconds axis |
| `working_clock` | `main.js` | integer-sec indexer |
| `offset` | `main.js` | wall-clock reference point |
| `loop1 = setInterval(update, 500)` | `main.js` | UI refresh @ 500 ms |
| `loop2 = setInterval(runinfusion2, …)` | `main.js` | PK tick (~1 s) |
| `loop3 = setInterval(updatechart, 5000)` | `main.js` | chart render @ 5 s |
| `deliver_cpt` replan cadence | `main.js` + events | continuous, not fixed-period |
| `cpt_threshold` / `cpt_avgfactor` presets | `pharmacology.js` ≈ 1950-2003 | per-drug lazy/accurate/auto |
| Upstream repo | `https://github.com/luktinghin/simtiva` | reference only |
