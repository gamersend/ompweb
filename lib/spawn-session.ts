import { existsSync } from "fs";
import { randomUUID } from "crypto";
import { allowFileRoot } from "@/lib/file-access";
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

export interface SpawnNewSessionInput {
  cwd: string;
  /** The route's command body minus `cwd` — `{ type: "prompt" | "ensure_session", ... }`.
   *  A stale/forged `sessionId` is stripped (never reaches the child RPC). */
  command: Record<string, unknown>;
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
  const command = input.command;

  if (!cwd || typeof cwd !== "string") {
    throw new SpawnSessionInputError("cwd is required", "cwd_required");
  }
  if (!existsSync(cwd)) {
    throw new SpawnSessionInputError(`Directory does not exist: ${cwd}`, "directory_not_found");
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
