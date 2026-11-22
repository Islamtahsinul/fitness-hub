// Rest, interval and circuit timers. Sounds use WebAudio (no files, no network).

import { h, fmtDuration } from './dom.js';

let audio = null;

function unlockAudio() {
  try {
    audio = audio || new (window.AudioContext || window.webkitAudioContext)();
    if (audio.state === 'suspended') audio.resume();
  } catch { audio = null; }
}

export function beep(times = 1, freq = 880, dur = 0.14) {
  if (!audio) return;
  try {
    const t0 = audio.currentTime + 0.01;
    for (let i = 0; i < times; i++) {
      const at = t0 + i * 0.24;
      const osc = audio.createOscillator();
      const gain = audio.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.0001, at);
      gain.gain.exponentialRampToValueAtTime(0.22, at + 0.012);
      gain.gain.exponentialRampToValueAtTime(0.0001, at + dur);
      osc.connect(gain).connect(audio.destination);
      osc.start(at);
      osc.stop(at + dur + 0.03);
    }
  } catch { /* sound is a nicety */ }
}

function buzz(pattern) {
  try { if (navigator.vibrate) navigator.vibrate(pattern); } catch { /* ignore */ }
}

// Keep the screen awake while a timer runs (released automatically when the tab is hidden;
// re-requested when it comes back). Feature-detected: a nicety, never required.
const wakeHolders = new Set();
let wakeSentinel = null;

async function requestWake() {
  try {
    if (!wakeHolders.size || wakeSentinel || typeof navigator === 'undefined' || !navigator.wakeLock) return;
    if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return;
    wakeSentinel = await navigator.wakeLock.request('screen');
    wakeSentinel.addEventListener?.('release', () => { wakeSentinel = null; });
    if (!wakeHolders.size) releaseWakeNow();
  } catch { wakeSentinel = null; }
}

function releaseWakeNow() {
  const s = wakeSentinel;
  wakeSentinel = null;
  try { if (s) s.release(); } catch { /* ignore */ }
}

export function holdWake(token) {
  wakeHolders.add(token);
  requestWake();
}

export function releaseWake(token) {
  wakeHolders.delete(token);
  if (!wakeHolders.size) releaseWakeNow();
}

if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') requestWake(); });
}

/**
 * Pure segment stepping for the interval timer: subtract `elapsed` seconds starting at segment
 * idx with `left` seconds remaining, carrying any overflow into the following segments (a
 * throttled background tab may tick only once a minute). Returns {idx, left, completed}, where
 * completed lists the segment indexes that finished during this step.
 */
export function stepSegments(segs, idx, left, elapsed) {
  const completed = [];
  let i = idx;
  let l = left - elapsed;
  while (i < segs.length && l <= 0) {
    completed.push(i);
    i += 1;
    if (i < segs.length) l += segs[i].secs;
  }
  return { idx: i, left: i < segs.length ? l : 0, completed };
}

// ------------------------------------------------------------ rest timer (floating)

let rest = null;

export function stopRest() {
  if (!rest) return;
  clearInterval(rest.tick);
  rest.el.remove();
  releaseWake(rest);
  rest = null;
}

export function startRest(seconds, label = 'Rest') {
  unlockAudio();
  stopRest();
  if (!(seconds > 0)) return;
  const time = h('p', { class: 'rt-time', role: 'timer', 'aria-live': 'off' }, fmtDuration(seconds));
  const bar = h('div', { class: 'rt-bar-fill' });
  const say = h('p', { class: 'visually-hidden', 'aria-live': 'assertive' });
  const adjust = (d) => { if (!rest) return; rest.end += d * 1000; rest.total = Math.max(1, rest.total + d); render(); };
  const el = h('div', { class: 'rest-timer', role: 'region', 'aria-label': 'Rest timer' },
    h('div', { class: 'rt-head' }, h('p', { class: 'rt-label' }, label), time),
    h('div', { class: 'rt-bar' }, bar),
    h('div', { class: 'rt-actions' },
      h('button', { type: 'button', class: 'btn btn-sm', onClick: () => adjust(-15) }, '−15 s'),
      h('button', { type: 'button', class: 'btn btn-sm', onClick: () => adjust(15) }, '+15 s'),
      h('button', { type: 'button', class: 'btn btn-sm btn-ghost', onClick: stopRest }, 'Skip rest')),
    say);
  document.body.appendChild(el);
  rest = { el, end: Date.now() + seconds * 1000, total: seconds, tick: null, done: false };
  const render = () => {
    if (!rest) return;
    const left = Math.max(0, (rest.end - Date.now()) / 1000);
    time.textContent = fmtDuration(Math.ceil(left));
    bar.style.width = `${Math.max(0, Math.min(100, 100 - (left / rest.total) * 100))}%`;
    if (left <= 0 && !rest.done) {
      rest.done = true;
      el.classList.add('is-over');
      time.textContent = 'Go';
      say.textContent = 'Rest over. Start your next set.';
      beep(2, 880);
      buzz([200, 100, 200]);
      setTimeout(() => { if (rest && rest.done) stopRest(); }, 6000);
    }
  };
  rest.tick = setInterval(render, 250);
  holdWake(rest);
  render();
}

// ------------------------------------------------------------ interval timer

export function intervalTimer({ warmup_min = 0, cooldown_min = 0, work_s = 0, rest_s = 0, rounds = 0, work_zone = '', rest_zone = '', onRound = null }) {
  const segs = [];
  if (warmup_min > 0) segs.push({ kind: 'warmup', label: 'Warm-up', secs: Math.round(warmup_min * 60), zone: 'easy' });
  for (let r = 1; r <= rounds; r++) {
    if (work_s > 0) segs.push({ kind: 'work', label: `Hard ${r} of ${rounds}`, secs: work_s, zone: work_zone, round: r });
    if (rest_s > 0 && r < rounds) segs.push({ kind: 'rest', label: `Easy ${r} of ${rounds}`, secs: rest_s, zone: rest_zone });
  }
  if (cooldown_min > 0) segs.push({ kind: 'cooldown', label: 'Cool-down', secs: Math.round(cooldown_min * 60), zone: 'easy' });
  const totalSecs = segs.reduce((a, b) => a + b.secs, 0);
  let idx = 0;
  let left = segs[0]?.secs || 0;
  let running = false;
  let tick = null;
  let last = 0;
  let lastWhole = null;

  const label = h('p', { class: 'tm-label' });
  const time = h('p', { class: 'tm-time', role: 'timer', 'aria-live': 'off' });
  const next = h('p', { class: 'tm-next' });
  const fill = h('div', { class: 'tm-bar-fill' });
  const say = h('p', { class: 'visually-hidden', 'aria-live': 'polite' });
  const startBtn = h('button', { type: 'button', class: 'btn btn-primary', onClick: () => (running ? pause() : start()) }, 'Start');
  const el = h('div', { class: 'timer', role: 'region', 'aria-label': 'Interval timer' },
    h('div', { class: 'tm-face' }, label, time, next),
    h('div', { class: 'tm-bar', 'aria-hidden': 'true' }, fill),
    h('div', { class: 'tm-actions' },
      startBtn,
      h('button', { type: 'button', class: 'btn', onClick: () => skip() }, 'Skip'),
      h('button', { type: 'button', class: 'btn btn-ghost', onClick: () => reset() }, 'Reset')),
    say);

  const elapsedBefore = () => segs.slice(0, idx).reduce((a, b) => a + b.secs, 0);
  const render = () => {
    const seg = segs[idx];
    if (!seg) {
      label.textContent = 'Finished';
      time.textContent = '0:00';
      next.textContent = 'Nice work. Log your average heart rate below.';
      fill.style.width = '100%';
      el.dataset.kind = 'done';
      return;
    }
    el.dataset.kind = seg.kind;
    label.textContent = `${seg.label}${seg.zone ? `, ${seg.zone}` : ''}`;
    time.textContent = fmtDuration(Math.ceil(left));
    const n = segs[idx + 1];
    next.textContent = n ? `Next: ${n.label}, ${fmtDuration(n.secs)}` : 'Last one';
    fill.style.width = `${totalSecs ? ((elapsedBefore() + (seg.secs - left)) / totalSecs) * 100 : 0}%`;
  };
  const token = {};
  // Move on by `elapsed` seconds, carrying overflow across segments so the timer never falls
  // behind real time; only the segment we land in gets a cue (no burst of beeps after a pause).
  const advanceBy = (elapsed) => {
    const r = stepSegments(segs, idx, left, elapsed);
    for (const i of r.completed) if (segs[i].kind === 'work' && onRound) onRound(segs[i].round);
    idx = r.idx;
    left = r.left;
    if (!r.completed.length) return;
    const n = segs[idx];
    if (!n) { pause(); beep(3, 660, 0.2); buzz([300, 120, 300]); say.textContent = 'Intervals finished.'; }
    else { beep(n.kind === 'work' ? 2 : 1, n.kind === 'work' ? 990 : 660, 0.18); buzz(200); say.textContent = n.label; }
    lastWhole = null;
  };
  const loop = () => {
    const now = performance.now();
    const elapsed = (now - last) / 1000;
    last = now;
    advanceBy(elapsed);
    const whole = Math.ceil(left);
    const nx = segs[idx + 1];
    if (segs[idx] && nx && nx.kind === 'work' && whole <= 3 && whole >= 1 && whole !== lastWhole) { beep(1, 520, 0.08); lastWhole = whole; }
    render();
  };
  function start() {
    if (!segs[idx]) return;
    unlockAudio();
    running = true;
    last = performance.now();
    tick = setInterval(loop, 200);
    startBtn.textContent = 'Pause';
    holdWake(token);
  }
  function pause() {
    running = false;
    clearInterval(tick);
    startBtn.textContent = segs[idx] ? 'Resume' : 'Start';
    releaseWake(token);
  }
  function skip() { if (segs[idx]) { advanceBy(left); render(); } }
  function reset() { pause(); idx = 0; left = segs[0]?.secs || 0; startBtn.textContent = 'Start'; render(); }
  render();
  return { el, stop: pause };
}

// ------------------------------------------------------------ circuit timer

export function circuitTimer({ minutes = null, rounds = 0, onRounds = null }) {
  const target = minutes ? minutes * 60 : null;
  let elapsed = 0;
  let count = rounds || 0;
  let running = false;
  let tick = null;
  let last = 0;
  let finished = false;
  const time = h('p', { class: 'tm-time', role: 'timer', 'aria-live': 'off' });
  const label = h('p', { class: 'tm-label' }, target ? 'Time left' : 'Time');
  const roundsOut = h('p', { class: 'tm-next' });
  const say = h('p', { class: 'visually-hidden', 'aria-live': 'polite' });
  const startBtn = h('button', { type: 'button', class: 'btn btn-primary', onClick: () => (running ? pause() : start()) }, 'Start');
  const render = () => {
    time.textContent = fmtDuration(target ? Math.max(0, target - elapsed) : elapsed);
    roundsOut.textContent = `Rounds done: ${count}`;
  };
  const loop = () => {
    const now = performance.now();
    elapsed += (now - last) / 1000;
    last = now;
    if (target && elapsed >= target && !finished) {
      finished = true;
      pause();
      beep(3, 660, 0.2);
      buzz([300, 120, 300]);
      say.textContent = 'Time. Circuit finished.';
    }
    render();
  };
  const token = {};
  function start() { unlockAudio(); running = true; last = performance.now(); tick = setInterval(loop, 250); startBtn.textContent = 'Pause'; holdWake(token); }
  function pause() { running = false; clearInterval(tick); startBtn.textContent = 'Resume'; releaseWake(token); }
  const el = h('div', { class: 'timer timer-circuit', role: 'region', 'aria-label': 'Circuit timer' },
    h('div', { class: 'tm-face' }, label, time, roundsOut),
    h('div', { class: 'tm-actions' },
      startBtn,
      h('button', { type: 'button', class: 'btn', onClick: () => { count += 1; render(); if (onRounds) onRounds(count); say.textContent = `${count} rounds`; } }, 'Add a round'),
      h('button', { type: 'button', class: 'btn btn-ghost', onClick: () => { pause(); elapsed = 0; finished = false; startBtn.textContent = 'Start'; render(); } }, 'Reset')),
    say);
  render();
  return { el, stop: pause, setRounds: (n) => { count = n || 0; render(); } };
}
