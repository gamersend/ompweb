# P2 — Notifications + webhooks (agent notes)

Phase 2 of BUILD-PLAN.md, implemented 2026-09-19. Status: gate green
(`tsc --noEmit` clean apart from foreign parallel-lane errors in
`components/ChatInput.tsx` + `components/SnippetDialogs.tsx` ·
`npm test` 918 pass / 0 fail / 1 pre-existing skip ·
`npm run lint` 0 errors; warnings pre-existing in
`android/app/build/.../native-bridge.js`, none from P2 files).

AGENTS.md was NOT touched (hard constraint) — the ready-to-fold block is at
the bottom of this file.

## Files created

| File | Purpose |
|---|---|
| `lib/feature-flags.ts` | Flag set `{ terminal, split, scheduler, herdrAttach, nativeStats }` per § Cross-cutting patterns. `readFlags()` = env `OMP_WEB_FLAGS` ∪ localStorage `omp-web:flags` (enable-only union; storage adds what env omits and vice versa). `parseFlagList` drops unknown names; `isEnabled` is the one-line entry-point guard. Env detection defaults: `herdrAttach` on only with `OMP_WEB_HERDR_BIN`; `nativeStats` follows an injectable probe (`setNativeStatsProbe`) so P7's stats reader can report stats.db existence without dragging `fs` into this client-bundleable module (client default off). |
| `lib/notify/notify-shared.ts` | Pure contracts shared client+server (no fs — imported by the hook): `NotifyRow`/`NotifyConfig` types, `dedupKeyFor(kind, sessionId, token)`, `validateWebhookUrl` (https anywhere; plain http only for `localhost`/`127.x`/`[::1]`), `maskWebhookUrl` (`configured` + host, never the URL), `isInQuietHours` (`[from, to)` local window, midnight-crossing, browser-only by contract), `migrateNotifyConfig`/`parseNotifyConfig` (accepts `{version:1}` and pre-versioning `{browser,webhook}`; forced-enabled with an unacceptable URL degrades to disabled), `applyNotifyConfigUpdate` (field-wise validation, error codes `invalid_provider` / `invalid_events` / `invalid_url` / `insecure` / `invalid_enabled` / `url_required` / `invalid_quiet_hours`; enabling without a valid URL is refused). `WEBHOOK_FAILURE_ID_PREFIX = "wherr-"` is the delivery-loop guard. |
| `lib/notify/feed.ts` | 500-row ring buffer (newest first) + persisted tail `~/.omp/agent/web-notify.json`, atomic temp+rename writes on a 2 s debounce, mode 0600. State lives on `globalThis.__ompNotifyFeed` (hot-reload safe). `pushNotifyRow` dedups by id (= `dedupKeyFor` output); pruning the cap frees pruned ids. `since(id)` returns rows newer than the cursor; unknown/pruned cursor → full history. `markDelivered(ids)` flips `delivered` (browser-ping proof). `migrateNotifyFeed`/`parseNotifyFeed` + corrupt-file quarantine to `*.bak-<ts>` (never silent data loss). Best-effort flush on process exit. |
| `lib/notify/notify-config.ts` | `~/.omp/agent/web-notify-config.json` store: load/migrate (corrupt → quarantine + defaults), save atomic temp+rename with mode 0600 (the URL may embed provider tokens — treat like omp's local secrets), `updateNotifyConfig` = load + validate + persist in one step. |
| `lib/notify/webhook.ts` | `buildWebhookRequest` per provider: ntfy (POST text, `X-Title` + `Priority: high` for error/approval), discord (embed JSON), telegram (`chat_id` lifted from the configured URL's query into the JSON body, `text` = title+body), generic (full row as JSON). `deliverWebhook`: undici fetch, 5 s `AbortSignal.timeout`, exactly one retry (non-2xx and throws both count); bodies drained so sockets return to the pool. `dispatchWebhookForRow`: fire-and-forget — checks enablement + per-event allowlist, skips `wherr-` rows (never re-notifies its own failures), lands failures as deduped `kind:"error"` feed rows. `runWebhookTest` awaits a bounded delivery for the settings test button. Delivery counters on globalThis, surfaced in GET. Test fetch seam: `setWebhookFetchImpl`. |
| `lib/notify/emit.ts` | The central emits rpc-manager calls: `notifyAgentEnd` (token = per-wrapper run counter), `notifyApprovalNeeded` (token = extension-UI frame id), `notifyRpcError` (token = response frame id / counter / `process-exit`). Each pushes the feed row (dedup) then fire-and-forget dispatches the webhook. Server copy is English; the browser composes localized titles via `notify.rowTitle.*` and falls back to `row.title`/`row.body`. |
| `app/api/notify/route.ts` | `runtime = "nodejs"`, `{ success, data }` envelope. `GET ?since=` → `{ rows, config (masked), webhookDeliveries }`. `PUT` → validated config update, masked echo (`configured` + `host`, `url: ""` always). `POST {action:"test"}` → awaited bounded webhook test delivery (settings gesture only); `POST {action:"delivered", ids}` → `markDelivered`; `POST {action:"seed-test-row"}` → feed-only preview row (no webhook needed). |
| `components/NotificationsBell.tsx` | Header bell: unread badge (99+ cap), dropdown (`role="region"`) with rows (kind chip, session title, body, project label, relative time), click → open session; mark-all-read, test notification (feed row), settings deep-link buttons. A11y: `aria-expanded`/`aria-haspopup` on the button, Esc closes + focus returns to the button, outside-pointer closes, hidden `aria-live="polite"` status for unread count. `formatRelativeAge` exported (pure, unit+count → i18n `notify.time.*`). |
| `components/NotificationsConfig.tsx` | Settings → Notifications section: browser toggle (requests permission ONLY inside the toggle gesture; refused unless granted), permission status line (`aria-live`), quiet hours (time inputs, apply/clear, copy states feed+webhook still record), webhook card (enable toggle, provider select, WRITE-ONLY URL input — typed once, never displayed back, only "configured (host)", hint states the https-or-loopback + credential policy), per-event checkboxes, test button (awaits `POST {action:"test"}` and toasts the outcome), delivery counters, feed preview (8 rows). |
| Tests | `lib/feature-flags.test.mjs` (parse, env∪storage merge + precedence, env-detection defaults, probe throw degrade), `lib/notify/feed.test.mjs` (migrate v1 + pre-versioning + reject, dedup keys, 500-ring + id freeing, `since`, atomic persist + reload, corrupt quarantine, markDelivered), `lib/notify/notify-config.test.mjs` (URL validation matrix, masked echo, quiet-hours edges incl. midnight crossing + exclusivity, migrate/quarantine, enabled-requires-URL, update paths, round trip), `lib/notify/webhook.test.mjs` (all four provider payload shapes, timeout+retry+non-2xx+insecure refusals, allowlist gate, `wherr-` loop guard, failure rows deduped, stats, test action + unconfigured short-circuit), `hooks/useNotifyFeed.test.mjs` (unread math, notification gate truth table, localized row copy, poll/visibility/online wiring source assertions, hydrate-without-ping vs new-row ping + delivered POST, quiet-hours suppression, permission only via the toggle). |

## Files modified

| File | Change |
|---|---|
| `lib/rpc-manager.ts` | Central emits (surgical): `notifyRunSeq` bumps on `agent_start`; terminal `agent_end` with `responseObserved` (≥ 1 assistant message this run) → `notifyAgentEnd`; `response` success=false (both prompt + non-prompt branches) → `notifyRpcError` (token = frame id else per-wrapper counter); unexpected child exit → `notifyRpcError("process-exit")`; `trackExtensionUiRequest` where a pending confirm/select/input/editor/open_url dialog registers → `notifyApprovalNeeded` (frame id dedups SSE replays). All emit calls wrapped in try/catch — notification plumbing can never break the RPC path. |
| `components/AppShell.tsx` | Bell mounted in the topbar between the left tools group and the center zone (never folded into the overflow menu); `handleOpenSessionFromBell` (fetch `/api/sessions` → `handleSelectSession`, URL-param fallback mirrors the palette hand-off), `handleOpenNotifySettings` → `setSettingsTab("notifications")`. |
| `components/SettingsTabs.tsx` | + `"notifications"` to the `SettingsTab` union + `SETTINGS_CATEGORIES` (lucide `Bell`, label/description via `settingsTabs.notifications.*`). |
| `components/SettingsConfig.tsx` | Two additive edits only (collision hot-spot): dynamic import of `NotificationsConfig` beside the other tab modules + the `{currentTab === "notifications"}` panel block before `</SettingsHighlightContext.Provider>`. |
| `lib/i18n/locales/{en,zh-CN,ja}.json` | + `notify.bell.*`, `notify.kind.*`, `notify.rowTitle.*`, `notify.time.*`, `settingsTabs.notifications.*`, `notifySettings.*` — all user-facing strings ×3 locales (notify + notifySettings namespaces as instructed; settings tab labels follow the existing `settingsTabs.<id>.*` convention the tab renderer requires). |
| `package.json` | test glob += `lib/notify/*.test.mjs` (inserted after the parallel lane's `lib/snippets` entry — both preserved). |

## Deviations & judgment calls

- **Approval frame shape (build task 1):** the live shape is KNOWN and
  tracked in this repo — `extension_ui_request` frames with
  `method ∈ {confirm, select, input, editor, open_url}` park in
  `AgentSessionWrapper.pendingUiRequests` (lib/rpc-manager.ts
  `PENDING_UI_METHODS`; frame = `{type, id, method, title, message?, timeout?}`,
  mirrored in `lib/pi-types.ts` `OmpExtensionUiRequest`). The `get_state`
  waiting-flag fallback was NOT needed: `RpcSessionState` exposes no dedicated
  waiting flag (only `buildWebState`'s derived `pendingUiRequests.size > 0`
  pending-work accounting), so the frame-id path is both the documented
  primary and the only signal. Dedup by frame id also makes SSE-reconnect
  replays (`onEvent` re-emits pending UI requests) collapse to one feed row.
  Host-tool/URI requests are excluded — they are tool plumbing, not approvals.
- **Webhook failures cannot loop:** failure rows carry the `wherr-` id prefix
  and `dispatchWebhookForRow` refuses to dispatch them; failure rows also
  dedup by source row id.
- **Quiet hours** suppress the browser ping only (checked client-side in the
  hook via `isInQuietHours`); feed rows and webhooks always record/fire —
  stated in the settings copy (`notifySettings.quietHoursDesc`).
- **URL write-only discipline:** GET/PUT never echo the URL (mask only).
  The settings input is `type="password"`, cleared after save; changing the
  URL = typing a new one. The config file is written 0600 (best-effort on
  Windows/NTFS, enforced on POSIX hosts).
- **Config read frequency:** `dispatchWebhookForRow` re-reads the config file
  per dispatched row. This happens at run-completion/approval frequency (a few
  per minute at worst), not on frame hot paths — deliberately simple until
  usage suggests caching.
- **Pre-existing overlap (left untouched):** AppShell's legacy
  `handleAgentEnd` still calls `Notification.requestPermission()` for the
  *currently open* session when permission is `default` (pre-P2 behavior).
  The P2 surfaces (hook/bell/settings) never request outside the settings
  toggle gesture, per spec; retiring the legacy path is a product call left
  to Blaze.
- **`seed-test-row` action** added beyond the spec's two POST actions so the
  bell/preview can be exercised without configuring a webhook (the spec's
  `{action:"test"}` exercises the real webhook delivery and reports the
  result to the settings panel).
- **No SSE for the feed:** spec says "20 s poll while visible" — implemented
  literally (interval + visibility/online refresh), no events route needed.
- **Localization of row content:** browser notification titles are composed
  client-side from `notify.rowTitle.<kind>`; server `title`/`body` (English)
  are the webhook content and the fallback.

## Frame-shape findings (for the record)

- `extension_ui_request` `{ id, method, title?, message?, timeout?, ... }`;
  methods that block on the user: `confirm`, `select`, `input`, `editor`,
  `open_url`. `cancel` carries `targetId`. The wrapper adds `expiresAt` from
  `timeout` for reconnect expiry.
- Failed async RPC responses reuse the original command `id`
  (`{type:"response", success:false, error?, command?}`); some omp versions
  omit `command` on the second (async) response — the wrapper already treats
  that as a prompt failure when a run is active. Feed dedup token = that id,
  so one wedged command cannot spam the feed.
- No terminal `runId` exists server-side; the wrapper's monotonic
  `notifyRunSeq` (bumped per `agent_start`) plays that role for
  `agent_end` dedup (`agent_end:<sessionId>:<runSeq>`).

## AGENTS.md-ready block (fold into AGENTS.md when the lane allows)

```markdown
### Notifications + webhooks (lib/notify/, /api/notify, NotificationsBell)
- Server-side feed (survives closed tabs): `lib/notify/feed.ts` — 500-row ring
  + debounced atomic tail at `~/.omp/agent/web-notify.json`; rows dedup by
  `kind:sessionId:runId-or-frameId` so N SSE subscribers → one row. Corrupt
  stores quarantine to `*.bak-<ts>`.
- Central emits live in `lib/rpc-manager.ts`: terminal `agent_end` (only with
  observed assistant output), approval-needed `extension_ui_request` frames
  (confirm/select/input/editor/open_url), failed RPC responses + child exits.
  Emits must never break the RPC path (all wrapped).
- Config store `~/.omp/agent/web-notify-config.json` (mode 0600): browser
  toggle, webhook `{provider,url,events}`, quiet hours. The webhook URL is a
  credential: https-or-loopback validated, NEVER echoed over GET (masked to
  configured+host), write-only in settings. Quiet hours suppress the browser
  ping only — feed + webhook always record.
- Webhook delivery (`lib/notify/webhook.ts`): ntfy/discord/telegram/generic,
  undici fetch, 5 s timeout, 1 retry, always fire-and-forget; failures land
  as `wherr-`-prefixed error feed rows that are never re-dispatched.
- Client: `hooks/useNotifyFeed.ts` polls 20 s while visible (+online/
  visibilitychange), fires OS notifications only for NEW rows while hidden,
  gated on the browser toggle + granted permission + quiet hours; permission
  is requested ONLY from the Settings → Notifications toggle gesture.
  `components/NotificationsBell.tsx` is the header bell (unread badge,
  dropdown, mark-all-read, test, settings deep-link); settings section lives
  in `components/NotificationsConfig.tsx`.
- `lib/feature-flags.ts`: env `OMP_WEB_FLAGS` ∪ localStorage `omp-web:flags`,
  enable-only, `isEnabled()` guards hidden entry points (terminal/split/
  scheduler/herdrAttach/nativeStats — wired per later phase).
```
