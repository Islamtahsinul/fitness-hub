// Plate maths for the plate-loaded leg press (pure, no DOM).
// Convention: the kg you log is the plates you load, both sides together (the sled isn't counted).

export const DEFAULT_PLATES = [25, 20, 15, 10, 5, 2.5, 1.25];
/** Above these, the number is almost certainly a typo (QA14): 400 kg total, or more than 8 plates a side. */
export const MAX_TOTAL_KG = 400;
export const MAX_PLATES_PER_SIDE = 8;

/** Why a total isn't sensible to load ('total' | 'plates'), or null when it's fine. */
export function plateLimit(result) {
  if (!result) return null;
  if (result.total > MAX_TOTAL_KG) return 'total';
  if (result.exact && result.stack && result.stack.length > MAX_PLATES_PER_SIDE) return 'plates';
  return null;
}
const UNIT = 0.25; // kg; every plate size is a multiple of this

const toUnits = (kg) => Math.round(Number(kg) / UNIT);

export function cleanPlates(plates) {
  const list = (Array.isArray(plates) ? plates : DEFAULT_PLATES)
    .map(Number).filter((p) => Number.isFinite(p) && p > 0 && p <= 50 && Math.abs(p / UNIT - Math.round(p / UNIT)) < 1e-9);
  return [...new Set(list)].sort((a, b) => b - a);
}

/** Fewest plates that make exactly `kg` per side, largest first; null if it can't be made. */
export function plateStack(kgPerSide, plates = DEFAULT_PLATES) {
  const sizes = cleanPlates(plates);
  if (!Number.isFinite(Number(kgPerSide)) || Math.abs(Number(kgPerSide) / UNIT - Math.round(Number(kgPerSide) / UNIT)) > 1e-6) return null;
  const target = toUnits(kgPerSide);
  if (!(target >= 0) || target > 4000) return null;
  if (target === 0) return [];
  const best = new Array(target + 1).fill(Infinity);
  const pick = new Array(target + 1).fill(-1);
  best[0] = 0;
  const units = sizes.map(toUnits);
  for (let t = 1; t <= target; t++) {
    for (let i = 0; i < units.length; i++) {
      const u = units[i];
      if (u <= t && best[t - u] + 1 < best[t]) { best[t] = best[t - u] + 1; pick[t] = i; }
    }
  }
  if (!Number.isFinite(best[target])) return null;
  const out = [];
  for (let t = target; t > 0; t -= units[pick[t]]) out.push(sizes[pick[t]]);
  return out.sort((a, b) => b - a);
}

/**
 * Per-side breakdown for a total. Returns {total, perSide, stack, exact, below, above}:
 * below/above are the nearest loadable totals when the exact total can't be made.
 */
export function platesFor(totalKg, plates = DEFAULT_PLATES) {
  const total = Number(totalKg);
  if (!Number.isFinite(total) || total < 0) return null;
  const perSide = total / 2;
  const stack = plateStack(perSide, plates);
  if (stack) return { total, perSide, stack, exact: true, below: null, above: null };
  const baseLo = Math.floor(perSide / UNIT + 1e-9) * UNIT;
  const baseHi = Math.ceil(perSide / UNIT - 1e-9) * UNIT;
  let below = null;
  let above = null;
  for (let k = 0; k <= 400 && (below === null || above === null); k++) {
    const lo = baseLo - k * UNIT;
    const hi = baseHi + k * UNIT;
    if (below === null && lo >= 0 && lo < perSide && plateStack(lo, plates)) below = Math.round(lo * 2 * 100) / 100;
    if (above === null && hi > perSide && plateStack(hi, plates)) above = Math.round(hi * 2 * 100) / 100;
  }
  return { total, perSide, stack: null, exact: false, below, above };
}

/** "25 + 5 + 2.5" (or "nothing: the empty sled"). */
export function stackText(stack) {
  if (!stack) return '';
  if (!stack.length) return 'no plates';
  const nf = new Intl.NumberFormat('en-GB', { maximumFractionDigits: 2 });
  return stack.map((p) => nf.format(p)).join(' + ');
}

/** Exercises loaded with plates on the plate-loaded leg press. */
export function isPlateLoaded(exercise) {
  if (!exercise) return false;
  const id = typeof exercise === 'string' ? exercise : exercise.id;
  const eq = typeof exercise === 'object' && Array.isArray(exercise.equipment) ? exercise.equipment.join(' ').toLowerCase() : '';
  return /(^|-)leg-press/.test(String(id || '')) || /leg press/.test(eq);
}
