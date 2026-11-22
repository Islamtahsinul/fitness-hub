// Program scheduling (SPEC section 5.2): gates, phases, looping, add-ons and week overrides.
// Pure functions only, so they run in the browser and in the Node tests.

import { addDays, daysBetween, isISODate, mondayOf, mondayOnOrAfter, todayISO, weekdayIndex } from './dates.js';

export const GATE_ORDER = ['none', 'good_arm_ok', 'clinic_light', 'grip_cleared', 'full_clearance'];
export const CLEARANCE_GATES = GATE_ORDER.slice(1);
export const DAY_KEYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
export const ALWAYS = '0000-01-01';

/**
 * The start used when neither profile.program_start nor program.default_start_date is set: the
 * next Monday after `today` (on a Monday, the one a week later), so a new user never lands
 * part-way into a programme they haven't begun. It moves on with the calendar until a start date
 * is chosen (in the welcome or Settings).
 */
export function defaultStart(today = todayISO()) {
  return mondayOnOrAfter(addDays(isISODate(today) ? today : todayISO(), 1));
}

export const DEFAULT_GATES = [
  { id: 'none', label: 'Available now', description: 'Safe before any clearance: nothing goes through the injured arm.' },
  { id: 'good_arm_ok', label: 'Good arm OK', description: 'The clinic or physio said you can train the uninjured arm.' },
  { id: 'clinic_light', label: 'Light use', description: 'Cleared for light use of the injured arm, and/or physio rehab has started.' },
  { id: 'grip_cleared', label: 'Grip cleared', description: 'Physio cleared gripping and holding light to moderate weights. Still no weight-bearing on the wrist, hanging or impact.' },
  { id: 'full_clearance', label: 'Full clearance', description: 'Fully cleared: heavy loading, carrying, hanging, weight-bearing on hands, impact and jumping.' },
];

/** Rank of a gate; unknown or missing ids count as the most restrictive (fail safe). */
export function gateRank(id) {
  const i = GATE_ORDER.indexOf(id);
  return i < 0 ? GATE_ORDER.length - 1 : i;
}

/** Earliest date on which a gate counts as met (cumulative), ALWAYS for 'none', or null. */
export function gateClearedOn(gateId, clearances) {
  const r = gateRank(gateId);
  if (r === 0) return ALWAYS;
  let best = null;
  for (let i = r; i < GATE_ORDER.length; i++) {
    const d = clearances ? clearances[GATE_ORDER[i]] : null;
    if (isISODate(d) && (best === null || d < best)) best = d;
  }
  return best;
}

export function isGateMet(gateId, clearances, dateISO) {
  const d = gateClearedOn(gateId, clearances);
  return d !== null && d <= dateISO;
}

export function highestGate(clearances, dateISO) {
  let g = 'none';
  for (const id of GATE_ORDER) if (isGateMet(id, clearances, dateISO)) g = id;
  return g;
}

export function gateList(program) {
  const byId = new Map(DEFAULT_GATES.map((g) => [g.id, { ...g }]));
  if (Array.isArray(program?.gates)) {
    for (const g of program.gates) {
      if (g && typeof g.id === 'string' && byId.has(g.id)) {
        const cur = byId.get(g.id);
        byId.set(g.id, {
          ...cur,
          label: typeof g.label === 'string' && g.label.trim() ? g.label : cur.label,
          description: typeof g.description === 'string' && g.description.trim() ? g.description : cur.description,
        });
      }
    }
  }
  return GATE_ORDER.map((id) => byId.get(id));
}

/** The programme start Monday: profile.program_start, else program.default_start_date, else defaultStart(today). */
export function programStart(program, profile, today) {
  const raw = isISODate(profile?.program_start)
    ? profile.program_start
    : isISODate(program?.default_start_date) ? program.default_start_date : defaultStart(today);
  return mondayOf(raw);
}

function toInt(v, fallback) {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) ? n : fallback;
}

export function phaseWeeks(p) {
  const w = toInt(p?.weeks, 1);
  return w >= 1 ? w : 1;
}

/** Earliest week count after which the next phase may start if its gate is already met. */
export function minWeeks(p) {
  const w = phaseWeeks(p);
  if (p?.min_weeks === null || p?.min_weeks === undefined) return w;
  const m = toInt(p.min_weeks, w);
  return Math.min(Math.max(m, 1), w);
}

/** First week of the repeat loop. null/missing -> repeat the final week. */
export function repeatFromWeek(p) {
  const w = phaseWeeks(p);
  if (p?.repeat_from_week === null || p?.repeat_from_week === undefined) return w;
  const r = toInt(p.repeat_from_week, w);
  return Math.min(Math.max(r, 1), w);
}

/**
 * Phase timeline. Phase 1 starts on the program start Monday (or, if its own entry gate is
 * not "none", the Monday on or after that gate's date, and it waits while the gate has no
 * date). Each later phase starts on the Monday on or after the later of (its gate date, the
 * previous phase's start + its min_weeks, which defaults to weeks); until then the previous
 * phase keeps looping. A phase whose gate has no date is "waiting".
 * Recomputed from scratch on every call, so setting, clearing or moving a clearance date or
 * the start date never leaves stale state behind. {today} only matters when no start date is
 * set anywhere (see defaultStart); it defaults to the local clock.
 */
export function buildTimeline(program, profile, { today } = {}) {
  const phases = Array.isArray(program?.phases) ? program.phases.filter((p) => p && typeof p === 'object') : [];
  const clearances = profile?.clearances && typeof profile.clearances === 'object' ? profile.clearances : {};
  const start = programStart(program, profile, today);
  const items = [];
  let prev = null;
  phases.forEach((p, i) => {
    const weeks = phaseWeeks(p);
    const entryGate = typeof p.entry_gate === 'string' && p.entry_gate ? p.entry_gate : 'none';
    const gateDate = gateClearedOn(entryGate, clearances);
    let s = null;
    let waitingGate = null;
    let blockedByPrev = false;
    if (i === 0) {
      // Fail safe: a gated first phase never starts before its gate (SPEC 5.2).
      if (gateDate === null) waitingGate = entryGate;
      else s = gateDate > start ? mondayOnOrAfter(gateDate) : start;
    } else if (!prev || prev.start === null) {
      blockedByPrev = true;
      if (gateDate === null) waitingGate = entryGate;
    } else if (gateDate === null) {
      waitingGate = entryGate;
    } else {
      const earliest = addDays(prev.start, prev.minWeeks * 7);
      const later = gateDate > earliest ? gateDate : earliest;
      s = mondayOnOrAfter(later);
    }
    const item = {
      index: i,
      id: typeof p.id === 'string' && p.id ? p.id : `phase-${i + 1}`,
      phase: p,
      name: typeof p.name === 'string' && p.name ? p.name : `Phase ${i + 1}`,
      short: typeof p.short === 'string' && p.short ? p.short : (typeof p.name === 'string' ? p.name : `Phase ${i + 1}`),
      weeks,
      minWeeks: minWeeks(p),
      repeatFrom: repeatFromWeek(p),
      entryGate,
      gateDate: gateDate === ALWAYS ? null : gateDate,
      start: s,
      plannedEnd: s ? addDays(s, weeks * 7) : null, // exclusive (the Monday after the last week)
      actualEnd: null,
      waitingGate,
      blockedByPrev,
    };
    items.push(item);
    prev = item;
  });
  items.forEach((it, i) => {
    const next = items[i + 1];
    it.actualEnd = it.start && next && next.start ? next.start : null; // exclusive; null = open-ended
  });
  return { start, phases: items };
}

/** Where a date falls in the program, or null before the start / without phases. */
export function positionOn(timeline, dateISO) {
  if (!timeline || !timeline.phases.length || !isISODate(dateISO) || dateISO < timeline.start) return null;
  let cur = null;
  for (const it of timeline.phases) if (it.start && it.start <= dateISO) cur = it;
  if (!cur) return null;
  const offset = daysBetween(cur.start, dateISO);
  const absWeek = Math.floor(offset / 7) + 1;
  let week = absWeek;
  let isRepeat = false;
  let cycle = 0;
  if (absWeek > cur.weeks) {
    const loopLen = cur.weeks - cur.repeatFrom + 1;
    const extra = absWeek - cur.weeks;
    week = cur.repeatFrom + ((extra - 1) % loopLen);
    isRepeat = true;
    cycle = Math.floor((extra - 1) / loopLen) + 1;
  }
  const wd = weekdayIndex(dateISO);
  return {
    item: cur,
    phase: cur.phase,
    phaseIndex: cur.index,
    phaseId: cur.id,
    absWeek,
    week,
    isRepeat,
    cycle,
    dayIndex: wd,
    dayKey: DAY_KEYS[wd],
    weekStart: mondayOf(dateISO),
  };
}

export function weekOverride(phase, week) {
  const list = Array.isArray(phase?.week_overrides) ? phase.week_overrides : [];
  return list.find((o) => o && Number(o.week) === week) || null;
}

function normaliseDays(days) {
  if (!Array.isArray(days)) return DAY_KEYS;
  return days.map((d) => String(d).trim().toLowerCase().slice(0, 3)).filter((d) => DAY_KEYS.includes(d));
}

/** Is an add-on running on this date (in this phase)? phases[] limits it to those phase ids. */
export function addonActive(addon, clearances, dateISO, phaseId = null) {
  if (!addon || typeof addon !== 'object') return false;
  if (Array.isArray(addon.phases) && addon.phases.length && !addon.phases.includes(phaseId)) return false;
  if (!isGateMet(typeof addon.gate === 'string' && addon.gate ? addon.gate : 'none', clearances, dateISO)) return false;
  if (typeof addon.until_gate === 'string' && addon.until_gate && isGateMet(addon.until_gate, clearances, dateISO)) return false;
  return true;
}

// ------------------------------------------------------- add-ons, alternates, exercise gates

/** The rehab add-on: id "rehab", or an add-on whose session is a rehab session. */
export function isRehabAddon(addon, program = null) {
  if (!addon || typeof addon !== 'object') return false;
  if (addon.id === 'rehab') return true;
  const s = program?.sessions && typeof addon.session === 'string' ? program.sessions[addon.session] : null;
  return !!(s && typeof s === 'object' && s.type === 'rehab');
}

/** True once data.arm.physio_exercises lists at least one exercise (SPEC 5.2 round 3 PM additions). */
export function physioProgrammeReady(data) {
  const list = Array.isArray(data?.arm?.physio_exercises) ? data.arm.physio_exercises : [];
  return list.some((p) => p && typeof p === 'object' && typeof p.exercise === 'string' && p.exercise.trim());
}

/**
 * Whether an (active) add-on is shown and counted for this user's data. The rehab add-on waits
 * until the physio has given exercises; until then the Arm page says "Waiting for your physio's
 * programme". Without data (null), every add-on is visible (the pre-round-3 behaviour).
 */
export function addonVisible(addon, data, program = null) {
  if (data === null || data === undefined) return true;
  return !(isRehabAddon(addon, program) && !physioProgrammeReady(data));
}

/** program.alternates ({short, travel}) as existing session ids (null when missing). */
export function alternatesOf(program) {
  const a = program && typeof program.alternates === 'object' && program.alternates ? program.alternates : {};
  const sessions = program && typeof program.sessions === 'object' && program.sessions ? program.sessions : {};
  const ok = (id) => (typeof id === 'string' && id && sessions[id] && typeof sessions[id] === 'object' ? id : null);
  return { short: ok(a.short), travel: ok(a.travel) };
}

/** Set of alternate session ids ("Short on time?" / "Gym closed?"). */
export function alternateIds(program) {
  const a = alternatesOf(program);
  return new Set([a.short, a.travel].filter(Boolean));
}

/** Set of every add-on's session id. */
export function addonSessionIds(program) {
  return new Set((Array.isArray(program?.addons) ? program.addons : []).map((a) => a?.session).filter((x) => typeof x === 'string' && x));
}

/**
 * An exercise's gate from the library (exById: Map or object), or null when the id is not in the
 * library. null means "unknown": always locked (SPEC 5.2 round 3, fail closed).
 */
export function exerciseGate(id, exById) {
  if (typeof id !== 'string' || !id) return null;
  const ex = exById instanceof Map ? exById.get(id) : exById && typeof exById === 'object' ? exById[id] : null;
  if (!ex || typeof ex !== 'object') return null;
  return typeof ex.gate === 'string' && GATE_ORDER.includes(ex.gate) ? ex.gate : 'full_clearance';
}

/** Fail-closed lock check: unknown ids are locked; known ones are locked until their gate is met. */
export function exerciseLocked(id, clearances, dateISO, exById) {
  const g = exerciseGate(id, exById);
  return g === null || !isGateMet(g, clearances, dateISO);
}

/** The migration default for profile.unavailable_exercises: the belt and ankle-strap exercises. */
export const UNAVAILABLE_DEFAULT = Object.freeze(['sled-drag-forward-belt', 'sled-drag-backward-belt', 'cable-kickback-ankle', 'cable-hip-abduction-ankle', 'cable-hip-adduction-ankle']);

/**
 * False when the exercise is in profile.unavailable_exercises ("Not available at your gym").
 * A profile that has never had the field uses the default list.
 */
export function isAvailable(id, data) {
  const p = data && typeof data === 'object' && data.profile && typeof data.profile === 'object' ? data.profile : data;
  const list = Array.isArray(p?.unavailable_exercises) ? p.unavailable_exercises : UNAVAILABLE_DEFAULT;
  return !list.includes(id);
}

/**
 * Planned sessions for a date: the phase template entry (or rest) plus any add-ons whose
 * gate is met, whose until_gate is not met, and which list this weekday.
 * Round 3: pass {data} to apply the rehab add-on rule (hidden until the physio's programme is
 * entered); hidden add-ons are listed in `hiddenAddons` with reason "waiting-physio".
 * Alternates never change the plan.
 */
export function plannedOn(program, profile, dateISO, timeline = buildTimeline(program, profile), { data = null } = {}) {
  const pos = positionOn(timeline, dateISO);
  const sessions = program && typeof program.sessions === 'object' && program.sessions ? program.sessions : {};
  const dayKey = DAY_KEYS[weekdayIndex(dateISO)];
  const out = [];
  if (pos) {
    const tpl = pos.phase && typeof pos.phase.week_template === 'object' && pos.phase.week_template ? pos.phase.week_template : {};
    let ids = tpl[dayKey];
    if (ids == null) ids = [];
    else if (!Array.isArray(ids)) ids = [ids];
    for (const id of ids) {
      if (typeof id !== 'string' || !id) continue;
      const s = sessions[id] && typeof sessions[id] === 'object' ? sessions[id] : null;
      out.push({ sessionId: id, session: s, source: 'template', addon: null, isRest: id === 'rest' || (s ? s.type === 'rest' : false) });
    }
    if (!out.length) {
      out.push({ sessionId: 'rest', session: sessions.rest || null, source: 'template', addon: null, isRest: true });
    }
  }
  const clearances = profile?.clearances || {};
  const addons = Array.isArray(program?.addons) ? program.addons : [];
  const hiddenAddons = [];
  for (const a of addons) {
    if (!a || typeof a.session !== 'string' || !a.session) continue;
    if (!normaliseDays(a.days).includes(dayKey)) continue;
    if (!addonActive(a, clearances, dateISO, pos ? pos.phaseId : null)) continue;
    const s = sessions[a.session] && typeof sessions[a.session] === 'object' ? sessions[a.session] : null;
    const entry = { sessionId: a.session, session: s, source: 'addon', addon: a, isRest: false };
    if (!addonVisible(a, data, program)) { hiddenAddons.push({ ...entry, reason: 'waiting-physio' }); continue; }
    out.push(entry);
  }
  const override = pos ? weekOverride(pos.phase, pos.week) : null;
  return { date: dateISO, pos, override, sessions: out, hiddenAddons };
}

// ---------------------------------------------------------------- blocks

export function blockKind(b) {
  if (!b || typeof b !== 'object') return 'unknown';
  if (b.circuit && typeof b.circuit === 'object') return 'circuit';
  if (b.intervals && typeof b.intervals === 'object') return 'intervals';
  if (b.minutes != null || Array.isArray(b.minutes_by_week)) return 'cardio';
  if (b.seconds != null) return 'timed';
  if (b.reps != null || b.sets != null) return 'strength';
  return 'unknown';
}

/** "Z3" / "z3" / 3 -> 3 (1-5); anything else -> null. */
export function zoneNumber(z) {
  if (typeof z === 'number' && Number.isInteger(z) && z >= 1 && z <= 5) return z;
  const m = typeof z === 'string' ? /^\s*Z?([1-5])\s*$/i.exec(z) : null;
  return m ? Number(m[1]) : null;
}

/** Caps every zone number in a label such as "Z4-Z5" at max: capZone("Z4-Z5", 3) -> "Z3". */
export function capZone(zone, max = 3) {
  if (typeof zone !== 'string' || !zone) return zone;
  const capped = zone.replace(/Z([1-5])/gi, (_, n) => `Z${Math.min(Number(n), max)}`);
  const parts = capped.split(/\s*[-–]\s*/);
  return parts.length === 2 && parts[0].toUpperCase() === parts[1].toUpperCase() ? parts[0] : capped;
}

/** sets_max caps sets; a deload week or an easy (amber) day halves them once, rounding up. */
export function adjustSets(planned, override, easyDay = false) {
  let s = Math.max(1, toInt(planned, 1));
  const cap = toInt(override?.sets_max, 0);
  if (cap > 0) s = Math.min(s, cap);
  if (override?.deload || easyDay) s = Math.max(1, Math.ceil(s / 2));
  return s;
}

const validMinutes = (v) => v !== null && v !== '' && typeof v !== 'boolean' && Number.isFinite(Number(v)) && Number(v) >= 0;

/**
 * Cardio minutes for a phase-week. minutes_by_week (indexed by phase-week, last value reused)
 * is explicit and wins; otherwise the base minutes are multiplied by the week's cardio_scale.
 * A bad entry inside minutes_by_week (null, "abc") falls back to the nearest earlier valid
 * entry; it never shifts the later weeks (the old filter-then-index did).
 */
export function cardioMinutes(block, week, override) {
  const mbw = Array.isArray(block?.minutes_by_week) ? block.minutes_by_week : [];
  if (mbw.some(validMinutes)) {
    const idx = Math.min(Math.max(toInt(week, 1), 1) - 1, mbw.length - 1);
    for (let i = idx; i >= 0; i--) if (validMinutes(mbw[i])) return Number(mbw[i]);
    return Number(mbw.find(validMinutes));
  }
  const base = Number(block?.minutes);
  if (block?.minutes === null || block?.minutes === '' || !Number.isFinite(base)) return null;
  const scale = Number(override?.cardio_scale);
  return Number.isFinite(scale) && scale > 0 ? Math.max(1, Math.round(base * scale)) : base;
}

/** A positive number from a week override (rounds, circuit_minutes), else null. */
function overrideNumber(v, { integer = false } = {}) {
  if (v === null || v === undefined || v === '' || typeof v === 'boolean') return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return null;
  return integer ? Math.max(1, Math.round(n)) : n;
}

/**
 * The week override fields that change blocks (SPEC 5.2 round 3): zone_cap ("Z3": caps interval
 * work zones, cardio zones and circuit zones), circuit_minutes (replaces circuit minutes) and
 * rounds (replaces interval rounds). Invalid values are ignored.
 */
export function overrideBlockFields(override) {
  const cap = zoneNumber(override?.zone_cap);
  return { zoneCap: cap, circuitMinutes: overrideNumber(override?.circuit_minutes), rounds: overrideNumber(override?.rounds, { integer: true }) };
}

/** Week zone cap for a cardio or circuit block; records zonePlanned / zoneCapped when it bites. */
function weekZoneCap(r, cap) {
  if (!cap || !r.zone) return;
  const capped = capZone(r.zone, cap);
  if (capped !== r.zone) {
    if (r.zonePlanned === undefined) r.zonePlanned = r.zone;
    r.zone = capped;
    r.zoneCapped = true;
  }
  r.zoneCap = `Z${cap}`;
}

/** The RIR shown while loads are held: easy (AMBER) days, fasting periods and deload weeks (SPEC 5.2). */
export const HOLD_RIR = '3-4';

/**
 * Round 4 (BT3-12): on an easy (AMBER) day or in a fasting period (`fasting: true` implies easy-day
 * mode, SPEC 5.2 fasting overlay) strength blocks show the hold RIR, 3–4, whatever the week says;
 * so does a deload week that doesn't set its own `rir` (a designer's deload or taper RIR wins).
 * The block then carries `holdRir: true` and, when it differs, `rirPlanned` (the RIR it replaced).
 */
export function resolveBlock(block, { week = 1, override = null, easyDay = false, fasting = false } = {}) {
  const kind = blockKind(block);
  const ov = overrideBlockFields(override);
  const easy = !!easyDay || !!fasting;
  const r = {
    kind,
    raw: block,
    exercise: typeof block?.exercise === 'string' ? block.exercise : null,
    notes: typeof block?.notes === 'string' ? block.notes : '',
  };
  if (kind === 'strength' || kind === 'timed') {
    r.setsPlanned = Math.max(1, toInt(block.sets, 1));
    r.sets = adjustSets(r.setsPlanned, override, easy);
    r.reps = block.reps != null ? String(block.reps) : null;
    r.seconds = block.seconds != null && Number.isFinite(Number(block.seconds)) ? Number(block.seconds) : null;
    r.rest_s = Number.isFinite(Number(block.rest_s)) ? Number(block.rest_s) : null;
    r.tempo = typeof block.tempo === 'string' ? block.tempo : '';
    const overrideRir = override && override.rir != null && override.rir !== '' ? String(override.rir) : null;
    const rir = overrideRir !== null ? overrideRir : (block.rir != null ? String(block.rir) : '');
    r.load = typeof block.load === 'string' ? block.load : '';
    r.per_side = !!block.per_side;
    // Physio work is "as prescribed"; a timed hold only gets an RIR when the plan gave it one.
    const holds = (easy || (!!override?.deload && overrideRir === null)) && r.load !== 'physio' && (kind === 'strength' || rir !== '');
    r.rir = holds ? HOLD_RIR : rir;
    if (holds) {
      r.holdRir = true;
      if (rir !== HOLD_RIR) r.rirPlanned = rir;
    }
    if (fasting) r.fasting = true;
    const why = [];
    const cap = toInt(override?.sets_max, 0);
    if (cap > 0 && cap < r.setsPlanned) why.push(`capped at ${cap} this week`);
    if (override?.deload) why.push('deload week: sets halved');
    else if (fasting) why.push('fasting period: sets halved');
    else if (easyDay) why.push('easy day: sets halved');
    r.setsNote = why.join('; ');
  } else if (kind === 'cardio') {
    r.minutes = cardioMinutes(block, week, override);
    r.baseMinutes = Number.isFinite(Number(block.minutes)) ? Number(block.minutes) : null;
    r.zone = typeof block.zone === 'string' ? block.zone : '';
    r.byWeek = Array.isArray(block.minutes_by_week) && block.minutes_by_week.length > 0;
    r.scaled = !r.byWeek && override && Number(override.cardio_scale) > 0 && Number(override.cardio_scale) !== 1;
    weekZoneCap(r, ov.zoneCap);
    easyZone(r, easy);
  } else if (kind === 'intervals') {
    const iv = block.intervals || {};
    r.warmup_min = Number.isFinite(Number(block.warmup_min)) ? Number(block.warmup_min) : 0;
    r.cooldown_min = Number.isFinite(Number(block.cooldown_min)) ? Number(block.cooldown_min) : 0;
    r.intervals = {
      work_s: Math.max(0, toInt(iv.work_s, 0)),
      rest_s: Math.max(0, toInt(iv.rest_s, 0)),
      rounds: Math.max(0, toInt(iv.rounds, 0)),
      work_zone: typeof iv.work_zone === 'string' ? iv.work_zone : '',
      rest_zone: typeof iv.rest_zone === 'string' ? iv.rest_zone : '',
    };
    r.easyReplaced = easy;
    r.deload = !!override?.deload;
    // An explicit `rounds` is the week's plan as written (like minutes_by_week): it wins over the
    // deload halving, so a designer's deload value is never halved twice.
    if (ov.rounds !== null) {
      r.roundsPlanned = r.intervals.rounds;
      r.intervals.rounds = ov.rounds;
      r.roundsOverridden = true;
    } else if (r.deload) {
      r.roundsPlanned = r.intervals.rounds;
      r.intervals.rounds = Math.max(1, Math.ceil(r.intervals.rounds / 2));
    }
    const cap = Math.min(r.deload ? 3 : 5, ov.zoneCap || 5);
    if (cap < 5) {
      const capped = capZone(r.intervals.work_zone || `Z${cap}`, cap);
      if (capped !== r.intervals.work_zone) {
        r.workZonePlanned = r.intervals.work_zone;
        r.intervals.work_zone = capped;
        if (ov.zoneCap && (!r.deload || ov.zoneCap < 3)) r.zoneCapped = true;
      } else if (r.deload) r.workZonePlanned = r.intervals.work_zone;
      if (ov.zoneCap) r.zoneCap = `Z${ov.zoneCap}`;
    }
    // Easy day: steady Zone 2 for the same total time (warm-up + rounds + cool-down).
    r.easyMinutes = Math.round(r.warmup_min + r.cooldown_min + (r.intervals.rounds * (r.intervals.work_s + r.intervals.rest_s)) / 60);
  } else if (kind === 'circuit') {
    const c = block.circuit || {};
    r.circuit = {
      minutes: c.minutes !== null && c.minutes !== '' && Number.isFinite(Number(c.minutes)) ? Number(c.minutes) : null,
      rounds: c.rounds !== null && c.rounds !== '' && Number.isFinite(Number(c.rounds)) ? Number(c.rounds) : null,
      items: Array.isArray(c.items) ? c.items.filter((x) => x && typeof x.exercise === 'string') : [],
    };
    if (ov.circuitMinutes !== null) {
      r.circuit.minutesPlanned = r.circuit.minutes;
      r.circuit.minutes = ov.circuitMinutes;
      r.circuitMinutesOverridden = true;
    }
    r.zone = typeof block.zone === 'string' ? block.zone : '';
    weekZoneCap(r, ov.zoneCap);
    easyZone(r, easy);
  }
  return r;
}

/**
 * Stable keys for a session's blocks (raw or resolved): the planned exercise id plus its
 * occurrence in the session ("leg-press:1", "leg-press:2", "circuit:1"; "block<i>:1" for a block
 * without an exercise). These are the keys the logger stores in exercises[].block / cardio[].block.
 */
export function blockKeysOf(blocks) {
  const seen = new Map();
  return (Array.isArray(blocks) ? blocks : []).map((b, i) => {
    const kind = (typeof b?.kind === 'string' && b.kind) || blockKind(b?.raw || b);
    const base = kind === 'circuit' ? 'circuit' : (typeof b?.exercise === 'string' && b.exercise) ? b.exercise : `block${i}`;
    const n = (seen.get(base) || 0) + 1;
    seen.set(base, n);
    return `${base}:${n}`;
  });
}

/**
 * The planned prescription a log stores for a resolved strength or timed block (SPEC 5.2 round 4):
 * {sets, reps, rir, seconds?, load}: the effective one, after sets_max, deload, easy-day or
 * fasting halving. null for other block kinds.
 */
export function plannedFromBlock(rb) {
  if (!rb || (rb.kind !== 'strength' && rb.kind !== 'timed')) return null;
  const out = { sets: Math.max(1, toInt(rb.sets, 1)), reps: rb.reps != null ? String(rb.reps) : null, rir: typeof rb.rir === 'string' ? rb.rir : (rb.rir != null ? String(rb.rir) : ''), load: typeof rb.load === 'string' ? rb.load : '' };
  if (rb.seconds != null && Number.isFinite(Number(rb.seconds))) out.seconds = Number(rb.seconds);
  return out;
}

/** SPEC 5.8 amber ("Zone 2 only"): cap a cardio or circuit zone label at Z2 on an easy day. */
function easyZone(r, easyDay) {
  if (!easyDay || !r.zone) return;
  const capped = capZone(r.zone, 2);
  if (capped !== r.zone) {
    if (r.zonePlanned === undefined) r.zonePlanned = r.zone;
    r.zone = capped;
    r.easyZoneCapped = true;
  }
}

export function resolveSession(session, opts = {}) {
  const blocks = Array.isArray(session?.blocks) ? session.blocks : [];
  return blocks.map((b) => resolveBlock(b, opts));
}

/** Every exercise id a session touches (blocks, circuits and its routines). */
export function sessionExerciseIds(session, routines = {}) {
  const ids = [];
  const push = (x) => { if (typeof x === 'string' && x && !ids.includes(x)) ids.push(x); };
  for (const key of ['warmup', 'cooldown']) {
    const r = routines && typeof session?.[key] === 'string' ? routines[session[key]] : null;
    if (r && Array.isArray(r.items)) r.items.forEach((it) => push(it?.exercise));
  }
  for (const b of Array.isArray(session?.blocks) ? session.blocks : []) {
    push(b?.exercise);
    if (b?.circuit && Array.isArray(b.circuit.items)) b.circuit.items.forEach((it) => push(it?.exercise));
  }
  return ids;
}

// ------------------------------------------------------- progression

/** "8-12" / "8–12" / "10" / "8 to 12 / side" -> {min, max}; null when there is no number. */
export function parseRepRange(reps) {
  if (reps == null) return null;
  const s = String(reps);
  const m = /(\d+)\s*(?:-|–|—|to)\s*(\d+)/.exec(s);
  if (m) {
    const a = +m[1], b = +m[2];
    return { min: Math.min(a, b), max: Math.max(a, b) };
  }
  const one = /(\d+)/.exec(s);
  return one ? { min: +one[1], max: +one[1] } : null;
}

export function incrementFor(exerciseId, exercise, rules) {
  const inc = rules && typeof rules.increments_kg === 'object' && rules.increments_kg ? rules.increments_kg : {};
  const pick = (k) => (Number.isFinite(Number(inc[k])) && Number(inc[k]) > 0 ? Number(inc[k]) : null);
  if (exerciseId && pick(exerciseId) != null) return pick(exerciseId);
  const eq = `${Array.isArray(exercise?.equipment) ? exercise.equipment.join(' ') : ''} ${exerciseId || ''}`.toLowerCase();
  const fallback = pick('default') ?? 2.5;
  if (/kettlebell|(^|[\s-])kb-/.test(eq)) return pick('kettlebell') ?? pick('dumbbell') ?? fallback;
  if (/sandbag/.test(eq)) return pick('sandbag') ?? fallback;
  if (/dumbbell|(^|[\s-])db-/.test(eq)) return pick('dumbbell') ?? fallback;
  if (/barbell|smith/.test(eq)) return pick('barbell') ?? fallback;
  if (/cable/.test(eq)) return pick('cable') ?? pick('machine') ?? fallback;
  if (/machine|leg press|pulldown|leg-press|stack/.test(eq)) return pick('machine') ?? fallback;
  return fallback;
}

const round2 = (n) => Math.round(n * 100) / 100;
const isNumber = (v) => v !== null && v !== undefined && v !== '' && typeof v !== 'boolean' && Number.isFinite(Number(v));

/** The text shown instead of a progression in deload weeks, easy days and fasting (SPEC 5.2). */
export const HOLD_TEXT = 'Hold: same load, RIR 3–4';

/**
 * A logged set counts as performed only with actual values: not undone (done !== false), not
 * marked as a placeholder (placeholder: true / actual: false), numeric reps, and numeric kg when
 * the exercise was loaded (any set of the entry has kg > 0).
 */
export function isPerformedSet(set, { loaded = false } = {}) {
  if (!set || typeof set !== 'object' || set.done === false || set.placeholder === true || set.actual === false) return false;
  if (!isNumber(set.reps) || Number(set.reps) < 0) return false;
  return !loaded || (isNumber(set.kg) && Number(set.kg) >= 0);
}

/** Why progression is paused today: 'red' | 'deload' | 'fasting' | 'easy-day' | null. */
export function holdReason({ deload = false, easyDay = false, easy = false, fasting = false, red = false, readiness = null } = {}) {
  const level = typeof readiness === 'string' ? readiness : readiness && typeof readiness === 'object' ? readiness.level : null;
  if (red || level === 'red') return 'red';
  if (deload) return 'deload';
  if (fasting || (readiness && typeof readiness === 'object' && readiness.fasting)) return 'fasting';
  if (easyDay || easy || level === 'amber') return 'easy-day';
  return null;
}

const HOLD_WHY = {
  deload: 'It’s a deload week, so no extra load or reps.',
  'easy-day': 'It’s an easy day (amber), so no extra load or reps.',
  fasting: 'Fasting period: no extra load or reps, and no new lifts.',
};

/** A planned set count from a number or a planned prescription ({sets}); null when there is none. */
export function plannedSetCount(p) {
  if (isNumber(p) && Number(p) >= 1) return Math.floor(Number(p));
  if (p && typeof p === 'object' && !Array.isArray(p) && isNumber(p.sets) && Number(p.sets) >= 1) return Math.floor(Number(p.sets));
  return null;
}

/**
 * Double progression: when every set last time reached the top of the rep range, add the
 * increment and drop to the bottom of the range; otherwise keep the load and add reps.
 *
 * Round 3 (PE5 / QA1 / SPEC 5.2):
 * - It suggests more only when ALL planned sets were logged with actual values (see
 *   isPerformedSet). `lastSets` may hold every set row of last time (undone ones included).
 *   Otherwise the result is {kind: 'hold', reason: 'incomplete'}: repeat the load, log every set.
 * - In deload weeks, on easy (amber) days, on red days and in fasting periods it never suggests
 *   more: {kind: 'hold', reason, kg: last load, text: HOLD_TEXT ...}. Pass {deload, easyDay,
 *   fasting, red} or {readiness} (a readinessOn() result or a level string).
 *
 * Round 4 (BT1-1 / BT3-1, SPEC 5.2): "all planned sets" means the sets planned LAST TIME, the
 * effective prescription that day (after sets_max, deload, easy-day or fasting halving), never
 * today's block. In order: `planned` (last time's entry.planned, or its set count), the
 * `lastSets.planned` annotation from stats.lastPerformance (entry.planned.sets, or recomputed
 * for older logs), `plannedSets` (only for a plain list of sets), then the number of set rows.
 * So 60 kg × 12, 12 in a 2-set capped week gives "Add 10 kg" next week, and 40 kg × 10, 10 on
 * a deload, easy or fasting day gives "beat last time". Results also carry `planned` (the count
 * judged against) and `performed`.
 */
export function suggestProgression({ reps, lastSets, increment, progressionName = '', plannedSets = null, complete = null, planned = null, lastPlanned = null, ...today } = {}) {
  const range = parseRepRange(reps);
  if (!range) return null;
  const rows = (Array.isArray(lastSets) ? lastSets : []).filter((s) => s && typeof s === 'object');
  const loaded = rows.some((s) => s.done !== false && isNumber(s.kg) && Number(s.kg) > 0);
  const done = rows.filter((s) => isPerformedSet(s, { loaded }));
  const kgs = done.map((s) => Number(s.kg)).filter((n) => Number.isFinite(n) && n > 0);
  const topKg = kgs.length ? Math.max(...kgs) : 0;
  const why = holdReason(today);
  if (why === 'red') {
    return { kind: 'hold', reason: 'red', kg: topKg || null, reps: null, text: 'No training today: readiness is red. Nothing to progress.' };
  }
  const startLoad = `Start around a load you could do for ${range.max + 3}`;
  if (why) {
    if (!done.length) {
      return why === 'fasting'
        ? { kind: 'hold', reason: why, kg: null, reps: null, text: 'Fasting period: no new lifts. Skip this one or swap it for an exercise you know.' }
        : { kind: 'hold', reason: why, kg: null, reps: range.min, text: `${startLoad} and keep RIR 3–4 today. ${HOLD_WHY[why]}` };
    }
    return { kind: 'hold', reason: why, kg: topKg || null, reps: range.min, text: `${HOLD_TEXT}. ${HOLD_WHY[why]}` };
  }
  if (!done.length) {
    return { kind: 'start', kg: null, reps: range.min, text: `${startLoad}, then let double progression find your level within 2 sessions.` };
  }
  const explicit = plannedSetCount(planned) ?? plannedSetCount(lastPlanned);
  const annotated = plannedSetCount(lastSets?.planned);
  const plan = explicit ?? annotated ?? plannedSetCount(plannedSets) ?? rows.length;
  // An explicit `planned` re-judges completeness itself; otherwise lastPerformance's verdict stands.
  if (complete === false || (explicit === null && lastSets?.complete === false) || done.length < plan) {
    const load = topKg > 0 ? `${topKg} kg` : 'the same version';
    return {
      kind: 'hold', reason: 'incomplete', kg: topKg || null, reps: range.min, planned: plan, performed: done.length,
      text: `Last time ${done.length} of ${plan} sets were logged with what you actually did. Repeat ${load} and log every set before adding anything.`,
    };
  }
  const atTop = done.every((s) => Number(s.reps) >= range.max);
  if (atTop) {
    if (topKg > 0) {
      const kg = round2(topKg + (increment || 2.5));
      return { kind: 'add-load', kg, reps: range.min, planned: plan, performed: done.length, text: `Every set hit ${range.max}. Add ${increment || 2.5} kg: ${kg} kg for ${range.min}+ reps.` };
    }
    return {
      kind: 'progress', kg: null, reps: range.min, planned: plan, performed: done.length,
      text: progressionName
        ? `Every set hit ${range.max}. Move on to ${progressionName}, or slow the lowering to 4 seconds.`
        : `Every set hit ${range.max}. Make it harder: slow the lowering to 4 seconds or add a pause.`,
    };
  }
  return {
    kind: 'add-reps', kg: topKg || null, reps: range.max, planned: plan, performed: done.length,
    text: topKg > 0
      ? `Stay at ${topKg} kg and beat last time: add a rep to any set below ${range.max}.`
      : `Beat last time: add a rep to any set below ${range.max}.`,
  };
}
/** Feature flag for the UI: this suggestProgression judges against last time's planned sets (round 4). */
suggestProgression.plannedAware = true;
