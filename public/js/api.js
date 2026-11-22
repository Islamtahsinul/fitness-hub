// Thin wrappers around fetch for the local hub API and content files.
// SPEC 5.7a: GET /api/data returns a strong ETag; PUT /api/data must send If-Match and (round 3)
// X-Hub-Build. Every request has a timeout that covers the WHOLE exchange (headers and body), so
// a half-dead SSH tunnel that sends headers and then stalls can't hang a load or a save.

const WRITE_HEADERS = { 'Content-Type': 'application/json', 'X-Fitness-Hub': '1' };

/** Browsers refuse keepalive bodies over 64 KiB (shared by all in-flight keepalive requests). */
export const KEEPALIVE_MAX_BYTES = 60 * 1024;
export const REQUEST_TIMEOUT_MS = 20000;
/** Header carrying the build id read from /api/health at boot (SPEC 5.7a round 3). */
export const BUILD_HEADER = 'X-Hub-Build';

export class HttpError extends Error {
  /**
   * status 0 = no answer (network down, server stopped, timeout). body = parsed JSON error body.
   * code = body.error when it is a short machine-readable string (for example "build_mismatch").
   * timeout = true when the request (or reading its body) took longer than the time limit.
   */
  constructor(status, url, message = '', body = null, { timeout = false } = {}) {
    super(message || (status ? `HTTP ${status} for ${url}` : `Can’t reach the hub (${url}).`));
    this.name = 'HttpError';
    this.status = status;
    this.url = url;
    this.body = body;
    this.code = body && typeof body.error === 'string' && /^[a-z0-9_]{1,40}$/.test(body.error) ? body.error : null;
    this.timeout = !!timeout;
  }
}

async function errorFrom(res, url) {
  let body = null;
  try { body = await res.json(); } catch { /* not JSON */ }
  const msg = body && typeof body.error === 'string' ? body.error : '';
  return new HttpError(res.status, url, msg, body);
}

/**
 * Optional early-start fetches (PERF5). A page script may start requests before the modules load:
 *   window.__hubPrefetch = {'/api/data': fetch('/api/data', {cache: 'no-store', credentials: 'same-origin'}), ...}
 * A plain GET of exactly that path uses its entry once (then it is removed). A rejected entry
 * falls back to a normal request, so a prefetch can never make loading worse.
 */
function takePrefetch(url, init) {
  try {
    const pf = globalThis.__hubPrefetch;
    if (!pf || typeof pf !== 'object') return null;
    if ((init.method && init.method !== 'GET') || (init.headers && Object.keys(init.headers).length)) return null;
    const p = pf[url];
    if (!p || typeof p.then !== 'function') return null;
    delete pf[url];
    return p;
  } catch { return null; }
}

function networkError(url, e, timedOut) {
  if (e instanceof HttpError) return e;
  const aborted = timedOut || (e && e.name === 'AbortError');
  return new HttpError(0, url, aborted ? 'The hub took too long to answer.' : 'Can’t reach the hub. Is it running?', null, { timeout: aborted });
}

/**
 * fetch + read with ONE time limit for the whole exchange. `read(res)` consumes the response
 * (status checks and body); the timer runs until it has finished, so a stalled body read times
 * out too (PE4). Network failures and timeouts become HttpError(status 0).
 */
async function request(url, init = {}, { timeoutMs = REQUEST_TIMEOUT_MS, read = null } = {}) {
  const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
  let timer = null;
  let timedOut = false;
  const limit = new Promise((_, reject) => {
    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        try { if (ctrl) ctrl.abort(); } catch { /* ignore */ }
        reject(networkError(url, null, true));
      }, timeoutMs);
    }
  });
  const work = (async () => {
    let res;
    const early = takePrefetch(url, init);
    if (early) {
      try { res = await early; } catch { res = null; }
    }
    if (!res) {
      try {
        res = await fetch(url, ctrl ? { ...init, signal: ctrl.signal } : init);
      } catch (e) { throw networkError(url, e, timedOut); }
    }
    if (!read) return res;
    try {
      return await read(res);
    } catch (e) {
      throw e instanceof HttpError ? e : networkError(url, e, timedOut);
    }
  })();
  work.catch(() => {}); // the loser of the race must never surface as an unhandled rejection
  try {
    return await Promise.race([work, limit]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * UTF-8 byte length of a string (what the server and keepalive limits count), without
 * allocating a copy (PERF7/PERF10). Pure ASCII, the usual case for JSON, is one native regex test.
 */
export function byteLength(text) {
  const s = typeof text === 'string' ? text : String(text ?? '');
  const first = s.search(/[^\x00-\x7f]/);
  if (first < 0) return s.length;
  let n = s.length;
  for (let i = first; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) continue;
    if (c < 0x800) { n += 1; continue; }
    if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length && (s.charCodeAt(i + 1) & 0xfc00) === 0xdc00) { n += 2; i++; continue; }
    n += 2; // 3 bytes (a lone surrogate is encoded as U+FFFD, also 3 bytes)
  }
  return n;
}

/** True when a body fits the browser's keepalive limit (cheap: length first, bytes only if needed). */
export function fitsKeepalive(text) {
  return typeof text === 'string' && text.length <= KEEPALIVE_MAX_BYTES && byteLength(text) <= KEEPALIVE_MAX_BYTES;
}

/** GET a text file; resolves to null on 404 so callers can treat it as "not written yet". */
export async function getText(url, { timeoutMs = REQUEST_TIMEOUT_MS } = {}) {
  return request(url, { cache: 'no-cache', credentials: 'same-origin' }, {
    timeoutMs,
    read: async (res) => {
      if (res.status === 404) return null;
      if (!res.ok) throw new HttpError(res.status, url);
      return res.text();
    },
  });
}

/** GET /api/health: {ok, app, version, build, ...}. `build` is the bundle's BUILD_ID or "dev". */
export async function apiHealth({ timeoutMs = REQUEST_TIMEOUT_MS } = {}) {
  return request('/api/health', { cache: 'no-store', credentials: 'same-origin' }, {
    timeoutMs,
    read: async (res) => {
      if (!res.ok) throw await errorFrom(res, '/api/health');
      return res.json();
    },
  });
}

/** The build id in a health answer, or null when the server doesn't report one. */
export function buildOf(health) {
  const b = health && typeof health === 'object' ? health.build : null;
  return typeof b === 'string' && b.trim() && b.length <= 200 ? b.trim() : null;
}

/** Stored size of the response body: Content-Length when the body isn't compressed, else measured. */
function bodyBytes(res, text) {
  const get = (k) => (res.headers && typeof res.headers.get === 'function' ? res.headers.get(k) : null);
  const enc = String(get('Content-Encoding') || '').trim().toLowerCase();
  const raw = get('Content-Length');
  const len = typeof raw === 'string' && /^\d+$/.test(raw.trim()) ? Number(raw.trim()) : NaN;
  if ((!enc || enc === 'identity') && Number.isSafeInteger(len)) return len;
  return byteLength(text);
}

/**
 * GET /api/data with its ETag: {status, data, etag, bytes}. With ifNoneMatch, a server that
 * supports it may answer 304 ({status: 304, data: null}); a 200 is handled the same way.
 */
export async function apiGetDataWithEtag({ ifNoneMatch = null, timeoutMs = REQUEST_TIMEOUT_MS } = {}) {
  const url = '/api/data';
  const init = { cache: 'no-store', credentials: 'same-origin' };
  if (ifNoneMatch) init.headers = { 'If-None-Match': ifNoneMatch };
  return request(url, init, {
    timeoutMs,
    read: async (res) => {
      if (res.status === 304) return { status: 304, data: null, etag: res.headers.get('ETag') || ifNoneMatch, bytes: 0 };
      if (!res.ok) throw await errorFrom(res, url);
      const text = await res.text();
      let data;
      try {
        data = JSON.parse(text.replace(/^\uFEFF/, ''));
      } catch {
        throw new HttpError(502, url, 'The hub sent data that is not valid JSON.');
      }
      return { status: res.status, data, etag: res.headers.get('ETag'), bytes: bodyBytes(res, text) };
    },
  });
}

/** Backwards compatible: just the data object. */
export async function apiGetData() {
  return (await apiGetDataWithEtag()).data;
}

/**
 * PUT /api/data. Sends If-Match when an etag is given (SPEC 5.7a) and X-Hub-Build when a build
 * is given (round 3). Resolves to the response body plus `etag` (from the ETag header, else
 * body.etag, else null). Rejects with HttpError: 412 (changed elsewhere, body.current_etag),
 * 428 (If-Match missing), 409 with code "build_mismatch" (the hub was updated), 0 (no answer
 * or timeout), ... keepalive (for pagehide) is only used when the body fits the 64 KiB limit.
 */
export async function apiPutData(bodyText, { etag = null, keepalive = false, build = null, timeoutMs = REQUEST_TIMEOUT_MS } = {}) {
  const url = '/api/data';
  const headers = { ...WRITE_HEADERS };
  if (etag) headers['If-Match'] = etag;
  if (typeof build === 'string' && build) headers[BUILD_HEADER] = build;
  const ka = !!keepalive && fitsKeepalive(bodyText);
  return request(url, { method: 'PUT', headers, body: bodyText, cache: 'no-store', credentials: 'same-origin', keepalive: ka }, {
    timeoutMs,
    read: async (res) => {
      if (!res.ok) throw await errorFrom(res, url);
      let body = {};
      try { body = await res.json(); } catch { /* empty or non-JSON success body */ }
      if (!body || typeof body !== 'object') body = {};
      return { ...body, etag: res.headers.get('ETag') || (typeof body.etag === 'string' ? body.etag : null) };
    },
  });
}

export async function apiBackup({ timeoutMs = REQUEST_TIMEOUT_MS } = {}) {
  return request('/api/backup', { method: 'POST', headers: WRITE_HEADERS, body: '{}', cache: 'no-store', credentials: 'same-origin' }, {
    timeoutMs,
    read: async (res) => {
      if (!res.ok) throw await errorFrom(res, '/api/backup');
      return res.json();
    },
  });
}
