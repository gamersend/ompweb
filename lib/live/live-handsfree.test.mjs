import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  alias: { "@/": new URL("../../", import.meta.url).pathname },
});
const {
  LIVE_HANDSFREE_STORAGE_KEY,
  initialListeningState,
  micEnabledFor,
  readHandsFreeEnabled,
  reduceListening,
} = await jiti.import("./handsfree.ts");

// ─── the machine ─────────────────────────────────────────────────────────────

test("a fresh call listens: nothing muted, nothing paused", () => {
  const state = initialListeningState();
  assert.deepEqual(state, { muted: false, micPaused: false });
  assert.equal(micEnabledFor(state), true);
});

test("hands-free pause holds the mic only while a run is in flight", () => {
  const paused = reduceListening(initialListeningState(), { kind: "pause", handsFree: true });
  assert.equal(paused.state.micPaused, true);
  assert.equal(paused.micEnabled, false);
  assert.equal(paused.resumed, false, "a pause never reports a resume");
});

test("hands-free OFF never pauses — behavior is exactly as before the setting", () => {
  const refused = reduceListening(initialListeningState(), { kind: "pause", handsFree: false });
  assert.equal(refused.state.micPaused, false, "the pause is refused outright");
  assert.equal(refused.micEnabled, true);
  // The panel only asks when hands-free is on, but the machine enforces it.
});

test("auto-resume after the spoken result reopens the mic and flags the divider", () => {
  let state = initialListeningState();
  state = reduceListening(state, { kind: "pause", handsFree: true }).state;
  const resumed = reduceListening(state, { kind: "auto_resume" });
  assert.equal(resumed.state.micPaused, false);
  assert.equal(resumed.micEnabled, true);
  assert.equal(resumed.resumed, true, "the panel shows the divider exactly here");
});

test("mute ALWAYS wins: a muted call never auto-resumes", () => {
  let state = initialListeningState();
  state = reduceListening(state, { kind: "pause", handsFree: true }).state;
  state = reduceListening(state, { kind: "mute", muted: true }).state;
  assert.equal(micEnabledFor(state), false);

  const refused = reduceListening(state, { kind: "auto_resume" });
  assert.equal(refused.state.micPaused, true, "the hold survives a mute (it resumes on unmute)");
  assert.equal(refused.micEnabled, false);
  assert.equal(refused.resumed, false, "no divider for a muted call");
});

test("unmuting mid-run is the user taking the call back: the hold clears too", () => {
  let state = initialListeningState();
  state = reduceListening(state, { kind: "pause", handsFree: true }).state;
  state = reduceListening(state, { kind: "mute", muted: true }).state;
  const unmuted = reduceListening(state, { kind: "mute", muted: false });
  assert.deepEqual(unmuted.state, { muted: false, micPaused: false });
  assert.equal(unmuted.micEnabled, true);
  // Unmute is explicit — never flagged as an auto-resume.
  assert.equal(unmuted.resumed, false);
});

test("auto-resume with nothing paused is a no-op (no divider)", () => {
  const idle = reduceListening(initialListeningState(), { kind: "auto_resume" });
  assert.equal(idle.resumed, false);
  assert.equal(idle.micEnabled, true);
  assert.deepEqual(idle.state, initialListeningState());
});

test("a double pause is idempotent; reset starts a fresh call listening", () => {
  let state = initialListeningState();
  state = reduceListening(state, { kind: "pause", handsFree: true }).state;
  const again = reduceListening(state, { kind: "pause", handsFree: true });
  assert.equal(again.state, state, "no new state object for an idempotent pause");

  const reset = reduceListening({ muted: true, micPaused: true }, { kind: "reset" });
  assert.deepEqual(reset.state, initialListeningState());
  assert.equal(reset.micEnabled, true);
});

// ─── the persisted preference ────────────────────────────────────────────────

test("the hands-free preference defaults ON; the storage key is pinned", () => {
  assert.equal(LIVE_HANDSFREE_STORAGE_KEY, "omp-web-live-handsfree");
  // window-less environment (node): the default holds.
  assert.equal(readHandsFreeEnabled(), true);
});
