"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Copy, Download, FileCode2, FileText, Share2 } from "lucide-react";
import { toast } from "./ui/toast";
import { translate, useI18n } from "@/lib/i18n";
import { copyText } from "@/lib/clipboard";
import { canWebShare, shareText } from "@/lib/web-share";

/**
 * Session download menu (6c): the chat-header entry point that used to be the
 * single "full history" (HTML export) button. Offers the HTML export, the
 * in-process Markdown download (?format=md), a session-level
 * "Copy as Markdown", and (P18/R3-26) a "Share…" entry for browsers with the
 * Web Share API. Owns its open state so AppShell keeps a one-line
 * mount; closes on outside click, Esc and re-render-unmount with focus
 * returned to the trigger.
 */
export function SessionExportMenu({ sessionId, onViewHtml, disabled }: {
  sessionId: string | null;
  /** Existing AppShell handler — opens the HTML export in a new tab. */
  onViewHtml: () => void;
  disabled?: boolean;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  // P18 (R3-26) capability, detected after mount so SSR and the first client
  // render agree (both false) and hydration never flips the item in.
  const [canShare, setCanShare] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => () => clearTimeout(timerRef.current), []);

  // P18: the Web Share entry only exists where the API exists (Firefox and
  // most desktop browsers hide it entirely instead of failing at click time).
  useEffect(() => {
    setCanShare(canWebShare());
  }, []);

  const close = useCallback((restoreFocus: boolean) => {
    setOpen(false);
    if (restoreFocus) buttonRef.current?.focus();
  }, []);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (menuRef.current?.contains(target) || buttonRef.current?.contains(target)) return;
      close(false);
    };
    // Fixed positioning follows the trigger even inside the compact topbar's
    // overflow containers (which would clip an absolutely positioned panel).
    const rect = buttonRef.current?.getBoundingClientRect();
    if (rect && menuRef.current) {
      menuRef.current.style.top = `${rect.bottom + 6}px`;
      menuRef.current.style.right = `${Math.max(6, window.innerWidth - rect.right)}px`;
    }
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => document.removeEventListener("pointerdown", onPointerDown, true);
  }, [open, close]);

  const mdUrl = sessionId
    ? `/api/sessions/${encodeURIComponent(sessionId)}/export?format=md`
    : null;

  const downloadMarkdown = () => {
    if (!mdUrl) return;
    close(true);
    const link = document.createElement("a");
    link.href = mdUrl;
    link.download = "";
    document.body.appendChild(link);
    link.click();
    link.remove();
  };

  const copyMarkdown = () => {
    if (!mdUrl) return;
    close(true);
    void fetch(mdUrl)
      .then(async (response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return response.text();
      })
      .then((text) => copyText(text))
      .then(() => {
        setCopied(true);
        clearTimeout(timerRef.current);
        timerRef.current = setTimeout(() => setCopied(false), 1500);
      })
      .catch(() => toast.error(translate("errors.generic")));
  };

  // P18 (R3-26) Web Share: the SAME markdown endpoint the Copy entry uses
  // (never a second composer), handed to navigator.share via lib/web-share.
  // "shared" toasts; "cancelled" (sheet dismissed / refused) is silent; the
  // "unsupported" outcome cannot reach here — the item is hidden when the
  // capability check fails at mount.
  const shareMarkdown = () => {
    if (!mdUrl) return;
    close(true);
    void fetch(mdUrl)
      .then(async (response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return response.text();
      })
      .then((text) => shareText(t("exportShare.title"), text))
      .then((outcome) => {
        if (outcome === "shared") toast.success(translate("exportShare.shared"));
        // cancelled: the user closed the share sheet — nothing to say.
      })
      .catch(() => toast.error(translate("errors.generic")));
  };

  const items = [
    { key: "html", label: t("sessionExport.viewHtml"), Icon: FileCode2, onClick: () => { close(true); onViewHtml(); } },
    { key: "md", label: t("sessionExport.downloadMarkdown"), Icon: Download, onClick: downloadMarkdown },
    { key: "copy-md", label: copied ? t("sessionExport.copied") : t("sessionExport.copyMarkdown"), Icon: Copy, onClick: copyMarkdown },
    ...(canShare && mdUrl
      ? [{ key: "share-md", label: t("exportShare.menu"), Icon: Share2, onClick: shareMarkdown }]
      : []),
  ];

  return (
    <span style={{ position: "relative", display: "inline-flex" }}>
      <button
        ref={buttonRef}
        onClick={() => setOpen((value) => !value)}
        disabled={disabled}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={t("sessionExport.menu")}
        title={disabled ? t("appShell.fullHistoryUnavailable") : t("sessionExport.menu")}
        className="shell-toolbar-btn ui-focus-ring"
      >
        <FileText size={16} strokeWidth={1.8} aria-hidden="true" />
      </button>
      {open && (
        <div
          ref={menuRef}
          role="menu"
          aria-label={t("sessionExport.menu")}
          className="dropdown-surface"
          style={{
            position: "fixed",
            right: 8,
            zIndex: 220,
            display: "flex",
            flexDirection: "column",
            minWidth: 210,
            padding: 4,
            gap: 2,
            boxShadow: "var(--shadow-pop)",
            borderRadius: "var(--radius-control)",
          }}
        >
          {items.map(({ key, label, Icon, onClick }) => (            <button
              key={key}
              role="menuitem"
              type="button"
              onClick={onClick}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                padding: "7px 9px",
                border: "none",
                borderRadius: 6,
                background: "transparent",
                color: "var(--text)",
                cursor: "pointer",
                textAlign: "left",
                fontSize: 12.5,
              }}
              onMouseEnter={(e) => { e.currentTarget.style.background = "var(--bg-hover)"; }}
              onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}
            >
              <Icon size={14} strokeWidth={1.8} aria-hidden="true" style={{ color: "var(--text-muted)" }} />
              {label}
            </button>
          ))}
        </div>
      )}
    </span>
  );
}
