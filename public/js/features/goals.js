// Goals (PM9, round 4), pure. data.goals is owned by the UI: {version: 1, items: [{id, ...settings}]}.
// Until you edit a goal nothing is written, and the defaults below (chapter 01, "Your 12-week
// goals") apply. Each goal is judged from your logs with the same numbers the rest of the hub uses:
//  - weight: the single fortnightly verdict (features/weight.js, SPEC 5.2 round 4)
//  - Zone 2: from Phase 1 week 3; deload and fasting weeks don't count
//  - leg press: estimated 1RM against your Re-entry Week calibration set
//  - protein: judged only on programme days
//  - sessions: done ÷ planned over the last four programme weeks, met at 80% or more
// Nothing is judged in programme week 1: every goal shows "Not started yet".

import { addDays, isISODate, mondayOf, daysBetween, fmtDay } from '../dates.js';
import { isNum, e1rm } from '../calc.js';
import { makeCtx, weekSummary, zone2Minutes, testResults, doneWorkouts } from '../stats.js';
import { fastingOn, fastingInWeek } from './safety.js';
import { planOn } from './plan.js';
import { weightVerdict, bandText, verdictLine } from './weight.js';

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const nf1 = new Intl.NumberFormat('en-GB', { maximumFractionDigits: 1, minimumFractionDigits: 1 });
const nf2 = new Intl.NumberFormat('en-GB', { maximumFractionDigits: 2, minimumFractionDigits: 1 });
const nf0 = new Intl.NumberFormat('en-GB', { maximumFractionDigits: 0 });

export const GOALS_VERSION = 1;
export const ADHERENCE_WEEKS = 4;

/** The defaults, in display order (chapter 01 and the PM brief). */
export function defaultGoals() {
  return [
    { id: 'weight', label: 'Weight trend', target_kg: null, by: null, enabled: true },
    { id: 'zone2', label: 'Zone 2 every week', minutes: 150, phase: 'p1', from_week: 3, enabled: true },
    { id: 'leg-press', label: 'Leg press strength', exercise: 'leg-press', pct: 30, phase: 'p0', baseline_week: 1, enabled: true },
    { id: 'protein', label: 'Protein days', days: 6, enabled: true },
    { id: 'adherence', label: 'Sessions done', pct: 80, enabled: true },
  ];
}

/** Your goals: saved settings over the defaults (unknown saved goals are kept as they are). */
export function goalsOf(data) {
  const saved = isObj(data?.goals) && Array.isArray(data.goals.items) ? data.goals.items.filter((g) => isObj(g) && typeof g.id === 'string') : [];
  const byId = new Map(saved.map((g) => [g.id, g]));
  const out = defaultGoals().map((d) => ({ ...d, ...(byId.get(d.id) || {}) }));
  for (const g of saved) if (!out.some((x) => x.id === g.id)) out.push({ ...g });
  return out;
}

/** Saves one goal's settings into data.goals (creating it on first edit). */
export function setGoal(data, id, patch) {
  if (!isObj(data.goals)) data.goals = { version: GOALS_VERSION, items: [] };
  if (!Array.isArray(data.goals.items)) data.goals.items = [];
  data.goals.version = GOALS_VERSION;
  let g = data.goals.items.find((x) => isObj(x) && x.id === id);
  if (!g) { g = { id }; data.goals.items.push(g); }
  Object.assign(g, patch);
  return g;
}

/** Start date of week `week` of phase `phaseId` in a timeline (or of the programme). */
function weekStartOf(timeline, phaseId, week) {
  const ph = (timeline?.phases || []).find((p) => p.id === phaseId) || null;
  if (ph && ph.start) return addDays(ph.start, (Math.max(1, week) - 1) * 7);
  if (ph && !ph.start) return null;
  return timeline?.start ? addDays(timeline.start, (Math.max(1, week) - 1) * 7) : null;
}

function bestE1rm(data, exercise, from, to) {
  let best = null;
  for (const w of doneWorkouts(data)) {
    if (!isISODate(w.date) || w.date < from || w.date > to) continue;
    for (const e of Array.isArray(w.exercises) ? w.exercises : []) {
      if (!e || e.exercise !== exercise) continue;
      for (const s of Array.isArray(e.sets) ? e.sets : []) {
        if (!s || s.done === false) continue;
        const v = e1rm(s.kg, s.reps);
        if (isNum(v) && (best === null || v > best)) best = v;
      }
    }
  }
  return best;
}

const signedKg = (v) => `${v >= 0 ? '+' : '−'}${nf2.format(Math.abs(v))} kg a week`;

/** Is the week starting Monday `m` a deload week (any day of it in a deload override)? */
function deloadWeek(program, data, m, timeline) {
  if (!program) return false;
  for (let i = 0; i < 7; i++) if (planOn(program, data, addDays(m, i), timeline || undefined).override?.deload) return true;
  return false;
}

/**
 * Status for every enabled goal on `today`:
 * [{goal, state: 'met'|'on-track'|'behind'|'ahead'|'hold'|'waiting', headline, detail, progress: {value, max} | null}].
 */
export function evaluateGoals({ data, program, today, timeline = null }) {
  if (!data || !isISODate(today)) return [];
  const ctx = program ? makeCtx({ program, profile: data.profile, data, today }) : null;
  const tl = timeline || ctx?.timeline || null;
  const start = tl?.start || null;
  const lastWeekStart = addDays(mondayOf(today), -7);
  const lastWeekEnd = addDays(lastWeekStart, 6);
  // Programme week 1 (and before it): nothing is judged yet.
  const notStarted = !start || today < addDays(start, 7);
  const firstJudged = start ? fmtDay(addDays(start, 7), { year: true }) : null;
  const waitingAll = (g, headline) => ({ goal: g, state: 'waiting', headline, detail: start ? `Judged from ${firstJudged}, after your first programme week.` : 'Judged once your programme has started.', progress: null });
  const out = [];
  for (const g of goalsOf(data).filter((x) => x.enabled !== false)) {
    if (g.id === 'weight') {
      const pre = isNum(data.profile?.pre_injury_weight_kg) ? Number(data.profile.pre_injury_weight_kg) : null;
      const target = pre ? [pre, pre] : Array.isArray(g.target_kg) ? g.target_kg : null;
      const tText = target ? ` Target: ${pre ? `back at your usual ${nf1.format(pre)} kg` : `a 7-day average of ${nf0.format(target[0])}–${nf0.format(target[1])} kg`}${isISODate(g.by) ? ` by ${fmtDay(g.by, { year: true })}` : ''}.` : '';
      const v = weightVerdict(data, today, { program, start });
      const fastNow = fastingOn(data, today);
      const aim = `Gain ${bandText(v.band).replace(/\+/g, '')}`; // "Gain 0.25 to 0.5 kg a week"
      if (notStarted) { out.push(waitingAll(g, aim)); continue; }
      if (fastNow || v.state === 'paused') {
        out.push({ goal: g, state: 'hold', headline: 'Hold your weight steady', detail: `${verdictLine(v, { fastingNow: fastNow })}${fastNow ? ' Eat at about maintenance (your calorie target without the surplus), spread across the meals your fast allows.' : ''}`, progress: null });
        continue;
      }
      if (!isNum(v.rate)) {
        out.push({ goal: g, state: 'waiting', headline: aim, detail: `${verdictLine(v)}${v.nextCheck ? ` Next verdict ${fmtDay(v.nextCheck)}.` : ''}${tText}`, progress: null });
        continue;
      }
      const state = v.state === 'in' ? 'on-track' : v.state === 'above' ? 'ahead' : 'behind';
      const now = isNum(v.avg) ? v.avg : null;
      out.push({
        goal: g, state, headline: signedKg(v.rate),
        detail: `${verdictLine(v)}${now ? ` Your 7-day average is ${nf1.format(now)} kg.` : ''}${tText}`,
        progress: null,
      });
    } else if (g.id === 'zone2') {
      const from = weekStartOf(tl, g.phase || 'p1', Number(g.from_week) || 3);
      const goal = Number(g.minutes) || 150;
      const thisMon = mondayOf(today);
      const thisWeek = zone2Minutes(data, thisMon, today);
      const lastWeek = zone2Minutes(data, lastWeekStart, lastWeekEnd);
      const quiet = (m) => deloadWeek(program, data, m, tl) ? 'deload' : fastingInWeek(data, m) ? 'fasting' : null;
      if (notStarted && !(from && today >= from)) { out.push(waitingAll(g, `${nf0.format(goal)} min of Zone 2 a week`)); continue; }
      if (!from || today < from) {
        out.push({ goal: g, state: 'waiting', headline: `${nf0.format(goal)} min of Zone 2 a week`, detail: from ? `Counts from Phase 1 week ${g.from_week || 3} (the week of ${fmtDay(from, { year: true })}). Until then, follow the week’s planned minutes.` : 'Counts from Phase 1 week 3.', progress: { value: thisWeek, max: goal } });
        continue;
      }
      const quietNow = quiet(thisMon);
      if (quietNow) {
        out.push({ goal: g, state: 'hold', headline: `${nf0.format(thisWeek)} min this week`, detail: quietNow === 'deload' ? 'Deload week: the planned minutes are lower and this week doesn’t count. Keep it easy.' : 'Fasting week: it doesn’t count. Keep the planned minutes easy.', progress: { value: thisWeek, max: goal } });
        continue;
      }
      const counted = lastWeekStart >= from && !quiet(lastWeekStart);
      const state = thisWeek >= goal ? 'met' : counted && lastWeek < goal ? 'behind' : 'on-track';
      out.push({ goal: g, state, headline: `${nf0.format(thisWeek)} of ${nf0.format(goal)} min this week`, detail: counted ? `Last week: ${nf0.format(lastWeek)} min${lastWeek >= goal ? ', goal met' : ', short of the goal'}.` : lastWeekStart >= from ? 'Last week was a deload or fasting week, so it doesn’t count.' : 'This is the first week it counts.', progress: { value: thisWeek, max: goal } });
    } else if (g.id === 'leg-press') {
      const pct = Number(g.pct) || 30;
      const bStart = weekStartOf(tl, g.phase || 'p0', Number(g.baseline_week) || 1);
      const tests = testResults(data, 'leg-press-10');
      let base = null;
      let now = null;
      if (tests.length) { base = tests[0].value; now = tests[tests.length - 1].value; }
      else if (bStart) {
        base = bestE1rm(data, g.exercise || 'leg-press', bStart, addDays(bStart, 6));
        now = bestE1rm(data, g.exercise || 'leg-press', addDays(today, -27), today);
      }
      const where = (g.phase || 'p0') === 'p0' && (Number(g.baseline_week) || 1) === 1 ? 'your Re-entry Week calibration set (the set at RIR 2 after your two easy sets)' : `your best leg-press set in ${g.phase || 'Phase 1'} week ${g.baseline_week || 2}`;
      // By the end of Phase 1 (chapter 01): the Sunday of its last planned week.
      const p1 = (tl?.phases || []).find((p) => p.id === (g.by_phase || 'p1')) || null;
      const by = isISODate(g.by_date) ? g.by_date : p1?.start ? addDays(p1.start, p1.weeks * 7 - 1) : null;
      const byText = by ? ` by the end of Phase 1 (${fmtDay(by, { year: true })})` : ' by the end of Phase 1';
      if (!isNum(base)) out.push({ goal: g, state: 'waiting', headline: `+${nf0.format(pct)}% on your baseline`, detail: `Estimated 1RM ${nf0.format(pct)}% above ${where}${byText}.${bStart ? ` That baseline comes from the week of ${fmtDay(bStart, { year: true })}: log the plates and reps exactly.` : ''}`, progress: null });
      else {
        const gain = isNum(now) ? (100 * (now - base)) / base : 0;
        out.push({ goal: g, state: gain >= pct ? 'met' : 'on-track', headline: `${gain >= 0 ? '+' : '−'}${nf0.format(Math.abs(gain))}% of +${nf0.format(pct)}%`, detail: `Estimated 1RM ${nf1.format(now ?? base)} kg against your Re-entry Week baseline of ${nf1.format(base)} kg (Epley, from your best set). Goal: +${nf0.format(pct)}%${byText}.`, progress: { value: Math.max(0, gain), max: pct } });
      }
    } else if (g.id === 'protein') {
      const need = Number(g.days) || 6;
      if (notStarted) { out.push(waitingAll(g, `Protein target on ${need} of 7 days`)); continue; }
      // Programme days only: last week is judged only if it was a programme week.
      const w = ctx && start && lastWeekStart >= start ? weekSummary(ctx, lastWeekStart) : null;
      const cur = ctx ? weekSummary(ctx, mondayOf(today)) : null;
      if (!w || !w.proteinTarget) out.push({ goal: g, state: 'waiting', headline: `Protein target on ${need} of 7 days`, detail: 'Log a weight to set your protein target, then log protein in the check-in.', progress: null });
      else out.push({ goal: g, state: w.proteinDays >= need ? 'met' : 'behind', headline: `${nf0.format(cur.proteinDays)} of 7 days this week`, detail: `Last week: ${nf0.format(w.proteinDays)} of 7 days at ${nf0.format(w.proteinTarget)} g or more.`, progress: { value: cur.proteinDays, max: need } });
    } else if (g.id === 'adherence') {
      const pct = Number(g.pct) || 80;
      if (notStarted || !ctx || lastWeekEnd < start) { out.push(waitingAll(g, `${nf0.format(pct)}% of planned sessions done`)); continue; }
      let done = 0;
      let planned = 0;
      let weeks = 0;
      for (let m = lastWeekStart; m >= start && weeks < ADHERENCE_WEEKS; m = addDays(m, -7)) {
        const s = weekSummary(ctx, m);
        if (!s.mainPlanned) continue;
        weeks += 1;
        done += s.mainDone;
        planned += s.mainPlanned;
      }
      if (!planned) { out.push({ goal: g, state: 'waiting', headline: `${nf0.format(pct)}% of planned sessions done`, detail: 'No planned sessions in the weeks so far.', progress: null }); continue; }
      const share = Math.round((100 * done) / planned);
      out.push({
        goal: g, state: share >= pct ? 'met' : 'behind', headline: `${nf0.format(share)}% of planned sessions done`,
        detail: `${nf0.format(done)} of ${nf0.format(planned)} planned sessions over the last ${weeks === 1 ? 'week' : `${weeks} weeks`} (goal ${pct}% or more). On a bad day, the short session still counts.`,
        progress: { value: share, max: 100 },
      });
    }
  }
  return out;
}

export const GOAL_STATE_LABEL = { met: 'Goal met', 'on-track': 'On track', behind: 'Behind', ahead: 'Faster than planned', hold: 'Holding steady', waiting: 'Not started yet' };

/** Days until a date (for "by 31 Jan"). */
export const daysTo = (today, iso) => (isISODate(iso) ? daysBetween(today, iso) : null);
