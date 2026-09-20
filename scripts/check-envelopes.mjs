// Wave-3 P1 parity gate (R3-29): every JSON response in app/api/**/route.ts
// must carry the shared envelope — `{ success: ... }` on the happy path or
// `{ error: ... }` / `{ success: false, error: ... }` on failures. Binary and
// stream responses (audio, HTML export, SSE) do not apply and are skipped via
// the explicit allowlist below.
//
// The repo predates the envelope convention on ~30 legacy route files; those
// are recorded in scripts/envelope-baseline.json as a RATCHET: the gate fails
// when a NEW route file carries an unwrapped JSON response, or when a baselined
// file gains ADDITIONAL violations. Legacy files may be migrated freely — the
// baseline shrinks with `node scripts/check-envelopes.mjs --update-baseline`.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("../", import.meta.url));
const apiRoot = join(repoRoot, "app", "api");
const baselinePath = join(repoRoot, "scripts", "envelope-baseline.json");

/** Routes with non-JSON responses (checked by their own tests instead). */
const ALLOWLIST = new Set([
  // audio proxy — binary mp3 / passthrough
  "tts",
  // HTML export / file download / SSE streams live in these trees
  "sessions-export",
  "bash-output",
]);

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (entry === "route.ts") out.push(full);
  }
  return out;
}

// Every `NextResponse.json(<first argument>` call site in a route file. The
// first argument must mention `success` or `error` (a literal object, a
// ternary of such objects, or a variable whose name says what it carries).
// Binary/stream returns (`new Response(`, `new NextResponse(`) are ignored.
function countViolations(source) {
  let count = 0;
  const re = /NextResponse\.json\(\s*([\s\S]{0,400}?)(?:,\s*\{[^}]*\}\s*\)|\))/g;
  let match;
  while ((match = re.exec(source)) !== null) {
    if (!/\bsuccess\b|\berror\b/.test(match[1])) count += 1;
  }
  return count;
}

const routeFiles = walk(apiRoot).filter((file) => {
  const rel = file.slice(apiRoot.length).replaceAll("\\", "/");
  const top = rel.split("/")[0];
  return !ALLOWLIST.has(top);
});

const current = new Map();
for (const file of routeFiles) {
  const rel = file.slice(apiRoot.length).replaceAll("\\", "/");
  const count = countViolations(readFileSync(file, "utf8"));
  if (count > 0) current.set(rel, count);
}

const updateBaseline = process.argv.includes("--update-baseline");
if (updateBaseline) {
  const sorted = Object.fromEntries([...current.entries()].sort(([a], [b]) => a.localeCompare(b)));
  const entries = Object.entries(sorted);
  writeFileSync(baselinePath, `${JSON.stringify(sorted, null, 2)}\n`, "utf8");
  console.log(`baseline updated — ${entries.length} legacy route file(s), ${entries.reduce((a, [, count]) => a + count, 0)} known violations`);
  process.exit(0);
}

const baseline = existsSync(baselinePath)
  ? JSON.parse(readFileSync(baselinePath, "utf8"))
  : {};

const failures = [];
for (const [rel, count] of current) {
  const known = baseline[rel];
  if (known === undefined) failures.push(`NEW unwrapped responses in ${rel} (${count}) — wrap in { success, data } / { error, code }`);
  else if (count > known) failures.push(`${rel} regressed: ${count} unwrapped responses (baseline ${known})`);
}
for (const rel of Object.keys(baseline)) {
  if (!current.has(rel)) console.log(`baseline cleanup available: ${rel} now conforms (remove from baseline via --update-baseline)`);
}

if (failures.length > 0) {
  console.error(`envelope parity FAILED — ${failures.length} problem(s):`);
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
const known = Object.values(baseline).reduce((a, b) => a + b, 0);
console.log(`envelope parity OK — ${routeFiles.length} route files checked, ${known} ratcheted legacy violations, 0 new`);
