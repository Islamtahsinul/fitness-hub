// #/train[/YYYY-MM-DD[/session]] and #/train/w/<workout-id>: the session logger.
// Input autosaves into a draft workout as you type; "Save session" marks it done.
//
// Built for the gym floor: each set shows its target as real numbers you can change, and the
// tick records exactly what's shown. A ticked set's kg carries into the sets after it. "All sets
// done" ticks the day's effective sets and says what it records. Easy-day mode follows today's
// readiness live (your own toggle wins). A red day shows the stop message and nothing starts.
// Exercises that aren't in the library, or aren't cleared yet, stay locked.
//
// Round 4 (SPEC 5.2): every exercise entry stores `planned`, the effective prescription that day
// (after sets_max, deload, easy-day or fasting halving, and swaps). A swapped-in or added
// exercise is shown with its own prescription (timed, reps or loaded with a kg column), cues and
// dose, and only exercises the current phase allows are offered (allowedForPhase).
// After the gym, "Enter from sheet" is a compact grid for typing in the printed week sheet.

import { h, uid, toast, confirmDialog, fmtDuration, fmtMinutes, replaceKids, debounce, selectOnFocus } from '../dom.js';
import { fmtDay, isISODate } from '../dates.js';
import { incrementFor, parseRepRange } from '../schedule.js';
import { isNum } from '../calc.js';
import { lastPerformance, isDone, workoutIssues } from '../stats.js';
import { pageHead, readinessBadge, exerciseButton, chip, gateLabel, gateText, numberField, selectField, textareaField, scaleField, dateField, emptyState, missingContent, parseNum, categoryLabel, statusIcon } from '../components.js';
import { content, exName, whyNotAllowed } from '../content.js';
import { intervalTimer, circuitTimer } from '../timers.js';
import { blockTarget, dash, easyMinutes, findWorkout, readinessOn, routineFor, sessionName, typeLabel, zoneText, isRestId, PHYSIO_ID, isPhysioBlock, fmtSecs } from './shared.js';
import { startRestDock, stopRestDock } from '../features/rest.js';
import { swapOptions, hasSwaps, applySwap, swapMode, performedCount, standInEntry, SWAP_TICKED_TEXT } from '../features/swap.js';
import { isPlateLoaded } from '../features/plates.js';
import { openPlateCalc } from '../features/platecalc.js';
import { icon, waymark } from '../features/icons.js';
import { isLocked, isAvailable, allowedForPhase, gateOf, progressionFor, holdReason, fastingOn, unavailableIds, RED_STOP, FASTING_TEXT } from '../features/safety.js';
import { blockKeys, findEntry, resolveFor, alternates, planOn, lastPlannedSets } from '../features/plan.js';
import { prescriptionFor, effectiveRx, rxFromBlock, plannedRecord, samePlanned, rxText, isLoadedExercise } from '../features/rx.js';
import { setTargets, setText, setsSummary, setHasActual, carriedKg } from '../features/sets.js';
import { singleFlight, setBusy } from '../features/busy.js';
import { undoSlot, offerUndo } from '../features/undo.js';
import * as store from '../store.js';

export const title = 'Log a session';

const ZONES = ['Z1', 'Z2', 'Z3', 'Z4', 'Z5', 'Z1-Z2', 'Z2-Z3', 'Z3-Z4', 'Z4-Z5', 'mixed'];
const CARDIO_ID = /(walk|hike|bike|stair|rower|ski-erg|ruck|incline|treadmill|cycle)/;
/** BT1-8: only these outdoor exercises offer "Add this to your hike log?". */
const HIKE_LOG_IDS = new Set(['walk-outdoor', 'hike-outdoor']);
const easyPref = new Map(); // date|session -> explicit easy-day choice before a draft exists
const recordMode = new Set(); // date|session: red day, "record something you did earlier" opened
const sheetMode = new Set(); // date|session: "Enter from sheet" grid is on
const addedRows = new Map(); // workout id|block key -> sets you added with "Add a set" (this tab)

const nowIso = () => new Date().toISOString();
const blankSet = () => ({ kg: null, reps: null, seconds: null, rir: null, done: false });
const setHasValues = (x) => !!x && (x.done || isNum(x.kg) || isNum(x.reps) || isNum(x.seconds));
const narrow = () => typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia('(max-width: 760px)').matches;

/** The most recent earlier done workout of the same session (for "copy last session"). */
function lastSameSession(data, sid, date, excludeId) {
  if (!sid || sid === 'adhoc') return null;
  return (data.workouts || [])
    .filter((w) => isDone(w) && w.session_id === sid && w.id !== excludeId && isISODate(w.date) && w.date <= date && (w.exercises || []).some((e) => (e.sets || []).some((x) => isNum(x.kg) || isNum(x.reps) || isNum(x.seconds))))
    .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0))[0] || null;
}

const hasValues = (w) => !!w && [...(w.exercises || [])].some((e) => (e.sets || []).some((x) => x.done || isNum(x.kg) || isNum(x.reps) || isNum(x.seconds)));

/** Exercises this session may offer (swaps, "Add an exercise"): SPEC 5.2 round 4, allowedForPhase. */
const allowed = (st, id) => allowedForPhase(id, st.date, st.ctx.data, { ceiling: st.addonGate, sessionId: st.addonGate ? st.sid : null });

/** Swap options that can actually be offered: allowed in this phase, unlocked on the day and at your gym. */
function offerable(st, current) {
  const o = swapOptions(current, { exById: content.exById, exercises: content.exercises, clearances: st.clearances, date: st.date, exclude: st.sessionIds(), unavailable: unavailableIds(st.ctx.data) });
  const ok = (id) => allowed(st, id);
  return { easier: o.easier.filter(ok), harder: o.harder.filter(ok), similar: o.similar.filter(ok) };
}

function redStop(date, today) {
  const isToday = date === today;
  return h('div', { class: 'banner banner-red', role: 'alert' },
    statusIcon('red', 28),
    h('div', null,
      h('p', { class: 'banner-title' }, isToday ? 'Red: no training today' : 'Red flag on this day'),
      h('p', null, RED_STOP),
      h('p', { class: 'row', style: { 'margin-top': '8px' } },
        h('a', { class: 'btn btn-sm', href: '#/arm' }, 'Clinic contacts and red flags'),
        h('a', { class: 'btn btn-sm btn-ghost', href: `#/checkin/${date}` }, 'Review the check-in'))));
}

// ---------------------------------------------------------------- the gym floor: notes, the next set

const NOTE_FOLD_CHARS = 160;

/**
 * A block's coaching note. Round 4 (finding 3): a long one folds to two lines on a phone, with
 * "More…" to open it, so the sets stay near the top of the card. Wide screens show it all.
 */
function blockNote(text) {
  const p = h('p', { class: 'block-note' }, text);
  if (typeof text !== 'string' || text.length <= NOTE_FOLD_CHARS) return p;
  p.id = uid('note');
  const wrap = h('div', { class: 'block-note-wrap is-folded' }, p);
  const more = h('button', { type: 'button', class: 'btn-link note-more no-print', 'aria-controls': p.id, 'aria-expanded': 'false', onClick: () => {
    const open = !wrap.classList.toggle('is-folded');
    more.setAttribute('aria-expanded', String(open));
    more.textContent = open ? 'Less' : 'More…';
  } }, 'More…');
  wrap.append(more);
  return wrap;
}

const reducedMotion = () => typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/** The space the page keeps clear (scroll-padding): the sticky top bar; the tab bar and docks below. */
function clearZone() {
  const cs = getComputedStyle(document.documentElement);
  const px = (v, d) => { const n = parseFloat(v); return Number.isFinite(n) ? n : d; };
  return { top: px(cs.scrollPaddingTop, 16), bottom: px(cs.scrollPaddingBottom, 24) };
}

/**
 * Round 4 (finding 3): brings a set into view between the top bar and the tab bar (and any dock),
 * then moves focus to its tick, a button, so the phone keyboard stays shut. The exercise card
 * shows from its title when it fits; otherwise the row sits in the middle of the clear space.
 * The row is marked for a moment so the eye finds it.
 */
function goToSet({ block = null, row = null, focus = null }) {
  const target = row || focus || block;
  if (!target || !target.isConnected) return;
  const { top, bottom } = clearZone();
  const vh = window.innerHeight || document.documentElement.clientHeight;
  const room = Math.max(80, vh - top - bottom);
  const t = target.getBoundingClientRect();
  const b = (block || target).getBoundingClientRect();
  if (!(t.top >= top && t.bottom <= vh - bottom)) {
    const dy = t.bottom - b.top <= room ? b.top - top : t.top - top - (room - t.height) / 2;
    window.scrollBy({ top: dy, behavior: reducedMotion() ? 'auto' : 'smooth' });
  }
  if (focus && focus.isConnected) focus.focus({ preventScroll: true });
  if (row) {
    row.classList.remove('is-next');
    void row.offsetWidth; // restart the mark
    row.classList.add('is-next');
    setTimeout(() => row.classList.remove('is-next'), 2400);
  }
}

/**
 * The next thing to do on the logger, in page order (after the block `after`, if given): the
 * first unticked set of an open exercise, else a cardio block with nothing logged, else the
 * physio block's "Done today". {block, row, focus, label} or null when everything is done.
 */
function nextTarget(root, after = null) {
  const blocks = [...root.querySelectorAll('.blocks > section.block:not(.is-locked)')];
  const from = after ? blocks.indexOf(after) + 1 : 0;
  for (const block of blocks.slice(Math.max(0, from))) {
    const name = block.dataset.name || 'Next exercise';
    const rows = [...block.querySelectorAll('.set-table tbody tr')];
    if (rows.length) {
      const i = rows.findIndex((r) => !r.classList.contains('is-done'));
      if (i >= 0) return { block, row: rows[i], focus: rows[i].querySelector('.set-check'), label: `Set ${i + 1} of ${rows.length}: ${name}`, kind: 'set' };
      continue;
    }
    if (block.dataset.kind === 'cardio') {
      const logged = [...block.querySelectorAll('input[data-fkey$=":minutes"], input[data-fkey$=":rounds"]')].some((i) => i.value.trim() !== '');
      if (logged) continue;
      const focus = block.querySelector('.timer button, .block-actions .btn') || block.querySelector('.block-title button');
      return { block, row: null, focus, label: name, kind: 'cardio' };
    }
    if (block.dataset.kind === 'physio') {
      const cb = block.querySelector('input[type="checkbox"]');
      if (cb && !cb.checked) return { block, row: null, focus: cb, label: name, kind: 'physio' };
    }
  }
  return null;
}

/** Every set is ticked: the Finish card, with focus on Save. */
function goToFinish() {
  const fin = document.querySelector('.finish');
  if (!fin) return;
  const btn = fin.querySelector('.session-actions .btn-primary');
  goToSet({ block: fin, row: null, focus: btn || null });
}

/**
 * Round 4 (finding 6): sets were ticked on this block, so a stand-in can't take its place (the
 * ticked sets stay on the exercise they were done on). The stand-in is logged fresh as an extra
 * exercise below, with its own prescription, and brought into view.
 */
function addStandIn(st, bd, entry, id, listName) {
  const w = st.ensure();
  const key = `x${Date.now().toString(36)}`;
  const cardio = listName === 'cardio';
  const rx = cardio ? null : effectiveRx(prescriptionFor(id), { override: st.plan.override, easyDay: st.easy });
  const added = standInEntry(id, { key, cardio, sets: rx?.sets || 2, zone: entry?.zone || 'Z2' });
  const list = cardio ? w.cardio : w.exercises;
  list.push(added);
  st.touched({ force: true });
  st.ctx.rerender();
  const n = performedCount(entry);
  const was = exName(entry?.exercise || bd.rb.exercise);
  offerUndo(`train-block:${bd.key}`, {
    message: cardio
      ? `${exName(id)} is added below as an extra exercise, starting fresh. What you logged stays as ${was}.`
      : `${exName(id)} is added below as an extra exercise, starting fresh. Your ${n} ticked set${n === 1 ? '' : 's'} stay${n === 1 ? 's' : ''} as ${was}.`,
    undo: () => {
      const i = list.indexOf(added);
      if (i >= 0) list.splice(i, 1);
      st.touched({ force: true });
      st.ctx.rerender();
    },
  });
  const show = () => {
    const card = [...document.querySelectorAll('.blocks > section.block')].find((el) => el.dataset.fscope === key);
    if (!card) return;
    const row = card.querySelector('.set-table tbody tr');
    goToSet({ block: card, row, focus: row ? row.querySelector('.set-check') : card.querySelector('.block-title button') });
  };
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(show); else setTimeout(show, 0);
}

// ---------------------------------------------------------------- prescriptions and `planned`

/**
 * The effective prescription for a block as logged today: the planned block, or, for a
 * swapped-in or added exercise, its own default dose from the library with the week's
 * adjustments (SPEC 5.2 round 4). Always strength-or-timed shaped for set work.
 */
function rxFor(st, bd, entry) {
  const { rb } = bd;
  const exId = entry?.exercise || rb.exercise;
  const own = bd.extra || (!!entry?.swapped_from && exId !== rb.exercise);
  if (own) {
    // A stand-in keeps the block's planned sets when its own range allows (prescriptionFor {sets}).
    const base = prescriptionFor(exId, bd.extra ? {} : { sets: rb.setsPlanned ?? rb.sets });
    if (base && (base.kind === 'strength' || base.kind === 'timed') && (base.kind === 'timed' ? isNum(base.seconds) : !!base.reps)) {
      const r = effectiveRx(base, { override: st.plan.override, easyDay: st.easy });
      // Finding 11: a stand-in rests as its own dose says (a wall sit: 60 s), else as the block planned.
      return { ...r, rest_s: isNum(base.rest_s) ? Number(base.rest_s) : isNum(rb.rest_s) ? rb.rest_s : 90, own: true };
    }
  }
  const r = rxFromBlock(rb);
  const ex = content.exById.get(exId);
  // A planned block's kg column follows the block's load; an unspecified load reads the kit.
  if (r && !rb.load) r.loaded = isLoadedExercise(ex);
  return r;
}

/** The planned record for one logged entry, or null when it can't be placed (left as it is). */
function plannedOf(st, entry) {
  if (!entry || typeof entry !== 'object' || typeof entry.exercise !== 'string') return null;
  if (entry.exercise === PHYSIO_ID) {
    const bd = st.descs.find((d) => isPhysioBlock(d.rb));
    const total = bd ? (bd.rb.seconds || 0) * (bd.rb.sets || 1) : null;
    return { sets: 1, reps: null, rir: null, seconds: total || null, load: 'physio' };
  }
  if (entry.extra) return plannedRecord(rxFor(st, { rb: { kind: 'strength', exercise: entry.exercise, rest_s: 90 }, key: entry.block, extra: true }, entry));
  const bd = st.descs.find((d) => d.key === entry.block)
    || st.descs.find((d) => d.legacy === entry.block && (entry.exercise === d.rb.exercise || entry.swapped_from === d.rb.exercise));
  if (bd) {
    if (bd.rb.kind !== 'strength' && bd.rb.kind !== 'timed') return null;
    return plannedRecord(rxFor(st, bd, entry));
  }
  // A block that's no longer in the programme: its exercise's own dose, adjusted for today.
  return plannedRecord(effectiveRx(prescriptionFor(entry.exercise), { override: st.plan.override, easyDay: st.easy }));
}

/**
 * SPEC 5.2 round 4: every exercises[] entry stores `planned` (the effective prescription).
 * Drafts follow the day live; a finished session keeps what it stored unless `force` (you
 * changed the prescription yourself: a swap, the easy-day switch, Save). Never rewrites an
 * identical record, so it causes no saves or merges of its own.
 */
function stampPlanned(st, { force = false } = {}) {
  const w = st.wk;
  if (!w || !Array.isArray(w.exercises)) return false;
  const live = force || w.status !== 'done';
  let changed = false;
  for (const e of w.exercises) {
    if (!e || typeof e !== 'object' || (!live && e.planned)) continue;
    const p = plannedOf(st, e);
    if (p && !samePlanned(e.planned, p)) { e.planned = p; changed = true; }
  }
  return changed;
}

/** At Save: blank, unticked sets past the planned number are dropped (they were never done). */
function trimBlankSets(w) {
  for (const e of Array.isArray(w?.exercises) ? w.exercises : []) {
    if (!e || !Array.isArray(e.sets)) continue;
    const keep = Math.max(1, isNum(e.planned?.sets) ? Number(e.planned.sets) : 1);
    while (e.sets.length > keep && !setHasValues(e.sets[e.sets.length - 1])) e.sets.pop();
  }
}

/** How many set rows a block shows: the effective sets, any you added, and any with values. */
function rowCount(st, bd, entry, rx) {
  const stored = Array.isArray(entry?.sets) ? entry.sets : [];
  let lastFilled = 0;
  stored.forEach((x, i) => { if (setHasValues(x)) lastFilled = i + 1; });
  const added = addedRows.get(`${st.wk?.id || 'new'}|${bd.key}`) || 0;
  return Math.max(1, rx.sets || 1, lastFilled, Math.min(stored.length, (rx.sets || 1) + added));
}

export function render(ctx) {
  const { data } = ctx;
  const program = content.program;
  const p = ctx.params;
  let date = ctx.today;
  let sid = null;
  let wk = null;
  if (p[0] === 'w') {
    wk = data.workouts.find((w) => w.id === p[1]) || null;
    if (!wk) {
      return h('div', { class: 'page' }, pageHead({ title: 'Session not found' }),
        undoSlot(`train:${ctx.today}`),
        emptyState({ title: 'That log no longer exists.', body: 'It may have been discarded. Pick a day to log a session.', action: h('a', { class: 'btn', href: '#/train' }, 'Log a session') }));
    }
    date = wk.date;
    sid = wk.session_id || 'adhoc';
  } else {
    if (isISODate(p[0])) date = p[0];
    if (p[1]) sid = p[1];
  }
  const plan = program ? planOn(program, data, date) : { sessions: [], pos: null, override: null };
  if (!sid) {
    const first = plan.sessions.find((e) => !e.isRest);
    sid = first ? first.sessionId : plan.sessions.length ? plan.sessions[0].sessionId : 'adhoc';
  }
  if (!wk) {
    wk = sid === 'adhoc'
      ? data.workouts.filter((w) => w.date === date && w.session_id === 'adhoc' && w.status === 'draft').pop() || null
      : findWorkout(data, date, sid);
  }
  const session = sid === 'adhoc' ? null : (program?.sessions?.[sid] || null);
  const clearances = data.profile.clearances;
  const r = readinessOn(ctx, date);
  const red = r.level === 'red';
  const fasting = fastingOn(data, date);
  const prefKey = `${date}|${sid}`;
  // PE2: easy-day mode follows readiness live; only an explicit toggle is stored.
  const choice = wk && typeof wk.easy_choice === 'boolean' ? wk.easy_choice : easyPref.has(prefKey) ? easyPref.get(prefKey) : null;
  const easy = !red && (choice !== null ? choice : r.level === 'amber');
  const week = plan.pos?.week || 1;
  const blocks = session ? resolveFor(session, { week, override: plan.override, easyDay: easy, fasting: !!fasting }) : [];
  const keys = blockKeys(blocks);
  const descs = blocks.map((rb, i) => ({ rb, key: keys[i], legacy: `b${i}`, index: i }));
  const cleanups = [];
  ctx.onCleanup(() => cleanups.forEach((fn) => fn()));
  const addonEntry = plan.sessions.find((e) => e.source === 'addon' && e.sessionId === sid) || null;

  const st = {
    ctx, date, sid, session, plan, wk, easy, red, fasting, clearances, blocks, descs, progressHooks: [], recordOnly: red || date > ctx.today,
    addonGate: addonEntry?.addon && typeof addonEntry.addon.gate === 'string' ? addonEntry.addon.gate : null,
  };
  st.sessionIds = () => [...blocks.map((b) => b.exercise), ...(st.wk?.exercises || []).map((e) => e.exercise), ...(st.wk?.cardio || []).map((e) => e.exercise)].filter(Boolean);
  st.hold = holdReason({ deload: !!plan.override?.deload, easy, fasting: !!fasting, red });
  st.done = () => st.wk?.status === 'done';

  const ensure = () => {
    if (st.wk) return st.wk;
    st.wk = {
      id: uid('uuid'), date, session_id: sid, session_name: sid === 'adhoc' ? 'Ad-hoc session' : (session?.name || sessionName(sid)),
      session_type: sid === 'adhoc' ? 'other' : (session?.type || 'other'),
      phase_id: plan.pos?.phaseId ?? null, phase_week: plan.pos?.week ?? null,
      duration_min: null, rpe: null, notes: '', exercises: [], cardio: [],
      status: 'draft', easy_day: easy, created_at: nowIso(), updated_at: nowIso(),
    };
    if (easyPref.has(prefKey)) st.wk.easy_choice = easyPref.get(prefKey);
    data.workouts.push(st.wk);
    store.touch();
    history.replaceState(null, '', `${location.pathname}${location.search}#/train/w/${st.wk.id}`);
    return st.wk;
  };
  const touched = ({ force = false } = {}) => {
    stampPlanned(st, { force });
    if (st.wk) st.wk.updated_at = nowIso();
    store.touch();
    st.progressHooks.forEach((fn) => fn());
  };
  st.touched = touched;
  st.ensure = ensure;

  const page = h('div', { class: 'page page-train' });

  // ---------------------------------------------------------------- top bar
  const options = [];
  const plannedOpts = plan.sessions.filter((e) => !e.isRest).map((e) => ({ value: e.sessionId, label: `${e.source === 'addon' ? 'Add-on: ' : ''}${e.session?.name || sessionName(e.sessionId)}` }));
  if (plannedOpts.length) options.push({ group: 'Planned for this day', options: plannedOpts });
  const alt = alternates(program);
  const altOpts = [['short', 'Short on time'], ['travel', 'Gym closed']].filter(([k]) => alt[k] && !plannedOpts.some((o) => o.value === alt[k]))
    .map(([k, l]) => ({ value: alt[k], label: `${l}: ${sessionName(alt[k])}` }));
  if (altOpts.length) options.push({ group: 'Alternatives', options: altOpts });
  const others = Object.entries(program?.sessions || {}).filter(([id, s]) => s && s.type !== 'rest' && !plannedOpts.some((o) => o.value === id) && !altOpts.some((o) => o.value === id))
    .map(([id, s]) => ({ value: id, label: s.name || sessionName(id) }));
  if (others.length) options.push({ group: 'Other sessions', options: others });
  options.push({ group: 'Your own', options: [{ value: 'adhoc', label: 'Ad-hoc session (pick exercises)' }] });
  if (!plannedOpts.some((o) => o.value === sid) && !others.some((o) => o.value === sid) && !altOpts.some((o) => o.value === sid) && sid !== 'adhoc') {
    options.unshift({ value: sid, label: sessionName(sid) });
  }
  const sameDay = data.workouts.filter((w) => w.date === date && w.id !== st.wk?.id);
  // BT1-15: on a phone the long texts fold away, so the first set is near the top.
  const small = narrow();
  const lede = session?.summary ? gateText(session.summary) : (sid === 'adhoc' ? 'Log anything you did: pick exercises from the library. Only exercises your clearances and this phase allow are offered.' : null);
  page.append(pageHead({
    title: sid === 'adhoc' ? 'Ad-hoc session' : (session?.name || sessionName(sid)),
    kicker: `${fmtDay(date)}${plan.pos ? `, ${plan.pos.item.short} week ${plan.pos.week}` : ''}`,
    lede: small ? null : lede,
  }));
  if (small && lede) page.append(h('details', { class: 'disclose train-fold' }, h('summary', null, 'About this session'), h('p', { class: 'page-lede' }, lede)));
  page.append(undoSlot(`train:${date}`));
  page.append(h('div', { class: 'train-bar no-print' },
    dateField({ label: 'Date', value: date, compact: true, onChange: (v) => { if (isISODate(v) && v !== date) ctx.navigate(`#/train/${v}`); } }),
    selectField({ label: 'Session', value: sid, options, cls: 'field-grow', onChange: (v) => ctx.navigate(`#/train/${date}/${encodeURIComponent(v)}`) }),
    sameDay.length ? h('div', { class: 'field' }, h('span', { class: 'field-label' }, 'Also logged this day'),
      h('div', { class: 'chip-row' }, sameDay.map((w) => h('a', { class: 'chip chip-btn', href: `#/train/w/${w.id}` }, `${w.session_name || sessionName(w.session_id)}${w.status === 'draft' ? ' (draft)' : ''}`)))) : null));

  if (!program && sid !== 'adhoc') page.append(missingContent('The programme', 'You can still log an ad-hoc session.'));

  // ---------------------------------------------------------------- red: stop (SPEC 5.8, CL8)
  if (red) page.append(redStop(date, ctx.today));
  if (fasting && !red) {
    page.append(h('div', { class: 'banner banner-fast', role: 'note' },
      h('span', { class: 'fast-mark', 'aria-hidden': 'true' }, icon('moon', 22)),
      h('div', null, h('p', { class: 'banner-title' }, fasting.label || 'Fasting period'), h('p', null, FASTING_TEXT))));
  }

  // ---------------------------------------------------------------- context & readiness
  const ctxBits = [];
  if (session) ctxBits.push(chip(typeLabel(session.type)));
  if (isNum(session?.duration_min)) ctxBits.push(chip(`About ${fmtMinutes(session.duration_min)}`));
  if (plan.override?.label) ctxBits.push(chip(`This week: ${plan.override.label}`, 'chip-accent'));
  if (plan.pos?.isRepeat) ctxBits.push(chip('Repeat week'));
  if (ctxBits.length) page.append(h('div', { class: 'chip-row train-chips' }, ctxBits));
  if (plan.override?.notes) {
    const notes = h('p', { class: 'notice notice-accent small train-note' }, gateText(plan.override.notes));
    page.append(small ? h('details', { class: 'disclose train-fold' }, h('summary', null, `This week’s notes${plan.override.label ? `: ${plan.override.label}` : ''}`), notes) : notes);
  }

  // On a red day the banner above carries the instruction; the box keeps the verdict and the reasons.
  const readyBox = h('div', { class: ['sheet', 'session-banner', red && 'notice-bad'] }, readinessBadge(r, { noAdvice: red }));
  if (!red) {
    const id = uid('easy');
    const auto = r.level === 'amber';
    readyBox.append(h('div', { class: 'check check-lg easy-toggle', style: { 'margin-top': '12px' } },
      h('input', { id, type: 'checkbox', checked: easy, onChange: (e) => {
        const on = e.target.checked;
        easyPref.set(prefKey, on);
        if (st.wk) {
          st.wk.easy_choice = on;
          st.wk.easy_day = on;
          st.easy = on;
          touched({ force: true }); // the prescription changed: re-stamp every entry's `planned`
        }
        ctx.rerender();
      } }),
      h('label', { for: id }, 'Easy-day adjustments: halve the sets, Zone 2 only, no intervals, hold loads')),
    choice !== null && choice !== auto ? h('p', { class: 'small muted easy-why' }, `${choice ? 'You switched easy-day mode on.' : 'You switched easy-day mode off.'} Today’s readiness ${auto ? 'suggests' : 'doesn’t call for'} an easy day.`)
      : auto ? h('p', { class: 'small muted easy-why' }, 'On because today’s readiness is amber.') : null);
  }
  if (r.level === 'unknown' && date === ctx.today) readyBox.append(h('p', { class: 'small', style: { 'margin-top': '8px' } }, h('a', { href: '#/checkin' }, 'Do your check-in first')));
  page.append(readyBox);

  // PM7: alternates for a bad day (never on a red day)
  const plannedMain = plan.sessions.find((e) => e.source === 'template' && !e.isRest);
  const addonSession = (program?.addons || []).some((a) => a && a.session === sid);
  // Not on a finished log, and not on an add-on (it doesn't stand in for the day's session).
  if (!red && program && st.wk?.status !== 'done' && !addonSession && (alt.short || alt.travel) && (plannedMain || sid === alt.short || sid === alt.travel)) {
    const onAlt = sid === alt.short || sid === alt.travel;
    const walkDay = plannedMain?.session?.type === 'hike';
    page.append(h('div', { class: 'alt-row no-print' },
      onAlt && plannedMain ? h('a', { class: 'btn btn-sm', href: `#/train/${date}/${encodeURIComponent(plannedMain.sessionId)}` }, `Back to the plan: ${plannedMain.session?.name || sessionName(plannedMain.sessionId)}`) : null,
      !onAlt && alt.short ? h('a', { class: 'btn btn-sm', href: `#/train/${date}/${encodeURIComponent(alt.short)}` }, walkDay ? 'Short on time? The 30-minute minimum counts today' : 'Short on time? Do the minimum session') : null,
      !onAlt && alt.travel && !walkDay ? h('a', { class: 'btn btn-sm', href: `#/train/${date}/${encodeURIComponent(alt.travel)}` }, 'Gym closed? Bodyweight session') : null,
      onAlt ? h('p', { class: 'small muted' }, 'Logging this counts as today’s session done, not as the planned strength session.') : null));
  }

  if (red && date === ctx.today && !st.wk && !recordMode.has(prefKey)) {
    page.append(h('div', { class: 'sheet sheet-tight red-record no-print' },
      h('p', null, 'Nothing starts today. If you trained earlier, before the red flag, you can still record it.'),
      h('div', { class: 'row', style: { 'margin-top': '10px' } },
        h('button', { type: 'button', class: 'btn btn-sm', disabled: true, 'aria-describedby': 'red-why' }, 'Start session'),
        h('button', { type: 'button', class: 'btn btn-sm btn-ghost', onClick: () => { recordMode.add(prefKey); ctx.rerender(); } }, 'Record something I did earlier')),
      h('p', { class: 'visually-hidden', id: 'red-why' }, 'Disabled: red readiness today.')));
    return page;
  }

  if ((session && session.type === 'rest') || isRestId(sid)) {
    if (!blocks.length) {
      page.append(emptyState({ title: 'This is a rest day.', body: 'Rest is part of the plan. If you went for a walk or did extra mobility, log it as an ad-hoc session.', action: h('a', { class: 'btn', href: `#/train/${date}/adhoc` }, 'Log an ad-hoc session') }));
      return page;
    }
    page.append(h('p', { class: 'notice notice-accent train-note' }, 'Rest day: everything here is optional. Tired or sore? Skip the walk and just do the mobility.'));
  }

  // ---------------------------------------------------------------- session tools: clock, progress, copy last, sheet entry
  const sheetOn = sheetMode.has(prefKey);
  const clockOut = h('span', { class: 'clock', 'aria-live': 'off' }, '0:00');
  const clockBtn = h('button', { type: 'button', class: 'btn btn-sm' }, icon('clock', 16), 'Start the clock');
  const progressOut = h('p', { class: 'session-progress', 'aria-live': 'polite' });
  const tickClock = () => {
    const s0 = st.wk?.started_at ? Date.parse(st.wk.started_at) : null;
    if (!s0) { clockOut.textContent = '0:00'; clockBtn.hidden = st.recordOnly; return; }
    clockBtn.hidden = true;
    clockOut.textContent = fmtDuration((Date.now() - s0) / 1000);
  };
  clockBtn.addEventListener('click', () => { ensure().started_at = nowIso(); touched(); tickClock(); });
  st.startClock = () => { if (st.recordOnly) return; const w = ensure(); if (!w.started_at) { w.started_at = nowIso(); tickClock(); } };
  const countDone = () => {
    let done = 0;
    let total = 0;
    descs.forEach((bd) => {
      const { rb } = bd;
      if (rb.kind === 'unknown') return;
      total += 1;
      if (rb.kind === 'cardio' || rb.kind === 'intervals' || rb.kind === 'circuit') {
        const e = findEntry(st.wk?.cardio, bd.key, bd.legacy, rb.exercise);
        if (e && (isNum(e.minutes) || isNum(e.rounds))) done += 1;
      } else {
        const e = findEntry(st.wk?.exercises, bd.key, bd.legacy, rb.exercise);
        const n = isPhysioBlock(rb) ? 1 : (rxFor(st, bd, e)?.sets || rb.sets || 1);
        if (e && e.sets.filter((x) => x.done).length >= n) done += 1;
      }
    });
    return { done, total };
  };
  const drawProgress = () => {
    const { done, total } = countDone();
    progressOut.textContent = total ? `${done} of ${total} ${total === 1 ? 'block' : 'blocks'} done` : '';
  };
  st.progressHooks.push(drawProgress);
  const prevW = lastSameSession(data, sid, date, st.wk?.id);
  const copyBtn = prevW && !hasValues(st.wk) && st.wk?.status !== 'done'
    ? h('button', { type: 'button', class: 'btn btn-sm', onClick: () => copyLast(st, prevW) }, icon('copy', 16), `Copy numbers from ${fmtDay(prevW.date)}`)
    : null;
  const hasSetWork = blocks.some((b) => b.kind === 'strength' || b.kind === 'timed' || b.kind === 'cardio' || b.kind === 'intervals' || b.kind === 'circuit')
    || (st.wk?.exercises || []).some((x) => x.extra) || (st.wk?.cardio || []).some((x) => x.extra);
  const sheetBtn = hasSetWork ? h('button', { type: 'button', class: ['btn', 'btn-sm', sheetOn && 'btn-primary'], 'aria-pressed': String(sheetOn), onClick: () => {
    if (sheetOn) sheetMode.delete(prefKey); else sheetMode.add(prefKey);
    ctx.rerender();
  } }, icon('grid', 16), 'Enter from sheet') : null;
  // Round 4 (finding 3): "Go to the next set" now sits in a dock above the tab bar (built below),
  // in reach of the right thumb; the rest dock takes its place while a rest runs.
  if (st.wk?.status !== 'done') {
    const t = setInterval(tickClock, 1000);
    cleanups.push(() => clearInterval(t));
    tickClock();
    page.append(h('div', { class: 'sheet sheet-tight session-tools no-print' },
      st.recordOnly ? null : h('div', { class: 'session-clock' }, clockOut, clockBtn),
      progressOut,
      copyBtn, sheetBtn));
  } else {
    page.append(h('div', { class: 'session-tools-done no-print' }, progressOut, sheetBtn));
  }
  drawProgress();

  // ---------------------------------------------------------------- routines
  // BT1-15: on a phone the warm-up's moves fold away, so the first set is near the top.
  const routineBox = (id, label, key) => {
    const rt = routineFor(id);
    if (!rt) return null;
    const cid = uid('rt');
    const items = Array.isArray(rt.items) ? rt.items.filter((it) => it && typeof it.exercise === 'string') : [];
    const list = items.length ? h('ul', { class: 'routine-items' }, items.map((it) => {
      const locked = isLocked(it.exercise, date, data);
      return h('li', null, h('span', null, exerciseButton(it.exercise, ctx), locked ? ' (locked: skip it)' : !isAvailable(it.exercise, data) ? ' (not at your gym: skip it)' : null), h('span', { class: 'dose' }, gateText(it.dose || '')));
    })) : null;
    return h('div', { class: 'routine' },
      h('div', { class: 'row-between' },
        h('h2', { class: 'mini-title', style: { margin: 0 } }, `${label}: ${rt.name || id}${isNum(rt.minutes) ? `, about ${rt.minutes} min` : ''}`),
        h('div', { class: 'check check-lg' },
          h('input', { id: cid, type: 'checkbox', checked: !!st.wk?.[key], onChange: (e) => { ensure()[key] = e.target.checked; touched(); } }),
          h('label', { for: cid }, 'Done'))),
      list || rt.notes ? h('details', { class: 'disclose routine-fold', open: !small && !st.wk?.[key] }, h('summary', null, items.length ? `The ${items.length} moves` : 'How to do it'),
        list, rt.notes ? h('p', { class: 'small muted', style: { 'margin-top': '6px' } }, gateText(rt.notes)) : null) : null);
  };
  if (session?.warmup) page.append(routineBox(session.warmup, 'Warm-up', 'warmup_done'));

  // ---------------------------------------------------------------- blocks (or the sheet-entry grid)
  const extras = [...(st.wk?.exercises || []), ...(st.wk?.cardio || [])].filter((x) => x.extra);
  if (sheetOn) {
    page.append(sheetEntry(st, extras));
  } else {
    const blockHost = h('div', { class: 'blocks' });
    page.append(blockHost);
    const names = blocks.map((b) => (b.kind === 'circuit' ? 'the circuit' : exName(b.exercise)));
    descs.forEach((bd, i) => blockHost.append(renderBlock(st, bd, { n: i + 1, of: blocks.length, nextName: names[i + 1] || null }, cleanups)));
    for (const e of extras) blockHost.append(renderExtra(st, e, cleanups));
    if (!blocks.length && !extras.length) {
      blockHost.append(emptyState({ title: session ? 'This session has no exercises listed yet.' : 'Add your first exercise.', body: 'Use the picker below. Locked exercises are hidden until your clinic clears them.' }));
    }
  }

  // add exercise (SPEC 5.2 round 4: only what this phase allows, never above your clearances or your gym)
  const pick = content.exercises.filter((ex) => allowed(st, ex.id));
  const byCat = new Map();
  for (const ex of pick) {
    const c = categoryLabel(ex.category);
    if (!byCat.has(c)) byCat.set(c, []);
    byCat.get(c).push({ value: ex.id, label: ex.name });
  }
  let chosen = '';
  const addRow = h('div', { class: 'sheet sheet-tight no-print add-ex' },
    fasting ? h('p', { class: 'small muted', style: { 'margin-bottom': '8px' } }, 'Fasting period: no new lifts. Add only exercises you already know.') : null,
    h('div', { class: 'train-bar', style: { 'margin-bottom': 0 } },
      selectField({ label: 'Add an exercise', value: '', cls: 'field-grow', options: [{ value: '', label: pick.length ? 'Choose from the library' : 'Library not loaded yet' }, ...[...byCat.entries()].sort().map(([g, o]) => ({ group: g, options: o }))], onChange: (v) => { chosen = v; } }),
      h('button', { type: 'button', class: 'btn', onClick: () => {
        if (!chosen) { toast('Choose an exercise first.'); return; }
        if (!allowed(st, chosen)) {
          const why = typeof whyNotAllowed === 'function' ? whyNotAllowed(chosen, date, data, { sessionId: st.addonGate ? sid : null }) : null;
          toast(why === 'locked' ? `Locked until “${gateLabel(gateOf(chosen))}” is recorded.` : why === 'unavailable' ? 'Not available at your gym (Settings, “My gym”).' : why === 'phase' ? 'Not in this phase yet: it opens with a later phase.' : 'That exercise isn’t open to you in this phase.');
          return;
        }
        const w = ensure();
        const ex = content.exById.get(chosen);
        const key = `x${Date.now().toString(36)}`;
        const rx = prescriptionFor(chosen);
        if (CARDIO_ID.test(chosen) || rx?.kind === 'cardio') w.cardio.push({ block: key, extra: true, exercise: chosen, minutes: null, zone: 'Z2', avg_hr: null, distance_km: null, ascent_m: null, level: null, notes: '' });
        else {
          const eff = effectiveRx(rx, { override: plan.override, easyDay: st.easy });
          w.exercises.push({ block: key, extra: true, exercise: chosen, sets: Array.from({ length: eff?.sets || 2 }, blankSet), notes: '' });
        }
        touched();
        toast(`Added ${ex?.name || exName(chosen)}`);
        ctx.rerender();
      } }, icon('plus', 16), 'Add')),
    h('p', { class: 'field-hint', style: { 'margin-top': '6px' } }, 'Only exercises this phase allows, that your clearances and your gym allow, are listed.'));
  page.append(addRow);

  if (session?.cooldown) page.append(routineBox(session.cooldown, 'Cool-down', 'cooldown_done'));

  // ---------------------------------------------------------------- finish
  page.append(renderFinish(st));

  // ---------------------------------------------------------------- the next-set dock (finding 3)
  if (hasSetWork && !sheetOn && !st.done()) {
    const main = h('span', { class: 'nd-main' });
    const sub = h('span', { class: 'nd-sub' });
    const dockBtn = h('button', { type: 'button', class: 'next-dock-btn', onClick: () => {
      const t = nextTarget(document);
      if (t) goToSet(t); else goToFinish();
    } }, waymark(26), h('span', { class: 'nd-text' }, main, h('span', { class: 'visually-hidden' }, ': '), sub));
    const dock = h('div', { class: 'next-dock no-print', role: 'region', 'aria-label': 'Next set' }, dockBtn);
    // Like "jump to latest" in a chat: the dock steps aside while what it points at is already in
    // view above the tab bar, so it never sits on the tick you're about to press.
    let io = null;
    const watch = (el) => {
      if (io) io.disconnect();
      io = null;
      dock.classList.remove('is-quiet');
      if (!el || typeof IntersectionObserver !== 'function') return;
      const bar = document.querySelector('.topbar');
      const tabs = document.querySelector('.tabbar');
      const top = bar && getComputedStyle(bar).display !== 'none' ? Math.max(0, bar.getBoundingClientRect().bottom) : 0;
      const bottom = tabs && getComputedStyle(tabs).display !== 'none' ? Math.max(0, window.innerHeight - tabs.getBoundingClientRect().top) : 0;
      io = new IntersectionObserver((entries) => {
        const e = entries[entries.length - 1];
        dock.classList.toggle('is-quiet', !!e && e.isIntersecting && e.intersectionRatio >= 0.99);
      }, { rootMargin: `-${Math.round(top)}px 0px -${Math.round(bottom)}px 0px`, threshold: [0, 0.99, 1] });
      io.observe(el);
    };
    cleanups.push(() => { if (io) io.disconnect(); io = null; });
    const drawDock = () => {
      const t = nextTarget(page);
      main.textContent = t ? (t.kind === 'set' ? 'Go to the next set' : 'Go to the next exercise') : 'Every set is ticked';
      sub.textContent = t ? t.label : 'Go to Finish to save the session';
      dock.dataset.state = t ? 'next' : 'finish';
      if (dock.isConnected) watch(t ? (t.row || t.focus || t.block) : page.querySelector('.finish .session-actions .btn-primary'));
    };
    let queued = false;
    st.progressHooks.push(() => {
      if (queued) return;
      queued = true;
      // After the row's own classes change (a tick updates the data, then the row).
      setTimeout(() => { queued = false; if (dock.isConnected) drawDock(); }, 0);
    });
    drawDock();
    page.append(dock);
    document.body.classList.add('has-next-dock');
    // Once the page is on screen, start watching what the dock points at.
    setTimeout(() => { if (dock.isConnected) drawDock(); }, 0);
    cleanups.push(() => document.body.classList.remove('has-next-dock'));
  }
  return page;
}

// ---------------------------------------------------------------- entries

/** The logged entry for a block (stable key, or an older positional key); created on demand. */
function entryFor(st, bd, kind, create) {
  const listName = kind === 'cardio' ? 'cardio' : 'exercises';
  const { rb } = bd;
  let e = findEntry(st.wk?.[listName], bd.key, bd.legacy, rb.exercise);
  if (e && create && !e.extra && e.block !== bd.key) e.block = bd.key; // upgrade an older positional key on write
  if (!e && create) {
    const w = st.ensure();
    if (kind === 'cardio') {
      e = { block: bd.key, exercise: rb.exercise || (rb.kind === 'circuit' ? 'circuit' : null), minutes: null, zone: rb.kind === 'intervals' ? (st.easy ? 'Z2' : (rb.intervals.work_zone || 'mixed')) : (rb.zone || 'Z2'), avg_hr: null, distance_km: null, ascent_m: null, level: null, notes: '' };
      if (rb.kind === 'circuit') { e.items = rb.circuit.items.map((it) => it.exercise); e.rounds = null; }
      if (rb.kind === 'intervals') e.rounds = null;
      w.cardio.push(e);
    } else {
      const rx = isPhysioBlock(rb) ? null : rxFor(st, bd, null);
      e = { block: bd.key, exercise: rb.exercise, sets: Array.from({ length: rx?.sets || rb.sets || 1 }, blankSet), notes: '' };
      w.exercises.push(e);
      const p = plannedOf(st, e);
      if (p) e.planned = p;
    }
  }
  return e;
}

// ---------------------------------------------------------------- copy last session

function copyLast(st, prevW) {
  const { descs, ctx } = st;
  const w = st.ensure();
  const before = JSON.parse(JSON.stringify(w.exercises));
  let copied = 0;
  descs.forEach((bd) => {
    const { rb } = bd;
    if (rb.kind !== 'strength' && rb.kind !== 'timed') return;
    if (isPhysioBlock(rb)) return;
    const src = (prevW.exercises || []).find((e) => e.block === bd.key && (e.exercise === rb.exercise || e.swapped_from === rb.exercise))
      || (prevW.exercises || []).find((e) => e.block === bd.legacy && e.exercise === rb.exercise)
      || (prevW.exercises || []).find((e) => e.exercise === rb.exercise);
    const sets = (src?.sets || []).filter((x) => isNum(x.kg) || isNum(x.reps) || isNum(x.seconds));
    if (!sets.length) return;
    const e = entryFor(st, bd, 'exercises', true);
    if (e.exercise !== rb.exercise) return;
    const n = rxFor(st, bd, e)?.sets || rb.sets || 1; // today's effective sets, not last time's
    e.sets = Array.from({ length: n }, (_, k) => {
      const from = sets[Math.min(k, sets.length - 1)];
      return { kg: isNum(from.kg) ? Number(from.kg) : null, reps: isNum(from.reps) ? Number(from.reps) : null, seconds: isNum(from.seconds) ? Number(from.seconds) : null, rir: null, done: false };
    });
    copied += 1;
  });
  if (!copied) { toast('Nothing to copy: last time had no numbers for these exercises.'); return; }
  st.touched();
  ctx.rerender();
  offerUndo(`train:${st.date}`, {
    message: `Copied ${copied} exercise${copied === 1 ? '' : 's'} from ${fmtDay(prevW.date)}. Tick each set as you do it.`,
    undo: () => { w.exercises = before; st.touched(); ctx.rerender(); },
  });
}

// ---------------------------------------------------------------- swaps

/** Opens the swap menu for a block. current: the exercise logged now; planned: the plan's. */
function openSwapMenu(st, bd, current) {
  const { ctx } = st;
  const { rb } = bd;
  const listName = rb.kind === 'cardio' ? 'cardio' : 'exercises';
  const opts = offerable(st, current);
  const planned = rb.exercise;
  const dlg = h('dialog', { class: 'modal swap-dialog', 'aria-labelledby': 'swap-title' });
  const prev = document.activeElement;
  const close = () => { dlg.close(); dlg.remove(); if (prev && prev.isConnected && prev.focus) prev.focus({ preventScroll: true }); };
  const choose = (id) => {
    close();
    const e = entryFor(st, bd, listName, true);
    if (swapMode(e, id) === 'extra') { addStandIn(st, bd, e, id, listName); return; }
    const wasEx = e.exercise;
    const wasFrom = e.swapped_from;
    const wasSets = Array.isArray(e.sets) ? JSON.parse(JSON.stringify(e.sets)) : null;
    const wasPlanned = e.planned ? { ...e.planned } : null;
    applySwap(e, planned, id);
    if (Array.isArray(e.sets) && listName === 'exercises') {
      // The new exercise brings its own number of sets (untouched rows only).
      const n = rxFor(st, bd, e)?.sets || e.sets.length;
      if (!e.sets.some((s) => s && s.done)) e.sets = Array.from({ length: n }, blankSet);
    }
    st.touched({ force: true });
    ctx.rerender();
    offerUndo(`train-block:${bd.key}`, {
      message: id === planned ? `Back to ${exName(planned)}` : `Swapped to ${exName(id)} for today`,
      undo: () => {
        e.exercise = wasEx;
        if (wasFrom) e.swapped_from = wasFrom; else delete e.swapped_from;
        if (wasSets) e.sets = wasSets;
        if (wasPlanned) e.planned = wasPlanned;
        st.touched({ force: true });
        ctx.rerender();
      },
    });
  };
  const doseOf = (id) => { const rx = prescriptionFor(id); return rx ? rxText(rx) : ''; };
  const ticked = performedCount(entryFor(st, bd, listName, false));
  const group = (title, ids) => (ids.length ? h('div', { class: 'swap-group' },
    h('h3', { class: 'mini-title' }, title),
    h('ul', { class: 'swap-list' }, ids.map((id) => {
      const x = content.exById.get(id);
      const dose = doseOf(id);
      const kit = x?.equipment?.length ? String(x.equipment[0]).split(/\s*[(:]/)[0] : '';
      return h('li', null, h('button', { type: 'button', class: 'swap-option', onClick: () => choose(id) },
        h('span', { class: 'swap-name' }, x?.name || exName(id)),
        dose ? h('span', { class: 'swap-meta' }, dose) : null,
        kit ? h('span', { class: 'swap-meta swap-kit' }, kit) : null));
    }))) : null);
  const back = !ticked && current !== planned && allowed(st, planned)
    ? h('div', { class: 'swap-group' }, h('button', { type: 'button', class: 'btn btn-sm', onClick: () => choose(planned) }, icon('undo', 16), `Back to the plan: ${exName(planned)}`)) : null;
  dlg.append(h('div', { class: 'modal-body' },
    h('h2', { class: 'modal-title', id: 'swap-title' }, `Swap ${exName(current)}`),
    ticked
      ? h('div', { class: 'notice notice-warn swap-ticked', role: 'note' },
        h('p', null, h('strong', null, `${SWAP_TICKED_TEXT}.`)),
        h('p', null, listName === 'cardio'
          ? `You’ve logged ${exName(current)} already, and that stays as it is. Pick a stand-in below to add it as an extra exercise, starting fresh.`
          : `You’ve ticked ${ticked} set${ticked === 1 ? '' : 's'} of ${exName(current)}; they stay logged as ${exName(current)}. Pick a stand-in below to add it as an extra exercise, starting fresh with its own sets. Or untick your sets first to swap the whole exercise.`))
      : h('p', { class: 'modal-text' }, 'Kit busy or missing? Pick a stand-in for today. Only exercises this phase allows, that your clearances and your gym allow, are listed. The stand-in brings its own sets and dose, and the swap is saved with this session.'),
    back,
    group('Easier versions', opts.easier),
    group('Harder versions', opts.harder),
    group(`Other ${categoryLabel(content.exById.get(current)?.category).toLowerCase()} exercises`, opts.similar),
    hasSwaps(opts) ? null : h('p', { class: 'muted' }, 'No other exercises this phase allows fit here. Skip this one today, or add something from the library below.'),
    h('div', { class: 'modal-actions' }, h('button', { type: 'button', class: 'btn', onClick: close }, 'Cancel'))));
  dlg.addEventListener('cancel', (ev) => { ev.preventDefault(); close(); });
  dlg.addEventListener('click', (ev) => { if (ev.target === dlg) close(); });
  document.body.appendChild(dlg);
  dlg.showModal();
  dlg.querySelector('.swap-option, .btn')?.focus();
}

function swapButton(st, bd, current) {
  if (!current || current === PHYSIO_ID || st.done()) return null; // BT2-7: no swaps on a finished session
  const opts = offerable(st, current);
  const canGoBack = current !== bd.rb.exercise;
  if (!hasSwaps(opts) && !canGoBack) return null;
  return h('button', { type: 'button', class: 'btn btn-sm btn-quiet block-swap no-print', onClick: () => openSwapMenu(st, bd, current) }, icon('swap', 16), 'Swap');
}

// ---------------------------------------------------------------- plausibility hints ("675 kg: did you mean 67.5?")

/**
 * A live list of plausibility issues for one logged entry, under its inputs. kind: 'exercises' | 'cardio'.
 * fieldInput(field, setIndex) returns the input to fill when you accept a suggestion.
 */
function issueBox(st, kind, getEntry, fieldInput) {
  const box = h('div', { class: 'block-issues', 'aria-live': 'polite' });
  const draw = () => {
    const w = st.wk;
    const e = getEntry();
    if (!w || !e) { box.replaceChildren(); return; }
    const probe = { ...w, exercises: kind === 'exercises' ? [e] : [], cardio: kind === 'cardio' ? [e] : [] };
    let list = [];
    try { list = workoutIssues(probe, st.ctx.data); } catch { list = []; }
    list = list.filter((x) => String(x.field || '').startsWith(`${kind}[0]`));
    box.replaceChildren(...list.slice(0, 4).map((x) => {
      const m = /sets\[(\d+)\]\.(kg|reps|seconds|rir)$/.exec(x.field || '') || /cardio\[0\]\.([a-z_]+)$/.exec(x.field || '');
      const setIdx = m && m.length === 3 ? Number(m[1]) : null;
      const fieldName = m ? m[m.length - 1] : null;
      const text = String(x.message || '').replace(/^[^,:]+, (set \d+:)/, (all, p1) => p1.charAt(0).toUpperCase() + p1.slice(1)).replace(/^[a-z0-9-]+: /, '');
      const input = fieldName ? fieldInput(fieldName, setIdx) : null;
      return h('p', { class: 'field-issue', dataset: { level: x.level } }, h('span', null, text),
        isNum(x.suggestion) && input ? h('button', { type: 'button', class: 'btn btn-sm', onClick: () => {
          input.value = String(x.suggestion);
          input.dispatchEvent(new Event('input', { bubbles: true }));
          input.focus();
        } }, `Use ${x.suggestion}`) : null);
    }));
  };
  const later = debounce(draw, 450);
  return { el: box, draw, later };
}

// ---------------------------------------------------------------- strength & timed

/** BT2-7: sets logged before a clearance was removed, shown as they were, with no inputs. */
function loggedReadOnly(entry, { cardio = false } = {}) {
  if (cardio) {
    const bits = [isNum(entry?.minutes) ? `${entry.minutes} min` : '', isNum(entry?.avg_hr) ? `${entry.avg_hr} bpm` : '', isNum(entry?.distance_km) ? `${entry.distance_km} km` : '', isNum(entry?.rounds) ? `${entry.rounds} rounds` : ''].filter(Boolean);
    if (!bits.length) return null;
    return h('div', { class: 'logged-readonly' }, h('p', { class: 'small' }, h('strong', null, 'Logged: '), bits.join(', ')),
      h('p', { class: 'small muted' }, 'Logged before the clearance was removed. Kept as it was; it can’t be changed here.'));
  }
  const sets = (Array.isArray(entry?.sets) ? entry.sets : []).filter(setHasValues);
  if (!sets.length) return null;
  return h('div', { class: 'logged-readonly' },
    h('table', { class: 'set-table set-table-readonly' },
      h('caption', { class: 'visually-hidden' }, `${exName(entry.exercise)}: sets logged before the clearance was removed`),
      h('thead', null, h('tr', null, h('th', { scope: 'col' }, 'Set'), h('th', { scope: 'col' }, 'Logged'), h('th', { scope: 'col', class: 'set-done' }, 'Done'))),
      h('tbody', null, sets.map((x, i) => h('tr', { class: x.done ? 'is-done' : null },
        h('td', { class: 'set-n' }, String(i + 1)), h('td', null, setText(x) || '–'), h('td', { class: 'set-done' }, x.done ? 'Yes' : 'No'))))),
    h('p', { class: 'small muted' }, 'Logged before the clearance was removed. Kept as it was; it can’t be changed here.'));
}

/** Locked (not cleared, or not in the library) or not available at your gym: say why and offer stand-ins. */
function blockedPanel(st, bd, why, entry = null) {
  const { ctx } = st;
  const { rb } = bd;
  const listName = rb.kind === 'cardio' ? 'cardio' : 'exercises';
  const shownId = entry?.exercise && entry.exercise !== 'circuit' ? entry.exercise : rb.exercise;
  const known = content.exById.has(shownId);
  const logged = why === 'locked' && entry ? loggedReadOnly(entry, { cardio: listName === 'cardio' }) : null;
  // BT2-7: a finished session, or sets already logged, get no "do this instead today" chips.
  const offer = !logged && !st.done();
  const opts = offer ? offerable(st, rb.exercise) : { easier: [], harder: [], similar: [] };
  const ids = [...opts.easier, ...opts.similar, ...opts.harder];
  const lead = why === 'unavailable'
    ? [h('strong', null, 'Not available at your gym. '), `${exName(rb.exercise)} needs kit your gym doesn’t have (Settings, “My gym”).`]
    : logged
      ? [h('strong', null, 'Locked now. '), `${exName(shownId)} needs “${gateLabel(gateOf(shownId))}”, which is no longer recorded.`]
      : known
        ? [h('strong', null, 'Locked. '), `${exName(shownId)} needs “${gateLabel(gateOf(shownId))}”. Don’t do it until your clinic or physio clears it, then record the date on the Your arm page.`]
        : [h('strong', null, 'Locked. '), `${exName(shownId)} isn’t in the exercise library, so the hub can’t check it’s safe. Skip it, or do one of these instead.`];
  return h('div', { class: ['notice', why === 'unavailable' ? 'notice-quiet' : 'notice-locked', 'locked-panel'] },
    h('p', null, lead),
    logged,
    logged ? null : !offer ? h('p', { class: 'small' }, 'Nothing was logged for it in this session.')
      : ids.length
        ? h('div', { class: 'locked-swaps' }, h('p', { class: 'small' }, 'Do one of these instead today:'),
          h('div', { class: 'chip-row' }, ids.map((id) => h('button', { type: 'button', class: 'chip chip-btn chip-lg', onClick: () => {
            const e = entryFor(st, bd, listName, true);
            if (swapMode(e, id) === 'extra') { addStandIn(st, bd, e, id, listName); return; }
            applySwap(e, rb.exercise, id);
            if (listName === 'exercises') {
              const n = rxFor(st, bd, e)?.sets || e.sets.length;
              if (!e.sets.some((s) => s && s.done)) e.sets = Array.from({ length: n }, blankSet);
            }
            st.touched({ force: true });
            ctx.rerender();
          } }, exName(id)))))
        : h('p', { class: 'small' }, 'Skip this block today.'));
}

/** The rehab add-on's single placeholder block: your physio's own programme. */
function renderPhysioBlock(st, bd, n) {
  const { ctx, date } = st;
  const { rb } = bd;
  const open = !isLocked(PHYSIO_ID, date, ctx.data) && !st.red;
  const total = (rb.seconds || 0) * (rb.sets || 1);
  const entry = entryFor(st, bd, 'exercises', false);
  const s0 = entry?.sets?.[0] || null;
  const list = ctx.data.arm.physio_exercises || [];
  const setFirst = (patch) => {
    const e = entryFor(st, bd, 'exercises', true);
    e.sets = [{ kg: null, reps: null, rir: null, seconds: total || null, done: false, ...(e.sets[0] || {}), ...patch }];
    st.touched();
  };
  const id = uid('pp');
  return h('section', { class: ['block', !open && 'is-locked'], 'aria-label': `Block ${n}: your physio’s programme`, dataset: { fscope: bd.key, name: 'Your physio’s programme', kind: 'physio' } },
    h('p', { class: 'block-num' }, `Block ${n}`),
    h('h2', { class: 'block-title' }, 'Your physio’s programme'),
    h('div', { class: 'spec' }, total ? chip(fmtSecs(total)) : null, chip('As prescribed by your physio', 'chip-accent')),
    h('p', { class: 'block-note' }, 'Do your physio’s exercises exactly as prescribed. They are often little and often through the day, so they don’t have to be part of your gym session. Anything your physio says overrides this programme.'),
    rb.notes ? h('p', { class: 'block-note' }, gateText(rb.notes)) : null,
    st.red ? h('p', { class: 'notice notice-bad small', style: { 'margin-top': '10px' } }, 'Red today: no physio exercises either, until you’ve been advised.') : null,
    !st.red && !open ? h('p', { class: 'notice notice-locked small', style: { 'margin-top': '10px' } }, `This starts once “${gateLabel(gateOf(PHYSIO_ID))}” is recorded on the Your arm page.`) : null,
    list.length
      ? h('ul', { class: 'circuit-items' }, list.map((p) => h('li', null,
        h('span', null, content.exById.has(p.exercise) ? exerciseButton(p.exercise, ctx) : (p.exercise || 'Exercise')),
        h('span', { class: 'muted' }, p.dose || ''))))
      : h('p', { class: 'small muted', style: { 'margin-top': '10px' } }, 'Waiting for your physio’s programme. Add their exercises on the Your arm page.'),
    h('p', { class: 'small', style: { 'margin-top': '8px' } }, h('a', { href: '#/arm' }, list.length ? 'Edit your physio exercises on the Your arm page' : 'Add your physio exercises on the Your arm page')),
    open ? h('div', { class: 'row', style: { 'margin-top': '12px', 'align-items': 'flex-end', gap: '20px' } },
      h('div', { class: 'check check-lg', style: { 'padding-bottom': '9px' } },
        h('input', { id, type: 'checkbox', checked: !!s0?.done, onChange: (e) => setFirst({ done: e.target.checked }) }),
        h('label', { for: id }, 'Done today')),
      h('div', { style: { width: '170px' } }, numberField({ label: 'Time', unit: 'min', value: s0 && isNum(s0.seconds) ? Math.round(s0.seconds / 60) : (total ? Math.round(total / 60) : null), min: 0, step: 1, onInput: (v) => setFirst({ seconds: isNum(v) ? v * 60 : null }) }))) : null);
}

/**
 * The last time this exercise was logged, for "Last time" and the suggestion. The session and
 * block are passed so a per-block baseline (SPEC 5.2 round 4) can be preferred where stats.js
 * supports it; older stats.js ignores the extra argument.
 */
function lastFor(st, bd, exId, rx) {
  if (!exId) return null;
  const timed = rx?.kind === 'timed';
  try {
    return lastPerformance(st.ctx.data, exId, st.date, st.wk?.id, {
      program: content.program, sessionId: st.sid === 'adhoc' ? null : st.sid, blockKey: bd.extra ? null : bd.key,
      reps: timed ? null : rx?.reps ?? null, seconds: timed ? rx?.seconds ?? null : null,
    });
  } catch { return null; }
}

/** The suggestion (or hold) for a block, from features/safety.js. */
function suggestionFor(st, rx, exId, ex, last) {
  if (rx.kind !== 'strength' || rx.load !== 'double-progression' || !parseRepRange(rx.reps)) return null;
  const prog = (ex?.progressions || []).find((id) => allowed(st, id));
  return progressionFor({
    reps: rx.reps, lastSets: last?.sets || [], increment: incrementFor(exId, ex, content.program?.rules),
    progressionName: prog ? exName(prog) : '', hold: st.hold,
    // BT1-1: judged against LAST time's effective planned sets, never today's raw block sets.
    setsPlanned: lastPlannedSets(content.program, st.ctx.data, last, exId),
  });
}

function renderBlock(st, bd, pos, cleanups) {
  const { ctx, date } = st;
  const { rb, key } = bd;
  const { n, of, nextName } = pos;
  if (rb.kind === 'cardio' || rb.kind === 'intervals' || rb.kind === 'circuit') return renderCardioBlock(st, bd, n, cleanups);
  if (isPhysioBlock(rb)) return renderPhysioBlock(st, bd, n);
  const entry = entryFor(st, bd, 'exercises', false);
  const exId = entry?.exercise || rb.exercise;
  const ex = content.exById.get(exId);
  const swapped = !bd.extra && !!entry?.swapped_from && exId !== rb.exercise;
  const lockedPlan = isLocked(rb.exercise, date, ctx.data);
  const unavailablePlan = !isAvailable(rb.exercise, ctx.data);
  const blocked = swapped ? (isLocked(exId, date, ctx.data) ? 'locked' : null) : lockedPlan ? 'locked' : unavailablePlan ? 'unavailable' : null;
  const titleId = uid('blk');
  const box = h('section', { class: ['block', blocked && 'is-locked'], 'aria-labelledby': titleId, dataset: { fscope: key, name: exId ? exName(exId) : 'Exercise', kind: 'sets' } });
  if (rb.kind === 'unknown') {
    box.append(h('p', { class: 'block-num' }, `Block ${n}`), h('p', null, gateText(rb.notes) || 'This block has an unrecognised format.'));
    return box;
  }
  const rx = rxFor(st, bd, entry);
  const timed = rx.kind === 'timed';
  const progress = h('span', { class: 'block-progress' });
  box.append(h('div', { class: 'block-head' },
    h('div', { class: 'block-head-text' },
      h('p', { class: 'block-num' }, typeof n === 'number' ? `Exercise ${n} of ${of}` : 'Added exercise', progress),
      h('h2', { class: 'block-title', id: titleId }, exId ? exerciseButton(exId, ctx) : 'Exercise'),
      swapped ? h('p', { class: 'swap-note' }, `Swapped in for ${exName(entry.swapped_from)} today, with its own sets and dose.`) : null),
    blocked ? null : swapButton(st, bd, exId)));
  const spec = [chip(`${rx.sets} ${rx.sets === 1 ? 'set' : 'sets'}`)];
  if (timed) spec.push(chip(`${isNum(rx.seconds) ? fmtSecs(rx.seconds) : '?'}${rx.per_side ? ' / side' : ''}`));
  else if (rx.reps) spec.push(chip(`${dash(rx.reps)} ${rx.unit === 'm' ? 'm' : rx.unit === 'steps' ? 'steps' : 'reps'}${rx.per_side ? ' / side' : ''}`));
  if (rx.rir) spec.push(chip(`RIR ${dash(rx.rir)}`));
  if (isNum(rx.rest_s)) spec.push(chip(`Rest ${fmtDuration(rx.rest_s)}`));
  if (rx.tempo) spec.push(chip(`Tempo ${rx.tempo}`));
  if (rx.load === 'bodyweight') spec.push(chip('Bodyweight'));
  if (rx.load === 'physio') spec.push(chip('As prescribed by your physio', 'chip-accent'));
  if (rx.loaded && rx.load !== 'bodyweight') spec.push(chip('Loaded: log the kg'));
  box.append(h('div', { class: 'spec' }, spec));
  if (rx.load === 'physio') box.append(h('p', { class: 'adjust-note' }, 'Only as prescribed by your physio. Replace these doses with theirs.'));
  if (rx.setsNote && rx.setsPlanned !== rx.sets) box.append(h('p', { class: 'adjust-note' }, `${rx.own ? 'Its usual dose is' : 'Planned'} ${rx.setsPlanned} ${rx.setsPlanned === 1 ? 'set' : 'sets'}: ${rx.setsNote}.`));
  if (rx.own) {
    // BT1-3: a stand-in shows its own dose and cues, not the planned exercise's notes.
    if (ex?.dose) box.append(h('p', { class: 'block-note' }, h('strong', null, 'Usual dose: '), gateText(ex.dose)));
    const cues = Array.isArray(ex?.cues) ? ex.cues.filter((c) => typeof c === 'string' && c).slice(0, 4) : [];
    if (cues.length) box.append(h('ul', { class: 'block-cues', 'aria-label': `${exName(exId)}: coaching cues` }, cues.map((c) => h('li', null, gateText(c)))));
  } else if (rb.notes) box.append(blockNote(gateText(rb.notes)));
  if (blocked) { box.append(blockedPanel(st, bd, blocked, entry), undoSlot(`train-block:${key}`)); return box; }

  const last = lastFor(st, bd, exId, rx);
  if (last && last.sets.length) box.append(h('p', { class: 'last-time' }, h('span', { class: 'muted' }, `Last time, ${fmtDay(last.date)}: `), last.sets.map(setText).filter(Boolean).join(', ')));
  const suggestion = suggestionFor(st, rx, exId, ex, last);
  if (suggestion?.text) box.append(h('p', { class: ['suggest', suggestion.kind === 'hold' && 'suggest-hold'] }, suggestion.text));
  else if (st.hold && rx.kind === 'strength' && rx.load === 'double-progression') box.append(h('p', { class: 'suggest suggest-hold' }, 'Hold: same load, RIR 3–4.'));
  const loaded = rx.loaded && rx.load !== 'bodyweight' && rx.load !== 'physio';
  const showKg = loaded || (entry?.sets || []).some((x) => isNum(x.kg)) || (last?.sets || []).some((x) => isNum(x.kg));
  const exLabel = exName(exId);
  const plateLoaded = isPlateLoaded(ex || exId);
  const count = rowCount(st, bd, entry, rx);
  // Round 4 (finding 5): per set from last time's matching set, within today's planned RIR.
  const lastRir = last?.prescription?.rir || last?.entry?.planned?.rir || null;
  const targets = setTargets({ kind: timed ? 'timed' : 'strength', reps: rx.reps, seconds: rx.seconds, count: count + 4, lastSets: last?.sets || [], suggestion, showKg, rir: rx.rir, lastRir });
  const prefillNote = uid('pf');
  const mainHead = timed ? ['Seconds', 'Secs'] : rx.unit === 'm' ? ['Metres', 'm'] : rx.unit === 'steps' ? ['Steps', 'Steps'] : ['Reps', 'Reps'];
  // Finding 7: short headers on a phone (the full words stay for screen readers).
  const head = (long, short, cls = null) => h('th', { scope: 'col', class: cls },
    short && short !== long ? [h('span', { class: 'th-long' }, long), h('span', { class: 'th-short', 'aria-hidden': 'true' }, short)] : long);

  const table = h('table', { class: ['set-table', !showKg && 'no-kg', timed && 'is-timed'] },
    h('caption', { class: 'visually-hidden' }, `${exLabel} sets`),
    h('thead', null, h('tr', null,
      head('Set', '#', 'set-n-h'),
      showKg ? head('kg', null, 'set-kg-h') : null,
      head(rx.per_side ? `${mainHead[0]} / side` : mainHead[0], rx.per_side ? `${mainHead[1]}/side` : mainHead[1], 'set-main-h'),
      timed ? null : head('RIR', null, 'set-rir-h'),
      head('Done', null, 'set-done'))));
  const tbody = h('tbody');
  table.append(tbody);
  const rows = [];
  const live = () => entryFor(st, bd, 'exercises', false);
  const getEntry = () => entryFor(st, bd, 'exercises', true);
  const rowsNow = () => rows.length;
  const allDoneBtn = h('button', { type: 'button', class: 'btn btn-sm' });
  const drawAllDone = () => {
    const todo = rows.filter((r) => !r.isDone());
    const shown = todo.map((r) => r.values());
    const what = setsSummary(shown);
    const miss = todo.map((r) => missingOf(r.values())).find(Boolean);
    // "Says exactly what it records" (BT1-2): the sets still to tick, as their boxes show them now,
    // or what's still needed first (loaded work needs its kg).
    const lead = todo.length === rows.length ? 'All sets done' : `Tick the other ${todo.length}`;
    replaceKids(allDoneBtn, icon('checks', 16), !todo.length ? 'All sets done' : miss ? `${lead}: type the ${miss} first` : `${lead}: record ${what}`);
    allDoneBtn.disabled = !todo.length;
  };
  const drawProgress = () => {
    const e = live();
    const done = (e?.sets || []).slice(0, rows.length).filter((x) => x.done).length;
    progress.textContent = done ? `, ${done} of ${rows.length} done` : '';
    box.classList.toggle('is-complete', rows.length > 0 && done >= rows.length);
    drawAllDone();
  };
  /**
   * Moves focus to the next set to do (this block, then the next block) when a rest ends or is
   * skipped. Round 4 (finding 12): the set's tick, never its kg box, so the keyboard stays shut.
   */
  const focusNextSet = (k) => {
    const ae = document.activeElement;
    if (ae && ae !== document.body && !ae.closest('.rest-dock') && !rows.some((r) => r.check === ae)) return;
    const next = rows.slice(k + 1).find((r) => !r.isDone());
    if (next) { goToSet({ block: box, row: next.tr, focus: next.check }); return; }
    const later = nextTarget(document, box);
    if (later) goToSet(later);
  };
  /** What a row is missing before it can be ticked, or ''. Loaded work needs its kg (BT1-2). */
  const missingOf = (v) => {
    if (!setHasActual(v, timed)) return timed ? 'time' : rx.unit === 'm' ? 'distance' : 'reps';
    if (loaded && showKg && !isNum(v.kg)) return 'kg';
    return '';
  };
  /**
   * BT1-2: a ticked set's kg carries into the following sets that are still empty. Round 4: a
   * ramp keeps its shape (60, 70, 80 stays a ramp; ticking 62.5 moves the rest up 2.5).
   */
  const carryKg = (k, kgValue) => {
    if (!showKg || !isNum(kgValue)) return;
    const fromTarget = targets[k]?.kg ?? null;
    for (const r of rows.slice(k + 1)) {
      if (r.isDone() || !r.kg) continue;
      const i = rows.indexOf(r);
      const s = live()?.sets?.[i] || null;
      const typed = r.kg.dataset.typed === '1' || (s && isNum(s.kg));
      if (typed) continue;
      const v = carriedKg(targets[i]?.kg ?? null, fromTarget, kgValue);
      if (!isNum(v) || String(v) === r.kg.value) continue;
      r.kg.value = String(v);
      if (r.tr.classList.contains('is-planned')) { r.kg.classList.add('is-prefill'); r.kg.setAttribute('aria-describedby', prefillNote); }
      else r.kg.dispatchEvent(new Event('input')); // a row you've typed into keeps the kg too
    }
    drawAllDone();
  };
  const addRowEl = (k) => {
    const cur = () => live()?.sets?.[k] || null;
    const s0 = cur();
    const saved = !!s0 && (s0.done || isNum(s0.kg) || isNum(s0.reps) || isNum(s0.seconds));
    const t = targets[k] || targets[targets.length - 1] || {};
    const label = `${exLabel}, set ${k + 1}`;
    const fmtV = (v) => (isNum(v) ? String(v) : '');
    // A set below a ticked set shows its kg carried from it (a ramp keeps its shape).
    const above = rows.slice(0, k).reverse().find((r) => r.isDone() && isNum(parseNum(r.kg?.value)));
    const kgTarget = above && !saved ? carriedKg(t.kg, targets[rows.indexOf(above)]?.kg ?? null, parseNum(above.kg.value)) : t.kg;
    const kgVal = saved ? fmtV(s0.kg) : fmtV(kgTarget);
    const mainVal = saved ? fmtV(timed ? s0.seconds : s0.reps) : fmtV(timed ? t.seconds : t.reps);
    const tr = h('tr', { class: [s0?.done && 'is-done', !saved && 'is-planned'] });
    const markTyped = (input) => { input.classList.remove('is-prefill'); input.removeAttribute('aria-describedby'); };
    const setAt = (field, value) => {
      const e = getEntry();
      while (e.sets.length <= k) e.sets.push(blankSet());
      e.sets[k][field] = value;
      st.touched();
      issues.later();
    };
    const mk = (field, value, extra) => {
      const input = h('input', {
        type: 'text', class: ['input', !saved && value !== '' && 'is-prefill', extra.cls], inputmode: extra.inputmode || 'decimal', enterkeyhint: extra.enter || 'next', autocomplete: 'off',
        value, 'aria-label': `${label}: ${extra.aria}`, 'aria-describedby': !saved && value !== '' ? prefillNote : null, dataset: { fkey: `${bd.key}:${k}:${field}` },
        // Changing any number in a row that still shows targets records the whole row as shown,
        // so the other targets never silently disappear on the next re-render.
        onInput: (e) => { e.target.dataset.typed = '1'; markTyped(e.target); if (tr.classList.contains('is-planned')) commit(); else setAt(field, parseNum(e.target.value)); drawAllDone(); },
      });
      return selectOnFocus(input); // "12", type 11 -> 11, never "1112" (finding 4)
    };
    const kg = showKg ? mk('kg', kgVal, { aria: 'kilograms' }) : null;
    const main = timed ? mk('seconds', mainVal, { aria: 'seconds', inputmode: 'numeric' }) : mk('reps', mainVal, { aria: rx.unit === 'm' ? 'metres' : 'reps', inputmode: 'numeric' });
    const rir = timed ? null : mk('rir', saved ? fmtV(s0.rir) : '', { aria: 'reps in reserve', cls: 'input-rir', inputmode: 'numeric', enter: 'done' });
    const values = () => ({ kg: kg ? parseNum(kg.value) : null, reps: timed ? null : parseNum(main.value), seconds: timed ? parseNum(main.value) : null, rir: rir ? parseNum(rir.value) : null });
    /** Ticking records exactly what the row shows (PE5). */
    const commit = () => {
      const v = values();
      const e = getEntry();
      while (e.sets.length <= k) e.sets.push(blankSet());
      Object.assign(e.sets[k], { kg: v.kg, reps: v.reps, seconds: v.seconds, rir: v.rir });
      for (const inp of [kg, main, rir]) if (inp) markTyped(inp);
      tr.classList.remove('is-planned');
      st.touched();
      issues.later();
    };
    const check = h('button', { type: 'button', class: 'set-check', 'aria-pressed': String(!!s0?.done), 'aria-label': `${label} done`, dataset: { fkey: `${bd.key}:${k}:done` } }, icon('check', 22));
    const mark = (on, { rest = true } = {}) => {
      if (on) {
        const miss = missingOf(values());
        if (miss) {
          toast(miss === 'kg' ? 'Type the weight in kg, then tick the set.' : miss === 'time' ? 'Type how many seconds you held, then tick the set.' : `Type how many ${miss} you did, then tick the set.`);
          (miss === 'kg' ? kg : main)?.focus();
          return false;
        }
        commit();
        st.startClock();
      }
      setAt('done', on);
      tr.classList.toggle('is-done', on);
      check.setAttribute('aria-pressed', String(on));
      if (on) carryKg(k, values().kg);
      drawProgress();
      if (on && rest && !st.recordOnly && isNum(rx.rest_s) && rx.rest_s > 0) {
        const more = k + 1 < rowsNow();
        if (more || nextName) startRestDock({ seconds: rx.rest_s, title: `Rest: ${exLabel}`, next: more ? `Set ${k + 2} of ${rowsNow()}` : nextName, onClose: () => focusNextSet(k) });
      }
      if (!on) stopRestDock('untick');
      return true;
    };
    check.addEventListener('click', () => mark(check.getAttribute('aria-pressed') !== 'true'));
    for (const inp of [kg, main, rir]) {
      if (!inp) continue;
      inp.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter') return;
        e.preventDefault();
        const order = [kg, main, rir, check].filter(Boolean);
        order[order.indexOf(inp) + 1]?.focus();
      });
    }
    tr.append(h('td', { class: 'set-n' }, String(k + 1)), kg ? h('td', { class: 'set-kg' }, kg) : null, h('td', { class: 'set-main' }, main), rir ? h('td', { class: 'set-rir' }, rir) : null, h('td', { class: 'set-done' }, check));
    tbody.append(tr);
    rows.push({ tr, mark, isDone: () => check.getAttribute('aria-pressed') === 'true', kg, main, rir, check, values });
  };
  const issues = issueBox(st, 'exercises', live, (field, k) => {
    const r = rows[k];
    if (!r) return null;
    if (field === 'kg') return r.kg;
    if (field === 'rir') return r.rir;
    return r.main;
  });
  for (let k = 0; k < count; k++) addRowEl(k);
  const anyPlanned = rows.some((r) => r.tr.classList.contains('is-planned'));
  // Said once a page (it's the same for every block); later blocks keep a hidden copy for screen readers.
  const firstNote = anyPlanned && !st.prefillShown;
  if (anyPlanned) st.prefillShown = true;
  box.append(
    anyPlanned ? h('p', { class: ['prefill-note', !firstNote && 'visually-hidden'], id: prefillNote }, `The numbers in each set are your targets. Change them if you did something different; ticking a set records what it shows, and its kg carries into the sets after it.`) : null,
    h('div', { class: 'table-wrap' }, table), issues.el);
  issues.draw();

  allDoneBtn.addEventListener('click', () => {
    const before = JSON.parse(JSON.stringify(getEntry().sets));
    const todo = rows.filter((r) => !r.isDone());
    if (!todo.length) { toast('Every set is already ticked.'); return; }
    const missing = todo.map((r) => ({ r, miss: missingOf(r.values()) })).find((x) => x.miss);
    if (missing) {
      const k = rows.indexOf(missing.r) + 1;
      toast(missing.miss === 'kg' ? `Set ${k} has no weight yet. Type the kg first: loaded sets need it.` : `Set ${k} has no ${missing.miss} yet. Type it in first.`);
      (missing.miss === 'kg' ? missing.r.kg : missing.r.main)?.focus();
      return;
    }
    const recorded = todo.map((r) => r.values());
    todo.forEach((r) => r.mark(true, { rest: false }));
    offerUndo(`train-block:${key}`, {
      message: `Recorded ${todo.length} set${todo.length === 1 ? '' : 's'} of ${exLabel}: ${setsSummary(recorded)}.`,
      undo: () => { getEntry().sets = before; st.touched(); ctx.rerender(); },
    });
  });
  const rowKey = () => `${st.wk?.id || 'new'}|${key}`;
  const addSet = h('button', { type: 'button', class: 'btn btn-sm btn-ghost', onClick: () => {
    const e = getEntry();
    const k = rows.length;
    while (e.sets.length <= k) e.sets.push(blankSet());
    addedRows.set(rowKey(), Math.max(0, k + 1 - (rx.sets || 1)));
    st.touched();
    addRowEl(k);
    drawProgress();
    (rows[k].kg || rows[k].main).focus();
  } }, icon('plus', 16), 'Add a set');
  const removeSet = h('button', { type: 'button', class: 'btn btn-sm btn-ghost', onClick: () => {
    if (rows.length <= 1) { toast('Keep at least one set. Use Swap or skip the exercise instead.'); return; }
    const e = live();
    const k = rows.length - 1;
    const removed = e && e.sets.length > k ? JSON.parse(JSON.stringify(e.sets.slice(k))) : null;
    rows.pop().tr.remove();
    if (e && e.sets.length > rows.length) { e.sets.length = rows.length; st.touched(); }
    addedRows.set(rowKey(), Math.max(0, rows.length - (rx.sets || 1)));
    drawProgress();
    offerUndo(`train-block:${key}`, {
      message: `Set ${k + 1} removed`,
      undo: () => {
        const e2 = getEntry();
        if (removed) e2.sets.splice(k, 0, ...removed);
        else while (e2.sets.length <= k) e2.sets.push(blankSet());
        addedRows.set(rowKey(), Math.max(0, k + 1 - (rx.sets || 1)));
        st.touched();
        ctx.rerender();
      },
    });
  } }, icon('minus', 16), 'Remove the last set');
  const plates = plateLoaded && showKg ? h('button', { type: 'button', class: 'btn btn-sm btn-ghost', onClick: () => {
    const next = rows.find((r) => !r.isDone()) || rows[rows.length - 1];
    const start = parseNum(next?.kg?.value);
    openPlateCalc({
      total: start, data: ctx.data, title: `${exLabel}: plates`,
      onUse: (v) => { if (next?.kg) { next.kg.value = String(v); next.kg.dispatchEvent(new Event('input')); next.kg.focus(); } },
    });
  } }, icon('plates', 16), 'Plate maths') : null;
  box.append(h('div', { class: 'block-actions no-print' }, allDoneBtn, addSet, removeSet, plates), undoSlot(`train-block:${key}`));
  drawProgress();
  const noteId = uid('n');
  box.append(h('div', { class: 'field block-notes' },
    h('label', { class: 'field-label', for: noteId }, 'Notes for this exercise'),
    h('input', { id: noteId, class: 'input', type: 'text', maxlength: 500, value: entry?.notes || '', placeholder: plateLoaded ? 'Seat position, foot position…' : 'How it felt, what to change next time…', onInput: (e) => { getEntry().notes = e.target.value; st.touched(); } })));
  return box;
}

// ---------------------------------------------------------------- cardio, intervals, circuits

function cardioInputs(st, bd, { showRounds = false, onRoundsRef = null } = {}) {
  const { rb } = bd;
  const e0 = entryFor(st, bd, 'cardio', false);
  const inputs = {};
  const issues = issueBox(st, 'cardio', () => entryFor(st, bd, 'cardio', false), (field) => inputs[field] || null);
  const set = (field, v) => { const e = entryFor(st, bd, 'cardio', true); e[field] = v; st.touched(); issues.later(); };
  const targetMin = rb.kind === 'cardio' ? rb.minutes : rb.kind === 'intervals' ? easyMinutes(rb) : rb.circuit?.minutes;
  const minutes = numberField({ label: 'Time', unit: 'min', value: e0?.minutes, min: 0, step: 1, onInput: (v) => set('minutes', v), fkey: `${bd.key}:minutes` });
  const zoneOpts = [...new Set([...(e0?.zone ? [e0.zone] : []), ...(rb.zone ? [rb.zone] : []), ...ZONES])].map((z) => ({ value: z, label: z === 'mixed' ? 'Mixed' : z }));
  const defZone = e0?.zone || (rb.kind === 'intervals' ? (st.easy ? 'Z2' : (rb.intervals.work_zone || 'mixed')) : (rb.zone || 'Z2'));
  let roundsField = null;
  const grid = h('div', { class: 'cardio-grid' },
    minutes,
    numberField({ label: 'Average heart rate', value: e0?.avg_hr, unit: 'bpm', min: 30, max: 230, step: 1, onInput: (v) => set('avg_hr', v), fkey: `${bd.key}:avg_hr` }),
    selectField({ label: 'Zone', value: defZone, options: zoneOpts, onChange: (v) => set('zone', v) }),
    rb.kind === 'cardio' ? numberField({ label: 'Distance', value: e0?.distance_km, unit: 'km', min: 0, step: 0.01, onInput: (v) => set('distance_km', v), fkey: `${bd.key}:distance_km` }) : null,
    rb.kind === 'cardio' ? numberField({ label: 'Ascent', value: e0?.ascent_m, unit: 'm', min: 0, step: 1, onInput: (v) => set('ascent_m', v) }) : null,
    rb.kind !== 'circuit' ? numberField({ label: 'Level or incline', value: e0?.level, min: 0, step: 0.5, hint: 'Machine level or treadmill %', onInput: (v) => set('level', v) }) : null,
    showRounds ? (roundsField = numberField({ label: 'Rounds done', value: e0?.rounds, min: 0, step: 1, onInput: (v) => set('rounds', v), fkey: `${bd.key}:rounds` })) : null);
  if (onRoundsRef) {
    onRoundsRef.set = (n) => {
      set('rounds', n);
      const input = roundsField?.querySelector('input');
      if (input) input.value = String(n);
    };
  }
  const fill = h('button', { type: 'button', class: 'btn btn-sm no-print', onClick: () => {
    if (!isNum(targetMin)) return;
    const input = minutes.querySelector('input');
    input.value = String(targetMin);
    set('minutes', targetMin);
    toast(`${targetMin} minutes recorded. Add your average heart rate if you have it.`);
  } }, icon('check', 16), `Done: record ${targetMin} min`);
  inputs.minutes = minutes.querySelector('input');
  inputs.avg_hr = grid.querySelectorAll('input')[1] || null;
  const dist = rb.kind === 'cardio' ? grid.querySelectorAll('input')[2] : null;
  if (dist) inputs.distance_km = dist;
  issues.draw();
  const noteId = uid('n');
  return h('div', null, grid, issues.el,
    isNum(targetMin) ? h('div', { class: 'block-actions' }, fill) : null,
    h('div', { class: 'field block-notes' },
      h('label', { class: 'field-label', for: noteId }, 'Notes'),
      h('input', { id: noteId, class: 'input', type: 'text', maxlength: 500, value: e0?.notes || '', onInput: (e) => set('notes', e.target.value) })));
}

function renderCardioBlock(st, bd, n, cleanups) {
  const { ctx, date } = st;
  const { rb, key } = bd;
  const entry = entryFor(st, bd, 'cardio', false);
  const exId = entry?.exercise && entry.exercise !== 'circuit' ? entry.exercise : rb.exercise;
  const swapped = !!entry?.swapped_from && exId !== rb.exercise;
  const blocked = rb.exercise ? (swapped ? (isLocked(exId, date, ctx.data) ? 'locked' : null) : isLocked(rb.exercise, date, ctx.data) ? 'locked' : !isAvailable(rb.exercise, ctx.data) ? 'unavailable' : null) : null;
  const box = h('section', { class: ['block', blocked && 'is-locked'], 'aria-label': `Block ${n}`, dataset: { fscope: key, name: rb.kind === 'circuit' ? 'Circuit' : exId ? exName(exId) : 'Cardio', kind: 'cardio' } });
  const profile = ctx.data.profile;
  const timersOn = !st.recordOnly && date === ctx.today;
  if (rb.kind === 'circuit') {
    box.append(h('p', { class: 'block-num' }, `Block ${n}`), h('h2', { class: 'block-title' }, 'Circuit'));
    box.append(h('div', { class: 'spec' }, chip(blockTarget(rb)), rb.zone ? chip(zoneText(rb.zone, profile, ctx.today)) : null));
    if (rb.zoneCapped || rb.easyZoneCapped) box.append(h('p', { class: 'adjust-note' }, `No harder than ${rb.zone} ${rb.easyZoneCapped ? 'today (easy day)' : 'this week'}${rb.zonePlanned ? ` (normally ${rb.zonePlanned})` : ''}.`));
    if (rb.notes) box.append(h('p', { class: 'block-note' }, gateText(rb.notes)));
    const lockedItems = rb.circuit.items.filter((it) => isLocked(it.exercise, date, ctx.data) || !isAvailable(it.exercise, ctx.data));
    box.append(h('ul', { class: 'circuit-items' }, rb.circuit.items.map((it) => {
      const locked = isLocked(it.exercise, date, ctx.data);
      const away = !locked && !isAvailable(it.exercise, ctx.data);
      return h('li', null, h('span', null, exerciseButton(it.exercise, ctx),
        locked ? h('span', { class: 'chip chip-locked', style: { 'margin-left': '8px' } }, `Locked: ${content.exById.has(it.exercise) ? gateLabel(gateOf(it.exercise)) : 'not in the library'}`) : null,
        away ? h('span', { class: 'chip chip-unavailable', style: { 'margin-left': '8px' } }, 'Not at your gym') : null), h('span', { class: 'muted' }, gateText(it.dose || '')));
    })));
    if (lockedItems.length) box.append(h('p', { class: 'notice notice-locked small', style: { 'margin-top': '8px' } }, 'Leave out the locked moves, or swap in an easier version from the library.'));
    const ref = {};
    if (timersOn) {
      const timer = circuitTimer({ minutes: rb.circuit.minutes, rounds: entry?.rounds || 0, onRounds: (c) => ref.set && ref.set(c) });
      cleanups.push(timer.stop);
      box.append(timer.el);
    }
    box.append(cardioInputs(st, bd, { showRounds: true, onRoundsRef: ref }));
    return box;
  }
  box.append(h('div', { class: 'block-head' },
    h('div', { class: 'block-head-text' },
      h('p', { class: 'block-num' }, typeof n === 'number' ? `Block ${n}` : 'Added exercise'),
      h('h2', { class: 'block-title' }, exId ? exerciseButton(exId, ctx) : 'Cardio'),
      swapped ? h('p', { class: 'swap-note' }, `Swapped in for ${exName(entry.swapped_from)} today.`) : null),
    blocked || rb.kind !== 'cardio' ? null : swapButton(st, bd, exId)));
  if (rb.kind === 'cardio') {
    const spec = [chip(`${rb.minutes ?? '?'} min`)];
    if (rb.zone) spec.push(chip(zoneText(rb.zone, profile, ctx.today)));
    box.append(h('div', { class: 'spec' }, spec));
    if (rb.byWeek && isNum(rb.baseMinutes) && rb.baseMinutes !== rb.minutes) box.append(h('p', { class: 'adjust-note' }, `Week ${st.plan.pos?.week || 1} target. It builds week by week.`));
    if (rb.scaled) box.append(h('p', { class: 'adjust-note' }, `Scaled from ${rb.baseMinutes} min for this week.`));
    if (rb.zoneCapped || rb.easyZoneCapped) box.append(h('p', { class: 'adjust-note' }, `No harder than ${rb.zone} ${rb.easyZoneCapped ? 'today (easy day)' : 'this week'}${rb.zonePlanned ? ` (normally ${rb.zonePlanned})` : ''}.`));
    if (rb.notes) box.append(h('p', { class: 'block-note' }, gateText(rb.notes)));
    if (blocked) { box.append(blockedPanel(st, bd, blocked, entry), undoSlot(`train-block:${key}`)); return box; }
    let last = null;
    try { last = exId ? lastPerformance(ctx.data, exId, date, st.wk?.id, { program: content.program, sessionId: st.sid === 'adhoc' ? null : st.sid, blockKey: bd.extra ? null : key }) : null; } catch { last = null; }
    if (last?.cardio?.length) {
      const c = last.cardio[0];
      box.append(h('p', { class: 'last-time' }, h('span', { class: 'muted' }, `Last time, ${fmtDay(last.date)}: `), [isNum(c.minutes) ? `${c.minutes} min` : '', isNum(c.avg_hr) ? `${c.avg_hr} bpm` : '', isNum(c.level) ? `level ${c.level}` : '', isNum(c.distance_km) ? `${c.distance_km} km` : ''].filter(Boolean).join(', ')));
    }
    box.append(cardioInputs(st, bd), undoSlot(`train-block:${key}`));
    return box;
  }
  // intervals
  const iv = rb.intervals;
  const spec = [];
  if (rb.warmup_min) spec.push(chip(`Warm-up ${rb.warmup_min} min`));
  spec.push(chip(`${iv.rounds} × ${iv.work_s} s ${iv.work_zone || 'hard'}`));
  spec.push(chip(`${iv.rest_s} s ${iv.rest_zone || 'easy'}`));
  if (rb.cooldown_min) spec.push(chip(`Cool-down ${rb.cooldown_min} min`));
  if (rb.deload) spec.push(chip('Deload', 'chip-accent'));
  box.append(h('div', { class: 'spec' }, spec));
  if (rb.deload && !st.easy) box.append(h('p', { class: 'adjust-note' }, `Deload week: ${iv.rounds} rounds instead of ${rb.roundsPlanned}, and no harder than ${iv.work_zone}${rb.workZonePlanned && rb.workZonePlanned !== iv.work_zone ? ` (normally ${rb.workZonePlanned})` : ''}.`));
  else if (rb.zoneCapped && !st.easy) box.append(h('p', { class: 'adjust-note' }, `This week: no harder than ${iv.work_zone}${rb.workZonePlanned && rb.workZonePlanned !== iv.work_zone ? ` (normally ${rb.workZonePlanned})` : ''}.`));
  if (rb.notes) box.append(h('p', { class: 'block-note' }, gateText(rb.notes)));
  if (blocked) { box.append(blockedPanel(st, bd, blocked, entry)); return box; }
  if (st.easy) {
    box.append(h('p', { class: 'notice notice-warn', style: { 'margin-top': '10px' } }, `Easy day: skip the hard efforts. Ride steady in ${zoneText('Z2', profile, ctx.today)} for about ${easyMinutes(rb)} minutes instead.`));
    box.append(cardioInputs(st, bd));
    return box;
  }
  const ref = {};
  if (timersOn) {
    const timer = intervalTimer({ ...iv, warmup_min: rb.warmup_min, cooldown_min: rb.cooldown_min, onRound: (r) => ref.set && ref.set(r) });
    cleanups.push(timer.stop);
    box.append(timer.el);
  }
  box.append(cardioInputs(st, bd, { showRounds: true, onRoundsRef: ref }));
  return box;
}

function renderExtra(st, e, cleanups) {
  const isCardio = Array.isArray(st.wk?.cardio) && st.wk.cardio.includes(e);
  const rb = isCardio
    ? { kind: 'cardio', exercise: e.exercise, minutes: null, zone: e.zone || 'Z2', notes: '' }
    : { kind: 'strength', exercise: e.exercise, sets: Math.max(1, e.sets.length), setsPlanned: Math.max(1, e.sets.length), reps: null, rir: '', rest_s: 90, notes: '' };
  const bd = { rb, key: e.block, legacy: null, extra: true };
  const box = isCardio ? renderCardioBlock(st, bd, '+', cleanups) : renderBlock(st, bd, { n: '+', of: 0, nextName: null }, cleanups);
  box.append(h('div', { class: 'block-actions no-print' }, h('button', { type: 'button', class: 'btn btn-sm btn-ghost', onClick: async () => {
    const doneSets = (e.sets || []).filter((x) => x.done).length;
    if (doneSets || st.wk.status === 'done') {
      const ok = await confirmDialog({ title: `Remove ${exName(e.exercise)}?`, body: `${doneSets ? `${doneSets} ticked set${doneSets === 1 ? '' : 's'} will be removed from this log.` : 'It will be removed from this log.'} You can undo it straight after.`, confirmText: 'Remove it', danger: true });
      if (!ok) return;
    }
    const list = isCardio ? st.wk.cardio : st.wk.exercises;
    const i = list.indexOf(e);
    if (i < 0) return;
    list.splice(i, 1);
    st.touched();
    st.ctx.rerender();
    offerUndo(`train:${st.date}`, {
      message: `${exName(e.exercise)} removed from this session`,
      focus: true,
      undo: () => { if (!list.includes(e)) list.splice(Math.min(i, list.length), 0, e); st.touched(); st.ctx.rerender(); },
    });
  } }, icon('trash', 16), 'Remove this exercise')));
  return box;
}

// ---------------------------------------------------------------- "Enter from sheet" (PM1, BT1-9)

/**
 * The printed week sheet, typed back in after the gym: the same blocks in the same order, with
 * the same boxes as the print (kg and reps per set, seconds for holds; minutes, average heart
 * rate, level or incline and km for cardio; rounds for intervals and circuits), then the
 * session's RPE and time. Keyboard first: Enter moves to the next box, Shift+Enter back, the up
 * and down arrows move between rows. A set with reps (or seconds) counts as done; clearing it
 * un-ticks it.
 */
function sheetEntry(st, extras) {
  const { ctx } = st;
  const cells = [];
  let row = 0;
  const groups = [];
  const move = (from, dir) => {
    const i = cells.indexOf(from);
    const next = cells[i + dir];
    if (next) { next.focus(); next.select?.(); }
    else if (dir > 0) document.querySelector('.finish .btn-primary')?.focus();
  };
  const moveRow = (from, dir) => {
    const col = from.dataset.col;
    const r0 = Number(from.dataset.row);
    const later = cells.filter((c) => c.dataset.col === col && (dir > 0 ? Number(c.dataset.row) > r0 : Number(c.dataset.row) < r0));
    const target = dir > 0 ? later[0] : later[later.length - 1];
    if (target) { target.focus(); target.select?.(); }
  };
  const cell = (props, col) => {
    const input = selectOnFocus(h('input', { type: 'text', inputmode: 'decimal', autocomplete: 'off', enterkeyhint: 'next', class: 'input sheet-cell', ...props, dataset: { row: String(row), col, fkey: `sheet:${props['aria-label']}` } }));
    input.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') { ev.preventDefault(); move(input, ev.shiftKey ? -1 : 1); }
      else if (ev.key === 'ArrowDown') { ev.preventDefault(); moveRow(input, 1); }
      else if (ev.key === 'ArrowUp') { ev.preventDefault(); moveRow(input, -1); }
    });
    cells.push(input);
    return input;
  };
  const fmtV = (v) => (isNum(v) ? String(v) : '');
  const head = (name, sub) => h('div', { class: 'sg-head' }, h('p', { class: 'sheet-ex-name' }, name), sub ? h('p', { class: 'sheet-last' }, sub) : null);
  const grid = (caption, cols, bodyRows) => h('div', { class: 'table-wrap' }, h('table', { class: 'sheet-grid' },
    h('caption', { class: 'visually-hidden' }, caption),
    h('thead', null, h('tr', null, cols.map((c) => h('th', { scope: 'col' }, c)))),
    h('tbody', null, bodyRows)));

  const strengthGroup = (bd) => {
    const { rb } = bd;
    const e0 = entryFor(st, bd, 'exercises', false);
    const exId = e0?.exercise || rb.exercise;
    const swapped = !bd.extra && !!e0?.swapped_from && exId !== rb.exercise;
    const lockedNow = swapped ? isLocked(exId, st.date, ctx.data) : isLocked(rb.exercise, st.date, ctx.data);
    if (lockedNow) return h('div', { class: 'sg-block is-locked' }, head(exName(exId), content.exById.has(exId) ? `Locked until “${gateLabel(gateOf(exId))}” is recorded. Skip it.` : 'Locked: not in the exercise library. Skip it.'));
    if (!swapped && !bd.extra && !isAvailable(rb.exercise, ctx.data)) return h('div', { class: 'sg-block is-locked' }, head(exName(exId), 'Not available at your gym: swap it on the cards, or skip it.'));
    const rx = rxFor(st, bd, e0);
    const timed = rx.kind === 'timed';
    const last = lastFor(st, bd, exId, rx);
    const loaded = rx.loaded && rx.load !== 'bodyweight' && rx.load !== 'physio';
    const showKg = loaded || (e0?.sets || []).some((x) => isNum(x.kg)) || (last?.sets || []).some((x) => isNum(x.kg));
    const count = rowCount(st, bd, e0, rx);
    const name = exName(exId);
    const trs = [];
    for (let k = 0; k < count; k++) {
      const s0 = e0?.sets?.[k] || null;
      const label = `${name}, set ${k + 1}`;
      let tr = null;
      const save = (field) => (ev) => {
        const e = entryFor(st, bd, 'exercises', true);
        while (e.sets.length <= k) e.sets.push(blankSet());
        e.sets[k][field] = parseNum(ev.target.value);
        e.sets[k].done = setHasActual(e.sets[k], timed);
        tr.classList.toggle('is-done', e.sets[k].done);
        st.touched();
      };
      const kg = showKg ? cell({ value: fmtV(s0?.kg), 'aria-label': `${label}: kilograms`, onInput: save('kg') }, 'kg') : null;
      const main = cell({ value: fmtV(timed ? s0?.seconds : s0?.reps), inputmode: 'numeric', 'aria-label': `${label}: ${timed ? 'seconds' : 'reps'}`, onInput: save(timed ? 'seconds' : 'reps') }, 'main');
      tr = h('tr', { class: s0?.done ? 'is-done' : null }, h('td', { class: 'set-n' }, String(k + 1)), showKg ? h('td', null, kg) : null, h('td', null, main));
      trs.push(tr);
      row += 1;
    }
    const sub = [last && last.sets.length ? `Last: ${last.sets.map(setText).filter(Boolean).join(', ')}` : '', `Target: ${rxText(rx)}${rx.rir ? `, RIR ${dash(rx.rir)}` : ''}`].filter(Boolean).join('. ');
    return h('div', { class: 'sg-block' }, head(name, sub),
      grid(`${name}: ${showKg ? 'kilograms and ' : ''}${timed ? 'seconds' : 'reps'}`, ['Set', ...(showKg ? ['kg'] : []), timed ? 'Seconds' : rx.per_side ? 'Reps / side' : 'Reps'], trs));
  };

  const cardioGroup = (bd) => {
    const { rb } = bd;
    const e0 = entryFor(st, bd, 'cardio', false);
    const name = rb.kind === 'circuit' ? 'Circuit' : exName(e0?.exercise && e0.exercise !== 'circuit' ? e0.exercise : rb.exercise);
    const locked = rb.exercise && rb.kind !== 'circuit' && (isLocked(e0?.swapped_from ? e0.exercise : rb.exercise, st.date, ctx.data));
    if (locked) return h('div', { class: 'sg-block is-locked' }, head(name, 'Locked: skip it.'));
    const save = (field) => (ev) => { const e = entryFor(st, bd, 'cardio', true); e[field] = parseNum(ev.target.value); st.touched(); };
    const easyIv = rb.kind === 'intervals' && st.easy;
    const target = rb.kind === 'cardio' ? rb.minutes : rb.kind === 'intervals' ? easyMinutes(rb) : rb.circuit?.minutes;
    let cols;
    let tds;
    // The same boxes as the print (views/print.js).
    if (rb.kind === 'cardio') {
      cols = ['Minutes', 'Avg HR', 'Level / %', 'km'];
      tds = [cell({ value: fmtV(e0?.minutes), inputmode: 'numeric', 'aria-label': `${name}: minutes`, onInput: save('minutes') }, 'c-min'),
        cell({ value: fmtV(e0?.avg_hr), inputmode: 'numeric', 'aria-label': `${name}: average heart rate`, onInput: save('avg_hr') }, 'c-hr'),
        cell({ value: fmtV(e0?.level), 'aria-label': `${name}: level or incline`, onInput: save('level') }, 'c-level'),
        cell({ value: fmtV(e0?.distance_km), 'aria-label': `${name}: distance in km`, onInput: save('distance_km') }, 'c-km')];
    } else if (rb.kind === 'intervals' && !easyIv) {
      cols = ['Rounds done', 'Avg HR', 'Level / %'];
      tds = [cell({ value: fmtV(e0?.rounds), inputmode: 'numeric', 'aria-label': `${name}: rounds done`, onInput: save('rounds') }, 'c-rounds'),
        cell({ value: fmtV(e0?.avg_hr), inputmode: 'numeric', 'aria-label': `${name}: average heart rate`, onInput: save('avg_hr') }, 'c-hr'),
        cell({ value: fmtV(e0?.level), 'aria-label': `${name}: level or incline`, onInput: save('level') }, 'c-level')];
    } else if (rb.kind === 'intervals') {
      cols = ['Minutes', 'Avg HR'];
      tds = [cell({ value: fmtV(e0?.minutes), inputmode: 'numeric', 'aria-label': `${name}: minutes`, onInput: save('minutes') }, 'c-min'),
        cell({ value: fmtV(e0?.avg_hr), inputmode: 'numeric', 'aria-label': `${name}: average heart rate`, onInput: save('avg_hr') }, 'c-hr')];
    } else {
      cols = ['Rounds', 'Minutes', 'Avg HR'];
      tds = [cell({ value: fmtV(e0?.rounds), inputmode: 'numeric', 'aria-label': `${name}: rounds`, onInput: save('rounds') }, 'c-rounds'),
        cell({ value: fmtV(e0?.minutes), inputmode: 'numeric', 'aria-label': `${name}: minutes`, onInput: save('minutes') }, 'c-min'),
        cell({ value: fmtV(e0?.avg_hr), inputmode: 'numeric', 'aria-label': `${name}: average heart rate`, onInput: save('avg_hr') }, 'c-hr')];
    }
    row += 1;
    return h('div', { class: 'sg-block' }, head(name, isNum(target) ? `Target ${target} min${easyIv ? ', steady Zone 2 (easy day)' : ''}` : null),
      grid(`${name}: ${cols.join(', ')}`, cols, [h('tr', null, tds.map((x) => h('td', null, x)))]));
  };

  const add = (bd) => {
    const { rb } = bd;
    if (isPhysioBlock(rb) || rb.kind === 'unknown') return;
    groups.push(rb.kind === 'cardio' || rb.kind === 'intervals' || rb.kind === 'circuit' ? cardioGroup(bd) : strengthGroup(bd));
  };
  st.descs.forEach(add);
  for (const e of extras) {
    const isCardio = (st.wk?.cardio || []).includes(e);
    add({ rb: isCardio ? { kind: 'cardio', exercise: e.exercise, zone: e.zone || 'Z2', minutes: null } : { kind: 'strength', exercise: e.exercise, sets: Math.max(1, e.sets.length), rest_s: 90 }, key: e.block, legacy: null, extra: true });
  }
  // The print's last line for every session: RPE and time (BT1-9).
  const rpe = cell({ value: fmtV(st.wk?.rpe), inputmode: 'numeric', 'aria-label': 'Session RPE, 1 to 10', onInput: (ev) => { const v = parseNum(ev.target.value); st.ensure().rpe = isNum(v) && v >= 1 && v <= 10 ? v : null; st.touched(); } }, 's-rpe');
  const mins = cell({ value: fmtV(st.wk?.duration_min), inputmode: 'numeric', 'aria-label': 'Session time in minutes', onInput: (ev) => { st.ensure().duration_min = parseNum(ev.target.value); st.touched(); } }, 's-min');
  row += 1;
  const sessionGroup = h('div', { class: 'sg-block sg-session' }, head('The whole session'),
    grid('Session: RPE and time', ['RPE (1–10)', 'Time (min)'], [h('tr', null, h('td', null, rpe), h('td', null, mins))]));
  return h('section', { class: 'sheet sheet-entry', 'aria-labelledby': 'sheet-h' },
    h('div', { class: 'row-between' },
      h('h2', { class: 'section-title', id: 'sheet-h' }, 'Enter from sheet'),
      h('button', { type: 'button', class: 'btn btn-sm', onClick: () => { sheetMode.delete(`${st.date}|${st.sid}`); ctx.rerender(); } }, 'Back to the cards')),
    h('p', { class: 'small muted', style: { 'margin-top': '4px' } }, 'Type what you wrote on the printed sheet, in the same order. Enter moves to the next box, Shift+Enter goes back, and the arrow keys move up and down. A set with reps counts as done. Everything saves as you type.'),
    groups.length ? h('div', { class: 'sg-list' }, groups) : h('p', { class: 'muted' }, 'Nothing in this session takes numbers.'),
    sessionGroup);
}

// ---------------------------------------------------------------- finish

function summary(w) {
  const sets = (w.exercises || []).reduce((n, e) => n + (e.sets || []).filter((x) => x.done).length, 0);
  const mins = (w.cardio || []).reduce((n, c) => n + (Number(c.minutes) || 0), 0);
  const bits = [];
  if (sets) bits.push(`${sets} set${sets === 1 ? '' : 's'}`);
  if (mins) bits.push(`${mins} min of cardio`);
  if (isNum(w.duration_min)) bits.push(`${w.duration_min} min in all`);
  return bits.join(', ');
}

function renderFinish(st) {
  const { ctx, session, date } = st;
  const wrap = h('section', { class: 'sheet finish', 'aria-labelledby': 'finish-h' });
  const statusLine = h('p', { class: 'small muted' });
  const updateStatus = () => {
    statusLine.textContent = !st.wk ? 'Nothing logged yet. Your entries save automatically as you type.'
      : st.wk.status === 'done' ? 'Saved as done. Changes you make now save automatically.'
        : 'Draft: everything you type is saved as you go. Press “Save session” when you finish.';
  };
  updateStatus();
  const started = st.wk?.started_at ? Date.parse(st.wk.started_at) : null;
  const autoMin = started ? Math.max(1, Math.round((Date.now() - started) / 60000)) : null;
  wrap.append(h('h2', { class: 'section-title', id: 'finish-h' }, 'Finish'), statusLine,
    h('div', { class: 'form-grid', style: { 'margin-top': '14px' } },
      h('div', { class: 'span-2' }, scaleField({ label: 'How hard was it? (RPE, 1 to 10)', value: st.wk?.rpe, min: 1, max: 10, lowLabel: 'Very easy', highLabel: 'Maximal', onChange: (v) => { st.ensure().rpe = v; st.touched(); } })),
      numberField({ label: 'Duration', unit: 'min', value: st.wk?.duration_min, min: 0, step: 1, hint: autoMin ? `The clock says ${autoMin} min` : (isNum(session?.duration_min) ? `Planned ${session.duration_min} min` : null), onInput: (v) => { st.ensure().duration_min = v; st.touched(); } }),
      h('div', { class: 'span-all' }, textareaField({ label: 'Session notes', value: st.wk?.notes, rows: 3, placeholder: 'How did it feel? Anything to tell your physio?', onInput: (v) => { st.ensure().notes = v; st.touched(); } }))));
  const after = h('div', { 'aria-live': 'polite' });
  // Round 4 (finding 9): one save at a time; the button is disabled and says "Saving…" meanwhile.
  const save = singleFlight(async () => {
    const w = st.ensure();
    w.status = 'done';
    w.completed_at = w.completed_at || nowIso();
    w.easy_day = st.easy;
    if (!isNum(w.duration_min)) {
      const s0 = w.started_at ? Date.parse(w.started_at) : null;
      w.duration_min = s0 ? Math.max(1, Math.round((Date.now() - s0) / 60000)) : (isNum(session?.duration_min) ? session.duration_min : null);
    }
    stampPlanned(st, { force: true }); // SPEC 5.2 round 4: `planned` on every entry, as of Save
    trimBlankSets(w);
    stopRestDock('code');
    st.touched();
    const res = await store.flush();
    const status = res?.status || store.getStatus();
    toast(status === 'error' ? 'Saved on this device. It reaches the hub when the hub is back.'
      : status === 'conflict' ? 'Saved on this device. The hub has other changes too: choose which to keep.'
        : status === 'build-mismatch' || status === 'outdated' ? 'Saved on this device. The hub was updated: reload to finish saving.'
          : 'Session saved', { key: 'save-session', tone: status === 'error' || status === 'conflict' ? 'error' : 'info' });
    updateStatus();
    saveBtn.dataset.idleLabel = 'Save changes';
    document.body.classList.remove('has-next-dock');
    document.querySelector('.next-dock')?.remove();
    const sum = summary(w);
    const done = h('div', { class: 'notice notice-good saved-note' },
      h('p', null, h('strong', null, 'Session saved. '), sum ? `${sum.charAt(0).toUpperCase()}${sum.slice(1)}.` : ''),
      h('div', { class: 'row', style: { 'margin-top': '8px' } }, h('a', { class: 'btn btn-sm btn-primary', href: '#/today' }, 'Back to Today')));
    replaceKids(after, done);
    // BT1-8: the hike-log prompt is for an outdoor walk or hike only, never the treadmill or bike.
    const outdoor = w.cardio.filter((c) => HIKE_LOG_IDS.has(c?.exercise));
    if (outdoor.length && !ctx.data.hikes.some((hk) => hk.workout_id === w.id)) {
      const dist = outdoor.reduce((a, c) => a + (Number(c.distance_km) || 0), 0);
      const asc = outdoor.reduce((a, c) => a + (Number(c.ascent_m) || 0), 0);
      const mins = outdoor.reduce((a, c) => a + (Number(c.minutes) || 0), 0);
      const hr = outdoor.find((c) => isNum(c.avg_hr))?.avg_hr ?? null;
      const ask = h('div', { class: 'notice notice-accent', style: { 'margin-top': '10px' } },
        h('p', null, 'Add this to your hike log? It counts towards the hiking ladder and your totals.'),
        h('div', { class: 'row', style: { 'margin-top': '8px' } },
          h('button', { type: 'button', class: 'btn btn-sm btn-primary', onClick: () => {
            ctx.data.hikes.push({ id: uid('uuid'), date: w.date, name: w.session_name || 'Hike', distance_km: dist || null, ascent_m: asc || null, duration_min: mins || w.duration_min, pack_kg: 0, terrain: '', avg_hr: hr, rpe: w.rpe, ladder_level: null, notes: w.notes || '', workout_id: w.id });
            store.touch();
            ask.replaceChildren(h('p', { class: 'small' }, 'Added to your hike log. ', h('a', { href: '#/hikes' }, 'Open Hikes')));
          } }, 'Add to hike log'),
          h('button', { type: 'button', class: 'btn btn-sm btn-ghost', onClick: () => ask.remove() }, 'Not now')));
      after.append(ask);
    }
  }, { onBusy: (on) => setBusy(saveBtn, on, 'Saving…') });
  const saveBtn = h('button', { type: 'button', class: 'btn btn-primary btn-lg', onClick: () => { save(); } }, st.wk?.status === 'done' ? 'Save changes' : 'Save session');
  const discard = h('button', { type: 'button', class: 'btn btn-ghost', onClick: async () => {
    if (!st.wk) { ctx.navigate('#/today'); return; }
    const w = st.wk;
    const wasDone = w.status === 'done';
    if (wasDone || hasValues(w)) {
      const ok = await confirmDialog({
        title: wasDone ? 'Delete this session log?' : 'Discard this draft?',
        body: `${w.session_name || 'This session'} on ${fmtDay(w.date, { year: true })}${summary(w) ? `: ${summary(w)}` : ''}. You can undo it straight after.`,
        confirmText: wasDone ? 'Delete the log' : 'Discard the draft', danger: true,
      });
      if (!ok) return;
    }
    const list = ctx.data.workouts;
    const i = list.indexOf(w);
    if (i >= 0) list.splice(i, 1);
    store.touch();
    stopRestDock('code');
    ctx.navigate(`#/train/${date}/${encodeURIComponent(w.session_id || 'adhoc')}`);
    offerUndo(`train:${date}`, {
      message: wasDone ? `Session log deleted: ${w.session_name || 'session'}, ${fmtDay(w.date)}` : 'Draft discarded',
      focus: true,
      undo: () => {
        if (!list.includes(w)) list.splice(Math.min(Math.max(i, 0), list.length), 0, w);
        store.touch();
        ctx.navigate(`#/train/w/${w.id}`);
      },
    });
  } }, icon('trash', 16), st.wk?.status === 'done' ? 'Delete this log' : 'Discard draft');
  wrap.append(h('div', { class: 'session-actions' }, saveBtn, discard), after);
  return wrap;
}
