import { existsSync, readdirSync, readFileSync, statSync } from "fs";
import { join, resolve } from "path";
import { getAgentDir } from "./omp/paths";

// ============================================================================
// Store health diagnostics (wave 3 P5.4 / R3-30).
//
// A READ-ONLY health census of every ompweb-owned store file: exists, size,
// last write, parse status (using each store's own exported migrate parser
// where practical, else a structural JSON check), declared version, entry
// counts, and quarantine/backup presence (.bak-* siblings). Never mutates a
// store, never renders file CONTENTS, credentials, prompts, or transcript
// text — only counts and health words. This is deliberately NOT a filesystem
// browser: the registry below is a fixed list.
//
// omp's OWN files (agent.db, stats.db, config.yml, session JSONL, plugins…)
// are intentionally absent — those are not ours to diagnose.
// ============================================================================

export type StoreHealth = "ok" | "missing" | "corrupt" | "unreadable" | "empty";

export interface StoreDiagnostic {
  /** Stable id for UI/sort. */
  id: string;
  /** File name relative to the omp agent dir (safe to display). */
  file: string;
  /** What the store is for, one short line (i18n key resolved client-side). */
  descriptionKey: string;
  health: StoreHealth;
  /** File size in bytes; null when missing/unreadable. */
  bytes: number | null;
  /** Last write (mtime ISO); null when missing/unreadable. */
  lastWrite: string | null;
  /** Declared schema `version` field, when the store carries one. */
  version: number | null;
  /** Entry/row counts where cheaply available (bounded stores only). */
  counts: Record<string, number>;
  /** Quarantined backups (*.bak-*) — evidence of past corruption. */
  backups: number;
  /** Bounded cap for the primary count, when the store has one (retention). */
  cap: number | null;
}

interface StoreSpec {
  id: string;
  file: string;
  descriptionKey: string;
  cap?: number | null;
  /** Optional store-specific parse → {version, counts, corrupt}. */
  inspect?: (raw: string) => { ok: boolean; version: number | null; counts: Record<string, number> };
}

/** Structural JSON probe for stores without an exported parser in scope. */
function jsonInspect(expectedKeys: string[]): StoreSpec["inspect"] {
  return (raw) => {
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { ok: false, version: null, counts: {} };
      const record = parsed as Record<string, unknown>;
      const version = typeof record.version === "number" ? record.version : null;
      const counts: Record<string, number> = {};
      for (const key of expectedKeys) {
        const value = record[key];
        if (Array.isArray(value)) counts[key] = value.length;
        else if (value && typeof value === "object") counts[key] = Object.keys(value).length;
      }
      return { ok: true, version, counts };
    } catch {
      return { ok: false, version: null, counts: {} };
    }
  };
}

function countJsonlLines(raw: string): number {
  let lines = 0;
  for (let i = 0; i < raw.length; i++) if (raw.charCodeAt(i) === 10) lines += 1;
  return raw.length > 0 ? lines + (raw.endsWith("\n") ? 0 : 1) : 0;
}

const REGISTRY: StoreSpec[] = [
  {
    id: "client-state",
    file: "web-client-state.json",
    descriptionKey: "diagnostics.stores.clientState",
    cap: 256,
    inspect: (raw): { ok: boolean; version: number | null; counts: Record<string, number> } => {
      try {
        const parsed = JSON.parse(raw) as Record<string, unknown>;
        if (!parsed || typeof parsed !== "object") return { ok: false, version: null, counts: {} };
        const keys = parsed.keys && typeof parsed.keys === "object" ? Object.keys(parsed.keys as object).length : 0;
        const tombstones = parsed.tombstones && typeof parsed.tombstones === "object" ? Object.keys(parsed.tombstones as object).length : 0;
        return { ok: true, version: typeof parsed.version === "number" ? parsed.version : null, counts: { keys, tombstones } };
      } catch {
        return { ok: false, version: null, counts: {} };
      }
    },
  },
  {
    id: "notify-feed",
    file: "web-notify.json",
    descriptionKey: "diagnostics.stores.notifyFeed",
    cap: 500,
    inspect: jsonInspect(["rows"]),
  },
  {
    id: "notify-config",
    file: "web-notify-config.json",
    descriptionKey: "diagnostics.stores.notifyConfig",
    inspect: jsonInspect(["webhook", "push"]),
  },
  {
    id: "push-subs",
    file: "web-push-subs.json",
    descriptionKey: "diagnostics.stores.pushSubs",
    cap: 20,
    inspect: jsonInspect(["subs"]),
  },
  {
    id: "push-keys",
    file: "web-push-keys.json",
    descriptionKey: "diagnostics.stores.pushKeys",
    // presence-only: the VAPID keypair is never parsed or echoed here
    inspect: jsonInspect(["publicKey", "privateKey"]),
  },
  {
    id: "schedules",
    file: "web-schedules.json",
    descriptionKey: "diagnostics.stores.schedules",
    inspect: jsonInspect(["jobs"]),
  },
  {
    id: "digest",
    file: "web-digest.json",
    descriptionKey: "diagnostics.stores.digest",
    inspect: jsonInspect([]),
  },
  {
    id: "delegations",
    file: "web-delegations.json",
    descriptionKey: "diagnostics.stores.delegations",
    cap: 200,
    inspect: jsonInspect(["delegations"]),
  },
  {
    id: "checkpoint-ledger",
    file: "web-checkpoint-ledger.json",
    descriptionKey: "diagnostics.stores.checkpointLedger",
    cap: 200,
    inspect: jsonInspect(["entries"]),
  },
  {
    id: "snippets",
    file: "snippets.json",
    descriptionKey: "diagnostics.stores.snippets",
    cap: 500,
    inspect: jsonInspect(["items"]),
  },
  {
    id: "projects",
    file: "projects.json",
    descriptionKey: "diagnostics.stores.projects",
    inspect: jsonInspect(["projects"]),
  },
  {
    id: "client-service",
    file: "web-service.json",
    descriptionKey: "diagnostics.stores.serviceConfig",
    // passwordSet is the only fact worth counting — never the value
    inspect: (raw): { ok: boolean; version: number | null; counts: Record<string, number> } => {
      try {
        const parsed = JSON.parse(raw) as Record<string, unknown>;
        return {
          ok: typeof parsed === "object" && parsed !== null,
          version: null,
          counts: { passwordSet: parsed && typeof parsed === "object" && typeof parsed.password === "string" && parsed.password.length > 0 ? 1 : 0 },
        };
      } catch {
        return { ok: false, version: null, counts: {} };
      }
    },
  },
];

function countBackups(dir: string, fileName: string): number {
  try {
    return readdirSync(dir).filter((name) => name.startsWith(`${fileName}.bak-`)).length;
  } catch {
    return 0;
  }
}

function fileBytes(path: string): number | null {
  try {
    return statSync(path).size;
  } catch {
    return null;
  }
}

function fileMtime(path: string): string | null {
  try {
    return statSync(path).mtime.toISOString();
  } catch {
    return null;
  }
}

/** Read-only health probe over the fixed registry. Never throws. */
export function collectStoreDiagnostics(): { agentDir: string; stores: StoreDiagnostic[] } {
  const agentDir = getAgentDir();
  const stores: StoreDiagnostic[] = [];
  for (const spec of REGISTRY) {
    const path = resolve(agentDir, spec.file);
    const diagnostic: StoreDiagnostic = {
      id: spec.id,
      file: spec.file,
      descriptionKey: spec.descriptionKey,
      health: "missing",
      bytes: null,
      lastWrite: null,
      version: null,
      counts: {},
      backups: countBackups(agentDir, spec.file),
      cap: spec.cap ?? null,
    };
    if (!existsSync(path)) {
      stores.push(diagnostic);
      continue;
    }
    diagnostic.bytes = fileBytes(path);
    diagnostic.lastWrite = fileMtime(path);
    let raw: string | null = null;
    try {
      raw = readFileSync(path, "utf8");
    } catch {
      diagnostic.health = "unreadable";
      stores.push(diagnostic);
      continue;
    }
    if (raw.trim() === "") {
      diagnostic.health = "empty";
      stores.push(diagnostic);
      continue;
    }
    const inspected = spec.inspect ? spec.inspect(raw) : { ok: true, version: null, counts: {} };
    if (!inspected.ok) {
      diagnostic.health = "corrupt";
    } else {
      diagnostic.health = "ok";
      diagnostic.version = inspected.version;
      diagnostic.counts = inspected.counts;
    }
    stores.push(diagnostic);
  }
  return { agentDir: "", stores };
}

/** The audit JSONL is line-shaped, not JSON — special-cased so the panel can
 *  show its row count without parsing keystroke-hash rows as JSON. */
export function terminalAuditHealth(): StoreDiagnostic {
  const agentDir = getAgentDir();
  const file = "web-terminal-audit.jsonl";
  const path = join(agentDir, file);
  const diagnostic: StoreDiagnostic = {
    id: "terminal-audit",
    file,
    descriptionKey: "diagnostics.stores.terminalAudit",
    health: "missing",
    bytes: null,
    lastWrite: null,
    version: null,
    counts: {},
    backups: countBackups(agentDir, file),
    cap: null,
  };
  if (!existsSync(path)) return diagnostic;
  diagnostic.bytes = fileBytes(path);
  diagnostic.lastWrite = fileMtime(path);
  try {
    diagnostic.health = "ok";
    diagnostic.counts = { rows: countJsonlLines(readFileSync(path, "utf8")) };
  } catch {
    diagnostic.health = "unreadable";
  }
  return diagnostic;
}
