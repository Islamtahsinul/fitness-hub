// Plate maths dialog for the plate-loaded leg press: type the total you want to log and see
// what goes on each side. Your gym's plate sizes are remembered in data.ui.plates_kg.

import { h, s, uid, fmtNum, selectOnFocus } from '../dom.js';
import { DEFAULT_PLATES, cleanPlates, platesFor, stackText, plateLimit, MAX_TOTAL_KG, MAX_PLATES_PER_SIDE } from './plates.js';
import * as store from '../store.js';

const ALL_SIZES = [25, 20, 15, 10, 5, 2.5, 1.25, 0.5];

export function savedPlates(data) {
  const p = data?.ui?.plates_kg;
  const list = cleanPlates(Array.isArray(p) && p.length ? p : DEFAULT_PLATES);
  return list.length ? list : DEFAULT_PLATES.slice();
}

/** Draws one side of the sled: plates as bars, taller for heavier plates. */
function plateDrawing(stack) {
  const W = 220;
  const H = 96;
  const svg = s('svg', { width: W, height: H, viewBox: `0 0 ${W} ${H}`, class: 'plate-svg', 'aria-hidden': 'true', focusable: 'false' });
  svg.append(s('rect', { x: 4, y: H / 2 - 5, width: W - 8, height: 10, rx: 3, class: 'plate-sleeve' }));
  let x = 14;
  for (const p of stack.slice(0, 14)) {
    const hh = Math.max(26, Math.min(88, 26 + (p / 25) * 62));
    const w = p >= 10 ? 12 : p >= 5 ? 10 : 8;
    svg.append(s('rect', { x, y: (H - hh) / 2, width: w, height: hh, rx: 2.5, class: `plate plate-${String(p).replace('.', '-')}` }));
    x += w + 3;
  }
  return svg;
}

/**
 * Opens the calculator. total: starting total in kg (optional). onUse(kg): called with the total
 * when you press "Use this weight" (the logger fills the next empty set with it).
 */
export function openPlateCalc({ total = null, data, onUse = null, title = 'Leg press plates' }) {
  const dlg = h('dialog', { class: 'modal plate-dialog', 'aria-labelledby': 'plate-title' });
  const prev = document.activeElement;
  const close = () => { dlg.close(); dlg.remove(); if (prev && prev.isConnected && prev.focus) prev.focus({ preventScroll: true }); };
  let plates = savedPlates(data);
  const inputId = uid('plate');
  const input = selectOnFocus(h('input', { id: inputId, class: 'input', type: 'number', inputmode: 'decimal', min: '0', step: '1.25', value: Number(total) > 0 ? String(total) : '' }));
  const out = h('div', { class: 'plate-out', 'aria-live': 'polite' });
  const sizes = h('div', { class: 'chip-row plate-sizes', role: 'group', 'aria-label': 'Plate sizes in your gym' });
  let useBtn = null;
  const current = () => {
    const v = Number(String(input.value).replace(',', '.'));
    return Number.isFinite(v) && v >= 0 ? v : null;
  };
  const draw = () => {
    const v = current();
    const r = v === null ? null : platesFor(v, plates);
    const limit = plateLimit(r);
    if (useBtn) useBtn.disabled = !(r && r.exact && v > 0) || !!limit;
    if (!r) { out.replaceChildren(h('p', { class: 'muted' }, 'Type the total you want on the sled: both sides together, not counting the sled itself.')); return; }
    if (limit) {
      out.replaceChildren(h('p', { class: 'field-issue', dataset: { level: 'error' }, role: 'alert' },
        limit === 'total'
          ? `${fmtNum(v, 2)} kg is over ${MAX_TOTAL_KG} kg, more than anyone should load here. Check the number: did you mean ${fmtNum(v / 10, 2)} kg?`
          : `That’s ${r.stack.length} plates a side, more than ${MAX_PLATES_PER_SIDE}. Check the number, or switch on bigger plates below.`));
      return;
    }
    if (r.exact) {
      out.replaceChildren(
        h('p', { class: 'plate-side' }, h('span', { class: 'plate-side-kg' }, `${fmtNum(r.perSide, 2)} kg`), ' each side'),
        h('p', { class: 'plate-load' }, r.stack.length ? `Load ${stackText(r.stack)} on each side.` : 'No plates: the empty sled.'),
        r.stack.length ? plateDrawing(r.stack) : null);
      return;
    }
    const pick = (kg) => h('button', { type: 'button', class: 'btn btn-sm', onClick: () => { input.value = String(kg); draw(); } }, `${fmtNum(kg, 2)} kg`);
    out.replaceChildren(
      h('p', { class: 'plate-load' }, `${fmtNum(v, 2)} kg can’t be split evenly with your plates.`),
      h('div', { class: 'row', style: { 'margin-top': '8px' } }, h('span', { class: 'small muted' }, 'Closest you can load:'), r.below !== null ? pick(r.below) : null, r.above !== null ? pick(r.above) : null));
  };
  const drawSizes = () => {
    sizes.replaceChildren(...ALL_SIZES.map((p) => h('button', {
      type: 'button', class: 'chip chip-btn chip-toggle', 'aria-pressed': String(plates.includes(p)),
      onClick: () => {
        const next = plates.includes(p) ? plates.filter((x) => x !== p) : [...plates, p];
        if (!next.length) return;
        plates = cleanPlates(next);
        if (data) { data.ui = data.ui && typeof data.ui === 'object' ? data.ui : {}; data.ui.plates_kg = plates; store.touch(); }
        drawSizes();
        draw();
      },
    }, `${fmtNum(p, 2)} kg`)));
  };
  input.addEventListener('input', draw);
  drawSizes();
  draw();
  useBtn = onUse ? h('button', { type: 'button', class: 'btn btn-primary', onClick: () => { const v = current(); if (v !== null) { onUse(v); close(); } } }, 'Use this weight') : null;
  dlg.append(h('div', { class: 'modal-body' },
    h('h2', { class: 'modal-title', id: 'plate-title' }, title),
    h('div', { class: 'field' },
      h('label', { class: 'field-label', for: inputId }, 'Total plates, both sides'),
      h('div', { class: 'input-unit', style: { 'max-width': '200px' } }, input, h('span', { class: 'unit', 'aria-hidden': 'true' }, 'kg'))),
    out,
    h('div', { class: 'field' }, h('p', { class: 'field-label' }, 'Plate sizes in your gym'), sizes,
      h('p', { class: 'field-hint' }, 'Tap a size to switch it off or on. The hub remembers this.')),
    h('div', { class: 'modal-actions' }, h('button', { type: 'button', class: 'btn', onClick: close }, 'Close'), useBtn)));
  draw();
  dlg.addEventListener('cancel', (e) => { e.preventDefault(); close(); });
  dlg.addEventListener('click', (e) => { if (e.target === dlg) close(); });
  document.body.appendChild(dlg);
  dlg.showModal();
  input.focus();
  input.select();
}
