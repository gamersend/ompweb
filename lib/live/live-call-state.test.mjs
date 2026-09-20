import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  alias: { "@/": new URL("../../", import.meta.url).pathname },
});
const { initialLiveState, reduceLiveEvent } = await jiti.import("./call-state.ts");

test("the happy path walks idle → connecting → live → ended", () => {
  let state = initialLiveState();
  state = reduceLiveEvent(state, { kind: "start" });
  assert.equal(state.phase, "connecting");
  state = reduceLiveEvent(state, { kind: "signaling_ok", callId: "rtc_1" });
  assert.equal(state.callId, "rtc_1");
  assert.equal(state.phase, "connecting");
  state = reduceLiveEvent(state, { kind: "peer_connected" });
  assert.equal(state.phase, "live");
  state = reduceLiveEvent(state, { kind: "stop" });
  assert.equal(state.phase, "ended");
  assert.equal(state.detail, null);
});

test("a start while connecting or live is refused — one live session per tab", () => {
  let state = reduceLiveEvent(initialLiveState(), { kind: "start" });
  const refusedWhileConnecting = reduceLiveEvent(state, { kind: "start" });
  assert.equal(refusedWhileConnecting, state, "the state object is unchanged, not reset");
  state = reduceLiveEvent(state, { kind: "peer_connected" });
  const refusedWhileLive = reduceLiveEvent(state, { kind: "start" });
  assert.equal(refusedWhileLive, state);
});

test("peer loss from live or connecting lands in failed with a detail", () => {
  let state = reduceLiveEvent(initialLiveState(), { kind: "start" });
  state = reduceLiveEvent(state, { kind: "peer_lost", detail: "peer disconnected" });
  assert.equal(state.phase, "failed");
  assert.equal(state.detail, "peer disconnected");
  // From `failed` further peer events are no-ops.
  const again = reduceLiveEvent(state, { kind: "peer_lost", detail: "again" });
  assert.equal(again.phase, "failed");
});

test("errors carry a detail and never override a terminal ended phase", () => {
  let state = reduceLiveEvent(initialLiveState(), { kind: "error" });
  assert.equal(state.phase, "failed");
  assert.ok(state.detail && state.detail.length > 0, "a default detail is supplied");
  state = reduceLiveEvent(state, { kind: "stop" });
  assert.equal(state.phase, "ended");
  const afterEnd = reduceLiveEvent(state, { kind: "error", detail: "late" });
  assert.equal(afterEnd.phase, "ended");
});

test("start clears a previous failure and the old call id", () => {
  let state = reduceLiveEvent(initialLiveState(), { kind: "start" });
  state = reduceLiveEvent(state, { kind: "signaling_ok", callId: "rtc_old" });
  state = reduceLiveEvent(state, { kind: "error", detail: "boom" });
  state = reduceLiveEvent(state, { kind: "start" });
  assert.equal(state.phase, "connecting");
  assert.equal(state.detail, null);
  assert.equal(state.callId, "", "a retry must not inherit the previous call id");
});

test("stop is a no-op before a call and after one already ended", () => {
  const idle = initialLiveState();
  assert.equal(reduceLiveEvent(idle, { kind: "stop" }), idle);
  let state = reduceLiveEvent(idle, { kind: "start" });
  state = reduceLiveEvent(state, { kind: "stop" });
  assert.equal(reduceLiveEvent(state, { kind: "stop" }), state);
});
