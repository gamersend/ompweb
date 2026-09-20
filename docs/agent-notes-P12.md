# Phase 12 — Split view (agent notes)

Two sessions — or two branches of one session — sit side by side, each fully
live, with a draggable divider. Desktop only; mobile falls back to a single
view by itself.

## Files

### New
- `components/SplitPane.tsx` — two-pane flex container. Draggable divider
  (same pattern as the right-file-panel resize: window mousemove, body cursor
  lock, `--ui-scale` correction, width written to a CSS var so dragging never
  re-renders the chats). Committed width persists under
  `omp-web:split-width`; double-click (or Enter/Space on the focused divider)
  resets 50/50 and clears the stored value. The divider is a `separator`
  slider (ArrowLeft/ArrowRight resize, visible focus ring). The ACTIVE pane
  carries a 2px `var(--accent)` ring; clicking/focusing a pane activates it,
  and Ctrl/Cmd+[ / Ctrl/Cmd+] switch panes (focus follows). `useIsMobile`
  gate: on mobile the component renders the left pane only — no divider, no
  pane chrome — so no URL state can force two columns on a phone.
- `hooks/useSplitSession.ts` — the split-specific glue around the second
  pane's full `ChatWindow` (whose per-mount `useAgentSession` IS the second
  instance): resolves `&split=` → `SessionInfo` from the session list (with a
  transient fallback so an in-flight/unknown id still mounts a pane), turns
  `&splitLeaf=` into a monotonic `AnchorRequest` (reusing the P1 anchor API's
  one `?forEntry=` branch hop), and forwards close.
- `hooks/useSplitSession.test.mjs` — fan-out verification + split glue tests
  (see "The fan-out verdict" below).
- `components/SplitPane.test.mjs` — width persistence, 50/50 reset, mobile
  gate, divider slider a11y, pane ring + Ctrl/Cmd-[ / Ctrl/Cmd+] switching,
  close hand-off, min-width clamping.

### Modified
- `components/AppShell.tsx` — URL state `&split=<sessionId>[&splitLeaf=<leafId>]`
  (same conventions as `session`/`anchor`: params preserved on write, shareable,
  restored on reload; pane close clears both). Chat-header "Split right" toggle
  button (`Columns2`, `aria-pressed`) next to the branch navigator; Ctrl/Cmd+\
  toggles split (new `onToggleSplit` option in `useGlobalKeyboardShortcuts`).
  The main `ChatWindow` JSX was hoisted into `mainChatNode` so the split layout
  drops it into `SplitPane`'s left slot without duplicating the prop list; the
  right pane renders a second `ChatWindow` keyed `split:<sessionId>`. Deleted
  sessions close the split if they were the split target. `onSplitSession`
  (flag-gated) is threaded into the sidebar; `onCompareLeaf` into
  `BranchNavigator`.
- `components/AppShell-layout.tsx` — `SPLIT_WIDTH_STORAGE_KEY`,
  `SPLIT_MIN_WIDTH` (280), `clampSplitWidth` (container-width aware; with no
  measurable container only the minimum applies), `loadSplitWidth`.
- `components/BranchNavigator.tsx` — "compare" affordance: a `Columns2` button
  per tree node (prop `onCompareLeaf`); click opens the split pane on that
  leaf. Kept out of the row's select handler via stopPropagation (and a
  keydown guard so Enter/Space on the button doesn't also navigate); the memo
  comparator watches `onCompare`.
- `components/SessionSidebar.tsx` + `components/SessionSidebar-rows.tsx` —
  "Split right" item in the session row's action menu, threaded
  AppShell → ProjectRow → SessionTreeItem → SessionItem with stable callbacks
  so the memo comparators stay effective (tree item's comparator extended).
- `hooks/useKeyboardShortcuts.ts` — `onToggleSplit` option (Ctrl/Cmd+\).
- `lib/feature-flags.ts` — `split` default flipped to ON (Phase 12 contract).
- `lib/i18n/locales/{en,zh-CN,ja}.json` — `splitView.*` (8 keys × 3 locales).
- `lib/feature-flags.test.mjs` — expectations updated to the split-ships-on
  contract (the file's own `SHIP_ENABLED` set already anticipated P12; the two
  merged-list assertions were stale against it).

## The fan-out verdict (the one known plumbing risk)

**No fix was needed: fan-out already exists at every layer.**

- `AgentSessionWrapper` keeps `listeners` as an ARRAY;
  `emit()` iterates all of them (with per-listener try/catch isolation)
  (`lib/rpc-manager.ts`). N attached UIs each receive every frame, stamped
  with the same wrapper-level `web` cursor.
- `GET /api/agent/[id]/events` attaches **one listener per HTTP connection**
  (`session.onEvent(...)` in `start(controller)`) and detaches it on
  disconnect/abort. There is no single-subscriber gate, no listener
  replacement, and no second child spawn (observer-only 409 when no wrapper).
- `startRpcSession` returns the SAME wrapper for the same session id
  (globalThis registry + shared start lock), so two panes = one child process
  + two SSE streams. A send from one pane dispatches exactly one `prompt`.

Verified explicitly (not by source reading alone):
1. Real `AgentSessionWrapper` + two `onEvent` subscribers: identical frames,
   order, and `web` cursors to both; detaching one leaves the other live
   (`useSplitSession.test.mjs`, "fans out to N subscribers").
2. SSE route source contract: per-connection attach/detach, observer-only.
3. Two full `useAgentSession` instances mounted against one session id (fake
   EventSource/fetch world): each pane owns its EventSource, hydration, and
   optimistic bubble; one send → exactly one prompt POST; A's optimistic
   bubble never appears in B; both panes see the same run through their own
   streams and settle to idle together ("no run-id cross-bleed": run ids are
   per-instance refs; incoming events carry only the wrapper cursor, so both
   instances track the shared run independently).

## Interaction notes

- Run ids: each pane's `promptRunIdRef` is instance-local, so a send in one
  pane cannot fence or resurrect the other's state. Both panes render the
  shared live run (that is the point of "each fully live").
- Esc-to-abort is a single global registration (`registerAbortHandler`);
  with two ChatWindows mounted, the most recently mounted pane owns Esc. Both
  panes' stop buttons always target their own session. Acceptable for P12;
  revisit only if per-pane Esc is ever reported.
- Queued-message persistence (`useAgentSession-queue`) is keyed by session id
  in sessionStorage, so two panes on the SAME session share that key. Queue
  writes happen only around sends; a same-session split rarely queues in both
  panes simultaneously. Accepted as a known, benign edge.
- `host_tool_call` / `extension_ui_request` frames are emitted to all
  listeners: with a same-session split, either pane can answer an approval
  dialog (the wrapper settles the first response and forgets the request).
- Selecting a different main session does NOT close the split — the two panes
  are independent (that is the two-different-sessions use case).
- The split `ChatWindow` gets a minimal prop set (no `chatInputRef`,
  no `onBranchDataChange`/system-prompt wiring — the top bar follows the main
  pane). It has a full composer: you can prompt from either pane.

## Deviations from the plan text

1. **"Tab context menu"** — the app has no session tab bar (its TabBar is
   file tabs in the right panel). The "Split right" action landed in the two
   places session actions actually live: the chat header toolbar and the
   sidebar session row's action menu (the session list's context-menu
   equivalent).
2. **`useSplitSession` hosts the glue, not the hook instance** — the plan
   said "the second pane's session state via a second `useAgentSession`
   instance". That second instance is real but lives inside a second full
   `ChatWindow` (the only way to get the complete composer/tool/streaming UX
   without duplicating ~2k lines); `useSplitSession` owns the id→SessionInfo
   resolution, the splitLeaf→AnchorRequest mapping, and close. The
   same-session×2 fan-out and cross-bleed verification the plan asked for is
   in `hooks/useSplitSession.test.mjs` and passes against the real wrapper.
3. **Divider keyboard step is ±10px with Enter to reset** (matching the right
   panel handle's conventions); Home/End were not added.
4. **Right-pane width clamps to `SPLIT_MIN_WIDTH` on both sides of the
   container** so the left pane never starves; with no measurable container
   (SSR/tests) only the minimum applies.

## AGENTS.md-ready block

```markdown
### Split view (P12)
- `&split=<sessionId>[&splitLeaf=<leafId>]` URL params mirror
  `session`/`anchor`; the pane close (X) clears both. Desktop only — the
  `split` flag (default ON) plus a `useIsMobile` gate inside SplitPane fall
  back to single view; no URL state can force split on mobile.
- The right pane is a second full `ChatWindow` → its own `useAgentSession`
  instance (own SSE stream, run ids, optimistic state). Same session in both
  panes is supported: `AgentSessionWrapper.emit` fans out to an array of
  listeners and the events route attaches one listener per HTTP connection,
  so one omp child serves both panes (verified in
  `hooks/useSplitSession.test.mjs`, same-session×2).
- `useSplitSession` maps `splitLeaf` to the P1 anchor API (`?forEntry=` one
  hop) — branch compare reuses deep-link plumbing, no new route params.
- Divider width persists in `omp-web:split-width`
  (`components/AppShell-layout.tsx` constants); double-click resets 50/50.
  Ctrl/Cmd+\ toggles split; Ctrl/Cmd+[ / Ctrl/Cmd+] switch panes; the divider
  is an arrow-key `separator` slider; the active pane shows an accent ring.
- Entries to the feature: chat header `Columns2` button (Ctrl/Cmd+\), sidebar
  session row menu "Split right", branch navigator per-node compare button.
  All gated by `isEnabled("split")` + desktop.
```
