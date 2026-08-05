# Changelog

## Versioning Scheme

| Format | Meaning |
|--------|---------|
| `1.0` | Reserved for public release |
| `0.x` | Major updates — new features, architectural changes |
| `0.x.x` | Minor updates — incremental improvements, additions |
| `0.x.x.x` | Bug fixes |

---

## [0.6.1.1] — 2026-08-05

Planning mode, second test round: crossover labels made optional, drag handle moved off the curve, and a first-time threshold now draws its dots.

- **Crossover time labels are now opt-in and off by default.** They answer a real question but add a lot of ink to a chart that already carries four bands, two threshold lines and a cursor. Settings → Appearance → *Label crossover dots with the crossing time*. The dots themselves are unchanged — only the label is behind the toggle.
- **The drag handle no longer sits on the point it controls.** A 44×56 touch target — and a finger — parked on the proposal's peak covered exactly the part being judged. The handle now rides the **left edge** of the plot at the same height, with a dashed tie-line out to a small marker at the anchor, so the connection stays legible while the curve stays visible. Left rather than right because the right edge carries the target/threshold label pills, which a threshold handle would share a y with exactly; the 46 px inset clears the y-axis drag zone.
- **Setting a threshold for the first time now renders its crossover dots.** The dots sit on the "Ce if stopped" decay trajectory, which `chart-bridge` builds from **committed** mode state — zero while a threshold is being set for the first time, so no trajectory was drawn and the dots had nothing to sit on. Editing an *existing* threshold happened to work only because the old value was still non-zero. Planning mode now publishes the value being previewed for the trajectory to use, and releases it on exit. Verified: trajectory length 0 → 101 points while previewing a first emergence Ce of 1.5 µg/mL.

Changed: `js/ui/chart/plugins/plan-handle.js`, `js/ui/chart/plugins/crossover-dots.js`, `js/app/chart-bridge.js` (`setPlanThresholds`), `js/app/planning.js`, `js/ui/chart/index.js` (`setCrossoverLabels`), `js/ui/settings.js`, `js/app/settings-ui.js`, `index.html`. Suite 1065 → 1069.

---

## [0.6.1] — 2026-08-05

Planning mode, from first test notes: layout fixes at phone sizes, a genuinely smooth drag, crossover dots on the proposal, plan step markers, and per-drug Ce titration steps.

- **Phone landscape had no chart.** The split switched on `max-width: 860px`, which catches a phone in landscape — wide, but only ~390 px tall. Stacking it there left the chart **75 px**. The breakpoints now switch on **orientation**, never width: landscape stays side by side and buys chart width by compacting the entry column; portrait stacks. Height is the scarce axis in landscape, width the scarce one in portrait, and each layout now spends the axis it has.
- **Portrait gave the chart less than half the screen** — 387 px against the entry's 405 px, because the keypad's intrinsic height won. The chart now holds a floor of 52 vh (50 vh on narrow phones) and the entry column shrinks and scrolls instead of pushing it down. Measured after: **480 px chart against 257 px entry** on a 390×844 phone, 865 against 261 on iPad portrait.
- **The drag now redraws every frame.** Two things were fighting it: a 40 ms throttle that capped updates at 25 Hz, and — worse — `setCanonical` firing the 180 ms keystroke debounce, which restarted on every drag frame, so the curve did not move at all until the finger stopped. Drag updates now coalesce on `requestAnimationFrame` and bypass the debounce entirely. The throttle was pure pessimism: a back-solve is **~2.7 ms** warm-seeded from the previous frame's answer (~4 clones), plus ~1.1 ms to reproject. Measured over a 400 ms drag: **29 distinct curve redraws**, against zero before.
- **Crossover dots now appear on the proposed curve**, marking where it descends through the redose and emergence thresholds — the same amber/red dots the committed trajectory already had.
- **Crossover dots are now labelled with the crossing time**, in whatever units the x-axis is showing (minutes, h:mm, or clock time). A dot says the drug gets there; the label says when, which is the number being planned around. Foreground only — labelling every background drug's dots would crowd the plot.
- **A proposed TCI plan now shows its rate-step markers.** The scheme a retarget generates lives on the preview clone, so nothing on the chart could read it and the plan being chosen drew as a bare curve. Preview markers render against the proposal and ignore the ⚑ toggle, since seeing the scheme *is* the reason to preview a target. Steps that predate the projection are excluded — they have no curve to sit on.
- **Ce titration is per-drug now.** Fentanyl thresholds jumped in 0.1 ng/mL steps — most of the drug's clinical range in one press — because `ng/mL` carries one decimal, which is right for ketamine at 800 ng/mL and useless below 1. Ce steps are now declared per drug (**propofol 0.1 µg/mL, fentanyl 0.05 ng/mL, ketamine 10 ng/mL**) and the displayed precision follows the step rather than the unit. Fentanyl now steps 1.00 → 1.05 → 1.10 and drags continuously at 0.01.

Changed: `index.html` (planning breakpoints), `js/app/planning.js`, `js/ui/chart/plugins/crossover-dots.js`, `js/ui/chart/plugins/event-markers.js`, `js/ui/chart/index.js`, `js/ui/keypad.js`, `js/util/units.js` (`decimalsForStep`, `formatValueStep`), `js/util/constants.js` (ceTarget `quantSteps`). New `js/ui/chart/time-format.js` — the axis formatters, extracted so plugins can label times the way the axis does without importing `chart/index.js`, which imports them. Suite 1042 → 1065.

---

## [0.6] — 2026-08-05

Feature — **dose planning mode**: see a dose on the chart before you commit it.

- **Dose entry can now be planned rather than guessed.** Until now the loop was commit-then-look: type a number, hit the confirm button, and only then find out what it did. The fast modal is unchanged and still the default, but it gains a **Plan** button that opens a screen splitting the chart against the dose entry surface — drug panel and history hidden — where the projected concentration curve redraws live as you type. The proposal is drawn bright over the committed curve, which dims back to a reference, so the comparison is the point rather than a guess.
- **Three ways to arrive at a number.** Type it; step it with **± buttons** that move along the drug's own quantize grid (so 47 mcg of fentanyl steps to 50, not 48, and press-and-hold repeats); or **drag a handle on the proposal itself** and let the app back-solve the dose that reaches the concentration you dragged to. The handle sits on the dose's own peak for a bolus, at +30 min for a rate, and on the target line for a TCI target — where dragging simply *is* setting the target.
- **Supported for every dose entry**: bolus, manual rate, TCI target, redose threshold and emergence Ce. The two threshold entries move their line live without touching the curve.
- **Confirm commits exactly as the modal would.** The planning screen's Confirm / IV Push / Clear delegate to the modal's own buttons rather than reimplementing them, so the TCI delay modal, the push-vs-pump split, and the last-dose memory all behave identically. **Cancel returns to the modal with the typed value intact.**
- **Optional default.** Settings → Simulation → *Open dose entry in planning mode* sends every supported entry straight there; Cancel remains the way back to quick entry.

Under the hood:

- **Projections run on a throwaway clone of the case, never the live model** (`js/sim/preview.js`). A clone carrying a full TCI plan costs ~0.8 ms, so it is rebuilt on every keystroke rather than mutating and reverting — `addBolus` merges into an in-flight bolus and rewrites its value, so `deleteEvent` was never a safe undo. Verified byte-identical to the source across all three drugs, and the source event list is unchanged after 25 projections, a replan and a back-solve.
- **The projection replays the same mutations the commit path performs**, so what you drag to is what you get: measured agreement with the committed curve is within 5·10⁻¹³ µg/mL. `resolveBolusDeliveryMode()` is now shared between `app.js onConfirm` and the preview so the two cannot disagree about delivery duration.
- **Sampling only uses steps the engine caches.** `engine.getExpm()` caches its matrix exponential for dt ∈ {0.1, 1, 10, 60} min only; the chart's own 10/60 step is not one of them and costs 81 ms for a 12 h curve against 0.79 ms at step 1. The preview samples the first 20 minutes at 0.1 min — fine enough to resolve a bolus peak — then 1 min to the horizon. Bolus and rate projections land at ~2 ms; a TCI target replan is ~25 ms, which is why it gets a longer debounce (260 ms against 180 ms).
- **The back-solve is a bracketed secant search.** Ce is strictly increasing in dose (linear system, non-negative input), so a bracket always exists; secant is tried first and falls back to the bracket midpoint whenever it would step outside. Lands within 0.5% in ≤12 iterations.
- **Layout reuses the analysis screen's approach**: a separate `.screen` with the `.chart-area` node teleported in, keeping the live chart instance, its y-calibration, inspect cursor and gesture bindings. The keypad box is likewise *moved* into the entry column rather than cloned — its digit keys are bound once at boot.
- The y-axis autoscale freezes for the duration of a handle drag, so the proposal's own curve can't grow the axis and slide out from under the finger dragging it.
- Dragging a dose to zero keeps drawing the baseline curve and its handle, so the handle can't be stranded off the bottom of the chart with no way back up.

Fixes found while building this:

- **Selecting a drug with no events could blank the chart.** `setCurveData`'s autoscale computed its maximum from the curve and the target line alone, so a drug with neither — fentanyl or ketamine before their first dose, with no propofol target set — produced `y.max = 0` and an empty plot with no axis ticks. The autoscale is now floored at the drug's default axis maximum, and the plan-preview curve counts toward it so an overshooting proposal stays on screen.

New: `js/sim/preview.js`, `js/app/planning.js`, `js/ui/chart/plugins/plan-handle.js`, `tests/test-planning-preview.js` (63 tests; suite 979 → 1042). `session.js restore()` and the preview clone now share one event-rehydration helper so the two rebuild paths cannot drift.

---

## [0.5.49.1] — 2026-07-30

Fix — background crossover dots now appear only when the decay projection is a real forecast.

- **A running infusion's decay curve is a "what if", not a prediction.** While a background drug is still delivering, its "Ce if stopped now" projection describes a course the drug is not on, so the dot marked a crossing it would never reach. Measured with ketamine infusing at 3 mg/min at t=20: the redose dot sat at y=300 while the drug's own ghost curve was at **761** there, and the emergence dot at y=150 while the curve was at **834** and still climbing — the dots floated hundreds of units below the trace with no line to sit on. The foreground drug avoids this because it draws the dashed `Ce (if stopped)` line, which labels the hypothetical and gives the dot something to sit on; a background drug draws no such line.
- **Background dots are now suppressed unless nothing more is going in** — no infusion running *and* no future rate or bolus events queued. A drug paused with an upcoming TCI step still isn't going to follow the decay curve, so it is excluded too. That test is exactly the condition under which the drug's own ghost Ce curve descends through the threshold, so a dot that does draw always sits on a visible line: verified at **gap = 0** between the dot and the ghost curve, against gaps of 461 and 684 before.
- **The foreground is deliberately unchanged.** Its dots still show whatever the pump is doing, because the labelled `Ce (if stopped)` trajectory already declares them as a projection.
- **Side benefit: the feature got cheaper.** The guard sits ahead of `computeDecayTrajectory`, so a running background drug — the common case — now costs zero decay simulations instead of one per update.

Changed in `updateGhostCrossings()` in `js/app/chart-bridge.js`. No change to the chart, the plugin, or the state.

## [0.5.49] — 2026-07-30

Feature — background drugs now show ghosted crossover dots on the chart.

- **Background drugs get crossover dots for the first time.** The dots marking where the "Ce if stopped now" trend line crosses a threshold — amber at redose, red at emergence — previously existed only for the selected drug: the plugin read a single `emergence-traj` dataset, took its thresholds from the `s.thresholdCe` / `s.exitCe` scalars, and positioned dots against the foreground `y` scale, all of which the bridge populates for the selected drug alone. Every non-selected drug now gets the same two dots, rendered as ghosts.
- **Ghost styling:** amber/red fill preserved so the threshold meaning survives, drawn at `ghostOpacity`, with the white ring replaced by the drug's own `DRUG_DEFS` colour. A background drug draws no threshold line, so that ring is the only cue for which drug a dot belongs to.
- **Gated on the `∿` ghost-traces toggle**, the same switch that reveals the background Ce curves — a dot with no curve and no threshold line beneath it would be meaningless. With the toggle off (the default) the feature also does no work at all: the bridge returns before computing anything.
- **Each drug's dots sit on its own hidden `yGhost_<drugId>` axis**, not the foreground scale. This matters: with propofol foreground (axis max 20) and ketamine background (max 10000, `yScale` 1000), the same threshold maps to y-pixel 662 on the correct axis versus −4159 on the foreground one — i.e. far off-canvas, where the dot would silently never draw.
- **Cost is contained.** Each background drug needs a full decay simulation, so the per-frame path is throttled to the same 2 s cadence the history dimming already uses (the timer ticks at 500 ms), and `refresh()` also recomputes immediately so a dosing edit moves the dots at once rather than up to 2 s later. The trajectory is sampled at a coarse 1-minute step instead of the default 0.25 — it is never drawn, only interpolated for a crossing, so the finer sampling would be 4× the engine work and array size for no visible gain (52 points instead of ~208 in testing).

New `setGhostCrossings` setter in `js/ui/chart/index.js` (idempotent per drug, like `setGhostTraces`), new `ghostCrossings` state in `js/ui/chart/state.js`, `updateGhostCrossings()` in `js/app/chart-bridge.js`, and a background pass in `js/ui/chart/plugins/crossover-dots.js`.

## [0.5.48.3] — 2026-07-30

Fix — the `TCI` / `AUTO` / `MAN` chip text now sits vertically centred in its pill.

- **The chip text hugged the top of its box.** Measured in the live panel at base scale, a 13.7px chip had 1.85px above the glyphs and 4.84px below. The cause is font metrics, not a stray padding value: DM Mono reports `capHeight` identical to its full ascent (0.778em) with 0.333em of descender space below, so all-caps chip text — `TCI`, `AUTO`, `MAN` all lack descenders — touches the top of the ascent box and leaves the whole descender gap empty underneath. The chip compounded it by inheriting `line-height:1.3` from `.h-type` and using symmetric `padding:1px 4px`, which cannot compensate.
- **Fixed with `line-height:1` and asymmetric em padding** (`.36em .45em .16em`). The 0.20em extra on top pushes the caps back to optical centre; `line-height:1` stops the box depending on `.h-type`; and em units mean the correction tracks `font-size:0.9em` across all four text scales instead of drifting. Worst-case off-centre drops from **1.49px to 0.68px**, and is now consistent across scales rather than oscillating.
- A fixed-pixel correction was tried first and rejected: because the inherited `1.3 × font-size` line height rounds differently per scale, the error oscillates (1.49 / 0.99 / 0.50 / 1.49px at base / `text-lg` / `text-xl` / `text-xxl`), so `padding:2px 4px 0` fixes base and `text-xxl` but *worsens* `text-xl`. The 0.20em difference was chosen by sweeping against measured error at every scale — it also beats the theoretically exact 0.333em, which is perfect at base but 1.44px out at `text-xl` once em padding rounds to device pixels.
- Horizontal padding moves `4px` → `.45em` — 4.05px at base, unchanged in practice, but now proportional at the larger text scales. Verified this introduces no new label wrapping at any panel width or scale.

Changed in the `.h-badge` rule in `index.html`. No JS change.

## [0.5.48.2] — 2026-07-30

Fixes — history labels no longer wrap, and the bolus violet is legible against its neighbours.

- **Row labels are shortened so they fit on one line.** Adding the `MAN`/`AUTO` chips in v0.5.48.1 pushed the label past the available width: the history panel is `flex:1` of the content area with `min-width:200px`, so on a tablet it commonly sits at 200–240px. Measured in the real panel, `AUTO Rate Resumed` and `MAN Pump Stopped` both wrapped to two lines at 200–220px, and `MAN Pump Bolus` wrapped at 200px. Labels are now **BOLUS / IV PUSH / RATE / RESUMED / STOPPED / PAUSED** — all fit on one line at every panel width. Nothing is lost: the chip and the category colour already said "pump", and `BOLUS` vs `IV PUSH` still distinguishes the delivery mode. These are display strings only — the `annotation` values the event layer keys on (`'Rate restored after bolus'`) are untouched.
- **The bolus violet is brighter in dark theme.** `--purple` (`#8b5cf6`) is noticeably less luminous than the cyan rate rows and red stop rows beside it, so the bolus category read as recessed. Bolus rows now use a new `--purple-bright` token — `#a78bfa` in dark theme, and deliberately the same `#7c3aed` in light theme, where the darker violet already is the correct ink on a white card.
- `--purple` itself is unchanged. It is used as a **fill** under white text (`.btn-ctrl-rate.active-mode`, `.modal-btn-confirm-rate`, the manual-mode indicator), so brightening it would have destroyed that contrast. The history rows need violet as **ink**, which is a separate requirement — hence the separate token, following the existing `--blue` / `--blue-dim` precedent.

Changed in `js/ui/history.js` (`buildEventRow`) and the theme tokens plus history CSS in `index.html`.

## [0.5.48.1] — 2026-07-30

Tweak — every history row now names its source, and the category colour reaches the label text.

- **Manual events carry a `MAN` chip.** v0.5.48 left manual as the unmarked baseline, which meant the label column didn't align across rows and the one source the user is personally responsible for was the only one not stated. `MAN` is outlined slate — deliberately quiet, so it aligns the column without competing with the filled `TCI` chip, and adds no new hue. All three chips now read as a family: `TCI` filled (a plan step), `AUTO` outlined cyan (machine-derived), `MAN` outlined slate (a human acted).
- **The category colour extends from the stripe into the label text.** `PUMP BOLUS` is violet, `RATE` cyan, `PUMP STOPPED` red, `NOTE` amber — so the category survives when the 3px stripe is at the edge of vision on a narrow panel. Notation rows already did this; the other types just stop being the exception.
- **The value line is deliberately *not* coloured.** The dose/rate readout stays `--text-primary` at full contrast. Tinting it was mocked up and rejected: it cost contrast on the one number you read precisely, and the loss was worse in light theme.
- **A TCI scheduled hold joins the red family.** `PAUSED` was cyan (rate family) while `PUMP STOPPED` was red, even though both mean no drug is flowing. Red now carries exactly one meaning — *not delivering* — and the `TCI` chip is what distinguishes a planned hold from a user-initiated stop.
- Chips nest inside the label, so each sets its own `color` explicitly rather than inheriting the category colour. That is what keeps `MAN` slate on a red `PUMP STOPPED` row, and it pins the `currentColor` outline the two outlined chips draw with.

Changed in `js/ui/history.js` (`sourceBadge`) and the history CSS block in `index.html`.

## [0.5.48] — 2026-07-30

Readability — the history log no longer fades any category of event.

- **Auto rate-restore rows are legible again.** The post-bolus "rate restored" event was rendered at `opacity:.35` in italic with its colour stripe stripped, which made the one row that explains *why the pump went back to its old rate* the hardest row in the list to read — and near-invisible in light theme. It now renders at full text contrast with its cyan rate stripe intact, labelled **Rate Resumed** (the `↩` prefix is gone), and recedes by **surface** instead of by ink: the card fill drops to a 1px hairline outline so the row still reads as derived rather than commanded.
- **Pump stops are no longer greyed out.** `Pump Stopped` carried a `--text-muted` slate stripe that read as *disabled*. It now takes a red stripe — stopping the pump is a real clinical action, not a de-emphasised one.
- **One meaning per visual channel.** The scheme is now: left-border colour = what the event is (bolus violet, rate cyan, TCI hold cyan, stop red, note amber); badge chip = who commanded it; row surface = commanded vs. derived. Opacity is reserved for a single job — past vs. future.
- **A new outlined `AUTO` chip** marks system-generated events, alongside the existing filled `TCI` chip. A manual event still carries no chip: it is the unmarked baseline. Chips are now sized in `em` so they track the label across all four text scales instead of staying pinned at 9px.
- **TCI scheduled holds are distinguishable from rate changes.** A TCI zero-rate step gets its own `h-evt-hold` category class rather than sharing one with real rate commands.
- **Label line contrast raised.** The event label was `--text-muted` on the card background; it is now `--text-secondary`, uppercase and letter-spaced across all row types. Notation labels lose their italic (an italic is a dimming-adjacent affordance) and pick up the amber of their stripe.
- **Theme fixes.** The bolus stripe was a hardcoded `#6d28d9`, a near-black violet on a white card in light theme; it now uses `var(--purple)`, which has a light-theme value. Two rules also referenced `var(--border)`, a variable defined in neither `:root` block — the notation delete button's border and the ET/RT separator now use `var(--border-subtle)`.

Changed in `js/ui/history.js` and the history CSS block in `index.html`.

## [0.5.47.1] — 2026-07-21

Bug fix — the redose-threshold crossover dot now shows when only the redose threshold is set.

- **The orange redose crossover dot no longer requires an emergence threshold.** The chart's "Ce if stopped now" trend line — which the crossover-dots plugin reads to place its dots — was only computed when an emergence (exit) threshold was set, so with only a redose threshold there was no trend line and thus no orange dot. The decay projection is now aimed at the **lowest set threshold** (redose or emergence), so the trend line appears whenever either threshold is set and current Ce is above it, and it descends far enough to cross both lines. Redose-only cases now show the orange dot; emergence-only and both-set cases are unchanged. Fixed in `js/app/chart-bridge.js`.

## [0.5.47] — 2026-07-21

Feature — the history log's time format now follows the chart x-axis time scale.

- **The history ET/RT toggle and the chart x-axis time scale are now one setting.** Previously the history log's elapsed-vs-real-time toggle was a separate, session-only control that could disagree with the chart axis and reset on every reload. Now both share the persisted `timeAxisMode`: when the chart is in **Real time**, the history rows show clock time; otherwise they show elapsed `h:mm:ss`. Changing the mode from any surface — the history ET/RT button, the on-chart cycle button, or Settings → Appearance — updates all of them together (reflected each frame in `chart-bridge.js onFrame`). The history log keeps its second-level precision; the chart keeps its separate `min` vs `h:min` tick choice, since that only affects axis ticks. Turning real time **off** from the history button restores whatever tick style the chart had before (never forcing `min` or `h:min`). As a side benefit, the history's real-time choice now persists across reloads.

## [0.5.46] — 2026-07-21

Fix + feature — removed stray hover circles from the chart and added an on-chart x-axis time-scale control.

- **Removed the hollow circles that rode the curves.** Chart.js's built-in hover/active-element points were being drawn on every curve at the hovered/clicked x-index — hollow rings (the datasets' fill is a near-transparent tint) that tracked the lines and re-snapped on click. They served no purpose (the tooltip is disabled and the click handler reads the pointer x directly, not the active elements). Suppressed them with `options.elements.point.hoverRadius = 0`. The filled "now" cursor dots, amber inspect dots, and crossover dots are unaffected.
- **On-chart x-axis time-scale button.** The Min / H:Min / Real-time selector (added in 0.5.45) is now also reachable directly from the chart-controls strip: a small button that cycles `min → h:min → real time`. It shares the single `timeAxisMode` setting with the Settings → Appearance segmented control — changing either surface updates the other (the chart button's label is reflected from the setting each frame; the segmented control re-seeds when the Settings modal opens). The chart axis and label update live.

## [0.5.45] — 2026-07-21

Feature — future threshold-crossover highlights on the chart, and a selectable x-axis time scale.

- **Crossover dots on the emergence trajectory.** Where the red dashed "Ce if stopped now" projection crosses a horizontal threshold, the chart now draws a highlight dot so the trainee can read the crossing time at a glance: an **orange dot** where it crosses the redose threshold (amber line) and a **red dot** where it meets the emergence/exit threshold (red line). The dots appear automatically whenever the trend line and the relevant threshold are both present, and clear when the trend line is not shown — no toggle. Implemented as a new `afterDraw` canvas plugin (`js/ui/chart/plugins/crossover-dots.js`) that reads the existing `emergence-traj` dataset and the `thresholdCe`/`exitCe` state, so it self-heals across New Case and needs no per-frame plumbing. Colors read from the `--amber`/`--red` CSS variables to stay theme-aware.
- **Selectable x-axis time scale.** A new Settings → Appearance "Time axis" control switches the chart's x-axis between **Min** (sim minutes, unchanged default), **H:Min** (h:mm), and **Real time** (wall-clock, anchored to the case start time from the timer). The choice persists (inside the settings blob, so it cloud-syncs with other preferences) and updates the axis ticks and title live. Real time falls back to h:min when no case start time is set. The x-axis now uses a dedicated tick formatter; the y-axes are unchanged.

## [0.5.44.13] — 2026-07-15

Bug fix — history action buttons no longer clip the "Edit" button.

- **The events-history action row now fits its panel on narrow landscape tablets.** On split-layout tablets whose history panel is narrow (e.g. iPad mini in landscape), the four action buttons (time toggle, Add Event, notes toggle, Edit) overflowed the panel and the rightmost "Edit" button had its edge cut off. The buttons carried fixed `min-width` floors (68/72/60 px) that inflated the row past the panel width. Removed those floors, trimmed the row's horizontal padding (12 → 8 px) and gap (6 → 4 px), and switched all four buttons to `flex:1 1 auto` so they size to their content and share the remaining space evenly. The row now fits with margin down to the 1020 px split-layout minimum and stays balanced on wide screens. CSS-only.

## [0.5.44.12] — 2026-07-15

Tweak — plateau exit band default lowered to ±2.5%.

- **Default plateau exit band is now ±2.5%** (was ±5%). The tighter default flags a departure from plateau sooner. The "Plateau exit band" slider now moves on a 0.5% grid (step `1` → `0.5`) so ±2.5% is selectable, and its live readout shows one decimal when needed (e.g. `±2.5%`, `±5%`). Updated `DEFAULTS.exitBandPct` and the drug-panel `EXIT_BAND_DEFAULT` fallback to `0.025`. Existing saved settings keep whatever exit band they stored; only the factory default changes.

## [0.5.44.11] — 2026-07-15

Tweak — narrower plateau exit band range.

- **Plateau exit band slider now spans ±1–5%** (was ±2–10%). The Settings → Simulation "Plateau exit band" control's range and the `exitBandPct` validation window were tightened so the exit band can be tuned more finely at the low end and no longer permits the wide ±6–10% settings, which were too loose to flag a genuine departure from plateau. Default remains ±5%. Persisted values outside the new 0.01–0.05 range now snap back to the default on load.

## [0.5.44.10] — 2026-07-12

Bug fix — landscape font inflation (iOS Safari).

- **Text no longer renders oversized in landscape.** On iOS Safari the setup screen (and any wide text block) rendered its fonts noticeably larger in landscape than in portrait — the model description, the "Plan rounds to…" line, and the dropdown values all ballooned once the phone was rotated. Cause: the page never pinned `text-size-adjust`, so WebKit's automatic text-inflation heuristic kicked in and scaled fonts up based on the width of their containing block (which grows in landscape), independent of the authored CSS `font-size`. Added `-webkit-text-size-adjust:100%; text-size-adjust:100%` to the root `html,body` rule (the standard normalize.css fix), which disables the inflation so every viewport renders the authored sizes. Portrait was already close to the authored sizes and is visually unchanged; landscape now matches it. CSS-only, one declaration; no behaviour change.

## [0.5.44.9] — 2026-07-12

Bug fix — Patient Demographics modal (landscape / short viewport).

- **Patient entry panel lays its fields and keypad side by side on short landscape screens.** Previously `.modal-patient-box` had no height cap, and the modal overlay centres its box vertically (`align-items:center`), so on a short landscape viewport (e.g. a phone rotated to landscape) the stacked sex + age/height/weight fields, numeric keypad, and Confirm button together exceeded the viewport height — the header ran off the top and the keypad's bottom row plus the Cancel/Confirm buttons ran off the bottom, with no way to reach them. The fields and keypad now sit in **two columns** (fields left, keypad right — mirroring the shared keypad modal's `keypad-layout`) whenever the viewport is landscape and short (`@media (orientation:landscape) and (max-height:520px)`), so the whole panel fits the short height without scrolling; the header spans the top and Cancel/Confirm span the bottom. The trigger keys off orientation + height rather than width, so it also catches wide phones whose landscape width exceeds the existing 900px phone-landscape breakpoint (the reported device). The narrow-column layout widens the box to 660px (via `.modal-box.modal-patient-box` to out-specify the base `.modal-box{max-width:400px}`) and pins the sex toggle's width (it is `overflow:hidden`, so it would otherwise collapse and clip "Female"). A defensive `max-height:92vh; overflow-y:auto` on the box remains as a last-resort fallback for extremely short viewports. Portrait and tall (e.g. iPad) layouts are unchanged. CSS-only; no JS or behaviour change.

## [0.5.44.8] — 2026-07-10

Bug fix — TCI planner (cet-emulation).

- **Maintenance rates stay on the coarsest readable grid, refining only as needed — in both directions.** Follow-up to the v0.5.44.4 two-tier grid fix. That change dropped straight to a fine (÷10) grid and engaged too early, so the slowly-changing maintenance rates showed fine `.5` decimals during the clinically active 3–8 h window instead of clean coarse numbers. The correction loop now uses a **progressive multi-tier grid**: it tracks the rate on the base display grid (5 mcg/kg/min) and only when that grid starts to *hunt* near steady state does it refine one tier at a time — `5 → 1 → 0.5 → 0.1 mcg/kg/min` (divisors of each unit's own grid, so it generalises to mL/h, mg/min and other drugs). Refinement is triggered by a **genuine direction reversal** on the grid (down-then-up or up-then-down), detected and backtracked one step — *not* by any single up-move. That distinction matters: on a target **decrease** the required rate legitimately rises as the deep compartment releases drug, and the earlier build mistook that ascent for hunting and cascaded straight to fine decimals; the plan now keeps that transient on clean integer rates. The plan never emits a coarse-grid reversal (the extended-case sawtooth) and stays on round 5-grid (then 1-grid) numbers through the active case — e.g. a Ce 3.5–5 induction is ~93–100% on the 5-grid across 3–8 h. Fully adaptive (no steady-state-rate estimate or tuning constant); the intended loading-phase behaviour is unchanged, and it self-re-arms across target changes.

## [0.5.44.5] — 2026-07-09

UI tweak.

- **Restyled the "Add Event" button.** Dropped the leading "+" and stacked the label onto two lines ("Add" over "Event") to match the neighbouring notes button, instead of the previous single-line "+ Add Event". No behaviour change.

## [0.5.44.4] — 2026-07-09

Bug fix — TCI planner (cet-emulation).

- **Extended-case steady-state rate oscillation removed.** On very long cases (well past a realistic case length — ~8–11 h in), the maintenance plan developed a sustained sawtooth: once the slow (V3) compartment saturated, the infusion rate flip-flopped between two adjacent pump-grid values (e.g. 90 ↔ 95 mcg/kg/min) every ~14 min and Ce bounced within its drift band. This is a quantized-actuator limit cycle — the true steady-state rate lands *between* grid points, so re-rounding each maintenance step to the coarse display grid can never settle. The correction loop now switches to a ÷10-finer grid (0.5 mcg/kg/min / 0.1 mL/h / 0.01 mg/min) once per-probe corrections converge below one normal grid step, so the tail settles smoothly onto target instead of hunting. Far-tail Ce amplitude drops ~10–35× (to well under 0.05 µg/mL — visually flat) and tail rate-change markers thin from ~1/14 min to ~1/hour. Clean round grid numbers are preserved through induction and active maintenance; the fix only engages in the saturated tail. Behaviour is unchanged when display-unit rounding is off, and it self-re-arms across target changes (a new target replans with coarse rounding, then re-converges). Worst in mcg/kg/min (the coarsest rate unit); also affected mL/h at 20 mg/mL.

## [0.5.44.3] — 2026-07-09

UI tweak.

- **History notes button label stacks vertically.** The "Show notes" / "Hide notes" toggle now renders the verb over "notes" on two lines (matching the neighbouring "+ Add Event" button) instead of a single line. Behaviour and always-lit styling are unchanged; only the verb ("Show"/"Hide") swaps on toggle.

## [0.5.44.2] — 2026-07-09

Bug fix.

- **Emergence line stays visible while the pump is paused.** The red dashed emergence trajectory (projected Ce decay to the emergence target) used to be gated on a running infusion, so lowering the target — which pauses the pump while Ce coasts down — made the line vanish until the infusion restarted. It's now shown whenever a target is set and current Ce is above it, regardless of pump state (the decay predictor already models "infusion stopped"). The line clears once Ce has decayed to/below the target.

## [0.5.44.1] — 2026-07-08

Three UI fixes.

- **Version status now shows two timestamps.** The setup-screen status line used to read "Last update `<ts>`", where `<ts>` was only the install time of the running version — misread as a "last checked" time. It now surfaces both: "Last update check `<ts>`" (stamped on every completed version poll, persisted under `tcisim:lastCheckedAt`) and "Last version updated `<ts>`" (the existing install timestamp). Background polls now repaint the steady-state line so the check time refreshes without a click.
- **History "Notes" button is always lit and self-labelling.** It previously dimmed when notations were hidden; now it stays full-color and reads "Show notes" / "Hide notes" to convey state through its label rather than brightness.
- **Detail cursor persists across drug switches.** The chart inspect cursor (time-position line + model-state readout) no longer resets when switching drugs — it stays at its current time position and re-renders the newly selected drug's data. It also survives dosing/edits; only toggling inspect off or starting a New Case clears it.

## [0.5.44] — 2026-07-08

Test-suite improvement round 2 — the follow-up items from the 0.5.43 review, plus a written suite guide. All green at 957 assertions (was 894). Test-only; no shipped-code delta.

- **New coverage for previously-untested modules.** `test-util-math` pins `js/util/math.js` (the 4×4 `inv4`/`expm4` behind the engine's matrix-exponential advance) against independent closed forms — diagonal exp = elementwise exp, nilpotent exp = I+N, A·A⁻¹ = I — plus `js/util/color.js` hex/alpha helpers. `test-settings-validation` drives the real `js/ui/settings.js` `getSettings`/`setSettings` clamp-and-validate logic (the guard between an arbitrary stored/cloud-pulled JSON blob and the running app) via a localStorage shim.
- **De-fossilized `test-reaction-delay`** — it inlined a copy of `displayedSecToEvent` "kept in lockstep"; it now imports the real function (renamed `.js` → `.mjs`). Its inline reactionDelaySec clamp mirror moved to `test-settings-validation`, which tests the real `getSettings` clamp instead.
- **`test-integration` now drives the real chain.** It used to inline its own event list + planner + model + PD and test the copies; it now runs the production `createModel().planTCI(… cet-emulation)` and asserts PK/PD curve *shape* (Ce lags Cp, redistribution, rate step-down, BIS range, resolution agreement) — complementing the endpoint-focused `test-tci-plan-fidelity`.
- **Downgraded incidental-timing locks to tolerance windows.** In `test-steady-state-predictor`, exact-integer-minute locks (time-to-95%-SS, plateau entry/exit minute) — which depend on the sampling grid and slope threshold — became tight `nearMin(…, ±)` windows that still catch a real regression but survive benign retuning. Ce_ss *value* locks (analytically cross-checked) and `=== 0`/`=== null` contracts stay exact.
- **Renamed two misnomer files.** `test-sim-v2` → `test-event-driven-sim` (the "v2" rewrite is long gone and the state-machine block was removed in 0.5.43); `test-tci-tolerance-diagnostic` → `test-tci-tolerance-slider` (it's a focused contract test now, not a diagnostic printer).
- **New `tests/README.md`** — a human-readable guide to the suite: how to run it, the five kinds of test (external baselines / clinical-outcome contracts / behavioral invariants / round-trip contracts / engine-mechanics scaffolding), a per-file table of what each guards, the conventions (test real code, independent oracles stay inline, exact-lock vs tolerance-window, production pump config), and how to add a test.

## [0.5.43] — 2026-07-08

Test-suite improvement round — a follow-on to the 0.5.41.x/0.5.42 audit that closed the last gaps and streamlined the suite. All green at 894 assertions (was 842).

- **New `test-tci-plan-fidelity`** — a clinical-outcome baseline that drives the *real production entry point* `createModel().planTCI('propofol', 0, target, { tciMode: 'cet-emulation' })` across a 5-patient × 3-target matrix (young / reference / elderly / obese / light; Ce 2.0 / 3.0 / 4.5). Every other planner test calls the planner function directly and replays with a hand-rolled sampler; none drove the facade layer that reads live pump settings, inserts events, and answers `getConcentrationsAt()` — the exact path behind the on-screen Ce card (and the path where the earlier `maxRate` bug lived). Instead of pinning byte-exact plan fingerprints (which change on any legitimate tuning), it asserts the property clinicians care about — the plan reaches ≥95% of target within 6 min and holds ±5% across 10–120 min, never dipping below the 90% clinical floor — so it survives planner refinement and only reddens on a broken therapeutic result.
- **maxRate faithfulness** — `test-tci-ce-tracking` and `test-tci-tolerance-diagnostic` drove the planner with `maxRate: 200`, but production derives `maxRate = bolusRateMlH × concentration / 60 = 125 mg/min` (the setup screen installs this on every case). Both now use 125.
- **Legacy retired** — `test-sim-v2` lost its "State Machine" / "State Change Callbacks" blocks (13 assertions over an obsolete READY/RUNNING/PAUSED design the stateless production facade never implemented). `test-tci-tolerance-diagnostic` was trimmed from a ~200-line diagnostic printer to its one real contract assertion (the ceTolerance slider reaches the planner), now with a per-plan reach-target sanity check.
- **Scaffolding de-duplicated** — `test-model`, `test-integration`, and `test-t0-edge` each carried their own byte-drifted copy of the same ~50-line mini event-list. They now import one documented `tests/helpers/mini-event-list.mjs`; every assertion is preserved (42 / 25 / 40), ~120 lines of triplication removed.

## [0.5.42] — 2026-07-07

- **CET (Emulation) is now the factory-default TCI planner** and the only one shown to users. The `stepped` / `cet` / `cet-conservative` planners had no clinical advantage over cet-emulation (the SimTIVA deliver_cpt port) and are retired from the UI — their code is retained for development only. The TCI Planning Mode picker on the setup screen is hidden by default; a developer can reveal it by setting `localStorage['tci-dev-planners'] = 'true'` and reloading. Existing users with a legacy saved mode (e.g. `stepped`) are migrated to cet-emulation automatically.

## [0.5.41.6] — 2026-07-07

Test-suite audit — the test files now exercise the real code they claim to validate (they had drifted into testing inline copies).

- **`test-vs-simtiva`** now imports the real `js/pk/engine.js` and `js/pk/eleveld.js`. Its "0.0000% vs SimTIVA" cross-validation previously ran against an inline *copy* of the engine that never touched production; it now validates the shipping matrix-exp engine and Eleveld calculator against the independent analytical eigenvalue oracle (kept inline by design). Confirmed real Eleveld matches the SimTIVA reference within 0.1% across all 7 patients.
- **`test-unit-safety`** now imports the real `validateParams` (js/pk/engine.js) instead of an inline copy.
- **`test-decay`** and **`test-steady-state-predictor`** now import the real predictors + engine + Eleveld/Fentanyl/Ketamine calculators. The inline copies had drifted from production (inline Eleveld used base CL 1.89 vs the real 1.79; inline ketamine was an entirely different volume model). Exact-value regression locks were re-baselined to the real predictors' output.
- **Remaining inline-engine tests converted**: `test-t0-edge`, `test-model`, `test-reconcile`, `test-sim-v2`, `test-integration`, `test-fentanyl-pk`, `test-ketamine-pk`, `test-units` now import the real engine / Eleveld / drug calculators / unit converter instead of copied-and-pasted duplicates (the 4×4 matrix engine was inlined 11×). `test-sim-v2` / `test-integration` also drop their inline *drifted* Eleveld for the real one. Mini event/sim harnesses are kept as labelled scaffolding (the production event/sim layers are covered by `test-session-roundtrip` / `test-pump-rate-correction`); genuinely-independent references (reconcile's Cardano cubic, vs-simtiva's analytical solver) stay inline by design. Matrix-exp primitive checks reframed through the engine's public `getSystemMatrix` + `advance`.
- **`test-tci-scheme`** now imports the real **cet-emulation planner** (`planTCISchemeEmulation`, the production planner) with the production pump config, instead of an inline copy of a stepped-style planner. It reaches target by ~5 min and holds the band, with or without display-rounding — verified against the live app (35 y/70 kg, target 3.5, rounding on). (A `0.5.41.4` note claiming display-rounding "slows CET onset" was **wrong** — it came from wiring the test to a development planner (`planTCISchemeCET`) with the wrong maxRate; corrected in `0.5.41.6`.)
- **New `test-meta`**: automated release-hygiene checks that were previously manual — `js/version.js` ↔ `sw.js` version lockstep, and `sw.js` PRECACHE_URLS ↔ the js modules on disk.

## [0.5.41.2] — 2026-07-06

- **Unpaired sync buttons now relabel like the patient button** (0.5.41.1's dim+hint treatment was too dark and inconsistent). All five buttons use the same "⚙ Pair to enable …" language when no code is stored — case buttons say "⚙ Pair to enable case sync", the compact template buttons say "⚙ Pair" — with a light dim (opacity .7) that keeps the text readable, since the label itself explains the disabled state. The untappable "Not paired — tap to set up" status-line notices are removed, and tapping goes straight to Settings → Sync with no extra message.

## [0.5.41.1] — 2026-07-06

- **Unpaired sync buttons now read clearly inert** (0.5.41's dim alone was too subtle on already-dashed buttons). Three reinforcing signals, all still tappable: heavier dim with muted text and no hover lift, a ⚙ prefix on the case/template buttons (matching the patient button's "⚙ Pair to enable cloud pull" language), and a persistent "Not paired — tap to set up" hint under each button group that clears on pairing. The tap notice now reads "Not paired — opening Settings → Sync…".

## [0.5.41] — 2026-07-06

Setup-screen sync UX, keypad standardization, and preferences cloud sync.

- **Preferences cloud sync** (new kind `prefs`, 30-day TTL): visual appearance, text size, sounds, tolerances, setup-default units, pump configuration, metric/imperial, TCI-mode/opioid defaults, and chart scales now push/pull under the same 6-char pairing code (Settings → Sync → "Push/Pull preferences"). Right after entering a valid code, the app checks the cloud and offers to apply any stored preferences — the fresh-install recovery flow for a wiped PWA. Applying reloads the app. `applyPrefs` is manifest-filtered both ways: a pulled blob can only write the known preference keys (never the sync code, saved case, or dose template), and manifest keys absent from the blob are removed so the device mirrors the pusher.
- **Starting-dose entry uses the custom keypad**: the six native `<input>`/`<select>` pairs (the app's last iOS-keyboard surface) are replaced by tappable dose displays that open the shared keypad in a one-shot custom session — full unit toggle (converts, not clears), conversion preview, and delivery-time line, with per-kg previews using the live setup weight. Template entries keep their own `{value, unit}`; in-case working unit preferences are untouched. Clear removes an entry.
- **Unpaired sync buttons are no longer silent**: with no sync code stored, the case/template push/pull buttons dim and a tap writes "Enter a sync code to pair — opening Settings…" to their status line before opening Settings → Sync (the patient-pull button keeps its existing relabel).

## [0.5.40.10] — 2026-07-03

Sync hardening (R5 — closes out the 0.5.40.8 audit roadmap).

- **Per-IP rate limit on `/api/sync`**: 60 requests/minute (fixed window, counter in the same Upstash Redis). Bounds pairing-code enumeration and quota burn on the intentionally unauthenticated endpoint while staying generous enough for several trainees behind one hospital NAT. Over-limit requests get `429` + `Retry-After`; the limiter **fails open** on any Redis error so it can never become a new sync outage mode. The app maps the 429 to "Too many sync requests — wait a minute and retry".
- **Case schema-version gate**: `CASE_SCHEMA_VERSION` (currently 1) is now enforced, not just stamped. `persist.loadCase()` and `validateIncomingCase()` refuse blobs from a **newer** schema, so a future v2 case pulled onto a not-yet-updated device shows "This case was saved by a newer app version — update this device to load it" instead of silently half-restoring with different numbers than the sender intended. Policy: `v` bumps only on breaking format changes; additive fields keep v1 (field-level fallbacks already handle those).

## [0.5.40.9] — 2026-07-03

Refactor round: the improvement-grade items deferred from the 0.5.40.8 audit, executed tests-first. Golden plan fingerprints (9 patient/target cases × 4 planners, 6-decimal times / 9-decimal values) are **bit-identical** before and after every phase; suite grew 717 → 782 tests.

- **Session/persist round-trip tests** (`tests/test-session-roundtrip.js`, 31 tests): the previously untested save/restore path — full field round-trip, bolus re-anchor under a changed pump rate, system-event skip/regeneration, `newCase()` unit-key reseeding, malformed-blob rejection, `DRUG_IDS`-generalized concentration restore — now runs in CI against the real `createSession` + `createModel` with stubbed `localStorage`/`document`.
- **Time-epsilon constants**: `TIME_EPS_CLINICAL` (0.001 min — "same clinical instant", event/bolus-end anchors) and `TIME_EPS_IDENTITY` (1e-9 — "did a recomputed time move") in `constants.js`; 11 literal sites in `events/actions.js`/`simulation.js` migrated. The 1e-12 loop terminators in `events/query.js` deliberately stay literal (commented).
- **Planner dedup** (`tci/shared.js`): the peak-matched bolus binary search (`searchPeakBolus` — stepped and CET differed only in four tuning constants, now passed as config), the target-decrease decay-wait loop (`waitForDecay`, was copied 3×), and the maintenance rate floor (`floorMaintenanceRate`, 2×) are single implementations. `calculateCETBolus` remains exported as a thin wrapper for `cet-conservative.js`.
- **One cubic solver** (`js/pk/cubic.js`): `eigenvalues.js cubeRoots()` and `simtiva-reference.js cube()` are now thin adapters (0-indexed per-minute vs SimTIVA's 1-indexed per-second API) over a single `solveCubicRoots` core — the "two solvers must stay in lockstep" hazard behind the 0.5.40.8 NaN bug is structurally gone. New `tests/test-cubic-parity.js` pins unit-scaling parity and the near-degenerate clamp.
- **Emulation rate grid derives from concentration**: `rf = 3600 / concentration` replaces the literal 360, which encoded "1 mL/h at 10 mg/mL" and rounded to the wrong grid at 8.33/20 mg/mL. Identical at the default 10 mg/mL.
- **Modal logic dedup**: new `js/ui/keypad-buffer.js` (the prefilled-buffer keypress reducer, the unit-toggle canonical round-trip, `fmtDeliveryTime`, `bolusTimeText`) and `js/ui/time-picker.js` (the case/real time picker factory) replace ~5 copies across `keypad.js` / `event-editor.js` / `patient-modal.js` / `reconcile-modal.js`. Deliberate divergences are parameters, not forks: RT-label prefix vs suffix, "real"-tab enable source, per-field prefill (patient modal), no prefill at all (reconcile). `tests/test-keypad-buffer.js` (24 tests) pins the CLAUDE.md invariants (first keypress replaces; unit toggles convert, not clear).

## [0.5.40.8] — 2026-07-03

Full-codebase audit round: correctness fixes, robustness hardening, dead-code removal.

- **Fixed the "All files present but module failed" boot failure** (mixed-version cache). Two service-worker holes let modules from different deploys coexist: install tolerated per-file precache failures (leaving a partial cache), and the runtime cache-miss fallback used the default fetch cache mode, letting a stale browser HTTP cache inject an old module into the current versioned cache. One stale module (e.g. a 0.5.40.6 `units.js` beside a 0.5.40.7 `session.js` importing `getSetupDefaultUnit`) kills the whole ES-module graph at link time. Same-origin precaching is now all-or-nothing (a failed install leaves the previous consistent version active), same-origin cache misses revalidate with the server, and the boot diagnostic now offers a one-tap **"Reset cached app & reload"** button (unregisters service workers, clears all caches, reloads) — the recovery path for devices already stuck.
- **Fixed a latent NaN in the SimTIVA eigenvalue solver.** `cube()` in `simtiva-reference.js` lacked the acos-argument clamp its twin (`eigenvalues.js cubeRoots()`) already had; near-degenerate eigenvalues could round the ratio past ±1 and silently produce a NaN loading bolus in CET-Conservative / CET-Emulation plans.
- **Fixed a chart listener leak on New Case.** Two anonymous handlers (double-tap recenter, multi-touch guard) attached to the persistent chart canvas on every chart creation and were never removed; repeated New Cases stacked stale handlers that threw on double-tap. They are now named and detached with the rest.
- **Removed hardcoded 10 mg/mL fallbacks** in bolus delivery math (`delivery.js`, `actions.js`). The fallback now uses the drug's own `DRUG_DEFS` concentration; a truly unknown drug logs a warning instead of silently assuming propofol concentration (200× wrong for fentanyl).
- **History totals now use the case's own pump concentration.** `getCumulativeDose` accepts the event list's snapshot-based delivery duration, so "Total delivered" and reconciliation agree with the curve replay when a restored case runs at a different concentration than the live global.
- **Cloud sync requests now time out after 15 s** instead of hanging forever on a stalled connection (which left the push/pull buttons permanently disabled). Timeouts surface as their own status message.
- **Case restore no longer hardcodes the three drug ids.** The pump-settings restore block iterates `DRUG_IDS` (as `save()` already did), so future drugs can't silently lose their saved concentration; failures now log instead of being swallowed. Patient-confirm drug-config refresh loops `DRUG_IDS` too.
- **The active drug card is restored with the case** (previously saved as `primaryDrug` but never read back — restore always landed on propofol).
- **Pulled cloud cases are validated event-by-event** (type/time/value shape) before restore, and the sync API's `kind` allowlist check no longer resolves prototype properties (`Object.hasOwn`).
- **Test runner:** now runs `.mjs` test files (two suites — 13 tests — were silently excluded; total 704 → 717), treats a non-zero exit after a printed summary as a failure, and flags test files that produce no summary instead of reporting them green.
- **PWA icons added.** `manifest.json` pointed at `/icons/*.png` that didn't exist — home-screen installs got a blank icon. Added programmatically generated placeholder icons (192/512 + apple-touch-icon; generator in `tools/gen-icons.js`), linked them in `index.html`, and precached them in `sw.js`.
- Perf: the engine caches `inv4(A)` (constant per engine) instead of recomputing it on every infused `advance()`, and computes only the needed column of the particular solution — planners call `advance()` tens of thousands of times per plan.
- Robustness: planner terminal-rate comparisons use a denominator floor so a 0-rate last step can't NaN-skip the steady-state rate; `decay-predictor` opts use `??` so an explicit 0 isn't replaced by the default.
- Dead code removed: `keypad.setOneShotConfirm`, `persist.clearSavedCase`, `constants.getAllPumpSettings`/`restorePumpSettings`, unused `add4` import, orphaned `ee-value-label` lookup, redundant assignments, dead `|| 175` fallback in the emulation planner.

## [0.5.40.7] — 2026-07-02

- **Preferred display units no longer leak between cases.** A mid-case unit swap (e.g. mcg/kg/min → mL/h) still sticks for the rest of the case and survives save/restore, but starting a **New Case** now resets each drug's bolus/rate units to the default chosen on the setup screen. The setup default is stored under a key (`tci-pref-{bolus|rate}Unit-{drug}-default`) separate from the in-case working key, so mid-case swaps can no longer overwrite it.
- **Pump concentration is now saved with the case.** Restoring an old case reapplies the concentration it was planned under (per drug) instead of the current global setting, so delivery volumes/durations stay faithful. Old saves without the field fall back to the global value.
- **The nonstandard 8.33 mg/mL propofol concentration is now non-sticky.** It still applies to the running case and is saved/restored with it, but it never becomes the setup-screen default — the setup screen always populates with a standard concentration, so 8.33 must be selected deliberately for each case.

## [0.5.40.6] — 2026-07-02

- Event acknowledgment popups now lay the **[Missed it — Recalculate]** and **[Got it]** buttons out side-by-side (left/right) with larger tap targets and a wider gap between them, instead of two thin bars stacked one over the other. Reduces the chance of tapping the wrong (destructive) action on a touch device. Non-TCI popups still show a single full-width **[Got it]**.

## [0.5.40.5] — 2026-06-29

- Fixed a propofol Ce discrepancy where the drug-card value and the chart/inspect readout disagreed after the global pump max rate was changed mid-case. Root cause: a bolus's delivery duration is derived from the global pump rate and a TCI plan anchors its first rate step to the bolus-end; changing the rate left a rate step stranded inside a bolus window, which the point query (card) and the curve sampler (graph) resolved differently.
- `computeCurve` now splits every engine advance at the bolus-end boundary, so the chart curve is bit-identical to `getConcentrationsAt`/`replayDrug` for any event arrangement (the matrix exponential is exact across the split, so no accuracy is lost). `replayDrug`/`replayDrugFrom` no longer move time backwards for an in-window event.
- A mid-case pump max-rate change is now treated as a whole-timeline **correction**: the engine's bolus-delivery config is synced (`refreshDrugConfig`) and every existing bolus's following step is re-anchored to its recomputed bolus-end (`reanchorBolusDeliveries`). Bolus dose (mg) is preserved — only delivery timing moves.
- Case save now records the pump bolus rate; restore re-anchors bolus deliveries if the global rate changed since the save, so reloaded cases stay internally consistent.

## [0.5.40.3] — 2026-06-25

- TCI alert popups (`warn-popup`): drug name now 15px bold for instant drug identification at a glance.
- Both popup systems (`warn-popup` and `modal-tci-firststep`): countdown shows `now (HH:MM RT)` when it reaches zero, providing a wall-clock timestamp for chart review and documentation.
- Both popup systems: added "Missed it — Recalculate" button with an inline confirmation panel. Confirming clears TCI events from the missed step forward and replans the same target from the current time; cancelling returns to the popup.

## [0.5.40.2] — 2026-06-25

- Drug panel infusion rate: numeric value now displays larger (1.45em) and colored in the drug's accent color for at-a-glance readability.

## [0.5.40.1] — 2026-06-17

Emergence trajectory continues past the threshold crossing.

- **The emergence trajectory line no longer ends abruptly on the threshold.** It now continues for a period (default 15 min) past the point where Ce crosses below the emergence threshold, so the dip below the line is clearly visible instead of terminating exactly on it.
- `js/sim/simulation.js` — `computeDecayTrajectory` takes a new `overshootMin` option; instead of breaking at the first `Ce ≤ targetCe`, it records the crossing time and keeps sampling until `overshootMin` minutes past it (still capped by `maxLookahead`).
- `js/version.js`, `sw.js` — `0.5.40` → `0.5.40.1`.

## [0.5.40] — 2026-06-17

Live emergence trajectory line on the chart.

- **Added a red dashed emergence trajectory line.** When an emergence threshold ("Emerge → X") is set for the selected drug AND an infusion is currently running, the chart now draws a dimmed-red dashed curve projecting forward from the current time, showing how Ce would decay *if the infusion were stopped right now* — descending until it meets the horizontal emergence threshold line. It updates continuously as the live Ce drifts, giving an immediate visual read of the shape and time-to-emergence. Hidden when no threshold is set, when the pump is already off (the real Ce curve is already decaying), or on drugs other than the selected one. Appearance (red, `[5,4]` dash, overlay alpha) is synced to the horizontal emergence threshold annotation so the two dim together.
- `js/sim/simulation.js` — new `computeDecayTrajectory(drugId, time, targetCe, opts)` facade method: a sibling of `predictDecayTo` that samples the rate-0 decay curve from the current engine state and restores state via `replayDrug`.
- `js/ui/chart/index.js`, `js/ui/chart/state.js` — new `emergence-traj` dataset + idempotent `setEmergenceTrajectory(points)` setter (signature-cache guarded, re-tints from the live `--red` CSS var + overlay alpha each call).
- `js/app/chart-bridge.js` — `onFrame` computes + pushes the trajectory each frame, gated on threshold-set + infusion-running, scaled to the drug's chart units.
- `js/version.js`, `sw.js` — `0.5.39.7` → `0.5.40`.

## [0.5.39.7] — 2026-06-17

More drug concentration options.

- **Added Propofol 8.33 mg/mL and Ketamine 100 mg/mL (10%)** to the per-drug concentration pickers on the setup screen. No other changes — pump math (`maxRate`, mL conversions) already derives from the selected concentration, so the new values work end-to-end with no code changes.
- `index.html` — new `<option>`s in `#input-concentration` and `#input-ketamine-concentration`.
- `js/version.js`, `sw.js` — `0.5.39.6` → `0.5.39.7`.

## [0.5.39.6] — 2026-06-17

Reconcile spread mode shows the rate in the drug's native unit.

- **Fixed: spread-mode rate was always labeled `mg/min`.** In Reconcile → Spread, the magnitude uses each drug's native mass unit (`fmtTotalMass`: mg for propofol/ketamine, mcg for fentanyl) but the rate beside it was hardcoded to canonical `mg/min`. For fentanyl that read e.g. `+50 mcg ... (0.001 mg/min for 60m)` — wrong unit and an awkward tiny number the code papered over with a `toExponential` fallback. The summary text and the post-confirm history notation now print the rate in the drug's native rate unit (`mcg/min` for fentanyl) with sensible precision; propofol/ketamine still read `mg/min`.
- `js/ui/reconcile-modal.js` — new `_fmtRatePerMin()` helper (reuses `mgToNative`/`nativeUnit` + shared `formatValue`); used in `_renderSummary()` and `_doReconcile()`; dropped the `rateStr`/`toExponential` workaround.
- `js/version.js`, `sw.js` — `0.5.39.5` → `0.5.39.6`.

## [0.5.39.5] — 2026-06-17

Reconcile Totals no longer overshoots the entered actual.

- **Fixed: dose reconciliation overshot the value you typed.** The reconcile modal sampled the simulated total *once* when it opened, but the case clock keeps running in real time while the modal is open. The correction (`delta = actual − simulated`) was therefore measured against a stale baseline yet applied against the live clock, so the post-reconcile total landed at `actual + (rate × time-the-dialog-was-open)` instead of `actual`. The overshoot scaled with infusion rate and time spent entering the number, and was zero only when the pump was paused — hence the intermittent "sometimes it's off" feel. Affected both single-bolus and spread modes.
- **Fix:** `_confirm()` now captures `now` up-front and re-samples the simulated total against that same `now` before computing the delta, so the whole confirm path is clock-consistent and `getCumulativeDose(now) == entered actual` exactly. `_render()` also re-samples the baseline each pass so the on-screen "Simulated total" and delta track the live clock and match what confirm will apply.
- `js/ui/reconcile-modal.js` — `_computeSimTotal(now)` parameterized; `_render()` and `_confirm()` re-sample against the live/apply-time clock.
- `tests/test-reconcile.js` — added two regression tests (676 total) pinning the "baseline must match apply-time clock" invariant for single-bolus and spread.
- `js/version.js`, `sw.js` — `0.5.39.4` → `0.5.39.5`.

## [0.5.39.4] — 2026-06-16

History keeps its place when you swap drugs.

- **Auto-scroll to current time on drug swap.** Switching the active drug rebuilds the event-history list (`render()` sets `innerHTML`, which resets the scroll container to the top). In TCI mode the past-event list is long, so the user was stranded at the top and had to scroll down to find the current time and upcoming events. After a swap the list now lands at the "now" boundary — the most recent past event and the upcoming future events in view. Drugs whose events are all in the past land at the bottom (latest event visible).
- New `scrollToNow()` export in `js/ui/history.js`, called once from the drug-card click handler in `js/app.js` after the swap re-renders. Deliberately NOT wired into the render cadence, so the scroll is never yanked while the user is reading.

- `js/ui/history.js` — new `scrollToNow()`; `js/app.js` — call after `refreshChart()` in the drug-card handler.
- `js/version.js`, `sw.js` — `0.5.39.3` → `0.5.39.4`.

## [0.5.39.3] — 2026-06-15

Cleaner dose numbers in the event log.

- **Trailing zeros stripped.** `formatValue` (the shared formatter for every rate/bolus/dose/volume display) now rounds to each unit's precision and then drops trailing zeros: `25.0 mcg` → `25 mcg`, `0.10 mg/min` → `0.1 mg/min`, while a real fractional part is kept (`25.5 mcg`). This applies everywhere the formatter is used — event rows, notations, keypad, step bar, chart labels — for consistency.
- **Number no longer wraps away from its unit.** The starting-dose notation and event-row values now join value and unit with a non-breaking space via a new `formatValueUnit(value, unit)` helper, so `140 mcg/kg/min` never breaks across lines.

- `js/util/units.js` — `formatValue` strips trailing zeros (`UNIT_DECIMALS` cap + `parseFloat().toString()`); new `formatValueUnit`.
- `js/sync/dose-template.js`, `js/ui/history.js` (`fmtRate` / `fmtBolusDose`) — use `formatValueUnit`.
- `tests/test-dose-template.js` — assertions updated to the stripped + non-breaking form.
- `js/version.js`, `sw.js` — `0.5.39.2` → `0.5.39.3`.

---

## [0.5.39.2] — 2026-06-15

Three fixes to the starting-dose setup section:

- **The fields now actually hide when the box is unchecked.** The `.start-doses-fields{display:flex}` rule was overriding the `hidden` attribute's `display:none` (equal specificity, author sheet wins over the UA sheet), so the inputs stayed visible regardless of the checkbox. Added `.start-doses-fields[hidden]{display:none}` to re-assert it.
- **Clearer visual division.** The checkbox, sync buttons, and per-drug fields are now wrapped in their own titled "Starting Doses" card with a 2px top border, matching the "Pump Configuration" / "Drug Configuration" cards above it.
- **Renamed the control** from "Give starting doses on Start" to "Apply Starting Doses to New Case".

- `index.html` — `[hidden]` CSS fix, `.start-doses-section` divider, titled wrapper card, control rename.
- `js/version.js`, `sw.js` — `0.5.39.1` → `0.5.39.2`.

---

## [0.5.39.1] — 2026-06-15

Move the starting-dose template fields out of the per-drug config tabs into a dedicated section directly below the "Give starting doses on Start" checkbox, grouped per drug and hidden until the box is checked (`updateStartDosesVisibility` in `js/ui/setup.js`). No field IDs changed, so the save/load/queue wiring is untouched.

Version bump is required for this to take effect on installed PWAs: the service worker caches assets by `VERSION`, and the preceding starting-dose UI commits changed `index.html`/`setup.js` without bumping it — so a byte-identical `sw.js` meant the browser never reinstalled the worker and kept serving the old cached layout. Bumping `js/version.js` + `sw.js` in lockstep busts the cache and triggers the version-aware reload.

- `js/version.js`, `sw.js` — `0.5.39` → `0.5.39.1`.
- `index.html`, `js/ui/setup.js` — relocated/collapsible starting-dose section.

---

## [0.5.39] — 2026-06-12

Extend the cloud scratch area to **case transfer** and a **starting-dose template**, both keyed by the existing pairing code.

**Cloud case transfer.** "↑ Push last case to cloud" / "↓ Pull case from cloud" buttons on the setup screen (push also in Settings → Sync for mid-case handoff) move the saved-case blob between devices. Pushed cases are kept 24 hours; pulling writes the blob into the local saved case and runs the normal restore path, so it also becomes "Restore Last Case". A confirm guard protects an existing local case from being overwritten.

**Starting-dose template.** A "Give starting doses on Start" checkbox on the setup screen reveals a per-drug section of optional "Starting bolus" / "Starting infusion" fields (value + unit, including weight-based units like mcg/kg) directly below it — hidden until the box is checked. When armed, **confirming the patient queues the doses as ordinary pre-start events** — they appear in the event history immediately under a "Starting Doses Queued" notation (flagged `pre` so it renders above the t=0 rows it announces, not as a caption below them — "Case Started" carries the same flag, so the log reads Queued → Started → delivery), can be edited or deleted via Edit mode like any planned event, and deliver when **Start** runs the case, exactly as if they had been keyed in manually (per drug: rate at the pre-start clock, then bolus, advancing the clock by the delivery time). Restores never re-queue (restore doesn't pass through patient confirm). The template lives in localStorage and can be pushed/pulled to the cloud (kept 30 days) via "↑ Push / ↓ Pull" next to the checkbox.

The `/api/sync` function now takes a `kind` discriminator (`case` | `template`; absent → patient). The patient path — the deployed scratchpad app's contract — is byte-for-byte unchanged, including the 1 KB cap and 30-minute TTL. New Redis keys are namespaced (`tcisync:{code}:case`, `tcisync:{code}:template`) with per-kind caps (64 KB / 4 KB). Case/template payloads get light server-side sanity checks; full validation happens client-side on pull.

- `api/sync.js` — `KINDS` table (TTL + size caps), `kind` routing on GET/POST, lazy `@upstash/redis` require (env check first), `__test` export hooks.
- `js/sync/cloud-sync.js` *(new)* — `pushPayload` / `fetchPayload` transport (never throws, shares patient-sync's error contract), `prepareCaseForPush` (strips cosmetic reconciliation ghosts if oversize), `validateIncomingCase`.
- `js/sync/dose-template.js` *(new)* — template schema + `normalizeTemplate` / `isTemplateEmpty` / `buildTemplateDoses` (pure planner: unit conversion, pump/push delivery mode, manual-mode flags, `rate-needs-pump` / `conversion-failed` errors), localStorage wrappers (`tci-dose-template`, `tci-dose-template-armed`).
- `js/app.js` — `queueStartingDoses()` called from setup's `onConfirm` (new-case only); push/pull case + template button wiring; shared `describeSyncError` / `makeStatusSetter` helpers (pull-patient refactored onto them).
- `js/ui/setup.js` — template editor wiring (`initTemplateControls`, exported `refreshTemplateInputs`), starting-dose section shown only when armed, starting-infusion row hidden when a drug's pump is off.
- `index.html` — arming row + template sync buttons, collapsible per-drug starting-dose section below it, case push/pull buttons, Settings → Sync case-transfer row.
- `tests/test-api-sync.js`, `tests/test-cloud-sync.js`, `tests/test-dose-template.js` *(new)* — 110 tests incl. the frozen-patient-contract guards.
- `js/app/settings-ui.js`, `sw.js` (precache + version), `DEPLOY.md`.

---

## [0.5.38.3] — 2026-06-11

Fix: restoring a case logged a duplicate **"Case Started"** notation. Restore loads the saved annotations (which already include the original "Case Started") and then calls `controls.ensureStarted()`, whose `onCaseStart` callback minted a second "Case Started" — on top of the "Case Restored" marker. `ensureStarted` now forwards an options object to `onCaseStart`, and restore passes `{ restored: true }` so the start annotation is skipped (the normal Start button is unaffected and still logs "Case Started").

- `js/ui/controls.js` — `ensureStarted(opts)` forwards `opts` to `onCaseStart`.
- `js/app.js` — `onCaseStart(opts)` skips the "Case Started" annotation when `opts.restored`.
- `js/app/session.js` — restore calls `ensureStarted({ restored: true })`.

---

## [0.5.38.2] — 2026-06-11

Fix: restoring a TCI-controlled case mis-flagged its rate steps. `session.restore()` re-inserted rate events via `model.addRate(...)` without the source argument, so saved `source:'tci'` rate steps came back as `'manual'` and lost their **TCI** badge in the event log (boluses were already restored with their source). Now the restore passes `{ source: evt.source || 'manual' }`, mirroring the bolus branch — TCI rate steps keep their tag (and any reconcile-sourced rows keep theirs). The save side already serialized `source` and `addRate` already honored `opts.source`; only the restore call was dropping it. Source is metadata only, so concentrations are unaffected.

- `js/app/session.js` — pass `source` through `model.addRate` in the restore replay loop.
- `tests/test-tci-bolus-restore.js` — added a save→restore round-trip assertion (re-insert saved events as `restore()` does; verify rate steps come back `source:'tci'`).

---

## [0.5.38.1] — 2026-06-11

Stop emitting the redundant **"Rate restored after bolus"** (`source:'system'`, dimmed ↩) row after a **TCI** bolus. `planTCI` already inserts explicit rate steps that define post-bolus delivery, so the system restore was pure clutter — and misleading, since it showed the *pre-plan* rate (often 0) immediately before the TCI maintenance rate. It was also a functional no-op: engine replay never changes the active rate across a bolus, so the restore only ever set the rate to the value it already was. Manual boluses are unchanged — they keep the restore marker, which is the only log evidence the pump resumed at its prior rate when there's no plan.

- `js/sim/events/actions.js` — `addBolus` skips the system rate-restore when `opts.source === 'tci'` (fresh-bolus path) / `existing.source === 'tci'` (merge path).
- `tests/test-tci-bolus-restore.js` — new real-module regression test (imports `js/sim/simulation.js`): a TCI plan's loading bolus produces no `system` event, a manual bolus still produces exactly one at the prior rate, and delivery still tracks toward target.

---

## [0.5.38] — 2026-06-11

Add **Notations** to the event history. The history panel now interleaves narrative two-line notes with the pump-command rows, so the log reads as a clinical timeline: `TCI Target Set / Ce 4.5 mcg/mL`, `TCI Ended / Manual Bolus`, `TCI Ended / Manual Rate Set`, `TCI Ended / Pump Stopped`, plus `Redose Threshold Set/Cleared`, `Emergence Set/Cleared`, `Dose Reconciled`, and the global `Case Started` / `Case Restored`. Notations are drug-tagged — drug-specific notes appear only in that drug's history, while global ones show everywhere. A **Notes** toggle in the history bar hides/shows all notations (persisted), and in Edit mode each note carries a ✕ to delete it.

This replaces a half-wired annotation system whose rows were rendered with stale markup and clobbered on every history repaint. `history.render()` is now the single source of truth, merging events and notations into one time-sorted list (events rank before a same-timestamp notation so the note reads as a caption under the action it describes).

- `js/app.js` — `addAnnotation(text, drugId)` accepts a `{ heading, sub }` notation and a drug tag, stores `{ id, timeMin, time, heading, sub, drug }`, and repaints via `history.render`; new `deleteAnnotation`; the four TCI-lifecycle emission points + redose/emergence wording; `history.init` wiring (`getAnnotations`, `onNotationDelete`); Notes toggle button wiring.
- `js/ui/history.js` — unified merge/sort renderer (`buildEventRow` / `buildNoteRow`), notation delete handling, `updateDimming` for notation rows, `toggleNotations` / `getNotationsVisible` (persisted under `tci-pref-history-show-notations`).
- `js/app/tci-modal.js` — running-case `TCI Target Set` notation.
- `js/app/session.js` — drop the manual DOM injection on restore; render via the unified path.
- `js/ui/reconcile-modal.js` — `Dose Reconciled` notation; `js/ui/persist.js` — annotation JSDoc.
- `index.html` — `.h-note*` row styling, Notes toggle button.

---

## [0.5.37] — 2026-06-05

Show the **estimated bolus delivery time** in the Add Bolus keypad and the event-editor modal, beneath the unit-conversion line. As a dose is typed, a muted line reads e.g. `Given over ~1:36 pump · ~20s push`, so the user can see how long the bolus will actually be infused before choosing **Pump Bolus** vs **IV Push**. When the bolus can only be given by hand (pump off, or a redose threshold is set outside manual mode), it collapses to a single `Given over ~20s`. Times are derived from the same pump settings (concentration + bolus rate) and push rate (3600 mL/h) used by the delivery engine.

- `js/ui/keypad.js` — bolus-time line in `updateDisplay()` via new `fmtDeliveryTime` / `updateBolusTime` helpers (uses `bolusDeliveryMinutes` / `pushDeliveryMinutes` from constants).
- `js/ui/event-editor.js` — same line for the unified Add/Edit Event modal.
- `index.html` — `#keypad-bolus-time` / `#ee-bolus-time` rows + `.keypad-bolus-time` styling.

---

## [0.5.36.0] — 2026-06-02

Expose the global **max pump rate** in the Settings → Simulation tab so it can be changed mid-case (previously only settable on the pre-case setup screen, which is unreachable once a case is running). The control mirrors the setup-screen options (750 / 1000 / 1200 mL/h); changing it updates the runtime pump settings for every drug and the derived mg/min cap, so subsequent TCI plans and bolus deliveries use the new rate while already-delivered events are unaffected. The setup-screen control and the `tci-pump-max-rate` localStorage key stay in lockstep, and the settings select re-reads the current value each time the modal opens (so a restored case shows the right rate).

- `js/ui/setup.js` — new exported `getGlobalMaxPumpRate()` / `setGlobalMaxPumpRate(mlh)` (applies to all `SETUP_DRUGS`, persists, syncs the setup control + derived displays).
- `js/app/settings-ui.js` — wire the new `#set-max-pump-rate` select; refresh on modal open; expanded Simulation info text.
- `index.html` — Max pump rate row at the top of the Simulation settings pane.

---

## [0.5.35.3] — 2026-06-02

Accept both Upstash credential namings in the sync backend. `api/sync.js` now reads `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` **or** the Vercel KV / Marketplace integration names `KV_REST_API_URL` / `KV_REST_API_TOKEN`. Which pair a deployment gets depends on how the store was provisioned, and a name mismatch was producing a spurious "kv-not-configured" 500 even with a connected store.

---

## [0.5.35.2] — 2026-06-02

Make cloud-pull failures diagnosable. The Pull button previously collapsed every non-success outcome into "Sync unavailable — check connection," which hid the actual cause (and mislabeled an invalid pairing code as a connection problem). `fetchPatient` now surfaces the HTTP status and the server's `{error}` string, and the on-screen status distinguishes the real cases:

- invalid pairing code → "Invalid pairing code — re-check it in Settings → Sync"
- network/CORS failure → "Can't reach sync server — check connection"
- HTTP 500 `kv-not-configured` → "Sync backend not configured (KV env vars missing)" — the Upstash env vars aren't set on that deployment
- HTTP 404 → "Sync endpoint not found (/api not deployed)"
- other HTTP errors → "Sync error \<status\> — \<server message\>"

`js/sync/patient-sync.js`, `js/app.js`.

---

## [0.5.35.1] — 2026-06-02

Follow-up fixes for the cloud patient pull (0.5.35.0).

- **Pairing reachable from the setup screen.** The settings gear lives only on the sim-screen top bar, so when unpaired the "Pull patient from cloud" button pointed users to Settings → Sync with no way to get there before a case starts. The button is now state-aware: with no pairing code it reads "⚙ Pair to enable cloud pull" and opens the settings modal directly on the Sync tab (focusing the code field); once paired it reverts to "↓ Pull patient from cloud". It stays enabled in both states instead of being a dead disabled control. `js/app.js`.
- **Fix Vercel build failure.** Removed `vercel.json`, whose `functions.runtime: "nodejs20.x"` is only valid for community runtimes (which require `name@version`) and failed the build with "Function Runtimes must have a valid version". The built-in Node runtime is auto-detected for `api/*.js`; its version is now pinned via `engines.node` (`20.x`) in `package.json`. Added `.gitignore` (`node_modules`, `.env*`, `.vercel/`) and a `DEPLOY.md` walkthrough for the Upstash env-var setup.

---

## [0.5.35.0] — 2026-06-02

Add cloud patient pull, so demographics entered in a separate scratchpad app (on another device) can be pulled into the simulator without re-typing. A small Vercel serverless endpoint backed by Upstash Redis acts as a short-lived "scratch area": the scratchpad continuously pushes age / sex / height / weight (canonical metric) keyed by a shared 6-character pairing code, and the simulator pulls the latest entry on demand. De-identified / training use only — only those four fields transfer (opioid co-administration is never synced), payloads are validated and size-capped server-side, and entries expire after 30 minutes.

- `api/sync.js` — new Vercel serverless function. `GET /api/sync?code=` reads the latest patient; `POST /api/sync` writes `{code, patient}` with a 30-min TTL and a server-set `updatedAt`. CORS allow-list via `SYNC_ALLOWED_ORIGINS`; Upstash via `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN`. 1 KB body cap, strict range validation.
- `js/sync/patient-sync.js` — new front-end module. Pure, tested helpers (`normalizeCode`, `isValidCode`, `normalizeIncomingPatient`, `canonicalToDisplay`, `formatRelativeTime`, code persistence) plus `fetchPatient()` and `applyPatientToInputs()` (injects via the existing `_writeHidden` setup pipeline, converting to the current display units).
- `js/ui/patient-modal.js` — export `_writeHidden` for reuse.
- `index.html` / `js/app/settings-ui.js` — new **Sync** settings tab with the pairing-code field (persisted to `tci-sync-code`); **Pull patient from cloud** button + freshness status under the patient summary on the setup screen.
- `js/app.js` — wire the Pull button (fetch → inject → "updated N min ago"; amber when stale or on error; disabled with no code).
- `sw.js` — VERSION bump, precache `js/sync/patient-sync.js`, and bypass `/api/` in the fetch handler so sync responses are never cached.
- `package.json` — new, for the serverless function only: declares `@upstash/redis` and pins the Node runtime via `engines.node` (`20.x`); Vercel auto-detects `api/*.js` (no `vercel.json` needed). The PWA stays build-step-free; the CommonJS test runner is preserved by intentionally omitting `"type": "module"`.
- `SCRATCHPAD-SYNC-SPEC.md` — handoff spec for the scratchpad app: pairing-code format, the POST contract/JSON schema, CORS/TTL notes, and a drop-in debounced auto-push snippet.

---

## [0.5.34.2] — 2026-05-26

Fix the TCI first-step countdown ignoring the reaction-delay offset. When a TCI plan is committed (including a target change that pauses the pump), the first-step modal counted down the raw plan delay and reached "Now!" at the real event time, while the drug-panel step bar and the alert popup reach zero `reactionDelaySec` *earlier*. With a non-zero reaction delay set, the prominent modal therefore fired one reaction-time later than every other cue — following it put the user's action late by exactly that lag, the opposite of the feature's intent. The modal now subtracts `reactionDelaySec` from its countdown so all three surfaces reach zero together, `reactionDelaySec` ahead of the planned event.

- `js/app/tci-modal.js` — `showFirstStep()` reads `getSettings().reactionDelaySec` and starts the countdown at `max(0, delaySeconds − reactionDelaySec)`.

---

## [0.5.34.1] — 2026-05-20

Fix missed keystrokes on rapid keypad entry. All three modal keypads (main numeric keypad, patient demographics, event editor) registered input via the `click` event, which on mobile is a synthesized event that the browser may coalesce or drop under fast successive taps. The visual `:active` highlight kept firing because it's driven by the underlying pointer event, so the user saw the key press but the digit never reached the buffer. Switched the input listeners to `pointerdown` with `preventDefault()` so taps register immediately and the follow-on synthesized click never double-registers.

- `js/ui/keypad.js` — `#modal-keypad .key` listener: `click` → `pointerdown`.
- `js/ui/patient-modal.js` — `.pm-key` listener: `click` → `pointerdown`.
- `js/ui/event-editor.js` — `#modal-evt-editor .ee-key` listener: `click` → `pointerdown`.

Non-keypad buttons (Confirm/Cancel, Next, unit toggles) keep their `click` handlers — they aren't tapped at high rates and `click` gives them correct slide-off cancellation.

---

## [0.5.34.0] — 2026-05-13

Two simulator-realism additions prompted by a unit-conversion confusion (a user comparing a mcg/kg/min value against the pump's mL/h reading and reading it as an out-of-range bolus rate):

**Bolus delivery shown in mL/h on the drug card.** The drug card's live rate readout switches from the user's preferred unit (mcg/kg/min etc.) to mL/h *while a bolus is in progress*, mirroring what a real infusion pump displays during delivery. The pump's currently-configured concentration is threaded through the conversion so the displayed mL/h matches the actual pump. History rows are unchanged — the dose remains the only value shown there. No effect on engine, planner, history times, or saved cases — display-only.

- `js/ui/drug-panel/formatters.js:108-141` — `fmtRateInline` accepts `{ bolusOverride: true }` to force mL/h with pump concentration.
- `js/ui/drug-panel/index.js:153-164` — drug card passes `bolusOverride` while `isInBolusPhase` or rate > 50 mg/min.

**Adjustable clinician reaction delay (0–2 s).** A new Notifications-tab setting that biases *only* the displayed countdown and the prep/alert firing thresholds earlier by `reactionDelaySec` for TCI-scheduled user-action events (`source: 'tci'`, type bolus/rate/pause). System-generated rate restorations after a bolus are not offset. The trainee's natural reaction lag then lands them at the planner's intended event time. The engine, history rows, and chart event markers all remain ground truth — nothing in the event list is shifted. Default is 0 s so existing cases see no behavior change until a user opts in.

- `js/ui/settings.js` — `reactionDelaySec` in DEFAULTS + validator (0–2 s, 0.5 s snap); new `displayedSecToEvent(evt, currentMin, reactionDelaySec)` helper; `check()` and `_showPopup()` route countdowns / prep / alert / zero-chime through it.
- `js/ui/drug-panel/step-bar.js` — step-bar progress + countdown shifted earlier for TCI events.
- `js/app/settings-ui.js` + `index.html` — Reaction-delay slider on the Notifications tab.
- `tests/test-reaction-delay.js` (new) — 19 tests covering helper edge cases (TCI / system / manual sources, all event types, floor at 0, validator clamp + 0.5-step snap).
- `js/version.js` + `sw.js` — bumped `0.5.33.8 → 0.5.34.0` in lockstep.

Note: fentanyl and ketamine rate-display defaults (`mcg/kg/min`, `mg/kg/h`) are unchanged. The display-unit confusion was the trigger for these changes, but flipping defaults silently would surprise existing users; this is left as a follow-up.

---

## [0.5.33.8] — 2026-05-08

Version bump to retrigger deployment. v0.5.33.7's deploy did not complete cleanly; bumping `VERSION` in `js/version.js` and `sw.js` in lockstep produces a fresh service-worker `CACHE_NAME` (`tcisim-v0.5.33.8`) and forces every client to fetch the new bundle on next navigation. No code changes.

- `js/version.js` + `sw.js` — bumped `0.5.33.7 → 0.5.33.8` in lockstep.

---

## [0.5.33.7] — 2026-05-08

Fix: setting a target then setting another target before tapping Start delivered both loading boluses on Start, instead of replacing the first plan with the second. Total dose was roughly the sum of the two plans' boluses.

The pre-case Set-Target handler in `js/app.js` advances a per-drug `preStartClock` by 0.01 min after every successful plan so subsequent events don't all collide at t=0. On a re-target, that means the second `planTCI` is called with `fromTime = 0.01`. Inside `planTCI`, `eventList.clearAfter(drugId, 0.01)` removes only events with `time > 0.01` — so plan #1's loading bolus at t=0 (and its initial rate event at t=0) survive. Plan #2 then appends its own bolus at t=0.01. Both boluses replay at the case origin.

Fix: in the pre-case `'ceTarget'` branch, treat re-targeting as a clean restart for the drug — rewind the pre-start clock to 0, wipe all events for the drug via the new `model.clearFrom(drugId, 0)`, then plan from t=0. First-time target is unaffected (rewind from 0→0 is a no-op; nothing to wipe). Other drugs' pre-case plans are untouched. The running-case path (which defers `planTCI` to the TCI delay modal's confirm) is untouched.

`clearFrom` already existed on the internal `eventList` (`js/sim/events/list-ops.js:79–85`); this exposes it on the public simulation facade as a sibling of `clearAfter`. "Wipe all events for a drug" is generally useful and reads more clearly than a `clearAfter(drugId, -1)` sentinel.

- `js/sim/simulation.js` — added `clearFrom(drugId, time)` wrapper after the existing `clearAfter`; added to facade exports.
- `js/app.js` — pre-case `'ceTarget'` branch now rewinds `preStartClock[selectedDrug]` to 0 and calls `model.clearFrom(selectedDrug, 0)` before re-planning.
- `js/version.js` + `sw.js` — bumped `0.5.33.6 → 0.5.33.7` in lockstep.

---

## [0.5.33.6] — 2026-05-08

Fix: the "Emerge → X.X in M:SS" countdown introduced in v0.5.33.5 stopped flickering during decay but oscillated 1 Hz at clinical steady state (`5:30 ↔ 5:29 ↔ 5:30`). Two-mode state machine fixes both regimes properly.

The v0.5.33.5 design rendered `fmtCountdown(arrivalMin - t)` every frame and re-baselined `arrivalMin` once per second. At true SS (Ce held flat by an active infusion) `arrivalMin` re-baselined to roughly the same value each second, but between refreshes `t` advanced continuously and crossed `Math.round`'s half-second boundary downward. The 1 Hz wall-clock refresh then snapped `arrivalMin` back up. Net: a visible `↓ ↑ ↓ ↑` flicker on a stable case.

Root cause is semantic: the "if you stopped now" answer has different semantics depending on whether you actually stopped. While infusing it's a *counter-factual* that needs periodic re-evaluation but doesn't tick down in real time; while idle it's *actually happening* and should tick at exactly 1 sec/sec.

Fix: split `js/ui/drug-panel/exit-readout.js` into two modes selected per frame from `ctx.model.getRateAtTime(drugId, t)`.

- **Active (`rate > 0`)**: cache `displayedDecayMin`, re-predict on a 1 s wall clock with ±1.5 s symmetric hysteresis, render directly with no `t` subtraction. The DOM string stays identical at SS, so the display is truly stable.
- **Idle (`rate == 0`)**: snapshot `idleStartT` and `idleStartDecayMin` at the Active→Idle transition (or first Idle frame), render every frame as `idleStartDecayMin - (t - idleStartT)` for a smooth 1 sec/sec countdown driven by the simulator clock. Periodic 5 s sanity re-predict re-baselines if cumulative drift exceeds hysteresis.

Mode transitions (Active↔Idle, exit-Ce change, `_curveVersion` bump from a bolus or event edit) trigger a forced re-predict. A bolus pushed during Idle bumps `_curveVersion`, which re-baselines the smooth countdown to the post-bolus Ce and resumes ticking.

- `js/ui/drug-panel/exit-readout.js` — replaced single-mode logic with Active/Idle state machine; cache holds both `displayedDecayMin` (Active) and `idleStartT` / `idleStartDecayMin` (Idle); `lastIsIdle` drives transition detection; render branch per mode.
- `js/version.js` + `sw.js` — bumped `0.5.33.5 → 0.5.33.6` in lockstep.
- `CLAUDE.md` — added a workflow note: before pushing follow-up commits to an existing branch, check whether the prior PR is already merged or closed; if so, open a new PR instead of assuming a push will update the closed one.

---

## [0.5.33.5] — 2026-05-07

Fix: the "Emerge → X.X in M:SS" countdown answers *"if you stopped now, when would Ce reach the threshold"* — but it was answering for the moment the user *engaged* the threshold, not the live moment.

In v0.5.31.8 the readout moved off a 3 s render throttle onto a frame-driven render that reads from a cached `arrivalMin`. The cache invalidates on (a) the user changing the exit Ce, and (b) `_curveVersion` bumping after an event mutation. That made the seconds digit tick smoothly, but it inadvertently dropped the property the old throttle was — by accident — providing: re-running `predictDecayTo` on a wall clock so the prediction stays current with the engine's drifting Ce. Between mutations the displayed time-to-emergence kept ticking down toward a target frozen at engagement, even while the user kept infusing and Ce kept climbing.

Fix: re-predict on a 1 s wall-clock cadence in addition to the existing event/threshold invalidations. The render path is unchanged — `arrivalMin` updates once per second to track Ce drift; `fmtCountdown(arrivalMin - t)` runs every frame so the M:SS field still ticks live. Cost is one `predictDecayTo` per drug per second when emergence is configured (~1–5 ms each).

- `js/ui/drug-panel/exit-readout.js` — added `lastPredictMs` field to the per-drug cache, added `stale = (now - lastPredictMs) >= 1000 ms` to the invalidation condition, updated `lastPredictMs` after each predict.
- `js/version.js` + `sw.js` — bumped `0.5.33.4 → 0.5.33.5` in lockstep.

---

## [0.5.33.4] — 2026-05-07

Fix: TCI event-flag markers (and a handful of other Ce/Cp-coupled chart features) drew against the wrong dataset once the foreground Ce trace started using the per-drug color.

Four chart plugins identified the foreground Ce/Cp datasets by `borderColor.startsWith(COLORS.ce)` / `COLORS.cp` — a pattern that worked while Ce was always blue (`#3b82f6`) and Cp always red. Now that foreground Ce reads `DRUG_DEFS[drugId].color` (e.g. canary `#facc15` for propofol), the Ce match falls through and the next dataset whose color happens to start with `#3b82f6` wins instead — that's the **fentanyl ghost trace**, since fentanyl's class color is narcotic blue.

Symptom: with propofol foregrounded, the green TCI event flags (rate up/down triangles, bolus arrows, stop octagons) appeared at the bottom of the chart along the fentanyl ghost trajectory in ng/mL space rather than on the propofol Ce curve at ~4 µg/mL. The inspect cursor dots, the inspect readout panel, and the (currently disabled) tooltip all had the same matcher pattern.

Fix: tag each dataset with a stable `role` field at construction (`'cp'`, `'ce'`, `'rate'`, `'ghost-reconcile'`, `'ghost-drug'`) and switch all four plugins to match on `ds.role` instead of color string. Color matching for dataset identity is brittle the moment colors become per-drug; the role tag is declarative and ghost-safe.

- `js/ui/chart/index.js` — added `role` to every dataset; switched the disabled tooltip's Ce-finder to use it.
- `js/ui/chart/plugins/event-markers.js` — match `ds.role === 'ce'`.
- `js/ui/chart/plugins/cursor-dots.js` — skip `ds.role !== 'ce' && ds.role !== 'cp'`.
- `js/ui/chart/plugins/inspect-dots.js` — same.
- `js/ui/chart/plugins/readout-panel.js` — separate Ce/Cp matchers by role; floor `py` raised from 52 to 80 to clear the chart-controls strip after its v0.5.33.1 drop to `top: 32px`.
- `js/version.js` + `sw.js` — bumped `0.5.33.3 → 0.5.33.4` in lockstep.

---

## [0.5.33.3] — 2026-05-07

Stop fighting ourselves on ghost-trace color identity.

The previous design layered four "this is secondary" cues on top of each other: dashed pattern, thinner stroke, `lighten(color, 0.25)` luminance shift, AND an opacity multiplier. Dash + thin already do most of the "in the background" work; layering luminance shift and alpha on top desaturated the per-drug color we just spent two patches tuning. At default 0.4 opacity on a `lighten()`-shifted hue, the canary-yellow propofol ghost was reading as a near-white wash instead of "yellow."

- Dropped the `lighten()` step from the ghost color path. Ghost color is now the full saturation `DRUG_DEFS[drugId].color`; the alpha multiplier is the single user-tunable fade.
- Bumped the default ghost opacity from `0.4 → 0.5`. With `lighten()` removed, 0.5 reads as clearly secondary while keeping the drug color recognizable.
- `lighten()` stays in `js/util/color.js` for any future use; just unused by the chart now.

Net result: ghosts retain their drug-color identity (canary propofol, amber ketamine, blue fentanyl) at any opacity setting, with dash + thin handling the visual hierarchy.

- `js/ui/chart/index.js` — drop `lighten()` from ghost dataset constructor and `_applyGhostColors()`.
- `js/ui/settings.js`, `js/ui/chart/state.js`, `js/app/chart-bridge.js`, `js/app/settings-ui.js`, `index.html` — default `ghostOpacity 0.4 → 0.5`.
- `js/version.js` + `sw.js` — bumped `0.5.33.2 → 0.5.33.3` in lockstep.

---

## [0.5.33.2] — 2026-05-07

Re-tune the hypnotic-class colors so propofol and ketamine separate by luminance rather than hue:

- Propofol → `#facc15` (Tailwind yellow-400, bright canary yellow). Previous `#eab308` was reading as a deeper goldenrod on screen rather than a primary yellow.
- Ketamine → reverted to `#f59e0b` (Tailwind amber-500). The v0.5.33.1 detour to orange (`#ea580c`) over-corrected; now that propofol has been pushed to a brighter canary, the original amber gives clear luminance separation while keeping ketamine cleanly in the warm-induction palette.

Net result: foreground Ce traces now read as canary yellow (propofol) vs amber (ketamine) — clearly distinct at a glance — while staying well clear of narcotic blue (fentanyl) and the BIS band overlays.

- `js/util/constants.js` — `DRUG_DEFS.propofol.color`, `DRUG_DEFS.ketamine.color`.
- `js/version.js` + `sw.js` — bumped `0.5.33.1 → 0.5.33.2` in lockstep.

---

## [0.5.33.1] — 2026-05-07

Three visual tweaks on top of v0.5.33.0:

1. **Chart-controls strip dropped 24 px** so the buttons no longer overlap the Chart.js legend at the top of the chart. `.chart-controls { top: 8px → 32px }` in `index.html`.
2. **Ketamine color shifted yellow-amber → orange** (`#f59e0b → #ea580c`). The previous amber was too close to propofol's primary yellow to read as distinct on the chart when both drugs were running. Orange gives a clear hue separation while staying within the warm-induction palette and away from narcotic blue.
3. **Ghost trace `borderWidth` 1 → 1.5 px** so each ghost carries a touch more color presence. Foreground Ce stays 3 px solid, so the foreground/ghost contrast is preserved — the ghost just has a bit more weight to register as a real line rather than a hairline.

- `index.html` — `.chart-controls` top offset.
- `js/util/constants.js` — ketamine `DRUG_DEFS.color`.
- `js/ui/chart/index.js` — ghost dataset `borderWidth`.
- `js/version.js` + `sw.js` — bumped `0.5.33.0 → 0.5.33.1` in lockstep.

---

## [0.5.33.0] — 2026-05-07

Promoted `DRUG_DEFS[drugId].color` to the single source of truth for every drug-keyed UI surface, and added ghost Ce traces of non-selected drugs for peripheral awareness during co-administered cases.

**Drug-color rework — `DRUG_DEFS[drugId].color`:**

The drug card highlights, analysis-screen drug buttons, compartment viz, and chart Ce trace all now read the same per-drug color. Drug-class color coding (medical convention) is preserved with distinct shades inside each class so two ghost Ce traces don't collide on the chart:

- propofol — `#eab308` (hypnotic, primary yellow)
- ketamine — `#f59e0b` (hypnotic, amber)
- fentanyl — `#3b82f6` (narcotic, primary blue)
- remifentanil — `#06b6d4` (narcotic, cyan; reserved — no PK model yet)

The four `#drug-{id}` literal CSS rules in `index.html` and the three hardcoded analysis-button hex literals are gone — `--drug-color` and `--drug-color-muted` are pushed onto each element at boot from `DRUG_DEFS`. The chart's foreground Ce trace now also reads from `DRUG_DEFS[drugId].color` (was hardcoded `COLORS.ce` blue) and is bumped from 2 px to 3 px for better contrast against the lighter ghost lines below it. Cp stays red (`COLORS.cp`) — anatomical convention for blood/plasma.

**Ghost Ce traces:**

A new `∿` button on the chart-controls strip toggles dimmed Ce-only traces of every non-selected drug that has events. Each ghost is drawn in that drug's color, lightened (HSL luminance shift) and 1 px dashed `[2,4]`. Each ghost is bound to its own hidden Y-axis so the line height matches that drug's foreground calibration even though X-axis pan/zoom is shared with the foreground.

- Off by default; persisted via `settings.ghostTracesEnabled`.
- "Ghost trace opacity" slider added to Settings → Appearance (default 40%, range 10–100%).
- Switching drugs hides the new selected drug's ghost (its data is now drawn as the foreground) and unhides the others.
- Drugs with no events skip ghost computation — no flat-zero baselines on session start.

**Files:**

- `js/util/color.js` — new. `lighten()`, `hexToRgba()`, `alphaToHex()`.
- `js/util/constants.js` — updated `DRUG_DEFS[].color` to class-coded values.
- `js/ui/chart/index.js` — foreground Ce reads `DRUG_DEFS[drugId].color` at 3 px; per-drug ghost datasets + hidden `yGhost_<drugId>` axes; new setters `setDrugColor`, `setGhostTraces`, `setGhostAxisMax`, `setGhostOpacity`, `setGhostEnabled`, `toggleGhostTraces`. `switchDrug()` re-tints + re-evaluates ghost visibility. Legend filter extended to hide per-drug ghost labels.
- `js/ui/chart/state.js` — added `drugColor`, `ghostOpacity`, `ghostEnabled`, `ghostTracesSigs`.
- `js/app/chart-bridge.js` — `refresh()` computes per-drug ghost curves and pushes them with matched Y-axis maxes; `onFrame()` calls the new idempotent setters every frame so chart recreation (new case) self-heals.
- `js/app.js` — boot-time `applyDrugColorVars()` pushes `--drug-color` / `--drug-color-muted` onto each drug card and analysis button; `btn-chart-ghosts` wired with persistence + active-state seeding on new case.
- `js/ui/settings.js` — `ghostOpacity` (0.1–1.0, default 0.4) and `ghostTracesEnabled` (default false) added to defaults + validation + persistence.
- `js/app/settings-ui.js` — wired the new ghost-opacity slider.
- `index.html` — removed four hardcoded `#drug-{id}` CSS rules + three `.btn-analysis-drug.active[data-drug=…]` hex literals (replaced with `var(--drug-color)`); added `btn-chart-ghosts` to chart-controls and `set-ghost-opacity` slider to the Appearance pane.
- `js/version.js` + `sw.js` — bumped `0.5.32.4 → 0.5.33.0` in lockstep; added `js/util/color.js` to the SW precache list.

---

## [0.5.32.4] — 2026-05-04

UX fix: pump-disabled fentanyl/ketamine drug cards previously showed `NO MODE` with all bottom-bar buttons dimmed, even though intermittent bolus IS the operating mode for these drugs by default — there's no infusion possible when the pump is off. The label was misleading and Add Bolus looked passive when it was actually the primary action.

New mode taxonomy for the pump-disabled non-TCI branch:

- **`BOLUS`** (purple `manual-mode` label) — default state, no redose threshold. Add Bolus highlighted as the primary action.
- **`INTERMITTENT`** (amber `target-mode` label) — redose threshold set. Change Threshold + Add Bolus highlighted (unchanged).

Add Bolus now stays highlighted across both states since bolus is always the primary action when the pump is disabled. The threshold becomes additive (it just promotes the label and lights up the threshold button) rather than the gating condition for whether the drug card looks "live."

TCI-capable drugs (propofol, remifentanil) and pump-enabled non-TCI drugs are unchanged.

- `js/ui/mode.js updateModeUI()` — pump-disabled branch: always apply `active-mode` to btn-bolus; show `BOLUS`/`manual-mode` instead of `NO MODE`/`no-mode` when no threshold; INTERMITTENT path otherwise unchanged.
- `js/version.js` + `sw.js` — bumped `0.5.32.3 → 0.5.32.4` in lockstep.

---

## [0.5.32.3] — 2026-05-04

Fix: rapid second taps on keypad buttons (patient demographics, numeric keypad, event editor) were occasionally being dropped on iOS — typing "35" too fast for the age field could land just "3". Cause: the buttons lacked `touch-action: manipulation`, so iOS was holding each tap for ~300 ms to disambiguate against a double-tap-zoom gesture, and a fast follow-up tap landed inside that window and got swallowed. Added a global `button, [role="button"] { touch-action: manipulation; -webkit-tap-highlight-color: transparent }` rule so every tappable control in the app responds immediately on iOS, plus an explicit `touch-action:manipulation` on `.pm-key` and `.key` for clarity.

- `index.html` — global `button` rule + explicit additions to `.pm-key` / `.key`.
- `js/version.js` + `sw.js` — bumped `0.5.32.2 → 0.5.32.3` in lockstep.

---

## [0.5.32.2] — 2026-05-04

Two BIS-readout fixes surfaced while testing the new themable colors:

1. **eBIS missing on phones.** A pre-existing CSS rule (added in v0.5.24.16) hard-hid `.drug-card .drug-bis-header` on phone-landscape (`max-width:900px and max-height:420px`) and phone-portrait (`max-width:500px and orientation:portrait`) viewports, plus reverted `.drug-card .drug-header-row` to `display:block`. On modern phones there's plenty of horizontal space in the header for the readout — kept the row as flex (default) and let the eBIS render right-justified next to the drug name. Empty bis-headers still collapse via the existing `:empty{display:none}` rule, so non-propofol drug cards are unaffected.

2. **eBIS color invisible in light theme.** `bisColor()` returned hard-coded hex literals tuned for a dark backdrop — `#eab308` yellow for BIS 40-60 (typical anesthetic depth) is unreadable on white. Promoted the five depth-band colors to per-theme CSS variables (`--bis-mild`, `--bis-moderate`, `--bis-deep`, `--bis-deeper`, `--bis-very-deep`) — dark theme keeps the original brights, light theme uses darker variants (`#a16207` darker amber for the GA range, `#dc2626` red, `#16a34a` green, etc.). `bisColor()` now returns `var(--bis-…)` strings.

- `index.html` — removed two `.drug-bis-header{display:none}` rules + matching `.drug-header-row{display:block}` overrides; added `--bis-mild` / `--bis-moderate` / `--bis-deep` / `--bis-deeper` / `--bis-very-deep` to both `:root` blocks.
- `js/ui/drug-panel/formatters.js` — `bisColor()` returns `var(--bis-…)` refs.
- `js/version.js` + `sw.js` — bumped `0.5.32.1 → 0.5.32.2` in lockstep.

---

## [0.5.32.1] — 2026-05-04

Fix: BIS nomogram bands invisible in light theme. The band fills were hard-coded at 19% alpha (`30` hex), tuned for a near-black backdrop. On the new white background that's essentially imperceptible — the bands and their labels disappeared. Promoted the alpha to a per-theme CSS token (`--bis-band-alpha`: `30` dark, `55` ≈ 33% light) so the bands stay visible against either backdrop without overwhelming the curves on top.

- `index.html` — added `--bis-band-alpha` to both `:root` and `:root[data-theme="light"]` blocks.
- `js/app/chart-bridge.js` `computeEffectOverlay()` — reads `--bis-band-alpha` via `getComputedStyle()` and appends it to each band's base hex (`'#ef4444' + a`). The `tci:theme-change` listener now also re-runs `computeEffectOverlay()` so the bands re-render with the new alpha when the user toggles themes mid-session.
- `js/version.js` + `sw.js` — bumped `0.5.32.0 → 0.5.32.1` in lockstep.

---

## [0.5.32.0] — 2026-05-03

Themable color scheme. The app now ships with a **Dark** (default, current look) and **Light** theme, selectable from Settings → Appearance. CSS custom properties on `<html>` cascade through every surface; chart axes/grid/legend/tooltip and annotation overlays re-read the theme tokens on theme change so the chart never looks orphaned against the rest of the UI.

- `index.html` — added `--chart-axis-title`, `--chart-tick`, `--chart-grid`, `--chart-legend`, `--chart-tooltip-bg`, `--chart-label-fg` to `:root` (dark defaults) and a parallel `:root[data-theme="light"]` block that overrides every UI + chart token. Added Theme segmented control to the Appearance pane.
- `js/ui/settings.js` — added `theme` (`'dark' | 'light'`) to `DEFAULTS`, `THEMES` validator list, getter/setter pass-through.
- `js/app/settings-ui.js` — `applyTheme()` sets `document.documentElement.dataset.theme`, swaps the browser-chrome `<meta name="theme-color">`, and dispatches a `tci:theme-change` CustomEvent. Click-handler wiring mirrors the existing text-size segmented control.
- `js/ui/chart/index.js` — added `readThemeVars()` helper (CSS-variable sampler), replaced eight hard-coded hex literals on axes/grid/legend/tooltip, and exposed `chart.applyTheme()` that re-reads vars and rebuilds annotations.
- `js/ui/chart/annotations.js` — replaced six semantic literals (`#f59e0b`, `#22c55e`, `#ef4444`, `#ffffff`) with reads of the `--amber` / `--green` / `--red` / `--chart-label-fg` CSS variables. The trailing-alpha hex concatenation pattern (`amber + s.overlayAlpha`) keeps working because both theme blocks use 6-char hex values.
- `js/app/chart-bridge.js` — listens to `tci:theme-change` once, calls `chart.applyTheme()` on the live chart instance.
- `js/version.js` + `sw.js` — bumped `0.5.31.9 → 0.5.32.0` in lockstep.

Drug brand colors (propofol blue, fentanyl orange, ketamine purple) and chart dataset colors (Cp red, Ce blue, BIS green, rate purple, target orange) are intentionally **not** themed — they are clinical identity tokens and should look the same in both themes for recognizability.

---

## [0.5.31.9] — 2026-05-01

Fix: when replaying a case (current time scrubbed into the past with rate-resume / bolus events queued ahead), Stop Pump did not clear the queued events. The simulation ended up in a contradictory state — pump shown as stopped at the current time, but resuming when the next future event fired. Two underlying problems in `onPumpPause` (`js/app.js`):

1. `clearAfter(drugId, t)` was gated on `mode === 'tci'` only. Manual-mode cases with future events kept them after a Stop Pump.
2. The early-return guard `if (conc.rate === 0 && mode !== 'tci') return` blocked the handler entirely when the current replay time landed in a momentary rate=0 gap, even if future events would resume the pump — the user had no way to cancel them.

Fix: always call `clearAfter` after the pause is inserted, regardless of mode. Refine the early-return guard to allow the handler when future events exist (`getEvents(drugId).some(e => e.time > t + 0.0001)`), so replay scenarios can cancel queued resumptions.

- `js/app.js` — `onPumpPause` rewritten per the above. No-ops only when pump is genuinely idle: `rate === 0`, mode not TCI, and nothing queued ahead.
- `js/version.js` + `sw.js` — bumped `0.5.31.8 → 0.5.31.9` in lockstep.

---

## [0.5.31.8] — 2026-05-01

The emergence countdown now updates live every frame instead of every 3 seconds. Same pattern `approach.js` uses for its TCI / SS / plateau countdowns: `predictDecayTo` runs once per state change (user changes the emergence Ce, or the model curve mutates), the returned `arrivalMin` is cached, and each rAF frame renders `fmtCountdown(arrivalMin - t)` from the cache. No per-frame model calls.

- `js/ui/drug-panel/approach.js` — exported `getCurveVersion()` so other drug-panel modules can use the curve-mutation counter as an invalidation signal.
- `js/ui/drug-panel/exit-readout.js` — replaced the 3 s `predictDecayTo` throttle with a per-drug cache of `{exitCe, computedVersion, arrivalMin, prefixHtml}`. Re-predicts only when `exitCe` or `getCurveVersion()` changes; renders `prefixHtml + fmtCountdown(arrivalMin - t)` per frame from the cache. Force re-predicts next frame if arrival elapses while Ce is still above threshold.
- `js/ui/drug-panel/index.js` — `forceUpdate()` now also invalidates the exit-readout cache via the newly exported `invalidateAll`, so explicit "model mutated" signals (`forceUpdate`) drop both caches in lockstep.
- `js/version.js` + `sw.js` — bumped `0.5.31.7 → 0.5.31.8` in lockstep.

---

## [0.5.31.7] — 2026-05-01

Fix: when the pump is stopped on a drug card with a configured emergence Ce, two emergence countdowns rendered simultaneously — `Exit 2.0 in 7:51` (live) above the status row and `Emerge → 2.0 in 7:54` (3 s throttle) below it. The two predictions used different APIs (`predictTrough` vs `predictDecayTo`) and different update cadences, so the displayed times drifted apart. The `Exit` label was also stale per the post-0.5.24.3 naming convention ("Emerge → / Emergence" everywhere users see it).

- `js/ui/drug-panel/approach.js` — the "Pump stopped — emergence countdown" block now early-returns when the user has configured an exit Ce (`ctx.getExitCeForDrug(drugId) > 0`). The exit-readout module owns that readout exclusively. The fallback path (no user-set emergence) keeps using the default `EMERGENCE_CE` (1.5) and now hardcodes the label to `Emergence` instead of branching on the now-unreachable `Exit` case.
- `js/version.js` + `sw.js` — bumped `0.5.31.6 → 0.5.31.7` in lockstep.

---

## [0.5.31.6] — 2026-05-01

Click the version number to manually check for updates.

- `index.html` — `.setup-brand .version-tag` gets `cursor: pointer`, `user-select: none`, a hover state (lifts `color` to `--text-primary` with a subtle blue text-shadow), and an active state at 70% opacity. The element gains `title="Click to check for updates"`, `role="button"`, and `tabindex="0"` for keyboard reachability.
- `js/app/sw-register.js`
  - New `manualCheck()` function. Guards on `manualCheckInFlight`, `registration` set, and `isOnSetupScreen()` (redundant — the version tag is only visible there — but kept as belt and suspenders). Paints `Checking for updates…` immediately, awaits `checkServerVersion()`, and reverts to the steady-state status if no update was found. If one is found, `checkServerVersion` already paints `Update available (vX)…` and the SW lifecycle takes over.
  - `checkServerVersion()` now returns a boolean (`true` = update detected) and absorbs fetch errors internally with a `try/catch` around the network call, so the manual-check path can branch on the result and the offline case naturally returns `false` → revert to the offline steady state.
  - `attachVersionTagHandler()` wires `click` + `keydown` (Enter / Space) on `#app-version-tag` from `init()`.
- `js/version.js` + `sw.js` — bumped `0.5.31.5 → 0.5.31.6` in lockstep.

---

## [0.5.31.5] — 2026-05-01

Make the post-update "✓ New update installed." status message sticky for the whole session instead of reverting to "No new version available." after 6 seconds.

- `js/app/sw-register.js`
  - Replaced the `setTimeout`-based `showJustUpdatedToastIfPending` with a one-shot `consumeJustUpdatedFlag()` that reads + clears the `tcisim:justUpdated` sessionStorage flag and returns a boolean. The boolean is captured in a module-level `justUpdated` const at boot.
  - `refreshConnectivityStatus()` now branches on `justUpdated` first: when set, it shows `✓ New update installed. Last update <ts>.` regardless of connectivity. The connectivity-based steady states (`No new version available. …` / `Offline. Cached version last updated …`) only apply when `justUpdated` is false.
  - Net effect: after an update reload, the "New update installed" message persists for the rest of the session — through screen transitions, going offline/online, opening cases, etc. — until the user reloads the page without an accompanying update, at which point the sessionStorage flag is gone and the message reverts to the connectivity steady state.
  - Dropped the now-unused `UPDATED_TOAST_MS` constant.
- `js/version.js` + `sw.js` — bumped `0.5.31.4 → 0.5.31.5` in lockstep.

---

## [0.5.31.4] — 2026-05-01

Show when the cached version was last installed in the SW status line, and use prose phrasing instead of one-word states.

- `js/app/sw-register.js`
  - New `localStorage` pair tracks the install timestamp: `tcisim:installedVersion` (the `APP_VERSION` string) and `tcisim:installedAt` (ISO datetime). Re-stamped on the boot right after an update — detected by `stored !== APP_VERSION` — so the timestamp always reflects when the currently-running cached code was first installed locally. Also stamps on first ever boot.
  - Status messages rewritten as full sentences with a localized date/time (`toLocaleString` with `month: 'short'` etc.):
    - online steady state → `No new version available. Last update May 1, 2026, 02:23 PM.`
    - offline steady state → `Offline. Cached version last updated May 1, 2026, 02:23 PM.`
    - just-updated toast → `✓ New update installed.`
    - mid-update transients → `Update available (vX)…` / `Updating to latest…` / `↻ Update queued · applies at next case start.`
- `index.html` — `.status-tag` font-size `9px → 10px`, dot bumped `6→7px`, `align-items: flex-start`, dot gets a 4 px top margin and the label sits in its own `<span class="text">` so the new sentences wrap cleanly inside the 220 px brand panel.
- `js/version.js` + `sw.js` — bumped `0.5.31.3 → 0.5.31.4` in lockstep.

---

## [0.5.31.3] — 2026-05-01

Lock SW updates to the setup screen — never apply mid-case.

- `js/app/sw-register.js`
  - All three update-triggering paths (the 60 s version poll, the post-`updatefound` `SKIP_WAITING` post, and the `controllerchange` → `location.reload()` chain) now hard-gate on `isOnSetupScreen()`. Once the user starts a case, the running version is locked in until they're back on setup.
  - When an update arrives mid-case, the new worker is parked in `waiting` (we don't post `SKIP_WAITING`) or, if `controllerchange` already fired, we set a `pendingReload` flag instead of reloading. The status badge shows `↻ update queued · applies at next case start` so the user knows.
  - On `tcisim:screenchange` to `setup-screen`: apply pending reload if set; else activate any waiting worker (covers updates the browser found via its own background check while we were on the sim screen); else run a fresh poll.
- `js/app.js` — `showScreen(id)` dispatches `tcisim:screenchange` with `{detail: {id}}` so `sw-register.js` can react to navigation without coupling to the rest of the app.
- `js/version.js` + `sw.js` — bumped `0.5.31.2 → 0.5.31.3` in lockstep.

---

## [0.5.31.2] — 2026-05-01

Make the version number on the setup-screen brand panel readable.

- `index.html` — `.setup-brand .version-tag` font-size `9px → 13px`, color `var(--text-muted) → var(--text-secondary)`, dropped the `opacity:.6` damping. The tag now prints at the same weight as the rest of the brand-panel text instead of getting lost beneath the title.
- `js/version.js` + `sw.js` — bumped `0.5.31.1 → 0.5.31.2` in lockstep.

---

## [0.5.31.1] — 2026-05-01

Status line under the version number on the setup-screen brand panel, plus a bug-fix in the SW reload flow.

- `index.html` — new `#app-status-tag` div directly below `#app-version-tag` inside `.setup-brand`. CSS adds a `.status-tag` rule with a 6 px colored dot + monospace label, and per-state classes (`online` / `offline` / `updating` / `updated`) that swap the dot and text color (green / amber / cyan-pulsing / blue). `.status-tag:empty{display:none}` so there's no layout jump before the first status write.
- `js/app/sw-register.js`
  - Added a status manager (`setStatus`, `refreshConnectivityStatus`) that writes one of: `online · cached`, `online · live`, `offline · cached`, `offline · live`, `updating to latest…`, `update available (vX)…`, `✓ updated to vX`. Connectivity is live (re-evaluated on `online`/`offline` events); the cached/live half is set once at load via `performance.getEntriesByType('navigation')[0].transferSize === 0`.
  - Bug fix: the `controllerchange` handler used to call `location.reload()` unconditionally, which meant the very first visit (when `clients.claim()` makes the new SW the controller) would reload once for nothing. Now guarded by an `updateTriggered` flag set only when we actually post `SKIP_WAITING` to a waiting worker, so first-install claim just refreshes the status badge instead of reloading.
  - The "✓ updated to vX" toast is driven by a `sessionStorage` flag set immediately before `location.reload()` and read on the next page load; it auto-clears after 6 s and reverts to the connectivity status.
  - When `'serviceWorker' in navigator` is false (older browsers), the module still wires up `online`/`offline` listeners on `DOMContentLoaded` so the status line is populated even without SW support.
- `js/version.js` + `sw.js` — bumped `0.5.31 → 0.5.31.1` in lockstep.

---

## [0.5.31] — 2026-05-01

Offline support via a service worker, plus an automatic reload when the server's version is newer than the running tab's.

- New `sw.js` at the repo root. Cache-first fetch handler, version-keyed cache (`tcisim-v<APP_VERSION>`). On install, precaches `index.html`, `manifest.json`, every JS module under `js/`, the four jsdelivr CDN scripts (Chart.js + annotation + zoom + hammer), and the Google Fonts CSS. Per-URL fetch with try/catch instead of `addAll`, so a flaky CDN can't take down offline support for the rest of the app. Activate handler deletes any cache whose name doesn't match the current `CACHE_NAME`. Network-first for `js/version.js` so the client-side version poller always sees fresh server bytes when online; cache-first for everything else, with opportunistic caching on miss (catches `fonts.gstatic.com` woff2 fetches the cached Google Fonts CSS triggers at runtime). Navigation fetch failures fall back to cached `index.html`. Responds to `'SKIP_WAITING'` and `'GET_VERSION'` messages.
- New `js/app/sw-register.js`. Registers the worker on `load`. On `updatefound` → installed → if there's an existing controller, posts `SKIP_WAITING` to the new worker; on `controllerchange`, calls `location.reload()` once. Polls `js/version.js` (network-only via `cache: 'no-store'`) every 60 s and on `visibilitychange→visible`, parses the `VERSION` constant with a regex, and if it differs from the running `APP_VERSION` calls `registration.update()` to drag the SW lifecycle along — which then triggers the same reload path.
- `js/app.js` — added `import './app/sw-register.js';` alongside the existing `js/app/*` imports.
- `js/version.js` — bumped `0.5.30.11 → 0.5.31`. **The `VERSION` constant in `sw.js` must be kept in lockstep with this on every release.**
- `CLAUDE.md` — "Adding a feature" workflow now mentions the lockstep `sw.js` bump.

---

## [0.5.30.11] — 2026-04-30

Compartment-viz: real backing rect behind every flow label, plus per-arrow label-position overrides. The `paint-order: stroke fill` halo from v0.5.30.8 only painted around individual glyphs, so arrow lines still showed through the gaps between letters; with bumped fonts the label bbox was also wider than 2× the perpendicular offset, meaning lines crossed into the label rectangle on vertical arrows.

- `js/ui/compartment-viz.js` — every arrow group now contains a `<rect class="cv-flow-label-bg">` behind its `<text>` label. `updateArrow()` calls `sizeBgToText()` after positioning the label to read the text's `getBBox()` and resize the rect with 4 / 2 viewBox-unit padding around it. Document order in the arrow group is `line → head → labelBg → label`, so the rect occludes the line/head where they overlap, and the label paints on top.
- Per-arrow `label` override added to the `anchors` table. When set, `updateArrow()` uses the explicit `{x, y, anchor}` instead of computing perpendicular offset. Used to keep short arrows' labels clear of destination boxes:
  - Wide `pump_to_v1`: `x = 305, y = 205, anchor: end` (sits left of V1's `x = 310`).
  - Wide `v1_to_v2`: `x = 540, y = 155, anchor: end` (clears V2's left edge at `x = 590`).
  - Tall `pump_to_v1`: `x = 105, y = 460, anchor: end` (clears V1's `x = 110`).
- The "Infusion" caption gets the same backing rect treatment, sized every frame from `onFrame` (cheap — one `getBBox` per frame).
- `index.html` — `.cv-flow-label-bg` styled with `fill: var(--bg-deep); stroke: none`.

---

## [0.5.30.10] — 2026-04-30

Compartment-viz: stop the "Infusion" caption from overlapping V1's left edge. Caption was anchored at midpoint just below the pump arrow; with the bumped flow-label font (14 viewBox units monospace ≈ 72 units of text), centering at `x = 95` gave a label spanning 59→131, overlapping V1's left wall at `x = 110`.

- `js/ui/compartment-viz.js` — added an `anchor` field to each layout's `infusion` descriptor; `buildSvg()` reads it. Both layouts switched to `anchor: 'end'` with the x position set 5 viewBox units before V1's left edge (`wide x = 305`, `tall x = 105`). Result: the label's right edge sits cleanly to the left of V1, with the rest of the text trailing off to the left into open space.

---

## [0.5.30.9] — 2026-04-30

Compartment-viz UX polish: rename, in-screen drug switcher, restored Infusion caption, and a properly tall landscape layout.

- `index.html` — analysis screen title `Retrospective Analysis → Compartment Analysis`. Added a 3-button drug switcher in the analysis topbar (`#analysis-drug-switch`) — Propofol / Fentanyl / Ketamine. The active button uses the drug's brand color (`#0099ff` / `#ff6b35` / `#a855f7`) to match the rest of the app's per-drug palette.
- `js/app.js` — the new buttons just programmatically click the matching `.drug-card`, which runs the existing switch logic (`chart.switchDrug`, history setup, mode refresh, `refreshChart`). `syncAnalysisDrugButtons()` keeps the active highlight in sync; called on screen entry and after each click.
- `js/ui/compartment-viz.js` — added an `infusion` anchor to each layout, drawing the word "Infusion" as a haloed flow-label below the pump arrow. Both labels (Infusion above the arrow tail, flow rate above the arrow midpoint perpendicular) get the `paint-order: stroke fill` halo so they don't clash with the line.
- Tall layout viewBox `540 × 720 → 500 × 940`. The landscape viz panel on iPad has aspect ~0.4 (narrow + very tall); the old 0.75 was leaving ~25 % of vertical space as letterbox bands. The new aspect (~0.53) fills the column and gives every box ~50 % more vertical room. Boxes resized: ce `220×120 → 220×150`, v2 `220×140 → 220×170`, v1 `280×160 → 280×200`, v3 `230×140 → 220×180`, elim `210×140 → 220×180`. Anchors recomputed.

---

## [0.5.30.8] — 2026-04-28

Compartment-viz: occlude arrow lines under flow labels with a halo, and drop the separate "Infusion" word that was crowding the pump-arrow flow label.

- `index.html` — `.cv-flow-label` now uses `paint-order: stroke fill` with a `5 px` stroke matching `var(--bg-deep)` (4 px on the mobile breakpoint). The stroke renders first, fill on top — creating a halo that occludes the arrow line passing under each label. This sidesteps the "label sits next to but bounding-box still crosses the line" problem entirely.
- `js/ui/compartment-viz.js` — removed the dedicated "Infusion" text element from both layouts. The pump arrow's tail enters the diagram from outside the canvas, which already conveys "drug coming in"; the flow rate at the arrow midpoint is the only label needed there. Saves a layout dimension and removes a chronic source of label collisions.
- Perpendicular offset of flow labels bumped from 16 → 20 viewBox units for additional clearance.

---

## [0.5.30.7] — 2026-04-28

Compartment-viz: per-drug units for flows and amounts, wider boxes to stop concentration text overflowing, and flow labels offset perpendicular to the arrow so they no longer collide with arrow strokes or the "Infusion" label.

- `js/ui/compartment-viz.js` — `fmtFlow(rate, drugId)` now expresses fentanyl/ketamine flows in `μg/min` (auto-promotes to `mg/min` only above 1000 μg/min, e.g. mid-bolus on ketamine); propofol stays `mg/min`. `fmtAmount(mg, drugId)` for fentanyl/ketamine: always `μg` below 1000 μg, then `mg`; propofol unchanged. Both formatters now take a `drugId` argument; all call sites updated.
- Box widths bumped: wide layout `160 → 220` (viewBox `700 → 820`); tall layout `180/200/210 → 220/220/280` (viewBox `500 → 540`). Concentration text like `Cp = 0.05 ng/mL` was overflowing the 160-unit boxes at the bumped 19 px font; the new widths give it ~30 viewBox units of margin even at the longest formatting.
- Flow-rate label placement: previously a fixed 8 px above the arrow midpoint, which overlapped horizontal arrow strokes and the "Infusion" topbar word. Now offset 16 viewBox-units along the line's perpendicular, with the perpendicular sign flipped so labels always land "above" the line in screen coords.
- "Infusion" word now uses `text-anchor="end"` and is positioned to the LEFT of the pump arrow's start (instead of horizontally centered at a hardcoded x), so it never crosses into the flow label's territory.

---

## [0.5.30.6] — 2026-04-28

Compartment-viz: ng/mL units for ketamine, and orientation-aware SVG layout to fix the iPad landscape letterboxing.

- `js/ui/compartment-viz.js` — `fmtConc()` now converts ketamine concentrations to ng/mL (previously only fentanyl). Mirrors `CHART_DRUG_CONFIG` in `chart-bridge.js`, where both drugs use `yScale: 1000` + `yLabel: 'ng/mL'`. Drugs needing this conversion are kept in a `NG_DRUGS` set so adding another is a one-liner.
- Replaced the single `BOXES` / `ANCHORS` constants with a `LAYOUTS = { wide, tall }` object. `wide` (viewBox `700 × 420`) is used when the viz host is wider than tall — portrait viewports, where the panel sits below the chart. `tall` (viewBox `500 × 700`) is used when the host is taller than wide — landscape viewports, where the panel sits to the right of the chart. In landscape, the old wide viewBox was letterboxing into ~33 % of the available height; the new tall layout fills it properly.
- `pickLayout()` reads the viz host's bounding rect and switches layouts when needed; `buildSvg()` runs again to lay everything out from scratch. A `ResizeObserver` on the host re-picks on orientation changes; `setActive(true)` also re-picks on entry to the analysis screen so the very first render uses the correct layout.
- Tall layout topology: Effect site top-left, V2 top-right, V1 mid-center, V3 bottom-left, Eliminated bottom-right — same connectivity as the wide layout, just rearranged onto a vertical canvas.
- Box text positions slightly nudged (`title 18 → 22`, `vol 36 → 42`, `conc h-22 → h-28`, `amt h-7 → h-10`) to give the bumped fonts (v0.5.30.5) breathing room.

---

## [0.5.30.5] — 2026-04-28

Compartment-viz readability bump: SVG text sizes increased across the board so the visualization is comfortable at arm's length.

- `index.html` — desktop sizes: `cv-box-title 12 → 16`, `cv-box-vol 10 → 12`, `cv-box-conc 13 → 19`, `cv-box-amt 10.5 → 14`, `cv-flow-label 10.5 → 14`. Mobile (≤640 px) sizes raised analogously: `title 11 → 14`, `vol added at 11`, `conc 12 → 17`, `amt 9.5 → 12.5`, `flow 9.5 → 12.5`. Analysis topbar: `h2 13 → 14`, drug title `12 → 14`, time readout `11 → 12`, back button `11 → 12`. Bumped `#cv-svg max-height 42vh → 48vh` so the SVG has more room when stacked under the chart on portrait viewports.
- All bumps fit within the existing box dimensions and arrow anchor positions — no layout changes needed.

---

## [0.5.30.4] — 2026-04-28

Compartment-viz arrowheads were missing in scrubbed mode but rendering correctly in live mode. Cause: `<marker>` elements referenced via `marker-end` are notoriously flaky on iOS WebKit — particularly when the SVG was hidden via `display:none` during init (the analysis screen starts hidden) and when the line endpoints reverse direction (which happens for bidirectional flows whenever `Cp < C2`/`C3`/`Ce`, common during decay). Live mode happens to avoid most of these states.

- `js/ui/compartment-viz.js` — replaced `<defs>` + `<marker>` arrowheads with inline `<polygon>` elements drawn directly per-frame. `updateArrow()` computes the arrowhead vertices from the line's endpoint and unit direction vector (`HEAD_LEN = 11`, `HEAD_WID = 8`). Arrowhead color follows the line color via the same drug-color CSS variable. No more marker indirection — what's drawn is what's rendered.
- `index.html` — replaced `.cv-arrowhead` / `.cv-ah-elim` rules with `.cv-head` / `.cv-head-elim` to style the inline polygons.

---

## [0.5.30.3] — 2026-04-28

Compartment-viz: pin arrow stroke-width to a constant `2.5 px`, and make the analysis-screen time label diagnostic. Variable thickness was dropping below ~1 device px on small screens at low flow magnitudes (especially when scrubbing into early case time before concentrations have built up), making arrows look like they were "missing" while live mode — almost always with non-trivial flow — looked fine.

- `js/ui/compartment-viz.js` — `updateArrow()`: stroke-width is a flat `2.5`. Magnitude is now conveyed solely by the numeric label (`X mg/min`); arrowhead direction still flips with the sign for bidirectional flows. Removed the now-unused `flowScale` variable and the `Math.max(0.5, params.CL * 5)` initialization in `applyDrugStyling`.
- Time label on the analysis topbar reformatted to `live H:MM:SS · scrub H:MM:SS · showing live|scrubbed` so it's obvious at a glance whether the viz is following the chart's inspect cursor.

---

## [0.5.30.2] — 2026-04-28

Compartment-flow visualization legibility tweak: flow numbers no longer fade with magnitude and arrow stroke-widths vary across a much tighter range. Previously the label opacity was tied to flow magnitude (`min 0.18`), so small but informative flows printed in nearly invisible text; arrows ranged from `0.4 px` (essentially a hairline) up to `8 px` (chunky), which obscured the box structure.

- `js/ui/compartment-viz.js` — `updateArrow()`: removed the per-arrow `opacity` attribute on the flow-rate `<text>` label; line `stroke-opacity` is now a constant `1`. Stroke-width range tightened from `0.4–8 px` (log-scaled) to `1.6–4.2 px` (linear in `min(1, |flow|/flowScale)`). Direction-by-sign behavior unchanged.

---

## [0.5.30.1] — 2026-04-28

Compartment-flow visualization moved out of a modal and into a dedicated retrospective Analysis screen. Modal-overlay pointer events were blocking chart access, which defeated the inspect-cursor link. The analysis screen is a full screen (`#analysis-screen`) with the chart on the left/top and the compartment SVG on the right/bottom (responsive); navigation is via a ⊟ button on the sim topbar and a "← Back to Sim" button on the analysis screen.

- Chart canvas is **teleported** between screens. `enterAnalysisScreen()` moves the existing `.chart-area` DOM node from `#panel-chart` into `#analysis-chart-host` and calls `chart.chart.resize()`; `exitAnalysisScreen()` returns it to its original parent. This reuses the live chart instance — inspect cursor, zoom, dataset, plugins, gestures all carry over without duplicate state.
- `js/ui/compartment-viz.js` — replaced the modal `open()` / `close()` API with `setActive(bool)`. `onFrame` early-returns when not active. SVG and header DOM moved out of the modal into the analysis-screen markup; the module's element lookups (`#cv-svg`, `#cv-drug-title`, `#cv-time-label`) are unchanged.
- `index.html` — removed `#modal-compartment-viz` block; replaced the `COMPARTMENT VIZ` CSS group with `ANALYSIS SCREEN` styles; added `#analysis-screen` with topbar + two-pane content; renamed the topbar button from `#btn-compartments` to `#btn-analyze`.
- `js/app.js` — replaced modal open/close handlers with `enterAnalysisScreen` / `exitAnalysisScreen` helpers; added `chartAreaHomeParent` cache so the chart returns to its original parent when leaving the analysis screen. Sim timer keeps running in the background — the analysis view is non-destructive.

---

## [0.5.30] — 2026-04-28

New self-contained Compartment Flow visualization. A topbar button (next to Settings) opens a modal showing the four PK compartments — effect site, V1 (central), V2 (fast peripheral), V3 (slow peripheral) — with per-compartment volumes, current concentrations, current amounts (in mg/μg), and inter-compartment mass-flow arrows whose stroke width and direction reflect instantaneous mg/min flow. When the chart's inspect cursor is active the visualization scrubs along with it; otherwise it tracks live elapsed time. Designed to be ripout-able: one new module, one modal block, one CSS group, four edits to `app.js`, and one getter line on the chart.

- `js/ui/compartment-viz.js` — new module exporting `initCompartmentViz({ getModel, getSelectedDrug, getInspectTime })`. Builds the SVG once on init; per-frame work is `O(arrows)` attribute writes. Reads PK params via the public `calc{Eleveld,Fentanyl,Ketamine}Params` exports so `simulation.js` is untouched. Flow math: `Pump→V1 = rate`, `V1→elim = CL·Cp`, `V1↔V2 = Q2·(Cp−C2)`, `V1↔V3 = Q3·(Cp−C3)`, `V1→Ce = ke0·(Cp−Ce)` (indicator only — Ce is virtual).
- `index.html` — new `#btn-compartments` topbar button (⊟ glyph) and `#modal-compartment-viz` overlay; ~25 lines of co-located CSS in the existing `<style>` block under `/* ==== COMPARTMENT VIZ (self-contained) ==== */`.
- `js/app.js` — single import, `initCompartmentViz` call after `chartBridge` creation, `compartmentViz.onFrame(t)` chained into the existing `drugPanel.init({ onFrame })` callback, and two button handlers.
- `js/ui/chart/index.js` — added `get inspectTime() { return s.inspectTime; }` next to the existing `inspectEnabled` getter so the viz can poll the cursor time without coupling to chart internals.

---

## [0.5.29.5] — 2026-04-28

Smart decimal formatting for user-set Ce values (target, redose threshold, emergence). They were displayed as `x.x`, which silently rounded a typed-in `1.55` up to `1.6`. They now show two decimals when the hundredths digit is non-zero (`1.55`) and one decimal otherwise (`3.0`). Computed values like steady-state Ce keep their existing precision; live Ce/Cp readouts (`fmtCeHTML`) are unchanged.

- `js/ui/drug-panel/formatters.js` — new `smartDecimal(value, fallbackDp = 1)` and `fmtCeSmart(ceMcgMl, drugId)` helpers; `fmtCeSmart` mirrors `fmtCe`'s ng/mL-for-fentanyl conversion before routing through `smartDecimal`.
- `js/ui/drug-panel/approach.js` — Target / At Target / decay countdown / "Below Redose Threshold" / Emergence labels now use `smartDecimal` (raw mcg/mL) or `fmtCeSmart` (unit-aware).
- `js/ui/drug-panel/index.js` — step-bar redose label uses `fmtCeSmart`.
- `js/ui/drug-panel/exit-readout.js` — `Emerge → X in Y` numeric portion routed through `smartDecimal` instead of `parseFloat(...).toFixed(1)`.
- `js/ui/chart/plugins/target-label.js` — chart right-edge target / threshold / exit pill labels use `smartDecimal`. Steady-state pill stays at `toFixed(2)` (computed value, not user-set).

---

## [0.5.29.4] — 2026-04-27

Set Target rounding override now shows the same explanation note as the setup screen — e.g. `Plan rounds to: bolus → nearest 10 mcg/kg, rate → nearest 5 mcg/kg/min`. Off-state shows the canonical-units hint. Live-updates when the checkbox is toggled.

- `js/util/units.js` — new `getRoundingNoteText(drugId, enabled, opts)` formats the note text. Resolves display units via `getQuantizeConfig(drugId, true)` so it reads the same source as the planner.
- `index.html` — `#keypad-round-note` (uses existing `.rounding-note` class) inside `#keypad-round-row`. Row switched to a column flex so label sits above the note.
- `js/ui/keypad.js` — `updateRoundNote()` helper called when the modal opens in `'ceTarget'` mode and on every checkbox `change`.

---

## [0.5.29.3] — 2026-04-27

Set Target keypad now exposes a one-shot rounding override. The setup screen's "Round TCI plan in display units" flag is unreachable once a case is running, so a clinician who wanted a more exact (or more rounded) plan mid-case had no way to flip it. The keypad modal now mirrors that checkbox in the Ce-target view; toggling it affects only the plan being confirmed and is not persisted — the modal re-opens at the global config value every time.

- `index.html` — new `#keypad-round-row` + `#keypad-round-in-display` inside `#modal-keypad`, hidden by default. Small CSS rule to center-align it above `.modal-actions`.
- `js/ui/keypad.js` — module-scope `currentRoundOverride`, initialised from `localStorage['tci-pref-quantizeInDisplay']` whenever the keypad opens in `'ceTarget'` mode and revealed only for that type. `confirm()` packs `{ roundOverride }` into a new `extras` argument passed to `onConfirm`/oneShotConfirm. Non-ceTarget types pass `null`.
- `js/util/units.js` — `getQuantizeConfig(drugId, enabledOverride)` now accepts an explicit boolean second arg. Backwards-compatible: omitting it preserves the old localStorage read.
- `js/app.js` — `onConfirm` signature gains `extras`; the `'ceTarget'` branch builds `quantConfig` from `getQuantizeConfig(drug, override)` and passes it to `planTCI` (pre-case) or stashes it on `tciModal.setPending` (running-case).
- `js/app/tci-modal.js` — `commit()` reads `quantConfig` off `pendingTCI` and threads it into `planTCI`; falls back to `getQuantizeConfig(drugId)` if absent.

`event-editor.js`-driven replan still uses the global setting only — the override is scoped to the explicit Set Target flow.

---

## [0.5.29.2] — 2026-04-25

Drug-card Ce/Cp readout: hundredths digit now renders smaller (`X.X` at full size, trailing digit at 0.65em with light opacity). Format is uniform across all drugs — propofol was already two decimals, fentanyl and ketamine were one. Both now show two with the same visual treatment, so the readouts line up across drug cards.

- New `fmtCeHTML(value, drugId)` in `js/ui/drug-panel/formatters.js` returns the major+minor split with the trailing digit wrapped in `.ce-frac`. Always two decimals, drug-specific unit (mcg/mL vs ng/mL ×1000) preserved.
- `js/ui/drug-panel/index.js` switches the prominent Ce/Cp display from `textContent` to `innerHTML` and uses the new helper. Other Ce displays (approach line, chart pills, target labels) unchanged.
- Initial markup in `index.html` updated for all three drug cards so the static state matches the live update.

---

## [0.5.29.1] — 2026-04-25

History panel: moved the Reconcile button out of the bottom action row and behind edit mode. The action row was getting crowded with four buttons, and reconcile is naturally tied to the totals shown just above it. Renamed to "Reconcile Totals" so the button reads with the totals it acts on.

- New `.history-reconcile-row` between `.history-totals` and `.history-actions`. Hidden by default; revealed by `body.edit-history-mode .history-reconcile-row{display:block}`. Full-width button inside.
- Action row now holds three buttons (ET/RT, +Add Event, Edit) instead of four.
- Click handler unchanged — still `#btn-reconcile`.

---

## [0.5.29.0] — 2026-04-25

Reconcile modal now respects active TCI plans, mirroring the existing add/edit pathway.

Before: confirming a reconciliation while a TCI plan was running silently mutated history without touching the future plan, leaving the planned events to fire on schedule against an invalidated compartment state — Ce overshoot or undershoot the target the plan was designed to hit.

Now: if the selected drug has any future TCI events at confirm time, the reconcile modal opens the same `#modal-tci-warn` dialog that add and edit use ("This will cancel TCI control and clear all future events from this point forward."). On Continue: future events are cleared, mode drops to manual, the reconcile mutation lands. On Cancel: nothing changes — event list and plan untouched, user can adjust or cancel.

No auto-replan. The user re-engages TCI on their own beat via Set Target.

Implementation:
- `js/ui/event-editor.js` — `showTciWarning(text, onConfirm)` is now exported. Internal callers (the three branches of `applyWithRules`) pass their action as the second arg instead of stashing it in module-scoped `_pendingRuleAction`. Cancel handler also clears the pending action so a stale lambda from one caller can't fire when a different caller reopens the dialog.
- `js/ui/reconcile-modal.js` — `_confirm()` checks `getEvents(drug)` for future `source: 'tci'` events. With any present, routes through `showTciWarning` whose onConfirm runs `clearAfter(drug, NOW)`, drops the drug to manual via `mode.set`, then runs the reconcile mutation. With none, mutation runs directly (matches the silent branch in `applyWithRules`). Mutation logic factored into `_doReconcile(now)` so both branches share it.

Verification: 493 tests still passing. Behavior of add and edit unchanged (same warning copy, same `clearAfter` + mode drop).

---

## [0.5.28.5] — 2026-04-25

Consistent blue active-input border across all numeric entry fields. The patient modal already used `border: 1px var(--blue)` + `inset 0 0 0 1px var(--blue)` for the active field; applied the same treatment to the two other standalone numeric displays:

- `.keypad-display` — used by the main keypad modal (target/rate/bolus/emergence/redose) and the event-editor modal. Always the only input in its modal, so always blue when the modal is open.
- `.rm-value-input` — reconcile modal's actual-total field. Same logic.

Patient-modal `.pm-field.active` already had this and is unchanged. No other standalone number inputs found in the audit (`<input>`s elsewhere are hidden, checkbox, time-picker, or range sliders).

---

## [0.5.28.4] — 2026-04-25

Reconcile modal: tone down. Stripped the fancy entry-field styling — it now matches the standard `.keypad-display` look used everywhere else in the app (subtle border, deep background, no glow, no caret animation). Tightened the info popup copy across all five sections; removed the disclaimer paragraph and the explanatory padding.

---

## [0.5.28.3] — 2026-04-25

Reconcile modal polish — entry-field highlight, volume entry mode, scenario-language rewording.

- **Active entry field is highlighted.** The "Actual total delivered" field now has an amber border, soft glow, and a blinking caret when empty. Reads as a focused input rather than a passive readout.
- **Dose / Volume toggle.** Pump-enabled drugs (propofol always; fentanyl/ketamine when pump is on) get a small "Enter as: [Dose] [Volume]" segmented control above the input. Volume mode lets users enter what the (simulated) pump display reads in mL — internally converted via the drug's pump concentration. Dose mode keeps the existing mg/mcg flow. The "Simulated total" line updates to match the active mode so comparisons stay unit-consistent. Switching modes converts the buffer through canonical mg (e.g., `247 mg` → `24.7 mL`).
- **Info popup language reworded.** The original copy ("when you've lost track during a busy case") read like real clinical use. Reframed to scenario/training language throughout, plus an explicit one-liner: "This is a teaching tool — it is not part of the dosing record for a real patient." Modal subtitle and helper text updated to match.

No engine change. Volume math: `mg = mL × concentration_mg_per_mL`, where concentration comes from `getPumpSettings`. If a drug doesn't have a pump (e.g., fentanyl with pump disabled), the toggle is hidden and the modal stays in dose mode.

---

## [0.5.28.2] — 2026-04-25

Reconcile default flipped back to **single bolus**. The clinical reality is that the common failure mode is a missed sharp event (stopcock push, manual bolus that didn't get logged), not sustained rate drift. Sustained drift requires either repeated logging failures or a pump-vs-display calibration mismatch — both rarer than a missed push.

Single-bolus is also the simpler tool: self-contained, no forward-rebuild caveat, no "now also adjust your set rate" follow-up. Spread mode stays available as the right tool for the user who knows they have a sustained rate mismatch.

- Mode segmented control: "Single bolus" is now the first/active button on open. Time picker visible by default.
- Info popup ("The two modes" section): single-bolus paragraph is first and labelled (default). Spread paragraph follows with the forward-rebuild caveat.

No engine change, no behavior change for either mode in isolation — just defaults and ordering.

---

## [0.5.28.1] — 2026-04-25

Reconcile spread-mode disclosure tweak. The spread reconciliation only fixes the past — it inserts an augmented rate across `[0, NOW]` and a baseline-restore at NOW. Forward of NOW the sim runs at the un-augmented set rate, so if the underlying rate mismatch is still active (pump still running faster than the sim's set rate), the drift rebuilds at the same per-minute rate. Surfaced this in two places:

- **Modal summary** (spread mode): explicit note that forward of NOW the sim returns to the un-augmented rate, and that the user should adjust the set rate to match reality.
- **Info popup** ("The two modes" → spread): full paragraph explaining the same point with guidance to use Change Rate after confirming.

No engine or behavior change — this is purely a clarification fix. Behavior change (e.g., "extend correction forward" checkbox that omits the restore) deferred to a later version pending real-world feedback.

---

## [0.5.28.0] — 2026-04-25

Reconcile dose v2 — second strategy plus an info popup that explains both. Driven by simulations through the engine that turned up a much better approach for the most common error mode.

### What changed

- **New default strategy: "Spread across case".** Adds the missing dose evenly across `[0, NOW]` as a small constant rate offset. For a sustained rate-logging error (the common "I lost track" failure mode) this reconstructs the truth **exactly** — 0.000 % Ce error at every horizon, no convergence wait. The "single bolus at case start" strategy that v0.5.27.1 shipped left 7–17 % Ce residual at NOW for the same scenario.
- **"Single bolus" remains as an alternate.** Best when the user remembers a specific missed event — drag the time picker to when it happened for an exact reconstruction. Case-start fallback is ≤1.5 % Ce error at NOW for any sharp event older than 90 min.
- **Mode toggle in the modal**: a two-button segmented control. Spread is selected by default; flipping to single-bolus reveals the time picker.
- **Info popup (ⓘ button in the header)**: explains the math (LTI, ke0 filtering), the two modes, when to pick which, and concrete "is it worth correcting?" thresholds for both sustained and bolus errors.
- **Spread-mode chart annotation**: amber band over `[0, NOW + 5 min]`. The past portion signals "re-baselined"; the small forward stub gives visible feedback. Spread is mathematically exact at NOW, so no long convergence window is shown.
- **Ghost line dropped from the chart legend.** The purple dashed line only appears during a reconciliation and is self-explanatory next to the live Ce. A persistent legend entry that was unused most of the time just added clutter.

### Math sketch

A sustained `+1 mg/min` deficit over the case is exactly cancelled by adding a sustained `+1 mg/min` to the historical rate events. The `applyRateAugmentation(drug, t0, t1, deltaPerMin)` helper in `js/sim/simulation.js` does this by:
1. Capturing the active rate at `t0` and `t1` before any mutation.
2. Bumping every existing rate event in `(t0, t1)` by `deltaPerMin` via `editEvent`.
3. Inserting an augmented rate event at `t0` (or bumping an existing one).
4. Inserting a "restore" rate event at `t1` set to the un-augmented baseline.

Pause events are not modified — augmenting during an explicit pump pause would deliver drug while the pump was off. Cases with pauses accept tiny inaccuracy in v1.

Validated end-to-end: a synthetic 180-min case with truth at 5 mg/min and sim at 4 mg/min, reconciled via spread, produces 0.000 % Cp/Ce error at t=30, 60, 90, 120, 180 min. Single-bolus at the same scenario leaves 7–17 % Ce residual depending on `T_insert`.

### Threshold guidance (info popup tables)

**Sustained error**: Ce % error at NOW = cumulative dose % error, regardless of case duration. < 5 % is probably not worth fixing; > 10 % is worth fixing.

**Missed bolus** decays fast. A 50 mg bolus is 81 % Ce off at 5 min after, 17 % off at 30 min, 6 % off at 60 min, < 2 % off after 2 hours.

### Files changed

`js/version.js`, `js/sim/simulation.js` (new `applyRateAugmentation`), `js/ui/reconcile-modal.js` (mode toggle + branched confirm), `js/ui/chart/index.js` (legend filter for ghost dataset), `index.html` (new mode segmented control, info-button in header, full info-popup markup + CSS), `CHANGELOG.md`, `DEVELOPMENT.md`.

---

## [0.5.27.1] — 2026-04-24

Two refinements to the dose-reconciliation feature shipped in 0.5.27.0, both prompted by a closer math check.

### Default insert time → case start (was: now)

Forward-curve accuracy is what users actually care about, and it's strictly maximized when `T_insert = 0`. The forward error after a correction at `T_insert` decays as `exp(A·(t − T_insert))`, so pushing `T_insert` further into the past gives the perturbation more time to redistribute before the cursor reaches it. With the case-start default and the standard propofol patient, by `now = 60 min` the intermediate-mode error is already down to ~6.7 % (vs. 100 % when correcting at `now`).

The cost is full retrospective curve perturbation — the historical Ce trace shifts to reflect the correction. Users who care about historical fidelity (e.g. for retrospective BIS analysis) can drag the picker forward.

### Ghost Ce curve

Added a purple dashed line that captures the simulation's Ce up to the moment of reconciliation, drawn alongside the corrected curve. Lets the user compare what the sim was about to predict against what the corrected sim now predicts — a troubleshooting / sanity-check aid.

The ghost runs from `t = 0` to `t = capturedAt` (the `now` when reconciliation was applied). Beyond `capturedAt` the corrected (live) curve takes over. Lifecycle is tied to the reconciliation window: when the window auto-clears (case time passes `endMin`), the ghost clears with it. Persisted across session save/restore.

### Files changed

`js/version.js`, `js/util/constants.js` (`COLORS.ghost`), `js/sim/simulation.js` (`setReconciliationGhost` / `getActiveReconciliationGhost` / `getAllReconciliationGhosts`), `js/ui/chart/{state,index}.js` (ghost dataset + idempotent `setGhostCurve`), `js/app/chart-bridge.js`, `js/ui/reconcile-modal.js`, `js/app/session.js`, `index.html`, `CHANGELOG.md`, `DEVELOPMENT.md`.

---

## [0.5.27.0] — 2026-04-24

**Dose reconciliation.** A new feature for the common case where a busy anesthetist loses track of pump rate changes or manual boluses during a case. The simulation's running total drifts from what was actually given; without a way to recover, users had to start over. With this feature they can enter the real total dose delivered (pump display + any non-pump boluses) and the sim inserts a single correction bolus that restores AUC. The PK system is linear time-invariant, so any two event histories with the same cumulative dose converge to the same state after a few intermediate half-lives.

### Shipped

- **New "Reconcile" button** in the history panel bottom bar, alongside `+ Add Event` and `Edit`.
- **Reconcile modal** (`js/ui/reconcile-modal.js`) shows the drug's simulated total vs. an "Actual total delivered" input. Live-computes the correction bolus (sign-aware — negative deltas are allowed). Lets the user pick where to insert the correction (defaults to `now`, but accepts any past time in either ET or RT). Multi-drug picker when multiple drugs have events.
- **Per-patient convergence window** from the PK A-matrix eigenvalues (`js/pk/eigenvalues.js`). Window = 3 × t½_intermediate, clamped to [15, 120] min. Computes to ~46 min for propofol, ~52 min for fentanyl, ~15 min for ketamine on a standard patient.
- **Chart "reconciling" region** — amber-hashed band spanning `[T_insert, T_insert + window]` on the time axis. Straddles the cursor when `T_insert` is recent; sits entirely in the past when `T_insert` is far back (model has already converged). Idempotent setter on the chart; bridge pushes every frame so the state is self-healing on chart recreation (CLAUDE.md invariant).
- **Drug card amber pulse** (`.reconciling` class) while the window covers `t`. Auto-clears once case time passes `endMin`.
- **Session persistence** for active reconciliation windows in case save/restore.
- **New test suite** (`tests/test-reconcile.js`, 8 tests) covers the extracted `getCumulativeDose`, negative-bolus replay behaviour (net-zero input → Cp decays to zero over 2 h), and the intermediate-eigenvalue half-life math. 493 tests total, all passing.

### Math sketch

The correction bolus restores mass-conservation. At the moment of reconciliation:

```
simulated total mg  =  ∫₀ⁿᵒʷ (bolus + infusion) as-simulated
actual total mg     =  pump cumulative display + manual push doses
delta_mg            =  actual − simulated         (may be negative)
```

We insert a single bolus of `delta_mg` at `T_insert`. Because the 3-compartment model is LTI, any two event histories with the same cumulative input converge to the same state exponentially fast. The dominant non-decayed error after 3 × t½_intermediate is ~12.5 % — small enough that the forward curve is clinically usable by `T_insert + window`. Eigenvalues come from the cubic characteristic polynomial of the A matrix built from `k10/k12/k13/k21/k31`, solved via the same closed-form route SimTIVA uses (per-minute conversion in our implementation; see `js/pk/eigenvalues.js`).

Placing the bolus at a user-chosen past time keeps most of the transient in history. The math converges regardless of where `T_insert` sits inside the case; what changes is how much of the "correction spike" is already water under the bridge by `now`.

### Files added

`js/ui/reconcile-modal.js`, `js/pk/eigenvalues.js`, `tests/test-reconcile.js`.

### Files changed

`js/version.js`, `js/sim/events/query.js` (`getCumulativeDose` extracted from history.js), `js/ui/history.js`, `js/sim/simulation.js` (`setReconciliationWindow` / `getActiveReconciliationWindow` / `getAllReconciliationWindows`), `js/ui/chart/{state,annotations,index}.js` (`setReconciliationRegion`), `js/app/chart-bridge.js`, `js/ui/drug-panel/index.js`, `js/app/session.js`, `js/app.js`, `index.html`, `CHANGELOG.md`, `DEVELOPMENT.md`.

---

## [0.5.26.4] — 2026-04-24

Always stack the Total delivered values vertically (mass over volume) instead of relying on browser wrapping. On an iPad Pro the strip had enough horizontal room to keep `554.5 mg · 55.4 mL` on one line while the `TOTAL DELIVERED` label wrapped onto two — asymmetric and harder to scan. Switched the value container to a two-row flex column, right-aligned, which makes the strip read symmetrically regardless of viewport width. Dropped the `·` separator (no longer meaningful once the values are stacked).

### Files changed

`js/version.js`, `index.html`, `js/ui/history.js`, `CHANGELOG.md`.

---

## [0.5.26.3] — 2026-04-24

Fix wrapping on the Total delivered strip: the number and its unit were breaking onto separate lines on narrow panels (observed on an iPad Pro running the portrait-tablet layout where the history column is tight). Added `white-space: nowrap` to `.ht-value` so `465.5 mg` and `46.6 mL` each stay atomic. Separator and label can still wrap between tokens.

### Files changed

`js/version.js`, `index.html`, `CHANGELOG.md`.

---

## [0.5.26.2] — 2026-04-22

Fix text-size scaling on iPad-class viewports (≥1020 / ≥1200 px) — Large and XL were rendering smaller than Normal.

### The bug

The `body.text-lg` / `body.text-xl` / `body.text-xxl` rules lived inside `@media(min-width:601px) and (min-height:421px)` — sized for phone-class viewports. The `@media(min-width:1020px)` and `@media(min-width:1200px)` blocks bump the Normal baseline above what the text-lg / text-xl block provides for several properties (`.drug-card .ce-current`, `.elapsed-timer`, `.drug-card.active .drug-name`, etc.). Because the text-size selectors still win by specificity, but their values were frozen at phone scale, Normal ended up visually larger than Large or XL on iPad Pro 12.9"/13". Worst offenders: `.drug-card.active .ce-current` was 30 px on Large vs 35 px on Normal at ≥1200 px.

### Fix

Added full `body.text-lg` / `body.text-xl` override sets inside both the `@media(min-width:1020px)` and `@media(min-width:1200px)` blocks so the Normal < Large < XL < XXL hierarchy holds at every viewport. Also bumped existing `body.text-xxl` values at ≥1020 px where XL had surpassed XXL (`.ce-current`, `.ce-current.active`, `.elapsed-timer`, `.step-bar-countdown`).

### Files changed

`js/version.js`, `index.html`, `CHANGELOG.md`, `DEVELOPMENT.md`.

---

## [0.5.26.1] — 2026-04-22

Tweak the new Total-delivered readout so it's always in absolute mass units (not per-kg) and always shows mL.

### Shipped

- **Mass unit is drug-native, not user-preferred.** Propofol and ketamine display mg; fentanyl (and a future remifentanil) display mcg. Hardcoded `TOTAL_MASS_UNIT` map replaces the earlier `getPreferredBolusUnit` lookup — a cumulative-dose readout has no business being expressed as mcg/kg or mL. (The user's per-drug bolus-entry pref is unchanged; it still drives the keypad and the history-row value column.)
- **mL always shown.** Concentration is known per-drug even when no infusion pump is enabled (`DRUG_DEFS[drug].concentration`), so e.g. a 50 mcg fentanyl push in intermittent-bolus mode now reads `50 mcg · 1.00 mL`.

### Files changed

`js/version.js`, `js/ui/history.js`, `CHANGELOG.md`, `DEVELOPMENT.md`.

---

## [0.5.26] — 2026-04-22

Add a cumulative-dose readout to the history panel.

### Shipped

- **Total delivered strip** at the bottom of the history panel (above the ET/RT · + Add Event · Edit action bar). Shows total dose delivered to the current elapsed time for the selected drug in the drug's native mass unit (mg for propofol/ketamine, mcg for fentanyl) plus mL — e.g. `Total delivered  180 mg · 18.0 mL`.
- **Rate integration is bolus-aware**: background rate is suppressed while a bolus is delivering (mirrors `replay.js` semantics where bolus delivery replaces the background infusion for its duration). A bolus still in progress credits a time-proportional fraction of its dose so the readout doesn't step up discontinuously.
- **Hidden until there's something to show.** `<div id="history-totals" hidden>` stays hidden when totals are zero or no events exist, so the bar doesn't add noise before a case starts.

### Update cadence

Computed on every `render(drug)` call (model mutations, drug switch) and also on `updateDimming()` — which the chart bridge already throttles to every 2 s. Totals therefore track elapsed time without an extra rAF subscription.

### Files changed

`js/version.js`, `index.html`, `js/ui/history.js`, `CHANGELOG.md`, `DEVELOPMENT.md`.

---

## [0.5.25] — 2026-04-22

Make the TCI tolerance slider do what its label says, add a drift-band visualization, and make the correction pass portable across drugs with different ke0.

### The original bug

The "TCI target tolerance (% of target)" slider at the top of the Simulation settings tab was persisted to localStorage but never threaded into `planTCI()`. `tciFraction` was only consumed by the drug-panel time-to-target readout. The CET emulation planner hardcoded `tolerancePct = 0.05` (for the loading-bolus and target-decrease gates) and `CE_TOL = 0.015` (for the maintenance-phase drift check) — both invisible to the UI. Diagnostic in `tests/test-tci-tolerance-diagnostic.mjs`; analysis write-up in `TCI-TOLERANCE-ANALYSIS.md`.

### Shipped

- **Slider rebound** to `ceTolerance`, the correction-pass drift tolerance. Label renamed to "Ce drift tolerance"; range remapped from `90..99` (% of target) to `5..30` step `5` (= 0.5%–3.0% in 0.5% increments, default 15 = 1.5%). Old `tciFraction` retired from settings; drug-panel time-to-target readout uses a hardcoded 0.95 internal default.
- **Moving the slider changes the plan.** At the 35 y / 70 kg reference patient and propofol target 3 μg/mL, `0.005` gives 47 maintenance rate steps over 12 hours, `0.030` gives 18 — tradeoff is tighter tracking vs simpler plans.
- **Info text** in the Simulation tab rewritten to describe the new semantic: lower values = tighter tracking + more rate changes; higher values = simpler plans with more visible Ce variation. Notes that the 1.5% default is already tighter than a live clinician could hold manually.
- **Optional drift-band visualization** on the chart. Appearance tab gets a "Show Ce drift band" checkbox (off by default). When on and a TCI target is set, the single dashed target line is replaced by a pair of dashed lines at `target × (1 ± ceTolerance)` — the zone between is the tolerance window. Initial implementation used a low-opacity fill but was imperceptible against the BIS nomogram overlays; dual lines are crisp against any background.
- **`PROBE` (correction-pass binary-search lookahead) is now derived from `ke0`** instead of hardcoded at 15 min. New formula at `emulation.js:459`: `max(10, min(30, 2/ke0))` — i.e. two time-constants, clamped to a 10-min clinical floor and a 30-min ceiling. For propofol and fentanyl this is ~13.7 min (was 15); for a future remifentanil model (ke0 ≈ 0.6/min) it'd clamp to 10. Makes the planner auto-adjust to each drug's equilibration speed without per-drug PROBE tuning.

### Planner experiment — tried and reverted

Attempted peak-aware dual-constraint rate selection (`min(endpointRate, peakRate)`, capping `max Ce` over `MAX_DUR = 90 min` at `target × (1 + CE_TOL)`). Caused clinically significant undershoot during V3 filling: Ce dipped to ~3.0 for a 3.5 target in a 90 kg adult. Root cause is that during V3 filling the rate needed to hold Ce at target *now* is higher than long-term steady-state — the peak constraint was systematically stricter than endpoint, and `min(endpoint, peak)` picked the too-low rate. Documented in `TCI-TOLERANCE-ANALYSIS.md §8` with requirements for any future peak-aware attempt.

### Testing improvements

- New `tests/test-tci-ce-tracking.mjs` — bidirectional tracking test across 4 patient fixtures (70, 60, 75, 90 kg). Asserts `max Ce ≤ target × 1.07`, `min Ce ≥ target × 0.93`, and a hard clinical floor `min Ce ≥ target × 0.90`. Replaces the retired `test-tci-peak-overshoot.mjs`, which only checked the upper bound and would have passed even on gross undershoot. 12 assertions.
- `tests/test-tci-tolerance-diagnostic.mjs` Loop A flipped from "slider is dead" to "slider is wired" — now asserts plans differ across the `ceTolerance` sweep.

### Comments / code documentation

- `js/sim/tci/shared.js:26` — `DEFAULT_SCHEME_CONFIG.tolerancePct` now comments that this is a BINARY-decision knob (loading-bolus + target-decrease gates), distinct from the maintenance-phase drift tolerance `ceTolerance`.
- `js/sim/tci/emulation.js:42, 49, 461` — call sites for `tolerancePct` and `CE_TOL` cross-reference each other so the distinction is hard to miss.

### New documentation

- `TCI-TOLERANCE-ANALYSIS.md` (new). Ten sections covering the original disconnect, a plain-English walkthrough of the CET emulation planner, a code-level deep-dive on the correction pass, SimTIVA's live-sim architecture and preset semantics (read-only reference), design options considered, the ke0 portability fix, the peak-aware experiment (tried / reverted / requirements for a future attempt), tolerance scaling across drugs, and a cross-referenced symbol table.

### Files changed

`js/version.js`, `index.html`, `js/ui/settings.js`, `js/app/settings-ui.js`, `js/app.js`, `js/app/tci-modal.js`, `js/sim/tci/emulation.js`, `js/sim/tci/shared.js`, `js/ui/chart/state.js`, `js/ui/chart/index.js`, `js/ui/chart/annotations.js`, `js/app/chart-bridge.js`, `tests/test-tci-tolerance-diagnostic.mjs` (new), `tests/test-tci-ce-tracking.mjs` (new), `TCI-TOLERANCE-ANALYSIS.md` (new), `CHANGELOG.md`, `DEVELOPMENT.md`.

---

## Session 27 summary — v0.5.24 → v0.5.24.23 (UI polish arc)

Single long session delivering a coherent UI polish pass. 23 interim version bumps grouped into themes below; detailed per-version notes follow. See `DEVELOPMENT.md` for the session narrative.

- **Large type** (v0.5.24 → .2): four-position segmented control (Normal / Large / XL / XXL) scaling drug-panel, history, topbar, bottom-controls, and chart fonts.
- **Drug-card layout + Emergence rename** (.3): eBIS on the drug-name row, Exit Ce countdown moved to an in-flow block, `Exit Ce` → `Emerge` / `Emergence` throughout user-facing text.
- **History UX rework** (.4 → .7): three-button bottom bar `[ET / RT] [+ Add Event] [Edit]`, edit-mode dim/blur, grid row layout.
- **Single-line case time** (.8): `[ CASE START 15:15 | ET 0:00:00 ]` bordered button.
- **Setup screen tightening + Patient Demographics modal** (.9, .11 → .14, .23): summary row on main screen; modal with inline 3×5 keypad, sex-first field order, Next key for numeric-field advance, unit toggle that converts instead of clears; first keypress on prefilled field replaces.
- **Systemic chart-setting re-apply bug** (.10): moved idempotent guards inside chart setters (matching `setFontScale`), dropped stale bridge-level `last*` caches.
- **Phone-portrait layout** (.15, .17, .18): CSS source-order fix; `fmtTick` axis formatter; bottom-bar tighten + `max(18px, env(safe-area-inset-bottom))`.
- **Keypad unit-toggle consistency** (.16): all three keypads now convert buffer + re-arm prefilled.
- **Draggable inspect cursor** (.19 → .22): handle plugin; capture-phase on ancestor; `pan.enabled` flip during drag is what finally stops the iPad hijack.

**New modules:** `js/ui/patient-modal.js`, `js/app/portrait-layout.js`, `js/ui/chart/plugins/inspect-handle.js`.

**New invariants in CLAUDE.md:** chart setters are idempotent; keypad unit toggles convert the buffer through canonical.

---

## [0.5.24.24] — 2026-04-22

Patient modal: fix age field not showing as active on open.

- On first open of the Patient Demographics modal, the Age row didn't render with its `.active` blue border, and tapping Age did nothing — users had to tap Height or Weight first, then come back. Root cause: `_active` was initialized to `'age'` at module scope, so `_selectFirstEmpty()` → `_setActive('age')` short-circuited on the `_active === field` re-tap guard before it could apply the `.active` class. Fix: reset `_active = null` inside `open()` just before `_selectFirstEmpty()` so the first selection in each modal session always runs the DOM sync. The re-tap guard itself is preserved for its intended in-session purpose (preserving `_prefilled` on re-taps).

**Files changed:** `js/version.js`, `js/ui/patient-modal.js`, `CHANGELOG.md`, `DEVELOPMENT.md`, `CLAUDE.md`.

---

## [0.5.24.23] — 2026-04-21

Patient modal flow tuning.

- **Sex toggle moved to top** (above Age). Reflects the natural order of entry: pick sex once (a toggle) before typing numeric data.
- **Next key added to the keypad**. Bottom row is now `[⌫] [Next →]` with Next spanning two columns. Pressing Next advances the active field through `age → height → weight`; disabled when on weight (end of chain). Lets users tap-type-type-type through the whole form without re-tapping each field.

Flow is now: toggle sex → type age → Next → type height → Next → type weight → Confirm.

**Files changed:** `js/version.js`, `index.html`, `js/ui/patient-modal.js`, `CHANGELOG.md`, `DEVELOPMENT.md`.

---

## [0.5.24.22] — 2026-04-21

Third attempt at the inspect-drag hijack. `stopImmediatePropagation` on an ancestor (v0.5.24.21) wasn't enough on iPad — hammerjs's pan recognizer state outlived my event-level intercepts, so after the user's finger crossed hammer's pan-threshold (~10px), pan activated even though my listeners had handled the earlier touchmove events.

Fix: during an active handle drag, flip `chart.options.plugins.zoom.pan.enabled = false` at touchstart/mousedown on the handle, and restore `true` at touchend/mouseup/touchcancel. Pan refuses to run while disabled regardless of hammer's internal state. `stopImmediatePropagation` + capture-phase listener on the canvas parent from v0.5.24.21 stays as defense-in-depth, as does `touch-action: none` on the canvas from v0.5.24.20.

**Files changed:** `js/version.js`, `js/ui/chart/gestures.js`, `CHANGELOG.md`, `DEVELOPMENT.md`.

---

## [0.5.24.21] — 2026-04-21

Actually fix the inspect-drag hijack on iPad.

v0.5.24.20's capture-phase listeners on the canvas weren't firing early enough. Root cause: when the event target IS the canvas, DOM event dispatch fires **all** listeners on that element in registration order during the target phase, regardless of each listener's `useCapture` flag. Chart.js's hammerjs listeners were registered first (at chart creation), so they ran before our capture-flagged listener in that registration order — `stopImmediatePropagation` was too late.

Fix: attach the inspect-drag listeners to `canvas.parentElement` (i.e. `.chart-area`) in capture phase. Capture-phase listeners on ancestor elements run during the real capturing phase, **before** the target phase on the canvas — so we beat Chart.js's hammer listeners with time to spare. `touch-action: none` on the canvas (from v0.5.24.20) stays.

**Files changed:** `js/version.js`, `js/ui/chart/gestures.js`, `CHANGELOG.md`, `DEVELOPMENT.md`.

---

## [0.5.24.20] — 2026-04-21

Two fixes on the draggable inspect handle from v0.5.24.19.

- **Handle moved to bottom of cursor with left/right arrows.** Replaced the top-of-chart circle-with-chevrons knob with a horizontal pill at `chartArea.bottom - 14`, drawn with crisp left (`<`) and right (`>`) chevrons and a subtle halo for touch-target hint. Hit region switched from 22px-radius circle to a 48×32px rectangle around the pill. Visual now reads clearly as "drag horizontally".
- **Drag no longer gets hijacked into page scroll.** On iPad Safari the gesture-recognizer would pick a direction after the first ~50px of movement and take over, scrolling the whole page instead of continuing our handle drag. Two fixes: (1) `touch-action: none` added to the chart canvas so the browser never attempts native scroll/zoom interpretation — Chart.js's own touch listeners still fire normally because `touch-action` only blocks *native* gestures, not JS touch events. (2) `stopPropagation()` upgraded to `stopImmediatePropagation()` in all inspect-drag handlers so any same-element bubble listeners (Chart.js / hammerjs) never get the event. Also added a `touchend` handler that swallows the release so Chart.js doesn't synthesize a click and re-snap the cursor.

**Files changed:** `js/version.js`, `js/ui/chart/plugins/inspect-handle.js`, `js/ui/chart/gestures.js`, `index.html`, `CHANGELOG.md`, `DEVELOPMENT.md`.

---

## [0.5.24.19] — 2026-04-21

Draggable inspect cursor with handle.

When the chart is in inspect mode (ⓘ on) and a cursor is set, a small circular handle now appears at the top of the cursor line. Dragging the handle sweeps the cursor across the chart; the readout panel, inspect dots, and cursor annotation all update live. Pan, pinch-zoom, double-tap-recenter, Y-axis drag, and tap-to-set-cursor all continue to work exactly as before — only touches that start inside the handle's 44px hit area trigger drag.

**Implementation:**

- New plugin `js/ui/chart/plugins/inspect-handle.js` — `afterDraw` hook draws a halo + knob + horizontal chevrons at `(cursorX, chartArea.top + 10)` when inspect is on and a cursor is set. Publishes `s._inspectHandleHit = { cx, cy, r: 22 }` so `gestures.js` can hit-test without recomputing pixel positions.
- `js/ui/chart/gestures.js` — added inspect-drag handlers (touch + mouse). Listeners attached in **capture phase** so they run before Chart.js's internal bubble-phase gesture listeners; `preventDefault()` + `stopPropagation()` on handle-hit touchstart stops Chart.js from interpreting the gesture as pan. Mouse move/up bound on `window` (not canvas) so the drag tracks when the pointer briefly leaves the canvas.
- `js/ui/chart/index.js` — registered the new plugin between `inspect-dots` and `readout-panel`; `attachGestures()` signature gains `setInspectTime` as a parameter.
- No change to `pan.enabled` — pan/zoom pass through unaffected for non-handle gestures.

**Files changed:** `js/version.js`, `js/ui/chart/plugins/inspect-handle.js` (new), `js/ui/chart/gestures.js`, `js/ui/chart/index.js`, `CHANGELOG.md`, `DEVELOPMENT.md`.

---

## [0.5.24.18] — 2026-04-21

More bottom-bar padding on phone portrait. Switched from `calc(6px + env(safe-area-inset-bottom))` to `max(18px, env(safe-area-inset-bottom))` so devices without a home indicator still get 18px of breathing room under the button row, and iPhones with one still get the full OS-reported inset (which is usually more than 18px).

**Files changed:** `js/version.js`, `index.html`, `CHANGELOG.md`.

---

## [0.5.24.17] — 2026-04-21

Phone-portrait bottom bar: tightened button metrics further (`.btn-ctrl` font 9.5 → 9px, padding 5px 6px → 5px 5px, added `min-width:0`; `.mode-label` 9.5 → 9px; `.sim-controls` gap 3 → 2px) so all six controls fit on one row at 390–430px viewports. Stop Pump no longer wraps.

Also added `padding-bottom: calc(6px + env(safe-area-inset-bottom, 0px))` on `.sim-controls` so the row sits above the iPhone home-indicator curve instead of getting clipped by the rounded screen corner.

**Files changed:** `js/version.js`, `index.html`, `CHANGELOG.md`, `DEVELOPMENT.md`.

---

## [0.5.24.16] — 2026-04-21

Consistent unit-toggle behavior across all keypad modals: **keep the value, convert to the new unit, re-arm prefilled so the next keypress overwrites**.

Previously:

- `js/ui/keypad.js setUnit(u)` (Set Target / Change Emergence / Set Rate / Add Bolus / Set Redose Threshold): kept the buffer literally but re-interpreted it in the new unit (so `3.5 mcg/kg` would silently become `3.5 mg`). The bolus mode did a different thing — reloaded the saved last bolus converted, ignoring what the user was typing.
- `js/ui/event-editor.js` unit-toggle (Edit Event): **cleared** the buffer entirely on unit change.
- `js/ui/patient-modal.js` (new case): already converted correctly (v0.5.24.12). Audit confirmed.

Now all three modals round-trip `parseFloat(buffer) → toCanonical(v, prev, drug, task, ctx) → fromCanonical(canonical.value, new, drug, task, ctx) → formatValue(...)` and set the prefilled flag so the next keypress replaces — matching the user's "typing should overwrite after switching units" requirement.

Empty-buffer fallbacks unchanged: `keypad.js` still reloads `tci_lastBolus_{drug}` when the user switches units before typing anything in bolus mode; `event-editor.js` leaves an empty buffer empty.

**Files changed:** `js/version.js`, `js/ui/keypad.js`, `js/ui/event-editor.js`, `CHANGELOG.md`, `DEVELOPMENT.md`.

---

## [0.5.24.15] — 2026-04-21

Phone-portrait layout fixes.

- **Topbar clipping on iPhone portrait.** The phone-portrait rule `.elapsed-timer .ct-start-group { display: none }` was being overridden by a later-in-source base rule `display: inline-flex` — both had identical specificity, so source order won. As a result the "CASE START HH:MM |" segment stayed visible on phones and pushed the gear + New Case buttons off the right edge. Fix: relocate the canonical base rules for `.elapsed-timer`, `.ct-label`, `.ct-value`, `.ct-sep`, `.ct-start-group`, and `.timer-popover` from their original spot (line ~627 in `index.html`) up to the base sim-topbar block (line ~140), before any `@media` blocks. All responsive overrides now win at equal specificity as intended.
- **Chart axis labels rendering raw floats.** X-axis max read `30.00000000000002` and similar when Chart.js auto-computed the scale. Added a `fmtTick(v)` helper in `js/ui/chart/index.js` wired into `ticks.callback` on the x, y, and yRate axes — snaps to 3 decimals, drops the decimal on integers, one decimal otherwise. `30.0` → `30`, `30.00000000000002` → `30`, `11.1` → `11.1`.
- **Phone-portrait bottom bar wrap.** Stop Pump was wrapping to a second row at 390–430px viewports. Tightened `.sim-controls` padding (4px 8px → 4px 6px), `.btn-ctrl` (padding 6px 8px → 5px 6px, font 10px → 9.5px, letter-spacing 0) and `.mode-label` (font 10px → 9.5px, padding 2px 6px) so all six controls fit on one row on iPhone.

**Files changed:** `js/version.js`, `index.html`, `js/ui/chart/index.js`, `CHANGELOG.md`, `DEVELOPMENT.md`.

---

## [0.5.24.14] — 2026-04-21

Follow-up to v0.5.24.13. Tapping a different field in the patient modal now re-arms the "replace on first keypress" state — matches the user's mental model of tapping to edit. Previous release only set the flag on `open()` and unit conversion, so once a flag was consumed by typing, switching to another field and typing would append instead of replace.

- `_setActive(field)` now sets `_prefilled[field] = true` when the target has existing content.
- Re-tapping the currently-active field is now a no-op (preserves in-progress typing state instead of re-arming).

**Files changed:** `js/version.js`, `js/ui/patient-modal.js`, `CHANGELOG.md`, `DEVELOPMENT.md`.

---

## [0.5.24.13] — 2026-04-21

Patient modal: first keypress on a pre-populated field replaces rather than appends — matching the existing `keypad.js` behavior in the sim.

- Added per-field `_prefilled` map (age / height / weight). A field is marked prefilled when its value comes from an external source: hidden inputs on `open()` or a unit conversion in `onUnitsChanged()`.
- On the first digit / decimal keypress, prefilled fields clear their buffer before appending — so tapping Age (which shows `35`) and typing `5` yields `5`, not `355`.
- Clear and Backspace also clear the flag. A single backspace on a prefilled field blanks the whole value (same as the sim keypad's behavior).
- Switching active field via tap does **not** change the flag, only typing does.

**Files changed:** `js/version.js`, `js/ui/patient-modal.js`, `CHANGELOG.md`, `DEVELOPMENT.md`.

---

## [0.5.24.12] — 2026-04-21

Metric/Imperial toggle now **converts** height and weight instead of clearing them. Old behavior was defensive (avoid misreading `170 cm` as `170 in`), but users reasonably expect a unit flip to preserve the entered values in the new units.

- `setUnits()` in `js/ui/setup.js`: when `prev !== next`, converts the hidden `#input-height` / `#input-weight` values between systems using two new exported helpers `_convertLength` / `_convertWeight` (1 cm = 0.393701 in, 1 kg = 2.20462 lbs, both rounded to 1 decimal for display). No-ops on blank values and on same-unit transitions.
- `patientModal.onUnitsChanged()` in `js/ui/patient-modal.js`: when the modal is open, converts the in-buffer `_values.height` / `_values.weight` between units using the shared helpers. Tracks `_lastUnits` to know the "from" side of the transition (set on `open()` and on each `onUnitsChanged` call, even when the modal is closed, so the tracker stays current).
- Applies in both directions: flipping on the main-screen toggle converts hidden inputs (and the summary re-renders); flipping on the modal's header toggle converts in-progress modal buffers and the hidden inputs.

**Files changed:** `js/version.js`, `js/ui/setup.js`, `js/ui/patient-modal.js`, `CHANGELOG.md`, `DEVELOPMENT.md`.

---

## [0.5.24.11] — 2026-04-21

Patient Demographics modal with built-in numeric keypad — eliminates the iPadOS keyboard entirely for patient entry.

**Main setup screen:** the four inputs (age / sex / height / weight) collapse into a single clickable summary row `[ Tap to edit patient demographics ✎ ]` (dim placeholder before entry) or `[ 35y · M · 170 cm · 70 kg ✎ ]` after entry. The underlying `<input>` elements stay in the DOM as `type="hidden"` so everything downstream (`validate()`, `getHeightCm()`, `getWeightKg()`, `updateDerived()`, `confirmPatient()`, restore) is unchanged.

**Patient modal** (`#modal-patient`, new): four field cells (age, sex, height, weight), a Metric/Imperial toggle in the header (kept in sync with the main-screen toggle via the shared `setUnits()` path), a 3×5 numeric keypad (with Clear and Backspace), and Cancel / Confirm buttons. On open, the first empty numeric field auto-selects; tapping any other field switches the active target; keypad feeds the active field. Sex is two toggle buttons, default none (required on confirm). Decimal key is disabled when Age is active. Confirming writes to the hidden inputs and dispatches `input` events so the existing reactive pipeline runs; Cancel discards.

**Why a custom keypad:** on iPadOS, `type="number"` and `inputmode="numeric"`/`"decimal"` still show the numbers-and-symbols keyboard with an ABC switch — there's no way to force a pure numeric pad via HTML on iPad. The app already uses custom numeric keypads for Set Rate / Add Bolus / Set Target in the sim; this brings setup in line with that pattern.

**New module:** `js/ui/patient-modal.js` owns the modal state (active field, per-field buffers, sex, active unit) plus the keypad wiring and validation (age 1–100, height 30–250 cm or 12–98 in, weight 0.5–300 kg or 1–660 lbs).

**Shared units state:** `setUnits()` in `setup.js` remains the single source of truth (localStorage + main-screen toggle state). Tapping Metric/Imperial inside the modal calls back into `setUnits()`; it in turn calls `patientModal.onUnitsChanged()` to re-render modal labels, re-sync toggle state, and clear the modal's height/weight buffers (so a `170 cm` value can't be misread as `170 in`). Unit switches also re-render the summary on the main screen. Skips the clear on the initial `restoreUnits()` call at app load (prev === next).

**Files changed:** `js/version.js`, `index.html`, `js/ui/patient-modal.js` (new), `js/ui/setup.js`, `CHANGELOG.md`, `DEVELOPMENT.md`.

---

## [0.5.24.10] — 2026-04-21

**Bugfix — chart settings not re-applied on new case.** Reported as "Cp line dimming not respected on case startup"; confirmed systemic.

`js/app/chart-bridge.js onFrame()` used closure-level `last*` guards (`lastCpOpacity`, `lastNomogramOpacity`, `lastOverlayOpacity`, `lastEventMarkerSize`) to avoid re-pushing unchanged values each frame. Those guards survived chart destruction in `initSimScreen()`: when a new case started, the fresh chart defaulted to `cpOpacity=1.0`, but the bridge still remembered `lastCpOpacity=0.5` from the previous case, so the value-change check fired false and the setter was never invoked — new chart stayed at full opacity. Same pattern applied to the BIS-nomogram, overlay, and event-marker-size settings.

Fix: moved the idempotent guard into each chart setter (early-return if the incoming value matches chart state), mirroring the pattern already in place for `setFontScale`. Bridge now calls the setters every frame; they no-op when nothing changes, and fire correctly the first frame after a chart recreate because the fresh chart's defaults differ from the user's saved settings. No bridge-level reset needed.

Setters now idempotent: `setCpOpacity`, `setNomogramOpacity`, `setOverlayOpacity`, `setEventMarkerSize` (`setFontScale` already was). New `cpOpacity` field added to chart state to back the guard.

**Files changed:** `js/version.js`, `js/ui/chart/state.js`, `js/ui/chart/index.js`, `js/app/chart-bridge.js`, `CHANGELOG.md`, `DEVELOPMENT.md`.

---

## [0.5.24.9] — 2026-04-21

Tightened the New Case (setup) screen on three fronts:

- **Numeric keyboard always.** Age / height / weight inputs changed from `type="number"` to `type="text"` with `inputmode="numeric"` (age) and `inputmode="decimal"` (height, weight) plus `pattern` attributes. iPadOS Safari shows a pure numeric keypad instead of the full alphanumeric keyboard it sometimes falls back to with `type="number"`. Validation is JS-side via `parseFloat` / `parseInt` — no behavior change.
- **Default numbers clearly dim.** Placeholders (`35` / `170` / `70`) previously rendered at near-full contrast, making them look like real entries. Added `.form-row input::placeholder { color: var(--text-muted); opacity: .45 }` so they read as hints.
- **Less dead space, buttons no longer fall off the bottom.**
  - `.setup-form` padding 14→10px vertical, gap 10→6px.
  - `.input-grid` gap 8 14 → 6 12.
  - Inputs: padding 7 10 → 6 10; font-size 15 → 14.
  - `.error-msg` + `.metric-preview` `min-height:13/15 → 0`, `:empty{display:none}` — no reserved space when there's nothing to show.
  - `.model-info` padding 6 9 → 5 9, margin-bottom 8 → 4.
  - `.pump-settings` padding-top 10 → 6; card-title margin-bottom 6 → 4.
  - `.rounding-note` padding-top 4 → 2; margin-top 4 → 2; `:empty{display:none}`.
  - Responsive rule at `@media(min-width:1020px)` bumped from `16px / 8px 11px` → `15px / 7px 11px` for consistency.

**Files changed:** `js/version.js`, `index.html`, `CHANGELOG.md`, `DEVELOPMENT.md`.

---

## [0.5.24.8] — 2026-04-21

Single-line Case Time display in the topbar.

- Collapsed the two-line `19:26:52 / start 15:15` stack into one bordered button: `CASE START 15:15 | ET 0:00:00` on a single line. Labels muted + uppercase; values crisp monospace (ET in green, Case start in `--text-primary`).
- `.elapsed-timer` is now a `<button>` with a 1px subtle border + hover state (bg brightens, border darkens) so the click affordance reads at a glance — it had always been clickable but never looked like it.
- `.timer-wall-hint` element and CSS rules removed throughout. Canonical base `.elapsed-timer` rule at `index.html:104` consolidated into the single rule near the popover definition (was duplicated before).
- On phone portrait (`orientation:portrait and max-width:500px`) the `Case start HH:MM |` segment hides via `.ct-start-group { display: none }`, leaving just `ET X:XX:XX` to fit the narrow topbar.
- `timer.js renderDisplay()` now writes to `#elapsed-time-val`; `updateWallHint()` writes to `#case-start-val` (dropping the `start ` prefix — the label is in the markup now). Pre-case renders as `CASE START --:-- | ET 0:00:00`. Click handler at `timer.js:29-30` unchanged (still targets `#elapsed-timer`, now the button).

**Files changed:** `js/version.js`, `index.html`, `js/ui/timer.js`, `CHANGELOG.md`, `DEVELOPMENT.md`.

---

## [0.5.24.7] — 2026-04-21

Clinical-style trim pass on v0.5.24.6:

- **Active drug-tile highlight** — dropped the soft inner halo (`inset 0 0 60px -15px var(--drug-color)`). Now just a 6px `border-left` + crisp `inset 0 0 0 2px var(--drug-color)` frame. Full-color but no glow; reads like a clinical device indicator rather than a consumer app accent.
- **Selected history row** — dropped the `transform:scale(1.03)`, the dark ring, and the 28px amber halo. Now a subtle amber tint (`rgba(245,158,11,.18)`) with a crisp `inset 0 0 0 2px var(--amber)` border. The `border-left-color:var(--amber)` overrides the event-type color to reinforce the "this is the one you're editing" signal without any animation.
- **Portrait edit modal position** — when the edit panel opens in the portrait tablet grid layout, the modal now anchors to the top of the viewport (`align-items:flex-start; padding-top:6vh`) so it sits over the chart area instead of covering the history tiles in the bottom-right quadrant. Landscape layout keeps the default centered position (the modal naturally sits over the chart between the drug panel and history panel).
- **ET/RT button** — replaced the single-letter label with a two-state indicator `[ET / RT]` with the active mode highlighted. The inactive mode stays visible but dimmed, so it reads as a toggle affordance at a glance rather than a generic text button. Minimum button width bumped from 52 → 68px to fit the dual label.

**Files changed:** `js/version.js`, `index.html`, `js/app.js`, `CHANGELOG.md`, `DEVELOPMENT.md`.

---

## [0.5.24.6] — 2026-04-21

Four fixes from iPad Pro screenshots after v0.5.24.5:

- **Active drug-tile highlight was too subtle.** Replaced the muted-alpha outer glow with: `border-left: 8px solid var(--drug-color)`, plus two inset box-shadows — `inset 0 0 0 2px var(--drug-color)` (full-alpha 2px inner frame) and `inset 0 0 60px -15px var(--drug-color)` (soft inner halo). All full-opacity `--drug-color`, so the active card now clearly stands out even with inactive cards fully visible.
- **Selected history row in edit mode was barely visible.** `.h-row-selected` now uses `background:rgba(245,158,11,.45)` (up from .22), `outline:3px solid var(--amber)` (up from 2px), plus a dark ring + 28px amber halo and `transform:scale(1.03)` to lift the row off the page.
- **No escape from edit mode without tapping the Edit button.** Added a document-level click listener (capture phase) in `history.init()` — clicking any dimmed element outside the history panel (and outside any open modal) now exits edit mode. New `exitEditMode()` export; click handler clears the button's `.active` state along with the body class.
- **Portrait dynamic row sizing didn't work.** Root cause: `drugPanel.scrollHeight` returns the container's `clientHeight` when content fits without scrolling — so if the grid had already sized the panel larger than its content, `scrollHeight` was that larger size, defeating the "shrink to fit" logic. Fix: sum the children's `getBoundingClientRect().height` + gap instead. Also hooked an explicit `syncPortraitLayout()` call into `showScreen('sim-screen')` (via 2× `requestAnimationFrame`) so the measurement runs once the screen is visible, not while it's still `display:none`. Cap bumped from 50% → 55% of window height.

**Files changed:** `js/version.js`, `index.html`, `js/ui/history.js`, `js/app.js`, `js/app/portrait-layout.js`, `CHANGELOG.md`, `DEVELOPMENT.md`.

---

## [0.5.24.5] — 2026-04-21

Six visual / interaction polish items in one release.

**Edit mode dim & focus** — when the user taps the `Edit` button, the rest of the sim (topbar, drug panel, chart, bottom controls) gets `filter:blur(2px); opacity:.45; pointer-events:none` so the history panel reads as the active tool. Tapping a row marks it with `.h-row-selected` (amber outline + halo) and opens the event editor. The modal's normal dark/blur backdrop is neutralized while in edit mode (`background:transparent; backdrop-filter:none`) so the highlighted row stays visible behind the editor. `clearSelectedRow()` fires on modal close via a MutationObserver on the modal's `.open` class — keeps history decoupled from the event-editor module.

**History row → grid layout** — replaced the flex-column `.h-desc` wrapper with a 2-column / 2-row grid on `.history-row`: `[time | type]` on line 1, `[value centered, spanning both columns]` on line 2. Pause events naturally collapse to single-line because the value row has no content.

**eBIS label demoted** — the `.drug-bis-header` now renders as `<span class="bis-label">eBIS</span> <span class="bis-value">37</span>`. Label is `0.72em` and muted-grey; only the numeric value carries the BIS-band color (`bisColor()` applied to `.bis-value` via inline style). The number-with-color is what conveys depth-of-anesthesia at a glance; the "eBIS" label is just context.

**Active drug-tile glow** — the active card gains a colored halo using the existing `--drug-color` / `--drug-color-muted` per-card variables: `box-shadow: inset 0 1px 0 rgba(255,255,255,.04), 0 0 0 1px var(--drug-color-muted), 0 0 18px -2px var(--drug-color-muted)`. Combined with the existing border-left and `::before` triangle, the active tile is hard to miss without dimming the inactive tiles.

**Dynamic drug-panel width** — replaced fixed `width:280px` / `width:320px` at tablet breakpoints with `width:fit-content; min-width:Xpx; max-width:35vw`. Browser sizes the panel to the widest unwrapped line in any card (typically the drug-model line at XXL), clamped to `min` and `max`. Portrait grid template column now `minmax(280px, max-content) 1fr`. No JS needed — adapts automatically when text-size or content changes.

**Files changed:** `js/version.js`, `index.html`, `js/ui/history.js`, `js/ui/drug-panel/index.js`, `CHANGELOG.md`, `DEVELOPMENT.md`.

---

## [0.5.24.4] — 2026-04-21

History UX + layout polish.

**History** — removed the illegible pencil column and the hidden tap-on-time-cell gesture, replaced with explicit bottom-bar buttons:

```
[ ET ]  [ + Add Event ]  [ Edit ]
```

- `ET` flips to `RT` on tap (wall-clock mode); no longer hides behind a timestamp tap.
- `Edit` toggles a panel-wide `body.edit-history-mode` — while on, every history row gets an amber outline + pointer cursor and becomes tappable (opens the event editor). The button itself gains an amber `.active` state to mirror the other mode toggles.
- Row markup simplified: `[time] | [type] / [value centered]`. Dropped the pump-bolus and IV-push duration detail (troubleshooting cruft), the `.h-detail` span, and the `.h-edit-btn` pencil entirely. Row padding tightened from 7px to 5px vertical.

**Drug panel widths** bumped on tablet breakpoints to give the cards more horizontal room — the Ce/Cp row no longer clips `μg/mL` at XXL:

- `@media (min-width:1020px)`: 250px → 280px.
- `@media (min-width:1200px)`: 285px → 320px.
- Portrait tablet grid column (`@media (orientation:portrait) and (min-width:700px)`): 250px → 280px.

**Portrait dynamic row sizing** — new module `js/app/portrait-layout.js` measures the drug panel's `scrollHeight` and sets `grid-template-rows: 1fr <measured>px` on `.sim-main`, so the chart takes all slack when drug cards are compact. ResizeObserver on the drug panel + `matchMedia` gating so the dynamic sizing only applies in the portrait-tablet layout; on phones/landscape the `.sim-main` inline style is cleared and the base CSS template takes over. Capped at 50% of window height so a pathologically tall drug panel never starves the chart.

Re-synced on text-size change via `applyTextSize()` in `js/app/settings-ui.js`.

**Files changed:** `js/version.js`, `index.html`, `js/ui/history.js`, `js/app.js`, `js/app/settings-ui.js`, `js/app/portrait-layout.js` (new), `CHANGELOG.md`, `DEVELOPMENT.md`.

---

## [0.5.24.3] — 2026-04-21

Drug-card layout reshuffle and rename `Exit Ce` → `Emerge / Emergence` throughout the UI.

**Layout changes driven by XXL iPad Mini screenshots** where eBIS was clipped, the Exit Ce banner was squeezed against the drug name, and the Cp → At Target narrative was at risk of being interrupted by a new eBIS row.

- **eBIS moves to the drug-name row** as a new right-justified header element (`.drug-bis-header`), color-coded via `bisColor()`. Header-level prominence matches how clinicians scan for depth-of-anesthesia; `:empty { display:none }` collapses the element on non-propofol cards and pre-case.
- **Emergence line moves to bottom of card** between the status row and the step-bar area, in the existing red color. Preserves the Cp / At Target visual adjacency (they're now vertically next to each other with nothing between them).
- **Propofol gets units back:** `Ce 3.48 │ Cp 3.45 μg/mL` — single trailing unit (shared between Ce and Cp). Fentanyl/ketamine updated to match the shared-unit style for consistency.
- **Rename in user-facing text:**
  - Drug-card readout: `Exit Ce 3.0 in 3:39` → `Emerge → 3.0 in 3:39` (parallels the existing `Rate → …` line).
  - Reached state: `Exit Ce Reached` → `Emergence Reached`.
  - Button: `Set Exit Ce` / `Change Exit Ce` → `Set Emergence` / `Change Emergence`.
  - Keypad modal title + confirm button: `Set Emergence` / `Change Emergence` (dynamic title swap when a value is already set, mirroring the intermittent-threshold flow).
  - Internal symbols unchanged (`.btn-ctrl-exit`, `.exit-readout`, `setExitLine`, `getExitCeForDrug`, `exitCe` state field) — renaming those would balloon the diff for no user benefit.

**Mechanics:**

- `.exit-readout` dropped from absolutely-positioned top-right floater to an inline block child of `.drug-card`. Line-height bumped slightly so wrapping (when it occurs on compact layouts) reads cleanly.
- `.drug-header-row` uses `display:flex; justify-content:space-between; align-items:baseline` so drug-name and bis-header align at the baseline regardless of their font sizes.
- `.drug-bis-header` large-type bumps: Normal 13 → Large 15 → XL 17 → XXL 19; active-card variant 17 → 20 → 23.
- Compact media queries (`max-width:900 and max-height:420`, phone portrait `max-width:500`) hide the bis-header and fall back to `white-space:normal` on `.exit-readout` so the emerge line wraps rather than overflows on tight screens.

**Files changed:** `js/version.js`, `index.html`, `js/ui/drug-panel/index.js`, `js/ui/drug-panel/exit-readout.js`, `js/ui/mode.js`, `js/ui/keypad.js`, `CHANGELOG.md`, `DEVELOPMENT.md`.

---

## [0.5.24.2] — 2026-04-21

Adds a fourth "XXL" option to the Text size segmented control, and renames the Appearance-tab label from "Text size (drug panel & history)" to just "Text size" (accurate now that the scope is global).

**XXL ladder:** ~+45% from base. Examples — `.drug-name` 13 → 19px, `.drug-name.active` 17 → 25px, `.ce-current` 22 → 32px, `.ce-current.active` 27 → 39px, `.history-row` 11 → 16px, `.btn-ctrl` 12 → 17.5px, `.elapsed-timer` 16 → 23px, chart fontScale 1.45.

**Gated behind `@media (min-width:1020px)`** — only applies when the drug panel widens to 250px+ at the existing desktop breakpoint. On narrower screens (phones, iPad Mini portrait) the `.text-xxl` body class is still set but the CSS rules do not match, so the layout falls back to base sizes and avoids wrapping the Ce row. Chart fontScale still applies since it is pushed through JS.

**Files changed:** `js/version.js`, `js/ui/settings.js` (TEXT_SIZES adds `xxl`), `js/app/settings-ui.js` (`applyTextSize` handles `text-xxl`), `js/app/chart-bridge.js` (TEXT_SCALE adds `xxl: 1.45`), `index.html` (new XXL button + CSS block + label rename), `CHANGELOG.md`, `DEVELOPMENT.md`.

---

## [0.5.24.1] — 2026-04-21

Expands "Large type" from drug-panel + history to every small-text element on the sim screen — based on iPad Mini screenshots showing plenty of unused space and several glaring misses at the previous scope (big Ce readout, chart text, topbar, bottom controls, and a step-bar countdown that was disappearing into ellipsis at XL).

**Added to the large-type CSS block** (`index.html`, already gated behind `@media (min-width:601px) and (min-height:421px)`):

- `.ce-current` and `.ce-current.active` now scale (22 → 25 → 28; active 27 → 30 → 34). These were intentionally excluded in 0.5.24 to protect the fixed-width Ce row from wrapping — bumps are modest and verified to fit on a 210px panel.
- Topbar: `.app-name`, `.patient-summary`, `.elapsed-timer`, `.btn-new-case`, `.btn-settings` (gear).
- Bottom controls: `.btn-ctrl` (Change Target / Change Exit Ce / Set Rate / Add Bolus / Stop Pump) and the `.mode-label` pill.
- `.step-bar-countdown` gets `white-space:normal; text-overflow:clip; min-height:0` when large-type is on, so the rate + countdown line ("Rate → 110.0 mcg/kg/min in 1:12") wraps to two lines instead of truncating to "Rate → 110.0 mcg/kg/min in ...". Actionable info no longer disappears at XL.

**Chart.js text scaling** (doesn't read CSS):

- New `setFontScale(scale)` on the chart controller in `js/ui/chart/index.js`. Stores `s.fontScale` in chart state and rescales `chart.options.scales.{x,y,yRate}.{ticks,title}.font.size`, `chart.options.plugins.legend.labels.font.size`, then rebuilds annotations. Base sizes are held in a `BASE_FONTS` constant so the scale multiplier always applies to the canonical base, not a previously-scaled value. Internal early-return on same-scale keeps it idempotent and self-synces a freshly-created chart after `initSimScreen`.
- Canvas-drawing plugins now multiply their hardcoded font sizes by `s.fontScale`:
  - `js/ui/chart/plugins/target-label.js` — target/threshold/SS/exit pill labels (base 10px).
  - `js/ui/chart/plugins/readout-panel.js` — inspect-mode time/Ce/Cp/eBIS/Rate panel (base 11px, line-height 14px also scales).
  - `js/ui/chart/annotations.js` — BIS band labels (base 9px) in `buildAnnotations`.
- `js/app/chart-bridge.js onFrame` pushes the mapped scale (`normal → 1.0`, `large → 1.15`, `xl → 1.30`) into `chart.setFontScale()` every frame. The idempotent guard lives on the chart side so chart recreation (new case) picks up the scale on the first frame without needing a bridge-level reset.

**Files changed:** `js/version.js`, `index.html`, `js/ui/chart/index.js`, `js/ui/chart/state.js`, `js/ui/chart/annotations.js`, `js/ui/chart/plugins/target-label.js`, `js/ui/chart/plugins/readout-panel.js`, `js/app/chart-bridge.js`, `CHANGELOG.md`, `DEVELOPMENT.md`.

---

## [0.5.24] — 2026-04-20

"Large type" option in the Appearance settings tab. Segmented control with three levels — Normal / Large / XL — that bumps drug-panel and history informational text by roughly +15% and +30%. The `.ce-current` and `.cp-current` readouts are deliberately left alone since they are already large, so the Ce row stays on one line.

**Implementation:**

- New `textSize` setting (`'normal' | 'large' | 'xl'`) in `js/ui/settings.js` with validator and persistence.
- `body.text-lg` / `body.text-xl` CSS classes in `index.html` override `font-size` on targeted drug-panel selectors (`.drug-name`, `.drug-approach`, `.drug-status`, `.drug-rate`, `.drug-bis`, `.drug-model`, labels, `.cp-current`, `.step-bar-countdown`) and history selectors (`.history-row`, `.h-time`, `.h-type`, `.h-detail`, `.history-empty`).
- Overrides are wrapped in `@media (min-width:601px) and (min-height:421px)` so they do not fight the compact-layout rules on phone landscape (`max-width:900 and max-height:420`) or small portrait phones (`max-width:500`). The cards grow taller, not wider; the drug panel is already `overflow-y:auto` so the extra height simply scrolls.
- Segmented-control UI in the Appearance pane, styled with new `.seg-group` / `.seg-btn` classes. `js/app/settings-ui.js` applies the body class on load and on change, persisting via `setSettings`.

**Files changed:** `js/version.js`, `js/ui/settings.js`, `js/app/settings-ui.js`, `index.html`, `CHANGELOG.md`, `DEVELOPMENT.md`.

---

## [0.5.23.1] — 2026-04-20

Fix chart-control button state at the start of a new case. The chart's internal toggles (`inspectEnabled`, `eventAnnotationsEnabled`) reset to `false` whenever `initSimScreen` destroys and recreates the chart, but the `.active` CSS class on the tooltip and event-markers buttons persisted across case boundaries — leaving the buttons lit while the chart showed neither inspect panel nor future-event markers. The expand button's glyph/`.active` class and the `sim-content.chart-expanded` layout class had the same problem. `initSimScreen` now clears all four button states (tooltip, events, expand glyph + class, and the expanded-layout class) before creating the new chart so the DOM matches the fresh chart state.

---

## [0.5.19] — 2026-04-11

Opt-in "Round TCI plan in display units" mode. Makes every bolus and rate emitted by the planner line up with pump-enterable numbers in the clinician's chosen display units (e.g. integer mL/h, multiples of 10 mcg/kg).

**Design principle — quantize inside the loop, not after:**

The naive fix (rounding the planner's final output to display units) introduces stacking errors because each iteration of the maintenance loop advances the engine with the *un-rounded* canonical value, so rounding error compounds. The correct fix is to quantize **inside** the planning loop — every `engine.advance()` call uses the already-quantized value the pump will actually deliver.

**Implementation:**

- New `quantSteps` tables in `DRUG_TASK_UNITS` (`js/util/constants.js`) define per-drug per-display-unit step sizes (propofol mL/h: 1, mcg/kg: 10, mcg/kg/min: 5; fentanyl mcg: 5, mcg/kg/min: 0.01; ketamine mg: 5, mg/kg: 0.1, etc.).
- `quantizeInDisplay(canonicalValue, displayUnit, drugId, task, ctx)` in `js/util/units.js` snaps a canonical value to the nearest step in the display grid and returns it in canonical units. No-op when no step is defined for that unit.
- `getQuantizeConfig(drugId)` reads `tci-pref-quantizeInDisplay` + the drug's stored `tci-pref-{task}Unit-{drug}` keys and returns a config object the planner threads through.
- `makeQuantizers(cfg)` in `js/sim/tci/shared.js` produces `qBolus`/`qRate` closures applied inside all four planners (`js/sim/tci/stepped.js`, `cet.js`, `cet-conservative.js`, `emulation.js`) *and* in `appendTerminalRates()` (`shared.js`). Closures are no-ops when the flag is off, so all 426 existing tests remain green.
- Emulation planner's legacy `Math.ceil(bolusMg)` and `rnd(r) = Math.round(r*360)/360` paths are gated behind `!cfg.quantizeInDisplay`; when quantize is on the `rnd` closure snaps through the user's chosen display unit (`qRate(r*60)/60`), and the adaptive-correction pass quantizes `rate` before the forward-probe extension loop so probe duration matches the rate the pump will actually deliver.
- Conservative→CET delegation passes the already-quantized bolus as `bolusOverrideMg` so it isn't double-snapped.
- Terminal rates (long-lookahead binary-search + analytical SS) are quantized before being appended.

**UI (opt-in):**

- New checkbox "Round TCI plan in display units" in the propofol setup panel (index.html). Flag is drug-agnostic — one checkbox governs every drug, since the planner reads each drug's own stored display-unit pref.
- Live-updating rounding-note line under every drug's unit selectors showing exactly what grid the planner will use, e.g. "Plan rounds to: bolus → nearest 10 mcg/kg, rate → nearest 1 mL/h". Note dims when the checkbox is off and reads "Planner rounds in engine-canonical units (mg / mg/min)."
- `populateRoundingControls()` in `js/ui/setup.js` wires listeners on the checkbox and all six unit selectors so the note reflects current selection in real time.
- Preference persisted under `tci-pref-quantizeInDisplay` in localStorage; re-saved on confirm in `applyPumpSettings()`.

**Tests:**

- 25 new quantization tests in `tests/test-units.js` covering every drug/unit grid, idempotence, round-to-nearest semantics, weight-dependent snapping, zero/NaN passthrough, null-step fallback.
- 4 new stacking-error regression tests in `tests/test-tci-scheme.js` using an inline quantize-in-loop planner variant. Proves (a) every rate in the scheme is an integer mL/h value, (b) Ce at 30 min stays within ±8% of target, (c) bolus is a whole mg, (d) engine state is preserved.
- **455 tests across 13 suites, all passing.**

---

## [0.5.18] — 2026-04-11

Per-drug default unit selectors and PK model provenance display on the setup screen.

**Model info display:**

Each drug setup panel now shows a `.model-info` block listing the PK/PD model provenance under the drug selection tabs — e.g. "Eleveld 2018" for propofol, "Shafer 1990 with Shibutani 2004 weight correction" for fentanyl, "Domino 1982 / Navarrete 2000" for ketamine. Names and descriptions come from exported `MODEL_NAME` / `MODEL_DESCRIPTION` constants in each `js/pk/<drug>.js`.

**Default unit selectors:**

Every drug gained per-task default unit dropdowns in its setup panel (bolus unit + rate unit, populated from the drug's `DRUG_TASK_UNITS.allowed` list). Persisted to localStorage under `tci-pref-{task}Unit-{drug}` and consulted by the keypad and drug panel on every open — so a clinician who prefers mcg/kg/min over mL/h sees that unit pre-selected everywhere, without having to flip it each time. Existing runtime unit overrides still work and still persist per-task.

---

## [0.5.14] — 2026-04-09

Split manual-mode infusion analysis into two independent systems: analytical steady state and slope-reversal plateau detection.

**Analytical Steady State:**

- Compute true Ce_ss via `−A⁻¹·B·rate` (pure matrix math, no simulation needed)
- Forward-simulate at 1-min resolution to find time to reach 95% of Ce_ss
- Backward scan from horizon end rejects transient band crossings (e.g. Ce passing through band on the way down after rate reduction)
- Green dashed line on chart at Ce_ss with "SS" right-margin label
- "Steady State X.XX in M:SS" countdown in drug card text

**Slope-Reversal Plateau Detection:**

- Entry: sustained low-slope window (15 consecutive minutes below slope tolerance)
- Mandatory slope reversal: pre-entry direction must differ from post-entry direction
- Monotonic approach to steady state is NOT a plateau — returns `noPlateau: true`
- Scan-based reversal detection catches slow V3 turnarounds up to EXIT_HORIZON minutes past sustain end
- Plateau entry marked at START of 15-minute sustained window
- Amber bounding box on chart + separate "Plateau" text line in drug card

**Bug fix:**

- Time-to-SS detection: changed from forward scan (first entry into 95% band) to backward scan (last exit from band). Fixes false positive where Ce transiently crosses the band while decaying through it, undershoots, then slowly recovers from below.

**421 tests across 13 suites, all passing.**

---

## [0.5.6] — 2026-04-06

Responsive tablet layout, drug panel readability improvements, history panel restructure, and chart label enhancement.

**Responsive layout (iPad support):**

- **Split chart + history on tablet (≥1020px):** At iPad widths (iPad 10th gen 1080px, iPad mini 7th gen 1133px, and larger), the chart and history panels are shown side by side instead of tab-switching. Chart takes ~2/3 width, history takes ~1/3 with independent scrolling. Breakpoint chosen to be safely above iPhone 17 landscape width (932px) so phone behaviour is unchanged.
- **Chart expand toggle:** New `⤢` button in chart controls (tablet only) collapses the history column and gives the chart full width; click `⤡` to restore the split view.
- **Larger fonts and wider drug panel at ≥1020px and ≥1200px:** Drug panel widens (210→250→285px), Ce font 22→26→30px, topbar height 34→42px, form inputs/buttons scale proportionally. Content tabs hidden on tablet (redundant with split view).

**Drug panel readability:**

- Base font sizes increased across all screen sizes: `drug-name` 12→13px, approach 9.5→10.5px, status/rate 10→11px, step-bar-countdown 9→10px, Cp value 11→12px, Ce/Cp/BIS labels 9→10px.
- Further increases at tablet breakpoints (≥1020px: approach 11.5px, status/rate 12px, countdown 11px; ≥1200px: approach 12px, countdown 12px, drug-name 15px).
- Step-bar countdown right-justified (`text-align: right`) so elapsed times align vertically across all drug tiles.
- Step bar turns red (`var(--red)`) when Ce falls below the intermittent redose threshold; reverts to drug color when counting down or during bolus delivery. Applied to both selected and non-selected tiles.

**History panel:**

- Timestamps changed from `text-muted` to `text-secondary` for better readability.
- Event rows restructured into two lines: event type (small/muted, e.g. "IV Push", "Rate") on the first line; dose or rate value (bold) on the second line. Consistent across bolus, rate, and pause events.
- IV push delivery time was hardcoded to "10 sec push" regardless of dose; now computed from actual volume at 3600 mL/h (1 mL/s) with a 1-second minimum. Added `pushDeliveryMinutes()` to `js/util/constants.js`.

**Chart:**

- Threshold line label now two lines: "Threshold" on top, the numeric Ce value (to 2 d.p.) underneath. `drawRightLabel()` extended with an optional `label2` parameter to support multi-line right-margin labels.

**Bug fix:**

- Non-selected drug tiles: step bar was not turning red when below intermittent threshold. The non-selected code path set `barPct = 100` (meaning the dark inner fill covered the entire bar), hiding the red wrap background. Fixed to `barPct = 0`.

**359 tests across 12 suites, all passing.**

---

## [0.5.1] — 2026-04-06

Bug fixes and PK model corrections for fentanyl and ketamine.

**PK model corrections:**

- **Fentanyl — Shafer 1990 parameters corrected**: V1=7.35 L, V2=33.94 L, V3=275.62 L, CL=36.47 L/h, Q2=207.71 L/h, Q3=99.22 L/h, ke0=0.1195 /min. Previous values were incorrect.
- **Fentanyl — Shibutani 2004 inclusion criteria fixed**: PK mass formula now applies only when TBW ≥ 85 kg **and** BMI > 30 — the actual entry criteria from the 2004 derivation study. Previous threshold (TBW > 80 kg, no BMI check) incorrectly triggered the correction for tall lean patients and created a non-physiological discontinuity at the boundary. `pkMass()` now accepts `(tbw, bmi)`; `calcFentanylParams()` computes BMI from `patient.height`.
- **Ketamine — Domino/Navarrete parameterization**: Fixed population micro-constants (K10=0.4381, K12=0.5921, K21=0.2470, K13=0.5900, K31=0.0146 /min; ke0=0.238 /min); V1=0.063×weight, all other volumes and clearances derived from V1 and fixed Kij. Previous model was based on Domino 1982 alone with different scaling.

**Bug fixes:**

- **Non-selected tile approach line frozen**: `$(dId + '-approach')` was never written for non-selected drugs — it kept the last rendered HTML from when the drug was selected. Now updated every frame via `_nonSelectedCache`.
- **Non-selected tile `predictTrough` called 60×/sec**: No cache existed for non-selected intermittent drugs, causing up to ~2000 engine advances per frame. Added `_nonSelectedCache` keyed by event count: `predictTrough` is called once per bolus, then `arrivalMin − t` is used for the live countdown (matching the selected-drug behaviour).
- **Fentanyl/ketamine not restored from saved state (events)**: `eventsByDrug` serialisation loop was restricted to `['propofol']` with a `// extend for multi-drug` comment. Fentanyl and ketamine events were never written to the save blob.
- **Fentanyl/ketamine not restored from saved state (mode/threshold)**: Mode and `ceTarget` collection likewise only covered `['propofol']`. Intermittent thresholds were also not saved at all. All three drugs' modes and thresholds are now saved and restored.

**359 tests across 12 suites, all passing.**

---

## [0.5.0] — 2026-04-05

Multi-drug tracking: fentanyl and ketamine with intermittent bolus mode.

**New features:**

- **Fentanyl PK model** (Shafer 1990, 3-compartment, ke0 from Scott 1985): live Ce/Cp tracking in ng/mL, separate drug card, IV-push–only administration
- **Ketamine PK model** (Domino 1982 / Clements 1982, 3-compartment): live Ce/Cp tracking in ng/mL, separate drug card
- **Intermittent bolus mode**: new mode selectable per drug (via "Intermittent" button). No infusion pump — IV-push boluses only. User sets a Ce redose threshold; approach line shows "Redose in M:SS" or "Redose now". History filtered to bolus events only. Mode-switch button relabeled "Set Infusion Rate" to transition back to infusion.
- **Threshold line on chart**: amber dashed horizontal line at the redose Ce threshold, with right-margin label, analogous to TCI's orange target line
- **Per-drug chart y-axis**: fentanyl and ketamine display in ng/mL (×1000 scaling); y-axis range and label persist to localStorage per drug; propofol unchanged in μg/mL
- **Redose countdown via matrix engine**: `predictTrough()` used for unlimited-lookahead redose timing — not limited by chart curve length, essential for ketamine's slow Ce decay (200–600 min)

**UI improvements:**

- All drug tiles update Ce/Cp, status label, and step-bar every frame from case start — no longer requires clicking each tile to wake it up
- Step-bar colors inverted: container shows drug color (full = ready), dark fill grows left-to-right as time elapses (depletes to dark as the interval expires)
- Non-selected intermittent tiles show "Redose in M:SS" countdown via `predictTrough()` even when not the active tile
- Pre-start clock is now per-drug — queuing a propofol bolus no longer delays fentanyl/ketamine events; all induction drugs can be stamped at t=0 simultaneously
- BIS nomogram bands clear when switching to fentanyl or ketamine (no validated PD model)

**346 tests across 11 suites, all passing.**

---

## [0.4.2] — 2026-04-04

Follow-up bug fixes to 0.4.1.

**Bug fixes:**
- Pinch-zoom snapped to current time on finger lift: the two `touchend` events fired when releasing a pinch were being interpreted as a double-tap, calling `recenter()`. Fixed by tracking `wasMultiTouch` and skipping the double-tap logic after any multi-touch gesture.
- Auto-scroll fought pinch-zoom mid-gesture: `onZoomStart` callback now disables auto-scroll immediately when the pinch begins, preventing `setCursorTime` from calling `zoomScale` with stale range before `onZoomComplete` fires.
- Ce target label cut off / overlapping nomogram bands: replaced the annotation plugin label (which is clipped to the chart area) with an `afterDraw` canvas plugin that draws the label directly in the 65px right-margin padding.
- BIS nomogram bands in wrong order: `ceForBIS(N)` returns the Ce needed to achieve BIS=N, so lower BIS = higher Ce; bands were reversed. Corrected to `[ce90→ce80]` Red, `[ce80→ce60]` Orange, `[ce60→ce40]` Yellow, `[ce40→ce20]` Green.
- Pump control button renamed "Pause Pump" → "Stop Pump".
- Syntax error from bad indentation of inline Chart.js `plugins` array.

**Housekeeping:**
- Extracted `APP_VERSION` into `js/version.js` — the single source of truth for the version number. `constants.js` re-exports it as `APP_VERSION` so no other files need changing on future releases.

---

## [0.4.1] — 2026-04-04

UI polish, bug fixes, and chart improvements.

**Bug fixes:**
- Zoom snap-back: chart now holds its pinch-zoomed position across data refreshes (syncs `scales.x.min/max` to tracked `viewMin/viewMax` before each update)
- Manual pump stop during TCI pause: the duplicate-pause guard was blocking the stop button when TCI had scheduled a `rate=0` interval; now correctly clears all future TCI events and stops the pump

**Chart:**
- Ce Target annotation label moved to the right margin (65px layout padding + `position:'end'`) so it no longer covers active data
- BIS nomogram: 4 correctly-ordered bands — Red (Light Sedation BIS 80–90), Orange (Deep Sedation 60–80), Yellow (GA 40–60), Green (Deep Anesthesia 20–40); alpha raised from 9% → 19% for visual distinction; previous bands were in wrong Ce order (lower BIS = more drug = higher Ce)
- Hover/tap tooltip now shows `Rate: X.X mcg/kg/min` between the Ce/Cp lines and BIS

**UI labels:**
- Pump control button renamed "Pause Pump" → "Stop Pump"
- Drug panel: TCI-scheduled `rate=0` shows "Paused"; manual pump stop shows "Pump Stopped"
- History panel: TCI `rate=0` events render as "Paused [TCI]"; `pause`-type events render as "Pump Stopped"

---

## [0.4.0] — 2026-04-04

Initial versioned release. Core simulation complete and cross-validated.

- Eleveld 2018 PK-PD model (propofol)
- Matrix-exponential engine — arbitrary time steps, no accumulation error
- Four TCI planners: stepped, CET, CET-conservative, emulation
- SimTIVA cross-validation at 0.0000% Cp deviation (262 tests passing)
- PWA with mobile-first landscape UI
- Event history with edit/delete, system events preserved
- Multi-drug support: propofol, fentanyl, remifentanil, ketamine
- Configurable pump settings persisted to localStorage
- App version displayed on setup screen
