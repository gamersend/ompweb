import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { shouldPushRow } = await jiti.import("./gate.ts");
const { NOTIFY_KINDS } = await jiti.import("../notify/notify-shared.ts");

const enabledConfig = (events = [...NOTIFY_KINDS], quietHours = undefined) => ({
  push: { enabled: true, events },
  ...(quietHours ? { quietHours } : {}),
});

const row = (id = "agent_end:s1:run1", kind = "agent_end") => ({ id, kind });

test("disabled config → no push, before any other rule", () => {
  assert.deepEqual(shouldPushRow({ config: { push: { enabled: false, events: [...NOTIFY_KINDS] } }, row: row(), pushedIds: new Set() }), { push: false, reason: "disabled" });
  assert.deepEqual(shouldPushRow({ config: {}, row: row(), pushedIds: new Set() }), { push: false, reason: "disabled" });
});

test("kind allowlist gates the push", () => {
  const config = enabledConfig(["agent_end", "approval"]);
  assert.deepEqual(shouldPushRow({ config, row: row("agent_end:s1:1", "agent_end"), pushedIds: new Set() }), { push: true, reason: "ok" });
  assert.deepEqual(shouldPushRow({ config, row: row("scheduler:s1:1", "scheduler"), pushedIds: new Set() }), { push: false, reason: "kind_not_allowed" });
});

test("webhook-failure rows (wherr-) never push — the loop guard", () => {
  const config = enabledConfig();
  assert.deepEqual(shouldPushRow({ config, row: row("wherr-agent_end:s1:1", "error"), pushedIds: new Set() }), { push: false, reason: "failure_row" });
});

test("a row id pushes exactly once (bounded-set dedup)", () => {
  const config = enabledConfig();
  const pushedIds = new Set();
  assert.equal(shouldPushRow({ config, row: row(), pushedIds }).push, true);
  pushedIds.add(row().id);
  assert.deepEqual(shouldPushRow({ config, row: row(), pushedIds }), { push: false, reason: "duplicate" });
});

test("quiet hours suppress the push (feed still records — that is feed.ts's business)", () => {
  const config = enabledConfig([...NOTIFY_KINDS], { from: "22:00", to: "07:00" });
  const at23 = new Date(2026, 0, 1, 23, 0);
  const at6 = new Date(2026, 0, 1, 6, 59);
  const at8 = new Date(2026, 0, 1, 8, 0);
  assert.deepEqual(shouldPushRow({ config, row: row(), pushedIds: new Set(), now: at23 }), { push: false, reason: "quiet_hours" });
  assert.deepEqual(shouldPushRow({ config, row: row(), pushedIds: new Set(), now: at6 }), { push: false, reason: "quiet_hours" });
  assert.deepEqual(shouldPushRow({ config, row: row(), pushedIds: new Set(), now: at8 }), { push: true, reason: "ok" });
  // midnight-crossing edge: 07:00 sharp is outside [22:00, 07:00)
  const at7 = new Date(2026, 0, 1, 7, 0);
  assert.deepEqual(shouldPushRow({ config, row: row(), pushedIds: new Set(), now: at7 }), { push: true, reason: "ok" });
});

test("rule order: disabled → failure_row → kind → duplicate → quiet → ok", () => {
  // A duplicate wherr- row inside quiet hours reports the FIRST failing rule.
  const config = enabledConfig(["agent_end"], { from: "22:00", to: "07:00" });
  const pushedIds = new Set(["wherr-x"]);
  assert.deepEqual(
    shouldPushRow({ config, row: { id: "wherr-x", kind: "agent_end" }, pushedIds, now: new Date(2026, 0, 1, 23, 0) }),
    { push: false, reason: "failure_row" },
  );
});
