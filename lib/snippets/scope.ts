import { comparableProjectPath } from "../comparable-path";
import { WEB_SLASH_COMMANDS } from "../web-slash-commands";

/**
 * Pure snippet scoping + validation (no node builtins — importable from
 * browser components). The fs-backed store in lib/snippets.ts re-exports
 * everything here so server consumers keep a single import point.
 *
 * Fixed-command precedence: the web-native and client builtin slash commands
 * (goal/plan/…/compact/reload/name/session/copy, plus the /snippets manager
 * entry itself) always win. Snippets cannot shadow them — creation rejects
 * reserved names AND resolveSlash re-checks, so a hand-edited store file
 * cannot smuggle a shadowing snippet either. The co-located test asserts the
 * reserved set stays in sync with components/ChatInput-slash-commands.ts
 * BUILTIN_SLASH_COMMAND_DEFS.
 */

/** Stable-code validation error, mirrored by `errors.<code>` i18n keys. */
export class SnippetValidationError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "SnippetValidationError";
    this.code = code;
  }
}

export const MAX_SNIPPET_BODY_BYTES = 16 * 1024;
export const MAX_SNIPPETS = 500;
export const MAX_SNIPPET_NAME_LENGTH = 64;

export const RESERVED_SLASH_NAMES: ReadonlySet<string> = new Set([
  ...WEB_SLASH_COMMANDS.map((command) => command.name),
  "compact",
  "reload",
  "name",
  "session",
  "copy",
  "snippets",
]);

/** Slash-token-safe snippet names: no whitespace, no slash (it would break
 *  the /token parse), not a reserved command name. */
const SNIPPET_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

export function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}

/** Validate and normalize a snippet name. Throws SnippetValidationError with a
 *  stable code: name_required / name_invalid / name_too_long / reserved_name. */
export function validateSnippetName(rawName: unknown): string {
  const name = typeof rawName === "string" ? rawName.trim() : "";
  if (!name) throw new SnippetValidationError("name_required", "Snippet name is required");
  if (name.length > MAX_SNIPPET_NAME_LENGTH) {
    throw new SnippetValidationError("name_too_long", `Snippet name must be at most ${MAX_SNIPPET_NAME_LENGTH} characters`);
  }
  if (!SNIPPET_NAME_RE.test(name)) {
    throw new SnippetValidationError("name_invalid", "Snippet name may contain letters, numbers, dashes, and underscores only");
  }
  if (RESERVED_SLASH_NAMES.has(name.toLowerCase())) {
    throw new SnippetValidationError("reserved_name", `"${name}" is a built-in slash command and cannot be used as a snippet name`);
  }
  return name;
}

/** Validate a snippet body. Throws body_required / body_too_large. */
export function validateSnippetBody(rawBody: unknown): string {
  const body = typeof rawBody === "string" ? rawBody : "";
  if (!body.trim()) throw new SnippetValidationError("body_required", "Snippet body is required");
  if (utf8ByteLength(body) > MAX_SNIPPET_BODY_BYTES) {
    throw new SnippetValidationError("body_too_large", `Snippet body must be at most ${MAX_SNIPPET_BODY_BYTES} bytes`);
  }
  return body;
}

/** Normalize the scope field: null/"" → global; anything else must be a path
 *  string (stored as provided; canonicalization happens at the caller). */
export function normalizeScope(rawProjectRoot: unknown): string | null {
  if (rawProjectRoot === null || rawProjectRoot === undefined || rawProjectRoot === "") return null;
  if (typeof rawProjectRoot !== "string") {
    throw new SnippetValidationError("invalid_scope", "projectRoot must be a string or null");
  }
  return rawProjectRoot;
}

export function makeSnippetId(): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Comparable scope key: global snippets share one bucket, project snippets
 *  bucket per canonical path (case-insensitive on Windows-form paths). */
export function scopeKeyOf(projectRoot: string | null): string {
  if (projectRoot === null) return "";
  return comparableProjectPath(projectRoot);
}

export function snippetKeyOf(projectRoot: string | null, name: string): string {
  return `${scopeKeyOf(projectRoot)}\u0000${name.toLowerCase()}`;
}

/**
 * Snippets visible for a project scope: globals plus snippets bound to the
 * exact (comparable) project root. Fixed-command names are dropped here too —
 * the palette must never offer a snippet that resolveSlash would refuse.
 */
export function snippetsForProject<T extends { name: string; projectRoot: string | null }>(
  items: readonly T[],
  projectRoot: string | null,
): T[] {
  const key = projectRoot === null ? "" : comparableProjectPath(projectRoot);
  return items.filter((item) => {
    if (RESERVED_SLASH_NAMES.has(item.name.toLowerCase())) return false;
    if (item.projectRoot === null) return true;
    return comparableProjectPath(item.projectRoot) === key;
  });
}

export type SlashResolution =
  | { kind: "fixed"; name: string }
  | { kind: "snippet"; item: { id: string; name: string } }
  | { kind: "none" };

/**
 * Resolve a slash token for a project scope. FIXED COMMANDS WIN: a reserved
 * name resolves to "fixed" even if the store (hand-edited) contains a
 * same-named snippet — enforced here and at write time (see the module header
 * of scope.ts's siblings for the full contract). Unknown tokens resolve to
 * "none"; the caller decides what they mean (omp command, skill, or literal).
 */
export function resolveSlash<T extends { id: string; name: string; projectRoot: string | null }>(
  items: readonly T[],
  token: string,
  projectRoot: string | null,
): SlashResolution {
  const name = token.replace(/^\//, "").trim().toLowerCase();
  if (!name) return { kind: "none" };
  if (RESERVED_SLASH_NAMES.has(name)) return { kind: "fixed", name };
  const match = snippetsForProject(items, projectRoot).find(
    (item) => item.name.toLowerCase() === name,
  );
  return match ? { kind: "snippet", item: match } : { kind: "none" };
}

/** First free "name", "name (2)", "name (3)", … within a scope. */
export function uniqueCopyName<T extends { name: string; projectRoot: string | null }>(
  items: readonly T[],
  baseName: string,
  projectRoot: string | null,
): string {
  const taken = new Set(
    items
      .filter((item) => scopeKeyOf(item.projectRoot) === scopeKeyOf(projectRoot))
      .map((item) => item.name.toLowerCase()),
  );
  if (!taken.has(baseName.toLowerCase())) return baseName;
  for (let n = 2; ; n += 1) {
    const candidate = `${baseName} (${n})`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
}
