# Development History & Roadmap

> Single source of truth for session history. SESSION-HISTORY.md has been retired and its content merged here.

## Session History

### A new case begins in two places (v0.6.4.13) — Interim

Reported against v0.6.4.12: a fresh case, and the ketamine Add Bolus keypad
opened prefilled `12.5 mg`, propofol's `274.6 mcg/kg`. Neither was a dose given
in that case — the log held a 25 mg ketamine push and a 1000 mcg/kg propofol
bolus, both stamped at case start.

That detail is the whole diagnosis. Doses stamped at case start come from the
**starting-dose template**, which `queueStartingDoses` inserts straight into the
event list; they never pass through `keypad.confirm()`, so they never write
`tci_lastBolus_*`. The Redose button read the event list and showed the right
numbers (`Redose 25 mg`, `Redose 1000 mcg/kg`); the keypad read localStorage
and showed the previous case's.

v0.6.4.10 added the clearing pass for exactly this, and it was correct — but it
was written *inside* `session.newCase()`, which is the New Case **button's**
handler. The app has two ways into a case:

```
btn-new-case → newCase() → setup screen → onConfirm → sim screen   ✓ cleared
cold start   →            setup screen → onConfirm → sim screen   ✗ never cleared
```

A cold start is not exotic. It is a page reload, a PWA relaunch — and the
automatic reload after a service-worker version update, which means **every
update dropped users onto the uncleared path**. The same gap left the working
display units unseeded, which is why propofol's keypad opened in mcg/kg instead
of the setup default.

`resetCaseCarryOver()` is now module-level in `session.js` and called from both
`newCase()` and setup's `onConfirm`. Idempotent, so the New Case path running it
twice costs nothing. Being module-level (it needs no closure state — only
`DRUG_IDS`, `getPrefKey`, `getSetupDefaultUnit` and localStorage) also makes it
directly unit-testable, which is what `tests/test-case-carryover.mjs` does,
including a guard list of cross-case keys it must not touch.

`restore()` is deliberately left alone. It resumes the case you were just in —
the reload-mid-case recovery path — so the memory it carries belongs to that
case.

The general shape, and it is the third of its kind in this stretch (after the
step-bar rail and the idle-vs-rate proxy): **the fix was attached to a UI event
rather than to the state transition it stood for.** "New Case was pressed" was
a proxy for "a new case begins", right on the path anyone would test and wrong
on the path an auto-update forces. Cleanup belongs at the transition, reachable
from every entry point, not in one handler.

### Idle is a direction, not a rate (v0.6.4.12) — Interim

Asked to check whether the emergence countdown could ever fail to update,
"especially for propofol infusions, and especially moving from TCI to a manual
infusion with boluses". The TCI → manual switch turned out to be fine. The
boluses were not.

`exit-readout.js` is a two-mode machine, and its header stated the premise
plainly: *"Idle (rate == 0): Ce is actually decaying."* That sentence is the
bug. `isIdle` was `!(getRateAtTime(...) > 0)`, and `getRateAtTime`
(`js/sim/events/replay.js:30`) walks `rate` and `pause` events only — **bolus
events are invisible to it**. So a bolus given with no infusion running reads
as rate 0 for its whole delivery and for the effect-site rise afterwards. In
that window Ce is climbing, the true time-to-emergence is climbing with it, and
the idle branch was ticking the display *down* 1 s per second, resyncing with
an upward jump every `IDLE_SANITY_MS`.

Driving the real module against the real model and comparing what the card
would display with `predictDecayTo` at the same instant:

```
 t(min)  rate    Ce     shown    truth     err
 25.40    0.0   1.882    647s     723s    76.3s   <<<
 25.43    0.0   1.914    739s     757s    18.3s
 25.47    0.0   1.949    737s     790s    53.1s   <<<
 25.50    0.0   1.986    821s     821s     0.5s   ← 5 s sanity snaps it back
 25.57    0.0   2.068    817s     881s    64.0s   <<<
```

Propofol, 100 mg with the pump stopped: worst 76 s. Ketamine by IV push — the
normal way it is given, so rate is 0 for the entire case — worst **3094 s**,
i.e. the card reading `26:38` against an honest `78:15`. And it fires in plain
TCI too: the plan leaves rate at 0 between the loading bolus and the first
maintenance step, which is the same trap in miniature (48.7 s at t ≈ 1.2 min).

The fix is to make idle mean what the code assumed: Ce is falling. Direction
decides — the rule `settings.checkBelowThreshold` and `decay-predictor`'s
`hasBeenAbove` already apply to the redose threshold, now applied here too.
Ce's own direction is not quite enough on its own: for the first few seconds of
a bolus the plasma is loaded but the effect site is still coasting down, so Ce
falls while the answer has already jumped. `isInBolusPhase` — which the drug
panel already uses for the "Bolus" status label — covers exactly that lag, and
`rising` carries the rest of the climb to the peak.

Worth stating generally, because this is the second bug in three days of the
same shape (after the step-bar rail): **a cheap proxy for a condition drifts
from the condition.** "Pump rate is zero" was a proxy for "Ce is falling", and
it was right often enough to survive review and wrong exactly where a bolus is
the whole point of the screen. The rail bug was a class outliving its
precondition; this is a proxy outliving its correlation. Both were found by
asking what the code *assumes* rather than what it *does*.

**Second defect, found while measuring the first.** The reference itself was
stepping in 30 s jumps for ketamine. `predictTroughTime`'s bisection carried an
absolute concentration early-exit, `|midCe − troughCe| < 1e-4` µg/mL. An
absolute band in canonical units means something different for every drug:

```
propofol  target 1.5 µg/mL     → 1e-4 is  0.01% of target   61 distinct values / 61 s
ketamine  target 0.030 µg/mL   → 1e-4 is  0.33% of target    3 distinct values / 61 s
fentanyl  target 0.0003 µg/mL  → 1e-4 is 33.33% of target    3 distinct values / 61 s
```

At 33% of target, bisection returns on its first probe and the answer collapses
onto the 0.5 min coarse grid, so the fentanyl and ketamine countdowns sat still
for half a minute and then jumped half a minute. The tolerance is now relative
to the target. The same function backs `predictTrough`, so the redose countdown
had the identical quantisation and is fixed with it.

`tests/test-exit-readout.mjs` drives the real readout module over the real
model with a fake wall clock locked to sim time, and asserts the displayed
countdown tracks ground truth and never walks against a rising truth. It fails
6 of 9 assertions against the pre-fix files.

### The chart stack comes in-house (v0.6.4.11) — Interim

Reported: after restoring a case on v0.6.4.10, **all horizontal chart threshold
lines were gone** — Ce target, redose threshold, emergence, and the BIS
nomogram bands with them. The drug cards still showed the values, and setting a
threshold fresh did not bring its line back.

Restore was a red herring; it was simply when the user looked. Reproduced by
blocking one script:

```
chartExists: true              datasetsDrawn: 9
registeredPlugins: [colors, decimation, filler, legend, subtitle, title, tooltip, zoom]
                    ^ annotation absent
configuredAnnotations: [cursor, target, exitCe, band_0..band_3]  ← present, none drawn
console errors: none
```

`chartjs-plugin-annotation` is a classic `<script>` that self-registers against
`window.Chart`. When it fails to load **nothing throws**. Chart.js constructs
the chart, draws every dataset, accepts and stores our
`plugins.annotation.annotations` object, and renders none of it. Everything
that is not an annotation keeps working — curves, event markers, crossover
dots, the readout panel — so the app looks healthy.

The confirming signature was the pills. `js/ui/chart/plugins/target-label.js`
is one of ours, so the orange `6.0` and red `30.0` chips were still painted at
the right edge, labelling lines that did not exist. A plugin of ours pointing
at the absence of a plugin of theirs.

**Why a version bump set it off.** `sw.js activate` deletes every cache except
the new `CACHE_NAME`, so the previous version's copy of the CDN files is gone
the moment the new SW takes over. `install` then precached the four jsdelivr
URLs under a deliberate exemption — "a flaky CDN must not take down offline
support" — so a failed fetch left the file out of the new cache and the install
still reported success. That exemption was written to protect offline support,
and it was the thing that destroyed it: every update re-ran the lottery, and a
device offline or behind a network that blocks the CDN had no way back.

The fix is to stop asking. Chart.js 4.5.1, chartjs-plugin-annotation 3.1.0,
Hammer.JS 2.0.7 and chartjs-plugin-zoom 2.2.0 now live in `js/vendor/` as
unmodified upstream builds (283 KB, all MIT) and load same-origin, which moves
them into the **mandatory** precache group. A failed fetch now aborts the
install and leaves the working previous version active — the same all-or-
nothing rule that already protects the ES-module graph from mixed versions, for
the same reason: a partial cache is worse than no update. Only the Google Fonts
CSS stays tolerant, where a miss costs typography rather than rendering.

Verified with jsdelivr blocked outright at the network layer: the plugins
register, all three lines and the nomogram bands draw, and the service worker
installs with all four `js/vendor/*` entries and no jsdelivr entries at all —
i.e. under precisely the condition that produced the bug.

`assertChartPlugins()` in `createChart` closes the diagnostic gap: a missing
`annotation` or `zoom` registration now throws a named error, which `app.js`
already catches and logs, instead of yielding a chart that looks fine and is
missing half its meaning. The general lesson is the one this bug taught the
hard way: **a dependency that fails silently needs a check at the boundary, not
a comment.** Chart.js's tolerance of unknown plugin config is reasonable
library behaviour; consuming it without asserting was ours.

### Keypad prefills: one formatter, two precisions (v0.6.4.10) — Interim

Reported: a fentanyl redose threshold set to **0.35 ng/mL** reopens the keypad
prefilled with **0.3**. Confirming it untouched moves the threshold.

The audit that followed covered every prefilled value in the numeric modals.

**Sources.**

| modal / field | source | unit handling | survived New Case |
|---|---|---|---|
| Keypad `ceTarget` | `mode.ceTargets[drug]` | **raw `.toString()`** | no |
| Keypad `intermittent` | `mode.intermittentThresholds[drug]` | `fromCanonical` + `formatValue` | no |
| Keypad `exitCe` | `mode.exitCeTargets[drug]` | `fromCanonical` + `formatValue` | no |
| Keypad `rate` | `tci_lastRate_<drug>` (canonical mg/min) | `fromCanonical` + `formatValue` | **yes** |
| Keypad `bolus` | `tci_lastBolus_<drug>` (canonical mg) | `fromCanonical` + `formatValue` | **yes** |
| Keypad unit toggle | current buffer | `convertBufferUnit` → `formatValue` | n/a |
| `showCustom` (starting doses) | `tci-dose-template` (display units) | `formatValue` | yes |
| Event editor — Edit | the event's canonical value | `fromCanonical` + `formatValue` | n/a |
| Event editor — Add | nothing | — | n/a |
| Patient modal | hidden setup inputs | own metric/imperial converters | no |

**The precision defect.** `formatValue(value, unit)` rounds to a *per-unit*
decimal cap (`UNIT_DECIMALS`) which knows nothing about each drug's titration
grid (`DRUG_TASK_UNITS[...].quantSteps`). Where the grid is finer than the cap,
the echo is coarser than the value:

```
fentanyl ceTarget ng/mL      grid 0.05  cap 1 dp   0.35 → 0.3   ← reported
fentanyl rate mcg/kg/min     grid 0.01  cap 1 dp   0.03 → 0
fentanyl bolus mcg/kg        grid 0.25  cap 1 dp   0.75 → 0.8
```

Only fentanyl trips it today — propofol and ketamine grids all sit at or above
their unit caps — but the defect is in the shared formatter, not the drug. Two
things made it worse than a display nit:

- The direction was unstable. `0.35` reached by conversion rounds to `0.3`;
  the same value as `0.05 × 7` (float `0.35000000000000003`) rounds to `0.4`.
- It was not only prefill. `convertBufferUnit` formats the same way, so a unit
  toggle truncated too; and `event-editor.js openEdit` prefilled an event's own
  value, so **editing a 0.03 mcg/kg/min fentanyl rate and pressing Save with no
  other change wrote a rate of 0**.

`formatValueStep` already existed for this concern but could not just be
swapped in: it rounds *to* the grid, and propofol's bolus grid is 1 mg, so a
22.5 mg dose would echo as `23`. Neither formatter is right alone.

`formatValueEntry(value, unit, step)` takes the **finer of the two**, which is
the actual rule: *echoing a value back to the user may never lose precision the
user could have entered; only a deliberate titration may snap to the grid.*
`setCanonical`'s `formatValueStep` (planning ± and drag) is the titration case
and keeps its behaviour; readouts, history and the conversion preview keep
`formatValue`. A positive value also never renders as `0` — a conversion into
an unsuitable unit (3 mcg/h of fentanyl is 0.00076 mcg/kg/min) widens to about
two significant figures rather than offering a zero to confirm.

**Consistency.** `ceTarget` was the one prefill that skipped `fromCanonical`
and formatting entirely, reading the stored canonical value in with
`.toString()`. It worked only because propofol's canonical Ce unit equals its
single allowed display unit — a coincidence, not a design. All five in-case
sources now go through one `prefillFromCanonical(canonicalValue, task)` in
`keypad.js`, which also folds in the four copies of the
`getPatient()?.weight || 70` context that `weightCtx()` already resolved.

**New Case.** Everything in-case resets — Ce target, redose threshold,
emergence (`mode.reset()`), patient demographics (`setup.reset()`), working
display units (reseeded from the setup defaults). The last-dose memory was the
sole exception, and it is a per-*patient* quantity wearing a per-drug key: a
canonical mg dose re-derives against the new patient's weight when the display
unit is per-kg, so 150 mg remembered from an 80 kg patient reappeared as
2.5 mg/kg for a 60 kg one. It now clears in the same `DRUG_IDS` loop that
reseeds the units. Doses meant to carry across cases already have a home — the
starting-dose template, which persists deliberately and is patient-independent.

Two asymmetries were examined and deliberately kept: the event editor's **Add**
starts empty while the keypad's Add Bolus prefills the last dose (a
retrospective event is not a dose you are giving now), and a starting-dose
template entry never writes the last-dose memory (a template is a plan, not a
dose given).

### Emerge rail: a below-threshold flag that outlived its threshold (v0.6.4.9) — Interim

Reported from a live case screenshot. The 3 px rail directly under each drug
card's `Emerge → …` line was canary on propofol and amber on ketamine — those
are `DRUG_DEFS` colors, painted by `.step-bar-wrap{background:var(--drug-color)}`
— but red on fentanyl. Red on that rail has exactly one meaning:
`.step-bar-below`, "Ce has fallen under the redose threshold".

Fentanyl had no redose threshold. The same screenshot proves it: the card's
right-edge status rail was absent, and `data-status="off"` is only reachable
through `m === 'none' && threshold === 0` (`index.js` status block). Two
indicators on one card, disagreeing about whether a threshold existed.

`step-bar-below` was written in five places inside the step-bar block, one per
branch, and the `threshold === 0` branch was the gap — it called
`updateStepBar()` and returned, and `updateStepBar()` does not touch the class
either. So the class survived its own precondition:

```
Set Threshold (fentanyl)  → threshold > 0
Ce falls below it         → add('step-bar-below')     rail red   ✓
Set Threshold → 0         → threshold === 0, branch A → no remove  rail red   ✗
```

Only New Case cleared it, via the `!caseStarted` branch.

The fix is not a sixth `remove()`. `belowThresh` is now a plain boolean set by
the one branch that means it, and the block ends with a single
`classList.toggle('step-bar-below', belowThresh)` — so the rail is a function of
this frame's state rather than of the branch history that got here. `barEl` /
`cntEl` are hoisted to the top of the block, which also removes the duplicate
lookups the old `else` branch carried.

Worth stating as a general shape: a per-branch `add`/`remove` pair over N
branches is N places to be right, and the branch that "does not care" about the
class is the one that silently keeps it. Derive, then toggle once.

### Next Up: a floor under the pump horizon (v0.6.4.8) — Interim

Reported from a live case at ET 2:29:49. The propofol card read `Rate → 170
mcg/kg/min in 25:27`; Next Up listed `FENTANYL — Redose due 25:32` and
`KETAMINE — Redose due 117:32` and nothing else. The single scheduled pump
action in the case was absent from the panel that exists to name it, while a
forecast **five seconds later** was present.

Reproduced directly against `collectUpcoming`, which is why the module is kept
free of DOM and localStorage:

```
collectUpcoming({ events, now: 149.8, milestones })
  → [ 'fentanyl redose 25.53', 'ketamine redose 117.50' ]
  → with cfg.horizonMin = 40: 'propofol rate 25.45' reappears
```

`horizonMin` is 20 min for pump events; `milestoneHorizonMin` is `Infinity` for
forecasts. That split is v0.6.4's fix and it is still right — but it made the
two populations' *failure modes* mirror images, and this is the mirror image
arriving. v0.6.4's note reads "the old rule silenced precisely the drugs that
had nothing else scheduled". Same sentence here, one step further in: the thing
being silenced is now a pump event, not a forecast.

**The horizon is a density control, and this case has no density.** Twenty
minutes is not a claim that a step 25 min out is irrelevant — it is a budget
against a TCI plan queueing dozens of steps over hours. Late in a long case the
emulation planner's maintenance steps spread out until consecutive steps sit
more than 20 min apart, and the budget starts spending itself on a plan that
isn't dense any more.

So the fix is a floor, not a wider horizon. `guaranteeNextPerDrug` admits each
drug's **first** future pump event however distant, once, and only when the
horizon walk left that drug unrepresented. Raising `horizonMin` to 45 would have
fixed this screenshot and re-broken the early-case one — six rate steps in the
first ten minutes is exactly the noise 20 min was chosen against.

Three properties that made it cheap to be confident in:

- **Every existing horizon test still passes untouched.** In each of them the
  dropped event is the drug's *second* candidate (`near 5 / far 90`, the
  `groupWindowMin` pair, the pump-vs-forecast pair), so a floor on the first one
  cannot reach them. That is a useful signal about where the old boundary
  actually sat — the suite had never pinned the "only one step, and it's
  distant" case at all.
- **No change in `next-up.js`.** The alarm level comes from `_remSec`, not from
  list membership, so a row 25 min out is quiet until `prepSec`; `_items` stays
  time-sorted so `_renderClock` still picks the soonest actionable item; and
  `fmtHudCountdown` already switches to `5h 02m` past the hour, so a genuinely
  distant guaranteed row reads correctly.
- **The floor is a config key, not a rewrite of the walk.**
  `guaranteeNextPerDrug: false` restores the old behaviour exactly, and there is
  a test pinning that — the policy stays legible as policy.

One test of my own was wrong before the code was: the elapsed-budget case used a
propofol event at t=5 with `now: 30`, which `elapsedLookbackMin` drops for the
same reason it drops the stale ketamine bolus, so the assertion would have
passed for the wrong reason. Moving it to t=35 makes it test what it claims.

### History log: centre the now-boundary (v0.6.4.7) — Interim

The Log tab is chronological — oldest at the top, newest at the bottom — and
`scrollToNow()` parked the first *future* row 48 px below the panel's top edge.
That reads as "most recent event at the top": the delivered history is pushed off
the top of the view and the whole panel below is upcoming plan steps. During a
case you want the opposite balance — what just happened is as relevant as what is
next.

The boundary now lands on the panel's vertical midpoint: `- lead` becomes
`- area.clientHeight / 2`. Recent history fills the top half, upcoming events the
bottom half.

**The short-list cases needed no code.** Early on there is not enough history to
push the boundary down to the midpoint, and the natural instinct is to guard for
it. But the computed `scrollTop` simply goes negative and the browser clamps it to
0, so the rows fill from the top and stop wherever they reach — exactly the wanted
behaviour. The all-past branch is likewise untouched: the boundary sits past the
end of the content, and both the midpoint formula and the existing
`scrollTop = scrollHeight` clamp to the same bottom-pinned position.

No separator element was added — the boundary stays implicit (the first row
carrying `h-future`), as it has been. The function is still deliberately kept out
of the render cadence, so nothing yanks the list while the user is reading it.

### Redose alert: re-arm after an inadequate dose (v0.6.4.4) — Interim

**A decision I flagged, accepted, and then had to reverse — worth recording
honestly.** In 0.6.4.2 I asked what should clear a latched threshold alarm and
offered "any bolus, but re-arm if still low" against "any bolus, cleared for
good". The user chose the latter; I noted at the time that a too-small dose would
leave no alarm, and shipped it. Two versions later that is exactly the report:
"let fentanyl drop below the redose threshold and then bolus, and it doesn't set
an alert for the next redose."

The lesson is not "the user chose wrong". It is that **I offered a
false symmetry.** The two options were not comparable risks: one fails by nagging
you for a minute, the other fails by going silent about an under-dosed patient for
the rest of the case. When the failure modes are that asymmetric, presenting them
as a preference is the mistake — the safe option should have been the
recommendation with the other flagged as a trade-off, or better, I should have
asked how long the quiet period should be rather than whether one should exist.

Reproducing it showed it was worse than reported: the panel had **no rows at
all**, while the fentanyl card still read `Below Redose Threshold 2.0`. The app
knew; only the alert had gone. Silent-failure-toward-under-treatment is the worst
direction this feature can fail in.

**Why "cleared for good" needed no extra state — and why that was the tell.**
The 0.6.4.2 note is smug about this: because the latch is stamped at the crossing,
a *later* crossing carries a later timestamp the old bolus no longer satisfies, so
"cleared for good" is free. True, and irrelevant — it quietly assumes there
*will* be a later crossing. When Ce never climbs back above the threshold there is
no new crossing, and the elegance becomes a permanent mute. An invariant that
holds only under an unstated assumption is worth less than one that costs a field.

**The fix required moving a rule out of the pure collector, which I resisted at
first.** `collectUpcoming` decided "a bolus at/after the crossing clears it",
which was nicely unit-tested. But the real question is *was that dose enough?*,
and no amount of event-list inspection answers it — it needs Ce's direction. So
the rule moved to `js/ui/settings.js`, which already owns the threshold edge and
the chime. Purity is worth defending until the pure module cannot see the
information; then keeping it there just means encoding a wrong answer cleanly.
The test coverage did not have to be sacrificed: `settings.js` is DOM-free enough
to drive from Node (`playAlert` no-ops without an unlocked AudioContext), so the
state machine got its own 28-assertion suite.

**Peak-relative, not a timer.** Re-arm triggers when Ce falls 0.5 % below its
post-dose peak while still under threshold. The first instinct was a fixed grace
period, but fentanyl and ketamine peak at very different rates, so any constant is
wrong for one of them. Tracking the peak also sidesteps a subtler trap: comparing
against the *previous* sample cannot work, because on a slow decay the per-frame
delta is far below any usable epsilon. Measured: re-arms 60–90 s after a fentanyl
push, which is where fentanyl's peak effect actually is.

**The second bug was mine outright, and the same shape as one I already fixed.**
Acknowledgement keys were `drugId:kind` — a per-drug slot. `liveKeys` pruning can
only release a key when it stops being live, and a recurring forecast's slot never
does, so a mute stuck permanently: the next redose countdown was born
`[ACKED]`, dimmed, unable to alarm. This is the third time in this feature that
**an identity chosen for convenience turned out to span more than one occurrence
of the thing it names** (see also `seenFuture` and the `render(t = 0)` bug). Keys
now carry an occurrence token, and `milestoneKey()` is exported so `liveKeys()`
and the collector cannot drift apart on identity — a mismatch there breaks pruning
silently, which is the failure class this whole version is about.

### Next Up: an overdue item owns the clock (v0.6.4.3) — Interim

**A screenshot made the design error obvious in a way description hadn't.** A
missed TCI rate change: panel pulsing red, the rate-change row present — and the
clock reading `13:38` in *amber*, labelled `FENTANYL — REDOSE DUE`. Two
independent signals pointing at different items, so the red border looked like it
belonged to a fentanyl redose thirteen minutes away.

The cause was one clause. `_renderClock` selected its head with an explicit
`!i.elapsed`, so an outstanding item could never own the clock. And because
`nu-clock-due` fired only on `rem <= 0`, the digits stayed amber inside a red
panel — the one place the colour has to agree, and it didn't.

Worth noting I had *asked* about this case and got the wrong answer from my own
framing. In 0.6.4.2 I offered "when an overdue item is the only thing left, what
should the clock show?" and the user chose "leave as-is". That question described
the benign case. The real problem is an overdue item **alongside** a later one,
where the clock actively contradicts the alarm. The lesson is about how I framed
the option, not about the user changing their mind: **when asking about a display
conflict, describe the conflicting state, not the quiet one.**

**The trap.** `_remSec` routes pump events through `displayedSecToEvent`, which
ends in `Math.max(0, rawSec - reactionDelaySec)` for `source:'tci'` events. A
count-up derived from it freezes at `-0:00` — precisely for a missed TCI rate step,
precisely when the user has a reaction delay configured. The count-up uses raw
`t - item.time`, and the browser verification runs the whole scenario a second time
at `reactionDelaySec = 2 s` specifically to catch a regression there. That clamp
exists for good reasons on the countdown path; it is simply wrong on the count-up
path, and the two share a helper.

**Two consistency debts paid off.** Missed pump rows said `missed` while crossed
thresholds counted up, so the clock could display `-2:14` for a row reading
`missed`; both now count up and the two branches of `_rowTimeText` collapsed into
one. And the ordering the new head-selection depends on — elapsed items leading,
ascending — is now pinned by tests rather than being an accident of sort order.
"Oldest overdue owns the clock" is a contract now.

**`MISSED ·` is applied narrowly**, only to a scheduled step the user did not
perform. A latched threshold keeps `FENTANYL — REDOSE DUE`, preserving the
distinction settled in 0.6.4.2: the patient crossed a line; nobody failed to act.
Verified both label paths in the browser rather than assuming the branch worked.

**The glyph budget held, and I measured it anyway.** The leading `-` pushes the
worst case to 8 glyphs. The per-length `--nu-fit` sizing built in 0.6.4.2 absorbed
it with no CSS change — but that budget is exactly what broke silently in 0.6.4, so
it was re-measured with the render frozen rather than reasoned about: 3–6% headroom
everywhere, `-12h 05m` at 53px in a 280px column and 43px in a 226px one.

### Next Up: latched threshold crossings + fit-to-width clock (v0.6.4.2) — Interim

**A self-clearing alarm was the sharpest signal yet that a design was wrong.**
The reported bug: a crossed redose threshold cleared itself. What made it
obviously not merely incomplete is that `settings.checkBelowThreshold` fires the
redose chime at exactly that instant — so the app was alarming audibly about a
row it had just deleted. When two subsystems disagree that loudly, one of them
has the wrong model of the event.

Three compounding causes, any one of which alone would have dropped the row:
`approach.js` stops reporting `kind`/`arrivalMin` once `Ce <= threshold` (it
switches to the "Below Redose Threshold" static text); both `_collectMilestones`
and `collectUpcoming` filtered milestones to `time > now`; and the rebuild then
pruned the key from `_clearedKeys`/`_alarmMuted` via `liveKeys`, discarding the
acknowledgement state too.

**The conceptual fix is a category distinction, not new machinery.** Almost
everything needed already existed: an *elapsed actionable* item persists, pulses
red, silences on a panel tap and clears on a row tap. What was missing is that a
threshold crossing is a **latched** event — it has already happened and stays
until dealt with — whereas every other milestone is a *forecast*, and a forecast
in the past is simply stale. Once `latched` existed as a concept the rest fell
out: keep it as `elapsed`, give it its own row budget (exempt from
`elapsedLookbackMin` and `maxElapsed`, because a crossing 40 min old is still
outstanding and three missed pump steps must not evict the row that is actively
alarming), and let a bolus at/after the crossing clear it.

The bolus rule has a pleasing property: because the latch is stamped at the
moment of the crossing, a *later* crossing carries a later timestamp that the old
bolus no longer satisfies. "Cleared for good" therefore needs no extra state —
the timestamp comparison is the state. Verified in-browser that a bolus clears
the latch while Ce is still *below* threshold (0.476 vs 0.507), i.e. it is the
bolus rule doing the work rather than Ce recovering.

**A bug I shipped and then had to find twice.** `nextUp.render(t = 0)` — the
row-tap handler calls `render()` with no argument, so it rebuilt against a clock
of zero. That makes every event in the case look pending, which poisons
`_seenFuture`, so already-performed actions come back as `missed`. The symptom
only appeared *after* clearing a row, which is why neither the unit tests nor the
earlier browser passes caught it: you have to tap something to trigger it. The
lesson is narrow and worth keeping: **a defaulted clock is never safe.** `t` now
defaults to the live clock via `_now()`, and CLAUDE.md carries the invariant.

**Fit-to-width clock, and a measurement lesson.** `28cqw` was calibrated in 0.6.3
for a 5-glyph `19:59`; in 0.6.4 I added the `H:MM:SS` rollover, making the string
7 glyphs, without revisiting the factor. In the ≥1020px split layout that
overflowed a 280px column by ~57px, and after the 0.6.4 horizon fix a ≥1h clock
head is the *normal* state for ketamine — so it shipped and the user saw it.

Two changes. First, drop seconds past the hour (`5h 02m`): a five-hour prediction
does not carry second-level precision, so the shorter string is also the more
honest one. Second, size per string rather than by one factor — the face is
monospaced with tabular figures, so width is exactly `glyphs × advance`, and CSS
only needs the glyph count. `next-up.js` publishes it as `data-len`; CSS holds the
per-length fit ceiling in `--nu-fit`; the text-size tiers stay as the upper bound
so the user's preference is still respected. The clock is now genuinely as large
as fits: in the same 280px box, `9:59` renders at 108px and `12h 05m` at 61.5px.

The measurement lesson is the durable part. My original check reported a false
pass for two reasons: `scrollWidth` does not grow when a block's text overflows
(so it must be a `Range` over the glyph run), and the rAF loop rewrote the string
I had injected before the measurement ran (so the render must be frozen —
`drugPanel.stop()` — first). Both traps are silent. The test now asserts
`rangeWidth <= boxWidth` for every reachable string across four
viewport/text-scale combinations.

### Next Up: drug-coloured names (v0.6.4.1) — Interim

The drug name was `--text-muted`, i.e. styled as a caption above the verb. Wrong
emphasis: on a cross-drug list the drug is the first thing you need to resolve,
not supporting detail. Now full-brightness in the drug's own colour, tying the
label to the row's left edge.

**Why this needed more than a one-line colour swap.** The drug-card `.drug-name`
deliberately uses `--text-primary` rather than `--drug-color`, and that is not an
oversight — the palette is tuned for a dark UI. Propofol's `#facc15` scores
**1.53:1** against the light theme's white card. Keying the name to the raw drug
colour would have fixed a dim label in dark theme by shipping an illegible one in
light. The codebase already knows this shape: the `--purple-bright` comment in
the light-theme block notes it was left equal to `--purple` because "on a white
card the darker violet already is the correct ink."

So `inkOnWhite()` (`js/util/color.js`) walks HSL lightness down, nudging
saturation up to keep the hue identifiable, until the colour clears a WCAG target
against white. Both inks go onto the row as inline custom properties and CSS
picks per theme — deliberately, because the list only re-renders when its row
*set* changes, so computing one ink at render time would leave stale colours after
a runtime theme switch.

### Next Up: milestone horizon fix + row time toggle (v0.6.4) — Interim

**The bug: one horizon for two kinds of thing that aren't alike.** 0.6.3 shipped
a single `horizonMin` (20 min) and a single `maxItems` (6) applied to the merged
future list. Reported symptom: on a loaded case, propofol's next set-rate counted
down correctly but the fentanyl and ketamine threshold crossings never appeared.

Two mechanisms, and it took the browser probe to separate them:

1. The selection loop walked the merged sorted list and `break`ed at the first
   item failing horizon-or-group. Fentanyl's crossing at ~22 min sat just past
   the horizon, so it was cut — along with everything behind it.
2. `maxItems: 6` was consumed entirely by propofol's dense TCI plan, so even
   ketamine's crossing at ~18 min — *inside* the horizon — lost its slot.

The conceptual error was treating pump events and clinical forecasts as one
population. They have opposite density profiles: **a pump plan is dense** (a TCI
scheme queues dozens of rate steps over hours, which is exactly why the tight
horizon exists — without it the panel degenerates into a second event log),
while **a forecast is sparse** (at most one per drug per kind) and its distance
is a property of the drug, not a sign it's irrelevant. Ketamine's redose
threshold sits hundreds of minutes out because its Ce decay is genuinely that
slow. The old rule therefore silenced precisely the drugs that had nothing else
scheduled and most needed the heads-up.

Fix: select the two populations independently under their own horizon and cap,
then merge and time-sort. Grouping and the horizon break still apply to pump
events only, which also closes the inverse hole — a forecast can't be smuggled
in early via the group window.

**A diagnostic trap worth recording.** My first reproduction "failed to fix" the
ketamine row, and I nearly went looking for a second bug. The cause was my own
test input: I entered a ketamine redose threshold of `0.3` while the keypad was
in **ng/mL**, giving 0.0003 mcg/mL — a threshold Ce sat 4170× above, which
`predictTrough` cannot reach even with a 5000 min lookahead, so it returned null
and there was legitimately no forecast to show. The tell was that the *drug card*
was blank too: when a symptom appears on a surface you didn't touch, suspect the
input before the change. With a realistic 300 ng/mL it resolves at ~20 min and
all three drugs appear.

That does leave a real, pre-existing limitation: `predictTrough`'s default 480
min lookahead means an unreachably-low threshold produces silence rather than a
"never reached" state — on the drug card as much as here. Left alone
deliberately; changing the default would alter drug-card behaviour nobody has
complained about.

**Redose became the first actionable forecast.** Every milestone was
`actionable: false` in the collector while `KIND_META` in the view already said
`redose: actionable: true` — the two could disagree, and did. Rather than
duplicate the table into the pure module, the collector now reads an
`actionable` flag off each milestone and `_collectMilestones` sets it from
`KIND_META`. One source of truth, no import from view into sim.

**Row time toggle.** IN / ET / RT for the list only. The clock stays a countdown
unconditionally — it is the one element whose entire purpose is "how long have I
got", and making it switchable would have been a category error. Reuses the
Log's ET/RT button idiom so the two views read as siblings. The click handler
must `stopPropagation`, since the whole panel is the tap-to-silence target.

**Long countdowns.** `fmtCountdown` renders bare minutes, which is right for a
pump step and absurd for a five-hour forecast (`300:00`). Added a HUD-local
H:MM:SS rollover past the hour rather than changing the shared formatter, which
the drug cards depend on in its current form.

### Next Up — interventions heads-up display (v0.6.3) — Interim

**Almost none of this was new computation.** The starting assumption was that a
"what's coming" panel would need its own prediction layer. It doesn't. The
drug-panel rAF loop already iterates every drug in `DRUG_IDS` and calls
`updateApproachLine` and `updateExitReadout` for each, so target arrival, redose
threshold, steady state, plateau entry/exit and emergence are *already* computed
60×/s for all three drugs — they were just being rendered into three different
slots on one card at a time. And `model.getEvents()` with no argument already
returns the flat, time-sorted, cross-drug array. The whole feature reduced to two
cache accessors, one curation function, and a view.

Worth recording as a pattern: **before adding a prediction layer, check whether
the display layer is already predicting.** The per-drug caches exist for
render-stability reasons (they were built to stop countdowns flickering), and
that made them incidentally into a whole-case forecast store.

**The honest-forecast problem, and why the panel is quieter than asked for.**
The request was for four clinical events on the list. All four are real
predictions, but two of them mean something different from "this will happen":

- `exit-readout` answers a **counter-factual** while the pump runs — *if you
  stopped now*, Ce reaches the Emerge threshold in N minutes. On a drug card,
  next to a running infusion, the framing is obvious. On a list headed "what
  happens next" it reads as a promise. So Emergence is surfaced only when the
  cache is in idle mode (`rate == 0`), where it is an actual forecast.
- Steady-state and plateau assume the current rate holds. A scheduled TCI step
  before the predicted arrival voids them, so those are dropped.

Net effect: the forecasts appear noticeably less often than the pump events.
That was a deliberate trade and it's the sort of thing to re-litigate only with
a new display convention — e.g. an explicit "projected, assumes no changes"
treatment — rather than by relaxing the guards.

**Two bugs the browser caught that the unit tests could not.** Both were found by
driving the real app with Playwright, and both were behavioural rather than
computational:

1. *The user's own Stop Pump came back as a `missed` intervention.* Stop Pump
   writes a `pause` at the clock and clears the forward plan; `time <= now`
   made it elapsed, and the panel reported it as something they had failed to
   do. The fix is a `seenFuture` set: an item can only be reported missed if it
   was still pending on an earlier pass. An event created at or behind the clock
   was never outstanding. Note this is *not* solvable by filtering on `source` —
   a manually-added future event can genuinely be missed, so the discriminator
   has to be "was this ever pending", which is history, not a field.
2. *Tap-to-silence muted the whole list.* `silenceAlarm` added every actionable
   item's key to the muted set, so the next intervention arrived with no alarm
   at all — the panel went permanently quiet after one tap. It now mutes only
   the keys actually at prep/due level, tracked in `_alarmingKeys` during the
   per-frame alarm pass. The observable symptom took ~80 s of wall-clock to
   appear, which is why it needed a driven browser rather than a unit test.

**Navigation: a sub-toggle, not a fourth panel.** `setView` only writes panel
`active` classes below 1020 px; at ≥1020 px `.content-view{display:flex}` reveals
every content-view unconditionally, and the portrait-≥700 px block turns
`.sim-content` into `display:contents` so each panel needs explicit grid
placement. A third `.content-view` would have needed correct handling in all
three regimes. Nesting both views inside `#panel-history` — which is always
`display:flex; flex-direction:column` at every breakpoint — means the layout work
was one pair of CSS rules mirroring the `.content-view` idiom one level down.

**`cqw`, not `vw`, for the clock.** First pass sized it `clamp(40px,15vw,78px)`,
which looked right on a phone and at 1180 px wide. But the Events panel is
`flex:1; min-width:200px` beside the chart at ≥1020 px — a ~280 px column in a
1180 px viewport — so `vw` was reading a box eight times the size of the one the
text lives in. At the XXL text scale a five-character `19:59` would have run off
the edge. `container-type: inline-size` on the wrapper plus `28cqw` makes the
clock self-limiting: it now drops from 108 px to 78 px in the narrow column
automatically. The `vw` line is left in place immediately above as the
no-container-query fallback.

**One duplication removed rather than tripled.** `_fmtEventDesc` in `settings.js`
and `fmtNextEvtLabel` in `step-bar.js` were already near-identical display-unit
formatters differing in two strings; the HUD needed a third. They now share
`js/util/event-label.js` with a `variant` parameter that reproduces both original
outputs byte-for-byte. Same reasoning applied to `classifyFutureEvents`, which
moved from `chart-bridge.js` into `js/sim/upcoming.js` (re-exported from its old
path so `planning.js` is untouched) so the chart's flags and the panel's rows
cannot drift apart on rate-direction classification.

### Redose button, plan-marker fix, ⏱ removal (v0.6.2) — Interim

**The ⏱ chart button lasted one version.** Added in 0.6.1.2 on the reasoning that
"when does this cross?" is a question you ask while looking at the chart; removed
here because once the labels moved onto leaders they stopped being the clutter
that made a quick toggle feel necessary. Worth recording as a small lesson: the
toggle was solving for a legibility problem, and fixing the legibility removed
the need for the toggle. The setting and its checkbox stay.

**The bolus marker was my own regression, one version old.** 0.6.1 taught the
preview to return the clone's events so a TCI retarget could show its rate
steps. A *bolus* proposal's own event comes back through the same channel, gets
classified `kind: 'bolus'`, and is drawn with the double-arrow glyph that means
"a scheduled bolus is coming" — which a dose you are about to commit by hand is
not. Markers now render for `ceTarget` proposals only.

The general shape is the one flagged in 0.6.1.1: **planning mode reuses chart
machinery built for committed state, and the mismatch surfaces as a small
visual lie.** Third instance now. The distinction that resolves all three is
whether the thing being drawn has any *other* representation on screen — a TCI
scheme's rate steps don't, so they need markers; a bolus's effect is the curve
itself, so a marker adds only a false implication.

**Redose button.** Repeats the last hand-entered bolus for a drug in one tap,
labelled with the dose it will give.

Three decisions, all taken with the user, all narrowing rather than widening:

- *Source: this case's event list, not `tci_lastBolus_`.* The persisted key would
  make the button live from case start, but it survives across cases — offering
  a dose from a previous patient. "Last dose given" should mean given, here.
- *TCI-sourced boluses excluded.* After leaving TCI the newest bolus is usually
  the planner's loading dose. Repeating a computed 155 mg as though the user
  chose it is wrong twice: they never picked the number, and it was sized for
  induction from zero, not a top-up.
- *Hidden entirely in TCI mode.* A bolus there ends the running plan. That is far
  too large a consequence for a control whose entire value is that it takes one
  unconsidered tap, so the button is absent rather than guarded — safe by
  construction instead of safe by confirmation.

`commitBolus()` was extracted in app.js because a bolus is not just an event: it
ends TCI, moves the drug to manual, annotates why, resolves pump-vs-push, and
pre-case advances that drug's own clock by the delivery duration. The Redose
button is the second caller, which is exactly the point where duplicating that
set stops being safe. Same reasoning as `resolveBolusDeliveryMode` in 0.6.

Label freshness goes through one line in `chart-bridge.refresh()` —
`mode.refreshUI(selectedDrug)`. Every path that adds, edits, deletes, reconciles
or restores a bolus already ends there. The alternative, refreshing in `onFrame`,
would re-scan the event list ~60×/s for a value that only changes on mutation.

`getWorkingUnit()` added to units.js: the saved-display-unit lookup was
copy-pasted in five places and the redose label needed a sixth. Migrated the
byte-identical copies (`drug-panel/step-bar.js` ×2, `settings.js`
`_getPreferredUnit`); left `keypad.js`, `event-editor.js` and `tci-modal.js`,
whose surrounding logic differs.

**One observation from testing that is not a bug.** Two Redose taps a second
apart produce *one* bolus of double the dose, not two events — `addBolus` merges
into an in-flight delivery, and a 100 mcg fentanyl push takes ~2 s to run. That
is the documented merge invariant and physically correct (the drug really does
go in over one window), and the keypad path behaves identically. Verified the
ordinary case separately: doses at 0, 20 and 45 min produce three distinct
events with the label steady at `Redose 100 mcg` throughout.

Verified in Chromium at 1280×900 plus phone landscape (844×390) and portrait
(390×844) — control bar fits on one row at both, no overflow. 0 console errors.
Suite 1069 → 1099.

### Crossing-time labels: on-chart toggle + leader placement (v0.6.1.2) — Interim

Two refinements to the labels added in 0.6.1 and made optional in 0.6.1.1.

**The toggle belongs on the chart.** Burying it in Settings meant two taps and a
modal to answer "when does this cross?" — a question you ask *while* looking at
the chart. New `⏱` button in the chart-controls strip, alongside the events,
ghosts and time-axis toggles it's a sibling of.

It follows the ghost-trace toggle exactly: the chart button is the in-case
control, the Settings checkbox is the same value rendered in the panel, and both
write one persisted key (`crossoverTimeLabels`). That two-surface arrangement has
a known failure mode — `initSettingsUI` populates its controls once at boot, so
a value changed from the chart afterwards leaves the checkbox stale. Caught it in
testing (button on, checkbox still reading false). The fix was already sitting
in `settings-ui.js`: the time-axis segmented control re-seeds itself in the
settings-open handler for precisely this reason, so the checkbox joined it there.
Worth remembering as a rule — **any setting with an on-chart counterpart must
re-seed on open**, or the two surfaces silently disagree.

**Label placement.** Butted against the dot, a label lands on the threshold line
it belongs to and on whatever curve passes through that point — three things
overlapping at the one pixel the eye is drawn to. It now offsets up-and-right on
a short leader drawn from the dot to the box's near corner, which keeps the
association explicit while leaving the line and curve legible underneath.

Two placement fallbacks, both verified by zooming a real crossing into the
corners: it folds to the left of the dot when the box would overflow the right
edge (crossings often sit near it), and drops below when there is no room above.
The box is finally clamped inside the plot area so neither fallback can push it
out.

### Planning mode: second test-note round (v0.6.1.1) — Interim

Three items. Two are refinements of things added last round; the third is a
genuine bug with an instructive shape.

**Crossover labels are opt-in now.** Added last round on request, then reported
as "a lot of visual clutter" — both true. The chart already carries four BIS
bands, two threshold lines, a cursor, event markers and now a preview curve, so
a persistent text box per dot is a lot to add unconditionally. New setting
`crossoverTimeLabels` (Appearance tab), **default off**, pushed from the bridge
every frame like the other display settings. Only the label is gated; the dots
stay. Default-off was the call because the reported problem *is* the current
default — leaving it on would ship the complaint.

**The handle was covering the thing it controls.** It sat on the anchor point
— the proposal's peak — which is precisely the part being judged, under a
44×56 touch target and a finger. It now parks at a fixed inset from the plot's
**left** edge at the same height, with a dashed tie-line out to a small marker
at the anchor.

Left rather than right for two reasons: `target-label.js` draws its
target/threshold pills against the right edge, and a threshold handle shares
those pills' y exactly, so a right-side handle would land on top of one every
time. The 46 px inset is chosen so the 44 px-wide hit region clears the 20 px
y-axis drag zone `gestures.js` reserves along the left edge — they would
otherwise fight, and the plan handle would win (it captures first), silently
eating the y-rescale gesture.

**First-time thresholds drew no dots; editing an existing one worked.** That
asymmetry is the whole diagnosis. The dots are interpolated off the
`emergence-traj` dataset, which `chart-bridge.onFrame` builds from **committed**
`mode` state:

```js
const exitCe   = mode.getExitCe(selectedDrug);
const redoseCe = mode.getIntermittentThreshold(selectedDrug);
const target   = targets.length ? Math.min(...targets) : 0;
const showTrajectory = target > 0 && ...
```

Setting a threshold for the first time leaves both at 0 → `target = 0` → no
trajectory → nothing for a dot to sit on. Editing an existing one only appeared
to work because the *old* value was still non-zero and kept the trajectory
alive; the dot was being placed on a curve computed toward the previous target.

Planning mode now publishes the previewed value through a new
`chartBridge.setPlanThresholds({exitCe|thresholdCe})`, which `onFrame` prefers
over committed state, and clears it on every non-line recompute and on exit.
Measured: trajectory 0 → 101 points while previewing a first emergence Ce of
1.5 µg/mL.

Worth noting the general shape — this is the second bug this feature has thrown
up from the same root: planning mode shows *proposed* state, but several chart
inputs are computed from *committed* state by a per-frame loop that knows
nothing about planning. The proposed TCI markers (0.6.1) were the first. Both
were fixed by handing the bridge an explicit override rather than letting
planning write to the chart directly, which would have been erased on the next
frame. Any future "planning shows the old value" report should be checked
against that list first.

Verified in Chromium: first-time threshold draws trajectory + dot + label;
labels absent by default and present with the setting on; handle at left+46 with
the peak unobstructed and a drag from the new position still solving (60 → 149
mg). 0 console errors. Suite 1065 → 1069.

### Planning mode: first test-note round (v0.6.1) — Interim

Six items from testing v0.6 on real devices. Five were real; the sixth was a
wording puzzle worth recording.

**Phone layout was broken in both orientations, for one root cause.** The split
switched on `max-width: 860px`, and a phone in landscape is 844×390 — wide
enough to miss the tablet path, so it stacked, and short enough that stacking
left the chart **75 px**. Measured, 844×390: chart 75 / entry 261. Portrait was
the same mistake from the other side — nothing guaranteed the chart a share, so
the keypad's intrinsic height won at 387 vs 405.

The fix is to stop treating "small" as one thing. **Landscape and portrait have
opposite scarce axes**: landscape is short and wide, so it must stay side by
side and buy chart width by compacting the entry column; portrait is tall and
narrow, so it stacks with the chart holding a `min-height` floor while the entry
shrinks and scrolls. Breakpoints now key off `orientation` and (for the compact
variant) `max-height`, never `max-width`. After: 844×390 → chart 345 side by
side; 390×844 → 480 / 257; iPad portrait → 865 / 261.

**The drag was fighting two brakes, and the second one was the real bug.** A
40 ms throttle capped it at 25 Hz — but `keypad.setCanonical` also fires
`onChange`, which went through the 180 ms keystroke debounce, and that timer
*restarts on every change*. During a continuous drag it therefore never expired:
the curve did not redraw at all until the finger stopped. Now the drag coalesces
on `requestAnimationFrame` and calls `recompute()` directly, with
`handleEntryChange` skipping the debounce while `dragging`.

The throttle turned out to be unfounded. Measured, warm-seeded from the previous
frame's answer:

| | ms per solve | clones |
|---|---|---|
| cold seed (fixed) | 3.24 | 4.3 |
| **warm seed (previous dose)** | **2.66** | 4.1 |
| reprojection | 1.12 | — |

So ~3.8 ms per frame against a 16 ms budget. The original 12 ms estimate assumed
the bracket search would grow from scratch each time; seeding it from the current
dose means it starts inside the bracket. Verified in the browser: **29 distinct
curve redraws across a 400 ms drag**, against zero before.

**Crossover dots on the proposal, with times.** The plugin already found the
downward crossing of the redose/emergence lines for the committed trajectory; it
now runs over `plan-preview-ce` as well. The dots are also labelled with the
crossing time in the axis's current units — a dot says the drug gets there, the
label says when, which is the number being planned around. Background drugs
deliberately get dots without labels; three or four would crowd the plot.

This forced a small extraction: the plugin needs `fmtXTick`, which lived in
`chart/index.js`, which imports the plugins. `js/ui/chart/time-format.js` now
holds `fmtTick` / `fmtXTick` / `xAxisTitle` plus a new `fmtTimeLabel` (adds the
"min" suffix that a bare number next to a concentration would otherwise lack;
h:mm and clock time are self-evident and don't get one).

**Proposed TCI plans drew as a bare curve.** The scheme a retarget generates
lives on the preview clone, so `chart-bridge`'s marker path — which reads the
live model and gates on the ⚑ toggle — had nothing to show. `project()` now
returns the clone's events, planning classifies them through the same
`classifyFutureEvents` (exported from chart-bridge rather than copied), and the
plugin draws them against `plan-preview-ce`, ignoring the toggle: seeing the
scheme *is* the reason to preview a target.

Two details found by looking at the render. The whole event list must be
classified, not the future slice — rate steps are labelled increase/decrease
against the preceding rate, so starting mid-sequence mislabels the first one.
But the *past* markers must then be dropped before drawing, or the plugin's
binary search clamps them to the preview's first sample and stacks them against
the left edge at the wrong height. Caught in a screenshot, not by a test.

**Ce titration granularity.** The report: fentanyl thresholds "jump in 0.1 ng/mL
steps", described as both "too granular" and "too fine". Those readings
contradict, so the numbers decided it: fentanyl rarely exceeds 1 ng/mL, and a
0.1 step gives ten increments across the entire clinical range. That is too
coarse however it's phrased, and the cause was `UNIT_DECIMALS['ng/mL'] = 1`
truncating every dragged value.

Bumping that constant globally would have been wrong — one decimal is right for
ketamine at 800 ng/mL. Instead Ce steps are declared per drug in
`DRUG_TASK_UNITS.ceTarget.quantSteps` (propofol 0.1 µg/mL, fentanyl 0.05 ng/mL,
ketamine 10 ng/mL), and `formatValueStep` derives display precision from the
step rather than the unit. One rule serves both ends of the range. Only values
*set* by stepping or dragging use it; readouts and history keep `formatValue`.

Adding those steps broke two unit tests that had used ceTarget as their
canonical "task with no quantSteps" example — updated to assert the new
per-drug steps, with a unit-outside-the-task case taking over the null role.
`getQuantizeConfig` only reads bolus/rate steps, so the planner is untouched.

Verified in Chromium at three viewports plus the full interaction set; 0 console
errors. Suite 1042 → 1065.

### Dose planning mode (v0.6) — Interim

Requested as: *"an optional planning mode that could be invoked from the dose entry
modal"* — the sim could visualise a decision already made, but not help make one.
The fast modal stays exactly as it is ("this works very well in practice"); planning
mode is a deliberate step up from it.

Scope agreed up front: bolus, rate, TCI target, redose threshold and emergence Ce.
The history event editor was explicitly excluded — it is a parallel implementation
(`event-editor.js`) and previewing an *edit in place* is a different problem from
previewing an append.

**Layout: a fourth `.screen`, not a body class.** The obvious approach — a
`body.planning-mode` class hiding `.drug-panel` and `#panel-history` — needs
overrides inside three separate media queries, because `.sim-main` is flex-column
on phones, flex-row on tablets, and a grid in tablet portrait where
`.sim-content` becomes `display:contents` and stops being a box at all. The
analysis screen already solved this: give it its own screen and teleport the
`.chart-area` node in. The live chart instance survives with its y-calibration,
inspect cursor and gesture bindings intact (gestures bind to
`canvas.parentElement`, which travels with the node). The keypad box is moved the
same way — never cloned, since `keypad.init()` binds the digit keys once at boot
via `querySelectorAll`.

**The preview runs on a clone, and that decision was measured.** Six strategies
were timed against a case carrying a full cet-emulation plan:

| strategy | ms |
|---|---|
| build a throwaway clone + replay 23 events | **0.77** |
| clone + addBolus + `computeCurve(0,720,10/60)` | 77.1 |
| clone + addBolus + `computeCurve(60,240,10/60)` | 30.3 |
| **clone + addBolus + `computeCurve(60,240,1)`** | **1.38** |
| in-place `getStateAtTime` → 180× `advance(1,R)` → `replayDrug` | 0.70 |
| in-place at 0.25-min sampling | 13.8 |

Two conclusions. **Building the clone is not the cost — sampling is.**
`engine.getExpm()` caches its Padé approximant for dt ∈ {0.1, 1, 10, 60} min and
nothing else, and `engine.reset()` clears that cache at the start of every replay,
so the chart's own 10/60 step recomputes a matrix exponential *per sample* — 81 ms
for a 12 h curve against 0.79 ms at step 1. The preview therefore samples in two
cached segments: 0.1 min over the first 20 minutes (enough to resolve a bolus
peak) then 1 min to the horizon.

And **the in-place pattern is not usable here**, despite being marginally
cheapest. `computeDecayTrajectory`'s snapshot-and-advance ignores every event
already queued in the future — which is precisely the case whenever a TCI plan is
running, i.e. the situation this feature exists to serve.

The clone is rebuilt on *every* projection rather than mutated and reverted.
`addBolus` merges into an in-flight bolus and rewrites the existing event's value
(`events/actions.js`), so `deleteEvent` was never a correct undo; `addRate` and
`addPause` defer to the bolus end and delete the paired system rate-restore. At
0.8 ms, rebuilding is cheaper than getting the undo right and removes the whole
class of bug.

**Preview must equal commit, so the commit logic is shared, not copied.**
`applyAction()` replays what `app.js onConfirm` does — `clearAfter` out of TCI,
`planTCI` from the delay offset, the pre-case rewind to t=0. The one piece that
could not safely be re-derived is the bolus delivery mode: `onConfirm` evaluates
`isInfusing` *after* flipping the drug to manual, so a drug in TCI with a redose
threshold set resolves to `pump`, while the keypad's own `pushOnly` (computed
before the flip, for the "Administer" label) says `push`. Rather than duplicate
that subtlety, `resolveBolusDeliveryMode()` was extracted in app.js and is now
called by both. Measured agreement between projection and commit: **5·10⁻¹³
µg/mL**.

**Back-solving the drag.** Ce is strictly increasing in dose (linear system,
non-negative input), so a bracket always exists and bisection always converges;
secant is tried first for speed and falls back to the bracket midpoint whenever it
would step outside, which stops it running away on the flat tail. Lands within
0.5% in ≤12 iterations (~1 ms each).

The handle's anchor and the solver's objective go through one function
(`anchorPoint`) because they must agree — otherwise dragging chases a number the
solver isn't targeting. The distinction that matters: a bolus is judged on its
peak **within the fine window**, not the global maximum of the projection. With a
drug left infusing, the global maximum is just the far end of the chart and has
nothing to do with the dose being entered. Caught in testing when the handle
reported a peak of 4.12 µg/mL at t=380 for a bolus given at t=20; pinned by a test
asserting the two are genuinely different values.

**Three problems found by driving the real app** (Playwright, Chromium; the CDN
Chart.js stack vendored locally since the browser has no proxy):

1. *No handle drawn at all.* `anchorPoint` returns `{time, Ce}` and the handle spec
   read `.ce`. The readout used `.Ce` and worked, which masked it.
2. *The axis rescaled under the finger.* Including the proposal in the autoscale is
   right — an overshooting dose must stay on screen, it carries the control
   surface — but recomputing it mid-drag made the curve shrink away as the user
   pulled it up. The autoscale now freezes for the duration of a drag and settles
   on release.
3. *Dragging to the floor stranded the user.* A dose solved to 0 cleared the
   preview and with it the handle, leaving nothing to drag back up. Zero is now a
   real projected value — it draws the baseline ("TCI stopped here, nothing
   given") and keeps its anchor. A 0 mg bolus event is still never fabricated; a
   zero *rate* is a genuine instruction and does insert one.

**Pre-existing bug surfaced, and fixed.** Selecting a drug with no events blanked
the chart entirely: `setCurveData`'s autoscale took its maximum from the curve and
the target line only, so fentanyl before its first dose with no propofol target set
gave `Math.ceil(0 × 1.3) = 0` — an empty plot with no axis ticks. Independent of
this feature (the autoscale knows nothing about planning), but planning mode makes
it acute, since planning a first fentanyl dose is exactly when you have no events.
Floored at the drug's default axis max. Confirmed against a pre-change build,
which only escaped it because `setCurveData` runs *before* `setTargetLine` in
`refresh()` and so still saw the outgoing drug's target propping the maximum up.

Verified end-to-end in the browser across bolus / rate / TCI target / emergence /
fentanyl (×1000 y-scale): preview renders and tracks typing, ± steps on the
quantize grid, drag solves both directions (55 → 149.3 mg up, → 0 down, back up by
±), committed curve dims to 0.28 alpha and restores, Cancel reopens the modal with
the buffer intact, Confirm produces the curve that was previewed, zero console
errors.

Tests: `tests/test-planning-preview.js`, 63 tests — clone fidelity per drug,
non-destructiveness under 25 projections, preview-equals-commit for five action
shapes, the cached-step sampling contract and segment join, anchor semantics,
solver round-trip and clamps, line tasks, zero-dose behaviour, and the new
setting's validation. Suite 979 → 1042, all green.

Known limitation, deliberately left: `applyAction` mirrors `app.js onConfirm`,
which cannot be imported into a Node test (it needs a live DOM). The tests pin
applyAction's own semantics, so a regression in `preview.js` is caught — but a
change to `onConfirm` that drifts away from them is not. The two carry pointers to
each other and must be read together.

### Chart: ghost crossover dots only when the projection is real (v0.5.49.1) — Interim

Refinement of v0.5.49, from a good catch: when a background drug's infusion is
**running**, its decay projection is a hypothetical — "what if I stopped now" —
not a forecast. The dot marked a crossing the drug was never going to reach.

Measured, ketamine background infusing at 3 mg/min, t=20 min:

| dot | lands at | drug's own ghost curve there |
|---|---|---|
| redose | t=30.8, y=300 | **761** |
| emergence | t=55.5, y=150 | **834** (still climbing) |

So the dots floated hundreds of units below the trace with nothing connecting
them. The foreground never shows this because it draws the dashed
`Ce (if stopped)` line, which both labels the hypothetical and gives the dot
something to sit on; background drugs draw no such line.

Considered adding a ghosted trajectory line for background drugs (the data was
already in the payload, so it was nearly free) and rendered a three-way
comparison. The better answer was the user's: **don't draw the dot unless the
projection is what will actually happen.** That condition — nothing more going
in — is precisely when the drug's own ghost Ce curve descends through the
threshold, so a drawn dot always sits on a visible line and the orphan case
cannot recur. No extra ink, and the semantics get stricter rather than looser.

Guard added ahead of `computeDecayTrajectory` in `updateGhostCrossings()`:
skip when `model.getRateAtTime(drugId, t) > 0`, and skip when any future event
is a bolus or a rate > 0. The strict second half matters — a drug paused with a
queued TCI step is still not going to follow the decay curve. `getRateAtTime`
already existed; `drugEvents` was already fetched for the empty-events check, so
the scan is free.

**Foreground deliberately untouched** — its labelled trajectory means its dots
are not misleading, and suppressing them would strip a shipped feature.

Side benefit: the guard sits *before* the decay simulation, so a running
background drug now costs zero decay sims instead of one per update — the
feature got cheaper, not more expensive.

Verified through the real bridge across four background states: infusion running
(no dots, 0 decay sims), stopped with nothing queued (dots, **gap = 0** between
dot and ghost curve), stopped with a future rate step (no dots), stopped with a
future bolus (no dots) — with the foreground trajectory confirmed present in all
four.

Harness note for next time: the bridge pushes `setGhostEnabled` from
`settings.ghostTracesEnabled` **every frame**, so a test stub returning `{}` from
`getSettings()` silently switches ghosts back off after you enable them
manually. Stub `{ ghostTracesEnabled: true, ghostOpacity: 0.5 }`.

### Chart: ghosted crossover dots for background drugs (v0.5.49) — Interim

Requested as "display the crossover dots as ghosts when the drug is in the
background". The premise needed correcting first: **background drugs had no
crossover dots at all**. `crossover-dots.js` found one dataset
(`role: 'emergence-traj'`), read `s.thresholdCe` / `s.exitCe`, and drew against
`ch.scales.y` — all three selected-drug-only, populated by `chart-bridge.js
onFrame`. So this was a feature addition, not a restyle.

**Naming trap worth flagging.** `role: 'ghost-drug'` (per-drug background traces)
is unrelated to `COLORS.ghost` / `role: 'ghost-reconcile'` (a purple
pre-reconciliation snapshot of the *selected* drug). This work belongs to the
former; the two share only the word.

Design — reuse the existing per-drug ghost machinery, don't build a parallel one:

- **Bridge** `updateGhostCrossings(t)` computes, per non-selected drug with
  events, the same target/guard the foreground uses (`min` of the positive
  thresholds; require `conc.Ce > target`), then `computeDecayTrajectory`, scaling
  Ce *and* both thresholds by that drug's `yScale`.
- **Chart** `setGhostCrossings(byDrug)` mirrors `setGhostTraces` — per-drug
  signature, early-return, `chart.update('none')` only when dirty. No dataset and
  no new axis: the dots are canvas-drawn, so nothing needs hiding from the legend.
- **Plugin** keeps the foreground path untouched and appends a background pass,
  with the arc drawing factored into one helper so the two can't drift. Dimming
  uses the `ctx.globalAlpha` precedent from `event-markers.js`.

Two decisions that carry the design:

1. **The dots sit on `yGhost_<drugId>`, never `scales.y`.** Easy to get wrong and
   impossible to eyeball: with propofol foreground (axis max 20) and ketamine
   background (max 10000, yScale 1000), the same threshold is y-pixel 662 on the
   right axis and −4159 on the foreground one. Wrong axis = dot silently off
   canvas, no error. Asserted numerically in testing.
2. **Cost is contained.** Each background drug is a full decay simulation. Gated
   on `chart.ghostTracesEnabled` so the default-off state costs nothing;
   throttled to the 2 s `lastHistoryDimUpdate` cadence rather than the 500 ms
   tick; and sampled at `{ step: 1 }` instead of the default 0.25 since the
   trajectory is only interpolated for a crossing, never drawn (52 points vs
   ~208). `refresh()` also calls it directly so dosing edits move the dots
   immediately.

Verified by sampling the rendered canvas at each predicted dot centre: redose
returned rgba(245,157,12,128) — `--amber` at exactly 0.5 `ghostOpacity` — and
emergence rgba(239,68,68,128) — `--red`, same alpha.

**Known limitation:** ketamine's `DRUG_DEFS.color` is `#f59e0b`, identical to
`--amber`, so on ketamine's *redose* ghost dot the drug-coloured ring is
invisible against the amber fill and it reads as a plain ghost dot. Its emergence
dot (red fill) is unaffected, as are the other drugs. Not worked around — the
alternative is colour-distance logic for one collision.

### History log: badge chip text optically centred (v0.5.48.3) — Interim

Reported as "the chip text doesn't look properly centred vertically". It wasn't —
at base scale a 13.69px chip had 1.85px above the glyphs and 4.84px below.

**Root cause is font metrics, not padding.** Canvas metrics for DM Mono at the
badge weight: `ascent 0.778em`, `descent 0.333em`, `capHeight 0.778em`. Cap height
*equals* the full ascent, so capitals touch the very top of the ascent box while
0.333em of descender space hangs empty below. `TCI`, `AUTO` and `MAN` contain no
descenders, so that entire gap collects underneath the text. The chip compounded
it by inheriting `line-height:1.3` from `.h-type` (padding the line box further)
and using symmetric `padding:1px 4px`, which cannot correct an asymmetry.

**The obvious fix is wrong, and this is the part worth remembering.** A fixed
`padding:2px 4px 0` looked perfect when checked at base and `text-xxl` — but the
error is not scale-invariant. Device-pixel rounding of the inherited
`1.3 × font-size` line height makes it oscillate:

| scale | base | text-lg | text-xl | text-xxl |
|---|---|---|---|---|
| off-centre | 1.49 | 0.99 | 0.50 | 1.49 |

so a fixed 1px shift *worsens* `text-xl` (0.50 → 1.00). Any two-scale spot check
would have shipped that.

Fixed with `line-height:1` + `padding:.36em .45em .16em`. `line-height:1` decouples
the chip box from `.h-type`; the 0.20em asymmetry pushes caps down to optical
centre; em units make the correction track `font-size:0.9em` instead of drifting.
The 0.20em difference was found by sweeping the padding *difference* against
measured error at all four scales — notably it beats the theoretically exact
0.333em (= descent − (ascent − capHeight)), which is perfect at base but 1.44px
out at `text-xl` once em padding rounds to device pixels. Worst case 1.49 → 0.68px,
and stable across scales. Residual is sub-pixel rounding plus genuine round-letter
overshoot (`O`, `C` sit a hair below the baseline by design) — not worth chasing.

Horizontal padding moved `4px` → `.45em` (4.05px at base) so chips breathe
proportionally at large text scales. Re-ran the wrap table before/after to confirm
the wider chips introduce no new wrapping — identical.

**Known gap, not fixed here:** that wrap check surfaced that at `text-lg` and above
combined with a 200px panel, labels still wrap. The v0.5.48.2 wrap fix was only
verified at the base text scale, so this predates this change and is untouched by
it. Worth a follow-up.

### History log: short labels + brighter bolus violet (v0.5.48.2) — Interim

Two fallouts from v0.5.48.1, both reported in use.

**Labels wrapped.** Adding a chip to every row spent horizontal budget the label
line didn't have. The history panel is `flex:1` of `.sim-content` with
`min-width:200px` (tablet-landscape block in `index.html`), so its real working
width is 200–240px, not the comfortable width it gets in a wide test viewport —
which is why the v0.5.48.1 screenshots missed it. Measured `.h-type` height ÷
`line-height` per row in the live panel:

| panel | `AUTO Rate Resumed` | `MAN Pump Stopped` | `MAN Pump Bolus` |
|---|---|---|---|
| 200px | 2 | 2 | 2 |
| 220px | 2 | 2 | 1 |
| 240px+ | 1 | 1 | 1 |

So the reported `Rate Resumed` was not a one-off — `Pump Stopped` was within a
character of the same failure. Shortened the whole set rather than patching one
string: **BOLUS / IV PUSH / RATE / RESUMED / STOPPED / PAUSED**, all one line at
every width. The dropped words were already carried by the chip and the category
colour, and `BOLUS` vs `IV PUSH` still expresses `deliveryMode`. Display strings
only — the `evt.annotation` values `js/sim/events/actions.js` matches on are
untouched.

**The bolus violet read as recessed.** `--purple` (`#8b5cf6`, violet-500) is
materially less luminous than the `--cyan` and `--red` rows next to it. Could not
just brighten the token: `--purple` is a **fill** under white text elsewhere
(`.btn-ctrl-rate.active-mode`, `.modal-btn-confirm-rate`, the manual-mode
indicator), where a lighter violet destroys contrast. The history rows need
violet as **ink** — a different requirement — so added `--purple-bright`,
following the existing `--blue`/`--blue-dim` precedent. Dark `#a78bfa`
(violet-400, already the push-bolus confirm fill and `COLORS.ghost`); light
`#7c3aed`, intentionally identical to light `--purple` because on a white card
the darker violet already is the correct ink. Only dark theme had the problem.

Process note: chose the shade from a rendered four-way comparison
(violet-500/400/300 and purple-500) shown against the cyan and red rows, rather
than reasoning about hex values in the abstract. Worth repeating — relative
luminance against neighbours is the thing that matters here, and it is not
legible from the numbers.

### History log: MAN chip + colour into the label text (v0.5.48.1) — Interim

Follow-up refining the v0.5.48 scheme on two axes the first pass left
half-expressed.

**Source chips are now complete.** v0.5.48 treated manual as "the unmarked
baseline" and gave it no chip. In use that read as an omission rather than a
default: the label column didn't align across rows, and the one source the user
is personally responsible for was the only one not stated. `sourceBadge` now
falls through to `MAN` (outlined `--text-secondary`), so the family is `TCI`
filled / `AUTO` outlined cyan / `MAN` outlined slate. Manual is the fallback
branch rather than an equality test, which also covers an unset `source` —
though `createEvent` already defaults it to `'manual'`.

**Category colour reaches the label text.** Previously only the 3px stripe
carried it (plus notation labels, which were already amber). Added
`.h-evt-* .h-type` colour rules at specificity `0,3,0` so they beat the base
`.history-row .h-type` rule, making the category readable when the stripe is at
the edge of vision on a narrow panel.

Deliberately stopped short of colouring the **value** line. Mocked up all three
reaches side by side (label-only / label+value / stops-only) and rendered them in
both themes before deciding: tinting the numeric readout cost contrast on the one
thing you read precisely, and the loss was worse in light theme. The value stays
`--text-primary` on every row.

**A TCI zero-rate hold moved from cyan to red**, joining the manual stop. Both
mean no drug is flowing, so red now carries exactly one meaning — *not
delivering* — and the `TCI` chip is what separates a planned hold from a
user-initiated stop. `typeClass` already emitted `h-evt-hold`; only its colour
moved.

One inheritance trap worth remembering: chips are nested **inside** `.h-type`, so
they would otherwise pick up the new category colour. `.h-badge-auto` and
`.h-badge-man` each set `color` explicitly, which both fixes the chip's own hue
and pins the `currentColor` its outline is drawn with — that is what keeps `MAN`
slate on a red `PUMP STOPPED` row. Do not "simplify" those to inherit.

### History log: category scheme with no dimmed rows (v0.5.48) — Interim

The history panel was signalling "this row matters less" by fading ink. Auto
rate-restore rows rendered at `opacity:.35`, italic, with their colour stripe
replaced by `--border-subtle`; pump stops carried a `--text-muted` slate stripe
that read as *disabled*. Both are events the user needs to read — the
rate-restore row is the one that explains why the pump returned to its previous
rate, and the CLAUDE.md invariant already requires those rows to stay visible.
Light theme made it worse: no history selector had a `[data-theme="light"]`
override and the bolus stripe was a hardcoded `#6d28d9`, a near-black violet on
a white card.

Root problem was channel overloading. The event shape carries `type`, `source`
and `deliveryMode`, but the row only expressed `type` (stripe colour) plus a
single `TCI` badge, so `source` had nowhere to live except the faded surface.
Reassigned to one meaning per channel:

| Channel | Encodes |
|---|---|
| left-border colour | what the event is — bolus `--purple`, rate `--cyan`, TCI hold `--cyan`, stop `--red`, note `--amber` |
| badge chip | who commanded it — `TCI` filled amber, `AUTO` outlined cyan, manual bare |
| row surface | commanded (filled `--bg-card`) vs. derived (transparent + 1px inset hairline) |
| row opacity | past vs. future *only* (`h-future`, unchanged) |

So a system row now recedes by surface while its label and value sit at full
contrast, and its label reads `Rate Resumed` (the `↩` prefix retired — the
`AUTO` chip carries that meaning). Kept the `h-system` class name; only its CSS
meaning changed. `typeClass` also gained `h-evt-hold` so a TCI zero-rate step
stops sharing a category with real rate commands.

Deliberately scoped out: past/future dimming stays as-is (temporal cue, not a
category cue), and the two-line row grid is untouched — recolour and chips only,
so nothing reflows across the four text-scale tiers. Chips did move from a fixed
`9px` to `0.9em` so they track `.h-type` at `text-lg`/`xl`/`xxl` instead of
shrinking into illegibility now that they are load-bearing.

Incidental fixes in the same block: `.h-type` raised from `--text-muted` to
`--text-secondary` (it was `#475569` on `#111827`) and made uppercase for all row
types; notation labels lost their italic and took the amber of their stripe; and
`.h-note-del` / `.t-sep` were pointed at `--border-subtle` — they referenced
`var(--border)`, which is defined in neither `:root` block.

`updateDimming()`, the `data-evt-id`/`data-evt-time` attributes, the merge/sort
in `render()` and `buildNoteRow` are all unchanged, so edit-mode selection and
the rAF dimming path are unaffected.

### Redose crossover dot shows without an emergence threshold (v0.5.47.1) — Interim

Bug fix to the crossover-highlights feature (v0.5.45). The orange dot marking where
the "Ce if stopped now" trend line crosses the redose threshold only appeared when an
emergence threshold was also set. Root cause: the trend line (`emergence-traj`
dataset, which `crossover-dots.js` reads) was computed in `chart-bridge.js onFrame`
only when `exitCe > 0`, targeting `exitCe`. Generalized it to project toward the
lowest set threshold — `Math.min` of the positive values among `getExitCe` and
`getIntermittentThreshold` — so the trend line exists whenever either threshold is set
and Ce is above it, descending far enough to cross both lines. Emergence-only and
both-set behavior is preserved (min collapses to the same target). Dataset role and
`setEmergenceTrajectory` setter names left unchanged to avoid churn.

### History timescale synced to chart x-axis (v0.5.47) — Interim

The history log's ET/RT time format was a separate, session-only toggle
(`_timeFormat` in `history.js`) that could disagree with the chart x-axis and
reset every reload. Unified them onto the shared, persisted `timeAxisMode` along
the real-time dimension only: `rt` → history shows clock time; `min`/`hmin` →
elapsed `h:mm:ss`. The history keeps its second precision; the chart keeps its
min-vs-h:min tick distinction (irrelevant to the log).

Single source of truth stays `settings.timeAxisMode`, reflected every frame in
`chart-bridge.js onFrame` — which now also (a) tracks the last non-`rt` mode,
(b) calls the new idempotent `history.setTimeFormat(fmt)` (replacing
`toggleTimeFormat`), and (c) reflects the history ET/RT button spans. The history
button handler (`app.js`) was rewritten to flip the shared setting: real-time
on → `rt`, off → `chartBridge.getLastNonRtMode()` (so the chart's tick style is
never destroyed). Both button surfaces and the Settings → Appearance segmented
control are now views of the one setting. History gains real-time persistence
for free. No new settings key.

### Removed stray hover circles + on-chart x-axis control (v0.5.46) — Interim

Two follow-ups to the v0.5.45 chart work.

**Hover-circle removal.** A user reported long-standing unfilled circles that ride
the Cp/Ce/trend lines and re-snap to the clicked x-position. They were not from any
custom plugin (cursor-dots, inspect-dots, crossover-dots all draw *filled* dots) —
they were Chart.js's built-in hover/active-element points. Every dataset sets
`pointRadius: 0`, but none disabled the hover radius, so the default
`pointHoverRadius: 4` drew a point on each curve at the active index. With
`interaction: { mode: 'index', intersect: false }`, hovering/clicking activates the
nearest index across all datasets, and the near-transparent dataset fills
(`color + '18'` / `transparent`) left just a colored ring. The tooltip is disabled
and `onClick` reads `event.x`, so nothing depended on hover activation. Fixed with
`options.elements.point.hoverRadius = 0` in `js/ui/chart/index.js`.

**On-chart x-axis time-scale button.** Added `btn-chart-timeaxis` to the
`#chart-controls` strip (`index.html`), a compact text button that cycles
`min → hmin → rt`. Wiring mirrors the persisted ghost-toggle pattern: the click
handler (`js/app.js`, "Wire chart controls" block) computes the next mode, persists
it via `settings.setSettings({ ...cur, timeAxisMode })`, and calls
`chart.setTimeAxisMode(next, timer.getWallClockStart()?.getTime())` for immediate
feedback. The button's *label* is reflected from the setting in `chart-bridge.js
onFrame` (idempotent, every frame — the rAF loop runs continuously), so it stays
correct whichever surface last changed the mode. The Settings → Appearance segmented
control re-seeds its `.active` state when the settings modal opens
(`settings-ui.js`), keeping the two controls in sync. `settings.timeAxisMode` stays
the single source of truth; no new chart/engine logic.

### Chart crossover highlights + selectable x-axis time scale (v0.5.45) — Interim

Two chart additions.

**Crossover dots.** The chart already draws a red dashed "emergence trajectory"
(the projected Ce-if-stopped-now decay, from `computeDecayTrajectory` →
`setEmergenceTrajectory`), which descends until it meets the horizontal emergence
threshold. Nothing marked *where* it crossed the threshold lines. Added a new
`afterDraw` canvas plugin `js/ui/chart/plugins/crossover-dots.js` (modeled on
`inspect-dots.js`) that finds the first downward crossing of the trend dataset
against `s.thresholdCe` (redose) and `s.exitCe` (emergence), interpolates the
crossing x, and draws an orange dot (redose) / red dot (emergence). Because both
thresholds are stored in the same chart y-units as the dataset and the plugin reads
existing state, there is no new state field and no per-frame bridge plumbing — it
self-heals across New Case. Registered after `inspectDots` so dots draw on top.
Colors come from `--amber`/`--red` so they match their lines and follow theme.

**Selectable x-axis time scale.** The x-axis was fixed to sim-minutes. Added a
Settings → Appearance "Time axis" segmented control (Min / H:Min / Real time),
following the Text size / Theme pattern (`DEFAULTS.timeAxisMode` +
`TIME_AXIS_MODES` validation in `settings.js`; grab/init/handler in
`settings-ui.js`; markup in `index.html`). The chart got a dedicated x-axis tick
formatter `fmtXTick` (the shared `fmtTick` still formats the y-axes) plus an
`xAxisTitle` helper and a `setTimeAxisMode(mode, wallClockStartMs)` setter that
updates the tick callback and axis title. `chart-bridge.js onFrame` pushes the mode
plus `timer.getWallClockStart()` every frame (idempotent). Real time reuses the
`history.js fmtTime` approach — `new Date(wallClockStart + m*60000)` → `H:MM` — and
falls back to h:min when no case start time is set. The setting lives inside the
`tci-warn-settings` blob, so it cloud-syncs with the other preferences with no
manifest change.

### History action-button row clipped "Edit" on narrow tablets (v0.5.44.13) — Interim

Reported from an iPad mini (2266×1488 physical → 1133 CSS px landscape): in the
split layout the events-history action row (time toggle · Add Event · notes
toggle · Edit) overflowed the ~285 px history panel and clipped the right edge of
the "Edit" button. Measured with Playwright across 1024–1366 px viewports: the row
needed ~284 px but the `flex:1` history panel shrinks to ~248–285 px at those
widths, so "Edit" was clipped by up to 35 px (and sat with only ~1 px of margin at
the iPad-mini width — hence the real-device clip). Root cause: the time/notes/edit
buttons carried fixed `min-width` floors (68/72/60 px) larger than their text,
inflating the row's minimum width. Fix (CSS-only, `.history-actions` block in
`index.html`): removed the three `min-width` floors, reduced the row padding
(`6px 12px` → `6px 8px`), gap (`6px` → `4px`), and per-button horizontal padding
(`10px` → `7px`), and set all four buttons to `flex:1 1 auto` so they size to
content and share the leftover space evenly instead of Add Event hogging it.
Verified the row fits with margin at every width from the 1020 px split-layout
minimum up, and stays visually balanced.

### Plateau exit band default lowered to ±2.5% (v0.5.44.12) — Interim

Followed the range narrowing by dropping the factory default exit band from
±5% to ±2.5% for earlier plateau-departure detection. Because 2.5% falls
between the old integer slider stops, moved the "Plateau exit band" slider to a
half-percent grid (`step` `1` → `0.5`, `value` `5` → `2.5` in `index.html`) and
made `settings-ui.js` decimal-aware: added `exitBandGridPct`/`exitBandToSlider`/
`exitBandLabel` helpers that snap to the 0.5% grid and format without a trailing
`.0` (so whole percents still read `±5%`), and switched the save path from
`parseInt`/`×100` integer handling to `parseFloat`. Updated `DEFAULTS.exitBandPct`
(settings.js) and `EXIT_BAND_DEFAULT` (drug-panel/formatters.js) to `0.025`, plus
the validation test's default-fallback assertion. The 0.01–0.05 validation window
is unchanged; saved user values are untouched.

### Plateau exit band range narrowed to ±1–5% (v0.5.44.11) — Interim

The Settings → Simulation "Plateau exit band" slider previously ranged ±2–10%.
Narrowed it to ±1–5%: the low end now allows finer tuning (down to ±1%), and the
upper half (±6–10%) was removed because a band that wide rarely flags a real
departure from plateau. Changed the `<input type="range">` `min`/`max` in
`index.html` (`2`/`10` → `1`/`5`, default value unchanged at `5`) and tightened
the `exitBandPct` validation window in `js/ui/settings.js` (`<= 0.20` → `<= 0.05`)
so persisted out-of-range values snap back to the ±5% default on load. Updated the
two affected assertions in `tests/test-settings-validation.mjs` (the out-of-range
comment and the round-trip fixture value, previously `0.10`, now `0.03`). Default
`exitBandPct` (0.05) and the predictor logic are unchanged.

### Landscape font inflation fixed with text-size-adjust (v0.5.44.10) — Interim

Reported after the v0.5.44.9 modal fix: on the same phone, the setup screen's
fonts looked inconsistently large in landscape versus portrait — the Eleveld
model description, the "Plan rounds to…" rounding note, and the dropdown values
all appeared roughly 2× bigger once rotated to landscape.

Diagnosis ruled out CSS: a headless render at 874×402 (landscape) and 402×874
(portrait) reported *identical* computed `font-size` for every element measured
(`.rounding-note` 10px, `.model-info-desc` 10px, `.form-row select` 14px in both
orientations). The divergence only appears on a real device, which points at
WebKit's **automatic text inflation** ("font boosting"): to keep body text
legible when a wide block would otherwise be zoomed, the engine scales fonts up
by a factor derived from the containing block's width relative to the viewport.
In landscape the setup form sits in a `flex-direction:row` layout and its text
blocks are wider, so the heuristic inflated them; the narrow portrait column did
not trigger it. The page had never set `text-size-adjust`, so the default
(`auto`) left inflation enabled — Chromium (and our `user-scalable=no` viewport)
happen not to inflate, which is why the headless numbers looked fine.

Fix is the standard normalize.css declaration on the root: `-webkit-text-size-adjust:100%; text-size-adjust:100%` added to the existing
`html,body` rule. `100%` (rather than `none`) disables inflation while still
honouring the user's OS/browser text-zoom preference. Verified the property
computes to `100%` and the authored font sizes are unchanged in headless; on iOS
Safari this makes landscape render the same authored sizes as portrait. One CSS
declaration, no markup or JS change.

### Patient Demographics modal side-by-side on short landscape (v0.5.44.9) — Interim

Reported from a small landscape screen: the Patient Demographics entry panel
(sex toggle + age/height/weight fields + built-in numeric keypad + Cancel/Confirm)
overflowed the viewport. `.modal-patient-box` had no `max-height`, and
`.modal-overlay` centres its child with `align-items:center`, so on a short
landscape viewport the stacked box was taller than the screen and got clipped at
*both* ends — the "Patient Demographics" header disappeared above the top edge and
the keypad's bottom row plus the Cancel/Confirm buttons disappeared below the
bottom edge, with no scroll affordance to reach them.

A first pass added `max-height:92vh; overflow-y:auto` to the box, but scrolling a
data-entry panel is a poor UX. The real fix restructures the layout: the fields and
keypad are wrapped in a `.pm-body` container and laid out **side by side** (fields
left, keypad right — the same two-column pattern the shared keypad modal already
uses) whenever the viewport is landscape and short. The header spans the top row and
the Cancel/Confirm actions span the bottom, so the whole panel fits the short height
with no scrolling.

Key details:
- **Trigger** is `@media (orientation:landscape) and (max-height:520px)` — keyed on
  orientation + height, *not* width. The reported device is a phone in landscape
  (~932×430 CSS px); its width exceeds the existing `max-width:900px` phone-landscape
  breakpoint, so a width-keyed query would have missed it. Tall landscape displays
  (iPad at ≥768 px height) keep the original stacked layout.
- **Box width** widens to 660 px so two columns fit. This needs the selector
  `.modal-box.modal-patient-box` (specificity 0,2,0) to out-specify the base
  `.modal-box{max-width:400px}` at line ~870, which otherwise wins on source order —
  the same reason the box was only ever 400 px wide before.
- **Sex toggle** is `overflow:hidden`, which lets it shrink below its content in a
  narrow flex column and clip the "Female" button; `flex-shrink:0` pins its natural
  width.

Verified with headless renders: iPhone-landscape (932×430) and a small landscape
(667×375) both lay out side by side with no scroll and the Confirm button visible;
iPad-landscape-tall (1024×768) keeps the stacked block layout. `max-height:92vh;
overflow-y:auto` is retained on the box purely as a last-resort fallback for
pathologically short viewports. CSS + markup wrapper only — no JS or behaviour
change.

### Progressive multi-tier maintenance grid (v0.5.44.8) — Interim

Follow-up to the v0.5.44.4 two-tier grid fix. Reported from the History view: for a
35 M/70 kg case the fine (÷10) grid engaged well before compartment filling (rates
showing `.5` increments like 106.5, 101.5 during the active case). The v0.5.44.4
trigger (`|Δexact| < one grid step`) is a poor saturation proxy — the extend-loop
makes early maintenance steps short, so the per-step decline drops below a grid step
while the rate is still ~40–50% above steady state. An interim saturation-proximity
trigger (`|exact − ssRate| < 3·gridStep`) improved it but still keyed off an estimate.

The design landed on a **progressive multi-tier grid** driven by the clinical
priority: clean coarse (integer) numbers through the **3–8 h window at Ce 2–5** matter;
11–16 h far-tail smoothness does not. The correction loop descends on the base display
grid and refines one tier at a time — divisors `[1, 5, 10, 50]` → `5 → 1 → 0.5 → 0.1
mcg/kg/min` (relative to each unit's own grid, so it generalises to mL/h, mg/min, and
other drugs). Refinement fires on a **genuine direction reversal**: when the tier-snapped rate changes
direction (down-then-up in a descent, or up-then-down) the grid has stopped tracking and
is about to hunt, so the loop refines (`tier++`) and **backtracks one step** — restoring
engine state / scheme / time before re-emitting on the finer grid. Only a direction
*change* triggers — not any up-move — which is what makes it robust to a target
**decrease**: after a drop, the required rate legitimately *rises* as V3 releases drug,
and an earlier "strict up-move" trigger mistook that monotone ascent for hunting and
cascaded straight to fine decimals (reported from the History view: a 3.5→2 drop showed
58.4/61.6/63.2 …). Tracking the trend direction keeps that ascent (and its later
decline) on clean integer rates, refining only at the actual near-SS hunt. Backtrack is
required: without it the over-shot step causes a Ce dip and a real rate bounce.

Design exploration (all validated against the real planner): "wait for the coarse grid
to stall (repeat)" is equivalent to the per-step trigger and mis-fires early; "strict
up-move" breaks on target decreases; a saturation-`finalTier` variant left the decrease
transient hunting on the coarse grid — the direction-reversal signal is the one that is
both unambiguous and direction-agnostic. Measured across 48–60 cases (2 patients ×
weights × targets):
**zero base-grid reversals** everywhere; the 3–8 h window stays on the clean 5-grid for
~93 % of Ce 3.5 and 100 % of Ce 5 (multi-tier keeps Ce 2–3 on integers — 5s then 1s —
where single-tier ÷10 would show `.5` decimals for 20–47 % of the window); costs (a
rougher band-riding far tail ~0.09 µg/mL and a ~−2 % transition dip) land at 10–16 h,
the clinically irrelevant zone. Some cases legitimately never refine (coarse grid holds
— ideal). Fully adaptive: no `computeSteadyStateRate`, no tuning constant. Loading-phase
band-riding (to ~+2.1 %) is pre-existing and unchanged.

`js/sim/tci/shared.js` adds `qRateDiv(mgMin, divisor)` to `makeQuantizers` (replacing the
single `qRateFine`/`TAIL_GRID_DIVISOR`); `js/sim/tci/emulation.js` correction loop tracks
a `tier` index + `lastRate` + a backtrack checkpoint. Regression guards rewritten:
`tests/test-tci-scheme.mjs` TEST 15 (zero base-grid reversals; Ce converges within the
band-riding envelope; target-change re-arm) and TEST 16 (active phase <2 h stays on the
5-grid; finer tiers appear only later).

### Restyle the Add Event button (v0.5.44.5) — Interim

Cosmetic follow-up to the notes-button restyle. The `#btn-add-event` label in the
history-actions row was "+ Add Event". Dropped the "+" and stacked the two words onto
their own lines ("Add" over "Event", via `Add<br>Event` + `line-height:1.15` on
`.h-action-add`) so it matches the two-line notes button beside it. `index.html`-only;
button id/classes and the `js/app.js` click handler untouched.

### Extended-case steady-state rate oscillation fix (v0.5.44.4) — Interim

Observed on the Compartment Analysis far-future tail: at ~11 h case time the
cet-emulation plan's infusion rate oscillated between two adjacent grid values
(90 ↔ 95 mcg/kg/min) every ~14 min, with Ce sawtoothing inside its ±CE_TOL band.
Diagnosis (confirmed numerically against the real Eleveld engine): a
quantized-actuator **limit cycle**. The maintenance correction loop
(`js/sim/tci/emulation.js` `planTCISchemeEmulation`) re-solves the exact
Ce-holding rate every `PROBE ≈ 2/ke0 ≈ 14 min` and snaps it to the display-unit
grid via `qRate`. Early in maintenance the required rate declines by more than a
grid step per probe (clean descending staircase); once V3 saturates
(k31 ≈ 0.0048/min, t½ ≈ 144 min) the true steady-state rate lands *between* grid
points and the memoryless re-rounding flip-flops. Coarseness is unit-dependent
(rounding is in the display unit): mcg/kg/min (step 5 → 0.35 mg/min, ~5.3% of a
3.5 target) is the coarsest and worst; mg/min (0.1) barely oscillates; mL/h at
20 mg/mL is as coarse as mcg/kg/min.

Analysis established that Ce_ss is exactly linear in rate, so the settled Ce gap
between two grid rates = grid-step / operating-rate; a hard "freeze to the
analytical SS rate" was rejected because it undershoots (a downward Ce sag
≈ 20.8% × (1 − V3 saturation) — ~4.9% at a 5 h switch, worse than the
oscillation). Instead: a **two-tier grid**. While per-probe corrections exceed
one normal grid step, snap on the normal grid (clean round numbers through
induction/active maintenance); once corrections converge below one grid step,
latch to a `TAIL_GRID_DIVISOR = 10` finer grid (0.5 mcg/kg/min / 0.1 mL/h /
0.01 mg/min). ÷10 keeps the worst-case ½-step settled-Ce offset under CE_TOL for
every unit/target (coarsest case, Ce 1.0 in mcg/kg/min: 9.2% → 0.9%), stays a
clean pump-programmable number at/above the pump's ~0.1 mL/h resolution, and lets
the extend-loop reach `MAX_DUR` so tail markers thin to ~1/hour. Because the
planner is a pure function replanned from the current loaded state, a target
change makes corrections large again → coarse rounding resumes → re-converges
(self-re-arming). Implementation: `js/util/units.js` `quantizeInDisplay` gains a
`stepOverride`; `js/sim/tci/shared.js` adds `TAIL_GRID_DIVISOR`, `qRateFine`, and
`rateGridStepMgMin`; the correction loop tracks `prevExact`/`useFine` and the
terminal SS append matches the grid the loop ended on. Inert when rounding is
off. Validated: far-tail Ce amplitude 0.005–0.05 µg/mL (10–35× reduction),
target held within ±0.4%, target-up/down settling — see `TCI-PLANNERS.md` and
`tests/test-tci-scheme.mjs` TEST 15.

### History notes button label stacks vertically (v0.5.44.3) — Interim

Follow-up to the v0.5.44.1 notes-button change. The "Show notes"/"Hide notes" label
now stacks the two words (verb over "notes") to match the "+ Add Event" button in the
same history-actions row. Implemented by wrapping the verb in a `<span class="notes-verb">`
(display:block) followed by a static "notes" text node — `index.html` markup + a CSS
rule near `.h-action-notes` (block span + `line-height:1.15`), and `js/app.js` now swaps
only the verb span's textContent ("Hide"/"Show") on init and click instead of the whole
button label. No behaviour change; the button stays always-lit (`--text-primary`).

### Emergence trajectory persists while pump paused (v0.5.44.2) — Interim

The red dashed emergence trajectory (`chart.setEmergenceTrajectory`) is drawn per
frame in `js/app/chart-bridge.js onFrame`. Its guard required a running infusion
(`getConcentrationsAt(...).rate > 0`), so when lowering the Ce target paused the pump
(rate→0) the line disappeared until the infusion restarted — even though that pause is
exactly the decay the line projects. `computeDecayTrajectory` (`js/sim/simulation.js`)
already advances at `engine.advance(step, 0)` (infusion stopped), so it needs no rate.
Replaced the pump-rate guard with `conc.Ce > exitCe` (both canonical mcg/mL, matching
the static exit line at chart-bridge.js:214-215): the line now shows whenever a target
is set and current Ce is above it, regardless of pump state, and clears once Ce reaches
the target. Also drops the pre-existing degenerate case (running pump, nothing on
board) where a flat line at Ce≈0 could draw.

### Three UI fixes: version status timestamps, history notes button label, persistent detail cursor (v0.5.44.1) — Interim

Three user-facing tweaks/bug-fixes.

1. **Version notification — two timestamps** (`js/app/sw-register.js`). The
   steady-state status line showed a single "Last update `<ts>`" that was really
   the install time of the running version, read by users as a "last checked"
   time. Added a `tcisim:lastCheckedAt` localStorage key, stamped inside
   `checkServerVersion()` on every completed poll (fetch ok + version regex
   matched, before the update-vs-no-update branch, so both paths record it;
   failed/offline polls that `return false` early do not). `refreshConnectivityStatus()`
   now renders "Last update check `<ts>`. Last version updated `<ts>`." (the
   check clause is omitted until we have a check time — offline first boot /
   no-SW path). The 60-second poll now repaints the steady-state line after a
   no-update result so the check time updates without a manual click.
2. **History notes button always lit** (`index.html`, `js/app.js`). Was dim when
   notations hidden, lit when shown, static "Notes" label. Dropped the
   `--text-muted` override (and the now-unused `.active` brightness rule) so it's
   always `--text-primary`; `js/app.js` now sets `textContent` to "Hide notes" /
   "Show notes" from `history.getNotationsVisible()` / `toggleNotations()` instead
   of toggling the `active` class. No change to `js/ui/history.js`.
3. **Persistent detail cursor** (`js/ui/chart/index.js`, `js/app/chart-bridge.js`).
   The inspect cursor reset on drug switch because two paths cleared
   `s.inspectTime`: `switchDrug()` and the chart-bridge `refresh()`
   (`clearInspect()`, also run after every dose/edit). Removed both. The four
   renderers (annotation line, inspect-handle, inspect-dots, readout-panel)
   recompute pixel positions from `s.inspectTime` on every draw, so the cursor
   stays at its time while `setCurveData` swaps in the new drug's curve.
   `s.inspectEnabled` was already preserved and `toggleInspect()` still clears the
   cursor when the mode is turned off; New Case recreates the chart and resets it.

### Test-suite improvement round 2: coverage gaps, de-fossilize, tolerance windows, suite guide (v0.5.44) — Interim

The five follow-up items proposed at the end of the v0.5.43 round (the user
said "fix them all"), plus a written suite guide. Test-only; 894 → 957 green.

1. **Coverage gaps closed.** `test-util-math.mjs` pins `js/util/math.js`
   (`mat4/eye4/mul4/mulVec4/add4/sub4/scale4/inv4/expm4`) against INDEPENDENT
   closed forms — diagonal exp = elementwise exp, nilpotent (N²=0) exp = I+N,
   A·A⁻¹ = I, singular → null — so the algebra layer under the engine's
   matrix-exponential advance is caught at the source, not just in aggregate via
   test-vs-simtiva. Also covers `js/util/color.js` (hexToRgba/alphaToHex/lighten).
   `test-settings-validation.mjs` drives the REAL `getSettings`/`setSettings`
   clamp matrix (out-of-range → default, enum rejection, wrong-type → default,
   reactionDelaySec clamp+0.5-snap, corrupt-JSON → defaults, round-trip) via a
   localStorage Map shim — settings.js imports cleanly under bare Node because
   alert-sound.js only touches `window` inside functions.
2. **De-fossilized test-reaction-delay** (`.js` → `.mjs`): it inlined a copy of
   `displayedSecToEvent` "kept in lockstep"; now imports the real one. The inline
   `snapReactionDelay` mirror it also carried moved into test-settings-validation
   as real-getSettings assertions (net: same coverage, now against production).
3. **test-integration → real chain.** Was inline event-list + inline planner +
   inline model + inline PD (all fossils). Rewritten on the production
   `createModel().planTCI(… cet-emulation)` with production pump config, keeping
   the curve-SHAPE assertions (Ce lags Cp, redistribution, rate step-down, BIS
   range, resolution agreement) that test-tci-plan-fidelity (endpoint-only)
   doesn't cover. One real-behavior correction surfaced: the old fixed-0.05-min
   bolus window put the rate-restore at t+0.05; the real facade puts it at the
   realistic delivery end (~t+0.4 for 50 mg), so the old `clearAfter(5.05)` was
   dropped (it would have deleted the restore).
4. **Incidental-timing locks → tolerance windows.** This is the deferred audit
   item #5. In test-steady-state-predictor, the exact-integer-MINUTE locks
   (timeToSsMin===856, plateau entryMin/exitMin===40/98/60/87) pinned values that
   are a function of the sampling grid + slope-tolerance knob — incidental, not
   clinical. They became `nearMin(actual, expected, ±few)` windows: still catch a
   "detection broke" regression (which moves the minute by tens or to null), but
   survive benign retuning. Ce_ss VALUE locks (analytic, cross-checked in TEST 1)
   and `=== 0`/`=== null` CONTRACTS stay exact. The header documents the split.
5. **Renamed misnomers.** test-sim-v2 → test-event-driven-sim; test-tci-tolerance-
   diagnostic → test-tci-tolerance-slider. Verified nothing imports them by name
   (the runner discovers by glob); headers updated with a "formerly" note.

Plus **tests/README.md** — a human-readable suite guide: run instructions, the
five-kind taxonomy (external baselines / clinical-outcome contracts / behavioral
invariants / round-trip contracts / engine-mechanics scaffolding), a per-file
what-it-guards table, the conventions (test-real-code, independent-oracles-stay-
inline, mini-event-list scaffolding, .mjs-vs-.js, exact-lock-vs-tolerance-window,
125-not-200 pump config), and a how-to-add checklist. No new js/ modules → sw.js
precache unchanged; version bumped per the every-code-change workflow.


### Test-suite improvement round: fidelity baseline, retire legacy, de-dupe (v0.5.43) — Interim

Follow-on to the 0.5.41.x/0.5.42 audit. The audit made the tests import real
production code; this round analysed whether the suite tests against a *proper
baseline* or merely locks existing behavior, and whether any of it is legacy or
redundant. Four changes (a fifth — downgrading the exact-minute change-detection
locks — was deliberately deferred):

1. **New clinical-outcome baseline (`test-tci-plan-fidelity.mjs`).** The gap the
   audit surfaced: no test drove `createModel().planTCI()`, the real production
   entry point. Every planner test called `planTCISchemeEmulation(...)` directly
   and replayed with a bespoke sampler, so the facade layer — live pump-settings
   read (the derived maxRate=125), event insertion, `getConcentrationsAt()`
   replay (the on-screen Ce card path) — was untested. That's exactly where the
   earlier maxRate bug hid. The new test iterates 5 patients × 3 Ce targets
   through the real facade and asserts a *clinical outcome*, not a fingerprint:
   onset (≥95% target ≤6 min), maintenance hold (±5% over 10–120 min), and a hard
   90% clinical floor from onset on. Measured margins on the real path: onset
   ≤3.6 min, hold within ±1.6% — the assertions have real headroom yet still trip
   on a broken therapeutic result. This is the "baseline" the suite was missing:
   behavior-property, tuning-independent, tied to what a clinician needs.
2. **maxRate faithfulness.** `test-tci-ce-tracking` and
   `test-tci-tolerance-diagnostic` drove the planner at `maxRate: 200`; the app
   derives 125 (`bolusRateMlH×concentration/60`, installed by setup.js on every
   case). Both corrected to 125 — the tests now match the delivery ceiling
   production actually enforces. Both stay green.
3. **Retire legacy.** `test-sim-v2` asserted READY/RUNNING/PAUSED transitions and
   stateChange callbacks on an inline `createSimulation` harness — an obsolete
   design; the production `simulation.js` facade is stateless (no getState, no
   start/pause). Those 13 assertions protected nothing real and were deleted
   (45→32); the behavioral sections (manual rate/bolus, edit, jump, multi-drug,
   tick fan-out) stay. `test-tci-tolerance-diagnostic` was a ~200-line printer
   around one real assertion (ceTolerance sweep ⇒ ≥2 distinct plans = slider is
   wired); trimmed to that assertion plus a per-plan reach-target check (1→6).
4. **De-duplicate scaffolding.** `test-model` / `test-integration` / `test-t0-edge`
   each inlined their own copy of the same ~50-line mini event-list (the exact
   drift pattern the audit fought). Extracted to one documented
   `tests/helpers/mini-event-list.mjs` (test-only, not precached). The helper is
   the union of the three (test-model's fuller CRUD API + `addManual*` aliases
   for the t=0 edge tests, no `status` field so test-model's absence-assertion
   still holds). Every assertion preserved (42/25/40); ~120 lines removed. Each
   test runs in its own process (run-tests.js spawnSync), so the helper's
   module-level id counter never leaks across suites.

Suite: 842 → 894 green. Test-only change; no shipped-code delta (version bumped
per the every-code-change workflow, sw.js in lockstep).


### cet-emulation is the production planner + default (v0.5.42) — Interim

Direct follow-on from the test-audit finding that the app's real behavior matches
cet-emulation (the SimTIVA deliver_cpt port), and the maintainer confirming the
other planners had no clinical advantage. Changes: factory default TCI Planning
Mode is now cet-emulation (was stepped); the setup-screen picker is hidden from
users (form-row #row-tci-mode, hidden by default) and revealed only when a
developer sets localStorage['tci-dev-planners']='true' and reloads. On restore,
a legacy saved mode (stepped/cet/cet-conservative) is honoured only with the dev
flag on — otherwise it's ignored so existing users migrate to cet-emulation. The
stepped / cet / cet-conservative planner modules and simulation.js's four-way
tciMode dispatch are LEFT INTACT for development. app.js getTciMode fallbacks and
setup.js getTciMode default both changed 'stepped' → 'cet-emulation'. Verified
headless: default hidden+emulation, dev-flag reveals + honours saved mode,
dev-off migrates a saved 'stepped' back to emulation.


### Test-suite audit: exercise real code, not inline copies (v0.5.41.3) — Interim

Audit finding: 14 of 26 test files loaded ZERO production code — they inlined
copies of the engine / Eleveld / planners / predictors and tested the copies,
which had silently drifted. Worst measured drift: inline Eleveld was 337% off
production Q3 for a 70y/55kg opioid patient; `test-vs-simtiva`'s headline
"0.0000% vs SimTIVA" validated a copy of the engine that never imported
js/pk/engine.js.

Converted to import real modules (renamed to .mjs where a big file needed
static imports without a 300-line async reindent; the runner already discovers
.mjs):
- test-vs-simtiva: real createEngine + calcEleveldParams; analytical +
  SimTIVA-tick + SimTIVA-param oracles kept inline (independent references).
  Verified real Eleveld matches the SimTIVA oracle within 0.1% across 7
  patients — no hidden production discrepancy.
- test-unit-safety: real validateParams.
- test-decay, test-steady-state-predictor: real predictors + engine + drug
  calculators; exact regression locks re-baselined to real output (propofol
  Ce_ss 2.857→3.017 at CL 1.79, ketamine Ce_ss 0.9375→0.776 at 63 mL/kg, etc.).
- New test-meta: version lockstep + precache-vs-disk (previously manual).

test-tci-scheme: converted to the real **CET planner** (planTCISchemeCET) — the
only planner used in production (stepped / cet-conservative / cet-emulation were
development aids, per the maintainer). Its inline copy was a stepped-style
variant matching neither shipping planner. Convergence bounds re-baselined to
CET's fast-onset reality (leading pause excluded from the rates-decrease check;
long-horizon band widened to CET's ~5.3% undershoot). TEST 13 reframed: the
quantize-in-loop plan is a genuinely different integer-mL/h plan (the loop
re-selects rates around the grid), so the guard is now "quantized plan still
converges to target" rather than "quantized ≈ unquantized."

CORRECTION (0.5.41.6): an earlier note here claimed enabling round-in-display-units "materially slows CET onset" (12-17% low for ~2 h). That was WRONG. It came from wiring test-tci-scheme to a DEVELOPMENT planner (planTCISchemeCET) with the wrong maxRate (200 vs the production 125 mg/min from 750 mL/h pump settings). The production planner is cet-emulation (planTCISchemeEmulation, the SimTIVA deliver_cpt port) — verified against the live app (35 y/70 kg, target 3.5, rounding ON): Ce reaches target by ~5 min and HOLDS the band (replay: Ce@5=3.04, @30=2.99, @60=3.01 for target 3.0, quantized). test-tci-scheme now imports planTCISchemeEmulation with the production pump config; step-count bounds re-baselined to emulation's fine cpt-interval step-down (~20 steps, tolerance-independent). Lesson: reproduce against the actual planTCI path / pump config before trusting a standalone planner call — the tell was a bolus mismatch (standalone 2350 vs app 2100 mcg/kg).

Follow-up (completed): the remaining inline-copy files now import real code —
test-fentanyl-pk / test-ketamine-pk (real calculators; population constants kept
as independent expected values), test-units (real converter), test-t0-edge /
test-model / test-reconcile (real engine; matrix-exp primitive checks reframed
through getSystemMatrix), test-sim-v2 / test-integration (real engine + real
Eleveld, dropping their inline drifted copies). Mini event/sim harnesses kept as
labelled scaffolding; reconcile's Cardano cubic and vs-simtiva's analytical
solver kept as deliberate independent oracles. Only test-pk retains a faithful
inline engine (it already imports the real Eleveld + PD, and its block includes
generic matrix-exp primitive tests that would be an anti-pattern to reframe).
The 4×4 matrix engine — previously copy-pasted across 11 files —

Superseded note: test-fentanyl-pk,
test-ketamine-pk (verified their inline constants match production exactly),
test-units, and the engine-mechanics files test-model / test-sim-v2 /
test-t0-edge / test-integration / test-reconcile.


### Unpaired-state: relabel, lighten, drop hints (v0.5.41.2) — Interim

v0.5.41.1 overshot (opacity .4 unreadable; the status-line hints read as untappable dead text; treatment diverged from the patient button). Final form per user direction: all five sync buttons relabel with the patient button's "⚙ Pair to enable …" language via a `SYNC_BUTTON_LABELS` table in `refreshSyncButtons()` (case buttons: "⚙ Pair to enable case sync"; compact template row: "⚙ Pair"), dim lightened to opacity .7 (the label explains the state — readability wins), the persistent hints and `noticeUnpaired`/`wasUnpaired` machinery removed, and the no-code tap is plain `openSettingsToSync()` again — identical to the patient button. The `animation:none` guard from 0.5.41.1 stays: without it the `.setup-form>*` fadeIn (fill-mode `both`) pins the case buttons at the retained final keyframe's opacity:1 and no dim applies at all.

### Unpaired-state legibility pass (v0.5.41.1) — Interim

Follow-up to v0.5.41: on the already-dashed, transparent sync buttons, `opacity:.55` alone didn't read as a state change. The unpaired treatment is now three reinforcing signals, all keeping the buttons tappable (tap → Settings → Sync): opacity .4 + `--text-muted` with the hover lift suppressed; a CSS `::before` ⚙ prefix on the four case/template buttons (scoped by id for the case pair — they share `.btn-pull-patient` with the patient button, whose relabel already carries its own ⚙); and a persistent "Not paired — tap to set up" hint in `#case-sync-status`/`#template-sync-status` written by `refreshSyncButtons()`. A `wasUnpaired` transition guard clears the hints exactly once on pairing — the sync-code input fires `tci:sync-code-change` per keystroke, and later refreshes must not clobber in-flight push/pull result messages.

### Setup sync UX + keypad standardization + prefs sync (v0.5.41) — Interim

Three user-reported items from live iPad use.

**Unpaired sync buttons (app.js).** `refreshPullButton` → `refreshSyncButtons`: the four case/template buttons now dim (`is-unpaired`) while no code is stored, and their no-code click path writes "Enter a sync code to pair — opening Settings…" to the adjacent status line via `noticeUnpaired()` before `openSettingsToSync()`. Same `tci:sync-code-change` listener as the patient button (which keeps its relabel treatment). The Settings-modal push button intentionally keeps its plain flow — it sits next to the code field.

**Starting doses on the shared keypad (keypad.js `showCustom`).** The template editor was the app's only native-input surface (iOS keyboard + `<select>`s). New one-shot custom session in keypad.js: `showCustom({drugId, task, title, value, unit, getWeightKg, onDone})` reuses the full modal but (a) never writes the in-case working unit-pref keys (`setUnit` guard — entries carry their own unit), (b) takes weight for per-kg previews from the caller (live setup weight input, unconfirmed patient is fine), (c) routes confirm/Clear to `onDone({value, unit} | null)` and clears itself on `close()`/`show()`. Setup markup: six `input+select` pairs → six `.start-dose-btn` displays; `setup.js saveTemplateEntry`/`refreshTemplateInputs` repaint labels ("50 mg" / "—"). Template schema unchanged.

**Preferences cloud sync (js/sync/prefs-sync.js, kind `prefs`).** Root cause of the loss: an iOS PWA reinstall wipes localStorage — and the sync code lives there too, so automatic recovery is impossible; the flow is re-enter code → pull. `prefsManifest()` is the single authoritative key list (settings blob, `-default` unit keys, quantize flag, pump max-rate/concentrations/enables, history toggle, metric/imperial, tci-mode/opioid, chart-ymax). Deliberate exclusions: sync code (circular), saved case + dose template (own sync kinds), working unit keys and `tci_last*` (transient). `applyPrefs` is manifest-filtered in both directions — non-manifest payload keys are never written (cloud data can't touch arbitrary localStorage), absent manifest keys are removed (mirror semantics) — and refuses newer-schema blobs outright. Apply always ends in `location.reload()`. UI in Settings → Sync (push/pull + status line); after a valid code is first entered, `offerCloudPrefs` checks the cloud and offers to apply (`window.confirm`) — the recovery flow. Server: `KINDS.prefs` (30 d, 8 KB), validation = flat string-valued object ≤ 64 keys.

### Sync hardening: rate limit + schema gate (v0.5.40.10) — Interim

R5, the last item from the 0.5.40.8 audit — the roadmap from that audit is now fully cleared.

**Per-IP rate limit (`api/sync.js`).** The endpoint stays intentionally unauthenticated (the pairing code is the only secret; documented trade-off for de-identified training data), but is no longer unbounded: a fixed-window counter (`tcisync:rl:{ip}`, INCR + EXPIRE 60 in the same Upstash Redis) rejects past 60 req/min/IP with 429 + Retry-After. Design points: the limit is deliberately generous because trainees can share one hospital NAT IP, and the limiter **fails open** (any Redis error → request proceeds) so it cannot become a new sync outage mode — a property the existing offline test suite exercises implicitly on every request (KV unconfigured → limiter throws → request still routes). IP from the first `x-forwarded-for` entry (Vercel). Test injection via `__test.setRedisForTest`; limiter tests cover the 60/61 boundary, per-IP isolation, Retry-After, and fail-open.

**Schema-version gate (`persist.js` + `cloud-sync.js`).** Saved cases have always carried `v: 1` but nothing checked it — a future breaking v2 blob pulled onto a not-yet-updated device would half-restore (known fields load, new semantics silently drop) and replay with different numbers than the sender intended; cross-device version skew is real (see the mixed-cache incident). Now: `CASE_SCHEMA_VERSION = 1` exported from persist.js; `loadCase()` and `validateIncomingCase()` both refuse `v > CASE_SCHEMA_VERSION`; the pull handler shows a distinct "saved by a newer app version — update this device" message via the new `isNewerSchema()` helper. saveCase's spread order deliberately lets a pulled blob keep its own `v`. Policy (in the persist.js comment): bump `v` only on BREAKING changes; additive fields stay v1 — the field-level fallbacks (`evt.deliveryMode || 'pump'` etc.) are the compatibility mechanism for those.

### Refactor round: deferred audit items R1–R4 (v0.5.40.9) — Interim

The improvement-grade items deferred from the 0.5.40.8 audit, executed **tests-first** in one PR: session round-trip tests landed before anything moved, then the mechanical epsilon rename, then the two dedup refactors. Equivalence was enforced with golden plan fingerprints (9 patient/target cases × all 4 planners, times to 6 decimals / values to 9) captured before the first change and re-checked after every phase — **bit-identical throughout**. Suite: 717 → 782 tests.

**R4 — session/persist coverage** (`tests/test-session-roundtrip.js`). The app-layer save/restore path had zero tests. The new suite runs the REAL `createSession` + `createModel` with a Map-backed `localStorage` and a minimal `document` stub (session.js only needs `getElementById(...)?.click()`), in-memory fakes for the injected deps. Covers the full field round-trip, re-anchor when the global pump rate changed between save and restore (asserts the plan's first rate step lands exactly on the recomputed bolus-end), system-event skip-and-regenerate, `newCase()` working-key reseeding, malformed-blob rejection, and per-drug concentration restore via `DRUG_IDS`.

**R3 — time epsilons.** `TIME_EPS_CLINICAL = 0.001` (60 ms, "same clinical instant": event identity, bolus-end anchors — 8 sites) and `TIME_EPS_IDENTITY = 1e-9` ("did this recomputed float time move at all" — 3 sites) now live in constants.js. Deliberately NOT unified: the two scales answer different questions, and `reanchorBolusDeliveries` legitimately uses both (IDENTITY to detect that a bolus-end moved, CLINICAL to find the step anchored at it). Left alone: query.js's 1e-12 strict loop terminators (tighter on purpose, now commented), emulation's 0.01 step-replacement window, decay-predictor's bisection tolerance, and every non-time epsilon (rate denominator floors, det guard, Ce tolerances).

**R2 — planner dedup + one cubic solver.** `searchPeakBolus` in shared.js absorbs stepped's `calculateLoadingBolus` and cet's `calculateCETBolus` — the two bodies were byte-identical except four tuning constants (`{upperMult, scanHorizon, scanStep, tol}`: 3/15/0.25/0.01 vs 8/20/0.1/0.005), now caller-supplied; `calculateCETBolus` survives as an exported wrapper because cet-conservative.js needs the raw unquantized search. `waitForDecay` and `floorMaintenanceRate` collapse the 3× decay-pause loop and 2× rate-floor idiom. The two cubic solvers became adapters over `js/pk/cubic.js solveCubicRoots` — return shapes (0-indexed vs SimTIVA's 1-indexed `[0, ...]`), unit conventions (per-min vs per-sec) and the clean-room header all preserved; only the polynomial core is shared, so a future numeric fix lands in both by construction. `tests/test-cubic-parity.js` pins scaling parity + the degenerate-case clamp. Also: emulation's rate-rounding grid `rf = 3600 / concentration` (literal 360 assumed 10 mg/mL; identical at default, correct now at 8.33/20).

**R1 — modal dedup.** `js/ui/keypad-buffer.js`: `applyBufferKey` (pure reducer for the prefilled-buffer keypress state machine; opts `{maxLen, allowDecimal}`), `convertBufferUnit` (the toCanonical→fromCanonical→formatValue round-trip, returns null on no-op so callers leave their buffer alone), `fmtDeliveryTime` (was byte-identical in two files), `bolusTimeText` (caller decides `pushOnly`). `js/ui/time-picker.js`: `makeTimePicker` factory + `buildTimeSelect`/`getSelectInt`. Call sites: keypad.js and event-editor.js map 1:1; patient-modal wraps the reducer per-field and keeps its `next`-key/age-integer handling at the call site (a `.` on the age field is a hard no-op that must not disarm the prefill — preserved explicitly); reconcile-modal uses the reducer with `prefilled` pinned false (it has no prefill by design) and `maxLen: 9`. Parameterized divergences, not unified: RT-label prefix (`= RT h:mm`, event editor) vs suffix (`= h:mm RT`, reconcile), and the "real"-tab enable source (`controls.isCaseStarted()` vs wall-clock presence). NOT folded in: patient-modal's metric/imperial demographics conversion (`setup._convertLength/_convertWeight` — different unit domain). `tests/test-keypad-buffer.js` pins the invariants.

**Still deferred (R5, unchanged):** api/sync.js rate limiting (unauthenticated by documented design) and a cloud-blob schema-version gate.

### Full-codebase audit round (v0.5.40.8) — Interim

A three-track audit (PK/sim core, UI layer, app wiring/sync/tests, plus a direct review of `api/sync.js`, the service worker, and PWA metadata) surfaced 3 confirmed bugs, 5 robustness gaps, and a set of dead code. All verified findings fixed this round; see CHANGELOG 0.5.40.8 for the full list. Highlights and rationale:

**Mixed-version cache boot failure (field report).** A device showed the boot diagnostic's "All files present but module failed" — the module graph dying at link time while every file fetches 200. Diagnosis: cross-deploy module mixing. `sw.js install` swallowed per-file precache failures ("runtime fetch handler will retry later"), so a flaky connection left a partial versioned cache; the runtime cache-miss fallback used default-cache-mode `fetch(req)`, so a stale browser HTTP cache could serve an old module version — which line-175 `cache.put` then poisoned into the current versioned cache *permanently*. Confirmed skew mechanism: 0.5.40.6 `units.js` exports no `getSetupDefaultUnit`; 0.5.40.7 `session.js`/`setup.js` import it → "does not provide an export named …" kills the graph, `__tciSimLoaded` never sets. Fixes: (1) same-origin precache is all-or-nothing — any app-file failure aborts the install (the previous SW and its complete cache stay active; CDN files remain tolerant); (2) same-origin cache-miss fetches use `cache: 'no-cache'` so the HTTP cache can never inject stale bytes; (3) the boot diagnostic now renders a **Reset cached app & reload** button (unregister SWs + delete all caches + reload) as the recovery path for already-stuck devices, which can't be rescued server-side.

**NaN eigenvalue clamp (`simtiva-reference.js cube()`).** The codebase has two copies of the trig-method cubic solver; `eigenvalues.js cubeRoots()` clamps the acos argument to [-1,1] (float error pushes it past ±1 when two eigenvalues nearly coincide) but the SimTIVA-side copy didn't — the fix was evidently applied to one copy and never back-ported. Unclamped, `acos(>1)` is NaN, which flows lambda → coefficients → `e_udf` → a NaN loading bolus with no error surfaced. Affects propofol CET(C)/CET(E) plans only, in a rare numerical corner. One-line fix; the two solvers are flagged to stay in lockstep (dedup into one shared function is on the roadmap below).

**Bolus-delivery duration had two sources of truth.** Curve replay used the per-case `drugConfigs` snapshot (the mechanism that lets restored cases replay at their saved concentration) while `getCumulativeDose` (history "Total delivered", reconciliation baseline) recomputed durations from the live global pump settings — divergent during in-progress boluses whenever snapshot ≠ live. `getCumulativeDose` now takes an optional per-event duration callback and both UI callers pass the event list's `getBolusDelivery`, so all three consumers share one duration. The constants-based default remains for back-compat (tests, no-model contexts).

**Restore generalized to `DRUG_IDS`.** `session.js restore()` wrote out propofol/fentanyl/ketamine literally (inside an empty catch) while `save()` iterated `DRUG_IDS`; a 4th drug would silently lose its saved concentration on restore. The block now loops `DRUG_IDS` with per-drug defaults from `DRUG_DEFS` (propofol's un-suffixed localStorage key special-cased), passes `pumpEnabled` unconditionally (setPumpSettings ignores it for pump-mandatory drugs), and logs restore failures. The purpose-built but never-wired `getAllPumpSettings`/`restorePumpSettings` pair in constants.js was deleted rather than adopted — the localStorage-per-key scheme is the established pattern. `saved.primaryDrug` (written since the field was added, never read) is now honored by programmatically clicking the drug card, reusing the full selection chain in app.js instead of duplicating it.

**Sync timeouts.** `fetch` on a stalled connection (captive portal, dropped Wi-Fi) may never reject; every push/pull button disables itself across the await, so the UI stuck at "Pulling…" forever. All three transports now go through `fetchWithTimeout` (AbortController, 15 s) in patient-sync.js; `AbortError` maps to a new `'timeout'` error kind with its own status-line message. Test stubs are unaffected (the signal is simply ignored).

**Test-runner trust.** Three gaps let CI report green on breakage: `.mjs` test files were excluded by the `endsWith('.js')` filter (both were real suites — 13 tests now included, 704 → 717); a non-zero exit *after* a printed summary (teardown throw) counted as ok; and a file printing no summary at all counted as ok. All three now fail the run, with distinct CRASH / NO-SUM labels.

**PWA icons.** `manifest.json` referenced `/icons/icon-192|512.png` — neither existed anywhere in the repo, and there was no `apple-touch-icon`, so iPad home-screen installs (the primary deployment) got a blank/screenshot icon. Placeholder icons (dark theme, propofol-yellow Ce curve + dashed target line) are generated by the dependency-free `tools/gen-icons.js` (pure-pixel rasterizer + hand-rolled PNG encoder; rerun `node tools/gen-icons.js .` from the repo root to regenerate). Linked in index.html, precached in sw.js. Swap in real artwork whenever ready — keep the same paths.

**Deferred to later rounds** (from the same audit, all improvement-grade):
- Deduplicate the modal logic copies (prefilled-buffer state machine, unit-toggle canonical round-trip, `fmtDeliveryTime`, time-picker/select builder) across keypad / event-editor / patient-modal / reconcile-modal into a shared helper.
- Deduplicate planner logic (peak-matched bolus binary search in stepped vs cet, target-decrease decay-pause loop ×3, rate-floor idiom) into `tci/shared.js`; fold the two cubic solvers into one.
- Centralize time-equality epsilons (currently `0.001` / `1e-9` / `1e-12` / `0.01` across the event layer — `reanchorBolusDeliveries` mixes two in one function) into a named constant in constants.js. Mechanical but touches many call sites; do with tests watching.
- Add `session.js` save/restore round-trip tests (the most intricate untested logic in the app layer) and `persist.js` coverage.
- `emulation.js` `rf = 360` rate-rounding grid assumes 10 mg/mL — derive from concentration.
- Optional: rate-limit `api/sync.js` (unauthenticated by documented design); add a schema-version gate so a future `v:2` case blob is rejected by older builds instead of half-restoring.

### Setting-persistence fixes: unit defaults, case concentration, non-sticky 8.33 (v0.5.40.7) — Interim

Three related persistence issues in how settings carry (or fail to carry) across cases.

**1. Preferred display units leaked from case to case.** The per-drug unit toggle wrote `tci-pref-{bolus|rate}Unit-{drug}` — by design the *same* key the setup screen read/wrote, so a mid-case swap overwrote the setup default and the next New Case inherited the swap. Fix: introduce a separate persistent **default** key (`…-default`) that the setup screen owns. New helpers in `js/util/units.js` — `getDefaultPrefKey()` (working key + `-default`) and `getSetupDefaultUnit()` (reads the default key, validates against `getAllowedUnits`, falls back to the static default). `setup.js populateUnitSelectors()` now preselects from the default key; `applyPumpSettings()` writes both the default key and the working key (so a setup change applies immediately); `setup.reset()` re-runs the selectors so New Case reflects persisted defaults rather than the previous case's DOM state. `session.js newCase()` reseeds each working key from the default. In-case consumers (keypad, event-editor, drug-panel, `getQuantizeConfig`) are unchanged, so mid-case swaps still stick and survive restore (restore deliberately leaves working keys alone).

**2. Pump concentration was not saved with a case.** It lived only in the global `tci-pump-concentration`; `session.js restore()` read that live global, so a case planned at 8.33 mg/mL replayed at whatever the global currently was (silently changing bolus volumes, since delivery math depends on concentration). Fix: `save()` records a per-drug `pumpConcentrations` map; `restore()` prefers it (`saved.pumpConcentrations?.<drug> ?? (parseFloat(global) || default)`), falling back to the global for old saves. `cloud-sync.js prepareCaseForPush()` only trims size, so the field flows through automatically.

**3. 8.33 mg/mL propofol must be non-sticky.** 8.33 is a nonstandard, site-specific value that must never become the persistent setup default. Fix: `js/util/constants.js` adds `NONSTICKY_PROPOFOL_CONCS = [8.33]` and `isStickyPropofolConc(v)` (tolerant compare, `< 0.005`). `applyPumpSettings()` skips persisting `tci-pump-concentration` when the value is non-sticky (it still applies to the live case via `setPumpSettings` and is saved with the case per fix #2); `restorePumpSettingsUI()` refuses to populate the setup select with a non-sticky value (belt-and-suspenders against a stale 8.33 from an older build), leaving the standard default. Net: setup never defaults to 8.33, but a case run at 8.33 applies and restores it faithfully.

Tests: `tests/test-setting-persistence.js` (17 assertions) covers `isStickyPropofolConc`, `getDefaultPrefKey`, and `getSetupDefaultUnit` including the key-decoupling invariant. Full suite green (704 tests).

### Side-by-side event acknowledgment buttons (v0.5.40.6) — Interim

User reported the "Got it" / "Missed it" buttons on the event-acknowledgment popup were too close together and easy to fat-finger. The warning popup (`js/ui/settings.js`, styled by `.warn-buttons` in `index.html`) rendered both as full-width thin bars stacked vertically with a 6 px gap — a small vertical miss hit the wrong action, and "Missed it — Recalculate" is destructive (clears TCI events and replans).

Fix (CSS only, `index.html`): `.warn-buttons` switched from `flex-direction:column` to `row` with the gap widened to 14 px; `.warn-dismiss` ("Got it") and `.warn-missed` ("Missed it") switched from `width:100%` to `flex:1` with padding bumped to `14px 12px` and `line-height:1.2` so the long label wraps rather than overflows. Result: two equal-width, taller buttons side-by-side — "Missed it" left, "Got it" right (matching the existing TCI modal convention; DOM order already produced this so no JS change). Non-TCI popups still show a single full-width "Got it". No logic changes.

### Propofol Ce card-vs-graph divergence after a pump max-rate correction (v0.5.40.5) — Interim

User reported the propofol drug card reading Ce ≈ 3.45 while the chart/inspect readout read ≈ 3.81 at the same instant. Reproduced in node: the trigger is a non-default concentration (8.33 mg/mL) plus a **mid-case change of the global pump max rate** (750 → 1000 mL/h) made before a target change (re-plan). The user clarified the rate change is almost always a *correction* of a setup value, so the right semantics is whole-timeline retroactive (the rate "was always" the corrected value); bolus dose in mg is invariant under re-rating (only the delivery duration/profile changes), which the user accepted.

Root cause (two layers):
- **Structural:** a bolus's delivery duration is recomputed live from the mutable global pump rate, and a TCI plan anchors its first rate step to the bolus-end time. `setGlobalMaxPumpRate` updated `getPumpSettings`/localStorage but never `model.refreshDrugConfig`, so the re-plan's planner (live `getPumpSettings` = 1000) placed the first rate step at the 1000 bolus-end while the engine (`state.drugConfigs` = 750) delivered to the 750 bolus-end — leaving a rate step **strictly inside** the active bolus window.
- **Divergence:** `computeCurve` only broke an advance at events and sample points, never at the bolus end, so the bolus rate bled past the end whenever it fell between samples (over-delivery, +0.21 µg/mL). `replayDrug` had a smaller mirror bug (moved `currentTime` backwards for an in-window event, over-integrating by the overhang, −0.02). An independent micro-step brute reference confirmed the card was ≈ correct and the graph was the large outlier.

Fixes:
- `js/sim/events/query.js` — `computeCurve` now advances via a helper that splits every step at the bolus-end boundary; a rate/pause event landing inside a bolus window defers to the bolus end (mirrors replay + `addRate`/`addPause`). Bit-identical to `getConcentrationsAt` at sample times.
- `js/sim/events/replay.js` — `replayDrug`/`replayDrugFrom` use `currentTime = Math.max(currentTime, evt.time)` so in-window events don't over-integrate.
- `js/sim/events/actions.js` — new `reanchorBolusDeliveries(drugId, oldRateMlH, newRateMlH)`: for every pump-mode bolus (whole timeline), recompute its delivery window and move the following rate/pause step from the old bolus-end to the new one. Dose (mg) untouched. Exposed via `events/index.js` and `simulation.js`.
- `js/app/settings-ui.js` + `js/app.js` — the mid-case Max Pump Rate control now reports old→new; app wires `refreshDrugConfig` + `reanchorBolusDeliveries` for each drug, then `refreshChart`.
- `js/app/session.js` — `save` records `bolusRateMlH`; `restore` re-anchors deliveries when the live global rate differs from the saved one, so reloaded cases (incl. those saved before this fix, via Fix 1) stay consistent.

Verification: new `tests/test-pump-rate-correction.js` (11 assertions) — clean plans and the corrected/reloaded cases show card == graph to ~1e-9 at sample times; the raw-collision graph no longer overshoots the brute reference; dose is preserved; steps land exactly on recomputed bolus-ends. Full suite 687 green. Lockstep version bump to `0.5.40.5`.

### Emergence trajectory continues past crossing (v0.5.40.1) — Interim

Follow-up to v0.5.40: the trajectory line ended exactly on the emergence threshold, which read as the line "stopping at" the line rather than passing through it. Added an `overshootMin` option to `computeDecayTrajectory` (`js/sim/simulation.js`, default 15 min) — instead of breaking at the first `Ce ≤ targetCe`, it records the crossing time and keeps sampling rate-0 decay until `overshootMin` minutes past it (still bounded by `maxLookahead`). The bridge gate is unchanged. Lockstep version bump to `0.5.40.1`.

### Emergence trajectory line (v0.5.40) — Interim

User request: when an emergence threshold is set AND an infusion is currently running, draw a continuously-updated emergence trajectory line on the chart showing the Ce concentration trajectory as it would proceed if the infusion were stopped — a dimmed red dashed line synced in appearance to the horizontal emergence threshold line.

The "emergence" concept is internally `exitCe` (the horizontal red dashed threshold line, drawn as an annotation in `js/ui/chart/annotations.js` at `c.red + s.overlayAlpha`, dash `[5,4]`, and the per-drug "Emerge → X in Y" countdown in `js/ui/drug-panel/exit-readout.js`). The countdown already predicts the rate-0 decay crossing via `simulation.js::predictDecayTo` → `predictTroughTime(engine, state, time, targetCe, /*rate*/0)` (`js/pk/decay-predictor.js`), restoring engine state with `replayDrug`. This change adds the *visual* counterpart.

Reused the **ghost reconciliation curve** as the template for a derived dashed dataset: a separate Chart.js dataset whose data is pushed each frame by the bridge through an idempotent, signature-cache-guarded setter, scaled by `yScale` for ng/mL drugs (`setGhostCurve` / `chart-bridge.js onFrame`).

Implementation:
- `js/sim/simulation.js` — `computeDecayTrajectory(drugId, time, targetCe, opts)`, a sibling of `predictDecayTo`. `getStateAtTime` → `engine.setState` → sample `engine.advance(step, 0)` (default 0.25 min) collecting `{time, Ce}`, anchored at the current Ce, stopping at the first `Ce ≤ targetCe` crossing or a 480-min safety cap → `replayDrug` to restore real state. Exported on the facade.
- `js/ui/chart/state.js` — `emergenceTrajSig` signature field (mirrors `ghostCurveSig`; includes `overlayAlpha` so the trace re-tints when overlay opacity changes).
- `js/ui/chart/index.js` — new `emergence-traj` dataset (red, dash `[5,4]`, width 1.5, `order:0`) + `setEmergenceTrajectory(points)` setter. Re-reads the live `--red` CSS var + `s.overlayAlpha` each call so it stays in lockstep with the threshold annotation across theme/opacity changes. Exported in the API object.
- `js/app/chart-bridge.js` — `onFrame` gate: `exitCe > 0 && t > 0 && getConcentrationsAt(...).rate > 0`. Computes the trajectory, scales by `ys`, pushes via the setter (cache prevents redundant `chart.update`); clears to null otherwise. Self-heals on New Case like the other idempotent setters.

No persistence (purely derived/live). 676 tests green (additive; engine state restored via `replayDrug`). Lockstep version bump to `0.5.40`.

### Additional drug concentrations (v0.5.39.7) — Interim

User request: add Propofol 8.33 mg/mL and Ketamine 100 mg/mL (10%) to the concentration pickers. Both are static `<select>` options in `index.html` (`#input-concentration`, `#input-ketamine-concentration`); `setup.js`/`app.js` read `.value` directly and there's no concentration allowlist, so adding `<option>`s is sufficient. Pump-derived `maxRate` and all mL↔mg conversions already flow from the selected concentration (`getPumpSettings`, `units.js`), so the new values are fully wired with no JS changes. Propofol option placed first (ascending: 8.33, 10, 20); ketamine appended (10, 50, 100). Lockstep version bump to `0.5.39.7`.

### Reconcile spread-mode rate units (v0.5.39.6) — Interim

Follow-up to the overshoot fix (the unit issue noted out-of-scope in v0.5.39.5). In Reconcile → Spread, the rate was hardcoded to canonical `mg/min` for every drug while the magnitude beside it used the drug's native mass unit (`fmtTotalMass`). For fentanyl (native mcg) this read `+50 mcg ... (0.001 mg/min for 60m)` — wrong unit and a tiny number the code worked around with a `toExponential` fallback.

Fix is display-only, `js/ui/reconcile-modal.js`. Added `_fmtRatePerMin(mgPerMin)` that converts a canonical mg/min rate to the drug's native rate unit via the modal's existing `mgToNative`/`nativeUnit` helpers and formats with the shared `formatValue` from `js/util/units.js` (`UNIT_DECIMALS` gives `mg/min` → 2 dp; `mcg/min` falls back to 2 dp, fine for small fentanyl rates). Used it in `_renderSummary()` (dropping the `rateStr`/`toExponential` hack) and in `_doReconcile()`'s history notation. Deliberately not `chart/rate-format.js::formatRateForDisplay` — that's chart-state-coupled and uses the user's *preferred* rate unit (could be `mcg/kg/min`), which would clash with the native-mass magnitude shown in the same sentence. No tests assert the annotation/summary strings (reconcile tests cover only pure dose math); 676 tests stay green. Lockstep version bump to `0.5.39.6`.

### Reconcile Totals overshoot fix — stale baseline (v0.5.39.5) — Interim

User report: dose reconciliation "felt like it was not working properly" in a recent case. Investigation (event-history edit → `Reconcile Totals`): the dose math itself is sound — `getCumulativeDose` (`js/sim/events/query.js`) is correct and unit-tested, `applyRateAugmentation` (`js/sim/simulation.js`) is correct for the infusion-only case, and the retrospective single-bolus rate-restore is benign (push delivery is seconds long; the restored rate equals the surrounding rate).

Root cause: the modal sampled `_simTotalMg` once on `open()` via `_computeSimTotal()` at the open-time clock, then never refreshed it. But `timer.getElapsedMinutes()` is wall-clock derived and the modal does not pause the case clock, so the simulated total grows in real time while the user reads the pump and types. The delta (`actual − _simTotalMg`) was measured against the open-time baseline but applied against the confirm-time clock, giving `final_total(now_confirm) = base(now_confirm) + delta = actual + rate·Δt` — a systematic overshoot proportional to infusion rate and dialog dwell time, zero only when paused. Both single-bolus and spread modes were affected (spread divides the same stale delta by `now`). The author had already noticed the clock drifts — `_doReconcile` captures `now` once "so a slow user clicking through the warning doesn't shift the case-clock baseline" — but only froze the mutation's timestamp, not the baseline the delta is measured against.

Fix (chosen scope: core + live display): parameterized `_computeSimTotal(now = _timer.getElapsedMinutes())`; `_confirm()` now captures `now` up-front (before the guards), re-samples `_computeSimTotal(now)` + `_computeDelta()` against that apply-time clock, and hands the same `now` to `_doReconcile` so the whole path is clock-consistent — `getCumulativeDose(now) == entered actual` exactly. `_render()` also re-samples the baseline each pass (cheap linear walk) so the displayed "Simulated total"/delta track the live clock and match what confirm applies. Added two regression tests to `tests/test-reconcile.js` pinning the "baseline must match apply-time clock" invariant (the stale-baseline path is asserted to overshoot; the apply-time path is asserted to land exactly) for single-bolus and spread. 676 tests green. Out of scope (noted): spread-mode annotation hardcodes `mg/min` and prints canonical-mg rate even for fentanyl (native mcg) — cosmetic, left as-is. Lockstep version bump to `0.5.39.5`.

### History auto-scroll to current time on drug swap (v0.5.39.4) — Interim

User report: swapping between drugs resets the event-history scroll to the top, so in TCI mode you have to scroll down to see the current time and future events. Root cause: `history.render()` rebuilds the list via `list.innerHTML = ...` (`js/ui/history.js`), and the browser resets the scroll container's `scrollTop` to 0 on innerHTML replacement. No scroll preservation existed.

Chosen behavior (user pick): auto-scroll to the "now" boundary rather than preserve the previous scrollTop — positions don't line up across drugs with different event counts, and the stated goal is to see current/future events. Added `scrollToNow()` to `history.js`: finds the first row with time `> now` (reusing the same `dataset.evtTime`/`dataset.annotTime` + `_getElapsedMinutes` conventions `updateDimming()` uses), then sets the `.history-area` (`list.parentElement`) scrollTop via a rect-based offset with a small lead so the last past row stays visible for context. All-past lists scroll to the bottom; empty lists early-return.

Called once from the drug-card click handler in `js/app.js`, after `refreshChart()` — both synchronous re-renders (the direct `history.render()` and the one inside `chart-bridge.refresh()`) have completed by then, so the scroll isn't undone. Deliberately kept out of the `render()` cadence so the scroll is never yanked while the user reads. DOM/scroll-only change, no PK impact; test suite stays green. Lockstep version bump to `0.5.39.4`.

### Event-log dose number formatting (v0.5.39.3) — Interim

User report: the "Starting Doses Queued" notation showed `140.0 mcg/kg/min` etc. and wrapped between the number and its unit (`Propofol 140.0` / `mcg/kg/min`). Two asks: strip trailing `.0` (but keep real fractions like `25.5`), and keep the number attached to its unit — made consistent.

`formatValue(value, unit)` in `js/util/units.js` was the right single point: it's the shared formatter every rate/bolus/dose/volume display funnels through (event rows via `fmtRate`/`fmtBolusDose`, keypad, step bar, chart labels, dose-template, TCI/redose/emergence annotations). Refactored it from a per-unit `toFixed(N)` if-chain to a `UNIT_DECIMALS` precision cap followed by `parseFloat(value.toFixed(dp)).toString()` — the codebase's existing trailing-zero-strip idiom (`session.js:213`, `units.js getRoundingNoteText`). This keeps the precision caps (no `140.333`) while dropping cosmetic zeros, and is safe: the agent sweep found no caller depends on fixed-width output and no test pinned `formatValue` strings except the two dose-template `displayText` assertions (updated).

For the wrapping, added `formatValueUnit(value, unit)` which joins the stripped value and unit with a non-breaking space (` `, written as the escape for source clarity; survives history's `esc()` since that only escapes `&<>"`). Used it in `dose-template.js buildTemplateDoses` (the reported notation) and in history's `fmtRate`/`fmtBolusDose` so event rows match. The ` + ` / ` · ` separators in `queueStartingDoses` stay ordinary spaces — sensible wrap points.

Scope: the independent live Ce readouts (`fmtCe`/`fmtCeSmart`/`fmtCeHTML`/`smartDecimal` in drug-panel) were left alone — they're fixed-decimal live readouts where stripping would cause width jitter, and weren't the complaint. The trailing-zero change does reach the short single-value annotations (TCI/redose/emergence) automatically via `formatValue`; their value+unit nbsp wasn't added (they rarely wrap) but `formatValueUnit` is available if wanted. Lockstep version bump to `0.5.39.3`.

### Starting-dose section: gate fix, divider, rename (v0.5.39.2) — Interim

Three follow-ups to the relocated starting-dose section. (1) Gating bug: the fields stayed visible when the checkbox was unchecked because `.start-doses-fields{display:flex}` (a class rule) overrode the UA `[hidden]{display:none}` — equal specificity, and author styles beat the UA sheet, so the `hidden` attribute had no effect. `updateStartDosesVisibility()` was setting `.hidden` correctly; the CSS just ignored it. Fix: `.start-doses-fields[hidden]{display:none}` (class+attribute specificity beats the bare class). (2) Visual division: wrapped the checkbox row + fields in a `.pump-settings.start-doses-section` card with a "Starting Doses" `card-title` and a 2px top border, so it reads as a distinct section from the Drug Configuration card, consistent with the other titled config cards. (3) Renamed the control "Give starting doses on Start" → "Apply Starting Doses to New Case" (user pick from offered options). Asset change → lockstep version bump to `0.5.39.2`.

### Starting-dose fields below the checkbox + cache-bust bump (v0.5.39.1) — Interim

User request: move the starting-dose entry fields out of the per-drug config tabs to directly below the "Give starting doses on Start" checkbox, and hide them until it's checked. Done in `index.html` (new `#start-doses-fields` section, per-drug groups) + `js/ui/setup.js` (`updateStartDosesVisibility`, called on init / checkbox change / cloud-pull refresh). Field IDs were preserved, so the template save/load/queue paths are untouched; pump-off drugs still hide their infusion row via `updatePumpToggleVisibility`.

Then user reported "does not appear to be working." Root cause was NOT the relocation code — it was a missing version bump. The three follow-up commits after the merged 0.5.39 base (queue-at-confirm, `pre` note ranking, field relocation) all changed `index.html`/`setup.js`/`app.js` but left `js/version.js` and `sw.js` at `0.5.39`. The service worker detects updates by byte-diff of `sw.js` and re-precaches assets only on a new `VERSION`; an unchanged `sw.js` meant the installed PWA never reinstalled the worker and kept serving the old cached layout. Fix: bump both files in lockstep to `0.5.39.1` (tweak level per the scheme), which changes `sw.js` bytes → SW reinstalls → re-caches the new `index.html`/`setup.js` → version-aware reload. Lesson reinforced: any asset change shipped to the PWA needs the lockstep version bump, even mid-feature follow-ups.

### Cloud case transfer + starting-dose template (v0.5.39) — Interim

User request: reuse the Vercel/Upstash scratchpad space for (a) keeping the last case in the cloud so it can move to another device, and (b) saved default starting doses (a bolus per drug + a propofol rate) applied when Start is pressed. Decisions confirmed up front: single default template (not a named-template library), local-first template with manual cloud push/pull, manual case push (no auto-push), 24 h case TTL.

API: one function, `kind` discriminator (`?kind=` on GET, `body.kind` on POST; absent → patient) rather than new serverless files — stays under Vercel Hobby's function limit and keeps the deployed scratchpad sender's no-kind contract byte-for-byte intact (guarded by tests, incl. ">1 KB patient body still 413"). Redis keys namespaced `tcisync:{code}:case` / `:template`; per-kind TTL/caps in a `KINDS` table (case 24 h / 64 KB — typical blob is 2–20 KB; template 30 d / 4 KB). The raw-stream cap is 70 KB with per-kind caps enforced after parse, preserving the patient 413 behavior. `@upstash/redis` is now lazily required *after* the env check so (1) the module is testable without node_modules and (2) missing env still reports `kv-not-configured`. Server-side validation of the new kinds is deliberately light (object + numeric `v` + `patient`/`events` or `drugs` keys) — the case blob is the app's own save format; full validation is client-side.

Case pull restores by writing the fetched blob through `persist.saveCase()` then calling `session.restore()` — no restore refactor. `saveCase` spreads the state after its `v`/`savedAt` defaults so the pulled blob's own fields win, and the pulled case doubles as the local "Restore Last Case". Pull lives on the setup screen only (restoring mid-case would clobber the running case); push is on the setup screen *and* Settings → Sync (reachable mid-case via the gear) through one shared handler. Push snapshots the live case (`session.save()`) first. `prepareCaseForPush` strips `reconciliationGhosts` (cosmetic chart overlays, the largest optional field) if the blob exceeds 64 KB, then gives up with "Case too large".

Template: per-drug value+unit pairs (display units, so mcg/kg scales with the patient), persisted to `tci-dose-template` on every input; `tci-dose-template-armed` backs the "Give starting doses on Start" checkbox. The fields live in a `#start-doses-fields` section directly below the checkbox (moved out of the per-drug config tabs on user request) and are `hidden` until the box is checked — `updateStartDosesVisibility()` toggles them on init, on checkbox change, and after a cloud template pull (`refreshTemplateInputs`); pump-off drugs still hide their infusion row via `updatePumpToggleVisibility`. `buildTemplateDoses` (pure, tested) expands the template into ordered items — per drug, rate before bolus, mirroring the keypad flow so the manual bolus's system rate-restore resumes the template rate; bolus delivery mode follows `pumpEnabled` (push when off); rates with pump off error `rate-needs-pump`; conversion failures (e.g. missing weight) error `conversion-failed`.

Application timing (revised after user feedback): the first cut applied the doses inside `onCaseStart`, which meant a blank history until Start — no warning of what pressing Start would do. Now `queueStartingDoses()` runs from setup's `onConfirm`, immediately after `initSimScreen`, inserting the doses as **ordinary pre-start events** via the same per-drug pre-start clock the keypad uses (rate at clock, advance 0.01; bolus at clock, advance by `bolusDeliveryMinutes`/push time). So the queued doses are visible in the history right away under a "Starting Doses Queued" notation, editable/deletable in Edit mode, shown on the chart, and Start simply runs the case — delivery is identical to manually keyed pre-start doses (including the system rate-restore resuming the template rate after a bolus). Restores can't double-queue (restore never passes through `onConfirm`), and a belt-and-braces per-drug "already has events" guard remains. A pre-case TCI target still wipes that drug's queued doses, consistent with existing pre-case re-target semantics. Skipped/errored items surface in the notation sub-line and console, never blocking confirm.

Ordering follow-up (user report): the queued-doses note rendered BELOW the t=0 rate row, because the 0.5.38 history merge ranks events before same-timestamp notations (notes as captions under the action they describe). That rule is right for the TCI-lifecycle notes but backwards for an announcement note. Added a `pre: true` flag on annotations (`addAnnotation({heading, sub, pre})` → stored on the notation, rank −1 in `history.render()`'s `(time, rank)` sort) so "Starting Doses Queued" renders above the t=0 events it announces. "Case Started" is flagged `pre` too (user follow-up) — it announces the case, so it belongs above the t=0 delivery rows, not sandwiched between them; both `pre` notes share time 0 and the stable sort keeps insertion order (Queued at confirm → Started at start → events). Default notes are unaffected; the flag persists through case save/restore like any annotation field.

Tests: `test-api-sync.js` drives the real handler with fake req/res and cleared env (validation failures short-circuit before Redis; anything reaching Redis 500s `kv-not-configured`, doubling as "validation passed"). `test-cloud-sync.js` injects `fetchImpl` mocks. `test-dose-template.js` exercises normalization against the real `DRUG_TASK_UNITS` and conversions through the real `toCanonical`. 674 total, all green. End-to-end network loop needs `vercel dev` or a preview deploy — on a static server every new button degrades to the existing "Sync endpoint not found" diagnostics.

### Don't duplicate "Case Started" on restore (v0.5.38.3) — Interim

Bug: restoring a case showed both a "Case Started" and a "Case Restored" notation freshly added at restore time. `session.restore()` loads the saved annotations (already containing the original "Case Started") and then calls `controls.ensureStarted()` to start the timer — `ensureStarted` fires the `onCaseStart` callback, which calls `addAnnotation('Case Started')`, minting a duplicate. `ensureStarted` is only ever called from restore (the keypad/Start paths use `handleButton`), so the fix is localized: `ensureStarted(opts)` forwards `opts` to `onCaseStart`, `onCaseStart(opts)` skips the annotation when `opts.restored`, and restore passes `{ restored: true }`. The normal Start button still logs "Case Started" (it calls `onCaseStart()` with no opts). No test added — the path is DOM/timer-coupled; verified by inspection + manual restore.

### Preserve TCI source on case restore (v0.5.38.2) — Interim

Bug: a restored TCI case showed its rate steps un-badged (treated as manual). `js/app/session.js` `save()` serializes `source` for every event, but `restore()`'s replay loop called `model.addRate(drugId, time, value, annotation)` with no `opts`, so `actions.js addRate` defaulted `source` to `'manual'` and the saved `'tci'` tag was lost. Boluses were unaffected — that branch already passed `{ source: evt.source || 'manual' }`.

Fix: pass the same `{ source: evt.source || 'manual' }` to `model.addRate` in the restore loop. The `model.addRate` facade already forwards `opts` (`simulation.js:200`) and `addRate` already honors `opts.source` (`actions.js:96`) — only the restore call was dropping it. `source` is metadata (history badge via `sourceBadge`), not used in replay, so concentrations are untouched. Pause events need no change: `addPause` has no source param and TCI never emits `'pause'`-type events (a TCI hold is a `rate:0` event, handled by the now-fixed rate branch).

Test: extended `tests/test-tci-bolus-restore.js` (real-module) with a save→restore round-trip — serialize a planned TCI case's events, re-insert them into a fresh model exactly as `restore()` does (passing source, skipping system rows), and assert the rate steps return with `source:'tci'`. `session.restore()` itself is DOM-coupled (initSimScreen/showScreen), so the model-level round-trip is the meaningful guard.

### Suppress rate-restore after TCI boluses (v0.5.38.1) — Interim

User observation: a TCI loading bolus in the event log is followed by the dimmed ↩ "Rate restored after bolus" (`source:'system'`) row, then the TCI plan's own rate steps — cluttered and confusing, especially as the restore shows the pre-plan rate (often 0).

Finding: that restore is **functionally redundant**. In `js/sim/events/replay.js` the bolus branch advances the engine transiently at the bolus rate but never touches `currentRate`, so the pump automatically resumes the pre-bolus rate afterward. The system rate-restore just sets the rate to the value it already is — removing it changes zero simulation output (verified). It exists only as a UI/audit marker, which is genuinely useful for *manual* boluses (the only log evidence the pump resumed) but redundant for TCI boluses (the plan's rate steps already define post-bolus delivery).

Decision (confirmed with user): suppress the restore **only for TCI-sourced boluses**. `js/sim/events/actions.js` `addBolus` now skips inserting the `source:'system'` event when `opts.source === 'tci'` (fresh-bolus path) or `existing.source === 'tci'` (merge path). Manual boluses keep theirs. Save/restore stays consistent — `js/app/session.js` re-inserts boluses with `source: evt.source` and skips saved `system` rows, so a restored TCI bolus regenerates no restore. The Case-1 "TCI rate step at the same maintenance rate" was intentionally left as-is (it documents the settling rate).

Testing note: the existing `test-*.js` files inline a reimplementation of the engine/events and don't exercise the real `addBolus`, so a regression test there would be meaningless. Added `tests/test-tci-bolus-restore.js` which dynamically imports the real `js/sim/simulation.js` (the runner executes any `test-*.js` that prints the `N passed, M failed` line) and asserts: TCI bolus → no `system` event; manual bolus → exactly one restore at the prior rate; and the plan still delivers toward target (no runaway from a stuck bolus rate).

### Notations in the event log (v0.5.38) — Interim

User request: surface narrative notations in the event history — two-line entries like `TCI Target Set / Ce 4.5 mcg/mL`, `TCI Ended / Manual Bolus`, `TCI Ended / Manual Rate Set`, `TCI Ended / Pump Stopped`.

Background: an annotation system already existed (`annotations[]` + `addAnnotation()` in `js/app.js`), persisted and restored, but its rendering was a known-temporary hack — `addAnnotation` and `session.restore` each `appendChild`'d rows using stale markup (`.h-step/.h-desc/.h-time`) that didn't match the real two-line history schema, and every `history.render()` (`list.innerHTML = …`) clobbered them. So notations never reliably showed.

Approach: make `history.render()` the single renderer that merges pump-command rows and notation rows, time-sorted, reusing the `.history-row` grid. Notations stay in the editorial `annotations[]` array — they must NOT enter the PK event list (engine-replay invariant). `addAnnotation` now takes `(text, drugId)` where `text` is a string or `{ heading, sub }`, and stores `{ id, timeMin, time, heading, sub, drug }`. The numeric `timeMin` lets notations interleave with events (which use numeric `evt.time`) and honor the ET/RT toggle. Both DOM-append hacks were removed; restore just calls `setAnnotations` and lets `refreshChart` → `history.render` paint.

Decisions (asked up front): (1) render ALL existing annotations as notation rows, not just the four TCI ones; (2) drug-tag notations — drug-specific ones show only in that drug's history, global ones (`drug === null`: Case Started/Restored) show everywhere; (3) notations are deletable in Edit mode (a ✕ per note → `deleteAnnotation` → re-render + save) and gated by a persisted **Notes** show/hide toggle (`tci-pref-history-show-notations`).

Wording was unified into one consistent scheme (heading = Title-Case action, sub = the detail), replacing the old inconsistent strings (`"Manual rate: X"`, `"Dropped out of TCI — manual bolus"`, `"Exit Ce set to X"`, `"TCI target Ce=X μg/mL"`). The four TCI-lifecycle notations are emitted explicitly at their call sites (pre-case keypad + running-case `tci-modal` for target-set; rate/bolus/pump-stop branches for TCI-end), and `onModeChange`'s detail-string fallback now drug-tags via the `drugId` it already receives. No legacy-format migration needed — the only restored data is the current-format interrupted-session snapshot.

Merge ordering: events rank before notations at the same timestamp (`sort` by `(time, rank)`, stable) so a notation reads as a caption under the action it describes. `updateDimming()` reads `data-annot-time` for notation rows so past/future dimming still applies.

### Bolus delivery-time display (v0.5.37) — Interim

User request: in the Add Bolus modals, show the time the bolus is expected to be given over, beneath the unit-conversion calculation section.

Approach: both modals (`js/ui/keypad.js` and the unified `js/ui/event-editor.js`) already compute the canonical mg dose inside `updateDisplay()` to render the unit-conversion line. Added a sibling `#keypad-bolus-time` / `#ee-bolus-time` element under each `#…-conversion` line and a small `fmtDeliveryTime(min)` helper (`Ns` under a minute, `M:SS` above) plus `updateBolusTime(doseMg)`. The duration math reuses the existing `bolusDeliveryMinutes` / `pushDeliveryMinutes` exports in `constants.js`, which mirror the delivery engine (`events/delivery.js`) — pump bolus at the configured `bolusRateMlH` (3 s min), IV push at 3600 mL/h (1 s min).

Both delivery times are shown when an infusion pump is available so the user can compare before tapping **Pump Bolus** vs **IV Push** (`Given over ~1:36 pump · ~20s push`). When the bolus is push-only — pump off, or in keypad a redose threshold is set while not in manual mode — it collapses to `Given over ~20s`. The line is cleared at the top of `updateDisplay()` so it disappears for non-bolus types / empty buffers.

### Expose max pump rate in settings (v0.5.36.0) — Interim

User request: make the global max pump rate changeable mid-case. It was only on the pre-case setup screen (`#input-max-pump-rate`, a 750/1000/1200 mL/h select that sets `bolusRateMlH` for all drugs via `applyPumpSettings` on Confirm), which is unreachable once a case is running — and there's no settings access from the setup screen either.

Approach: add a mirror control to the Settings → Simulation pane (`#set-max-pump-rate`). To avoid duplicating the "apply global rate to every drug + persist + sync setup control + refresh derived displays" logic, factored it into two exported helpers in `setup.js`: `getGlobalMaxPumpRate()` (reads `getPumpSettings('propofol').bolusRateMlH`) and `setGlobalMaxPumpRate(mlh)` (loops `SETUP_DRUGS` calling the partial-update `setPumpSettings`, persists `tci-pump-max-rate`, syncs `#input-max-pump-rate`, calls `updateAllPumpDerived`). `settings-ui.js` imports them, initializes the select, wires `change`, and re-syncs the select on modal open (so a restored case shows the right rate). No new import cycle — `setup.js` does not import `settings-ui.js`.

Mid-case semantics: TCI planners and bolus-delivery math read `getPumpSettings` live, so the change applies to subsequent plans/boluses; already-delivered events are untouched, and no automatic replan is triggered (that would be surprising). The derived mg/min `maxRate` is re-derived inside `setPumpSettings`.

### Cloud patient pull follow-ups (v0.5.35.1) — Interim

Two fixes on top of the 0.5.35.0 feature, both from real testing of the open PR.

- **Pairing unreachable from the setup screen.** User report: the Pull button told them to "pair in Settings → Sync" but the settings gear only exists on the sim-screen top bar — there is no way to open settings from the setup screen, where pairing actually needs to happen before a case starts. Fix: the Pull button is now state-aware. With no stored pairing code it relabels to "⚙ Pair to enable cloud pull" and opens the settings modal directly on the Sync tab (the modal is a top-level overlay, so it opens fine over the setup screen), focusing `#set-sync-code`; once a valid code is entered it relabels to "↓ Pull patient from cloud" live via the `tci:sync-code-change` event. The button stays enabled in both states rather than being a dead disabled control. `js/app.js`.
- **Vercel build failure.** `vercel.json` used `functions.runtime: "nodejs20.x"`, which is only valid for *community* runtimes (they need a `name@version` identifier) and failed the build with "Function Runtimes must have a valid version". The built-in Node runtime is auto-detected for `api/*.js`; pin its version via `engines.node` (`20.x`) in `package.json` instead and drop `vercel.json` entirely. Also added `.gitignore` (`node_modules`, `.env*`, `.vercel/`) and `DEPLOY.md` documenting the Upstash env-var setup.

---

### Cloud patient pull (v0.5.35.0) — Interim

User has a separate "scratchpad" PWA (on another device) where they enter patient demographics in imperial and convert to metric; they wanted those values to flow into TCIsim without re-typing. Constraints established with the user: cross-device (both apps on Vercel but different phones), iOS, de-identified/training data only. That rules out same-device transports (URL handoff, shared `localStorage`, `BroadcastChannel`) and Web Share Target (poor iOS support), leaving a network "scratch area."

Design: a small Vercel serverless endpoint (`api/sync.js`) backed by Upstash Redis. The two apps are paired by a user-entered 6-character code (`^[A-HJ-NP-Z2-9]{6}$` — no ambiguous 0/O/1/I). The scratchpad generates/displays the code and continuously pushes (auto, debounced, no Send button); TCIsim requires the code in **Settings → Sync** and pulls on demand. Only **age, sex, height, weight** transfer (opioid is never synced); the payload is canonical metric with a server-set `updatedAt`. Entries carry a 30-min TTL so a reused code never serves stale demographics, and the UI shows "updated N min ago" (amber if > 10 min) so the user can confirm freshness.

Implementation notes:
- **Reuse over new coupling.** Injection goes through `patient-modal.js`'s `_writeHidden` (now exported) → dispatched `input`/`change` events → the existing `setup.js` reactive pipeline recomputes previews/derived/summary. No new hooks into setup's render functions. Metric→display conversion lives in a pure `canonicalToDisplay()`.
- **Build-step-free preserved.** `package.json` exists only to declare `@upstash/redis` for the serverless function. It intentionally **omits `"type": "module"`** — adding it would make Node treat the CommonJS test runner (`tests/run-tests.js`, which uses `require`) as ESM and break it. Consequently `api/sync.js` is written in CommonJS (`require` / `module.exports`). The browser PWA loads ESM via `<script type="module">` regardless of package.json.
- **SW `/api/` bypass.** The cache-first fetch handler now early-returns for `/api/*` so sync responses are always live and never cached/served offline.
- **Local dev.** `python3 -m http.server` does not execute `/api`, so the Pull button shows a graceful "Sync unavailable" error locally. For end-to-end sync testing use `npm i && vercel dev` (or a Vercel Preview) with the Upstash env vars set.
- **Env / config.** Serverless reads `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN`, and `SYNC_ALLOWED_ORIGINS` (CORS allow-list — must include the scratchpad's origin; the JSON POST triggers an OPTIONS preflight which the function handles). The Node runtime is pinned via `engines.node` in `package.json` (`20.x`); Vercel auto-detects `api/*.js` so no `vercel.json` is needed. (An early `vercel.json` using `functions.runtime: "nodejs20.x"` broke the build — that key is for community runtimes needing `name@version`; the built-in Node runtime is configured via `engines` instead.)
- **Privacy / scope.** De-identified training data only; server validates ranges, caps the body at 1 KB, and the endpoint is unauthenticated (the code is the only secret) with last-writer-wins. Documented in `SCRATCHPAD-SYNC-SPEC.md`, which also carries the POST contract and a drop-in debounced auto-push snippet for the scratchpad's own coding session.
- **Tests.** `tests/test-patient-sync.js` dynamically imports the real module (no top-level DOM/network access) and covers code normalization/validation, payload normalization + range checks, metric→imperial conversion, and relative-time boundaries. Suite is green at 554 tests.

---

### Fix TCI first-step countdown ignoring reaction delay (v0.5.34.2) — Interim

User report: the reaction-delay feature *"seems to be inverted — telling the user to initiate the event one second late instead of one second early."* Narrowed down by the user's follow-up: lowering the target raises a "pause the pump" countdown alert, and the drug-panel countdown in the background reaches zero ~1 s *before* that alert's countdown finishes.

Root cause: the reaction-delay offset (v0.5.34.0) was wired into `js/ui/settings.js` (prep/alert/popup/zero-chime) and `js/ui/drug-panel/step-bar.js`, but **not** into `js/app/tci-modal.js`'s first-step countdown. That modal — which appears whenever a TCI plan is committed, including a target-down replan whose first step is "Hold infusion (pump off)" — counted down the raw `delaySeconds` and reached "Now!" at the real event time `T`. The step bar, correctly offset, reached zero at `T − reactionDelaySec`. So the two countdowns ran `reactionDelaySec` apart, and the prominent modal fired *late* relative to every other cue. A trainee following the modal would then act `reactionDelaySec` after `T` — exactly the "one second late" inversion reported.

Fix: `showFirstStep()` now reads `getSettings().reactionDelaySec` and starts the countdown at `Math.max(0, delaySeconds − reactionDelaySec)`, so the modal reaches "Now!" at `T − reactionDelaySec` in lockstep with the step bar and alert popup. The planned event time in the engine/event list is unchanged. Default reaction delay is 0, so existing behavior is unaffected until a user opts in. No import cycle: `settings.js` does not import `tci-modal.js`.

---

### Fix missed keystrokes on rapid keypad entry (v0.5.34.1) — Interim

User report: *"Have noticed I am getting missed keystrokes on keypad entry. With rapid entry, the key is seen as pressed (highlights when touched) but not registered."* The visual `:active` highlight firing while the digit fails to register is the diagnostic tell — `:active` is driven by the real pointer event, but the input handler was wired to `click`, a synthesized event that mobile browsers (iOS Safari especially) are free to coalesce or drop under rapid successive taps. `touch-action: manipulation` removes the 300 ms double-tap delay but does not make synthesized click delivery reliable for fast keypad input.

Fix: rebind the three modal keypads to `pointerdown` and call `preventDefault()` to suppress the follow-on synthesized click that would otherwise double-register the press.

- `js/ui/keypad.js` — main keypad (`#modal-keypad .key`).
- `js/ui/patient-modal.js` — patient demographics (`.pm-key`). The `[disabled]` state of `Next →` already uses `pointer-events:none`, so disabled buttons remain inert under `pointerdown`.
- `js/ui/event-editor.js` — event editor (`#modal-evt-editor .ee-key`).

Non-keypad buttons (Confirm/Cancel, Next, sex/unit toggles, pause-mode tabs, etc.) keep `click`. They're not tapped at high rates and `click` gives correct slide-off-to-cancel semantics for them. The `:active` CSS keeps working because it has always been driven by the underlying pointer event, not by `click`.

---

### Bolus shown in mL/h + adjustable reaction delay (v0.5.34.0) — Interim

User report: *"I think there might be an issue with the bolus rate — when I run propofol it shows the rate way over the pump's max."* On investigation the rate was correct; the user was looking at the drug card's `mcg/kg/min` readout during a bolus and reading it as `mL/h`. The conversion gap between the sim's display units and what the real pump shows is a recurring source of confusion. Two changes follow from that — a display alignment and a presentation-layer reaction-time setting.

**Part A — Bolus display in mL/h on the drug card.** During a pump-delivered bolus, the drug card's "rate" line now forces `mL/h` (mirroring the actual pump screen) regardless of the user's preferred rate unit. The mL/h figure is converted via the user's currently-configured pump concentration (`getPumpSettings(drug).concentration`), so it agrees with the real pump rather than the drug's `DRUG_DEFS` default. History rows show the bolus dose only — keeping them clinically focused on the prescribed amount.

- `js/ui/drug-panel/formatters.js` — `fmtRateInline` accepts `opts.bolusOverride`; when true, forces `mL/h` and threads the live pump concentration through `fromCanonical`.
- `js/ui/drug-panel/index.js` — drug card detects "bolus in progress" via the existing `isInBolusPhase(ctx, dId, t) || rate > 50` heuristic and passes `bolusOverride`.

Fentanyl and ketamine's *default* rate-display units (`mcg/kg/min`, `mg/kg/h`) are unchanged. That's the unit-mismatch root cause but flipping defaults silently would surprise existing users; leaving it as a follow-up.

**Part B — Reaction-time presentation offset.** A new Notifications-tab slider (`Reaction delay — present TCI cues this much earlier`, 0–2 s, step 0.5 s, default 0). It does *not* move events in the engine, history, or chart — it only shifts the displayed "seconds to next event" earlier for TCI-scheduled user-action events (`source: 'tci'`, type bolus/rate/pause). The countdown reaches zero `reactionDelaySec` seconds before the event actually fires; prep visual pulse, prep chime, alert popup, warning chime, and the zero-chime all trigger that much earlier. System-generated rate restorations after a bolus (`source: 'system'`) are not offset — those don't require a human at the pump. Manual events also bypass the offset since the user is already in the loop when dispatching them.

The implementation is a single helper, `displayedSecToEvent(evt, currentMin, reactionDelaySec)`, in `js/ui/settings.js`. Every site that compared "seconds to event" against a threshold or rendered a countdown routes through it: `settings.check()` prep/alert/zero-chime, the popup's live countdown, and `drug-panel/step-bar.js`'s bar progress + countdown text (where the bar fill is also rescaled so it reaches 100% at displayed-zero, keeping bar and countdown visually in sync). Exit-readout (emergence countdown) is *not* routed through the helper — emergence is a passive observation, not a user-action prompt.

The setting persists under the existing `'tci-warn-settings'` JSON blob. Validator clamps to `[0, 2]` and snaps to the 0.5-s grid; bad values (NaN, negative, out of range) fall back to the default of 0.

19 new tests in `tests/test-reaction-delay.js` cover: identity when delay = 0, exact shift for each event type, floor at 0, system and manual sources untouched, non-actionable event types untouched, validator clamp + snap. Full suite is 512 tests, all passing.

- `js/ui/settings.js` — DEFAULTS, validator, setter destructure, `displayedSecToEvent` export, `check()` + `_showPopup()` wiring.
- `js/ui/drug-panel/step-bar.js` — import + use the helper; bar fill rescaled to `displayedTime - prevTime` window.
- `js/app/settings-ui.js` + `index.html` — slider + readout in Notifications tab.
- `js/version.js` + `sw.js` — bumped `0.5.33.8 → 0.5.34.0` in lockstep.

### Version bump to retrigger deployment (v0.5.33.8) — Interim

v0.5.33.7's deployment did not complete cleanly. Bumping `VERSION` in `js/version.js` and `sw.js` in lockstep produces a fresh service-worker `CACHE_NAME` (`tcisim-v0.5.33.8`), which forces each client to fetch the new bundle on next navigation and gives the deploy pipeline a new commit to act on.

No code changes — patch-level bump only, per the CLAUDE.md scheme: "Never bump a higher-level version because a lower level looks 'full'." `0.5.33.7 → 0.5.33.8` is the right shape for a routine deploy retrigger.

### Pre-case TCI re-target was additive instead of replacing the prior plan (v0.5.33.7) — Interim

User report: *"If you set a target, then set another target before hitting Start, it is additive."*

**Reproduction.** Fresh case (do not tap Start). Tap Set Target propofol → Ce 4.0. Tap Set Target again → Ce 2.0. Tap Start. Expected: a single loading bolus sized for Ce 2.0 + the Ce 2.0 maintenance ramp. Actual: two stacked loading boluses (sized for plans #1 and #2 respectively) delivered at the case origin, then the Ce 2.0 maintenance.

**Mechanism.** The pre-case `'ceTarget'` handler in `js/app.js:404–430` reads a per-drug `preStartClock` (defined at `js/app.js:43–45`), passes it as `fromTime` into `model.planTCI`, then advances the clock by 0.01 min. Inside `planTCI` (`js/sim/simulation.js:232–285`), the very first step is `eventList.clearAfter(drugId, fromTime)` — which removes events with `time > fromTime`, **strictly** (`js/sim/events/list-ops.js:63–69`).

Walk through:

- **Set Target #1 (Ce 4.0)** — `t = 0`. `clearAfter(propofol, 0)` is a no-op (no prior events). Plan inserts bolus at t=0, rate steps at t=0, 0.5, 1.0, … `advancePreStartClock` → 0.01.
- **Set Target #2 (Ce 2.0)** — `t = 0.01`. `clearAfter(propofol, 0.01)` removes events with `time > 0.01`. Plan #1's bolus at t=0 is **kept**. Plan #2's bolus at t=0.01 is added. On Start, both boluses replay.

Two compounding causes: (A) `clearAfter` is exclusive (keeps events at `=fromTime`), and (B) the pre-start clock has advanced past the prior plan's t=0 origin so the prior bolus is below the cutoff anyway. (B) is dominant; (A) would still leak a same-`t` re-plan if (B) weren't already triggering.

**Why the running-case path doesn't have this bug.** During a running case, Set Target opens the TCI delay modal and defers `planTCI` to the confirm callback. Re-tapping Set Target overwrites the deferred pending state in `tciModal` before any events are inserted; only the most recent target's plan ever reaches `planTCI`.

**Fix.** Treat pre-case re-target as a clean restart for the drug. In the pre-case branch of the `'ceTarget'` handler, rewind `preStartClock[selectedDrug]` to 0, wipe all events for the drug via the new public `model.clearFrom(drugId, 0)`, then plan from `t = 0`. First-time target: rewind 0→0 is a no-op; `clearFrom(drugId, 0)` removes nothing (no prior events); plan as before. Re-target: rewind, wipe plan #1, plan #2 from origin. Other drugs' pre-case plans are untouched because `clearFrom` filters by `drugId`. The running-case path (`js/app.js:418–423`) is unchanged.

`eventList.clearFrom` already existed (`js/sim/events/list-ops.js:79–85`). Exposed it on the simulation facade in `js/sim/simulation.js` as a sibling of `clearAfter` — "wipe all events for a drug" is generally useful and reads more clearly than the alternative `clearAfter(drugId, -1)` sentinel.

Versions bumped in lockstep `0.5.33.6 → 0.5.33.7`. Test suite green (no engine/planner changes; the change is in the caller layer).

This is the fix shipped on a fresh branch (`claude/fix-pre-case-tci-restack-RPLT8`) per the v0.5.33.6 CLAUDE.md guidance to open a new PR rather than push to a branch whose prior PR is already merged. PRs #228 and #229 on `claude/fix-duplicate-emergence-timer-FQMMT` have both landed; this fix is independent and gets its own PR.

### Two-mode emergence countdown — stable at SS, smooth on decay (v0.5.33.6) — Interim

User feedback after v0.5.33.5 shipped: the countdown now tracks Ce drift correctly, but at clinical SS the M:SS field oscillates 1 Hz between adjacent seconds (`5:30 ↔ 5:29`). User: *"In order to retain a smooth countdown, would detecting when the pump is stopped and initiating a countdown at that point work?"* The instinct was right — and it points at the underlying semantic asymmetry that v0.5.33.5 papered over.

**Root cause is semantic, not bisection jitter.** The "if you stopped now, when would Ce reach exitCe" answer has fundamentally different semantics depending on whether the pump is actually delivering:

- **Active (current rate > 0)** — the answer is a *counter-factual*. Reality is that you keep infusing, so the prediction must be re-evaluated periodically against current Ce. Frame-ticking `arrivalMin − t` here implies "if I stopped at engagement I'd be N seconds closer now," which isn't what the readout claims to show. At true SS the answer is roughly constant; the display should be **stable**.
- **Idle (current rate == 0)** — the answer is *actually happening*. Ce decays along the model's decay path; the prediction made the moment rate hit zero is mathematically valid for as long as no new intervention happens, and `now − transition_time` is exactly the right thing to subtract from it. The display should **count down smoothly at 1 sec/sec**.

**Mechanism of the v0.5.33.5 SS flicker.** `fmtCountdown(min)` does `Math.round(min * 60)` on whole seconds (`js/ui/drug-panel/formatters.js:21–27`). Per frame the render is `fmtCountdown(arrivalMin − t)`. Between two re-predicts `arrivalMin` is held constant, but `t` advances continuously, so `rem` decreases linearly and crosses `Math.round`'s half-second boundary downward each second. Then the next 1 s wall-clock re-predict resets `arrivalMin ≈ t' + decayDuration`, snapping `rem` back up. Net visual: 1 Hz `↓ ↑ ↓ ↑`. Bisection inside `predictTroughTime` (`js/pk/decay-predictor.js:30–114`, tolerance 0.01 min ≈ 0.6 sec, ±0.3 sec midpoint jitter) adds residual flicker on top.

**Fix: two-mode state machine in `js/ui/drug-panel/exit-readout.js`.** Mode is selected per frame from `ctx.model.getRateAtTime(drugId, t)` (already on the public facade at `js/sim/simulation.js:431–433`).

```js
const currentRate = ctx.model.getRateAtTime(drugId, t);
const isIdle = !(currentRate > 0);
```

Active mode (`currentRate > 0`):
- Re-predict on a 1 s wall clock and on forced invalidation (`exitCe` change, `_curveVersion` bump, mode change).
- Cache `displayedDecayMin` (a delta in minutes from the predict call).
- Apply small symmetric hysteresis (`HYSTERESIS_MIN = 1.5 / 60` = 1.5 sec) so bisection jitter and sub-second wobble don't flip the rounded display. Forced updates skip hysteresis.
- Render directly from `cache.displayedDecayMin` — no `t` subtraction. The DOM string only changes when the cached value changes, so at SS the display is truly stable.

Idle mode (`currentRate == 0`):
- On Active → Idle transition (or first frame ever in Idle, including the user setting Emergence Ce while pump already off), call `predictDecayTo` and store `cache.idleStartT = t` and `cache.idleStartDecayMin = result.time − t`.
- Render every frame as `fmtCountdown(idleStartDecayMin − (t − idleStartT))` — smooth 1 sec/sec countdown driven by the simulator clock.
- Periodic 5 s sanity re-predict; if the fresh decay-from-now differs from the frame-ticked value by ≥ `HYSTERESIS_MIN`, re-baseline `idleStartT` and `idleStartDecayMin`. Otherwise keep ticking. Corrects cumulative drift without visible jumps.

Mode-transition detection via `cache.lastIsIdle`: any change forces a re-predict in the new mode. A bolus push during Idle bumps `_curveVersion`, which forces a re-predict, which writes new `idleStartT` and `idleStartDecayMin` so the smooth countdown re-baselines from the post-bolus Ce and resumes ticking.

**Why this beats blanket hysteresis.** A single-mode 1.5 s symmetric hysteresis on the cached decay value would fix SS flicker too — but at the cost of choppy 2 sec-every-2-sec ticking during real decay. The two-mode design gives each regime its semantically correct rendering: Active is genuinely stable (no per-frame computation that varies), Idle is genuinely smooth (1 sec/sec, mathematically exact).

**No model/simulation/predictor/formatter changes.** `predictDecayTo`, `decay-predictor.js`, `fmtCountdown`, `getCurveVersion`, and `invalidateAll()` are untouched. `getRateAtTime` is already on the public facade.

**CLAUDE.md updated.** PR #228 was merged before the v0.5.33.6 commit, so a `git push -u` to the branch wouldn't update the original PR — it'd orphan the new commit behind a closed PR. Added a workflow note: before pushing follow-up commits to an existing branch, check whether the prior PR is `merged` or `closed` (via `mcp__github__list_pull_requests` or `pull_request_read`), and open a new PR if so.

Versions bumped in lockstep `0.5.33.5 → 0.5.33.6`. Test suite green (no model/simulation changes).

### Re-predict emergence countdown on a 1 s wall clock so it tracks Ce drift (v0.5.33.5) — Interim

User report: "When you set an emergence threshold, the system correctly calculates the time and sets the countdown in the display, but … it assumes that you have stopped the infusion and does not update. The user will expect a live update of how long emergence will take if they stopped all interventions, as they progress through the case and make changes. Currently the readout sets a timer at the point in time that it is engaged and does not update."

The semantics of "Emerge → X.X in M:SS" — *if you stopped now, when would Ce reach the threshold?* — are correct. The bug is the prediction's freshness, not its meaning.

**How it broke.** v0.5.31.8 moved the readout off a 3 s render throttle onto a frame-driven render that reads from a cached `arrivalMin`. The cache invalidates on (a) the user changing the exit Ce, and (b) `_curveVersion` bumping after an event mutation (bolus, rate change, pause). That made the seconds digit tick smoothly each frame, but it inadvertently dropped the property the old throttle was — by accident — providing: re-running `predictDecayTo` on a wall clock so the prediction stays current with the engine's drifting Ce. Between event mutations the displayed time-to-emergence kept ticking down toward an arrival moment frozen at engagement, even while the user kept infusing and Ce kept climbing.

**Why event-only invalidation isn't enough.** During a manual infusion the rate is constant and there are no events for ten, twenty, sixty seconds at a stretch — but Ce is still moving (rising under infusion, falling on washout). `predictDecayTo` with the current engine state and `rate=0` from "now" gives an answer that depends on current Ce. If you don't recompute it, the rendered countdown drifts from reality.

**Fix.** Add a wall-clock invalidator alongside the existing event/threshold ones:

```js
const stale = (now - cache.lastPredictMs) >= PREDICTION_REFRESH_MS;
if (cache.exitCe !== exitCe || cache.computedVersion !== curveVersion || stale) {
  // re-predict ...
  cache.lastPredictMs = now;
}
```

`PREDICTION_REFRESH_MS = 1000`. The render path is unchanged: every frame, if `arrivalMin !== null`, render `prefixHtml + fmtCountdown(arrivalMin - t)`. The seconds field still ticks live; only the underlying `arrivalMin` re-baselines once per second.

**Cost.** `predictDecayTo` is one full event-list replay + a 0.5-min coarse decay scan to a 480-min lookahead + ≤40 bisection iterations — roughly 1–5 ms. With three drugs configured for emergence and 1 Hz refresh, ~3–15 ms per second total. Comfortably under one frame's worth of budget per second.

**Why 1 s.** Drug Ce typically drifts <1 %/s in clinical regimes. A 1 s refresh keeps the displayed M:SS within a single second of the live "if you stopped now" answer, which is well below the perceptible jitter threshold against a once-per-second tick. 500 ms or 2 s would also be defensible; 1 s is the cheap default that feels snappy.

The "arrival elapsed → force re-predict" branch in the render loop already sets `cache.computedVersion = -1` on the next frame; that path keeps working since the regular condition runs first.

Versions bumped in lockstep `0.5.33.4 → 0.5.33.5`. Test suite green (485 tests, no model/simulation changes).

### Fix TCI event flags rendering on the wrong dataset (v0.5.33.4) — Interim

User screenshot of v0.5.33.3 showed the green TCI event flags (rate triangles, bolus arrows, stop octagons) clustered at the bottom of the chart at Y ≈ 0.2–0.5 instead of along the propofol Ce trace at Y ≈ 4. The flags were tracing the trajectory of the fentanyl ghost line.

Root cause: four chart plugins identified the foreground Ce/Cp datasets by string-matching `borderColor.startsWith(COLORS.ce)` / `COLORS.cp` — a pattern that worked when Ce was always `#3b82f6` (blue) and Cp always `#ef4444` (red). The v0.5.33.0 promotion of foreground Ce to per-drug color broke this contract: the foreground Ce dataset now starts with whatever drug color is active (`#facc15` canary for propofol). The plugins' Ce-match falls through and the loop finds the next dataset whose `borderColor` starts with `#3b82f6` — that's the fentanyl ghost trace, since fentanyl's class color is narcotic blue. Markers then plot Y values from fentanyl-ng/mL space (canonical 0.4 mcg/mL × yScale 1000 = 400 ng/mL) interpreted on the propofol µg/mL axis (max ~5), pushing them way off-scale into the bottom of the visible region.

Affected plugins:
- `event-markers.js` — TCI flag markers (the symptom)
- `cursor-dots.js` — the small filled dots at the live-time cursor
- `inspect-dots.js` — the amber inspect-cursor dots
- `readout-panel.js` — the Ce/Cp/eBIS/Rate text panel during inspect mode

Plus a fifth code path inside the disabled tooltip callback that searched by `lbl.startsWith('Ce')` — would have collided with `'Ce ghost (...)'` labels if the tooltip were ever re-enabled.

Fix: introduce a `role` field on each dataset at construction time (`'cp'`, `'ce'`, `'rate'`, `'ghost-reconcile'`, `'ghost-drug'`) and switch every matcher to use it. Color-string matching is brittle the moment colors become per-drug; role tagging is declarative, ghost-safe, and survives any future color tweaks. This is the same lesson we learned with the chart's idempotent setters — once the dataset arrangement gets richer (multi-drug ghosts) you can't keep using shape-of-dataset proxies.

Versions bumped in lockstep `0.5.33.3 → 0.5.33.4`.

### Drop lighten() from ghost color path — preserve drug identity (v0.5.33.3) — Interim

User asked how the ghost traces are currently delineated and noted: "we may be fighting ourselves on color differentiation by reducing their luminance." Correct.

The v0.5.33.0 design stacked four "ghost" cues simultaneously:

1. `order: 4` (drawn behind everything)
2. `borderDash: [2, 4]`
3. `borderWidth: 1.5` (vs foreground 3 px)
4. `borderColor: lighten(DRUG_DEFS[drugId].color, 0.25) + alpha(ghostOpacity)`

Cues 1–3 are color-neutral; they tell the eye "this is supplementary" without touching the drug-color identity. Cue 4 layered TWO desaturating treatments on top: an HSL luminance shift (raise L by 0.25, drop S by 0.125) AND an alpha multiplier (default 0.4). At the default settings, a propofol ghost was reading as ~`#fde892` at 40% alpha — a near-cream wash, not recognizably "canary yellow."

Fix: drop the `lighten()` step. Ghost color is now `def.color + alphaToHex(s.ghostOpacity)` — full saturation hue at user opacity. Default opacity bumped 0.4 → 0.5 since we're no longer also lightening; 0.5 reads as clearly secondary while keeping color identity readable. The `lighten()` helper stays exported from `js/util/color.js` for any future use; it's just unused by the chart now.

Net result: ghosts retain their per-drug color identity (canary propofol, amber ketamine, blue fentanyl) at any opacity setting. Dash + thin + draw-order handle the visual hierarchy; opacity slider is the single fade control.

Versions bumped in lockstep `0.5.33.2 → 0.5.33.3`.

### Re-tune hypnotic-class colors: propofol canary, revert ketamine (v0.5.33.2) — Interim

User feedback after v0.5.33.1: propofol's `#eab308` was reading as a deeper goldenrod on the iPad screen, not the bright primary yellow they wanted. They asked to push propofol into "brighter primary canary yellow" and revert ketamine to where it was before (`#f59e0b` amber).

The v0.5.33.1 fix had shifted ketamine to orange (`#ea580c`) to separate the two yellows by hue. With propofol now bumped up to a much brighter canary (`#facc15`, Tailwind yellow-400), there's enough luminance separation between propofol (bright) and ketamine (deeper amber) that they read as clearly distinct without needing to push ketamine all the way out of the yellow family. Going back to amber for ketamine restores the original "two shades of warm yellow" intent while keeping the chart legible.

Final hypnotic-class colors:
- propofol: `#facc15` (canary yellow, bright)
- ketamine: `#f59e0b` (amber, deeper)

Versions bumped in lockstep `0.5.33.1 → 0.5.33.2`.

### Visual tweaks on the ghost-traces feature (v0.5.33.1) — Interim

User screenshot of v0.5.33.0 running on iPad in landscape flagged three things:

1. **Chart-controls strip overlapped the Chart.js legend.** The reset/info/flag/`∿`/expand buttons sat at `top: 8px` and partially obscured the `Ce (μg/mL) / Cp (μg/mL)` legend rendered by Chart.js at the top of the chart. Bumped to `top: 32px` so the buttons sit just below the legend strip.
2. **Propofol yellow vs ketamine amber were too similar.** `#eab308` (yellow) and `#f59e0b` (amber) both read as "yellow-ish" on the chart — fine for distinct cards but the two ghost lines on the same chart didn't separate cleanly when fentanyl was foregrounded. Shifted ketamine to `#ea580c` (Tailwind orange-600) so we now have yellow vs orange — clearly distinct hues, both still in the warm-induction palette and well away from narcotic blue. The slight visual overlap with the BIS "Deep Sedation" band (`#f97316` at ~19% alpha) is acceptable: the band is a wide horizontal region, the ketamine line is thin and dashed (when ghosted) or thick saturated (when foreground), and `#ea580c` is one step deeper than the band hex.
3. **Ghost lines wanted a touch more color tinge.** Bumped ghost `borderWidth` from 1 → 1.5. Foreground Ce stays 3 px solid; ghost is still clearly secondary by being lightened + dashed + thinner, but now carries enough weight to register as a real line rather than a hairline.

Versions bumped in lockstep `0.5.33.0 → 0.5.33.1`.

### Per-drug color source of truth + ghost Ce traces (v0.5.33.0) — Interim

User asked about adding peripheral-awareness "ghost" traces of non-selected drugs to the chart, and in the same conversation flagged that `DRUG_DEFS[drugId].color` should be the single source of truth — used everywhere the drug panel highlights are sourced from, the chart Ce trace, the compartment viz, the analysis-screen drug buttons. Audit confirmed three drifted truths today: the drug-card highlight came from four hardcoded `#drug-{id}` CSS rules in `index.html` (class colors — yellow for hypnotics, blue for narcotics), the chart Ce was hardcoded `COLORS.ce` blue, and three `.btn-analysis-drug.active[data-drug=…]` rules carried their own hex literals. Compartment viz alone was reading `DRUG_DEFS.color`.

**Color decisions.** The drug-panel highlights are class-coded by medical convention (induction yellow, narcotic blue) and the user wanted that scheme preserved. Promoting `DRUG_DEFS.color` to the source meant rewriting the four hex values to the class scheme — but with distinct shades inside each class so two ghost Ce traces (e.g. propofol + ketamine when fentanyl is foregrounded) don't visually collide:

- propofol — `#eab308` primary yellow
- ketamine — `#f59e0b` amber (within the hypnotic yellow family, distinguishable)
- fentanyl — `#3b82f6` primary blue
- remifentanil — `#06b6d4` cyan (within the narcotic blue family, reserved — no PK model yet)

Foreground Ce now adopts the active drug's color and was bumped from 2 px to 3 px so it dominates the lighter ghost lines below it. Foreground Cp stays red (`COLORS.cp`) — anatomical convention for blood/plasma is intentional and the user confirmed it should hold.

**Ghosts.** Each non-selected drug with events draws a Ce trace at `lighten(DRUG_DEFS[drugId].color, 0.25)` × `ghostOpacity`, 1 px, dashed `[2, 4]`. The luminance shift is HSL-based (raise L by 0.25, drop S by 0.125), implemented in a new `js/util/color.js` (~30 LoC: `lighten`, `hexToRgba`, `alphaToHex`). Each ghost runs against its own hidden secondary Y-axis (`yGhost_<drugId>`) so the line height matches that drug's foreground calibration — X-axis pan/zoom is shared with the foreground, Y is per-drug. The bridge resolves each ghost's Y max from `localStorage 'chart-ymax-' + drugId` ‖ `CHART_DRUG_CONFIG[drugId].yDefault` (same fallback the foreground uses).

**Toggle placement.** On/off lives on the chart-controls strip (`∿` button between `⚑` events and `⤢` expand) per user instruction — not in the Settings modal. The opacity slider does live in Settings → Appearance, mirroring the existing Cp/nomogram/overlay sliders. Both are persisted under the existing `tci-warn-settings` blob (`ghostTracesEnabled`, `ghostOpacity`).

**Self-heal invariant.** Chart-bridge `onFrame()` calls `setDrugColor`, `setGhostOpacity`, and `setGhostEnabled` every frame — all idempotent inside the chart. This matches the existing pattern for `setCpOpacity`/`setNomogramOpacity` and is the CLAUDE.md invariant that lets New Case (which rebuilds the chart from scratch) self-heal: the fresh chart's defaults differ from the user's persisted settings, so the first post-recreate frame applies them. `switchDrug` also re-tints the foreground Ce and re-evaluates per-dataset ghost visibility so the new selected drug's ghost is hidden (its data is the foreground) and the others reappear.

**Boot wiring.** `applyDrugColorVars()` runs once at boot, iterating `DRUG_IDS` and calling `el.style.setProperty('--drug-color', DRUG_DEFS[drugId].color)` on each `#drug-<drugId>` card and `.btn-analysis-drug[data-drug="<drugId>"]` button. The matching `--drug-color-muted` (rgba 25% alpha) is computed via the new `hexToRgba` helper. The drug-card highlight CSS in `index.html` already read `var(--drug-color)` — the change was upstream, deleting the four hardcoded rules and feeding the variable from JS.

Versions bumped in lockstep `0.5.32.4 → 0.5.33.0`. Added `js/util/color.js` to the service-worker precache list so it loads offline.

### BOLUS mode for pump-disabled fentanyl/ketamine (v0.5.32.4) — Interim

User asked about the mode taxonomy and pointed out a real UX inconsistency: in propofol MANUAL mode the Set Rate + Add Bolus buttons highlight to show the active operating actions, but in fentanyl/ketamine "intermittent bolus" mode the buttons "are always dimmed."

Investigation: in the pump-disabled non-TCI branch of `updateModeUI()`, `active-mode` was only applied to btn-target + btn-bolus when `hasThreshold` was true (i.e. when the user had explicitly set a redose threshold). Without a threshold, mode label was `NO MODE` and all bottom-bar buttons dim. But for these drugs there's no infusion possible when the pump is off — bolus IS the operating mode by default. Calling that "NO MODE" with passive-looking buttons was misleading.

Verified with puppeteer (selecting fentanyl, calling `mode.setIntermittentThreshold('fentanyl', 1.5)`, then `refreshUI`) that the active-mode CSS applies correctly in both themes when the rule is reached — the bug was the gating condition, not the styling.

Fix: split the pump-disabled branch into two states with Add Bolus *always* highlighted, since bolus is always the primary action when the pump is disabled:

- `BOLUS` — default state, no redose threshold. `manual-mode` label class (purple, matching the bolus-button color). Add Bolus highlighted.
- `INTERMITTENT` — redose threshold set. `target-mode` label class (amber). Change Threshold + Add Bolus highlighted.

Setting a threshold becomes additive — it promotes the label and lights up the threshold button, but the bolus highlight is unchanged across both states. Net result: drug cards no longer go visually inert just because the user hasn't set a threshold.

TCI-capable drugs (propofol, remifentanil) and pump-enabled non-TCI drugs are deliberately unchanged. Their `NO MODE` label still makes sense because both Set Target and Set Rate are real, available alternatives that the user might pick — there's no single primary action to highlight by default.

Versions bumped in lockstep `0.5.32.3 → 0.5.32.4`.

### Keypad input lag on iOS — global touch-action fix (v0.5.32.3) — Interim

User report: typing the patient's age, pressing "3" then "5" too fast occasionally lands just "3" — the second tap is dropped. They flagged it as possibly systemic.

Cause is the iOS Safari "fast-tap" issue. Even with `<meta name="viewport" content="width=device-width, initial-scale=1.0, user-scalable=no">` set in `index.html`, iOS still holds tap events for ~300 ms on plain `<button>` elements when neither `touch-action` nor a few other heuristics tell it that double-tap-zoom is unwanted. A fast follow-up tap that lands inside that holding window can be dropped entirely. The patient-modal keypad (`.pm-key`) and the main numeric keypad (`.key`) had `-webkit-tap-highlight-color:transparent` and `cursor:pointer` but neither had `touch-action: manipulation`, so the holding window was active.

Fix is two-tiered:

1. **Global default**: `button, [role="button"] { touch-action: manipulation; -webkit-tap-highlight-color: transparent }` near the top of the stylesheet, so every existing and future button in the app gets the snappy behavior by default. `manipulation` is the right keyword — it allows panning and pinch-zoom but disables double-tap-zoom, which is exactly what we want on a clinical app where pinch-zoom on the chart is intentional but you never want the simulator to interpret a fast keypad sequence as a zoom gesture.
2. **Explicit on the keypad classes**: kept the explicit `touch-action:manipulation` on `.pm-key` and `.key` because they're the most rapid-tap-prone surfaces and explicitness here documents intent for future readers.

No JS changes — the `addEventListener('click', ...)` handlers in `js/ui/patient-modal.js`, `js/ui/keypad.js`, and `js/ui/event-editor.js` are correct; the bug was at the platform layer. Considered switching to `pointerdown`/`touchend` but that has its own pitfalls (firing on accidental drags, harder to support keyboard-driven taps for accessibility) and the CSS fix is sufficient.

Versions bumped in lockstep `0.5.32.2 → 0.5.32.3`.

### eBIS readout — restored on phones, theme-aware color (v0.5.32.2) — Interim

User report after v0.5.32.1: "Bis display is gone. It is gone." Screenshot showed the propofol drug card on an iPhone-portrait viewport with the header row containing only "PROPOFOL" — the eBIS readout that's supposed to be right-justified next to the drug name was absent.

Two separate problems, both surfaced by the themable-colors PR but not all caused by it:

**1. The eBIS readout was hard-hidden on phones.** A CSS rule added back in v0.5.24.16 set `.drug-card .drug-bis-header{display:none}` inside two media queries — phone-landscape (`max-width:900px and max-height:420px`) and phone-portrait (`max-width:500px and orientation:portrait`) — and also flipped `.drug-card .drug-header-row` from flex to `display:block`. Net effect: on every phone form factor, the propofol BIS readout was just gone. Verified with a puppeteer test against the running localhost — at viewport 430×932 portrait, `getComputedStyle(document.getElementById('propofol-bis-header')).display === 'none'` and the matched rules were both phone media query overrides.

The display:block override was probably to allow long drug names to wrap. But the only drug names we have (Propofol, Fentanyl, Ketamine) are short enough to share the row. Removed both `display:none` rules and the matching `display:block` rule on header-row. Header-row reverts to its default flex layout (justify-content: space-between, align-items: baseline), so the drug name sits left and the eBIS sits right. Empty bis-headers still collapse via the existing `:empty{display:none}` rule, so non-propofol drug cards (which never get BIS) are visually identical to before. Re-ran the puppeteer test with mock content injected — at iPhone width, the BIS readout renders at `x=372 (right-edge), w=48px` next to the drug name at `x=16, w=71px`, both `align-items: baseline`. Confirmed visually with a screenshot.

**2. The eBIS color was invisible in light theme.** `bisColor()` in `js/ui/drug-panel/formatters.js` returned hard-coded hex literals tuned for a dark backdrop — `#ef4444` red, `#f97316` orange, `#eab308` yellow, `#22c55e` green, `#a855f7` purple. The yellow at BIS 40-60 (typical anesthetic depth — what the user would see during most cases) is unreadable text on white. The light-purple (#a855f7) and light-green (#22c55e) read OK but feel garish on white. Promoted all five depth-band colors to per-theme CSS variables (`--bis-mild`, `--bis-moderate`, `--bis-deep`, `--bis-deeper`, `--bis-very-deep`). Dark theme keeps the original brights (no visual change). Light theme uses darker variants — `#a16207` (deep amber) for the BIS 40-60 GA range, `#dc2626` red, `#c2410c` orange, `#16a34a` green, `#7c3aed` purple. `bisColor()` returns `var(--bis-…)` strings, which work fine when assigned to `element.style.color`.

The `> 90` muted band was already `var(--text-muted)` — already adapted, no change needed.

Same lesson as the BIS-band-alpha fix in v0.5.32.1: any color hard-coded for a dark backdrop is a latent landmine when adding light theme. The themable-colors PR has now exposed and fixed three of these (chart axes/grid, BIS-band fills, BIS readout text); the rest of the codebase passed the audit (drug brand colors, dataset colors are intentionally non-themed for clinical recognizability).

Versions bumped in lockstep `0.5.32.1 → 0.5.32.2`.

### BIS nomogram bands invisible in light theme (v0.5.32.1) — Interim

User report after the v0.5.32.0 themable-colors ship: "Bis display is gone. Doesn't show up at all."

The BIS nomogram bands (Light Sedation / Deep Sedation / GA / Deep Anesthesia colored regions on the chart) were hard-coded at `30` hex alpha = ~19% in `chart-bridge.js computeEffectOverlay()`. That value was originally tuned for a near-black backdrop where 19% colored fills are still readily visible. On the new white background, 19% red/orange/yellow/green fills are essentially imperceptible — and the band labels (positioned inside the bands) disappear with them, so it does look like the entire BIS display is missing.

Fix: promote the alpha to a per-theme CSS variable. `--bis-band-alpha: 30` for dark (unchanged), `55` (≈33%) for light. `computeEffectOverlay()` reads it via `getComputedStyle(document.documentElement).getPropertyValue('--bis-band-alpha')` and appends it to the band base hex (`'#ef4444' + a`). Fallback `|| '30'` keeps the old alpha if the variable isn't defined (e.g., a stale service-worker `index.html` with new chart-bridge).

Wired the existing `tci:theme-change` listener in chart-bridge.js to also call `computeEffectOverlay()` after `chart.applyTheme()`, so toggling themes mid-session re-renders the bands with the new alpha. The chart-side `applyTheme()` was already rebuilding annotations from current `s.effectBands`, but those bands had the OLD alpha baked in — recomputing here regenerates them with the new alpha pulled from the theme-aware CSS variable.

Versions bumped in lockstep `0.5.32.0 → 0.5.32.1`.

### Themable color schemes — dark + light (v0.5.32.0) — Interim

User asked for a themable app with at least a "light" color scheme alongside the existing dark default.

The HTML/CSS side was already 90% there: every UI surface in `index.html` consumes CSS custom properties (`--bg-deep`, `--text-primary`, `--blue`, etc.) defined once in a single `:root { … }` block. What was missing was (a) a user-facing toggle, (b) a second theme defined as variable overrides, and (c) Chart.js participation — the chart axes/grid/legend/tooltip and the custom annotation overlays were hard-coded hex literals (`'#9ca3af'`, `'#1e293b'`, `'#ffffff'`, `'#f59e0b'`, etc.) that would have looked broken on a light background.

**Pattern:** `<html data-theme="light">` + a sibling `:root[data-theme="light"]` CSS block that overrides every variable. One attribute swap re-themes the entire document; cascades through modals/portals; no specificity surprises. Default load (`data-theme="dark"`) keeps the current values, so this is a zero-regression change for existing users.

**Settings integration** mirrors the existing `textSize` pattern exactly: added `theme: 'dark'` to `DEFAULTS` in `js/ui/settings.js`, a `THEMES = ['dark', 'light']` validator list, getter/setter pass-through, and a Theme segmented control in the Appearance pane styled with the existing `.seg-group` / `.seg-btn` classes (no new CSS for the toggle itself). `js/app/settings-ui.js` exports `applyTheme()` that sets `document.documentElement.dataset.theme`, swaps `<meta name="theme-color">`, and dispatches a `tci:theme-change` CustomEvent.

**Chart conversion** introduced six new chart-specific CSS variables (`--chart-axis-title`, `--chart-tick`, `--chart-grid`, `--chart-legend`, `--chart-tooltip-bg`, `--chart-label-fg`) so we don't conflate UI text colors with chart axis colors. A small `readThemeVars()` helper at the top of `js/ui/chart/index.js` samples them via `getComputedStyle(document.documentElement)`. Chart construction reads the helper once for the initial config; a new public `chart.applyTheme()` re-reads the helper and updates `options.scales.{x,y}.{title,ticks,grid}.color`, `legend.labels.color`, `tooltip.backgroundColor`, then rebuilds annotations + calls `chart.update('none')`.

`js/ui/chart/annotations.js` got a parallel `readAnnotationColors()` helper that reads `--amber`, `--green`, `--red`, and `--chart-label-fg`. The trailing-alpha hex concatenation pattern (`'#f59e0b' + s.overlayAlpha` → `c.amber + s.overlayAlpha`) keeps working as long as both theme blocks use 6-char hex values, which they do. The most important fix was the BIS band label color at line 117 — previously hard-coded `'#ffffff'`, now `c.labelFg` — without this, plateau pill labels would be invisible white-on-white in light theme.

`js/app/chart-bridge.js` adds a single `document.addEventListener('tci:theme-change', …)` listener that calls `chart.applyTheme()` on the live chart instance. The bridge is constructed once in `app.js`, so this is a single listener for the lifetime of the app; chart recreation on New Case is handled because `getChart()` always returns the current instance.

**Intentionally not themed:** drug brand colors (propofol blue, fentanyl orange, ketamine purple, remifentanil amber) and chart dataset colors (Cp red, Ce blue, BIS green, rate purple, target orange) live in `js/util/constants.js DRUG_DEFS` + `COLORS`. These are clinical identity tokens — propofol is "the blue drug" regardless of background — and changing them across themes would defeat color-recognition. Chart curves render the same hue against either background; if any specific clinical color reads poorly in light mode, the fix is to tune the corresponding semantic CSS variable (e.g. `--amber: #d97706` instead of `#f59e0b` for better contrast on white), not to recolor the dataset itself.

Versions bumped in lockstep `0.5.31.9 → 0.5.32.0`.

### Stop Pump clears future events during replay (v0.5.31.9) — Interim

User reported: when replaying a case (current time scrubbed into the past with future events queued ahead), Stop Pump didn't clear those events. The sim ended up in a contradictory state — UI showed the pump stopped, but the pump silently resumed at the next queued rate-restore or bolus.

Two bugs in `onPumpPause` (`js/app.js:321-342`):

1. The `clearAfter(drugId, t)` call was inside an `if (mode === 'tci')` block. The original comment ("Stop drops out of current mode and clears future events") matched the right intent, but the implementation only honored it for TCI-mode cases. Manual mode with queued events left them in place. After `addPause` inserts a rate=0 event at `t`, the very next future event resumes infusion, exactly the contradictory state the user described.

2. The early-return guard `if (conc.rate === 0 && mode !== 'tci') return` blocked the entire handler when the current replay time landed in a momentary rate=0 gap (e.g., between two infusion segments in the saved case). The user had no way to cancel queued resumptions because the button silently no-op'd.

Fix is two surgical edits: lift `clearAfter` out of the TCI conditional so it always runs after the pause is inserted, and refine the guard to allow the handler when there are future events queued (`getEvents(drugId).some(e => e.time > t + 0.0001)`). Cached `mode.get(selectedDrug)` once in a local `m` while in there. The "genuinely idle, no-op the button" case now reads as `rate === 0 && m !== 'tci' && !hasFuture` — pump idle, not in TCI, and nothing queued ahead. Anything else proceeds: insert pause, clear all future events, drop mode to 'none' (if not already), refresh chart.

Versions bumped in lockstep `0.5.31.8 → 0.5.31.9`.

### Live emergence countdown via cached arrivalMin (v0.5.31.8) — Interim

Follow-up to v0.5.31.7. After fixing the duplicate timer, the remaining `exit-readout.js` was still on a 3 s `predictDecayTo` throttle — necessary in the original design because it baked the formatted countdown string into a cached HTML blob, and the only way to refresh the displayed seconds was to re-predict. The cost of re-predicting is real (per call: a coarse 0.5 min × 480 min lookahead scan = up to ~960 4×4 matrix-exp `engine.advance` calls, plus 40 bisection iterations, plus two full event-list replays). Without throttling we'd be doing 60–600 ms/sec of matrix-exp work per drug at native rAF. With it, ~1 ms/sec. The throttle was load-bearing.

But it was also the reason the post-fix countdown still ticked once every 3 s instead of live. The right pattern was already in `approach.js`: cache the absolute `arrivalMin`, render `fmtCountdown(arrivalMin - t)` per frame from the cache, only re-predict on actual state changes.

Refactored `exit-readout.js` to mirror that pattern. Per-drug cache holds `{exitCe, computedVersion, arrivalMin, prefixHtml}`. The invalidation triggers are: user-set `exitCe` changes, or the model curve version bumps (any event mutation). Each frame: read exitCe, check the two invalidation signals, re-predict if needed, then render `prefixHtml + fmtCountdown(arrivalMin - t)`. The `Ce ≤ exitCe` "Emergence Reached" branch stays as an early-return — no caching needed because the input flips it back the moment Ce drops through the threshold.

Plumbing for the model-mutation signal: exposed `getCurveVersion()` from `approach.js` (the existing `_curveVersion` counter that gets incremented in `setCurveData`, called from `app.js` after every `refreshChart()`). Exit-readout reads it directly. Also exported `invalidateAll()` from exit-readout so `forceUpdate()` in `drug-panel/index.js` can invalidate both caches in lockstep on explicit "model mutated" signals.

Edge case: arrival elapses while Ce is still above threshold (model mismatch / coarse-step rounding). Mirroring approach.js, set `cache.computedVersion = -1` on the next render to force a re-predict. In normal operation this branch is unreachable because Ce drops through exitCe right around arrivalMin, flipping the early-return to "Emergence Reached".

Net cost change: was ~0.33 calls/s/drug → now ~0 calls/s/drug under steady state (recomputes only on event mutations and threshold changes). Net UX change: countdown ticks once per second instead of once every three. Versions bumped in lockstep `0.5.31.7 → 0.5.31.8`.

### Fix duplicate emergence timer when pump stopped (v0.5.31.7) — Interim

User reported: when the pump is stopped on a drug card that has a configured emergence Ce threshold, two emergence countdowns appear simultaneously — `Exit 2.0 in 7:51` above the status row (live updating) and `Emerge → 2.0 in 7:54` below it (slower update cadence). Same prediction, two display paths, drifting times.

Root cause was a leftover block in `js/ui/drug-panel/approach.js` (lines 119-135) that pre-dated the 0.5.24.3 "Emerge → / Emergence" naming refactor. The block rendered an emergence countdown into `#<drug>-approach` whenever the pump was stopped (`m === 'none'` or `rate === 0 && m !== 'tci'`) with no redose threshold set, using the user's configured exit Ce when present and labelling it `Exit`. Meanwhile `js/ui/drug-panel/exit-readout.js` — explicitly built for the same purpose, with the canonical `Emerge →` label, the green `Emergence Reached` state, and a 3 s `predictDecayTo` throttle — was rendering into `#<drug>-exit` unconditionally. No mutual exclusion existed.

Fix is surgical: in the approach block, early-return `noData` when the user has configured an exit Ce. Exit-readout.js owns that readout exclusively. The fallback path (no user-set emergence) still triggers the default `EMERGENCE_CE` (1.5 mcg/mL) hint in the approach slot — it was the only path that reached the body once the user-set case was carved out — so the dead `Exit` vs `Emergence` label branch collapsed to a hardcoded `Emergence`.

Net effect: stopped-with-emergence-set shows one timer (`Emerge → X.X in M:SS` in the exit-readout slot, with `Emergence Reached` once Ce ≤ exitCe). Stopped-without-emergence-set still shows the default `Emergence 1.5 in M:SS` hint in the approach slot. Versions bumped in lockstep `0.5.31.6 → 0.5.31.7`.

### Click the version tag to check for updates (v0.5.31.6) — Interim

User asked for a manual update check, triggered by clicking the version number. The natural target — the version tag is already where the user looks when they want to know what they're running, and we now have a status line directly under it that's the perfect place to surface check results.

UI. `.setup-brand .version-tag` gets `cursor: pointer`, a hover state that lifts the color from `text-secondary` to `text-primary` plus a subtle blue text-shadow (so it's clearly interactive without being loud), and a 70 %-opacity active flash. The element gains `title`, `role="button"`, and `tabindex="0"` for accessibility — keyboard users can tab to it and press Enter/Space.

Logic. New `manualCheck()` in `js/app/sw-register.js`. Reuses the existing `checkServerVersion()` machinery — the only change there was making it return a boolean (`true` = update detected) and absorbing fetch errors with a `try/catch` around the `fetch()` call so manual checks can react to the offline case (returns false → fall back to the offline steady-state status, which already says "Offline. Cached version last updated …"). Manual check semantics:
1. Bail if a check is already in flight (single-flight `manualCheckInFlight` flag).
2. Bail if no registration yet, or not on the setup screen.
3. Paint `Checking for updates…` immediately (cyan pulsing dot — same `updating` class).
4. Await `checkServerVersion()`.
5. If it returned true, the function already painted "Update available (vX)…" and triggered `registration.update()`; the SW lifecycle takes over from there. If false, paint the steady-state status (which is the just-updated message, "No new version available…", or "Offline. …" depending on state).

Wiring. `attachVersionTagHandler()` is called once from `init()` after the early `refreshConnectivityStatus()` call. Listens for `click` and `keydown` (Enter / Space, with `preventDefault()` so Space doesn't scroll). The handler doesn't await `manualCheck()` because we don't care about the resolution at the call site — the status updates communicate the outcome.

Versions bumped in lockstep `0.5.31.5 → 0.5.31.6`.

### Make "New update installed" message sticky for the session (v0.5.31.5) — Interim

User flagged: after an update boot, the status reverted to "No new version available." after 6 s. They want "✓ New update installed." to remain.

Root cause was the `showJustUpdatedToastIfPending()` helper from v0.5.31.1, which painted the post-update message and then `setTimeout(refreshConnectivityStatus, 6000)`'d back to the connectivity steady state. That made sense as a transient toast, but the user is treating "just updated" as a first-class status — they want to know when they sit down at a tablet whether the version they're looking at was just installed.

Fix: capture the just-updated state once at boot and let `refreshConnectivityStatus()` branch on it forever. New `consumeJustUpdatedFlag()` reads + clears the `tcisim:justUpdated` sessionStorage flag and returns a boolean; that boolean is stored in a module-level `justUpdated` const. `refreshConnectivityStatus()` now checks `justUpdated` first — when true it paints `✓ New update installed. Last update <ts>.` regardless of online/offline; otherwise it falls through to the existing connectivity branch.

Lifetime is exactly one boot. The sessionStorage flag is cleared on first read, so a subsequent reload (without an accompanying update) starts a fresh session where `justUpdated` is false and the message reverts to "No new version available. Last update <ts>." This is the right scope: the user knows there's a new version on this session because they're seeing the badge, and they don't need to be reminded forever.

Online/offline still flips between the two non-update messages but doesn't touch the just-updated branch — which is fine because going offline post-update doesn't suddenly invalidate "we just installed an update" as the most relevant fact to surface. Versions bumped in lockstep `0.5.31.4 → 0.5.31.5`.

### Status line shows install timestamp + prose phrasing (v0.5.31.4) — Interim

User asked for the status notice under the version to spell out when the cached version was installed: "New Update Installed" right after an update, "No new version available. Last update <date time>." while online on cached, and "Offline. Cached version last updated <date time>." while offline.

Tracking the install time. Two new `localStorage` keys: `tcisim:installedVersion` (the `APP_VERSION` string) and `tcisim:installedAt` (ISO datetime). On boot, `stampInstallTimeIfNeeded()` reads them; if `stored !== APP_VERSION` (or no stored entry exists), it stamps both with the current time. That trips exactly when an update has just been applied — because the SW reload hands control to a page whose `APP_VERSION` is the new version while `localStorage` still has the old one. So the timestamp tracks "when the currently-running cached version was first installed locally", which is what the user's wording asks for.

Status messages rewritten as full sentences with `Date.toLocaleString(undefined, {month:'short', ...})` → "May 1, 2026, 2:23 PM". Steady states are split by connectivity:
- online: `No new version available. Last update <ts>.`
- offline: `Offline. Cached version last updated <ts>.`

Transient states (around the SW update flow) keep their one-line phrasing but get sentence case + a period for consistency: `Update available (vX)…`, `Updating to latest…`, `↻ Update queued · applies at next case start.`, `✓ New update installed.`

Layout. The brand panel is 220 px wide with a 16 px side padding so the usable text width is ~190 px. At 10 px DM Mono the longest sentence ("No new version available. Last update May 1, 2026, 02:23 PM.") spans roughly two lines. CSS changes: `font-size: 9 → 10 px`, `align-items: center → flex-start` so the dot anchors to the first line (with `margin-top: 4 px` to vertically center against a single text row), and the label moved into its own `<span class="text">` with `flex: 1; min-width: 0; word-break: break-word` so the sentence wraps inside the column instead of overflowing.

Versions bumped in lockstep `0.5.31.3 → 0.5.31.4`.

### Lock SW updates to the setup screen (v0.5.31.3) — Interim

User flagged the obvious safety issue with the freshly-added auto-update flow: a service worker reload mid-case would yank the running app's modules out from under an in-progress simulation. Fix: hard-gate every update-triggering path on `isOnSetupScreen()` so the version is locked in once the user clicks Start.

Three paths to gate, all in `js/app/sw-register.js`:

1. **The 60 s version poll.** `checkServerVersion()` early-returns if not on setup, so we never even fetch `js/version.js` while a case is running. (We still poll on the interval and on `visibilitychange`, but they no-op until the user is back on setup.)
2. **The `SKIP_WAITING` post in `updatefound` → `installed`.** A new worker that finished installing while the user is mid-case stays parked in `waiting` indefinitely; we don't hand it the baton.
3. **The `controllerchange` → `location.reload()` chain.** This handles the rare case where `SKIP_WAITING` was already in flight when the user clicked Start. If `controllerchange` fires off-setup, we set a `pendingReload` flag instead of reloading.

When the user navigates back to the setup screen (driven by a new `tcisim:screenchange` custom event dispatched from `app.js#showScreen`), the screenchange listener does, in priority order:
- If `pendingReload` is set → `triggerReload()` (sessionStorage flag + `location.reload()`).
- Else if `registration.waiting` exists → activate it via `SKIP_WAITING` (covers both our queued updates and any update the browser found via its own background check during the case).
- Else → fire a fresh `checkServerVersion()`.

Status badge gets a new state: `↻ update queued · applies at next case start` (cyan, pulsing dot). User sees this if they happen to be on the setup screen when an update arrives but choose not to use the app for a moment, or — more typically — when they finish a case and return to setup with an update already queued.

App-side touchpoint is one line in `js/app.js#showScreen`:

```js
document.dispatchEvent(new CustomEvent('tcisim:screenchange', { detail: { id } }));
```

This is the only coupling between `app.js` and `sw-register.js` — any future screen will get gated automatically as long as it's not `'setup-screen'`. The analysis screen, for instance, is also off-setup, which is correct: even though the user isn't actively running a sim there, they might be reviewing a case, and we shouldn't yank state.

Versions bumped in lockstep `0.5.31.2 → 0.5.31.3`.

### Make the version tag readable (v0.5.31.2) — Interim

User asked for the version number to be larger and not dimmed. The `.setup-brand .version-tag` rule was 9 px / `text-muted` / `opacity: .6` — chosen originally as a "footnote" treatment but barely legible at arm's length on a tablet. Bumped to 13 px / `text-secondary` and dropped the opacity damping. Same monospace face and letter-spacing so it still reads as a build label, just legibly. Versions bumped in lockstep `0.5.31.1 → 0.5.31.2`.

### SW status badge under the version tag + first-install reload fix (v0.5.31.1) — Interim

User asked for a notice under the version number that says whether the app loaded from cache, whether it's online, whether a new version was just installed, etc. Wired into the existing `js/app/sw-register.js` rather than a new module — it already knows about the SW lifecycle and is the only place that observes connectivity-relevant events.

UI. New `#app-status-tag` div directly under `#app-version-tag` inside `.setup-brand`. The whole brand panel only shows on the setup screen; once the user picks a patient and starts a sim, neither the version nor the status are visible — that's fine, the status answers a "how did the app load just now / is the network there" question that's most relevant pre-case. Style: 9 px DM Mono, colored dot + label, four state classes (`online` green, `offline` amber, `updating` cyan with a pulsing dot, `updated` blue). `.status-tag:empty{display:none}` so the panel doesn't reserve space before the first status write.

Status text. Two axes: connectivity (live, re-evaluated via `online` / `offline` events) and load source (set once at boot). Load source comes from `performance.getEntriesByType('navigation')[0].transferSize` — `0` means the document body never crossed the wire, so it was served by the SW cache (or HTTP cache); `> 0` means a network fetch. Combined into `online · cached`, `online · live`, `offline · cached`, `offline · live`. Two transient states wrap the SW update: `updating to latest…` while a new worker is installing, and `✓ updated to v0.5.31.1` for 6 s after the post-update reload.

Bug found while wiring this up. The original `controllerchange` handler reloaded the page unconditionally. That's wrong on the very first visit: the SW activates, calls `clients.claim()`, that fires `controllerchange`, and a brand-new visitor would silently reload once for no reason. Fixed with an `updateTriggered` flag set only inside the `updatefound → installed` branch where we post `SKIP_WAITING`. First-install claim now just refreshes the status badge (we're newly controlled, so the next load will be `cached`).

Update toast. Driven by a `sessionStorage` flag (`tcisim:justUpdated = '1'`) set immediately before `location.reload()` and read on the very next boot. After display the flag is cleared and the badge reverts to the connectivity status. SessionStorage was the right scope — it survives the reload but doesn't leak across tabs or across days.

Older-browser fallback. When `'serviceWorker' in navigator` is false, the module still wires up `online`/`offline` listeners on `DOMContentLoaded` so the status badge is populated. Load source is hard-coded to `live` in that branch since there's no SW to serve from.

Versions bumped in lockstep: `js/version.js` and `sw.js`'s `VERSION` constant `0.5.31 → 0.5.31.1` (per the CLAUDE.md "Adding a feature" workflow note added in 0.5.31).

### Offline support via service worker + version-aware reload (v0.5.31) — Interim

User asked for the app to run offline from cache and for the service worker to compare its version against the server and force a reload when the server is newer. The app had no SW at all (`grep -r serviceWorker js index.html` returned zero hits), but is otherwise an ideal PWA candidate — pure static, no build step, single entry HTML, ES modules.

Approach. New `sw.js` at the repo root (scope `/`). Cache-first fetch handler with a version-keyed cache (`tcisim-v<APP_VERSION>`). On install it precaches `index.html`, `manifest.json`, every JS module under `js/` (~65 files, full list inlined), the four jsdelivr CDN scripts (Chart.js + annotation + zoom + hammer), and the Google Fonts CSS. Per-URL fetch with a try/catch in a `Promise.all` instead of `cache.addAll` — `addAll` is atomic, so one bad URL would abort the entire install and offline support would silently never come up. Activate handler deletes any cache whose name doesn't match `CACHE_NAME` and calls `clients.claim()` so the new SW takes over without a second reload.

Two things make the version check robust. First, `sw.js` itself embeds a `VERSION` string that's kept in lockstep with `js/version.js`. When that string changes, the file's bytes change, the browser's normal SW update check on navigation/`registration.update()` fires, the new worker installs, and we tell it to skipWaiting → activate → fire `controllerchange` → `location.reload()`. Second — and this is the part that actually matters for a tab the user has open all day — the new `js/app/sw-register.js` polls `js/version.js` every 60 s and on `visibilitychange→visible`, with `cache: 'no-store'` so it goes through the SW's network-first branch for `js/version.js` and reaches the actual server when online. If the parsed `VERSION` constant differs from the running `APP_VERSION`, we call `registration.update()` to drag the SW lifecycle along and the same reload chain runs. The `VERSION_RE = /VERSION\s*=\s*['"]([^'"]+)['"]/` regex matches `js/version.js`'s single-line `export const VERSION = '...'` shape directly.

Fetch handler. Network-first for `js/version.js` (the version-poll branch must always see fresh server bytes when online); cache-first for everything else, with opportunistic caching on miss — important because the cached Google Fonts CSS triggers `fonts.gstatic.com` woff2 fetches at runtime, and we want those to fall into the cache the first time they're seen so the *next* offline session has fonts. Navigation fetch failures fall back to cached `index.html` so a deep-link refresh while offline still boots the app.

Wiring. `js/app.js` gets one new line: `import './app/sw-register.js';` alongside the existing `js/app/*` imports. The registration module guards on `'serviceWorker' in navigator`, so older browsers that don't support SWs no-op cleanly. No changes to `index.html` (the inline diagnostic block at the bottom is unaffected) or `manifest.json` (icons stay as-is — they're referenced but missing on disk; intentionally not in the precache list to avoid the per-URL fetch cluttering DevTools with 404s).

Lockstep ritual. CLAUDE.md "Adding a feature" workflow now mentions that bumping `js/version.js` requires a matching bump in `sw.js`'s `VERSION` constant. If the two drift, the worst case is the version-check poll fires `registration.update()` on every poll and finds nothing to do (because `sw.js` bytes haven't changed) — the page would stay on the old version. So the lockstep is the linchpin.

### Compartment-flow viz: modal → retrospective Analysis screen (v0.5.30.1) — Interim

The first cut of the compartment visualization (v0.5.30) was a modal overlay opened from a topbar button. User flagged that the modal blocked the chart underneath, which defeated the whole point — they couldn't move the chart's inspect cursor while the visualization was open, so the "scrub the chart, watch the compartments scrub with it" interaction was unreachable. We considered a few fixes (non-modal floating panel with click-through, side drawer, swap-with-history-tab); user chose: just give it its own retrospective Analysis page with the chart on the left and the visualization on the right.

Approach. New `#analysis-screen` (a peer of `#setup-screen` and `#sim-screen`). Topbar with "← Back to Sim", title, and time readout — no bottom controls, since this is read-only retrospective analysis. The content area is a two-pane flex layout: chart-host on the left, viz-host on the right (landscape ≥900 px) or stacked (chart on top, viz below) on narrow / portrait viewports.

Chart canvas is **teleported** rather than duplicated. On `enterAnalysisScreen`, `document.querySelector('.chart-area')` is appended to `#analysis-chart-host`; `chartAreaHomeParent` caches the original parent so `exitAnalysisScreen` puts it back. After each move we call `chart.chart.resize()` inside a `requestAnimationFrame` to let the new container's bounding box settle. Chart.js doesn't care about the canvas's parent — it holds a direct canvas reference and re-measures via the parent on resize, so all chart state survives the move: the inspect cursor, zoom, datasets, plugins, gesture handlers attached to the parent. This was the cheapest possible reuse.

Compartment-viz module. Replaced `open()` / `close()` (which toggled `.modal-overlay.open`) with a single `setActive(bool)` method; `onFrame` early-returns when `!isActive`. The SVG (`#cv-svg`), title (`#cv-drug-title`), and time readout (`#cv-time-label`) DOM moved out of the modal block into the analysis-screen markup, but kept the same IDs so the module's element lookups didn't change.

Sim timer keeps running in the background while you're on the analysis screen — the cursor's "Live t" keeps ticking. The inspect cursor (when set) scrubs independently of that. This was a deliberate choice: pausing on enter would lose state if the user just wanted to peek; the user agreed.

Removed: `#modal-compartment-viz` block from `index.html`, the `COMPARTMENT VIZ` CSS group, the modal open/close button handlers in `app.js`. Renamed `#btn-compartments` (modal opener) to `#btn-analyze` (screen navigator). Net diff of v0.5.30.1 over v0.5.30: ~80 lines added (the analysis screen markup + CSS), ~30 lines removed (modal scaffolding), and the viz module shrunk slightly.

### Compartment-flow visualization (v0.5.30) — Interim

User asked for a self-contained module that visualizes the underlying PK compartments with concentrations and directional drug flow, with one explicit constraint: it must be **as separate as possible from the rest of the sim** so it can be ripped out without complicating anything else. Goal is intuition-building for trainees — see V1 fill from a bolus, watch V2/V3 rise as drug redistributes, see flow reverse as the gradient flips.

Approach. A single new file `js/ui/compartment-viz.js` exports `initCompartmentViz({ getModel, getSelectedDrug, getInspectTime })` and returns `{ open, close, onFrame, destroy }`. It owns its own SVG inside a modal overlay (`#modal-compartment-viz`), built once on init from a static layout of four boxes (Effect site / V1 / V2 / V3) + an Eliminated sink, with five flow arrows (`Pump→V1`, `V1→elim`, `V1↔V2`, `V1↔V3`, `V1→Ce`). Each frame the module reads `Cp/Ce/C2/C3/rate` from the public `model.getConcentrationsAt(drug, t)` API and computes flows from the macro-rate constants:

| Arrow | Formula |
|---|---|
| Pump → V1 | `rate` (mg/min) |
| V1 → elim | `CL · Cp` |
| V1 ↔ V2 | `Q2 · (Cp − C2)` |
| V1 ↔ V3 | `Q3 · (Cp − C3)` |
| V1 → Ce | `ke0 · (Cp − Ce)` (indicator only — Ce is virtual) |

Per-drug PK params come straight from the publicly-exported PK calc functions (`calcEleveldParams`, `calcFentanylParams`, `calcKetamineParams`) so `simulation.js` is untouched. Params are cached and only recomputed when the active drug or the patient demographics change.

Arrow rendering. Each arrow is an SVG `<line>` with a marker-end arrowhead and a midpoint `<text>` flow label. For bidirectional arrows (V1↔V2, V1↔V3, V1↔Ce) the `(x1,y1)` and `(x2,y2)` swap when the signed flow goes negative, so the arrow physically reverses. Stroke-width is `clamp(0.4, 8, log10(1+norm·9)·4 + 0.6)` against a per-drug scale derived from CL; opacity is `clamp(0.18, 1, 0.25 + norm·0.85)`. Elimination uses muted gray; the V1↔Ce arrow is dashed since no mass actually moves.

Inspect-cursor link. The user explicitly asked for the viz to scrub along with the chart's inspect cursor. The module's `getInspectTime` callback returns `chart.inspectTime` (a new one-line getter on `js/ui/chart/index.js` — sole touchpoint outside the new file/`app.js`/`index.html`). When the cursor is active, the viz reads compartment state at the cursor time; otherwise it uses live elapsed time. The header line displays `Live t = …` or `Scrubbed t = …` accordingly.

Wire-up. Four edits to `js/app.js`: import line, module-scope `compartmentViz` declaration, init call in `boot()` after `chartBridge` is created, and chaining into the existing `drugPanel.init({ onFrame })` callback so the viz piggy-backs on the master rAF loop without owning one of its own. Two button handlers (`btn-compartments` open / `btn-compartment-close` close) round it out. Closed-state cost: a single boolean check.

Ripout path. Delete `js/ui/compartment-viz.js`; revert the four edits in `js/app.js`; remove the `#btn-compartments` topbar button, the `#modal-compartment-viz` block, and the `/* ==== COMPARTMENT VIZ (self-contained) ==== */` CSS group from `index.html`. The `chart.inspectTime` getter on `js/ui/chart/index.js` can stay (harmless) or be reverted. No PK files, no event/sim files, no settings keys, no localStorage.

### Smart decimal formatting for Ce set points (v0.5.29.5) — Interim

User-set Ce values — TCI target, redose threshold, emergence Ce — were displayed with `toFixed(1)` in the drug-card approach line, the chart's right-edge pill labels, and the exit-readout. A clinician who deliberately typed `1.55` for an emergence threshold saw it presented back as `1.6`, which silently rounds away the precision they entered.

Fix: show two decimals when the hundredths digit is non-zero, and one decimal otherwise. So `3.0` stays `3.0`, `3.05` displays as `3.05`, and `3.097` rounds to `3.10` then strips the trailing zero to `3.1`. Live Ce/Cp readouts (`fmtCeHTML`) already display two decimals always and are unchanged. Computed values like the steady-state pill stay at fixed `toFixed(2)` since those aren't user-set.

**Implementation.** Single helper plus a unit-aware variant in `js/ui/drug-panel/formatters.js`:

```js
export function smartDecimal(value, fallbackDp = 1) {
  if (!isFinite(value)) return String(value);
  const t2 = value.toFixed(2);
  return t2.endsWith('0') ? value.toFixed(fallbackDp) : t2;
}

export function fmtCeSmart(ceMcgMl, drugId) {
  const allowed = getAllowedUnits(drugId, 'ceTarget');
  const v = (allowed && allowed[0] === 'ng/mL') ? ceMcgMl * 1000 : ceMcgMl;
  return smartDecimal(v);
}
```

Call sites:
- `approach.js` — `fmtCe(ceTarget, drugId, 1)` → `fmtCeSmart(ceTarget, drugId)` for "Below Redose Threshold X" and the redose countdown; raw `ceTarget.toFixed(1)` / `emergenceCe.toFixed(1)` → `smartDecimal(...)` for Target and Emergence labels.
- `drug-panel/index.js` — step-bar redose label uses `fmtCeSmart`.
- `exit-readout.js` — `parseFloat(lbl.split(' ')[0]).toFixed(1)` → `smartDecimal(parseFloat(...))`.
- `chart/plugins/target-label.js` — target / threshold / exit pill labels use `smartDecimal`. Steady-state pill stays at `toFixed(2)`.

`fmtCe` itself is left as-is so `fmtCeHTML` and other paths that want fixed-precision Ce keep working.

---

### Per-target rounding override in Set Target modal (v0.5.29.3)

The setup screen has a "Round TCI plan in display units" checkbox (persisted under `tci-pref-quantizeInDisplay`) that snaps every TCI plan call to the user's selected display-unit grid. Once a case is started, the setup screen is no longer reachable, so a clinician who wanted a more exact (or more rounded) plan mid-case had no way to flip it.

Solution: mirror the same checkbox inside the Set Target keypad modal, with **one-shot semantics** chosen by the user — toggling in the modal affects only the plan being confirmed; nothing is persisted; the modal re-opens at the global config value every time. This keeps the global config the single source of truth while giving in-the-moment override capability.

**Implementation.** Five touch-points, all small:

1. `index.html` — added `#keypad-round-row` + `#keypad-round-in-display` inside `#modal-keypad`, hidden by default. Small inline CSS (`.keypad-round-row`) so the row sits centered above `.modal-actions` with muted text.

2. `js/ui/keypad.js` — module-scope `currentRoundOverride` (boolean when the row is exposed, null otherwise). `show(type)` reveals the row only for `'ceTarget'` and seeds the checkbox + `currentRoundOverride` from `localStorage['tci-pref-quantizeInDisplay']`. A `change` listener on the checkbox keeps `currentRoundOverride` in sync. `confirm()` packs `{ roundOverride }` into a new `extras` argument passed as the 5th param of `onConfirm`/oneShotConfirm. Non-ceTarget types always pass `null`.

3. `js/util/units.js` — `getQuantizeConfig(drugId, enabledOverride)` now accepts an explicit boolean second arg. Omitting it preserves the previous localStorage read; passing a boolean bypasses storage and uses that value to gate the per-drug display-unit lookup. Backwards-compatible.

4. `js/app.js` — the keypad `onConfirm` signature gains `extras`. The `'ceTarget'` branch reads `extras?.roundOverride` and builds `quantConfig` via `getQuantizeConfig(drug, override)`; that config is passed straight to `planTCI` (pre-case) or stashed on `tciModal.setPending({ ..., quantConfig })` (running-case).

5. `js/app/tci-modal.js` — `commit()` destructures `quantConfig` off `pendingTCI` and uses it; falls back to `getQuantizeConfig(drugId)` for safety if a future caller omits the field.

**Out of scope.** `js/ui/event-editor.js:557` (event-editor-driven replan) still uses the global setting only — the user's request was specifically the Set Target flow.

---

### Reconcile modal honors active TCI plans (v0.5.29.0)

Closing the loop on the reconcile feature: the modal previously bypassed the TCI-conflict rule engine entirely, silently mutating history while letting future TCI events fire on schedule. Result: Ce overshoots or undershoots the target the plan was designed to hit.

The Phase 1 trace of the codebase clarified two things:

- **History add and edit already do the right thing.** Both routes go through `applyWithRules()` in `js/ui/event-editor.js:507-553`, which has a four-branch rule engine (silent / past-edit-during-TCI / pre-case / future-TCI-edit). The user's question "should we mirror this for editing?" was already satisfied by current code; only reconcile was missing the parallel.
- **Auto-replan is the wrong move.** Replanning generates immediate bolus prompts and rate-change actions — kicking off a clinical sequence right after the user finished a maintenance task is the failure mode they explicitly flagged. The conservative move (clear future plan, drop to manual, let the user re-engage on their own beat) is consistent with the existing add/edit pathway.

**Implementation.** Two pieces:

1. `event-editor.js`: exported `showTciWarning(text, onConfirm)` so other modules can route through the same `#modal-tci-warn` dialog. Refactored the three internal callers in `applyWithRules` to pass their action as the second arg instead of stashing it in module-scoped `_pendingRuleAction` first. Added `_pendingRuleAction = null` on cancel so a stale lambda from one caller can't fire when a different caller (e.g., reconcile) reopens the dialog later.

2. `reconcile-modal.js`: `_confirm()` now scans `getEvents(drug)` for `source === 'tci' && time >= now`. If any exist, routes through `showTciWarning` with copy taken verbatim from `applyWithRules`'s third branch ("This will cancel TCI control and clear all future events from this point forward."). The onConfirm lambda calls `model.clearAfter(drug, now)`, then `setMode(drug, 'manual', 'Dropped to manual — dose reconciled')`, then `_doReconcile(now)`. With no future TCI events, mutation runs directly. Mutation logic extracted into `_doReconcile(now)` so both branches share it; `now` is captured up-front so a slow user clicking through the warning doesn't shift the case-clock baseline.

**Why no shared helper.** The reconcile case is a single condition (any future TCI event?), versus event-editor's four branches. Inlining is cleaner than extracting a generic rule engine; if a third mutation path needs the same logic later, refactor at that point. Reusing `showTciWarning` (UI) without extracting `applyWithRules` (logic) gives consistency where it matters and keeps the call site readable.

**Cached-target preservation deferred.** Phase 1 also surfaced that `mode.set(drug, 'manual', ...)` clears `ceTargets[drug]` (`mode.js:61`), so after the rule fires the user has to retype the target on Set Target. A `lastCeTargets` cache that survives mode changes would make re-engagement one tap. Punted for a separate small UX change — not blocking the conflict-handling fix.

**Files changed:** `js/version.js`, `js/ui/event-editor.js` (export + cancel-clears + caller refactor), `js/ui/reconcile-modal.js` (TCI-conflict check, _doReconcile extraction, imports), `CHANGELOG.md`, `DEVELOPMENT.md`. No engine change.

### Interim — Consistent blue active-input border (v0.5.28.5)

User asked for the reconcile entry field to match the patient-screen blue active style, then asked to audit the rest of the app for the same treatment.

The patient modal already uses `.pm-field.active{border-color:var(--blue);box-shadow:inset 0 0 0 1px var(--blue)}` to mark which cell is currently being typed into. The audit turned up two other standalone numeric displays:

1. `.keypad-display` — the main keypad modal (target/rate/bolus/emergence/redose) and the event-editor modal both use this. Each modal has only one input, so it's always the active field when the modal is open. Applied the blue treatment unconditionally.
2. `.rm-value-input` — reconcile modal's actual-total field. Same single-input situation, same fix.

The other `<input>` elements in the page audit are hidden inputs backing the patient `.pm-field` cells, checkboxes, native time pickers, and range sliders — none need the active-text-input border.

**Files changed:** `js/version.js`, `index.html` (two CSS rules), `CHANGELOG.md`, `DEVELOPMENT.md`. No engine change.

### Interim — Reconcile modal: tone down (v0.5.28.4)

User feedback on v0.5.28.3: too much copy ("laying it on a bit thick") and too fancy on the entry field ("just make it look like every other input box in the app"). Both fair — the previous round was leaning marketing.

Changes:
- Entry field: dropped the amber border, glow, blinking caret, color-flip on the unit label, and the `rm-actual-input-active` wrapper class. Now uses `bg-deep` background + subtle border + mono font, matching the existing `.keypad-display` pattern.
- Info popup: shortened all five sections. "What this is for" went from two paragraphs to one declarative sentence. Removed the "teaching tool" disclaimer paragraph (was clutter, not load-bearing). "Why it works", "The two modes", "Reconciling band", "Ghost line" all tightened to facts only.
- Modal subtitle and "actual total" helper line shortened for the same reason.

No engine change.

### Interim — Reconcile modal polish: highlight, volume mode, scenario language (v0.5.28.3)

Same session. Three small fixes piling up after the user previewed v0.5.28.2 on a real-looking case in the screenshot:

1. **Entry-field highlight.** The "Actual total delivered" cell looked like a passive readout — same flat border as the "Simulated total" row above it. Made it visually obvious that this is where the user types: amber border, soft amber glow (`box-shadow: 0 0 6px rgba(245,158,11,.35)`), amber text color, and a blinking caret pseudo-element when the buffer is empty (`::after { animation: rm-caret-blink 1s steps(2) infinite }`). The unit label flips to amber too. Width bumped from 70 → 90 px and padding from 4 → 6 px so the field feels like a real input, not a number stamp.

2. **Dose / Volume toggle.** Pumps display infused volume (mL); making the user mental-math `750 mL/hr × 10 mg/mL × duration → mg` is friction. New segmented control above the input: `[Dose] [Volume]`. Visible only when the selected drug has a pump enabled (`isPumpEnabled` && `concentration > 0`). Switching modes converts the buffer through canonical mg so the displayed number stays equivalent (`247 mg → 24.7 mL` with 10 mg/mL propofol). The "Simulated total" line updates to the same unit so the comparison stays apples-to-apples. The drug-picker change handler falls back to dose mode if the newly selected drug doesn't have a pump.

   Implementation: added `_inputMode: 'dose' | 'volume'` state, plus `_displayUnit()`, `_mgToDisplay()`, `_displayToMg()`, `_fmtDisplay()` helpers that read from `getPumpSettings(drugId).concentration` (canonical mg/mL across all drugs — propofol 10, fentanyl 0.05, ketamine 0.05). All canonical-mass math (`_computeDelta`, the confirm path's `_deltaMg`) is unchanged — only the display layer is parameterized.

3. **Scenario-language rewording.** The original info-popup copy and modal subtitle read like real clinical use ("during a busy case", "the pump actually delivered"). Reframed throughout: "if you've stepped away from a long simulation… the dose the scenario actually called for", "the simulated pump", "the rate the scenario calls for". Added an explicit disclaimer paragraph: "This is a teaching tool — it is not part of the dosing record for a real patient." The single-bolus example changed from "stopcock push during airway management" (sounds operative) to "a manual bolus the scenario called for that you didn't enter, or one you forgot you'd already entered" (sounds trainee-track).

**Files changed:** `js/version.js`, `js/ui/reconcile-modal.js` (input-mode state, helpers, drug-picker fallback, render integration), `index.html` (toggle markup, highlighted-input CSS + caret animation, info-popup rewording), `CHANGELOG.md`, `DEVELOPMENT.md`. No engine change.

### Interim — Reconcile default flipped to single-bolus (v0.5.28.2)

Same session. After v0.5.28.1 added the forward-rebuild caveat to spread mode, the user pushed back on the default choice itself: "A missed dose is an easier fix than a systemic pump error and one that requires less explanation and troubleshooting." That argument holds up under scrutiny:

- The clinically common failure is a missed sharp event — a stopcock push during airway management, a manual bolus that wasn't logged. Sustained rate drift requires either repeated logging failures (the user bumped the pump rate three times and forgot to update the sim each time) or a hardware-level calibration mismatch (rare).
- Single-bolus is mentally simpler: "I forgot to push that — add it where I think it happened." Spread requires the user to reason about whether the underlying mismatch is still active (it usually is), and to follow up with a Change Rate to keep the drift from rebuilding.
- Single-bolus is fully self-contained. Spread has the forward-rebuild gotcha that v0.5.28.1 just had to add a paragraph to explain.

So flipped the default back to single-bolus and reordered the segmented control accordingly (single first, spread second). Updated the info popup so single-bolus is the first paragraph and labelled "(default)". Spread retains its full explanation including the forward-rebuild caveat — kept in the toolbox for the user who recognizes a sustained rate mismatch.

The earlier v0.5.28.0 reasoning ("sustained errors are the dominant failure mode, so default to the strategy that fixes them exactly") was wrong on the empirical claim — it was extrapolating from the math being clean rather than from how cases actually go off the rails. Spread is still mathematically the better tool for sustained errors; it just isn't the common case.

**Files changed:** `js/version.js`, `js/ui/reconcile-modal.js` (one-line `_mode` default), `index.html` (button order, default-active class, time-picker default-visible, info-popup paragraph order/copy), `CHANGELOG.md`, `DEVELOPMENT.md`. No engine change.

### Interim — Reconcile spread-mode forward-rebuild disclosure (v0.5.28.1)

Same session as v0.5.28.0. The user, after seeing the result on a real case (3:30:15 ET, 150 mcg/kg/min infusion, ghost line clearly diverging from the new Ce above NOW), pointed out that the spread reconciliation only fixes the past. The restore event at t=NOW puts the rate back to the un-augmented baseline, so forward of NOW the sim runs at whatever set rate the user had configured before. If the underlying mismatch is still active (e.g., the pump has been running 1 mg/min faster than the sim's set rate, and is still doing so), the drift will rebuild at the same per-minute rate.

Two options considered:
1. **Documentation only**: surface the caveat in the modal summary and the info popup, with guidance to use Change Rate after confirming.
2. **Behavior change**: add an "extend correction forward" checkbox that omits the restore event, so the augmented rate continues indefinitely.

Going with #1 for v0.5.28.1. The honest answer is "the sim doesn't know whether the underlying mismatch is still happening" — only the user does. Surfacing the caveat puts the responsibility for forward correction in the right place. Option #2 is straightforward to add later if real-world feedback shows it's worth the extra UI complexity. The expected workflow becomes: reconcile (spread) → notice the new Ce trajectory → adjust the set rate to match what the pump is actually doing.

**Files changed:** `js/version.js`, `js/ui/reconcile-modal.js` (summary text), `index.html` (info popup paragraph), `CHANGELOG.md`, `DEVELOPMENT.md`. No engine change.

### Interim — Reconcile v3: spread-across-case mode + info popup (v0.5.28.0)

Same session as v0.5.27.x. The user, after experimenting with the single-bolus reconciliation, observed empirically that "the Ce curve is relatively resilient as long as the total dose is correct." That prompted a closer look at the math, which surfaced two corrections to my earlier claims and one new design opportunity:

1. **Earlier claim "T_insert = 0 is mathematically optimal for forward accuracy"** was true for sharp events at induction, false for sustained errors. For a sustained rate mismatch, no single-bolus T_insert reconstructs truth at NOW exactly; the optimum is somewhere in the middle of the case (centroid of the missed-dose distribution, shifted later by ke0 lag). Tabled the actual numbers for a 180-min case at 4 vs 5 mg/min with a +180 mg correction:

   ```
   T_insert    Ce error at NOW
   0 min       -16.79 %
   60 min      -15.95 %
   90 min      -14.68 %
   120 min     -10.54 %
   150 min      +7.22 %  ← single-bolus sweet spot
   180 min     -18.31 %
   ```

   None of these are exact. So the single-bolus approach is fundamentally an approximation for sustained errors.

2. **Spreading the correction across the case is exact** for sustained errors. A `+1 mg/min` rate offset over `[0, 180]` adds exactly `+180 mg` to the cumulative dose AND replicates the truth's instantaneous-input waveform. Engine confirms 0.000 % Cp/Ce error at every horizon:

   ```
   Inserted events: { restore: { t: 180, rate: 4, src: 'reconcile' } }
   t=30  truth Ce=1.4640  sim Ce=1.4640  ΔCe=0.000%
   t=60  truth Ce=1.7372  sim Ce=1.7372  ΔCe=0.000%
   t=180 truth Ce=2.0571  sim Ce=2.0571  ΔCe=0.000%
   ```

3. **Sharp events handled by spread** are ~10 % Ce off at NOW (smearing a 100 mg bolus across 3 hours produces a ramp instead of an impulse) but converge to <1 % within 2 hours — acceptable degradation when the user picks the wrong mode. Sharp events handled by single-bolus at the actual event time → exact reconstruction; at any earlier time → ≤1.5 % Ce off (the earlier-bolus case has had more time to redistribute and looks like it was always there).

So the right tool depends on what the user thinks happened. v0.5.28 ships the mode toggle plus an info popup that explains the trade-off and surfaces concrete "worth correcting?" thresholds derived from the simulation runs.

**Spread-mode primitive: `applyRateAugmentation(drugId, t0, t1, deltaPerMin)`** on the simulation facade. Captures active rate at the endpoints before any mutation, then walks every rate event strictly inside the interval and bumps each by `deltaPerMin` via `editEvent`. Inserts an augmented start at `t0` (or bumps an existing one) and a baseline-restore at `t1`. Pause events are skipped — augmenting during a real pump pause would deliver drug while the pump was off. Tiny inaccuracy in cases with pauses is accepted; revisit in v2 if it matters.

**Why spread is the new default.** Sustained errors (rate changes that lasted) are the dominant failure mode. Single missed boluses are usually noticed at the moment ("did I push that?") or remembered. So the strategy that reconstructs sustained errors *exactly* and degrades gracefully on sharp ones beats the strategy that's mediocre on the common case and exact only on the uncommon one. Two clicks to switch to single-bolus mode if the user does remember a specific event.

**Info popup contents.** New `#modal-reconcile-info` overlay with five sections: what this is for, why it works (LTI + ke0 lag), the two modes, when it's worth correcting (with the threshold tables — sustained errors are 1:1 dose %→Ce %, bolus errors fade fast), and what the band/ghost line mean. Triggered by an `ⓘ` button in the reconcile-modal header. Wider modal-box (`max-width: 560px`) with scrollable body for small viewports.

**Ghost-line legend filter.** The purple dashed line is only present during a reconciliation. A persistent legend entry "Ce (pre-reconcile)" was reading as confusing clutter when it was unused, so added a `legend.labels.filter` that drops any dataset whose label contains "pre-reconcile". The line itself still draws when present.

**Files changed:** `js/version.js`, `js/sim/simulation.js` (`applyRateAugmentation`), `js/ui/reconcile-modal.js` (mode state + segmented control + branched confirm + info-popup wiring), `js/ui/chart/index.js` (legend filter), `index.html` (mode UI, info-popup markup + CSS), `CHANGELOG.md`.

### Interim — Dose reconciliation v2: case-start default + ghost Ce curve (v0.5.27.1)

After 0.5.27.0 shipped, the user pushed back with a sharper version of the math question: "aside from perturbing historical curves, is there any benefit to placing the bolus at a particular time as opposed to just dumping it at time 0?" The honest answer was no — the forward error after a correction at `T_insert` is `e^{A·(t − T_insert)} · B_vec`, so for any `t > now`, smaller `(t − T_insert)` strictly means bigger forward residual. The original "place at now" default is the *worst* choice for forward accuracy and the *best* for past fidelity. Concrete table for propofol with case duration 60 min: `T_insert = 0` leaves only ~6.7 % intermediate-mode residual at `now`, while `T_insert = now` leaves the full 100 %. Switched the default.

User then asked for a troubleshooting affordance: copy the current Ce up to `now` to a ghost line so the corrected vs. pre-correction curves can be visually compared. Implementation snapshots `model.computeCurve(drug, 0, now, 10/60)` immediately before the addBolus call inside `_confirm()` of `js/ui/reconcile-modal.js`, then stores the result in a per-drug `reconciliationGhosts` map on the simulation model that mirrors the existing `reconciliationWindows` map. Lifecycle is tied: `getActiveReconciliationWindow` auto-clears the matching ghost when `now > endMin`, and `clearReconciliationWindows()` / `setReconciliationWindow(_, null, null)` both delete the ghost too.

The chart got a new dataset (purple `#a78bfa`, dashed) appended after Cp/Ce/Rate. Setter `setGhostCurve(points)` is idempotent against a signature string (`length|firstTime|lastTime|lastCe`), since the bridge calls it every frame. The bridge in `chart-bridge.js onFrame` reads `model.getActiveReconciliationGhost(selectedDrug, t)`, applies the same `yScale` it applies to the live Ce dataset, and pushes — `null` when no window is active or no drug match. Drug switches naturally clear the ghost because the new drug's ghost slot is whatever it is (usually empty), so `setGhostCurve(null)` fires.

Persistence: `getAllReconciliationGhosts()` and the matching restore branch in `session.js`. Each ghost is a few hundred `{time, Ce}` points; for a 60-min case at 10-sec sampling that's 360 points × ~30 bytes JSON ≈ 11 KB per drug. Three drugs = 33 KB. Well under any localStorage limit.

Helper text in the modal updated to "defaults to case start (most accurate forward curve). Drag forward to a guess of when the drift happened if you'd rather preserve historical fidelity." So the user understands the trade-off they're choosing among.

**Files changed:** `js/version.js`, `js/util/constants.js` (added `COLORS.ghost`), `js/sim/simulation.js`, `js/ui/chart/{state,index}.js`, `js/app/chart-bridge.js`, `js/ui/reconcile-modal.js`, `js/app/session.js`, `index.html`, `CHANGELOG.md`.

### Interim — Dose reconciliation feature (v0.5.27.0)

*Branch: `claude/propofol-convergence-analysis-RKIV8`.*

User flagged a very common clinical workflow problem: during a busy case the anesthetist loses track of pump rate changes or manual boluses, the simulation's running total drifts from reality, and without a reconciliation path the user has to start over. Discussion with the user surfaced three design decisions (captured in the plan file): (1) entry point = history panel bottom bar next to Edit / + Add Event, (2) per-patient convergence window computed from the PK eigenvalues rather than a fixed 30 min, (3) allow negative corrections (sim says 500 mg, pump says 450 mg — treat mathematically as a −50 mg bolus). Then the user corrected my initial framing of the comparison: "We are comparing the total dose given during the case as calculated by the sim and as displayed by the infusion pump (plus any non pump boluses)" — i.e. total case dose vs. pump display, not a windowed gap, because the user generally doesn't know when the drift started. Followed that with another correction: insert the bolus at a user-specified past time rather than `now`, to shrink the visible forward transient when the user has a reasonable guess of when the missed change occurred. Finally: insert-time picker needs ET and RT support.

**Math sketch.** The PK model is a 3-compartment mammillary system with effect site; the state-transition matrix A is 3×3 (excluding the one-way Ce link from V1). At reconciliation time the simulated vs. actual mass differs by `delta = actual − simulated`. Inserting a single bolus of `delta` at time `T_insert` makes both event histories deliver the same cumulative mass, so for any `t > T_insert` the two state vectors satisfy `x_reconciled(t) − x_truth(t) = e^{A (t − T_insert)} · (x_reconciled(T_insert⁺) − x_truth(T_insert⁺))`. Since all three eigenvalues of A are real-negative, the error decays as a sum of three exponentials. The fast mode is ~1–3 min, the intermediate mode is ~15–40 min for propofol (tens of minutes for the others), and the slow mode is hours — so the dominant residual a clinician cares about decays at the intermediate rate. After 3 × t½_intermediate the intermediate-mode error is ~12.5 %, small enough that the forward curve is clinically usable. Placing the bolus in the past redistributes the spike before `now`, so the forward transient is smaller by whatever factor the intermediate mode has already decayed; the math converges either way. Eigenvalues are computed via the cubic characteristic polynomial of A (same closed-form route SimTIVA uses; per-minute conversion in our `js/pk/eigenvalues.js`). For a 70 kg, 40 y/o male the computed intermediate half-lives are 15.5 min (propofol), 17.2 min (fentanyl), and 4.6 min (ketamine) — windows 46.5 / 51.7 / 15 min, with ketamine hitting the 15-min floor clamp.

**Ship list:**

- `js/pk/eigenvalues.js` — builds the 3×3 A matrix from the per-drug PK param calculators (`calcEleveldParams`, `calcFentanylParams`, `calcKetamineParams`), solves the cubic, returns `getIntermediateHalfLife(drugId, patient)` and `getConvergenceWindow(drugId, patient)` (the latter = 3 × t½, clamped to [15, 120] min). Pure function — no side effects.
- `js/sim/events/query.js` now exports `getCumulativeDose(events, drugId, now)` as a standalone pure helper. The same logic used to live inline in `js/ui/history.js` as `computeTotalsForDrug`; extracted verbatim so the totals row and the reconcile modal share a single source of truth. `history.js` still exposes its thin wrapper so the public history API is unchanged.
- `js/sim/simulation.js` gained `setReconciliationWindow(drugId, insertMin, endMin)`, `getActiveReconciliationWindow(drugId, now)` (auto-clears when `now > endMin`), `getAllReconciliationWindows()` for session serialisation, and `clearReconciliationWindows()`. The map is in-memory per drug, keyed by drugId, cleared on `reset()`.
- Chart: `s.reconciliationRegion` (nullable `{ xMin, xMax }`) in `js/ui/chart/state.js`; full-height amber-hashed box annotation with `overlayAlpha`-modulated fill in `js/ui/chart/annotations.js`; idempotent `setReconciliationRegion({ xMin, xMax } | null)` exported from `js/ui/chart/index.js` — matches the `setPlateauRegion` pattern and the CLAUDE.md idempotence invariant. `chart-bridge.js onFrame` reads the window from simulation state every frame and calls the setter unconditionally (self-healing on chart recreation).
- Drug card `.reconciling` CSS pulse on the left inset — amber-glowing edge that toggles on/off based on `model.getActiveReconciliationWindow`. Two keyframes: `drug-card-reconcile-pulse` for inactive cards, `drug-card-reconcile-pulse-active` for the currently-selected one (composes with the drug-color frame so we don't lose the selection indicator).
- `js/ui/reconcile-modal.js` — the interactive controller. Drug picker appears when 2+ drugs are active; auto-picks when one. Simulated total uses `fmtTotalMass` (exported from `history.js`). Delta is live-computed from the input buffer, color-coded (violet for positive, amber for negative), sign-aware. Time picker reuses the event-editor's two-select pattern with ET/RT toggle; `_setTimeUnit` round-trips the buffer through case-start-anchored conversion (CLAUDE.md keypad-round-trip invariant). Keypad is inline, modelled on the patient-modal. Summary line describes what will happen: sign, magnitude, insert time (with "N ago" or "at current sim time"), window end, and a caution note for negative deltas. Confirm is disabled for empty input, NaN, or zero delta; on success it calls `model.addBolus(drug, T_insert, delta_mg, 'Dose reconciliation ±Nmg', { deliveryMode: 'push', source: 'manual' })` followed by `setReconciliationWindow(drug, T_insert, T_insert + window)`, then `refreshChart()` and an annotation for the history/audit trail.
- `js/app/session.js` persists `reconciliationWindows` as a drugId-keyed map alongside `pumpEnabled` in case save/restore.
- `index.html` — new `#modal-reconcile` markup after the event-editor; `Reconcile` button in the history panel bottom bar; `.rm-*` styles for the modal layout; `.reconciling` pulse keyframes.

**Negative corrections.** Engine handles negative `mg` natively — the minimum-delivery-duration clamp in `events/delivery.js` means the value `-50 mg` becomes e.g. a `-1000 mg/min` infusion for 3 seconds (AUC = −50 mg, correct). The V1 amount transiently dips below zero but redistributes; the long-term state converges to the reduced-dose reality. Test `rate-based negative correction: +50 mg infused then -50 mg retracted` in `tests/test-reconcile.js` verifies Cp returns to ≤5 % of peak after 120 min of coast. No UI filter for negative values was needed — `history.js` / `fmtBolusDose` already format with sign via `formatValue`.

**Tests:** `tests/test-reconcile.js` (8 tests) — `getCumulativeDose` math (bolus-only sum, rate integration, partial rate, empty events), negative-bolus physics (+50 then −50 converges to zero, rate-based net-zero input decays), intermediate-half-life clamp/sanity. 485 → 493 tests, all passing.

**Why the correction bolus rather than reducing past rates (for negative deltas).** Considered: if the delta is negative (user over-counted in sim), distribute the correction across past rate events by scaling them proportionally. Rejected for v1: more code complexity, and the user's request was explicitly "allow negative bolus". The chart does show a brief retrospective dip at `T_insert` in the negative case, but the amber-hashed region makes clear that the curve inside the window is reconciling. If this turns out to be visually alarming in practice, v2 can redistribute negatives across existing infusion events.

**Files added:** `js/ui/reconcile-modal.js`, `js/pk/eigenvalues.js`, `tests/test-reconcile.js`.

**Files changed:** `js/version.js`, `js/sim/events/query.js`, `js/ui/history.js`, `js/sim/simulation.js`, `js/ui/chart/{state,annotations,index}.js`, `js/app/chart-bridge.js`, `js/ui/drug-panel/index.js`, `js/app/session.js`, `js/app.js`, `index.html`, `CHANGELOG.md`.

### Interim — Fix text-size scaling on iPad-class viewports (v0.5.26.2)

User reported on a full-size iPad Pro that "Large" text was rendering smaller than "Normal". Confirmed by inspecting the CSS media-query stack: the `body.text-lg` / `body.text-xl` rules were scoped to `@media(min-width:601px) and (min-height:421px)` and calibrated for phone-class viewports. On ≥1020 and ≥1200 px, the Normal baseline inside those media queries bumped several properties above the text-lg values — while text-lg still won by specificity, its absolute values were frozen at phone scale, so Large looked smaller than Normal. Worst case: `.drug-card.active .ce-current` = 30 px on Large, 35 px on Normal at ≥1200 px.

Fix adds full `body.text-lg` / `body.text-xl` override sets inside the ≥1020 and ≥1200 media blocks to restore Normal < Large < XL < XXL at every viewport. Also bumped xxl values at ≥1020 where xl had surpassed xxl (`.ce-current`, `.ce-current.active`, `.elapsed-timer`, `.step-bar-countdown`) after the text-xl bumps in the same block.

Structural note: the long-term cleaner fix would be CSS custom properties — e.g. `--scale-text: 1` on `:root`, bumped by each body class, with every font-size rule using `calc(Npx * var(--scale-text))`. That refactor is deferred; the per-viewport override approach is verbose but matches the existing pattern and has no risk of regressing other sizes.

### Interim — Total-delivered readout in history panel (v0.5.26 → .1)

*Branch: `claude/add-drug-amount-display-rWPVg`.*

User asked for a way to see total amount given per drug, in the drug's dose unit and in mL. Options considered were a footer line on the drug card or a totals row at the bottom of the history panel; the history panel won because it's already the "what happened" surface and has room without crowding the drug card.

**v0.5.26.1 correction.** Initial implementation routed the mass total through `getPreferredBolusUnit` so it honoured whatever unit the user had chosen for the bolus keypad (mg / mcg / mcg/kg / mL). User feedback: a cumulative-dose readout should be unconditional — absolute mass in the drug's native unit (mg for propofol/ketamine, mcg for fentanyl), with mL always shown. Replaced the pref lookup with a hardcoded `TOTAL_MASS_UNIT` map; dropped the `isPumpEnabled` gate on the mL column because `DRUG_DEFS[drug].concentration` is known even when a pump isn't configured. Push of 50 mcg fentanyl in intermittent-bolus mode now reads `50 mcg · 1.00 mL` instead of hiding the mL.

**Shipped:**

- New `<div class="history-totals" id="history-totals">` between `.history-area` and `.history-actions` in `index.html`. CSS defines a bordered top strip with an uppercase `Total delivered` label on the left and the value(s) on the right — monospace, muted label colour, full-strength value colour. text-lg / text-xl / text-xxl scalings added to match the rest of the history panel.
- `computeTotalsForDrug(drugId, now)` in `js/ui/history.js` walks the drug's event list once, integrating rate segments between events and crediting bolus doses. Background rate is suppressed during bolus delivery (mirrors `js/sim/events/replay.js` — `advanceBolus` replaces the background infusion for its computed duration). A bolus that's still being delivered at `now` contributes a time-proportional fraction of its dose, so the readout doesn't step discontinuously when a push bolus crosses the current cursor.
- Unit formatting goes through the existing `fromCanonical` / `formatValue` helpers so the total displays in whatever bolus unit the user preferred for that drug (mg / mcg / mcg/kg / mL). If pump is enabled and the preferred unit isn't already `mL`, an mL figure is appended using `getPumpSettings(drug).concentration`.
- Hidden (`el.hidden = true`) when `totalMg <= 0` or no events exist — keeps the bar quiet before a case starts.

**Update cadence:**

Hooked into both `render(drug)` (called on every model mutation + drug switch) and `updateDimming()` (called from `chart-bridge.js onFrame`, already throttled to 2 s). Totals depend on `_getElapsedMinutes()` so they need a time-driven tick; reusing the existing 2 s dimming cadence avoids adding an rAF subscription.

### Interim — TCI tolerance slider rebind, drift-band viz, ke0-aware PROBE (v0.5.25)

*Between Sessions 27 and 28. Not tracked in session numbering. Branch: `claude/test-tci-tolerance-slider-bqElU`.*

Started as a diagnostic — a user suspected the "TCI target tolerance" slider wasn't changing plans. A code trace confirmed the suspicion: the `tciFraction` value was never threaded into `planTCI()`. The CET emulation planner's real drift tolerance lives in `CE_TOL` at `emulation.js:457`, controlled by nothing user-visible. From there the work broadened into three shipped changes plus a notable planner experiment that was tried and reverted.

**Ship list:**

1. **Slider rebind.** `#set-tci-fraction` remapped to the `ceTolerance` setting (range 5..30 step 5 = 0.5%..3.0%, default 15 = 1.5%). Label renamed "Ce drift tolerance". Reads through to `emulation.js:461` via `cfg.ceTolerance`. Drug-panel time-to-target readout (the previous sole consumer of `tciFraction`) now uses a hardcoded 0.95 clinical default. Moving the slider produces visibly different plans — at propofol target 3 for a 70 kg patient, `0.005` gives 47 maintenance steps, `0.030` gives 18.

2. **Drift-band visualization.** Opt-in Appearance toggle. When on, the single dashed target line is replaced by a pair of dashed lines at `target × (1 ± ceTolerance)`. First implementation used a 14% alpha-filled box annotation — imperceptible against the BIS nomogram overlays. Switched to dual lines in `annotations.js`, which are crisp against any background because they're 1.5px strokes rather than alpha-blended fills.

3. **`PROBE` scales with `ke0`.** `emulation.js:459` now computes `max(10, min(30, 2/ke0))` — two time-constants clamped to a 10-min clinical floor and a 30-min ceiling. For propofol and fentanyl (ke0 ≈ 0.147/min) this is ~13.7 min (was 15 hardcoded); for a future remifentanil model it would clamp to 10 instead of waiting 15 min on a drug that settles in under 2. Makes the planner portable across drugs with different equilibration speeds without per-drug PROBE tuning.

**The experiment that didn't ship — peak-aware rate selection:**

Tried to prevent the small (~1–2%) overshoots at early-maintenance step boundaries by adding a dual-constraint rate search in the correction pass: `min(endpointRate, peakRate)`, where `peakRate` was the rate keeping max Ce over `MAX_DUR = 90 min` below `target × (1 + CE_TOL)`. Shipped in `76ad049`, reverted in `60b57c2` once a user screenshot showed Ce dipping to ~3.0 from a 3.5 target in a 90 kg adult — 14% undershoot, well below the 95% "patient stays asleep" clinical floor.

Root cause, documented permanently in `TCI-TOLERANCE-ANALYSIS.md §8`: during V3 filling the rate needed to *hold* Ce at target *now* is higher than long-term steady-state, because it's filling V3 while also maintaining plasma. Any rate that keeps Ce at target short-term will, after 90 min of V3 equilibration, produce a Ce above target. So the peak-bounded search was systematically stricter than endpoint, and `min(endpoint, peak)` picked a rate too low to maintain Ce now. Ce dipped.

The test that shipped with the experiment (`test-tci-peak-overshoot.mjs`) only asserted `max Ce ≤ upper ceiling + ε` — undershoot satisfies an upper-bound test trivially, so it passed green while the planner was clinically worse. Replacement `test-tci-ce-tracking.mjs` asserts BOTH upper and lower bounds plus a hard 90%-of-target floor. 12 assertions; would have failed loudly on the 14% dip.

**New analysis doc:** `TCI-TOLERANCE-ANALYSIS.md`, 10 sections — original disconnect, plain-English planner walkthrough (three-bucket analogy), code walkthrough of the correction pass, SimTIVA live-sim architecture notes (`simspeed`, three `setInterval` loops, `deliver_cpt` replan cadence) drawn from reading `luktinghin/simtiva` read-only, preset semantics (`cpt_threshold` / `cpt_avgfactor` per-drug table), design options (four alternatives with Option C chosen), ke0 portability fix, peak-aware experiment post-mortem, tolerance scaling across drugs with PD-vs-PK caveats, and a cross-referenced symbol table.

**New invariant worth noting:** The `tolerancePct` config key and the `ceTolerance` setting both express "fraction of target" but answer different questions. `tolerancePct` drives BINARY decision gates (loading-bolus threshold at `emulation.js:49`, target-decrease pause cap at `emulation.js:42`). `ceTolerance` drives CONTINUOUS maintenance drift control at `emulation.js:461`. They must stay separate — merging them would create perverse behavior (loading boluses for no reason, or target-decrease pause resuming at the wrong point). Comments at both call sites now explicitly cross-reference to avoid confusion.

**Files changed:** 13 source files + 3 tests + 3 docs. See `CHANGELOG.md` for the full list.

---

### Interim — Patient modal age field not visually active on open (v0.5.24.24)

Regression follow-up from the patient modal (Theme 5 of Session 27). User reported: opening the modal, the Age field is supposed to be active, but it doesn't show the active blue border, and tapping Age does nothing until you tap a different field first and come back.

Root cause in `js/ui/patient-modal.js`: module-level `_active` initializes to `'age'`. `open()` calls `_selectFirstEmpty()` which (in the common path, and explicitly as a fallback) calls `_setActive('age')`. `_setActive` has an early-return `if (_active === field) return;` to make re-taps no-ops (it preserves `_prefilled` and avoids redundant DOM work). Because `_active` is already `'age'` on every open, the guard fires and the DOM work — including applying `.active` to the row — never runs. First tap on the age row hits the same guard. Only after touching a different field does `_active` change, letting a subsequent age-tap actually apply the styling.

Fix: reset `_active = null` inside `open()` right before `_selectFirstEmpty()`. This invalidates the re-tap guard only at modal-open time, so the first `_setActive` call of each session always applies its DOM side effects. The guard itself is kept for its original purpose (re-tapping the already-active field during entry shouldn't re-arm `_prefilled`). Considered but rejected: removing the guard entirely (breaks `_prefilled` re-arm semantics); changing the module-level default (sticky `_active` across close/reopen reintroduces the bug).

Also added a standing rule to `CLAUDE.md` (Common Workflows): when committing, open a PR by default.

**Files changed:** `js/version.js`, `js/ui/patient-modal.js`, `CHANGELOG.md`, `DEVELOPMENT.md`, `CLAUDE.md`.

---

### Session 27 (2026-04-20 / 2026-04-21) — UI Polish Arc (v0.5.24 → v0.5.24.23)

Long polish session driven by iPad Mini / iPad Pro / iPhone screenshots. 23 interim version bumps, all on the `claude/add-large-type-option-d5Onn` branch. See `CHANGELOG.md` for per-version detail; this block is the coherent summary.

**Theme 1 — Accessibility: Large type (v0.5.24 → v0.5.24.2).**
Added a four-position segmented control in the Appearance tab: Normal / Large / XL / XXL. Scales drug-panel, history, topbar, bottom-controls, and chart font-sizes together via `body.text-{lg,xl,xxl}` classes plus a chart-side `fontScale` (1.0 / 1.15 / 1.30 / 1.45). XXL gated to `@media (min-width:1020px)` so the drug-panel has room. Chart text handled via a new `setFontScale()` setter on the chart controller that rewrites `chart.options.*.font.size` from canonical `BASE_FONTS` constants and propagates through canvas-drawing plugins (target-label, readout-panel, BIS band labels in annotations).

**Theme 2 — Drug-card layout + Emergence rename (v0.5.24.3).**
eBIS moved from the Ce/Cp row to a right-justified header element next to the drug name; propofol got units back on the Ce/Cp row (single trailing `μg/mL`, shared). Exit Ce countdown moved out of its absolutely-positioned top-right slot to a block element between the status row and step bar. Renamed user-facing text throughout: `Exit Ce 3.0 in 3:39` → `Emerge → 3.0 in 3:39`; button labels `Set Exit Ce` / `Change Exit Ce` → `Set Emergence` / `Change Emergence`; keypad modal + reached state match. Internal symbols (`exitCe`, `setExitLine`, `.btn-ctrl-exit`, `.exit-readout`) kept to avoid churn.

**Theme 3 — History UX rework (v0.5.24.4 → v0.5.24.7).**
Bottom-bar went from a single `+ Add Event` button to three-button layout `[ET / RT] [+ Add Event] [Edit]`. Edit toggles `body.edit-history-mode` which dims / blurs non-history surface; rows get an amber-tint highlight + crisp 2px border and become tappable (opens event editor via existing `onEventTap`). Time-format toggle now explicit; the old tap-on-time-cell affordance is gone. Rows re-laid-out via CSS grid: `[time | type]` on line 1, `[value centered]` on line 2. Dropped the pencil icon column, the pump-bolus / IV-push duration detail, and the `fmtBolusDelivery` formatter. Selected row uses amber tint + inset 2px border (clinical feel; no halo or scale transform). Click-outside-panel exits edit mode. Dynamic drug-panel width via CSS `fit-content` + `min-width`/`max-width:35vw` clamps. Portrait tablet dynamic row sizing via ResizeObserver + matchMedia in new `js/app/portrait-layout.js`.

**Theme 4 — Single-line Case Time display (v0.5.24.8).**
Topbar stack `19:26:52 / start 15:15` → single bordered button `[ CASE START 15:15 | ET 0:00:00 ]`. Subtle 1px border + hover state so the click affordance reads at a glance. `.timer-wall-hint` element removed; `.elapsed-timer` is now a `<button>`. Labels muted uppercase, values crisp (ET in `--green`).

**Theme 5 — Patient Demographics modal (v0.5.24.9 / v0.5.24.11 → v0.5.24.14 / v0.5.24.23).**
Eliminates the iPadOS numbers-and-symbols keyboard for patient entry (iPadOS won't show a pure 10-key numeric pad regardless of `inputmode`). Main setup screen collapses the four inputs into a single `[Tap to edit patient demographics ✎]` summary row (dim placeholder before entry, `35y · M · 170 cm · 70 kg ✎` after). Modal `#modal-patient` owns entry via a custom 3×5 numeric keypad: Sex field first (two toggle buttons, default none, required on confirm), then Age / Height / Weight; first empty numeric field auto-selected; tap any other field to switch active; keypad feeds the active buffer. A `Next →` key in the bottom row cycles active through `age → height → weight` (disabled on weight), so the user's flow is `toggle sex → type age → Next → type height → Next → type weight → Confirm` — no re-tapping of fields. Metric/Imperial toggle in the modal header routes through the shared `setUnits()` so main-screen toggle + localStorage + modal stay in lockstep. Unit toggle **converts** height/weight between systems (1 cm = 0.393701 in, 1 kg = 2.20462 lbs, 1-decimal rounded) rather than clearing. First keypress on a pre-populated field **replaces** rather than appends; tapping a different field re-arms the prefilled flag. Underlying `<input>` elements kept as `type="hidden"` so `validate()`, `getHeightCm()`, `getWeightKg()`, `updateDerived()`, `confirmPatient()`, session restore all work unchanged — the modal writes values and dispatches `input` events. New module `js/ui/patient-modal.js`.

**Theme 6 — Chart-setting re-apply bug (v0.5.24.10).**
Reported as "Cp-line dimming not respected on case startup". Systemic: four setters (`setCpOpacity`, `setNomogramOpacity`, `setOverlayOpacity`, `setEventMarkerSize`) were guarded by closure-level `last*` caches in `js/app/chart-bridge.js onFrame()`. On `initSimScreen()` the chart gets destroyed and recreated; fresh chart had default values (1.0 opacity etc.) but the bridge still remembered the previous case's cached values — equality check skipped the push. `setFontScale` had already been fixed correctly in v0.5.24.1 (guard inside the setter). Retrofit: moved each setter's change-guard inside the setter (`if (s.cpOpacity === clamped) return`), dropped the bridge-level caches. Bridge now calls every setter every frame unconditionally; chart recreation is self-healing because the fresh chart's defaults differ from user settings, so the first post-recreate frame takes effect. Logged as an invariant in CLAUDE.md.

**Theme 7 — Phone-portrait layout (v0.5.24.15 / v0.5.24.17 / v0.5.24.18).**
Three iPhone screenshots. (a) Topbar "CASE START 13:56 |" segment wasn't hiding on phones even though the phone-portrait media query had `display:none` — **CSS source-order inversion**: the canonical base rule was later in source with equal specificity and overrode the media-query rule. Relocated the canonical `.elapsed-timer` / `.ct-*` base block up before all `@media` blocks. (b) Chart axis labels rendered raw floats (`30.00000000000002`) — added `fmtTick(v)` formatter wired into `ticks.callback` on x, y, and yRate axes; snaps to 3 decimals, integer string for integers, 1-decimal otherwise. (c) Stop Pump wrapped to a second row on iPhone 15 Pro Max — tightened `.btn-ctrl` / `.mode-label` / `.sim-controls` metrics so all six fit; added `padding-bottom: max(18px, env(safe-area-inset-bottom))` so the row sits above the iPhone home-indicator curve instead of being clipped by the rounded screen corner.

**Theme 8 — Keypad unit-toggle consistency (v0.5.24.16).**
Audit surfaced three modals behaving differently on unit toggle mid-entry. `keypad.js` non-bolus kept buffer literally and silently re-interpreted it as the new unit (wrong). `keypad.js` bolus ignored the buffer and reloaded saved-last. `event-editor.js` cleared the buffer. `patient-modal.js` already correct per v0.5.24.12. Standardized: all three now `parseFloat(buffer) → toCanonical(prev, task, ctx) → fromCanonical(new, task, ctx) → formatValue` and mark `prefilled = true` so the next keypress overwrites. Logged as an invariant in CLAUDE.md.

**Theme 9 — Draggable inspect cursor (v0.5.24.19 → v0.5.24.22).**
Added a draggable handle on the inspect cursor. Four iterations to get the iPad drag-hijack fixed:

1. **v0.5.24.19** — new plugin `js/ui/chart/plugins/inspect-handle.js` draws a knob and publishes `s._inspectHandleHit` for hit-testing. Gestures.js added capture-phase touch/mouse handlers on the canvas.
2. **v0.5.24.20** — handle visual redesigned to bottom-of-cursor pill with left/right chevrons (user feedback). Added `touch-action: none` on the canvas; upgraded `stopPropagation` to `stopImmediatePropagation`.
3. **v0.5.24.21** — moved capture-phase listeners from the canvas to `canvas.parentElement`. The previous attempt's mistake: when the event target IS the canvas, listeners on it fire in registration order regardless of `useCapture`, so Chart.js's earlier-registered hammerjs listeners ran first. Capture-phase on an **ancestor** genuinely precedes target-phase on the descendant.
4. **v0.5.24.22** — belt-and-suspenders wasn't enough for hammer's state machine; the drag still hijacked into pan after ~10px. Fixed by flipping `chart.options.plugins.zoom.pan.enabled = false` at touchstart/mousedown on the handle, restoring at touchend/mouseup. The pan plugin respects that flag and refuses to pan while disabled, regardless of recognizer state. Previous layers (capture-phase listener, `touch-action: none`) kept as defense-in-depth around the toggle boundaries.

Clean interaction matrix while inspect is on: **tap empty chart body** sets cursor; **drag handle** moves cursor (live readout updates); **drag empty body** pans; **pinch** zooms; **double-tap** recenters; **Y-axis left-edge drag** scales y-axis.

**New modules added this session:**
- `js/ui/patient-modal.js` — patient entry modal with inline numeric keypad.
- `js/app/portrait-layout.js` — dynamic `grid-template-rows` sizing for the portrait tablet layout.
- `js/ui/chart/plugins/inspect-handle.js` — draggable knob on the inspect cursor.

**Invariants added to CLAUDE.md:**
- Chart setters are idempotent; bridge calls them unconditionally.
- Keypad unit toggles convert the buffer through canonical; don't clear.

**Files changed this session:** `index.html`, `js/version.js`, `js/ui/settings.js`, `js/app/settings-ui.js`, `js/ui/history.js`, `js/ui/keypad.js`, `js/ui/event-editor.js`, `js/ui/setup.js`, `js/ui/timer.js`, `js/ui/mode.js`, `js/ui/drug-panel/index.js`, `js/ui/drug-panel/exit-readout.js`, `js/ui/chart/index.js`, `js/ui/chart/state.js`, `js/ui/chart/annotations.js`, `js/ui/chart/gestures.js`, `js/ui/chart/plugins/readout-panel.js`, `js/ui/chart/plugins/target-label.js`, `js/app/chart-bridge.js`, `js/app.js`, plus the three new modules. `CHANGELOG.md` and `DEVELOPMENT.md` for docs.

---

### Interim — Fix chart-button state on new case (v0.5.23.1)

*Between Sessions 26 and 27. Not tracked in session numbering.*

Bug fix: chart-control buttons (tooltip, events, expand) retained their `.active` CSS class across case resets while the freshly created chart's internal state (`inspectEnabled`, `eventAnnotationsEnabled`) was back to `false`. `sim-content.chart-expanded` and the expand button's glyph/title had the same problem. Result: after a user toggled any of these buttons during one case and then started a new case, the buttons looked lit/expanded but the chart showed neither inspect panel nor future-event markers (and the layout glyph lied about whether the chart was expanded).

**Fix:** `initSimScreen()` in `js/app.js` now clears the `.active` class on `btn-chart-tooltip` and `btn-chart-events`, resets `btn-chart-expand` glyph/title/`.active`, and removes `chart-expanded` from `sim-content` before creating the new chart — so the DOM matches the fresh chart state (everything off, not expanded).

**Files changed:** `js/app.js`, `js/version.js`, `CHANGELOG.md`, `DEVELOPMENT.md`.

---

### Interim — Chart visuals & appearance settings (v0.5.20.2)

*Between Sessions 25 and 26. Not tracked in session numbering.*

Chart readability improvements and a new Appearance settings tab for controlling visual density.

**Chart cursor dots (`js/ui/chart.js`):**

- Custom `cursorDots` Chart.js plugin draws filled circles where Ce (blue) and Cp (red) curves cross the current time cursor line. Uses binary search + linear interpolation on dataset points. Each dot is 4px radius with a dark outline. Dot color matches the line — Cp dot dims with Cp opacity setting.

**Stop Pump button dimming (`js/ui/mode.js`, `index.html`):**

- New `is-idle` CSS state for the Stop Pump button: muted translucent red when case is running but no pump is active (mode `'none'`). Bright red `is-running` only when TCI or manual mode is active. Toggled in `updateModeUI()` after case start.

**Appearance settings tab (`index.html`, `js/ui/settings.js`, `js/app/settings-ui.js`):**

- New "Appearance" tab in the settings modal with three opacity sliders (10%–100%):
  - **Cp line opacity** (`cpOpacity`) — fades the Cp curve via hex alpha on dataset border/fill colors
  - **BIS nomogram opacity** (`nomogramOpacity`) — scales the base alpha of BIS effect-site bands and their text labels
  - **Threshold line opacity** (`overlayOpacity`) — controls alpha on all horizontal reference lines (target, threshold, SS, exit Ce) and plateau region; pill labels remain at full opacity for legibility
- All three settings persisted in localStorage and applied in real time via change detection in `chart-bridge.onFrame()`
- Opacity values stored as `_overlayAlpha` (hex) and `_nomogramOpacity` (float) in chart scope, used by `buildAnnotations()` so they survive annotation rebuilds (cursor move, zoom, pan)

**Files changed:** `js/ui/chart.js`, `js/ui/mode.js`, `js/ui/settings.js`, `js/app/settings-ui.js`, `js/app/chart-bridge.js`, `index.html`

**Tests:** 485 tests across 13 suites, all passing.

---

### Interim — Fix stale drug panel data & control button UX (v0.5.20.1)

*Between Sessions 25 and 26. Not tracked in session numbering.*

Fixes several bugs where drug panel data and control buttons retained stale state from a previous case or failed to update for non-selected drugs. Also improves control button visual feedback with dim/bright states.

**Bug fixes:**

- **Step bar stale data after New Case** — Step bar countdown text (rate countdowns, redose thresholds) persisted in the DOM after starting a new case because the `update()` loop had no `else` branch to clear step bar elements when `caseStarted` was false.
- **Approach cache not invalidating on Ce threshold crossing** — The approach cache used mode, rate, and ceTarget as invalidation keys but did not track whether Ce was above or below the threshold. Non-selected drug cards showed stale "Below Redose Threshold" text even after Ce rose above the threshold. Added `ceAboveTarget` tracking to the cache.
- **Stale button state after New Case** — `mode.reset()` did not call `updateExitButton()`, leaving the exit button showing "Change Exit Ce" after targets were cleared. `initSimScreen()` did not reset `selectedDrug` or drug card `.active` class, causing `onCaseStart` to update buttons for the wrong drug.
- **Pump stop not clearing manual mode** — Stopping the pump from manual mode left the mode as `'manual'`, keeping the rate button highlighted. Now drops to `'none'` from any active mode.

**UI improvements:**

- **Dim/bright control buttons** — Target/threshold, exit Ce, rate, and bolus buttons now use muted translucent backgrounds by default. Full bright color with glow ring appears only when `active-mode` is set, making active vs inactive state visually clear.
- **Bolus button highlights in intermittent mode** — Add Bolus gets `active-mode` in both intermittent-only and infusion+redose states (pump-off and pump-on paths).
- **Threshold dialog clear option** — Mirrors the exit Ce pattern: shows a Clear button when a threshold is set, pre-fills the current value for editing, title changes to "Change Redose Threshold".
- **Rate keypad pre-fill** — The rate keypad pre-fills with the last used rate (per-drug, stored in localStorage) for quick resume after pump stop.

**Files changed:** `js/ui/drug-panel/index.js`, `js/ui/drug-panel/approach.js`, `js/ui/mode.js`, `js/ui/keypad.js`, `js/app.js`, `index.html`

**Tests:** 485 tests across 13 suites, all passing.

---

### Interim — Per-drug pump settings (v0.5.20)

*Between Sessions 25 and 26. Not tracked in session numbering.*

Adds a per-drug "Delivery Method" setting controlling whether each drug uses an infusion pump. Propofol pump is mandatory; fentanyl and ketamine default to manual (bolus only) and can opt-in to pump use via the setup screen.

**When pump is OFF for a drug:**

- Set Rate and Stop Pump buttons are hidden — simplified bolus-only interface
- Boluses forced to IV Push delivery mode ("Administer" button)
- Mode locked to NO MODE or INTERMITTENT (INFUSION / INF+REDOSE states unavailable)
- Event editor hides rate/pause type options
- Drug status no longer shows "Stopped" for pumpless drugs (bug fix)
- History defaults to bolus-only view

**Data model (`js/util/constants.js`):**

- `PUMP_MANDATORY` set — drugs where pump is always on (propofol)
- `getPumpSettings()` returns `pumpEnabled` (propofol: always true, fentanyl/ketamine: default false)
- `setPumpSettings()` accepts `pumpEnabled` (skipped for mandatory drugs)
- `isPumpEnabled(drugId)` — convenience getter

**UI (`index.html` + `js/ui/setup.js`):**

- "Delivery Method" `<select>` on fentanyl/ketamine setup tabs (Manual bolus only / Infusion pump)
- Infusion unit selector and pump-derived rate display hidden when pump is OFF
- Persisted to `tci-pump-enabled-{drugId}` in localStorage

**Mode gating (`js/ui/mode.js`):**

- New pump-disabled branch in `updateModeUI()` hides `btn-rate`, `btn-pause` (post-start), ctrl-divider
- Imports `isPumpEnabled` from constants and `isCaseStarted` from controls (no circular dependency — controls.js does not import mode.js)

**Bolus handling (`js/app.js` + `js/ui/keypad.js`):**

- `isPumpEnabled` injected into keypad via opts; extends `isIntermittentBolus` to include no-pump drugs
- Rate handler guarded: `if (!isPumpEnabled(selectedDrug)) return`
- Pump-pause handler guarded similarly
- `onCaseStart` callback calls `mode.refreshUI()` to hide Stop Pump for no-pump drugs

**Event editor (`js/ui/event-editor.js`):**

- Rate/pause type buttons hidden when pump is off; delivery mode forced to push

**Persistence (`js/app/session.js`):**

- `pumpEnabled` map added to `persist.saveCase()` and restored on load
- Old saved cases without `pumpEnabled` field default to current settings (no migration issue)

**Tests:** 485 tests across 13 suites, all passing. Model layer unchanged — pump settings are purely a UI concern.

---

### Interim — Refactor app.js into sub-modules (v0.5.19.10)

*Between Sessions 25 and 26. Not tracked in session numbering.*

`js/app.js` was the largest file in the codebase at 1087 lines, owning 8+ unrelated concerns. Decomposed into 4 focused sub-modules under a new `js/app/` directory using the strangler fig pattern (one extraction at a time, full test suite verified after each step).

**New modules:**

- **`js/app/settings-ui.js`** (`initSettingsUI()`) — Settings modal DOM wiring: slider/checkbox initialization, live value labels, tab switching, open/close buttons. Dependencies: only `getSettings` and `setSettings` from the settings module.
- **`js/app/tci-modal.js`** (`createTciModal()`) — TCI delay selection modal and first-step countdown modal. Owns `pendingTCI`, `tciDelaySeconds`, `tciCountdownInterval` state that was previously at module scope in app.js. Exposes `showDelay`, `commit`, `setPending`, `cleanupDelay`, `cleanupFirstStep`, `initListeners`.
- **`js/app/session.js`** (`createSession()`) — Case save, restore, and new case lifecycle. Receives mutable app state via getter/setter pairs (`getModel`, `getConfirmedPatient`, `setConfirmedPatient`, etc.). Preserves all invariants: snapshot stripping, system event skipping, `'intermittent'` → `'none'` migration, `mode.refreshUI()` after threshold restore.
- **`js/app/chart-bridge.js`** (`createChartBridge()`) — Chart refresh cycle (`refresh`), BIS effect overlay (`computeEffectOverlay`), per-drug y-axis config (`getConfig`, replaces `CHART_DRUG_CONFIG`), and the per-frame `onFrame` callback. The `chart._lastCursorUpdate`, `chart._lastSsCe`, `chart._lastPlateauRegion` properties previously glued onto the chart object are now clean local variables.

**Prerequisite: `DRUG_IDS` constant** — Added `export const DRUG_IDS = ['propofol', 'fentanyl', 'ketamine']` to `js/util/constants.js`. Replaces 4 hardcoded drug ID arrays in app.js. Adding remifentanil later is a one-line change.

**Circular dependency resolution:** `chartBridge.refresh()` calls `session.save()` and `session.restore()` calls `chartBridge.refresh()`. Resolved via late-binding closures — both are created in `boot()` before any user interaction, and reference each other through module-scope variables.

**No shim needed:** Unlike `drug-panel.js` → `drug-panel/` and `events.js` → `events/`, app.js is only loaded via `<script type="module">` in index.html — no other JS module imports from it.

**Result:** app.js reduced from 1087 to 542 lines (50% reduction). `initSimScreen` (75 lines) and keypad `onConfirm` handler (90 lines) remain in app.js — they are deeply coupled to app-level state with no natural module boundary.

**Tests:** 485 tests across 13 suites, all passing. No behavioral changes.

---

### Interim — Round TCI plan in display units (v0.5.19)

*Between Sessions 25 and 26. Not tracked in session numbering.*

An opt-in checkbox in the propofol setup panel makes every TCI planner snap bolus and rate values to the clinician's chosen display-unit grid (e.g. integer mL/h, multiples of 10 mcg/kg, 0.01 mcg/kg/min). Addresses the pain point that a bolus of 148 mg = 14.8 mL = 2114.3 mcg/kg and a rate of 58.0 mL/h = 138.1 mcg/kg/min = 9.67 mg/min can't be typed cleanly into a pump.

**Key design principle — quantize inside the loop, not after:**

Rounding the planner's final output to display units introduces stacking errors because each iteration of the maintenance loop sees the *un-rounded* canonical value, so rounding error compounds. Instead, quantization happens **inside** the planning loop, before every `engine.advance()` call — so the engine always sees the value the pump will actually deliver, and the next iteration corrects from that state.

**New helpers (`js/util/units.js`):**

- `quantizeInDisplay(canonicalValue, displayUnit, drugId, task, ctx)` — snaps a canonical value to the nearest step defined in `DRUG_TASK_UNITS[drug][task].quantSteps[displayUnit]`, then returns it in canonical units. No-op for units without a defined step, so callers can invoke unconditionally.
- `getQuantStep(drugId, task, displayUnit)` — table lookup, returns null when no step exists.
- `getQuantizeConfig(drugId)` — reads `tci-pref-quantizeInDisplay` + the drug's stored `tci-pref-{task}Unit-{drug}` keys from localStorage, falls back to `getDefaultUnit()` when stored prefs are invalid or missing, and returns the config object that call sites spread into `planTCI()`'s `tciConfig` argument.

**Planner integration (`js/sim/tci-planner.js`):**

`makeQuantizers(cfg)` produces per-run `qBolus`/`qRate` closures that resolve to identity functions when `cfg.quantizeInDisplay` is false. Applied at every critical point:

- `planTCIScheme` (stepped): `qBolus(calculateLoadingBolus())`, `qRate(findMaintenanceRate())` inside the maintenance loop, plus the 0.001 mg/min minimum-rate fallback.
- `planTCISchemeCET`: `qBolus(calculateCETBolus())` — but only when `bolusOverrideMg` is null, so the Conservative→CET delegation doesn't double-quantize. `qRate(findMaintenanceRate())` at both the initial step and every in-loop iteration.
- `planTCISchemeCETConservative`: `qBolus(simtiva.bolusMg)` for the zero-Ce analytical path, `qBolus(exactBolus * correctionRatio)` for the existing-drug binary-search path.
- `planTCISchemeEmulation`:
  - `qBolus` on both the zero-Ce SimTIVA bolus and the binary-searched trial dose.
  - `bolusDurSec` calculation uses `cfg.quantizeInDisplay ? bolusMg : Math.ceil(bolusMg)` so the pause duration matches the final bolus value under either mode.
  - Legacy `bolusMg = Math.ceil(bolusMg)` gated behind `!cfg.quantizeInDisplay`.
  - The `rnd` closure (previously hard-coded to `Math.round(r*360)/360` = nearest 1 mL/h at 10 mg/mL) is replaced with `cfg.quantizeInDisplay ? (r) => qRate(r*60)/60 : <legacy>`.
  - In the post-extraction adaptive-correction pass, `rate` is quantized **before** the forward-probe extension loop — otherwise the probe would run at a different rate than the engine advance, and extension would stop too early/late.
  - Terminal SS rate is quantized before being appended.
- `appendTerminalRates()`: both the 5-hour lookahead binary-search rate and the analytical SS rate are quantized before being pushed.

**Call-site threading (`js/sim/simulation.js`, `js/app.js`, `js/ui/event-editor.js`):**

`planTCI()`'s `planConfig` gained `drugId`, `weightKg`, `quantizeInDisplay`, `bolusDisplayUnit`, `rateDisplayUnit`. All three planTCI call sites (pre-start planning in `app.js:545`, delayed planning in `app.js:974`, event-editor re-plan in `event-editor.js:515`) spread `getQuantizeConfig(drugId)` into their `tciConfig` argument.

**UI (`index.html`, `js/ui/setup.js`):**

- New checkbox `#input-round-in-display` in the propofol setup panel (one checkbox governs every drug; the planner reads each drug's own display-unit pref).
- Three `.rounding-note` spans (one per drug panel) with a live-updating line: "Plan rounds to: bolus → nearest 10 mcg/kg, rate → nearest 1 mL/h" when enabled, or a dimmed off-state hint when not.
- `populateRoundingControls()` restores the checkbox from localStorage, registers a `change` listener that re-renders all three notes, and registers listeners on every unit selector so changing a unit immediately re-renders its note. `updateRoundingNote(drugId)` reads the current `<select>` values + checkbox state and composes the sentence via `getQuantStep()`.
- `applyPumpSettings()` also persists the checkbox state on confirm (redundant with the change listener but mirrors the existing pump-settings persistence pattern).

**Tests:**

- **`tests/test-units.js`** gained an inline `quantizeInDisplay` + `getQuantStep` helper matching the real ones, plus 25 tests covering: propofol/fentanyl/ketamine grid snapping across every unit, round-to-nearest semantics (0.55 → 1, 0.45 → 0), idempotence, weight-dependent snapping (same mcg/kg grid → different mg for 50kg vs 100kg), null-step fallback, zero/NaN passthrough, and a getQuantStep lookup table check.
- **`tests/test-tci-scheme.js`** gained an inline `planTCISchemeQuantized` variant that mirrors the real planner's quantize-in-loop pattern (all iterations see the snapped rate), plus 4 tests: all rates are integer mL/h values, bolus is whole mg, Ce at 30 min stays within ±8% of target (proving stacking-error prevention), engine state is preserved.
- **455 tests across 13 suites, all passing.**

---

### Interim — Model info display and default unit selectors (v0.5.18)

*Between Sessions 25 and 26. Not tracked in session numbering.*

Each drug setup panel gained a `.model-info` block directly under the drug tab buttons showing the PK/PD model provenance ("Eleveld 2018", "Shafer 1990 with Shibutani 2004 weight correction", "Domino 1982 / Navarrete 2000") sourced from new `MODEL_NAME` / `MODEL_DESCRIPTION` exports in each `js/pk/<drug>.js`.

Each panel also gained per-task default-unit dropdowns (bolus unit + rate unit) populated from `DRUG_TASK_UNITS.allowed`. Selection is persisted under `tci-pref-{task}Unit-{drug}` and read by the keypad and drug-panel modules on every open, so a clinician's preferred units are pre-selected everywhere without having to flip them each time. Runtime overrides still work and still persist.

---

### Interim — Threshold chart pill precision fixed to X.x for all drugs (v0.5.17.5)

*Between Sessions 25 and 26. Not tracked in session numbering.*

The threshold pill label on the chart (`js/ui/chart.js`, `drawPillLabel`) used `thresholdCe.toFixed(2)`. Since `thresholdCe` is stored in chart units (already ×`_yScale`), fentanyl's 0.2 ng/mL threshold displayed as "0.20". Changed to `toFixed(1)`. Note: `targetCe` and `exitCe` pills already used `toFixed(1)`.

---

### Interim — Threshold Ce label precision fixed to X.x (v0.5.17.4)

*Between Sessions 25 and 26. Not tracked in session numbering.*

The redose threshold Ce value shown in approach-line and step-bar labels ("Redose Threshold 2.00 in 3:21") used `toFixed(2)` for mcg/mL drugs, giving unnecessary X.xx precision inconsistent with the X.x format used for the Exit Ce corner readout. `fmtCe()` in `js/ui/drug-panel.js` was given an optional `dp` parameter (default 2, preserving live Ce/Cp readout precision). The three threshold label call sites (approach-line "Below Redose Threshold", approach-line "Redose Threshold X in", and step-bar countdown) now pass `dp=1`.

---

### Interim — Rate button shows "Change Rate" when infusion is running (v0.5.17.3)

*Between Sessions 25 and 26. Not tracked in session numbering.*

The rate button (`btn-rate`) previously showed a static label ("Manual Rate" from HTML for TCI drugs, "Set Rate" for non-TCI drugs) regardless of whether an infusion was active. For consistency with the pattern established by "Set/Change Threshold" and "Set/Change Exit Ce", `updateModeUI()` in `js/ui/mode.js` now sets `br.textContent` explicitly in every branch:

- Mode `'manual'` (infusion running) → **"Change Rate"**
- All other states → **"Set Rate"**

This applies to both TCI and non-TCI drugs. The initial HTML button text was also updated from "Manual Rate" to "Set Rate" to match the default no-mode state.

---

### Interim — Exit Ce corner value fixed to X.x precision (v0.5.17.2)

*Between Sessions 25 and 26. Not tracked in session numbering.*

The drug card corner readout used the raw keypad buffer token for the Ce value, so an integer entry (e.g. "2") would display as "2" rather than "2.0". Fixed by parsing the numeric part of the label and formatting with `toFixed(1)` in `updateExitReadout()` (`js/ui/drug-panel.js`).

---

### Interim — Exit Ce UI: Labels, Corner Readout, Button Grouping (v0.5.17.1)

*Between Sessions 25 and 26. Not tracked in session numbering.*

Polished the Exit Ce UI across three areas:

**Button labels (`js/ui/mode.js`):**
`updateExitButton()` now shows state-aware labels — `"Set Exit Ce"` when no threshold is set, `"Change Exit Ce"` when one is active. The old label embedded the numeric value (`"Exit 0.8 mcg/mL"`), which was redundant given the corner readout and chart line. New `getExitCeLabel(drugId)` export exposes the display label to downstream modules.

**Drug card corner readout (`js/ui/drug-panel.js`):**
The top-right corner of each drug card now shows `Exit Ce <value> in <mm:ss>` when a threshold is set and the simulation is running — the Ce value is rendered in cyan (`var(--cyan)`) to match the Ce color scheme, and the countdown remains amber. Only the numeric part of the label is shown (units stripped). When Ce drops at or below the threshold, the readout now says `"Exit Ce Reached"` (was `"Exit reached"`) in green. New `getExitCeLabelForDrug` callback slot added to `drug-panel.js` init, wired in `app.js`.

**Button grouping (`index.html`):**
Exit Ce moved from between Add Bolus and Start to immediately after Set Target — grouping the two concentration-targeting controls together. A thin `ctrl-divider` separates this targeting group from the manual pump controls (Manual Rate, Add Bolus). New `.ctrl-divider` CSS rule added.

426 tests across 13 suites, all passing.

---

### Interim — Orthogonal Infusion + Redose Threshold for Non-TCI Drugs (v0.5.17)

*Between Sessions 25 and 26. Not tracked in session numbering.*

For non-TCI drugs (fentanyl, ketamine), intermittent bolus and manual infusion were mutually exclusive mode states. Setting a redose threshold while an infusion was running silently hid the rate display (but the pump kept running). Setting an infusion rate cleared the stored threshold. Button labels changed meaning depending on state, making the UI unpredictable.

**Orthogonal mode model (`js/ui/mode.js`):**
Infusion rate and redose threshold are now independent properties. `mode.set()` no longer clears `intermittentThresholds` on mode change. The display state is derived from both mode AND threshold:

| Mode | Threshold | Label | btn-target | btn-rate |
|------|-----------|-------|------------|----------|
| none | 0 | NO MODE | Set Threshold | Set Rate |
| none | >0 | INTERMITTENT | Change Threshold | Set Rate |
| manual | 0 | INFUSION | Set Threshold | Set Rate |
| manual | >0 | INF + REDOSE | Change Threshold | Set Rate |

Button labels are now action-consistent — btn-rate is always "Set Rate", btn-target toggles between "Set Threshold" / "Change Threshold" based on whether a threshold is set. Added `clearIntermittentThreshold()` export for explicit clearing.

**Mode transitions (`js/app.js`):**
Setting a redose threshold no longer changes mode — it just stores the threshold and refreshes the UI. Setting a rate while a threshold is set keeps the threshold. For non-TCI drugs, a bolus from 'none' mode no longer auto-sets 'manual' mode. Bolus delivery mode is determined by threshold + infusion state: push-only when threshold is set and no infusion running, pump/push choice when infusing. Old saved sessions with `mode='intermittent'` are migrated to `'none'` on restore.

**Combined state display (`js/ui/drug-panel.js`):**
Rate display is always visible when rate > 0 (removed intermittent-mode hiding). In the combined INF + REDOSE state, the approach area shows SS/plateau analysis while the step bar shows the redose countdown. When the infusion keeps Ce above the threshold (no redose needed), the step bar falls back to normal display instead of showing the red "below threshold" indicator. All `m === 'intermittent'` checks replaced with threshold-based checks. Redose countdown wording changed to "Redose Threshold X.x in MM:SS" and "Below Redose Threshold X.x" to show the target Ce value.

**Intermittent bolus detection (`js/ui/keypad.js`):**
The keypad's push-only "Administer" button now triggers when a threshold is set AND no infusion is running, instead of checking for the old 'intermittent' mode value. Wired new `getIntermittentThreshold` callback.

**Chart threshold line (`js/app.js`):**
The amber dashed threshold line now shows whenever a threshold is set, regardless of mode (previously gated on `m === 'intermittent'`).

**Chart tooltip rate units (`js/ui/chart.js`):**
The tooltip previously hardcoded `mcg/kg/min` for rate display, which rounded to "0.0" for fentanyl's tiny rates. Now uses the drug's preferred rate unit via the unit system (mcg/kg/min, mcg/h, mL/h for fentanyl; mg/kg/h, mL/h for ketamine), matching the drug card's inline rate display.

421 tests across 13 suites, all passing.

---

### Interim — Fix Long-Term TCI Ce Drift (v0.5.16.1)

*Between Sessions 25 and 26. Not tracked in session numbering.*

All four TCI planners held target Ce well in the near term (0-60 min) but allowed significant upward drift long-term. At t=230 min with Ce target 3.5, Ce read 3.642 (+4%) and kept growing. Root cause: planners are one-shot — they generate a finite set of rate-step events at planning time, and the last emitted rate becomes permanent. As V3 (slow peripheral, τ ≈ 300 min) continues equilibrating, the optimal rate decreases, but no planner was emitting new steps.

**`computeSteadyStateRate()` (`js/pk/steady-state-predictor.js`):**
Algebraic inverse of `predictSteadyStateCe()`. Computes the exact infusion rate for any Ce target at true steady state: `rate = ceTarget / (-A⁻¹[3,0])`. One matrix inverse, no simulation needed.

**Terminal rate events for Stepped/CET planners (`js/sim/tci-planner.js`):**
New `appendTerminalRates()` helper emits two final rate events after the maintenance loop exits: (1) a long-lookahead (300 min) binary-search rate from the current engine state, accounting for actual V3 level; (2) the analytical SS rate at +300 min for asymptotic convergence. CET-Conservative inherits this via its CET delegation.

**Emulation planner post-extraction correction pass (`js/sim/tci-planner.js`):**
SimTIVA's step extraction uses `cptAvgFactor=0.667` which biases rates HIGH. SimTIVA compensates by replanning every 2 min; our one-shot planner held biased rates for 30-120+ min. Fix: a correction pass replaces all SimTIVA maintenance rates (preserving only the zero-rate pause after bolus) with binary-search-corrected steps. Adaptive spacing via Ce deviation probing: each step targets Ce=target at a 15-min lookahead, then extends while Ce stays within ±1.5%. Produces 15-min steps during fast V3 equilibration, widening to 90-min steps near steady state. ~19 rate events total with Ce within ±1.5% across 900+ min.

**Long-duration drift tests (`tests/test-tci-scheme.js`):**
Three new tests: (9) Ce within ±5% at t=300, 600, 900 min; (10) analytical SS rate matches true steady state within 0.5%; (11) SS rate event is emitted in scheme within 2% of analytical.

426 tests across 13 suites, all passing.

### Interim — Code review fixes: peak detection, fentanyl height, steady-state heuristic (v0.5.19.9)

*Not tracked in session numbering.*

Five fixes from a full code review of the simulation orchestration layer and TCI planners. The pharmacology core (`eleveld.js`, `pd.js`, `engine.js`) was confirmed correct. Two review claims were rejected after independent verification.

**CET/Emulation peak-detection bug (`js/sim/tci/cet.js`, `js/sim/tci/emulation.js`):**
The bolus pause scan used `cePrior` (previous Ce) instead of `cePeak` for the drop threshold. Because `cePrior` was unconditionally updated at the end of every loop iteration (`cePrior = ce`), the termination condition `ce < cePrior - 0.0005` checked against the immediately previous Ce — not the observed peak. This could trigger premature exit on single-step floating-point noise at the flat peak. Fixed: removed `cePrior`, threshold against `cePeak` instead.

**Fentanyl NaN height (`js/sim/simulation.js`, `js/pk/fentanyl.js`):**
`calcFentanylParams()` uses `height` for BMI to apply the Shibutani weight correction for obese patients (BMI > 30, TBW >= 85 kg). Both call sites in `simulation.js` (`init()` and `setPatient()`) passed only `{ weight }`, causing `height` to be `undefined` → `NaN` for BMI. The `pkMass()` guard `bmi > 30` evaluated to `false` (since `NaN > 30` is false), so the correction was silently skipped. Obese patients never received the Shibutani-corrected pharmacokinetic mass for fentanyl. Fixed: pass `height` at both call sites.

**Steady-state heuristic too short (`js/pk/decay-predictor.js`):**
`predictTroughWithRate()` estimated steady-state Ce by advancing 120 minutes. Eleveld V3 equilibration has τ ≈ V3/Q3 ≈ 246 min, so at 120 min V3 is only ~40% equilibrated, inflating the estimated SS. Could incorrectly return `willReach: false`. Replaced with `predictSteadyStateCe()` from `steady-state-predictor.js` — analytical matrix math, exact and stateless.

**Dead setState calls removed (`js/sim/simulation.js`):**
`setPatient()` snapshotted old engine state and transplanted it into new engines before calling `replayAll()`. Since `replayDrug()` calls `engine.reset()` before replaying events, the transplanted state was immediately zeroed — making the `setState()` calls dead code. Removed along with updated docstring.

**Bolus deficit threshold configurable (`js/sim/tci/shared.js`, `js/sim/tci/cet.js`):**
Hard-coded `0.8` threshold for skipping the loading bolus (when Ce is already >= 80% of target) moved to `bolusDeficitThreshold: 0.8` in `DEFAULT_SCHEME_CONFIG`.

**Rejected review claims:**
- *"setState double-counts drug"* — incorrect; `engine.reset()` in `replayDrug()` zeroes state before replay. No double-counting.
- *"appendTerminalRates leaves engine dirty"* — incorrect; `computeSteadyStateRate()` is pure matrix math with no state mutation, and the engine is restored at line 107.
- *"Q2 test tolerance too wide (1.83 is erroneous)"* — incorrect; 1.83 is the correct output. The Q2 formula includes `(1 + 1.3*(1 - fq3maturation(age)))`, shifting the base theta of 1.75 to ~1.83 for adult patients.

**Files changed:**
- `js/sim/tci/cet.js` — removed `cePrior`, use `cePeak` in threshold; use `cfg.bolusDeficitThreshold`
- `js/sim/tci/emulation.js` — same `cePrior` fix
- `js/sim/simulation.js` — pass `height` to secondary drug calc; remove dead `setState` calls
- `js/pk/decay-predictor.js` — import `predictSteadyStateCe`, replace 120-min simulation
- `js/sim/tci/shared.js` — add `bolusDeficitThreshold` to config

485 tests across 13 suites, all passing.

---

### Interim — Fix test-pk.js divergence from production, add ceForBIS coverage (v0.5.19.8)

*Not tracked in session numbering.*

**Problem:** `tests/test-pk.js` inlined its own copy of `calcEleveldParams` instead of importing from production `js/pk/eleveld.js`. This copy had two divergences from the production implementation:

1. **Female CL computed incorrectly:** The test used a multiplier approach (`1.89 × 1.30 = 2.457 L/min`), while the production code uses separate base values per Eleveld Table 2 (`male ? 1.79 : 2.1`). The existing directional assertion (`female.CL > base.CL`) passed silently with the wrong absolute value.
2. **Q3 had a spurious sex modifier:** The test applied the Q3 maturation ratio only for females (`q3_sex = male ? 1 : (q3_mat/q3_mat_ref)`), while the production code applies it universally regardless of sex.

Additionally, `ceForBIS` in `js/pk/pd.js` had a misleading comment implying its gamma branch was an approximation when it is mathematically exact, and had zero test coverage.

**Fix:**
- Replaced inlined `calcEleveldParams`, `drugEffect`, and `predictBIS` in `test-pk.js` with dynamic imports of the production modules (`eleveld.js`, `pd.js`). Test body wrapped in async IIFE to support dynamic `import()`.
- Added absolute value assertion for female CL: `relEqual(female.CL, 2.1, 0.05)`.
- Added Test 10: `ceForBIS` round-trip (9 assertions) — validates `ceForBIS(predictBIS(Ce)) ≈ Ce` across six Ce values, correct side-of-Ce50 for high/low BIS, and exact Ce50 return at 50% baseline.
- Fixed `ceForBIS` comment in `pd.js` to explain that `effect < 0.5 ↔ Ce < Ce50` by definition of Ce50, so the branch is exact.

**No production simulation logic changed.** Only the test suite and a comment were modified.

**Files changed:**
- `tests/test-pk.js` — replaced inlined PK/PD functions with imports, added female CL absolute assertion, added ceForBIS round-trip test
- `js/pk/pd.js` — fixed misleading comment on ceForBIS gamma branch

485 tests across 13 suites, all passing.

---

### Interim — Remove Ce50 opioid correction (v0.5.19.7)

*Not tracked in session numbering.*

**Change:** Removed the `ce50OpioidCorrection` flag and `exp(-0.567)` Ce50 opioid correction from the Eleveld implementation. Ce50 is now unconditionally age-dependent only: `Ce50 = 3.08 * exp(-0.00635 * (age - 35))`.

**Rationale:** The `exp(-0.567)` factor is not part of the published Eleveld 2018 model. Ce50 in the paper depends only on age. Opioid covariates affect V3 and CL (PK) but not Ce50 (PD). Three independent reference implementations — SimTIVA, TivaTrainer, and TivaTrainer DiY spreadsheets — all compute Ce50 without an opioid term. Cross-validation against Vandemoortele 2022 review confirms this. The factor (`exp(-0.567) ≈ 0.567`) is numerically close to the V3 opioid term at age 40 (`exp(-0.0138*40) ≈ 0.576`), suggesting it was a misinterpretation of a PK parameter as a PD covariate.

**Files changed:**
- `js/pk/eleveld.js` — removed `ce50OpioidCorrection` destructuring and `exp(-0.567)` multiplier
- `index.html` — removed Ce50 opioid correction checkbox row
- `js/ui/setup.js` — removed checkbox wiring, localStorage persistence, visibility toggling
- `js/sim/simulation.js` — removed `ce50OpioidCorrection` from default patient
- `tests/test-pk.js` — removed `Ce50_opioid` theta, updated inline calc, replaced correction-on test with Ce50 opioid-independence tests and BIS reference-value regression tests
- `tests/test-sim-v2.js` — fixed legacy inline Ce50 formula (removed opioid factor, corrected aging coefficient)

---

### Session 25 — Configurable Exit Ce & Emergence Fix (v0.5.16)

**Bug fix — emergence readout rendering (`js/ui/drug-panel.js`):**
The approach line failed to show the emergence countdown when the propofol pump was stopped. Root cause: the `updateApproachLine` rendering branch `if (m === 'manual')` entered the two-line SS+Plateau display even when rate=0. The emergence data was stored in the single-line fields but only rendered in the `else` branch. Fix: `if (m === 'manual' && rate > 0)`.

**Configurable Exit Ce (`js/ui/mode.js`, `js/ui/keypad.js`, `js/app.js`):**
Per-drug Exit Ce threshold that persists across mode changes. Stored as canonical mcg/mL in `exitCeTargets` with a display label for the button (e.g. "1.5"). Set via a red "Exit Ce" button in the bottom control bar that opens the keypad. The keypad hides the unit toggle and conversion preview for exitCe since no unit conversion is needed. A "Clear" button appears in the keypad when a value is already set. On clear, the value, chart line, and readout are all removed. Persisted in case state alongside modes and ceTargets.

**Chart exit line (`js/ui/chart.js`):**
Red dashed horizontal annotation line at the Exit Ce level, following the same `buildAnnotations()` pattern as target, threshold, and steady-state lines. Red pill label drawn by the `targetCeLabel` afterDraw plugin. Public API: `setExitLine(ce)` — pass 0/null to clear. Scaled by yScale in `refreshChart` for ng/mL-scale drugs.

**Drug card exit readout (`js/ui/drug-panel.js`):**
Absolutely-positioned element in the upper-right of each drug card. When Exit Ce is set and Ce > threshold: shows "Exit M:SS" — the predicted time for Ce to decay to the exit threshold if the infusion were hypothetically stopped now. Uses `predictDecayTo()` (rate forced to 0) throttled to every 3 seconds. Shows "Exit reached" (green) when Ce is at or below threshold. Hidden when Exit Ce is not set.

**`predictDecayTo` (`js/sim/simulation.js`):**
New method identical to `predictTrough` but forces `currentRate = 0` for the decay prediction. Used exclusively by the exit readout for "what-if stopped now" calculations.

**Emergence approach line uses Exit Ce (`js/ui/drug-panel.js`):**
When Exit Ce is set, the emergence countdown uses it instead of the hardcoded 1.5 µg/mL default. Label changes from "Emergence" to "Exit" when Exit Ce is active.

**Red stop button (`index.html`):**
`.btn-ctrl-pause.is-running` styled red (#ef4444) with red hover (#dc2626). Start button remains green.

421 tests across 13 suites, all passing.

---

### Interim — Settings Rename & Pump-Change Popup (v0.5.15.1)

*Between Sessions 24 and 25. Not tracked in session numbering.*

**Rename `warnings.js` → `settings.js`:**
The module outgrew its original name — it now manages notification settings, simulation tuning parameters (TCI fraction, plateau slope tolerance, exit band), and per-frame event processing. Renamed file via `git mv`, updated import alias from `warnings` to `settings` in `app.js` (8 call sites) and `drug-panel.js` (3 call sites). Updated references in `CLAUDE.md` and `ARCHITECTURE.md`. localStorage key `'tci-warn-settings'` unchanged — no migration needed.

**Larger TCI pump-change popup (`index.html`):**
The warning popup shown during active TCI plans (upcoming rate changes and boluses) was small and hard to read on mobile. Enlarged to be visually closer to the first-step countdown modal: `.warn-desc` (pump action) bumped from 14px/500 to 19px/600, `.warn-countdown` from 12px/`--text-secondary` to 24px/`--amber` with letter-spacing. Container width increased to 400px, padding and button sizing scaled proportionally.

**Zero chime on pump-change countdown (`js/ui/settings.js`):**
Added a one-shot `playAlert('info')` when the warning popup countdown reaches zero, matching the existing first-step modal behaviour. Required a new `_zeroChimeFired` Set guard (alongside `_prepSoundFired`/`_alertFired`). The chime logic runs in a separate pass over all `_activePopups` after the per-drug loop — the `nextEvt` selector uses strict future time (`e.time > t`), so the event drops out of selection at the exact moment `rem <= 0`. Event time stored on the popup element's `dataset.evtTime` for the post-loop check.

421 tests across 13 suites, all passing.

---

### Session 24 (2026-04-10) — Mobile Interface Optimization & Portrait Layout (v0.5.15)

**Y-axis gesture reversal (`js/ui/chart.js`):**
Reversed the y-axis finger-drag direction: dragging down now increases yMax (zoom out), dragging up decreases it (zoom in). Single sign flip in `handleYTouchMove` — `yDragStartY - clientY` changed to `clientY - yDragStartY`.

**Phone landscape layout (`index.html`):**
New `@media(max-width:900px) and (max-height:420px)` query targets phone landscape specifically. Drug panel narrowed to 175px, card padding/gap/font sizes tightened (active Ce 20px, inactive 16px), model label hidden. Prevents BIS overflow on the active propofol tile.

**Portrait layout — phones (`index.html`, `js/app.js`, `manifest.json`):**
New `@media(orientation:portrait) and (max-width:500px)` query. Portrait overlay removed — manifest orientation changed from `"landscape"` to `"any"`, JS orientation lock removed. Layout: `.sim-main` switches to `flex-direction:column`; `.drug-panel` moves to `order:1` (bottom) with `max-height:45%` and `overflow-y:auto`; `.sim-content` gets `flex:1 1 0` + `min-height:0` to properly constrain the 45/55 split. Drug cards use reduced sizes (padding 6px 10px, gap 2px, active Ce 22px, inactive 18px) — full landscape-style vertical cards, not a compact horizontal row. Setup screen stacks brand above form. Topbar hides app name, compacts patient summary.

**Portrait layout — iPad (`index.html`):**
New `@media(orientation:portrait) and (min-width:700px)` query placed after tablet landscape queries so it wins on wide iPads (Pro 12.9" at 1024px portrait). Uses CSS Grid on `.sim-main` with `display:contents` on `.sim-content` to place chart and history as independent grid items: chart fills top half (`grid-column:1/-1;grid-row:1`), drug panel (250px) and history panel share the bottom half side by side. Content tabs hidden, both panels always visible.

**Chart label pills (`js/ui/chart.js`):**
Replaced rectangular right-margin text labels with compact pill badges drawn by the `targetCeLabel` afterDraw plugin. Each pill: `ctx.roundRect` with full pill radius, white bold 10px text on coloured background. Target = orange (`COLORS.target`), threshold = amber (`#f59e0b`), steady-state = green (`rgba(34,197,94,0.9)`). Positioned fully inside chart area at `ca.right - pillW - 2`. Chart right padding reduced from 65px to 5px — reclaims ~60px of chart width.

**Nomogram band labels (`js/ui/chart.js`):**
Repositioned from `position:{x:'end'}` to `position:{x:'end'}, xAdjust:-36` — fixed pixel offset from right edge sits flush with the Ce pills regardless of screen width.

**Chart controls (`index.html`):**
Switched from vertical column to horizontal row (`flex-direction:row`, gap 6px). Reordered: Reset → Tooltips → Expand. Positioned at `right:4px` to overlap chart fully.

**Keypad modal responsive (`index.html`):**
Portrait phones: keypad layout stacks vertically (`flex-direction:column`), numpad goes full-width. Modal padding reduced (14px), display font 24px, key font 16px. Event editor gets `max-height:90vh;overflow-y:auto`. Landscape phones: tighter padding (12px), key font 15px.

**Bottom screen padding (`index.html`):**
6px body bottom padding for rounded phone screen corners. `viewport-fit=cover` was tested but added excessive top inset (~59px on Dynamic Island) — reverted to default `viewport-fit=contain`.

421 tests across 13 suites, all passing.

---

### Session 23 (2026-04-08) — Split TCI target and manual-SS convergence tolerances (v0.5.9)

**Problem.** v0.5.8 introduced a single "Convergence tolerance" slider (90–99%, default 95%) driving both TCI "time to target" and manual-mode "Steady state ≈ X in M:SS". Mathematically clean but clinically wrong: the two modes operate on completely different timescales. TCI delivers a front-loaded plan that reaches target in minutes, so 95% is a reasonable "close enough". A plain constant-rate infusion approaches the asymptote on the slowest compartmental time constant — for propofol τ ≈ 316 min, meaning 950 min to 95%, 730 min to 90%, 220 min even to 50%. With the shared 95% default the manual-SS countdown showed 15+ hours, which is useless.

**Fix.** Split the setting. TCI slider keeps the tight 90–99% range at 95% default. Manual-SS gets its own 50–95% slider at 50% default (5% steps). Both live in the same `tci-warn-settings` localStorage blob under new keys `tciFraction` and `ssFraction`.

- **`js/ui/warnings.js`** — `DEFAULTS` now has `tciFraction: 0.95` and `ssFraction: 0.50`. `getSettings()` validates each against its own range (TCI: 0.90–0.99, SS: 0.50–0.95) and includes inline migration: if a legacy v0.5.8 blob is detected (no `tciFraction`, `ssFraction` in the old tight 0.90–0.99 range), the stored value is re-homed to `tciFraction` and `ssFraction` is reset to the new default. `setSettings()` persists both fields.
- **`index.html`** — the single "Convergence tolerance" row was replaced with two rows: "TCI target tolerance (% of target)" (`set-tci-fraction`, 90–99, step 1) and "Infusion steady-state tolerance (% of asymptote)" (`set-ss-fraction`, 50–95, step 5). The SS slider uses 5% steps because integer-percent granularity has no clinical meaning in a range that already spans half a magnitude of equilibration time.
- **`js/app.js`** — `initSettings()` wires both sliders, populates from `savedSettings.tciFraction/ssFraction`, and passes both values through `warnings.setSettings(...)` in `saveAll()`. `drugPanel.init(...)` receives two independent callbacks: `getTciFraction` and `getSsFraction`.
- **`js/ui/drug-panel.js`** — module-scope `getTciFraction` / `getSsFraction` getters with independent defaults (0.95 / 0.50). `init(opts)` accepts both. `_approachCache` now tracks both `ssFraction` and `tciFraction` so slider changes on either invalidate the cache within one rAF frame. `computeApproachData(...)` signature takes both fractions; the main TCI branch, the "already at target" guard, and the "TCI paused, Ce above target" decay branch all use `tciFraction`, while the manual-mode SS branch passes `ssFraction` straight to `model.predictSteadyState`.
- **Label display unchanged** — the manual-SS label still shows the true asymptote `ssCeAsymptote`, not `fraction * asymp`. When fraction = 50%, a 3.0 mcg/mL propofol asymptote displays as "Steady state ≈ 3.0 in M:SS"; the countdown ends when Ce reaches 1.5, but the displayed 3.0 is still a clinically useful anchor for where Ce is heading.
- **No predictor/facade/test changes** — `js/pk/steady-state-predictor.js` and `js/sim/simulation.js` take `fraction` as an opaque parameter and have no knowledge of what it represents. `tests/test-steady-state-predictor.js` exercises the predictor with a range of fractions (0.50 through 0.99 across existing assertions) and all 39 cases still pass.

**Effect on manual propofol.** At the new 50% default, "Steady state ≈ 3.2 in M:SS" for a typical maintenance rate lands around 3.5 h — still not fast, but inside the "useful planning horizon" clinicians actually care about. Users who want tighter can slide up toward 95%. The displayed asymptote value doesn't change with the slider, only the countdown does.

**TCI users see no change.** TCI slider and default are identical to v0.5.8. The SS slider has no effect on TCI countdowns.

398 tests across 13 suites, all passing.

---

### Session 22 (2026-04-08) — Steady-state predictor & unified convergence tolerance (v0.5.8)

**Problem.** The manual-mode "Steady state ≈ X in M:SS" label used a drift-scan heuristic (`_scanSteadyState` in `js/ui/drug-panel.js`) that walked the precomputed chart curve looking for a window where Ce drifted less than a hardcoded per-drug absolute threshold (`SS_DRIFT_BY_DRUG = { propofol: 0.1, fentanyl: 0.0001, remifentanil: 0.0001, ketamine: 0.005 }`). Three structural issues:
1. Arbitrary drug-dependent thresholds; ng-scale drugs latched at the first sample as "steady state ≈ 0.0".
2. The reported `ssCe` was "Ce at the first stable-ish window point", not a defined fraction of the true equilibrium.
3. Scan was clipped to the 120-min chart curve — propofol's slow V3 (τ ≈ 316 min at standard covariates) meant the curve often never contained a genuinely stable window.

TCI had the same root-cause disease in a parallel function: `_estimateTimeToTarget` used a hardcoded `0.05 mcg/mL` absolute tolerance. Fine for propofol at 3 mcg/mL (≈1.67%), latent-broken for any ng-scale TCI (fentanyl target 3 ng/mL vs 50 ng/mL tolerance = 1667%, so the first curve sample would latch as "at target" the moment TCI was extended to a non-propofol drug).

**Fix.** A single user-selectable convergence fraction (0.9–0.99, default 0.95) defines a symmetric relative tolerance band `|Ce − target| / target ≤ (1 − fraction)`. One slider drives both labels.

- **`js/pk/steady-state-predictor.js` (NEW).** Mirrors `decay-predictor.js`. Given engine, start-state, rate, and fraction:
  1. Save engine state (try/finally).
  2. Compute `ssCeAsymptote` by advancing with horizon doubling (60 → 120 → … up to ~30 h cumulatively) until successive Ce samples agree within 1e-6 relative.
  3. If starting Ce is already inside the `(1 − fraction) * asymptote` band, return `timeToSsMin: 0`.
  4. Forward-scan at 0.5-min resolution up to 2880 min (48 h — enough for 99% with propofol's slow V3), recording the greatest index where Ce was still outside the band. Return `(lastOutside + 1) * 0.5`. This is "first time after which Ce stays inside the band for the remainder of the scan", which survives post-bolus transient overshoots (Ce rising to catch a declining Cp) and arbitrary starting states (above, below, or oscillating through the asymptote). The 4-compartment linear system with negative real eigenvalues guarantees that once Ce enters the band it never leaves.
  5. Restore engine state in finally.
- **`js/sim/simulation.js`.** New `predictSteadyState(drugId, time, rate, fraction)` facade — pulls the engine and state at `time` out of the event list, calls the predictor, then `replayDrug` as a defensive state reset (same pattern as `predictTrough`).
- **`js/ui/drug-panel.js`.** `_scanSteadyState`, `SS_DRIFT_BY_DRUG`, `SS_DRIFT_DEFAULT`, `SS_WINDOW_MIN` deleted. The `manual && rate > 0` branch now calls `model.predictSteadyState(drugId, t, rate, fraction)` directly (no curve needed). `_estimateTimeToTarget` signature gains a `fraction` parameter and uses `(1 − fraction) * ceTarget` as a relative band on both approach directions; exported for tests. The TCI "already at target" guard now uses `Math.abs(Ce − ceTarget) / ceTarget ≤ (1 − fraction)` instead of `< 0.05`. The `_approachCache` tracks `ssFraction` so slider changes invalidate the cache and trigger a recompute on the next frame. Non-selected drugs in manual mode no longer need a per-drug PK curve (saves one `computeCurve` call per rescan).
- **`js/ui/warnings.js`.** Added `ssFraction: 0.95` to `DEFAULTS`, validated in `getSettings()` (accepts 0.9–0.99), persisted via `setSettings()` through the existing `tci-warn-settings` localStorage key — no new storage key.
- **`index.html` + `js/app.js`.** New "Convergence tolerance (% of target / asymptote)" slider in the settings modal, range 90–99, step 1, default 95. `app.js:initSettings()` wires it; `drugPanel.init(...)` receives a `getSsFraction` callback.
- **`tests/test-steady-state-predictor.js` (NEW).** 39 assertions across 15 test blocks: asymptote accuracy vs 96-h reference (< 0.01% relative error), fraction monotonicity (`t(0.90) < t(0.95) < t(0.99)`), drug independence (fentanyl, ketamine) with no per-drug magic numbers, state restoration (byte-identical before/after), approach from above (rate lowered from a settled high state), post-bolus overshoot (Ce rises past asymptote on the way up, then settles), already-inside-band short-circuit, tolerance symmetry, and 4 TCI-tolerance tests (default 95%, fentanyl-scale non-latching, approach from above, fraction monotonicity for TCI).

**Why the same fraction drives both TCI and SS labels.** Clinicians reason about "within X% of target/asymptote" the same way across modes and drugs. One slider is less clutter than two and matches the clinical mental model. At the 95% default, propofol TCI's effective tolerance becomes ±0.15 mcg/mL (up from ±0.05), slightly looser than previous; users who want tighter can set 99% (±0.03 mcg/mL, tighter than previous).

**Asymptote math.** For propofol under standard covariates, the Eleveld-model slow-compartment time constant is τ ≈ 316 min. Time to reach 95% of the asymptote from zero ≈ 3τ ≈ 950 min; to reach 99%, ≈ 4.6τ ≈ 1460 min. The predictor's 48-h scan horizon comfortably covers both. The horizon-doubling asymptote search runs cumulatively up to ~30 h which puts Ce within floating-point precision of the true asymptote.

398 tests across 13 suites, all passing.

---

### Session 21 (2026-04-07) — UI Polish: Drug Cards, TCI Modals, Chart Controls (v0.5.7)

**Bug fix — `editEvent` bolus sync (`js/sim/events.js`):**
When editing a fentanyl (or any) bolus in planning mode, the associated `source:'system'` rate-restore event at the old bolus-end time was not being relocated to the new end time. `getConcentrationsAt` replayed with a rate-restore at the wrong time, producing a wildly wrong predicted curve. Fix: `editEvent` now captures `oldBolusEnd` before any mutation, recomputes `newBolusEnd` after, and moves the rate-restore event using tolerance-based time matching (< 0.001 min) consistent with the rest of the codebase.

**Drug card rendering unification (`js/ui/drug-panel.js`):**
Replaced the two-path `update()` function (separate non-selected loop + selected block) with a single loop over all drugs. Every card — selected or not — now renders Ce/Cp, status, rate, approach line, and step-bar each frame. Eliminated stale values on non-selected cards and made the code easier to audit. Per-drug `_approachCache` dict (keyed by drugId) replaces the old single `_approachCache`; non-selected TCI/manual drugs compute their own PK curve lazily when rescan is triggered.

**Drug card status indicators (`index.html`, `js/ui/drug-panel.js`, `js/ui/warnings.js`):**
- *Left border*: always-present 4px strip, muted (25% opacity) when inactive, bright when selected. Yellow (`#eab308`) for hypnotics (propofol/ketamine), blue (`#3b82f6`) for narcotics (fentanyl/remifentanil). CSS custom properties `--drug-color` / `--drug-color-muted` scoped per drug ID.
- *Right indicator* (`::after` pseudo-element): 3px strip. Green = running OK; amber = next event within warn window; red = pump paused/stopped or intermittent Ce below threshold.
- *Active card `::before` arrow*: CSS triangle at the inner edge of the left border, forming a `>` pointer shape.
- *Warn window*: user-configurable 1–10 min slider in Warning Settings modal (`statusWarnMinutes`, default 2 min, persisted to localStorage).

**TCI delay modal unit fix (`js/app.js`):**
`showTciDelayModal()` previously always displayed `Ce = X.X µg/mL` in canonical units — useless for fentanyl (target of 4 ng/mL showed as `Ce = 0.0 µg/mL`). Now converts via `fromCanonical` to the drug's allowed display units using `getAllowedUnits`/`formatValue`.

**TCI first-step modal multi-unit display (`js/app.js`, `index.html`):**
`showTciFirstStepModal()` previously hardcoded unit conversions (mcg/kg + mL for bolus; mL/hr for rate). Replaced with `buildActionHtml()` using `getDefaultUnit`/`getAllowedUnits`/`fromCanonical`/`formatValue` — primary unit large, all other allowed units smaller below it (`.tci-fs-secondary` span). Drug-specific: propofol shows `mg / mcg/kg · mL`, fentanyl shows `mcg/kg/min · mcg/h · mL/h`, etc.

**TCI countdown chime (`js/app.js`):**
`showTciFirstStepModal` tick now fires `playAlert('info')` once when `remainingMs ≤ 0` ("Now!"). One-shot guard prevents repeated firing on subsequent ticks.

**Redose chime redesign (`js/ui/alert-sound.js`, `js/ui/warnings.js`):**
Added `redose` pattern: two quick 880 Hz beeps (100ms each, 50ms gap) — more distinctive than the previous single `info` beep. `checkBelowThreshold()` now calls `playAlert('redose')`.

**Drug card font size (`index.html`):**
Active card renders `.drug-name` and `.ce-current` visibly larger than inactive cards at every breakpoint (e.g. drug-name 13→17px, Ce 22→27px at base). No layout shift — font size only.

**Chart controls restyle (`index.html`):**
Moved from small muted top-right row to a vertical column at top-right, fully visible at rest. Reordered top-to-bottom: Expand (zoom) → Tooltip → Reset. 34→38px buttons, 16→18px icons, gap 5→10px. Removed opacity muting; replaced with colour+background hover transitions.

359 tests across 12 suites, all passing.

---

### Session 20 (2026-04-06) — Responsive Tablet Layout & UI Polish (v0.5.6)

Added `@media(min-width:1020px)` breakpoint (iPad 10th gen / iPad mini 7th gen and larger). At ≥1020px: `.sim-content` switches to `flex-direction:row`, both chart and history panels shown side-by-side (chart `flex:2`, history `flex:1`), tab buttons hidden via CSS. New `⤢/⤡` expand button toggles `.chart-expanded` to hide history and fill chart width. `@media(min-width:1200px)` added for iPad Air/Pro. Drug panel width 210→250→285px; Ce font 22→26→30px; topbar 34→42px.

Font sizes enlarged throughout: `drug-name` 12→13px, approach 9.5→10.5px, status/rate 10→11px, countdown 9→10px. Step-bar countdown `text-align:right`. Step-bar below-threshold: `.step-bar-wrap.step-bar-below` red; non-selected path `barPct` fixed 100→0. History two-line layout (type first line, bold value second). IV push delivery time corrected (`pushDeliveryMinutes`). History timestamp color promoted.

359 tests across 12 suites, all passing.

---

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

### Interim — Restore Bug Fix (v0.5.5)

*Between Sessions 19 and 20. Not tracked in session numbering.*

**Root cause:** The audit session moved `genId` inside `createEventList()` for instance-scoped ID counters. But `createEvent` — a module-level function — still called `genId()`. In the browser, every `addBolus`/`addRate`/`addPause` threw `ReferenceError: genId is not defined`. The restore try-catch caught this silently.

**Why tests passed:** Every test file inlines its own `genId`/`createEventList` copy rather than importing from `events.js`.

**Fix:** Moved `createEvent` inside the factory closure immediately after `genId`. Removed now-inaccessible `export { createEvent }`. No external callers existed.

359 tests across 12 suites, all passing.

---

### Interim — Audit Remediation (v0.5.4)

*Between Sessions 18 and 19. Not tracked in session numbering.*

External code audit reviewed and independently verified against source. Four audit claims were false positives (file not truncated, Ce-boost engine correctly restored, CET small-deficit path intentional design, units.js `checkAllowed` not bypassed). The following issues were confirmed and fixed:

**`onPumpPause` targeted wrong drug (`js/app.js`):**
`model.addPause(model.primaryDrug, ...)` hardcoded to `'propofol'`. If a fentanyl or ketamine card was selected and Pump Stopped was pressed, the pause was silently applied to propofol. Fixed: `selectedDrug` (already used two lines below for `clearAfter`).

**IV push duration fixed to 10 s regardless of volume (`js/sim/events.js`):**
`PUSH_DURATION = 10/60` applied to all push boluses. For 0.5–2 mL fentanyl/ketamine boluses (typical intermittent mode), 10 s is actually *slower* than pump bolus delivery (2–10 s at 750 mL/h). Replaced with volume-derived duration at `PUSH_RATE_MLH = 3600` mL/h (1 mL/s rapid push), 1-second minimum. Gives: 0.5 mL → 1 s, 1 mL → 1 s, 2 mL → 2 s, 5 mL propofol → 5 s.

**`_nextId` module-scoped across all EventList instances (`js/sim/events.js`):**
`let _nextId = 1` was declared at module level; `clearAll()` on any instance reset the counter for all instances. Moved inside `createEventList()` factory so each instance has its own counter and `clearAll()` resets only that instance.

**`planTCIFromEvents` called non-existent method (`js/sim/tci-planner.js`):**
Called `eventList.getLastExecutedState()` which does not exist. Renamed to `eventList.getStateAtLastEvent()` (the actual exported method). Function was not reachable from any call site so no runtime impact, but a latent error.

**`setPumpSettings` fragile maxRate computation (`js/util/constants.js`):**
When both `concentration` and `bolusRateMlH` were updated together, the first block computed `maxRate` with a stale rate before the second block wrote `bolusRateMlH`. Final value was correct (second block overwrote), but intermediate state was wrong. Refactored: both fields written first, `maxRate` computed once from `getPumpSettings()`.

**`addAnnotation` used innerHTML for description text (`js/app.js`):**
Both render sites (live + case-restore) injected text via template-literal `innerHTML`. Annotations are currently system-generated strings only (no user input path), so XSS risk is theoretical. Fixed anyway: description span populated via `textContent`.

**`getActiveRateForDrug` parameter renamed (`js/sim/events.js`):**
`beforeIdx` renamed to `beforeGlobalIdx` to clarify it is a global event-array index, not a drug-scoped index.

**`e_udf` decay ceiling extended 3600 → 21600 s (`js/sim/simtiva-reference.js`):**
The iterative trial-dose peak-finder in `planTCISchemeEmulation` was clamped to 3600 entries. For drugs with very slow ke0, the Ce peak beyond 3600 s would produce an undersized bolus. Extended to 21600 s (6 hours) to match `p_udf`. No impact on propofol (peak < 60 s).

**Ketamine y-axis default raised (`js/app.js`):**
`yDefault: 2000` ng/mL (= 2 mcg/mL) clipped induction-dose curves. Changed to `10000` ng/mL (10 mcg/mL), covering 3000–8000 ng/mL induction range.

**Remifentanil persistence deferred:** Remifentanil is a stub (not yet clinically implemented); adding it to persistence loops is premature. To be addressed when remifentanil is fully implemented.

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
