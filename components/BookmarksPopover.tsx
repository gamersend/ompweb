"use client";
/**
 * Message bookmarks UI (6d): the chat-header popover listing a session's
 * bookmarks and the per-message star toggle.
 *
 * The popover renders nothing until the session has at least one bookmark,
 * so fresh sessions carry no chrome; the pill appears with the first star.
 * Clicking a row jumps via the P1 anchor API (`anchorTo`), which resolves
 * branch hops server-side, scrolls instantly and shows the highlight ring.
 * Bookmark state lives in lib/bookmarks.ts (localStorage); this component
 * only subscribes to its change events.
 */
import { memo, useCallback, useEffect, useState } from "react";
import { Popover } from "@base-ui/react/popover";
import { Pencil, Star, X } from "lucide-react";
import { useI18n } from "@/lib/i18n";
import {
  isBookmarked,
  listBookmarks,
  removeBookmark,
  setBookmarkNote,
  subscribeBookmarks,
  toggleBookmark,
  type BookmarkEntry,
} from "@/lib/bookmarks";
import type { AgentMessage } from "@/lib/types";

const BOOKMARK_PREVIEW_MAX_CHARS = 140;

/** Flat display text for one message (user or assistant prose). */
function messagePreviewText(message: AgentMessage): string | null {
  if (message.role === "user") {
    if (typeof message.content === "string") {
      const text = message.content.trim();
      return text.length > 0 ? text : null;
    }
    const text = message.content
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("\n")
      .trim();
    return text.length > 0 ? text : null;
  }
  if (message.role === "assistant") {
    const text = (message.content ?? [])
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("\n")
      .trim();
    return text.length > 0 ? text : null;
  }
  return null;
}

/** entryId → short preview, for the popover rows (missing ids fall back to
 *  the note or a placeholder so rows stay actionable after lazy-load trimming). */
export function buildBookmarkPreviews(messages: AgentMessage[], entryIds: string[]): Map<string, string> {
  const previews = new Map<string, string>();
  for (let i = 0; i < messages.length; i++) {
    const entryId = entryIds[i];
    if (!entryId || previews.has(entryId)) continue;
    const text = messagePreviewText(messages[i]);
    if (!text) continue;
    const condensed = text.replace(/\s+/g, " ").trim();
    previews.set(
      entryId,
      condensed.length > BOOKMARK_PREVIEW_MAX_CHARS
        ? `${condensed.slice(0, BOOKMARK_PREVIEW_MAX_CHARS - 1)}…`
        : condensed,
    );
  }
  return previews;
}

function formatBookmarkTime(ts: number, locale: string): string {
  if (!ts) return "";
  try {
    return new Date(ts).toLocaleString(locale, {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return "";
  }
}

/* --------------------------- per-message star toggle --------------------------- */

const iconButtonStyle = {
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  width: 22,
  height: 22,
  padding: 0,
  border: "none",
  borderRadius: "var(--radius-control)",
  background: "transparent",
  color: "var(--text-dim)",
  cursor: "pointer",
} as const;

/** Hover-revealed star in a message row's top-right corner. Filled while the
 *  entry is bookmarked; toggles through the store so the popover + sidebar
 *  badge update via the same change event. */
export const MessageBookmarkButton = memo(function MessageBookmarkButton({
  sessionId,
  entryId,
}: {
  sessionId: string | undefined;
  entryId: string | undefined;
}) {
  const { t } = useI18n();
  const [bookmarked, setBookmarked] = useState(() => (sessionId && entryId ? isBookmarked(sessionId, entryId) : false));
  const [hovered, setHovered] = useState(false);
  useEffect(() => {
    if (!sessionId || !entryId) return;
    setBookmarked(isBookmarked(sessionId, entryId));
    return subscribeBookmarks((changed) => {
      if (changed !== sessionId) return;
      setBookmarked(isBookmarked(sessionId, entryId));
    });
  }, [sessionId, entryId]);

  const onToggle = useCallback(() => {
    if (!sessionId || !entryId) return;
    setBookmarked(toggleBookmark(sessionId, entryId));
  }, [sessionId, entryId]);

  if (!sessionId || !entryId) return null;
  const active = bookmarked || hovered;
  return (
    <button
      type="button"
      aria-label={bookmarked ? t("bookmarks.remove") : t("bookmarks.add")}
      aria-pressed={bookmarked}
      title={bookmarked ? t("bookmarks.remove") : t("bookmarks.add")}
      onClick={(event) => {
        event.stopPropagation();
        onToggle();
      }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        position: "absolute",
        top: 2,
        right: 0,
        zIndex: 5,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        width: 24,
        height: 24,
        padding: 0,
        border: "none",
        borderRadius: "var(--radius-control)",
        background: hovered ? "var(--bg-hover)" : "transparent",
        color: bookmarked ? "var(--accent)" : "var(--text-dim)",
        cursor: "pointer",
        opacity: active ? 1 : 0,
        transition: "opacity var(--dur-fast) var(--ease-out-warm), color var(--dur-fast) var(--ease-out-warm), background var(--dur-fast) var(--ease-out-warm)",
      }}
    >
      <Star size={13} strokeWidth={1.8} fill={bookmarked ? "currentColor" : "none"} aria-hidden="true" />
    </button>
  );
});

/* ------------------------------- header popover ------------------------------- */

/** Chat-header pill + popover: every bookmark of the session, with preview,
 *  time, inline note edit, remove, and click-to-jump via `anchorTo`. */
export function BookmarksPopover({
  sessionId,
  previewByEntry,
  onJump,
}: {
  sessionId: string | null | undefined;
  /** entryId → display preview built from the loaded transcript. */
  previewByEntry?: Map<string, string>;
  /** Jump request for one entry (ChatWindow passes the anchor API). */
  onJump: (entryId: string) => void;
}) {
  const { t, locale, tn } = useI18n();
  const [bookmarks, setBookmarks] = useState<BookmarkEntry[]>([]);
  const [open, setOpen] = useState(false);
  const [editingEntryId, setEditingEntryId] = useState<string | null>(null);
  const [noteDraft, setNoteDraft] = useState("");

  useEffect(() => {
    if (!sessionId) {
      setBookmarks([]);
      return;
    }
    setBookmarks(listBookmarks(sessionId));
    return subscribeBookmarks((changed) => {
      if (changed !== sessionId) return;
      setBookmarks(listBookmarks(sessionId));
    });
  }, [sessionId]);

  const handleJump = useCallback((entryId: string) => {
    setOpen(false);
    onJump(entryId);
  }, [onJump]);

  const startNoteEdit = useCallback((entry: BookmarkEntry) => {
    setEditingEntryId(entry.entryId);
    setNoteDraft(entry.note ?? "");
  }, []);

  const commitNoteEdit = useCallback(() => {
    if (sessionId && editingEntryId) setBookmarkNote(sessionId, editingEntryId, noteDraft);
    setEditingEntryId(null);
    setNoteDraft("");
  }, [sessionId, editingEntryId, noteDraft]);

  const count = bookmarks.length;
  if (!sessionId || (count === 0 && !open)) return null;

  const pillLabel = tn("bookmarks.count", count);
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger
        render={
          <button
            type="button"
            aria-label={pillLabel}
            title={pillLabel}
            style={{
              pointerEvents: "auto",
              display: "flex",
              alignItems: "center",
              gap: 5,
              height: 26,
              padding: "0 9px",
              border: "1px solid color-mix(in srgb, var(--border) 70%, transparent)",
              borderRadius: "var(--radius-card)",
              background: "var(--bg)",
              boxShadow: "var(--shadow-card)",
              color: "var(--text-muted)",
              cursor: "pointer",
              fontSize: 11,
              fontWeight: 600,
              fontVariantNumeric: "tabular-nums",
            }}
          >
            <Star size={12} strokeWidth={1.8} fill="currentColor" aria-hidden="true" style={{ color: "var(--accent)" }} />
            <span>{count}</span>
          </button>
        }
      />
      <Popover.Portal>
        <Popover.Positioner align="end" sideOffset={6} style={{ zIndex: 1100 }}>
          <Popover.Popup
            aria-label={t("bookmarks.panelLabel")}
            style={{
              background: "var(--bg)",
              color: "var(--text)",
              border: "1px solid var(--border)",
              borderRadius: "var(--radius-card)",
              boxShadow: "var(--shadow-pop)",
              width: "min(420px, calc(100vw - 32px))",
              maxHeight: 380,
              overflowY: "auto",
              padding: 8,
              fontSize: 12,
            }}
          >
            <div style={{ padding: "4px 6px 8px", color: "var(--text-muted)", fontWeight: 600, fontSize: 11 }}>
              {t("bookmarks.panelLabel")}
            </div>
            {count === 0 ? (
              <div style={{ padding: "2px 6px 8px", color: "var(--text-dim)" }}>{t("bookmarks.empty")}</div>
            ) : (
              <div role="list">
                {bookmarks.map((bookmark) => {
                  const preview = previewByEntry?.get(bookmark.entryId) ?? "";
                  const time = formatBookmarkTime(bookmark.ts, locale);
                  return (
                    <div
                      key={bookmark.entryId}
                      role="listitem"
                      style={{
                        display: "flex",
                        flexDirection: "column",
                        gap: 4,
                        padding: "6px",
                        borderRadius: "var(--radius-control)",
                      }}
                    >
                      <div style={{ display: "flex", alignItems: "flex-start", gap: 6 }}>
                        <button
                          type="button"
                          aria-label={t("bookmarks.jumpTo", { preview: preview || bookmark.entryId })}
                          title={preview || bookmark.entryId}
                          onClick={() => handleJump(bookmark.entryId)}
                          style={{
                            flex: 1,
                            minWidth: 0,
                            display: "flex",
                            flexDirection: "column",
                            alignItems: "stretch",
                            gap: 2,
                            padding: 4,
                            border: "none",
                            borderRadius: "var(--radius-control)",
                            background: "transparent",
                            color: "var(--text)",
                            textAlign: "left",
                            cursor: "pointer",
                          }}
                          onMouseEnter={(e) => { e.currentTarget.style.background = "var(--bg-hover)"; }}
                          onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}
                        >
                          <span style={{ overflow: "hidden", textOverflow: "ellipsis", display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", lineHeight: 1.4 }}>
                            {preview || t("bookmarks.noPreview")}
                          </span>
                          {bookmark.note && editingEntryId !== bookmark.entryId && (
                            <span style={{ color: "var(--accent)", fontSize: 11, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                              {bookmark.note}
                            </span>
                          )}
                          {time && <span style={{ color: "var(--text-dim)", fontSize: 10, fontVariantNumeric: "tabular-nums" }}>{time}</span>}
                        </button>
                        <div style={{ display: "flex", alignItems: "center", gap: 2, flexShrink: 0, paddingTop: 4 }}>
                          <button
                            type="button"
                            aria-label={t("bookmarks.noteEdit")}
                            title={t("bookmarks.noteEdit")}
                            onClick={() => startNoteEdit(bookmark)}
                            style={iconButtonStyle}
                            onMouseEnter={(e) => { e.currentTarget.style.color = "var(--text)"; e.currentTarget.style.background = "var(--bg-hover)"; }}
                            onMouseLeave={(e) => { e.currentTarget.style.color = "var(--text-dim)"; e.currentTarget.style.background = "transparent"; }}
                          >
                            <Pencil size={12} strokeWidth={1.8} aria-hidden="true" />
                          </button>
                          <button
                            type="button"
                            aria-label={t("bookmarks.remove")}
                            title={t("bookmarks.remove")}
                            onClick={() => sessionId && removeBookmark(sessionId, bookmark.entryId)}
                            style={iconButtonStyle}
                            onMouseEnter={(e) => { e.currentTarget.style.color = "var(--status-error)"; e.currentTarget.style.background = "var(--bg-hover)"; }}
                            onMouseLeave={(e) => { e.currentTarget.style.color = "var(--text-dim)"; e.currentTarget.style.background = "transparent"; }}
                          >
                            <X size={13} strokeWidth={1.8} aria-hidden="true" />
                          </button>
                        </div>
                      </div>
                      {editingEntryId === bookmark.entryId && (
                        <input
                          /* Inline note editor: Enter/blur commits, Esc cancels. */
                          value={noteDraft}
                          autoFocus
                          aria-label={t("bookmarks.noteEdit")}
                          placeholder={t("bookmarks.notePlaceholder")}
                          onChange={(event) => setNoteDraft(event.target.value)}
                          onBlur={commitNoteEdit}
                          onKeyDown={(event) => {
                            if (event.key === "Enter") {
                              event.preventDefault();
                              commitNoteEdit();
                            } else if (event.key === "Escape") {
                              event.preventDefault();
                              setEditingEntryId(null);
                              setNoteDraft("");
                            }
                          }}
                          style={{
                            width: "100%",
                            boxSizing: "border-box",
                            height: 26,
                            padding: "3px 8px",
                            border: "1px solid var(--border)",
                            borderRadius: "var(--radius-control)",
                            outline: "none",
                            background: "var(--bg)",
                            color: "var(--text)",
                            fontSize: 12,
                          }}
                        />
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}
