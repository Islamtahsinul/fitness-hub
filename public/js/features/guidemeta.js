// Guide table of contents without downloading every chapter: a HEAD request per chapter gives
// its size (and whether it exists yet); the reading time is estimated from the bytes.
// Chapters themselves load only when you open them (or when you search).

const sizeCache = new Map();
const BYTES_PER_WORD = 6.2; // Markdown with headings, tables and links
const WORDS_PER_MIN = 230;

/** Minutes to read from a file size in bytes (at least 1). */
export function readMinutes(bytes) {
  const b = Number(bytes);
  if (!Number.isFinite(b) || b <= 0) return null;
  return Math.max(1, Math.round(b / BYTES_PER_WORD / WORDS_PER_MIN));
}

async function headSize(url) {
  if (sizeCache.has(url)) return sizeCache.get(url);
  let out = { exists: null, bytes: null };
  try {
    const res = await fetch(url, { method: 'HEAD', cache: 'no-cache', credentials: 'same-origin' });
    if (res.status === 404) out = { exists: false, bytes: null };
    else if (res.ok) {
      const len = Number(res.headers.get('Content-Length'));
      out = { exists: len !== 0, bytes: Number.isFinite(len) ? len : null };
    }
  } catch { /* offline or blocked: leave unknown */ }
  sizeCache.set(url, out);
  return out;
}

/** Map of file -> {exists, bytes, minutes} for the given chapter files. */
export async function chapterMeta(files, base) {
  const pairs = await Promise.all(files.map(async (f) => {
    const r = await headSize(`${base}guide/${f}`);
    return [f, { ...r, minutes: readMinutes(r.bytes) }];
  }));
  return new Map(pairs);
}

export function clearChapterMeta() {
  sizeCache.clear();
}
