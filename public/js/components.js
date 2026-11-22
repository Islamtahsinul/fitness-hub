// Shared UI pieces built with the safe DOM helpers.

import { h, s, uid, extLink, openDrawer, fmtNum, isHttpUrl, selectOnFocus } from './dom.js';
import { ukDateField } from './features/datefield.js';
import * as store from './store.js';
import { fmtDay, WEEKDAYS, weekdayIndex } from './dates.js';
import { content, exName } from './content.js';
import { isGateMet, gateList } from './schedule.js';
import { isNum } from './calc.js';
import { exerciseHistory } from './stats.js';
import { timeChart } from './charts.js';
import { READINESS_COPY, isLocked, isAvailable, gateOf } from './features/safety.js';
import { offerUndo } from './features/undo.js';

// ------------------------------------------------------------ layout

export function pageHead({ title, lede = null, actions = null, kicker = null }) {
  return h('header', { class: 'page-head' },
    h('div', { class: 'page-head-text' },
      kicker ? h('p', { class: 'page-kicker' }, kicker) : null,
      h('h1', { class: 'page-title', tabindex: '-1', id: 'page-title' }, title),
      lede ? h('p', { class: 'page-lede' }, lede) : null),
    actions ? h('div', { class: 'page-actions' }, actions) : null);
}

export function section({ title, sub = null, actions = null, cls = null, id = null, level = 2 }, ...kids) {
  return h('section', { class: ['section', cls], id, 'aria-labelledby': id ? `${id}-h` : null },
    title ? h('div', { class: 'section-head' },
      h('div', null,
        h(`h${level}`, { class: 'section-title', id: id ? `${id}-h` : null }, title),
        sub ? h('p', { class: 'section-sub' }, sub) : null),
      actions ? h('div', { class: 'section-actions' }, actions) : null) : null,
    ...kids);
}

/** A card. BT2-10: `class` may be a string or a (nested) array; it's flattened, never "a,b". */
export function sheet(props, ...kids) {
  const extra = [props?.class].flat(Infinity).filter((c) => typeof c === 'string' && c);
  return h('div', { ...(props || {}), class: ['sheet', ...extra] }, ...kids);
}

export function emptyState({ title, body = '', action = null }) {
  return h('div', { class: 'empty' },
    h('p', { class: 'empty-title' }, title),
    body ? h('p', { class: 'empty-body' }, body) : null,
    action);
}

/**
 * Section-level error boundary: runs build() and, if it throws, shows a quiet inline notice
 * instead, so one broken section never takes the rest of the page with it.
 */
export function guard(label, build) {
  try {
    return build();
  } catch (err) {
    console.error(`${label} failed`, err);
    return h('div', { class: 'notice notice-quiet section-error', role: 'note' },
      h('p', null, h('strong', null, `${label} couldn’t be shown. `), 'The rest of the page is fine, and your data is safe.'),
      h('details', { class: 'disclose' }, h('summary', null, 'Details'), h('p', { class: 'small muted' }, String(err && err.message ? err.message : err))));
  }
}

/**
 * Removes `item` from `list` straight away and offers Undo next to the list (the `slot` named
 * by the view with undoSlot()), until you press Undo or Dismiss. after() redraws whatever shows
 * the list; it runs after the delete and again after an undo.
 */
export function deleteWithUndo({ list, item, message, after = () => {}, slot = 'page' }) {
  const i = list.indexOf(item);
  if (i < 0) return;
  list.splice(i, 1);
  store.touch();
  after();
  offerUndo(slot, {
    message,
    focus: true,
    undo: () => {
      if (!list.includes(item)) list.splice(Math.min(i, list.length), 0, item);
      store.touch();
      after();
    },
  });
}

export function missingContent(label, extra = '') {
  return h('div', { class: 'notice notice-quiet', role: 'note' },
    h('p', null, `${label} isn’t ready yet. It’s still being written, so refresh the page later to load it.`),
    extra ? h('p', { class: 'small' }, extra) : null);
}

export function chip(text, cls = null, props = {}) {
  return h('span', { ...props, class: ['chip', cls] }, text);
}

// ------------------------------------------------------------ icons

export function statusIcon(level, size = 18) {
  const svg = s('svg', { width: size, height: size, viewBox: '0 0 20 20', class: `status-icon si-${level}`, 'aria-hidden': 'true', focusable: 'false' });
  if (level === 'green') {
    svg.append(s('circle', { cx: 10, cy: 10, r: 9, class: 'si-fill' }), s('path', { d: 'M5.8 10.4l2.8 2.8 5.6-6', class: 'si-mark' }));
  } else if (level === 'amber') {
    svg.append(s('path', { d: 'M10 1.6l8.6 15.4H1.4z', class: 'si-fill' }), s('path', { d: 'M10 7v4.6', class: 'si-mark' }), s('circle', { cx: 10, cy: 14.3, r: 1.1, class: 'si-dot' }));
  } else if (level === 'red') {
    svg.append(s('path', { d: 'M6.3 1h7.4L19 6.3v7.4L13.7 19H6.3L1 13.7V6.3z', class: 'si-fill' }), s('path', { d: 'M6.5 10h7', class: 'si-mark' }));
  } else {
    svg.append(s('circle', { cx: 10, cy: 10, r: 8.2, class: 'si-ring' }), s('path', { d: 'M7.8 7.8a2.3 2.3 0 1 1 3.1 2.2c-.6.3-.9.7-.9 1.3v.4', class: 'si-mark-muted' }), s('circle', { cx: 10, cy: 14.6, r: 1, class: 'si-dot-muted' }));
  }
  return svg;
}

const READINESS_LABEL = { green: 'Green: train as planned', amber: 'Amber: easy day', red: 'Red: stop and get advice', unknown: 'No check-in yet' };
export const readinessWord = (level) => ({ green: 'Green', amber: 'Amber', red: 'Red' }[level] || 'Not checked in');

/** The readiness verdict (SPEC 5.8 wording), its reasons and any extra messages (rising pain, fasting). */
export function readinessBadge(r, { large = false, noAdvice = false } = {}) {
  const level = r?.level || 'unknown';
  const reasons = Array.isArray(r?.reasons) ? r.reasons : [];
  const messages = Array.isArray(r?.messages) ? r.messages : [];
  return h('div', { class: ['readiness', `readiness-${level}`, large && 'readiness-large'] },
    statusIcon(level, large ? 28 : 20),
    h('div', { class: 'readiness-text' },
      h('p', { class: 'readiness-label' }, READINESS_LABEL[level] || READINESS_LABEL.unknown),
      noAdvice ? null : h('p', { class: 'readiness-advice' }, (typeof r?.advice === 'string' && r.advice) || READINESS_COPY[level] || READINESS_COPY.unknown),
      reasons.length ? h('ul', { class: 'readiness-reasons' }, reasons.map((x) => h('li', null, x))) : null,
      messages.length ? h('div', { class: 'readiness-messages' }, messages.filter((m) => m !== r?.advice).map((m) => h('p', { class: 'readiness-message' }, m))) : null));
}

export function dayGlyph(status, size = 14) {
  const svg = s('svg', { width: size, height: size, viewBox: '0 0 16 16', class: `day-glyph dg-${status}`, 'aria-hidden': 'true', focusable: 'false' });
  if (status === 'done') svg.append(s('circle', { cx: 8, cy: 8, r: 7 }), s('path', { d: 'M4.6 8.3l2.2 2.2 4.4-4.8', class: 'dg-mark' }));
  else if (status === 'partial') svg.append(s('circle', { cx: 8, cy: 8, r: 6.2, class: 'dg-ring' }), s('path', { d: 'M8 1.8a6.2 6.2 0 0 1 0 12.4z', class: 'dg-half' }));
  else if (status === 'missed') svg.append(s('circle', { cx: 8, cy: 8, r: 6.2, class: 'dg-ring' }), s('path', { d: 'M5.6 5.6l4.8 4.8M10.4 5.6l-4.8 4.8', class: 'dg-x' }));
  else if (status === 'rest') svg.append(s('path', { d: 'M4 8h8', class: 'dg-dash' }));
  else if (status === 'neutral') svg.append(s('circle', { cx: 8, cy: 8, r: 6.2, class: 'dg-ring dg-ring-dashed' }), s('path', { d: 'M5.4 8h5.2', class: 'dg-dash' }));
  else svg.append(s('circle', { cx: 8, cy: 8, r: 6.2, class: 'dg-ring' }));
  return svg;
}

/** Day states. `neutral`: a red or fasting day, not counted as missed (SPEC 5.2 round 4). */
export const DAY_STATUS_LABEL = { done: 'Done', partial: 'Partly done', missed: 'Missed', today: 'Today', planned: 'Planned', rest: 'Rest', neutral: 'Not counted' };

// ------------------------------------------------------------ gates

export function gates() {
  return gateList(content.program);
}

export function gateLabel(id) {
  return gates().find((g) => g.id === id)?.label || 'Unknown gate';
}

const GATE_ID_RE = /(good_arm_ok|clinic_light|grip_cleared|full_clearance)/g;

/**
 * Content text with raw gate ids mapped to their labels (SPEC 5.2 round 4: no raw gate ids in
 * user-facing text): "from clinic_light" -> "from “Light use / rehab started”".
 */
export function gateText(text) {
  if (typeof text !== 'string' || !text) return text ?? '';
  return text.replace(GATE_ID_RE, (id) => `“${gateLabel(id)}”`);
}

/** A small padlock (shut) or an open shackle: gates carry a shape as well as colour and text. */
export function lockIcon(open, size = 14) {
  const svg = s('svg', { width: size, height: size, viewBox: '0 0 16 16', class: `lock-icon ${open ? 'is-open' : 'is-shut'}`, 'aria-hidden': 'true', focusable: 'false' });
  svg.append(s('rect', { x: 3, y: 7, width: 10, height: 7.5, rx: 1.5, class: 'lk-body' }),
    s('path', { d: open ? 'M5.5 7V4.8a2.5 2.5 0 0 1 4.9-.7' : 'M5.5 7V4.8a2.5 2.5 0 0 1 5 0V7', class: 'lk-shackle' }));
  return svg;
}

export function gateChip(gateId, clearances, date) {
  const met = isGateMet(gateId, clearances, date);
  if (gateId === 'none') return chip([lockIcon(true), 'Available now'], 'chip-open');
  return chip([lockIcon(met), met ? `Unlocked: ${gateLabel(gateId)}` : `Needs: ${gateLabel(gateId)}`], met ? 'chip-open' : 'chip-locked');
}

/** "Not available at your gym" (profile.unavailable_exercises). */
export function unavailableChip() {
  return chip('Not available at your gym', 'chip-unavailable');
}

// ------------------------------------------------------------ fields

export const parseNum = (v) => {
  if (v === null || v === undefined) return null;
  const t = String(v).trim().replace(',', '.');
  if (!t) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
};

const UNIT_WORDS = { '/10': 'out of 10', '/5': 'out of 5', '/100': 'out of 100', '°': 'degrees', '0–3': '0 to 3', '0-3': '0 to 3', '%': '%', L: 'litres', l: 'litres' };
/** The unit as it reads in a label: "Weight (kg)", "Arm pain at rest (out of 10)". */
export const unitText = (u) => (u ? UNIT_WORDS[u] || u : '');

function fieldWrap(id, label, control, { hint = null, unit = null, cls = null } = {}) {
  return h('div', { class: ['field', cls] },
    h('label', { class: 'field-label', for: id }, label, unit ? h('span', { class: 'field-unit' }, ` (${unitText(unit)})`) : null),
    control,
    hint ? h('p', { class: 'field-hint', id: `${id}-hint` }, hint) : null);
}

export function numberField({ label, value, onInput, min = null, max = null, step = 'any', unit = null, hint = null, placeholder = null, cls = null, disabled = false, autocomplete = 'off', fkey = null }) {
  const id = uid('f');
  const input = h('input', {
    id, type: 'number', class: 'input', value: isNum(value) ? String(value) : '', min, max, step, placeholder,
    inputmode: 'decimal', disabled, autocomplete, 'aria-describedby': hint ? `${id}-hint` : null, dataset: fkey ? { fkey } : null,
    onInput: (e) => onInput(parseNum(e.target.value), e),
  });
  selectOnFocus(input); // typing replaces a value already in the box (round 4, finding 4)
  return fieldWrap(id, label, input, { hint, unit, cls });
}

export function textField({ label, value, onInput, hint = null, placeholder = null, cls = null, type = 'text', maxlength = 500, autocomplete = null, fkey = null }) {
  const id = uid('f');
  const input = h('input', { id, type, class: 'input', value: value ?? '', placeholder, maxlength, autocomplete, 'aria-describedby': hint ? `${id}-hint` : null, dataset: fkey ? { fkey } : null, onInput: (e) => onInput(e.target.value, e) });
  return fieldWrap(id, label, input, { hint, cls });
}

/** Date entry, day first (dd/mm/yyyy) with a calendar button. onChange gets 'YYYY-MM-DD' (or ''). */
export function dateField({ label, value, onChange, hint = null, cls = null, max = null, min = null, required = false, compact = false, minError = null, maxError = null }) {
  return ukDateField({ label, value, onChange, hint, cls, max, min, required, compact, minError, maxError });
}

export function textareaField({ label, value, onInput, hint = null, rows = 3, placeholder = null, cls = null, maxlength = 5000, fkey = null }) {
  const id = uid('f');
  const ta = h('textarea', { id, class: 'input textarea', rows, placeholder, maxlength, 'aria-describedby': hint ? `${id}-hint` : null, dataset: fkey ? { fkey } : null, onInput: (e) => onInput(e.target.value, e) });
  ta.value = value ?? '';
  return fieldWrap(id, label, ta, { hint, cls });
}

/** options: [{value, label}] or [{group, options:[...]}] */
export function selectField({ label, value, options, onChange, hint = null, cls = null, autocomplete = null, fkey = null }) {
  const id = uid('f');
  const sel = h('select', { id, class: 'input select', autocomplete, 'aria-describedby': hint ? `${id}-hint` : null, dataset: fkey ? { fkey } : null, onChange: (e) => onChange(e.target.value, e) });
  const add = (parent, o) => parent.append(h('option', { value: o.value, selected: String(o.value) === String(value ?? ''), disabled: !!o.disabled }, o.label));
  for (const o of options) {
    if (o.group) {
      const g = h('optgroup', { label: o.group });
      o.options.forEach((x) => add(g, x));
      sel.append(g);
    } else add(sel, o);
  }
  return fieldWrap(id, label, sel, { hint, cls });
}

export function checkField({ label, checked, onChange, hint = null, cls = null }) {
  const id = uid('f');
  return h('div', { class: ['check', cls] },
    h('input', { id, type: 'checkbox', checked: !!checked, 'aria-describedby': hint ? `${id}-hint` : null, onChange: (e) => onChange(e.target.checked, e) }),
    h('label', { for: id }, label),
    hint ? h('p', { class: 'field-hint', id: `${id}-hint` }, hint) : null);
}

/**
 * How a scale's buttons wrap on a narrow screen (round 4, finding 8): up to 6 options stay on one
 * row; longer scales split into two rows, the first one longer (0–5 / 6–10, 1–5 / 6–10), so every
 * button keeps 44 px or more with a gap between them. Returns the rows of values in order.
 */
export function scaleRows(values) {
  const list = Array.isArray(values) ? values : [];
  if (list.length <= 6) return [list.slice()];
  const first = Math.ceil(list.length / 2);
  return [list.slice(0, first), list.slice(first)];
}

/**
 * A row of radio buttons (min..max) with a Clear button; keyboard arrows work natively.
 * Scale direction is the same on every page: the good end is always on the left. For scales
 * where a high number is good (energy, mood, sleep quality) pass goodEnd: 'high' and the
 * buttons run max..min. The stored value is always the number you picked. Both end labels are
 * visible and linked to every option with aria-describedby.
 *
 * Round 4 (finding 8): separate 44 px buttons with spacing; scales over 6 options wrap into two
 * rows on narrow screens (scaleRows). readBack(v) -> {level, text} | null says what a value
 * means next to the buttons ("7/10 = RED: no training today"). confirm(v, previous) may return
 * (a promise of) false to refuse a value: the buttons go back to the previous one and onChange
 * isn't called, so a slip can't flip the day's readiness.
 */
export function scaleField({ label, value, min = 1, max = 5, onChange, lowLabel = '', highLabel = '', hint = null, goodEnd = null, readBack = null, confirm = null }) {
  const name = uid('scale');
  const endsId = `${name}-ends`;
  const hintId = hint ? `${name}-hint` : null;
  const reverse = goodEnd === 'high';
  const values = [];
  for (let v = min; v <= max; v++) values.push(v);
  if (reverse) values.reverse();
  const rows = scaleRows(values);
  let current = isNum(value) ? Number(value) : null;
  const group = h('div', { class: ['scale-options', rows.length > 1 && 'scale-wrap', `scale-n-${values.length}`], style: { '--scale-n': String(values.length), '--scale-row': String(rows[0].length) } });
  const said = h('p', { class: 'scale-readback', 'aria-live': 'polite', 'aria-atomic': 'true', hidden: true });
  const sayBack = () => {
    const r = typeof readBack === 'function' ? readBack(current) : null;
    said.hidden = !(r && r.text);
    said.dataset.level = r?.level || '';
    said.replaceChildren(r && r.text ? [r.level ? statusIcon(r.level, 18) : null, h('span', null, r.text)] : []);
  };
  const showChecked = (v) => group.querySelectorAll('input').forEach((i) => { i.checked = isNum(v) && Number(i.value) === v; });
  let asking = false;
  const choose = async (v) => {
    if (v === current) return;
    if (typeof confirm === 'function') {
      const prev = current;
      asking = true;
      let ok = true;
      try { ok = await confirm(v, prev); } catch { ok = false; } finally { asking = false; }
      if (ok === false) { showChecked(prev); return; }
    }
    current = v;
    showChecked(v);
    sayBack();
    onChange(v);
  };
  for (const v of values) {
    const id = `${name}-${v}`;
    group.append(h('span', { class: 'scale-opt' },
      h('input', { type: 'radio', id, name, value: String(v), checked: current === v, 'aria-describedby': [lowLabel || highLabel ? endsId : null, hintId].filter(Boolean).join(' ') || null, onChange: () => { if (!asking) choose(v); } }),
      h('label', { for: id }, String(v))));
  }
  const clearBtn = h('button', {
    type: 'button', class: 'btn-link scale-clear', onClick: () => { if (!asking) choose(null); },
  }, h('span', null, 'Clear'), h('span', { class: 'visually-hidden' }, ` ${label}`));
  const left = reverse ? [max, highLabel] : [min, lowLabel];
  const right = reverse ? [min, lowLabel] : [max, highLabel];
  sayBack();
  return h('fieldset', { class: ['field', 'scale', reverse && 'scale-reversed', rows.length > 1 && 'scale-long'] },
    h('legend', { class: 'field-label' }, label),
    h('div', { class: 'scale-body' },
      group,
      lowLabel || highLabel ? h('p', { class: 'scale-ends', id: endsId },
        h('span', null, left[1] ? `${left[0]} = ${left[1]}` : ''),
        h('span', { class: 'visually-hidden' }, ', '),
        h('span', null, right[1] ? `${right[0]} = ${right[1]}` : '')) : null),
    said,
    h('div', { class: 'scale-foot' }, hint ? h('span', { class: 'field-hint', id: hintId }, hint) : h('span'), clearBtn));
}

/**
 * What an arm-pain or soreness score means for readiness, said next to the scale (SPEC 5.8):
 * arm pain 7+ is RED, 4–6 AMBER; soreness 7+ is AMBER. null below the lines.
 */
export function painReadBack(v, { kind = 'arm', red = 7, amber = 4 } = {}) {
  if (!isNum(v)) return null;
  const n = Number(v);
  if (kind === 'arm') {
    if (n >= red) return { level: 'red', text: `${n}/10 = RED: no training today` };
    if (n >= amber) return { level: 'amber', text: `${n}/10 = AMBER: easy day` };
    return null;
  }
  return n >= red ? { level: 'amber', text: `${n}/10 = AMBER: easy day` } : null;
}

/** Does changing arm pain from `prev` to `next` move it across the RED line (either way)? */
export const crossesRed = (next, prev, red = 7) => (isNum(next) && Number(next) >= red) !== (isNum(prev) && Number(prev) >= red);

// ------------------------------------------------------------ exercises

const ARM_USE = { none: 'No arm use', 'good-arm': 'Good arm only', 'injured-light': 'Light injured-arm use', both: 'Both arms' };
const FALL = { low: 'Low fall risk', medium: 'Medium fall risk', high: 'High fall risk' };
export const armUseLabel = (v) => ARM_USE[v] || '';
export const fallLabel = (v) => FALL[v] || '';
export const categoryLabel = (c) => (c ? c.charAt(0).toUpperCase() + c.slice(1).replace(/-/g, ' ') : 'Other');

export function exerciseButton(id, ctx, { label = null, cls = null } = {}) {
  return h('button', { type: 'button', class: ['ex-link', cls], onClick: () => openExercise(id, ctx) }, label || exName(id));
}

export function openExercise(id, ctx) {
  const ex = content.exById.get(id);
  let close = () => {};
  const body = ex
    ? exerciseDetail(ex, ctx, { compact: true, onNavigate: () => close() })
    : h('p', null, 'This exercise isn’t in the library yet, so the hub keeps it locked. The library files may still be being written.');
  close = openDrawer({ title: ex ? ex.name : exName(id), content: body });
}

function list(tag, items, cls) {
  return items.length ? h(tag, { class: cls }, items.map((t) => h('li', null, gateText(t)))) : null;
}

export function exerciseDetail(ex, ctx, { compact = false, onNavigate = null } = {}) {
  const clearances = ctx.data.profile.clearances;
  const gate = gateOf(ex.id);
  const met = !isLocked(ex.id, ctx.today, ctx.data);
  const available = isAvailable(ex.id, ctx.data);
  const relink = (ids, title) => {
    if (!ids.length) return null;
    return h('div', { class: 'ex-rel' },
      h('h3', { class: 'mini-title' }, title),
      h('div', { class: 'chip-row' }, ids.map((rid) => {
        const r = content.exById.get(rid);
        const ok = r ? !isLocked(rid, ctx.today, ctx.data) : false;
        const here = isAvailable(rid, ctx.data);
        return h('button', { type: 'button', class: ['chip', 'chip-btn', ok && here ? null : 'chip-locked'], onClick: () => { if (onNavigate) onNavigate(); ctx.navigate(`#/exercises/${rid}`); } },
          ok ? null : lockIcon(false), r ? r.name : exName(rid),
          ok ? null : h('span', { class: 'visually-hidden' }, ' (locked)'),
          here ? null : h('span', { class: 'chip-note' }, ' (not at your gym)'));
      })));
  };
  const unlockedAlternatives = ex.regressions.filter((rid) => content.exById.has(rid) && !isLocked(rid, ctx.today, ctx.data) && isAvailable(rid, ctx.data));
  const hist = exerciseHistory(ctx.data, ex.id);
  const metric = hist.some((r) => r.bestE1rm) ? 'e1rm' : hist.some((r) => r.bestSeconds) ? 'seconds' : hist.some((r) => r.bestReps) ? 'reps' : hist.some((r) => r.minutes) ? 'minutes' : null;
  const point = (r) => (metric === 'e1rm' ? r.bestE1rm : metric === 'seconds' ? r.bestSeconds : metric === 'reps' ? r.bestReps : r.minutes);
  const metricLabel = { e1rm: 'Best estimated 1RM (kg)', seconds: 'Best hold (s)', reps: 'Best reps', minutes: 'Minutes' }[metric] || '';
  return h('article', { class: ['ex-detail', compact && 'ex-detail-compact'] },
    h('div', { class: 'chip-row' },
      chip(categoryLabel(ex.category)),
      gateChip(gate, clearances, ctx.today),
      available ? null : unavailableChip(),
      ex.arm_use ? chip(armUseLabel(ex.arm_use)) : null,
      ex.fall_risk ? chip(fallLabel(ex.fall_risk), ex.fall_risk === 'high' ? 'chip-warn' : null) : null),
    !met ? h('div', { class: 'notice notice-locked', role: 'note' },
      h('p', null, h('strong', null, 'Locked. '), `This needs “${gateLabel(gate)}” from your clinic or physio first.`),
      unlockedAlternatives.length ? h('p', null, 'Do this instead for now: ', unlockedAlternatives.map((rid, i) => [i ? ', ' : '', exerciseButtonInline(rid, ctx, onNavigate)])) : null) : null,
    !available ? h('div', { class: 'notice notice-quiet', role: 'note' },
      h('p', null, h('strong', null, 'Not available at your gym. '), 'The hub never offers it as a swap. If your gym gets the kit, untick it in Settings, under “My gym”.'),
      unlockedAlternatives.length ? h('p', null, 'Try instead: ', unlockedAlternatives.map((rid, i) => [i ? ', ' : '', exerciseButtonInline(rid, ctx, onNavigate)])) : null) : null,
    ex.why ? h('p', { class: 'ex-why prose-lead' }, gateText(ex.why)) : null,
    ex.arm_safety ? h('aside', { class: 'callout callout-note', role: 'note' }, h('p', { class: 'callout-title' }, 'Protect your arm'), h('p', null, gateText(ex.arm_safety))) : null,
    h('div', { class: compact ? 'ex-cols-1' : 'ex-cols' },
      ex.setup.length ? h('div', null, h('h3', { class: 'mini-title' }, 'Set-up'), list('ol', ex.setup, 'steps')) : null,
      ex.cues.length ? h('div', null, h('h3', { class: 'mini-title' }, 'Coaching cues'), list('ul', ex.cues, 'ticks')) : null,
      ex.mistakes.length ? h('div', null, h('h3', { class: 'mini-title' }, 'Common mistakes'), list('ul', ex.mistakes, 'plain')) : null),
    h('dl', { class: 'facts' },
      ex.dose ? [h('dt', null, 'Typical dose'), h('dd', null, gateText(ex.dose))] : null,
      ex.equipment.length ? [h('dt', null, 'Equipment'), h('dd', null, ex.equipment.join(', '))] : null,
      ex.muscles.length ? [h('dt', null, 'Muscles'), h('dd', null, ex.muscles.join(', '))] : null),
    relink(ex.regressions, 'Easier versions'),
    relink(ex.progressions, 'Harder versions'),
    h('div', { class: 'ex-links' },
      isHttpUrl(ex.video) ? extLink(ex.video, 'Watch a demo (opens in a new tab)', { class: 'btn btn-sm' }) : null,
      isHttpUrl(ex.source) ? extLink(ex.source, 'Source', { class: 'btn btn-sm btn-ghost' }) : null,
      compact ? h('a', { href: `#/exercises/${ex.id}`, class: 'btn btn-sm btn-ghost', onClick: () => { if (onNavigate) onNavigate(); } }, 'Open the full page') : null),
    hist.length
      ? h('div', { class: 'ex-history' },
        h('h3', { class: 'mini-title' }, 'Your history'),
        !compact && metric ? timeChart({ title: metricLabel, series: [{ label: metricLabel, cls: 's1', points: hist.filter((r) => isNum(point(r))).map((r) => ({ date: r.date, value: point(r) })), dots: 'all', endLabel: true }], unit: metric === 'e1rm' ? 'kg' : metric === 'seconds' ? 's' : metric === 'minutes' ? 'min' : '', dp: metric === 'e1rm' ? 1 : 0, height: 200 }) : null,
        h('ul', { class: 'history-list' }, hist.slice(-(compact ? 3 : 8)).reverse().map((r) => h('li', null,
          h('span', { class: 'hl-date' }, fmtDay(r.date)),
          h('span', { class: 'hl-sets' }, r.sets.length
            ? r.sets.map((st) => [isNum(st.kg) ? `${fmtNum(st.kg, 2)} kg` : '', isNum(st.reps) ? `${isNum(st.kg) ? ' × ' : ''}${st.reps}` : '', isNum(st.seconds) ? ` ${st.seconds} s` : ''].join('').trim()).filter(Boolean).join(', ')
            : r.minutes ? `${fmtNum(r.minutes)} min` : 'Logged')))))
      : h('p', { class: 'small muted' }, 'You haven’t logged this exercise yet.'));
}

function exerciseButtonInline(id, ctx, onNavigate) {
  return h('a', { href: `#/exercises/${id}`, onClick: () => { if (onNavigate) onNavigate(); } }, exName(id));
}

// ------------------------------------------------------------ figures

export function stat({ label, value, unit = '', sub = null, extra = null, cls = null }) {
  return h('div', { class: ['stat', cls] },
    h('p', { class: 'stat-label' }, label),
    h('p', { class: 'stat-value' }, value, unit ? h('span', { class: 'stat-unit' }, ` ${unit}`) : null),
    sub ? h('p', { class: 'stat-sub' }, sub) : null,
    extra);
}

/** The words for a day's status; a neutral day says why it's excused. */
export function dayStatusText(d, status = d?.status) {
  if (status === 'neutral') return d?.neutral === 'fasting' ? 'Fasting: excused' : 'Red day: excused';
  return DAY_STATUS_LABEL[status] || '';
}

export function dayStrip(days, today, { onPick = null, sessionName = (s) => s.session?.name || s.sessionId } = {}) {
  return h('ol', { class: 'day-strip' }, days.map((d) => {
    const status = d.date === today && d.status !== 'done' && d.status !== 'partial' && d.status !== 'neutral' ? (d.main.length ? 'today' : d.status) : d.status;
    const names = d.main.length ? d.main.map(sessionName).join(' + ') : (d.inProgram ? 'Rest' : '—');
    const wd = WEEKDAYS[weekdayIndex(d.date)];
    const inner = [
      h('span', { class: 'ds-day' }, `${wd} ${Number(d.date.slice(8))}`),
      h('span', { class: 'ds-name' }, names),
      h('span', { class: 'ds-status' }, dayGlyph(status), dayStatusText(d, status)),
    ];
    return h('li', { class: ['ds-cell', `ds-${status}`, d.date === today && 'is-today'] },
      onPick ? h('a', { href: onPick(d), class: 'ds-link', 'aria-label': `${fmtDay(d.date)}: ${names}, ${dayStatusText(d, status)}` }, inner) : h('span', { class: 'ds-inner' }, inner));
  }));
}
