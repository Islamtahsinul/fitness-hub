// Shared formulas (SPEC sections 5.8 and 5.9). Pure functions only.

import { addDays, daysBetween, fmtDay, isISODate, mondayOf, mondayOnOrAfter, monthIndex } from './dates.js';

export const isNum = (v) => v !== null && v !== undefined && v !== '' && typeof v !== 'boolean' && Number.isFinite(Number(v));
export const num = (v) => (isNum(v) ? Number(v) : null);

export function mean(values) {
  const v = values.filter(isNum).map(Number);
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
}

export function round(v, dp = 0) {
  if (!isNum(v)) return null;
  const f = 10 ** dp;
  return Math.round(Number(v) * f) / f;
}

// ------------------------------------------------------------ heart rate

export function ageFrom(birthYear, todayISO) {
  const y = num(birthYear);
  if (!y || !isISODate(todayISO)) return null;
  const a = Number(todayISO.slice(0, 4)) - Math.floor(y);
  return a >= 14 && a <= 100 ? a : null;
}

/** Tanaka: 208 - 0.7 x age, unless a plausible override is set. */
export function hrMax(age, override = null) {
  const o = num(override);
  if (o && o >= 100 && o <= 230) return Math.round(o);
  if (!isNum(age)) return null;
  return Math.round(208 - 0.7 * Number(age));
}

export const ZONES = [
  { id: 'Z1', lo: 50, hi: 60, name: 'Recovery' },
  { id: 'Z2', lo: 60, hi: 70, name: 'Endurance (Zone 2)' },
  { id: 'Z3', lo: 70, hi: 80, name: 'Tempo' },
  { id: 'Z4', lo: 80, hi: 90, name: 'Threshold' },
  { id: 'Z5', lo: 90, hi: 100, name: 'VO2max' },
];

export function hrZones(hrmax) {
  if (!isNum(hrmax)) return [];
  return ZONES.map((z) => ({ ...z, loBpm: Math.round((hrmax * z.lo) / 100), hiBpm: Math.round((hrmax * z.hi) / 100) }));
}

/** bpm range for a zone label such as "Z2" or "Z2-Z3"; null if unknown. */
export function zoneRange(label, hrmax) {
  if (!isNum(hrmax) || typeof label !== 'string') return null;
  const ids = (label.toUpperCase().match(/Z[1-5]/g) || []);
  if (!ids.length) return null;
  const zs = hrZones(hrmax).filter((z) => ids.includes(z.id));
  return { lo: Math.min(...zs.map((z) => z.loBpm)), hi: Math.max(...zs.map((z) => z.hiBpm)) };
}

/** MAF cross-check: 180 - age. */
export function mafHr(age) {
  return isNum(age) ? 180 - Number(age) : null;
}

// ------------------------------------------------------------ energy

/** Mifflin-St Jeor. sex: 'male' | 'female'. Returns kcal/day or null if anything is missing. */
export function bmrMifflin({ sex, weightKg, heightCm, age }) {
  const w = num(weightKg), h = num(heightCm), a = num(age);
  if (!w || !h || !a || w <= 0 || h <= 0 || a <= 0) return null;
  const base = 10 * w + 6.25 * h - 5 * a;
  const s = typeof sex === 'string' ? sex.trim().toLowerCase() : sex;
  if (s === 'male') return base + 5;
  if (s === 'female') return base - 161;
  return null;
}

export const ACTIVITY_DEFAULT = 1.55;
export const ACTIVITY_MIN = 1.375;
export const ACTIVITY_MAX = 1.725;

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/** BMR x activity factor. The factor is clamped to the SPEC range 1.375-1.725 (default 1.55). */
export function tdee(bmr, activityFactor = ACTIVITY_DEFAULT) {
  if (!isNum(bmr)) return null;
  const f = isNum(activityFactor) && Number(activityFactor) > 1 ? clamp(Number(activityFactor), ACTIVITY_MIN, ACTIVITY_MAX) : ACTIVITY_DEFAULT;
  return Number(bmr) * f;
}

export const SURPLUS_DEFAULT = 300;
export const SURPLUS_MAX = 1000;

/**
 * TDEE + surplus. SPEC section 2 rule 6 (no dieting while the bone heals): a negative surplus
 * is treated as 0, so the hub never suggests a deficit.
 */
export function targetKcal(tdeeValue, surplus = SURPLUS_DEFAULT) {
  if (!isNum(tdeeValue)) return null;
  const s = isNum(surplus) ? clamp(Number(surplus), 0, SURPLUS_MAX) : SURPLUS_DEFAULT;
  return Number(tdeeValue) + s;
}

export const PROTEIN_MIN = 1.6;
export const PROTEIN_MAX = 2.2;
export const PROTEIN_DEFAULT = 1.8;

/** Protein band for a body weight. perKg is clamped to 1.6-2.2 g/kg (SPEC 5.9). */
export function proteinTargets(weightKg, perKg = PROTEIN_DEFAULT) {
  const w = num(weightKg);
  if (!w || w <= 0) return null;
  const p = isNum(perKg) ? clamp(Number(perKg), PROTEIN_MIN, PROTEIN_MAX) : PROTEIN_DEFAULT;
  return { low: PROTEIN_MIN * w, high: PROTEIN_MAX * w, target: p * w, perKg: p };
}

export const CALCIUM_MG = 700;
export const VITAMIN_D_UG = 10;
export const CREATINE_G = '3–5';
export const STEPS_GOAL = [8000, 10000];
export const GAIN_BAND = [0.2, 0.4]; // kg per week, the band when no pre-injury weight is set (GAIN_BANDS.default)

/** UK advice: 10 micrograms of vitamin D a day from October to March. */
export function vitaminDSeason(dateISO) {
  const m = monthIndex(dateISO);
  return m >= 9 || m <= 2;
}

// ------------------------------------------------------------ strength

/** Epley estimated 1RM: kg x (1 + reps/30). Charts only; there is no 1RM testing. */
export function e1rm(kg, reps) {
  const k = num(kg), r = num(reps);
  if (!k || !r || k <= 0 || r <= 0) return null;
  return k * (1 + r / 30);
}


// ------------------------------------------------------------ averages

/** Mean of values dated in [dateISO - days + 1, dateISO]. points: [{date, value}] */
export function trailingMean(points, dateISO, days = 7) {
  const from = addDays(dateISO, -(days - 1));
  return mean(points.filter((p) => p && p.date >= from && p.date <= dateISO).map((p) => p.value));
}

/**
 * One point per input point: the trailing mean over the calendar window [date - days + 1, date].
 * Gaps simply mean fewer readings in the window. O(n log n) (sort) + O(n) sliding window.
 * Round 3 (QA6): `{to}` ignores points dated after `to` (pass today, so a future-dated entry can
 * never move today's average) and `{from}` drops output points before `from`.
 */
export function rollingMean(points, days = 7, { from = null, to = null } = {}) {
  const sorted = (Array.isArray(points) ? points : [])
    .filter((p) => p && isISODate(p.date) && isNum(p.value) && (!to || p.date <= to))
    .map((p) => ({ date: p.date, value: Number(p.value) }))
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  const out = new Array(sorted.length);
  let lo = 0;
  let sum = 0;
  let i = 0;
  while (i < sorted.length) {
    // Points sharing a date all get the same window (every reading on that date included).
    let j = i;
    while (j < sorted.length && sorted[j].date === sorted[i].date) { sum += sorted[j].value; j++; }
    const start = addDays(sorted[i].date, -(days - 1));
    while (sorted[lo].date < start) { sum -= sorted[lo].value; lo++; }
    const value = sum / (j - lo);
    for (let k = i; k < j; k++) out[k] = { date: sorted[k].date, value };
    i = j;
  }
  return from ? out.filter((p) => p.date >= from) : out;
}

/** Change of the 7-day average over the last week, in units per week; null if not enough data. */
export function weeklyChange(points, dateISO) {
  const sorted = points.filter((p) => isISODate(p.date) && isNum(p.value));
  const now = trailingMean(sorted, dateISO, 7);
  const before = trailingMean(sorted, addDays(dateISO, -7), 7);
  if (now === null || before === null) return null;
  return now - before;
}

/** Mean of the values dated in [from, to] (inclusive), or null. Never looks past `to`. */
export function meanBetween(points, from, to) {
  return mean((Array.isArray(points) ? points : []).filter((p) => p && isISODate(p.date) && (!from || p.date >= from) && (!to || p.date <= to)).map((p) => p.value));
}

/**
 * Everything Today needs for one trend, bounded by `today` (QA6: entries dated after today are
 * ignored): {points, rolling, mean7, weeklyChange, latest}. `span` limits `rolling` to the last
 * `span` days. points: [{date, value}] in any order.
 */
export function trendUntil(points, today, { days = 7, span = 28 } = {}) {
  const pts = (Array.isArray(points) ? points : []).filter((p) => p && isISODate(p.date) && isNum(p.value) && p.date <= today)
    .map((p) => ({ date: p.date, value: Number(p.value) }))
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  const from = span ? addDays(today, -(span - 1)) : null;
  return {
    points: from ? pts.filter((p) => p.date >= from) : pts,
    rolling: rollingMean(pts, days, { from, to: today }),
    mean7: trailingMean(pts, today, days),
    weeklyChange: weeklyChange(pts, today),
    latest: pts.length ? pts[pts.length - 1] : null,
  };
}

// ------------------------------------------------------------ readiness (SPEC 5.8, revised in round 3)

export const READINESS_TEXT = {
  red: 'Stop. No training today, including your physio exercises, until you’ve been advised. Contact your fracture clinic today, or NHS 111 / 999 as the red-flag guidance says.',
  amber: 'Easy day: halve the sets, Zone 2 only, no intervals, hold loads.',
  green: 'Good to train as planned.',
  unknown: 'Check in to see today’s readiness.',
};

/** Messages the UI must show with a result (they are also put in `messages[]`). */
export const READINESS_MESSAGES = {
  red: READINESS_TEXT.red,
  risingPain: 'Rising arm pain can be the red flag “pain getting worse”. If it keeps rising, or you’re unsure, call your fracture clinic today.',
  fasting: 'Fasting: if you can, train after you break your fast. Stop at any dizziness or light-headedness. No new lifts this period.',
};

/** The SPEC 5.8 thresholds in one place. */
export const READINESS_RULES = Object.freeze({
  redPain: 7, // arm pain >= 7/10: red
  amberPain: 4, // arm pain >= 4/10: amber
  risingDelta: 2, // arm pain >= 7-day average + 2: amber (needs risingMinReadings earlier readings)
  risingMinReadings: 3,
  rhrDelta: 5, // resting HR >= 7-day average + 5: amber
  rhrMinReadings: 3, // readings needed in the 7-day window for an average
  rhrMinSinceChange: 5, // readings needed since the latest rhr_method_changes date
  sleepMin: 6, // sleep under 6 h: amber
  sorenessMax: 7, // soreness >= 7/10: amber
  energyMin: 2, // energy <= 2/5: amber
});

/**
 * Red-flag ids ticked on a check-in. A bare string (hand-edited or imported data) counts as
 * one flag rather than being ignored, so a malformed file can never hide a red flag.
 */
export function armFlagsOf(checkin) {
  const raw = checkin?.arm_flags;
  if (Array.isArray(raw)) return raw.filter((f) => typeof f === 'string' && f.trim()).map((f) => f.trim());
  if (typeof raw === 'string' && raw.trim()) return [raw.trim()];
  return [];
}

const READINESS_FIELDS = ['rhr', 'sleep_h', 'arm_pain', 'soreness', 'energy'];
/** The morning answers: a check-in with none of these (and no red flag), say only a weight, is not a check-in. */
export const CHECKIN_ANSWER_FIELDS = ['rhr', 'hrv', 'sleep_h', 'sleep_q', 'energy', 'soreness', 'mood', 'stress', 'arm_pain'];

/** SPEC 5.8: a check-in counts only if it includes more than a weight (an answer or a red flag). */
export function countsAsCheckin(checkin) {
  if (!checkin || typeof checkin !== 'object') return false;
  return armFlagsOf(checkin).length > 0 || CHECKIN_ANSWER_FIELDS.some((k) => isNum(checkin[k]));
}
const EPS = 1e-9; // float noise in averages must not flip a boundary (">= average + 5")
const fmt1 = (v) => String(Math.round(Number(v) * 10) / 10);
/** These helpers take the profile or the whole user data. */
const profileOf = (x) => (x && typeof x === 'object' && x.profile && typeof x.profile === 'object' && !Array.isArray(x.profile) ? x.profile : x);
const isPlainObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
/** The user data from data itself or a view ctx ({data}). */
const dataOf = (x) => (x && typeof x === 'object' && !Array.isArray(x.checkins) && !isPlainObj(x.arm) && isPlainObj(x.data) ? x.data : x);

// ------------------------------------------------------------ the arm log in readiness (SPEC 5.2 round 4)

/** Arm-log measurements read as pain (0–10): every arm.json id starting "pain" (pain_rest, pain_activity, pain_night…). */
export const ARM_LOG_PAIN = /^pain/;
const PAIN_LABELS = { pain_rest: 'pain at rest', pain_activity: 'pain with activity', pain_night: 'night pain' };

/**
 * The worst same-day arm-log pain: {value, field, label, date}, or null. SPEC 5.2 round 4: a
 * pain_rest or pain_activity value of 7 or more is RED, exactly like the check-in's arm pain; the
 * hub reads every "pain…" score in arm.json the same way (fail safe), so night pain counts too.
 * Several logs on one date (a merge can leave them) count together: the highest wins.
 */
export function armLogPainOn(data, dateISO) {
  const d = dataOf(data);
  const logs = Array.isArray(d?.arm?.logs) ? d.arm.logs : [];
  let best = null;
  for (const l of logs) {
    if (!l || typeof l !== 'object' || l.date !== dateISO || !isPlainObj(l.values)) continue;
    for (const [k, v] of Object.entries(l.values)) {
      if (!ARM_LOG_PAIN.test(k) || !isNum(v)) continue;
      const n = Number(v);
      if (!best || n > best.value) best = { value: n, field: k, label: PAIN_LABELS[k] || k.replace(/_/g, ' '), date: dateISO };
    }
  }
  return best;
}

/** Every arm-log date's worst pain: Map(date -> {value, field, label, date}). O(n). */
function armLogPains(logs) {
  const out = new Map();
  for (const l of Array.isArray(logs) ? logs : []) {
    if (!l || typeof l !== 'object' || !isISODate(l.date) || !isPlainObj(l.values)) continue;
    for (const [k, v] of Object.entries(l.values)) {
      if (!ARM_LOG_PAIN.test(k) || !isNum(v)) continue;
      const cur = out.get(l.date);
      if (!cur || Number(v) > cur.value) out.set(l.date, { value: Number(v), field: k, label: PAIN_LABELS[k] || k.replace(/_/g, ' '), date: l.date });
    }
  }
  return out;
}

/**
 * The dates that are RED (SPEC 5.8 and round 4): any check-in on the date with a red flag ticked
 * or arm pain 7/10 or more, or an arm-log pain score of 7 or more. RED needs only that day's
 * entries, so this is the same answer as readinessOn(...).level === 'red', in one O(n) pass.
 */
export function redDays(data) {
  const d = dataOf(data);
  const out = new Set();
  for (const c of Array.isArray(d?.checkins) ? d.checkins : []) {
    if (c && typeof c === 'object' && isISODate(c.date) && (armFlagsOf(c).length || (isNum(c.arm_pain) && Number(c.arm_pain) >= READINESS_RULES.redPain))) out.add(c.date);
  }
  for (const [date, p] of armLogPains(d?.arm?.logs)) if (p.value >= READINESS_RULES.redPain) out.add(date);
  return out;
}

/**
 * profile.fasting_periods, cleaned: [{start, end, label, approximate}] (inclusive dates, end >=
 * start; a missing end means a single day), sorted by start. `approximate` defaults to true
 * (dates that follow the moon, such as Ramadan's, shift by a day or so); `approx` is read as an older spelling.
 */
export function fastingPeriods(profile) {
  const p = profileOf(profile);
  const raw = Array.isArray(p?.fasting_periods) ? p.fasting_periods : [];
  return raw.filter((p) => p && typeof p === 'object' && isISODate(p.start) && isISODate(p.end || p.start) && (p.end || p.start) >= p.start)
    .map((p) => ({
      start: p.start, end: p.end || p.start, label: typeof p.label === 'string' ? p.label : '',
      approximate: typeof p.approximate === 'boolean' ? p.approximate : typeof p.approx === 'boolean' ? p.approx : true,
    }))
    .sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0));
}

/** The fasting period that covers dateISO (inclusive), or null. */
export function fastingOn(profile, dateISO) {
  if (!isISODate(dateISO)) return null;
  return fastingPeriods(profile).find((p) => p.start <= dateISO && dateISO <= p.end) || null;
}

/** profile.rhr_method_changes as sorted unique dates. Entries may be "YYYY-MM-DD" or {date}. */
export function rhrMethodChanges(profile) {
  const p = profileOf(profile);
  const raw = Array.isArray(p?.rhr_method_changes) ? p.rhr_method_changes : [];
  const out = new Set();
  for (const x of raw) {
    const d = typeof x === 'string' ? x.trim() : x && typeof x === 'object' && typeof x.date === 'string' ? x.date.trim() : null;
    if (isISODate(d)) out.add(d);
  }
  return [...out].sort();
}

/** The latest resting-HR method change on or before dateISO, or null. */
export function rhrMethodChangeOn(profile, dateISO) {
  let best = null;
  for (const d of rhrMethodChanges(profile)) if (d <= dateISO) best = d;
  return best;
}

const rhrRefOf = (value, source, count, extra = {}) => ({ value, source, count, threshold: Math.ceil(value + READINESS_RULES.rhrDelta - EPS), ...extra });

/**
 * Resting-HR reference for dateISO: the mean of the readings in the 7 days before it (needs 3+),
 * else the baseline. Round 3: when `profile.rhr_method_changes` has a date on or before dateISO
 * (pass {profile} or {changeDate}), only readings since that change count, the rule needs 5+ of
 * them, and the old baseline is not used, so switching from a band to a manual pulse never
 * causes false amber days. `threshold` is the whole-number bpm from which the day is amber.
 */
export function rhrReference(checkins, dateISO, baseline = null, { profile = null, changeDate } = {}) {
  const change = changeDate !== undefined ? changeDate : profile ? rhrMethodChangeOn(profile, dateISO) : null;
  const list = Array.isArray(checkins) ? checkins : [];
  const from = addDays(dateISO, -7);
  const lower = change && change > from ? change : from;
  const vals = [];
  let since = 0;
  for (const c of list) {
    if (!c || !isISODate(c.date) || c.date >= dateISO || !isNum(c.rhr)) continue;
    if (change && c.date >= change) since++;
    if (c.date >= lower) vals.push(Number(c.rhr));
  }
  if (change) {
    if (since < READINESS_RULES.rhrMinSinceChange || vals.length < READINESS_RULES.rhrMinReadings) return null;
    return rhrRefOf(mean(vals), 'average', vals.length, { since: change });
  }
  if (vals.length >= READINESS_RULES.rhrMinReadings) return rhrRefOf(mean(vals), 'average', vals.length);
  if (isNum(baseline)) return rhrRefOf(Number(baseline), 'baseline', vals.length);
  return null;
}

/** Arm-pain reference: mean of the readings in the 7 days before dateISO (needs 3+), or null. */
export function painReference(checkins, dateISO) {
  const from = addDays(dateISO, -7);
  const vals = (Array.isArray(checkins) ? checkins : [])
    .filter((c) => c && isISODate(c.date) && c.date >= from && c.date < dateISO && isNum(c.arm_pain))
    .map((c) => Number(c.arm_pain));
  return vals.length >= READINESS_RULES.risingMinReadings ? { value: mean(vals), count: vals.length } : null;
}

function rhrRebaselineInfo(checkins, dateISO, change) {
  if (!change) return null;
  let n = 0;
  for (const c of Array.isArray(checkins) ? checkins : []) if (c && isISODate(c.date) && c.date >= change && c.date < dateISO && isNum(c.rhr)) n++;
  return { since: change, readings: n, needed: READINESS_RULES.rhrMinSinceChange, active: n < READINESS_RULES.rhrMinSinceChange };
}

/**
 * Several check-ins on one date (a merge can leave duplicates): readiness uses the worst of each
 * answer and every red flag from all of them (fail safe). One check-in is returned unchanged.
 */
export function combineCheckins(list) {
  const cks = (Array.isArray(list) ? list : []).filter((c) => c && typeof c === 'object');
  if (cks.length <= 1) return cks[0] || null;
  const out = { ...cks[0] };
  const pick = (k, worse) => {
    const vals = cks.map((c) => c[k]).filter(isNum).map(Number);
    if (vals.length) out[k] = vals.reduce((a, b) => (worse(b, a) ? b : a));
  };
  pick('arm_pain', (a, b) => a > b);
  pick('soreness', (a, b) => a > b);
  pick('rhr', (a, b) => a > b);
  pick('sleep_h', (a, b) => a < b);
  pick('energy', (a, b) => a < b);
  out.arm_flags = [...new Set(cks.flatMap(armFlagsOf))];
  return out;
}

function result(level, extra) {
  return {
    level,
    reasons: [],
    messages: [],
    flags: [],
    rhrRef: null,
    painRef: null,
    inputs: 0,
    checkedIn: false,
    fasting: null,
    risingPain: false,
    rhrRebaseline: null,
    rhrBlocked: null,
    easyDay: level === 'amber',
    stop: level === 'red',
    holdLoads: level === 'amber' || level === 'red',
    advice: READINESS_TEXT[level],
    ...extra,
  };
}

/**
 * SPEC 5.8 (revised in round 3). Returns {level, reasons[], messages[], ...}:
 * - RED: any arm red flag ticked, or arm pain 7/10 or more. messages = [the stop text].
 * - AMBER (easy day: halve the sets, Zone 2 only, no intervals, hold loads) if any of: resting HR
 *   >= 7-day average + 5 (only with 5+ readings since the latest profile.rhr_method_changes date);
 *   sleep under 6 h; arm pain >= 4/10; arm pain >= its 7-day average + 2 with 3+ earlier readings
 *   (adds the rising-pain message); soreness >= 7/10; energy <= 2/5; the date is inside
 *   profile.fasting_periods (adds the fasting message; applies even without a check-in).
 * - GREEN otherwise, but only for a check-in that counts (countsAsCheckin: an answer or a red
 *   flag): a weight-only (or empty) check-in is "unknown", never green.
 * Extras: flags, rhrRef ({value, source, count, threshold}), painRef, inputs, checkedIn,
 * fasting (the period or null), risingPain, rhrRebaseline ({since, readings, needed, active}),
 * rhrBlocked ({since, count} while the RHR rule waits for 5 readings, else null), easyDay,
 * stop, holdLoads, advice, armLog.
 * Pass {rhrRef, painRef, fasting, rhrRebaseline} to reuse precomputed values (readinessHistory).
 * Round 4 (BT2-6): pass {armLog} (armLogPainOn() for that date, or a number): a same-day arm-log
 * pain of 7 or more is RED, exactly like the check-in's arm pain. readinessOn does this for you.
 */
export function readiness(checkin, checkins = [], profile = {}, opts = {}) {
  if (!checkin || typeof checkin !== 'object') return result('unknown', {});
  const R = READINESS_RULES;
  const date = isISODate(checkin.date) ? checkin.date : null;
  const flags = armFlagsOf(checkin);
  const inputs = READINESS_FIELDS.filter((k) => isNum(checkin[k])).length + (flags.length ? 1 : 0);
  const change = date ? rhrMethodChangeOn(profile, date) : null;
  const ref = opts.rhrRef !== undefined ? opts.rhrRef : date ? rhrReference(checkins, date, profile?.rhr_baseline, { changeDate: change }) : null;
  const pRef = opts.painRef !== undefined ? opts.painRef : date ? painReference(checkins, date) : null;
  const fast = opts.fasting !== undefined ? opts.fasting : date ? fastingOn(profile, date) : null;
  const rebase = opts.rhrRebaseline !== undefined ? opts.rhrRebaseline : date ? rhrRebaselineInfo(checkins, date, change) : null;
  const armLog = isNum(opts.armLog) ? { value: Number(opts.armLog), field: 'pain', label: 'pain', date } : isPlainObj(opts.armLog) && isNum(opts.armLog.value) ? opts.armLog : null;
  const checkedIn = countsAsCheckin(checkin);
  const blocked = rebase && rebase.active ? { since: rebase.since, count: rebase.readings } : null;
  const base = { flags, rhrRef: ref, painRef: pRef, inputs, checkedIn, fasting: fast, rhrRebaseline: rebase, rhrBlocked: blocked, armLog };
  const pain = num(checkin.arm_pain);

  const red = [];
  if (flags.length) red.push(`${flags.length} arm red flag${flags.length > 1 ? 's' : ''} ticked`);
  if (pain !== null && pain >= R.redPain) red.push(`Arm pain ${fmt1(pain)}/10 (${R.redPain} or more)`);
  if (armLog && Number(armLog.value) >= R.redPain) red.push(`Arm log: ${armLog.label || 'pain'} ${fmt1(armLog.value)}/10 (${R.redPain} or more)`);
  if (red.length) return result('red', { ...base, reasons: red, messages: [READINESS_MESSAGES.red] });

  const reasons = [];
  const messages = [];
  let rising = false;
  if (isNum(checkin.rhr) && ref && Number(checkin.rhr) >= ref.value + R.rhrDelta - EPS) {
    reasons.push(`Resting HR ${Math.round(checkin.rhr)} is ${Math.round(Number(checkin.rhr) - ref.value)} bpm above your ${ref.source === 'average' ? '7-day average' : 'baseline'} (${Math.round(ref.value)})`);
  }
  if (isNum(checkin.sleep_h) && Number(checkin.sleep_h) < R.sleepMin) reasons.push(`Under 6 hours of sleep (${checkin.sleep_h} h)`);
  if (pain !== null && pain >= R.amberPain) reasons.push(`Arm pain ${fmt1(pain)}/10`);
  if (pain !== null && pRef && pain >= pRef.value + R.risingDelta - EPS) {
    rising = true;
    reasons.push(`Arm pain ${fmt1(pain)}/10 is ${fmt1(pain - pRef.value)} above your 7-day average (${fmt1(pRef.value)})`);
    messages.push(READINESS_MESSAGES.risingPain);
  }
  if (isNum(checkin.soreness) && Number(checkin.soreness) >= R.sorenessMax) reasons.push(`Soreness ${checkin.soreness}/10`);
  if (isNum(checkin.energy) && Number(checkin.energy) <= R.energyMin) reasons.push(`Energy ${checkin.energy}/5`);
  if (fast) {
    reasons.push(`Fasting period${fast.label ? ` (${fast.label})` : ''}`);
    messages.push(READINESS_MESSAGES.fasting);
  }
  const level = reasons.length ? 'amber' : checkedIn ? 'green' : 'unknown';
  return result(level, { ...base, reasons, messages, risingPain: rising });
}

/**
 * Readiness for a day, the single source of truth for every page and coach note (SPEC 5.8):
 * the check-in of that date (several are combined, worst answer wins), the 7-day references and
 * the fasting overlay. A day without a check-in is "unknown", or amber inside a fasting period.
 * Also accepts a view ctx ({data}) in place of data. Adds `date` and `checkin` (the record or null).
 * Round 4 (BT2-6): the same day's arm log counts too: a pain score of 7 or more is RED, even
 * without a check-in (`armLog` says which reading).
 */
export function readinessOn(data, dateISO) {
  const d = data && !Array.isArray(data.checkins) && data.data && typeof data.data === 'object' ? data.data : data;
  const list = Array.isArray(d?.checkins) ? d.checkins : [];
  const profile = d?.profile && typeof d.profile === 'object' ? d.profile : {};
  const same = list.filter((c) => c && typeof c === 'object' && c.date === dateISO);
  const ck = same.length > 1 ? combineCheckins(same) : same[0] || { date: dateISO };
  return { ...readiness(ck, list, profile, { armLog: armLogPainOn(d, dateISO) }), date: dateISO, checkin: same[0] || null };
}

/**
 * Readiness for every dated check-in at once: Map(date -> readiness result). Same rules as
 * readiness() (several check-ins on one date are combined, as in readinessOn), but every 7-day
 * reference is a sliding window, so a two-year history costs O(n log n) instead of O(n^2).
 * Round 4: pass {armLogs} (data.arm.logs), or call readinessHistory(data), so arm-log pain of 7+
 * is RED as in readinessOn; a RED arm-log date without a check-in gets an entry too. The Map is
 * in date order.
 */
export function readinessHistory(checkins, profile = {}, { armLogs = null } = {}) {
  if (isPlainObj(checkins) && (Array.isArray(checkins.checkins) || isPlainObj(checkins.arm) || isPlainObj(checkins.profile))) {
    const d = checkins;
    checkins = d.checkins;
    profile = isPlainObj(d.profile) ? d.profile : {};
    if (armLogs === null) armLogs = d.arm?.logs || null;
  }
  const armPain = armLogPains(armLogs);
  const R = READINESS_RULES;
  const list = (Array.isArray(checkins) ? checkins : []).filter((c) => c && isISODate(c.date));
  const sorted = list.slice().sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  const series = (field) => {
    const pts = sorted.filter((c) => isNum(c[field])).map((c) => ({ date: c.date, v: Number(c[field]) }));
    const pre = new Float64Array(pts.length + 1);
    pts.forEach((p, i) => { pre[i + 1] = pre[i] + p.v; });
    return { pts, pre };
  };
  const rhr = series('rhr');
  const pain = series('arm_pain');
  const changes = rhrMethodChanges(profile);
  const baseline = isNum(profile?.rhr_baseline) ? Number(profile.rhr_baseline) : null;
  const periods = fastingPeriods(profile);
  const out = new Map();
  // Pointers only move forward: every window bound is non-decreasing in the date.
  let rHi = 0; let rLo = 0; let rSince = 0; let pHi = 0; let pLo = 0; let ci = -1; let fi = 0;
  for (let i = 0; i < sorted.length; i++) {
    const date = sorted[i].date;
    if (out.has(date)) continue;
    let j = i;
    while (j + 1 < sorted.length && sorted[j + 1].date === date) j++;
    const ck = j > i ? combineCheckins(sorted.slice(i, j + 1)) : sorted[i];
    const from = addDays(date, -7);
    while (ci + 1 < changes.length && changes[ci + 1] <= date) ci++;
    const change = ci >= 0 ? changes[ci] : null;
    const lower = change && change > from ? change : from;
    while (rHi < rhr.pts.length && rhr.pts[rHi].date < date) rHi++;
    while (rLo < rHi && rhr.pts[rLo].date < lower) rLo++;
    let ref = null;
    let rebase = null;
    const n = rHi - rLo;
    if (change) {
      while (rSince < rHi && rhr.pts[rSince].date < change) rSince++;
      const since = rHi - rSince;
      rebase = { since: change, readings: since, needed: R.rhrMinSinceChange, active: since < R.rhrMinSinceChange };
      if (since >= R.rhrMinSinceChange && n >= R.rhrMinReadings) ref = rhrRefOf((rhr.pre[rHi] - rhr.pre[rLo]) / n, 'average', n, { since: change });
    } else if (n >= R.rhrMinReadings) ref = rhrRefOf((rhr.pre[rHi] - rhr.pre[rLo]) / n, 'average', n);
    else if (baseline !== null) ref = rhrRefOf(baseline, 'baseline', n);
    while (pHi < pain.pts.length && pain.pts[pHi].date < date) pHi++;
    while (pLo < pHi && pain.pts[pLo].date < from) pLo++;
    const pn = pHi - pLo;
    const painRef = pn >= R.risingMinReadings ? { value: (pain.pre[pHi] - pain.pre[pLo]) / pn, count: pn } : null;
    while (fi < periods.length && periods[fi].end < date) fi++;
    let fasting = null;
    for (let k = fi; k < periods.length && periods[k].start <= date; k++) if (periods[k].end >= date) { fasting = periods[k]; break; }
    out.set(date, readiness(ck, null, profile, { rhrRef: ref, painRef, fasting, rhrRebaseline: rebase, armLog: armPain.get(date) || null }));
  }
  // RED arm-log dates without a check-in (BT2-6), merged in date order.
  const extra = [...armPain.values()].filter((p) => p.value >= R.redPain && !out.has(p.date));
  if (!extra.length) return out;
  for (const p of extra) out.set(p.date, readiness({ date: p.date }, null, profile, { rhrRef: null, painRef: null, fasting: fastingOn(profile, p.date), rhrRebaseline: null, armLog: p }));
  return new Map([...out.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)));
}

// ------------------------------------------------------------ weight-gain bands (SPEC 5.2 round 4)

/**
 * Weekly gain bands, kg a week, for an experienced lifter coming back from injury (SPEC 5.2 round 4):
 * the regain band while the 7-day average is below profile.pre_injury_weight_kg (muscle memory brings
 * lost muscle back faster than new muscle is built), the lean-gain band once it has reached it, and
 * +0.2 to +0.4 when no pre-injury weight is set.
 */
export const GAIN_BANDS = Object.freeze({
  regain: Object.freeze({ id: 'regain', lo: 0.25, hi: 0.5, label: 'regain band' }),
  lean: Object.freeze({ id: 'lean', lo: 0.15, hi: 0.3, label: 'lean-gain band' }),
  default: Object.freeze({ id: 'default', lo: 0.2, hi: 0.4, label: 'gain band' }),
});

/** The fortnightly weight verdict's rules (SPEC 5.2 round 4 and chapter 14). */
export const WEIGHT_RULES = Object.freeze({
  windowDays: 14, // non-overlapping fortnights counted from the programme start Monday
  minWeighIns: 10, // mornings with a weight inside the fortnight
  minPerWeek: 3, // weigh-ins behind each 7-day average that is compared
  afterFastingDays: 14, // nudges pause during fasting and for 14 days after it
  plausible: Object.freeze([30, 250]), // weights outside this (typos) never move a verdict
});

/** profile.pre_injury_weight_kg as a number (30–250 kg), or null. Takes the profile or the data. */
export function preInjuryWeight(profile) {
  const v = num(profileOf(profile)?.pre_injury_weight_kg);
  return v !== null && v >= WEIGHT_RULES.plausible[0] && v <= WEIGHT_RULES.plausible[1] ? v : null;
}

/** "+0.25 to +0.5 kg a week" */
export const bandText = (band) => `+${band.lo} to +${band.hi} kg a week`;

/**
 * The gain band for a 7-day average weight: {id: 'regain' | 'lean' | 'default', lo, hi, label,
 * text, preInjury}. With a pre-injury weight but no average yet, the default band is used.
 */
export function gainBand(profile, avg7 = null) {
  const pre = preInjuryWeight(profile);
  const band = pre === null || !isNum(avg7) ? GAIN_BANDS.default : Number(avg7) < pre - EPS ? GAIN_BANDS.regain : GAIN_BANDS.lean;
  return { ...band, text: bandText(band), preInjury: pre };
}

const fmt2s = (v) => `${v < 0 ? '−' : '+'}${String(Math.round(Math.abs(Number(v)) * 100) / 100)}`;
/** A fortnight losing more than this (kg a week) is "drifting down" (state 'losing'): no dieting while the bone heals. */
export const LOSING_KG_WEEK = -0.05;

/**
 * The single fortnightly weight verdict that the goals card and the coach notes share (SPEC 5.2
 * round 4, chapter 14). Fortnights are non-overlapping 14-day windows from the programme start
 * Monday (weeks 1–2, 3–4, …); the latest one that has ended on or before `dateISO` is judged, so
 * the verdict changes once a fortnight. Its change per week is (the 7-day average of its last
 * week − the 7-day average two weeks earlier) / 2, judged only with at least 10 weigh-ins in the
 * fortnight and 3 behind each average, against gainBand() for the fortnight's end average.
 * Weigh-ins inside a fasting period and the 14 days after it are ignored, and while `dateISO` is
 * in one of those there is no verdict at all ("paused": hold your weight steady).
 *
 * Returns {date, status, state, verdict, rate, avg7, prev7, band, window: {start, end, weighIns,
 * needed, week, weekBefore}, previous, twice, losing, nudge, next, first, start, preInjury,
 * fasting, until, reason, title, text}. status: 'in' | 'below' | 'above' (then verdict is the
 * same), 'insufficient' (too few weigh-ins), 'paused' (fasting or the 14 days after it) or
 * 'waiting' (before the first fortnight has ended). state is status, except 'losing' when the
 * average is drifting down by more than 0.05 kg a week. nudge: 'eat-more' | 'eat-less' | null.
 * {start} overrides the programme start (pass the timeline's start). With neither {start} nor
 * profile.program_start, the programme counts as starting the Monday after dateISO ('waiting').
 */
export function weightVerdict(data, dateISO, { start = null } = {}) {
  if (!isISODate(dateISO)) return null;
  const d = dataOf(data);
  const profile = isPlainObj(d?.profile) ? d.profile : {};
  const R = WEIGHT_RULES;
  const W = R.windowDays;
  const pauses = fastingPeriods(profile).map((p) => ({ start: p.start, end: addDays(p.end, R.afterFastingDays), period: p }));
  const pauseOn = (iso) => pauses.find((p) => p.start <= iso && iso <= p.end) || null;
  // One weigh-in per morning (several on a date are averaged), never after dateISO, never in a pause.
  const byDate = new Map();
  for (const c of Array.isArray(d?.checkins) ? d.checkins : []) {
    if (!c || typeof c !== 'object' || !isISODate(c.date) || c.date > dateISO || !isNum(c.weight_kg)) continue;
    const w = Number(c.weight_kg);
    if (w < R.plausible[0] || w > R.plausible[1] || pauseOn(c.date)) continue;
    const cur = byDate.get(c.date);
    if (cur) { cur.sum += w; cur.n += 1; } else byDate.set(c.date, { sum: w, n: 1 });
  }
  const pts = [...byDate.entries()].map(([date, x]) => ({ date, value: x.sum / x.n }));
  const between = (a, b) => pts.filter((p) => p.date >= a && p.date <= b);
  const anchor = mondayOf(isISODate(start) ? start : isISODate(profile.program_start) ? profile.program_start : mondayOnOrAfter(addDays(dateISO, 1)));
  const first = addDays(anchor, W - 1); // the Sunday that ends programme week 2
  const k = Math.floor((daysBetween(anchor, dateISO) - (W - 1)) / W);
  const end = addDays(anchor, k * W + (W - 1)); // the latest fortnight ending on or before dateISO
  const day = (iso) => fmtDay(iso, { today: dateISO });
  const judge = (e) => {
    const win = between(addDays(e, -(W - 1)), e);
    const now = between(addDays(e, -6), e);
    const before = between(addDays(e, -20), addDays(e, -14));
    const window = { start: addDays(e, -(W - 1)), end: e, weighIns: win.length, needed: R.minWeighIns, week: now.length, weekBefore: before.length };
    if (win.length < R.minWeighIns || now.length < R.minPerWeek || before.length < R.minPerWeek) return { ok: false, window };
    const avg7 = mean(now.map((p) => p.value));
    const prev7 = mean(before.map((p) => p.value));
    const rate = (avg7 - prev7) / 2;
    const band = gainBand(profile, avg7);
    return { ok: true, window, avg7, prev7, rate, band, status: rate < band.lo - EPS ? 'below' : rate > band.hi + EPS ? 'above' : 'in' };
  };
  const recent = between(addDays(dateISO, -6), dateISO);
  const base = {
    date: dateISO, start: anchor, first, preInjury: preInjuryWeight(profile), verdict: null, rate: null, avg7: null, prev7: null,
    band: gainBand(profile, recent.length ? mean(recent.map((p) => p.value)) : null), window: null, previous: null, twice: false,
    losing: false, nudge: null, next: null, fasting: null, until: null, reason: null,
  };
  const pause = pauseOn(dateISO);
  if (pause) {
    const fasting = dateISO <= pause.period.end;
    return {
      ...base, status: 'paused', state: 'paused', reason: fasting ? 'fasting' : 'after-fasting', fasting: pause.period, until: pause.end,
      title: fasting ? 'Fasting: hold your weight steady' : 'Weight check paused after fasting',
      text: fasting
        ? `Fasting: aim to hold your weight steady. Weight-trend nudges pause while you fast and for 14 days after (until ${day(pause.end)}), while water and glycogen settle.`
        : `Weight-trend nudges pause for 14 days after fasting (until ${day(pause.end)}) while water and glycogen settle. The next verdict needs a clean fortnight of weigh-ins after that.`,
    };
  }
  if (end < first) {
    return { ...base, status: 'waiting', state: 'waiting', next: first, title: 'Weight verdict: not started yet', text: `Your first weight verdict is on ${day(first)}, after the first fortnight of weigh-ins.` };
  }
  const cur = judge(end);
  const next = addDays(end, W);
  if (!cur.ok) {
    const hit = pauses.find((p) => p.start <= end && p.end >= addDays(end, -20));
    if (hit) {
      return {
        ...base, status: 'paused', state: 'paused', reason: 'after-fasting', fasting: hit.period, until: hit.end, window: cur.window, next,
        title: 'Weight check paused after fasting',
        text: `No weight verdict for the fortnight to ${day(end)}: weigh-ins during fasting and the 14 days after it (until ${day(hit.end)}) don’t count. Next check: ${day(next)}.`,
      };
    }
    const w = cur.window;
    const missing = [];
    if (w.weighIns < R.minWeighIns) missing.push(`${w.weighIns} of the ${R.minWeighIns} mornings needed`);
    if (w.week < R.minPerWeek) missing.push(`${w.week} in its last week (3 needed)`);
    if (w.weekBefore < R.minPerWeek) missing.push(`${w.weekBefore} in the week two weeks earlier (3 needed)`);
    return {
      ...base, status: 'insufficient', state: 'insufficient', window: w, next, title: 'Weight verdict: not enough weigh-ins',
      text: `Not enough weigh-ins to judge the fortnight to ${day(end)}: ${missing.join(', ')}. Weigh in every morning; next check ${day(next)}.`,
    };
  }
  const prevJudge = judge(addDays(end, -W));
  const previous = prevJudge.ok ? { status: prevJudge.status, state: prevJudge.rate < LOSING_KG_WEEK - EPS ? 'losing' : prevJudge.status, rate: prevJudge.rate, end: prevJudge.window.end } : null;
  const twice = !!previous && previous.status === cur.status && cur.status !== 'in';
  const losing = cur.rate < LOSING_KG_WEEK - EPS;
  const b = cur.band;
  const avg = `${String(Math.round(cur.avg7 * 10) / 10)} kg`;
  const moved = `Your 7-day average ${cur.rate < 0 ? 'fell' : 'rose'} ${String(Math.round(Math.abs(cur.rate) * 100) / 100)} kg a week over the fortnight to ${day(end)} (now ${avg})`;
  let title;
  let text;
  if (cur.status === 'in') {
    title = `Weight: ${fmt2s(cur.rate)} kg a week, in your ${b.label}`;
    text = `${moved}: inside your ${b.label} of ${b.text}. Change nothing.`;
  } else if (cur.status === 'below') {
    title = losing ? `Weight is drifting down: ${fmt2s(cur.rate)} kg a week` : `Weight gain below your ${b.label}: ${fmt2s(cur.rate)} kg a week`;
    text = losing
      ? `${moved}. No dieting while the bone heals: add 250–300 kcal a day, and check you’re eating every planned meal.`
      : `${moved}, below your ${b.label} of ${b.text}. Add 150–200 kcal a day, such as a glass of milk and a banana.`;
    if (twice) text += ' That’s the second fortnight in a row: move up to the next bigger meal-plan day.';
  } else {
    title = `Gaining faster than your ${b.label}: ${fmt2s(cur.rate)} kg a week`;
    text = `${moved}, above your ${b.label} of ${b.text}. Take off 100–150 kcal a day and stay above maintenance (no dieting while the bone heals).`;
    if (twice) text += ' That’s the second fortnight in a row: move down to the next smaller meal-plan day.';
  }
  return {
    ...base, status: cur.status, state: losing ? 'losing' : cur.status, verdict: cur.status, rate: cur.rate, avg7: cur.avg7, prev7: cur.prev7, band: b, window: cur.window,
    previous, twice, losing, nudge: cur.status === 'below' ? 'eat-more' : cur.status === 'above' ? 'eat-less' : null, next, title, text,
  };
}
