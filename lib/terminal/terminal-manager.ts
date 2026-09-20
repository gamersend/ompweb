// ============================================================================
// Terminal manager (Phase 13) — plain-pipe shell sessions for the Terminal tab.
//
// Safety model (BUILD-PLAN § Security additions, P13):
// - spawn cwd validated against the SAME allow-roots as /api/files — a
//   terminal can only ever start where a session/project already may read.
// - Fixed shell candidates / OMP_WEB_SHELL only. The user's command bytes go
//   to the shell's stdin — never interpolated into any argv.
// - No PTY: stdout+stderr merge into one coalesced stream. Full-screen TUI
//   apps are unsupported (the UI banner documents this); herdr attach mode is
//   the escape hatch for those.
// - Kill switch: OMP_WEB_DISABLE_TERMINAL=1 refuses every create.
// - Idle dispose (10 min without output or input) and explicit dispose close
//   the child; the registry lives on globalThis like rpc-manager's, so Next.js
//   hot reload cannot orphan children.
// - Server-side scrollback caps at 10k lines so a reconnecting SSE client
//   replays a bounded window.
// ============================================================================

import { spawn, type ChildProcess } from "child_process";
import { createHash, randomUUID } from "crypto";
import { existsSync } from "fs";
import { getAllowedFileRoots, isExistingFilePathAllowed, isFilePathAllowed } from "../file-access";

export const TERMINAL_DISABLED_ENV_VAR = "OMP_WEB_DISABLE_TERMINAL";
export const TERMINAL_SHELL_ENV_VAR = "OMP_WEB_SHELL";

/** Perf budget (BUILD-PLAN table): coalesce terminal output flushes at
 * ≥ 16 KB / 100 ms per terminal before they cross the SSE boundary. */
export const FLUSH_INTERVAL_MS = 100;
export const FLUSH_BYTES = 16 * 1024;

/** Server-side scrollback cap: last N lines replayed to new SSE subscribers. */
export const SCROLLBACK_MAX_LINES = 10_000;

/** Idle dispose, mirroring rpc-manager's idle timeout. */
export const IDLE_DISPOSE_MS = 10 * 60 * 1000;
/** Exited terminals linger briefly so a reconnecting client can still read
 * the exit frame; then the registry entry is purged. */
export const EXITED_LINGER_MS = 5 * 60 * 1000;

/** True when the kill switch is armed (env flag wins over everything). */
export function isTerminalDisabled(env: Record<string, string | undefined> = process.env): boolean {
  return env[TERMINAL_DISABLED_ENV_VAR] === "1";
}

export class TerminalError extends Error {
  readonly code: string;

  constructor(message: string, code: string) {
    super(message);
    this.name = "TerminalError";
    this.code = code;
  }
}

// ============================================================================
// Types
// ============================================================================

export type TerminalFrame = { t: "d"; b: string } | { t: "exit"; code: number | null };

export interface TerminalInfo {
  terminalId: string;
  cwd: string;
  shell: string;
  createdAt: number;
  lastActivity: number;
  exited: boolean;
  exitCode: number | null;
}

interface TerminalEntry {
  id: string;
  proc: ChildProcess;
  cwd: string;
  shell: string;
  createdAt: number;
  lastActivity: number;
  scrollback: string;
  /** Attached after construction; disposes flush any buffered bytes first. */
  coalescer: OutputCoalescer | null;
  exited: boolean;
  exitCode: number | null;
  subscribers: Set<(frame: TerminalFrame) => void>;
  idleTimer: ReturnType<typeof setTimeout> | null;
  lingerTimer: ReturnType<typeof setTimeout> | null;
  disposed: boolean;
}

type TerminalListener = (frame: TerminalFrame) => void;

declare global {
  var __ompTerminals: Map<string, TerminalEntry> | undefined;
}

// ============================================================================
// Pure helpers (unit-tested)
// ============================================================================

/** Keep the last `maxLines` lines of `text`, content-preserving: a trailing
 * partial line counts as one line and survives intact (split/join roundtrip
 * never loses bytes). */
export function capScrollback(text: string, maxLines: number = SCROLLBACK_MAX_LINES): string {
  if (maxLines <= 0) return "";
  const lines = text.split("\n");
  if (lines.length <= maxLines) return text;
  return lines.slice(-maxLines).join("\n");
}

export interface ShellCandidate {
  shell: string;
  args: string[];
}

/**
 * Fixed shell candidate list, best first. OMP_WEB_SHELL (absolute path or
 * PATH name) wins over every platform default. Windows probes
 * pwsh.exe → powershell.exe → cmd.exe; POSIX uses $SHELL → /bin/bash →
 * /bin/sh. Interactive flags per platform: `-i` on POSIX, `-NoLogo` for
 * PowerShell, none for cmd (already interactive over a pipe).
 */
export function resolveShellCandidates(env: Record<string, string | undefined> = process.env, platformName: string = process.platform): ShellCandidate[] {
  const override = env[TERMINAL_SHELL_ENV_VAR];
  const candidates: ShellCandidate[] = [];
  if (override) {
    if (platformName === "win32") {
      // Windows shells are not interactive over pipes without help; cmd and
      // PowerShell differ, so pick flags by name.
      const base = override.toLowerCase();
      const args = base.includes("pwsh") || base.includes("powershell") ? ["-NoLogo"] : [];
      candidates.push({ shell: override, args });
    } else {
      candidates.push({ shell: override, args: ["-i"] });
    }
  }
  if (platformName === "win32") {
    candidates.push({ shell: "pwsh.exe", args: ["-NoLogo"] });
    candidates.push({ shell: "powershell.exe", args: ["-NoLogo"] });
    candidates.push({ shell: "cmd.exe", args: [] });
  } else {
    if (env.SHELL) candidates.push({ shell: env.SHELL, args: ["-i"] });
    candidates.push({ shell: "/bin/bash", args: ["-i"] });
    candidates.push({ shell: "/bin/sh", args: ["-i"] });
  }
  return candidates;
}

/** First candidate whose executable exists. Absolute/relative paths are
 * checked with `exists`; bare names are probed across `pathEnv` entries (PATH
 * + PATHEXT extensions on Windows). Unknown overrides are trusted as-is —
 * spawn's own ENOENT handling reports the failure. */
export function firstSpawnableCandidate(
  candidates: ShellCandidate[],
  options: { platformName?: string; pathEnv?: string; exists?: (p: string) => boolean } = {},
): ShellCandidate | null {
  const exists = options.exists ?? existsSync;
  const platformName = options.platformName ?? process.platform;
  const pathEnv = options.pathEnv ?? process.env.PATH ?? "";
  const pick = (candidate: ShellCandidate): boolean => {
    const hasSeparator = /[\\/]/.test(candidate.shell);
    if (!hasSeparator) {
      if (platformName !== "win32") {
        // POSIX PATH probe; bare names like "zsh" resolve at spawn time too.
        for (const dir of pathEnv.split(":")) {
          if (dir && exists(dir + "/" + candidate.shell)) return true;
        }
        return false;
      }
      const pathext = process.env.PATHEXT || ".COM;.EXE;.BAT;.CMD";
      for (const dir of pathEnv.split(";")) {
        if (!dir) continue;
        if (exists(dir + "\\" + candidate.shell)) return true;
        const dot = candidate.shell.lastIndexOf(".");
        if (dot === -1 || dot === 0) {
          for (const ext of pathext.split(";")) {
            if (ext && exists(`${dir}\\${candidate.shell}${ext.toLowerCase()}`)) return true;
          }
        }
      }
      return false;
    }
    return exists(candidate.shell);
  };
  for (const candidate of candidates) {
    try {
      if (pick(candidate)) return candidate;
    } catch {
      // A weird PATH entry must not kill the whole probe.
    }
  }
  return candidates.length > 0 ? candidates[candidates.length - 1] : null;
}

// ============================================================================
// Output coalescer (perf budget, unit-tested)
// ============================================================================

export interface OutputCoalescer {
  push(chunk: Buffer): void;
  dispose(): void;
}

/** Buffers output chunks and flushes when the buffer reaches `flushBytes` OR
 * `flushIntervalMs` elapses since the first buffered byte — a chatty command
 * produces at most ~1 SSE frame per 100 ms instead of one per chunk. */
export function createOutputCoalescer(
  flush: (merged: Buffer) => void,
  options: { flushBytes?: number; flushIntervalMs?: number; setTimeoutFn?: typeof setTimeout; clearTimeoutFn?: typeof clearTimeout } = {},
): OutputCoalescer {
  const flushBytes = options.flushBytes ?? FLUSH_BYTES;
  const flushIntervalMs = options.flushIntervalMs ?? FLUSH_INTERVAL_MS;
  const setTimeoutFn = options.setTimeoutFn ?? setTimeout;
  const clearTimeoutFn = options.clearTimeoutFn ?? clearTimeout;
  let pending: Buffer[] = [];
  let pendingSize = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;

  const doFlush = () => {
    if (timer !== null) {
      clearTimeoutFn(timer);
      timer = null;
    }
    if (pending.length === 0) return;
    const merged = pendingSize === 1 ? pending[0] : Buffer.concat(pending, pendingSize);
    pending = [];
    pendingSize = 0;
    flush(merged);
  };

  return {
    push(chunk: Buffer) {
      if (disposed || chunk.length === 0) return;
      pending.push(chunk);
      pendingSize += chunk.length;
      if (pendingSize >= flushBytes) {
        doFlush();
        return;
      }
      if (timer === null) {
        timer = setTimeoutFn(() => {
          timer = null;
          doFlush();
        }, flushIntervalMs);
      }
    },
    dispose() {
      disposed = true;
      doFlush();
    },
  };
}

// ============================================================================
// Registry (globalThis — survives Next.js hot reload, mirrors rpc-manager)
// ============================================================================

function getRegistry(): Map<string, TerminalEntry> {
  if (!globalThis.__ompTerminals) {
    globalThis.__ompTerminals = new Map();
    const cleanup = () => {
      globalThis.__ompTerminals?.forEach((entry) => {
        try { entry.proc.kill(); } catch { /* already gone */ }
      });
    };
    process.once("exit", cleanup);
    process.once("SIGINT", cleanup);
    process.once("SIGTERM", cleanup);
  }
  return globalThis.__ompTerminals;
}

/** Test hook: drop the registry so a fresh one is created (registry-survival
 * tests pre-seed globalThis.__ompTerminals themselves). */
export function resetTerminalRegistryForTests(): void {
  globalThis.__ompTerminals = undefined;
}

export function getTerminalInfo(id: string): TerminalInfo | null {
  const entry = getRegistry().get(id);
  if (!entry) return null;
  return {
    terminalId: entry.id,
    cwd: entry.cwd,
    shell: entry.shell,
    createdAt: entry.createdAt,
    lastActivity: entry.lastActivity,
    exited: entry.exited,
    exitCode: entry.exitCode,
  };
}

export function listTerminals(): TerminalInfo[] {
  return [...getRegistry().values()].map((entry) => ({
    terminalId: entry.id,
    cwd: entry.cwd,
    shell: entry.shell,
    createdAt: entry.createdAt,
    lastActivity: entry.lastActivity,
    exited: entry.exited,
    exitCode: entry.exitCode,
  }));
}

// ============================================================================
// Subscription (scrollback replay + live frames)
// ============================================================================

/** Subscribe to a terminal's output. Replays the server-side scrollback as
 * one `d` frame first; when the terminal already exited, delivers the exit
 * frame instead of keeping the listener waiting. Returns the unsubscriber. */
export function subscribeTerminal(id: string, listener: TerminalListener): () => void {
  const registry = getRegistry();
  const entry = registry.get(id);
  if (!entry) throw new TerminalError("Terminal not found", "terminal_not_found");
  if (entry.scrollback.length > 0) {
    listener({ t: "d", b: Buffer.from(entry.scrollback, "utf8").toString("base64") });
  }
  if (entry.exited) {
    listener({ t: "exit", code: entry.exitCode });
    return () => {};
  }
  entry.subscribers.add(listener);
  return () => {
    entry.subscribers.delete(listener);
  };
}

function emitToEntry(entry: TerminalEntry, frame: TerminalFrame): void {
  for (const listener of entry.subscribers) {
    try {
      listener(frame);
    } catch {
      // A throwing subscriber must not starve the others (same isolation as
      // rpc-manager's listener fan-out).
    }
  }
}

// ============================================================================
// Spawn
// ============================================================================

function trySpawn(candidate: ShellCandidate, cwd: string): Promise<ChildProcess | null> {
  return new Promise((resolve) => {
    let settled = false;
    let proc: ChildProcess;
    try {
      proc = spawn(candidate.shell, candidate.args, {
        cwd,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
        env: { ...process.env, TERM: "xterm-256color" },
      });
    } catch {
      resolve(null);
      return;
    }
    const fail = () => {
      if (settled) return;
      settled = true;
      resolve(null);
    };
    const win = () => {
      if (settled) return;
      settled = true;
      resolve(proc);
    };
    proc.once("error", fail);
    proc.once("spawn", win);
  });
}

function scheduleIdleDispose(entry: TerminalEntry): void {
  if (entry.idleTimer) clearTimeout(entry.idleTimer);
  entry.idleTimer = setTimeout(() => {
    entry.idleTimer = null;
    if (Date.now() - entry.lastActivity >= IDLE_DISPOSE_MS) {
      disposeTerminal(entry.id);
    } else {
      scheduleIdleDispose(entry);
    }
  }, IDLE_DISPOSE_MS);
  // Never pin the event loop for a background shell nobody may be watching.
  entry.idleTimer.unref?.();
}

function touch(entry: TerminalEntry): void {
  entry.lastActivity = Date.now();
}

/**
 * Create a terminal in `cwd`. Throws:
 * - `terminal_disabled` — kill switch armed (OMP_WEB_DISABLE_TERMINAL=1)
 * - `access_denied` — cwd outside the /api/files allow-roots
 * - `spawn_failed` — no candidate shell could start
 */
export async function createTerminal(cwd: string): Promise<TerminalInfo> {
  if (isTerminalDisabled()) {
    throw new TerminalError("Terminal is disabled by OMP_WEB_DISABLE_TERMINAL", "terminal_disabled");
  }
  const allowedRoots = await getAllowedFileRoots();
  if (!isFilePathAllowed(cwd, allowedRoots) || !isExistingFilePathAllowed(cwd, allowedRoots)) {
    throw new TerminalError("Access denied", "access_denied");
  }

  const candidates = resolveShellCandidates();
  const chosen = firstSpawnableCandidate(candidates) ?? candidates[candidates.length - 1];
  if (!chosen) throw new TerminalError("No shell available", "spawn_failed");
  const proc = await trySpawn(chosen, cwd);
  if (!proc) {
    throw new TerminalError(`Failed to start shell: ${chosen.shell}`, "spawn_failed");
  }

  const id = randomUUID();
  const entry: TerminalEntry = {
    id,
    proc,
    cwd,
    shell: chosen.shell,
    createdAt: Date.now(),
    lastActivity: Date.now(),
    scrollback: "",
    coalescer: null,
    exited: false,
    exitCode: null,
    subscribers: new Set(),
    idleTimer: null,
    lingerTimer: null,
    disposed: false,
  };

  const coalescer = createOutputCoalescer((merged) => {
    const text = merged.toString("utf8");
    entry.scrollback = capScrollback(entry.scrollback + text);
    touch(entry);
    if (entry.subscribers.size > 0) {
      emitToEntry(entry, { t: "d", b: merged.toString("base64") });
    }
  });
  entry.coalescer = coalescer;

  const onOutput = (chunk: Buffer) => coalescer.push(chunk);
  proc.stdout?.on("data", onOutput);
  proc.stderr?.on("data", onOutput);

  proc.once("error", () => {
    // Spawn succeeded but the child later failed to launch a program.
    finalizeExit(entry, null);
  });
  proc.once("close", (code) => {
    finalizeExit(entry, typeof code === "number" ? code : null);
  });

  getRegistry().set(id, entry);
  scheduleIdleDispose(entry);
  return getTerminalInfo(id) as TerminalInfo;
}

function finalizeExit(entry: TerminalEntry, code: number | null): void {
  if (entry.exited) return;
  entry.exited = true;
  entry.exitCode = code;
  // Flush any buffered output BEFORE the exit frame so a client can never
  // observe the exit ahead of the bytes that preceded it.
  try { entry.coalescer?.dispose(); } catch { /* never block exit */ }
  entry.coalescer = null;
  emitToEntry(entry, { t: "exit", code });
  if (entry.idleTimer) {
    clearTimeout(entry.idleTimer);
    entry.idleTimer = null;
  }
  // Purge the registry entry after the linger window so late subscribers can
  // still observe the exit, then the id stops resolving.
  entry.lingerTimer = setTimeout(() => {
    if (getRegistry().get(entry.id) === entry) getRegistry().delete(entry.id);
  }, EXITED_LINGER_MS);
  entry.lingerTimer.unref?.();
}

// ============================================================================
// Input + dispose
// ============================================================================

/** Write raw bytes (keyboard data incl. escape sequences, bracketed paste) to
 * the shell's stdin. Returns false when the child is gone. */
export function writeTerminalInput(id: string, data: string): boolean {
  const entry = getRegistry().get(id);
  if (!entry) throw new TerminalError("Terminal not found", "terminal_not_found");
  if (entry.exited || entry.disposed) {
    throw new TerminalError("Terminal has exited", "terminal_exited");
  }
  touch(entry);
  scheduleIdleDispose(entry);
  try {
    return entry.proc.stdin != null && entry.proc.stdin.write(Buffer.from(data, "utf8"));
  } catch {
    return false;
  }
}

/** Kill the shell and drop the registry entry. Resolves after the child's
 * close event so callers that immediately respawn don't overlap exits. */
export async function disposeTerminal(id: string): Promise<boolean> {
  const entry = getRegistry().get(id);
  if (!entry) return false;
  entry.disposed = true;
  if (entry.idleTimer) {
    clearTimeout(entry.idleTimer);
    entry.idleTimer = null;
  }
  if (entry.lingerTimer) {
    clearTimeout(entry.lingerTimer);
    entry.lingerTimer = null;
  }
  getRegistry().delete(id);
  entry.subscribers.clear();
  if (entry.exited) return true;
  const proc = entry.proc;
  const exited = new Promise<void>((resolve) => {
    let settled = false;
    const done = () => {
      if (!settled) {
        settled = true;
        resolve();
      }
    };
    proc.once("close", done);
    setTimeout(done, 2_000).unref?.();
  });
  try {
    proc.kill();
  } catch {
    // Already dead.
  }
  await exited;
  return true;
}

/** Short content hash of an input batch — audit records are content-
 * addressable without ever storing what may be a typed password. */
export function auditHash(data: string): string {
  return createHash("sha256").update(data, "utf8").digest("hex").slice(0, 16);
}
