// #/review[/YYYY-MM-DD]: weekly review with an automatic summary and your reflections.

import { h, uid, fmtNum, fmtFixed, fmtSigned } from '../dom.js';
import { addDays, fmtDay, fmtRange, isISODate, mondayOf, weekdayIndex } from '../dates.js';
import { isNum } from '../calc.js';
import { makeCtx, weekSummary, weightChange } from '../stats.js';
import { pageHead, section, sheet, stat, dayStrip, textareaField, missingContent, guard } from '../components.js';
import { meter } from '../charts.js';
import { content } from '../content.js';
import { sessionName, readinessOn } from './shared.js';
import { insightsFor, coachPanel } from '../features/coach.js';
import { zone2Week } from '../features/plan.js';
import { fastingInWeek, fastingOn } from '../features/safety.js';
import { weightVerdict, bandText } from '../features/weight.js';
import * as store from '../store.js';

export const title = 'Weekly review';

export function render(ctx) {
  const { data, today } = ctx;
  const defaultWeek = weekdayIndex(today) >= 4 ? mondayOf(today) : addDays(mondayOf(today), -7);
  const weekStart = isISODate(ctx.params[0]) ? mondayOf(ctx.params[0]) : defaultWeek;
  const end = addDays(weekStart, 6);
  const page = h('div', { class: 'page' });
  page.append(pageHead({
    title: 'Weekly review',
    kicker: `Week of ${fmtDay(weekStart, { year: true })}`,
    lede: 'Ten minutes on a Sunday. Look at what happened, name one win and one struggle, and choose one focus for next week.',
    actions: h('div', { class: 'row' },
      h('a', { class: 'btn btn-sm', href: `#/review/${addDays(weekStart, -7)}` }, 'Previous week'),
      weekStart < mondayOf(today) ? h('a', { class: 'btn btn-sm', href: `#/review/${addDays(weekStart, 7)}` }, 'Next week') : null),
  }));
  if (!content.program) page.append(missingContent('The programme', 'The summary below shows what you logged; planned sessions need the programme file.'));
  const sctx = makeCtx({ program: content.program || { phases: [] }, profile: data.profile, data, today });
  const sum = weekSummary(sctx, weekStart);
  const wChange = weightChange(data, end < today ? end : today);
  const done = end < today;
  // BT3-14: Zone 2 from one place (features/plan.js), the week's planned minutes.
  const z2 = zone2Week(content.program, data, weekStart, { today, timeline: sctx.timeline });
  const z2Target = z2.target ?? sum.z2Target;
  // BT3-3/13: the weight band from the single verdict; a fasting week shows the hold.
  const asOfW = end < today ? end : today;
  const verdict = weightVerdict(data, asOfW, { program: content.program });
  const fastWeek = fastingInWeek(data, weekStart);
  const weightSub = fastWeek || fastingOn(data, asOfW) || verdict.state === 'paused'
    ? 'Fasting: hold steady. No gain target until 14 days after the fast.'
    : `Your ${verdict.band?.name || 'band'}: ${bandText(verdict.band)}`;
  page.append(guard('What happened', () => section({ title: 'What happened', sub: `${fmtRange(weekStart, end)}${done ? '' : ', so far'}${sum.pos ? `. ${sum.pos.item.name}, week ${sum.pos.week}` : ''}.` },
    h('div', { class: 'stats' },
      stat({ label: 'Sessions done', value: `${sum.mainDone}`, unit: `of ${sum.mainPlanned} planned`, sub: !sum.mainPlanned ? 'No sessions planned' : done ? `${sum.adherencePct}% adherence` : `${fmtNum(sum.adherenceToDatePct ?? 0)}% so far this week`, extra: sum.mainPlanned ? meter({ value: sum.mainDone, max: sum.mainPlanned, label: 'Sessions done against planned' }) : null }),
      sum.addonPlanned ? stat({ label: 'Add-on sessions', value: `${sum.addonDone}`, unit: `of ${sum.addonPlanned}`, extra: meter({ value: sum.addonDone, max: sum.addonPlanned, label: 'Add-ons done' }) }) : null,
      stat({ label: 'Zone 2', value: fmtNum(sum.z2Min), unit: z2Target ? `of ${fmtNum(z2Target)} min` : 'min', sub: z2.target ? 'Planned this week' : null, extra: z2Target ? meter({ value: sum.z2Min, max: z2Target, label: 'Zone 2 minutes against the week’s plan' }) : null }),
      stat({ label: 'Weight change', value: isNum(wChange) ? fmtSigned(wChange, 2) : '–', unit: 'kg', sub: weightSub }),
      stat({ label: 'Sleep', value: isNum(sum.sleepAvg) ? fmtFixed(sum.sleepAvg, 1) : '–', unit: 'h a night' }),
      stat({ label: 'Resting HR', value: isNum(sum.rhrAvg) ? fmtNum(sum.rhrAvg) : '–', unit: 'bpm' }),
      stat({ label: 'Protein target days', value: `${sum.proteinDays}`, unit: `of 7`, sub: sum.proteinTarget ? `${fmtNum(sum.proteinTarget)} g or more` : 'Log weight for a target' }),
      stat({ label: 'Arm pain', value: isNum(sum.armPainAvg) ? fmtFixed(sum.armPainAvg, 1) : '–', unit: 'average /10', sub: sum.armPainMax >= 0 ? `Highest ${sum.armPainMax}/10` : 'Not logged' }),
      stat({ label: 'Steps', value: isNum(sum.stepsAvg) ? fmtNum(sum.stepsAvg) : '–', unit: 'a day', sub: sum.stepsTarget ? `Target ${fmtNum(sum.stepsTarget)}` : null })),
    h('div', { style: { 'margin-top': '12px' } }, dayStrip(sum.days, today, { onPick: (d) => `#/train/${d.date}`, sessionName: (s) => s.session?.name || sessionName(s.sessionId) })))));

  const asOf = end < today ? end : today;
  const isPast = end < today;
  page.append(guard('Coach notes', () => section({ title: isPast ? 'What the numbers say' : 'What the numbers say so far', sub: 'Plain-English notes worked out from your logs. They’re a nudge, not a verdict.' },
    coachPanel(insightsFor(ctx, { asOf, readiness: isPast ? 'unknown' : readinessOn(ctx, today).level, exclude: isPast ? ['clinic-soon', 'clinic-followup', 'tests-due', 'gate-cleared'] : [] }), {
      title: 'Coach notes', limit: 6, cls: 'sheet review-coach', headingLevel: 3,
      emptyText: sum.checkinCount >= 3 ? 'Nothing stands out this week. That’s a good week.' : 'Log a few check-ins and sessions and the notes appear here.',
    }))));

  // PM9: last week's focus, with a tick for whether you did it (stored on last week's review).
  const prev = data.weekly_reviews.find((r) => r.week_start === addDays(weekStart, -7) && String(r.next_focus || '').trim()) || null;
  if (prev) {
    const id = uid('focus');
    page.append(section({ title: 'Last week’s focus', sub: `From your review of the week of ${fmtDay(prev.week_start)}.` }, sheet({ class: 'focus-check' },
      h('p', { class: 'focus-text' }, prev.next_focus),
      h('div', { class: 'check check-lg' },
        h('input', { id, type: 'checkbox', checked: prev.focus_done === true, onChange: (e) => { prev.focus_done = e.target.checked; prev.saved_at = new Date().toISOString(); store.touch(); } }),
        h('label', { for: id }, 'I did it this week')))));
  }

  let rec = data.weekly_reviews.find((r) => r.week_start === weekStart) || null;
  const get = () => {
    if (!rec) {
      rec = { week_start: weekStart, wins: '', struggles: '', next_focus: '', adherence_pct: sum.adherencePct };
      data.weekly_reviews.push(rec);
      data.weekly_reviews.sort((a, b) => (a.week_start < b.week_start ? -1 : 1));
    }
    rec.adherence_pct = sum.adherencePct;
    rec.saved_at = new Date().toISOString();
    return rec;
  };
  const upd = (k) => (v) => { get()[k] = v; store.touch(); };
  page.append(section({ title: 'Your reflections', sub: 'Saved as you type.' }, sheet({ class: 'review-text' },
    textareaField({ label: 'Wins', value: rec?.wins, rows: 3, placeholder: 'What went well? Small wins count.', onInput: upd('wins') }),
    textareaField({ label: 'Struggles', value: rec?.struggles, rows: 3, placeholder: 'What got in the way? Be specific, not harsh.', onInput: upd('struggles') }),
    textareaField({ label: 'Next week’s focus', value: rec?.next_focus, rows: 2, placeholder: 'One thing. For example: in bed by 22:30 on training nights.', onInput: upd('next_focus') }))));

  const past = data.weekly_reviews.filter((r) => isISODate(r.week_start) && r.week_start !== weekStart && (r.wins || r.struggles || r.next_focus)).sort((a, b) => (a.week_start < b.week_start ? 1 : -1)).slice(0, 12);
  if (past.length) {
    page.append(section({ title: 'Earlier reviews' }, h('div', { class: 'table-wrap' }, h('table', { class: 'table table-compact' },
      h('thead', null, h('tr', null, h('th', { scope: 'col' }, 'Week'), h('th', { scope: 'col', class: 'num' }, 'Adherence'), h('th', { scope: 'col' }, 'Focus'))),
      h('tbody', null, past.map((r) => h('tr', null,
        h('th', { scope: 'row' }, h('a', { href: `#/review/${r.week_start}` }, fmtDay(r.week_start))),
        h('td', { class: 'num' }, isNum(r.adherence_pct) ? `${r.adherence_pct}%` : '–'),
        h('td', null, r.next_focus || '–'))))))));
  }
  return page;
}
