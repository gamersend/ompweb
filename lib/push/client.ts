// ============================================================================
// Client-side pure helpers for the Web Push enable flow. NO DOM/window access
// at module level — every browser fact arrives as a function argument so the
// capability ladder is unit-testable in node:test.
// ============================================================================

export type PushCapability =
  | { supported: true }
  | { supported: false; reason: "no-push-manager" | "no-service-worker" | "ios-needs-install" };

export interface PushCapabilityInput {
  /** "PushManager" in window */
  hasPushManager: boolean;
  /** "serviceWorker" in navigator */
  hasServiceWorker: boolean;
  /** iOS / iPadOS Safari (including iPadOS-13+ masquerading as Mac). */
  isIOS: boolean;
  /** Installed-PWA mode: display-mode: standalone or navigator.standalone. */
  isStandalone: boolean;
}

/**
 * The capability ladder, in order:
 * 1. PushManager + serviceWorker must exist (any non-push browser, old Safari).
 * 2. iOS/iPadOS Safari only exposes Web Push inside the INSTALLED PWA
 *    (iOS/iPadOS 16.4+; added to Home Screen). A regular Safari tab cannot
 *    subscribe — the UI must explain that instead of failing opaquely.
 */
export function detectPushCapability(input: PushCapabilityInput): PushCapability {
  if (!input.hasServiceWorker) return { supported: false, reason: "no-service-worker" };
  if (!input.hasPushManager) return { supported: false, reason: "no-push-manager" };
  if (input.isIOS && !input.isStandalone) return { supported: false, reason: "ios-needs-install" };
  return { supported: true };
}

/** Best-effort iOS detection: explicit i-devices, plus iPadOS 13+ which
 * reports itself as Macintosh with a multi-touch screen. */
export function isIOSUserAgent(userAgent: string, maxTouchPoints = 0): boolean {
  return /iphone|ipad|ipod/i.test(userAgent)
    || (/Macintosh/i.test(userAgent) && maxTouchPoints > 1);
}

/** Installed-PWA check across browsers: the standard display-mode query plus
 * Safari's legacy navigator.standalone flag. */
export function isStandaloneDisplay(matchesStandalone: boolean, navigatorStandalone: boolean): boolean {
  return matchesStandalone || navigatorStandalone === true;
}

/** applicationServerKey needs raw bytes: base64url → Uint8Array. The array is
 * backed by a plain ArrayBuffer so it satisfies the DOM BufferSource type. */
export function decodeBase64UrlToUint8Array(base64Url: string): Uint8Array<ArrayBuffer> {
  const padding = "=".repeat((4 - (base64Url.length % 4)) % 4);
  const base64 = `${base64Url}${padding}`.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(base64);
  const buffer = new ArrayBuffer(binary.length);
  const bytes = new Uint8Array(buffer);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
