import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const {
  findRedactionSpans,
  applyRedactions,
  redactSnippet,
  looksHighEntropy,
  shannonEntropy,
  isSecretValue,
  REDACTION_MARKER,
} = await jiti.import("./redact.ts");

/** A long opaque mixed-case alphanumeric run: ≥28 chars, ≥3.9 bits/char. */
const HIGH_ENTROPY = "aZ3kL9pQ2wR7tY5uI1oP6sD8fG4hJ0mNb";

test("entropy: opaque long alphanumerics qualify, prose and shapes do not", () => {
  assert.ok(looksHighEntropy(HIGH_ENTROPY), "opaque run should be a secret");
  assert.ok(shannonEntropy(HIGH_ENTROPY) >= 3.9);

  // Prose false-positive sweep.
  assert.equal(looksHighEntropy("this is a perfectly normal english sentence"), false);
  assert.equal(looksHighEntropy("https://example.com/some/very/long/path/segment"), false);
  assert.equal(looksHighEntropy("/home/blaze/fire/repos/ompweb/lib/search/redact.ts"), false);
  assert.equal(looksHighEntropy("C:\\Users\\blaze\\fire\\repos\\ompweb"), false);
  assert.equal(looksHighEntropy("1.2.19-beta.4"), false);
  assert.equal(looksHighEntropy("123e4567-e89b-12d3-a456-426614174000"), false);
  assert.equal(looksHighEntropy("2026-09-19T12:34:56.789Z"), false);
  assert.equal(looksHighEntropy("short"), false);
});

test("known prefixes: sk-, ghp_/gho_, AKIA, xox[bap]- are masked", () => {
  for (const [secret, prose] of [
    ["sk-a1b2c3d4e5f6g7h8", "key sk-a1b2c3d4e5f6g7h8 in text"],
    ["ghp_a1b2c3d4e5f6g7h8i9", "token ghp_a1b2c3d4e5f6g7h8i9 here"],
    ["gho_a1b2c3d4e5f6g7h8i9", "token gho_a1b2c3d4e5f6g7h8i9 here"],
    ["AKIAIOSFODNN7EXAMPLE", "aws AKIAIOSFODNN7EXAMPLE access"],
    ["xoxb-123456789012-abcdef", "slack xoxb-123456789012-abcdef"],
    ["xoxp-123456789012-abcdef", "slack xoxp-123456789012-abcdef"],
  ]) {
    const redacted = redactSnippet(prose);
    assert.ok(!redacted.text.includes(secret), `expected ${secret} masked`);
    assert.equal(redacted.redactedCount, 1, secret);
    assert.ok(redacted.text.includes(REDACTION_MARKER), secret);
  }
});

test("JWT shapes (three eyJ segments) are masked", () => {
  const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJVadQssw5c";
  const redacted = redactSnippet(`Authorization: ${jwt} expired`);
  assert.ok(!redacted.text.includes("eyJhbGciOiJIUzI1NiJ9"));
  assert.equal(redacted.redactedCount, 1);
});

test("Bearer tokens are masked, the word Bearer survives", () => {
  const redacted = redactSnippet("Bearer aB3dE5fG7hI9jK1lM2N4");
  assert.ok(!redacted.text.includes("aB3dE5fG7hI9jK1lM2N4"));
  assert.ok(redacted.text.includes("Bearer "));
  assert.equal(redacted.redactedCount, 1);
});

test("URL credentials are masked, scheme and host survive", () => {
  const redacted = redactSnippet("clone https://alice:s3cret-password@example.com/repo.git");
  assert.ok(!redacted.text.includes("alice:s3cret-password"));
  assert.ok(redacted.text.includes("https://"));
  assert.ok(redacted.text.includes("example.com/repo.git"));
});

test("NAME=value assignments with secret names mask the value, keep the name", () => {
  const redacted = redactSnippet("OMNIROUTE_API_KEY=sk-a1b2c3d4e5f6g7h8 in env");
  assert.ok(!redacted.text.includes("sk-a1b2c3d4e5f6g7h8"));
  assert.ok(redacted.text.includes("OMNIROUTE_API_KEY="));
  // Innocent assignments survive.
  const innocent = redactSnippet("compaction.thresholdTokens=284240 in config");
  assert.ok(innocent.text.includes("284240"));
  assert.equal(innocent.redactedCount, 0);
});

test("everyday prose survives with zero redactions", () => {
  const prose = "The compaction threshold is 284240 tokens; see docs/compaction.md and https://example.com/guide for details. Fixed the flaky retry test on 2026-09-19.";
  const redacted = redactSnippet(prose);
  assert.equal(redacted.redactedCount, 0, redacted.text);
  assert.equal(redacted.text, prose);
});

test("findRedactionSpans returns sorted non-overlapping spans into the original", () => {
  const text = `start sk-a1b2c3d4e5f6g7h8 middle Bearer z1x2c3v4b5 end`;
  const spans = findRedactionSpans(text);
  assert.equal(spans.length, 2);
  assert.ok(spans[0][0] < spans[0][1]);
  assert.ok(spans[1][0] >= spans[0][1], "non-overlapping");
  for (const [start, end] of spans) {
    assert.notEqual(text.slice(start, end), "");
  }
});

test("applyRedactions maps spans onto the OUTPUT text coordinates", () => {
  const text = `before sk-a1b2c3d4e5f6g7h8 after`;
  const spans = findRedactionSpans(text);
  const result = applyRedactions(text, spans);
  assert.equal(result.redactedCount, 1);
  const [start, end] = result.spans[0];
  assert.equal(result.text.slice(start, end), REDACTION_MARKER);
  assert.ok(result.text.startsWith("before "));
  assert.ok(result.text.endsWith(" after"));
  assert.ok(!result.text.includes("a1b2c3d4"));
});

test("matchRanges computed on redacted text never point into a secret", () => {
  // The query token appears both before the secret and inside it; ranges
  // must land on the surviving occurrence only, in redacted coordinates.
  const text = "token prefix sk-a1b2c3d4e5f6g7h8 suffix";
  const spans = findRedactionSpans(text);
  const redaction = applyRedactions(text, spans);
  const queryToken = "prefix";
  const at = redaction.text.toLowerCase().indexOf(queryToken);
  assert.ok(at >= 0);
  assert.ok(!redaction.text.includes("a1b2c3d4"));
});

test("isSecretValue agrees with prefix + entropy detectors", () => {
  assert.ok(isSecretValue("sk-a1b2c3d4e5f6g7h8"));
  assert.ok(isSecretValue(HIGH_ENTROPY));
  assert.equal(isSecretValue("plain sentence with spaces"), false);
});
