"use client";

import { useCallback, useEffect, useState } from "react";
import { Check, RefreshCw } from "lucide-react";
import { useI18n } from "@/lib/i18n";
import { toast } from "./ui/toast";

// ============================================================================
// Store diagnostics panel (wave 3 P5.5 / R3-30): read-only health of the
// ompweb-owned stores — version, size, last write, entry counts, and
// quarantine/backup evidence. Copy-safe by construction: the server endpoint
// only ever sends health words and counts, never file contents, secrets,
// prompts, transcript text, or absolute paths. No repair buttons: a corrupt
// store already self-quarantines and rebuilds; this panel explains that.
// ============================================================================

interface StoreDiagnosticRow {
  id: string;
  file: string;
  descriptionKey: string;
  health: "ok" | "missing" | "corrupt" | "unreadable" | "empty";
  bytes: number | null;
  lastWrite: string | null;
  version: number | null;
  counts: Record<string, number>;
  backups: number;
  cap: number | null;
}

const HEALTH_COLOR: Record<StoreDiagnosticRow["health"], string> = {
  ok: "var(--accent)",
  missing: "var(--text-dim)",
  corrupt: "var(--danger, #b91c1c)",
  unreadable: "var(--danger, #b91c1c)",
  empty: "var(--text-muted)",
};

function formatBytes(bytes: number | null): string {
  if (bytes === null) return "—";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function StoreDiagnosticsPanel() {
  const { t } = useI18n();
  const [stores, setStores] = useState<StoreDiagnosticRow[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);

  const load = useCallback(async () => {
    setBusy(true);
    try {
      const res = await fetch("/api/store-diagnostics", { cache: "no-store" });
      const payload = await res.json().catch(() => null) as { success?: boolean; data?: { stores?: StoreDiagnosticRow[] } } | null;
      if (payload?.success && payload.data?.stores) setStores(payload.data.stores);
      else setStores([]);
    } catch {
      setStores([]);
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const copySummary = useCallback(async () => {
    if (!stores) return;
    // Copy-safe summary: health words + counts only (the same facts the panel
    // renders — never paths beyond the relative file name).
    const lines = stores.map((store) => {
      const counts = Object.entries(store.counts).map(([key, value]) => `${key}=${value}`).join(",");
      return `${store.file}: ${t(`diagnostics.health.${store.health}`)}${store.version !== null ? ` v${store.version}` : ""}${counts ? ` (${counts})` : ""}${store.backups > 0 ? ` [${store.backups} bak]` : ""}`;
    });
    try {
      await navigator.clipboard.writeText(lines.join("\n"));
      setCopied(true);
      toast.success(t("diagnostics.copied"));
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      toast.error(t("diagnostics.copyFailed"));
    }
  }, [stores, t]);

  return (
    <section style={{ padding: 14, border: "1px solid var(--border)", borderRadius: "var(--radius-card)", background: "var(--bg-panel)", display: "flex", flexDirection: "column", gap: 10 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
        <div>
          <div style={{ fontSize: 13, fontWeight: 600 }}>{t("diagnostics.title")}</div>
          <div style={{ marginTop: 2, fontSize: 11, color: "var(--text-muted)", lineHeight: 1.45 }}>{t("diagnostics.desc")}</div>
        </div>
        <div style={{ display: "flex", gap: 6 }}>
          <button
            type="button"
            onClick={() => void load()}
            disabled={busy}
            aria-label={t("diagnostics.refresh")}
            style={{ display: "inline-flex", alignItems: "center", gap: 5, padding: "6px 10px", border: "1px solid var(--border)", borderRadius: "var(--radius-control)", background: "var(--bg-subtle)", color: "var(--text)", cursor: busy ? "wait" : "pointer", fontSize: 12 }}
          >
            <RefreshCw size={12} className={busy ? "spin" : undefined} aria-hidden="true" /> {t("diagnostics.refresh")}
          </button>
          <button
            type="button"
            onClick={() => void copySummary()}
            disabled={!stores || stores.length === 0}
            aria-label={t("diagnostics.copy")}
            style={{ display: "inline-flex", alignItems: "center", gap: 5, padding: "6px 10px", border: "1px solid var(--border)", borderRadius: "var(--radius-control)", background: "var(--bg-subtle)", color: "var(--text)", cursor: stores?.length ? "pointer" : "not-allowed", fontSize: 12 }}
          >
            {copied ? <Check size={12} aria-hidden="true" /> : null} {t("diagnostics.copy")}
          </button>
        </div>
      </div>

      {stores === null ? (
        <div style={{ fontSize: 12, color: "var(--text-dim)" }}>{t("diagnostics.loading")}</div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          {stores.map((store) => {
            const primaryCount = Object.entries(store.counts)
              .filter(([key]) => key !== "passwordSet")
              .map(([key, value]) => `${key}: ${value.toLocaleString()}`)
              .join(" · ");
            return (
              <div
                key={store.id}
                style={{ display: "flex", alignItems: "center", gap: 8, padding: "5px 8px", borderRadius: "var(--radius-control)", flexWrap: "wrap", fontSize: 12 }}
                onMouseEnter={(e) => { e.currentTarget.style.background = "var(--bg-hover)"; }}
                onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}
              >
                <span
                  aria-label={t(`diagnostics.health.${store.health}`)}
                  title={t(`diagnostics.health.${store.health}`)}
                  style={{ width: 8, height: 8, borderRadius: 999, background: HEALTH_COLOR[store.health], flexShrink: 0 }}
                />
                <span style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--text)", minWidth: 170 }}>
                  {store.file}
                </span>
                <span style={{ color: "var(--text-muted)", flex: 1, minWidth: 140, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {primaryCount || t(`diagnostics.health.${store.health}`)}
                </span>
                {store.backups > 0 && (
                  <span title={t("diagnostics.backups", { count: store.backups })} style={{ fontSize: 10, color: "var(--warning, #b45309)", flexShrink: 0 }}>
                    {t("diagnostics.backups", { count: store.backups })}
                  </span>
                )}
                <span style={{ fontSize: 10, color: "var(--text-dim)", flexShrink: 0 }}>{formatBytes(store.bytes)}</span>
              </div>
            );
          })}
          <p style={{ margin: "6px 0 0", fontSize: 11, color: "var(--text-dim)", lineHeight: 1.5 }}>{t("diagnostics.hint")}</p>
        </div>
      )}
    </section>
  );
}
