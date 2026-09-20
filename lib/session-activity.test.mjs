import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

// Throwaway agent dir BEFORE the module loads.
const testRoot = mkdtempSync(join(tmpdir(), "omp-web-activity-"));
process.env.PI_CODING_AGENT_DIR = join(testRoot, "agent");

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const {
  SESSION_ACTIVITY_MAX_PER_SESSION,
  SESSION_ACTIVITY_MAX_SESSIONS,
  flushSessionActivity,
  getSessionActivityPath,
  migrateSessionActivity,
  readSessionActivity,
  recordSessionActivity,
  resetSessionActivityForTests,
  sanitizeActivityText,
} = await jiti.import("./session-activity.ts");

// ============================================================================
// Session activity ring (wave 3 P7 / R3-06): bounded per-session lifecycle
// events, redacted text, LRU session pruning, restart-durable, and a
// best-effort contract — the recorder can never throw into frame forwarding.
// ============================================================================

test("sanitize: redacts secrets and truncates, never returns raw text", () => {
  const safe = sanitizeActivityText("switched to gpt-5");
  assert.equal(safe, "switched to gpt-5");
  const secret = sanitizeActivityText("token sk-abcdefghijklmnopqrst failed");
  assert.ok(!secret?.includes("sk-abcdefghijklmnopqrst"), "credential-shaped text redacted");
  assert.equal(sanitizeActivityText(""), undefined);
  assert.equal(sanitizeActivityText(null), undefined);
  const long = sanitizeActivityText("x".repeat(400));
  assert.ok(long.length <= 160, "hard cap");
});

test("record: bounded per-session ring, newest first", () => {
  resetSessionActivityForTests();
  rmSync(getSessionActivityPath(), { force: true });
  for (let i = 0; i < SESSION_ACTIVITY_MAX_PER_SESSION + 5; i++) {
    recordSessionActivity("s1", "run_started");
  }
  recordSessionActivity("s1", "notice", `run failed with ${"y".repeat(300)}`);
  const events = readSessionActivity("s1");
  assert.equal(events.length, SESSION_ACTIVITY_MAX_PER_SESSION, "bounded");
  assert.equal(events[0].kind, "notice", "newest first");
  assert.ok((events[0].text?.length ?? 0) <= 160);
});

test("durable across a simulated restart", () => {
  resetSessionActivityForTests();
  rmSync(getSessionActivityPath(), { force: true });
  recordSessionActivity("s2", "run_finished");
  flushSessionActivity();
  assert.ok(existsSync(getSessionActivityPath()));
  resetSessionActivityForTests(); // drop the cache — like a restart
  assert.equal(readSessionActivity("s2")[0]?.kind, "run_finished");
});

test("LRU: only the 60 most-recently-active sessions survive", () => {
  resetSessionActivityForTests();
  rmSync(getSessionActivityPath(), { force: true });
  for (let i = 0; i < SESSION_ACTIVITY_MAX_SESSIONS + 3; i++) {
    recordSessionActivity(`sess-${i}`, "run_started", undefined, 1_000_000 + i);
  }
  flushSessionActivity();
  resetSessionActivityForTests();
  assert.equal(readSessionActivity("sess-0").length, 0, "oldest session evicted");
  assert.equal(readSessionActivity(`sess-${SESSION_ACTIVITY_MAX_SESSIONS + 2}`).length, 1, "newest kept");
});

test("migrate: rejects broken stores, skips junk, re-applies bounds", () => {
  assert.equal(migrateSessionActivity("{nope"), null);
  assert.equal(migrateSessionActivity(JSON.stringify({ version: 4, sessions: {} })), null);
  assert.equal(migrateSessionActivity("{}"), null);
  const parsed = migrateSessionActivity(JSON.stringify({
    version: 1,
    sessions: {
      ok: { events: [{ ts: 5, kind: "notice", text: "hi" }, "junk", { ts: 9, kind: "run_started" }] },
      empty: { events: [] },
      broken: null,
    },
  }));
  assert.ok(parsed);
  assert.deepEqual(parsed.sessions.ok.events.map((event) => event.ts), [9, 5], "newest-first normalized");
  assert.ok(!parsed.sessions.empty && !parsed.sessions.broken);
});

test("contract: recorder never throws on garbage input", () => {
  assert.doesNotThrow(() => recordSessionActivity("", "run_started"));
  assert.doesNotThrow(() => recordSessionActivity("s", "made-up-kind", "x"));
  assert.doesNotThrow(() => recordSessionActivity("s", "notice", { not: "a string" }));
});

test("wiring: rpc-manager taps emit(), insights route attaches the ring", async () => {
  const { readFile } = await import("node:fs/promises");
  const manager = await readFile(new URL("./rpc-manager.ts", import.meta.url), "utf8");
  assert.match(manager, /recordSessionActivityTap\(this\._sessionId, event\)/);
  assert.match(manager, /type === "config_update"/);
  const route = await readFile(new URL("../app/api/sessions/[id]/insights/route.ts", import.meta.url), "utf8");
  assert.match(route, /readSessionActivity/);
});

test("cleanup", () => {
  resetSessionActivityForTests();
  rmSync(testRoot, { recursive: true, force: true });
});
