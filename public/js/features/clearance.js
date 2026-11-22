// Recording a clearance: one confirmation flow for the Your arm page and the welcome (PE12, BT2-5,
// BT2-12). A clearance unlocks exercises, phases and add-ons, so it is never recorded with a single
// tap: you pick the date (never before the injury, once its date is in your profile), then confirm a
// read-back of the date and of everything it opens. Gates are cumulative, so recording one also
// opens every gate below it: "Light use" also unlocks other-arm weights and the good-arm sessions.

import { h, toast, confirmDialog } from '../dom.js';
import { promptDate } from './datefield.js';
import { fmtDay, fmtDayLong, isISODate, todayISO, daysBetween, addDays } from '../dates.js';
import { buildTimeline, gateList, gateRank, highestGate, isRehabAddon, GATE_ORDER } from '../schedule.js';
import { content } from '../content.js';
import * as store from '../store.js';

export const OLD_DAYS = 14;

/** The optional profile.injury_date (SPEC 5.7) as an ISO date, or null: no clearance can be dated before it. */
export function injuryDateOf(profile) {
  const d = profile && typeof profile === 'object' ? profile.injury_date : null;
  return isISODate(d) ? d : null;
}

/** The date fields' message for a date before the injury (null when no injury date is set). */
export function beforeInjuryError(injury) {
  return isISODate(injury) ? `That’s before your injury on ${fmtDay(injury, { year: true })}. Enter the day your clinic told you.` : null;
}

const CATEGORY_WORDS = { 'knee-ankle': 'knee and ankle', 'single-leg': 'single-leg', conditioning: 'conditioning', rehab: 'rehab', mobility: 'mobility', core: 'core', grip: 'grip', carry: 'carry', push: 'push', pull: 'pull', hinge: 'hinge', squat: 'squat', calves: 'calf', hip: 'hip', balance: 'balance', power: 'power' };

/** What a gate opens: {exs, phases, addons} (exercises at exactly that gate). */
export function unlockInfo(g) {
  const exs = content.exercises.filter((e) => e.gate === g);
  const phases = (content.program?.phases || []).filter((p) => p.entry_gate === g);
  const addons = (content.program?.addons || []).filter((a) => a.gate === g);
  return { exs, phases, addons };
}

export const labelOf = (g) => gateList(content.program).find((x) => x.id === g)?.label || 'this clearance';

const listText = (names) => (names.length <= 1 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`);

/**
 * Everything recording gate `g` on `date` newly opens, given what's already recorded:
 * {gates: [ids newly met], exercises, byCategory: [text], phases: [names], addons: [{name, text}],
 *  goodArm: true when it also opens Good arm OK (other-arm weights and the good-arm sessions)}.
 */
export function unlockSummary(g, date, clearances = {}, program = content.program, exercises = content.exercises) {
  const before = highestGate(clearances || {}, date);
  const from = gateRank(before);
  const to = gateRank(g);
  const gates = GATE_ORDER.filter((x) => x !== 'none' && gateRank(x) > from && gateRank(x) <= to);
  const opens = (x) => gates.includes(x);
  const exs = (Array.isArray(exercises) ? exercises : []).filter((e) => e && opens(e.gate));
  const counts = new Map();
  for (const e of exs) counts.set(e.category || 'other', (counts.get(e.category || 'other') || 0) + 1);
  const byCategory = [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([c, n]) => `${n} ${CATEGORY_WORDS[c] || String(c).replace(/[-_]/g, ' ')}`);
  const phases = (program?.phases || []).filter((p) => p && opens(p.entry_gate)).map((p) => p.short || p.name || 'a phase');
  const addons = (program?.addons || []).filter((a) => a && opens(typeof a.gate === 'string' && a.gate ? a.gate : 'none')).map((a) => {
    const name = a.name || program?.sessions?.[a.session]?.name || 'An add-on';
    const where = Array.isArray(a.phases) && a.phases.length
      ? ` in ${listText(a.phases.map((id) => (program.phases || []).find((p) => p.id === id)?.short || id))}` : '';
    const text = isRehabAddon(a, program)
      ? `${name}${where}: it joins your plan once you enter your physio’s exercises on the Your arm page`
      : `${name}${where}`;
    return { name, text };
  });
  return { gates, exercises: exs.length, byCategory, phases, addons, goodArm: opens('good_arm_ok') && g !== 'good_arm_ok' };
}

/** The unlock text: exercises (by kind) and phases, then each add-on it starts. */
export function opensParts(g, date = todayISO(), clearances = {}) {
  const u = unlockSummary(g, date, clearances);
  const kinds = u.byCategory.slice(0, 4);
  const more = u.byCategory.length > 4;
  const what = !u.exercises ? 'It unlocks no new exercises'
    : `It unlocks ${u.exercises} exercise${u.exercises === 1 ? '' : 's'}${kinds.length ? ` (${more ? `${kinds.join(', ')} and more` : listText(kinds)})` : ''}`;
  const lead = `${what}${u.phases.length ? `, and can start ${listText(u.phases)}` : ''}.`;
  return { lead, addons: u.addons.map((a) => a.text) };
}

/** The unlock paragraph as one line of text (exercises, phases and add-ons). */
export function opensText(g, date = todayISO(), clearances = {}) {
  const p = opensParts(g, date, clearances);
  return p.addons.length ? `${p.lead} Add-ons it starts: ${p.addons.join('; ')}.` : p.lead;
}

/** The unlock paragraph for a dialog, the add-ons as a list. */
function opensNodes(g, date, clearances) {
  const p = opensParts(g, date, clearances);
  return [h('p', { class: 'modal-text' }, p.lead),
    p.addons.length ? h('div', { class: 'modal-text' }, h('p', null, `Add-on${p.addons.length === 1 ? '' : 's'} it starts:`), h('ul', { class: 'plain clearance-addons' }, p.addons.map((t) => h('li', null, t)))) : null];
}

/** BT2-5: a higher gate also opens Good arm OK. Say so, and when to record it. */
export function goodArmWarning(g, date, clearances = {}) {
  const u = unlockSummary(g, date, clearances);
  if (!u.goodArm) return null;
  return `Recording “${labelOf(g)}” also unlocks other-arm weights and the good-arm sessions, because each clearance includes the ones below it. Only record it if your clinic also said yes to training your other arm (chapter 18). If they didn’t, record nothing yet and ask at your next appointment.`;
}

/** BT2-12: the date read back, with a warning when it's old, in the future or before `injury` (an ISO date or null). */
export function dateCheck(date, today = todayISO(), injury = null) {
  const n = daysBetween(today, date);
  const when = n === 0 ? 'today' : n === 1 ? 'tomorrow' : n === -1 ? 'yesterday' : n > 1 ? `in ${n} days` : `${-n} days ago`;
  let warn = null;
  const beforeInjury = isISODate(injury) && date < injury;
  if (beforeInjury) warn = `That’s before your injury on ${fmtDay(injury, { year: true })}, so it can’t be right.`;
  else if (n > 0) warn = 'That date is in the future. Nothing unlocks until that day; record it then if you prefer.';
  else if (-n > OLD_DAYS) warn = `That’s more than two weeks ago. Check it’s the day your clinic or physio told you: the programme is recalculated as if you’d recorded it then.`;
  return { read: `${fmtDayLong(date, { year: true })} (${when})`, warn, invalid: beforeInjury };
}

/**
 * Asks "Is this right?" for recording gate `g` from `date`: the date read back, what it unlocks
 * (add-ons included), the Light-use warning and the phases it would start. Resolves true when
 * confirmed (it does not write anything).
 */
export async function confirmClearance(ctx, g, date) {
  const cl = ctx.data.profile.clearances || {};
  const check = dateCheck(date, ctx.today, injuryDateOf(ctx.data.profile));
  if (check.invalid) {
    await confirmDialog({ title: 'Check the date', body: check.warn, confirmText: 'Change the date', cancelText: 'Cancel' });
    return false;
  }
  const sim = { ...ctx.data.profile, clearances: { ...cl, [g]: date } };
  const tl = content.program ? buildTimeline(content.program, sim) : null;
  const opened = tl ? tl.phases.filter((p) => p.start && gateRank(p.entryGate) <= gateRank(g) && p.entryGate !== 'none' && p.start >= date).map((p) => `${p.short} starts ${fmtDay(p.start)}`) : [];
  const warn = goodArmWarning(g, date, cl);
  return confirmDialog({
    title: 'Is this right?',
    body: h('div', { class: 'stack-sm' },
      h('p', { class: 'modal-text' }, h('strong', null, `“${labelOf(g)}”`), ` from ${check.read}.`),
      check.warn ? h('p', { class: 'modal-text notice notice-warn small' }, check.warn) : null,
      ...opensNodes(g, date, cl),
      warn ? h('p', { class: 'modal-text notice notice-warn small clearance-warning' }, warn) : null,
      opened.length ? h('p', { class: 'modal-text' }, `${opened.join('. ')}.`) : null,
      h('p', { class: 'modal-text' }, 'Only record it if your fracture clinic or physio told you so, in person or in writing.')),
    confirmText: 'Yes, record it',
  });
}

/** Writes the clearance date (after confirmClearance). */
export function recordClearance(ctx, g, date) {
  ctx.data.profile.clearances[g] = date;
  store.touch();
  toast(`Recorded: ${labelOf(g)} from ${fmtDay(date, { year: true })}`);
}

/** The full flow: pick the date, confirm, record. Resolves true when recorded. */
export async function recordClearanceFlow(ctx, g) {
  const own = ctx.data.profile.clearances[g];
  const cl = ctx.data.profile.clearances || {};
  const warn = goodArmWarning(g, ctx.today, cl);
  const picked = await promptDate({
    title: `Record “${labelOf(g)}”`,
    body: h('div', { class: 'stack-sm' },
      h('p', { class: 'modal-text' }, 'Only record this once your fracture clinic or physio has told you, in person or in writing. Enter the day they told you.'),
      ...opensNodes(g, ctx.today, cl),
      warn ? h('p', { class: 'modal-text notice notice-warn small clearance-warning' }, warn) : null),
    value: isISODate(own) ? own : ctx.today, min: injuryDateOf(ctx.data.profile), max: addDays(ctx.today, 365),
    minError: beforeInjuryError(injuryDateOf(ctx.data.profile)),
    confirmText: 'Next',
  });
  if (!picked) return false;
  if (!(await confirmClearance(ctx, g, picked))) return false;
  recordClearance(ctx, g, picked);
  return true;
}
