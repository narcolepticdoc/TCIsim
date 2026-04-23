# Floor-aware rate selection — design proposal

Status: **not implemented; future work.** Written 2026-04-22 on branch
`claude/test-tci-tolerance-slider-bqElU` after the peak-aware experiment
in v0.5.25 was reverted. Companion to `TCI-TOLERANCE-ANALYSIS.md §8`.

## Context and motivation

The v0.5.25 correction pass uses an endpoint-only binary search at
`js/sim/tci/emulation.js:512-539`:

```js
// Binary search: rate where Ce = ceTarget after PROBE minutes.
let lo = 0, hi = cfg.maxRate;
for (let iter = 0; iter < 25; iter++) {
  const mid = (lo + hi) / 2;
  engine.setState(state);
  engine.advance(PROBE, mid);
  if (engine.getConcentrations().Ce < ceTarget) lo = mid; else hi = mid;
}
const rate = qRate((lo + hi) / 2);
```

This constrains only `Ce(+PROBE) = target` — what Ce does *between* 0
and PROBE is unconstrained. For heavy patients with a large V3 sink,
redistribution from plasma to V3 drops Ce noticeably in the first few
minutes of the step even though it hits target at +PROBE. The
`test-tci-ce-tracking.mjs` run for the 90 kg / target 3.5 fixture
shows a ~5.85% midpoint dip — within the relaxed 7% transient margin,
but noticeably worse than the 1–3% dip seen in normal-weight fixtures.

Clinically, 5–6% undershoot for the first 15 min of maintenance is
acceptable — patients stay anesthetized. But it's the remaining
visible deviation from tight tracking in our otherwise-clean planner,
and it scales with patient size.

The peak-aware attempt (v0.5.25, reverted) tried to fix this by
adding an upper-bound constraint on max Ce over MAX_DUR. It produced
severe undershoot because the peak constraint fought the endpoint
constraint during V3 filling (§8 of the analysis doc). **Floor-aware
is the inverse pattern and does not share that pathology.**

## Proposed change

Add a second binary search in the correction-pass main loop that finds
the rate where **min Ce over [0, PROBE] ≥ target × (1 - CE_TOL)**. Take
`max(endpointRate, floorRate)` as the selected rate.

### Why `max(endpoint, floor)` and not `min`

- **Endpoint** search says "rate must make Ce = target at +PROBE." If Ce
  is below target now, this rate is above steady-state — it's pushing
  Ce UP.
- **Floor** search says "rate must keep Ce from dipping below
  target × (1 - CE_TOL) during the step." Lower rates let Ce dip;
  higher rates prevent the dip.

Both constraints argue for a higher rate. Taking the max gives the
rate that satisfies both — reaches target at +PROBE AND doesn't dip
below tolerance midstream.

### Why this doesn't share peak-awareness's pathology

During V3 filling, plasma-to-V3 redistribution pulls Ce **down**. Any
constraint that wants to keep Ce up pushes rate up too. So floor
selection and endpoint selection are physically aligned — they both
demand a rate above long-term steady-state. No fight.

Peak-awareness (what was tried and reverted) wanted rate **down** to
prevent overshoot after V3 filled. That fought the endpoint's demand
for rate **up** to hit target now. Fundamental conflict, no resolution.

## Design sketch

Location: `js/sim/tci/emulation.js`, replacing the endpoint-only block
at lines ~517-539.

```js
// Search 1: endpoint — rate where Ce = ceTarget at +PROBE.
let lo1 = 0, hi1 = cfg.maxRate;
for (let iter = 0; iter < 25; iter++) {
  const mid = (lo1 + hi1) / 2;
  engine.setState(state);
  engine.advance(PROBE, mid);
  if (engine.getConcentrations().Ce < ceTarget) lo1 = mid; else hi1 = mid;
}
const endpointRate = (lo1 + hi1) / 2;

// Search 2: floor — rate where min Ce over [0, PROBE] ≥ target*(1-CE_TOL).
// Skipped when currentCe ≤ target*(1-CE_TOL) (Ce already below floor —
// floor search would return cfg.maxRate and waste compute). In that
// case the endpoint rate is the right answer: aggressively raise Ce.
const currentCe = engine.getConcentrations().Ce;
engine.setState(state);
let floorRate = endpointRate;
if (currentCe > ceTarget * (1 - CE_TOL)) {
  const floorLevel = ceTarget * (1 - CE_TOL);
  const sampleStep = 1; // 1-min granularity; matrix-exp cache keeps this cheap
  const sampleCount = Math.ceil(PROBE / sampleStep);
  let lo2 = 0, hi2 = cfg.maxRate;
  for (let iter = 0; iter < 25; iter++) {
    const mid = (lo2 + hi2) / 2;
    engine.setState(state);
    let minCe = Infinity;
    for (let s = 0; s < sampleCount; s++) {
      engine.advance(sampleStep, mid);
      const ce = engine.getConcentrations().Ce;
      if (ce < minCe) minCe = ce;
    }
    // If min Ce stays at or above the floor, rate is sufficient →
    // search lower. If min Ce dips below, rate is insufficient →
    // search higher.
    if (minCe < floorLevel) lo2 = mid; else hi2 = mid;
  }
  floorRate = (lo2 + hi2) / 2;
}
engine.setState(state);
const rate = qRate(Math.max(endpointRate, floorRate));
```

### Key design choices

- **Floor window = PROBE, not MAX_DUR.** The dip happens in the first
  few minutes of a step. Once the extension loop runs at +PROBE and
  either commits or bails, we're evaluating a new step from fresh
  state. No need to look further out.
- **Sample granularity = 1 min** (not `cfg.simStep = 0.1`). The matrix-
  exp cache means 1-min advances are cheap after warmup. Over 25
  iterations × ~14 samples (PROBE-dependent), total cost is small.
- **Skip the floor search when Ce is already below the floor.** Happens
  after an aggressive target increase or a missed step. The endpoint
  rate is already trying its best; floor search would clamp at maxRate
  and waste compute.
- **Binary-search direction.** Mirror-image of peak-aware: if `minCe <
  floorLevel` then rate is too low (the floor was breached), so raise
  the lower bound. Opposite sign from the peak-aware code that was
  reverted.

## Expected outcomes

### Tracking-test margins

Current `test-tci-ce-tracking.mjs` passes with `TRANSIENT_MARGIN = 0.07`
(= 7%). Expected post-change:

- **90 kg / 3.5** — the current problem case. Expected min Ce dip
  reduces from 5.85% to ≤3% (one `CE_TOL` × 2 = 3%).
- **70 kg / 3.0** — currently 3.36% dip. Expected ≤ 1.5% (1 × CE_TOL).
- **60 kg / 2.0** — currently 2.63% dip. Expected ≤ 1.5%.
- **75 kg / 2.5** — currently 1.73% dip. Expected ≤ 1.5%.

Could then tighten `TRANSIENT_MARGIN` to 0.03 (= 2 × CE_TOL, the
original aspirational value) and the test would still pass.

### Plan complexity

Step count should stay roughly the same. The rate is higher, so the
extension loop may bail slightly earlier as Ce drifts toward the
upper band instead of the lower one. Net effect on step count is
probably ±10% per fixture.

### Drug-delivered total

Slight increase. Heavier patients will receive ~2–5% more propofol
over the first hour. Still within the PK model's precision bounds.

## Validation plan

1. **Tighten `test-tci-ce-tracking.mjs`.** Reduce `TRANSIENT_MARGIN`
   from 0.07 to 0.03. All 4 existing fixtures should still pass.
2. **Add a heavy-patient fixture.** 120 kg, target 4.0. Currently
   would show the worst undershoot. Must pass under the tightened
   margin after the change.
3. **Regression.** `node tests/run-tests.js` — 485 tests should stay
   green.
4. **Diagnostic.** `node tests/test-tci-tolerance-diagnostic.mjs` —
   Loop A should still show ceTolerance moving the plan, with rate-
   step counts slightly different from current.
5. **Manual.** Reload the 90 kg / 3.5 propofol case in the browser.
   Ce curve should reach target after bolus+pause and stay within the
   visual tolerance band (if showCeBand is on) throughout
   maintenance. No visible mid-step dip.

## Risks and open questions

### Rate clamping at `cfg.maxRate`

For extreme patient sizes or very rapid V3 fill, the rate needed to
satisfy the floor could exceed `cfg.maxRate`. Graceful degradation:
the floor search clamps at maxRate, the resulting rate is the best
we can do, and the extension loop's CE_TOL check will still bail on
the dip. Behavior degrades to "undershoot is what it was, plus rate
held at maxRate" — no worse than endpoint-only, but also no better.
Acceptable.

### Transient overshoot near step end

If the chosen rate is "tight" — just satisfying both constraints —
Ce may overshoot slightly near the end of the step as V3 equilibrates.
The existing extension loop check (`|Ce - target| / target > CE_TOL`)
catches this at the next PROBE-multiple and closes the step. Known
behavior; already bounded. Acceptable.

### Interaction with `PROBE` scaling (ke0-derived)

`PROBE = max(10, min(30, 2/ke0))` per v0.5.25. The floor window
inherits this scaling. For fast-ke0 drugs (remifentanil, ke0 ≈ 0.6)
the floor window clamps to 10 min — which is still longer than the
actual redistribution transient (~3–5 min for remifentanil). Should
be fine, but needs per-drug sanity check when a remifentanil PK model
lands.

### Cost

~2000 extra `engine.advance` calls per maintenance step (14 samples
× 25 iterations, bounded). Matrix-exp cache makes each call sub-
millisecond after warmup. Total planning overhead probably still
under 100 ms for a full 12-hour plan. No UI impact.

## Decision criteria

**Build if:**

- A clinician reports the post-bolus dip is clinically visible or
  objectionable (e.g. "BIS bumps up too much during the first 15 min").
- We add a patient fixture that the current tracking test's 7% margin
  can't accommodate.
- A new drug with fast V3 kinetics (e.g. remifentanil) is added and its
  dip exceeds the margin.

**Don't build if:**

- The current 5–6% dip is inside clinical tolerance for all realistic
  patients (plausible — no clinician has complained yet).
- An alternative simpler fix is acceptable: shorter post-bolus pause
  or larger loading bolus. These have different tradeoffs (wastes
  drug, briefly overshoots target) but are zero additional code.

## Alternative approaches considered

1. **Shorter PROBE.** Forces more frequent rate updates. Would reduce
   dip magnitude at cost of plan readability. Fights the ke0-derived
   floor already clamping PROBE at 10 min.
2. **Bigger loading bolus.** Starts Ce higher going into maintenance.
   Transient overshoot, then dip into target. Different tradeoff; not
   obviously better.
3. **Shorter post-bolus pause.** Hands off to maintenance at higher
   Ce. Wastes a bit of drug but might eliminate the dip entirely.
   Simpler than floor-aware but less principled — it's "give up on
   precise bolus+pause timing."
4. **Rate scheduling with intentional ramp-up.** First step high, taper.
   Not standard TCI; would require UI rework.

Floor-aware is the simplest structural fix that addresses the root
cause without new UI concepts.

## Files that would change

- `js/sim/tci/emulation.js` — new floor-bounded search block replacing
  the endpoint-only block at lines ~517-539. ~30 lines.
- `tests/test-tci-ce-tracking.mjs` — tighten `TRANSIENT_MARGIN` from
  0.07 to 0.03, add 120 kg / target 4.0 fixture.
- `TCI-TOLERANCE-ANALYSIS.md §8` — update "Requirements for a future
  peak-aware implementation" to note that floor-aware was the chosen
  follow-up, with a link to this doc's post-mortem.
- `TCI-FLOOR-AWARENESS-PROPOSAL.md` (this file) — update status to
  "implemented" with commit reference.

## Estimated complexity

**Small.** One new binary-search block mirroring the reverted
peak-aware attempt but inverted. ~30 lines of code, one test tightening
+ one new fixture, two doc updates. Single commit. Same-branch.

## References

- **`TCI-TOLERANCE-ANALYSIS.md §8`** — peak-aware post-mortem,
  including why V3 filling makes upper-bound constraints incompatible
  with endpoint constraints in our correction pass.
- **`tests/test-tci-ce-tracking.mjs`** — current margins (0.07
  transient, 0.90 clinical floor) and fixture set (70, 60, 75, 90 kg).
- **`js/sim/tci/emulation.js:512-539`** — endpoint-only search block
  to be extended.
- **`js/sim/tci/shared.js:138-182`** (`findMaintenanceRate`) — reference
  dual-constraint implementation for the Stepped planner. Peak-aware,
  not directly reusable here, but its structure is a template.
- **Commits `76ad049` (peak-aware shipped) and `60b57c2` (reverted)** —
  the code diff that introduced and undid the peak-aware experiment.
  The revert commit's message spells out the specific pathology.
