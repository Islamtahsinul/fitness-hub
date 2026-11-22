// Content smoke tests: run the hub's logic over the real files in public/content/.
// Run: node --test tests/test_content.mjs   (checks for files that don't exist yet are skipped)
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

import { buildTimeline, positionOn, plannedOn, resolveSession, sessionExerciseIds, gateRank, GATE_ORDER, addDays, withDiskFetch } from './_content_helpers.mjs';
import { renderMarkdown } from '../public/js/markdown.js';
import { content, loadContent, contentProblems, RED_FLAG_IDS, compareExerciseSources, validateProgram } from '../public/js/content.js';
import { alternatesOf, overrideBlockFields } from '../public/js/schedule.js';

const BASE = fileURLToPath(new URL('../public/content/', import.meta.url));
const read = (rel) => {
  try { return JSON.parse(fs.readFileSync(BASE + rel, 'utf8').replace(/^\uFEFF/, '')); } catch { return undefined; }
};
const program = read('program.json');
const exercises = read('exercises.json') || [...(read('exercises/part-a.json') || []), ...(read('exercises/part-b.json') || [])];
const byId = new Map((exercises || []).map((e) => [e.id, e]));
// The shipped program.json has default_start_date: null (the hub then starts the next Monday after
// today), so the tests pin their own Monday to stay deterministic.
const TEST_START = program?.default_start_date || '2025-11-24';
const profile = (cl = {}) => ({ program_start: TEST_START, clearances: { good_arm_ok: null, clinic_light: null, grip_cleared: null, full_clearance: null, ...cl } });

test('program.json ships without a fixed start date (default_start_date null, or a Monday)', { skip: !program }, () => {
  const d = program.default_start_date;
  assert.ok(d === null || d === undefined || (typeof d === 'string' && mondayOf(d) === d), `default_start_date: ${d}`);
  const tl = buildTimeline(program, { clearances: {} }, { today: '2025-11-22' });
  if (d == null) assert.equal(tl.start, '2025-11-24', 'no start anywhere: the next Monday after today');
});

test('program builds a timeline and every block resolves', { skip: !program }, () => {
  const tl = buildTimeline(program, profile());
  assert.ok(tl.phases.length > 0);
  assert.equal(tl.phases[0].start, tl.start);
  let unknown = [];
  for (const [id, s] of Object.entries(program.sessions)) {
    resolveSession(s).forEach((b, i) => { if (b.kind === 'unknown') unknown.push(`${id}#${i}`); });
  }
  assert.deepEqual(unknown, []);
  const all = buildTimeline(program, profile({ good_arm_ok: '2025-12-02', clinic_light: '2025-12-02', grip_cleared: '2026-01-11', full_clearance: '2026-04-02' }));
  for (const p of all.phases) assert.ok(p.start, `${p.id} gets a start date once every gate is cleared`);
  for (let d = all.start, n = 0; n < 600; d = addDays(d, 1), n++) {
    const plan = plannedOn(program, profile({ good_arm_ok: '2025-12-02', clinic_light: '2025-12-02', grip_cleared: '2026-01-11', full_clearance: '2026-04-02' }), d, all);
    for (const s of plan.sessions) assert.ok(s.isRest || s.session, `${d}: session ${s.sessionId} exists`);
  }
});

test('every exercise the program references is in the library', { skip: !program || !exercises.length }, () => {
  const missing = new Set();
  for (const [sid, s] of Object.entries(program.sessions)) {
    for (const id of sessionExerciseIds(s, program.routines || {})) if (!byId.has(id)) missing.add(`${id} (${sid})`);
  }
  assert.deepEqual([...missing], []);
});

test('no phase schedules an exercise gated above its entry gate', { skip: !program || !exercises.length }, () => {
  const problems = [];
  for (const ph of program.phases) {
    const ids = new Set(Object.values(ph.week_template || {}).flat().filter(Boolean)
      .flatMap((sid) => (program.sessions[sid] ? sessionExerciseIds(program.sessions[sid], program.routines || {}) : [])));
    for (const id of ids) {
      const ex = byId.get(id);
      if (ex && gateRank(ex.gate) > gateRank(ph.entry_gate || 'none')) problems.push(`${ph.id}: ${id} needs ${ex.gate}`);
    }
  }
  assert.deepEqual(problems, []);
});

test('library entries use valid gates and categories', { skip: !exercises.length }, () => {
  const cats = new Set(['squat', 'hinge', 'single-leg', 'knee-ankle', 'calves', 'hip', 'core', 'balance', 'mobility', 'conditioning', 'push', 'pull', 'carry', 'grip', 'power', 'rehab']);
  const bad = exercises.filter((e) => !GATE_ORDER.includes(e.gate) || !cats.has(e.category)).map((e) => e.id);
  assert.deepEqual(bad, []);
  const ids = exercises.map((e) => e.id);
  assert.equal(new Set(ids).size, ids.length, 'ids are unique');
});

test('arm.json has the fixed red flags and required measurements', { skip: !read('arm.json') }, () => {
  const arm = read('arm.json');
  const flags = arm.red_flags.map((f) => f.id);
  for (const id of ['pain_increasing', 'swelling_new', 'redness_heat', 'wound_discharge', 'fever_unwell', 'numbness_tingling', 'colour_cold', 'deformity_give', 'fall_on_arm']) assert.ok(flags.includes(id), id);
  const ms = arm.measurements.map((m) => m.id);
  for (const id of ['pain_rest', 'pain_activity', 'grip_injured_kg', 'grip_good_kg', 'wrist_flex_deg', 'wrist_ext_deg', 'pronation_deg', 'supination_deg']) assert.ok(ms.includes(id), id);
});

test('hike ladder and tests use valid gates', { skip: !read('hikes.json') && !read('tests.json') }, () => {
  for (const l of read('hikes.json')?.ladder || []) assert.ok(GATE_ORDER.includes(l.gate), `ladder ${l.level}`);
  for (const t of read('tests.json') || []) assert.ok(GATE_ORDER.includes(t.gate || 'none'), `test ${t.id}`);
});

test('every written guide chapter renders without raw HTML', { skip: !read('guide/index.json') }, () => {
  const idx = read('guide/index.json');
  for (const c of idx.parts.flatMap((p) => p.chapters)) {
    let src;
    try { src = fs.readFileSync(`${BASE}guide/${c.file}`, 'utf8'); } catch { continue; }
    const { html, title } = renderMarkdown(src, { file: c.file });
    assert.ok(title, `${c.file} has a # title`);
    assert.ok(!/<script|<iframe|<img|javascript:/i.test(html), `${c.file} output is clean`);
  }
});

test('today\'s position is computable', { skip: !program }, () => {
  const tl = buildTimeline(program, profile());
  const p = positionOn(tl, addDays(tl.start, 3));
  assert.ok(p && p.week === 1);
});

// content.js itself over the real files: it must never throw, every file gets a status, and
// the safety-relevant checks hold. Other problems are printed (content may be mid-edit).
test('content.js loads the real content without throwing and reports every file', async () => {
  await withDiskFetch(() => loadContent());
  const labels = content.status.map((s) => s.label);
  for (const l of ['Program', 'Tests', 'Hikes', 'Nutrition', 'Arm recovery', 'Guide index']) assert.ok(labels.includes(l), l);
  assert.ok(labels.some((l) => l.startsWith('Exercises')));
  for (const s of content.status) {
    assert.ok(['ok', 'missing', 'empty', 'invalid', 'error'].includes(s.state), `${s.file}: ${s.state}`);
    assert.ok(Array.isArray(s.problems), `${s.file} has a problems list`);
  }
  if (program) assert.ok(content.program && content.program.phases.length === program.phases.length);
  const problems = contentProblems();
  const summary = content.status.map((s) => `${s.file}=${s.state}${s.problems.length ? `(${s.problems.length})` : ''}`).join(' ');
  console.log(`# content status: ${summary}`);
  for (const p of problems.slice(0, 12)) console.log(`#   ${p.file}: ${p.message}`);
  // Safety: nothing above a phase's gate is scheduled in it, and no exercise has an unknown gate.
  assert.deepEqual(problems.filter((p) => p.safety && /schedules|unknown (entry_)?gate|no gate|does not match|alternate session/.test(p.message)).map((p) => p.message), []);
});

test('content.js keeps every fixed red flag available (from arm.json or the built-in list)', { skip: !read('arm.json') }, async () => {
  await withDiskFetch(() => loadContent());
  const ids = new Set((content.arm?.red_flags || []).map((f) => f.id));
  assert.deepEqual(RED_FLAG_IDS.filter((id) => !ids.has(id)), []);
});

test('content.js loads the dev fixtures as cleanly as before', async () => {
  await withDiskFetch(() => loadContent({ fixtures: true }));
  const bad = content.status.filter((s) => s.state !== 'ok' && s.state !== 'missing');
  assert.deepEqual(bad.map((s) => s.file), []);
  assert.ok(content.exercises.length > 10);
  assert.ok(content.program.phases.length >= 3);
});

// ---------------------------------------------------------------- round 3
const sameJSON = (a, b) => JSON.stringify(a) === JSON.stringify(b);

test('exercises.json equals part-a + part-b (ids, gates and every entry)', { skip: !read('exercises.json') || !read('exercises/part-a.json') }, () => {
  const merged = read('exercises.json');
  const parts = [...(read('exercises/part-a.json') || []), ...(read('exercises/part-b.json') || [])];
  const cmp = compareExerciseSources(merged, parts);
  assert.deepEqual({ onlyMerged: cmp.onlyMerged, onlyParts: cmp.onlyParts, gateDiffs: cmp.gateDiffs }, { onlyMerged: [], onlyParts: [], gateDiffs: [] },
    'exercises.json is out of date: re-merge part-a + part-b');
  const byId = new Map(parts.map((e) => [e.id, e]));
  assert.deepEqual(merged.filter((e) => !sameJSON(e, byId.get(e.id))).map((e) => e.id), [], 'every merged entry is identical to its part');
});

test('round 3 program contracts: week-override fields, alternates and the rehab add-on', { skip: !program }, () => {
  const bad = [];
  for (const ph of program.phases) {
    for (const o of ph.week_overrides || []) {
      const f = overrideBlockFields(o);
      if (o.zone_cap != null && f.zoneCap === null) bad.push(`${ph.id} w${o.week} zone_cap ${o.zone_cap}`);
      if (o.circuit_minutes != null && f.circuitMinutes === null) bad.push(`${ph.id} w${o.week} circuit_minutes ${o.circuit_minutes}`);
      if (o.rounds != null && !(Number.isInteger(o.rounds) && o.rounds >= 1)) bad.push(`${ph.id} w${o.week} rounds ${o.rounds}`);
    }
  }
  assert.deepEqual(bad, []);
  if (program.alternates !== undefined) {
    const alt = alternatesOf(program);
    for (const k of ['short', 'travel']) if (program.alternates[k] != null) assert.ok(alt[k], `alternates.${k} names an existing session`);
    for (const sid of [alt.short, alt.travel].filter(Boolean)) {
      const above = sessionExerciseIds(program.sessions[sid], program.routines || {}).filter((id) => byId.has(id) && gateRank(byId.get(id).gate) > 0);
      assert.deepEqual(above, [], `alternate ${sid} uses only gate-none exercises`);
    }
  }
  for (const a of program.addons || []) {
    if (a.id === 'rehab') assert.equal(program.sessions[a.session]?.type, 'rehab', 'the rehab add-on is recognised (it waits for the physio programme)');
  }
  const prob = validateProgram(program, new Map(exercises.map((e) => [e.id, e])));
  assert.deepEqual(prob.filter((m) => /zone_cap|circuit_minutes|rounds should|alternates?/.test(m)), []);
});

test('hikes.json weekend_plan entries have a valid week and a ladder level', { skip: !read('hikes.json')?.weekend_plan }, () => {
  const h = read('hikes.json');
  const levels = new Set((h.ladder || []).map((l) => l.level));
  // Round 4: an entry may give program_week (1–8, relative to the programme start) instead of week_start.
  const weekOk = (e) => (e.program_week != null ? Number.isInteger(e.program_week) && e.program_week >= 1 : /^\d{4}-\d{2}-\d{2}$/.test(e.week_start || ''));
  const bad = h.weekend_plan.filter((e) => !weekOk(e) || (e.level != null && !levels.has(e.level))).map((e) => `${e.program_week ?? e.week_start}: ${e.name}`);
  assert.deepEqual(bad, []);
});

// ---------------------------------------------------------------- round 4
import { testsDueOn, testStatusOn, allowedForPhase, whyNotAllowed, prescriptionFor } from '../public/js/content.js';
import { weekendPlanOn, weekendPlanList } from '../public/js/stats.js';
import { armLogPainOn, weightVerdict } from '../public/js/calc.js';
import { mondayOf } from '../public/js/dates.js';

const tests = read('tests.json') || [];
const hasScheduling = tests.some((t) => t && ('first_phase' in t || 'first_week' in t || 'baseline_day' in t));
const FAST = { start: '2026-01-12', end: '2026-01-16', label: 'Planned fast' };
const ALL_CLEAR = { good_arm_ok: '2025-12-02', clinic_light: '2025-12-02', grip_cleared: '2026-01-11', full_clearance: '2026-04-02' };

test('tests.json scheduling fields are well formed (first_phase is a phase, first_week ≥ 1, baseline_day 1–3)', { skip: !program || !tests.length }, () => {
  const phases = new Set(program.phases.map((p) => p.id));
  const bad = [];
  for (const t of tests) {
    if (t.first_phase != null && !phases.has(t.first_phase)) bad.push(`${t.id}: first_phase ${t.first_phase}`);
    if (t.first_week != null && !(Number.isInteger(t.first_week) && t.first_week >= 1)) bad.push(`${t.id}: first_week ${t.first_week}`);
    if (t.baseline_day != null && !(Number.isInteger(t.baseline_day) && t.baseline_day >= 1 && t.baseline_day <= 3)) bad.push(`${t.id}: baseline_day ${t.baseline_day}`);
  }
  assert.deepEqual(bad, []);
});

test('tests.json round 4 schedule: dead hang and farmer’s carry from p4a week 4; the baselines spread over Mon–Wed', { skip: (!program || !hasScheduling) && 'tests.json has no scheduling fields yet' }, () => {
  for (const id of tests.filter((t) => /dead-hang|farmer/.test(t.id)).map((t) => t.id)) {
    const t = tests.find((x) => x.id === id);
    assert.deepEqual([t.first_phase, t.first_week], ['p4a', 4], id);
  }
  const baselines = tests.filter((t) => (t.gate || 'none') === 'none');
  assert.deepEqual(baselines.filter((t) => t.baseline_day == null).map((t) => t.id), [], 'every gate-none baseline has its day');
  const prof = profile(ALL_CLEAR);
  const tl = buildTimeline(program, prof);
  const data = { profile: prof, tests: [] };
  const due = (date) => testsDueOn(data, date, tests, { program, timeline: tl }).map((s) => s.id);
  const mon = tl.start;
  assert.deepEqual(due(addDays(mon, -1)), [], 'nothing before the programme starts');
  for (let d = 0; d < 3; d++) {
    assert.deepEqual(due(addDays(mon, d)).sort(), baselines.filter((t) => t.baseline_day <= d + 1).map((t) => t.id).sort(), `day ${d + 1}`);
  }
  const p4a = tl.phases.find((p) => p.id === 'p4a');
  if (p4a?.start) {
    for (const t of tests.filter((x) => x.first_phase === 'p4a')) {
      assert.equal(testStatusOn(data, addDays(p4a.start, 20), t, { program, timeline: tl }).state, 'scheduled', `${t.id} not before p4a week 4`);
      assert.equal(testStatusOn(data, addDays(p4a.start, 21), t, { program, timeline: tl }).state, 'due', `${t.id} from p4a week 4`);
    }
  }
});

test('testsDueOn over the real programme: nothing during a fasting period, never above the gate', { skip: !program || !tests.length }, () => {
  const prof = profile({ ...ALL_CLEAR });
  prof.fasting_periods = [FAST];
  const tl = buildTimeline(program, prof);
  const data = { profile: prof, tests: [] };
  for (let d = FAST.start; d <= FAST.end; d = addDays(d, 1)) assert.deepEqual(testsDueOn(data, d, tests, { program, timeline: tl }), [], d);
  const none = { profile: profile(), tests: [] };
  for (let d = TEST_START, n = 0; n < 120; d = addDays(d, 1), n++) {
    for (const s of testsDueOn(none, d, tests, { program })) assert.equal(s.test.gate || 'none', 'none', `${d}: ${s.id} is gated`);
  }
});

test('allowedForPhase over the real programme: swaps never go above the current phase (no rower in Phase 1, even with grip cleared)', { skip: !program || !exercises.length }, () => {
  const lib = new Map(exercises.map((e) => [e.id, e]));
  const prof = profile(ALL_CLEAR);
  prof.unavailable_exercises = [];
  const tl = buildTimeline(program, prof);
  const data = { profile: prof };
  for (const ph of tl.phases.filter((p) => p.start)) {
    const day = addDays(ph.start, 2);
    const pos = positionOn(tl, day);
    if (!pos) continue;
    const ceiling = gateRank(pos.item.entryGate);
    const above = exercises.filter((e) => allowedForPhase(e.id, day, data, { program, exById: lib }) && gateRank(e.gate) > ceiling).map((e) => e.id);
    assert.deepEqual(above, [], `${ph.id}: nothing above ${pos.item.entryGate}`);
  }
  // BT2-3: grip cleared early (before Phase 1's minimum weeks are up): still Phase 1, so no rower or ski erg.
  const early = profile({ good_arm_ok: '2025-12-02', clinic_light: '2025-12-02', grip_cleared: '2025-12-03' });
  early.unavailable_exercises = [];
  const etl = buildTimeline(program, early);
  const i1 = etl.phases.findIndex((p) => p.id === 'p1');
  const next = i1 >= 0 ? etl.phases[i1 + 1] : null;
  if (i1 >= 0 && next?.start && lib.has('rower')) {
    const inP1 = addDays(next.start, -2);
    assert.equal(positionOn(etl, inP1)?.phaseId, 'p1');
    assert.equal(whyNotAllowed('rower', inP1, { profile: early }, { program, exById: lib }), 'phase', 'grip is cleared, but Phase 1 opens at gate none');
    if (lib.has('ski-erg')) assert.equal(allowedForPhase('ski-erg', inP1, { profile: early }, { program, exById: lib }), false);
    assert.equal(allowedForPhase('rower', addDays(next.start, 1), { profile: early }, { program, exById: lib }), gateRank(lib.get('rower').gate) <= gateRank(next.entryGate));
  }
  assert.equal(allowedForPhase('leg-press', TEST_START, { profile: profile() }, { program, exById: lib }), true);
});

test('prescriptionFor reads every library dose (never throws; rehab is physio; a known type each)', { skip: !exercises.length }, () => {
  const lib = new Map(exercises.map((e) => [e.id, e]));
  const types = new Set(['loaded', 'reps', 'timed', 'cardio', 'physio', 'other']);
  const counts = {};
  for (const e of exercises) {
    const p = prescriptionFor(e.id, { exById: lib });
    assert.ok(p && types.has(p.type), e.id);
    counts[p.type] = (counts[p.type] || 0) + 1;
    if (e.category === 'rehab') assert.equal(p.type, 'physio', e.id);
    if (p.type === 'loaded' || p.type === 'reps') assert.ok(p.sets >= 1 && p.reps, `${e.id}: ${e.dose}`);
    if (p.type === 'timed') assert.ok(p.sets >= 1 && p.seconds > 0, `${e.id}: ${e.dose}`);
  }
  console.log(`# prescriptions: ${JSON.stringify(counts)}`);
  const other = exercises.filter((e) => prescriptionFor(e.id, { exById: lib }).type === 'other').map((e) => e.id);
  if (other.length) console.log(`#   dose text shown as written: ${other.join(', ')}`);
});

test('weekend_plan over the real hikes.json: one entry per programme week, whatever the start date', { skip: !read('hikes.json')?.weekend_plan }, () => {
  const h = read('hikes.json');
  const start = mondayOf(TEST_START);
  const list = weekendPlanList(h, { start });
  assert.ok(list.length > 0);
  const weeks = list.map((e) => e.week_start);
  assert.equal(new Set(weeks).size, weeks.length, 'no two entries for one week');
  if (h.weekend_plan.some((e) => e.program_week != null)) {
    const later = addDays(start, 14);
    for (const e of h.weekend_plan.filter((x) => x.program_week != null)) {
      assert.equal(weekendPlanOn(h, addDays(later, (e.program_week - 1) * 7 + 5), { start: later }).name, e.name, `week ${e.program_week} follows a later start`);
    }
  }
});

test('the real arm.json pain scores are read by readiness (arm-log pain of 7+ is RED)', { skip: !read('arm.json') }, () => {
  const ids = read('arm.json').measurements.map((m) => m.id).filter((id) => /^pain/.test(id));
  assert.ok(ids.includes('pain_rest') && ids.includes('pain_activity'));
  for (const id of ids) assert.equal(armLogPainOn({ arm: { logs: [{ date: '2025-12-03', values: { [id]: 7 } }] } }, '2025-12-03').field, id);
  assert.equal(weightVerdict({ profile: profile(), checkins: [] }, '2025-12-02').status, 'waiting');
});
