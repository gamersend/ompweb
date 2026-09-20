import assert from "node:assert/strict";
import "../tests/setup-dom.mjs";
import test, { afterEach } from "node:test";
import React from "react";
import { act, cleanup, fireEvent, render } from "@testing-library/react/pure.js";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  jsx: { runtime: "automatic" },
  tsconfigPaths: true,
});
const { TabBar } = await jiti.import("./TabBar.tsx");

afterEach(cleanup);

// TabBar's scroll-into-view effect uses CSS.escape; jsdom does not expose CSS.
if (!globalThis.CSS) {
  globalThis.CSS = { escape: (s) => String(s).replace(/[^a-zA-Z0-9_\u00A0-\uFFFF-]/g, "\\$&") };
}

const TABS = [
  { id: "file:/a.ts", label: "a.ts", filePath: "/proj/a.ts" },
  { id: "file:/b.ts", label: "b.ts", filePath: "/proj/b.ts", dirty: true },
];

function renderBar(props = {}) {
  return render(React.createElement(TabBar, {
    tabs: TABS,
    activeTabId: "file:/a.ts",
    onSelectTab() {},
    onCloseTab() {},
    ...props,
  }));
}

test("dirty tabs show an unsaved dot instead of the close button", () => {
  const view = renderBar();
  const clean = view.getByRole("tab", { name: "/proj/a.ts" });
  assert.ok(clean.querySelector(".tabbar-close"), "clean tab has a close button");
  const dirty = view.getByRole("tab", { name: "b.ts (unsaved changes)" });
  assert.equal(dirty.querySelector(".tabbar-close"), null, "dirty tab hides close until hover");
  assert.ok(dirty.textContent.length > 0);
});

test("closing a clean tab is immediate", async () => {
  const closed = [];
  const view = renderBar({ onCloseTab: (id) => closed.push(id) });
  const clean = view.getByRole("tab", { name: "/proj/a.ts" });
  await act(async () => {
    fireEvent.keyDown(clean, { key: "Delete", bubbles: true });
  });
  assert.deepEqual(closed, ["file:/a.ts"]);
  assert.equal(dialogOpen(), null);
});

test("closing a dirty tab asks first; discard confirms, cancel keeps", async () => {
  const closed = [];
  const view = renderBar({ onCloseTab: (id) => closed.push(id) });
  const dirty = view.getByRole("tab", { name: "b.ts (unsaved changes)" });
  await act(async () => {
    fireEvent.keyDown(dirty, { key: "Delete", bubbles: true });
  });
  const dialog = document.querySelector("[role='dialog'], [aria-modal]");
  assert.ok(dialog, "confirmation dialog opens");
  assert.match(document.body.textContent, /Close tab with unsaved changes\?/);

  // Cancel keeps the tab.
  await act(async () => {
    fireEvent.click(Array.from(document.querySelectorAll("button")).find((b) => b.textContent === "Cancel"));
  });
  assert.deepEqual(closed, []);

  // Confirm discards and closes.
  await act(async () => {
    fireEvent.keyDown(dirty, { key: "Delete", bubbles: true });
  });
  await act(async () => {
    fireEvent.click(Array.from(document.querySelectorAll("button")).find((b) => b.textContent === "Discard and close"));
  });
  assert.deepEqual(closed, ["file:/b.ts"]);
});

function dialogOpen() {
  return Array.from(document.querySelectorAll("button")).find((b) => b.textContent === "Discard and close") ?? null;
}
