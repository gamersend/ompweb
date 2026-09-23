"use client";

import { memo, useCallback, useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import {
  Brain, Check, ChevronDown, ChevronRight, ClipboardCheck, Copy, Database,
  Lock, MessageSquarePlus, Minus, RefreshCw, Search, TriangleAlert, X,
} from "lucide-react";
import { MarkdownBody } from "./MarkdownBody";
import { useI18n } from "@/lib/i18n";
import { formatApiError } from "@/lib/i18n/api-error";
import { copyText } from "@/lib/clipboard";
import { insertIntoComposer } from "@/lib/composer-insert";
import { splitMemoryCards } from "@/lib/memory/mem0";

interface Props {
  /** True while the memory view is the visible right-panel tab. */
  active: boolean;
  /** Draft key of the ACTIVE session composer (`<id>` or `new:<cwd>`) —
   *  insert targets exactly that composer, never a split pane's other draft. */
  composerDraftKey: string | null;
}

type Health = "checking" | "ok" | "down";

interface SearchState {
  cards: string[];
  redactedCount: number;
  tookMs: number;
}

/** Fence with four backticks: memory markdown may itself contain fences. */
function buildMemoryContextBlock(cards: string[]): string {
  return `Shared memory (mem0) — context for this task, treat as reference:\n\n\`\`\`\n${cards.join("\n\n")}\n\`\`\``;
}

export const MemoryPanel = memo(function MemoryPanel({ active, composerDraftKey }: Props) {
  const { t, tn } = useI18n();
  const [health, setHealth] = useState<Health>("checking");
  const [configured, setConfigured] = useState(true);
  const [query, setQuery] = useState("");
  const [searching, setSearching] = useState(false);
  const [errorText, setErrorText] = useState<string | null>(null);
  const [results, setResults] = useState<SearchState | null>(null);
  const [copiedIndex, setCopiedIndex] = useState<number | null>(null);
  const [insertedIndex, setInsertedIndex] = useState<number | null>(null);

  const probeHealth = useCallback(async () => {
    setHealth("checking");
    try {
      const res = await fetch("/api/memory");
      if (res.status === 503) {
        setConfigured(false);
        setHealth("down");
        return;
      }
      const data = await res.json() as { success?: boolean; data?: { configured?: boolean; healthy?: boolean } };
      setConfigured(data?.data?.configured !== false);
      setHealth(data?.data?.healthy ? "ok" : "down");
    } catch {
      setHealth("down");
    }
  }, []);

  // One probe on mount; re-probe when the tab becomes visible and the last
  // answer is older than a minute (cheap GET, no omp child involved).
  const lastProbeAtRef = useRef(0);
  useEffect(() => {
    if (!active && lastProbeAtRef.current > 0) return;
    if (Date.now() - lastProbeAtRef.current < 60_000) return;
    lastProbeAtRef.current = Date.now();
    void probeHealth();
  }, [probeHealth, active]);

  const runSearch = useCallback(async (rawQuery: string) => {
    const q = rawQuery.trim();
    if (!q || searching) return;
    setSearching(true);
    setErrorText(null);
    const startedAt = performance.now();
    try {
      const res = await fetch(`/api/memory?q=${encodeURIComponent(q)}&limit=20`);
      const payload = await res.json().catch(() => null) as
        | { success?: boolean; data?: { result?: string; redactedCount?: number }; error?: string; code?: string }
        | null;
      if (!res.ok || !payload?.success) {
        setErrorText(formatApiError(payload));
        setResults(null);
        return;
      }
      const text = payload.data?.result ?? "";
      setResults({
        cards: splitMemoryCards(text),
        redactedCount: payload.data?.redactedCount ?? 0,
        tookMs: Math.round(performance.now() - startedAt),
      });
    } catch {
      setErrorText(formatApiError(null));
      setResults(null);
    } finally {
      setSearching(false);
    }
  }, [searching]);

  const handleCopy = useCallback(async (card: string, index: number) => {
    try {
      await copyText(card);
      setCopiedIndex(index);
      window.setTimeout(() => setCopiedIndex((current) => (current === index ? null : current)), 1500);
    } catch {
      /* clipboard unavailable — nothing to surface in a narrow panel */
    }
  }, []);

  const handleInsert = useCallback((cards: string[], index: number) => {
    insertIntoComposer({
      text: buildMemoryContextBlock(cards),
      draftKey: composerDraftKey ?? undefined,
      source: "memory",
    });
    setInsertedIndex(index);
    window.setTimeout(() => setInsertedIndex((current) => (current === index ? null : current)), 1500);
  }, [composerDraftKey]);

  const healthColor = health === "ok"
    ? "var(--status-success)"
    : health === "checking"
      ? "var(--text-dim)"
      : "var(--status-modified)";
  const healthLabel = health === "ok"
    ? t("memory.healthOk")
    : health === "checking"
      ? t("memory.healthChecking")
      : configured
        ? t("memory.healthDown")
        : t("memory.notConfigured");

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}>
      {/* View header: title + health dot + re-probe */}
      <div style={{ display: "flex", alignItems: "center", gap: 7, padding: "10px 10px 6px", flexShrink: 0 }}>
        <Brain size={14} strokeWidth={2} aria-hidden="true" style={{ color: "var(--accent)", flexShrink: 0 }} />
        <span style={{ fontSize: 12, fontWeight: 600, color: "var(--text)" }}>{t("memory.title")}</span>
        <span
          role="img"
          aria-label={healthLabel}
          title={healthLabel}
          style={{
            width: 8,
            height: 8,
            borderRadius: "50%",
            flexShrink: 0,
            background: healthColor,
            ...(health === "checking" ? { animation: "pulse 1.2s ease-in-out infinite" } : {}),
          }}
        />
        <span style={{ flex: 1 }} />
        <button
          onClick={() => void probeHealth()}
          title={t("memory.healthProbe")}
          aria-label={t("memory.healthProbe")}
          style={{ display: "flex", alignItems: "center", justifyContent: "center", width: 24, height: 24, padding: 0, background: "none", border: "none", borderRadius: "var(--radius-control)", color: health === "checking" ? "var(--accent)" : "var(--text-dim)", cursor: "pointer" }}
          onMouseEnter={(e) => { e.currentTarget.style.color = "var(--text)"; e.currentTarget.style.background = "var(--bg-hover)"; }}
          onMouseLeave={(e) => { e.currentTarget.style.color = health === "checking" ? "var(--accent)" : "var(--text-dim)"; e.currentTarget.style.background = "none"; }}
        >
          <RefreshCw size={12} strokeWidth={2} aria-hidden="true" className={health === "checking" ? "icon-spin" : undefined} />
        </button>
      </div>

      {/* Search row */}
      <form
        onSubmit={(e) => { e.preventDefault(); void runSearch(query); }}
        style={{ display: "flex", gap: 6, padding: "0 10px 8px", flexShrink: 0 }}
        role="search"
        aria-label={t("memory.title")}
      >
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t("memory.searchPlaceholder")}
          aria-label={t("memory.searchPlaceholder")}
          disabled={!configured}
          style={{
            flex: 1,
            minWidth: 0,
            padding: "6px 9px",
            fontSize: 12,
            color: "var(--text)",
            background: "var(--bg-subtle)",
            border: "1px solid var(--border)",
            borderRadius: "var(--radius-control)",
            outline: "none",
          }}
        />
        <button
          type="submit"
          disabled={searching || !query.trim() || !configured}
          title={t("memory.search")}
          aria-label={t("memory.search")}
          style={{
            display: "flex", alignItems: "center", justifyContent: "center",
            width: 28, height: 28, flexShrink: 0,
            background: searching || !query.trim() || !configured ? "none" : "var(--accent)",
            border: "1px solid var(--border)",
            borderRadius: "var(--radius-control)",
            color: searching || !query.trim() || !configured ? "var(--text-dim)" : "var(--bg)",
            cursor: searching || !query.trim() || !configured ? "default" : "pointer",
            opacity: searching ? 0.7 : 1,
          }}
        >
          <Search size={13} strokeWidth={2.2} aria-hidden="true" />
        </button>
      </form>

      {/* omp native memory (P17): read-only stats/diagnostics/TTSR rules —
          collapsible, fetch-on-expand only; mem0 flows above stay untouched. */}
      <NativeMemorySection />

      {/* Results / states */}
      <div style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: "0 10px 10px", display: "flex", flexDirection: "column", gap: 8 }}>
        {!configured ? (
          <EmptyState icon={<Brain size={26} strokeWidth={1.5} aria-hidden="true" />} title={t("memory.title")} hint={t("memory.notConfigured")} />
        ) : errorText ? (
          <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 8, padding: "24px 8px", textAlign: "center" }}>
            <TriangleAlert size={26} strokeWidth={1.5} aria-hidden="true" style={{ color: "var(--status-modified)" }} />
            <div style={{ color: "var(--text)", fontSize: 12, lineHeight: 1.6, maxWidth: 280 }}>{errorText}</div>
          </div>
        ) : results === null ? (
          <EmptyState icon={<Brain size={26} strokeWidth={1.5} aria-hidden="true" />} title={t("memory.title")} hint={t("memory.idleHint")} />
        ) : results.cards.length === 0 ? (
          <EmptyState icon={<Search size={26} strokeWidth={1.5} aria-hidden="true" />} title={t("memory.noResults")} hint={t("memory.idleHint")} />
        ) : (
          <>
            <div style={{ fontSize: 11, color: "var(--text-dim)", flexShrink: 0 }}>
              {tn("memory.resultsCount", results.cards.length)}
              {results.redactedCount > 0
                ? ` · ${tn("memory.redacted", results.redactedCount)}`
                : ""}
            </div>
            {results.cards.map((card, index) => (
              <div
                key={`${index}-${card.slice(0, 24)}`}
                style={{
                  background: "var(--bg-panel)",
                  border: "1px solid var(--border)",
                  borderRadius: "var(--radius-card)",
                  padding: "8px 10px 6px",
                  minWidth: 0,
                }}
              >
                <MarkdownBody suppressImages className="memory-result-markdown">{card}</MarkdownBody>
                <div style={{ display: "flex", gap: 4, justifyContent: "flex-end", marginTop: 4 }}>
                  <button
                    onClick={() => void handleCopy(card, index)}
                    title={t("memory.copy")}
                    aria-label={t("memory.copy")}
                    style={cardActionStyle(copiedIndex === index)}
                  >
                    {copiedIndex === index
                      ? <ClipboardCheck size={12} strokeWidth={2} aria-hidden="true" />
                      : <Copy size={12} strokeWidth={2} aria-hidden="true" />}
                  </button>
                  <button
                    onClick={() => handleInsert(results.cards, index)}
                    title={t("memory.insert")}
                    aria-label={t("memory.insert")}
                    style={cardActionStyle(insertedIndex === index)}
                  >
                    <MessageSquarePlus size={12} strokeWidth={2} aria-hidden="true" />
                  </button>
                </div>
              </div>
            ))}
          </>
        )}
      </div>

      {/* Disclosure — this service is shared fleet-wide; treat results as sensitive. */}
      <div style={{ display: "flex", alignItems: "flex-start", gap: 6, padding: "8px 10px 10px", flexShrink: 0, borderTop: "1px solid var(--border)", color: "var(--text-dim)", fontSize: 10, lineHeight: 1.5 }}>
        <Lock size={11} strokeWidth={2} aria-hidden="true" style={{ flexShrink: 0, marginTop: 1 }} />
        <span>{t("memory.disclosure")}</span>
      </div>
    </div>
  );
});

function cardActionStyle(active: boolean): CSSProperties {
  return {
    display: "flex", alignItems: "center", justifyContent: "center",
    width: 24, height: 24, padding: 0,
    background: "none", border: "none",
    borderRadius: "var(--radius-control)",
    color: active ? "var(--accent)" : "var(--text-dim)",
    cursor: "pointer",
  };
}

// ─── omp native memory (P17 / R3-20 + R3-21) ────────────────────────────────
// Read-only inspectors for omp's OWN memory (distinct from the mem0 service
// this panel browses): aggregate stats + diagnostics + TTSR rule LIST
// metadata. Raw memory content is never fetched (`memory view` does not
// exist here) and nothing mutates omp state. Fetches happen only on first
// expand and on the manual Refresh button — never polled.

interface NativeStatsShape { backend?: string; entries?: number; queueDepth?: number | null }
interface NativeDiagnoseRow { check: string; ok: boolean; detail?: string }
interface TtsrRuleShape { id: string; scope?: string; source?: string; enabled?: boolean | null }
interface NativeMemoryPayload {
  stats: { supported: true; stats: NativeStatsShape } | { supported: false; reason: string };
  diagnose: { supported: true; checks: NativeDiagnoseRow[] } | { supported: false; reason: string };
  ttsr: { supported: true; rules: TtsrRuleShape[] } | { supported: false; reason: string };
}

/** Per-group display cap: 15 rows then a "+N more" line. */
const NATIVE_MAX_ROWS = 15;

const NativeMemorySection = memo(function NativeMemorySection() {
  const { t, tn } = useI18n();
  const [expanded, setExpanded] = useState(false);
  const [data, setData] = useState<NativeMemoryPayload | null>(null);
  const [loading, setLoading] = useState(false);
  const [errorText, setErrorText] = useState<string | null>(null);
  const fetchedRef = useRef(false);

  const load = useCallback(async (refresh: boolean) => {
    setLoading(true);
    setErrorText(null);
    try {
      const res = await fetch(`/api/native-memory${refresh ? "?refresh=1" : ""}`);
      const payload = await res.json().catch(() => null) as { success?: boolean; data?: NativeMemoryPayload; error?: string; code?: string } | null;
      if (!payload?.success || !payload.data) {
        setErrorText(formatApiError(payload));
        return;
      }
      fetchedRef.current = true;
      setData(payload.data);
    } catch {
      setErrorText(formatApiError(null));
    } finally {
      setLoading(false);
    }
  }, []);

  const toggle = useCallback(() => {
    setExpanded((prev) => {
      const next = !prev;
      if (next && !fetchedRef.current) void load(false);
      return next;
    });
  }, [load]);

  return (
    <div style={{ margin: "0 0 8px", flexShrink: 0, borderBottom: "1px solid var(--border)", paddingBottom: 8 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 6, padding: "0 10px", minWidth: 0 }}>
        <button
          onClick={toggle}
          aria-expanded={expanded}
          style={{
            display: "flex", alignItems: "center", gap: 6, flex: 1, minWidth: 0,
            padding: "4px 6px 4px 2px", background: "none", border: "none",
            borderRadius: "var(--radius-control)", cursor: "pointer", textAlign: "left",
          }}
        >
          {expanded
            ? <ChevronDown size={12} strokeWidth={2} aria-hidden="true" style={{ color: "var(--text-dim)", flexShrink: 0 }} />
            : <ChevronRight size={12} strokeWidth={2} aria-hidden="true" style={{ color: "var(--text-dim)", flexShrink: 0 }} />}
          <Database size={12} strokeWidth={2} aria-hidden="true" style={{ color: "var(--accent)", flexShrink: 0 }} />
          <span style={{ fontSize: 12, fontWeight: 600, color: "var(--text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {t("nativeMemory.sectionTitle")}
          </span>
          {loading
            ? <RefreshCw size={11} strokeWidth={2} aria-hidden="true" className="icon-spin" style={{ color: "var(--accent)", flexShrink: 0 }} />
            : null}
        </button>
        {expanded ? (
          <button
            onClick={() => void load(true)}
            title={t("nativeMemory.refresh")}
            aria-label={t("nativeMemory.refresh")}
            style={{
              display: "flex", alignItems: "center", justifyContent: "center",
              width: 24, height: 24, padding: 0, flexShrink: 0,
              background: "none", border: "none", borderRadius: "var(--radius-control)",
              color: loading ? "var(--accent)" : "var(--text-dim)", cursor: "pointer",
            }}
            onMouseEnter={(e) => { e.currentTarget.style.color = "var(--text)"; e.currentTarget.style.background = "var(--bg-hover)"; }}
            onMouseLeave={(e) => { e.currentTarget.style.color = loading ? "var(--accent)" : "var(--text-dim)"; e.currentTarget.style.background = "none"; }}
          >
            <RefreshCw size={12} strokeWidth={2} aria-hidden="true" className={loading ? "icon-spin" : undefined} />
          </button>
        ) : null}
      </div>
      {/* Persistent hint: omp's own memory, not the mem0 service; read-only here. */}
      <div style={{ display: "flex", alignItems: "flex-start", gap: 5, padding: "2px 10px 0", color: "var(--text-dim)", fontSize: 10, lineHeight: 1.5, minWidth: 0 }}>
        <Lock size={10} strokeWidth={2} aria-hidden="true" style={{ flexShrink: 0, marginTop: 1 }} />
        <span style={{ minWidth: 0 }}>{t("nativeMemory.hint")}</span>
      </div>

      {expanded ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 6, padding: "8px 10px 0", maxHeight: 280, overflowY: "auto", minWidth: 0 }}>
          {errorText ? (
            <div style={{ color: "var(--status-modified)", fontSize: 11, lineHeight: 1.5 }}>{errorText}</div>
          ) : data ? (
            <>
              <NativeGroupLabel>{t("nativeMemory.stats")}</NativeGroupLabel>
              {data.stats.supported ? (
                <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
                  <NativeStatChip
                    label={t("nativeMemory.backend")}
                    value={data.stats.stats.backend ?? t("nativeMemory.notAvailable")}
                  />
                  <NativeStatChip
                    label={t("nativeMemory.entries")}
                    value={data.stats.stats.entries !== undefined ? String(data.stats.stats.entries) : t("nativeMemory.notAvailable")}
                  />
                  <NativeStatChip
                    label={t("nativeMemory.queue")}
                    value={data.stats.stats.queueDepth !== undefined && data.stats.stats.queueDepth !== null
                      ? String(data.stats.stats.queueDepth)
                      : t("nativeMemory.notAvailable")}
                  />
                </div>
              ) : (
                <NativeMutedLine>{t("nativeMemory.unsupported", { reason: data.stats.reason })}</NativeMutedLine>
              )}

              <NativeGroupLabel>{t("nativeMemory.diagnostics")}</NativeGroupLabel>
              {data.diagnose.supported ? (
                data.diagnose.checks.length === 0 ? (
                  <NativeMutedLine>{t("nativeMemory.checksEmpty")}</NativeMutedLine>
                ) : (
                  <>
                    {data.diagnose.checks.slice(0, NATIVE_MAX_ROWS).map((row) => (
                      <div key={row.check} style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0 }}>
                        <span
                          role="img"
                          aria-label={row.ok ? t("nativeMemory.ok") : t("nativeMemory.notOk")}
                          title={row.ok ? t("nativeMemory.ok") : t("nativeMemory.notOk")}
                          style={{
                            display: "flex", alignItems: "center", justifyContent: "center",
                            width: 16, height: 16, flexShrink: 0, borderRadius: "var(--radius-control)",
                            background: row.ok ? "color-mix(in srgb, var(--status-success) 15%, transparent)" : "color-mix(in srgb, var(--status-modified) 15%, transparent)",
                            color: row.ok ? "var(--status-success)" : "var(--status-modified)",
                          }}
                        >
                          {row.ok
                            ? <Check size={10} strokeWidth={2.5} aria-hidden="true" />
                            : <X size={10} strokeWidth={2.5} aria-hidden="true" />}
                        </span>
                        <span style={{ fontSize: 11, color: "var(--text)", flexShrink: 0, maxWidth: "45%", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={row.check}>
                          {row.check}
                        </span>
                        {row.detail ? (
                          <span style={{ fontSize: 10, color: "var(--text-dim)", flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={row.detail}>
                            {row.detail}
                          </span>
                        ) : null}
                      </div>
                    ))}
                    {data.diagnose.checks.length > NATIVE_MAX_ROWS ? (
                      <NativeMutedLine>{tn("nativeMemory.more", data.diagnose.checks.length - NATIVE_MAX_ROWS)}</NativeMutedLine>
                    ) : null}
                  </>
                )
              ) : (
                <NativeMutedLine>{t("nativeMemory.unsupported", { reason: data.diagnose.reason })}</NativeMutedLine>
              )}

              <NativeGroupLabel>{t("nativeMemory.rules")}</NativeGroupLabel>
              {data.ttsr.supported ? (
                data.ttsr.rules.length === 0 ? (
                  <NativeMutedLine>{t("nativeMemory.rulesEmpty")}</NativeMutedLine>
                ) : (
                  <>
                    {data.ttsr.rules.slice(0, NATIVE_MAX_ROWS).map((rule) => (
                      <div key={rule.id} style={{ display: "flex", alignItems: "center", gap: 5, minWidth: 0 }}>
                        <span style={{ fontSize: 11, color: "var(--text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0 }} title={rule.id}>
                          {rule.id}
                        </span>
                        {rule.scope ? <NativeTagChip>{rule.scope}</NativeTagChip> : null}
                        {rule.source ? <NativeTagChip>{rule.source}</NativeTagChip> : null}
                        <span style={{ flex: 1 }} />
                        <NativeEnabledMark enabled={rule.enabled} />
                      </div>
                    ))}
                    {data.ttsr.rules.length > NATIVE_MAX_ROWS ? (
                      <NativeMutedLine>{tn("nativeMemory.more", data.ttsr.rules.length - NATIVE_MAX_ROWS)}</NativeMutedLine>
                    ) : null}
                  </>
                )
              ) : (
                <NativeMutedLine>{t("nativeMemory.unsupported", { reason: data.ttsr.reason })}</NativeMutedLine>
              )}
            </>
          ) : (
            <NativeMutedLine>{t("nativeMemory.loading")}</NativeMutedLine>
          )}
        </div>
      ) : null}
    </div>
  );
});

function NativeGroupLabel({ children }: { children: ReactNode }) {
  return (
    <div style={{ fontSize: 10, fontWeight: 600, color: "var(--text-dim)", textTransform: "uppercase", letterSpacing: 0.4, marginTop: 2 }}>
      {children}
    </div>
  );
}

function NativeMutedLine({ children }: { children: ReactNode }) {
  return (
    <div style={{ fontSize: 10, color: "var(--text-dim)", lineHeight: 1.5, overflow: "hidden", textOverflow: "ellipsis", minWidth: 0 }}>
      {children}
    </div>
  );
}

function NativeStatChip({ label, value }: { label: string; value: string }) {
  return (
    <span style={{
      display: "inline-flex", alignItems: "center", gap: 4, maxWidth: "100%",
      padding: "2px 7px", fontSize: 10, color: "var(--text-dim)",
      background: "var(--bg-panel)", border: "1px solid var(--border)",
      borderRadius: "var(--radius-control)", minWidth: 0,
    }}>
      <span style={{ flexShrink: 0 }}>{label}</span>
      <span style={{ color: "var(--text)", fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={value}>
        {value}
      </span>
    </span>
  );
}

function NativeTagChip({ children }: { children: ReactNode }) {
  return (
    <span style={{
      display: "inline-block", flexShrink: 0, maxWidth: "30%",
      padding: "1px 6px", fontSize: 9, color: "var(--accent)",
      background: "var(--bg-panel)", border: "1px solid var(--border)",
      borderRadius: "var(--radius-control)",
      overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
    }}>
      {children}
    </span>
  );
}

function NativeEnabledMark({ enabled }: { enabled: boolean | null | undefined }) {
  const { t } = useI18n();
  const label = enabled === true
    ? t("nativeMemory.enabled")
    : enabled === false
      ? t("nativeMemory.disabled")
      : t("nativeMemory.enabledUnknown");
  const color = enabled === true
    ? "var(--status-success)"
    : enabled === false
      ? "var(--status-modified)"
      : "var(--text-dim)";
  return (
    <span role="img" aria-label={label} title={label} style={{ display: "flex", alignItems: "center", flexShrink: 0, color }}>
      {enabled === true
        ? <Check size={11} strokeWidth={2.5} aria-hidden="true" />
        : enabled === false
          ? <X size={11} strokeWidth={2.5} aria-hidden="true" />
          : <Minus size={11} strokeWidth={2.5} aria-hidden="true" />}
    </span>
  );
}

function EmptyState({ icon, title, hint }: { icon: ReactNode; title: string; hint: string }) {
  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 8, padding: 24, textAlign: "center" }}>
      <span style={{ color: "var(--text-dim)", display: "flex" }}>{icon}</span>
      <div style={{ color: "var(--text)", fontSize: 13, fontWeight: 600 }}>{title}</div>
      <div style={{ color: "var(--text-dim)", fontSize: 11, lineHeight: 1.6, maxWidth: 260 }}>{hint}</div>
    </div>
  );
}
