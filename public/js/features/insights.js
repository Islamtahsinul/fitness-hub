// Coach insights: plain-English, rules-based nudges computed from the user's data.
// Pure functions only (no DOM), so they run in the browser and in tests/test_ui.mjs.
//
// Every rule takes the day it is judged on (`asOf`) and `today` separately, so the weekly
// review can ask "what did the week look like?" for a past week with the same logic.
// Each insight: {id, tone: 'alert'|'warn'|'info'|'good', priority (0-100), title, body,
// action: {label, href} | null, push: true when it asks for more training}.
//
// Readiness decides whether a day is easy (SPEC 5.8). Notes never recommend an easy day on
// their own; they point out trends, and they never push for more on intro, deload, amber or
// fasting weeks.

import { addDays, daysBetween, isISODate, mondayOf, fmtDay, weekdayIndex } from '../dates.js';
import { isNum, mean, proteinTargets } from '../calc.js';
import { zone2Minutes, latestValue, makeCtx, doneWorkouts } from '../stats.js';
import { buildTimeline, positionOn, highestGate, gateRank, gateList, CLEARANCE_GATES, addonActive, isRehabAddon, physioProgrammeReady } from '../schedule.js';
import { plannedZone2, plannedZone2Week, planOn, isIntroWeek } from './plan.js';
import { fastingInWeek, fastingOn, rhrMethodChanges, RISING_PAIN_MSG } from './safety.js';
import { testsDueOn } from './testplan.js';
import { weightVerdict, bandText } from './weight.js';

const nf0 = new Intl.NumberFormat('en-GB', { maximumFractionDigits: 0 });
const nf1 = new Intl.NumberFormat('en-GB', { maximumFractionDigits: 1, minimumFractionDigits: 1 });
const nf2 = new Intl.NumberFormat('en-GB', { maximumFractionDigits: 2, minimumFractionDigits: 1 });
const n0 = (v) => nf0.format(v);
const signed2 = (v) => `${v > 0 ? '+' : v < 0 ? '−' : '±'}${nf2.format(Math.abs(v))}`;

/** Exercise categories as words (never ids). */
const CATEGORY_WORDS = { 'knee-ankle': 'knee and ankle', 'single-leg': 'single-leg', conditioning: 'conditioning', rehab: 'rehab', mobility: 'mobility', core: 'core', grip: 'grip', carry: 'carry', push: 'push', pull: 'pull', hinge: 'hinge', squat: 'squat', calves: 'calf', hip: 'hip', balance: 'balance', power: 'power' };
const categoryWord = (c) => CATEGORY_WORDS[c] || String(c || 'other').replace(/[-_]/g, ' ');
const plural = (n, one, many = `${one}s`) => `${n0(n)} ${n === 1 ? one : many}`;
const listText = (names, max = 3) => {
  const shown = names.slice(0, max);
  const extra = names.length - shown.length;
  if (extra > 0) return `${shown.join(', ')} and ${plural(extra, 'more', 'more')}`;
  if (shown.length <= 1) return shown.join('');
  return `${shown.slice(0, -1).join(', ')} and ${shown[shown.length - 1]}`;
};

function checkins(data) {
  return (Array.isArray(data?.checkins) ? data.checkins : []).filter((c) => c && isISODate(c.date));
}

/** Values of a check-in field dated in [from, to], oldest first. */
function valuesBetween(data, field, from, to) {
  return checkins(data)
    .filter((c) => c.date >= from && c.date <= to && isNum(c[field]))
    .sort((a, b) => (a.date < b.date ? -1 : 1))
    .map((c) => ({ date: c.date, value: Number(c[field]) }));
}

/** The last fully finished day: asOf itself for past days, otherwise the day before. */
const lastFullDay = (asOf, today) => (asOf < today ? asOf : addDays(asOf, -1));

// ---------------------------------------------------------------- protein

export function proteinStreak(data, { asOf, today = asOf } = {}) {
  const weight = latestValue(data, 'weight_kg', asOf);
  if (!weight) return null;
  const prot = proteinTargets(weight.value, data?.profile?.protein_g_per_kg);
  if (!prot) return null;
  const target = Math.round(prot.target);
  const byDate = new Map(checkins(data).map((c) => [c.date, c]));
  const under = [];
  for (let d = lastFullDay(asOf, today), i = 0; i < 60; i++, d = addDays(d, -1)) {
    const c = byDate.get(d);
    if (!c || !isNum(c.protein_g) || Number(c.protein_g) >= target) break;
    under.push(Number(c.protein_g));
  }
  if (under.length < 3) return null;
  const avg = Math.round(mean(under));
  return {
    id: 'protein-streak', tone: 'warn', priority: 60 + Math.min(10, under.length - 3), push: false,
    title: `Protein under target ${n0(under.length)} days running`,
    body: `You’ve averaged ${n0(avg)} g a day against your ${n0(target)} g target. Muscle and healing bone are both built from it. Add one cheap protein hit a day: a pint of milk (about 20 g), two eggs (about 12 g) or a tin of tuna (about 25 g).`,
    action: { label: 'Protein foods', href: '#/nutrition' },
    data: { days: under.length, avg, target },
  };
}

// ---------------------------------------------------------------- zone 2

/** Planned Zone 2 minutes still to come in the week (sessions not yet logged). */
export function plannedZone2Remaining(sctx, from, weekEnd) {
  const logged = new Set(doneWorkouts(sctx.data).map((w) => `${w.date}|${w.session_id}`));
  return plannedZone2(sctx.program, sctx.data, from, weekEnd, { timeline: sctx.timeline, doneOn: (d, sid) => logged.has(`${d}|${sid}`) });
}

const about5 = (n) => Math.max(5, Math.ceil(n / 5) * 5);
const QUIET_WEEK = { intro: 'This is an intro week', deload: 'This is a deload week', fasting: 'You’re fasting this week', easy: 'Today is an easy day' };
const QUIET_PAST = { intro: 'an intro week', deload: 'a deload week', fasting: 'a fasting week', easy: 'an easy week' };

/** Thursday: before it, a Zone 2 gap is still easy to close with the sessions planned (BT3-15). */
export const ZONE2_FROM_DAY = 3;

/**
 * CL6 / BT3-14/15. The week's target is the programme's planned Zone 2 minutes for that week
 * (features/plan.js, the one source every page uses), not a phase-wide number. Intro, deload,
 * amber and fasting weeks never get a "do more" push. Extra minutes are always suggested in
 * daylight or on the treadmill: never an outdoor walk after dark.
 * Shown only when it means something: a live note is `hidden` on rest days and while the week is
 * on track, and a shortfall is raised from Thursday. A finished week (the weekly review) always
 * reports. `hidden` notes keep their data for pages that show the numbers.
 */
export function zone2Status(data, program, { asOf, today = asOf, readiness = 'unknown' } = {}) {
  if (!program) return null;
  const sctx = makeCtx({ program, profile: data.profile, data, today });
  const pos = positionOn(sctx.timeline, asOf);
  if (!pos) return null;
  const weekStart = mondayOf(asOf);
  const weekEnd = addDays(weekStart, 6);
  const target = plannedZone2Week(program, data, weekStart, { timeline: sctx.timeline });
  if (!(target > 0)) return null;
  const done = zone2Minutes(data, weekStart, weekEnd);
  const finished = asOf >= weekEnd && today > weekEnd;
  const remaining = finished ? 0 : plannedZone2Remaining(sctx, today > weekStart ? today : weekStart, weekEnd);
  const plan = planOn(program, data, asOf, sctx.timeline);
  const restDay = !plan.sessions.some((e) => e.source === 'template' && !e.isRest);
  const why = isIntroWeek(plan) ? 'intro' : plan.override?.deload ? 'deload' : fastingInWeek(data, weekStart) ? 'fasting'
    : readiness === 'amber' || readiness === 'red' ? 'easy' : null;
  const base = { action: { label: 'Log a walk or ride', href: `#/train/${asOf <= today ? asOf : today}/adhoc` }, data: { done, target, remaining, quiet: why, restDay } };
  if (done >= target) {
    return { ...base, id: 'zone2', tone: 'good', priority: 18, push: false, action: null, hidden: !finished && restDay,
      title: `Zone 2 done for the week: ${n0(done)} of ${n0(target)} min`,
      body: 'That’s the planned engine work for the week. Anything more is a bonus, not a requirement.' };
  }
  if (finished) {
    const short = target - done;
    return { ...base, id: 'zone2', tone: why ? 'info' : short >= 30 ? 'warn' : 'info', priority: 45, push: false, action: null,
      title: `Zone 2 finished ${n0(short)} min short`,
      body: why
        ? `${n0(done)} of ${n0(target)} min. It was ${QUIET_PAST[why]}, so that’s fine: there’s nothing to make up.`
        : `${n0(done)} of ${n0(target)} min this week. Next week, put the easy minutes where they’re hardest to skip: 10 extra minutes on the bike or treadmill straight after strength, or a daylight walk at lunch.` };
  }
  const projected = done + remaining;
  const shortfall = target - projected;
  const dayIdx = weekdayIndex(asOf);
  if (shortfall >= 10 && dayIdx >= ZONE2_FROM_DAY) {
    if (why) {
      return { ...base, id: 'zone2', tone: 'info', priority: 20, push: false, action: null, hidden: restDay,
        title: `Zone 2 so far: ${n0(done)} of ${n0(target)} min`,
        body: `${QUIET_WEEK[why]}, so don’t chase the minutes. Do what’s planned and keep it easy.` };
    }
    const daysLeft = Math.max(1, 7 - weekdayIndex(today > weekStart ? today : weekStart));
    const perDay = about5(shortfall / daysLeft);
    const planned = remaining > 0 ? `The sessions left this week add ${n0(remaining)} min, which still leaves you ${n0(shortfall)} min short.` : `Nothing else is planned this week, so you’re ${n0(shortfall)} min short.`;
    let fix;
    if (shortfall <= 40) fix = `Add about ${n0(about5(shortfall))} minutes: a brisk walk in daylight on good paths, or the treadmill or bike at the gym.`;
    else if (daysLeft >= 2 && perDay <= 45) fix = `Spread it out: about ${n0(perDay)} minutes on each of the ${n0(daysLeft)} days left, as a daylight walk or on the treadmill.`;
    else fix = 'That’s too much to make up now, so don’t cram it. Do what’s planned and start next week’s easy minutes early.';
    return { ...base, id: 'zone2', tone: shortfall >= 30 ? 'warn' : 'info', priority: 52 + Math.min(10, Math.round(shortfall / 10)), push: true, hidden: restDay,
      title: `Zone 2 is behind: ${n0(done)} of ${n0(target)} min`,
      body: `${planned} ${fix}` };
  }
  return { ...base, id: 'zone2', tone: 'info', priority: 8, push: false, action: null, hidden: true,
    title: `Zone 2 on track: ${n0(done)} of ${n0(target)} min`,
    body: remaining > 0 ? `${n0(remaining)} min more is planned this week.` : 'Keep the easy minutes easy: you should be able to talk in full sentences.' };
}

// ---------------------------------------------------------------- weight

/**
 * PM6, chapter 14 and SPEC 5.2 round 4: the single fortnightly verdict (features/weight.js) on
 * non-overlapping 14-day windows from the programme start, with at least 10 weigh-ins, against
 * your band (regain while below your pre-injury weight, then lean gain). The note appears for
 * the week after each check, so it never nags daily. Fasting windows and the 14 days after a
 * fast give no gain nudges: the aim is to hold steady.
 */
export function weightTrend(data, { asOf, programStart = null, program = null } = {}) {
  if (!isISODate(asOf)) return null;
  const firstWeigh = valuesBetween(data, 'weight_kg', '0000-01-01', asOf)[0];
  const start = isISODate(programStart) ? programStart : firstWeigh && !program ? mondayOf(firstWeigh.date) : null;
  const v = weightVerdict(data, asOf, { start, program });
  if (!v || !v.window || v.state === 'waiting' || v.state === 'insufficient') return null;
  if (v.window.to > asOf || daysBetween(v.window.to, asOf) > 6) return null;
  const change = isNum(v.rate) ? v.rate : null;
  const c = isNum(change) ? Math.round(change * 100) / 100 : 0;
  const twice = typeof v.twice === 'boolean' ? v.twice : !!v.prev && v.prev.state === v.state;
  const action = { label: 'Your targets', href: '#/nutrition' };
  const data2 = { change, review: v.window.to, band: v.band, state: v.state };
  const band = bandText(v.band);
  if (fastingOn(data, asOf) || (v.state === 'paused' && v.reason !== 'after-fasting')) {
    return { id: 'weight', tone: 'info', priority: 12, push: false, action: null, data: data2,
      title: isNum(change) ? `Weight check: ${signed2(c)} kg a week` : 'Weight check: hold steady',
      body: 'You’re fasting, so there’s no push to gain: the aim for now is to hold your weight steady at about maintenance (your calorie target without the surplus), spread across the meals your fast allows.' };
  }
  if (v.state === 'paused') {
    return { id: 'weight', tone: 'info', priority: 12, push: false, action: null, data: data2,
      title: 'Weight check: holding after the fast',
      body: `No gain nudges for 14 days after a fast. Ease back to your usual meals; the next verdict counts from ${fmtDay(v.nextCheck || addDays(v.window.to, 14))}.` };
  }
  if (v.state === 'losing') {
    return { id: 'weight', tone: 'warn', priority: 66, push: false, action, data: data2,
      title: `Weight is drifting down: ${signed2(c)} kg a week`,
      body: 'No dieting while the bone heals. Add 250–300 kcal a day, and check you’re eating every planned meal.' };
  }
  if (v.state === 'below') {
    return { id: 'weight', tone: 'info', priority: 40, push: false, action, data: data2,
      title: `Weight gain is below your band: ${signed2(c)} kg a week`,
      body: `Your ${v.band.name} is ${band}. Add 150–200 kcal a day, such as a glass of milk and a banana.${twice ? ' That’s twice in a row, so move up one meal-plan level on the Nutrition page.' : ''}` };
  }
  if (v.state === 'in') {
    return { id: 'weight', tone: 'good', priority: 14, push: false, action: null, data: data2,
      title: `Weight is on target: ${signed2(c)} kg a week`,
      body: `Change nothing: that’s inside your ${v.band.name}, ${band}.${v.band.kind === 'regain' ? ' Muscle you had before comes back faster than new muscle is built.' : ''}` };
  }
  return { id: 'weight', tone: 'info', priority: 30, push: false, action, data: data2,
    title: `Gaining faster than planned: ${signed2(c)} kg a week`,
    body: `That’s above your ${v.band.name}, ${band}. Take off 100–150 kcal a day, such as a slice of toast or a small snack, and stay above maintenance.${twice ? ' That’s twice in a row, so move down one meal-plan level on the Nutrition page.' : ''}` };
}

// ---------------------------------------------------------------- resting heart rate

/**
 * A trend note only (CL15): readiness, not this note, decides whether a day is easy, so it never
 * recommends an easy day. Readings from before a change of measuring method
 * (profile.rhr_method_changes) are never compared with readings after it.
 */
export function rhrTrend(data, { asOf } = {}) {
  let since = '0000-01-01';
  for (const d of rhrMethodChanges(data?.profile)) if (d <= asOf) since = d;
  const from = (d) => (d > since ? d : since);
  const recent = valuesBetween(data, 'rhr', from(addDays(asOf, -2)), asOf);
  if (recent.length < 2) return null;
  const hist = valuesBetween(data, 'rhr', from(addDays(asOf, -30)), addDays(asOf, -3));
  const baseline = hist.length >= 5 ? mean(hist.map((p) => p.value))
    : since === '0000-01-01' && isNum(data?.profile?.rhr_baseline) ? Number(data.profile.rhr_baseline) : null;
  if (!isNum(baseline)) return null;
  const avg = mean(recent.map((p) => p.value));
  const diff = avg - baseline;
  const consistent = recent.every((p) => p.value >= baseline + 1);
  if (diff < 3 || !consistent) return null;
  return {
    id: 'rhr-up', tone: 'info', priority: diff >= 5 ? 72 : 64, push: false,
    title: `Resting heart rate is trending up: about ${n0(Math.round(diff))} bpm`,
    body: `Your last ${plural(recent.length, 'morning')} averaged ${n0(Math.round(avg))} bpm against your usual ${n0(Math.round(baseline))}. A rise like this often comes with fatigue, short sleep or a bug coming on, so watch it and protect your sleep. Your morning check-in decides how hard each day should be.`,
    action: { label: 'Today’s check-in', href: '#/checkin' },
    data: { avg, baseline, diff },
  };
}

// ---------------------------------------------------------------- sleep

export function sleepShort(data, { asOf } = {}) {
  const vals = valuesBetween(data, 'sleep_h', addDays(asOf, -6), asOf);
  if (vals.length < 4) return null;
  const avg = mean(vals.map((p) => p.value));
  if (avg >= 6.5) return null;
  return {
    id: 'sleep', tone: avg < 6 ? 'warn' : 'info', priority: avg < 6 ? 50 : 38, push: false,
    title: `Sleep is averaging ${nf1.format(avg)} h`,
    body: 'Muscle and bone both repair while you sleep, so aim for 7 to 9 hours. A fixed lights-out time is the easiest lever: count back 8 hours from your alarm.',
    action: { label: 'Sleep and recovery', href: '#/guide/17-sleep-and-recovery.md' },
    data: { avg },
  };
}

// ---------------------------------------------------------------- arm pain

export function armPainTrend(data, { asOf } = {}) {
  const now = valuesBetween(data, 'arm_pain', addDays(asOf, -6), asOf);
  const before = valuesBetween(data, 'arm_pain', addDays(asOf, -13), addDays(asOf, -7));
  if (now.length < 3) return null;
  const avgNow = mean(now.map((p) => p.value));
  const avgBefore = before.length >= 3 ? mean(before.map((p) => p.value)) : null;
  const rising = avgBefore !== null && avgNow - avgBefore >= 1.5;
  if (!rising && avgNow < 4) return null;
  return {
    id: 'arm-pain', tone: 'warn', priority: 80, push: false,
    title: rising ? 'Arm pain is creeping up' : `Arm pain is averaging ${nf1.format(avgNow)}/10`,
    body: `${rising ? `This week it’s averaged ${nf1.format(avgNow)}/10, against ${nf1.format(avgBefore)} the week before. ` : ''}Keep exercise pain at 2/10 or less and tell your clinic or physio. ${RISING_PAIN_MSG}`,
    action: { label: 'Your arm', href: '#/arm' },
    data: { avgNow, avgBefore },
  };
}

// ---------------------------------------------------------------- tests

/** PM2: tests are due only from their scheduled time (features/testplan.js), and only those your gate allows. */
export function testsDue(data, tests, { asOf, programStart = null, timeline = null } = {}) {
  const list = Array.isArray(tests) ? tests.filter((t) => t && typeof t.id === 'string') : [];
  if (!list.length) return null;
  const tl = timeline || { start: isISODate(programStart) ? programStart : null, phases: [] };
  if (tl.start && asOf < tl.start) return null;
  const due = testsDueOn(data, list, asOf, tl);
  if (!due.length) return null;
  const overdueDays = due.reduce((m, d) => Math.max(m, d.overdueDays), 0);
  const names = due.map((d) => d.test.name || d.test.id);
  return {
    id: 'tests-due', tone: 'info', priority: overdueDays >= 7 ? 48 : 42, push: true,
    title: due.length === 1 ? `Test due: ${names[0]}` : `${plural(due.length, 'test')} due`,
    body: `${due.length === 1 ? '' : `${listText(names)}. `}Retesting every few weeks shows real change that day-to-day numbers hide. Do them fresh, at the start of a session, on a green morning.`,
    action: { label: 'Log a result', href: '#/progress' },
    data: { ids: due.map((d) => d.test.id) },
  };
}

// ---------------------------------------------------------------- clinic

export function clinicInsight(data, { asOf, questions = [] } = {}) {
  const appts = (Array.isArray(data?.arm?.appointments) ? data.arm.appointments : []).filter((a) => a && isISODate(a.date));
  const recent = appts.filter((a) => a.date < asOf && a.date >= addDays(asOf, -3) && !String(a.outcome || '').trim())
    .sort((a, b) => (a.date < b.date ? 1 : -1))[0];
  if (recent) {
    return {
      id: 'clinic-followup', tone: 'info', priority: 74, push: false,
      title: `How did the ${String(recent.type || 'appointment').toLowerCase()} go?`,
      body: `Write down what they said on ${fmtDay(recent.date)} while it’s fresh. If they cleared anything, record the date: the programme unlocks the next exercises and phases from it, never before.`,
      action: { label: 'Record the outcome', href: '#/arm' },
      data: { date: recent.date },
    };
  }
  const next = appts.filter((a) => a.date >= asOf).sort((a, b) => (a.date < b.date ? -1 : 1))[0];
  if (!next) return null;
  const days = daysBetween(asOf, next.date);
  if (days > 14) return null;
  const asked = data?.arm?.questions && typeof data.arm.questions === 'object' ? Object.values(data.arm.questions).filter((q) => q && q.asked).length : 0;
  const total = Array.isArray(questions) ? questions.length : 0;
  const what = next.type || 'Appointment';
  const when = days === 0 ? 'today' : days === 1 ? 'tomorrow' : `in ${plural(days, 'day')}`;
  return {
    id: 'clinic-soon', tone: 'info', priority: days <= 1 ? 82 : days <= 7 ? 50 : 28, push: false,
    title: `${what} ${when}`,
    body: `${fmtDay(next.date, { year: true })}.${total ? ` Your list has ${plural(total, 'question')}${asked ? `, ${n0(asked)} already asked` : ''}.` : ''} Ask what you can do now, what comes next and when: good-arm training, light use, grip, physio.`,
    action: { label: 'Prepare your questions', href: '#/arm' },
    data: { date: next.date, days },
  };
}

// ---------------------------------------------------------------- clearances

export function recentClearance(data, program, exercises, { asOf } = {}) {
  const cl = data?.profile?.clearances || {};
  let best = null;
  for (const g of CLEARANCE_GATES) {
    const d = cl[g];
    if (!isISODate(d) || d > asOf || d < addDays(asOf, -13)) continue;
    if (!best || gateRank(g) > gateRank(best.gate)) best = { gate: g, date: d };
  }
  if (!best) return null;
  const before = highestGate(cl, addDays(best.date, -1));
  const after = highestGate(cl, best.date);
  if (gateRank(after) <= gateRank(before)) return null;
  const opened = (id) => gateRank(id) > gateRank(before) && gateRank(id) <= gateRank(after);
  const gates = gateList(program);
  const labelOf = (id) => gates.find((g) => g.id === id)?.label || 'A new clearance';
  const exs = (Array.isArray(exercises) ? exercises : []).filter((e) => e && opened(typeof e.gate === 'string' ? e.gate : 'full_clearance'));
  const byCat = new Map();
  for (const e of exs) byCat.set(e.category || 'other', (byCat.get(e.category || 'other') || 0) + 1);
  const cats = [...byCat.entries()].sort((a, b) => b[1] - a[1]).map(([c, n]) => `${n0(n)} ${categoryWord(c)}`);
  const label = labelOf(best.gate);
  const bits = [];
  if (exs.length) bits.push(`${plural(exs.length, 'exercise')} unlocked${cats.length ? `: ${listText(cats, 4)}` : ''}.`);
  if (program) {
    const tl = buildTimeline(program, data.profile);
    const phaseId = positionOn(tl, asOf)?.phaseId ?? null;
    for (const p of tl.phases) if (p.start && opened(p.entryGate) && p.index > 0) bits.push(`${p.short} ${p.start > asOf ? 'starts' : 'started'} ${fmtDay(p.start)}.`);
    for (const a of Array.isArray(program.addons) ? program.addons : []) {
      if (!a || !opened(typeof a.gate === 'string' && a.gate ? a.gate : 'none') || !addonActive(a, cl, asOf, phaseId)) continue;
      const name = a.name || program.sessions?.[a.session]?.name || 'An add-on';
      // BT2-4: say what's really true. The rehab add-on waits for the physio's programme.
      if (isRehabAddon(a, program) && !physioProgrammeReady(data)) bits.push(`${name}: waiting for your physio’s programme. Add their exercises on the Your arm page and it joins your plan.`);
      else bits.push(`${name} now runs alongside your sessions.`);
    }
  }
  if (!bits.length) bits.push('More of the programme is open to you now.');
  bits.push('Take every new movement easy the first time, and anything your physio says comes first.');
  const days = daysBetween(best.date, asOf);
  return {
    id: 'gate-cleared', tone: 'good', priority: days <= 3 ? 86 : 58, push: false,
    title: `New clearance: ${label} (${days === 0 ? 'today' : days === 1 ? 'yesterday' : `${plural(days, 'day')} ago`})`,
    body: bits.join(' '),
    action: { label: 'See what’s unlocked', href: '#/exercises' },
    data: { gate: best.gate, date: best.date, exercises: exs.length },
  };
}

// ---------------------------------------------------------------- all together

const TONE_RANK = { alert: 3, warn: 2, info: 1, good: 0 };

/**
 * All insights for a day, most important first.
 * readiness: 'red' | 'amber' | 'green' | 'unknown' (from features/safety.js readinessFor, the
 * single source). On a red day nothing that asks for more training is shown, nor the news of a
 * clearance; on an amber day tests are held back (they need you fresh) and Zone 2 never pushes.
 * Notes marked `hidden` (Zone 2 on a rest day, or on track) carry data only and aren't shown.
 */
export function coachInsights({ data, program = null, exercises = [], tests = [], questions = [], today, asOf = today, readiness = 'unknown', exclude = [] } = {}) {
  if (!data || !isISODate(asOf)) return [];
  // Nothing to say until there's something recent to say it about.
  const since = addDays(asOf, -13);
  const recent = (list) => (Array.isArray(list) ? list : []).some((x) => x && isISODate(x.date) && x.date >= since && x.date <= asOf);
  const cl = data.profile?.clearances || {};
  const recentGate = CLEARANCE_GATES.some((g) => isISODate(cl[g]) && cl[g] >= since && cl[g] <= asOf);
  const hasAppt = (Array.isArray(data.arm?.appointments) ? data.arm.appointments : []).some((a) => a && isISODate(a.date) && a.date >= addDays(asOf, -3) && a.date <= addDays(asOf, 14));
  if (!recent(data.checkins) && !recent(data.workouts) && !recent(data.hikes) && !recentGate && !hasAppt) return [];
  const timeline = program ? buildTimeline(program, data.profile) : null;
  const programStart = timeline ? timeline.start : null;
  const rules = [
    () => recentClearance(data, program, exercises, { asOf }),
    () => armPainTrend(data, { asOf }),
    () => clinicInsight(data, { asOf, questions }),
    () => rhrTrend(data, { asOf }),
    () => weightTrend(data, { asOf, programStart, program }),
    () => proteinStreak(data, { asOf, today }),
    () => zone2Status(data, program, { asOf, today, readiness }),
    () => sleepShort(data, { asOf }),
    () => testsDue(data, tests, { asOf, programStart, timeline }),
  ];
  const out = [];
  for (const rule of rules) {
    let r = null;
    try { r = rule(); } catch (e) { r = null; if (typeof console !== 'undefined') console.error('insight rule failed', e); }
    if (!r || r.hidden || exclude.includes(r.id)) continue;
    if (readiness === 'red' && (r.push || r.id === 'gate-cleared')) continue; // BT2-4: never on a red day
    if (readiness === 'amber' && (r.id === 'tests-due' || r.push)) continue;
    out.push(r);
  }
  return out.sort((a, b) => b.priority - a.priority || TONE_RANK[b.tone] - TONE_RANK[a.tone]);
}
