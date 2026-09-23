import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const {
  DEFAULT_PROJECT_SORT_MODE,
  PROJECT_SORT_STORAGE_KEY,
  RECENT_SESSIONS_FILTER_LIMIT,
  RECENT_SESSIONS_REST_LIMIT,
  buildOrderResetUpdates,
  groupSessionsByProject,
  hasManualProjectOrder,
  loadProjectSortMode,
  projectActivityCounts,
  projectRecency,
  recentSessions,
  saveProjectSortMode,
  sortManagedProjects,
} = await jiti.import("./project-ordering.ts");
const { comparableProjectPath } = await jiti.import("./comparable-path.ts");

function session(id, overrides = {}) {
  return {
    path: `/sessions/${id}.jsonl`,
    id,
    cwd: `/work/${id}`,
    created: "2026-01-01T00:00:00.000Z",
    modified: "2026-01-01T00:00:00.000Z",
    messageCount: 1,
    firstMessage: "hi",
    ...overrides,
  };
}

test("sorts registered projects by most-recently-added, tie-broken by path", () => {
  const projects = [
    { path: "/proj/oldest", addedAt: "2026-01-01T00:00:00.000Z" },
    { path: "/proj/newest", addedAt: "2026-03-01T00:00:00.000Z" },
    { path: "/proj/middle", addedAt: "2026-02-01T00:00:00.000Z" },
  ];
  const sorted = sortManagedProjects(projects).map((p) => p.path);
  assert.deepEqual(sorted, ["/proj/newest", "/proj/middle", "/proj/oldest"]);
});

test("manual workspace order overrides add time and remains stable", () => {
  const projects = [
    { path: "/proj/new", addedAt: "2026-03-01T00:00:00.000Z", sortOrder: 1 },
    { path: "/proj/old", addedAt: "2026-01-01T00:00:00.000Z", sortOrder: 0 },
  ];
  assert.deepEqual(sortManagedProjects(projects).map((project) => project.path), ["/proj/old", "/proj/new"]);
});

test("project order is stable regardless of session activity", () => {
  const projects = [
    { path: "/proj/a", addedAt: "2026-01-01T00:00:00.000Z" },
    { path: "/proj/b", addedAt: "2026-02-01T00:00:00.000Z" },
  ];
  const sorted = sortManagedProjects(projects).map((p) => p.path);
  // A session whose modified timestamp is newer than project B's must NOT
  // bump project A above it — rows must never reorder from activity.
  const sessions = [
    session("s-a", { modified: "2026-06-01T00:00:00.000Z", projectRoot: "/proj/a" }),
    session("s-b", { modified: "2026-03-01T00:00:00.000Z", projectRoot: "/proj/b" }),
  ];
  const sortedAfterActivity = sortManagedProjects(projects).map((p) => p.path);
  assert.deepEqual(sorted, ["/proj/b", "/proj/a"]);
  assert.deepEqual(sortedAfterActivity, sorted);
  assert.ok(sessions.length === 2); // sessions are irrelevant to ordering
});

test("session-discovered projects without addedAt sort below registered, by path", () => {
  const projects = [
    { path: "/proj/registered" }, // discovered, no addedAt
    { path: "/proj/active", addedAt: "2026-01-01T00:00:00.000Z" },
    { path: "/proj/inactive", addedAt: "2026-02-01T00:00:00.000Z" },
    { path: "/proj/zzz" }, // discovered
  ];
  const sorted = sortManagedProjects(projects).map((p) => p.path);
  assert.deepEqual(sorted, ["/proj/inactive", "/proj/active", "/proj/registered", "/proj/zzz"]);
});

test("groups sessions under their project, including worktree sessions", () => {
  const projects = [
    { path: "/repo", addedAt: "2026-01-01T00:00:00.000Z" },
    { path: "/empty", addedAt: "2026-02-01T00:00:00.000Z" },
    { path: "/other" },
  ];
  const sessions = [
    // Worktree session: cwd differs, projectRoot is the main repo.
    session("wt", { cwd: "/repo-worktrees/feature", projectRoot: "/repo" }),
    // Forked session groups under its project like any other session.
    session("fork", { parentSessionId: "parent", projectRoot: "/other" }),
    session("parent", { projectRoot: "/other" }),
  ];
  const grouped = groupSessionsByProject(projects, sessions);
  assert.deepEqual(grouped.get("/repo").map((s) => s.id), ["wt"]);
  // Empty managed project gets an (empty) bucket.
  assert.deepEqual(grouped.get("/empty"), []);
  assert.deepEqual(grouped.get("/other").map((s) => s.id).sort(), ["fork", "parent"]);
});

test("projectActivityCounts tallies running and unread per project", () => {
  const sessions = [
    session("running-main", { projectRoot: "/repo" }),
    session("unread-main", { projectRoot: "/repo" }),
    session("running-wt", { cwd: "/repo-worktrees/x", projectRoot: "/repo" }),
    session("idle-other", { projectRoot: "/other" }),
  ];
  const counts = projectActivityCounts(sessions, ["running-main", "running-wt"], ["unread-main"]);
  // Keys are the case-folded comparable form (see projectActivityCounts docs).
  assert.deepEqual(counts.get(comparableProjectPath("/repo")), { running: 2, unread: 1 });
  assert.deepEqual(counts.get(comparableProjectPath("/other")), { running: 0, unread: 0 });
});

test("casing-only projectRoot differences still group and tally on Windows", { skip: process.platform !== "win32" }, () => {
  // A session file whose cwd casing differs from the registered project path
  // must still land in that project's bucket and its activity row.
  const projects = [{ path: "D:\\OtherProjects\\Waku", addedAt: "2026-01-01T00:00:00.000Z" }];
  const sessions = [session("s1", { projectRoot: "d:\\otherprojects\\waku" })];
  const grouped = groupSessionsByProject(projects, sessions);
  assert.deepEqual(grouped.get("D:\\OtherProjects\\Waku").map((s) => s.id), ["s1"]);
  const counts = projectActivityCounts(sessions, ["s1"], []);
  assert.deepEqual(counts.get(comparableProjectPath("d:\\otherprojects\\waku")), { running: 1, unread: 0 });
});

test("running session placeholders group stably under their own project cwd, not active workspace", () => {
  const projects = [
    { path: "/project-a", addedAt: "2026-01-01T00:00:00.000Z" },
    { path: "/project-b", addedAt: "2026-02-01T00:00:00.000Z" },
    { path: "/project-c", addedAt: "2026-03-01T00:00:00.000Z" },
  ];
  // Session started in project A (running placeholder with path: "")
  const runningSessionInA = session("running-in-a", {
    path: "",
    cwd: "/project-a",
    projectRoot: "/project-a",
  });
  // Existing sessions in project B and C
  const sessionInB = session("session-b", { projectRoot: "/project-b" });
  const sessionInC = session("session-c", { projectRoot: "/project-c" });

  const visibleSessions = [sessionInB, sessionInC, runningSessionInA];
  const grouped = groupSessionsByProject(projects, visibleSessions);

  assert.deepEqual(grouped.get("/project-a").map((s) => s.id), ["running-in-a"]);
  assert.deepEqual(grouped.get("/project-b").map((s) => s.id), ["session-b"]);
  assert.deepEqual(grouped.get("/project-c").map((s) => s.id), ["session-c"]);
});

// ---------------------------------------------------------------------------
// Activity-aware ordering ("Sort: recent activity")
// ---------------------------------------------------------------------------

/** Activity map in the shape the sidebar builds it: comparable project path →
 *  newest session timestamp. */
function activity(pairs) {
  return new Map(pairs.map(([path, ts]) => [comparableProjectPath(path), Date.parse(ts)]));
}

test("activity map orders projects by most recent session activity", () => {
  const projects = [
    { path: "/proj/stale", addedAt: "2026-03-01T00:00:00.000Z" },
    { path: "/proj/fresh", addedAt: "2026-01-01T00:00:00.000Z" },
    { path: "/proj/middle", addedAt: "2026-02-01T00:00:00.000Z" },
  ];
  const map = activity([
    ["/proj/stale", "2026-04-01T00:00:00.000Z"],
    ["/proj/fresh", "2026-06-01T00:00:00.000Z"],
    ["/proj/middle", "2026-05-01T00:00:00.000Z"],
  ]);
  assert.deepEqual(
    sortManagedProjects(projects, map).map((p) => p.path),
    ["/proj/fresh", "/proj/middle", "/proj/stale"],
  );
});

test("projects without activity sink below every project that has activity", () => {
  const projects = [
    { path: "/proj/quiet-a", addedAt: "2026-02-01T00:00:00.000Z" },
    { path: "/proj/active", addedAt: "2026-01-01T00:00:00.000Z" },
    { path: "/proj/quiet-b", addedAt: "2026-03-01T00:00:00.000Z" },
  ];
  // Only the middle project has sessions at all.
  const map = activity([["/proj/active", "2026-01-01T00:00:00.000Z"]]);
  assert.deepEqual(
    sortManagedProjects(projects, map).map((p) => p.path),
    // "quiet-b" is newer by addedAt, so it leads the activity-less tail.
    ["/proj/active", "/proj/quiet-b", "/proj/quiet-a"],
  );
});

test("manual workspace order wins over recency", () => {
  const projects = [
    { path: "/proj/hot", addedAt: "2026-01-01T00:00:00.000Z", sortOrder: 1 },
    { path: "/proj/cold", addedAt: "2026-06-01T00:00:00.000Z", sortOrder: 0 },
    { path: "/proj/unordered", addedAt: "2026-07-01T00:00:00.000Z" },
  ];
  const map = activity([
    ["/proj/hot", "2026-09-01T00:00:00.000Z"],
    ["/proj/unordered", "2026-09-02T00:00:00.000Z"],
    ["/proj/cold", "2026-01-01T00:00:00.000Z"],
  ]);
  assert.deepEqual(
    sortManagedProjects(projects, map).map((p) => p.path),
    ["/proj/cold", "/proj/hot", "/proj/unordered"],
  );
});

test("equal activity falls through to addedAt then path (deterministic)", () => {
  const tie = "2026-05-01T00:00:00.000Z";
  const projects = [
    { path: "/proj/b", addedAt: "2026-01-01T00:00:00.000Z" },
    { path: "/proj/a", addedAt: "2026-01-01T00:00:00.000Z" },
    { path: "/proj/newest", addedAt: "2026-02-01T00:00:00.000Z" },
  ];
  const map = activity([["/proj/b", tie], ["/proj/a", tie], ["/proj/newest", tie]]);
  assert.deepEqual(
    sortManagedProjects(projects, map).map((p) => p.path),
    ["/proj/newest", "/proj/a", "/proj/b"],
  );
});

test("omitting the map reproduces the exact registration order for the same input", () => {
  const projects = [
    { path: "/proj/old", addedAt: "2026-01-01T00:00:00.000Z" },
    { path: "/proj/new", addedAt: "2026-03-01T00:00:00.000Z" },
    { path: "/proj/discovered" },
  ];
  const registered = sortManagedProjects(projects).map((p) => p.path);
  assert.deepEqual(registered, ["/proj/new", "/proj/old", "/proj/discovered"]);
  // The very same recency map that WOULD reorder things is ignored when the
  // caller does not opt in (AppShell's palette options rely on this).
  const map = activity([
    ["/proj/old", "2026-09-01T00:00:00.000Z"],
    ["/proj/discovered", "2026-09-02T00:00:00.000Z"],
  ]);
  assert.deepEqual(sortManagedProjects(projects).map((p) => p.path), registered);
  assert.notDeepEqual(sortManagedProjects(projects, map).map((p) => p.path), registered);
});

test("activity is matched through the case-folded comparable path", { skip: process.platform !== "win32" }, () => {
  const projects = [
    { path: "D:\\Repos\\Alpha", addedAt: "2026-01-01T00:00:00.000Z" },
    { path: "D:\\Repos\\Beta", addedAt: "2026-02-01T00:00:00.000Z" },
  ];
  // Session cwd casing differs from the registered project path.
  const map = projectRecency([session("s1", { projectRoot: "d:\\repos\\alpha", modified: "2026-08-01T00:00:00.000Z" })]);
  assert.deepEqual(
    sortManagedProjects(projects, map).map((p) => p.path),
    ["D:\\Repos\\Alpha", "D:\\Repos\\Beta"],
  );
});

test("non-finite activity timestamps count as no activity", () => {
  const projects = [
    { path: "/proj/a", addedAt: "2026-01-01T00:00:00.000Z" },
    { path: "/proj/b", addedAt: "2026-02-01T00:00:00.000Z" },
  ];
  const map = new Map([[comparableProjectPath("/proj/a"), Number.NaN]]);
  assert.deepEqual(sortManagedProjects(projects, map).map((p) => p.path), ["/proj/b", "/proj/a"]);
});

test("projectRecency keeps the newest timestamp per project and skips unparseable ones", () => {
  const sessions = [
    session("a-old", { projectRoot: "/repo", modified: "2026-01-01T00:00:00.000Z" }),
    session("a-new", { projectRoot: "/repo", modified: "2026-04-01T00:00:00.000Z" }),
    session("wt", { cwd: "/repo-worktrees/x", projectRoot: "/repo", modified: "2026-02-01T00:00:00.000Z" }),
    session("broken", { projectRoot: "/other", modified: "not-a-date" }),
  ];
  const recency = projectRecency(sessions);
  assert.equal(recency.get(comparableProjectPath("/repo")), Date.parse("2026-04-01T00:00:00.000Z"));
  assert.equal(recency.has(comparableProjectPath("/other")), false, "unparseable timestamps add no entry");
});

test("projectRecency keys empty-cwd sessions out instead of bucketing them", () => {
  const recency = projectRecency([session("no-cwd", { cwd: "", projectRoot: undefined, projectKey: undefined })]);
  assert.equal(recency.size, 0);
});

// ---------------------------------------------------------------------------
// Cross-project recent list
// ---------------------------------------------------------------------------

function withTimes(pairs) {
  return pairs.map(([id, modified, overrides]) => session(id, { modified, ...overrides }));
}

test("recentSessions returns the newest sessions across all projects, newest first", () => {
  const sessions = withTimes([
    ["s-old", "2026-01-01T00:00:00.000Z", { projectRoot: "/a" }],
    ["s-new", "2026-03-01T00:00:00.000Z", { projectRoot: "/b" }],
    ["s-mid", "2026-02-01T00:00:00.000Z", { projectRoot: "/c" }],
  ]);
  const { items, total } = recentSessions(sessions);
  assert.deepEqual(items.map((s) => s.id), ["s-new", "s-mid", "s-old"]);
  assert.equal(total, 3);
});

test("recentSessions caps at rest and reports the remainder through total", () => {
  const sessions = withTimes(
    Array.from({ length: 12 }, (_, index) => [
      `s-${String(index).padStart(2, "0")}`,
      new Date(Date.UTC(2026, 0, index + 1)).toISOString(),
    ]),
  );
  const { items, total } = recentSessions(sessions);
  assert.equal(items.length, RECENT_SESSIONS_REST_LIMIT);
  assert.equal(total, 12, "the caller renders '+N older' from total - items.length");
  assert.deepEqual(items.map((s) => s.id), ["s-11", "s-10", "s-09", "s-08", "s-07", "s-06", "s-05", "s-04"]);
});

test("recentSessions raises the cap to 30 while a filter is active", () => {
  const many = withTimes(
    Array.from({ length: 40 }, (_, index) => [
      `s-${String(index).padStart(2, "0")}`,
      new Date(Date.UTC(2026, 0, index + 1)).toISOString(),
      { firstMessage: "needle" },
    ]),
  );
  const rest = recentSessions(many);
  assert.equal(rest.items.length, RECENT_SESSIONS_REST_LIMIT);
  const filtered = recentSessions(many, { query: "needle" });
  assert.equal(filtered.items.length, RECENT_SESSIONS_FILTER_LIMIT);
  assert.equal(filtered.total, 40);
  const running = recentSessions(many, { runningOnly: true, runningIds: many.map((s) => s.id) });
  assert.equal(running.items.length, RECENT_SESSIONS_FILTER_LIMIT);
  // An explicit limit always wins over both defaults.
  assert.equal(recentSessions(many, { limit: 2 }).items.length, 2);
});

test("recentSessions filters on session name and first message, case-insensitively", () => {
  const sessions = [
    session("named", { name: "Refactor the sidebar", firstMessage: "hi" }),
    session("first", { firstMessage: "Sidebar feels messy" }),
    session("other", { name: "Unrelated", firstMessage: "nope" }),
  ];
  assert.deepEqual(recentSessions(sessions, { query: "SIDEBAR" }).items.map((s) => s.id).sort(), ["first", "named"]);
  assert.deepEqual(recentSessions(sessions, { query: "  messy  " }).items.map((s) => s.id), ["first"]);
  assert.equal(recentSessions(sessions, { query: "nothing-matches" }).total, 0);
});

test("recentSessions runningOnly keeps running ids only", () => {
  const sessions = withTimes([
    ["running", "2026-01-01T00:00:00.000Z"],
    ["idle", "2026-02-01T00:00:00.000Z"],
  ]);
  const { items, total } = recentSessions(sessions, { runningOnly: true, runningIds: ["running"] });
  assert.deepEqual(items.map((s) => s.id), ["running"]);
  assert.equal(total, 1);
});

test("recentSessions tie-breaks deterministically and sinks unparseable timestamps", () => {
  const sessions = [
    session("b", { modified: "2026-05-01T00:00:00.000Z" }),
    session("a", { modified: "2026-05-01T00:00:00.000Z" }),
    session("broken", { modified: "nope" }),
  ];
  assert.deepEqual(recentSessions(sessions).items.map((s) => s.id), ["a", "b", "broken"]);
});

test("recentSessions on an empty list yields no rows", () => {
  assert.deepEqual(recentSessions([]), { items: [], total: 0 });
});

// ---------------------------------------------------------------------------
// Persisted sort mode
// ---------------------------------------------------------------------------

function memoryStorage(initial) {
  const map = new Map(Object.entries(initial ?? {}));
  return {
    map,
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => { map.set(key, value); },
  };
}

test("project sort mode defaults to recent and survives a round trip", () => {
  assert.equal(DEFAULT_PROJECT_SORT_MODE, "recent");
  assert.equal(loadProjectSortMode(null), "recent", "no storage (SSR) → recent");
  const storage = memoryStorage();
  assert.equal(loadProjectSortMode(storage), "recent", "nothing stored → recent");
  saveProjectSortMode("added", storage);
  assert.equal(storage.map.get(PROJECT_SORT_STORAGE_KEY), "added");
  assert.equal(loadProjectSortMode(storage), "added");
  saveProjectSortMode("recent", storage);
  assert.equal(loadProjectSortMode(storage), "recent");
});

test("a corrupt stored sort mode falls back to recent", () => {
  assert.equal(loadProjectSortMode(memoryStorage({ [PROJECT_SORT_STORAGE_KEY]: "by-vibes" })), "recent");
  assert.equal(loadProjectSortMode(memoryStorage({ [PROJECT_SORT_STORAGE_KEY]: "" })), "recent");
  const throwing = {
    getItem: () => { throw new Error("privacy mode"); },
    setItem: () => { throw new Error("privacy mode"); },
  };
  assert.equal(loadProjectSortMode(throwing), "recent");
  assert.doesNotThrow(() => saveProjectSortMode("added", throwing));
});

/* ---------------------- reset-order helpers (W3-P25) ---------------------- */

test("buildOrderResetUpdates: one null-rank entry per project, caller order kept", () => {
  const payload = buildOrderResetUpdates([{ path: "C:\a" }, { path: "C:\b" }]);
  assert.deepEqual(payload, {
    updates: [{ cwd: "C:\a", sortOrder: null }, { cwd: "C:\b", sortOrder: null }],
  });
  // Empty list stays an empty batch (the route rejects nothing here; the
  // caller simply has nothing to unpin).
  assert.deepEqual(buildOrderResetUpdates([]), { updates: [] });
  // null (not undefined) is the registry's documented "clear the rank" value.
  assert.equal(payload.updates.every((update) => update.sortOrder === null), true);
});

test("hasManualProjectOrder: true only while some project carries a rank", () => {
  assert.equal(hasManualProjectOrder([]), false);
  assert.equal(hasManualProjectOrder([{ sortOrder: undefined }, { sortOrder: undefined }]), false);
  assert.equal(hasManualProjectOrder([{ sortOrder: undefined }, { sortOrder: 0 }]), true,
    "rank 0 is a real rank — falsy values must not read as unpinned");
  assert.equal(hasManualProjectOrder([{ sortOrder: 3 }]), true);
});
