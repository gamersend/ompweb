import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "fs";
import { resolve } from "path";
import { getAgentDir } from "./omp/paths";

// ============================================================================
// Durable delegation ledger (wave 3 P5.2 / R3-08).
//
// ~/.omp/agent/web-delegations.json records every SUCCESSFUL session→session
// delegation so the model report, the digest, and the runs board can attribute
// work to its origin instead of reporting it as anonymous/manual. Before this
// store the only record was the in-process globalThis ledger in
// lib/delegate.ts (busy-window bookkeeping — intentionally ephemeral) plus
// prunable notify feed rows; both survive neither a restart nor the feed cap.
//
// ompweb-owned store, shared pattern: `version` field, migrate-or-quarantine
// on read, atomic temp+rename writes, bounded (200 entries, oldest dropped —
// attribution is a recent-history concern, not an archive). No transcript
// text: titles/paths stay out — just session ids, the mode, and the time.
// ============================================================================

export const DELEGATION_LEDGER_FILE = "web-delegations.json";
/** Retention: recent-history only. */
export const MAX_DELEGATION_LEDGER_ENTRIES = 200;

export interface DelegationLedgerEntry {
  /** Target session (where the delegated work LANDED). */
  toSession: string;
  /** Source session (whose output was delegated). */
  fromSession: string;
  /** Delivery time (epoch ms) — also the recency/sort key. */
  tsMs: number;
  mode: "queued" | "prompt" | "spawned";
}

export interface DelegationLedgerFile {
  version: 1;
  delegations: DelegationLedgerEntry[];
}

function isEntryLike(value: unknown): value is DelegationLedgerEntry {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const entry = value as Partial<DelegationLedgerEntry>;
  return typeof entry.toSession === "string" && entry.toSession.length > 0
    && typeof entry.fromSession === "string" && entry.fromSession.length > 0
    && typeof entry.tsMs === "number" && Number.isFinite(entry.tsMs) && entry.tsMs > 0
    && (entry.mode === "queued" || entry.mode === "prompt" || entry.mode === "spawned");
}

/** Parse + migrate. Null = structurally broken → caller quarantines + rebuilds
 *  (never silent). Invalid individual entries are skipped. */
export function migrateDelegationLedger(raw: string): DelegationLedgerFile | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const source = parsed as Record<string, unknown>;
  if (typeof source.version === "number" && source.version > 1) return null;
  if (!Array.isArray(source.delegations)) return null;
  const byKey = new Map<string, DelegationLedgerEntry>();
  for (const item of source.delegations) {
    if (!isEntryLike(item)) continue;
    // Dedup: one record per (target, source, time) — a replayed write is a no-op.
    const key = `${item.toSession}\u0000${item.fromSession}\u0000${item.tsMs}`;
    if (!byKey.has(key)) byKey.set(key, item);
  }
  const delegations = [...byKey.values()].sort((a, b) => b.tsMs - a.tsMs).slice(0, MAX_DELEGATION_LEDGER_ENTRIES);
  return { version: 1, delegations };
}

export function getDelegationLedgerPath(): string {
  return resolve(getAgentDir(), DELEGATION_LEDGER_FILE);
}

function quarantineLedgerFile(filePath: string): void {
  try {
    renameSync(filePath, `${filePath}.bak-${Date.now()}`);
  } catch {
    // Best-effort: an unrenamable file is left alone rather than blocking loads.
  }
}

export function loadDelegationLedger(): DelegationLedgerFile {
  const filePath = getDelegationLedgerPath();
  if (!existsSync(filePath)) return { version: 1, delegations: [] };
  let raw: string;
  try {
    raw = readFileSync(filePath, "utf8");
  } catch {
    return { version: 1, delegations: [] };
  }
  const migrated = migrateDelegationLedger(raw);
  if (migrated === null) {
    quarantineLedgerFile(filePath);
    return { version: 1, delegations: [] };
  }
  return migrated;
}

/** Atomic persistence (temp + rename in the same directory). */
export function saveDelegationLedger(ledger: DelegationLedgerFile): void {
  const filePath = getDelegationLedgerPath();
  mkdirSync(resolve(filePath, ".."), { recursive: true });
  const temp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  try {
    writeFileSync(temp, `${JSON.stringify(ledger, null, 2)}\n`, "utf8");
    renameSync(temp, filePath);
  } finally {
    try {
      if (existsSync(temp)) rmSync(temp);
    } catch {
      // ignore cleanup failures
    }
  }
}

/** Append one delivered delegation (deduped, bounded, persisted). */
export function recordDelegationDelivery(entry: DelegationLedgerEntry): DelegationLedgerFile {
  const current = loadDelegationLedger();
  const key = `${entry.toSession}\u0000${entry.fromSession}\u0000${entry.tsMs}`;
  if (current.delegations.some((existing) => `${existing.toSession}\u0000${existing.fromSession}\u0000${existing.tsMs}` === key)) {
    return current;
  }
  const delegations = [entry, ...current.delegations]
    .sort((a, b) => b.tsMs - a.tsMs)
    .slice(0, MAX_DELEGATION_LEDGER_ENTRIES);
  const ledger: DelegationLedgerFile = { version: 1, delegations };
  saveDelegationLedger(ledger);
  return ledger;
}

/** Target session id → most recent delegation (for origin attribution). */
export function collectDelegatedSessions(): Map<string, DelegationLedgerEntry> {
  const map = new Map<string, DelegationLedgerEntry>();
  try {
    for (const entry of loadDelegationLedger().delegations) {
      if (!map.has(entry.toSession)) map.set(entry.toSession, entry);
    }
  } catch {
    // never break a report over origin labels
  }
  return map;
}
