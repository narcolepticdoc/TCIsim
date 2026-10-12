# Case Log — Implementation Plan

**Status:** proposal, not started. Scoped 2026-10-12 against v0.6.4.17.
File:line references are as of that version and will drift.

**Goal:** keep a log of past cases, not just the most recent one. Let older cases
be opened for review, on the device and through cloud sync.

**Estimate:**
- Phase 1, the device log with a read-only summary: **2–2.5 weeks**.
- Phase 2, the cloud log: **about 2 more weeks**.
- Phase 3 (full chart replay, auto-push, continue-from-end) is optional: **1–3 weeks**, depending on what is picked.

---

## 1. Where things stand

**Device.** There is one slot, `localStorage['tci-sim-last-case']` (`persist.js:16`).
- `saveCase` overwrites it on every `chart-bridge.refresh()`, even a drug-card tap (`chart-bridge.js:280-281`).
- The blob has `v`, `savedAt`, patient, events per drug, `wallClockStart` (ISO), modes, Ce targets, thresholds, emergence targets, `pumpEnabled`, `pumpConcentrations`, `bolusRateMlH`, reconciliation windows/ghosts and annotations. It is typically 2–20 KB.
- `CASE_SCHEMA_VERSION = 1`. Additive fields keep v1. `loadCase()` refuses newer schemas.

**Cloud.** One Vercel function, `api/sync.js`, backed by Upstash Redis and keyed by a 6-character pairing code.
- Kinds: `patient` (scratchpad contract, frozen), `case`, `template`, `prefs`.
- `case` is one last-writer-wins key per code, `tcisync:{code}:case`, with a 24 h TTL that is reset on every push, and a 64 KB cap.
- Push and pull are manual only (`app.js` ~716-775). A pull writes the slot and calls `session.restore()`.
- There is no delete, of anything. The rate limit is 60 requests/min per IP, shared by all kinds.

**Restore.** `session.restore()` resumes a case. It never just views one.
- It applies the case's pump settings to the live globals.
- It re-anchors boluses to *today's* global pump rate.
- It sets the clock to now − `wallClockStart` (`timer.js:96-99`).
- It adds a "Case Restored" note and autosaves.

## 2. Why this is more than storage

Four things stop any current code path from opening an old case safely:

1. **No case identity.**
   - Nothing distinguishes "the same case saved again" from "a new case", and `savedAt` is re-stamped on every save.
   - `wallClockStart` cannot serve as an id: it can be edited or null, and `save()` builds it from two clock reads, so it varies by a millisecond.
2. **No end marker.**
   - Nothing records when a case ended. A TCI infusion simply carries on at its steady-state rate up to "now".
   - The usual way a case ends is the app being closed, which leads to a cold start where `newCase()` never runs.
3. **Restore falsifies an old case.** Restoring a 72 h-old case would:
   - show propofol at about 3 µg/mL, still "Infusing", with about 23 g "Total delivered";
   - re-anchor every bolus to today's pump rate;
   - write the case's concentration into the live globals;
   - save all of that back over the slot.
4. **The live machinery fires on a dead case.**
   - Redose thresholds chime within 1–3 min (`checkBelowThreshold`, `drug-panel/index.js:119`).
   - Next Up marks every planned TCI step "missed".
   - Autosave runs on every refresh.

## 3. Decisions to make first

| # | Decision | Options | Recommendation |
|---|---|---|---|
| D1 | Where the log lives | device only / cloud / device + JSON export | **Device first** (Phase 1), cloud second (Phase 2). Device needs no server and raises no privacy questions, and most of the logic lives there anyway. The cloud matters for durability: reinstalling the iOS PWA wipes localStorage (`prefs-sync.js:6-7`). Export/import is **M**, not S: there is no file I/O anywhere today, and iOS standalone needs `navigator.share({files})`. |
| D2 | View-only or resumable | view / resume / continue-from-end | **Older cases are view-only.** Restore Last Case keeps resuming the slot, whatever its `endedAt`. Continue-from-end is Phase 3 (M). |
| D3 | What "view" shows | summary sheet / full chart replay | **Summary sheet** in Phase 1: patient, start/end, per-drug totals, merged event + note timeline. Chart replay in Phase 3 (L), if wanted. |
| D4 | Where the log opens from | setup screen / also mid-case | **Setup screen.** The summary sheet uses an isolated model, so opening it mid-case costs only about S more. Chart replay mid-case is the expensive one (L): it loses redose latches and Next Up acknowledgements, and silences live alarms. |
| D5 | Retention | — | Device: about 50 cases or about 1.5 MB, evicting the oldest, never the slot. Cloud: 30 days (like template/prefs), at most about 50 cases and about 2 MB per code, the clock running from the *first* push (EXAT) so re-pushing does not extend it. |
| D6 | Cloud push | manual / automatic | **Manual per row.** Optional opt-in "push at case end" in Phase 3. Manual was a deliberate earlier choice (`DEVELOPMENT.md` ~2262). |
| D7 | Privacy | — | Today a case sits in the cloud for 24 h behind the code. A log keeps weeks of demographics, dated case timelines and notes, and one list request returns them all. Make the cloud log **opt-in**, add **delete** (one case, and everything under a code), and allow **no free-text labels**. If scratchpad demographics could ever be real patients, store the time of day only (no date) and cap age at 90 in the cloud copy, or skip the cloud log. A separate high-entropy log key is L. |
| D8 | What counts as a case | — | Log only cases that were **started** (`wallClockStart != null`). "No user events" is not enough: armed starting doses queue events at confirm, before Start. |
| D9 | End time for pre-log saves | — | Use the latest of: the last user event or pause, the last note (excluding the restore note), and `savedAt − wallClockStart`. Flag it as approximate in the viewer. Record an explicit end from now on. |

## 4. Phase 1 — device case log and read-only summary (2–2.5 weeks)

### 1a. Case identity — S–M
- Mint a `caseId` in a testable `session.beginCase()`, next to `resetCaseCarryOver()`, called from setup `onConfirm` (`app.js` ~606). That is the entry point every case passes through, cold start included. Today `onConfirm` lives inside `boot()`, which no test imports.
- Use `crypto.randomUUID`, falling back to `crypto.getRandomValues` (no `randomUUID` over plain-http LAN).
- Carry the id through `save()`. `restore()` takes it from the blob, and `newCase()` clears it. The field is additive, so the schema stays v1.
- **Id-less blobs arrive mid-session as well as at boot:** a pull of a case pushed by an older app, or a restore of an old slot.
  - At every entry point (boot, pull, restore), stamp the id with a **raw slot write that bypasses the archive hook**. Otherwise the next save sees the id change and archives the case into itself, leaving a duplicate.
  - Derive ids for legacy blobs **deterministically**: patient + `wallClockStart` rounded to the second + first event. The same old case pulled twice is then one entry.

### 1b. Recording the end — S–M (required, not optional)
- Add `endedAt`, `endMin` and `appVersion` to the blob.
- Save on `pagehide` / `visibilitychange: hidden`. That is the commonest way a case ends, and today nothing saves there. The only `visibilitychange` listener is the update check in `sw-register.js:118`. This is cheaper and more accurate than a 60 s heartbeat.
- `newCase()` does a final save **only when the slot's caseId equals the live caseId and the case was started**.
  - An unconditional save would let an empty, just-confirmed case B overwrite case A in the slot.
  - That would push A into the view-only log and break the accidental-New-Case recovery that Restore Last Case exists for (`app.js:176-181`).
- `restore()` clears `endedAt`/`endMin` when it resumes.
- Flag the "Case Restored" note (e.g. `sys: true`) and exclude it from `caseEndMin`.
- Keep a `lastActiveMin` that restore's own save does not advance. Otherwise restoring yesterday's case and pressing New Case records an end time about 24 h late.
- Consider opening the summary sheet, not resuming, when the slot's `savedAt` is more than N hours old.

### 1c. Log store — M
- Keep `tci-sim-last-case` as the live slot. Add an index key `tci-case-log` and one key per archived case, `tci-case:<id>`, all in a new `js/ui/case-log-store.js`.
- **One archive hook, in `saveCase`.** When the incoming caseId differs from the slot's, archive the outgoing slot first. That one place covers New Case, cold-start confirm and cloud pull.
- **Wrap the archive step in its own try/catch**, separate from the live write.
  - Read the **raw** slot JSON, not `loadCase()`. That returns null for schema > 1, which would let a newer-schema slot be overwritten instead of archived.
  - List newer-schema entries as "update this device", never drop them.
- Strip `reconciliationGhosts` when archiving (about 300 B per case-minute).
- Add list, load-by-id and delete. Evict by count and bytes **before** the live write, never instead of it.
- On `QuotaExceededError`: evict and retry. Today `persist.js:51-53` swallows the error, which would silently stop the running case's autosave.
- Stay on localStorage: IndexedDB is not warranted at this size.
- Housekeeping:
  - The new keys go in the exclusion comment in `prefs-sync.js` and the test at `test-prefs-sync.js:54`; `prefsManifest` is an allow-list. The caseId never syncs as a pref.
  - Add the new module to `sw.js` PRECACHE_URLS.

### 1d. Viewer model, isolated from the live case — S
- `normalizeCase(blob)` pulls restore()'s fallbacks into one function: `'intermittent'`→`'none'`, missing `pumpConcentrations` / `bolusRateMlH` / `pumpEnabled`. Restore and the viewer then cannot drift apart.
- `buildModelFromCase(blob)` sits next to `cloneModel` (`preview.js:90-107`):
  - It builds a fresh model and calls `registerDrugConfig` with the case's **own** concentration and saved `bolusRateMlH`. **There is no re-anchor.**
  - Then it calls `rehydrateEvents`.
  - It never touches `setPumpSettings`, mode, timer, settings, Next Up or the slot.
  - `setPatient` re-registers config from the globals, and `registerDrugConfig` afterwards overrides it, as `cloneModel` already does.
- Loop over `DRUG_IDS`, not `Object.entries(blob.events)` (`preview.js:61` does the latter). Archived, cloud and imported blobs are untrusted.

### 1e. `summarizeCase(blob)` — S–M
- **Reuse `sim/case-stats.js` `computeDrugStats`** (added in v0.6.5 for the Totals tab). It already gives per-drug totals, the push/pump split, the pump window and the average pump rate from an event list. Feed it the throwaway model's events, its `getBolusDelivery`, and `endMin` as `now`. `ui/case-totals.js collectTotals` shows how; the viewer needs its own rendering with explicit concentration and weight.
- Start date/time, duration to `endMin` (not `savedAt`), drugs used, patient in the user's units, and per-drug totals.
- Totals come from the throwaway model's own `getBolusDelivery`, integrated to `endMin`, the way history does (`history.js:266-273`). `getCumulativeDose` alone falls back to the *live* pump settings for bolus durations (`query.js:26-29, 49-53`).
- **Pass the case's concentration explicitly** to every `toCanonical`/`fromCanonical` and to the mL total. Since v0.6.4.17, `units.js` falls back to the *live* pump concentration, which belongs to the live case, not the archived one (CLAUDE.md invariant). Pass the case patient's weight too: `history.js` uses `_getPatient()?.weight || 70`, which is 70 kg on the setup screen.
- Compute totals once, at archive time.
- Rework `getSavedCaseSummary` (`persist.js:94-104`) to use it. Today it shows no date, hardcodes kg and counts system events.

### 1f. Case log screen — M
- Add a "Case log (N)" button on the setup screen, opening a scrollable list with View and Delete. Restore Last Case stays as it is.
- **List = slot + archive, deduplicated by caseId.** The newest case is not archived until the next case saves, and a pulled case can sit both in the slot and as an older archived copy. Deleting the slot's row also removes Restore Last Case, so define that behaviour.
- Make it its own `.screen`, or add a busy guard.
  - On the setup screen, a detected service-worker update activates and **reloads immediately** (`sw-register.js:83-90, 99-105, 123-135, 150-173`; it checks every 60 s and on foreground).
  - A modal over `#setup-screen` leaves `isOnSetupScreen()` true, so the page would reload mid-browse or mid-delete.
- Build rows with `textContent`. Pulled blobs are untrusted, and the restore label uses `innerHTML` (`app.js:192-193`).
- Layout: give it its own scroll container, because `html,body` are `overflow:hidden` (`index.html:65`). It must fit the 380 px-tall landscape layout and the text-size setting.

### 1g. Summary sheet — M
- Patient, start/end, totals, and a merged timeline of events and notes.
- **Extract a pure row builder** from `history.js` (merge and ordering rules at ~425-466) that takes weight and concentration as arguments.
  - Exporting only `esc` would let the sheet drift from the note ordering CLAUDE.md requires: events before same-time notes, `pre: true` notes first.
  - `history.js` is bound to the live `_model`.
- System rate-restore rows are shown dimmed and italic, never filtered out (CLAUDE.md invariant).
- Label the sheet with the `appVersion` it was recorded under. Replay uses the current PK code, so curves and totals may differ slightly from what was shown at the time.

### 1h. Cloud-pull path — S
- Archive the outgoing local case instead of losing it. Once that exists, the confirm at `app.js` ~763 can be softened.
- **Keep the confirm strict when the caseIds match** (or compare a content hash). Example: push from this device, keep working, then pull the older cloud copy. Archive-on-id-change does not fire, and the newer local work is overwritten.
- *(Already done in v0.6.4.17: the pull now calls `resetCaseCarryOver()`.)*

### 1i. Tests and housekeeping — M
Tests, version bump (a feature, so 0.6.5 or 0.7 by the CLAUDE.md scheme), CHANGELOG, DEVELOPMENT Interim block. Add a CLAUDE.md note on the new invariants: the id is minted at `onConfirm`, the archive hook lives in `saveCase`, and restore clears `endedAt`.

### Tests Phase 1 needs
- (a) Restoring a slot with no id does not archive it into itself.
- (b) An old case pulled twice gives one log entry.
- (c) Confirm A → Start → Confirm B → New Case with nothing else done leaves A in the slot.
- (d) Restore clears `endedAt`.
- (e) `caseEndMin` ignores the "Case Restored" note.
- (f) A confirmed case with queued starting doses that was never started is not logged.
- (g) Summary totals and labels use the case's concentration, `bolusRateMlH` and weight even when the live globals differ.
- (h) Quota eviction. The existing localStorage stubs never throw (`test-session-roundtrip.js:35-40`, `test-case-carryover.mjs:15-20`), so this needs a size-capped stub.
- (i) `beginCase()` mints the id.

## 5. Phase 2 — cloud case log (about 2 weeks)

| # | Work | Size |
|---|---|---|
| 2a | New **`caselog`** kind. One key per case, `tcisync:{code}:caselog:{id}` holding `{payload, createdAt, updatedAt}`. An index hash `tcisync:{code}:caselog` holds about 200 B of summary per case, so listing is one `HGETALL` (about 10 KB for 50 cases). GET branches on `id` (`sync.js:199-210`). Reuse the `case` payload validation, and add it to `KINDS` so the `Object.hasOwn` allow-list accepts it. Rejected alternatives: one hash of full blobs (listing ships about 3 MB) and LIST+LTRIM (no update by id). | M |
| 2b | Check the caseId against a strict pattern (`^[A-Za-z0-9_-]{8,40}$`) because it becomes part of a Redis key. The server builds summaries from numbers only, plus drug ids checked against a regex (copying `DRUG_IDS` into CommonJS would create a second source of truth; otherwise add `api/sync.js` to CLAUDE.md's "Adding a drug" steps). No free strings from the client go into the index. Do not import ESM from `js/` into the function (no `"type":"module"`, and Vercel file tracing). | S |
| 2c | Retention and caps: blob `EXAT` from the first push; index `EXPIRE` on every push; per-code count and byte caps (summed from the summaries) with oldest-first eviction; lazy pruning of index entries whose blob has expired (on list, and on a 404 fetch). Each upsert is one `multi()`. Upstash REST has no WATCH, so the cap can be off by one when two devices push at once, which is harmless. Lua would be exact, but the test fake cannot run it. `HEXPIREAT` per field is an alternative, but needs a higher `@upstash/redis` minimum version. | **M** |
| 2d | Delete one case, or everything under a code. That needs `DELETE` added at `sync.js:91` and `:270`, or `POST {op:'delete'}`. **"Everything" must exclude `tcisync:{code}`**, the scratchpad's patient key. Decide explicitly about the 30-day template/prefs keys. | S |
| 2e | Old clients: keep `kind=case` byte-identical. **Dual-write on the server**: one `caselog` POST also writes the legacy `:case` slot, which halves the cost against the shared 60/min budget. Do not copy legacy `kind=case` pushes into the log, because that UI promised 24 h. Show a friendly message for `400 invalid-kind` after a rollback (`describeSyncError`, `app.js` ~638-651). | S |
| 2f | An in-memory fake Redis for tests, through `setRedisForTest` (`sync.js` `__test`). No current test stores data and reads it back. | M |
| 2g | Abuse hardening for longer retention: a separate per-IP budget for log writes; lock out repeated misses on unknown codes (a GET returns `found:false/true`, which tells a guesser when a code hits); group IPv6 addresses by /64; document Vercel Firewall rules, the Upstash budget cap and the eviction policy. *(The INCR/EXPIRE permanent-lockout bug was fixed in v0.6.4.17.)* | M |
| 2h | Keep Preview and Production data apart: prefix keys with `VERCEL_ENV`, or give Preview its own database. | S |
| 2i | Client: an optional `id` on push/fetch, plus `fetchCaseIndex` and `deleteCasePayload`, keeping the never-throw contract. Extend `validateIncomingCase` to check note and annotation strings (`cloud-sync.js:120-143`). | S |
| 2j | Merge the device and cloud lists by caseId. Detect changes with a content hash, never `savedAt`. Track which code each entry was pushed under. Each row gets a badge (device / cloud / in sync / conflict) and Push, Pull and Delete actions. **Any copy or conflict fork gets a new caseId with `forkedFrom`**; otherwise two cases share a key and overwrite each other. | M |
| 2k | Docs: remove the "24 h" wording (`index.html` 1635/2429/2446, `settings-ui.js:41`, `prefs-sync.js:13`). Fix DEPLOY.md's kinds table and `sync.js`'s "three kinds" header, which already leave out `prefs`. Leave SCRATCHPAD-SYNC-SPEC unchanged. | S |

Phase 2 risks:
- The code space is 32⁶ ≈ 2³⁰, which is fine against one machine but not a botnet. One hit now exposes every case under that code.
- TCIsim lets a user type any valid code, so codes can be guessable or shared by accident.
- Changing the pairing code orphans the log.
- Browsing the log behind a hospital NAT can 429 that network's patient pulls, because all kinds share one per-IP budget.

## 6. Phase 3 — optional

- **Full chart-replay review** — L, plus M for a time slider.
  - Split `restore()` into resume and review.
  - Add `timer.freezeAt(endMin)`, set **before** the first refresh (`nextUp.render` must never see t = 0).
  - `session.save()` does nothing while reviewing.
  - Gate alarms by *skipping the call*: `chart-bridge.js:270/507/510`, `drug-panel/index.js:119`, `playAlert`. Never weaken the redose latch or the "below threshold ≠ due" logic, both CLAUDE.md invariants.
  - **Stop** Next Up, don't just hide it. Scrubbing back and forth fills `_seenFuture` and produces false "missed" rows.
  - Add a `body.review-mode` class plus a read-only lock in the simulation layer, since there are about 9 ways to change a case.
  - Fit the chart to the whole case.
  - Scrubbing also meets `getActiveReconciliationWindow`, which deletes a window once now > `endMin` (`simulation.js:639-648`). That is the designed lifecycle for a live case, but a scrubbing viewer must not persist it.
- **Automatic push at case end** — M.
  - An opt-in setting in `DEFAULTS` (it syncs through `tci-warn-settings`).
  - A persisted retry queue, flushed on boot, on coming back online and on setup-screen visits.
  - Archive before any network call: a service-worker reload can happen as soon as the setup screen shows.
- **Continue from end** — M. Copy the case in with a **new caseId** (`forkedFrom`), shift the clock to its end, add a pause at the end for every drug still infusing, and call `resetCaseCarryOver()`.
- **Separate high-entropy log key** — L, only if D7 calls for it.

## 7. Gotchas, ranked

1. **Any viewer that reuses the sim screen overwrites the live case.** `refresh()` saves on every call, and with archive-on-id-change it would also archive the real live case.
2. **`restore()` falsifies history when used to view.** It applies today's `bolusRateMlH` and re-anchors every bolus, writes the case's pump settings into the live globals, and runs the clock from now. Viewing must replay at the case's own settings, without re-anchoring, up to an explicit end.
3. **Identity holes duplicate or merge cases.** These come from id stamping that goes through the hook, deterministic ids for legacy blobs, forks without new ids, and same-id pulls overwriting newer work. See 1a, 1h and 2j.
4. **The end time is easy to corrupt.** Unconditional final saves, a stale `endedAt` on a resumed case, and the restore note or restore's own save both pushing the end forward. See 1b.
5. **Alarms on a dead case.** Phase 3 only, if the sim screen is reused. See there.
6. **Cross-patient dose memory.** Any path that loads a different case without `resetCaseCarryOver()`. The pull path was fixed in v0.6.4.17; continue-from-end must call it too.
7. **The quota failure is silent.** A growing log can stop the live autosave with no error. Evict before the live write.
8. **Newer-schema entries vanish** if the log goes through `loadCase()`.
9. **Wrong units in the summary.** The live concentration (the `units.js` fallback), the live weight, and the live working units all belong to the live case. Pass the archived case's own values explicitly.
10. **Cloud key and contract safety.** Check the id before it becomes part of a Redis key, never touch the `patient` kind or SCRATCHPAD-SYNC-SPEC, and keep `kind=case` byte-identical.

## 8. Already fixed while scoping (v0.6.4.17)

- `units.js` fell back to the `DRUG_DEFS` concentration, so mL figures at 2% propofol were off by 2× (5–10× for ketamine at 5%/10%). It now falls back to the live pump concentration. This matters for 1e and 1g above.
- Cloud pull did not clear last-dose memory.
- The rate limiter could lock an IP out permanently (INCR/EXPIRE).
- Hour menus stopped at 23. The Elapsed tab rewound restored cases older than 24 h, and the event picker moved events past ET 24:00 back a day.

## 9. Housekeeping checklist (CLAUDE.md)

- Add every new `js/` module to `sw.js` PRECACHE_URLS (`tests/test-meta.mjs` enforces this).
- List or explicitly exclude new localStorage keys in `prefsManifest` / `prefs-sync.js`.
- Multi-drug loops use `DRUG_IDS`.
- Bump the version in `js/version.js` and `sw.js` in lockstep; each phase is its own PR.
- Add a CHANGELOG entry and a DEVELOPMENT.md Interim block per phase.
- Add the new invariants to CLAUDE.md (id minted at `onConfirm`, archive hook in `saveCase`, restore clears `endedAt`, viewer converts with the case's own concentration and weight).
