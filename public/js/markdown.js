// A small, safe Markdown renderer for the SPEC section 6 subset.
//
// Safety model: the WHOLE source is HTML-escaped before parsing. The parser then only adds
// its own tags; the only attributes it writes are validated hrefs (http/https or relative
// *.md chapter links), fixed class names, [a-z0-9-] heading ids and hex task keys.

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const UNESC = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'" };

export function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ESC[c]);
}

export function unescapeHtml(s) {
  return String(s ?? '').replace(/&(?:amp|lt|gt|quot|#39);/g, (e) => UNESC[e]);
}

const CALLOUT_KIND = { NOTE: 'note', IMPORTANT: 'note', TIP: 'tip', WARNING: 'warning', CAUTION: 'warning', SAFETY: 'safety', DANGER: 'safety' };
const CALLOUT_TITLE = { note: 'Note', tip: 'Tip', warning: 'Warning', safety: 'Safety' };

const FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const HEADING = /^ {0,3}(#{1,6})[ \t]+(.+?)[ \t]*#*[ \t]*$/;
const HR = /^ {0,3}(?:(?:-[ \t]*){3,}|(?:\*[ \t]*){3,}|(?:_[ \t]*){3,})$/;
const QUOTE = /^ {0,3}&gt;[ ]?(.*)$/;
const LIST = /^( *)([-*+]|\d{1,9}[.)])[ \t]+(.*)$/;
const TABLE_SEP = /^ *\|? *:?-+:? *(?:\| *:?-+:? *)*\|? *$/;
const TASK = /^\[( |x|X)\][ \t]+(.*)$/;

/** Plain heading text from raw (unescaped) Markdown: drops links, emphasis and code ticks. */
export function headingPlain(raw) {
  return String(raw)
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[*`]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function slugify(text) {
  const s = String(text)
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
  return s || 'section';
}

function uniqueId(base, used) {
  let id = base;
  let n = 2;
  while (used.has(id)) id = `${base}-${n++}`;
  used.add(id);
  return id;
}

export function taskKey(text) {
  let h = 5381;
  const s = String(text);
  for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
  return h.toString(16).padStart(8, '0');
}

function resolveHref(url, ctx) {
  const u = url.trim();
  if (/^https?:\/\/[^\s"'<>`]+$/i.test(u)) return { href: u, external: true };
  let m = /^(?:\.\/)?([A-Za-z0-9][A-Za-z0-9._-]*\.md)(?:#([A-Za-z0-9_-]+))?$/.exec(u);
  if (m) return { href: `#/guide/${m[1]}${m[2] ? '/' + m[2].toLowerCase() : ''}`, external: false };
  m = /^#([A-Za-z0-9_-]+)$/.exec(u);
  if (m && ctx.file) return { href: `#/guide/${ctx.file}/${m[1].toLowerCase()}`, external: false };
  return null;
}

function anchor(target, innerHtml) {
  return target.external
    ? `<a href="${target.href}" target="_blank" rel="noopener noreferrer" class="ext">${innerHtml}</a>`
    : `<a href="${target.href}">${innerHtml}</a>`;
}

function emphasis(t) {
  t = t.replace(/\*\*(\S(?:[\s\S]*?\S)?)\*\*/g, '<strong>$1</strong>');
  t = t.replace(/(^|[^\w*])\*(\S(?:[^*\n]*?\S)?)\*(?![\w*])/g, '$1<em>$2</em>');
  return t;
}

const EVIDENCE = /(?:<strong>)?\[(Strong evidence|Moderate evidence|Weak evidence|Expert opinion)\](?:<\/strong>)?/gi;

function evidence(t) {
  return t.replace(EVIDENCE, (_, label) => {
    const l = label.toLowerCase();
    const kind = l.startsWith('strong') ? 'strong' : l.startsWith('moderate') ? 'moderate' : l.startsWith('weak') ? 'weak' : 'expert';
    return `<span class="evidence ev-${kind}">${label}</span>`;
  });
}

/**
 * SPEC 5.2 round 4: no raw gate ids in user-facing text. A gate id in a code span (`clinic_light`)
 * or in running text renders as its label. Labels are plain text, escaped like everything else.
 */
export const GATE_LABELS = Object.freeze({ none: 'Now', good_arm_ok: 'Good arm OK', clinic_light: 'Light use / rehab started', grip_cleared: 'Grip cleared', full_clearance: 'Full clearance' });
const GATE_WORD = /\b(good_arm_ok|clinic_light|grip_cleared|full_clearance)\b/g;
const gateRef = (id, ctx) => `<span class="gate-ref">${escapeHtml((ctx.gateLabels && ctx.gateLabels[id]) || GATE_LABELS[id])}</span>`;

/** Inline Markdown on already-escaped text. */
function inline(text, ctx) {
  const slots = [];
  const keep = (html) => `\u0001${slots.push(html) - 1}\u0002`;
  let t = text;
  t = t.replace(/(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/g, (_, _ticks, code) => {
    const c = code.trim();
    return keep(Object.prototype.hasOwnProperty.call(GATE_LABELS, c) ? gateRef(c, ctx) : `<code>${c}</code>`);
  });
  t = t.replace(/&lt;(https?:\/\/[^\s]+?)&gt;/gi, (m, url) => {
    const target = resolveHref(url, ctx);
    return target ? keep(anchor(target, url)) : m;
  });
  t = t.replace(/\[([^\[\]]+)\]\(\s*((?:[^()\s]|\([^()\s]*\))+)\s*\)/g, (_, label, url) => {
    const target = resolveHref(url, ctx);
    const inner = evidence(emphasis(label)).replace(GATE_WORD, (id) => gateRef(id, ctx));
    return keep(target ? anchor(target, inner) : `<span class="link-off">${inner}</span>`);
  });
  t = t.replace(GATE_WORD, (id) => keep(gateRef(id, ctx))); // URLs are already set aside above
  t = evidence(emphasis(t));
  let guard = 0;
  while (/\u0001\d+\u0002/.test(t) && guard++ < 10) {
    t = t.replace(/\u0001(\d+)\u0002/g, (_, i) => slots[Number(i)]);
  }
  return t;
}

function indentOf(line) {
  return line.length - line.replace(/^ +/, '').length;
}

function startsBlock(lines, i) {
  const l = lines[i];
  return FENCE.test(l) || HEADING.test(l) || HR.test(l) || QUOTE.test(l) || LIST.test(l) || isTableStart(lines, i);
}

function isTableStart(lines, i) {
  const l = lines[i];
  const next = lines[i + 1];
  if (!l || next === undefined || !l.includes('|')) return false;
  return TABLE_SEP.test(next) && next.includes('-') && (next.includes('|') || splitRow(l).length > 1);
}

function splitRow(line) {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1);
  const cells = [];
  let cur = '';
  let inCode = false;
  for (let k = 0; k < s.length; k++) {
    const ch = s[k];
    if (ch === '\\' && s[k + 1] === '|') { cur += '|'; k++; continue; }
    if (ch === '`') inCode = !inCode;
    if (ch === '|' && !inCode) { cells.push(cur.trim()); cur = ''; continue; }
    cur += ch;
  }
  cells.push(cur.trim());
  return cells;
}

function heading(level, text, ctx) {
  const plain = headingPlain(unescapeHtml(text));
  const id = uniqueId(slugify(plain), ctx.ids);
  if (level === 1 && !ctx.title) ctx.title = plain;
  ctx.headings.push({ level, text: plain, id });
  return `<h${level} id="${id}">${inline(text, ctx)}</h${level}>`;
}

function blockquote(body, ctx) {
  const m = /^\s*\[!(NOTE|TIP|WARNING|SAFETY|CAUTION|IMPORTANT|DANGER)\]\s*(.*)$/i.exec(body[0] || '');
  if (m) {
    const kind = CALLOUT_KIND[m[1].toUpperCase()];
    const title = m[2].trim() ? inline(m[2].trim(), ctx) : CALLOUT_TITLE[kind];
    return `<aside class="callout callout-${kind}" role="note"><p class="callout-title">${title}</p>${blocks(body.slice(1), ctx)}</aside>`;
  }
  return `<blockquote>${blocks(body, ctx)}</blockquote>`;
}

function table(lines, i, ctx) {
  const head = splitRow(lines[i]);
  const aligns = splitRow(lines[i + 1]).map((c) => (/^:-+:$/.test(c) ? 'c' : /^-+:$/.test(c) ? 'r' : ''));
  i += 2;
  const rows = [];
  while (i < lines.length && lines[i].trim() && lines[i].includes('|')) {
    rows.push(splitRow(lines[i]));
    i++;
  }
  const al = (k) => (aligns[k] ? ` class="al-${aligns[k]}"` : '');
  const th = head.map((c, k) => `<th scope="col"${al(k)}>${inline(c, ctx)}</th>`).join('');
  const body = rows
    .map((r) => `<tr>${head.map((_, k) => `<td${al(k)}>${inline(r[k] ?? '', ctx)}</td>`).join('')}</tr>`)
    .join('');
  return { html: `<div class="table-wrap"><table class="md-table"><thead><tr>${th}</tr></thead><tbody>${body}</tbody></table></div>`, next: i };
}

function list(lines, i, ctx) {
  const first = LIST.exec(lines[i]);
  const base = first[1].length;
  const ordered = /\d/.test(first[2]);
  const start = ordered ? parseInt(first[2], 10) : 1;
  const items = [];
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      let j = i + 1;
      while (j < lines.length && !lines[j].trim()) j++;
      if (j >= lines.length) break;
      const mj = LIST.exec(lines[j]);
      if (mj && mj[1].length >= base && mj[1].length <= base + 1 && /\d/.test(mj[2]) === ordered) { i = j; continue; }
      if (indentOf(lines[j]) >= base + 2 && items.length) {
        items[items.length - 1].sub.push('');
        i = j;
        continue;
      }
      break;
    }
    const ind = indentOf(line);
    const m = LIST.exec(line);
    if (m && ind <= base + 1) {
      if (ind < base || /\d/.test(m[2]) !== ordered) break;
      items.push({ text: [m[3]], sub: [] });
      i++;
      continue;
    }
    if (!items.length || ind < base) break;
    if (ind >= base + 2) {
      items[items.length - 1].sub.push(line.slice(base + 2));
      i++;
      continue;
    }
    if (startsBlock(lines, i)) break;
    items[items.length - 1].text.push(line.trim()); // lazy continuation
    i++;
  }
  let hasTasks = false;
  const lis = items.map((it) => {
    const text = it.text.join(' ');
    const sub = it.sub.length ? blocks(it.sub, ctx) : '';
    const task = TASK.exec(text);
    if (task) {
      hasTasks = true;
      ctx.tasks.push(taskKey(`${ctx.file}|${unescapeHtml(task[2])}`));
      const done = task[1] !== ' ';
      return `<li class="task"><span class="task-label"><input type="checkbox" class="task-check" disabled aria-label="${done ? 'Done' : 'To do'}"${done ? ' checked' : ''}><span>${inline(task[2], ctx)}</span></span>${sub}</li>`;
    }
    return `<li>${inline(text, ctx)}${sub}</li>`;
  });
  const tag = ordered ? 'ol' : 'ul';
  const attrs = `${ordered && start !== 1 ? ` start="${start}"` : ''}${hasTasks ? ' class="tasks"' : ''}`;
  return { html: `<${tag}${attrs}>${lis.join('')}</${tag}>`, next: i };
}

function blocks(lines, ctx) {
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }
    let m = FENCE.exec(line);
    if (m) {
      const fence = m[1];
      const close = new RegExp(`^ {0,3}${fence[0] === '`' ? '`' : '~'}{${fence.length},}\\s*$`);
      const body = [];
      i++;
      while (i < lines.length && !close.test(lines[i])) { body.push(lines[i]); i++; }
      i++;
      out.push(`<pre class="md-pre"><code>${body.join('\n')}</code></pre>`);
      continue;
    }
    m = HEADING.exec(line);
    if (m) { out.push(heading(m[1].length, m[2], ctx)); i++; continue; }
    if (HR.test(line)) { out.push('<hr>'); i++; continue; }
    if (QUOTE.test(line)) {
      const body = [];
      while (i < lines.length && QUOTE.test(lines[i])) { body.push(QUOTE.exec(lines[i])[1]); i++; }
      out.push(blockquote(body, ctx));
      continue;
    }
    if (isTableStart(lines, i)) { const r = table(lines, i, ctx); out.push(r.html); i = r.next; continue; }
    if (LIST.test(line)) { const r = list(lines, i, ctx); out.push(r.html); i = r.next; continue; }
    const para = [];
    while (i < lines.length && lines[i].trim() && (para.length === 0 || !startsBlock(lines, i))) {
      const l = lines[i];
      const hard = / {2,}$/.test(l) || /\\$/.test(l);
      para.push(l.trim().replace(/\\$/, '') + (hard ? '\u0003' : ''));
      i++;
    }
    out.push(`<p>${inline(para.join('\n'), ctx).replace(/\u0003\n?/g, '<br>').replace(/\n/g, ' ')}</p>`);
  }
  return out.join('\n');
}

function clean(src) {
  return String(src ?? '')
    .replace(/^\uFEFF/, '')
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0003]/g, '')
    .replace(/\t/g, '    ');
}

/** Render Markdown to an HTML string that is safe to assign to innerHTML. */
export function renderMarkdown(src, { file = '', gateLabels = null } = {}) {
  const ctx = { file: /^[A-Za-z0-9][A-Za-z0-9._-]*\.md$/.test(file) ? file : '', ids: new Set(), headings: [], title: '', tasks: [], gateLabels: gateLabels && typeof gateLabels === 'object' ? gateLabels : null };
  const lines = escapeHtml(clean(src)).split('\n');
  const html = blocks(lines, ctx);
  return { html, headings: ctx.headings, title: ctx.title, tasks: ctx.tasks };
}

function stripInline(raw) {
  return raw
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\*\*|\*|`/g, '')
    .replace(/^\s*(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?/, '')
    .replace(/^\s*>\s?/, '')
    .replace(/\[!(?:NOTE|TIP|WARNING|SAFETY|CAUTION|IMPORTANT|DANGER)\]/i, '')
    .replace(/\|/g, ' ');
}

/** Plain-text sections for search: [{id, heading, level, text}], ids match renderMarkdown's. */
export function markdownSections(src) {
  const lines = clean(src).split('\n');
  const used = new Set();
  const sections = [{ id: '', heading: '', level: 0, text: [] }];
  let inFence = null;
  for (const line of lines) {
    const f = FENCE.exec(line);
    if (inFence) {
      if (f && f[1][0] === inFence[0] && f[1].length >= inFence.length && !f[2].trim()) inFence = null;
      else sections[sections.length - 1].text.push(line);
      continue;
    }
    if (f) { inFence = f[1]; continue; }
    const h = HEADING.exec(line);
    if (h) {
      const plain = headingPlain(h[2]);
      sections.push({ id: uniqueId(slugify(plain), used), heading: plain, level: h[1].length, text: [] });
      continue;
    }
    if (HR.test(line) || TABLE_SEP.test(line) && line.includes('-')) continue;
    const t = stripInline(line).trim();
    if (t) sections[sections.length - 1].text.push(t);
  }
  return sections.map((s) => ({ ...s, text: s.text.join(' ').replace(/\s+/g, ' ').trim() })).filter((s) => s.heading || s.text);
}

export function wordCount(src) {
  const m = clean(src).match(/[A-Za-z0-9’']+/g);
  return m ? m.length : 0;
}
