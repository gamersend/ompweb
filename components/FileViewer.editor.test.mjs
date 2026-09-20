import assert from "node:assert/strict";
import "../tests/setup-dom.mjs";
import test, { afterEach } from "node:test";
import React from "react";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react/pure.js";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  jsx: { runtime: "automatic" },
  tsconfigPaths: true,
});
const { FileViewer } = await jiti.import("./FileViewer.tsx");

afterEach(() => {
  cleanup();
  FakeEventSource.instances = [];
});

// useTheme → matchMedia (not implemented by jsdom).
const originalMatchMedia = window.matchMedia;
if (!originalMatchMedia) {
  window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
}

/* Stub EventSource: jsdom has none. Instances record change events so tests
 * can fake the file watcher pushing disk mutations. */
class FakeEventSource {
  constructor(url) {
    this.url = url;
    this.listeners = new Map();
    this.closed = false;
    FakeEventSource.instances.push(this);
    queueMicrotask(() => this.emit("connected", { filePath: "" }));
  }
  addEventListener(type, fn) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(fn);
  }
  emit(type, data) {
    for (const fn of this.listeners.get(type) ?? []) fn({ data: JSON.stringify(data) });
  }
  close() { this.closed = true; }
}
FakeEventSource.instances = [];
globalThis.EventSource = FakeEventSource;

/* Stub fetch: routes /api/files requests against a tiny fake disk. */
const state = {
  diskContent: "export const a = 1;\n",
  diskMtime: "2026-01-01T00:00:00.000Z",
  calls: [],
  editStatus: 200,
};
function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}
globalThis.fetch = async (url, opts = {}) => {
  const href = String(url);
  state.calls.push({ href, method: opts.method ?? "GET", body: opts.body });
  const u = new URL(href, "http://localhost");
  if (opts.method === "PUT" && u.pathname.startsWith("/api/files/")) {
    const parsed = JSON.parse(opts.body);
    state.diskContent = parsed.content;
    state.diskMtime = "2026-01-02T00:00:00.000Z";
    return jsonResponse(200, { size: parsed.content.length, mtime: state.diskMtime });
  }
  const type = u.searchParams.get("type");
  if (type === "meta") {
    return jsonResponse(200, { size: state.diskContent.length, mtime: state.diskMtime, language: "typescript", mime: "text/plain", previewKind: null });
  }
  if (type === "edit") {
    if (state.editStatus !== 200) return jsonResponse(state.editStatus, { error: "File too large to edit (over 2MB)", code: "file_too_large_edit" });
    return jsonResponse(200, { content: state.diskContent, language: "typescript", size: state.diskContent.length, mtime: state.diskMtime });
  }
  if (type === "read") {
    return jsonResponse(200, { content: state.diskContent, language: "typescript", size: state.diskContent.length, mtime: state.diskMtime });
  }
  if (u.pathname === "/api/git/diff") {
    return jsonResponse(200, { supported: false });
  }
  return jsonResponse(404, { error: "unrouted" });
};

function renderViewer(props = {}) {
  const dirtyEvents = [];
  const view = render(React.createElement(FileViewer, {
    filePath: "C:/proj/src/app.ts",
    cwd: "C:/proj",
    onDirtyChange: (d) => dirtyEvents.push(d),
    ...props,
  }));
  return { view, dirtyEvents };
}

const pencil = (view) => view.getByRole("button", { name: "Edit file" });
const eye = (view) => view.getByRole("button", { name: "Stop editing" });

test("edit toggle loads the editor; dirty state bubbles up", async () => {
  const { view, dirtyEvents } = renderViewer();
  await waitFor(() => view.getByRole("button", { name: "Edit file" }));
  await act(async () => { fireEvent.click(pencil(view)); });
  const textarea = await waitFor(() => view.container.querySelector("textarea.file-editor-textarea"));
  assert.ok(textarea, "editor textarea mounted");
  await act(async () => {
    fireEvent.change(textarea, { target: { value: "export const a = 2;\n" } });
  });
  assert.ok(dirtyEvents.includes(true), "dirty bubbles to the tab strip");

  // Exit guard: saving is confirmed from the dialog, then the editor closes.
  await act(async () => { fireEvent.click(eye(view)); });
  assert.match(document.body.textContent, /Unsaved changes/);
  const saveButton = Array.from(document.querySelectorAll("button")).find((b) => b.textContent === "Save changes");
  await act(async () => { fireEvent.click(saveButton); });
  await waitFor(() => assert.equal(view.container.querySelector("textarea.file-editor-textarea"), null));
  const put = state.calls.find((c) => c.method === "PUT");
  assert.ok(put, "PUT issued");
  assert.equal(JSON.parse(put.body).content, "export const a = 2;\n");
  assert.ok(dirtyEvents.includes(false), "dirty clears after save+exit");
});

test("external change while dirty offers reload / overwrite, never silent clobber", async () => {
  state.diskContent = "export const a = 1;\n";
  state.diskMtime = "2026-01-01T00:00:00.000Z";
  state.calls = [];
  const { view } = renderViewer();
  await waitFor(() => view.getByRole("button", { name: "Edit file" }));
  await act(async () => { fireEvent.click(pencil(view)); });
  const textarea = await waitFor(() => view.container.querySelector("textarea.file-editor-textarea"));

  await act(async () => {
    fireEvent.change(textarea, { target: { value: "my local version\n" } });
  });

  // The watcher reports a disk mutation while we are dirty.
  const es = FakeEventSource.instances[FakeEventSource.instances.length - 1];
  await act(async () => {
    es.emit("change", { mtime: "2026-01-05T00:00:00.000Z", size: 42 });
  });
  assert.match(document.body.textContent, /File changed on disk/);
  // The local value survived — no blind overwrite, no blind reload.
  assert.equal(view.container.querySelector("textarea.file-editor-textarea").value, "my local version\n");

  // "Overwrite with my edits" PUTs the local version.
  await act(async () => {
    fireEvent.click(Array.from(document.querySelectorAll("button")).find((b) => b.textContent === "Overwrite with my edits"));
  });
  await waitFor(() => assert.equal(document.body.textContent.includes("File changed on disk"), false));
  const put = [...state.calls].reverse().find((c) => c.method === "PUT");
  assert.equal(JSON.parse(put.body).content, "my local version\n");
});

test("external change while clean refreshes the editor baseline quietly", async () => {
  state.diskContent = "export const a = 1;\n";
  state.diskMtime = "2026-01-01T00:00:00.000Z";
  state.calls = [];
  const { view } = renderViewer();
  await waitFor(() => view.getByRole("button", { name: "Edit file" }));
  await act(async () => { fireEvent.click(pencil(view)); });
  await waitFor(() => view.container.querySelector("textarea.file-editor-textarea"));

  state.diskContent = "export const diskWon = true;\n";
  state.diskMtime = "2026-01-06T00:00:00.000Z";
  const es = FakeEventSource.instances[FakeEventSource.instances.length - 1];
  await act(async () => {
    es.emit("change", { mtime: state.diskMtime, size: 29 });
  });
  const textarea = await waitFor(() => {
    const ta = view.container.querySelector("textarea.file-editor-textarea");
    if (!ta || ta.value !== "export const diskWon = true;\n") throw new Error("baseline not swapped yet");
    return ta;
  });
  assert.equal(textarea.value, "export const diskWon = true;\n");
  assert.equal(document.body.textContent.includes("File changed on disk"), false);
});

test("a focus-driven mtime check opens the diff-choice dialog while dirty", async () => {
  state.diskContent = "export const a = 1;\n";
  state.diskMtime = "2026-01-01T00:00:00.000Z";
  state.calls = [];
  const { view } = renderViewer();
  await waitFor(() => view.getByRole("button", { name: "Edit file" }));
  await act(async () => { fireEvent.click(pencil(view)); });
  const textarea = await waitFor(() => view.container.querySelector("textarea.file-editor-textarea"));
  await act(async () => {
    fireEvent.change(textarea, { target: { value: "unsaved\n" } });
  });

  // The agent rewrote the file while we typed; we only notice on focus.
  state.diskMtime = "2026-01-07T00:00:00.000Z";
  await act(async () => {
    fireEvent(window, new Event("focus"));
  });
  await waitFor(() => assert.match(document.body.textContent, /File changed on disk/));

  // Reload discards the local edit and adopts the disk version.
  state.diskContent = "export const agentWroteThis = true;\n";
  await act(async () => {
    fireEvent.click(Array.from(document.querySelectorAll("button")).find((b) => b.textContent === "Reload from disk"));
  });
  const fresh = await waitFor(() => {
    const ta = view.container.querySelector("textarea.file-editor-textarea");
    if (!ta || ta.value !== "export const agentWroteThis = true;\n") throw new Error("reload pending");
    return ta;
  });
  assert.equal(fresh.value, "export const agentWroteThis = true;\n");
});
