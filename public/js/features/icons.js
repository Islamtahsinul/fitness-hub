// A small line-icon set (20 × 20 grid, 1.6 stroke, round caps) built with the safe SVG helper.
// Icons are always decorative: the text next to them carries the meaning.

import { s } from '../dom.js';

const PATHS = {
  swap: ['M4 7h11l-3-3', 'M16 13H5l3 3'],
  plates: ['M4 5v10', 'M7 3.5v13', 'M10 6v8', 'M10 10h7'],
  copy: ['M7 7h9v10H7z', 'M4 13V3h9'],
  check: ['M4.5 10.5l3.5 3.5 7.5-8'],
  checks: ['M2.5 10.5 6 14l7-8', 'M9.5 13l1 1 7-8'],
  plus: ['M10 4v12', 'M4 10h12'],
  minus: ['M4 10h12'],
  undo: ['M7 5 3.5 8.5 7 12', 'M4 8.5h8a4.5 4.5 0 0 1 0 9H9'],
  clock: ['M10 2.8a7.2 7.2 0 1 0 0 14.4a7.2 7.2 0 1 0 0-14.4', 'M10 6v4.2l2.8 1.8'],
  trash: ['M4 6h12', 'M8 6V4h4v2', 'M5.5 6l.8 10.5h7.4l.8-10.5'],
  chevron: ['M7.5 4.5 13 10l-5.5 5.5'],
  close: ['M5 5l10 10', 'M15 5 5 15'],
  info: ['M10 2.8a7.2 7.2 0 1 0 0 14.4a7.2 7.2 0 1 0 0-14.4', 'M10 9v5', 'M10 6.2v.1'],
  calendar: ['M3 4.5h14v12.5H3z', 'M3 8.5h14', 'M7 2.5v4', 'M13 2.5v4'],
  edit: ['M4 16l.7-3.3L13 4.4l2.6 2.6-8.3 8.3z', 'M11.5 6l2.5 2.5'],
  pulse: ['M2.5 10.5h3.2l1.8-4.5 3.3 8.5 2-4h4.7'],
  dumbbell: ['M6.5 5.5v9', 'M13.5 5.5v9', 'M3.5 7.5v5', 'M16.5 7.5v5', 'M6.5 10h7'],
  signpost: ['M10 2.5v15', 'M10 4.5h5.5l2 2.2-2 2.3H10', 'M10 10.5H4.5l-2 2.2 2 2.3H10'],
  grid: ['M3 4h14v12H3z', 'M3 8h14', 'M3 12h14', 'M8 4v12', 'M12.5 4v12'],
  moon: ['M15.5 12.6A6.5 6.5 0 0 1 7.4 4.5a6.5 6.5 0 1 0 8.1 8.1z'],
  flag: ['M5 17.5V3', 'M5 3.5h9l-2 3.2 2 3.3H5'],
  target: ['M10 2.8a7.2 7.2 0 1 0 0 14.4a7.2 7.2 0 1 0 0-14.4', 'M10 6.5a3.5 3.5 0 1 0 0 7a3.5 3.5 0 1 0 0-7', 'M10 9.6v.8'],
  route: ['M4.5 16.5c0-3 3-3 5-5.5s.5-4.5 3-6', 'M4.5 16.5h.1', 'M12.5 5h.1', 'M14.5 3.5l1.5 1.5-1.5 1.5'],
  print: ['M5.5 7.5V3h9v4.5', 'M5.5 14H3.5V8h13v6h-2', 'M5.5 11.5h9V17h-9z'],
};

export function icon(name, size = 18, cls = '') {
  const svg = s('svg', { width: size, height: size, viewBox: '0 0 20 20', class: `ico${cls ? ` ${cls}` : ''}`, 'aria-hidden': 'true', focusable: 'false' });
  for (const d of PATHS[name] || []) svg.append(s('path', { d }));
  return svg;
}

/** A UK footpath-style waymark disc (a circle with an arrow), for coach notes. */
export function waymark(size = 22) {
  const svg = s('svg', { width: size, height: size, viewBox: '0 0 22 22', class: 'waymark', 'aria-hidden': 'true', focusable: 'false' });
  svg.append(s('circle', { cx: 11, cy: 11, r: 10, class: 'wm-disc' }), s('path', { d: 'M6 11.5h8.5M11 7.5l4 4-4 4', class: 'wm-arrow' }));
  return svg;
}
