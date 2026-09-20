import { NextResponse } from "next/server";
import { RequestBodyTooLargeError, parseJsonWithinLimit } from "@/lib/bounded-form-data";
import { isEnabled } from "@/lib/feature-flags";
import {
  claimHerdrPane,
  isHerdrAttachEnabled,
  isHerdrPaneOwner,
  listHerdrPanes,
  readHerdrPane,
  releaseHerdrPane,
  resizeHerdrPane,
  sendHerdrKeys,
  sendHerdrText,
} from "@/lib/terminal/herdr-attach";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const HERDR_BODY_MAX_BYTES = 64 * 1024;

// GET /api/terminal/herdr                    → { enabled, panes }
// GET /api/terminal/herdr?paneId=<id>        → { enabled, content }
//
// `enabled` is false whenever OMP_WEB_HERDR_BIN is unset — the client hides
// the picker entirely in that case (BUILD-PLAN: env-gated optionals are fully
// functional and dependency-free when the env var is absent).
export async function GET(req: Request) {
  const enabled = isHerdrAttachEnabled();
  if (!enabled) return NextResponse.json({ success: true, data: { enabled: false, panes: [] } });
  const paneId = new URL(req.url).searchParams.get("paneId");
  if (!paneId) {
    const { panes, error } = await listHerdrPanes();
    return NextResponse.json({ success: true, data: { enabled: true, panes, ...(error ? { error } : {}) } });
  }
  const read = await readHerdrPane(paneId);
  if (!read.ok) {
    return NextResponse.json({ error: read.error ?? "pane read failed", code: "herdr_read_failed" }, { status: 502 });
  }
  return NextResponse.json({ success: true, data: { enabled: true, content: read.content } });
}

// POST /api/terminal/herdr
//   { action: "claim",   paneId }
//   { action: "release", paneId }
//   { action: "send-text", paneId, text }    (owner-attached panes only)
//   { action: "send-keys", paneId, keys }    (owner-attached panes only)
//   { action: "resize",    paneId, cols, rows } (owner-attached panes only)
//
// Non-owner panes are read-only watch targets: writes return 403
// `herdr_not_owner` and the client renders them with the watch banner.
export async function POST(req: Request) {
  let body: { action?: unknown; paneId?: unknown; text?: unknown; keys?: unknown; cols?: unknown; rows?: unknown };
  try {
    body = await parseJsonWithinLimit(req, HERDR_BODY_MAX_BYTES);
  } catch (error) {
    const tooLarge = error instanceof RequestBodyTooLargeError;
    return NextResponse.json(
      { error: tooLarge ? "request too large" : "invalid request body", code: tooLarge ? "request_too_large" : "invalid_body" },
      { status: tooLarge ? 413 : 400 },
    );
  }
  const action = typeof body.action === "string" ? body.action : "";
  const paneId = typeof body.paneId === "string" ? body.paneId : "";

  if (!isHerdrAttachEnabled()) {
    return NextResponse.json({ error: "herdr attach is disabled (OMP_WEB_HERDR_BIN not set)", code: "herdr_disabled" }, { status: 403 });
  }
  if (action === "claim") {
    const result = await claimHerdrPane(paneId);
    return result.ok
      ? NextResponse.json({ success: true })
      : NextResponse.json({ error: result.error ?? "claim failed", code: result.error === "pane is owned by another session" ? "herdr_owned" : "herdr_claim_failed" }, { status: 409 });
  }
  if (action === "release") {
    releaseHerdrPane(paneId);
    return NextResponse.json({ success: true });
  }

  // Everything below mutates a pane: owner-only.
  if (!paneId) {
    return NextResponse.json({ error: "paneId is required", code: "pane_id_required" }, { status: 400 });
  }
  if (!isHerdrPaneOwner(paneId)) {
    return NextResponse.json({ error: "this pane is being watched read-only", code: "herdr_not_owner" }, { status: 403 });
  }
  if (action === "send-text") {
    const text = typeof body.text === "string" ? body.text : "";
    if (!text) return NextResponse.json({ error: "text is required", code: "text_required" }, { status: 400 });
    const result = await sendHerdrText(paneId, text);
    return result.ok ? NextResponse.json({ success: true }) : NextResponse.json({ error: result.error ?? "send failed", code: "herdr_send_failed" }, { status: 502 });
  }
  if (action === "send-keys") {
    const keys = typeof body.keys === "string" ? body.keys : "";
    if (!keys) return NextResponse.json({ error: "keys is required", code: "keys_required" }, { status: 400 });
    const result = await sendHerdrKeys(paneId, keys);
    return result.ok ? NextResponse.json({ success: true }) : NextResponse.json({ error: result.error ?? "send failed", code: "herdr_send_failed" }, { status: 502 });
  }
  if (action === "resize") {
    const cols = typeof body.cols === "number" ? body.cols : NaN;
    const rows = typeof body.rows === "number" ? body.rows : NaN;
    const result = await resizeHerdrPane(paneId, cols, rows);
    return result.ok ? NextResponse.json({ success: true }) : NextResponse.json({ error: result.error ?? "resize failed", code: "herdr_resize_failed" }, { status: result.error === "invalid size" ? 400 : 502 });
  }
  return NextResponse.json({ error: `unknown action: ${action || "(none)"}`, code: "unknown_action" }, { status: 400 });
}

// Entry-point guard parity: expose the flag so settings can show the state
// without probing env from the client.
export async function OPTIONS() {
  return NextResponse.json({ success: true, data: { enabled: isHerdrAttachEnabled(), flagEnabled: isEnabled("herdrAttach") } });
}
