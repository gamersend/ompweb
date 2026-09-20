import { NextResponse } from "next/server";
import { parseJsonWithinLimit, RequestBodyTooLargeError } from "@/lib/bounded-form-data";
import {
  CLIENT_STATE_MAX_VALUE_BYTES,
  ClientStateConflictError,
  ClientStateValidationError,
  deleteClientStateItem,
  loadClientState,
  putClientStateValue,
  withClientState,
} from "@/lib/client-state-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Per-key values cap at 256 KB; the wire body is bounded at 4× that plus
// 64 KB for JSON escaping headroom (mirrors the file-editor route's math).
const MAX_PUT_REQUEST_BYTES = 4 * CLIENT_STATE_MAX_VALUE_BYTES + 64 * 1024;
// Delete markers carry only {key, itemId, deviceId} — tiny bodies.
const MAX_DELETE_REQUEST_BYTES = 16 * 1024;
const NO_STORE = { "Cache-Control": "no-store" } as const;

// GET /api/client-state?since=<rev> → { success, data: { rev, keys, tombstones } }
// Returns every key AND delete marker whose rev is greater than `since`
// (`since` omitted → the whole store). Polled by the sync clients every
// 15 s while visible, so the response is explicitly uncacheable.
export async function GET(request: Request) {
  const sinceParam = new URL(request.url).searchParams.get("since");
  let since: number | undefined;
  if (sinceParam !== null) {
    since = Number(sinceParam);
    if (!Number.isInteger(since) || since < 0) {
      return NextResponse.json({ error: "since must be a non-negative integer", code: "invalid_since" }, { status: 400 });
    }
  }
  const store = loadClientState();
  const keys: Record<string, { rev: number; value: unknown }> = {};
  for (const [key, entry] of Object.entries(store.keys)) {
    if (since !== undefined && entry.rev <= since) continue;
    keys[key] = entry;
  }
  const tombstones: Record<string, { rev: number; itemId: string; deletedAt: number; deviceId?: string }> = {};
  for (const [id, tombstone] of Object.entries(store.tombstones)) {
    if (since !== undefined && tombstone.rev <= since) continue;
    tombstones[id] = tombstone;
  }
  return NextResponse.json({ success: true, data: { rev: store.rev, keys, tombstones } }, { headers: NO_STORE });
}

// PUT /api/client-state  body: { key, value, baseRev? } → { success, data: { rev } }
// baseRev mismatch with the stored key rev → 409
// { success: false, error: { code: "conflict", currentRev } } — the client
// re-fetches, re-merges, and retries once. Sync failures are silent
// client-side; stable codes exist for observability and i18n mapping.
export async function PUT(request: Request) {
  let body: Record<string, unknown>;
  try {
    body = await parseJsonWithinLimit<Record<string, unknown>>(request, MAX_PUT_REQUEST_BYTES);
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) {
      return NextResponse.json({ error: "Client-state request is too large", code: "invalid_body" }, { status: 413 });
    }
    return NextResponse.json({ error: "Request body must be valid JSON", code: "invalid_body" }, { status: 400 });
  }
  try {
    const rev = withClientState((store) => {
      const next = putClientStateValue(store, body.key, body.value, body.baseRev);
      return { store: next.store, result: next.rev };
    });
    return NextResponse.json({ success: true, data: { rev } }, { headers: NO_STORE });
  } catch (error) {
    if (error instanceof ClientStateConflictError) {
      return NextResponse.json(
        { success: false, error: { code: "conflict", currentRev: error.currentRev } },
        { status: 409, headers: NO_STORE },
      );
    }
    if (error instanceof ClientStateValidationError) {
      const status = error.code === "value_too_large" ? 413 : 400;
      return NextResponse.json({ error: error.message, code: error.code }, { status, headers: NO_STORE });
    }
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}

// DELETE /api/client-state  body: { key, itemId, deviceId? }
//   → { success, data: { rev, tombstone, idempotent } }
// Records a bounded delete marker so the deletion converges across devices
// (wave 3 P2). Idempotent: a repeat delete for the same (key, itemId) keeps
// the FIRST marker and does not advance the store rev. The stored VALUE is
// intentionally untouched — clients filter tombstoned items at merge time.
export async function DELETE(request: Request) {
  let body: Record<string, unknown>;
  try {
    body = await parseJsonWithinLimit<Record<string, unknown>>(request, MAX_DELETE_REQUEST_BYTES);
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) {
      return NextResponse.json({ error: "Client-state request is too large", code: "invalid_body" }, { status: 413 });
    }
    return NextResponse.json({ error: "Request body must be valid JSON", code: "invalid_body" }, { status: 400 });
  }
  try {
    const result = withClientState((store) => {
      const next = deleteClientStateItem(store, body.key, body.itemId, body.deviceId);
      return { store: next.store, result: next };
    });
    return NextResponse.json(
      { success: true, data: { rev: result.tombstone.rev, tombstone: result.tombstone, idempotent: result.idempotent } },
      { headers: NO_STORE },
    );
  } catch (error) {
    if (error instanceof ClientStateValidationError) {
      return NextResponse.json({ error: error.message, code: error.code }, { status: 400, headers: NO_STORE });
    }
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
