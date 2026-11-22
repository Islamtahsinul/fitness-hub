// DOM helpers. Text always goes in as text nodes; nothing here touches innerHTML.
// No imports: every other UI module builds on this one (the date prompt lives in features/datefield.js).

const SVG_NS = 'http://www.w3.org/2000/svg';

// Native append()/prepend()/replaceChildren() turn null into the visible text "null" and
// arrays into "[object …]". Views build children with conditionals, so make these calls
// skip empty values and flatten arrays. Strings still become text nodes (never HTML).
if (typeof Element !== 'undefined') {
  for (const proto of [Element.prototype, DocumentFragment.prototype]) {
    for (const name of ['append', 'prepend', 'replaceChildren']) {
      const orig = proto[name];
      if (typeof orig !== 'function' || orig.fhSafe) continue;
      const safe = function safeInsert(...nodes) {
        return orig.apply(this, nodes.flat(Infinity).filter((n) => n !== null && n !== undefined && n !== false && n !== true));
      };
      safe.fhSafe = true;
      Object.defineProperty(proto, name, { value: safe, writable: true, configurable: true });
    }
  }
}

function appendKids(el, kids) {
  for (const c of kids.flat(Infinity)) {
    if (c === null || c === undefined || c === false || c === true) continue;
    el.appendChild(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}

function applyProps(el, props, isSvg) {
  if (!props) return;
  for (const [k, v] of Object.entries(props)) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class' || k === 'className') {
      // Nested arrays are flattened, and only real class names are kept (BT2-10: never "a,false").
      const cls = Array.isArray(v) ? v.flat(Infinity).filter((c) => typeof c === 'string' && c).join(' ') : String(v);
      if (cls) el.setAttribute('class', cls);
    } else if (k === 'style' && typeof v === 'object') {
      for (const [sk, sv] of Object.entries(v)) if (sv !== null && sv !== undefined) el.style.setProperty(sk, String(sv));
    } else if (k === 'dataset') {
      for (const [dk, dv] of Object.entries(v)) if (dv !== null && dv !== undefined) el.dataset[dk] = String(dv);
    } else if (k.startsWith('on') && typeof v === 'function') {
      el.addEventListener(k.slice(2).toLowerCase(), v);
    } else if (!isSvg && (k === 'value' || k === 'checked' || k === 'selected' || k === 'indeterminate' || k === 'disabled' || k === 'open')) {
      el[k] = v;
      if ((k === 'disabled' || k === 'open') && v) el.setAttribute(k, '');
    } else if (k === 'href' || k === 'src' || k === 'action') {
      el.setAttribute(k, safeUrl(String(v)));
    } else if (v === true) {
      el.setAttribute(k, '');
    } else {
      el.setAttribute(k, String(v));
    }
  }
}

/** Internal routes, same-origin paths, blob: downloads and http(s) only; anything else becomes '#'. */
export function safeUrl(u) {
  if (/^#\//.test(u) || /^#[A-Za-z0-9_-]*$/.test(u)) return u;
  if (/^\/(?!\/)/.test(u)) return u;
  if (/^https?:\/\//i.test(u)) return u;
  if (/^blob:/i.test(u)) return u;
  return '#';
}

export function isHttpUrl(u) {
  return typeof u === 'string' && /^https?:\/\/[^\s<>"']+$/i.test(u.trim());
}

export function h(tag, props = null, ...kids) {
  const el = document.createElement(tag);
  applyProps(el, props, false);
  appendKids(el, kids);
  return el;
}

export function s(tag, props = null, ...kids) {
  const el = document.createElementNS(SVG_NS, tag);
  applyProps(el, props, true);
  appendKids(el, kids);
  return el;
}

export function clear(el) {
  while (el.firstChild) el.removeChild(el.firstChild);
  return el;
}

export function replaceKids(el, ...kids) {
  clear(el);
  appendKids(el, kids);
  return el;
}

/** External link: http(s) only, new tab, no opener or referrer. Returns plain text otherwise. */
export function extLink(url, text, props = {}) {
  if (!isHttpUrl(url)) return document.createTextNode(text || '');
  return h('a', { ...props, href: url.trim(), target: '_blank', rel: 'noopener noreferrer', class: ['ext', props.class] }, text || url);
}

let uidCounter = 0;
export function uid(prefix = 'id') {
  if (prefix === 'uuid') {
    if (globalThis.crypto?.randomUUID) return crypto.randomUUID();
    const b = crypto.getRandomValues(new Uint8Array(16));
    b[6] = (b[6] & 0x0f) | 0x40; b[8] = (b[8] & 0x3f) | 0x80;
    const hex = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }
  uidCounter += 1;
  return `${prefix}-${uidCounter}`;
}

// ------------------------------------------------------------ number fields: typing replaces a prefilled value

const quietFocus = typeof WeakSet === 'function' ? new WeakSet() : null;
const SELECT_WINDOW_MS = 450;

/**
 * Focus a field without selecting its text (used when focus is put back after a re-render, so a
 * half-typed value is never selected and overwritten by the next key).
 */
export function focusQuietly(el, opts = { preventScroll: true }) {
  if (!el || typeof el.focus !== 'function') return;
  if (quietFocus) quietFocus.add(el);
  try { el.focus(opts); } finally { if (quietFocus) quietFocus.delete(el); }
}

function selectAllOf(input) {
  const len = String(input.value ?? '').length;
  try {
    if (input.type !== 'number' && typeof input.setSelectionRange === 'function') { input.setSelectionRange(0, len); return; }
  } catch { /* fall through */ }
  try { if (typeof input.select === 'function') input.select(); } catch { /* not selectable */ }
}

/**
 * Round 4 (finding 4): selects a field's whole value when it gets focus by tap, click or Tab, so
 * typing replaces a prefilled number instead of adding to it ("12", type 11 -> 11, never "1112").
 * Touch browsers move the caret to the tap point after focus, so the selection is made again just
 * after the tap; the mouseup that follows the focusing tap keeps it. A second tap on a field that
 * already has focus places the caret as usual, and a key pressed in between is never overwritten.
 * Returns the input.
 */
export function selectOnFocus(input, { now = () => Date.now(), later = null } = {}) {
  if (!input || typeof input.addEventListener !== 'function') return input;
  let since = 0; // when focus arrived (0 = the select-all window is closed)
  const open = () => since > 0 && now() - since <= SELECT_WINDOW_MS;
  const again = () => { if (open() && isFocused(input)) selectAllOf(input); };
  const defer = later || ((fn) => {
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => fn());
    setTimeout(fn, 0);
    setTimeout(fn, 60);
  });
  input.addEventListener('focus', () => {
    if (quietFocus && quietFocus.has(input)) { since = 0; return; }
    since = now();
    selectAllOf(input);
    defer(again);
  });
  input.addEventListener('mouseup', (e) => { if (open() && e && typeof e.preventDefault === 'function') e.preventDefault(); });
  const close = () => { since = 0; };
  input.addEventListener('keydown', close);
  input.addEventListener('input', close);
  input.addEventListener('blur', close);
  return input;
}

function isFocused(el) {
  if (typeof document === 'undefined') return true;
  return document.activeElement === el;
}

export function debounce(fn, ms) {
  let t = null;
  const d = (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
  d.cancel = () => clearTimeout(t);
  return d;
}

export function download(filename, text, type = 'application/json') {
  const blob = new Blob([text], { type });
  const url = URL.createObjectURL(blob);
  const a = h('a', { href: url, download: filename, style: { display: 'none' } });
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 1000);
}

// ------------------------------------------------------------ numbers

const nfCache = new Map();
export function fmtNum(v, dp = 0) {
  if (v === null || v === undefined || v === '' || !Number.isFinite(Number(v))) return '–';
  const key = dp;
  if (!nfCache.has(key)) nfCache.set(key, new Intl.NumberFormat('en-GB', { maximumFractionDigits: dp, minimumFractionDigits: 0 }));
  return nfCache.get(key).format(Number(v));
}

export function fmtFixed(v, dp = 1) {
  if (v === null || v === undefined || v === '' || !Number.isFinite(Number(v))) return '–';
  return new Intl.NumberFormat('en-GB', { maximumFractionDigits: dp, minimumFractionDigits: dp }).format(Number(v));
}

export function fmtSigned(v, dp = 1, unit = '') {
  if (!Number.isFinite(Number(v))) return '–';
  const n = Number(v);
  const sign = n > 0 ? '+' : n < 0 ? '−' : '±';
  return `${sign}${fmtFixed(Math.abs(n), dp)}${unit}`;
}

export function fmtDuration(totalSeconds) {
  const sec = Math.max(0, Math.round(totalSeconds));
  const hrs = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s2 = sec % 60;
  return hrs ? `${hrs}:${String(m).padStart(2, '0')}:${String(s2).padStart(2, '0')}` : `${m}:${String(s2).padStart(2, '0')}`;
}

/** 65 -> "65 min", 150 -> "2 h 30 min", 360 -> "6 h" */
export function fmtMinutes(min) {
  const m = Math.round(Number(min));
  if (!Number.isFinite(m)) return '';
  if (m < 120) return `${m} min`;
  const hrs = Math.floor(m / 60);
  const rest = m % 60;
  return rest ? `${hrs} h ${rest} min` : `${hrs} h`;
}

export function plural(n, one, many = `${one}s`) {
  return `${fmtNum(n)} ${Number(n) === 1 ? one : many}`;
}

// ------------------------------------------------------------ toasts

let toastRoot = null;
const MAX_TOASTS = 3;
const keyedToasts = new Map(); // key -> close(), so one action never stacks two toasts

/**
 * A short message at the bottom of the screen. With `action` ({label, run}) it becomes an undo
 * toast: it stays 10 seconds, and the timer pauses while the pointer or keyboard focus is on it.
 * With `key`, a new toast replaces the one already showing under that key (one toast only).
 */
export function toast(message, { tone = 'info', action = null, timeout = action ? 10000 : 4000, key = null } = {}) {
  if (!toastRoot || !toastRoot.isConnected) {
    toastRoot = h('div', { class: 'toasts', role: 'status', 'aria-live': 'polite' });
    document.body.appendChild(toastRoot);
  }
  if (key && keyedToasts.has(key)) { try { keyedToasts.get(key)(true); } catch { /* gone */ } }
  let timer = null;
  let remaining = timeout;
  let started = 0;
  let gone = false;
  const close = (now = false) => {
    if (gone) return;
    gone = true;
    clearTimeout(timer);
    if (key && keyedToasts.get(key) === close) keyedToasts.delete(key);
    if (now === true) { el.remove(); return; }
    el.classList.add('leaving');
    setTimeout(() => el.remove(), 200);
  };
  const arm = () => { if (!timeout || gone) return; clearTimeout(timer); started = Date.now(); timer = setTimeout(close, Math.max(1200, remaining)); };
  const pause = () => { if (!timeout) return; clearTimeout(timer); remaining -= Date.now() - started; };
  const el = h('div', { class: ['toast', `toast-${tone}`, action && 'toast-action'] },
    h('span', { class: 'toast-msg' }, message),
    action ? h('button', { type: 'button', class: 'btn btn-sm toast-btn', onClick: () => { close(); action.run(); } }, action.label) : null,
    h('button', { type: 'button', class: 'toast-x', 'aria-label': 'Dismiss', onClick: close }, '×'));
  el.addEventListener('pointerenter', pause);
  el.addEventListener('pointerleave', arm);
  el.addEventListener('focusin', pause);
  el.addEventListener('focusout', arm);
  while (toastRoot.children.length >= MAX_TOASTS) toastRoot.firstElementChild.remove();
  toastRoot.appendChild(el);
  if (key) keyedToasts.set(key, close);
  arm();
  return close;
}

/** "Removed X" with an Undo button that runs `undo()`. It stays until it's dismissed or used. */
export function undoToast(message, undo, { label = 'Undo' } = {}) {
  return toast(message, { action: { label, run: undo }, timeout: 0 });
}

// ------------------------------------------------------------ dialogs

/** Modal confirm built on <dialog>. Resolves true/false. `body` may be a string or nodes. */
export function confirmDialog({ title, body = '', confirmText = 'Confirm', cancelText = 'Cancel', danger = false, extra = null }) {
  return new Promise((resolve) => {
    const dlg = h('dialog', { class: 'modal', 'aria-labelledby': 'dlg-title' });
    const prev = document.activeElement;
    const done = (v) => { dlg.close(); dlg.remove(); if (prev && prev.isConnected && prev.focus) prev.focus({ preventScroll: true }); resolve(v); };
    dlg.append(
      h('form', { method: 'dialog', class: 'modal-body', onSubmit: (e) => { e.preventDefault(); done(true); } },
        h('h2', { id: 'dlg-title', class: 'modal-title' }, title),
        typeof body === 'string' ? h('p', { class: 'modal-text' }, body) : body,
        extra,
        h('div', { class: 'modal-actions' },
          h('button', { type: 'button', class: 'btn', onClick: () => done(false) }, cancelText),
          h('button', { type: 'submit', class: ['btn', danger ? 'btn-danger' : 'btn-primary'] }, confirmText))));
    dlg.addEventListener('cancel', (e) => { e.preventDefault(); done(false); });
    document.body.appendChild(dlg);
    dlg.showModal();
  });
}

/** A message with a single Close button (no choice to make). Resolves when it closes. */
export function alertDialog({ title, body = '', closeText = 'Close' }) {
  return new Promise((resolve) => {
    const dlg = h('dialog', { class: 'modal', 'aria-labelledby': 'dlg-title', role: 'alertdialog' });
    const prev = document.activeElement;
    const done = () => { dlg.close(); dlg.remove(); if (prev && prev.isConnected && prev.focus) prev.focus({ preventScroll: true }); resolve(); };
    const closeBtn = h('button', { type: 'button', class: 'btn btn-primary', onClick: done }, closeText);
    dlg.append(h('div', { class: 'modal-body' },
      h('h2', { id: 'dlg-title', class: 'modal-title' }, title),
      typeof body === 'string' ? h('p', { class: 'modal-text' }, body) : body,
      h('div', { class: 'modal-actions' }, closeBtn)));
    dlg.addEventListener('cancel', (e) => { e.preventDefault(); done(); });
    document.body.appendChild(dlg);
    dlg.showModal();
    closeBtn.focus();
  });
}

/** Side drawer (a modal <dialog>): focus is trapped, Esc and the backdrop close it. */
export function openDrawer({ title, content, label = title }) {
  const dlg = h('dialog', { class: 'drawer', 'aria-label': label });
  const prev = document.activeElement;
  const close = () => { dlg.close(); };
  dlg.addEventListener('close', () => { dlg.remove(); if (prev && prev.isConnected && prev.focus) prev.focus({ preventScroll: true }); });
  dlg.addEventListener('click', (e) => { if (e.target === dlg) close(); });
  dlg.append(
    h('div', { class: 'drawer-inner' },
      h('div', { class: 'drawer-head' },
        h('h2', { class: 'drawer-title' }, title),
        h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Close', onClick: close }, '×')),
      h('div', { class: 'drawer-body' }, content)));
  document.body.appendChild(dlg);
  dlg.showModal();
  return close;
}
