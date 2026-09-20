/**
 * ElevenLabs voice metadata for the live lane's RESULT speech — server-side
 * only (node:fs / node:os; never import this from client code).
 *
 * Ground truth is omp's own terminal extension
 * (`~/.omp/agent/extensions/live-elevenlabs/env.ts`): the credential is
 * `ELEVENLABS_API_KEY` from process.env, falling back to a parse of the
 * agent `.env` file (`$AGENT_DIR/.env`, `~/.omp/agent/.env`, `~/.pi/agent/.env`).
 * ompweb does NOT load that file at boot, so the fallback parse happens here,
 * read-only, on demand. The key exists only inside this module's request
 * frames: it is forwarded to api.elevenlabs.io as a header and NEVER echoed,
 * logged, or persisted.
 *
 * Scope (voice round 3, deliberate deviation from the terminal extension):
 * this proxy serves the read-only voice LIST for the picker and the settings
 * status probe. The result speech itself is a one-shot POST to the existing
 * /api/tts proxy; the CONVERSATIONAL call audio stays the native live voice,
 * browser↔OpenAI direct. No audio bytes and no media relay ever flow through
 * here — JSON metadata only.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const EL_VOICES_URL = "https://api.elevenlabs.io/v1/voices";
export const EL_VOICES_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
export const EL_VOICES_TIMEOUT_MS = 20_000;
/** A long account list must not balloon the response; the picker is a select. */
export const EL_VOICES_MAX = 200;

/** Exactly the fields the picker needs — the wire shape of a proxied voice. */
export interface ElVoiceInfo {
  voice_id: string;
  name: string;
  labels: Record<string, string>;
}

// ─── credential resolution ───────────────────────────────────────────────────

function cleanEnvValue(value: string | undefined): string | null {
  const cleaned = value?.replace(/\\n|[\r\n]/g, "").trim();
  return cleaned ? cleaned : null;
}

/**
 * Parse KEY=VALUE lines from an agent .env (the extension's contract):
 * comments and blank lines skipped, quoted values unquoted, malformed lines
 * ignored. Pure — tests feed it fixture text.
 */
export function parseAgentDotEnv(contents: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

/** The .env candidates in the extension's order (deduped). Injectable so
 * tests can point at a fixture file without touching the real home. */
export function agentEnvCandidates(home = homedir()): string[] {
  const override = process.env.PI_CODING_AGENT_DIR?.trim() || process.env.OMP_AGENT_DIR?.trim();
  const candidates = override ? [join(override, ".env")] : [];
  candidates.push(join(home, ".omp", "agent", ".env"));
  candidates.push(join(home, ".pi", "agent", ".env"));
  return [...new Set(candidates)];
}

/**
 * The ElevenLabs key: process.env first (a shell-exported value wins, same
 * as the extension), then the agent .env files. Null when nowhere — the
 * route answers `el_not_configured`. Never logged.
 */
export function resolveElApiKey(
  env: Record<string, string | undefined> = process.env,
  candidates: string[] = agentEnvCandidates(),
): string | null {
  const direct = cleanEnvValue(env.ELEVENLABS_API_KEY);
  if (direct) return direct;
  for (const path of candidates) {
    if (!existsSync(path)) continue;
    try {
      const parsed = parseAgentDotEnv(readFileSync(path, "utf8"));
      const value = cleanEnvValue(parsed.ELEVENLABS_API_KEY);
      if (value) return value;
    } catch {
      /* an unreadable .env stays silent — the route just reports unconfigured */
    }
  }
  return null;
}

/** Cheap probe for the status endpoint: is a key resolvable at all? */
export function hasElApiKey(): boolean {
  return currentElApiKey() !== null;
}

/** Injectable key resolver for tests (a real install falls through to the
 * agent .env, so "unconfigured" needs a seam, not a deleted env var). */
const KEY_RESOLVER_KEY = "__ompweb_el_api_key_resolver__";

export function _setElApiKeyResolver(fake: (() => string | null) | null): void {
  const g = globalThis as Record<string, unknown>;
  if (fake) g[KEY_RESOLVER_KEY] = fake;
  else delete g[KEY_RESOLVER_KEY];
}

function currentElApiKey(): string | null {
  const seam = (globalThis as Record<string, unknown>)[KEY_RESOLVER_KEY];
  if (typeof seam === "function") return (seam as () => string | null)();
  return resolveElApiKey();
}

// ─── payload parsing (tolerant, like every upstream-facing reader) ───────────

function parseLabels(raw: unknown): Record<string, string> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value === "string") out[key] = value;
  }
  return out;
}

/** Tolerant parse of the ElevenLabs voices payload: string id+name required,
 * labels coerced, entries capped. Junk fields are dropped, not fatal. */
export function parseElVoicesPayload(payload: unknown): ElVoiceInfo[] {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return [];
  const voices = (payload as { voices?: unknown }).voices;
  if (!Array.isArray(voices)) return [];
  const out: ElVoiceInfo[] = [];
  for (const entry of voices) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const record = entry as Record<string, unknown>;
    if (typeof record.voice_id !== "string" || !record.voice_id) continue;
    if (typeof record.name !== "string" || !record.name) continue;
    out.push({ voice_id: record.voice_id, name: record.name, labels: parseLabels(record.labels) });
    if (out.length >= EL_VOICES_MAX) break;
  }
  return out;
}

// ─── cached fetch ────────────────────────────────────────────────────────────

const CACHE_KEY = "__ompweb_el_voices_cache__";

interface ElVoicesCache {
  at: number;
  voices: ElVoiceInfo[];
}

function readCache(): ElVoicesCache | null {
  const cached = (globalThis as Record<string, unknown>)[CACHE_KEY];
  return cached && typeof cached === "object" ? (cached as ElVoicesCache) : null;
}

function writeCache(entry: ElVoicesCache): void {
  (globalThis as Record<string, unknown>)[CACHE_KEY] = entry;
}

/** Test seams — seed/forget the cache without touching the wire. */
export function _seedElVoicesCache(at: number, voices: ElVoiceInfo[]): void {
  writeCache({ at, voices });
}
export function _clearElVoicesCache(): void {
  delete (globalThis as Record<string, unknown>)[CACHE_KEY];
}

/** Injectable transport, same globalThis discipline as lib/live/signaling. */
const HTTP_FETCH_KEY = "__ompweb_el_voices_http__";

export function _setElVoicesHttp(fake: typeof fetch | null): void {
  const g = globalThis as Record<string, unknown>;
  if (fake) g[HTTP_FETCH_KEY] = fake;
  else delete g[HTTP_FETCH_KEY];
}

function elFetch(): typeof fetch {
  const seam = (globalThis as Record<string, unknown>)[HTTP_FETCH_KEY];
  if (typeof seam === "function") return seam as typeof fetch;
  return (...args) => fetch(...args);
}

export type ElVoicesResult =
  | { ok: true; voices: ElVoiceInfo[]; cached: boolean }
  | { ok: false; reason: "not_configured" | "upstream" };

/**
 * The voice list: fresh within the TTL, refetched after, and a stale cache
 * still answers when upstream is down (a picker must not break because one
 * refresh failed). `force` bypasses the freshness check.
 */
export async function fetchElVoices(force = false): Promise<ElVoicesResult> {
  const cached = readCache();
  const fresh = cached !== null && Date.now() - cached.at < EL_VOICES_CACHE_TTL_MS;
  if (!force && cached && fresh) {
    return { ok: true, voices: cached.voices, cached: true };
  }

  const apiKey = currentElApiKey();
  if (!apiKey) return { ok: false, reason: "not_configured" };

  let res: Response;
  try {
    res = await elFetch()(EL_VOICES_URL, {
      method: "GET",
      headers: { Accept: "application/json", "xi-api-key": apiKey },
      signal: AbortSignal.timeout(EL_VOICES_TIMEOUT_MS),
    });
  } catch {
    return cached
      ? { ok: true, voices: cached.voices, cached: true }
      : { ok: false, reason: "upstream" };
  }
  if (!res.ok) {
    return cached
      ? { ok: true, voices: cached.voices, cached: true }
      : { ok: false, reason: "upstream" };
  }

  let payload: unknown = null;
  try {
    payload = await res.json();
  } catch {
    return cached
      ? { ok: true, voices: cached.voices, cached: true }
      : { ok: false, reason: "upstream" };
  }
  const voices = parseElVoicesPayload(payload);
  writeCache({ at: Date.now(), voices });
  return { ok: true, voices, cached: false };
}
