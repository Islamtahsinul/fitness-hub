// #/print[/YYYY-MM-DD]: a clean A4 week sheet for logging on paper at the gym (the hub itself
// stays at home). For every exercise it shows what you did last time and today's target load,
// with a box per set for what you actually did. Type the boxes in afterwards with
// "Enter from sheet" on the Log a session page: the order matches.

import { h, fmtNum, fmtMinutes } from '../dom.js';
import { addDays, fmtDay, fmtDayLong, isISODate, mondayOf, weekDates } from '../dates.js';
import { buildTimeline, positionOn, incrementFor, parseRepRange } from '../schedule.js';
import { isNum } from '../calc.js';
import { lastPerformance } from '../stats.js';
import { missingContent, gateLabel, gateText } from '../components.js';
import { content, exName } from '../content.js';
import { blockTarget, routineFor, sessionName, typeLabel, zoneText, isPhysioBlock, dash } from './shared.js';
import { isLocked, isAvailable, gateOf, progressionFor, holdReason, fastingOn, readinessFor } from '../features/safety.js';
import { resolveFor, planOn, blockKeys, lastPlannedSets, plannedZone2Week } from '../features/plan.js';
import { setTargets, setText, setsSummary } from '../features/sets.js';

export const title = 'Print this week';

const box = (label, wide = false) => h('span', { class: ['pw-box', wide && 'pw-box-wide'] }, h('span', null, label));

/**
 * "Last 12 Nov: 40 kg × 10, 10, 9" and "Target: 3 × 8 at 42.5 kg" for a strength or timed block.
 * The boxes are the day's effective sets (rb is resolved for the week, easy days halved), and the
 * suggestion is judged against LAST time's effective sets (SPEC 5.2 round 4, BT1-1).
 */
function lastAndTarget(ctx, rb, date, { sessionId = null, key = null, hold = null } = {}) {
  if (rb.kind !== 'strength' && rb.kind !== 'timed') return null;
  let last = null;
  try {
    last = lastPerformance(ctx.data, rb.exercise, addDays(date, -1), null, {
      program: content.program, sessionId, blockKey: key, reps: rb.kind === 'timed' ? null : rb.reps, seconds: rb.kind === 'timed' ? rb.seconds : null,
    });
  } catch { last = null; }
  const sets = last?.sets || [];
  const ex = content.exById.get(rb.exercise);
  const sug = rb.kind === 'strength' && rb.load === 'double-progression' && parseRepRange(rb.reps)
    ? progressionFor({ reps: rb.reps, lastSets: sets, increment: incrementFor(rb.exercise, ex, content.program?.rules), hold, setsPlanned: lastPlannedSets(content.program, ctx.data, last, rb.exercise) })
    : null;
  const bodyweight = rb.load === 'bodyweight' || rb.load === 'physio';
  const showKg = !bodyweight || sets.some((s) => isNum(s.kg));
  const targets = setTargets({ kind: rb.kind, reps: rb.reps, seconds: rb.seconds, count: rb.sets, lastSets: sets, suggestion: sug, showKg });
  const lastText = sets.length ? `Last ${fmtDay(last.date)}: ${sets.map(setText).filter(Boolean).join(', ')}` : 'No log yet';
  const targetText = sug?.kind === 'hold' && sug.reason === 'incomplete' ? `Repeat the load and log every set: ${setsSummary(targets)}`
    : sug?.kind === 'hold' ? `Hold: same load, RIR 3–4 (${setsSummary(targets)})`
    : sug?.kind === 'start' ? `Target: ${rb.sets} × ${dash(rb.reps)}. Start around a load you could do for 15; double progression finds your level within 2 sessions`
      : `Target: ${setsSummary(targets)}`;
  return { lastText, targetText, showKg };
}

function blockRow(ctx, rb, date, opts = {}) {
  const locked = rb.exercise && isLocked(rb.exercise, date, ctx.data);
  const away = rb.exercise && !locked && !isAvailable(rb.exercise, ctx.data);
  const name = rb.kind === 'circuit' ? 'Circuit' : exName(rb.exercise);
  let target = blockTarget(rb);
  if ((rb.kind === 'strength' || rb.kind === 'timed') && isNum(rb.rest_s)) target += `, rest ${rb.rest_s} s`;
  if (rb.tempo) target += `, tempo ${rb.tempo}`;
  if (rb.kind === 'cardio' && rb.zone) target = `${rb.minutes ?? '?'} min, ${zoneText(rb.zone, ctx.data.profile, ctx.today)}`;
  if (isPhysioBlock(rb)) {
    return h('div', { class: 'pw-block' },
      h('div', null, h('p', { class: 'pw-ex' }, 'Your physio’s programme'), h('p', { class: 'pw-target' }, blockTarget(rb))),
      h('span', { class: 'pw-boxes' }, box('Done ✓'), box('Minutes')));
  }
  let boxes;
  let lt = null;
  if (locked) {
    boxes = h('span', { class: 'pw-target' }, content.exById.has(rb.exercise) ? `Locked until “${gateLabel(gateOf(rb.exercise))}” is recorded. Skip it or do an easier version.` : 'Locked: not in the exercise library. Skip it.');
  } else if (away) {
    boxes = h('span', { class: 'pw-target' }, 'Not available at your gym: use a swap from the logger.');
  } else if (rb.kind === 'strength') {
    lt = lastAndTarget(ctx, rb, date, opts);
    boxes = h('span', { class: 'pw-boxes' }, Array.from({ length: rb.sets }, (_, k) => box(lt?.showKg === false ? `Set ${k + 1}: reps` : `Set ${k + 1}: kg × reps`, lt?.showKg !== false)));
  } else if (rb.kind === 'timed') {
    lt = lastAndTarget(ctx, rb, date, opts);
    boxes = h('span', { class: 'pw-boxes' }, Array.from({ length: rb.sets }, (_, k) => box(`Set ${k + 1}: s`)));
  } else if (rb.kind === 'cardio') {
    const last = rb.exercise ? lastPerformance(ctx.data, rb.exercise, addDays(date, -1)) : null;
    const c = last?.cardio?.[0];
    if (c) lt = { lastText: `Last ${fmtDay(last.date)}: ${[isNum(c.minutes) ? `${c.minutes} min` : '', isNum(c.avg_hr) ? `${c.avg_hr} bpm` : '', isNum(c.level) ? `level ${c.level}` : ''].filter(Boolean).join(', ')}`, targetText: null };
    boxes = h('span', { class: 'pw-boxes' }, box('Minutes'), box('Avg HR'), box('Level / %'), box('km'));
  } else if (rb.kind === 'intervals') {
    boxes = rb.easyReplaced ? h('span', { class: 'pw-boxes' }, box('Minutes'), box('Avg HR'))
      : h('span', { class: 'pw-boxes' }, Array.from({ length: rb.intervals.rounds }, (_, k) => box(String(k + 1))), box('Avg HR'));
  } else if (rb.kind === 'circuit') {
    boxes = h('span', { class: 'pw-boxes' }, box('Rounds'), box('Minutes'), box('Avg HR'));
  } else {
    boxes = h('span');
  }
  return h('div', { class: 'pw-block' },
    h('div', null,
      h('p', { class: 'pw-ex' }, name),
      h('p', { class: 'pw-target' }, target),
      lt?.lastText ? h('p', { class: 'pw-last' }, lt.lastText) : null,
      lt?.targetText ? h('p', { class: 'pw-goal' }, lt.targetText) : null,
      rb.kind === 'circuit' ? h('p', { class: 'pw-target' }, rb.circuit.items.map((it) => `${exName(it.exercise)}${it.dose ? ` ${gateText(it.dose)}` : ''}`).join('; ')) : null),
    boxes);
}

export function render(ctx) {
  const program = content.program;
  const weekStart = isISODate(ctx.params[0]) ? mondayOf(ctx.params[0]) : mondayOf(ctx.today);
  const page = h('div', { class: 'page' });
  page.append(h('div', { class: 'print-toolbar' },
    h('h1', { class: 'page-title', tabindex: '-1', id: 'page-title', style: { 'margin-right': 'auto', 'font-size': '28px' } }, 'Print this week'),
    h('button', { type: 'button', class: 'btn btn-primary', onClick: () => window.print() }, 'Print'),
    h('a', { class: 'btn', href: `#/print/${addDays(weekStart, -7)}` }, 'Previous week'),
    h('a', { class: 'btn', href: `#/print/${addDays(weekStart, 7)}` }, 'Next week'),
    h('a', { class: 'btn btn-ghost', href: '#/program' }, 'Back to the programme')));
  if (!program) { page.append(missingContent('The programme')); return page; }
  const tl = buildTimeline(program, ctx.data.profile);
  const pos = positionOn(tl, weekStart) || positionOn(tl, addDays(weekStart, 6));
  const firstPlan = planOn(program, ctx.data, weekStart, tl);
  const targets = pos?.phase?.weekly_targets || {};
  const tbits = [];
  // BT3-14: Zone 2 from one place (features/plan.js): this week's planned minutes.
  const z2 = plannedZone2Week(program, ctx.data, weekStart, { timeline: tl });
  if (z2 > 0) tbits.push(`Zone 2 ${fmtNum(z2)} min`);
  if (isNum(targets.strength_sessions)) tbits.push(`${targets.strength_sessions} strength sessions`);
  if (isNum(targets.steps_avg)) tbits.push(`${fmtNum(targets.steps_avg)} steps a day`);
  const sheetEl = h('div', { class: 'pw' },
    h('h1', null, `Week of ${fmtDayLong(weekStart, { year: true })}`),
    h('p', { class: 'pw-sub' }, pos ? `${pos.item.name}, week ${pos.week}${firstPlan.override?.label ? ` (${firstPlan.override.label})` : ''}.${tbits.length ? ` Targets: ${tbits.join(', ')}.` : ''}` : 'Before the programme starts.'),
    h('p', { class: 'pw-sub' }, 'Each exercise shows last time and today’s target. Write what you actually did in the boxes, then type them in with “Enter from sheet” on Log a session.'),
    h('p', { class: 'pw-sub pw-rules' }, 'Amber morning (under 6 h sleep, resting HR 5+ above average, sore 7+, energy 2 or less, arm pain 4+, arm pain rising, or a fasting day)? Halve the sets, Zone 2 only, no intervals, same loads. Red (any arm red flag, or arm pain 7+): no training, including physio exercises. Call the fracture clinic, or NHS 111 / 999.'));
  for (const date of weekDates(weekStart)) {
    const plan = planOn(program, ctx.data, date, tl);
    const main = plan.sessions.filter((e) => !e.isRest);
    const r = date <= ctx.today ? readinessFor(ctx.data, date) : null;
    const fast = !!fastingOn(ctx.data, date);
    const easy = r?.level === 'amber' || fast;
    const hold = holdReason({ deload: !!plan.override?.deload, easy, fasting: fast });
    const day = h('section', { class: 'pw-day' });
    day.append(h('div', { class: 'pw-day-head' },
      h('p', { class: 'pw-day-name' }, `${fmtDay(date)}: ${main.length ? main.map((e) => `${e.source === 'addon' ? 'add-on ' : ''}${e.session?.name || sessionName(e.sessionId)}`).join(' + ') : 'Rest'}`),
      h('p', { class: 'pw-day-meta' }, [main.filter((e) => isNum(e.session?.duration_min)).map((e) => fmtMinutes(e.session.duration_min)).join(' + '), fastingOn(ctx.data, date) ? 'fasting: easy day, after you break your fast' : ''].filter(Boolean).join(', '))));
    day.append(h('div', { class: 'pw-checkin' }, box('Weight kg'), box('Resting HR'), box('Sleep h'), box('Energy 1–5'), box('Sore 0–10'), box('Arm pain 0–10'), box('Steps', true), box('Protein g')));
    if (!main.length) day.append(h('p', { class: 'pw-rest' }, plan.pos ? 'Rest day: an easy walk in daylight and the daily mobility routine.' : 'Before the programme start: walks and check-ins.'));
    for (const e of main) {
      const s = e.session;
      if (!s) { day.append(h('p', { class: 'pw-rest' }, `${sessionName(e.sessionId)}: not described in the programme yet.`)); continue; }
      if (main.length > 1) day.append(h('p', { class: 'pw-ex', style: { 'margin-top': '8px' } }, `${e.source === 'addon' ? 'Add-on: ' : ''}${s.name || sessionName(e.sessionId)}`));
      const warm = routineFor(s.warmup);
      if (warm) day.append(h('p', { class: 'pw-target' }, `Warm-up: ${warm.name || s.warmup}. ${Array.isArray(warm.items) ? warm.items.filter((x) => x && x.exercise).map((x) => `${exName(x.exercise)} ${gateText(x.dose || '')}`.trim()).join('; ') : ''}`));
      const blocks = resolveFor(s, { week: plan.pos?.week || 1, override: plan.override, easyDay: easy, fasting: fast });
      const keys = blockKeys(blocks);
      blocks.forEach((rb, i) => day.append(blockRow(ctx, rb, date, { sessionId: e.sessionId, key: keys[i], hold })));
      const cool = routineFor(s.cooldown);
      if (cool) day.append(h('p', { class: 'pw-target' }, `Cool-down: ${cool.name || s.cooldown}`));
      day.append(h('div', { class: 'pw-lines' }, h('span', null, `${typeLabel(s.type)} done`), box('✓'), h('span', null, 'RPE'), box('/10'), h('span', null, 'Time'), box('min'), h('span', { class: 'pw-note' })));
    }
    sheetEl.append(day);
  }
  page.append(sheetEl);
  return page;
}
