"use client";

/**
 * Tiny window-event bus (the lib/palette-bus.ts pattern) that carries the
 * "a live voice call is hot" signal from the VoicePanel (inside ChatWindow)
 * to the AppShell topbar chip (⑦) without prop-drilling through two layers
 * or coupling the modules. No state is stored here: the chip owns its React
 * state, and the panel re-publishes on every phase change (so a chip that
 * mounts late still converges on the next transition).
 */

export interface LiveCallIndicatorDetail {
  active: boolean;
}

const EVENT_NAME = "ompweb:live-call-active";

/** Publish the current call-activeness (idempotent per value). */
export function setLiveCallActive(active: boolean): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent<LiveCallIndicatorDetail>(EVENT_NAME, { detail: { active } }));
}

/** Subscribe to call-activeness changes; returns the unsubscribe function. */
export function onLiveCallChange(listener: (active: boolean) => void): () => void {
  if (typeof window === "undefined") return () => {};
  const handler = (event: Event) => {
    const custom = event as CustomEvent<LiveCallIndicatorDetail>;
    listener(Boolean(custom.detail?.active));
  };
  window.addEventListener(EVENT_NAME, handler);
  return () => window.removeEventListener(EVENT_NAME, handler);
}
