import { NextResponse } from "next/server";
import { deriveRpContext, isRequestUnlocked, type DeviceLockErrorCode } from "./device-lock";
import { createDeviceUnlockCookie, OMP_WEB_UNLOCK_COOKIE, OMP_WEB_UNLOCK_MAX_AGE_SECONDS } from "./web-auth";

// ============================================================================
// Shared helpers for the /api/device-lock/* routes (nodejs runtime, envelope
// convention: success = {success:true, data}, errors = {error, code}).
// ============================================================================

/** HTTP status per stable error code (lib/i18n/api-error.ts maps these to errors.<code>). */
export const DEVICE_LOCK_ERROR_STATUS: Record<DeviceLockErrorCode, number> = {
  device_lock_disabled: 404,
  device_lock_bootstrap_loopback_required: 403,
  device_lock_verified_required: 403,
  device_lock_no_credentials: 404,
  device_lock_challenge: 400,
  device_lock_verify_failed: 401,
  device_lock_credential_limit: 409,
  device_lock_not_found: 404,
};

export function deviceLockErrorResponse(code: DeviceLockErrorCode, message?: string): NextResponse {
  return NextResponse.json({ error: message ?? code, code }, { status: DEVICE_LOCK_ERROR_STATUS[code] });
}

/** rpID/origin derived from the REQUEST host (see deriveRpContext for the tradeoffs). */
export function rpContextForRequest(request: Request): { rpID: string; origin: string } {
  return deriveRpContext(request.headers.get("host"), request.headers.get("x-forwarded-proto"), new URL(request.url).protocol);
}

/** Mint the unlock cookie on a JSON response after a successful verify/registration. */
export function setUnlockCookie(response: NextResponse, request: Request, unlockKey: string): NextResponse {
  const secure = new URL(request.url).protocol === "https:" || request.headers.get("x-forwarded-proto") === "https";
  response.cookies.set({
    name: OMP_WEB_UNLOCK_COOKIE,
    value: createDeviceUnlockCookie(unlockKey),
    httpOnly: true,
    secure,
    sameSite: "lax",
    maxAge: OMP_WEB_UNLOCK_MAX_AGE_SECONDS,
    path: "/",
  });
  return response;
}

export function isUnlockedRequest(request: Request): boolean {
  // NextRequest cookies are also exposed as headers in route handlers; read
  // the Cookie header directly so plain Request parsing works in tests.
  const header = request.headers.get("cookie");
  if (!header) return false;
  const match = /(?:^|;\s*)omp_web_unlock=([^;]+)/.exec(header);
  return isRequestUnlocked(match?.[1] ? decodeURIComponent(match[1]) : undefined);
}
