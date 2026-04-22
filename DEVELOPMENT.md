# Development History & Roadmap

> Single source of truth for session history. SESSION-HISTORY.md has been retired and its content merged here.

## Session History

### Interim — Total-delivered readout in history panel (v0.5.26)

*Branch: `claude/add-drug-amount-display-rWPVg`.*

User asked for a way to see total amount given per drug, in the drug's dose unit and in mL. Options considered were a footer line on the drug card or a totals row at the bottom of the history panel; the history panel won because it's already the "what happened" surface and has room without crowding the drug card.

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
