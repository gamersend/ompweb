// ============================================================================
// herdr attach — server-side pane runner (Phase 13).
//
// Env-gated by OMP_WEB_HERDR_BIN, default OFF: with the variable unset every
// entry point reports disabled and nothing spawns. With it set, omp-web talks
// to the herdr workspace manager through FIXED ARGV only (never a shell
// string): pane list (picker), pane read (800 ms poll in the client), pane
// send-text / send-keys (owner-attached input), pane resize.
//
// Ownership model (ported tier UX): watching a pane is read-only for
// everyone; typing/resizing is only allowed for panes omp-web attached as
// owner. Server-side claims live on globalThis (hot-reload safe). herdr's
// own reported owner (when present in the pane list) additionally gates
// attach.
// ============================================================================

import { spawn } from "child_process";
import { HERDR_BIN_ENV_VAR } from "../feature-flags";
import {
  isPaneAttachable,
  isValidPaneId,
  parsePaneList,
  type HerdrPaneMeta,
} from "./herdr-plan";

export { isValidPaneId } from "./herdr-plan";

/** Configured herdr binary, or null when herdr attach is disabled. */
export function herdrBin(env: Record<string, string | undefined> = process.env): string | null {
  const value = env[HERDR_BIN_ENV_VAR];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

export function isHerdrAttachEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return herdrBin(env) !== null;
}

// ============================================================================
// Fixed-argv runner
// ============================================================================

export interface HerdrRunResult {
  code: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

const DEFAULT_TIMEOUT_MS = 5_000;
/** `pane read` can dump a busy pane's screen; keep an explicit bound. */
const READ_TIMEOUT_MS = 5_000;
export const HERDR_READ_MAX_BYTES = 512 * 1024;

export function runHerdr(args: string[], timeoutMs: number = DEFAULT_TIMEOUT_MS): Promise<HerdrRunResult> {
  const bin = herdrBin();
  if (!bin) {
    return Promise.resolve({ code: -1, stdout: "", stderr: "herdr attach is disabled (OMP_WEB_HERDR_BIN not set)", timedOut: false });
  }
  return new Promise((resolve) => {
    let settled = false;
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const proc = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    const timer = setTimeout(() => {
      timedOut = true;
      try { proc.kill(); } catch { /* already gone */ }
    }, timeoutMs);
    timer.unref?.();
    const finish = (code: number) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut });
    };
    proc.stdout?.on("data", (chunk: Buffer) => {
      if (stdout.length < HERDR_READ_MAX_BYTES) stdout += chunk.toString("utf8");
    });
    proc.stderr?.on("data", (chunk: Buffer) => {
      if (stderr.length < 64 * 1024) stderr += chunk.toString("utf8");
    });
    proc.once("error", (error) => {
      stderr += String(error);
      finish(-1);
    });
    proc.once("close", (code) => finish(typeof code === "number" ? code : -1));
  });
}

// ============================================================================
// Pane commands
// ============================================================================

/** `herdr pane list --json` → parsed panes ([] when disabled/failed). */
export async function listHerdrPanes(): Promise<{ enabled: boolean; panes: HerdrPaneMeta[]; error?: string }> {
  if (!isHerdrAttachEnabled()) return { enabled: false, panes: [] };
  const result = await runHerdr(["pane", "list", "--json"]);
  if (result.code !== 0 && result.stdout.trim() === "") {
    return { enabled: true, panes: [], error: result.timedOut ? "herdr pane list timed out" : (result.stderr.trim() || `herdr exited with code ${result.code}`) };
  }
  const panes = parsePaneList(result.stdout);
  return { enabled: true, panes };
}

/** `herdr pane read <id>` → the pane's screen text snapshot. */
export async function readHerdrPane(paneId: string): Promise<{ ok: boolean; content: string; error?: string }> {
  if (!isValidPaneId(paneId)) return { ok: false, content: "", error: "invalid pane id" };
  const result = await runHerdr(["pane", "read", paneId], READ_TIMEOUT_MS);
  if (result.code !== 0) {
    return { ok: false, content: "", error: result.timedOut ? "herdr pane read timed out" : (result.stderr.trim() || `herdr exited with code ${result.code}`) };
  }
  return { ok: true, content: result.stdout };
}

/** `herdr pane send-text <id> <text>` — typed text including paste payloads. */
export async function sendHerdrText(paneId: string, text: string): Promise<{ ok: boolean; error?: string }> {
  if (!isValidPaneId(paneId)) return { ok: false, error: "invalid pane id" };
  const result = await runHerdr(["pane", "send-text", paneId, text]);
  return result.code === 0
    ? { ok: true }
    : { ok: false, error: result.stderr.trim() || `herdr exited with code ${result.code}` };
}

/** `herdr pane send-keys <id> <keys>` — key names (Enter, C-c, …). */
export async function sendHerdrKeys(paneId: string, keys: string): Promise<{ ok: boolean; error?: string }> {
  if (!isValidPaneId(paneId)) return { ok: false, error: "invalid pane id" };
  const result = await runHerdr(["pane", "send-keys", paneId, keys]);
  return result.code === 0
    ? { ok: true }
    : { ok: false, error: result.stderr.trim() || `herdr exited with code ${result.code}` };
}

/** `herdr pane resize <id> <cols> <rows>`. Plain-pipe local terminals have no
 * size signaling — resize is a herdr-mode-only affordance (documented trap). */
export async function resizeHerdrPane(paneId: string, cols: number, rows: number): Promise<{ ok: boolean; error?: string }> {
  if (!isValidPaneId(paneId)) return { ok: false, error: "invalid pane id" };
  if (!Number.isInteger(cols) || cols < 2 || cols > 1000 || !Number.isInteger(rows) || rows < 2 || rows > 1000) {
    return { ok: false, error: "invalid size" };
  }
  const result = await runHerdr(["pane", "resize", paneId, String(cols), String(rows)]);
  return result.code === 0
    ? { ok: true }
    : { ok: false, error: result.stderr.trim() || `herdr exited with code ${result.code}` };
}

// ============================================================================
// omp-web-side ownership claims (globalThis — hot-reload safe)
// ============================================================================

declare global {
  var __ompHerdrOwnedPanes: Set<string> | undefined;
}

function getOwnedPanes(): Set<string> {
  if (!globalThis.__ompHerdrOwnedPanes) globalThis.__ompHerdrOwnedPanes = new Set();
  return globalThis.__ompHerdrOwnedPanes;
}

/** Attach as owner: only allowed when herdr reports the pane unowned. */
export async function claimHerdrPane(paneId: string): Promise<{ ok: boolean; error?: string }> {
  if (!isValidPaneId(paneId)) return { ok: false, error: "invalid pane id" };
  const { enabled, panes } = await listHerdrPanes();
  if (!enabled) return { ok: false, error: "herdr attach is disabled" };
  const pane = panes.find((p) => p.id === paneId);
  if (!pane) return { ok: false, error: "pane not found" };
  if (!isPaneAttachable(pane)) return { ok: false, error: `pane is owned by ${pane.owner}` };
  getOwnedPanes().add(paneId);
  return { ok: true };
}

export function releaseHerdrPane(paneId: string): void {
  if (!isValidPaneId(paneId)) return;
  getOwnedPanes().delete(paneId);
}

/** Writes (send-text / send-keys / resize) require an omp-web owner claim —
 * non-owner panes are strictly read-only watch targets. */
export function isHerdrPaneOwner(paneId: string): boolean {
  return isValidPaneId(paneId) && getOwnedPanes().has(paneId);
}
