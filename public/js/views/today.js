// #/today: the morning dashboard.

import { h, fmtNum, fmtFixed, fmtSigned, fmtMinutes, extLink, isHttpUrl } from '../dom.js';
import { fmtDayLong, fmtDay, addDays, mondayOf, daysBetween, isISODate, relDays, weekdayIndex } from '../dates.js';
import { positionOn, CLEARANCE_GATES, isGateMet } from '../schedule.js';
import { isNum, rollingMean, weeklyChange, mean } from '../calc.js';
import { makeCtx, weekSummary, streak, checkinOn, series, seriesUntil, latestValue, dayInfo } from '../stats.js';
import { section, sheet, readinessBadge, gates, gateLabel, gateText, dayStrip, stat, missingContent, exerciseButton, statusIcon, guard, lockIcon } from '../components.js';
import { meter, sparkline } from '../charts.js';
import { routeProfile } from '../route.js';
import { content, exName } from '../content.js';
import { blockTarget, findWorkout, lockedIn, readinessOn, typeLabel, routineFor, sessionName } from './shared.js';
import { insightsFor, coachPanel } from '../features/coach.js';
import { RED_STOP, FASTING_TEXT, fastingOn } from '../features/safety.js';
import { resolveFor, planOn, alternates, weekendPlanFor, zone2Week } from '../features/plan.js';
import { evaluateGoals, GOAL_STATE_LABEL } from '../features/goals.js';
import { baselineDueFrom, testStatus } from '../features/testplan.js';
import { weightVerdict, verdictLine } from '../features/weight.js';
import { icon } from '../features/icons.js';
import * as store from '../store.js';

export const title = 'Today';

function redBanner(ctx, r, checkin) {
  const flags = r.flags?.length ? r.flags : (checkin?.arm_flags || []);
  const defs = content.arm?.red_flags || [];
  return h('div', { class: 'banner banner-red', role: 'alert' },
    statusIcon('red', 28),
    h('div', null,
      h('p', { class: 'banner-title' }, 'Red: no training today'),
      h('p', null, RED_STOP),
      flags.length ? h('ul', null, flags.map((id) => {
        const d = defs.find((f) => f.id === id);
        return h('li', null, d ? `${d.label}${d.action ? `: ${d.action}` : ''}` : String(id).replace(/_/g, ' '));
      })) : r.reasons?.length ? h('ul', null, r.reasons.map((x) => h('li', null, x))) : null,
      h('p', { class: 'row', style: { 'margin-top': '8px' } },
        h('a', { class: 'btn btn-sm', href: '#/arm' }, 'Clinic contacts and red flags'),
        h('a', { class: 'btn btn-sm btn-ghost', href: '#/checkin' }, 'Review today’s check-in'))));
}

function fastingBanner(period) {
  return h('div', { class: 'banner banner-fast', role: 'note' },
    h('span', { class: 'fast-mark', 'aria-hidden': 'true' }, icon('moon', 22)),
    h('div', null,
      h('p', { class: 'banner-title' }, `${period.label || 'Fasting period'}: easy-day mode is on`),
      h('p', null, FASTING_TEXT),
      h('p', { class: 'small' }, h('a', { href: '#/settings' }, 'Fasting dates in Settings'))));
}

function heroWhere(ctx, timeline, pos, override) {
  if (!content.program) return 'Your programme file isn’t ready yet. Refresh later to load it.';
  if (!timeline.phases.length) return 'The programme has no phases yet.';
  if (!pos) {
    if (ctx.today < timeline.start) {
      return [h('strong', null, `Your programme starts ${fmtDay(timeline.start)}`), ` (${relDays(timeline.start, ctx.today)}). Until then, keep walking, check in each morning and read the guide’s Start Here chapter.`];
    }
    return 'No phase is scheduled for today.';
  }
  const bits = [h('strong', null, pos.item.name), `, week ${pos.week} of ${pos.item.weeks}`];
  if (override?.label) bits.push(` (${override.label})`);
  if (pos.isRepeat) bits.push('. Repeating weeks while you wait for the next gate');
  bits.push('.');
  return bits;
}

/** This weekend's route (hikes.json weekend_plan), for the long-walk card. */
function weekendCard(entry) {
  if (!entry) return null;
  const bits = [isNum(entry.minutes) ? `${fmtNum(entry.minutes)} min` : null, isNum(entry.level) ? `Level ${entry.level}` : null].filter(Boolean).join(', ');
  return h('div', { class: 'weekend-route' },
    h('p', { class: 'mini-title' }, 'This weekend’s route'),
    h('p', { class: 'wr-name' }, isHttpUrl(entry.url) ? extLink(entry.url, entry.name || 'Route') : (entry.name || 'Route'), bits ? h('span', { class: 'wr-meta' }, ` ${bits}`) : null),
    entry.notes ? h('p', { class: 'small ink-2' }, gateText(entry.notes)) : null,
    h('p', { class: 'small' }, h('a', { href: '#/hikes' }, 'More routes on the Hikes page')));
}

/** "Short on time?" and "Gym closed?". A walk day needs no gym, so it only offers the minimum session. */
function alternatesRow(ctx, date, { walkDay = false } = {}) {
  const alt = alternates(content.program);
  if (!alt.short && !alt.travel) return null;
  return h('div', { class: 'alt-row' },
    alt.short ? h('a', { class: 'btn btn-sm btn-ghost', href: `#/train/${date}/${encodeURIComponent(alt.short)}` }, walkDay ? 'Short on time? The 30-minute minimum counts' : 'Short on time?') : null,
    alt.travel && !walkDay ? h('a', { class: 'btn btn-sm btn-ghost', href: `#/train/${date}/${encodeURIComponent(alt.travel)}` }, 'Gym closed?') : null);
}

function disabledStart(text = 'Start session') {
  return [h('button', { type: 'button', class: 'btn btn-lg', disabled: true, 'aria-describedby': 'red-start-why' }, text),
    h('span', { class: 'small muted', id: 'red-start-why' }, 'Not today: red readiness.')];
}

function sessionCard(ctx, entry, plan, r, { checkedIn = true, info = null, start = null } = {}) {
  const { data, today } = ctx;
  const sess = entry.session;
  const easy = r.level === 'amber';
  const red = r.level === 'red';
  const blocks = sess ? resolveFor(sess, { week: plan.pos?.week || 1, override: plan.override, easyDay: easy, fasting: !!fastingOn(data, today) }) : [];
  const existing = findWorkout(data, today, entry.sessionId);
  const locked = sess ? lockedIn(sess, data, today) : [];
  const warm = routineFor(sess?.warmup);
  const cool = routineFor(sess?.cooldown);
  const href = `#/train/${today}/${encodeURIComponent(entry.sessionId)}`;
  if (!sess) {
    return h('div', { class: 'session-card' },
      h('p', { class: 'session-name' }, sessionName(entry.sessionId)),
      h('p', { class: 'muted' }, 'This session isn’t described in the programme file yet.'),
      h('div', { class: 'session-actions' }, red ? disabledStart('Log it') : h('a', { class: 'btn', href }, 'Log it anyway')));
  }
  // BT1-11: the long walk is the session of type "hike", whatever the weekday.
  const longWalk = sess.type === 'hike';
  // "Never miss twice": a short or gym-closed session, or (BT1-4) a logged hike, can stand in for it.
  const altRole = existing?.status === 'done' ? null : (info?.roles || []).find((x) => x.role === 'alternate') || null;
  const hikeCover = existing?.status === 'done' || altRole ? null : (info?.viaHike ? info.hikes?.[0] || null : null);
  const covered = !!(altRole || hikeCover);
  return h('div', { class: ['session-card', covered && 'is-covered'] },
    h('div', { class: 'session-head' },
      h('h3', { class: 'session-name' }, sess.name || sessionName(entry.sessionId)),
      h('span', { class: 'session-meta' }, [typeLabel(sess.type), isNum(sess.duration_min) ? fmtMinutes(sess.duration_min) : null].filter(Boolean).join(', '))),
    sess.summary ? h('p', { class: 'session-summary' }, gateText(sess.summary)) : null,
    warm ? h('p', { class: 'routine-line' }, `Warm-up: ${warm.name || sess.warmup}${isNum(warm.minutes) ? `, about ${warm.minutes} min` : ''}`) : null,
    blocks.length ? h('ol', { class: 'block-list' }, blocks.map((b) => h('li', null,
      b.kind === 'circuit'
        ? h('span', null, 'Circuit: ', b.circuit.items.map((it, i) => [i ? ', ' : '', exerciseButton(it.exercise, ctx)]))
        : b.exercise ? exerciseButton(b.exercise, ctx) : h('span', null, 'Block'),
      h('span', { class: 'bl-target' }, blockTarget(b))))) : null,
    cool ? h('p', { class: 'routine-line' }, `Cool-down: ${cool.name || sess.cooldown}`) : null,
    longWalk && !covered ? weekendCard(weekendPlanFor(content.hikes, today, { start })) : null,
    locked.length ? h('p', { class: 'notice notice-locked small', role: 'note' }, lockIcon(false), ` Locked for now: ${locked.map(exName).join(', ')}. The logger offers safe swaps.`) : null,
    easy && blocks.some((b) => b.kind === 'strength' || b.kind === 'timed' || b.kind === 'intervals')
      ? h('p', { class: 'notice notice-warn small' }, 'Easy day: the logger halves your sets, swaps intervals for steady Zone 2 and holds your loads.') : null,
    altRole ? h('p', { class: 'small covered-note' }, `${altRole.workout.session_name || sessionName(altRole.workout.session_id)} done instead. It counts as today’s session done${sess.type === 'strength' ? ', but not as a strength session' : ''}; nothing needs making up. Carry on with the plan tomorrow.`) : null,
    hikeCover ? h('p', { class: 'small covered-note' }, `Your logged hike${hikeCover.name ? `, ${hikeCover.name}` : ''}${isNum(hikeCover.duration_min) ? ` (${fmtMinutes(hikeCover.duration_min)})` : ''}, counts as today’s long walk.`) : null,
    h('div', { class: 'session-actions' },
      existing?.status === 'done'
        ? [h('span', { class: 'done-line' }, statusIcon('green', 18), 'Done'), h('a', { class: 'btn btn-sm', href: `#/train/w/${existing.id}` }, 'View or edit the log')]
        : altRole
          ? [h('span', { class: 'done-line' }, statusIcon('green', 18), 'Done: short session'), h('a', { class: 'btn btn-sm', href: `#/train/w/${altRole.workout.id}` }, 'View or edit the log')]
          : hikeCover
            ? [h('span', { class: 'done-line' }, statusIcon('green', 18), 'Done: hike logged'), h('a', { class: 'btn btn-sm', href: '#/hikes' }, 'See your hikes')]
            : red
              ? disabledStart(existing ? 'Continue session' : 'Start session')
              : [h('a', { class: ['btn', 'btn-lg', (checkedIn || existing) && 'btn-primary'], href }, existing ? 'Continue session' : 'Start session'),
                !checkedIn && !existing ? h('span', { class: 'small muted' }, 'Check in first to see if today should be easy.') : null]),
    existing?.status === 'done' || covered || red ? null : alternatesRow(ctx, today, { walkDay: longWalk }));
}

function addonRow(ctx, entry, r) {
  const sess = entry.session;
  const existing = findWorkout(ctx.data, ctx.today, entry.sessionId);
  const red = r.level === 'red';
  return h('div', { class: 'addon' },
    h('div', null,
      h('p', { class: 'addon-name' }, `Add-on: ${entry.addon?.name || sess?.name || sessionName(entry.sessionId)}`),
      h('p', { class: 'small muted' }, red ? 'Not today, including your physio exercises, until you’ve been advised.' : (sess?.summary || 'Do this alongside today’s main session.'))),
    existing?.status === 'done'
      ? h('span', { class: 'done-line' }, statusIcon('green', 18), 'Done')
      : red
        ? h('button', { type: 'button', class: 'btn btn-sm', disabled: true }, existing ? 'Continue' : 'Start')
        : h('a', { class: 'btn btn-sm', href: `#/train/${ctx.today}/${encodeURIComponent(entry.sessionId)}` }, existing ? 'Continue' : 'Start'));
}

function nextAppointment(data, today) {
  const list = (data.arm.appointments || []).filter((a) => isISODate(a.date) && a.date >= today).sort((a, b) => (a.date < b.date ? -1 : 1));
  return list[0] || null;
}

function weekStats(ctx, sum, streakDays, z2Planned, fasting) {
  const tiles = [];
  tiles.push(stat({
    label: 'Strength sessions', value: `${sum.strengthDone}`, unit: `of ${sum.strengthTarget || 0}`,
    extra: sum.strengthTarget ? meter({ value: sum.strengthDone, max: sum.strengthTarget, label: 'Strength sessions this week' }) : null,
  }));
  const z2Target = z2Planned > 0 ? z2Planned : sum.z2Target;
  tiles.push(stat({
    label: 'Zone 2 minutes', value: fmtNum(sum.z2Min), unit: z2Target ? `of ${fmtNum(z2Target)}` : 'min',
    sub: z2Target ? (z2Planned > 0 ? 'Planned this week' : null) : 'No weekly target yet',
    extra: z2Target ? meter({ value: sum.z2Min, max: z2Target, label: 'Zone 2 minutes this week' }) : null,
  }));
  tiles.push(stat({
    label: 'Average steps', value: isNum(sum.stepsAvg) ? fmtNum(sum.stepsAvg) : '–',
    unit: sum.stepsTarget ? `of ${fmtNum(sum.stepsTarget)}` : '',
    sub: isNum(sum.stepsAvg) ? null : 'Add steps to your check-ins',
    extra: sum.stepsTarget && isNum(sum.stepsAvg) ? meter({ value: sum.stepsAvg, max: sum.stepsTarget, label: 'Average steps this week' }) : null,
  }));
  tiles.push(stat({
    label: 'Protein target days', value: `${sum.proteinDays}`, unit: 'of 7',
    sub: fasting ? 'Fasting: spread it over the meals your fast allows' : sum.proteinTarget ? `Target ${fmtNum(sum.proteinTarget)} g a day` : 'Log your weight to set a target',
    extra: meter({ value: sum.proteinDays, max: 7, label: 'Days at the protein target this week' }),
  }));
  tiles.push(stat({ label: 'On-plan streak', value: fmtNum(streakDays), unit: streakDays === 1 ? 'day' : 'days', sub: 'Trained on training days, rested on rest days' }));
  return h('div', { class: 'stats' }, tiles);
}

/** QA6: trends never include entries dated after today. */
function trends(ctx) {
  const { data, today } = ctx;
  const from = addDays(today, -27);
  const until = (field) => (typeof seriesUntil === 'function' ? seriesUntil(data, field, today) : series(data, field).filter((p) => p.date <= today));
  const weights = until('weight_kg');
  const avg = rollingMean(weights).filter((p) => p.date >= from);
  const lastAvg = avg.length ? avg[avg.length - 1].value : null;
  const change = weeklyChange(weights, today);
  // BT3-3/13: the single fortnightly verdict, and the hold while fasting (never "below band").
  const v = weightVerdict(data, today, { program: content.program });
  const fastNow = fastingOn(data, today);
  let verdict = weights.length ? verdictLine(v, { fastingNow: fastNow }) : 'Log your weight most mornings to see the trend.';
  if (!fastNow && v && (v.state === 'waiting' || v.state === 'insufficient') && isNum(change)) verdict = `${fmtSigned(change, 2, ' kg')} over the last week. ${verdict}`;
  const rhr = until('rhr');
  const rhrMean = rollingMean(rhr).filter((p) => p.date >= from);
  const rhrAvg = mean(rhr.filter((p) => p.date >= addDays(today, -6)).map((p) => p.value));
  const sleep = until('sleep_h');
  const sleepMean = rollingMean(sleep).filter((p) => p.date >= from);
  const sleepAvg = mean(sleep.filter((p) => p.date >= addDays(today, -6)).map((p) => p.value));
  const lastRhr = latestValue(data, 'rhr', today);
  const lastSleep = latestValue(data, 'sleep_h', today);
  return h('div', { class: 'stats stats-3' },
    stat({ label: 'Weight, 7-day average', value: isNum(lastAvg) ? fmtFixed(lastAvg, 1) : '–', unit: 'kg', sub: verdict, extra: sparkline({ points: avg, label: 'Weight, 7-day average, last 4 weeks', unit: 'kg' }) }),
    stat({ label: 'Resting heart rate, 7-day average', value: isNum(rhrAvg) ? fmtNum(rhrAvg) : '–', unit: 'bpm', sub: lastRhr ? `Latest ${fmtNum(lastRhr.value)} bpm, ${fmtDay(lastRhr.date)}` : 'Measure it before you get up', extra: sparkline({ points: rhrMean, label: 'Resting heart rate, 7-day average, last 4 weeks', unit: 'bpm', dp: 0 }) }),
    stat({ label: 'Sleep, 7-day average', value: isNum(sleepAvg) ? fmtFixed(sleepAvg, 1) : '–', unit: 'h', sub: lastSleep ? `Last logged ${fmtFixed(lastSleep.value, 1)} h` : 'Aim for 7 to 9 hours', extra: sparkline({ points: sleepMean, label: 'Sleep, 7-day average, last 4 weeks', unit: 'h' }) }));
}

function readinessPanel(ctx, r, sessionDone) {
  const panel = sheet({ class: ['area-ready', r.level === 'red' && 'notice-bad'] },
    h('h2', { class: 'mini-title' }, 'Readiness'),
    readinessBadge(r, { large: true, noAdvice: r.level === 'red' }));
  if (!r.checkedIn) {
    panel.append(
      h('p', { class: 'small muted ready-hint' }, 'One minute: sleep, resting heart rate, energy, soreness and your arm. Measure your heart rate before you get up.'),
      h('a', { class: 'btn btn-primary btn-lg btn-block ready-cta', href: '#/checkin' }, 'Check in now'));
  } else {
    panel.append(h('p', { class: 'ready-edit' }, h('a', { href: '#/checkin' }, sessionDone ? 'See today’s check-in' : 'Edit today’s check-in')));
  }
  return panel;
}

function appointmentPanel(data, today) {
  const appt = nextAppointment(data, today);
  const days = appt ? daysBetween(today, appt.date) : null;
  return sheet({ class: 'area-appt' },
    h('h2', { class: 'mini-title' }, 'Next appointment'),
    appt
      ? [h('p', { class: 'session-name' }, appt.type || 'Appointment'),
        h('p', { class: 'countdown' }, days === 0 ? 'Today' : fmtNum(days), days === 0 ? null : h('span', { class: 'countdown-unit' }, days === 1 ? ' day to go' : ' days to go')),
        h('p', { class: 'muted' }, fmtDay(appt.date, { year: true })),
        h('p', { class: 'appt-link' }, h('a', { href: '#/arm' }, 'Get your clinic questions ready'))]
      : [h('p', { class: 'muted' }, 'No upcoming appointments.'), h('p', { class: 'appt-link' }, h('a', { href: '#/arm' }, 'Add one on the Your arm page'))]);
}

function planPanel(ctx, { program, plan, pos, timeline, r, info = null }) {
  const { today } = ctx;
  const sessPanel = sheet({ class: 'area-session' }, h('h2', { class: 'mini-title' }, 'Today’s plan'));
  if (!program) {
    sessPanel.append(missingContent('The programme'));
    return sessPanel;
  }
  const main = plan.sessions.filter((e) => e.source === 'template');
  const addons = plan.sessions.filter((e) => e.source === 'addon');
  if (!pos) {
    sessPanel.append(h('p', { class: 'session-summary' }, `Nothing is scheduled before your programme starts on ${fmtDay(timeline.start)}. A 30-minute walk in daylight, on good paths, is perfect.`),
      h('div', { class: 'session-actions' }, r.level === 'red' ? disabledStart('Log a walk or session') : h('a', { class: 'btn', href: `#/train/${today}/adhoc` }, 'Log a walk or session')));
  } else {
    for (const e of main) {
      if (e.isRest) {
        sessPanel.append(h('div', { class: 'session-card' },
          h('h3', { class: 'session-name' }, 'Rest day'),
          h('p', { class: 'session-summary' }, e.session?.summary || 'Recovery is when you adapt. An easy walk and the daily mobility routine are welcome.'),
          weekdayIndex(today) === 5 || weekdayIndex(today) === 6 ? weekendCard(weekendPlanFor(content.hikes, today, { start: timeline?.start })) : null,
          h('div', { class: 'session-actions' }, r.level === 'red' ? disabledStart('Log a walk') : e.session && Array.isArray(e.session.blocks) && e.session.blocks.length
            ? h('a', { class: 'btn btn-sm', href: `#/train/${today}/${encodeURIComponent(e.sessionId)}` }, 'Log the optional walk and mobility')
            : h('a', { class: 'btn btn-sm', href: `#/train/${today}/adhoc` }, 'Log a walk or extra session'))));
      } else {
        sessPanel.append(sessionCard(ctx, e, plan, r, { checkedIn: !!r.checkedIn, info, start: timeline?.start }));
      }
    }
  }
  for (const a of addons) sessPanel.append(addonRow(ctx, a, r));
  return sessPanel;
}

// ---------------------------------------------------------------- Phase 0 checklist (PM2)

// SPEC 1a: an experienced lifter coming back. No induction, no "learn the machines".
const P0_DEFAULT = [
  { id: 'parq', text: 'Fill in the PAR-Q+ health questionnaire before your first session.' },
  { id: 'setup', text: 'Set up each machine one-handed: seat, pads and pins with your uninjured hand, injured arm across your stomach. Note the settings.' },
  { id: 'stops', text: 'Set the leg press’s safety stops for your dead start (ask staff if it needs two hands) and write the setting down.' },
];

function checklistItems(phase) {
  const raw = Array.isArray(phase?.checklist) ? phase.checklist : null;
  if (!raw || !raw.length) return P0_DEFAULT;
  return raw.map((x, i) => (typeof x === 'string' ? { id: `item-${i + 1}`, text: x } : x && typeof x === 'object' ? { id: String(x.id || `item-${i + 1}`), text: String(x.text || x.label || x.name || ''), href: x.href || null } : null))
    .filter((x) => x && x.text);
}

/** Week-one jobs: PAR-Q+, induction, leg-press stops, and the baseline tests as they come due. */
function phase0Card(ctx, timeline) {
  const { data, today } = ctx;
  if (!timeline?.phases?.length) return null;
  const first = timeline.phases[0];
  const start = timeline.start;
  if (!start || today < addDays(start, -21) || today > addDays(start, 13)) return null;
  const ui = data.ui && typeof data.ui === 'object' ? data.ui : null;
  const ticks = ui && ui.p0_checklist && typeof ui.p0_checklist === 'object' ? ui.p0_checklist : {};
  const items = checklistItems(first.phase);
  const tests = (content.tests || []).filter((t) => t && typeof t.id === 'string');
  // BT2-1 / BT1-13: baselines spread over Mon–Wed (baseline_day); later tests wait for their phase.
  const baseline = tests.map((t) => ({ t, due: baselineDueFrom(t, timeline), st: testStatus(data, t, today >= start ? today : start, timeline) }))
    .filter((x) => x.st.state !== 'locked' && x.due && x.due <= addDays(start, 6))
    .sort((a, b) => (a.due < b.due ? -1 : a.due > b.due ? 1 : 0));
  const later = tests.map((t) => ({ t, due: baselineDueFrom(t, timeline) })).filter((x) => x.due && x.due > addDays(start, 6))
    .sort((a, b) => (a.due < b.due ? -1 : 1));
  const done = items.filter((x) => ticks[x.id]).length + baseline.filter((x) => x.st.last).length;
  const total = items.length + baseline.length;
  if (total && done >= total && today > addDays(start, 6)) return null;
  const host = h('div');
  const draw = () => {
    host.replaceChildren(
      h('ul', { class: 'p0-list' }, items.map((x) => {
        const id = `p0-${x.id}`;
        return h('li', { class: 'check' },
          h('input', { id, type: 'checkbox', checked: !!ticks[x.id], onChange: (e) => {
            data.ui = data.ui && typeof data.ui === 'object' ? data.ui : {};
            data.ui.p0_checklist = data.ui.p0_checklist && typeof data.ui.p0_checklist === 'object' ? data.ui.p0_checklist : {};
            if (e.target.checked) data.ui.p0_checklist[x.id] = today; else delete data.ui.p0_checklist[x.id];
            store.touch();
          } }),
          h('label', { for: id }, x.text));
      })),
      baseline.length ? h('div', { class: 'p0-tests' },
        h('p', { class: 'mini-title' }, 'Baseline tests, Monday to Wednesday'),
        h('ul', { class: 'p0-test-list' }, baseline.map((x) => h('li', null,
          x.st.last ? statusIcon('green', 16) : h('span', { class: 'p0-todo', 'aria-hidden': 'true' }),
          h('a', { href: '#/progress' }, x.t.name || x.t.id),
          h('span', { class: 'small muted' }, x.st.last ? ` done ${fmtDay(x.st.last.date)}` : x.st.fasting ? ' after the fast' : x.due > today ? ` ${fmtDay(x.due)}` : ' due now'))))) : null,
      later.length ? h('p', { class: 'small muted', style: { 'margin-top': '8px' } }, `Later: ${later.map((x) => `${x.t.name || x.t.id} from ${fmtDay(x.due)}`).join('; ')}.`) : null,
      h('p', { class: 'small muted', style: { 'margin-top': '8px' } }, 'Your leg-press baseline is this week’s calibration set: the set at RIR 2 after your two easy sets. Log the plates and reps exactly; the goal is +30% on it by the end of Phase 1. Test on green mornings only.'));
  };
  draw();
  return sheet({ class: 'area-p0' },
    h('h2', { class: 'mini-title' }, `${first.short || 'Phase 0'}: your week-one checklist`),
    host);
}

// ---------------------------------------------------------------- weekly review card (PM9)

function reviewCard(ctx) {
  const { data, today } = ctx;
  const wd = weekdayIndex(today);
  if (wd !== 6 && wd !== 0) return null;
  const weekStart = wd === 6 ? mondayOf(today) : addDays(mondayOf(today), -7);
  const rec = (data.weekly_reviews || []).find((x) => x.week_start === weekStart);
  const started = rec && (rec.wins || rec.struggles || rec.next_focus);
  if (wd === 0 && started) return null;
  return sheet({ class: 'area-review' },
    h('h2', { class: 'mini-title' }, wd === 6 ? 'Sunday: weekly review' : 'Last week’s review'),
    started
      ? [h('p', null, statusIcon('green', 16), ' Done for this week.'), rec.next_focus ? h('p', { class: 'small ink-2' }, `Next week’s focus: ${rec.next_focus}`) : null,
        h('p', { class: 'appt-link' }, h('a', { href: `#/review/${weekStart}` }, 'Open the review'))]
      : [h('p', { class: 'small ink-2' }, 'Ten minutes: look at the week, name one win and one struggle, and pick one focus for next week.'),
        h('a', { class: 'btn btn-sm btn-primary', href: `#/review/${weekStart}`, style: { 'margin-top': '10px' } }, 'Do the weekly review')]);
}

// ---------------------------------------------------------------- goals (PM9)

export function goalShape(state) {
  if (state === 'met') return statusIcon('green', 16);
  if (state === 'behind') return statusIcon('amber', 16);
  return icon(state === 'waiting' ? 'clock' : 'target', 16, 'goal-ico');
}

function goalsCard(ctx, timeline) {
  const list = evaluateGoals({ data: ctx.data, program: content.program, today: ctx.today, timeline });
  if (!list.length) return null;
  return sheet({ class: 'area-goals' },
    h('h2', { class: 'mini-title' }, 'Your goals'),
    h('ul', { class: 'goal-list goal-list-compact' }, list.map((x) => h('li', { class: ['goal', `goal-${x.state}`] },
      h('span', { class: 'goal-shape' }, goalShape(x.state)),
      h('span', { class: 'goal-text' },
        h('span', { class: 'goal-name' }, x.goal.label),
        h('span', { class: 'goal-head' }, x.headline),
        h('span', { class: 'goal-state' }, GOAL_STATE_LABEL[x.state] || ''))))),
    h('p', { class: 'appt-link' }, h('a', { href: '#/progress' }, 'Goals and progress')));
}

export function render(ctx) {
  const { data, today } = ctx;
  const program = content.program;
  const page = h('div', { class: 'page page-today' });
  const record = checkinOn(data, today);
  const r = readinessOn(ctx, today);
  if (r.level === 'red') page.append(guard('The red-flag warning', () => redBanner(ctx, r, record)));
  const fasting = fastingOn(data, today);
  if (fasting && r.level !== 'red') page.append(fastingBanner(fasting));

  const sctx = program ? makeCtx({ program, profile: data.profile, data, today }) : null;
  const timeline = sctx?.timeline || null;
  const pos = timeline ? positionOn(timeline, today) : null;
  const plan = program ? planOn(program, data, today, timeline) : null;
  const mainSessions = plan ? plan.sessions.filter((e) => e.source === 'template' && !e.isRest) : [];
  const info = sctx ? dayInfo(sctx, today) : null;
  const mainDone = mainSessions.length > 0 && (mainSessions.every((e) => findWorkout(data, today, e.sessionId)?.status === 'done') || (info && info.mainCovered >= mainSessions.length));

  page.append(h('header', { class: 'hero' },
    h('h1', { class: 'hero-date', tabindex: '-1', id: 'page-title' }, fmtDayLong(today)),
    h('p', { class: 'hero-where' }, guard('Where you are', () => heroWhere(ctx, timeline || { phases: [] }, pos, plan?.override))),
    timeline && timeline.phases.length ? guard('The route', () => routeProfile({ timeline, today, gates: gates(), clearances: data.profile.clearances, compact: true, animate: true })) : null,
    h('p', { class: 'hero-link' }, h('a', { href: '#/program' }, 'See the whole programme'))));

  const p0 = guard('Week-one checklist', () => phase0Card(ctx, timeline));
  const coach = guard('Coach notes', () => coachPanel(insightsFor(ctx, { readiness: r.level, exclude: ['clinic-soon', ...(p0 && p0.classList?.contains('area-p0') ? ['tests-due'] : [])] }), {
    limit: 3, cls: 'sheet area-coach',
    emptyText: data.checkins.length >= 3 ? 'Nothing to flag today. Keep doing what you’re doing.' : 'Coach notes appear here once you’ve logged a few days: protein, Zone 2, weight trend, resting heart rate and more.',
  }));

  page.append(h('div', { class: 'today-grid' },
    h('div', { class: 'today-main' },
      guard('Today’s plan', () => planPanel(ctx, { program, plan, pos, timeline, r, info })),
      p0,
      coach),
    h('div', { class: 'today-side' },
      guard('Readiness', () => readinessPanel(ctx, r, mainDone)),
      guard('Weekly review', () => reviewCard(ctx)),
      guard('Next appointment', () => appointmentPanel(data, today)),
      guard('Goals', () => goalsCard(ctx, timeline)))));

  // this week (or, before day one, a preview of the first week)
  page.append(guard('This week', () => {
    if (sctx && !pos && timeline.phases.length && today < timeline.start) {
      const first = weekSummary(sctx, timeline.start);
      return section({ title: 'Your first week', sub: `Starts ${fmtDay(timeline.start)}. Pick a day to see the session.`, actions: h('a', { class: 'btn btn-sm btn-ghost', href: `#/print/${timeline.start}` }, 'Print it') },
        dayStrip(first.days, today, { onPick: (d) => `#/train/${d.date}`, sessionName: (s) => s.session?.name || sessionName(s.sessionId) }));
    }
    if (!sctx) return null;
    const sum = weekSummary(sctx, mondayOf(today));
    const z2 = zone2Week(program, data, mondayOf(today), { today, timeline });
    return section({ title: 'This week', sub: pos ? `Targets come from ${pos.item.short}.` : null, actions: h('a', { class: 'btn btn-sm btn-ghost', href: `#/print/${mondayOf(today)}` }, 'Print this week') },
      weekStats(ctx, sum, streak(sctx), z2.planned, fasting),
      h('div', { class: 'strip-gap' }, dayStrip(sum.days, today, { onPick: (d) => `#/train/${d.date}`, sessionName: (s) => s.session?.name || sessionName(s.sessionId) })));
  }));

  page.append(guard('Trends', () => section({ title: 'Trends', sub: 'Last four weeks. The Progress page has the full charts.', actions: h('a', { class: 'btn btn-sm btn-ghost', href: '#/progress' }, 'Open Progress') }, trends(ctx))));

  page.append(guard('Clearances', () => {
    const cl = data.profile.clearances;
    return section({ title: 'Clearances', sub: 'Only your fracture clinic or physio can clear these. Each one unlocks more of the programme.', actions: h('a', { class: 'btn btn-sm btn-ghost', href: '#/arm' }, 'Update clearances') },
      h('div', { class: 'clearance-list' }, CLEARANCE_GATES.map((g) => {
        const met = isGateMet(g, cl, today);
        const d = cl[g];
        return h('div', { class: ['clearance', met && 'is-met'] },
          h('p', { class: 'clearance-name' }, lockIcon(met, 16), gateLabel(g)),
          h('p', { class: 'clearance-state' }, met ? (isISODate(d) ? `Recorded ${fmtDay(d)}` : 'Included in a higher clearance') : isISODate(d) ? `From ${fmtDay(d)}` : 'Not yet'));
      })));
  }));
  return page;
}
