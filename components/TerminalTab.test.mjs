import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import "../tests/setup-dom.mjs";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  jsx: { runtime: "automatic" },
  tsconfigPaths: true,
});

const TAB_SOURCE = readFileSync(new URL("./TerminalTab.tsx", import.meta.url), "utf8");
const RIGHT_PANEL_SOURCE = readFileSync(new URL("./RightPanel.tsx", import.meta.url), "utf8");
const { insertIntoComposer, onComposerInsert } = await jiti.import("@/lib/composer-insert");
const { buildTerminalInsertDetail } = await jiti.import("@/lib/terminal/select-insert");

// ─── source-contract assertions (P11) ────────────────────────────────────────

test("the select→composer seam is wired through the composer-insert bus", () => {
  assert.match(TAB_SOURCE, /import \{ insertIntoComposer \} from "@\/lib\/composer-insert"/);
  assert.match(TAB_SOURCE, /import \{ copyText \} from "@\/lib\/clipboard"/);
  // Insert builds the detail with the ACTIVE draft key + terminal source.
  assert.match(TAB_SOURCE, /insertIntoComposer\(\{\s*text,\s*draftKey: composerDraftKey \?\? undefined,\s*source: "terminal"/);
  // It fills the input only — TerminalTab never sends anything.
  assert.doesNotMatch(TAB_SOURCE, /onSend\(/);
  assert.doesNotMatch(TAB_SOURCE, /handleSend/);
});

test("insert is capped at 8 KB via the shared truncate helper", () => {
  assert.match(TAB_SOURCE, /import \{ TERMINAL_INSERT_MAX_BYTES, truncateToByteCap \} from "@\/lib\/terminal\/select-insert"/);
  assert.match(TAB_SOURCE, /truncateToByteCap\(selection, TERMINAL_INSERT_MAX_BYTES\)/);
  // Truncation is surfaced, never silent.
  assert.match(TAB_SOURCE, /terminal\.insertTruncated/);
});

test("the selection toolbar is gated on a live selection in a ready local terminal", () => {
  assert.match(TAB_SOURCE, /term\.onSelectionChange/);
  assert.match(TAB_SOURCE, /term\.hasSelection\(\)/);
  assert.match(TAB_SOURCE, /hasSelection && status === "ready" && mode\.kind === "local"/);
  assert.match(TAB_SOURCE, /t\("terminal\.selectionToolbar"\)/);
  // Both affordances exist; copy rides the clipboard lib.
  assert.match(TAB_SOURCE, /t\("terminal\.insertIntoComposer"\)/);
  assert.match(TAB_SOURCE, /t\("terminal\.copySelection"\)/);
});

test("resize forwarding is pty-gated and rides the input route", () => {
  // xterm resize events feed the forwarder…
  assert.match(TAB_SOURCE, /term\.onResize\(/);
  assert.match(TAB_SOURCE, /forwardResizeIfPty\(/);
  // …which refuses to send outside pty mode (the server no-ops anyway).
  assert.match(TAB_SOURCE, /if \(!ptyModeRef\.current\) return;/);
  // The payload is the additive input-route action.
  assert.match(TAB_SOURCE, /type: "resize", cols, rows/);
});

test("the banner states the ACTUAL mode; the TUI warning only in pipe mode", () => {
  // Mode comes from the create response, never an env guess client-side.
  assert.match(TAB_SOURCE, /data\.mode === "pty"/);
  assert.match(TAB_SOURCE, /ptyMode \? t\("terminal\.bannerTitlePty"\) : t\("terminal\.bannerTitle"\)/);
  assert.match(TAB_SOURCE, /ptyMode \? t\("terminal\.bannerBodyPty"\) : t\("terminal\.bannerBody"\)/);
  // The herdr escape-hatch hint belongs to pipe mode only.
  assert.match(TAB_SOURCE, /!ptyMode && !herdrEnabled/);
});

test("RightPanel passes the active composer draft key to the terminal", () => {
  assert.match(RIGHT_PANEL_SOURCE, /<TerminalTab cwd=\{activeCwd\} active=\{rightView === "terminal" && rightPanelOpen\} composerDraftKey=\{composerDraftKey\} \/>/);
});

// ─── live bus check ──────────────────────────────────────────────────────────

test("a terminal selection flows through the real composer-insert bus", () => {
  const seen = [];
  const unsubscribe = onComposerInsert((detail) => seen.push(detail));
  insertIntoComposer(buildTerminalInsertDetail("picked output", "sess-9"));
  insertIntoComposer(buildTerminalInsertDetail("no draft key"));
  unsubscribe();
  assert.equal(seen.length, 2);
  assert.deepEqual(seen[0], { text: "picked output", draftKey: "sess-9", source: "terminal" });
  assert.deepEqual(seen[1], { text: "no draft key", draftKey: undefined, source: "terminal" });
});
