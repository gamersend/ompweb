import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

// Redirect the agent dir BEFORE import so audit rows never land in the real
// ~/.omp/agent state.
const testRoot = mkdtempSync(join(tmpdir(), "omp-web-audit-"));
process.env.PI_CODING_AGENT_DIR = join(testRoot, "agent");

const jiti = createJiti(import.meta.url);
const {
  AUDIT_FILE_NAME,
  AUDIT_ROTATE_BYTES,
  appendTerminalAudit,
  terminalAuditPath,
} = await jiti.import("./audit.ts");

test("appendTerminalAudit writes JSONL metadata rows (never the payload)", () => {
  const file = terminalAuditPath();
  assert.equal(existsSync(file), false, "no file before the first append");
  appendTerminalAudit({
    ts: "2026-09-21T00:00:00.000Z",
    terminalId: "t-1",
    cwd: "C:/repo",
    bytes: 12,
    hash: "0123456789abcdef",
    kind: "input",
  });
  appendTerminalAudit({
    ts: "2026-09-21T00:00:01.000Z",
    terminalId: "t-1",
    cwd: "C:/repo",
    bytes: 3,
    hash: "fedcba9876543210",
  });
  assert.equal(existsSync(file), true);
  const lines = readFileSync(file, "utf8").trim().split("\n");
  assert.equal(lines.length, 2);
  const first = JSON.parse(lines[0]);
  assert.equal(first.terminalId, "t-1");
  assert.equal(first.bytes, 12);
  assert.equal(first.hash, "0123456789abcdef");
  assert.equal(first.kind, "input");
  // The rows never carry raw keystrokes — a typed password cannot leak into
  // the audit file.
  assert.equal(lines.join("\n").includes("password"), false);
});

test("appendTerminalAudit rotates at 1 MB keeping one .1 generation", () => {
  const file = terminalAuditPath();
  // Age the active file past the cap.
  writeFileSync(file, "x".repeat(AUDIT_ROTATE_BYTES + 1), "utf8");
  appendTerminalAudit({
    ts: "2026-09-21T00:00:02.000Z",
    terminalId: "t-2",
    cwd: "C:/repo",
    bytes: 1,
    hash: "aaaaaaaaaaaaaaaa",
  });
  const rotated = file + ".1";
  assert.equal(existsSync(rotated), true, "previous generation renamed to .1");
  assert.equal(readFileSync(rotated, "utf8").length, AUDIT_ROTATE_BYTES + 1);
  const lines = readFileSync(file, "utf8").trim().split("\n");
  assert.equal(lines.length, 1, "active file starts fresh after rotation");
  assert.equal(JSON.parse(lines[0]).terminalId, "t-2");
});

test("appendTerminalAudit tolerates a vanished agent dir", () => {
  // Point the agent dir somewhere that does not exist yet — the audit writer
  // creates it on demand and must never throw.
  rmSync(join(testRoot, "agent"), { recursive: true, force: true });
  assert.doesNotThrow(() => {
    appendTerminalAudit({
      ts: "2026-09-21T00:00:03.000Z",
      terminalId: "t-3",
      cwd: "C:/repo",
      bytes: 1,
      hash: "bbbbbbbbbbbbbbbb",
    });
  });
  assert.equal(existsSync(terminalAuditPath()), true);
  assert.match(terminalAuditPath(), new RegExp(`${AUDIT_FILE_NAME.replace(".", "\\.")}$`));
});
