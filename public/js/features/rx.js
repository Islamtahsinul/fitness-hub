// Prescriptions (pure, no DOM): what an exercise asks for on a day, and the `planned` record every
// logged exercise entry stores (SPEC 5.2, round 4).
//
// - A planned block's prescription is the resolved block (sets after sets_max, deload and
//   easy-day or fasting halving).
// - A swapped-in or added exercise uses its OWN prescription from the library: its own type
//   (timed, reps or loaded, with a kg column for loaded work) and its default dose, with the same
//   week adjustments applied.
// - `planned` = {sets, reps, rir, seconds?, load}: the effective prescription that day. Progression
//   judges "all planned sets done" against it, never against the raw block sets.
//
// content.js / schedule.js may export prescriptionFor(exerciseId) (Team L, round 4). It is
// feature-detected and normalised; the local fallback reads the library's `dose` text.

import * as schedule from '../schedule.js';
import * as contentMod from '../content.js';
import * as calc from '../calc.js';
import * as stats from '../stats.js';

const { content } = contentMod;
const isNum = (v) => v !== null && v !== undefined && v !== '' && typeof v !== 'boolean' && Number.isFinite(Number(v));
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const toInt = (v, d = null) => (isNum(v) ? Math.max(0, Math.round(Number(v))) : d);

/** The first logic module that exports `name` as a function (or null). */
function shared(name) {
  for (const m of [contentMod, schedule, calc, stats]) if (m && typeof m[name] === 'function') return m[name];
  return null;
}

/** RIR shown on hold days (easy day, fasting): SPEC 5.2 "Hold: same load, RIR 3–4". */
export const HOLD_RIR = '3-4';

// ---------------------------------------------------------------- loaded or bodyweight

const LOAD_KIT = /dumbbell|barbell|\bplates?\b|machine|cable|kettlebell|sandbag|smith|leg press|pulldown|pulley|ez bar|trap bar|\bsled\b/i;

/**
 * Does an exercise take external load (a kg column)? Read from its kit list, each item without
 * its asides ("(or kettlebells…)", alternatives after "or", "not" or a colon). A bar locked in place
 * (Smith or rack) is a fixed handle, not a load, and supports for your uninjured (good) hand don't count.
 * Bodyweight ids (-bw), mobility, balance and rehab never take load.
 */
export function isLoadedExercise(ex) {
  if (!ex || typeof ex !== 'object') return false;
  const id = String(ex.id || '');
  if (/-bw$/.test(id) || ['mobility', 'balance', 'rehab'].includes(ex.category)) return false;
  return (Array.isArray(ex.equipment) ? ex.equipment : []).some((q) => {
    if (typeof q !== 'string' || /\blocked\b|\bfixed\b|^\s*(optional|until|bring)|for your (right|left|good|uninjured|other|free) hand/i.test(q)) return false;
    return LOAD_KIT.test(q.replace(/\([^)]*\)/g, ' ').split(/:|\bor\b|\bnot\b|,/i)[0]);
  });
}

// ---------------------------------------------------------------- the library dose, read as numbers

const DASH = /\s*[–—-]\s*/;
const clean = (t) => String(t || '').replace(/×/g, 'x').replace(/[–—]/g, '-');

/**
 * Reads a library dose such as "3 × 8–12, RIR 2–3", "3–5 × 30–45 s holds", "4 × 30 s / side" or
 * "20–60 min Zone 2" into {kind, sets, reps, seconds, minutes, rir, per_side, unit}. Sets and
 * times take the lower end of a range (start conservative); reps keep the range for double
 * progression. Returns null when nothing in it is a number.
 */
export function parseDose(dose) {
  const t = clean(dose);
  if (!t.trim()) return null;
  const out = { kind: 'strength', sets: null, reps: null, seconds: null, minutes: null, rir: null, per_side: false, unit: null };
  const rir = /RIR\s*(\d+(?:\s*-\s*\d+)?)/i.exec(t);
  if (rir) out.rir = rir[1].replace(/\s+/g, '');
  out.per_side = /(per|\/)\s*(leg|side|hand|shoulder|arm)\b|each (leg|side)/i.test(t);
  const m = /(\d+)(?:\s*-\s*(\d+))?\s*(?:x|sets? of)\s*(\d+(?:\.\d+)?)(?:\s*-\s*(\d+(?:\.\d+)?))?\s*(steps|seconds|sec\b|secs\b|s\b|minutes|min\b|metres|meters|m\b)?/i.exec(t);
  if (m) {
    out.sets = Number(m[1]);
    const lo = Number(m[3]);
    const hi = m[4] ? Number(m[4]) : null;
    const unit = (m[5] || '').toLowerCase();
    if (unit === 's' || unit.startsWith('sec')) { out.kind = 'timed'; out.seconds = lo; }
    else if (unit.startsWith('min')) { out.kind = 'timed'; out.seconds = lo * 60; }
    else {
      out.reps = hi ? `${lo}-${hi}` : String(lo);
      if (unit === 'm' || unit.startsWith('met')) out.unit = 'm';
      else if (unit === 'steps') out.unit = 'steps';
    }
    return out;
  }
  const mins = /(\d+)(?:\s*-\s*(\d+))?\s*(?:min\b|minutes)/i.exec(t);
  const secs = /(\d+)(?:\s*-\s*(\d+))?\s*s\b/i.exec(t);
  const reps = /(\d+)(?:\s*-\s*(\d+))?\s*(?:reps?|rocks|turns|switches|swings|breaths|circles|slow|marches|squeezes)/i.exec(t);
  if (secs && (!mins || secs.index < mins.index)) { out.kind = 'timed'; out.sets = 1; out.seconds = Number(secs[1]); return out; }
  if (mins) { out.kind = 'cardio'; out.minutes = Number(mins[1]); return out; }
  if (reps) { out.sets = 1; out.reps = reps[2] ? `${reps[1]}-${reps[2]}` : reps[1]; return out; }
  const any = /(\d+)/.exec(t);
  if (any) { out.sets = 1; out.reps = any[1]; return out; }
  return null;
}

const CARDIO_ID = /(walk|hike|bike|stair|rower|ski-erg|ruck|incline|treadmill|cycle)/;

/**
 * The rest between sets a library dose asks for, in seconds: "60 s rest", "45–60 s rest",
 * "rest 60–90 s", "60–90 s full rest", "2 min rest". A range starts at its lower end, like the
 * rest of the dose. null when the dose doesn't say ("resting as needed", "full rest").
 */
export function restFromDose(dose) {
  const t = clean(dose);
  if (!t.trim()) return null;
  const before = /(\d+(?:\.\d+)?)(?:\s*-\s*\d+(?:\.\d+)?)?\s*(s|sec|secs|seconds|min|mins|minutes)\b\.?\s+(?:of\s+)?(?:full\s+|easy\s+)?rest\b/i.exec(t);
  const after = /\brest(?:ing)?\s+(?:for\s+)?(\d+(?:\.\d+)?)(?:\s*-\s*\d+(?:\.\d+)?)?\s*(s|sec|secs|seconds|min|mins|minutes)\b/i.exec(t);
  const m = before && after ? (before.index <= after.index ? before : after) : before || after;
  if (!m) return null;
  const v = Number(m[1]) * (/^m/i.test(m[2]) ? 60 : 1);
  return Number.isFinite(v) && v > 0 && v <= 600 ? Math.round(v) : null;
}

/** The local reading of an exercise's default prescription (used until prescriptionFor exists). */
function localPrescription(ex) {
  const physio = ex.category === 'rehab' || /as prescribed by your physio/i.test(String(ex.dose || ''));
  const p = parseDose(ex.dose) || { kind: 'strength', sets: null, reps: null, seconds: null, minutes: null, rir: null, per_side: false, unit: null };
  let kind = physio ? 'physio' : p.kind;
  if (!physio && ex.category === 'conditioning' && CARDIO_ID.test(ex.id)) {
    // Machines and walks are cardio: their first "N min" is the dose ("20–60 min Zone 2").
    kind = 'cardio';
    const mins = /(\d+)(?:\s*-\s*\d+)?\s*(?:min\b|minutes)/i.exec(clean(ex.dose));
    p.minutes = mins ? Number(mins[1]) : p.minutes;
  }
  const loaded = !physio && kind !== 'cardio' && isLoadedExercise(ex);
  const sets = Math.max(1, Math.min(10, toInt(p.sets, 2) || 2));
  const tempo = /tempo\s*(\d+(?:-\d+){2,3})/i.exec(clean(ex.dose));
  const range = schedule.parseRepRange(p.reps);
  return {
    kind, sets, reps: p.reps, seconds: p.seconds, minutes: p.minutes, rir: p.rir || null, per_side: !!p.per_side, unit: p.unit,
    tempo: tempo ? tempo[1] : '', rest_s: restFromDose(ex.dose),
    loaded,
    load: physio ? 'physio' : loaded ? (kind === 'strength' && range && range.max > range.min ? 'double-progression' : '') : 'bodyweight',
    dose: typeof ex.dose === 'string' ? ex.dose : '', source: 'library',
  };
}

const KIND_OF = { timed: 'timed', time: 'timed', hold: 'timed', seconds: 'timed', cardio: 'cardio', minutes: 'cardio', physio: 'physio', rehab: 'physio', reps: 'strength', loaded: 'strength', strength: 'strength', bodyweight: 'strength', weighted: 'strength' };

/** Accepts whatever prescriptionFor returns and gives the shape the logger uses. */
export function normaliseRx(r, ex = null) {
  if (!isObj(r)) return null;
  const type = String(r.type || r.kind || r.prescription || '').toLowerCase();
  if (type === 'other') return null;
  let kind = KIND_OF[type] || null;
  const reps = isObj(r.reps) && isNum(r.reps.min) ? (isNum(r.reps.max) && r.reps.max !== r.reps.min ? `${r.reps.min}-${r.reps.max}` : String(r.reps.min))
    : r.reps !== null && r.reps !== undefined && r.reps !== '' ? String(r.reps) : null;
  const seconds = isNum(r.seconds) ? Number(r.seconds) : null;
  if (!kind) kind = seconds !== null && !reps ? 'timed' : isNum(r.minutes) && !reps ? 'cardio' : r.load === 'physio' ? 'physio' : 'strength';
  // "timed, reps or loaded" (SPEC 5.2): only an untyped answer falls back to the library's kit.
  const loaded = typeof r.loaded === 'boolean' ? r.loaded : typeof r.kg === 'boolean' ? r.kg
    : type === 'loaded' || type === 'weighted' || r.load === 'double-progression'
      || (!type && kind !== 'physio' && r.load !== 'bodyweight' && ex ? isLoadedExercise(ex) : false);
  const load = typeof r.load === 'string' && r.load ? r.load
    : kind === 'physio' ? 'physio' : loaded ? (kind === 'strength' ? 'double-progression' : '') : 'bodyweight';
  const dose = typeof r.dose === 'string' ? r.dose : (typeof ex?.dose === 'string' ? ex.dose : '');
  const rest = isNum(r.rest_s) ? Number(r.rest_s) : isNum(r.block?.rest_s) ? Number(r.block.rest_s) : restFromDose(dose);
  return {
    kind, sets: Math.max(1, toInt(r.sets, 2) || 1), reps, seconds, minutes: isNum(r.minutes) ? Number(r.minutes) : null,
    rir: r.rir !== null && r.rir !== undefined && r.rir !== '' ? String(r.rir) : null,
    per_side: !!(r.per_side ?? r.perSide), unit: typeof r.unit === 'string' ? r.unit : null, tempo: typeof r.tempo === 'string' ? r.tempo : '',
    rest_s: rest, loaded: !!loaded, load, dose, source: 'logic',
  };
}

/**
 * The default prescription of an exercise from the library: {kind: 'strength'|'timed'|'cardio'|
 * 'physio', sets, reps, seconds, minutes, rir, per_side, loaded, load, tempo, dose}, or null for
 * an id that isn't in the library (fail closed: it's locked anyway).
 */
export function prescriptionFor(id, opts = {}) {
  const o = opts instanceof Map ? { exById: opts } : isObj(opts) ? opts : {};
  const exById = o.exById instanceof Map ? o.exById : content.exById;
  const ex = typeof id === 'string' && exById ? exById.get(id) : null;
  const fn = shared('prescriptionFor');
  if (fn) {
    try {
      // The logic module's answer is used as it is; 'other' (a dose it can't read) stays null,
      // so the logger keeps the planned block's shape and shows the dose text.
      const r = fn(id, { ...(o.exById instanceof Map ? { exById: o.exById } : {}), ...(isNum(o.sets) ? { sets: Number(o.sets) } : {}) });
      return r ? normaliseRx(r, ex) : null;
    } catch { /* fall back */ }
  }
  return ex ? localPrescription(ex) : null;
}

// ---------------------------------------------------------------- the day's adjustments

/**
 * A prescription with the week's adjustments: sets_max, deload or easy-day (fasting) halving
 * (schedule.adjustSets, so it matches the planned blocks exactly), the override's RIR, and the
 * hold RIR (3–4) on easy days and on deload weeks that don't set their own RIR, as
 * schedule.resolveBlock does for planned blocks.
 * Round 4 (finding 11): a timed hold or physio work only carries an RIR its own dose gives it, so
 * an easy-day swap to a timed exercise shows no RIR chip (SPEC-DATA "Hold RIR").
 */
export function effectiveRx(rx, { override = null, easyDay = false } = {}) {
  if (!rx) return null;
  const planned = Math.max(1, toInt(rx.sets, 1) || 1);
  const sets = typeof schedule.adjustSets === 'function' ? schedule.adjustSets(planned, override, easyDay) : planned;
  const why = [];
  const cap = toInt(override?.sets_max, 0);
  if (cap > 0 && cap < planned) why.push(`capped at ${cap} this week`);
  if (override?.deload) why.push('deload week: sets halved');
  else if (easyDay) why.push('easy day: sets halved');
  const text = (v) => (v !== null && v !== undefined && v !== '' ? String(v) : null);
  const overrideRir = text(override?.rir);
  const own = text(rx.rir);
  const physio = rx.kind === 'physio' || rx.load === 'physio';
  const timed = rx.kind === 'timed' || physio;
  const base = timed ? own : overrideRir ?? own;
  const holds = (easyDay || (!!override?.deload && overrideRir === null)) && !physio && (rx.kind === 'strength' || base !== null);
  const out = { ...rx, setsPlanned: planned, sets, setsNote: why.join('; '), rir: holds ? HOLD_RIR : base };
  if (holds) out.holdRir = true;
  return out;
}

/** The resolved planned block as a prescription (for blocks that weren't swapped). */
export function rxFromBlock(rb) {
  if (!rb) return null;
  const physio = rb.exercise === 'x-physio-programme' || rb.load === 'physio';
  const timed = rb.kind === 'timed';
  return {
    kind: physio && rb.exercise === 'x-physio-programme' ? 'physio' : timed ? 'timed' : 'strength',
    sets: rb.sets, setsPlanned: rb.setsPlanned ?? rb.sets, setsNote: rb.setsNote || '',
    reps: timed ? null : rb.reps ?? null, seconds: isNum(rb.seconds) ? Number(rb.seconds) : null,
    rir: rb.rir || null, per_side: !!rb.per_side, tempo: rb.tempo || '', rest_s: rb.rest_s ?? null, unit: null,
    load: rb.load || '', loaded: !physio && rb.load !== 'bodyweight' && rb.load !== 'physio', dose: '', source: 'block',
  };
}

/**
 * The SPEC 5.2 `planned` record: {sets, reps, rir, seconds?, load}. Built by
 * schedule.plannedFromBlock when it exists, so a stored record has exactly the shape the logic
 * module recomputes for older logs.
 */
export function plannedRecord(rx) {
  if (!rx) return null;
  if (typeof schedule.plannedFromBlock === 'function') {
    try {
      const timed = rx.kind === 'timed' || rx.kind === 'physio';
      const p = schedule.plannedFromBlock({
        kind: timed ? 'timed' : 'strength', sets: Math.max(1, toInt(rx.sets, 1) || 1), reps: timed ? null : rx.reps ?? null,
        rir: rx.rir ? String(rx.rir) : '', load: rx.load || '', seconds: timed ? (isNum(rx.seconds) ? Number(rx.seconds) : null) : null,
      });
      if (p) {
        if (timed && !('seconds' in p)) p.seconds = isNum(rx.seconds) ? Number(rx.seconds) : null;
        return p;
      }
    } catch { /* fall back */ }
  }
  const out = {
    sets: Math.max(1, toInt(rx.sets, 1) || 1),
    reps: rx.kind === 'timed' || rx.kind === 'physio' ? null : rx.reps ?? null,
    rir: rx.rir ? String(rx.rir) : null,
    load: rx.load || null,
  };
  if (rx.kind === 'timed' || rx.kind === 'physio' || isNum(rx.seconds)) out.seconds = isNum(rx.seconds) ? Number(rx.seconds) : null;
  return out;
}

/** Same planned record? (so stamping never rewrites an entry, and never causes a merge.) */
export function samePlanned(a, b) {
  if (!isObj(a) || !isObj(b)) return false;
  const v = (x) => (x === '' || x === undefined ? null : x);
  return ['sets', 'reps', 'rir', 'seconds', 'load'].every((k) => v(a[k]) === v(b[k]));
}

/** Short dose text for chips: "3 × 8–12", "2 × 30 s / side", "20 min". */
export function rxText(rx) {
  if (!rx) return '';
  const dash = (v) => String(v ?? '').replace(/(\d)\s*-\s*(\d)/g, '$1–$2');
  const side = rx.per_side ? ' / side' : '';
  if (rx.kind === 'cardio') return isNum(rx.minutes) ? `${rx.minutes} min` : '';
  if (rx.kind === 'timed') return `${rx.sets} × ${isNum(rx.seconds) ? `${rx.seconds} s` : '?'}${side}`;
  if (rx.kind === 'physio') return 'As prescribed by your physio';
  return `${rx.sets} × ${dash(rx.reps ?? '?')}${rx.unit === 'm' ? ' m' : rx.unit === 'steps' ? ' steps' : ''}${side}`;
}
