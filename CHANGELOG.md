# Changelog

## Versioning Scheme

| Format | Meaning |
|--------|---------|
| `1.0` | Reserved for public release |
| `0.x` | Major updates — new features, architectural changes |
| `0.x.x` | Minor updates — incremental improvements, additions |
| `0.x.x.x` | Bug fixes |

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
