import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createJiti } from "jiti";

// Throwaway agent dir + resolvable omp bin BEFORE the modules load. The exec
// seam is injected everywhere — node.exe is only ever a placeholder path for
// resolveOmpBin; nothing real is ever spawned.
const testRoot = mkdtempSync(join(tmpdir(), "omp-web-native-jobs-"));
process.env.PI_CODING_AGENT_DIR = join(testRoot, "agent");
if (!existsSync(process.execPath)) throw new Error("node executable missing for placeholder OMP_WEB_OMP_BIN");
process.env.OMP_WEB_OMP_BIN = process.execPath;

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const {
  NATIVE_JOBS_TIMEOUT_MS,
  getJobs,
  getProcesses,
  getCollabPeers,
  parseJobsOutput,
  parseProcessesOutput,
  parseCollabOutput,
  setNativeJobsExecForTests,
  resetNativeJobsCacheForTest,
} = await jiti.import("./native-jobs.ts");

// ============================================================================
// Native jobs/processes/peers adapters (wave 3 P14.1, R3-13 + R3-23):
// READ-ONLY omp CLI shelling with fixed argv + Tier B degrade. Tests NEVER
// shell the real binary — the exec boundary is swapped via
// setNativeJobsExecForTests. No stop/kill/restart shape exists anywhere in
// this module; the route source-pin below enforces the read-only contract.
// ============================================================================

/** Exec recorder: counts calls, returns a canned stdout (or throws). */
function makeRecorder(stdout, { fail = false, error } = {}) {
  const calls = [];
  const impl = async (bin, args, timeoutMs) => {
    calls.push({ bin, args, timeoutMs });
    if (fail) throw error ?? new Error("omp: unknown flag: --json");
    return typeof stdout === "function" ? stdout(args) : stdout;
  };
  return { calls, impl };
}

function reset() {
  resetNativeJobsCacheForTest();
}

// ---------------------------------------------------------------------------
// Pure parsers: shape acceptance, id-required, unknown-field drop.
// ---------------------------------------------------------------------------

test("parse jobs: bare array + {jobs} shape, id/jobId required, unknown fields dropped, ageMs null passthrough", () => {
  const rows = parseJobsOutput(JSON.stringify([
    { id: "job-a", status: "running", owner: "web", ageMs: 42_000, summary: "build", secretField: "drop-me" },
    { jobId: "job-b", status: "queued", ageMs: null },
    { status: "no id here" },
    "garbage",
    null,
  ]));
  assert.equal(rows.length, 2, "rows without an id are dropped");
  assert.deepEqual(Object.keys(rows[0]).sort(), ["ageMs", "id", "owner", "status", "summary"], "unknown fields dropped");
  assert.equal(rows[1].id, "job-b", "jobId alias accepted");
  assert.equal(rows[1].ageMs, null, "source-provided null age stays null (never estimated)");

  const wrapped = parseJobsOutput(JSON.stringify({ jobs: [{ id: "job-c" }], unrelated: true }));
  assert.equal(wrapped.length, 1);
  assert.equal(wrapped[0].id, "job-c");
});

test("parse jobs: invalid JSON / wrong shapes → empty, never throws", () => {
  assert.deepEqual(parseJobsOutput("{not json"), []);
  assert.deepEqual(parseJobsOutput('{"jobs": "nope"}'), []);
  assert.deepEqual(parseJobsOutput('{"jobs": [null, 42, {}]}'), []);
  assert.deepEqual(parseJobsOutput(""), []);
});

test("parse processes: {processes} shape, id aliases, pid confirmed-identity rule, unknown fields dropped", () => {
  const rows = parseProcessesOutput(JSON.stringify({
    processes: [
      { id: "relay", kind: "service", status: "running", pid: 4242, ageMs: 90_000, secret: "drop" },
      { name: "unnamed-worker", status: "stopped", pid: null },
      { processId: "third", pid: "not-a-number", ageMs: "soon" },
      { status: "running" },
    ],
  }));
  assert.equal(rows.length, 3, "rows without any id alias are dropped");
  const [a, b, c] = rows;
  assert.deepEqual(Object.keys(a).sort(), ["ageMs", "id", "kind", "pid", "status"]);
  assert.equal(a.pid, 4242, "confirmed finite pid is carried");
  assert.equal(b.id, "unnamed-worker", "name alias accepted");
  assert.equal(b.pid, null, "source-explicit null pid stays null — never fabricated");
  assert.equal(c.id, "third");
  assert.equal(c.pid, undefined, "non-numeric pid is dropped, not guessed");
  assert.equal(c.ageMs, undefined, "non-numeric ageMs is dropped");
});

test("parse processes: bare array + invalid shapes → safe", () => {
  assert.equal(parseProcessesOutput(JSON.stringify([{ id: "x", pid: 1 }]))[0].id, "x");
  assert.deepEqual(parseProcessesOutput("nope"), []);
  assert.deepEqual(parseProcessesOutput('{"processes": 7}'), []);
});

test("parse collab: observed {version, hosts} shape plus peers/bare-array fallbacks, id aliases, lastSeen string|number", () => {
  const observed = parseCollabOutput(JSON.stringify({
    version: 1,
    hosts: [
      { instanceId: "inst-1", name: "beast", role: "host", lastSeen: "2026-09-21T00:00:00Z" },
      { hostId: "inst-2", role: "guest", lastSeen: 1_758_000_000_000 },
      { name: "no id" },
    ],
  }));
  assert.equal(observed.length, 2);
  assert.equal(observed[0].id, "inst-1");
  assert.equal(observed[1].id, "inst-2", "hostId alias accepted");
  assert.equal(observed[1].lastSeen, 1_758_000_000_000, "numeric lastSeen kept");

  const peersShape = parseCollabOutput(JSON.stringify({ peers: [{ id: "p1" }] }));
  assert.equal(peersShape[0].id, "p1");
  const bare = parseCollabOutput(JSON.stringify([{ id: "p2" }]));
  assert.equal(bare[0].id, "p2");
  assert.deepEqual(parseCollabOutput(""), []);
});

// ---------------------------------------------------------------------------
// Adapters: fixed argv, 5s timeout, Tier-B degrade, caches.
// ---------------------------------------------------------------------------

test("fixed argv for all three probes: exactly [jobs --json] / [ps --json] / [collab --json] at 5s", async () => {
  reset();
  const { calls, impl } = makeRecorder("[]");
  setNativeJobsExecForTests(impl);
  try {
    await getJobs();
    await getProcesses({ refresh: true });
    await getCollabPeers({ refresh: true });
    assert.equal(calls.length, 3);
    assert.deepEqual(calls[0].args, ["jobs", "--json"], "jobs argv is exactly the fixed contract");
    assert.deepEqual(calls[1].args, ["ps", "--json"], "ps argv is exactly the fixed contract");
    assert.deepEqual(calls[2].args, ["collab", "--json"], "collab argv is exactly the fixed contract");
    for (const call of calls) {
      assert.equal(call.timeoutMs, NATIVE_JOBS_TIMEOUT_MS);
      assert.ok(call.bin, "bin resolved from the placeholder env");
    }
  } finally {
    setNativeJobsExecForTests(null);
  }
});

test("degrade: CLI error → {unsupported:true, reason}; the negative verdict is NEVER re-guessed (permanent until refresh)", async () => {
  reset();
  const { calls, impl } = makeRecorder("", { fail: true, error: new Error("omp: unknown flag: --json") });
  setNativeJobsExecForTests(impl);
  try {
    const first = await getJobs();
    assert.equal(first.unsupported, true);
    assert.equal(typeof first.reason, "string");
    assert.ok(first.reason.length > 0);
    assert.equal(calls.length, 1);

    const second = await getJobs();
    assert.equal(second.unsupported, true);
    assert.equal(second.reason, first.reason, "cached reason is replayed");
    assert.equal(calls.length, 1, "the failed probe is cached, never re-run");

    const refreshed = await getJobs({ refresh: true });
    assert.equal(refreshed.unsupported, true);
    assert.equal(calls.length, 2, "refresh explicitly re-probes (omp may have been updated)");

    // Each section degrades independently — ps/collab keep their own caches.
    reset();
    const ps = await getProcesses();
    assert.equal(ps.unsupported, true);
    const psAgain = await getProcesses();
    assert.equal(psAgain.unsupported, true);
    assert.equal(calls.length, 3, "ps degrade cached independently");
    const collab = await getCollabPeers();
    assert.equal(collab.unsupported, true);
    assert.equal(calls.length, 4);
  } finally {
    setNativeJobsExecForTests(null);
  }
});

test("collab unsupported case: a failing collab CLI returns the unsupported object, never an array and never a throw", async () => {
  reset();
  const { impl } = makeRecorder("", { fail: true });
  setNativeJobsExecForTests(impl);
  try {
    const section = await getCollabPeers();
    assert.ok(!Array.isArray(section), "unsupported sections are objects, not arrays");
    assert.equal(section.unsupported, true);
    assert.equal(typeof section.reason, "string");
  } finally {
    setNativeJobsExecForTests(null);
  }
});

test("60s positive cache: repeat calls share one probe; expiry and refresh re-probe", async () => {
  reset();
  const { calls, impl } = makeRecorder(JSON.stringify({ processes: [{ id: "w1", pid: 7 }] }));
  setNativeJobsExecForTests(impl);
  try {
    const first = await getProcesses();
    assert.deepEqual(first, [{ id: "w1", pid: 7 }]);
    const second = await getProcesses();
    assert.equal(calls.length, 1, "60s cache serves the second call");
    assert.deepEqual(second, first);

    // Backdate the cache entry past the TTL (no real waiting).
    const cacheMap = globalThis.__ompNativeJobsCache;
    const entry = cacheMap.get("ps");
    assert.ok(entry, "cache entry lives on globalThis");
    assert.equal(entry.supported, true);
    entry.ts = Date.now() - 61_000;

    await getProcesses();
    assert.equal(calls.length, 2, "expired entry re-probes");

    await getProcesses({ refresh: true });
    assert.equal(calls.length, 3, "refresh bypasses a fresh cache too");
  } finally {
    setNativeJobsExecForTests(null);
  }
});

test("in-flight dedupe: two concurrent misses share ONE probe", async () => {
  reset();
  const calls = [];
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  setNativeJobsExecForTests(async (bin, args, timeoutMs) => {
    calls.push({ bin, args, timeoutMs });
    await gate;
    return JSON.stringify({ jobs: [{ id: "j1" }] });
  });
  try {
    const p1 = getJobs();
    const p2 = getJobs();
    release();
    const [r1, r2] = await Promise.all([p1, p2]);
    assert.equal(calls.length, 1, "the second caller joined the in-flight probe");
    assert.deepEqual(r1, [{ id: "j1" }]);
    assert.deepEqual(r2, [{ id: "j1" }]);
  } finally {
    setNativeJobsExecForTests(null);
  }
});

// ---------------------------------------------------------------------------
// Source-pin: /api/jobs is GET-only (read-only contract) with the envelope.
// ---------------------------------------------------------------------------

test("source-pin: app/api/jobs/route.ts exports GET only + {success,data} envelope + no-store + read-only note", () => {
  const routePath = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "app", "api", "jobs", "route.ts");
  const source = readFileSync(routePath, "utf8");
  assert.match(source, /export async function GET\(/, "GET handler present");
  assert.doesNotMatch(source, /export async function (POST|PUT|DELETE|PATCH)\(/, "NO mutation handlers exist");
  assert.match(source, /success: true/, "envelope present");
  assert.match(source, /Cache-Control": "no-store/, "no-store caching");
  assert.match(source, /read-only/i, "wire note documents read-only-ness");
  assert.match(source, /from "@\/lib\/omp\/native-jobs"/, "backed by the native-jobs adapters");
});

test("cleanup", () => {
  setNativeJobsExecForTests(null);
  resetNativeJobsCacheForTest();
  delete process.env.OMP_WEB_OMP_BIN;
  rmSync(testRoot, { recursive: true, force: true });
});
