// Set targets and set text for the logger (pure, no DOM).
//
// PE5: the logger shows each set's target as real, editable numbers (not placeholders), and
// ticking a set records exactly what is shown. These helpers work out those numbers and the
// words that say what "All sets done" will record.

import { parseRepRange } from '../schedule.js';

const isNum = (v) => v !== null && v !== undefined && v !== '' && typeof v !== 'boolean' && Number.isFinite(Number(v));
const nf = new Intl.NumberFormat('en-GB', { maximumFractionDigits: 2 });
const n = (v) => nf.format(Number(v));
const round2 = (v) => Math.round(v * 100) / 100;

/** The lower end of an RIR prescription ("1-2" -> 1, "3" -> 3), or null. */
export function rirFloor(rir) {
  const r = parseRepRange(rir);
  return r ? r.min : null;
}

/** Last time's sets that were really done, in order (not unticked, not placeholders). */
function performedSets(lastSets, timed) {
  return (Array.isArray(lastSets) ? lastSets : []).filter((s) => s && typeof s === 'object' && s.done !== false
    && s.placeholder !== true && s.actual !== false && (timed ? isNum(s.seconds) : isNum(s.reps)));
}

/**
 * Per-set targets: [{kg, reps, seconds}] (numbers or null) for `count` sets.
 *
 * Round 4 (gym-floor review): every set starts from LAST TIME'S MATCHING SET (set 1 from set 1,
 * set 2 from set 2...; sets beyond last time's copy its final set), so a ramp such as 60 × 12,
 * 70 × 10, 80 × 10 is prefilled as a ramp, never as the top load on every set. Then:
 *  - add load (every set hit the top): each set's own load plus the step, so the top set lands
 *    on the suggested load; reps back to the bottom of the range.
 *  - add reps: the same load per set, and one more rep on a set below the top of the range, but
 *    only where the planned RIR leaves room for it.
 *  - hold (deload, easy day, fasting, or last time incomplete): the same load and never more reps
 *    than last time.
 *  - no log yet: the bottom of the range, no load.
 * The planned RIR is respected throughout: `rir` is today's (e.g. "1-2"), `lastRir` last time's
 * planned RIR. A set's reserve last time is its logged RIR, else the lower end of `lastRir`; when
 * today asks for more reserve than that, the reps drop by the difference (never below 1), and a
 * rep is only added when the set had at least one rep to spare beyond today's RIR. So a set done
 * at RIR 2 is never prefilled +2 reps (RIR 0). With no RIR known at all, add reps adds one.
 * Timed blocks: the planned seconds.
 */
export function setTargets({ kind = 'strength', reps = null, seconds = null, count = 1, lastSets = [], suggestion = null, showKg = true, rir = null, lastRir = null }) {
  const timed = kind === 'timed';
  const last = performedSets(lastSets, timed);
  const lastAt = (k) => last[k] || last[last.length - 1] || null;
  const range = parseRepRange(reps);
  const s = suggestion && typeof suggestion === 'object' ? suggestion : null;
  const todayRir = rirFloor(rir);
  const plannedLastRir = rirFloor(lastRir);
  const loads = last.map((x) => Number(x.kg)).filter((v) => Number.isFinite(v) && v > 0);
  const topKg = loads.length ? Math.max(...loads) : null;
  const step = s?.kind === 'add-load' && isNum(s.kg) && topKg !== null ? Number(s.kg) - topKg : null;
  const out = [];
  for (let k = 0; k < Math.max(0, count); k++) {
    const l = lastAt(k);
    const lastKg = showKg && isNum(l?.kg) ? Number(l.kg) : null;
    if (timed) {
      out.push({ kg: lastKg, reps: null, seconds: isNum(seconds) ? Number(seconds) : isNum(l?.seconds) ? Number(l.seconds) : null });
      continue;
    }
    const lastReps = isNum(l?.reps) ? Number(l.reps) : null;
    const reserve = isNum(l?.rir) ? Number(l.rir) : plannedLastRir;
    // + : reps that set had in hand beyond today's planned RIR; - : today asks for more reserve.
    const spare = reserve !== null && todayRir !== null ? reserve - todayRir : null;
    const fewer = (v) => (spare !== null && spare < 0 ? Math.max(1, v + spare) : v);
    let kg = lastKg;
    let r = lastReps !== null ? fewer(lastReps) : range ? range.min : null;
    if (s?.kind === 'add-load') {
      kg = !showKg ? null : lastKg !== null && step !== null ? round2(lastKg + step) : isNum(s.kg) ? Number(s.kg) : lastKg;
      r = range ? range.min : r;
    } else if (s?.kind === 'add-reps') {
      if (kg === null && showKg && isNum(s.kg)) kg = Number(s.kg);
      if (lastReps === null) r = range ? range.min : null;
      else if (range && lastReps < range.max && (spare === null || spare >= 1)) r = lastReps + 1;
    } else if (s?.kind === 'hold') {
      if (kg === null && showKg && isNum(s.kg)) kg = Number(s.kg);
      if (lastReps === null) r = range ? range.min : isNum(s.reps) ? Number(s.reps) : null;
    } else if (s?.kind === 'start') {
      kg = null;
      r = range ? range.min : r;
    } else if (s?.kind === 'progress') {
      r = range ? range.min : r;
    }
    out.push({ kg, reps: isNum(r) ? r : null, seconds: null });
  }
  return out;
}

/**
 * The kg a set below should show once a set above it is ticked (BT1-2, round 4). Straight sets
 * take the ticked kg; a ramp keeps its shape and moves by the same amount the ticked set moved
 * from its own target. `target`: this row's prefilled kg; `aboveTarget` / `aboveKg`: the ticked
 * row's prefilled and recorded kg. Returns this row's kg (unchanged when nothing moved).
 */
export function carriedKg(target, aboveTarget, aboveKg) {
  if (!isNum(aboveKg)) return isNum(target) ? Number(target) : null;
  if (!isNum(target)) return Number(aboveKg);
  if (!isNum(aboveTarget)) return Number(target);
  return round2(Number(target) + (Number(aboveKg) - Number(aboveTarget)));
}

/** "40 kg × 10", "× 12", "45 s", "12.5 kg × 8 + 30 s"; '' for an empty set. */
export function setText(s) {
  if (!s) return '';
  const kg = isNum(s.kg) ? `${n(s.kg)} kg` : '';
  const reps = isNum(s.reps) ? `${kg ? ' × ' : ''}${n(s.reps)}${kg ? '' : ' reps'}` : '';
  const secs = isNum(s.seconds) ? `${kg || reps ? ' ' : ''}${n(s.seconds)} s` : '';
  return `${kg}${reps}${secs}`.trim();
}

/** What a batch of sets records, briefly: "3 × 10 at 40 kg", or each set listed when they differ. */
export function setsSummary(sets) {
  const list = (Array.isArray(sets) ? sets : []).filter(Boolean);
  if (!list.length) return '';
  const same = list.every((s) => s.kg === list[0].kg && s.reps === list[0].reps && s.seconds === list[0].seconds);
  if (same) {
    const s = list[0];
    if (isNum(s.reps)) return `${list.length} × ${n(s.reps)}${isNum(s.kg) ? ` at ${n(s.kg)} kg` : ''}${isNum(s.seconds) ? `, ${n(s.seconds)} s` : ''}`;
    if (isNum(s.seconds)) return `${list.length} × ${n(s.seconds)} s${isNum(s.kg) ? ` at ${n(s.kg)} kg` : ''}`;
    if (isNum(s.kg)) return `${list.length} × ${n(s.kg)} kg`;
    return `${list.length} set${list.length === 1 ? '' : 's'} with no numbers`;
  }
  return list.map((s) => setText(s) || 'no numbers').join(', ');
}

/** A set counts as performed only with a rep count (or a hold time for timed work). */
export const setHasActual = (s, timed = false) => !!s && (timed ? isNum(s.seconds) : isNum(s.reps));
