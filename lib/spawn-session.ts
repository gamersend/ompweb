import { existsSync } from "fs";
import { randomUUID } from "crypto";
import { allowFileRoot } from "@/lib/file-access";
import { isToolPreset, getToolNamesForPreset, type ToolPreset } from "@/lib/tool-presets";
import { splitLaunchModelRef } from "@/lib/launch-profile";
import { isKnownThinkingLevel } from "@/lib/thinking-levels";
import { invalidateSessionListCache } from "@/lib/session-reader";
import { startRpcSession, type AgentSessionWrapper } from "@/lib/rpc-manager";

// ============================================================================
// Session-creation core (BUILD-PLAN Phase 11).
//
// Extracted verbatim from app/api/agent/new/route.ts so a scheduler fire can
// start a session as a plain function call — never self-HTTP (the plan's hard
// rule). The route delegates here with the SAME body it parsed, so its wire
// contract is byte-for-byte unchanged:
//   - cwd_required / directory_not_found / command_type_required 400s,
//   - request_too_large / invalid_json from the body parser (route side),
//   - WebRpcError / RpcCommandError forwarded with their codes,
//   - `{ success: true, sessionId, data }` on success.
//
// Deps are injectable ONLY for tests (spawnSessionDeps.startRpcSession); the
// route and the scheduler use the real rpc-manager. Behavior notes preserved:
//   - the one-time `__new__<uuid>` key so startRpcSession's coalescing lock
//     cannot merge concurrent creations,
//   - allowFileRoot + invalidateSessionListCache so the new cwd is immediately
//     browsable and the sidebar refreshes,
//   - set_model / set_thinking_level applied BEFORE the first prompt,
//   - ensure_session short-circuits without sending a prompt,
//   - a failed post-spawn step destroys the child (no orphaned omp process).
// ============================================================================

/** Failure raised for caller-input problems, carrying the stable wire code
 *  the /api/agent/new route has always returned. */
export class SpawnSessionInputError extends Error {
  readonly code: string;

  constructor(message: string, code: string) {
    super(message);
    this.name = "SpawnSessionInputError";
    this.code = code;
  }
}

export interface SpawnLaunchOptions {
  /** "provider:modelId" reference (launch-profile schema) — applied as the
   *  pre-prompt set_model when the command body does not already carry one. */
  model?: string;
  /** Thinking effort — applied as the pre-prompt set_thinking_level when the
   *  command body does not already carry one. */
  thinkingLevel?: string;
  /** Tool preset — mapped through getToolNamesForPreset ("full"/unset leaves
   *  omp's complete default toolset) when the command body has no toolNames. */
  toolsPreset?: ToolPreset;
}

export interface SpawnNewSessionInput {
  cwd: string;
  /** The route's command body minus `cwd` — `{ type: "prompt" | "ensure_session", ... }`.
   *  A stale/forged `sessionId` is stripped (never reaches the child RPC). */
  command: Record<string, unknown>;
  /** Phase 3 quick-launch: explicit profile defaults (model / thinkingLevel /
   *  toolsPreset). Folded into the command BEFORE the existing destructure so
   *  they reuse the exact set_model / set_thinking_level / toolNames semantics
   *  below; explicit per-command values always win over the profile. Invalid
   *  profile values (unparseable model, unknown preset) are silently dropped. */
  launch?: SpawnLaunchOptions;
}

export interface SpawnNewSessionResult {
  sessionId: string;
  data: unknown;
  /** The live wrapper — the scheduler uses it to watch the run to completion.
   *  The route ignores it. */
  session: AgentSessionWrapper;
}

export interface SpawnSessionDeps {
  /** Test seam; defaults to the real rpc-manager startRpcSession. */
  startRpcSession?: typeof startRpcSession;
}

// Module-level swap for the route contract test: the route calls
// spawnNewSession WITHOUT deps, so the test overrides the starter here for
// the duration and restores it afterwards.
let startOverride: typeof startRpcSession | null = null;

/** Swap the session starter for tests (null restores the real one). */
export function __setStartRpcSessionOverrideForTests(fn: typeof startRpcSession | null): void {
  startOverride = fn;
}

export async function spawnNewSession(
  input: SpawnNewSessionInput,
  deps: SpawnSessionDeps = {},
): Promise<SpawnNewSessionResult> {
  const start = deps.startRpcSession ?? startOverride ?? startRpcSession;
  const cwd = input.cwd;
  // Shallow copy: launch-option folding below must never mutate the caller's
  // command object (the route reuses its parsed body across error paths).
  const command: Record<string, unknown> = { ...input.command };

  if (!cwd || typeof cwd !== "string") {
    throw new SpawnSessionInputError("cwd is required", "cwd_required");
  }
  if (!existsSync(cwd)) {
    throw new SpawnSessionInputError(`Directory does not exist: ${cwd}`, "directory_not_found");
  }

  // Fold launch-profile defaults in only where the command is silent, so an
  // explicit caller value (ChatInput's pre-prompt picks, scheduler job fields)
  // always wins over the workspace profile.
  const launch = input.launch;
  if (launch) {
    if (command.provider === undefined && command.modelId === undefined && launch.model) {
      const modelRef = splitLaunchModelRef(launch.model);
      if (modelRef) {
        command.provider = modelRef.provider;
        command.modelId = modelRef.modelId;
      }
    }
    if (command.thinkingLevel === undefined && launch.thinkingLevel && isKnownThinkingLevel(launch.thinkingLevel)) {
      command.thinkingLevel = launch.thinkingLevel;
    }
    if (command.toolNames === undefined && launch.toolsPreset && isToolPreset(launch.toolsPreset)) {
      // undefined for "full" = leave omp's complete default toolset intact.
      command.toolNames = getToolNamesForPreset(launch.toolsPreset);
    }
  }

  const { provider, modelId, toolNames, thinkingLevel, advisor, ...promptCommand } = command as {
    provider?: string;
    modelId?: string;
    toolNames?: string[];
    thinkingLevel?: string;
    advisor?: boolean;
    [key: string]: unknown;
  };
  // A session id has no meaning for a fresh spawn and must never reach the
  // child RPC: a stale or forged id would address the wrong session.
  delete promptCommand.sessionId;
  if (typeof promptCommand.type !== "string" || !promptCommand.type.trim()) {
    throw new SpawnSessionInputError("command type is required", "command_type_required");
  }

  // Must be unique per request: startRpcSession coalesces concurrent callers
  // that share a key onto one session. Date.now() (ms resolution) collides for
  // requests in the same millisecond, merging two new sessions into one.
  const tempKey = `__new__${randomUUID()}`;
  const { session, realSessionId } = await start(tempKey, "", cwd, toolNames, advisor === true);

  // Keep the files-route allowed-roots cache (see app/api/files/[...path]/route.ts)
  // in sync so the new cwd is immediately readable via /api/files. Without this,
  // a file request under a brand-new cwd would 403 for up to the cache TTL.
  allowFileRoot(cwd);
  invalidateSessionListCache();

  try {
    // Apply pre-selected model before sending the prompt
    if (provider && modelId) {
      await session.send({ type: "set_model", provider, modelId });
    }

    // Apply pre-selected thinking level before sending the prompt
    if (thinkingLevel) {
      await session.send({ type: "set_thinking_level", level: thinkingLevel });
    }

    if (promptCommand.type === "ensure_session") {
      return { sessionId: realSessionId, data: null, session };
    }

    const result = await session.send(promptCommand);

    return { sessionId: realSessionId, data: result, session };
  } catch (error) {
    // The child was spawned but the prompt never ran: without this cleanup a
    // failed set_model/set_thinking_level/prompt leaves an orphaned omp
    // process and a registry entry nobody will ever use.
    await session.destroyAndWait();
    throw error;
  }
}
