// ============================================================================
// External omp client discovery (runs board, bug 1) — READ-ONLY.
//
// The board's running set is ompweb's OWN RPC registry (`getRunningRpcSessions`),
// i.e. only sessions THIS web app spawned — a terminal/TUI session never shows
// up and the board reads "no active runs" while a dozen omp clients are live.
// omp publishes every live client process in its internal runtime registry:
//
//   <config>/run/daemons/<projectHash>/clients/<pid>-<uuid>.json
//     {"pid":38940,"id":"38940-5d…","projectDir":"C:\\Users\\blaze\\fire"}
//   <config>/run/daemons/<projectHash>/scope.json  {"projectDir":"…"}
//
// Those client files carry NO session id. They are presented honestly as
// EXTERNAL omp clients (pid + project + registered-at) and are never mapped to
// a session that was not parsed. Stale files from killed processes linger, so
// every row is liveness-filtered (`process.kill(pid, 0)` — a signal-less
// existence probe, never a kill; ESRCH means gone).
//
// Discipline (same family as lib/omp/native-jobs.ts / native-memory.ts):
// - READ-ONLY IS ABSOLUTE: nothing here writes anywhere. The only fs calls are
//   readdir / readFile / stat, and no session is ever created, stopped or
//   signalled. A source-contract test pins the module against write calls.
// - Never throws: a missing/unreadable registry degrades to
//   { supported: false, reason } — the board simply omits the section.
// - Bounded: ≤ 100 client files collected, ≤ 20 per scope dir, ≤ 200 file
//   entries examined per scope dir, malformed/unparseable files ignored.
// - 5 s in-process cache on globalThis (hot-reload safe) so the board's 2 s
//   poll does not hammer the filesystem.
// - Pure exported parsers (unknown fields dropped, nothing guessed) plus an
//   injectable fs/pid boundary for tests.
// ============================================================================

import { readdirSync, readFileSync, statSync } from "fs";
import { join } from "path";
import { getConfigRoot } from "./paths";
import { asNumber, asString, isRecord } from "../type-guards";

export const EXTERNAL_CLIENTS_CACHE_TTL_MS = 5_000;
/** Hard cap on rows collected from the whole registry. */
export const EXTERNAL_CLIENTS_MAX_FILES = 100;
/** Hard cap on client files considered per scope (project) directory. */
export const EXTERNAL_CLIENTS_MAX_PER_SCOPE = 20;
/** Defensive bound on directory entries examined per scope's `clients/`. */
export const EXTERNAL_CLIENTS_MAX_DIR_ENTRIES = 200;

/** One live omp client that this web app does NOT own. `startedAt` is the
 * client file's write time — omp writes it once at client registration, so it
 * is the honest "this client showed up at" timestamp. */
export interface ExternalOmpClient {
  pid: number;
  clientId: string;
  projectDir: string;
  /** ISO timestamp of the registry file's mtime. */
  startedAt: string;
}

/** Tier-B section shape: either the parsed clients, or an explicit unsupported
 * verdict. Never mixed, never an exception across the wire. */
export type ExternalOmpClientsResult =
  | { supported: true; clients: ExternalOmpClient[] }
  | { supported: false; reason: string };

/** `<config>/run/daemons` — omp's per-project runtime scopes. */
export function getRunDaemonsDir(): string {
  return join(getConfigRoot(), "run", "daemons");
}

// ---------------------------------------------------------------------------
// Pure parsers — defensive, unknown fields dropped, no guesses.
// ---------------------------------------------------------------------------

/** A parsed `clients/<pid>-<uuid>.json` record. A positive integer pid and a
 * non-empty id are required; anything else is not a client file. */
export interface ClientFileRecord {
  pid: number;
  clientId: string;
  /** Present only when the file carried a non-empty projectDir. */
  projectDir?: string;
}

/** Parse a client registry file's contents. Returns undefined (never throws)
 * for malformed JSON or a record without a usable pid/id. */
export function parseClientFile(text: string): ClientFileRecord | undefined {
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!isRecord(payload)) return undefined;
  const pid = asNumber(payload.pid);
  if (pid === undefined || !Number.isInteger(pid) || pid <= 0) return undefined;
  const clientId = asString(payload.id) ?? asString(payload.clientId);
  if (!clientId) return undefined;
  const record: ClientFileRecord = { pid, clientId };
  const projectDir = asString(payload.projectDir);
  if (projectDir) record.projectDir = projectDir;
  return record;
}

/** A parsed `scope.json` record. */
export interface ScopeFileRecord {
  projectDir: string;
}

/** Parse a scope file's contents — the project label fallback for a client
 * file that carries no projectDir of its own. */
export function parseScopeFile(text: string): ScopeFileRecord | undefined {
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!isRecord(payload)) return undefined;
  const projectDir = asString(payload.projectDir);
  return projectDir ? { projectDir } : undefined;
}

// ---------------------------------------------------------------------------
// Injectable boundary (tests never touch the real registry).
// ---------------------------------------------------------------------------

/** Minimal structural fs slice — enough to walk a registry, nothing more. */
export interface NativeClientsFs {
  readdir(dir: string): Array<{ name: string; isDirectory(): boolean }>;
  readFile(file: string): string;
  /** Last-write ms for an already-listed file; null when it vanished. */
  mtimeMs(file: string): number | null;
}

export interface NativeClientsDeps {
  /** Registry root override (defaults to `getRunDaemonsDir()`). */
  rootDir?: string;
  /** fs boundary override. */
  fs?: NativeClientsFs;
  /** Liveness probe override (default: `process.kill(pid, 0)`). */
  isPidAlive?: (pid: number) => boolean;
  /** Clock override (unused by the scan today; kept for callers/tests). */
  now?: () => number;
}

const defaultFs: NativeClientsFs = {
  readdir: (dir) => readdirSync(dir, { withFileTypes: true })
    .map((entry) => ({ name: entry.name, isDirectory: () => entry.isDirectory() })),
  readFile: (file) => readFileSync(file, "utf8"),
  mtimeMs: (file) => {
    try {
      return statSync(file).mtimeMs;
    } catch {
      return null;
    }
  },
};

/** Existence probe: ESRCH means the pid is gone; anything else (EPERM included)
 * means a process is there. Never sends a signal. */
function defaultIsPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException | null)?.code !== "ESRCH";
  }
}

/** Short, transport-safe failure reason (never echoes file contents). */
function reasonFromError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const compact = message.replace(/\s+/g, " ").trim();
  return compact.length > 200 ? `${compact.slice(0, 197)}…` : compact || "unknown_error";
}

// ---------------------------------------------------------------------------
// Scan
// ---------------------------------------------------------------------------

interface ClientCandidate {
  file: string;
  mtimeMs: number;
}

/** Client files inside one scope's `clients/` dir, newest first. Unreadable
 * dirs yield an empty list — a scope without clients is not an error. */
function listClientCandidates(fs: NativeClientsFs, clientsDir: string): ClientCandidate[] {
  let entries: Array<{ name: string; isDirectory(): boolean }>;
  try {
    entries = fs.readdir(clientsDir);
  } catch {
    return [];
  }
  const candidates: ClientCandidate[] = [];
  for (const entry of entries.slice(0, EXTERNAL_CLIENTS_MAX_DIR_ENTRIES)) {
    if (entry.isDirectory() || !entry.name.endsWith(".json")) continue;
    const file = join(clientsDir, entry.name);
    const mtimeMs = fs.mtimeMs(file);
    if (mtimeMs === null) continue;
    candidates.push({ file, mtimeMs });
  }
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return candidates.slice(0, EXTERNAL_CLIENTS_MAX_PER_SCOPE);
}

function scanClients(deps: NativeClientsDeps): ExternalOmpClientsResult {
  const fs = deps.fs ?? defaultFs;
  const rootDir = deps.rootDir ?? getRunDaemonsDir();
  const isPidAlive = deps.isPidAlive ?? defaultIsPidAlive;

  let scopes: Array<{ name: string; isDirectory(): boolean }>;
  try {
    scopes = fs.readdir(rootDir).filter((entry) => entry.isDirectory());
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | null)?.code;
    // No registry at all is the normal state on a machine where omp has never
    // opened a project: an explicit "not supported here" verdict, not an error.
    return { supported: false, reason: code === "ENOENT" ? "not_found" : reasonFromError(error) };
  }

  const rows: Array<{ client: ExternalOmpClient; mtimeMs: number }> = [];
  for (const scope of scopes) {
    if (rows.length >= EXTERNAL_CLIENTS_MAX_FILES) break;
    const scopeDir = join(rootDir, scope.name);
    let scopeProjectDir = "";
    try {
      scopeProjectDir = parseScopeFile(fs.readFile(join(scopeDir, "scope.json")))?.projectDir ?? "";
    } catch {
      // No scope.json — the client files carry their own projectDir.
    }
    for (const candidate of listClientCandidates(fs, join(scopeDir, "clients"))) {
      if (rows.length >= EXTERNAL_CLIENTS_MAX_FILES) break;
      let text: string;
      try {
        text = fs.readFile(candidate.file);
      } catch {
        continue; // vanished mid-scan
      }
      const record = parseClientFile(text);
      if (!record) continue;
      if (!isPidAlive(record.pid)) continue; // stale file from a dead process
      const projectDir = record.projectDir ?? scopeProjectDir;
      // A client with no project anywhere cannot be labelled honestly — skip it
      // rather than invent a location.
      if (!projectDir) continue;
      rows.push({
        mtimeMs: candidate.mtimeMs,
        client: {
          pid: record.pid,
          clientId: record.clientId,
          projectDir,
          startedAt: new Date(candidate.mtimeMs).toISOString(),
        },
      });
    }
  }

  rows.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return { supported: true, clients: rows.map((row) => row.client) };
}

// ---------------------------------------------------------------------------
// 5 s cache (globalThis — hot-reload safe). Explicit deps bypass it entirely.
// ---------------------------------------------------------------------------

declare global {
  var __ompExternalClientsCache: { ts: number; result: ExternalOmpClientsResult } | undefined;
}

/** Test/refresh hook: drop the cached registry read. */
export function resetExternalClientsCacheForTests(): void {
  globalThis.__ompExternalClientsCache = undefined;
}

function cloneResult(result: ExternalOmpClientsResult): ExternalOmpClientsResult {
  return result.supported ? { supported: true, clients: result.clients.map((client) => ({ ...client })) } : { ...result };
}

/**
 * Live omp clients discovered in omp's runtime registry. Cached 5 s for the
 * dependency-free call; passing any dep reads fresh. Never throws.
 */
export function getExternalOmpClients(deps: NativeClientsDeps = {}): ExternalOmpClientsResult {
  const cacheable = deps.fs === undefined
    && deps.rootDir === undefined
    && deps.isPidAlive === undefined
    && deps.now === undefined;
  if (cacheable) {
    const cached = globalThis.__ompExternalClientsCache;
    if (cached && Date.now() - cached.ts < EXTERNAL_CLIENTS_CACHE_TTL_MS) return cloneResult(cached.result);
  }
  let result: ExternalOmpClientsResult;
  try {
    result = scanClients(deps);
  } catch (error) {
    result = { supported: false, reason: reasonFromError(error) };
  }
  if (cacheable) globalThis.__ompExternalClientsCache = { ts: Date.now(), result };
  return cloneResult(result);
}

/**
 * Drop clients this web app already owns (its own `omp --mode rpc-ui`
 * children register in the same registry) so the board never double-reports a
 * session it already lists as a run. Pure.
 */
export function filterOwnedClients(
  clients: readonly ExternalOmpClient[],
  ownedPids: Iterable<number>,
): ExternalOmpClient[] {
  const owned = ownedPids instanceof Set ? ownedPids : new Set(ownedPids);
  if (owned.size === 0) return [...clients];
  return clients.filter((client) => !owned.has(client.pid));
}
