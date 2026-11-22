// #/hikes: this weekend's route, the hiking ladder, hike log, totals, kit checklist and terrain skills.

import { h, uid, toast, confirmDialog, fmtNum, fmtFixed, extLink, isHttpUrl } from '../dom.js';
import { fmtDay, isISODate, todayISO } from '../dates.js';
import { isGateMet } from '../schedule.js';
import { isNum } from '../calc.js';
import { hikeTotals, ladderStatus } from '../stats.js';
import { pageHead, section, sheet, stat, chip, gateChip, gateLabel, gateText, numberField, textField, dateField, selectField, textareaField, scaleField, emptyState, missingContent, deleteWithUndo } from '../components.js';
import { formDraft } from '../features/drafts.js';
import { undoSlot } from '../features/undo.js';
import { weekendPlanFor, nextWeekendPlan, weekendDate } from '../features/plan.js';
import { buildTimeline } from '../schedule.js';
import * as store from '../store.js';
import { content } from '../content.js';

export const title = 'Hikes';

const KIT_ORDER = ['footwear', 'clothing', 'pack', 'navigation', 'safety', 'food-water', 'other'];
const KIT_LABEL = { footwear: 'Footwear', clothing: 'Clothing', pack: 'Pack', navigation: 'Navigation', safety: 'Safety', 'food-water': 'Food and water', other: 'Other' };
const PAGE = 20;
let shown = PAGE;
const dashIfNull = (v, unit = '', dp = 0) => (isNum(v) ? `${fmtNum(v, dp)}${unit}` : '—');

/** "Level 1: 30–45 min local flat walk", without doubling a name that already says "Level 1 —". */
export function rungTitle(level) {
  const n = level?.level;
  const name = String(level?.name || '').trim();
  const m = /^level\s*(\d+)\s*[:—–-]?\s*(.*)$/i.exec(name);
  if (m) return m[2] ? `Level ${m[1]}: ${m[2]}` : `Level ${m[1]}`;
  return name ? `Level ${n ?? ''}: ${name}` : `Level ${n ?? ''}`;
}

/** A ladder level's example routes, in the order hikes.json lists them (anything that isn't an object is skipped). */
export function routeExamples(examples) {
  return Array.isArray(examples) ? examples.filter((e) => e && typeof e === 'object') : [];
}

function criteriaText(c) {
  if (!c || typeof c !== 'object') return '—';
  const bits = [];
  bits.push(isNum(c.distance_km) ? `${fmtNum(c.distance_km, 1)} km` : 'distance —');
  bits.push(isNum(c.ascent_m) ? `${fmtNum(c.ascent_m)} m up` : 'ascent —');
  if (isNum(c.pack_kg) && Number(c.pack_kg) > 0) bits.push(`${fmtNum(c.pack_kg, 1)} kg pack`);
  if (c.terrain) bits.push(String(c.terrain));
  return bits.join(', ');
}

function weekendSection(ctx) {
  const hk = content.hikes;
  if (!hk || !Array.isArray(hk.weekend_plan) || !hk.weekend_plan.length) return null;
  // SPEC 5.2 round 4: program_week (relative to your start date) wins over week_start.
  const start = content.program ? buildTimeline(content.program, ctx.data.profile).start : null;
  const now = weekendPlanFor(hk, ctx.today, { start });
  const next = now ? null : nextWeekendPlan(hk, ctx.today, { start });
  const e = now || next;
  if (!e) return null;
  const sat = weekendDate(e, start);
  if (!sat) return null;
  const bits = [isNum(e.minutes) ? `about ${fmtNum(e.minutes)} min` : null, isNum(e.level) ? `ladder Level ${e.level}` : null].filter(Boolean).join(', ');
  return section({ title: now ? `This weekend: ${fmtDay(sat)}` : `Next weekend’s route: ${fmtDay(sat)}`, sub: 'From your weekend plan. Go in daylight, on dry, good paths, with a waist pack only until the clinic clears light use.' },
    sheet({ class: 'weekend-route weekend-route-lg' },
      h('p', { class: 'wr-name' }, isHttpUrl(e.url) ? extLink(e.url, e.name || 'Route') : (e.name || 'Route')),
      bits ? h('p', { class: 'wr-meta' }, bits) : null,
      e.notes ? h('p', { class: 'rung-desc' }, gateText(e.notes)) : null));
}

function ladder(ctx) {
  const hk = content.hikes;
  if (!hk || !hk.ladder.length) return missingContent('The hiking ladder');
  const cl = ctx.data.profile.clearances;
  const status = ladderStatus(hk.ladder, ctx.data, cl);
  return h('ol', { class: 'ladder' }, status.map((s) => {
    const L = s.level;
    const open = isGateMet(s.gate, cl, ctx.today);
    const key = String(L.level);
    const id = uid('rung');
    const examples = routeExamples(L.examples);
    return h('li', { class: ['rung', s.done && 'is-done', !open && 'is-locked'] },
      h('span', { class: 'rung-level', 'aria-hidden': 'true' }, isNum(L.level) ? String(L.level) : '·'),
      h('div', null,
        h('div', { class: 'row-between' },
          h('h3', { class: 'rung-name' }, rungTitle(L)),
          gateChip(s.gate, cl, ctx.today)),
        h('p', { class: 'rung-crit' }, criteriaText(L.criteria)),
        L.description ? h('p', { class: 'rung-desc' }, gateText(L.description)) : null,
        h('div', { class: 'row', style: { 'margin-top': '8px' } },
          s.autoDate ? chip(`Done ${fmtDay(s.autoDate)}${s.autoHike?.name ? `: ${s.autoHike.name}` : ''}`, 'chip-open') : null,
          !s.autoDate ? h('div', { class: 'check' },
            h('input', { id, type: 'checkbox', disabled: !open, checked: !!s.manualDate, onChange: (e) => {
              if (e.target.checked) ctx.data.hike_ladder[key] = { done: ctx.today };
              else delete ctx.data.hike_ladder[key];
              store.touch();
              ctx.rerender();
            } }),
            h('label', { for: id }, s.manualDate ? `Marked done ${fmtDay(s.manualDate)}` : open ? 'Mark as done' : `Locked until “${gateLabel(s.gate)}”`)) : null),
        examples.length ? h('details', { class: 'disclose' }, h('summary', null, `Example routes (${examples.length})`),
          h('ul', { class: 'plain rung-ex' }, examples.map((e) => h('li', null,
            isHttpUrl(e.url) ? extLink(e.url, e.name || 'Route') : h('strong', null, e.name || 'Route'),
            ` ${e.region ? `(${e.region})` : ''}: ${dashIfNull(e.distance_km, ' km', 1)}, ${dashIfNull(e.ascent_m, ' m up')}${e.terrain ? `, ${e.terrain}` : ''}`)))) : null));
  }));
}

/** The hike form keeps what you type as a draft until Save (PE6). */
function logForm(ctx) {
  const levels = content.hikes?.ladder || [];
  const blank = { date: ctx.today, name: '', distance_km: null, ascent_m: null, duration_min: null, pack_kg: 0, terrain: '', avg_hr: null, rpe: null, ladder_level: null, notes: '' };
  const draft = formDraft('hike-log', blank);
  const f = draft.value;
  const status = h('p', { class: 'small muted draft-state', 'aria-live': 'polite' }, draft.dirty ? 'Not saved yet. Press Save hike.' : '');
  const put = (k) => (v) => { draft.set(k, v); status.textContent = 'Not saved yet. Press Save hike.'; };
  const save = () => {
    // BT1-12: a walk timed on a watch with no distance still counts.
    if (!isISODate(f.date) || (!isNum(f.distance_km) && !isNum(f.duration_min))) { toast('Enter a date, and a distance or a time.'); return; }
    const rec = { id: uid('uuid'), ...blank, ...f, pack_kg: isNum(f.pack_kg) ? f.pack_kg : 0 };
    delete rec.saved_at;
    ctx.data.hikes.push(rec);
    ctx.data.hikes.sort((a, b) => (a.date < b.date ? -1 : 1));
    store.touch();
    draft.clear();
    toast('Hike saved');
    ctx.rerender();
  };
  return sheet(null,
    h('div', { class: 'form-grid' },
      dateField({ label: 'Date', value: f.date, max: todayISO(), onChange: (v) => { if (isISODate(v)) put('date')(v); } }),
      h('div', { class: 'span-2' }, textField({ label: 'Route or place', value: f.name, placeholder: 'e.g. Malham Cove loop', fkey: 'hike:name', onInput: put('name') })),
      numberField({ label: 'Distance', unit: 'km', value: f.distance_km, min: 0, step: 0.1, fkey: 'hike:distance', onInput: put('distance_km') }),
      numberField({ label: 'Ascent', unit: 'm', value: f.ascent_m, min: 0, step: 1, fkey: 'hike:ascent', onInput: put('ascent_m') }),
      numberField({ label: 'Time', unit: 'min', value: f.duration_min, min: 0, step: 1, fkey: 'hike:time', onInput: put('duration_min') }),
      numberField({ label: 'Pack', unit: 'kg', value: f.pack_kg, min: 0, step: 0.5, fkey: 'hike:pack', onInput: put('pack_kg') }),
      numberField({ label: 'Average heart rate', unit: 'bpm', value: f.avg_hr, min: 40, max: 220, step: 1, fkey: 'hike:hr', onInput: put('avg_hr') }),
      textField({ label: 'Terrain', value: f.terrain, placeholder: 'Good paths, rocky, wet…', fkey: 'hike:terrain', onInput: put('terrain') }),
      selectField({ label: 'Ladder level', value: f.ladder_level ?? '', options: [{ value: '', label: 'None' }, ...levels.map((l) => ({ value: String(l.level), label: rungTitle(l) }))], onChange: (v) => put('ladder_level')(v ? Number(v) : null) }),
      h('div', { class: 'span-2' }, scaleField({ label: 'Effort (RPE, 1 to 10)', value: f.rpe, min: 1, max: 10, lowLabel: 'Easy', highLabel: 'Max', onChange: put('rpe') })),
      h('div', { class: 'span-all' }, textareaField({ label: 'Notes', value: f.notes, rows: 2, placeholder: 'Weather, feet, fuelling, what you learned', fkey: 'hike:notes', onInput: put('notes') }))),
    h('div', { class: 'block-actions' },
      h('button', { type: 'button', class: 'btn btn-primary', onClick: save }, 'Save hike'),
      draft.dirty ? h('button', { type: 'button', class: 'btn btn-ghost', onClick: () => { draft.clear(); ctx.rerender(); } }, 'Discard') : null),
    status);
}

function hikeTable(ctx) {
  const list = ctx.data.hikes.filter((x) => isISODate(x.date)).slice().sort((a, b) => (a.date < b.date ? 1 : -1));
  if (!list.length) return h('div', null, undoSlot('hikes'), emptyState({ title: 'No hikes logged yet.', body: 'Your first one starts the ladder.' }));
  const page = list.slice(0, shown);
  return h('div', null,
    undoSlot('hikes'),
    h('div', { class: 'table-wrap' }, h('table', { class: 'table table-compact' },
      h('caption', { class: 'visually-hidden' }, `Your hikes, newest first: ${page.length} of ${list.length}`),
      h('thead', null, h('tr', null, ['Date', 'Route', 'Distance', 'Ascent', 'Time', 'Pack', 'RPE', ''].map((t, i) => h('th', { scope: 'col', class: i >= 2 && i <= 6 ? 'num' : null }, t || h('span', { class: 'visually-hidden' }, 'Actions'))))),
      h('tbody', null, page.map((x) => h('tr', null,
        h('th', { scope: 'row' }, fmtDay(x.date)),
        h('td', null, x.name || '—', x.terrain ? h('span', { class: 'small muted', style: { display: 'block' } }, x.terrain) : null),
        h('td', { class: 'num' }, dashIfNull(x.distance_km, ' km', 1)),
        h('td', { class: 'num' }, dashIfNull(x.ascent_m, ' m')),
        h('td', { class: 'num' }, dashIfNull(x.duration_min, ' min')),
        h('td', { class: 'num' }, isNum(x.pack_kg) && x.pack_kg > 0 ? `${fmtNum(x.pack_kg, 1)} kg` : '—'),
        h('td', { class: 'num' }, dashIfNull(x.rpe)),
        h('td', null, h('button', { type: 'button', class: 'btn btn-sm btn-ghost', 'aria-label': `Delete ${x.name || 'hike'} on ${fmtDay(x.date)}`, onClick: async () => {
          const ok = await confirmDialog({ title: 'Delete this hike?', body: `${x.name || 'The hike'} on ${fmtDay(x.date, { year: true })}${isNum(x.distance_km) ? `, ${fmtNum(x.distance_km, 1)} km` : ''}. You can undo it straight after.`, confirmText: 'Delete the hike', danger: true });
          if (!ok) return;
          deleteWithUndo({ list: ctx.data.hikes, item: x, message: `Deleted ${x.name || 'the hike'} on ${fmtDay(x.date)}`, after: () => ctx.rerender(), slot: 'hikes' });
        } }, 'Delete'))))))),
    list.length > shown ? h('div', { class: 'block-actions' },
      h('button', { type: 'button', class: 'btn btn-sm', onClick: () => { shown += PAGE; ctx.rerender(); } }, `Show ${Math.min(PAGE, list.length - shown)} more`),
      h('span', { class: 'small muted' }, `Showing ${shown} of ${list.length}`)) : null);
}

function kit(ctx) {
  const items = content.hikes?.kit || [];
  if (!items.length) return missingContent('The kit list');
  const owned = ctx.data.kit_owned;
  const essentials = items.filter((k) => k.essential);
  const countEl = h('p', { class: 'small muted', style: { 'margin-bottom': '12px' } });
  const updateCount = () => { countEl.textContent = `You own ${essentials.filter((k) => owned[k.item]).length} of ${essentials.length} essentials and ${items.filter((k) => owned[k.item]).length} of ${items.length} items in total.`; };
  updateCount();
  const cats = [...new Set(items.map((k) => (KIT_ORDER.includes(k.category) ? k.category : 'other')))].sort((a, b) => KIT_ORDER.indexOf(a) - KIT_ORDER.indexOf(b));
  return h('div', null, countEl, h('div', { class: 'grid grid-2' }, cats.map((c) => sheet({ class: 'sheet-tight kit-group' },
    h('h3', { class: 'mini-title' }, KIT_LABEL[c] || c),
    h('div', { class: 'check-list' }, items.filter((k) => (KIT_ORDER.includes(k.category) ? k.category : 'other') === c).map((k) => {
      const id = uid('kit');
      return h('div', null,
        h('div', { class: 'check' },
          h('input', { id, type: 'checkbox', checked: !!owned[k.item], onChange: (e) => { if (e.target.checked) owned[k.item] = true; else delete owned[k.item]; store.touch(); updateCount(); } }),
          h('label', { for: id }, k.item, k.essential ? h('span', { class: 'chip chip-accent chip-tiny' }, 'Essential') : null)),
        k.notes ? h('p', { class: 'field-hint', style: { 'padding-left': '28px' } }, gateText(k.notes)) : null);
    }))))));
}

function terrain(ctx) {
  const list = content.hikes?.terrain_skills || [];
  if (!list.length) return missingContent('The terrain skills');
  const cl = ctx.data.profile.clearances;
  return h('div', { class: 'grid grid-2' }, list.map((t) => {
    const gate = typeof t.gate === 'string' && t.gate ? t.gate : 'full_clearance';
    const open = isGateMet(gate, cl, ctx.today);
    return sheet({ class: ['sheet-tight', !open && 'is-locked'], style: open ? null : { 'border-style': 'dashed', background: 'transparent' } },
      h('div', { class: 'row-between' }, h('h3', { class: 'mini-title', style: { margin: 0 } }, t.terrain ? String(t.terrain).charAt(0).toUpperCase() + String(t.terrain).slice(1) : 'Terrain'), gateChip(gate, cl, ctx.today)),
      !open ? h('p', { class: 'small muted', style: { 'margin-top': '6px' } }, 'For later. Read it now, practise it once you are cleared.') : null,
      Array.isArray(t.technique) && t.technique.length ? h('ul', { class: 'ticks', style: { 'margin-top': '8px' } }, t.technique.map((x) => h('li', null, String(x)))) : null);
  }));
}

export function render(ctx) {
  const page = h('div', { class: 'page' });
  page.append(pageHead({ title: 'Hikes', lede: 'Long days on the hill are the goal. Climb the ladder one level at a time, on terrain your clearances allow. Until full clearance, stick to good, dry paths in daylight: a fall onto that arm is the biggest risk you have.' }));
  const t = hikeTotals(ctx.data);
  page.append(h('div', { class: 'stats' },
    stat({ label: 'Hikes logged', value: fmtNum(t.count) }),
    stat({ label: 'Total distance', value: fmtFixed(t.km, 1), unit: 'km' }),
    stat({ label: 'Total ascent', value: fmtNum(t.ascent), unit: 'm' }),
    stat({ label: 'Longest hike', value: t.longest ? fmtFixed(t.longest.distance_km, 1) : '–', unit: t.longest ? 'km' : '', sub: t.longest ? `${t.longest.name || 'Hike'}, ${fmtDay(t.longest.date)}` : 'Log one to start' })));
  page.append(weekendSection(ctx));
  page.append(section({ title: 'The ladder', sub: 'A level counts as done automatically when a logged hike meets its distance, ascent and pack while its gate was cleared. Check the terrain yourself.' }, sheet(null, ladder(ctx))));
  page.append(section({ title: 'Log a hike' }, logForm(ctx)));
  page.append(section({ title: 'Your hikes' }, hikeTable(ctx)));
  page.append(section({ title: 'Kit', sub: 'Tick what you own. Essentials first.' }, kit(ctx)));
  page.append(section({ title: 'Terrain skills', sub: 'Rough ground is gated: practise it only when your clearances allow.' }, terrain(ctx)));
  return page;
}
