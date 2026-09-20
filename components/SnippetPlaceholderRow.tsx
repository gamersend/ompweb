"use client";

/**
 * Composer chip row for a detached snippet with placeholders (BUILD-PLAN P4).
 *
 * Rendered next to the draft-attachment chips, above the composer input: one
 * labeled input per placeholder in the snippet body. Tab cycles (wrapping),
 * Enter submits when every placeholder is filled (else it moves focus to the
 * next empty input), Esc detaches the snippet. Values live in the parent's
 * memory only — they are NEVER written to the persisted draft store.
 */
import { useEffect, useRef } from "react";
import { X } from "lucide-react";
import { useI18n } from "@/lib/i18n";

export interface SnippetPlaceholderRowProps {
  snippet: { id: string; name: string; body: string; projectRoot: string | null };
  placeholders: string[];
  values: Record<string, string>;
  /** Scope badge text ("global" / "project"), already localized. */
  scopeLabel: string | null;
  onValueChange: (name: string, value: string) => void;
  /** Enter with every input filled. */
  onSubmit: () => void;
  /** Esc or the ✕ button. */
  onDetach: () => void;
}

export function SnippetPlaceholderRow({
  snippet,
  placeholders,
  values,
  scopeLabel,
  onValueChange,
  onSubmit,
  onDetach,
}: SnippetPlaceholderRowProps) {
  const { t } = useI18n();
  const inputRefs = useRef<Array<HTMLInputElement | null>>([]);

  useEffect(() => {
    // Mount/placeholder-set change: land focus on the first empty input so
    // typing starts immediately.
    inputRefs.current.length = placeholders.length;
    const firstEmpty = placeholders.findIndex((name) => !(values[name] ?? "").trim());
    const target = firstEmpty === -1 ? 0 : firstEmpty;
    inputRefs.current[target]?.focus();
    // values intentionally excluded: only (re)focus when the row appears or
    // the placeholder set changes, never while typing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [snippet.id, placeholders.join("\u0000")]);

  const filled = placeholders.filter((name) => (values[name] ?? "").trim().length > 0).length;
  const allFilled = filled === placeholders.length && placeholders.length > 0;

  const focusInput = (index: number) => {
    const count = placeholders.length;
    if (count === 0) return;
    const wrapped = ((index % count) + count) % count;
    inputRefs.current[wrapped]?.focus();
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLInputElement>, index: number) => {
    if (event.key === "Escape") {
      // Stop propagation so the composer's own Esc handlers (abort/minimize)
      // never fire for a detach that already consumed the key.
      event.preventDefault();
      event.stopPropagation();
      onDetach();
      return;
    }
    if (event.key === "Tab") {
      event.preventDefault();
      focusInput(index + (event.shiftKey ? -1 : 1));
      return;
    }
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      if (allFilled) {
        onSubmit();
        return;
      }
      // Land on the next empty input (wrapping); stay put if none are empty
      // except inputs with whitespace-only drafts.
      const nextEmpty = placeholders.findIndex(
        (name, i) => i !== index && !(values[name] ?? "").trim(),
      );
      if (nextEmpty !== -1) focusInput(nextEmpty);
    }
  };

  return (
    <div
      role="group"
      aria-label={t("snippets.attachedLabel", { name: snippet.name })}
      style={{
        marginBottom: 6,
        padding: "8px 10px",
        border: "1px solid var(--border)",
        borderRadius: "var(--radius-control)",
        background: "var(--bg-panel)",
        display: "flex",
        flexDirection: "column",
        gap: 8,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
        <span
          style={{
            flexShrink: 0,
            fontSize: 10,
            fontWeight: 600,
            letterSpacing: "0.05em",
            textTransform: "uppercase",
            padding: "1px 6px",
            borderRadius: 4,
            border: "1px solid var(--accent)",
            color: "var(--accent)",
            background: "color-mix(in srgb, var(--accent) 10%, transparent)",
          }}
        >
          {t("snippets.groupLabel")}
        </span>
        <span
          title={`/${snippet.name}`}
          style={{
            minWidth: 0,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            fontFamily: "var(--font-mono)",
            fontSize: 12,
            color: "var(--text)",
          }}
        >
          /{snippet.name}
        </span>
        {scopeLabel && (
          <span style={{ flexShrink: 0, fontSize: 10, color: "var(--text-dim)" }}>
            {scopeLabel}
          </span>
        )}
        <span
          aria-live="polite"
          style={{ marginLeft: "auto", flexShrink: 0, fontSize: 10, fontFamily: "var(--font-mono)", color: "var(--text-dim)" }}
        >
          {t("snippets.progressStatus", { filled, total: placeholders.length })}
        </span>
        <button
          type="button"
          onClick={onDetach}
          title={t("snippets.detachTitle")}
          aria-label={t("snippets.detachTitle")}
          style={{
            flexShrink: 0,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            width: 20,
            height: 20,
            borderRadius: "50%",
            padding: 0,
            background: "transparent",
            border: "none",
            cursor: "pointer",
            color: "var(--text-muted)",
            transition: "color var(--dur-fast) var(--ease-out-warm), background var(--dur-fast) var(--ease-out-warm)",
          }}
          onMouseEnter={(e) => { e.currentTarget.style.color = "var(--text)"; e.currentTarget.style.background = "var(--bg-hover)"; }}
          onMouseLeave={(e) => { e.currentTarget.style.color = "var(--text-muted)"; e.currentTarget.style.background = "transparent"; }}
        >
          <X size={12} strokeWidth={2} aria-hidden="true" />
        </button>
      </div>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        {placeholders.map((name, index) => {
          const inputId = `snippet-ph-${snippet.id}-${name}`;
          return (
            <div key={name} style={{ display: "flex", flexDirection: "column", gap: 3, minWidth: 140, flex: "1 1 160px" }}>
              <label
                htmlFor={inputId}
                style={{
                  fontSize: 10.5,
                  fontFamily: "var(--font-mono)",
                  fontWeight: 500,
                  color: "var(--text-muted)",
                  overflowWrap: "anywhere",
                }}
              >
                ${name}
              </label>
              <input
                ref={(node) => {
                  inputRefs.current[index] = node;
                }}
                id={inputId}
                value={values[name] ?? ""}
                onChange={(e) => onValueChange(name, e.target.value)}
                onKeyDown={(e) => handleKeyDown(e, index)}
                autoComplete="off"
                spellCheck={false}
                style={{
                  padding: "5px 8px",
                  background: "var(--bg)",
                  border: "1px solid var(--border)",
                  borderRadius: 6,
                  color: "var(--text)",
                  fontSize: 12,
                  outline: "none",
                  width: "100%",
                  boxSizing: "border-box",
                  transition: "border-color var(--dur-fast) var(--ease-out-warm), box-shadow var(--dur-fast) var(--ease-out-warm)",
                }}
                onFocus={(e) => {
                  e.currentTarget.style.borderColor = "var(--accent)";
                  e.currentTarget.style.boxShadow = "var(--focus-ring)";
                }}
                onBlur={(e) => {
                  e.currentTarget.style.borderColor = "var(--border)";
                  e.currentTarget.style.boxShadow = "none";
                }}
              />
            </div>
          );
        })}
      </div>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
        <span style={{ fontSize: 10, color: "var(--text-dim)" }}>
          {t("snippets.hintKeys")}
        </span>
        <button
          type="button"
          onClick={onSubmit}
          disabled={!allFilled}
          title={t("snippets.sendFilled")}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            padding: "5px 12px",
            background: allFilled ? "var(--accent-strong)" : "var(--bg-subtle)",
            border: "none",
            borderRadius: "var(--radius-control)",
            color: allFilled ? "var(--on-accent)" : "var(--text-dim)",
            cursor: allFilled ? "pointer" : "not-allowed",
            fontSize: 12,
            fontWeight: 600,
            opacity: allFilled ? 1 : 0.7,
            transition: "background var(--dur-fast) var(--ease-out-warm)",
          }}
          onMouseEnter={(e) => { if (allFilled) e.currentTarget.style.background = "var(--accent-hover)"; }}
          onMouseLeave={(e) => { if (allFilled) e.currentTarget.style.background = "var(--accent-strong)"; }}
        >
          {t("snippets.sendFilled")}
        </button>
      </div>
    </div>
  );
}
