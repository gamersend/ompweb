import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

// Throwaway agent dir BEFORE the modules load.
const testRoot = mkdtempSync(join(tmpdir(), "omp-web-advisor-"));
process.env.PI_CODING_AGENT_DIR = join(testRoot, "agent");

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const {
  ADVISOR_MAX_OBSERVATIONS,
  ADVISOR_SUMMARY_MAX_CHARS,
  extractAdvisorEvidence,
  readAdvisorEvidence,
} = await jiti.import("./advisor-evidence.ts");

// ============================================================================
// Advisor/prewalk evidence (P15 / R3-16): extraction from fabricated entries,
// redaction at the boundary, 20-observation cap with the truncated flag, and
// the route pinned as an envelope + read-only surface.
// ============================================================================

const advisorEntry = (text, overrides = {}) => ({
  id: "e-adv",
  type: "message",
  parentId: null,
  timestamp: "2026-09-21T10:00:00.000Z",
  message: {
    role: "custom",
    customType: "advisor",
    display: true,
    content: [{ type: "text", text }],
  },
  ...overrides,
});

const withIndex = (entries) => entries.map((entry, i) => ({ ...entry, id: `e-${i}` }));

test("extracts advisor custom messages (message-entry shape, live shape)", () => {
  const result = extractAdvisorEvidence([advisorEntry("Consider splitting the module.")]);
  assert.equal(result.truncated, false);
  assert.equal(result.observations.length, 1);
  assert.equal(result.observations[0].kind, "advisor");
  assert.equal(result.observations[0].ts, "2026-09-21T10:00:00.000Z");
  assert.ok(result.observations[0].summary.includes("Consider splitting the module."));
});

test("custom_message top-level shape + prewalk detection (customType and text mention)", () => {
  const result = extractAdvisorEvidence([
    {
      id: "c1", type: "custom_message", parentId: null, timestamp: "2026-09-21T10:01:00.000Z",
      customType: "prewalk", display: true, content: "Walking the plan before the run.",
    },
    {
      id: "c2", type: "custom_message", parentId: null, timestamp: "2026-09-21T10:02:00.000Z",
      customType: "note", display: true, content: [{ type: "text", text: "queued a prewalk hand-off soon" }],
    },
  ]);
  assert.equal(result.observations.length, 2);
  assert.equal(result.observations[0].kind, "prewalk");
  assert.equal(result.observations[1].kind, "prewalk", "a prewalk mention in text is enough");
});

test("advisor customType wins over a mere prewalk mention; epoch message timestamps normalize to ISO", () => {
  const result = extractAdvisorEvidence([
    advisorEntry("reviewing the prewalk notes", {
      timestamp: undefined, // force the message-level epoch fallback
      message: { role: "custom", customType: "advisor", content: "reviewing the prewalk notes", timestamp: 1726900000000 },
    }),
  ]);
  assert.equal(result.observations.length, 1);
  assert.equal(result.observations[0].kind, "advisor", 'customType "advisor" beats a text mention');
  assert.equal(result.observations[0].ts, new Date(1726900000000).toISOString());
});

test("entries with no extractable text become kind-only observations", () => {
  const result = extractAdvisorEvidence([
    advisorEntry("has text"),
    advisorEntry(undefined, {
      message: { role: "custom", customType: "advisor", display: true, content: [{ type: "image", data: "x" }] },
    }),
    advisorEntry(undefined, { message: { role: "custom", customType: "advisor", display: true, content: "   " } }),
  ]);
  assert.equal(result.observations.length, 3);
  assert.equal(result.observations[0].summary.includes("has text"), true);
  assert.equal("summary" in result.observations[1], false, "image-only content: no summary key");
  assert.equal("summary" in result.observations[2], false, "whitespace-only content: no summary key");
  assert.equal(result.observations[1].kind, "advisor");
});

test("junk shapes are skipped, extraction never throws", () => {
  const junk = [null, 42, "str", [], {}, { type: "message" }, { type: "message", message: { role: "custom" } },
    { type: "custom_message" }, { type: "message", message: { role: "assistant", content: "ignored" } }];
  const result = extractAdvisorEvidence([...junk, advisorEntry("the one real observation")]);
  assert.equal(result.observations.length, 1);
  assert.equal(result.observations[0].kind, "advisor");
});

test("redaction: an api-key-shaped token never survives into summaries", () => {
  const secret = "sk-abcdefghijklmnopqrst";
  const result = extractAdvisorEvidence([advisorEntry(`check key ${secret} end`)]);
  const wire = JSON.stringify(result);
  assert.equal(wire.includes(secret), false, "the sk- token must be masked");
  assert.ok(wire.includes("🔒"), "the redaction marker is visible instead");
});

test("summaries are hard-capped at 200 chars", () => {
  const long = "word ".repeat(120).trim();
  const result = extractAdvisorEvidence([advisorEntry(long)]);
  const summary = result.observations[0].summary;
  assert.ok(summary.length <= ADVISOR_SUMMARY_MAX_CHARS + 1, `got ${summary.length}`);
});

test("cap: newest 20 kept in order, truncated flag set, droppedCount honest", () => {
  const many = withIndex(
    Array.from({ length: ADVISOR_MAX_OBSERVATIONS + 5 }, (_, i) =>
      advisorEntry(`observation number ${i}`, { timestamp: `2026-09-21T10:${String(i).padStart(2, "0")}:00.000Z` })),
  );
  const result = extractAdvisorEvidence(many);
  assert.equal(result.truncated, true);
  assert.equal(result.observations.length, ADVISOR_MAX_OBSERVATIONS);
  assert.equal(result.droppedCount, 5);
  assert.ok(result.observations[0].summary.includes("observation number 5"), "oldest dropped, chronological order kept");
  assert.ok(result.observations[ADVISOR_MAX_OBSERVATIONS - 1].summary.includes("observation number 24"), "newest last");

  const exact = extractAdvisorEvidence(
    Array.from({ length: ADVISOR_MAX_OBSERVATIONS }, (_, i) => advisorEntry(`exactly ${i}`)),
  );
  assert.equal(exact.truncated, false);
  assert.equal("droppedCount" in exact, false);
  assert.equal(exact.observations.length, ADVISOR_MAX_OBSERVATIONS);
});

test("readAdvisorEvidence degrades to empty on a missing/unreadable file", () => {
  const result = readAdvisorEvidence(join(testRoot, "definitely-missing.jsonl"));
  assert.deepEqual(result, { observations: [], truncated: false });
});

test("route source-pin: envelope, no-store, readAdvisorEvidence, read-only surface", async () => {
  const { readFile } = await import("node:fs/promises");
  const route = await readFile(new URL("../app/api/sessions/[id]/advisor/route.ts", import.meta.url), "utf8");
  assert.match(route, /success: true/);
  assert.match(route, /"Cache-Control": "no-store"/);
  assert.match(route, /resolveSessionPathOr404/);
  assert.match(route, /readAdvisorEvidence/);
  assert.match(route, /runtime = "nodejs"/);
  assert.doesNotMatch(route, /export async function (POST|PUT|DELETE|PATCH)/, "read-only surface");
  assert.match(route, /readAdvisorEvidence\(filePath\)/);
});

test("cleanup", () => {
  rmSync(testRoot, { recursive: true, force: true });
});
