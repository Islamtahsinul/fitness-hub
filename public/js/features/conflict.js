// "Changed in two places" dialog for the store's conflict API (onConflict / resolveConflict).
// Shown when the same field was changed to different values here and in another tab or device.
// Nothing is lost either way: the store archives the losing values (Settings → Sync details).

import { h, uid, toast } from '../dom.js';
import * as store from '../store.js';
import { fmtDay, isISODate } from '../dates.js';

const COLLECTION_LABEL = {
  checkins: 'Check-in', workouts: 'Session', hikes: 'Hike', tests: 'Test result', measurements: 'Measurements',
  'arm.logs': 'Rehab log', 'arm.appointments': 'Appointment', 'arm.physio_exercises': 'Physio exercise', weekly_reviews: 'Weekly review',
};
const FIELD_LABEL = {
  weight_kg: 'weight', rhr: 'resting heart rate', hrv: 'HRV', sleep_h: 'hours asleep', sleep_q: 'sleep quality', energy: 'energy',
  soreness: 'soreness', mood: 'mood', stress: 'stress', arm_pain: 'arm pain', arm_flags: 'red flags', steps: 'steps', protein_g: 'protein',
  calories: 'calories', water_l: 'water', creatine: 'creatine', notes: 'notes', duration_min: 'duration', rpe: 'effort (RPE)',
  distance_km: 'distance', ascent_m: 'ascent', pack_kg: 'pack weight', outcome: 'outcome', wins: 'wins', struggles: 'struggles', next_focus: 'next week’s focus',
};

/** "Check-in, Fri 31 Jan 2025: weight" from a conflict item's collection, key and field (pure). */
export function conflictLabel(item) {
  if (!item) return '';
  const coll = COLLECTION_LABEL[item.collection];
  const field = String(item.field || '').split('.').filter((x) => !/^\d+$/.test(x));
  const last = field[field.length - 1] || '';
  const what = FIELD_LABEL[last] || last.replace(/_/g, ' ');
  if (coll) {
    const key = item.key && isISODate(String(item.key)) ? fmtDay(String(item.key), { year: true }) : null;
    return `${coll}${key ? `, ${key}` : ''}${what ? `: ${what}` : ''}`;
  }
  const path = Array.isArray(item.path) ? item.path.map(String) : [];
  if (path[0] === 'profile') return `Profile: ${path.slice(1).map((x) => FIELD_LABEL[x] || x.replace(/_/g, ' ')).join(', ')}`;
  return item.label || path.join(' › ');
}

/** Short, human text for a conflicting value (pure; exported for tests). */
export function formatConflictValue(v) {
  if (v === undefined) return 'Deleted';
  if (v === null || v === '') return 'Empty';
  if (v === true) return 'Yes';
  if (v === false) return 'No';
  if (typeof v === 'number') return new Intl.NumberFormat('en-GB', { maximumFractionDigits: 2 }).format(v);
  if (typeof v === 'string') return v.length > 90 ? `“${v.slice(0, 87)}…”` : `“${v}”`;
  if (Array.isArray(v)) return v.length ? (v.every((x) => typeof x !== 'object') ? v.join(', ') : `${v.length} items`) : 'None';
  if (typeof v === 'object') {
    const keys = Object.keys(v).filter((k) => v[k] !== null && v[k] !== '' && !(Array.isArray(v[k]) && !v[k].length));
    if ('date' in v && keys.length) return `Entry for ${v.date}${keys.length > 1 ? ` (${keys.length - 1} fields)` : ''}`;
    return keys.length ? `${keys.length} field${keys.length === 1 ? '' : 's'}` : 'Empty';
  }
  return String(v);
}

let open = null;

export function closeConflictDialog() {
  if (open) { open.close(); open.remove(); open = null; }
}

export function showConflictDialog(conflict) {
  closeConflictDialog();
  if (!conflict || !Array.isArray(conflict.items) || !conflict.items.length) return;
  const choices = new Map(conflict.items.map((it) => [it.id, 'mine']));
  const dlg = h('dialog', { class: 'modal conflict-dialog', 'aria-labelledby': 'conflict-title' });
  open = dlg;
  const resolve = async (choice, message) => {
    closeConflictDialog();
    const r = await store.resolveConflict(choice);
    toast(r?.status === 'error' ? 'Saved on this computer. It will reach the hub when the server is back.' : message);
  };
  const rows = conflict.items.slice(0, 30).map((it) => {
    const name = uid('cf');
    const opt = (value, label, text) => h('label', { class: 'conflict-opt' },
      h('input', { type: 'radio', name, value, checked: value === 'mine', onChange: () => choices.set(it.id, value) }),
      h('span', null, h('span', { class: 'conflict-who' }, label), h('span', { class: 'conflict-val' }, text)));
    return h('fieldset', { class: 'conflict-item' },
      h('legend', { class: 'conflict-label' }, conflictLabel(it) || it.label || it.id),
      opt('mine', 'This tab', formatConflictValue(it.mine)),
      opt('theirs', 'Saved elsewhere', formatConflictValue(it.theirs)));
  });
  const more = conflict.items.length - rows.length;
  dlg.append(h('div', { class: 'modal-body' },
    h('h2', { class: 'modal-title', id: 'conflict-title' }, 'Changed in two places'),
    h('p', { class: 'modal-text' }, `${conflict.count === 1 ? 'One entry was' : `${conflict.count} entries were`} changed here and in another tab or on another device, to different values. Saving is paused until you choose. Whichever you don’t keep is archived in Settings, so nothing is lost.`),
    h('div', { class: 'conflict-list' }, rows),
    more > 0 ? h('p', { class: 'small muted' }, `${more} more follow the choice for the rest (this tab’s version).`) : null,
    h('div', { class: 'modal-actions conflict-actions' },
      h('button', { type: 'button', class: 'btn btn-ghost', onClick: () => { closeConflictDialog(); toast('Saving is paused. Use “Resolve” next to the save status when you’re ready.', { timeout: 7000 }); } }, 'Decide later'),
      h('button', { type: 'button', class: 'btn', onClick: () => resolve('theirs', 'Kept the version saved elsewhere') }, 'Keep all saved elsewhere'),
      h('button', { type: 'button', class: 'btn', onClick: () => resolve('mine', 'Kept this tab’s version') }, 'Keep all from this tab'),
      h('button', { type: 'button', class: 'btn btn-primary', onClick: () => {
        const obj = { default: 'mine' };
        for (const [id, c] of choices) obj[id] = c;
        resolve(obj, 'Your choices are saved');
      } }, 'Save my choices'))));
  dlg.addEventListener('cancel', (e) => { e.preventDefault(); closeConflictDialog(); });
  document.body.appendChild(dlg);
  dlg.showModal();
  dlg.querySelector('input')?.focus();
}
