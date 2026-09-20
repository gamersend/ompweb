/**
 * Tiny window-event bus for pushing text into the chat composer from outside
 * it (P8 memory browser "insert into composer"; later phases reuse it) —
 * palette-bus.ts style: no import of the dynamically-loaded composer module,
 * no prop drilling, and never an auto-send.
 *
 * The event carries an optional `draftKey` so only the composer bound to that
 * session draft answers it (split view mounts two ChatInput instances); a
 * detail without `draftKey` targets whichever composer is mounted first.
 */

export interface ComposerInsertDetail {
  text: string;
  /** Session draft key (`<sessionId>` or `new:<cwd>`); omit for "any". */
  draftKey?: string;
  /** Where the insert came from (annotation only, e.g. "memory"). */
  source?: string;
}

const EVENT_NAME = "ompweb:composer-insert";

export function insertIntoComposer(detail: ComposerInsertDetail): void {
  if (typeof window === "undefined") return;
  if (!detail.text) return;
  window.dispatchEvent(new CustomEvent<ComposerInsertDetail>(EVENT_NAME, { detail }));
}

/** Subscribe to insert requests; returns the unsubscribe function. */
export function onComposerInsert(
  listener: (detail: ComposerInsertDetail) => void,
): () => void {
  if (typeof window === "undefined") return () => {};
  const handler = (event: Event) => {
    const custom = event as CustomEvent<ComposerInsertDetail>;
    const detail = custom.detail;
    if (!detail?.text) return;
    listener(detail);
  };
  window.addEventListener(EVENT_NAME, handler);
  return () => window.removeEventListener(EVENT_NAME, handler);
}
