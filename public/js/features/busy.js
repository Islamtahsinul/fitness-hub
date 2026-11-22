// One action at a time from a button (pure, no DOM at import time).
//
// Round 4 (finding 9): "Save session" is disabled and shows a busy state while its save is in
// flight, so a double tap (or a tap during a slow tunnel) can never start a second save or
// show a second toast.

/**
 * Wraps an async action so it runs at most once at a time: a call made while one is in flight is
 * ignored (it returns null instead of starting another). run.busy() says whether one is out.
 * onBusy(true | false) is called as the flight starts and settles (for the button's state).
 */
export function singleFlight(fn, { onBusy = null } = {}) {
  let flight = null;
  const run = (...args) => {
    if (flight) return null;
    if (typeof onBusy === 'function') { try { onBusy(true); } catch { /* ignore */ } }
    flight = (async () => {
      try { return await fn(...args); } finally {
        flight = null;
        if (typeof onBusy === 'function') { try { onBusy(false); } catch { /* ignore */ } }
      }
    })();
    return flight;
  };
  run.busy = () => !!flight;
  return run;
}

/**
 * Shows a button as busy: disabled, aria-busy, and its label swapped for `label` (the old label
 * comes back with setBusy(btn, false)). Keyboard focus stays on the button.
 */
export function setBusy(btn, on, label = 'Saving…') {
  if (!btn) return;
  const doc = typeof document !== 'undefined' ? document : null;
  const ds = btn.dataset || {};
  if (on) {
    if (ds.idleLabel === undefined) ds.idleLabel = btn.textContent;
    ds.busyFocus = doc && doc.activeElement === btn ? '1' : '';
    btn.disabled = true;
    btn.setAttribute('aria-busy', 'true');
    btn.classList?.add('is-busy');
    btn.textContent = label;
    return;
  }
  btn.disabled = false;
  btn.removeAttribute('aria-busy');
  btn.classList?.remove('is-busy');
  if (ds.idleLabel !== undefined) { btn.textContent = ds.idleLabel; delete ds.idleLabel; }
  // A disabled button loses focus in some browsers: put it back so keyboard users stay put.
  const refocus = ds.busyFocus === '1';
  delete ds.busyFocus;
  if (refocus && doc && (!doc.activeElement || doc.activeElement === doc.body) && btn.isConnected !== false && typeof btn.focus === 'function') {
    try { btn.focus({ preventScroll: true }); } catch { /* ignore */ }
  }
}
