import { NextResponse, type NextRequest } from "next/server";
import { isApiRequestOriginAllowed, shouldCheckApiRequestOrigin } from "@/lib/request-security";
import { isValidWebSession, isWebPasswordEnabled, OMP_WEB_SESSION_COOKIE } from "@/lib/web-auth";
import {
  evaluateDeviceLockGate,
  getDeviceUnlockKey,
  hasDeviceCredentials,
  isDeviceLockEnabled,
} from "@/lib/device-lock";
import { isValidDeviceUnlockCookie, OMP_WEB_UNLOCK_COOKIE } from "@/lib/web-auth";

export function proxy(request: NextRequest) {
  if (request.nextUrl.pathname.startsWith("/api/") && shouldCheckApiRequestOrigin(request) && !isApiRequestOriginAllowed(request)) {
    return NextResponse.json({ error: "Cross-origin API requests are not allowed" }, { status: 403 });
  }

  // --- Device-local lock (OPTIONAL, default OFF) ---------------------------
  // Only when OMP_WEB_DEVICE_LOCK=1: an additional passkey gate IN FRONT of
  // everything else. Unset env → this block returns "next" and the proxy
  // below behaves exactly as it did before (tests pin the unchanged matrix).
  // Cheap by design: one stat-cached store read + one HMAC verify per request
  // in lock mode; nothing at all when disabled. The unlock cookie only ever
  // exists in lock mode — minted by /api/device-lock/verify-finish after a
  // successful WebAuthn ceremony (lib/web-auth.ts HMAC cookie pattern, keyed
  // on the secret in ~/.omp/agent/web-authz.json — no passwords).
  if (isDeviceLockEnabled()) {
    const unlockCookie = request.cookies.get(OMP_WEB_UNLOCK_COOKIE)?.value;
    const decision = evaluateDeviceLockGate({
      enabled: true,
      pathname: request.nextUrl.pathname,
      passwordEnabled: isWebPasswordEnabled(),
      hasCredentials: hasDeviceCredentials(),
      cookieValid: isValidDeviceUnlockCookie(unlockCookie, getDeviceUnlockKey()),
    });
    if (decision.action === "redirect") {
      return NextResponse.redirect(new URL(decision.to, request.url));
    }
    if (decision.action === "api-locked") {
      return NextResponse.json({ error: "Device locked", code: "device_locked" }, { status: 401 });
    }
  }

  if (!isWebPasswordEnabled()) {
    return request.nextUrl.pathname === "/login"
      ? NextResponse.redirect(new URL("/", request.url))
      : NextResponse.next();
  }

  const { pathname } = request.nextUrl;
  const hasSession = isValidWebSession(request.cookies.get(OMP_WEB_SESSION_COOKIE)?.value);
  if (pathname === "/login") {
    return hasSession ? NextResponse.redirect(new URL("/", request.url)) : NextResponse.next();
  }
  if (pathname === "/api/web-auth/session") return NextResponse.next();
  if (hasSession) return NextResponse.next();
  if (pathname.startsWith("/api/")) {
    return NextResponse.json({ error: "Password required", code: "password_required" }, { status: 401 });
  }
  return NextResponse.redirect(new URL("/login", request.url));
}

// The sign-in screen still needs its Next.js JavaScript and CSS before a
// session exists; these are public build assets, not workspace data. The
// same goes for the web app manifest and its icons: browsers fetch them
// without cookies, and a login redirect there breaks PWA installation.
// The /device-lock unlock screen loads from the same shell assets.
export const config = { matcher: "/((?!_next/static|_next/image|favicon\\.ico|manifest\\.webmanifest|icon\\.svg|icon\\.png|icon-192\\.png).*)" };
