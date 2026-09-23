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

// ============================================================================
// P20.3 / P20.4 — share-target intake
// ============================================================================

test("share target bounds are pinned", async () => {
  const { SHARE_PROVENANCE_HEADER, SHARE_TEXT_MAX_CHARS, SHARE_URL_MAX_CHARS } = await loadSubject();
  // Provenance header must stay byte-identical: it is the visible P20.4
  // review-before-send marker prefixed onto every share-target draft.
  assert.equal(SHARE_PROVENANCE_HEADER, "[Shared from another app — review before sending]");
  assert.equal(SHARE_TEXT_MAX_CHARS, 8000);
  assert.equal(SHARE_URL_MAX_CHARS, 2048);
});

test("parses share text only", async () => {
  const { parseShareTarget } = await loadSubject();
  assert.deepEqual(parseShareTarget(new URLSearchParams({ "share-text": "hello from gmaps" })), {
    text: "hello from gmaps",
    url: null,
  });
});

test("parses share url only", async () => {
  const { parseShareTarget } = await loadSubject();
  assert.deepEqual(parseShareTarget(new URLSearchParams({ "share-url": "https://example.com/page" })), {
    text: "",
    url: "https://example.com/page",
  });
});

test("parses both share text and url", async () => {
  const { parseShareTarget } = await loadSubject();
  assert.deepEqual(
    parseShareTarget(new URLSearchParams({ "share-text": "look", "share-url": "https://example.com/x" })),
    { text: "look", url: "https://example.com/x" },
  );
});

test("returns null when share params are absent or whitespace-only", async () => {
  const { parseShareTarget } = await loadSubject();
  assert.equal(parseShareTarget(new URLSearchParams({})), null);
  assert.equal(parseShareTarget(new URLSearchParams({ session: "s1" })), null);
  assert.equal(parseShareTarget(new URLSearchParams({ "share-text": "   ", "share-url": " \t " })), null);
  assert.deepEqual(parseShareTarget(new URLSearchParams({ "share-text": "  ", "share-url": "https://x.io" })), {
    text: "",
    url: "https://x.io",
  });
});

test("oversized share text and url are truncated to the caps", async () => {
  const { parseShareTarget, SHARE_TEXT_MAX_CHARS, SHARE_URL_MAX_CHARS } = await loadSubject();
  const longText = "x".repeat(SHARE_TEXT_MAX_CHARS + 500);
  const longUrl = "https://example.com/" + "y".repeat(SHARE_URL_MAX_CHARS);
  const parsed = parseShareTarget(new URLSearchParams({ "share-text": longText, "share-url": longUrl }));
  assert.equal(parsed.text.length, SHARE_TEXT_MAX_CHARS);
  assert.equal(parsed.url.length, SHARE_URL_MAX_CHARS);
  // Truncation, not replacement: prefixes survive.
  assert.ok(parsed.text.startsWith("x"));
  assert.ok(parsed.url.startsWith("https://example.com/"));
});

test("builds the provenance-prefixed draft message", async () => {
  const { buildShareDraftMessage, SHARE_PROVENANCE_HEADER } = await loadSubject();
  // Both parts.
  assert.equal(
    buildShareDraftMessage({ text: "look", url: "https://example.com/x" }),
    `${SHARE_PROVENANCE_HEADER}\nlook\nhttps://example.com/x`,
  );
  // Text only — no trailing separator.
  assert.equal(buildShareDraftMessage({ text: "look", url: null }), `${SHARE_PROVENANCE_HEADER}\nlook`);
  // Url only — header still leads, no blank middle line.
  assert.equal(
    buildShareDraftMessage({ text: "", url: "https://example.com/x" }),
    `${SHARE_PROVENANCE_HEADER}\nhttps://example.com/x`,
  );
  // Empty payload builds nothing (parseShareTarget never yields this, but the
  // builder must not emit a bare header for a blank draft).
  assert.equal(buildShareDraftMessage({ text: "", url: null }), "");
  // Re-bounds defensively even when handed an oversized payload.
  assert.equal(buildShareDraftMessage({ text: "z".repeat(9000), url: null }).length, SHARE_PROVENANCE_HEADER.length + 1 + 8000);
});

test("stripShareTargetParams removes share params and keeps the rest", async () => {
  const { stripShareTargetParams } = await loadSubject();
  const calls = [];
  const replaced = stripShareTargetParams(
    "?share-text=hi&share-url=https%3A%2F%2Fx.io&session=s1",
    "/app",
    (url) => calls.push(url),
  );
  assert.equal(replaced, true);
  assert.deepEqual(calls, ["/app?session=s1"]);
});

test("stripShareTargetParams drops the question mark when nothing remains and is a no-op without share params", async () => {
  const { stripShareTargetParams } = await loadSubject();
  const calls = [];
  assert.equal(stripShareTargetParams("?share-text=hi", "/app#frag", (url) => calls.push(url)), true);
  assert.deepEqual(calls, ["/app#frag"]);
  assert.equal(stripShareTargetParams("?session=s1", "/", (url) => calls.push(url)), false);
  assert.deepEqual(calls, ["/app#frag"]);
});
