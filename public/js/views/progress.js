// #/progress: goals, then charts over a chosen range (one filter row scopes every chart).
//
// PERF3: every chart is built from one pass over the data. Workouts and hikes are bucketed by
// week once; ranges over a year show weekly averages instead of daily points; dots are only
// drawn for short series (charts.js); "All time" covers at most the last three years.

import { h, fmtNum, fmtFixed, fmtSigned, toast } from '../dom.js';
import { addDays, daysBetween, fmtDay, fmtShort, isISODate, mondayOf, todayISO } from '../dates.js';
import { isGateMet } from '../schedule.js';
import { isNum, rollingMean, weeklyChange, e1rm } from '../calc.js';
import { series, doneWorkouts, testResults, sessionType } from '../stats.js';
import { pageHead, section, sheet, numberField, selectField, dateField, textField, emptyState, missingContent, gateLabel, guard, statusIcon } from '../components.js';
import { timeChart, columnChart, weeklyMeans, meter } from '../charts.js';
import { readinessChart } from '../features/readinesschart.js';
import { content, exName } from '../content.js';
import { formDraft } from '../features/drafts.js';
import { evaluateGoals, goalsOf, setGoal, GOAL_STATE_LABEL } from '../features/goals.js';
import { testStatus } from '../features/testplan.js';
import { alternates, plannedZone2Week, isZ2 } from '../features/plan.js';
import { icon } from '../features/icons.js';
import { weightVerdict, bandText, verdictLine } from '../features/weight.js';
import { fastingOn } from '../features/safety.js';
import * as store from '../store.js';
import { buildTimeline } from '../schedule.js';

export const title = 'Progress';

const ALL_TIME_MAX_DAYS = 3 * 365;
const WEEKLY_AFTER_DAYS = 365;
const RANGES = [[28, '4 weeks'], [84, '12 weeks'], [182, '6 months'], [365, '1 year'], [0, 'All time']];
let range = 84;
let measureKey = 'waist_cm';
let strengthId = null;
let testId = null;

export const MEASURES = [
  ['waist_cm', 'Waist'], ['chest_cm', 'Chest'], ['hips_cm', 'Hips'], ['thigh_cm', 'Thigh'], ['calf_cm', 'Calf'],
  ['arm_good_cm', 'Upper arm, good side'], ['arm_injured_cm', 'Upper arm, injured side'],
  ['forearm_good_cm', 'Forearm, good side'], ['forearm_injured_cm', 'Forearm, injured side'],
];

function rangeStart(data, today) {
  if (range) return addDays(today, -(range - 1));
  let first = null;
  for (const list of [data.checkins, data.workouts, data.hikes, data.tests, data.measurements]) {
    for (const x of Array.isArray(list) ? list : []) if (x && isISODate(x.date) && x.date <= today && (!first || x.date < first)) first = x.date;
  }
  const cap = addDays(today, -(ALL_TIME_MAX_DAYS - 1));
  if (!first) return addDays(today, -27);
  return first < cap ? cap : first;
}

const within = (from, to) => (p) => p.date >= from && p.date <= to;
const isLong = (from, to) => daysBetween(from, to) > WEEKLY_AFTER_DAYS;

/** Points for a range: daily, or weekly means when the range is over a year. */
function rangePoints(points, from, to) {
  const inRange = points.filter(within(from, to));
  return isLong(from, to) ? weeklyMeans(inRange) : inRange;
}

// ---------------------------------------------------------------- one-pass indexes

/** Per-week buckets of workouts and hikes, built once: Map(monday -> {z2, sessions, strength}). */
function weekBuckets(data, program) {
  const out = new Map();
  const get = (m) => { if (!out.has(m)) out.set(m, { z2: 0, sessions: 0, strength: 0 }); return out.get(m); };
  const alt = alternates(program);
  const addonIds = new Set((program?.addons || []).map((a) => a && a.session).filter(Boolean));
  const notStrength = new Set([...addonIds, alt.short, alt.travel].filter(Boolean));
  for (const w of doneWorkouts(data)) {
    if (!isISODate(w.date)) continue;
    const b = get(mondayOf(w.date));
    b.sessions += 1;
    if (sessionType(w, program) === 'strength' && !notStrength.has(w.session_id)) b.strength += 1;
    for (const c of Array.isArray(w.cardio) ? w.cardio : []) if (c && isZ2(c.zone) && isNum(c.minutes)) b.z2 += Number(c.minutes);
  }
  for (const hk of Array.isArray(data.hikes) ? data.hikes : []) {
    if (hk && isISODate(hk.date) && !hk.workout_id && isNum(hk.duration_min)) get(mondayOf(hk.date)).z2 += Number(hk.duration_min);
  }
  return out;
}

/** Per-exercise session bests in one pass (the same numbers as stats.exerciseHistory). */
function historyIndex(data) {
  const out = new Map();
  for (const w of doneWorkouts(data)) {
    if (!isISODate(w.date)) continue;
    const per = new Map();
    for (const e of Array.isArray(w.exercises) ? w.exercises : []) {
      if (!e || typeof e.exercise !== 'string') continue;
      for (const s of Array.isArray(e.sets) ? e.sets : []) {
        if (!s || s.done === false || !(isNum(s.reps) || isNum(s.seconds) || isNum(s.kg))) continue;
        const r = per.get(e.exercise) || { date: w.date, bestE1rm: null, topKg: null, bestReps: null, bestSeconds: null };
        const v = e1rm(s.kg, s.reps);
        if (isNum(v) && (r.bestE1rm === null || v > r.bestE1rm)) r.bestE1rm = v;
        if (isNum(s.kg) && (r.topKg === null || Number(s.kg) > r.topKg)) r.topKg = Number(s.kg);
        if (isNum(s.reps) && (r.bestReps === null || Number(s.reps) > r.bestReps)) r.bestReps = Number(s.reps);
        if (isNum(s.seconds) && (r.bestSeconds === null || Number(s.seconds) > r.bestSeconds)) r.bestSeconds = Number(s.seconds);
        per.set(e.exercise, r);
      }
    }
    for (const [id, r] of per) {
      if (!out.has(id)) out.set(id, []);
      out.get(id).push(r);
    }
  }
  for (const list of out.values()) list.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  return out;
}

// ---------------------------------------------------------------- goals (PM9)

function goalShape(state) {
  if (state === 'met') return statusIcon('green', 18);
  if (state === 'behind') return statusIcon('amber', 18);
  return icon(state === 'waiting' || state === 'hold' ? 'clock' : 'target', 18, 'goal-ico');
}

function goalsSection(ctx) {
  const tl = content.program ? buildTimeline(content.program, ctx.data.profile) : null;
  const list = evaluateGoals({ data: ctx.data, program: content.program, today: ctx.today, timeline: tl });
  const all = goalsOf(ctx.data);
  const edit = (id, patch) => { setGoal(ctx.data, id, patch); store.touch(); };
  const editor = h('details', { class: 'disclose goal-editor' }, h('summary', null, 'Change your goals'),
    h('div', { class: 'form-grid', style: { 'margin-top': '12px' } },
      ...all.map((g) => {
        const on = h('div', { class: 'check' },
          h('input', { type: 'checkbox', id: `goal-on-${g.id}`, checked: g.enabled !== false, onChange: (e) => { edit(g.id, { enabled: e.target.checked }); ctx.rerender(); } }),
          h('label', { for: `goal-on-${g.id}` }, g.label));
        // The weight band isn't a setting: it follows your usual pre-injury weight (Settings).
        const field = g.id === 'weight' ? h('p', { class: 'field-hint' }, 'The weekly band comes from your usual weight before the injury: the regain band (+0.25 to +0.5 kg) until you’re back to it, then +0.15 to +0.3. ', h('a', { href: '#/settings' }, 'Set it in Settings'), '.')
          : g.id === 'zone2' ? numberField({ label: 'Zone 2 a week', unit: 'min', value: g.minutes, min: 30, max: 600, step: 10, onInput: (v) => { if (isNum(v)) edit(g.id, { minutes: v }); } })
            : g.id === 'leg-press' ? numberField({ label: 'Gain on your Re-entry Week baseline', unit: '%', value: g.pct, min: 5, max: 100, step: 5, hint: 'Estimated 1RM, by the end of Phase 1', onInput: (v) => { if (isNum(v)) edit(g.id, { pct: v }); } })
              : g.id === 'protein' ? numberField({ label: 'Days at the protein target', unit: 'of 7', value: g.days, min: 1, max: 7, step: 1, onInput: (v) => { if (isNum(v)) edit(g.id, { days: Math.round(v) }); } })
                : g.id === 'adherence' ? numberField({ label: 'Weeks with every session', unit: '%', value: g.pct, min: 50, max: 100, step: 5, onInput: (v) => { if (isNum(v)) edit(g.id, { pct: v }); } }) : null;
        return h('div', { class: 'goal-edit' }, on, field);
      })),
    h('p', { class: 'field-hint', style: { 'margin-top': '8px' } }, 'The starting goals come from chapter 01 of the guide. Rewrite them at each 12-week review.'));
  return section({ title: 'Your goals', id: 'goals', sub: 'Your 12-week goals, judged from what you log. Process goals come first: you control them completely.' },
    list.length ? h('ul', { class: 'goal-list' }, list.map((x) => h('li', { class: ['goal', 'sheet', 'sheet-tight', `goal-${x.state}`] },
      h('div', { class: 'goal-top' },
        h('span', { class: 'goal-shape' }, goalShape(x.state)),
        h('h3', { class: 'goal-name' }, x.goal.label),
        h('span', { class: 'goal-state' }, GOAL_STATE_LABEL[x.state] || '')),
      h('p', { class: 'goal-head' }, x.headline),
      x.progress ? meter({ value: x.progress.value, max: x.progress.max, label: `${x.goal.label}: progress`, valueText: x.headline }) : null,
      x.detail ? h('p', { class: 'goal-detail' }, x.detail) : null))) : h('p', { class: 'muted' }, 'All goals are switched off.'),
    editor);
}

// ---------------------------------------------------------------- body

function weightSection(ctx, from, to) {
  const pts = series(ctx.data, 'weight_kg').filter((p) => p.date <= to);
  const avgAll = rollingMean(pts);
  const avg = avgAll.filter(within(from, to));
  const long = isLong(from, to);
  const raw = long ? [] : pts.filter(within(from, to));
  const avgShown = long ? weeklyMeans(avg) : avg;
  // BT3-3/13: the band and the verdict come from the single fortnightly verdict (features/weight.js).
  const v = weightVerdict(ctx.data, to, { program: content.program });
  const fastNow = fastingOn(ctx.data, to);
  const b = v.band;
  let band = null;
  if (avg.length >= 2 && b) {
    const a = avg[0];
    const weeks = daysBetween(a.date, to) / 7;
    band = { label: `Your ${b.name}, ${bandText(b).replace(' a week', '')} a week`, points: [{ date: a.date, lo: a.value, hi: a.value }, { date: to, lo: a.value + b.lo * weeks, hi: a.value + b.hi * weeks }] };
  }
  const change = weeklyChange(pts, to);
  const total = avg.length >= 2 ? avg[avg.length - 1].value - avg[0].value : null;
  const bandSub = b?.kind === 'regain' ? 'While you’re below your usual pre-injury weight, the regain band is +0.25 to +0.5 kg a week: muscle you had before comes back faster than new muscle is built.'
    : b?.kind === 'lean' ? 'Back at your pre-injury weight: the lean-gain band is +0.15 to +0.3 kg a week.'
      : 'With no pre-injury weight set (Settings), the band is +0.2 to +0.4 kg a week.';
  return section({ title: 'Body weight', sub: `Daily weigh-ins bounce around. Watch the 7-day average against the band. ${bandSub}${long ? ' Over a year, each point is a week’s average.' : ''}` },
    sheet(null,
      h('div', { class: 'row', style: { gap: '24px', 'margin-bottom': '10px' } },
        h('p', null, h('span', { class: 'muted' }, 'Last week: '), h('strong', null, isNum(change) ? fmtSigned(change, 2, ' kg') : '–')),
        h('p', null, h('span', { class: 'muted' }, 'Over this range: '), h('strong', null, isNum(total) ? fmtSigned(total, 1, ' kg') : '–'))),
      h('p', { class: ['small', 'weight-verdict', fastNow || v.state === 'paused' ? 'is-hold' : null] }, verdictLine(v, { fastingNow: fastNow })),
      timeChart({
        title: 'Weight', unit: 'kg', dp: 1, height: 240, xDomain: [from, to], band,
        series: [
          ...(raw.length ? [{ label: 'Weigh-ins', cls: 'muted', points: raw, line: false, dots: 'all' }] : []),
          { label: long ? '7-day average, weekly' : '7-day average', cls: 's1', points: avgShown, endLabel: true },
        ],
        empty: 'Log your weight in the morning check-in to start this chart.',
      })));
}

function measurementSection(ctx, from, to) {
  const data = ctx.data;
  const label = (MEASURES.find(([k]) => k === measureKey) || MEASURES[0])[1];
  const chartHost = h('div');
  const drawChart = () => chartHost.replaceChildren(timeChart({ title: label, unit: 'cm', dp: 1, height: 200, series: [{ label, cls: 's1', points: rangePoints(series(data, measureKey, 'measurements'), from, to), dots: 'all', endLabel: true }], empty: 'No measurements in this range yet.' }));
  drawChart();
  // PE6: typed values live in a draft until Save, so a re-render or a date change keeps them.
  const draft = formDraft('measurements', { date: ctx.today });
  const form = draft.value;
  const status = h('p', { class: 'small muted draft-state', 'aria-live': 'polite' }, draft.dirty ? 'Not saved yet. Press Save measurements.' : '');
  const mark = () => { status.textContent = 'Not saved yet. Press Save measurements.'; };
  const fields = MEASURES.map(([k, l]) => numberField({ label: l, unit: 'cm', value: form[k], min: 10, max: 200, step: 0.1, fkey: `measure:${k}`, onInput: (v) => { draft.set(k, v); mark(); } }));
  const save = () => {
    if (!isISODate(form.date)) { toast('Pick a date first.'); return; }
    const vals = MEASURES.filter(([k]) => isNum(form[k]));
    if (!vals.length) { toast('Enter at least one measurement.'); return; }
    let rec = data.measurements.find((m) => m.date === form.date);
    if (!rec) {
      rec = { date: form.date };
      MEASURES.forEach(([k]) => { rec[k] = null; });
      data.measurements.push(rec);
      data.measurements.sort((a, b) => (a.date < b.date ? -1 : 1));
    }
    vals.forEach(([k]) => { rec[k] = form[k]; });
    store.touch();
    draft.clear();
    toast(`Measurements saved for ${fmtDay(form.date)}`);
    ctx.rerender();
  };
  const recent = data.measurements.filter((m) => isISODate(m.date)).sort((a, b) => (a.date < b.date ? 1 : -1)).slice(0, 8);
  return section({ title: 'Measurements', sub: 'Tape measurements every 2 to 4 weeks, same time of day. Compare the injured and good sides as the arm recovers.' },
    h('div', { class: 'grid grid-2' },
      sheet(null,
        h('div', { style: { 'max-width': '320px', 'margin-bottom': '10px' } }, selectField({ label: 'Show', value: measureKey, options: MEASURES.map(([k, l]) => ({ value: k, label: l })), onChange: (v) => { measureKey = v; drawChart(); } })),
        chartHost),
      sheet(null,
        h('h3', { class: 'mini-title' }, 'Add measurements'),
        h('div', { class: 'form-grid' }, dateField({ label: 'Date', value: form.date, max: todayISO(), onChange: (v) => { if (isISODate(v)) { draft.set('date', v); mark(); } } }), ...fields),
        h('div', { class: 'block-actions' },
          h('button', { type: 'button', class: 'btn btn-primary', onClick: save }, 'Save measurements'),
          draft.dirty ? h('button', { type: 'button', class: 'btn btn-ghost', onClick: () => { draft.clear(); ctx.rerender(); } }, 'Discard') : null),
        status,
        recent.length ? h('div', { class: 'table-wrap', style: { 'margin-top': '14px' } }, h('table', { class: 'table table-compact' },
          h('thead', null, h('tr', null, h('th', { scope: 'col' }, 'Date'), ...MEASURES.slice(0, 5).map(([, l]) => h('th', { scope: 'col', class: 'num' }, `${l} (cm)`)))),
          h('tbody', null, recent.map((m) => h('tr', null, h('th', { scope: 'row' }, fmtDay(m.date)), ...MEASURES.slice(0, 5).map(([k]) => h('td', { class: 'num' }, isNum(m[k]) ? fmtFixed(m[k], 1) : '–'))))))) : null)));
}

function strengthSection(ctx, from, to) {
  const index = historyIndex(ctx.data);
  const rows = [...index.entries()].map(([id, hist]) => {
    const best = hist.reduce((b, r) => (isNum(r.bestE1rm) && (!b || r.bestE1rm > b.bestE1rm) ? r : b), null);
    return { id, hist, best, last: hist[hist.length - 1] };
  }).filter((r) => r.hist.length).sort((a, b) => exName(a.id).localeCompare(exName(b.id)));
  if (!rows.length) {
    return section({ title: 'Strength' }, emptyState({ title: 'No strength sessions logged yet.', body: 'Log a session and your best sets will show here.', action: h('a', { class: 'btn', href: '#/train' }, 'Log a session') }));
  }
  if (!strengthId || !rows.some((r) => r.id === strengthId)) {
    const ranked = rows.slice().sort((a, b) => b.hist.filter((x) => x.bestE1rm).length - a.hist.filter((x) => x.bestE1rm).length);
    strengthId = ranked[0].id;
  }
  const host = h('div');
  const draw = () => {
    const r = rows.find((x) => x.id === strengthId);
    const hist = r.hist.filter(within(from, to));
    const metric = r.hist.some((x) => x.bestE1rm) ? 'e1rm' : r.hist.some((x) => x.bestSeconds) ? 'seconds' : 'reps';
    const val = (x) => (metric === 'e1rm' ? x.bestE1rm : metric === 'seconds' ? x.bestSeconds : x.bestReps);
    const label = metric === 'e1rm' ? 'Best estimated 1RM' : metric === 'seconds' ? 'Longest hold' : 'Most reps in a set';
    const pts = hist.filter((x) => isNum(val(x))).map((x) => ({ date: x.date, value: val(x) }));
    host.replaceChildren(timeChart({
      title: `${exName(strengthId)}: ${label.toLowerCase()}`, subtitle: metric === 'e1rm' ? 'Epley estimate from your best set each session (kg × (1 + reps ÷ 30)). For trends only.' : null,
      unit: metric === 'e1rm' ? 'kg' : metric === 'seconds' ? 's' : 'reps', dp: metric === 'e1rm' ? 1 : 0, height: 220, xDomain: [from, to],
      series: [{ label, cls: 's1', points: isLong(from, to) ? weeklyMeans(pts) : pts, dots: 'all', endLabel: true }],
      empty: 'No sessions with this exercise in the selected range.',
    }));
  };
  draw();
  return section({ title: 'Strength', sub: 'Pick an exercise to see its trend. Double progression means the line climbs in small steps.' },
    h('div', { class: 'grid grid-2' },
      sheet(null, h('div', { style: { 'max-width': '360px', 'margin-bottom': '10px' } }, selectField({ label: 'Exercise', value: strengthId, options: rows.map((r) => ({ value: r.id, label: exName(r.id) })), onChange: (v) => { strengthId = v; draw(); } })), host),
      sheet(null, h('h3', { class: 'mini-title' }, 'Personal bests'),
        h('div', { class: 'table-wrap' }, h('table', { class: 'table table-compact' },
          h('thead', null, h('tr', null, h('th', { scope: 'col' }, 'Exercise'), h('th', { scope: 'col', class: 'num' }, 'Best e1RM'), h('th', { scope: 'col', class: 'num' }, 'Top kg'), h('th', { scope: 'col', class: 'num' }, 'Best reps'), h('th', { scope: 'col', class: 'num' }, 'Last done'))),
          h('tbody', null, rows.map((r) => {
            let topKg = 0;
            let reps = 0;
            for (const x of r.hist) { if (x.topKg > topKg) topKg = x.topKg; if (x.bestReps > reps) reps = x.bestReps; }
            return h('tr', null,
              h('th', { scope: 'row' }, h('a', { href: `#/exercises/${encodeURIComponent(r.id)}` }, exName(r.id))),
              h('td', { class: 'num' }, r.best ? `${fmtFixed(r.best.bestE1rm, 1)} kg` : '–'),
              h('td', { class: 'num' }, topKg ? `${fmtNum(topKg, 2)} kg` : '–'),
              h('td', { class: 'num' }, reps ? fmtNum(reps) : '–'),
              h('td', { class: 'num' }, fmtDay(r.last.date)));
          })))))));
}

function engineSection(ctx, from, to) {
  const data = ctx.data;
  const program = content.program;
  const buckets = weekBuckets(data, program);
  const weeks = [];
  for (let m = mondayOf(from); m <= to; m = addDays(m, 7)) weeks.push(m);
  const bar = (m, key) => ({ key: m, label: fmtShort(m), tip: `Week of ${fmtDay(m)}`, value: buckets.get(m)?.[key] || 0 });
  const z2 = weeks.map((m) => bar(m, 'z2'));
  const sessions = weeks.map((m) => bar(m, 'sessions'));
  const strength = weeks.map((m) => bar(m, 'strength'));
  const plannedNow = program ? plannedZone2Week(program, data, mondayOf(to)) : 0;
  const tl = program ? buildTimeline(program, data.profile) : null;
  let sTarget = null;
  if (tl) {
    let cur = null;
    for (const it of tl.phases) if (it.start && it.start <= to) cur = it;
    sTarget = cur?.phase?.weekly_targets?.strength_sessions ?? null;
  }
  return section({ title: 'Engine and consistency', sub: 'Zone 2 counts cardio logged as Z2 plus your logged hikes. Add-ons and the short or gym-closed sessions don’t count as strength sessions.' },
    h('div', { class: 'grid grid-3' },
      sheet(null, columnChart({ title: 'Zone 2 minutes a week', subtitle: plannedNow > 0 ? `This week’s plan: ${fmtNum(plannedNow)} min.` : '', bars: z2, unit: 'min', empty: 'No Zone 2 work logged in this range.' })),
      sheet(null, columnChart({ title: 'Strength sessions a week', bars: strength, target: isNum(sTarget) ? Number(sTarget) : null, targetLabel: 'Target', empty: 'No strength sessions in this range.' })),
      sheet(null, columnChart({ title: 'All sessions a week', bars: sessions, empty: 'No sessions in this range.' }))));
}

function hikesSection(ctx, from, to) {
  const hikes = ctx.data.hikes.filter((x) => isISODate(x.date) && x.date >= from && x.date <= to).sort((a, b) => (a.date < b.date ? -1 : 1));
  const bars = (field) => hikes.map((x) => ({ key: x.id, label: fmtShort(x.date), tip: `${x.name || 'Hike'}, ${fmtDay(x.date)}`, value: isNum(x[field]) ? Number(x[field]) : 0 }));
  return section({ title: 'Hikes', sub: 'Distance and climb of each logged hike, side by side rather than on one axis.' },
    hikes.length ? h('div', { class: 'grid grid-2' },
      sheet(null, columnChart({ title: 'Distance', bars: bars('distance_km'), unit: 'km', dp: 1 })),
      sheet(null, columnChart({ title: 'Ascent', bars: bars('ascent_m'), unit: 'm', cls: 's1' })))
      : emptyState({ title: 'No hikes in this range.', body: 'Log hikes on the Hikes page.', action: h('a', { class: 'btn', href: '#/hikes' }, 'Open Hikes') }));
}

function testsSection(ctx, from, to) {
  const data = ctx.data;
  const tests = content.tests;
  if (!tests.length) return section({ title: 'Tests' }, missingContent('The test battery'));
  if (!testId || !tests.some((t) => t.id === testId)) testId = tests[0].id;
  const tl = content.program ? buildTimeline(content.program, data.profile) : { start: null, phases: [] };
  const host = h('div');
  const draw = () => {
    const t = tests.find((x) => x.id === testId);
    host.replaceChildren(timeChart({
      title: t.name || t.id, subtitle: `${t.higher_is_better === false ? 'Lower is better.' : 'Higher is better.'}${t.norms ? ` ${t.norms}` : ''}`,
      unit: t.unit || '', dp: 1, height: 200, series: [{ label: t.name || t.id, cls: 's1', points: testResults(data, t.id).filter(within(from, to)), dots: 'all', endLabel: true }],
      empty: 'No results for this test in the selected range.',
    }));
  };
  draw();
  const open = (t) => isGateMet(typeof t.gate === 'string' && t.gate ? t.gate : 'none', data.profile.clearances, ctx.today);
  const firstOpen = tests.find((t) => t.id === testId && open(t)) || tests.find(open) || tests[0];
  // PE6: the result form is a draft until Save.
  const draft = formDraft('test-result', { date: ctx.today, test: firstOpen.id, value: null, notes: '' });
  const form = draft.value;
  if (!tests.some((t) => t.id === form.test)) form.test = firstOpen.id;
  const save = () => {
    if (!isISODate(form.date) || !isNum(form.value)) { toast('Enter a date and a result.'); return; }
    const t = tests.find((x) => x.id === form.test);
    if (!t || !open(t)) { toast('That test isn’t open to you yet.'); return; }
    data.tests.push({ date: form.date, test: form.test, value: form.value, notes: form.notes });
    store.touch();
    draft.clear();
    toast('Test result saved');
    testId = form.test;
    ctx.rerender();
  };
  const latest = tests.map((t) => {
    const res = testResults(data, t.id);
    return { t, first: res[0] || null, last: res[res.length - 1] || null, st: testStatus(data, t, ctx.today, tl) };
  });
  const phaseName = (id) => tl.phases?.find((p) => p.id === id)?.short || 'a later phase';
  const nextText = ({ t, last, st }) => {
    if (st.state === 'locked') return `Locked: ${gateLabel(t.gate)}`;
    if (st.state === 'due') return last ? 'Due now' : 'Baseline due now';
    if (st.fasting) return 'After the fast';
    if (st.dueOn) return last ? fmtDay(st.dueOn) : `From ${fmtDay(st.dueOn)}`;
    if (st.waitingPhase || t.first_phase) return `When ${phaseName(st.waitingPhase || t.first_phase)} week ${t.first_week || 1} starts`;
    return last ? '–' : 'Not scheduled yet';
  };
  return section({ title: 'Tests', id: 'tests', sub: 'Each test is due only from its scheduled time, then every few weeks. Test on green mornings, and only what your gate allows.' },
    h('div', { class: 'grid grid-2' },
      sheet(null, h('div', { style: { 'max-width': '360px', 'margin-bottom': '10px' } }, selectField({ label: 'Test', value: testId, options: tests.map((t) => ({ value: t.id, label: t.name || t.id })), onChange: (v) => { testId = v; draw(); } })), host),
      sheet(null, h('h3', { class: 'mini-title' }, 'Log a test result'),
        h('div', { class: 'form-grid' },
          dateField({ label: 'Date', value: form.date, max: todayISO(), onChange: (v) => { if (isISODate(v)) draft.set('date', v); } }),
          selectField({ label: 'Test', value: form.test, options: tests.map((t) => ({ value: t.id, label: open(t) ? `${t.name || t.id}${t.unit ? ` (${t.unit})` : ''}` : `${t.name || t.id} (locked: ${gateLabel(t.gate)})`, disabled: !open(t) })), onChange: (v) => draft.set('test', v) }),
          numberField({ label: 'Result', min: 0, step: 'any', value: form.value, hint: 'In the test’s own unit', fkey: 'test-result:value', onInput: (v) => draft.set('value', v) }),
          h('div', { class: 'span-all' }, textField({ label: 'Notes', value: form.notes, fkey: 'test-result:notes', onInput: (v) => draft.set('notes', v) }))),
        h('div', { class: 'block-actions' },
          h('button', { type: 'button', class: 'btn btn-primary', onClick: save }, 'Save result'),
          draft.dirty ? h('button', { type: 'button', class: 'btn btn-ghost', onClick: () => { draft.clear(); ctx.rerender(); } }, 'Discard') : null))),
    h('div', { class: 'table-wrap', style: { 'margin-top': '14px' } }, h('table', { class: 'table table-compact' },
      h('thead', null, h('tr', null, ['Test', 'First', 'Latest', 'Change', 'Next due'].map((x, i) => h('th', { scope: 'col', class: i ? 'num' : null }, x)))),
      h('tbody', null, latest.map((row) => h('tr', null,
        h('th', { scope: 'row' }, row.t.name || row.t.id),
        h('td', { class: 'num' }, row.first ? `${fmtNum(row.first.value, 1)} ${row.t.unit || ''}` : '–'),
        h('td', { class: 'num' }, row.last ? `${fmtNum(row.last.value, 1)} ${row.t.unit || ''}` : '–'),
        h('td', { class: 'num' }, row.first && row.last && row.first !== row.last ? fmtSigned(row.last.value - row.first.value, 1) : '–'),
        h('td', { class: 'num' }, nextText(row))))))));
}

function recoverySection(ctx, from, to) {
  const d = ctx.data;
  const long = isLong(from, to);
  const mk = (field, label, unit, dp) => {
    const raw = series(d, field).filter((p) => p.date <= to);
    const avg = rollingMean(raw).filter(within(from, to));
    return sheet(null, timeChart({
      title: label, unit, dp, height: 180, xDomain: [from, to],
      series: [
        ...(long ? [] : [{ label: 'Each morning', cls: 'muted', points: raw.filter(within(from, to)), line: false, dots: 'all' }]),
        { label: long ? '7-day average, weekly' : '7-day average', cls: 's1', points: long ? weeklyMeans(avg) : avg, endLabel: true },
      ],
      empty: `No ${label.toLowerCase()} logged in this range.`,
    }));
  };
  return section({ title: 'Recovery', sub: `${long ? 'Each point is a week’s average. ' : 'Grey dots are single mornings; the line is the 7-day average. '}A resting heart rate creeping up, or HRV and sleep sliding down, is worth raising at your weekly review.` },
    sheet({ style: { 'margin-bottom': '16px' } }, readinessChart({ data: d, from, to })),
    h('div', { class: 'grid grid-3' }, mk('rhr', 'Resting heart rate', 'bpm', 0), mk('hrv', 'HRV', 'ms', 0), mk('sleep_h', 'Sleep', 'h', 1)));
}

function armSection(ctx, from, to) {
  const logs = (ctx.data.arm.logs || []).filter((l) => isISODate(l.date) && l.values && typeof l.values === 'object');
  const pts = logs.filter((l) => isNum(l.values.grip_injured_kg) && isNum(l.values.grip_good_kg) && Number(l.values.grip_good_kg) > 0)
    .map((l) => ({ date: l.date, value: (100 * Number(l.values.grip_injured_kg)) / Number(l.values.grip_good_kg) }))
    .filter(within(from, to));
  return section({ title: 'Arm: grip strength', sub: 'Injured-side grip as a percentage of your good side. Log grip tests on the Your arm page when your physio says it’s OK.' },
    sheet(null, timeChart({
      title: 'Injured grip as % of good side', unit: '%', dp: 0, height: 200, xDomain: [from, to],
      series: [{ label: 'Injured side, % of good', cls: 's1', points: pts, dots: 'all', endLabel: true }],
      refs: [{ value: 100, label: 'Good side' }], yZero: true,
      empty: 'No grip measurements yet.',
    })));
}

export function render(ctx) {
  const page = h('div', { class: 'page' });
  page.append(pageHead({ title: 'Progress', lede: 'Trends over weeks, not days. One bad morning is noise; a month is a story.' }));
  page.append(guard('Your goals', () => goalsSection(ctx)));
  const to = ctx.today;
  const from = rangeStart(ctx.data, to);
  const capped = !range && daysBetween(from, to) >= ALL_TIME_MAX_DAYS - 1;
  page.append(h('div', { class: 'filters', role: 'group', 'aria-label': 'Date range' },
    h('div', { class: 'seg' }, RANGES.map(([d, l]) => h('button', { type: 'button', 'aria-pressed': String(range === d), onClick: () => { range = d; ctx.rerender(); } }, l))),
    h('p', { class: 'small muted' }, `${fmtDay(from)} to ${fmtDay(to)}${capped ? ' (all time shows the last three years)' : ''}${isLong(from, to) ? '. Weekly averages.' : ''}`)));
  page.append(guard('Body weight', () => weightSection(ctx, from, to)));
  page.append(guard('Measurements', () => measurementSection(ctx, from, to)));
  page.append(guard('Strength', () => strengthSection(ctx, from, to)));
  page.append(guard('Engine and consistency', () => engineSection(ctx, from, to)));
  page.append(guard('Hikes', () => hikesSection(ctx, from, to)));
  page.append(guard('Tests', () => testsSection(ctx, from, to)));
  page.append(guard('Recovery', () => recoverySection(ctx, from, to)));
  page.append(guard('Arm: grip strength', () => armSection(ctx, from, to)));
  return page;
}
