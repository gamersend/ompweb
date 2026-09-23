/**
 * P20 — device capability detection (app badging, share target, background
 * sync, file system access).
 *
 * Same contract as lib/web-share.ts: every browser global is reached through
 * an injectable environment so tests exercise the exact predicates the UI
 * runs, and nothing here ever throws. Pure — no fs, no network, no React.
 *
 * What each capability means:
 * - `appBadging`: `navigator.setAppBadge`/`clearAppBadge` exist (installed
 *   PWA on Chromium/Android/desktop). `applyAppBadge` is the silent writer.
 * - `shareTarget`: actual share-target arrival happens via URL params
 *   (`share-text`/`share-url`, see manifest.webmanifest share_target and
 *   lib/initial-navigation.ts) — it cannot be feature-detected at runtime.
 *   The only checkable signal is the installed standalone display mode, a
 *   PROXY (an installed PWA may still not declare a share target). Report
 *   both `supported` (the proxy) and `standalone` so callers never conflate
 *   them.
 * - `backgroundSync`: `navigator.serviceWorker` present AND the global
 *   `SyncManager` exists. Presence only — never registers or awaits here.
 * - `fileSystemAccess`: `window.showOpenFilePicker` is invocable.
 */

/** The slice of navigator this module needs. Structural on purpose. */
export interface DeviceCapabilityNavigatorLike {
  setAppBadge?: unknown;
  clearAppBadge?: unknown;
  /** iOS Safari legacy standalone marker (home-screen web app). */
  standalone?: unknown;
  serviceWorker?: { ready?: unknown } | undefined;
}

export interface DeviceCapabilityWindowLike {
  showOpenFilePicker?: unknown;
  matchMedia?: ((query: string) => { matches: boolean }) | undefined;
}

/** Everything the helpers touch, injectable for tests. */
export interface DeviceCapabilityEnvironment {
  navigator?: DeviceCapabilityNavigatorLike | undefined;
  window?: DeviceCapabilityWindowLike | undefined;
  /** The global `SyncManager` constructor (background sync), injectable. */
  SyncManager?: unknown;
}

export interface CapabilitySupport {
  supported: boolean;
}

export interface ShareTargetCapability extends CapabilitySupport {
  /**
   * True when the installed standalone display mode is detected. This is the
   * only client-checkable proxy for share-target availability — actual
   * arrival is via `share-text`/`share-url` URL params, never this flag.
   */
  standalone: boolean;
}

export interface DeviceCapabilities {
  appBadging: CapabilitySupport;
  shareTarget: ShareTargetCapability;
  backgroundSync: CapabilitySupport;
  fileSystemAccess: CapabilitySupport;
}

function isCallable(value: unknown): value is (...args: never[]) => unknown {
  return typeof value === "function";
}

/** The real browser globals, guarded: SSR and odd runtimes must not crash. */
function defaultEnvironment(): DeviceCapabilityEnvironment {
  try {
    const nav = typeof navigator === "undefined" ? undefined : (navigator as unknown as DeviceCapabilityNavigatorLike);
    const win = typeof window === "undefined" ? undefined : (window as unknown as DeviceCapabilityWindowLike);
    // globalThis, not the bare identifier: SyncManager is not in every
    // TypeScript DOM lib set, and this must compile and run everywhere.
    const syncManager = (globalThis as { SyncManager?: unknown }).SyncManager;
    return { navigator: nav, window: win, SyncManager: syncManager };
  } catch {
    return {};
  }
}

/** True when both badging functions are invocable. Never throws. */
export function appBadgingSupported(env: DeviceCapabilityEnvironment = defaultEnvironment()): boolean {
  try {
    const nav = env?.navigator;
    return isCallable(nav?.setAppBadge) && isCallable(nav?.clearAppBadge);
  } catch {
    return false;
  }
}

/**
 * Standalone display-mode detection: the CSS `(display-mode: standalone)`
 * media query first, then iOS Safari's legacy `navigator.standalone` marker.
 * Never throws; absence of both is `false`.
 */
export function detectStandaloneDisplayMode(env: DeviceCapabilityEnvironment = defaultEnvironment()): boolean {
  try {
    const matchMedia = env?.window?.matchMedia;
    if (isCallable(matchMedia)) {
      if (matchMedia("(display-mode: standalone)")?.matches === true) return true;
    }
    return env?.navigator?.standalone === true;
  } catch {
    return false;
  }
}

/**
 * Share-target proxy: see the module header. `supported` mirrors the
 * standalone detection — it says "probably an installed PWA", never "the
 * manifest declared this app a share target".
 */
export function shareTargetCapability(env: DeviceCapabilityEnvironment = defaultEnvironment()): ShareTargetCapability {
  const standalone = detectStandaloneDisplayMode(env);
  return { supported: standalone, standalone };
}

/** `navigator.serviceWorker` present AND the global SyncManager exists. */
export function backgroundSyncSupported(env: DeviceCapabilityEnvironment = defaultEnvironment()): boolean {
  try {
    const serviceWorker = env?.navigator?.serviceWorker;
    if (!serviceWorker || typeof serviceWorker !== "object") return false;
    return env?.SyncManager !== undefined && env.SyncManager !== null;
  } catch {
    return false;
  }
}

/** `window.showOpenFilePicker` is invocable. Never throws. */
export function fileSystemAccessSupported(env: DeviceCapabilityEnvironment = defaultEnvironment()): boolean {
  try {
    return isCallable(env?.window?.showOpenFilePicker);
  } catch {
    return false;
  }
}

/** One call, whole table. */
export function getDeviceCapabilities(env: DeviceCapabilityEnvironment = defaultEnvironment()): DeviceCapabilities {
  return {
    appBadging: { supported: appBadgingSupported(env) },
    shareTarget: shareTargetCapability(env),
    backgroundSync: { supported: backgroundSyncSupported(env) },
    fileSystemAccess: { supported: fileSystemAccessSupported(env) },
  };
}

/**
 * P20.2 — mirror the actionable unread count onto the OS app icon.
 *
 * count > 0 → `setAppBadge(n)` (clamped to a non-negative integer), count ≤ 0
 * → `clearAppBadge()`. Returns `true` only when a badging call was actually
 * issued; unsupported browsers, thrown sync errors, and rejected promises all
 * resolve to a silent `false` — badging must never surface an error. Never
 * throws.
 */
export function applyAppBadge(count: number, env: DeviceCapabilityEnvironment = defaultEnvironment()): boolean {
  try {
    const nav = env?.navigator;
    if (!isCallable(nav?.setAppBadge) || !isCallable(nav?.clearAppBadge)) return false;
    const navigatorLike = nav as DeviceCapabilityNavigatorLike & {
      setAppBadge: (value?: number) => unknown;
      clearAppBadge: () => unknown;
    };
    let result: unknown;
    if (Number.isFinite(count) && count > 0) {
      result = navigatorLike.setAppBadge(Math.floor(count));
    } else {
      result = navigatorLike.clearAppBadge();
    }
    // Promise rejection must never become an unhandled rejection.
    const pending = result as PromiseLike<unknown> | undefined;
    if (pending && typeof pending.then === "function") {
      pending.then(undefined, () => {});
    }
    return true;
  } catch {
    return false;
  }
}
