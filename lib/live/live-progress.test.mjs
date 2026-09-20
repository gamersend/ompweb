import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  alias: { "@/": new URL("../../", import.meta.url).pathname },
});
const {
  initialProgressState,
  nextProgressUpdate,
  progressCommentary,
  LIVE_PROGRESS_MIN_INTERVAL_MS,
  LIVE_MAX_PROGRESS_UPDATES,
} = await jiti.import("./progress.ts");

test("progressCommentary names the current tool", () => {
  assert.equal(progressCommentary("bash"), "still working — running bash");
  assert.equal(progressCommentary("  read_file  "), "still working — running read_file");
  assert.equal(progressCommentary(null), "still working");
  assert.equal(progressCommentary("   "), "still working");
});

test("a tool change fires immediately; a stable tool fires only after the interval", () => {
  let state = initialProgressState();
  // First observation ever: the tool is news, send it.
  const first = nextProgressUpdate(state, "bash", 1_000);
  assert.equal(first.text, "still working — running bash");
  assert.equal(first.state.sentCount, 1);
  state = first.state;
  // Same tool, 5s later: coalesced away.
  const stable = nextProgressUpdate(state, "bash", 1_000 + 5_000);
  assert.equal(stable.text, null);
  assert.equal(stable.state, state, "coalescing leaves the state untouched");
  // Same tool, ≥30s later: the interval fires.
  const interval = nextProgressUpdate(state, "bash", 1_000 + LIVE_PROGRESS_MIN_INTERVAL_MS);
  assert.equal(interval.text, "still working — running bash");
  state = interval.state;
  // A DIFFERENT tool right after: the change fires immediately ("whichever first").
  const changed = nextProgressUpdate(state, "read_file", interval.state.lastSentAt + 1_000);
  assert.equal(changed.text, "still working — running read_file");
});

test("a null (idle) tool never fires and preserves the state for the next start", () => {
  const state = { lastSentAt: 0, lastTool: null, sentCount: 0 };
  const idle = nextProgressUpdate(state, null, 5_000);
  assert.equal(idle.text, null);
  assert.equal(idle.state, state);
  // After a sent update, an idle spell does not reset the last tool: the next
  // tool start still counts as a change.
  let s = initialProgressState();
  s = nextProgressUpdate(s, "bash", 1_000).state;
  s = nextProgressUpdate(s, null, 2_000).state;
  const again = nextProgressUpdate(s, "bash", 3_000);
  assert.equal(again.text, null, "same tool after an idle spell is not news");
  const fresh = nextProgressUpdate(s, "edit_file", 3_001);
  assert.equal(fresh.text, "still working — running edit_file", "a new tool still is");
});

test("the per-delegation cap stops the commentary after the limit", () => {
  let state = initialProgressState();
  let now = 0;
  let sent = 0;
  for (let i = 0; i < LIVE_MAX_PROGRESS_UPDATES + 5; i++) {
    const tool = `tool-${i}`; // every observation is a change → always due
    const outcome = nextProgressUpdate(state, tool, now);
    state = outcome.state;
    if (outcome.text) sent += 1;
    now += LIVE_PROGRESS_MIN_INTERVAL_MS;
  }
  assert.equal(sent, LIVE_MAX_PROGRESS_UPDATES);
  assert.equal(state.sentCount, LIVE_MAX_PROGRESS_UPDATES);
  assert.equal(LIVE_MAX_PROGRESS_UPDATES, 10);
});

test("the interval floor is 30 seconds and the first send is immediate", () => {
  assert.equal(LIVE_PROGRESS_MIN_INTERVAL_MS, 30_000);
  const state = initialProgressState();
  const outcome = nextProgressUpdate(state, "bash", 123_456);
  assert.equal(outcome.text, "still working — running bash");
  assert.equal(outcome.state.lastSentAt, 123_456);
});

test("a sub-interval tool chain is capped, not monologuing (10 changes max)", () => {
  // Fast-cycling tools (change fires immediately per spec) still stop at the cap.
  let state = initialProgressState();
  let sent = 0;
  for (let i = 0; i < 50; i++) {
    const outcome = nextProgressUpdate(state, `t${i}`, i * 100);
    state = outcome.state;
    if (outcome.text) sent += 1;
  }
  assert.equal(sent, LIVE_MAX_PROGRESS_UPDATES);
});
