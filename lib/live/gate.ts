/**
 * The live voice feature gate.
 *
 * Decision (documented in docs/agent-notes-PVoice.md): the lane is ON when
 * the capability is actually present — an omp binary with at least one stored
 * ChatGPT Codex OAuth account — and OFF otherwise, with `OMP_WEB_LIVE_ENABLED`
 * as an explicit override:
 *
 *   - `OMP_WEB_LIVE_ENABLED=0` forces the lane OFF even when capable;
 *   - `OMP_WEB_LIVE_ENABLED=1` forces the route handlers enabled (useful for
 *     smoke-testing the error envelopes before logging into Codex);
 *   - unset → auto: enabled exactly when omp exists and a Codex OAuth account
 *     is stored (probed via `omp token openai-codex --list`, which prints
 *     account metadata only — no tokens can leak through this gate).
 *
 * The probe is cached briefly so the status route stays cheap; a cache miss
 * after 5 minutes re-probes, so a fresh `omp` login is picked up without a
 * server restart.
 */

import { OMP_CODEX_PROVIDER } from "./protocol";
import { listCodexAccounts, type CodexAccount } from "./token";
import { resolveOmpBin } from "@/lib/omp/omp-cli";

export type LiveGateReason =
  | "ok"
  | "env_off"
  | "env_on"
  | "omp_unavailable"
  | "no_codex_account";

export interface LiveGate {
  enabled: boolean;
  reason: LiveGateReason;
  /** Account metadata for the status route; only present when probed. */
  accounts?: CodexAccount[];
}

interface GateCache {
  at: number;
  gate: LiveGate;
}

const PROBE_TTL_MS = 5 * 60_000;

// Process/globalThis-keyed so Next.js hot reload cannot fork the cache — the
// same discipline as rpc-manager.ts.
const G_KEY = "__ompweb_live_gate_cache__";
function cacheStore(): { cache?: GateCache } {
  const g = globalThis as Record<string, unknown>;
  if (!g[G_KEY] || typeof g[G_KEY] !== "object") g[G_KEY] = {};
  return g[G_KEY] as { cache?: GateCache };
}

function envOverride(): "on" | "off" | null {
  const raw = process.env.OMP_WEB_LIVE_ENABLED?.trim();
  if (raw === "1" || raw === "true") return "on";
  if (raw === "0" || raw === "false") return "off";
  return null;
}

/** Read the gate, probing omp when no env override forces an answer. */
export async function getLiveGate(): Promise<LiveGate> {
  const override = envOverride();
  if (override === "off") return { enabled: false, reason: "env_off" };

  const store = cacheStore();
  const now = Date.now();
  if (store.cache && now - store.cache.at < PROBE_TTL_MS) {
    // An env_on override can force-enable over a cached "not capable" probe.
    if (override === "on") {
      return { ...store.cache.gate, enabled: true, reason: "env_on" };
    }
    return store.cache.gate;
  }

  const gate = await probeGate();
  store.cache = { at: now, gate };
  if (override === "on") return { ...gate, enabled: true, reason: "env_on" };
  return gate;
}

async function probeGate(): Promise<LiveGate> {
  if (!resolveOmpBin()) return { enabled: false, reason: "omp_unavailable" };
  try {
    const accounts = await listCodexAccounts();
    if (accounts.length === 0) return { enabled: false, reason: "no_codex_account" };
    return { enabled: true, reason: "ok", accounts };
  } catch {
    // `omp token --list` failing usually means no stored account for the
    // provider; either way the lane is not usable right now.
    return { enabled: false, reason: "no_codex_account" };
  }
}

/** Tests only — forget the cached probe. */
export function resetLiveGateForTests(): void {
  cacheStore().cache = undefined;
}
