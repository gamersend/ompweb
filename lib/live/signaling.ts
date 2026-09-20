/**
 * The signaling exchange, server-side.
 *
 * One OAuth-authenticated POST to the Codex live endpoint turns the browser's
 * SDP offer into an answer; everything after that is browser↔OpenAI direct.
 * This module is the whole server role in the media path: get the token from
 * the user's own omp CLI, shape the pinned request, relay the answer back,
 * and forget the token. No retry loops (a failed handshake is exactly when
 * the private route may have drifted — the drift-check rule applies), no
 * sideband relay, no transcript visibility.
 */

import { randomUUID } from "crypto";

import {
  LIVE_SIGNAL_TIMEOUT_MS,
  LIVE_SIGNAL_URL,
  buildLiveSignalBody,
  buildLiveSignalHeaders,
  callIdFromLocation,
  extractAnswerSdp,
  looksLikeSdp,
  mapLiveSignalFailure,
} from "./protocol";
import { LiveTokenError, getCodexLiveToken } from "./token";

export { LiveTokenError };

export class LiveSignalingError extends Error {
  constructor(
    readonly code: "live_bad_request" | "live_unauthorized" | "live_signaling",
    message: string,
  ) {
    super(message);
    this.name = "LiveSignalingError";
  }
}

export interface LiveCallAnswer {
  answerSdp: string;
  callId: string;
}

/**
 * Injectable fetch for tests — production uses the global. (The server's
 * HTTP(S)_PROXY wiring applies naturally: Node's fetch honors the env proxy
 * dispatcher installed at boot in instrumentation.ts.)
 */
let httpFetch: typeof fetch = (...args) => fetch(...args);

/** Test seam — swaps the transport. */
export function _setLiveSignalHttp(fake: typeof fetch | null): void {
  httpFetch = fake ?? ((...args) => fetch(...args));
}

/**
 * Run the exchange. Throws LiveSignalingError / LiveTokenError with machine
 * codes; the route maps them onto the error envelope. The token exists only
 * inside this call frame.
 */
export async function startLiveCall(opts: {
  sdp: string;
  voice?: string | null;
  instructions?: string | null;
}): Promise<LiveCallAnswer> {
  if (!looksLikeSdp(opts.sdp)) {
    throw new LiveSignalingError("live_bad_request", "send the browser's SDP offer as `sdp`");
  }
  const { token, accountID } = await getCodexLiveToken();

  // A fresh id per call, threaded through all three session headers exactly
  // as the accepted implementation does.
  const sid = randomUUID();
  const headers = buildLiveSignalHeaders({ token, accountID, sid });
  const body = buildLiveSignalBody({ sdp: opts.sdp, voice: opts.voice, instructions: opts.instructions });

  let res: Response;
  try {
    res = await httpFetch(LIVE_SIGNAL_URL, {
      method: "POST",
      headers,
      body,
      signal: AbortSignal.timeout(LIVE_SIGNAL_TIMEOUT_MS),
    });
  } catch (err) {
    throw new LiveSignalingError(
      "live_signaling",
      `codex signaling unreachable: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (res.status >= 300) {
    let text = "";
    try {
      text = await res.text();
    } catch {
      // empty body on failure is fine, the status carries the meaning
    }
    const failure = mapLiveSignalFailure(res.status, text);
    throw new LiveSignalingError(failure.code, failure.detail);
  }

  const raw = await res.text();
  const answerSdp = extractAnswerSdp(raw);
  if (!answerSdp) {
    throw new LiveSignalingError("live_signaling", "codex signaling returned no SDP answer");
  }
  const callId = callIdFromLocation(res.headers.get("location"));
  return { answerSdp, callId };
}
