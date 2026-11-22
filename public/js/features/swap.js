// Exercise swaps for when the kit is busy or missing (pure, no DOM).
// Options always respect the clearance gates on the day: easier versions (regressions),
// harder versions (progressions), then other exercises from the same category.

import { isGateMet } from '../schedule.js';

const PHYSIO_ONLY = new Set(['rehab']);

/**
 * {easier, harder, similar}: arrays of exercise ids that are unlocked on `date`.
 * exclude: ids already in the session (never offered twice). unavailable: ids your gym can't do
 * (profile.unavailable_exercises), never offered. Ids missing from the library are never offered
 * (fail closed). Rehab work is physio-prescribed, so it is never offered as a "similar" swap.
 */
export function swapOptions(exerciseId, { exById, exercises, clearances, date, exclude = [], unavailable = [], limit = 8 }) {
  const ex = exById.get(exerciseId) || null;
  const open = (id) => {
    const e = exById.get(id);
    return !!e && isGateMet(e.gate, clearances, date);
  };
  const skip = new Set([exerciseId, ...exclude, ...(Array.isArray(unavailable) ? unavailable : [])]);
  const easier = (ex?.regressions || []).filter((id) => open(id) && !skip.has(id));
  const harder = (ex?.progressions || []).filter((id) => open(id) && !skip.has(id) && !easier.includes(id));
  let similar = [];
  if (ex && ex.category && !PHYSIO_ONLY.has(ex.category)) {
    similar = (Array.isArray(exercises) ? exercises : [])
      .filter((e) => e && e.category === ex.category && !skip.has(e.id) && !easier.includes(e.id) && !harder.includes(e.id) && isGateMet(e.gate, clearances, date))
      .sort((a, b) => String(a.name).localeCompare(String(b.name)))
      .slice(0, limit)
      .map((e) => e.id);
  }
  return { easier, harder, similar };
}

export const hasSwaps = (opts) => !!opts && (opts.easier.length + opts.harder.length + opts.similar.length) > 0;

const isNum = (v) => v !== null && v !== undefined && v !== '' && typeof v !== 'boolean' && Number.isFinite(Number(v));

/**
 * How much of an entry was actually done on the exercise it names: ticked sets for set work,
 * or 1 when a cardio entry has minutes, distance or rounds logged. Performed work belongs to the
 * exercise it was done on, so it is never relabelled by a swap.
 */
export function performedCount(entry) {
  if (!entry || typeof entry !== 'object') return 0;
  if (Array.isArray(entry.sets)) return entry.sets.filter((s) => s && s.done).length;
  return isNum(entry.minutes) || isNum(entry.distance_km) || isNum(entry.rounds) ? 1 : 0;
}

/**
 * What a swap from `entry` to `newId` may do: 'swap' (relabel the whole block: nothing was done
 * on it yet), 'none' (it already is that exercise) or 'extra' (sets were ticked: they stay on the
 * exercise they were done on, and the stand-in is logged fresh as an extra exercise).
 */
export function swapMode(entry, newId) {
  if (!newId) return 'none';
  if (entry && entry.exercise === newId) return 'none';
  return performedCount(entry) > 0 ? 'extra' : 'swap';
}

/** The message shown when a block with ticked sets is swapped (round 4 review, finding 6). */
export const SWAP_TICKED_TEXT = 'Untick your sets or log the swap as an extra exercise';

/**
 * A fresh extra entry for a stand-in that couldn't replace a block because sets were ticked on
 * it: its own key, no numbers, `sets` blank rows (set work) or an empty cardio record.
 */
export function standInEntry(newId, { key, sets = 2, cardio = false, zone = 'Z2' } = {}) {
  if (cardio) return { block: key, extra: true, exercise: newId, minutes: null, zone, avg_hr: null, distance_km: null, ascent_m: null, level: null, notes: '' };
  return { block: key, extra: true, exercise: newId, sets: Array.from({ length: Math.max(1, Math.round(Number(sets)) || 1) }, () => ({ kg: null, reps: null, seconds: null, rir: null, done: false })), notes: '' };
}

/**
 * Applies a swap to a logged entry in place. The planned exercise is kept in `swapped_from`
 * (the first one, so swapping twice still remembers the plan). Set numbers are cleared when
 * nothing has been ticked yet, because loads don't carry over between exercises.
 * Round 4: an entry with ticked sets (or logged cardio) is never relabelled; it is returned
 * unchanged (see swapMode / standInEntry for logging the stand-in as an extra exercise).
 */
export function applySwap(entry, plannedId, newId) {
  if (!entry || !newId) return entry;
  if (swapMode(entry, newId) === 'extra') return entry;
  if (newId === plannedId) {
    delete entry.swapped_from;
    entry.exercise = plannedId;
  } else {
    entry.swapped_from = entry.swapped_from || plannedId;
    entry.exercise = newId;
  }
  if (Array.isArray(entry.sets) && !entry.sets.some((s) => s && s.done)) {
    entry.sets = entry.sets.map(() => ({ kg: null, reps: null, seconds: null, rir: null, done: false }));
  }
  return entry;
}
