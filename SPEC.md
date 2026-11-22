# Fitness Hub — Shared Build Spec (read fully before writing anything)

This is the single source of truth for everyone building the Fitness Hub, a locally hosted coaching hub plus an exhaustive training guide. Every agent writes **only the files it owns** (section 3). The JSON contracts in section 5 are fixed. If you need a change, don't make it. Report it in your final message.

---

## 1. Target user

The hub and its guide are written for an **experienced lifter returning to training after an arm fracture** (for example a forearm fracture, possibly with surgical plates), who is detrained by the layoff. They may not yet be cleared by the fracture clinic or have started physio, so everything works from gate `none` upwards (section 4).

- **Voice:** write for an experienced lifter: no novice explanations of basic technique. Muscle memory means lost muscle returns faster than new muscle is built. Use the second person ("you").
- **UK context:** NHS guidance, metric units and UK English. No home city is assumed: hiking content uses UK routes and covers getting to the hills by public transport in general terms.
- **Unknown to the content:** the user's age, sex, height, weight, injured side and clinic details. The hub collects them, so content uses formulas and ranges, never personal numbers.
  - If a worked example is needed, use the clearly labelled **example profile: a 30-year-old, 80 kg, 180 cm adult**. Protein at 1.8 g/kg is about 145 g; Tanaka HRmax is about 187; Zone 2 (60–70% of HRmax) is about 112–131 bpm; MAF is 180 − 30 = 150; BMR (Mifflin–St Jeor) is 1,780 kcal for a man or 1,614 kcal for a woman. Or say "use the calculator on the Nutrition page".
- **Schedule:** training most days, 60–90 min a session.
- **Gym equipment (assumed: a commercial gym):** treadmill, stair climber, rower, ski erg, bike, squat rack, leg press, hamstring curl, leg extension, lat pulldown, row machine, chest press machine, free weights (dumbbells, barbells, plates), ropes, sled, sandbags with handles, medicine ball, mats, cable machines, Smith machine, bench press, benches.
  - Not assumed: sled harness or waist belt, cable ankle strap, plyo boxes or steps, recumbent bike, 45° back extension, kettlebells, dip belt. Always give an alternative when you use one of these.
  - The leg press is a **plate-loaded 45° machine with safety catches**, so the programme uses a dead-start method. A sled belt and ankle straps may be missing; the programme has substitutes (`profile.unavailable_exercises`, section 5.2).
- **Goals:**
  1. Functional fitness.
  2. Long-distance hiking on all terrains.
  3. Core stability.
  4. Carrying ("farmer") strength.
  5. Building muscle, first regaining what the layoff took.
- **Diet and kit:** none is assumed. Meal plans offer halal-friendly and vegetarian swaps as options, and label-reading tips sit in an optional "If you eat halal" section. A smart scale and a wearable or chest strap help, but every reading can be typed in.
- **The coaches and researchers this programme draws on:** Pavel Tsatsouline (StrongFirst), Pat McNamara (TMACS), Peter Attia, Andy Galpin, Andrew Huberman, Bill Maeda, Tom Haviland (via Josh Bryant), plus Joe Rogan and his guests.
- **Hosting:** loopback on a desktop, or a Unix socket on a Linux home server reached through an SSH tunnel, with optional identity-gated Tailscale Serve (section 5.7a).

## 2. Safety non-negotiables

These apply everywhere: content, program and UI.

1. Until the relevant **gate** (section 4) is cleared:
   - Nothing grips, holds, pushes, pulls, braces or bears weight through the injured arm.
   - No equipment that needs two hands: rack, Smith machine, barbells, rower, ski erg, battle ropes, sled push, two-handed machines, medicine ball.
   - Getting into or out of any machine, or up from the floor, must not need the injured arm.
2. **Fall risk is the biggest threat** while the bone heals. Before full clearance:
   - No jumping or plyometrics, sprints, wobble or balance boards, rough or slippery terrain, or outdoor cycling.
   - Balance work is always done next to a support the good hand can touch.
3. **No maximal breath-hold straining (Valsalva)** before clearance. Use moderate bracing, exhale on effort.
4. **Good-arm training** only once the `good_arm_ok` gate is set.
   - Anything physio-prescribed overrides this program.
   - Rehab exercises for the injured arm are "as prescribed by your physio" only.
5. **Never diagnose.** Frame the fracture clinic and physio as the authority. Recommend medical review for red flags (section 5.8).
6. **No dieting** while the bone heals. A small surplus is the default.

## 3. Layout and ownership

Root: the repository root (the folder that holds `server.py`).

| Path | Owner |
|---|---|
| `server.py`, `start_hub.bat`, `README.md`, `SPEC-DATA.md`, `public/index.html`, `public/css/*`, `public/js/*`, `public/dev-fixtures/*` | **hub-builder** |
| `public/content/program.json`, `public/content/tests.json` | **program-designer** |
| `public/content/exercises/part-a.json` | **exercise-library-a** |
| `public/content/exercises/part-b.json` | **exercise-library-b** |
| `public/content/hikes.json` | **hiking-coach** |
| `public/content/nutrition.json` | **nutrition-coach** |
| `public/content/arm.json` | **rehab-coach** |
| `public/content/guide/*.md` | see section 6 (one owner per chapter) |
| `public/content/guide/index.json`, `00-start-here.md`, `public/content/exercises.json` (merged), `SPEC.md` | **orchestrator** (don't touch) |
| `data/` (user data, created at runtime) | server only |

**Content agents must not create or modify any other file, and must not start servers.**

## 4. Gates (clearance levels, cumulative, lowest to highest)

| id | Meaning |
|---|---|
| `none` | Available now |
| `good_arm_ok` | The clinic or physio said it's OK to train the uninjured arm |
| `clinic_light` | Cleared for light use of the injured arm, and/or physio rehab has started |
| `grip_cleared` | Physio cleared gripping and holding weights (light to moderate). Still no weight-bearing on the wrist, hanging or impact |
| `full_clearance` | Fully cleared: heavy loading, carrying, hanging, weight-bearing on hands (push-ups, planks), impact and jumping |

- **Cumulative:** a gate counts as met if it, or any higher gate, has a cleared date on or before the day in question.
- **Weight-bearing through the injured wrist** (push-ups, planks, quadruped work, bird dog, side plank on the forearm) and **hanging** are `full_clearance`. The one exception is physio-graded wall presses (`grip_cleared`).

## 5. JSON contracts

All files are UTF-8 with no comments. Validate yours with `python -c "import json;json.load(open(r'PATH',encoding='utf-8'))"`.

### 5.1 `exercises/part-a.json` and `part-b.json`

Each is a JSON array of exercise objects:

```json
{
  "id": "leg-press",
  "name": "Leg press",
  "category": "squat",
  "gate": "none",
  "arm_use": "none",
  "fall_risk": "low",
  "equipment": ["leg press machine"],
  "muscles": ["quads", "glutes", "adductors"],
  "why": "1–3 sentences: why this is in YOUR program (link to the goals).",
  "setup": ["step", "step"],
  "cues": ["3–6 short coaching cues"],
  "mistakes": ["2–4 common mistakes, each with the fix"],
  "arm_safety": "How to do it without the injured arm (getting in or out, safety catches, what to do with the arm). Required when gate is none or good_arm_ok.",
  "regressions": ["box-squat-bw"],
  "progressions": ["leg-press-single"],
  "dose": "3 × 8–12, RIR 2–3",
  "video": "https://www.youtube.com/results?search_query=leg+press+form+squat+university",
  "source": "optional URL"
}
```

Field values:
- `category`: one of `squat | hinge | single-leg | knee-ankle | calves | hip | core | balance | mobility | conditioning | push | pull | carry | grip | power | rehab`.
- `gate`: a gate id.
- `arm_use`: `none | good-arm | injured-light | both`.
- `fall_risk`: `low | medium | high`.

### 5.2 `program.json`

```json
{
  "version": 1,
  "default_start_date": null,
  "gates": [{"id": "none", "label": "...", "description": "..."}],
  "phases": [{
    "id": "p1",
    "name": "Phase 1 — Foundation",
    "short": "Foundation",
    "entry_gate": "none",
    "weeks": 8,
    "repeat_from_week": 3,
    "goal": "paragraph",
    "focus": ["..."],
    "exit_criteria": ["..."],
    "week_template": {"mon": "session-id", "tue": "...", "wed": "...", "thu": "...", "fri": "...", "sat": "...", "sun": "rest"},
    "week_overrides": [
      {"week": 1, "label": "Intro", "sets_max": 2, "rir": "3-4", "cardio_scale": 0.7, "notes": "..."},
      {"week": 5, "label": "Deload", "deload": true, "notes": "..."}
    ],
    "weekly_targets": {"zone2_min": 120, "strength_sessions": 3, "steps_avg": 7000, "long_session_min": 60}
  }],
  "addons": [{"id": "rehab", "name": "...", "gate": "clinic_light", "until_gate": "full_clearance", "days": ["mon","tue","wed","thu","fri","sat","sun"], "session": "session-id"}],
  "sessions": {
    "session-id": {
      "name": "Strength A — Squat & Knee",
      "type": "strength",
      "duration_min": 70,
      "summary": "...",
      "warmup": "routine-id",
      "blocks": [],
      "cooldown": "routine-id"
    }
  },
  "routines": {"mobility-daily": {"name": "...", "minutes": 10, "items": [{"exercise": "id", "dose": "10 / side"}]}},
  "rules": {"progression": "...", "deload": "...", "readiness": "...", "missed_sessions": "...", "increments_kg": {"leg-press": 10, "machine": 2.5, "dumbbell": 2, "barbell": 2.5, "default": 2.5}}
}
```

Notes on `program.json`:
- `default_start_date` is `null` in the shipped content. A deployer may set it to a `YYYY-MM-DD` Monday (see "Programme start" below).
- `type` is one of `strength | cardio | intervals | hike | circuit | mobility | rehab | rest`.
- `warmup` and `cooldown` are optional routine ids.
- `repeat_from_week`: if the next phase's gate isn't met when this phase ends, the hub loops weeks `repeat_from_week..weeks`. Use `null` to repeat the final week.
- `cardio_scale` multiplies cardio minutes.

**Block shapes** (each block has exactly one shape):
- **Strength:** `{"exercise": "id", "sets": 3, "reps": "8-12", "rest_s": 120, "tempo": "3-1-1-0", "rir": "2-3", "load": "double-progression", "notes": "..."}`. For per-side work add `"per_side": true`.
- **Timed:** `{"exercise": "id", "sets": 2, "seconds": 45, "rest_s": 60, "notes": "..."}`.
- **Cardio:** `{"exercise": "id", "minutes": 20, "zone": "Z2", "minutes_by_week": [10,13,16], "notes": "..."}`. `minutes_by_week` is optional and indexed by phase-week. If it's shorter than the phase, the last value is reused.
- **Intervals:** `{"exercise": "id", "warmup_min": 10, "cooldown_min": 10, "intervals": {"work_s": 30, "rest_s": 90, "rounds": 6, "work_zone": "Z5", "rest_zone": "Z1"}, "notes": "..."}`.
- **Circuit:** `{"circuit": {"minutes": 30, "rounds": null, "items": [{"exercise": "id", "dose": "20 m"}]}, "zone": "Z2-Z3", "notes": "..."}`.

**Hub scheduling semantics** (the builder implements these, the designer designs for them):
- **Programme start:** `profile.program_start`, else `program.default_start_date`, else **the next Monday after today**. That fallback is recomputed daily until the user picks a date in the welcome or in Settings. The scheduler always uses the Monday of the chosen week.
- Phases run back to back from the program start date (always a Monday).
- A phase whose `entry_gate` isn't met when its turn comes doesn't start. The previous phase keeps looping, as described under `repeat_from_week`.
- Once the gate is met, the phase starts the next Monday on or after the later of (gate date, previous phase's planned end).
- Add-ons append their session on their listed days while `gate` is met and `until_gate` is NOT met.

**Review update (round 2). These additions are part of the contract:**
- Phase field `min_weeks` (optional). If the NEXT phase's `entry_gate` is already met, the next phase may start on the next Monday on or after max(gate date, this phase's start + `min_weeks` weeks). If it's absent, `min_weeks` = `weeks`. While waiting for a gate, the looping rules still apply.
- Add-on field `phases` (optional array of phase ids). The add-on is active only in those phases, and only while `gate` is met and `until_gate` (which may now be `null`) is not.
- Deload weeks (`deload: true`): the hub halves sets (rounding up), and `intervals` blocks become easy: rounds halved (rounding up) and the work zone capped at Z3. Never combine `sets_max` with `deload` in the same override.
- `minutes_by_week` takes precedence over `cardio_scale`. Designers must write deload and taper minutes directly into `minutes_by_week`.
- Session blocks may use `"load": "bodyweight"` or `"load": "physio"`. The hub only suggests load progressions for `"double-progression"`.

**Round 3 contract additions (binding):**
- `week_overrides[]` may also contain:
  - `zone_cap`, e.g. `"Z3"`. Caps that week's interval `work_zone`, cardio `zone` and circuit `zone`, both in what's displayed and in the timers.
  - `circuit_minutes` (number). Overrides circuit block minutes.
  - `rounds` (number). Overrides interval rounds.
- **Deload weeks and easy-day mode hold loads.** The hub never suggests adding load or reps then. It shows "Hold: same load, RIR 3–4".
- **Fasting overlay** (hub-level, not in program.json). The user enters fasting periods in Settings (`profile.fasting_periods`; for example Ramadan, other religious fasts or planned fasting). The hub has no built-in suggestion. On dates inside a period, the hub applies easy-day mode automatically (as for AMBER), and shows "Fasting: train after your first meal of the day if you can. Stop at any dizziness or light-headedness. No new lifts this period." Phase dates don't move.
- **Unavailable exercises.** `profile.unavailable_exercises` (ids) are never offered in swaps or as alternatives, and are labelled "Not available at your gym" in the library. The migration default is the five belt and ankle-strap ids: `sled-drag-forward-belt`, `sled-drag-backward-belt`, `cable-kickback-ankle`, `cable-hip-abduction-ankle`, `cable-hip-adduction-ankle`.
- **Fail closed.** An exercise id that isn't in the library is treated as **locked**.
- **Counting.** Add-on sessions never count towards `strength_sessions` or weekly adherence. A day's planned session counts as done only when a workout with that `session_id` exists.

**Round 3 PM additions (binding):**
- **program.json `alternates`:** `{"short": "<session-id>", "travel": "<session-id>"}`. Both are gate-`none` sessions:
  - a minimum viable session of about 25–30 min, for "never miss twice"
  - a gym-closed or travel session using bodyweight only
  The UI offers them as "Short on time?" and "Gym closed?" on Today and Train. Logging one counts as a session done, but not as the planned strength session.
- **The rehab add-on is displayed and counted only once `data.arm.physio_exercises` is non-empty.** Until then, the Arm page says "Waiting for your physio's programme".
- **Data keys owned by the UI:** `ui` and `goals`. Migration MUST preserve unknown top-level keys and their contents (`ui`, `goals`, `kit_owned`, any future ones). Only quarantine values that are malformed inside the known schema.
- **hikes.json `weekend_plan`:** `[{"week_start": "YYYY-MM-DD", "name": "...", "minutes": 40, "level": 1, "notes": "...", "url": "..."}]`. The UI shows the entry for the current week on the Saturday long-walk card and on the Hikes page. Each ladder level's examples are shown in the order written.
- **tests.json:** remove the tests that duplicate data logged elsewhere (body weight, resting HR, waist, thigh, leg press, grip; grip lives on the Your arm page). Keep about 6–8 real tests, and add a hollow-hold core test.

**Round 4 contract additions (binding):**
- **The planned prescription is stored with each log.** When a workout is saved, every `exercises[]` entry stores `planned: {sets, reps, rir, seconds?, load}`. This is the *effective* prescription that day, after `sets_max`, deload, easy-day or fasting halving, and swaps. `suggestProgression` judges "all planned sets done" against `entry.planned.sets`. For older logs it recomputes the effective sets for that date. It never judges against the raw block sets.
- **Last performance is per block.** Prefer the most recent log of the same exercise **in the same session template and block key**. Next best is the same exercise with a compatible prescription (same rep range), then any log of it. Logs from `alternates` sessions are never used as the baseline for a full session.
- **Phase-appropriate swaps.** Swap and "Add an exercise" offer only exercises with gate ≤ the **current phase's `entry_gate`**, never above the user's clearances, and not in `unavailable_exercises`. A swapped-in exercise is shown with its **own** prescription type (timed, reps or loaded, with a kg column for loaded work), its own cues and its default dose.
- **Readiness also reads the arm log.** A same-day `arm.logs` value of `pain_rest` or `pain_activity` ≥ 7 is RED, exactly like the check-in's arm pain. Saving a rehab log at that level brings up the red-flag guidance.
- **Streaks and adherence.**
  - RED days and fasting easy days are neutral. They're not "missed" and don't break streaks.
  - A logged hike on a day whose planned session is a long walk or hike counts as that session done if it lasts ≥70% of the planned minutes. It's counted once, not twice.
- **Weight-gain bands** (experienced lifter, in `calc.js`):
  - Optional `profile.pre_injury_weight_kg`. While the current 7-day average is below it, use the **regain band, +0.25 to +0.5 kg/week**, because muscle memory brings lost muscle back faster than new muscle is built.
  - Otherwise use the **lean-gain band, +0.15 to +0.3 kg/week**.
  - With no pre-injury weight set, use +0.2 to +0.4.
  - Weight-trend nudges ignore fasting windows and the 14 days after them. They're judged on non-overlapping 14-day windows with at least 10 weigh-ins, giving one verdict per fortnight that the goals card and the coach notes share.
  - Nudges never name a meal-plan calorie day. They say "move up (or down) one meal-plan level on the Nutrition page". During a fast the advice is to hold your weight steady at about maintenance, with no fixed calorie number.
- **tests.json scheduling fields** (optional):
  - `first_phase` (a phase id) and `first_week` (a phase week). A test is never due before them. The dead-hang and farmer's-carry tests first become due at **p4a week 4**.
  - `baseline_day` (1–3 = Mon–Wed of programme week 1) for first-week baselines.
  - No test is due during a fasting period.
- **hikes.json `weekend_plan`:** entries may use `program_week` (1–8, relative to the programme start) instead of `week_start`. `program_week` takes precedence.
- **No raw gate ids in user-facing text.** Show the gate labels: "Now", "Good arm OK", "Light use / rehab started", "Grip cleared", "Full clearance".

### 5.3 `tests.json`

A JSON array of test objects:

```json
{"id": "sit-to-stand-30s", "name": "30-second sit-to-stand", "category": "strength", "unit": "reps", "higher_is_better": true, "gate": "none", "every_weeks": 4, "how": ["steps"], "equipment": "...", "norms": "short text or empty", "safety": "..."}
```

`category` is one of `strength | endurance | balance | mobility | body | grip | engine`.

### 5.4 `hikes.json`

```json
{
  "ladder": [{"level": 1, "name": "...", "description": "...", "gate": "none", "criteria": {"distance_km": 8, "ascent_m": 150, "pack_kg": 0, "terrain": "good paths"}, "examples": [{"name": "...", "region": "...", "distance_km": 8, "ascent_m": 150, "terrain": "...", "url": "https://..."}]}],
  "kit": [{"item": "...", "category": "footwear|clothing|pack|navigation|safety|food-water|other", "essential": true, "notes": "..."}],
  "terrain_skills": [{"terrain": "scree", "technique": ["..."], "gate": "full_clearance"}]
}
```

### 5.5 `nutrition.json`

```json
{
  "foods": [{"name": "Greek yoghurt (0% fat)", "category": "dairy", "serving": "170 g pot", "kcal": 100, "protein_g": 17, "calcium_mg": 190, "notes": ""}],
  "meal_templates": [{"id": "day-2600", "name": "...", "kcal": 2600, "protein_g": 150, "notes": "...", "meals": [{"time": "06:15 pre-gym", "name": "...", "items": ["..."], "kcal": 300, "protein_g": 25}]}],
  "supplements": [{"name": "Creatine monohydrate", "dose": "3–5 g/day", "timing": "...", "evidence": "strong", "why": "...", "cautions": "..."}],
  "shopping_list": [{"category": "...", "items": ["..."]}]
}
```

`evidence` is one of `strong | moderate | weak | avoid`.

### 5.6 `arm.json`

```json
{
  "red_flags": [{"id": "pain_increasing", "label": "...", "action": "..."}],
  "clinic_questions": [{"topic": "...", "question": "...", "why": "..."}],
  "healing_stages": [{"stage": "...", "typical_timing": "...", "what_happens": "...", "training_implications": "..."}],
  "measurements": [{"id": "grip_injured_kg", "name": "...", "unit": "kg", "how": "...", "reference": "..."}],
  "appointments_default": [{"date": null, "type": "Fracture clinic", "notes": ""}]
}
```

`appointments_default` entries may have `"date": null`. The Arm page's "Add the suggested appointments" button then uses today's date.

The `red_flags` ids are fixed and must all be present: `pain_increasing`, `swelling_new`, `redness_heat`, `wound_discharge`, `fever_unwell`, `numbness_tingling`, `colour_cold`, `deformity_give`, `fall_on_arm`. The `measurements` ids should include `pain_rest`, `pain_activity`, `grip_injured_kg`, `grip_good_kg`, `wrist_flex_deg`, `wrist_ext_deg`, `pronation_deg`, `supination_deg`.

### 5.7 User data (`data/data.json`, builder owns)

Builder: keep at least these fields, and document any extras in `SPEC-DATA.md`.

```json
{
  "schema_version": 1,
  "profile": {"name": "", "sex": null, "birth_year": null, "height_cm": null, "injured_arm": null, "dominant_hand": null, "program_start": null, "activity_factor": 1.55, "surplus_kcal": 300, "protein_g_per_kg": 1.8, "hrmax_override": null, "rhr_baseline": null, "diet_notes": "", "clearances": {"good_arm_ok": null, "clinic_light": null, "grip_cleared": null, "full_clearance": null}},
  "checkins": [{"date": "YYYY-MM-DD", "weight_kg": null, "rhr": null, "hrv": null, "sleep_h": null, "sleep_q": null, "energy": null, "soreness": null, "mood": null, "stress": null, "arm_pain": null, "arm_flags": [], "steps": null, "protein_g": null, "calories": null, "water_l": null, "creatine": false, "notes": ""}],
  "workouts": [{"id": "uuid", "date": "YYYY-MM-DD", "session_id": "...", "phase_id": "...", "phase_week": 1, "duration_min": null, "rpe": null, "notes": "", "exercises": [{"exercise": "id", "sets": [{"kg": null, "reps": null, "seconds": null, "rir": null, "done": true}], "notes": ""}], "cardio": [{"exercise": "id", "minutes": null, "zone": "Z2", "avg_hr": null, "distance_km": null, "ascent_m": null, "level": null, "notes": ""}]}],
  "hikes": [{"id": "uuid", "date": "...", "name": "...", "distance_km": null, "ascent_m": null, "duration_min": null, "pack_kg": 0, "terrain": "...", "avg_hr": null, "rpe": null, "ladder_level": null, "notes": ""}],
  "tests": [{"date": "...", "test": "test-id", "value": null, "notes": ""}],
  "measurements": [{"date": "...", "waist_cm": null, "chest_cm": null, "hips_cm": null, "thigh_cm": null, "calf_cm": null, "arm_good_cm": null, "arm_injured_cm": null, "forearm_good_cm": null, "forearm_injured_cm": null}],
  "arm": {"appointments": [{"date": "YYYY-MM-DD", "type": "Fracture clinic", "notes": "", "outcome": ""}], "logs": [{"date": "...", "values": {"pain_rest": 1}, "notes": ""}], "physio_exercises": [{"exercise": "id or free text", "dose": "", "since": "", "notes": ""}]},
  "weekly_reviews": [{"week_start": "YYYY-MM-DD", "wins": "", "struggles": "", "next_focus": "", "adherence_pct": null}]
}
```

Defaults (the server's `default_data()` and the store's profile defaults) hold nothing personal:
- `profile.name` is `""`. The welcome greets the user by name only when one is set.
- `profile.program_start` is `null`, so the start rule in section 5.2 applies until the user picks a date.
- `arm.appointments` is `[]`. No appointment is assumed.
- The optional `profile.injury_date` (`YYYY-MM-DD` or `null`, default `null`) sets the earliest date a clearance can have. See `SPEC-DATA.md`.

### 5.7a Data API concurrency (review round 2, binding for server and store)

- `GET /api/data` returns the JSON with a strong `ETag: "<sha256 hex of the stored bytes>"` header.
- `PUT /api/data` must send `If-Match: "<etag>"`.
  - **Missing `If-Match`:** `428 Precondition Required`.
  - **Mismatch:** `412 Precondition Failed`, with body `{"error": "...", "current_etag": "\"...\""}`.
  - **Success:** `200`, with a new `ETag` header and body `{"ok": true, "etag": "\"...\""}`.
- `POST /api/backup` is unchanged.
- **The client must never silently lose data.** On a 412 it re-fetches and merges safely, or keeps the local unsaved changes and asks the user.
- Writes are serialised server-side with a lock.

**Round 3 additions:**
- **Build id.**
  - `/api/health` returns `build`: the content of `BUILD_ID` written by `make_bundle.py`, or `"dev"`.
  - The client reads `build` at boot and sends `X-Hub-Build: <build>` on every PUT.
  - The server returns `409 {"error":"build_mismatch","build":"..."}` if the header differs from its own build. No check is made when the server build is `"dev"`.
  - On a 409, the client keeps local changes and shows "The hub was updated. Reload to continue."
- **Proxy tripwire.** Any request on the main listener carrying `Forwarded`, `X-Forwarded-For`, `X-Forwarded-Host`, `X-Forwarded-Proto`, `X-Real-IP`, `Via` or `Tailscale-*` gets a 403. `FITNESS_HUB_EXTRA_HOSTS` is **removed**.
- **Tailscale phone access (opt-in; round 4).**
  - A **second** Unix socket, `FITNESS_HUB_TS_SOCKET` (0600, in the same 0700 runtime directory). It's the target of `tailscale serve`, which needs Tailscale ≥1.104.4.
  - It has its own `TailscalePolicy`:
    - `Tailscale-User-Login` must be in `FITNESS_HUB_TS_USERS` (exact match, no fallback).
    - `X-Forwarded-Host` must equal `FITNESS_HUB_TS_HOST` (an exact `*.ts.net` name).
    - Host must be `localhost` or the TS host.
    - Writes must send exactly `Origin: https://<TS_HOST>`.
    - Funnel requests get a 403.
  - The mode turns on only when all three variables are valid. `verify.sh` asserts that Funnel is off and probes the policy.
  - The hosting guide in `deploy/` (§14) covers it, and it's applied only when the user explicitly asks.
- **Linux socket mode.**
  - On the server the hub listens on a Unix socket: `FITNESS_HUB_SOCKET`, created with mode 0600 inside `$XDG_RUNTIME_DIR/fitness-hub/` (0700). There is no TCP listener.
  - The PC tunnels with `ssh -L 127.0.0.1:8642:/run/user/<uid>/fitness-hub/hub.sock`.
  - The Host allowlist stays `127.0.0.1:8642` / `localhost:8642`.
  - TCP loopback mode remains for running on a desktop.
- **Precondition order.** Check `If-Match` (and the build) **before** reading the request body.
- **Backups.**
  - Take an automatic backup before any PUT that shrinks an array by more than 5 records or more than 10%.
  - Rate-limit `POST /api/backup`.
  - Prune by the date in the backup name (mtime as tiebreak). Never prune the file just written or today's copy.
  - The client aborts an import if its pre-import backup fails.

**Ports for agents:**
- Port 8642 and the real `data/` folder belong to the user's live instance. Never use them in tests.
- Each agent uses its own port with `FITNESS_HUB_PORT` and a temporary `FITNESS_HUB_DATA_DIR`.

### 5.8 Readiness rule (hub and content must agree; revised in round 3)

There is a **single source of truth**: `calc.js` `readinessOn(data, date)`. Every page (Check-in, Today, Train) and every coach note uses it. A check-in counts only if it includes more than a weight.

**RED.** Any arm red flag is ticked, **or** arm pain is 7/10 or more.
- Show "Stop. No training today, including your physio exercises, until you've been advised. Contact your fracture clinic today, or NHS 111 / 999 as the red-flag guidance says."
- Disable add-ons and the Start buttons.

**AMBER.** Easy day: halve the sets, Zone 2 only, no intervals, hold loads. It applies if any of these is true:
- Morning resting HR is at least the 7-day average + 5 bpm. This only counts once there are 5 or more readings since the latest `profile.rhr_method_changes` date, so switching from a wearable to a manual pulse (or to another device) doesn't trigger false AMBER days.
- Sleep under 6 h.
- Arm pain 4/10 or more.
- **Arm pain is 2 or more points above its 7-day average**, with at least 3 earlier readings. Add this message: "Rising arm pain can be the red flag 'pain getting worse'. If it keeps rising, or you're unsure, call your fracture clinic today."
- Soreness 7/10 or more.
- Energy 2/5 or less.
- A date inside `profile.fasting_periods`.

**GREEN.** Otherwise. Coach notes must never recommend an easy day when readiness is GREEN. They may only point out trends.

**Medical warning, in content:** dark (cola-coloured) urine with severe muscle pain or swelling after training needs same-day medical advice (possible rhabdomyolysis).

### 5.9 Shared constants

- **HRmax:** Tanaka formula, 208 − 0.7 × age. Allow an override.
- **Zones (% HRmax):** Z1 50–60, Z2 60–70, Z3 70–80, Z4 80–90, Z5 90–100.
  - Zone 2 field check: you can speak in full sentences but would rather not. Nasal breathing is possible.
  - Cross-check: MAF, 180 − age.
- **Calories:** BMR by Mifflin–St Jeor. Men: 10W + 6.25H − 5A + 5. Women: 10W + 6.25H − 5A − 161.
  - TDEE = BMR × activity factor. Default 1.55; range 1.375–1.725.
  - Lean gain = TDEE + 250–300 kcal. Target scale gain 0.2–0.4 kg/week.
- **Protein:** 1.6–2.2 g/kg/day. Hub default is 1.8.
- **Micronutrients:** calcium 700 mg/day (UK adult reference). Vitamin D 10 µg/day, October–March (UK advice).
- **Creatine:** 3–5 g/day.
- **Steps:** build towards 8,000–10,000 a day.
- **Arm pain rule (injured arm, everywhere):** follow your physio's limit. If you weren't given one, keep pain at 2/10 or below during the exercise, back to your usual level by the next morning. Never train through pain that's increasing.
- **Grip ladder (injured hand as % of good hand):**
  - At least 70%: light holds and carries begin. Needs `grip_cleared` plus physio OK.
  - At least 80%: moderate farmer's carries.
  - At least 90%: heavy carries and hanging. Needs `full_clearance`.
- **Carrying rule (one rule everywhere; its home is ch18):**
  - **Training carries** (suitcase, farmer, sandbag): none until `grip_cleared`, then follow the grip ladder.
  - **Daily life until `clinic_light`:** nothing in the hand or on the shoulder of your injured arm. A light bag (3 kg or less) on your OTHER shoulder, or a waist pack, is fine. Put it on and take it off with your uninjured hand.
  - **On walks** (hike Levels 1–3): a waist pack only (2 kg or less).
  - **From `clinic_light`:** a light day pack on both shoulders. Start at 2–4 kg, with the hip belt fastened, and put it on seated, uninjured arm first. Add about 1 kg every 2–3 weeks if the walk and the next morning feel fine.
- **Cardio machines until `full_clearance`:** your uninjured hand lightly on the rail of the stair climber or treadmill, injured arm across your stomach, safety key clipped on. Never step onto a moving belt.
- **Step height until `full_clearance`:** an aerobic step (15–25 cm) or the bottom stair. No benches as boxes.
- **Estimated 1RM:** Epley, kg × (1 + reps/30). Use it for progress charts only; there's no 1RM testing.

### 5.10 Canonical exercise IDs

`program.json` may only reference these. The library agents must define every id in their range. If you need a new one, use the prefix `x-`, define it yourself if you're a library agent, and report it.

**Part A (exercise-library-a): gates `none`, `good_arm_ok`, `clinic_light`**

- **Squat and knee:**
  - Machines and bodyweight squats: `leg-press`, `leg-press-single`, `calf-raise-leg-press`, `leg-extension`, `hamstring-curl`, `box-squat-bw`, `tempo-squat-bw`, `wall-sit`, `spanish-squat-band`.
  - Single-leg and step work: `split-squat-bw`, `rfe-split-squat-bw`, `step-up-bw`, `lateral-step-up-bw`, `step-down-eccentric`, `patrick-step`, `box-pistol`.
- **Hinge and hip:**
  - Hinges and bridges: `single-leg-rdl-bw`, `glute-bridge`, `glute-bridge-single-leg`, `glute-bridge-march`, `hip-thrust-bench-bw`, `hip-thrust-single-leg`.
  - Cable and side-lying hip work: `cable-kickback-ankle`, `cable-hip-abduction-ankle`, `cable-hip-adduction-ankle`, `side-lying-hip-abduction`, `side-lying-hip-adduction`, `back-extension-45`.
- **Sled (belt or harness):** `sled-drag-forward-belt`, `sled-drag-backward-belt`.
- **Calves and ankle:** `tibialis-raise-wall`, `calf-raise-single-bw`, `bent-knee-calf-raise`.
- **Core and balance:** `dead-bug-legs`, `hollow-hold-tuck`, `reverse-crunch`, `curl-up-mcgill`, `single-leg-balance`, `breathing-90-90`.
- **Mobility:** `ankle-knee-to-wall`, `hip-90-90-switch`, `couch-stretch`, `deep-squat-hold-box`, `hip-circles-standing`, `thoracic-rotation-seated`, `leg-swings`, `calf-stretch-wall`, `hip-flexor-stretch-half-kneeling`, `hamstring-stretch-bench`.
- **Cardio:** `stair-climber`, `incline-walk`, `bike-upright`, `bike-recumbent`, `walk-outdoor`, `hike-outdoor`.
- **Good arm only (`good_arm_ok`):** `ga-chest-press-machine`, `ga-cable-row`, `ga-lat-pulldown`, `ga-db-curl-seated`, `ga-triceps-pushdown`, `ga-db-shoulder-press-seated`, `ga-wrist-curl`, `ga-grip-squeeze`, `suitcase-carry-good-hand`.
- **Rehab (`clinic_light`, physio-prescribed only):**
  - Range of motion: `rehab-finger-tendon-glides`, `rehab-wrist-flex-ext`, `rehab-forearm-rotation`, `rehab-wrist-deviation`, `rehab-elbow-flex-ext`.
  - Grip and light loading: `rehab-putty-grip`, `rehab-towel-wring`, `rehab-wrist-curl-light`, `rehab-reverse-wrist-curl-light`, `rehab-hammer-rotation-light`, `rehab-rice-bucket`.
- **Light ruck (`clinic_light`):** `ruck-light`.
- **Physio programme (`clinic_light`, added in review):** `x-physio-programme`, a placeholder meaning "your physio's programme exactly as prescribed".

**Part B (exercise-library-b): gates `grip_cleared`, `full_clearance`**

- **Lower body:**
  - Squats: `goblet-squat`, `smith-squat`, `back-squat`.
  - Single-leg with dumbbells: `db-split-squat`, `db-bulgarian-split-squat`, `db-step-up`, `db-walking-lunge`.
  - Hinges: `db-rdl`, `barbell-rdl`, `kb-deadlift`, `barbell-deadlift`, `barbell-hip-thrust`.
- **Push:** `chest-press-machine`, `db-bench-press`, `bench-press`, `incline-push-up`, `push-up`, `db-shoulder-press`, `triceps-rope-pushdown`.
- **Pull:**
  - Machines and rows: `lat-pulldown`, `seated-cable-row`, `row-machine`, `chest-supported-db-row`, `inverted-row-smith`, `face-pull`, `db-curl`.
  - Hanging (full clearance): `pull-up`, `band-assisted-pull-up`.
- **Core:**
  - Cable: `pallof-press`, `cable-woodchop`.
  - On the floor or hanging (full clearance): `bird-dog`, `plank`, `side-plank`, `hanging-knee-raise`.
- **Carry:** `suitcase-carry`, `farmer-carry`, `sandbag-bear-hug-carry`, `sandbag-shoulder-carry`.
- **Grip:** `dead-hang-feet-supported`, `dead-hang`, `plate-pinch`, `rehab-wall-press`.
- **Conditioning:** `sled-push`, `sled-rope-pull`, `rower`, `ski-erg`, `battle-ropes`, `ruck-loaded`.
- **Power:** `med-ball-slam`, `kb-swing-two-hand`, `kb-swing-one-hand`, `turkish-get-up`, `sandbag-to-shoulder`, `box-jump-low`, `pogo-hops`, `broad-jump`.
- **Hip and hamstring:** `copenhagen-plank-short`, `nordic-curl-assisted`.

**Review regates:** `dead-hang-feet-supported`, `sled-push`, `inverted-row-smith`, `box-pistol` and `db-walking-lunge` are `full_clearance`.

**Part B gating guide:**
- **`full_clearance`:**
  - Wrist weight-bearing and hanging: `push-up`, `incline-push-up`, `plank`, `side-plank`, `bird-dog`, `dead-hang`, `pull-up`, `band-assisted-pull-up`, `hanging-knee-raise`.
  - Impact: `box-jump-low`, `pogo-hops`, `broad-jump`, `med-ball-slam`.
  - Kettlebell ballistics and get-ups: `kb-swing-*`, `turkish-get-up`.
  - Sandbag shouldering and carries: `sandbag-*`.
  - Hip and hamstring: `copenhagen-plank-short`, `nordic-curl-assisted`.
  - Heavy loading: `ruck-loaded`, `battle-ropes`.
- **`grip_cleared`:** the rest, unless you argue otherwise in your report.

### 5.11 The daily mobility routine (program and ch07 must match; reordered in round 3)

`mobility-daily` takes about 10 min. The standing block comes first, then **one** floor descent: via a bench, using your uninjured hand, with your injured arm across your stomach.

| Order | Exercise | Dose |
|---|---|---|
| 1 | `ankle-knee-to-wall` | 10 / side |
| 2 | `hip-circles-standing` | 5 each way / side |
| 3 | `single-leg-balance` | 30 s / side (uninjured hand by a support) |
| 4 | `deep-squat-hold-box` | 60 s |
| 5 | `thoracic-rotation-seated` | 8 / side, on a bench |
| 6 (floor) | `hip-90-90-switch` | 8 switches |
| 7 (floor) | `breathing-90-90` | 5 slow breaths |
| 8 | `hip-flexor-stretch-half-kneeling` | 45 s / side, by a bench (uninjured hand on it). **From `clinic_light`, `couch-stretch` is an optional progression.** |

Strength warm-up `warmup-strength`: `bike-upright` 5 min easy, then `mobility-daily`, then 2 ramp-up sets of the first exercise. For the leg press, the ramp-up is 10 easy box squats, so the plates don't change.

## 6. Guide chapters (Markdown) and owners

| File | Title | Owner |
|---|---|---|
| 00-start-here.md | Start Here | orchestrator |
| 01-assessment-and-goals.md | Your Assessment & Goals | mindset-coach |
| 02-philosophy.md | The Philosophy — What We Take From Coaches and Researchers | mindset-coach |
| 03-training-principles.md | Training Principles | program-designer |
| 04-the-program.md | The Programme — Phases, Weeks & Gates | program-designer |
| 05-strength-technique.md | Strength Technique — Movement Patterns | exercise-library-b |
| 06-core-and-stability.md | Core & Stability | program-designer |
| 07-mobility.md | Mobility & Movement Quality | rehab-coach |
| 08-building-muscle.md | Building Muscle | program-designer |
| 09-farmer-strength.md | Farmer Strength — Carries & Grip | program-designer |
| 10-engine-cardio.md | The Engine — Zone 2, VO2max & Conditioning | hiking-coach |
| 11-hiking-training.md | Training for Long-Distance Hiking | hiking-coach |
| 12-hiking-skills-and-kit.md | Hiking Skills, Kit & Mountain Safety | hiking-coach |
| 13-uk-hiking-roadmap.md | Your UK Hiking Roadmap | hiking-coach |
| 14-nutrition.md | Nutrition — Fuel, Muscle & Bone Healing | nutrition-coach |
| 15-meal-plans.md | Meal Plans, Shopping & Prep | nutrition-coach |
| 16-supplements.md | Supplements — What Works, What Doesn't | nutrition-coach |
| 17-sleep-and-recovery.md | Sleep, Recovery & Readiness | nutrition-coach |
| 18-arm-recovery.md | Your Arm — Fracture Recovery & Return to Loading | rehab-coach |
| 19-injury-prevention.md | Injury Prevention & Pain Rules | rehab-coach |
| 20-habits-and-mindset.md | Habits, Consistency & Mindset | mindset-coach |
| 21-library.md | The Library — Books, Podcasts, Channels, Kit | mindset-coach |
| 22-glossary.md | Glossary | mindset-coach |

### Markdown rules (the hub's renderer supports only these)

- **Headings:** `#` is the chapter title. Use it once, on line 1. Below that, `##`, `###` and `####`.
- **Text:** paragraphs, `**bold**`, `*italic*`, `` `code` ``, and links `[text](https://...)`. Link other chapters as `[text](08-building-muscle.md)`.
- **Lists:** `-` or `1.`, with one level of nesting (two-space indent).
- **Tables:** GFM pipe tables.
- **Horizontal rule:** `---`.
- **Callouts:** blockquotes starting with `> [!NOTE]`, `> [!TIP]`, `> [!WARNING]` or `> [!SAFETY]` on their own line, followed by `> text` lines.
- **Not supported:** raw HTML, images, footnotes, code fences (use them only for literal text such as an example log).

### Writing standard (world-class PT voice)

- Plain, warm and direct. Be specific: numbers, doses, cues. UK English.
- **Chapter structure:**
  1. Title.
  2. An `> [!NOTE]` "In short" callout with 3–5 bullets.
  3. The sections.
  4. A "## Your actions this week" checklist.
  5. A "## Sources" list.
- **Depth:** exhaustive but skimmable. 1,500–4,500 words a chapter as the topic needs. Tables are welcome.
- **Evidence:** tag key claims **[Strong evidence]**, **[Moderate evidence]** or **[Expert opinion]**.
  - Only cite URLs you actually opened. Mark anything else "(not verified)".
  - Don't invent studies, numbers or quotes.
  - Summarise books in your own words, and keep quotes very short.
- **Context:** always connect to the programme goals (section 1) and the gates. Say clearly what's allowed **now** and what comes **later**.
- **Research tips:**
  - WebSearch may be unavailable. Use WebFetch on known authoritative URLs (NHS, NICE, ACSM, StrongFirst, peterattiamd.com, hubermanlab.com, physio and university sites).
  - PubMed pages are cookie-walled. Use Europe PMC: `https://www.ebi.ac.uk/europepmc/webservices/rest/search?query=QUERY&format=json&resultType=core`.
