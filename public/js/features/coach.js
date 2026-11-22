// Coach notes: renders the rules-based insights (features/insights.js) as a short list of
// waymarks. Tone is carried by the icon shape and a hidden label, never by colour alone.

import { h } from '../dom.js';
import { statusIcon } from '../components.js';
import { content } from '../content.js';
import { coachInsights } from './insights.js';
import { waymark } from './icons.js';

const TONE_WORD = { alert: 'Important', warn: 'Heads-up', info: 'Note', good: 'Good news' };

function toneIcon(tone) {
  if (tone === 'good') return statusIcon('green', 22);
  if (tone === 'warn') return statusIcon('amber', 22);
  if (tone === 'alert') return statusIcon('red', 22);
  return waymark(22);
}

/** Insights for a day from the loaded content (wraps the pure coachInsights). */
export function insightsFor(ctx, { asOf = ctx.today, readiness = 'unknown', exclude = [] } = {}) {
  return coachInsights({
    data: ctx.data, program: content.program, exercises: content.exercises, tests: content.tests,
    questions: content.arm?.clinic_questions || [], today: ctx.today, asOf, readiness, exclude,
  });
}

export function coachNote(ins) {
  return h('li', { class: ['coach-note', `tone-${ins.tone}`] },
    h('span', { class: 'coach-icon' }, toneIcon(ins.tone)),
    h('div', { class: 'coach-text' },
      h('p', { class: 'coach-title' }, h('span', { class: 'visually-hidden' }, `${TONE_WORD[ins.tone] || 'Note'}: `), ins.title),
      ins.body ? h('p', { class: 'coach-body' }, ins.body) : null,
      ins.action ? h('a', { class: 'coach-action', href: ins.action.href }, ins.action.label) : null));
}

/**
 * The "Coach notes" panel. `limit` caps how many show; the rest sit behind a disclosure.
 * `emptyText` is shown when there's nothing to flag (or null to hide the panel).
 */
export function coachPanel(list, { title = 'Coach notes', limit = 3, emptyText = 'Nothing to flag. Keep doing what you’re doing.', headingLevel = 2, cls = null } = {}) {
  if (!list.length && emptyText === null) return null;
  const shown = list.slice(0, limit);
  const more = list.slice(limit);
  return h('section', { class: ['coach', cls], 'aria-label': title },
    h(`h${headingLevel}`, { class: 'mini-title coach-head' }, title),
    list.length
      ? h('ul', { class: 'coach-list' }, shown.map(coachNote))
      : h('p', { class: 'coach-empty' }, emptyText),
    more.length ? h('details', { class: 'disclose coach-more' },
      h('summary', null, `${more.length} more note${more.length === 1 ? '' : 's'}`),
      h('ul', { class: 'coach-list' }, more.map(coachNote))) : null);
}
