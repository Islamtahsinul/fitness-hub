// Plan helpers for the views (pure, no DOM): stable block keys, the round-3 week-override fields,
// which add-ons are shown, the alternate sessions, this weekend's route and the week's planned
// Zone 2 minutes. Scheduling itself lives in schedule.js; nothing here moves a phase or a date.

import * as schedule from '../schedule.js';
import * as stats from '../stats.js';
import { addDays, daysBetween, isISODate, mondayOf } from '../dates.js';
import { HOLD_RIR, effectiveRx, prescriptionFor } from './rx.js';

const isNum = (v) => v !== null && v !== undefined && v !== '' && typeof v !== 'boolean' && Number.isFinite(Number(v));
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

// ---------------------------------------------------------------- block keys (PE10)

/**
 * A stable key for each block of a session: the planned exercise id plus its occurrence in the
 * session ("leg-press:1", "circuit:1"). Logged entries keep it in `block`, so editing the
 * programme (adding, removing or reordering blocks) never attaches sets to the wrong exercise.
 */
export function blockKeys(blocks) {
  const seen = new Map();
  return (Array.isArray(blocks) ? blocks : []).map((b, i) => {
    const kind = b?.kind || schedule.blockKind(b?.raw || b);
    const base = kind === 'circuit' ? 'circuit' : (typeof b?.exercise === 'string' && b.exercise) ? b.exercise : `block${i}`;
    const n = (seen.get(base) || 0) + 1;
    seen.set(base, n);
    return `${base}:${n}`;
  });
}

/**
 * The logged entry for a block: matched by its stable key, or (older logs) by the positional
 * key "b<i>" when that entry is for the same planned exercise.
 */
export function findEntry(list, key, legacyKey, plannedExercise) {
  const arr = Array.isArray(list) ? list : [];
  const exact = arr.find((x) => x && x.block === key);
  if (exact) return exact;
  if (!legacyKey) return null;
  return arr.find((x) => x && x.block === legacyKey && !x.extra
    && (!plannedExercise || x.exercise === plannedExercise || x.swapped_from === plannedExercise || x.exercise === 'circuit')) || null;
}

// ---------------------------------------------------------------- week overrides (SPEC 5.2, round 3)

let overrideSupport = null;

/** Does schedule.resolveBlock already apply zone_cap / circuit_minutes / rounds? (Probed once.) */
function scheduleHandlesOverrides() {
  if (overrideSupport !== null) return overrideSupport;
  try {
    const c = schedule.resolveBlock({ circuit: { minutes: 30, items: [] }, zone: 'Z2' }, { week: 1, override: { circuit_minutes: 5 } });
    const iv = schedule.resolveBlock({ exercise: 'x', intervals: { work_s: 30, rest_s: 60, rounds: 6, work_zone: 'Z5' } }, { week: 1, override: { rounds: 3, zone_cap: 'Z3' } });
    overrideSupport = c?.circuit?.minutes === 5 && iv?.intervals?.rounds === 3 && iv?.intervals?.work_zone === 'Z3';
  } catch { overrideSupport = false; }
  return overrideSupport;
}

const zoneCapOf = (o) => {
  const m = /Z([1-5])/i.exec(String(o?.zone_cap ?? ''));
  return m ? Number(m[1]) : null;
};

function applyOverrideFields(rb, override) {
  if (!override || !rb) return rb;
  const cap = zoneCapOf(override);
  if (rb.kind === 'intervals' && rb.intervals) {
    if (isNum(override.rounds) && Number(override.rounds) > 0) {
      rb.roundsPlanned = rb.roundsPlanned ?? rb.intervals.rounds;
      rb.intervals.rounds = Math.round(Number(override.rounds));
    }
    if (cap) {
      const z = schedule.capZone(rb.intervals.work_zone || `Z${cap}`, cap);
      if (z !== rb.intervals.work_zone) { rb.workZonePlanned = rb.workZonePlanned || rb.intervals.work_zone; rb.intervals.work_zone = z; rb.zoneCapped = true; }
    }
    rb.easyMinutes = Math.round((rb.warmup_min || 0) + (rb.cooldown_min || 0) + (rb.intervals.rounds * ((rb.intervals.work_s || 0) + (rb.intervals.rest_s || 0))) / 60);
  }
  if ((rb.kind === 'cardio' || rb.kind === 'circuit') && cap && rb.zone) {
    const z = schedule.capZone(rb.zone, cap);
    if (z !== rb.zone) { rb.zonePlanned = rb.zonePlanned || rb.zone; rb.zone = z; rb.zoneCapped = true; }
  }
  if (rb.kind === 'circuit' && rb.circuit && isNum(override.circuit_minutes) && Number(override.circuit_minutes) > 0) {
    rb.circuit.minutes = Number(override.circuit_minutes);
  }
  return rb;
}

/**
 * schedule.resolveSession plus the round-3 override fields, whichever module applies them.
 * Easy days (amber, which includes fasting) show the hold RIR, 3–4 (SPEC 5.2 round 4, BT3-12):
 * applied here too until schedule.resolveBlock does it, and harmless once it does.
 */
export function resolveFor(session, { week = 1, override = null, easyDay = false, fasting = false } = {}) {
  let blocks = schedule.resolveSession(session, { week, override, easyDay, fasting });
  if (override && !scheduleHandlesOverrides()) blocks = blocks.map((rb) => applyOverrideFields(rb, override));
  if (easyDay || fasting) {
    for (const rb of blocks) {
      if ((rb.kind === 'strength' || rb.kind === 'timed') && rb.load !== 'physio' && rb.rir !== HOLD_RIR) {
        rb.rirPlanned = rb.rirPlanned ?? rb.rir;
        rb.rir = HOLD_RIR;
      }
    }
  }
  return blocks;
}

/** Intro weeks (the re-entry week, "build-in"): the first programme week, or an override labelled so. */
export function isIntroWeek(plan) {
  const label = String(plan?.override?.label || '');
  if (/\b(intro|learn|learning|build-in|primer|re-?entry|calibrat\w*)\b/i.test(label)) return true;
  return !!plan?.pos && plan.pos.phaseIndex === 0 && plan.pos.absWeek === 1;
}

/** The planned (template) week of the programme on a date: 1 for its first week; null before it. */
export function programWeekOn(data, date, program = null) {
  const start = program ? schedule.buildTimeline(program, data?.profile || {}).start : (isISODate(data?.profile?.program_start) ? mondayOf(data.profile.program_start) : null);
  if (!isISODate(start) || !isISODate(date) || date < start) return null;
  return Math.floor(daysBetween(start, mondayOf(date)) / 7) + 1;
}

// ---------------------------------------------------------------- add-ons (PM11)

const PHYSIO_ID = 'x-physio-programme';

/** The rehab add-on: id "rehab", or a session whose only work is the physio placeholder. */
export function isRehabAddon(entry, program = null) {
  if (!entry || entry.source !== 'addon') return false;
  if (typeof schedule.isRehabAddon === 'function' && entry.addon) {
    try { if (schedule.isRehabAddon(entry.addon, program)) return true; } catch { /* fall back */ }
  }
  if (entry.addon && entry.addon.id === 'rehab') return true;
  const blocks = Array.isArray(entry.session?.blocks) ? entry.session.blocks : [];
  return blocks.length > 0 && blocks.every((b) => b && b.exercise === PHYSIO_ID);
}

/** SPEC 5.2: the rehab add-on is shown and counted only once the physio's exercises are recorded. */
export function addonVisible(entry, data, program = null) {
  if (entry && entry.source === 'addon' && entry.addon && typeof schedule.addonVisible === 'function') {
    try { return !!schedule.addonVisible(entry.addon, data, program); } catch { /* fall back */ }
  }
  if (!isRehabAddon(entry, program)) return true;
  const list = data?.arm?.physio_exercises;
  return Array.isArray(list) && list.some((p) => p && String(p.exercise || '').trim());
}

/** plannedOn() with the add-on visibility rule applied. */
export function planOn(program, data, date, timeline = undefined) {
  const tl = timeline || schedule.buildTimeline(program, data.profile);
  const plan = schedule.plannedOn(program, data.profile, date, tl, { data });
  return { ...plan, sessions: plan.sessions.filter((e) => addonVisible(e, data, program)) };
}

// ---------------------------------------------------------------- alternates (PM7)

/** {short, travel}: ids of the alternate sessions that exist in the programme (either may be null). */
export function alternates(program) {
  if (typeof schedule.alternatesOf === 'function') {
    try { const r = schedule.alternatesOf(program); if (r && typeof r === 'object') return { short: r.short || null, travel: r.travel || null }; } catch { /* fall back */ }
  }
  const a = isObj(program?.alternates) ? program.alternates : {};
  const ok = (id) => (typeof id === 'string' && id && isObj(program?.sessions?.[id]) ? id : null);
  return { short: ok(a.short), travel: ok(a.travel) };
}

// ---------------------------------------------------------------- this weekend's route (PM8)

const programWeekOf = (w) => (isObj(w) && isNum(w.program_week) && Number(w.program_week) >= 1 ? Math.floor(Number(w.program_week)) : null);

/**
 * The Monday a weekend_plan entry belongs to. SPEC 5.2 round 4: `program_week` (1-8, relative to
 * the programme start) takes precedence over `week_start`.
 */
export function weekendWeekStart(entry, start) {
  const pw = programWeekOf(entry);
  if (pw && isISODate(start)) return addDays(mondayOf(start), (pw - 1) * 7);
  return isObj(entry) && isISODate(entry.week_start) ? mondayOf(entry.week_start) : null;
}

/** The Saturday of an entry's week (the long-walk day). */
export const weekendDate = (entry, start) => { const m = weekendWeekStart(entry, start); return m ? addDays(m, 5) : null; };

/**
 * hikes.json weekend_plan entry for the week containing `date` (Monday-based), or null.
 * `start`: the programme start (needed for program_week entries).
 */
export function weekendPlanFor(hikes, date, { start = null } = {}) {
  const list = Array.isArray(hikes?.weekend_plan) ? hikes.weekend_plan.filter(isObj) : [];
  if (!isISODate(date)) return null;
  const mon = mondayOf(date);
  // stats.weekendPlanOn knows program_week once it takes the programme start (round 4).
  if (typeof stats.weekendPlanOn === 'function' && typeof stats.nextWeekendPlanOn === 'function') {
    try { return stats.weekendPlanOn(hikes, date, isISODate(start) ? { start } : {}) || null; } catch { /* fall back */ }
  }
  if (list.some((w) => programWeekOf(w)) && isISODate(start)) {
    return list.find((w) => weekendWeekStart(w, start) === mon) || null;
  }
  if (typeof stats.weekendPlanOn === 'function') {
    try { return stats.weekendPlanOn(hikes, date) || null; } catch { /* fall back */ }
  }
  return list.find((w) => isISODate(w.week_start) && mondayOf(w.week_start) === mon) || null;
}

/** The next weekend_plan entry on or after the week containing `date`. */
export function nextWeekendPlan(hikes, date, { start = null } = {}) {
  if (typeof stats.nextWeekendPlanOn === 'function') {
    try { return stats.nextWeekendPlanOn(hikes, date, isISODate(start) ? { start } : {}) || null; } catch { /* fall back */ }
  }
  const list = Array.isArray(hikes?.weekend_plan) ? hikes.weekend_plan.filter(isObj) : [];
  const mon = isISODate(date) ? mondayOf(date) : null;
  if (!mon) return null;
  const useStart = list.some((w) => programWeekOf(w)) && isISODate(start) ? start : null;
  return list.map((w) => ({ w, m: weekendWeekStart(w, useStart) })).filter((x) => x.m && x.m >= mon)
    .sort((a, b) => (a.m < b.m ? -1 : a.m > b.m ? 1 : 0))[0]?.w || null;
}

// ---------------------------------------------------------------- planned Zone 2 (CL6)

export const isZ2 = (zone) => typeof zone === 'string' && /Z2/i.test(zone);

/**
 * Zone 2 minutes the programme plans for days [from, to] (overrides applied, no easy-day change).
 * Optionally skips sessions already logged (doneOn(date, sessionId) -> true).
 */
export function plannedZone2(program, data, from, to, { timeline = null, doneOn = null } = {}) {
  if (!program || !isISODate(from) || !isISODate(to)) return 0;
  const tl = timeline || schedule.buildTimeline(program, data.profile);
  let total = 0;
  for (let d = from; d <= to; d = addDays(d, 1)) {
    const plan = planOn(program, data, d, tl);
    const week = plan.pos?.week || 1;
    for (const e of plan.sessions) {
      if (e.isRest && !e.session) continue;
      if (!e.session || (doneOn && doneOn(d, e.sessionId))) continue;
      for (const rb of resolveFor(e.session, { week, override: plan.override, easyDay: false })) {
        if (rb.kind === 'cardio' && isZ2(rb.zone) && isNum(rb.minutes)) total += Number(rb.minutes);
        else if (rb.kind === 'circuit' && isZ2(rb.zone) && isNum(rb.circuit?.minutes)) total += Number(rb.circuit.minutes);
      }
    }
  }
  return total;
}

/** Planned Zone 2 minutes for the Monday-to-Sunday week starting `weekStart`. */
export function plannedZone2Week(program, data, weekStart, opts = {}) {
  return plannedZone2(program, data, weekStart, addDays(weekStart, 6), opts);
}

/**
 * The week's Zone 2, from one place for Today, Review, Print and the coach notes (BT3-14):
 * {planned, done, target, weekStart, end}. `planned` is the programme's Zone 2 minutes that week
 * (overrides applied); `done` counts up to min(week end, today). Without a programme, the phase
 * target is unknown and `target` is null.
 */
export function zone2Week(program, data, weekStart, { today = null, timeline = null } = {}) {
  const end = addDays(weekStart, 6);
  const upTo = isISODate(today) && today < end ? today : end;
  const planned = program ? plannedZone2Week(program, data, weekStart, { timeline }) : 0;
  const done = upTo >= weekStart ? stats.zone2Minutes(data, weekStart, upTo) : 0;
  return { planned, done, target: planned > 0 ? planned : null, weekStart, end };
}

// ---------------------------------------------------------------- planned sets of an earlier log (SPEC 5.2 round 4)

/**
 * How many sets an earlier log planned for an entry: entry.planned.sets when it was stored;
 * otherwise the effective sets recomputed for that log's date (its phase week's override, and
 * easy-day halving when the log was an easy day; a swapped-in exercise's own dose). null when it
 * can't be worked out (an ad-hoc session, an added exercise, an edited programme).
 */
export function plannedSetsOfLog(program, data, workout, entry) {
  const p = isObj(entry?.planned) ? entry.planned : null;
  if (p && isNum(p.sets) && Number(p.sets) >= 1) return Math.round(Number(p.sets));
  if (typeof stats.effectivePrescription === 'function' && isObj(workout) && isObj(entry)) {
    try {
      const e = stats.effectivePrescription(workout, entry, { program, data });
      if (e && e.source !== 'rows' && isNum(e.sets) && Number(e.sets) >= 1) return Math.round(Number(e.sets));
    } catch { /* fall back */ }
  }
  if (!program || !isObj(workout) || !isObj(entry) || entry.extra) return null;
  const session = program.sessions && isObj(program.sessions[workout.session_id]) ? program.sessions[workout.session_id] : null;
  if (!session) return null;
  let week = isNum(workout.phase_week) ? Number(workout.phase_week) : null;
  const phase = (Array.isArray(program.phases) ? program.phases : []).find((ph) => ph && ph.id === workout.phase_id) || null;
  let override = null;
  if (phase && week) override = schedule.weekOverride(phase, week);
  else if (isISODate(workout.date) && data) {
    const plan = planOn(program, data, workout.date);
    week = plan.pos?.week || 1;
    override = plan.override;
  }
  const easyDay = workout.easy_day === true;
  const blocks = resolveFor(session, { week: week || 1, override, easyDay });
  const keys = blockKeys(blocks);
  let i = keys.indexOf(entry.block);
  if (i < 0 && /^b\d+$/.test(String(entry.block || ''))) i = Number(String(entry.block).slice(1));
  const rb = blocks[i];
  if (!rb || (rb.kind !== 'strength' && rb.kind !== 'timed')) return null;
  if (entry.swapped_from && entry.exercise !== rb.exercise) {
    const rx = effectiveRx(prescriptionFor(entry.exercise), { override, easyDay });
    return rx ? rx.sets : rb.sets;
  }
  return rb.exercise === entry.exercise ? rb.sets : null;
}

/**
 * The planned sets of the log `last` came from (stats.lastPerformance's result), for the exercise
 * `exId`: what "every planned set" means for the progression suggestion. null when unknown.
 */
export function lastPlannedSets(program, data, last, exId) {
  if (!last || !data) return null;
  if (isNum(last.plannedSets)) return Number(last.plannedSets);
  if (isObj(last.entry)) return plannedSetsOfLog(program, data, last.workout || null, last.entry);
  const w = (Array.isArray(data.workouts) ? data.workouts : []).find((x) => x && x.id === last.workoutId) || null;
  if (!w) return null;
  const entry = (Array.isArray(w.exercises) ? w.exercises : []).find((e) => e && e.exercise === exId) || null;
  return entry ? plannedSetsOfLog(program, data, w, entry) : null;
}
