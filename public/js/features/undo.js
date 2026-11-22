// Inline Undo, placed next to the thing you just changed (not a toast that times out).
// A view puts undoSlot('hikes') where the bar should appear; offerUndo('hikes', {...}) fills it.
// The offer survives re-renders (it lives here, not in the page) and stays until you press
// Undo or Dismiss, or another offer replaces it in the same slot.

import { h } from '../dom.js';

const offers = new Map(); // slot -> {message, undo, id}
let seq = 0;

function hostsFor(slot) {
  if (typeof document === 'undefined') return [];
  return [...document.querySelectorAll('.undo-slot')].filter((el) => el.dataset.undoSlot === slot);
}

function bar(slot, offer, host) {
  const dismiss = () => {
    if (offers.get(slot)?.id === offer.id) offers.delete(slot);
    refresh(slot);
    host.focus({ preventScroll: true });
  };
  const undoBtn = h('button', { type: 'button', class: 'btn btn-sm undo-btn', onClick: () => {
    if (offers.get(slot)?.id === offer.id) offers.delete(slot);
    refresh(slot);
    try { offer.undo(); } finally {
      const target = host.isConnected ? host : hostsFor(slot)[0];
      if (target) target.focus({ preventScroll: true });
    }
  } }, 'Undo');
  return h('div', { class: 'undo-bar', role: 'status' },
    h('span', { class: 'undo-msg' }, offer.message),
    h('span', { class: 'undo-actions' }, undoBtn,
      h('button', { type: 'button', class: 'btn btn-sm btn-ghost', onClick: dismiss }, 'Dismiss')));
}

function fill(host) {
  const slot = host.dataset.undoSlot;
  const offer = offers.get(slot);
  host.replaceChildren(offer ? bar(slot, offer, host) : null);
  host.classList.toggle('has-undo', !!offer);
}

function refresh(slot) {
  for (const host of hostsFor(slot)) fill(host);
}

/** The place an Undo bar appears for `slot` (empty until offerUndo). */
export function undoSlot(slot, { cls = null } = {}) {
  const host = h('div', { class: ['undo-slot', cls], tabindex: '-1', dataset: { undoSlot: slot } });
  fill(host);
  return host;
}

/**
 * Shows "message [Undo] [Dismiss]" in every visible slot named `slot`. With focus: true the
 * Undo button gets keyboard focus (use it when the control you pressed has just disappeared).
 */
export function offerUndo(slot, { message, undo, focus = false }) {
  const offer = { message, undo, id: ++seq };
  offers.set(slot, offer);
  refresh(slot);
  if (focus) {
    const btn = hostsFor(slot).map((x) => x.querySelector('.undo-btn')).find(Boolean);
    if (btn) btn.focus({ preventScroll: false });
  }
  return () => { if (offers.get(slot)?.id === offer.id) { offers.delete(slot); refresh(slot); } };
}

export function clearUndo(slot) {
  offers.delete(slot);
  refresh(slot);
}

export const hasUndo = (slot) => offers.has(slot);
