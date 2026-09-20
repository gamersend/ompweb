import assert from "node:assert/strict";
import test from "node:test";

async function loadSubject() {
  return import("./initial-navigation.ts");
}

test("uses cwd instead of session when both parameters are present", async () => {
  const { getInitialNavigation } = await loadSubject();
  const result = getInitialNavigation(new URLSearchParams({
    cwd: " /work/project ",
    session: "saved-session",
  }));

  assert.deepEqual(result, {
    requestedCwd: "/work/project",
    sessionId: null,
    anchor: null,
  });
});

test("restores session when cwd is absent", async () => {
  const { getInitialNavigation } = await loadSubject();

  assert.deepEqual(
    getInitialNavigation(new URLSearchParams({ session: "saved-session" })),
    { requestedCwd: null, sessionId: "saved-session", anchor: null },
  );
});

test("treats an empty cwd as absent", async () => {
  const { getInitialNavigation } = await loadSubject();

  assert.deepEqual(
    getInitialNavigation(new URLSearchParams({ cwd: "  ", session: "saved-session" })),
    { requestedCwd: null, sessionId: "saved-session", anchor: null },
  );
});

test("preserves a URL-encoded Windows path", async () => {
  const { getInitialNavigation } = await loadSubject();

  assert.deepEqual(
    getInitialNavigation(new URLSearchParams("cwd=C%3A%5CProjects%5Cpi-web")),
    { requestedCwd: "C:\\Projects\\pi-web", sessionId: null, anchor: null },
  );
});

test("parses the P1 anchor param with an optional hl range", async () => {
  const { getInitialNavigation } = await loadSubject();

  assert.deepEqual(
    getInitialNavigation(new URLSearchParams({ session: "s1", anchor: "ab12cd34" })),
    { requestedCwd: null, sessionId: "s1", anchor: { entryId: "ab12cd34" } },
  );
  assert.deepEqual(
    getInitialNavigation(new URLSearchParams({ session: "s1", anchor: "ab12cd34", hl: "10,42" })),
    { requestedCwd: null, sessionId: "s1", anchor: { entryId: "ab12cd34", hl: [10, 42] } },
  );
  // Malformed hl degrades to entry-only, never throws.
  assert.deepEqual(
    getInitialNavigation(new URLSearchParams({ anchor: "ab12cd34", hl: "bogus" })),
    { requestedCwd: null, sessionId: null, anchor: { entryId: "ab12cd34" } },
  );
  assert.equal(getInitialNavigation(new URLSearchParams({})).anchor, null);
});
