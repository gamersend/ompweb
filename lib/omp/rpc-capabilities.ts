// ============================================================================
// RPC capability adapter (BUILD-PLAN-3 P1 / R3-28).
//
// The installed omp negotiates a protocol (ready frame) and announces live
// command metadata (available_commands_update). Wave-3 native surfacing must
// not GUESS capability from a name it has never seen: every command family a
// future phase wants to render goes through here and comes back an explicit
// supported / unsupported flag with the reason it is unsupported.
//
// Pure module — no child process, no fs. The sanitized fixtures in
// tests/fixtures/rpc/ are the contract samples this normalizer must accept;
// lib/omp/rpc-capabilities.test.mjs loads every fixture and asserts shape.
//
// Sanitization rule for fixtures: hand-authored structural samples only — no
// transcript text, file contents, tokens, credentials, or personal paths.
// ============================================================================

/** Shapes the ready frame must have per the RPC contract (protocol v1–v2). */
export interface RpcReadyInfo {
  /** The protocol this child speaks (omp announces 1; negotiation may lift to 2). */
  protocolVersion: number;
  supportedProtocolVersions: number[];
  maxFrameBytes: number | null;
  maxReassembledFrameBytes: number | null;
}

export interface RpcCommandInfo {
  name: string;
  source: string;
  description?: string;
}

/** Explicit capability verdict for one native command family. */
export interface NativeCapability {
  name: string;
  supported: boolean;
  /** Why not, when unsupported. Unknown names are "unknown_command" — never guessed. */
  reason?: "missing_command" | "stale_version" | "malformed_response" | "transport_disconnected" | "unknown_command";
  /** Protocol version the verdict was derived against. */
  protocolVersion?: number;
}

/** Why a native probe answered "no capability surface at all". */
export type RpcTransportState = "connected" | "disconnected" | "unprobed";

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/**
 * Parse + validate a ready frame. Returns null for malformed input (wrong
 * shape, non-numeric versions, empty supported list) — the caller treats that
 * as `malformed_response`, never as a working transport.
 */
export function parseRpcReady(raw: unknown): RpcReadyInfo | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  if (typeof record.type === "string" && record.type !== "ready") return null;
  if (!isFiniteNumber(record.protocolVersion) || record.protocolVersion < 1) return null;
  const supported = Array.isArray(record.supportedProtocolVersions)
    ? record.supportedProtocolVersions.filter(isFiniteNumber)
    : [];
  if (supported.length === 0) return null;
  return {
    protocolVersion: record.protocolVersion,
    supportedProtocolVersions: supported,
    maxFrameBytes: isFiniteNumber(record.maxFrameBytes) ? record.maxFrameBytes : null,
    maxReassembledFrameBytes: isFiniteNumber(record.maxReassembledFrameBytes) ? record.maxReassembledFrameBytes : null,
  };
}

/** Could this child speak `want` (negotiation candidate)? A stale child that
 * only offers v1 fails a v2 candidate — surfaced as `stale_version`. */
export function supportsProtocol(ready: RpcReadyInfo | null, want: number): boolean {
  if (!ready) return false;
  return ready.supportedProtocolVersions.includes(want) || ready.protocolVersion === want;
}

/** Sanitize one available-commands payload. Malformed entries are dropped
 * (never guessed into something usable); duplicates keep the first. */
export function normalizeAvailableCommands(raw: unknown): RpcCommandInfo[] {
  if (!raw || typeof raw !== "object") return [];
  const record = raw as Record<string, unknown>;
  const list = Array.isArray(record.commands) ? record.commands : Array.isArray(raw) ? raw : [];
  const out: RpcCommandInfo[] = [];
  const seen = new Set<string>();
  for (const item of list) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const entry = item as Record<string, unknown>;
    if (typeof entry.name !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(entry.name)) continue;
    if (seen.has(entry.name)) continue;
    seen.add(entry.name);
    const info: RpcCommandInfo = {
      name: entry.name,
      source: typeof entry.source === "string" && entry.source.length > 0 ? entry.source : "unknown",
    };
    if (typeof entry.description === "string" && entry.description.length > 0) {
      info.description = entry.description.slice(0, 200);
    }
    out.push(info);
  }
  return out;
}

/**
 * Capability verdicts for the wanted command families against one probe.
 * A disconnected/unprobed transport marks every family
 * `transport_disconnected`; a malformed ready frame marks them
 * `malformed_response`; a name absent from the announced commands is
 * `missing_command` (a versioned child that does not ship it) — or
 * `unknown_command` when the caller explicitly flagged the name as one we
 * do not know how to render at all.
 */
export function deriveCapabilities(input: {
  transport: RpcTransportState;
  ready: RpcReadyInfo | null;
  commands: RpcCommandInfo[];
  wanted: ReadonlyArray<{ name: string; known?: boolean }>;
}): NativeCapability[] {
  const available = new Set(input.commands.map((command) => command.name));
  return input.wanted.map(({ name, known }) => {
    const base: NativeCapability = { name, supported: false, protocolVersion: input.ready?.protocolVersion };
    if (input.transport !== "connected") return { ...base, reason: "transport_disconnected" };
    if (!input.ready) return { ...base, reason: "malformed_response" };
    if (known === false) return { ...base, reason: "unknown_command" };
    if (!available.has(name)) return { ...base, reason: "missing_command" };
    return { ...base, supported: true };
  });
}
