// Runs before the first paint (no inline scripts under the CSP):
//  1. applies a saved light/dark choice;
//  2. starts the data and content requests straight away (PERF5), so they travel while the page
//     modules load. api.js uses each entry of window.__hubPrefetch once, for a plain GET of exactly
//     that path, and falls back to a normal request if an entry fails.
(function () {
  try {
    var t = window.localStorage.getItem('fitness-hub:theme');
    if (t === 'light' || t === 'dark') document.documentElement.setAttribute('data-theme', t);
  } catch (e) { /* storage unavailable: follow the system setting */ }

  try {
    if (typeof window.fetch !== 'function' || window.__hubPrefetch) return;
    var fixtures = /(?:^|[?&])fixtures=1(?:&|$)/.test(window.location.search || '');
    var base = fixtures ? '/dev-fixtures/' : '/content/';
    var files = ['program.json', 'exercises.json', 'exercises/part-a.json', 'exercises/part-b.json', 'tests.json',
      'hikes.json', 'nutrition.json', 'arm.json', 'guide/index.json'];
    var pf = {};
    var quiet = function (p) { p.catch(function () { /* the normal request will report it */ }); return p; };
    if (!fixtures) pf['/api/data'] = quiet(window.fetch('/api/data', { cache: 'no-store', credentials: 'same-origin' }));
    for (var i = 0; i < files.length; i++) {
      pf[base + files[i]] = quiet(window.fetch(base + files[i], { cache: 'no-cache', credentials: 'same-origin' }));
    }
    window.__hubPrefetch = pf;
  } catch (e) { /* no prefetch: everything loads the usual way */ }
})();
