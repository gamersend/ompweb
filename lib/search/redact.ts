/**
 * Snippet redaction for search results — the boundary that stops a secret
 * leaving the server inside a search snippet.
 *
 * Ported from firedeck `server/src/copilot/redact.ts` (which itself is a
 * verbatim harnessland port): the regexes and entropy thresholds are the
 * tuned ones, and "a small cleanup during a port" is how a redactor stops
 * redacting. Adapted for omp-web's snippet contract in two ways:
 *
 *   1. Snippets are free text — there is no config-key metadata here, so the
 *      key-NAME detector runs on `NAME=value` assignment shapes (the port's
 *      ASSIGNMENT_RE + SECRET_NAME_RE) rather than dotted setting paths.
 *   2. Results must carry MATCH RANGES into the redacted text, so detection
 *      and replacement are separated: `findRedactionSpans()` finds
 *      non-overlapping spans in the ORIGINAL text, `applyRedactions()`
 *      builds the output and maps every span to its output coordinates.
 *
 * Never trust transcripts: everything a search route returns passes through
 * `redactSnippet()` before transport.
 */

// ─── entropy detection (ported) ──────────────────────────────────────────────

/** Shannon entropy in bits per character. */
export function shannonEntropy(s: string): number {
  if (!s) return 0;
  const freq = new Map<string, number>();
  for (const ch of s) freq.set(ch, (freq.get(ch) ?? 0) + 1);
  let h = 0;
  for (const n of freq.values()) {
    const p = n / s.length;
    h -= p * Math.log2(p);
  }
  return h;
}

/** Length at which a structureless string starts being treated as a secret. */
export const ENTROPY_MIN_LENGTH = 28;
export const ENTROPY_MIN_BITS = 3.9;

/** Long, dense, but demonstrably-not-credential shapes (ported verbatim). */
const NOT_A_SECRET_RE = [
  /^[a-z]+:\/\//i, // URL
  /^~?[/\\]/, // posix path
  /^[A-Za-z]:[/\\]/, // windows path
  /^\d[\d.]*$/, // version / number
  /^v?\d+\.\d+\.\d+/, // semver
  /^[0-9a-f-]{36}$/i, // uuid
  /^\d{4}-\d{2}-\d{2}/, // date / timestamp
];

/**
 * True when a bare string looks like a credential on its own evidence.
 * Requires density (no whitespace), a restricted charset, mixed character
 * classes, and high entropy — all four, so English prose never qualifies.
 */
export function looksHighEntropy(s: string): boolean {
  if (s.length < ENTROPY_MIN_LENGTH) return false;
  if (/\s/.test(s)) return false;
  if (!/^[A-Za-z0-9_\-+/=.:]+$/.test(s)) return false;
  for (const re of NOT_A_SECRET_RE) if (re.test(s)) return false;

  // A long pure-hex run is a hash or a key; either way, not for a snippet.
  if (/^[0-9a-f]{40,}$/i.test(s)) return true;

  const hasDigit = /\d/.test(s);
  const hasUpper = /[A-Z]/.test(s);
  const hasLower = /[a-z]/.test(s);
  if (!hasDigit || !(hasUpper && hasLower)) return false;

  // Dotted/slashed identifiers (`anthropic/claude-fable-5`) are structure, not
  // entropy: judge the longest opaque run rather than the decorated whole.
  const longestRun = s.split(/[./:_-]/).reduce((a, b) => (b.length > a.length ? b : a), "");
  if (longestRun.length < 20) return false;

  return shannonEntropy(s) >= ENTROPY_MIN_BITS;
}

// ─── known-prefix detection (ported) ─────────────────────────────────────────

/**
 * Vendor prefixes masked on sight: the ones the phase spec names (`sk-`,
 * `ghp_`/`gho_`, `AKIA`, `xox[bap]-`) plus the rest of the tuned port list,
 * with each prefix's minimum credible length.
 */
const PREFIX_RULES: { prefix: string; minLength: number; rest: number }[] = [
  { prefix: "sk-", minLength: 12, rest: 8 },
  { prefix: "ghp_", minLength: 12, rest: 8 },
  { prefix: "gho_", minLength: 12, rest: 8 },
  { prefix: "ghu_", minLength: 12, rest: 8 },
  { prefix: "ghs_", minLength: 12, rest: 8 },
  { prefix: "github_pat_", minLength: 20, rest: 8 },
  { prefix: "xoxa-", minLength: 12, rest: 8 },
  { prefix: "xoxb-", minLength: 12, rest: 8 },
  { prefix: "xoxp-", minLength: 12, rest: 8 },
  { prefix: "AKIA", minLength: 16, rest: 8 },
  { prefix: "glpat-", minLength: 12, rest: 8 },
  { prefix: "npm_", minLength: 20, rest: 8 },
  { prefix: "tvly-", minLength: 12, rest: 8 },
];

/** A run of secret-ish characters used to find candidates inside prose. `=`
 *  only trails (base64 padding) so `NAME=value` stays one candidate — the
 *  assignment rule below splits it before this can misjudge it. */
const TOKEN_RE = /[A-Za-z0-9_\-+/.]{8,}={0,2}/g;

/** Minted token namespaces: proof on their own, however short the remainder.
 *  Deliberately excludes ambiguous prefixes (`xai-`, `pa-`) that collide with
 *  live provider ids in this user's config. */
const UNAMBIGUOUS_PREFIX_RE =
  /(?:^|[^A-Za-z0-9])((?:sk-|sk_|ghp_|gho_|ghs_|ghu_|github_pat_|glpat-|xoxa-|xoxb-|xoxp-|AKIA|npm_|tvly-)[A-Za-z0-9_\-./+]{4,})/g;

/**
 * `Authorization: Bearer <token>` and bare `Bearer <token>` in free text.
 * Only the token is masked; the word "Bearer" survives so the snippet still
 * reads.
 */
const BEARER_RE = /\bBearer\s+([A-Za-z0-9._~+/=-]{8,})/gi;

/** JWT: three dot-joined base64url segments, each starting with the `eyJ`
 *  (`{"`-header) signature. */
const JWT_RE = /\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}/g;

/** `scheme://user:password@host` — the credential pair is masked, scheme and
 *  host survive so the snippet still says where it pointed. */
const URL_CREDENTIALS_RE = /\b([a-z][a-z0-9+.-]*:\/\/)([^\s:@/"'<>[\]]{1,128}):([^\s@/"'<>[\]]{1,256})@/gi;

/**
 * `NAME=value` / `NAME: value` — the shape every `.env` file and most error
 * messages use, welded into one TOKEN_RE candidate that the prefix and
 * entropy rules then both miss (the name drags entropy down). The name is
 * capped at 64 chars — load-bearing in the port, where unbounded greed was a
 * measured 5s quadratic blowup on 64 KB blobs.
 */
const ASSIGNMENT_RE = /([A-Za-z][A-Za-z0-9_.-]{2,63})(\s*[=:]\s*)(["']?)([^\s"'`,;<][^\s"'`,;]{3,})\3/g;

/** Names that advertise a credential; the value is masked whatever it looks like. */
const SECRET_NAME_RE =
  /(?:^|[_.-])(?:api[_.-]?keys?|secrets?|tokens?|passwds?|passwords?|credentials?|auth|bearer|access[_.-]?keys?|private[_.-]?keys?|client[_.-]?secrets?)(?:$|[_.-])|^(?:pat|pwd)$/i;

function matchesKnownPrefix(s: string): boolean {
  if (s.includes("/")) return false; // every prefixed vendor key is URL-safe

  for (const { prefix, minLength, rest } of PREFIX_RULES) {
    if (s.length < minLength || !s.startsWith(prefix)) continue;
    const remainder = s.slice(prefix.length);
    if (remainder.length < rest) continue;
    if (/\d/.test(remainder) || (/[a-z]/.test(remainder) && /[A-Z]/.test(remainder)) || remainder.length >= 16) {
      return true;
    }
  }
  return false;
}

/** True when this exact string should never reach a snippet. */
export function isSecretValue(s: string): boolean {
  return matchesKnownPrefix(s) || looksHighEntropy(s);
}

// ─── span detection + redaction with range mapping ───────────────────────────

export type RedactionSpan = [number, number];

interface Candidate {
  start: number;
  end: number;
}

function addCandidate(candidates: Candidate[], start: number, end: number): void {
  if (start < 0 || end <= start) return;
  candidates.push({ start, end });
}

/**
 * Find every secret-shaped span in `text`, as [start, end) offsets into the
 * ORIGINAL string, sorted and non-overlapping (earlier/longer wins).
 */
export function findRedactionSpans(text: string): RedactionSpan[] {
  if (!text) return [];
  const candidates: Candidate[] = [];

  for (const match of text.matchAll(URL_CREDENTIALS_RE)) {
    const index = match.index ?? 0;
    addCandidate(candidates, index + match[1].length, index + match[1].length + match[2].length + 1 + match[3].length);
  }
  for (const match of text.matchAll(BEARER_RE)) {
    const index = match.index ?? 0;
    addCandidate(candidates, index + match[0].length - match[1].length, index + match[0].length);
  }
  for (const match of text.matchAll(JWT_RE)) {
    addCandidate(candidates, match.index ?? 0, (match.index ?? 0) + match[0].length);
  }
  for (const match of text.matchAll(UNAMBIGUOUS_PREFIX_RE)) {
    const token = match[1];
    const start = (match.index ?? 0) + match[0].length - token.length;
    addCandidate(candidates, start, start + token.length);
  }
  for (const match of text.matchAll(ASSIGNMENT_RE)) {
    const name = match[1];
    const value = match[4];
    const valueStart = (match.index ?? 0) + match[0].length - (match[3] ?? "").length - value.length;
    if (SECRET_NAME_RE.test(name) || isSecretValue(value)) {
      addCandidate(candidates, valueStart, valueStart + value.length);
    }
  }
  for (const match of text.matchAll(TOKEN_RE)) {
    const token = match[0];
    if (isSecretValue(token)) addCandidate(candidates, match.index ?? 0, (match.index ?? 0) + token.length);
  }

  // Sort by start, longest first, then sweep keeping non-overlapping spans.
  candidates.sort((a, b) => a.start - b.start || (b.end - b.start) - (a.end - a.start));
  const spans: RedactionSpan[] = [];
  let cursor = -1;
  for (const candidate of candidates) {
    if (candidate.start < cursor) continue;
    spans.push([candidate.start, candidate.end]);
    cursor = candidate.end;
  }
  return spans;
}

export interface RedactionResult {
  /** Text with every redacted span replaced by "🔒". */
  text: string;
  /** Redacted spans mapped into the OUTPUT text's coordinates. */
  spans: RedactionSpan[];
  /** How many secrets were masked. */
  redactedCount: number;
}

/** The replacement marker: one visible glyph (2 UTF-16 units), unmistakably
 *  not a secret and not confusable with prose. */
export const REDACTION_MARKER = "🔒";

/**
 * Apply spans to `text`, returning the redacted text plus every span's
 * coordinates in the NEW text — this is what lets the search route keep its
 * `matchRanges` honest after redaction shrank the snippet.
 */
export function applyRedactions(text: string, spans: RedactionSpan[]): RedactionResult {
  if (spans.length === 0) return { text, spans: [], redactedCount: 0 };
  const parts: string[] = [];
  const outSpans: RedactionSpan[] = [];
  let cursor = 0;
  for (const [start, end] of spans) {
    parts.push(text.slice(cursor, start));
    const outStart = parts.reduce((sum, part) => sum + part.length, 0);
    parts.push(REDACTION_MARKER);
    outSpans.push([outStart, outStart + REDACTION_MARKER.length]);
    cursor = end;
  }
  parts.push(text.slice(cursor));
  return { text: parts.join(""), spans: outSpans, redactedCount: spans.length };
}

/**
 * Detect + redact in one call — the single chokepoint every search snippet
 * crosses before transport.
 */
export function redactSnippet(text: string): RedactionResult {
  return applyRedactions(text, findRedactionSpans(text));
}
