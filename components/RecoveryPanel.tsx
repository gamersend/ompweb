"use client";

// ============================================================================
// Recovery panel (Phase P9 / R3-07): the runs board's session-recovery
// section, rendered below the runs grid.
//
// Fetches the read-only /api/recovery read model on mount + via the manual
// Refresh button (recovery is user-invoked — never polled). Shows two finding
// kinds: running-stale sessions (a live omp child with no frame traffic for
// ≥ 10 min — the run looks frozen) and orphans (recently-modified sessions
// whose omp process is gone). Open reuses the board's onOpenSession;
// Interrupt reuses the board's existing abort path via the onInterrupt prop.
// A per-browser dismiss (localStorage, bounded to 100 ids) hides a row.
// Collapsed by default; the header carries a count badge when findings exist.
// ============================================================================

import { useCallback, useEffect, useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  CircleStop,
  History,
  Play,
  RefreshCw,
  X,
} from "lucide-react";
import { useI18n } from "@/lib/i18n";

interface RecoveryRunningRow {
  sessionId: string;
  cwd: string;
  status: "running" | "stale" | "idle" | "unresponsive-unknown";
  detail?: string;
  lastActivityAgeMs: number | null;
}

interface RecoveryOrphanRow {
  sessionId: string;
  cwd?: string;
  modifiedAgeMs: number;
}

interface RecoveryData {
  running: RecoveryRunningRow[];
  orphans: RecoveryOrphanRow[];
  truncated?: boolean;
  generatedAt: string;
}

const DISMISS_KEY = "omp-web:dismissed-recovery";
const MAX_DISMISSED = 100;

function loadDismissed(): Set<string> {
  try {
    const raw = localStorage.getItem(DISMISS_KEY);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return new Set();
    return new Set(
      parsed.filter((id): id is string => typeof id === "string" && id.length > 0),
    );
  } catch {
    return new Set();
  }
}

function saveDismissed(ids: Set<string>): void {
  try {
    localStorage.setItem(DISMISS_KEY, JSON.stringify([...ids].slice(-MAX_DISMISSED)));
  } catch {
    // storage failures are silent — dismissing must never break the board
  }
}

/** Compact mono age like `42s` / `12m` / `3h` — unit-suffixed numbers, no
 *  locale grammar needed. */
function formatAgeMs(ageMs: number | null): string | null {
  if (ageMs === null || !Number.isFinite(ageMs)) return null;
  const seconds = Math.floor(ageMs / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

const SMALL_BUTTON: React.CSSProperties = {
  display: "inline-flex", alignItems: "center", gap: 5, flexShrink: 0,
  padding: "3px 10px", border: "1px solid var(--border)",
  borderRadius: "var(--radius-control)", background: "transparent",
  fontSize: 12, cursor: "pointer",
};

function RecoveryRow({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        display: "flex", alignItems: "center", gap: 8, fontSize: 11.5,
        flexWrap: "wrap", padding: "5px 8px", borderRadius: "var(--radius-control)",
        background: "var(--bg-subtle)", minWidth: 0,
      }}
    >
      {children}
    </div>
  );
}

export function RecoveryPanel({
  onOpenSession,
  onInterrupt,
}: {
  onOpenSession: (sessionId: string) => void;
  /** The board's existing abort path — when absent, stale rows show Open only. */
  onInterrupt?: (sessionId: string) => Promise<void> | void;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  const [data, setData] = useState<RecoveryData | null>(null);
  const [dismissed, setDismissed] = useState<Set<string>>(() => new Set());
  const [interruptBusy, setInterruptBusy] = useState(false);

  // localStorage is browser-only — hydrate after mount.
  useEffect(() => {
    setDismissed(loadDismissed());
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/recovery", { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = await res.json() as { success?: boolean; data?: RecoveryData } | null;
      if (body?.success && body.data) {
        setData(body.data);
        setLoadFailed(false);
      }
    } catch {
      // Keep the last successful read; only surface the failure when we
      // never got one.
      setLoadFailed(true);
    } finally {
      setLoading(false);
    }
  }, []);

  // Fetch on mount only — no polling loop (recovery is user-invoked).
  useEffect(() => {
    void load();
  }, [load]);

  const dismiss = useCallback((sessionId: string) => {
    setDismissed((prev) => {
      const next = new Set(prev);
      next.delete(sessionId);
      next.add(sessionId);
      // Bounded: evict the oldest (first-inserted) ids beyond the cap.
      while (next.size > MAX_DISMISSED) {
        const oldest = next.values().next();
        if (oldest.done) break;
        next.delete(oldest.value);
      }
      saveDismissed(next);
      return next;
    });
  }, []);

  const staleRuns = (data?.running ?? []).filter(
    (row) => row.status === "stale" && !dismissed.has(row.sessionId),
  );
  const orphans = (data?.orphans ?? []).filter((row) => !dismissed.has(row.sessionId));
  const findingCount = staleRuns.length + orphans.length;

  const handleInterrupt = useCallback((sessionId: string) => {
    if (!onInterrupt || interruptBusy) return;
    setInterruptBusy(true);
    void Promise.resolve(onInterrupt(sessionId)).finally(() => setInterruptBusy(false));
  }, [onInterrupt, interruptBusy]);

  return (
    <section aria-label={t("recovery.title")} style={{ flexShrink: 0 }}>
      {/* Header row: chevron + title + (count badge) + refresh */}
      <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 16px", flexWrap: "wrap", minWidth: 0 }}>
        <button
          type="button"
          onClick={() => setOpen((value) => !value)}
          aria-expanded={open}
          className="ui-focus-ring"
          style={{
            display: "inline-flex", alignItems: "center", gap: 6,
            border: "none", background: "none", padding: 0, cursor: "pointer",
            fontSize: 12, fontWeight: 600, color: "var(--text-muted)", minWidth: 0,
          }}
        >
          {open
            ? <ChevronDown size={14} strokeWidth={2} aria-hidden="true" style={{ flexShrink: 0 }} />
            : <ChevronRight size={14} strokeWidth={2} aria-hidden="true" style={{ flexShrink: 0 }} />}
          <History size={13} strokeWidth={1.8} aria-hidden="true" style={{ flexShrink: 0 }} />
          <span>{t("recovery.title")}</span>
          {findingCount > 0 && (
            <span
              aria-label={t("recovery.findings", { count: findingCount })}
              style={{
                fontSize: 10, padding: "1px 7px", borderRadius: 999, flexShrink: 0,
                border: "1px solid var(--border)", background: "var(--bg-selected)",
                color: "var(--accent-strong)", fontWeight: 600,
              }}
            >
              {findingCount}
            </span>
          )}
        </button>
        <span style={{ flex: 1 }} />
        <button
          type="button"
          onClick={() => void load()}
          disabled={loading}
          className="ui-focus-ring"
          aria-label={t("recovery.refresh")}
          title={t("recovery.refresh")}
          style={{
            display: "inline-flex", alignItems: "center", justifyContent: "center",
            width: 24, height: 24, padding: 0, flexShrink: 0,
            border: "1px solid var(--border)", borderRadius: "var(--radius-control)",
            background: "transparent", color: "var(--text-muted)",
            cursor: loading ? "default" : "pointer", opacity: loading ? 0.5 : 1,
          }}
        >
          <RefreshCw size={12} strokeWidth={1.8} aria-hidden="true" />
        </button>
      </div>

      {/* Body: only while expanded */}
      {open && (
        <div style={{ display: "flex", flexDirection: "column", gap: 4, padding: "0 16px 8px", maxWidth: 760 }}>
          {loadFailed && data === null && (
            <div style={{ fontSize: 12, color: "var(--text-muted)" }}>{t("recovery.loadFailed")}</div>
          )}

          {data?.truncated && (
            <div style={{ fontSize: 11, color: "var(--text-dim)" }}>{t("recovery.truncated")}</div>
          )}

          {staleRuns.map((row) => (
            <RecoveryRow key={`stale-${row.sessionId}`}>
              <span
                aria-hidden="true"
                style={{ width: 7, height: 7, borderRadius: 999, background: "var(--accent-strong)", flexShrink: 0 }}
              />
              <span style={{ fontFamily: "var(--font-mono)", color: "var(--text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0, maxWidth: 160 }} title={row.sessionId}>
                {row.sessionId.slice(0, 8)}
              </span>
              <span style={{
                fontSize: 10, padding: "1px 7px", borderRadius: 999, flexShrink: 0,
                border: "1px solid var(--border)", background: "var(--bg)",
                color: "var(--accent-strong)",
              }}>
                {t("recovery.statusStale")}
              </span>
              {row.lastActivityAgeMs !== null && (
                <span style={{ fontFamily: "var(--font-mono)", color: "var(--text-muted)", flexShrink: 0 }}>
                  {formatAgeMs(row.lastActivityAgeMs)}
                </span>
              )}
              {row.detail && (
                <span style={{ color: "var(--text-muted)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0, flex: 1 }} title={row.detail}>
                  {row.detail}
                </span>
              )}
              <span style={{ flex: row.detail ? 0 : 1 }} />
              <button
                type="button"
                onClick={() => onOpenSession(row.sessionId)}
                className="ui-focus-ring"
                style={{ ...SMALL_BUTTON, color: "var(--text)" }}
              >
                <Play size={11} strokeWidth={2} aria-hidden="true" />
                {t("recovery.open")}
              </button>
              {onInterrupt && (
                <button
                  type="button"
                  onClick={() => handleInterrupt(row.sessionId)}
                  disabled={interruptBusy}
                  className="ui-focus-ring"
                  style={{ ...SMALL_BUTTON, color: "var(--accent-strong)", opacity: interruptBusy ? 0.5 : 1, cursor: interruptBusy ? "default" : "pointer" }}
                >
                  <CircleStop size={11} strokeWidth={2} aria-hidden="true" />
                  {t("recovery.interrupt")}
                </button>
              )}
              <button
                type="button"
                onClick={() => dismiss(row.sessionId)}
                className="ui-focus-ring"
                aria-label={t("recovery.dismiss")}
                title={t("recovery.dismiss")}
                style={{
                  display: "inline-flex", alignItems: "center", justifyContent: "center",
                  width: 20, height: 20, padding: 0, flexShrink: 0,
                  border: "none", background: "none", color: "var(--text-dim)", cursor: "pointer",
                }}
              >
                <X size={12} strokeWidth={2} aria-hidden="true" />
              </button>
            </RecoveryRow>
          ))}

          {orphans.map((row) => (
            <RecoveryRow key={`orphan-${row.sessionId}`}>
              <span
                aria-hidden="true"
                style={{ width: 7, height: 7, borderRadius: 999, background: "var(--text-dim)", flexShrink: 0 }}
              />
              <span style={{ fontFamily: "var(--font-mono)", color: "var(--text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0, maxWidth: 160 }} title={row.sessionId}>
                {row.sessionId.slice(0, 8)}
              </span>
              <span style={{
                fontSize: 10, padding: "1px 7px", borderRadius: 999, flexShrink: 0,
                border: "1px solid var(--border)", background: "var(--bg)",
                color: "var(--text-muted)",
              }}>
                {t("recovery.statusOrphan")}
              </span>
              <span style={{ fontFamily: "var(--font-mono)", color: "var(--text-muted)", flexShrink: 0 }}>
                {formatAgeMs(row.modifiedAgeMs)}
              </span>
              {row.cwd && (
                <span style={{ color: "var(--text-dim)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0, flex: 1 }} title={row.cwd}>
                  {row.cwd}
                </span>
              )}
              <span style={{ flex: row.cwd ? 0 : 1 }} />
              <button
                type="button"
                onClick={() => onOpenSession(row.sessionId)}
                className="ui-focus-ring"
                style={{ ...SMALL_BUTTON, color: "var(--text)" }}
              >
                <Play size={11} strokeWidth={2} aria-hidden="true" />
                {t("recovery.open")}
              </button>
              <button
                type="button"
                onClick={() => dismiss(row.sessionId)}
                className="ui-focus-ring"
                aria-label={t("recovery.dismiss")}
                title={t("recovery.dismiss")}
                style={{
                  display: "inline-flex", alignItems: "center", justifyContent: "center",
                  width: 20, height: 20, padding: 0, flexShrink: 0,
                  border: "none", background: "none", color: "var(--text-dim)", cursor: "pointer",
                }}
              >
                <X size={12} strokeWidth={2} aria-hidden="true" />
              </button>
            </RecoveryRow>
          ))}

          {findingCount === 0 && !loadFailed && (
            <div style={{ fontSize: 12, color: "var(--text-muted)" }}>{t("recovery.empty")}</div>
          )}
        </div>
      )}
    </section>
  );
}
