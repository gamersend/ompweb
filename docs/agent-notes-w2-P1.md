# Wave 2 — Phase 1: Client-state sync (agent notes)

## What changed

Bookmarks, global prompt history, workspace last-open sessions, and the
steer/queue composer preference are now synced across devices through a small
per-install server store. Everything stays **local-first**: a local write
always lands in localStorage before any network activity, and every sync
failure is silent — offline behaves exactly like the pre-sync app. The
Settings → general toggle **"Sync across devices"** (localStorage
`omp-web:sync-enabled`, default ON) stops both pushing and pulling when off;
local behavior keeps working while off and queued changes flush on re-enable.

Drafts (`lib/draft-store.ts`, sessionStorage) and `omp-web:notify-last-read`
are deliberately NOT synced — drafts are mid-typing, tab-scoped state and the
unread cursor is per-device. Bookmark/prompt DELETION also does not truly
propagate: the contract is additive union / LWW, so any device still holding
an entry resurrects it on the next pull (no tombstones in this phase).

## Files

New:
- `lib/client-state-store.ts` — server store at `~/.omp/agent/web-client-state.json`
- `lib/client-state-merge.ts` — pure merge math (unit-tested, no I/O)
- `lib/client-state-sync.ts` — client engine + per-store adapters + `initClientStateSync()`
- `lib/client-state-store.test.mjs`, `lib/client-state-merge.test.mjs`, `lib/client-state-sync.test.mjs`
- `app/api/client-state/route.ts` — GET/PUT (nodejs runtime)

Modified:
- `lib/workspace-memory.ts` — added `setWorkspaceMemoryStorage()` injectable-getter seam + exported `WORKSPACE_MEMORY_STORAGE_KEY` (existing per-call `storage` args unchanged; wave-1 tests untouched)
- `lib/composer-prefs.ts` — added `setComposerPrefsStorage()` seam; reads/writes now go through it (defaults identical); exported `SUBMIT_DURING_RUN_STORAGE_KEY`
- `components/AppShell.tsx` — mounts `initClientStateSync()` on mount (idempotent, dispose on unmount — Strict Mode safe)
- `components/SettingsConfig.tsx` — "Sync across devices" toggle row in Settings → general (+ search index entry)
- `lib/i18n/locales/{en,zh-CN,ja}.json` — `sync.label` / `sync.desc` appended after `settingsConfig.promptHistoryDescCount` in all three

## Server contract (as shipped)

```
// ~/.omp/agent/web-client-state.json
interface ClientStateStore { version: 1; rev: number;
  keys: Record<string, { rev: number; value: unknown }>; }
GET /api/client-state?since=<rev> → { success, data: { rev, keys: {k:{rev,value}} } }   // keys with rev > since; no since → all
PUT /api/client-state { key, value, baseRev? }   → { success, data: { rev } }
409 → { success: false, error: { code: "conflict", currentRev } }
```

- Store follows the wave-1 Store versioning pattern (same as
  `project-registry`/`snippets`): `version` field, `migrateClientState()`
  returns null for foreign shapes, atomic temp+rename writes, corrupt file
  quarantined to `web-client-state.json.bak-<ts>`, empty store rebuilt.
- Caps: 256 keys (evict lowest-rev first), 256 KB per value
  (`value_too_large`, 413), keys printable ASCII ≤ 256 chars.
- Runtime keeps the store in memory (globalThis `__ompClientStateRuntime`,
  hot-reload safe) with a 1 s debounced flush; `flushClientStateSync()` forces
  the write. The 1 s debounce is why GETs never hit disk twice.
- `rev` is one store-wide monotonic counter; each key stores the rev it was
  last written at. `baseRev` mismatch → the 409 above. Missing key counts as
  rev 0.
- Wire bodies go through `parseJsonWithinLimit` (cap = 4× value cap + 64 KB,
  mirroring the file-editor route math); GET/PUT set `Cache-Control: no-store`.

## Client design

**Namespaces:** `bookmarks/<sessionId>` (array), `prompt-history` (array),
`workspace-memory` (object of `{id, ts}` per raw workspace key),
`composer-prefs` (`{value, ts}` wrapper — the local value has no ts, so the
adapter shadows timestamps).

**Seams:** the engine installs one observing storage proxy into all four
injectable getters (`setBookmarksStorage`, `setPromptHistoryStorage`,
`setWorkspaceMemoryStorage`, `setComposerPrefsStorage`). The proxy delegates
every read/write to the real storage unchanged and observes watched keys →
dirty flag → 1 s debounced PUT. Writes land through the same seam the stores
already use, so pulled changes propagate cross-tab via the existing `storage`
listeners for free.

**Adapters (`KeyAdapter`):** local-key discovery, read/serialize, write-through,
and a merge call per namespace. Workspace-memory shadows per-key timestamps in
memory (first sight stamps `now`, a local change restamps; pulled remote ts is
adopted on apply so pushes serialize byte-identically). Composer prefs shadows
one timestamp the same way.

**Push:** local-first write → observe → 1 s debounce → PUT with the best-known
baseRev (pulled rev hint → memoized rev → 0). On 409: refetch the key, re-merge
(pure merge), converge local if the union differs, retry PUT ONCE with the
server's currentRev; a second 409 (or any failure) gives up silently until the
next cycle.

**Pull:** every 15 s while the tab is visible + on `visibilitychange`→visible +
`online` + when the toggle is re-enabled (the `useNotifyFeed` discipline).
Incremental via `?since=lastRev`; full GET on first contact and for conflict
refetches. Per key: `merged = merge(local, remote)`; if merged ≠ local →
write-through; if merged == remote → memoize (rev, json) — server already holds
the union; else mark dirty (local ahead). Foreign/future namespaces are ignored
(incremental pulls move `since` past them).

**Loop guards:** (a) per-key memo of lastPushed/applied `{rev, json}` — a push
whose serialized local state equals the memo is skipped; (b) pulled values are
memoized so our own write-through never re-pushes; (c) `syncValuesEqual` is
key-order AND array-order insensitive — merge outputs are canonically sorted,
so a differently-ordered-but-equivalent server value never triggers churn.
Deletions are still local-first and pushed, but any other copy union-restores
(see above).

**LWW note (documented edge):** `mergeWorkspaceMemory`/`mergeComposerPrefs`
compare via `comparableProjectPath` identity — Windows casing/separator
variants collapse to one workspace and the newer side's raw key spelling wins,
so a device whose path casing differs only re-gains restore after the session
is opened again there.

## Tests (37 new, colocated)

- `lib/client-state-merge.test.mjs` — union/LWW/note-merge math, cap-200
  re-sort, comparable-path identity, malformed-row tolerance, equality helper.
- `lib/client-state-store.test.mjs` — migrate/quarantine (temp agent dir via
  `PI_CODING_AGENT_DIR`), put validation, rev conflicts, 256-key eviction,
  value cap, debounced flush (mock timers), round-trip, atomic rename, plus a
  route source-contract drift test (nodejs runtime, no-store, bounded body,
  409 shape).
- `lib/client-state-sync.test.mjs` — adapter-level with injectable
  storage/fetch: local-first debounced push, echo guard, pull apply/merge,
  409 refetch-remerge-retry-once, adopt-server-union, offline silence,
  disabled-mode (no traffic, dirty survives re-enable), per-namespace pulls
  (bookmarks/prompt-history/workspace/prefs), unknown-namespace skip, dispose,
  idempotent init, union-resurrect semantics.

## Gate results

- `node_modules/.bin/tsc --noEmit` → 0 errors
- `npm run lint` → 0 errors, 0 warnings
- `npm test` → 1359 tests: **1358 pass, 0 fail, 1 skipped** (pre-existing skip)

---

## AGENTS.md-ready section (fold into "Key Design Decisions & Traps")

### Client-state sync (`lib/client-state-*.ts`, `/api/client-state`) (W2-P1)
- Bookmarks, prompt history, workspace last-open, and the composer steer/queue
  pref sync across devices through `~/.omp/agent/web-client-state.json`
  (omp-web's own store — wave-1 Store pattern: version + migrate + atomic
  temp+rename + corrupt-file quarantine to `*.bak-<ts>`). `rev` is one
  store-wide monotonic counter, per-key revs gate optimistic concurrency:
  `PUT {key,value,baseRev?}` → 409 `{error:{code:"conflict",currentRev}}` on
  mismatch. Caps: 256 keys (evict lowest-rev), 256 KB/value
  (`value_too_large`). Mutations flush through a 1 s debounced write
  (globalThis `__ompClientStateRuntime`, hot-reload safe).
- `GET /api/client-state?since=<rev>` returns keys with per-key rev > since
  (`Cache-Control: no-store`); bodies bounded via `parseJsonWithinLimit`.
- Client engine `lib/client-state-sync.ts`: ONE `initClientStateSync()` mounted
  from AppShell (idempotent, returns dispose). It installs an observing
  storage proxy into the four storage seams (`setBookmarksStorage`,
  `setPromptHistoryStorage`, `setWorkspaceMemoryStorage`,
  `setComposerPrefsStorage`) — local writes always land first, then a 1 s
  debounced PUT. Pulls: 15 s while visible + visibilitychange/online, then
  merge via pure `lib/client-state-merge.ts` (bookmarks union by entryId,
  newer ts, longer note; prompts dedupe on text max-ts cap 200; workspace
  memory per-key LWW over comparable-path identity; prefs whole-value LWW with
  a `{value, ts}` wrapper). 409 → refetch, re-merge, retry once, then stay
  silent until the next cycle. ALL sync failures are silent; offline is
  byte-for-byte today's behavior.
- Loop guards: per-key lastPushed `{rev, json}` memo + `syncValuesEqual`
  (key- AND array-order-insensitive — merge outputs are canonically sorted, so
  equivalent-but-reordered server values never re-push).
- Settings → general toggle "Sync across devices" (`omp-web:sync-enabled`,
  default ON; OFF stops pushing AND pulling, queued local changes flush on
  re-enable). i18n keys under `sync.` in all three locales.
- NOT synced by design: composer drafts (tab-scoped sessionStorage),
  `omp-web:notify-last-read` (per-device unread cursor), and true deletions —
  the merge is additive union/LWW, so any device still holding an entry
  resurrects it (tombstones would be a later phase).
