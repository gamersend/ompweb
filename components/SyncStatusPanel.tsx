"use client";

import { useCallback, useEffect, useState } from "react";
import { RotateCcw, ChevronDown, ChevronRight } from "lucide-react";
import { useI18n } from "@/lib/i18n";
import {
  SYNC_ENABLED_EVENT,
  getClientStateSyncStatus,
  listLocalTombstones,
  restoreTombstonedBookmark,
  type ClientStateSyncStatus,
  type LocalTombstone,
} from "@/lib/client-state-sync";
import { shortDeviceId } from "@/lib/device-id";
import { toast } from "./ui/toast";

// ============================================================================
// Sync status surface (wave 3 P2.3): the client-state engine's live state —
// device identity, last pull/push, conflict count, and the bounded list of
// delete tombstones this device is holding, with restore for bookmarks (a
// re-add with a fresh timestamp beats its own tombstone everywhere). Compact
// by default so it fits the phone-width settings column.
// ============================================================================

type TombstoneKind = "bookmark" | "prompt" | "workspace" | "prefs";

function tombstoneKind(serverKey: string): TombstoneKind {
  if (serverKey.startsWith("bookmarks/")) return "bookmark";
  if (serverKey === "prompt-history") return "prompt";
  if (serverKey === "workspace-memory") return "workspace";
  return "prefs";
}

function tombstoneItemLabel(tombstone: LocalTombstone): string {
  if (tombstoneKind(tombstone.serverKey) === "bookmark") {
    const sessionId = tombstone.serverKey.slice("bookmarks/".length);
    const session = sessionId.length > 12 ? `${sessionId.slice(0, 12)}…` : sessionId;
    return `${session} · ${tombstone.itemId.length > 14 ? `${tombstone.itemId.slice(0, 14)}…` : tombstone.itemId}`;
  }
  return tombstone.itemId.length > 28 ? `${tombstone.itemId.slice(0, 28)}…` : tombstone.itemId;
}

function clockTime(ts: number | null): string {
  if (!ts) return "";
  try {
    return new Date(ts).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  } catch {
    return "";
  }
}

export function SyncStatusPanel() {
  const { t } = useI18n();
  const [status, setStatus] = useState<ClientStateSyncStatus | null>(null);
  const [tombstones, setTombstones] = useState<LocalTombstone[]>([]);
  const [expanded, setExpanded] = useState(false);

  const refresh = useCallback(() => {
    setStatus(getClientStateSyncStatus());
    setTombstones(listLocalTombstones());
  }, []);

  useEffect(() => {
    refresh();
    const timer = window.setInterval(refresh, 5000);
    const onSyncChange = () => window.setTimeout(refresh, 200);
    window.addEventListener(SYNC_ENABLED_EVENT, onSyncChange as EventListener);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener(SYNC_ENABLED_EVENT, onSyncChange as EventListener);
    };
  }, [refresh]);

  const pending = tombstones.filter((tombstone) => !tombstone.ackedAt);
  const resolved = tombstones.filter((tombstone) => tombstone.ackedAt);

  const statusRow = (label: string, value: string) => (
    <div key={label} style={{ display: "flex", justifyContent: "space-between", gap: 8, fontSize: 12 }}>
      <span style={{ color: "var(--text-muted)" }}>{label}</span>
      <span style={{ color: "var(--text)", fontFamily: "var(--font-mono, monospace)", fontSize: 11 }}>{value}</span>
    </div>
  );

  return (
    <div
      style={{
        width: "100%",
        border: "1px solid var(--border)",
        borderRadius: "var(--radius-control, 8px)",
        padding: "10px 12px",
        display: "flex",
        flexDirection: "column",
        gap: 8,
        background: "transparent",
      }}
    >
      <button
        type="button"
        onClick={() => setExpanded((prev) => !prev)}
        aria-expanded={expanded}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          background: "transparent",
          border: "none",
          padding: 0,
          cursor: "pointer",
          color: "var(--text)",
          fontSize: 12.5,
          fontWeight: 600,
        }}
      >
        {expanded ? <ChevronDown size={14} strokeWidth={1.8} aria-hidden="true" /> : <ChevronRight size={14} strokeWidth={1.8} aria-hidden="true" />}
        {t("sync.statusTitle")}
        {!status?.active && (
          <span style={{ color: "var(--text-muted)", fontWeight: 400, fontSize: 11 }}>{t("sync.inactiveShort")}</span>
        )}
      </button>

      {status && (
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          {statusRow(t("sync.device"), shortDeviceId(status.deviceId))}
          {statusRow(t("sync.lastPull"), status.lastPullAt ? clockTime(status.lastPullAt) : t("sync.never"))}
          {statusRow(t("sync.lastPush"), status.lastPushAt ? clockTime(status.lastPushAt) : t("sync.never"))}
          {statusRow(t("sync.conflicts"), String(status.conflicts))}
          {statusRow(t("sync.pendingDeletes"), String(pending.length))}
        </div>
      )}

      {expanded && (
        <div style={{ display: "flex", flexDirection: "column", gap: 6, borderTop: "1px solid var(--border)", paddingTop: 8 }}>
          <p style={{ margin: 0, fontSize: 11, color: "var(--text-muted)", lineHeight: 1.5 }}>{t("sync.tombstoneHint")}</p>
          {pending.length === 0 && resolved.length === 0 && (
            <p style={{ margin: 0, fontSize: 12, color: "var(--text-muted)" }}>{t("sync.tombstonesNone")}</p>
          )}
          {[...pending, ...resolved].slice(0, 8).map((tombstone) => {
            const kind = tombstoneKind(tombstone.serverKey);
            const kindLabel = kind === "bookmark"
              ? t("sync.itemBookmark")
              : kind === "prompt"
                ? t("sync.itemPrompt")
                : kind === "workspace"
                  ? t("sync.itemWorkspace")
                  : t("sync.itemPrefs");
            return (
              <div key={`${tombstone.serverKey}::${tombstone.itemId}`} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12 }}>
                <span
                  style={{
                    flexShrink: 0,
                    fontSize: 10,
                    padding: "1px 6px",
                    borderRadius: 999,
                    border: "1px solid var(--border)",
                    color: "var(--text-muted)",
                  }}
                >
                  {kindLabel}
                </span>
                <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={tombstone.itemId}>
                  {tombstoneItemLabel(tombstone)}
                </span>
                <span style={{ flexShrink: 0, fontSize: 10, color: tombstone.ackedAt ? "var(--text-muted)" : "var(--warning, #b45309)" }}>
                  {tombstone.ackedAt ? t("sync.tombstoneSynced") : t("sync.tombstonePending")}
                </span>
                {kind === "bookmark" && (
                  <button
                    type="button"
                    aria-label={t("sync.restore")}
                    title={t("sync.restore")}
                    onClick={() => {
                      if (restoreTombstonedBookmark(tombstone)) {
                        toast.success(t("sync.restoreDone"));
                      } else {
                        toast.error(t("sync.restoreFailed"));
                      }
                      refresh();
                    }}
                    style={{
                      flexShrink: 0,
                      display: "inline-flex",
                      alignItems: "center",
                      gap: 4,
                      padding: "3px 8px",
                      border: "1px solid var(--border)",
                      borderRadius: "var(--radius-control, 8px)",
                      background: "transparent",
                      color: "var(--text)",
                      cursor: "pointer",
                      fontSize: 11,
                    }}
                  >
                    <RotateCcw size={11} strokeWidth={1.8} aria-hidden="true" />
                    {t("sync.restore")}
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
