// #/settings: profile, programme start, fasting periods, resting-HR method, your gym's kit,
// data export/import/backup, content status, disclaimer.

import { h, uid, toast, confirmDialog, alertDialog, download, fmtNum, debounce } from '../dom.js';
import { fmtDay, isISODate, mondayOf, todayISO, addDays } from '../dates.js';
import { ageFrom, hrMax, hrZones, mafHr, isNum } from '../calc.js';
import { pageHead, section, sheet, numberField, textField, selectField, dateField, textareaField, categoryLabel } from '../components.js';
import { content, loadContent, contentProblems, exName } from '../content.js';
import { exportCSV, dataIssues } from '../stats.js';
import { apiBackup, apiHealth } from '../api.js';
import { setTheme, getTheme } from '../theme.js';
import * as store from '../store.js';
import { onboardingState } from '../features/onboarding.js';
import { programStart } from '../schedule.js';
import { fastingPeriods, rhrMethodChanges, unavailableIds, DEFAULT_UNAVAILABLE } from '../features/safety.js';
import { undoSlot, offerUndo } from '../features/undo.js';

export const title = 'Settings';

const ACTIVITY = [[1.375, 'Light'], [1.465, 'Light to moderate'], [1.55, 'Moderate (default)'], [1.635, 'Moderate to high'], [1.725, 'High']];
const STATE_LABEL = { ok: 'Loaded', missing: 'Not written yet', empty: 'Empty', invalid: 'Not readable yet', error: 'Could not load' };
const UNCONFIRMED = /not confirmed|not available|ankle strap|belt|kettlebell|plyo|recumbent|back extension|dip belt|harness|band for assistance|long resistance band/i;

function shortVal(v) {
  if (v === undefined) return 'Deleted';
  if (v === null || v === '') return 'Empty';
  if (typeof v === 'object') { const t = JSON.stringify(v); return t.length > 60 ? `${t.slice(0, 57)}…` : t; }
  const t = String(v);
  return t.length > 60 ? `${t.slice(0, 57)}…` : t;
}

function zonesTable(profile, today) {
  const age = ageFrom(profile.birth_year, today);
  const hm = hrMax(age, profile.hrmax_override);
  if (!hm) return h('p', { class: 'small muted' }, 'Add your birth year (or an HRmax from a test) to see your heart-rate zones.');
  const maf = mafHr(age);
  return h('div', null,
    h('p', { class: 'small', style: { 'margin-bottom': '6px' } }, `HRmax ${hm} bpm ${isNum(profile.hrmax_override) ? '(your override)' : `(Tanaka: 208 − 0.7 × ${age})`}.`),
    isNum(maf) ? h('p', { class: 'small maf-line', style: { 'margin-bottom': '8px' } }, `MAF cross-check for Zone 2: 180 − age = ${maf} bpm. While recovering from injury, Maffetone suggests −10 → ${maf - 10} bpm.`) : null,
    h('div', { class: 'table-wrap' }, h('table', { class: 'table table-compact' },
      h('thead', null, h('tr', null, h('th', { scope: 'col' }, 'Zone'), h('th', { scope: 'col' }, 'Feels like'), h('th', { scope: 'col', class: 'num' }, '% HRmax'), h('th', { scope: 'col', class: 'num' }, 'Heart rate'))),
      h('tbody', null, hrZones(hm).map((z) => h('tr', null, h('th', { scope: 'row' }, z.id), h('td', null, z.id === 'Z2' ? 'Full sentences, but you’d rather not talk. Nasal breathing possible.' : z.name), h('td', { class: 'num' }, `${z.lo}–${z.hi}%`), h('td', { class: 'num' }, `${z.loBpm}–${z.hiBpm} bpm`)))))));
}

// ---------------------------------------------------------------- fasting periods (SPEC 5.2 fasting overlay)

function fastingEditor(ctx) {
  const pr = ctx.data.profile;
  const host = h('div', { class: 'stack' });
  const list = () => (Array.isArray(pr.fasting_periods) ? pr.fasting_periods : (pr.fasting_periods = []));
  const draw = () => {
    const periods = list();
    const known = fastingPeriods(pr);
    host.replaceChildren(
      undoSlot('fasting'),
      periods.length ? h('div', { class: 'stack' }, periods.map((p, i) => sheet({ class: 'sheet-tight fasting-row' },
        h('div', { class: 'form-grid' },
          textField({ label: 'Name', value: p.label || '', placeholder: 'For example Ramadan, or a planned fast', onInput: (v) => { p.label = v; store.touch(); } }),
          dateField({ label: 'First day', value: p.start, onChange: (v) => { if (isISODate(v)) { p.start = v; if (isISODate(p.end) && p.end < v) p.end = v; store.touch(); draw(); } } }),
          dateField({ label: 'Last day', value: p.end, min: isISODate(p.start) ? p.start : null, onChange: (v) => { if (isISODate(v)) { p.end = v; store.touch(); draw(); } } })),
        h('div', { class: 'block-actions' },
          p.approximate !== false ? h('span', { class: 'chip chip-warn' }, 'Dates are approximate') : null,
          p.approximate !== false ? h('button', { type: 'button', class: 'btn btn-sm btn-ghost', onClick: () => { p.approximate = false; store.touch(); draw(); } }, 'The dates are confirmed') : null,
          h('button', { type: 'button', class: 'btn btn-sm btn-ghost', onClick: () => {
            periods.splice(i, 1);
            store.touch();
            draw();
            offerUndo('fasting', { message: `Removed ${p.label || 'the fasting period'}`, focus: true, undo: () => { list().splice(Math.min(i, list().length), 0, p); store.touch(); draw(); } });
          } }, 'Remove'))))) : h('p', { class: 'small muted' }, 'No fasting periods. If you fast, add the dates and the hub switches to easy-day mode for them automatically.'),
      h('div', { class: 'block-actions' },
        h('button', { type: 'button', class: periods.length ? 'btn' : 'btn btn-primary', onClick: () => { list().push({ start: ctx.today, end: addDays(ctx.today, 29), label: '', approximate: true }); store.touch(); draw(); } }, periods.length ? 'Add another period' : 'Add a fasting period')),
      known.some((p) => p.start <= ctx.today && ctx.today <= p.end) ? h('p', { class: 'notice notice-accent small' }, 'You’re in a fasting period now: easy-day mode is on.') : null);
  };
  draw();
  return sheet(null,
    h('p', { class: 'small ink-2', style: { 'margin-bottom': '12px' } }, 'On these dates the hub applies easy-day mode automatically: half the sets, Zone 2 only, no intervals, same loads, and no new lifts. If you can, train after you break your fast, and stop at any dizziness or light-headedness. Your phase dates don’t move. If the dates depend on the moon (Ramadan, for example), keep them marked approximate and check them nearer the time.'),
    host);
}

// ---------------------------------------------------------------- resting-HR method (SPEC 5.8)

function rhrMethod(ctx) {
  const pr = ctx.data.profile;
  const host = h('div');
  const draw = () => {
    const changes = rhrMethodChanges(pr);
    const last = changes[changes.length - 1] || null;
    // BT3-11: the same count readiness uses: mornings measured the new way BEFORE today
    // (today's own reading is judged against them, so it counts from tomorrow).
    const since = last ? ctx.data.checkins.filter((c) => c && isISODate(c.date) && c.date >= last && c.date < ctx.today && isNum(c.rhr)).length : 0;
    host.replaceChildren(
      h('p', { class: 'small ink-2' }, 'Switching to a different wearable, a chest strap or a manual pulse changes your numbers. Press this on the first morning you measure the new way: readiness ignores the resting-HR rule until there are 5 mornings measured the new way, so the switch can’t cause false amber days.'),
      last ? h('p', { class: 'small', style: { 'margin-top': '8px' } }, `Last change: ${fmtDay(last, { year: true })}. ${since >= 5 ? 'The resting-HR rule counts again.' : `${since} of the 5 mornings it needs so far, not counting today.`}`) : null,
      h('div', { class: 'block-actions' },
        h('button', { type: 'button', class: 'btn', onClick: async () => {
          if (changes.includes(ctx.today)) { toast('Already recorded for today.'); return; }
          const ok = await confirmDialog({ title: 'Changed how you measure resting HR?', body: `Recorded as ${fmtDay(ctx.today, { year: true })}. For the next 5 mornings the resting-HR rule won’t make a day amber, while the hub learns your new numbers.`, confirmText: 'Yes, I changed it' });
          if (!ok) return;
          pr.rhr_method_changes = Array.isArray(pr.rhr_method_changes) ? pr.rhr_method_changes : [];
          pr.rhr_method_changes.push(ctx.today);
          store.touch();
          toast('Recorded. Readiness re-learns your resting HR over 5 mornings.');
          draw();
        } }, 'I changed how I measure resting HR')),
      undoSlot('rhr-method'));
  };
  draw();
  return sheet(null, host);
}

// ---------------------------------------------------------------- my gym (SPEC 5.2 unavailable exercises)

function myGym(ctx) {
  const pr = ctx.data.profile;
  const ex = content.exercises || [];
  if (!ex.length) return sheet(null, h('p', { class: 'small muted' }, 'The exercise library isn’t loaded yet.'));
  const current = () => new Set(unavailableIds(ctx.data));
  const toggle = (id, off) => {
    const set = current();
    if (off) set.add(id); else set.delete(id);
    pr.unavailable_exercises = [...set].sort();
    store.touch();
    countEl.textContent = summary();
  };
  const summary = () => `${current().size} exercise${current().size === 1 ? '' : 's'} marked as not available. They’re never offered as swaps or alternatives.`;
  const countEl = h('p', { class: 'small muted', 'aria-live': 'polite' }, summary());
  const row = (e) => {
    const id = uid('gym');
    const eq = (e.equipment || []).join(', ');
    return h('li', { class: 'check gym-item' },
      h('input', { id, type: 'checkbox', checked: current().has(e.id), onChange: (ev) => toggle(e.id, ev.target.checked) }),
      h('label', { for: id }, h('span', { class: 'gym-name' }, e.name), eq ? h('span', { class: 'gym-eq' }, eq) : null));
  };
  const unsure = ex.filter((e) => DEFAULT_UNAVAILABLE.includes(e.id) || (e.equipment || []).some((q) => UNCONFIRMED.test(q))).sort((a, b) => a.name.localeCompare(b.name));
  const rest = ex.filter((e) => !unsure.includes(e)).sort((a, b) => (a.category || '').localeCompare(b.category || '') || a.name.localeCompare(b.name));
  const restHost = h('ul', { class: 'gym-list' });
  let q = '';
  const drawRest = () => {
    const words = q.trim().toLowerCase().split(/\s+/).filter(Boolean);
    const list = rest.filter((e) => !words.length || words.every((w) => `${e.name} ${e.id} ${(e.equipment || []).join(' ')} ${e.category}`.toLowerCase().includes(w)));
    restHost.replaceChildren(...list.slice(0, 60).map(row), list.length > 60 ? h('li', { class: 'small muted' }, `${list.length - 60} more: search to narrow it down.`) : null);
  };
  drawRest();
  const search = textField({ label: 'Search the rest of the library', type: 'search', placeholder: 'Exercise or equipment', onInput: debounce((v) => { q = v; drawRest(); }, 150) });
  return sheet(null,
    h('p', { class: 'small ink-2', style: { 'margin-bottom': '10px' } }, 'Tick what your gym can’t do. The hub won’t offer those as swaps or alternatives, and the library labels them “Not available at your gym”.'),
    countEl,
    h('h3', { class: 'mini-title', style: { 'margin-top': '12px' } }, 'Kit to check with your gym'),
    h('ul', { class: 'gym-list' }, unsure.map(row)),
    h('details', { class: 'disclose' }, h('summary', null, `Everything else (${rest.length})`),
      h('div', { style: { 'margin-top': '10px', 'max-width': '420px' } }, search), restHost));
}

// ---------------------------------------------------------------- import (validated, with a backup first)

const problemList = (items, max = 12) => h('ul', { class: 'problem-list' }, items.slice(0, max).map((p) => h('li', null,
  p.path ? h('code', { class: 'problem-path' }, p.path) : null, p.path ? ' ' : null, p.message)),
  items.length > max ? h('li', { class: 'muted' }, `…and ${items.length - max} more.`) : null);

/** One way to report an import that didn't happen (QA11): a single dialog with one Close button. */
function importFailed(title, lead, items = []) {
  return alertDialog({
    title,
    body: h('div', { class: 'stack-sm' },
      h('p', { class: 'modal-text' }, lead),
      items.length ? problemList(items) : null,
      h('p', { class: 'modal-text' }, 'Nothing has been changed: your data is exactly as it was.')),
  });
}

async function runImport(ctx, f) {
  const fixture = store.isFixtureMode();
  if (f.size > 10 * 1024 * 1024) { await importFailed('This file can’t be imported', 'It’s over 10 MB, the most the hub can store.'); return; }
  let obj;
  try { obj = JSON.parse(await f.text()); } catch { await importFailed('This file can’t be imported', 'It isn’t valid JSON. Export a fresh copy from the hub and try that.'); return; }
  const v = store.validateImportDetailed(obj, { today: ctx.today });
  if (!v.ok) {
    await importFailed('This file can’t be imported', `${v.errorCount === 1 ? 'One problem needs fixing' : `${fmtNum(v.errorCount)} problems need fixing`} first.`, v.errors);
    return;
  }
  const c = v.counts || {};
  const count = (k) => (Number.isFinite(c[k]) ? c[k] : Array.isArray(obj[k]) ? obj[k].length : 0);
  const ok = await confirmDialog({
    title: 'Replace all your data?',
    body: h('div', { class: 'stack-sm' },
      h('p', { class: 'modal-text' }, `The file has ${fmtNum(count('checkins'))} check-ins, ${fmtNum(count('workouts'))} sessions, ${fmtNum(count('hikes'))} hikes and ${fmtNum(count('tests'))} test results. Everything in the hub now will be replaced, after a backup of what you have.`),
      v.warningCount ? h('details', { class: 'disclose' }, h('summary', null, `${fmtNum(v.warningCount)} thing${v.warningCount === 1 ? '' : 's'} to know (the import still works)`), problemList(v.warnings)) : null),
    confirmText: 'Back up, then replace', danger: true,
  });
  if (!ok) return;
  if (!fixture) {
    // PE7: no backup, no import.
    try {
      await store.flush();
      await apiBackup();
    } catch (err) {
      await importFailed('Import stopped: the backup failed', `The hub couldn’t back up your current data before replacing it (${err?.message || 'no answer from the hub'}), so it didn’t import anything. Check the hub is running, press “Back up now”, and import again once that works.`);
      return;
    }
  }
  const r = await store.importData(obj, { today: ctx.today });
  if (r && r.ok === false) { await importFailed('This file can’t be imported', 'It changed while it was being checked.', r.errors || []); return; }
  ctx.rerender();
  // Round 4 (finding 13): "imported" only once the hub has the data (the PUT succeeded).
  const said = importOutcome(fixture ? 'fixture' : store.getStatus());
  toast(said.text, { tone: said.tone, key: 'import', timeout: said.done ? 5000 : 9000 });
  if (!said.done && !fixture) {
    // Still waiting: say "imported" when the retry gets through.
    let finished = false;
    const stop = store.onStatus((st) => {
      if (finished || st !== 'saved') return;
      finished = true;
      if (typeof stop === 'function') stop();
      toast(IMPORT_SAVED, { key: 'import' });
    });
    if (finished && typeof stop === 'function') stop();
  }
}

const IMPORT_SAVED = 'Data imported. Your previous data is in the backups folder.';

/**
 * What to say after an import, from the store's status once its save has settled: "imported"
 * only when the hub has the data ('saved'); otherwise the data is kept on this device and the
 * save goes on (offline, an error, the hub was updated, or a conflict to resolve).
 */
export function importOutcome(status) {
  if (status === 'saved') return { done: true, tone: 'info', text: IMPORT_SAVED };
  if (status === 'fixture') return { done: true, tone: 'info', text: 'Imported into the sample data. Nothing is saved in sample-data mode.' };
  if (status === 'conflict') return { done: false, tone: 'error', text: 'Not saved yet: the hub’s data also changed. Choose which version to keep; the import is kept on this device meanwhile.' };
  if (status === 'build-mismatch' || status === 'outdated') return { done: false, tone: 'error', text: 'Not saved yet: the hub was updated. Reload to finish the import; it’s kept on this device meanwhile.' };
  return { done: false, tone: 'error', text: 'Not saved yet: retrying. The import is kept on this device until the hub has it.' };
}

export function render(ctx) {
  const { data, today } = ctx;
  const pr = data.profile;
  const page = h('div', { class: 'page page-narrow' });
  page.append(pageHead({ title: 'Settings', lede: 'Your details drive the calorie, protein and heart-rate numbers. Everything stays on your own hub.' }));
  const touch = () => store.touch();
  const zonesHost = h('div');
  const drawZones = () => zonesHost.replaceChildren(zonesTable(pr, today));
  drawZones();
  const age = ageFrom(pr.birth_year, today);

  page.append(section({ title: 'Profile' }, sheet(null, h('div', { class: 'form-grid' },
    textField({ label: 'Name', value: pr.name, autocomplete: 'given-name', onInput: (v) => { pr.name = v; touch(); } }),
    selectField({ label: 'Sex (for the calorie formula)', value: pr.sex || '', autocomplete: 'sex', options: [{ value: '', label: 'Not set' }, { value: 'male', label: 'Male' }, { value: 'female', label: 'Female' }], onChange: (v) => { pr.sex = v || null; touch(); } }),
    numberField({ label: 'Birth year', value: pr.birth_year, min: 1920, max: 2012, step: 1, autocomplete: 'bday-year', hint: age ? `Age ${age} this year` : 'Used for age-based formulas', onInput: (v) => { pr.birth_year = v; touch(); drawZones(); } }),
    numberField({ label: 'Height', unit: 'cm', value: pr.height_cm, min: 120, max: 230, step: 0.5, onInput: (v) => { pr.height_cm = v; touch(); } }),
    numberField({ label: 'Your usual weight before the injury (optional)', unit: 'kg', value: pr.pre_injury_weight_kg, min: 30, max: 250, step: 0.1, cls: 'span-2', hint: 'Sets your weight band: +0.25 to +0.5 kg a week while you’re below it (muscle you had comes back faster), then +0.15 to +0.3. Leave it blank for +0.2 to +0.4.', onInput: (v) => { pr.pre_injury_weight_kg = isNum(v) && v >= 30 && v <= 250 ? v : null; touch(); } }),
    selectField({ label: 'Injured arm', value: pr.injured_arm || '', options: [{ value: '', label: 'Not set' }, { value: 'left', label: 'Left' }, { value: 'right', label: 'Right' }], onChange: (v) => { pr.injured_arm = v || null; touch(); } }),
    selectField({ label: 'Dominant hand', value: pr.dominant_hand || '', options: [{ value: '', label: 'Not set' }, { value: 'left', label: 'Left' }, { value: 'right', label: 'Right' }], onChange: (v) => { pr.dominant_hand = v || null; touch(); } }),
    dateField({ label: 'Date of the injury (optional)', value: pr.injury_date || '', max: today, cls: 'span-2', hint: 'When set, no clearance can be recorded before this day.', onChange: (v) => { pr.injury_date = isISODate(v) ? v : null; touch(); } }),
    selectField({ label: 'Activity factor', cls: 'span-2', value: String(pr.activity_factor ?? 1.55), options: ACTIVITY.map(([v, l]) => ({ value: String(v), label: `${v}: ${l}` })), onChange: (v) => { pr.activity_factor = Number(v); touch(); } }),
    numberField({ label: 'Calorie surplus', unit: 'kcal', value: pr.surplus_kcal, min: 0, max: 600, step: 25, hint: '250 to 300 for a lean gain', onInput: (v) => { pr.surplus_kcal = isNum(v) ? v : 300; touch(); } }),
    numberField({ label: 'Protein', unit: 'g/kg', value: pr.protein_g_per_kg, min: 1.6, max: 2.2, step: 0.1, hint: '1.6 to 2.2; default 1.8', onInput: (v) => { pr.protein_g_per_kg = isNum(v) ? Math.min(2.2, Math.max(1.6, v)) : 1.8; touch(); } }),
    numberField({ label: 'HRmax override', unit: 'bpm', value: pr.hrmax_override, min: 100, max: 230, step: 1, hint: 'Only if you have a measured value', onInput: (v) => { pr.hrmax_override = v; touch(); drawZones(); } }),
    numberField({ label: 'Resting HR baseline', unit: 'bpm', value: pr.rhr_baseline, min: 30, max: 110, step: 1, hint: 'Used until you have 3 mornings of data', onInput: (v) => { pr.rhr_baseline = v; touch(); } }),
    h('div', { class: 'span-all' }, textareaField({ label: 'Diet notes', value: pr.diet_notes, rows: 2, placeholder: 'Allergies, preferences, foods you avoid', onInput: (v) => { pr.diet_notes = v; touch(); } }))))));

  page.append(section({ title: 'Heart-rate zones' }, sheet(null, zonesHost)));

  const startNote = h('p', { class: 'field-hint' }, isISODate(pr.program_start) ? `Your programme starts ${fmtDay(mondayOf(pr.program_start), { year: true })}.` : `No start date chosen yet: the programme counts from ${fmtDay(programStart(content.program, pr, today), { year: true })} until you pick one.`);
  page.append(section({ title: 'Programme start', sub: 'Always a Monday. Other days snap back to the Monday of that week.' }, sheet(null,
    h('div', { style: { 'max-width': '280px' } }, dateField({ label: 'Start date', value: pr.program_start, compact: true, onChange: (v) => {
      if (!isISODate(v)) return;
      const mon = mondayOf(v);
      pr.program_start = mon;
      touch();
      startNote.textContent = `Your programme starts ${fmtDay(mon, { year: true })}.`;
      if (mon !== v) toast(`Moved to Monday ${fmtDay(mon)}`);
    } })), startNote)));

  page.append(section({ title: 'Fasting periods', sub: 'Optional: for example Ramadan, other religious fasts or planned fasting. Dates count as approximate until you confirm them.' }, fastingEditor(ctx)));
  page.append(section({ title: 'Resting heart rate', sub: 'Readiness compares each morning with your recent average.' }, rhrMethod(ctx)));
  page.append(section({ title: 'My gym: unavailable exercises', sub: 'What your gym doesn’t have, so the hub never suggests it.' }, myGym(ctx)));

  const themeSeg = h('div', { class: 'seg', role: 'group', 'aria-label': 'Theme' });
  const drawTheme = () => themeSeg.replaceChildren(...[['system', 'Match system'], ['light', 'Light'], ['dark', 'Dark']].map(([v, l]) => h('button', { type: 'button', 'aria-pressed': String(getTheme() === v), onClick: () => { setTheme(v); drawTheme(); themeSeg.querySelector('[aria-pressed="true"]')?.focus(); } }, l)));
  drawTheme();
  page.append(section({ title: 'Appearance' }, themeSeg));

  const ob = onboardingState(data);
  page.append(section({ title: 'Getting started', sub: 'The short welcome: your details, start date, clearances and the safety rules.' }, sheet(null,
    h('p', { class: 'small muted', style: { 'margin-bottom': '12px' } }, ob?.safety_ack_at
      ? `You read and accepted the safety rules on ${fmtDay(ob.safety_ack_at.slice(0, 10), { year: true })}.`
      : ob?.skipped_at ? 'You skipped the welcome. It only takes two minutes.' : 'You haven’t been through the welcome yet.'),
    h('a', { class: 'btn', href: '#/welcome' }, 'Run the welcome again'))));

  // data
  const where = h('p', { class: 'small' }, 'Checking…');
  const fixture = store.isFixtureMode();
  if (fixture) where.textContent = 'Sample-data mode (?fixtures=1): nothing is saved, and the real data file is untouched.';
  else apiHealth().then((x) => {
    where.replaceChildren('Data file: ', h('code', null, x.data_file), h('br'), 'Backups: ', h('code', null, x.backup_dir), ` (${fmtNum(x.backups)} so far). A daily copy is kept automatically on the first save of each day.`);
  }).catch(() => { where.textContent = 'The hub server is not responding.'; });
  const fileInput = h('input', { type: 'file', accept: 'application/json,.json', class: 'visually-hidden', id: 'import-file', tabindex: '-1', 'aria-hidden': 'true', onChange: async (e) => {
    const f = e.target.files && e.target.files[0];
    e.target.value = '';
    if (f) await runImport(ctx, f);
  } });
  const csvBtn = (kind, label) => h('button', { type: 'button', class: 'btn btn-sm', onClick: () => {
    try {
      const out = exportCSV(store.get(), kind, { today, exName });
      download(out.filename, out.text, out.mime);
      toast(`${label} downloaded`);
    } catch (err) { toast(`Couldn’t export: ${err.message}`, { tone: 'error' }); }
  } }, label);
  page.append(section({ title: 'Your data', sub: 'Saved automatically to the data file on your hub as you type.' }, sheet(null, h('div', { class: 'stack' },
    where,
    h('div', { class: 'row' },
      h('button', { type: 'button', class: 'btn', onClick: () => { download(`fitness-hub-data-${todayISO()}.json`, JSON.stringify(store.get(), null, 1)); toast('Export downloaded'); } }, 'Export as JSON'),
      h('button', { type: 'button', class: 'btn', onClick: () => fileInput.click() }, 'Import a JSON file'),
      fileInput,
      h('button', { type: 'button', class: 'btn', disabled: fixture, onClick: async () => {
        try { await store.flush(); const r = await apiBackup(); toast(`Backup saved: ${r.file}`); } catch (err) { toast(`Backup failed: ${err.message}`, { tone: 'error' }); }
      } }, 'Back up now')),
    h('p', { class: 'field-hint' }, 'Import checks the whole file first, backs up your current data, and only then replaces it. If the backup fails, nothing is imported.'),
    h('div', null, h('p', { class: 'field-label', style: { 'margin-bottom': '6px' } }, 'Spreadsheet (CSV) exports'),
      h('div', { class: 'row' }, csvBtn('checkins', 'Check-ins CSV'), csvBtn('workouts', 'Sessions CSV'), csvBtn('hikes', 'Hikes CSV')),
      h('p', { class: 'field-hint', style: { 'margin-top': '6px' } }, 'Opens in Excel or Google Sheets. Sessions have one row per set and per cardio entry.')),
    h('p', { class: 'small muted' }, 'To restore a backup: stop the hub, copy a file from the backups folder over data.json, then start the hub again. Or use Import here.')))));

  // sync details (PERF8: redrawn at most every 300 ms, however often the status changes)
  const syncHost = h('div');
  const drawSync = () => {
    const si = typeof store.syncInfo === 'function' ? store.syncInfo() : null;
    const log = typeof store.conflictLog === 'function' ? store.conflictLog() : [];
    if (!si) { syncHost.replaceChildren(h('p', { class: 'small muted' }, 'Sync details aren’t available.')); return; }
    const rows = [
      ['Status', { saved: 'All changes saved', dirty: 'Saving…', saving: 'Saving…', error: 'Not saved yet: retrying', conflict: 'Waiting for you to choose between two versions', fixture: 'Sample data: nothing is saved', idle: 'Loading', outdated: 'The hub was updated: reload to keep saving', 'build-mismatch': 'The hub was updated: reload to keep saving' }[si.status] || si.status],
      ['Last saved', si.savedAt ? new Date(si.savedAt).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' }) : '–'],
      ['Changes waiting', fmtNum(si.pendingChanges || 0)],
      ['Size of your data', Number.isFinite(si.bytes) ? `${fmtNum(si.bytes / 1024, 0)} KB of the 10 MB limit` : '–'],
      ['Safety copy in this browser', si.pendingStored === false ? 'Couldn’t be stored (browser storage is full)' : 'Kept until the hub confirms each save'],
    ];
    syncHost.replaceChildren(
      si.nearLimit ? h('p', { class: 'notice notice-warn small', style: { 'margin-bottom': '12px' } }, 'Your data is close to the 10 MB limit. Export a copy, then ask for older entries to be archived.') : null,
      si.pendingStored === false ? h('p', { class: 'notice notice-warn small', style: { 'margin-bottom': '12px' } }, 'This browser couldn’t keep its safety copy of unsaved changes. Keep this tab open until the status says “All changes saved”.') : null,
      h('ul', { class: 'kv-list' }, rows.map(([k, v]) => h('li', null, h('span', null, k), h('span', { class: 'kv-v' }, v)))),
      h('div', { style: { 'margin-top': '16px' } },
        h('h3', { class: 'mini-title' }, 'Choices made when the same entry changed in two places'),
        log.length
          ? h('div', { class: 'table-wrap' }, h('table', { class: 'table table-compact' },
            h('thead', null, h('tr', null, ['When', 'What', 'Kept', 'This tab', 'Elsewhere'].map((t) => h('th', { scope: 'col' }, t)))),
            h('tbody', null, log.slice(-12).reverse().map((x) => h('tr', null,
              h('td', { class: 'nowrap' }, x.at ? new Date(x.at).toLocaleString('en-GB', { dateStyle: 'short', timeStyle: 'short' }) : '–'),
              h('td', null, x.label || (Array.isArray(x.path) ? x.path.join(' › ') : '')),
              h('td', null, x.kept === 'theirs' ? 'Elsewhere' : 'This tab'),
              h('td', { class: 'small' }, shortVal(x.mine)),
              h('td', { class: 'small' }, shortVal(x.theirs)))))))
          : h('p', { class: 'small muted' }, 'None so far.'),
        log.length && typeof store.clearConflictLog === 'function' ? h('div', { class: 'block-actions' }, h('button', { type: 'button', class: 'btn btn-sm btn-ghost', onClick: () => { store.clearConflictLog(); drawSync(); toast('Conflict history cleared'); } }, 'Clear this history')) : null));
  };
  drawSync();
  const later = debounce(() => { if (syncHost.isConnected) drawSync(); }, 300);
  const unsub = store.onStatus(later);
  ctx.onCleanup(() => { later.cancel(); if (typeof unsub === 'function') unsub(); });
  page.append(section({ title: 'Sync details', sub: 'For when the hub is open in more than one tab or on more than one device.' }, sheet(null, syncHost)));

  // data check
  const issuesHost = h('div');
  page.append(section({ title: 'Check my data', sub: 'Looks for typing slips, such as 805 kg instead of 80.5, across everything you’ve logged.' }, sheet(null,
    h('button', { type: 'button', class: 'btn', onClick: () => {
      const d = store.get();
      const list = dataIssues(d, { limit: 200 });
      const whereOf = (x) => {
        if (x.key && isISODate(String(x.key))) return `${x.collection === 'checkins' ? 'Check-in' : x.collection === 'measurements' ? 'Measurements' : 'Rehab log'}, ${fmtDay(String(x.key), { year: true })}`;
        if (x.collection === 'hikes') { const hk = d.hikes.find((y) => y.id === x.key); return hk ? `Hike, ${fmtDay(hk.date, { year: true })}${hk.name ? `: ${hk.name}` : ''}` : 'Hike'; }
        if (x.collection === 'workouts') { const w = d.workouts.find((y) => y.id === x.key); return w ? `Session, ${fmtDay(w.date, { year: true })}${w.session_name ? `: ${w.session_name}` : ''}` : 'Session'; }
        return '';
      };
      issuesHost.replaceChildren(list.length
        ? h('div', { style: { 'margin-top': '12px' } }, h('p', { class: 'small' }, `${fmtNum(list.length)} thing${list.length === 1 ? '' : 's'} to check:`),
          h('ul', { class: 'problem-list' }, list.slice(0, 40).map((x) => h('li', null, whereOf(x) ? h('strong', null, `${whereOf(x)}. `) : null, x.message)),
            list.length > 40 ? h('li', { class: 'muted' }, `…and ${fmtNum(list.length - 40)} more.`) : null))
        : h('p', { class: 'small', style: { 'margin-top': '12px' } }, 'Nothing looks out of place.'));
    } }, 'Check my data'),
    h('div', { 'aria-live': 'polite' }, issuesHost))));

  const uk = (t) => String(t || '').replace(/\bProgram\b/g, 'Programme');
  const statusList = h('ul', { class: 'status-list' }, content.status.map((s) => h('li', null, h('span', null, uk(s.label), h('span', { class: 'small muted' }, ` ${s.file}`)), h('span', { class: `state-${s.state}` }, STATE_LABEL[s.state] || s.state))));
  let probs = [];
  try { probs = contentProblems(); } catch { probs = []; }
  probs.sort((a, b) => Number(b.safety) - Number(a.safety));
  const probBox = probs.length ? h('div', { style: { 'margin-top': '14px' } },
    h('h3', { class: 'mini-title' }, `Warnings from the content checks (${fmtNum(probs.length)})`),
    h('p', { class: 'small muted', style: { 'margin-bottom': '6px' } }, 'The files are still used. Safety warnings come first; the hub stays on the safe side (an unknown gate, or an exercise missing from the library, counts as locked).'),
    h('ul', { class: 'problem-list' }, probs.slice(0, 30).map((p) => h('li', { class: p.safety ? 'is-safety' : null }, h('strong', null, `${uk(p.label)}: `), p.message))),
    probs.length > 30 ? h('p', { class: 'small muted' }, `…and ${fmtNum(probs.length - 30)} more.`) : null) : null;
  page.append(section({ title: 'Coaching content', sub: `Loaded ${content.loadedAt ? content.loadedAt.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }) : ''} from ${content.base}.` }, sheet(null,
    statusList,
    probBox,
    h('div', { class: 'block-actions' }, h('button', { type: 'button', class: 'btn', onClick: async () => { await loadContent({ fixtures: content.fixtures }); toast('Content reloaded'); ctx.rerender(); } }, 'Reload content')))));

  page.append(section({ title: 'Safety' }, sheet(null, h('div', { class: 'legal stack-sm' },
    h('p', null, 'This hub is a training diary and coaching guide. It is not medical advice and does not diagnose anything.'),
    h('p', null, 'Your fracture clinic and physio decide what your arm can do. Their advice overrides anything here, and nothing should go through the injured arm until they clear it.'),
    h('p', null, 'If you notice a red flag (worsening pain, new swelling, redness or heat, wound discharge, fever, numbness, a pale or cold hand, a new deformity, or a fall onto the arm), or arm pain of 7 out of 10 or more, stop and contact the fracture clinic or NHS 111. In an emergency call 999.'),
    h('p', null, 'Stop any exercise that causes sharp pain, dizziness, chest pain or unusual breathlessness. Dark, cola-coloured urine with severe muscle pain or swelling after training needs same-day medical advice.')))));
  return page;
}
