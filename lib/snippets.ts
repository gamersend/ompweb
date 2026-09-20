import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "fs";
import { resolve } from "path";
import { getAgentDir } from "./omp/paths";
import {
  MAX_SNIPPET_BODY_BYTES,
  MAX_SNIPPETS,
  makeSnippetId,
  normalizeScope,
  snippetKeyOf,
  uniqueCopyName,
  validateSnippetBody,
  validateSnippetName,
  SnippetValidationError,
} from "./snippets/scope";

// ============================================================================
// Prompt / snippet library (BUILD-PLAN Phase 4).
//
// User-owned reusable prompts stored at ~/.omp/agent/snippets.json following
// the project-registry store pattern (atomic temp+rename writes) plus the
// shared Store versioning pattern: a `version` field, an exported
// migrateSnippets() parser that returns null for foreign-shaped content, and
// corrupt-file quarantine to *.bak-<ts> on load — data loss is never silent.
//
// Scope: a snippet is global (projectRoot: null) or bound to one project root
// (canonical, worktree-resolved). Names are unique PER SCOPE, compared
// case-insensitively (slash tokens match case-insensitively in the composer
// menu, so case-differing names would collide as commands anyway).
//
// Pure validation / scoping / fixed-command precedence live in
// ./snippets/scope.ts (client-safe) and are re-exported here so server
// consumers keep a single import point.
// ============================================================================

export {
  MAX_SNIPPET_BODY_BYTES,
  MAX_SNIPPET_NAME_LENGTH,
  MAX_SNIPPETS,
  RESERVED_SLASH_NAMES,
  SnippetValidationError,
  makeSnippetId,
  normalizeScope,
  resolveSlash,
  snippetsForProject,
  validateSnippetBody,
  validateSnippetName,
} from "./snippets/scope";
export type { SlashResolution } from "./snippets/scope";

export interface SnippetItem {
  id: string;
  /** Slash token (without the leading /). Unique per scope, case-insensitive. */
  name: string;
  /** Prompt body, ≤ MAX_SNIPPET_BODY_BYTES UTF-8 bytes. */
  body: string;
  /** Canonical project root this snippet is scoped to; null = global. */
  projectRoot: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface SnippetStore {
  version: 1;
  items: SnippetItem[];
}

const EMPTY_STORE: SnippetStore = { version: 1, items: [] };

/**
 * Parse snippet-store JSON per the Store versioning pattern. Returns the
 * migrated store, or **null** for corrupt/foreign-shaped content (caller
 * quarantines + rebuilds — never silent). Invalid individual items are
 * skipped; a future format version lands here as a migration step.
 */
export function migrateSnippets(raw: string): SnippetStore | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  if (!("items" in parsed) || !Array.isArray((parsed as { items: unknown }).items)) return null;
  const items: SnippetItem[] = [];
  for (const entry of (parsed as { items: unknown[] }).items) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const item = entry as Record<string, unknown>;
    if (typeof item.id !== "string" || !item.id) continue;
    if (typeof item.name !== "string" || !item.name.trim()) continue;
    if (typeof item.body !== "string") continue;
    if (item.body.length > MAX_SNIPPET_BODY_BYTES) continue;
    const projectRoot = typeof item.projectRoot === "string" && item.projectRoot ? item.projectRoot : null;
    items.push({
      id: item.id,
      name: item.name.trim(),
      body: item.body,
      projectRoot,
      createdAt: typeof item.createdAt === "string" ? item.createdAt : new Date(0).toISOString(),
      updatedAt: typeof item.updatedAt === "string" ? item.updatedAt : new Date(0).toISOString(),
    });
  }
  // Stored per-scope uniqueness is repaired defensively (a hand-edited file
  // may carry duplicates): first occurrence wins.
  const seen = new Set<string>();
  const deduped = items.filter((item) => {
    const key = snippetKeyOf(item.projectRoot, item.name);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return { version: 1, items: deduped };
}

/** Corrupt-file quarantine target: snippets.json.bak-<ts>. */
function quarantineSnippetFile(filePath: string): void {
  try {
    renameSync(filePath, `${filePath}.bak-${Date.now()}`);
  } catch {
    // Quarantine is best-effort: a file that cannot be renamed is left alone
    // rather than blocking loads.
  }
}

export function getSnippetsPath(): string {
  return resolve(getAgentDir(), "snippets.json");
}

export function loadSnippets(): SnippetStore {
  const filePath = getSnippetsPath();
  if (!existsSync(filePath)) return EMPTY_STORE;
  let raw: string;
  try {
    raw = readFileSync(filePath, "utf8");
  } catch {
    return EMPTY_STORE;
  }
  const migrated = migrateSnippets(raw);
  if (migrated === null) {
    quarantineSnippetFile(filePath);
    return EMPTY_STORE;
  }
  return migrated;
}

/** Atomic persistence: temp file in the same directory, then rename over the
 *  store. A crash mid-write leaves the previous store intact. */
export function saveSnippets(store: SnippetStore): void {
  const filePath = getSnippetsPath();
  mkdirSync(resolve(filePath, ".."), { recursive: true });
  const temp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  try {
    writeFileSync(temp, `${JSON.stringify(store, null, 2)}\n`, "utf8");
    renameSync(temp, filePath);
  } finally {
    // Best-effort cleanup if the rename never happened (e.g. EACCES).
    try {
      if (existsSync(temp)) rmSync(temp);
    } catch {
      // ignore cleanup failures
    }
  }
}

/** Cap pruning per the Store versioning pattern: beyond MAX_SNIPPETS the
 *  oldest-updated items are dropped. Mutating helpers call this before their
 *  result is returned, so a persisted store always fits the cap. */
export function pruneSnippets(store: SnippetStore, cap = MAX_SNIPPETS): SnippetStore {
  if (store.items.length <= cap) return store;
  const kept = [...store.items]
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id))
    .slice(0, cap);
  const keptIds = new Set(kept.map((item) => item.id));
  return { version: 1, items: store.items.filter((item) => keptIds.has(item.id)) };
}

/**
 * Create or update one snippet (per-scope name uniqueness). When `id` names an
 * existing item it is updated in place; a conflicting name on ANOTHER item in
 * the same scope throws name_conflict instead of silently stealing it. New
 * items get a fresh id when none is supplied.
 */
export function upsertSnippet(
  store: SnippetStore,
  input: { id?: unknown; name: unknown; body: unknown; projectRoot: unknown },
  now = new Date().toISOString(),
): SnippetStore {
  const name = validateSnippetName(input.name);
  const body = validateSnippetBody(input.body);
  const projectRoot = normalizeScope(input.projectRoot);
  const id = typeof input.id === "string" && input.id ? input.id : makeSnippetId();

  const byId = store.items.find((item) => item.id === id);
  const nameOwner = store.items.find((item) => snippetKeyOf(item.projectRoot, item.name) === snippetKeyOf(projectRoot, name));
  if (nameOwner && nameOwner.id !== id) {
    throw new SnippetValidationError("name_conflict", `A snippet named "${name}" already exists in this scope`);
  }

  const items = store.items.map((item) =>
    item.id === id ? { ...item, name, body, projectRoot, updatedAt: now } : item,
  );
  if (!byId) {
    items.push({ id, name, body, projectRoot, createdAt: now, updatedAt: now });
  }
  return pruneSnippets({ version: 1, items });
}

export function deleteSnippet(store: SnippetStore, id: string): SnippetStore {
  return { version: 1, items: store.items.filter((item) => item.id !== id) };
}

/** Duplicate an item into the same scope, renaming on collision "name (2)". */
export function duplicateSnippet(
  store: SnippetStore,
  id: string,
  now = new Date().toISOString(),
): { store: SnippetStore; item: SnippetItem } {
  const source = store.items.find((item) => item.id === id);
  if (!source) throw new SnippetValidationError("snippet_not_found", "Snippet not found");
  const item: SnippetItem = {
    id: makeSnippetId(),
    name: uniqueCopyName(store.items, source.name, source.projectRoot),
    body: source.body,
    projectRoot: source.projectRoot,
    createdAt: now,
    updatedAt: now,
  };
  return { store: pruneSnippets({ version: 1, items: [...store.items, item] }), item };
}

/**
 * Import validated items (the {action:"import"} payload). Every imported item
 * gets a FRESH id and keeps its own scope; per-scope name collisions rename to
 * "name (2)" instead of overwriting. Structurally invalid entries are skipped
 * and counted, never thrown — one bad row must not sink a whole import.
 */
export function importSnippets(
  store: SnippetStore,
  rawItems: unknown[],
  now = new Date().toISOString(),
): { store: SnippetStore; imported: SnippetItem[]; skipped: number } {
  const items = [...store.items];
  const imported: SnippetItem[] = [];
  let skipped = 0;
  for (const raw of Array.isArray(rawItems) ? rawItems : []) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      skipped += 1;
      continue;
    }
    const entry = raw as Record<string, unknown>;
    try {
      const item: SnippetItem = {
        id: makeSnippetId(),
        name: uniqueCopyName(items, validateSnippetName(entry.name), normalizeScope(entry.projectRoot)),
        body: validateSnippetBody(entry.body),
        projectRoot: normalizeScope(entry.projectRoot),
        createdAt: now,
        updatedAt: now,
      };
      items.push(item);
      imported.push(item);
    } catch {
      skipped += 1;
    }
  }
  return { store: pruneSnippets({ version: 1, items }), imported, skipped };
}
