import { NextResponse } from "next/server";
import { parseJsonWithinLimit, RequestBodyTooLargeError } from "@/lib/bounded-form-data";
import { finishVerification, getDeviceUnlockKey, isDeviceLockEnabled, type DeviceLockErrorCode } from "@/lib/device-lock";
import { deviceLockErrorResponse, rpContextForRequest, setUnlockCookie } from "@/lib/device-lock-route";
import type { AuthenticationResponseJSON } from "@simplewebauthn/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_VERIFY_BODY_BYTES = 32 * 1024;

// POST /api/device-lock/verify-finish — verify the client's assertion and mint
// the short-lived unlock cookie on success (the ONLY unlock path in
// device-lock mode; recovery from zero credentials is file deletion).
export async function POST(request: Request) {
  if (!isDeviceLockEnabled()) return deviceLockErrorResponse("device_lock_disabled");
  let body: { response?: unknown };
  try {
    body = await parseJsonWithinLimit(request, MAX_VERIFY_BODY_BYTES);
  } catch (error) {
    const status = error instanceof RequestBodyTooLargeError ? 413 : 400;
    return NextResponse.json({ error: "Invalid verification body", code: "invalid_body" }, { status });
  }
  if (typeof body.response !== "object" || body.response === null) {
    return NextResponse.json({ error: "Missing assertion response", code: "invalid_body" }, { status: 400 });
  }
  const result = await finishVerification({
    response: body.response as AuthenticationResponseJSON,
    requestOrigin: rpContextForRequest(request),
  });
  if (!result.ok) return deviceLockErrorResponse(result.code as DeviceLockErrorCode, result.message);
  const unlockKey = getDeviceUnlockKey();
  const response = NextResponse.json({ success: true, data: { ok: true } });
  return unlockKey ? setUnlockCookie(response, request, unlockKey) : response;
}
