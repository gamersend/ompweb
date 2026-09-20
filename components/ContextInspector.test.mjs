import assert from "node:assert/strict";
import "../tests/setup-dom.mjs";
import test, { afterEach } from "node:test";
import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react/pure.js";
import { createJiti } from "jiti";

// jsdom lacks ResizeObserver; guard in case the dialog internals probe it.
if (typeof globalThis.ResizeObserver === "undefined") {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}

const jiti = createJiti(import.meta.url, {
  jsx: { runtime: "automatic" },
  tsconfigPaths: true,
});
const { ContextInspector } = await jiti.import("./ContextInspector.tsx");

// ---------------------------------------------------------------------------
// fabricated tree payload — a compaction cut, an exact-sourced assistant
// node, and a node whose latest continuation another node owns
// ---------------------------------------------------------------------------

const T0 = 1_789_000_000_000;

function node(overrides) {
  return {
    id: "x",
    parentId: null,
    kind: "message",
    ts: new Date(T0).toISOString(),
    tsMs: T0,
    estTokens: 10,
    exact: false,
    depth: 0,
    leafId: "x",
    preview: "preview text",
    ...overrides,
  };
}

const NODES = [
  node({ id: "a1", parentId: null, kind: "message", role: "user", estTokens: 25, depth: 0, leafId: "a2", preview: "first question" }),
  node({ id: "a2", parentId: "a1", kind: "message", role: "assistant", estTokens: 400, exact: true, tokensIn: 12_000, depth: 1, leafId: "a2", preview: "big measured answer" }),
  node({ id: "k3", parentId: "a2", kind: "compaction", estTokens: 0, depth: 2, leafId: "k3", preview: "" }),
  node({ id: "b4", parentId: "k3", kind: "message", role: "user", estTokens: 8, depth: 3, leafId: "b4", preview: "after compaction" }),
];

const PAYLOAD = {
  success: true,
  sessionId: "sess-inspect",
  leafId: "b4",
  inContext: ["k3", "b4"],
  livePath: ["a1", "a2", "k3", "b4"],
  nodes: NODES,
  compactions: [{ entryId: "k3", firstKeptEntryId: "a1", tokensBefore: 33_000, summaryExcerpt: "cut the early turns" }],
  truncated: false,
  contextGauge: { tokens: 51_200, percent: 12.5, contextWindow: 400_000 },
};

const originalFetch = globalThis.fetch;

function mockFetch(payload, ok = true, status = 200) {
  globalThis.fetch = async () => ({
    ok,
    status,
    json: async () => payload,
  });
}

/** Wait until the four node buttons (aria-labels carry "tokens") are mounted. */
async function waitForNodeButtons() {
  return waitFor(() => {
    const nodeButtons = screen.getAllByRole("button").filter((el) =>
      typeof el.getAttribute("aria-label") === "string" && el.getAttribute("aria-label").includes("tokens"));
    assert.equal(nodeButtons.length, NODES.length);
    return nodeButtons;
  });
}

function nodeByPreview(buttons, preview) {
  const found = buttons.find((el) => el.getAttribute("aria-label").includes(preview));
  assert.ok(found, `node button with preview "${preview}" exists`);
  return found;
}

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
});

test("renders the graph, legend, and heaviest footer from the payload", async () => {
  mockFetch(PAYLOAD);
  render(React.createElement(ContextInspector, {
    sessionId: "sess-inspect", open: true, onClose: () => {}, onNavigate: () => {},
  }));

  await waitForNodeButtons();

  // legend labels — the info lives in text, never color alone
  assert.ok(screen.getByText("Live branch"));
  assert.ok(screen.getByText("In current context"));
  assert.ok(screen.getByText("Compaction cut"));
  assert.ok(screen.getByText(/estimated \(chars\/4\)/));
  assert.ok(screen.getByText(/exact \(stats\.db\)/));

  // heaviest footer: est/exact totals vs the live gauge; the exact node's
  // measured tokens appear with its "=" marker and its preview
  assert.ok(screen.getByText("Top 5 heaviest entries"));
  assert.ok(screen.getByText(/Whole file \(est\.\):/));
  assert.ok(screen.getByText(/Live context: 51\.2k tokens/));
  assert.ok(screen.getByText(/=400/));
  assert.ok(screen.getByText(/after compaction/));
});

test("clicking a node navigates to that node's resolved leaf", async () => {
  mockFetch(PAYLOAD);
  const navigated = [];
  render(React.createElement(ContextInspector, {
    sessionId: "sess-inspect", open: true, onClose: () => {},
    onNavigate: (leafId) => navigated.push(leafId),
  }));

  const buttons = await waitForNodeButtons();
  fireEvent.click(nodeByPreview(buttons, "after compaction"));
  assert.deepEqual(navigated, ["b4"]);

  fireEvent.click(nodeByPreview(buttons, "first question"));
  assert.deepEqual(navigated, ["b4", "a2"], "clicking a1 navigates to its resolved leaf a2");
});

test("hover exposes the tooltip with kind, exact marker and state (not color-only)", async () => {
  mockFetch(PAYLOAD);
  render(React.createElement(ContextInspector, {
    sessionId: "sess-inspect", open: true, onClose: () => {}, onNavigate: () => {},
  }));

  const buttons = await waitForNodeButtons();
  fireEvent.mouseEnter(nodeByPreview(buttons, "big measured answer"));
  const tooltip = await waitFor(() => screen.getByRole("tooltip"));
  assert.match(tooltip.textContent, /Assistant message/);
  assert.match(tooltip.textContent, /=\s*400/); // "= exact" marker
  assert.match(tooltip.textContent, /live branch/);
});

test("compaction hover tooltip carries tokensBefore and the summary excerpt", async () => {
  mockFetch(PAYLOAD);
  render(React.createElement(ContextInspector, {
    sessionId: "sess-inspect", open: true, onClose: () => {}, onNavigate: () => {},
  }));

  const buttons = await waitForNodeButtons();
  fireEvent.mouseEnter(buttons.find((el) => el.getAttribute("aria-label").startsWith("Compaction")));
  const tooltip = await waitFor(() => screen.getByRole("tooltip"));
  assert.match(tooltip.textContent, /33\.0k tokens before this cut/);
  assert.match(tooltip.textContent, /cut the early turns/);
});

test("fetch failure surfaces the localized error text", async () => {
  mockFetch({ error: "Session not found", code: "session_not_found" }, false, 404);
  render(React.createElement(ContextInspector, {
    sessionId: "gone", open: true, onClose: () => {}, onNavigate: () => {},
  }));
  await waitFor(() => screen.getByText(/Session not found/));
});

test("nothing mounts when closed, and the BranchNavigator trigger stays wired", async () => {
  const empty = render(React.createElement(ContextInspector, {
    sessionId: "sess", open: false, onClose: () => {}, onNavigate: () => {},
  }));
  assert.equal(empty.container.textContent, "");
  empty.unmount();

  // trigger wiring asserted at source level (same pattern as api-contract tests)
  const { readFile } = await import("node:fs/promises");
  const navigator = await readFile(new URL("./BranchNavigator.tsx", import.meta.url), "utf8");
  assert.match(navigator, /<ContextInspector/);
  assert.match(navigator, /sessionId=\{sessionId \?\? null\}/);
  assert.match(navigator, /GitGraph/);
});
