import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("agent command routes reject malformed commands and map RPC failures to 400", async () => {
  const route = await readFile(new URL("../app/api/agent/[id]/route.ts", import.meta.url), "utf8");
  const newRoute = await readFile(new URL("../app/api/agent/new/route.ts", import.meta.url), "utf8");
  assert.match(route, /command_type_required/);
  assert.match(route, /instanceof RpcCommandError/);
  assert.match(route, /status: 400/);
  // The new-session route's validation moved into lib/spawn-session.ts
  // (Phase 11 extraction); the route keeps the shared error mapper.
  assert.match(newRoute, /newSessionErrorResponse/);
  assert.match(newRoute, /spawnNewSession/);
});

test("interactive login negotiates RPC v2 before sending the login command", async () => {
  const route = await readFile(new URL("../app/api/auth/login/[provider]/route.ts", import.meta.url), "utf8");
  const waitReady = route.indexOf("await child.waitReady(READY_TIMEOUT_MS)");
  const negotiate = route.indexOf("await child.negotiateProtocol(ready)");
  const login = route.indexOf('await child.sendCommand({ type: "login"');

  assert.ok(waitReady >= 0);
  assert.ok(negotiate > waitReady);
  assert.ok(login > negotiate);
});

test("session archive route stops live children and maps missing sessions", async () => {
  const route = await readFile(new URL("../app/api/sessions/[id]/archive/route.ts", import.meta.url), "utf8");
  const utils = await readFile(new URL("../lib/api-utils.ts", import.meta.url), "utf8");
  assert.match(route, /destroyAndWait/);
  assert.match(route, /archiveSessionFileWithArtifacts/);
  // Missing-session responses now come from the shared helper.
  assert.match(route, /resolveSessionPathOr404/);
  assert.match(utils, /session_not_found/);
  assert.match(route, /session_archive_failed/);
  assert.match(route, /session_has_children/);
});

test("session archive remains keyboard-discoverable with an ARIA label", async () => {
  const source = await readFile(new URL("../components/SessionSidebar.tsx", import.meta.url), "utf8");
  const rows = await readFile(new URL("../components/SessionSidebar-rows.tsx", import.meta.url), "utf8");
  assert.match(rows, /api\/sessions\/\$\{encodeURIComponent\(session\.id\)\}\/archive/);
  assert.match(rows, /sessionSidebar\.archiveLeafOnly/);
  assert.match(source, /onOpenArchive/);
});

test("prompt controls preserve abort, steer, and follow-up RPC commands", async () => {
  const source = await readFile(new URL("./rpc-manager.ts", import.meta.url), "utf8");
  assert.match(source, /case "abort":/);
  assert.match(source, /case "steer":/);
  assert.match(source, /case "follow_up":/);
  assert.match(source, /streamingBehavior/);
});

test("worktree discovery filters prunable entries and identifies the main checkout", async () => {
  const source = await readFile(new URL("./worktree.ts", import.meta.url), "utf8");
  assert.match(source, /current\.prunable/);
  assert.match(source, /isMain:\s*samePath\(worktreePath,\s*repoRoot\)/);
  assert.match(source, /"worktree", "list", "--porcelain"/);
});

test("OMP update route permits check and restart actions with force support", async () => {
  const route = await readFile(new URL("../app/api/omp-update/route.ts", import.meta.url), "utf8");
  const settings = await readFile(new URL("../components/SettingsConfig.tsx", import.meta.url), "utf8");
  const appShell = await readFile(new URL("../components/AppShell.tsx", import.meta.url), "utf8");

  assert.match(route, /body\.action === "check"/);
  assert.match(route, /checkOmpUpdate\(body\.force === true\)/);
  assert.match(route, /body\.action === "restart"/);
  assert.match(route, /restartAllRpcSessions/);

  // Settings manual refresh passes force: true; auto check uses cached default
  assert.match(settings, /checkForUpdate\(true\)/);
  assert.match(settings, /force:\s*true/);
  assert.match(settings, /force = false/);
  assert.match(appShell, /fetch\("\/api\/omp-update"[\s\S]*?action:\s*"check"/);
  assert.doesNotMatch(appShell, /force:\s*true/);
});

test("settings groups runtime preferences and resource managers behind tabs", async () => {
  const settings = await readFile(new URL("../components/SettingsConfig.tsx", import.meta.url), "utf8");
  const models = await readFile(new URL("../components/ModelsConfig.tsx", import.meta.url), "utf8");
  const appShell = await readFile(new URL("../components/AppShell.tsx", import.meta.url), "utf8");
  assert.match(settings, /settingsConfig\.runAppUpdateCommand/);
  assert.match(settings, /settingsConfig\.restartSessions/);
  assert.match(appShell, /appShell\.ompUpdateAvailable/);
  assert.match(appShell, /appShell\.appUpdateAvailable/);
  assert.match(appShell, /appShell\.updateVersion/);
  assert.match(appShell, /appShell\.copyCommand/);
  assert.match(appShell, /appShell\.commandCopied/);
  assert.match(appShell, /appShell\.commandCopyFailed/);
  assert.match(settings, /currentTab === "models"/);
  assert.match(settings, /currentTab === "skills"/);
  assert.match(settings, /currentTab === "plugins"/);
  assert.doesNotMatch(settings, /visitedTabs/);
  assert.match(settings, /<ModelsConfig embedded/);
  assert.match(models, /fetch\("\/api\/models", \{ cache: "no-store" \}\)/);
  assert.match(models, /OMP runtime models/);
});

test("model endpoint invalidates cached runtime models after external config edits", async () => {
  const route = await readFile(new URL("../app/api/models/route.ts", import.meta.url), "utf8");
  assert.match(route, /statSync/);
  assert.match(route, /__ompModelsConfigFingerprint/);
  assert.match(route, /invalidateModelsCache\(\)/);
  assert.match(route, /disposeUtilityRpc\(\)/);
});

test("agent project discovery requires an explicit workspace", async () => {
  const route = await readFile(new URL("../app/api/agents/route.ts", import.meta.url), "utf8");
  assert.match(route, /scope === "project" && !cwdParam/);
  assert.match(route, /cwd is required for project scope/);
});

test("agent mutations bound JSON input before parsing", async () => {
  const route = await readFile(new URL("../app/api/agents/route.ts", import.meta.url), "utf8");
  assert.match(route, /parseJsonWithinLimit/);
  assert.match(route, /MAX_AGENT_REQUEST_BYTES/);
  assert.match(route, /RequestBodyTooLargeError/);
  assert.match(route, /status: 413/);
  assert.doesNotMatch(route, /request\.json\(\)/);
});

test("mutating agent and MCP routes bound JSON input", async () => {
  const newAgent = await readFile(new URL("../app/api/agent/new/route.ts", import.meta.url), "utf8");
  const agent = await readFile(new URL("../app/api/agent/[id]/route.ts", import.meta.url), "utf8");
  const mcp = await readFile(new URL("../app/api/mcp/route.ts", import.meta.url), "utf8");
  for (const route of [newAgent, agent, mcp]) {
    assert.match(route, /parseJsonWithinLimit/);
    assert.match(route, /RequestBodyTooLargeError/);
  }
  assert.match(newAgent, /status: 413/);
  assert.match(agent, /status: 413/);
  assert.match(mcp, /\? 413 : 400/);
});

test("agent routes bound requests with the shared attachment budget", async () => {
  const newAgent = await readFile(new URL("../app/api/agent/new/route.ts", import.meta.url), "utf8");
  const agent = await readFile(new URL("../app/api/agent/[id]/route.ts", import.meta.url), "utf8");
  const budget = await readFile(new URL("./image-attachments.ts", import.meta.url), "utf8");

  // One source of truth: the composer preflights against the same constant, so
  // a per-route literal would let the client send bodies the route rejects.
  for (const route of [newAgent, agent]) {
    assert.match(route, /import \{ MAX_AGENT_COMMAND_REQUEST_BYTES \} from "@\/lib\/image-attachments"/);
    assert.match(route, /parseJsonWithinLimit<[^>]*>\(req, MAX_AGENT_COMMAND_REQUEST_BYTES\)/);
    assert.doesNotMatch(route, /REQUEST_BYTES = /);
  }
  // Below Next's 10 MB proxy buffering boundary, with base64 headroom for the
  // aggregate image cap.
  assert.match(budget, /MAX_AGENT_COMMAND_REQUEST_BYTES = 8 \* 1024 \* 1024/);
  assert.match(budget, /MAX_TOTAL_ATTACHED_IMAGE_BYTES = 5 \* 1024 \* 1024/);
});

test("MCP route redacts project server credentials", async () => {
  const route = await readFile(new URL("../app/api/mcp/route.ts", import.meta.url), "utf8");
  assert.match(route, /redactMcpServer\(config\)/);
  assert.doesNotMatch(route, /config }\)\), user: safeUser/);
});

test("event streams observe only existing web-managed sessions", async () => {
  const route = await readFile(new URL("../app/api/agent/[id]/events/route.ts", import.meta.url), "utf8");
  assert.match(route, /getRpcSession\(id\)/);
  assert.match(route, /Session is not managed by omp-web/);
  assert.doesNotMatch(route, /startRpcSession/);
});

test("agent command route forwards the advisor choice to lazy spawns via query param", async () => {
  const route = await readFile(new URL("../app/api/agent/[id]/route.ts", import.meta.url), "utf8");
  assert.match(route, /searchParams\.get\("advisor"\) === "1"/);
  assert.match(route, /startRpcSession\(id, filePath, cwd, undefined, advisor/);
  // The RPC body goes to omp verbatim; the flag must never ride inside it.
  assert.match(route, /existing\.send\(body\)/);
});

test("mcp listing carries the advisor opinion into fresh spawns only", async () => {
  const route = await readFile(new URL("../app/api/mcp/route.ts", import.meta.url), "utf8");
  assert.match(route, /params\.get\("advisor"\) === "1"/);
  assert.match(route, /startRpcSession\(sessionId, sessionFile, cwd, undefined, advisor/);
  // An alive child is always reused for listing; the opinion must never
  // trigger a flag-mismatch replace of a live session.
  assert.match(route, /getRpcSession\(sessionId\)/);
});

test("new-session route never forwards a session id into the child RPC", async () => {
  // The spawn core was extracted into lib/spawn-session.ts (Phase 11): the
  // route must delegate, and the sessionId strip must live in the core the
  // scheduler also fires through.
  const route = await readFile(new URL("../app/api/agent/new/route.ts", import.meta.url), "utf8");
  assert.match(route, /spawnNewSession/);
  const core = await readFile(new URL("../lib/spawn-session.ts", import.meta.url), "utf8");
  assert.match(core, /delete promptCommand\.sessionId/);
});

test("session insights route serves the envelope over the shared 404 resolver", async () => {
  const route = await readFile(new URL("../app/api/sessions/[id]/insights/route.ts", import.meta.url), "utf8");
  assert.match(route, /resolveSessionPathOr404/);
  assert.match(route, /success: true/);
  assert.match(route, /getSessionInsights/);
  assert.match(route, /runtime = "nodejs"/);
  assert.match(route, /Cache-Control": "no-store/);
  // ?refresh=1 must bypass the 60 s native shape cache, not leak into SQL.
  assert.match(route, /refreshParam === "1"/);
});

test("usage route unions omp stats.db by default and honors the exclusion param", async () => {
  const route = await readFile(new URL("../app/api/usage/route.ts", import.meta.url), "utf8");
  assert.match(route, /includeNativeParam === null/);
  assert.match(route, /applyNativeUsage\(report, query\)/);
  assert.match(route, /statsDbExists\(\)/);
});

test("native readers stay read-only and degrade instead of throwing", async () => {
  const reader = await readFile(new URL("../lib/omp-stats-db.ts", import.meta.url), "utf8");
  assert.match(reader, /readOnly: true/);
  assert.match(reader, /createRequire\(import\.meta\.url\)\("node:sqlite"\)/);
  // omp's credential tables are never queried — all SQL names allowed tables only.
  assert.doesNotMatch(reader, /auth_credentials|auth_credential/);
  assert.match(reader, /CACHE_TTL_MS = 60_000/);
  assert.match(reader, /BUSY_RETRIES = 2/);
  // session-mutation hooks must keep invalidating the insights-adjacent caches
  const usageNative = await readFile(new URL("../lib/usage-native.ts", import.meta.url), "utf8");
  assert.match(usageNative, /mergeNativeUsage/);
});

test("session insights dialog wires the header pill and the sortable tool table", async () => {
  const dialog = await readFile(new URL("../components/SessionInsightsDialog.tsx", import.meta.url), "utf8");
  assert.match(dialog, /SessionInsightsEntry/);
  assert.match(dialog, /aria-sort/);
  assert.match(dialog, /insights\.partialData/);
  assert.match(dialog, /\/api\/sessions\/\$\{encodeURIComponent\(sessionId\)\}\/insights/);
  const chatWindow = await readFile(new URL("../components/ChatWindow.tsx", import.meta.url), "utf8");
  assert.match(chatWindow, /<SessionInsightsEntry sessionId=\{session\?\.id \?\? sessionIdRef\.current \?\? null\} \/>/);
  const usageConfig = await readFile(new URL("../components/UsageConfig.tsx", import.meta.url), "utf8");
  assert.match(usageConfig, /usageNative\.toggle/);
  assert.match(usageConfig, /usageNative\.quotaTitle/);
  assert.match(usageConfig, /usageNative\.partial/);
});

