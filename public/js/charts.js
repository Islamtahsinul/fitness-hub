// Hand-rolled SVG charts (dataviz method): thin marks, 2px lines, >=8px dots with a 2px
// surface ring, <=24px columns with 4px rounded data-ends, hairline solid grid, one y-axis,
// a crosshair/tooltip layer on hover and keyboard focus, and a table view for every chart.
// All text goes in via text nodes. Colours come from CSS custom properties (.s1/.s2/.s3/.muted).

import { h, s, clear, fmtNum } from './dom.js';
import { toDayNum, fromDayNum, fmtShort, fmtDay, weekdayIndex, mondayOf, addDays } from './dates.js';

const registry = new Set();

/** Dots are drawn only for series up to this many points (PERF3); longer series show the line. */
export const DOTS_MAX = 150;

/**
 * Weekly means of [{date, value}] (one point per Monday-based week, dated mid-week). Used for
 * ranges over a year, so a long history draws a few hundred points, not thousands.
 */
export function weeklyMeans(points) {
  const buckets = new Map();
  for (const p of Array.isArray(points) ? points : []) {
    if (!p || !p.date || !Number.isFinite(p.value)) continue;
    const m = mondayOf(p.date);
    const b = buckets.get(m) || { sum: 0, n: 0 };
    b.sum += p.value;
    b.n += 1;
    buckets.set(m, b);
  }
  return [...buckets.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([m, b]) => ({ date: addDays(m, 3), value: b.sum / b.n, n: b.n }));
}

/** Disconnect resize observers for charts that are no longer in the page. */
export function cleanupCharts() {
  for (const entry of [...registry]) {
    if (!entry.el.isConnected) { entry.ro.disconnect(); registry.delete(entry); }
  }
}

export function observeWidth(el, draw) {
  let last = 0;
  let raf = 0;
  const ro = new ResizeObserver((entries) => {
    const w = Math.floor(entries[0].contentRect.width);
    if (w > 0 && w !== last) {
      last = w;
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => draw(w));
    }
  });
  ro.observe(el);
  registry.add({ el, ro });
}

function niceStep(range, count) {
  const raw = range / Math.max(1, count);
  const mag = 10 ** Math.floor(Math.log10(raw));
  const norm = raw / mag;
  const step = norm < 1.5 ? 1 : norm < 3 ? 2 : norm < 7 ? 5 : 10;
  return step * mag;
}

export function niceScale(min, max, count = 4, includeZero = false) {
  let lo = min, hi = max;
  if (includeZero) { lo = Math.min(0, lo); hi = Math.max(0, hi); }
  if (lo === hi) { const pad = Math.abs(lo) * 0.05 || 1; lo -= pad; hi += pad; }
  const step = niceStep(hi - lo, count);
  const dec = Math.max(0, -Math.floor(Math.log10(step)) + 1);
  const r = (v) => Number(v.toFixed(dec));
  const a = r(Math.floor(lo / step) * step);
  const b = r(Math.ceil(hi / step) * step);
  const ticks = [];
  for (let v = a, i = 0; v <= b + step / 2 && i < 20; v = r(v + step), i++) ticks.push(v);
  return { lo: a, hi: b, ticks, step };
}

function fmtTick(v, step) {
  const dp = step < 1 ? Math.min(2, Math.ceil(-Math.log10(step))) : 0;
  return Math.abs(v) >= 10000 ? `${fmtNum(v / 1000, 1)}K` : fmtNum(v, dp);
}

function dateTicks(d0, d1, width) {
  const span = d1 - d0;
  const maxTicks = Math.max(2, Math.floor(width / 80));
  for (const step of [1, 2, 7, 14, 28, 56, 91, 182, 364]) {
    if (span / step <= maxTicks) {
      let start = d0;
      if (step >= 7) start = d0 + ((7 - weekdayIndex(fromDayNum(d0))) % 7);
      const out = [];
      for (let d = start; d <= d1; d += step) out.push(d);
      return out;
    }
  }
  return [d0, d1];
}

function legend(items) {
  return h('ul', { class: 'chart-legend' }, items.map((it) => h('li', { class: 'legend-item' }, swatch(it), h('span', null, it.label))));
}

function swatch(it) {
  const svg = s('svg', { width: 20, height: 12, viewBox: '0 0 20 12', 'aria-hidden': 'true', class: 'legend-key' });
  if (it.kind === 'dot') svg.append(s('circle', { cx: 10, cy: 6, r: 4, class: `dot ${it.cls}` }));
  else if (it.kind === 'band') svg.append(s('rect', { x: 1, y: 1, width: 18, height: 10, rx: 2, class: 'band-key' }));
  else if (it.kind === 'ref') svg.append(s('line', { x1: 1, x2: 19, y1: 6, y2: 6, class: 'ref-line' }));
  else if (it.kind === 'rect') svg.append(s('rect', { x: 4, y: 1, width: 12, height: 10, rx: 2, class: `bar ${it.cls}` }));
  else svg.append(s('line', { x1: 1, x2: 19, y1: 6, y2: 6, class: `line ${it.cls}` }));
  return svg;
}

function tableView(columns, rows, caption) {
  return h('div', { class: 'table-wrap chart-table' },
    h('table', { class: 'table table-compact' },
      caption ? h('caption', { class: 'visually-hidden' }, caption) : null,
      h('thead', null, h('tr', null, columns.map((c, i) => h('th', { scope: 'col', class: i ? 'num' : null }, c)))),
      h('tbody', null, rows.map((r) => h('tr', null, r.map((v, i) => h(i ? 'td' : 'th', { scope: i ? null : 'row', class: i ? 'num' : null }, v)))))));
}

function chartShell({ title, subtitle, compact, legendItems }) {
  const fig = h('figure', { class: ['chart', compact && 'chart-compact'] });
  if (title && !compact) {
    fig.append(h('figcaption', { class: 'chart-head' },
      h('h3', { class: 'chart-title' }, title),
      subtitle ? h('p', { class: 'chart-sub' }, subtitle) : null));
  }
  if (!compact && legendItems && legendItems.length >= 2) fig.append(legend(legendItems));
  return fig;
}

/** "Show as table": the table is built the first time it's opened (long histories stay cheap). */
function addTableToggle(fig, columns, rowsOrFn, caption) {
  const host = h('div', { class: 'chart-table-host' });
  let wrap = null;
  const btn = h('button', {
    type: 'button', class: 'btn-link chart-table-toggle', 'aria-expanded': 'false',
    onClick: () => {
      if (!wrap) {
        wrap = tableView(columns, typeof rowsOrFn === 'function' ? rowsOrFn() : rowsOrFn, caption);
        wrap.hidden = true;
        host.append(wrap);
      }
      wrap.hidden = !wrap.hidden;
      btn.setAttribute('aria-expanded', String(!wrap.hidden));
      btn.textContent = wrap.hidden ? 'Show as table' : 'Hide table';
    },
  }, 'Show as table');
  fig.append(h('div', { class: 'chart-foot' }, btn), host);
}

/** Index of the value in a sorted number array nearest to x. */
function nearestIndex(sorted, x) {
  let lo = 0;
  let hi = sorted.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid] < x) lo = mid; else hi = mid;
  }
  return Math.abs(sorted[lo] - x) <= Math.abs(sorted[hi] - x) ? lo : hi;
}

function placeTip(tip, plot, x, width) {
  tip.hidden = false;
  const tw = tip.offsetWidth || 160;
  const left = x + 14 + tw > width ? Math.max(0, x - 14 - tw) : x + 14;
  tip.style.left = `${left}px`;
}

function tipRow(cls, valueText, label, kind = 'line') {
  return h('div', { class: 'tip-row' }, swatch({ cls, kind }), h('strong', { class: 'tip-value' }, valueText), label ? h('span', { class: 'tip-label' }, label) : null);
}

/**
 * Time-series chart.
 * series: [{label, cls:'s1'|'s2'|'s3'|'muted', points:[{date, value}], line?:bool, dots?:'all'|'end'|'none', area?:bool, endLabel?:bool}]
 * band: {label, points:[{date, lo, hi}]}, refs: [{value, label}]
 */
export function timeChart(opts) {
  const {
    title = '', subtitle = '', series = [], band = null, refs = [], unit = '', dp = 1, height = 200,
    compact = false, yZero = false, xDomain = null, empty = 'Nothing logged yet.', valueFormat = null, ariaLabel = '',
  } = opts;
  const fmt = valueFormat || ((v) => `${fmtNum(v, dp)}${unit ? ` ${unit}` : ''}`);
  const live = series.map((sr) => ({ ...sr, points: (sr.points || []).filter((p) => p && p.date && Number.isFinite(p.value)).sort((a, b) => (a.date < b.date ? -1 : 1)) }));
  const legendItems = [
    ...live.filter((sr) => sr.points.length && !sr.noLegend).map((sr) => ({ label: sr.label, cls: sr.cls, kind: sr.line === false ? 'dot' : 'line' })),
    ...(band && band.points?.length ? [{ label: band.label, kind: 'band' }] : []),
    ...refs.filter((r) => r.legend).map((r) => ({ label: r.label, kind: 'ref' })),
  ];
  const fig = chartShell({ title, subtitle, compact, legendItems });
  const all = live.flatMap((sr) => sr.points);
  if (!all.length) {
    fig.append(h('p', { class: compact ? 'chart-empty chart-empty-compact' : 'chart-empty' }, empty));
    return fig;
  }
  const dates = [...new Set(all.map((p) => p.date))].sort();
  const bandPts = band && Array.isArray(band.points) ? band.points.filter((p) => Number.isFinite(p.lo) && Number.isFinite(p.hi)) : [];
  let x0 = xDomain ? toDayNum(xDomain[0]) : toDayNum(dates[0]);
  let x1 = xDomain ? toDayNum(xDomain[1]) : toDayNum(dates[dates.length - 1]);
  if (x0 === x1) { x0 -= 3; x1 += 3; }
  const ys = [...all.map((p) => p.value), ...bandPts.flatMap((p) => [p.lo, p.hi]), ...refs.map((r) => r.value).filter(Number.isFinite)];
  const sc = niceScale(Math.min(...ys), Math.max(...ys), compact ? 2 : 4, yZero);

  const summary = ariaLabel || `${title || 'Chart'}: ${live.filter((sr) => sr.points.length).map((sr) => `${sr.label} latest ${fmt(sr.points[sr.points.length - 1].value)} on ${fmtDay(sr.points[sr.points.length - 1].date)}`).join('; ')}`;
  const plot = h('div', { class: 'chart-plot', tabindex: '0', role: 'group', 'aria-roledescription': 'chart', 'aria-label': `${summary}. Use the arrow keys to read values.`, style: { height: `${height}px` } });
  const tip = h('div', { class: 'chart-tip', 'aria-live': 'polite' });
  tip.hidden = true;
  plot.append(tip);
  fig.append(plot);

  const endLabelled = live.filter((sr) => sr.endLabel && sr.points.length);
  const rightPad = compact ? 6 : endLabelled.length ? 64 : 16;
  let svgEl = null;
  let geom = null;
  let active = -1;

  const byDate = new Map(live.map((sr) => [sr, new Map(sr.points.map((p) => [p.date, p]))]));
  const valueAt = (sr, d) => byDate.get(sr)?.get(d);

  const draw = (W) => {
    const m = compact ? { t: 6, r: rightPad, b: 6, l: 4 } : { t: 12, r: rightPad, b: 26, l: 46 };
    const H = height;
    const iw = Math.max(10, W - m.l - m.r);
    const ih = Math.max(10, H - m.t - m.b);
    const X = (d) => m.l + ((d - x0) / (x1 - x0)) * iw;
    const Y = (v) => m.t + (1 - (v - sc.lo) / (sc.hi - sc.lo || 1)) * ih;
    const root = s('svg', { width: W, height: H, viewBox: `0 0 ${W} ${H}`, class: 'chart-svg', 'aria-hidden': 'true', focusable: 'false' });
    if (!compact) {
      for (const t of sc.ticks) {
        root.append(s('line', { x1: m.l, x2: m.l + iw, y1: Y(t), y2: Y(t), class: 'grid-line' }));
        root.append(s('text', { x: m.l - 8, y: Y(t), class: 'tick', 'text-anchor': 'end', 'dominant-baseline': 'middle' }, fmtTick(t, sc.step)));
      }
      for (const d of dateTicks(x0, x1, iw)) {
        root.append(s('text', { x: X(d), y: H - 6, class: 'tick', 'text-anchor': 'middle' }, fmtShort(fromDayNum(d))));
      }
      root.append(s('line', { x1: m.l, x2: m.l + iw, y1: m.t + ih, y2: m.t + ih, class: 'axis-line' }));
    }
    if (bandPts.length > 1) {
      const pts = bandPts.map((p) => [X(toDayNum(p.date)), Y(p.hi), Y(p.lo)]);
      const d = `M${pts.map((p) => `${p[0].toFixed(1)},${p[1].toFixed(1)}`).join('L')}L${pts.slice().reverse().map((p) => `${p[0].toFixed(1)},${p[2].toFixed(1)}`).join('L')}Z`;
      root.append(s('path', { d, class: 'band-area' }));
    }
    for (const r of refs) {
      if (!Number.isFinite(r.value)) continue;
      root.append(s('line', { x1: m.l, x2: m.l + iw, y1: Y(r.value), y2: Y(r.value), class: 'ref-line' }));
      if (!compact && r.label) root.append(s('text', { x: m.l + 4, y: Y(r.value) - 5, class: 'ref-label' }, r.label));
    }
    for (const sr of live) {
      if (!sr.points.length) continue;
      const pts = sr.points.map((p) => [X(toDayNum(p.date)), Y(p.value)]);
      if (sr.area && pts.length > 1) {
        const base = Y(Math.max(sc.lo, Math.min(0, sc.hi)));
        root.append(s('path', { d: `M${pts[0][0]},${base}L${pts.map((p) => `${p[0].toFixed(1)},${p[1].toFixed(1)}`).join('L')}L${pts[pts.length - 1][0]},${base}Z`, class: `area ${sr.cls}` }));
      }
      if (sr.line !== false && pts.length > 1) {
        root.append(s('path', { d: `M${pts.map((p) => `${p[0].toFixed(1)},${p[1].toFixed(1)}`).join('L')}`, class: `line ${sr.cls}` }));
      }
      let dots = sr.dots || (sr.line === false ? 'all' : 'end');
      if (dots === 'all' && pts.length > DOTS_MAX) dots = sr.line === false ? 'none' : 'end';
      const list = dots === 'all' ? pts : dots === 'end' ? [pts[pts.length - 1]] : [];
      for (const p of list) root.append(s('circle', { cx: p[0], cy: p[1], r: compact ? 3.5 : 4, class: `dot ${sr.cls}` }));
    }
    if (!compact && endLabelled.length) {
      const labels = endLabelled.map((sr) => { const p = sr.points[sr.points.length - 1]; return { y: Y(p.value), x: X(toDayNum(p.date)), text: fmt(p.value) }; });
      const collide = labels.length > 1 && labels.some((a, i) => labels.some((b, j) => i < j && Math.abs(a.y - b.y) < 14));
      if (!collide) for (const l of labels) root.append(s('text', { x: l.x + 9, y: l.y, class: 'end-label', 'dominant-baseline': 'middle' }, l.text));
    }
    const cross = s('line', { class: 'crosshair', x1: 0, x2: 0, y1: m.t, y2: m.t + ih, visibility: 'hidden' });
    const hl = s('g', { class: 'hl' });
    root.append(cross, hl);
    geom = { X, Y, cross, hl, W, Xinv: (px) => x0 + ((px - m.l) / iw) * (x1 - x0) };
    if (svgEl) svgEl.replaceWith(root); else plot.prepend(root);
    svgEl = root;
    if (active >= 0) show(active);
  };

  const show = (i) => {
    if (!geom) return;
    active = Math.max(0, Math.min(dates.length - 1, i));
    const d = dates[active];
    const x = geom.X(toDayNum(d));
    geom.cross.setAttribute('x1', x);
    geom.cross.setAttribute('x2', x);
    geom.cross.setAttribute('visibility', 'visible');
    clear(geom.hl);
    clear(tip);
    tip.append(h('div', { class: 'tip-title' }, fmtDay(d)));
    for (const sr of live) {
      const p = valueAt(sr, d);
      if (!p) continue;
      geom.hl.append(s('circle', { cx: x, cy: geom.Y(p.value), r: 5, class: `dot hl-dot ${sr.cls}` }));
      tip.append(tipRow(sr.cls, fmt(p.value), sr.label, sr.line === false ? 'dot' : 'line'));
    }
    const b = bandPts.find((p) => p.date === d);
    if (b) tip.append(h('div', { class: 'tip-row tip-band' }, swatch({ kind: 'band' }), h('span', { class: 'tip-label' }, `${band.label}: ${fmt(b.lo)} to ${fmt(b.hi)}`)));
    placeTip(tip, plot, x, geom.W);
  };
  const hide = () => {
    active = -1;
    if (geom) { geom.cross.setAttribute('visibility', 'hidden'); clear(geom.hl); }
    tip.hidden = true;
  };
  const dayNums = dates.map(toDayNum);
  plot.addEventListener('pointermove', (e) => {
    if (!svgEl || !geom || !dayNums.length) return;
    const px = e.clientX - svgEl.getBoundingClientRect().left;
    const day = geom.Xinv(px);
    const best = nearestIndex(dayNums, day);
    if (best !== active) show(best);
  });
  plot.addEventListener('pointerleave', hide);
  plot.addEventListener('focus', () => { if (active < 0) show(dates.length - 1); });
  plot.addEventListener('blur', hide);
  plot.addEventListener('keydown', (e) => {
    const map = { ArrowLeft: -1, ArrowDown: -1, ArrowRight: 1, ArrowUp: 1 };
    if (e.key in map) { e.preventDefault(); show((active < 0 ? dates.length - 1 : active) + map[e.key]); }
    else if (e.key === 'Home') { e.preventDefault(); show(0); }
    else if (e.key === 'End') { e.preventDefault(); show(dates.length - 1); }
    else if (e.key === 'Escape') hide();
  });
  observeWidth(plot, draw);

  if (!compact) {
    const cols = ['Date', ...live.filter((sr) => sr.points.length).map((sr) => sr.label)];
    const rows = () => {
      const maps = live.filter((sr) => sr.points.length).map((sr) => new Map(sr.points.map((p) => [p.date, p])));
      return dates.slice().reverse().map((d) => [fmtDay(d), ...maps.map((mp) => { const p = mp.get(d); return p ? fmt(p.value) : '–'; })]);
    };
    addTableToggle(fig, cols, rows, title);
  }
  return fig;
}

/**
 * Column chart: bars [{key, label, tip, value}], optional target line. One series, one colour.
 * The plot is a single tab stop: the arrow keys (and Home/End) move between bars, Esc closes
 * the tooltip. Bars keep a 2px surface gap between neighbours.
 */
export function columnChart(opts) {
  const { title = '', subtitle = '', bars = [], target = null, targetLabel = 'Target', unit = '', dp = 0, height = 180, cls = 's1', empty = 'Nothing logged yet.', valueFormat = null } = opts;
  const fmt = valueFormat || ((v) => `${fmtNum(v, dp)}${unit ? ` ${unit}` : ''}`);
  const fig = chartShell({ title, subtitle, compact: false, legendItems: [] });
  const live = bars.filter((b) => Number.isFinite(b.value));
  if (!live.length || live.every((b) => b.value === 0) && !Number.isFinite(target)) {
    fig.append(h('p', { class: 'chart-empty' }, empty));
    return fig;
  }
  const maxV = Math.max(...live.map((b) => b.value), Number.isFinite(target) ? target : 0);
  const sc = niceScale(0, maxV || 1, 4, true);
  const lastWith = bars.reduce((li, b, i) => (Number.isFinite(b.value) && b.value > 0 ? i : li), -1);
  const latest = lastWith >= 0 ? bars[lastWith] : null;
  const summary = `${title || 'Chart'}: ${bars.length} bars${latest ? `, latest ${latest.tip || latest.label} ${fmt(latest.value)}` : ''}${Number.isFinite(target) ? `, ${targetLabel.toLowerCase()} ${fmt(target)}` : ''}. Use the arrow keys to read each bar.`;
  const plot = h('div', { class: 'chart-plot', tabindex: '0', role: 'group', 'aria-roledescription': 'chart', 'aria-label': summary, style: { height: `${height}px` } });
  const tip = h('div', { class: 'chart-tip', 'aria-live': 'polite' });
  tip.hidden = true;
  plot.append(tip);
  fig.append(plot);
  let svgEl = null;
  let groups = [];
  let active = -1;
  let geomW = 0;

  const show = (i) => {
    if (!groups.length) return;
    const idx = Math.max(0, Math.min(groups.length - 1, i));
    const g = groups[idx];
    if (!g) return;
    groups.forEach((x) => x.el.classList.remove('is-active'));
    active = idx;
    g.el.classList.add('is-active');
    const b = g.bar;
    clear(tip);
    tip.append(h('div', { class: 'tip-title' }, b.tip || b.label), tipRow(cls, Number.isFinite(b.value) ? fmt(b.value) : 'Nothing logged', '', 'rect'));
    if (Number.isFinite(target)) tip.append(h('div', { class: 'tip-row' }, swatch({ kind: 'ref' }), h('span', { class: 'tip-label' }, `${targetLabel} ${fmt(target)}`)));
    placeTip(tip, plot, g.cx, geomW);
  };
  const hide = () => { active = -1; groups.forEach((x) => x.el.classList.remove('is-active')); tip.hidden = true; };

  const draw = (W) => {
    const m = { t: 18, r: Number.isFinite(target) ? 74 : 12, b: 26, l: 46 };
    const H = height;
    const iw = Math.max(10, W - m.l - m.r);
    const ih = Math.max(10, H - m.t - m.b);
    const band = iw / bars.length;
    const bw = Math.max(2, Math.min(24, band * 0.62, band - 2));
    const Y = (v) => m.t + (1 - (v - sc.lo) / (sc.hi - sc.lo || 1)) * ih;
    const root = s('svg', { width: W, height: H, viewBox: `0 0 ${W} ${H}`, class: 'chart-svg', 'aria-hidden': 'true', focusable: 'false' });
    for (const t of sc.ticks) {
      root.append(s('line', { x1: m.l, x2: m.l + iw, y1: Y(t), y2: Y(t), class: t === 0 ? 'axis-line' : 'grid-line' }));
      root.append(s('text', { x: m.l - 8, y: Y(t), class: 'tick', 'text-anchor': 'end', 'dominant-baseline': 'middle' }, fmtTick(t, sc.step)));
    }
    const every = Math.max(1, Math.ceil(44 / band));
    groups = [];
    bars.forEach((b, i) => {
      const cx = m.l + band * i + band / 2;
      if (i % every === 0 || i === bars.length - 1) {
        root.append(s('text', { x: cx, y: H - 6, class: 'tick', 'text-anchor': 'middle' }, b.label));
      }
      const g = s('g', { class: 'bar-g' });
      if (Number.isFinite(b.value)) {
        const y0 = Y(0);
        const y1 = Y(b.value);
        const hgt = y0 - y1;
        const x = cx - bw / 2;
        const r = Math.min(4, bw / 2, hgt);
        if (hgt > 0.5) {
          g.append(s('path', { class: `bar ${cls}`, d: `M${x},${y0}V${y1 + r}A${r},${r} 0 0 1 ${x + r},${y1}H${x + bw - r}A${r},${r} 0 0 1 ${x + bw},${y1 + r}V${y0}Z` }));
        }
      }
      g.append(s('rect', { x: m.l + band * i, y: m.t, width: band, height: ih, class: 'hit' }));
      g.addEventListener('pointerenter', () => show(i));
      g.addEventListener('pointerleave', hide);
      root.append(g);
      groups.push({ el: g, bar: b, cx });
      if (i === lastWith) root.append(s('text', { x: cx, y: Y(b.value) - 6, class: 'end-label', 'text-anchor': 'middle' }, fmtNum(b.value, dp)));
    });
    if (Number.isFinite(target)) {
      root.append(s('line', { x1: m.l, x2: m.l + iw, y1: Y(target), y2: Y(target), class: 'ref-line' }));
      root.append(s('text', { x: m.l + iw + 6, y: Y(target), class: 'ref-label', 'dominant-baseline': 'middle' }, `${targetLabel} ${fmtNum(target, dp)}`));
    }
    geomW = W;
    if (svgEl) svgEl.replaceWith(root); else plot.prepend(root);
    svgEl = root;
    if (active >= 0) show(active);
  };
  plot.addEventListener('focus', () => { if (active < 0) show(lastWith >= 0 ? lastWith : bars.length - 1); });
  plot.addEventListener('blur', hide);
  plot.addEventListener('keydown', (e) => {
    const map = { ArrowLeft: -1, ArrowDown: -1, ArrowRight: 1, ArrowUp: 1 };
    if (e.key in map) { e.preventDefault(); show((active < 0 ? bars.length - 1 : active) + map[e.key]); }
    else if (e.key === 'Home') { e.preventDefault(); show(0); }
    else if (e.key === 'End') { e.preventDefault(); show(bars.length - 1); }
    else if (e.key === 'Escape') { hide(); }
  });
  observeWidth(plot, draw);
  addTableToggle(fig, ['Period', title || 'Value', ...(Number.isFinite(target) ? [targetLabel] : [])],
    bars.slice().reverse().map((b) => [b.tip || b.label, Number.isFinite(b.value) ? fmt(b.value) : '–', ...(Number.isFinite(target) ? [fmt(target)] : [])]), title);
  return fig;
}

/** Progress meter: a fill on a lighter track of the same hue. */
export function meter({ value, max, label = '', valueText = '', tone = 'accent' }) {
  const v = Number.isFinite(value) ? value : 0;
  const pct = max > 0 ? Math.max(0, Math.min(100, (v / max) * 100)) : 0;
  return h('div', {
    class: ['meter', `meter-${tone}`], role: 'meter', 'aria-valuemin': '0', 'aria-valuemax': String(max || 0),
    'aria-valuenow': String(v), 'aria-valuetext': valueText || `${fmtNum(v)} of ${fmtNum(max)}`, 'aria-label': label || undefined,
  }, h('div', { class: 'meter-fill', style: { width: `${pct}%` } }));
}

export function sparkline({ points, cls = 's1', label = '', unit = '', dp = 1, band = null, refs = [] }) {
  return timeChart({ series: [{ label, cls, points, endLabel: false }], band, refs, compact: true, height: 44, unit, dp, ariaLabel: label, empty: 'No entries yet' });
}

// Esc dismisses any chart tooltip shown by hovering (WCAG 1.4.13), not only the focused chart's.
if (typeof document !== 'undefined') {
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    for (const tip of document.querySelectorAll('.chart-tip')) tip.hidden = true;
    for (const g of document.querySelectorAll('.bar-g.is-active')) g.classList.remove('is-active');
  });
}
