// App shell: boot, hash router, navigation state, save indicator and error boundaries.
//
// Boot order: the data and the coaching content start loading first, and the page modules
// (views) are imported while those requests are in flight, so a slow SSH tunnel costs one
// round trip, not two.

import * as store from './store.js';
import { content, loadContent, contentProblems } from './content.js';
import { h, toast, confirmDialog } from './dom.js';
import { todayISO, fmtDay } from './dates.js';
import { cleanupCharts } from './charts.js';
import { applyTheme, cycleTheme } from './theme.js';
import { needsOnboarding } from './features/onboarding.js';
import { showConflictDialog, closeConflictDialog } from './features/conflict.js';
import { hasDirtyDrafts } from './features/drafts.js';
import { captureFocus, restoreFocus } from './features/focus.js';

const VIEW_MODULES = {
  today: () => import('./views/today.js'),
  train: () => import('./views/train.js'),
  program: () => import('./views/program.js'),
  print: () => import('./views/print.js'),
  exercises: () => import('./views/exercises.js'),
  checkin: () => import('./views/checkin.js'),
  progress: () => import('./views/progress.js'),
  nutrition: () => import('./views/nutrition.js'),
  arm: () => import('./views/arm.js'),
  hikes: () => import('./views/hikes.js'),
  guide: () => import('./views/guide.js'),
  review: () => import('./views/review.js'),
  settings: () => import('./views/settings.js'),
  welcome: () => import('./views/welcome.js'),
};
const ROUTES = {};
const NAV_FOR = { print: 'program', welcome: 'today' };
const SAVE_TEXT = {
  idle: 'Loading',
  saved: 'All changes saved',
  dirty: 'Saving…',
  saving: 'Saving…',
  error: 'Not saved yet: retrying',
  offline: 'Offline: will retry',
  'offline-idle': 'Offline',
  conflict: 'Changed elsewhere: check your data',
  fixture: 'Sample data: not saved',
  outdated: 'Hub updated: reload to save',
  'build-mismatch': 'Hub updated: reload to save',
};
/** Round 4 (finding 2): the phone's top bar shows the state as a short, always-visible chip. */
const SAVE_SHORT = {
  idle: 'Loading', saved: 'Saved', dirty: 'Saving…', saving: 'Saving…', error: 'Not saved: retrying', offline: 'Offline: will retry',
  'offline-idle': 'Offline', conflict: 'Changed elsewhere', fixture: 'Sample data', outdated: 'Reload to save', 'build-mismatch': 'Reload to save',
};
const UPDATED_TEXT = typeof store.BUILD_MISMATCH_TEXT === 'string' ? store.BUILD_MISMATCH_TEXT : 'The hub was updated. Reload to continue.';
/** Said once (politely) when the save state changes; never for each autosave. */
const SAVE_SAY = {
  saved: 'All changes saved.',
  offline: 'Offline: will retry. Your changes are kept on this device.',
  'offline-idle': 'Offline. Changes you make are kept on this device until the hub is back.',
  error: 'Not saved yet: retrying. Your changes are kept on this device.',
  conflict: 'Changed elsewhere: check your data.',
  outdated: UPDATED_TEXT,
};
const SETTLED = new Set(['saved', 'offline', 'offline-idle', 'error', 'conflict', 'outdated']);
const PROBLEM = new Set(['error', 'offline', 'conflict', 'outdated']);

const hasDom = typeof document !== 'undefined';
const main = hasDom ? document.getElementById('main') : null;
let cleanups = [];
let lastDay = todayISO();
let buildMismatch = false;
let storeStatus = 'idle';
let storeInfo = null;
let lastSettled = null;
let hadProblem = false;

function parseHash() {
  const raw = location.hash || '';
  if (!raw.startsWith('#/')) return null;
  const parts = raw.slice(2).split('/').filter((p) => p !== '').map((p) => { try { return decodeURIComponent(p); } catch { return p; } });
  return { name: parts[0] || 'today', params: parts.slice(1) };
}

export function navigate(hash) {
  if (location.hash === hash) render({ keepScroll: false });
  else location.hash = hash;
}

function errorMessage(err) {
  return String(err && err.message ? err.message : err);
}

/** Shown when a whole view fails to build. The menu and every other page still work. */
function errorView(err, routeName) {
  return h('div', { class: 'page page-narrow' },
    h('h1', { class: 'page-title', tabindex: '-1', id: 'page-title' }, 'This page hit a problem'),
    h('p', { class: 'page-lede' }, 'Your data is safe, and the rest of the hub still works. Something in this page, or the content it reads, didn’t load as expected. Reloading usually fixes it.'),
    h('div', { class: 'row', style: { 'margin-top': '20px' } },
      h('button', { type: 'button', class: 'btn btn-primary', onClick: () => location.reload() }, 'Reload the hub'),
      routeName !== 'today' ? h('a', { class: 'btn', href: '#/today' }, 'Go to Today') : null),
    h('details', { class: 'disclose error-detail' }, h('summary', null, 'Technical details'),
      h('pre', { class: 'notice' }, `${routeName ? `Page: ${routeName}\n` : ''}${errorMessage(err)}`)));
}

const BANNER_KEY = 'fitness-hub:content-alert-dismissed';

/** A dismissible warning when a coaching file has a safety problem (missing red flags, unknown gates…). */
function contentBanner() {
  let list = [];
  try { list = contentProblems().filter((p) => p.safety); } catch { list = []; }
  if (!list.length) return null;
  const sig = list.map((p) => p.message).join('|');
  try { if (sessionStorage.getItem(BANNER_KEY) === sig) return null; } catch { /* storage blocked: show it */ }
  const el = h('div', { class: 'banner banner-amber content-alert', role: 'status' },
    h('span', { 'aria-hidden': 'true', class: 'content-alert-mark' }, '!'),
    h('div', null,
      h('p', { class: 'banner-title' }, 'A coaching file needs checking'),
      h('p', null, `${String(list[0].label).replace(/\bProgram\b/g, 'Programme')}: ${list[0].message.replace(/^Safety:\s*/, '')}`),
      list.length > 1 ? h('p', { class: 'small' }, `And ${list.length - 1} more. The hub keeps you on the safe side meanwhile.`) : null,
      h('p', { class: 'row', style: { 'margin-top': '8px' } },
        h('a', { class: 'btn btn-sm', href: '#/settings' }, 'See the details'),
        h('button', { type: 'button', class: 'btn btn-sm btn-ghost', onClick: () => { try { sessionStorage.setItem(BANNER_KEY, sig); } catch { /* ignore */ } el.remove(); } }, 'Hide for now'))));
  return el;
}

/** SPEC 5.7a build id: the server runs a newer hub than this tab. Local changes are kept. */
function updatedBanner() {
  if (!buildMismatch) return null;
  return h('div', { class: 'banner banner-accent updated-banner', role: 'alert' },
    h('span', { 'aria-hidden': 'true', class: 'content-alert-mark updated-mark' }, '↻'),
    h('div', null,
      h('p', { class: 'banner-title' }, UPDATED_TEXT),
      h('p', null, 'Your latest changes are kept in this browser and are offered back after the reload. Nothing is saved to the hub until you reload.'),
      h('p', { class: 'row', style: { 'margin-top': '8px' } },
        h('button', { type: 'button', class: 'btn btn-primary', onClick: () => location.reload() }, 'Reload now'))));
}

/**
 * The save state to show (round 4, finding 2). "Offline" is explicit: the browser says it's
 * offline, or a save got no answer at all (status 0: network down, tunnel gone, timeout).
 */
export function shownSaveState(status, info, { online = true, outdated = false } = {}) {
  if (outdated) return 'outdated';
  if (status === 'fixture' || status === 'conflict' || status === 'idle') return status;
  if (status === 'build-mismatch' || status === 'outdated') return 'outdated';
  if (!online) return status === 'saved' ? 'offline-idle' : 'offline';
  const e = info?.error;
  if (status === 'error' && e && (e.status === 0 || e.timeout)) return 'offline';
  return status;
}

const browserOnline = () => typeof navigator === 'undefined' || navigator.onLine !== false;

/** Paints both save chips (the phone's top bar and the menu) from the store's latest status. */
function paintSave() {
  const shown = shownSaveState(storeStatus, storeInfo, { online: browserOnline(), outdated: buildMismatch });
  for (const el of document.querySelectorAll('.save-status')) {
    el.dataset.state = shown;
    const text = el.querySelector('.save-text');
    const words = el.closest('.topbar') ? SAVE_SHORT : SAVE_TEXT;
    if (text) text.textContent = words[shown] || SAVE_TEXT[shown] || shown;
    const err = storeInfo?.error;
    el.title = PROBLEM.has(shown) && err?.message ? `Last error: ${err.message}` : shown === 'saved' && storeInfo?.savedAt ? `Last saved ${new Date(storeInfo.savedAt).toLocaleTimeString('en-GB')}` : '';
    const retry = el.querySelector('.save-retry');
    if (retry) {
      retry.hidden = !PROBLEM.has(shown);
      // "Retry now"; the smallest phones drop " now" (CSS) so the chip keeps its words.
      if (shown === 'conflict') retry.textContent = 'Resolve';
      else if (shown === 'outdated') retry.textContent = 'Reload';
      else retry.replaceChildren('Retry', h('span', { class: 'retry-more' }, ' now'));
    }
  }
  announceSave(shown);
}

/**
 * One polite announcement per change of settled state: going offline, a save that failed, a
 * conflict, the hub being updated, and "All changes saved" once things recover (finding 10).
 * Ordinary autosaves stay quiet.
 */
function announceSave(shown) {
  if (!SETTLED.has(shown) || shown === lastSettled) return;
  const first = lastSettled === null;
  lastSettled = shown;
  let msg = null;
  if (shown === 'saved') {
    if (hadProblem && !first) msg = SAVE_SAY.saved; // recovered: "All changes saved."
    hadProblem = false;
  } else {
    hadProblem = true;
    msg = SAVE_SAY[shown] || null;
  }
  if (!msg) return;
  for (const live of document.querySelectorAll('.save-status .save-live')) {
    live.textContent = '';
    live.textContent = msg;
  }
}

/** The first load failed: the chips say so (no Retry there: the page has its own). */
function paintBootFailure(kind) {
  for (const el of document.querySelectorAll('.save-status')) {
    el.dataset.state = kind === 'offline' ? 'offline-idle' : 'error';
    const text = el.querySelector('.save-text');
    if (text) text.textContent = kind === 'offline' ? 'Offline' : 'Not loaded';
    const retry = el.querySelector('.save-retry');
    if (retry) retry.hidden = true;
  }
}

/** The mismatch went away (for example the hub was rolled back): remove the banner. */
function clearBuildMismatch() {
  if (!buildMismatch) return;
  buildMismatch = false;
  main.querySelector('.updated-banner')?.remove();
  storeStatus = store.getStatus();
  paintSave();
}

function showBuildMismatch() {
  if (buildMismatch) return;
  buildMismatch = true;
  const old = main.querySelector('.updated-banner');
  if (!old) main.prepend(updatedBanner());
  paintSave();
}

/** Recognises the store's build-mismatch report, whatever shape it arrives in. */
function isBuildMismatch(st, info) {
  if (st === 'outdated' || st === 'build_mismatch' || st === 'build-mismatch' || st === 'updated') return true;
  if (info && (info.buildMismatch || info.build_mismatch || info.outdated)) return true;
  const e = info?.error;
  return !!e && (e.status === 409 && (!e.body || e.body.error === 'build_mismatch' || /build/i.test(String(e.body?.error || ''))));
}

function notFound() {
  return h('div', { class: 'page' },
    h('h1', { class: 'page-title', tabindex: '-1', id: 'page-title' }, 'Page not found'),
    h('p', { class: 'page-lede' }, 'That address doesn’t match a page in the hub.'),
    h('p', { style: { 'margin-top': '16px' } }, h('a', { class: 'btn', href: '#/today' }, 'Go to Today')));
}

function markNav(name) {
  for (const a of document.querySelectorAll('.nav a[data-route], .tabbar a[data-route]')) {
    if (a.dataset.route === name) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  }
}

function render({ keepScroll = false } = {}) {
  const r = parseHash();
  if (!r) return;
  const focus = keepScroll ? captureFocus(main) : null;
  for (const fn of cleanups.splice(0)) { try { fn(); } catch (e) { console.error(e); } }
  const view = ROUTES[r.name];
  lastDay = todayISO();
  const ctx = {
    route: r.name,
    params: r.params,
    get data() { return store.get(); },
    store,
    content,
    today: lastDay,
    navigate,
    rerender: () => render({ keepScroll: true }),
    onCleanup: (fn) => cleanups.push(fn),
  };
  const y = window.scrollY;
  let node;
  try {
    node = view ? view.render(ctx) : notFound();
  } catch (err) {
    console.error(err);
    node = errorView(err, r.name);
  }
  main.replaceChildren(updatedBanner(), contentBanner(), node);
  cleanupCharts();
  markNav(NAV_FOR[r.name] || r.name);
  const t = view ? view.title || 'Fitness Hub' : 'Page not found';
  document.title = `${t} — Fitness Hub`;
  closeNav({ restore: false });
  if (keepScroll) {
    window.scrollTo(0, y);
    restoreFocus(main, focus);
  } else {
    window.scrollTo(0, 0);
    const heading = main.querySelector('#page-title') || main.querySelector('h1');
    if (heading) {
      if (!heading.hasAttribute('tabindex')) heading.setAttribute('tabindex', '-1');
      heading.focus({ preventScroll: true });
    }
  }
}

// ---------------------------------------------------------------- mobile menu (a modal while open)

let navOpener = null;
const mobileNav = () => window.matchMedia('(max-width: 880px)').matches;

function openers() {
  return [...document.querySelectorAll('.menu-btn, .tab-menu')];
}

function setBackgroundInert(on) {
  for (const el of [main, document.querySelector('.topbar'), document.querySelector('.tabbar'), document.querySelector('.skip-link')]) {
    if (!el) continue;
    if (on) el.setAttribute('inert', ''); else el.removeAttribute('inert');
  }
}

function openNav(opener) {
  navOpener = opener || null;
  document.body.classList.add('nav-open');
  for (const b of openers()) b.setAttribute('aria-expanded', 'true');
  const sidebar = document.getElementById('sidebar');
  if (mobileNav()) {
    sidebar?.setAttribute('role', 'dialog');
    sidebar?.setAttribute('aria-modal', 'true');
    setBackgroundInert(true);
  }
  (sidebar?.querySelector('.nav a[aria-current="page"]') || sidebar?.querySelector('.nav a'))?.focus();
}

function closeNav({ restore = true } = {}) {
  const wasOpen = document.body.classList.contains('nav-open');
  document.body.classList.remove('nav-open');
  for (const b of openers()) b.setAttribute('aria-expanded', 'false');
  const sidebar = document.getElementById('sidebar');
  sidebar?.removeAttribute('role');
  sidebar?.removeAttribute('aria-modal');
  setBackgroundInert(false);
  if (wasOpen && restore && navOpener && navOpener.isConnected) navOpener.focus();
  if (wasOpen) navOpener = null;
}

function setupShell(fixtures) {
  applyTheme();
  document.getElementById('theme-toggle')?.addEventListener('click', cycleTheme);
  for (const opener of openers()) {
    opener.addEventListener('click', () => {
      if (document.body.classList.contains('nav-open')) closeNav(); else openNav(opener);
    });
  }
  document.querySelector('.nav-close')?.addEventListener('click', () => closeNav());
  document.querySelector('.scrim')?.addEventListener('click', () => closeNav());
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && document.body.classList.contains('nav-open')) { e.preventDefault(); closeNav(); }
  });
  window.matchMedia('(max-width: 880px)').addEventListener?.('change', (e) => { if (!e.matches) closeNav({ restore: false }); });
  document.querySelector('.skip-link')?.addEventListener('click', (e) => { e.preventDefault(); main.focus(); });
  for (const b of document.querySelectorAll('.save-retry')) {
    b.addEventListener('click', () => {
      if (buildMismatch) { location.reload(); return; }
      const c = typeof store.getConflict === 'function' ? store.getConflict() : null;
      if (c) showConflictDialog(c); else store.retry();
    });
  }
  if (fixtures) {
    const badge = document.querySelector('.fixture-badge');
    if (badge) badge.hidden = false;
  }
  // Each save chip carries one polite live region: problems and recoveries, not every autosave.
  store.onStatus((st, info) => {
    storeStatus = st;
    storeInfo = info || null;
    if (isBuildMismatch(st, info)) { showBuildMismatch(); return; }
    if (buildMismatch && (st === 'saved' || st === 'saving' || st === 'dirty') && !info?.buildMismatch) { clearBuildMismatch(); return; }
    paintSave();
  });
  // The browser's own online / offline signal shows straight away (the store retries on "online").
  window.addEventListener('online', paintSave);
  window.addEventListener('offline', paintSave);
  if (typeof store.onBuildMismatch === 'function') store.onBuildMismatch((m) => { if (m) showBuildMismatch(); else clearBuildMismatch(); });
  window.addEventListener('fitness-hub:build-mismatch', (e) => { if (e?.detail === null) clearBuildMismatch(); else showBuildMismatch(); });
}

/**
 * Form drafts (rehab log, measurements, test results, the hike log) live only in this tab until
 * you press Save: ask before the tab closes with one open (PE6). Unsaved data changes are the
 * store's job (it keeps a localStorage copy and asks on its own when that matters).
 */
function setupLeaveGuard() {
  window.addEventListener('beforeunload', (e) => {
    if (hasDirtyDrafts()) { e.preventDefault(); e.returnValue = ''; }
  });
}

/** SEC10: the hub has no service worker, so any registration is unknown and is removed. */
function removeServiceWorkers() {
  try {
    navigator.serviceWorker?.getRegistrations?.().then((regs) => regs.forEach((r) => r.unregister())).catch(() => {});
  } catch { /* not supported */ }
}

/** How many kept changes a recovery offer holds: the store gives a number (older ones a list). */
export function recoveryCount(pending) {
  const c = pending?.changes;
  if (typeof c === 'number' && Number.isFinite(c) && c > 0) return Math.round(c);
  if (Array.isArray(c)) return c.length;
  return 0;
}

async function offerRecovery(pending) {
  const when = pending.at ? new Date(pending.at) : null;
  const n = recoveryCount(pending);
  const ok = await confirmDialog({
    title: 'Restore unsaved changes?',
    body: `This browser kept ${n ? `${n} change${n === 1 ? '' : 's'}` : 'changes'} from ${when ? `${fmtDay(todayISO(when))} at ${when.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}` : 'earlier'} that never reached the hub, for example because the tab closed while you were typing. They’ve been lined up with what’s saved now. Restore them? Choosing “Keep the saved data” sets them aside.`,
    confirmText: 'Restore my changes',
    cancelText: 'Keep the saved data',
  });
  if (ok) {
    if (typeof store.restorePending === 'function') await store.restorePending();
    else await store.replaceAll(pending.data);
    toast('Unsaved changes restored');
    render({ keepScroll: true });
  } else {
    store.discardPending();
  }
}

/**
 * Why the first load failed: 'offline' (no answer at all: network, tunnel, a stopped hub or a
 * timeout), 'damaged' (the hub answered, but data/data.json isn't valid JSON) or 'error' (the hub
 * answered with some other error).
 */
export function bootFailure(err) {
  const status = err && typeof err.status === 'number' ? err.status : null;
  const msg = String(err?.message || '');
  if ((status === 500 || status === 502) && /not valid JSON/i.test(msg)) return 'damaged';
  if (status === 0 || err?.timeout) return 'offline';
  return 'error';
}

/** localStorage, or null where it's missing or blocked (reading it can throw there). */
function browserStorage() {
  try { return typeof localStorage !== 'undefined' ? localStorage : null; } catch { return null; }
}

/**
 * Unsaved changes this browser kept from earlier visits (localStorage, written by the store):
 * {changes, copies, legacy}. They are only read here, never changed, so nothing is lost while
 * the hub is down; the store offers them back after the next successful load.
 */
export function keptChanges(storage = browserStorage()) {
  const out = { changes: 0, copies: 0, legacy: false };
  if (!storage) return out;
  try {
    for (let i = 0; i < storage.length; i++) {
      const k = storage.key(i);
      if (typeof k !== 'string' || !k.startsWith('fitness-hub:pending')) continue;
      if (k === 'fitness-hub:pending') { out.legacy = true; out.copies += 1; continue; }
      try {
        const v = JSON.parse(storage.getItem(k));
        if (v && Array.isArray(v.changes) && v.changes.length) { out.changes += v.changes.length; out.copies += 1; }
      } catch { /* unreadable: left alone */ }
    }
  } catch { /* storage blocked */ }
  return out;
}

const RETRY_EVERY_MS = 15000;

/** Asks the hub whether it's there (any HTTP answer counts), without loading anything. */
async function hubAnswers() {
  const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
  const t = setTimeout(() => ctrl?.abort(), 8000);
  try {
    const res = await fetch('/api/health', { cache: 'no-store', credentials: 'same-origin', signal: ctrl?.signal });
    return res.status > 0;
  } catch { return false; } finally { clearTimeout(t); }
}

/**
 * The first load failed. Round 4 (findings 12 and 16): a friendly offline screen when the hub
 * doesn't answer (it checks again by itself and reloads only once the hub answers, so a reload
 * can never land on the browser's own offline page), a distinct page for a damaged data file,
 * and in every case the unsaved changes this browser kept are left untouched and said so.
 */
function serverDown(err) {
  const kind = bootFailure(err);
  const kept = keptChanges();
  const keptLine = kept.changes
    ? `This device is keeping ${kept.changes} unsaved change${kept.changes === 1 ? '' : 's'} from earlier. ${kept.changes === 1 ? 'It’s' : 'They’re'} offered back as soon as the hub loads.`
    : kept.legacy ? 'This device is keeping unsaved changes from earlier. They’re offered back as soon as the hub loads.'
      : 'Everything you saved before is safe on the hub.';
  const title = (t) => h('h1', { class: 'page-title', tabindex: '-1', id: 'page-title' }, t);
  const details = err?.message ? h('details', { class: 'disclose error-detail' }, h('summary', null, 'Technical details'), h('pre', { class: 'notice' }, String(err.message))) : null;
  if (kind === 'damaged') {
    return h('div', { class: 'page page-narrow boot-problem', dataset: { kind } },
      title('The hub’s data file is damaged'),
      h('p', { class: 'page-lede' }, 'The hub answered, but its data file (data/data.json) isn’t valid JSON, so your data can’t load. Nothing has been overwritten: the hub never saves over a damaged file.'),
      h('div', { class: 'notice notice-warn boot-steps' },
        h('p', null, h('strong', null, 'To fix it')),
        h('ol', null,
          h('li', null, 'Stop the hub.'),
          h('li', null, 'Copy the newest good file from data/backups over data/data.json (keep the name data.json).'),
          h('li', null, 'Start the hub again, then reload this page.'))),
      h('p', { class: 'boot-kept' }, keptLine),
      h('div', { class: 'boot-actions' }, h('button', { type: 'button', class: 'btn btn-primary btn-lg', onClick: () => location.reload() }, 'Reload the hub')),
      details);
  }
  if (kind === 'error') {
    return h('div', { class: 'page page-narrow boot-problem', dataset: { kind } },
      title('The hub couldn’t load your data'),
      h('p', { class: 'page-lede' }, 'The hub answered with an error, so your data can’t load right now. Nothing has been changed.'),
      h('p', { class: 'boot-kept' }, keptLine),
      h('div', { class: 'boot-actions' }, h('button', { type: 'button', class: 'btn btn-primary btn-lg', onClick: () => location.reload() }, 'Try again')),
      details);
  }
  const line = h('p', { class: 'boot-check small muted', 'aria-live': 'polite' }, 'Checking again by itself every 15 seconds.');
  const btn = h('button', { type: 'button', class: 'btn btn-primary btn-lg' }, 'Try again');
  let busy = false;
  let timer = null;
  const attempt = async (byHand) => {
    if (busy) return;
    busy = true;
    btn.disabled = true;
    if (byHand) line.textContent = 'Checking…';
    const ok = await hubAnswers();
    busy = false;
    btn.disabled = false;
    if (ok) {
      line.textContent = 'The hub answered. Loading…';
      clearInterval(timer);
      location.reload();
      return;
    }
    line.textContent = `Still no answer (checked ${new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}). Checking again every 15 seconds.`;
  };
  btn.addEventListener('click', () => attempt(true));
  timer = setInterval(() => attempt(false), RETRY_EVERY_MS);
  window.addEventListener('online', () => attempt(false));
  return h('div', { class: 'page page-narrow boot-problem', dataset: { kind } },
    title('Can’t reach the hub'),
    h('p', { class: 'page-lede' }, 'Nothing is lost. The hub isn’t answering this device right now, so your data can’t load yet.'),
    h('p', { class: 'boot-kept' }, keptLine),
    h('div', { class: 'notice boot-steps' },
      h('p', null, h('strong', null, 'Things to check')),
      h('ul', null,
        h('li', null, 'This device is online: Wi-Fi or mobile data, and Tailscale if you use it.'),
        h('li', null, 'The hub is running: start_hub.bat or start_hub.sh on this computer, or the service on your home server, and your SSH tunnel is open.'))),
    h('div', { class: 'boot-actions' }, btn),
    line,
    details);
}

/** Errors outside a view's first render (event handlers, async work) get a toast, not a blank page. */
function setupErrorNet() {
  let lastAt = 0;
  const report = (err) => {
    console.error(err);
    const now = Date.now();
    if (now - lastAt < 4000) return;
    lastAt = now;
    toast(`Something on this page went wrong: ${errorMessage(err).slice(0, 140)}. Your data is safe; reload if it keeps happening.`, { tone: 'error', timeout: 8000 });
  };
  window.addEventListener('error', (e) => { if (e.error) report(e.error); });
  window.addEventListener('unhandledrejection', (e) => report(e.reason));
}

async function loadViews() {
  const names = Object.keys(VIEW_MODULES);
  const mods = await Promise.all(names.map((n) => VIEW_MODULES[n]()));
  names.forEach((n, i) => { ROUTES[n] = mods[i]; });
}

async function boot() {
  const params = new URLSearchParams(location.search);
  const fixtures = params.get('fixtures') === '1';
  setupShell(fixtures);
  setupErrorNet();
  setupLeaveGuard();
  removeServiceWorkers();
  let recovered = null;
  // Data and content first; the page modules load alongside them.
  const loading = Promise.all([loadContent({ fixtures }), store.init({ fixtures })]);
  const views = loadViews();
  try {
    const [, init] = await loading;
    recovered = init?.recovered || null;
  } catch (err) {
    console.error(err);
    main.replaceChildren(serverDown(err));
    paintBootFailure(bootFailure(err));
    document.getElementById('page-title')?.focus({ preventScroll: true });
    return;
  }
  try {
    await views;
  } catch (err) {
    console.error(err);
    main.replaceChildren(errorView(err, 'startup'));
    return;
  }
  window.addEventListener('hashchange', () => render());
  store.onExternalChange((info) => {
    const n = info?.notes?.length ? ` ${info.notes[0].message}` : '';
    toast(info?.kind === 'merge' ? `Merged with changes saved in another tab.${n}` : 'Updated with changes saved in another tab.');
    render({ keepScroll: true });
  });
  if (typeof store.onConflict === 'function') store.onConflict((c) => { if (c) showConflictDialog(c); else closeConflictDialog(); });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && todayISO() !== lastDay) render({ keepScroll: true });
  });
  const hash = parseHash();
  const firstRun = !recovered && (params.get('welcome') === '1' || (!fixtures && needsOnboarding(store.get())));
  if (firstRun && (!hash || hash.name === 'today')) history.replaceState(null, '', `${location.pathname}${location.search}#/welcome`);
  else if (!hash) history.replaceState(null, '', `${location.pathname}${location.search}#/today`);
  render();
  if (recovered) offerRecovery(recovered);
}

// The browser entry point; importing the module elsewhere (tests, the import check) does nothing.
if (hasDom && main) boot();
