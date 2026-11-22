// Light / dark / match-system preference, stored in this browser only.

const KEY = 'fitness-hub:theme';
const LABEL = { system: 'Theme: match system', light: 'Theme: light', dark: 'Theme: dark' };

export function getTheme() {
  try {
    const t = localStorage.getItem(KEY);
    return t === 'light' || t === 'dark' ? t : 'system';
  } catch { return 'system'; }
}

export function applyTheme() {
  const t = getTheme();
  if (t === 'system') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', t);
  const btn = document.getElementById('theme-toggle');
  if (btn) btn.textContent = LABEL[t];
}

export function setTheme(t) {
  try {
    if (t === 'system') localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, t);
  } catch { /* preference just won't persist */ }
  applyTheme();
}

export function cycleTheme() {
  const order = ['system', 'light', 'dark'];
  setTheme(order[(order.indexOf(getTheme()) + 1) % order.length]);
}
