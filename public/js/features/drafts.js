// Form drafts that survive a re-render, a date change or a trip to another page (PE6).
// Used by forms that only write to your data when you press Save (rehab log, measurements,
// test results, the hike log). Drafts live in this tab's sessionStorage until you save or
// discard them, and the app asks before you close the tab while one is open.
// Pure apart from storage access (falls back to memory in Node).

const PREFIX = 'fitness-hub:draft:';
const memory = new Map();

function storage() {
  try {
    if (typeof sessionStorage !== 'undefined' && sessionStorage) return sessionStorage;
  } catch { /* blocked */ }
  return null;
}

/** The saved draft object for `key`, or null. */
export function loadDraft(key) {
  const st = storage();
  let raw = null;
  try { raw = st ? st.getItem(PREFIX + key) : memory.get(key) ?? null; } catch { raw = memory.get(key) ?? null; }
  if (!raw) return null;
  try {
    const v = JSON.parse(raw);
    return v && typeof v === 'object' ? v : null;
  } catch { return null; }
}

/** Saves (replaces) the draft for `key`. Only call it for something the person typed. */
export function saveDraft(key, value) {
  const raw = JSON.stringify({ ...value, saved_at: new Date().toISOString() });
  memory.set(key, raw);
  const st = storage();
  try { if (st) st.setItem(PREFIX + key, raw); } catch { /* storage full: the memory copy still survives re-renders */ }
}

export function clearDraft(key) {
  memory.delete(key);
  const st = storage();
  try { if (st) st.removeItem(PREFIX + key); } catch { /* ignore */ }
}

/** Keys of every open draft in this tab. */
export function draftKeys() {
  const st = storage();
  const keys = new Set(memory.keys());
  try {
    if (st) for (let i = 0; i < st.length; i++) { const k = st.key(i); if (k && k.startsWith(PREFIX)) keys.add(k.slice(PREFIX.length)); }
  } catch { /* ignore */ }
  return [...keys];
}

/** True while any form has typed-in values that haven't been saved. */
export function hasDirtyDrafts() {
  return draftKeys().length > 0;
}

/**
 * A small helper for one form: draft(key, defaults) returns {value, set(field, v), merge(obj),
 * clear(), dirty}. `value` starts from the stored draft (if any) over the defaults.
 */
export function formDraft(key, defaults = {}) {
  const stored = loadDraft(key);
  const state = { ...defaults, ...(stored || {}) };
  delete state.saved_at;
  const api = {
    value: state,
    dirty: !!stored,
    set(field, v) { state[field] = v; api.dirty = true; saveDraft(key, state); },
    merge(obj) { Object.assign(state, obj); api.dirty = true; saveDraft(key, state); },
    clear() { clearDraft(key); api.dirty = false; },
  };
  return api;
}
