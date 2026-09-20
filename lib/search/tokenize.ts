/**
 * Shared tokenizer + query grammar for cross-session full-text search (P1).
 *
 * Pure and dependency-free so the same functions serve the index builder,
 * the query parser and the tests. Ported lighter than firedeck's
 * retrieval.ts tokenizer: session text is prose, not dotted setting keys, so
 * there is no camelCase splitting and no stopword list — the BM25 IDF term
 * weighting already demotes words that appear in every message ("the",
 * "and"), and a stopword list silently breaks CJK-ish queries that tokenize
 * to short runs.
 */

/** Words shorter than this are neither indexed nor searched (grammar: min 2). */
export const MIN_TOKEN_LENGTH = 2;

/** Smallest query (after trimming) the search route accepts. */
export const MIN_QUERY_LENGTH = 2;

/** Unicode word characters only — letters and numbers, any script. */
const WORD_RE = /[\p{L}\p{N}]+/gu;

/**
 * Lowercasing word tokenizer shared by the index and the query parser.
 * Splits on every non-alphanumeric code point and keeps words of length ≥ 2.
 * CJK runs stay single tokens; exact matching for them is the quoted-phrase
 * pass, not the token pass.
 */
export function tokenize(text: string): string[] {
  if (!text) return [];
  const out: string[] = [];
  for (const match of text.toLowerCase().matchAll(WORD_RE)) {
    const word = match[0];
    if (word.length >= MIN_TOKEN_LENGTH) out.push(word);
  }
  return out;
}

export interface ParsedSearchQuery {
  /** Bare tokens — every one must be present in a hit (AND), BM25-ranked. */
  tokens: string[];
  /** Quoted phrases — exact case-insensitive substring pass over candidates. */
  phrases: string[];
  /** `project:<name>` filters — comparable-path substring match. */
  projectFilters: string[];
}

/**
 * Parse the query grammar: bare tokens AND together, `"quoted phrase"` runs
 * an exact substring pass over the token-narrowed candidates, and a
 * `project:<name>` prefix filters by project path. Unknown `foo:` prefixes
 * are treated as bare text, not filters.
 */
export function parseSearchQuery(query: string): ParsedSearchQuery {
  const parsed: ParsedSearchQuery = { tokens: [], phrases: [], projectFilters: [] };
  if (!query) return parsed;

  const projectRe = /(?:^|\s)project:(\S+)/gi;
  let withoutProjects = query;
  for (const match of query.matchAll(projectRe)) {
    const name = (match[1] ?? "").trim();
    if (name) parsed.projectFilters.push(name.toLowerCase());
  }
  withoutProjects = withoutProjects.replace(projectRe, " ");

  const phraseRe = /"([^"]*)"/g;
  let withoutPhrases = withoutProjects;
  for (const match of withoutProjects.matchAll(phraseRe)) {
    const phrase = normalizePhrase(match[1] ?? "");
    if (phrase) parsed.phrases.push(phrase);
  }
  withoutPhrases = withoutPhrases.replace(phraseRe, " ");

  parsed.tokens = tokenize(withoutPhrases);
  return parsed;
}

/** Collapse whitespace + lowercase so phrase matching tolerates line wraps. */
export function normalizePhrase(phrase: string): string {
  return phrase.replace(/\s+/g, " ").trim().toLowerCase();
}

/**
 * Total query width (tokens + phrases) after parsing — the grammar's
 * minimum-length gate. A query of only `project:` filters has no text to
 * match and is treated as too short.
 */
export function parsedQueryLength(parsed: ParsedSearchQuery): number {
  return parsed.tokens.join(" ").length
    + parsed.phrases.join(" ").length
    + parsed.projectFilters.join(" ").length;
}
