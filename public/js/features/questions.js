// Clinic-question answers (data.arm.questions) that survive rewording (pure, no DOM).
//
// Records used to be keyed only by a hash of the question text, so editing a question's wording
// in arm.json orphaned its tick and answer. Matching now runs in three steps:
//   1. a stable content id, when arm.json gives the question one (key "id:<id>");
//   2. the hash of the exact text (every existing record keeps working);
//   3. otherwise the stored record whose question text is most similar (same topic preferred),
//      if it's clearly the same question. Each record is claimed by at most one question.
// Writes go to the stable key, and a record found by steps 2–3 is moved there (migration-safe:
// nothing is deleted until its replacement is written).

import { taskKey } from '../markdown.js';

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

export function questionKey(q) {
  return q && typeof q.id === 'string' && q.id.trim() ? `id:${q.id.trim()}` : taskKey(q?.question ?? '');
}

function words(text) {
  return new Set(String(text || '').toLowerCase().replace(/[’']/g, '').split(/[^a-z0-9]+/).filter((w) => w.length > 2));
}

/** Jaccard similarity of the meaningful words in two texts (0..1). */
export function similarity(a, b) {
  const A = words(a);
  const B = words(b);
  if (!A.size || !B.size) return 0;
  let both = 0;
  for (const w of A) if (B.has(w)) both++;
  return both / (A.size + B.size - both);
}

const THRESHOLD = 0.6;

/**
 * Pairs each question with its stored record: Map(index -> {key, rec, via}), via = 'id' | 'text' | 'similar'.
 * Questions without a record are absent from the map.
 */
export function matchAnswers(questions, stored) {
  const qs = Array.isArray(questions) ? questions : [];
  const recs = isObj(stored) ? stored : {};
  const out = new Map();
  const claimed = new Set();
  qs.forEach((q, i) => {
    const k = questionKey(q);
    if (isObj(recs[k])) { out.set(i, { key: k, rec: recs[k], via: k.startsWith('id:') ? 'id' : 'text' }); claimed.add(k); }
  });
  qs.forEach((q, i) => {
    if (out.has(i)) return;
    const k = taskKey(q?.question ?? '');
    if (!claimed.has(k) && isObj(recs[k])) { out.set(i, { key: k, rec: recs[k], via: 'text' }); claimed.add(k); }
  });
  const pairs = [];
  qs.forEach((q, i) => {
    if (out.has(i)) return;
    for (const [k, rec] of Object.entries(recs)) {
      if (claimed.has(k) || !isObj(rec) || typeof rec.question !== 'string') continue;
      let sim = similarity(q?.question, rec.question);
      if (rec.topic && q?.topic && rec.topic === q.topic) sim += 0.05;
      if (sim >= THRESHOLD) pairs.push({ i, k, sim });
    }
  });
  pairs.sort((a, b) => b.sim - a.sim);
  for (const p of pairs) {
    if (out.has(p.i) || claimed.has(p.k)) continue;
    out.set(p.i, { key: p.k, rec: recs[p.k], via: 'similar' });
    claimed.add(p.k);
  }
  return out;
}

/**
 * The record to write for question q (creating or moving it under the stable key) — mutates `stored`.
 * `found` is matchAnswers()'s entry for this question, if any.
 */
export function answerRecord(stored, q, found = null) {
  const k = questionKey(q);
  if (isObj(stored[k])) {
    stored[k].question = q.question;
    if (q.topic) stored[k].topic = q.topic;
    return stored[k];
  }
  const base = found && isObj(found.rec) ? found.rec : { asked: false, notes: '' };
  const rec = { ...base, question: q.question };
  if (q.topic) rec.topic = q.topic;
  stored[k] = rec;
  if (found && found.key !== k) delete stored[found.key];
  return rec;
}
