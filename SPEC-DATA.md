# Fitness Hub: user data reference (`data/data.json`)

This document extends SPEC §5.7 and §5.7a. **Every §5.7 field is kept with the same name and meaning.**
Everything below marked *extra* is added by the hub. Readers that don't know an extra field
can ignore it. The client migrates and normalises every file it loads (see "Schema versions"), so
older files keep working.

## Schema versions

`schema_version` is **2**. The browser upgrades a file in memory when it loads it and writes the new
version with the next real change (loading alone never writes; the server's first-save-of-the-day
backup keeps the previous file). `migrate(data)` in `store.js` runs the steps in order and is
**idempotent** (running it twice changes nothing) and **deterministic** (two tabs migrating the same
file agree on every record key). A file from a newer hub keeps its higher number and all its fields.

| Version | Change |
|---|---|
| 1 | SPEC §5.7 as written. |
| 2 | Numbers stored as text become numbers ("80.5" → 80.5, "" → null), dates are tidied (`" 2030-01-07 "`, `2030-01-07T07:00`, `2030/01/07`, `2030-1-7` → `YYYY-MM-DD`), `sex` is lower-cased (`M`/`F` → `male`/`female`), a red flag stored as a bare string becomes a one-item list. |
| every load | Missing §5.7 fields get their defaults; `tests[]`, `arm.appointments[]`, `arm.physio_exercises[]` (and any `workouts[]`/`hikes[]` without one) get a stable `id` (derived from the record's content for old records, a UUID for new ones); duplicate ids get a `~2` suffix; anything in the wrong shape is moved to `quarantine` instead of being dropped. |
| every load (round 3) | `profile.fasting_periods` and `profile.rhr_method_changes` default to `[]`; `profile.unavailable_exercises` defaults to the five belt and ankle-strap ids (only when the field is missing: your edits, including an empty list, are kept). Their dates are tidied like every other date; a value of the wrong type is quarantined (a broken `unavailable_exercises` falls back to the default list). Top-level keys the hub doesn't own (`ui`, `goals`, `kit_owned`'s contents, any future key) are kept exactly as they are. |

## Top level

| Key | Type | Notes |
|---|---|---|
| `schema_version` | integer | 2. Required by the server on every save. |
| `profile` | object | §5.7, see below. |
| `checkins` | array | One object per date (§5.7). **Merge key: `date`.** |
| `workouts` | array | §5.7, with extras below. **Merge key: `id`.** |
| `hikes` | array | §5.7, plus `workout_id`. **Merge key: `id`.** |
| `tests` | array | §5.7 `{date, test, value, notes}` plus *extra* `id`. `test` is a `tests.json` id. **Merge key: `id`.** |
| `measurements` | array | §5.7 tape measurements in cm, one object per date. **Merge key: `date`.** |
| `arm` | object | §5.7 `appointments` (+ *extra* `id`, merge key `id`), `logs` (merge key `date`), `physio_exercises` (+ *extra* `id`, merge key `id`), plus `questions`. |
| `weekly_reviews` | array | §5.7, plus `saved_at`. **Merge key: `week_start`.** |
| `hike_ladder` | object | *extra.* Manual ladder completions: `{"<level>": {"done": "YYYY-MM-DD"}}`. Merged key by key. |
| `kit_owned` | object | *extra.* Kit checklist: `{"<kit item text>": true}`. Merged key by key. |
| `ui`, `goals` | object | *extra, owned by the UI* (round 3 PM additions): onboarding state, plate sizes, goals, drafts... Migration never changes them; merging is key by key like `profile`. |
| `meta` | object | *extra.* `{save_id, saved_at, app}`, written by the browser on every save. Never merged. |
| `quarantine` | array | *extra, only when needed.* `[{from, value}]`: values that were in the wrong shape (a check-in that was a string, a `workouts` that was an object, …). Kept so nothing is ever silently deleted. |

## `profile`

Same as §5.7. Merged field by field (including each clearance date).

| Field | Values |
|---|---|
| `name` | Text, default `""`. The welcome greets you by name only when one is set. |
| `sex` | `"male"`, `"female"` or `null`. Only used to pick the Mifflin–St Jeor constant. |
| `birth_year` | Integer. Age = current year − birth year. |
| `height_cm` | Number. |
| `injured_arm`, `dominant_hand` | `"left"`, `"right"` or `null`. |
| `program_start` | `YYYY-MM-DD`, or `null` (the default). Settings snaps it to a Monday. The scheduler also uses the Monday of that week, so a non-Monday date can never shift the program. While it is `null` the programme starts on `program.default_start_date` (`null` in the shipped content; a deployer may set a Monday), else on **the next Monday after today**, recomputed every day until you pick a date in the welcome or Settings (`schedule.js` `programStart`, `defaultStart`). |
| `injury_date` | *Optional.* `YYYY-MM-DD` or `null` (the default). When set, no clearance can be dated before it (`features/clearance.js` `injuryDateOf`, `dateCheck`). Edit it in Settings > Profile or, optionally, in the welcome's profile step. Import checks it as a date. |
| `activity_factor` | 1.375 to 1.725 (default 1.55). `tdee()` clamps to this range. |
| `surplus_kcal` | Default 300 (250–300 is a lean gain). `targetKcal()` treats a negative surplus as 0: no deficit while the bone heals (SPEC §2.6). |
| `protein_g_per_kg` | 1.6 to 2.2 (default 1.8). `proteinTargets()` clamps to this range. |
| `hrmax_override` | bpm or `null`. If set (100–230), it wins over Tanaka (208 − 0.7 × age). |
| `rhr_baseline` | bpm or `null`. Used for readiness until there are 3 mornings of resting HR. |
| `clearances` | `{good_arm_ok, clinic_light, grip_cleared, full_clearance}`: each `YYYY-MM-DD` or `null`. The gates are cumulative (SPEC §4). An invalid date counts as not cleared (fail safe). |
| `fasting_periods` | *Round 3.* `[{"start": "YYYY-MM-DD", "end": "YYYY-MM-DD", "label": "Fasting period", "approximate": true}]`, inclusive dates. You add them in Settings (for example Ramadan, other religious fasts or planned fasting); the hub has no built-in suggestion. Every date inside a period is an easy day (AMBER, SPEC §5.2 fasting overlay) with the fasting message; phase dates don't move. `approximate` defaults to true (`approx` is read too). Import errors: not a list, an entry that isn't an object, a missing or impossible date, an end before the start. |
| `rhr_method_changes` | *Round 3.* Dates you changed how you measure resting HR (a wearable to a manual pulse, a new device...): `["YYYY-MM-DD"]` (entries may also be `{"date": "..."}`). From the latest one on or before a day, the resting-HR rule only counts once there are 5 readings since it, the 7-day average uses only those readings, and `rhr_baseline` is no longer used. A list of plain dates merges as a set, so two devices pressing the button never conflict. |
| `unavailable_exercises` | *Round 3.* Exercise ids your gym can't do: never offered in swaps or as alternatives, and shown as "Not available at your gym". Default: `sled-drag-forward-belt`, `sled-drag-backward-belt`, `cable-kickback-ankle`, `cable-hip-abduction-ankle`, `cable-hip-adduction-ankle`. Merges as a set. |
| `pre_injury_weight_kg` | *Round 4, optional.* Your usual weight before the injury, kg (30–250; anything else counts as not set). While your 7-day average is below it the weight goal uses the **regain band** (+0.25 to +0.5 kg a week); at or above it, the **lean-gain band** (+0.15 to +0.3); not set, +0.2 to +0.4 (see "Weight verdict"). Text numbers are converted on import; out-of-range values are a warning. Never added by migration. |

## `checkins[]`

All §5.7 fields. The scales and meanings used by the UI are:

A check-in **counts** only if it has more than a weight: at least one morning answer (`rhr`, `hrv`, `sleep_h`, `sleep_q`,
`energy`, `soreness`, `mood`, `stress`, `arm_pain`) or a red flag. A weight-only check-in leaves the day "not checked in"
(`unknown`), never GREEN. Two check-ins on one date (a merge can leave both) are read together: the worst answer and every
flag count.

| Field | Scale / unit | Readiness rule (SPEC §5.8, revised in round 3) |
|---|---|---|
| `weight_kg` | kg | – (doesn't make a check-in) |
| `rhr` | bpm, measured lying down before getting up | Amber if ≥ (mean of the previous 7 days' readings, needs 3+) + 5; `rhrRef.threshold` is the whole-number bpm where amber starts. With fewer readings, `profile.rhr_baseline` is used. After a `profile.rhr_method_changes` date: only readings since it count, 5 are needed before the rule applies, and no baseline. |
| `hrv` | ms | – |
| `sleep_h` | hours | Amber if < 6 |
| `sleep_q` | 1 (awful) to 5 (great) | – |
| `energy` | 1 (drained) to 5 | Amber if ≤ 2 |
| `soreness` | 0 (none) to 10 | Amber if ≥ 7 |
| `mood` | 1 (low) to 5 (great) | – |
| `stress` | 1 (calm) to 5 (very stressed) | – |
| `arm_pain` | 0 to 10 | **Red if ≥ 7.** Amber if ≥ 4. Amber if ≥ its 7-day average + 2 (3+ earlier readings in those 7 days), with the message "Rising arm pain can be the red flag “pain getting worse”…". |
| `arm_flags` | array of red-flag ids (`pain_increasing`, `swelling_new`, `redness_heat`, `wound_discharge`, `fever_unwell`, `numbness_tingling`, `colour_cold`, `deformity_give`, `fall_on_arm`, plus any extra ids in `arm.json`) | **Red** if any are ticked. Unknown ids count too, and a bare string counts as one flag (fail safe). |
| `steps`, `protein_g`, `calories`, `water_l` | That date's totals (fill them in during the day or next morning) | – |
| `creatine` | boolean | – |
| `notes` | string | – |

A date inside `profile.fasting_periods` is AMBER even without a check-in (RED still wins).

**Round 4 (BT2-6): the arm log counts too.** A same-day `arm.logs` entry with `pain_rest` or `pain_activity` of **7 or more**
is **RED**, exactly like the check-in's arm pain (the stop text, add-ons and Start disabled), even with no check-in that
day. The hub reads every pain score in `arm.json` the same way (ids starting `pain`, so `pain_night` too: fail safe). Two
logs on one date count together (the highest). Only RED comes from the arm log; AMBER rules still read the check-in.

## `workouts[]`

§5.7 fields: `id` (UUID), `date`, `session_id`, `phase_id`, `phase_week`, `duration_min`, `rpe` (1–10),
`notes`, `exercises[]`, `cardio[]`.

| Extra field | Meaning |
|---|---|
| `status` | `"draft"` while you log (autosaved as you type), `"done"` after **Save session**. Stats, streaks and "last time" only use `done` workouts. Workouts without a `status` count as done. |
| `session_name`, `session_type` | Snapshot of the program session's name and type when the log was created, so stats survive program edits. `session_id` is `"adhoc"` for your own sessions. |
| `easy_day` | `true` if the amber easy-day adjustments were applied. |
| `started_at`, `created_at`, `updated_at`, `completed_at` | ISO timestamps. |
| `warmup_done`, `cooldown_done` | Booleans from the routine checkboxes. |

`exercises[]` items: §5.7 `{exercise, sets: [{kg, reps, seconds, rir, done}], notes}`, plus:

- `block`: which program block the entry belongs to. Round 3 logs use a stable key, the planned exercise id plus its occurrence in
  the session (`"leg-press:1"`, `"circuit:1"`); older logs have positional keys (`"b0"`, `"b1"`, …). Added exercises use `"x…"` keys.
  Merging matches entries by the stable key, or by exercise id plus occurrence for positional or missing keys (never by position).
- A set counts as *performed* (for progression) only with actual values: not `done: false`, not `placeholder: true` (or
  `actual: false`), numeric `reps` (and `kg` when the exercise was loaded). Timed sets need their `seconds`.
- `extra: true`: an exercise you added yourself.
- `swapped_from`: the locked exercise this one replaced.
- A set without `done` is a done set (migration writes `done: true`, matching what stats always assumed).
- `planned` (*round 4*, SPEC 5.2): `{sets, reps, rir, seconds?, load}`, the **effective** prescription that day, stored by
  the logger on save: after `sets_max`, deload, easy-day or fasting halving, and swaps (a swapped-in or added exercise
  stores its own prescription). Progression judges "every planned set done" against `planned.sets`, never the raw block
  sets. Older logs without it get it **recomputed** for their date (see "Progression suggestions"). It merges field by
  field like the rest of the entry. A `planned` without a whole `sets` of at least 1 is ignored.

The rehab add-on's `x-physio-programme` block logs one set, `{seconds, done}`.

`cardio[]` items: §5.7 `{exercise, minutes, zone, avg_hr, distance_km, ascent_m, level, notes}`, plus:

- `block`, `extra`, `swapped_from`: as above.
- `rounds`: interval or circuit rounds completed.
- `items`: circuit exercise ids. A circuit's `exercise` is `"circuit"`.

## `hikes[]`

§5.7 fields, plus `workout_id`, the id of the logged hike session it came from (offered after saving a
hike-type session). Hikes with a `workout_id` are not counted twice in Zone 2 minutes.

Round 4 (BT1-4): a hike logged on a day whose planned session is a long walk or hike (session `type: "hike"`) counts as
**that session done** when its `duration_min` is at least **70% of the planned minutes** (the session's cardio minutes for
that week, else its `duration_min`; with neither, any hike counts). It is counted once: never on top of a workout for the
same session, one hike per planned session, and a hike linked (`workout_id`) to a workout that already counts never covers
a second one. Hikes never stand in for other session types.

## `arm`

- `appointments[]`: `{id, date, type, notes, outcome}` (§5.7 + `id`). The date can be edited; the `id` keeps the record's identity.
  The default is `[]` (no appointment is assumed). **Add the suggested appointments** copies `arm.json`
  `appointments_default`; an entry whose `date` is `null` gets today's date.
- `logs[]`: `{date, values: {<arm.json measurement id>: number}, notes}` (§5.7). There is one log per date, and the form is built from every measurement in `arm.json`. Merged value by value.
- `physio_exercises[]`: `{id, exercise, dose, since, notes}` (§5.7 + `id`). `exercise` is a library id or free text.
- `questions` (*extra*): `{"<hash of question text>": {question, asked, notes}}`, the clinic-question ticks and answers.

## `weekly_reviews[]`

§5.7 `{week_start, wins, struggles, next_focus, adherence_pct}`, plus `saved_at`. `adherence_pct` is
the share of planned main (template) sessions done that week, captured when you edit the review.

## Saving and concurrency (client side of SPEC §5.7a)

- **ETag.** `GET /api/data` returns a strong ETag; the store keeps it and sends it as `If-Match` on every
  `PUT`. The new ETag comes back with each successful save.
- **Debounce.** A save starts 500 ms after the last `touch()`. If nothing actually changed (compared with
  the last copy the server confirmed), no request is sent.
- **412 / 428.** The store re-fetches, then applies *only this tab's changes since its last confirmed copy*
  on top of the fresh server copy (a three-way merge), and saves again with the fresh ETag. A 428 (no ETag
  yet, for example the server was upgraded while the tab was open) is handled the same way.
  - Records in the arrays above are matched by their merge key, never by position.
  - Inside a record, fields merge one by one. `values` in arm logs merge one by one. Lists of ids such as
    `arm_flags` merge as sets (ticks from both tabs are kept). Lists of the same length (sets of an
    exercise) merge item by item.
  - Profile fields, clearance dates, `kit_owned`, `hike_ladder` and `arm.questions` merge key by key.
  - Deleted in one place and edited in the other: the edited version is kept (a note is passed to the UI).
  - Created in both places (for example today's check-in): empty fields never beat filled ones.
  - **A true conflict** (the same field changed to different values in both places) pauses saving. Local
    changes stay in memory and in `localStorage`. The UI gets the choice through `onConflict()` and answers
    with `resolveConflict('mine' | 'theirs' | {...})`. The losing values go to the conflict log in
    `localStorage`, so even the overwritten version is kept.
  - With no `onConflict` listener registered, the store falls back to status `error` with an explanatory
    message, and **Retry** keeps this tab's version (the other version is archived).
- **Offline.** Failed saves retry with backoff (2 s, 4 s, 8 s … 60 s, ±20 % jitter); `online` and tab focus retry
  at once. Every request times out after 20 s, **including reading the body** (round 3, PE4), so a half-dead SSH tunnel that
  sends headers and then stalls can't hang a load or a save.
- **Save watchdog (round 3).** A save (or a stale-tab check) that hasn't settled after 30 s is abandoned: status `error`
  ("The hub took too long to answer…") and the normal retry. Its late answer, if any, is ignored (the retry gets a 412 and
  merges). Edits made while a save is out are written to `localStorage` straight away.
- **Build id (round 3, SPEC §5.7a).** `init()` reads `build` from `/api/health` (if that fails it is read once more before the
  first save) and every `PUT` sends `X-Hub-Build: <build>`. A `409 {"error": "build_mismatch", "build": "..."}` keeps every
  local change (in memory and `localStorage`), stops saving (no retry loop) and sets status `build-mismatch`, with
  `info.buildMismatch = {server, client, at}`, `onBuildMismatch()` listeners and a `fitness-hub:build-mismatch` window event.
  The UI shows "The hub was updated. Reload to continue." Leaving the page then doesn't warn (the changes are safe in
  `localStorage` and are offered back after the reload). Focus re-checks `/api/health` at most once a minute, so an update is
  noticed before a save is refused; `retry()` re-checks at once and a mismatch that has gone (a rollback) clears itself.
  No check is made when the server's build is `"dev"`.
- **Byte sizes (PERF7/PERF10).** `info.bytes` is the size of the compact JSON the store sends (or the GET's Content-Length when
  the body isn't compressed), counted without copying the text.
- **Leaving the page.** On `visibilitychange` (hidden), `pagehide` and `beforeunload` the delta is written to
  `localStorage` synchronously and a save is sent with `fetch(..., {keepalive: true})` when the body fits the
  browser's 64 KiB keepalive limit (in practice only small data files; larger ones rely on the
  `localStorage` copy, which is offered back on the next load).
- **Stale tabs.** On focus / visibility / `pageshow` (back-forward cache), and when another tab in the same
  browser broadcasts a save (`BroadcastChannel('fitness-hub')`), the store asks the server with
  `If-None-Match` (a 304 costs nothing). If the server copy changed, it is applied **in place** (records keep
  their object identity, so a view holding a record keeps working) or merged with unsaved edits.
- **Merging details (round 3, PE11).** A workout's `exercises[]` and `cardio[]` are matched by block key (see `workouts[]`),
  so a reordered or swapped exercise never receives another one's sets. Bookkeeping timestamps (`*_at`: `updated_at`,
  `saved_at`, `completed_at`…) never make a conflict: the later one wins (`created_at` / `started_at`: the earlier).
- **Recovering unsaved changes (round 3, PE1).** `init()` only *previews* what restoring would do. Restoring
  (`restorePending()`, or `replaceAll(recovered.data)` as before) re-reads the stored deltas and re-applies them onto the
  **live** data at that moment, field by field against each delta's own base: anything adopted since the offer (a hike from
  the phone, a newer weight) is never reverted. A field that was also changed elsewhere since the delta was written becomes a
  conflict (`onConflict`, `kind: 'recovery'`; "mine" = the restored value): until you choose, the live value stays and saving
  pauses; the losing value goes to the conflict log. A delta that only kept its base's hash (storage was full) can only be
  chosen as a whole record. An old v1 copy (`fitness-hub:pending`) has no base, so it may only **add** records the data
  doesn't have and **fill** empty fields; every value it disagrees with is kept as it is now and archived in the conflict
  log (`source: 'legacy'`), and clearance dates are never filled from it. The browser copies stay in `localStorage` until the
  server has the result. A preview that was already restored or discarded is never applied again.

## Files and browser storage

- `data/data.json`: written atomically (temp file, then `os.replace`).
- `data/backups/data-YYYY-MM-DD.json`: a copy of the previous file, made on the first save of each local day. The newest 60 are kept.
- `data/backups/manual-YYYY-MM-DD-HHMMSS.json`: written by **Back up now** and before an import. The newest 60 are kept.
- Browser `localStorage`:
  - `fitness-hub:pending:<tab id>.<load id>` (round 3; older pages wrote `fitness-hub:pending:<tab id>`): this page's
    unsaved changes as a small delta `{v: 2, tab, at, base_etag, changes: [...]}`, until the server confirms them. One key
    per page load, so two tabs, or a reload of the same tab, never overwrite each other's copy. On the next load the hub
    offers back the deltas of earlier loads of this tab and of tabs that are no longer open (Web Locks tell open tabs
    apart; without them, deltas older than 2 minutes). A change the server already has is not offered again.
  - `fitness-hub:pending`: the v1 format (`{at, data}`), still read once (add-or-fill only, see above) and then removed.
  - `fitness-hub:conflict-log`: conflict decisions with both values (`conflictLog()`). SEC10: at most the last 20
    entries, none older than 30 days, at most 200 KB (an entry too big for that keeps a 2,000-character preview,
    `truncated: true`). Expired entries are dropped whenever the log is read or written.
  - `fitness-hub:discarded`: the last 3 deltas you chose not to restore (kept 30 days), in case it was a misclick.
  - `fitness-hub:theme` holds `light` / `dark` (absent = match system).
- Browser `sessionStorage`: `fitness-hub:tab` holds this tab's id (survives a reload of the same tab).
- `?fixtures=1` loads content **and** sample user data from `public/dev-fixtures/` and never saves.
  `?fixtures=1&data=2y` loads `dev-fixtures/data-2y.json` instead: two years of dense daily use (705 check-ins,
  702 sessions, schema 1) for performance work. Regenerate all the fixtures with `python tests/make_fixtures.py`.
  The sample data uses the neutral example profile: no name, male, born 1996, 180 cm and about 80 kg (the weigh-ins
  trend up from about 79 kg), injured arm right, dominant hand right, an arbitrary `injury_date`, and
  `pre_injury_weight_kg` 83, so the regain band shows. Its fasting example is a generic planned fast, its hikes and weekend plan use generic UK route names, and the
  fixture `program.json` has `default_start_date: null`. `data-v1.json` is a frozen schema-1 sample in the shape of a
  real file (not a copy of anyone's data), used by the migration tests so that no test reads `data/`.
  Round 4: the sample data has `planned` on the leg-press and hamstring-curl logs from programme week 3 (older ones are
  recomputed), a hike standing in for the long walk on the Saturday of programme week 3, and a RED arm-log day (the
  Wednesday of week 2, pain with activity 7: neutral, no session). The fixture tests.json has `baseline_day` and a
  `first_phase` test; its weekend_plan mixes `week_start` and `program_week` entries.

## Import

`validateImportDetailed(obj)` checks everything **before** anything changes. Errors block the import (nothing
is applied, ever partially); warnings are shown but the data is kept as it is.

- **Errors:** not an object; `schema_version` missing, not a whole number, or newer than this hub; wrong
  types (a list where an object belongs and vice versa, text where a number belongs, records that aren't
  objects); missing or impossible dates (`2030-02-30`, `2031-02-29`, `31/01/2030`); a test result without a
  `test`; over 10 MB; nesting over 24 levels; a text over 200,000 characters; over 100,000 entries in a list;
  the reserved keys `__proto__`, `constructor`, `prototype`.
- **Warnings:** numbers stored as text and dates in another format (converted), duplicate dates or ids,
  a start date that isn't a Monday, out-of-range profile values (a negative surplus is used as 0), unknown
  clearance names, very long notes, and the plausibility hints below (for example "805 kg: did you mean 80.5?").
- Messages name the place (`checkins[12].date: …`) and say what to do. At most 40 of each are listed; the
  counts are exact.

## How the hub interprets the program (SPEC §5.2 and its round 2 review update)

- **Phase starts:** phase 1 starts on the program start Monday: `profile.program_start`, else
  `program.default_start_date`, else the next Monday after today (recomputed every day until you pick a date; see
  `program_start` under `profile`). If phase 1's own `entry_gate` isn't `none`,
  it waits for that gate (Monday on or after the gate date, never before the start); nothing is scheduled
  meanwhile (fail safe). A later phase starts on the Monday on or after max(its entry-gate date, previous phase
  start + `min_weeks` weeks). `min_weeks` defaults to `weeks` and is clamped to 1..`weeks`. If the gate has no
  date, the phase is "waiting" and the previous phase loops weeks `repeat_from_week..weeks` (`null` repeats the
  final week). Looped weeks reuse that week's override, so a deload week repeats. The timeline is recomputed
  from scratch every time, so setting, clearing or moving a clearance date (or the start date) never leaves
  stale state. A clearance date entered retroactively moves the plan as if you had entered it on the day.
- **Unknown or missing exercise gates** count as `full_clearance` (fail safe). **An exercise id that isn't in the library
  is always locked** (round 3, fail closed): `gateOf(id)` is `null` and `isLocked(id, date, data)` is `true`, even after
  full clearance, and everything is locked while the library hasn't loaded. Locked exercises can't be logged; the logger
  offers unlocked easier versions instead.
- **Exercise library sources (round 3).** When `exercises.json` exists, `part-a.json` and `part-b.json` are read as well. If
  they disagree (ids or gates) that is a `Safety:` problem in `content.status`, and the hub uses every exercise from both
  with the **stricter** gate for each id (the parts' text). `tests/test_content.mjs` checks that the merged file equals
  the parts.
- **Week overrides, round 3 fields.** `zone_cap` (`"Z3"`) caps that week's interval work zones, cardio zones and circuit
  zones, in what is shown and in the timers (blocks get `zonePlanned` / `workZonePlanned`, `zoneCapped`, `zoneCap`).
  With a deload (cap Z3) or an easy day (cardio and circuits Z2) the strictest cap wins. `circuit_minutes` replaces circuit
  minutes (`circuit.minutesPlanned`, `circuitMinutesOverridden`). `rounds` replaces interval rounds and, like
  `minutes_by_week`, is the week's plan as written: it is never halved again by a deload (`roundsPlanned`,
  `roundsOverridden`). Invalid values are ignored (and reported by `validateProgram`).
- **Alternates (round 3 PM7).** `program.alternates = {short, travel}`: logging one counts as a session done for that day
  (the day isn't missed, streaks continue, adherence counts it), but never as the planned strength session. `plannedOn()`
  never lists them. `validateProgram` reports an alternate that uses an exercise above gate `none` as a `Safety:` problem.
- **The rehab add-on (round 3 PM11)** (id `rehab`, or a session of type `rehab`) is shown and counted only once
  `arm.physio_exercises` lists an exercise. `plannedOn(..., {data})` and `dayInfo` apply this; hidden add-ons are in
  `plan.hiddenAddons` with reason `waiting-physio`.
- **Week overrides:** `sets_max` caps sets. `deload: true` halves sets (rounding up). On a deload week, intervals get half the rounds (rounding up) with the work zone capped at Z3. An amber easy day also halves sets, caps cardio and circuit zones at Z2 ("Zone 2 only", SPEC §5.8; the block gets `zonePlanned` and `easyZoneCapped`) and swaps intervals for steady Zone 2 for the same total time (`easyMinutes` on the resolved block). A deload week and an easy day never stack (sets are halved once). An override's `rir` replaces block RIR.
- **Cardio minutes:** `minutes_by_week` (indexed by phase-week, last value reused) wins. A bad entry in it (null, text) falls back to the nearest earlier valid entry and never shifts later weeks. Otherwise base `minutes` × `cardio_scale`, rounded; `minutes: null` stays unknown.
- **Add-ons:** run on their listed `days` while `gate` is met and `until_gate` is not met. `until_gate` may be `null`, meaning they never end. If `phases` is given, they run only during those phases (never before the program starts). Add-ons without `phases` also run before the program start once their gate is met.
- **Progression suggestions** appear only for `load: "double-progression"` blocks with a rep range. When every set last time hit the top of the range, add the `rules.increments_kg` step and drop to the bottom; otherwise add reps. The step is looked up by exercise id first, then kettlebell / sandbag / dumbbell / barbell / cable / machine (from equipment and id), then `default`. `bodyweight` and `physio` loads never get load suggestions.
  Round 3: more load or reps is suggested only when **every planned set** last time was logged with actual values;
  otherwise the result is `{kind: 'hold', reason: 'incomplete'}` (repeat the load, log every set). In deload weeks, on easy
  (AMBER) days, in fasting periods and on RED days it never suggests more: `{kind: 'hold', reason: 'deload' | 'easy-day' |
  'fasting' | 'red', kg: last time's load}` with the text "Hold: same load, RIR 3–4" (a first time in a fasting period:
  "no new lifts").
  **Round 4 (BT1-1 / BT3-1, critical):** "every planned set" means the sets planned **last time**, the effective prescription
  that day, never today's block. So 60 kg × 12, 12 logged in a 2-set capped week gives "Add 10 kg" the next week, and
  40 kg × 10, 10 on a deload, AMBER or fasting day gives "Stay at 40 kg and beat last time". Last time's planned sets come
  from, in order: `entry.planned.sets`; for older logs, the program block recomputed for that date (the workout's own
  `phase_id` / `phase_week`, else the timeline; `easy_choice`, else `easy_day`, else readiness on that date, AMBER including
  fasting); with no program to hand, the number of set rows logged (the logger creates the effective number). A first log
  of a lift says "Start around a load you could do for 15, then let double progression find your level within 2 sessions"
  (the top of the range + 3; SPEC §1: no novice wording).
- **Last performance per block (round 4, BT3-2).** "Last time" for a block is the most recent log of the same exercise in
  the same session template and block key; next best, the same exercise with the same rep range (its stored or
  recomputed prescription; timed work matches timed work); then any log of it. A log from an `alternates` session is never
  the baseline for a full session (an alternate may use any log). `lastPerformance()` does this when given
  `{sessionId, blockKey, reps}` and says which tier it used in `match`.
- **Hold RIR (round 4, BT3-12).** On an easy (AMBER) day and in a fasting period every strength block shows RIR **3–4**
  (`holdRir: true`, the RIR it replaced in `rirPlanned`), whatever the week says. A deload week shows 3–4 too unless its
  override sets its own `rir` (a designer's taper RIR wins). Timed holds only get an RIR the plan gave them; physio work
  is as prescribed. `resolveBlock(..., {fasting: true})` applies the whole fasting overlay (sets halved, Zone 2 only, no
  intervals, hold RIR) with the note "fasting period: sets halved".
- **Phase-appropriate swaps (round 4, BT2-2/3).** Swaps and "Add an exercise" offer only exercises whose gate is at or
  below the **current phase's `entry_gate`** (before the programme starts, the first phase's), never above your
  clearances, never on `unavailable_exercises`, never an id that isn't in the library. So the rower and ski erg (Grip
  cleared) only appear once a Grip-cleared phase has started, even if grip was cleared earlier. On an add-on's own
  session the add-on's gate counts too (the good-arm session swaps among good-arm work). A swapped-in or added exercise
  is shown with its **own** prescription from the library (`prescriptionFor`): its type (loaded reps with a kg column,
  bodyweight reps, timed, cardio or physio), its cues and its default dose, with the day's sets_max / deload / easy-day
  rules applied to it like any block.
- **When tests are due (round 4; tests.json, all optional).** `first_phase` (a phase id) + `first_week` (a week of that
  phase, default 1): never due before then, nor while that phase hasn't started (a `first_phase` that isn't in program.json
  is never due and is reported in `content.status`). `first_week` alone is a programme week. `baseline_day` (1–3 =
  Monday–Wednesday of programme week 1): when a first result is due, so the baselines spread over three mornings. The
  older forms `due_from` (a date), `baseline` / `schedule` `{phase, week, day}` and `baseline_week` still work. A repeat is
  due `every_weeks` after the last result. Nothing is due before the programme starts, above your gate, or **during a
  fasting period**; a due date that falls inside a fasting period moves to the day after it (state `paused` meanwhile).
- **weekend_plan (round 4).** An entry may give `program_week` (1–8, relative to the programme start Monday) instead of, or
  as well as, `week_start`; `program_week` wins. `content.js` keeps such entries (a bad `program_week` is reported and
  ignored; with neither field the entry is dropped), and `weekendPlanOn(hikes, date, start)` resolves them against your
  `profile.program_start`.

## Derived numbers

- **Zone 2 minutes:** done-workout cardio rows whose `zone` contains `Z2` (`Z2`, `Z1-Z2`, `Z2-Z3`), plus hikes without a `workout_id`.
- **Strength sessions:** done workouts whose session type is `strength`, against the phase's `weekly_targets.strength_sessions`.
  Round 3 (QA3): only planned (template) sessions and your own (ad-hoc) ones count. Add-on sessions, alternates and a
  second log of the same planned session never do.
- **A day's planned session** counts as done only when a done workout with that `session_id` exists (QA5); an ad-hoc walk
  doesn't complete Strength A. `weekSummary().mainDone` / `adherencePct` also count an alternate standing in for a planned
  session (`mainDoneStrict` doesn't; `altDone` counts alternates). Add-ons never count towards adherence.
  Round 4: a logged hike of at least 70% of the planned minutes counts as the planned long walk or hike (`hikeDone`; it is
  part of `mainDone` and `mainDoneStrict`), once (see `hikes[]`).
- **Neutral days (round 4, BT2-9).** RED days and fasting days are neutral: a planned session you didn't do on one is
  *excused*, not missed. The day's status is `neutral`; it neither counts towards nor breaks a streak; and its excused
  sessions are left out of `mainPlanned` / `mainPlannedToDate`, so of adherence (`mainExcused` counts them,
  `mainPlannedRaw` is everything planned). A past day is excused when it was RED or in a fasting period; today is excused
  only once it is RED (a fasting day can still be trained after your first meal of the day); future days never. A session you did train on a
  neutral day counts as usual.
- **Nothing after today (QA6):** `weekSummary` counts sessions, minutes and check-ins up to today only, and the trend
  helpers take an end date (`series(..., {to})`, `seriesUntil`, `rollingMean(..., {to})`, `trendUntil`), so a future-dated
  entry never moves today's figures.
- **Protein-target days:** check-ins with `protein_g` ≥ round(`protein_g_per_kg` × latest weight on or before the week's end).
- **Streak:** consecutive days on plan. Training days count when a session was logged, rest days count when they are planned rest, and today counts once it's done. Before the program starts, only days with a logged session count. No upper limit (multi-year streaks count in full). Round 4: neutral days (RED, or a fasting day you didn't train) are skipped (they neither add nor break), and a hike covering the long walk counts as a session.
- **Weight trend:** a 7-day trailing mean over calendar days (gaps just mean fewer readings). The weekly change is that mean now minus the mean 7 days earlier, with a target band of +0.2 to +0.4 kg a week.
- **Weight verdict (round 4, BT3-7; `calc.weightVerdict`, the one the goals card, the coach notes, Today, Review and
  Progress share).** Fortnights are non-overlapping 14-day windows from the programme start Monday (programme weeks 1–2,
  3–4, …). On any date the latest fortnight that has ended (on or before that date) is judged, so there is one verdict per
  fortnight: the first on the Sunday that ends week 2. Its rate is (the 7-day average of the fortnight's last week − the
  7-day average two weeks earlier) / 2, in kg a week (chapter 14's check), judged only with at least **10 weigh-ins** in
  the fortnight and 3 behind each average. One weigh-in per morning (several are averaged); weights outside 30–250 kg are
  ignored. The band (`gainBand`): the **regain band +0.25 to +0.5** while that 7-day average is below
  `profile.pre_injury_weight_kg` (muscle memory brings lost muscle back faster than new muscle is built), the
  **lean-gain band +0.15 to +0.3** once at or above it, and **+0.2 to +0.4** when no pre-injury weight is set. Result:
  `in`, `below` (state `losing` when it is falling more than 0.05 kg a week: "no dieting while the bone heals") or
  `above`, with the previous fortnight's verdict (`previous`, `twice` when both are out of band the same way). The
  nudges name no meal-plan calorie day: they say "move up (or down) one meal-plan level on the Nutrition page".
  **Fasting:** weigh-ins inside a fasting period and in the 14 days after it are ignored, and on those dates there is no
  verdict at all (`paused`: "hold your weight steady at about maintenance", with no calorie number); a fortnight whose
  baseline week fell in that pause is `paused` too. Too few weigh-ins: `insufficient`; before the first fortnight has
  ended: `waiting`. With no start given and no `profile.program_start`, the fortnights count from the next Monday after
  the date being judged, so the verdict is `waiting`.
- **Hike ladder:** a level is done automatically by the first logged hike that meets its `distance_km`, `ascent_m` and `pack_kg` on a date when the level's gate was met. Terrain is checked by you, and you can also tick a level manually.
  Round 3 (PM8): an `ascent_m` of 0 or `null` means "any ascent" (a hike with no ascent logged qualifies), an optional
  `duration_min` (or `minutes`) is a minimum time, and `ladderStatus(..., {today})` ignores hikes dated after today.
  `weekendPlanOn(hikes, date)` is the `weekend_plan` entry for that date's week. `hikeIssues(hike, data)` warns when a walk
  before `clinic_light` carries more than a 2 kg waist pack (SPEC §5.9 carrying rule).

## Data quality (plausibility)

`PLAUSIBLE` in `stats.js` holds the ranges. Values outside a hard scale are `error`; unlikely values are `warning`,
with a `suggestion` when a decimal slip explains them.

- Weight outside 30–250 kg (805 → "did you mean 80.5 kg?"), or more than 3 kg per day from the previous weigh-in.
- Resting HR outside 30–120 bpm (600 → 60); HRV outside 5–250 ms.
- Sleep over 14 h (450 → 7.5 h: minutes typed as hours).
- Scales: `sleep_q`/`energy`/`mood`/`stress` 1–5, `soreness`/`arm_pain` 0–10, RPE 1–10, RIR 0–10.
- Sets: load over 400 kg or 3× last time's top set; reps over 100; holds over an hour. Cardio over 8 h; average HR outside 40–220.
- Hikes: over 100 km, 6,000 m ascent, 24 h or a 40 kg pack, or faster than 8 km/h on average.
- Arm logs: pain outside 0–10, ranges of motion outside 0–180°, grip over 100 kg. Tape measurements outside 5–250 cm.

## Module API

All modules are plain ES modules with no DOM work at import time (they also run in Node for the tests).
**New in review round 2** is marked ★, **new in round 3** is marked ◆, **new in round 4** is marked ▲. Every older export
keeps its name and signature (rounds 3 and 4 only add optional parameters and result fields), except the fixed dates and
examples that the public release replaced with generic defaults (see "Generic defaults").

### Round 4 at a glance (▲)

| Module | Export | What it does |
|---|---|---|
| `content.js` | ▲ `allowedForPhase(id, date, data, opts)` | May this exercise be offered in a swap or "Add an exercise" on this date? Gate ≤ the current phase's entry gate, gate met by your clearances, not on `unavailable_exercises`, in the library. `data`: the user data or a profile. `opts`: `{program = content.program, exById = content.exById, timeline, sessionId, gate}`. |
| `content.js` | ▲ `whyNotAllowed(id, date, data, opts)` | The reason it can't: `'unknown'` (not in the library), `'locked'` (above your clearances), `'phase'` (above the phase), `'unavailable'`; `null` when allowed. |
| `content.js` | ▲ `phaseGateOn(date, data, opts)` | The ceiling gate on that date: the current phase's `entry_gate` (the first phase's before the start); on an add-on's session (`sessionId`) the add-on's gate if higher; `opts.gate` sets it. No program or an unknown gate: `'none'`. |
| `content.js` | ▲ `prescriptionFor(exerciseId, opts)` | The exercise's own default prescription from the library, or `null` for an unknown id: `{id, name, type: 'loaded' \| 'reps' \| 'timed' \| 'cardio' \| 'physio' \| 'other', kind, kg, load, sets, setsRange, reps, repRange, seconds, secondsRange, minutes, zone, rir, per_side, unit ('reps' \| 's' \| 'm' \| 'steps' \| 'min'), metres, dose, cues, block}`. `block` is a program block, so `resolveBlock(p.block, {week, override, easyDay})` applies the day's rules. `opts`: the library (a Map) or `{exById, sets}` (`sets` = the replaced block's planned sets, kept within the exercise's own range). |
| `content.js` | ▲ `parseDose(dose, ex)` | The dose-text reader behind it (first "N × M", "N sets of M", "N rounds of M s"; cardio minutes first for conditioning; ranges start at the lower end). |
| `content.js` | ▲ `testsDueOn(data, date, tests = content.tests, opts)` | Tests due on a date, most overdue first: `[{test, id, state: 'due', dueOn, last, overdueDays, baseline, earliest}]`. Never before the programme start, during a fasting period, above the gate or before `first_phase`/`first_week`; baselines on their `baseline_day`. `opts`: `{program = content.program, timeline}`. The older order `(data, tests, date, timeline)` works too. |
| `content.js` | ▲ `testStatusOn(data, date, test, opts)` | One test: `state` `'locked' \| 'scheduled' \| 'due' \| 'done' \| 'paused'` (would be due, but fasting), `dueOn`, `last`, `overdueDays`, `baseline`, `earliest`. |
| `content.js` | ▲ `testEarliestDue(test, timeline)`, `testBaselineDue(test, timeline)` | The date a test may first be due (`first_phase` + `first_week`), and a first result's due date (`baseline_day`, or the older `due_from` / `baseline {phase, week, day}` / `baseline_week`); `null` while the phase hasn't started. |
| `calc.js` | ▲ `weightVerdict(data, date, {start})` | The fortnightly weight verdict (see "Weight verdict"): `{date, status, state, verdict, rate, avg7, prev7, band, window: {start, end, weighIns, needed, week, weekBefore}, previous: {status, state, rate, end}, twice, losing, nudge: 'eat-more' \| 'eat-less' \| null, next, first, start, preInjury, fasting, until, reason: 'fasting' \| 'after-fasting' \| null, title, text}`. Accepts a view ctx. Without `start` or `profile.program_start` it counts from the next Monday after `date` (so: `waiting`). |
| `calc.js` | ▲ `gainBand(profile, avg7)`, `GAIN_BANDS`, `preInjuryWeight(profile)`, `bandText(band)`, `WEIGHT_RULES`, `LOSING_KG_WEEK` | The band for a 7-day average (`{id: 'regain' \| 'lean' \| 'default', lo, hi, label, text, preInjury}`), the three bands, the cleaned pre-injury weight, "+0.25 to +0.5 kg a week", the verdict's rules (`{windowDays: 14, minWeighIns: 10, minPerWeek: 3, afterFastingDays: 14, plausible: [30, 250]}`) and −0.05 kg a week. `GAIN_BAND` ([0.2, 0.4]) is unchanged. |
| `calc.js` | ▲ `armLogPainOn(data, date)`, `redDays(data)`, `ARM_LOG_PAIN` | The worst same-day arm-log pain `{value, field, label, date}` (or `null`); the Set of RED dates (flags, check-in pain 7+, arm-log pain 7+) in one pass; the pain-id pattern. |
| `calc.js` | ▲ `readiness(..., {armLog})`, `readinessOn`, `readinessHistory(checkins, profile, {armLogs})` | Arm-log pain of 7+ is RED (`reasons` "Arm log: pain with activity 7/10 (7 or more)", `armLog` on the result). `readinessHistory(data)` reads the logs itself and adds RED arm-log dates without a check-in (the Map stays in date order). |
| `schedule.js` | ▲ `suggestProgression({..., planned, lastPlanned})`, `suggestProgression.plannedAware` (`true`), `plannedSetCount(p)` | Judges last time's planned sets (see "Progression suggestions"): `planned` (a count or `{sets}`) > `lastSets.planned` > `plannedSets` (plain lists only) > the rows. Results add `planned` and `performed`. |
| `schedule.js` | ▲ `resolveBlock(block, {week, override, easyDay, fasting})`, `HOLD_RIR` (`'3-4'`) | The hold RIR (`holdRir`, `rirPlanned`) and the fasting overlay (`fasting: true` on the block). |
| `schedule.js` | ▲ `blockKeysOf(blocks)`, `plannedFromBlock(rb)` | Stable block keys (`"leg-press:1"`, `"circuit:1"`), and the `planned` record of a resolved block (`{sets, reps, rir, load, seconds?}`). |
| `stats.js` | ▲ `lastPerformance(data, id, date, excludeId, opts)` | Per block with `{sessionId, blockKey, reps \| seconds, program}` (or `alternates`); options may be the 4th argument. Adds `prescription`, `plannedSets`, `match: 'block' \| 'prescription' \| 'any' \| null`, `sessionId`, `block`, `entry` (read-only). `planned` / `complete` are now against the effective prescription. |
| `stats.js` | ▲ `effectivePrescription(workout, entry, {program, data, timeline})`, `entryBlock(workout, entry, {program, list})` | `{sets, reps, rir, seconds, load, source: 'stored' \| 'recomputed' \| 'rows'}`; an entry's `{key, index}` in its session (stable, positional or by occurrence). |
| `stats.js` | ▲ `dayInfo` / `weekSummary` / `streak` | `dayInfo` adds `hikeDone`, `viaHike`, `hikes`, `neutral` ('red' \| 'fasting' \| null), `excused`, `plannedCounted`, status `'neutral'`. `weekSummary` adds `mainPlannedRaw`, `mainExcused`, `neutralDays`, `hikeDone` (`mainPlanned` excludes the excused). |
| `stats.js` | ▲ `isHikeSession(entry)`, `plannedHikeMinutes(entry, plan)`, `hikeCovers(hike, minutes)`, `HIKE_COVERS_SHARE` (0.7) | The BT1-4 pieces. |
| `stats.js` | ▲ `weekendPlanOn(hikes, date, start)`, `weekendPlanList(hikes, start)`, `nextWeekendPlanOn(hikes, date, start)`, `weekendPlanStart(start)` | `program_week` support. `start`: an ISO date, `{start}`, `{timeline}`, `{profile}` or `{data}` (+ `{program}`); with nothing to go on, `defaultStart()` (the next Monday after today). `program_week` entries come back as copies with their resolved `week_start`. |
| `store.js` | ▲ `profile.pre_injury_weight_kg` | A known number field (converted from text, range-checked on import). |

### Generic defaults (public release)

Nothing in the code or the shipped content assumes a particular person, date or place.

| Module | Export | What it does |
|---|---|---|
| `schedule.js` | `defaultStart(today = todayISO())` | The next Monday after `today`: the programme start while neither `profile.program_start` nor `program.default_start_date` is set. It replaces the fixed `DEFAULT_START` constant. |
| `schedule.js` | `programStart(program, profile, today?)` | `profile.program_start`, else `program.default_start_date`, else `defaultStart(today)`; always the Monday of that week. |
| `schedule.js` | `buildTimeline(program, profile, {today} = {})` | `today` (default: the real date) only matters while no start date is set. |
| `stats.js` | `weekendPlanStart(opts)` | With nothing to go on: `defaultStart()`. |
| `calc.js` | `weightVerdict(data, date, {start})` | Without `start` or `profile.program_start`: the next Monday after `date`, so the verdict is `waiting`. |
| `features/clearance.js` | `injuryDateOf(profile)`, `dateCheck(date, today, injuryDate = null)` | The profile's `injury_date` (or `null`), and the clearance-date check, which refuses a date before `injuryDate` when one is given. They replace the fixed `INJURY_DATE` constant. |
| `features/safety.js`, `views/settings.js` | The fasting-period setting | No built-in fasting period and no button that adds one: you enter your own ("for example Ramadan, other religious fasts or planned fasting"). The fasting texts name no meals and no calorie number: "train after your first meal of the day if you can", "hold your weight steady at about maintenance". |
| `features/goals.js` | `defaultGoals()` | The weight goal is `{target_kg: null, by: null}`: no personal target. Its target text comes from `profile.pre_injury_weight_kg` when that is set. |
| `features/insights.js` | Weight-trend nudges | They say "move up (or down) one meal-plan level on the Nutrition page", never a named calorie day. |
| `views/hikes.js` | Ladder examples | Shown in the order written. |
| `views/welcome.js` | The welcome steps | Step 1 greets you by name only when `profile.name` is set. The profile step has an optional `injury_date` field (also in Settings > Profile). The start-date step's example date is the next Monday. |
| `views/arm.js` | **Add the suggested appointments** | An `arm.json` `appointments_default` entry with `"date": null` gets today's date. |
| `server.py`, `store.js` | `default_data()`, `defaultData()` and the profile defaults | `profile.name` `""`, `profile.program_start` `null`, `arm.appointments` `[]`. `profile.injury_date` is optional (default `null`) and import checks it as a date. |

### `store.js`

| Export | What it does |
|---|---|
| `init({fixtures})` | Loads the data (and its ETag). Resolves `{recovered}`: `null`, or `{at, data, changes, conflicts, notes, sources}` for unsaved changes from a closed tab or crash, already merged onto the current server copy. Pass `recovered.data` to `replaceAll()` to keep them, or call `discardPending()`. |
| `get()`, `getStatus()`, `isFixtureMode()`, `lastSaved()` | As before. Status: `idle`, `saved`, `dirty`, `saving`, `error`, `fixture`, ★`conflict`. |
| `touch()`, `update(fn)` | Call after mutating data in place (unchanged). |
| `flush(opts)` | Save now. Never rejects; ★ resolves to `{status, saved, conflict, error}`. |
| `retry()` | Retry now (resets the backoff). While a conflict is pending it re-checks the server; without an `onConflict` listener it keeps your version. |
| `hasUnsaved()` | True while anything is not yet on the server. |
| `onStatus(fn)` | `fn(status, info)`; `info` = `{error, savedAt}` plus ★ `{conflict, retryAt, pendingStored, bytes, nearLimit, etag, tabId}`. `pendingStored: false` means the browser couldn't keep its safety copy (storage full); `nearLimit` means the data is over 8 MB of the server's 10 MB. |
| `onExternalChange(fn)` | Another tab's or device's changes were applied in place. ★ `fn({kind: 'reload' \| 'merge', reason, changes, notes})`. |
| `replaceAll(next)` | Replace everything (import / restore) and save. ★ Migrates first, patches in place, and merges with anything another tab saved meanwhile. |
| `discardPending()` | Drop the recovered changes offered by `init()` (kept aside in `fitness-hub:discarded`). |
| `validateImport(obj)` | The blocking problems as strings (empty = OK), as before but far more thorough. |
| ★ `validateImportDetailed(obj, {today})` | `{ok, errors, warnings, errorCount, warningCount, counts, data, bytes}`; each problem is `{path, message}`. `data` is what would be stored. |
| ★ `importData(obj)` | Validate, then (only if there are no errors) replace everything. Resolves to the validation result. |
| ★ `onConflict(fn)` | `fn(conflict \| null)` with `conflict = {id, detectedAt, count, items: [{id, label, path, collection, key, field, base, mine, theirs}]}`. Registering a listener switches the store from the "error + retry" fallback to status `conflict`. |
| ★ `getConflict()` | The pending conflict or `null`. |
| ★ `resolveConflict(choice)` | `'mine'`, `'theirs'`, or `{default: 'mine', [itemId]: 'theirs'}`. Applies, archives the losing values, saves. |
| ★ `conflictLog()`, `clearConflictLog()` | The archived conflict decisions `[{at, label, path, kept, mine, theirs}]`. |
| ★ `checkForUpdates({force})` | Ask the server whether another tab saved (focus already does this). |
| ★ `syncInfo()` | Everything in `info` plus `{status, pendingChanges, hasUnsaved}` for a sync details panel. |
| ★ `migrate(data, {report})`, `MIGRATIONS`, `SCHEMA_VERSION` (2) | The upgrade pipeline (see "Schema versions"). `normalize()` is the old name and does the same. `defaultData()` is a v2 document. |
| ★ `diffData`, `mergeData`, `applyChanges`, `patchInPlace`, `deepEqual`, `hashValue`, `recordKeys`, `ensureIds`, `cloneJSON`, `describePath`, `coerceDate`, `DATA_COLLECTIONS`, `MAX_DATA_BYTES`, `createStore(options)` | The pure merge machinery and an isolated store factory (used by the tests). ◆ `createStore` also takes `getHealth`, `saveTimeout`. |
| ◆ `restorePending()` | Restore the unsaved changes `init()` offered: re-applied onto the live data now (PE1). Resolves like `flush()`; a conflict goes to `onConflict` with `kind: 'recovery'`. `replaceAll(recovered.data)` does the same. |
| ◆ `init()` result | `recovered` also has `conflictItems: [{id, label, path, field, mine, theirs, source: 'recovery' \| 'legacy'}]` (what may need a choice, or what an old copy disagrees with). |
| ◆ `getConflict()` / `onConflict` | The conflict also has `kind`: `'sync'` (saved elsewhere meanwhile) or `'recovery'` (restoring unsaved changes). |
| ◆ Status `build-mismatch` | The hub was updated under this tab (409 on save, or noticed on focus). Saving stops; changes stay in `localStorage`; show `BUILD_MISMATCH_TEXT` and a Reload button. `hasUnsaved()` is true while changes exist, `onBeforeUnload()` doesn't warn. |
| ◆ `onBuildMismatch(fn)` | `fn({server, client, at, message} \| null)`. The browser also gets a `fitness-hub:build-mismatch` window event (`detail` the same). |
| ◆ `checkBuild({force})`, `getBuild()`, `getBuildMismatch()` | Re-read the hub's build (focus does this at most once a minute; `retry()` forces it); the build read at boot; the current mismatch or `null`. `info` / `syncInfo()` also carry `build` and `buildMismatch`. |
| ◆ `BUILD_MISMATCH_TEXT` | "The hub was updated. Reload to continue." |
| ◆ `isAvailable(id, data)`, `UNAVAILABLE_DEFAULT` | See `schedule.js` (re-exported here). |
| ◆ `legacyFill(target, v1data)`, `applyRecovery(target, sources, {choices, defaultChoice})`, `entryKeys(list)`, `CONFLICT_LOG_LIMITS` | The pure recovery rules, the block keys used to merge exercise lists, and the conflict-log limits (`{entries: 20, days: 30, chars: 200000}`). |

### `api.js`

`getText`, `apiHealth`, `apiGetData`, `apiBackup`, `HttpError` as before (`HttpError` ★ also has `.body`, the
parsed error body; status `0` means no answer or timeout). `apiPutData(text, ★{etag, keepalive})` sends
`If-Match` and resolves to the response plus ★`etag`. ★ `apiGetDataWithEtag({ifNoneMatch})` resolves
`{status: 200 | 304, data, etag, bytes}`. ★ `byteLength(text)`, `KEEPALIVE_MAX_BYTES`, `REQUEST_TIMEOUT_MS`.

◆ Round 3: the time limit covers the whole exchange, body included (PE4); every call takes an optional `{timeoutMs}`.
`apiPutData(text, {etag, keepalive, build})` sends `X-Hub-Build` (◆ `BUILD_HEADER`) when `build` is given. `HttpError`
◆ also has `.code` (`body.error` when it is a short code, e.g. `"build_mismatch"`) and `.timeout`. ◆ `buildOf(health)`
reads the build id from an `/api/health` answer. ◆ `fitsKeepalive(text)`. `byteLength` no longer copies the text, and
`bytes` from a GET is the Content-Length when the body isn't compressed. ◆ Early fetches (PERF5): a page script may set
`window.__hubPrefetch = {'/api/data': fetch('/api/data', {cache: 'no-store', credentials: 'same-origin'}), '/content/program.json': fetch(...)}`;
a plain GET of exactly that path uses its entry once, and a rejected entry falls back to a normal request.

### `stats.js` (★ data quality and CSV)

| Export | What it does |
|---|---|
| ★ `checkinIssues(checkin, data?, {previous?})` | Plausibility issues for one check-in (for live form hints): `[{level: 'error' \| 'warning', collection, key, field, path, value, message, suggestion}]`. |
| ★ `workoutIssues(workout, data?)`, `hikeIssues(hike)` | The same for a session (loads checked against last time) and a hike. |
| ★ `dataIssues(data, {limit})` | Whole-dataset audit (check-ins, workouts, hikes, arm logs, measurements) in one O(n log n) pass. |
| ★ `PLAUSIBLE`, `suggestTypoFix(value, [lo, hi], ref)` | The ranges, and the decimal-slip helper. |
| ★ `exportCSV(data, 'checkins' \| 'workouts' \| 'hikes', {today, exName})` | `{filename, text, mime}` ready for a download. Workouts are one row per set and per cardio entry (drafts left out unless `includeDrafts`). |
| ★ `checkinsCSV`, `workoutsCSV`, `hikesCSV`, `toCSV(rows, columns, {bom, eol})`, `csvCell` | The pieces. RFC 4180 quoting, CRLF, UTF-8 BOM (Excel), and text that a spreadsheet would run as a formula (`= + - @`) is prefixed with `'`. |
| `streak`, `weekSummary`, `dayInfo`, `hikeTotals`, … | As before (streaks now have no 400-day cap; `hikeTotals().longest` ignores hikes without a distance). |
| ◆ `dayInfo(ctx, date)` | Also `roles` (`[{workout, role: 'main' \| 'repeat' \| 'alternate' \| 'addon' \| 'extra'}]`), `altDone`, `mainCovered`, `viaAlternate`. `mainDone` needs the planned `session_id` (QA5). The rehab add-on is left out of `addons` until the physio programme is entered. |
| ◆ `weekSummary(ctx, weekStart)` | Bounded by today. Also `mainDoneStrict`, `altDone`. `strengthDone` excludes add-ons, alternates and repeats; `mainDone` / `adherencePct` count alternates as a session done. |
| ◆ `workoutRoles(workouts, main, program)` | The classification `dayInfo` uses. |
| ◆ `series(data, field, collection, {from, to})`, `seriesUntil(data, field, until, collection)` | Date-bounded series (QA6). |
| ◆ `lastPerformance(...)` | Also `rows` (every set row last time), `planned`, `complete`; `sets.planned` / `sets.complete` (non-enumerable) feed `suggestProgression`. `setRowsFor(w, id)`. ▲ Per block, effective `planned` (see "Round 4 at a glance"); `rows` carry the annotation too. |
| ◆ `ladderStatus(ladder, data, clearances, {today})`, `hikeMeets` | Future hikes ignored; "any ascent"; optional minimum time. |
| ◆ `weekendPlanOn(hikes, date)` | This week's `weekend_plan` entry or `null`. ▲ Third argument: the programme start, for `program_week` entries. |
| ◆ `hikeIssues(hike, data)`, `WAIST_PACK_MAX_KG` (2) | With `data`, a pack over 2 kg before `clinic_light` is flagged. |

### `calc.js`

As before, plus ★ `readinessHistory(checkins, profile)` (a `Map(date → readiness)` for charts; O(n log n)
instead of calling `readiness()` per day), ★ `armFlagsOf(checkin)`, ★ `SURPLUS_DEFAULT`, `SURPLUS_MAX`.
`readiness()` results ★ also carry `inputs` (how many readiness answers the check-in has; 0 = nothing filled in).
`rollingMean()` is now O(n).

◆ Round 3 (SPEC §5.8 revised):

| Export | What it does |
|---|---|
| ◆ `readinessOn(data, date)` | **The single source of truth** for a day's readiness (also accepts a view `ctx`). Returns `{level: 'red' \| 'amber' \| 'green' \| 'unknown', reasons[], messages[], advice, flags, checkedIn, fasting, risingPain, rhrRef: {value, source, count, threshold}, painRef, rhrRebaseline, rhrBlocked, easyDay, stop, holdLoads, inputs, date, checkin}`. `reasons` are the short "why" lines; `messages` are the texts the SPEC says must be shown (RED: the stop text; AMBER: the rising-pain and fasting texts). `unknown` = not checked in (no answer, or only a weight); a fasting day is AMBER even then. Duplicate check-ins on the date are combined (worst answer wins). |
| `readiness(checkin, checkins, profile, opts)` | The same rules for one record (red at pain ≥ 7, rising pain, fasting, method changes; a weight-only record is `unknown`). |
| `readinessHistory(checkins, profile)` | Same rules, all dates, O(n log n). |
| ◆ `READINESS_TEXT`, `READINESS_MESSAGES`, `READINESS_RULES` | The SPEC wording (`red` is the stop text, `amber` ends "hold loads"), the extra messages (`red`, `risingPain`, `fasting`) and the thresholds. |
| ◆ `countsAsCheckin(checkin)`, `CHECKIN_ANSWER_FIELDS` | "More than a weight". |
| ◆ `fastingPeriods(profile)`, `fastingOn(profile, date)` | Cleaned periods; the period covering a date (inclusive) or `null`. These and `rhrMethodChanges` take the profile or the whole data. |
| ◆ `rhrMethodChanges(profile)`, `rhrMethodChangeOn(profile, date)`, `rhrReference(checkins, date, baseline, {profile, changeDate})` | Method-change dates; the latest on or before a date; the reference with the re-baselining rule and `threshold`. |
| ◆ `painReference(checkins, date)`, `combineCheckins(list)` | The 7-day pain average (3+ readings); the worst-of merge of same-day check-ins. |
| ◆ `rollingMean(points, days, {from, to})`, `meanBetween(points, from, to)`, `trendUntil(points, today, {days, span})` | Date-bounded trend helpers for Today (QA6): `trendUntil` gives `{points, rolling, mean7, weeklyChange, latest}`. |

### `schedule.js`

As before. Resolved blocks ★ also carry `zonePlanned` / `easyZoneCapped` (cardio and circuits on an easy day)
and `easyMinutes` (intervals).

| Export (◆ round 3) | What it does |
|---|---|
| `resolveBlock` / `resolveSession` | Apply `zone_cap`, `circuit_minutes` and `rounds` (fields `zoneCap`, `zoneCapped`, `zonePlanned`, `workZonePlanned`, `roundsPlanned`, `roundsOverridden`, `circuit.minutesPlanned`, `circuitMinutesOverridden`). |
| ◆ `overrideBlockFields(override)`, `zoneNumber(z)` | `{zoneCap, circuitMinutes, rounds}` from an override (invalid values → `null`); `"Z3"` → 3. |
| `suggestProgression({reps, lastSets, increment, progressionName, ◆plannedSets, complete, deload, easyDay, easy, fasting, red, readiness})` | See "Progression suggestions". ◆ `HOLD_TEXT`, `holdReason(opts)`, `isPerformedSet(set, {loaded})`. |
| `plannedOn(program, profile, date, timeline, ◆{data})` | With `data`, the rehab add-on waits for the physio programme (`hiddenAddons`). |
| ◆ `isRehabAddon(addon, program)`, `physioProgrammeReady(data)`, `addonVisible(addon, data, program)` | The PM11 rule. |
| ◆ `alternatesOf(program)`, `alternateIds(program)`, `addonSessionIds(program)` | `{short, travel}` (existing session ids or `null`), and id sets. |
| ◆ `exerciseGate(id, exById)`, `exerciseLocked(id, clearances, date, exById)` | Fail-closed gating with an explicit library (`null` gate = unknown id = locked). |
| ◆ `isAvailable(id, data)`, `UNAVAILABLE_DEFAULT` | `false` when the id is in `profile.unavailable_exercises` (data or profile; the default list when the field is missing). |

### `dates.js`

As before, plus ★ `isLeapYear(y)`, `daysInMonth(y, m)`, `dateOfTimestamp(ts)` (the local date of an ISO
timestamp), `weeksBetween(a, b)`.

### `content.js`

As before. Each `content.status[]` entry ★ also has `problems` (short warnings from the loose validation; the
file is still used) and `detail` summarises them. Problems that matter for safety start with `Safety:`
(missing red flags, unknown gates, an exercise scheduled above its phase's gate). Non-http(s) `video` /
`source` links are dropped. ★ `contentProblems()` flattens them to `[{file, label, message, safety}]`;
★ `validateProgram(program, exById)`; ★ `RED_FLAG_IDS`, `ARM_MEASUREMENT_IDS`, `EXERCISE_CATEGORIES`,
`SESSION_TYPES`, `TEST_CATEGORIES`.

◆ Round 3: `gateOf(id)` (the loaded library's gate, `null` for an unknown id), `isLocked(id, date, data)` (fail closed:
unknown ids and an unloaded library are locked), `isAvailable(id, data)`, `UNAVAILABLE_DEFAULT`,
`compareExerciseSources(merged, parts)` (`{same, onlyMerged, onlyParts, gateDiffs}`), and `content.exerciseSources`
(`{merged, parts, same, compare}`). A merged `exercises.json` that differs from its parts is a `Safety:` problem (stricter
gate wins). `validateProgram` also checks `alternates` (safety: gate `none` only) and the new override fields;
`content.hikes.weekend_plan` is cleaned (valid `week_start`, http(s) links, sorted).

▲ Round 4: `weekend_plan` entries with a valid `program_week` are kept without a `week_start` (a bad `program_week` is
reported and dropped from the entry; `program_week` entries sort first, by week). `tests.json` `first_phase`,
`first_week` and `baseline_day` are checked (a `first_phase` that isn't a phase in program.json is reported: it would
never be due). Plus `allowedForPhase`, `whyNotAllowed`, `phaseGateOn`, `prescriptionFor`, `parseDose`, `testsDueOn`,
`testStatusOn`, `testEarliestDue`, `testBaselineDue` (see "Round 4 at a glance").

### `timers.js`

As before. The interval timer now carries overflow across segments (a throttled background tab never falls
behind real time), and all timers keep the screen awake while running (Wake Lock, where supported).
★ `stepSegments(segs, idx, left, elapsed)` (the pure stepping), ★ `holdWake(token)`, `releaseWake(token)`.

## Additions from the round 2 UI upgrade (recorded by the orchestrator)

| Field | Type | Notes |
|---|---|---|
| `ui` | object | UI state. `ui.onboarding` records whether the welcome flow has been completed or skipped (it's shown once). `ui.plates_kg` holds the plate sizes available for the leg-press plate calculator. |
| `workouts[].exercises[].swapped_from` | string or null | The exercise id this entry replaced, set when the user swaps an exercise because it's gate-locked **or** because the kit is busy or missing. Allowed swaps are limited to exercises permitted at the current gate. |
| `arm.questions` | object | Clinic-question answers. Keys are `id:<question id>` (stable ids now in `arm.json` `clinic_questions[].id`). Older keys (a hash of the question text) still resolve as a fallback. Records store `topic`, `asked` (tick), `answer` and `updated`. |

## Additions from the round 3 UI fixes (recorded by the orchestrator)

| Field | Type | Notes |
|---|---|---|
| `workouts[].easy_choice` | `"easy"`, `"normal"` or null | An explicit user override of easy-day mode for that workout. Easy-day mode otherwise follows `readinessOn` live. |
| `checkins[].meal_followed` | `"yes"`, `"mostly"`, `"no"` or null | Whether the meal template was followed. "Yes" auto-fills 100% of the template's protein and kcal; "mostly" fills 80%. |
| `checkins[].meal_template` | string or null | The id of the nutrition.json meal template used for the auto-fill. |
| `checkins[].quick_adds` | array | Quick-add food entries (`{name, protein_g, kcal}`) on top of the template. |
| `weekly_reviews[].focus_done` | boolean or null | Ticks off the previous week's focus in Review. |
| `ui.p0_checklist` | object | Phase 0 checklist ticks (PAR-Q+, gym induction, leg-press stops, baseline tests). |
| `goals` | object | The 12-week goals (weight trend target, Zone 2 minutes, leg-press +20%, protein days, adherence), with defaults from ch01. The weight goal has no personal default (`target_kg: null`, `by: null`); its target text comes from `profile.pre_injury_weight_kg` when that is set. Owned by the UI and preserved by migration. |

## Final round 4 behaviour notes (recorded by the orchestrator)

- **Prefill rule** (`features/sets.js`): each set prefills from **last time's matching set**, shifted by the progression suggestion. It never exceeds the planned RIR. On hold days (deload, easy, fasting or red), it never prefills above last time's reps. Number inputs select all on focus, so typing replaces the value.
- **Swaps after sets are ticked:** ticked sets are never relabelled. The swap dialog asks you to untick them first, or to add the stand-in as an **extra exercise** entry, which starts fresh with its own prescription.
- **Pain scale:** a 7/10 or higher reading turns the day red. Moving the value across the 7 boundary in either direction asks for confirmation.
