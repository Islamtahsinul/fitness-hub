// #/guide and #/guide/<file>[/<section>]: the training guide reader.
// The only innerHTML in the app is here, and it only ever receives output from
// renderMarkdown(), which HTML-escapes the entire source before adding its own tags.

import { h, debounce } from '../dom.js';
import { pageHead, emptyState, missingContent, textField, gates } from '../components.js';
import { content, loadChapter, guideChapters, isChapterFile } from '../content.js';
import { renderMarkdown, markdownSections } from '../markdown.js';
import { chapterMeta } from '../features/guidemeta.js';

export const title = 'The guide';

let query = '';

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Text with <mark> around matches, built from text nodes only. */
function highlighted(text, terms) {
  if (!terms.length) return [text];
  const re = new RegExp(`(${terms.map(escapeRe).join('|')})`, 'gi');
  return text.split(re).map((part, i) => (i % 2 ? h('mark', null, part) : part));
}

async function runSearch(q) {
  const terms = q.toLowerCase().split(/\s+/).filter((t) => t.length > 1);
  if (!terms.length) return { terms, results: [] };
  const chapters = guideChapters();
  const texts = await Promise.all(chapters.map((c) => loadChapter(c.file)));
  const out = [];
  chapters.forEach((c, i) => {
    const src = texts[i];
    if (!src) return;
    for (const sec of markdownSections(src)) {
      const hay = `${sec.heading} ${sec.text}`.toLowerCase();
      if (!terms.every((t) => hay.includes(t))) continue;
      const lower = sec.text.toLowerCase();
      const hits = terms.map((t) => lower.indexOf(t)).filter((k) => k >= 0);
      const at = Math.max(0, (hits.length ? Math.min(...hits) : 0) - 80);
      let snippet = sec.text.slice(at, at + 220);
      if (at > 0) snippet = `…${snippet}`;
      if (at + 220 < sec.text.length) snippet = `${snippet}…`;
      out.push({ chapter: c, section: sec, snippet, score: terms.reduce((n, t) => n + (sec.heading.toLowerCase().includes(t) ? 3 : 0), 0) });
    }
  });
  out.sort((a, b) => b.score - a.score);
  return { terms, results: out.slice(0, 40) };
}

function searchBox(ctx, resultsHost, { autofocus = false } = {}) {
  const draw = async () => {
    const q = query.trim();
    if (!q) { resultsHost.replaceChildren(); return; }
    resultsHost.replaceChildren(h('p', { class: 'small muted', role: 'status' }, 'Searching the guide…'));
    const r = await runSearch(q);
    const results = r.results || [];
    resultsHost.replaceChildren(
      h('p', { class: 'small muted', 'aria-live': 'polite' }, results.length ? `${results.length} match${results.length === 1 ? '' : 'es'}` : 'No matches. Try fewer or different words.'),
      results.length ? h('ul', { class: 'search-results' }, results.map((x) => h('li', null,
        h('a', { href: `#/guide/${x.chapter.file}${x.section.id ? `/${x.section.id}` : ''}` }, x.chapter.title),
        x.section.heading ? h('span', { class: 'sr-section' }, `: ${x.section.heading}`) : null,
        h('p', { class: 'sr-snippet' }, highlighted(x.snippet, r.terms))))) : null);
  };
  const redraw = debounce(draw, 220);
  const field = textField({ label: 'Search the guide', value: query, type: 'search', placeholder: 'e.g. Zone 2, protein, farmer carry', cls: 'search-box', onInput: (v) => { query = v; redraw(); } });
  if (autofocus) requestAnimationFrame(() => field.querySelector('input')?.focus());
  if (query.trim()) draw();
  return field;
}

function tocPage(ctx) {
  const idx = content.guideIndex;
  const page = h('div', { class: 'page' });
  page.append(pageHead({ title: idx?.title || 'The guide', lede: 'Everything behind the programme: why each piece is there, how to do it well, and how to keep your arm safe while you build. Chapters appear here as they are written.' }));
  if (!idx) { page.append(missingContent('The guide’s table of contents')); return page; }
  const results = h('div');
  page.append(searchBox(ctx, results), results);
  const parts = h('div', { class: 'guide-parts' });
  const draw = (meta) => {
    parts.replaceChildren(...idx.parts.map((p) => h('section', { class: 'sheet' },
      h('h2', { class: 'part-title' }, p.title),
      h('ol', { class: 'chapter-list' }, p.chapters.map((c) => {
        const m = meta?.get(c.file);
        if (m && m.exists === false) return h('li', null, h('span', { class: 'chapter-soon' }, h('span', null, c.title), h('span', { class: 'chapter-meta' }, 'Coming soon')));
        return h('li', null, h('a', { class: 'chapter-link', href: `#/guide/${c.file}` }, h('span', null, c.title), h('span', { class: 'chapter-meta' }, m?.minutes ? `${m.minutes} min read` : '')));
      })))));
  };
  draw(null);
  page.append(parts);
  // Sizes only (HEAD requests): no chapter is downloaded until you open it or search.
  chapterMeta(guideChapters().map((c) => c.file), content.base).then((meta) => { if (parts.isConnected) draw(meta); });
  return page;
}

function chapterPage(ctx, file, anchor) {
  const page = h('div', { class: 'page' });
  const chapters = guideChapters();
  const i = chapters.findIndex((c) => c.file === file);
  const entry = chapters[i] || { file, title: file, part: '' };
  page.append(h('nav', { class: 'crumbs', 'aria-label': 'Breadcrumb' }, h('a', { href: '#/guide' }, 'The guide'), entry.part ? h('span', null, `/ ${entry.part}`) : null));
  const layout = h('div', { class: 'guide-layout' });
  const article = h('article', { class: 'prose', 'aria-live': 'off' }, h('p', { class: 'muted' }, 'Loading the chapter…'));
  const aside = h('aside', { class: 'guide-aside', 'aria-label': 'On this page' });
  layout.append(article, aside);
  page.append(layout);
  const pager = h('nav', { class: 'pager', 'aria-label': 'Chapters' },
    i > 0 ? h('a', { href: `#/guide/${chapters[i - 1].file}` }, h('span', { class: 'pager-dir' }, 'Previous'), chapters[i - 1].title) : h('span'),
    i >= 0 && i < chapters.length - 1 ? h('a', { class: 'pager-next', href: `#/guide/${chapters[i + 1].file}` }, h('span', { class: 'pager-dir' }, 'Next'), chapters[i + 1].title) : h('span'));
  page.append(pager);

  loadChapter(file).then((src) => {
    if (!article.isConnected && !page.isConnected) return;
    if (!src) {
      article.replaceChildren(h('h1', { tabindex: '-1', id: 'page-title' }, entry.title), emptyState({ title: 'This chapter is coming soon.', body: 'It is still being written. Refresh later, or read another chapter.' }));
      return;
    }
    // Raw gate ids in a chapter show as the programme's gate labels ("Now" for none).
    const gateLabels = Object.fromEntries(gates().filter((g) => g.id !== 'none').map((g) => [g.id, g.label]));
    const out = renderMarkdown(src, { file, gateLabels });
    article.innerHTML = out.html; // safe: renderMarkdown escapes all source text first
    for (const el of article.querySelectorAll('h1, h2, h3, h4, h5, h6')) el.id = `sec-${el.id}`;
    const h1 = article.querySelector('h1');
    if (h1) { h1.setAttribute('tabindex', '-1'); h1.dataset.pageTitle = '1'; } else article.prepend(h('h1', { tabindex: '-1' }, entry.title));
    document.title = `${out.title || entry.title} — Fitness Hub`;
    const heads = out.headings.filter((x) => x.level === 2 || x.level === 3);
    const results = h('div');
    aside.replaceChildren(
      h('div', { class: 'row', style: { 'margin-bottom': '12px' } },
        h('button', { type: 'button', class: 'btn btn-sm', onClick: () => window.print() }, 'Print this chapter')),
      heads.length ? h('div', null, h('p', { class: 'mini-title' }, 'On this page'),
        h('ul', { class: 'toc' }, heads.map((x) => h('li', { class: `lvl-${x.level}` }, h('a', {
          href: `#/guide/${file}/${x.id}`,
          onClick: (e) => {
            const target = document.getElementById(`sec-${x.id}`);
            if (!target) return;
            e.preventDefault();
            history.replaceState(null, '', `${location.pathname}${location.search}#/guide/${file}/${x.id}`);
            target.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' });
            target.setAttribute('tabindex', '-1');
            target.focus({ preventScroll: true });
          },
        }, x.text))))) : null,
      h('div', { style: { 'margin-top': '18px' } }, searchBox(ctx, results), results));
    if (anchor) {
      requestAnimationFrame(() => {
        const target = document.getElementById(`sec-${anchor}`);
        if (target) target.scrollIntoView({ block: 'start' });
      });
    }
  });
  return page;
}

export function render(ctx) {
  const file = ctx.params[0];
  if (file && isChapterFile(file)) return chapterPage(ctx, file, ctx.params[1] || '');
  return tocPage(ctx);
}
