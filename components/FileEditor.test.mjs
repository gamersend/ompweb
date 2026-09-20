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
  FileEditor,
  detectEol,
  normalizeToLf,
  restoreEol,
  EDITOR_READONLY_MAX_BYTES,
  EDITOR_PREVIEW_MAX_BYTES,
} = await jiti.import("./FileEditor.tsx");

afterEach(cleanup);

// SyntaxHighlightedCode → useTheme reads matchMedia (not implemented by
// jsdom); the editor itself never needs a real answer.
const originalMatchMedia = window.matchMedia;
if (!originalMatchMedia) {
  window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
}

function renderEditor(props = {}) {
  const onSave = props.onSave ?? (async () => ({ mtime: "2026-01-01T00:00:00.000Z", size: 1 }));
  const view = render(React.createElement(FileEditor, {
    filePath: "C:/proj/src/app.ts",
    language: "typescript",
    content: "line one\nline two\nline three\n",
    onSave,
    ...props,
  }));
  return { view, textarea: view.container.querySelector("textarea.file-editor-textarea") };
}

test("EOL helpers round trip CRLF, lone CR, and LF content", () => {
  assert.equal(detectEol("a\r\nb\r\nc"), "\r\n");
  assert.equal(detectEol("a\rb\nc"), "\r"); // lone CR wins over trailing LF
  assert.equal(detectEol("a\nb\nc"), "\n");
  assert.equal(normalizeToLf("a\r\nb\rc\nd"), "a\nb\nc\nd");
  assert.equal(restoreEol("a\nb\nc", "\r\n"), "a\r\nb\r\nc");
  assert.equal(restoreEol("a\nb", "\n"), "a\nb");
  // Round trip preserves the file's dominant EOL style.
  const crlf = "x\r\ny\r\n";
  assert.equal(restoreEol(normalizeToLf(crlf), detectEol(crlf)), crlf);
});

test("renders a mono textarea with caret status and a save button", () => {
  const { view } = renderEditor();
  const area = view.container.querySelector("textarea.file-editor-textarea");
  assert.ok(area, "textarea is rendered");
  assert.equal(area.value, "line one\nline two\nline three\n");
  assert.match(view.container.textContent, /Ln 1, Col 1/);
  assert.ok(view.container.querySelector(".file-editor-save-button"), "save button rendered while editable");
});

test("typing reports dirty and returning to the baseline clears it", async () => {
  const dirtyStates = [];
  const onDirtyChange = (d) => dirtyStates.push(d);
  const { textarea } = renderEditor({ onDirtyChange });
  await act(async () => {
    fireEvent.change(textarea, { target: { value: "line one changed\nline two\nline three\n" } });
  });
  assert.deepEqual(dirtyStates, [false, true]);
  await act(async () => {
    fireEvent.change(textarea, { target: { value: "line one\nline two\nline three\n" } });
  });
  assert.deepEqual(dirtyStates, [false, true, false]);
});

test("Ctrl+S saves through onSave with the file's EOL restored", async () => {
  const saved = [];
  let resolveSave;
  const onSave = (content) => new Promise((resolve) => {
    saved.push(content);
    resolveSave = () => resolve({ mtime: "2026-01-01T00:00:00.000Z", size: content.length });
  });
  const { view, textarea } = renderEditor({
    content: "a\r\nb\r\n",
    onSave,
    onDirtyChange: () => {},
  });
  await act(async () => {
    fireEvent.change(textarea, { target: { value: "a\r\nb changed\r\n" } });
  });
  // The textarea only ever sees LF.
  assert.equal(textarea.value, "a\nb changed\n");
  await act(async () => {
    fireEvent.keyDown(textarea, { key: "s", ctrlKey: true, bubbles: true });
  });
  // Restore: the bytes handed to onSave carry the file's CRLF style.
  assert.deepEqual(saved, ["a\r\nb changed\r\n"]);
  await act(async () => { resolveSave(); });
  const status = view.container.querySelector("[role='status']");
  assert.match(status.textContent, /Saved/);
});

test("failed save surfaces the error state in the status region", async () => {
  const { view, textarea } = renderEditor({ onSave: async () => null });
  await act(async () => {
    fireEvent.change(textarea, { target: { value: "edited\n" } });
  });
  await act(async () => {
    fireEvent.keyDown(textarea, { key: "s", metaKey: true, bubbles: true });
  });
  const status = view.container.querySelector("[role='status']");
  assert.match(status.textContent, /Save failed/);
});

test("files over 1 MB render read-only and refuse Ctrl+S", async () => {
  const calls = [];
  const big = "a".repeat(EDITOR_READONLY_MAX_BYTES + 1);
  const { view, textarea } = renderEditor({ content: big, onSave: async () => { calls.push("save"); return null; } });
  assert.equal(textarea.readOnly, true);
  assert.match(view.container.textContent, /Read-only/);
  await act(async () => {
    fireEvent.keyDown(textarea, { key: "s", ctrlKey: true, bubbles: true });
  });
  assert.deepEqual(calls, []);
});

test("Ctrl+G opens go-to-line and Enter jumps to the line", async () => {
  const { view, textarea } = renderEditor();
  await act(async () => {
    fireEvent.keyDown(textarea, { key: "g", ctrlKey: true, bubbles: true });
  });
  const input = view.getByLabelText("Go to line");
  await act(async () => {
    fireEvent.change(input, { target: { value: "3" } });
    fireEvent.keyDown(input, { key: "Enter", bubbles: true });
  });
  // Line 3 starts after "line one\nline two\n" and is selected in full.
  assert.equal(textarea.selectionStart, "line one\nline two\n".length);
  assert.equal(textarea.selectionEnd, "line one\nline two\nline three".length);
  assert.match(view.container.textContent, /Ln 3, Col/);
});

test("go-to-line clamps out-of-range input and Esc cancels", async () => {
  const { view, textarea } = renderEditor();
  await act(async () => {
    fireEvent.keyDown(textarea, { key: "g", ctrlKey: true, bubbles: true });
  });
  const input = view.getByLabelText("Go to line");
  await act(async () => {
    fireEvent.change(input, { target: { value: "999" } });
    fireEvent.keyDown(input, { key: "Enter", bubbles: true });
  });
  assert.equal(textarea.selectionStart, "line one\nline two\nline three\n".length); // clamped to the trailing (empty) last line
  await act(async () => {
    fireEvent.keyDown(textarea, { key: "g", ctrlKey: true, bubbles: true });
  });
  const input2 = view.getByLabelText("Go to line");
  await act(async () => {
    fireEvent.keyDown(input2, { key: "Escape", bubbles: true });
  });
  assert.equal(view.queryByLabelText("Go to line"), null);
});

test("syntax preview toggle is capped at 512 KB and swaps the pane", async () => {
  const small = renderEditor({ content: "const a = 1;\n" });
  const toggle = small.view.container.querySelector("button.file-editor-preview-toggle");
  assert.ok(toggle, "preview toggle rendered");
  assert.equal(toggle.disabled, false);
  await act(async () => { fireEvent.click(toggle); });
  assert.equal(small.view.container.querySelector("textarea.file-editor-textarea"), null);
  await act(async () => { fireEvent.click(small.view.container.querySelector("button.file-editor-preview-toggle")); });
  assert.ok(small.view.container.querySelector("textarea.file-editor-textarea"));
  small.view.unmount();

  const big = renderEditor({ content: "a".repeat(EDITOR_PREVIEW_MAX_BYTES + 1) });
  const bigToggle = big.view.container.querySelector("button.file-editor-preview-toggle");
  assert.equal(bigToggle.disabled, true);
});

test("a fresh baseline prop is adopted only while clean", async () => {
  const onSave = async () => ({ mtime: "2026-01-01T00:00:00.000Z", size: 1 });
  const props = (content) => ({
    filePath: "C:/proj/src/app.ts",
    language: "typescript",
    content,
    onSave,
  });
  const view = render(React.createElement(FileEditor, props("disk v1\n")));
  const textarea = view.getByRole("textbox");
  await act(async () => {
    fireEvent.change(textarea, { target: { value: "my local edit\n" } });
  });
  // Disk changed underneath a dirty editor: the baseline prop arrives but
  // must not clobber typing.
  await act(async () => {
    view.rerender(React.createElement(FileEditor, props("disk v2\n")));
  });
  assert.equal(textarea.value, "my local edit\n");
});
