export interface InitialAnchor {
  entryId: string;
  /** Optional [start, end) character range into the entry's text. */
  hl?: [number, number];
}

export interface InitialNavigation {
  requestedCwd: string | null;
  sessionId: string | null;
  /** P1 deep link: `&anchor=<entryId>` (+ `&hl=<start>,<end>`). */
  anchor: InitialAnchor | null;
}

function parseAnchor(searchParams: Pick<URLSearchParams, "get">): InitialAnchor | null {
  const entryId = searchParams.get("anchor")?.trim() || "";
  if (!entryId) return null;
  const hlParam = searchParams.get("hl") ?? "";
  const parts = hlParam.split(",").map((value) => Number.parseInt(value, 10));
  if (parts.length === 2 && Number.isInteger(parts[0]) && Number.isInteger(parts[1]) && parts[0] >= 0 && parts[1] >= parts[0]) {
    return { entryId, hl: [parts[0], parts[1]] };
  }
  return { entryId };
}

export function getInitialNavigation(searchParams: Pick<URLSearchParams, "get">): InitialNavigation {
  const requestedCwd = searchParams.get("cwd")?.trim() || null;

  return {
    requestedCwd,
    sessionId: requestedCwd ? null : searchParams.get("session"),
    anchor: parseAnchor(searchParams),
  };
}

// ============================================================================
// P20.3 / P20.4 — PWA share-target intake.
//
// manifest.webmanifest declares `share_target: { action: "/", method: "GET",
// params: { text: "share-text", url: "share-url" } }`, so a share from
// another app lands on "/" with those params. The payload becomes a COMPOSER
// DRAFT — never an auto-send — prefixed with a visible provenance header the
// user sees and can edit/delete before sending (P20.4). `getInitialNavigation`
// keeps its original shape (existing tests pin it); share parsing is a
// separate export consumed alongside it.
// ============================================================================

/** Visible provenance line prefixed onto every share-target draft. */
export const SHARE_PROVENANCE_HEADER = "[Shared from another app — review before sending]";

/** Hard bounds so a hostile share payload cannot blow up a draft. */
export const SHARE_TEXT_MAX_CHARS = 8000;
export const SHARE_URL_MAX_CHARS = 2048;

/** The decoded share-target payload (`url` only when the app sent one). */
export interface SharedTargetPayload {
  text: string;
  url: string | null;
}

/**
 * Parse `?share-text=`/`?share-url=` out of the URL search. Whitespace-only
 * values count as absent; text is bounded to SHARE_TEXT_MAX_CHARS and the url
 * (trimmed) to SHARE_URL_MAX_CHARS. Returns `null` when neither param
 * carries content — i.e. this was not a share-target arrival.
 */
export function parseShareTarget(searchParams: Pick<URLSearchParams, "get">): SharedTargetPayload | null {
  const rawText = searchParams.get("share-text") ?? "";
  const rawUrl = searchParams.get("share-url") ?? "";
  const text = rawText.trim() ? rawText.slice(0, SHARE_TEXT_MAX_CHARS) : "";
  const trimmedUrl = rawUrl.trim();
  const url = trimmedUrl ? trimmedUrl.slice(0, SHARE_URL_MAX_CHARS) : null;
  if (!text && !url) return null;
  return { text, url };
}

/**
 * Build the draft message: the provenance header, then the shared text, then
 * the shared url when present — one per line. Re-bounds both parts
 * defensively so any caller-composed payload stays within the caps.
 */
export function buildShareDraftMessage(share: SharedTargetPayload): string {
  const text = share.text.slice(0, SHARE_TEXT_MAX_CHARS);
  const url = (share.url ?? "").slice(0, SHARE_URL_MAX_CHARS);
  const parts = [text, url].filter((part) => part.length > 0);
  if (parts.length === 0) return "";
  return SHARE_PROVENANCE_HEADER + "\n" + parts.join("\n");
}

/**
 * Strip the share-target params from the URL via the injected `replaceState`
 * (the caller wires `history.replaceState` — Next's router would refetch).
 * Keeps every other param and any hash; drops the `?` entirely when nothing
 * remains. Returns `true` only when a share param was present and a
 * replacement URL was emitted.
 */
export function stripShareTargetParams(
  currentSearch: string,
  baseUrl: string,
  replaceState: (url: string) => void,
): boolean {
  const params = new URLSearchParams(currentSearch);
  if (!params.has("share-text") && !params.has("share-url")) return false;
  params.delete("share-text");
  params.delete("share-url");
  const query = params.toString();
  replaceState(baseUrl + (query ? `?${query}` : ""));
  return true;
}
