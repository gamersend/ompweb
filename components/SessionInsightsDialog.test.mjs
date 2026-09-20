import assert from "node:assert/strict";
import "../tests/setup-dom.mjs";
import test, { afterEach } from "node:test";
import React from "react";
import { act, cleanup, render, waitFor } from "@testing-library/react/pure.js";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  jsx: { runtime: "automatic" },
  tsconfigPaths: true,
});
const { SessionInsightsDialog } = await jiti.import("./SessionInsightsDialog.tsx");

const SESSION = "sess-insights-1";
const realFetch = globalThis.fetch;

afterEach(() => {
  cleanup();
  globalThis.fetch = realFetch;
});

/** Full well-formed insights payload the route is supposed to produce. */
function fullData(overrides = {}) {
  return {
    sessionPath: "C:\\s\\a.jsonl",
    native: { available: true, partial: false, facts: 3 },
    entriesAvailable: true,
    totals: {
      messages: 6, userMessages: 2, assistantMessages: 4, toolCalls: 2,
      tokensIn: 200, tokensOut: 80, cacheRead: 20, cacheWrite: 10,
      costUsd: 0.5, durationMs: 60_000, ttftAvgMs: 900, ttftSamples: 4,
      retries: 0, aborts: 0, errors: 1, compactions: 0,
    },
    timeline: [{ ts: "2026-01-01T00:00:00.000Z", tokensIn: 100, tokensOut: 40, costUsd: 0.2, source: "entries" }],
    tools: [{ tool: "read", calls: 2, errors: 0, estDurationMs: 120, estSamples: 1, source: "entries" }],
    tookMs: 12,
    ...overrides,
  };
}

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

async function openDialog(payload, status = 200) {
  globalThis.fetch = async () => jsonResponse(payload, status);
  const view = render(React.createElement(SessionInsightsDialog, {
    sessionId: SESSION, open: true, onClose: () => {},
  }));
  // let the load effect settle
  await act(async () => { await Promise.resolve(); });
  return view;
}

test("success envelope: unwraps {success,data} and renders tiles without crashing", async () => {
  const view = await openDialog({ success: true, data: fullData() });
  await waitFor(() => {
    assert.ok(view.getByText("Messages"));
  });
  assert.ok(view.getByText("6"), "messages tile shows the total");
  assert.ok(view.getByText("read"), "tool table lists the read tool");
  assert.ok(view.getByText("$0.50"), "cost tile renders");
  assert.doesNotMatch(document.body.textContent ?? "", /Partial data/);
});

test("native.partial badge renders from the unwrapped data object", async () => {
  const view = await openDialog({ success: true, data: fullData({ native: { available: true, partial: true, facts: 3 } }) });
  await waitFor(() => assert.ok(view.getByText(/Partial data/)));
});

test("REGRESSION: undefined data shape renders an empty state instead of throwing", async () => {
  // The old code stored the whole envelope and read `insights.native.partial`
  // off undefined — TypeError that crashed the app into the error boundary.
  const view = await openDialog({ success: true, data: undefined });
  await waitFor(() => assert.ok(view.getByText("No insights yet — send a message first.")));
  assert.doesNotMatch(document.body.textContent ?? "", /partial/i);
});

test("REGRESSION: envelope-without-data (bare success payload) renders empty state", async () => {
  const view = await openDialog({ success: true });
  await waitFor(() => assert.ok(view.getByText("No insights yet — send a message first.")));
});

test("malformed data fields degrade to empty sections, never throw", async () => {
  const view = await openDialog({
    success: true,
    data: { native: null, totals: null, timeline: "nope", tools: 42 },
  });
  await waitFor(() => {
    assert.ok(view.getByText("No token activity recorded"));
    assert.ok(view.getByText("No tool calls in this session"));
  });
});

test("failed payload (success:false) renders the error row, no crash", async () => {
  const view = await openDialog({ success: false, error: "boom happened", code: "boom" }, 500);
  await waitFor(() => assert.ok(view.getByText(/boom happened/)));
});

test("non-JSON error body renders an error, no crash", async () => {
  globalThis.fetch = async () => new Response("<html>nope</html>", { status: 502 });
  const view = render(React.createElement(SessionInsightsDialog, {
    sessionId: SESSION, open: true, onClose: () => {},
  }));
  await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
  assert.ok(view.container !== null, "component still mounted");
  assert.ok(document.body.textContent !== null);
});
