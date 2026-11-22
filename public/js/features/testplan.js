// When each test is due (PM2, SPEC 5.2 round 4), pure. A test is due only from its scheduled time:
//  - tests.json may say when: `first_phase` + `first_week` (a phase id and that phase's week: never
//    due before it; the dead hang and farmer's carry first come due at p4a week 4), `baseline_day`
//    (1-3 = Mon-Wed of programme week 1, so the six baselines are spread over three mornings),
//    and the older due_from / baseline {phase, week, day} / first_week-only forms
//  - otherwise the baseline is due from the programme start
// After a result, it's due again every_weeks later (never before first_phase/first_week). Tests
// above your gate are never due, and nothing is due during a fasting period.
//
// schedule.js / stats.js may export testsDueOn(data, date, tests) (Team L, round 4): when it
// exists it decides which tests are due; this module still works out the dates for display.

import { addDays, isISODate, daysBetween } from '../dates.js';
import * as schedule from '../schedule.js';
import * as stats from '../stats.js';
import * as calc from '../calc.js';
import * as contentMod from '../content.js';
import { fastingOn } from './safety.js';

const { isGateMet } = schedule;
const isNum = (v) => v !== null && v !== undefined && v !== '' && typeof v !== 'boolean' && Number.isFinite(Number(v));
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const weekOf = (v) => (isNum(v) ? Math.max(1, Math.floor(Number(v))) : null);

/**
 * The first date a test may be due because of first_phase / first_week, or:
 *   undefined: the test sets no such limit
 *   null: the phase it waits for hasn't started (or has no date yet)
 */
export function firstDueFrom(test, timeline) {
  if (!test || (!test.first_phase && !isNum(test.first_week))) return undefined;
  const week = weekOf(test.first_week) || 1;
  if (typeof test.first_phase === 'string' && test.first_phase) {
    const ph = (timeline?.phases || []).find((p) => p.id === test.first_phase) || null;
    if (!ph || !isISODate(ph.start)) return null;
    return addDays(ph.start, (week - 1) * 7);
  }
  return timeline?.start ? addDays(timeline.start, (week - 1) * 7) : null;
}

/** The logic module's function `name` (content.js / schedule.js / stats.js), or null. */
function logic(name) {
  for (const m of [contentMod, schedule, stats, calc]) if (m && typeof m[name] === 'function') return m[name];
  return null;
}

/** Older UI-only scheduling forms the logic module doesn't read. */
const legacyForm = (test) => !!test && (isISODate(test.due_from) || isObj(test.baseline) || isObj(test.schedule));

/** The first date a test's baseline is due on, from the timeline ({start, phases}). */
export function baselineDueFrom(test, timeline) {
  if (!test) return null;
  const fn = logic('testBaselineDue');
  if (fn && !legacyForm(test) && timeline?.start) {
    try { return fn(test, timeline) || null; } catch { /* fall back */ }
  }
  const first = firstDueFrom(test, timeline);
  if (first === null) return null;
  const later = (d) => (first && d && first > d ? first : d || first || null);
  if (isISODate(test.due_from)) return later(test.due_from);
  const start = timeline?.start || null;
  const sched = isObj(test.baseline) ? test.baseline : isObj(test.schedule) ? test.schedule : null;
  if (sched && (sched.phase || sched.week)) {
    const ph = (timeline?.phases || []).find((p) => p.id === sched.phase) || null;
    const week = weekOf(sched.week) || 1;
    const day = isNum(sched.day) ? Math.max(0, Math.min(6, Math.floor(Number(sched.day)) - 1)) : 0;
    if (ph && ph.start) return later(addDays(ph.start, (week - 1) * 7 + day));
    if (ph && !ph.start) return null; // that phase hasn't started (waiting for a gate)
    if (start && !sched.phase) return later(addDays(start, (week - 1) * 7 + day));
  }
  if (first) return first;
  if (start && isNum(test.baseline_day)) return addDays(start, Math.max(0, Math.min(6, Math.floor(Number(test.baseline_day)) - 1)));
  const fw = isNum(test.baseline_week) ? test.baseline_week : null;
  if (start && isNum(fw)) return addDays(start, (Math.max(1, Math.floor(Number(fw))) - 1) * 7);
  return start;
}

const resultsFor = (data, id) => (Array.isArray(data?.tests) ? data.tests : [])
  .filter((t) => t && t.test === id && isISODate(t.date) && isNum(t.value))
  .sort((a, b) => (a.date < b.date ? -1 : 1));

/**
 * The status of one test on a date: {test, state: 'locked'|'scheduled'|'due'|'done', dueOn, last,
 * overdueDays, fasting, waitingPhase}. 'scheduled' = not due yet (dueOn says when; null while the
 * phase it waits for hasn't started), 'done' = done and not due again yet. On a fasting day a test
 * that would be due is 'scheduled' with `fasting` set.
 */
export function testStatus(data, test, date, timeline) {
  const fn = logic('testStatusOn');
  if (fn && !legacyForm(test) && (timeline?.start || !timeline)) {
    try {
      const r = fn(data, date, test, timeline?.start ? { timeline } : {});
      if (r && typeof r.state === 'string') {
        const paused = r.state === 'paused';
        return {
          ...r, test, last: r.last || null, overdueDays: Number(r.overdueDays) || 0,
          state: paused ? 'scheduled' : r.state, fasting: paused ? fastingOn(data, date) : null,
          waitingPhase: !r.dueOn && test.first_phase && r.state === 'scheduled' ? test.first_phase : null,
        };
      }
    } catch { /* fall back */ }
  }
  const gate = typeof test?.gate === 'string' && test.gate ? test.gate : 'none';
  const res = resultsFor(data, test.id).filter((r) => r.date <= date);
  const last = res[res.length - 1] || null;
  const base = { test, last, overdueDays: 0, fasting: null, waitingPhase: null };
  if (!isGateMet(gate, data?.profile?.clearances || {}, date)) return { ...base, state: 'locked', dueOn: null };
  const first = firstDueFrom(test, timeline);
  if (first === null) return { ...base, state: last ? 'done' : 'scheduled', dueOn: null, waitingPhase: test.first_phase || null };
  let dueOn;
  if (!last) dueOn = baselineDueFrom(test, timeline);
  else dueOn = isNum(test.every_weeks) && Number(test.every_weeks) > 0 ? addDays(last.date, Number(test.every_weeks) * 7) : null;
  if (dueOn && first && dueOn < first) dueOn = first;
  if (!dueOn) return { ...base, state: last ? 'done' : 'scheduled', dueOn: null };
  if (dueOn <= date) {
    const fast = fastingOn(data, date);
    if (fast) return { ...base, state: 'scheduled', dueOn, fasting: fast };
    return { ...base, state: 'due', dueOn, overdueDays: daysBetween(dueOn, date) };
  }
  return { ...base, state: last ? 'done' : 'scheduled', dueOn };
}

/** The logic module's testsDueOn(data, date, tests, opts), if it exists. */
const logicTestsDueOn = () => logic('testsDueOn');

/** Ids from whatever testsDueOn returns: tests, statuses ({test}), or ids. */
function idsOf(list) {
  if (!Array.isArray(list)) return null;
  const ids = [];
  for (const x of list) {
    const id = typeof x === 'string' ? x : isObj(x?.test) ? x.test.id : typeof x?.test === 'string' ? x.test : x?.id;
    if (typeof id === 'string') ids.push(id);
  }
  return ids;
}

/**
 * Tests due on a date (scheduled time reached, gate met, not fasting), most overdue first:
 * [{test, state: 'due', dueOn, last, overdueDays}].
 */
export function testsDueOn(data, tests, date, timeline) {
  const list = (Array.isArray(tests) ? tests : []).filter((t) => t && typeof t.id === 'string');
  if (!isISODate(date)) return [];
  if (timeline?.start && date < timeline.start) return [];
  if (fastingOn(data, date)) return []; // SPEC 5.2: no test is due during a fasting period
  const fn = logicTestsDueOn();
  if (fn && !list.some(legacyForm)) {
    try {
      const out = fn(data, date, list, timeline?.start ? { timeline } : {});
      if (Array.isArray(out)) {
        const ids = idsOf(out);
        return ids.map((id) => {
          const raw = out.find((x) => (isObj(x?.test) ? x.test.id : x?.id ?? x) === id);
          const test = list.find((t) => t.id === id);
          return test ? { ...(isObj(raw) ? raw : {}), test, state: 'due', dueOn: raw?.dueOn || date, last: raw?.last || null, overdueDays: Number(raw?.overdueDays) || 0 } : null;
        }).filter(Boolean).sort((a, b) => b.overdueDays - a.overdueDays);
      }
    } catch { /* fall back */ }
  }
  const statuses = list.map((t) => testStatus(data, t, date, timeline));
  return statuses.filter((s) => s.state === 'due').sort((a, b) => b.overdueDays - a.overdueDays);
}
