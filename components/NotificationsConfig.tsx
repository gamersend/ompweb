"use client";

import { useCallback, useEffect, useState } from "react";
import { BellRing, CalendarClock, FlaskConical, Send, X } from "lucide-react";
import { toast } from "./ui/toast";
import { useI18n } from "@/lib/i18n";
import { useNotifyFeed } from "@/hooks/useNotifyFeed";
import { projectLabel } from "./AppShell-layout";
import type { NotifyKind } from "@/lib/notify/notify-shared";
import {
  decodeBase64UrlToUint8Array,
  detectPushCapability,
  isIOSUserAgent,
  isStandaloneDisplay,
  type PushCapability,
} from "@/lib/push/client";

// ============================================================================
// Settings → Notifications tab section (BUILD-PLAN Phase 2):
// - Browser toggle + permission state. Requesting permission happens ONLY
//   inside this toggle's onChange (a user gesture) — never on load.
// - Quiet hours (browser-only suppression; feed + webhook still record).
// - Webhook: provider/URL/events; the stored URL is a credential and is never
//   displayed — only "configured + host"; a test button exercises delivery.
// - Feed preview + delivery counters.
// ============================================================================

const ALL_EVENTS: NotifyKind[] = ["agent_end", "approval", "error", "guardrail", "scheduler", "delegation", "digest"];
const PROVIDERS = ["ntfy", "discord", "telegram", "generic"] as const;
/** Chip order Monday-first (matches the default Mon 08:00 digest slot). */
const DIGEST_DAYS = [1, 2, 3, 4, 5, 6, 0];

const selectStyle = {
  minHeight: 32,
  padding: "4px 28px 4px 10px",
  border: "1px solid var(--border)",
  borderRadius: "var(--radius-control)",
  background: "var(--bg)",
  color: "var(--text)",
  fontSize: 12,
  cursor: "pointer",
  appearance: "none" as const,
  colorScheme: "dark light",
} as const;

const inputStyle = {
  flex: 1,
  minWidth: 160,
  padding: "6px 10px",
  border: "1px solid var(--border)",
  borderRadius: "var(--radius-control)",
  background: "var(--bg)",
  color: "var(--text)",
  fontSize: 12,
  outline: "none",
  colorScheme: "dark light",
} as const;

function ToggleRow({ id, checked, disabled, label, description, onChange }: {
  id: string;
  checked: boolean;
  disabled?: boolean;
  label: string;
  description: string;
  onChange: (checked: boolean) => void;
}) {
  return (
    <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12, padding: "10px 12px", border: "1px solid var(--border)", borderRadius: "var(--radius-control)", background: "var(--bg)" }}>
      <div style={{ minWidth: 0 }}>
        <div style={{ fontSize: 12, fontWeight: 500 }}>{label}</div>
        <div style={{ marginTop: 2, fontSize: 11, color: "var(--text-muted)", lineHeight: 1.45 }}>{description}</div>
      </div>
      <button
        type="button"
        role="switch"
        id={id}
        aria-checked={checked}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        style={{
          flexShrink: 0,
          width: 34,
          height: 20,
          borderRadius: 999,
          border: "1px solid var(--border)",
          background: checked ? "var(--accent-strong)" : "var(--bg-subtle)",
          position: "relative",
          cursor: disabled ? "wait" : "pointer",
          transition: "background var(--dur-fast) var(--ease-out-warm)",
        }}
      >
        <span
          aria-hidden="true"
          style={{
            position: "absolute",
            top: 2,
            left: checked ? 16 : 2,
            width: 14,
            height: 14,
            borderRadius: "50%",
            background: checked ? "var(--on-accent)" : "var(--text-dim)",
            transition: "left var(--dur-fast) var(--ease-out-warm)",
          }}
        />
      </button>
    </div>
  );
}

export function NotificationsConfig() {
  const { t } = useI18n();
  const feed = useNotifyFeed();
  const [urlDraft, setUrlDraft] = useState("");
  const [quietFrom, setQuietFrom] = useState("");
  const [quietTo, setQuietTo] = useState("");
  const [testBusy, setTestBusy] = useState(false);
  // Weekly digest (wave 2 P10): drafts stay null/empty until the user edits;
  // the applied values fall back to the stored config (default Mon 08:00).
  const [digestDayDraft, setDigestDayDraft] = useState<number | null>(null);
  const [digestTimeDraft, setDigestTimeDraft] = useState("");
  const [digestNowBusy, setDigestNowBusy] = useState(false);
  // Web Push (wave 2 P2): capability ladder + this-device subscription state.
  const [pushCapability, setPushCapability] = useState<PushCapability | null>(null);
  const [pushCount, setPushCount] = useState<number | null>(null);
  const [pushSubscribed, setPushSubscribed] = useState(false);
  const [pushBusy, setPushBusy] = useState(false);
  const [pushTestBusy, setPushTestBusy] = useState(false);

  const config = feed.config;

  const refreshPushState = useCallback(async () => {
    try {
      const response = await fetch("/api/push/status", { cache: "no-store" });
      const payload = await response.json().catch(() => null) as { success?: boolean; data?: { subscriptionCount?: number } } | null;
      if (payload?.success && payload.data) setPushCount(payload.data.subscriptionCount ?? 0);
    } catch {
      // status stays unknown; the toggle still works off the local subscription
    }
    try {
      const registration = await navigator.serviceWorker.getRegistration();
      const subscription = await registration?.pushManager.getSubscription();
      setPushSubscribed(!!subscription);
    } catch {
      setPushSubscribed(false);
    }
  }, []);

  // Capability detection on mount only (browser APIs, never during SSR).
  useEffect(() => {
    const capability = detectPushCapability({
      hasServiceWorker: "serviceWorker" in navigator,
      hasPushManager: "PushManager" in window,
      isIOS: isIOSUserAgent(navigator.userAgent, navigator.maxTouchPoints ?? 0),
      isStandalone: isStandaloneDisplay(
        typeof window.matchMedia === "function" && window.matchMedia("(display-mode: standalone)").matches,
        (navigator as Navigator & { standalone?: boolean }).standalone === true,
      ),
    });
    setPushCapability(capability);
    if (capability.supported) void refreshPushState();
  }, [refreshPushState]);

  const handleBrowserToggle = useCallback(async (next: boolean) => {
    if (next) {
      // Permission request happens HERE, inside the toggle gesture — never on
      // load. Enabling is rejected when the OS denies it.
      const permission = await feed.requestBrowserPermission();
      if (permission !== "granted") {
        toast.error(t(`notifySettings.permission.${permission}`));
        return;
      }
    }
    const result = await feed.saveConfig({ browser: next });
    if (!result.ok) toast.error(t("notifySettings.saveFailed", { detail: result.error ?? "" }));
  }, [feed, t]);

  const handleQuietApply = useCallback(async () => {
    if (!quietFrom || !quietTo) return;
    if (quietFrom === quietTo) {
      toast.error(t("notifySettings.saveFailed", { detail: "from = to" }));
      return;
    }
    const result = await feed.saveConfig({ quietHours: { from: quietFrom, to: quietTo } });
    if (result.ok) {
      setQuietFrom("");
      setQuietTo("");
      toast.success(t("notifySettings.quietSaved"));
    } else {
      toast.error(t("notifySettings.saveFailed", { detail: result.error ?? "" }));
    }
  }, [feed, quietFrom, quietTo, t]);

  const handleQuietClear = useCallback(async () => {
    const result = await feed.saveConfig({ quietHours: null });
    if (!result.ok) toast.error(t("notifySettings.saveFailed", { detail: result.error ?? "" }));
  }, [feed, t]);

  const handleUrlSave = useCallback(async () => {
    const url = urlDraft.trim();
    if (!url) return;
    const result = await feed.saveConfig({ webhook: { url } });
    if (result.ok) {
      setUrlDraft("");
      toast.success(t("notifySettings.urlSaved"));
    } else {
      toast.error(result.error?.includes("insecure") || result.error?.includes("invalid_url")
        ? t("notifySettings.invalidUrl")
        : t("notifySettings.saveFailed", { detail: result.error ?? "" }));
    }
  }, [feed, t, urlDraft]);

  const handleWebhookToggle = useCallback(async (next: boolean) => {
    const result = await feed.saveConfig({ webhook: { enabled: next } });
    if (!result.ok) {
      toast.error(next && result.error?.includes("url_required")
        ? t("notifySettings.testNotConfigured")
        : t("notifySettings.saveFailed", { detail: result.error ?? "" }));
    }
  }, [feed, t]);

  const handleEventToggle = useCallback(async (kind: NotifyKind, next: boolean) => {
    if (!config) return;
    const current = new Set(config.webhook.events);
    if (next) current.add(kind);
    else current.delete(kind);
    if (current.size === 0) return; // server rejects empty sets; keep last state
    const result = await feed.saveConfig({ webhook: { events: [...current] } });
    if (!result.ok) toast.error(t("notifySettings.saveFailed", { detail: result.error ?? "" }));
  }, [config, feed, t]);

  // ── Web Push (wave 2 P2) ──────────────────────────────────────────────────
  // Enable: permission (in-gesture) → subscribe with the server's public VAPID
  // key → register server-side. Disable: unsubscribe + unregister. All steps
  // surface failures as toasts; the row state refreshes from the server.
  const handlePushToggle = useCallback(async (next: boolean) => {
    if (!pushCapability?.supported) return;
    setPushBusy(true);
    try {
      if (next) {
        // Permission must be requested from this gesture, like the browser ping.
        const permission = await feed.requestBrowserPermission();
        if (permission !== "granted") {
          toast.error(t("push.blocked"));
          return;
        }
        const statusResponse = await fetch("/api/push/status", { cache: "no-store" });
        const statusPayload = await statusResponse.json().catch(() => null) as { success?: boolean; data?: { publicKey?: string | null } } | null;
        const publicKey = statusPayload?.data?.publicKey;
        if (!statusPayload?.success || !publicKey) {
          toast.error(t("push.enableFailed", { detail: "no VAPID key" }));
          return;
        }
        const registration = await navigator.serviceWorker.ready;
        const subscription = await registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: decodeBase64UrlToUint8Array(publicKey),
        });
        const response = await fetch("/api/push/register", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ subscription: subscription.toJSON() }),
        });
        const payload = await response.json().catch(() => null) as { success?: boolean; error?: string } | null;
        if (!response.ok || !payload?.success) {
          // Register failed → roll the browser subscription back so local and
          // server state agree.
          await subscription.unsubscribe().catch(() => {});
          toast.error(t("push.enableFailed", { detail: payload?.error ?? `HTTP ${response.status}` }));
          return;
        }
      } else {
        const registration = await navigator.serviceWorker.getRegistration();
        const subscription = await registration?.pushManager.getSubscription();
        if (subscription) {
          const endpoint = subscription.endpoint;
          await subscription.unsubscribe().catch(() => {});
          await fetch("/api/push/unregister", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ endpoint }),
          }).catch(() => {});
        }
      }
      await refreshPushState();
      void feed.refresh();
    } catch (error) {
      toast.error(t("push.enableFailed", { detail: error instanceof Error ? error.message : String(error) }));
    } finally {
      setPushBusy(false);
    }
  }, [feed, pushCapability, refreshPushState, t]);

  const handlePushTest = useCallback(async () => {
    setPushTestBusy(true);
    try {
      const response = await fetch("/api/push/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      const payload = await response.json().catch(() => null) as { success?: boolean; error?: string; data?: { delivered?: number; pruned?: number; subscriptionCount?: number } } | null;
      if (!payload?.success || !payload.data) {
        toast.error(t("push.testFail", { detail: payload?.error ?? `HTTP ${response.status}` }));
        return;
      }
      if ((payload.data.subscriptionCount ?? 0) === 0) {
        toast.info(t("push.testNone"));
        return;
      }
      toast.success(t("push.testOk", { delivered: payload.data.delivered ?? 0, pruned: payload.data.pruned ?? 0 }));
    } finally {
      setPushTestBusy(false);
    }
  }, [t]);

  const handleTest = useCallback(async () => {
    setTestBusy(true);
    try {
      const response = await fetch("/api/notify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "test" }),
      });
      const payload = await response.json().catch(() => null) as { success?: boolean; data?: { ok?: boolean; status?: number; configured?: boolean; error?: string } } | null;
      const data = payload?.data;
      if (!payload?.success || !data) {
        toast.error(t("notifySettings.testFailed", { detail: `HTTP ${response.status}` }));
        return;
      }
      if (!data.configured) {
        toast.info(t("notifySettings.testNotConfigured"));
      } else if (data.ok) {
        toast.success(t("notifySettings.testOk", { status: data.status ?? 200 }));
      } else {
        toast.error(t("notifySettings.testFailed", { detail: data.error ?? "unknown" }));
      }
      void feed.refresh();
    } finally {
      setTestBusy(false);
    }
  }, [feed, t]);

  // ── Weekly digest (wave 2 P10) ────────────────────────────────────────────
  // The enabled toggle and the day/time chips share one PUT; the digest
  // section of the payload is validated independently server-side. "Compose
  // now" is the same gesture as the scheduler's run-now: it publishes a row
  // immediately and never claims this week's scheduled slot.
  const digest = config?.digest;
  const digestDay = digestDayDraft ?? digest?.dayOfWeek ?? 1;
  const digestTime = digestTimeDraft || digest?.time || "08:00";

  const handleDigestToggle = useCallback(async (next: boolean) => {
    const result = await feed.saveConfig({ digest: { enabled: next } });
    if (!result.ok) toast.error(t("notifySettings.saveFailed", { detail: result.error ?? "" }));
  }, [feed, t]);

  const handleDigestScheduleApply = useCallback(async () => {
    const result = await feed.saveConfig({ digest: { dayOfWeek: digestDay, time: digestTime } });
    if (result.ok) {
      setDigestTimeDraft("");
      toast.success(t("digest.scheduleSaved"));
    } else {
      toast.error(t("notifySettings.saveFailed", { detail: result.error ?? "" }));
    }
  }, [digestDay, digestTime, feed, t]);

  const handleDigestNow = useCallback(async () => {
    setDigestNowBusy(true);
    try {
      const response = await fetch("/api/notify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "digest-now" }),
      });
      const payload = await response.json().catch(() => null) as { success?: boolean; data?: { outcome?: string } | null } | null;
      if (!response.ok || !payload?.success) {
        toast.error(t("digest.sendFailed"));
        return;
      }
      toast.success(t("digest.sentToast"));
      void feed.refresh();
    } finally {
      setDigestNowBusy(false);
    }
  }, [feed, t]);

  const webhook = config?.webhook;
  const events = new Set(webhook?.events ?? []);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <div style={{ marginBottom: 4 }}>
        <h2 className="display-serif" style={{ fontSize: 22, fontWeight: 600, margin: 0, color: "var(--text)", letterSpacing: "-0.01em" }}>{t("notifySettings.title")}</h2>
        <p className="settings-content-subtitle" style={{ margin: "4px 0 0", fontSize: 13, color: "var(--text-muted)", lineHeight: 1.45 }}>{t("notifySettings.desc")}</p>
      </div>

      {/* Browser notifications */}
      <section style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <ToggleRow
          id="notify-browser-toggle"
          checked={config?.browser === true}
          label={t("notifySettings.browser")}
          description={t("notifySettings.browserDesc")}
          onChange={(next) => void handleBrowserToggle(next)}
        />
        <div aria-live="polite" style={{ fontSize: 11, color: "var(--text-dim)", paddingLeft: 12 }}>
          {t(`notifySettings.permission.${feed.browserPermission}`)}
        </div>
      </section>

      {/* Web Push (wave 2 P2): OS push while no tab is open. Capability is
          detected first — unsupported browsers and non-installed iOS Safari
          get an explanation instead of a dead toggle. */}
      <section style={{ display: "flex", flexDirection: "column", gap: 10, padding: 12, border: "1px solid var(--border)", borderRadius: "var(--radius-card)", background: "var(--bg-panel)" }}>
        <div>
          <div style={{ fontSize: 13, fontWeight: 600 }}>{t("push.title")}</div>
          <div style={{ marginTop: 2, fontSize: 11, color: "var(--text-muted)", lineHeight: 1.45 }}>{t("push.desc")}</div>
        </div>
        <ToggleRow
          id="notify-push-toggle"
          checked={pushSubscribed}
          disabled={!pushCapability?.supported || pushBusy}
          label={pushSubscribed ? t("push.disable") : t("push.enable")}
          description={
            pushCapability === null ? ""
              : !pushCapability.supported
                ? (pushCapability.reason === "ios-needs-install" ? t("push.unsupported.ios") : t("push.unsupported"))
                : feed.browserPermission === "denied"
                  ? t("push.blocked")
                  : t("push.count", { count: pushCount ?? 0 })
          }
          onChange={(next) => void handlePushToggle(next)}
        />
        <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
          <button
            type="button"
            onClick={() => void handlePushTest()}
            disabled={!pushCapability?.supported || pushTestBusy}
            style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "6px 10px", border: "1px solid var(--border)", borderRadius: "var(--radius-control)", background: "var(--bg-subtle)", color: "var(--text)", cursor: pushCapability?.supported && !pushTestBusy ? "pointer" : "not-allowed", fontSize: 12 }}
          >
            <BellRing size={12} aria-hidden="true" /> {t("push.test")}
          </button>
        </div>
      </section>

      {/* Quiet hours */}
      <section style={{ display: "flex", flexDirection: "column", gap: 8, padding: 12, border: "1px solid var(--border)", borderRadius: "var(--radius-card)", background: "var(--bg-panel)" }}>
        <div>
          <div style={{ fontSize: 13, fontWeight: 600 }}>{t("notifySettings.quietHours")}</div>
          <div style={{ marginTop: 2, fontSize: 11, color: "var(--text-muted)", lineHeight: 1.45 }}>{t("notifySettings.quietHoursDesc")}</div>
        </div>
        {config?.quietHours ? (
          <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12, color: "var(--text)" }}>
            <span style={{ fontFamily: "var(--font-mono)" }}>{config.quietHours.from} → {config.quietHours.to}</span>
            <button
              type="button"
              onClick={() => void handleQuietClear()}
              aria-label={t("notifySettings.quietClear")}
              style={{ display: "inline-flex", alignItems: "center", gap: 4, padding: "3px 8px", border: "1px solid var(--border)", borderRadius: "var(--radius-control)", background: "var(--bg-subtle)", color: "var(--text)", cursor: "pointer", fontSize: 11 }}
            >
              <X size={11} aria-hidden="true" /> {t("notifySettings.quietClear")}
            </button>
          </div>
        ) : (
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <label style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12, color: "var(--text-muted)" }}>
              {t("notifySettings.quietFrom")}
              <input type="time" aria-label={t("notifySettings.quietFrom")} value={quietFrom} onChange={(event) => setQuietFrom(event.target.value)} style={inputStyle} />
            </label>
            <label style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12, color: "var(--text-muted)" }}>
              {t("notifySettings.quietTo")}
              <input type="time" aria-label={t("notifySettings.quietTo")} value={quietTo} onChange={(event) => setQuietTo(event.target.value)} style={inputStyle} />
            </label>
            <button
              type="button"
              onClick={() => void handleQuietApply()}
              disabled={!quietFrom || !quietTo}
              style={{ display: "inline-flex", alignItems: "center", gap: 5, padding: "6px 10px", border: "1px solid var(--border)", borderRadius: "var(--radius-control)", background: "var(--bg-subtle)", color: "var(--text)", cursor: quietFrom && quietTo ? "pointer" : "not-allowed", fontSize: 12 }}
            >
              <Send size={12} aria-hidden="true" /> {t("notifySettings.quietApply")}
            </button>
          </div>
        )}
      </section>

      {/* Webhook */}
      <section style={{ display: "flex", flexDirection: "column", gap: 10, padding: 12, border: "1px solid var(--border)", borderRadius: "var(--radius-card)", background: "var(--bg-panel)" }}>
        <div>
          <div style={{ fontSize: 13, fontWeight: 600 }}>{t("notifySettings.webhook")}</div>
          <div style={{ marginTop: 2, fontSize: 11, color: "var(--text-muted)", lineHeight: 1.45 }}>{t("notifySettings.webhookDesc")}</div>
        </div>

        <ToggleRow
          id="notify-webhook-toggle"
          checked={webhook?.enabled === true}
          label={t("notifySettings.webhookEnabled")}
          description={webhook?.configured ? t("notifySettings.webhookConfigured", { host: webhook.host ?? "?" }) : t("notifySettings.webhookNotConfigured")}
          onChange={(next) => void handleWebhookToggle(next)}
        />

        <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
          <label style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12, color: "var(--text-muted)" }}>
            {t("notifySettings.webhookProvider")}
            <select
              value={webhook?.provider ?? "generic"}
              onChange={(event) => void feed.saveConfig({ webhook: { provider: event.target.value as typeof PROVIDERS[number] } }).then((result) => {
                if (!result.ok) toast.error(t("notifySettings.saveFailed", { detail: result.error ?? "" }));
              })}
              style={selectStyle}
            >
              {PROVIDERS.map((provider) => (
                <option key={provider} value={provider}>{provider}</option>
              ))}
            </select>
          </label>
        </div>

        {/* The URL is write-only: type it once, it never comes back. */}
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <label style={{ display: "flex", flex: 1, minWidth: 220, gap: 6, fontSize: 12, color: "var(--text-muted)", flexDirection: "column", alignItems: "stretch" }}>
            {t("notifySettings.webhookUrl")}
            <input
              type="password"
              autoComplete="off"
              spellCheck={false}
              placeholder={t("notifySettings.webhookUrlPlaceholder")}
              value={urlDraft}
              onChange={(event) => setUrlDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") void handleUrlSave();
              }}
              style={inputStyle}
            />
          </label>
          <button
            type="button"
            onClick={() => void handleUrlSave()}
            disabled={!urlDraft.trim()}
            style={{ alignSelf: "flex-end", padding: "6px 10px", border: "1px solid var(--border)", borderRadius: "var(--radius-control)", background: "var(--bg-subtle)", color: "var(--text)", cursor: urlDraft.trim() ? "pointer" : "not-allowed", fontSize: 12 }}
          >
            {t("notifySettings.urlSave")}
          </button>
        </div>
        <div style={{ fontSize: 11, color: "var(--text-dim)", lineHeight: 1.45 }}>{t("notifySettings.webhookUrlHint")}</div>

        <fieldset style={{ border: "none", margin: 0, padding: 0 }}>
          <legend style={{ fontSize: 12, fontWeight: 500, color: "var(--text)", padding: 0, marginBottom: 6 }}>{t("notifySettings.webhookEvents")}</legend>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
            {ALL_EVENTS.map((kind) => {
              const checked = events.has(kind);
              return (
                <label key={kind} style={{ display: "inline-flex", alignItems: "center", gap: 5, padding: "4px 9px", border: "1px solid var(--border)", borderRadius: 999, background: checked ? "var(--bg-selected)" : "var(--bg-subtle)", color: "var(--text)", fontSize: 11, cursor: "pointer" }}>
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={(event) => void handleEventToggle(kind, event.target.checked)}
                    style={{ accentColor: "var(--accent-strong)", margin: 0 }}
                  />
                  {t(`notify.kind.${kind}`)}
                </label>
              );
            })}
          </div>
        </fieldset>

        <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
          <button
            type="button"
            onClick={() => void handleTest()}
            disabled={testBusy}
            style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "7px 12px", border: "1px solid var(--border)", borderRadius: "var(--radius-control)", background: "var(--bg-subtle)", color: "var(--text)", cursor: testBusy ? "wait" : "pointer", fontSize: 12 }}
          >
            <FlaskConical size={13} aria-hidden="true" /> {t("notifySettings.webhookTest")}
          </button>
          <span aria-live="polite" style={{ fontSize: 11, color: "var(--text-dim)", fontFamily: "var(--font-mono)" }}>
            {t("notifySettings.deliveries", { sent: feed.webhookDeliveries.sent, failed: feed.webhookDeliveries.failed })}
          </span>
        </div>
      </section>

      {/* Weekly digest (wave 2 P10): one markdown row a week — sessions,
          usage, delegations, failures. Fires through the built-in digest
          scheduler; the browser ping still obeys quiet hours. */}
      <section style={{ display: "flex", flexDirection: "column", gap: 10, padding: 12, border: "1px solid var(--border)", borderRadius: "var(--radius-card)", background: "var(--bg-panel)" }}>
        <div>
          <div style={{ fontSize: 13, fontWeight: 600 }}>{t("digest.title")}</div>
          <div style={{ marginTop: 2, fontSize: 11, color: "var(--text-muted)", lineHeight: 1.45 }}>{t("digest.desc")}</div>
        </div>

        <ToggleRow
          id="notify-digest-toggle"
          checked={digest?.enabled === true}
          label={t("digest.enable")}
          description={t("digest.enableDesc")}
          onChange={(next) => void handleDigestToggle(next)}
        />

        <div aria-live="polite" style={{ fontSize: 11, color: "var(--text-dim)", paddingLeft: 12, lineHeight: 1.5 }}>
          {digest?.nextRunAt ? t("digest.next", { when: new Date(digest.nextRunAt).toLocaleString() }) : t("digest.never")}
          {digest?.lastDigestAt ? ` · ${t("digest.last", { when: new Date(digest.lastDigestAt).toLocaleString() })}` : ""}
        </div>

        <fieldset style={{ border: "none", margin: 0, padding: 0 }}>
          <legend style={{ fontSize: 12, fontWeight: 500, color: "var(--text)", padding: 0, marginBottom: 6 }}>{t("digest.day")}</legend>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
            {DIGEST_DAYS.map((day) => {
              const active = digestDay === day;
              return (
                <button
                  key={day}
                  type="button"
                  aria-pressed={active}
                  onClick={() => setDigestDayDraft(day)}
                  style={{
                    padding: "4px 10px",
                    border: `1px solid ${active ? "var(--accent-strong)" : "var(--border)"}`,
                    borderRadius: 999,
                    background: active ? "var(--bg-selected)" : "var(--bg-subtle)",
                    color: "var(--text)",
                    fontSize: 11,
                    cursor: "pointer",
                  }}
                >
                  {t(`scheduler.weekdayShort.${day}`)}
                </button>
              );
            })}
          </div>
        </fieldset>

        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <label style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12, color: "var(--text-muted)" }}>
            {t("digest.time")}
            <input
              type="time"
              aria-label={t("digest.time")}
              value={digestTime}
              onChange={(event) => setDigestTimeDraft(event.target.value)}
              style={inputStyle}
            />
          </label>
          <button
            type="button"
            onClick={() => void handleDigestScheduleApply()}
            style={{ display: "inline-flex", alignItems: "center", gap: 5, padding: "6px 10px", border: "1px solid var(--border)", borderRadius: "var(--radius-control)", background: "var(--bg-subtle)", color: "var(--text)", cursor: "pointer", fontSize: 12 }}
          >
            <CalendarClock size={12} aria-hidden="true" /> {t("digest.apply")}
          </button>
          <button
            type="button"
            onClick={() => void handleDigestNow()}
            disabled={digestNowBusy}
            style={{ display: "inline-flex", alignItems: "center", gap: 5, padding: "6px 10px", border: "1px solid var(--border)", borderRadius: "var(--radius-control)", background: "var(--bg-subtle)", color: "var(--text)", cursor: digestNowBusy ? "wait" : "pointer", fontSize: 12 }}
          >
            <Send size={12} aria-hidden="true" /> {t("digest.sendNow")}
          </button>
        </div>
      </section>

      {/* Feed preview */}
      <section style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <div style={{ fontSize: 13, fontWeight: 600 }}>{t("notifySettings.preview")}</div>
        {feed.rows.length === 0 ? (
          <div style={{ padding: 12, border: "1px dashed var(--border)", borderRadius: "var(--radius-control)", fontSize: 12, color: "var(--text-dim)" }}>
            {t("notifySettings.previewEmpty")}
          </div>
        ) : (
          <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: 6 }}>
            {feed.rows.slice(0, 8).map((row) => (
              <li key={row.id} style={{ padding: "8px 10px", border: "1px solid var(--border)", borderRadius: "var(--radius-control)", background: "var(--bg)", display: "flex", flexDirection: "column", gap: 2 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <span style={{ padding: "1px 6px", borderRadius: 999, border: "1px solid var(--border)", background: "var(--bg-subtle)", color: "var(--text-muted)", fontSize: 10 }}>
                    {t(`notify.kind.${row.kind}`)}
                  </span>
                  <span style={{ fontSize: 12, fontWeight: 500, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{row.sessionTitle}</span>
                  <span style={{ marginLeft: "auto", fontSize: 10, color: "var(--text-dim)", fontFamily: "var(--font-mono)" }}>
                    {(() => {
                      // The {count} placeholder must be interpolated — the bare
                      // t(key) call rendered the literal "{count}h".
                      const time = rowKindTime(row.ts);
                      return t(`notify.time.${time.unit}`, time.count !== undefined ? { count: time.count } : undefined);
                    })()}
                  </span>
                </div>
                <div style={{ fontSize: 11, color: "var(--text-muted)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {row.projectRoot ? `${projectLabel(row.projectRoot)} · ` : ""}{row.body}
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function rowKindTime(ts: string): { unit: "now" | "minutes" | "hours" | "days"; count?: number } {
  const then = Date.parse(ts);
  if (!Number.isFinite(then)) return { unit: "now" };
  const minutes = Math.max(0, Math.round((Date.now() - then) / 60_000));
  if (minutes < 1) return { unit: "now" };
  if (minutes < 60) return { unit: "minutes", count: minutes };
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return { unit: "hours", count: hours };
  return { unit: "days", count: Math.floor(hours / 24) };
}
