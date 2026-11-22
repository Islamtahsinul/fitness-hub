// Loads the coaching content (program, exercises, tests, hikes, nutrition, arm, guide).
// Any file may be missing or half-written while it is being authored: each one is loaded
// independently, validated loosely, and reported in `content.status` instead of throwing.
//
// content.status: [{file, label, state, detail, problems}]
//   state: 'ok' | 'missing' | 'empty' | 'invalid' | 'error' (unchanged meanings)
//   problems: short, human-readable warnings found by the loose validation (the file is still
//   used). Safety-relevant ones (missing red flags, exercises scheduled above a phase's gate,
//   unknown gates treated as full clearance, a merged exercises.json that disagrees with its
//   parts) start with "Safety:".
//
// Round 3 (fail closed): gateOf(id) is null and isLocked(id, date, data) is true for any id that
// isn't in the library. When exercises.json and part-a + part-b disagree, both are read and the
// stricter gate wins for every id.

import { getText } from './api.js';
import { addDays, daysBetween, isISODate } from './dates.js';
import {
  GATE_ORDER, DAY_KEYS, blockKind, sessionExerciseIds, gateRank, exerciseGate, exerciseLocked, isAvailable as availableIn,
  alternatesOf, zoneNumber, UNAVAILABLE_DEFAULT, buildTimeline, positionOn, isGateMet, programStart,
} from './schedule.js';
import { fastingOn } from './calc.js';

export const content = {
  fixtures: false,
  base: '/content/',
  program: null,
  exercises: [],
  exById: new Map(),
  tests: [],
  hikes: null,
  nutrition: null,
  arm: null,
  guideIndex: null,
  status: [],
  loadedAt: null,
  exerciseSources: null, // {merged, parts, same, compare}: how the library was assembled
};

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isISO = isISODate;
const isHttp = (u) => typeof u === 'string' && /^https?:\/\/[^\s]+$/i.test(u.trim());
const chapterCache = new Map();
const MAX_PROBLEMS = 60;

export const EXERCISE_CATEGORIES = ['squat', 'hinge', 'single-leg', 'knee-ankle', 'calves', 'hip', 'core', 'balance', 'mobility', 'conditioning', 'push', 'pull', 'carry', 'grip', 'power', 'rehab'];
export const SESSION_TYPES = ['strength', 'cardio', 'intervals', 'hike', 'circuit', 'mobility', 'rehab', 'rest'];
export const TEST_CATEGORIES = ['strength', 'endurance', 'balance', 'mobility', 'body', 'grip', 'engine'];
export const RED_FLAG_IDS = ['pain_increasing', 'swelling_new', 'redness_heat', 'wound_discharge', 'fever_unwell', 'numbness_tingling', 'colour_cold', 'deformity_give', 'fall_on_arm'];
export const ARM_MEASUREMENT_IDS = ['pain_rest', 'pain_activity', 'grip_injured_kg', 'grip_good_kg', 'wrist_flex_deg', 'wrist_ext_deg', 'pronation_deg', 'supination_deg'];

/**
 * An exercise's gate, or null when the id isn't in the loaded library (null = always locked).
 * exById defaults to the loaded content.
 */
export function gateOf(id, exById = content.exById) {
  return exerciseGate(id, exById);
}

/**
 * Fail closed (SPEC 5.2 round 3): true when the exercise is locked on dateISO for this user's
 * clearances. Unknown ids (not in the library, or the library failed to load) are always locked.
 * data may be the user data ({profile: {clearances}}) or a profile.
 */
export function isLocked(id, dateISO, data, exById = content.exById) {
  const profile = data && typeof data === 'object' && data.profile && typeof data.profile === 'object' ? data.profile : data;
  return exerciseLocked(id, profile?.clearances || {}, dateISO, exById);
}

/** False when the exercise is on the "My gym: unavailable exercises" list (see schedule.isAvailable). */
export function isAvailable(id, data) {
  return availableIn(id, data);
}

export { UNAVAILABLE_DEFAULT };

// ---------------------------------------------------------------- phase-appropriate swaps (SPEC 5.2 round 4)

const profileOfData = (data) => (data && typeof data === 'object' && data.profile && typeof data.profile === 'object' && !Array.isArray(data.profile) ? data.profile : data);

/**
 * The highest gate that swaps and "Add an exercise" may offer on a date (SPEC 5.2 round 4, BT2-2):
 * the current phase's entry_gate (before the programme starts, the first phase's). On an add-on's
 * session (opts.sessionId) the add-on's own gate counts too, so the good-arm add-on can offer
 * good-arm work. opts.gate sets the ceiling directly. No program, or an unknown entry gate:
 * 'none' (fail safe). opts: {program = content.program, timeline, sessionId, gate}.
 */
export function phaseGateOn(dateISO, data, { program = content.program, timeline = null, sessionId = null, gate = null } = {}) {
  if (typeof gate === 'string' && GATE_ORDER.includes(gate)) return gate;
  const prog = isObj(program) ? program : null;
  const tl = timeline || (prog ? buildTimeline(prog, profileOfData(data) || {}) : null);
  let ceiling = 'none';
  if (tl && isISODate(dateISO)) {
    const pos = positionOn(tl, dateISO);
    if (pos) ceiling = pos.item.entryGate;
    else if (tl.phases.length && dateISO < tl.start) ceiling = tl.phases[0].entryGate;
  }
  if (!GATE_ORDER.includes(ceiling)) ceiling = 'none';
  if (sessionId && prog) {
    for (const a of Array.isArray(prog.addons) ? prog.addons : []) {
      if (isObj(a) && a.session === sessionId && GATE_ORDER.includes(a.gate) && gateRank(a.gate) > gateRank(ceiling)) ceiling = a.gate;
    }
  }
  return ceiling;
}

/**
 * Why an exercise can't be offered as a swap or an added exercise on a date, or null when it can:
 * 'unknown' (not in the library: fail closed), 'locked' (above your clearances), 'phase' (above
 * the current phase's entry gate, phaseGateOn) or 'unavailable' (profile.unavailable_exercises).
 * opts: {program, timeline, sessionId, gate, exById = content.exById}.
 */
export function whyNotAllowed(id, dateISO, data, opts = {}) {
  const exById = opts.exById || content.exById;
  const g = exerciseGate(id, exById);
  if (g === null) return 'unknown';
  const profile = profileOfData(data) || {};
  if (!isGateMet(g, profile.clearances || {}, dateISO)) return 'locked';
  if (gateRank(g) > gateRank(phaseGateOn(dateISO, data, opts))) return 'phase';
  if (!availableIn(id, data)) return 'unavailable';
  return null;
}

/**
 * SPEC 5.2 round 4 (BT2-2): may this exercise be offered in a swap or "Add an exercise" on this
 * date? Only with a gate at or below the current phase's entry gate, never above your clearances,
 * and never one on profile.unavailable_exercises. Unknown ids never (fail closed). data: the user
 * data or a profile. opts: see whyNotAllowed.
 */
export function allowedForPhase(id, dateISO, data, opts = {}) {
  return whyNotAllowed(id, dateISO, data, opts) === null;
}

// ---------------------------------------------------------------- an exercise's own prescription (SPEC 5.2 round 4)

const NUM_SRC = '(\\d+(?:\\.\\d+)?)';
const RANGE_SRC = `${NUM_SRC}(?:\\s*(?:-|–|—|to)\\s*${NUM_SRC})?`;
const DOSE_SETS = new RegExp(`${RANGE_SRC}\\s*(?:[×x]|sets? of|rounds? of)\\s*${RANGE_SRC}(\\s*-?\\s*(?:s|secs?|seconds?|min|mins|minutes?|m|metres?|meters?|steps?)\\b)?`, 'i');
const DOSE_MIN = new RegExp(`${RANGE_SRC}\\s*-?\\s*(?:min|mins|minutes?)\\b`, 'i');
const DOSE_SEC = new RegExp(`${RANGE_SRC}\\s*-?\\s*(?:s|secs?|seconds?)\\b`, 'i');
const DOSE_REPS = new RegExp(`${RANGE_SRC}\\s+(?:(?:slow|easy|hard|crisp)\\s+)?(?:reps?|rocks?|switches|breaths?|circles?|turns?|swings?|marches|squeezes|singles|lowers|slams|jumps|contacts)\\b`, 'i');
const PER_SIDE = /\b(?:per|each|a)\s+(?:leg|side|hand|arm|shoulder)\b|\/\s*(?:side|leg|hand|arm|shoulder)\b/i;
const LOAD_KIT = /dumbbell|barbell|kettlebell|\bplates?\b|machine|cable|smith|sandbag|\bsled\b|leg press|slam ball|med(?:icine)? ball|gripper|weight/i;
const BODYWEIGHT_ID = /-bw$|push-up|pull-up|inverted-row|dead-hang|plank|hanging/;

const rangeOf = (a, b) => {
  const lo = Number(a);
  const hi = b != null ? Number(b) : lo;
  return { min: Math.min(lo, hi), max: Math.max(lo, hi) };
};
const rangeText = (r) => (r.min === r.max ? String(r.min) : `${r.min}-${r.max}`);

/** Does the exercise use an external load (a kg column)? From its main kit, ignoring "optional" and "or …" items. */
function usesLoad(ex) {
  if (!ex || BODYWEIGHT_ID.test(String(ex.id || ''))) return false;
  return (Array.isArray(ex.equipment) ? ex.equipment : []).some((item) => {
    if (typeof item !== 'string' || /^\s*(?:optional|or)\b/i.test(item)) return false;
    return LOAD_KIT.test(item.split(/[:(,;]|\sor\s/i)[0]);
  });
}

/**
 * A library dose string read as a prescription: {type, sets, setsRange, reps, repRange, seconds,
 * secondsRange, minutes, minutesRange, metres, unit, rir, per_side, zone}. type: 'reps' | 'timed' |
 * 'cardio' | 'physio' | 'other'. The first "N × M" (also "N sets of M", "N rounds of M s") wins;
 * cardio work reads its minutes when they come first; a range of sets or seconds starts at its
 * lower end (setsRange / secondsRange keep the whole range).
 */
export function parseDose(dose, ex = null) {
  const s = typeof dose === 'string' ? dose : '';
  const category = typeof ex?.category === 'string' ? ex.category : '';
  const out = {
    type: 'other', sets: null, setsRange: null, reps: null, repRange: null, seconds: null, secondsRange: null,
    minutes: null, minutesRange: null, metres: null, unit: null, rir: '', per_side: PER_SIDE.test(s), zone: null,
  };
  const rir = /RIR\s*(\d+(?:\s*[-–]\s*\d+)?)/i.exec(s);
  if (rir) out.rir = rir[1].replace(/\s*[-–]\s*/, '-');
  const zone = /\b(?:Z|Zone\s*)([1-5])\b/i.exec(s);
  if (zone) out.zone = `Z${zone[1]}`;
  if (category === 'rehab' || /as prescribed by your physio|only as prescribed/i.test(s)) { out.type = 'physio'; return out; }
  const sets = DOSE_SETS.exec(s);
  const mins = DOSE_MIN.exec(s);
  const cardio = category === 'conditioning';
  const minutes = (m) => { out.type = 'cardio'; out.unit = 'min'; out.minutesRange = rangeOf(m[1], m[2]); out.minutes = out.minutesRange.min; };
  if (cardio && mins && (!sets || mins.index < sets.index)) { minutes(mins); return out; }
  if (sets) {
    out.setsRange = rangeOf(sets[1], sets[2]);
    out.sets = out.setsRange.min;
    const v = rangeOf(sets[3], sets[4]);
    const unit = String(sets[5] || '').replace(/[\s-]/g, '').toLowerCase();
    if (/^(s|secs?|seconds?)$/.test(unit)) { out.type = 'timed'; out.unit = 's'; out.secondsRange = v; out.seconds = v.min; }
    else if (/^(min|mins|minutes?)$/.test(unit)) { out.type = 'cardio'; out.unit = 'min'; out.minutesRange = v; out.minutes = v.min; }
    else if (/^(m|metres?|meters?)$/.test(unit)) { out.type = 'reps'; out.unit = 'm'; out.metres = v.min; out.repRange = v; out.reps = rangeText(v); }
    else { out.type = 'reps'; out.unit = unit.startsWith('step') ? 'steps' : 'reps'; out.repRange = v; out.reps = rangeText(v); }
    return out;
  }
  if (cardio) { out.type = 'cardio'; out.unit = 'min'; return out; }
  const secs = DOSE_SEC.exec(s);
  const reps = DOSE_REPS.exec(s);
  if (secs && (!reps || secs.index < reps.index)) {
    out.type = 'timed'; out.unit = 's'; out.sets = 1; out.setsRange = { min: 1, max: 1 };
    out.secondsRange = rangeOf(secs[1], secs[2]); out.seconds = out.secondsRange.min;
    return out;
  }
  if (reps) {
    out.type = 'reps'; out.unit = 'reps'; out.sets = 1; out.setsRange = { min: 1, max: 1 };
    out.repRange = rangeOf(reps[1], reps[2]); out.reps = rangeText(out.repRange);
    return out;
  }
  if (mins) {
    out.type = 'timed'; out.unit = 's'; out.sets = 1; out.setsRange = { min: 1, max: 1 };
    out.secondsRange = { min: Number(mins[1]) * 60, max: Number(mins[2] ?? mins[1]) * 60 }; out.seconds = out.secondsRange.min;
  }
  return out;
}

/**
 * An exercise's own default prescription from the library (SPEC 5.2 round 4, BT2-2/3): what a
 * swapped-in or added exercise is shown with, instead of the replaced block's. Returns null for an
 * id that isn't in the library (it's locked anyway), else {id, name, type, kind, kg, load, sets,
 * setsRange, reps, repRange, seconds, secondsRange, minutes, zone, rir, per_side, unit, metres,
 * dose, cues, block}.
 * - type: 'loaded' (reps with a kg column), 'reps' (bodyweight reps), 'timed' (holds and carries;
 *   kg says whether it's loaded), 'cardio', 'physio' (as prescribed by your physio) or 'other'
 *   (the dose text could not be read: show `dose`).
 * - kg: show a kg column. load: 'double-progression' (loaded reps), 'bodyweight', 'physio' or ''.
 * - block: the prescription as a program block ({exercise, sets, reps, rir, load, per_side} /
 *   {exercise, sets, seconds} / {exercise, minutes, zone}), so resolveBlock(block, {week,
 *   override, easyDay}) applies the day's sets_max, deload, easy-day and fasting rules to it.
 * The second argument may be the library (a Map) or {exById, sets}: `sets` (the replaced block's
 * planned sets) is kept when the exercise's own range of sets allows it.
 */
export function prescriptionFor(exerciseId, opts = {}) {
  const o = opts instanceof Map ? { exById: opts } : isObj(opts) ? opts : {};
  const lib = o.exById instanceof Map ? o.exById : content.exById;
  const ex = typeof exerciseId === 'string' ? lib.get(exerciseId) : null;
  if (!ex) return null;
  const p = parseDose(ex.dose, ex);
  const loaded = usesLoad(ex);
  let sets = p.sets;
  if (p.setsRange && Number.isInteger(Number(o.sets)) && Number(o.sets) >= 1) sets = Math.min(Math.max(Number(o.sets), p.setsRange.min), p.setsRange.max);
  let type = p.type;
  let load = '';
  let block = { exercise: ex.id };
  if (p.type === 'reps') {
    type = loaded ? 'loaded' : 'reps';
    load = loaded ? (p.unit === 'reps' ? 'double-progression' : '') : 'bodyweight';
    block = { exercise: ex.id, sets, reps: p.reps, rir: p.rir, load, per_side: p.per_side };
  } else if (p.type === 'timed') {
    load = loaded ? '' : 'bodyweight';
    block = { exercise: ex.id, sets, seconds: p.seconds, per_side: p.per_side, ...(p.rir ? { rir: p.rir } : {}), ...(load ? { load } : {}) };
  } else if (p.type === 'cardio') {
    block = { exercise: ex.id, minutes: p.minutes, zone: p.zone || 'Z2' };
  } else if (p.type === 'physio') {
    load = 'physio';
    block = { exercise: ex.id, sets: 1, load: 'physio' };
  }
  return {
    id: ex.id, name: ex.name, type, kind: blockKind(block), kg: loaded && (type === 'loaded' || type === 'timed' || (type === 'reps' && p.unit === 'm')),
    load, sets, setsRange: p.setsRange, reps: p.reps, repRange: p.repRange, seconds: p.seconds, secondsRange: p.secondsRange,
    minutes: p.minutes, zone: p.zone, rir: p.rir, per_side: p.per_side, unit: p.unit, metres: p.metres,
    dose: typeof ex.dose === 'string' ? ex.dose : '', cues: Array.isArray(ex.cues) ? [...ex.cues] : [], block,
  };
}

// ---------------------------------------------------------------- when tests are due (SPEC 5.2 round 4)

const posInt = (v) => (v !== null && v !== '' && typeof v !== 'boolean' && Number.isInteger(Number(v)) && Number(v) >= 1 ? Number(v) : null);

/**
 * The earliest date a test can be due (tests.json scheduling fields): `first_phase` (a phase id)
 * plus `first_week` (a week of that phase, default 1), or `first_week` alone (a programme week),
 * else the programme start. null while first_phase hasn't started (or isn't in the program).
 */
export function testEarliestDue(test, timeline) {
  const start = timeline?.start || null;
  if (!start) return null;
  const week = posInt(test?.first_week) || 1;
  if (typeof test?.first_phase === 'string' && test.first_phase) {
    const ph = (Array.isArray(timeline.phases) ? timeline.phases : []).find((p) => p && p.id === test.first_phase);
    return ph && ph.start ? addDays(ph.start, (week - 1) * 7) : null;
  }
  return addDays(start, (week - 1) * 7);
}

/**
 * A first result's due date, never before testEarliestDue: `baseline_day` (1–3 = Mon–Wed of
 * programme week 1). The older tests.json forms still work: `due_from` (a date), `baseline` or
 * `schedule` ({phase, week, day}: that phase's week, weekday 1–7) and `baseline_week` (a programme
 * week). null while the phase it waits for hasn't started (or isn't in the program).
 */
export function testBaselineDue(test, timeline) {
  const earliest = testEarliestDue(test, timeline);
  if (!earliest) return null;
  const sched = isObj(test?.baseline) ? test.baseline : isObj(test?.schedule) ? test.schedule : null;
  let day = null;
  if (isISODate(test?.due_from)) day = test.due_from;
  else if (sched && (sched.phase || sched.week != null || sched.day != null)) {
    let from = timeline.start;
    if (typeof sched.phase === 'string' && sched.phase) {
      const ph = (Array.isArray(timeline.phases) ? timeline.phases : []).find((p) => p && p.id === sched.phase);
      if (!ph || !ph.start) return null;
      from = ph.start;
    }
    day = addDays(from, ((posInt(sched.week) || 1) - 1) * 7 + Math.min(posInt(sched.day) || 1, 7) - 1);
  } else if (posInt(test?.baseline_day) !== null) day = addDays(timeline.start, Math.min(posInt(test.baseline_day), 7) - 1);
  else if (posInt(test?.baseline_week) !== null) day = addDays(timeline.start, (posInt(test.baseline_week) - 1) * 7);
  return day && day > earliest ? day : earliest;
}

/** The first date on or after iso outside every fasting period. */
function afterFasting(profile, iso) {
  let d = iso;
  for (let i = 0; i < 50; i++) {
    const p = fastingOn(profile, d);
    if (!p) return d;
    d = addDays(p.end, 1);
  }
  return d;
}

function testTimeline(data, { program = content.program, timeline = null } = {}) {
  if (timeline && isISODate(timeline.start)) return timeline;
  const profile = profileOfData(data) || {};
  return isObj(program) ? buildTimeline(program, profile) : { start: programStart(null, profile), phases: [] };
}

/**
 * One test's status on a date: {test, id, state, dueOn, last, overdueDays, baseline, earliest}.
 * state: 'locked' (its gate isn't met), 'scheduled' (no result yet and not due: dueOn says when, or
 * null while its first phase hasn't started), 'due', 'done' (not due again yet) or 'paused' (it
 * would be due, but the date is in a fasting period). A first result is due on testBaselineDue; a
 * repeat every_weeks after the last result, never before testEarliestDue. A due date that falls in
 * a fasting period moves to the day after it. opts: {program = content.program, timeline}.
 */
export function testStatusOn(data, dateISO, test, opts = {}) {
  const profile = profileOfData(data) || {};
  const tl = testTimeline(data, opts);
  const id = typeof test?.id === 'string' ? test.id : null;
  const res = (Array.isArray(data?.tests) ? data.tests : [])
    .filter((t) => t && t.test === id && isISODate(t.date) && t.value !== null && t.value !== '' && Number.isFinite(Number(t.value)) && t.date <= dateISO)
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  const last = res[res.length - 1] || null;
  const earliest = testEarliestDue(test, tl);
  const out = { test, id, state: 'scheduled', dueOn: null, last, overdueDays: 0, baseline: !last, earliest };
  const gate = typeof test?.gate === 'string' && test.gate ? test.gate : 'none';
  if (!isGateMet(gate, profile.clearances || {}, dateISO)) return { ...out, state: 'locked' };
  const gated = typeof test?.first_phase === 'string' && test.first_phase;
  let dueOn = null;
  if (!last) dueOn = testBaselineDue(test, tl);
  else if (!gated || earliest) {
    const every = Number(test?.every_weeks);
    dueOn = Number.isFinite(every) && every > 0 ? addDays(last.date, Math.round(every * 7)) : null;
    if (dueOn && earliest && earliest > dueOn) dueOn = earliest;
  }
  if (dueOn) dueOn = afterFasting(profile, dueOn);
  if (!dueOn) return { ...out, state: last ? 'done' : 'scheduled' };
  if (dueOn > dateISO) return { ...out, state: last ? 'done' : 'scheduled', dueOn };
  if (fastingOn(profile, dateISO)) return { ...out, state: 'paused', dueOn };
  return { ...out, state: 'due', dueOn, overdueDays: daysBetween(dueOn, dateISO) };
}

/**
 * Tests due on a date, most overdue first (SPEC 5.2 round 4; BT2-1 / BT1-13): never before the
 * programme starts, never during a fasting period, never above your gate, never before their
 * first_phase / first_week, and first-week baselines spread over Mon–Wed by baseline_day.
 * `tests` defaults to the loaded tests.json; opts: {program = content.program, timeline}. The
 * older argument order (data, tests, date, timeline) works too.
 */
export function testsDueOn(data, dateISO, tests = content.tests, opts = {}) {
  if (Array.isArray(dateISO) && isISODate(tests)) {
    const list = dateISO;
    dateISO = tests;
    tests = list;
    if (isObj(opts) && Array.isArray(opts.phases)) opts = { timeline: opts };
  }
  if (!isISODate(dateISO)) return [];
  const profile = profileOfData(data) || {};
  if (fastingOn(profile, dateISO)) return [];
  const o = isObj(opts) ? opts : {};
  const tl = testTimeline(data, o);
  if (tl.start && dateISO < tl.start) return [];
  return (Array.isArray(tests) ? tests : []).filter((t) => isObj(t) && typeof t.id === 'string' && t.id)
    .map((t) => testStatusOn(data, dateISO, t, { ...o, timeline: tl }))
    .filter((s) => s.state === 'due')
    .sort((a, b) => b.overdueDays - a.overdueDays);
}

async function loadJSON(path) {
  const url = content.base + path;
  try {
    const text = await getText(url);
    if (text === null) return { path, state: 'missing', value: null };
    if (!text.trim()) return { path, state: 'empty', value: null };
    try {
      return { path, state: 'ok', value: JSON.parse(text.replace(/^\uFEFF/, '')) };
    } catch (e) {
      return { path, state: 'invalid', value: null, detail: 'Not valid JSON yet (it may still be being written).' };
    }
  } catch (e) {
    return { path, state: 'error', value: null, detail: String((e && e.message) || e) };
  }
}

function problemList() {
  const list = [];
  let more = 0;
  const add = (msg) => { if (list.length < MAX_PROBLEMS) list.push(msg); else more++; };
  add.list = list;
  add.done = () => (more ? [...list, `…and ${more} more.`] : list);
  return add;
}

function cleanExercises(list, add = () => {}) {
  const seen = new Map();
  (Array.isArray(list) ? list : []).forEach((ex, i) => {
    if (!isObj(ex) || typeof ex.id !== 'string' || !ex.id.trim()) { add(`Exercise #${i + 1} has no id and was skipped.`); return; }
    const e = { ...ex };
    e.name = typeof e.name === 'string' && e.name.trim() ? e.name : e.id;
    e.gate = typeof e.gate === 'string' && GATE_ORDER.includes(e.gate) ? e.gate : 'full_clearance';
    e.gateKnown = typeof ex.gate === 'string' && GATE_ORDER.includes(ex.gate);
    if (!e.gateKnown) add(`Safety: ${ex.id} has ${ex.gate === undefined ? 'no gate' : `an unknown gate "${ex.gate}"`}, so it is locked until full clearance.`);
    for (const k of ['equipment', 'muscles', 'setup', 'cues', 'mistakes', 'regressions', 'progressions']) {
      e[k] = Array.isArray(e[k]) ? e[k].filter((x) => typeof x === 'string') : [];
    }
    for (const k of ['category', 'arm_use', 'fall_risk', 'why', 'arm_safety', 'dose', 'video', 'source']) {
      e[k] = typeof e[k] === 'string' ? e[k] : '';
    }
    for (const k of ['video', 'source']) {
      if (e[k] && !isHttp(e[k])) { add(`${ex.id}: ${k} "${e[k].slice(0, 60)}" is not an http(s) link and was dropped.`); e[k] = ''; }
    }
    if (e.category && !EXERCISE_CATEGORIES.includes(e.category)) add(`${ex.id}: unknown category "${e.category}".`);
    if (e.arm_use && !['none', 'good-arm', 'injured-light', 'both'].includes(e.arm_use)) add(`${ex.id}: unknown arm_use "${e.arm_use}".`);
    if (e.fall_risk && !['low', 'medium', 'high'].includes(e.fall_risk)) add(`${ex.id}: unknown fall_risk "${e.fall_risk}".`);
    if ((e.gate === 'none' || e.gate === 'good_arm_ok') && !e.arm_safety.trim()) add(`${ex.id}: arm_safety is required for gate ${e.gate}.`);
    if (seen.has(e.id)) add(`Duplicate exercise id ${e.id}: the first one is used.`);
    else seen.set(e.id, e);
  });
  const out = [...seen.values()];
  for (const e of out) {
    for (const k of ['regressions', 'progressions']) {
      const missing = e[k].filter((id) => !seen.has(id));
      if (missing.length) add(`${e.id}: ${k} refer to unknown exercises (${missing.slice(0, 4).join(', ')}).`);
    }
  }
  return out;
}

/**
 * Compare a merged exercises.json with part-a + part-b (by ids and gates). Returns
 * {same, onlyMerged, onlyParts, gateDiffs: [{id, merged, parts}]} using the raw gate values.
 */
export function compareExerciseSources(merged, parts) {
  const byId = (list) => {
    const m = new Map();
    for (const e of Array.isArray(list) ? list : []) if (isObj(e) && typeof e.id === 'string' && e.id.trim() && !m.has(e.id)) m.set(e.id, e);
    return m;
  };
  const a = byId(merged);
  const b = byId(parts);
  const onlyMerged = [...a.keys()].filter((k) => !b.has(k));
  const onlyParts = [...b.keys()].filter((k) => !a.has(k));
  const gateDiffs = [...a.keys()].filter((k) => b.has(k) && a.get(k).gate !== b.get(k).gate)
    .map((id) => ({ id, merged: a.get(id).gate, parts: b.get(id).gate }));
  return { same: !onlyMerged.length && !onlyParts.length && !gateDiffs.length, onlyMerged, onlyParts, gateDiffs };
}

/** Effective gate of a raw entry (unknown or missing counts as full_clearance), for "stricter wins". */
const rawGateRank = (e) => (typeof e?.gate === 'string' && GATE_ORDER.includes(e.gate) ? gateRank(e.gate) : GATE_ORDER.length - 1);

/**
 * One raw list from both sources: every id in either. The parts are the source of truth for the
 * text; for each id the stricter gate of the two wins (fail safe).
 */
function unionExercises(merged, parts) {
  const out = [];
  const index = new Map();
  for (const e of Array.isArray(parts) ? parts : []) {
    if (isObj(e) && typeof e.id === 'string' && e.id.trim() && !index.has(e.id)) { index.set(e.id, out.length); out.push({ ...e }); }
  }
  for (const e of Array.isArray(merged) ? merged : []) {
    if (!isObj(e) || typeof e.id !== 'string' || !e.id.trim()) continue;
    const i = index.get(e.id);
    if (i === undefined) { index.set(e.id, out.length); out.push({ ...e }); continue; }
    if (rawGateRank(e) > rawGateRank(out[i])) out[i] = { ...out[i], gate: GATE_ORDER.includes(e.gate) ? e.gate : 'full_clearance' };
  }
  return out;
}

function cleanProgram(p) {
  if (!isObj(p)) return null;
  const out = { ...p };
  out.phases = Array.isArray(p.phases) ? p.phases.filter(isObj) : [];
  out.sessions = isObj(p.sessions) ? p.sessions : {};
  out.routines = isObj(p.routines) ? p.routines : {};
  out.addons = Array.isArray(p.addons) ? p.addons.filter(isObj) : [];
  out.rules = isObj(p.rules) ? p.rules : {};
  out.gates = Array.isArray(p.gates) ? p.gates.filter(isObj) : [];
  return out;
}

/** Loose checks of program.json against SPEC 5.2. Returns problem strings (never throws). */
export function validateProgram(p, exById = null) {
  const add = problemList();
  try {
    if (!isObj(p)) return ['Not a program object.'];
    const raw = p;
    if (!Array.isArray(raw.phases) || !raw.phases.length) add('There are no phases yet.');
    const sessions = isObj(raw.sessions) ? raw.sessions : {};
    const routines = isObj(raw.routines) ? raw.routines : {};
    const phaseIds = new Set();
    (Array.isArray(raw.phases) ? raw.phases : []).forEach((ph, i) => {
      if (!isObj(ph)) { add(`Phase #${i + 1} is not an object.`); return; }
      const id = typeof ph.id === 'string' && ph.id ? ph.id : `#${i + 1}`;
      if (phaseIds.has(id)) add(`Duplicate phase id ${id}.`);
      phaseIds.add(id);
      if (!GATE_ORDER.includes(ph.entry_gate || 'none')) add(`Safety: phase ${id} has an unknown entry_gate "${ph.entry_gate}", treated as full_clearance.`);
      const weeks = Number(ph.weeks);
      if (!Number.isInteger(weeks) || weeks < 1) add(`Phase ${id}: weeks should be a whole number of at least 1.`);
      if (ph.repeat_from_week !== null && ph.repeat_from_week !== undefined && !(Number.isInteger(ph.repeat_from_week) && ph.repeat_from_week >= 1 && ph.repeat_from_week <= weeks)) add(`Phase ${id}: repeat_from_week should be 1–${weeks} or null.`);
      if (ph.min_weeks !== null && ph.min_weeks !== undefined && !(Number.isInteger(ph.min_weeks) && ph.min_weeks >= 1 && ph.min_weeks <= weeks)) add(`Phase ${id}: min_weeks should be 1–${weeks}.`);
      const tpl = isObj(ph.week_template) ? ph.week_template : null;
      if (!tpl) add(`Phase ${id}: week_template is missing.`);
      else {
        for (const k of Object.keys(tpl)) if (!DAY_KEYS.includes(k)) add(`Phase ${id}: week_template has an unknown day "${k}".`);
        for (const d of DAY_KEYS) {
          const ids = tpl[d] == null ? [] : Array.isArray(tpl[d]) ? tpl[d] : [tpl[d]];
          for (const sid of ids) if (sid !== 'rest' && !isObj(sessions[sid])) add(`Phase ${id} ${d}: session "${sid}" does not exist.`);
        }
        // Safety: anything scheduled in a phase must be allowed at the phase's entry gate.
        if (exById && exById.size) {
          const gateR = gateRank(ph.entry_gate || 'none');
          const ids = new Set(Object.values(tpl).flat().filter((s) => typeof s === 'string' && isObj(sessions[s]))
            .flatMap((s) => sessionExerciseIds(sessions[s], routines)));
          for (const x of ids) {
            const ex = exById.get(x);
            if (ex && gateRank(ex.gate) > gateR) add(`Safety: phase ${id} schedules ${x}, which needs ${ex.gate} (the phase opens at ${ph.entry_gate || 'none'}). The hub keeps it locked.`);
          }
        }
      }
      for (const o of Array.isArray(ph.week_overrides) ? ph.week_overrides : []) {
        if (!isObj(o)) continue;
        if (!(Number.isInteger(Number(o.week)) && Number(o.week) >= 1 && Number(o.week) <= weeks)) add(`Phase ${id}: an override is for week ${o.week}, outside 1–${weeks}.`);
        if (o.deload && o.sets_max != null) add(`Phase ${id} week ${o.week}: sets_max and deload are combined (SPEC says never both).`);
        if (o.cardio_scale != null && !(Number(o.cardio_scale) > 0)) add(`Phase ${id} week ${o.week}: cardio_scale should be above 0.`);
        if (o.zone_cap != null && zoneNumber(o.zone_cap) === null) add(`Phase ${id} week ${o.week}: zone_cap "${String(o.zone_cap).slice(0, 20)}" should be Z1–Z5 (ignored).`);
        if (o.circuit_minutes != null && !(Number(o.circuit_minutes) > 0)) add(`Phase ${id} week ${o.week}: circuit_minutes should be a number above 0 (ignored).`);
        if (o.rounds != null && !(Number.isInteger(Number(o.rounds)) && Number(o.rounds) >= 1)) add(`Phase ${id} week ${o.week}: rounds should be a whole number of at least 1.`);
      }
    });
    for (const [sid, s] of Object.entries(sessions)) {
      if (!isObj(s)) { add(`Session ${sid} is not an object.`); continue; }
      if (s.type && !SESSION_TYPES.includes(s.type)) add(`Session ${sid}: unknown type "${s.type}".`);
      for (const k of ['warmup', 'cooldown']) if (s[k] && !isObj(routines[s[k]])) add(`Session ${sid}: ${k} routine "${s[k]}" does not exist.`);
      if (s.blocks !== undefined && !Array.isArray(s.blocks)) add(`Session ${sid}: blocks should be a list.`);
      (Array.isArray(s.blocks) ? s.blocks : []).forEach((b, i) => {
        if (blockKind(b) === 'unknown') add(`Session ${sid} block ${i + 1}: shape not recognised (it is shown without targets).`);
        if (isObj(b) && b.minutes_by_week !== undefined && !(Array.isArray(b.minutes_by_week) && b.minutes_by_week.every((m) => Number.isFinite(Number(m)) && m !== null))) add(`Session ${sid} block ${i + 1}: minutes_by_week has entries that are not numbers.`);
      });
      if (exById && exById.size) {
        const missing = sessionExerciseIds(s, routines).filter((x) => !exById.has(x));
        if (missing.length) add(`Session ${sid}: exercises not in the library (${missing.slice(0, 5).join(', ')}${missing.length > 5 ? '…' : ''}).`);
      }
    }
    (Array.isArray(raw.addons) ? raw.addons : []).forEach((a, i) => {
      if (!isObj(a)) return;
      const id = a.id || `#${i + 1}`;
      if (!isObj(sessions[a.session])) add(`Add-on ${id}: session "${a.session}" does not exist.`);
      if (!GATE_ORDER.includes(a.gate || 'none')) add(`Safety: add-on ${id} has an unknown gate "${a.gate}", treated as full_clearance.`);
      if (a.until_gate != null && !GATE_ORDER.includes(a.until_gate)) add(`Add-on ${id}: unknown until_gate "${a.until_gate}".`);
      if (Array.isArray(a.phases)) for (const ph of a.phases) if (!phaseIds.has(ph)) add(`Add-on ${id}: unknown phase "${ph}".`);
      if (Array.isArray(a.days)) for (const d of a.days) if (!DAY_KEYS.includes(String(d).trim().toLowerCase().slice(0, 3))) add(`Add-on ${id}: unknown day "${d}".`);
    });
    // Round 3 PM additions: alternates are gate-"none" sessions ("Short on time?", "Gym closed?").
    if (raw.alternates !== undefined) {
      if (!isObj(raw.alternates)) add('alternates should be an object {short, travel}.');
      else {
        const alt = alternatesOf({ alternates: raw.alternates, sessions });
        for (const k of ['short', 'travel']) {
          const sid = raw.alternates[k];
          if (sid === undefined || sid === null) continue;
          if (!alt[k]) { add(`alternates.${k}: session "${sid}" does not exist.`); continue; }
          if (exById && exById.size) {
            for (const x of sessionExerciseIds(sessions[sid], routines)) {
              const ex = exById.get(x);
              if (ex && gateRank(ex.gate) > 0) add(`Safety: alternate session ${sid} uses ${x}, which needs ${ex.gate} (alternates must be gate "none"). The hub keeps it locked.`);
            }
          }
        }
      }
    }
    const inc = isObj(raw.rules) && isObj(raw.rules.increments_kg) ? raw.rules.increments_kg : null;
    if (inc) for (const [k, v] of Object.entries(inc)) if (!(Number(v) > 0)) add(`rules.increments_kg.${k} should be a positive number.`);
  } catch (e) {
    add(`Validation stopped early: ${String((e && e.message) || e)}`);
  }
  return add.done();
}

function cleanTests(list, add = () => {}) {
  const seen = new Set();
  const out = [];
  (Array.isArray(list) ? list : []).forEach((t, i) => {
    if (!isObj(t) || typeof t.id !== 'string' || !t.id) { add(`Test #${i + 1} has no id and was skipped.`); return; }
    if (seen.has(t.id)) { add(`Duplicate test id ${t.id}.`); return; }
    seen.add(t.id);
    if (t.gate !== undefined && !GATE_ORDER.includes(t.gate)) add(`Safety: test ${t.id} has an unknown gate "${t.gate}".`);
    if (t.category && !TEST_CATEGORIES.includes(t.category)) add(`Test ${t.id}: unknown category "${t.category}".`);
    // Round 4 scheduling fields (optional): first_phase, first_week, baseline_day.
    if (t.first_phase !== undefined && t.first_phase !== null && !(typeof t.first_phase === 'string' && t.first_phase.trim())) add(`Test ${t.id}: first_phase should be a phase id.`);
    if (t.first_week !== undefined && t.first_week !== null && posInt(t.first_week) === null) add(`Test ${t.id}: first_week should be a whole number of at least 1.`);
    if (t.baseline_day !== undefined && t.baseline_day !== null && !(posInt(t.baseline_day) !== null && Number(t.baseline_day) <= 3)) add(`Test ${t.id}: baseline_day should be 1, 2 or 3 (Monday to Wednesday of programme week 1).`);
    out.push(t);
  });
  return out;
}

function cleanHikes(h, add = () => {}) {
  if (!isObj(h)) return null;
  const ladder = Array.isArray(h.ladder) ? h.ladder.filter(isObj).sort((a, b) => (Number(a.level) || 0) - (Number(b.level) || 0)) : [];
  const levels = new Set();
  for (const l of ladder) {
    if (levels.has(l.level)) add(`Hike ladder: level ${l.level} appears twice.`);
    levels.add(l.level);
    if (l.gate !== undefined && !GATE_ORDER.includes(l.gate)) add(`Safety: ladder level ${l.level} has an unknown gate "${l.gate}".`);
    if (!isObj(l.criteria)) add(`Ladder level ${l.level}: criteria are missing, so no hike can complete it automatically.`);
    for (const ex of Array.isArray(l.examples) ? l.examples : []) if (isObj(ex) && ex.url && !isHttp(ex.url)) add(`Ladder level ${l.level}: example "${ex.name || ''}" has a non-http(s) link.`);
  }
  // Round 3 PM additions: weekend_plan [{week_start, name, minutes, level, notes, url}].
  // Round 4: an entry may give program_week (1–8, relative to the programme start) instead; it wins.
  const plan = [];
  if (h.weekend_plan !== undefined && !Array.isArray(h.weekend_plan)) add('weekend_plan should be a list.');
  for (const e of Array.isArray(h.weekend_plan) ? h.weekend_plan : []) {
    if (!isObj(e)) continue;
    const name = String(e.name || '').slice(0, 40);
    const hasPw = e.program_week !== undefined && e.program_week !== null;
    const pw = hasPw ? posInt(e.program_week) : null;
    if (hasPw && pw === null) add(`weekend_plan "${name}": program_week should be a whole number of at least 1 (ignored).`);
    if (pw === null && !isISO(e.week_start)) { add(`weekend_plan: "${name}" has no valid week_start (YYYY-MM-DD) or program_week (1–8).`); continue; }
    const x = { ...e };
    if (pw !== null) x.program_week = pw;
    else delete x.program_week;
    const where = pw !== null ? `week ${pw}` : e.week_start;
    if (x.url && !isHttp(x.url)) { add(`weekend_plan ${where}: the link is not http(s) and was dropped.`); x.url = ''; }
    if (x.level != null && !levels.has(x.level) && !levels.has(Number(x.level))) add(`weekend_plan ${where}: level ${x.level} is not on the ladder.`);
    plan.push(x);
  }
  const planKey = (e) => (e.program_week ? `0${String(e.program_week).padStart(4, '0')}` : `1${e.week_start}`);
  plan.sort((a, b) => (planKey(a) < planKey(b) ? -1 : planKey(a) > planKey(b) ? 1 : 0));
  return {
    ...h,
    ladder,
    kit: Array.isArray(h.kit) ? h.kit.filter((k) => isObj(k) && typeof k.item === 'string') : [],
    terrain_skills: Array.isArray(h.terrain_skills) ? h.terrain_skills.filter(isObj) : [],
    weekend_plan: plan,
  };
}

function cleanNutrition(n, add = () => {}) {
  if (!isObj(n)) return null;
  const out = {
    ...n,
    foods: Array.isArray(n.foods) ? n.foods.filter((f) => isObj(f) && typeof f.name === 'string') : [],
    meal_templates: Array.isArray(n.meal_templates) ? n.meal_templates.filter(isObj) : [],
    supplements: Array.isArray(n.supplements) ? n.supplements.filter((s) => isObj(s) && typeof s.name === 'string') : [],
    shopping_list: Array.isArray(n.shopping_list) ? n.shopping_list.filter(isObj) : [],
  };
  for (const f of out.foods) for (const k of ['kcal', 'protein_g']) if (f[k] != null && !Number.isFinite(Number(f[k]))) add(`Food "${f.name}": ${k} is not a number.`);
  for (const s of out.supplements) if (s.evidence && !['strong', 'moderate', 'weak', 'avoid'].includes(s.evidence)) add(`Supplement "${s.name}": unknown evidence level "${s.evidence}".`);
  return out;
}

function cleanArm(a, add = () => {}) {
  if (!isObj(a)) return null;
  const out = {
    ...a,
    red_flags: Array.isArray(a.red_flags) ? a.red_flags.filter((f) => isObj(f) && typeof f.id === 'string') : [],
    clinic_questions: Array.isArray(a.clinic_questions) ? a.clinic_questions.filter((q) => isObj(q) && typeof q.question === 'string') : [],
    healing_stages: Array.isArray(a.healing_stages) ? a.healing_stages.filter(isObj) : [],
    measurements: Array.isArray(a.measurements) ? a.measurements.filter((m) => isObj(m) && typeof m.id === 'string') : [],
    appointments_default: Array.isArray(a.appointments_default) ? a.appointments_default.filter(isObj) : [],
  };
  const flags = new Set(out.red_flags.map((f) => f.id));
  const missing = RED_FLAG_IDS.filter((id) => !flags.has(id));
  if (missing.length) add(`Safety: red flags missing from arm.json (${missing.join(', ')}); the check-in falls back to its built-in list.`);
  const ms = new Set(out.measurements.map((m) => m.id));
  const missingM = ARM_MEASUREMENT_IDS.filter((id) => !ms.has(id));
  if (missingM.length) add(`Measurements missing: ${missingM.join(', ')}.`);
  return out;
}

function cleanGuideIndex(g, add = () => {}) {
  if (!isObj(g)) return null;
  const files = new Set();
  const parts = (Array.isArray(g.parts) ? g.parts : []).filter(isObj).map((p) => ({
    title: typeof p.title === 'string' ? p.title : '',
    chapters: (Array.isArray(p.chapters) ? p.chapters : []).filter((c) => {
      if (!isObj(c)) return false;
      if (!isChapterFile(c.file)) { add(`Guide index: "${String(c.file).slice(0, 60)}" is not a valid chapter file name.`); return false; }
      if (files.has(c.file)) add(`Guide index: ${c.file} is listed twice.`);
      files.add(c.file);
      return true;
    }).map((c) => ({ file: c.file, title: typeof c.title === 'string' && c.title ? c.title : c.file })),
  }));
  return { title: typeof g.title === 'string' && g.title ? g.title : 'The guide', parts };
}

export function isChapterFile(f) {
  return typeof f === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]*\.md$/.test(f);
}

/** Run a cleaner without ever throwing: returns {value, problems}. */
function safely(fn, raw) {
  const add = problemList();
  try {
    return { value: fn(raw, add), problems: add.done() };
  } catch (e) {
    add(`Could not be read: ${String((e && e.message) || e)}`);
    return { value: null, problems: add.done(), failed: true };
  }
}

export async function loadContent({ fixtures = false } = {}) {
  content.fixtures = fixtures;
  content.base = fixtures ? '/dev-fixtures/' : '/content/';
  chapterCache.clear();
  const status = [];
  const entry = (r, label, valid, problems = []) => ({
    file: r.path,
    label,
    state: r.state === 'ok' && !valid ? 'invalid' : r.state,
    detail: r.state === 'ok' && !valid ? 'Does not match the expected shape yet.' : (r.detail || (problems.length ? `${problems.length} thing${problems.length > 1 ? 's' : ''} to check` : '')),
    problems,
  });
  const record = (r, label, valid, problems = []) => status.push(entry(r, label, valid, problems));
  try {
    const [program, merged, tests, hikes, nutrition, arm, guide] = await Promise.all([
      loadJSON('program.json'), loadJSON('exercises.json'), loadJSON('tests.json'), loadJSON('hikes.json'),
      loadJSON('nutrition.json'), loadJSON('arm.json'), loadJSON('guide/index.json'),
    ]);

    let exercises = [];
    let exProblems = [];
    if (merged.state === 'ok' && Array.isArray(merged.value)) {
      // The merged file is a build artefact of part-a + part-b. Read the parts too: if they
      // disagree (ids or gates), that is a safety problem, and the stricter gate wins per id.
      const [a, b] = await Promise.all([loadJSON('exercises/part-a.json'), loadJSON('exercises/part-b.json')]);
      const haveParts = Array.isArray(a.value) || Array.isArray(b.value);
      const parts = [...(Array.isArray(a.value) ? a.value : []), ...(Array.isArray(b.value) ? b.value : [])];
      const cmp = haveParts ? compareExerciseSources(merged.value, parts) : { same: true };
      const r = safely((list, addP) => {
        if (!cmp.same) {
          const bits = [];
          if (cmp.onlyMerged.length) bits.push(`only in exercises.json: ${cmp.onlyMerged.slice(0, 5).join(', ')}${cmp.onlyMerged.length > 5 ? '…' : ''}`);
          if (cmp.onlyParts.length) bits.push(`missing from exercises.json: ${cmp.onlyParts.slice(0, 5).join(', ')}${cmp.onlyParts.length > 5 ? '…' : ''}`);
          if (cmp.gateDiffs.length) bits.push(`different gates: ${cmp.gateDiffs.slice(0, 5).map((d) => `${d.id} (${d.merged} vs ${d.parts})`).join(', ')}${cmp.gateDiffs.length > 5 ? '…' : ''}`);
          addP(`Safety: exercises.json does not match part-a + part-b (${bits.join('; ')}). The hub uses every exercise from both, with the stricter gate for each.`);
        }
        return cleanExercises(cmp.same ? list : unionExercises(list, parts), addP);
      }, merged.value);
      exercises = r.value || [];
      exProblems = r.problems;
      record(merged, 'Exercises (merged)', !r.failed, r.problems);
      content.exerciseSources = { merged: true, parts: haveParts, same: cmp.same, compare: cmp.same ? null : cmp };
    } else {
      const [a, b] = await Promise.all([loadJSON('exercises/part-a.json'), loadJSON('exercises/part-b.json')]);
      const r = safely(cleanExercises, [...(Array.isArray(a.value) ? a.value : []), ...(Array.isArray(b.value) ? b.value : [])]);
      exercises = r.value || [];
      exProblems = r.problems;
      if (merged.state !== 'missing') record(merged, 'Exercises (merged)', false);
      record(a, 'Exercises part A', Array.isArray(a.value), exProblems);
      record(b, 'Exercises part B', Array.isArray(b.value));
      content.exerciseSources = { merged: false, parts: true, same: true, compare: null };
    }
    content.exercises = exercises.sort((x, y) => x.name.localeCompare(y.name));
    content.exById = new Map(content.exercises.map((e) => [e.id, e]));

    const prog = safely(cleanProgram, program.value);
    content.program = prog.value;
    const progProblems = content.program ? [...prog.problems, ...validateProgram(program.value, content.exById)] : prog.problems;
    status.unshift(entry(program, 'Program', !!content.program, progProblems)); // listed first, as before

    const t = safely(cleanTests, tests.value);
    content.tests = t.value || [];
    // Round 4: a first_phase that isn't a phase in program.json would never become due.
    const phaseIds = new Set((content.program?.phases || []).map((p) => p && p.id).filter(Boolean));
    const testProblems = content.program ? content.tests
      .filter((x) => typeof x.first_phase === 'string' && x.first_phase && !phaseIds.has(x.first_phase))
      .map((x) => `Test ${x.id}: first_phase "${x.first_phase}" is not a phase in program.json, so it never becomes due.`) : [];
    record(tests, 'Tests', Array.isArray(tests.value), [...t.problems, ...testProblems]);
    const hk = safely(cleanHikes, hikes.value);
    content.hikes = hk.value;
    record(hikes, 'Hikes', !!content.hikes, hk.problems);
    const nu = safely(cleanNutrition, nutrition.value);
    content.nutrition = nu.value;
    record(nutrition, 'Nutrition', !!content.nutrition, nu.problems);
    const am = safely(cleanArm, arm.value);
    content.arm = am.value;
    record(arm, 'Arm recovery', !!content.arm, am.problems);
    const gi = safely(cleanGuideIndex, guide.value);
    content.guideIndex = gi.value;
    record(guide, 'Guide index', !!content.guideIndex, gi.problems);
  } catch (e) {
    // Belt and braces: whatever happened above, the hub still boots with what it has.
    status.push({ file: '(all)', label: 'Content', state: 'error', detail: String((e && e.message) || e), problems: [] });
  }
  content.status = status;
  content.loadedAt = new Date();
  return content;
}

/** Every problem across the content files: [{file, label, message, safety}]. */
export function contentProblems(c = content) {
  return (Array.isArray(c.status) ? c.status : []).flatMap((s) => (Array.isArray(s.problems) ? s.problems : [])
    .map((message) => ({ file: s.file, label: s.label, message, safety: /^Safety:/.test(message) })));
}

/** Guide chapter text, or null if it has not been written yet. */
export async function loadChapter(file) {
  if (!isChapterFile(file)) return null;
  if (chapterCache.has(file)) return chapterCache.get(file);
  let text = null;
  try { text = await getText(`${content.base}guide/${file}`); } catch { text = null; }
  if (text !== null && !text.trim()) text = null;
  chapterCache.set(file, text);
  return text;
}

export function guideChapters() {
  return (content.guideIndex?.parts || []).flatMap((p) => p.chapters.map((c) => ({ ...c, part: p.title })));
}

export const exName = (id) => content.exById.get(id)?.name || (id === 'x-physio-programme' ? 'Your physio’s programme' : prettifyId(id));

export function prettifyId(id) {
  if (typeof id !== 'string' || !id) return 'Exercise';
  const s = id.replace(/^x-/, '').replace(/-/g, ' ');
  return s.charAt(0).toUpperCase() + s.slice(1);
}
