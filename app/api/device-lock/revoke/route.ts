import { NextResponse } from "next/server";
import { parseJsonWithinLimit, RequestBodyTooLargeError } from "@/lib/bounded-form-data";
import { isDeviceLockEnabled, revokeCredential, type DeviceLockErrorCode } from "@/lib/device-lock";
import { deviceLockErrorResponse, isUnlockedRequest } from "@/lib/device-lock-route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_REVOKE_BODY_BYTES = 4 * 1024;

// POST /api/device-lock/revoke {id} — remove a credential. Requires a verified
// unlock cookie. Revoking the LAST credential is allowed but the response
// warns that recovery from the fully-locked-out state is deleting
// web-authz.json on disk (documented in the settings copy too).
export async function POST(request: Request) {
  if (!isDeviceLockEnabled()) return deviceLockErrorResponse("device_lock_disabled");
  if (!isUnlockedRequest(request)) {
    return NextResponse.json({ error: "Device lock verification required", code: "device_lock_verified_required" }, { status: 403 });
  }
  let body: { id?: unknown };
  try {
    body = await parseJsonWithinLimit(request, MAX_REVOKE_BODY_BYTES);
  } catch (error) {
    const status = error instanceof RequestBodyTooLargeError ? 413 : 400;
    return NextResponse.json({ error: "Invalid revoke body", code: "invalid_body" }, { status });
  }
  if (typeof body.id !== "string" || body.id.length === 0) {
    return NextResponse.json({ error: "Credential id is required", code: "invalid_body" }, { status: 400 });
  }
  const result = revokeCredential(body.id);
  if (!result.ok) return deviceLockErrorResponse(result.code as DeviceLockErrorCode, result.message);
  return NextResponse.json({
    success: true,
    data: {
      remaining: result.data.remaining,
      // Warn the caller when the gate is about to disarm into bootstrap mode:
      // the ONLY way back in is deleting web-authz.json from disk.
      lastCredentialRevoked: result.data.remaining === 0,
      recovery: result.data.remaining === 0 ? "delete-web-authz-json" : undefined,
    },
  });
}
