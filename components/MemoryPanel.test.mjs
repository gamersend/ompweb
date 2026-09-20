import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import "../tests/setup-dom.mjs";
import test, { afterEach } from "node:test";
import React from "react";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react/pure.js";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  jsx: { runtime: "automatic" },
  tsconfigPaths: true,
});
const { MemoryPanel } = await jiti.import("./MemoryPanel.tsx");
const { onComposerInsert } = await jiti.import("@/lib/composer-insert");

const PANEL_SOURCE = readFileSync(new URL("./MemoryPanel.tsx", import.meta.url), "utf8");
const CHAT_INPUT_SOURCE = readFileSync(new URL("./ChatInput.tsx", import.meta.url), "utf8");

afterEach(cleanup);

// ─── source-contract assertions ──────────────────────────────────────────────

test("the composer-insert seam is wired through ChatInput", () => {
  assert.match(CHAT_INPUT_SOURCE, /import \{ onComposerInsert \} from "@\/lib\/composer-insert"/);
  assert.match(CHAT_INPUT_SOURCE, /onComposerInsert\(\(\{ text, draftKey: targetKey \}\)/);
  // The seam appends to the composer; it must never send.
  assert.doesNotMatch(CHAT_INPUT_SOURCE, /onComposerInsert[\s\S]{0,600}onSend\(/);
});

test("the memory panel renders results through the markdown pipeline", () => {
  assert.match(PANEL_SOURCE, /<MarkdownBody suppressImages/);
  // The disclosure line is in the panel, not SettingsConfig.
  assert.match(PANEL_SOURCE, /t\("memory\.disclosure"\)/);
});

// ─── fetch mock harness ──────────────────────────────────────────────────────

const fetchCalls = [];
let fetchResponder = null;
const originalFetch = globalThis.fetch;

function jsonResponse(body, status = 200) {
  return {
    ok: status < 400,
    status,
    json: async () => body,
  };
}

function installFetchMock() {
  globalThis.fetch = async (input) => {
    const url = String(input);
    fetchCalls.push(url);
    if (fetchResponder) return fetchResponder(url);
    if (url === "/api/memory") return jsonResponse({ success: true, data: { configured: true, healthy: true } });
    return jsonResponse({ success: true, data: { result: "", redactedCount: 0 } });
  };
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  fetchResponder = null;
  fetchCalls.length = 0;
});

function renderPanel(props = {}) {
  return render(React.createElement(MemoryPanel, {
    active: true,
    composerDraftKey: "sess-1",
    ...props,
  }));
}

// ─── health dot ──────────────────────────────────────────────────────────────

test("shows a healthy dot after a green probe", async () => {
  installFetchMock();
  const { getByRole } = renderPanel();
  await waitFor(() => assert.equal(getByRole("img", { name: "mem0 reachable" }).textContent, ""));
  assert.ok(fetchCalls.includes("/api/memory"));
});

test("shows a down dot when the service is unreachable", async () => {
  installFetchMock();
  fetchResponder = () => jsonResponse({ success: true, data: { configured: true, healthy: false } });
  const { getByRole } = renderPanel();
  await waitFor(() => assert.ok(getByRole("img", { name: "mem0 unreachable" })));
});

test("shows the not-configured empty state when the route gates with 503", async () => {
  installFetchMock();
  fetchResponder = () => jsonResponse(
    { error: "Shared memory is not configured", code: "memory_not_configured" },
    503,
  );
  const { getByRole, getByText } = renderPanel();
  await waitFor(() => assert.ok(getByText("Shared memory is not configured on this install")));
  // Search is disabled while unconfigured.
  assert.equal(getByRole("textbox").disabled, true);
});

// ─── search + cards ──────────────────────────────────────────────────────────

async function searchFor(getByRole, query) {
  const input = getByRole("textbox");
  fireEvent.change(input, { target: { value: query } });
  const form = input.closest("form");
  fireEvent.submit(form);
}

test("search proxies through /api/memory and renders markdown cards", async () => {
  installFetchMock();
  fetchResponder = (url) => {
    if (url.includes("/api/memory?q=")) {
      return jsonResponse({
        success: true,
        data: { result: "- first memory entry\n- second memory entry", redactedCount: 0 },
      });
    }
    return jsonResponse({ success: true, data: { configured: true, healthy: true } });
  };
  const { getByRole, getByText, queryAllByText } = renderPanel();
  await waitFor(() => assert.ok(getByRole("img", { name: "mem0 reachable" })));

  await searchFor(getByRole, "lan registry");

  await waitFor(() => assert.ok(getByText("first memory entry")));
  // One card per list item, plus the count line ("2 results").
  await waitFor(() => assert.ok(getByText("2 results")));
  assert.equal(queryAllByText("first memory entry").length, 1);
  const searched = fetchCalls.find((url) => url.includes("/api/memory?q="));
  assert.ok(searched.includes(encodeURIComponent("lan registry")));
  assert.ok(searched.includes("limit=20"));
});

test("shows the redaction count when secrets were masked", async () => {
  installFetchMock();
  fetchResponder = (url) => {
    if (url.includes("/api/memory?q=")) {
      return jsonResponse({
        success: true,
        data: { result: "- entry with a masked secret", redactedCount: 2 },
      });
    }
    return jsonResponse({ success: true, data: { configured: true, healthy: true } });
  };
  const { getByRole, getByText } = renderPanel();
  await waitFor(() => assert.ok(getByRole("img", { name: "mem0 reachable" })));
  await searchFor(getByRole, "secrets");
  await waitFor(() => assert.ok(getByText((_content, el) => el?.textContent === "1 result · 2 secrets masked")));
});

test("maps an unreachable search to the localized error state", async () => {
  installFetchMock();
  fetchResponder = (url) => {
    if (url.includes("/api/memory?q=")) {
      return jsonResponse({ error: "mem0 request failed", code: "memory_unreachable" }, 502);
    }
    return jsonResponse({ success: true, data: { configured: true, healthy: true } });
  };
  const { getByRole, getByText } = renderPanel();
  await waitFor(() => assert.ok(getByRole("img", { name: "mem0 reachable" })));
  await searchFor(getByRole, "anything");
  await waitFor(() => assert.ok(getByText("The shared memory service is unreachable")));
});

// ─── insert-into-composer flow ───────────────────────────────────────────────

test("insert publishes a fenced context block targeted at the active draft", async () => {
  installFetchMock();
  fetchResponder = (url) => {
    if (url.includes("/api/memory?q=")) {
      return jsonResponse({
        success: true,
        data: { result: "- memory A\n- memory B", redactedCount: 0 },
      });
    }
    return jsonResponse({ success: true, data: { configured: true, healthy: true } });
  };
  const seen = [];
  const unsubscribe = onComposerInsert((detail) => seen.push(detail));

  const { getByRole, getAllByRole } = renderPanel();
  await waitFor(() => assert.ok(getByRole("img", { name: "mem0 reachable" })));
  await searchFor(getByRole, "q");
  await waitFor(() => assert.ok(getAllByRole("button", { name: "Insert into composer" }).length > 0));

  fireEvent.click(getAllByRole("button", { name: "Insert into composer" })[0]);
  unsubscribe();

  assert.equal(seen.length, 1);
  assert.equal(seen[0].draftKey, "sess-1");
  assert.equal(seen[0].source, "memory");
  assert.match(seen[0].text, /^Shared memory \(mem0\)/);
  assert.match(seen[0].text, /```/);
  assert.match(seen[0].text, /memory A/);
});

test("insert without an active draft key targets any mounted composer", async () => {
  installFetchMock();
  fetchResponder = (url) => {
    if (url.includes("/api/memory?q=")) {
      return jsonResponse({ success: true, data: { result: "- memory X", redactedCount: 0 } });
    }
    return jsonResponse({ success: true, data: { configured: true, healthy: true } });
  };
  const seen = [];
  const unsubscribe = onComposerInsert((detail) => seen.push(detail));

  const { getByRole, getAllByRole } = renderPanel({ composerDraftKey: null });
  await waitFor(() => assert.ok(getByRole("img", { name: "mem0 reachable" })));
  await searchFor(getByRole, "q");
  await waitFor(() => assert.ok(getAllByRole("button", { name: "Insert into composer" }).length > 0));
  fireEvent.click(getAllByRole("button", { name: "Insert into composer" })[0]);
  unsubscribe();

  assert.equal(seen[0].draftKey, undefined);
});
