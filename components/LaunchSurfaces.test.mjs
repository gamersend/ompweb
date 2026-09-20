import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// ============================================================================
// Quick-launch surfaces (BUILD-PLAN-2 Phase 3) — source assertions.
//
// These pins are structural: the chip row must consume the sidebar's OWN
// project list (never a registry fetch on the render path), the palette must
// source its entries from props (never its own /api/projects fetch), and the
// spawn must go through the launchCommandFields → /api/agent/new mapping
// (never a bespoke wire shape). Plus i18n parity: every launch.* key exists
// in all THREE locale dictionaries.
// ============================================================================

const readSource = (relative) => readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");

const chromeSource = readSource("./SessionSidebar-chrome.tsx");
const sidebarSource = readSource("./SessionSidebar.tsx");
const paletteSource = readSource("./CommandPalette.tsx");
const appShellSource = readSource("./AppShell.tsx");
const dialogSource = readSource("./ProjectLaunchConfigDialog.tsx");

test("sidebar chip row consumes the loaded project list, never a render-path fetch", () => {
  assert.match(chromeSource, /function LaunchChipRow/, "chip row lives in SessionSidebar-chrome (exported via the bottom export block)");
  assert.match(chromeSource, /hasLaunchSpawnConfig/, "the profile dot is driven by spawn-shortcut presence");
  assert.match(chromeSource, /launch\.chipRowLabel/);
  assert.match(chromeSource, /launch\.profileDot/);
  assert.match(chromeSource, /projects\.filter\(\(project\) => project\.launchConfig\)/, "one chip per project with a launch profile");

  // The sidebar renders the row from its already-loaded `projects` state —
  // no new fetch, no render blocking on the registry.
  assert.match(sidebarSource, /<LaunchChipRow/, "SessionSidebar renders the chip row in its header");
  assert.match(sidebarSource, /projects=\{projects\}/);
  assert.match(sidebarSource, /launchingPath=\{launchingPath\}/);
});

test("palette Launch entries come from props and reuse the shared spawn handler", () => {
  assert.match(paletteSource, /launchProjects\?: ManagedProject\[\]/, "project list arrives via props");
  assert.match(paletteSource, /launch\.paletteHeading/);
  assert.match(paletteSource, /launch\.paletteEntry/);
  assert.match(paletteSource, /onLaunchProject\?\.\(project\)/);
  assert.equal(paletteSource.includes('fetch("/api/projects")'), false, "palette never refetches the registry itself");

  // AppShell feeds both surfaces from the same handler over the same data.
  assert.match(appShellSource, /launchProjects=\{workspaceOptions\.projects\}/, "palette gets the sidebar's project list");
  const wired = appShellSource.split("onLaunchProject={handleLaunchProject}").length - 1;
  assert.equal(wired, 2, "handler wired to BOTH the sidebar and the palette");
});

test("the spawn path goes through launchCommandFields → /api/agent/new", () => {
  assert.match(appShellSource, /launchCommandFields\(config\)/, "profile mapped by the pure helper");
  assert.match(appShellSource, /fetch\("\/api\/agent\/new"/, "chip/palette spawn uses the agent/new adapter (lib/spawn-session), never raw RPC");
  assert.match(appShellSource, /cwd: project\.path, \.\.\.fields/);
  assert.match(appShellSource, /translate\("launch\.failed"/, "spawn failures toast");
  // Profile prompt discipline: verbatim body fields, snippet machinery absent.
  assert.match(appShellSource, /fields\.message \?\? translate\("agentSession\.noMessages"\)/, "absent prompt spawns without a first message");
  assert.equal(appShellSource.includes("fillSnippet"), false, "no snippet expansion anywhere on the launch path");
});

test("profile dialog carries all four quick-launch fields with the prompt cap", () => {
  assert.match(dialogSource, /LAUNCH_PROMPT_MAX/);
  assert.match(dialogSource, /maxLength=\{LAUNCH_PROMPT_MAX\}/, "prompt textarea is capped in the UI too");
  assert.match(dialogSource, /ModelPickerPanel/, "model reuses the composer picker panel");
  assert.match(dialogSource, /DEFAULT_THINKING_LEVELS/, "thinking select uses the shared ladder");
  assert.match(dialogSource, /launch\.promptLabel/);
  assert.match(dialogSource, /launch\.modelLabel/);
  assert.match(dialogSource, /launch\.thinkingLabel/);
  assert.match(dialogSource, /launch\.toolsLabel/);
});

test("every launch.* i18n key exists in all three locales (and only there for new strings)", () => {
  const load = (locale) => JSON.parse(readFileSync(fileURLToPath(new URL(`../lib/i18n/locales/${locale}.json`, import.meta.url)), "utf8"));
  const en = load("en");
  const zh = load("zh-CN");
  const ja = load("ja");
  const keys = (dict) => Object.keys(dict).filter((key) => key.startsWith("launch.")).sort();
  assert.deepEqual(keys(zh), keys(en), "zh-CN launch keys match en");
  assert.deepEqual(keys(ja), keys(en), "ja launch keys match en");
  assert.ok(keys(en).length >= 19, "the launch namespace is populated");
  for (const key of ["launch.chipRowLabel", "launch.chipTitle", "launch.paletteHeading", "launch.paletteEntry", "launch.failed", "launch.promptLabel", "launch.modelLabel", "launch.thinkingLabel", "launch.toolsLabel"]) {
    assert.ok(en[key] && zh[key] && ja[key], `${key} present ×3`);
  }
});
