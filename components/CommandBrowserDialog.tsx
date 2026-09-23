"use client";

/**
 * Command browser dialog (P16 / R3-19): a metadata VIEWER over omp's full
 * `get_available_commands` surface, served by /api/command-browser (which
 * degrades to an explicit unsupported state instead of failing). Nothing in
 * this dialog EXECUTES a command — it is reference material for "what can
 * this session's /-palette become", sourced from the shared utility omp
 * process. Design tokens + lucide only; phone-width safe.
 */
import { useCallback, useEffect, useMemo, useState, type CSSProperties } from "react";
import { Info, Search } from "lucide-react";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/primitives";
import { useI18n } from "@/lib/i18n";
import type { CommandBrowserIndex, CommandInfo } from "@/lib/command-browser";

type SourceFilter = "all" | "builtin" | "skill" | "extension" | "custom" | "mcp_prompt" | "file" | "unknown";

const SOURCE_FILTERS: SourceFilter[] = ["all", "builtin", "skill", "extension", "custom", "mcp_prompt", "file", "unknown"];

const SOURCE_LABEL_KEYS: Record<Exclude<SourceFilter, "all">, string> = {
  builtin: "commandBrowser.sourceBuiltin",
  skill: "commandBrowser.sourceSkill",
  extension: "commandBrowser.sourceExtension",
  custom: "commandBrowser.sourceCustom",
  mcp_prompt: "commandBrowser.sourceMcpPrompt",
  file: "commandBrowser.sourceFile",
  unknown: "commandBrowser.sourceUnknown",
};

function sourceLabelKey(source: string): string {
  const known = (Object.keys(SOURCE_LABEL_KEYS) as Exclude<SourceFilter, "all">[]).find((key) => key === source);
  return known ? SOURCE_LABEL_KEYS[known] : SOURCE_LABEL_KEYS.unknown;
}

function matchesQuery(command: CommandInfo, query: string): boolean {
  if (!query) return true;
  if (command.name.toLowerCase().includes(query)) return true;
  if (command.description?.toLowerCase().includes(query)) return true;
  return command.aliases.some((alias) => alias.toLowerCase().includes(query));
}

export function CommandBrowserDialog({ open, onOpenChange }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t, tn } = useI18n();
  const [index, setIndex] = useState<CommandBrowserIndex | null>(null);
  const [loading, setLoading] = useState(false);
  const [query, setQuery] = useState("");
  const [sourceFilter, setSourceFilter] = useState<SourceFilter>("all");
  const [mutatingOnly, setMutatingOnly] = useState(false);

  // Fetch per open (the route caches 60s server-side, so re-opening is cheap)
  // and reset the local filters so a re-open starts clean.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setQuery("");
    setSourceFilter("all");
    setMutatingOnly(false);
    setIndex(null);
    setLoading(true);
    fetch("/api/command-browser", { cache: "no-store" })
      .then((res) => (res.ok ? (res.json() as Promise<{ success: boolean; data?: CommandBrowserIndex }>) : null))
      .then((payload) => {
        if (cancelled) return;
        setIndex(payload?.data ?? { supported: false, reason: "transport_disconnected", commands: [] });
      })
      .catch(() => {
        if (!cancelled) setIndex({ supported: false, reason: "transport_disconnected", commands: [] });
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open]);

  const availableSources = useMemo(() => {
    const present = new Set((index?.commands ?? []).map((command) => command.source));
    return SOURCE_FILTERS.filter((source) => source === "all" || source === "unknown" || present.has(source));
  }, [index]);

  const visibleCommands = useMemo(() => {
    if (!index?.supported) return [];
    const q = query.trim().toLowerCase();
    return index.commands.filter((command) =>
      (sourceFilter === "all" || command.source === sourceFilter)
      && (!mutatingOnly || command.mutating)
      && matchesQuery(command, q));
  }, [index, query, sourceFilter, mutatingOnly]);

  const sourceChipStyle = useCallback((active: boolean): CSSProperties => ({
    padding: "3px 9px",
    fontSize: 11,
    lineHeight: 1.4,
    borderRadius: 999,
    cursor: "pointer",
    border: `1px solid ${active ? "var(--accent)" : "var(--border)"}`,
    background: active ? "color-mix(in srgb, var(--accent) 12%, transparent)" : "transparent",
    color: active ? "var(--accent)" : "var(--text-dim)",
    whiteSpace: "nowrap",
  }), []);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent ariaLabel={t("commandBrowser.title")} style={{ width: 560, maxWidth: "94vw", display: "flex", flexDirection: "column", maxHeight: "88dvh", padding: 16 }}>
        <DialogTitle style={{ fontSize: 18, margin: "0 0 8px" }}>{t("commandBrowser.title")}</DialogTitle>

        {/* Search + mutating-only toggle */}
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center" }}>
          <div style={{
            flex: "1 1 200px",
            minWidth: 0,
            display: "flex",
            alignItems: "center",
            gap: 6,
            padding: "5px 9px",
            border: "1px solid var(--border)",
            borderRadius: "var(--radius-control, 7px)",
            background: "var(--bg-panel)",
          }}>
            <Search size={13} style={{ color: "var(--text-dim)", flexShrink: 0 }} aria-hidden="true" />
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t("commandBrowser.searchPlaceholder")}
              aria-label={t("commandBrowser.searchPlaceholder")}
              style={{
                flex: 1,
                minWidth: 0,
                border: "none",
                background: "transparent",
                color: "var(--text)",
                fontSize: 12.5,
                outline: "none",
              }}
            />
          </div>
          <label style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 12, color: "var(--text-dim)", cursor: "pointer" }}>
            <input
              type="checkbox"
              checked={mutatingOnly}
              onChange={(e) => setMutatingOnly(e.target.checked)}
            />
            {t("commandBrowser.mutatingOnly")}
          </label>
        </div>

        {/* Source filter chips */}
        {!loading && index?.supported && (
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 8 }}>
            {availableSources.map((source) => (
              <button
                key={source}
                type="button"
                onClick={() => setSourceFilter(source)}
                style={sourceChipStyle(sourceFilter === source)}
              >
                {source === "all" ? t("commandBrowser.filterAll") : t(SOURCE_LABEL_KEYS[source as Exclude<SourceFilter, "all">])}
              </button>
            ))}
          </div>
        )}

        {/* Body: list or unsupported-state explanation */}
        <div style={{
          flex: 1,
          minHeight: 120,
          marginTop: 8,
          overflowY: "auto",
          border: "1px solid var(--border)",
          borderRadius: 8,
          padding: 8,
          display: "flex",
          flexDirection: "column",
          gap: 6,
        }}>
          {loading && (
            <div style={{ fontSize: 12, color: "var(--text-dim)", padding: 6 }}>{t("commandBrowser.loading")}</div>
          )}
          {!loading && index && !index.supported && (
            <div style={{ display: "flex", gap: 8, alignItems: "flex-start", padding: 8, fontSize: 12.5, lineHeight: 1.5, color: "var(--text-dim)" }}>
              <Info size={14} style={{ flexShrink: 0, marginTop: 2, color: "var(--text-dim)" }} aria-hidden="true" />
              <span>
                {index.reason === "no_commands"
                  ? t("commandBrowser.degradedNoCommands")
                  : t("commandBrowser.degradedTransport")}
              </span>
            </div>
          )}
          {!loading && index?.supported && visibleCommands.length === 0 && (
            <div style={{ fontSize: 12, color: "var(--text-dim)", padding: 6 }}>{t("commandBrowser.noMatches")}</div>
          )}
          {!loading && index?.supported && visibleCommands.map((command) => (
            <div
              key={command.name}
              style={{
                display: "flex",
                flexWrap: "wrap",
                alignItems: "baseline",
                gap: "4px 8px",
                padding: "6px 8px",
                borderRadius: 6,
                background: "var(--bg-panel)",
                border: "1px solid var(--border)",
                minWidth: 0,
              }}
            >
              <span style={{
                fontFamily: "var(--font-mono)",
                fontSize: 12.5,
                color: "var(--text)",
                overflowWrap: "anywhere",
                flexShrink: 0,
              }}>
                /{command.name}
              </span>
              <span style={{
                fontSize: 9.5,
                fontWeight: 600,
                letterSpacing: "0.05em",
                textTransform: "uppercase",
                padding: "1px 5px",
                borderRadius: 4,
                border: "1px solid var(--border)",
                color: "var(--text-muted)",
                flexShrink: 0,
              }}>
                {t(sourceLabelKey(command.source))}
              </span>
              {command.mutating && (
                <span style={{
                  fontSize: 9.5,
                  fontWeight: 600,
                  letterSpacing: "0.05em",
                  textTransform: "uppercase",
                  padding: "1px 5px",
                  borderRadius: 4,
                  border: "1px solid color-mix(in srgb, var(--status-warning) 50%, transparent)",
                  color: "var(--status-warning)",
                  flexShrink: 0,
                }}>
                  {t("commandBrowser.mutatingChip")}
                </span>
              )}
              {command.description && (
                <span
                  title={command.description}
                  style={{
                    fontSize: 11.5,
                    color: "var(--text-dim)",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                    flex: "1 1 140px",
                    minWidth: 0,
                  }}
                >
                  {command.description}
                </span>
              )}
              {command.aliases.length > 0 && (
                <span aria-label={t("commandBrowser.aliasesAria")} style={{
                  fontFamily: "var(--font-mono)",
                  fontSize: 10.5,
                  color: "var(--text-muted)",
                  overflowWrap: "anywhere",
                }}>
                  {command.aliases.map((alias) => `/${alias}`).join(" ")}
                </span>
              )}
            </div>
          ))}
        </div>

        {/* Footer: count + the view-only contract line */}
        <div style={{ marginTop: 8, display: "flex", flexDirection: "column", gap: 4, fontSize: 11.5, color: "var(--text-dim)", lineHeight: 1.45 }}>
          {!loading && index?.supported && (
            <span>{tn("commandBrowser.commandCount", visibleCommands.length)}</span>
          )}
          <span>{t("commandBrowser.viewOnlyHint")}</span>
        </div>
      </DialogContent>
    </Dialog>
  );
}
