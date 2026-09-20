import { getToolNamesForPreset, isToolPreset } from "./tool-presets";
import { isKnownThinkingLevel } from "./thinking-levels";
import type { ProjectLaunchConfig } from "./types";

// ============================================================================
// Launch-profile helpers (BUILD-PLAN-2 Phase 3, quick-launch toolbar).
//
// Pure + importable from client and server code: the schema guard in
// lib/project-registry.ts, the /api/projects write validator, spawn-session's
// launch options, and the UI (dialog / chips / palette) all share these.
//
// IMPORTANT: a profile's `prompt` is NOT a snippet. It is sent VERBATIM as the
// first message of the spawned session — NO $NAME / ${NAME} placeholder
// expansion, ever (the snippet grammar in lib/snippets/placeholders.ts does
// not apply here). An empty or absent prompt spawns the session without a
// first message (the pre-Phase-3 behavior).
// ============================================================================

/** Hard cap on a stored launch prompt: 4 KB (code points). Larger values are
 *  dropped by the schema guards, never truncated silently on disk. */
export const LAUNCH_PROMPT_MAX = 4096;

/** Split a stored "provider:modelId" reference for the spawn command.
 *  Mirrors lib/scheduler/store.ts splitModelRef (kept local so this pure
 *  module never imports the scheduler store's fs-backed module graph). */
export function splitLaunchModelRef(ref: string): { provider: string; modelId: string } | null {
  const index = ref.indexOf(":");
  if (index <= 0 || index === ref.length - 1) return null;
  const provider = ref.slice(0, index);
  const modelId = ref.slice(index + 1);
  return provider && modelId ? { provider, modelId } : null;
}

/** Sanitize the Phase 3 launch fields of a raw (untrusted / hand-edited)
 *  launch-config object. Invalid values are DROPPED, never fatal — the rest
 *  of the config survives. Returns only the fields that are present AND
 *  valid (no undefined-valued keys), so callers can spread the result. */
export function normalizeLaunchConfigFields(raw: Record<string, unknown>): Partial<ProjectLaunchConfig> {
  const out: Partial<ProjectLaunchConfig> = {};
  if (typeof raw.prompt === "string" && raw.prompt.length > 0 && raw.prompt.length <= LAUNCH_PROMPT_MAX) {
    out.prompt = raw.prompt;
  }
  if (typeof raw.model === "string" && splitLaunchModelRef(raw.model)) {
    out.model = raw.model;
  }
  if (isKnownThinkingLevel(raw.thinkingLevel)) {
    out.thinkingLevel = raw.thinkingLevel;
  }
  if (isToolPreset(raw.toolsPreset)) {
    out.toolsPreset = raw.toolsPreset;
  }
  return out;
}

/** True when the config carries at least one spawn shortcut (first prompt,
 *  model, thinking level, or tools preset) — the "one-tap fully-configured"
 *  marker the sidebar chips and palette entries highlight. */
export function hasLaunchSpawnConfig(config: ProjectLaunchConfig | undefined): boolean {
  if (!config) return false;
  return Boolean(config.prompt || config.model || config.thinkingLevel || config.toolsPreset);
}

/** The /api/agent/new body fields a launch profile maps onto. `toolNames` is
 *  omitted for "full"/unset (undefined = leave omp's complete default toolset
 *  intact) but PRESENT as [] for "none" (spawn with no tools at all). */
export interface LaunchCommandFields {
  type: "prompt" | "ensure_session";
  message?: string;
  provider?: string;
  modelId?: string;
  thinkingLevel?: string;
  toolNames?: string[];
}

/** Map a launch profile onto spawn command fields. The prompt rides the
 *  normal `prompt` command verbatim; absent prompt → `ensure_session` (spawn
 *  without a first message). Invalid profile values are ignored here too, so
 *  a stale config can never produce a broken spawn body. */
export function launchCommandFields(config: ProjectLaunchConfig | undefined): LaunchCommandFields {
  const message = typeof config?.prompt === "string" && config.prompt.trim() ? config.prompt : undefined;
  const modelRef = config?.model ? splitLaunchModelRef(config.model) : null;
  const thinkingLevel = isKnownThinkingLevel(config?.thinkingLevel) ? config.thinkingLevel : undefined;
  const toolNames = config?.toolsPreset && isToolPreset(config.toolsPreset)
    ? getToolNamesForPreset(config.toolsPreset)
    : undefined;
  return {
    type: message ? "prompt" : "ensure_session",
    ...(message ? { message } : {}),
    ...(modelRef ? { provider: modelRef.provider, modelId: modelRef.modelId } : {}),
    ...(thinkingLevel ? { thinkingLevel } : {}),
    ...(toolNames !== undefined ? { toolNames } : {}),
  };
}
