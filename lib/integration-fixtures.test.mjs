import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

// Throwaway agent dir BEFORE the modules load (these stores resolve paths at
// import time through lib/omp/paths).
const testRoot = mkdtempSync(join(tmpdir(), "omp-web-integration-"));
process.env.PI_CODING_AGENT_DIR = join(testRoot, "agent");

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });

// ============================================================================
// P22.1 — cross-phase integration fixture gate.
//
// One sanitized fixture (tests/fixtures/integration/wave3-cross-phase.json)
// tells ONE coherent story that touches every wave-3 durable domain, and this
// file proves two things about it:
//   1. the identifiers LINK across domains (the delegation target is the same
//      session the handoff, goal, restore ledger, activity ring, notify row,
//      tombstone, result record, and task batch all belong to);
//   2. each section is accepted by the REAL store migrator it claims to
//      represent — the fixture matches live store contracts, not just itself.
// ============================================================================

const fixturePath = new URL("../tests/fixtures/integration/wave3-cross-phase.json", import.meta.url);
const fixtureRaw = readFileSync(fixturePath, "utf8");
const fx = JSON.parse(fixtureRaw);

const { migrateDelegationLedger } = await jiti.import("./delegation-ledger.ts");
const { migrateHandoffs } = await jiti.import("./handoffs.ts");
const { migrateGoals } = await jiti.import("./goals.ts");
const { migrateCheckpointLedger } = await jiti.import("./checkpoints/ledger.ts");
const { migrateSessionActivity } = await jiti.import("./session-activity.ts");
const { migrateClientState, tombstoneIdFor } = await jiti.import("./client-state-store.ts");
const { migrateTaskBatches } = await jiti.import("./task-batch.ts");
const { normalizeResultRecord } = await jiti.import("./result-records.ts");
const { dedupKeyFor, NOTIFY_KINDS } = await jiti.import("./notify/notify-shared.ts");
const { migrateNotifyFeed } = await jiti.import("./notify/feed.ts");
const { resolveSessionOrigin } = await jiti.import("./origin.ts");

const RESULT_STATUSES = ["complete", "partial", "failed", "canceled", "unknown"];

test("fixture shape: versioned, tiny, placeholder-only story naming every player", () => {
  assert.equal(fx.version, 1);
  assert.equal(statSync(fixturePath).size <= 8 * 1024, true, "fixture must stay under 8 KB");
  for (const needle of ["sess-alpha", "sess-beta", "model m1", "delegated"]) {
    assert.ok(fx.story.includes(needle), `story must mention ${needle}`);
  }
  // No secret-shaped strings anywhere in the fixture.
  assert.doesNotMatch(fixtureRaw, /sk-[A-Za-z0-9]{8}|bearer\s+[A-Za-z0-9]|password\s*[:=]|api[_-]?key\s*[:=]/i);
});

test("cross-domain linkage: every domain points at the same delegated session", () => {
  const { delegation, handoff, goal, restoreLedger, activity, notifyRow, taskBatch, origin } = fx;
  assert.equal(delegation.toSession, handoff.toSession);
  assert.equal(handoff.toSession, goal.sessionId);
  assert.equal(goal.sessionId, restoreLedger.sessionId);
  assert.equal(restoreLedger.sessionId, activity.sessionId);
  assert.equal(activity.sessionId, notifyRow.sessionId);
  assert.equal(notifyRow.sessionId, taskBatch.sessionId);
  assert.equal(taskBatch.sessionId, origin.sessionId);
  // And the source side: the handoff mirrors the delegation, and the origin
  // label names the same source session.
  assert.equal(handoff.fromSession, delegation.fromSession);
  assert.equal(delegation.fromSession, origin.label);
  assert.notEqual(delegation.fromSession, delegation.toSession);
});

test("story coherence: completed handoff matches a successful restore; batch results match specs", () => {
  const { handoff, restoreLedger, taskBatch, resultRecord, tombstone } = fx;
  assert.equal(handoff.state, "completed");
  assert.equal(restoreLedger.outcome, "success");
  assert.equal(restoreLedger.mode, "in-place");
  assert.equal(typeof restoreLedger.device, "string");
  assert.ok(restoreLedger.device.length > 0);
  // Delivery mode is consistent between the two records of the same delivery.
  assert.equal(handoff.mode, fx.delegation.mode);
  // Task batch: one result id per spec, and the roster ResultRecord is one of them.
  assert.equal(taskBatch.resultIds.length, taskBatch.specs.length);
  assert.ok(taskBatch.resultIds.includes(resultRecord.id), "ResultRecord belongs to the batch roster");
  // Tombstone: non-empty opaque item id.
  assert.ok(typeof tombstone.itemId === "string" && tombstone.itemId.length > 0);
});

test("timestamps: all parseable, ordered within one coherent 10-minute window", () => {
  const msValues = [
    fx.delegation.tsMs,
    fx.handoff.tsMs,
    fx.handoff.settledMs,
    fx.goal.ts,
    ...fx.activity.events.map((event) => event.ts),
    fx.tombstone.deletedAt,
    fx.taskBatch.tsMs,
  ];
  const isoValues = [fx.restoreLedger.ts, fx.notifyRow.ts];
  for (const ms of msValues) {
    assert.equal(Number.isFinite(ms) && ms > 0, true, `epoch ts ${ms} must be a positive finite number`);
  }
  const times = [
    ...msValues,
    ...isoValues.map((iso) => {
      const parsed = Date.parse(iso);
      assert.equal(Number.isNaN(parsed), false, `ISO ts ${iso} must parse`);
      return parsed;
    }),
  ];
  const windowStart = Date.parse("2026-09-23T00:00:00.000Z");
  const windowEnd = Date.parse("2026-10-01T00:00:00.000Z");
  for (const time of times) {
    assert.ok(time > windowStart && time < windowEnd, `ts ${new Date(time).toISOString()} outside the story window`);
  }
  const spread = Math.max(...times) - Math.min(...times);
  assert.ok(spread <= 10 * 60 * 1000, `story spans ${spread} ms — expected one coherent <=10 min window`);
  // The handoff settles AFTER it was delivered (the delegated run finished later).
  assert.ok(fx.handoff.settledMs > fx.handoff.tsMs);
});

test("real migrators accept every fixture section (store contracts, not just self-consistency)", () => {
  // Delegation ledger.
  const ledger = migrateDelegationLedger(JSON.stringify({ version: 1, delegations: [fx.delegation] }));
  assert.ok(ledger);
  assert.equal(ledger.delegations.length, 1);
  assert.equal(ledger.delegations[0].toSession, fx.delegation.toSession);

  // Handoff manifest.
  const handoffs = migrateHandoffs(JSON.stringify({ version: 1, handoffs: [fx.handoff] }));
  assert.ok(handoffs);
  assert.equal(handoffs.handoffs[0].state, "completed");

  // Durable goal (keyed by session, steps sanitized).
  const goals = migrateGoals(JSON.stringify({
    version: 1,
    goals: { [fx.goal.sessionId]: { title: fx.goal.title, steps: fx.goal.steps, ts: fx.goal.ts, device: fx.goal.device } },
  }));
  assert.ok(goals);
  const storedGoal = goals.goals[fx.goal.sessionId];
  assert.ok(storedGoal);
  assert.equal(storedGoal.steps.length, 3);
  assert.equal(storedGoal.steps.filter((step) => step.done).length, 2);

  // Checkpoint-restore ledger.
  const checkpointLedger = migrateCheckpointLedger(JSON.stringify({ version: 1, entries: [fx.restoreLedger] }));
  assert.ok(checkpointLedger);
  assert.equal(checkpointLedger.entries[0].outcome, "success");
  assert.equal(checkpointLedger.entries[0].device, "device-a");

  // Session-activity ring: migrate re-sorts newest-first (store order).
  const activity = migrateSessionActivity(JSON.stringify({
    version: 1,
    sessions: { [fx.activity.sessionId]: { events: fx.activity.events } },
  }));
  assert.ok(activity);
  const ring = activity.sessions[fx.activity.sessionId].events;
  assert.equal(ring.length, 2);
  assert.equal(ring[0].kind, "run_finished", "store keeps the ring newest-first");
  assert.equal(ring[1].kind, "run_started");

  // Client-state tombstone (serverKey::itemId map id).
  const tombstoneId = tombstoneIdFor(fx.tombstone.serverKey, fx.tombstone.itemId);
  const clientState = migrateClientState(JSON.stringify({
    version: 2,
    rev: fx.tombstone.rev,
    keys: {},
    tombstones: { [tombstoneId]: {
      rev: fx.tombstone.rev,
      itemId: fx.tombstone.itemId,
      deletedAt: fx.tombstone.deletedAt,
      deviceId: fx.tombstone.deviceId,
    } },
  }));
  assert.ok(clientState);
  assert.equal(clientState.tombstones[tombstoneId].itemId, fx.tombstone.itemId);

  // Notify feed row (kind "checkpoint" is part of the NotifyKind ladder).
  const feed = migrateNotifyFeed({ version: 1, rows: [fx.notifyRow] });
  assert.ok(feed);
  assert.equal(feed.rows.length, 1);
  assert.ok((NOTIFY_KINDS).includes(feed.rows[0].kind));
  assert.equal(feed.rows[0].id, dedupKeyFor(feed.rows[0].kind, feed.rows[0].sessionId, "1790157990000"));

  // Task-batch store.
  const batches = migrateTaskBatches(JSON.stringify({ version: 1, batches: [fx.taskBatch] }));
  assert.ok(batches);
  assert.equal(batches.batches[0].specs.length, fx.taskBatch.specs.length);
});

test("result record normalizes through the real ladder; origin resolver reproduces the fixture label", () => {
  const normalized = normalizeResultRecord(fx.resultRecord);
  assert.ok(normalized, "ResultRecord input must normalize");
  assert.ok(RESULT_STATUSES.includes(normalized.status), `status ${normalized.status} must be a ladder value`);
  assert.equal(normalized.status, "complete");
  assert.equal(normalized.origin, "delegated");
  assert.equal(normalized.model, "m1", "story model m1 rides the record");

  // Origin attribution: the delegation entry is exactly what
  // collectSessionOrigins() feeds into resolveSessionOrigin().
  const delegated = new Map([[fx.delegation.toSession, fx.delegation.fromSession]]);
  // resolveSessionOrigin returns the label WITHOUT the sessionId (it is the
  // lookup key) — compare the resolver-shaped projection of fixture.origin.
  assert.deepEqual(resolveSessionOrigin(fx.origin.sessionId, new Map(), delegated), {
    kind: fx.origin.kind,
    label: fx.origin.label,
  });
  // The source session itself is direct work.
  assert.deepEqual(resolveSessionOrigin(fx.delegation.fromSession, new Map(), delegated), { kind: "direct" });
});

test("cleanup", () => {
  rmSync(testRoot, { recursive: true, force: true });
});
