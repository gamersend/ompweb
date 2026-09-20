import assert from "node:assert/strict";
import test from "node:test";

async function loadSubject() {
  return import("./placeholders.ts");
}

test("parses bare and braced placeholders in first-appearance order", async () => {
  const { parsePlaceholders } = await loadSubject();
  assert.deepEqual(parsePlaceholders("Review $TARGET and ${FILE_PATH} now"), ["TARGET", "FILE_PATH"]);
  // Ordered unique: repeats collapse, first position wins.
  assert.deepEqual(parsePlaceholders("$B then $A then ${B}"), ["B", "A"]);
  assert.deepEqual(parsePlaceholders("$A $B $A"), ["A", "B"]);
});

test("treats $$ as an escape, not a placeholder", async () => {
  const { parsePlaceholders } = await loadSubject();
  assert.deepEqual(parsePlaceholders("costs $$5 for $TARGET"), ["TARGET"]);
  assert.deepEqual(parsePlaceholders("$$TARGET is literal"), []);
  // $$ escapes only one dollar: the third $ still opens a placeholder.
  assert.deepEqual(parsePlaceholders("$$$NAME"), ["NAME"]);
});

test("ignores dollar sequences that do not open a placeholder", async () => {
  const { parsePlaceholders } = await loadSubject();
  assert.deepEqual(parsePlaceholders("$1 no digits first"), []);
  assert.deepEqual(parsePlaceholders("${unclosed stays literal"), []);
  assert.deepEqual(parsePlaceholders("${} empty is literal"), []);
  assert.deepEqual(parsePlaceholders("$ trailing-space"), []);
  assert.deepEqual(parsePlaceholders("no dollars at all"), []);
  assert.deepEqual(parsePlaceholders(""), []);
});

test("fill replaces known values, leaves unknown placeholders literal", async () => {
  const { fill } = await loadSubject();
  assert.equal(fill("Deploy $ENV to ${REGION}", { ENV: "prod", REGION: "eu-1" }), "Deploy prod to eu-1");
  // Empty string is a provided value, not an unknown one.
  assert.equal(fill("a=$A b=$B", { A: "", B: "x" }), "a= b=x");
  // Unknown names survive so the agent still sees the marker.
  assert.equal(fill("hi $WHO", {}), "hi $WHO");
  assert.equal(fill("hi $WHO", { OTHER: "x" }), "hi $WHO");
});

test("fill unescapes $$ to a literal dollar", async () => {
  const { fill } = await loadSubject();
  assert.equal(fill("costs $$5", {}), "costs $5");
  assert.equal(fill("$$NAME stays", {}), "$NAME stays");
  assert.equal(fill("$$NAME=$NAME", { NAME: "v" }), "$NAME=v");
});

test("fill and parsePlaceholders round-trip complex bodies", async () => {
  const { parsePlaceholders, fill } = await loadSubject();
  const body = "Review $TARGET.\nBudget: $$50\nScope: ${SCOPE}";
  assert.deepEqual(parsePlaceholders(body), ["TARGET", "SCOPE"]);
  const filled = fill(body, { TARGET: "lib/", SCOPE: "types" });
  assert.equal(filled, "Review lib/.\nBudget: $50\nScope: types");
  // An unclosed brace does not swallow the bare placeholder inside it.
  const tricky = "Focus: ${FOCUS:-none is fine $FOCUS";
  assert.deepEqual(parsePlaceholders(tricky), ["FOCUS"]);
  assert.equal(fill(tricky, { FOCUS: "types" }), "Focus: ${FOCUS:-none is fine types");
});
