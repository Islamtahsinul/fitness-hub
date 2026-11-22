// Derived statistics over the user's data. Pure functions (no DOM), shared by views and tests.

import { addDays, daysBetween, isISODate, mondayOf, weekDates } from './dates.js';
import {
  buildTimeline, plannedOn, positionOn, isGateMet, alternateIds, addonSessionIds, isPerformedSet, blockKeysOf, blockKind,
  resolveBlock, resolveSession, plannedFromBlock, weekOverride, parseRepRange, programStart,
} from './schedule.js';
import { isNum, num, mean, e1rm, proteinTargets, trailingMean, readinessOn, redDays, fastingPeriods } from './calc.js';

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

export const isDone = (w) => !!w && w.status !== 'draft';

export function doneWorkouts(data) {
  return (Array.isArray(data?.workouts) ? data.workouts : []).filter(isDone);
}

export function indexWorkouts(data) {
  const byDate = new Map();
  for (const w of doneWorkouts(data)) {
    if (!isISODate(w.date)) continue;
    if (!byDate.has(w.date)) byDate.set(w.date, []);
    byDate.get(w.date).push(w);
  }
  return byDate;
}

export function checkinOn(data, date) {
  return (Array.isArray(data?.checkins) ? data.checkins : []).find((c) => c && c.date === date) || null;
}

export function checkinsBetween(data, start, end) {
  return (Array.isArray(data?.checkins) ? data.checkins : []).filter((c) => c && isISODate(c.date) && c.date >= start && c.date <= end);
}

/** Most recent numeric value of a check-in field on or before a date: {date, value} or null. */
export function latestValue(data, field, onOrBefore = '9999-12-31') {
  let best = null;
  for (const c of Array.isArray(data?.checkins) ? data.checkins : []) {
    if (!c || !isISODate(c.date) || c.date > onOrBefore || !isNum(c[field])) continue;
    if (!best || c.date > best.date) best = { date: c.date, value: Number(c[field]) };
  }
  return best;
}

/** [{date, value}] for a field, oldest first. Round 3 (QA6): {from, to} bound it (pass to: today). */
export function series(data, field, collection = 'checkins', { from = null, to = null } = {}) {
  return (Array.isArray(data?.[collection]) ? data[collection] : [])
    .filter((c) => c && isISODate(c.date) && isNum(c[field]) && (!from || c.date >= from) && (!to || c.date <= to))
    .map((c) => ({ date: c.date, value: Number(c[field]) }))
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

/** series() that never includes entries dated after `until` (for Today's trends and averages). */
export function seriesUntil(data, field, until, collection = 'checkins') {
  return series(data, field, collection, { to: until });
}

export function sessionType(w, program) {
  if (w && typeof w.session_type === 'string' && w.session_type) return w.session_type;
  const s = program?.sessions?.[w?.session_id];
  if (s && typeof s.type === 'string') return s.type;
  if (Array.isArray(w?.exercises) && w.exercises.length) return 'strength';
  if (Array.isArray(w?.cardio) && w.cardio.length) return 'cardio';
  return 'other';
}

export const isZ2 = (zone) => typeof zone === 'string' && /Z2/i.test(zone);

/** Zone 2 minutes: workout cardio rows tagged Z2 plus logged hikes not linked to a workout. */
export function zone2Minutes(data, start, end) {
  let total = 0;
  for (const w of doneWorkouts(data)) {
    if (!isISODate(w.date) || w.date < start || w.date > end) continue;
    for (const c of Array.isArray(w.cardio) ? w.cardio : []) if (c && isZ2(c.zone) && isNum(c.minutes)) total += Number(c.minutes);
  }
  for (const h of Array.isArray(data?.hikes) ? data.hikes : []) {
    if (h && isISODate(h.date) && h.date >= start && h.date <= end && !h.workout_id && isNum(h.duration_min)) total += Number(h.duration_min);
  }
  return total;
}

const programSets = new WeakMap();
/** {alternates, addonSessions} id sets for a program, memoised per program object. */
function sessionSets(program) {
  if (!program || typeof program !== 'object') return { alternates: new Set(), addonSessions: new Set() };
  let v = programSets.get(program);
  if (!v) { v = { alternates: alternateIds(program), addonSessions: addonSessionIds(program) }; programSets.set(program, v); }
  return v;
}

/**
 * The role of each done workout on a day (SPEC 5.2 round 3 counting rules):
 * 'main' (a planned template session, matched by session_id; each planned entry once),
 * 'repeat' (the same planned session logged again), 'alternate' (program.alternates: counts as
 * a session done, never as the planned strength session), 'addon' (an add-on's session: never
 * counts towards strength sessions or adherence) or 'extra' (ad-hoc or unplanned sessions).
 */
export function workoutRoles(workouts, main, program) {
  const { alternates, addonSessions } = sessionSets(program);
  const open = (Array.isArray(main) ? main : []).map((m) => m.sessionId);
  const planned = new Set(open);
  return (Array.isArray(workouts) ? workouts : []).map((w) => {
    const id = w?.session_id;
    const k = open.indexOf(id);
    if (k >= 0) { open.splice(k, 1); return { workout: w, role: 'main' }; }
    if (planned.has(id)) return { workout: w, role: 'repeat' };
    if (alternates.has(id)) return { workout: w, role: 'alternate' };
    if (addonSessions.has(id)) return { workout: w, role: 'addon' };
    return { workout: w, role: 'extra' };
  });
}

/** A logged hike counts as a planned long walk or hike once it lasts this share of the planned minutes. */
export const HIKE_COVERS_SHARE = 0.7;

const dayIndexes = new WeakMap();
/**
 * Per-ctx indexes for dayInfo (built once per ctx, so a streak over years stays O(n)): hikes by
 * date, the RED dates (calc.redDays: red flags, arm pain 7+, arm-log pain 7+) and the fasting periods.
 */
function dayIndexOf(ctx) {
  let idx = dayIndexes.get(ctx);
  if (idx) return idx;
  const data = isObj(ctx.data) ? ctx.data : {};
  const hikes = new Map();
  for (const h of Array.isArray(data.hikes) ? data.hikes : []) {
    if (!h || typeof h !== 'object' || !isISODate(h.date)) continue;
    if (!hikes.has(h.date)) hikes.set(h.date, []);
    hikes.get(h.date).push(h);
  }
  const prof = isObj(ctx.profile) && Array.isArray(ctx.profile.fasting_periods) ? ctx.profile : data.profile;
  idx = { hikes, red: redDays(data), fasting: fastingPeriods(prof || {}) };
  dayIndexes.set(ctx, idx);
  return idx;
}

/** A planned session that a logged hike can stand in for: type "hike" (the long walk and the hikes). */
export function isHikeSession(entry) {
  const t = entry?.session?.type;
  if (typeof t === 'string' && t) return t === 'hike';
  return typeof entry?.sessionId === 'string' && /(^|-)(hike|walk)(-|$)/.test(entry.sessionId);
}

/** Planned minutes of a hike-type session that day (its cardio blocks; else duration_min), or null. */
export function plannedHikeMinutes(entry, plan) {
  const s = entry?.session;
  if (!s || typeof s !== 'object') return null;
  const total = resolveSession(s, { week: plan?.pos?.week || 1, override: plan?.override || null })
    .filter((b) => b.kind === 'cardio' && isNum(b.minutes)).reduce((n, b) => n + Number(b.minutes), 0);
  if (total > 0) return total;
  return isNum(s.duration_min) && Number(s.duration_min) > 0 ? Number(s.duration_min) : null;
}

/** Does a logged hike cover a planned hike of `planned` minutes (>= 70%; any hike when unknown)? */
export function hikeCovers(hike, planned) {
  if (!hike || typeof hike !== 'object') return false;
  if (!isNum(planned) || Number(planned) <= 0) return true;
  return isNum(hike.duration_min) && Number(hike.duration_min) >= HIKE_COVERS_SHARE * Number(planned) - 1e-9;
}

/**
 * One day of the plan against what was logged. Round 3:
 * - mainDone counts planned sessions done with their own session_id (QA5: an ad-hoc walk does
 *   not complete Strength A); add-ons never count.
 * - altDone: alternate sessions logged; mainCovered = planned sessions done or stood in for by an
 *   alternate ("never miss twice"), which is what `status` uses (viaAlternate says so).
 * - The rehab add-on is listed (and counted) only once data.arm.physio_exercises is filled in.
 * Round 4 (SPEC 5.2):
 * - BT1-4: a logged hike (data.hikes) on a day whose planned session is a long walk or hike counts
 *   as that session done when it lasts at least 70% of the planned minutes. It is counted once:
 *   never on top of a workout for the same session, one hike per planned session, and a hike
 *   linked to a workout that already counts never covers a second one. `hikeDone` counts them
 *   (they are included in mainDone), `viaHike` / `hikes` say which.
 * - BT2-9: RED days and fasting easy days are neutral (`neutral`: 'red' | 'fasting' | null).
 *   Their unfinished planned sessions are `excused` (past days, and today once it is RED): the
 *   day's status is 'neutral' instead of 'missed', it never breaks a streak, and the excused
 *   sessions are left out of adherence. `plannedCounted` = planned sessions minus the excused.
 */
export function dayInfo(ctx, date) {
  const { program, profile, today } = ctx;
  const timeline = ctx.timeline || buildTimeline(program, profile);
  const byDate = ctx.byDate || indexWorkouts(ctx.data);
  const plan = plannedOn(program, profile, date, timeline, { data: ctx.data || {} });
  const main = plan.sessions.filter((s) => s.source === 'template' && !s.isRest);
  const addons = plan.sessions.filter((s) => s.source === 'addon');
  const workouts = byDate.get(date) || [];
  const roles = workoutRoles(workouts, main, program);
  const idx = dayIndexOf(ctx);
  // BT1-4: hikes stand in for the planned long walks / hikes no workout covered.
  const coveredBy = new Map();
  const linked = new Set();
  for (const r of roles) {
    if (r.role !== 'main') continue;
    coveredBy.set(r.workout.session_id, (coveredBy.get(r.workout.session_id) || 0) + 1);
    if (r.workout.id != null) linked.add(r.workout.id);
  }
  const dayHikes = (idx.hikes.get(date) || []).filter((h) => !(h.workout_id != null && linked.has(h.workout_id)));
  const viaHikes = [];
  for (const m of main) {
    const n = coveredBy.get(m.sessionId) || 0;
    if (n > 0) { coveredBy.set(m.sessionId, n - 1); continue; }
    if (!isHikeSession(m) || !dayHikes.length) continue;
    const need = plannedHikeMinutes(m, plan);
    const h = dayHikes.find((x) => !viaHikes.includes(x) && hikeCovers(x, need));
    if (h) viaHikes.push(h);
  }
  const hikeDone = viaHikes.length;
  const mainDone = roles.filter((r) => r.role === 'main').length + hikeDone;
  const altDone = roles.filter((r) => r.role === 'alternate').length;
  const mainCovered = Math.min(main.length, mainDone + altDone);
  const addonDone = addons.filter((a) => workouts.some((w) => w.session_id === a.sessionId)).length;
  // BT2-9: RED and fasting days are neutral.
  const neutral = idx.red.has(date) ? 'red' : idx.fasting.some((p) => p.start <= date && date <= p.end) ? 'fasting' : null;
  const settled = isISODate(today) && (date < today || (date === today && neutral === 'red'));
  const excused = neutral && settled ? main.length - mainCovered : 0;
  let status;
  if (!main.length) status = workouts.length ? 'done' : 'rest';
  else if (mainCovered >= main.length) status = 'done';
  else if (mainCovered > 0) status = 'partial';
  else if (excused > 0) status = 'neutral';
  else if (date < today) status = 'missed';
  else if (date === today) status = 'today';
  else status = 'planned';
  return {
    date, plan, main, addons, workouts, roles, mainDone, altDone, mainCovered, viaAlternate: mainCovered > mainDone,
    hikeDone, viaHike: hikeDone > 0, hikes: viaHikes, neutral, excused, plannedCounted: main.length - excused,
    addonDone, status, inProgram: !!plan.pos,
  };
}

export function makeCtx({ program, profile, data, today }) {
  return { program, profile, data, today, timeline: buildTimeline(program, profile, { today }), byDate: indexWorkouts(data) };
}

/**
 * Week figures for Monday weekStart. Round 3:
 * - Everything done or measured is counted up to min(week end, today) only (QA6).
 * - strengthDone counts strength sessions that are planned or your own (roles 'main' / 'extra');
 *   add-ons, alternates and repeats of the same planned session never count (QA3).
 * - mainDone / adherencePct count planned (template) sessions done, an alternate standing in for
 *   one included (PM7); mainDoneStrict leaves alternates out; altDone counts them.
 * Round 4 (BT2-9 / BT1-4): a logged hike covering the long walk counts as that session done
 * (hikeDone). The planned sessions RED and fasting days excused are left out of mainPlanned and
 * mainPlannedToDate (so of adherence): mainExcused counts them, mainPlannedRaw is every planned
 * session, neutralDays the days with excused sessions.
 */
export function weekSummary(ctx, weekStart) {
  const { program, profile, data, today } = ctx;
  const end = addDays(weekStart, 6);
  const upTo = isISODate(today) && today < end ? today : end;
  const days = weekDates(weekStart).map((d) => dayInfo(ctx, d));
  const posDate = today >= weekStart && today <= end ? today : weekStart;
  const pos = positionOn(ctx.timeline, posDate) || positionOn(ctx.timeline, end);
  const targets = pos?.phase?.weekly_targets && typeof pos.phase.weekly_targets === 'object' ? pos.phase.weekly_targets : {};
  const counted = days.filter((d) => d.date <= upTo);
  const inWeek = counted.flatMap((d) => d.workouts);
  const strengthDone = counted.reduce((n, d) => n + d.roles.filter((r) => (r.role === 'main' || r.role === 'extra') && sessionType(r.workout, program) === 'strength').length, 0);
  const strengthPlanned = days.reduce((n, d) => n + d.main.filter((s) => s.session?.type === 'strength').length, 0);
  const checkins = upTo >= weekStart ? checkinsBetween(data, weekStart, upTo) : [];
  const weight = latestValue(data, 'weight_kg', upTo);
  const prot = weight ? proteinTargets(weight.value, profile?.protein_g_per_kg) : null;
  const proteinTarget = prot ? Math.round(prot.target) : null;
  const sum = (key, list = days) => list.reduce((n, d) => n + d[key], 0);
  const mainPlannedRaw = days.reduce((n, d) => n + d.main.length, 0);
  const mainExcused = sum('excused');
  const mainPlanned = mainPlannedRaw - mainExcused;
  const mainDone = sum('mainCovered', counted);
  const pastDays = days.filter((d) => d.date <= today);
  const mainPlannedToDate = pastDays.reduce((n, d) => n + d.main.length - d.excused, 0);
  const mainDoneToDate = sum('mainCovered', pastDays);
  const pct = (a, b) => (b ? Math.round((100 * a) / b) : null);
  return {
    weekStart, end, days, pos, targets,
    strengthDone, strengthPlanned, strengthTarget: isNum(targets.strength_sessions) ? Number(targets.strength_sessions) : strengthPlanned,
    mainDoneStrict: sum('mainDone', counted), altDone: sum('altDone', counted),
    z2Min: upTo >= weekStart ? zone2Minutes(data, weekStart, upTo) : 0,
    z2Target: isNum(targets.zone2_min) ? Number(targets.zone2_min) : null,
    stepsAvg: mean(checkins.map((c) => c.steps)),
    stepsTarget: isNum(targets.steps_avg) ? Number(targets.steps_avg) : null,
    longTarget: isNum(targets.long_session_min) ? Number(targets.long_session_min) : null,
    proteinTarget,
    proteinDays: proteinTarget ? checkins.filter((c) => isNum(c.protein_g) && Number(c.protein_g) >= proteinTarget).length : 0,
    proteinLogged: checkins.filter((c) => isNum(c.protein_g)).length,
    mainPlanned, mainDone, adherencePct: pct(mainDone, mainPlanned),
    mainPlannedToDate, mainDoneToDate, adherenceToDatePct: pct(mainDoneToDate, mainPlannedToDate),
    mainPlannedRaw, mainExcused, neutralDays: days.filter((d) => d.excused > 0).length, hikeDone: sum('hikeDone', counted),
    addonPlanned: days.reduce((n, d) => n + d.addons.length, 0), addonDone: sum('addonDone', counted),
    sleepAvg: mean(checkins.map((c) => c.sleep_h)),
    rhrAvg: mean(checkins.map((c) => c.rhr)),
    armPainAvg: mean(checkins.map((c) => c.arm_pain)),
    armPainMax: checkins.filter((c) => isNum(c.arm_pain)).reduce((m, c) => Math.max(m, Number(c.arm_pain)), -1),
    checkinCount: checkins.length,
    workouts: inWeek,
  };
}

/** Weight change across a week: 7-day mean at the week's end minus the 7 days before it. */
export function weightChange(data, end) {
  const pts = series(data, 'weight_kg');
  const now = trailingMean(pts, end, 7);
  const before = trailingMean(pts, addDays(end, -7), 7);
  return now !== null && before !== null ? now - before : null;
}

/**
 * Days in a row on plan: trained on planned days, rested on planned rest days. Today counts
 * once it is done; before the program starts only days with a logged session count.
 * There is no artificial cap (the old 400-day limit broke multi-year streaks): the walk stops
 * at the first off-plan day, and never goes back past the program start or first workout.
 * Round 4 (BT2-9): neutral days (RED, or a fasting day you didn't train) are skipped: they
 * neither add to the streak nor break it. A hike covering the long walk counts as training.
 */
export function streak(ctx) {
  const { today } = ctx;
  if (!isISODate(today)) return 0;
  const byDate = ctx.byDate || indexWorkouts(ctx.data);
  const c = ctx.byDate ? ctx : { ...ctx, byDate, timeline: ctx.timeline || buildTimeline(ctx.program, ctx.profile) };
  let floor = c.timeline?.start && c.timeline.start < today ? c.timeline.start : today;
  for (const d of byDate.keys()) if (d < floor) floor = d;
  let count = 0;
  let trained = 0;
  const first = dayInfo(c, today);
  if (first.status === 'done' || first.status === 'partial') { count++; trained++; }
  for (let d = addDays(today, -1); d >= floor; d = addDays(d, -1)) {
    const info = dayInfo(c, d);
    if (!info.inProgram && !info.workouts.length) break;
    if (info.status === 'neutral') continue;
    const ok = info.status === 'done' || info.status === 'partial' || (info.status === 'rest' && info.inProgram);
    if (!ok) break;
    count++;
    if (info.workouts.length || info.hikeDone) trained++;
  }
  return trained ? count : 0;
}

// ---------------------------------------------------------- exercises

export function setsFor(w, exerciseId) {
  const out = [];
  for (const e of Array.isArray(w?.exercises) ? w.exercises : []) {
    if (!e || e.exercise !== exerciseId) continue;
    for (const s of Array.isArray(e.sets) ? e.sets : []) if (s && s.done !== false) out.push(s);
  }
  return out;
}

/** Every set row of an exercise in a workout, undone ones included (the planned sets). */
export function setRowsFor(w, exerciseId) {
  const out = [];
  for (const e of Array.isArray(w?.exercises) ? w.exercises : []) {
    if (!e || e.exercise !== exerciseId) continue;
    for (const s of Array.isArray(e.sets) ? e.sets : []) if (s && typeof s === 'object') out.push(s);
  }
  return out;
}

export function cardioFor(w, exerciseId) {
  return (Array.isArray(w?.cardio) ? w.cardio : []).filter((c) => c && c.exercise === exerciseId);
}

/** Per-session bests for one exercise, oldest first. */
export function exerciseHistory(data, exerciseId) {
  const rows = [];
  for (const w of doneWorkouts(data)) {
    const sets = setsFor(w, exerciseId).filter((s) => isNum(s.reps) || isNum(s.seconds) || isNum(s.kg));
    const cardio = cardioFor(w, exerciseId);
    if (!sets.length && !cardio.length) continue;
    const e1 = sets.map((s) => e1rm(s.kg, s.reps)).filter(isNum);
    rows.push({
      date: w.date,
      workoutId: w.id,
      sets,
      bestE1rm: e1.length ? Math.max(...e1) : null,
      topKg: sets.some((s) => isNum(s.kg)) ? Math.max(...sets.filter((s) => isNum(s.kg)).map((s) => Number(s.kg))) : null,
      bestReps: sets.some((s) => isNum(s.reps)) ? Math.max(...sets.filter((s) => isNum(s.reps)).map((s) => Number(s.reps))) : null,
      bestSeconds: sets.some((s) => isNum(s.seconds)) ? Math.max(...sets.filter((s) => isNum(s.seconds)).map((s) => Number(s.seconds))) : null,
      volume: sets.reduce((v, s) => v + (num(s.kg) || 0) * (num(s.reps) || 0), 0),
      minutes: cardio.reduce((m, c) => m + (num(c.minutes) || 0), 0) || null,
    });
  }
  return rows.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

// ---------------------------------------------------------- last time: the effective prescription (round 4)

const STABLE_KEY = /:\d+$/;
const POSITIONAL_KEY = /^b(\d+)$/;
/** Every set row of one logged entry (undone ones included). */
const entryRows = (e) => (Array.isArray(e?.sets) ? e.sets : []).filter((s) => s && typeof s === 'object');
/** The rows that hold numbers and weren't undone (what "last time" shows). */
const entrySets = (e) => entryRows(e).filter((s) => s.done !== false && (isNum(s.reps) || isNum(s.seconds) || isNum(s.kg)));
/** The exercise an entry was planned as: the swapped-out one for a swap. */
const plannedIdOf = (e) => (typeof e?.swapped_from === 'string' && e.swapped_from ? e.swapped_from : e?.exercise);

/**
 * Where a logged entry sits in its session: {key, index}. key is the stable block key
 * ("leg-press:1"); index is the block's position in the program session (-1 when the program
 * isn't known or no longer has it). Stable keys are used as they are; older positional keys
 * ("b0") are mapped through the program session (only when that block plans the same exercise);
 * entries without a key use the planned exercise's occurrence in the workout. Added exercises
 * (extra, "x…" keys) have no block: null.
 */
export function entryBlock(workout, entry, { program = null, list = null } = {}) {
  if (!entry || typeof entry !== 'object' || entry.extra) return null;
  const session = isObj(program?.sessions?.[workout?.session_id]) ? program.sessions[workout.session_id] : null;
  const blocks = Array.isArray(session?.blocks) ? session.blocks : null;
  const keys = blocks ? blockKeysOf(blocks) : null;
  const b = typeof entry.block === 'string' ? entry.block.trim() : '';
  if (b && STABLE_KEY.test(b)) return { key: b, index: keys ? keys.indexOf(b) : -1 };
  const planned = plannedIdOf(entry);
  const m = POSITIONAL_KEY.exec(b);
  if (m && blocks) {
    const i = Number(m[1]);
    const blk = blocks[i];
    const same = blk && (blk.exercise === planned || (entry.exercise === 'circuit' && blockKind(blk) === 'circuit'));
    return same ? { key: keys[i], index: i } : null;
  }
  if (b && !m) return null;
  const siblings = (Array.isArray(list) ? list : []).filter((x) => x && typeof x === 'object' && !x.extra && plannedIdOf(x) === planned);
  const n = siblings.indexOf(entry) + 1;
  if (n < 1) return null;
  const key = `${entry.exercise === 'circuit' ? 'circuit' : planned}:${n}`;
  return { key, index: keys ? keys.indexOf(key) : -1 };
}

/** entry.planned (round 4 logs) as {sets, reps, rir, seconds, load, source: 'stored'}, or null. */
function storedPrescription(e) {
  const p = isObj(e?.planned) ? e.planned : null;
  if (!p || !isNum(p.sets) || Number(p.sets) < 1) return null;
  return {
    sets: Math.floor(Number(p.sets)), reps: p.reps != null && p.reps !== '' ? String(p.reps) : null, rir: p.rir != null ? String(p.rir) : '',
    seconds: isNum(p.seconds) ? Number(p.seconds) : null, load: typeof p.load === 'string' ? p.load : '', source: 'stored',
  };
}

/** The week (and override) a workout was planned in: its own phase_id / phase_week, else the timeline. */
function weekOfWorkout(w, env) {
  const phases = Array.isArray(env.program?.phases) ? env.program.phases : [];
  const n = isNum(w.phase_week) ? Math.floor(Number(w.phase_week)) : 0;
  const ph = typeof w.phase_id === 'string' && w.phase_id ? phases.find((p) => p && p.id === w.phase_id) : null;
  if (ph && n >= 1) return { week: n, override: weekOverride(ph, n) };
  const pos = positionOn(env.timeline(), w.date);
  return pos ? { week: pos.week, override: weekOverride(pos.phase, pos.week) } : { week: 1, override: null };
}

/** Whether easy-day mode applied to a workout: the saved choice, else readiness on its date (AMBER, which includes fasting). */
function easyOfWorkout(w, env) {
  if (typeof w.easy_choice === 'boolean') return w.easy_choice;
  if (typeof w.easy_day === 'boolean') return w.easy_day;
  return !!env.data && readinessOn(env.data, w.date).level === 'amber';
}

/**
 * The effective prescription a logged entry was done against (SPEC 5.2 round 4):
 * {sets, reps, rir, seconds, load, source}. `source` is 'stored' (entry.planned), 'recomputed'
 * (older logs: the program block for that date, after sets_max, deload, easy-day or fasting
 * halving; needs {program}) or 'rows' (neither is possible: the number of set rows logged, which
 * the logger created from the effective sets). Never the raw block sets.
 */
export function effectivePrescription(workout, entry, { program = null, data = null, timeline = null, list = null } = {}) {
  const prog = isObj(program) ? program : null;
  let tl = timeline;
  const env = { program: prog, data, timeline: () => tl || (tl = buildTimeline(prog, data?.profile)) };
  return prescriptionIn(workout, entry, list || workout?.exercises, env);
}

/** effectivePrescription with a shared environment ({program, data, timeline()}: built once per call site). */
function prescriptionIn(workout, entry, list, env) {
  const stored = storedPrescription(entry);
  if (stored) return stored;
  const prog = env.program;
  if (prog && workout && isISODate(workout.date)) {
    const loc = entryBlock(workout, entry, { program: prog, list });
    const blk = loc && loc.index >= 0 ? prog.sessions[workout.session_id].blocks[loc.index] : null;
    if (blk) {
      const { week, override } = weekOfWorkout(workout, env);
      const p = plannedFromBlock(resolveBlock(blk, { week, override, easyDay: easyOfWorkout(workout, env) }));
      if (p) return { sets: p.sets, reps: p.reps, rir: p.rir, seconds: p.seconds ?? null, load: p.load, source: 'recomputed' };
    }
  }
  return { sets: entryRows(entry).length, reps: null, rir: '', seconds: null, load: '', source: 'rows' };
}

/** Same rep range ({min, max}) or, for timed work, both timed. */
function samePrescription(p, want) {
  if (!p) return false;
  if (want.range) {
    const r = parseRepRange(p.reps);
    return !!r && r.min === want.range.min && r.max === want.range.max;
  }
  return !!want.timed && !parseRepRange(p.reps) && isNum(p.seconds);
}

const MATCH = ['block', 'prescription', 'any'];

/**
 * The most recent earlier log of this exercise (excluding one workout id), with what was planned.
 *
 * Round 3: also {rows, planned, complete}: every set row last time (undone ones included), how
 * many sets were planned, and whether they were all performed with actual values (isPerformedSet;
 * a timed set needs its seconds). `sets` and `rows` carry `planned` and `complete` too
 * (non-enumerable), so passing either straight to suggestProgression() applies the rule.
 *
 * Round 4 (SPEC 5.2):
 * - `planned` is the EFFECTIVE prescription last time (BT1-1 / BT3-1): entry.planned.sets, or
 *   for older logs the sets recomputed for that date (pass {program}), else the set rows logged.
 *   Never the raw block sets. `prescription` is the whole {sets, reps, rir, seconds, load, source}.
 * - Per block (BT3-2): pass {sessionId, blockKey, reps (or seconds), program}. The baseline is
 *   the most recent log of the same exercise in the same session template and block key
 *   (`match: 'block'`), else the same exercise with the same rep range ('prescription'), else
 *   any log of it ('any'). Logs from program.alternates sessions are never the baseline for a
 *   full session. Without those options it behaves as before (the most recent log, every entry
 *   of the exercise in that session; `match: null`).
 * Options may also be passed as the 4th argument: lastPerformance(data, id, date, {excludeId, ...}).
 * Also returns `plannedSets` (= planned), `sessionId` (of that log), `block` (its block key) and
 * `entry` (the logged entry it read; the first one in the legacy mode). Read-only.
 */
export function lastPerformance(data, exerciseId, beforeOrOn, excludeId = null, opts = {}) {
  if (isObj(excludeId)) { opts = excludeId; excludeId = opts.excludeId ?? null; }
  const o = isObj(opts) ? opts : {};
  const program = isObj(o.program) ? o.program : null;
  const sessionId = typeof o.sessionId === 'string' && o.sessionId ? o.sessionId : null;
  const blockKey = typeof o.blockKey === 'string' && o.blockKey ? o.blockKey : typeof o.block === 'string' && o.block ? o.block : null;
  const range = o.reps != null && o.reps !== '' ? parseRepRange(o.reps) : null;
  const want = { range, timed: !range && isNum(o.seconds) };
  const perBlock = !!(sessionId || blockKey || range || want.timed);
  const alternates = Array.isArray(o.alternates) || o.alternates instanceof Set ? new Set(o.alternates) : program ? alternateIds(program) : new Set();
  const skipAlternates = !!sessionId && !alternates.has(sessionId);
  let tl = null;
  const env = { program, data, timeline: () => tl || (tl = buildTimeline(program, data?.profile)) };
  const prescriptionFor = (w, e) => prescriptionIn(w, e, w.exercises, env);
  let best = null;
  const consider = (c) => {
    c.key = entryBlock(c.w, c.item, { program, list: c.list })?.key ?? null;
    const sameBlock = (sessionId || blockKey) && (!sessionId || c.w.session_id === sessionId) && (!blockKey || c.key === blockKey);
    c.tier = sameBlock ? 1 : 3;
    // A prescription is only worth working out when this log could still win.
    if (c.tier === 3 && !c.cardio && (want.range || want.timed) && (!best || best.tier > 2 || (best.tier === 2 && c.w.date > best.w.date))) {
      if (samePrescription(prescriptionFor(c.w, c.item), want)) c.tier = 2;
    }
    if (!best || c.tier < best.tier || (c.tier === best.tier && c.w.date > best.w.date)) best = c;
  };
  for (const w of doneWorkouts(data)) {
    if (w.id === excludeId || !isISODate(w.date) || w.date > beforeOrOn) continue;
    if (!perBlock) {
      if (!setsFor(w, exerciseId).some((s) => isNum(s.reps) || isNum(s.seconds) || isNum(s.kg)) && !cardioFor(w, exerciseId).length) continue;
      if (!best || w.date > best.w.date) best = { w, tier: 3 };
      continue;
    }
    if (skipAlternates && alternates.has(w.session_id)) continue;
    const exList = Array.isArray(w.exercises) ? w.exercises : [];
    for (const e of exList) if (e && e.exercise === exerciseId && entrySets(e).length) consider({ w, item: e, list: exList, cardio: false });
    const cdList = Array.isArray(w.cardio) ? w.cardio : [];
    for (const c of cdList) if (c && c.exercise === exerciseId) consider({ w, item: c, list: cdList, cardio: true });
  }
  if (!best) return null;
  const w = best.w;
  let entries;
  let sets;
  let rows;
  let cardio;
  if (!perBlock) {
    entries = (Array.isArray(w.exercises) ? w.exercises : []).filter((e) => e && e.exercise === exerciseId);
    sets = setsFor(w, exerciseId).filter((s) => isNum(s.reps) || isNum(s.seconds) || isNum(s.kg));
    rows = setRowsFor(w, exerciseId);
    cardio = cardioFor(w, exerciseId);
  } else if (best.cardio) {
    entries = [];
    sets = [];
    rows = [];
    cardio = [best.item, ...cardioFor(w, exerciseId).filter((c) => c !== best.item)];
  } else {
    entries = [best.item];
    sets = entrySets(best.item);
    rows = entryRows(best.item);
    cardio = cardioFor(w, exerciseId);
  }
  const prescriptions = entries.map((e) => prescriptionFor(w, e));
  const planned = prescriptions.length ? prescriptions.reduce((n, p) => n + p.sets, 0) : rows.length;
  const timed = rows.some((s) => isNum(s.seconds)) && !rows.some((s) => isNum(s.reps));
  const loaded = rows.some((s) => s.done !== false && isNum(s.kg) && Number(s.kg) > 0);
  const performed = timed
    ? rows.filter((s) => s.done !== false && s.placeholder !== true && s.actual !== false && isNum(s.seconds)).length
    : rows.filter((s) => isPerformedSet(s, { loaded })).length;
  const complete = rows.length > 0 && performed >= planned;
  for (const arr of [sets, rows]) {
    Object.defineProperty(arr, 'planned', { value: planned, enumerable: false });
    Object.defineProperty(arr, 'complete', { value: complete, enumerable: false });
  }
  const prescription = prescriptions.length === 1 ? prescriptions[0] : prescriptions.length ? { ...prescriptions[0], sets: planned } : null;
  const block = perBlock ? best.key : entries.length ? entryBlock(w, entries[0], { program, list: w.exercises })?.key ?? null : null;
  return {
    date: w.date, workoutId: w.id, sets, cardio, rows, planned, plannedSets: planned, complete, prescription,
    match: perBlock ? MATCH[best.tier - 1] : null, sessionId: w.session_id ?? null, block, entry: perBlock ? best.item : entries[0] || null,
  };
}

// ---------------------------------------------------------- tests & hikes

export function testResults(data, testId) {
  return (Array.isArray(data?.tests) ? data.tests : [])
    .filter((t) => t && t.test === testId && isISODate(t.date) && isNum(t.value))
    .map((t) => ({ date: t.date, value: Number(t.value), notes: t.notes || '' }))
    .sort((a, b) => (a.date < b.date ? -1 : 1));
}

/**
 * Does a hike meet a ladder level's numbers? distance_km and ascent_m are minimums (an ascent of
 * 0 or null means "any ascent", and a hike with no ascent logged counts as 0); pack_kg > 0 is a
 * minimum pack; optional duration_min (or minutes) is a minimum time. Terrain is checked by you.
 */
export function hikeMeets(hike, level) {
  const c = level && typeof level.criteria === 'object' && level.criteria ? level.criteria : {};
  if (!hike || typeof hike !== 'object') return false;
  if (isNum(c.distance_km) && Number(c.distance_km) > 0 && !(num(hike.distance_km) >= Number(c.distance_km))) return false;
  if (isNum(c.ascent_m) && Number(c.ascent_m) > 0 && !((num(hike.ascent_m) ?? 0) >= Number(c.ascent_m))) return false;
  if (isNum(c.pack_kg) && Number(c.pack_kg) > 0 && !((num(hike.pack_kg) ?? 0) >= Number(c.pack_kg))) return false;
  const minutes = isNum(c.duration_min) ? Number(c.duration_min) : isNum(c.minutes) ? Number(c.minutes) : null;
  if (minutes !== null && minutes > 0 && !(num(hike.duration_min) >= minutes)) return false;
  return true;
}

/**
 * Ladder completion: the first logged hike that meets a level's numbers while its gate was met, or a manual tick.
 * Round 3: {today} ignores hikes dated after today (a typo can't complete a level in advance).
 */
export function ladderStatus(ladder, data, clearances, { today = null } = {}) {
  const hikes = (Array.isArray(data?.hikes) ? data.hikes : []).filter((h) => h && isISODate(h.date) && (!today || h.date <= today)).sort((a, b) => (a.date < b.date ? -1 : 1));
  const manual = data?.hike_ladder && typeof data.hike_ladder === 'object' ? data.hike_ladder : {};
  return (Array.isArray(ladder) ? ladder : []).map((level) => {
    const gate = typeof level.gate === 'string' && level.gate ? level.gate : 'none';
    const auto = hikes.find((h) => hikeMeets(h, level) && isGateMet(gate, clearances, h.date)) || null;
    const m = manual[String(level.level)];
    const manualDate = m && isISODate(m.done) ? m.done : null;
    return { level, gate, autoHike: auto, autoDate: auto ? auto.date : null, manualDate, done: !!(auto || manualDate) };
  });
}

/**
 * The programme start Monday that weekend_plan program_week entries count from. `opts` may be an
 * ISO date, or {start | programStart}, {timeline}, {profile} or {data} (with {program} for its
 * default_start_date); without any of them it is the default start, the Monday after {today}
 * (the local clock when {today} isn't given).
 */
export function weekendPlanStart(opts = {}) {
  if (isISODate(opts)) return mondayOf(opts);
  const o = isObj(opts) ? opts : {};
  for (const k of ['start', 'programStart']) if (isISODate(o[k])) return mondayOf(o[k]);
  if (isISODate(o.timeline?.start)) return mondayOf(o.timeline.start);
  const profile = isObj(o.profile) ? o.profile : isObj(o.data?.profile) ? o.data.profile : null;
  return programStart(isObj(o.program) ? o.program : null, profile, isISODate(o.today) ? o.today : undefined);
}

const programWeekOf = (e) => {
  const n = isNum(e?.program_week) ? Number(e.program_week) : NaN;
  return Number.isInteger(n) && n >= 1 ? n : null;
};

/**
 * hikes.json weekend_plan with every entry's week worked out, sorted by week. Round 4: an entry's
 * `program_week` (1–8, relative to the programme start) takes precedence over its `week_start`;
 * such entries come back as copies whose week_start is that programme week's Monday. Entries
 * with neither are left out. `opts`: see weekendPlanStart.
 */
export function weekendPlanList(hikesContent, opts = {}) {
  const list = Array.isArray(hikesContent?.weekend_plan) ? hikesContent.weekend_plan : [];
  let start = null;
  const out = [];
  list.forEach((e, i) => {
    if (!isObj(e)) return;
    const pw = programWeekOf(e);
    let week = null;
    if (pw !== null) {
      start = start || weekendPlanStart(opts);
      week = addDays(start, (pw - 1) * 7);
    } else if (isISODate(e.week_start)) week = mondayOf(e.week_start);
    if (week) out.push({ e, week, pw, i });
  });
  out.sort((a, b) => (a.week < b.week ? -1 : a.week > b.week ? 1 : ((b.pw !== null) - (a.pw !== null)) || a.i - b.i));
  return out.map((x) => (x.pw !== null ? { ...x.e, week_start: x.week, program_week: x.pw } : x.e));
}

/**
 * hikes.json weekend_plan entry for the week of dateISO, or null. Round 4: entries may give
 * `program_week` instead of `week_start` (program_week wins); pass the programme start as the
 * third argument (an ISO date, {start}, {timeline}, {profile} or {data}; see weekendPlanStart).
 */
export function weekendPlanOn(hikesContent, dateISO, opts = {}) {
  if (!isISODate(dateISO)) return null;
  const wk = mondayOf(dateISO);
  return weekendPlanList(hikesContent, opts).find((e) => mondayOf(e.week_start) === wk) || null;
}

/** The first weekend_plan entry for the week of dateISO or a later week, or null. */
export function nextWeekendPlanOn(hikesContent, dateISO, opts = {}) {
  if (!isISODate(dateISO)) return null;
  const wk = mondayOf(dateISO);
  return weekendPlanList(hikesContent, opts).find((e) => mondayOf(e.week_start) >= wk) || null;
}

export function hikeTotals(data) {
  const hikes = (Array.isArray(data?.hikes) ? data.hikes : []).filter((h) => h && isISODate(h.date));
  const km = hikes.reduce((s, h) => s + (num(h.distance_km) || 0), 0);
  const ascent = hikes.reduce((s, h) => s + (num(h.ascent_m) || 0), 0);
  // A hike without a distance can never be the "longest" (null used to compare as 0 > -1).
  const longest = hikes.reduce((best, h) => (isNum(h.distance_km) && (!best || Number(h.distance_km) > Number(best.distance_km)) ? h : best), null);
  return { count: hikes.length, km, ascent, longest };
}

// ---------------------------------------------------------- data quality

/**
 * Plausible ranges. Values outside a [lo, hi] pair are flagged; `scale` fields are hard
 * scales (outside = "error"), the rest are "warning" (possible, but probably a typo).
 */
export const PLAUSIBLE = {
  weight_kg: [30, 250],
  weightJumpKgPerDay: 3,
  rhr: [30, 120],
  hrv: [5, 250],
  sleep_h: [0, 14],
  steps: [0, 60000],
  protein_g: [0, 400],
  calories: [0, 8000],
  water_l: [0, 10],
  set_kg: [0, 400],
  set_reps: [0, 100],
  set_seconds: [0, 3600],
  cardio_minutes: [0, 480],
  avg_hr: [40, 220],
  cardio_distance_km: [0, 100],
  hike_distance_km: [0, 100],
  hike_ascent_m: [0, 6000],
  hike_duration_min: [0, 1440],
  hike_speed_kmh: 8,
  pack_kg: [0, 40],
  measurement_cm: [5, 250],
  arm_deg: [0, 180],
  grip_kg: [0, 100],
  scale: { sleep_q: [1, 5], energy: [1, 5], mood: [1, 5], stress: [1, 5], soreness: [0, 10], arm_pain: [0, 10], rpe: [1, 10], rir: [0, 10] },
};

const fmt1 = (v) => String(Math.round(v * 10) / 10);

/** A decimal-slip fix for v (805 -> 80.5, 8.05 -> 80.5) that lands in range and near ref. */
export function suggestTypoFix(value, [lo, hi], ref = null, extra = []) {
  const v = Number(value);
  if (!Number.isFinite(v) || v === 0) return null;
  const cands = [v / 10, v / 100, v / 1000, v * 10, v * 100, ...extra.map((f) => v * f)]
    .map((c) => Math.round(c * 100) / 100)
    .filter((c) => c >= lo && c <= hi);
  if (!cands.length) return null;
  if (isNum(ref)) {
    const best = cands.reduce((a, b) => (Math.abs(b - ref) < Math.abs(a - ref) ? b : a));
    return Math.abs(best - ref) <= Math.max(5, Math.abs(ref) * 0.15) ? best : null;
  }
  return cands.length === 1 ? cands[0] : null;
}

function issueMaker(out, collection, key, base) {
  return (level, field, value, message, suggestion = null) => {
    out.push({ level, collection, key, field, path: `${base}.${field}`, value, message, suggestion });
  };
}

function checkRange(add, field, value, [lo, hi], label, unit, { ref = null, extra = [], hard = false } = {}) {
  if (!isNum(value)) return false;
  const v = Number(value);
  if (v >= lo && v <= hi) return false;
  const fix = hard ? null : suggestTypoFix(v, [lo, hi], ref, extra);
  const u = unit ? ` ${unit}` : '';
  add(hard ? 'error' : 'warning', field, v,
    hard ? `${label} ${v} is outside the ${lo}–${hi} scale.`
      : `${label} of ${v}${u} looks unlikely${fix !== null ? `. Did you mean ${fix}${u}?` : '. Please check it.'}`,
    fix);
  return true;
}

/**
 * Plausibility checks for one check-in. `previous` is the most recent earlier check-in with a
 * weight ({date, weight_kg}); when omitted it is looked up in data.checkins.
 */
export function checkinIssues(checkin, data = null, { previous } = {}) {
  const out = [];
  if (!checkin || typeof checkin !== 'object') return out;
  const add = issueMaker(out, 'checkins', checkin.date, `checkins[${checkin.date}]`);
  let prev = previous;
  if (prev === undefined && data) {
    prev = null;
    for (const c of Array.isArray(data.checkins) ? data.checkins : []) {
      if (c && c !== checkin && isISODate(c.date) && isISODate(checkin.date) && c.date < checkin.date && isNum(c.weight_kg) && (!prev || c.date > prev.date)) prev = c;
    }
  }
  const prevW = prev && isNum(prev.weight_kg) ? Number(prev.weight_kg) : null;
  const outOfRange = checkRange(add, 'weight_kg', checkin.weight_kg, PLAUSIBLE.weight_kg, 'A weight', 'kg', { ref: prevW });
  if (!outOfRange && isNum(checkin.weight_kg) && prevW !== null && isISODate(prev.date) && isISODate(checkin.date)) {
    const days = Math.max(1, daysBetween(prev.date, checkin.date));
    const diff = Number(checkin.weight_kg) - prevW;
    if (Math.abs(diff) / days > PLAUSIBLE.weightJumpKgPerDay) {
      const fix = suggestTypoFix(checkin.weight_kg, PLAUSIBLE.weight_kg, prevW);
      add('warning', 'weight_kg', Number(checkin.weight_kg),
        `That is ${fmt1(Math.abs(diff))} kg ${diff > 0 ? 'more' : 'less'} than your weigh-in ${days === 1 ? 'the day before' : `${days} days earlier`} (${fmt1(prevW)} kg). Check the scale or the decimal point${fix !== null && Math.abs(fix - prevW) / days <= PLAUSIBLE.weightJumpKgPerDay ? `: did you mean ${fix} kg?` : '.'}`,
        fix !== null && Math.abs(fix - prevW) / days <= PLAUSIBLE.weightJumpKgPerDay ? fix : null);
    }
  }
  checkRange(add, 'rhr', checkin.rhr, PLAUSIBLE.rhr, 'A resting heart rate', 'bpm', { ref: 60 });
  checkRange(add, 'hrv', checkin.hrv, PLAUSIBLE.hrv, 'An HRV', 'ms');
  checkRange(add, 'sleep_h', checkin.sleep_h, PLAUSIBLE.sleep_h, 'Sleep', 'h', { extra: [1 / 60], ref: 7.5 }); // 450 (minutes) -> 7.5 h
  checkRange(add, 'steps', checkin.steps, PLAUSIBLE.steps, 'A step count', '');
  checkRange(add, 'protein_g', checkin.protein_g, PLAUSIBLE.protein_g, 'Protein', 'g');
  checkRange(add, 'calories', checkin.calories, PLAUSIBLE.calories, 'Calories', 'kcal');
  checkRange(add, 'water_l', checkin.water_l, PLAUSIBLE.water_l, 'Water', 'l', { extra: [1 / 1000] });
  for (const [k, range] of Object.entries(PLAUSIBLE.scale)) {
    if (k in checkin) checkRange(add, k, checkin[k], range, (k.charAt(0).toUpperCase() + k.slice(1)).replace(/_/g, ' '), '', { hard: true });
  }
  return out;
}

/** Plausibility checks for one workout: set loads, reps and times, cardio minutes and HR. */
export function workoutIssues(workout, data = null, { lastTopKg } = {}) {
  const out = [];
  if (!workout || typeof workout !== 'object') return out;
  const add = issueMaker(out, 'workouts', workout.id, `workouts[${workout.id}]`);
  (Array.isArray(workout.exercises) ? workout.exercises : []).forEach((e, ei) => {
    if (!e || typeof e !== 'object') return;
    let ref = lastTopKg ? lastTopKg.get(e.exercise) : undefined;
    if (ref === undefined && data && isISODate(workout.date)) {
      const last = lastPerformance(data, e.exercise, addDays(workout.date, -1), workout.id);
      const kgs = (last?.sets || []).map((s) => num(s.kg)).filter((k) => k !== null && k > 0);
      ref = kgs.length ? Math.max(...kgs) : null;
    }
    (Array.isArray(e.sets) ? e.sets : []).forEach((s, si) => {
      if (!s || typeof s !== 'object') return;
      const f = (k) => `exercises[${ei}].sets[${si}].${k}`;
      const sub = (level, field, value, message, suggestion) => add(level, f(field), value, `${e.exercise || 'Exercise'}, set ${si + 1}: ${message}`, suggestion);
      if (!checkRange(sub, 'kg', s.kg, PLAUSIBLE.set_kg, 'a load', 'kg', { ref }) && isNum(s.kg) && isNum(ref) && ref > 0 && Number(s.kg) >= ref * 3 && Number(s.kg) - ref >= 20) {
        const fix = suggestTypoFix(s.kg, PLAUSIBLE.set_kg, ref);
        sub('warning', 'kg', Number(s.kg), `${s.kg} kg is more than three times last time (${ref} kg)${fix !== null ? `. Did you mean ${fix} kg?` : '.'}`, fix);
      }
      checkRange(sub, 'reps', s.reps, PLAUSIBLE.set_reps, 'reps', '');
      checkRange(sub, 'seconds', s.seconds, PLAUSIBLE.set_seconds, 'a hold', 's');
      checkRange(sub, 'rir', s.rir, PLAUSIBLE.scale.rir, 'RIR', '', { hard: true });
    });
  });
  (Array.isArray(workout.cardio) ? workout.cardio : []).forEach((c, ci) => {
    if (!c || typeof c !== 'object') return;
    const sub = (level, field, value, message, suggestion) => add(level, `cardio[${ci}].${field}`, value, `${c.exercise || 'Cardio'}: ${message}`, suggestion);
    checkRange(sub, 'minutes', c.minutes, PLAUSIBLE.cardio_minutes, 'a duration', 'min');
    checkRange(sub, 'avg_hr', c.avg_hr, PLAUSIBLE.avg_hr, 'an average heart rate', 'bpm');
    checkRange(sub, 'distance_km', c.distance_km, PLAUSIBLE.cardio_distance_km, 'a distance', 'km');
  });
  checkRange(add, 'duration_min', workout.duration_min, [0, 480], 'A session length', 'min');
  if ('rpe' in workout) checkRange(add, 'rpe', workout.rpe, PLAUSIBLE.scale.rpe, 'RPE', '', { hard: true });
  return out;
}

/** The SPEC 5.9 carrying rule for walks before clinic_light: a waist pack of 2 kg or less. */
export const WAIST_PACK_MAX_KG = 2;

/**
 * Plausibility checks for one hike, including an average speed check. Round 3: with data, a pack
 * over 2 kg before clinic_light is flagged (SPEC 5.9: waist pack only until then).
 */
export function hikeIssues(hike, data = null) {
  const out = [];
  if (!hike || typeof hike !== 'object') return out;
  const add = issueMaker(out, 'hikes', hike.id, `hikes[${hike.id}]`);
  const cl = data?.profile?.clearances;
  if (cl && isISODate(hike.date) && isNum(hike.pack_kg) && Number(hike.pack_kg) > WAIST_PACK_MAX_KG && Number(hike.pack_kg) <= PLAUSIBLE.pack_kg[1] && !isGateMet('clinic_light', cl, hike.date)) {
    add('warning', 'pack_kg', Number(hike.pack_kg), `Until your clinic clears light use of the arm, walks are waist pack only (2 kg or less), put on and taken off with your uninjured hand. ${hike.pack_kg} kg is more than that.`);
  }
  const d = checkRange(add, 'distance_km', hike.distance_km, PLAUSIBLE.hike_distance_km, 'A distance', 'km');
  checkRange(add, 'ascent_m', hike.ascent_m, PLAUSIBLE.hike_ascent_m, 'An ascent', 'm');
  const t = checkRange(add, 'duration_min', hike.duration_min, PLAUSIBLE.hike_duration_min, 'A duration', 'min');
  checkRange(add, 'pack_kg', hike.pack_kg, PLAUSIBLE.pack_kg, 'A pack weight', 'kg');
  checkRange(add, 'avg_hr', hike.avg_hr, PLAUSIBLE.avg_hr, 'An average heart rate', 'bpm');
  if ('rpe' in hike) checkRange(add, 'rpe', hike.rpe, PLAUSIBLE.scale.rpe, 'RPE', '', { hard: true });
  if (!d && !t && isNum(hike.distance_km) && isNum(hike.duration_min) && Number(hike.duration_min) > 0) {
    const kmh = Number(hike.distance_km) / (Number(hike.duration_min) / 60);
    if (kmh > PLAUSIBLE.hike_speed_kmh) add('warning', 'duration_min', Number(hike.duration_min), `${fmt1(Number(hike.distance_km))} km in ${hike.duration_min} min is ${fmt1(kmh)} km/h, faster than a brisk hike. Check the distance and the time (in minutes).`);
  }
  return out;
}

/**
 * Whole-dataset audit for a "check my data" panel: check-ins (with weight jumps), workouts
 * (with load jumps against the previous session of the same exercise), hikes, arm logs and
 * tape measurements. One pass over sorted data: O(n log n).
 */
export function dataIssues(data, { limit = 500 } = {}) {
  const out = [];
  const push = (list) => { for (const x of list) if (out.length < limit) out.push(x); };
  const checkins = (Array.isArray(data?.checkins) ? data.checkins : []).filter((c) => c && isISODate(c.date))
    .slice().sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  let prev = null;
  for (const c of checkins) {
    push(checkinIssues(c, null, { previous: prev }));
    if (isNum(c.weight_kg) && Number(c.weight_kg) >= PLAUSIBLE.weight_kg[0] && Number(c.weight_kg) <= PLAUSIBLE.weight_kg[1]) prev = c;
  }
  const lastTop = new Map();
  const workouts = doneWorkouts(data).filter((w) => isISODate(w.date)).slice().sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  for (const w of workouts) {
    push(workoutIssues(w, null, { lastTopKg: lastTop }));
    for (const e of Array.isArray(w.exercises) ? w.exercises : []) {
      const kgs = (Array.isArray(e?.sets) ? e.sets : []).filter((s) => s && s.done !== false).map((s) => num(s.kg))
        .filter((k) => k !== null && k > 0 && k <= PLAUSIBLE.set_kg[1]);
      if (kgs.length) lastTop.set(e.exercise, Math.max(...kgs));
    }
  }
  for (const h of Array.isArray(data?.hikes) ? data.hikes : []) push(hikeIssues(h, data));
  for (const l of Array.isArray(data?.arm?.logs) ? data.arm.logs : []) {
    if (!l || typeof l.values !== 'object' || !l.values) continue;
    const list = [];
    const add = issueMaker(list, 'arm.logs', l.date, `arm.logs[${l.date}]`);
    for (const [k, v] of Object.entries(l.values)) {
      if (/^pain/.test(k)) checkRange(add, `values.${k}`, v, [0, 10], 'Pain', '/10', { hard: true });
      else if (/_deg$/.test(k)) checkRange(add, `values.${k}`, v, PLAUSIBLE.arm_deg, 'A range of motion', '°');
      else if (/_kg$/.test(k)) checkRange(add, `values.${k}`, v, PLAUSIBLE.grip_kg, 'A grip strength', 'kg');
    }
    push(list);
  }
  for (const m of Array.isArray(data?.measurements) ? data.measurements : []) {
    if (!m || typeof m !== 'object') continue;
    const list = [];
    const add = issueMaker(list, 'measurements', m.date, `measurements[${m.date}]`);
    for (const [k, v] of Object.entries(m)) if (/_cm$/.test(k)) checkRange(add, k, v, PLAUSIBLE.measurement_cm, 'A measurement', 'cm');
    push(list);
  }
  return out;
}

// ---------------------------------------------------------- CSV export

/**
 * One CSV cell (RFC 4180). Every text cell is quoted (round 4), so a ";" or "," inside text can
 * never start a new cell, whichever list separator the spreadsheet's locale uses ("a;=1+1" stays
 * one cell). Text that a spreadsheet would run as a formula (= + - @, also after leading spaces,
 * or a leading tab or CR) is prefixed with '. Numbers and booleans stay bare, so they're values.
 */
export function csvCell(v) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : '';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  let s = Array.isArray(v) ? v.map((x) => (x !== null && typeof x === 'object' ? JSON.stringify(x) : String(x ?? ''))).join('; ')
    : typeof v === 'object' ? JSON.stringify(v) : String(v);
  if (/^[\t\r]|^\s*[=+\-@]/.test(s)) s = `'${s}`;
  return `"${s.replace(/"/g, '""')}"`;
}

/**
 * rows -> CSV text. columns: [{key, label?, get?(row)}]. CRLF line ends and a UTF-8 BOM by
 * default, so Excel opens it with the right encoding.
 */
export function toCSV(rows, columns, { bom = true, eol = '\r\n' } = {}) {
  const lines = [columns.map((c) => csvCell(c.label ?? c.key)).join(',')];
  for (const r of rows) lines.push(columns.map((c) => csvCell(typeof c.get === 'function' ? c.get(r) : r?.[c.key])).join(','));
  return (bom ? '\uFEFF' : '') + lines.join(eol) + eol;
}

const byDateThen = (a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0);

export const CHECKIN_CSV_COLUMNS = ['date', 'weight_kg', 'rhr', 'hrv', 'sleep_h', 'sleep_q', 'energy', 'soreness', 'mood', 'stress',
  'arm_pain', 'arm_flags', 'steps', 'protein_g', 'calories', 'water_l', 'creatine', 'notes'].map((key) => ({ key }));

export function checkinsCSV(data, opts = {}) {
  const rows = (Array.isArray(data?.checkins) ? data.checkins : []).filter((c) => c && typeof c === 'object').slice().sort(byDateThen);
  return toCSV(rows, CHECKIN_CSV_COLUMNS, opts);
}

/**
 * Workouts in "long" form: one row per logged set and one per cardio entry (a session with
 * neither gets one row). Drafts are left out unless includeDrafts. exName(id) adds names.
 */
export function workoutsCSV(data, { exName = null, includeDrafts = false, ...opts } = {}) {
  const list = (Array.isArray(data?.workouts) ? data.workouts : []).filter((w) => w && typeof w === 'object' && (includeDrafts || isDone(w)))
    .slice().sort(byDateThen);
  const rows = [];
  for (const w of list) {
    const base = { date: w.date, workout_id: w.id, session_id: w.session_id, session_name: w.session_name, status: w.status || 'done',
      phase_id: w.phase_id, phase_week: w.phase_week, duration_min: w.duration_min, rpe: w.rpe, workout_notes: w.notes };
    let n = 0;
    for (const e of Array.isArray(w.exercises) ? w.exercises : []) {
      (Array.isArray(e?.sets) ? e.sets : []).forEach((s, i) => {
        n++;
        rows.push({ ...base, kind: 'set', exercise: e.exercise, set_no: i + 1, kg: s?.kg, reps: s?.reps, seconds: s?.seconds, rir: s?.rir, done: s?.done !== false, notes: e.notes });
      });
    }
    for (const c of Array.isArray(w.cardio) ? w.cardio : []) {
      if (!c || typeof c !== 'object') continue;
      n++;
      rows.push({ ...base, kind: 'cardio', exercise: c.exercise, minutes: c.minutes, zone: c.zone, avg_hr: c.avg_hr, distance_km: c.distance_km, ascent_m: c.ascent_m, level: c.level, rounds: c.rounds, notes: c.notes });
    }
    if (!n) rows.push({ ...base, kind: 'session' });
  }
  const cols = ['date', 'workout_id', 'session_id', 'session_name', 'status', 'phase_id', 'phase_week', 'duration_min', 'rpe', 'kind', 'exercise']
    .map((key) => ({ key }));
  if (typeof exName === 'function') cols.push({ key: 'exercise_name', get: (r) => (r.exercise ? exName(r.exercise) : '') });
  cols.push(...['set_no', 'kg', 'reps', 'seconds', 'rir', 'done', 'minutes', 'zone', 'avg_hr', 'distance_km', 'ascent_m', 'level', 'rounds', 'notes', 'workout_notes'].map((key) => ({ key })));
  return toCSV(rows, cols, opts);
}

export const HIKE_CSV_COLUMNS = ['date', 'name', 'distance_km', 'ascent_m', 'duration_min', 'pack_kg', 'terrain', 'avg_hr', 'rpe', 'ladder_level', 'notes', 'workout_id', 'id']
  .map((key) => ({ key }));

export function hikesCSV(data, opts = {}) {
  const rows = (Array.isArray(data?.hikes) ? data.hikes : []).filter((h) => h && typeof h === 'object').slice().sort(byDateThen);
  return toCSV(rows, HIKE_CSV_COLUMNS, opts);
}

/** exportCSV(data, 'checkins' | 'workouts' | 'hikes', opts) -> {filename, text, mime}. */
export function exportCSV(data, kind, { today = '', ...opts } = {}) {
  const make = { checkins: checkinsCSV, workouts: workoutsCSV, hikes: hikesCSV }[kind];
  if (!make) throw new Error(`Unknown CSV export: ${kind}`);
  return { filename: `fitness-hub-${kind}${today ? `-${today}` : ''}.csv`, text: make(data, opts), mime: 'text/csv;charset=utf-8' };
}
