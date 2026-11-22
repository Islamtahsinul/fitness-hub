// Helpers shared by several views.

import { content, prettifyId } from '../content.js';
import { buildTimeline, sessionExerciseIds } from '../schedule.js';
import { hrMax, ageFrom, zoneRange } from '../calc.js';
import { readinessFor, isLocked } from '../features/safety.js';

const TYPE_LABEL = { strength: 'Strength', cardio: 'Cardio', intervals: 'Intervals', hike: 'Hike', circuit: 'Circuit', mobility: 'Mobility', rehab: 'Rehab', rest: 'Rest' };

export function typeLabel(t) {
  return TYPE_LABEL[t] || (typeof t === 'string' && t ? t.charAt(0).toUpperCase() + t.slice(1) : 'Session');
}

export function timelineFor(ctx) {
  return content.program ? buildTimeline(content.program, ctx.data.profile) : null;
}

export function sessionName(id) {
  if (id === 'rest') return 'Rest';
  if (id === 'adhoc') return 'Ad-hoc session';
  const s = content.program?.sessions?.[id];
  return s && typeof s.name === 'string' && s.name ? s.name : prettifyId(id);
}

export const dash = (v) => String(v ?? '').replace(/(\d)\s*-\s*(\d)/g, '$1–$2');

export function easyMinutes(rb) {
  if (Number.isFinite(rb?.easyMinutes)) return rb.easyMinutes;
  const iv = rb.intervals || {};
  return Math.round((rb.warmup_min || 0) + (rb.cooldown_min || 0) + ((iv.rounds || 0) * ((iv.work_s || 0) + (iv.rest_s || 0))) / 60);
}

export const PHYSIO_ID = 'x-physio-programme';
export const isPhysioBlock = (rb) => rb && rb.exercise === PHYSIO_ID;

/** 45 -> "45 s", 90 -> "90 s", 150 -> "2 min 30 s", 900 -> "15 min" */
export function fmtSecs(sec) {
  const s = Math.round(Number(sec));
  if (!Number.isFinite(s)) return '?';
  if (s < 120) return `${s} s`;
  const m = Math.floor(s / 60);
  const r = s % 60;
  return r ? `${m} min ${r} s` : `${m} min`;
}

/** Short target text for a resolved block, e.g. "3 × 8–12, RIR 2–3". */
export function blockTarget(rb) {
  if (isPhysioBlock(rb)) return `${fmtSecs((rb.seconds || 0) * (rb.sets || 1))}, as your physio prescribed`;
  switch (rb.kind) {
    case 'strength': return `${rb.sets} × ${dash(rb.reps ?? '?')}${rb.per_side ? ' / side' : ''}${rb.rir ? `, RIR ${dash(rb.rir)}` : ''}`;
    case 'timed': return `${rb.sets > 1 ? `${rb.sets} × ` : ''}${fmtSecs(rb.seconds)}${rb.per_side ? ' / side' : ''}`;
    case 'cardio': return `${rb.minutes ?? '?'} min${rb.zone ? ` ${rb.zone}` : ''}`;
    case 'intervals': {
      const iv = rb.intervals;
      if (rb.easyReplaced) return `Easy day: ${easyMinutes(rb)} min steady Zone 2`;
      const how = rb.deload ? `at ${iv.work_zone} (deload)` : rb.zoneCapped ? `at ${iv.work_zone}` : 'hard';
      return `${iv.rounds} × ${iv.work_s} s ${how} / ${iv.rest_s} s easy`;
    }
    case 'circuit': {
      const c = rb.circuit;
      return c.minutes ? `${c.minutes} min circuit${rb.zone ? `, ${rb.zone}` : ''}` : c.rounds ? `${c.rounds} rounds` : 'Circuit';
    }
    default: return '';
  }
}

export function blockLabel(rb) {
  if (rb.kind === 'circuit') return 'Circuit';
  return rb.exercise;
}

/**
 * Readiness for a day, from the single source (calc.readinessOn via features/safety.js).
 * 'unknown' means not checked in yet: no answers, or only a weight.
 */
export function readinessOn(ctx, date) {
  return readinessFor(ctx.data, date);
}

export function hrmaxFor(profile, today) {
  return hrMax(ageFrom(profile.birth_year, today), profile.hrmax_override);
}

export function zoneText(zone, profile, today) {
  const r = zoneRange(zone, hrmaxFor(profile, today));
  return r ? `${zone}, ${r.lo}–${r.hi} bpm` : zone;
}

export function findWorkout(data, date, sessionId) {
  const list = data.workouts.filter((w) => w.date === date && w.session_id === sessionId);
  list.sort((a, b) => (a.status === 'done' ? 0 : 1) - (b.status === 'done' ? 0 : 1));
  return list[0] || null;
}

export function routineFor(id) {
  const r = typeof id === 'string' ? content.program?.routines?.[id] : null;
  return r && typeof r === 'object' ? r : null;
}

/** Exercises in a session that are locked on a date. Ids missing from the library count as locked (fail closed). */
export function lockedIn(session, data, date) {
  return sessionExerciseIds(session, content.program?.routines || {}).filter((id) => isLocked(id, date, data));
}

export function isRestId(id) {
  return id === 'rest' || content.program?.sessions?.[id]?.type === 'rest';
}
