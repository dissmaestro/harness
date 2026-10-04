/** BM25 over name (weighted x3), tags (x2) and description. No dependencies, instant for thousands of items. */

export interface Searchable {
  name: string;
  description: string;
  tags?: string[];
}

export function tokenize(s: string): string[] {
  return s
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
}

/** Exact match, or a shared stem (helps with plurals and Russian word endings). */
function termMatches(q: string, t: string): boolean {
  if (q === t) return true;
  if (q.length < 4 || t.length < 4) return false;
  const stem = Math.max(4, Math.min(q.length, t.length) - 2);
  return q.slice(0, stem) === t.slice(0, stem);
}

const K1 = 1.2;
const B = 0.75;

/**
 * Query syntax (same as Claude Code's ToolSearch): plain keywords are ranked;
 * "+word" requires the word to appear in the name.
 */
export function search<T extends Searchable>(items: T[], query: string, limit = 5): T[] {
  const required: string[] = [];
  const free = query.replace(/(^|\s)\+(\S+)/g, (_m, sp: string, w: string) => {
    required.push(w.toLowerCase());
    return sp;
  });
  const candidates = items.filter((it) => required.every((r) => it.name.toLowerCase().includes(r)));
  const terms = [...new Set(tokenize(free))];
  if (!terms.length) return candidates.slice(0, limit);

  const docs = candidates.map((it) => {
    const name = tokenize(it.name);
    const tags = (it.tags ?? []).flatMap(tokenize);
    return [...name, ...name, ...name, ...tags, ...tags, ...tokenize(it.description)];
  });
  const avgLen = docs.reduce((a, d) => a + d.length, 0) / Math.max(1, docs.length);
  const df = terms.map((q) => docs.filter((d) => d.some((t) => termMatches(q, t))).length);

  const scored = candidates.map((item, i) => {
    const doc = docs[i];
    let score = 0;
    terms.forEach((q, qi) => {
      const tf = doc.filter((t) => termMatches(q, t)).length;
      if (!tf) return;
      const idf = Math.log(1 + (candidates.length - df[qi] + 0.5) / (df[qi] + 0.5));
      score += (idf * tf * (K1 + 1)) / (tf + K1 * (1 - B + (B * doc.length) / avgLen));
    });
    return { item, score };
  });
  return scored
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((s) => s.item);
}
