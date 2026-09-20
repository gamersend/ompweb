import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  alias: { "@/": new URL("../../", import.meta.url).pathname },
});
const { reconnectDelayMs, LIVE_RECONNECT_ATTEMPTS, LIVE_RECONNECT_BACKOFF_MS } = await jiti.import("./reconnect.ts");
const { reduceLiveEvent, initialLiveState } = await jiti.import("./call-state.ts");

test("the backoff ladder is 1s → 2s → 4s, then exhausted", () => {
  assert.equal(LIVE_RECONNECT_ATTEMPTS, 3);
  assert.deepEqual([...LIVE_RECONNECT_BACKOFF_MS], [1_000, 2_000, 4_000]);
  assert.equal(reconnectDelayMs(0), 1_000);
  assert.equal(reconnectDelayMs(1), 2_000);
  assert.equal(reconnectDelayMs(2), 4_000);
  assert.equal(reconnectDelayMs(3), null, "attempt 3 is exhausted");
  assert.equal(reconnectDelayMs(4), null);
  assert.equal(reconnectDelayMs(-1), null);
});

test("live → reconnecting → live keeps the call id and clears the detail", () => {
  let state = initialLiveState();
  state = reduceLiveEvent(state, { kind: "start" });
  state = reduceLiveEvent(state, { kind: "signaling_ok", callId: "rtc_1" });
  state = reduceLiveEvent(state, { kind: "peer_connected" });
  assert.equal(state.phase, "live");
  assert.equal(state.callId, "rtc_1");
  // Unexpected drop → reconnecting (not failed).
  state = reduceLiveEvent(state, { kind: "reconnect_start" });
  assert.equal(state.phase, "reconnecting");
  assert.equal(state.callId, "rtc_1");
  // The renegotiated peer connects → live again.
  state = reduceLiveEvent(state, { kind: "peer_connected" });
  assert.equal(state.phase, "live");
  assert.equal(state.detail, null);
});

test("reconnect_start from any phase other than live is a no-op", () => {
  assert.equal(reduceLiveEvent(initialLiveState(), { kind: "reconnect_start" }).phase, "idle");
  const connecting = reduceLiveEvent(initialLiveState(), { kind: "start" });
  assert.equal(reduceLiveEvent(connecting, { kind: "reconnect_start" }).phase, "connecting", "a failed handshake takes the plain failure path, not reconnecting");
});

test("exhausted reconnects land in the existing failed state with the detail", () => {
  let state = initialLiveState();
  state = reduceLiveEvent(state, { kind: "start" });
  state = reduceLiveEvent(state, { kind: "peer_connected" });
  state = reduceLiveEvent(state, { kind: "reconnect_start" });
  state = reduceLiveEvent(state, { kind: "reconnect_exhausted", detail: "peer failed" });
  assert.equal(state.phase, "failed");
  assert.equal(state.detail, "peer failed");
});

test("a user stop from reconnecting ends the call (never reconnects, never fails)", () => {
  let state = initialLiveState();
  state = reduceLiveEvent(state, { kind: "start" });
  state = reduceLiveEvent(state, { kind: "peer_connected" });
  state = reduceLiveEvent(state, { kind: "reconnect_start" });
  state = reduceLiveEvent(state, { kind: "stop" });
  assert.equal(state.phase, "ended");
  assert.equal(state.detail, null);
});

test("reconnecting still accepts a fresh signaling_ok and refuses a second start", () => {
  let state = initialLiveState();
  state = reduceLiveEvent(state, { kind: "start" });
  state = reduceLiveEvent(state, { kind: "signaling_ok", callId: "rtc_1" });
  state = reduceLiveEvent(state, { kind: "peer_connected" });
  state = reduceLiveEvent(state, { kind: "reconnect_start" });
  state = reduceLiveEvent(state, { kind: "signaling_ok", callId: "rtc_2" });
  assert.equal(state.callId, "rtc_2", "the renegotiated call id threads through");
  assert.equal(reduceLiveEvent(state, { kind: "start" }), state, "a start during reconnecting is a no-op");
});

test("peer_connected from reconnecting flips to live; errors still fail the call", () => {
  let state = initialLiveState();
  state = reduceLiveEvent(state, { kind: "start" });
  state = reduceLiveEvent(state, { kind: "peer_connected" });
  state = reduceLiveEvent(state, { kind: "reconnect_start" });
  state = reduceLiveEvent(state, { kind: "error", detail: "signaling failed (502)" });
  assert.equal(state.phase, "failed");
  assert.equal(state.detail, "signaling failed (502)");
});
