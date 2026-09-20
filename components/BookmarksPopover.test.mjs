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
const {
  BookmarksPopover,
  MessageBookmarkButton,
  buildBookmarkPreviews,
} = await jiti.import("./BookmarksPopover.tsx");
const {
  addBookmark,
  bookmarksStorageKey,
  setBookmarksStorage,
  toggleBookmark,
} = await jiti.import("@/lib/bookmarks");
const { BOOKMARKS_STORAGE_PREFIX } = await jiti.import("@/lib/bookmarks");
const noop = () => {};

/** jsdom localStorage wrapper matching the injectable StorageLike shape. */
function domStorage() {
  return {
    getItem: (key) => window.localStorage.getItem(key),
    setItem: (key, value) => { window.localStorage.setItem(key, value); },
    removeItem: (key) => { window.localStorage.removeItem(key); },
  };
}

function seedBookmarks(sessionId, entries) {
  window.localStorage.setItem(bookmarksStorageKey(sessionId), JSON.stringify(entries));
}

function resetBookmarks() {
  for (const key of Object.keys(window.localStorage)) {
    if (key.startsWith(BOOKMARKS_STORAGE_PREFIX)) window.localStorage.removeItem(key);
  }
}

afterEach(() => {
  cleanup();
  resetBookmarks();
  setBookmarksStorage(null);
});

const SESSION = "sess-bookmarks-1";

test("buildBookmarkPreviews flattens user + assistant prose and truncates long text", () => {
  const messages = [
    { role: "user", content: "First question\nwith two lines" },
    { role: "assistant", content: [
      { type: "thinking", thinking: "hidden reasoning" },
      { type: "text", text: "Answer part one." },
      { type: "text", text: "Answer part two." },
    ] },
    { role: "toolResult", content: [{ type: "text", text: "tool output is never previewed" }] },
  ];
  const previews = buildBookmarkPreviews(messages, ["e1", "e2", "e3", "e4"]);
  assert.equal(previews.get("e1"), "First question with two lines");
  assert.equal(previews.get("e2"), "Answer part one. Answer part two.");
  assert.equal(previews.size, 2, "toolResults and entry-less rows produce no preview");

  const long = "x".repeat(400);
  const truncated = buildBookmarkPreviews([{ role: "user", content: long }], ["e9"]);
  assert.ok(truncated.get("e9").length <= 140);
  assert.ok(truncated.get("e9").endsWith("…"));
});

test("renders nothing without a session or when there are no bookmarks", () => {
  setBookmarksStorage(() => domStorage());
  const empty = render(React.createElement(BookmarksPopover, {
    sessionId: SESSION, previewByEntry: new Map(), onJump: noop,
  }));
  assert.equal(empty.container.textContent, "");
  empty.unmount();

  const noSession = render(React.createElement(BookmarksPopover, {
    sessionId: null, previewByEntry: new Map(), onJump: noop,
  }));
  assert.equal(noSession.container.textContent, "");
  noSession.unmount();
});

test("star toggle reflects store state and flips it through the pill count", async () => {
  setBookmarksStorage(() => domStorage());
  seedBookmarks(SESSION, [{ entryId: "e1", ts: 42, note: "remember" }]);

  const view = render(React.createElement("div", {}, [
    React.createElement(MessageBookmarkButton, { key: "star", sessionId: SESSION, entryId: "e1" }),
    React.createElement(BookmarksPopover, {
      key: "popover", sessionId: SESSION, previewByEntry: new Map([["e1", "hello world"]]), onJump: noop,
    }),
  ]));

  assert.equal(view.container.textContent, "1", "only the popover pill is visible; the star button hides at opacity 0");
  const star = view.getByRole("button", { name: "Remove bookmark" });
  assert.equal(star.getAttribute("aria-pressed"), "true");
  assert.ok(view.getByRole("button", { name: "1 bookmark" }));

  await act(async () => { fireEvent.click(star); });
  assert.equal(view.getByRole("button", { name: "Bookmark this message" }).getAttribute("aria-pressed"), "false");
  assert.equal(view.container.textContent, "", "pill disappears with the last bookmark removed");
});

test("popover opens, lists previews + notes, and jump routes through onJump", async () => {
  setBookmarksStorage(() => domStorage());
  seedBookmarks(SESSION, [
    { entryId: "e2", ts: 1_700_000_000_000, note: "check the math" },
    { entryId: "e1", ts: 1_700_000_001_000 },
  ]);
  const jumped = [];
  const previews = new Map([["e1", "first message"], ["e2", "second message"]]);

  const view = render(React.createElement(BookmarksPopover, {
    sessionId: SESSION, previewByEntry: previews, onJump: (entryId) => jumped.push(entryId),
  }));

  await act(async () => { fireEvent.click(view.getByRole("button", { name: "2 bookmarks" })); });

  const panel = view.getByRole("list");
  assert.ok(panel, "bookmark list is rendered once open");
  assert.match(view.getByTitle("first message").textContent, /first message/);
  assert.match(view.getByTitle("second message").textContent, /check the math|second message/);
  const jumpFirst = view.getByRole("button", { name: "Jump to: first message" });
  const jumpSecond = view.getByRole("button", { name: "Jump to: second message" });
  assert.ok(jumpFirst && jumpSecond);

  await act(async () => { fireEvent.click(jumpSecond); });
  assert.deepEqual(jumped, ["e2"], "row click asks the parent to anchorTo that entry");
});

test("popover jump falls back to entry id when no preview exists", async () => {
  setBookmarksStorage(() => domStorage());
  seedBookmarks(SESSION, [{ entryId: "eOnly", ts: 1 }]);
  const jumped = [];
  const view = render(React.createElement(BookmarksPopover, {
    sessionId: SESSION, previewByEntry: new Map(), onJump: (entryId) => jumped.push(entryId),
  }));
  await act(async () => { fireEvent.click(view.getByRole("button", { name: "1 bookmark" })); });
  await act(async () => { fireEvent.click(view.getByRole("button", { name: "Jump to: eOnly" })); });
  assert.deepEqual(jumped, ["eOnly"]);
});

test("note edit commits through the store and remove drops the bookmark", async () => {
  setBookmarksStorage(() => domStorage());
  seedBookmarks(SESSION, [{ entryId: "e1", ts: 1 }]);
  const view = render(React.createElement(BookmarksPopover, {
    sessionId: SESSION, previewByEntry: new Map([["e1", "target message"]]), onJump: noop,
  }));
  await act(async () => { fireEvent.click(view.getByRole("button", { name: "1 bookmark" })); });

  await act(async () => { fireEvent.click(view.getByRole("button", { name: "Edit note" })); });
  const input = view.getByRole("textbox", { name: "Edit note" });
  await act(async () => { fireEvent.change(input, { target: { value: "my note" } }); });
  await act(async () => { fireEvent.keyDown(input, { key: "Enter" }); });
  assert.match(view.getByTitle("target message").textContent, /my note/);

  await act(async () => { fireEvent.click(view.getByRole("button", { name: "Remove bookmark" })); });
  assert.equal(window.localStorage.getItem(bookmarksStorageKey(SESSION)), "[]", "removal persists the emptied list");
});

test("toggling a bookmark in another session never repaints this popover", async () => {
  setBookmarksStorage(() => domStorage());
  seedBookmarks(SESSION, [{ entryId: "e1", ts: 1 }]);
  addBookmark("other-session", "x");
  const view = render(React.createElement(BookmarksPopover, {
    sessionId: SESSION, previewByEntry: new Map([["e1", "mine"]]), onJump: noop,
  }));
  assert.equal(view.getByRole("button", { name: "1 bookmark" }).textContent, "1");
  toggleBookmark("other-session", "y");
  assert.equal(view.getByRole("button", { name: "1 bookmark" }).textContent, "1", "cross-session events are filtered by session id");
});
