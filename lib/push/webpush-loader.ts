import { createRequire } from "module";

// ============================================================================
// Lazy `web-push` loader. The package is CJS and drags a legacy dependency
// tree (request, uuid@3) — it must never be statically imported into the
// Next.js server bundle. createRequire resolves it at runtime from the real
// node_modules, exactly like lib/omp-stats-db.ts reaches node:sqlite. Only the
// push routes / the feed hook ever load it (and only when a push is due).
// ============================================================================

export interface WebPushSubscriptionShape {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

export interface WebPushSendOptions {
  vapidDetails: { subject: string; publicKey: string; privateKey: string };
  /** Time-to-live for the message at the push service (seconds). */
  TTL?: number;
  /** Per-request socket timeout (ms) — supported by web-push ≥ 3.5. */
  timeout?: number;
}

/** The slice of the web-push API ompweb uses. A push service rejecting a
 * delivery throws (typically WebPushError) with a numeric `statusCode`. */
export interface WebPushModule {
  generateVAPIDKeys(): { publicKey: string; privateKey: string };
  sendNotification(
    subscription: WebPushSubscriptionShape,
    payload?: string | null,
    options?: WebPushSendOptions,
  ): Promise<{ statusCode: number }>;
}

let cached: WebPushModule | null = null;

/** Runtime require of "web-push"; cached for the process. */
export function loadWebPushModule(): WebPushModule {
  if (cached) return cached;
  const require = createRequire(import.meta.url);
  cached = require("web-push") as WebPushModule;
  return cached;
}

/** Test hook: inject a fake web-push module (null restores the real one). */
export function setWebPushModuleForTests(impl: WebPushModule | null): void {
  cached = impl;
}

/** Pull the numeric HTTP status out of a web-push failure (WebPushError or a
 * plain object tagged by our own boundary). 404/410 mean "subscription gone". */
export function statusCodeOf(error: unknown): number | undefined {
  if (error && typeof error === "object" && "statusCode" in error) {
    const value = (error as { statusCode?: unknown }).statusCode;
    if (typeof value === "number") return value;
  }
  return undefined;
}
