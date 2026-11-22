// #/program: the roadmap. Phase timeline with computed dates, phase details, a 4-week
// calendar (planned / done / missed), session templates, add-ons and the programme rules.

import { h, fmtNum, fmtMinutes } from '../dom.js';
import { addDays, fmtDay, fmtRange, mondayOf, WEEKDAYS, WEEKDAYS_LONG } from '../dates.js';
import { positionOn, DAY_KEYS, addonActive, isGateMet } from '../schedule.js';
import { isNum } from '../calc.js';
import { makeCtx, dayInfo } from '../stats.js';
import { pageHead, section, sheet, chip, gates, gateLabel, gateText, missingContent, exerciseButton, dayGlyph, DAY_STATUS_LABEL, dayStatusText } from '../components.js';
import { routeProfile } from '../route.js';
import { content } from '../content.js';
import { blockTarget, dash, routineFor, sessionName, typeLabel } from './shared.js';
import { resolveFor, alternates, addonVisible } from '../features/plan.js';

export const title = 'Programme';

let calStart = null;

const TARGET_LABELS = {
  zone2_min: ['Zone 2', (v) => `${fmtNum(v)} min a week`],
  strength_sessions: ['Strength sessions', (v) => `${fmtNum(v)} a week`],
  steps_avg: ['Steps', (v) => `${fmtNum(v)} a day on average`],
  long_session_min: ['Long session', (v) => `${fmtNum(v)} min`],
};

function targetsList(t) {
  if (!t || typeof t !== 'object') return null;
  const items = Object.entries(t).filter(([, v]) => v !== null && v !== undefined && v !== '');
  if (!items.length) return null;
  return h('ul', { class: 'kv-list' }, items.map(([k, v]) => {
    const def = TARGET_LABELS[k];
    const label = def ? def[0] : k.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());
    return h('li', null, h('span', null, label), h('span', { class: 'kv-v' }, def && isNum(v) ? def[1](Number(v)) : String(v)));
  }));
}

function overrideChanges(o) {
  const bits = [];
  if (isNum(o.sets_max)) bits.push(`Max ${o.sets_max} sets`);
  if (o.deload) bits.push('Deload: half the sets, same loads');
  if (o.rir) bits.push(`RIR ${dash(o.rir)}`);
  if (isNum(o.cardio_scale) && Number(o.cardio_scale) !== 1) bits.push(`Cardio × ${o.cardio_scale}`);
  if (o.zone_cap) bits.push(`No harder than ${o.zone_cap}`);
  if (isNum(o.circuit_minutes)) bits.push(`Circuits ${o.circuit_minutes} min`);
  if (isNum(o.rounds)) bits.push(`${o.rounds} interval rounds`);
  return bits.join(', ') || '–';
}

function templateTable(phase) {
  const tpl = phase.week_template && typeof phase.week_template === 'object' ? phase.week_template : {};
  return h('div', { class: 'table-wrap' }, h('table', { class: 'table table-compact' },
    h('thead', null, h('tr', null, DAY_KEYS.map((d, i) => h('th', { scope: 'col' }, WEEKDAYS[i])))),
    h('tbody', null, h('tr', null, DAY_KEYS.map((d) => {
      const v = tpl[d];
      const ids = v == null ? [] : Array.isArray(v) ? v : [v];
      return h('td', null, ids.length ? ids.map((id) => sessionName(id)).join(' + ') : 'Rest');
    })))));
}

function phaseCard(ctx, it, pos, i, n, phasesAll) {
  const p = it.phase;
  const today = ctx.today;
  let status;
  let dates;
  if (pos && pos.phaseIndex === i) status = 'Current';
  else if (it.start && it.actualEnd && it.actualEnd <= today) status = 'Done';
  else if (it.start && it.start > today) status = 'Upcoming';
  else if (!it.start) status = 'Waiting';
  else status = 'Done';
  if (it.start) {
    if (it.actualEnd) dates = fmtRange(it.start, addDays(it.actualEnd, -1));
    else if (i === n - 1) dates = `From ${fmtDay(it.start)}, ${it.weeks} weeks, then the final weeks repeat`;
    else dates = `${fmtRange(it.start, addDays(it.plannedEnd, -1))}, then repeats until “${gateLabel(phasesAll[i + 1].entryGate)}” is recorded`;
  } else if (it.waitingGate) {
    dates = `Waiting for “${gateLabel(it.waitingGate)}”. Starts on the first Monday on or after the date it’s recorded, once the previous phase has had at least ${phasesAll[i - 1]?.minWeeks || phasesAll[i - 1]?.weeks || ''} weeks.`;
  } else {
    dates = 'Starts after the previous phase.';
  }
  const overrides = Array.isArray(p.week_overrides) ? p.week_overrides.filter((o) => o && isNum(o.week)) : [];
  const details = h('div', { class: 'stack' },
    Array.isArray(p.focus) && p.focus.length ? h('div', null, h('h3', { class: 'mini-title' }, 'Focus'), h('ul', { class: 'ticks' }, p.focus.map((f) => h('li', null, gateText(String(f)))))) : null,
    Array.isArray(p.exit_criteria) && p.exit_criteria.length ? h('div', null, h('h3', { class: 'mini-title' }, 'Ready to move on when'), h('ul', { class: 'ticks' }, p.exit_criteria.map((f) => h('li', null, gateText(String(f)))))) : null,
    p.weekly_targets ? h('div', null, h('h3', { class: 'mini-title' }, 'Weekly targets'), targetsList(p.weekly_targets)) : null,
    h('div', null, h('h3', { class: 'mini-title' }, 'A typical week'), templateTable(p)),
    overrides.length ? h('div', null, h('h3', { class: 'mini-title' }, 'Special weeks'),
      h('div', { class: 'table-wrap' }, h('table', { class: 'table table-compact' },
        h('thead', null, h('tr', null, h('th', { scope: 'col' }, 'Week'), h('th', { scope: 'col' }, 'Name'), h('th', { scope: 'col' }, 'Changes'), h('th', { scope: 'col' }, 'Notes'))),
        h('tbody', null, overrides.sort((a, b) => a.week - b.week).map((o) => h('tr', { class: pos && pos.phaseIndex === i && pos.week === Number(o.week) ? 'is-highlight' : null },
          h('td', { class: 'num' }, String(o.week)), h('td', null, o.label || ''), h('td', null, overrideChanges(o)), h('td', null, gateText(o.notes || '')))))))) : null,
    isNum(p.repeat_from_week) || p.repeat_from_week === null
      ? h('p', { class: 'small muted' }, p.repeat_from_week === null ? 'If the next gate isn’t cleared in time, the final week repeats.' : `If the next gate isn’t cleared in time, weeks ${p.repeat_from_week} to ${it.weeks} repeat.`) : null);
  const current = status === 'Current';
  return sheet({ class: ['phase', current && 'is-current'] },
    h('div', { class: 'phase-head' },
      h('h3', { class: 'phase-name' }, it.name),
      chip(current ? `You are here: week ${pos.week}` : status, current ? 'chip-accent' : status === 'Waiting' ? 'chip-locked' : null)),
    h('p', { class: 'phase-dates' }, i > 0 ? `Gate: ${gateLabel(it.entryGate)}. ` : '', dates),
    p.goal ? h('p', { class: 'phase-goal' }, gateText(p.goal)) : null,
    h('details', { class: 'disclose', open: current }, h('summary', null, current ? 'Phase details' : 'Show phase details'), h('div', { style: { 'margin-top': '12px' } }, details)));
}

/** A4: four weeks as a plain table (a row per week, a column per weekday), each day a link. */
function calendar(ctx, sctx) {
  const today = ctx.today;
  if (!calStart) calStart = addDays(mondayOf(today), -14);
  const wrap = h('div');
  const draw = () => {
    const rows = [];
    for (let w = 0; w < 4; w++) {
      const cells = [];
      for (let k = 0; k < 7; k++) {
        const date = addDays(calStart, w * 7 + k);
        const info = dayInfo(sctx, date);
        const mains = info.main.filter((s) => addonVisible(s, ctx.data));
        const addons = info.addons.filter((s) => addonVisible(s, ctx.data));
        const st = date === today && info.status !== 'done' && info.status !== 'partial' && info.status !== 'neutral' ? (mains.length ? 'today' : info.status) : info.status;
        const names = mains.length ? mains.map((s) => s.session?.name || sessionName(s.sessionId)).join(' + ') : info.inProgram ? 'Rest' : '';
        const extra = addons.length ? ` + ${addons.length} add-on${addons.length > 1 ? 's' : ''}` : '';
        const dayNum = Number(date.slice(8));
        cells.push(h('td', { class: ['cal-cell', date === today && 'is-today', !info.inProgram && 'is-pre'] },
          h('a', { class: 'cal-link', href: `#/train/${date}`, 'aria-current': date === today ? 'date' : null },
            h('span', { class: 'cal-date' }, dayNum === 1 || (w === 0 && k === 0) ? fmtDay(date).split(' ').slice(1).join(' ') : String(dayNum),
              h('span', { class: 'visually-hidden' }, ` ${fmtDay(date)}`)),
            h('span', { class: 'cal-name' }, names + extra),
            h('span', { class: 'cal-status' }, dayGlyph(st, 13), h('span', { class: 'cal-status-text' }, dayStatusText(info, st))))));
      }
      rows.push(h('tr', null, h('th', { scope: 'row', class: 'visually-hidden' }, `Week of ${fmtDay(addDays(calStart, w * 7))}`), cells));
    }
    wrap.replaceChildren(
      h('div', { class: 'row-between', style: { 'margin-bottom': '10px' } },
        h('p', { class: 'small muted' }, `${fmtRange(calStart, addDays(calStart, 27))}. Pick a day to log or review it.`),
        h('div', { class: 'cal-nav' },
          h('button', { type: 'button', class: 'btn btn-sm', onClick: () => { calStart = addDays(calStart, -28); draw(); } }, 'Earlier'),
          h('button', { type: 'button', class: 'btn btn-sm', onClick: () => { calStart = addDays(mondayOf(today), -14); draw(); } }, 'Now'),
          h('button', { type: 'button', class: 'btn btn-sm', onClick: () => { calStart = addDays(calStart, 28); draw(); } }, 'Later'))),
      h('table', { class: 'cal' },
        h('caption', { class: 'visually-hidden' }, `Four weeks from ${fmtDay(calStart)}: planned sessions and what you did`),
        h('thead', null, h('tr', null, h('td', { class: 'visually-hidden' }), WEEKDAYS.map((d, i) => h('th', { scope: 'col', class: 'cal-head', abbr: WEEKDAYS_LONG[i] }, d)))),
        h('tbody', null, rows)),
      h('ul', { class: 'cal-legend', 'aria-label': 'Key' }, ['done', 'partial', 'missed', 'neutral', 'today', 'planned', 'rest'].map((s) => h('li', null, dayGlyph(s, 13), s === 'neutral' ? 'Red or fasting day: not counted' : DAY_STATUS_LABEL[s]))));
  };
  draw();
  return wrap;
}

function sessionTemplate(ctx, id, s, tag = null) {
  const blocks = resolveFor(s, { week: 1, override: null });
  const warm = routineFor(s.warmup);
  const cool = routineFor(s.cooldown);
  return h('details', { class: 'sheet sheet-tight', style: { 'margin-top': '8px' } },
    h('summary', { class: 'row-between' }, h('span', { style: { 'font-weight': 600 } }, s.name || sessionName(id), tag ? h('span', { class: 'chip chip-accent chip-tiny', style: { 'margin-left': '8px' } }, tag) : null), h('span', { class: 'small muted' }, [typeLabel(s.type), isNum(s.duration_min) ? fmtMinutes(s.duration_min) : ''].filter(Boolean).join(', '))),
    h('div', { class: 'stack-sm', style: { 'margin-top': '10px' } },
      s.summary ? h('p', { class: 'read ink-2' }, gateText(s.summary)) : null,
      warm ? h('p', { class: 'small' }, `Warm-up: ${warm.name || s.warmup}`) : null,
      blocks.length ? h('div', { class: 'table-wrap' }, h('table', { class: 'table table-compact' },
        h('thead', null, h('tr', null, h('th', { scope: 'col' }, 'Exercise'), h('th', { scope: 'col' }, 'Target'), h('th', { scope: 'col' }, 'Notes'))),
        h('tbody', null, blocks.map((b) => h('tr', null,
          h('td', null, b.kind === 'circuit' ? ['Circuit: ', b.circuit.items.map((it, i) => [i ? ', ' : '', exerciseButton(it.exercise, ctx), it.dose ? ` ${it.dose}` : ''])] : b.exercise ? exerciseButton(b.exercise, ctx) : ''),
          h('td', { class: 'nowrap' }, blockTarget(b), isNum(b.rest_s) ? `, rest ${b.rest_s} s` : '', b.tempo ? `, tempo ${b.tempo}` : ''),
          h('td', { class: 'small' }, gateText(b.notes || ''))))))) : h('p', { class: 'small muted' }, 'No blocks listed.'),
      cool ? h('p', { class: 'small' }, `Cool-down: ${cool.name || s.cooldown}`) : null));
}

export function render(ctx) {
  const program = content.program;
  const page = h('div', { class: 'page' });
  page.append(pageHead({
    title: 'Your programme',
    lede: 'The route from here to full clearance and long hills. Each phase opens when its gate is cleared by your clinic or physio, never earlier.',
    actions: h('a', { class: 'btn btn-primary', href: `#/print/${mondayOf(ctx.today)}` }, 'Print this week'),
  }));
  if (!program) { page.append(missingContent('The programme')); return page; }
  const sctx = makeCtx({ program, profile: ctx.data.profile, data: ctx.data, today: ctx.today });
  const tl = sctx.timeline;
  const pos = positionOn(tl, ctx.today);
  if (!tl.phases.length) { page.append(missingContent('The programme’s phases')); return page; }

  page.append(sheet(null, routeProfile({ timeline: tl, today: ctx.today, gates: gates(), clearances: ctx.data.profile.clearances })));
  if (!pos && ctx.today < tl.start) page.append(h('p', { class: 'notice notice-accent', style: { 'margin-top': '12px' } }, `Your programme starts ${fmtDay(tl.start)} with ${tl.phases?.[0]?.name || 'Phase 0'}. You can change the start date in Settings.`));

  page.append(section({ title: 'Phases', sub: 'Dates are worked out from your start date and the clearance dates on the Your arm page.' },
    h('div', null, tl.phases.map((it, i) => phaseCard(ctx, it, pos, i, tl.phases.length, tl.phases)))));

  page.append(section({ title: 'Four-week calendar', sub: 'Planned sessions, what you did, and what you missed.' }, calendar(ctx, sctx)));

  const alt = alternates(program);
  if (alt.short || alt.travel) {
    page.append(section({ title: 'For bad days', sub: 'Never miss twice. Logging one of these counts as a session done, but not as the planned strength session.' },
      h('div', null,
        alt.short ? sessionTemplate(ctx, alt.short, program.sessions[alt.short], 'Short on time') : null,
        alt.travel ? sessionTemplate(ctx, alt.travel, program.sessions[alt.travel], 'Gym closed') : null)));
  }

  const addons = program.addons || [];
  if (addons.length) {
    page.append(section({ title: 'Add-ons', sub: 'Extra sessions that run alongside a phase while their gate allows. They never count towards your strength sessions.' },
      h('div', { class: 'grid grid-auto' }, addons.map((a) => {
        const cl = ctx.data.profile.clearances;
        const active = addonActive(a, cl, ctx.today, pos ? pos.phaseId : null);
        const waitingPhysio = !addonVisible({ source: 'addon', addon: a, session: program.sessions?.[a.session] }, ctx.data);
        const ended = a.until_gate && isGateMet(a.until_gate, cl, ctx.today);
        const gateOk = isGateMet(a.gate || 'none', cl, ctx.today);
        const limited = Array.isArray(a.phases) && a.phases.length;
        const phaseNames = limited ? a.phases.map((id) => tl.phases.find((p) => p.id === id)?.short || id).join(', ') : '';
        const state = active && waitingPhysio ? 'Waiting for your physio’s programme'
          : active ? 'Running now'
            : ended ? `Finished once “${gateLabel(a.until_gate)}” was recorded`
              : !gateOk ? `Starts once “${gateLabel(a.gate || 'none')}” is recorded`
                : limited ? `Runs during ${phaseNames}` : 'Not running today';
        const days = Array.isArray(a.days) ? a.days.map((d) => WEEKDAYS[DAY_KEYS.indexOf(String(d).toLowerCase().slice(0, 3))] || d).join(', ') : 'Every day';
        return sheet({ class: 'sheet-tight' },
          h('p', { style: { 'font-weight': 600 } }, a.name || sessionName(a.session)),
          h('p', { class: 'small', style: { 'margin-top': '4px' } }, chip(state, active && !waitingPhysio ? 'chip-open' : 'chip-locked')),
          h('p', { class: 'small muted', style: { 'margin-top': '6px' } }, `${days}. Session: ${sessionName(a.session)}.${limited ? ` Only in ${phaseNames}.` : ''}${a.until_gate ? ` Ends at “${gateLabel(a.until_gate)}”.` : ''}`));
      }))));
  }

  const sessions = Object.entries(program.sessions || {}).filter(([, s]) => s && typeof s === 'object' && s.type !== 'rest');
  if (sessions.length) {
    page.append(section({ title: 'Session templates', sub: 'Week-one targets. The logger adjusts them for special weeks and easy days.' },
      h('div', null, sessions.map(([id, s]) => sessionTemplate(ctx, id, s)))));
  }

  const routines = Object.entries(program.routines || {}).filter(([, r]) => r && Array.isArray(r.items));
  if (routines.length) {
    page.append(section({ title: 'Routines' }, h('div', { class: 'grid grid-2' }, routines.map(([id, r]) => sheet({ class: 'sheet-tight' },
      h('p', { style: { 'font-weight': 600 } }, `${r.name || id}${isNum(r.minutes) ? `, about ${r.minutes} min` : ''}`),
      h('ul', { class: 'routine-items', style: { 'grid-template-columns': '1fr' } }, r.items.filter((x) => x && x.exercise).map((it) => h('li', null, exerciseButton(it.exercise, ctx), h('span', { class: 'dose' }, it.dose || '')))))))));
  }

  const rules = program.rules || {};
  const ruleText = [['progression', 'How you progress'], ['deload', 'Deloads'], ['readiness', 'Readiness'], ['missed_sessions', 'Missed sessions']]
    .filter(([k]) => typeof rules[k] === 'string' && rules[k].trim());
  if (ruleText.length) {
    page.append(section({ title: 'The rules' }, h('div', { class: 'grid grid-2' }, ruleText.map(([k, label]) => sheet({ class: 'sheet-tight' },
      h('h3', { class: 'mini-title' }, label), h('p', { class: 'read' }, gateText(rules[k])))))));
  }
  return page;
}
