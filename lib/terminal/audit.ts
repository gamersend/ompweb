// ============================================================================
// Terminal input audit (Phase 13) — firedeck console's audit discipline,
// ported: every terminal input batch appends one JSONL row to
// ~/.omp/agent/web-terminal-audit.jsonl, rotated at 1 MB (web-terminal-audit
// .jsonl.1 keeps the previous generation).
//
// Privacy note: rows carry metadata ONLY (ts, terminalId, cwd, bytes, short
// content hash). Keystrokes may include typed passwords — they are never
// written; the hash makes a batch recognizable without being reversible.
// ============================================================================

import { appendFileSync, existsSync, mkdirSync, renameSync, statSync } from "fs";
import { dirname, join } from "path";
import { getAgentDir } from "../omp/paths";

export const AUDIT_FILE_NAME = "web-terminal-audit.jsonl";
export const AUDIT_ROTATED_SUFFIX = ".1";
/** Rotate when the active file would exceed 1 MB (BUILD-PLAN: "1 MB rotate"). */
export const AUDIT_ROTATE_BYTES = 1024 * 1024;

export function terminalAuditPath(): string {
  return join(getAgentDir(), AUDIT_FILE_NAME);
}

export interface TerminalAuditEntry {
  ts: string;
  terminalId: string;
  cwd: string;
  bytes: number;
  hash: string;
  /** Extra context (e.g. route action) without any payload content. */
  kind?: string;
}

/** Append one audit row; creates the agent dir on demand and rotates at the
 * byte cap. Never throws to the caller — an audit failure must not break the
 * input path (the write already happened by the time routes call this). */
export function appendTerminalAudit(entry: TerminalAuditEntry): void {
  try {
    const file = terminalAuditPath();
    const dir = dirname(file);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    if (existsSync(file)) {
      let size = 0;
      try { size = statSync(file).size; } catch { /* raced with rotation */ }
      if (size >= AUDIT_ROTATE_BYTES) {
        try { renameSync(file, file + AUDIT_ROTATED_SUFFIX); } catch { /* best effort */ }
      }
    }
    appendFileSync(file, JSON.stringify(entry) + "\n", "utf8");
  } catch {
    // Audit is best-effort by design; input must keep working.
  }
}
