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
