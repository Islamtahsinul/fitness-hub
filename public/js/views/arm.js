// #/arm: clearance gates, appointments, clinic questions, rehab log and charts,
// healing stages, red flags and the physio exercise list.

import { h, uid, toast, confirmDialog, fmtNum } from '../dom.js';
import { fmtDay, isISODate, todayISO, daysBetween } from '../dates.js';
import { CLEARANCE_GATES, isGateMet, gateRank, GATE_ORDER } from '../schedule.js';
import { isNum } from '../calc.js';
import { pageHead, section, sheet, chip, gates, gateLabel, gateText, numberField, textField, textareaField, dateField, selectField, emptyState, missingContent, exerciseButton, deleteWithUndo, lockIcon } from '../components.js';
import { timeChart } from '../charts.js';
import { content } from '../content.js';
import { matchAnswers, answerRecord, questionKey } from '../features/questions.js';
import { unlockInfo, recordClearanceFlow, injuryDateOf } from '../features/clearance.js';
import { formDraft } from '../features/drafts.js';
import { undoSlot } from '../features/undo.js';
import { redFlags } from './checkin.js';
import { RED_STOP, ARM_LOG_PAIN, RED_PAIN } from '../features/safety.js';
import * as store from '../store.js';

export const title = 'Your arm';

const FALLBACK_MEASURES = [
  { id: 'pain_rest', name: 'Pain at rest', unit: '/10' }, { id: 'pain_activity', name: 'Pain with activity', unit: '/10' },
  { id: 'grip_injured_kg', name: 'Grip, injured hand', unit: 'kg' }, { id: 'grip_good_kg', name: 'Grip, good hand', unit: 'kg' },
  { id: 'wrist_flex_deg', name: 'Wrist flexion', unit: '°' }, { id: 'wrist_ext_deg', name: 'Wrist extension', unit: '°' },
  { id: 'pronation_deg', name: 'Pronation (palm down)', unit: '°' }, { id: 'supination_deg', name: 'Supination (palm up)', unit: '°' },
];
const DOTS_MAX = 60; // PERF9: dots only for short series
let chartMeasure = null;
let logDate = null; // the rehab-log date you picked, kept across re-renders even before you type

/**
 * BT2-11: grip readings wait for their clearance. The good hand is measured once the clinic has
 * said your other arm can train (Good arm OK, or any higher clearance); the injured hand only once
 * gripping is cleared. Other measurements are open (your physio decides what you measure).
 */
export const MEASURE_GATES = { grip_good_kg: 'good_arm_ok', grip_injured_kg: 'grip_cleared' };
const MEASURE_WHY = {
  grip_good_kg: 'Opens at “{gate}”: gripping hard with your good hand waits until the clinic says your other arm can train.',
  grip_injured_kg: 'Opens at “{gate}”: no gripping with the injured hand until your physio clears it.',
};

function measures() {
  const list = content.arm?.measurements?.length ? content.arm.measurements : FALLBACK_MEASURES;
  return list.map((m) => ({ id: m.id, name: m.name || m.id, unit: m.unit || '', how: m.how || '', reference: m.reference || '' }));
}

function gateCard(ctx, g) {
  const cl = ctx.data.profile.clearances;
  const today = ctx.today;
  const def = gates().find((x) => x.id === g);
  const own = cl[g];
  const met = isGateMet(g, cl, today);
  const via = met && !isISODate(own) ? GATE_ORDER.slice(gateRank(g) + 1).find((x) => isISODate(cl[x]) && cl[x] <= today) : null;
  const info = unlockInfo(g);
  let state;
  if (isISODate(own) && own <= today) state = `Recorded from ${fmtDay(own, { year: true })}`;
  else if (isISODate(own)) state = `Set for ${fmtDay(own, { year: true })}`;
  else if (via) state = `Included in “${gateLabel(via)}”, which is recorded`;
  else state = 'Not yet';
  const setDate = async () => {
    if (await recordClearanceFlow(ctx, g)) ctx.rerender();
  };
  const clearIt = async () => {
    const ok = await confirmDialog({ title: `Remove “${def.label}”?`, body: 'Exercises and phases that depend on it will lock again. Your logged sessions are kept.', confirmText: 'Remove the date', danger: true });
    if (!ok) return;
    cl[g] = null;
    store.touch();
    toast('Clearance removed');
    ctx.rerender();
  };
  return sheet({ class: ['gate-card', met && 'is-met'] },
    h('div', { class: 'gate-card-head' },
      h('h3', { class: 'gate-card-name' }, lockIcon(met, 16), ' ', def.label),
      h('p', { class: 'gate-card-state' }, state)),
    h('p', { class: 'gate-card-desc' }, gateText(def.description)),
    h('div', { class: 'block-actions' },
      h('button', { type: 'button', class: ['btn', 'btn-sm', !isISODate(own) && 'btn-primary'], onClick: setDate }, isISODate(own) ? 'Change the date' : 'Record clearance'),
      isISODate(own) ? h('button', { type: 'button', class: 'btn btn-sm btn-ghost', onClick: clearIt }, 'Remove') : null),
    info.exs.length ? h('details', { class: 'disclose' }, h('summary', null, `Unlocks ${info.exs.length} exercise${info.exs.length === 1 ? '' : 's'}${info.phases.length ? `, ${info.phases.map((p) => p.short || p.name).join(', ')}` : ''}${info.addons.length ? ` and ${info.addons.map((a) => a.name || 'an add-on').join(', ')}` : ''}`),
      h('div', { class: 'chip-row', style: { 'margin-top': '10px' } }, info.exs.map((e) => h('a', { class: 'chip chip-btn', href: `#/exercises/${encodeURIComponent(e.id)}` }, e.name)))) : null);
}

function appointments(ctx) {
  const arm = ctx.data.arm;
  const list = arm.appointments;
  const host = h('div', { class: 'stack' });
  const draw = () => {
    const sorted = list.slice().sort((a, b) => (String(a.date) < String(b.date) ? -1 : 1));
    host.replaceChildren(...(sorted.length ? sorted.map((a) => sheet({ class: 'sheet-tight' },
      h('div', { class: 'form-grid' },
        dateField({ label: 'Date', value: a.date, onChange: (v) => { a.date = v; store.touch(); } }),
        textField({ label: 'Type', value: a.type, placeholder: 'Fracture clinic, physio…', onInput: (v) => { a.type = v; store.touch(); } }),
        h('div', { class: 'span-2' }, textField({ label: 'Notes', value: a.notes, placeholder: 'Time, place, what to bring', onInput: (v) => { a.notes = v; store.touch(); } })),
        h('div', { class: 'span-all' }, textareaField({ label: 'Outcome', value: a.outcome, rows: 2, placeholder: 'What they said, any limits, next steps', onInput: (v) => { a.outcome = v; store.touch(); } }))),
      h('div', { class: 'block-actions' },
        isISODate(a.date) ? chip(((n) => (n === 0 ? 'Today' : n === 1 ? 'Tomorrow' : n > 1 ? `In ${fmtNum(n)} days` : 'Past'))(daysBetween(ctx.today, a.date)), a.date >= ctx.today ? 'chip-accent' : null) : null,
        h('button', { type: 'button', class: 'btn btn-sm btn-ghost', onClick: async () => {
          const label = `the ${a.type || 'appointment'}${isISODate(a.date) ? ` on ${fmtDay(a.date, { year: true })}` : ''}`;
          if (String(a.outcome || '').trim() || (isISODate(a.date) && a.date < ctx.today)) {
            const ok = await confirmDialog({ title: 'Delete this appointment?', body: `${label.charAt(0).toUpperCase()}${label.slice(1)}${String(a.outcome || '').trim() ? ', and the outcome you wrote down' : ''}. You can undo it straight after.`, confirmText: 'Delete it', danger: true });
            if (!ok) return;
          }
          deleteWithUndo({ list, item: a, message: `Deleted ${label}`, after: draw, slot: 'arm-appointments' });
        } }, 'Delete')))) : [emptyState({ title: 'No appointments yet.', body: 'Add your next fracture clinic or physio appointment so the hub can count down to it.' })]));
  };
  draw();
  const defaults = content.arm?.appointments_default || [];
  return h('div', null, undoSlot('arm-appointments'), host, h('div', { class: 'block-actions' },
    h('button', { type: 'button', class: 'btn', onClick: () => { list.push({ date: ctx.today, type: '', notes: '', outcome: '' }); store.touch(); draw(); } }, 'Add an appointment'),
    defaults.length && !list.length ? h('button', { type: 'button', class: 'btn btn-ghost', onClick: () => { defaults.forEach((d) => list.push({ date: d.date || ctx.today, type: d.type || '', notes: d.notes || '', outcome: '' })); store.touch(); draw(); } }, 'Add the suggested appointments') : null));
}

function questions(ctx) {
  const qs = content.arm?.clinic_questions || [];
  if (!qs.length) return missingContent('The clinic questions');
  const store2 = ctx.data.arm.questions;
  const matched = matchAnswers(qs, store2);
  const topics = [...new Set(qs.map((q) => q.topic || 'General'))];
  return h('div', null, topics.map((t) => h('div', { style: { 'margin-bottom': '18px' } },
    h('h3', { class: 'mini-title' }, t),
    h('div', null, qs.map((q, i) => [q, i]).filter(([q]) => (q.topic || 'General') === t).map(([q, i]) => {
      let found = matched.get(i) || null;
      const rec = found?.rec || null;
      const id = uid('q');
      const get = () => {
        const r = answerRecord(store2, q, found);
        found = { key: questionKey(q), rec: r, via: 'id' };
        return r;
      };
      return h('div', { class: 'question' },
        h('div', { class: 'check' },
          h('input', { id, type: 'checkbox', checked: !!rec?.asked, onChange: (e) => { get().asked = e.target.checked; store.touch(); } }),
          h('label', { for: id }, q.question)),
        q.why ? h('p', { class: 'q-why' }, gateText(q.why)) : null,
        found?.via === 'similar' ? h('p', { class: 'q-why' }, 'This question’s wording has changed since you answered it. Your earlier answer is kept below.') : null,
        textareaField({ label: 'Their answer', value: rec?.notes || '', rows: 2, onInput: (v) => { get().notes = v; store.touch(); } }));
    })))));
}

/**
 * BT2-6 / SPEC 5.2 round 4: rehab-log pain of 7 or more is RED, exactly like the check-in. Saving
 * it brings up the red-flag guidance, and on today's log a way to Today, which is now red.
 */
async function redFlagPrompt(ctx, date, pain) {
  const isToday = date === ctx.today;
  const flags = redFlags();
  const ok = await confirmDialog({
    title: `Arm pain ${fmtNum(pain)}/10: stop and get advice`,
    body: h('div', { class: 'stack-sm' },
      h('p', { class: 'modal-text' }, `Saved. Arm pain of ${RED_PAIN} out of 10 or more is a red flag, so ${isToday ? 'today is now red' : `${fmtDay(date)} counts as a red day`}.`),
      h('p', { class: 'modal-text notice notice-bad small' }, RED_STOP),
      h('details', { class: 'disclose' }, h('summary', null, 'The other red flags'),
        h('ul', { class: 'plain' }, flags.map((f) => h('li', null, h('strong', null, f.label), f.action ? `: ${f.action}` : ''))))),
    confirmText: isToday ? 'Open Today' : 'Close', cancelText: isToday ? 'Stay here' : 'Back to the log', danger: isToday,
  });
  if (ok && isToday) ctx.navigate('#/today');
}

/**
 * The rehab log form. What you type is kept as a draft (this tab) until you press Save, so a
 * re-render, a date change or a trip to another page never wipes it (PE6).
 */
function rehabLog(ctx) {
  const ms = measures();
  const logs = ctx.data.arm.logs;
  const logFor = (d) => logs.find((l) => l.date === d) || null;
  const draft = formDraft('arm-log', { date: ctx.today, values: {}, notes: null, touched: [] });
  const form = draft.value;
  if (!draft.dirty && isISODate(logDate) && logDate <= ctx.today) form.date = logDate;
  if (!isISODate(form.date)) form.date = ctx.today;
  const typed = () => new Set(Array.isArray(form.touched) ? form.touched : []);
  const valueOf = (id) => {
    if (typed().has(id)) return form.values?.[id];
    return logFor(form.date)?.values?.[id];
  };
  const notesNow = () => (form.notes !== null && form.notes !== undefined ? form.notes : logFor(form.date)?.notes || '');
  const touch = (id, v) => {
    const t = typed();
    t.add(id);
    draft.merge({ values: { ...(form.values || {}), [id]: v }, touched: [...t] });
    drawState();
  };
  const fieldsHost = h('div', { class: 'form-grid' });
  const stateLine = h('p', { class: 'small muted draft-state', 'aria-live': 'polite' });
  const drawState = () => {
    const ex = logFor(form.date);
    stateLine.textContent = draft.dirty ? `Not saved yet: you have changes for ${fmtDay(form.date)}. Press Save the log.` : ex ? `Showing your log for ${fmtDay(form.date)}.` : `Nothing logged for ${fmtDay(form.date)} yet.`;
  };
  const drawFields = () => {
    fieldsHost.replaceChildren(
      dateField({ label: 'Date', value: form.date, max: todayISO(), onChange: (v) => {
        if (!isISODate(v)) return;
        // Typed values move with you to the new date; untouched fields show that date's log.
        logDate = v;
        if (draft.dirty) draft.merge({ date: v }); else form.date = v;
        drawFields();
      } }),
      ...ms.map((m) => {
        const gate = MEASURE_GATES[m.id];
        const shut = gate && !isGateMet(gate, ctx.data.profile.clearances || {}, form.date);
        const f = numberField({
          label: m.name, unit: m.unit && m.unit.length <= 6 ? m.unit : null, value: shut ? null : valueOf(m.id), step: 'any', fkey: `arm-log:${m.id}`,
          disabled: !!shut, hint: shut ? MEASURE_WHY[m.id].replace('{gate}', gateLabel(gate)) : null, onInput: (v) => touch(m.id, v),
        });
        if (shut) { f.classList.add('field-locked'); f.querySelector('.field-label')?.prepend(lockIcon(false), ' '); return f; }
        if (m.how || m.reference) {
          f.append(h('details', { class: 'disclose field-how' }, h('summary', null, 'How to measure'),
            m.how ? h('p', { class: 'field-hint' }, gateText(m.how)) : null,
            m.reference ? h('p', { class: 'field-hint' }, m.reference) : null));
        }
        return f;
      }),
      h('div', { class: 'span-all' }, textareaField({ label: 'Notes', value: notesNow(), rows: 2, fkey: 'arm-log:notes', onInput: (v) => { draft.merge({ notes: v }); drawState(); } })));
    drawState();
  };
  drawFields();
  const save = async () => {
    const ex = logFor(form.date);
    const merged = { ...(ex?.values || {}) };
    for (const id of typed()) {
      const gate = MEASURE_GATES[id];
      if (gate && !isGateMet(gate, ctx.data.profile.clearances || {}, form.date)) continue; // locked readings are never saved
      merged[id] = form.values?.[id];
    }
    const vals = Object.fromEntries(Object.entries(merged).filter(([, v]) => isNum(v)));
    const notes = notesNow();
    if (!Object.keys(vals).length && !notes) { toast('Enter at least one measurement.'); return; }
    if (ex) { ex.values = vals; ex.notes = notes; } else logs.push({ date: form.date, values: vals, notes });
    logs.sort((a, b) => (a.date < b.date ? -1 : 1));
    store.touch();
    draft.clear();
    logDate = form.date;
    const pain = Math.max(...ARM_LOG_PAIN.map((k) => (isNum(vals[k]) ? Number(vals[k]) : -1)));
    ctx.rerender();
    if (pain >= RED_PAIN) await redFlagPrompt(ctx, form.date, pain);
    else toast(`Rehab log saved for ${fmtDay(form.date)}`);
  };
  const discard = () => { draft.clear(); ctx.rerender(); };
  const recent = logs.filter((l) => isISODate(l.date)).slice().sort((a, b) => (a.date < b.date ? 1 : -1)).slice(0, 10);
  const shown = ms.filter((m) => recent.some((l) => isNum(l.values?.[m.id])));
  return h('div', { class: 'stack' },
    sheet(null, h('p', { class: 'small muted', style: { 'margin-bottom': '12px' } }, 'Measure only what your physio has shown you how to do. Leave the rest blank.'), fieldsHost,
      h('div', { class: 'block-actions' },
        h('button', { type: 'button', class: 'btn btn-primary', onClick: save }, 'Save the log'),
        draft.dirty ? h('button', { type: 'button', class: 'btn btn-ghost', onClick: discard }, 'Discard changes') : null),
      stateLine),
    recent.length ? h('div', { class: 'table-wrap' }, h('table', { class: 'table table-compact' },
      h('thead', null, h('tr', null, h('th', { scope: 'col' }, 'Date'), ...shown.map((m) => h('th', { scope: 'col', class: 'num' }, `${m.name}${m.unit ? ` (${m.unit})` : ''}`)), h('th', { scope: 'col' }, 'Notes'))),
      h('tbody', null, recent.map((l) => h('tr', null, h('th', { scope: 'row' }, fmtDay(l.date)), ...shown.map((m) => h('td', { class: 'num' }, isNum(l.values?.[m.id]) ? fmtNum(l.values[m.id], 1) : '–')), h('td', { class: 'small' }, l.notes || '')))))) : null);
}

function armCharts(ctx) {
  const ms = measures();
  const logs = (ctx.data.arm.logs || []).filter((l) => isISODate(l.date) && l.values && typeof l.values === 'object');
  const pts = (id) => logs.filter((l) => isNum(l.values[id])).map((l) => ({ date: l.date, value: Number(l.values[id]) }));
  const dots = (n) => (n <= DOTS_MAX ? 'all' : 'end');
  const painIds = ['pain_rest', 'pain_activity', 'pain_night'].filter((id) => ms.some((m) => m.id === id));
  const cls = ['s1', 's2', 's3'];
  const pain = timeChart({
    title: 'Arm pain', unit: '/10', dp: 0, height: 210, yZero: true,
    series: painIds.map((id, i) => { const p = pts(id); return { label: ms.find((m) => m.id === id)?.name || id, cls: cls[i], points: p, dots: dots(p.length), endLabel: painIds.length <= 2 }; }),
    empty: 'Log pain scores in the rehab log to see them here.',
  });
  const grip = logs.filter((l) => isNum(l.values.grip_injured_kg) && isNum(l.values.grip_good_kg) && Number(l.values.grip_good_kg) > 0)
    .map((l) => ({ date: l.date, value: (100 * Number(l.values.grip_injured_kg)) / Number(l.values.grip_good_kg) }));
  const gripChart = timeChart({
    title: 'Grip: injured side as % of good side', unit: '%', dp: 0, height: 210, yZero: true,
    series: [{ label: 'Injured grip, % of good', cls: 's1', points: grip, dots: dots(grip.length), endLabel: true }], refs: [{ value: 100, label: 'Good side' }],
    empty: 'Log both grip measurements on the same day to see this.',
  });
  const withData = ms.filter((m) => pts(m.id).length);
  if (!chartMeasure || !withData.some((m) => m.id === chartMeasure)) chartMeasure = withData[0]?.id || null;
  const anyHost = h('div');
  const drawAny = () => {
    const m = ms.find((x) => x.id === chartMeasure);
    const p = m ? pts(m.id) : [];
    anyHost.replaceChildren(m ? timeChart({ title: m.name, subtitle: m.reference || null, unit: m.unit || '', dp: 1, height: 200, series: [{ label: m.name, cls: 's1', points: p, dots: dots(p.length), endLabel: true }] }) : h('p', { class: 'chart-empty' }, 'No measurements logged yet.'));
  };
  drawAny();
  return h('div', { class: 'grid grid-2' },
    sheet(null, pain), sheet(null, gripChart),
    sheet({ class: 'span-all', style: { 'grid-column': '1 / -1' } },
      withData.length ? h('div', { style: { 'max-width': '360px', 'margin-bottom': '10px' } }, selectField({ label: 'Any measurement', value: chartMeasure, options: withData.map((m) => ({ value: m.id, label: m.name })), onChange: (v) => { chartMeasure = v; drawAny(); } })) : null,
      anyHost));
}

function physio(ctx) {
  const list = ctx.data.arm.physio_exercises;
  const rehab = content.exercises.filter((e) => e.category === 'rehab');
  const host = h('div', { class: 'stack' });
  const draw = () => {
    host.replaceChildren(...(list.length ? list.map((p) => {
      const known = content.exById.has(p.exercise);
      return sheet({ class: 'sheet-tight' },
        h('div', { class: 'form-grid' },
          selectField({ label: 'Exercise', value: known ? p.exercise : '', cls: 'span-2', options: [{ value: '', label: 'Other (type below)' }, ...rehab.map((e) => ({ value: e.id, label: e.name }))], onChange: (v) => { p.exercise = v || ''; store.touch(); draw(); } }),
          known ? h('div', { class: 'field' }, h('span', { class: 'field-label' }, 'Library'), h('p', { style: { 'padding-top': '8px' } }, exerciseButton(p.exercise, ctx, { label: 'How to do it' })))
            : textField({ label: 'Exercise name', value: p.exercise, onInput: (v) => { p.exercise = v; store.touch(); } }),
          textField({ label: 'Dose', value: p.dose, placeholder: 'e.g. 10 reps, 3 times a day', onInput: (v) => { p.dose = v; store.touch(); } }),
          dateField({ label: 'Since', value: p.since, onChange: (v) => { p.since = v; store.touch(); } }),
          h('div', { class: 'span-all' }, textField({ label: 'Notes', value: p.notes, onInput: (v) => { p.notes = v; store.touch(); } }))),
        h('div', { class: 'block-actions' }, h('button', { type: 'button', class: 'btn btn-sm btn-ghost', onClick: () => {
          deleteWithUndo({ list, item: p, message: `Removed ${known ? content.exById.get(p.exercise).name : p.exercise || 'the physio exercise'}`, after: draw, slot: 'arm-physio' });
        } }, 'Remove')));
    }) : [h('div', { class: 'notice notice-accent waiting-physio', role: 'note' },
      h('p', null, h('strong', null, 'Waiting for your physio’s programme.')),
      h('p', null, 'The rehab add-on appears in your plan, and counts, only once you add the exercises your physio gives you here, exactly as prescribed. Until then, nothing goes through the injured arm.'))]));
  };
  draw();
  return h('div', null, undoSlot('arm-physio'), host, h('div', { class: 'block-actions' }, h('button', { type: 'button', class: 'btn', onClick: () => { list.push({ exercise: '', dose: '', since: ctx.today, notes: '' }); store.touch(); draw(); } }, 'Add a physio exercise')));
}

export function render(ctx) {
  const page = h('div', { class: 'page' });
  const injury = injuryDateOf(ctx.data.profile);
  page.append(pageHead({ title: 'Your arm', lede: `${injury ? `Injured ${fmtDay(injury, { year: true })}. ` : ''}Your fracture clinic and physio are in charge of this arm: this page keeps their decisions, your questions and your measurements in one place.` }));

  page.append(section({ title: 'Clearances', sub: 'Gates are cumulative: a higher clearance counts for the lower ones too.' },
    h('div', { class: 'grid grid-2' }, CLEARANCE_GATES.map((g) => gateCard(ctx, g)))));

  page.append(section({ title: 'Appointments' }, appointments(ctx)));

  const qSection = section({ title: 'Questions for the clinic', sub: 'Tick them off as you ask, and write down the answers while they are fresh.', cls: 'questions-section',
    actions: h('button', { type: 'button', class: 'btn btn-sm', onClick: () => {
      qSection.classList.add('print-target');
      document.body.classList.add('print-target-only');
      const done = () => { qSection.classList.remove('print-target'); document.body.classList.remove('print-target-only'); window.removeEventListener('afterprint', done); };
      window.addEventListener('afterprint', done);
      window.print();
    } }, 'Print the questions') },
  questions(ctx));
  page.append(qSection);

  page.append(section({ title: 'Rehab log', sub: 'Pain, grip and range of movement over time.' }, rehabLog(ctx)));
  page.append(section({ title: 'Charts' }, armCharts(ctx)));

  const stages = content.arm?.healing_stages || [];
  page.append(section({ title: 'How bone heals', sub: 'Typical timings only. Your X-rays and your clinic decide.' },
    stages.length ? h('ol', { class: 'timeline' }, stages.map((s) => h('li', null,
      h('p', { class: 'tl-title' }, s.stage || ''),
      s.typical_timing ? h('p', { class: 'tl-when' }, s.typical_timing) : null,
      s.what_happens ? h('p', { class: 'tl-body' }, s.what_happens) : null,
      s.training_implications ? h('p', { class: 'tl-body' }, h('strong', null, 'For training: '), gateText(s.training_implications)) : null))) : missingContent('The healing stages')));

  page.append(section({ title: 'Red flags', sub: 'Any of these, or arm pain of 7 out of 10 or more: stop, and get advice the same day. In an emergency call 999.' },
    sheet(null, h('ul', { class: 'kv-list' }, redFlags().map((f) => h('li', { style: { display: 'block' } }, h('strong', null, f.label), f.action ? h('p', { class: 'small ink-2', style: { 'margin-top': '2px' } }, f.action) : null))))));

  page.append(section({ title: 'Your physio exercises', sub: 'Anything your physio prescribes overrides this programme.' }, physio(ctx)));
  return page;
}
