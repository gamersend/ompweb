import assert from "node:assert/strict";
import "../tests/setup-dom.mjs";
import test, { afterEach } from "node:test";
import React from "react";
import { act, cleanup, render } from "@testing-library/react/pure.js";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  jsx: { runtime: "automatic" },
  tsconfigPaths: true,
});
const { SessionItem } = await jiti.import("./SessionSidebar-rows.tsx");
const { addBookmark, bookmarkCountFor, setBookmarksStorage } = await jiti.import("@/lib/bookmarks");

afterEach(() => {
  cleanup();
  for (const key of Object.keys(window.localStorage)) {
    if (key.startsWith("omp-web:bookmarks:")) window.localStorage.removeItem(key);
  }
  setBookmarksStorage(null);
});

const SESSION = "sess-badge-1";

function makeSession() {
  return {
    id: SESSION,
    name: "Bookmarked session",
    firstMessage: "hello there",
    cwd: "C:/tmp/repo",
    modified: new Date().toISOString(),
  };
}

function renderRow() {
  return render(React.createElement(SessionItem, {
    session: makeSession(),
    isSelected: false,
    relativeTimeNow: Date.now(),
    onClick: () => {},
  }));
}

/** The lib takes a storage GETTER; wrap the jsdom backend. */
function domStorage() {
  return () => ({
    getItem: (key) => window.localStorage.getItem(key),
    setItem: (key, value) => { window.localStorage.setItem(key, value); },
    removeItem: (key) => { window.localStorage.removeItem(key); },
  });
}

test("session rows show a star-count badge only when bookmarks exist", () => {
  setBookmarksStorage(domStorage());

  const bare = renderRow();
  assert.equal(bare.queryByLabelText("1 bookmark"), null, "no badge on a bookmark-less session");
  bare.unmount();

  addBookmark(SESSION, "e1");
  addBookmark(SESSION, "e2");
  const row = renderRow();
  const badge = row.getByLabelText("2 bookmarks");
  assert.equal(badge.textContent, "2");
  assert.equal(bookmarkCountFor(SESSION), 2);
});

test("the badge updates live when the open session's bookmarks change", async () => {
  setBookmarksStorage(domStorage());
  const row = renderRow();
  assert.equal(row.queryByLabelText(/bookmark/), null);

  await act(async () => { addBookmark(SESSION, "e1"); });
  assert.ok(row.getByLabelText("1 bookmark"), "store change event repaints the row badge");

  // A different session's bookmark change must not touch this row.
  await act(async () => { addBookmark("sess-other", "e1"); });
  assert.ok(row.getByLabelText("1 bookmark"));
  assert.equal(row.queryByLabelText("2 bookmarks"), null);
});
