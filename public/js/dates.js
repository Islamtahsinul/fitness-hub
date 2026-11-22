// Local calendar dates as 'YYYY-MM-DD' strings. Arithmetic runs on UTC day numbers so
// daylight-saving changes (BST <-> GMT) never shift a date; "today" comes from the local clock.
// Weeks start on Monday everywhere in the hub.

const DAY_MS = 86400000;
export const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
export const WEEKDAYS_LONG = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
export const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export const MONTHS_LONG = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August',
  'September', 'October', 'November', 'December'];

const ISO_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const pad = (n) => String(n).padStart(2, '0');

export function isLeapYear(y) {
  return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
}

/** Days in month m (1-12) of year y. */
export function daysInMonth(y, m) {
  return [31, isLeapYear(y) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1] || 0;
}

export function isISODate(s) {
  if (typeof s !== 'string') return false;
  const m = ISO_RE.exec(s);
  if (!m) return false;
  const y = +m[1], mo = +m[2], d = +m[3];
  return y >= 1900 && y <= 2200 && mo >= 1 && mo <= 12 && d >= 1 && d <= daysInMonth(y, mo);
}

/** Day number (days since 1970-01-01). setUTCFullYear keeps years below 100 literal. */
export function toDayNum(iso) {
  const [y, m, d] = String(iso).split('-').map(Number);
  const dt = new Date(0);
  dt.setUTCFullYear(y, m - 1, d);
  return Math.round(dt.getTime() / DAY_MS);
}

export function fromDayNum(n) {
  const dt = new Date(n * DAY_MS);
  return `${String(dt.getUTCFullYear()).padStart(4, '0')}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}`;
}

/** Today's date on the local clock (so 00:30 BST on 29 March is already the 29th). */
export function todayISO(now = new Date()) {
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/** Local calendar date of a timestamp (ISO string, epoch ms or Date), or null. */
export function dateOfTimestamp(ts) {
  if (ts === null || ts === undefined || ts === '') return null;
  const dt = ts instanceof Date ? ts : new Date(ts);
  return Number.isFinite(dt.getTime()) ? todayISO(dt) : null;
}

export function addDays(iso, n) {
  return fromDayNum(toDayNum(iso) + n);
}

export function daysBetween(a, b) {
  return toDayNum(b) - toDayNum(a);
}

/** Monday = 0 ... Sunday = 6 */
export function weekdayIndex(iso) {
  const dow = new Date(toDayNum(iso) * DAY_MS).getUTCDay();
  return (dow + 6) % 7;
}

export function mondayOf(iso) {
  return addDays(iso, -weekdayIndex(iso));
}

export function mondayOnOrAfter(iso) {
  const w = weekdayIndex(iso);
  return w === 0 ? iso : addDays(iso, 7 - w);
}

export function dateRange(start, endInclusive) {
  const out = [];
  const a = toDayNum(start), b = toDayNum(endInclusive);
  for (let n = a; n <= b; n++) out.push(fromDayNum(n));
  return out;
}

export function weekDates(monday) {
  return dateRange(monday, addDays(monday, 6));
}

export function minISO(...xs) {
  const v = xs.flat().filter(isISODate);
  return v.length ? v.reduce((a, b) => (b < a ? b : a)) : null;
}

export function maxISO(...xs) {
  const v = xs.flat().filter(isISODate);
  return v.length ? v.reduce((a, b) => (b > a ? b : a)) : null;
}

function parts(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return { y, m, d, wd: weekdayIndex(iso) };
}

/** "Fri 31 Jan" (adds the year when it differs from this year, or when asked). */
export function fmtDay(iso, { year = 'auto', today = todayISO() } = {}) {
  if (!isISODate(iso)) return '';
  const p = parts(iso);
  const showYear = year === true || (year === 'auto' && String(p.y) !== today.slice(0, 4));
  return `${WEEKDAYS[p.wd]} ${p.d} ${MONTHS[p.m - 1]}${showYear ? ' ' + p.y : ''}`;
}

/** "Friday 31 January" */
export function fmtDayLong(iso, { year = false } = {}) {
  if (!isISODate(iso)) return '';
  const p = parts(iso);
  return `${WEEKDAYS_LONG[p.wd]} ${p.d} ${MONTHS_LONG[p.m - 1]}${year ? ' ' + p.y : ''}`;
}

/** "31 Jan" */
export function fmtShort(iso) {
  if (!isISODate(iso)) return '';
  const p = parts(iso);
  return `${p.d} ${MONTHS[p.m - 1]}`;
}

/** "31 Jan – 14 Mar" (en dash range) */
export function fmtRange(a, b) {
  if (!isISODate(a)) return '';
  if (!isISODate(b)) return fmtShort(a);
  const sameYear = a.slice(0, 4) === b.slice(0, 4);
  const ys = sameYear ? '' : ` ${a.slice(0, 4)}`;
  return `${fmtShort(a)}${ys} – ${fmtShort(b)}${sameYear ? '' : ' ' + b.slice(0, 4)}`;
}

/** "in 3 days", "tomorrow", "today", "yesterday", "5 days ago" */
export function relDays(iso, today = todayISO()) {
  if (!isISODate(iso)) return '';
  const n = daysBetween(today, iso);
  if (n === 0) return 'today';
  if (n === 1) return 'tomorrow';
  if (n === -1) return 'yesterday';
  if (n > 1) return `in ${n} days`;
  return `${-n} days ago`;
}

export function monthIndex(iso) {
  return Number(iso.slice(5, 7)) - 1;
}

/** Whole weeks from the Monday of a to the Monday of b (negative if b is earlier). */
export function weeksBetween(a, b) {
  return Math.floor(daysBetween(mondayOf(a), mondayOf(b)) / 7);
}
