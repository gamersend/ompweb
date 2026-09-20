import { NextResponse } from "next/server";
import { deviceCredentialCount, hasDeviceCredentials, isDeviceLockEnabled, listDeviceCredentials } from "@/lib/device-lock";
import { isUnlockedRequest } from "@/lib/device-lock-route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/device-lock/status — gate state for the Settings section.
// enabled mirrors the env gate (the section renders nothing when false);
// credentials carry id/label/createdAt only — never the public key blob.
export async function GET(request: Request) {
  if (!isDeviceLockEnabled()) {
    return NextResponse.json({ success: true, data: { enabled: false, hasCredentials: false, credentialCount: 0, credentials: [], unlocked: false } });
  }
  return NextResponse.json({
    success: true,
    data: {
      enabled: true,
      hasCredentials: hasDeviceCredentials(),
      credentialCount: deviceCredentialCount(),
      credentials: listDeviceCredentials(),
      unlocked: isUnlockedRequest(request),
    },
  });
}
