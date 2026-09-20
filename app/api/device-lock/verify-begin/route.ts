import { NextResponse } from "next/server";
import { beginVerification, isDeviceLockEnabled, listDeviceCredentials } from "@/lib/device-lock";
import { deviceLockErrorResponse, rpContextForRequest } from "@/lib/device-lock-route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST /api/device-lock/verify-begin — WebAuthn assertion options for the
// unlock screen. Needs at least one registered credential; the challenge is
// memory-only (2 min TTL, single-use).
export async function POST(request: Request) {
  if (!isDeviceLockEnabled()) return deviceLockErrorResponse("device_lock_disabled");
  const result = await beginVerification({
    credentials: listDeviceCredentials().map(({ id }) => ({ id })),
    requestOrigin: rpContextForRequest(request),
  });
  if (!result.ok) return deviceLockErrorResponse(result.code, result.message);
  return NextResponse.json({ success: true, data: result.data });
}
