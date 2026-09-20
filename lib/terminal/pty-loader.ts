import { createRequire } from "module";

// ============================================================================
// Lazy `node-pty` loader (P11 terminal round 2) — the webpush-loader pattern:
// node-pty is a NATIVE optional dependency that must never be statically
// imported into the Next.js server bundle. createRequire resolves it at
// runtime from the real node_modules; a missing or half-built install simply
// throws here and the terminal manager falls back to plain pipes.
//
// The probe result is remembered for the process lifetime (BUILD-PLAN P11:
// "probe at spawn … remember the probe result for the process lifetime") so a
// machine without a working ConPTY build logs its fallback reason once and
// never retries the require on every spawn.
// ============================================================================

/** The slice of the node-pty API the terminal manager uses. node-pty ships no
 * separate type package the bundler can rely on, so this is a local
 * structural mirror (same approach as lib/pi-types.ts). */
export interface PtyProcess {
  pid: number;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
  onData(listener: (data: string) => void): { dispose(): void };
  onExit(listener: (event: { exitCode: number; signal?: number | undefined }) => void): { dispose(): void };
}

export interface PtyModule {
  spawn(
    file: string,
    args: string[],
    options: { name?: string; cols?: number; rows?: number; cwd?: string; env?: Record<string, string> },
  ): PtyProcess;
}

export type PtyProbeResult =
  | { ok: true; module: PtyModule }
  | { ok: false; reason: string };

let probe: PtyProbeResult | null = null;

/** Require "node-pty" once; cache the outcome (success OR the failure reason)
 * for the process lifetime. */
export function probePtyModule(): PtyProbeResult {
  if (probe) return probe;
  try {
    const require = createRequire(import.meta.url);
    probe = { ok: true, module: require("node-pty") as PtyModule };
  } catch (error) {
    probe = {
      ok: false,
      reason: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
    };
  }
  return probe;
}

/** Test hook: inject a probe outcome (null restores the real probe and
 * clears the cache, so a later call re-runs the require). */
export function setPtyProbeForTests(result: PtyProbeResult | null): void {
  probe = result;
}
