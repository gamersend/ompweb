/**
 * P18 / R3-26 — Web Share capability + invocation for session exports.
 *
 * The export menu already offers HTML / Markdown download / Copy as Markdown;
 * this module adds the Web Share API (`navigator.share`) lane: a capability
 * check so the menu can hide the "Share…" entry where the API is missing
 * (Firefox, most desktop browsers) and a defensive invocation that maps the
 * outcome to one of three values. Every browser global is reached through an
 * injectable environment so tests exercise the exact mapping the menu runs,
 * and nothing here ever throws.
 *
 * Pure-ish by design: no fs, no network, no React. The caller composes the
 * text (the export menu fetches the same `?format=md` endpoint its Copy
 * entry uses — never a second composer).
 */

/** The three terminal outcomes of a share attempt. */
export type WebShareOutcome = "shared" | "cancelled" | "unsupported";

/**
 * The slice of the Web Share API this module needs. Structural on purpose:
 * the DOM typing never constrains the injected test doubles, and
 * `navigator.share` / `navigator.canShare` are optional members at runtime.
 */
export interface ShareNavigatorLike {
  share?: (data: { title?: string; text?: string; files?: unknown[] }) => Promise<void>;
  canShare?: (data: { files?: unknown[]; title?: string; text?: string }) => boolean;
}

/** Minimal structural File constructor (browsers and Node 20+ both have one). */
export interface ShareFileCtor {
  new (parts: readonly unknown[], name: string, options?: { type?: string }): unknown;
}

/**
 * Everything the helpers touch. `navigator` is required (possibly undefined
 * — the Node/test default), `FileCtor` is injectable so `shareFileRecommended`
 * stays deterministic on any runtime.
 */
export interface WebShareEnvironment {
  navigator: ShareNavigatorLike | undefined;
  FileCtor?: ShareFileCtor | undefined;
}

/** The real navigator, guarded: SSR and odd runtimes must not crash a read. */
function defaultNavigator(): ShareNavigatorLike | undefined {
  try {
    if (typeof navigator === "undefined") return undefined;
    return navigator as unknown as ShareNavigatorLike;
  } catch {
    return undefined;
  }
}

/** The default environment (production). Tests pass their own. */
function defaultEnvironment(): WebShareEnvironment {
  return {
    navigator: defaultNavigator(),
    FileCtor: typeof File === "undefined" ? undefined : (File as unknown as ShareFileCtor),
  };
}

/**
 * True when `navigator.share` is an invocable function. Never throws.
 * Callers use this to capability-detect at mount and simply omit the
 * "Share…" menu item on unsupported browsers.
 */
export function canWebShare(nav?: ShareNavigatorLike | undefined): boolean {
  try {
    return typeof (nav ?? defaultNavigator())?.share === "function";
  } catch {
    return false;
  }
}

/**
 * Share plain text through `navigator.share({ title, text })`.
 *
 * Outcome mapping: the API missing → "unsupported"; the sheet resolving →
 * "shared"; any rejection — `AbortError` (the user closed the share sheet)
 * or anything else (permission refused, platform quirk) — resolves
 * "cancelled". The helper never throws and never surfaces an error to the
 * caller, so the UI can treat "cancelled" as a silent no-op.
 */
export async function shareText(
  title: string,
  text: string,
  env: WebShareEnvironment = defaultEnvironment(),
): Promise<WebShareOutcome> {
  const nav = env.navigator;
  const share = nav?.share;
  if (typeof share !== "function") return "unsupported";
  try {
    await share.call(nav, { title, text });
    return "shared";
  } catch {
    // AbortError (user dismissed the sheet) and every other rejection land
    // here: nothing happened from the user's point of view.
    return "cancelled";
  }
}

/**
 * Whether sharing a FILE would be accepted on this browser: builds a
 * `File` from the markdown string (`text/markdown`) and asks
 * `navigator.canShare({ files })`. Requires both `canShare` and `share` to
 * be present, a usable File constructor, and a `true` answer — anything
 * missing, throwing, or negative resolves `false` (callers fall back to
 * `shareText`). Never throws.
 */
export function shareFileRecommended(
  markdown: string,
  filename = "session.md",
  env: WebShareEnvironment = defaultEnvironment(),
): boolean {
  try {
    const nav = env.navigator;
    const canShare = nav?.canShare;
    if (typeof canShare !== "function" || typeof nav?.share !== "function") return false;
    const FileCtor = env.FileCtor ?? (typeof File === "undefined" ? undefined : (File as unknown as ShareFileCtor));
    if (typeof FileCtor !== "function") return false;
    const file = new FileCtor([markdown], filename, { type: "text/markdown" });
    return canShare.call(nav, { files: [file] }) === true;
  } catch {
    return false;
  }
}
