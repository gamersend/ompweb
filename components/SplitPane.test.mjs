import "../tests/setup-dom.mjs";
import assert from "node:assert/strict";
import test, { afterEach, beforeEach } from "node:test";
import React from "react";
import { act, cleanup, fireEvent, render } from "@testing-library/react/pure.js";
import { createJiti } from "jiti";

// ============================================================================
// SplitPane (Phase 12): width persistence, 50/50 reset, mobile gate,
// divider slider a11y, pane focus ring + Ctrl/Cmd-[ / Ctrl/Cmd+] switching.
// ============================================================================

const jiti = createJiti(import.meta.url, {
  jsx: { runtime: "automatic" },
  tsconfigPaths: true,
});
const { SplitPane } = await jiti.import("./SplitPane.tsx");

const STORAGE_KEY = "omp-web:split-width";

// jsdom has no layout: keep matchMedia controllable per test (mobile gate).
let mobile = false;
const matchMediaOverrides = [
  [window, "matchMedia", {
    value: (media) => Object.assign(new window.EventTarget(), { matches: mobile, media }),
  }],
].map(([target, key, replacement]) => ({
  target, key, replacement, original: Object.getOwnPropertyDescriptor(target, key),
}));

beforeEach(() => {
  mobile = false;
  localStorage.clear();
  for (const { target, key, replacement } of matchMediaOverrides) {
    Object.defineProperty(target, key, { configurable: true, ...replacement });
  }
});

afterEach(() => {
  cleanup();
  for (const { target, key, original } of matchMediaOverrides) {
    if (original) Object.defineProperty(target, key, original);
    else delete target[key];
  }
  localStorage.clear();
});

function mountSplit(overrides = {}) {
  let activePane = "left";
  let closed = false;
  function Harness() {
    const [pane, setPane] = React.useState("left");
    activePane = pane;
    return React.createElement(SplitPane, {
      left: React.createElement("div", {}, "left-content"),
      right: React.createElement("div", {}, "right-content"),
      rightTitle: "split session",
      onCloseRight: () => { closed = true; },
      activePane: pane,
      onActivePaneChange: setPane,
      ...overrides,
    });
  }
  const view = render(React.createElement(Harness));
  return {
    view,
    separator: view.container.querySelector('[role="separator"]'),
    leftPane: view.container.querySelector('[data-split-pane="left"]'),
    rightPane: view.container.querySelector('[data-split-pane="right"]'),
    closeButton: view.container.querySelector('button[aria-label="Close split"]'),
    isClosed: () => closed,
    active: () => activePane,
  };
}

test("renders both panes with a separator slider between them", () => {
  const split = mountSplit();
  assert.ok(split.leftPane, "left pane mounted");
  assert.ok(split.rightPane, "right pane mounted");
  assert.equal(split.leftPane.textContent, "left-content");
  assert.equal(split.rightPane.textContent.includes("split session"), true, "right pane header shows the title");
  assert.equal(split.rightPane.textContent.includes("right-content"), true);
  assert.equal(split.separator.getAttribute("role"), "separator");
  assert.equal(split.separator.getAttribute("aria-orientation"), "vertical");
  assert.equal(split.separator.getAttribute("aria-valuenow"), "50", "default 50/50");
  assert.ok(split.separator.getAttribute("aria-valuemin"));
});

test("divider keyboard arrows resize and persist the width", async () => {
  localStorage.setItem(STORAGE_KEY, "400");
  const split = mountSplit();
  await act(async () => {}); // flush persisted-width hydration

  // ArrowRight narrows the right pane (divider sits on its left edge).
  await act(async () => {
    fireEvent.keyDown(split.separator, { key: "ArrowRight" });
  });
  const narrowed = Number(localStorage.getItem(STORAGE_KEY));
  assert.equal(narrowed, 390, "committed width persisted (400 - 10)");

  // ArrowLeft widens again.
  await act(async () => {
    fireEvent.keyDown(split.separator, { key: "ArrowLeft" });
  });
  assert.equal(Number(localStorage.getItem(STORAGE_KEY)), 400);
});

test("double-click resets to 50/50 and clears the stored width", async () => {
  localStorage.setItem(STORAGE_KEY, "400");
  const split = mountSplit();
  await act(async () => {});

  await act(async () => {
    fireEvent.doubleClick(split.separator);
  });
  assert.equal(localStorage.getItem(STORAGE_KEY), null, "double-click clears the stored width");
  assert.equal(split.separator.getAttribute("aria-valuenow"), "50");
});

test("Enter on the focused divider follows the same reset path", async () => {
  localStorage.setItem(STORAGE_KEY, "420");
  const split = mountSplit();
  await act(async () => {}); // hydration adopts 420

  await act(async () => {
    fireEvent.keyDown(split.separator, { key: "Enter" });
  });
  assert.equal(localStorage.getItem(STORAGE_KEY), null);
});

test("closing the pane chrome hands off to onCloseRight", async () => {
  const split = mountSplit();
  await act(async () => {
    fireEvent.click(split.closeButton);
  });
  assert.equal(split.isClosed(), true, "pane close delegated to the owner");
});

test("mobile falls back to a single view: left content only, no divider", async () => {
  mobile = true;
  const split = mountSplit();
  assert.ok(split.view.container.textContent.includes("left-content"), "left content still rendered");
  assert.equal(split.view.container.querySelector("[data-split-pane]"), null, "no pane chrome on mobile");
  assert.equal(split.separator, null, "no divider on mobile");
  assert.equal(split.view.container.textContent.includes("right-content"), false, "right pane dropped");
});

test("Ctrl/Cmd+[ and Ctrl/Cmd+] switch the active pane (focus + ring)", async () => {
  const split = mountSplit();
  assert.equal(split.active(), "left");

  await act(async () => {
    fireEvent.keyDown(window, { key: "]", ctrlKey: true });
  });
  assert.equal(split.active(), "right", "Ctrl+] activates the split pane");
  assert.equal(document.activeElement, split.rightPane, "right pane focused");
  assert.equal(split.rightPane.style.outline.includes("var(--accent)"), true, "visible ring on the active pane");

  await act(async () => {
    fireEvent.keyDown(window, { key: "[", ctrlKey: true });
  });
  assert.equal(split.active(), "left", "Ctrl+[ switches back");
  assert.equal(document.activeElement, split.leftPane);
  assert.equal(split.leftPane.style.outline.includes("var(--accent)"), true);
  assert.equal(split.rightPane.style.outline, "none", "inactive pane has no ring");
});

test("focusing into a pane makes it active", async () => {
  const split = mountSplit();
  await act(async () => {
    fireEvent.focus(split.rightPane);
  });
  assert.equal(split.active(), "right");
});

test("width changes are clamped to the split minimum", async () => {
  localStorage.setItem(STORAGE_KEY, "285");
  const split = mountSplit();
  await act(async () => {});
  // Several ArrowRight steps (−10 each) must never go below SPLIT_MIN_WIDTH.
  for (let i = 0; i < 10; i += 1) {
    await act(async () => {
      fireEvent.keyDown(split.separator, { key: "ArrowRight" });
    });
  }
  assert.equal(Number(localStorage.getItem(STORAGE_KEY)), 280);
});
