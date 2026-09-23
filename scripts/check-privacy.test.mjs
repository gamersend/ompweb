import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { ALLOWLIST, CATEGORIES, DEFAULT_ROOTS, scanRoots } from "./check-privacy.mjs";

// ============================================================================
// P22.3 — pins the static privacy audit itself:
//   1. the audit runs CLEAN on the current tree (exit 0);
//   2. every allowlist entry is real (a detector hit exists behind it) and
//      reasoned — no stale or over-broad entries;
//   3. each category's detector catches a synthetic violation in a temp
//      fixture tree, and leaves clean files alone.
// ============================================================================

const scriptPath = fileURLToPath(new URL("./check-privacy.mjs", import.meta.url));
const repoRoot = fileURLToPath(new URL("../", import.meta.url));



test("audit runs clean on the current tree (exit 0)", () => {
  const run = spawnSync(process.execPath, [scriptPath], { cwd: repoRoot, encoding: "utf8" });
  assert.equal(run.status, 0, `audit failed:\n${run.stdout}\n${run.stderr}`);
  assert.match(run.stdout, /privacy audit OK/);
});

test("allowlist integrity: every entry is reasoned and backed by a real detector hit", () => {
  for (const entry of ALLOWLIST) {
    assert.ok(entry.reason && entry.reason.length > 20, `allowlist entry needs a real reason: ${entry.file}`);
    assert.ok(CATEGORIES.includes(entry.category), `unknown category ${entry.category}`);
  }
  // Probe with the explicit allowlist disabled: every raw finding must map
  // back to an allowlist entry (1:1), and the should-be-zero categories must
  // stay zero even without the allowlist.
  const raw = scanRoots(repoRoot, DEFAULT_ROOTS, { bypassAllowlist: true });
  const zeroCategories = CATEGORIES.filter((category) => !ALLOWLIST.some((entry) => entry.category === category));
  for (const finding of raw) {
    const backed = ALLOWLIST.some((entry) =>
      entry.category === finding.category
      && entry.file === finding.rel
      && (entry.match === null || finding.text.includes(entry.match)));
    assert.ok(backed, `unbacked finding (stale detector or missing allowlist entry): ${finding.category} ${finding.rel}:${finding.line}`);
  }
  for (const category of zeroCategories) {
    assert.equal(raw.filter((finding) => finding.category === category).length, 0,
      `${category} must stay at zero hits`);
  }
  // match:null (whole-file) entries must still name files that DO trip the
  // detector — otherwise the entry is stale and should be removed.
  for (const entry of ALLOWLIST.filter((item) => item.match === null)) {
    assert.ok(raw.some((finding) => finding.category === entry.category && finding.rel === entry.file),
      `stale whole-file allowlist entry: ${entry.category} ${entry.file}`);
  }
});

test("each detector catches a synthetic violation; clean files stay silent", () => {
  const tmp = mkdtempSync(join(tmpdir(), "omp-web-privacy-"));
  try {
    mkdirSync(join(tmp, "lib"), { recursive: true });
    mkdirSync(join(tmp, "app", "api", "live", "fake"), { recursive: true });

    // 1. forbidden import
    writeFileSync(join(tmp, "lib", "bad-import.mjs"), 'import { x } from "@oh-my-pi/fake";\n', "utf8");
    // 2. write call near an omp-owned path literal (stats.db)
    writeFileSync(
      join(tmp, "lib", "bad-write.mjs"),
      'import { writeFileSync } from "node:fs";\nconst statsDbPath = "/tmp/stats.db";\nwriteFileSync(statsDbPath, "x");\n',
      "utf8",
    );
    // 3. secret-shaped text in a console call
    writeFileSync(join(tmp, "lib", "bad-log.mjs"), 'console.log("using api_key=supersecret123");\n', "utf8");
    // 4. budget-enforcement wording
    writeFileSync(join(tmp, "lib", "bad-budget.mjs"), "// TODO: add a spend cap here\n", "utf8");
    // 5. publish command
    writeFileSync(join(tmp, "lib", "bad-publish.mjs"), 'execSync("npm publish");\n', "utf8");
    // 6. live-media under app/api (server route touching media APIs)
    writeFileSync(join(tmp, "app", "api", "live", "fake", "route.ts"), 'const kind = "getUserMedia";\n', "utf8");
    // 7. clean control file
    writeFileSync(join(tmp, "lib", "clean.mjs"), "export const fine = 1;\n", "utf8");

    const findings = scanRoots(tmp, ["lib", "app"]);
    const hit = (category, rel) => findings.some(
      (finding) => finding.category === category && finding.rel === rel.replaceAll("\\", "/"),
    );

    assert.ok(hit("forbidden-imports", "lib/bad-import.mjs"), "@oh-my-pi import must be flagged");
    assert.ok(hit("omp-owned-writes", "lib/bad-write.mjs"), "write near stats.db must be flagged");
    assert.ok(hit("secrets-in-logs", "lib/bad-log.mjs"), "console line with api_key must be flagged");
    assert.ok(hit("budget-enforcement", "lib/bad-budget.mjs"), "spend-cap wording must be flagged");
    assert.ok(hit("npm-publish", "lib/bad-publish.mjs"), "npm publish must be flagged");
    assert.ok(hit("live-media-server", join("app", "api", "live", "fake", "route.ts")), "getUserMedia in app/api must be flagged");

    assert.ok(!findings.some((finding) => finding.rel.endsWith("clean.mjs")), "clean file must not be flagged");
    // The repo allowlist is file-scoped — none of it may swallow temp findings.
    assert.ok(findings.length >= 6, "every synthetic violation should yield a finding");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
