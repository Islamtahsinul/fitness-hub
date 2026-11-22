// #/checkin[/YYYY-MM-DD]: the daily check-in (SPEC 5.7) with live readiness (SPEC 5.8, from the
// single source in features/safety.js). Every scale has its good end on the left.

import { h, uid, fmtNum, fmtFixed, debounce, confirmDialog } from '../dom.js';
import { addDays, fmtDay, isISODate, todayISO } from '../dates.js';
import { isNum, proteinTargets, tdee, bmrMifflin, targetKcal, ageFrom, READINESS_RULES } from '../calc.js';
import { latestValue, checkinOn, checkinIssues } from '../stats.js';
import { findWorkout, sessionName } from './shared.js';
import { pageHead, section, sheet, readinessBadge, readinessWord, numberField, scaleField, textareaField, dateField, checkField, statusIcon, selectField, painReadBack, crossesRed } from '../components.js';
import { content } from '../content.js';
import { readinessFor, rhrAmberAt, RED_STOP } from '../features/safety.js';
import { planOn } from '../features/plan.js';
import { offerUndo, undoSlot } from '../features/undo.js';
import * as store from '../store.js';

export const title = 'Check-in';

export const RED_FLAG_FALLBACK = [
  { id: 'pain_increasing', label: 'Pain is getting worse, not better', action: 'Contact the fracture clinic today.' },
  { id: 'swelling_new', label: 'New or increasing swelling', action: 'Rest and raise the arm, and contact the fracture clinic.' },
  { id: 'redness_heat', label: 'Redness, heat or spreading redness around the arm or wound', action: 'Possible infection: contact the clinic or NHS 111 today.' },
  { id: 'wound_discharge', label: 'Wound leaking, smelling or opening', action: 'Contact the clinic or NHS 111 today.' },
  { id: 'fever_unwell', label: 'Fever, chills or feeling generally unwell', action: 'Call NHS 111. Infection after an open fracture needs prompt care.' },
  { id: 'numbness_tingling', label: 'New numbness, tingling or pins and needles in the hand', action: 'Contact the clinic or NHS 111 today.' },
  { id: 'colour_cold', label: 'Hand or fingers pale, blue or cold', action: 'Urgent: call 999 or go to A&E if it doesn’t settle quickly.' },
  { id: 'deformity_give', label: 'New bend, clicking, or the arm giving way', action: 'Stop using the arm and contact the clinic or NHS 111.' },
  { id: 'fall_on_arm', label: 'You fell or landed on the arm', action: 'Contact the fracture clinic or NHS 111 for advice.' },
];

export function redFlags() {
  const list = (content.arm?.red_flags || []).map((f) => ({ id: f.id, label: f.label || f.id, action: f.action || '' }));
  for (const f of RED_FLAG_FALLBACK) if (!list.some((x) => x.id === f.id)) list.push(f);
  return list;
}

const RED_PAIN_AT = Number.isFinite(READINESS_RULES?.redPain) ? READINESS_RULES.redPain : 7;
const AMBER_PAIN_AT = Number.isFinite(READINESS_RULES?.amberPain) ? READINESS_RULES.amberPain : 4;
const SORENESS_AT = Number.isFinite(READINESS_RULES?.sorenessMax) ? READINESS_RULES.sorenessMax : 7;

/**
 * Round 4 (finding 8): arm pain moving across the RED line (7/10), either way, is confirmed
 * first, so a slip of the thumb can never stop (or restart) a day's training on its own.
 */
export async function confirmArmPain(next, prev) {
  if (!crossesRed(next, prev, RED_PAIN_AT)) return true;
  if (isNum(next) && next >= RED_PAIN_AT) {
    return confirmDialog({
      title: `Arm pain ${next}/10?`,
      body: `${next}/10 = RED: no training today, including your physio exercises, and contact your fracture clinic today. Is ${next} right?`,
      confirmText: `Yes, ${next}/10 is right`, cancelText: 'No, change it',
    });
  }
  return confirmDialog({
    title: isNum(next) ? `Lower arm pain to ${next}/10?` : 'Clear the arm pain score?',
    body: `It was ${prev}/10, which makes today red. ${isNum(next) ? `At ${next}/10 today is no longer red from arm pain.` : 'Without a score today is no longer red from arm pain.'} Only change it if ${prev} was a slip.`,
    confirmText: isNum(next) ? `Yes, ${next}/10 is right` : 'Yes, clear it', cancelText: `No, keep ${prev}/10`,
  });
}

const blank = (date) => ({
  date, weight_kg: null, rhr: null, hrv: null, sleep_h: null, sleep_q: null, energy: null, soreness: null, mood: null,
  stress: null, arm_pain: null, arm_flags: [], steps: null, protein_g: null, calories: null, water_l: null, creatine: false, notes: '',
});

// ---------------------------------------------------------------- meal templates and quick-add (PM10)

const FOLLOWED = [['yes', 'Yes', 1], ['mostly', 'Mostly', 0.8], ['no', 'No', 0]];

/** The template the check-in fills from: your last choice, else the one closest to your calorie target. */
export function defaultTemplate(data, today = todayISO()) {
  const list = content.nutrition?.meal_templates || [];
  if (!list.length) return null;
  const chosen = data?.ui?.meal_template;
  const byId = list.find((t) => (t.id || t.name) === chosen);
  if (byId) return byId;
  const pr = data.profile || {};
  const w = latestValue(data, 'weight_kg', today);
  const kcal = w ? targetKcal(tdee(bmrMifflin({ sex: pr.sex, weightKg: w.value, heightCm: pr.height_cm, age: ageFrom(pr.birth_year, today) }), pr.activity_factor), pr.surplus_kcal) : null;
  if (!isNum(kcal)) return list.find((t) => /3000|3,000/.test(String(t.id || t.name))) || list[0];
  return list.filter((t) => isNum(t.kcal)).reduce((b, t) => (!b || Math.abs(t.kcal - kcal) < Math.abs(b.kcal - kcal) ? t : b), null) || list[0];
}

/** Protein and kcal for a template answer: yes = 100 %, mostly = 80 %, no = nothing. */
export function templateTotals(template, answer) {
  const f = (FOLLOWED.find(([k]) => k === answer) || [])[2] || 0;
  if (!template || !f) return { protein_g: 0, calories: 0 };
  return { protein_g: Math.round((Number(template.protein_g) || 0) * f), calories: Math.round(((Number(template.kcal) || 0) * f) / 10) * 10 };
}

function foodControls(ctx, getRec, recNow, { onTotals, slot }) {
  const { data } = ctx;
  const templates = content.nutrition?.meal_templates || [];
  const foods = content.nutrition?.foods || [];
  if (!templates.length && !foods.length) return null;
  const wrap = h('div', { class: 'food-controls' });
  const tplId = (t) => t.id || t.name;
  const current = () => {
    const rec = recNow();
    const id = rec?.meal_template;
    return templates.find((t) => tplId(t) === id) || defaultTemplate(data, ctx.today);
  };
  const adds = () => (Array.isArray(recNow()?.quick_adds) ? recNow().quick_adds : []);
  const sumAdds = (list) => list.reduce((a, x) => ({ protein_g: a.protein_g + (Number(x.protein_g) || 0), calories: a.calories + (Number(x.kcal) || 0) }), { protein_g: 0, calories: 0 });
  const apply = (answer) => {
    const rec = getRec();
    const before = { protein_g: rec.protein_g, calories: rec.calories, meal_followed: rec.meal_followed, meal_template: rec.meal_template };
    const t = current();
    rec.meal_followed = answer;
    if (t) rec.meal_template = tplId(t);
    if (answer !== 'no') {
      const base = templateTotals(t, answer);
      const extra = sumAdds(adds());
      rec.protein_g = base.protein_g + extra.protein_g;
      rec.calories = base.calories + extra.calories;
    }
    store.touch();
    onTotals();
    draw();
    if (answer !== 'no') {
      offerUndo(slot, {
        message: `Filled from “${t?.name || 'your template'}”: ${fmtNum(rec.protein_g)} g protein, ${fmtNum(rec.calories)} kcal.`,
        undo: () => { Object.assign(getRec(), before); store.touch(); onTotals(); draw(); },
      });
    }
  };
  const draw = () => {
    const rec = recNow();
    const t = current();
    const name = uid('meal');
    const answer = rec?.meal_followed || '';
    let chosen = '';
    const list = adds();
    wrap.replaceChildren(
      templates.length ? h('fieldset', { class: 'field meal-followed' },
        h('legend', { class: 'field-label' }, 'Followed my meal template'),
        h('div', { class: 'seg seg-radio' }, FOLLOWED.map(([k, label]) => {
          const id = `${name}-${k}`;
          return h('span', { class: 'seg-opt' },
            h('input', { type: 'radio', id, name, value: k, checked: answer === k, onChange: () => apply(k) }),
            h('label', { for: id }, label));
        })),
        templates.length > 1 ? h('div', { class: 'meal-tpl' }, selectField({
          label: 'Template', value: t ? tplId(t) : '', options: templates.map((x) => ({ value: tplId(x), label: `${x.name || tplId(x)}${isNum(x.protein_g) ? ` (${fmtNum(x.protein_g)} g protein)` : ''}` })),
          onChange: (v) => {
            data.ui = data.ui && typeof data.ui === 'object' ? data.ui : {};
            data.ui.meal_template = v;
            const r2 = recNow();
            if (r2) r2.meal_template = v;
            store.touch();
            if (r2?.meal_followed && r2.meal_followed !== 'no') apply(r2.meal_followed); else draw();
          },
        })) : null,
        h('p', { class: 'field-hint' }, t ? `Yes fills ${fmtNum(t.protein_g)} g protein and ${fmtNum(t.kcal)} kcal; mostly fills 80% of that. Quick-adds go on top.` : '')) : null,
      foods.length ? h('div', { class: 'quick-add' },
        h('div', { class: 'quick-add-row' },
          selectField({
            label: 'Quick-add a food', value: '', cls: 'field-grow',
            options: [{ value: '', label: 'Choose a food' }, ...[...new Set(foods.map((f) => f.category || 'Other'))].map((c) => ({ group: c, options: foods.filter((f) => (f.category || 'Other') === c).map((f, i) => ({ value: `${c}|${f.name}`, label: `${f.name}${f.serving ? `, ${f.serving}` : ''}${isNum(f.protein_g) ? ` (${fmtNum(f.protein_g, 1)} g)` : ''}` })) }))],
            onChange: (v) => { chosen = v; },
          }),
          h('button', { type: 'button', class: 'btn', onClick: () => {
            const f = foods.find((x) => `${x.category || 'Other'}|${x.name}` === chosen);
            if (!f) return;
            const rec = getRec();
            rec.quick_adds = Array.isArray(rec.quick_adds) ? rec.quick_adds : [];
            const item = { name: f.name, serving: f.serving || '', protein_g: Number(f.protein_g) || 0, kcal: Number(f.kcal) || 0 };
            rec.quick_adds.push(item);
            rec.protein_g = (Number(rec.protein_g) || 0) + item.protein_g;
            rec.calories = (Number(rec.calories) || 0) + item.kcal;
            store.touch();
            onTotals();
            draw();
            offerUndo(slot, {
              message: `Added ${f.name}: +${fmtNum(item.protein_g, 1)} g protein, +${fmtNum(item.kcal)} kcal.`,
              undo: () => {
                const r2 = getRec();
                const i = (r2.quick_adds || []).indexOf(item);
                if (i >= 0) r2.quick_adds.splice(i, 1);
                r2.protein_g = Math.max(0, (Number(r2.protein_g) || 0) - item.protein_g);
                r2.calories = Math.max(0, (Number(r2.calories) || 0) - item.kcal);
                store.touch(); onTotals(); draw();
              },
            });
          } }, 'Add')),
        list.length ? h('ul', { class: 'chip-row quick-list', 'aria-label': 'Foods added' }, list.map((x) => h('li', { class: 'chip' }, `${x.name}${x.serving ? `, ${x.serving}` : ''}: +${fmtNum(x.protein_g, 1)} g`))) : null) : null,
      undoSlot(slot));
  };
  draw();
  return wrap;
}

export function render(ctx) {
  const { data } = ctx;
  const date = isISODate(ctx.params[0]) ? ctx.params[0] : ctx.today;
  let rec = data.checkins.find((c) => c.date === date) || null;
  const get = () => {
    if (!rec) {
      rec = blank(date);
      data.checkins.push(rec);
      data.checkins.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
    }
    return rec;
  };
  const resultBox = h('div');
  const redInline = h('div', { class: 'checkin-red-inline' });
  // BT1-15: on a phone the verdict stays in view at the top while you fill the form in.
  const stickyVerdict = h('a', { class: 'checkin-sticky', href: '#checkin-result', onClick: (e) => { e.preventDefault(); document.getElementById('checkin-result')?.scrollIntoView({ block: 'start' }); document.getElementById('checkin-result')?.focus({ preventScroll: true }); } });
  const announcer = h('p', { class: 'visually-hidden', 'aria-live': 'polite', 'aria-atomic': 'true' });
  let announced = readinessFor(data, date).level;
  const announce = debounce(() => {
    const lvl = readinessFor(data, date).level;
    if (lvl === announced) return;
    announced = lvl;
    announcer.textContent = lvl === 'unknown' ? 'Readiness: not enough answers yet.' : `Readiness is now ${readinessWord(lvl)}${lvl === 'amber' ? ': easy day' : lvl === 'red' ? ': stop, no training today' : ': train as planned'}.`;
  }, 900);
  const drawResult = () => {
    const r = readinessFor(data, date);
    const flags = redFlags().filter((f) => rec?.arm_flags?.includes(f.id));
    const todo = flags.length ? h('div', { class: 'notice notice-bad', style: { 'margin-top': '12px' } },
      h('p', null, h('strong', null, 'What to do')),
      h('ul', { style: { margin: '6px 0 0', 'padding-left': '18px' } }, flags.map((f) => h('li', null, `${f.label}: ${f.action || 'contact the fracture clinic or NHS 111.'}`))),
      h('p', { style: { 'margin-top': '6px' } }, 'In an emergency call 999.')) : null;
    const amberAt = Number.isFinite(r.rhrRef?.threshold) ? r.rhrRef.threshold : rhrAmberAt(r.rhrRef);
    stickyVerdict.dataset.level = r.level;
    stickyVerdict.replaceChildren(statusIcon(r.level, 18),
      h('span', { class: 'cs-word' }, r.level === 'unknown' ? 'Readiness: answer a question or two' : `Readiness: ${readinessWord(r.level)}`),
      h('span', { class: 'cs-why' }, r.level === 'red' ? 'Stop: no training today' : r.level === 'amber' ? 'Easy day' : r.level === 'green' ? 'Train as planned' : ''),
      h('span', { class: 'cs-go' }, 'See why'));
    resultBox.replaceChildren(
      readinessBadge(r, { large: true }),
      todo,
      r.rhrRef && amberAt ? h('p', { class: 'small muted', style: { 'margin-top': '10px' } }, `Resting HR reference: ${fmtNum(r.rhrRef.value, 1)} bpm (${r.rhrRef.source === 'average' ? `average of ${r.rhrRef.count} mornings` : 'your baseline'}). Amber at ${amberAt} bpm or more.`) : null,
      r.rhrBlocked ? h('p', { class: 'small muted', style: { 'margin-top': '10px' } }, `You changed how you measure resting HR on ${fmtDay(r.rhrBlocked.since)}. The resting-HR rule counts again after 5 mornings measured the new way (${r.rhrBlocked.count} so far, not counting this one).`) : null,
      nextStep(r));
    redInline.replaceChildren(r.level === 'red' ? h('div', { class: 'notice notice-bad', role: 'alert' },
      h('p', null, statusIcon('red', 18), ' ', h('strong', null, 'Red: no training today.')),
      h('p', { style: { 'margin-top': '4px' } }, RED_STOP),
      flags.length ? h('ul', { style: { margin: '6px 0 0', 'padding-left': '18px' } }, flags.map((f) => h('li', null, `${f.label}: ${f.action || 'contact the fracture clinic or NHS 111.'}`))) : null) : null);
    announce();
  };
  const nextStep = (r) => {
    if (date !== ctx.today || !rec) return null;
    const plan = content.program ? planOn(content.program, data, date) : null;
    const main = plan ? plan.sessions.filter((e) => e.source === 'template' && !e.isRest) : [];
    const first = main.find((e) => findWorkout(data, date, e.sessionId)?.status !== 'done');
    if (r.level === 'red') return h('div', { class: 'checkin-next' }, h('a', { class: 'btn', href: '#/arm' }, 'Clinic contacts and red flags'));
    if (!first) return h('div', { class: 'checkin-next' }, h('a', { class: 'btn btn-primary', href: '#/today' }, main.length ? 'Done for today: back to Today' : 'See today’s plan'));
    return h('div', { class: 'checkin-next' },
      h('a', { class: 'btn btn-primary btn-lg btn-block', href: `#/train/${date}/${encodeURIComponent(first.sessionId)}` }, `${r.level === 'amber' ? 'Start the easy version of ' : 'Start '}${first.session?.name || sessionName(first.sessionId)}`),
      h('a', { class: 'btn btn-ghost', href: '#/today' }, 'See today’s plan first'));
  };
  const slots = new Map();
  const drawIssues = () => {
    const list = rec ? checkinIssues(rec, data) : [];
    for (const [field, { slot, input }] of slots) {
      const issue = list.find((x) => x.field === field);
      if (!issue) { slot.replaceChildren(); slot.hidden = true; continue; }
      slot.hidden = false;
      slot.dataset.level = issue.level;
      slot.replaceChildren(h('span', null, issue.message),
        isNum(issue.suggestion) ? h('button', { type: 'button', class: 'btn btn-sm', onClick: () => {
          input.value = String(issue.suggestion);
          get()[field] = Number(issue.suggestion);
          store.touch();
          drawResult();
          drawIssues();
          input.focus();
        } }, `Use ${issue.suggestion}`) : null);
    }
  };
  const issueField = (field, el) => {
    const slot = h('p', { class: 'field-issue', hidden: true });
    el.append(slot);
    slots.set(field, { slot, input: el.querySelector('input') });
    return el;
  };
  const set = (field) => (v) => { get()[field] = v; store.touch(); drawResult(); if (slots.has(field)) drawIssues(); };

  const page = h('div', { class: 'page' });
  page.append(pageHead({
    title: 'Morning check-in',
    lede: 'One minute, before training. Measure resting heart rate before you get up. Everything is optional, but the arm questions matter most. On every scale, the good end is on the left.',
  }));
  const nav = h('div', { class: 'train-bar' },
    dateField({ label: 'Day', value: date, max: todayISO(), onChange: (v) => { if (isISODate(v)) ctx.navigate(`#/checkin/${v}`); } }),
    h('div', { class: 'row' },
      h('a', { class: 'btn btn-sm', href: `#/checkin/${addDays(date, -1)}` }, 'Previous day'),
      date < ctx.today ? h('a', { class: 'btn btn-sm', href: `#/checkin/${addDays(date, 1)}` }, 'Next day') : null,
      date !== ctx.today ? h('a', { class: 'btn btn-sm btn-ghost', href: '#/checkin' }, 'Today') : null),
    h('p', { class: 'small muted', style: { 'margin-left': 'auto' } }, rec ? 'Saved as you type.' : 'Nothing entered for this day yet.'));
  page.append(nav);
  page.append(stickyVerdict);

  const weight = latestValue(data, 'weight_kg', date);
  const prot = weight ? proteinTargets(weight.value, data.profile.protein_g_per_kg) : null;
  const flagsList = redFlags();
  const flagBoxes = h('div', { class: 'check-list' }, flagsList.map((f) => {
    const id = uid('flag');
    return h('div', { class: 'check' },
      h('input', { id, type: 'checkbox', checked: !!rec?.arm_flags?.includes(f.id), onChange: (e) => {
        const r = get();
        const set2 = new Set(r.arm_flags || []);
        if (e.target.checked) set2.add(f.id); else set2.delete(f.id);
        r.arm_flags = flagsList.map((x) => x.id).filter((x) => set2.has(x));
        store.touch();
        drawResult();
      } }),
      h('label', { for: id }, f.label));
  }));

  const lastWeight = latestValue(data, 'weight_kg', addDays(date, -1));
  const lastRhr = latestValue(data, 'rhr', addDays(date, -1));
  const yDate = addDays(date, -1);
  const yRec = checkinOn(data, yDate);
  const missingY = date === ctx.today && yRec && ['protein_g', 'calories', 'steps'].some((k) => !isNum(yRec[k]));
  let yInputs = null;
  const yesterday = missingY ? (() => {
    const pIn = numberField({ label: 'Protein', unit: 'g', value: yRec.protein_g, min: 0, max: 500, step: 1, onInput: (v) => { yRec.protein_g = v; store.touch(); } });
    const kIn = numberField({ label: 'Calories', unit: 'kcal', value: yRec.calories, min: 0, max: 8000, step: 10, onInput: (v) => { yRec.calories = v; store.touch(); } });
    yInputs = { p: pIn.querySelector('input'), k: kIn.querySelector('input') };
    const sync = () => { yInputs.p.value = isNum(yRec.protein_g) ? String(yRec.protein_g) : ''; yInputs.k.value = isNum(yRec.calories) ? String(yRec.calories) : ''; };
    return section({ title: 'Finish yesterday', level: 2, cls: 'checkin-yesterday', sub: `Totals for ${fmtDay(yDate)}, while you remember them. They count towards yesterday, not today.` },
      foodControls(ctx, () => yRec, () => yRec, { onTotals: sync, slot: `checkin-food:${yDate}` }),
      h('div', { class: 'form-grid' },
        pIn, kIn,
        numberField({ label: 'Steps', value: yRec.steps, min: 0, max: 80000, step: 1, onInput: (v) => { yRec.steps = v; store.touch(); } }),
        numberField({ label: 'Water', unit: 'L', value: yRec.water_l, min: 0, max: 10, step: 0.1, onInput: (v) => { yRec.water_l = v; store.touch(); } })));
  })() : null;

  const proteinField = issueField('protein_g', numberField({ label: 'Protein today', unit: 'g', value: rec?.protein_g, min: 0, max: 500, step: 1, onInput: set('protein_g') }));
  const kcalField = issueField('calories', numberField({ label: 'Calories today', unit: 'kcal', value: rec?.calories, min: 0, max: 8000, step: 10, onInput: set('calories') }));
  const syncFood = () => {
    const p = proteinField.querySelector('input');
    const k = kcalField.querySelector('input');
    if (p) p.value = isNum(rec?.protein_g) ? String(rec.protein_g) : '';
    if (k) k.value = isNum(rec?.calories) ? String(rec.calories) : '';
    drawIssues();
  };

  const form = h('div', { class: 'stack-lg' },
    yesterday,
    section({ title: 'Your arm', level: 2, sub: 'Tick anything that applies today. Any tick, or pain of 7 out of 10 or more, turns readiness red.' },
      h('div', { class: 'stack' },
        h('div', { style: { 'max-width': '560px' } }, scaleField({ label: 'Arm pain right now (0 to 10)', value: rec?.arm_pain, min: 0, max: 10, lowLabel: 'No pain', highLabel: 'Worst imaginable', goodEnd: 'low', onChange: set('arm_pain'), readBack: (v) => painReadBack(v, { kind: 'arm', red: RED_PAIN_AT, amber: AMBER_PAIN_AT }), confirm: confirmArmPain })),
        h('fieldset', { class: 'field', style: { border: 0, padding: 0 } }, h('legend', { class: 'field-label', style: { 'margin-bottom': '8px' } }, 'Red flags'), flagBoxes),
        redInline)),
    section({ title: 'Body', level: 2 }, h('div', { class: 'form-grid' },
      issueField('weight_kg', numberField({ label: 'Weight', unit: 'kg', value: rec?.weight_kg, min: 30, max: 250, step: 0.1, hint: lastWeight ? `Last ${fmtFixed(lastWeight.value, 1)} kg, ${fmtDay(lastWeight.date)}. Same scale, after the toilet, before food.` : 'Same scale, after the toilet, before food', onInput: set('weight_kg') })),
      issueField('rhr', numberField({ label: 'Resting heart rate', unit: 'bpm', value: rec?.rhr, min: 30, max: 120, step: 1, hint: lastRhr ? `Last ${fmtNum(lastRhr.value)} bpm. Lying down, before you get up.` : 'Lying down, before you get up', onInput: set('rhr') })),
      issueField('hrv', numberField({ label: 'HRV', unit: 'ms', value: rec?.hrv, min: 5, max: 250, step: 1, hint: 'If your watch measures it', onInput: set('hrv') })),
      issueField('steps', numberField({ label: 'Steps today', value: rec?.steps, min: 0, max: 80000, step: 1, onInput: set('steps') })))),
    section({ title: 'Sleep', level: 2 }, h('div', { class: 'form-grid' },
      issueField('sleep_h', numberField({ label: 'Hours asleep', unit: 'h', value: rec?.sleep_h, min: 0, max: 16, step: 0.25, onInput: set('sleep_h') })),
      h('div', { class: 'span-2' }, scaleField({ label: 'Sleep quality (1 to 5)', value: rec?.sleep_q, min: 1, max: 5, lowLabel: 'Awful', highLabel: 'Great', goodEnd: 'high', onChange: set('sleep_q') })))),
    section({ title: 'How you feel', level: 2 }, h('div', { class: 'form-grid' },
      h('div', { class: 'span-2' }, scaleField({ label: 'Energy (1 to 5)', value: rec?.energy, min: 1, max: 5, lowLabel: 'Drained', highLabel: 'Full of beans', goodEnd: 'high', onChange: set('energy') })),
      h('div', { class: 'span-2' }, scaleField({ label: 'Muscle soreness (0 to 10)', value: rec?.soreness, min: 0, max: 10, lowLabel: 'None', highLabel: 'Very sore', goodEnd: 'low', onChange: set('soreness'), readBack: (v) => painReadBack(v, { kind: 'soreness', red: SORENESS_AT }) })),
      h('div', { class: 'span-2' }, scaleField({ label: 'Mood (1 to 5)', value: rec?.mood, min: 1, max: 5, lowLabel: 'Low', highLabel: 'Great', goodEnd: 'high', onChange: set('mood') })),
      h('div', { class: 'span-2' }, scaleField({ label: 'Stress (1 to 5)', value: rec?.stress, min: 1, max: 5, lowLabel: 'Calm', highLabel: 'Very stressed', goodEnd: 'low', onChange: set('stress') })))),
    section({ title: 'Food and drink', level: 2, sub: `${prot ? `Protein target ${fmtNum(prot.target)} g (range ${fmtNum(prot.low)} to ${fmtNum(prot.high)} g) from your latest weight of ${fmtFixed(weight.value, 1)} kg. ` : 'Log a weight to get a protein target. '}Fill these in tonight, or tomorrow morning using Previous day.` },
      foodControls(ctx, get, () => rec, { onTotals: syncFood, slot: `checkin-food:${date}` }),
      h('div', { class: 'form-grid', style: { 'margin-top': '12px' } },
        proteinField, kcalField,
        issueField('water_l', numberField({ label: 'Water', unit: 'L', value: rec?.water_l, min: 0, max: 10, step: 0.1, onInput: set('water_l') })),
        h('div', { class: 'checkin-creatine' }, checkField({ label: 'Took creatine', cls: 'check-lg check-target', checked: !!rec?.creatine, onChange: set('creatine') })))),
    section({ title: 'Notes', level: 2 }, textareaField({ label: 'Anything else', value: rec?.notes, rows: 3, placeholder: 'Niggles, mood, what you ate, how the arm feels…', onInput: set('notes') })));

  page.append(h('div', { class: 'checkin-layout' },
    form,
    sheet({ class: 'checkin-result', id: 'checkin-result', tabindex: '-1', role: 'region', 'aria-label': 'Readiness result' }, h('h2', { class: 'mini-title' }, `Readiness for ${fmtDay(date)}`), resultBox, announcer)));
  drawResult();
  drawIssues();

  // history (the same single readiness source as everything else)
  const recent = data.checkins.filter((c) => isISODate(c.date) && c.date <= ctx.today).sort((a, b) => (a.date < b.date ? 1 : -1)).slice(0, 21);
  const cell = (v, dp = 0) => h('td', { class: 'num' }, isNum(v) ? fmtNum(v, dp) : '–');
  page.append(section({ title: 'Recent check-ins', sub: 'Pick a date to open it.' },
    recent.length ? h('div', { class: 'table-wrap' }, h('table', { class: 'table table-compact' },
      h('thead', null, h('tr', null, ['Date', 'Readiness', 'Weight (kg)', 'RHR (bpm)', 'HRV (ms)', 'Sleep (h)', 'Energy (1–5)', 'Soreness (0–10)', 'Arm pain (0–10)', 'Flags', 'Steps', 'Protein (g)'].map((t, i) => h('th', { scope: 'col', class: i > 1 ? 'num' : null }, t)))),
      h('tbody', null, recent.map((c) => {
        const r = readinessFor(data, c.date);
        return h('tr', { class: c.date === date ? 'is-highlight' : null },
          h('th', { scope: 'row' }, h('a', { href: `#/checkin/${c.date}` }, fmtDay(c.date))),
          h('td', null, h('span', { class: 'row', style: { gap: '6px', 'flex-wrap': 'nowrap' } }, statusIcon(r.level, 16), { green: 'Green', amber: 'Amber', red: 'Red', unknown: '–' }[r.level])),
          h('td', { class: 'num' }, isNum(c.weight_kg) ? fmtFixed(c.weight_kg, 1) : '–'), cell(c.rhr), cell(c.hrv), cell(c.sleep_h, 2), cell(c.energy), cell(c.soreness), cell(c.arm_pain),
          h('td', { class: 'num' }, c.arm_flags?.length ? String(c.arm_flags.length) : '–'), cell(c.steps), cell(c.protein_g));
      })))) : h('p', { class: 'muted' }, 'No check-ins yet. Your first one starts the trends.')));
  return page;
}
