// #/exercises and #/exercises/<id>: the exercise library.

import { h, debounce } from '../dom.js';
import { GATE_ORDER } from '../schedule.js';
import { pageHead, chip, gateLabel, gateText, gateChip, unavailableChip, emptyState, missingContent, exerciseDetail, categoryLabel, armUseLabel, fallLabel, textField, selectField, checkField } from '../components.js';
import { content } from '../content.js';
import { isLocked, isAvailable, gateOf } from '../features/safety.js';

export const title = 'Exercises';

const CATEGORY_ORDER = ['squat', 'hinge', 'single-leg', 'knee-ankle', 'calves', 'hip', 'core', 'balance', 'mobility', 'conditioning', 'push', 'pull', 'carry', 'grip', 'power', 'rehab'];
const filters = { q: '', category: '', gate: '', equipment: '', available: false };

function matches(ex, ctx) {
  const q = filters.q.trim().toLowerCase();
  if (q) {
    const hay = [ex.name, ex.id, ex.category, ...ex.muscles, ...ex.equipment, ex.why].join(' ').toLowerCase();
    if (!q.split(/\s+/).every((t) => hay.includes(t))) return false;
  }
  if (filters.category && ex.category !== filters.category) return false;
  if (filters.gate && ex.gate !== filters.gate) return false;
  if (filters.equipment && !ex.equipment.some((e) => e.toLowerCase() === filters.equipment)) return false;
  if (filters.available && (isLocked(ex.id, ctx.today, ctx.data) || !isAvailable(ex.id, ctx.data))) return false;
  return true;
}

function card(ex, ctx) {
  const ok = !isLocked(ex.id, ctx.today, ctx.data);
  const here = isAvailable(ex.id, ctx.data);
  return h('a', { class: ['ex-card', !ok && 'is-locked', !here && 'is-away'], href: `#/exercises/${encodeURIComponent(ex.id)}` },
    h('span', { class: 'ex-card-name' }, ex.name),
    h('span', { class: 'ex-card-meta' }, ex.muscles.slice(0, 4).join(', ') || categoryLabel(ex.category)),
    ex.dose ? h('span', { class: 'small' }, gateText(ex.dose)) : null,
    h('span', { class: 'chip-row' }, here ? null : unavailableChip(), ok ? null : gateChip(gateOf(ex.id), ctx.data.profile.clearances, ctx.today), ex.arm_use ? chip(armUseLabel(ex.arm_use)) : null, ex.fall_risk === 'high' ? chip(fallLabel(ex.fall_risk), 'chip-warn') : null));
}

function detail(ctx, id) {
  const ex = content.exById.get(id);
  const page = h('div', { class: 'page' });
  page.append(h('a', { class: 'back-link', href: '#/exercises' }, 'All exercises'));
  if (!ex) {
    page.append(h('h1', { class: 'page-title', tabindex: '-1', id: 'page-title' }, 'Exercise not found'),
      emptyState({ title: 'This exercise isn’t in the library yet.', body: 'The library files may still be being written. Refresh later.' }));
    return page;
  }
  page.append(pageHead({ title: ex.name, kicker: categoryLabel(ex.category) }));
  page.append(exerciseDetail(ex, ctx, { compact: false }));
  return page;
}

export function render(ctx) {
  if (ctx.params[0]) return detail(ctx, ctx.params[0]);
  const page = h('div', { class: 'page' });
  page.append(pageHead({ title: 'Exercise library', lede: 'Every movement in your programme, with the set-up, cues and how to protect your arm. Locked exercises open as your clinic clears each gate; kit your gym doesn’t have is marked “Not available at your gym”.' }));
  if (!content.exercises.length) { page.append(missingContent('The exercise library')); return page; }
  const cats = [...new Set(content.exercises.map((e) => e.category).filter(Boolean))].sort((a, b) => {
    const ia = CATEGORY_ORDER.indexOf(a), ib = CATEGORY_ORDER.indexOf(b);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || a.localeCompare(b);
  });
  const equipment = [...new Set(content.exercises.flatMap((e) => e.equipment.map((x) => x.toLowerCase())))].sort();
  const results = h('div');
  const count = h('p', { class: 'result-count', 'aria-live': 'polite' });
  const draw = () => {
    const list = content.exercises.filter((ex) => matches(ex, ctx));
    count.textContent = `${list.length} of ${content.exercises.length} exercises`;
    if (!list.length) {
      results.replaceChildren(emptyState({ title: 'No exercises match.', body: 'Clear a filter or try a different word.' }));
      return;
    }
    if (!filters.category && !filters.q) {
      const groups = cats.map((c) => [c, list.filter((e) => e.category === c)]).filter(([, l]) => l.length);
      const rest = list.filter((e) => !cats.includes(e.category));
      results.replaceChildren(...groups.map(([c, l]) => h('section', { class: 'section', 'aria-label': categoryLabel(c) },
        h('h2', { class: 'section-title', style: { 'margin-bottom': '10px' } }, categoryLabel(c)),
        h('div', { class: 'ex-grid' }, l.map((ex) => card(ex, ctx))))),
      rest.length ? h('div', { class: 'ex-grid' }, rest.map((ex) => card(ex, ctx))) : '');
    } else {
      results.replaceChildren(h('div', { class: 'ex-grid' }, list.map((ex) => card(ex, ctx))));
    }
  };
  const redraw = debounce(draw, 120);
  page.append(h('div', { class: 'filters', role: 'search' },
    textField({ label: 'Search', value: filters.q, cls: 'field-grow', placeholder: 'Name, muscle or equipment', type: 'search', onInput: (v) => { filters.q = v; redraw(); } }),
    selectField({ label: 'Category', value: filters.category, options: [{ value: '', label: 'All categories' }, ...cats.map((c) => ({ value: c, label: categoryLabel(c) }))], onChange: (v) => { filters.category = v; draw(); } }),
    selectField({ label: 'Gate', value: filters.gate, options: [{ value: '', label: 'Any gate' }, ...GATE_ORDER.map((g) => ({ value: g, label: gateLabel(g) }))], onChange: (v) => { filters.gate = v; draw(); } }),
    selectField({ label: 'Equipment', value: filters.equipment, options: [{ value: '', label: 'Any equipment' }, ...equipment.map((e) => ({ value: e, label: e.charAt(0).toUpperCase() + e.slice(1) }))], onChange: (v) => { filters.equipment = v; draw(); } }),
    checkField({ label: 'Open to me now, at my gym', checked: filters.available, onChange: (v) => { filters.available = v; draw(); } })));
  page.append(count, results);
  draw();
  return page;
}
