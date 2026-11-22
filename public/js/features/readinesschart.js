// "Readiness by week": a stacked column per week (green, amber, red, no check-in), using the
// reserved status colours plus a texture for amber and red, so identity never rests on colour
// alone (colour-blind readers, print, forced colours). Dataviz method: <=24px columns, a 2px
// surface gap between segments, a 4px rounded data-end, a hairline baseline, a legend, a
// tooltip on hover, one tab stop with arrow keys (Esc closes), and a table view.
// Built from features/safety.js readinessRange: the same single readiness source as every page.

import { h, s, clear } from '../dom.js';
import { addDays, mondayOf, fmtShort, fmtDay } from '../dates.js';
import { observeWidth } from '../charts.js';
import { readinessRange } from './safety.js';

const LEVELS = [
  ['green', 'Green', 'rd-green'],
  ['amber', 'Amber', 'rd-amber'],
  ['red', 'Red', 'rd-red'],
  ['none', 'No check-in', 'rd-none'],
];

let patternSeq = 0;

/**
 * Per-week counts of each readiness level between two dates (pure).
 * Accepts the whole data object, or (older callers) (checkins, profile, from, to).
 */
export function readinessWeeks(dataOrCheckins, profile, from, to) {
  const data = Array.isArray(dataOrCheckins) ? { checkins: dataOrCheckins, profile: profile || {} } : dataOrCheckins;
  const hist = readinessRange(data, from, to);
  const weeks = [];
  for (let m = mondayOf(from); m <= to; m = addDays(m, 7)) {
    const counts = { green: 0, amber: 0, red: 0, none: 0 };
    let days = 0;
    for (let i = 0; i < 7; i++) {
      const d = addDays(m, i);
      if (d < from || d > to) continue;
      days++;
      const r = hist.get(d);
      const level = !r || !r.checkedIn || r.level === 'unknown' ? 'none' : r.level;
      counts[level] += 1;
    }
    if (days) weeks.push({ start: m, days, counts });
  }
  return weeks;
}

function tableView(weeks) {
  return h('div', { class: 'table-wrap chart-table' }, h('table', { class: 'table table-compact' },
    h('caption', { class: 'visually-hidden' }, 'Readiness by week'),
    h('thead', null, h('tr', null, h('th', { scope: 'col' }, 'Week of'), ...LEVELS.map(([, l]) => h('th', { scope: 'col', class: 'num' }, l)))),
    h('tbody', null, weeks.slice().reverse().map((w) => h('tr', null, h('th', { scope: 'row' }, fmtDay(w.start)), ...LEVELS.map(([k]) => h('td', { class: 'num' }, String(w.counts[k]))))))));
}

/** Hatch patterns: amber 45°, red 135° (cross-hatched), drawn in the segment's darker ink. */
function patterns(id) {
  const mk = (pid, d, cls) => s('pattern', { id: pid, width: 6, height: 6, patternUnits: 'userSpaceOnUse', patternTransform: 'rotate(45)' },
    s('rect', { width: 6, height: 6, class: `rd-pat-bg ${cls}` }), s('path', { d, class: `rd-pat-ink ${cls}` }));
  return s('defs', null,
    mk(`${id}-amber`, 'M0 0V6', 'rd-amber'),
    mk(`${id}-red`, 'M0 0V6M0 3H6', 'rd-red'));
}

function key(cls, id) {
  const fill = cls === 'rd-amber' ? `url(#${id}-amber)` : cls === 'rd-red' ? `url(#${id}-red)` : null;
  return s('svg', { width: 14, height: 12, viewBox: '0 0 14 12', 'aria-hidden': 'true', class: 'legend-key' },
    fill ? patterns(id) : null,
    s('rect', { x: 1, y: 1, width: 12, height: 10, rx: 2, class: `rd-seg ${cls}`, fill: fill || undefined }));
}

export function readinessChart({ data, checkins, profile, from, to, height = 170 }) {
  const d = data || { checkins, profile };
  const all = readinessWeeks(d, null, from, to);
  // Weeks before your first check-in in the range aren't "missed": the chart starts at the first logged week.
  const firstLogged = all.findIndex((w) => w.days > w.counts.none);
  const weeks = firstLogged > 0 ? all.slice(firstLogged) : all;
  const pid = `rdp-${++patternSeq}`;
  const fig = h('figure', { class: 'chart readiness-chart' });
  fig.append(h('figcaption', { class: 'chart-head' },
    h('h3', { class: 'chart-title' }, 'Readiness by week'),
    h('p', { class: 'chart-sub' }, 'Each column is one week of mornings. More amber than usual is the cue for an easier week.')));
  const logged = weeks.reduce((n, w) => n + w.days - w.counts.none, 0);
  if (!weeks.length || !logged) {
    fig.append(h('p', { class: 'chart-empty' }, 'Check in on a few mornings to see your readiness by week.'));
    return fig;
  }
  fig.append(h('ul', { class: 'chart-legend' }, LEVELS.map(([, label, cls]) => h('li', { class: 'legend-item' }, key(cls, `${pid}-k`), h('span', null, label)))));
  const last = weeks[weeks.length - 1];
  const plot = h('div', {
    class: 'chart-plot', tabindex: '0', role: 'group', 'aria-roledescription': 'chart', style: { height: `${height}px` },
    'aria-label': `Readiness by week, ${weeks.length} weeks. Latest week of ${fmtDay(last.start)}: ${LEVELS.map(([k, l]) => `${last.counts[k]} ${l.toLowerCase()}`).join(', ')}. Use the arrow keys to read each week.`,
  });
  const tip = h('div', { class: 'chart-tip', 'aria-live': 'polite' });
  tip.hidden = true;
  plot.append(tip);
  fig.append(plot);
  let svgEl = null;
  let groups = [];
  let active = -1;
  let width = 0;
  const show = (i) => {
    if (!groups.length) return;
    active = Math.max(0, Math.min(groups.length - 1, i));
    groups.forEach((g) => g.el.classList.remove('is-active'));
    const g = groups[active];
    g.el.classList.add('is-active');
    const w = g.week;
    clear(tip);
    tip.append(h('div', { class: 'tip-title' }, `Week of ${fmtDay(w.start)}`), ...LEVELS.filter(([k]) => w.counts[k]).map(([k, l, cls]) => h('div', { class: 'tip-row' },
      key(cls, `${pid}-t`), h('strong', { class: 'tip-value' }, String(w.counts[k])), h('span', { class: 'tip-label' }, l))));
    tip.hidden = false;
    const tw = tip.offsetWidth || 150;
    tip.style.left = `${g.cx + 14 + tw > width ? Math.max(0, g.cx - 14 - tw) : g.cx + 14}px`;
  };
  const hide = () => { active = -1; groups.forEach((g) => g.el.classList.remove('is-active')); tip.hidden = true; };
  const draw = (W) => {
    const m = { t: 10, r: 12, b: 26, l: 46 };
    const H = height;
    const iw = Math.max(10, W - m.l - m.r);
    const ih = Math.max(10, H - m.t - m.b);
    const band = iw / weeks.length;
    const bw = Math.max(2, Math.min(24, band * 0.62, band - 2));
    const unit = ih / 7;
    const root = s('svg', { width: W, height: H, viewBox: `0 0 ${W} ${H}`, class: 'chart-svg', 'aria-hidden': 'true', focusable: 'false' });
    root.append(patterns(pid));
    for (const t of [0, 7]) {
      const y = m.t + ih - t * unit;
      root.append(s('line', { x1: m.l, x2: m.l + iw, y1: y, y2: y, class: t === 0 ? 'axis-line' : 'grid-line' }));
      root.append(s('text', { x: m.l - 8, y, class: 'tick', 'text-anchor': 'end', 'dominant-baseline': 'middle' }, t === 0 ? '0' : '7 days'));
    }
    const every = Math.max(1, Math.ceil(52 / band));
    groups = [];
    weeks.forEach((w, i) => {
      const cx = m.l + band * i + band / 2;
      if (i % every === 0 || i === weeks.length - 1) root.append(s('text', { x: cx, y: H - 6, class: 'tick', 'text-anchor': 'middle' }, fmtShort(w.start)));
      const g = s('g', { class: 'bar-g' });
      let y = m.t + ih;
      const segs = LEVELS.filter(([k]) => w.counts[k] > 0);
      segs.forEach(([k, , cls], si) => {
        const full = w.counts[k] * unit;
        const top = si === segs.length - 1;
        const hgt = Math.max(1, full - (top ? 0 : 2));
        const x = cx - bw / 2;
        const y1 = y - hgt;
        const fill = cls === 'rd-amber' ? `url(#${pid}-amber)` : cls === 'rd-red' ? `url(#${pid}-red)` : undefined;
        if (top) {
          const r = Math.min(4, bw / 2, hgt);
          g.append(s('path', { class: `rd-seg ${cls}`, fill, d: `M${x},${y}V${y1 + r}A${r},${r} 0 0 1 ${x + r},${y1}H${x + bw - r}A${r},${r} 0 0 1 ${x + bw},${y1 + r}V${y}Z` }));
        } else {
          g.append(s('rect', { class: `rd-seg ${cls}`, fill, x, y: y1, width: bw, height: hgt }));
        }
        y -= full;
      });
      g.append(s('rect', { x: m.l + band * i, y: m.t, width: band, height: ih, class: 'hit' }));
      g.addEventListener('pointerenter', () => show(i));
      g.addEventListener('pointerleave', hide);
      root.append(g);
      groups.push({ el: g, week: w, cx });
    });
    width = W;
    if (svgEl) svgEl.replaceWith(root); else plot.prepend(root);
    svgEl = root;
    if (active >= 0) show(active);
  };
  plot.addEventListener('focus', () => { if (active < 0) show(weeks.length - 1); });
  plot.addEventListener('blur', hide);
  plot.addEventListener('keydown', (e) => {
    const map = { ArrowLeft: -1, ArrowDown: -1, ArrowRight: 1, ArrowUp: 1 };
    if (e.key in map) { e.preventDefault(); show((active < 0 ? weeks.length - 1 : active) + map[e.key]); }
    else if (e.key === 'Home') { e.preventDefault(); show(0); }
    else if (e.key === 'End') { e.preventDefault(); show(weeks.length - 1); }
    else if (e.key === 'Escape') hide();
  });
  observeWidth(plot, draw);
  let table = null;
  const btn = h('button', { type: 'button', class: 'btn-link chart-table-toggle', 'aria-expanded': 'false', onClick: () => {
    if (!table) { table = tableView(weeks); table.hidden = true; fig.append(table); }
    table.hidden = !table.hidden;
    btn.setAttribute('aria-expanded', String(!table.hidden));
    btn.textContent = table.hidden ? 'Show as table' : 'Hide table';
  } }, 'Show as table');
  fig.append(h('div', { class: 'chart-foot' }, btn));
  return fig;
}
