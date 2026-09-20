"use client";

import { memo, useCallback, useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { Brain, ClipboardCheck, Copy, Lock, MessageSquarePlus, RefreshCw, Search, TriangleAlert } from "lucide-react";
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

function EmptyState({ icon, title, hint }: { icon: ReactNode; title: string; hint: string }) {
  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 8, padding: 24, textAlign: "center" }}>
      <span style={{ color: "var(--text-dim)", display: "flex" }}>{icon}</span>
      <div style={{ color: "var(--text)", fontSize: 13, fontWeight: 600 }}>{title}</div>
      <div style={{ color: "var(--text-dim)", fontSize: 11, lineHeight: 1.6, maxWidth: 260 }}>{hint}</div>
    </div>
  );
}
