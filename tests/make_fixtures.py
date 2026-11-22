#!/usr/bin/env python3
"""Regenerate the small, schema-conformant dev fixtures in public/dev-fixtures/.

Open the hub with ?fixtures=1 to use them (content AND sample user data; nothing is saved).
They deliberately include edge cases: a locked exercise inside a session, null example
fields, missing guide chapters, and HTML/script injection attempts in Markdown.

Round 3: the program has `alternates` (a short session and a gym-closed session) and week
overrides with `zone_cap`, `rounds` and `circuit_minutes`; hikes.json has a `weekend_plan`;
the sample data has the round 3 profile fields (`fasting_periods`, `rhr_method_changes`,
`unavailable_exercises`) and the UI-owned `ui` and `goals` keys. `data-v1.json` is a frozen
schema-1 sample in the shape of a real file, used by the migration tests so that no test ever
reads the user's data/ folder.

The sample user is the neutral example profile used throughout the docs (a 30-year-old, 80 kg,
180 cm adult with an arm fracture). The dates are arbitrary; the programme has no default start
date (`default_start_date: null`), like the shipped content.

Round 4: tests.json has the scheduling fields (`baseline_day`, `first_phase` + `first_week`),
weekend_plan mixes `week_start` and `program_week` entries, and the sample data has
`profile.pre_injury_weight_kg`, `planned` on the newer leg-press and hamstring-curl logs (older
ones are recomputed), a hike that stands in for a long walk, and a RED arm-log day (neutral).

Run: python tests/make_fixtures.py
"""
from __future__ import annotations

import datetime as dt
import json
import random
from pathlib import Path

OUT = Path(__file__).resolve().parent.parent / "public" / "dev-fixtures"


def write(rel: str, obj) -> None:
    path = OUT / rel
    path.parent.mkdir(parents=True, exist_ok=True)
    if isinstance(obj, str):
        path.write_text(obj, encoding="utf-8", newline="\n")
    else:
        path.write_text(json.dumps(obj, ensure_ascii=False, indent=1) + "\n", encoding="utf-8", newline="\n")


def ex(id_, name, category, gate, arm_use, fall, equipment, muscles, dose, why="", **extra):
    base = {
        "id": id_, "name": name, "category": category, "gate": gate, "arm_use": arm_use, "fall_risk": fall,
        "equipment": equipment, "muscles": muscles,
        "why": why or f"{name} builds the strength you need for long hikes and carrying.",
        "setup": ["Set the machine or space up with your good hand.", "Get into position without using the injured arm."],
        "cues": ["Brace gently and breathe out on the effort.", "Move slowly: three seconds down.", "Stop two to three reps before failure."],
        "mistakes": ["Rushing the lowering: count three seconds.", "Holding your breath: exhale as you push."],
        "arm_safety": "Keep the injured arm across your stomach. Ask staff for help with anything that needs two hands.",
        "regressions": [], "progressions": [], "dose": dose,
        "video": "https://www.youtube.com/results?search_query=" + name.lower().replace(" ", "+") + "+form",
    }
    base.update(extra)
    return base


PART_A = [
    ex("leg-press", "Leg press", "squat", "none", "none", "low", ["leg press machine"], ["quads", "glutes", "adductors"], "3 × 8–12, RIR 2–3",
       regressions=["box-squat-bw"], progressions=["leg-press-single"]),
    ex("leg-press-single", "Single-leg leg press", "single-leg", "none", "none", "low", ["leg press machine"], ["quads", "glutes"], "3 × 10–12 / side", regressions=["leg-press"]),
    ex("box-squat-bw", "Box squat (bodyweight)", "squat", "none", "none", "low", ["bench"], ["quads", "glutes"], "3 × 5", progressions=["leg-press", "goblet-squat"]),
    ex("split-squat-bw", "Split squat (bodyweight)", "single-leg", "none", "none", "medium", ["rack for balance"], ["quads", "glutes"], "3 × 8–10 / side", regressions=["box-squat-bw"]),
    ex("step-up-bw", "Step-up (bodyweight)", "single-leg", "none", "none", "medium", ["step", "bench"], ["quads", "glutes"], "3 × 8 / side"),
    ex("hamstring-curl", "Hamstring curl", "hinge", "none", "none", "low", ["hamstring curl machine"], ["hamstrings"], "3 × 8–12"),
    ex("leg-extension", "Leg extension", "knee-ankle", "none", "none", "low", ["leg extension machine"], ["quads"], "2 × 12–15"),
    ex("glute-bridge", "Glute bridge", "hip", "none", "none", "low", ["mat"], ["glutes", "hamstrings"], "3 × 12"),
    ex("single-leg-rdl-bw", "Single-leg RDL (bodyweight)", "hinge", "none", "none", "medium", ["rack for balance"], ["hamstrings", "glutes"], "3 × 6 / side"),
    ex("wall-sit", "Wall sit", "squat", "none", "none", "low", ["wall"], ["quads"], "2 × 30–60 s"),
    ex("tibialis-raise-wall", "Tibialis raise (back to wall)", "calves", "none", "none", "low", ["wall"], ["tibialis anterior"], "2 × 15–20"),
    ex("calf-raise-leg-press", "Calf raise on the leg press", "calves", "none", "none", "low", ["leg press machine"], ["calves"], "3 × 12–15"),
    ex("dead-bug-legs", "Dead bug (legs only)", "core", "none", "none", "low", ["mat"], ["deep core"], "3 × 6 / side"),
    ex("single-leg-balance", "Single-leg balance", "balance", "none", "none", "medium", ["rack for support"], ["ankle", "hip"], "3 × 30 s / side"),
    ex("breathing-90-90", "90/90 breathing", "mobility", "none", "none", "low", ["mat", "bench"], ["diaphragm"], "5 slow breaths"),
    ex("ankle-knee-to-wall", "Ankle knee-to-wall", "mobility", "none", "none", "low", ["wall"], ["ankle"], "10 / side"),
    ex("hip-90-90-switch", "90/90 hip switch", "mobility", "none", "none", "low", ["mat"], ["hips"], "8 switches"),
    ex("couch-stretch", "Couch stretch", "mobility", "none", "none", "medium", ["bench", "mat"], ["hip flexors", "quads"], "45 s / side"),
    ex("deep-squat-hold-box", "Deep squat hold (to a box)", "mobility", "none", "none", "low", ["box"], ["hips", "ankles"], "60 s"),
    ex("hip-circles-standing", "Standing hip circles", "mobility", "none", "none", "medium", ["rack for support"], ["hips"], "5 each way / side"),
    ex("thoracic-rotation-seated", "Seated thoracic rotation", "mobility", "none", "none", "low", ["bench"], ["upper back"], "8 / side"),
    ex("stair-climber", "Stair climber", "conditioning", "none", "none", "medium", ["stair climber"], ["legs", "heart"], "20–30 min Zone 2"),
    ex("incline-walk", "Incline treadmill walk", "conditioning", "none", "none", "low", ["treadmill"], ["legs", "heart"], "30–45 min Zone 2"),
    ex("bike-upright", "Upright bike", "conditioning", "none", "none", "low", ["bike"], ["legs", "heart"], "20–40 min"),
    ex("walk-outdoor", "Outdoor walk", "conditioning", "none", "none", "low", [], ["legs", "heart"], "30–90 min"),
    ex("hollow-hold-tuck", "Tucked hollow hold", "core", "none", "none", "low", ["mat"], ["deep core"], "3 × 20–30 s"),
    ex("sled-drag-forward-belt", "Sled drag forwards (belt)", "conditioning", "none", "none", "low", ["sled", "waist belt"], ["legs"], "6 × 20 m"),
    ex("sled-drag-backward-belt", "Sled drag backwards (belt)", "conditioning", "none", "none", "low", ["sled", "waist belt"], ["quads"], "6 × 20 m"),
    ex("ga-cable-row", "Good-arm cable row", "pull", "good_arm_ok", "good-arm", "low", ["cable machine"], ["lats", "upper back"], "3 × 10–12"),
    ex("ga-chest-press-machine", "Good-arm chest press", "push", "good_arm_ok", "good-arm", "low", ["chest press machine"], ["chest", "triceps"], "3 × 10–12"),
    ex("rehab-finger-tendon-glides", "Finger tendon glides", "rehab", "clinic_light", "injured-light", "low", [], ["forearm"], "As prescribed by your physio"),
    ex("rehab-putty-grip", "Putty grip", "rehab", "clinic_light", "injured-light", "low", ["putty"], ["forearm"], "As prescribed by your physio"),
    ex("x-physio-programme", "Your physio's programme", "rehab", "clinic_light", "injured-light", "low", [], ["forearm", "wrist", "hand"], "As prescribed by your physio",
       why="A placeholder for the exercises your physio gives you, done exactly as prescribed."),
]

PART_B = [
    ex("goblet-squat", "Goblet squat", "squat", "grip_cleared", "both", "low", ["dumbbell"], ["quads", "glutes"], "3 × 8–10", regressions=["box-squat-bw"]),
    ex("farmer-carry", "Farmer carry", "carry", "grip_cleared", "both", "medium", ["dumbbells"], ["grip", "traps", "core"], "4 × 30 m",
       regressions=["glute-bridge"], arm_safety=""),
    ex("db-rdl", "Dumbbell Romanian deadlift", "hinge", "grip_cleared", "both", "low", ["dumbbells"], ["hamstrings", "glutes"], "3 × 8–10", arm_safety=""),
    ex("lat-pulldown", "Lat pulldown", "pull", "grip_cleared", "both", "low", ["lat pulldown machine"], ["lats"], "3 × 8–12", arm_safety=""),
    ex("push-up", "Push-up", "push", "full_clearance", "both", "low", ["mat"], ["chest", "triceps"], "3 × AMRAP", arm_safety=""),
    ex("plank", "Plank", "core", "full_clearance", "both", "low", ["mat"], ["core"], "3 × 30 s", arm_safety=""),
]

MOBILITY = [
    {"exercise": "ankle-knee-to-wall", "dose": "10 / side"}, {"exercise": "hip-90-90-switch", "dose": "8 switches"},
    {"exercise": "couch-stretch", "dose": "45 s / side (by a bench, good-hand support only)"}, {"exercise": "deep-squat-hold-box", "dose": "60 s"},
    {"exercise": "hip-circles-standing", "dose": "5 each way / side"}, {"exercise": "thoracic-rotation-seated", "dose": "8 / side"},
    {"exercise": "breathing-90-90", "dose": "5 slow breaths"}, {"exercise": "single-leg-balance", "dose": "30 s / side"},
]

PROGRAM = {
    "version": 1,
    "default_start_date": None,
    "gates": [
        {"id": "none", "label": "Available now", "description": "Nothing goes through the injured arm."},
        {"id": "good_arm_ok", "label": "Good arm OK", "description": "Clinic or physio OK'd training the uninjured arm."},
        {"id": "clinic_light", "label": "Light use", "description": "Light use of the injured arm; physio rehab started."},
        {"id": "grip_cleared", "label": "Grip cleared", "description": "Light to moderate gripping and holding. No weight-bearing on the wrist yet."},
        {"id": "full_clearance", "label": "Full clearance", "description": "Heavy loading, carrying, hanging, push-ups, impact."},
    ],
    "phases": [
        {
            "id": "p1", "name": "Phase 1 — Foundation", "short": "Foundation", "entry_gate": "none", "weeks": 6, "min_weeks": 5, "repeat_from_week": 3,
            "goal": "Find your working loads again, rebuild the leg and engine base for hiking, and train daily, all without the injured arm.",
            "focus": ["Leg strength on machines", "Zone 2 base", "Arm-free core"],
            "exit_criteria": ["Six weeks done", "Leg press up by 20 kg", "60-minute Zone 2 walk feels easy"],
            "week_template": {"mon": "str-a", "tue": "engine", "wed": "str-b", "thu": "intervals", "fri": "circuit-day", "sat": "long-walk", "sun": "rest"},
            "week_overrides": [
                {"week": 1, "label": "Intro", "sets_max": 2, "rir": "3-4", "cardio_scale": 0.7, "notes": "Two sets of everything, easy effort."},
                {"week": 2, "label": "Primer", "zone_cap": "Z3", "rounds": 4, "notes": "Intervals are a Zone 3 primer: 4 rounds, nothing harder."},
                {"week": 4, "label": "Deload", "deload": True, "circuit_minutes": 5, "notes": "Half the sets, same exercises; the circuit is 5 easy minutes."},
            ],
            "weekly_targets": {"zone2_min": 120, "strength_sessions": 2, "steps_avg": 7000, "long_session_min": 60},
        },
        {
            "id": "p2", "name": "Phase 2 — Good-arm build", "short": "Good-arm build", "entry_gate": "good_arm_ok", "weeks": 6, "repeat_from_week": None,
            "goal": "Add good-arm upper-body work while the legs keep progressing.", "focus": ["Good-arm push and pull"], "exit_criteria": ["Grip cleared by physio"],
            "week_template": {"mon": "str-a", "tue": "engine", "wed": "str-b", "thu": "engine", "fri": "str-a", "sat": "long-walk", "sun": "rest"},
            "week_overrides": [{"week": 3, "label": "Deload", "deload": True}],
            "weekly_targets": {"zone2_min": 150, "strength_sessions": 3, "steps_avg": 8000, "long_session_min": 75},
        },
        {
            "id": "p3", "name": "Phase 3 — Grip and carry", "short": "Grip and carry", "entry_gate": "grip_cleared", "weeks": 8, "repeat_from_week": 4,
            "goal": "Both hands back on the weights: carries, dumbbells and pulls.", "focus": ["Farmer carries", "Dumbbell hinges"], "exit_criteria": ["Full clearance"],
            "week_template": {"mon": "str-c", "tue": "engine", "wed": "str-b", "thu": "intervals", "fri": "str-c", "sat": "long-walk", "sun": "rest"},
            "week_overrides": [],
            "weekly_targets": {"zone2_min": 160, "strength_sessions": 3, "steps_avg": 9000, "long_session_min": 90},
        },
    ],
    "addons": [
        {"id": "crossed", "name": "Good-arm work", "gate": "good_arm_ok", "until_gate": "grip_cleared", "days": ["mon", "wed", "fri"], "session": "crossed"},
        {"id": "rehab", "name": "Physio rehab", "gate": "clinic_light", "until_gate": "full_clearance", "days": ["mon", "tue", "wed", "thu", "fri", "sat", "sun"], "session": "rehab"},
        {"id": "p2-core", "name": "Extra core (Phase 2 only)", "gate": "none", "until_gate": None, "days": ["tue", "thu"], "phases": ["p2"], "session": "crossed"},
    ],
    "sessions": {
        "str-a": {"name": "Strength A — Squat & Knee", "type": "strength", "duration_min": 65, "summary": "Leg press for muscle, box squats for skill, knee armour for descents.",
                  "warmup": "warmup-strength", "cooldown": "mobility-daily", "blocks": [
                      {"exercise": "leg-press", "sets": 3, "reps": "8-12", "rest_s": 120, "tempo": "3-1-1-0", "rir": "2-3", "load": "double-progression", "notes": "Injured arm across your stomach; stand up with your uninjured hand on the side handle."},
                      {"exercise": "box-squat-bw", "sets": 3, "reps": "5", "rest_s": 90, "rir": "3-4", "load": "bodyweight"},
                      {"exercise": "split-squat-bw", "sets": 3, "reps": "8-10", "rest_s": 75, "rir": "2-3", "load": "bodyweight", "per_side": True},
                      {"exercise": "wall-sit", "sets": 2, "seconds": 45, "rest_s": 60},
                      {"exercise": "tibialis-raise-wall", "sets": 2, "reps": "15-20", "rest_s": 45, "load": "bodyweight"},
                      {"exercise": "dead-bug-legs", "sets": 3, "reps": "6", "rest_s": 45, "load": "bodyweight", "per_side": True}]},
        "str-b": {"name": "Strength B — Hinge & Hips", "type": "strength", "duration_min": 65, "summary": "Hamstrings, glutes and balance for uneven ground.",
                  "warmup": "warmup-strength", "blocks": [
                      {"exercise": "hamstring-curl", "sets": 3, "reps": "8-12", "rest_s": 90, "rir": "2-3", "load": "double-progression"},
                      {"exercise": "glute-bridge", "sets": 3, "reps": "12", "rest_s": 60, "load": "bodyweight"},
                      {"exercise": "single-leg-rdl-bw", "sets": 3, "reps": "6", "rest_s": 60, "load": "bodyweight", "per_side": True},
                      {"exercise": "single-leg-balance", "sets": 3, "seconds": 30, "rest_s": 30, "per_side": True},
                      {"exercise": "farmer-carry", "sets": 4, "reps": "30 m", "rest_s": 90, "notes": "Locked fixture case: needs grip clearance."}]},
        "str-c": {"name": "Strength C — Carry & Grip", "type": "strength", "duration_min": 70, "summary": "Carries and dumbbells once grip is cleared.", "warmup": "warmup-strength", "blocks": [
            {"exercise": "goblet-squat", "sets": 3, "reps": "8-10", "rest_s": 90, "rir": "2-3", "load": "double-progression"},
            {"exercise": "farmer-carry", "sets": 4, "reps": "30 m", "rest_s": 90}]},
        "engine": {"name": "Hiking Engine — Zone 2", "type": "cardio", "duration_min": 60, "summary": "Stair climber then incline walking, all Zone 2.", "cooldown": "mobility-daily", "blocks": [
            {"exercise": "stair-climber", "minutes": 10, "zone": "Z2", "minutes_by_week": [10, 13, 16, 18, 20, 22]},
            {"exercise": "incline-walk", "minutes": 30, "zone": "Z2"}]},
        "intervals": {"name": "Engine — Bike Intervals", "type": "intervals", "duration_min": 50, "summary": "Short hard efforts, then Zone 2 walking.", "blocks": [
            {"exercise": "bike-upright", "warmup_min": 8, "cooldown_min": 5, "intervals": {"work_s": 30, "rest_s": 90, "rounds": 6, "work_zone": "Z4-Z5", "rest_zone": "Z1"}},
            {"exercise": "incline-walk", "minutes": 20, "zone": "Z2"}]},
        "circuit-day": {"name": "Strength C — Single-Leg & Sled", "type": "strength", "duration_min": 60, "summary": "Single-leg work and sled drags.", "warmup": "warmup-strength", "blocks": [
            {"exercise": "leg-press-single", "sets": 3, "reps": "10-12", "rest_s": 90, "rir": "3", "load": "double-progression", "per_side": True},
            {"exercise": "step-up-bw", "sets": 3, "reps": "8", "rest_s": 75, "load": "bodyweight", "per_side": True},
            {"circuit": {"minutes": 12, "rounds": None, "items": [{"exercise": "sled-drag-forward-belt", "dose": "20 m"}, {"exercise": "sled-drag-backward-belt", "dose": "20 m"}]}, "zone": "Z2-Z3", "notes": "Needs a waist belt: never hold the strap."}]},
        "long-walk": {"name": "Long Walk — Zone 2", "type": "hike", "duration_min": 90, "summary": "Time on your feet on good paths.", "cooldown": "mobility-daily", "blocks": [
            {"exercise": "walk-outdoor", "minutes": 45, "zone": "Z2", "minutes_by_week": [45, 50, 55, 60, 60, 60]}]},
        "rest": {"name": "Rest Day — Easy Walk & Mobility", "type": "rest", "duration_min": 40, "summary": "Optional easy stroll and the mobility routine.", "cooldown": "mobility-daily", "blocks": [
            {"exercise": "walk-outdoor", "minutes": 30, "zone": "Z1"}]},
        "rehab": {"name": "Arm Rehab — Your Physio's Programme", "type": "rehab", "duration_min": 15, "summary": "Your physio's exercises, exactly as prescribed.", "blocks": [
            {"exercise": "x-physio-programme", "sets": 1, "seconds": 900, "load": "physio", "notes": "Little and often through the day is fine."}]},
        "crossed": {"name": "Good-arm work", "type": "strength", "duration_min": 20, "summary": "Cross-education: training the good arm helps the injured one.", "blocks": [
            {"exercise": "ga-cable-row", "sets": 3, "reps": "10-12", "rest_s": 60, "load": "double-progression"},
            {"exercise": "ga-chest-press-machine", "sets": 3, "reps": "10-12", "rest_s": 60, "load": "double-progression"}]},
        "short-session": {"name": "Short on time — 25-minute minimum", "type": "strength", "duration_min": 25, "summary": "The minimum that keeps the habit: never miss twice.", "blocks": [
            {"exercise": "leg-press", "sets": 2, "reps": "8-12", "rest_s": 90, "rir": "3", "load": "double-progression"},
            {"exercise": "box-squat-bw", "sets": 2, "reps": "5", "rest_s": 60, "load": "bodyweight"},
            {"exercise": "dead-bug-legs", "sets": 2, "reps": "6", "rest_s": 45, "load": "bodyweight", "per_side": True}]},
        "travel-session": {"name": "Gym closed — bodyweight circuit", "type": "circuit", "duration_min": 30, "summary": "Bodyweight only, anywhere: a chair and a wall.", "blocks": [
            {"circuit": {"minutes": 20, "rounds": None, "items": [{"exercise": "box-squat-bw", "dose": "8"}, {"exercise": "glute-bridge", "dose": "12"}, {"exercise": "wall-sit", "dose": "30 s"}, {"exercise": "hollow-hold-tuck", "dose": "20 s"}]}, "zone": "Z2-Z3", "notes": "Steady pace; rest when you need to."}]},
    },
    "alternates": {"short": "short-session", "travel": "travel-session"},
    "routines": {
        "mobility-daily": {"name": "Daily mobility", "minutes": 10, "items": MOBILITY},
        "warmup-strength": {"name": "Strength warm-up", "minutes": 17, "items": [{"exercise": "bike-upright", "dose": "5 min easy"}] + MOBILITY,
                            "notes": "Then 2 ramp-up sets of the first exercise."},
    },
    "rules": {
        "progression": "Double progression: when every set hits the top of the rep range, add load and drop to the bottom.",
        "deload": "Every fourth to sixth week, halve the sets.",
        "readiness": "Amber: halve the sets, Zone 2 only, no intervals. Red: stop and call the clinic.",
        "missed_sessions": "Don't make up missed sessions. Carry on with the plan.",
        "increments_kg": {"leg-press": 10, "machine": 2.5, "cable": 2.5, "dumbbell": 2, "barbell": 2.5, "default": 2.5},
    },
}

TESTS = [
    {"id": "sit-to-stand-30s", "name": "30-second sit-to-stand", "category": "strength", "unit": "reps", "higher_is_better": True, "gate": "none", "every_weeks": 4, "baseline_day": 1,
     "how": ["Sit on a bench, arms folded", "Stand fully and sit, 30 s"], "equipment": "Bench", "norms": "Over 17 is good for adults under 60.", "safety": "Arms folded; no pushing off."},
    {"id": "wall-sit", "name": "Wall sit", "category": "endurance", "unit": "s", "higher_is_better": True, "gate": "none", "every_weeks": 4, "baseline_day": 1, "how": ["Back on the wall, knees at 90°"], "equipment": "Wall", "norms": "", "safety": "Stop if knees hurt."},
    {"id": "balance-eyes-open", "name": "Single-leg balance, eyes open", "category": "balance", "unit": "s", "higher_is_better": True, "gate": "none", "every_weeks": 4, "baseline_day": 2, "how": ["Next to a rack"], "equipment": "Rack", "norms": "", "safety": "Good hand near support."},
    {"id": "hollow-hold", "name": "Tucked hollow hold", "category": "strength", "unit": "s", "higher_is_better": True, "gate": "none", "every_weeks": 4, "baseline_day": 3, "how": ["On a mat, knees tucked, lower back pressed down"], "equipment": "Mat", "norms": "", "safety": "Get down and up via a bench, uninjured hand only."},
    {"id": "dead-hang", "name": "Dead hang", "category": "grip", "unit": "s", "higher_is_better": True, "gate": "full_clearance", "every_weeks": 4, "first_phase": "p3", "first_week": 2, "how": ["Hang from a bar"], "equipment": "Bar", "norms": "", "safety": "Full clearance only."},
]

HIKES = {
    "ladder": [
        {"level": 1, "name": "Park loop", "description": "Flat, firm paths. Learn your pace.", "gate": "none", "criteria": {"distance_km": 5, "ascent_m": 0, "pack_kg": 0, "terrain": "tarmac and gravel"},
         "examples": [{"name": "Riverside park loop", "region": "Any town", "distance_km": 5, "ascent_m": None, "terrain": "tarmac"}, {"name": "Local park circuit", "region": "Anywhere", "distance_km": 5, "ascent_m": None, "terrain": "tarmac"}]},
        {"level": 2, "name": "Canal towpath", "description": "Longer and flat.", "gate": "none", "criteria": {"distance_km": 10, "ascent_m": 100, "pack_kg": 0, "terrain": "good paths"},
         "examples": [{"name": "Canal towpath", "region": "Midlands", "distance_km": 12, "ascent_m": 40, "terrain": "towpath", "url": "https://canalrivertrust.org.uk/"}]},
        {"level": 3, "name": "Rolling downs", "description": "Gentle hills, firm tracks.", "gate": "clinic_light", "criteria": {"distance_km": 14, "ascent_m": 300, "pack_kg": 4, "terrain": "chalk tracks"},
         "examples": [{"name": "South Downs Way section", "region": "Sussex", "distance_km": 14, "ascent_m": 320, "terrain": "chalk", "url": None}]},
        {"level": 4, "name": "First fell", "description": "Rough ground and real climbs.", "gate": "full_clearance", "criteria": {"distance_km": 16, "ascent_m": 800, "pack_kg": 7, "terrain": "rocky paths"}, "examples": []},
    ],
    "kit": [
        {"item": "Walking boots or trail shoes", "category": "footwear", "essential": True, "notes": "Broken in before long walks."},
        {"item": "Wool socks", "category": "footwear", "essential": True, "notes": ""},
        {"item": "Waterproof jacket", "category": "clothing", "essential": True, "notes": "Taped seams."},
        {"item": "Warm layer", "category": "clothing", "essential": True, "notes": ""},
        {"item": "20–30 L daypack", "category": "pack", "essential": True, "notes": "Hip belt takes the load."},
        {"item": "OS Maps app", "category": "navigation", "essential": True, "notes": "Download maps offline."},
        {"item": "Paper map and compass", "category": "navigation", "essential": False, "notes": ""},
        {"item": "First-aid kit", "category": "safety", "essential": True, "notes": ""},
        {"item": "Head torch", "category": "safety", "essential": True, "notes": ""},
        {"item": "Water bottles", "category": "food-water", "essential": True, "notes": "1 L per 2 hours."},
        {"item": "Walking poles", "category": "other", "essential": False, "notes": "Good hand only until cleared."},
    ],
    "weekend_plan": [
        {"week_start": "2025-11-17", "name": "Local park outer loop", "minutes": 45, "level": 1, "notes": "Daylight, flat, tarmac. Waist pack only.", "url": None},
        {"week_start": "2025-11-24", "name": "Canal towpath, out and back from the nearest lock", "minutes": 50, "level": 2, "notes": "Firm towpath; keep to the inside away from the edge.", "url": "https://canalrivertrust.org.uk/"},
        {"week_start": "2025-12-01", "name": "Country park gravel trail (part)", "minutes": 60, "level": 2, "notes": "Gravel trail. Daylight only.", "url": None},
        {"program_week": 7, "name": "Riverside towpath, station to station", "minutes": 70, "level": 2, "notes": "Programme week 7. Flat towpath; a train or bus back.", "url": "https://canalrivertrust.org.uk/"},
        {"program_week": 8, "week_start": "2026-03-02", "name": "Forest tracks from the station", "minutes": 80, "level": 2, "notes": "Programme week 8 (program_week wins over week_start). Stay on the wide tracks.", "url": None},
    ],
    "terrain_skills": [
        {"terrain": "good paths", "technique": ["Short steps uphill", "Soft knees downhill"], "gate": "none"},
        {"terrain": "wet grass", "technique": ["Shorter strides", "Avoid until cleared if slippery"], "gate": "clinic_light"},
        {"terrain": "scree", "technique": ["Face the slope", "Test each step"], "gate": "full_clearance"},
    ],
}

NUTRITION = {
    "foods": [
        {"name": "Greek yoghurt (0% fat)", "category": "dairy", "serving": "170 g pot", "kcal": 100, "protein_g": 17, "calcium_mg": 190, "notes": ""},
        {"name": "Semi-skimmed milk", "category": "dairy", "serving": "250 ml", "kcal": 118, "protein_g": 9, "calcium_mg": 300, "notes": ""},
        {"name": "Cheddar", "category": "dairy", "serving": "30 g", "kcal": 125, "protein_g": 7.6, "calcium_mg": 220, "notes": ""},
        {"name": "Eggs", "category": "protein", "serving": "2 large", "kcal": 156, "protein_g": 13, "calcium_mg": 56, "notes": ""},
        {"name": "Chicken breast", "category": "protein", "serving": "150 g cooked", "kcal": 240, "protein_g": 46, "calcium_mg": 15, "notes": ""},
        {"name": "Tinned salmon with bones", "category": "fish", "serving": "100 g", "kcal": 150, "protein_g": 21, "calcium_mg": 240, "notes": "Soft bones = calcium."},
        {"name": "Tinned sardines", "category": "fish", "serving": "90 g", "kcal": 170, "protein_g": 20, "calcium_mg": 350, "notes": ""},
        {"name": "Red lentils (cooked)", "category": "plant", "serving": "150 g", "kcal": 175, "protein_g": 13, "calcium_mg": 25, "notes": ""},
        {"name": "Tofu (calcium-set)", "category": "plant", "serving": "100 g", "kcal": 120, "protein_g": 13, "calcium_mg": 350, "notes": ""},
        {"name": "Porridge oats", "category": "carbs", "serving": "50 g", "kcal": 187, "protein_g": 5.5, "calcium_mg": 26, "notes": ""},
        {"name": "Banana", "category": "fruit", "serving": "1 medium", "kcal": 105, "protein_g": 1.3, "calcium_mg": 6, "notes": ""},
        {"name": "Whey protein", "category": "supplement", "serving": "30 g scoop", "kcal": 120, "protein_g": 24, "calcium_mg": 130, "notes": ""},
    ],
    "meal_templates": [
        {"id": "day-2400", "name": "Training day, 2,400 kcal", "kcal": 2400, "protein_g": 140, "notes": "Smaller frame or lighter week.", "meals": [
            {"time": "06:15 pre-gym", "name": "Banana and milk", "items": ["1 banana", "250 ml milk"], "kcal": 223, "protein_g": 10}]},
        {"id": "day-2800", "name": "Training day, 2,800 kcal", "kcal": 2800, "protein_g": 155, "notes": "The usual day.", "meals": [
            {"time": "06:15 pre-gym", "name": "Yoghurt pot", "items": ["Greek yoghurt", "honey"], "kcal": 150, "protein_g": 17},
            {"time": "08:30 breakfast", "name": "Porridge with milk and whey", "items": ["50 g oats", "250 ml milk", "1 scoop whey"], "kcal": 425, "protein_g": 39}]},
        {"id": "day-3200", "name": "Big day, 3,200 kcal", "kcal": 3200, "protein_g": 170, "notes": "Long hike days.", "meals": []},
    ],
    "supplements": [
        {"name": "Creatine monohydrate", "dose": "3–5 g/day", "timing": "Any time", "evidence": "strong", "why": "More strength and muscle with training.", "cautions": "Drink enough water."},
        {"name": "Vitamin D", "dose": "10 µg/day", "timing": "October to March", "evidence": "strong", "why": "UK advice for everyone in winter; bone health.", "cautions": ""},
        {"name": "Whey protein", "dose": "As needed", "timing": "Any meal", "evidence": "moderate", "why": "Convenient protein.", "cautions": ""},
        {"name": "Collagen with vitamin C", "dose": "15 g", "timing": "Before rehab", "evidence": "weak", "why": "Early research on connective tissue.", "cautions": ""},
        {"name": "Fat burners", "dose": "—", "timing": "—", "evidence": "avoid", "why": "No dieting while bone heals.", "cautions": "Stimulants."},
    ],
    "shopping_list": [
        {"category": "Dairy", "items": ["Greek yoghurt", "Milk", "Cheddar"]},
        {"category": "Protein", "items": ["Eggs", "Chicken", "Tinned salmon"]},
        {"category": "Store cupboard", "items": ["Oats", "Lentils", "Rice"]},
    ],
}

RED_FLAGS = [
    ("pain_increasing", "Pain getting worse, not better", "Contact the fracture clinic today."),
    ("swelling_new", "New or increasing swelling", "Raise the arm and contact the clinic."),
    ("redness_heat", "Redness or heat around the wound", "Possible infection: NHS 111 today."),
    ("wound_discharge", "Wound leaking or smelling", "NHS 111 or the clinic today."),
    ("fever_unwell", "Fever or feeling unwell", "Call NHS 111."),
    ("numbness_tingling", "New numbness or tingling", "Contact the clinic today."),
    ("colour_cold", "Hand pale, blue or cold", "Urgent: 999 or A&E."),
    ("deformity_give", "New bend or giving way", "Stop and get it checked."),
    ("fall_on_arm", "Fell on the arm", "Contact the clinic or NHS 111."),
]

ARM = {
    "red_flags": [{"id": i, "label": l, "action": a} for i, l, a in RED_FLAGS],
    "clinic_questions": [
        {"topic": "Healing", "question": "Is the bone united on the X-ray?", "why": "Decides when loading can start."},
        {"topic": "Healing", "question": "Are there plates, screws or a fixator, and do they change anything?", "why": "Hardware can change the plan."},
        {"topic": "Training", "question": "Can I train my good arm normally now?", "why": "Unlocks the good-arm gate."},
        {"topic": "Training", "question": "When can I grip, carry and push through the hand?", "why": "Unlocks grip and full clearance."},
        {"topic": "Physio", "question": "Can you refer me to physio, and how soon?", "why": "Rehab drives the timeline."},
    ],
    "healing_stages": [
        {"stage": "Inflammation", "typical_timing": "Days 1–7", "what_happens": "A clot forms and the body cleans up.", "training_implications": "Protect the arm; walk."},
        {"stage": "Soft callus", "typical_timing": "Weeks 2–6", "what_happens": "Cartilage bridges the gap.", "training_implications": "Lower body only."},
        {"stage": "Hard callus", "typical_timing": "Weeks 6–12+", "what_happens": "Woven bone forms.", "training_implications": "Physio-led light use."},
        {"stage": "Remodelling", "typical_timing": "Months to years", "what_happens": "Bone reshapes to the loads it sees.", "training_implications": "Graded return to heavy loads."},
    ],
    "measurements": [
        {"id": "pain_rest", "name": "Pain at rest", "unit": "/10", "how": "0 is none, 10 is the worst imaginable.", "reference": ""},
        {"id": "pain_activity", "name": "Pain with activity", "unit": "/10", "how": "During daily tasks.", "reference": ""},
        {"id": "pain_night", "name": "Pain at night", "unit": "/10", "how": "Worst pain last night.", "reference": ""},
        {"id": "grip_injured_kg", "name": "Grip, injured hand", "unit": "kg", "how": "Only once your physio says so.", "reference": ""},
        {"id": "grip_good_kg", "name": "Grip, good hand", "unit": "kg", "how": "Dynamometer, best of three.", "reference": ""},
        {"id": "wrist_flex_deg", "name": "Wrist flexion", "unit": "°", "how": "As measured by your physio.", "reference": "Typical 60–80°"},
        {"id": "wrist_ext_deg", "name": "Wrist extension", "unit": "°", "how": "As measured by your physio.", "reference": "Typical 60–70°"},
        {"id": "pronation_deg", "name": "Pronation", "unit": "°", "how": "Palm down.", "reference": "Typical 80–90°"},
        {"id": "supination_deg", "name": "Supination", "unit": "°", "how": "Palm up.", "reference": "Typical 80–90°"},
        {"id": "swelling_score", "name": "Swelling", "unit": "0–3", "how": "0 none, 3 severe.", "reference": ""},
    ],
    "appointments_default": [{"date": None, "type": "Fracture clinic", "notes": ""}],
}

GUIDE_INDEX = {
    "title": "The Functional Fitness Guide (fixture)",
    "parts": [
        {"title": "Part 1 — Foundations", "chapters": [{"file": "00-start-here.md", "title": "Start Here"}, {"file": "01-assessment-and-goals.md", "title": "Your Assessment & Goals"}]},
        {"title": "Part 2 — Training", "chapters": [{"file": "03-training-principles.md", "title": "Training Principles"}, {"file": "04-the-program.md", "title": "The Program"}]},
    ],
}

START_HERE = """# Start Here <script>alert('fixture XSS in a heading')</script>

> [!NOTE] In short
> - This guide explains *why* each part of your program exists.
> - The **gates** decide what you can do with your arm.
> - Check in every morning: readiness drives the day.

Welcome. This fixture chapter exercises every Markdown feature the hub supports. Raw HTML like <img src=x onerror=alert(1)> and <b>bold tags</b> must show as text.

## How to use this guide

Read [Training Principles](03-training-principles.md) next, then [the program](04-the-program.md#how-phases-work). External sources open in a new tab, like the [NHS fracture advice](https://www.nhs.uk/conditions/broken-arm-or-wrist/). A bad link [should not be clickable](javascript:alert(1)) and neither should [this one](data:text/html,hi).

Some `inline code`, some **bold with *italic* inside**, and a claim **[Strong evidence]** next to one that is **[Expert opinion]**.

### A table

| Gate | What it unlocks | Typical timing |
|---|:---:|--:|
| None | Leg machines, walking | Now |
| Grip cleared | Dumbbells, carries | Physio decides |
| Full clearance | Push-ups, hanging | Clinic decides |

### Lists

1. Check in.
2. Train.
   - Warm up first.
   - Log as you go.
3. Recover.

- Plain bullet
  - Nested bullet

> [!SAFETY]
> If anything on the red-flag list happens, stop and call the fracture clinic or NHS 111.

> [!TIP]
> Put your phone on the bench and log sets as you go.

> [!WARNING]
> Ice and wet leaves are a fall risk. Use the treadmill.

---

```
Example log:
Leg press 3 × 10 @ 60 kg <not html>
```

## Your actions this week

- [ ] Do your first check-in.
- [x] Read this chapter.
- [ ] Book the physio referral question into your clinic list.

## Sources

- NHS: Broken arm or wrist (https://www.nhs.uk/conditions/broken-arm-or-wrist/)
"""

PRINCIPLES = """# Training Principles

> [!NOTE] In short
> - Progressive overload, done patiently.
> - Leave reps in reserve.

## Double progression

Work in a rep range. When every set reaches the top, add a little load. **[Moderate evidence]**

## Zone 2

You can speak in full sentences but would rather not.

## Your actions this week

- [ ] Find your Zone 2 heart rate in Settings.
"""


def daterange(start: dt.date, end: dt.date):
    d = start
    while d <= end:
        yield d
        d += dt.timedelta(days=1)


def make_data() -> dict:
    rnd = random.Random(42)
    start = dt.date(2026, 10, 26)
    today = dt.date(2026, 11, 21)
    checkins = []
    weight = 79.0
    for i, d in enumerate(daterange(start, today)):
        if d.day in (2, 9) and d != today:
            continue  # gaps
        weight += 0.036 + rnd.uniform(-0.25, 0.25) * 0.4
        ck = {
            "date": d.isoformat(), "weight_kg": round(weight + rnd.uniform(-0.3, 0.3), 1), "rhr": rnd.choice([56, 57, 58, 58, 59, 60]),
            "hrv": rnd.randint(52, 70), "sleep_h": round(rnd.uniform(6.4, 8.3), 1), "sleep_q": rnd.randint(3, 5), "energy": rnd.randint(3, 5),
            "soreness": rnd.randint(1, 5), "mood": rnd.randint(3, 5), "stress": rnd.randint(1, 3), "arm_pain": rnd.choice([1, 1, 2, 2, 3]),
            "arm_flags": [], "steps": rnd.randint(6200, 9800), "protein_g": rnd.randint(110, 150), "calories": rnd.randint(2450, 3050),
            "water_l": round(rnd.uniform(1.8, 2.8), 1), "creatine": rnd.random() > 0.15, "notes": "",
        }
        checkins.append(ck)
    checkins[-1].update({"sleep_h": 5.6, "energy": 3, "notes": "Late night, woke early."})  # today: amber
    plan = {0: "str-a", 1: "engine", 2: "str-b", 3: "intervals", 4: "circuit-day", 5: "long-walk", 6: "rest"}
    workouts = []
    lp = 60.0
    for d in daterange(start, today - dt.timedelta(days=1)):
        sid = plan[d.weekday()]
        if sid == "rest" or d in (dt.date(2026, 11, 5), dt.date(2026, 11, 12), dt.date(2026, 11, 4), dt.date(2026, 11, 14)):
            continue
        wk = (d - start).days // 7 + 1
        w = {"id": f"fx-{d.isoformat()}-{sid}", "date": d.isoformat(), "session_id": sid, "session_name": PROGRAM["sessions"][sid]["name"],
             "session_type": PROGRAM["sessions"][sid]["type"], "phase_id": "p1", "phase_week": wk, "duration_min": PROGRAM["sessions"][sid]["duration_min"] - rnd.randint(0, 8),
             "rpe": rnd.randint(5, 8), "notes": "", "exercises": [], "cardio": [], "status": "done"}
        sets_n = 2 if wk == 1 or wk == 4 else 3
        if sid == "str-a":
            reps_top = 12 if d.weekday() == 0 and wk % 2 == 0 else 11
            w["exercises"].append({"block": "b0", "exercise": "leg-press", "sets": [{"kg": lp, "reps": reps_top if k == 0 else reps_top - k % 2, "seconds": None, "rir": 2, "done": True} for k in range(sets_n)], "notes": ""})
            if wk >= 3:  # round 4 logs store the effective prescription (deload week 4: 2 sets, hold RIR)
                w["exercises"][-1]["planned"] = {"sets": sets_n, "reps": "8-12", "rir": "3-4" if wk == 4 else "2-3", "load": "double-progression"}
            w["exercises"].append({"block": "b1", "exercise": "box-squat-bw", "sets": [{"kg": None, "reps": 5, "seconds": None, "rir": 3, "done": True} for _ in range(sets_n)], "notes": ""})
            w["exercises"].append({"block": "b3", "exercise": "wall-sit", "sets": [{"kg": None, "reps": None, "seconds": 35 + wk * 4, "rir": None, "done": True} for _ in range(2)], "notes": ""})
            lp += 2.5 if wk != 4 else 0
        elif sid == "str-b":
            w["exercises"].append({"block": "b0", "exercise": "hamstring-curl", "sets": [{"kg": 25 + wk * 2.5, "reps": 10, "seconds": None, "rir": 2, "done": True} for _ in range(sets_n)], "notes": ""})
            if wk >= 3:
                w["exercises"][-1]["planned"] = {"sets": sets_n, "reps": "8-12", "rir": "3-4" if wk == 4 else "2-3", "load": "double-progression"}
            w["exercises"].append({"block": "b1", "exercise": "glute-bridge", "sets": [{"kg": None, "reps": 12, "seconds": None, "rir": 3, "done": True} for _ in range(sets_n)], "notes": ""})
        elif sid == "circuit-day":
            w["exercises"].append({"block": "b0", "exercise": "leg-press-single", "sets": [{"kg": 25 + wk * 2.5, "reps": 11, "seconds": None, "rir": 3, "done": True} for _ in range(sets_n)], "notes": ""})
            w["cardio"].append({"block": "b2", "exercise": "circuit", "items": ["sled-drag-forward-belt", "sled-drag-backward-belt"], "minutes": 12, "rounds": 6, "zone": "Z2-Z3", "avg_hr": 128, "distance_km": None, "ascent_m": None, "level": None, "notes": ""})
        elif sid == "engine":
            w["cardio"].append({"block": "b0", "exercise": "stair-climber", "minutes": [10, 13, 16, 18][min(wk, 4) - 1], "zone": "Z2", "avg_hr": rnd.randint(118, 128), "distance_km": None, "ascent_m": None, "level": 5, "notes": ""})
            w["cardio"].append({"block": "b1", "exercise": "incline-walk", "minutes": 30, "zone": "Z2", "avg_hr": rnd.randint(115, 125), "distance_km": 2.6, "ascent_m": None, "level": 10, "notes": ""})
        elif sid == "intervals":
            w["cardio"].append({"block": "b0", "exercise": "bike-upright", "minutes": 25, "rounds": 6, "zone": "Z4-Z5", "avg_hr": 138, "distance_km": None, "ascent_m": None, "level": 8, "notes": ""})
            w["cardio"].append({"block": "b1", "exercise": "incline-walk", "minutes": 20, "zone": "Z2", "avg_hr": 120, "distance_km": 1.7, "ascent_m": None, "level": 9, "notes": ""})
        elif sid == "long-walk":
            w["cardio"].append({"block": "b0", "exercise": "walk-outdoor", "minutes": [45, 50, 55, 60][min(wk, 4) - 1], "zone": "Z2", "avg_hr": 112, "distance_km": 5.2, "ascent_m": 60, "level": None, "notes": "Canal path"})
        workouts.append(w)
    return {
        "schema_version": 1,
        "profile": {"name": "", "sex": "male", "birth_year": 1996, "height_cm": 180, "injured_arm": "right", "dominant_hand": "right",
                    "injury_date": "2026-07-13", "program_start": "2026-10-26", "activity_factor": 1.55, "surplus_kcal": 300, "protein_g_per_kg": 1.8, "hrmax_override": None,
                    "rhr_baseline": 58, "diet_notes": "", "pre_injury_weight_kg": 83.0, "clearances": {"good_arm_ok": "2026-11-10", "clinic_light": None, "grip_cleared": None, "full_clearance": None},
                    "fasting_periods": [{"start": "2027-01-11", "end": "2027-01-15", "label": "Planned fast (example)", "approximate": False}],
                    "rhr_method_changes": [],
                    "unavailable_exercises": ["sled-drag-forward-belt", "sled-drag-backward-belt", "cable-kickback-ankle", "cable-hip-abduction-ankle", "cable-hip-adduction-ankle"]},
        "checkins": checkins,
        "workouts": workouts,
        "hikes": [
            {"id": "fx-hike-1", "date": "2026-11-08", "name": "Canal towpath", "distance_km": 10.4, "ascent_m": 105, "duration_min": 150, "pack_kg": 0, "terrain": "towpath", "avg_hr": 108, "rpe": 5, "ladder_level": 2, "notes": ""},
            {"id": "fx-hike-2", "date": "2026-11-15", "name": "Park loop and hill", "distance_km": 7.8, "ascent_m": 140, "duration_min": 120, "pack_kg": 0, "terrain": "gravel", "avg_hr": 112, "rpe": 6, "ladder_level": None, "notes": ""},
            {"id": "fx-hike-3", "date": "2026-11-14", "name": "Canal towpath (instead of the long walk)", "distance_km": 4.6, "ascent_m": None, "duration_min": 50, "pack_kg": 0, "terrain": "towpath", "avg_hr": 110, "rpe": 4, "ladder_level": None, "notes": "Logged in the hike log only: it counts as the long walk (at least 70% of the planned minutes)."},
        ],
        "tests": [
            {"date": "2026-10-26", "test": "sit-to-stand-30s", "value": 14, "notes": ""}, {"date": "2026-11-16", "test": "sit-to-stand-30s", "value": 18, "notes": ""},
            {"date": "2026-10-26", "test": "wall-sit", "value": 40, "notes": ""}, {"date": "2026-11-16", "test": "wall-sit", "value": 62, "notes": ""},
        ],
        "measurements": [
            {"date": "2026-10-26", "waist_cm": 81, "chest_cm": 94, "hips_cm": 95, "thigh_cm": 54, "calf_cm": 36, "arm_good_cm": 31, "arm_injured_cm": 29.5, "forearm_good_cm": 27, "forearm_injured_cm": 25},
            {"date": "2026-11-16", "waist_cm": 81.5, "chest_cm": 95, "hips_cm": 95.5, "thigh_cm": 55, "calf_cm": 36.4, "arm_good_cm": 31.4, "arm_injured_cm": 29.6, "forearm_good_cm": 27.2, "forearm_injured_cm": 25.1},
        ],
        "arm": {
            "appointments": [
                {"date": "2026-10-20", "type": "Fracture clinic", "notes": "", "outcome": "Healing well. Review in seven weeks. Good arm OK from 10 Nov."},
                {"date": "2026-12-08", "type": "Fracture clinic", "notes": "Bring the questions list", "outcome": ""},
            ],
            "logs": [{"date": d, "values": {"pain_rest": pr, "pain_activity": pa, "grip_good_kg": 46, "grip_injured_kg": gi}, "notes": ""}
                     for d, pr, pa, gi in [("2026-10-27", 3, 5, 12), ("2026-11-03", 2, 4, 14), ("2026-11-10", 2, 4, 16), ("2026-11-17", 1, 3, 19)]]
                    + [{"date": "2026-11-04", "values": {"pain_rest": 3, "pain_activity": 7}, "notes": "Knocked the arm on a door frame: RED (arm-log pain 7), no training, clinic called."}],
            "physio_exercises": [{"exercise": "rehab-finger-tendon-glides", "dose": "5 reps, 3 times a day", "since": "2026-10-20", "notes": "Gentle."}],
            "questions": {},
        },
        "weekly_reviews": [{"week_start": "2026-11-09", "wins": "Hit every strength session.", "struggles": "Sleep on Thursday.", "next_focus": "Bed by 22:30.", "adherence_pct": 83}],
        "hike_ladder": {}, "kit_owned": {"Walking boots or trail shoes": True, "Wool socks": True}, "meta": {},
        "ui": {"onboarding": {"version": 1, "completed_at": "2026-10-26T07:00:00Z", "safety_ack_at": "2026-10-26T07:00:00Z"}, "plates_kg": [20, 10, 5, 2.5, 1.25]},
        "goals": {"weight_gain_kg_week": [0.2, 0.3], "zone2_min_week": 150, "protein_days": 6, "focus": "Bed by 22:30."},
    }


def make_v1_copy() -> dict:
    """A frozen schema-1 data file in the shape a real one has after the welcome (sample values only).

    Every SPEC 5.7 field with the neutral example profile, plus the UI-owned keys (ui, goals, kit_owned)
    and an unknown future key, so the tests can prove migration keeps them. The tests use this file
    and never read the live data/ folder.
    """
    return {
        "schema_version": 1,
        "profile": {
            "name": "", "sex": "male", "birth_year": 1996, "height_cm": 180, "injured_arm": "right", "dominant_hand": "right",
            "program_start": "2026-11-30", "activity_factor": 1.55, "surplus_kcal": 300, "protein_g_per_kg": 1.8, "hrmax_override": None,
            "rhr_baseline": None, "diet_notes": "Budget-friendly protein.",
            "clearances": {"good_arm_ok": None, "clinic_light": None, "grip_cleared": None, "full_clearance": None},
        },
        "checkins": [{"date": "2026-11-21", "weight_kg": 80.0, "rhr": None, "hrv": None, "sleep_h": None, "sleep_q": None, "energy": None, "soreness": None,
                      "mood": None, "stress": None, "arm_pain": None, "arm_flags": [], "steps": None, "protein_g": None, "calories": None, "water_l": None,
                      "creatine": False, "notes": "Starting weight."}],
        "workouts": [], "hikes": [], "tests": [], "measurements": [],
        "arm": {"appointments": [{"date": "2026-12-08", "type": "Fracture clinic", "notes": "Bring the questions list.", "outcome": ""}], "logs": [], "physio_exercises": []},
        "weekly_reviews": [],
        "kit_owned": {"Walking boots or trail shoes": True},
        "ui": {"onboarding": {"version": 1, "skipped_at": "2026-11-21T09:00:00Z"}, "plates_kg": [20, 10, 5, 2.5]},
        "goals": {"zone2_min_week": 150, "focus": ""},
        "future_key": {"kept": True, "list": [1, 2, 3]},
    }


def make_dense_data(days: int = 730) -> dict:
    """Two years of dense, realistic daily use (for the performance tests and ?fixtures=1&data=2y).

    Schema v1 on purpose (tests, appointments and physio exercises have no ids), so loading it also
    exercises the v1 -> v2 migration at scale. Deterministic (seeded). No deliberate typos: the data
    quality tests inject their own.
    """
    rnd = random.Random(2024)
    start = dt.date(2023, 11, 27)  # a Monday
    end = start + dt.timedelta(days=days - 1)
    clear = {"good_arm_ok": dt.date(2023, 12, 18), "clinic_light": dt.date(2024, 1, 8), "grip_cleared": dt.date(2024, 3, 4), "full_clearance": dt.date(2024, 6, 3)}
    sessions = PROGRAM["sessions"]
    plan = {0: "str-a", 1: "engine", 2: "str-b", 3: "intervals", 4: "circuit-day", 5: "long-walk", 6: "rest"}
    checkins, workouts, hikes, tests, measurements, logs, reviews, appts = [], [], [], [], [], [], [], []
    weight, lp, hc = 76.0, 60.0, 25.0
    for i, d in enumerate(daterange(start, end)):
        iso = d.isoformat()
        if rnd.random() < 0.04:
            continue  # about one missed check-in in 25
        weight += 0.0075 + rnd.uniform(-0.12, 0.12)
        flags = ["swelling_new"] if rnd.random() < 0.004 else []
        checkins.append({
            "date": iso, "weight_kg": round(weight + rnd.uniform(-0.35, 0.35), 1), "rhr": rnd.choice([54, 55, 56, 57, 58, 58, 59, 60, 62, 65]),
            "hrv": rnd.randint(45, 80), "sleep_h": round(rnd.uniform(5.4, 8.6), 1), "sleep_q": rnd.randint(2, 5), "energy": rnd.randint(2, 5),
            "soreness": rnd.randint(0, 8), "mood": rnd.randint(2, 5), "stress": rnd.randint(1, 4), "arm_pain": rnd.choice([0, 1, 1, 2, 2, 3, 4]),
            "arm_flags": flags, "steps": rnd.randint(4500, 14500), "protein_g": rnd.randint(95, 165), "calories": rnd.randint(2300, 3300),
            "water_l": round(rnd.uniform(1.5, 3.2), 1), "creatine": rnd.random() > 0.1, "notes": "Long day, slept badly." if rnd.random() < 0.05 else "",
        })
    for d in daterange(start, end - dt.timedelta(days=1)):
        iso = d.isoformat()
        wk = (d - start).days // 7 + 1
        sid = plan[d.weekday()]
        todo = [] if sid == "rest" or rnd.random() < 0.08 else [sid]
        if clear["good_arm_ok"] <= d < clear["grip_cleared"] and d.weekday() in (0, 2, 4) and rnd.random() < 0.9:
            todo.append("crossed")
        if clear["clinic_light"] <= d < clear["full_clearance"] and rnd.random() < 0.7:
            todo.append("rehab")
        for s in todo:
            ses = sessions[s]
            w = {"id": f"dense-{iso}-{s}", "date": iso, "session_id": s, "session_name": ses["name"], "session_type": ses["type"], "phase_id": "p1", "phase_week": wk,
                 "duration_min": ses["duration_min"] - rnd.randint(-5, 10), "rpe": rnd.randint(4, 9), "notes": "", "exercises": [], "cardio": [], "status": "done",
                 "created_at": f"{iso}T06:30:00Z", "updated_at": f"{iso}T07:45:00Z", "completed_at": f"{iso}T07:45:00Z"}
            for bi, b in enumerate(ses["blocks"]):
                if "sets" in b:
                    n = b["sets"]
                    if b["exercise"] == "leg-press":
                        kg = lp
                    elif b["exercise"] in ("hamstring-curl", "leg-press-single", "goblet-squat", "ga-cable-row", "ga-chest-press-machine"):
                        kg = hc
                    elif b["exercise"] == "farmer-carry":
                        kg = 16 + wk // 8 * 2
                    else:
                        kg = None
                    sets = []
                    for k in range(n):
                        if "seconds" in b:
                            sets.append({"kg": None, "reps": None, "seconds": b["seconds"] + rnd.randint(-5, 15), "rir": None, "done": True})
                        else:
                            sets.append({"kg": kg, "reps": rnd.randint(7, 12), "seconds": None, "rir": rnd.choice([1, 2, 2, 3]), "done": rnd.random() > 0.03})
                    w["exercises"].append({"block": f"b{bi}", "exercise": b["exercise"], "sets": sets, "notes": ""})
                elif "minutes" in b or "intervals" in b:
                    zone = b.get("zone") or (b["intervals"]["work_zone"] if "intervals" in b else "Z2")
                    w["cardio"].append({"block": f"b{bi}", "exercise": b["exercise"], "minutes": b.get("minutes", 25) + rnd.randint(-3, 10), "zone": zone,
                                        "avg_hr": rnd.randint(112, 150), "distance_km": round(rnd.uniform(2, 9), 1) if b["exercise"] in ("walk-outdoor", "incline-walk") else None,
                                        "ascent_m": rnd.randint(20, 300) if b["exercise"] == "walk-outdoor" else None, "level": rnd.randint(3, 12), "notes": ""})
                elif "circuit" in b:
                    w["cardio"].append({"block": f"b{bi}", "exercise": "circuit", "items": [x["exercise"] for x in b["circuit"]["items"]], "minutes": b["circuit"]["minutes"],
                                        "rounds": rnd.randint(4, 8), "zone": b.get("zone", "Z2"), "avg_hr": rnd.randint(120, 145), "distance_km": None, "ascent_m": None, "level": None, "notes": ""})
            workouts.append(w)
            if s == "long-walk" and rnd.random() < 0.5:
                hikes.append({"id": f"dense-hike-{iso}", "date": iso, "name": rnd.choice(["Canal towpath", "Forest loop", "Country park trail", "Ridge walk", "South Downs Way"]),
                              "distance_km": round(rnd.uniform(6, 22), 1), "ascent_m": rnd.randint(40, 700), "duration_min": rnd.randint(90, 360), "pack_kg": rnd.choice([0, 0, 4, 6, 8]),
                              "terrain": rnd.choice(["good paths", "gravel", "chalk tracks", "woodland"]), "avg_hr": rnd.randint(100, 130), "rpe": rnd.randint(3, 8),
                              "ladder_level": None, "notes": "", "workout_id": w["id"]})
        if d.weekday() == 0:
            lp += 2.5 if wk % 5 else -5
            hc += 0.5
    for k, d in enumerate(daterange(start, end)):
        iso = d.isoformat()
        if d.weekday() == 6 and k % 14 == 6:
            hikes.append({"id": f"dense-solo-{iso}", "date": iso, "name": "Sunday ramble", "distance_km": round(rnd.uniform(5, 15), 1), "ascent_m": rnd.randint(30, 400),
                          "duration_min": rnd.randint(80, 260), "pack_kg": 0, "terrain": "good paths", "avg_hr": rnd.randint(98, 120), "rpe": rnd.randint(3, 6), "ladder_level": None, "notes": ""})
        if d.weekday() == 0:
            if (d - start).days % 28 == 0:
                for t, v in (("sit-to-stand-30s", 14 + k // 60), ("wall-sit", 40 + k // 20), ("balance-eyes-open", 20 + k // 30), ("resting-hr", 60 - k // 120)):
                    tests.append({"date": iso, "test": t, "value": v, "notes": ""})
            if (d - start).days % 14 == 0:
                measurements.append({"date": iso, "waist_cm": round(80 + rnd.uniform(-1, 2), 1), "chest_cm": round(94 + k / 120, 1), "hips_cm": 95.0, "thigh_cm": round(54 + k / 200, 1),
                                     "calf_cm": 36.0, "arm_good_cm": round(31 + k / 300, 1), "arm_injured_cm": round(29 + k / 250, 1), "forearm_good_cm": 27.0, "forearm_injured_cm": round(25 + k / 400, 1)})
            logs.append({"date": iso, "values": {"pain_rest": max(0, 3 - k // 120), "pain_activity": max(0, 5 - k // 100), "grip_good_kg": 46, "grip_injured_kg": min(46, 12 + k // 12),
                                                 "wrist_flex_deg": min(80, 30 + k // 6), "wrist_ext_deg": min(70, 25 + k // 7), "pronation_deg": min(80, 40 + k // 8), "supination_deg": min(85, 35 + k // 7)}, "notes": ""})
            reviews.append({"week_start": iso, "wins": "Hit my sessions.", "struggles": "Sleep." if rnd.random() < 0.4 else "", "next_focus": "Keep going.", "adherence_pct": rnd.randint(60, 100), "saved_at": f"{iso}T20:00:00Z"})
            if (d - start).days % 42 == 0:
                appts.append({"date": iso, "type": rnd.choice(["Fracture clinic", "Physio"]), "notes": "", "outcome": "Progressing well."})
    return {
        "schema_version": 1,
        "profile": {"name": "", "sex": "male", "birth_year": 1996, "height_cm": 180, "injured_arm": "right", "dominant_hand": "right", "program_start": start.isoformat(),
                    "activity_factor": 1.55, "surplus_kcal": 300, "protein_g_per_kg": 1.8, "hrmax_override": None, "rhr_baseline": 58, "diet_notes": "Budget-friendly protein.",
                    "clearances": {k: v.isoformat() for k, v in clear.items()}},
        "checkins": checkins, "workouts": workouts, "hikes": hikes, "tests": tests, "measurements": measurements,
        "arm": {"appointments": appts, "logs": logs,
                "physio_exercises": [{"exercise": e, "dose": "3 × 10, twice a day", "since": "2024-01-08", "notes": ""} for e in ("rehab-finger-tendon-glides", "rehab-putty-grip")],
                "questions": {"q1": {"question": "When can I carry shopping?", "asked": True, "notes": "At grip clearance."}}},
        "weekly_reviews": reviews, "hike_ladder": {"1": {"done": "2024-01-13"}}, "kit_owned": {"Wool socks": True, "Head torch": True}, "meta": {},
    }


def main() -> None:
    write("program.json", PROGRAM)
    write("exercises/part-a.json", PART_A)
    write("exercises/part-b.json", PART_B)
    write("tests.json", TESTS)
    write("hikes.json", HIKES)
    write("nutrition.json", NUTRITION)
    write("arm.json", ARM)
    write("guide/index.json", GUIDE_INDEX)
    write("guide/00-start-here.md", START_HERE)
    write("guide/03-training-principles.md", PRINCIPLES)
    write("data.json", make_data())
    write("data-v1.json", make_v1_copy())
    # Compact on purpose (about 2 MB): the two-year dataset for performance work.
    dense = OUT / "data-2y.json"
    dense.write_text(json.dumps(make_dense_data(), ensure_ascii=False, separators=(",", ":")) + "\n", encoding="utf-8", newline="\n")
    print(f"Fixtures written to {OUT}")


if __name__ == "__main__":
    main()
