/**
 * Okapi BM25 over the session message index — ported from firedeck
 * `server/src/copilot/retrieval.ts` (k1 = 1.2, b = 0.75, standard IDF with
 * the +0.5 smoothing that keeps common terms from going negative on small
 * corpora).
 *
 * Implemented here rather than pulled in for the same reason firedeck gives:
 * BM25 over a hundred thousand short docs is a hundred lines and a
 * millisecond, and the dependency list is a security surface. The firedeck
 * domain touches (title weighting, dotted-key splitting) do not apply —
 * session transcripts have no titles or setting keys, docs are plain token
 * streams.
 *
 * Pure and dependency-free: the caller owns document storage and passes
 * token arrays in.
 */

const K1 = 1.2;
const B = 0.75;

export interface Bm25DocInput {
  id: number;
  tokens: string[];
}

export interface Bm25Hit {
  id: number;
  score: number;
}

interface IndexedBm25Doc {
  id: number;
  length: number;
  freq: Map<string, number>;
}

export interface Bm25SearchOptions {
  /**
   * AND gate: docs missing any of these tokens are skipped before scoring.
   * BM25 alone ranks partial matches highly enough to crowd out the docs the
   * grammar promised ("bare tokens AND together"), so the filter runs inside
   * the scoring pass rather than as a post-filter over a huge ranked list.
   */
  requiredTokens?: Set<string>;
}

export class Bm25Index {
  private docs: IndexedBm25Doc[] = [];
  private ids: number[] = [];
  private df = new Map<string, number>();
  private avgLength = 0;

  constructor(docs: Bm25DocInput[]) {
    for (const doc of docs) {
      const freq = new Map<string, number>();
      for (const token of doc.tokens) freq.set(token, (freq.get(token) ?? 0) + 1);
      for (const token of freq.keys()) this.df.set(token, (this.df.get(token) ?? 0) + 1);
      this.docs.push({ id: doc.id, length: doc.tokens.length, freq });
      this.ids.push(doc.id);
    }
    const total = this.docs.reduce((sum, doc) => sum + doc.length, 0);
    this.avgLength = this.docs.length > 0 ? total / this.docs.length : 0;
  }

  get size(): number {
    return this.docs.length;
  }

  /** Docs containing the term, as caller-side positional indexes. */
  postings(token: string): number[] {
    const out: number[] = [];
    for (let i = 0; i < this.docs.length; i++) {
      if (this.docs[i].freq.has(token)) out.push(i);
    }
    return out;
  }

  /**
   * Score the corpus for one query. Returns hits with score > 0, sorted
   * descending; `limit` caps the returned list (the sort itself is over all
   * matching docs — with session-sized corpora that is the cheap part).
   */
  search(query: string | string[], limit = 20, options: Bm25SearchOptions = {}): Bm25Hit[] {
    const terms = Array.isArray(query) ? query : tokenizeQueryTerms(query);
    if (terms.length === 0 || this.docs.length === 0) return [];
    const required = options.requiredTokens;

    const n = this.docs.length;
    const scored: Bm25Hit[] = [];
    for (const doc of this.docs) {
      if (required) {
        let hasAll = true;
        for (const term of required) {
          if (!doc.freq.has(term)) { hasAll = false; break; }
        }
        if (!hasAll) continue;
      }
      let score = 0;
      for (const term of terms) {
        const f = doc.freq.get(term);
        if (!f) continue;
        const df = this.df.get(term) ?? 0;
        const idf = Math.log(1 + (n - df + 0.5) / (df + 0.5));
        const norm = f * (K1 + 1);
        const denom = f + K1 * (1 - B + (B * doc.length) / (this.avgLength || 1));
        score += idf * (norm / denom);
      }
      if (score > 0) scored.push({ id: doc.id, score });
    }

    scored.sort((a, b) => b.score - a.score || a.id - b.id);
    return scored.slice(0, limit);
  }
}

/** Internal: tokenize a raw query string without importing tokenize.ts (the
 *  index takes token arrays from its owner; this fallback keeps the class
 *  usable standalone, mirroring firedeck's string-query API). */
function tokenizeQueryTerms(query: string): string[] {
  return (query.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter((t) => t.length >= 2);
}
