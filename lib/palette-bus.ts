"use client";

/**
 * Tiny event bus so deep surfaces (find bar "search all sessions" hand-off,
 * future notification rows) can open the command palette in a given mode
 * without importing the dynamically-loaded CommandPalette module (an eager
 * import would defeat AppShell's `next/dynamic` split).
 */

export type PaletteMode = "sessions" | "search";

export interface OpenPaletteDetail {
  mode: PaletteMode;
  /** Optional initial query (Search mode pre-fills the input). */
  query?: string;
}

const EVENT_NAME = "ompweb:open-palette";

export function openPalette(detail: OpenPaletteDetail = { mode: "sessions" }): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent<OpenPaletteDetail>(EVENT_NAME, { detail }));
}

/** Subscribe to open requests; returns the unsubscribe function. */
export function onOpenPalette(listener: (detail: OpenPaletteDetail) => void): () => void {
  if (typeof window === "undefined") return () => {};
  const handler = (event: Event) => {
    const custom = event as CustomEvent<OpenPaletteDetail>;
    listener(custom.detail ?? { mode: "sessions" });
  };
  window.addEventListener(EVENT_NAME, handler);
  return () => window.removeEventListener(EVENT_NAME, handler);
}
