# TCI Sim — Claude Code Reference

Mobile-first PWA for anesthesia training. Simulates propofol (Eleveld 2018), fentanyl (Shafer 1990 + Shibutani 2004), and ketamine (Domino 1982 / Navarrete 2000) pharmacokinetics with Target Controlled Infusion (TCI) planning. Current version lives in `js/version.js` (single source of truth — never state or hardcode it elsewhere except `sw.js`, see Workflows).

## Commands

No build step — pure ES modules served as static files. `index.html` is the single-page entry point; `js/app.js` boots everything.

```bash
python3 -m http.server 8080     # serve locally (any static server works)
node tests/run-tests.js         # full test suite — must be 100% green before any commit
```

## Architecture in One Paragraph

The engine (`js/pk/engine.js`) stores compartment amounts as a `Float64Array[5]` and advances via matrix exponential — any step size, no accumulation error. The event list (bolus/rate/pause) is the source of truth; concentrations at any time are computed by replaying events through the engine. `js/sim/simulation.js` is a pure command/query facade — no internal clock or state machine. The UI owns time display and playback. TCI planners generate arrays of `{type, time, value}` events that get inserted into the event list.

## Invariants — Do Not Break

- **Engine time unit is minutes.** `simtiva-reference.js` converts internally to seconds; everything else uses minutes.
- **`findActiveBolus` uses strict less-than boundaries.** Boundary collisions (e.g. a rate change at the exact end of a bolus) require the explicit scans in `addRate`/`addPause` — do not rely on `findActiveBolus` alone.
- **Cramér's rule is the eigenstate pattern.** When syncing SimTIVA eigenstate (`ps1/ps2/ps3`) to engine reality, use the 3-sample Cramér's rule refit (`refitEigenstate()`), never second-by-second replay.
- **System events stay visible.** Rate-restore events (`source: 'system'`) render in history as dimmed italic rows — never filter them from the UI. Separately: TCI-sourced boluses deliberately create **no** rate-restore (`addBolus` skips it when `source === 'tci'`) because the plan's own rate steps define post-bolus delivery; only manual boluses generate one.
- **Quantize inside the planning loop, not after.** When `cfg.quantizeInDisplay` is set, apply `qBolus`/`qRate` (from `makeQuantizers`) **before** every `engine.advance()`. Rounding planner output as a final pass stacks error across maintenance-loop iterations.
- **`DRUG_IDS` is the iteration source of truth** (`js/util/constants.js`) — multi-drug loops in `app.js`, `session.js`, `chart-bridge.js` consume it. `remifentanil` is in `DRUG_DEFS` but not `DRUG_IDS` (no PK model yet).
- **Chart setters are idempotent; the bridge calls them unconditionally.** `setCpOpacity`/`setNomogramOpacity`/`setOverlayOpacity`/`setEventMarkerSize`/`setFontScale` early-return on unchanged values, and `chart-bridge.js onFrame` pushes settings every frame with no cache. This makes chart recreation (New Case) self-healing. Do not reintroduce bridge-level `last*` caches on these setters.
- **Keypad unit toggles convert, they don't clear.** `keypad.js`, `event-editor.js`, `patient-modal.js` round-trip the buffer through `toCanonical → fromCanonical` on unit change and re-arm `prefilled = true`.
- **The Next Up panel never promises a counter-factual.** `exit-readout.js` answers "if you stopped now" while the pump runs, and SS/plateau assume the current rate holds. `js/ui/next-up.js` therefore surfaces Emergence only when `getEmergenceArrival().isIdle`, and `collectUpcoming` drops any milestone with a scheduled pump event before it. Do not relax either guard to make the list fuller.
- **Pump events and clinical forecasts get separate horizons in `collectUpcoming`.** A TCI plan is dense (dozens of steps over hours) so it needs `horizonMin`/`maxItems`; a forecast is sparse and legitimately distant (a ketamine redose threshold sits hundreds of minutes out) so it gets `milestoneHorizonMin`/`maxMilestones`. Never merge them back under one budget — that regression silences exactly the drugs with nothing else scheduled.
- **Below the redose threshold is not the same as due — direction decides.** `checkBelowThreshold` compares Ce to the previous sample on the first frame below: falling means it fell through and alarms at once; rising (or unknown) enters the same wait-and-watch state a dose does, resolving silently if Ce crosses upward or firing if Ce peaks below. Without this, arming a threshold mid-upswing alarms instantly for a dose that simply has not peaked. `js/pk/decay-predictor.js` carries the same idea as `hasBeenAbove`.
- **A dose only silences the redose alert while it is taking effect.** `settings.js` owns the occurrence lifecycle (`checkBelowThreshold` / `noteRedoseDose`): a dose sets `dosedAt` and the panel goes quiet, then once Ce falls away from its post-dose peak *while still under threshold* the alert re-arms, counting from that dose. Peak-relative, not a fixed timer, so it tracks each drug's own onset. Never make "a dose clears it" permanent — an inadequate top-up then silences the panel for the rest of the case while the drug card still reads "Below Redose Threshold". `collectUpcoming` deliberately does **not** decide this: "was that dose enough?" needs Ce's direction, which an event list cannot answer.
- **Milestone acknowledgement keys must be occurrence-scoped.** `drugId:kind` is a per-drug slot that never leaves `liveKeys`, so a `cleared`/muted entry against it can never be pruned and one tap silences that drug's redose for the whole case. `milestoneKey()` appends an `occurrence` token; `next-up.js` builds it from `getRedoseGeneration()` plus whether the item is latched.
- **A crossed redose threshold latches; it is not a user action.** `approach.js` reports `belowThreshold`, `settings.getBelowSince(drugId)` stamps the crossing, and `collectUpcoming` keeps the item as `elapsed` with its own budget (exempt from `elapsedLookbackMin`/`maxElapsed`) until a tap or a bolus at/after the crossing clears it. Never let it expire on its own — the chime fires at that instant, so a self-clearing row alarms about something it just removed.
- **An unacknowledged overdue item owns the Next Up clock, counting up.** Skipping to the next item while the panel pulses red made the alarm read as belonging to that next item. `_renderClock` prefers `i.elapsed && _isActionable(i) && !_alarmMuted.has(i.key)` (oldest first — `collectUpcoming` guarantees elapsed items lead ascending, and `tests/test-upcoming.mjs` pins it). The count-up must use raw `t - item.time`: `_remSec` routes pump events through `displayedSecToEvent`, which floors at 0 for `source:'tci'` once `reactionDelaySec > 0`, freezing the display at `-0:00`.
- **`nextUp.render(t)` must never default `t` to 0.** A rebuild against a zero clock makes every event look pending, poisons `_seenFuture`, and brings already-performed actions back as `missed`. It defaults to the live clock via `_now()`.
- **Only genuinely-pending items can be reported as `missed`.** `collectUpcoming` gates elapsed rows on the caller's `seenFuture` set — an event the user creates at the clock (manual bolus, Stop Pump) was never outstanding. This is not a `source` filter: a manually-added *future* event can genuinely be missed.
- **`pharmacology.js` is GPL-3.0.** Never import, bundle, or copy code from `/mnt/project/pharmacology.js`. Reference only.

## Code Map

Explore with Glob/Grep for details; this is orientation, not an index. Four files are thin re-export shims over directories of the same name: `js/sim/events.js`, `js/sim/tci-planner.js`, `js/ui/drug-panel.js`, `js/ui/chart.js` — edit the modules inside the directory, keep the shim's export surface stable.

```
js/pk/        PK-PD models (eleveld, fentanyl, ketamine, pd), matrix engine,
              decay + steady-state predictors
js/sim/       events/  event list: replay, query, CRUD, actions (findActiveBolus)
              tci/     planners (stepped, cet, cet-conservative, emulation) +
                       shared.js (DEFAULT_SCHEME_CONFIG, makeQuantizers)
              simulation.js (facade), simtiva-reference.js (clean-room eigenvalue math)
              upcoming.js (pure: classifyFutureEvents + Next Up curation)
js/util/      constants.js (DRUG_DEFS, DRUG_IDS, DRUG_TASK_UNITS, pump settings,
              PUMP_MANDATORY), units.js (conversion + quantize), math.js,
              event-label.js (formatEventAction — one formatter, 3 variants)
js/ui/        chart/ (index, annotations, gestures, plugins/), drug-panel/,
              settings, keypad, event-editor, patient-modal, setup, history,
              next-up (Next Up HUD), mode, timer, controls, persist, alert-sound
js/sync/      cloud sync: patient pull, case/template push-pull, dose templates
js/app.js     entry point + wiring; js/app/ has settings-ui, tci-modal, session,
              chart-bridge (per-frame updates), portrait-layout
js/version.js APP_VERSION — bump here (and sw.js) only
```

## TCI Planners

| Mode | Key characteristic | Function |
|---|---|---|
| `stepped` | Conservative, binary-search bolus | `planTCIScheme` |
| `cet` | Fast onset, peak-matched bolus | `planTCISchemeCET` |
| `cet-conservative` | SimTIVA-style, rate-corrected bolus | `planTCISchemeCETConservative` |
| `cet-emulation` | SimTIVA deliver_cpt port, best accuracy | `planTCISchemeEmulation` |

**Production uses `cet-emulation` only** (factory default; the setup picker is hidden unless `localStorage['tci-dev-planners'] === 'true'`). `stepped`/`cet`/`cet-conservative` are retained for development but never shipped — `simulation.js planTCI` still dispatches all four by `tciMode`.

The emulation planner maintains a parallel SimTIVA eigenstate (`ps1/ps2/ps3`); after any Ce-boost `engine.advance()`, call `refitEigenstate()` before resuming Cp-targeting. `computeRateCorrFactor` in `simtiva-reference.js` takes `(rawBolusMg, peakTimeSec, maxRateMgSec, e_coef, lambda)` — not pump-rate scalars — and simulates Ce second-by-second to find the correction duration. Full algorithms and validation data: `TCI-PLANNERS.md`.

## Pump Settings

- Always read via `getPumpSettings(drugId)` — never hardcode 750 ml/h or 10 mg/mL. `maxRate` is auto-derived (`bolusRateMlH * concentration / 60` mg/min).
- **Concentration is saved per-case**: `session.js save()` records a `pumpConcentrations` map and `restore()` prefers it over the live global, so old cases replay at the concentration they were planned under. **8.33 mg/mL propofol is non-sticky** (`NONSTICKY_PROPOFOL_CONCS`): valid for the live case and its save, but never persisted as the setup default.
- The global max pump rate has two UI controls (setup screen `#input-max-pump-rate` and Settings → Simulation `#set-max-pump-rate`) kept in lockstep via `setup.js setGlobalMaxPumpRate()`. Changes affect subsequent plans/boluses only — no automatic replan.
- `pumpEnabled` is per-drug delivery method. Propofol is pump-mandatory (`PUMP_MANDATORY`); fentanyl/ketamine default to manual — when pump is OFF, `mode.js updateModeUI()` hides rate controls and locks the drug to intermittent IV-push boluses.

## Settings & LocalStorage

User settings live in `js/ui/settings.js` (`getSettings()`/`setSettings()`, one JSON blob under `'tci-warn-settings'`); the `DEFAULTS` object there is the authoritative key/default/range list. UI wiring is in `js/app/settings-ui.js`. To add a setting: extend `DEFAULTS` + its validator, add the `<input>` to the matching tab in `index.html`, wire it in `settings-ui.js`.

Keys persisted outside the blob — note the working-vs-default unit split:

- `tci-pref-{bolus|rate}Unit-{drug}` — **working** (in-case) display unit, mutated by mid-case keypad/editor swaps; reseeded on New Case.
- `tci-pref-{bolus|rate}Unit-{drug}-default` — **setup default**, owned by the setup screen (`getSetupDefaultUnit`). Deliberately decoupled so mid-case swaps never overwrite the setup default.
- `tci-pref-quantizeInDisplay`, `tci-pump-enabled-{drugId}`, `tci-pump-max-rate`, `tci-pref-history-show-notations`, `tci-sync-code`, `tci-dose-template`, `tci-dose-template-armed`; pump settings and saved cases via `js/ui/persist.js`.
- **Preferences cloud-sync** (`js/sync/prefs-sync.js`): `prefsManifest()` is the single list of keys that push/pull under the pairing code (kind `prefs`). When adding a persisted preference key, add it to the manifest (or deliberately exclude it there with a comment). `applyPrefs` only ever writes manifest keys — never extend it to arbitrary payload keys.

## UI Conventions & Gotchas

- **Emergence naming**: the "time until Ce decays to a target" concept is labelled **Emerge → / Emergence** in all user-facing text, but internal symbols (`exitCe`, `setExitLine`, `.btn-ctrl-exit`, `#<drug>-exit`, …) intentionally keep the old `exit` names — do not rename them.
- **Prefilled keypad buffers replace on first keypress**: pre-populated buffers are flagged `prefilled`; the first digit/decimal/backspace clears instead of appending, and switching fields re-arms the flag.
- **Notations are not PK events**: editorial notes live in the `annotations[]` array (`addAnnotation`/`deleteAnnotation` in `app.js`), merged time-sorted into history with events ranked before same-timestamp notes — except notes with `pre: true` ("Case Started"-style announcements) which rank first. Drug-tagged notes show only in that drug's history.
- **Chart gesture handling**: `gestures.js` binds inspect-handle drag listeners on `canvas.parentElement` in **capture phase** so they beat Chart.js's hammer listeners, and disables `plugins.zoom.pan` during an active handle drag (iPad pan hijacking). Keep `touch-action: none` on the canvas.
- **Portrait layout measures with `getBoundingClientRect()`**, summing children — `scrollHeight` lies when content fits inside a larger container (`js/app/portrait-layout.js`).
- **Dim/bright buttons** (`mode.js`): controls are muted by default; full color + glow only with `active-mode`. Clinical look — no halos or transforms.
- New chart overlays get a setter on `js/ui/chart.js` plus a propagation step in `chart-bridge.js onFrame`; user-dimmable overlays plumb through `_overlayAlpha`/`_nomogramOpacity` in chart scope so they survive annotation rebuilds.

Detailed UI/UX history and rationale for all of the above: `DEVELOPMENT.md` (session log).

## Versioning

`js/version.js` is the single source of truth; `sw.js` `VERSION` must stay in lockstep (service-worker reload keys off both).

- `1.0` — reserved for release
- `0.x` — major revisions or feature additions
- `0.x.x` — minor revisions and feature changes
- `0.x.x.x` — bug fixes and tweaks

Patch numbers may go multi-digit (`0.3.14.15` is valid). **Never bump a higher level because a lower level looks "full"** — `0.5.9 → 0.5.10` is correct; `0.5.9 → 0.6.0` for a routine patch is not.

## Workflows

- **Every code change** (not docs-only): bump `js/version.js` + `sw.js` per the scheme above, add a `CHANGELOG.md` entry and a matching "Interim" block at the top of `DEVELOPMENT.md`, and confirm `node tests/run-tests.js` is green before committing.
- **Commits open a PR by default** on `narcolepticdoc/tcisim` via the GitHub MCP tools, unless the user says otherwise.
- **Before follow-up commits to a branch that already has a PR, check the PR's state first** (`mcp__github__list_pull_requests` with `head: narcolepticdoc:<branch>`, or `pull_request_read`). Open → keep committing, push updates it. Merged/closed → do **not** reuse the branch (push won't reopen it); branch off current `HEAD` (`git checkout -b claude/<descriptive-name>`) and open a new PR. Re-run this check after every merge.
- **Adding a drug**: implement `js/pk/<drug>.js` exporting `MODEL_NAME`, `MODEL_DESCRIPTION`, `calc<Drug>Params(patient)`; register in `DRUG_DEFS`, `DRUG_IDS`, `DRUG_TASK_UNITS`; wire `simulation.js modelNames`; add `chart-bridge.js CHART_DRUG_CONFIG` entry; add setup tab + drug card markup in `index.html`.
- **Editing a TCI planner**: thread `cfg` through and call `makeQuantizers(cfg)` so the planner participates in display-unit rounding; in the emulation planner, `refitEigenstate()` after any direct `engine.advance()`.

## Docs

- `ARCHITECTURE.md` — engine, event system, module responsibilities
- `TCI-PLANNERS.md` — planner algorithms, validation data, remaining gaps
- `DEVELOPMENT.md` — complete session log, known issues, roadmap
- `CHANGELOG.md` — versioned release notes
- `DEPLOY.md` — Vercel + Upstash cloud-sync backend setup
- `SCRATCHPAD-SYNC-SPEC.md` — sender-side contract for cloud patient sync
- `LICENSE-NOTES.md` — clean-room implementation notes, file audit
