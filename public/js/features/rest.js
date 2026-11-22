// Rest timer dock for the session logger. It sits at the bottom of the screen (above the mobile
// tab bar) and survives page changes, so you can open an exercise's cues mid-rest.
// - Big countdown, with what comes next ("Set 2 of 3" or the next exercise).
// - −15 s / +15 s / +30 s, and Skip. Once the rest is over it counts up, so you can see how long
//   you've been chatting, and closes itself after 90 seconds or when you tick the next set.
// - Screen readers hear 10 seconds left and "Rest over" (polite / assertive); sound and vibration
//   are a bonus (WebAudio, no files).
// - Round 4: the screen stays awake while the dock is up (Screen Wake Lock, feature-detected and
//   silently skipped where it isn't supported). The lock is released when the rest ends, is
//   skipped or closed, and requested again when the tab becomes visible while the dock is up.

import { h, s, fmtDuration } from '../dom.js';

let audio = null;
let dock = null;

/**
 * A Screen Wake Lock you can want or not want (pure: the browser objects are passed in, so the
 * tests can drive it). keep() asks for the lock; letGo() releases it; visible() asks again after
 * the browser dropped it while the tab was hidden. Every failure is silent: the lock is a nicety.
 */
export function wakeLockKeeper({ nav = typeof navigator !== 'undefined' ? navigator : null, doc = typeof document !== 'undefined' ? document : null } = {}) {
  let want = false;
  let sentinel = null;
  let pending = null;
  const supported = () => !!(nav && nav.wakeLock && typeof nav.wakeLock.request === 'function');
  const shown = () => !doc || doc.visibilityState === undefined || doc.visibilityState === 'visible';
  const drop = (sn) => {
    try { const p = sn && sn.release ? sn.release() : null; if (p && typeof p.catch === 'function') p.catch(() => {}); } catch { /* already gone */ }
  };
  const acquire = () => {
    if (!want || sentinel || pending || !supported() || !shown()) return pending;
    let req;
    try { req = nav.wakeLock.request('screen'); } catch { return null; }
    pending = Promise.resolve(req).then((sn) => {
      pending = null;
      if (!sn) return;
      if (!want) { drop(sn); return; } // the rest ended while the request was out
      sentinel = sn;
      try { sn.addEventListener?.('release', () => { if (sentinel === sn) sentinel = null; }); } catch { /* old shape */ }
    }, () => { pending = null; });
    return pending;
  };
  return {
    keep() { want = true; return acquire(); },
    letGo() { want = false; const sn = sentinel; sentinel = null; drop(sn); },
    visible() { if (want && shown()) return acquire(); return null; },
    get held() { return !!sentinel; },
    get wanted() { return want; },
  };
}

const wake = wakeLockKeeper();
if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') wake.visible(); });
}

function ensureAudio() {
  try {
    audio = audio || new (window.AudioContext || window.webkitAudioContext)();
    if (audio.state === 'suspended') audio.resume();
  } catch { audio = null; }
}

function tone(times = 1, freq = 880, dur = 0.14) {
  if (!audio) return;
  try {
    const t0 = audio.currentTime + 0.01;
    for (let i = 0; i < times; i++) {
      const at = t0 + i * 0.22;
      const osc = audio.createOscillator();
      const gain = audio.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.0001, at);
      gain.gain.exponentialRampToValueAtTime(0.2, at + 0.012);
      gain.gain.exponentialRampToValueAtTime(0.0001, at + dur);
      osc.connect(gain).connect(audio.destination);
      osc.start(at);
      osc.stop(at + dur + 0.03);
    }
  } catch { /* sound is a nicety */ }
}

function vibrate(p) {
  try { if (navigator.vibrate) navigator.vibrate(p); } catch { /* ignore */ }
}

/**
 * Closes the dock. reason 'user' (Skip, Close, or the 90-second auto-close) calls the onClose
 * hook, which the logger uses to move focus to the next set; a restart or an untick doesn't.
 */
export function stopRestDock(reason = 'code') {
  if (!dock) return;
  const { onClose } = dock;
  clearInterval(dock.tick);
  dock.el.remove();
  document.body.classList.remove('has-rest-dock');
  dock = null;
  // A restart asks for the lock again straight away, so it isn't released in between.
  if (reason !== 'restart') wake.letGo();
  if (reason === 'user' && typeof onClose === 'function') {
    try { onClose(); } catch (e) { console.error(e); }
  }
}

export const restDockActive = () => !!dock;

/**
 * Starts (or restarts) the rest timer.
 * seconds: rest length; title: what you're resting from; next: what comes next, e.g. "Set 2 of 3".
 */
export function startRestDock({ seconds, title = 'Rest', next = '', onClose = null } = {}) {
  ensureAudio();
  stopRestDock('restart');
  if (!(seconds > 0)) { wake.letGo(); return; }
  wake.keep();
  const time = h('p', { class: 'rd-time', role: 'timer', 'aria-live': 'off', 'aria-atomic': 'true' });
  const state = h('p', { class: 'rd-state' });
  const fill = h('div', { class: 'rd-fill' });
  const polite = h('p', { class: 'visually-hidden', 'aria-live': 'polite' });
  const urgent = h('p', { class: 'visually-hidden', 'aria-live': 'assertive' });
  const adjust = (d) => {
    if (!dock) return;
    if (dock.over) { dock.over = false; dock.el.classList.remove('is-over'); dock.end = Date.now(); }
    dock.end += d * 1000;
    dock.total = Math.max(1, dock.total + d);
    dock.warned = false;
    render();
  };
  const btn = (label, onClick, cls = 'btn btn-sm', aria = null) => h('button', { type: 'button', class: cls, onClick, 'aria-label': aria }, label);
  const userClose = () => stopRestDock('user');
  const close = btn(s('svg', { width: 16, height: 16, viewBox: '0 0 20 20', 'aria-hidden': 'true', class: 'ico' }, s('path', { d: 'M5 5l10 10M15 5 5 15' })), userClose, 'icon-btn rd-close', 'Close the rest timer');
  const el = h('div', { class: 'rest-dock', role: 'region', 'aria-label': 'Rest timer' },
    h('div', { class: 'rd-top' },
      h('div', { class: 'rd-text' }, h('p', { class: 'rd-title' }, title), state),
      time, close),
    h('div', { class: 'rd-bar', 'aria-hidden': 'true' }, fill),
    h('div', { class: 'rd-actions' },
      btn('−15 s', () => adjust(-15), 'btn btn-sm', 'Take 15 seconds off'),
      btn('+15 s', () => adjust(15), 'btn btn-sm', 'Add 15 seconds'),
      btn('+30 s', () => adjust(30), 'btn btn-sm', 'Add 30 seconds'),
      btn('Skip rest', userClose, 'btn btn-sm btn-ghost rd-skip')),
    polite, urgent);
  document.body.appendChild(el);
  document.body.classList.add('has-rest-dock');
  dock = { el, end: Date.now() + seconds * 1000, total: seconds, tick: null, over: false, warned: false, overSince: 0, onClose };
  const nextText = next ? `Next: ${next}` : 'Get ready for the next set';
  const render = () => {
    if (!dock) return;
    const left = (dock.end - Date.now()) / 1000;
    if (left > 0) {
      time.textContent = fmtDuration(Math.ceil(left));
      state.textContent = nextText;
      fill.style.width = `${Math.max(0, Math.min(100, 100 - (left / dock.total) * 100))}%`;
      if (left <= 10 && !dock.warned && dock.total > 20) { dock.warned = true; polite.textContent = '10 seconds of rest left.'; tone(1, 660, 0.08); }
      return;
    }
    if (!dock.over) {
      dock.over = true;
      dock.overSince = Date.now();
      el.classList.add('is-over');
      urgent.textContent = `Rest over. ${next ? `${next}: go.` : 'Start your next set.'}`;
      tone(2, 880);
      vibrate([200, 100, 200]);
    }
    const over = (Date.now() - dock.end) / 1000;
    time.textContent = `+${fmtDuration(Math.floor(over))}`;
    state.textContent = next ? `${next}: go` : 'Go: next set';
    fill.style.width = '100%';
    if (over > 90) stopRestDock('user');
  };
  dock.tick = setInterval(render, 250);
  render();
}
