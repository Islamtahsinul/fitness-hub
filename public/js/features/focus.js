// Keeps keyboard focus on "the same" control when a page re-renders (A11Y3).
// A control is identified by a stable key: its data-fkey when the view sets one, otherwise
// its role, accessible name and surrounding group, plus which occurrence it is.

import { focusQuietly } from '../dom.js';

const FOCUSABLE = 'a[href], button, input, select, textarea, summary, [tabindex]:not([tabindex="-1"])';

const clean = (t) => String(t || '').replace(/\s+/g, ' ').trim().slice(0, 80);

function nameOf(el) {
  const aria = el.getAttribute('aria-label');
  if (aria) return clean(aria);
  const by = el.getAttribute('aria-labelledby');
  if (by) return clean(by.split(/\s+/).map((id) => document.getElementById(id)?.textContent || '').join(' '));
  if (el.labels && el.labels.length) return clean(el.labels[0].textContent);
  if (el.tagName === 'INPUT' && el.type === 'radio') return clean(el.value);
  return clean(el.textContent);
}

function scopeOf(el) {
  const scope = el.closest('[data-fscope]');
  if (scope) return scope.dataset.fscope;
  const fs = el.closest('fieldset');
  const legend = fs ? fs.querySelector('legend') : null;
  if (legend) return clean(legend.textContent);
  const sec = el.closest('section, [role="region"], .block, .sheet');
  const head = sec ? sec.querySelector('h1, h2, h3') : null;
  return head ? clean(head.textContent) : '';
}

function signature(el) {
  if (el.dataset && el.dataset.fkey) return `k:${el.dataset.fkey}`;
  return `${el.tagName}|${el.type || ''}|${el.getAttribute('role') || ''}|${scopeOf(el)}|${nameOf(el)}`;
}

/** What has focus inside `root` now, as a key that survives rebuilding the DOM (or null). */
export function captureFocus(root) {
  if (typeof document === 'undefined' || !root) return null;
  const el = document.activeElement;
  if (!el || el === document.body || !root.contains(el) || el.getAttribute('tabindex') === '-1') return null;
  const sig = signature(el);
  const same = [...root.querySelectorAll(el.tagName)].filter((x) => signature(x) === sig);
  const out = { sig, tag: el.tagName, index: Math.max(0, same.indexOf(el)) };
  try {
    if (typeof el.selectionStart === 'number') out.sel = [el.selectionStart, el.selectionEnd];
  } catch { /* number inputs have no selection */ }
  return out;
}

/** Puts focus back on the matching control after a re-render (never scrolls the page). */
export function restoreFocus(root, saved) {
  if (!saved || !root) return false;
  const same = [...root.querySelectorAll(saved.tag)].filter((x) => x.matches(FOCUSABLE) && signature(x) === saved.sig);
  const el = same[Math.min(saved.index, same.length - 1)];
  if (!el || el.disabled) return false;
  focusQuietly(el, { preventScroll: true }); // never select a half-typed value (dom.selectOnFocus)
  if (saved.sel) {
    try { el.setSelectionRange(saved.sel[0], saved.sel[1]); } catch { /* not a text control */ }
  }
  return document.activeElement === el;
}
