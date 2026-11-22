// The safety rules every page applies, from one place:
//   - readiness (SPEC 5.8, revised in round 3): RED / AMBER / GREEN, plus the fasting overlay
//   - fail-closed gates (SPEC 5.2): an exercise id that isn't in the library is locked
//   - unavailable exercises (SPEC 5.2): never offered in swaps or as alternatives
//   - "hold" weeks (SPEC 5.2): deload, easy-day and fasting weeks never add load or reps
//
// The data/logic modules (calc.js, schedule.js, store.js, content.js) are the single source of
// truth. Their round-3 exports (readinessOn, isLocked, gateOf, isAvailable) are feature-detected:
// when one exists it is used, and the local fallback below (the same SPEC rule, written out) only
// runs until it lands. Pure functions only (no DOM), so the Node tests can check them.

import * as calc from '../calc.js';
import * as schedule from '../schedule.js';
import * as store from '../store.js';
import * as contentMod from '../content.js';
import { addDays, isISODate } from '../dates.js';

const { content } = contentMod;
const isNum = (v) => v !== null && v !== undefined && v !== '' && typeof v !== 'boolean' && Number.isFinite(Number(v));
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const EPS = 1e-9;

/** The first data/logic module that exports `name` as a function (or null). */
function shared(name) {
  for (const m of [calc, schedule, store, contentMod]) {
    if (m && typeof m[name] === 'function') return m[name];
  }
  return null;
}

// ---------------------------------------------------------------- wording (SPEC 5.8 / 5.2)

export const RED_STOP = 'Stop. No training today, including your physio exercises, until you’ve been advised. Contact your fracture clinic today, or NHS 111 / 999 as the red-flag guidance says.';
export const AMBER_TEXT = 'Easy day: halve the sets, Zone 2 only, no intervals, hold loads.';
export const GREEN_TEXT = 'Good to train as planned.';
export const UNKNOWN_TEXT = 'Check in to see today’s readiness.';
export const RISING_PAIN_MSG = 'Rising arm pain can be the red flag “pain getting worse”. If it keeps rising, or you’re unsure, call your fracture clinic today.';
export const FASTING_TEXT = 'Fasting: if you can, train after you break your fast. Stop at any dizziness or light-headedness. No new lifts this period.';
export const HOLD_TEXT = 'Hold: same load, RIR 3–4';

export const READINESS_COPY = { red: RED_STOP, amber: AMBER_TEXT, green: GREEN_TEXT, unknown: UNKNOWN_TEXT };

// ---------------------------------------------------------------- fasting periods

/** profile.fasting_periods as [{start, end, label}] (inclusive ISO dates), tolerant of from/to. */
export function fastingPeriods(profile) {
  if (typeof calc.fastingPeriods === 'function') {
    try {
      const list = calc.fastingPeriods(profile);
      if (Array.isArray(list)) return list.filter((p) => p && isISODate(p.start) && isISODate(p.end)).map((p) => ({ ...p, label: typeof p.label === 'string' ? p.label : '', approximate: p.approximate !== false && p.approx !== false }));
    } catch { /* fall back */ }
  }
  const raw = Array.isArray(profile?.fasting_periods) ? profile.fasting_periods : [];
  return raw.filter(isObj).map((p) => ({
    start: isISODate(p.start) ? p.start : isISODate(p.from) ? p.from : null,
    end: isISODate(p.end) ? p.end : isISODate(p.to) ? p.to : isISODate(p.until) ? p.until : null,
    label: typeof p.label === 'string' ? p.label : typeof p.name === 'string' ? p.name : '',
    approximate: p.approximate !== false,
    raw: p,
  })).filter((p) => p.start && p.end && p.start <= p.end);
}

/** The fasting period a date falls in, or null. */
export function fastingOn(data, date) {
  if (!isISODate(date)) return null;
  return fastingPeriods(data?.profile || data).find((p) => p.start <= date && date <= p.end) || null;
}

/** Any day of the week starting Monday `weekStart` inside a fasting period. */
export function fastingInWeek(data, weekStart) {
  for (let i = 0; i < 7; i++) if (fastingOn(data, addDays(weekStart, i))) return true;
  return false;
}

// ---------------------------------------------------------------- resting-HR method changes

/** ISO dates from profile.rhr_method_changes (plain dates or {date}), oldest first. */
export function rhrMethodChanges(profile) {
  if (typeof calc.rhrMethodChanges === 'function') {
    try { const list = calc.rhrMethodChanges(profile); if (Array.isArray(list)) return list.map((x) => (typeof x === 'string' ? x : x?.date)).filter(isISODate).sort(); } catch { /* fall back */ }
  }
  const raw = Array.isArray(profile?.rhr_method_changes) ? profile.rhr_method_changes : [];
  return raw.map((x) => (typeof x === 'string' ? x : isObj(x) ? x.date : null)).filter(isISODate).sort();
}

// ---------------------------------------------------------------- readiness (SPEC 5.8)

const ANSWER_FIELDS = ['rhr', 'hrv', 'sleep_h', 'sleep_q', 'energy', 'soreness', 'mood', 'stress', 'arm_pain'];

export function armFlags(checkin) {
  if (typeof calc.armFlagsOf === 'function') return calc.armFlagsOf(checkin);
  const raw = checkin?.arm_flags;
  if (Array.isArray(raw)) return raw.filter((f) => typeof f === 'string' && f.trim()).map((f) => f.trim());
  if (typeof raw === 'string' && raw.trim()) return [raw.trim()];
  return [];
}

/** A check-in counts only if it holds more than a weight: at least one readiness answer or a red flag. */
export function countsAsCheckin(checkin) {
  if (!checkin || typeof checkin !== 'object') return false;
  if (typeof calc.countsAsCheckin === 'function') { try { return !!calc.countsAsCheckin(checkin); } catch { /* fall back */ } }
  return armFlags(checkin).length > 0 || ANSWER_FIELDS.some((k) => isNum(checkin[k]));
}

/** Sorted readings of a check-in field: [{date, value}], oldest first. */
function readings(list, field) {
  return list.filter((c) => c && isISODate(c.date) && isNum(c[field]))
    .map((c) => ({ date: c.date, value: Number(c[field]) }))
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

/** Index of the first reading dated >= iso (binary search). */
function lowerBound(rows, iso) {
  let lo = 0;
  let hi = rows.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (rows[mid].date < iso) lo = mid + 1; else hi = mid;
  }
  return lo;
}

function meanOf(rows, a, b) {
  let s = 0;
  for (let i = a; i < b; i++) s += rows[i].value;
  return b > a ? s / (b - a) : null;
}

/**
 * The resting-HR reference for a date: the mean of the 7 days before it (3+ readings), else the
 * profile baseline. After a change of method (profile.rhr_method_changes) the rule only counts
 * once there are 5 or more readings since the latest change, and older readings and the old
 * baseline are never mixed in. Returns {value, source, count} or null; `blocked` explains a null.
 */
export function rhrReferenceFor(rhrRows, profile, date, changes = rhrMethodChanges(profile)) {
  let since = null;
  for (const d of changes) if (d <= date) since = d;
  const end = lowerBound(rhrRows, date); // readings before `date`
  if (since) {
    const fromChange = end - lowerBound(rhrRows, since);
    if (fromChange < 5) return { ref: null, blocked: { since, count: fromChange } };
  }
  const winStart = lowerBound(rhrRows, since && since > addDays(date, -7) ? since : addDays(date, -7));
  const n = end - winStart;
  if (n >= 3) return { ref: { value: meanOf(rhrRows, winStart, end), source: 'average', count: n }, blocked: null };
  if (!since && isNum(profile?.rhr_baseline)) return { ref: { value: Number(profile.rhr_baseline), source: 'baseline', count: n }, blocked: null };
  return { ref: null, blocked: null };
}

/** Lowest whole-bpm reading that turns readiness amber for a reference (readings are integers). */
export function rhrAmberAt(ref) {
  if (!ref || !isNum(ref.value)) return null;
  return Math.ceil(Number(ref.value) + 5 - EPS);
}

function indexFor(data) {
  const list = (Array.isArray(data?.checkins) ? data.checkins : []).filter((c) => c && isISODate(c.date));
  const byDate = new Map();
  for (const c of list) if (!byDate.has(c.date)) byDate.set(c.date, c);
  const armPain = new Map();
  for (const l of Array.isArray(data?.arm?.logs) ? data.arm.logs : []) {
    if (!l || !isISODate(l.date) || !isObj(l.values)) continue;
    const v = Math.max(...ARM_LOG_PAIN.map((k) => (isNum(l.values[k]) ? Number(l.values[k]) : -1)));
    if (v >= 0 && v > (armPain.get(l.date) ?? -1)) armPain.set(l.date, v);
  }
  return { byDate, armPain, rhr: readings(list, 'rhr'), pain: readings(list, 'arm_pain'), changes: rhrMethodChanges(data?.profile) };
}

/** Rehab-log pain fields that count for readiness (SPEC 5.2 round 4). */
export const ARM_LOG_PAIN = ['pain_rest', 'pain_activity'];
export const RED_PAIN = 7;

/** The highest same-day rehab-log pain (pain_rest / pain_activity), or null. */
export function armLogPainOn(data, date) {
  const v = indexFor(data).armPain.get(date);
  return isNum(v) ? v : null;
}

/** SPEC 5.8, written out. Used only while calc.readinessOn doesn't exist. */
function localReadiness(data, date, idx = indexFor(data)) {
  const profile = data?.profile || {};
  const c = idx.byDate.get(date) || null;
  const flags = c ? armFlags(c) : [];
  const checkedIn = countsAsCheckin(c);
  const rr = rhrReferenceFor(idx.rhr, profile, date, idx.changes);
  const fasting = fastingOn(data, date);
  const reasons = [];
  const messages = [];
  const pain = c && isNum(c.arm_pain) ? Number(c.arm_pain) : null;
  if (checkedIn && (flags.length || (pain !== null && pain >= 7))) {
    if (flags.length) reasons.push(`${flags.length} arm red flag${flags.length > 1 ? 's' : ''} ticked`);
    if (pain !== null && pain >= 7) reasons.push(`Arm pain ${pain}/10`);
    return { level: 'red', reasons, messages, flags, rhrRef: rr.ref, rhrBlocked: rr.blocked, checkedIn, fasting };
  }
  if (checkedIn) {
    if (isNum(c.rhr) && rr.ref && Number(c.rhr) >= rr.ref.value + 5 - EPS) {
      reasons.push(`Resting HR ${Math.round(c.rhr)} is ${Math.round(Number(c.rhr) - rr.ref.value)} bpm above your ${rr.ref.source === 'average' ? '7-day average' : 'baseline'} (${Math.round(rr.ref.value)})`);
    }
    if (isNum(c.sleep_h) && Number(c.sleep_h) < 6) reasons.push(`Under 6 hours of sleep (${c.sleep_h} h)`);
    if (pain !== null && pain >= 4) reasons.push(`Arm pain ${pain}/10`);
    if (pain !== null) {
      const end = lowerBound(idx.pain, date);
      const start = lowerBound(idx.pain, addDays(date, -7));
      if (end - start >= 3) {
        const avg = meanOf(idx.pain, start, end);
        if (pain >= avg + 2 - EPS) {
          reasons.push(`Arm pain is ${Math.round((pain - avg) * 10) / 10} points above its 7-day average`);
          messages.push(RISING_PAIN_MSG);
        }
      }
    }
    if (isNum(c.soreness) && Number(c.soreness) >= 7) reasons.push(`Soreness ${c.soreness}/10`);
    if (isNum(c.energy) && Number(c.energy) <= 2) reasons.push(`Energy ${c.energy}/5`);
  }
  if (fasting) { reasons.push(`Fasting period${fasting.label ? `: ${fasting.label}` : ''}`); messages.push(FASTING_TEXT); }
  const level = reasons.length ? 'amber' : checkedIn ? 'green' : 'unknown';
  return { level, reasons, messages, flags: [], rhrRef: rr.ref, rhrBlocked: rr.blocked, checkedIn, fasting };
}

const LEVELS = new Set(['green', 'amber', 'red']);

/** Normalises a calc.readinessOn result and enforces the parts every page relies on. */
function normalise(r, data, date, idx) {
  const c = idx.byDate.get(date) || null;
  const checkedIn = countsAsCheckin(c);
  const fasting = fastingOn(data, date);
  let level = r && LEVELS.has(r.level) ? r.level : 'unknown';
  const reasons = Array.isArray(r?.reasons) ? r.reasons.filter((x) => typeof x === 'string') : [];
  const messages = Array.isArray(r?.messages) ? r.messages.filter((x) => typeof x === 'string') : [];
  // Fail safe: a red flag or 7/10 pain is always red, and a fasting day is never "train as planned".
  const flags = c ? armFlags(c) : [];
  if (level !== 'red' && checkedIn && (flags.length || (isNum(c?.arm_pain) && Number(c.arm_pain) >= RED_PAIN))) {
    level = 'red';
    if (!reasons.length) reasons.push(flags.length ? `${flags.length} arm red flag${flags.length > 1 ? 's' : ''} ticked` : `Arm pain ${c.arm_pain}/10`);
  }
  // SPEC 5.2 round 4: same-day rehab-log pain of 7 or more is red too, exactly like the check-in's.
  const logPain = idx.armPain ? idx.armPain.get(date) : null;
  if (isNum(logPain) && logPain >= RED_PAIN) {
    if (level !== 'red') { level = 'red'; reasons.length = 0; }
    if (!reasons.some((x) => /\blog\b/i.test(x))) reasons.push(`Rehab log: arm pain ${logPain}/10 (${RED_PAIN} or more)`);
  }
  if (fasting && (level === 'green' || level === 'unknown')) {
    level = 'amber';
    if (!reasons.some((x) => /fast/i.test(x))) reasons.push(`Fasting period${fasting.label ? `: ${fasting.label}` : ''}`);
  }
  if (fasting && level === 'amber' && !messages.includes(FASTING_TEXT)) messages.push(FASTING_TEXT);
  // A weight-only check-in is not a check-in: never "green" from it.
  if (level === 'green' && !checkedIn) level = 'unknown';
  let rhrRef = r && 'rhrRef' in r ? r.rhrRef : undefined;
  let rhrBlocked = r?.rhrBlocked ?? null;
  if (rhrRef === undefined) { const rr = rhrReferenceFor(idx.rhr, data?.profile, date, idx.changes); rhrRef = rr.ref; rhrBlocked = rr.blocked; }
  // A level raised here (a red flag, rehab-log pain) never keeps the softer advice it came with.
  const advice = r && r.level === level && typeof r.advice === 'string' && r.advice ? r.advice : READINESS_COPY[level];
  const extra = messages.filter((m, i) => m !== advice && messages.indexOf(m) === i);
  return { level, reasons, messages: extra, advice, flags: level === 'red' ? flags : [], rhrRef: rhrRef || null, rhrBlocked, checkedIn, fasting, inputs: checkedIn ? 1 : 0 };
}

/**
 * Readiness for one date: {level: 'green'|'amber'|'red'|'unknown', reasons[], messages[], flags[],
 * rhrRef, rhrBlocked, checkedIn, fasting}. 'unknown' means "not checked in yet" (no answers, or
 * only a weight). Uses calc.readinessOn (the single source of truth) when it exists.
 */
export function readinessFor(data, date, idx = null) {
  const index = idx || indexFor(data);
  const fn = typeof calc.readinessOn === 'function' ? calc.readinessOn : null;
  if (fn) {
    let r = null;
    try { r = fn(data, date); } catch (e) { r = null; if (typeof console !== 'undefined') console.error('readinessOn failed', e); }
    if (r) return normalise(r, data, date, index);
  }
  return normalise(localReadiness(data, date, index), data, date, index);
}

/** Readiness for every date in [from, to] (inclusive): Map(date -> result). One index, so O(n log n + days). */
export function readinessRange(data, from, to) {
  const out = new Map();
  if (!isISODate(from) || !isISODate(to) || from > to) return out;
  const idx = indexFor(data);
  // calc.readinessHistory applies the same rules to every check-in in one O(n log n) pass
  // (PERF3); days without a check-in are "not checked in", except fasting days, which are
  // asked of readinessOn directly.
  let hist = null;
  if (typeof calc.readinessHistory === 'function' && typeof calc.readinessOn === 'function') {
    try { hist = calc.readinessHistory(Array.isArray(data?.checkins) ? data.checkins : [], data?.profile || {}, { armLogs: Array.isArray(data?.arm?.logs) ? data.arm.logs : null }); } catch { hist = null; }
  }
  for (let d = from, i = 0; d <= to && i < 4000; d = addDays(d, 1), i++) {
    if (hist) {
      const h = hist.get(d);
      if (h) { out.set(d, normalise(h, data, d, idx)); continue; }
      if (!fastingOn(data, d)) { out.set(d, normalise({ level: 'unknown', reasons: [], messages: [] }, data, d, idx)); continue; }
    }
    out.set(d, readinessFor(data, d, idx));
  }
  return out;
}

/** Easy-day mode applies (AMBER, which includes the fasting overlay). */
export const isEasyLevel = (r) => !!r && r.level === 'amber';

// ---------------------------------------------------------------- exercises: gates and availability

export const DEFAULT_UNAVAILABLE = ['sled-drag-forward-belt', 'sled-drag-backward-belt', 'cable-kickback-ankle', 'cable-hip-abduction-ankle', 'cable-hip-adduction-ankle'];

/** The gate an exercise needs; unknown ids count as full clearance (fail closed). */
export function gateOf(id) {
  const fn = shared('gateOf');
  if (fn) {
    try { const g = fn(id); if (typeof g === 'string' && schedule.GATE_ORDER.includes(g)) return g; } catch { /* fall back */ }
  }
  const ex = typeof id === 'string' ? content.exById.get(id) : null;
  return ex && schedule.GATE_ORDER.includes(ex.gate) ? ex.gate : 'full_clearance';
}

/** True when an exercise can't be done on `date`: its gate isn't met, or it isn't in the library at all. */
export function isLocked(id, date, data) {
  const fn = shared('isLocked');
  if (fn) {
    try { return !!fn(id, date, data); } catch { /* fall back */ }
  }
  if (typeof id !== 'string' || !id || !content.exById.has(id)) return true;
  return !schedule.isGateMet(gateOf(id), data?.profile?.clearances || {}, date);
}

/** profile.unavailable_exercises, or the migration default until the profile has the field. */
export function unavailableIds(data) {
  const list = data?.profile?.unavailable_exercises;
  if (Array.isArray(list)) return list.filter((x) => typeof x === 'string');
  const def = Array.isArray(schedule.UNAVAILABLE_DEFAULT) ? schedule.UNAVAILABLE_DEFAULT : DEFAULT_UNAVAILABLE;
  return [...def];
}

/** False for exercises your gym can't do (profile.unavailable_exercises). */
export function isAvailable(id, data) {
  const fn = shared('isAvailable');
  if (fn) {
    try { return !!fn(id, data); } catch { /* fall back */ }
  }
  return !unavailableIds(data).includes(id);
}

/** Can be offered as a swap or an alternative: in the library, unlocked on the day and available. */
export function canOffer(id, date, data) {
  return !isLocked(id, date, data) && isAvailable(id, data);
}

// ---------------------------------------------------------------- phase-appropriate swaps (SPEC 5.2 round 4)

/**
 * The entry gate of the phase you're in on `date` (the first phase's before the programme starts),
 * or null when there's no programme or no phase that day.
 */
export function phaseGateOn(date, data, program = content.program) {
  if (!program || !isISODate(date)) return null;
  const tl = schedule.buildTimeline(program, data?.profile || {});
  if (!tl.phases.length) return null;
  const pos = schedule.positionOn(tl, date);
  const item = pos ? pos.item : (tl.start && date < tl.start ? tl.phases[0] : null);
  if (!item) return null;
  return schedule.GATE_ORDER.includes(item.entryGate) ? item.entryGate : 'full_clearance';
}

/** SPEC 5.2, written out: gate <= the phase's entry gate, never above your clearances, available at your gym. */
function localAllowedForPhase(id, date, data) {
  if (!canOffer(id, date, data)) return false;
  const ceiling = phaseGateOn(date, data);
  if (ceiling === null) return true; // no programme: your clearances are the only limit
  return schedule.gateRank(gateOf(id)) <= schedule.gateRank(ceiling);
}

/**
 * May this exercise be offered as a swap or added to a session on `date`? Only exercises with a
 * gate at or below the current phase's entry gate, never above your clearances, and not marked
 * unavailable (SPEC 5.2 round 4). Uses the logic module's allowedForPhase when it exists.
 * `sessionId` / `ceiling`: on an add-on's session its own gate counts too (a good-arm session swaps
 * among good-arm work); it only widens the phase limit up to that gate, never past your clearances
 * or your gym.
 */
export function allowedForPhase(id, date, data, { ceiling = null, sessionId = null } = {}) {
  let ok;
  const fn = shared('allowedForPhase');
  if (fn) {
    try { ok = !!fn(id, date, data, sessionId ? { sessionId } : {}); } catch { ok = undefined; }
  }
  if (ok === undefined) ok = localAllowedForPhase(id, date, data);
  if (!ok && ceiling && schedule.GATE_ORDER.includes(ceiling) && canOffer(id, date, data)) {
    ok = schedule.gateRank(gateOf(id)) <= schedule.gateRank(ceiling);
  }
  return !!ok && canOffer(id, date, data); // fail safe whatever the answer
}

// ---------------------------------------------------------------- progression: hold weeks

/**
 * Why loads are held today, or null. Deload weeks, easy days (AMBER, which includes fasting) and
 * fasting periods never add load or reps (SPEC 5.2, "Hold: same load, RIR 3–4").
 */
export function holdReason({ deload = false, easy = false, fasting = false, red = false } = {}) {
  if (red) return 'red';
  if (fasting) return 'fasting';
  if (deload) return 'deload';
  if (easy) return 'easy';
  return null;
}

const HOLD_WHY = {
  deload: 'Deload week: keep last time’s load and stop well short of failure.',
  easy: 'Easy day: keep last time’s load and stop well short of failure.',
  fasting: 'Fasting period: keep last time’s load. No new lifts this period.',
  red: 'Red flag today: no training.',
};

/** SPEC 1a: an experienced lifter coming back. No "first time" or "learn it" wording. */
export const START_TEXT = 'No log yet: start around a load you could do for 15, then let double progression find your level within 2 sessions.';

function experienced(r) {
  if (!r || typeof r.text !== 'string') return r;
  if (/^first time\b/i.test(r.text)) return { ...r, text: START_TEXT };
  if (/learn it light/i.test(r.text)) {
    const why = r.text.replace(/^.*?RIR 3[–-]4\.\s*/i, '').trim();
    return { ...r, text: `No log yet: start around a load you could do for 15 and keep RIR 3–4.${why ? ` ${why}` : ''}` };
  }
  return r;
}

/**
 * The suggestion for a double-progression block. A hold week returns
 * {kind: 'hold', kg, reps, text}. Otherwise schedule.suggestProgression decides (it may itself
 * return a hold, or null when last time's sets weren't all logged).
 * `setsPlanned` is LAST time's effective planned sets (entry.planned.sets, or recomputed for an
 * older log), never today's raw block sets (SPEC 5.2 round 4); null when unknown.
 */
export function progressionFor({ reps, lastSets = [], increment, progressionName = '', hold = null, setsPlanned = null }) {
  if (typeof schedule.suggestProgression === 'function' && (typeof schedule.HOLD_TEXT === 'string' || typeof schedule.holdReason === 'function')) {
    const planned = isNum(setsPlanned) ? Number(setsPlanned) : null;
    return experienced(schedule.suggestProgression({
      reps, lastSets, increment, progressionName, plannedSets: planned, lastPlanned: planned,
      deload: hold === 'deload', easyDay: hold === 'easy', fasting: hold === 'fasting', red: hold === 'red',
    }) || null);
  }
  const sets = (Array.isArray(lastSets) ? lastSets : []).filter((s) => s && s.done !== false);
  const kgs = sets.map((s) => Number(s.kg)).filter((n) => Number.isFinite(n) && n > 0);
  const topKg = kgs.length ? Math.max(...kgs) : null;
  if (hold) {
    return { kind: 'hold', kg: topKg, reps: null, hold, text: `${HOLD_TEXT}. ${HOLD_WHY[hold] || ''}`.trim() };
  }
  if (typeof schedule.suggestProgression !== 'function') return null;
  const planned = isNum(setsPlanned) ? Number(setsPlanned) : null;
  const r = experienced(schedule.suggestProgression({ reps, lastSets, increment, progressionName, plannedSets: planned, setsPlanned: planned }));
  if (r && r.kind === 'hold' && r.reason !== 'incomplete' && !/^Hold/i.test(r.text || '')) return { ...r, text: `${HOLD_TEXT}. ${r.text || ''}`.trim() };
  return r || null;
}
