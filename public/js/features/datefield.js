// UK date entry: a dd/mm/yyyy text input with validation, a live "Fri 31 Jan 2025" read-back
// (so day/month order can never be misread) and a Monday-first calendar dialog as a fallback.
// Built with the safe DOM helpers only.

import { h, s, uid } from '../dom.js';
import { isISODate, todayISO, addDays, fmtDay, MONTHS_LONG, WEEKDAYS, WEEKDAYS_LONG, weekdayIndex } from '../dates.js';
import { checkUKDate, formatUKDate, isCompleteDateText, monthGrid } from './ukdate.js';

function calendarIcon() {
  const svg = s('svg', { width: 18, height: 18, viewBox: '0 0 20 20', 'aria-hidden': 'true', focusable: 'false', class: 'ico' });
  svg.append(
    s('rect', { x: 2.5, y: 4, width: 15, height: 13.5, rx: 2 }),
    s('path', { d: 'M2.5 8.5h15M6.5 2v4M13.5 2v4' }),
    s('path', { d: 'M6 12h2M9 12h2M12 12h2M6 15h2M9 15h2', class: 'ico-thin' }));
  return svg;
}

const longDay = (iso) => `${WEEKDAYS_LONG[weekdayIndex(iso)]} ${Number(iso.slice(8))} ${MONTHS_LONG[Number(iso.slice(5, 7)) - 1]} ${iso.slice(0, 4)}`;

/**
 * Calendar dialog. Resolves 'YYYY-MM-DD' or null. Arrow keys move by day/week, Page Up/Down
 * by month, Home/End to the start/end of the week, Enter picks, Esc closes.
 */
export function pickDate({ value = null, min = null, max = null, title = 'Choose a date' } = {}) {
  return new Promise((resolve) => {
    const today = todayISO();
    let focus = isISODate(value) ? value : (isISODate(max) && today > max ? max : isISODate(min) && today < min ? min : today);
    let shownY = Number(focus.slice(0, 4));
    let shownM = Number(focus.slice(5, 7));
    const titleId = uid('cal');
    const monthLabel = h('p', { class: 'cal-month', 'aria-live': 'polite', id: `${titleId}-m` });
    const grid = h('table', { class: 'cal-grid', role: 'grid', 'aria-labelledby': `${titleId}-m` });
    const dlg = h('dialog', { class: 'modal cal-dialog', 'aria-labelledby': titleId });
    const prev = document.activeElement;
    const done = (v) => { dlg.close(); dlg.remove(); if (prev && prev.focus) prev.focus({ preventScroll: true }); resolve(v); };
    const allowed = (iso) => !(isISODate(min) && iso < min) && !(isISODate(max) && iso > max);
    const draw = (focusIt = false) => {
      monthLabel.textContent = `${MONTHS_LONG[shownM - 1]} ${shownY}`;
      const cells = monthGrid(shownY, shownM);
      const body = h('tbody');
      for (let r = 0; r < 6; r++) {
        const tr = h('tr');
        for (let c = 0; c < 7; c++) {
          const { iso, inMonth } = cells[r * 7 + c];
          const ok = allowed(iso);
          const btn = h('button', {
            type: 'button', class: ['cal-day', !inMonth && 'is-out', iso === today && 'is-today', iso === value && 'is-picked'],
            tabindex: iso === focus ? '0' : '-1', 'aria-label': longDay(iso), 'aria-disabled': ok ? null : 'true',
            'aria-pressed': iso === value ? 'true' : null, 'aria-current': iso === today ? 'date' : null, dataset: { iso },
            onClick: () => { if (ok) done(iso); },
          }, String(Number(iso.slice(8))));
          tr.append(h('td', { role: 'gridcell' }, btn));
        }
        body.append(tr);
      }
      grid.replaceChildren(
        h('thead', null, h('tr', null, WEEKDAYS.map((d, i) => h('th', { scope: 'col', abbr: WEEKDAYS_LONG[i] }, d.slice(0, 2))))),
        body);
      if (focusIt) grid.querySelector(`[data-iso="${focus}"]`)?.focus();
    };
    const moveTo = (iso) => {
      focus = iso;
      const y = Number(iso.slice(0, 4));
      const m = Number(iso.slice(5, 7));
      shownY = y; shownM = m;
      draw(true);
    };
    const shiftMonth = (n) => {
      let y = Number(focus.slice(0, 4));
      let m = Number(focus.slice(5, 7)) + n;
      while (m < 1) { m += 12; y -= 1; }
      while (m > 12) { m -= 12; y += 1; }
      const dim = new Date(Date.UTC(y, m, 0)).getUTCDate();
      const d = Math.min(Number(focus.slice(8)), dim);
      moveTo(`${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`);
    };
    grid.addEventListener('keydown', (e) => {
      const map = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 };
      if (e.key in map) { e.preventDefault(); moveTo(addDays(focus, map[e.key])); }
      else if (e.key === 'PageUp') { e.preventDefault(); shiftMonth(e.shiftKey ? -12 : -1); }
      else if (e.key === 'PageDown') { e.preventDefault(); shiftMonth(e.shiftKey ? 12 : 1); }
      else if (e.key === 'Home') { e.preventDefault(); moveTo(addDays(focus, -weekdayIndex(focus))); }
      else if (e.key === 'End') { e.preventDefault(); moveTo(addDays(focus, 6 - weekdayIndex(focus))); }
    });
    const navBtn = (label, n, d) => h('button', { type: 'button', class: 'icon-btn', 'aria-label': label, onClick: () => shiftMonth(n) },
      s('svg', { width: 18, height: 18, viewBox: '0 0 20 20', 'aria-hidden': 'true', class: 'ico' }, s('path', { d })));
    dlg.append(h('div', { class: 'modal-body' },
      h('h2', { class: 'modal-title', id: titleId }, title),
      h('div', { class: 'cal-head' }, navBtn('Previous month', -1, 'M12.5 4.5 7 10l5.5 5.5'), monthLabel, navBtn('Next month', 1, 'M7.5 4.5 13 10l-5.5 5.5')),
      grid,
      h('div', { class: 'modal-actions' },
        allowed(today) ? h('button', { type: 'button', class: 'btn btn-ghost', onClick: () => done(today) }, `Today, ${fmtDay(today)}`) : null,
        h('button', { type: 'button', class: 'btn', onClick: () => done(null) }, 'Cancel'))));
    dlg.addEventListener('cancel', (e) => { e.preventDefault(); done(null); });
    dlg.addEventListener('click', (e) => { if (e.target === dlg) done(null); });
    document.body.appendChild(dlg);
    draw(false);
    dlg.showModal();
    grid.querySelector(`[data-iso="${focus}"]`)?.focus();
  });
}

/**
 * The date control: returns {el, input, set(iso), get()}. onChange(iso) fires with a valid ISO
 * date (or '' when cleared and not required). While typing it fires only once a four-digit year is in.
 */
export function ukDateInput({ id = uid('d'), value = '', onChange = () => {}, min = null, max = null, required = false, describedBy = null, label = 'Date', compact = false, minError = null, maxError = null }) {
  let committed = isISODate(value) ? value : '';
  const errId = `${id}-err`;
  const readId = `${id}-read`;
  const input = h('input', {
    id, type: 'text', class: 'input date-text', inputmode: 'numeric', autocomplete: 'off', spellcheck: 'false',
    placeholder: 'dd/mm/yyyy', value: formatUKDate(committed), maxlength: 24,
    'aria-describedby': [describedBy, readId, errId].filter(Boolean).join(' '), required: required || null,
  });
  const err = h('p', { class: 'field-error', id: errId, role: 'alert', hidden: true });
  const read = h('p', { class: 'date-read', id: readId }, committed && !compact ? fmtDay(committed, { year: true }) : '');
  const today = () => todayISO();
  const showError = (msg) => {
    err.textContent = msg;
    err.hidden = !msg;
    if (msg) input.setAttribute('aria-invalid', 'true'); else input.removeAttribute('aria-invalid');
  };
  const showRead = (iso) => { read.textContent = iso && !compact ? fmtDay(iso, { year: true }) : ''; };
  const fire = (iso) => {
    if (iso === committed) return;
    committed = iso;
    onChange(iso);
  };
  const commit = () => {
    const r = checkUKDate(input.value, { min, max, required, today: today(), minError, maxError });
    if (r.error) { showError(r.error); return false; }
    showError('');
    if (r.iso) { input.value = formatUKDate(r.iso); showRead(r.iso); fire(r.iso); }
    else { showRead(''); fire(''); }
    return true;
  };
  input.addEventListener('input', () => {
    const r = checkUKDate(input.value, { min, max, required, today: today(), partial: true, minError, maxError });
    showError(r.error);
    showRead(r.iso || '');
    if (r.iso && isCompleteDateText(input.value)) fire(r.iso);
  });
  input.addEventListener('blur', commit);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { if (!commit()) e.preventDefault(); }
    else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      const base = checkUKDate(input.value, { today: today() }).iso || committed || today();
      const next = addDays(base, e.key === 'ArrowUp' ? 1 : -1);
      if ((isISODate(min) && next < min) || (isISODate(max) && next > max)) return;
      e.preventDefault();
      input.value = formatUKDate(next);
      showError(''); showRead(next); fire(next);
    }
  });
  const calBtn = h('button', {
    type: 'button', class: 'icon-btn date-cal', 'aria-label': `Choose ${label.toLowerCase()} from a calendar`,
    onClick: async () => {
      const picked = await pickDate({ value: committed || null, min, max, title: label });
      if (!picked) { input.focus(); return; }
      input.value = formatUKDate(picked);
      showError(''); showRead(picked); fire(picked);
      input.focus();
    },
  }, calendarIcon());
  const el = h('div', { class: ['date-input', compact && 'date-input-compact'] }, h('div', { class: 'date-row' }, input, calBtn), read, err);
  return {
    el, input,
    set(iso) { committed = isISODate(iso) ? iso : ''; input.value = formatUKDate(committed); showError(''); showRead(committed); },
    get: () => committed,
  };
}

/** Labelled field wrapper with the same signature as components.dateField. The label names the format. */
export function ukDateField({ label, value, onChange, hint = null, cls = null, max = null, min = null, required = false, compact = false, minError = null, maxError = null }) {
  const id = uid('f');
  const hintId = hint ? `${id}-hint` : null;
  const ctl = ukDateInput({ id, value, onChange, min, max, required, describedBy: hintId, label, compact, minError, maxError });
  return h('div', { class: ['field', 'field-date', cls] },
    h('label', { class: 'field-label', for: id }, label, h('span', { class: 'field-format' }, ' (dd/mm/yyyy)')),
    ctl.el,
    hint ? h('p', { class: 'field-hint', id: hintId }, hint) : null);
}

/** Ask for a date (typed day first, or picked from a calendar); resolves 'YYYY-MM-DD' or null. */
export function promptDate({ title, body = '', value, confirmText = 'Save', max = null, min = null, minError = null, maxError = null }) {
  return new Promise((resolve) => {
    let picked = value || '';
    const ctl = ukDateInput({ id: 'dlg-date', value, min, max, required: true, label: 'Date', minError, maxError, onChange: (v) => { picked = v; } });
    const dlg = h('dialog', { class: 'modal', 'aria-labelledby': 'dlg-title' });
    const prev = document.activeElement;
    const done = (v) => { dlg.close(); dlg.remove(); if (prev && prev.isConnected && prev.focus) prev.focus({ preventScroll: true }); resolve(v); };
    dlg.append(
      h('form', { method: 'dialog', class: 'modal-body', onSubmit: (e) => {
        e.preventDefault();
        ctl.input.dispatchEvent(new Event('blur'));
        if (picked && !ctl.input.hasAttribute('aria-invalid')) done(picked);
        else ctl.input.focus();
      } },
        h('h2', { id: 'dlg-title', class: 'modal-title' }, title),
        typeof body === 'string' ? h('p', { class: 'modal-text' }, body) : body,
        h('div', { class: 'field' }, h('label', { class: 'field-label', for: 'dlg-date' }, 'Date', h('span', { class: 'field-format' }, ' (dd/mm/yyyy)')), ctl.el),
        h('div', { class: 'modal-actions' },
          h('button', { type: 'button', class: 'btn', onClick: () => done(null) }, 'Cancel'),
          h('button', { type: 'submit', class: 'btn btn-primary' }, confirmText))));
    dlg.addEventListener('cancel', (e) => { e.preventDefault(); done(null); });
    document.body.appendChild(dlg);
    dlg.showModal();
    ctl.input.focus();
    ctl.input.select();
  });
}
