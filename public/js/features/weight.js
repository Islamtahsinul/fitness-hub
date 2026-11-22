// The weight-gain verdict (SPEC 5.2, round 4): one verdict per fortnight, shared by the goals
// card, the coach notes, Today, Review and Progress. Pure, no DOM.
//
// Bands (experienced lifter, muscle memory):
//   - profile.pre_injury_weight_kg set and the 7-day average below it: regain, +0.25 to +0.5 kg/week
//   - otherwise, with it set: lean gain, +0.15 to +0.3 kg/week
//   - not set: +0.2 to +0.4 kg/week
// Judged on non-overlapping 14-day windows from the programme start, each with at least 10
// weigh-ins. Windows that touch a fasting period, or the 14 days after one, give no verdict (no
// gain nudges). calc.js / stats.js may export weightVerdict(data, date) (Team L); it's
// feature-detected and its answer normalised. The local fallback below follows the SPEC.

import * as calc from '../calc.js';
import * as stats from '../stats.js';
import * as schedule from '../schedule.js';
import { addDays, daysBetween, isISODate, mondayOf } from '../dates.js';
import { fastingPeriods } from './safety.js';

const isNum = (v) => v !== null && v !== undefined && v !== '' && typeof v !== 'boolean' && Number.isFinite(Number(v));
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const EPS = 1e-9;
const nfKg = new Intl.NumberFormat('en-GB', { minimumFractionDigits: 1, maximumFractionDigits: 2 });
/** 0.25 -> "0.25", 0.5 -> "0.5", 0.312 -> "0.31" */
const kg = (v) => nfKg.format(Number(v));

export const BANDS = Object.freeze({
  regain: { kind: 'regain', lo: 0.25, hi: 0.5, name: 'regain band' },
  lean: { kind: 'lean', lo: 0.15, hi: 0.3, name: 'lean-gain band' },
  default: { kind: 'default', lo: 0.2, hi: 0.4, name: 'target band' },
});
export const WINDOW_DAYS = 14;
export const MIN_WEIGHINS = 10;
export const AFTER_FAST_DAYS = 14;

/** "+0.25 to +0.5 kg a week" */
export function bandText(band) {
  if (!band) return '';
  return `+${kg(band.lo)} to +${kg(band.hi)} kg a week`;
}

function weighIns(data) {
  const byDate = new Map();
  for (const c of Array.isArray(data?.checkins) ? data.checkins : []) {
    if (c && isISODate(c.date) && isNum(c.weight_kg) && !byDate.has(c.date)) byDate.set(c.date, Number(c.weight_kg));
  }
  return byDate;
}

function meanIn(byDate, from, to) {
  let s = 0;
  let n = 0;
  for (let d = from; d <= to; d = addDays(d, 1)) if (byDate.has(d)) { s += byDate.get(d); n += 1; }
  return { mean: n ? s / n : null, n };
}

/** The band for a 7-day average (SPEC): regain while below the pre-injury weight. */
export function bandFor(profile, avg7) {
  const pre = isNum(profile?.pre_injury_weight_kg) && Number(profile.pre_injury_weight_kg) > 0 ? Number(profile.pre_injury_weight_kg) : null;
  if (pre === null) return { ...BANDS.default, pre: null };
  if (isNum(avg7) && Number(avg7) < pre - EPS) return { ...BANDS.regain, pre };
  if (!isNum(avg7)) return { ...BANDS.regain, pre }; // no weigh-ins yet: assume still below it
  return { ...BANDS.lean, pre };
}

/** The 7-day average on or before a date (needs 3 weigh-ins). */
export function avg7On(data, date, byDate = weighIns(data)) {
  const r = meanIn(byDate, addDays(date, -6), date);
  return r.n >= 3 ? r.mean : null;
}

/** The band that applies on a date. */
export function weightBand(data, date) {
  return bandFor(data?.profile, avg7On(data, date));
}

function programStartOf(data, program = null) {
  const tl = program ? schedule.buildTimeline(program, data?.profile || {}) : null;
  if (tl?.start) return tl.start;
  const p = data?.profile?.program_start;
  return isISODate(p) ? mondayOf(p) : null;
}

/** The fasting period touching [from, to], or the one whose 14 days after touch it: {period, after}. */
function fastingTouch(profile, from, to) {
  for (const p of fastingPeriods(profile)) {
    if (p.start <= to && p.end >= from) return { period: p, after: false };
    if (p.end < from && addDays(p.end, AFTER_FAST_DAYS) >= from) return { period: p, after: true };
  }
  return null;
}

/** One 14-day window's verdict (local SPEC rules). */
function windowVerdict(data, from, byDate) {
  const to = addDays(from, WINDOW_DAYS - 1);
  const fast = fastingTouch(data?.profile, from, to);
  const all = meanIn(byDate, from, to);
  const first = meanIn(byDate, from, addDays(from, 6));
  const second = meanIn(byDate, addDays(from, 7), to);
  const band = bandFor(data?.profile, second.n >= 3 ? second.mean : null);
  const base = { window: { from, to }, count: all.n, avg: second.n ? second.mean : null, band };
  if (fast) return { ...base, state: 'paused', reason: fast.after ? 'after-fasting' : 'fasting', fasting: fast.period, rate: null };
  if (all.n < MIN_WEIGHINS || first.n < 3 || second.n < 3) return { ...base, state: 'insufficient', rate: null };
  const rate = second.mean - first.mean;
  const state = rate < -0.05 - EPS ? 'losing' : rate < band.lo - EPS ? 'below' : rate > band.hi + EPS ? 'above' : 'in';
  return { ...base, state, rate };
}

/** Local fallback: the latest finished window on or before `date`, with the window before it. */
export function localWeightVerdict(data, date, { program = null, start = null } = {}) {
  const s = isISODate(start) ? start : programStartOf(data, program);
  const today = isISODate(date) ? date : null;
  if (!s || !today) return { state: 'waiting', reason: 'no-start', rate: null, band: weightBand(data, today || s), window: null, nextCheck: null };
  const firstEnd = addDays(s, WINDOW_DAYS - 1);
  if (today < firstEnd) {
    return { state: 'waiting', reason: 'first-window', rate: null, band: weightBand(data, today), window: { from: s, to: firstEnd }, nextCheck: firstEnd, count: 0 };
  }
  const byDate = weighIns(data);
  const k = Math.floor((daysBetween(s, today) - (WINDOW_DAYS - 1)) / WINDOW_DAYS);
  const from = addDays(s, k * WINDOW_DAYS);
  const v = windowVerdict(data, from, byDate);
  // The fortnight before (even one before the programme start, when you weighed in then).
  const prev = windowVerdict(data, addDays(from, -WINDOW_DAYS), byDate);
  const prevOk = prev && isNum(prev.rate);
  return { ...v, prev: prevOk ? { state: prev.state, rate: prev.rate } : null, twice: prevOk && prev.state === v.state && v.state !== 'in', nextCheck: addDays(v.window.to, WINDOW_DAYS), source: 'local' };
}

// ---------------------------------------------------------------- Team L's verdict, normalised

const STATE_WORDS = [
  [/fasting|paused|hold|after.?fast|excluded/i, 'paused'],
  [/insufficient|not.?enough|too.?few|sparse|no.?data/i, 'insufficient'],
  [/wait|early|pending|none|not.?yet/i, 'waiting'],
  [/los|drop|down|declin/i, 'losing'],
  [/below|slow|under|low/i, 'below'],
  [/above|over|high|faster|too.?fast/i, 'above'],
  [/^in$|in.?band|on.?target|on.?track|^ok$|good|within/i, 'in'],
];

function stateOf(v) {
  const t = String(v ?? '');
  for (const [re, s] of STATE_WORDS) if (re.test(t)) return s;
  return null;
}

function bandOf(r, fallback) {
  const b = r.band ?? r.target ?? null;
  const kind = String((isObj(b) && (b.kind || b.name || b.id)) || r.bandKind || r.band_kind || r.mode || '').toLowerCase();
  const pick = /regain/.test(kind) ? BANDS.regain : /lean/.test(kind) ? BANDS.lean : null;
  let lo = null;
  let hi = null;
  if (Array.isArray(b) && b.length >= 2) [lo, hi] = b.map(Number);
  else if (isObj(b)) { lo = Number(b.lo ?? b.min ?? b.low); hi = Number(b.hi ?? b.max ?? b.high); }
  if (Number.isFinite(lo) && Number.isFinite(hi)) {
    const k = pick?.kind || (Math.abs(lo - 0.25) < 1e-6 && Math.abs(hi - 0.5) < 1e-6 ? 'regain' : Math.abs(lo - 0.15) < 1e-6 ? 'lean' : 'default');
    return { ...BANDS[k], lo, hi, pre: fallback?.pre ?? null };
  }
  return pick ? { ...pick, pre: fallback?.pre ?? null } : fallback;
}

/** Normalises a weightVerdict() answer into the local shape, or null when it can't be read. */
export function normaliseVerdict(r, local) {
  if (!isObj(r)) return null;
  const state = stateOf(r.state ?? r.verdict ?? r.status ?? r.result ?? r.kind);
  if (!state) return null;
  const rateRaw = r.rate ?? r.perWeek ?? r.per_week ?? r.weekly ?? r.change ?? r.kgPerWeek ?? null;
  const w = isObj(r.window) ? r.window : null;
  const from = w ? (w.from ?? w.start) : (r.from ?? r.start ?? null);
  const to = w ? (w.to ?? w.end) : (r.to ?? r.end ?? null);
  const pv = isObj(r.previous) ? r.previous : isObj(r.prev) ? r.prev : null;
  const prevState = pv ? stateOf(pv.state ?? pv.status ?? pv.verdict) : null;
  const prev = pv && prevState ? { state: prevState, rate: isNum(pv.rate) ? Number(pv.rate) : null } : (r.previous === null ? null : local?.prev ?? null);
  return {
    ...local,
    state,
    prev,
    twice: typeof r.twice === 'boolean' ? r.twice : !!prev && prev.state === state && state !== 'in',
    nextCheck: isISODate(r.next) ? r.next : local?.nextCheck ?? null,
    fasting: isObj(r.fasting) ? r.fasting : local?.fasting ?? null,
    title: typeof r.title === 'string' ? r.title : null,
    text: typeof r.text === 'string' ? r.text : null,
    reason: typeof r.reason === 'string' ? r.reason : state === 'paused' ? (local?.reason || 'fasting') : local?.reason,
    rate: isNum(rateRaw) ? Number(rateRaw) : state === 'paused' || state === 'insufficient' || state === 'waiting' ? null : local?.rate ?? null,
    band: bandOf(r, local?.band),
    window: isISODate(from) && isISODate(to) ? { from, to } : local?.window || null,
    count: isNum(r.count ?? r.weighIns ?? r.n ?? w?.weighIns) ? Number(r.count ?? r.weighIns ?? r.n ?? w?.weighIns) : local?.count,
    avg: isNum(r.avg ?? r.mean ?? r.avg7) ? Number(r.avg ?? r.mean ?? r.avg7) : local?.avg ?? null,
    source: 'logic',
  };
}

/**
 * The fortnightly verdict for `date`: {state: 'in'|'below'|'above'|'losing'|'paused'|'insufficient'|
 * 'waiting', reason, rate (kg/week), band {kind, lo, hi, name, pre}, window {from, to}, prev, nextCheck,
 * count, avg, fasting}.
 */
export function weightVerdict(data, date, opts = {}) {
  const local = localWeightVerdict(data, date, opts);
  for (const m of [calc, stats]) {
    if (typeof m.weightVerdict !== 'function') continue;
    try {
      const r = normaliseVerdict(m.weightVerdict(data, date, opts.start ? { start: opts.start } : {}), local);
      if (r) return r;
    } catch { /* fall back */ }
  }
  return local;
}

// ---------------------------------------------------------------- words

const fmtRate = (v) => `${v >= 0 ? '+' : '−'}${kg(Math.abs(v))} kg a week`;

/**
 * One line for Today, Review and Progress: the verdict against the band, or the fasting hold.
 * `fastingNow` (the period covering today, if any) wins: fasting days show the hold, never
 * "below band" (SPEC 5.2 fasting overlay).
 */
export function verdictLine(v, { fastingNow = null } = {}) {
  if (fastingNow) return `Fasting: hold your weight steady for now. No gain target until 14 days after the fast.`;
  if (!v) return '';
  const band = v.band ? `your ${v.band.name}, ${bandText(v.band)}` : 'the band';
  switch (v.state) {
    case 'in': return `${fmtRate(v.rate)} over the last fortnight: inside ${band}.`;
    case 'below': return `${fmtRate(v.rate)} over the last fortnight: below ${band}.`;
    case 'above': return `${fmtRate(v.rate)} over the last fortnight: above ${band}.`;
    case 'losing': return `${fmtRate(v.rate)} over the last fortnight: losing weight. Aim for ${bandText(v.band)}.`;
    case 'paused': return v.reason === 'after-fasting' ? 'Holding after the fast: no gain target for 14 days after it ends.' : 'Fasting: hold your weight steady. No gain target this fortnight.';
    case 'insufficient': return `Not enough weigh-ins last fortnight for a verdict (${MIN_WEIGHINS} needed). Aim for ${bandText(v.band)}.`;
    default: return `Aim for ${bandText(v.band)}. The first verdict comes after two weeks of weigh-ins.`;
  }
}
