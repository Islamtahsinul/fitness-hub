// Re-exports used by test_content.mjs, plus a disk-backed fetch so content.js itself can be
// exercised against the real files in public/ (no server needed).
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

export { buildTimeline, positionOn, plannedOn, resolveSession, sessionExerciseIds, gateRank, GATE_ORDER } from '../public/js/schedule.js';
export { addDays } from '../public/js/dates.js';

const PUBLIC = fileURLToPath(new URL('../public/', import.meta.url));

/** Run fn() with globalThis.fetch answering from public/ on disk (404 when a file is missing). */
export async function withDiskFetch(fn) {
  const real = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const rel = String(url).split('?')[0].replace(/^\/+/, '');
    let body = null;
    try { body = fs.readFileSync(PUBLIC + rel, 'utf8'); } catch { body = null; }
    return {
      status: body === null ? 404 : 200,
      ok: body !== null,
      headers: { get: () => null },
      text: async () => body ?? '',
      json: async () => JSON.parse(body ?? 'null'),
    };
  };
  try {
    return await fn();
  } finally {
    globalThis.fetch = real;
  }
}
