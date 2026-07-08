# TCI Sim — Test Suite Guide

This is the map of the test suite: what each file guards, why it exists, and the
conventions that keep the suite honest. It's written to be read by a human
picking up the project, and to be the reference a future maintainer (or Claude
session) checks before adding or changing a test.

## Running

```bash
node tests/run-tests.js        # whole suite; exit 0 only if every file is green
node tests/test-<name>.mjs     # one file, with its full per-assertion output
```

The runner (`run-tests.js`) discovers every `test-*.js` and `test-*.mjs` in this
directory, runs each in **its own Node process**, and parses the `N passed, N
failed` line each file prints. A file that **crashes**, or exits cleanly but
prints **no summary line**, is counted as a failure — a test file can't pass by
silently doing nothing. There is no build step and no test framework; each file
is a plain script with a tiny inline `ok(cond, msg)` helper.

**The suite must be 100% green before any commit** (CLAUDE.md).

## The one rule that matters: test real code

The single most important convention, learned the hard way: **tests import the
real production modules and exercise them.** The suite was once full of files
that inlined a *copy* of the engine / Eleveld model / planners and tested the
copy; the copies silently drifted from production (one inline Eleveld was 337%
off for an elderly opioid patient) so the tests couldn't catch a real
regression. That's fixed — every file below either imports the shipping module,
or is one of the few deliberate, labelled exceptions (independent oracles and
scaffolding, described under Conventions).

If you're tempted to paste a formula or a helper into a test "to keep it
runnable," don't — import it. If it can't be imported (needs a DOM), shim the
DOM (see `test-settings-validation.mjs`) rather than copy the logic.

## How the suite is organized (five kinds of test)

Tests fail for different reasons and carry different trust. Knowing which kind
you're looking at tells you whether a red result means "the pharmacology is
wrong" or "a plan step moved by a minute."

### 1. External baselines — the ground truth

Validate the real math against an *independent* source of truth, not against its
own past output. These are the only tests that can catch "the model is wrong."

| File | Guards |
|---|---|
| `test-vs-simtiva.js` | The shipping matrix-exponential engine + Eleveld params vs an independent analytical eigenvalue solver — 0.0000% deviation. The gold standard for the engine. |
| `test-pk.js` | Eleveld propofol parameters against published-model expectations across a patient matrix. |
| `test-fentanyl-pk.mjs` / `test-ketamine-pk.mjs` | Fentanyl (Shafer/Shibutani) and ketamine (Domino/Navarrete) parameter calculators. |
| `test-steady-state-predictor.mjs` | Analytical steady-state Ce + plateau predictors; Ce_ss values are cross-checked against an independent matrix solve. |
| `test-decay.mjs` | Decay-to-trough predictor (time-for-Ce-to-fall-to-target). |
| `test-cubic-parity.js` | The two cubic-root solvers (`eigenvalues.js`, `simtiva-reference.js`) agree — the drift hazard that once caused a NaN bolus. |
| `test-util-math.mjs` | 4×4 linear algebra (`inv4`, `expm4`) against closed forms: diagonal exp = elementwise exp, nilpotent exp = I+N, A·A⁻¹ = I. |

### 2. Clinical-outcome contracts — does the real path do the clinically right thing

Drive the **real production entry point** and assert the therapeutic result,
not byte-exact output — so they survive legitimate tuning but redden on a broken
outcome.

| File | Guards |
|---|---|
| `test-tci-plan-fidelity.mjs` | The real `createModel().planTCI(… cet-emulation)` across 5 patients × 3 targets: onset ≤6 min, holds ±5% over 10–120 min, never below 90% clinical floor. The only test that drives the facade path behind the on-screen Ce card. |
| `test-integration.mjs` | Real-chain PK/PD curve *shape*: Ce lags Cp, Cp redistributes down, rate steps down, BIS tracks into the anaesthetic range, resolutions agree. Complements fidelity (shape vs endpoint). |
| `test-tci-scheme.mjs` | The cet-emulation planner reaches + holds target, step count is bounded, tighter tolerance ⇒ more steps, quantized plans still hold. |
| `test-tci-ce-tracking.mjs` | Maintenance Ce tracks target **both** directions (catches under- *and* over-shoot) with a hard clinical floor. |

### 3. Behavioral invariants — the specific mistakes this codebase has made

Guard documented invariants (many in CLAUDE.md) and past bugs.

| File | Guards |
|---|---|
| `test-pump-rate-correction.js` | Card (`getConcentrationsAt`) == graph (`computeCurve`) after a mid-case pump-rate correction re-anchors bolus deliveries. |
| `test-tci-bolus-restore.js` | Manual boluses generate a rate-restore; TCI boluses deliberately don't. |
| `test-tci-tolerance-slider.mjs` | The ceTolerance slider is actually wired through to the planner (≥2 distinct plans across the tolerance range). |
| `test-reaction-delay.mjs` | `displayedSecToEvent` biases TCI countdowns earlier by the reaction-delay, never touching real event time. |
| `test-settings-validation.mjs` | `getSettings` clamps/validates every field of the stored blob back to its default — the guard between arbitrary stored JSON and the running app. |
| `test-keypad-buffer.mjs`* | Prefilled-buffer first-keypress-replaces, unit toggle converts-not-clears (CLAUDE.md keypad invariants). |
| `test-unit-safety.js` | The real `validateParams` rejects mis-united PK params. |
| `test-units.mjs` | Unit conversion + quantization round-trips (mg/mcg/kg, mL/h). |
| `test-reconcile.mjs` | Reconcile modal's dose-back-calculation (independent Cardano cubic oracle kept inline by design). |

<sub>*filename is `test-keypad-buffer.js`.</sub>

### 4. Round-trip / integration contracts — data survives the wire

| File | Guards |
|---|---|
| `test-session-roundtrip.js` | Save → wipe → restore preserves events/patient/modes; bolus re-anchor under a changed pump rate; system events dropped and regenerated. |
| `test-cloud-sync.js` | Case push/pull validation + schema-version gate. |
| `test-prefs-sync.js` | Preferences sync: manifest filtering both ways, newer-schema refusal. |
| `test-patient-sync.js` | Cloud patient-pull payload parsing/validation. |
| `test-dose-template.js` | Starting-dose template schema + collect/apply. |
| `test-api-sync.js` | The serverless `api/sync.js` endpoint: kind validation, per-IP rate limit (fake-Redis), fail-open. |
| `test-setting-persistence.js` | The pure predicates behind setup-default vs in-case working unit keys, and non-sticky 8.33 mg/mL propofol. |
| `test-meta.mjs` | Release hygiene: `js/version.js` ↔ `sw.js` version lockstep, and `sw.js` precache list ↔ the JS modules on disk. |

### 5. Engine-mechanics scaffolding — fast low-level edge cases

Exercise the **real engine** around a controlled event timeline via a shared
harness (`helpers/mini-event-list.mjs`), reaching edge cases that would be
awkward through the full facade.

| File | Guards |
|---|---|
| `test-model.mjs` | Event-list CRUD semantics: clearAfter/clearFrom, edit/delete, rate-restore, addRateBatch, no status field. |
| `test-t0-edge.mjs` | The t=0 boundary: zero-state no-ops, negative-dt guard, bolus-from-zero conservation, matrix-exp identity/linearization, simultaneous events. |
| `test-event-driven-sim.mjs` | Event-driven sim behaviors — manual rate/bolus, edit/delete, mid-case patient change, multi-drug isolation, jump-to-time, per-tick data fan-out. |

## Conventions & deliberate exceptions

- **Independent oracles stay inline.** `test-vs-simtiva.js` keeps an analytical
  eigenvalue solver, `test-reconcile.mjs` a Cardano cubic, and
  `test-steady-state-predictor.mjs` a small `inv4` for one cross-check. These are
  *not* copies of production code — they're independent implementations the real
  code is validated *against*. Importing the production solver here would make
  the test self-referential and prove nothing.

- **`helpers/mini-event-list.mjs` is shared scaffolding, not production.** It's a
  minimal event list wired to the real engine, used by the three engine-mechanics
  files so they don't each carry a drifting copy. The *production* event list is
  covered by `test-session-roundtrip` + `test-pump-rate-correction`. It carries no
  `status` field (production dropped it) and aliases `addManual*` → `add*`.

- **`.mjs` vs `.js`.** Files that need static `import` of ES modules are `.mjs`;
  older CommonJS-style files use `pathToFileURL` + dynamic `import()`. The runner
  handles both. Prefer `.mjs` for new files.

- **Exact locks vs tolerance windows.** Lock a number exactly only when it's an
  *analytic property* (a Ce_ss value, a conserved mass) or a *contract* (`=== 0`
  at steady state, `=== null` for bad input). For *timing magnitudes* whose exact
  value depends on a sampling grid or a threshold knob (plateau entry minute,
  time-to-95%-SS), use a tight tolerance window (see `nearMin` in
  `test-steady-state-predictor.mjs`) — it still catches a real regression but
  doesn't red-fail on benign retuning.

- **Pump config in planner tests.** Production derives `maxRate =
  bolusRateMlH × concentration / 60 = 125 mg/min` (installed by the setup screen
  on every case). Drive planner tests with that, not the un-derived `200`
  default, or you're testing a delivery ceiling production never uses.

## Adding a test

1. Create `tests/test-<thing>.mjs`. Import the **real** module(s) under test.
2. Use a local `let passed=0, failed=0` + `ok(cond, msg)` helper (copy the
   pattern from any file). Print `\n${passed} passed, ${failed} failed\n` at the
   end and `process.exit(failed > 0 ? 1 : 0)`.
3. If the module touches `localStorage`/`document`, shim them before importing
   (see `test-settings-validation.mjs`), don't reimplement the logic.
4. Decide which of the five kinds it is, and assert accordingly — property/outcome
   for planners and predictors, exact only for analytic values and contracts.
5. `node tests/run-tests.js` must stay green.
