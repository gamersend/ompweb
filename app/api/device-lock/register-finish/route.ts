import { NextResponse } from "next/server";
import { parseJsonWithinLimit, RequestBodyTooLargeError } from "@/lib/bounded-form-data";
import { finishRegistration, getDeviceUnlockKey, isDeviceLockEnabled, type DeviceLockErrorCode } from "@/lib/device-lock";
import { deviceLockErrorResponse, rpContextForRequest, setUnlockCookie } from "@/lib/device-lock-route";
import type { RegistrationResponseJSON } from "@simplewebauthn/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_REGISTER_BODY_BYTES = 64 * 1024;

// POST /api/device-lock/register-finish — verify the client's registration
// response, persist the credential (bootstrap-first writes the store), and
// mint the unlock cookie so the registering device is unlocked immediately.
export async function POST(request: Request) {
  if (!isDeviceLockEnabled()) return deviceLockErrorResponse("device_lock_disabled");
  let body: { label?: unknown; response?: unknown };
  try {
    body = await parseJsonWithinLimit(request, MAX_REGISTER_BODY_BYTES);
  } catch (error) {
    const status = error instanceof RequestBodyTooLargeError ? 413 : 400;
    return NextResponse.json({ error: "Invalid registration body", code: "invalid_body" }, { status });
  }
  if (typeof body.response !== "object" || body.response === null) {
    return NextResponse.json({ error: "Missing registration response", code: "invalid_body" }, { status: 400 });
  }
  const result = await finishRegistration({
    response: body.response as RegistrationResponseJSON,
    label: typeof body.label === "string" ? body.label : "",
    requestOrigin: rpContextForRequest(request),
  });
  if (!result.ok) return deviceLockErrorResponse(result.code as DeviceLockErrorCode, result.message);
  const unlockKey = getDeviceUnlockKey();
  const response = NextResponse.json({
    success: true,
    data: { id: result.data.credential.id, label: result.data.credential.label, remaining: result.data.remaining },
  });
  return unlockKey ? setUnlockCookie(response, request, unlockKey) : response;
}
