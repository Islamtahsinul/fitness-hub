// The programme drawn as a hill route: each phase is a leg that climbs to a field gate (the
// clearance needed for the next leg). Walked ground is bilberry; planned ground is grey;
// legs still waiting for a gate are dashed. A ringed dot marks where you are today.
//
// Leg widths are proportional to weeks but never narrower than a readable minimum; the SVG
// and the labels underneath share the same pixel widths, so gates line up with their legs.

import { h, s } from './dom.js';
import { addDays, daysBetween, fmtRange, fmtDay } from './dates.js';
import { positionOn, isGateMet } from './schedule.js';
import { observeWidth } from './charts.js';

let clipCounter = 0;
const PAD = { l: 8, r: 12 };

function smooth(x) {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  return x * x * (3 - 2 * x);
}

/** Pixel width per leg: proportional to weeks, with a floor (water-filling). */
export function legWidths(weeks, width, minPx) {
  const n = weeks.length;
  const floor = Math.min(minPx, width / n);
  const fixed = new Array(n).fill(false);
  let out = weeks.slice();
  for (let iter = 0; iter <= n; iter++) {
    const fixedCount = fixed.filter(Boolean).length;
    const freeW = width - fixedCount * floor;
    const freeWeeks = weeks.reduce((a, w, i) => a + (fixed[i] ? 0 : w), 0) || 1;
    out = weeks.map((w, i) => (fixed[i] ? floor : (freeW * w) / freeWeeks));
    let changed = false;
    out.forEach((x, i) => { if (!fixed[i] && x < floor - 0.01) { fixed[i] = true; changed = true; } });
    if (!changed) break;
  }
  return out;
}

export function routeProfile({ timeline, today, gates = [], clearances = {}, compact = false, animate = false }) {
  const phases = timeline?.phases || [];
  const wrap = h('div', { class: ['route', compact && 'route-compact'] });
  if (!phases.length) return wrap;
  const n = phases.length;
  const weeks = phases.map((p) => p.weeks);
  const pos = positionOn(timeline, today);
  let here = null; // [phase index, fraction 0..1]
  let looping = false;
  if (pos) {
    const it = phases[pos.phaseIndex];
    const wIn = daysBetween(it.start, today) / 7;
    looping = wIn >= it.weeks;
    here = [pos.phaseIndex, Math.min((wIn + 1 / 14) / it.weeks, 0.985)];
  } else if (today < timeline.start) {
    here = [0, 0];
  }
  const elev = (i, u) => i + 0.32 * u + 0.68 * smooth((u - 0.76) / 0.24);
  const gateLabel = (id) => gates.find((g) => g.id === id)?.label || id;
  const H = compact ? 60 : 112;
  const svgHost = h('div', { class: 'route-plot', style: { height: `${H}px` } });
  wrap.append(svgHost);

  let legs = null;
  if (!compact) {
    legs = h('ol', { class: 'route-legs', style: { 'padding-left': `${PAD.l}px`, 'padding-right': `${PAD.r}px` } });
    phases.forEach((p, i) => {
      const current = pos && pos.phaseIndex === i;
      let when;
      if (p.start && p.actualEnd) when = fmtRange(p.start, addDays(p.actualEnd, -1));
      else if (p.start && i === n - 1) when = `From ${fmtDay(p.start)}`;
      else if (p.start) when = `${fmtRange(p.start, addDays(p.plannedEnd, -1))}, then repeats until the next gate opens`;
      else if (p.waitingGate) when = `Waits for ${gateLabel(p.waitingGate)}`;
      else when = `After ${phases[i - 1]?.short || 'the previous phase'}`;
      const gateOpen = isGateMet(p.entryGate, clearances, today);
      const gateText = i === 0 ? 'Start' : p.entryGate === 'none' ? 'No gate' : `Gate: ${gateLabel(p.entryGate)} (${gateOpen ? 'open' : 'shut'})`;
      legs.append(h('li', { class: ['route-leg', current && 'is-current', !p.start && 'is-waiting'] },
        h('span', { class: 'leg-gate' }, gateText),
        h('span', { class: 'leg-name' }, p.short),
        h('span', { class: 'leg-when' }, when),
        current ? h('span', { class: 'leg-here' }, looping ? `You are here: repeating week ${pos.week}` : `You are here: week ${pos.week} of ${p.weeks}`) : null));
    });
    wrap.append(legs);
  }

  const draw = (W) => {
    const top = compact ? 14 : 22;
    const bottom = compact ? 6 : 8;
    const inner = Math.max(40, W - PAD.l - PAD.r);
    const widths = legWidths(weeks, inner, compact ? 40 : 124);
    const lefts = [];
    widths.reduce((acc, w, i) => { lefts[i] = acc; return acc + w; }, PAD.l);
    const X = (i, u) => lefts[i] + u * widths[i];
    const Y = (e) => H - bottom - (e / n) * (H - top - bottom);
    const sample = (i) => {
      const steps = Math.max(8, Math.round(widths[i] / 6));
      const pts = [];
      for (let k = 0; k <= steps; k++) { const u = k / steps; pts.push([X(i, u), Y(elev(i, u))]); }
      return pts;
    };
    const toPath = (pts) => `M${pts.map((p) => `${p[0].toFixed(1)},${p[1].toFixed(1)}`).join('L')}`;
    const legPts = phases.map((_, i) => sample(i));
    const all = legPts.flat();
    const clipId = `route-walked-${++clipCounter}`;
    const svg = s('svg', { width: W, height: H, viewBox: `0 0 ${W} ${H}`, class: 'route-svg', 'aria-hidden': 'true', focusable: 'false' });
    const walkedW = here ? X(here[0], here[1]) : 0;
    svg.append(s('defs', null, s('clipPath', { id: clipId }, s('rect', { x: 0, y: 0, width: walkedW, height: H }))));
    svg.append(s('path', { d: `${toPath(all)}L${X(n - 1, 1)},${H}L${X(0, 0)},${H}Z`, class: 'route-ground' }));
    phases.forEach((p, i) => svg.append(s('path', { d: toPath(legPts[i]), class: `route-seg ${p.start ? 'is-planned' : 'is-waiting'}` })));
    svg.append(s('path', { d: toPath(all), class: 'route-walked', pathLength: '1', 'clip-path': `url(#${clipId})` }));
    for (let k = 1; k < n; k++) {
      const x = X(k, 0);
      const y = Y(elev(k - 1, 1));
      const open = isGateMet(phases[k].entryGate, clearances, today);
      // Shape, not just colour: a shut gate is a closed field gate with a padlock; an open
      // gate has swung back on its hinge post.
      svg.append(open
        ? s('g', { class: 'gate-glyph is-open', transform: `translate(${(x - 8).toFixed(1)},${(y - 15).toFixed(1)})` },
          s('line', { x1: 1, y1: 0, x2: 1, y2: 14 }),
          s('line', { x1: 15, y1: 0, x2: 15, y2: 14 }),
          s('line', { x1: 1, y1: 3, x2: 6, y2: 1 }),
          s('line', { x1: 1, y1: 7.5, x2: 6, y2: 6.5 }),
          s('line', { x1: 1, y1: 12, x2: 6, y2: 12 }),
          s('line', { x1: 6, y1: 1, x2: 6, y2: 12 }))
        : s('g', { class: 'gate-glyph is-shut', transform: `translate(${(x - 8).toFixed(1)},${(y - 15).toFixed(1)})` },
          s('line', { x1: 1, y1: 0, x2: 1, y2: 14 }),
          s('line', { x1: 15, y1: 0, x2: 15, y2: 14 }),
          s('line', { x1: 1, y1: 3, x2: 15, y2: 3 }),
          s('line', { x1: 1, y1: 7.5, x2: 15, y2: 7.5 }),
          s('line', { x1: 1, y1: 12, x2: 15, y2: 12 }),
          s('line', { x1: 1, y1: 12, x2: 15, y2: 3 }),
          s('rect', { x: 11, y: 5.5, width: 6, height: 5, rx: 1, class: 'gate-lock' }),
          s('path', { d: 'M12.3 5.5V4.3a1.7 1.7 0 0 1 3.4 0v1.2', class: 'gate-lock-shackle' })));
    }
    if (here) svg.append(s('circle', { cx: X(here[0], here[1]), cy: Y(elev(here[0], here[1])), r: compact ? 5 : 6, class: 'route-here' }));
    svgHost.replaceChildren(svg);
    if (legs) legs.style.gridTemplateColumns = widths.map((w) => `${w.toFixed(1)}px`).join(' ');
  };
  observeWidth(svgHost, draw);
  if (animate) {
    wrap.classList.add('is-new');
    setTimeout(() => wrap.classList.remove('is-new'), 2000);
  }

  const where = pos
    ? `You are in ${pos.item.name}, week ${pos.week} of ${pos.item.weeks}${looping ? ', repeating while you wait for the next gate' : ''}.`
    : today < timeline.start ? `The programme starts ${fmtDay(timeline.start)}.` : '';
  const shut = phases.slice(1).filter((p) => p.entryGate !== 'none' && !isGateMet(p.entryGate, clearances, today)).map((p) => gateLabel(p.entryGate));
  svgHost.setAttribute('role', 'img');
  svgHost.setAttribute('aria-label', `Programme route with ${n} phases. ${where}${shut.length ? ` Gates still shut: ${[...new Set(shut)].join(', ')}.` : ''}`);
  return wrap;
}
