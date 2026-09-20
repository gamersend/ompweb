import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  alias: { "@/": new URL("../../", import.meta.url).pathname },
});
const {
  decideDelegationRouting,
  delegationCountInStates,
  oldestDelegationInState,
  newestDelegationInState,
  upsertDelegation,
  patchDelegation,
  LIVE_MAX_QUEUED_DELEGATIONS,
  LIVE_IN_FLIGHT_STATES,
} = await jiti.import("./delegation.ts");

const item = (id, state) => ({ id, requestText: `req ${id}`, state });

test("an idle surface dispatches immediately; a busy one queues (cap 3)", () => {
  assert.equal(LIVE_MAX_QUEUED_DELEGATIONS, 3);
  assert.deepEqual(LIVE_IN_FLIGHT_STATES, ["delegating", "running"]);
  // Nothing in flight → straight to dispatch.
  assert.equal(decideDelegationRouting([]), "dispatch");
  assert.equal(
    decideDelegationRouting([item("a", "done"), item("b", "failed"), item("c", "pending")]),
    "dispatch",
    "terminal and manual-pending items do not block a dispatch",
  );
  // One run in flight → queue.
  assert.equal(decideDelegationRouting([item("a", "running")]), "queue");
  assert.equal(decideDelegationRouting([item("a", "delegating")]), "queue");
});

test("the queue fills to the cap, then rejects", () => {
  let list = [item("run", "running")];
  assert.equal(decideDelegationRouting(list), "queue");
  list = [...list, item("q1", "queued")];
  assert.equal(decideDelegationRouting(list), "queue");
  list = [...list, item("q2", "queued")];
  assert.equal(decideDelegationRouting(list), "queue");
  list = [...list, item("q3", "queued")];
  assert.equal(decideDelegationRouting(list), "reject", "3 queued is the cap");
  assert.equal(delegationCountInStates(list, ["queued"]), LIVE_MAX_QUEUED_DELEGATIONS);
});

test("drain is FIFO: the oldest queued item leaves first", () => {
  const list = [
    item("old", "done"),
    item("q1", "queued"),
    item("q2", "queued"),
    item("run", "running"),
    item("q3", "queued"),
  ];
  const next = oldestDelegationInState(list, "queued");
  assert.equal(next.id, "q1", "the queue drains first-in-first-out");
  // After q1 dispatches (delegating), the next drain target is q2.
  const after = patchDelegation(list, "q1", { state: "delegating" });
  assert.equal(oldestDelegationInState(after, "queued").id, "q2");
  // The result mapping still targets the newest running item.
  assert.equal(newestDelegationInState(after, "running").id, "run");
});

test("the lifecycle walks queued → delegating → running → done, then frees the slot", () => {
  let list = [];
  // First request on an idle surface → straight to dispatch.
  assert.equal(decideDelegationRouting(list), "dispatch");
  list = upsertDelegation(list, item("a", "running"));
  // Second arrival while a is running → queued.
  assert.equal(decideDelegationRouting(list), "queue");
  list = upsertDelegation(list, item("b", "queued"));
  assert.equal(oldestDelegationInState(list, "queued").id, "b");
  // a's agent_end: a → done, b dispatches (delegating) and counts in flight.
  list = patchDelegation(list, "a", { state: "done" });
  list = patchDelegation(list, "b", { state: "delegating" });
  assert.equal(decideDelegationRouting(list), "queue", "the dispatched item itself occupies the slot");
  list = patchDelegation(list, "b", { state: "running" });
  assert.equal(newestDelegationInState(list, "running").id, "b");
  // b finishes with nothing queued → idle again.
  list = patchDelegation(list, "b", { state: "done" });
  assert.equal(decideDelegationRouting(list), "dispatch");
});
