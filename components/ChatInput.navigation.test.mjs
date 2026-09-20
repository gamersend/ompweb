import "../tests/setup-dom.mjs";
import assert from "node:assert/strict";
import test, { afterEach, beforeEach } from "node:test";
import React, { act } from "react";
import { cleanup, render, screen, waitFor } from "@testing-library/react/pure.js";
import userEvent from "@testing-library/user-event";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { jsx: { runtime: "automatic" }, tsconfigPaths: true });
const { ChatInput } = await jiti.import("./ChatInput.tsx");
const { useSidebarHistory } = await jiti.import("@/hooks/useSidebarHistory");
const { clearDraft, getDraft } = await jiti.import("@/lib/draft-store");
const { recordPrompt } = await jiti.import("@/lib/prompt-history");

beforeEach(() => {
  window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
});
afterEach(() => {
  cleanup();
  clearDraft("new:unassigned");
  clearDraft("draft-a");
  clearDraft("draft-b");
  localStorage.clear();
  delete window.matchMedia;
});

function warnsOnExit() {
  const event = new Event("beforeunload", { cancelable: true });
  window.dispatchEvent(event);
  return event.defaultPrevented;
}

function Guard() {
  // The actual history protocol is exercised in useSidebarHistory.test.mjs.
  // This mounts the same document guard with the real composer/draft store.
  useSidebarHistory({ active: false, ready: false, sidebarOpen: true, setSidebarOpen() {}, url: "" });
  return null;
}

test("no-key composer text survives minimization and warns on document exit until sent", async () => {
  const user = userEvent.setup();
  const sent = [];
  function Shell({ minimized = false }) {
    return React.createElement(React.Fragment, null,
      React.createElement(Guard),
      React.createElement("div", { style: { display: minimized ? "none" : undefined } },
        React.createElement(ChatInput, { onSend: (text) => sent.push(text), onAbort() {}, isStreaming: false })),
    );
  }
  const { rerender } = render(React.createElement(Shell));
  assert.equal(warnsOnExit(), false);
  await user.type(screen.getByRole("textbox"), "unsent in a new composer");
  assert.equal(warnsOnExit(), true);
  rerender(React.createElement(Shell, { minimized: true }));
  assert.equal(warnsOnExit(), true);
  assert.equal(screen.getByRole("textbox", { hidden: true }).value, "unsent in a new composer");
  rerender(React.createElement(Shell));
  await user.click(screen.getByRole("textbox"));
  await user.keyboard("{Enter}");
  assert.deepEqual(sent, ["unsent in a new composer"]);
  assert.equal(warnsOnExit(), false);
});

test("attachment-only drafts stay protected across live draft-key changes and restore without warning on internal picks", async () => {
  const user = userEvent.setup();
  const ref = React.createRef();
  const sent = [];
  function Shell({ session }) {
    return React.createElement(React.Fragment, null,
      React.createElement(Guard),
      React.createElement(ChatInput, { draftKey: session, ref, onSend: (text) => sent.push(text), onAbort() {}, isStreaming: false }),
    );
  }
  const { rerender } = render(React.createElement(Shell, { session: "draft-a" }));
  await act(async () => {
    ref.current.addFiles([new File(["important attachment"], "notes.txt", { type: "text/plain" })]);
  });
  await waitFor(() => assert.equal(getDraft("draft-a")?.files[0]?.content, "important attachment"));
  assert.equal(warnsOnExit(), true);
  rerender(React.createElement(Shell, { session: "draft-b" }));
  assert.equal(screen.getByRole("textbox").value, "");
  assert.equal(getDraft("draft-a")?.files[0]?.content, "important attachment");
  assert.equal(warnsOnExit(), true);
  rerender(React.createElement(Shell, { session: "draft-a" }));
  await user.click(screen.getByRole("textbox"));
  await user.keyboard("{Enter}");
  assert.match(sent[0], /important attachment/);
  assert.equal(warnsOnExit(), false);
});

// ── 6e: global prompt history ───────────────────────────────────────────────

test("empty-input ArrowUp falls back to global prompt history and recalls the newest first", async () => {
  const user = userEvent.setup();
  const sent = [];
  recordPrompt("older global prompt", { now: () => 1 });
  recordPrompt("newest global prompt", { now: () => 2 });
  render(React.createElement(ChatInput, { onSend: (text) => sent.push(text), onAbort() {}, isStreaming: false }));

  const textarea = screen.getByRole("textbox");
  await user.click(textarea);
  // No per-session input history → the recall menu falls back to the global
  // store. Rows are chronological like session history (oldest on top) and the
  // highlight starts on the last row = the most recent prompt.
  await user.keyboard("{ArrowUp}");
  const rows = screen.getAllByRole("button", { name: /global prompt/ });
  const labels = rows.map((row) => row.textContent?.match(/(?:newest|older) global prompt/)?.[0]);
  assert.deepEqual(labels, ["older global prompt", "newest global prompt"]);

  // Enter applies the highlighted (newest) prompt — it never sends.
  await user.keyboard("{Enter}");
  assert.equal(textarea.value, "newest global prompt");
  assert.equal(sent.length, 0, "recall inserts the prompt; it must not send it");
});

test("Ctrl+ArrowUp opens the project-filtered global picker and inserts the picked prompt without sending", async () => {
  const user = userEvent.setup();
  const sent = [];
  recordPrompt("repo-a first", { projectRoot: "/repo-a", now: () => 1 });
  recordPrompt("repo-a second", { projectRoot: "/repo-a", now: () => 2 });
  recordPrompt("repo-b prompt", { projectRoot: "/repo-b", now: () => 3 });
  recordPrompt("unscoped prompt", { now: () => 4 });
  render(React.createElement(ChatInput, {
    onSend: (text) => sent.push(text),
    onAbort() {},
    isStreaming: false,
    projectRoot: "/repo-a",
  }));

  const textarea = screen.getByRole("textbox");
  await user.click(textarea);
  await user.keyboard("{Control>}{ArrowUp}{/Control}");
  const picker = screen.getByRole("listbox", { name: /Recent prompts|promptHistory\.pickerTitle/ });
  assert.match(picker.textContent ?? "", /repo-a second/, "newest repo-a prompt is listed");
  assert.match(picker.textContent ?? "", /repo-a first/);
  assert.ok(!picker.textContent?.includes("repo-b prompt"), "other projects stay out");
  assert.ok(!picker.textContent?.includes("unscoped prompt"), "projectless prompts stay out");

  // ArrowDown moves to the older repo-a row; Enter inserts it — never sends.
  await user.keyboard("{ArrowDown}");
  await user.keyboard("{Enter}");
  assert.equal(textarea.value, "repo-a first");
  assert.equal(sent.length, 0, "the picker inserts; it must not send");
});

test("per-session recall wins over global history; the global store is only the fallback", async () => {
  const user = userEvent.setup();
  const sent = [];
  recordPrompt("global fallback prompt", { now: () => 1 });
  render(React.createElement(ChatInput, {
    onSend: (text) => sent.push(text),
    onAbort() {},
    isStreaming: false,
    inputHistory: ["session prompt"],
  }));

  const textarea = screen.getByRole("textbox");
  await user.click(textarea);
  await user.keyboard("{ArrowUp}");
  // The recall menu shows the session prompt and none of the global entries.
  const rows = screen.getAllByRole("button", { name: /prompt/ });
  const labels = rows.map((row) => row.textContent ?? "").join(" ");
  assert.match(labels, /session prompt/);
  assert.ok(!labels.includes("global fallback prompt"), "global entries stay hidden while session history exists");
  await user.keyboard("{Enter}");
  assert.equal(textarea.value, "session prompt");
  assert.equal(sent.length, 0);
});

