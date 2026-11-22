// Logic tests for the Fitness Hub. Run: node --test tests/  (or: node tests/test_logic.mjs)
import test from 'node:test';
import assert from 'node:assert/strict';

import { addDays, mondayOf, weekdayIndex, fmtDay, fmtRange, isISODate, todayISO } from '../public/js/dates.js';
import {
  buildTimeline, positionOn, plannedOn, isGateMet, gateClearedOn, highestGate, adjustSets, cardioMinutes,
  resolveBlock, resolveSession, weekOverride, parseRepRange, incrementFor, suggestProgression, gateRank,
  addonActive, capZone,
} from '../public/js/schedule.js';
import { blockTarget, fmtSecs } from '../public/js/views/shared.js';
import {
  readiness, bmrMifflin, tdee, targetKcal, proteinTargets, hrMax, hrZones, zoneRange, mafHr, e1rm, ageFrom,
  rollingMean, weeklyChange, vitaminDSeason,
} from '../public/js/calc.js';
import { renderMarkdown, escapeHtml, markdownSections } from '../public/js/markdown.js';
import { makeCtx, weekSummary, zone2Minutes, streak, ladderStatus, exerciseHistory, lastPerformance } from '../public/js/stats.js';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  toDayNum, fromDayNum, daysBetween, mondayOnOrAfter, isLeapYear, daysInMonth, dateOfTimestamp, weeksBetween, weekDates,
} from '../public/js/dates.js';
import { blockKind, defaultStart } from '../public/js/schedule.js';
import { readinessHistory, rhrReference, armFlagsOf, mean, trailingMean } from '../public/js/calc.js';
import {
  dayInfo, hikeTotals, checkinIssues, workoutIssues, hikeIssues, dataIssues, suggestTypoFix, csvCell, toCSV, checkinsCSV,
  workoutsCSV, hikesCSV, exportCSV, weightChange,
} from '../public/js/stats.js';
import {
  SCHEMA_VERSION, migrate, normalize, defaultData, validateImport, validateImportDetailed, diffData, mergeData, applyChanges,
  patchInPlace, deepEqual, hashValue, recordKeys, ensureIds, createStore, cloneJSON, describePath, coerceDate, MIGRATIONS,
} from '../public/js/store.js';
import { apiGetDataWithEtag, apiPutData, apiGetData, HttpError, KEEPALIVE_MAX_BYTES } from '../public/js/api.js';
import { content, loadContent, validateProgram, contentProblems } from '../public/js/content.js';
import { stepSegments } from '../public/js/timers.js';

const PROGRAM = {
  version: 1,
  default_start_date: '2025-11-24',
  phases: [
    {
      id: 'p1', name: 'Phase 1 — Foundation', short: 'Foundation', entry_gate: 'none', weeks: 8, repeat_from_week: 3,
      week_template: { mon: 'str-a', tue: 'engine', wed: 'str-b', thu: 'engine', fri: 'str-a', sat: 'hike', sun: 'rest' },
      week_overrides: [
        { week: 1, label: 'Intro', sets_max: 2, rir: '3-4', cardio_scale: 0.7 },
        { week: 5, label: 'Deload', deload: true },
      ],
      weekly_targets: { zone2_min: 120, strength_sessions: 3, steps_avg: 7000, long_session_min: 60 },
    },
    { id: 'p2', name: 'Phase 2 — Good arm', entry_gate: 'good_arm_ok', weeks: 6, repeat_from_week: null, week_template: { mon: 'str-a', sun: 'rest' } },
    { id: 'p3', name: 'Phase 3 — Grip', entry_gate: 'grip_cleared', weeks: 4, repeat_from_week: 2, week_template: { mon: 'str-b' } },
  ],
  addons: [
    { id: 'rehab', name: 'Physio rehab', gate: 'clinic_light', until_gate: 'full_clearance', days: ['mon', 'wed', 'fri'], session: 'rehab' },
  ],
  sessions: {
    'str-a': { name: 'Strength A', type: 'strength', blocks: [
      { exercise: 'leg-press', sets: 3, reps: '8-12', rest_s: 120, rir: '2-3', load: 'double-progression' },
      { exercise: 'wall-sit', sets: 4, seconds: 45, rest_s: 60 },
      { exercise: 'stair-climber', minutes: 20, zone: 'Z2' },
      { exercise: 'incline-walk', minutes: 30, zone: 'Z2', minutes_by_week: [10, 13, 16] },
    ] },
    'str-b': { name: 'Strength B', type: 'strength', blocks: [] },
    engine: { name: 'Engine', type: 'cardio', blocks: [{ exercise: 'bike-upright', warmup_min: 10, cooldown_min: 10, intervals: { work_s: 30, rest_s: 90, rounds: 6, work_zone: 'Z5', rest_zone: 'Z1' } }] },
    hike: { name: 'Long hike', type: 'hike', blocks: [] },
    rehab: { name: 'Rehab', type: 'rehab', blocks: [] },
    rest: { name: 'Rest', type: 'rest', blocks: [] },
  },
  rules: { increments_kg: { 'leg-press': 10, machine: 2.5, dumbbell: 2, barbell: 2.5, default: 2.5 } },
};

const profile = (clearances = {}, extra = {}) => ({
  program_start: '2025-11-24',
  clearances: { good_arm_ok: null, clinic_light: null, grip_cleared: null, full_clearance: null, ...clearances },
  ...extra,
});

// ---------------------------------------------------------------- dates
test('dates: weekday maths and UK formatting', () => {
  assert.equal(weekdayIndex('2025-11-24'), 0); // Monday
  assert.equal(weekdayIndex('2025-11-30'), 6); // Sunday
  assert.equal(mondayOf('2025-11-27'), '2025-11-24');
  assert.equal(addDays('2025-03-29', 2), '2025-03-31'); // across the UK clock change
  assert.equal(fmtDay('2025-11-24', { today: '2025-11-22' }), 'Mon 24 Nov');
  assert.equal(fmtDay('2025-12-02', { today: '2025-11-22' }), 'Tue 2 Dec');
  assert.equal(fmtDay('2026-01-05', { today: '2025-11-22' }), 'Mon 5 Jan 2026');
  assert.equal(fmtRange('2025-11-24', '2026-01-18'), '24 Nov 2025 – 18 Jan 2026');
  assert.ok(isISODate(todayISO()));
  assert.equal(isISODate('2026-02-30'), false);
});

// ---------------------------------------------------------------- gates
test('gates are cumulative and dated', () => {
  const c = { grip_cleared: '2026-02-02' };
  assert.equal(isGateMet('none', c, '2019-01-02'), true);
  assert.equal(isGateMet('good_arm_ok', c, '2026-02-01'), false);
  assert.equal(isGateMet('good_arm_ok', c, '2026-02-02'), true, 'a higher gate implies the lower ones');
  assert.equal(isGateMet('clinic_light', c, '2026-02-02'), true);
  assert.equal(isGateMet('full_clearance', c, '2026-06-02'), false);
  assert.equal(gateClearedOn('good_arm_ok', { good_arm_ok: '2026-03-02', grip_cleared: '2026-02-02' }), '2026-02-02');
  assert.equal(highestGate(c, '2026-02-03'), 'grip_cleared');
  assert.equal(gateRank('made-up-gate'), 4, 'unknown gates are treated as most restrictive');
});

// ---------------------------------------------------------------- phases
test('phase timeline: no clearances -> phase 1 runs, later phases wait', () => {
  const tl = buildTimeline(PROGRAM, profile());
  assert.equal(tl.start, '2025-11-24');
  assert.equal(tl.phases[0].start, '2025-11-24');
  assert.equal(tl.phases[0].plannedEnd, '2026-01-19');
  assert.equal(tl.phases[1].start, null);
  assert.equal(tl.phases[1].waitingGate, 'good_arm_ok');
  assert.equal(tl.phases[2].start, null);
  assert.equal(tl.phases[2].blockedByPrev, true);
});

test('phase position and looping via repeat_from_week', () => {
  const tl = buildTimeline(PROGRAM, profile());
  assert.equal(positionOn(tl, '2025-11-23'), null, 'before the start');
  let p = positionOn(tl, '2025-11-24');
  assert.deepEqual([p.phaseId, p.week, p.dayKey, p.isRepeat], ['p1', 1, 'mon', false]);
  p = positionOn(tl, '2026-01-18'); // last day of week 8
  assert.deepEqual([p.week, p.isRepeat], [8, false]);
  p = positionOn(tl, '2026-01-19'); // gate not met: loop weeks 3..8
  assert.deepEqual([p.phaseId, p.absWeek, p.week, p.isRepeat, p.cycle], ['p1', 9, 3, true, 1]);
  p = positionOn(tl, '2026-02-23'); // abs week 14 -> loop index 6 -> week 8
  assert.deepEqual([p.absWeek, p.week, p.cycle], [14, 8, 1]);
  p = positionOn(tl, '2026-03-02'); // abs week 15 -> second cycle starts at week 3
  assert.deepEqual([p.absWeek, p.week, p.cycle], [15, 3, 2]);
});

test('gate met early: next phase starts after the planned end', () => {
  const tl = buildTimeline(PROGRAM, profile({ good_arm_ok: '2025-12-02' }));
  assert.equal(tl.phases[1].start, '2026-01-19');
  assert.equal(positionOn(tl, '2026-01-19').phaseId, 'p2');
  assert.equal(positionOn(tl, '2026-01-18').phaseId, 'p1');
});

test('gate met late: phase 1 loops until the Monday on/after the gate date', () => {
  const tl = buildTimeline(PROGRAM, profile({ good_arm_ok: '2026-02-04' })); // a Wednesday
  assert.equal(tl.phases[1].start, '2026-02-09');
  assert.equal(tl.phases[0].actualEnd, '2026-02-09');
  const p = positionOn(tl, '2026-02-02'); // abs week 11 of p1 -> week 5 (looping 3..8)
  assert.deepEqual([p.phaseId, p.week, p.isRepeat], ['p1', 5, true]);
  assert.equal(positionOn(tl, '2026-02-09').phaseId, 'p2');
  assert.equal(positionOn(tl, '2026-02-09').week, 1);
});

test('repeat_from_week null repeats the final week; later phase chains', () => {
  const tl = buildTimeline(PROGRAM, profile({ good_arm_ok: '2025-12-02' }));
  // p2: 2026-01-19 + 6 weeks = 2026-03-02 planned end; no grip gate -> week 6 repeats
  let p = positionOn(tl, '2026-03-02');
  assert.deepEqual([p.phaseId, p.week, p.isRepeat], ['p2', 6, true]);
  p = positionOn(tl, '2026-04-06');
  assert.deepEqual([p.phaseId, p.week], ['p2', 6]);
  const tl2 = buildTimeline(PROGRAM, profile({ good_arm_ok: '2025-12-02', grip_cleared: '2026-02-11' }));
  assert.equal(tl2.phases[2].start, '2026-03-02', 'p3 waits for p2 planned end');
});

test('program start snaps to the Monday of its week', () => {
  const tl = buildTimeline(PROGRAM, profile({}, { program_start: '2025-11-26' }));
  assert.equal(tl.start, '2025-11-24');
});

// ---------------------------------------------------------------- add-ons
test('add-ons follow gate, until_gate and days', () => {
  const before = plannedOn(PROGRAM, profile(), '2025-12-01');
  assert.equal(before.sessions.filter((s) => s.source === 'addon').length, 0);
  const c = { clinic_light: '2025-12-02' };
  const mon = plannedOn(PROGRAM, profile(c), '2025-12-08');
  assert.deepEqual(mon.sessions.map((s) => s.sessionId), ['str-a', 'rehab']);
  const tue = plannedOn(PROGRAM, profile(c), '2025-12-09');
  assert.deepEqual(tue.sessions.map((s) => s.sessionId), ['engine']);
  const ended = plannedOn(PROGRAM, profile({ ...c, full_clearance: '2026-05-02' }), '2026-05-04');
  assert.equal(ended.sessions.some((s) => s.sessionId === 'rehab'), false);
  const preProgram = plannedOn(PROGRAM, profile({ clinic_light: '2025-11-02' }), '2025-11-17');
  assert.equal(preProgram.pos, null);
  assert.deepEqual(preProgram.sessions.map((s) => s.sessionId), ['rehab']);
  const sun = plannedOn(PROGRAM, profile(), '2025-11-30');
  assert.equal(sun.sessions[0].isRest, true);
});

// ---------------------------------------------------------------- overrides
test('week overrides: sets_max, rir, cardio_scale, minutes_by_week, deload', () => {
  const plan = plannedOn(PROGRAM, profile(), '2025-11-24');
  assert.equal(plan.override.label, 'Intro');
  const blocks = resolveSession(PROGRAM.sessions['str-a'], { week: plan.pos.week, override: plan.override });
  assert.equal(blocks[0].kind, 'strength');
  assert.equal(blocks[0].sets, 2, 'sets_max caps 3 -> 2');
  assert.equal(blocks[0].rir, '3-4');
  assert.equal(blocks[1].kind, 'timed');
  assert.equal(blocks[1].sets, 2);
  assert.equal(blocks[2].minutes, 14, 'cardio_scale 0.7 x 20');
  assert.equal(blocks[3].minutes, 10, 'minutes_by_week is explicit and wins');
  const w5 = plannedOn(PROGRAM, profile(), '2025-12-22');
  assert.equal(w5.pos.week, 5);
  assert.equal(w5.override.deload, true);
  const d = resolveSession(PROGRAM.sessions['str-a'], { week: 5, override: w5.override });
  assert.equal(d[0].sets, 2, 'deload halves 3 -> 2 (rounded up)');
  assert.equal(d[1].sets, 2, 'deload halves 4 -> 2');
  assert.equal(d[3].minutes, 16, 'minutes_by_week reuses the last value');
  assert.equal(adjustSets(1, { deload: true }), 1);
  assert.equal(adjustSets(4, null, true), 2, 'amber easy day halves sets');
  assert.equal(adjustSets(4, { deload: true }, true), 2, 'deload and easy day do not stack');
  assert.equal(cardioMinutes({ minutes: 30 }, 2, null), 30);
  assert.equal(weekOverride(PROGRAM.phases[0], 2), null);
  const iv = resolveBlock(PROGRAM.sessions.engine.blocks[0], { easyDay: true });
  assert.equal(iv.kind, 'intervals');
  assert.equal(iv.easyReplaced, true);
  assert.equal(iv.intervals.rounds, 6);
});

test('looping weeks reuse that week\'s override (deload repeats)', () => {
  const tl = buildTimeline(PROGRAM, profile());
  const p = positionOn(tl, '2026-02-02'); // looped week 5
  assert.equal(p.week, 5);
  assert.equal(weekOverride(p.phase, p.week).deload, true);
});

// ---------------------------------------------------------------- progression
test('double progression suggestions', () => {
  assert.deepEqual(parseRepRange('8-12'), { min: 8, max: 12 });
  assert.deepEqual(parseRepRange('8–12 / side'), { min: 8, max: 12 });
  assert.deepEqual(parseRepRange('5'), { min: 5, max: 5 });
  assert.equal(parseRepRange('AMRAP'), null);
  const inc = incrementFor('leg-press', { equipment: ['leg press machine'] }, PROGRAM.rules);
  assert.equal(inc, 10);
  assert.equal(incrementFor('ga-db-curl-seated', { equipment: ['dumbbell'] }, PROGRAM.rules), 2);
  assert.equal(incrementFor('hamstring-curl', { equipment: ['hamstring curl machine'] }, PROGRAM.rules), 2.5);
  const up = suggestProgression({ reps: '8-12', lastSets: [{ kg: 40, reps: 12, done: true }, { kg: 40, reps: 12, done: true }], increment: 10 });
  assert.equal(up.kind, 'add-load');
  assert.equal(up.kg, 50);
  assert.equal(up.reps, 8);
  const hold = suggestProgression({ reps: '8-12', lastSets: [{ kg: 40, reps: 12 }, { kg: 40, reps: 11 }], increment: 10 });
  assert.equal(hold.kind, 'add-reps');
  assert.equal(hold.kg, 40);
  assert.equal(suggestProgression({ reps: '8-12', lastSets: [], increment: 10 }).kind, 'start');
  assert.equal(suggestProgression({ reps: '8-12', lastSets: [{ reps: 12 }, { reps: 13 }], increment: 2.5, progressionName: 'Split squat' }).kind, 'progress');
});

// ---------------------------------------------------------------- readiness
test('readiness rules (SPEC 5.8)', () => {
  const hist = ['2025-11-15', '2025-11-16', '2025-11-17', '2025-11-18', '2025-11-19', '2025-11-20', '2025-11-21']
    .map((date) => ({ date, rhr: 60 }));
  const base = { date: '2025-11-22', arm_flags: [], rhr: 60, sleep_h: 7.5, energy: 4, soreness: 3, arm_pain: 1 };
  assert.equal(readiness(null).level, 'unknown');
  assert.equal(readiness(base, hist).level, 'green');
  assert.equal(readiness({ ...base, arm_flags: ['swelling_new'] }, hist).level, 'red');
  assert.equal(readiness({ ...base, rhr: 65 }, hist).level, 'amber', 'RHR >= avg + 5');
  assert.equal(readiness({ ...base, rhr: 64 }, hist).level, 'green', 'RHR avg + 4 is fine');
  assert.equal(readiness({ ...base, sleep_h: 5.9 }, hist).level, 'amber');
  assert.equal(readiness({ ...base, sleep_h: 6 }, hist).level, 'green');
  assert.equal(readiness({ ...base, arm_pain: 4 }, hist).level, 'amber');
  assert.equal(readiness({ ...base, soreness: 7 }, hist).level, 'amber');
  assert.equal(readiness({ ...base, energy: 2 }, hist).level, 'amber');
  assert.equal(readiness({ ...base, energy: 3 }, hist).level, 'green');
  const few = hist.slice(-2);
  assert.equal(readiness({ ...base, rhr: 70 }, few).level, 'green', 'needs 3 readings for an average');
  assert.equal(readiness({ ...base, rhr: 70 }, few, { rhr_baseline: 60 }).level, 'amber', 'falls back to the baseline');
  const multi = readiness({ ...base, sleep_h: 5, energy: 1 }, hist);
  assert.equal(multi.reasons.length, 2);
});

// ---------------------------------------------------------------- energy & HR
test('BMR (Mifflin-St Jeor), TDEE, target kcal and protein', () => {
  assert.equal(bmrMifflin({ sex: 'male', weightKg: 80, heightCm: 180, age: 30 }), 1780);
  assert.equal(bmrMifflin({ sex: 'female', weightKg: 80, heightCm: 180, age: 30 }), 1614);
  assert.equal(bmrMifflin({ sex: null, weightKg: 80, heightCm: 180, age: 30 }), null);
  assert.equal(bmrMifflin({ sex: 'male', weightKg: null, heightCm: 180, age: 30 }), null);
  assert.equal(Math.round(tdee(1780, 1.55)), 2759);
  assert.equal(Math.round(targetKcal(tdee(1780, 1.55), 300)), 3059);
  const p = proteinTargets(80, 1.8);
  assert.equal(Math.round(p.target), 144);
  assert.equal(Math.round(p.low), 128);
  assert.equal(Math.round(p.high), 176);
  assert.equal(vitaminDSeason('2025-11-22'), true);
  assert.equal(vitaminDSeason('2025-06-02'), false);
});

test('HRmax (Tanaka), zones and MAF', () => {
  assert.equal(ageFrom(1995, '2025-11-22'), 30);
  assert.equal(hrMax(30), 187);
  assert.equal(hrMax(30, 195), 195, 'override wins');
  const z = hrZones(187);
  assert.equal(z.length, 5);
  assert.deepEqual([z[1].id, z[1].loBpm, z[1].hiBpm], ['Z2', 112, 131]);
  assert.deepEqual([z[4].loBpm, z[4].hiBpm], [168, 187]);
  assert.deepEqual(zoneRange('Z2-Z3', 187), { lo: 112, hi: 150 });
  assert.equal(mafHr(30), 150);
});

test('e1RM (Epley) and averages', () => {
  assert.equal(Math.round(e1rm(100, 5) * 100) / 100, 116.67);
  assert.equal(e1rm(0, 5), null);
  assert.equal(e1rm(50, null), null);
  const pts = [{ date: '2025-11-02', value: 70 }, { date: '2025-11-03', value: 72 }, { date: '2025-11-10', value: 74 }];
  const r = rollingMean(pts);
  assert.equal(r[1].value, 71);
  assert.equal(r[2].value, 74, 'only the last 7 days count');
  assert.equal(weeklyChange(pts, '2025-11-10'), 74 - 71);
});

// ---------------------------------------------------------------- stats
test('week summary, Zone 2 minutes and streak', () => {
  const data = {
    checkins: [{ date: '2025-11-24', weight_kg: 75, protein_g: 140, steps: 8000 }, { date: '2025-11-25', protein_g: 120, steps: 6000 }],
    workouts: [
      { id: 'a', date: '2025-11-24', session_id: 'str-a', status: 'done', exercises: [{ exercise: 'leg-press', sets: [{ kg: 40, reps: 12, done: true }] }], cardio: [{ exercise: 'stair-climber', minutes: 14, zone: 'Z2' }] },
      { id: 'b', date: '2025-11-25', session_id: 'engine', status: 'done', cardio: [{ exercise: 'bike-upright', minutes: 20, zone: 'Z1-Z2' }, { exercise: 'bike-upright', minutes: 6, zone: 'Z5' }] },
      { id: 'c', date: '2025-11-26', session_id: 'str-b', status: 'draft', exercises: [] },
    ],
    hikes: [{ id: 'h', date: '2025-11-29', distance_km: 8, ascent_m: 150, duration_min: 120, pack_kg: 0 }],
  };
  assert.equal(zone2Minutes(data, '2025-11-24', '2025-11-30'), 14 + 20 + 120);
  const ctx = makeCtx({ program: PROGRAM, profile: profile(), data, today: '2025-11-26' });
  const s = weekSummary(ctx, '2025-11-24');
  assert.equal(s.strengthDone, 1);
  assert.equal(s.strengthTarget, 3);
  assert.equal(s.z2Target, 120);
  assert.equal(s.mainPlanned, 6);
  assert.equal(s.mainDoneToDate, 2);
  assert.equal(s.mainPlannedToDate, 3);
  assert.equal(s.proteinTarget, 135);
  assert.equal(s.proteinDays, 1);
  assert.equal(s.stepsAvg, 7000);
  assert.equal(streak(ctx), 2, 'Mon + Tue done; Wed (today, draft only) does not break it');
  const ctx2 = makeCtx({ program: PROGRAM, profile: profile(), data, today: '2025-11-28' });
  assert.equal(streak(ctx2), 0, 'Wed missed breaks the streak');
  assert.equal(exerciseHistory(data, 'leg-press')[0].bestE1rm, 40 * (1 + 12 / 30));
  assert.equal(lastPerformance(data, 'leg-press', '2025-12-01').workoutId, 'a');
  const ladder = [{ level: 1, gate: 'none', criteria: { distance_km: 8, ascent_m: 150, pack_kg: 0 } }, { level: 2, gate: 'clinic_light', criteria: { distance_km: 5 } }];
  const ls = ladderStatus(ladder, data, {});
  assert.equal(ls[0].done, true);
  assert.equal(ls[1].done, false, 'gate not met on the hike date');
});

// ---------------------------------------------------------------- review update (21 Nov)
test('min_weeks lets the next phase start early once its gate is met', () => {
  const prog = JSON.parse(JSON.stringify(PROGRAM));
  prog.phases[0].min_weeks = 6; // p1: 8 weeks, may hand over after 6
  // Gate cleared before the program starts: p2 starts at p1 start + 6 weeks.
  let tl = buildTimeline(prog, profile({ good_arm_ok: '2025-11-02' }));
  assert.equal(tl.phases[0].minWeeks, 6);
  assert.equal(tl.phases[1].start, '2026-01-05');
  assert.equal(tl.phases[0].actualEnd, '2026-01-05');
  assert.equal(tl.phases[0].plannedEnd, '2026-01-19', 'planned end is still the full 8 weeks');
  // Gate cleared mid-phase, after min_weeks: next Monday after the gate date (before the planned end).
  tl = buildTimeline(prog, profile({ good_arm_ok: '2026-01-07' }));
  assert.equal(tl.phases[1].start, '2026-01-12');
  // Gate after the planned end: looping still applies until the Monday after the gate.
  tl = buildTimeline(prog, profile({ good_arm_ok: '2026-02-04' }));
  assert.equal(tl.phases[1].start, '2026-02-09');
  assert.equal(positionOn(tl, '2026-02-02').week, 5, 'p1 loops weeks 3..8 meanwhile');
  // Absent min_weeks = weeks (original rule).
  tl = buildTimeline(PROGRAM, profile({ good_arm_ok: '2025-11-02' }));
  assert.equal(tl.phases[1].start, '2026-01-19');
  // Out-of-range values are clamped to 1..weeks.
  prog.phases[0].min_weeks = 99;
  assert.equal(buildTimeline(prog, profile({ good_arm_ok: '2025-11-02' })).phases[1].start, '2026-01-19');
});

test('add-on phases[] limits an add-on to those phases; until_gate may be null', () => {
  const prog = JSON.parse(JSON.stringify(PROGRAM));
  prog.addons = [{ id: 'p2-only', name: 'P2 extra', gate: 'none', until_gate: null, days: ['mon'], phases: ['p2'], session: 'rehab' }];
  const cl = { good_arm_ok: '2025-12-02' };
  assert.equal(plannedOn(prog, profile(cl), '2025-12-01').sessions.some((s) => s.source === 'addon'), false, 'not in p1');
  assert.equal(plannedOn(prog, profile(cl), '2026-01-19').sessions.some((s) => s.source === 'addon'), true, 'in p2');
  assert.equal(plannedOn(prog, profile(cl), '2025-11-17').sessions.some((s) => s.source === 'addon'), false, 'not before the program');
  assert.equal(addonActive(prog.addons[0], cl, '2029-01-02', 'p2'), true, 'null until_gate never ends');
  assert.equal(addonActive({ gate: 'none', until_gate: null, session: 'x' }, {}, '2029-01-02', null), true, 'no phases[] = any phase');
});

test('deload weeks make intervals easy: rounds halved (round up), work zone capped at Z3', () => {
  const iv = PROGRAM.sessions.engine.blocks[0];
  const d = resolveBlock(iv, { week: 5, override: { week: 5, label: 'Deload', deload: true } });
  assert.equal(d.deload, true);
  assert.equal(d.intervals.rounds, 3);
  assert.equal(d.roundsPlanned, 6);
  assert.equal(d.intervals.work_zone, 'Z3');
  const odd = resolveBlock({ exercise: 'bike-upright', intervals: { work_s: 240, rest_s: 240, rounds: 5, work_zone: 'Z4', rest_zone: 'Z1' } }, { override: { deload: true } });
  assert.equal(odd.intervals.rounds, 3);
  assert.equal(odd.intervals.work_zone, 'Z3');
  assert.equal(resolveBlock(iv, { week: 2, override: null }).intervals.rounds, 6, 'normal weeks untouched');
  assert.equal(capZone('Z4-Z5'), 'Z3');
  assert.equal(capZone('Z2-Z3'), 'Z2-Z3');
  assert.equal(capZone('Z3 - Z4'), 'Z3');
  assert.equal(capZone('Z1'), 'Z1');
});

test('physio programme block and long holds read in minutes', () => {
  const rb = resolveBlock({ exercise: 'x-physio-programme', sets: 1, seconds: 900, load: 'physio' }, {});
  assert.equal(rb.kind, 'timed');
  assert.equal(blockTarget(rb), '15 min, as your physio prescribed');
  assert.equal(fmtSecs(45), '45 s');
  assert.equal(fmtSecs(150), '2 min 30 s');
  assert.equal(blockTarget(resolveBlock({ exercise: 'wall-sit', sets: 2, seconds: 45, per_side: true }, {})), '2 × 45 s / side');
  assert.equal(suggestProgression({ reps: '8-12', lastSets: [{ kg: 40, reps: 12 }], increment: 10 }).kind, 'add-load', 'the view gates this on load === "double-progression"');
});

// ---------------------------------------------------------------- markdown
test('markdown renderer escapes HTML and only allows safe links', () => {
  const src = [
    '# Title <script>alert(1)</script>',
    '',
    'Text with <img src=x onerror=alert(1)> and **bold** and *italic* and `co<de>`.',
    '[bad](javascript:alert(1)) [ok](https://example.org/a?b=1&c=2) [chapter](08-building-muscle.md) [quoted](https://x.org/"onmouseover="alert(1))',
    '',
    '> [!SAFETY]',
    '> Stop if it hurts.',
    '> - point one',
    '',
    '| A | B |',
    '|---|:-:|',
    '| 1 | <b>2</b> |',
    '',
    '- top',
    '  - nested',
    '- [ ] task item',
    '',
    '```',
    '<div>literal</div>',
    '```',
    '',
    '**[Strong evidence]** claim.',
  ].join('\n');
  const { html, title, headings } = renderMarkdown(src, { file: '03-training-principles.md' });
  assert.equal(title, 'Title <script>alert(1)</script>');
  assert.ok(!/<script/i.test(html), 'no raw script tag');
  assert.ok(!/<img/i.test(html), 'no raw img tag');
  assert.ok(!/<b>/.test(html), 'no raw HTML from table cells');
  assert.ok(!/<div>/.test(html), 'code fences stay escaped');
  assert.ok(!/href="javascript/i.test(html), 'javascript: links are dropped');
  assert.ok(!/onmouseover="/i.test(html), 'quotes cannot break out of href');
  assert.ok(html.includes('href="https://example.org/a?b=1&amp;c=2" target="_blank" rel="noopener noreferrer"'));
  assert.ok(html.includes('href="#/guide/08-building-muscle.md"'));
  assert.ok(html.includes('<strong>bold</strong>') && html.includes('<em>italic</em>'));
  assert.ok(html.includes('<code>co&lt;de&gt;</code>'));
  assert.ok(html.includes('callout-safety'));
  assert.ok(/<ul[^>]*><li>top<ul><li>nested<\/li><\/ul><\/li>/.test(html), 'one level of nesting');
  assert.ok(html.includes('class="task-check"'));
  assert.ok(html.includes('class="al-c"'));
  assert.ok(html.includes('evidence ev-strong'));
  assert.equal(headings[0].id, 'title-script-alert-1-script');
  assert.equal(escapeHtml('<a href="x">'), '&lt;a href=&quot;x&quot;&gt;');
  const secs = markdownSections('# T\n\nIntro\n\n## Part one\nBody **text**\n\n## Part one\nMore');
  assert.deepEqual(secs.map((s) => s.id), ['t', 'part-one', 'part-one-2']);
  assert.equal(secs[1].text, 'Body text');
});

// =====================================================================================
// Review round 2: data integrity and correctness (dates, schedule, formulas, stats, store)
// =====================================================================================

const HUB = fileURLToPath(new URL('..', import.meta.url));
function seeded(seed = 1) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6D2B79F5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------- dates
test('dates: BST/GMT changes never shift a local date (Europe/London)', () => {
  const saved = process.env.TZ;
  process.env.TZ = 'Europe/London';
  try {
    // Spring forward: 01:00 GMT 30 Mar 2025 -> 02:00 BST.
    assert.equal(todayISO(new Date(Date.UTC(2025, 2, 29, 23, 30))), '2025-03-29', '23:30 GMT Saturday');
    assert.equal(todayISO(new Date(Date.UTC(2025, 2, 30, 0, 30))), '2025-03-30', '00:30 GMT Sunday');
    assert.equal(todayISO(new Date(Date.UTC(2025, 2, 30, 23, 30))), '2025-03-31', '00:30 BST Monday is already Monday');
    // Fall back: 02:00 BST 26 Oct 2025 -> 01:00 GMT.
    assert.equal(todayISO(new Date(Date.UTC(2025, 9, 25, 23, 30))), '2025-10-26', '00:30 BST Sunday');
    assert.equal(todayISO(new Date(Date.UTC(2025, 9, 26, 23, 30))), '2025-10-26', '23:30 GMT Sunday');
    assert.equal(dateOfTimestamp('2025-07-01T23:30:00Z'), '2025-07-02', 'a late UTC timestamp is the next local day in summer');
    assert.equal(dateOfTimestamp('2026-01-01T23:30:00Z'), '2026-01-01', 'in winter UK time is UTC');
    assert.equal(dateOfTimestamp(''), null);
    assert.equal(dateOfTimestamp('not a date'), null);
  } finally {
    if (saved === undefined) delete process.env.TZ; else process.env.TZ = saved;
  }
  // Day arithmetic is pure calendar maths: exactly one day per day across either change.
  assert.equal(daysBetween('2025-03-29', '2025-03-31'), 2);
  assert.equal(daysBetween('2025-10-25', '2025-10-27'), 2);
  assert.equal(addDays('2025-10-26', 1), '2025-10-27');
  assert.equal(mondayOf('2025-03-30'), '2025-03-24', 'the clock-change Sunday belongs to the week before');
  assert.equal(mondayOf('2025-10-26'), '2025-10-20');
});

test('dates: Monday week starts, leap years and odd years', () => {
  for (const d of weekDates('2025-11-24')) assert.equal(mondayOf(d), '2025-11-24');
  assert.deepEqual(weekDates('2025-11-24'), ['2025-11-24', '2025-11-25', '2025-11-26', '2025-11-27', '2025-11-28', '2025-11-29', '2025-11-30']);
  assert.equal(mondayOf('2025-11-30'), '2025-11-24', 'Sunday is the last day of the week');
  assert.equal(mondayOnOrAfter('2025-11-24'), '2025-11-24');
  assert.equal(mondayOnOrAfter('2025-11-25'), '2025-12-01');
  assert.equal(mondayOnOrAfter('2025-11-30'), '2025-12-01');
  assert.equal(weeksBetween('2025-11-24', '2025-12-07'), 1);
  assert.equal(weeksBetween('2025-11-30', '2025-12-01'), 1);
  assert.equal(isLeapYear(2028), true);
  assert.equal(isLeapYear(2100), false);
  assert.equal(isLeapYear(2000), true);
  assert.equal(daysInMonth(2028, 2), 29);
  assert.equal(daysInMonth(2027, 2), 28);
  assert.equal(isISODate('2028-02-29'), true);
  assert.equal(isISODate('2027-02-29'), false);
  assert.equal(isISODate('2100-02-29'), false);
  assert.equal(isISODate('1900-02-29'), false);
  assert.equal(isISODate('2026-13-01'), false);
  assert.equal(isISODate('2026-11-3'), false);
  assert.equal(addDays('2028-02-28', 1), '2028-02-29');
  assert.equal(addDays('2028-02-29', 1), '2028-03-01');
  assert.equal(addDays('2027-02-28', 1), '2027-03-01');
  assert.equal(daysBetween('2028-02-01', '2028-03-01'), 29);
  assert.equal(addDays('2026-12-31', 1), '2027-01-01');
  assert.equal(weekdayIndex('2028-02-29'), 1, 'a Tuesday');
  assert.equal(fromDayNum(toDayNum('0050-03-01')), '0050-03-01', 'years below 100 stay literal');
  assert.equal(toDayNum('1970-01-01'), 0);
  for (let n = toDayNum('0000-01-01'); n < 200000; n += 9973) assert.equal(toDayNum(fromDayNum(n)), n);
});

// ---------------------------------------------------------------- schedule: a program shaped like the real one
const blk = {
  str: { exercise: 'leg-press', sets: 3, reps: '8-12', load: 'double-progression' },
  iv: { exercise: 'bike-upright', warmup_min: 8, cooldown_min: 6, intervals: { work_s: 240, rest_s: 180, rounds: 5, work_zone: 'Z4-Z5', rest_zone: 'Z1' } },
};
const ses = (type, blocks = [blk.str]) => ({ name: type, type, blocks });
const REAL_LIKE = {
  default_start_date: '2025-11-24',
  phases: [
    { id: 'p0', entry_gate: 'none', weeks: 1, repeat_from_week: null, week_template: { mon: 'a', tue: 'z2', wed: 'a', thu: 'z2', fri: 'a', sat: 'walk', sun: 'rest' }, week_overrides: [{ week: 1, sets_max: 2 }] },
    { id: 'p1', entry_gate: 'none', weeks: 8, min_weeks: 4, repeat_from_week: 3, week_template: { mon: 'a', tue: 'z2', wed: 'a', thu: 'iv', fri: 'a', sat: 'walk', sun: 'rest' }, week_overrides: [{ week: 1, sets_max: 2 }, { week: 5, label: 'Deload', deload: true }] },
    { id: 'p2a', entry_gate: 'grip_cleared', weeks: 2, repeat_from_week: null, week_template: { mon: 'a', thu: 'iv' }, week_overrides: [{ week: 1, sets_max: 2 }] },
    { id: 'p2', entry_gate: 'grip_cleared', weeks: 6, repeat_from_week: 2, week_template: { mon: 'a', thu: 'iv' }, week_overrides: [{ week: 4, deload: true }] },
    { id: 'p3', entry_gate: 'grip_cleared', weeks: 12, repeat_from_week: 5, week_template: { mon: 'a', thu: 'iv' }, week_overrides: [{ week: 4, deload: true }, { week: 12, deload: true }] },
    { id: 'p4a', entry_gate: 'full_clearance', weeks: 4, repeat_from_week: null, week_template: { mon: 'a' } },
    { id: 'p4', entry_gate: 'full_clearance', weeks: 16, repeat_from_week: 6, week_template: { mon: 'rest', tue: 'a' } },
    { id: 'p5', entry_gate: 'full_clearance', weeks: 10, repeat_from_week: 1, week_template: { tue: 'a', thu: 'iv' }, week_overrides: [{ week: 9, label: 'Taper', deload: true }, { week: 10, label: 'Mission week', deload: true }] },
  ],
  addons: [
    { id: 'crossed', gate: 'good_arm_ok', until_gate: null, phases: ['p0', 'p1'], days: ['mon', 'wed', 'fri'], session: 'crossed' },
    { id: 'rehab', gate: 'clinic_light', until_gate: 'full_clearance', days: ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'], session: 'rehab' },
  ],
  sessions: { a: ses('strength'), z2: ses('cardio', [{ exercise: 'incline-walk', minutes: 30, zone: 'Z2-Z3' }]), iv: ses('intervals', [blk.iv]), walk: ses('hike'), rest: ses('rest', []), crossed: ses('strength'), rehab: ses('rehab') },
};
const prof = (clearances = {}, start = '2025-11-24') => profile(clearances, { program_start: start });
const starts = (tl) => Object.fromEntries(tl.phases.map((p) => [p.id, p.start]));

test('schedule: p0 -> p1 and looping while no gate is set; past and far-future dates', () => {
  const tl = buildTimeline(REAL_LIKE, prof());
  assert.deepEqual(starts(tl), { p0: '2025-11-24', p1: '2025-12-01', p2a: null, p2: null, p3: null, p4a: null, p4: null, p5: null });
  assert.equal(tl.phases[2].waitingGate, 'grip_cleared');
  assert.equal(tl.phases[3].blockedByPrev, true);
  assert.equal(positionOn(tl, '2025-11-23'), null, 'the day before the start');
  assert.equal(positionOn(tl, '2019-01-02'), null, 'long before the start');
  assert.equal(positionOn(tl, 'garbage'), null);
  assert.deepEqual([positionOn(tl, '2025-11-30').phaseId, positionOn(tl, '2025-11-30').week], ['p0', 1]);
  assert.deepEqual([positionOn(tl, '2026-01-25').phaseId, positionOn(tl, '2026-01-25').week], ['p1', 8]);
  let p = positionOn(tl, '2026-01-26'); // p1 abs week 9: loop 3..8
  assert.deepEqual([p.phaseId, p.absWeek, p.week, p.isRepeat, p.cycle], ['p1', 9, 3, true, 1]);
  p = positionOn(tl, '2029-06-04'); // years later, still looping correctly
  const abs = Math.floor(daysBetween('2025-12-01', '2029-06-04') / 7) + 1;
  assert.equal(p.absWeek, abs);
  assert.equal(p.week, 3 + ((abs - 8 - 1) % 6));
  assert.equal(plannedOn(REAL_LIKE, prof(), '2025-11-23').sessions.length, 0, 'nothing is planned before the start');
});

test('schedule: grip gate set mid-phase, min_weeks, then p2a -> p2 -> p3 chain and p4a waiting', () => {
  const tl = buildTimeline(REAL_LIKE, prof({ grip_cleared: '2026-01-07' })); // a Wednesday in p1 week 6
  assert.deepEqual(starts(tl), { p0: '2025-11-24', p1: '2025-12-01', p2a: '2026-01-12', p2: '2026-01-26', p3: '2026-03-09', p4a: null, p4: null, p5: null });
  assert.equal(tl.phases[1].actualEnd, '2026-01-12', 'p1 hands over before its planned end');
  assert.equal(tl.phases[1].plannedEnd, '2026-01-26');
  assert.equal(positionOn(tl, '2026-01-11').phaseId, 'p1');
  assert.deepEqual([positionOn(tl, '2026-01-12').phaseId, positionOn(tl, '2026-01-12').week], ['p2a', 1]);
  assert.equal(plannedOn(REAL_LIKE, prof({ grip_cleared: '2026-01-07' }), '2026-01-12').override.sets_max, 2);
  // p3 runs 12 weeks, then loops 5..12 while full clearance has no date.
  const q = positionOn(tl, addDays('2026-03-09', 12 * 7));
  assert.deepEqual([q.phaseId, q.week, q.isRepeat], ['p3', 5, true]);
  // Gate before p1's min_weeks: min_weeks wins (p1 start + 4 weeks).
  assert.equal(buildTimeline(REAL_LIKE, prof({ grip_cleared: '2025-12-02' })).phases[2].start, '2025-12-29');
  // A gate dated before the program starts behaves the same.
  assert.equal(buildTimeline(REAL_LIKE, prof({ grip_cleared: '2025-01-02' })).phases[2].start, '2025-12-29');
});

test('schedule: clearing, moving and implying gates recomputes everything (no stale state)', () => {
  const set = prof({ grip_cleared: '2026-01-07' });
  assert.equal(buildTimeline(REAL_LIKE, set).phases[2].start, '2026-01-12');
  set.clearances.grip_cleared = null; // cleared again (entered by mistake)
  let tl = buildTimeline(REAL_LIKE, set);
  assert.equal(tl.phases[2].start, null);
  assert.deepEqual([positionOn(tl, '2026-01-12').phaseId, positionOn(tl, '2026-01-12').week], ['p1', 7]);
  set.clearances.grip_cleared = '2026-02-18'; // moved later (a Wednesday)
  tl = buildTimeline(REAL_LIKE, set);
  assert.equal(tl.phases[2].start, '2026-02-23');
  assert.deepEqual([positionOn(tl, '2026-02-22').phaseId, positionOn(tl, '2026-02-22').isRepeat], ['p1', true]);
  set.clearances.grip_cleared = 'not-a-date'; // garbage counts as not cleared (fail safe)
  assert.equal(buildTimeline(REAL_LIKE, set).phases[2].start, null);
  // Only full clearance set: it implies grip_cleared on the same date (cumulative gates).
  tl = buildTimeline(REAL_LIKE, prof({ full_clearance: '2026-01-07' }));
  assert.deepEqual(starts(tl), { p0: '2025-11-24', p1: '2025-12-01', p2a: '2026-01-12', p2: '2026-01-26', p3: '2026-03-09', p4a: '2026-06-01', p4: '2026-06-29', p5: '2026-10-19' });
  // Final phase loops from week 1 (repeat_from_week 1) forever.
  const fin = positionOn(tl, addDays('2026-10-19', 10 * 7));
  assert.deepEqual([fin.phaseId, fin.week, fin.isRepeat, fin.cycle], ['p5', 1, true, 1]);
  // Full clearance after p3's planned end: p3 loops, p4a starts the Monday on/after the gate.
  tl = buildTimeline(REAL_LIKE, prof({ grip_cleared: '2026-01-07', full_clearance: '2026-07-02' }));
  assert.equal(tl.phases[5].start, '2026-07-06');
});

test('schedule: changing the program start shifts the whole plan; non-Mondays snap back', () => {
  const a = buildTimeline(REAL_LIKE, prof({}, '2025-12-15'));
  assert.deepEqual([a.phases[0].start, a.phases[1].start], ['2025-12-15', '2025-12-22']);
  const b = buildTimeline(REAL_LIKE, prof({ grip_cleared: '2026-01-07' }, '2025-12-15'));
  assert.equal(b.phases[2].start, '2026-01-19', 'min_weeks now ends later than the gate');
  assert.equal(buildTimeline(REAL_LIKE, prof({}, '2025-12-18')).start, '2025-12-15', 'Thursday snaps to its Monday');
  assert.equal(buildTimeline(REAL_LIKE, prof({}, 'rubbish')).start, '2025-11-24', 'invalid start falls back to the program default');
  // No start anywhere (program.json ships default_start_date: null): the next Monday after today.
  assert.equal(buildTimeline({ ...REAL_LIKE, default_start_date: undefined }, prof({}, null), { today: '2025-11-22' }).start, '2025-11-24');
  assert.equal(buildTimeline({ ...REAL_LIKE, default_start_date: null }, prof({}, null), { today: '2025-11-24' }).start, '2025-12-01', 'on a Monday: the one a week later');
  assert.equal(buildTimeline({ ...REAL_LIKE, default_start_date: null }, prof({}, null), { today: '2025-11-30' }).start, '2025-12-01');
  assert.equal(buildTimeline({ ...REAL_LIKE, default_start_date: null }, prof({}, null)).start, defaultStart(), 'the local clock when no today is given');
  assert.deepEqual([defaultStart('2025-11-22'), defaultStart('2025-11-24'), defaultStart('2025-12-31'), defaultStart('rubbish') === defaultStart()], ['2025-11-24', '2025-12-01', '2026-01-05', true]);
  assert.equal(weekdayIndex(defaultStart()), 0, 'always a Monday');
  assert.ok(defaultStart() > todayISO(), 'always after today');
});

test('schedule: add-on phases[] and gates (crossed in p0/p1 only, rehab until full clearance)', () => {
  const c = prof({ good_arm_ok: '2025-12-02', clinic_light: '2025-12-11', grip_cleared: '2026-01-07', full_clearance: '2026-04-16' });
  const ids = (d) => plannedOn(REAL_LIKE, c, d).sessions.map((s) => s.sessionId);
  assert.deepEqual(ids('2025-11-24'), ['a'], 'Monday in p0 before good_arm_ok');
  assert.deepEqual(ids('2025-12-03'), ['a', 'crossed'], 'Wednesday in p1 with good_arm_ok');
  assert.deepEqual(ids('2025-12-12'), ['a', 'crossed', 'rehab'], 'Friday: crossed plus daily rehab');
  assert.deepEqual(ids('2025-12-13'), ['walk', 'rehab'], 'Saturday: rehab only');
  assert.deepEqual(ids('2026-01-12'), ['a', 'rehab'], 'p2a: crossed is limited to p0/p1');
  assert.deepEqual(ids('2026-04-20'), ['a'], 'p3 after full clearance: rehab has ended');
  const pre = plannedOn(REAL_LIKE, prof({ clinic_light: '2025-11-02' }), '2025-11-19');
  assert.deepEqual(pre.sessions.map((s) => s.sessionId), ['rehab'], 'an add-on without phases runs before the program once its gate is met');
});

test('schedule: deload, taper and easy days (sets, intervals, Zone 2 cap, minutes)', () => {
  const tl = buildTimeline(REAL_LIKE, prof({ full_clearance: '2026-01-07' }));
  const deload = plannedOn(REAL_LIKE, prof({ full_clearance: '2026-01-07' }), '2025-12-29', tl); // p1 week 5
  assert.deepEqual([deload.pos.phaseId, deload.pos.week, deload.override.deload], ['p1', 5, true]);
  const b = resolveSession(REAL_LIKE.sessions.a, { week: 5, override: deload.override });
  assert.equal(b[0].sets, 2, '3 sets halved, rounding up');
  const taperDay = addDays('2026-10-19', 8 * 7 + 3); // p5 week 9, Thursday
  const taper = plannedOn(REAL_LIKE, prof({ full_clearance: '2026-01-07' }), taperDay, tl);
  assert.deepEqual([taper.pos.phaseId, taper.pos.week, taper.override.label], ['p5', 9, 'Taper']);
  const iv = resolveBlock(blk.iv, { week: 9, override: taper.override });
  assert.deepEqual([iv.intervals.rounds, iv.roundsPlanned, iv.intervals.work_zone, iv.workZonePlanned], [3, 5, 'Z3', 'Z4-Z5']);
  assert.equal(iv.easyMinutes, Math.round(8 + 6 + (3 * 420) / 60));
  // Amber easy day: Zone 2 only for cardio and circuits; intervals become steady Z2 for the same time.
  const cardio = resolveBlock({ exercise: 'incline-walk', minutes: 30, zone: 'Z2-Z3' }, { easyDay: true });
  assert.deepEqual([cardio.zone, cardio.zonePlanned, cardio.easyZoneCapped], ['Z2', 'Z2-Z3', true]);
  assert.equal(resolveBlock({ exercise: 'incline-walk', minutes: 30, zone: 'Z2-Z3' }, {}).zone, 'Z2-Z3', 'normal days unchanged');
  assert.equal(resolveBlock({ exercise: 'walk-outdoor', minutes: 30, zone: 'Z1' }, { easyDay: true }).zone, 'Z1');
  assert.equal(resolveBlock({ circuit: { minutes: 12, items: [] }, zone: 'Z2-Z3' }, { easyDay: true }).zone, 'Z2');
  const easyIv = resolveBlock(blk.iv, { easyDay: true });
  assert.equal(easyIv.easyReplaced, true);
  assert.equal(easyIv.easyMinutes, Math.round(8 + 6 + (5 * 420) / 60));
  assert.equal(blockTarget(easyIv), `Easy day: ${easyIv.easyMinutes} min steady Zone 2`);
});

test('schedule: minutes_by_week bad entries never shift later weeks; cardio_scale; null minutes', () => {
  const blkM = { exercise: 'x', minutes: 30, minutes_by_week: [10, null, 16, 'abc', 20] };
  assert.deepEqual([1, 2, 3, 4, 5, 9].map((w) => cardioMinutes(blkM, w, null)), [10, 10, 16, 16, 20, 20]);
  assert.equal(cardioMinutes({ minutes: 30, minutes_by_week: [null, 12] }, 1, null), 12, 'nothing valid yet: first valid value');
  assert.equal(cardioMinutes({ minutes: 30, minutes_by_week: [null, 'x'] }, 1, { cardio_scale: 0.5 }), 15, 'no valid entries: base x scale');
  assert.equal(cardioMinutes({ minutes: 30, minutes_by_week: [] }, 3, { cardio_scale: 0.7 }), 21);
  assert.equal(cardioMinutes({ minutes: 30, minutes_by_week: [25] }, 3, { cardio_scale: 0.7 }), 25, 'minutes_by_week beats cardio_scale');
  assert.equal(cardioMinutes({ minutes: null, minutes_by_week: [] }, 1, { cardio_scale: 0.7 }), null, 'null minutes stay unknown (used to become 1)');
  assert.equal(blockKind({ minutes: null, minutes_by_week: [5] }), 'cardio');
});

test('schedule: a gated first phase waits for its gate (fail safe)', () => {
  const prog = { phases: [{ id: 'g1', entry_gate: 'good_arm_ok', weeks: 4, week_template: { mon: 'a' } }, { id: 'g2', entry_gate: 'none', weeks: 2, week_template: { mon: 'a' } }], sessions: REAL_LIKE.sessions };
  let tl = buildTimeline(prog, prof());
  assert.deepEqual([tl.phases[0].start, tl.phases[0].waitingGate, tl.phases[1].blockedByPrev], [null, 'good_arm_ok', true]);
  assert.equal(positionOn(tl, '2025-12-08'), null);
  tl = buildTimeline(prog, prof({ good_arm_ok: '2025-12-03' }));
  assert.deepEqual([tl.phases[0].start, tl.phases[1].start], ['2025-12-08', '2026-01-05']);
  tl = buildTimeline(prog, prof({ good_arm_ok: '2025-10-02' }));
  assert.equal(tl.phases[0].start, '2025-11-24', 'a gate met before the start does not delay it');
});

// ---------------------------------------------------------------- calc
test('calc: BMR/TDEE/targets for the example profile (30, 80 kg, 180 cm) and safety clamps', () => {
  const bmr = bmrMifflin({ sex: 'male', weightKg: 80, heightCm: 180, age: ageFrom(1995, '2025-11-22') });
  assert.equal(bmr, 1780, 'BMR about 1,780');
  assert.equal(bmrMifflin({ sex: 'female', weightKg: 80, heightCm: 180, age: 30 }), 1614, 'female: -161 instead of +5');
  assert.equal(Math.round(tdee(bmr, 1.55)), 2759, 'TDEE about 2,760');
  assert.equal(Math.round(targetKcal(tdee(bmr, 1.55), 300)), 3059, 'target about 3,050');
  assert.equal(Math.round(proteinTargets(80, 1.8).target * 10) / 10, 144, 'protein about 145 g');
  assert.equal(bmrMifflin({ sex: 'Male ', weightKg: 80, heightCm: 180, age: 30 }), 1780, 'case and spaces tolerated');
  assert.equal(bmrMifflin({ sex: 'male', weightKg: -70, heightCm: 180, age: 30 }), null);
  assert.equal(tdee(1700, 3), 1700 * 1.725, 'activity factor clamped to 1.725');
  assert.equal(tdee(1700, 1.1), 1700 * 1.375, 'and to 1.375');
  assert.equal(tdee(1700, 0.5), 1700 * 1.55, 'nonsense falls back to the default');
  assert.equal(targetKcal(2700, -500), 2700, 'no deficit while the bone heals (SPEC 2.6)');
  assert.equal(targetKcal(2700, null), 3000);
  assert.equal(targetKcal(2700, 5000), 3700, 'surplus capped');
  assert.equal(proteinTargets(80, 3).perKg, 2.2);
  assert.equal(proteinTargets(80, 1).perKg, 1.6);
  assert.equal(proteinTargets(0, 1.8), null);
});

test('calc: HRmax 187 and Zone 2 112-131 for the example profile (age 30); zones and MAF', () => {
  const age = ageFrom(1995, '2025-11-22');
  assert.equal(age, 30);
  const hm = hrMax(age);
  assert.equal(hm, 187, 'Tanaka: 208 - 0.7 x 30');
  const z2 = hrZones(hm).find((z) => z.id === 'Z2');
  assert.deepEqual([z2.loBpm, z2.hiBpm], [112, 131]);
  assert.deepEqual(zoneRange('z1-Z2', hm), { lo: 94, hi: 131 });
  assert.equal(zoneRange('Zone 2', hm), null);
  assert.equal(hrMax(age, 250), 187, 'implausible override ignored');
  assert.equal(hrMax(age, '199'), 199);
  assert.equal(mafHr(age), 150, '180 - age');
  assert.equal(ageFrom(2019, '2025-11-22'), null, 'under 14 is not plausible');
});

test('calc: readiness exactly per SPEC 5.8 (boundaries, float noise, malformed flags)', () => {
  const day = (date, rhr) => ({ date, rhr });
  const hist = [day('2025-11-19', 60.1), day('2025-11-20', 60.2), day('2025-11-21', 60.3)];
  assert.equal(readiness({ date: '2025-11-22', rhr: 65.2 }, hist).level, 'amber', 'exactly average + 5 despite float noise');
  assert.equal(readiness({ date: '2025-11-22', rhr: 65.19 }, hist).level, 'green');
  const week = ['2025-11-14', '2025-11-15', '2025-11-16', '2025-11-17', '2025-11-18', '2025-11-19', '2025-11-20', '2025-11-21'].map((d, i) => day(d, i === 0 ? 90 : 60));
  assert.equal(rhrReference(week, '2025-11-22').count, 7, 'the 7 days before; 8 days ago is outside');
  assert.equal(rhrReference(week, '2025-11-22').value, 60);
  assert.equal(readiness({ date: '2025-11-22', rhr: 64.9 }, week).level, 'green');
  assert.equal(readiness({ date: '2025-11-22', rhr: '65' }, week).level, 'amber', 'numbers stored as text still count');
  const ck = { date: '2025-11-22', sleep_h: 6, arm_pain: 3, soreness: 6, energy: 3 };
  assert.equal(readiness(ck).level, 'green');
  assert.equal(readiness({ ...ck, sleep_h: 5.99 }).level, 'amber');
  assert.equal(readiness({ ...ck, arm_pain: 4 }).level, 'amber');
  assert.equal(readiness({ ...ck, soreness: 7 }).level, 'amber');
  assert.equal(readiness({ ...ck, energy: 2 }).level, 'amber');
  assert.equal(readiness({ ...ck, energy: 2, arm_flags: ['fall_on_arm'] }).level, 'red', 'red beats amber');
  assert.equal(readiness({ ...ck, arm_flags: 'swelling_new' }).level, 'red', 'a flag stored as text is never ignored');
  assert.equal(readiness({ ...ck, arm_flags: ['made_up_flag'] }).level, 'red', 'unknown flag ids still count (fail safe)');
  assert.equal(readiness({ ...ck, arm_flags: ['', '  ', null] }).level, 'green', 'blank entries are not flags');
  assert.deepEqual(armFlagsOf({ arm_flags: [' swelling_new '] }), ['swelling_new']);
  assert.equal(readiness({ date: '2025-11-22' }).inputs, 0, 'an empty check-in says so');
  assert.equal(readiness(ck).inputs, 4);
  assert.equal(readiness({ ...ck, sleep_h: null, energy: '' }).inputs, 2);
});

test('calc: readinessHistory matches readiness() day by day on 600 random days with gaps', () => {
  const rnd = seeded(7);
  const checkins = [];
  for (let i = 0; i < 600; i++) {
    if (rnd() < 0.15) continue;
    checkins.push({ date: addDays('2024-01-03', i), rhr: rnd() < 0.2 ? null : 52 + Math.round(rnd() * 14), sleep_h: 5 + rnd() * 4, arm_pain: Math.floor(rnd() * 6), soreness: Math.floor(rnd() * 9), energy: 1 + Math.floor(rnd() * 5), arm_flags: rnd() < 0.02 ? ['swelling_new'] : [] });
  }
  const shuffled = checkins.slice().sort(() => rnd() - 0.5);
  const hist = readinessHistory(shuffled, { rhr_baseline: 58 });
  for (const c of checkins) {
    const a = readiness(c, checkins, { rhr_baseline: 58 });
    const b = hist.get(c.date);
    assert.equal(b.level, a.level, c.date);
    assert.deepEqual(b.reasons, a.reasons, c.date);
  }
});

test('calc: rolling averages with gaps equal the naive window; weekly change; e1RM', () => {
  const rnd = seeded(3);
  const pts = [];
  for (let i = 0; i < 400; i++) {
    if (rnd() < 0.3) continue;
    pts.push({ date: addDays('2024-03-02', i), value: 70 + rnd() * 5 });
    if (rnd() < 0.05) pts.push({ date: addDays('2024-03-02', i), value: 70 + rnd() * 5 }); // two weigh-ins one day
  }
  const fast = rollingMean(pts.slice().reverse());
  const sorted = pts.slice().sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  fast.forEach((p, i) => {
    assert.equal(p.date, sorted[i].date);
    assert.ok(Math.abs(p.value - trailingMean(sorted, p.date, 7)) < 1e-9, p.date);
  });
  assert.deepEqual(rollingMean([{ date: 'x', value: 1 }, { date: '2025-01-02', value: null }, null]), []);
  const gap = [{ date: '2025-11-02', value: 70 }, { date: '2025-11-21', value: 72 }];
  assert.equal(weeklyChange(gap, '2025-11-21'), null, 'no reading in the earlier window');
  assert.equal(weightChange({ checkins: [{ date: '2025-11-11', weight_kg: 70 }, { date: '2025-11-18', weight_kg: 70.4 }] }, '2025-11-18'), 70.4 - 70);
  assert.equal(e1rm('100', '5'), 100 * (1 + 5 / 30));
  assert.equal(e1rm(100, 0), null);
  assert.equal(e1rm(-5, 5), null);
  assert.equal(Math.round(e1rm(60, 1) * 100) / 100, 62, 'Epley as specified: kg x (1 + reps/30)');
});

// ---------------------------------------------------------------- stats
const wk = (id, date, session_id, extra = {}) => ({ id, date, session_id, status: 'done', exercises: [], cardio: [], ...extra });

test('stats: adherence (to date and whole week) and protein-target days', () => {
  const data = {
    checkins: [
      { date: '2025-11-24', weight_kg: 75, protein_g: 130 }, { date: '2025-11-25', protein_g: 125 },
      { date: '2025-11-26', protein_g: 126 }, { date: '2025-11-27', weight_kg: 70 },
    ],
    workouts: [wk('m', '2025-11-24', 'str-a'), wk('t', '2025-11-25', 'engine'), wk('th', '2025-11-27', 'engine'),
      wk('f', '2025-11-28', 'str-a', { status: 'draft' }), wk('s', '2025-11-29', 'hike')],
  };
  const ctx = makeCtx({ program: PROGRAM, profile: profile(), data, today: '2025-11-30' });
  const s = weekSummary(ctx, '2025-11-24');
  assert.deepEqual([s.mainPlanned, s.mainDone, s.adherencePct], [6, 4, 67], 'a draft does not count');
  assert.deepEqual([s.mainPlannedToDate, s.mainDoneToDate], [6, 4]);
  assert.equal(s.proteinTarget, 126, 'round(1.8 x latest weight on or before the week end)');
  assert.deepEqual([s.proteinDays, s.proteinLogged], [2, 3]);
  const mid = weekSummary(makeCtx({ program: PROGRAM, profile: profile(), data, today: '2025-11-26' }), '2025-11-24');
  assert.deepEqual([mid.mainPlannedToDate, mid.mainDoneToDate, mid.adherenceToDatePct], [3, 2, 67]);
  const two = { ...PROGRAM, phases: [{ ...PROGRAM.phases[0], week_template: { mon: ['str-a', 'engine'] } }] };
  const d = dayInfo(makeCtx({ program: two, profile: profile(), data: { workouts: [wk('x', '2025-11-24', 'str-a')] }, today: '2025-12-01' }), '2025-11-24');
  assert.deepEqual([d.main.length, d.mainDone, d.status], [2, 1, 'partial']);
});

test('stats: streaks run for years (no 400-day cap), break on a missed day, count pre-program sessions', () => {
  const start = '2025-11-24';
  const today = addDays(start, 899);
  const tpl = PROGRAM.phases[0].week_template;
  const workouts = [];
  for (let i = 0; i <= 899; i++) {
    const d = addDays(start, i);
    const sid = tpl[['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'][weekdayIndex(d)]];
    if (sid !== 'rest') workouts.push(wk(`w${i}`, d, sid));
  }
  const ctxFor = (list, t = today) => makeCtx({ program: PROGRAM, profile: profile(), data: { workouts: list }, today: t });
  assert.equal(streak(ctxFor(workouts)), 900, 'every day on plan for 900 days');
  const missed = addDays(start, 500);
  const gap = workouts.filter((w) => w.date !== missed);
  assert.equal(weekdayIndex(missed) === 6 ? 'rest' : 'planned', 'planned');
  assert.equal(streak(ctxFor(gap)), 899 - 500, 'stops at the missed planned day');
  const pre = [wk('p1', addDays(start, -1), 'adhoc'), wk('p2', addDays(start, -2), 'adhoc'), ...workouts];
  assert.equal(streak(ctxFor(pre)), 902, 'logged sessions before the start extend it');
  const notYet = workouts.filter((w) => w.date !== today);
  assert.equal(streak(ctxFor(notYet)), 899, 'today counts once done, and not being done yet does not break it');
  assert.equal(streak(ctxFor([], '2025-11-26')), 0, 'no sessions, no streak');
  assert.equal(streak({ program: PROGRAM, profile: profile(), data: { workouts }, today }), 900, 'works without a prebuilt ctx');
});

test('stats: hikeTotals never picks a hike without a distance as the longest', () => {
  assert.equal(hikeTotals({ hikes: [{ date: '2025-11-02', distance_km: null }, { date: '2025-11-03', distance_km: 5 }, { date: '2025-11-04', distance_km: 8 }] }).longest.distance_km, 8);
  assert.equal(hikeTotals({ hikes: [{ date: '2025-11-02', distance_km: null }] }).longest, null);
  assert.equal(hikeTotals({ hikes: [{ date: '2025-11-02', distance_km: null }, { date: '2025-11-03', distance_km: 0.5 }] }).longest.distance_km, 0.5);
});

// ---------------------------------------------------------------- data quality
test('data quality: weight typos and jumps, RHR, sleep, scales', () => {
  const prev = { date: '2025-11-21', weight_kg: 80.4 };
  let is = checkinIssues({ date: '2025-11-22', weight_kg: 805 }, null, { previous: prev });
  assert.equal(is.length, 1);
  assert.deepEqual([is[0].field, is[0].level, is[0].suggestion], ['weight_kg', 'warning', 80.5]);
  assert.match(is[0].message, /Did you mean 80\.5 kg/);
  is = checkinIssues({ date: '2025-11-22', weight_kg: 84.8 }, null, { previous: prev });
  assert.equal(is.length, 1);
  assert.match(is[0].message, /4\.4 kg more than your weigh-in the day before/);
  assert.equal(checkinIssues({ date: '2025-11-28', weight_kg: 83 }, null, { previous: { date: '2025-11-21', weight_kg: 80.4 } }).length, 0, '2.6 kg over 7 days is fine');
  is = checkinIssues({ date: '2025-11-22', weight_kg: 8.05 }, null, { previous: prev });
  assert.equal(is[0].suggestion, 80.5);
  const data = { checkins: [{ date: '2025-11-20', weight_kg: 80 }, prev] };
  assert.equal(checkinIssues({ date: '2025-11-22', weight_kg: 76.9 }, data)[0].field, 'weight_kg', 'previous weigh-in looked up in data');
  assert.equal(checkinIssues({ date: '2025-11-22', rhr: 25 })[0].field, 'rhr');
  assert.equal(checkinIssues({ date: '2025-11-22', rhr: 600 })[0].suggestion, 60);
  assert.equal(checkinIssues({ date: '2025-11-22', rhr: 121 }).length, 1);
  assert.equal(checkinIssues({ date: '2025-11-22', rhr: 30 }).length, 0, 'edges are inclusive');
  assert.equal(checkinIssues({ date: '2025-11-22', sleep_h: 15 })[0].field, 'sleep_h');
  assert.equal(checkinIssues({ date: '2025-11-22', sleep_h: 450 })[0].suggestion, 7.5, 'minutes typed instead of hours');
  assert.equal(checkinIssues({ date: '2025-11-22', sleep_h: 14 }).length, 0);
  const scale = checkinIssues({ date: '2025-11-22', energy: 7, arm_pain: 11, soreness: 3 });
  assert.deepEqual(scale.map((x) => [x.field, x.level]), [['energy', 'error'], ['arm_pain', 'error']]);
  assert.equal(checkinIssues(null).length, 0);
  assert.equal(suggestTypoFix(805, [30, 250]), 80.5);
  assert.equal(suggestTypoFix(80, [30, 250], 73), null, 'no fix when nothing lands near the reference');
});

test('data quality: workout loads, hikes, whole-dataset audit', () => {
  const data = {
    checkins: [{ date: '2025-11-21', weight_kg: 80.4 }, { date: '2025-11-22', weight_kg: 805 }, { date: '2025-11-23', weight_kg: 80.6 }],
    workouts: [
      wk('a', '2025-11-17', 'str-a', { exercises: [{ exercise: 'leg-press', sets: [{ kg: 40, reps: 10, done: true }] }] }),
      wk('b', '2025-11-24', 'str-a', { exercises: [{ exercise: 'leg-press', sets: [{ kg: 400, reps: 10, done: true }, { kg: 42.5, reps: 140, done: true }] }], cardio: [{ exercise: 'bike', minutes: 30, avg_hr: 300 }] }),
    ],
    hikes: [{ id: 'h', date: '2025-11-23', distance_km: 30, duration_min: 60 }, { id: 'h2', date: '2025-11-30', distance_km: 12, duration_min: 240, pack_kg: 6 }],
    arm: { logs: [{ date: '2025-11-22', values: { pain_rest: 12, wrist_flex_deg: 70, grip_injured_kg: 150 } }] },
    measurements: [{ date: '2025-11-22', waist_cm: 820 }],
  };
  const wi = workoutIssues(data.workouts[1], data);
  assert.equal(wi.find((x) => /sets\[0\]\.kg/.test(x.field)).suggestion, 40, '400 kg after 40 kg last time');
  assert.ok(wi.some((x) => /sets\[1\]\.reps/.test(x.field)), '140 reps');
  assert.ok(wi.some((x) => /cardio\[0\]\.avg_hr/.test(x.field)), 'HR 300');
  assert.match(hikeIssues(data.hikes[0])[0].message, /30 km\/h/);
  assert.equal(hikeIssues(data.hikes[1]).length, 0);
  const all = dataIssues(data);
  const fields = all.map((x) => `${x.collection}:${x.field}`);
  assert.ok(fields.includes('checkins:weight_kg'));
  assert.equal(all.filter((x) => x.collection === 'checkins').length, 1, 'the typo is not also used as the reference for the next day');
  assert.ok(fields.includes('arm.logs:values.pain_rest') && fields.includes('arm.logs:values.grip_injured_kg'));
  assert.ok(!fields.includes('arm.logs:values.wrist_flex_deg'));
  assert.ok(fields.includes('measurements:waist_cm'));
  assert.ok(fields.some((f) => f.startsWith('workouts:exercises[0].sets[0].kg')));
  assert.equal(dataIssues(data, { limit: 2 }).length, 2);
  assert.deepEqual(dataIssues({}), []);
});

// ---------------------------------------------------------------- CSV export
test('CSV: RFC 4180 quoting, spreadsheet-formula guard, BOM and CRLF', () => {
  assert.equal(csvCell('plain'), '"plain"', 'every text cell is quoted (round 4)');
  assert.equal(csvCell(''), '""');
  assert.equal(csvCell('a,b'), '"a,b"');
  assert.equal(csvCell('say "hi"'), '"say ""hi"""');
  assert.equal(csvCell('line1\nline2'), '"line1\nline2"');
  assert.equal(csvCell(' padded'), '" padded"');
  assert.equal(csvCell('=HYPERLINK("x")'), '"\'=HYPERLINK(""x"")"');
  assert.equal(csvCell('+44 7700'), `"'+44 7700"`);
  assert.equal(csvCell('-3 kg'), `"'-3 kg"`);
  assert.equal(csvCell('@SUM(A1)'), `"'@SUM(A1)"`);
  assert.equal(csvCell('  =1+1'), `"'  =1+1"`, 'a formula after leading spaces is guarded too');
  assert.equal(csvCell('\tx'), `"'\tx"`);
  assert.equal(csvCell(-3.5), '-3.5', 'real numbers are left alone');
  assert.equal(csvCell(Infinity), '');
  assert.equal(csvCell(null), '');
  assert.equal(csvCell(false), 'false');
  assert.equal(csvCell(['swelling_new', 'fever_unwell']), '"swelling_new; fever_unwell"');
  assert.equal(csvCell({ a: 1 }), '"{""a"":1}"');
  const text = toCSV([{ a: 1, b: 'x' }], [{ key: 'a' }, { key: 'b', label: 'B col' }]);
  assert.equal(text.charCodeAt(0), 0xfeff, 'UTF-8 BOM for Excel');
  assert.equal(text.slice(1), '"a","B col"\r\n1,"x"\r\n');
  assert.equal(toCSV([], [{ key: 'a' }], { bom: false, eol: '\n' }), '"a"\n');
});

test('CSV: a ";" or "," inside text never makes a new cell, in comma or semicolon locales (round 4)', () => {
  // How a spreadsheet reads one line with its locale's list separator (quotes respected).
  const read = (line, sep) => {
    const out = [];
    let cur = '';
    let quoted = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (quoted) {
        if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (c === '"') quoted = false; else cur += c;
      } else if (c === '"') quoted = true;
      else if (c === sep) { out.push(cur); cur = ''; } else cur += c;
    }
    out.push(cur);
    return out;
  };
  assert.equal(csvCell('a;=1+1'), '"a;=1+1"');
  const line = toCSV([{ n: 'a;=1+1', m: 'b,c', k: 2, f: ['x', 'y'] }], [{ key: 'n' }, { key: 'm' }, { key: 'k' }, { key: 'f' }], { bom: false, eol: '\n' }).split('\n')[1];
  assert.deepEqual(read(line, ','), ['a;=1+1', 'b,c', '2', 'x; y'], 'UK locale: four cells, exactly as logged');
  for (const sep of [',', ';']) {
    const cells = read(line, sep);
    assert.ok(cells.every((c) => !/^[=+\-@]/.test(c)), `no cell starts a formula with "${sep}" as the separator: ${JSON.stringify(cells)}`);
  }
  assert.equal(read(line, ';').length, 1, 'semicolon locale: the quoted ";" stays inside its cell');
});

test('CSV: check-ins, workouts (one row per set / cardio entry) and hikes', () => {
  const data = {
    checkins: [{ date: '2025-11-23', weight_kg: 80.6, arm_flags: ['swelling_new'], notes: 'tired, sore' }, { date: '2025-11-22', weight_kg: 80.5, arm_flags: [], creatine: true }],
    workouts: [
      wk('w1', '2025-11-24', 'str-a', { session_name: 'Strength A', exercises: [{ exercise: 'leg-press', sets: [{ kg: 40, reps: 10, done: true }, { kg: 40, reps: 9, done: false }], notes: '' }], cardio: [{ exercise: 'bike-upright', minutes: 20, zone: 'Z2' }] }),
      wk('w2', '2025-11-25', 'engine'),
      wk('w3', '2025-11-26', 'str-b', { status: 'draft', exercises: [{ exercise: 'glute-bridge', sets: [{ reps: 12 }] }] }),
    ],
    hikes: [{ id: 'h1', date: '2025-11-29', name: 'Malham Cove, "the steps"', distance_km: 10.5, ascent_m: 300 }],
  };
  const c = checkinsCSV(data).slice(1).split('\r\n');
  assert.ok(c[0].startsWith('"date","weight_kg","rhr"'));
  assert.ok(c[1].startsWith('"2025-11-22",80.5,'), 'sorted by date');
  assert.ok(c[2].includes('swelling_new') && c[2].endsWith('"tired, sore"'));
  const w = workoutsCSV(data, { exName: (id) => id.toUpperCase() }).slice(1).split('\r\n').filter(Boolean);
  assert.equal(w.length, 1 + 2 + 1 + 1, 'header + 2 sets + 1 cardio + 1 empty session; draft left out');
  assert.ok(w[0].includes('"exercise","exercise_name","set_no"'));
  assert.ok(w[1].includes(',"set","leg-press","LEG-PRESS",1,40,10,'));
  assert.ok(w[2].includes(',false,'), 'undone set marked');
  assert.ok(w[3].includes(',"cardio","bike-upright","BIKE-UPRIGHT",'));
  assert.ok(w[4].includes(',"session",'));
  assert.equal(workoutsCSV(data, { includeDrafts: true }).split('\r\n').filter(Boolean).length, 6);
  const h = hikesCSV(data).slice(1).split('\r\n');
  assert.ok(h[1].startsWith('"2025-11-29","Malham Cove, ""the steps""",10.5,300'));
  const e = exportCSV(data, 'hikes', { today: '2025-11-30' });
  assert.deepEqual([e.filename, e.mime], ['fitness-hub-hikes-2025-11-30.csv', 'text/csv;charset=utf-8']);
  assert.throws(() => exportCSV(data, 'nope'));
});

// ---------------------------------------------------------------- migrations
// A schema-1 data file in the shape a real one has after the welcome (the example profile), frozen here.
const REAL_V1 = {
  schema_version: 1,
  profile: {
    name: 'Sam', sex: 'male', birth_year: 1995, height_cm: 180, injured_arm: 'right', dominant_hand: 'right', program_start: '2025-11-24',
    activity_factor: 1.55, surplus_kcal: 300, protein_g_per_kg: 1.8, hrmax_override: null, rhr_baseline: null,
    diet_notes: 'Budget-friendly protein sources preferred.',
    clearances: { good_arm_ok: null, clinic_light: null, grip_cleared: null, full_clearance: null },
  },
  checkins: [{ date: '2025-11-22', weight_kg: 80.0, rhr: null, hrv: null, sleep_h: null, sleep_q: null, energy: null, soreness: null, mood: null, stress: null, arm_pain: null, arm_flags: [], steps: null, protein_g: null, calories: null, water_l: null, creatine: false, notes: 'Starting weight (not a morning weigh-in).' }],
  workouts: [], hikes: [], tests: [], measurements: [],
  arm: { appointments: [{ date: '2025-12-09', type: 'Fracture clinic', notes: 'Forearm fracture with plates. Ask about a physio referral.', outcome: '' }], logs: [], physio_exercises: [] },
  weekly_reviews: [],
};

/** Every leaf of `a` is present, unchanged, at the same path in `b`. */
function leavesPreserved(a, b, path = '') {
  if (a !== null && typeof a === 'object') {
    for (const k of Object.keys(a)) leavesPreserved(a[k], b?.[k], `${path}.${k}`);
    return;
  }
  assert.deepEqual(b, a, `value at ${path} changed`);
}

test('migrate: a v1 file upgrades safely (nothing lost, input untouched, idempotent, deterministic)', () => {
  const before = JSON.stringify(REAL_V1);
  const report = [];
  const m = migrate(REAL_V1, { report });
  assert.equal(JSON.stringify(REAL_V1), before, 'migrate never mutates its input');
  assert.equal(m.schema_version, SCHEMA_VERSION);
  assert.equal(SCHEMA_VERSION, 2);
  leavesPreserved({ ...REAL_V1, schema_version: 2 }, m);
  assert.deepEqual(report, [], 'nothing needed coercing');
  assert.deepEqual([m.arm.questions, m.hike_ladder, m.kit_owned, m.meta], [{}, {}, {}, {}]);
  assert.match(m.arm.appointments[0].id, /^a-[0-9a-f]{12}$/);
  assert.deepEqual(migrate(m), m, 'idempotent');
  assert.deepEqual(migrate(REAL_V1), m, 'deterministic: two tabs agree on every key');
  assert.deepEqual(normalize(REAL_V1), m, 'old name, same result');
  const keys = Object.keys(readiness(m.checkins[0]));
  for (const k of ['level', 'reasons', 'flags', 'rhrRef', 'inputs', 'messages']) assert.ok(keys.includes(k), `readiness() still returns ${k}`);
  assert.equal(readiness(m.checkins[0]).level, 'unknown', 'a weight-only check-in is not a check-in (SPEC 5.8)');
});

// PE13: the tests never read the user's data/ folder. dev-fixtures/data-v1.json is a frozen sample
// in a real file's shape (schema 1, every SPEC 5.7 field) plus the UI-owned keys.
test('migrate: the frozen v1 fixture copy upgrades safely and keeps ui, goals, kit_owned and unknown keys', () => {
  const text = fs.readFileSync(`${HUB}public/dev-fixtures/data-v1.json`, 'utf8');
  const raw = JSON.parse(text.replace(/^\uFEFF/, ''));
  assert.equal(raw.schema_version, 1);
  const m = migrate(raw);
  leavesPreserved({ ...raw, schema_version: m.schema_version }, m);
  assert.deepEqual(migrate(m), m, 'idempotent');
  assert.deepEqual([m.ui, m.goals, m.kit_owned, m.future_key], [raw.ui, raw.goals, raw.kit_owned, raw.future_key], 'UI-owned and unknown keys are kept as they are');
  assert.equal(validateImportDetailed(raw, { today: '2025-11-22' }).errorCount, 0, 'the file would import cleanly');
  assert.equal(fs.readFileSync(`${HUB}public/dev-fixtures/data-v1.json`, 'utf8'), text, 'never written');
  const src = fs.readFileSync(fileURLToPath(import.meta.url), 'utf8');
  assert.ok(!src.includes('${HUB}' + ['data', 'data.json'].join('/')), 'no test reads the live data file');
});

test('migrate: garbage is normalised, coerced or quarantined, never dropped', () => {
  const raw = {
    schema_version: 1,
    profile: 'x',
    checkins: [null, 5, { date: ' 2025-11-22 ', weight_kg: '80.5', steps: '', arm_flags: 'swelling_new', creatine: 'yes' }],
    workouts: { a: 1 },
    tests: [{ date: '2025-11-22T07:00:00Z', test: 't', value: '12' }, { date: '2025-11-22T07:00:00Z', test: 't', value: '12' }],
    hikes: [{ id: 7, date: '2025/11/23' }, { id: '7', date: '2025-11-24' }],
    arm: { appointments: 'nope', logs: [{ date: '2026-1-5', values: { pain_rest: '3' } }, { date: '2026-01-06', values: 'x' }], questions: [] },
    kit_owned: [], hike_ladder: null,
    future_field: { kept: true },
  };
  const report = [];
  const m = migrate(raw, { report });
  assert.deepEqual([m.profile.name, m.profile.program_start, m.profile.injury_date], ['', null, null], 'profile defaults filled: no name, no start date until one is chosen');
  const c = m.checkins[0];
  assert.equal(m.checkins.length, 1);
  assert.deepEqual([c.date, c.weight_kg, c.steps, c.arm_flags, c.creatine, c.rhr, c.notes], ['2025-11-22', 80.5, null, ['swelling_new'], true, null, '']);
  assert.equal(readiness(c).level, 'red', 'the string red flag survived');
  assert.deepEqual(m.tests.map((t) => [t.date, t.value]), [['2025-11-22', 12], ['2025-11-22', 12]]);
  assert.notEqual(m.tests[0].id, m.tests[1].id, 'identical legacy records get distinct ids');
  assert.deepEqual(m.hikes.map((h) => [h.id, h.date]), [['7', '2025-11-23'], ['7~2', '2025-11-24']], 'numeric id to text; duplicate made unique');
  assert.deepEqual(m.arm.logs.map((l) => [l.date, l.values]), [['2026-01-05', { pain_rest: 3 }], ['2026-01-06', {}]]);
  assert.deepEqual(m.arm.appointments, [], 'a broken list is set aside, not replaced by the default');
  assert.deepEqual(m.future_field, { kept: true }, 'unknown fields are kept');
  const q = m.quarantine.map((x) => x.from);
  for (const k of ['profile', 'checkins[0]', 'checkins[1]', 'workouts', 'arm.appointments', 'arm.questions', 'kit_owned']) assert.ok(q.includes(k), k);
  assert.deepEqual(m.quarantine.find((x) => x.from === 'workouts').value, { a: 1 });
  assert.ok(report.some((r) => /stored as the number 80.5/.test(r.message)));
  assert.deepEqual(migrate(m), m, 'idempotent on the cleaned result');
});

test('migrate: workouts, sets and edge versions', () => {
  const m = migrate({ schema_version: 1, workouts: [{ id: 'w', date: '2025-11-24', exercises: [{ exercise: 'leg-press', sets: [{ kg: '40', reps: '10' }, 'bad'] }, 'bad'], cardio: null }] });
  const w = m.workouts[0];
  assert.deepEqual(w.exercises[0].sets, [{ kg: 40, reps: 10, seconds: null, rir: null, done: true }], 'missing done counts as done (as stats always did)');
  assert.equal(w.exercises.length, 1);
  assert.deepEqual(w.cardio, []);
  assert.equal(w.notes, '');
  assert.equal(m.quarantine.length, 2);
  assert.equal(migrate({ schema_version: 99, x: 1 }).schema_version, 99, 'a newer file keeps its version');
  assert.deepEqual(migrate(null), defaultData());
  assert.deepEqual(migrate('nonsense'), defaultData());
  assert.equal(defaultData().schema_version, 2);
  assert.deepEqual(defaultData().arm.appointments, [], 'no appointment is made up');
  assert.deepEqual([defaultData().profile.name, defaultData().profile.program_start, defaultData().profile.injury_date], ['', null, null]);
  assert.deepEqual(migrate({ schema_version: 2, arm: { appointments: [] } }).arm.appointments, [], 'deleting every appointment sticks');
  assert.ok(MIGRATIONS.every((s, i) => s.to === i + 2 && typeof s.up === 'function'));
  assert.equal(coerceDate('2026-2-3'), '2026-02-03');
  assert.equal(coerceDate('2026-02-30'), '2026-02-30', 'impossible dates are left for validation to report');
});

// ---------------------------------------------------------------- import validation
const errs = (obj, opts) => validateImportDetailed(obj, { today: '2025-11-22', ...opts }).errors.map((e) => e.message);
const warns = (obj, opts) => validateImportDetailed(obj, { today: '2025-11-22', ...opts }).warnings.map((e) => e.message);

test('import validation: structure, types and dates give helpful errors', () => {
  assert.match(errs([])[0], /holds a list/);
  assert.match(errs('x')[0], /not Fitness Hub data/);
  assert.match(errs({})[0], /schema_version: is missing/);
  assert.match(errs({ schema_version: '1' })[0], /whole number/);
  assert.match(errs({ schema_version: 3 })[0], /newer version of the hub/);
  assert.match(errs({ schema_version: 1, profile: 'x' })[0], /profile: should be an object/);
  assert.match(errs({ schema_version: 1, profile: { clearances: 'soon' } })[0], /clearances: should be an object/);
  assert.match(errs({ schema_version: 1, profile: { clearances: { grip_cleared: '2026-02-30' } } })[0], /not a real calendar date/);
  assert.match(errs({ schema_version: 1, profile: { clearances: { grip_cleared: '2027-02-29' } } })[0], /2027 is not a leap year/);
  assert.match(errs({ schema_version: 1, profile: { program_start: '21/11/2026' } })[0], /Use YYYY-MM-DD/);
  assert.match(errs({ schema_version: 1, checkins: {} })[0], /checkins: should be a list/);
  assert.match(errs({ schema_version: 1, checkins: ['x'] })[0], /checkins\[0\]: should be an object/);
  assert.match(errs({ schema_version: 1, checkins: [{ weight_kg: 70 }] })[0], /checkins\[0\]\.date: is missing/);
  assert.match(errs({ schema_version: 1, checkins: [{ date: '2025-11-22', weight_kg: 'heavy' }] })[0], /weight_kg: should be a number, not the text "heavy"/);
  assert.match(errs({ schema_version: 1, checkins: [{ date: '2025-11-22', weight_kg: true }] })[0], /should be a number/);
  assert.match(errs({ schema_version: 1, checkins: [{ date: '2025-11-22', arm_flags: 5 }] })[0], /red-flag ids/);
  assert.match(errs({ schema_version: 1, tests: [{ date: '2025-11-22', value: 3 }] })[0], /which test/);
  assert.match(errs({ schema_version: 1, workouts: [{ date: '2025-11-22', exercises: {} }] })[0], /exercises: should be a list/);
  assert.match(errs({ schema_version: 1, workouts: [{ date: '2025-11-22', exercises: [{ sets: 3 }] }] })[0], /sets: should be a list of sets/);
  assert.match(errs({ schema_version: 1, workouts: [{ date: '2025-11-22', id: { a: 1 } }] })[0], /id: should be text/);
  assert.match(errs({ schema_version: 1, arm: [] })[0], /arm: should be an object/);
  assert.match(errs({ schema_version: 1, arm: { logs: [{ date: '2025-11-22', values: { pain_rest: 'bad' } }] } })[0], /values\.pain_rest: should be a number/);
  assert.match(errs({ schema_version: 1, kit_owned: [] })[0], /kit_owned: should be an object/);
  assert.equal(errs({ schema_version: 1, arm: { physio_exercises: [{ exercise: 'x' }] } }).length, 0, 'physio exercises need no date');
  const many = validateImportDetailed({ schema_version: 1, checkins: Array.from({ length: 100 }, () => 'x') }, { today: '2025-11-22' });
  assert.equal(many.errorCount, 100);
  assert.equal(many.errors.length, 40, 'the list is capped, the count is not');
});

test('import validation: sizes, depth, reserved keys, warnings, and never a partial apply', () => {
  assert.match(errs({ schema_version: 1, notes: 'x'.repeat(2000) }, { maxBytes: 1000 })[0], /accepts up to/);
  let deep = { v: 1 };
  for (let i = 0; i < 30; i++) deep = { deep };
  assert.match(errs({ schema_version: 1, deep })[0], /nested more than/);
  assert.match(errs(JSON.parse('{"schema_version": 1, "__proto__": {"x": 1}}'))[0], /reserved key "__proto__"/);
  assert.match(errs({ schema_version: 1, checkins: [{ date: '2025-11-22', notes: 'x'.repeat(200001) }] })[0], /200,001 characters/);
  const w = warns({
    schema_version: 1,
    profile: { surplus_kcal: -400, sex: 'M', program_start: '2025-11-26', clearances: { grip_cleared: '2026-01-07T09:00' } },
    checkins: [{ date: '2025-11-21', weight_kg: 80.4 }, { date: '2025-11-22', weight_kg: '805', arm_flags: 'swelling_new' }, { date: '2025-11-22', weight_kg: 80.6 }],
    workouts: [{ id: 'a', date: '2025-11-22' }, { id: 'a', date: '2025-11-23' }],
  });
  const all = w.join('\n');
  assert.match(all, /never plans a calorie deficit/);
  assert.match(all, /not a Monday/);
  assert.match(all, /will be imported as 2026-01-07/);
  assert.match(all, /stored as text \("805"\)/);
  assert.match(all, /imported as one red flag/);
  assert.match(all, /same date \(2025-11-22\)/);
  assert.match(all, /also used by workouts\[0\]/);
  assert.match(all, /Did you mean 80\.5 kg/, 'plausibility hints are included');
  const bad = validateImportDetailed({ schema_version: 1, checkins: [{ date: '2025-11-22' }, { date: 'soon' }] });
  assert.deepEqual([bad.ok, bad.data], [false, null], 'any error means nothing is applied');
  const good = validateImportDetailed(REAL_V1, { today: '2025-11-22' });
  assert.deepEqual([good.ok, good.errorCount, good.warningCount, good.data.schema_version, good.counts.checkins], [true, 0, 0, 2, 1]);
  assert.deepEqual(validateImport(REAL_V1), []);
  assert.match(validateImport({ schema_version: 1, checkins: 'x' })[0], /should be a list/);
});

// ---------------------------------------------------------------- diff, merge, patch
const base3 = () => migrate({
  schema_version: 2,
  profile: { name: 'Sam', height_cm: 180, clearances: { good_arm_ok: null } },
  checkins: [{ date: '2025-11-21', weight_kg: 79.9, arm_flags: [] }, { date: '2025-11-22', weight_kg: 80.0, sleep_h: null, arm_flags: [] }],
  workouts: [{ id: 'w1', date: '2025-11-22', session_id: 'str-a', status: 'done', exercises: [{ exercise: 'leg-press', sets: [{ kg: 40, reps: 10 }, { kg: 40, reps: 10 }] }] }],
  hikes: [{ id: 'h1', date: '2025-11-16', name: 'Malham Cove', notes: '' }],
  kit_owned: { Boots: true },
  meta: { save_id: 'base' },
});

test('diffData: record-level for collections, leaf-level elsewhere, meta ignored', () => {
  const b = base3();
  const l = cloneJSON(b);
  l.meta.save_id = 'other';
  l.schema_version = 9;
  assert.deepEqual(diffData(b, l), []);
  l.checkins[1].sleep_h = 7;
  l.profile.clearances.good_arm_ok = '2025-12-02';
  l.kit_owned.Socks = true;
  l.hikes.splice(0, 1);
  const d = diffData(b, l);
  assert.deepEqual(d.map((c) => [c.path.join('.'), c.key ?? null]).sort(), [['checkins', '2025-11-22'], ['hikes', 'h1'], ['kit_owned.Socks', null], ['profile.clearances.good_arm_ok', null]].sort());
  assert.equal(d.find((c) => c.key === 'h1').value, undefined, 'a deletion');
  assert.deepEqual(recordKeys([{ date: 'a' }, { date: 'a' }, {}, 'x', { date: '' }], 'date'), ['a', 'a\u00002', '\u0000', '\u0000\u00002', '\u0000\u00003']);
});

test('mergeData: disjoint changes, field-level merge inside a record, inputs untouched', () => {
  const b = base3();
  const l = cloneJSON(b);
  const r = cloneJSON(b);
  l.checkins[1].sleep_h = 7.5;
  l.profile.height_cm = 181;
  r.checkins[1].weight_kg = 80.2;
  r.checkins.push({ date: '2025-11-23', weight_kg: 80.1 });
  r.profile.name = 'T';
  r.kit_owned.Socks = true;
  const snap = JSON.stringify([b, l, r]);
  const m = mergeData(b, l, r);
  assert.equal(JSON.stringify([b, l, r]), snap, 'no input is mutated');
  assert.deepEqual(m.conflicts, []);
  const ck = m.result.checkins.find((c) => c.date === '2025-11-22');
  assert.deepEqual([ck.sleep_h, ck.weight_kg], [7.5, 80.2], 'both fields of the same check-in kept');
  assert.equal(m.result.checkins.length, 3);
  assert.deepEqual([m.result.profile.height_cm, m.result.profile.name, m.result.kit_owned.Socks], [181, 'T', true]);
});

test('mergeData: true conflicts, choices, delete-vs-edit, both-added, sets and set-like lists', () => {
  const b = base3();
  let l = cloneJSON(b);
  let r = cloneJSON(b);
  l.checkins[1].weight_kg = 80.4;
  r.checkins[1].weight_kg = 80.5;
  let m = mergeData(b, l, r);
  assert.equal(m.conflicts.length, 1);
  const c = m.conflicts[0];
  assert.deepEqual([c.collection, c.key, c.field, c.base, c.mine, c.theirs, c.resolvedAs], ['checkins', '2025-11-22', 'weight_kg', 80, 80.4, 80.5, null]);
  assert.equal(c.label, 'Check-in 2025-11-22 · weight_kg');
  assert.equal(m.result.checkins[1].weight_kg, 80.4, 'unresolved: local placeholder');
  assert.equal(mergeData(b, l, r, { choices: { [c.id]: 'theirs' } }).result.checkins[1].weight_kg, 80.5);
  assert.equal(mergeData(b, l, r, { defaultChoice: 'theirs' }).conflicts[0].resolvedAs, 'theirs');
  // Deleted here, edited there (and the reverse): the edit is kept.
  l = cloneJSON(b); r = cloneJSON(b);
  l.hikes = [];
  r.hikes[0].notes = 'muddy';
  m = mergeData(b, l, r);
  assert.deepEqual([m.conflicts.length, m.result.hikes[0].notes, m.notes[0].type], [0, 'muddy', 'kept-theirs']);
  l = cloneJSON(b); r = cloneJSON(b);
  l.hikes[0].notes = 'mine';
  r.hikes = [];
  m = mergeData(b, l, r);
  assert.deepEqual([m.result.hikes[0].notes, m.notes[0].type], ['mine', 'kept-mine']);
  l = cloneJSON(b); r = cloneJSON(b);
  l.hikes = []; r.hikes = [];
  assert.equal(mergeData(b, l, r).result.hikes.length, 0, 'deleted on both sides');
  // Both tabs created the same day's check-in: empty fields never beat filled ones.
  l = cloneJSON(b); r = cloneJSON(b);
  l.checkins.push(migrate({ checkins: [{ date: '2025-11-23', sleep_h: 7.2 }] }).checkins[0]);
  r.checkins.push(migrate({ checkins: [{ date: '2025-11-23', weight_kg: 80.1, creatine: true }] }).checkins[0]);
  m = mergeData(b, l, r);
  const n = m.result.checkins.find((x) => x.date === '2025-11-23');
  assert.deepEqual([m.conflicts.length, n.sleep_h, n.weight_kg, n.creatine], [0, 7.2, 80.1, true]);
  // Red flags ticked in two tabs: both kept (a set merge, never a conflict).
  l = cloneJSON(b); r = cloneJSON(b);
  l.checkins[1].arm_flags = ['fever_unwell'];
  r.checkins[1].arm_flags = ['swelling_new'];
  m = mergeData(b, l, r);
  assert.deepEqual(m.result.checkins[1].arm_flags, ['fever_unwell', 'swelling_new']);
  assert.equal(readiness(m.result.checkins[1]).level, 'red');
  // Different sets of the same exercise edited in two tabs: merged set by set.
  l = cloneJSON(b); r = cloneJSON(b);
  l.workouts[0].exercises[0].sets[0].reps = 12;
  r.workouts[0].exercises[0].sets[1].reps = 11;
  m = mergeData(b, l, r);
  assert.deepEqual([m.conflicts.length, m.result.workouts[0].exercises[0].sets.map((s) => s.reps)], [0, [12, 11]]);
  // An exercise added in one tab while sets change in the other: exercises are matched by
  // exercise id + occurrence (PE11), so both changes are kept and nothing conflicts.
  l = cloneJSON(b); r = cloneJSON(b);
  l.workouts[0].exercises.push({ exercise: 'box-squat-bw', sets: [] });
  r.workouts[0].exercises[0].sets[0].kg = 50;
  m = mergeData(b, l, r);
  assert.deepEqual([m.conflicts.length, m.result.workouts[0].exercises.map((e) => e.exercise), m.result.workouts[0].exercises[0].sets[0].kg], [0, ['leg-press', 'box-squat-bw'], 50]);
});

test('patchInPlace keeps record identities (views never hold detached copies)', () => {
  const live = base3();
  const ck = live.checkins[1];
  const set0 = live.workouts[0].exercises[0].sets[0];
  const arr = live.checkins;
  const next = cloneJSON(live);
  next.checkins[1].sleep_h = 8;
  next.checkins.reverse();
  next.checkins.push({ date: '2025-11-26', weight_kg: 80.5 });
  next.workouts[0].exercises[0].sets[0].reps = 11;
  next.hikes = [];
  next.profile.name = 'T';
  const n = patchInPlace(live, next);
  assert.ok(n > 0);
  assert.equal(live.checkins, arr, 'same array object');
  assert.equal(live.checkins.find((c) => c.date === '2025-11-22'), ck, 'same record object');
  assert.equal(ck.sleep_h, 8);
  assert.equal(live.workouts[0].exercises[0].sets[0], set0);
  assert.equal(set0.reps, 11);
  assert.deepEqual(live, next);
  assert.notEqual(live.checkins[2], next.checkins[2], 'inserted records are copies, never shared');
  assert.equal(patchInPlace(live, cloneJSON(live)), 0, 'nothing to do');
});

test('applyChanges with hash-only bases (localStorage deltas) and helpers', () => {
  const b = base3();
  const l = cloneJSON(b);
  l.checkins[1].sleep_h = 6.5;
  const stored = diffData(b, l).map((c) => ({ path: c.path, key: c.key, baseHash: hashValue(c.base), value: c.value }));
  const unchanged = cloneJSON(b);
  assert.equal(applyChanges(unchanged, stored).conflicts.length, 0);
  assert.equal(unchanged.checkins[1].sleep_h, 6.5, 'server unchanged: applied');
  const moved = cloneJSON(b);
  moved.checkins[1].weight_kg = 81;
  const ctx = applyChanges(moved, stored, { defaultChoice: 'mine' });
  assert.deepEqual([ctx.conflicts.length, ctx.conflicts[0].resolvedAs, moved.checkins[1].sleep_h], [1, 'mine', 6.5], 'without a full base only the whole record can be chosen');
  assert.equal(hashValue({ a: 1, b: [1, { c: 2 }] }), hashValue({ b: [1, { c: 2 }], a: 1 }), 'key order does not matter');
  assert.notEqual(hashValue({ a: 1 }), hashValue({ a: '1' }));
  assert.ok(deepEqual({ a: 1, b: undefined }, { a: 1 }));
  assert.ok(!deepEqual([1, 2], [2, 1]));
  const doc = { tests: [{ date: '2025-11-22', test: 't' }, { id: 5 }], arm: { physio_exercises: [{ exercise: 'x' }] } };
  let k = 0;
  ensureIds(doc, () => `new-${++k}`);
  assert.deepEqual([doc.tests[0].id, doc.tests[1].id, doc.arm.physio_exercises[0].id], ['new-1', '5', 'new-2']);
  assert.equal(describePath(['arm', 'logs', '2025-11-22', 'values', 'pain_rest']).label, 'Arm log 2025-11-22 · values.pain_rest');
  assert.equal(describePath(['profile', 'clearances', 'grip_cleared']).label, 'Profile · clearances.grip_cleared');
  assert.equal(describePath(['checkins', '2025-11-22\u00002', 'weight_kg']).key, '2025-11-22 (#2)');
});

// ---------------------------------------------------------------- store: the sync engine against a fake SPEC 5.7a server
const sha = (t) => `"${crypto.createHash('sha256').update(t).digest('hex')}"`;
const httpErr = (status, body = null) => Object.assign(new Error(`HTTP ${status}`), { status, body });
const settle = async () => { for (let i = 0; i < 40; i++) await new Promise((r) => setImmediate(r)); };

/** In-memory server with the SPEC 5.7a contract: strong ETag, If-Match, 412/428. */
function fakeServer(initial, { requireIfMatch = true, build = 'dev' } = {}) {
  const srv = {
    text: '', etag: null, gets: 0, puts: [], down: false, requireIfMatch, support304: false, hang: false,
    build, builds: [], healthCalls: 0, healthDown: false,
    getHealth: async () => {
      srv.healthCalls++;
      if (srv.healthDown || srv.down) throw httpErr(0);
      return { ok: true, app: 'fitness-hub', build: srv.build };
    },
    set(obj) { srv.text = JSON.stringify(obj, null, 1); srv.etag = sha(srv.text); },
    json() { return JSON.parse(srv.text); },
    edit(fn) { const d = migrate(srv.json()); fn(d); srv.set(d); }, // another tab or device saves
    getData: async ({ ifNoneMatch } = {}) => {
      srv.gets++;
      if (srv.down) throw httpErr(0);
      if (srv.support304 && ifNoneMatch && ifNoneMatch === srv.etag) return { status: 304, data: null, etag: srv.etag, bytes: 0 };
      return { status: 200, data: JSON.parse(srv.text), etag: srv.etag, bytes: srv.text.length };
    },
    putData: async (body, { etag = null, keepalive = false, build: hdr = null } = {}) => {
      srv.puts.push({ etag, keepalive: !!keepalive });
      srv.builds.push(hdr);
      if (srv.down) throw httpErr(0);
      if (srv.build !== 'dev' && hdr !== srv.build) throw httpErr(409, { error: 'build_mismatch', build: srv.build });
      if (srv.requireIfMatch && !etag) throw httpErr(428, { error: 'If-Match required' });
      if (etag && etag !== srv.etag) throw httpErr(412, { error: 'changed', current_etag: srv.etag });
      srv.set(JSON.parse(body));
      if (srv.hang) return new Promise(() => {}); // applied, but the answer never arrives (tab closed)
      return { ok: true, etag: srv.etag };
    },
  };
  srv.set(initial);
  return srv;
}

function fakeStorage({ quota = Infinity } = {}) {
  const m = new Map();
  return {
    map: m,
    get: (k) => (m.has(k) ? m.get(k) : null),
    set: (k, v) => {
      let size = v.length;
      for (const [kk, vv] of m) if (kk !== k) size += vv.length;
      if (size > quota) return false;
      m.set(k, v);
      return true;
    },
    remove: (k) => { m.delete(k); },
    keys: () => [...m.keys()],
  };
}

function fakeClock(start = Date.UTC(2025, 10, 22, 8)) {
  let now = start;
  let seq = 0;
  const timers = new Map();
  return {
    now: () => now,
    setTimer: (fn, ms) => { const id = ++seq; timers.set(id, { at: now + Math.max(0, ms), fn }); return id; },
    clearTimer: (id) => { timers.delete(id); },
    async tick(ms) {
      const end = now + ms;
      for (;;) {
        let id = null;
        let t = null;
        for (const [k, v] of timers) if (v.at <= end && (!t || v.at < t.at)) { id = k; t = v; }
        if (!t) break;
        timers.delete(id);
        now = t.at;
        t.fn();
        await settle();
      }
      now = end;
      await settle();
    },
  };
}

function fakeLocks() {
  const held = new Set();
  return {
    held,
    request(name, opts, cb) {
      if (held.has(name)) return Promise.resolve(cb(null));
      held.add(name);
      cb({ name });
      return new Promise(() => {});
    },
    async query() { return { held: [...held].map((name) => ({ name })) }; },
  };
}

let uuidSeq = 0;
const testUuid = () => `00000000-0000-4000-8000-${String(++uuidSeq).padStart(12, '0')}`;
function makeStore(srv, { storage = fakeStorage(), session = fakeStorage(), clock = fakeClock(), locks = null, getData = null, putData = null, getHealth = null, channel = null, saveTimeout } = {}) {
  const s = createStore({
    getData: getData || srv.getData, putData: putData || srv.putData, getHealth: getHealth || srv.getHealth, getText: async () => null, storage, session, locks, channel,
    now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer, random: () => 0.5, uuid: testUuid, isVisible: () => true, location: null, saveTimeout,
  });
  return { s, storage, session, clock };
}
const pendingKeys = (st) => st.keys().filter((k) => k.startsWith('fitness-hub:pending'));

test('store: GET keeps the ETag, PUT sends If-Match, saves are debounced and no-op touches write nothing', async () => {
  const srv = fakeServer(REAL_V1);
  const { s, clock, storage } = makeStore(srv);
  assert.deepEqual(await s.init(), { recovered: null });
  const etag0 = srv.etag;
  assert.deepEqual([s.syncInfo().etag, s.getStatus(), s.get().schema_version], [etag0, 'saved', 2]);
  assert.equal(srv.puts.length, 0, 'loading (and migrating) never writes');
  s.get().profile.height_cm = 179;
  s.touch();
  assert.equal(s.getStatus(), 'dirty');
  assert.ok(s.hasUnsaved());
  await clock.tick(499);
  assert.equal(srv.puts.length, 0, 'debounced');
  await clock.tick(1);
  assert.deepEqual(srv.puts, [{ etag: etag0, keepalive: false }]);
  assert.equal(s.getStatus(), 'saved');
  assert.notEqual(srv.etag, etag0);
  assert.equal(s.syncInfo().etag, srv.etag, 'the new ETag from the PUT response is kept');
  const saved = srv.json();
  assert.deepEqual([saved.profile.height_cm, saved.schema_version, saved.meta.app], [179, 2, 'fitness-hub']);
  assert.equal(pendingKeys(storage).length, 0, 'the browser copy is cleared once the server has it');
  s.touch();
  await clock.tick(1000);
  assert.equal(srv.puts.length, 1, 'touch without a change writes nothing');
  s.get().profile.height_cm = 180;
  s.touch();
  s.get().profile.height_cm = 179;
  await clock.tick(600);
  assert.equal(srv.puts.length, 1, 'changed and changed back: nothing to save');
  s.dispose();
});

test('store: 412 merges another tab\'s save, saves with the fresh ETag and keeps record identities', async () => {
  const srv = fakeServer(REAL_V1);
  const { s, clock } = makeStore(srv);
  await s.init();
  const events = [];
  s.onExternalChange((e) => events.push(e));
  const rec = s.get().checkins[0]; // a view holds this record
  srv.edit((d) => { d.checkins.push({ date: '2025-11-23', weight_kg: 80.1 }); d.profile.name = 'Sam H'; });
  const etagOther = srv.etag;
  rec.sleep_h = 7.5;
  s.get().tests.push({ date: '2025-11-22', test: 'wall-sit', value: 45, notes: '' });
  s.touch();
  await clock.tick(500);
  assert.equal(srv.puts.length, 2, 'one 412, then the merged save');
  assert.equal(srv.puts[1].etag, etagOther);
  const d = srv.json();
  assert.deepEqual(d.checkins.map((c) => c.date), ['2025-11-22', '2025-11-23']);
  assert.deepEqual([d.checkins[0].sleep_h, d.profile.name], [7.5, 'Sam H']);
  assert.equal(typeof d.tests[0].id, 'string', 'new records get an id before saving');
  assert.equal(s.get().checkins[0], rec, 'the view still holds the live record');
  assert.equal(s.get().profile.name, 'Sam H');
  assert.deepEqual(events.map((e) => e.kind), ['merge']);
  rec.notes = 'after the merge';
  s.touch();
  await clock.tick(500);
  assert.equal(srv.json().checkins[0].notes, 'after the merge', 'edits through the held record still save');
  assert.equal(s.getStatus(), 'saved');
  s.dispose();
});

test('store: a true conflict pauses saving, keeps changes in localStorage and lets the UI choose', async () => {
  const srv = fakeServer(REAL_V1);
  const { s, clock, storage } = makeStore(srv);
  await s.init();
  const seen = [];
  s.onConflict((c) => seen.push(c));
  const rec = s.get().checkins[0];
  srv.edit((d) => { d.checkins[0].weight_kg = 80.5; });
  rec.weight_kg = 80.4;
  s.touch();
  await clock.tick(500);
  assert.equal(s.getStatus(), 'conflict');
  assert.equal(srv.puts.length, 1, 'nothing was overwritten');
  const item = seen.at(-1).items[0];
  assert.deepEqual([seen.at(-1).count, item.label, item.mine, item.theirs, item.base], [1, 'Check-in 2025-11-22 · weight_kg', 80.4, 80.5, 80]);
  assert.deepEqual(s.getConflict().items.map((x) => x.id), [item.id]);
  assert.ok(s.hasUnsaved());
  const pend = () => JSON.parse(storage.get(pendingKeys(storage)[0]));
  assert.equal(pend().changes[0].v.weight_kg, 80.4, 'the local change is safe in localStorage');
  rec.notes = 'typed while the choice is open';
  s.touch();
  await clock.tick(5000);
  assert.equal(srv.puts.length, 1, 'still paused');
  assert.equal(pend().changes[0].v.notes, 'typed while the choice is open');
  await s.resolveConflict('theirs');
  assert.equal(s.getStatus(), 'saved');
  assert.deepEqual([srv.json().checkins[0].weight_kg, srv.json().checkins[0].notes], [80.5, 'typed while the choice is open']);
  assert.equal(seen.at(-1), null, 'listeners hear that the conflict is gone');
  assert.equal(rec.weight_kg, 80.5, 'the live record shows the chosen value');
  const log = s.conflictLog();
  assert.deepEqual([log.length, log[0].kept, log[0].mine, log[0].theirs], [1, 'theirs', 80.4, 80.5], 'the losing value is archived');
  assert.equal(pendingKeys(storage).length, 0);
  srv.edit((d) => { d.checkins[0].weight_kg = 81.5; });
  rec.weight_kg = 80.3;
  s.touch();
  await clock.tick(500);
  assert.equal(s.getStatus(), 'conflict');
  await s.resolveConflict({ default: 'mine' });
  assert.equal(srv.json().checkins[0].weight_kg, 80.3);
  assert.equal(s.conflictLog().at(-1).theirs, 81.5, 'the other version is archived, not lost');
  s.dispose();
});

test('store: a conflict that disappears (same fix made elsewhere) resolves itself on the next check', async () => {
  const srv = fakeServer(REAL_V1);
  const { s, clock } = makeStore(srv);
  await s.init();
  s.onConflict(() => {});
  srv.edit((d) => { d.profile.height_cm = 182; });
  s.get().profile.height_cm = 179;
  s.touch();
  await clock.tick(500);
  assert.equal(s.getStatus(), 'conflict');
  srv.edit((d) => { d.profile.height_cm = 179; }); // the other device corrects itself
  await s.retry();
  await clock.tick(100);
  assert.equal(s.getStatus(), 'saved');
  assert.equal(s.getConflict(), null);
  s.dispose();
});

test('store: without a conflict listener it falls back to "error + retry", and retry keeps your version', async () => {
  const srv = fakeServer(REAL_V1);
  const { s, clock } = makeStore(srv);
  await s.init();
  srv.edit((d) => { d.profile.height_cm = 182; });
  s.get().profile.height_cm = 177;
  s.touch();
  await clock.tick(500);
  assert.equal(s.getStatus(), 'error');
  assert.match(s.syncInfo().error.message, /Another tab or device changed one of the same things/);
  await s.retry();
  assert.equal(s.getStatus(), 'saved');
  assert.equal(srv.json().profile.height_cm, 177);
  assert.equal(s.conflictLog()[0].theirs, 182);
  s.dispose();
});

test('store: 428 (no ETag yet) re-fetches the ETag, merges and saves', async () => {
  const srv = fakeServer(REAL_V1);
  let first = true;
  const getData = async (o) => { const r = await srv.getData(o); if (first) { first = false; r.etag = null; } return r; };
  const { s, clock } = makeStore(srv, { getData });
  await s.init();
  assert.equal(s.syncInfo().etag, null);
  const etag0 = srv.etag;
  s.get().profile.height_cm = 179;
  s.touch();
  await clock.tick(500);
  assert.deepEqual(srv.puts.map((p) => p.etag), [null, etag0]);
  assert.deepEqual([srv.gets, s.getStatus(), srv.json().profile.height_cm], [2, 'saved', 179]);
  s.dispose();
});

test('store: server down keeps changes in localStorage and retries with backoff until it is back', async () => {
  const srv = fakeServer(REAL_V1);
  const { s, clock, storage } = makeStore(srv);
  await s.init();
  srv.down = true;
  s.get().checkins[0].sleep_h = 6;
  s.touch();
  await clock.tick(500);
  assert.equal(s.getStatus(), 'error');
  assert.match(s.syncInfo().error.message, /Can’t reach the hub/);
  assert.equal(pendingKeys(storage).length, 1);
  assert.equal(JSON.parse(storage.get(pendingKeys(storage)[0])).changes[0].v.sleep_h, 6);
  for (const wait of [2000, 4000, 8000]) {
    const n = srv.puts.length;
    await clock.tick(wait - 1);
    assert.equal(srv.puts.length, n, `no retry before ${wait} ms`);
    await clock.tick(1);
    assert.equal(srv.puts.length, n + 1, `retry after ${wait} ms`);
  }
  assert.ok(s.syncInfo().retryAt > clock.now());
  assert.ok(s.hasUnsaved());
  srv.down = false;
  await clock.tick(16000);
  assert.equal(s.getStatus(), 'saved');
  assert.equal(srv.json().checkins[0].sleep_h, 6);
  assert.equal(pendingKeys(storage).length, 0);
  srv.down = true;
  s.get().checkins[0].sleep_h = 6.5;
  s.touch();
  await clock.tick(500);
  srv.down = false;
  const n = srv.puts.length;
  s.onOnline(); // the browser says the network is back: retry at once
  await settle();
  assert.deepEqual([srv.puts.length, s.getStatus()], [n + 1, 'saved']);
  s.dispose();
});

test('store: after a crash the next load offers the unsaved changes back; saving or discarding them works', async () => {
  const srv = fakeServer(REAL_V1);
  const storage = fakeStorage();
  const session = fakeStorage();
  const a = makeStore(srv, { storage, session });
  await a.s.init();
  srv.down = true;
  a.s.get().checkins.push({ date: '2025-11-23', weight_kg: 80.2, arm_flags: [] });
  a.s.get().profile.rhr_baseline = 57;
  a.s.touch();
  await a.clock.tick(500);
  a.s.dispose(); // the tab dies
  srv.down = false;
  const b = makeStore(srv, { storage, session }); // reload in the same tab
  const { recovered } = await b.s.init();
  assert.ok(recovered);
  assert.deepEqual([recovered.changes, recovered.conflicts, recovered.data.profile.rhr_baseline], [2, 0, 57]);
  assert.ok(recovered.data.checkins.some((c) => c.date === '2025-11-23'));
  assert.equal(typeof recovered.at, 'string');
  await b.s.replaceAll(recovered.data);
  assert.equal(b.s.getStatus(), 'saved');
  assert.equal(srv.json().profile.rhr_baseline, 57);
  assert.equal(pendingKeys(storage).length, 0);
  b.s.dispose();
  // Same again, but the user chooses "Keep the saved data": discarded (kept aside for a while).
  const c = makeStore(srv, { storage, session });
  await c.s.init();
  srv.down = true;
  c.s.get().profile.rhr_baseline = 99;
  c.s.touch();
  await c.clock.tick(500);
  c.s.dispose();
  srv.down = false;
  const d = makeStore(srv, { storage, session });
  assert.ok((await d.s.init()).recovered);
  d.s.discardPending();
  assert.equal(pendingKeys(storage).length, 0);
  assert.equal(JSON.parse(storage.get('fitness-hub:discarded')).length, 1);
  assert.equal(srv.json().profile.rhr_baseline, 57);
  d.s.dispose();
});

test('store: a keepalive save that reached the server is not offered back as unsaved', async () => {
  const srv = fakeServer(REAL_V1);
  const storage = fakeStorage();
  const session = fakeStorage();
  const a = makeStore(srv, { storage, session });
  await a.s.init();
  srv.hang = true;
  a.s.get().profile.name = 'closing the tab';
  a.s.touch();
  a.s.onPageHide();
  await settle();
  assert.deepEqual(srv.puts.at(-1), { etag: srv.puts.at(-1).etag, keepalive: true });
  assert.equal(srv.json().profile.name, 'closing the tab');
  assert.equal(pendingKeys(storage).length, 1, 'the page died before the answer');
  a.s.dispose();
  srv.hang = false;
  const b = makeStore(srv, { storage, session });
  assert.equal((await b.s.init()).recovered, null);
  assert.equal(pendingKeys(storage).length, 0, 'already saved: the browser copy is dropped');
  b.s.dispose();
});

test('store: recovery merges field by field with another device\'s later save; the old v1 key is read too', async () => {
  const srv = fakeServer(REAL_V1);
  const storage = fakeStorage();
  const session = fakeStorage();
  const a = makeStore(srv, { storage, session });
  await a.s.init();
  srv.down = true;
  a.s.get().checkins[0].sleep_h = 6.5;
  a.s.touch();
  await a.clock.tick(500);
  a.s.dispose();
  srv.down = false;
  srv.edit((d) => { d.checkins[0].weight_kg = 80.3; d.hikes.push({ id: 'h-new', date: '2025-11-23', name: 'Malham Cove' }); });
  const b = makeStore(srv, { storage, session });
  const { recovered } = await b.s.init();
  const ck = recovered.data.checkins[0];
  assert.deepEqual([ck.sleep_h, ck.weight_kg, recovered.conflicts], [6.5, 80.3, 0], 'both edits to the same check-in survive');
  assert.ok(recovered.data.hikes.some((h) => h.id === 'h-new'));
  b.s.dispose();
  const legacy = fakeStorage();
  legacy.set('fitness-hub:pending', JSON.stringify({ at: '2025-11-21T10:00:00Z', data: { ...REAL_V1, checkins: [...REAL_V1.checkins, { date: '2025-11-21', weight_kg: 79.7, arm_flags: [] }] } }));
  const c = makeStore(srv, { storage: legacy });
  const r2 = (await c.s.init()).recovered;
  assert.deepEqual(r2.data.checkins.map((x) => x.date).sort(), ['2025-11-21', '2025-11-22']);
  assert.ok(r2.data.hikes.some((h) => h.id === 'h-new'), 'nothing newer is deleted by an old browser copy');
  await c.s.replaceAll(r2.data);
  assert.deepEqual(pendingKeys(legacy), []);
  c.s.dispose();
});

test('store: tabs sharing localStorage keep separate deltas and never take over a live tab\'s changes', async () => {
  const srv = fakeServer(REAL_V1);
  const storage = fakeStorage();
  const locks = fakeLocks();
  const A = makeStore(srv, { storage, locks });
  await A.s.init();
  srv.down = true;
  A.s.get().profile.height_cm = 181;
  A.s.touch();
  await A.clock.tick(500);
  srv.down = false;
  const B = makeStore(srv, { storage, locks });
  assert.equal((await B.s.init()).recovered, null, 'A is still open');
  assert.notEqual(B.s.syncInfo().tabId, A.s.syncInfo().tabId);
  B.s.get().profile.name = 'B';
  B.s.touch();
  await B.clock.tick(500);
  assert.equal(B.s.getStatus(), 'saved');
  assert.equal(pendingKeys(storage).length, 1, 'A\'s delta is untouched by B');
  locks.held.delete(`fitness-hub:tab:${A.s.syncInfo().tabId}`); // A is closed
  A.s.dispose();
  const C = makeStore(srv, { storage, locks });
  const rc = (await C.s.init()).recovered;
  assert.deepEqual([rc.data.profile.height_cm, rc.data.profile.name], [181, 'B'], 'built on the latest server copy');
  const dup = fakeStorage();
  dup.set('fitness-hub:tab', C.s.syncInfo().tabId); // a duplicated tab copies sessionStorage
  const D = makeStore(srv, { storage, locks, session: dup });
  await D.s.init();
  assert.notEqual(D.s.syncInfo().tabId, C.s.syncInfo().tabId);
  for (const x of [B, C, D]) x.s.dispose();
  // Without Web Locks: another tab's delta counts as orphaned only after two minutes.
  const st2 = fakeStorage();
  const E = makeStore(srv, { storage: st2 });
  await E.s.init();
  srv.down = true;
  E.s.get().profile.height_cm = 170;
  E.s.touch();
  await E.clock.tick(500);
  srv.down = false;
  const clock = fakeClock(E.clock.now() + 10000);
  const F = makeStore(srv, { storage: st2, clock });
  assert.equal((await F.s.init()).recovered, null, '10 s old: probably still open');
  const G = makeStore(srv, { storage: st2, clock: fakeClock(E.clock.now() + 180000) });
  assert.equal((await G.s.init()).recovered.data.profile.height_cm, 170);
  for (const x of [E, F, G]) x.s.dispose();
});

test('store: a stale tab picks up another tab\'s save on focus, in place; 304 and throttling keep it cheap', async () => {
  const srv = fakeServer(REAL_V1);
  const { s, clock } = makeStore(srv);
  await s.init();
  const ev = [];
  s.onExternalChange((e) => ev.push(e));
  const rec = s.get().checkins[0];
  srv.edit((d) => { d.checkins[0].weight_kg = 81; d.profile.name = 'Other tab'; });
  s.onVisible();
  s.onVisible();
  await clock.tick(300);
  assert.equal(s.get().checkins[0], rec);
  assert.deepEqual([rec.weight_kg, s.get().profile.name], [81, 'Other tab']);
  assert.deepEqual(ev.map((e) => e.kind), ['reload']);
  assert.equal(srv.puts.length, 0, 'nothing to save');
  assert.equal(s.syncInfo().etag, srv.etag);
  const gets = srv.gets;
  srv.support304 = true;
  assert.deepEqual(await s.checkForUpdates({ force: true }), { stale: false });
  assert.equal(srv.gets, gets + 1);
  await clock.tick(1000);
  s.onVisible();
  await clock.tick(300);
  assert.equal(srv.gets, gets + 1, 'throttled to one check per few seconds');
  s.dispose();
});

test('store: a stale tab with unsaved edits merges on focus and saves with the fresh ETag (no 412)', async () => {
  const srv = fakeServer(REAL_V1);
  const { s, clock } = makeStore(srv);
  await s.init();
  srv.edit((d) => { d.profile.name = 'Other'; });
  const fresh = srv.etag;
  s.get().checkins[0].sleep_h = 7;
  s.touch();
  s.onVisible();
  await clock.tick(300);
  assert.deepEqual(srv.puts, [{ etag: fresh, keepalive: false }]);
  assert.deepEqual([srv.json().profile.name, srv.json().checkins[0].sleep_h], ['Other', 7]);
  await clock.tick(1000);
  assert.equal(srv.puts.length, 1, 'the debounced save has nothing left to do');
  s.dispose();
});

test('store: another tab\'s "saved" broadcast triggers a check (BroadcastChannel)', async () => {
  const srv = fakeServer(REAL_V1);
  let ch = null;
  const posted = [];
  const channel = () => (ch = { onmessage: null, postMessage: (m) => posted.push(m), close() {} });
  const { s, clock } = makeStore(srv, { channel });
  await s.init();
  s.get().profile.name = 'me';
  s.touch();
  await clock.tick(500);
  assert.equal(posted.at(-1).type, 'saved');
  assert.equal(posted.at(-1).etag, srv.etag);
  srv.edit((d) => { d.profile.height_cm = 185; });
  ch.onmessage({ data: { type: 'saved', etag: srv.etag, tab: 'someone-else' } });
  await clock.tick(5000);
  assert.equal(s.get().profile.height_cm, 185);
  s.dispose();
});

test('store: hidden/pagehide flush with keepalive; an in-flight save also sends a keepalive copy', async () => {
  const srv = fakeServer(REAL_V1);
  let release = null;
  const putData = (b, o) => (o.keepalive ? srv.putData(b, o) : new Promise((r) => { release = () => r(srv.putData(b, o)); }));
  const { s, clock } = makeStore(srv, { putData });
  await s.init();
  s.get().profile.name = 'x';
  s.touch();
  s.onHidden();
  await settle();
  assert.deepEqual([srv.puts.length, srv.puts[0].keepalive, s.getStatus()], [1, true, 'saved']);
  s.get().profile.name = 'y';
  s.touch();
  await clock.tick(500);
  assert.equal(s.getStatus(), 'saving');
  assert.equal(s.onBeforeUnload(), true, 'the browser should warn');
  s.onPageHide();
  await settle();
  assert.deepEqual(srv.puts.at(-1).keepalive, true, 'a keepalive copy went out');
  assert.equal(srv.json().profile.name, 'y');
  release();
  await clock.tick(100);
  assert.equal(s.getStatus(), 'saved', 'the late original gets a 412, finds nothing left to merge');
  assert.equal(s.onBeforeUnload(), false);
  s.dispose();
});

test('store: edits made while a save is in flight are saved right after it', async () => {
  const srv = fakeServer(REAL_V1);
  let release = null;
  const putData = (b, o) => new Promise((r) => { release = () => r(srv.putData(b, o)); });
  const { s, clock } = makeStore(srv, { putData });
  await s.init();
  s.get().profile.name = 'one';
  s.touch();
  await clock.tick(500);
  assert.equal(s.getStatus(), 'saving');
  s.get().profile.height_cm = 190;
  s.touch();
  assert.equal(s.getStatus(), 'saving');
  const first = srv.etag;
  release();
  await settle();
  assert.equal(s.getStatus(), 'saving', 'second save started at once');
  release();
  await settle();
  assert.equal(s.getStatus(), 'saved');
  assert.deepEqual([srv.json().profile.name, srv.json().profile.height_cm], ['one', 190]);
  assert.equal(srv.puts.length, 2);
  assert.notEqual(srv.puts[1].etag, first, 'the second save uses the ETag from the first');
  s.dispose();
});

test('store: an import while another tab saved applies fully and keeps the other tab\'s new record', async () => {
  const srv = fakeServer(REAL_V1);
  const { s } = makeStore(srv);
  await s.init();
  srv.edit((d) => { d.hikes.push({ id: 'other', date: '2025-11-23', name: 'Other tab hike' }); });
  const imp = JSON.parse(fs.readFileSync(`${HUB}public/dev-fixtures/data.json`, 'utf8'));
  const v = await s.importData(imp, { today: '2025-11-22' });
  assert.equal(v.ok, true);
  assert.equal(s.getStatus(), 'saved');
  const d = srv.json();
  assert.equal(d.checkins.length, imp.checkins.length);
  assert.equal(d.profile.program_start, imp.profile.program_start);
  assert.ok(d.hikes.some((h) => h.id === 'other'));
  const bad = await s.importData({ schema_version: 1, checkins: 'x' });
  assert.equal(bad.ok, false);
  assert.equal(srv.json().checkins.length, imp.checkins.length, 'a bad import changes nothing');
  s.dispose();
});

test('store: storage quota, constant churn and fixture mode', async () => {
  const srv = fakeServer(REAL_V1);
  const q = makeStore(srv, { storage: fakeStorage({ quota: 50 }) });
  await q.s.init();
  srv.down = true;
  q.s.get().profile.name = 'x';
  q.s.touch();
  await q.clock.tick(500);
  assert.equal(q.s.syncInfo().pendingStored, false, 'the UI can warn that the browser copy failed');
  q.s.dispose();
  srv.down = false;
  let n = 0;
  const getData = async (o) => { const r = await srv.getData(o); srv.edit((d) => { d.kit_owned[`x${++n}`] = true; }); return r; };
  const c = makeStore(srv, { getData });
  await c.s.init();
  c.s.get().profile.name = 'churn';
  c.s.touch();
  await c.clock.tick(500);
  assert.equal(c.s.getStatus(), 'error');
  assert.match(c.s.syncInfo().error.message, /keeps changing/);
  assert.ok(srv.puts.length <= 8, 'bounded');
  c.s.dispose();
  const f = createStore({ getText: async (u) => (u === '/dev-fixtures/data-2y.json' ? '{"schema_version":1,"checkins":[{"date":"2025-11-22"}]}' : null), location: { search: '?fixtures=1&data=2y' }, storage: fakeStorage(), session: fakeStorage(), locks: null, channel: null });
  await f.init({ fixtures: true });
  assert.deepEqual([f.getStatus(), f.get().checkins.length, f.get().schema_version], ['fixture', 1, 2]);
  f.touch();
  assert.deepEqual([f.getStatus(), f.hasUnsaved()], ['fixture', false]);
  f.dispose();
});

// ---------------------------------------------------------------- api.js against a mocked fetch
const fakeRes = (status, body, headers = {}) => ({
  status, ok: status >= 200 && status < 300,
  headers: { get: (k) => headers[k.toLowerCase()] ?? null },
  text: async () => body, json: async () => JSON.parse(body),
});

test('api: ETag from GET, If-Match on PUT, keepalive only within the size limit, errors carry the status', async () => {
  const calls = [];
  const realFetch = globalThis.fetch;
  let next = null;
  globalThis.fetch = async (url, init = {}) => { calls.push({ url, init }); return next(url, init); };
  try {
    next = () => fakeRes(200, '{"schema_version":1}', { etag: '"abc"' });
    const g = await apiGetDataWithEtag();
    assert.deepEqual([g.status, g.etag, g.data.schema_version, g.bytes], [200, '"abc"', 1, 20]);
    assert.deepEqual(await apiGetData(), { schema_version: 1 });
    assert.equal(calls.at(-1).init.cache, 'no-store');
    next = () => fakeRes(304, '', {});
    const nm = await apiGetDataWithEtag({ ifNoneMatch: '"abc"' });
    assert.deepEqual([nm.status, nm.etag, nm.data], [304, '"abc"', null]);
    assert.equal(calls.at(-1).init.headers['If-None-Match'], '"abc"');
    next = () => fakeRes(200, 'not json', {});
    await assert.rejects(apiGetDataWithEtag(), (e) => e instanceof HttpError && e.status === 502);
    next = () => fakeRes(500, '{"ok":false,"error":"data/data.json is not valid JSON."}', {});
    await assert.rejects(apiGetDataWithEtag(), (e) => e.status === 500 && /not valid JSON/.test(e.message));
    next = () => fakeRes(200, '{"ok":true,"etag":"\\"def\\""}', { etag: '"def"' });
    const p = await apiPutData('{"a":1}', { etag: '"abc"', keepalive: true });
    assert.equal(p.etag, '"def"');
    const init = calls.at(-1).init;
    assert.deepEqual([init.method, init.headers['If-Match'], init.headers['X-Fitness-Hub'], init.headers['Content-Type'], init.keepalive], ['PUT', '"abc"', '1', 'application/json', true]);
    next = () => fakeRes(200, '{"ok":true,"etag":"\\"ghi\\""}', {});
    assert.equal((await apiPutData('x'.repeat(KEEPALIVE_MAX_BYTES + 1), { etag: '"abc"', keepalive: true })).etag, '"ghi"', 'ETag from the body when there is no header');
    assert.equal(calls.at(-1).init.keepalive, false, 'too big for keepalive: a normal request');
    await apiPutData('{}');
    assert.equal(calls.at(-1).init.headers['If-Match'], undefined, 'no ETag, no If-Match');
    next = () => fakeRes(412, '{"error":"changed","current_etag":"\\"zzz\\""}', {});
    await assert.rejects(apiPutData('{}', { etag: '"abc"' }), (e) => e.status === 412 && e.body.current_etag === '"zzz"' && e.message === 'changed');
    next = () => fakeRes(428, '{"error":"If-Match required"}', {});
    await assert.rejects(apiPutData('{}'), (e) => e.status === 428);
    next = () => { throw new TypeError('Failed to fetch'); };
    await assert.rejects(apiPutData('{}', { etag: '"a"' }), (e) => e instanceof HttpError && e.status === 0 && /Can’t reach the hub/.test(e.message));
  } finally {
    globalThis.fetch = realFetch;
  }
});

// ---------------------------------------------------------------- content.js validation
test('content: loose validation reports problems (safety first) and never throws', async () => {
  const files = {
    '/content/program.json': JSON.stringify({
      phases: [
        { id: 'p1', entry_gate: 'none', weeks: 4, week_template: { mon: 'a', tue: 'ghost', funday: 'a' }, week_overrides: [{ week: 2, deload: true, sets_max: 2 }, { week: 9 }] },
        { id: 'p1', entry_gate: 'gripp', weeks: 0, week_template: {} },
      ],
      sessions: { a: { type: 'strength', warmup: 'nope', blocks: [{ exercise: 'pull-up', sets: 3, reps: '5' }, { foo: 1 }, { exercise: 'walk', minutes: 10, minutes_by_week: [5, 'x'] }] } },
      addons: [{ id: 'ad', session: 'missing', gate: 'zzz', phases: ['p9'], days: ['funday'] }],
      rules: { increments_kg: { machine: -1 } },
    }),
    '/content/exercises/part-a.json': JSON.stringify([
      { id: 'walk', name: 'Walk', gate: 'none', arm_use: 'none', fall_risk: 'low', category: 'conditioning', arm_safety: 'Nothing in the hands.', video: 'javascript:alert(1)', regressions: ['nothing-here'] },
      { name: 'no id' }, { id: 'walk', gate: 'none' },
    ]),
    '/content/exercises/part-b.json': JSON.stringify([{ id: 'pull-up', name: 'Pull-up', gate: 'full_clearance', category: 'pull' }, { id: 'mystery', gate: 'banana' }]),
    '/content/tests.json': '{"not": "a list"}',
    '/content/hikes.json': JSON.stringify({ ladder: [{ level: 1, gate: 'none', criteria: { distance_km: 5 } }, { level: 1, gate: 'nope', examples: [{ name: 'x', url: 'ftp://x' }] }] }),
    '/content/nutrition.json': '{ half written',
    '/content/arm.json': JSON.stringify({ red_flags: [{ id: 'pain_increasing' }], measurements: [] }),
    '/content/guide/index.json': JSON.stringify({ parts: [{ title: 'A', chapters: [{ file: '../etc/passwd' }, { file: '01-a.md' }, { file: '01-a.md' }] }] }),
  };
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => (files[url] === undefined ? fakeRes(404, '') : fakeRes(200, files[url]));
  try {
    await loadContent();
    const st = Object.fromEntries(content.status.map((s) => [s.label, s]));
    assert.equal(content.status[0].label, 'Program', 'listed first, as before');
    assert.equal(st.Program.state, 'ok');
    const pp = st.Program.problems.join('\n');
    for (const re of [/session "ghost" does not exist/, /unknown day "funday"/, /sets_max and deload/, /outside 1–4/, /Duplicate phase id p1/,
      /Safety: phase p1 has an unknown entry_gate "gripp"/, /weeks should be a whole number/, /Safety: phase p1 schedules pull-up, which needs full_clearance/,
      /warmup routine "nope" does not exist/, /shape not recognised/, /minutes_by_week has entries that are not numbers/, /Add-on ad: session "missing"/,
      /Safety: add-on ad has an unknown gate/, /unknown phase "p9"/, /increments_kg\.machine/]) assert.match(pp, re);
    assert.equal(st['Exercises part A'].state, 'ok');
    const ep = st['Exercises part A'].problems.join('\n');
    for (const re of [/not an http\(s\) link and was dropped/, /Duplicate exercise id walk/, /Safety: mystery has an unknown gate "banana"/, /regressions refer to unknown exercises \(nothing-here\)/, /Exercise #2 has no id/]) assert.match(ep, re);
    assert.equal(content.exById.get('walk').video, '', 'unsafe link removed');
    assert.equal(content.exById.get('mystery').gate, 'full_clearance', 'unknown gate locks the exercise');
    assert.deepEqual([st.Tests.state, content.tests], ['invalid', []]);
    assert.deepEqual([st.Nutrition.state, content.nutrition], ['invalid', null]);
    assert.match(st.Hikes.problems.join('\n'), /level 1 appears twice/);
    assert.match(st.Hikes.problems.join('\n'), /non-http\(s\) link/);
    assert.match(st['Arm recovery'].problems[0], /^Safety: red flags missing/);
    assert.match(st['Guide index'].problems.join('\n'), /not a valid chapter file name/);
    assert.deepEqual(content.guideIndex.parts[0].chapters.map((c) => c.file), ['01-a.md', '01-a.md']);
    assert.ok(contentProblems().some((p) => p.safety && p.file === 'arm.json'));
    assert.match(st.Program.detail, /things to check/);
    globalThis.fetch = async () => { throw new Error('offline'); };
    await loadContent();
    assert.ok(content.status.length >= 7);
    assert.ok(content.status.every((s) => s.state === 'error'), 'a dead network is reported, not thrown');
    assert.deepEqual(validateProgram(null), ['Not a program object.']);
    assert.deepEqual(validateProgram({ phases: [{ id: 'x', weeks: 2, week_template: { mon: 'rest' } }], sessions: {} }), []);
  } finally {
    globalThis.fetch = realFetch;
  }
});

// ---------------------------------------------------------------- timers
test('timers: interval steps carry overflow across segments (a throttled tab never falls behind)', () => {
  const segs = [{ secs: 60 }, { secs: 30 }, { secs: 90 }, { secs: 30 }];
  assert.deepEqual(stepSegments(segs, 0, 60, 10), { idx: 0, left: 50, completed: [] });
  assert.deepEqual(stepSegments(segs, 0, 60, 100), { idx: 2, left: 80, completed: [0, 1] });
  assert.deepEqual(stepSegments(segs, 0, 60, 1000), { idx: 4, left: 0, completed: [0, 1, 2, 3] });
  assert.deepEqual(stepSegments(segs, 3, 5, 5), { idx: 4, left: 0, completed: [3] });
  assert.deepEqual(stepSegments([], 0, 0, 5), { idx: 0, left: 0, completed: [] });
});

// ---------------------------------------------------------------- performance
test('performance: two years of dense data stays fast (no O(n^2) hot paths)', { skip: !fs.existsSync(`${HUB}public/dev-fixtures/data-2y.json`) }, () => {
  const raw = JSON.parse(fs.readFileSync(`${HUB}public/dev-fixtures/data-2y.json`, 'utf8'));
  const program = JSON.parse(fs.readFileSync(`${HUB}public/dev-fixtures/program.json`, 'utf8'));
  const timings = {};
  const time = (name, fn) => { const t0 = performance.now(); const r = fn(); timings[name] = Math.round((performance.now() - t0) * 10) / 10; return r; };
  const data = time('migrate v1->v2', () => migrate(raw));
  const body = time('stringify body', () => JSON.stringify(data));
  const base = time('parse base', () => JSON.parse(body));
  time('diffData none', () => diffData(base, data));
  const local = cloneJSON(data);
  local.checkins.at(-1).sleep_h = 9;
  local.workouts.at(-1).notes = 'x';
  local.profile.name = 'y';
  assert.equal(time('diffData 3', () => diffData(base, local)).length, 3);
  const remote = cloneJSON(data);
  remote.checkins[0].notes = 'remote';
  const m = time('mergeData', () => mergeData(base, local, remote));
  assert.equal(m.conflicts.length, 0);
  time('patchInPlace', () => patchInPlace(local, m.result));
  const today = '2025-11-22';
  const ctx = time('makeCtx', () => makeCtx({ program, profile: data.profile, data, today }));
  const st = time('streak', () => streak(ctx));
  time('weekSummary all weeks', () => { for (let w = mondayOf(data.profile.program_start); w <= today; w = addDays(w, 7)) weekSummary(ctx, w); });
  const weights = data.checkins.map((c) => ({ date: c.date, value: c.weight_kg }));
  time('rollingMean', () => rollingMean(weights));
  time('rollingMean (old O(n^2))', () => { const s = weights.slice().sort((a, b) => (a.date < b.date ? -1 : 1)); return s.map((p) => trailingMean(s, p.date, 7)); });
  time('readinessHistory', () => readinessHistory(data.checkins, data.profile));
  time('readiness per day (old way)', () => data.checkins.map((c) => readiness(c, data.checkins, data.profile)));
  time('dataIssues', () => dataIssues(data));
  time('workoutsCSV', () => workoutsCSV(data));
  time('validateImport', () => validateImportDetailed(raw, { today }));
  time('exerciseHistory all', () => { for (const id of new Set(data.workouts.flatMap((w) => w.exercises.map((e) => e.exercise)))) exerciseHistory(data, id); });
  console.log(`# 2-year fixture: ${data.checkins.length} check-ins, ${data.workouts.length} sessions, ${(body.length / 1024).toFixed(0)} KB as JSON, streak ${st}`);
  console.log(`# timings (ms): ${JSON.stringify(timings)}`);
  for (const [k, v] of Object.entries(timings)) assert.ok(v < 1500, `${k} took ${v} ms`);
  // Scaling guard: with 20,000 points the old quadratic code took seconds.
  const big = Array.from({ length: 20000 }, (_, i) => ({ date: addDays('1999-01-02', i), value: 70 + (i % 7), rhr: 55 + (i % 9) }));
  const t1 = performance.now();
  rollingMean(big);
  const rm = performance.now() - t1;
  const t2 = performance.now();
  readinessHistory(big, {});
  const rh = performance.now() - t2;
  console.log(`# 20,000 points: rollingMean ${Math.round(rm)} ms, readinessHistory ${Math.round(rh)} ms`);
  assert.ok(rm < 500 && rh < 1000);
});

// =====================================================================================
// Review round 3 (Team 1: data and logic). Every Team 1 item in reviews/ROUND3_TRIAGE.md, and
// the Team 1 PM additions, has a test below. PE1's two probes are reproduced first.
// =====================================================================================
import {
  readinessOn, painReference, fastingPeriods, rhrMethodChanges, rhrMethodChangeOn, combineCheckins,
  READINESS_TEXT, READINESS_MESSAGES, READINESS_RULES, trendUntil, meanBetween, countsAsCheckin,
} from '../public/js/calc.js';
import {
  overrideBlockFields, zoneNumber, isRehabAddon, physioProgrammeReady, alternatesOf, alternateIds, addonSessionIds,
  exerciseGate, exerciseLocked, UNAVAILABLE_DEFAULT, isAvailable as isAvailableS, HOLD_TEXT, isPerformedSet, holdReason,
} from '../public/js/schedule.js';
import { workoutRoles, seriesUntil, series, weekendPlanOn, hikeMeets, WAIST_PACK_MAX_KG } from '../public/js/stats.js';
import {
  legacyFill, applyRecovery, entryKeys, CONFLICT_LOG_LIMITS, BUILD_MISMATCH_TEXT, isAvailable as isAvailableStore,
} from '../public/js/store.js';
import { byteLength, fitsKeepalive, buildOf, BUILD_HEADER, getText, apiHealth } from '../public/js/api.js';
import { gateOf, isLocked, isAvailable, compareExerciseSources } from '../public/js/content.js';

/** A tab that dies with one unsaved change in localStorage; returns the shared storage and session. */
async function crashWith(srv, edit) {
  const storage = fakeStorage();
  const session = fakeStorage();
  const a = makeStore(srv, { storage, session });
  await a.s.init();
  srv.down = true;
  edit(a.s.get());
  a.s.touch();
  await a.clock.tick(500);
  a.s.dispose();
  srv.down = false;
  return { storage, session };
}

// ---------------------------------------------------------------- PE1 (critical): recovery and restore
test('PE1 probe 1: restoring unsaved changes never deletes a hike adopted from another device meanwhile', async () => {
  const srv = fakeServer(REAL_V1);
  const { storage, session } = await crashWith(srv, (d) => { d.checkins[0].sleep_h = 6.5; });
  const b = makeStore(srv, { storage, session });
  const { recovered } = await b.s.init();
  assert.ok(recovered, 'the lost change is offered back');
  // While "Restore unsaved changes?" is open, a hike is logged on the phone and adopted here.
  srv.edit((d) => { d.hikes.push({ id: 'phone-hike', date: '2025-11-23', name: 'Malham Cove', distance_km: 6 }); });
  await b.s.checkForUpdates({ force: true });
  assert.ok(b.s.get().hikes.some((h) => h.id === 'phone-hike'), 'adopted into the live data');
  await b.s.replaceAll(recovered.data); // exactly what the UI's offerRecovery does
  const d = srv.json();
  assert.ok(d.hikes.some((h) => h.id === 'phone-hike'), 'the hike survives the restore (the init-time snapshot used to delete it)');
  assert.ok(b.s.get().hikes.some((h) => h.id === 'phone-hike'));
  assert.equal(d.checkins[0].sleep_h, 6.5, 'the restored change is saved');
  assert.equal(b.s.getStatus(), 'saved');
  assert.deepEqual(pendingKeys(storage), [], 'the browser copy is cleared once the server has it');
  b.s.dispose();
});

test('PE1 probe 2: a weight changed elsewhere after the offer (80 -> 80.6) is never reverted by the restore', async () => {
  const srv = fakeServer(REAL_V1);
  const { storage, session } = await crashWith(srv, (d) => { d.checkins[0].sleep_h = 7.25; }); // same record as the weight
  const b = makeStore(srv, { storage, session });
  const { recovered } = await b.s.init();
  assert.equal(recovered.data.checkins[0].weight_kg, 80, 'the preview was made before the new weight existed');
  srv.edit((d) => { d.checkins[0].weight_kg = 80.6; });
  await b.s.checkForUpdates({ force: true });
  await b.s.replaceAll(recovered.data);
  assert.deepEqual([srv.json().checkins[0].weight_kg, srv.json().checkins[0].sleep_h], [80.6, 7.25]);
  assert.deepEqual([b.s.get().checkins[0].weight_kg, b.s.getStatus()], [80.6, 'saved']);
  // The same preview passed again (a double click, a stale copy) changes nothing.
  const puts = srv.puts.length;
  await b.s.replaceAll(recovered.data);
  await b.s.replaceAll(cloneJSON(recovered.data));
  assert.deepEqual([srv.puts.length, srv.json().checkins[0].weight_kg], [puts, 80.6], 'a spent snapshot is never applied');
  b.s.dispose();
});

test('PE1: a delta stored without its base (storage was full) surfaces a conflict instead of reverting newer values', async () => {
  const srv = fakeServer(REAL_V1);
  const baseRec = migrate(REAL_V1).checkins[0];
  const storage = fakeStorage();
  storage.set('fitness-hub:pending:dead-tab-0001', JSON.stringify({
    v: 2, tab: 'dead-tab-0001', at: '2025-11-22T07:00:00.000Z', base_etag: null,
    changes: [{ p: ['checkins'], k: '2025-11-22', bh: hashValue(baseRec), v: { ...baseRec, sleep_h: 6.5 } }],
  }));
  srv.edit((d) => { d.checkins[0].weight_kg = 80.6; });
  const { s } = makeStore(srv, { storage });
  const seen = [];
  s.onConflict((c) => seen.push(c));
  const { recovered } = await s.init();
  assert.deepEqual([recovered.conflicts, recovered.conflictItems[0].source], [1, 'recovery']);
  await s.replaceAll(recovered.data);
  assert.equal(s.getStatus(), 'conflict');
  const c = seen.at(-1);
  assert.deepEqual([c.kind, c.count, c.items[0].mine.weight_kg, c.items[0].theirs.weight_kg], ['recovery', 1, 80, 80.6]);
  assert.equal(s.get().checkins[0].weight_kg, 80.6, 'until you choose, the newer value stays');
  assert.equal(srv.puts.length, 0, 'saving waits for the choice');
  assert.equal(pendingKeys(storage).includes('fitness-hub:pending:dead-tab-0001'), true, 'the lost change is still in localStorage');
  assert.deepEqual(await s.checkForUpdates({ force: true }), { stale: false, paused: true });
  await s.resolveConflict('theirs');
  assert.deepEqual([s.getStatus(), srv.json().checkins[0].weight_kg, srv.json().checkins[0].sleep_h], ['saved', 80.6, null]);
  const log = s.conflictLog().at(-1);
  assert.deepEqual([log.kept, log.source, log.mine.sleep_h], ['theirs', 'recovery', 6.5], 'the version you did not keep is archived');
  assert.deepEqual(pendingKeys(storage), []);
  assert.equal(seen.at(-1), null);
  s.dispose();
});

test('PE1 / BL: the same field changed in the lost tab and elsewhere (79.9 vs 80.1) is a conflict, not a silent merge', async () => {
  const srv = fakeServer(REAL_V1);
  const { storage, session } = await crashWith(srv, (d) => { d.checkins.push({ date: '2025-11-23', weight_kg: 79.9, arm_flags: [] }); });
  srv.edit((d) => { d.checkins.push({ date: '2025-11-23', weight_kg: 80.1, sleep_h: 7, arm_flags: [] }); });
  const b = makeStore(srv, { storage, session });
  const seen = [];
  b.s.onConflict((c) => seen.push(c));
  const { recovered } = await b.s.init();
  assert.equal(recovered.conflicts, 1);
  assert.deepEqual([recovered.conflictItems[0].field, recovered.conflictItems[0].mine, recovered.conflictItems[0].theirs], ['weight_kg', 79.9, 80.1]);
  await b.s.replaceAll(recovered.data);
  assert.deepEqual([b.s.getStatus(), seen.at(-1).items[0].mine, seen.at(-1).items[0].theirs], ['conflict', 79.9, 80.1]);
  assert.equal(srv.json().checkins.find((c) => c.date === '2025-11-23').weight_kg, 80.1, 'nothing overwritten');
  await b.s.resolveConflict({ default: 'theirs', [seen.at(-1).items[0].id]: 'mine' });
  const ck = srv.json().checkins.find((c) => c.date === '2025-11-23');
  assert.deepEqual([ck.weight_kg, ck.sleep_h, b.s.conflictLog().at(-1).theirs], [79.9, 7, 80.1], 'your choice wins, the other value is archived, other fields merge');
  b.s.dispose();
  // The live path (a 412 while both tabs are open) raises the same conflict.
  const srv2 = fakeServer(REAL_V1);
  const t = makeStore(srv2);
  await t.s.init();
  t.s.onConflict(() => {});
  srv2.edit((d) => { d.checkins.push({ date: '2025-11-23', weight_kg: 80.1, arm_flags: [] }); });
  t.s.get().checkins.push(migrate({ checkins: [{ date: '2025-11-23', weight_kg: 79.9 }] }).checkins[0]);
  t.s.touch();
  await t.clock.tick(500);
  assert.deepEqual([t.s.getStatus(), t.s.getConflict().items[0].field, t.s.getConflict().kind], ['conflict', 'weight_kg', 'sync']);
  t.s.dispose();
});

test('PE1 legacy: an old v1 browser copy only adds or fills; newer values win and the differences are archived', async () => {
  const srv = fakeServer(REAL_V1);
  srv.edit((d) => { d.checkins[0].weight_kg = 80.6; d.profile.height_cm = 181; d.hikes.push({ id: 'h-new', date: '2025-11-23', name: 'Malham Cove' }); });
  const old = cloneJSON(REAL_V1);
  old.checkins[0].sleep_h = 7; // empty on the server: filled
  old.checkins.push({ date: '2025-11-21', weight_kg: 79.7, arm_flags: [] }); // missing on the server: added
  old.profile.height_cm = 180; // the server has 181: kept
  old.profile.clearances.grip_cleared = '2025-11-21'; // never filled from an old copy (it would unlock exercises)
  old.tests = [{ date: '2025-11-21', test: 'wall-sit', value: 40, notes: '' }]; // a v1 record without an id
  old.kit_owned = { 'Head torch': true };
  const storage = fakeStorage();
  storage.set('fitness-hub:pending', JSON.stringify({ at: '2025-11-21T10:00:00Z', data: old }));
  const { s } = makeStore(srv, { storage });
  const { recovered } = await s.init();
  const fields = recovered.conflictItems.filter((x) => x.source === 'legacy').map((x) => x.path.join('.')).sort();
  assert.deepEqual(fields, ['checkins.2025-11-22.weight_kg', 'profile.clearances.grip_cleared', 'profile.height_cm']);
  await s.replaceAll(recovered.data);
  const d = srv.json();
  assert.deepEqual([d.checkins.find((c) => c.date === '2025-11-22').weight_kg, d.profile.height_cm, d.profile.clearances.grip_cleared], [80.6, 181, null], 'never overwritten');
  assert.deepEqual([d.checkins.find((c) => c.date === '2025-11-22').sleep_h, d.checkins.some((c) => c.date === '2025-11-21')], [7, true], 'filled and added');
  assert.deepEqual([d.tests.length, typeof d.tests[0].id, d.kit_owned['Head torch'], d.hikes.some((h) => h.id === 'h-new')], [1, 'string', true, true]);
  const log = s.conflictLog().filter((x) => x.source === 'legacy');
  assert.equal(log.length, 3);
  assert.ok(log.every((x) => x.kept === 'theirs'));
  assert.deepEqual(pendingKeys(storage), []);
  s.dispose();
  // Pure: the same rules without the store.
  const live = migrate(REAL_V1);
  live.tests.push(migrate({ schema_version: 1, tests: [{ date: '2025-11-21', test: 'wall-sit', value: 40 }] }).tests[0]);
  const r = legacyFill(live, { schema_version: 1, tests: [{ date: '2025-11-21', test: 'wall-sit', value: 40, notes: 'felt easy' }], profile: { name: 'Sam' } });
  assert.deepEqual([live.tests.length, live.tests[0].notes, r.conflicts.length], [1, 'felt easy', 0], 'an id-less v1 record is matched by its content, not duplicated');
  assert.deepEqual(applyRecovery(live, [null, { legacy: true, data: 'garbage' }]).conflicts, []);
});

test('PE1: a reload\'s unsaved changes are not overwritten by new edits made before you answer the restore question', async () => {
  const srv = fakeServer(REAL_V1);
  const { storage, session } = await crashWith(srv, (d) => { d.profile.rhr_baseline = 57; });
  const b = makeStore(srv, { storage, session }); // the same tab, reloaded
  const { recovered } = await b.s.init();
  assert.ok(recovered);
  srv.down = true;
  b.s.get().profile.height_cm = 182; // typed while the dialog is open
  b.s.touch();
  await b.s.flush();
  const stored = pendingKeys(storage).map((k) => JSON.parse(storage.get(k)).changes.map((c) => c.p.join('.')).join(','));
  assert.deepEqual(stored.sort(), ['profile.height_cm', 'profile.rhr_baseline'], 'two deltas, one per page load');
  srv.down = false;
  await b.s.replaceAll(recovered.data);
  await b.clock.tick(500);
  assert.deepEqual([srv.json().profile.rhr_baseline, srv.json().profile.height_cm, b.s.getStatus()], [57, 182, 'saved']);
  assert.deepEqual(pendingKeys(storage), []);
  b.s.dispose();
});

// ---------------------------------------------------------------- CL1 / SPEC 5.8: readiness, revised
test('CL1 / SPEC 5.8: red at arm pain 7, rising pain, fasting and weight-only check-ins', () => {
  const days = (vals, end = '2025-11-21') => vals.map((v, i) => ({ date: addDays(end, i - vals.length + 1), arm_pain: v }));
  let r = readiness({ date: '2025-11-22', arm_pain: 7 });
  assert.deepEqual([r.level, r.messages, r.stop], ['red', [READINESS_MESSAGES.red], true]);
  assert.equal(READINESS_TEXT.red, 'Stop. No training today, including your physio exercises, until you’ve been advised. Contact your fracture clinic today, or NHS 111 / 999 as the red-flag guidance says.');
  assert.equal(readiness({ date: '2025-11-22', arm_pain: 6.9 }).level, 'amber');
  assert.deepEqual([READINESS_RULES.redPain, READINESS_RULES.risingDelta, READINESS_RULES.rhrMinSinceChange], [7, 2, 5]);
  // Rising pain: 2 or more above the 7-day average, with at least 3 earlier readings.
  const hist = days([1, 1, 1]);
  r = readiness({ date: '2025-11-22', arm_pain: 3 }, hist);
  assert.deepEqual([r.level, r.risingPain, r.messages, r.painRef], ['amber', true, [READINESS_MESSAGES.risingPain], { value: 1, count: 3 }]);
  assert.equal(READINESS_MESSAGES.risingPain, 'Rising arm pain can be the red flag “pain getting worse”. If it keeps rising, or you’re unsure, call your fracture clinic today.');
  assert.equal(readiness({ date: '2025-11-22', arm_pain: 2.9 }, hist).level, 'green', 'under 2 above');
  assert.equal(readiness({ date: '2025-11-22', arm_pain: 3 }, days([1, 1])).level, 'green', 'needs 3 earlier readings');
  assert.equal(painReference([...days([1, 1]), { date: '2025-11-14', arm_pain: 1 }], '2025-11-22'), null, '8 days ago is outside the week');
  // Fasting periods: amber all day (even without a check-in), with the fasting message.
  const profile = { fasting_periods: [{ start: '2026-01-12', end: '2026-01-16', label: 'Planned fast', approximate: true }] };
  r = readiness({ date: '2026-01-12', sleep_h: 8, energy: 4, arm_pain: 0, soreness: 1 }, [], profile);
  assert.deepEqual([r.level, r.fasting.label, r.fasting.approximate, r.messages, r.holdLoads], ['amber', 'Planned fast', true, [READINESS_MESSAGES.fasting], true]);
  assert.equal(fastingPeriods({ fasting_periods: [{ start: '2026-01-12', end: '2026-01-13', approx: false }] })[0].approximate, false, 'the older spelling is read too');
  assert.equal(READINESS_MESSAGES.fasting, 'Fasting: if you can, train after you break your fast. Stop at any dizziness or light-headedness. No new lifts this period.');
  assert.equal(readiness({ date: '2026-01-17', sleep_h: 8 }, [], profile).level, 'green', 'the day after');
  assert.equal(readinessOn({ checkins: [], profile }, '2026-01-16').level, 'amber', 'no check-in on a fasting day');
  assert.equal(readinessOn({ checkins: [], profile }, '2026-01-17').level, 'unknown');
  assert.equal(readiness({ date: '2026-01-14', arm_pain: 8 }, [], profile).level, 'red', 'red beats fasting');
  assert.deepEqual(readiness({ date: '2026-01-14', arm_pain: 8 }, [], profile).messages, [READINESS_MESSAGES.red], 'no "train after you break your fast" on a red day');
  // A weight-only check-in is not a check-in.
  assert.equal(readinessOn({ checkins: [{ date: '2025-11-22', weight_kg: 80.6, steps: 9000 }], profile: {} }, '2025-11-22').level, 'unknown');
  assert.equal(readinessOn({ checkins: [{ date: '2025-11-22', weight_kg: 80.6, sleep_h: 8 }], profile: {} }, '2025-11-22').level, 'green');
  assert.equal(readinessOn({ checkins: [{ date: '2025-11-22', weight_kg: 80.6, mood: 4 }], profile: {} }, '2025-11-22').level, 'green', 'any morning answer counts');
  assert.deepEqual([countsAsCheckin({ weight_kg: 70, steps: 1, notes: 'x' }), countsAsCheckin({ arm_flags: 'fever_unwell' }), countsAsCheckin(null)], [false, true, false]);
  // Two check-ins on one date (a merge can leave both): the worst answer and every flag count.
  const dup = { checkins: [{ date: '2025-11-22', sleep_h: 8, energy: 4 }, { date: '2025-11-22', arm_flags: ['swelling_new'] }], profile: {} };
  assert.equal(readinessOn(dup, '2025-11-22').level, 'red');
  assert.equal(readinessOn({ data: dup }, '2025-11-22').level, 'red', 'a view ctx works too');
  assert.deepEqual(combineCheckins([{ sleep_h: 8, arm_pain: 1 }, { sleep_h: 5, arm_pain: 4 }]).sleep_h, 5);
  assert.deepEqual(fastingPeriods({ fasting_periods: [{ start: 'x' }, { start: '2026-01-14', end: '2026-01-12' }, null, { start: '2026-01-12' }] }).map((x) => [x.start, x.end]), [['2026-01-12', '2026-01-12']]);
});

test('CL1 / SPEC 5.8: the resting-HR rule re-baselines after profile.rhr_method_changes (5 readings needed)', () => {
  const ck = [];
  for (let i = 0; i < 7; i++) ck.push({ date: addDays('2025-11-26', i), rhr: 60, sleep_h: 8 }); // the old wearable: 60
  const profile = { rhr_baseline: 58, rhr_method_changes: ['2025-12-03'] }; // a manual pulse reads 66
  assert.equal(readiness({ date: '2025-12-03', rhr: 66, sleep_h: 8 }, ck, {}).level, 'amber', 'without the change recorded: a false amber');
  let r = readiness({ date: '2025-12-03', rhr: 66, sleep_h: 8 }, ck, profile);
  assert.deepEqual([r.level, r.rhrRef, r.rhrRebaseline.readings, r.rhrRebaseline.active, r.rhrBlocked], ['green', null, 0, true, { since: '2025-12-03', count: 0 }]);
  const after = [...ck];
  for (let i = 0; i < 5; i++) after.push({ date: addDays('2025-12-03', i), rhr: 66, sleep_h: 8 });
  r = readiness({ date: '2025-12-08', rhr: 70, sleep_h: 8 }, after, profile);
  assert.deepEqual([r.level, r.rhrRef.value, r.rhrRef.count, r.rhrRef.threshold, r.rhrRebaseline.active, r.rhrBlocked], ['green', 66, 5, 71, false, null]);
  assert.equal(readiness({ date: '2025-12-08', rhr: 71, sleep_h: 8 }, after, profile).level, 'amber', 'only new-method readings in the average');
  assert.equal(readiness({ date: '2025-12-07', rhr: 90, sleep_h: 8 }, after, profile).level, 'green', '4 readings since the change: not yet');
  assert.equal(rhrMethodChangeOn({ rhr_method_changes: [{ date: '2025-12-03' }, '2026-01-11', 'junk'] }, '2026-01-01'), '2025-12-03');
  assert.deepEqual(rhrMethodChanges({ rhr_method_changes: ['2026-01-11', { date: '2025-12-03' }, '2026-01-11'] }), ['2025-12-03', '2026-01-11']);
  // QA4: the hint can show the true whole-number threshold (average 60.2 -> amber from 66).
  assert.equal(rhrReference([{ date: '2025-11-19', rhr: 60 }, { date: '2025-11-20', rhr: 60 }, { date: '2025-11-21', rhr: 60.6 }], '2025-11-22').threshold, 66);
});

test('readinessHistory matches readiness() day by day with rising pain, method changes and fasting', () => {
  const rnd = seeded(11);
  const checkins = [];
  for (let i = 0; i < 400; i++) {
    if (rnd() < 0.15) continue;
    checkins.push({ date: addDays('2025-01-02', i), rhr: rnd() < 0.2 ? null : 52 + Math.round(rnd() * 16), sleep_h: 5 + rnd() * 4, arm_pain: rnd() < 0.2 ? null : Math.floor(rnd() * 9), soreness: Math.floor(rnd() * 9), energy: 1 + Math.floor(rnd() * 5), arm_flags: rnd() < 0.01 ? ['fever_unwell'] : [] });
  }
  // Fast A is around the second method change, so both rules apply on the same days.
  const profile = { rhr_baseline: 58, rhr_method_changes: ['2025-03-02', { date: '2025-08-16' }], fasting_periods: [{ start: '2025-08-14', end: '2025-08-18', label: 'Fast A' }, { start: '2025-06-02', end: '2025-06-04' }] };
  const hist = readinessHistory(checkins.slice().reverse(), profile);
  let amber = 0;
  for (const c of checkins) {
    const a = readiness(c, checkins, profile);
    const b = hist.get(c.date);
    if (a.level === 'amber') amber++;
    assert.deepEqual([b.level, b.reasons, b.messages, b.rhrRef?.value ?? null, b.painRef?.value ?? null, b.fasting?.start ?? null],
      [a.level, a.reasons, a.messages, a.rhrRef?.value ?? null, a.painRef?.value ?? null, a.fasting?.start ?? null], c.date);
  }
  assert.ok(amber > 20, 'the sample exercises the amber rules');
});

// ---------------------------------------------------------------- PE5 / QA1: progression
test('PE5 / QA1: progression only after every planned set was logged with actual values; hold in deload, amber, red and fasting', () => {
  const full = [{ kg: 40, reps: 12, done: true }, { kg: 40, reps: 12, done: true }, { kg: 40, reps: 12, done: true }];
  assert.equal(suggestProgression({ reps: '8-12', lastSets: full, increment: 10 }).kind, 'add-load');
  const partial = [...full.slice(0, 2), { kg: 40, reps: null, done: false }];
  let s = suggestProgression({ reps: '8-12', lastSets: partial, increment: 10 });
  assert.deepEqual([s.kind, s.reason, s.kg], ['hold', 'incomplete', 40]);
  assert.match(s.text, /2 of 3 sets/);
  assert.equal(suggestProgression({ reps: '8-12', lastSets: full.slice(0, 2), plannedSets: 3, increment: 10 }).reason, 'incomplete');
  assert.equal(suggestProgression({ reps: '8-12', lastSets: [...full.slice(0, 2), { kg: 40, reps: 12, done: true, placeholder: true }], increment: 10 }).reason, 'incomplete', 'a prefilled target is not a performed set');
  assert.equal(suggestProgression({ reps: '8-12', lastSets: [...full.slice(0, 2), { kg: null, reps: 12, done: true }], increment: 10 }).reason, 'incomplete', 'a loaded exercise needs its kg');
  assert.equal(suggestProgression({ reps: '8-12', lastSets: full, complete: false, increment: 10 }).reason, 'incomplete');
  assert.deepEqual([isPerformedSet({ reps: 10, done: true }), isPerformedSet({ reps: 10, done: true }, { loaded: true }), isPerformedSet({ reps: '', done: true })], [true, false, false]);
  for (const [opts, reason] of [[{ deload: true }, 'deload'], [{ easyDay: true }, 'easy-day'], [{ readiness: 'amber' }, 'easy-day'], [{ fasting: true }, 'fasting'],
    [{ readiness: { level: 'amber', fasting: { start: '2026-01-12' } } }, 'fasting'], [{ readiness: 'red' }, 'red'], [{ red: true, deload: true }, 'red']]) {
    s = suggestProgression({ reps: '8-12', lastSets: full, increment: 10, ...opts });
    assert.deepEqual([s.kind, s.reason], ['hold', reason], JSON.stringify(opts));
    if (reason !== 'red') { assert.equal(s.kg, 40, 'same load'); assert.ok(s.text.startsWith(HOLD_TEXT), s.text); }
  }
  assert.equal(HOLD_TEXT, 'Hold: same load, RIR 3–4', 'the SPEC 5.2 wording');
  assert.equal(holdReason({ easy: true }), 'easy-day', 'the UI\'s spelling works too');
  s = suggestProgression({ reps: '8-12', lastSets: [], increment: 10, fasting: true });
  assert.deepEqual([s.kind, s.reason, s.kg], ['hold', 'fasting', null]);
  assert.match(s.text, /no new lifts/);
  assert.equal(holdReason({}), null);
  // lastPerformance tells it how many sets were planned, even when only last.sets is passed (as the UI does).
  const data = { workouts: [wk('w', '2025-11-24', 'str-a', { exercises: [{ exercise: 'leg-press', sets: partial }] })] };
  const last = lastPerformance(data, 'leg-press', '2025-12-01');
  assert.deepEqual([last.sets.length, last.planned, last.complete, last.rows.length], [2, 3, false, 3]);
  assert.equal(suggestProgression({ reps: '8-12', lastSets: last.sets, increment: 10 }).reason, 'incomplete');
  assert.equal(JSON.stringify(last.sets), JSON.stringify(partial.slice(0, 2)), 'the annotation is invisible to JSON');
  const timed = { workouts: [wk('t', '2025-11-24', 'str-a', { exercises: [{ exercise: 'wall-sit', sets: [{ seconds: 45, done: true }, { seconds: 40, done: true }] }] })] };
  assert.equal(lastPerformance(timed, 'wall-sit', '2025-12-01').complete, true, 'timed sets need their seconds');
});

// ---------------------------------------------------------------- QA2 / SPEC 5.2: week overrides
test('QA2 / SPEC 5.2: week overrides zone_cap, circuit_minutes and rounds (what is shown and what the timers get)', () => {
  const iv = { exercise: 'bike-upright', warmup_min: 8, cooldown_min: 5, intervals: { work_s: 30, rest_s: 90, rounds: 6, work_zone: 'Z4-Z5', rest_zone: 'Z1' } };
  let r = resolveBlock(iv, { week: 2, override: { week: 2, zone_cap: 'Z3', rounds: 4 } });
  assert.deepEqual([r.intervals.rounds, r.roundsPlanned, r.roundsOverridden, r.intervals.work_zone, r.workZonePlanned, r.zoneCapped, r.zoneCap], [4, 6, true, 'Z3', 'Z4-Z5', true, 'Z3']);
  assert.equal(r.easyMinutes, Math.round(8 + 5 + (4 * 120) / 60), 'the easy-day time follows the overridden rounds');
  r = resolveBlock(iv, { override: { deload: true, rounds: 3 } });
  assert.deepEqual([r.intervals.rounds, r.intervals.work_zone], [3, 'Z3'], 'explicit rounds are never halved again; the deload cap stays');
  assert.equal(resolveBlock(iv, { override: { deload: true } }).intervals.rounds, 3, 'a deload alone still halves');
  assert.equal(resolveBlock(iv, { override: { deload: true, zone_cap: 'Z2' } }).intervals.work_zone, 'Z2', 'the stricter cap wins');
  const cardio = { exercise: 'incline-walk', minutes: 30, zone: 'Z2-Z4' };
  r = resolveBlock(cardio, { override: { zone_cap: 'z3' } });
  assert.deepEqual([r.zone, r.zonePlanned, r.zoneCapped], ['Z2-Z3', 'Z2-Z4', true]);
  r = resolveBlock(cardio, { override: { zone_cap: 'Z3' }, easyDay: true });
  assert.deepEqual([r.zone, r.zonePlanned, r.easyZoneCapped], ['Z2', 'Z2-Z4', true]);
  const circ = { circuit: { minutes: 12, rounds: null, items: [{ exercise: 'sled-drag-forward-belt' }] }, zone: 'Z2-Z3' };
  r = resolveBlock(circ, { override: { deload: true, circuit_minutes: 5, zone_cap: 'Z2' } });
  assert.deepEqual([r.circuit.minutes, r.circuit.minutesPlanned, r.circuitMinutesOverridden, r.zone], [5, 12, true, 'Z2']);
  assert.equal(blockTarget(r), '5 min circuit, Z2');
  r = resolveBlock(iv, { override: { zone_cap: 'Z9', rounds: 0, circuit_minutes: 'x' } });
  assert.deepEqual([r.intervals.rounds, r.intervals.work_zone, r.zoneCapped], [6, 'Z4-Z5', undefined], 'invalid values are ignored');
  assert.deepEqual(overrideBlockFields({ zone_cap: 'Z3', rounds: '4', circuit_minutes: 5.5 }), { zoneCap: 3, circuitMinutes: 5.5, rounds: 4 });
  assert.deepEqual([zoneNumber('Z3'), zoneNumber(' z2 '), zoneNumber(4), zoneNumber('Zone 3'), zoneNumber(7)], [3, 2, 4, null, null]);
  // Through a program: the fixture's p1 week 2 is a Z3 primer with 4 rounds; week 4's circuit is 5 minutes.
  const fx = JSON.parse(fs.readFileSync(`${HUB}public/dev-fixtures/program.json`, 'utf8'));
  const pf = profile({}, { program_start: '2025-11-24' });
  let plan = plannedOn(fx, pf, '2025-12-04');
  let bl = resolveSession(plan.sessions[0].session, { week: plan.pos.week, override: plan.override });
  assert.deepEqual([plan.pos.week, plan.sessions[0].sessionId, bl[0].intervals.rounds, bl[0].intervals.work_zone], [2, 'intervals', 4, 'Z3']);
  plan = plannedOn(fx, pf, '2025-12-19');
  bl = resolveSession(plan.sessions[0].session, { week: plan.pos.week, override: plan.override });
  assert.equal(bl.find((x) => x.kind === 'circuit').circuit.minutes, 5);
});

// ---------------------------------------------------------------- QA3 / QA5 / PM7 / PM11: counting
test('QA3 / QA5 / PM7 / PM11: add-ons, alternates, ad-hoc sessions and the rehab add-on in the counts', () => {
  const prog = cloneJSON(PROGRAM);
  prog.alternates = { short: 'short', travel: 'travel' };
  prog.sessions.short = { name: 'Short', type: 'strength', blocks: [] };
  prog.sessions.travel = { name: 'Travel', type: 'circuit', blocks: [] };
  prog.sessions.crossed = { name: 'Good arm', type: 'strength', blocks: [] };
  prog.addons = [{ id: 'crossed', gate: 'none', until_gate: null, days: ['mon', 'wed', 'fri'], session: 'crossed' }, ...PROGRAM.addons.map((a) => ({ ...a, days: ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] }))];
  const cl = { clinic_light: '2025-11-02' };
  const data = {
    arm: { physio_exercises: [] },
    workouts: [
      wk('m', '2025-11-24', 'str-a'), wk('mx', '2025-11-24', 'crossed'), wk('mr', '2025-11-24', 'rehab'),
      wk('t', '2025-11-25', 'adhoc', { session_type: 'cardio' }), // an ad-hoc walk on the engine day
      wk('w', '2025-11-26', 'short'), wk('wx', '2025-11-26', 'crossed'), // Strength B replaced by the short alternate
      wk('f', '2025-11-28', 'str-a'), wk('f2', '2025-11-28', 'str-a'), wk('fx', '2025-11-28', 'crossed'), // logged twice
    ],
  };
  const ctx = makeCtx({ program: prog, profile: profile(cl), data, today: '2025-11-30' });
  const mon = dayInfo(ctx, '2025-11-24');
  assert.deepEqual([mon.mainDone, mon.status, mon.addons.map((a) => a.sessionId)], [1, 'done', ['crossed']]);
  assert.deepEqual(mon.plan.hiddenAddons.map((a) => [a.sessionId, a.reason]), [['rehab', 'waiting-physio']], 'PM11: rehab waits for the physio programme');
  assert.deepEqual(mon.roles.map((x) => x.role), ['main', 'addon', 'addon']);
  const tue = dayInfo(ctx, '2025-11-25');
  assert.deepEqual([tue.mainDone, tue.status, tue.roles[0].role], [0, 'missed', 'extra'], 'QA5: an ad-hoc walk does not complete the planned session');
  const wed = dayInfo(ctx, '2025-11-26');
  assert.deepEqual([wed.mainDone, wed.altDone, wed.mainCovered, wed.status, wed.viaAlternate], [0, 1, 1, 'done', true], 'PM7: an alternate counts as a session done');
  assert.deepEqual(dayInfo(ctx, '2025-11-28').roles.map((x) => x.role), ['main', 'repeat', 'addon']);
  const s = weekSummary(ctx, '2025-11-24');
  assert.equal(s.strengthDone, 2, 'QA3: Mon + Fri only; add-ons, the alternate and the repeat never count (it said 7 of 3 before)');
  assert.deepEqual([s.mainPlanned, s.mainDone, s.mainDoneStrict, s.altDone, s.adherencePct], [6, 3, 2, 1, 50]);
  assert.deepEqual([s.addonPlanned, s.addonDone], [3, 3], 'the hidden rehab add-on is not planned or counted');
  assert.deepEqual(plannedOn(prog, profile(cl), '2025-11-26').sessions.map((x) => x.sessionId), ['str-b', 'crossed', 'rehab'], 'plannedOn itself is unaffected (alternates never appear)');
  // Once the physio programme is entered, the rehab add-on appears and counts.
  data.arm.physio_exercises = [{ exercise: 'rehab-putty-grip', dose: '3 × 10' }];
  const s2 = weekSummary(makeCtx({ program: prog, profile: profile(cl), data, today: '2025-11-30' }), '2025-11-24');
  assert.deepEqual([s2.addonPlanned, s2.addonDone, s2.strengthDone], [10, 4, 2]);
  assert.deepEqual([physioProgrammeReady({ arm: { physio_exercises: [{ exercise: '  ' }] } }), physioProgrammeReady(data)], [false, true]);
  assert.deepEqual([isRehabAddon({ id: 'rehab' }), isRehabAddon({ id: 'x', session: 'rehab' }, prog), isRehabAddon({ id: 'crossed', session: 'crossed' }, prog)], [true, true, false]);
  assert.deepEqual([[...alternateIds(prog)].sort(), [...addonSessionIds(prog)].sort()], [['short', 'travel'], ['crossed', 'rehab']]);
  assert.deepEqual(alternatesOf({ alternates: { short: 'ghost' }, sessions: {} }), { short: null, travel: null });
  // Never miss twice: the short session keeps the streak alive.
  const run = { workouts: [wk('a', '2025-11-24', 'str-a'), wk('b', '2025-11-25', 'engine'), wk('c', '2025-11-26', 'short')] };
  assert.equal(streak(makeCtx({ program: prog, profile: profile(), data: run, today: '2025-11-26' })), 3);
  assert.deepEqual(workoutRoles([{ session_id: 'x' }], [], null).map((x) => x.role), ['extra']);
});

test('QA6: weekly figures, trends and the ladder ignore entries dated after today', () => {
  const data = {
    checkins: [{ date: '2025-11-25', weight_kg: 74, protein_g: 140, sleep_h: 7 }, { date: '2025-11-28', weight_kg: 90, protein_g: 200, sleep_h: 2 }],
    workouts: [wk('m', '2025-11-24', 'str-a'), wk('f', '2025-11-28', 'str-a')],
    hikes: [{ id: 'h', date: '2025-11-29', duration_min: 120 }],
  };
  const s = weekSummary(makeCtx({ program: PROGRAM, profile: profile(), data, today: '2025-11-26' }), '2025-11-24');
  assert.deepEqual([s.strengthDone, s.proteinLogged, s.sleepAvg, s.z2Min, s.workouts.length], [1, 1, 7, 0, 1]);
  assert.deepEqual(seriesUntil(data, 'weight_kg', '2025-11-26').map((p) => p.value), [74]);
  assert.deepEqual(series(data, 'weight_kg', 'checkins', { from: '2025-11-26' }).map((p) => p.value), [90]);
  const pts = data.checkins.map((c) => ({ date: c.date, value: c.weight_kg }));
  const t = trendUntil(pts, '2025-11-26');
  assert.deepEqual([t.points.length, t.latest.value, t.mean7, t.rolling.map((p) => p.value)], [1, 74, 74, [74]]);
  assert.deepEqual(rollingMean(pts, 7, { to: '2025-11-26' }).map((p) => p.value), [74]);
  assert.equal(meanBetween([{ date: '2025-11-25', value: 2 }, { date: '2025-11-27', value: 4 }], '2025-11-21', '2025-11-26'), 2);
  assert.equal(ladderStatus([{ level: 1, gate: 'none', criteria: { distance_km: 5 } }], { hikes: [{ date: '2025-12-02', distance_km: 6 }] }, {}, { today: '2025-11-26' })[0].done, false);
});

// ---------------------------------------------------------------- SPEC 5.2: fail closed, unavailable exercises
test('SPEC 5.2 fail closed: unknown exercise ids are locked (gateOf / isLocked)', () => {
  const lib = new Map([['leg-press', { id: 'leg-press', gate: 'none' }], ['farmer-carry', { id: 'farmer-carry', gate: 'grip_cleared' }], ['odd', { id: 'odd', gate: 'banana' }]]);
  assert.deepEqual(['leg-press', 'farmer-carry', 'odd', 'ghost', ''].map((id) => exerciseGate(id, lib)), ['none', 'grip_cleared', 'full_clearance', null, null]);
  assert.equal(exerciseLocked('ghost', { full_clearance: '2025-01-02' }, '2026-01-02', lib), true, 'unknown: locked even after full clearance');
  assert.equal(exerciseLocked('leg-press', {}, '2025-11-24', lib), false);
  assert.deepEqual([exerciseLocked('farmer-carry', { grip_cleared: '2026-01-11' }, '2026-01-10', lib), exerciseLocked('farmer-carry', { grip_cleared: '2026-01-11' }, '2026-01-11', lib)], [true, false]);
  const saved = content.exById;
  try {
    content.exById = lib;
    assert.equal(gateOf('ghost'), null);
    assert.equal(gateOf('farmer-carry'), 'grip_cleared');
    assert.equal(isLocked('ghost', '2029-01-02', { profile: { clearances: { full_clearance: '2025-01-02' } } }), true);
    assert.equal(isLocked('leg-press', '2025-11-24', { profile: { clearances: {} } }), false);
    assert.equal(isLocked('farmer-carry', '2026-01-11', { clearances: { grip_cleared: '2026-01-11' } }), false, 'a profile works too');
    content.exById = new Map();
    assert.equal(isLocked('leg-press', '2025-11-24', {}), true, 'no library loaded: everything is locked');
  } finally {
    content.exById = saved;
  }
});

test('SPEC 5.2: profile.unavailable_exercises (migration default, isAvailable, your edits kept, validation, merging)', () => {
  const m = migrate(REAL_V1);
  assert.deepEqual(UNAVAILABLE_DEFAULT, ['sled-drag-forward-belt', 'sled-drag-backward-belt', 'cable-kickback-ankle', 'cable-hip-abduction-ankle', 'cable-hip-adduction-ankle']);
  assert.deepEqual([m.profile.unavailable_exercises, m.profile.fasting_periods, m.profile.rhr_method_changes], [[...UNAVAILABLE_DEFAULT], [], []]);
  assert.deepEqual([isAvailable('sled-drag-forward-belt', m), isAvailable('leg-press', m), isAvailableStore('cable-kickback-ankle', m.profile), isAvailableS('cable-kickback-ankle', {})], [false, true, false, false]);
  assert.deepEqual(migrate({ ...m, profile: { ...m.profile, unavailable_exercises: ['cable-kickback-ankle'] } }).profile.unavailable_exercises, ['cable-kickback-ankle'], 'your edits are kept');
  assert.deepEqual(migrate({ ...m, profile: { ...m.profile, unavailable_exercises: [] } }).profile.unavailable_exercises, [], 'an empty list sticks');
  const bad = migrate({ schema_version: 2, profile: { unavailable_exercises: 'sled', fasting_periods: [{ start: '2026-01-12T00:00', end: '2026-01-16' }, 5], rhr_method_changes: ['2025-12-3', { date: '2025-12-06' }, 7] } });
  assert.deepEqual(bad.profile.unavailable_exercises, [...UNAVAILABLE_DEFAULT]);
  assert.deepEqual(bad.profile.fasting_periods, [{ start: '2026-01-12', end: '2026-01-16' }]);
  assert.deepEqual(bad.profile.rhr_method_changes, ['2025-12-03', { date: '2025-12-06' }]);
  assert.deepEqual(bad.quarantine.map((q) => q.from).sort(), ['profile.fasting_periods[]', 'profile.rhr_method_changes[]', 'profile.unavailable_exercises']);
  assert.deepEqual(migrate(bad), bad, 'idempotent');
  assert.match(errs({ schema_version: 1, profile: { unavailable_exercises: 'x' } })[0], /list of exercise ids/);
  assert.match(errs({ schema_version: 1, profile: { fasting_periods: [{ start: '2026-01-16', end: '2026-01-12' }] } })[0], /ends \(2026-01-12\) before it starts/);
  assert.match(errs({ schema_version: 1, profile: { fasting_periods: [{ start: '2026-01-12' }] } })[0], /fasting_periods\[0\]\.end: is missing/);
  assert.match(errs({ schema_version: 1, profile: { rhr_method_changes: [5] } })[0], /should be a date/);
  assert.equal(errs({ schema_version: 1, profile: { rhr_method_changes: ['2025-12-03', { date: '2025-12-06' }], fasting_periods: [{ start: '2026-01-12', end: '2026-01-16', label: 'Planned fast', approx: true }] } }).length, 0);
  const b0 = migrate(REAL_V1);
  const l = cloneJSON(b0);
  const r = cloneJSON(b0);
  l.profile.unavailable_exercises = l.profile.unavailable_exercises.filter((x) => x !== 'cable-kickback-ankle');
  r.profile.unavailable_exercises.push('rower');
  assert.deepEqual(mergeData(b0, l, r).result.profile.unavailable_exercises.slice().sort(), [...UNAVAILABLE_DEFAULT.filter((x) => x !== 'cable-kickback-ankle'), 'rower'].sort(), 'two devices editing the list merge as a set');
  // Migration keeps the UI-owned keys and anything unknown, untouched.
  const ui = { schema_version: 2, ui: { onboarding: { completed_at: 'x' }, drafts: [1, { a: 2 }] }, goals: { list: [], focus: 'sleep' }, kit_owned: { Boots: true }, later: [{ x: 1 }] };
  const mu = migrate(ui);
  assert.deepEqual([mu.ui, mu.goals, mu.kit_owned, mu.later], [ui.ui, ui.goals, ui.kit_owned, ui.later]);
  assert.equal(mu.quarantine, undefined, 'nothing quarantined');
});

// ---------------------------------------------------------------- SPEC 5.7a: build id
test('SPEC 5.7a build id: read at boot, X-Hub-Build on every PUT, a 409 keeps the changes and reports build-mismatch', async () => {
  const srv = fakeServer(REAL_V1, { build: 'b1' });
  const storage = fakeStorage();
  const session = fakeStorage();
  const { s, clock } = makeStore(srv, { storage, session });
  const events = [];
  s.onBuildMismatch((e) => events.push(e));
  await s.init();
  assert.equal(s.syncInfo().build, 'b1');
  s.get().profile.height_cm = 179;
  s.touch();
  await clock.tick(500);
  assert.deepEqual([srv.builds.at(-1), s.getStatus()], ['b1', 'saved']);
  srv.build = 'b2'; // the hub is updated while this tab is open
  s.get().profile.height_cm = 180;
  s.touch();
  await clock.tick(500);
  assert.equal(s.getStatus(), 'build-mismatch');
  assert.equal(srv.json().profile.height_cm, 179, 'the old page wrote nothing');
  assert.deepEqual([events.length, events[0].server, events[0].client, events[0].message], [1, 'b2', 'b1', BUILD_MISMATCH_TEXT]);
  assert.equal(BUILD_MISMATCH_TEXT, 'The hub was updated. Reload to continue.');
  assert.deepEqual([s.syncInfo().error.message, s.syncInfo().buildMismatch.server], [BUILD_MISMATCH_TEXT, 'b2']);
  const deltas = () => pendingKeys(storage).flatMap((k) => JSON.parse(storage.get(k)).changes.map((c) => `${c.p.join('.')}=${c.v}`));
  assert.ok(deltas().includes('profile.height_cm=180'), 'local changes are kept in localStorage');
  const n = srv.puts.length;
  s.get().profile.name = 'T';
  s.touch();
  await clock.tick(120000);
  assert.equal(srv.puts.length, n, 'no retry loop against the new hub');
  assert.ok(deltas().includes('profile.name=T'), 'later edits are kept too');
  assert.deepEqual([s.hasUnsaved(), s.onBeforeUnload()], [true, false], 'the reload is safe: the browser need not warn');
  s.dispose();
  // The reload: the new page reads b2 and offers the changes back.
  const b = makeStore(srv, { storage, session });
  const { recovered } = await b.s.init();
  assert.equal(b.s.syncInfo().build, 'b2');
  await b.s.replaceAll(recovered.data);
  assert.deepEqual([srv.json().profile.height_cm, srv.json().profile.name, srv.builds.at(-1), b.s.getStatus()], [180, 'T', 'b2', 'saved']);
  b.s.dispose();
});

test('build id: health down at boot is retried before the first PUT; focus notices an update; a rollback clears it; "dev" never checks', async () => {
  const srv = fakeServer(REAL_V1, { build: 'b1' });
  srv.healthDown = true;
  const { s, clock } = makeStore(srv);
  await s.init();
  assert.equal(s.syncInfo().build, null);
  srv.healthDown = false;
  s.get().profile.name = 'x';
  s.touch();
  await clock.tick(500);
  assert.deepEqual([srv.builds.at(-1), s.getStatus()], ['b1', 'saved'], 'one more health check, then the header is sent');
  srv.build = 'b2';
  assert.equal((await s.checkBuild({ force: true })).mismatch, true);
  assert.equal(s.getStatus(), 'build-mismatch', 'shown before any save is refused');
  srv.build = 'b1';
  await s.retry();
  await clock.tick(500);
  assert.deepEqual([s.getStatus(), s.syncInfo().buildMismatch], ['saved', null]);
  s.dispose();
  const dev = fakeServer(REAL_V1); // build "dev": the server doesn't check
  const d = makeStore(dev);
  await d.s.init();
  d.s.get().profile.name = 'y';
  d.s.touch();
  await d.clock.tick(500);
  assert.deepEqual([dev.builds.at(-1), d.s.getStatus()], ['dev', 'saved']);
  d.s.dispose();
});

// ---------------------------------------------------------------- PE4: timeouts and the save watchdog
test('PE4: api.js keeps its time limit until the body has been read (a stalled body times out)', async () => {
  const realFetch = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (url, init = {}) => {
    seen.push(init);
    const never = () => new Promise(() => {});
    return { status: 200, ok: true, headers: { get: () => null }, text: never, json: never };
  };
  try {
    const t0 = Date.now();
    await assert.rejects(apiGetDataWithEtag({ timeoutMs: 40 }), (e) => e instanceof HttpError && e.status === 0 && e.timeout === true && /took too long/.test(e.message));
    assert.ok(Date.now() - t0 < 3000);
    assert.equal(seen.at(-1).signal.aborted, true, 'the request is aborted as well');
    await assert.rejects(apiPutData('{}', { etag: '"a"', timeoutMs: 40 }), (e) => e.status === 0 && e.timeout);
    await assert.rejects(getText('/content/x.json', { timeoutMs: 40 }), (e) => e.status === 0 && e.timeout);
    await assert.rejects(apiHealth({ timeoutMs: 40 }), (e) => e.status === 0 && e.timeout);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('PE4: a save that never answers goes to retry; edits made meanwhile still reach localStorage; a late answer is ignored', async () => {
  const srv = fakeServer(REAL_V1);
  let mode = 'hang';
  let release = null;
  const putData = (b, o) => {
    if (mode === 'hang') return new Promise(() => {});
    if (mode === 'late') { const r = srv.putData(b, o); mode = 'ok'; return new Promise((res) => { release = () => res(r); }); }
    return srv.putData(b, o);
  };
  const { s, clock, storage } = makeStore(srv, { putData, saveTimeout: 30000 });
  await s.init();
  s.get().profile.name = 'one';
  s.touch();
  await clock.tick(500);
  assert.equal(s.getStatus(), 'saving');
  s.get().profile.height_cm = 190; // typed while the save hangs
  s.touch();
  await clock.tick(600);
  const stored = () => pendingKeys(storage).flatMap((k) => JSON.parse(storage.get(k)).changes.map((c) => c.p.join('.')));
  assert.ok(stored().includes('profile.height_cm'), 'the new edit is in localStorage while the save hangs');
  await clock.tick(30000);
  assert.equal(s.getStatus(), 'error');
  assert.match(s.syncInfo().error.message, /took too long/);
  assert.ok(s.syncInfo().retryAt > clock.now());
  mode = 'ok';
  await clock.tick(3000);
  assert.deepEqual([s.getStatus(), srv.json().profile.name, srv.json().profile.height_cm], ['saved', 'one', 190]);
  assert.deepEqual(pendingKeys(storage), []);
  // A save that reached the server but whose answer comes after the watchdog: the retry merges, the late answer is ignored.
  mode = 'late';
  s.get().profile.name = 'two';
  s.touch();
  await clock.tick(500 + 30000 + 3000);
  assert.deepEqual([s.getStatus(), srv.json().profile.name], ['saved', 'two']);
  const etag = s.syncInfo().etag;
  release();
  await settle();
  assert.deepEqual([s.getStatus(), s.syncInfo().etag, etag], ['saved', srv.etag, srv.etag]);
  s.dispose();
});

test('PE4: a stale-tab check that never answers is abandoned, so later checks still run', async () => {
  const srv = fakeServer(REAL_V1);
  let hang = true;
  const getData = (o) => (hang && o && 'ifNoneMatch' in o ? new Promise(() => {}) : srv.getData(o));
  const { s, clock } = makeStore(srv, { getData, saveTimeout: 30000 });
  await s.init();
  const first = s.checkForUpdates({ force: true });
  await clock.tick(30000);
  const r = await first;
  assert.equal(r.error.timeout, true);
  hang = false;
  srv.edit((d) => { d.profile.name = 'elsewhere'; });
  await s.checkForUpdates({ force: true });
  assert.equal(s.get().profile.name, 'elsewhere');
  s.dispose();
});

test('api: X-Hub-Build on PUT, the 409 build_mismatch code, sizes from Content-Length, early (prefetched) responses used once', async () => {
  const calls = [];
  const realFetch = globalThis.fetch;
  let next = null;
  globalThis.fetch = async (url, init = {}) => { calls.push({ url, init }); return next(url, init); };
  try {
    next = () => fakeRes(200, '{"ok":true}', { etag: '"e"' });
    await apiPutData('{}', { etag: '"a"', build: 'abc123' });
    assert.equal(calls.at(-1).init.headers[BUILD_HEADER], 'abc123');
    assert.equal(BUILD_HEADER, 'X-Hub-Build');
    await apiPutData('{}', { etag: '"a"' });
    assert.equal(calls.at(-1).init.headers[BUILD_HEADER], undefined);
    next = () => fakeRes(409, '{"error":"build_mismatch","build":"def"}', {});
    await assert.rejects(apiPutData('{}', { etag: '"a"', build: 'abc' }), (e) => e.status === 409 && e.code === 'build_mismatch' && e.body.build === 'def');
    next = () => fakeRes(200, '{ "schema_version": 1 }', { etag: '"x"', 'content-length': '24' });
    assert.equal((await apiGetDataWithEtag()).bytes, 24, 'Content-Length, not a re-measure of the text');
    next = () => fakeRes(200, '{"schema_version":1}', { etag: '"x"', 'content-length': '7', 'content-encoding': 'gzip' });
    assert.equal((await apiGetDataWithEtag()).bytes, 20, 'compressed: measured from the text');
    next = () => fakeRes(200, '{"ok":true,"build":"b9"}', {});
    assert.equal(buildOf(await apiHealth()), 'b9');
    assert.deepEqual([buildOf({}), buildOf({ build: '  ' }), buildOf(null)], [null, null, null]);
    const before = calls.length;
    globalThis.__hubPrefetch = { '/api/data': Promise.resolve(fakeRes(200, '{"schema_version":2}', { etag: '"pf"' })) };
    const pf = await apiGetDataWithEtag();
    assert.deepEqual([pf.etag, calls.length, globalThis.__hubPrefetch['/api/data']], ['"pf"', before, undefined], 'used once, no extra request');
    const rejected = Promise.reject(new Error('offline'));
    rejected.catch(() => {});
    globalThis.__hubPrefetch = { '/api/data': rejected, '/content/program.json': Promise.resolve(fakeRes(200, '{"v":1}', {})) };
    next = () => fakeRes(200, '{"schema_version":3}', { etag: '"fresh"' });
    assert.equal((await apiGetDataWithEtag()).etag, '"fresh"', 'a failed prefetch falls back to a normal request');
    assert.equal(calls.length, before + 1);
    assert.equal(await getText('/content/program.json'), '{"v":1}');
    assert.equal(calls.length, before + 1, 'content files can be prefetched too');
    globalThis.__hubPrefetch = { '/api/data': Promise.resolve(fakeRes(200, '{}', { etag: '"pf"' })) };
    await apiGetDataWithEtag({ ifNoneMatch: '"x"' });
    assert.equal(calls.length, before + 2, 'a conditional GET never uses a prefetched answer');
  } finally {
    delete globalThis.__hubPrefetch;
    globalThis.fetch = realFetch;
  }
});

// ---------------------------------------------------------------- minor items
test('PERF7 / PERF10: byte sizes are exact UTF-8 without TextEncoder copies; the store counts the compact body it sends', async () => {
  const samples = ['', 'plain ascii {"a":1}', 'café', '73,5 kg — “quoted” ✓', '😀 emoji and 𝄞', '\uD800 lone surrogate', 'x'.repeat(70000)];
  for (const t of samples) assert.equal(byteLength(t), new TextEncoder().encode(t).length, JSON.stringify(t.slice(0, 12)));
  assert.deepEqual([fitsKeepalive('x'.repeat(KEEPALIVE_MAX_BYTES)), fitsKeepalive('x'.repeat(KEEPALIVE_MAX_BYTES + 1)), fitsKeepalive('é'.repeat(KEEPALIVE_MAX_BYTES / 2 + 1))], [true, false, false]);
  const srv = fakeServer(REAL_V1);
  const { s, clock } = makeStore(srv);
  await s.init();
  s.get().profile.diet_notes = 'Vegetarian — no gelatine';
  s.touch();
  await clock.tick(500);
  assert.equal(s.syncInfo().bytes, byteLength(JSON.stringify(s.get())), 'compact JSON as sent, not the indented copy');
  s.dispose();
});

test('PE11: workout exercises merge by exercise id + occurrence, and timestamps never make a conflict', () => {
  const b = migrate({ schema_version: 2, workouts: [{ id: 'w1', date: '2025-11-24', session_id: 'str-a', status: 'draft', updated_at: '2025-11-24T07:00:00Z', created_at: '2025-11-24T06:30:00Z',
    exercises: [{ block: 'b0', exercise: 'leg-press', sets: [{ kg: 40, reps: 10 }] }, { block: 'b1', exercise: 'box-squat-bw', sets: [{ reps: 5 }] }] }] });
  let l = cloneJSON(b);
  let r = cloneJSON(b);
  l.workouts[0].exercises.reverse();
  l.workouts[0].updated_at = '2025-11-24T07:05:00Z';
  r.workouts[0].exercises[1].sets[0].reps = 6;
  r.workouts[0].updated_at = '2025-11-24T07:06:00Z';
  let m = mergeData(b, l, r);
  assert.equal(m.conflicts.length, 0, 'reordering here and logging there never mixes up the sets');
  const ex = m.result.workouts[0].exercises;
  assert.deepEqual(ex.map((e) => [e.exercise, e.sets[0].reps]), [['box-squat-bw', 6], ['leg-press', 10]]);
  assert.equal(m.result.workouts[0].updated_at, '2025-11-24T07:06:00Z', 'the later timestamp, no conflict');
  l = cloneJSON(b);
  r = cloneJSON(b);
  l.workouts[0].exercises[0] = { block: 'b0', exercise: 'leg-press-single', swapped_from: 'leg-press', sets: [{ kg: 20, reps: 10 }], notes: '' };
  r.workouts[0].exercises[0].sets[0].kg = 42.5;
  m = mergeData(b, l, r);
  assert.equal(m.conflicts.length, 0);
  assert.deepEqual(m.result.workouts[0].exercises.map((e) => [e.exercise, e.sets[0].kg]), [['leg-press-single', 20], ['box-squat-bw', null], ['leg-press', 42.5]], 'a swap never receives the other exercise\'s sets');
  assert.deepEqual(entryKeys([{ exercise: 'a' }, { exercise: 'b', block: 'b1' }, { exercise: 'a' }, {}]), ['a#1', 'b#1', 'a#2', '?#1'], 'positional block keys are not stable');
  assert.deepEqual(entryKeys([{ exercise: 'x', block: 'leg-press:1' }, { exercise: 'leg-press', block: 'leg-press:2' }, { exercise: 'y', block: 'leg-press:1' }]), ['@leg-press:1', '@leg-press:2', '@leg-press:1#2']);
  // With the UI's stable block keys (PE10) a swap stays one entry for that block; sets changed on both sides are yours to choose.
  const sb = migrate({ schema_version: 2, workouts: [{ id: 'w2', date: '2025-11-24', session_id: 'str-a', exercises: [{ block: 'leg-press:1', exercise: 'leg-press', sets: [{ kg: 40, reps: 10 }] }, { block: 'box-squat-bw:1', exercise: 'box-squat-bw', sets: [{ reps: 5 }] }] }] });
  l = cloneJSON(sb);
  r = cloneJSON(sb);
  l.workouts[0].exercises[0] = { ...l.workouts[0].exercises[0], exercise: 'leg-press-single', swapped_from: 'leg-press' };
  r.workouts[0].exercises.reverse();
  m = mergeData(sb, l, r);
  assert.deepEqual([m.conflicts.length, m.result.workouts[0].exercises.map((e) => `${e.block}=${e.exercise}`)], [0, ['leg-press:1=leg-press-single', 'box-squat-bw:1=box-squat-bw']]);
  // Sets inside one exercise still merge set by set.
  l = cloneJSON(b);
  r = cloneJSON(b);
  l.workouts[0].exercises[0].sets.push({ kg: 40, reps: 9, seconds: null, rir: null, done: true });
  r.workouts[0].exercises[0].sets[0].reps = 11;
  assert.equal(mergeData(b, l, r).conflicts[0].field.split('.').at(-1), 'sets', 'a set added here and edited there is still yours to choose');
});

test('SEC10: the conflict log keeps the last 20 entries, none older than 30 days, and stays under its size cap', async () => {
  const srv = fakeServer(REAL_V1);
  const clock = fakeClock();
  const { s, storage } = makeStore(srv, { clock });
  await s.init();
  storage.set('fitness-hub:conflict-log', JSON.stringify(Array.from({ length: 30 }, (_, i) => ({ at: new Date(clock.now() - (40 - i) * 86400000).toISOString(), label: `old ${i}`, mine: 1, theirs: 2 }))));
  assert.equal(s.conflictLog().length, 20, 'older than 30 days: gone');
  assert.equal(JSON.parse(storage.get('fitness-hub:conflict-log')).length, 20, 'and removed from localStorage');
  s.onConflict(() => {});
  srv.edit((d) => { d.checkins[0].notes = 'a'.repeat(300000); });
  s.get().checkins[0].notes = 'b'.repeat(300000);
  s.touch();
  await clock.tick(500);
  await s.resolveConflict('theirs');
  const log = s.conflictLog();
  assert.equal(log.length, 1, 'a huge entry pushed the old ones out');
  assert.ok(storage.get('fitness-hub:conflict-log').length <= CONFLICT_LOG_LIMITS.chars);
  assert.equal(log[0].truncated, true, 'and was cut down to a preview');
  await clock.tick(31 * 86400000);
  assert.deepEqual(s.conflictLog(), []);
  assert.equal(storage.get('fitness-hub:conflict-log'), null);
  assert.deepEqual(CONFLICT_LOG_LIMITS, { entries: 20, days: 30, chars: 200000 });
  s.dispose();
});

test('PM8: ladder auto-completion with public-transport-friendly criteria; this weekend\'s route; the carrying rule on walks', () => {
  const L1 = { level: 1, gate: 'none', criteria: { distance_km: 3, ascent_m: 0, pack_kg: 0 } };
  const L3 = { level: 3, gate: 'none', criteria: { distance_km: 8, ascent_m: null, pack_kg: 0 } };
  assert.equal(hikeMeets({ distance_km: 8.2 }, L3), true, 'any ascent: none logged is fine');
  assert.equal(hikeMeets({ distance_km: 7.9, ascent_m: 300 }, L3), false);
  assert.equal(hikeMeets({ distance_km: '8.5', ascent_m: '' }, L3), true, 'numbers typed as text');
  assert.equal(hikeMeets({ distance_km: null }, L1), false, 'a hike with no distance completes nothing');
  assert.equal(hikeMeets({ distance_km: 5, duration_min: 30 }, { criteria: { distance_km: 3, duration_min: 40 } }), false, 'an optional minimum time');
  assert.equal(hikeMeets(null, L1), false);
  assert.deepEqual(ladderStatus([L1, L3], { hikes: [{ id: 'a', date: '2025-11-23', distance_km: 9, ascent_m: null }] }, {}).map((x) => x.done), [true, true]);
  const fx = JSON.parse(fs.readFileSync(`${HUB}public/dev-fixtures/hikes.json`, 'utf8'));
  assert.equal(weekendPlanOn(fx, '2025-11-29').name, 'Canal towpath, out and back from the nearest lock');
  assert.equal(weekendPlanOn(fx, '2025-11-24').level, 2, 'any day of that week');
  assert.equal(weekendPlanOn(fx, '2026-06-02'), null);
  const hk = { id: 'h', date: '2025-11-29', distance_km: 6, duration_min: 90, pack_kg: 5 };
  assert.match(hikeIssues(hk, { profile: { clearances: {} } }).find((x) => x.field === 'pack_kg').message, /waist pack only/);
  assert.equal(hikeIssues({ ...hk, pack_kg: 2 }, { profile: { clearances: {} } }).length, 0);
  assert.equal(hikeIssues(hk, { profile: { clearances: { clinic_light: '2025-11-21' } } }).length, 0, 'after clinic_light a light day pack is fine');
  assert.equal(hikeIssues(hk).length, 0, 'without data the rule is not checked');
  assert.equal(WAIST_PACK_MAX_KG, 2);
});

test('content.js: alternates must be gate "none"; the new override fields are validated', () => {
  const ex = new Map([['leg-press', { id: 'leg-press', gate: 'none' }], ['farmer-carry', { id: 'farmer-carry', gate: 'grip_cleared' }]]);
  const prog = {
    phases: [{ id: 'p1', weeks: 4, week_template: { mon: 'a' }, week_overrides: [{ week: 2, zone_cap: 'Z7', rounds: 2.5, circuit_minutes: -1 }, { week: 3, zone_cap: 'Z3', rounds: 4, circuit_minutes: 5 }] }],
    sessions: { a: { type: 'strength', blocks: [{ exercise: 'leg-press', sets: 2, reps: '8' }] }, short: { type: 'strength', blocks: [{ exercise: 'farmer-carry', sets: 2, reps: '20' }] } },
    alternates: { short: 'short', travel: 'nope' },
  };
  const pr = validateProgram(prog, ex).join('\n');
  for (const re of [/zone_cap "Z7" should be Z1–Z5/, /rounds should be a whole number/, /circuit_minutes should be a number above 0/,
    /Safety: alternate session short uses farmer-carry, which needs grip_cleared/, /alternates\.travel: session "nope" does not exist/]) assert.match(pr, re);
  assert.ok(!/week 3/.test(pr), 'valid values pass');
  assert.deepEqual(alternatesOf(prog), { short: 'short', travel: null });
});

test('content.js: exercises.json that differs from part-a + part-b is a safety problem, and the stricter gate wins', async () => {
  const partA = [{ id: 'leg-press', name: 'Leg press', gate: 'none', arm_safety: 'x', category: 'squat' }, { id: 'suitcase-carry-good-hand', name: 'Suitcase carry', gate: 'grip_cleared', category: 'carry' }];
  const partB = [{ id: 'farmer-carry', name: 'Farmer carry', gate: 'grip_cleared', category: 'carry' }];
  const stale = [{ ...partA[0], gate: 'clinic_light' }, { ...partA[1], name: 'Suitcase carry (old)', gate: 'good_arm_ok', arm_safety: 'x' }, { id: 'stale-only', name: 'Stale', gate: 'none', arm_safety: 'x', category: 'core' }];
  const files = {
    '/content/program.json': JSON.stringify({ phases: [{ id: 'p1', weeks: 2, week_template: { mon: 'rest' } }], sessions: {} }),
    '/content/exercises.json': JSON.stringify(stale),
    '/content/exercises/part-a.json': JSON.stringify(partA),
    '/content/exercises/part-b.json': JSON.stringify(partB),
    '/content/hikes.json': JSON.stringify({ ladder: [{ level: 1, gate: 'none', criteria: { distance_km: 3 } }], weekend_plan: [{ week_start: '2025-12-01', name: 'B', level: 1, url: 'javascript:x' }, { week_start: 'soon', name: 'Bad' }, { week_start: '2025-11-24', name: 'A', level: 9 }] }),
  };
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => (files[url] === undefined ? fakeRes(404, '') : fakeRes(200, files[url]));
  try {
    await loadContent();
    const st = content.status.find((x) => x.label === 'Exercises (merged)');
    const text = st.problems.join('\n');
    assert.match(text, /^Safety: exercises\.json does not match part-a \+ part-b/m);
    for (const re of [/suitcase-carry-good-hand \(good_arm_ok vs grip_cleared\)/, /leg-press \(clinic_light vs none\)/, /missing from exercises\.json: farmer-carry/, /only in exercises\.json: stale-only/]) assert.match(text, re);
    assert.deepEqual([content.exById.get('suitcase-carry-good-hand').gate, content.exById.get('leg-press').gate], ['grip_cleared', 'clinic_light'], 'the stricter gate wins either way');
    assert.equal(content.exById.get('suitcase-carry-good-hand').name, 'Suitcase carry', 'the parts are the source of truth for the text');
    assert.ok(content.exById.has('farmer-carry') && content.exById.has('stale-only'));
    assert.equal(content.exerciseSources.same, false);
    assert.ok(contentProblems().some((p) => p.safety && /does not match/.test(p.message)));
    assert.deepEqual(content.hikes.weekend_plan.map((x) => [x.week_start, x.url ?? '']), [['2025-11-24', ''], ['2025-12-01', '']], 'sorted, bad links and dates dropped');
    assert.match(content.status.find((x) => x.label === 'Hikes').problems.join('\n'), /no valid week_start[\s\S]*level 9 is not on the ladder|level 9 is not on the ladder[\s\S]*no valid week_start/);
    files['/content/exercises.json'] = JSON.stringify([...partA, ...partB]);
    await loadContent();
    assert.ok(!contentProblems().some((p) => /does not match/.test(p.message)), 'equal sources: no problem');
    assert.equal(content.exerciseSources.same, true);
    assert.equal(compareExerciseSources([...partA, ...partB], [...partA, ...partB]).same, true);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('PE1: a save or a stale-tab check already in flight never replaces a restore that is waiting for your choice', async () => {
  const srv = fakeServer(REAL_V1);
  const { storage, session } = await crashWith(srv, (d) => { d.checkins.push({ date: '2025-11-23', weight_kg: 79.9, arm_flags: [] }); });
  srv.edit((d) => { d.checkins.push({ date: '2025-11-23', weight_kg: 80.1, arm_flags: [] }); });
  let hold = true;
  let release = null;
  const putData = (b, o) => (hold ? new Promise((res, rej) => { release = () => srv.putData(b, o).then(res, rej); }) : srv.putData(b, o));
  const t = makeStore(srv, { storage, session, putData });
  t.s.onConflict(() => {});
  const { recovered } = await t.s.init();
  t.s.get().profile.name = 'mine';
  t.s.touch();
  await t.clock.tick(500); // a save is out
  srv.edit((d) => { d.profile.height_cm = 185; d.profile.name = 'phone'; }); // the phone saves meanwhile: a 412 with its own conflict
  await t.s.replaceAll(recovered.data);
  assert.equal(t.s.getConflict().kind, 'recovery');
  hold = false;
  release();
  await settle();
  assert.deepEqual([t.s.getConflict()?.kind, t.s.getStatus()], ['recovery', 'conflict'], 'the 412 resync waits instead of replacing it');
  assert.deepEqual(await t.s.checkForUpdates({ force: true }), { stale: false, paused: true });
  await t.s.resolveConflict('theirs');
  await t.clock.tick(100);
  assert.deepEqual([t.s.getConflict()?.kind, t.s.getConflict()?.items[0].field], ['sync', 'name'], 'then the name changed in both places is asked about');
  await t.s.resolveConflict('mine');
  await t.clock.tick(100);
  const d = srv.json();
  assert.deepEqual([t.s.getStatus(), d.profile.name, d.profile.height_cm, d.checkins.find((c) => c.date === '2025-11-23').weight_kg], ['saved', 'mine', 185, 80.1]);
  assert.deepEqual(pendingKeys(storage), []);
  t.s.dispose();
});

// =====================================================================================
// Round 4 (Team L: logic). Every Team L item in reviews/ROUND4_TRIAGE.md has a test below; the
// two critical progression repros (BT1-1, BT3-1) come first.
// =====================================================================================
import {
  HOLD_RIR, blockKeysOf, plannedFromBlock, plannedSetCount,
} from '../public/js/schedule.js';
import {
  effectivePrescription, entryBlock, weekendPlanList, nextWeekendPlanOn, weekendPlanStart, hikeCovers, plannedHikeMinutes, isHikeSession,
  HIKE_COVERS_SHARE,
} from '../public/js/stats.js';
import {
  armLogPainOn, redDays, weightVerdict, gainBand, GAIN_BANDS, WEIGHT_RULES, preInjuryWeight, LOSING_KG_WEEK, bandText, GAIN_BAND,
} from '../public/js/calc.js';
import {
  allowedForPhase, whyNotAllowed, phaseGateOn, prescriptionFor, parseDose, testsDueOn, testStatusOn, testEarliestDue, testBaselineDue,
} from '../public/js/content.js';

/** A programme shaped like the real one: p1 week 1 capped at 2 sets, week 5 a deload; alternates; a good-arm add-on. */
const R4 = {
  default_start_date: '2025-11-24',
  phases: [
    { id: 'p1', entry_gate: 'none', weeks: 8, min_weeks: 8, repeat_from_week: 3,
      week_template: { mon: 'str-a', tue: 'z2', wed: 'str-b', thu: 'z2', fri: 'str-c', sat: 'walk', sun: 'rest' },
      week_overrides: [{ week: 1, sets_max: 2, rir: '3-4' }, { week: 5, label: 'Deload', deload: true }] },
    { id: 'p2', entry_gate: 'grip_cleared', weeks: 6, repeat_from_week: null, week_template: { mon: 'str-a', sat: 'walk' } },
    { id: 'p4a', entry_gate: 'full_clearance', weeks: 4, repeat_from_week: null, week_template: { mon: 'str-a' } },
  ],
  addons: [{ id: 'crossed', gate: 'good_arm_ok', until_gate: null, phases: ['p1'], days: ['mon', 'wed', 'fri'], session: 'crossed' }],
  alternates: { short: 'alt-short', travel: 'alt-travel' },
  sessions: {
    'str-a': { name: 'Strength A', type: 'strength', blocks: [
      { exercise: 'leg-press', sets: 3, reps: '8-12', rir: '2-3', load: 'double-progression' },
      { exercise: 'wall-sit', sets: 2, seconds: 45 },
    ] },
    'str-b': { name: 'Strength B', type: 'strength', blocks: [{ exercise: 'hamstring-curl', sets: 3, reps: '8-12', rir: '2-3', load: 'double-progression' }] },
    'str-c': { name: 'Strength C', type: 'strength', blocks: [{ exercise: 'hamstring-curl', sets: 2, reps: '10-15', rir: '2', load: 'double-progression' }] },
    z2: { name: 'Zone 2', type: 'cardio', blocks: [{ exercise: 'incline-walk', minutes: 30, zone: 'Z2' }] },
    walk: { name: 'Long walk', type: 'hike', blocks: [{ exercise: 'walk-outdoor', minutes: 80, zone: 'Z2', minutes_by_week: [45, 60, 70] }] },
    crossed: { name: 'Good arm', type: 'strength', blocks: [{ exercise: 'ga-cable-row', sets: 3, reps: '8-12', load: 'double-progression' }] },
    'alt-short': { name: 'Short', type: 'strength', blocks: [{ exercise: 'leg-press', sets: 2, reps: '8-12', load: 'double-progression' }] },
    'alt-travel': { name: 'Travel', type: 'strength', blocks: [{ exercise: 'split-squat-bw', sets: 3, reps: '8-10', load: 'bodyweight' }] },
    rest: { name: 'Rest', type: 'rest', blocks: [] },
  },
  rules: { increments_kg: { 'leg-press': 10, machine: 2.5, default: 2.5 } },
};

// ---------------------------------------------------------------- BT1-1 / BT3-1 (critical): progression
test('BT1-1 (critical): 60 kg × 12, 12 in a 2-set capped week gives "Add 10 kg" next week, never "incomplete"', () => {
  const capped = (extra = {}, w = {}) => ({ id: 'w1', date: '2025-11-24', session_id: 'str-a', phase_id: 'p1', phase_week: 1, status: 'done', cardio: [], ...w, exercises: [
    { block: 'leg-press:1', exercise: 'leg-press', sets: [{ kg: 60, reps: 12, rir: 3, done: true }, { kg: 60, reps: 12, rir: 3, done: true }], notes: '', ...extra },
  ] });
  const next = resolveSession(R4.sessions['str-a'], { week: 2, override: null })[0];
  assert.deepEqual([next.setsPlanned, next.sets], [3, 3], 'today Strength A plans 3 sets');
  const inc = incrementFor('leg-press', { equipment: ['leg press machine'] }, R4.rules);
  // Exactly how the logger asks: last.sets, and today's raw block sets as plannedSets.
  const suggest = (last) => suggestProgression({ reps: next.reps, lastSets: last.sets, increment: inc, plannedSets: next.setsPlanned });
  // (a) A round 4 log stores the effective prescription.
  const stored = { profile: profile(), workouts: [capped({ planned: { sets: 2, reps: '8-12', rir: '3-4', load: 'double-progression' } })] };
  let last = lastPerformance(stored, 'leg-press', '2025-12-01', null, { program: R4 });
  assert.deepEqual([last.planned, last.plannedSets, last.complete, last.prescription.source], [2, 2, true, 'stored']);
  let s = suggest(last);
  assert.deepEqual([s.kind, s.kg, s.reps, s.planned, s.performed], ['add-load', 70, 8, 2, 2]);
  assert.match(s.text, /Add 10 kg/);
  // (b) An older log without `planned`: the effective sets are recomputed for that date (p1 week 1, sets_max 2).
  const old = { profile: profile(), workouts: [capped()] };
  last = lastPerformance(old, 'leg-press', '2025-12-01', null, { program: R4 });
  assert.deepEqual([last.planned, last.prescription.source, last.prescription.sets, last.prescription.rir], [2, 'recomputed', 2, '3-4']);
  assert.match(suggest(last).text, /Add 10 kg/);
  assert.equal(lastPerformance({ profile: profile(), workouts: [capped({}, { phase_id: null, phase_week: null })] }, 'leg-press', '2025-12-01', null, { program: R4 }).planned, 2,
    'no phase week stored: the timeline gives week 1');
  // (c) No program to hand: the set rows the logger created (it creates the effective sets).
  last = lastPerformance(old, 'leg-press', '2025-12-01');
  assert.deepEqual([last.planned, last.prescription.source], [2, 'rows']);
  assert.match(suggest(last).text, /Add 10 kg/);
  assert.equal(suggestProgression({ reps: '8-12', lastSets: last.rows, increment: inc, plannedSets: 3 }).kind, 'add-load', 'rows carry the annotation too');
  // The bug: judging a plain list against today's raw block sets made it "incomplete" every week.
  const plain = [...last.sets];
  assert.equal(suggestProgression({ reps: '8-12', lastSets: plain, increment: inc, plannedSets: 3 }).reason, 'incomplete');
  assert.equal(suggestProgression({ reps: '8-12', lastSets: plain, increment: inc, plannedSets: 3, planned: { sets: 2 } }).kind, 'add-load', 'an explicit planned (last time) wins');
  assert.equal(suggestProgression({ reps: '8-12', lastSets: plain, increment: inc, planned: 2 }).kind, 'add-load', 'or just its count');
  assert.equal(suggestProgression.plannedAware, true, 'the UI can feature-detect it');
  // Still strict: what was planned has to be done.
  s = suggest(lastPerformance({ workouts: [capped({ planned: { sets: 3, reps: '8-12' } })] }, 'leg-press', '2025-12-01'));
  assert.deepEqual([s.kind, s.reason, s.planned, s.performed], ['hold', 'incomplete', 3, 2]);
  assert.match(s.text, /2 of 3 sets/);
  const undone = capped();
  undone.exercises[0].sets.push({ kg: 60, reps: null, done: false });
  assert.equal(suggest(lastPerformance({ profile: profile(), workouts: [{ ...undone, phase_week: 2 }] }, 'leg-press', '2025-12-08', null, { program: R4 })).reason, 'incomplete', 'a normal week planned 3');
  assert.deepEqual([plannedSetCount(2), plannedSetCount({ sets: '3' }), plannedSetCount({ sets: 0 }), plannedSetCount(null)], [2, 3, null, null]);
  // No novice wording (SPEC 1): an experienced lifter's first log of a lift.
  s = suggestProgression({ reps: '8-12', lastSets: [], increment: inc });
  assert.equal(s.kind, 'start');
  assert.match(s.text, /^Start around a load you could do for 15, then let double progression find your level within 2 sessions\.$/);
  assert.doesNotMatch(suggestProgression({ reps: '8-12', lastSets: [], increment: inc, deload: true }).text, /learn|first time/i);
});

test('BT3-1 (critical): 40 kg × 10, 10 on a deload, AMBER or fasting day gives "beat last time" next session', () => {
  const sets = () => [{ kg: 40, reps: 10, done: true }, { kg: 40, reps: 10, done: true }];
  const log = (date, week, extra = {}, entry = {}) => ({ id: `h-${date}`, date, session_id: 'str-b', phase_id: 'p1', phase_week: week, status: 'done', cardio: [], ...extra,
    exercises: [{ block: 'hamstring-curl:1', exercise: 'hamstring-curl', sets: sets(), notes: '', ...entry }] });
  const today = resolveSession(R4.sessions['str-b'], { week: 6 })[0];
  const check = (data, before, label, program = R4) => {
    const last = lastPerformance(data, 'hamstring-curl', before, null, { program });
    assert.deepEqual([last.planned, last.complete], [2, true], label);
    const s = suggestProgression({ reps: today.reps, lastSets: last.sets, increment: 2.5, plannedSets: today.setsPlanned });
    assert.deepEqual([s.kind, s.kg, s.reps], ['add-reps', 40, 12], label);
    assert.match(s.text, /Stay at 40 kg and beat last time/, label);
  };
  check({ profile: profile(), workouts: [log('2025-12-24', 5)] }, '2025-12-31', 'deload week (p1 week 5, sets halved)');
  check({ profile: profile(), workouts: [log('2025-12-03', 2, { easy_day: true })] }, '2025-12-10', 'AMBER easy day (saved with the log)');
  check({ profile: profile(), checkins: [{ date: '2025-12-03', sleep_h: 5 }], workouts: [log('2025-12-03', 2)] }, '2025-12-10', 'AMBER from that morning’s check-in');
  check({ profile: profile({}, { fasting_periods: [{ start: '2025-12-02', end: '2025-12-06' }] }), workouts: [log('2025-12-03', 2)] }, '2025-12-10', 'fasting: easy-day mode');
  check({ profile: profile(), workouts: [log('2025-12-03', 2, {}, { planned: { sets: 2, reps: '8-12', rir: '3-4', load: 'double-progression' } })] }, '2025-12-10', 'a stored plan', null);
  check({ profile: profile(), workouts: [log('2025-12-03', 2, { easy_day: true })] }, '2025-12-10', 'no program: the 2 rows logged', null);
  // A normal week that planned 3 is still incomplete with 2 of them.
  const normal = { profile: profile(), workouts: [log('2025-12-03', 2, { easy_day: false })] };
  const last = lastPerformance(normal, 'hamstring-curl', '2025-12-10', null, { program: R4 });
  assert.deepEqual([last.planned, last.complete, last.prescription.source], [3, false, 'recomputed']);
  assert.equal(suggestProgression({ reps: '8-12', lastSets: last.sets, increment: 2.5 }).reason, 'incomplete');
  // An explicit easy-day choice beats readiness: easy mode switched off on a fasting day plans the full 3.
  const off = { profile: profile({}, { fasting_periods: [{ start: '2025-12-02', end: '2025-12-06' }] }), workouts: [log('2025-12-03', 2, { easy_choice: false })] };
  assert.equal(lastPerformance(off, 'hamstring-curl', '2025-12-10', null, { program: R4 }).planned, 3);
});

// ---------------------------------------------------------------- BT3-2: last performance per block
test('BT3-2: last performance is per block (same session and block, then the same rep range, then any); alternates are never the baseline', () => {
  const e = (exercise, block, kg, reps = 10, extra = {}) => ({ block, exercise, sets: [{ kg, reps, done: true }, { kg, reps, done: true }], notes: '', ...extra });
  const data = { profile: profile(), workouts: [
    wk('a1', '2025-12-01', 'str-a', { exercises: [e('leg-press', 'leg-press:1', 70)] }),
    wk('s1', '2025-12-02', 'alt-short', { exercises: [e('leg-press', 'leg-press:1', 50)] }),
    wk('c1', '2025-11-28', 'str-c', { exercises: [e('hamstring-curl', 'hamstring-curl:1', 30, 15)] }),
    wk('b1', '2025-12-03', 'str-b', { exercises: [e('hamstring-curl', 'hamstring-curl:1', 45, 9)] }),
    wk('x1', '2025-12-04', 'adhoc', { exercises: [e('hamstring-curl', 'xk1', 25, 12, { extra: true, planned: { sets: 2, reps: '10-15' } })] }),
  ] };
  const lp = (d, id, sessionId, blockKey, reps) => lastPerformance(d, id, '2025-12-08', null, { program: R4, sessionId, blockKey, reps });
  let r = lp(data, 'leg-press', 'str-a', 'leg-press:1', '8-12');
  assert.deepEqual([r.workoutId, r.match, r.block, r.sessionId, r.sets[0].kg], ['a1', 'block', 'leg-press:1', 'str-a', 70], 'the newer short-session log is not the baseline for Strength A');
  assert.equal(lastPerformance(data, 'leg-press', '2025-12-08').workoutId, 's1', 'without the options: the most recent log, as before');
  assert.equal(lastPerformance(data, 'leg-press', '2025-12-08').match, null);
  r = lp(data, 'leg-press', 'alt-short', 'leg-press:1', '8-12');
  assert.deepEqual([r.workoutId, r.match], ['s1', 'block'], 'an alternate may use its own logs');
  assert.equal(lp({ workouts: [data.workouts[1]] }, 'leg-press', 'str-a', 'leg-press:1', '8-12'), null, 'alternates are never the baseline for a full session');
  assert.equal(lastPerformance({ workouts: [data.workouts[1]] }, 'leg-press', '2025-12-08', null, { alternates: ['alt-short'], sessionId: 'str-a' }), null, 'alternate ids may be passed directly');
  // Strength C's 10-15 curl: its own last log wins, though Strength B's 8-12 and the ad-hoc one are newer.
  r = lp(data, 'hamstring-curl', 'str-c', 'hamstring-curl:1', '10-15');
  assert.deepEqual([r.workoutId, r.match, r.sets[0].kg], ['c1', 'block', 30]);
  const noC = { profile: profile(), workouts: data.workouts.filter((w) => w.id !== 'c1') };
  r = lp(noC, 'hamstring-curl', 'str-c', 'hamstring-curl:1', '10-15');
  assert.deepEqual([r.workoutId, r.match], ['x1', 'prescription'], 'next: the same rep range (the ad-hoc log planned 10-15)');
  r = lp({ profile: profile(), workouts: [data.workouts[3]] }, 'hamstring-curl', 'str-c', 'hamstring-curl:1', '8-12');
  assert.deepEqual([r.workoutId, r.match, r.prescription.reps], ['b1', 'prescription', '8-12'], 'an older log’s rep range is recomputed from the programme');
  r = lp(noC, 'hamstring-curl', 'str-c', 'hamstring-curl:1', '6-8');
  assert.deepEqual([r.workoutId, r.match], ['x1', 'any'], 'then any log, the most recent');
  r = lp(data, 'hamstring-curl', 'str-b', 'hamstring-curl:1', '8-12');
  assert.deepEqual([r.workoutId, r.match, r.sets.length, r.entry.block], ['b1', 'block', 2, 'hamstring-curl:1']);
  // Older positional keys ("b0") map through the programme; options may be the 4th argument.
  const legacy = { workouts: [wk('o1', '2025-11-24', 'str-a', { exercises: [e('leg-press', 'b0', 60, 12)] })] };
  r = lastPerformance(legacy, 'leg-press', '2025-12-08', { program: R4, sessionId: 'str-a', blockKey: 'leg-press:1', reps: '8-12' });
  assert.deepEqual([r.match, r.block], ['block', 'leg-press:1']);
  assert.deepEqual(entryBlock(legacy.workouts[0], legacy.workouts[0].exercises[0], { program: R4 }), { key: 'leg-press:1', index: 0 });
  assert.equal(entryBlock(legacy.workouts[0], { block: 'b1', exercise: 'leg-press' }, { program: R4 }), null, 'a position that now holds another exercise');
  assert.deepEqual(entryBlock({ session_id: 'gone' }, { exercise: 'leg-press' }, { list: [{ exercise: 'leg-press' }] }), null, 'not in the list');
  const two = [{ exercise: 'leg-press' }, { exercise: 'leg-press' }];
  assert.equal(entryBlock({ session_id: 'gone' }, two[1], { list: two }).key, 'leg-press:2', 'no key: the planned exercise’s occurrence');
  // A swap keeps its block: the swapped-in exercise's last log in that block.
  const sw = { workouts: [wk('w9', '2025-11-24', 'str-a', { exercises: [e('box-squat-bw', 'leg-press:1', null, 8, { swapped_from: 'leg-press' })] })] };
  r = lastPerformance(sw, 'box-squat-bw', '2025-12-08', null, { program: R4, sessionId: 'str-a', blockKey: 'leg-press:1' });
  assert.deepEqual([r.match, r.block, r.planned, r.prescription.source], ['block', 'leg-press:1', 2, 'recomputed']);
  // Timed work: compatible with timed work.
  const holds = { workouts: [wk('t1', '2025-12-01', 'adhoc', { exercises: [{ block: 'xa', extra: true, exercise: 'wall-sit', planned: { sets: 2, seconds: 30 }, sets: [{ seconds: 30, done: true }] }] })] };
  assert.equal(lastPerformance(holds, 'wall-sit', '2025-12-08', null, { program: R4, sessionId: 'str-a', blockKey: 'wall-sit:1', seconds: 45 }).match, 'prescription');
  // Cardio rows are per block as well.
  const cardio = { workouts: [wk('z1', '2025-12-02', 'z2', { cardio: [{ block: 'incline-walk:1', exercise: 'incline-walk', minutes: 30 }] }), wk('z0', '2025-12-04', 'adhoc', { cardio: [{ block: 'xz', extra: true, exercise: 'incline-walk', minutes: 12 }] })] };
  r = lastPerformance(cardio, 'incline-walk', '2025-12-08', null, { program: R4, sessionId: 'z2', blockKey: 'incline-walk:1' });
  assert.deepEqual([r.workoutId, r.match, r.cardio[0].minutes, r.sets.length], ['z1', 'block', 30, 0]);
  assert.deepEqual(blockKeysOf(R4.sessions['str-a'].blocks), ['leg-press:1', 'wall-sit:1']);
  assert.deepEqual(blockKeysOf([{ exercise: 'a', sets: 2 }, { circuit: { items: [] } }, { exercise: 'a', sets: 1 }, {}]), ['a:1', 'circuit:1', 'a:2', 'block3:1']);
  assert.deepEqual(effectivePrescription(legacy.workouts[0], legacy.workouts[0].exercises[0], { program: R4 }), { sets: 2, reps: '8-12', rir: '3-4', seconds: null, load: 'double-progression', source: 'recomputed' });
});

// ---------------------------------------------------------------- BT2-2/3: phase-appropriate swaps
const LIB4 = new Map([
  ['leg-press', { id: 'leg-press', name: 'Leg press', gate: 'none', category: 'squat', equipment: ['45° plate-loaded leg press with adjustable bottom stops', 'plates'], dose: '3 × 8–12, RIR 2–3, 3-s lowering (Phase 3: 3 × 10–15, RIR 1–2)', cues: ['Feet mid-platform', 'Three seconds down'] }],
  ['leg-extension', { id: 'leg-extension', gate: 'none', category: 'knee-ankle', equipment: ['leg extension machine'], dose: '2–3 × 10–15, RIR 2–3, 1 s squeeze, 3 s lowering' }],
  ['wall-sit', { id: 'wall-sit', gate: 'none', category: 'squat', equipment: ['smooth wall', 'non-slip floor'], dose: '3–5 × 30–45 s holds, 60 s rest (test: one maximum hold every 4 weeks)' }],
  ['split-squat-bw', { id: 'split-squat-bw', gate: 'none', category: 'single-leg', equipment: ['squat rack upright or wall for your uninjured hand', 'mat (optional knee pad)'], dose: '3 × 8–10 per leg, RIR 2–3, 3-s lowering' }],
  ['patrick-step', { id: 'patrick-step', gate: 'none', category: 'knee-ankle', equipment: ['aerobic step at its lowest height (about 15 cm) or the bottom stair: not a stack of plates or a bench'], dose: '2–3 × 10–15 per leg, slow and controlled' }],
  ['stair-climber', { id: 'stair-climber', gate: 'none', category: 'conditioning', equipment: ['stair climber (stepmill)'], dose: 'Tuesday engine: about 8–10 min in Zone 2 at first, building by 2–4 min a week to 30–35 min; uphill 4 × 4-min intervals from Phase 4' }],
  ['single-leg-balance', { id: 'single-leg-balance', gate: 'none', category: 'balance', equipment: ['wall or rack upright'], dose: '30 s per leg every day in your mobility routine; 45–60 s holds as a test' }],
  ['hip-90-90-switch', { id: 'hip-90-90-switch', gate: 'none', category: 'mobility', equipment: ['mat'], dose: '8 switches (4 each way)' }],
  ['sled-drag-forward-belt', { id: 'sled-drag-forward-belt', gate: 'none', category: 'conditioning', equipment: ['sled'], dose: '6–8 × 20 m, rest 60–90 s (or 10–15 min continuous at Zone 2–3)' }],
  ['ga-cable-row', { id: 'ga-cable-row', gate: 'good_arm_ok', category: 'pull', equipment: ['cable machine or seated row station', 'single D-handle'], dose: '3 × 8–12, RIR 2–3' }],
  ['rehab-putty-grip', { id: 'rehab-putty-grip', gate: 'clinic_light', category: 'rehab', equipment: ['therapy putty'], dose: 'Only as prescribed by your physio; doses here are placeholders. Typical starting point: 2–3 sets of 10 squeezes.' }],
  ['rower', { id: 'rower', gate: 'grip_cleared', category: 'conditioning', equipment: ['rowing machine'], dose: 'Zone 2: 10–20 min at about 20–24 strokes per minute. Build by 2–5 min per session.' }],
  ['farmer-carry', { id: 'farmer-carry', gate: 'grip_cleared', category: 'carry', equipment: ['dumbbells (or kettlebells if available)', 'clear 20–30 m lane'], dose: '4 × 30–40 s, 75–90 s rest. Add 2 kg per hand when every trip feels strong and tall.' }],
  ['suitcase-carry-good-hand', { id: 'suitcase-carry-good-hand', gate: 'grip_cleared', category: 'carry', equipment: ['dumbbell (or kettlebell if your gym has them)'], dose: '3–4 × 20–30 m; start light (around 8–12 kg)' }],
  ['incline-push-up', { id: 'incline-push-up', gate: 'full_clearance', category: 'push', equipment: ['Smith machine bar locked at chest-to-hip height, or a barbell in a rack'], dose: '3 × 6–12, RIR 2–3. Lower the bar one notch when 3 × 12 is easy.' }],
  ['kb-swing-two-hand', { id: 'kb-swing-two-hand', gate: 'full_clearance', category: 'power', equipment: ['kettlebell (not confirmed at your gym)'], dose: 'Start with 5–10 sets of 5–10 swings, resting as needed.' }],
]);

test('BT2-2/3: allowedForPhase offers only exercises at or below the current phase gate, never above your clearances, never unavailable', () => {
  const opts = { program: R4, exById: LIB4 };
  const cl = { good_arm_ok: '2025-11-21', grip_cleared: '2025-12-02' };
  const d = { profile: profile(cl) };
  const ids = ['leg-press', 'rower', 'ga-cable-row', 'incline-push-up', 'sled-drag-forward-belt', 'ghost'];
  // Grip is cleared on 2 Dec, but Phase 1 (gate none) runs until 19 Jan: no rower yet (BT2-3).
  assert.deepEqual(ids.map((id) => whyNotAllowed(id, '2025-12-11', d, opts)), [null, 'phase', 'phase', 'locked', 'unavailable', 'unknown']);
  assert.deepEqual(ids.map((id) => allowedForPhase(id, '2025-12-11', d, opts)), [true, false, false, false, false, false]);
  assert.equal(phaseGateOn('2025-12-11', d, opts), 'none');
  const p2 = buildTimeline(R4, d.profile).phases[1].start;
  assert.equal(p2, '2026-01-19');
  assert.deepEqual([phaseGateOn(p2, d, opts), allowedForPhase('rower', p2, d, opts), allowedForPhase('ga-cable-row', p2, d, opts)], ['grip_cleared', true, true]);
  assert.equal(whyNotAllowed('rower', '2025-11-26', d, opts), 'locked', 'before the clearance: locked first');
  // The good-arm add-on's own session may offer good-arm work, never above your clearances.
  assert.equal(allowedForPhase('ga-cable-row', '2025-12-10', d, { ...opts, sessionId: 'crossed' }), true);
  assert.equal(allowedForPhase('ga-cable-row', '2025-12-10', { profile: profile() }, { ...opts, sessionId: 'crossed' }), false);
  assert.equal(allowedForPhase('rower', '2025-12-10', d, { ...opts, gate: 'grip_cleared' }), true, 'an explicit ceiling');
  assert.equal(allowedForPhase('sled-drag-forward-belt', '2025-12-11', { profile: profile(cl, { unavailable_exercises: [] }) }, opts), true, 'your own gym list');
  assert.equal(allowedForPhase('leg-press', '2025-12-11', profile(cl), opts), true, 'a profile works too');
  assert.equal(phaseGateOn('2025-11-02', d, opts), 'none', 'before the programme: the first phase');
  assert.equal(phaseGateOn('2026-06-02', d, { program: null }), 'none', 'no programme: gate none only (fail safe)');
  assert.equal(phaseGateOn('2026-06-02', d, { program: { phases: [{ id: 'x', entry_gate: 'banana', weeks: 1, week_template: {} }] } }), 'none', 'an unknown entry gate opens nothing');
  // Defaults to the loaded content.
  const saved = [content.program, content.exById];
  try {
    content.program = R4;
    content.exById = LIB4;
    assert.deepEqual([allowedForPhase('rower', '2025-12-11', d), allowedForPhase('rower', p2, d)], [false, true]);
  } finally {
    [content.program, content.exById] = saved;
  }
});

test('BT2-2/3: prescriptionFor gives a swapped-in exercise its own type, kg column, cues and default dose', () => {
  const p = (id, o = {}) => prescriptionFor(id, { exById: LIB4, ...o });
  let r = p('leg-press');
  assert.deepEqual([r.type, r.kind, r.kg, r.sets, r.reps, r.rir, r.load, r.per_side], ['loaded', 'strength', true, 3, '8-12', '2-3', 'double-progression', false]);
  assert.deepEqual(r.cues, ['Feet mid-platform', 'Three seconds down']);
  assert.match(r.dose, /^3 × 8–12/);
  const capped = resolveBlock(r.block, { week: 1, override: { sets_max: 2, rir: '3-4' } });
  assert.deepEqual([capped.kind, capped.sets, capped.reps, capped.rir], ['strength', 2, '8-12', '3-4'], 'the day’s rules apply to it like any block');
  assert.equal(resolveBlock(r.block, { easyDay: true }).rir, HOLD_RIR);
  r = p('wall-sit');
  assert.deepEqual([r.type, r.kind, r.kg, r.sets, r.seconds, r.secondsRange, r.load], ['timed', 'timed', false, 3, 30, { min: 30, max: 45 }, 'bodyweight']);
  r = p('farmer-carry');
  assert.deepEqual([r.type, r.kg, r.sets, r.seconds, r.load], ['timed', true, 4, 30, ''], 'a carry is timed and loaded');
  r = p('split-squat-bw');
  assert.deepEqual([r.type, r.kg, r.reps, r.per_side, r.load, r.rir], ['reps', false, '8-10', true, 'bodyweight', '2-3']);
  assert.deepEqual([p('patrick-step').type, p('patrick-step').kg], ['reps', false], '"not a stack of plates" is not a load');
  assert.deepEqual([p('incline-push-up').type, p('incline-push-up').kg], ['reps', false], 'a locked Smith bar is a handle, not a load');
  r = p('stair-climber');
  assert.deepEqual([r.type, r.kind, r.minutes, r.zone, r.kg], ['cardio', 'cardio', 8, 'Z2', false], 'cardio reads its first minutes, not the Phase 4 intervals');
  assert.deepEqual([p('rower').type, p('rower').minutes], ['cardio', 10]);
  r = p('sled-drag-forward-belt');
  assert.deepEqual([r.type, r.unit, r.metres, r.sets, r.kg], ['loaded', 'm', 20, 6, true]);
  assert.deepEqual([p('suitcase-carry-good-hand').unit, p('suitcase-carry-good-hand').kg], ['m', true]);
  assert.deepEqual([p('single-leg-balance').type, p('single-leg-balance').seconds, p('single-leg-balance').per_side, p('single-leg-balance').sets], ['timed', 30, true, 1]);
  assert.deepEqual([p('hip-90-90-switch').type, p('hip-90-90-switch').reps, p('hip-90-90-switch').per_side], ['reps', '8', false]);
  assert.deepEqual([p('kb-swing-two-hand').sets, p('kb-swing-two-hand').reps, p('kb-swing-two-hand').kg], [5, '5-10', true]);
  r = p('rehab-putty-grip');
  assert.deepEqual([r.type, r.load, r.kg, r.kind], ['physio', 'physio', false, 'strength']);
  assert.equal(p('ghost'), null, 'not in the library: nothing (it’s locked anyway)');
  assert.deepEqual([p('leg-extension').sets, p('leg-extension', { sets: 3 }).sets, p('leg-extension', { sets: 5 }).sets, p('leg-extension', { sets: 1 }).sets], [2, 3, 3, 2], 'a swap keeps the block’s sets within the exercise’s own range');
  assert.equal(prescriptionFor('leg-press', LIB4).type, 'loaded', 'the library may be passed as a Map');
  assert.equal(parseDose('').type, 'other');
  assert.equal(parseDose('As prescribed by your physio (about 10–15 min, usually daily)').type, 'physio');
  const saved = content.exById;
  try { content.exById = LIB4; assert.equal(prescriptionFor('wall-sit').type, 'timed'); } finally { content.exById = saved; }
});

// ---------------------------------------------------------------- BT2-6: the arm log in readiness
test('BT2-6: same-day arm-log pain of 7 or more is RED, exactly like the check-in’s arm pain', () => {
  const day = '2025-12-03';
  const data = (values, checkins = []) => ({ profile: profile(), checkins, arm: { logs: [{ date: day, values, notes: '' }, { date: '2025-12-02', values: { pain_rest: 9 } }] } });
  let r = readinessOn(data({ pain_rest: 3, pain_activity: 7 }), day);
  assert.deepEqual([r.level, r.stop, r.holdLoads, r.checkedIn], ['red', true, true, false], 'even without a check-in');
  assert.match(r.reasons.join(' | '), /Arm log: pain with activity 7\/10 \(7 or more\)/);
  assert.deepEqual(r.messages, [READINESS_MESSAGES.red]);
  assert.deepEqual([r.armLog.field, r.armLog.value], ['pain_activity', 7]);
  assert.equal(readinessOn(data({ pain_rest: 6, pain_activity: 6 }), day).level, 'unknown', '6/10 is not red (and no check-in yet)');
  const green = [{ date: day, sleep_h: 8, energy: 4, arm_pain: 1 }];
  assert.equal(readinessOn(data({ pain_rest: 6 }, green), day).level, 'green');
  assert.equal(readinessOn(data({ pain_rest: 8 }, green), day).level, 'red', 'the arm log beats a green check-in');
  assert.equal(readinessOn(data({ pain_rest: '7' }), day).level, 'red', 'a number typed as text');
  assert.equal(readinessOn(data({ pain_night: 8 }), day).level, 'red', 'every pain score counts (fail safe)');
  assert.equal(readinessOn(data({ grip_injured_kg: 12 }), day).level, 'unknown', 'other measurements are not pain');
  assert.equal(readinessOn(data({ pain_rest: 2 }), '2025-12-04').level, 'unknown', 'only the same day');
  assert.equal(readinessOn({ data: data({ pain_activity: 7 }) }, day).level, 'red', 'a view ctx works too');
  const dup = { arm: { logs: [{ date: day, values: { pain_rest: 2 } }, { date: day, values: { pain_activity: 8 } }] } };
  assert.deepEqual([armLogPainOn(dup, day).value, armLogPainOn(dup, day).label], [8, 'pain with activity'], 'two logs on one date: the worst');
  assert.equal(armLogPainOn(dup, '2025-01-02'), null);
  assert.equal(readiness({ date: day, sleep_h: 8 }, [], {}, { armLog: 7 }).level, 'red', 'readiness() takes it as an option');
  // readinessHistory and redDays agree with readinessOn.
  const d = data({ pain_activity: 7 }, [{ date: '2025-12-01', sleep_h: 8 }, { date: day, sleep_h: 8 }]);
  const hist = readinessHistory(d);
  assert.deepEqual([hist.get(day).level, hist.get('2025-12-02').level, hist.get('2025-12-01').level], ['red', 'red', 'green'], 'a red arm-log date without a check-in gets an entry');
  assert.deepEqual([...hist.keys()], ['2025-12-01', '2025-12-02', day], 'in date order');
  assert.equal(readinessHistory(d.checkins, d.profile, { armLogs: d.arm.logs }).get(day).level, 'red');
  assert.equal(readinessHistory(d.checkins, d.profile).get(day).level, 'green', 'without the logs: the check-in alone (as before)');
  assert.deepEqual([...redDays(d)].sort(), ['2025-12-02', day]);
  assert.deepEqual([...redDays({ checkins: [{ date: day, arm_flags: ['swelling_new'] }, { date: '2025-12-06', arm_pain: 7 }, { date: '2025-12-07', arm_pain: 6 }] })].sort(), [day, '2025-12-06']);
});

// ---------------------------------------------------------------- BT3-7: weight bands and the fortnightly verdict
/** Daily weigh-ins from `from` for `n` days: start kg plus `perWeek` a week (optional tweak by date). */
const weighIns = (from, n, start, perWeek, tweak = () => 0) => Array.from({ length: n }, (_, i) => {
  const date = addDays(from, i);
  return { date, weight_kg: start + (perWeek * i) / 7 + tweak(date) };
});

test('BT3-7: gain bands for an experienced lifter (regain below the pre-injury weight, then lean gain)', () => {
  assert.deepEqual(GAIN_BAND, [0.2, 0.4], 'the old export is unchanged');
  assert.deepEqual([GAIN_BANDS.regain.lo, GAIN_BANDS.regain.hi, GAIN_BANDS.lean.lo, GAIN_BANDS.lean.hi, GAIN_BANDS.default.lo, GAIN_BANDS.default.hi], [0.25, 0.5, 0.15, 0.3, 0.2, 0.4]);
  assert.deepEqual([gainBand({}, 74).id, gainBand({ pre_injury_weight_kg: 78 }, 74).id, gainBand({ pre_injury_weight_kg: 78 }, 78).id, gainBand({ pre_injury_weight_kg: 78 }, 79).id], ['default', 'regain', 'lean', 'lean']);
  assert.equal(gainBand({ pre_injury_weight_kg: 78 }, null).id, 'default', 'no average yet');
  assert.equal(gainBand({ profile: { pre_injury_weight_kg: '78' } }, 74).id, 'regain', 'the data and text numbers work too');
  assert.deepEqual([preInjuryWeight({ pre_injury_weight_kg: 735 }), preInjuryWeight({}), preInjuryWeight({ pre_injury_weight_kg: 76.5 })], [null, null, 76.5]);
  assert.equal(gainBand({ pre_injury_weight_kg: 78 }, 74).text, '+0.25 to +0.5 kg a week');
  assert.equal(bandText(GAIN_BANDS.lean), '+0.15 to +0.3 kg a week');
});

test('BT3-7: one weight verdict per fortnight (non-overlapping windows, 10+ weigh-ins) shared by every page', () => {
  const data = { profile: profile(), checkins: weighIns('2025-11-10', 63, 74, 0.3) };
  assert.equal(weightVerdict(data, '2025-12-06').status, 'waiting', 'nothing before the first fortnight ends');
  assert.match(weightVerdict(data, '2025-12-06').text, /first weight verdict is on Sun 7 Dec/);
  const v = weightVerdict(data, '2025-12-07');
  assert.deepEqual([v.status, v.state, v.verdict, v.window.start, v.window.end, v.window.weighIns, v.next, v.band.id, v.nudge], ['in', 'in', 'in', '2025-11-24', '2025-12-07', 14, '2025-12-21', 'default', null]);
  assert.ok(Math.abs(v.rate - 0.3) < 1e-6, `(7-day average − the one two weeks earlier) / 2 = ${v.rate}`);
  assert.match(v.text, /rose 0\.3 kg a week over the fortnight to Sun 7 Dec .*inside your gain band of \+0\.2 to \+0\.4 kg a week\. Change nothing\./);
  // The same verdict all fortnight, whatever is logged after the window ends.
  const jumpy = { ...data, checkins: data.checkins.map((c) => (c.date === '2025-12-16' ? { ...c, weight_kg: 90 } : c)) };
  for (const d of ['2025-12-08', '2025-12-14', '2025-12-20']) assert.deepEqual([weightVerdict(jumpy, d).window.end, weightVerdict(jumpy, d).rate], [v.window.end, v.rate], d);
  assert.equal(weightVerdict(data, '2025-12-21').window.end, '2025-12-21', 'then the next fortnight');
  assert.equal(weightVerdict(data, '2025-12-21').previous.status, 'in');
  // Bands: regain while below the pre-injury weight, lean gain once at or above it.
  const fast = { profile: profile(), checkins: weighIns('2025-11-10', 28, 74, 0.4) };
  assert.equal(weightVerdict(fast, '2025-12-07').status, 'in', '+0.4: inside +0.2 to +0.4');
  assert.deepEqual([weightVerdict({ ...fast, profile: profile({}, { pre_injury_weight_kg: 80 }) }, '2025-12-07').band.id, weightVerdict({ ...fast, profile: profile({}, { pre_injury_weight_kg: 80 }) }, '2025-12-07').status], ['regain', 'in']);
  const lean = weightVerdict({ ...fast, profile: profile({}, { pre_injury_weight_kg: 70 }) }, '2025-12-07');
  assert.deepEqual([lean.band.id, lean.status, lean.nudge], ['lean', 'above', 'eat-less']);
  assert.match(lean.text, /above your lean-gain band of \+0\.15 to \+0\.3 kg a week\. Take off 100–150 kcal a day and stay above maintenance/);
  // Below the band, twice in a row; drifting down never suggests dieting.
  const slow = weightVerdict({ profile: profile(), checkins: weighIns('2025-11-02', 50, 74, 0.1) }, '2025-12-21');
  assert.deepEqual([slow.status, slow.nudge, slow.twice, slow.previous.status], ['below', 'eat-more', true, 'below']);
  assert.match(slow.text, /Add 150–200 kcal a day.*second fortnight in a row/);
  const down = weightVerdict({ profile: profile(), checkins: weighIns('2025-11-10', 28, 74, -0.2) }, '2025-12-07');
  assert.deepEqual([down.status, down.state, down.losing], ['below', 'losing', true]);
  assert.ok(LOSING_KG_WEEK < 0);
  assert.match(down.text, /fell 0\.2 kg a week.*No dieting while the bone heals: add 250–300 kcal a day/);
  // At least 10 weigh-ins in the fortnight (and 3 behind each average).
  const sparse = { profile: profile(), checkins: data.checkins.filter((c) => !['2025-11-25', '2025-11-26', '2025-11-27', '2025-11-28', '2025-11-29'].includes(c.date)) };
  const s9 = weightVerdict(sparse, '2025-12-07');
  assert.deepEqual([s9.status, s9.window.weighIns, s9.rate, s9.nudge], ['insufficient', 9, null, null]);
  assert.match(s9.text, /9 of the 10 mornings needed/);
  assert.equal(weightVerdict({ profile: profile(), checkins: weighIns('2025-11-24', 14, 74, 0.3) }, '2025-12-07').status, 'insufficient', 'no weigh-ins two weeks earlier');
  // Typos never move it; two weigh-ins on one morning are averaged.
  const typo = { ...data, checkins: [...data.checkins, { date: '2025-12-02', weight_kg: 735 }] };
  assert.equal(weightVerdict(typo, '2025-12-07').rate, v.rate);
  const twice = { ...data, checkins: [...data.checkins, { ...data.checkins.find((c) => c.date === '2025-12-03'), weight_kg: 74 + (0.3 * 23) / 7 + 0.7 }, { ...data.checkins.find((c) => c.date === '2025-12-03'), weight_kg: 74 + (0.3 * 23) / 7 - 0.7 }] };
  assert.ok(Math.abs(weightVerdict(twice, '2025-12-07').rate - v.rate) < 0.02);
  assert.equal(weightVerdict(data, 'soon'), null);
  assert.equal(weightVerdict({ data }, '2025-12-07').status, 'in', 'a view ctx works too');
  assert.equal(weightVerdict(data, '2025-12-14', { start: '2025-12-01' }).window.end, '2025-12-14', '{start} moves the fortnights');
  assert.deepEqual([WEIGHT_RULES.windowDays, WEIGHT_RULES.minWeighIns, WEIGHT_RULES.afterFastingDays], [14, 10, 14]);
});

test('BT3-7: fasting and the 14 days after it are ignored; no verdict (hold steady) meanwhile', () => {
  // Mon–Fri of programme week 8; the pause runs to Fri 30 Jan (the fast's end + 14 days).
  const fast = { start: '2026-01-12', end: '2026-01-16', label: 'Planned fast' };
  // Steady gain, a 1.5 kg dip while fasting and a rebound in the fortnight after.
  const tweak = (d) => (d >= fast.start && d <= fast.end ? -1.5 : d > fast.end && d <= '2026-01-30' ? -0.75 : 0);
  const data = { profile: profile({}, { fasting_periods: [fast] }), checkins: weighIns('2025-12-14', 120, 76, 0.25, tweak) };
  assert.equal(weightVerdict(data, '2026-01-04').status, 'in', 'before the fast');
  let v = weightVerdict(data, '2026-01-14');
  assert.deepEqual([v.status, v.reason, v.until, v.nudge, v.rate], ['paused', 'fasting', '2026-01-30', null, null]);
  assert.match(v.text, /^Fasting: aim to hold your weight steady/);
  v = weightVerdict(data, '2026-01-25');
  assert.deepEqual([v.status, v.reason], ['paused', 'after-fasting']);
  v = weightVerdict(data, '2026-02-15');
  assert.deepEqual([v.status, v.reason, v.window.end], ['paused', 'after-fasting', '2026-02-15'], 'its baseline week fell in the pause');
  v = weightVerdict(data, '2026-03-01');
  assert.equal(v.status, 'in', 'the first clean fortnight after the pause');
  assert.ok(v.rate > 0.2 && v.rate < 0.3, `the dip and the rebound are ignored (${v.rate})`);
  assert.equal(weightVerdict(data, '2026-01-18').status, 'paused', 'a fortnight ending in the pause: paused');
});

// ---------------------------------------------------------------- BT1-4: a hike counts as the long walk
test('BT1-4: a logged hike of at least 70% of the planned minutes counts as the long walk, once', () => {
  const sat = '2025-11-29'; // p1 week 1: the walk plans 45 minutes
  const ctx = (data, today = '2025-11-30') => makeCtx({ program: R4, profile: profile(), data: { profile: profile(), ...data }, today });
  const plan = plannedOn(R4, profile(), sat);
  const walk = plan.sessions[0];
  assert.deepEqual([isHikeSession(walk), plannedHikeMinutes(walk, plan), HIKE_COVERS_SHARE], [true, 45, 0.7]);
  let d = dayInfo(ctx({ hikes: [{ id: 'h1', date: sat, duration_min: 32, distance_km: 3 }] }), sat);
  assert.deepEqual([d.status, d.mainDone, d.hikeDone, d.viaHike, d.mainCovered, d.viaAlternate, d.hikes[0].id], ['done', 1, 1, true, 1, false, 'h1'], '32 min ≥ 70% of 45');
  assert.deepEqual([dayInfo(ctx({ hikes: [{ id: 'h1', date: sat, duration_min: 31 }] }), sat).status], ['missed'], '31 min is not enough');
  assert.equal(dayInfo(ctx({ hikes: [{ id: 'h1', date: sat, distance_km: 9 }] }), sat).status, 'missed', 'a hike needs its time');
  d = dayInfo(ctx({ workouts: [wk('wl', sat, 'walk')], hikes: [{ id: 'h1', date: sat, duration_min: 50, workout_id: 'wl' }] }), sat);
  assert.deepEqual([d.mainDone, d.hikeDone, d.mainCovered], [1, 0, 1], 'logged in Train and added to the hike log: counted once');
  d = dayInfo(ctx({ hikes: [{ id: 'a', date: sat, duration_min: 60 }, { id: 'b', date: sat, duration_min: 90 }] }), sat);
  assert.deepEqual([d.mainDone, d.hikeDone], [1, 1], 'two hikes still cover one walk');
  assert.equal(dayInfo(ctx({ hikes: [{ id: 'a', date: '2025-11-24', duration_min: 120 }] }), '2025-11-24').status, 'missed', 'a hike never stands in for Strength A');
  d = dayInfo(ctx({ workouts: [wk('x', sat, 'adhoc')], hikes: [{ id: 'h', date: sat, duration_min: 40, workout_id: 'x' }] }), sat);
  assert.deepEqual([d.status, d.hikeDone], ['done', 1], 'a hike linked to an ad-hoc session still covers the walk');
  // Week 2 plans 60 minutes: 42 is enough, 41 isn't.
  assert.deepEqual(['2025-12-06', '2025-12-06'].map((dt, i) => dayInfo(ctx({ hikes: [{ id: 'h', date: dt, duration_min: [42, 41][i] }] }, '2025-12-07'), dt).status), ['done', 'missed']);
  assert.deepEqual([hikeCovers({ duration_min: 10 }, null), hikeCovers(null, 10), hikeCovers({ duration_min: '35' }, 50)], [true, false, true]);
  // The week's figures and the streak count it.
  const all = { workouts: ['2025-11-24', '2025-11-25', '2025-11-26', '2025-11-27', '2025-11-28'].map((dt, i) => wk(`w${i}`, dt, ['str-a', 'z2', 'str-b', 'z2', 'str-c'][i])), hikes: [{ id: 'h', date: sat, duration_min: 45 }] };
  const sum = weekSummary(ctx(all), '2025-11-24');
  assert.deepEqual([sum.mainPlanned, sum.mainDone, sum.mainDoneStrict, sum.adherencePct, sum.hikeDone], [6, 6, 6, 100, 1]);
  assert.equal(streak(ctx(all)), 6, 'Mon–Sat; today (Sunday rest) counts once it is done');
});

// ---------------------------------------------------------------- BT2-9 / BT3: neutral days
test('BT2-9 / BT3: RED and fasting days are neutral: never missed, never break a streak, left out of adherence', () => {
  const ctx = (data, today = '2025-12-07') => makeCtx({ program: R4, profile: data.profile || profile(), data: { profile: profile(), ...data }, today });
  const week2 = ['2025-12-01', '2025-12-02', '2025-12-03', '2025-12-04', '2025-12-05', '2025-12-06'];
  const sessions = ['str-a', 'z2', 'str-b', 'z2', 'str-c', 'walk'];
  const trained = (skip = []) => week2.map((dt, i) => wk(`w${i}`, dt, sessions[i])).filter((w) => !skip.includes(w.date));
  const base = ['2025-11-24', '2025-11-25', '2025-11-26', '2025-11-27', '2025-11-28', '2025-11-29'].map((dt, i) => wk(`v${i}`, dt, sessions[i]));
  // RED Wednesday (arm pain 8), no session: neutral.
  let data = { checkins: [{ date: '2025-12-03', arm_pain: 8 }], workouts: [...base, ...trained(['2025-12-03'])] };
  let d = dayInfo(ctx(data), '2025-12-03');
  assert.deepEqual([d.status, d.neutral, d.excused, d.plannedCounted], ['neutral', 'red', 1, 0]);
  let sum = weekSummary(ctx(data), '2025-12-01');
  assert.deepEqual([sum.mainPlanned, sum.mainPlannedRaw, sum.mainExcused, sum.mainDone, sum.adherencePct, sum.neutralDays], [5, 6, 1, 5, 100, 1]);
  assert.equal(streak(ctx(data)), 12, 'skipped, not broken: the 13 days since the start minus the RED one');
  // The same day without the RED check-in is missed and breaks it.
  data = { workouts: [...base, ...trained(['2025-12-03'])] };
  assert.deepEqual([dayInfo(ctx(data), '2025-12-03').status, weekSummary(ctx(data), '2025-12-01').adherencePct, streak(ctx(data))], ['missed', 83, 3]);
  // An arm-log RED day is neutral too.
  data = { arm: { logs: [{ date: '2025-12-03', values: { pain_activity: 7 } }] }, workouts: [...base, ...trained(['2025-12-03'])] };
  assert.equal(dayInfo(ctx(data), '2025-12-03').status, 'neutral');
  // Fasting days: a missed one is neutral, a trained one counts, today's is still open, future ones are planned.
  const fasting = profile({}, { fasting_periods: [{ start: '2025-12-02', end: '2025-12-11' }] });
  data = { profile: fasting, workouts: [...base, ...trained(['2025-12-02', '2025-12-04'])] };
  const c = ctx(data, '2025-12-09');
  assert.deepEqual(['2025-12-02', '2025-12-03', '2025-12-04', '2025-12-09', '2025-12-10'].map((dt) => [dayInfo(c, dt).status, dayInfo(c, dt).neutral]),
    [['neutral', 'fasting'], ['done', 'fasting'], ['neutral', 'fasting'], ['today', 'fasting'], ['planned', 'fasting']]);
  sum = weekSummary(c, '2025-12-01');
  assert.deepEqual([sum.mainPlanned, sum.mainDone, sum.adherencePct, sum.mainExcused], [4, 4, 100, 2]);
  assert.equal(streak(makeCtx({ program: R4, profile: fasting, data: { ...data, workouts: [...data.workouts, wk('m', '2025-12-08', 'str-a')] }, today: '2025-12-08' })), 13);
  // Today RED: neutral at once (no training today), and the streak stands.
  data = { checkins: [{ date: '2025-12-08', arm_flags: ['swelling_new'] }], workouts: [...base, ...trained()] };
  const t = ctx(data, '2025-12-08');
  assert.deepEqual([dayInfo(t, '2025-12-08').status, dayInfo(t, '2025-12-08').excused], ['neutral', 1]);
  assert.equal(streak(t), 14);
  assert.equal(weekSummary(t, '2025-12-08').mainPlannedToDate, 0);
});

// ---------------------------------------------------------------- BT3-12: the hold RIR
test('BT3-12: resolveBlock shows the hold RIR (3–4) on easy days, in fasting periods and in deload weeks without their own RIR', () => {
  const b = { exercise: 'leg-press', sets: 3, reps: '8-12', rir: '2-3', load: 'double-progression' };
  assert.equal(HOLD_RIR, '3-4');
  let r = resolveBlock(b, {});
  assert.deepEqual([r.rir, r.holdRir, r.rirPlanned, r.sets], ['2-3', undefined, undefined, 3]);
  r = resolveBlock(b, { easyDay: true });
  assert.deepEqual([r.rir, r.holdRir, r.rirPlanned, r.sets, r.setsNote], ['3-4', true, '2-3', 2, 'easy day: sets halved']);
  r = resolveBlock(b, { fasting: true });
  assert.deepEqual([r.rir, r.sets, r.fasting, r.setsNote], ['3-4', 2, true, 'fasting period: sets halved'], 'fasting implies easy-day mode');
  r = resolveBlock(b, { easyDay: true, override: { rir: '1-2' } });
  assert.equal(r.rir, '3-4', 'the hold beats the week’s RIR');
  assert.deepEqual([resolveBlock(b, { override: { deload: true } }).rir, resolveBlock(b, { override: { deload: true, rir: '3' } }).rir, resolveBlock(b, { override: { rir: '1-2' } }).rir], ['3-4', '3', '1-2'], 'a deload or taper RIR from the designer wins');
  assert.equal(resolveBlock({ exercise: 'wall-sit', sets: 2, seconds: 45 }, { easyDay: true }).rir, '', 'a timed hold gets no RIR it never had');
  assert.equal(resolveBlock({ exercise: 'x-physio-programme', sets: 1, reps: '10', load: 'physio' }, { easyDay: true }).rir, '', 'physio work is as prescribed');
  assert.equal(resolveBlock({ exercise: 'incline-walk', minutes: 30, zone: 'Z2-Z3' }, { fasting: true }).zone, 'Z2', 'fasting: Zone 2 only');
  assert.equal(resolveBlock(blk.iv, { fasting: true }).easyReplaced, true, 'fasting: no intervals');
  assert.deepEqual(plannedFromBlock(resolveBlock(b, { easyDay: true })), { sets: 2, reps: '8-12', rir: '3-4', load: 'double-progression' });
  assert.deepEqual(plannedFromBlock(resolveBlock({ exercise: 'wall-sit', sets: 3, seconds: 45 }, { override: { sets_max: 2 } })), { sets: 2, reps: null, rir: '', load: '', seconds: 45 });
  assert.equal(plannedFromBlock(resolveBlock({ exercise: 'walk-outdoor', minutes: 30 })), null);
});

// ---------------------------------------------------------------- tests.json scheduling fields: testsDueOn
test('tests.json scheduling: baselines spread over Mon–Wed, dead hang and farmer’s carry from p4a week 4, nothing while fasting', () => {
  const T = [
    { id: 'sit', gate: 'none', every_weeks: 4, baseline_day: 1 }, { id: 'ktw', gate: 'none', every_weeks: 4, baseline_day: 1 },
    { id: 'bal', gate: 'none', every_weeks: 4, baseline_day: 1 }, { id: 'mile', gate: 'none', every_weeks: 4, baseline_day: 2 },
    { id: 'heel', gate: 'none', every_weeks: 4, baseline_day: 3 }, { id: 'hollow', gate: 'none', every_weeks: 4, baseline_day: 3 },
    { id: 'hang', gate: 'full_clearance', every_weeks: 4, first_phase: 'p4a', first_week: 4 },
    { id: 'farmer', gate: 'full_clearance', every_weeks: 4, first_phase: 'p4a', first_week: 4 },
  ];
  const ids = (list) => list.map((s) => s.id);
  const data = { profile: profile(), tests: [] };
  const due = (d, date, o = { program: R4 }) => ids(testsDueOn(d, date, T, o));
  assert.deepEqual(due(data, '2025-11-23'), [], 'nothing before the programme starts');
  assert.deepEqual(due(data, '2025-11-24'), ['sit', 'ktw', 'bal'], 'Monday: day-1 baselines');
  assert.deepEqual(due(data, '2025-11-25'), ['sit', 'ktw', 'bal', 'mile'], 'Tuesday adds the 1-mile walk');
  assert.deepEqual(due(data, '2025-11-26'), ['sit', 'ktw', 'bal', 'mile', 'heel', 'hollow'], 'Wednesday: all six, most overdue first');
  const s = testsDueOn(data, '2025-11-26', T, { program: R4 })[0];
  assert.deepEqual([s.state, s.dueOn, s.overdueDays, s.baseline, s.test.id], ['due', '2025-11-24', 2, true, 'sit']);
  // Retests every_weeks after the result.
  const done = { profile: profile(), tests: [{ date: '2025-11-24', test: 'sit', value: 18 }] };
  assert.deepEqual([testStatusOn(done, '2025-12-21', T[0], { program: R4 }).state, testStatusOn(done, '2025-12-22', T[0], { program: R4 }).state], ['done', 'due']);
  // The dead hang and farmer's carry: locked until full clearance, then not before p4a week 4.
  assert.equal(testStatusOn(data, '2026-06-02', T[6], { program: R4 }).state, 'locked');
  const cleared = { profile: profile({ full_clearance: '2026-01-07' }), tests: [] };
  const tl = buildTimeline(R4, cleared.profile);
  const p4a = tl.phases.find((p) => p.id === 'p4a').start;
  assert.equal(p4a, '2026-03-02');
  assert.deepEqual([testEarliestDue(T[6], tl), testBaselineDue(T[6], tl)], ['2026-03-23', '2026-03-23']);
  assert.deepEqual([testStatusOn(cleared, '2026-03-22', T[6], { program: R4 }).state, testStatusOn(cleared, '2026-03-22', T[6], { program: R4 }).dueOn], ['scheduled', '2026-03-23']);
  assert.deepEqual(due(cleared, '2026-03-23').filter((x) => x === 'hang' || x === 'farmer'), ['hang', 'farmer']);
  const waiting = { profile: profile({ full_clearance: '2026-01-07' }), tests: [] };
  assert.deepEqual([testStatusOn(waiting, '2026-02-02', T[6], { program: { ...R4, phases: R4.phases.slice(0, 2) } }).state, testStatusOn(waiting, '2026-02-02', T[6], { program: { ...R4, phases: R4.phases.slice(0, 2) } }).dueOn], ['scheduled', null], 'its phase isn’t in the programme: never due');
  // Fasting: nothing is due; a due date inside the fast moves to the day after it.
  const fast = { profile: profile({}, { fasting_periods: [{ start: '2025-11-26', end: '2025-11-28' }] }), tests: [] };
  assert.deepEqual(due(fast, '2025-11-26'), []);
  assert.deepEqual([testStatusOn(fast, '2025-11-27', T[0], { program: R4 }).state, testStatusOn(fast, '2025-11-27', T[4], { program: R4 }).state, testStatusOn(fast, '2025-11-27', T[4], { program: R4 }).dueOn],
    ['paused', 'scheduled', '2025-11-29']);
  assert.deepEqual(due(fast, '2025-11-29'), ['sit', 'ktw', 'bal', 'mile', 'heel', 'hollow']);
  assert.equal(testsDueOn(fast, '2025-11-29', T, { program: R4 }).find((x) => x.id === 'heel').overdueDays, 0, 'counted from the day after the fast');
  // The older argument order and tests.json forms still work.
  assert.deepEqual(ids(testsDueOn(data, T, '2025-11-25', tl)), ['sit', 'ktw', 'bal', 'mile']);
  const legacy = { id: 'lp', gate: 'none', every_weeks: 4, baseline: { phase: 'p1', week: 2, day: 5 } };
  assert.equal(testBaselineDue(legacy, buildTimeline(R4, profile())), '2025-12-05', 'Friday of Phase 1 week 2');
  assert.equal(testBaselineDue({ id: 'f', due_from: '2025-12-11' }, buildTimeline(R4, profile())), '2025-12-11');
  assert.equal(testBaselineDue({ id: 'w', baseline_week: 3 }, buildTimeline(R4, profile())), '2025-12-08');
  assert.equal(testBaselineDue({ id: 'x', first_phase: 'p9' }, buildTimeline(R4, profile())), null, 'an unknown phase is never due');
  // Without a programme: baselines from profile.program_start; phase-gated tests never.
  assert.deepEqual(ids(testsDueOn(data, '2025-11-26', T, { program: null })), ['sit', 'ktw', 'bal', 'mile', 'heel', 'hollow']);
  assert.deepEqual(ids(testsDueOn({ profile: profile({ full_clearance: '2025-01-02' }), tests: [] }, '2026-06-02', T, { program: null })).includes('hang'), false);
  // Defaults to the loaded content.
  const saved = [content.program, content.tests];
  try {
    content.program = R4;
    content.tests = T;
    assert.deepEqual(ids(testsDueOn(data, '2025-11-25')), ['sit', 'ktw', 'bal', 'mile']);
  } finally {
    [content.program, content.tests] = saved;
  }
  assert.deepEqual(testsDueOn(data, 'not a date', T), []);
});

// ---------------------------------------------------------------- weekend_plan program_week
test('weekend_plan: program_week (relative to the programme start) takes precedence over week_start', () => {
  const hikes = { weekend_plan: [
    { week_start: '2025-12-08', name: 'C' },
    { program_week: 2, week_start: '2026-01-05', name: 'B' },
    { program_week: 1, name: 'A', level: 1 },
    { week_start: '2025-12-01', name: 'B-old' },
    { program_week: 0, name: 'bad' }, { name: 'nothing' }, null,
  ] };
  // No programme start: the default is the Monday after today, so today is pinned (Sat 22 Nov).
  const now = { today: '2025-11-22' };
  assert.deepEqual([weekendPlanOn(hikes, '2025-11-29', now).name, weekendPlanOn(hikes, '2025-12-06', now).name, weekendPlanOn(hikes, '2025-12-13', now).name], ['A', 'B', 'C'], 'default start Mon 24 Nov');
  assert.equal(weekendPlanOn(hikes, '2025-11-29', now).week_start, '2025-11-24', 'a program_week entry comes back with its Monday');
  assert.equal(weekendPlanOn(hikes, '2026-01-10', now), null, 'week_start is ignored when program_week is set');
  assert.deepEqual([weekendPlanOn(hikes, '2025-12-06', '2025-12-01').name, weekendPlanOn(hikes, '2025-12-06', { profile: { program_start: '2025-12-03' } }).name], ['A', 'A'], 'a later start moves them');
  assert.equal(weekendPlanOn(hikes, '2025-12-13', { data: { profile: { program_start: '2025-12-01' } } }).name, 'B');
  assert.equal(weekendPlanOn(hikes, '2025-12-13', { timeline: { start: '2025-12-01' } }).name, 'B');
  assert.deepEqual(weekendPlanList(hikes, now).map((e) => e.name), ['A', 'B', 'B-old', 'C'], 'sorted by week; program_week first on a tie');
  assert.deepEqual([nextWeekendPlanOn(hikes, '2025-12-09', now).name, nextWeekendPlanOn(hikes, '2026-03-02', now)], ['C', null]);
  assert.deepEqual([weekendPlanStart({ today: '2025-11-22' }), weekendPlanStart('2025-11-26'), weekendPlanStart({ program: { default_start_date: '2025-12-08' } })], ['2025-11-24', '2025-11-24', '2025-12-08']);
  assert.equal(weekendPlanStart(), defaultStart(), 'nothing to go on: the next Monday after today');
  assert.equal(weekendPlanStart({ program: { default_start_date: null }, today: '2025-11-24' }), '2025-12-01', 'a null default_start_date');
  assert.equal(weekendPlanOn(hikes, 'x'), null);
});

test('content.js: weekend_plan program_week entries and tests.json scheduling fields are read and checked', async () => {
  const files = {
    '/content/program.json': JSON.stringify({ phases: [{ id: 'p1', weeks: 2, week_template: { mon: 'rest' } }, { id: 'p4a', entry_gate: 'full_clearance', weeks: 4, week_template: { mon: 'rest' } }], sessions: {} }),
    '/content/exercises/part-a.json': JSON.stringify([{ id: 'leg-press', name: 'Leg press', gate: 'none', arm_safety: 'x', category: 'squat' }]),
    '/content/hikes.json': JSON.stringify({ ladder: [{ level: 1, gate: 'none', criteria: { distance_km: 3 } }], weekend_plan: [
      { week_start: '2025-12-08', name: 'C', level: 1 }, { program_week: 2, name: 'B' }, { program_week: '1', week_start: '2025-11-24', name: 'A' }, { program_week: -1, name: 'Bad' }, { program_week: 'x', week_start: '2025-12-01', name: 'Kept by its date' },
    ] }),
    '/content/tests.json': JSON.stringify([
      { id: 'sit', gate: 'none', baseline_day: 1 }, { id: 'hang', gate: 'full_clearance', first_phase: 'p4a', first_week: 4 },
      { id: 'odd', first_phase: 'p9', first_week: 0, baseline_day: 5 },
    ]),
  };
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => (files[url] === undefined ? fakeRes(404, '') : fakeRes(200, files[url]));
  try {
    await loadContent();
    assert.deepEqual(content.hikes.weekend_plan.map((e) => [e.name, e.program_week ?? null]), [['A', 1], ['B', 2], ['Kept by its date', null], ['C', null]]);
    const hk = content.status.find((x) => x.label === 'Hikes').problems.join('\n');
    assert.match(hk, /"Bad": program_week should be a whole number of at least 1/);
    assert.match(hk, /"Bad" has no valid week_start \(YYYY-MM-DD\) or program_week/);
    assert.equal(weekendPlanOn(content.hikes, '2025-12-02', { today: '2025-11-22' }).name, 'B', 'programme week 2 of a default start (the Monday after today)');
    const tp = content.status.find((x) => x.label === 'Tests').problems.join('\n');
    assert.match(tp, /odd: first_week should be a whole number/);
    assert.match(tp, /odd: baseline_day should be 1, 2 or 3/);
    assert.match(tp, /odd: first_phase "p9" is not a phase in program\.json/);
    assert.doesNotMatch(tp, /hang|sit/);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('profile.pre_injury_weight_kg: stored as a number, checked on import, merged like any profile field', () => {
  const m = migrate({ schema_version: 1, profile: { pre_injury_weight_kg: '78.5' } });
  assert.equal(m.profile.pre_injury_weight_kg, 78.5);
  assert.equal(migrate({ schema_version: 2, profile: {} }).profile.pre_injury_weight_kg, undefined, 'optional: never added');
  const v = validateImportDetailed({ schema_version: 2, profile: { pre_injury_weight_kg: 785 } }, { today: '2025-11-22' });
  assert.ok(v.warnings.some((w) => w.path === 'profile.pre_injury_weight_kg' && /outside the usual 30–250/.test(w.message)));
  assert.ok(validateImportDetailed({ schema_version: 2, profile: { pre_injury_weight_kg: 'heavy' } }, { today: '2025-11-22' }).errors.some((e) => e.path === 'profile.pre_injury_weight_kg'));
});
