import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  alias: {
    "@/": new URL("../", import.meta.url).pathname,
  },
});
const { computeChatMatches, stepActiveIndex, CHAT_FIND_MIN_QUERY_LENGTH } = await jiti.import("./useChatFind.ts");

const user = (text) => ({ role: "user", content: text });
const assistant = (text) => ({ role: "assistant", provider: "t", model: "m", content: [{ type: "text", text }] });
const toolResultMsg = () => ({ role: "toolResult", toolCallId: "tc", content: [{ type: "text", text: "needle in tool output" }] });

test("computeChatMatches finds case-insensitive matches over user+assistant text only", () => {
  const messages = [
    user("where is the NEEDLE configured?"),
    assistant("The needle lives in config.yml."),
    toolResultMsg(),
    user("no match here"),
  ];
  const entryIds = ["e1", "e2", "e3", "e4"];
  const matches = computeChatMatches(messages, entryIds, "needle");
  assert.equal(matches.length, 2, "toolResult bodies are never searched");
  assert.deepEqual(matches[0], { entryId: "e1", messageIndex: 0, ranges: [[13, 19]] });
  assert.deepEqual(matches[1], { entryId: "e2", messageIndex: 1, ranges: [[4, 10]] });
});

test("computeChatMatches: every occurrence per message, empty for short queries", () => {
  const messages = [user("ab ab ab")];
  const matches = computeChatMatches(messages, ["e1"], "ab");
  assert.deepEqual(matches[0].ranges, [[0, 2], [3, 5], [6, 8]]);
  assert.equal(CHAT_FIND_MIN_QUERY_LENGTH, 2);
  assert.deepEqual(computeChatMatches(messages, ["e1"], "a"), []);
  assert.deepEqual(computeChatMatches(messages, ["e1"], "   "), []);
});

test("stepActiveIndex wraps around both directions and handles the cold start", () => {
  assert.equal(stepActiveIndex(-1, 3, 1), 0, "first next lands on 0");
  assert.equal(stepActiveIndex(-1, 3, -1), 2, "first prev wraps to the last");
  assert.equal(stepActiveIndex(2, 3, 1), 0, "next past the end wraps");
  assert.equal(stepActiveIndex(0, 3, -1), 2, "prev before the start wraps");
  assert.equal(stepActiveIndex(1, 3, 1), 2);
  assert.equal(stepActiveIndex(0, 0, 1), -1, "no matches");
});

test("the find bar keeps the shortcut, wrap-around, and hand-off wiring", async () => {
  const hook = await readFile(new URL("./useChatFind.ts", import.meta.url), "utf8");
  // Debounced match computation (150ms per the build plan).
  assert.match(hook, /setTimeout\(\(\) => setDebouncedQuery\(query\), 150\)/);
  // Stepping drives the shared anchor API (hl = first range).
  assert.match(hook, /anchorToRef\.current\(match\.entryId, \{ hl: match\.ranges\[0\] \}\)/);
  // "Search all sessions" hands off through the palette bus.
  assert.match(hook, /onSearchAllSessions\(query\.trim\(\)\)/);

  const shortcuts = await readFile(new URL("./useKeyboardShortcuts.ts", import.meta.url), "utf8");
  // Ctrl/Cmd+F registered globally; browser default stopped only when the
  // registered handler claims the key.
  assert.match(shortcuts, /registerFindHandler/);
  assert.match(shortcuts, /if \(!globalFindHandler\) return;\s*\n\s*if \(!globalFindHandler\(\)\) return;\s*\n\s*e\.preventDefault\(\);/);

  const chatWindow = await readFile(new URL("../components/ChatWindow.tsx", import.meta.url), "utf8");
  // ChatWindow registers the find handler and mounts the find bar.
  assert.match(chatWindow, /registerFindHandler\(\(\) => chatFindRef\.current\.handleFindShortcut\(\)\)/);
  assert.match(chatWindow, /<ChatFindBar/);
  assert.match(chatWindow, /onSearchAllSessions=\{chatFind\.canSearchAllSessions \? chatFind\.searchAllSessions : undefined\}/);
  // Enter / Shift+Enter step, Esc closes (keydown handler in ChatWindow).
  assert.match(chatWindow, /if \(event\.shiftKey\) chatFind\.previous\(\);/);
  assert.match(chatWindow, /else chatFind\.next\(\);/);
  assert.match(chatWindow, /chatFind\.close\(\);/);
});

test("the palette opens in Search mode via the bus with the handed-off query", async () => {
  const palette = await readFile(new URL("../components/CommandPalette.tsx", import.meta.url), "utf8");
  assert.match(palette, /PALETTE_MODE_STORAGE_KEY = "omp-web:palette-mode"/);
  // Search mode disables cmdk's own filtering (the server ranks).
  assert.match(palette, /shouldFilter=\{!isSearch\}/);
  assert.match(palette, /onOpenPalette\(\(detail\) =>/);
  assert.match(palette, /setQuery\(detail\.query \?\? ""\)/);

  const bus = await readFile(new URL("../lib/palette-bus.ts", import.meta.url), "utf8");
  assert.match(bus, /EVENT_NAME = "ompweb:open-palette"/);
});
