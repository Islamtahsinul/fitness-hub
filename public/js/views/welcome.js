// #/welcome[/step]: the first-run flow. Welcome, profile check, start date, clearance status and
// a safety acknowledgement. Skippable at every step; shown once (data.ui.onboarding).

import { h, toast } from '../dom.js';
import { fmtDay, fmtDayLong, isISODate, mondayOf, mondayOnOrAfter, addDays, weekdayIndex } from '../dates.js';
import { ageFrom, hrMax, zoneRange, bmrMifflin, tdee, targetKcal, proteinTargets, isNum } from '../calc.js';
import { latestValue } from '../stats.js';
import { gateList, highestGate, gateRank, buildTimeline, GATE_ORDER } from '../schedule.js';
import { numberField, selectField, dateField, statusIcon } from '../components.js';
import { content } from '../content.js';
import { WELCOME_STEPS, stepFromParam, markOnboarding } from '../features/onboarding.js';
import { confirmClearance, recordClearance, injuryDateOf, beforeInjuryError } from '../features/clearance.js';
import { formatUKDate } from '../features/ukdate.js';
import { icon } from '../features/icons.js';
import * as store from '../store.js';

export const title = 'Welcome';

const nf = new Intl.NumberFormat('en-GB', { maximumFractionDigits: 0 });
const PROFILE_FIELDS = ['sex', 'birth_year', 'height_cm', 'injured_arm', 'dominant_hand'];

function stepper(i) {
  return h('ol', { class: 'welcome-steps', 'aria-hidden': 'true' },
    WELCOME_STEPS.map((_, k) => h('li', { class: [k < i && 'is-done', k === i && 'is-current'] })));
}

function shell(ctx, i, { title: t, lede, body, next = 'Next', canNext = () => true, onNext = null, nextRef = null, nextHint = null }) {
  const go = (n) => ctx.navigate(`#/welcome/${n + 1}`);
  const skip = () => {
    markOnboarding(ctx.data, { skipped: true });
    store.touch();
    toast('Setup skipped. You can run it again from Settings.');
    ctx.navigate('#/today');
  };
  const hintId = `welcome-next-hint-${i}`;
  const nextBtn = h('button', { type: 'button', class: 'btn btn-primary btn-lg', disabled: !canNext(), 'aria-describedby': nextHint ? hintId : null, onClick: async () => {
    if (!canNext()) return;
    if (onNext && (await onNext()) === false) return;
    if (i < WELCOME_STEPS.length - 1) go(i + 1);
  } }, next);
  if (nextRef) nextRef.btn = nextBtn;
  return h('div', { class: 'page welcome' },
    stepper(i),
    h('p', { class: 'welcome-kicker' }, `Step ${i + 1} of ${WELCOME_STEPS.length}`),
    h('h1', { class: 'welcome-title', tabindex: '-1', id: 'page-title' }, t),
    lede ? h('p', { class: 'welcome-lede' }, lede) : null,
    h('div', { class: 'welcome-body' }, body),
    h('div', { class: 'welcome-actions' },
      i > 0 ? h('button', { type: 'button', class: 'btn btn-lg', onClick: () => go(i - 1) }, 'Back') : null,
      nextBtn,
      h('button', { type: 'button', class: 'btn btn-ghost welcome-skip', onClick: skip }, 'Skip setup')),
    nextHint ? h('p', { class: 'small muted welcome-next-hint', id: hintId, 'aria-live': 'polite' }, nextHint) : null);
}

function stepWelcome(ctx, i) {
  const name = typeof ctx.data.profile.name === 'string' ? ctx.data.profile.name.trim() : '';
  const point = (ico, strong, text) => h('li', null, h('span', { class: 'wp-n' }, icon(ico, 18)), h('div', null, h('strong', null, strong), h('p', null, text)));
  return shell(ctx, i, {
    title: name ? `Welcome, ${name}.` : 'Welcome.',
    lede: 'Your training base for the way back: today’s plan, a session logger, your arm’s recovery and the full guide, all on your own hub. You know how to train; here the arm sets the pace. Five quick checks and you’re set up.',
    next: 'Start',
    body: h('ul', { class: 'welcome-points' },
      point('pulse', 'Check in each morning.', 'Sleep, resting heart rate, how you feel and your arm. The hub turns it into green, amber or red, and adjusts the day.'),
      point('dumbbell', 'Train from today’s plan.', 'Double progression from your logged sets, halved sets on easy days, safe swaps when kit is busy.'),
      point('signpost', 'Your clinic sets the pace.', 'Each clearance you record unlocks the next exercises and phases, never before.')),
  });
}

function targetsLine(ctx) {
  const pr = ctx.data.profile;
  const age = ageFrom(pr.birth_year, ctx.today);
  const hm = hrMax(age, pr.hrmax_override);
  const z2 = zoneRange('Z2', hm);
  const w = latestValue(ctx.data, 'weight_kg', ctx.today);
  const kcal = w ? targetKcal(tdee(bmrMifflin({ sex: pr.sex, weightKg: w.value, heightCm: pr.height_cm, age }), pr.activity_factor), pr.surplus_kcal) : null;
  const prot = w ? proteinTargets(w.value, pr.protein_g_per_kg) : null;
  const items = [];
  if (isNum(kcal)) items.push(['Calories', `about ${nf.format(Math.round(kcal / 50) * 50)} kcal a day`]);
  if (prot) items.push(['Protein', `about ${nf.format(Math.round(prot.target / 5) * 5)} g a day`]);
  if (hm) items.push(['Heart rate max', `${hm} bpm`]);
  if (z2) items.push(['Zone 2', `${z2.lo}–${z2.hi} bpm`]);
  return h('div', { class: 'sheet sheet-tight welcome-targets', 'aria-live': 'polite' },
    h('h2', { class: 'mini-title' }, 'What these give you'),
    items.length ? h('ul', { class: 'kv-list' }, items.map(([k, v]) => h('li', null, h('span', null, k), h('span', { class: 'kv-v' }, v))))
      : h('p', { class: 'small muted' }, 'Your calorie, protein and heart-rate targets appear here as you fill in the fields.'));
}

const profileFilled = (pr) => PROFILE_FIELDS.every((k) => (k === 'birth_year' || k === 'height_cm' ? isNum(pr[k]) : typeof pr[k] === 'string' && pr[k]));

/** Today's weigh-in for the welcome (a weight-only check-in, which never counts as a readiness check-in). */
function setWeight(ctx, v) {
  const list = ctx.data.checkins;
  let rec = list.find((c) => c.date === ctx.today);
  if (!rec) {
    if (!isNum(v)) return;
    rec = { date: ctx.today, weight_kg: null, rhr: null, hrv: null, sleep_h: null, sleep_q: null, energy: null, soreness: null, mood: null, stress: null, arm_pain: null, arm_flags: [], steps: null, protein_g: null, calories: null, water_l: null, creatine: false, notes: '' };
    list.push(rec);
    list.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  }
  rec.weight_kg = v;
}

function stepProfile(ctx, i) {
  const pr = ctx.data.profile;
  const host = h('div');
  const nextRef = {};
  const weightNow = latestValue(ctx.data, 'weight_kg', ctx.today);
  const blank = PROFILE_FIELDS.every((k) => pr[k] === null || pr[k] === undefined || pr[k] === '');
  const hint = h('span');
  const ready = () => profileFilled(pr) && !!latestValue(ctx.data, 'weight_kg', ctx.today);
  const refresh = () => {
    host.replaceChildren(targetsLine(ctx));
    if (nextRef.btn) nextRef.btn.disabled = !ready();
    const missing = [];
    if (!pr.sex) missing.push('sex');
    if (!isNum(pr.birth_year)) missing.push('birth year');
    if (!isNum(pr.height_cm)) missing.push('height');
    if (!latestValue(ctx.data, 'weight_kg', ctx.today)) missing.push('weight');
    if (!pr.injured_arm) missing.push('injured arm');
    if (!pr.dominant_hand) missing.push('dominant hand');
    hint.textContent = missing.length ? `Still to fill in: ${missing.join(', ')}.` : 'All filled in.';
  };
  const set = (k, v) => { pr[k] = v; store.touch(); refresh(); };
  const opts2 = (a, b) => [{ value: '', label: 'Choose…' }, { value: a.toLowerCase(), label: a }, { value: b.toLowerCase(), label: b }];
  const page = shell(ctx, i, {
    title: blank ? 'Tell the hub about you' : 'Is this you?',
    lede: blank
      ? 'Fill these in. They drive your calorie, protein and heart-rate numbers, and they stay on your own hub.'
      : 'These drive your calorie, protein and heart-rate numbers. Check them and change anything that’s wrong.',
    next: 'Looks right', canNext: ready, nextRef, nextHint: hint,
    body: h('div', null,
      h('div', { class: 'sheet' }, h('div', { class: 'form-grid' },
        selectField({ label: 'Sex (for the calorie formula)', value: pr.sex || '', autocomplete: 'sex', options: opts2('Male', 'Female'), onChange: (v) => set('sex', v || null) }),
        numberField({ label: 'Birth year', value: pr.birth_year, min: 1920, max: 2012, step: 1, autocomplete: 'bday-year', onInput: (v) => set('birth_year', v) }),
        numberField({ label: 'Height', unit: 'cm', value: pr.height_cm, min: 120, max: 230, step: 0.5, onInput: (v) => set('height_cm', v) }),
        numberField({ label: 'Weight this morning', unit: 'kg', value: weightNow?.value ?? null, min: 30, max: 250, step: 0.1, hint: weightNow && weightNow.date !== ctx.today ? `Last weigh-in ${fmtDay(weightNow.date)}` : 'After the toilet, before food', onInput: (v) => { setWeight(ctx, v); store.touch(); refresh(); } }),
        selectField({ label: 'Injured arm', value: pr.injured_arm || '', options: opts2('Left', 'Right'), onChange: (v) => set('injured_arm', v || null) }),
        selectField({ label: 'Dominant hand', value: pr.dominant_hand || '', options: opts2('Left', 'Right'), onChange: (v) => set('dominant_hand', v || null) }),
        dateField({ label: 'Date of the injury (optional)', value: pr.injury_date || '', max: ctx.today, hint: 'No clearance can be dated before it.', onChange: (v) => set('injury_date', isISODate(v) ? v : null) }))),
      host),
  });
  refresh();
  return page;
}

function stepStart(ctx, i) {
  const pr = ctx.data.profile;
  const today = ctx.today;
  const nextMon = mondayOnOrAfter(addDays(today, 1));
  const thisMon = mondayOf(today);
  const read = h('p', { class: 'welcome-lede', 'aria-live': 'polite' });
  const field = h('div', { style: { 'max-width': '300px' } });
  const describe = () => {
    const start = isISODate(pr.program_start) ? mondayOf(pr.program_start) : null;
    if (!start) { read.textContent = ''; return; }
    const tl = content.program ? buildTimeline(content.program, pr) : null;
    const first = tl?.phases?.[0];
    read.replaceChildren(h('strong', null, `Your programme starts ${fmtDayLong(start, { year: true })}`),
      first ? `, with ${first.name}${first.weeks ? ` (${first.weeks} week${first.weeks === 1 ? '' : 's'})` : ''}.` : '.',
      start < today ? ' That’s in the past, so you’ll join part-way through.' : '');
  };
  const setStart = (iso) => {
    if (!isISODate(iso)) return;
    const mon = mondayOf(iso);
    pr.program_start = mon;
    store.touch();
    if (mon !== iso) toast(`The programme starts on a Monday: moved to ${fmtDay(mon)}.`);
    drawField();
    describe();
  };
  const drawField = () => field.replaceChildren(dateField({ label: 'Start date', value: pr.program_start, hint: `Always a Monday. Type it day first, for example ${formatUKDate(nextMon)}.`, onChange: setStart }));
  drawField();
  describe();
  const quick = weekdayIndex(today) === 0
    ? [[today, `Today, ${fmtDay(today)}`], [nextMon, `Next Monday, ${fmtDay(nextMon)}`]]
    : [[nextMon, `Next Monday, ${fmtDay(nextMon)}`], [thisMon, `This Monday, ${fmtDay(thisMon)} (join part-way)`]];
  return shell(ctx, i, {
    title: 'When do you start?',
    lede: 'Week one is your Re-entry Week: set up each machine one-handed and find your working loads. Starting on a Monday keeps the weeks lined up.',
    body: h('div', null,
      h('div', { class: 'row', style: { 'margin-bottom': '16px' } }, quick.map(([d, l]) => h('button', { type: 'button', class: 'btn', 'aria-pressed': String(mondayOf(pr.program_start || '') === d), onClick: () => setStart(d) }, l))),
      field,
      read),
  });
}

function stepClearance(ctx, i) {
  const pr = ctx.data.profile;
  const cl = pr.clearances;
  const today = ctx.today;
  const gates = gateList(content.program);
  const current = highestGate(cl, today);
  let choice = current;
  let date = isISODate(cl[current]) ? cl[current] : today;
  const dateHost = h('div');
  const note = h('p', { class: 'small muted', 'aria-live': 'polite' });
  const nextRef = {};
  const valid = () => choice === 'none' || isISODate(date);
  const drawDate = () => {
    note.textContent = '';
    if (choice === 'none') {
      dateHost.replaceChildren();
      if (current !== 'none') note.textContent = `“${gates.find((g) => g.id === current)?.label}” is already recorded. To remove a clearance, use the Your arm page.`;
    } else {
      dateHost.replaceChildren(h('div', { style: { 'max-width': '300px', 'margin-top': '14px' } },
        dateField({ label: 'Cleared on', value: date, min: injuryDateOf(pr), max: today, required: true, minError: beforeInjuryError(injuryDateOf(pr)), hint: 'The day your clinic or physio told you.', onChange: (v) => { date = v; if (nextRef.btn) nextRef.btn.disabled = !valid(); } })));
      if (gateRank(choice) > gateRank(current)) note.textContent = 'You’ll be asked to confirm before this is recorded: it unlocks exercises and phases.';
    }
    if (nextRef.btn) nextRef.btn.disabled = !valid();
  };
  const name = `gate-${Math.random().toString(36).slice(2, 7)}`;
  const options = h('div', { class: 'gate-choice', role: 'radiogroup', 'aria-label': 'What your clinic has cleared' },
    GATE_ORDER.map((g) => {
      const def = gates.find((x) => x.id === g);
      const id = `${name}-${g}`;
      return h('label', { class: 'gate-option', for: id },
        h('input', { type: 'radio', id, name, value: g, checked: g === choice, onChange: () => { choice = g; if (isISODate(cl[g])) date = cl[g]; drawDate(); } }),
        h('span', null,
          h('span', { class: 'gate-option-name' }, g === 'none' ? 'Nothing yet' : def?.label || g),
          h('span', { class: 'gate-option-desc', style: { display: 'block' } }, g === 'none' ? 'Not cleared for anything with the injured arm. The programme starts with work that never uses it.' : def?.description || '')));
    }));
  // next appointment: edits change one appointment, never add a new one each time (PE12)
  const appts = ctx.data.arm.appointments;
  let target = appts.filter((a) => isISODate(a.date) && a.date >= today).sort((a, b) => (a.date < b.date ? -1 : 1))[0] || null;
  const apptField = dateField({ label: 'Next fracture clinic appointment', value: target?.date || '', min: today, hint: 'Day first. Leave it blank if you don’t have one booked.', onChange: (v) => {
    if (!isISODate(v)) return;
    if (!target || !appts.includes(target)) {
      target = { date: v, type: 'Fracture clinic', notes: '', outcome: '' };
      appts.push(target);
    } else target.date = v;
    store.touch();
  } });
  const onNext = async () => {
    if (choice !== 'none' && isISODate(date) && gateRank(choice) > 0 && cl[choice] !== date) {
      // PE12: never one tap. The same confirmation as the Your arm page.
      if (!(await confirmClearance(ctx, choice, date))) return false;
      recordClearance(ctx, choice, date);
    }
    return true;
  };
  const body = h('div', null,
    h('div', { class: 'sheet' }, options, dateHost, note),
    h('div', { style: { 'max-width': '300px', 'margin-top': '20px' } }, apptField));
  const page = shell(ctx, i, {
    title: 'What has your clinic cleared?',
    lede: 'Only record what your fracture clinic or physio has told you, in person or in writing. Each clearance unlocks more of the programme, and you can add new ones on the Your arm page.',
    body, canNext: valid, onNext, nextRef,
  });
  drawDate();
  return page;
}

function stepSafety(ctx, i) {
  const ackId = `ack-${Math.random().toString(36).slice(2, 7)}`;
  let ok = false;
  const nextRef = {};
  const rule = (lvl, strong, text) => h('li', null, statusIcon(lvl, 20), h('p', null, h('strong', null, strong), ' ', text));
  const finish = () => {
    if (!ok) return false;
    markOnboarding(ctx.data, { safetyAck: true });
    store.touch();
    toast('You’re set. Check in each morning to see the day’s plan.');
    ctx.navigate('#/today');
    return false;
  };
  const page = shell(ctx, i, {
    title: 'Six rules that keep you safe',
    lede: 'Until your clinic clears each step, these come before any session in this hub.',
    next: 'Finish and go to Today', canNext: () => ok, onNext: finish, nextRef,
    body: h('div', null,
      h('ul', { class: 'safety-list' },
        rule('red', 'Nothing goes through the injured arm until it’s cleared.', 'No gripping, holding, pushing, pulling, bracing or leaning on it, and no kit that needs two hands. Get in and out of machines, and up from the floor, without it.'),
        rule('amber', 'Falls are the biggest risk while the bone heals.', 'No jumping, sprints, wobble boards, rough or slippery ground, or cycling outdoors. Do balance work next to something your good hand can hold.'),
        rule('amber', 'Breathe out on the effort.', 'Brace moderately; never hold your breath and strain.'),
        rule('green', 'Your physio overrides this programme.', 'Rehab for the injured arm is only ever “as prescribed by your physio”.'),
        rule('red', 'Red flags mean stop and get advice.', 'Worsening pain, arm pain of 7 out of 10 or more, new swelling, redness or heat, wound discharge, fever, numbness or tingling, a pale or cold hand, a new bend or give, or a fall on the arm: contact the fracture clinic or NHS 111. In an emergency call 999.'),
        rule('green', 'No dieting while the bone heals.', 'A small surplus builds bone and muscle. If your weight drifts down, eat more.')),
      h('div', { class: 'safety-ack check check-lg' },
        h('input', { type: 'checkbox', id: ackId, onChange: (e) => { ok = e.target.checked; if (nextRef.btn) nextRef.btn.disabled = !ok; } }),
        h('label', { for: ackId }, 'I’ve read these and I’ll follow them. My fracture clinic and physio decide what my arm can do.')),
      h('p', { class: 'small muted', style: { 'margin-top': '12px' } }, 'This hub is a training diary and coaching guide. It is not medical advice and doesn’t diagnose anything.')),
  });
  return page;
}

export function render(ctx) {
  const i = stepFromParam(ctx.params[0]);
  const step = WELCOME_STEPS[i];
  if (step === 'profile') return stepProfile(ctx, i);
  if (step === 'start') return stepStart(ctx, i);
  if (step === 'clearance') return stepClearance(ctx, i);
  if (step === 'safety') return stepSafety(ctx, i);
  return stepWelcome(ctx, i);
}
