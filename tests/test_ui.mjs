// UI logic tests for the Fitness Hub front end (pure modules under public/js/features/).
// Run: node tests/test_ui.mjs   (or: node --test tests/test_ui.mjs)
import test from 'node:test';
import assert from 'node:assert/strict';

import { parseUKDate, formatUKDate, checkUKDate, isCompleteDateText, monthGrid } from '../public/js/features/ukdate.js';
import {
  coachInsights, proteinStreak, zone2Status, weightTrend, rhrTrend, sleepShort, armPainTrend, testsDue, clinicInsight, recentClearance,
} from '../public/js/features/insights.js';
import { platesFor, plateStack, stackText, isPlateLoaded, cleanPlates, DEFAULT_PLATES } from '../public/js/features/plates.js';
import { swapOptions, hasSwaps, applySwap } from '../public/js/features/swap.js';
import { needsOnboarding, markOnboarding, onboardingState, stepFromParam, WELCOME_STEPS } from '../public/js/features/onboarding.js';
import { readMinutes } from '../public/js/features/guidemeta.js';
import { addDays } from '../public/js/dates.js';

const TODAY = '2025-11-22'; // a Saturday

// ---------------------------------------------------------------- helpers

function baseData(extra = {}) {
  return {
    schema_version: 1,
    profile: {
      name: 'Sam', sex: 'male', birth_year: 1995, height_cm: 180, program_start: '2025-11-03', activity_factor: 1.55,
      surplus_kcal: 300, protein_g_per_kg: 1.8, hrmax_override: null, rhr_baseline: null,
      clearances: { good_arm_ok: null, clinic_light: null, grip_cleared: null, full_clearance: null },
    },
    checkins: [], workouts: [], hikes: [], tests: [], measurements: [],
    arm: { appointments: [], logs: [], physio_exercises: [], questions: {} },
    weekly_reviews: [],
    ...extra,
  };
}

/** One check-in per day from `from` for `n` days; fn(i, date) returns the fields. */
function days(from, n, fn) {
  return Array.from({ length: n }, (_, i) => ({ date: addDays(from, i), arm_flags: [], ...fn(i, addDays(from, i)) }));
}

const PROGRAM = {
  version: 1,
  phases: [
    { id: 'p1', name: 'Phase 1 — Foundation', short: 'Foundation', entry_gate: 'none', weeks: 8, repeat_from_week: 3,
      week_template: { mon: 'str', tue: 'z2', wed: 'str', thu: 'z2', fri: 'str', sat: 'walk', sun: 'rest' },
      weekly_targets: { zone2_min: 120, strength_sessions: 3 } },
    { id: 'p2', name: 'Phase 2 — Light', short: 'Light', entry_gate: 'clinic_light', weeks: 6, week_template: { mon: 'str' } },
  ],
  addons: [{ id: 'rehab', name: 'Arm rehab', gate: 'clinic_light', until_gate: 'full_clearance', days: ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'], session: 'rehab' }],
  sessions: {
    str: { name: 'Strength', type: 'strength', blocks: [{ exercise: 'leg-press', sets: 3, reps: '8-12' }] },
    z2: { name: 'Zone 2', type: 'cardio', blocks: [{ exercise: 'bike-upright', minutes: 20, zone: 'Z2' }] },
    walk: { name: 'Walk', type: 'hike', blocks: [{ exercise: 'walk-outdoor', minutes: 10, zone: 'Z2' }] },
    rehab: { name: 'Rehab', type: 'rehab', blocks: [] },
    rest: { name: 'Rest', type: 'rest', blocks: [] },
  },
  gates: [], rules: {},
};

const EXERCISES = [
  { id: 'leg-press', name: 'Leg press', category: 'squat', gate: 'none', regressions: ['box-squat-bw'], progressions: ['leg-press-single'], equipment: ['leg press machine'] },
  { id: 'leg-press-single', name: 'Single-leg leg press', category: 'single-leg', gate: 'none', regressions: ['leg-press'], progressions: [], equipment: ['leg press machine'] },
  { id: 'box-squat-bw', name: 'Box squat', category: 'squat', gate: 'none', regressions: [], progressions: ['goblet-squat'], equipment: ['box'] },
  { id: 'tempo-squat-bw', name: 'Tempo squat', category: 'squat', gate: 'none', regressions: [], progressions: [], equipment: [] },
  { id: 'wall-sit', name: 'Wall sit', category: 'squat', gate: 'none', regressions: [], progressions: [], equipment: [] },
  { id: 'goblet-squat', name: 'Goblet squat', category: 'squat', gate: 'grip_cleared', regressions: ['box-squat-bw'], progressions: [], equipment: ['dumbbell'] },
  { id: 'rehab-putty-grip', name: 'Putty grip', category: 'rehab', gate: 'clinic_light', regressions: [], progressions: [], equipment: [] },
  { id: 'rehab-wrist-flex-ext', name: 'Wrist flexion and extension', category: 'rehab', gate: 'clinic_light', regressions: [], progressions: [], equipment: [] },
  { id: 'ruck-light', name: 'Light ruck', category: 'conditioning', gate: 'clinic_light', regressions: [], progressions: [], equipment: [] },
];
const exById = new Map(EXERCISES.map((e) => [e.id, e]));

const done = (date, session_id, cardio = []) => ({ id: `w-${date}-${session_id}`, date, session_id, session_type: 'cardio', status: 'done', exercises: [], cardio });

// ---------------------------------------------------------------- UK dates

test('parseUKDate reads day-first dates in all the usual shapes', () => {
  const t = { today: TODAY };
  assert.equal(parseUKDate('22/11/2025', t), '2025-11-22');
  assert.equal(parseUKDate('2/12/2025', t), '2025-12-02');
  assert.equal(parseUKDate('02-12-25', t), '2025-12-02');
  assert.equal(parseUKDate('2.12.2025', t), '2025-12-02');
  assert.equal(parseUKDate('02 12 2025', t), '2025-12-02');
  assert.equal(parseUKDate('02122025', t), '2025-12-02');
  assert.equal(parseUKDate('2 Dec 2025', t), '2025-12-02');
  assert.equal(parseUKDate('Tue 2 December 2025', t), '2025-12-02');
  assert.equal(parseUKDate('2nd dec', t), '2025-12-02');
  assert.equal(parseUKDate('2025-12-02', t), '2025-12-02');
  assert.equal(parseUKDate('today', t), TODAY);
  assert.equal(parseUKDate('yesterday', t), '2025-11-21');
  assert.equal(parseUKDate('tomorrow', t), '2025-11-23');
  assert.equal(parseUKDate('5/3', t), '2025-03-05', 'no year means this year, day first');
});

test('parseUKDate rejects impossible dates and nonsense', () => {
  const t = { today: TODAY };
  for (const bad of ['31/02/2026', '29/02/2027', '00/01/2026', '12/13/2026', '', '  ', 'soon', '1/2/3/4', null, undefined, 42]) {
    assert.equal(parseUKDate(bad, t), null, String(bad));
  }
  assert.equal(parseUKDate('29/02/2028', t), '2028-02-29', 'leap day');
});

test('formatUKDate is dd/mm/yyyy', () => {
  assert.equal(formatUKDate('2025-12-02'), '02/12/2025');
  assert.equal(formatUKDate('nope'), '');
});

test('checkUKDate explains problems in plain English, including US-style entry', () => {
  assert.match(checkUKDate('11/22/2025', { today: TODAY }).error, /Day first.*22\/11\/2025/);
  assert.match(checkUKDate('31/04/2025', { today: TODAY }).error, /doesn’t exist/);
  assert.equal(checkUKDate('23/11/2025', { today: TODAY, max: TODAY }).error, 'That date is in the future.');
  assert.match(checkUKDate('02/01/2025', { today: TODAY, min: '2025-11-02' }).error, /2 Nov 2025 or later/);
  assert.deepEqual(checkUKDate('22/11/2025', { today: TODAY, max: TODAY }), { iso: '2025-11-22', error: '' });
  assert.equal(checkUKDate('', { required: true }).error.length > 0, true);
  assert.equal(checkUKDate('', { required: false }).error, '');
  assert.equal(checkUKDate('22/11/2', { today: TODAY, partial: true }).error, '', 'no nagging while typing');
  assert.notEqual(checkUKDate('22/11/2', { today: TODAY }).error, '', 'but it is an error once committed');
});

test('isCompleteDateText waits for a four-digit year before acting while typing', () => {
  assert.equal(isCompleteDateText('22/11/20'), false);
  assert.equal(isCompleteDateText('22/11/2025'), true);
  assert.equal(isCompleteDateText('2025-11-22'), true);
  assert.equal(isCompleteDateText('today'), false);
});

test('monthGrid is six Monday-first weeks', () => {
  const g = monthGrid(2026, 11); // 1 Nov 2026 is a Sunday
  assert.equal(g.length, 42);
  assert.equal(g[0].iso, '2026-10-26');
  assert.equal(g[6].iso, '2026-11-01');
  assert.equal(g[6].inMonth, true);
  assert.equal(g[0].inMonth, false);
});

// ---------------------------------------------------------------- insights: protein

test('protein: under target three days running fires; today is ignored because it is not finished', () => {
  const d = baseData({ checkins: days('2025-11-18', 5, (i) => ({ weight_kg: 80, protein_g: [150, 100, 110, 120, 20][i] })) });
  // target = round(1.8 x 80) = 144. 19 Nov..21 Nov are under; 22 Nov (today, 20 g) is ignored.
  const r = proteinStreak(d, { asOf: TODAY, today: TODAY });
  assert.ok(r);
  assert.equal(r.data.days, 3);
  assert.equal(r.data.target, 144);
  assert.equal(r.data.avg, 110);
  assert.equal(r.tone, 'warn');
  assert.match(r.title, /3 days running/);
});

test('protein: a day at target, or a missing day, breaks the streak', () => {
  const hit = baseData({ checkins: days('2025-11-19', 3, (i) => ({ weight_kg: 80, protein_g: [100, 150, 100][i] })) });
  assert.equal(proteinStreak(hit, { asOf: TODAY, today: TODAY }), null);
  const gap = baseData({ checkins: [...days('2025-11-18', 2, () => ({ weight_kg: 80, protein_g: 90 })), { date: '2025-11-20', weight_kg: 80, arm_flags: [] }, { date: '2025-11-21', weight_kg: 80, protein_g: 90, arm_flags: [] }] });
  assert.equal(proteinStreak(gap, { asOf: TODAY, today: TODAY }), null);
  assert.equal(proteinStreak(baseData(), { asOf: TODAY, today: TODAY }), null, 'no weight, no target');
});

test('protein: for a finished past day (weekly review) that day counts', () => {
  const d = baseData({ checkins: days('2025-11-14', 3, () => ({ weight_kg: 80, protein_g: 100 })) });
  assert.equal(proteinStreak(d, { asOf: '2025-11-16', today: TODAY }).data.days, 3);
});

// ---------------------------------------------------------------- insights: weight (PM6, chapter 14: every 2 weeks)

/** 21 days of weigh-ins from Mon 27 Oct: `before` for the first week, `now` for the last week. */
const fortnight = (before, now, extra = {}) => baseData({ checkins: days('2025-10-27', 21, (i) => ({ weight_kg: i < 7 ? before : i >= 14 ? now : (before + now) / 2 })), ...extra });
const W = { asOf: TODAY, programStart: '2025-11-03' }; // the check is the Sunday ending week 2 (16 Nov), shown that week

test('weight trend: checked every 2 weeks; inside the band says change nothing', () => {
  const r = weightTrend(fortnight(80.0, 80.6), W);
  assert.equal(r.tone, 'good');
  assert.ok(Math.abs(r.data.change - 0.3) < 1e-9, 'per week = (now - two weeks earlier) / 2');
  assert.match(r.body, /Change nothing/);
  assert.equal(r.data.review, '2025-11-16');
});

test('weight trend: losing weight warns, and never suggests dieting', () => {
  const r = weightTrend(fortnight(80.5, 80.1), W);
  assert.equal(r.tone, 'warn');
  assert.match(r.body, /No dieting/);
  assert.match(r.body, /250–300 kcal/);
});

test('weight trend: slow and fast gains follow chapter 14, and twice in a row moves the template', () => {
  const slow = weightTrend(fortnight(80.0, 80.2), W);
  assert.equal(slow.tone, 'info');
  assert.match(slow.body, /150–200 kcal/);
  assert.doesNotMatch(slow.body, /twice/);
  const fast = weightTrend(fortnight(80.0, 81.0), W);
  assert.match(fast.title, /faster than planned/);
  assert.match(fast.body, /100–150 kcal/);
  assert.match(fast.body, /stay above maintenance/);
  const steady = baseData({ checkins: days('2025-10-13', 35, (i) => ({ weight_kg: 80 + (0.1 / 7) * i })) });
  assert.match(weightTrend(steady, W).body, /twice in a row, so move up one meal-plan level on the Nutrition page/);
  assert.doesNotMatch(weightTrend(steady, W).body, /\d,\d{3} kcal/, 'no fixed calorie day: the levels depend on the person');
});

test('weight trend: needs 10 days of weigh-ins, and appears only in the week after each 2-week check', () => {
  const sparse = baseData({ checkins: [...days('2025-10-27', 4, () => ({ weight_kg: 80 })), ...days('2025-11-12', 5, () => ({ weight_kg: 80.6 }))] });
  assert.equal(weightTrend(sparse, W), null, 'only 9 days of data');
  assert.equal(weightTrend(fortnight(80.0, 80.6), { asOf: '2025-11-24', programStart: '2025-11-03' }), null, 'the following week is quiet');
  assert.equal(weightTrend(fortnight(80.0, 80.6), { asOf: '2025-11-11', programStart: '2025-11-03' }), null, 'nothing before programme week 3');
});

test('weight trend: no gain nudges while fasting; the aim is to hold steady at about maintenance', () => {
  const d = fortnight(80.5, 80.2, {});
  d.profile.fasting_periods = [{ start: '2025-11-15', end: '2025-12-14', label: 'A fast', approximate: true }];
  const r = weightTrend(d, W);
  assert.equal(r.tone, 'info');
  assert.match(r.body, /hold your weight steady at about maintenance/);
  assert.doesNotMatch(r.body, /iftar|suhoor|\d,\d{3} kcal/, 'no meal names or fixed calories');
  assert.doesNotMatch(r.body, /Add \d/);
});

// ---------------------------------------------------------------- insights: resting HR, sleep, arm

test('resting HR: a consistent rise is a trend note, never an easy-day recommendation (CL15)', () => {
  const d = baseData({ checkins: days('2025-11-02', 21, (i) => ({ rhr: i < 18 ? 58 : [62, 63, 62][i - 18] })) });
  const r = rhrTrend(d, { asOf: TODAY });
  assert.ok(r);
  assert.equal(r.id, 'rhr-up');
  assert.equal(r.push, false);
  assert.match(r.title, /trending up/);
  assert.doesNotMatch(`${r.title} ${r.body}`, /easy day|halve the sets|Zone 2 only/i);
  assert.match(r.body, /check-in decides/);
  const blip = baseData({ checkins: days('2025-11-02', 21, (i) => ({ rhr: i < 18 ? 58 : [66, 58, 58][i - 18] })) });
  assert.equal(rhrTrend(blip, { asOf: TODAY }), null, 'one high morning is not a trend');
  const flat = baseData({ checkins: days('2025-11-02', 21, () => ({ rhr: 58 })) });
  assert.equal(rhrTrend(flat, { asOf: TODAY }), null);
});

test('resting HR: readings from before a change of measuring method are never compared', () => {
  const d = baseData({ checkins: days('2025-11-02', 21, (i) => ({ rhr: i < 14 ? 52 : 60 })) });
  assert.ok(rhrTrend(d, { asOf: TODAY }), 'without a method change the jump looks like a rise');
  d.profile.rhr_method_changes = ['2025-11-16'];
  assert.equal(rhrTrend(d, { asOf: TODAY }), null, 'after the change only the new readings count, and there are too few');
});

// ---------------------------------------------------------------- insights: zone 2 (CL6)

/** Zone 2 planned this week: Tue 50 + Thu 50 + Sat 60 = 160 min (blocks with the week's overrides). */
const Z2PROG = {
  ...PROGRAM,
  sessions: {
    ...PROGRAM.sessions,
    z2: { name: 'Zone 2', type: 'cardio', blocks: [{ exercise: 'bike-upright', minutes: 50, zone: 'Z2' }] },
    walk: { name: 'Walk', type: 'hike', blocks: [{ exercise: 'walk-outdoor', minutes: 60, zone: 'Z2' }] },
  },
};
const withOverrides = (overrides) => ({ ...Z2PROG, phases: [{ ...Z2PROG.phases[0], week_overrides: overrides }, Z2PROG.phases[1]] });

test('zone 2: the target is the week’s planned minutes, not a phase-wide number', () => {
  const r = zone2Status(baseData(), Z2PROG, { asOf: '2025-11-18', today: '2025-11-18' });
  assert.equal(r.data.target, 160);
  const scaled = zone2Status(baseData(), withOverrides([{ week: 3, label: 'Lighter', cardio_scale: 0.5 }]), { asOf: '2025-11-18', today: '2025-11-18' });
  assert.equal(scaled.data.target, 80, 'cardio_scale applies');
});

test('zone 2: a gap is spread over the days left in daylight or on the treadmill, or not crammed at all', () => {
  const thu = zone2Status(baseData(), Z2PROG, { asOf: '2025-11-20', today: '2025-11-20' });
  assert.equal(thu.push, true);
  assert.match(thu.body, /Spread it out: about 15 minutes on each of the 4 days left, as a daylight walk or on the treadmill/);
  const sat = zone2Status(baseData(), Z2PROG, { asOf: TODAY, today: TODAY });
  assert.match(sat.body, /don’t cram it/);
  for (const r of [thu, sat]) assert.doesNotMatch(r.body, /after work|after dark|evening/i, 'never an outdoor walk after dark');
});

test('zone 2: behind target after counting the sessions still planned; small gaps say "about"', () => {
  const d = baseData({ workouts: [done('2025-11-18', 'z2', [{ exercise: 'bike-upright', minutes: 40, zone: 'Z2' }])] });
  const r = zone2Status(d, Z2PROG, { asOf: TODAY, today: TODAY });
  assert.equal(r.push, true);
  assert.equal(r.data.done, 40);
  assert.equal(r.data.remaining, 60, 'Saturday’s walk is still to come; Tuesday’s is logged');
  assert.match(r.body, /leaves you 60 min short/);
  assert.match(r.body, /about 30 minutes on each of the 2 days left/);
  const d2 = baseData({ workouts: [done('2025-11-18', 'z2', [{ exercise: 'bike-upright', minutes: 50, zone: 'Z2' }]), done('2025-11-20', 'z2', [{ exercise: 'bike-upright', minutes: 23, zone: 'Z2' }])] });
  const small = zone2Status(d2, Z2PROG, { asOf: TODAY, today: TODAY });
  assert.match(small.body, /27 min short\. Add about 30 minutes: a brisk walk in daylight/);
});

test('zone 2: no "do more" push in intro, deload, amber or fasting weeks', () => {
  const quiet = (r, why) => { assert.equal(r.push, false, why); assert.doesNotMatch(r.body, /Add about|Spread it out/, why); };
  quiet(zone2Status(baseData(), withOverrides([{ week: 3, label: 'Deload', deload: true }]), { asOf: '2025-11-20', today: '2025-11-20' }), 'deload');
  quiet(zone2Status(baseData(), Z2PROG, { asOf: '2025-11-20', today: '2025-11-20', readiness: 'amber' }), 'amber');
  const fasting = baseData();
  fasting.profile.fasting_periods = [{ start: '2025-11-19', end: '2025-12-01', label: 'A fast' }];
  quiet(zone2Status(fasting, Z2PROG, { asOf: '2025-11-20', today: '2025-11-20' }), 'fasting');
  const intro = baseData();
  intro.profile.program_start = '2025-11-17';
  quiet(zone2Status(intro, Z2PROG, { asOf: '2025-11-20', today: '2025-11-20' }), 'intro (first programme week)');
});

test('zone 2: target reached is good news; a finished week reports the shortfall without "after work"', () => {
  const full = baseData({ workouts: [done('2025-11-18', 'z2', [{ exercise: 'bike-upright', minutes: 170, zone: 'Z2' }])] });
  assert.equal(zone2Status(full, Z2PROG, { asOf: TODAY, today: TODAY }).tone, 'good');
  const past = baseData({ workouts: [done('2025-11-11', 'z2', [{ exercise: 'bike-upright', minutes: 60, zone: 'Z2' }])] });
  const r = zone2Status(past, Z2PROG, { asOf: '2025-11-16', today: TODAY });
  assert.match(r.title, /100 min short/);
  assert.match(r.body, /daylight walk at lunch/);
  assert.doesNotMatch(r.body, /after work/);
  assert.equal(zone2Status(full, null, { asOf: TODAY, today: TODAY }), null, 'no programme, no target');
});

test('zone 2: hikes without a linked workout count', () => {
  const d = baseData({ hikes: [{ id: 'h1', date: '2025-11-19', duration_min: 170, distance_km: 9 }] });
  assert.equal(zone2Status(d, Z2PROG, { asOf: TODAY, today: TODAY }).tone, 'good');
});

test('resting HR: falls back to the profile baseline when there is little history', () => {
  const d = baseData({ checkins: days('2025-11-20', 3, () => ({ rhr: 63 })) });
  d.profile.rhr_baseline = 58;
  assert.ok(rhrTrend(d, { asOf: TODAY }));
});

test('sleep: a short week nudges, a normal week does not', () => {
  const short = baseData({ checkins: days('2025-11-16', 7, () => ({ sleep_h: 5.8 })) });
  assert.equal(sleepShort(short, { asOf: TODAY }).tone, 'warn');
  const ok = baseData({ checkins: days('2025-11-16', 7, () => ({ sleep_h: 7.4 })) });
  assert.equal(sleepShort(ok, { asOf: TODAY }), null);
});

test('arm pain: rising pain is flagged with the pain rule and the clinic', () => {
  const d = baseData({ checkins: days('2025-11-09', 14, (i) => ({ arm_pain: i < 7 ? 1 : 3 })) });
  const r = armPainTrend(d, { asOf: TODAY });
  assert.ok(r);
  assert.match(r.body, /2\/10 or less/);
  assert.match(r.body, /fracture clinic/);
  assert.match(r.body, /pain getting worse/);
  const calm = baseData({ checkins: days('2025-11-09', 14, () => ({ arm_pain: 1 })) });
  assert.equal(armPainTrend(calm, { asOf: TODAY }), null);
});

// ---------------------------------------------------------------- insights: tests, clinic, clearances

test('tests due: retest after every_weeks, baseline missing, locked tests skipped', () => {
  const tests = [
    { id: 'sit', name: 'Sit-to-stand', gate: 'none', every_weeks: 4 },
    { id: 'wall', name: 'Wall sit', gate: 'none', every_weeks: 4 },
    { id: 'hang', name: 'Dead hang', gate: 'full_clearance', every_weeks: 4 },
  ];
  const d = baseData({ tests: [{ date: '2025-10-21', test: 'sit', value: 14 }, { date: '2025-11-11', test: 'wall', value: 40 }] });
  const r = testsDue(d, tests, { asOf: TODAY, programStart: '2025-11-03' });
  assert.deepEqual(r.data.ids, ['sit']);
  assert.equal(r.push, true);
  const fresh = baseData();
  assert.deepEqual(testsDue(fresh, tests, { asOf: TODAY, programStart: '2025-11-03' }).data.ids, ['sit', 'wall'], 'baselines due');
  assert.equal(testsDue(fresh, tests, { asOf: TODAY, programStart: '2025-11-24' }), null, 'nothing before the program starts');
});

test('clinic: upcoming appointment counts down; a past one without an outcome asks how it went', () => {
  const soon = baseData();
  soon.arm.appointments = [{ date: '2025-12-04', type: 'Fracture clinic', notes: '', outcome: '' }];
  const r = clinicInsight(soon, { asOf: TODAY, questions: [{}, {}, {}] });
  assert.equal(r.id, 'clinic-soon');
  assert.match(r.title, /in 12 days/);
  assert.match(r.body, /3 questions/);
  const after = baseData();
  after.arm.appointments = [{ date: '2025-11-20', type: 'Fracture clinic', notes: '', outcome: '' }];
  const f = clinicInsight(after, { asOf: TODAY });
  assert.equal(f.id, 'clinic-followup');
  assert.match(f.body, /record the date/);
  after.arm.appointments[0].outcome = 'All good';
  assert.equal(clinicInsight(after, { asOf: TODAY }), null);
  const far = baseData();
  far.arm.appointments = [{ date: '2026-01-31', type: 'Physio' }];
  assert.equal(clinicInsight(far, { asOf: TODAY }), null, 'more than two weeks away');
});

test('gate cleared: says what unlocked (exercises by category, phases, add-ons)', () => {
  const d = baseData();
  d.profile.clearances.clinic_light = '2025-11-20';
  const r = recentClearance(d, PROGRAM, EXERCISES, { asOf: TODAY });
  assert.equal(r.id, 'gate-cleared');
  assert.equal(r.tone, 'good');
  assert.equal(r.data.exercises, 3);
  assert.match(r.title, /^New clearance: Light use \(2 days ago\)$/);
  assert.doesNotMatch(r.title, /cleared cleared|clinic_light/, 'BT2-13: labels, and no "cleared cleared"');
  assert.match(r.body, /2 rehab and 1 conditioning/);
  assert.match(r.body, /Light starts Mon 29 Dec/, 'Foundation runs its 8 weeks first');
  assert.match(r.body, /Arm rehab: waiting for your physio’s programme/, 'BT2-4: accurate until the physio’s exercises are entered');
  assert.doesNotMatch(r.body, /Arm rehab now runs/);
  d.arm.physio_exercises = [{ exercise: 'rehab-putty-grip', dose: '10 x 3' }];
  assert.match(recentClearance(d, PROGRAM, EXERCISES, { asOf: TODAY }).body, /Arm rehab now runs alongside your sessions/);
  const red = coachInsights({ data: { ...d, checkins: [{ date: TODAY, arm_pain: 8, arm_flags: [] }] }, program: PROGRAM, exercises: EXERCISES, today: TODAY, readiness: 'red' });
  assert.equal(red.some((x) => x.id === 'gate-cleared'), false, 'BT2-4: never on a red day');
  d.profile.clearances.clinic_light = '2025-10-02';
  assert.equal(recentClearance(d, PROGRAM, EXERCISES, { asOf: TODAY }), null, 'old news after two weeks');
});

test('gate cleared: skipping straight to a higher gate unlocks everything in between', () => {
  const d = baseData();
  d.profile.clearances.grip_cleared = '2025-11-21';
  const r = recentClearance(d, PROGRAM, EXERCISES, { asOf: TODAY });
  assert.equal(r.data.exercises, 4, 'three clinic_light exercises plus the goblet squat');
});

// ---------------------------------------------------------------- insights: together

test('coachInsights sorts by priority and holds back "do more" notes on a red or amber day', () => {
  const d = baseData({
    checkins: days('2025-10-27', 27, (i) => ({ weight_kg: i < 7 ? 80.5 : i >= 14 ? 80.2 : 80.35, protein_g: 90, arm_pain: 1 })),
    workouts: [done('2025-11-18', 'z2', [{ exercise: 'bike-upright', minutes: 20, zone: 'Z2' }])],
  });
  const all = coachInsights({ data: d, program: PROGRAM, exercises: EXERCISES, tests: [], today: TODAY });
  const ids = all.map((x) => x.id);
  assert.ok(ids.includes('weight') && ids.includes('protein-streak') && ids.includes('zone2'), ids.join(','));
  assert.equal(all.find((x) => x.id === 'zone2').push, true);
  for (let i = 1; i < all.length; i++) assert.ok(all[i - 1].priority >= all[i].priority, 'sorted');
  const red = coachInsights({ data: d, program: PROGRAM, exercises: EXERCISES, tests: [], today: TODAY, readiness: 'red' });
  assert.equal(red.some((x) => x.push), false);
  assert.equal(red.some((x) => x.id === 'weight'), true, 'nutrition advice still shows');
  const amber = coachInsights({ data: d, program: PROGRAM, exercises: EXERCISES, tests: [], today: TODAY, readiness: 'amber' });
  assert.equal(amber.some((x) => x.push), false, 'amber never pushes for more');
  const ex = coachInsights({ data: d, program: PROGRAM, today: TODAY, exclude: ['weight'] });
  assert.equal(ex.some((x) => x.id === 'weight'), false);
});

test('coachInsights is safe on empty or odd data, and quiet until there is something recent', () => {
  assert.deepEqual(coachInsights({ data: baseData(), program: PROGRAM, today: TODAY }), []);
  const stale = baseData({ checkins: days('2025-09-02', 10, () => ({ weight_kg: 73, protein_g: 80 })) });
  assert.deepEqual(coachInsights({ data: stale, program: PROGRAM, today: TODAY }), [], 'nothing logged for weeks');
  assert.deepEqual(coachInsights({ data: null, today: TODAY }), []);
  const odd = baseData({ checkins: [{ date: 'nope' }, null, { date: '2025-11-21', weight_kg: 'x' }] });
  assert.doesNotThrow(() => coachInsights({ data: odd, program: PROGRAM, today: TODAY }));
});

test('insight text is plain UK English with no unresolved placeholders', () => {
  const d = baseData({ checkins: days('2025-11-09', 14, (i) => ({ weight_kg: 80.5 - (i < 7 ? 0 : 0.3), protein_g: 90, sleep_h: 5.5, arm_pain: i < 7 ? 1 : 4, rhr: i < 11 ? 58 : 63 })) });
  d.arm.appointments = [{ date: '2025-11-26', type: 'Fracture clinic' }];
  for (const r of coachInsights({ data: d, program: PROGRAM, exercises: EXERCISES, tests: [], today: TODAY })) {
    assert.doesNotMatch(`${r.title} ${r.body}`, /undefined|NaN|null|\$\{/, r.id);
    assert.ok(['alert', 'warn', 'info', 'good'].includes(r.tone));
  }
});

// ---------------------------------------------------------------- plates

test('plate maths: per-side breakdown with the fewest plates', () => {
  const r = platesFor(67.5);
  assert.equal(r.perSide, 33.75);
  assert.deepEqual(r.stack, [25, 5, 2.5, 1.25]);
  assert.equal(stackText(r.stack), '25 + 5 + 2.5 + 1.25');
  assert.deepEqual(platesFor(100).stack, [25, 25]);
  assert.deepEqual(platesFor(0).stack, []);
  assert.equal(stackText([]), 'no plates');
});

test('plate maths: works when some plate sizes are missing (greedy would fail)', () => {
  assert.deepEqual(plateStack(30, [20, 15]), [15, 15]);
  assert.deepEqual(platesFor(70, [20, 15]).stack, [20, 15]);
  const r = platesFor(65, [20, 15]);
  assert.equal(r.exact, false);
  assert.equal(r.below, 60);
  assert.equal(r.above, 70);
});

test('plate maths: a total that can’t be split suggests the nearest loadable totals', () => {
  const r = platesFor(67.3);
  assert.equal(r.exact, false);
  assert.equal(r.below, 65);
  assert.equal(r.above, 67.5);
  assert.equal(platesFor(-5), null);
  assert.equal(platesFor('x'), null);
});

test('plate helpers', () => {
  assert.deepEqual(cleanPlates([5, '25', 5, -1, 'x', 0.3]), [25, 5]);
  assert.deepEqual(cleanPlates(null), DEFAULT_PLATES);
  assert.equal(isPlateLoaded({ id: 'leg-press', equipment: [] }), true);
  assert.equal(isPlateLoaded({ id: 'calf-raise-leg-press', equipment: ['leg press machine'] }), true);
  assert.equal(isPlateLoaded('leg-press-single'), true);
  assert.equal(isPlateLoaded({ id: 'leg-extension', equipment: ['leg extension machine'] }), false);
});

// ---------------------------------------------------------------- swaps

test('swap options respect the gate on the day and never repeat exercises in the session', () => {
  const cl = { good_arm_ok: null, clinic_light: null, grip_cleared: null, full_clearance: null };
  const o = swapOptions('leg-press', { exById, exercises: EXERCISES, clearances: cl, date: TODAY, exclude: ['wall-sit'] });
  assert.deepEqual(o.easier, ['box-squat-bw']);
  assert.deepEqual(o.harder, ['leg-press-single']);
  assert.deepEqual(o.similar, ['tempo-squat-bw'], 'goblet squat is locked, wall sit is already in the session');
  assert.equal(hasSwaps(o), true);
  const later = swapOptions('leg-press', { exById, exercises: EXERCISES, clearances: { ...cl, grip_cleared: '2025-11-02' }, date: TODAY });
  assert.ok(later.similar.includes('goblet-squat'));
});

test('rehab work is never swapped for something "similar"', () => {
  const o = swapOptions('rehab-putty-grip', { exById, exercises: EXERCISES, clearances: { clinic_light: '2025-11-02' }, date: TODAY });
  assert.deepEqual(o.similar, []);
});

test('applySwap remembers the planned exercise and resets untouched sets', () => {
  const e = { block: 'b0', exercise: 'leg-press', sets: [{ kg: 60, reps: null, done: false }, { kg: 60, reps: null, done: false }] };
  applySwap(e, 'leg-press', 'box-squat-bw');
  assert.equal(e.exercise, 'box-squat-bw');
  assert.equal(e.swapped_from, 'leg-press');
  assert.equal(e.sets.every((s) => s.kg === null), true);
  applySwap(e, 'leg-press', 'tempo-squat-bw');
  assert.equal(e.swapped_from, 'leg-press', 'the plan is remembered through a second swap');
  applySwap(e, 'leg-press', 'leg-press');
  assert.equal(e.exercise, 'leg-press');
  assert.equal('swapped_from' in e, false);
  const doneSet = { block: 'b1', exercise: 'leg-press', sets: [{ kg: 60, reps: 10, done: true }] };
  applySwap(doneSet, 'leg-press', 'box-squat-bw');
  assert.equal(doneSet.sets[0].kg, 60, 'ticked sets are kept');
});

// ---------------------------------------------------------------- onboarding

test('onboarding shows once: finished or skipped both count', () => {
  const d = baseData();
  assert.equal(needsOnboarding(d), true);
  markOnboarding(d, { skipped: true, now: '2025-11-22T07:00:00.000Z' });
  assert.equal(needsOnboarding(d), false);
  assert.equal(onboardingState(d).skipped_at, '2025-11-22T07:00:00.000Z');
  const d2 = baseData();
  markOnboarding(d2, { safetyAck: true, now: '2025-11-22T07:05:00.000Z' });
  assert.equal(needsOnboarding(d2), false);
  assert.equal(d2.ui.onboarding.safety_ack_at, '2025-11-22T07:05:00.000Z');
  assert.equal(d2.ui.onboarding.version, 1);
  assert.equal(needsOnboarding({ ui: 'odd' }), true);
});

test('welcome step numbers clamp to the five steps', () => {
  assert.equal(WELCOME_STEPS.length, 5);
  assert.equal(stepFromParam(undefined), 0);
  assert.equal(stepFromParam('3'), 2);
  assert.equal(stepFromParam('99'), 4);
  assert.equal(stepFromParam('-2'), 0);
});

// ---------------------------------------------------------------- guide

test('guide read time is estimated from the file size', () => {
  assert.equal(readMinutes(39759), 28);
  assert.equal(readMinutes(500), 1);
  assert.equal(readMinutes(0), null);
  assert.equal(readMinutes(null), null);
});

// ---------------------------------------------------------------- clinic questions that survive rewording

import { matchAnswers, answerRecord, questionKey, similarity } from '../public/js/features/questions.js';
import { taskKey } from '../public/js/markdown.js';

test('clinic answers: exact text still matches the old hash keys', () => {
  const q = { topic: 'Ask first', question: 'When can I start using my injured hand for light tasks?' };
  const stored = { [taskKey(q.question)]: { question: q.question, asked: true, notes: 'From week 3' } };
  const m = matchAnswers([q], stored);
  assert.equal(m.get(0).via, 'text');
  assert.equal(m.get(0).rec.notes, 'From week 3');
});

test('clinic answers: a reworded question keeps its answer, and is moved to the new key on the next edit', () => {
  const old = 'When can I start using my injured hand for light tasks?';
  const stored = { [taskKey(old)]: { question: old, asked: true, notes: 'From week 3' } };
  const q = { topic: 'Ask first', question: 'When can I start using my injured hand for light everyday tasks?' };
  const m = matchAnswers([q], stored);
  assert.equal(m.get(0).via, 'similar');
  const rec = answerRecord(stored, q, m.get(0));
  assert.equal(rec.notes, 'From week 3');
  assert.equal(rec.question, q.question);
  assert.ok(stored[questionKey(q)]);
  assert.equal(stored[taskKey(old)], undefined, 'the old key is replaced, not duplicated');
});

test('clinic answers: unrelated questions never steal an answer, and one record serves one question', () => {
  const stored = { [taskKey('Is the wound fully healed?')]: { question: 'Is the wound fully healed?', asked: true, notes: 'Yes' } };
  const qs = [{ question: 'Can I carry a light shopping bag in my injured hand?' }, { question: 'Is the wound fully healed now?' }, { question: 'Is the wound fully healed yet?' }];
  const m = matchAnswers(qs, stored);
  assert.equal(m.has(0), false);
  assert.equal([...m.values()].filter((x) => x.rec.notes === 'Yes').length, 1);
  assert.ok(similarity('a b c', '') === 0);
});

test('clinic answers: a content id, when present, is the stable key', () => {
  const q = { id: 'q-light-use', question: 'Anything' };
  assert.equal(questionKey(q), 'id:q-light-use');
  const stored = {};
  answerRecord(stored, q).asked = true;
  assert.equal(stored['id:q-light-use'].asked, true);
  assert.equal(matchAnswers([{ id: 'q-light-use', question: 'Reworded completely' }], stored).get(0).via, 'id');
});

// ---------------------------------------------------------------- conflict dialog text

import { formatConflictValue, conflictLabel } from '../public/js/features/conflict.js';

test('conflict values and labels read as plain English', () => {
  assert.equal(formatConflictValue(undefined), 'Deleted');
  assert.equal(formatConflictValue(null), 'Empty');
  assert.equal(formatConflictValue(true), 'Yes');
  assert.equal(formatConflictValue(80.5), '80.5');
  assert.equal(formatConflictValue('Bed by 22:30'), '“Bed by 22:30”');
  assert.equal(formatConflictValue(['pain_increasing', 'swelling_new']), 'pain_increasing, swelling_new');
  assert.equal(conflictLabel({ collection: 'checkins', key: '2025-11-21', field: 'weight_kg' }), 'Check-in, Fri 21 Nov 2025: weight');
  assert.equal(conflictLabel({ collection: null, path: ['profile', 'clearances', 'good_arm_ok'] }), 'Profile: clearances, good arm ok');
  assert.equal(conflictLabel({ collection: 'workouts', key: 'abc', field: 'exercises.b0.sets.1.kg' }), 'Session: kg');
});

// ---------------------------------------------------------------- readiness by week

import { readinessWeeks } from '../public/js/features/readinesschart.js';

test('readiness by week counts green, amber, red and missing mornings', () => {
  const checkins = [
    { date: '2025-11-17', sleep_h: 7.5, energy: 4, arm_flags: [] },
    { date: '2025-11-18', sleep_h: 5, arm_flags: [] },
    { date: '2025-11-19', arm_flags: ['swelling_new'] },
    { date: '2025-11-20', weight_kg: 73, arm_flags: [] }, // nothing that counts towards readiness
  ];
  const w = readinessWeeks(checkins, {}, '2025-11-17', '2025-11-22');
  assert.equal(w.length, 1);
  assert.deepEqual(w[0].counts, { green: 1, amber: 1, red: 1, none: 3 });
  assert.equal(w[0].days, 6, 'the week so far');
});

// ================================================================ round 3: the UI's safety layer

import { readinessFor, readinessRange, rhrAmberAt, isLocked, isAvailable, canOffer, unavailableIds, progressionFor, holdReason, fastingOn, fastingInWeek, RED_STOP, FASTING_TEXT, RISING_PAIN_MSG, HOLD_TEXT } from '../public/js/features/safety.js';
import { blockKeys, findEntry, resolveFor, alternates, addonVisible, planOn, weekendPlanFor, plannedZone2Week, isIntroWeek } from '../public/js/features/plan.js';
import { setTargets, setText, setsSummary, setHasActual } from '../public/js/features/sets.js';
import { baselineDueFrom, testStatus, testsDueOn } from '../public/js/features/testplan.js';
import { defaultGoals, goalsOf, setGoal, evaluateGoals } from '../public/js/features/goals.js';
import { formDraft, loadDraft, hasDirtyDrafts, clearDraft } from '../public/js/features/drafts.js';
import { plateLimit } from '../public/js/features/plates.js';
import { content } from '../public/js/content.js';
import { resolveSession, buildTimeline } from '../public/js/schedule.js';

function withLibrary(fn) {
  const saved = { exercises: content.exercises, exById: content.exById };
  content.exercises = EXERCISES;
  content.exById = new Map(EXERCISES.map((e) => [e.id, e]));
  try { return fn(); } finally { content.exercises = saved.exercises; content.exById = saved.exById; }
}

test('readiness (single source): red at pain 7, amber for rising pain with the message, weight-only is not a check-in', () => {
  const d = baseData({ checkins: [...days('2025-11-16', 4, () => ({ arm_pain: 1 })), { date: '2025-11-20', arm_pain: 4, arm_flags: [] }, { date: '2025-11-21', arm_pain: 7, arm_flags: [] }, { date: TODAY, weight_kg: 80.4, arm_flags: [] }] });
  const red = readinessFor(d, '2025-11-21');
  assert.equal(red.level, 'red');
  assert.equal(red.advice, RED_STOP);
  const rising = baseData({ checkins: [...days('2025-11-16', 4, () => ({ arm_pain: 1 })), { date: '2025-11-20', arm_pain: 3, arm_flags: [] }] });
  const r = readinessFor(rising, '2025-11-20');
  assert.equal(r.level, 'amber', '3 is 2 or more above the 7-day average of 1');
  assert.ok(r.messages.includes(RISING_PAIN_MSG));
  assert.equal(readinessFor(d, TODAY).level, 'unknown', 'a weight alone is not a check-in');
  assert.equal(readinessFor(d, TODAY).checkedIn, false);
});

test('readiness: a fasting day is amber even before a check-in, with the fasting message', () => {
  const d = baseData();
  d.profile.fasting_periods = [{ start: '2026-01-12', end: '2026-01-16', label: 'Planned fast', approximate: true }];
  const r = readinessFor(d, '2026-01-14');
  assert.equal(r.level, 'amber');
  assert.ok(r.messages.includes(FASTING_TEXT));
  assert.ok(fastingOn(d, '2026-01-16'));
  assert.equal(fastingOn(d, '2026-01-17'), null);
  assert.equal(fastingInWeek(d, '2026-01-12'), true);
});

test('readiness: the resting-HR rule waits for 5 readings after a change of method, and the amber line is a whole number', () => {
  const d = baseData({ checkins: [...days('2025-11-11', 9, () => ({ rhr: 52 })), { date: '2025-11-20', rhr: 62, arm_flags: [] }] });
  assert.equal(readinessFor(d, '2025-11-20').level, 'amber');
  d.profile.rhr_method_changes = ['2025-11-17'];
  const r = readinessFor(d, '2025-11-20');
  assert.equal(r.level, 'green', 'only 3 readings since the change');
  assert.ok(r.rhrBlocked && r.rhrBlocked.count < 5 && r.rhrBlocked.since === '2025-11-17');
  assert.equal(rhrAmberAt({ value: 58.4 }), 64, '58.4 + 5 = 63.4, so 64 bpm is the first amber reading');
  assert.equal(rhrAmberAt({ value: 58 }), 63);
});

test('readinessRange agrees with readinessFor day by day', () => {
  const d = baseData({ checkins: days('2025-11-09', 14, (i) => ({ sleep_h: i % 3 ? 7.5 : 5, energy: 4 })) });
  const map = readinessRange(d, '2025-11-09', TODAY);
  assert.equal(map.size, 14);
  for (const [date, r] of map) assert.equal(r.level, readinessFor(d, date).level, date);
});

test('fail closed: an exercise missing from the library is locked; unavailable kit is never offered', () => {
  withLibrary(() => {
    const d = baseData();
    assert.equal(isLocked('leg-press', TODAY, d), false);
    assert.equal(isLocked('not-in-the-library', TODAY, d), true);
    assert.equal(isLocked('goblet-squat', TODAY, d), true, 'grip_cleared not met');
    assert.deepEqual(unavailableIds(d).sort(), ['cable-hip-abduction-ankle', 'cable-hip-adduction-ankle', 'cable-kickback-ankle', 'sled-drag-backward-belt', 'sled-drag-forward-belt'], 'the migration default');
    d.profile.unavailable_exercises = ['tempo-squat-bw'];
    assert.equal(isAvailable('tempo-squat-bw', d), false);
    assert.equal(canOffer('tempo-squat-bw', TODAY, d), false);
    assert.equal(canOffer('wall-sit', TODAY, d), true);
    const o = swapOptions('leg-press', { exById: content.exById, exercises: content.exercises, clearances: d.profile.clearances, date: TODAY, unavailable: ['tempo-squat-bw'] });
    assert.equal([...o.easier, ...o.harder, ...o.similar].includes('tempo-squat-bw'), false, 'QA10');
  });
});

test('progression holds in deload, easy-day and fasting weeks (SPEC 5.2)', () => {
  const lastSets = [{ kg: 60, reps: 12, done: true }, { kg: 60, reps: 12, done: true }, { kg: 60, reps: 12, done: true }];
  const grow = progressionFor({ reps: '8-12', lastSets, increment: 10, setsPlanned: 3 });
  assert.equal(grow.kind, 'add-load');
  for (const hold of ['deload', 'easy', 'fasting']) {
    const r = progressionFor({ reps: '8-12', lastSets, increment: 10, hold, setsPlanned: 3 });
    assert.equal(r.kind, 'hold', hold);
    assert.match(r.text, new RegExp(HOLD_TEXT.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
  assert.equal(holdReason({ deload: true }), 'deload');
  assert.equal(holdReason({ fasting: true, deload: true }), 'fasting');
  assert.equal(holdReason({}), null);
});

// ---------------------------------------------------------------- plan helpers

test('block keys are the planned exercise plus its occurrence, so sets never move to another exercise (PE10)', () => {
  const blocks = resolveSession({ blocks: [{ exercise: 'leg-press', sets: 3, reps: '8-12' }, { exercise: 'wall-sit', sets: 2, seconds: 30 }, { exercise: 'leg-press', sets: 2, reps: '10' }, { circuit: { minutes: 10, items: [] } }] });
  assert.deepEqual(blockKeys(blocks), ['leg-press:1', 'wall-sit:1', 'leg-press:2', 'circuit:1']);
  const list = [{ block: 'b0', exercise: 'leg-press', sets: [] }, { block: 'wall-sit:1', exercise: 'wall-sit', sets: [] }];
  assert.equal(findEntry(list, 'leg-press:1', 'b0', 'leg-press'), list[0], 'an older positional key still matches the same exercise');
  assert.equal(findEntry(list, 'leg-press:2', 'b2', 'leg-press'), null);
  assert.equal(findEntry([{ block: 'b0', exercise: 'box-squat-bw', sets: [] }], 'leg-press:1', 'b0', 'leg-press'), null, 'a positional key for another exercise never matches');
});

test('week overrides: zone_cap, circuit_minutes and rounds reach the resolved blocks', () => {
  const s = { blocks: [{ exercise: 'bike-upright', warmup_min: 5, cooldown_min: 5, intervals: { work_s: 30, rest_s: 90, rounds: 6, work_zone: 'Z4-Z5' } }, { circuit: { minutes: 20, items: [] }, zone: 'Z2-Z3' }] };
  const [iv, circ] = resolveFor(s, { week: 1, override: { zone_cap: 'Z3', circuit_minutes: 5, rounds: 4 } });
  assert.equal(iv.intervals.work_zone, 'Z3');
  assert.equal(iv.intervals.rounds, 4);
  assert.equal(circ.circuit.minutes, 5);
});

test('the rehab add-on waits for the physio’s programme; alternates and this weekend’s route come from content', () => {
  const entry = { source: 'addon', sessionId: 'rehab', session: PROGRAM.sessions.rehab, addon: PROGRAM.addons[0] };
  const d = baseData();
  assert.equal(addonVisible(entry, d, PROGRAM), false);
  d.arm.physio_exercises = [{ exercise: 'rehab-putty-grip', dose: '10 x 3' }];
  assert.equal(addonVisible(entry, d, PROGRAM), true);
  const prog = { ...PROGRAM, alternates: { short: 'str', travel: 'missing' } };
  assert.deepEqual(alternates(prog), { short: 'str', travel: null });
  const hikes = { weekend_plan: [{ week_start: '2025-11-17', name: 'Riverside park loop', minutes: 45, level: 1 }] };
  assert.equal(weekendPlanFor(hikes, TODAY).name, 'Riverside park loop');
  assert.equal(weekendPlanFor(hikes, '2025-11-24'), null);
  assert.equal(weekendPlanFor({}, TODAY), null);
});

test('planned Zone 2 for a week, and intro weeks', () => {
  assert.equal(plannedZone2Week(PROGRAM, baseData(), '2025-11-17'), 50);
  const d = baseData();
  d.profile.program_start = '2025-11-17';
  const plan = planOn(PROGRAM, d, '2025-11-18', buildTimeline(PROGRAM, d.profile));
  assert.equal(isIntroWeek(plan), true);
});

// ---------------------------------------------------------------- set targets (PE5)

test('set targets are real numbers from the suggestion, and the summary says what will be recorded', () => {
  const last = [{ kg: 60, reps: 12, done: true }, { kg: 60, reps: 11, done: true }];
  assert.deepEqual(setTargets({ reps: '8-12', count: 2, lastSets: last, suggestion: { kind: 'add-load', kg: 70 } }).map((s) => [s.kg, s.reps]), [[70, 8], [70, 8]]);
  assert.deepEqual(setTargets({ reps: '8-12', count: 2, lastSets: last, suggestion: { kind: 'add-reps', kg: 60 } }).map((s) => [s.kg, s.reps]), [[60, 12], [60, 12]], 'one more rep than last time, capped at the top');
  assert.deepEqual(setTargets({ reps: '8-12', count: 1, lastSets: last, suggestion: { kind: 'hold', kg: 60 } }).map((s) => [s.kg, s.reps]), [[60, 12]], 'hold: last time’s load and reps for that set (round 4), never more');
  assert.deepEqual(setTargets({ reps: '8-12', count: 1, lastSets: [], suggestion: { kind: 'start' } }).map((s) => [s.kg, s.reps]), [[null, 8]]);
  assert.deepEqual(setTargets({ kind: 'timed', seconds: 45, count: 2 }).map((s) => s.seconds), [45, 45]);
  assert.equal(setsSummary([{ kg: 40, reps: 10 }, { kg: 40, reps: 10 }, { kg: 40, reps: 10 }]), '3 × 10 at 40 kg');
  assert.equal(setsSummary([{ kg: 40, reps: 10 }, { kg: 42.5, reps: 8 }]), '40 kg × 10, 42.5 kg × 8');
  assert.equal(setText({ kg: null, reps: 12 }), '12 reps');
  assert.equal(setHasActual({ kg: 40, reps: null }), false, 'a tick needs a rep count');
  assert.equal(setHasActual({ seconds: 30 }, true), true);
});

// ---------------------------------------------------------------- tests are due from their scheduled time (PM2)

test('tests: baselines from the programme start (or their scheduled week), never before; retests every_weeks', () => {
  const tl = { start: '2025-11-24', phases: [{ id: 'p0', start: '2025-11-24' }, { id: 'p1', start: '2025-12-01' }] };
  const sit = { id: 'sit', gate: 'none', every_weeks: 4 };
  const lp = { id: 'lp', gate: 'none', every_weeks: 4, baseline: { phase: 'p1', week: 2, day: 5 } };
  const hang = { id: 'hang', gate: 'full_clearance', every_weeks: 4 };
  assert.equal(baselineDueFrom(sit, tl), '2025-11-24');
  assert.equal(baselineDueFrom(lp, tl), '2025-12-12', 'Friday of Phase 1 week 2');
  const d = baseData();
  assert.deepEqual(testsDueOn(d, [sit, lp, hang], '2025-11-23', tl), [], 'nothing before day 1');
  assert.deepEqual(testsDueOn(d, [sit, lp, hang], '2025-11-25', tl).map((x) => x.test.id), ['sit']);
  assert.equal(testStatus(d, lp, '2025-11-25', tl).state, 'scheduled');
  assert.equal(testStatus(d, hang, '2025-11-25', tl).state, 'locked');
  d.tests = [{ date: '2025-11-25', test: 'sit', value: 14 }];
  assert.equal(testStatus(d, sit, '2025-12-02', tl).state, 'done');
  assert.equal(testStatus(d, sit, '2025-12-23', tl).state, 'due');
});

// ---------------------------------------------------------------- goals (PM9)

test('goals: chapter 01 defaults until edited; edits are saved in data.goals', () => {
  const d = baseData();
  assert.deepEqual(goalsOf(d).map((g) => g.id), ['weight', 'zone2', 'leg-press', 'protein', 'adherence']);
  assert.equal(goalsOf(d).find((g) => g.id === 'zone2').minutes, 150);
  assert.equal(d.goals, undefined, 'reading never writes');
  setGoal(d, 'zone2', { minutes: 180 });
  assert.equal(goalsOf(d).find((g) => g.id === 'zone2').minutes, 180);
  assert.equal(d.goals.version, 1);
  assert.equal(defaultGoals().length, 5);
});

test('goals: Zone 2 counts from Phase 1 week 3; the leg-press goal waits for its baseline', () => {
  const d = baseData();
  const list = evaluateGoals({ data: d, program: PROGRAM, today: '2025-11-11' });
  assert.equal(list.find((x) => x.goal.id === 'zone2').state, 'waiting', 'week 2');
  assert.equal(list.find((x) => x.goal.id === 'leg-press').state, 'waiting');
  const later = evaluateGoals({ data: baseData({ workouts: [done('2025-11-18', 'z2', [{ exercise: 'bike-upright', minutes: 160, zone: 'Z2' }])] }), program: PROGRAM, today: TODAY });
  const z2 = later.find((x) => x.goal.id === 'zone2');
  assert.notEqual(z2.state, 'waiting');
  assert.match(z2.headline, /160 of 150 min/);
});

// ---------------------------------------------------------------- drafts (PE6) and plate limits (QA14)

test('form drafts survive a re-render and count as unsaved until cleared', () => {
  const a = formDraft('test-form', { date: TODAY, value: null });
  assert.equal(a.dirty, false);
  a.set('value', 42);
  const b = formDraft('test-form', { date: TODAY, value: null });
  assert.equal(b.value.value, 42, 'a rebuilt form gets the typed value back');
  assert.equal(hasDirtyDrafts(), true);
  b.clear();
  assert.equal(loadDraft('test-form'), null);
  clearDraft('test-form');
  assert.equal(hasDirtyDrafts(), false);
});

test('plate calculator refuses absurd totals', () => {
  assert.equal(plateLimit(platesFor(100)), null);
  assert.equal(plateLimit(platesFor(500)), 'total');
  assert.equal(plateLimit(platesFor(40, [2.5])), null, '8 plates a side is allowed');
  assert.equal(plateLimit(platesFor(45, [2.5])), 'plates', 'but not 9');
});

// ================================================================ round 4 (wave B): Team U

import { prescriptionFor, effectiveRx, plannedRecord, samePlanned, parseDose, rxText, isLoadedExercise } from '../public/js/features/rx.js';
import { plannedSetsOfLog, lastPlannedSets, weekendDate, zone2Week } from '../public/js/features/plan.js';
import { allowedForPhase, phaseGateOn, armLogPainOn, START_TEXT } from '../public/js/features/safety.js';
import { weightVerdict, bandFor, verdictLine, BANDS } from '../public/js/features/weight.js';
import { GOAL_STATE_LABEL } from '../public/js/features/goals.js';
import { unlockSummary, goodArmWarning, dateCheck, injuryDateOf, beforeInjuryError } from '../public/js/features/clearance.js';
import { renderMarkdown } from '../public/js/markdown.js';
import { lastPerformance } from '../public/js/stats.js';

function withContent({ program = null, exercises = null } = {}, fn) {
  const saved = { program: content.program, exercises: content.exercises, exById: content.exById };
  if (program) content.program = program;
  if (exercises) { content.exercises = exercises; content.exById = new Map(exercises.map((e) => [e.id, e])); }
  try { return fn(); } finally { Object.assign(content, saved); }
}

/** Strength with one leg-press block; week 1 caps sets at 2, week 4 is a deload. */
const CAPPED = {
  ...PROGRAM,
  phases: [{ ...PROGRAM.phases[0], week_overrides: [{ week: 1, label: 'Build-in', sets_max: 2, rir: '3' }, { week: 4, label: 'Deload', deload: true }] }, PROGRAM.phases[1]],
  sessions: { ...PROGRAM.sessions, str: { name: 'Strength', type: 'strength', blocks: [{ exercise: 'leg-press', sets: 3, reps: '8-12', rir: '2-3', load: 'double-progression' }] } },
  rules: { increments_kg: { 'leg-press': 10, default: 2.5 } },
};
const legPressLog = (date, sets, extra = {}) => ({
  id: `w-${date}`, date, session_id: 'str', session_type: 'strength', status: 'done', phase_id: 'p1', ...extra,
  exercises: [{ block: 'leg-press:1', exercise: 'leg-press', sets: sets.map(([kg, reps]) => ({ kg, reps, seconds: null, rir: null, done: true })), notes: '' }], cardio: [],
});

test('BT1-1: progression is judged against last time’s effective sets, never the raw block sets', () => {
  // Week 1 (sets_max 2): 60 kg × 12, 12, an older log with no `planned`: recomputed as 2 sets.
  const capped = baseData({ workouts: [legPressLog('2025-11-03', [[60, 12], [60, 12]], { phase_week: 1 })] });
  const last = lastPerformance(capped, 'leg-press', '2025-11-10', null, { program: CAPPED, sessionId: 'str', blockKey: 'leg-press:1', reps: '8-12' });
  assert.equal(plannedSetsOfLog(CAPPED, capped, capped.workouts[0], capped.workouts[0].exercises[0]), 2);
  assert.equal(lastPlannedSets(CAPPED, capped, last, 'leg-press'), 2);
  const grow = progressionFor({ reps: '8-12', lastSets: last.sets, increment: 10, setsPlanned: lastPlannedSets(CAPPED, capped, last, 'leg-press') });
  assert.equal(grow.kind, 'add-load');
  assert.equal(grow.kg, 70);
  assert.match(grow.text, /Add 10 kg/);
  // An easy (amber) day halves 3 sets to 2: 40 kg × 10, 10 then means "beat last time".
  const easy = baseData({ workouts: [legPressLog('2025-11-11', [[40, 10], [40, 10]], { phase_week: 2, easy_day: true })] });
  const l2 = lastPerformance(easy, 'leg-press', '2025-11-17', null, { program: CAPPED, sessionId: 'str', blockKey: 'leg-press:1', reps: '8-12' });
  const beat = progressionFor({ reps: '8-12', lastSets: l2.sets, increment: 10, setsPlanned: lastPlannedSets(CAPPED, easy, l2, 'leg-press') });
  assert.equal(beat.kind, 'add-reps');
  assert.match(beat.text, /beat last time/);
  // A stored `planned` wins over any recomputation.
  const stored = legPressLog('2025-11-11', [[40, 10], [40, 10]], { phase_week: 2 });
  stored.exercises[0].planned = { sets: 2, reps: '8-12', rir: '3-4', load: 'double-progression' };
  assert.equal(plannedSetsOfLog(CAPPED, baseData({ workouts: [stored] }), stored, stored.exercises[0]), 2);
});

const RXLIB = [
  { id: 'wall-sit', name: 'Wall sit', category: 'squat', gate: 'none', equipment: ['smooth wall'], dose: '3–5 × 30–45 s holds, 60 s rest', cues: ['Back flat on the wall'] },
  { id: 'ga-cable-row', name: 'Cable row (good arm)', category: 'pull', gate: 'good_arm_ok', equipment: ['cable machine or seated row station'], dose: '3 × 8–12, RIR 2–3', cues: [] },
  { id: 'glute-bridge', name: 'Glute bridge', category: 'hinge', gate: 'none', equipment: ['mat'], dose: '2–3 × 10–12 with a 3-s squeeze at the top', cues: [] },
];

test('swaps bring their own prescription: timed, bodyweight reps or loaded with a kg column (BT1-3)', () => {
  const lib = new Map(RXLIB.map((e) => [e.id, e]));
  const hold = prescriptionFor('wall-sit', lib);
  assert.equal(hold.kind, 'timed');
  assert.equal(hold.seconds, 30);
  assert.equal(hold.loaded, false);
  const row = prescriptionFor('ga-cable-row', lib);
  assert.equal(row.kind, 'strength');
  assert.equal(row.loaded, true);
  assert.equal(row.load, 'double-progression');
  assert.equal(prescriptionFor('glute-bridge', lib).loaded, false);
  assert.equal(prescriptionFor('not-in-the-library', lib), null, 'fail closed');
  // The week's adjustments apply to a stand-in exactly as to a planned block.
  const capped = effectiveRx(row, { override: { sets_max: 2 } });
  assert.equal(capped.sets, 2);
  assert.match(capped.setsNote, /capped at 2/);
  const easy = effectiveRx(row, { easyDay: true });
  assert.equal(easy.sets, 2, '3 halved, rounding up');
  assert.equal(easy.rir, '3-4', 'hold RIR on an easy day');
  assert.deepEqual(plannedRecord(easy), { sets: 2, reps: '8-12', rir: '3-4', load: 'double-progression' });
  assert.deepEqual(plannedRecord(effectiveRx(hold, {})), { sets: 3, reps: null, rir: '', load: 'bodyweight', seconds: 30 }, 'the same shape as schedule.plannedFromBlock');
  assert.equal(samePlanned({ sets: 2, reps: '8-12', rir: null, load: 'x' }, { sets: 2, reps: '8-12', load: 'x' }), true);
  assert.equal(rxText(effectiveRx(hold, {})), '3 × 30 s');
  // The local reading of a dose (used until content.prescriptionFor exists).
  const side = parseDose('4 × 30 s / side');
  assert.deepEqual([side.kind, side.seconds, side.per_side], ['timed', 30, true]);
  assert.equal(parseDose('2–3 × 8–10 steps / leg, RIR 2–3').unit, 'steps');
  assert.equal(isLoadedExercise({ id: 'inverted-row-smith', category: 'pull', equipment: ['Smith machine with the bar locked'] }), false, 'a locked bar is a handle, not a load');
});

test('swap and "Add an exercise" offer only what the phase allows, never above your clearances (BT2-2)', () => {
  const lib = [...EXERCISES, { id: 'ga-cable-row', name: 'Cable row', category: 'pull', gate: 'good_arm_ok', regressions: [], progressions: [], equipment: [] }];
  withContent({ program: PROGRAM, exercises: lib }, () => {
    const d = baseData();
    d.profile.clearances.grip_cleared = '2025-11-02';
    assert.equal(phaseGateOn(TODAY, d), 'none', 'Phase 1 opens at "none"');
    assert.equal(allowedForPhase('leg-press', TODAY, d), true);
    assert.equal(allowedForPhase('goblet-squat', TODAY, d), false, 'cleared, but above this phase');
    assert.equal(allowedForPhase('ga-cable-row', TODAY, d), false);
    assert.equal(allowedForPhase('rehab-putty-grip', TODAY, d, { sessionId: 'rehab', ceiling: 'clinic_light' }), true, 'an add-on session’s own gate counts');
    assert.equal(allowedForPhase('not-in-the-library', TODAY, d), false, 'fail closed');
    d.profile.unavailable_exercises = ['leg-press'];
    assert.equal(allowedForPhase('leg-press', TODAY, d), false, 'not at your gym');
    const later = baseData();
    later.profile.clearances.clinic_light = '2025-11-02';
    assert.equal(allowedForPhase('ruck-light', '2026-01-05', later), true, 'Phase 2 opens at Light use');
    assert.equal(allowedForPhase('goblet-squat', '2026-01-05', later), false, 'never above your clearances');
  });
});

test('readiness: same-day rehab-log pain of 7 or more is red, like the check-in (BT2-6)', () => {
  const d = baseData();
  d.arm.logs = [{ date: TODAY, values: { pain_rest: 2, pain_activity: 7 }, notes: '' }];
  assert.equal(armLogPainOn(d, TODAY), 7);
  const r = readinessFor(d, TODAY);
  assert.equal(r.level, 'red');
  assert.equal(r.advice, RED_STOP);
  d.arm.logs[0].values.pain_activity = 6;
  assert.notEqual(readinessFor(d, TODAY).level, 'red');
  assert.equal(readinessFor(d, '2025-11-21').level, 'unknown', 'only the same day');
});

/** Daily weigh-ins from Mon 20 Oct to Sun 16 Nov rising `perWeek` kg a week. */
const rising = (perWeek, extra = {}) => baseData({ checkins: days('2025-10-20', 28, (i) => ({ weight_kg: 73 + (perWeek / 7) * i })), ...extra });

test('weight: the regain band while below your pre-injury weight, then lean gain (SPEC 5.2 round 4)', () => {
  assert.equal(bandFor({ pre_injury_weight_kg: 78 }, 74).kind, 'regain');
  assert.equal(bandFor({ pre_injury_weight_kg: 78 }, 78.4).kind, 'lean');
  assert.equal(bandFor({}, 74).kind, 'default');
  assert.deepEqual([BANDS.regain.lo, BANDS.regain.hi, BANDS.lean.lo, BANDS.lean.hi], [0.25, 0.5, 0.15, 0.3]);
  const fast = rising(0.45);
  assert.equal(weightVerdict(fast, TODAY).state, 'above', '0.45 is above +0.2 to +0.4 with no pre-injury weight');
  fast.profile.pre_injury_weight_kg = 78;
  const v = weightVerdict(fast, TODAY);
  assert.equal(v.state, 'in', 'inside the regain band');
  assert.equal(v.band.kind, 'regain');
  assert.match(weightTrend(fast, { asOf: TODAY, programStart: '2025-11-03' }).body, /regain band/);
  const goal = evaluateGoals({ data: fast, program: PROGRAM, today: TODAY }).find((x) => x.goal.id === 'weight');
  assert.equal(goal.state, 'on-track', 'the goals card uses the same verdict');
});

test('weight: fasting (and the 14 days after) holds steady, never "below band" (BT3-13)', () => {
  const d = rising(0.1);
  d.profile.fasting_periods = [{ start: '2025-11-17', end: '2025-12-11', label: 'A fast' }];
  const v = weightVerdict(d, TODAY);
  assert.equal(v.state, 'paused');
  const line = verdictLine(v, { fastingNow: fastingOn(d, TODAY) });
  assert.match(line, /hold your weight steady/i);
  assert.doesNotMatch(line, /below/);
  const goal = evaluateGoals({ data: d, program: PROGRAM, today: TODAY }).find((x) => x.goal.id === 'weight');
  assert.equal(goal.state, 'hold');
  assert.equal(GOAL_STATE_LABEL.hold, 'Holding steady');
});

test('tests due: baselines spread over Mon–Wed, first_phase waits, nothing while fasting (BT2-1, BT1-13)', () => {
  const tests = [
    { id: 'sts', gate: 'none', every_weeks: 4, baseline_day: 1 },
    { id: 'walk', gate: 'none', every_weeks: 4, baseline_day: 2 },
    { id: 'hollow', gate: 'none', every_weeks: 4, baseline_day: 3 },
    { id: 'hang', gate: 'none', every_weeks: 4, first_phase: 'p2', first_week: 4 },
  ];
  const d = baseData();
  d.profile.program_start = '2025-11-24';
  d.profile.clearances.clinic_light = '2025-11-02';
  const tl = buildTimeline(PROGRAM, d.profile);
  const ids = (date) => testsDueOn(d, tests, date, tl).map((x) => x.test.id);
  assert.deepEqual(ids('2025-11-23'), [], 'nothing before day 1');
  assert.deepEqual(ids('2025-11-24'), ['sts']);
  assert.deepEqual(ids('2025-11-25'), ['sts', 'walk']);
  assert.deepEqual(ids('2025-11-26'), ['sts', 'walk', 'hollow']);
  const p2 = tl.phases.find((p) => p.id === 'p2').start;
  assert.equal(testStatus(d, tests[3], '2025-12-02', tl).state, 'scheduled');
  assert.equal(testStatus(d, tests[3], '2025-12-02', tl).dueOn, addDays(p2, 21), 'week 4 of its phase');
  assert.equal(ids(addDays(p2, 20)).includes('hang'), false);
  assert.equal(ids(addDays(p2, 21)).includes('hang'), true);
  d.profile.fasting_periods = [{ start: '2025-11-24', end: '2025-11-30', label: 'A fast' }];
  assert.deepEqual(ids('2025-11-26'), [], 'no tests during a fast');
});

test('goals: "Not started yet" in programme week 1; sessions done ÷ planned; deload weeks don’t count (BT3)', () => {
  const wk1 = baseData();
  wk1.profile.program_start = '2025-11-17';
  const first = evaluateGoals({ data: wk1, program: PROGRAM, today: TODAY });
  assert.ok(first.length >= 4);
  for (const g of first) assert.equal(g.state, 'waiting', g.goal.id);
  assert.equal(GOAL_STATE_LABEL.waiting, 'Not started yet');
  // The weeks of 3 and 10 Nov plan 6 sessions each (Mon–Sat): 10 of 12 done is 83%.
  const plan = ['str', 'z2', 'str', 'z2', 'str', 'walk'];
  const logs = [];
  for (const mon of ['2025-11-03', '2025-11-10']) plan.forEach((sid, i) => logs.push(done(addDays(mon, i), sid)));
  const d = baseData({ workouts: logs.slice(0, 10) });
  const adh = evaluateGoals({ data: d, program: PROGRAM, today: TODAY }).find((x) => x.goal.id === 'adherence');
  assert.equal(adh.state, 'met');
  assert.match(adh.headline, /83% of planned sessions done/);
  assert.match(adh.detail, /10 of 12 planned sessions/);
  const fewer = evaluateGoals({ data: baseData({ workouts: logs.slice(0, 9) }), program: PROGRAM, today: TODAY }).find((x) => x.goal.id === 'adherence');
  assert.equal(fewer.state, 'behind', '75% is under 80%');
  const deload = evaluateGoals({ data: baseData(), program: withOverrides([{ week: 3, label: 'Deload', deload: true }]), today: TODAY }).find((x) => x.goal.id === 'zone2');
  assert.equal(deload.state, 'hold');
  assert.match(deload.detail, /Deload week/);
  const lp = evaluateGoals({ data: baseData(), program: PROGRAM, today: TODAY }).find((x) => x.goal.id === 'leg-press');
  assert.match(lp.headline, /\+30%/, 'chapter 01: +30% on the Re-entry Week calibration set');
  assert.match(lp.detail, /by the end of Phase 1/);
});

test('zone 2: no note on rest days, and a shortfall only from Thursday (BT3-14/15, BT1-10)', () => {
  const sun = zone2Status(baseData(), Z2PROG, { asOf: '2025-11-23', today: '2025-11-23' });
  assert.equal(sun.hidden, true, 'Sunday is a rest day');
  const wed = zone2Status(baseData(), Z2PROG, { asOf: '2025-11-19', today: '2025-11-19' });
  assert.equal(wed.push, false);
  assert.equal(wed.hidden, true, 'Wednesday: the gap is still easy to close');
  const thu = zone2Status(baseData(), Z2PROG, { asOf: '2025-11-20', today: '2025-11-20' });
  assert.equal(thu.push, true);
  assert.equal(!!thu.hidden, false);
  const d = baseData({ checkins: days('2025-11-17', 7, () => ({ sleep_h: 7 })) });
  const notes = coachInsights({ data: d, program: Z2PROG, today: '2025-11-23' });
  assert.equal(notes.some((x) => x.id === 'zone2'), false, 'hidden notes never show');
  const week = zone2Week(Z2PROG, d, '2025-11-17', { today: '2025-11-23' });
  assert.equal(week.planned, 160, 'one source: the week’s planned minutes');
});

test('recording Light use names everything it unlocks, the good-arm sessions included (BT2-5)', () => {
  const prog = { ...PROGRAM, addons: [{ id: 'crossed', name: 'Good-arm sessions', gate: 'good_arm_ok', until_gate: null, phases: ['p1'], days: ['tue'], session: 'z2' }, ...PROGRAM.addons] };
  const lib = [...EXERCISES, { id: 'ga-cable-row', name: 'Cable row', category: 'pull', gate: 'good_arm_ok', regressions: [], progressions: [], equipment: [] }];
  withContent({ program: prog, exercises: lib }, () => {
    const u = unlockSummary('clinic_light', TODAY, {}, prog, lib);
    assert.equal(u.goodArm, true);
    assert.deepEqual(u.gates, ['good_arm_ok', 'clinic_light']);
    assert.equal(u.exercises, 4);
    assert.ok(u.addons.some((a) => /^Good-arm sessions in Foundation$/.test(a.text)), u.addons.map((a) => a.text).join(' | '));
    assert.ok(u.addons.some((a) => /joins your plan once you enter your physio’s exercises/.test(a.text)), 'rehab waits for the physio');
    assert.match(goodArmWarning('clinic_light', TODAY, {}), /other-arm weights and the good-arm sessions/);
    assert.doesNotMatch(goodArmWarning('clinic_light', TODAY, {}), /\b(left|right)\b/, 'no side: the injured arm can be either');
    assert.match(goodArmWarning('clinic_light', TODAY, {}), /chapter 18/);
    assert.equal(goodArmWarning('clinic_light', TODAY, { good_arm_ok: '2025-11-02' }), null, 'already recorded');
    assert.equal(goodArmWarning('good_arm_ok', TODAY, {}), null);
  });
});

test('clearance dates: never before the injury once its date is set; old or future dates are read back with a warning (BT2-12)', () => {
  const injury = '2025-09-15';
  assert.equal(injuryDateOf({ injury_date: injury }), injury);
  assert.deepEqual([injuryDateOf({}), injuryDateOf({ injury_date: 'rubbish' }), injuryDateOf(null)], [null, null, null], 'optional: unset means no lower limit');
  assert.equal(dateCheck('2025-09-14', TODAY, injury).invalid, true);
  assert.match(dateCheck('2025-09-14', TODAY, injury).warn, /before your injury on Mon 15 Sep 2025, so it can’t be right/);
  assert.equal(dateCheck('2025-09-15', TODAY, injury).invalid, false, 'the injury day itself is allowed');
  assert.deepEqual([dateCheck('2025-09-14', TODAY).invalid, dateCheck('2025-09-14', TODAY, null).invalid], [false, false], 'no injury date: nothing to compare with');
  assert.match(dateCheck('2025-09-14', TODAY).warn, /more than two weeks ago/);
  assert.match(dateCheck('2025-11-02', TODAY, injury).warn, /more than two weeks ago/);
  assert.match(dateCheck('2025-11-26', TODAY, injury).warn, /in the future/);
  assert.equal(dateCheck('2025-11-20', TODAY, injury).warn, null);
  assert.equal(dateCheck(TODAY, TODAY).read, 'Saturday 22 November 2025 (today)');
  assert.match(dateCheck('2025-11-20', TODAY).read, /\(2 days ago\)/);
  assert.equal(checkUKDate('02/09/2025', { min: injury, minError: 'Before your injury.' }).error, 'Before your injury.');
  assert.equal(beforeInjuryError(injury), 'That’s before your injury on Mon 15 Sep 2025. Enter the day your clinic told you.');
  assert.equal(beforeInjuryError(null), null);
});

test('raw gate ids in guide text render as labels; experienced-lifter wording (SPEC 1)', () => {
  const { html } = renderMarkdown('# T\n\nFrom `clinic_light` until full_clearance, then `none` [see](https://x.org/grip_cleared).');
  assert.match(html, /Light use \/ rehab started/);
  assert.match(html, /Full clearance/);
  assert.match(html, />Now</);
  assert.doesNotMatch(html.replace(/href="[^"]*"/g, ''), /clinic_light|full_clearance/);
  assert.ok(html.includes('href="https://x.org/grip_cleared"'), 'links are never rewritten');
  assert.match(START_TEXT, /could do for 15/);
  assert.doesNotMatch(START_TEXT, /first time|learn/i);
  const r = progressionFor({ reps: '8-12', lastSets: [], increment: 10 });
  assert.doesNotMatch(r.text, /^First time|Learn it light/);
});

test('weekend routes: program_week wins over week_start, relative to your start date', () => {
  const hikes = { weekend_plan: [{ program_week: 1, week_start: '2025-11-24', name: 'A', minutes: 40, level: 1 }, { program_week: 2, week_start: '2025-12-01', name: 'B', minutes: 45, level: 1 }] };
  assert.equal(weekendPlanFor(hikes, '2025-12-06', { start: '2025-12-01' }).name, 'A', 'you started a week late');
  assert.equal(weekendPlanFor(hikes, '2025-12-13', { start: '2025-12-01' }).name, 'B');
  assert.equal(weekendDate({ program_week: 2 }, '2025-12-01'), '2025-12-13');
  assert.equal(weekendDate({ week_start: '2025-11-24' }, null), '2025-11-29');
});

// ================================================================ round 4 final fixes: the gym floor, one-handed

import { selectOnFocus, focusQuietly } from '../public/js/dom.js';
import { carriedKg, rirFloor } from '../public/js/features/sets.js';
import { swapMode, performedCount, standInEntry, SWAP_TICKED_TEXT } from '../public/js/features/swap.js';
import { scaleRows, painReadBack, crossesRed } from '../public/js/components.js';
import { confirmArmPain } from '../public/js/views/checkin.js';
import { singleFlight, setBusy } from '../public/js/features/busy.js';
import { wakeLockKeeper } from '../public/js/features/rest.js';
import { restFromDose } from '../public/js/features/rx.js';
import { shownSaveState, bootFailure, keptChanges, recoveryCount } from '../public/js/app.js';
import { importOutcome } from '../public/js/views/settings.js';

/** A text box that behaves like a browser's for focus, selection and typing (no DOM in Node). */
class FakeInput {
  constructor(value) { this.value = value; this.type = 'text'; this.selectionStart = value.length; this.selectionEnd = value.length; this.on = {}; }
  addEventListener(t, fn) { (this.on[t] ||= []).push(fn); }
  fire(t) { const ev = { prevented: false, preventDefault() { this.prevented = true; } }; for (const fn of this.on[t] || []) fn(ev); return ev; }
  focus() { this.fire('focus'); }
  setSelectionRange(a, b) { this.selectionStart = a; this.selectionEnd = b; }
  select() { this.setSelectionRange(0, this.value.length); }
  /** One key: replaces the selection (what a keyboard does). */
  press(ch) {
    this.fire('keydown');
    this.value = this.value.slice(0, this.selectionStart) + ch + this.value.slice(this.selectionEnd);
    this.selectionStart = this.selectionEnd = this.selectionStart + ch.length;
    this.fire('input');
  }
}

test('finding 4: tapping a prefilled number selects it all, so typing replaces it ("12", 11 -> 11)', () => {
  const later = [];
  const box = selectOnFocus(new FakeInput('12'), { later: (fn) => later.push(fn) });
  box.fire('focus');
  assert.deepEqual([box.selectionStart, box.selectionEnd], [0, 2], 'selected on focus');
  box.setSelectionRange(1, 1); // a touch browser drops the caret where the finger was, after focus
  later.forEach((fn) => fn());
  assert.deepEqual([box.selectionStart, box.selectionEnd], [0, 2], 'selected again once the tap is over');
  assert.equal(box.fire('mouseup').prevented, true, 'the focusing tap keeps the selection');
  box.press('1');
  box.press('1');
  assert.equal(box.value, '11', 'never "1112"');
  assert.equal(box.fire('mouseup').prevented, false, 'a later tap places the caret as usual');
  box.setSelectionRange(1, 1);
  later.length = 0;
  box.fire('focus');
  box.press('0');
  later.forEach((fn) => fn());
  assert.equal(box.value, '0', 'typing straight after focus replaces too');
  // Focus put back after a re-render never selects a half-typed value.
  const typed = selectOnFocus(new FakeInput('6'), { later: (fn) => fn() });
  typed.setSelectionRange(1, 1);
  focusQuietly(typed);
  assert.deepEqual([typed.selectionStart, typed.selectionEnd], [1, 1]);
});

test('finding 5: prefill per set from last time, within the planned RIR (60×12, 70×10, 80×10 at RIR 2)', () => {
  const last = [[60, 12], [70, 10], [80, 10]].map(([kg, reps]) => ({ kg, reps, rir: 2, done: true }));
  const sugg = progressionFor({ reps: '8-12', lastSets: last, increment: 10, setsPlanned: 3 });
  assert.equal(sugg.kind, 'add-reps');
  const pairs = (opts) => setTargets({ reps: '8-12', count: 3, lastSets: last, suggestion: sugg, ...opts }).map((t) => [t.kg, t.reps]);
  // Today RIR 2–3: those sets had no reps to spare, so the same sets.
  assert.deepEqual(pairs({ rir: '2-3' }), [[60, 12], [70, 10], [80, 10]]);
  // Today RIR 1–2 (the leg press): one rep to spare, so +1 where below the top.
  assert.deepEqual(pairs({ rir: '1-2' }), [[60, 12], [70, 11], [80, 11]]);
  for (const t of [pairs({ rir: '2-3' }), pairs({ rir: '1-2' }), pairs({})]) {
    assert.deepEqual(t[0], [60, 12], 'set 1 comes from set 1, never the top load');
    assert.ok(t.every(([kg, reps]) => !(kg === 80 && reps >= 12)), 'never 80 × 12 (RIR 0 on the top set)');
  }
  // Hold (deload, RIR 3–4): the same load per set and never more reps than last time.
  const hold = { kind: 'hold', reason: 'deload', kg: 80, reps: 8 };
  const held = setTargets({ reps: '8-12', count: 3, lastSets: last, suggestion: hold, rir: '3-4' }).map((t) => [t.kg, t.reps]);
  assert.deepEqual(held, [[60, 11], [70, 9], [80, 9]], 'one rep fewer: RIR 3 asked, RIR 2 last time');
  held.forEach(([, reps], i) => assert.ok(reps <= last[i].reps));
  assert.deepEqual(setTargets({ reps: '8-12', count: 3, lastSets: last.map(({ rir, ...s }) => s), suggestion: hold }).map((t) => [t.kg, t.reps]), [[60, 12], [70, 10], [80, 10]], 'no RIR known: exactly last time');
  // A top set taken to RIR 0 is never prefilled with more reps.
  const failed = [{ kg: 80, reps: 10, rir: 0, done: true }];
  assert.ok(setTargets({ reps: '8-12', count: 1, lastSets: failed, suggestion: { kind: 'add-reps', kg: 80 }, rir: '1-2' })[0].reps <= 10);
  // Last time's planned RIR stands in when the set's RIR wasn't logged.
  assert.equal(setTargets({ reps: '8-12', count: 1, lastSets: [{ kg: 80, reps: 10, done: true }], suggestion: { kind: 'add-reps', kg: 80 }, rir: '2-3', lastRir: '2-3' })[0].reps, 10);
  assert.equal(setTargets({ reps: '8-12', count: 1, lastSets: [{ kg: 80, reps: 10, done: true }], suggestion: { kind: 'add-reps', kg: 80 }, rir: '2-3', lastRir: '3-4' })[0].reps, 11, 'more reserve last time: add a rep');
  // Add load keeps a ramp's shape: each set's own load plus the step, back to the bottom of the range.
  const top = [[60, 12], [70, 12], [80, 12]].map(([kg, reps]) => ({ kg, reps, done: true }));
  const up = progressionFor({ reps: '8-12', lastSets: top, increment: 10, setsPlanned: 3 });
  assert.equal(up.kind, 'add-load');
  assert.deepEqual(setTargets({ reps: '8-12', count: 3, lastSets: top, suggestion: up }).map((t) => [t.kg, t.reps]), [[70, 8], [80, 8], [90, 8]]);
  // Unticked or placeholder rows last time never set a target.
  assert.deepEqual(setTargets({ reps: '8-12', count: 2, lastSets: [{ kg: 60, reps: 12, done: true }, { kg: 90, reps: null, done: false }], suggestion: null }).map((t) => [t.kg, t.reps]), [[60, 12], [60, 12]]);
  // A ticked set's kg carries into the rows below: straight sets take it, a ramp keeps its shape.
  assert.equal(carriedKg(60, 60, 62.5), 62.5);
  assert.equal(carriedKg(80, 70, 70), 80, 'ticked as planned: the ramp is untouched');
  assert.equal(carriedKg(80, 70, 72.5), 82.5);
  assert.equal(carriedKg(null, null, 40), 40, 'no target yet: the ticked kg');
  assert.equal(rirFloor('1-2'), 1);
  assert.equal(rirFloor('3–4'), 3);
  assert.equal(rirFloor(''), null);
});

test('finding 6: a block with ticked sets is never relabelled; the stand-in starts fresh as an extra', () => {
  const ticked = { block: 'leg-press:1', exercise: 'leg-press', sets: [{ kg: 60, reps: 12, done: true }, { kg: 60, reps: null, done: false }] };
  assert.equal(performedCount(ticked), 1);
  assert.equal(swapMode(ticked, 'box-squat-bw'), 'extra');
  const before = JSON.stringify(ticked);
  applySwap(ticked, 'leg-press', 'box-squat-bw');
  assert.equal(JSON.stringify(ticked), before, 'the performed set stays on the leg press');
  const fresh = standInEntry('box-squat-bw', { key: 'xabc', sets: 3 });
  assert.deepEqual([fresh.block, fresh.extra, fresh.exercise, fresh.sets.length], ['xabc', true, 'box-squat-bw', 3]);
  assert.ok(fresh.sets.every((s) => s.done === false && s.kg === null && s.reps === null), 'starts fresh');
  assert.equal(SWAP_TICKED_TEXT, 'Untick your sets or log the swap as an extra exercise');
  // Nothing ticked yet: the whole block swaps, as before.
  const untouched = { block: 'leg-press:1', exercise: 'leg-press', sets: [{ kg: 60, reps: 12, done: false }] };
  assert.equal(swapMode(untouched, 'box-squat-bw'), 'swap');
  applySwap(untouched, 'leg-press', 'box-squat-bw');
  assert.equal(untouched.exercise, 'box-squat-bw');
  // Going "back to the plan" can't relabel the stand-in's ticked sets either.
  const swapped = { block: 'leg-press:1', exercise: 'box-squat-bw', swapped_from: 'leg-press', sets: [{ reps: 10, done: true }] };
  applySwap(swapped, 'leg-press', 'leg-press');
  assert.equal(swapped.exercise, 'box-squat-bw');
  // Cardio: logged minutes belong to the machine they were done on.
  assert.equal(swapMode({ exercise: 'bike-upright', minutes: 10 }, 'stair-climber'), 'extra');
  assert.equal(swapMode({ exercise: 'bike-upright', minutes: null }, 'stair-climber'), 'swap');
  assert.equal(standInEntry('stair-climber', { key: 'xc', cardio: true }).minutes, null);
  assert.equal(swapMode(ticked, 'leg-press'), 'none');
});

test('finding 8: 0–10 scales wrap 0–5 / 6–10, read back their meaning, and confirm crossing RED', async () => {
  const range = (a, b) => Array.from({ length: b - a + 1 }, (_, i) => a + i);
  assert.deepEqual(scaleRows(range(0, 10)), [range(0, 5), range(6, 10)]);
  assert.deepEqual(scaleRows(range(1, 10)), [range(1, 5), range(6, 10)]);
  assert.deepEqual(scaleRows(range(1, 5)), [range(1, 5)], 'five options stay on one row');
  // Two rows of at most 6 buttons fit a 360 px phone at 44 px or more with 6 px gaps.
  const width = 360 - 2 * 16;
  assert.ok((width - 5 * 6) / 6 >= 44);
  assert.deepEqual(painReadBack(7), { level: 'red', text: '7/10 = RED: no training today' });
  assert.deepEqual(painReadBack(4), { level: 'amber', text: '4/10 = AMBER: easy day' });
  assert.equal(painReadBack(3), null);
  assert.equal(painReadBack(null), null);
  assert.deepEqual(painReadBack(7, { kind: 'soreness' }), { level: 'amber', text: '7/10 = AMBER: easy day' });
  assert.equal(painReadBack(6, { kind: 'soreness' }), null);
  assert.equal(crossesRed(7, 6), true);
  assert.equal(crossesRed(7, null), true);
  assert.equal(crossesRed(3, 8), true, 'leaving RED is confirmed too');
  assert.equal(crossesRed(null, 8), true, 'so is clearing a RED score');
  assert.equal(crossesRed(8, 7), false);
  assert.equal(crossesRed(5, 2), false);
  assert.equal(await confirmArmPain(5, 2), true, 'no dialog when the RED line isn’t crossed');
  assert.equal(await confirmArmPain(9, 7), true);
});

test('finding 9: Save session runs once at a time, is busy meanwhile, and toasts once', async () => {
  let calls = 0;
  const toasts = [];
  const states = [];
  let release;
  const gate = new Promise((r) => { release = r; });
  const save = singleFlight(async () => { calls++; await gate; toasts.push('Session saved'); return 'ok'; }, { onBusy: (on) => states.push(on) });
  const first = save();
  assert.equal(save(), null, 'a second tap while saving is ignored');
  assert.equal(save(), null);
  assert.equal(save.busy(), true);
  release();
  assert.equal(await first, 'ok');
  assert.equal(calls, 1);
  assert.deepEqual(toasts, ['Session saved'], 'one toast only');
  assert.deepEqual(states, [true, false]);
  assert.equal(save.busy(), false);
  assert.notEqual(save(), null, 'once settled, the next save can run');
  // A failing save still frees the button.
  const broken = singleFlight(async () => { throw new Error('no'); });
  await assert.rejects(broken());
  assert.equal(broken.busy(), false);
  // The button: disabled, aria-busy and "Saving…" while busy; its label comes back after.
  const attrs = {};
  const cls = new Set();
  const btn = { textContent: 'Save session', disabled: false, dataset: {}, setAttribute: (k, v) => { attrs[k] = v; }, removeAttribute: (k) => { delete attrs[k]; }, classList: { add: (c) => cls.add(c), remove: (c) => cls.delete(c) } };
  setBusy(btn, true, 'Saving…');
  assert.deepEqual([btn.disabled, attrs['aria-busy'], btn.textContent, cls.has('is-busy')], [true, 'true', 'Saving…', true]);
  btn.dataset.idleLabel = 'Save changes'; // the logger renames it once a session is saved
  setBusy(btn, false);
  assert.deepEqual([btn.disabled, 'aria-busy' in attrs, btn.textContent, cls.has('is-busy')], [false, false, 'Save changes', false]);
});

test('finding 1: the rest dock keeps the screen awake, lets go when rest ends, and asks again when visible', async () => {
  const made = [];
  const nav = { wakeLock: { request: async (type) => {
    const s = { type, released: false, on: {}, addEventListener(t, fn) { this.on[t] = fn; }, release() { this.released = true; this.on.release?.(); return Promise.resolve(); } };
    made.push(s);
    return s;
  } } };
  const doc = { visibilityState: 'visible' };
  const k = wakeLockKeeper({ nav, doc });
  await k.keep();
  assert.equal(k.held, true);
  assert.equal(made[0].type, 'screen');
  made[0].release(); // the browser drops it while the tab is hidden
  doc.visibilityState = 'hidden';
  await k.visible();
  assert.equal(made.length, 1, 'nothing is asked for while hidden');
  doc.visibilityState = 'visible';
  await k.visible();
  assert.equal(k.held, true, 're-acquired on visibilitychange');
  assert.equal(made.length, 2);
  k.letGo();
  assert.equal(k.held, false);
  assert.equal(made[1].released, true, 'released when the rest ends or is skipped');
  await k.visible();
  assert.equal(made.length, 2, 'not asked again once the rest is over');
  // Ended while the request was still out: the late lock is released at once.
  const slow = { wakeLock: { request: () => new Promise((r) => setTimeout(() => r(made[made.push({ released: false, release() { this.released = true; return Promise.resolve(); } }) - 1]), 5)) } };
  const k2 = wakeLockKeeper({ nav: slow, doc });
  const asked = k2.keep();
  k2.letGo();
  await asked;
  assert.equal(made[made.length - 1].released, true);
  // Unsupported or refused: silent.
  await assert.doesNotReject(async () => { await wakeLockKeeper({ nav: {}, doc }).keep(); });
  const refused = wakeLockKeeper({ nav: { wakeLock: { request: () => Promise.reject(new Error('NotAllowedError')) } }, doc });
  await assert.doesNotReject(async () => { await refused.keep(); });
  assert.equal(refused.held, false);
});

test('finding 11: an easy-day swap to a timed hold has its own rest and no RIR chip', () => {
  const lib = new Map(RXLIB.map((e) => [e.id, e]));
  const wall = prescriptionFor('wall-sit', lib);
  assert.equal(wall.rest_s, 60, 'its own dose: 60 s rest');
  const easy = effectiveRx(wall, { easyDay: true });
  assert.equal(easy.rir, null, 'a timed hold gets no hold RIR');
  assert.equal(easy.sets, 2);
  assert.equal(effectiveRx(prescriptionFor('ga-cable-row', lib), { easyDay: true }).rir, '3-4', 'strength work still holds at RIR 3–4');
  assert.equal(effectiveRx(prescriptionFor('ga-cable-row', lib), { override: { deload: true } }).rir, '3-4', 'and on a deload week');
  assert.equal(restFromDose('rest 60–90 s'), 60);
  assert.equal(restFromDose('3 × 20–40 s, 45–60 s rest'), 45);
  assert.equal(restFromDose('2 min rest'), 120);
  assert.equal(restFromDose('3–5 × 3 jumps, full rest'), null);
});

test('findings 2, 13, 15, 16: offline state, import wording, kept-change count, boot failures', () => {
  // 2: "Offline" when the browser says so or a save got no answer; other errors keep retrying.
  assert.equal(shownSaveState('error', { error: { status: 0 } }), 'offline');
  assert.equal(shownSaveState('error', { error: { status: 0, timeout: true } }), 'offline');
  assert.equal(shownSaveState('error', { error: { status: 500 } }), 'error');
  assert.equal(shownSaveState('dirty', null, { online: false }), 'offline');
  assert.equal(shownSaveState('saved', null, { online: false }), 'offline-idle');
  assert.equal(shownSaveState('saving', null), 'saving');
  assert.equal(shownSaveState('saved', null, { outdated: true }), 'outdated');
  assert.equal(shownSaveState('build-mismatch', null), 'outdated');
  // 13: "imported" only once the hub has it.
  assert.match(importOutcome('saved').text, /imported/);
  for (const st of ['error', 'dirty', 'conflict', 'build-mismatch']) {
    const o = importOutcome(st);
    assert.equal(o.done, false);
    assert.doesNotMatch(o.text, /imported/i, st);
    assert.match(o.text, /^Not saved yet/);
  }
  assert.match(importOutcome('error').text, /^Not saved yet: retrying/);
  // 15: the store gives a number.
  assert.equal(recoveryCount({ changes: 3 }), 3);
  assert.equal(recoveryCount({ changes: [{}, {}] }), 2);
  assert.equal(recoveryCount({ changes: 0 }), 0);
  assert.equal(recoveryCount(null), 0);
  // 16: a damaged data file is not "can't reach the hub".
  assert.equal(bootFailure({ status: 500, message: 'data/data.json is not valid JSON. Restore a file from data/backups (see README).' }), 'damaged');
  assert.equal(bootFailure({ status: 502, message: 'The hub sent data that is not valid JSON.' }), 'damaged');
  assert.equal(bootFailure({ status: 0, message: 'Can’t reach the hub. Is it running?' }), 'offline');
  assert.equal(bootFailure({ status: 0, timeout: true }), 'offline');
  assert.equal(bootFailure({ status: 403, message: 'Forbidden' }), 'error');
  // 12: what the offline screen says is kept: read only, never changed.
  const store = new Map([['fitness-hub:pending:tab1.load1', JSON.stringify({ v: 2, changes: [{}, {}, {}] })], ['fitness-hub:pending', '{"at":"x","data":{}}'], ['fitness-hub:theme', 'dark'], ['fitness-hub:pending:tab2.load2', 'not json']]);
  const ls = { get length() { return store.size; }, key: (i) => [...store.keys()][i], getItem: (k) => store.get(k) ?? null };
  const snapshot = JSON.stringify([...store]);
  assert.deepEqual(keptChanges(ls), { changes: 3, copies: 2, legacy: true });
  assert.equal(JSON.stringify([...store]), snapshot, 'nothing in localStorage is touched');
  assert.deepEqual(keptChanges(null), { changes: 0, copies: 0, legacy: false });
});
