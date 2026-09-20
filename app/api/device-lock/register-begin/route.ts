import { NextResponse } from "next/server";
import { beginRegistration, deviceCredentialCount, isDeviceLockEnabled, listDeviceCredentials, isLoopbackLikeRequest } from "@/lib/device-lock";
import { deviceLockErrorResponse, isUnlockedRequest, rpContextForRequest } from "@/lib/device-lock-route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST /api/device-lock/register-begin — WebAuthn registration options.
// Bootstrap-once: with ZERO credentials this is loopback-like only (no proxy
// forwarding headers); afterwards it requires a verified unlock cookie. The
// challenge lives in memory (2 min TTL, single-use).
export async function POST(request: Request) {
  if (!isDeviceLockEnabled()) return deviceLockErrorResponse("device_lock_disabled");
  const count = deviceCredentialCount();
  const authorized = count === 0 ? isLoopbackLikeRequest(request.headers) : isUnlockedRequest(request);
  const result = await beginRegistration({
    credentials: listDeviceCredentials().map(({ id }) => ({ id })),
    requestOrigin: rpContextForRequest(request),
    authorized,
  });
  if (!result.ok) return deviceLockErrorResponse(result.code, result.message);
  return NextResponse.json({ success: true, data: result.data });
}
