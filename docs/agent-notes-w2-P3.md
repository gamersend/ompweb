# Wave 2 — Phase 3: Quick-launch toolbar (agent notes)

Per-project launch profiles surfaced as one-tap chips (sidebar header + command
palette), and the `projects.json` schema extended to v2 so a chip spawns a
fully-configured agent in two seconds. Spawn path stays `lib/spawn-session.ts`
via the `/api/agent/new` adapter — never raw RPC.

## What changed

### Schema — registry v2 (`lib/project-registry.ts`, `lib/types.ts`)
- `ProjectLaunchConfig` gains optional `prompt` (≤ 4 KB, `LAUNCH_PROMPT_MAX`),
  `model` (`"provider:modelId"`), `thinkingLevel` (generic ladder), and
  `toolsPreset` (`"none" | "default" | "full"`).
- `ProjectRegistryFile` version is now `2` (`REGISTRY_VERSION = 2`); all
  registry mutation helpers emit v2. `parseProjectRegistry` migrates on read;
  the pure `migrateRegistry()` seam bumps the version while preserving every
  entry field verbatim (migration never rewrites paths — only parse
  canonicalizes).
- New pure module `lib/launch-profile.ts` (client+server safe): 
  `normalizeLaunchConfigFields` (invalid values DROPPED, never fatal — bad
  model / unknown thinking level / unknown preset / oversized prompt all
  dropped, the rest preserved), `splitLaunchModelRef` (first-colon split so
  model ids may contain colons; mirrors scheduler `splitModelRef` without
  importing the scheduler's fs-backed module), `hasLaunchSpawnConfig`,
  `launchCommandFields`.
- Both validators sanitize the new fields the same way: the on-disk parser in
  `project-registry.ts` and the write validator in `/api/projects` (invalid →
  dropped; existing profile/advisor/extraArgs throw behavior unchanged).
- `lib/thinking-levels.ts` exports `DEFAULT_THINKING_LEVELS` and
  `isKnownThinkingLevel()`.

### Flow — profile → spawn (`lib/spawn-session.ts`, `components/AppShell.tsx`)
- `spawnNewSession` accepts explicit optional `launch: { model, thinkingLevel,
  toolsPreset }`. Folding happens BEFORE the existing destructure, so the
  profile reuses the exact existing semantics (pre-prompt `set_model` /
  `set_thinking_level`, `toolNames` argument to `startRpcSession`); explicit
  per-command values always win over the profile; invalid profile values are
  silently dropped; `input.command` is never mutated. The wire contract of
  `/api/agent/new` is unchanged (the body fields the chip sends — `message`,
  `provider`, `modelId`, `thinkingLevel`, `toolNames` — all existed already).
- **Prompt discipline (documented in code + tests):** a profile prompt is NOT
  a snippet — it is sent VERBATIM as the first message, no `$NAME`/`${NAME}`
  placeholder expansion. Empty/absent prompt → `type: "ensure_session"` (spawn
  without a first message, today's behavior). Reserved spawn args remain
  rejected (forged `sessionId` strip regression-tested alongside launch
  folding).
- `AppShell.handleLaunchProject` maps the profile through
  `launchCommandFields`, POSTs `/api/agent/new`, and adopts the created
  session via the proven `handleSessionCreated` path (select + hydrate + URL).
  Spawn failures toast (`launch.failed`); the promise still resolves so the
  sidebar chip's busy state clears.

### UI
- `components/SessionSidebar-chrome.tsx`: `LaunchChipRow` — one compact chip
  per project with a launch profile, Zap icon, accent dot when the profile
  carries spawn shortcuts (`hasLaunchSpawnConfig`), design tokens +
  `SIDEBAR_BUTTON_TRANSITION`, lucide only.
- `components/SessionSidebar.tsx`: renders the chip row in the header from the
  ALREADY-loaded `projects` state — no registry fetch, no render blocking;
  one spawn in flight at a time (`launchingPath` busy state).
- `components/CommandPalette.tsx`: "Launch" group with entries
  `Launch <profileName> — <project>` (`launch.paletteEntry`), sourced from a
  `launchProjects` prop — AppShell feeds it `workspaceOptions.projects` (the
  sidebar's own list), so the palette never refetches `/api/projects`.
- `components/ProjectLaunchConfigDialog.tsx`: four additive fields — prompt
  textarea (4 KB cap + live counter), model via the composer picker
  (`ModelPickerPanel`/`ProviderBadge`, `/api/models` fetched lazily on first
  open — the SchedulesConfig pattern), thinking-level select
  (`DEFAULT_THINKING_LEVELS` + Default), tools-preset select. Existing
  profile/advisor/extraArgs UI untouched.

### i18n
19 new keys under `launch.*` appended to all three dictionaries
(`en.json`, `zh-CN.json`, `ja.json`) — identical key sets, appended after the
existing tail via unique anchors, no reordering.

## File list (exact)

Changed:
- `lib/types.ts` — ProjectLaunchConfig v2 fields
- `lib/thinking-levels.ts` — export ladder + isKnownThinkingLevel
- `lib/project-registry.ts` — v2, migrateRegistry, launch-field parse guards
- `lib/spawn-session.ts` — SpawnLaunchOptions + folding (shallow-copies command)
- `app/api/projects/route.ts` — write validator sanitizes the new fields
- `components/SessionSidebar-chrome.tsx` — LaunchChipRow
- `components/SessionSidebar.tsx` — chip row wiring, onLaunchProject prop
- `components/AppShell.tsx` — handleLaunchProject, props to sidebar + palette
- `components/CommandPalette.tsx` — Launch group
- `components/ProjectLaunchConfigDialog.tsx` — four new fields
- `lib/i18n/locales/en.json`, `lib/i18n/locales/zh-CN.json`,
  `lib/i18n/locales/ja.json` — launch.* ×3

Added:
- `lib/launch-profile.ts` — pure launch-profile helpers
- `lib/launch-profile.test.mjs`
- `components/LaunchSurfaces.test.mjs` — source assertions + i18n parity

Tests extended:
- `lib/project-registry.test.mjs` — migrate v1→v2 preserves all; parse guards
- `lib/spawn-session.test.mjs` — launch application / absence / precedence /
  invalid-drop / forged-sessionId strip

## Gate results

- `node_modules/.bin/tsc --noEmit` — **0 errors** (mid-run snapshots showed
  transient errors in P2/P8 files; final run clean across the repo).
- `npm run lint` — **clean** (0 errors, 0 warnings).
- `npm test` — **1459 pass / 0 fail / 1 skip** (1460 tests). One transient
  failure mid-session (`components/MemoryPanel.test.mjs`, P8's in-flight
  file) was green on re-run.

## AGENTS.md-ready section

```markdown
### Quick-launch toolbar (P3 wave 2)
- `projects.json` is schema v2: `ProjectLaunchConfig` may carry `prompt`
  (≤ 4 KB), `model` ("provider:modelId"), `thinkingLevel`, and
  `toolsPreset` ("none"|"default"|"full"). Reading the registry migrates
  v1→v2 in memory (`migrateRegistry`); every invalid new field is DROPPED at
  parse AND at `/api/projects` write time — never fatal, never partial-loss
  of the valid remainder.
- A launch profile's `prompt` is NOT a snippet: it is sent verbatim as the
  spawned session's first message — no `$PLACEHOLDER` expansion, ever.
  Empty/absent prompt spawns without a first message (`ensure_session`).
- Chip → palette → spawn all go through `AppShell.handleLaunchProject` →
  POST `/api/agent/new` (the `lib/spawn-session.ts` adapter) with the profile
  mapped by `lib/launch-profile.ts` `launchCommandFields`. Never raw RPC,
  never a bespoke spawn body. `spawnNewSession` also accepts explicit
  `launch: {model, thinkingLevel, toolsPreset}` for server callers; explicit
  command values always beat profile values; invalid profile values never
  reach the child.
- Surfaces: sidebar header `LaunchChipRow` (one chip per profiled project,
  dot = spawn shortcuts present) renders from the sidebar's already-loaded
  project list — never a registry fetch on the render path. The command
  palette's Launch group reuses the SAME list via `workspaceOptions` props —
  the palette never fetches `/api/projects` itself.
- Spawn failures toast (`launch.failed`); the adopting session flows through
  `handleSessionCreated` (select + hydrate + `?session=` URL), the same path
  as a composer-created session. All strings live under `launch.*` ×3 locales.
```
