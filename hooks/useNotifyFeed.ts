"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { isInQuietHours, type NotifyKind, type NotifyRow } from "@/lib/notify/notify-shared";
import { translate } from "@/lib/i18n";

// ============================================================================
// Client view of the server notification feed (BUILD-PLAN Phase 2):
// - 20 s poll while the tab is visible, plus refreshes on `online` and on
//   visibilitychange back to visible (same discipline as useAgentSession).
// - `new Notification` only for NEW rows while the tab is hidden, only when
//   the browser toggle is on, permission is granted, and outside quiet hours
//   (quiet hours suppress the browser ping only — feed + webhook still record).
// - Notification permission is requested ONLY from the settings toggle gesture
//   (requestBrowserPermission) — never on load, mirroring the useAudio
//   unlock discipline.
// ============================================================================

export const NOTIFY_POLL_INTERVAL_MS = 20_000;
export const NOTIFY_LAST_READ_STORAGE_KEY = "omp-web:notify-last-read";

/** Masked webhook view returned by GET/PUT — the URL itself never leaves the
 * server (it is a credential). */
export interface MaskedNotifyWebhook {
  enabled: boolean;
  provider: "ntfy" | "discord" | "telegram" | "generic";
  events: NotifyKind[];
  configured: boolean;
  host: string | null;
  url: "";
}

export interface NotifyFeedConfigView {
  version: 1;
  browser: boolean;
  webhook: MaskedNotifyWebhook;
  /** Web Push section (wave 2 P2): kinds + enabled only. Keys/subscriptions
   * live behind /api/push/* and never ride this payload. */
  push?: { enabled: boolean; events: NotifyKind[] };
  quietHours?: { from: string; to: string };
}

export type BrowserPermission = "default" | "granted" | "denied" | "unsupported";

/** Unread = rows newer than the stored last-read id (bell badge). A cursor
 * that no longer exists in the feed (pruned server-side) counts nothing. */
export function computeUnreadCount(rows: readonly NotifyRow[], lastReadId: string | null): number {
  if (!lastReadId) return rows.length;
  const index = rows.findIndex((row) => row.id === lastReadId);
  return index === -1 ? 0 : index;
}

export interface BrowserNotificationGate {
  browserEnabled: boolean;
  permission: BrowserPermission;
  hidden: boolean;
  quietHours: boolean;
}

/** All four conditions must hold for the OS-level ping. */
export function shouldFireBrowserNotification(gate: BrowserNotificationGate): boolean {
  return gate.browserEnabled && gate.permission === "granted" && gate.hidden && !gate.quietHours;
}

/** Localized copy for a row; falls back to the server strings for kinds the
 * dictionary does not cover (e.g. future guardrail/scheduler rows). */
export function rowNotificationCopy(row: NotifyRow): { title: string; body: string } {
  const key = `notify.rowTitle.${row.kind}`;
  const translated = translate(key, { title: row.sessionTitle });
  return {
    title: translated === key ? row.title : translated,
    body: row.body,
  };
}

function readLastReadId(): string | null {
  try {
    return window.localStorage.getItem(NOTIFY_LAST_READ_STORAGE_KEY);
  } catch {
    return null;
  }
}

function currentPermission(): BrowserPermission {
  if (typeof window === "undefined" || !("Notification" in window)) return "unsupported";
  return Notification.permission as BrowserPermission;
}

/** Stand-in before the first fetch answers (notifications off, no quiet hours). */
const EMPTY_CONFIG_VIEW: NotifyFeedConfigView = {
  version: 1,
  browser: false,
  webhook: { enabled: false, provider: "generic", events: [], configured: false, host: null, url: "" },
};

export interface NotifyConfigUpdate {
  browser?: boolean;
  webhook?: {
    enabled?: boolean;
    provider?: MaskedNotifyWebhook["provider"];
    url?: string;
    events?: NotifyKind[];
  };
  push?: {
    enabled?: boolean;
    events?: NotifyKind[];
  };
  quietHours?: { from: string; to: string } | null;
}

export interface UseNotifyFeedOptions {
  /** Called when the user activates a browser notification. */
  onOpenSession?: (sessionId: string) => void;
}

export function useNotifyFeed(options: UseNotifyFeedOptions = {}) {
  const [rows, setRows] = useState<NotifyRow[]>([]);
  const [config, setConfig] = useState<NotifyFeedConfigView | null>(null);
  const [browserPermission, setBrowserPermission] = useState<BrowserPermission>("default");
  const [webhookDeliveries, setWebhookDeliveries] = useState<{ sent: number; failed: number }>({ sent: 0, failed: 0 });
  const [lastReadId, setLastReadId] = useState<string | null>(null);
  const [lastError, setLastError] = useState<string | null>(null);

  const newestRowRef = useRef<NotifyRow | null>(null);
  const seenIdsRef = useRef<Set<string>>(new Set());
  /** False until the first fetch answered: history hydration never pings. */
  const hydratedRef = useRef(false);
  const configRef = useRef<NotifyFeedConfigView | null>(null);
  const onOpenSessionRef = useRef(options.onOpenSession);
  useEffect(() => {
    onOpenSessionRef.current = options.onOpenSession;
  }, [options.onOpenSession]);
  useEffect(() => {
    configRef.current = config;
  }, [config]);

  useEffect(() => {
    setLastReadId(readLastReadId());
    setBrowserPermission(currentPermission());
  }, []);

  /** Show the OS notification for one row (gate already checked). */
  const showBrowserNotification = useCallback((row: NotifyRow) => {
    try {
      const copy = rowNotificationCopy(row);
      const notification = new Notification(copy.title, { body: copy.body, tag: row.id });
      notification.onclick = () => {
        notification.close();
        window.focus();
        if (row.sessionId) onOpenSessionRef.current?.(row.sessionId);
      };
    } catch {
      // The Notification constructor can throw on some platforms; the row
      // stays visible in the bell regardless.
      return;
    }
    // Fire-and-forget bookkeeping: the row's `delivered` flag is server-side
    // proof the browser ping went out.
    void fetch("/api/notify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "delivered", ids: [row.id] }),
    }).catch(() => {});
  }, []);

  const ingest = useCallback((incoming: readonly NotifyRow[], configOverride?: NotifyFeedConfigView | null) => {
    // Apply the config that arrived with this batch so the notification gate
    // below never judges new rows by the previous poll's settings.
    if (configOverride !== undefined) configRef.current = configOverride;
    const fresh: NotifyRow[] = [];
    for (const row of incoming) {
      if (seenIdsRef.current.has(row.id)) continue;
      seenIdsRef.current.add(row.id);
      fresh.push(row);
      if (!newestRowRef.current || row.ts > newestRowRef.current.ts) newestRowRef.current = row;
    }
    if (fresh.length === 0) return;
    setRows((previous) => {
      const byId = new Map(previous.map((row) => [row.id, row] as const));
      for (const row of fresh) byId.set(row.id, row);
      return [...byId.values()].sort((a, b) => b.ts.localeCompare(a.ts));
    });
    // The first fetch after mount hydrates the bell with feed history — those
    // rows are old news, never OS pings. Only genuinely new rows arriving on
    // later polls notify.
    const hydrating = !hydratedRef.current;
    hydratedRef.current = true;
    if (hydrating) return;
    // OS ping for brand-new rows only, gated on toggle + permission + hidden
    // + quiet hours (a visible tab shows the bell itself — never a popup).
    const gate: BrowserNotificationGate = {
      browserEnabled: configRef.current?.browser === true,
      permission: currentPermission(),
      hidden: typeof document !== "undefined" && document.visibilityState === "hidden",
      quietHours: isInQuietHours(configRef.current ?? EMPTY_CONFIG_VIEW),
    };
    if (shouldFireBrowserNotification(gate)) {
      for (const row of fresh) showBrowserNotification(row);
    }
  }, [showBrowserNotification]);

  const fetchFeed = useCallback(async (sinceId?: string | null) => {
    try {
      const cursor = sinceId !== undefined ? sinceId : newestRowRef.current?.id ?? null;
      const response = await fetch(`/api/notify${cursor ? `?since=${encodeURIComponent(cursor)}` : ""}`, { cache: "no-store" });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const payload = await response.json() as { success?: boolean; data?: { rows?: NotifyRow[]; config?: NotifyFeedConfigView; webhookDeliveries?: { sent: number; failed: number } } } | null;
      const data = payload?.data;
      if (!data) throw new Error("Malformed notify response");
      setConfig(data.config ?? null);
      if (data.webhookDeliveries) setWebhookDeliveries(data.webhookDeliveries);
      if (data.rows?.length) ingest(data.rows, data.config ?? null);
      setLastError(null);
    } catch (error) {
      setLastError(error instanceof Error ? error.message : String(error));
    }
  }, [ingest]);

  // Initial fetch + 20 s poll (visible tabs only) + online/visibility refresh.
  useEffect(() => {
    let disposed = false;
    const tick = () => {
      if (disposed || document.visibilityState !== "visible") return;
      void fetchFeed();
    };
    tick();
    const interval = setInterval(tick, NOTIFY_POLL_INTERVAL_MS);
    const onVisible = () => {
      if (document.visibilityState === "visible") tick();
    };
    const onOnline = () => tick();
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("online", onOnline);
    return () => {
      disposed = true;
      clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("online", onOnline);
    };
  }, [fetchFeed]);

  const refresh = useCallback(() => fetchFeed(), [fetchFeed]);

  const markAllRead = useCallback(() => {
    const newest = newestRowRef.current?.id ?? null;
    setLastReadId(newest);
    try {
      if (newest) window.localStorage.setItem(NOTIFY_LAST_READ_STORAGE_KEY, newest);
      else window.localStorage.removeItem(NOTIFY_LAST_READ_STORAGE_KEY);
    } catch {
      // in-memory only for this session
    }
  }, []);

  /** Settings-toggle gesture ONLY: requests OS notification permission. Never
   * called on load or from any passive path. */
  const requestBrowserPermission = useCallback(async (): Promise<BrowserPermission> => {
    if (!("Notification" in window)) return "unsupported";
    try {
      const result = await Notification.requestPermission();
      const permission = (typeof result === "string" ? result : Notification.permission) as BrowserPermission;
      setBrowserPermission(permission);
      return permission;
    } catch {
      setBrowserPermission(currentPermission());
      return currentPermission();
    }
  }, []);

  const saveConfig = useCallback(async (update: NotifyConfigUpdate): Promise<{ ok: boolean; error?: string }> => {
    try {
      const response = await fetch("/api/notify", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(update),
      });
      const payload = await response.json().catch(() => null) as { success?: boolean; error?: string } | null;
      if (!response.ok || !payload?.success) {
        return { ok: false, error: payload?.error ?? `HTTP ${response.status}` };
      }
      await fetchFeed(null);
      return { ok: true };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }, [fetchFeed]);

  const sendTestNotification = useCallback(async (): Promise<{ ok: boolean; error?: string }> => {
    try {
      const response = await fetch("/api/notify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "seed-test-row" }),
      });
      const payload = await response.json().catch(() => null) as { success?: boolean; error?: string } | null;
      if (!response.ok || !payload?.success) return { ok: false, error: payload?.error ?? `HTTP ${response.status}` };
      await fetchFeed(null);
      return { ok: true };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }, [fetchFeed]);

  const unreadCount = computeUnreadCount(rows, lastReadId);

  return {
    rows,
    config,
    unreadCount,
    browserPermission,
    webhookDeliveries,
    lastError,
    refresh,
    markAllRead,
    requestBrowserPermission,
    saveConfig,
    sendTestNotification,
  };
}
