// UK date parsing and formatting (pure, no DOM). Dates are stored as ISO 'YYYY-MM-DD';
// people type them day first. Native date pickers on this machine show month first, which
// makes 01/12 vs 12/01 easy to get wrong, and clearance dates unlock exercises.

import { isISODate, todayISO, addDays, MONTHS } from '../dates.js';

const pad = (n) => String(n).padStart(2, '0');

const MONTH_WORDS = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4, may: 5, jun: 6, june: 6,
  jul: 7, july: 7, aug: 8, august: 8, sep: 9, sept: 9, september: 9, oct: 10, october: 10,
  nov: 11, november: 11, dec: 12, december: 12,
};

function build(y, m, d) {
  const iso = `${String(y).padStart(4, '0')}-${pad(m)}-${pad(d)}`;
  return isISODate(iso) ? iso : null;
}

function fullYear(y, today) {
  if (y === undefined || y === null || y === '') return Number(today.slice(0, 4));
  return String(y).length <= 2 ? 2000 + Number(y) : Number(y);
}

const NUMERIC = /^(\d{1,2})[/.\- ]+(\d{1,2})(?:[/.\- ]+(\d{2}|\d{4}))?$/;

/**
 * Parses what a UK user types into 'YYYY-MM-DD', or null if it isn't a real date.
 * Accepts 31/01/2025, 31-01-25, 31.01.2025, 31 01 2025, 31012025, 31 Jan 2025, Fri 31 January,
 * 2025-01-31, and the words today, yesterday and tomorrow. A missing year means this year.
 */
export function parseUKDate(text, { today = todayISO() } = {}) {
  if (typeof text !== 'string') return null;
  let t = text.trim().toLowerCase().replace(/\s+/g, ' ');
  if (!t) return null;
  if (t === 'today' || t === 'tod' || t === 'now') return today;
  if (t === 'yesterday' || t === 'yday') return addDays(today, -1);
  if (t === 'tomorrow' || t === 'tmrw' || t === 'tom') return addDays(today, 1);
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(t);
  if (m) return build(+m[1], +m[2], +m[3]);
  t = t.replace(/^(mon|tue|tues|wed|thu|thur|thurs|fri|sat|sun)[a-z]*\.?,? /, '');
  m = NUMERIC.exec(t);
  if (m) return build(fullYear(m[3], today), +m[2], +m[1]);
  m = /^(\d{2})(\d{2})(\d{4}|\d{2})$/.exec(t);
  if (m) return build(fullYear(m[3], today), +m[2], +m[1]);
  m = /^(\d{1,2})(?:st|nd|rd|th)? ?([a-z]+)\.?,?(?: (\d{4}|\d{2}))?$/.exec(t);
  if (m && MONTH_WORDS[m[2]]) return build(fullYear(m[3], today), MONTH_WORDS[m[2]], +m[1]);
  return null;
}

/** 'YYYY-MM-DD' -> 'DD/MM/YYYY' ('2025-01-31' -> '31/01/2025'); anything else -> ''. */
export function formatUKDate(iso) {
  if (!isISODate(iso)) return '';
  return `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`;
}

/** True once the text names a whole date unambiguously enough to act on while typing. */
export function isCompleteDateText(text) {
  const t = String(text || '').trim();
  return /\d{4}/.test(t) && (/^\d{4}-\d{1,2}-\d{1,2}$/.test(t) || /\d{4}$/.test(t));
}

const spoken = (iso) => `${Number(iso.slice(8, 10))} ${MONTHS[Number(iso.slice(5, 7)) - 1]} ${iso.slice(0, 4)}`;

/**
 * Checks typed text against optional bounds. Returns {iso, error}: iso is set only when the
 * text is a valid date inside [min, max]; error is a plain-English message or ''.
 * `partial` (while typing) holds back the error for text that may still become a date.
 * `minError` / `maxError` replace the default out-of-range messages ("before your injury").
 */
export function checkUKDate(text, { min = null, max = null, today = todayISO(), required = false, partial = false, minError = null, maxError = null } = {}) {
  const raw = typeof text === 'string' ? text.trim() : '';
  if (!raw) return { iso: null, error: required && !partial ? `Enter a date, for example ${formatUKDate(today) || '31/01/2025'}.` : '' };
  const iso = parseUKDate(raw, { today });
  if (!iso) {
    const n = /^(\d{1,2})[/.\- ]+(\d{1,2})[/.\- ]+(\d{4})$/.exec(raw);
    if (n) {
      const d = Number(n[1]);
      const mo = Number(n[2]);
      if (mo > 12 && d >= 1 && d <= 12 && build(Number(n[3]), d, mo)) {
        return { iso: null, error: `Day first, then month. Did you mean ${pad(mo)}/${pad(d)}/${n[3]}?` };
      }
      return { iso: null, error: 'That date doesn’t exist. Check the day and the month.' };
    }
    if (partial && /^[\d/.\- ]*$/.test(raw) && raw.replace(/\D/g, '').length < 8) return { iso: null, error: '' };
    if (partial && /^[a-z]/i.test(raw)) return { iso: null, error: '' };
    return { iso: null, error: `Use day/month/year, for example ${formatUKDate(today) || '31/01/2025'}.` };
  }
  if (isISODate(min) && iso < min) return { iso: null, error: minError || `Pick ${spoken(min)} or later.` };
  if (isISODate(max) && iso > max) return { iso: null, error: maxError || (max === today ? 'That date is in the future.' : `Pick ${spoken(max)} or earlier.`) };
  return { iso, error: '' };
}

/** The six-week (42-day) Monday-first grid that contains a month: [{iso, inMonth}]. */
export function monthGrid(year, month) {
  const first = `${year}-${pad(month)}-01`;
  const dow = (new Date(Date.UTC(year, month - 1, 1)).getUTCDay() + 6) % 7;
  const start = addDays(first, -dow);
  return Array.from({ length: 42 }, (_, i) => {
    const iso = addDays(start, i);
    return { iso, inMonth: Number(iso.slice(5, 7)) === month };
  });
}
