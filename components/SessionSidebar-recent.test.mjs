import assert from "node:assert/strict";
import "../tests/setup-dom.mjs";
import test, { afterEach } from "node:test";
import React from "react";
import { cleanup, fireEvent, render } from "@testing-library/react/pure.js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

// ============================================================================
// Cross-project "Recent" rail.
//
// Two kinds of pins here:
//  • behavior — rendered rows/caps/collapse/filters, driven through the real
//    component (jsdom);
//  • structure — the sidebar must keep the rail mounted above the workspace
//    tree, keep the sort toggle wired to the persisted mode, and keep passing
//    the preformatted activity age to project rows.
//
// Assertions avoid translated copy on purpose: the new sessionSidebar.* keys
// are applied by the release tooling, so tests must never depend on their
// (or their raw-key fallback) text.
// ============================================================================

const jiti = createJiti(import.meta.url, {
  jsx: { runtime: "automatic" },
  tsconfigPaths: true,
});
const {
  RECENT_COLLAPSED_STORAGE_KEY,
  RecentSessionsSection,
  loadRecentCollapsed,
  saveRecentCollapsed,
} = await jiti.import("./SessionSidebar-recent.tsx");
const { ProjectRow } = await jiti.import("./SessionSidebar-rows.tsx");

const readSource = (relative) => readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");

afterEach(() => {
  cleanup();
  window.localStorage.removeItem(RECENT_COLLAPSED_STORAGE_KEY);
});

let seq = 0;
/** A session row fixture; `modified` defaults to "newer than the last one". */
function session(id, overrides = {}) {
  seq += 1;
  return {
    path: `/sessions/${id}.jsonl`,
    id,
    cwd: `/work/${id}`,
    name: undefined,
    created: "2026-01-01T00:00:00.000Z",
    modified: new Date(Date.UTC(2026, 0, seq)).toISOString(),
    messageCount: 1,
    firstMessage: "",
    ...overrides,
  };
}

function mountRail(props = {}) {
  const onSelectSession = props.onSelectSession ?? (() => {});
  const view = render(React.createElement(RecentSessionsSection, {
    sessions: props.sessions ?? [],
    selectedSessionId: props.selectedSessionId ?? null,
    runningSessionIds: props.runningSessionIds ?? new Set(),
    unreadSessionIds: props.unreadSessionIds ?? new Set(),
    relativeTimeNow: props.relativeTimeNow ?? Date.now(),
    searchQuery: props.searchQuery ?? "",
    runningOnly: props.runningOnly ?? false,
    onSelectSession,
  }));
  return { ...view, onSelectSession };
}

const rowsOf = (container) => Array.from(container.querySelectorAll(".sidebar-recent-row"));
const titlesOf = (container) => rowsOf(container).map((row) => row.querySelector(".sidebar-recent-title").textContent);
const projectsOf = (container) => rowsOf(container).map((row) => row.querySelector(".sidebar-recent-project").textContent);
const toggleOf = (container) => container.querySelector(".sidebar-recent-toggle");

test("renders the newest sessions across all projects, newest first, labeled with their project", () => {
  const sessions = [
    session("old", { name: "Oldest chat", modified: "2026-01-01T00:00:00.000Z", projectRoot: "/repos/alpha" }),
    session("newest", { name: "Newest chat", modified: "2026-03-01T00:00:00.000Z", projectRoot: "/repos/beta" }),
    session("middle", { name: "Middle chat", modified: "2026-02-01T00:00:00.000Z", projectRoot: "/repos/gamma" }),
  ];
  const { container } = mountRail({ sessions });
  assert.deepEqual(titlesOf(container), ["Newest chat", "Middle chat", "Oldest chat"]);
  // Flat list, so every row must say WHICH project it came from.
  assert.deepEqual(projectsOf(container), ["beta", "gamma", "alpha"]);
});

test("falls back to the first message (then the id) for untitled sessions", () => {
  const { container } = mountRail({
    sessions: [
      session("a", { firstMessage: "fix the sidebar", modified: "2026-02-01T00:00:00.000Z" }),
      session("b", { modified: "2026-01-01T00:00:00.000Z" }),
    ],
  });
  assert.deepEqual(titlesOf(container), ["fix the sidebar", "b"]);
});

test("caps at 8 rows at rest and points at the remainder", () => {
  const sessions = Array.from({ length: 12 }, (_, index) => session(`s-${index}`, {
    name: `Chat ${index}`,
    modified: new Date(Date.UTC(2026, 0, index + 1)).toISOString(),
  }));
  const { container } = mountRail({ sessions });
  assert.equal(rowsOf(container).length, 8);
  assert.equal(titlesOf(container)[0], "Chat 11", "newest first");
  const more = container.querySelector(".sidebar-recent-more");
  assert.ok(more, "a '+N older' hint is rendered when rows are hidden");
  assert.equal(more.textContent.includes("Chat"), false, "the hint is not a row");
});

test("shows no remainder hint when nothing is hidden", () => {
  const { container } = mountRail({ sessions: [session("only", { name: "Only" })] });
  assert.equal(rowsOf(container).length, 1);
  assert.equal(container.querySelector(".sidebar-recent-more"), null);
});

test("raises the cap to 30 while a filter is active", () => {
  const sessions = Array.from({ length: 40 }, (_, index) => session(`s-${index}`, {
    name: `Needle ${index}`,
    firstMessage: "needle",
    modified: new Date(Date.UTC(2026, 0, index + 1)).toISOString(),
  }));
  assert.equal(rowsOf(mountRail({ sessions }).container).length, 8);
  assert.equal(rowsOf(mountRail({ sessions, searchQuery: "needle" }).container).length, 30);
  assert.equal(rowsOf(mountRail({ sessions, runningOnly: true, runningSessionIds: new Set(sessions.map((s) => s.id)) }).container).length, 30);
});

test("narrows to the matching sessions while searching", () => {
  const sessions = [
    session("hit", { name: "Deploy pipeline", modified: "2026-03-01T00:00:00.000Z" }),
    session("miss", { name: "Unrelated", modified: "2026-02-01T00:00:00.000Z" }),
    session("first-message-hit", { firstMessage: "deploy the thing", modified: "2026-01-01T00:00:00.000Z" }),
  ];
  const { container } = mountRail({ sessions, searchQuery: "DEPLOY" });
  assert.deepEqual(titlesOf(container), ["Deploy pipeline", "deploy the thing"]);
});

test("honors the running-only filter", () => {
  const sessions = [session("running", { name: "Running" }), session("idle", { name: "Idle" })];
  const { container } = mountRail({ sessions, runningOnly: true, runningSessionIds: new Set(["running"]) });
  assert.deepEqual(titlesOf(container), ["Running"]);
});

test("hides itself entirely when there is nothing to show", () => {
  assert.equal(mountRail({ sessions: [] }).container.querySelector(".sidebar-recent"), null);
  const noMatches = mountRail({ sessions: [session("a", { name: "Alpha" })], searchQuery: "zzz" });
  assert.equal(noMatches.container.querySelector(".sidebar-recent"), null);
});

test("marks the open session with a selection highlight", () => {
  const sessions = [session("sel", { name: "Selected" }), session("other", { name: "Other" })];
  const { container } = mountRail({ sessions, selectedSessionId: "sel" });
  const selected = rowsOf(container).find((row) => row.textContent.includes("Selected"));
  const other = rowsOf(container).find((row) => row.textContent.includes("Other"));
  assert.equal(selected.getAttribute("aria-current"), "true");
  assert.equal(other.getAttribute("aria-current"), null);
});

test("clicking a row opens that session", () => {
  const sessions = [session("one", { name: "One" }), session("two", { name: "Two" })];
  const calls = [];
  const { container } = mountRail({ sessions, onSelectSession: (s) => calls.push(s) });
  const target = rowsOf(container).find((row) => row.textContent.includes("Two"));
  fireEvent.click(target);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].id, "two", "the row resolves its own session id, never a stale object");
  assert.equal(calls[0].name, "Two");
});

test("collapses from the header chevron and persists the choice", () => {
  const sessions = [session("a", { name: "Alpha" }), session("b", { name: "Beta" })];
  const first = mountRail({ sessions });
  assert.equal(rowsOf(first.container).length, 2);
  assert.equal(window.localStorage.getItem(RECENT_COLLAPSED_STORAGE_KEY), "false", "expanded by default");

  fireEvent.click(toggleOf(first.container));
  assert.equal(rowsOf(first.container).length, 0, "collapsed hides the rows");
  assert.equal(toggleOf(first.container).getAttribute("aria-expanded"), "false");
  assert.equal(window.localStorage.getItem(RECENT_COLLAPSED_STORAGE_KEY), "true");

  // A fresh mount (i.e. a reload) remembers the collapsed state.
  const second = mountRail({ sessions });
  assert.equal(rowsOf(second.container).length, 0);

  fireEvent.click(toggleOf(second.container));
  assert.equal(rowsOf(second.container).length, 2);
  assert.equal(window.localStorage.getItem(RECENT_COLLAPSED_STORAGE_KEY), "false");
});

test("the collapse preference defaults to expanded and ignores garbage", () => {
  const memory = (initial) => {
    const map = new Map(initial ? [[RECENT_COLLAPSED_STORAGE_KEY, initial]] : []);
    return {
      map,
      getItem: (key) => (map.has(key) ? map.get(key) : null),
      setItem: (key, value) => { map.set(key, value); },
    };
  };
  assert.equal(loadRecentCollapsed(null), false, "no storage (SSR) → expanded");
  assert.equal(loadRecentCollapsed(memory()), false, "nothing stored → expanded");
  assert.equal(loadRecentCollapsed(memory("true")), true);
  assert.equal(loadRecentCollapsed(memory("yes")), false, "corrupt value → expanded");
  const storage = memory();
  saveRecentCollapsed(true, storage);
  assert.equal(storage.map.get(RECENT_COLLAPSED_STORAGE_KEY), "true");
  const throwing = {
    getItem: () => { throw new Error("privacy mode"); },
    setItem: () => { throw new Error("privacy mode"); },
  };
  assert.equal(loadRecentCollapsed(throwing), false);
  assert.doesNotThrow(() => saveRecentCollapsed(true, throwing));
});

// ---------------------------------------------------------------------------
// Structure pins (the sidebar owns the wiring)
// ---------------------------------------------------------------------------

const sidebarSource = readSource("./SessionSidebar.tsx");
const rowsSource = readSource("./SessionSidebar-rows.tsx");

test("the sidebar mounts the Recent rail above the workspace tree", () => {
  assert.match(sidebarSource, /import \{ RecentSessionsSection \} from "\.\/SessionSidebar-recent"/);
  assert.match(sidebarSource, /<RecentSessionsSection/);
  assert.match(sidebarSource, /sessions=\{visibleSessions\}/, "the rail sees every project's sessions");
  assert.match(sidebarSource, /onSelectSession=\{handleSelectSessionFromList\}/, "clicks reuse the session-select path");
  assert.match(sidebarSource, /searchQuery=\{deferredSearchQuery\}/, "the rail honors the sidebar search");
  assert.match(sidebarSource, /runningOnly=\{runningOnly\}/);
  // Above the first workspace entry AND inside the scrolling list container.
  const railIndex = sidebarSource.indexOf("<RecentSessionsSection");
  const firstProjectRow = sidebarSource.indexOf("visibleProjectEntries.map");
  assert.ok(railIndex > 0 && firstProjectRow > railIndex, "rail renders before the project rows");
  const scrollContainer = sidebarSource.indexOf('overflowY: "auto"');
  assert.ok(scrollContainer > 0 && railIndex > scrollContainer, "rail lives inside the scroll container (never pinned chrome)");
});

test("the sort toggle is a persisted preference driving the activity-aware sort", () => {
  assert.match(sidebarSource, /useState<ProjectSortMode>\(\(\) => loadProjectSortMode\(\)\)/);
  assert.match(sidebarSource, /saveProjectSortMode\(projectSortMode\)/);
  assert.match(sidebarSource, /projectSortMode === "recent" \? projectRecencyByPath : undefined/, "only 'recent' opts into activity ordering");
  assert.match(sidebarSource, /projectSortMode === "recent" \? t\("sessionSidebar\.projectSortRecent"\) : t\("sessionSidebar\.projectSortAdded"\)/);
  assert.match(sidebarSource, /active=\{projectSortMode === "recent"\}/);
  assert.match(sidebarSource, /<Clock size=\{15\}/, "lucide Clock icon (no new icon system)");
  assert.match(sidebarSource, /setProjectSortMode\("added"\)/, "an explicit reorder flips the toggle onto the order it just created (manual order always wins)");
});

test("project rows receive a preformatted activity age, only when they have sessions", () => {
  assert.match(sidebarSource, /projectLastActiveLabels\.get\(comparableProjectPath\(project\.path\)\)/);
  assert.match(sidebarSource, /lastActiveLabel=\{lastActiveLabel\}/);
  assert.match(rowsSource, /lastActiveLabel\?: string/);
  assert.match(rowsSource, /sessionSidebar\.projectLastActive/);
});

test("a workspace row renders the age hint beside the name (and omits it when absent)", () => {
  const base = {
    project: { path: "/repos/alpha" },
    isActive: false,
    isExpanded: false,
    tree: [],
    hiddenCount: 0,
    selectedSessionId: null,
    runningSessionIds: new Set(),
    unreadSessionIds: new Set(),
    relativeTimeNow: Date.now(),
    onActivate: () => {},
    onToggleExpand: () => {},
    onRemoveProject: () => {},
    onEditLaunchConfig: () => {},
    onUpdatePresentation: () => {},
    onDragPathChange: () => {},
    onDropProject: () => {},
    onMoveProject: () => {},
    isDragTarget: false,
    removeBusy: false,
    onSelectSession: () => {},
    homeDir: "",
  };
  const withAge = render(React.createElement(ProjectRow, { ...base, lastActiveLabel: "3h" }));
  const identity = withAge.container.querySelector(".sidebar-project-identity");
  assert.match(identity.textContent, /alpha3h/, "name + muted age hint share the row identity");

  cleanup();
  const withoutAge = render(React.createElement(ProjectRow, base));
  const bare = withoutAge.container.querySelector(".sidebar-project-identity");
  assert.equal(bare.textContent, "alpha", "empty/never-used workspaces carry no age hint");
});
