"use client";

/**
 * The ⑦ live-call indicator: a pulsing mic chip in the AppShell topbar (next
 * to the notifications bell) plus the "🎤 " document.title prefix, shown
 * while a /live call is hot. Fed by the lib/live/live-indicator.ts window
 * bus — the VoicePanel publishes, this component only consumes, so the chat
 * surface and the shell stay decoupled.
 *
 * Reduced motion: the pulse animation is gated in app/globals.css via
 * prefers-reduced-motion, like every other live-lane animation. The title
 * prefix is restored on deactivate and on unmount.
 */

import { useEffect, useState } from "react";
import { Mic } from "lucide-react";

import { useI18n } from "@/lib/i18n";
import { onLiveCallChange } from "@/lib/live/live-indicator";

const LIVE_TITLE_PREFIX = "🎤 ";

export function LiveCallChip() {
  const { t } = useI18n();
  const [active, setActive] = useState(false);

  useEffect(() => onLiveCallChange(setActive), []);

  // Own the title prefix while active; the cleanup restores the pre-call
  // title exactly once per activation.
  useEffect(() => {
    if (!active) return;
    const base = document.title;
    if (!base.startsWith(LIVE_TITLE_PREFIX)) {
      document.title = `${LIVE_TITLE_PREFIX}${base}`;
    }
    return () => {
      const current = document.title;
      document.title = current.startsWith(LIVE_TITLE_PREFIX) ? current.slice(LIVE_TITLE_PREFIX.length) : base;
    };
  }, [active]);

  if (!active) return null;
  return (
    <span
      role="status"
      aria-label={t("live.liveIndicator")}
      title={t("live.liveIndicator")}
      style={{
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        width: 28,
        height: 28,
        borderRadius: "50%",
        color: "var(--status-success)",
        background: "var(--bg-panel)",
        border: "1px solid var(--border)",
        flexShrink: 0,
      }}
    >
      <Mic size={15} strokeWidth={2} aria-hidden="true" className="omp-live-indicator-pulse" />
    </span>
  );
}
