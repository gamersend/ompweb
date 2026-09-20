// ============================================================================
// herdr attach — render-plan primitives (Phase 13).
//
// Pure, DOM-free, dependency-free: safe to import from client components AND
// the server-side herdr-attach runner. Ported semantics from firedeck's
// lib/terminal.ts pane renderer (BUILD-PLAN Phase 13):
//
// - append  → the pane content only GREW and everything before the growth is
//             unchanged: write just the suffix (no flicker, no scroll jump).
// - reset   → the content slid (scrollback trimmed) or shrank (clear):
//             reset the view and rewrite the whole snapshot.
// - skip    → fingerprint unchanged (same content): write nothing.
//
// The poll loop (800 ms, server route) carries full pane snapshots; this
// plan turns each pair into the smallest xterm write. `herdr read` output is
// treated as the pane's visible screen text.
// ============================================================================

export type PaneRenderPlan =
  | { kind: "skip" }
  | { kind: "append"; text: string }
  | { kind: "reset"; text: string };

/** Compact fingerprint of a snapshot: length + rolling djb2 hash, hex.
 * Collision risk across pane-sized strings is negligible and the plan step
 * re-verifies with a real comparison before choosing skip vs append. */
export function paneFingerprint(content: string): string {
  let hash = 5381;
  for (let i = 0; i < content.length; i += 1) {
    hash = ((hash << 5) + hash + content.charCodeAt(i)) | 0;
  }
  return `${content.length.toString(36)}:${(hash >>> 0).toString(36)}`;
}

/** Decide the smallest write that turns `previous` into `next`. */
export function planPaneRender(previous: string, next: string): PaneRenderPlan {
  if (next === previous) return { kind: "skip" };
  // append: strictly grew, old prefix intact (the slide/shrink cases all
  // break startsWith because trimmed/overwritten content changes the head).
  if (next.length > previous.length && next.startsWith(previous)) {
    return { kind: "append", text: next.slice(previous.length) };
  }
  return { kind: "reset", text: next };
}

/** Stateful helper for a poll loop: keeps the last fingerprint, returns the
 * plan for each new snapshot. Cheap enough to reconstruct per poll — the
 * fingerprint check short-circuits before any string comparison of the full
 * bodies. */
export function createPaneDiffState(initialFingerprint?: string): {
  apply(next: string): PaneRenderPlan;
} {
  let lastFingerprint = initialFingerprint ?? null;
  return {
    apply(next: string): PaneRenderPlan {
      const fingerprint = paneFingerprint(next);
      if (fingerprint === lastFingerprint) return { kind: "skip" };
      lastFingerprint = fingerprint;
      return { kind: "reset", text: next };
    },
  };
}

// ============================================================================
// Defensive wire parsing
// ============================================================================

export interface HerdrPaneMeta {
  id: string;
  title: string | null;
  cwd: string | null;
  session: string | null;
  /** herdr-reported owning session, when the pane list carries one. Absent /
   * null means the pane is unowned and may be attached. */
  owner: string | null;
}

const PANE_ID_PATTERN = /^[A-Za-z0-9_.:@-]{1,128}$/;

/** A pane id is interpolated into fixed argv for `herdr pane read/send/...`.
 * spawn never involves a shell, but an id beginning with "-" would be parsed
 * as a flag and whitespace/controls would mangle the argument — confine ids
 * to the shape herdr actually issues. */
export function isValidPaneId(id: string): boolean {
  return typeof id === "string" && !id.startsWith("-") && PANE_ID_PATTERN.test(id);
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** Parse `herdr pane list --json` output. Unknown shapes degrade to an empty
 * list — never throw, the picker just shows nothing. Accepts both a bare
 * array and `{panes: [...]}`. */
export function parsePaneList(raw: string): HerdrPaneMeta[] {
  if (!raw || typeof raw !== "string") return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  const list = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === "object" && Array.isArray((parsed as { panes?: unknown }).panes)
      ? (parsed as { panes: unknown[] }).panes
      : [];
  const out: HerdrPaneMeta[] = [];
  for (const entry of list) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    const id = optionalString(record.id);
    if (!id || !isValidPaneId(id)) continue;
    out.push({
      id,
      title: optionalString(record.title) ?? optionalString(record.name),
      cwd: optionalString(record.cwd) ?? optionalString(record.dir),
      session: optionalString(record.session) ?? optionalString(record.sessionName),
      owner: optionalString(record.owner) ?? optionalString(record.ownerSession),
    });
  }
  return out;
}

/** A pane is attachable as owner when herdr reports no other owner. ompweb's
 * own claim (server-side, herdr-attach.ts) is layered on top by the caller. */
export function isPaneAttachable(pane: HerdrPaneMeta): boolean {
  return pane.owner === null;
}
