import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const {
  FEED_CAP,
  allNotifyRows,
  flushNotifyFeed,
  getNotifyFeedPath,
  markDelivered,
  migrateNotifyFeed,
  parseNotifyFeed,
  pushNotifyRow,
  resetNotifyFeedForTests,
  since,
  webhookFailureRowId,
} = await jiti.import("./feed.ts");
const { dedupKeyFor, WEBHOOK_FAILURE_ID_PREFIX } = await jiti.import("./notify-shared.ts");

/** Point the omp agent dir at a throwaway location for the duration of `fn`
 * (the feed resolves its file via getAgentDir()). */
function withAgentDir(t) {
  const agentDir = mkdtempSync(join(tmpdir(), "omp-web-notify-feed-test-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  t.after(() => {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    rmSync(agentDir, { recursive: true, force: true });
  });
  return agentDir;
}

const row = (over = {}) => ({
  id: dedupKeyFor("agent_end", "s1", 1),
  ts: "2026-09-19T00:00:00.000Z",
  kind: "agent_end",
  sessionId: "s1",
  sessionTitle: "Session one",
  projectRoot: "/repo",
  title: "Session one — run completed",
  body: "done",
  ...over,
});

test("migrateNotifyFeed accepts v1 and pre-versioning shapes, rejects broken input", () => {
  const v1 = migrateNotifyFeed({ version: 1, rows: [row()] });
  assert.equal(v1.version, 1);
  assert.equal(v1.rows.length, 1);
  // Missing `version` = the pre-versioning store; rows survive.
  const legacy = migrateNotifyFeed({ rows: [row({ delivered: undefined })] });
  assert.equal(legacy.version, 1);
  assert.equal(legacy.rows[0].delivered, false);
  assert.equal(migrateNotifyFeed({ nope: true }), null);
  assert.equal(migrateNotifyFeed({ rows: "nope" }), null);
  assert.equal(migrateNotifyFeed({ rows: [{ id: "x" }] }), null, "rows missing required fields are rejected");
  assert.equal(migrateNotifyFeed({ version: 2, rows: [] }), null, "future versions are not migratable");
  assert.equal(parseNotifyFeed("{not json"), null);
});

test("pushNotifyRow dedups by key kind:sessionId:runId/frameId and rings at the cap", (t) => {
  withAgentDir(t);
  resetNotifyFeedForTests();

  const first = pushNotifyRow(row());
  assert.ok(first);
  assert.equal(pushNotifyRow(row()), null, "identical dedup key is dropped (N SSE subscribers, one row)");
  const second = pushNotifyRow(row({ id: dedupKeyFor("agent_end", "s1", 2) }));
  assert.equal(second.id, dedupKeyFor("agent_end", "s1", 2), "distinct run token = distinct row");
  // Different frame token = a distinct event.
  assert.ok(pushNotifyRow(row({ id: dedupKeyFor("approval", "s1", "frame-1") })));

  const rows = allNotifyRows();
  assert.equal(rows.length, 3);
  assert.equal(rows[0].id, dedupKeyFor("approval", "s1", "frame-1"), "newest first");

  // Ring buffer: pushing past the cap drops the oldest tail and frees its id.
  for (let i = 0; i < FEED_CAP; i += 1) {
    pushNotifyRow(row({ id: `agent_end:bulk:${i}`, sessionId: `bulk-${i}` }));
  }
  const capped = allNotifyRows();
  assert.equal(capped.length, FEED_CAP);
  assert.equal(capped.some((r) => r.id === dedupKeyFor("agent_end", "s1", 1)), false, "oldest rows pruned");
  assert.ok(capped.every((r) => r.id !== `agent_end:bulk:${FEED_CAP - 3}`) === false, "recent rows kept");
  resetNotifyFeedForTests();
});

test("since(id) returns rows newer than the cursor; unknown cursor returns everything", (t) => {
  withAgentDir(t);
  resetNotifyFeedForTests();
  pushNotifyRow(row({ id: "e1" }));
  pushNotifyRow(row({ id: "e2" }));
  pushNotifyRow(row({ id: "e3" }));
  assert.deepEqual(since("e2").map((r) => r.id), ["e3"]);
  assert.deepEqual(since(null).map((r) => r.id), ["e3", "e2", "e1"]);
  assert.deepEqual(since("gone").map((r) => r.id), ["e3", "e2", "e1"], "pruned cursor → full history");
  assert.deepEqual(since("e3"), []);
  resetNotifyFeedForTests();
});

test("the feed persists atomically and survives a reload; corrupt files quarantine", (t) => {
  const agentDir = withAgentDir(t);
  resetNotifyFeedForTests();

  pushNotifyRow(row({ id: "p1" }));
  pushNotifyRow(row({ id: "p2" }));
  markDelivered(["p1"]);
  flushNotifyFeed();

  const file = getNotifyFeedPath();
  assert.ok(existsSync(file));
  const onDisk = JSON.parse(readFileSync(file, "utf8"));
  assert.equal(onDisk.version, 1);
  assert.equal(onDisk.rows.find((r) => r.id === "p1").delivered, true);
  assert.equal(onDisk.rows.find((r) => r.id === "p2").delivered, false);

  // A fresh process view (state reset) reads the persisted tail back.
  resetNotifyFeedForTests();
  assert.deepEqual(allNotifyRows().map((r) => r.id), ["p2", "p1"]);
  assert.equal(allNotifyRows().find((r) => r.id === "p1").delivered, true);

  // Corrupt store → quarantined to *.bak-<ts>, feed rebuilds empty.
  resetNotifyFeedForTests();
  writeFileSync(file, "{oops", "utf8");
  pushNotifyRow(row({ id: "after-corrupt" }));
  flushNotifyFeed();
  const backups = readdirSync(agentDir).filter((name) => name.startsWith("web-notify.json.bak-"));
  assert.equal(backups.length, 1, "corrupt file quarantined, never silently dropped");
  assert.deepEqual(allNotifyRows().map((r) => r.id), ["after-corrupt"]);
  resetNotifyFeedForTests();
});

test("markDelivered flips only matching undelivered rows and persists", (t) => {
  withAgentDir(t);
  resetNotifyFeedForTests();
  pushNotifyRow(row({ id: "d1" }));
  pushNotifyRow(row({ id: "d2" }));
  assert.equal(markDelivered(["d1", "missing"]), 1);
  assert.equal(markDelivered(["d1"]), 0, "already delivered");
  flushNotifyFeed();
  resetNotifyFeedForTests();
  const rows = allNotifyRows();
  assert.equal(rows.find((r) => r.id === "d1").delivered, true);
  assert.equal(rows.find((r) => r.id === "d2").delivered, false);
  resetNotifyFeedForTests();
});

test("webhook failure row ids carry the wherr- prefix so dispatch skips them", () => {
  assert.equal(webhookFailureRowId("agent_end:s1:1"), `${WEBHOOK_FAILURE_ID_PREFIX}agent_end:s1:1`);
});
