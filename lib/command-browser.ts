// ============================================================================
// Metadata-driven command browser (P16 / R3-19) — pure index builder.
//
// Turns omp's `get_available_commands` payload (RpcAvailableSlashCommand
// entries, mirrored in lib/pi-types.ts) into a defensively-validated
// CommandInfo index for the CommandBrowserDialog. THE BROWSER EXECUTES
// NOTHING: there is no endpoint and no UI path in this phase that dispatches
// a command the user picked, so `mutating` is INFORMATIONAL LABELING (a
// curated prefix list, not a security boundary) — it tells the reader which
// commands change session/model state if they are run from the composer.
//
// Pure module — no child process, no fs, no React. The route
// (app/api/command-browser/route.ts) owns the transport and the degrade.
// ============================================================================

/** Where the transport stands when the index was built. */
export type CommandTransport = "connected" | "disconnected";

export type CommandDomain =
  | "agent"
  | "session"
  | "model"
  | "tools"
  | "mcp"
  | "memory"
  | "other";

/** One defensively-validated slash command for display. */
export interface CommandInfo {
  name: string;
  /** Known RpcAvailableSlashCommandSource value, else "unknown". */
  source: string;
  description?: string;
  aliases: string[];
  /** omp advertises an input contract (hint) for this command. */
  hasInput: boolean;
  /** Informational: name matches KNOWN_MUTATING_COMMANDS (see header). */
  mutating: boolean;
  domain: CommandDomain;
}

export interface CommandBrowserIndex {
  supported: boolean;
  /** Why not, when unsupported. */
  reason?: "transport_disconnected" | "no_commands";
  commands: CommandInfo[];
}

/**
 * Curated mutating-command prefixes (informational only — see module header).
 * A command whose name STARTS WITH one of these is labeled mutating; anything
 * else defaults to non-mutating. New families land here by hand when they do.
 */
export const KNOWN_MUTATING_COMMANDS: readonly string[] = [
  "compact",
  "model",
  "abort",
  "steer",
  "follow_up",
  "prompt",
  "bash",
  "retry",
  "handoff",
  "fresh",
  "stop",
  "restart",
];

/** The RpcAvailableSlashCommandSource set omp announces today (lib/pi-types.ts). */
const KNOWN_SOURCES = new Set(["builtin", "skill", "extension", "custom", "mcp_prompt", "file"]);

/**
 * Curated domain prefix map. First matching prefix wins; anything unclaimed
 * defaults to "agent" (the browser dialog's general bucket). "other" stays in
 * the union for future curated splits, the map never emits it today.
 */
const DOMAIN_PREFIXES: ReadonlyArray<readonly [prefix: string, domain: CommandDomain]> = [
  ["model", "model"],
  ["mcp", "mcp"],
  ["memory", "memory"],
  ["tools", "tools"],
  ["tool", "tools"],
  ["compact", "session"],
  ["context", "session"],
  ["session", "session"],
];

const NAME_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const DESCRIPTION_MAX_CHARS = 200;
const ALIASES_MAX = 12;

function domainFor(name: string): CommandDomain {
  for (const [prefix, domain] of DOMAIN_PREFIXES) {
    if (name.startsWith(prefix)) return domain;
  }
  return "agent";
}

function isMutating(name: string): boolean {
  return KNOWN_MUTATING_COMMANDS.some((prefix) => name.startsWith(prefix));
}

/** Plain `<`/`>` codepoint comparison — deterministic across ICU builds. */
function compare(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

/**
 * Build the display index from raw command entries. Malformed entries are
 * dropped (never guessed into something usable); duplicate names keep the
 * first. A disconnected transport degrades wholesale before any parsing;
 * a connected transport that announced nothing degrades to "no_commands".
 */
export function buildCommandIndex(commands: unknown[], transport: CommandTransport): CommandBrowserIndex {
  if (transport !== "connected") {
    return { supported: false, reason: "transport_disconnected", commands: [] };
  }
  const seen = new Set<string>();
  const out: CommandInfo[] = [];
  for (const item of commands) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const entry = item as Record<string, unknown>;
    if (typeof entry.name !== "string" || !NAME_PATTERN.test(entry.name)) continue;
    if (seen.has(entry.name)) continue;
    seen.add(entry.name);

    const rawSource = entry.source;
    const source = typeof rawSource === "string" && KNOWN_SOURCES.has(rawSource) ? rawSource : "unknown";
    const rawDescription = entry.description;
    const description = typeof rawDescription === "string" && rawDescription.trim().length > 0
      ? rawDescription.slice(0, DESCRIPTION_MAX_CHARS)
      : undefined;
    const rawAliases = Array.isArray(entry.aliases) ? entry.aliases : [];
    const aliases: string[] = [];
    for (const alias of rawAliases) {
      if (typeof alias !== "string" || !NAME_PATTERN.test(alias) || alias === entry.name || aliases.includes(alias)) continue;
      aliases.push(alias);
      if (aliases.length >= ALIASES_MAX) break;
    }

    out.push({
      name: entry.name,
      source,
      ...(description !== undefined ? { description } : {}),
      aliases,
      hasInput: Boolean(entry.input) && typeof entry.input === "object",
      mutating: isMutating(entry.name),
      domain: domainFor(entry.name),
    });
  }
  if (out.length === 0) {
    return { supported: false, reason: "no_commands", commands: [] };
  }
  out.sort((a, b) => compare(a.source, b.source) || compare(a.name, b.name));
  return { supported: true, commands: out };
}
