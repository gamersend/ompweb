# Phase 9 — Context inspector (agent notes)

Implements BUILD-PLAN § Phase 9. Read-only over session `.jsonl` and omp's
`stats.db`; no new stores, no omp file writes.

## Files

New:
- `lib/session-tree.ts` — `buildEntryTree()` (pure core) +
  `readEntryTree(filePath)` (fs wrapper). Flattens the `(id, parentId)` entry
  tree into `{nodes, compactions, truncated}` for the inspector. Also exports
  `livePathIds()` and the 4 000-node `MAX_TREE_NODES` wire cap.
- `app/api/sessions/[id]/tree/route.ts` — GET, envelope `{success: true,
  data}`, `runtime = "nodejs"`, `no-store`. Returns tree + current `leafId` +
  `inContext` (buildSessionContext's compaction-collapsed window) +
  `livePath` + `contextGauge` (live child's `get_state.contextUsage`, null
  when no live session). 404 `session_file_malformed` / 413
  `session_file_too_large` exactly like the context route; `?leafId=`
  previews another branch, unknown ids fall back to the tip (resolved leaf is
  echoed in the payload).
- `components/ContextInspector.tsx` — the wide dialog: SVG connector layer +
  real `<button>` nodes positioned over it (one lane per depth, left→right;
  node width linear in estTokens, 4 px floor), live branch outlined in the
  accent, in-context range tinted, Scissors markers on compaction cuts,
  shared hover/focus tooltip (kind · time · tokens + exact marker · state ·
  first 80 chars), legend, and the "Top 5 heaviest entries" footer with
  est/exact totals vs the live context gauge.
- Tests: `lib/session-tree.test.mjs` (graph build from a written fixture,
  compaction markers, est-vs-exact, orphan/cycle tolerance, unknown kinds,
  node cap, route source contract, route in-process envelope test, i18n +
  wiring contract) and `components/ContextInspector.test.mjs` (render,
  click-nav via resolved leaf, hover tooltips incl. compaction
  tokensBefore/excerpt, fetch-failure text, closed-mounts-nothing +
  BranchNavigator trigger wiring).

Modified:
- `components/BranchNavigator.tsx` — the "open tree" affordance: a
  `GitGraph` footer row in the dropdown panel (inline + non-inline) that
  opens a self-contained `ContextInspector`; new optional
  `sessionId?: string | null` prop; inspector node clicks reuse
  `handleSelect` → the same `onLeafChange` path as branch-list clicks
  (dropdown closes when the dialog opens).
- `components/AppShell.tsx` — ONE anchored edit: pass
  `sessionId={selectedSession?.id ?? null}` to `BranchNavigator`.
- `lib/i18n/locales/{en,zh-CN,ja}.json` — `inspector.*` (27 keys each).

## Key decisions & deviations

- **Exact = output_tokens, not total_tokens.** stats.db `input/cache_*`
  columns describe the whole prompt turn, not the entry; using them for node
  width would break the shared visual scale with the chars/4 estimates. The
  exact value is the row's `output_tokens` (the message's own generation,
  which is what chars/4 approximates); `tokensIn/cacheRead/cacheWrite/
  totalTokens` still ride on the node for tooltips. Flagged `exact: true`.
- **Leaf resolution = findLeafForEntry semantics** (latest-timestamp child
  wins at every fork, "last appended wins"), computed bottom-up in one pass
  so EVERY node carries its `leafId` — clicking any node lands the
  transcript on its most recent continuation, matching the anchor-hop rule.
  Note the consequence: a *deeper* branch that is *older* loses to a
  *shallower but later* branch.
- **Node cap 4 000** (`MAX_TREE_NODES`, oldest kept, `truncated: true`
  surfaced in the UI) — bounds the wire payload and the DOM.
- **Dialog trigger lives in BranchNavigator only** (per plan's "Modified
  files"); the optional chat-header pill was skipped to keep the ChatWindow
  edit count at zero. The chat-header pill pattern (`SessionInsightsEntry`)
  is what the self-contained dialog design copies if it's ever wanted.
- **Layout**: lanes per depth get wide on long linear sessions (one lane per
  entry). Accepted per the plan's left→right lane spec; the graph panel
  scrolls both axes and the node cap bounds worst cases.
- **Route tests stub `resolveSessionPathOr404`/`getRpcSession`** by
  reassigning the jiti module's exports (jiti transpiles to CJS property
  reads, so call-time reassignment works); the same jiti instance + the
  `@/` alias (like `lib/file-index-route.test.mjs`) keeps module identity
  shared between the route and the stubs.
- `?refresh=1` is not wired for the tree route: the stats.db facts cache
  (60 s, per query shape) is the only cache involved, and the entry parse is
  the memoized (mtime/size) session-reader cache — both acceptably fresh for
  an inspector the user reopens on demand.

## Traps honored

- Estimation skips images (blob refs are tiny; inline base64 would explode
  chars/4).
- Unknown entry kinds become ordinary nodes; missing parents root at depth
  0; parent cycles terminate deterministically (documented in-module).
- The route reuses the context route's header-null → 413/404 split so giant
  sessions report `session_file_too_large` instead of looking empty.
- `buildSessionContext` is called with `deferThinking`/`deferToolResultImages`
  and only `.entryIds` survives into the payload — no message bodies shipped.
- i18n: all 27 keys in all three locales (contract-tested); raw omp entry
  type strings shown for uncommon kinds are data identifiers, matching
  BranchNavigator's existing `entry.type` fallback.
- Reduced motion: hover transition is gated through
  `usePrefersReducedMotion`; no other animation in the graph.
- A11y: nodes are real buttons (tab/Enter), aria-labels carry
  kind/time/tokens/state/preview, legend text + `≈`/`=` markers + dashed
  borders carry est-vs-exact — information is never color-only.

## AGENTS.md-ready block

```markdown
### Context inspector (P9)
- `GET /api/sessions/[id]/tree` (envelope route, nodejs) returns the
  flattened entry tree: `nodes[{id,parentId,kind,role?,ts,estTokens,exact,
  depth,leafId,preview,tokensIn?…}]`, `compactions[{entryId,
  firstKeptEntryId,tokensBefore,summaryExcerpt}]`, current `leafId`,
  `inContext` (buildSessionContext's compaction-collapsed window),
  `livePath`, `truncated` (4 000-node cap), and `contextGauge` (live child's
  `get_state.contextUsage`, null when the session isn't running).
- `lib/session-tree.ts`: estTokens = chars/4 (text-ish content, images
  skipped); a stats.db `messages` row matched by entry id replaces the
  estimate with the measured `output_tokens` and sets `exact: true` — turn
  columns (`tokensIn`/cache/`totalTokens`) ride along for tooltips only, they
  describe the prompt, not the entry. Orphans root at depth 0, parent cycles
  terminate deterministically, unknown kinds are ordinary nodes.
- `components/ContextInspector.tsx` mounts from the BranchNavigator dropdown
  footer (`GitGraph` icon, needs the `sessionId` prop AppShell passes);
  clicking a node navigates via `onLeafChange` to the node's `leafId`
  (findLeafForEntry semantics: latest child wins at forks). The live branch
  is outlined in `--accent`, the in-context range tinted, compaction cuts
  carry Scissors markers; the footer ranks the top 5 heaviest entries with
  est/exact totals vs the live context gauge. Node cap 4 000 (truncation is
  labeled); reduced-motion disables the hover transition; all states are
  carried by labels/tooltips/aria, never color alone.
```
