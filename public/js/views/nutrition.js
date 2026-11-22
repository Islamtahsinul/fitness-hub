// #/nutrition: energy and protein calculator, today's intake, foods, meal templates, supplements.

import { h, fmtNum, fmtFixed, debounce } from '../dom.js';
import { fmtDay } from '../dates.js';
import { ageFrom, bmrMifflin, tdee, targetKcal, proteinTargets, isNum, CALCIUM_MG, VITAMIN_D_UG, vitaminDSeason, PROTEIN_MIN, PROTEIN_MAX } from '../calc.js';
import { latestValue, checkinOn } from '../stats.js';
import { pageHead, section, sheet, stat, chip, selectField, numberField, textField, missingContent, emptyState } from '../components.js';
import { meter } from '../charts.js';
import { content } from '../content.js';
import * as store from '../store.js';

export const title = 'Nutrition';

const ACTIVITY = [
  [1.375, 'Light: training most days, desk job'],
  [1.465, 'Light to moderate'],
  [1.55, 'Moderate: daily training (default)'],
  [1.635, 'Moderate to high'],
  [1.725, 'High: long sessions, active job'],
];
const sortState = { key: 'protein_per_100', dir: -1, q: '', category: '' };
let tempWeight = null;

const EVIDENCE_LABEL = { strong: 'Strong evidence', moderate: 'Moderate evidence', weak: 'Weak evidence', avoid: 'Avoid' };

function calcBlock(ctx) {
  const { data, today } = ctx;
  const pr = data.profile;
  const latest = latestValue(data, 'weight_kg', today);
  const weight = latest ? latest.value : tempWeight;
  const age = ageFrom(pr.birth_year, today);
  const out = h('div');
  const draw = () => {
    const w = latest ? latest.value : tempWeight;
    const bmr = bmrMifflin({ sex: pr.sex, weightKg: w, heightCm: pr.height_cm, age });
    const td = tdee(bmr, pr.activity_factor);
    const kcal = targetKcal(td, pr.surplus_kcal);
    const prot = proteinTargets(w, pr.protein_g_per_kg);
    const missing = [];
    if (!pr.sex) missing.push('sex');
    if (!age) missing.push('birth year');
    if (!isNum(pr.height_cm)) missing.push('height');
    if (!isNum(w)) missing.push('weight');
    out.replaceChildren(
      missing.length ? h('p', { class: 'notice notice-accent', style: { 'margin-bottom': '12px' } }, `Add your ${missing.join(', ')} to work out calories. `, h('a', { href: '#/settings' }, 'Open Settings')) : null,
      h('div', { class: 'calc-out' },
        stat({ label: 'Target intake', value: isNum(kcal) ? fmtNum(Math.round(kcal / 10) * 10) : '–', unit: 'kcal a day', sub: isNum(td) ? `Maintenance ${fmtNum(Math.round(td / 10) * 10)} + ${fmtNum(pr.surplus_kcal)} surplus` : 'Needs the details above' }),
        stat({ label: 'Protein', value: prot ? fmtNum(prot.target) : '–', unit: 'g a day', sub: prot ? `${fmtNum(prot.low)} to ${fmtNum(prot.high)} g (1.6 to 2.2 g/kg). Split over 4 meals.` : 'Needs your weight' }),
        stat({ label: 'BMR (Mifflin–St Jeor)', value: isNum(bmr) ? fmtNum(bmr) : '–', unit: 'kcal', sub: 'What you burn at complete rest' }),
        stat({ label: 'Maintenance (TDEE)', value: isNum(td) ? fmtNum(td) : '–', unit: 'kcal', sub: `BMR × ${pr.activity_factor || 1.55} activity` }),
        stat({ label: 'Calcium', value: fmtNum(CALCIUM_MG), unit: 'mg a day', sub: 'UK adult reference. Bone needs it.' }),
        stat({ label: 'Vitamin D', value: fmtNum(VITAMIN_D_UG), unit: 'µg a day', sub: vitaminDSeason(today) ? 'Take it now: UK advice is October to March.' : 'UK advice: from October to March.' })));
  };
  const redraw = debounce(() => { store.touch(); draw(); }, 200);
  draw();
  const inputs = h('div', { class: 'form-grid', style: { 'margin-bottom': '16px' } },
    selectField({ label: 'Sex (for the formula)', value: pr.sex || '', options: [{ value: '', label: 'Not set' }, { value: 'male', label: 'Male' }, { value: 'female', label: 'Female' }], onChange: (v) => { pr.sex = v || null; redraw(); } }),
    numberField({ label: 'Birth year', value: pr.birth_year, min: 1920, max: 2012, step: 1, hint: age ? `Age ${age}` : null, onInput: (v) => { pr.birth_year = v; redraw(); } }),
    numberField({ label: 'Height', unit: 'cm', value: pr.height_cm, min: 120, max: 230, step: 0.5, onInput: (v) => { pr.height_cm = v; redraw(); } }),
    latest
      ? h('div', { class: 'field' }, h('span', { class: 'field-label' }, 'Weight'), h('p', { style: { 'padding-top': '8px' } }, h('strong', null, `${fmtFixed(latest.value, 1)} kg`)), h('p', { class: 'field-hint' }, `From your check-in on ${fmtDay(latest.date)}`))
      : numberField({ label: 'Weight', unit: 'kg', value: weight, min: 30, max: 250, step: 0.1, hint: 'Not saved: log it in a check-in', onInput: (v) => { tempWeight = v; draw(); } }),
    selectField({ label: 'Activity', value: String(pr.activity_factor ?? 1.55), cls: 'span-2', options: ACTIVITY.map(([v, l]) => ({ value: String(v), label: `${v}: ${l}` })), onChange: (v) => { pr.activity_factor = Number(v); redraw(); } }),
    numberField({ label: 'Surplus', unit: 'kcal', value: pr.surplus_kcal, min: 0, max: 600, step: 25, hint: '250 to 300 is a lean gain', onInput: (v) => { pr.surplus_kcal = isNum(v) ? v : 300; redraw(); } }),
    numberField({ label: 'Protein per kg', unit: 'g/kg', value: pr.protein_g_per_kg, min: PROTEIN_MIN, max: PROTEIN_MAX, step: 0.1, hint: '1.6 to 2.2', onInput: (v) => { pr.protein_g_per_kg = isNum(v) ? Math.min(PROTEIN_MAX, Math.max(PROTEIN_MIN, v)) : 1.8; redraw(); } }));
  return { inputs, out, kcalNow: () => targetKcal(tdee(bmrMifflin({ sex: pr.sex, weightKg: latest ? latest.value : tempWeight, heightCm: pr.height_cm, age }), pr.activity_factor), pr.surplus_kcal), protNow: () => proteinTargets(latest ? latest.value : tempWeight, pr.protein_g_per_kg) };
}

function foodsTable(foods) {
  const cats = [...new Set(foods.map((f) => f.category).filter(Boolean))].sort();
  const per100 = (f) => (isNum(f.kcal) && Number(f.kcal) > 0 && isNum(f.protein_g) ? (100 * Number(f.protein_g)) / Number(f.kcal) : null);
  const cols = [
    ['name', 'Food', false], ['category', 'Category', false], ['serving', 'Serving', false], ['kcal', 'kcal', true],
    ['protein_g', 'Protein g', true], ['protein_per_100', 'Protein per 100 kcal', true], ['calcium_mg', 'Calcium mg', true],
  ];
  const host = h('div');
  const draw = () => {
    const q = sortState.q.trim().toLowerCase();
    let rows = foods.filter((f) => (!sortState.category || f.category === sortState.category) && (!q || `${f.name} ${f.category} ${f.notes || ''}`.toLowerCase().includes(q)));
    const val = (f, k) => (k === 'protein_per_100' ? per100(f) : f[k]);
    rows = rows.slice().sort((a, b) => {
      const va = val(a, sortState.key), vb = val(b, sortState.key);
      if (typeof va === 'string' || typeof vb === 'string') return String(va || '').localeCompare(String(vb || '')) * sortState.dir;
      return ((isNum(va) ? va : -Infinity) - (isNum(vb) ? vb : -Infinity)) * sortState.dir;
    });
    host.replaceChildren(h('div', { class: 'table-wrap' }, h('table', { class: 'table table-compact' },
      h('caption', { class: 'visually-hidden' }, 'Foods, sortable by column'),
      h('thead', null, h('tr', null, cols.map(([k, l, numeric]) => h('th', { scope: 'col', class: numeric ? 'num' : null, 'aria-sort': sortState.key === k ? (sortState.dir > 0 ? 'ascending' : 'descending') : 'none' },
        h('button', { type: 'button', class: 'sort-btn', 'aria-sort': sortState.key === k ? (sortState.dir > 0 ? 'ascending' : 'descending') : null, onClick: () => {
          if (sortState.key === k) sortState.dir *= -1; else { sortState.key = k; sortState.dir = numeric ? -1 : 1; }
          draw();
        } }, l))))),
      h('tbody', null, rows.map((f) => h('tr', null,
        h('th', { scope: 'row' }, f.name, f.notes ? h('span', { class: 'small muted', style: { display: 'block', 'font-weight': 400 } }, f.notes) : null),
        h('td', null, f.category || ''), h('td', null, f.serving || ''),
        h('td', { class: 'num' }, isNum(f.kcal) ? fmtNum(f.kcal) : '–'),
        h('td', { class: 'num' }, isNum(f.protein_g) ? fmtNum(f.protein_g, 1) : '–'),
        h('td', { class: 'num' }, isNum(per100(f)) ? fmtFixed(per100(f), 1) : '–'),
        h('td', { class: 'num' }, isNum(f.calcium_mg) ? fmtNum(f.calcium_mg) : '–')))))));
  };
  const redraw = debounce(draw, 120);
  draw();
  return h('div', null,
    h('div', { class: 'filters' },
      textField({ label: 'Search foods', value: sortState.q, type: 'search', cls: 'field-grow', onInput: (v) => { sortState.q = v; redraw(); } }),
      selectField({ label: 'Category', value: sortState.category, options: [{ value: '', label: 'All' }, ...cats.map((c) => ({ value: c, label: c }))], onChange: (v) => { sortState.category = v; draw(); } })),
    host);
}

export function render(ctx) {
  const { data, today } = ctx;
  const n = content.nutrition;
  const page = h('div', { class: 'page' });
  page.append(pageHead({ title: 'Nutrition', lede: 'Fuel for muscle and for bone healing. While the fracture heals there is no dieting: eat a small surplus, plenty of protein and enough calcium and vitamin D.' }));
  page.append(h('aside', { class: 'callout callout-safety', role: 'note', style: { 'margin-bottom': '20px' } }, h('p', { class: 'callout-title' }, 'No dieting while the bone heals'), h('p', null, 'Healing bone needs energy and protein. If your weight trend drops, eat more, not less. Talk to your GP before any supplement if you take other medicines.')));

  const calc = calcBlock(ctx);
  page.append(section({ title: 'Your daily targets', sub: 'From your profile and your latest weigh-in. Changes here save to your profile.' }, sheet(null, calc.inputs, calc.out)));

  const ck = checkinOn(data, today);
  const kcal = calc.kcalNow();
  const prot = calc.protNow();
  page.append(section({ title: 'Today so far', sub: 'From today’s check-in.', actions: h('a', { class: 'btn btn-sm', href: '#/checkin' }, 'Update today’s check-in') },
    h('div', { class: 'stats' },
      h('div', { class: 'stat' }, h('p', { class: 'stat-label' }, 'Calories'), h('p', { class: 'stat-value' }, isNum(ck?.calories) ? fmtNum(ck.calories) : '–', h('span', { class: 'stat-unit' }, isNum(kcal) ? ` of ${fmtNum(Math.round(kcal / 10) * 10)} kcal` : ' kcal')),
        isNum(kcal) ? meter({ value: Number(ck?.calories) || 0, max: kcal, label: 'Calories today against target' }) : null),
      h('div', { class: 'stat' }, h('p', { class: 'stat-label' }, 'Protein'), h('p', { class: 'stat-value' }, isNum(ck?.protein_g) ? fmtNum(ck.protein_g) : '–', h('span', { class: 'stat-unit' }, prot ? ` of ${fmtNum(prot.target)} g` : ' g')),
        prot ? meter({ value: Number(ck?.protein_g) || 0, max: prot.target, label: 'Protein today against target' }) : null),
      h('div', { class: 'stat' }, h('p', { class: 'stat-label' }, 'Water'), h('p', { class: 'stat-value' }, isNum(ck?.water_l) ? fmtFixed(ck.water_l, 1) : '–', h('span', { class: 'stat-unit' }, ' L'))),
      h('div', { class: 'stat' }, h('p', { class: 'stat-label' }, 'Creatine'), h('p', { class: 'stat-value' }, ck?.creatine ? 'Taken' : 'Not yet')))));

  if (!n) { page.append(section({ title: 'Foods, meals and supplements' }, missingContent('The nutrition guide'))); return page; }

  if (n.meal_templates.length) {
    const closest = isNum(kcal) ? n.meal_templates.filter((m) => isNum(m.kcal)).reduce((b, m) => (!b || Math.abs(m.kcal - kcal) < Math.abs(b.kcal - kcal) ? m : b), null) : null;
    page.append(section({ title: 'Meal templates', sub: isNum(kcal) ? `Your target is about ${fmtNum(Math.round(kcal / 10) * 10)} kcal. The closest template is marked.` : 'Set up your profile to see which template fits.' },
      h('div', { class: 'grid grid-auto' }, n.meal_templates.map((m) => sheet({ class: ['meal', m === closest && 'is-closest'] },
        h('div', { class: 'row-between' }, h('h3', { class: 'section-title', style: { 'font-size': '19px' } }, m.name || m.id || 'Template'), m === closest ? chip('Closest to your target', 'chip-accent') : null),
        h('p', { class: 'small', style: { 'margin-top': '4px' } }, `${isNum(m.kcal) ? `${fmtNum(m.kcal)} kcal` : ''}${isNum(m.protein_g) ? `, ${fmtNum(m.protein_g)} g protein` : ''}`),
        m.notes ? h('p', { class: 'read small ink-2', style: { 'margin-top': '6px' } }, m.notes) : null,
        Array.isArray(m.meals) && m.meals.length ? h('details', { class: 'disclose', open: m === closest }, h('summary', null, 'Meals'),
          h('ul', { class: 'meal-list' }, m.meals.filter((x) => x && typeof x === 'object').map((x) => h('li', null,
            h('p', { class: 'meal-time' }, x.time || ''),
            h('p', { style: { 'font-weight': 600 } }, x.name || ''),
            Array.isArray(x.items) ? h('p', { class: 'small ink-2' }, x.items.join(', ')) : null,
            h('p', { class: 'small muted' }, [isNum(x.kcal) ? `${fmtNum(x.kcal)} kcal` : '', isNum(x.protein_g) ? `${fmtNum(x.protein_g)} g protein` : ''].filter(Boolean).join(', ')))))) : null)))));
  }

  page.append(section({ title: 'Foods', sub: `${typeof n.foods_note === 'string' && n.foods_note.trim() ? `${n.foods_note.trim()} ` : ''}Sort by protein per 100 kcal to find the most protein-dense choices.` },
    n.foods.length ? foodsTable(n.foods) : emptyState({ title: 'No foods listed yet.' })));

  if (n.supplements.length) {
    page.append(section({ title: 'Supplements', sub: 'Food first. These are the ones with a case, and the ones to skip.' },
      sheet(null, n.supplements.map((s) => {
        const ev = ['strong', 'moderate', 'weak', 'avoid'].includes(s.evidence) ? s.evidence : 'weak';
        return h('div', { class: 'supp' },
          h('div', null, h('p', { class: 'supp-name' }, s.name), h('p', { class: 'small muted' }, [s.dose, s.timing].filter((x) => typeof x === 'string' && x.replace(/[\s.—–-]/g, '')).join('. '))),
          h('span', { class: `evidence ev-${ev}` }, EVIDENCE_LABEL[ev]),
          h('div', { class: 'supp-body' }, s.why ? h('p', null, s.why) : null, s.cautions ? h('p', { style: { 'margin-top': '4px' } }, h('strong', null, 'Cautions: '), s.cautions) : null));
      }))));
  }

  if (n.shopping_list.length) {
    page.append(section({ title: 'Shopping list' }, h('div', { class: 'grid grid-3' }, n.shopping_list.map((g) => sheet({ class: 'sheet-tight' },
      h('h3', { class: 'mini-title' }, g.category || 'Other'),
      h('ul', { class: 'plain' }, (Array.isArray(g.items) ? g.items : []).map((i) => h('li', null, String(i)))))))));
  }
  return page;
}
