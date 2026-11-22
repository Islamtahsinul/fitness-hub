// User data store: in-memory data, debounced saves, optimistic concurrency (SPEC 5.7a) and a
// localStorage safety net. Nothing you type is ever silently lost:
//
//  * Unsaved changes are mirrored to localStorage as a small delta (one key per tab) until the
//    server confirms them. After a crash, a closed tab or a stopped server they are offered back.
//  * Every PUT carries If-Match. On 412 (someone else saved first) or 428 (no ETag yet) the store
//    re-fetches, merges record by record (field by field inside a record) and saves again.
//    A true conflict (the same field changed differently on both sides) pauses saving and is
//    handed to the UI (onConflict / resolveConflict); local changes stay in localStorage.
//  * Merges patch the live data in place, so views holding a record never write into a detached
//    copy. Failed saves retry with backoff; pagehide/hidden flush with fetch keepalive.
//
// Round 3:
//  * Recovery (PE1) re-applies the stored deltas onto the LIVE data when you choose to restore,
//    never an init-time snapshot, so anything adopted meanwhile (a hike from another device, a
//    newer weight) survives. Old v1 browser copies may only add records or fill empty fields.
//    Real conflicts go through onConflict / resolveConflict like any other.
//  * A save watchdog: a save that never answers goes to "error + retry"; edits made meanwhile
//    are still written to localStorage (PE4).
//  * The build id from /api/health is sent as X-Hub-Build on every PUT; a 409 build_mismatch
//    keeps local changes and switches to status "build-mismatch" (SPEC 5.7a).

import { apiGetDataWithEtag, apiPutData, apiHealth, getText, byteLength, fitsKeepalive, buildOf } from './api.js';
import { isISODate, mondayOf, todayISO, addDays } from './dates.js';
import { dataIssues } from './stats.js';
import { UNAVAILABLE_DEFAULT, isAvailable as availableIn } from './schedule.js';

export const SCHEMA_VERSION = 2;
export const MAX_DATA_BYTES = 10 * 1024 * 1024; // server limit for PUT /api/data

const SAVE_DELAY = 500;
const RETRY_MIN = 2000;
const RETRY_MAX = 60000;
const SAVE_TIMEOUT = 30000; // watchdog: a save (or check) that hasn't settled by then is abandoned
const BUILD_CHECK_GAP = 60000; // focus re-checks the hub's build at most once a minute
const MAX_RESYNCS = 5; // consecutive 412/428 rounds before backing off
const CHECK_MIN_GAP = 4000; // focus/visibility checks are throttled to one per 4 s
const ORPHAN_AGE_MS = 120000; // without Web Locks, other tabs' deltas older than this are orphans
const LEGACY_PENDING_KEY = 'fitness-hub:pending'; // v1 client: {at, data}
const PENDING_PREFIX = 'fitness-hub:pending:'; // + tab id: {v: 2, tab, at, base_etag, changes}
const TAB_KEY = 'fitness-hub:tab'; // sessionStorage
const CONFLICT_LOG_KEY = 'fitness-hub:conflict-log';
const DISCARDED_KEY = 'fitness-hub:discarded';
/** SEC10: the conflict log keeps the last 20 entries, none older than 30 days, at most 200 KB. */
export const CONFLICT_LOG_LIMITS = Object.freeze({ entries: 20, days: 30, chars: 200000 });
const DISCARDED_LIMITS = Object.freeze({ entries: 3, days: 30, chars: 1500000 });
/** Shown when the hub was updated under an open tab (SPEC 5.7a round 3). */
export const BUILD_MISMATCH_TEXT = 'The hub was updated. Reload to continue.';
export { UNAVAILABLE_DEFAULT };
/** False when the exercise is on profile.unavailable_exercises (see schedule.isAvailable). */
export const isAvailable = (id, data) => availableIn(id, data);
const LOCK_PREFIX = 'fitness-hub:tab:';
const CHANNEL_NAME = 'fitness-hub';

// ====================================================================== JSON helpers

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

/** Assignment that also works for a key literally named "__proto__". */
function setKey(o, k, v) {
  if (k === '__proto__') Object.defineProperty(o, k, { value: v, enumerable: true, writable: true, configurable: true });
  else o[k] = v;
}

export function cloneJSON(v) {
  return v === undefined ? undefined : JSON.parse(JSON.stringify(v));
}

function unionKeys(...objs) {
  const s = new Set();
  for (const o of objs) if (isObj(o)) for (const k of Object.keys(o)) s.add(k);
  return [...s];
}

/** Structural equality for JSON values. Keys whose value is undefined count as absent. */
export function deepEqual(a, b) {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false;
  const aa = Array.isArray(a);
  if (aa !== Array.isArray(b)) return false;
  if (aa) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!deepEqual(a[i], b[i])) return false;
    return true;
  }
  let n = 0;
  for (const k of Object.keys(a)) {
    if (a[k] === undefined) continue;
    n++;
    if (!own(b, k) || !deepEqual(a[k], b[k])) return false;
  }
  for (const k of Object.keys(b)) if (b[k] !== undefined) n--;
  return n === 0;
}

function canonical(v) {
  if (v === undefined) return 'u';
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map((x) => (x === undefined ? 'null' : canonical(x))).join(',')}]`;
  return `{${Object.keys(v).filter((k) => v[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`;
}

function hash64(str) {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
  h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
  h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (h2 >>> 0).toString(16).padStart(8, '0') + (h1 >>> 0).toString(16).padStart(8, '0');
}

/** Stable 64-bit hash of a JSON value (key order does not matter). */
export function hashValue(v) {
  return hash64(canonical(v));
}

function newUuid() {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  if (c && typeof c.getRandomValues === 'function') {
    const b = c.getRandomValues(new Uint8Array(16));
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    const hx = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
    return `${hx.slice(0, 8)}-${hx.slice(8, 12)}-${hx.slice(12, 16)}-${hx.slice(16, 20)}-${hx.slice(20)}`;
  }
  return `${Date.now().toString(16)}-${Math.random().toString(16).slice(2)}-${Math.random().toString(16).slice(2)}`;
}

function getAt(obj, path) {
  let o = obj;
  for (const k of path) {
    if (o === null || typeof o !== 'object') return undefined;
    o = o[k];
  }
  return o;
}

function ensureParent(obj, path) {
  let o = obj;
  for (const k of path) {
    if (!isObj(o[k])) setKey(o, k, {});
    o = o[k];
  }
  return o;
}

// ====================================================================== schema

/** Arrays of records and the field that identifies a record (SPEC 5.7a merge keys). */
export const DATA_COLLECTIONS = [
  { path: ['checkins'], key: 'date', dateField: 'date', label: 'Check-in', idPrefix: null },
  { path: ['workouts'], key: 'id', dateField: 'date', label: 'Session', idPrefix: 'w' },
  { path: ['hikes'], key: 'id', dateField: 'date', label: 'Hike', idPrefix: 'h' },
  { path: ['tests'], key: 'id', dateField: 'date', label: 'Test result', idPrefix: 't' },
  { path: ['measurements'], key: 'date', dateField: 'date', label: 'Measurements', idPrefix: null },
  { path: ['weekly_reviews'], key: 'week_start', dateField: 'week_start', label: 'Weekly review', idPrefix: null },
  { path: ['arm', 'appointments'], key: 'id', dateField: 'date', label: 'Appointment', idPrefix: 'a' },
  { path: ['arm', 'logs'], key: 'date', dateField: 'date', label: 'Arm log', idPrefix: null },
  { path: ['arm', 'physio_exercises'], key: 'id', dateField: null, label: 'Physio exercise', idPrefix: 'p' },
];
const COLL = new Map(DATA_COLLECTIONS.map((c) => [c.path.join('.'), c]));
const collAt = (path) => (path.length <= 2 ? COLL.get(path.join('.')) : undefined);
const ID_COLLECTIONS = DATA_COLLECTIONS.filter((c) => c.key === 'id');

const PROFILE_DEFAULTS = () => ({
  name: '', sex: null, birth_year: null, height_cm: null, injured_arm: null, dominant_hand: null, injury_date: null,
  program_start: null, activity_factor: 1.55, surplus_kcal: 300, protein_g_per_kg: 1.8,
  hrmax_override: null, rhr_baseline: null, diet_notes: '',
  // Round 3 (SPEC 5.2 / 5.8): fasting overlay, resting-HR method changes, kit missing at the gym.
  fasting_periods: [], rhr_method_changes: [], unavailable_exercises: [...UNAVAILABLE_DEFAULT],
});
/** Round 3 profile lists: [field, item check, default]. */
const PROFILE_LISTS = [
  ['unavailable_exercises', (x) => typeof x === 'string' && !!x.trim(), () => [...UNAVAILABLE_DEFAULT]],
  ['fasting_periods', (x) => isObj(x), () => []],
  ['rhr_method_changes', (x) => typeof x === 'string' || (isObj(x) && typeof x.date === 'string'), () => []],
];
const CLEARANCE_KEYS = ['good_arm_ok', 'clinic_light', 'grip_cleared', 'full_clearance'];

const RECORD_DEFAULTS = {
  checkins: () => ({ date: null, weight_kg: null, rhr: null, hrv: null, sleep_h: null, sleep_q: null, energy: null, soreness: null, mood: null, stress: null, arm_pain: null, arm_flags: [], steps: null, protein_g: null, calories: null, water_l: null, creatine: false, notes: '' }),
  workouts: () => ({ id: null, date: null, session_id: null, phase_id: null, phase_week: null, duration_min: null, rpe: null, notes: '', exercises: [], cardio: [] }),
  hikes: () => ({ id: null, date: null, name: '', distance_km: null, ascent_m: null, duration_min: null, pack_kg: 0, terrain: '', avg_hr: null, rpe: null, ladder_level: null, notes: '' }),
  tests: () => ({ id: null, date: null, test: null, value: null, notes: '' }),
  measurements: () => ({ date: null, waist_cm: null, chest_cm: null, hips_cm: null, thigh_cm: null, calf_cm: null, arm_good_cm: null, arm_injured_cm: null, forearm_good_cm: null, forearm_injured_cm: null }),
  weekly_reviews: () => ({ week_start: null, wins: '', struggles: '', next_focus: '', adherence_pct: null }),
  'arm.appointments': () => ({ id: null, date: null, type: '', notes: '', outcome: '' }),
  'arm.logs': () => ({ date: null, values: {}, notes: '' }),
  'arm.physio_exercises': () => ({ id: null, exercise: '', dose: '', since: '', notes: '' }),
};
const EXERCISE_DEFAULTS = () => ({ exercise: null, sets: [], notes: '' });
const SET_DEFAULTS = () => ({ kg: null, reps: null, seconds: null, rir: null, done: true });
const CARDIO_DEFAULTS = () => ({ exercise: null, minutes: null, zone: '', avg_hr: null, distance_km: null, ascent_m: null, level: null, notes: '' });

const NUMERIC = {
  profile: ['birth_year', 'height_cm', 'activity_factor', 'surplus_kcal', 'protein_g_per_kg', 'hrmax_override', 'rhr_baseline', 'pre_injury_weight_kg'],
  checkins: ['weight_kg', 'rhr', 'hrv', 'sleep_h', 'sleep_q', 'energy', 'soreness', 'mood', 'stress', 'arm_pain', 'steps', 'protein_g', 'calories', 'water_l'],
  workouts: ['phase_week', 'duration_min', 'rpe'],
  hikes: ['distance_km', 'ascent_m', 'duration_min', 'pack_kg', 'avg_hr', 'rpe', 'ladder_level'],
  tests: ['value'],
  measurements: ['waist_cm', 'chest_cm', 'hips_cm', 'thigh_cm', 'calf_cm', 'arm_good_cm', 'arm_injured_cm', 'forearm_good_cm', 'forearm_injured_cm'],
  weekly_reviews: ['adherence_pct'],
  set: ['kg', 'reps', 'seconds', 'rir'],
  cardio: ['minutes', 'avg_hr', 'distance_km', 'ascent_m', 'level', 'rounds'],
};
const BOOLEAN = { checkins: ['creatine'], set: ['done'] };
const EXTRA_DATES = { 'arm.physio_exercises': ['since'] };

const NUM_RE = /^\s*[-+]?(\d+(\.\d*)?|\.\d+)\s*$/;

function coerceNumber(v) {
  if (typeof v === 'string') {
    if (!v.trim()) return null;
    if (NUM_RE.test(v)) return Number(v);
  }
  return v;
}

function coerceBoolean(v) {
  if (typeof v === 'string') {
    const s = v.trim().toLowerCase();
    if (s === 'true' || s === 'yes') return true;
    if (s === 'false' || s === 'no' || s === '') return false;
  }
  return v;
}

/** Tidy a date string: trims, 2025-01-31T07:00 -> 2025-01-31, 2025-1-5 / 2025/01/05 -> 2025-01-05. */
export function coerceDate(v) {
  if (typeof v !== 'string') return v;
  const s = v.trim();
  if (isISODate(s)) return s;
  if (/^\d{4}-\d{2}-\d{2}[T ]/.test(s) && isISODate(s.slice(0, 10))) return s.slice(0, 10);
  const m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/.exec(s);
  if (m) {
    const d = `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
    if (isISODate(d)) return d;
  }
  return s === v ? v : s;
}

function fillDefaults(rec, defaults) {
  for (const [k, v] of Object.entries(defaults)) if (!own(rec, k) || rec[k] === undefined) setKey(rec, k, v);
  return rec;
}

// ====================================================================== migrations

function legacyId(prefix, rec, occ) {
  const { id: _ignored, ...rest } = rec;
  const h = hashValue(rest).slice(0, 12);
  const n = (occ.get(h) || 0) + 1;
  occ.set(h, n);
  return `${prefix}-${h}${n > 1 ? `-${n}` : ''}`;
}

/** Give every record a unique id; legacy records get a deterministic one from their content. */
function normaliseIds(arr, prefix) {
  const seen = new Set();
  const occ = new Map();
  for (const r of arr) {
    let id = typeof r.id === 'string' && r.id.trim() ? r.id : typeof r.id === 'number' && Number.isFinite(r.id) ? String(r.id) : null;
    if (!id) id = legacyId(prefix, r, occ);
    let unique = id;
    for (let n = 2; seen.has(unique); n++) unique = `${id}~${n}`;
    seen.add(unique);
    if (r.id !== unique) r.id = unique;
  }
}

function tidyRecord(rec, kind, note, where) {
  for (const k of NUMERIC[kind] || []) {
    if (!own(rec, k)) continue;
    const v = coerceNumber(rec[k]);
    if (v !== rec[k]) { note(`${where}.${k}`, `"${rec[k]}" stored as ${v === null ? 'empty' : `the number ${v}`}.`); rec[k] = v; }
  }
  for (const k of BOOLEAN[kind] || []) {
    if (!own(rec, k)) continue;
    const v = coerceBoolean(rec[k]);
    if (v !== rec[k]) { note(`${where}.${k}`, `"${rec[k]}" stored as ${v}.`); rec[k] = v; }
  }
}

function tidyDate(obj, k, note, where) {
  if (!own(obj, k) || typeof obj[k] !== 'string') return;
  const v = coerceDate(obj[k]);
  if (v !== obj[k]) { note(`${where}.${k}`, `"${obj[k]}" stored as ${v}.`); obj[k] = v; }
}

/**
 * Ordered upgrade steps. Each one is idempotent: running it on already-upgraded data changes
 * nothing. migrate() runs the steps newer than the file's schema_version, then normaliseShape().
 */
export const MIGRATIONS = [
  {
    to: 2,
    title: 'v1 to v2',
    description: 'Numbers typed as text become numbers, dates are tidied to YYYY-MM-DD, sex is lower-cased, '
      + 'a red flag stored as a bare string becomes a list, and tests, appointments and physio exercises get stable ids '
      + '(added by normaliseShape so any version gets them).',
    up(doc, { note }) {
      if (isObj(doc.profile)) {
        const p = doc.profile;
        tidyRecord(p, 'profile', note, 'profile');
        tidyDate(p, 'program_start', note, 'profile');
        if (typeof p.sex === 'string') {
          const s = p.sex.trim().toLowerCase();
          const v = s === 'm' ? 'male' : s === 'f' ? 'female' : s === '' ? null : s;
          if (v !== p.sex) { note('profile.sex', `"${p.sex}" stored as ${v === null ? 'empty' : v}.`); p.sex = v; }
        }
        for (const k of ['injured_arm', 'dominant_hand']) {
          if (typeof p[k] === 'string') {
            const v = p[k].trim().toLowerCase() || null;
            if (v !== p[k]) p[k] = v;
          }
        }
        if (isObj(p.clearances)) for (const k of Object.keys(p.clearances)) {
          if (p.clearances[k] === '') p.clearances[k] = null;
          tidyDate(p.clearances, k, note, 'profile.clearances');
        }
      }
      for (const c of DATA_COLLECTIONS) {
        const arr = getAt(doc, c.path);
        if (!Array.isArray(arr)) continue;
        const name = c.path.join('.');
        arr.forEach((rec, i) => {
          if (!isObj(rec)) return;
          const where = `${name}[${i}]`;
          tidyRecord(rec, name, note, where);
          if (c.dateField) tidyDate(rec, c.dateField, note, where);
          for (const k of EXTRA_DATES[name] || []) tidyDate(rec, k, note, where);
          if (name === 'checkins' && typeof rec.arm_flags === 'string') {
            note(`${where}.arm_flags`, 'a single red flag stored as text was turned into a list.');
            rec.arm_flags = rec.arm_flags.trim() ? [rec.arm_flags.trim()] : [];
          }
          if (name === 'workouts') {
            (Array.isArray(rec.exercises) ? rec.exercises : []).forEach((e, ei) => {
              if (isObj(e)) (Array.isArray(e.sets) ? e.sets : []).forEach((s, si) => { if (isObj(s)) tidyRecord(s, 'set', note, `${where}.exercises[${ei}].sets[${si}]`); });
            });
            (Array.isArray(rec.cardio) ? rec.cardio : []).forEach((x, ci) => { if (isObj(x)) tidyRecord(x, 'cardio', note, `${where}.cardio[${ci}]`); });
          }
          if (name === 'arm.logs' && isObj(rec.values)) {
            for (const k of Object.keys(rec.values)) rec.values[k] = coerceNumber(rec.values[k]);
          }
        });
      }
    },
  },
];

/**
 * Structural guarantees for every version (idempotent): containers exist, records are objects
 * (anything else moves to `quarantine` rather than being dropped), missing SPEC 5.7 fields get
 * their defaults, nested workout lists are lists, and id-keyed records have unique ids.
 */
function normaliseShape(doc, { note }) {
  const quarantine = Array.isArray(doc.quarantine) ? doc.quarantine : [];
  const hold = (from, value) => { quarantine.push({ from, value }); note(from, 'was not in the expected shape, so it was set aside in "quarantine" (nothing was deleted).'); };

  if (own(doc, 'profile') && !isObj(doc.profile) && doc.profile !== undefined) { hold('profile', doc.profile); doc.profile = {}; }
  doc.profile = fillDefaults(isObj(doc.profile) ? doc.profile : {}, PROFILE_DEFAULTS());
  const p = doc.profile;
  for (const [k, ok, dflt] of PROFILE_LISTS) {
    if (!Array.isArray(p[k])) { if (p[k] !== null && p[k] !== undefined) hold(`profile.${k}`, p[k]); p[k] = dflt(); continue; }
    if (!p[k].every(ok)) { p[k].filter((x) => !ok(x)).forEach((x) => hold(`profile.${k}[]`, x)); p[k] = p[k].filter(ok); }
  }
  for (const f of p.fasting_periods) for (const k of ['start', 'end']) tidyDate(f, k, note, 'profile.fasting_periods[]');
  tidyDate(p, 'injury_date', note, 'profile'); // optional (added after v2), so tidied for every version
  p.rhr_method_changes.forEach((x, i) => {
    if (typeof x === 'string') { const v = coerceDate(x); if (v !== x) p.rhr_method_changes[i] = v; } else tidyDate(x, 'date', note, 'profile.rhr_method_changes[]');
  });
  if (own(p, 'clearances') && !isObj(p.clearances) && p.clearances !== undefined && p.clearances !== null) { hold('profile.clearances', p.clearances); }
  p.clearances = isObj(p.clearances) ? p.clearances : {};
  for (const k of CLEARANCE_KEYS) if (!own(p.clearances, k) || p.clearances[k] === undefined) p.clearances[k] = null;

  if (own(doc, 'arm') && doc.arm !== undefined && !isObj(doc.arm)) { hold('arm', doc.arm); doc.arm = {}; }
  const armWasMissing = !isObj(doc.arm);
  doc.arm = isObj(doc.arm) ? doc.arm : {};
  if (!own(doc.arm, 'appointments') || doc.arm.appointments === undefined || (armWasMissing && !Array.isArray(doc.arm.appointments))) {
    doc.arm.appointments = [];
  }

  for (const c of DATA_COLLECTIONS) {
    const name = c.path.join('.');
    const parent = c.path.length === 1 ? doc : doc.arm;
    const last = c.path[c.path.length - 1];
    let arr = parent[last];
    if (arr !== undefined && arr !== null && !Array.isArray(arr)) { hold(name, arr); arr = []; }
    if (!Array.isArray(arr)) arr = [];
    const kept = [];
    arr.forEach((rec, i) => { if (isObj(rec)) kept.push(rec); else hold(`${name}[${i}]`, rec); });
    for (const rec of kept) {
      fillDefaults(rec, RECORD_DEFAULTS[name]());
      if (name === 'checkins' && !Array.isArray(rec.arm_flags)) {
        if (typeof rec.arm_flags === 'string' && rec.arm_flags.trim()) rec.arm_flags = [rec.arm_flags.trim()];
        else { if (rec.arm_flags !== null && rec.arm_flags !== undefined) hold(`checkins[${rec.date}].arm_flags`, rec.arm_flags); rec.arm_flags = []; }
      }
      if (name === 'workouts') {
        for (const k of ['exercises', 'cardio']) {
          if (!Array.isArray(rec[k])) { if (rec[k] !== null && rec[k] !== undefined) hold(`workouts[${rec.id ?? rec.date}].${k}`, rec[k]); rec[k] = []; }
          const items = [];
          rec[k].forEach((x, xi) => { if (isObj(x)) items.push(x); else hold(`workouts[${rec.id ?? rec.date}].${k}[${xi}]`, x); });
          if (items.length !== rec[k].length) rec[k] = items;
        }
        for (const e of rec.exercises) {
          fillDefaults(e, EXERCISE_DEFAULTS());
          if (!Array.isArray(e.sets)) { if (e.sets !== null && e.sets !== undefined) hold(`workouts[${rec.id ?? rec.date}].exercises.sets`, e.sets); e.sets = []; }
          const sets = e.sets.filter(isObj);
          if (sets.length !== e.sets.length) { e.sets.filter((s) => !isObj(s)).forEach((s) => hold(`workouts[${rec.id ?? rec.date}].exercises.sets[]`, s)); e.sets = sets; }
          for (const s of e.sets) fillDefaults(s, SET_DEFAULTS());
        }
        for (const x of rec.cardio) fillDefaults(x, CARDIO_DEFAULTS());
      }
      if (name === 'arm.logs' && !isObj(rec.values)) { if (rec.values !== null && rec.values !== undefined) hold(`arm.logs[${rec.date}].values`, rec.values); rec.values = {}; }
    }
    if (c.idPrefix) normaliseIds(kept, c.idPrefix);
    parent[last] = kept;
  }
  if (own(doc.arm, 'questions') && doc.arm.questions !== undefined && doc.arm.questions !== null && !isObj(doc.arm.questions)) hold('arm.questions', doc.arm.questions);
  if (!isObj(doc.arm.questions)) doc.arm.questions = {};
  for (const k of ['hike_ladder', 'kit_owned', 'meta']) {
    if (own(doc, k) && doc[k] !== undefined && doc[k] !== null && !isObj(doc[k])) hold(k, doc[k]);
    if (!isObj(doc[k])) doc[k] = {};
  }
  if (quarantine.length) doc.quarantine = quarantine;
  return doc;
}

/**
 * Upgrade any user-data document (v1 or later, or garbage) to the current schema.
 * Pure (works on a copy unless inPlace), idempotent (migrate(migrate(x)) equals migrate(x)) and
 * deterministic (the same input always gives the same ids), so two tabs migrating the same file
 * agree on every record key. Unknown fields are kept. A file from a newer app keeps its higher
 * schema_version. report: optional array that collects {path, message} notes.
 */
export function migrate(input, { report = null, force = false, inPlace = false } = {}) {
  const note = (path, message) => { if (report) report.push({ path, message }); };
  let doc;
  if (isObj(input)) doc = inPlace ? input : cloneJSON(input);
  else {
    if (input !== undefined && input !== null) note('', 'The data was not an object, so the hub started from defaults.');
    doc = {};
  }
  let version = Number.isInteger(doc.schema_version) && doc.schema_version > 0 ? doc.schema_version : 1;
  for (const step of MIGRATIONS) {
    if (force || version < step.to) step.up(doc, { note });
    if (version < step.to) version = step.to;
  }
  normaliseShape(doc, { note });
  doc.schema_version = Math.max(version, SCHEMA_VERSION);
  return doc;
}

/** Backwards-compatible name: fill in anything missing so views can rely on the shape. */
export function normalize(input) {
  return migrate(input);
}

export function defaultData() {
  return migrate({
    schema_version: SCHEMA_VERSION,
    profile: { ...PROFILE_DEFAULTS(), clearances: { good_arm_ok: null, clinic_light: null, grip_cleared: null, full_clearance: null } },
    checkins: [], workouts: [], hikes: [], tests: [], measurements: [],
    arm: { appointments: [], logs: [], physio_exercises: [], questions: {} },
    weekly_reviews: [], hike_ladder: {}, kit_owned: {}, meta: {},
  });
}

/** Assign fresh ids to records the UI created without one (tests, appointments, physio...). */
export function ensureIds(doc, uuid = newUuid) {
  if (!isObj(doc)) return;
  for (const c of ID_COLLECTIONS) {
    const arr = getAt(doc, c.path);
    if (!Array.isArray(arr)) continue;
    for (const r of arr) {
      if (!isObj(r)) continue;
      if (typeof r.id === 'number' && Number.isFinite(r.id)) r.id = String(r.id);
      else if (!(typeof r.id === 'string' && r.id)) r.id = uuid();
    }
  }
}

// ====================================================================== import validation

const MAX_STRING = 200000;
const LONG_STRING = 20000;
const MAX_NODES = 3000000;
const MAX_DEPTH = 24;
const MAX_RECORDS = 100000;
const MAX_LISTED = 40;

function describeType(v) {
  if (v === null) return 'empty (null)';
  if (Array.isArray(v)) return 'a list';
  if (typeof v === 'object') return 'an object';
  if (typeof v === 'string') return `the text "${v.length > 40 ? `${v.slice(0, 37)}…` : v}"`;
  return `${typeof v} ${String(v)}`;
}

/**
 * Check an import thoroughly before anything changes. Returns
 * {ok, errors, warnings, errorCount, warningCount, counts, data, bytes}. Errors block the import
 * (nothing is applied); warnings are shown but the data is kept as it is. `data` is the
 * migrated document that replaceAll()/importData() would store.
 */
export function validateImportDetailed(obj, { today = todayISO(), maxBytes = MAX_DATA_BYTES } = {}) {
  const errors = [];
  const warnings = [];
  let errorCount = 0;
  let warningCount = 0;
  const err = (path, msg) => { errorCount++; if (errors.length < MAX_LISTED) errors.push({ path, message: path ? `${path}: ${msg}` : msg }); };
  const warn = (path, msg) => { warningCount++; if (warnings.length < MAX_LISTED) warnings.push({ path, message: path ? `${path}: ${msg}` : msg }); };
  const done = (data = null, bytes = 0, counts = {}) => ({ ok: errorCount === 0, errors, warnings, errorCount, warningCount, counts, data: errorCount ? null : data, bytes });

  if (!isObj(obj)) {
    err('', Array.isArray(obj) ? 'This file holds a list, but Fitness Hub data is a single JSON object ({ … }) with your profile, check-ins and sessions.'
      : 'This file is not Fitness Hub data: it should contain one JSON object ({ … }).');
    return done();
  }

  // Size, depth and string limits first: they protect everything below.
  let nodes = 0;
  const stack = [[obj, 0, '']];
  while (stack.length) {
    const [v, depth, path] = stack.pop();
    if (++nodes > MAX_NODES) { err('', 'The file has far more entries than any hub data could. Is it the right file?'); return done(); }
    if (depth > MAX_DEPTH) { err(path, `is nested more than ${MAX_DEPTH} levels deep, which hub data never is.`); return done(); }
    if (typeof v === 'string') {
      if (v.length > MAX_STRING) err(path, `has a text of ${v.length.toLocaleString('en-GB')} characters (the limit is ${MAX_STRING.toLocaleString('en-GB')}).`);
      else if (v.length > LONG_STRING) warn(path, `has a very long text (${v.length.toLocaleString('en-GB')} characters).`);
    } else if (Array.isArray(v)) {
      if (v.length > MAX_RECORDS) err(path, `has ${v.length.toLocaleString('en-GB')} entries (the limit is ${MAX_RECORDS.toLocaleString('en-GB')}).`);
      for (let i = v.length - 1; i >= 0; i--) stack.push([v[i], depth + 1, `${path}[${i}]`]);
    } else if (isObj(v)) {
      for (const k of Object.keys(v)) {
        if (k === '__proto__' || k === 'constructor' || k === 'prototype') { err(path, `contains the reserved key "${k}", which hub data never uses.`); continue; }
        stack.push([v[k], depth + 1, path ? `${path}.${k}` : k]);
      }
    } else if (typeof v === 'number' && !Number.isFinite(v)) err(path, 'is not a finite number.');
  }
  if (errorCount) return done();
  let bytes = 0;
  try { bytes = byteLength(JSON.stringify(obj)); } catch { err('', 'The file could not be read as JSON data.'); return done(); }
  if (bytes > maxBytes) {
    err('', `The data is ${(bytes / 1048576).toFixed(1)} MB, but the hub accepts up to ${(maxBytes / 1048576).toFixed(0)} MB.`);
    return done();
  }

  // schema_version
  const sv = obj.schema_version;
  if (sv === undefined) err('schema_version', 'is missing. Hub exports always have it, so this may not be a Fitness Hub file.');
  else if (!Number.isInteger(sv)) err('schema_version', `should be a whole number, not ${describeType(sv)}.`);
  else if (sv < 1) err('schema_version', `is ${sv}; the first version is 1.`);
  else if (sv > SCHEMA_VERSION) err('schema_version', `is ${sv}: the file was saved by a newer version of the hub (this one understands up to ${SCHEMA_VERSION}). Update the hub first.`);

  const numberCheck = (path, v) => {
    if (v === null || v === undefined) return;
    if (typeof v === 'number') return;
    if (typeof v === 'string') {
      if (!v.trim()) return;
      if (NUM_RE.test(v)) { warn(path, `the number is stored as text ("${v}"); it will be imported as ${Number(v)}.`); return; }
    }
    err(path, `should be a number, not ${describeType(v)}.`);
  };
  const dateCheck = (path, v, { required = false, futureOk = true } = {}) => {
    if (v === null || v === undefined || v === '') { if (required) err(path, 'is missing. Every entry needs a date like 2025-01-31.'); return; }
    if (typeof v !== 'string') { err(path, `should be a date like 2025-01-31, not ${describeType(v)}.`); return; }
    if (isISODate(v)) {
      if (!futureOk && v > addDays(today, 366)) warn(path, `${v} is more than a year in the future.`);
      return;
    }
    const fixed = coerceDate(v);
    if (isISODate(fixed)) { warn(path, `"${v}" will be imported as ${fixed}.`); return; }
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v.trim());
    if (m) err(path, `${v} is not a real calendar date${+m[2] === 2 && +m[3] === 29 ? ` (${m[1]} is not a leap year)` : ''}.`);
    else err(path, `"${v}" is not a date the hub understands. Use YYYY-MM-DD, for example 2025-01-31.`);
  };

  // profile
  const pr = obj.profile;
  if (pr !== undefined && !isObj(pr)) err('profile', `should be an object, not ${describeType(pr)}.`);
  if (isObj(pr)) {
    for (const k of NUMERIC.profile) numberCheck(`profile.${k}`, pr[k]);
    if (pr.sex !== undefined && pr.sex !== null && !(typeof pr.sex === 'string' && ['', 'male', 'female', 'm', 'f'].includes(pr.sex.trim().toLowerCase()))) {
      warn('profile.sex', `should be "male" or "female" (it is only used for the calorie formula); ${describeType(pr.sex)} will be ignored.`);
    }
    for (const k of ['injured_arm', 'dominant_hand']) {
      if (pr[k] !== undefined && pr[k] !== null && !(typeof pr[k] === 'string' && ['', 'left', 'right'].includes(pr[k].trim().toLowerCase()))) warn(`profile.${k}`, `should be "left" or "right", not ${describeType(pr[k])}.`);
    }
    dateCheck('profile.program_start', pr.program_start);
    dateCheck('profile.injury_date', pr.injury_date);
    if (isISODate(pr.program_start) && mondayOf(pr.program_start) !== pr.program_start) warn('profile.program_start', `${pr.program_start} is not a Monday; the programme will start on Monday ${mondayOf(pr.program_start)}.`);
    const ranges = { birth_year: [1900, Number(today.slice(0, 4)) - 10], height_cm: [100, 250], activity_factor: [1.2, 2], surplus_kcal: [0, 1500], protein_g_per_kg: [1, 3], hrmax_override: [100, 230], rhr_baseline: [30, 120], pre_injury_weight_kg: [30, 250] };
    for (const [k, [lo, hi]] of Object.entries(ranges)) {
      const v = coerceNumber(pr[k]);
      if (typeof v === 'number' && (v < lo || v > hi)) warn(`profile.${k}`, `${v} is outside the usual ${lo}–${hi}${k === 'surplus_kcal' && v < 0 ? ' (the hub never plans a calorie deficit while the bone heals, so it will use 0)' : ''}.`);
    }
    const ux = pr.unavailable_exercises;
    if (ux !== undefined && ux !== null) {
      if (!Array.isArray(ux)) err('profile.unavailable_exercises', `should be a list of exercise ids, not ${describeType(ux)}.`);
      else ux.forEach((x, i) => { if (!(typeof x === 'string' && x.trim())) err(`profile.unavailable_exercises[${i}]`, `should be an exercise id, not ${describeType(x)}.`); });
    }
    const fp = pr.fasting_periods;
    if (fp !== undefined && fp !== null) {
      if (!Array.isArray(fp)) err('profile.fasting_periods', `should be a list of {start, end} periods, not ${describeType(fp)}.`);
      else fp.forEach((x, i) => {
        const w = `profile.fasting_periods[${i}]`;
        if (!isObj(x)) { err(w, `should be an object like {"start": "2026-01-12", "end": "2026-01-16"}, not ${describeType(x)}.`); return; }
        dateCheck(`${w}.start`, x.start, { required: true });
        dateCheck(`${w}.end`, x.end, { required: true });
        const a = coerceDate(x.start);
        const b = coerceDate(x.end);
        if (isISODate(a) && isISODate(b) && b < a) err(w, `ends (${b}) before it starts (${a}).`);
      });
    }
    const rm = pr.rhr_method_changes;
    if (rm !== undefined && rm !== null) {
      if (!Array.isArray(rm)) err('profile.rhr_method_changes', `should be a list of dates, not ${describeType(rm)}.`);
      else rm.forEach((x, i) => {
        const w = `profile.rhr_method_changes[${i}]`;
        if (typeof x === 'string') dateCheck(w, x, { required: true });
        else if (isObj(x)) dateCheck(`${w}.date`, x.date, { required: true });
        else err(w, `should be a date like 2025-01-31, not ${describeType(x)}.`);
      });
    }
    if (pr.clearances !== undefined && pr.clearances !== null && !isObj(pr.clearances)) err('profile.clearances', `should be an object with the four clearance dates, not ${describeType(pr.clearances)}.`);
    if (isObj(pr.clearances)) {
      for (const [k, v] of Object.entries(pr.clearances)) {
        if (!CLEARANCE_KEYS.includes(k)) warn(`profile.clearances.${k}`, 'is not one of the hub’s clearance gates; it will be kept but ignored.');
        dateCheck(`profile.clearances.${k}`, v);
      }
    }
  }
  if (obj.arm !== undefined && !isObj(obj.arm)) err('arm', `should be an object, not ${describeType(obj.arm)}.`);
  for (const k of ['hike_ladder', 'kit_owned', 'meta']) if (obj[k] !== undefined && obj[k] !== null && !isObj(obj[k])) err(k, `should be an object, not ${describeType(obj[k])}.`);

  // collections
  const counts = {};
  for (const c of DATA_COLLECTIONS) {
    const name = c.path.join('.');
    const arr = getAt(obj, c.path);
    counts[name] = Array.isArray(arr) ? arr.length : 0;
    if (arr === undefined || arr === null) continue;
    if (!Array.isArray(arr)) { err(name, `should be a list ([ … ]), not ${describeType(arr)}.`); continue; }
    const seen = new Map();
    arr.forEach((rec, i) => {
      const where = `${name}[${i}]`;
      if (!isObj(rec)) { err(where, `should be an object ({ … }), not ${describeType(rec)}.`); return; }
      if (c.dateField) dateCheck(`${where}.${c.dateField}`, rec[c.dateField], { required: true, futureOk: name === 'arm.appointments' });
      if (c.dateField === 'week_start' && isISODate(rec.week_start) && mondayOf(rec.week_start) !== rec.week_start) warn(`${where}.week_start`, `${rec.week_start} is not a Monday.`);
      for (const k of EXTRA_DATES[name] || []) dateCheck(`${where}.${k}`, rec[k]);
      for (const k of NUMERIC[name] || []) numberCheck(`${where}.${k}`, rec[k]);
      if (c.key === 'id' && rec.id !== undefined && rec.id !== null && typeof rec.id !== 'string' && typeof rec.id !== 'number') err(`${where}.id`, `should be text, not ${describeType(rec.id)}.`);
      const key = c.key === 'id' ? (rec.id === undefined || rec.id === null || rec.id === '' ? null : String(rec.id)) : coerceDate(rec[c.key]);
      if (key !== null && key !== undefined) {
        if (seen.has(key)) {
          if (c.key === 'id') warn(`${where}.id`, `"${key}" is also used by ${name}[${seen.get(key)}]; this one will get a new id.`);
          else warn(where, `has the same ${c.key} (${key}) as ${name}[${seen.get(key)}]; both are kept, and the hub shows the first.`);
        } else seen.set(key, i);
      }
      if (name === 'tests' && !(typeof rec.test === 'string' && rec.test.trim())) err(`${where}.test`, 'is missing: which test is this result for?');
      if (name === 'checkins' && rec.arm_flags !== undefined && rec.arm_flags !== null) {
        if (typeof rec.arm_flags === 'string') warn(`${where}.arm_flags`, 'is text instead of a list; it will be imported as one red flag.');
        else if (!Array.isArray(rec.arm_flags) || rec.arm_flags.some((f) => typeof f !== 'string')) err(`${where}.arm_flags`, 'should be a list of red-flag ids.');
      }
      if (name === 'arm.logs' && rec.values !== undefined && rec.values !== null) {
        if (!isObj(rec.values)) err(`${where}.values`, `should be an object of measurements, not ${describeType(rec.values)}.`);
        else for (const [k, v] of Object.entries(rec.values)) numberCheck(`${where}.values.${k}`, v);
      }
      if (name === 'workouts') {
        for (const k of ['exercises', 'cardio']) {
          const list = rec[k];
          if (list === undefined || list === null) continue;
          if (!Array.isArray(list)) { err(`${where}.${k}`, `should be a list, not ${describeType(list)}.`); continue; }
          list.forEach((x, xi) => {
            const w2 = `${where}.${k}[${xi}]`;
            if (!isObj(x)) { err(w2, `should be an object, not ${describeType(x)}.`); return; }
            if (k === 'cardio') { for (const f of NUMERIC.cardio) numberCheck(`${w2}.${f}`, x[f]); return; }
            if (x.sets === undefined || x.sets === null) return;
            if (!Array.isArray(x.sets)) { err(`${w2}.sets`, `should be a list of sets, not ${describeType(x.sets)}.`); return; }
            x.sets.forEach((s, si) => {
              if (!isObj(s)) err(`${w2}.sets[${si}]`, `should be an object, not ${describeType(s)}.`);
              else for (const f of NUMERIC.set) numberCheck(`${w2}.sets[${si}].${f}`, s[f]);
            });
          });
        }
      }
    });
  }
  if (errorCount) return done(null, bytes, counts);

  const report = [];
  const data = migrate(obj, { report, force: true });
  for (const r of report) if (!/stored as|turned into a list/.test(r.message)) warn(r.path, r.message);
  try {
    for (const issue of dataIssues(data, { limit: 25 })) warn(issue.path, issue.message);
  } catch { /* plausibility hints are optional */ }
  return done(data, bytes, counts);
}

/** Backwards compatible: the blocking problems as plain strings (empty list = OK to import). */
export function validateImport(obj) {
  return validateImportDetailed(obj).errors.map((e) => e.message);
}

// ====================================================================== diff, merge, patch

/**
 * Keys for the records of one collection, aligned with arr. A duplicate natural key gets an
 * occurrence suffix ("2025-01-31", "2025-01-31\u00002") and a record without a key is matched by
 * position among the unkeyed ones, so duplicates are never merged into each other.
 */
export function recordKeys(arr, keyField) {
  const seen = new Map();
  const out = new Array(arr.length);
  for (let i = 0; i < arr.length; i++) {
    const r = arr[i];
    const k = isObj(r) && typeof r[keyField] === 'string' && r[keyField] ? r[keyField] : '\u0000';
    const n = (seen.get(k) || 0) + 1;
    seen.set(k, n);
    out[i] = n === 1 ? k : `${k}\u0000${n}`;
  }
  return out;
}

const SKIP_TOP = new Set(['meta', 'schema_version']);

/**
 * Local changes relative to a base: record-level for the DATA_COLLECTIONS
 * ({path, key, base, value}; value undefined = deleted) and leaf-level for everything else
 * (profile fields, clearances, kit_owned items, ...: {path, base, value}). meta is ignored.
 */
export function diffData(base, local) {
  const out = [];
  diffObj(isObj(base) ? base : {}, isObj(local) ? local : {}, [], out);
  return out;
}

function diffObj(b, l, path, out) {
  for (const k of unionKeys(b, l)) {
    if (!path.length && SKIP_TOP.has(k)) continue;
    const bv = b[k];
    const lv = l[k];
    if (bv === lv) continue;
    const p = [...path, k];
    const coll = collAt(p);
    if (coll) { diffCollection(Array.isArray(bv) ? bv : [], Array.isArray(lv) ? lv : [], p, coll.key, out); continue; }
    if (isObj(lv) && (isObj(bv) || bv === undefined)) { diffObj(isObj(bv) ? bv : {}, lv, p, out); continue; }
    if (!deepEqual(bv, lv)) out.push({ path: p, base: bv, value: lv });
  }
}

function diffCollection(bArr, lArr, path, keyField, out) {
  const bk = recordKeys(bArr, keyField);
  const lk = recordKeys(lArr, keyField);
  const bMap = new Map();
  bk.forEach((k, i) => bMap.set(k, bArr[i]));
  const seen = new Set();
  lk.forEach((k, i) => {
    seen.add(k);
    const lr = lArr[i];
    const br = bMap.get(k);
    if (br === undefined || !deepEqual(br, lr)) out.push({ path, key: k, base: br, value: lr });
  });
  for (const [k, br] of bMap) if (!seen.has(k)) out.push({ path, key: k, base: br, value: undefined });
}

const isBlank = (v) => v === undefined || v === null || v === '' || v === false
  || (Array.isArray(v) && v.length === 0) || (isObj(v) && Object.keys(v).length === 0);
const setLike = (a) => a.every((x) => x === null || ['string', 'number', 'boolean'].includes(typeof x)) && new Set(a).size === a.length;

function setMerge(b, l, r) {
  const B = new Set(b);
  const L = new Set(l);
  const R = new Set(r);
  const out = l.filter((x) => R.has(x) || !B.has(x));
  for (const x of r) if (!B.has(x) && !L.has(x)) out.push(x);
  return out;
}

const cleanKey = (k) => String(k).replace(/\u0000(\d+)$/, ' (#$1)').replace(/\u0000/g, '(no key)');

/** Bookkeeping timestamps (updated_at, saved_at, ...) never make a conflict (PE11). */
const isStampKey = (k) => typeof k === 'string' && /_at$/.test(k);
const EARLIEST_STAMPS = new Set(['created_at', 'started_at']);

function mergeStamp(k, b, l, r) {
  if (deepEqual(l, r)) return l;
  if (deepEqual(b, r)) return l;
  if (deepEqual(b, l)) return r;
  if (l === undefined || l === null) return r;
  if (r === undefined || r === null) return l;
  if (typeof l === 'string' && typeof r === 'string') return EARLIEST_STAMPS.has(k) ? (l < r ? l : r) : (l > r ? l : r);
  return l;
}

/**
 * Lists matched by a key instead of by position (PE11): a workout's exercises and cardio entries
 * are keyed by their stable block key (the UI's `block`, "leg-press:1": planned exercise id plus
 * occurrence) or, for older logs with positional keys ("b0", "b1") or none, by exercise id plus
 * occurrence ("leg-press#1"). A reordered or swapped exercise never gets another one's sets.
 */
function keyedListFor(path) {
  return path.length === 3 && path[0] === 'workouts' && (path[2] === 'exercises' || path[2] === 'cardio');
}

const POSITIONAL_BLOCK = /^b\d+$/;

export function entryKeys(list) {
  const seen = new Map();
  return list.map((x) => {
    const stable = isObj(x) && typeof x.block === 'string' && x.block && !POSITIONAL_BLOCK.test(x.block) ? `@${x.block}` : null;
    const id = stable || (isObj(x) && typeof x.exercise === 'string' && x.exercise ? x.exercise : '?');
    const n = (seen.get(id) || 0) + 1;
    seen.set(id, n);
    return stable ? (n === 1 ? id : `${id}#${n}`) : `${id}#${n}`;
  });
}

function mergeKeyedList(ba, l, r, path, ctx) {
  const bk = entryKeys(ba);
  const lk = entryKeys(l);
  const rk = entryKeys(r);
  const bm = new Map(bk.map((k, i) => [k, ba[i]]));
  const rm = new Map(rk.map((k, i) => [k, r[i]]));
  const out = [];
  const seen = new Set();
  lk.forEach((k, i) => {
    seen.add(k);
    const v = merge3(bm.get(k), l[i], rm.get(k), [...path, k], ctx);
    if (v !== undefined) out.push(v);
  });
  rk.forEach((k, i) => {
    if (seen.has(k)) return;
    seen.add(k);
    const v = merge3(bm.get(k), undefined, r[i], [...path, k], ctx);
    if (v !== undefined) out.push(v);
  });
  return out;
}

/** {collection, key, field, label} for a merge path, for conflict lists in the UI. */
export function describePath(path) {
  const p = path.map(String);
  let coll = null;
  let key = null;
  let field = [];
  if (p.length >= 2 && COLL.has(`${p[0]}.${p[1]}`)) { coll = COLL.get(`${p[0]}.${p[1]}`); key = p[2] ?? null; field = p.slice(3); }
  else if (COLL.has(p[0])) { coll = COLL.get(p[0]); key = p[1] ?? null; field = p.slice(2); }
  const f = field.join('.');
  if (coll) {
    const k = key === null ? '' : ` ${cleanKey(key)}`;
    return { collection: coll.path.join('.'), key: key === null ? null : cleanKey(key), field: f || null, label: `${coll.label}${k}${f ? ` · ${f}` : ''}` };
  }
  const area = p[0] === 'profile' ? 'Profile' : p[0] === 'kit_owned' ? 'Kit list' : p[0] === 'hike_ladder' ? 'Hike ladder' : p[0];
  const rest = p.slice(1).join('.');
  return { collection: null, key: null, field: rest || null, label: `${area}${rest ? ` · ${rest}` : ''}` };
}

function mergeCtx(choices, defaultChoice) {
  const ctx = { conflicts: [], notes: [] };
  const valid = (c) => (c === 'mine' || c === 'theirs' ? c : null);
  ctx.conflict = (path, b, l, r) => {
    const id = path.map(String).join(' › ');
    const pick = valid(choices && choices[id]) || valid(defaultChoice);
    ctx.conflicts.push({ id, path: path.map(String), ...describePath(path), base: b, mine: l, theirs: r, resolvedAs: pick });
    return pick === 'theirs' ? r : l;
  };
  ctx.note = (type, path, message) => ctx.notes.push({ type, path: path.map(String), ...describePath(path), message });
  return ctx;
}

/**
 * Three-way merge of one value. b = base (or only its hash bh when it came from localStorage;
 * bh === null means "absent in the base"), l = local, r = remote.
 */
function merge3(b, l, r, path, ctx, bh) {
  if (deepEqual(l, r)) return l;
  const hashed = bh !== undefined;
  const baseAbsent = hashed ? bh === null : b === undefined;
  const eqBase = (v) => (hashed ? (v === undefined ? bh === null : bh !== null && hashValue(v) === bh) : deepEqual(b, v));
  if (eqBase(r)) return l; // only this side changed
  if (eqBase(l)) return r; // only the other side changed
  // Both sides changed, differently. Deleted on one side + edited on the other: keep the edit.
  if (l === undefined) { ctx.note('kept-theirs', path, 'Deleted in this tab but changed elsewhere, so the changed version was kept.'); return r; }
  if (r === undefined) { ctx.note('kept-mine', path, 'Deleted elsewhere but changed in this tab, so your version was kept.'); return l; }
  const baseKnown = !hashed || baseAbsent;
  const bv = hashed ? undefined : b;
  if (baseKnown && isObj(l) && isObj(r) && (bv === undefined || bv === null || isObj(bv))) {
    const bo = isObj(bv) ? bv : {};
    const out = {};
    for (const k of unionKeys(bo, l, r)) {
      const v = isStampKey(k) ? mergeStamp(k, bo[k], l[k], r[k]) : merge3(bo[k], l[k], r[k], [...path, k], ctx);
      if (v !== undefined) setKey(out, k, v);
    }
    return out;
  }
  if (baseAbsent) { // added on both sides: an empty value never beats a real one
    if (isBlank(l)) return r;
    if (isBlank(r)) return l;
  }
  if (baseKnown && Array.isArray(l) && Array.isArray(r)) {
    const ba = Array.isArray(bv) ? bv : bv === undefined || bv === null ? [] : null;
    if (ba && setLike(l) && setLike(r) && setLike(ba)) return setMerge(ba, l, r);
    if (ba && keyedListFor(path) && l.every(isObj) && r.every(isObj) && ba.every(isObj)) return mergeKeyedList(ba, l, r, path, ctx);
    if (ba && ba.length === l.length && l.length === r.length && l.every(isObj) && r.every(isObj) && ba.every(isObj)) {
      return l.map((x, i) => { const v = merge3(ba[i], x, r[i], [...path, i], ctx); return v === undefined ? null : v; });
    }
  }
  return ctx.conflict(path, hashed ? undefined : b, l, r);
}

/**
 * Apply changes (from diffData, or expanded from localStorage) on top of target, in place,
 * with three-way conflict detection. Returns {conflicts, notes}. Conflicts use choices[id] or
 * defaultChoice ('mine' | 'theirs'); unresolved ones keep the local value as a placeholder.
 */
export function applyChanges(target, changes, { choices = null, defaultChoice = null } = {}) {
  const ctx = mergeCtx(choices, defaultChoice);
  const groups = new Map();
  for (const c of changes) {
    if (c.key !== undefined) {
      const id = c.path.join('.');
      if (!COLL.has(id)) continue;
      if (!groups.has(id)) groups.set(id, { path: c.path, list: [] });
      groups.get(id).list.push(c);
    } else {
      const parent = ensureParent(target, c.path.slice(0, -1));
      const k = c.path[c.path.length - 1];
      const r = parent[k];
      const v = merge3(c.base, c.value, r, c.path, ctx);
      if (v === undefined) delete parent[k];
      else if (v !== r) setKey(parent, k, cloneJSON(v));
    }
  }
  for (const { path, list } of groups.values()) {
    const parent = ensureParent(target, path.slice(0, -1));
    const last = path[path.length - 1];
    if (!Array.isArray(parent[last])) setKey(parent, last, []);
    const arr = parent[last];
    const keys = recordKeys(arr, COLL.get(path.join('.')).key);
    const index = new Map(keys.map((k, i) => [k, i]));
    const remove = new Set();
    for (const c of list) {
      const i = index.get(c.key);
      const r = i === undefined ? undefined : arr[i];
      const v = merge3(c.base, c.value, r, [...path, c.key], ctx, c.baseHash);
      if (v === undefined) { if (i !== undefined) remove.add(i); }
      else if (i !== undefined) { if (v !== r) arr[i] = cloneJSON(v); }
      else { arr.push(cloneJSON(v)); index.set(c.key, arr.length - 1); }
    }
    if (remove.size) {
      const kept = arr.filter((_, i) => !remove.has(i));
      arr.length = 0;
      arr.push(...kept);
    }
  }
  return ctx;
}

/**
 * Three-way merge of whole documents: the remote copy plus every local change since base.
 * Returns {result, conflicts, notes, localChanges}. Never mutates its inputs.
 */
export function mergeData(base, local, remote, { changes = null, choices = null, defaultChoice = null } = {}) {
  const ch = changes || diffData(base, local);
  const result = cloneJSON(isObj(remote) ? remote : {});
  const ctx = applyChanges(result, ch, { choices, defaultChoice });
  if (isObj(local?.meta)) result.meta = cloneJSON(local.meta);
  const versions = [base, local, remote].map((d) => (Number.isInteger(d?.schema_version) ? d.schema_version : 0));
  result.schema_version = Math.max(SCHEMA_VERSION, ...versions);
  return { result, conflicts: ctx.conflicts, notes: ctx.notes, localChanges: ch.length };
}

/**
 * Make target deep-equal to source while keeping object identities wherever the record (by
 * key) or the position (inside a record) still matches. Returns the number of changes made.
 */
export function patchInPlace(target, source, path = []) {
  let n = 0;
  for (const k of Object.keys(target)) {
    if (!own(source, k) || source[k] === undefined) { delete target[k]; n++; }
  }
  for (const k of Object.keys(source)) {
    const s = source[k];
    if (s === undefined) continue;
    const t = target[k];
    const p = [...path, k];
    const coll = collAt(p);
    if (coll && Array.isArray(t) && Array.isArray(s)) n += patchCollection(t, s, coll.key, p);
    else if (isObj(t) && isObj(s)) n += patchInPlace(t, s, p);
    else if (Array.isArray(t) && Array.isArray(s)) n += patchArray(t, s, p);
    else if (!deepEqual(t, s)) { setKey(target, k, cloneJSON(s)); n++; }
  }
  return n;
}

function patchCollection(tArr, sArr, keyField, path) {
  const byKey = new Map();
  recordKeys(tArr, keyField).forEach((k, i) => byKey.set(k, tArr[i]));
  let n = 0;
  const out = recordKeys(sArr, keyField).map((k, i) => {
    const t = byKey.get(k);
    const s = sArr[i];
    if (isObj(t) && isObj(s)) { n += patchInPlace(t, s, [...path, k]); return t; }
    n++;
    return cloneJSON(s);
  });
  if (out.length !== tArr.length || out.some((x, i) => x !== tArr[i])) {
    tArr.length = 0;
    tArr.push(...out);
    n++;
  }
  return n;
}

function patchArray(tArr, sArr, path) {
  let n = 0;
  for (let i = 0; i < sArr.length; i++) {
    if (i < tArr.length && isObj(tArr[i]) && isObj(sArr[i])) n += patchInPlace(tArr[i], sArr[i], [...path, i]);
    else if (i < tArr.length && Array.isArray(tArr[i]) && Array.isArray(sArr[i])) n += patchArray(tArr[i], sArr[i], [...path, i]);
    else if (i >= tArr.length || !deepEqual(tArr[i], sArr[i])) { tArr[i] = cloneJSON(sArr[i]); n++; }
  }
  if (tArr.length > sArr.length) { tArr.length = sArr.length; n++; }
  return n;
}

// Pending deltas in localStorage. Records carry their full base (so recovery can still merge
// field by field) plus its hash; when storage is tight, withBase=false keeps only the hash.
function compactChanges(changes, { withBase = true } = {}) {
  return changes.map((c) => {
    if (c.key !== undefined) {
      const o = { p: c.path, k: c.key, bh: c.base === undefined ? null : hashValue(c.base) };
      if (withBase && c.base !== undefined) o.b = c.base;
      if (c.value !== undefined) o.v = c.value;
      return o;
    }
    const o = { p: c.path };
    if (c.base !== undefined) o.b = c.base;
    if (c.value !== undefined) o.v = c.value;
    return o;
  });
}

function expandChanges(list) {
  return (Array.isArray(list) ? list : [])
    .filter((c) => isObj(c) && Array.isArray(c.p) && c.p.length && c.p.every((x) => typeof x === 'string' || typeof x === 'number'))
    .filter((c) => !('k' in c) || COLL.has(c.p.join('.')))
    .map((c) => {
      if (!('k' in c)) return { path: c.p.map(String), base: c.b, value: c.v };
      const rec = { path: c.p.map(String), key: String(c.k), value: c.v };
      if ('b' in c) rec.base = c.b; // full base: three-way merge field by field
      else if (c.bh === null || c.bh === undefined) rec.base = undefined; // absent in the base
      else rec.baseHash = String(c.bh); // hash only: record-level three-way merge
      return rec;
    });
}

// ====================================================================== recovery (PE1)

/** Content keys that match an id-less v1 record to its migrated twin (ids were added in v2). */
const NATURAL_KEYS = {
  tests: (r) => `${coerceDate(r.date)}|${r.test}`,
  'arm.appointments': (r) => `${coerceDate(r.date)}|${String(r.type || '').trim().toLowerCase()}`,
  'arm.physio_exercises': (r) => String(r.exercise || '').trim().toLowerCase(),
  workouts: (r) => `${coerceDate(r.date)}|${r.session_id}`,
  hikes: (r) => `${coerceDate(r.date)}|${String(r.name || '').trim().toLowerCase()}`,
};
const COLLECTION_TOPS = new Set(DATA_COLLECTIONS.filter((c) => c.path.length === 1).map((c) => c.path[0]));
const isClearancePath = (p) => p.length >= 2 && p[0] === 'profile' && p[1] === 'clearances';
const RESERVED = new Set(['__proto__', 'constructor', 'prototype']);

/** Tidy one v1 record the way the v1 -> v2 migration would (types and dates), without adding defaults. */
function tidyLegacy(rec, name) {
  const r = cloneJSON(rec);
  const no = () => {};
  tidyRecord(r, name, no, '');
  const c = COLL.get(name);
  if (c && c.dateField) tidyDate(r, c.dateField, no, '');
  for (const k of EXTRA_DATES[name] || []) tidyDate(r, k, no, '');
  if (name === 'checkins' && typeof r.arm_flags === 'string') r.arm_flags = r.arm_flags.trim() ? [r.arm_flags.trim()] : [];
  if (name === 'workouts') {
    (Array.isArray(r.exercises) ? r.exercises : []).forEach((e) => { if (isObj(e)) (Array.isArray(e.sets) ? e.sets : []).forEach((x) => { if (isObj(x)) tidyRecord(x, 'set', no, ''); }); });
    (Array.isArray(r.cardio) ? r.cardio : []).forEach((x) => { if (isObj(x)) tidyRecord(x, 'cardio', no, ''); });
  }
  if (name === 'arm.logs' && isObj(r.values)) for (const k of Object.keys(r.values)) r.values[k] = coerceNumber(r.values[k]);
  if (typeof r.id === 'number' && Number.isFinite(r.id)) r.id = String(r.id);
  return r;
}

function nestAt(path, value) {
  const doc = { schema_version: 1 };
  if (path.length === 1) doc[path[0]] = value;
  else doc[path[0]] = { [path[1]]: value };
  return doc;
}

/**
 * Apply an old v1 browser copy ({at, data} under fitness-hub:pending) onto target, in place, the
 * safe way (PE1): it has no base, so it may only ADD records the target doesn't have and FILL
 * fields that are empty in the target. It never overwrites a value: every field where the old
 * copy differs is returned as a conflict kept as the target's value ({resolvedAs: 'theirs',
 * source: 'legacy'}), for the conflict log. Clearance dates are never filled from an old copy
 * (that could unlock exercises); they are reported instead. Returns {conflicts, notes}.
 */
export function legacyFill(target, raw) {
  const conflicts = [];
  const notes = [];
  if (!isObj(target) || !isObj(raw)) return { conflicts, notes };
  const conflict = (path, mine, theirs) => {
    const ps = path.map(String);
    conflicts.push({ id: ps.join(' › '), path: ps, ...describePath(ps), base: undefined, mine, theirs, resolvedAs: 'theirs', source: 'legacy' });
  };
  const fill = (t, src, path, skip = null) => {
    for (const k of Object.keys(src)) {
      if (RESERVED.has(k) || (skip && skip(k))) continue;
      const pk = [...path, k];
      const sv = src[k];
      if (sv === undefined || isBlank(sv)) continue;
      const tv = t[k];
      if (isBlank(tv)) {
        if (isClearancePath(pk)) { conflict(pk, sv, tv === undefined ? null : tv); continue; }
        setKey(t, k, cloneJSON(sv));
        continue;
      }
      if (isObj(tv) && isObj(sv)) { fill(tv, sv, pk); continue; }
      if (!deepEqual(tv, sv)) conflict(pk, sv, tv);
    }
  };
  for (const c of DATA_COLLECTIONS) {
    const name = c.path.join('.');
    const src = getAt(raw, c.path);
    if (!Array.isArray(src) || !src.length) continue;
    const recs = src.filter(isObj).map((r) => tidyLegacy(r, name));
    if (!recs.length) continue;
    const parent = ensureParent(target, c.path.slice(0, -1));
    const last = c.path[c.path.length - 1];
    if (!Array.isArray(parent[last])) setKey(parent, last, []);
    const arr = parent[last];
    const keys = recordKeys(arr, c.key);
    const byKey = new Map(keys.map((k, i) => [k, i]));
    const nat = NATURAL_KEYS[name];
    const byNat = new Map();
    if (nat) arr.forEach((r, i) => { if (isObj(r)) { const k = nat(r); if (!byNat.has(k)) byNat.set(k, i); } });
    const rk = recordKeys(recs, c.key);
    recs.forEach((rec, i) => {
      const keyed = typeof rec[c.key] === 'string' && rec[c.key] !== '';
      let j = keyed ? byKey.get(rk[i]) : undefined;
      if (j === undefined && !keyed && nat) j = byNat.get(nat(rec));
      if (j === undefined && !keyed && c.key !== 'id') return; // a dated record without a date can't be placed
      if (j === undefined) {
        const added = getAt(migrate(nestAt(c.path, [rec])), c.path)[0];
        if (!added) return;
        const dup = c.key === 'id' ? arr.findIndex((x) => isObj(x) && x.id === added.id) : -1;
        if (dup < 0) {
          arr.push(added);
          const ap = [...c.path, c.key === 'id' ? added.id : rk[i]];
          notes.push({ type: 'legacy-added', path: ap.map(String), ...describePath(ap), message: 'Added from an older copy kept in this browser.' });
          return;
        }
        j = dup;
      }
      fill(arr[j], rec, [...c.path, keys[j] ?? recordKeys(arr, c.key)[j]], (k) => k === c.key || k === 'id');
    });
  }
  for (const k of Object.keys(raw)) {
    if (RESERVED.has(k) || COLLECTION_TOPS.has(k) || k === 'meta' || k === 'schema_version' || k === 'quarantine') continue;
    const sv = raw[k];
    if (k === 'arm') {
      if (!isObj(sv)) continue;
      if (!isObj(target.arm)) target.arm = {};
      fill(target.arm, sv, ['arm'], (x) => x === 'appointments' || x === 'logs' || x === 'physio_exercises');
      continue;
    }
    if (k === 'profile') {
      if (!isObj(sv)) continue;
      const pr = cloneJSON(sv);
      tidyRecord(pr, 'profile', () => {}, '');
      tidyDate(pr, 'program_start', () => {}, '');
      tidyDate(pr, 'injury_date', () => {}, '');
      if (typeof pr.sex === 'string') { const x = pr.sex.trim().toLowerCase(); pr.sex = x === 'm' ? 'male' : x === 'f' ? 'female' : x || null; }
      if (isObj(pr.clearances)) for (const ck of Object.keys(pr.clearances)) tidyDate(pr.clearances, ck, () => {}, '');
      if (!isObj(target.profile)) target.profile = {};
      fill(target.profile, pr, ['profile']);
      continue;
    }
    fill(target, { [k]: sv }, []);
  }
  return { conflicts, notes };
}

/**
 * Re-apply recovered sources onto target (the live data), in place. v2 sources are deltas with
 * their own base, merged three-way field by field (applyChanges), so a value changed elsewhere
 * since the delta was written is a conflict, never silently overwritten; legacy sources use
 * legacyFill. Returns {conflicts (v2, latest source wins per id), legacyConflicts, notes}.
 */
export function applyRecovery(target, sources, { choices = null, defaultChoice = null } = {}) {
  const conflicts = new Map();
  const legacyConflicts = [];
  const notes = [];
  for (const src of Array.isArray(sources) ? sources : []) {
    if (!src) continue;
    if (src.legacy) {
      const r = legacyFill(target, src.data);
      legacyConflicts.push(...r.conflicts);
      notes.push(...r.notes);
      continue;
    }
    const ctx = applyChanges(target, expandChanges(src.changes), { choices, defaultChoice });
    for (const c of ctx.conflicts) conflicts.set(c.id, { ...c, source: 'recovery' });
    notes.push(...ctx.notes);
  }
  return { conflicts: [...conflicts.values()], legacyConflicts, notes };
}

/** Drop log entries older than `days` (entries without a readable date are kept). */
function expireLog(log, days, now) {
  if (!days) return log;
  const cutoff = now - days * 86400000;
  return log.filter((e) => { const t = Date.parse(isObj(e) ? e.at : ''); return !Number.isFinite(t) || t >= cutoff; });
}

const preview = (v) => { try { const t = JSON.stringify(v); return t === undefined ? v : t.length > 2000 ? `${t.slice(0, 2000)}…` : v; } catch { return null; } };

// ====================================================================== browser plumbing

function browserStorage(name) {
  try {
    const s = globalThis[name];
    if (!s || typeof s.getItem !== 'function') return null;
    return {
      get: (k) => { try { return s.getItem(k); } catch { return null; } },
      set: (k, v) => { try { s.setItem(k, v); return true; } catch { return false; } },
      remove: (k) => { try { s.removeItem(k); } catch { /* ignore */ } },
      keys: () => { try { const out = []; for (let i = 0; i < s.length; i++) out.push(s.key(i)); return out.filter((k) => typeof k === 'string'); } catch { return []; } },
    };
  } catch { return null; }
}

function readJSON(text) {
  if (typeof text !== 'string' || !text) return null;
  try { return JSON.parse(text); } catch { return null; }
}

function friendlyError(err) {
  const e = err instanceof Error ? err : new Error(String(err));
  const st = e.status;
  let msg = e.message;
  if (st === 0 && e.timeout) msg = 'The hub took too long to answer. Your changes are kept in this browser and will be sent when it answers.';
  else if (st === 0) msg = 'Can’t reach the hub. Your changes are kept in this browser and will be sent when it is back.';
  else if (st === 413) msg = 'Your data is larger than the hub accepts (10 MB). Nothing was lost: export a copy from Settings.';
  else if (st === 403) msg = `The hub refused the save (${e.message}). Open the hub at the address it printed when it started.`;
  else if (st === 409) msg = `${e.message} Your changes are kept in this browser meanwhile.`;
  else if (st >= 500) msg = `The hub could not save (${e.message}). It will try again.`;
  const out = new Error(msg);
  out.status = st;
  out.cause = e;
  if (e.timeout) out.timeout = true;
  return out;
}

// ====================================================================== the store

/**
 * A store instance. The module exports below drive one default instance; tests create
 * isolated ones with fake API, storage and timers.
 */
export function createStore(options = {}) {
  const env = {
    getData: options.getData || apiGetDataWithEtag,
    putData: options.putData || apiPutData,
    getHealth: options.getHealth || apiHealth,
    getText: options.getText || getText,
    storage: 'storage' in options ? options.storage : browserStorage('localStorage'),
    session: 'session' in options ? options.session : browserStorage('sessionStorage'),
    locks: 'locks' in options ? options.locks : (globalThis.navigator && globalThis.navigator.locks) || null,
    channel: 'channel' in options ? options.channel
      : (typeof BroadcastChannel !== 'undefined' && typeof window !== 'undefined' ? () => new BroadcastChannel(CHANNEL_NAME) : null),
    now: options.now || (() => Date.now()),
    setTimer: options.setTimer || ((fn, ms) => setTimeout(fn, ms)),
    clearTimer: options.clearTimer || ((t) => clearTimeout(t)),
    random: options.random || Math.random,
    uuid: options.uuid || newUuid,
    saveDelay: options.saveDelay ?? SAVE_DELAY,
    saveTimeout: options.saveTimeout ?? SAVE_TIMEOUT,
    isVisible: options.isVisible || (() => typeof document === 'undefined' || document.visibilityState !== 'hidden'),
    location: 'location' in options ? options.location : globalThis.location || null,
  };

  let data = null; // live data the views mutate
  let base = null; // last document confirmed by the server (at `etag`)
  let etag = null;
  let status = 'idle';
  let lastError = null;
  let saveTimer = null;
  let retryTimer = null;
  let checkTimer = null;
  let retryDelay = RETRY_MIN;
  let retryAt = null;
  let inflight = null;
  let again = false;
  let editSeq = 0;
  let fixtureMode = false;
  let lastSaveId = null;
  let lastSavedAt = null;
  let conflict = null; // {id, detectedAt, items, remote, remoteEtag}
  let recovered = null; // {keys, data, at, conflicts}
  let tabId = null;
  let channel = null;
  let resyncs = 0;
  let checking = null;
  let lastCheckAt = -Infinity;
  let epoch = 0; // bumps whenever base/etag change
  let pendingStored = true;
  let lastBytes = 0;
  let disposed = false;
  let loadId = null; // one localStorage delta per page load, so a reload never overwrites the last one
  let build = null; // the hub's build id read at boot (sent as X-Hub-Build)
  let buildChecked = false;
  let buildMismatch = null; // {server, client, at} after a 409 build_mismatch
  let lastBuildCheck = -Infinity;
  let saveToken = 0; // bumps when a save is abandoned by the watchdog: its late answer is ignored
  let checkToken = 0;
  const staleKeys = new Set(); // recovered localStorage keys, removed once the server has the data
  const spentPreviews = new WeakSet();
  const spentHashes = new Set();
  const statusListeners = new Set();
  const externalListeners = new Set();
  const conflictListeners = new Set();
  const buildListeners = new Set();

  const pendingKey = () => `${PENDING_PREFIX}${tabId}${loadId ? `.${loadId}` : ''}`;

  function publicConflict() {
    if (!conflict) return null;
    return {
      id: conflict.id,
      detectedAt: conflict.detectedAt,
      count: conflict.items.length,
      kind: conflict.kind || 'sync', // 'sync' (saved elsewhere meanwhile) | 'recovery' (restoring unsaved changes)
      items: conflict.items.map(({ id, path, label, collection, key, field, base: b, mine, theirs }) => ({ id, path, label, collection, key, field, base: b, mine, theirs })),
    };
  }

  function info() {
    return {
      error: lastError, savedAt: lastSavedAt, conflict: publicConflict(), retryAt, pendingStored,
      bytes: lastBytes, nearLimit: lastBytes > MAX_DATA_BYTES * 0.8, etag, tabId,
      build, buildMismatch: buildMismatch ? { ...buildMismatch } : null,
    };
  }

  function setStatus(s) {
    status = s;
    const i = info();
    for (const fn of statusListeners) {
      try { fn(status, i); } catch (e) { console.error(e); }
    }
  }

  function emitExternal(detail) {
    for (const fn of externalListeners) {
      try { fn(detail); } catch (e) { console.error(e); }
    }
  }

  function emitConflict() {
    const c = publicConflict();
    for (const fn of conflictListeners) {
      try { fn(c); } catch (e) { console.error(e); }
    }
  }

  function emitBuild() {
    const d = buildMismatch ? { ...buildMismatch, message: BUILD_MISMATCH_TEXT } : null;
    for (const fn of buildListeners) {
      try { fn(d); } catch (e) { console.error(e); }
    }
  }

  /** With nobody listening for conflicts, fall back to the plain "error + retry" UI. */
  function conflictStatus() {
    if (!conflict) return;
    if (conflictListeners.size) { lastError = null; setStatus('conflict'); return; }
    const n = conflict.items.length;
    const what = conflict.items.slice(0, 3).map((x) => x.label).join('; ');
    lastError = new Error(conflict.kind === 'recovery'
      ? `Restoring your unsaved changes: ${n === 1 ? 'one of them was' : `${n} of them were`} also changed since (${what}). Press retry to keep your restored version; the other version is kept in this browser’s conflict log.`
      : `Another tab or device changed ${n === 1 ? 'one of the same things' : `${n} of the same things`} you changed (${what}). Press retry to keep your version; the other version is kept in this browser’s conflict log.`);
    lastError.status = 412;
    setStatus('error');
  }

  const result = () => ({ status, saved: status === 'saved', conflict: !!conflict, error: lastError });

  // ------------------------------------------------------------- localStorage delta

  function writePending(changes) {
    if (fixtureMode || !env.storage || !data || !base || !tabId) return;
    let ok = true;
    try {
      const ch = changes || (ensureIds(data, env.uuid), diffData(base, data));
      if (!ch.length) { env.storage.remove(pendingKey()); }
      else {
        const payload = (withBase) => JSON.stringify({
          v: 2, tab: tabId, at: new Date(env.now()).toISOString(), base_etag: etag,
          base_save_id: base?.meta?.save_id || null, changes: compactChanges(ch, { withBase }),
        });
        ok = env.storage.set(pendingKey(), payload(true)) || env.storage.set(pendingKey(), payload(false));
      }
    } catch { ok = false; }
    if (ok !== pendingStored) { pendingStored = ok; setStatus(status); }
  }

  function clearOwnPending() {
    if (env.storage && tabId) env.storage.remove(pendingKey());
    if (env.storage) for (const k of staleKeys) env.storage.remove(k);
    staleKeys.clear();
  }

  /** Append to a capped, expiring list in localStorage (SEC10: old health data doesn't linger). */
  function archive(key, entry, { entries, days, chars }) {
    if (!env.storage) return;
    let log = readJSON(env.storage.get(key));
    if (!Array.isArray(log)) log = [];
    log.push(entry);
    log = expireLog(log, days, env.now());
    while (log.length > entries) log.shift();
    let text = JSON.stringify(log);
    while (text.length > chars && log.length > 1) { log.shift(); text = JSON.stringify(log); }
    if (text.length > chars) {
      log = log.map((e) => ({ ...e, mine: preview(e.mine), theirs: preview(e.theirs), changes: e.changes ? preview(e.changes) : undefined, truncated: true }));
      text = JSON.stringify(log);
    }
    if (text.length <= chars) env.storage.set(key, text);
  }

  function readLog(key, limits) {
    if (!env.storage) return [];
    const raw = readJSON(env.storage.get(key));
    if (!Array.isArray(raw)) return [];
    let log = expireLog(raw, limits.days, env.now());
    if (log.length > limits.entries) log = log.slice(-limits.entries);
    if (log.length !== raw.length) { if (log.length) env.storage.set(key, JSON.stringify(log)); else env.storage.remove(key); }
    return log;
  }

  function archiveConflicts(items, source = 'sync') {
    if (!items || !items.length) return;
    const at = new Date(env.now()).toISOString();
    for (const it of items) {
      archive(CONFLICT_LOG_KEY, { at, label: it.label, path: it.path, kept: it.resolvedAs === 'theirs' ? 'theirs' : 'mine', mine: it.mine, theirs: it.theirs, source: it.source || source }, CONFLICT_LOG_LIMITS);
    }
  }

  function spend(previewDoc) {
    if (!isObj(previewDoc)) return;
    spentPreviews.add(previewDoc);
    try { spentHashes.add(hashValue(previewDoc)); } catch { /* best effort */ }
  }

  const isSpent = (doc) => isObj(doc) && (spentPreviews.has(doc) || (spentHashes.size > 0 && spentHashes.has(hashValue(doc))));

  // ------------------------------------------------------------- tabs

  function holdLock(name) {
    return new Promise((resolve) => {
      let settled = false;
      const finish = (v) => { if (!settled) { settled = true; resolve(v); } };
      try {
        const p = env.locks.request(name, { ifAvailable: true }, (lock) => {
          if (!lock) { finish(false); return undefined; }
          finish(true);
          return new Promise(() => {}); // held for the life of the page
        });
        if (p && typeof p.catch === 'function') p.catch(() => finish(false));
      } catch { finish(false); }
      env.setTimer(() => finish(true), 1500);
    });
  }

  async function acquireTab() {
    let id = env.session ? env.session.get(TAB_KEY) : null;
    if (!(typeof id === 'string' && /^[A-Za-z0-9-]{8,64}$/.test(id))) id = env.uuid();
    if (env.locks && typeof env.locks.request === 'function') {
      // A duplicated tab copies sessionStorage: if our id is already held, take a new one.
      for (let i = 0; i < 3; i++) {
        if (await holdLock(LOCK_PREFIX + id)) break;
        id = env.uuid();
      }
    }
    if (env.session) env.session.set(TAB_KEY, id);
    tabId = id;
  }

  async function liveTabs() {
    if (!env.locks || typeof env.locks.query !== 'function') return null;
    try {
      const q = await env.locks.query();
      return new Set((q && Array.isArray(q.held) ? q.held : []).map((l) => l && l.name)
        .filter((n) => typeof n === 'string' && n.startsWith(LOCK_PREFIX)).map((n) => n.slice(LOCK_PREFIX.length)));
    } catch { return null; }
  }

  function openChannel() {
    if (!env.channel || channel) return;
    try {
      channel = env.channel();
      channel.onmessage = (e) => {
        const m = e && e.data;
        if (!isObj(m) || m.tab === tabId) return;
        if (m.type === 'saved' && (!m.etag || m.etag !== etag) && env.isVisible()) scheduleCheck(300);
      };
    } catch { channel = null; }
  }

  function post(msg) {
    try { if (channel) channel.postMessage({ ...msg, tab: tabId }); } catch { /* ignore */ }
  }

  // ------------------------------------------------------------- recovery

  /** One stored delta (v2) or the old v1 copy, or null when the key is gone or unreadable. */
  function readPendingEntry(k) {
    if (!env.storage) return null;
    if (k === LEGACY_PENDING_KEY) {
      const p = readJSON(env.storage.get(k));
      return isObj(p) && isObj(p.data) ? { key: k, legacy: true, at: typeof p.at === 'string' ? p.at : '', data: p.data } : null;
    }
    if (typeof k !== 'string' || !k.startsWith(PENDING_PREFIX)) return null;
    const p = readJSON(env.storage.get(k));
    if (!isObj(p) || p.v !== 2 || !Array.isArray(p.changes)) return null; // unreadable: left alone
    const tab = typeof p.tab === 'string' ? p.tab : k.slice(PENDING_PREFIX.length).split('.')[0];
    return { key: k, tab, at: typeof p.at === 'string' ? p.at : '', changes: p.changes };
  }

  const publicItem = ({ id, path, label, collection, key, field, base: b, mine, theirs, source }) => ({ id, path, label, collection, key, field, base: b, mine, theirs, source });

  /**
   * Unsaved changes of closed tabs, crashed pages and older page loads of this tab. Only a
   * PREVIEW is computed here; restoring re-applies the stored deltas onto the live data at that
   * moment (restorePending), so anything adopted in between is never reverted.
   */
  async function findRecoverable() {
    if (!env.storage) return null;
    const entries = env.storage.keys().filter((k) => k !== pendingKey()).map(readPendingEntry).filter(Boolean);
    if (!entries.length) return null;
    const live = await liveTabs();
    const usable = entries.filter((e) => e.legacy || e.tab === tabId
      || (live ? !live.has(e.tab) : env.now() - (Date.parse(e.at) || 0) > ORPHAN_AGE_MS));
    if (!usable.length) return null;
    usable.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
    const previewDoc = cloneJSON(data);
    const r = applyRecovery(previewDoc, usable, { defaultChoice: 'mine' });
    const initDiff = diffData(data, previewDoc);
    if (!initDiff.length) {
      // Nothing to restore: already saved, or only older values from an old copy (archived).
      archiveConflicts(r.legacyConflicts, 'legacy');
      for (const e of usable) env.storage.remove(e.key);
      return null;
    }
    const at = usable[usable.length - 1].at;
    const items = [...r.conflicts, ...r.legacyConflicts].map(publicItem);
    recovered = { keys: usable.map((e) => e.key), sources: usable, preview: previewDoc, at, initDiff };
    return { at, data: previewDoc, changes: initDiff.length, conflicts: items.length, conflictItems: items, notes: r.notes, sources: usable.length };
  }

  /**
   * Restore what findRecoverable() offered (the UI's "Restore my changes"). The stored deltas are
   * re-read and re-applied onto the live data now: fields changed nowhere else are applied, a
   * field also changed since (here, in another tab or on another device) becomes a conflict for
   * the UI (onConflict, kind 'recovery'); until it is resolved the live value stays and saving
   * pauses. Old v1 copies only add or fill (legacyFill). The source keys stay in localStorage
   * until the server has the result.
   */
  function restorePending() {
    if (!recovered) return Promise.resolve(result());
    const rec = recovered;
    recovered = null;
    spend(rec.preview);
    if (!data || disposed) return Promise.resolve(result());
    const sources = rec.sources.map((e) => readPendingEntry(e.key)).filter(Boolean);
    checkToken++; // a stale-tab check already out must not merge over what is restored now
    ensureIds(data, env.uuid);
    const r = applyRecovery(data, sources, { defaultChoice: 'theirs' });
    archiveConflicts(r.legacyConflicts, 'legacy');
    for (const k of rec.keys) staleKeys.add(k);
    editSeq++;
    if (fixtureMode) { setStatus('fixture'); return Promise.resolve(result()); }
    if (r.conflicts.length) {
      conflict = {
        id: env.uuid(), detectedAt: new Date(env.now()).toISOString(), kind: 'recovery',
        items: r.conflicts, sources: sources.filter((x) => !x.legacy),
      };
      writePending();
      emitConflict();
      conflictStatus();
      return Promise.resolve(result());
    }
    writePending();
    return flush();
  }

  // ------------------------------------------------------------- saving

  function scheduleRetry(err) {
    env.clearTimer(retryTimer);
    const slow = err && (err.status === 400 || err.status === 409 || err.status === 413); // retrying fast can't fix these
    const delay = Math.round((slow ? RETRY_MAX : retryDelay) * (0.8 + env.random() * 0.4));
    retryAt = env.now() + delay;
    retryTimer = env.setTimer(() => { retryTimer = null; retryAt = null; flush(); }, delay);
    retryDelay = Math.min(retryDelay * 2, RETRY_MAX);
  }

  function fail(err) {
    lastError = friendlyError(err);
    setStatus('error');
    scheduleRetry(err);
  }

  const isBuildMismatchError = (err) => !!err && err.status === 409 && (err.code === 'build_mismatch' || err.body?.error === 'build_mismatch');

  /** SPEC 5.7a: the hub was updated under this tab. Keep every local change; the UI asks for a reload. */
  function markBuildMismatch(serverBuild) {
    buildMismatch = { server: typeof serverBuild === 'string' ? serverBuild : null, client: build, at: new Date(env.now()).toISOString() };
    lastError = new Error(BUILD_MISMATCH_TEXT);
    lastError.status = 409;
    lastError.code = 'build_mismatch';
    env.clearTimer(retryTimer);
    retryTimer = null;
    retryAt = null;
    writePending();
    setStatus('build-mismatch');
    emitBuild();
  }

  /** Read the hub's build once more (boot failed to, or a mismatch may have cleared). */
  async function refreshBuild() {
    buildChecked = true;
    try {
      const b = buildOf(await env.getHealth());
      if (b && build === null) build = b;
      return b;
    } catch { return null; }
  }

  /**
   * Compare the hub's current build with the one this page booted with (focus does this at most
   * once a minute; retry() forces it). A mismatch is reported before any save is refused; a
   * mismatch that has gone (the hub was rolled back) clears and saving resumes.
   */
  async function checkBuild({ force = false } = {}) {
    if (fixtureMode || disposed || !data) return { mismatch: false };
    if (!force && env.now() - lastBuildCheck < BUILD_CHECK_GAP) return { mismatch: !!buildMismatch, skipped: true };
    lastBuildCheck = env.now();
    let b = null;
    try { b = buildOf(await env.getHealth()); } catch { return { mismatch: !!buildMismatch, error: true }; }
    if (!b || disposed) return { mismatch: !!buildMismatch };
    if (build === null) { build = b; buildChecked = true; }
    const mismatch = b !== 'dev' && b !== build;
    if (mismatch && !buildMismatch) markBuildMismatch(b);
    else if (!mismatch && buildMismatch) {
      buildMismatch = null;
      lastError = null;
      emitBuild();
      setStatus('dirty');
      flush();
    }
    return { mismatch, server: b, client: build };
  }

  function adoptBase(remote, newEtag) {
    base = remote;
    etag = newEtag || null;
    epoch++;
    if (remote?.meta?.save_id) lastSaveId = remote.meta.save_id;
    if (remote?.meta?.saved_at) lastSavedAt = remote.meta.saved_at;
  }

  function setConflict(items, remote, remoteEtag) {
    if (conflict && conflict.kind === 'recovery') return; // never replaces a restore that is waiting for a choice
    conflict = { id: env.uuid(), detectedAt: new Date(env.now()).toISOString(), items, remote, remoteEtag };
    writePending();
    emitConflict();
    conflictStatus();
  }

  /** Bring a fresh server copy in: adopt it (no local changes) or merge into the live data. */
  function reconcile(fresh, reason) {
    const remote = migrate(fresh.data, { inPlace: true });
    if (fresh.bytes) lastBytes = fresh.bytes;
    ensureIds(data, env.uuid);
    const changes = diffData(base, data);
    if (!changes.length) {
      const n = patchInPlace(data, cloneJSON(remote));
      adoptBase(remote, fresh.etag);
      if (n) emitExternal({ kind: 'reload', reason, changes: n });
      return { merged: false, changed: n > 0 };
    }
    const m = mergeData(base, data, remote, { changes });
    if (m.conflicts.length) {
      setConflict(m.conflicts, remote, fresh.etag);
      return { conflict: true };
    }
    const n = patchInPlace(data, m.result);
    adoptBase(remote, fresh.etag);
    if (n) emitExternal({ kind: 'merge', reason, changes: n, notes: m.notes });
    return { merged: true, changed: n > 0, notes: m.notes };
  }

  async function resync(token) {
    resyncs++;
    if (resyncs > MAX_RESYNCS) {
      resyncs = 0;
      throw new Error('The data keeps changing in another tab or device, so this tab paused saving for a moment. It will try again.');
    }
    const fresh = await env.getData();
    if (token !== saveToken || disposed) return; // abandoned meanwhile: the retry starts afresh
    if (conflict && conflict.kind === 'recovery') return; // a restore is waiting for your choice: merge after it
    reconcile(fresh, 'precondition');
    if (!conflict) again = true; // save the merged result with the fresh ETag
  }

  const STALLED = Symbol('stalled');

  function flush({ keepalive = false } = {}) {
    env.clearTimer(saveTimer);
    saveTimer = null;
    if (disposed || fixtureMode || !data) return Promise.resolve(result());
    if (conflict) { writePending(); conflictStatus(); return Promise.resolve(result()); }
    if (buildMismatch) { writePending(); if (status !== 'build-mismatch') setStatus('build-mismatch'); return Promise.resolve(result()); }
    // A save is still out: the edits wait for it, but reach localStorage now (PE4).
    if (inflight) { again = true; writePending(); return inflight; }
    env.clearTimer(retryTimer);
    retryTimer = null;
    retryAt = null;
    ensureIds(data, env.uuid);
    const changes = diffData(base, data);
    if (!changes.length) {
      clearOwnPending();
      if (status !== 'saved') { lastError = null; setStatus('saved'); }
      return Promise.resolve(result());
    }
    writePending(changes);
    const seq = editSeq;
    const saveId = env.uuid();
    const savedAt = new Date(env.now()).toISOString();
    data.meta = { ...(isObj(data.meta) ? data.meta : {}), save_id: saveId, saved_at: savedAt, app: 'fitness-hub' };
    if (!Number.isInteger(data.schema_version) || data.schema_version < SCHEMA_VERSION) data.schema_version = SCHEMA_VERSION;
    const body = JSON.stringify(data);
    lastBytes = byteLength(body);
    if (lastBytes > MAX_DATA_BYTES) {
      const e = new Error('too large');
      e.status = 413;
      fail(e);
      return Promise.resolve(result());
    }
    setStatus('saving');
    const token = saveToken;
    let watchdog = null;
    const attempt = (async () => {
      try {
        if (build === null && !buildChecked) await refreshBuild(); // so the PUT can carry X-Hub-Build
        if (token !== saveToken) return;
        const res = await env.putData(body, { etag, keepalive, build });
        if (token !== saveToken || disposed) return; // abandoned by the watchdog: the retry takes over
        etag = res && typeof res.etag === 'string' && res.etag ? res.etag : null;
        base = JSON.parse(body);
        epoch++;
        lastSaveId = saveId;
        lastSavedAt = savedAt;
        lastError = null;
        retryDelay = RETRY_MIN;
        resyncs = 0;
        post({ type: 'saved', etag, saveId });
        if (editSeq === seq) { clearOwnPending(); setStatus('saved'); } else again = true;
      } catch (err) {
        if (token !== saveToken || disposed) return;
        if (err && (err.status === 412 || err.status === 428)) {
          try { await resync(token); } catch (e2) { if (token === saveToken) fail(e2); }
        } else if (isBuildMismatchError(err)) markBuildMismatch(err.body?.build);
        else fail(err);
      }
    })();
    // Watchdog (PE4): a save that hasn't settled in time is abandoned and goes to retry.
    const stalled = new Promise((resolve) => { watchdog = env.setTimer(() => resolve(STALLED), env.saveTimeout); });
    inflight = (async () => {
      const outcome = await Promise.race([attempt.then(() => null), stalled]);
      env.clearTimer(watchdog);
      inflight = null;
      if (outcome === STALLED && token === saveToken && !disposed) {
        saveToken++;
        again = false;
        writePending();
        const e = new Error('The hub took too long to answer.');
        e.status = 0;
        e.timeout = true;
        fail(e);
        return result();
      }
      // A follow-up save (edits made meanwhile, or the merged copy after a 412) is chained, so
      // `await flush()` settles only when everything it started has finished.
      if (again && !conflict && !disposed && !buildMismatch) { again = false; return flush(); }
      again = false;
      return result();
    })();
    return inflight;
  }

  function touch() {
    if (fixtureMode) { setStatus('fixture'); return; }
    if (!data || disposed) return;
    editSeq++;
    if (conflict) { writePending(); conflictStatus(); return; }
    if (status !== 'saving' && !buildMismatch) setStatus('dirty');
    env.clearTimer(saveTimer);
    saveTimer = env.setTimer(() => { saveTimer = null; flush(); }, env.saveDelay);
  }

  // ------------------------------------------------------------- stale tabs

  function scheduleCheck(ms) {
    env.clearTimer(checkTimer);
    checkTimer = env.setTimer(() => { checkTimer = null; checkForUpdates(); }, ms);
  }

  /** Re-read the server copy (If-None-Match) and adopt or merge it if another tab saved. */
  function checkForUpdates({ force = false } = {}) {
    if (disposed || fixtureMode || !data || !base) return Promise.resolve({ stale: false });
    // Restoring unsaved changes with a conflict open: nothing is merged in until it is resolved.
    if (conflict && conflict.kind === 'recovery') return Promise.resolve({ stale: false, paused: true });
    if (checking) return checking;
    if (inflight) return Promise.resolve({ stale: false, busy: true });
    if (!force && env.now() - lastCheckAt < CHECK_MIN_GAP) return Promise.resolve({ stale: false, skipped: true });
    lastCheckAt = env.now();
    const startEpoch = epoch;
    const token = ++checkToken;
    let watchdog = null;
    const work = (async () => {
      try {
        const fresh = await env.getData({ ifNoneMatch: etag });
        if (token !== checkToken || disposed) return { stale: false, busy: true };
        if (conflict && conflict.kind === 'recovery') return { stale: false, paused: true };
        if (epoch !== startEpoch || inflight) return { stale: false, busy: true };
        if (fresh.status === 304 || (fresh.etag && etag && fresh.etag === etag)) return { stale: false };
        if (!fresh.etag && !etag && fresh.data?.meta?.save_id && fresh.data.meta.save_id === lastSaveId) return { stale: false };
        const hadConflict = !!conflict;
        if (hadConflict) conflict = null; // re-merge against the newer copy: it may have gone away
        const r = reconcile(fresh, 'stale');
        if (hadConflict && !conflict) { emitConflict(); lastError = null; setStatus('dirty'); }
        if (!conflict && (r.merged || hadConflict)) flush();
        return { stale: true, ...r };
      } catch (error) {
        return { stale: false, error };
      }
    })();
    const stalled = new Promise((resolve) => { watchdog = env.setTimer(() => resolve(STALLED), env.saveTimeout); });
    const run = Promise.race([work, stalled]).then((r) => {
      env.clearTimer(watchdog);
      if (checking === run) checking = null;
      if (r === STALLED) {
        if (token === checkToken) checkToken++; // its late answer is ignored
        const error = new Error('The hub took too long to answer.');
        error.status = 0;
        error.timeout = true;
        return { stale: false, error };
      }
      return r;
    });
    checking = run;
    return run;
  }

  // ------------------------------------------------------------- public API

  async function init({ fixtures = false, fixtureFile = null } = {}) {
    fixtureMode = !!fixtures;
    if (fixtureMode) {
      let name = fixtureFile;
      if (!name && env.location) {
        const q = new URLSearchParams(env.location.search || '').get('data');
        if (q && /^[a-z0-9-]{1,40}$/.test(q)) name = `data-${q}`;
      }
      const text = await env.getText(`/dev-fixtures/${name && /^[a-z0-9-]{1,48}$/.test(name) ? name : 'data'}.json`);
      let parsed = null;
      try { parsed = text ? JSON.parse(text) : null; } catch { parsed = null; }
      data = migrate(parsed);
      base = cloneJSON(data);
      setStatus('fixture');
      return { recovered: null };
    }
    await acquireTab();
    loadId = env.uuid();
    const healthP = Promise.resolve().then(() => env.getHealth()).catch(() => null);
    const [fresh, health] = await Promise.all([env.getData(), healthP]);
    build = buildOf(health);
    buildChecked = build !== null;
    lastBuildCheck = env.now();
    base = migrate(fresh.data, { inPlace: true });
    etag = fresh.etag || null;
    lastBytes = fresh.bytes || 0;
    data = cloneJSON(base);
    lastSaveId = base.meta?.save_id || null;
    lastSavedAt = base.meta?.saved_at || null;
    setStatus('saved');
    openChannel();
    return { recovered: await findRecoverable() };
  }

  /**
   * Replace everything (import / restore from a file) and save. Passing the `recovered.data`
   * preview from init() restores the unsaved changes instead (restorePending: re-applied onto the
   * live data, never the preview itself); a preview that was already restored or discarded is
   * ignored, so a stale snapshot can never be applied.
   */
  function replaceAll(next) {
    if (recovered && (next === recovered.preview || (isObj(next) && deepEqual(next, recovered.preview)))) return restorePending();
    if (isSpent(next)) return Promise.resolve(result());
    const m = migrate(next);
    ensureIds(m, env.uuid);
    if (!data) data = m;
    else patchInPlace(data, m);
    if (fixtureMode) { setStatus('fixture'); return Promise.resolve(result()); }
    editSeq++;
    return flush();
  }

  async function importData(obj, opts = {}) {
    const v = validateImportDetailed(obj, opts);
    if (!v.ok) return v;
    await replaceAll(v.data);
    return v;
  }

  function discardPending() {
    if (!recovered) return;
    const rec = recovered;
    recovered = null;
    spend(rec.preview);
    if (!env.storage) return;
    try {
      archive(DISCARDED_KEY, { at: new Date(env.now()).toISOString(), changes: compactChanges(rec.initDiff) }, DISCARDED_LIMITS);
    } catch { /* best effort */ }
    for (const k of rec.keys) env.storage.remove(k);
  }

  async function resolveConflict(choice = 'mine') {
    if (!conflict) return result();
    const c = conflict;
    const defaultChoice = typeof choice === 'string' ? choice : (isObj(choice) && typeof choice.default === 'string' ? choice.default : 'mine');
    const choices = isObj(choice) ? choice : null;
    ensureIds(data, env.uuid);
    if (c.kind === 'recovery') {
      // 'mine' = the restored (unsaved) value, 'theirs' = the value in the hub now.
      const r = applyRecovery(data, c.sources, { choices, defaultChoice: defaultChoice === 'theirs' ? 'theirs' : 'mine' });
      archiveConflicts(r.conflicts, 'recovery');
      conflict = null;
      lastError = null;
      emitConflict();
      editSeq++;
      writePending();
      setStatus('dirty');
      return flush();
    }
    const m = mergeData(base, data, c.remote, { choices, defaultChoice: defaultChoice === 'theirs' ? 'theirs' : 'mine' });
    archiveConflicts(m.conflicts);
    const n = patchInPlace(data, m.result);
    adoptBase(c.remote, c.remoteEtag);
    conflict = null;
    lastError = null;
    emitConflict();
    if (n) emitExternal({ kind: 'merge', reason: 'conflict-resolved', changes: n, notes: m.notes });
    editSeq++;
    setStatus('dirty');
    return flush();
  }

  function retry() {
    retryDelay = RETRY_MIN;
    resyncs = 0;
    if (buildMismatch) return checkBuild({ force: true }).then(result);
    if (conflict) {
      if (!conflictListeners.size) return resolveConflict('mine');
      return checkForUpdates({ force: true }).then(result);
    }
    return flush();
  }

  function hasUnsaved() {
    if (fixtureMode || !data) return false;
    if (buildMismatch) return !!conflict || saveTimer !== null || (!!base && diffData(base, data).length > 0);
    return !!conflict || saveTimer !== null || ['dirty', 'saving', 'error', 'conflict'].includes(status);
  }

  function onStatus(fn) {
    statusListeners.add(fn);
    try { fn(status, info()); } catch (e) { console.error(e); }
    return () => statusListeners.delete(fn);
  }

  function onExternalChange(fn) {
    externalListeners.add(fn);
    return () => externalListeners.delete(fn);
  }

  function onConflict(fn) {
    conflictListeners.add(fn);
    if (conflict) { try { fn(publicConflict()); } catch (e) { console.error(e); } conflictStatus(); }
    return () => { conflictListeners.delete(fn); if (conflict) conflictStatus(); };
  }

  /** fn({server, client, at, message} | null): the hub was updated under this tab (or that cleared). */
  function onBuildMismatch(fn) {
    buildListeners.add(fn);
    if (buildMismatch) { try { fn({ ...buildMismatch, message: BUILD_MISMATCH_TEXT }); } catch (e) { console.error(e); } }
    return () => buildListeners.delete(fn);
  }

  // Lifecycle hooks (wired to window events for the default instance).
  function onHidden() {
    if (fixtureMode || !data) return;
    writePending();
    if (hasUnsaved() && !conflict && !inflight && !buildMismatch) flush({ keepalive: true });
  }

  function onPageHide() {
    if (fixtureMode || !data) return;
    writePending();
    if (!hasUnsaved() || conflict || buildMismatch) return;
    if (!inflight) { flush({ keepalive: true }); return; }
    // A save is in flight and may be cancelled with the page: send a keepalive copy as well.
    // If both arrive, the second gets 412, which is harmless; the delta is in localStorage anyway.
    try {
      const body = JSON.stringify(data);
      if (fitsKeepalive(body)) Promise.resolve(env.putData(body, { etag, keepalive: true, build })).catch(() => {});
    } catch { /* ignore */ }
  }

  function onBeforeUnload() {
    if (fixtureMode || !data) return false;
    writePending();
    // After a hub update the changes are safe in localStorage and offered back after the reload
    // the user is asked to do, so the browser shouldn't warn about leaving.
    if (buildMismatch && pendingStored) return false;
    if (!hasUnsaved()) return false;
    if (!inflight && !conflict && !buildMismatch) flush({ keepalive: true });
    return true;
  }

  function onVisible() {
    if (fixtureMode || !data) return;
    if (status === 'error' && !conflict) { retryDelay = RETRY_MIN; flush(); }
    scheduleCheck(250);
    checkBuild().catch(() => {});
  }

  function onOnline() {
    if (status === 'error' && !conflict) retry();
  }

  function dispose() {
    disposed = true;
    for (const t of [saveTimer, retryTimer, checkTimer]) if (t) env.clearTimer(t);
    saveTimer = retryTimer = checkTimer = null;
    try { if (channel) channel.close(); } catch { /* ignore */ }
    channel = null;
  }

  return {
    init, get: () => data, getStatus: () => status, isFixtureMode: () => fixtureMode, lastSaved: () => lastSavedAt,
    touch, update: (mutator) => { mutator(data); touch(); }, flush, retry, hasUnsaved, onStatus, onExternalChange,
    replaceAll, restorePending, discardPending, importData, onConflict, getConflict: publicConflict, resolveConflict, checkForUpdates,
    onBuildMismatch, checkBuild, getBuild: () => build, getBuildMismatch: () => (buildMismatch ? { ...buildMismatch, message: BUILD_MISMATCH_TEXT } : null),
    syncInfo: () => ({ status, ...info(), pendingChanges: data && base ? diffData(base, data).length : 0, hasUnsaved: hasUnsaved() }),
    conflictLog: () => readLog(CONFLICT_LOG_KEY, CONFLICT_LOG_LIMITS),
    clearConflictLog: () => { if (env.storage) env.storage.remove(CONFLICT_LOG_KEY); },
    onHidden, onPageHide, onBeforeUnload, onVisible, onOnline, dispose,
    _debug: () => ({ base, etag, editSeq, tabId, loadId, recovered, conflict, epoch, build, buildMismatch, pendingKey: pendingKey() }),
  };
}

// ====================================================================== default instance

const store = createStore();

export const init = (opts) => store.init(opts);
export const get = () => store.get();
export const getStatus = () => store.getStatus();
export const isFixtureMode = () => store.isFixtureMode();
export const lastSaved = () => store.lastSaved();
/** Call after mutating data in place. */
export const touch = () => store.touch();
export const update = (mutator) => store.update(mutator);
/** Save now. Never rejects; resolves to {status, saved, conflict, error}. */
export const flush = (opts) => store.flush(opts);
export const retry = () => store.retry();
export const hasUnsaved = () => store.hasUnsaved();
export const onStatus = (fn) => store.onStatus(fn);
/** fn({kind: 'reload' | 'merge', reason, changes, notes}) after another tab's changes were applied. */
export const onExternalChange = (fn) => store.onExternalChange(fn);
/** Replace everything (import / restore) and save straight away. Concurrent edits elsewhere are merged on top. */
export const replaceAll = (next) => store.replaceAll(next);
/** Restore the unsaved changes init() offered: re-applied onto the live data (conflicts go to onConflict). */
export const restorePending = () => store.restorePending();
export const discardPending = () => store.discardPending();
/** Validate and, only if there are no errors, replace everything. Resolves to the validation result. */
export const importData = (obj, opts) => store.importData(obj, opts);
/** fn(conflict | null). conflict = {id, detectedAt, count, items: [{id, label, path, collection, key, field, base, mine, theirs}]}. */
export const onConflict = (fn) => store.onConflict(fn);
export const getConflict = () => store.getConflict();
/** 'mine' | 'theirs' | {default: 'mine' | 'theirs', [itemId]: 'mine' | 'theirs'}. The losing values go to conflictLog(). */
export const resolveConflict = (choice) => store.resolveConflict(choice);
export const checkForUpdates = (opts) => store.checkForUpdates(opts);
export const syncInfo = () => store.syncInfo();
export const conflictLog = () => store.conflictLog();
export const clearConflictLog = () => store.clearConflictLog();
/** fn({server, client, at, message} | null) when the hub was updated under this tab (status "build-mismatch"). */
export const onBuildMismatch = (fn) => store.onBuildMismatch(fn);
/** Re-read the hub's build ({force} skips the once-a-minute limit). Resolves {mismatch, server, client}. */
export const checkBuild = (opts) => store.checkBuild(opts);
/** The build id read from /api/health at boot ("dev", a content hash, or null if unknown). */
export const getBuild = () => store.getBuild();
export const getBuildMismatch = () => store.getBuildMismatch();

if (typeof window !== 'undefined' && typeof document !== 'undefined' && typeof window.addEventListener === 'function') {
  window.addEventListener('pagehide', () => store.onPageHide());
  window.addEventListener('beforeunload', (e) => {
    if (store.onBeforeUnload()) {
      e.preventDefault();
      e.returnValue = '';
    }
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') store.onHidden();
    else store.onVisible();
  });
  window.addEventListener('focus', () => store.onVisible());
  window.addEventListener('pageshow', (e) => { if (e.persisted) store.onVisible(); });
  window.addEventListener('online', () => store.onOnline());
  // The build-mismatch event for UI code that listens on window rather than importing onBuildMismatch.
  store.onBuildMismatch((detail) => {
    try { window.dispatchEvent(new CustomEvent('fitness-hub:build-mismatch', { detail })); } catch { /* old browser */ }
  });
}
