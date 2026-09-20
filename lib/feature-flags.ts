// ============================================================================
// Feature flags (§ BUILD-PLAN Cross-cutting patterns).
//
// Big-surface features ship dark and flip on per install. Rules:
// - Flags ENABLE only: a feature is always complete when enabled, never
//   half-gated internally. `isEnabled` guards the entry points (settings rows,
//   palette commands, header buttons) with one line each.
// - Sources: env `OMP_WEB_FLAGS="a,b,c"` ∪ localStorage `omp-web:flags`
//   (comma-separated names; presence enables). Storage wins by union — a flag
//   listed in either place is on, and nothing can turn a default-on flag off.
// - Default state comes from env detection: `herdrAttach` is on only when
//   `OMP_WEB_HERDR_BIN` is set; `nativeStats` flips on when a server-side
//   probe (registered by the stats reader, Phase 7) reports stats.db exists.
//   Client-side, without a probe, it stays off.
//
// Isomorphic by design: no `fs` import here (client bundles would break).
// Server code registers the nativeStats probe via setNativeStatsProbe().
// ============================================================================

export type FlagName = "terminal" | "split" | "scheduler" | "herdrAttach" | "nativeStats";

export interface FlagSet {
  terminal: boolean;
  split: boolean;
  scheduler: boolean;
  herdrAttach: boolean;
  nativeStats: boolean;
}

export const FLAG_NAMES: readonly FlagName[] = ["terminal", "split", "scheduler", "herdrAttach", "nativeStats"];

export const FLAGS_ENV_VAR = "OMP_WEB_FLAGS";
export const FLAGS_STORAGE_KEY = "omp-web:flags";
export const HERDR_BIN_ENV_VAR = "OMP_WEB_HERDR_BIN";
/** Kill switch for the Terminal tab (Phase 13). "1" disables terminal spawn
 * server-side AND hides the entry point; any other value leaves it on. */
export const TERMINAL_DISABLE_ENV_VAR = "OMP_WEB_DISABLE_TERMINAL";

/** A settable probe so server code (Phase 7's stats reader) can report env
 * detection without dragging `fs` into this module. Returns true when the
 * omp-native stats.db exists. */
let nativeStatsProbe: (() => boolean) | null = null;

export function setNativeStatsProbe(probe: (() => boolean) | null): void {
  nativeStatsProbe = probe;
}

/** Parse a comma/space-separated flag list (env or storage form). Unknown
 * names are ignored so old clients and renamed flags never poison the rest.
 * Matching is case-insensitive against the canonical camelCase names — a
 * lowercased token like "herdrattach" must still enable `herdrAttach`. */
export function parseFlagList(raw: string | null | undefined): FlagName[] {
  if (typeof raw !== "string") return [];
  const out: FlagName[] = [];
  for (const token of raw.split(/[\s,]+/)) {
    const name = token.trim().toLowerCase();
    if (!name) continue;
    const match = FLAG_NAMES.find((candidate) => candidate.toLowerCase() === name);
    if (match && !out.includes(match)) out.push(match);
  }
  return out;
}

/** Env-derived default for one flag. Everything ships off except `split`
 * (Phase 12: split view is complete desktop-only work, falls back to a
 * single view on mobile by itself), `scheduler` (Phase 11: scheduled prompts,
 * entry point is a Settings tab and the engine is one idle timer),
 * `terminal` (Phase 13: default ON — the plain-pipe terminal is complete and
 * allow-root confined; the OMP_WEB_DISABLE_TERMINAL=1 kill switch is the one
 * way off, matching the server-side check in terminal-manager),
 * `herdrAttach` (only with the binary configured) and `nativeStats` (only
 * when the probe — server-side — confirms stats.db). */
export function defaultFlagValue(name: FlagName, env: Record<string, string | undefined> = typeof process === "undefined" ? {} : process.env): boolean {
  if (name === "split") return true;
  if (name === "scheduler") return true;
  if (name === "terminal") return env[TERMINAL_DISABLE_ENV_VAR] !== "1";
  if (name === "herdrAttach") return Boolean(env[HERDR_BIN_ENV_VAR]);
  if (name === "nativeStats") {
    if (!nativeStatsProbe) return false;
    try {
      return nativeStatsProbe() === true;
    } catch {
      return false;
    }
  }
  return false;
}

/** The full read: defaults ∪ env list ∪ storage list. Union semantics —
 * listing a flag anywhere enables it; nothing disables. */
export function readFlags(env: Record<string, string | undefined> = typeof process === "undefined" ? {} : process.env): FlagSet {
  const sources: FlagName[][] = [
    parseFlagList(env[FLAGS_ENV_VAR]),
  ];
  if (typeof window !== "undefined" && typeof window.localStorage !== "undefined") {
    try {
      sources.push(parseFlagList(window.localStorage.getItem(FLAGS_STORAGE_KEY)));
    } catch {
      // storage unavailable (private mode etc.)
    }
  }
  const enabled = new Set<FlagName>();
  for (const name of FLAG_NAMES) {
    if (defaultFlagValue(name, env)) enabled.add(name);
  }
  for (const source of sources) {
    for (const name of source) enabled.add(name);
  }
  const flags = {} as FlagSet;
  for (const name of FLAG_NAMES) flags[name] = enabled.has(name);
  return flags;
}

/** Entry-point guard (one line per surface): true when the named flag is on. */
export function isEnabled(name: FlagName, flags: FlagSet = readFlags()): boolean {
  return flags[name] === true;
}
