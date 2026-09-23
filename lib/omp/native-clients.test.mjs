import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const {
  EXTERNAL_CLIENTS_MAX_FILES,
  EXTERNAL_CLIENTS_MAX_PER_SCOPE,
  filterOwnedClients,
  getExternalOmpClients,
  parseClientFile,
  parseScopeFile,
  resetExternalClientsCacheForTests,
} = await jiti.import("./native-clients.ts");

// ============================================================================
// External omp client discovery (runs board bug 1): the read-only walk of
// omp's runtime registry (~/.omp/run/daemons/<hash>/clients/*.json).
//
// The fs + pid boundaries are injected everywhere — no test touches the real
// registry, no test process is ever signalled, and the source-pin at the
// bottom fails if this module ever grows a write call.
// ============================================================================

const MODULE_SOURCE = readFileSync(new URL("./native-clients.ts", import.meta.url), "utf8");

/** Registry root, built with the same path joining the module uses. */
const ROOT = join("/", "d", "daemons");

/** Virtual registry: dirs = { <abs dir>: [entry names] }, files = { <abs
 * file>: { text, mtimeMs } }. Directories are implied by the dirs map. */
function makeFs({ dirs = {}, files = {} } = {}) {
  const dirMap = new Map(Object.entries(dirs));
  const fileMap = new Map(Object.entries(files));
  return {
    readdir(dir) {
      const entries = dirMap.get(dir);
      if (!entries) {
        const error = new Error(`ENOENT: no such file or directory, scandir '${dir}'`);
        error.code = "ENOENT";
        throw error;
      }
      return entries.map((name) => ({ name, isDirectory: () => dirMap.has(join(dir, name)) }));
    },
    readFile(file) {
      const entry = fileMap.get(file);
      if (!entry) {
        const error = new Error(`ENOENT: no such file or directory, open '${file}'`);
        error.code = "ENOENT";
        throw error;
      }
      return entry.text;
    },
    mtimeMs(file) {
      const entry = fileMap.get(file);
      return entry ? entry.mtimeMs : null;
    },
  };
}

/** Client file contents exactly as omp writes them (shape verified live). */
const clientJson = (pid, id, projectDir) => JSON.stringify({ pid, id: id ?? `${pid}-uuid`, projectDir });
const scopeJson = (projectDir) => JSON.stringify({ projectDir });

/** One scope's tree: `<root>/<hash>/scope.json` plus `clients/*.json`. */
function scopeTree(hash, projectDir, clientFiles) {
  const scopeRoot = join(ROOT, hash);
  const clientsDir = join(scopeRoot, "clients");
  const dirs = {
    [scopeRoot]: ["clients", "scope.json"],
    [clientsDir]: clientFiles.map((client) => client.name),
  };
  const files = { [join(scopeRoot, "scope.json")]: { text: scopeJson(projectDir), mtimeMs: 1 } };
  for (const client of clientFiles) {
    files[join(clientsDir, client.name)] = { text: client.text, mtimeMs: client.mtimeMs };
  }
  return { dirs, files };
}

/** A whole registry root holding every listed scope. */
function registry(scopes) {
  const dirs = { [ROOT]: scopes.map((scope) => scope.hash) };
  const files = {};
  for (const scope of scopes) {
    const tree = scopeTree(scope.hash, scope.projectDir, scope.clients);
    Object.assign(dirs, tree.dirs);
    Object.assign(files, tree.files);
  }
  return { dirs, files };
}

const client = (pid, mtimeMs, extra = {}) => ({
  name: `${pid}-client.json`,
  text: clientJson(pid, `${pid}-uuid`, extra.projectDir),
  mtimeMs,
});

// ---------------------------------------------------------------------------
// Pure parsers
// ---------------------------------------------------------------------------

test("parseClientFile: parses a live registry client file (pid + id + projectDir)", () => {
  const record = parseClientFile('{"pid":38940,"id":"38940-dd5ef6ff-0fc9-4451-afc5-714395086a8f","projectDir":"C:\\\\Users\\\\blaze\\\\fire"}');
  assert.deepEqual(record, {
    pid: 38940,
    clientId: "38940-dd5ef6ff-0fc9-4451-afc5-714395086a8f",
    projectDir: "C:\\Users\\blaze\\fire",
  });
});

test("parseClientFile: malformed JSON, non-records, bad pids and missing ids are dropped", () => {
  assert.equal(parseClientFile("not json"), undefined);
  assert.equal(parseClientFile("[]"), undefined, "an array is not a client record");
  assert.equal(parseClientFile('"38940"'), undefined);
  assert.equal(parseClientFile('{"id":"38940-x"}'), undefined, "pid required");
  assert.equal(parseClientFile('{"pid":"38940","id":"38940-x"}'), undefined, "pid must be a number");
  assert.equal(parseClientFile('{"pid":0,"id":"0-x"}'), undefined);
  assert.equal(parseClientFile('{"pid":-4,"id":"-4-x"}'), undefined);
  assert.equal(parseClientFile('{"pid":12.5,"id":"12-x"}'), undefined, "pid must be an integer");
  assert.equal(parseClientFile('{"pid":9001}'), undefined, "id required");
  assert.equal(parseClientFile('{"pid":9001,"id":""}'), undefined);
  // projectDir is optional — a client file without one is still a client.
  assert.deepEqual(parseClientFile('{"pid":9001,"id":"9001-x"}'), { pid: 9001, clientId: "9001-x" });
});

test("parseScopeFile: projectDir required, garbage dropped", () => {
  assert.deepEqual(parseScopeFile(scopeJson("C:\\repo")), { projectDir: "C:\\repo" });
  assert.equal(parseScopeFile("{oops"), undefined);
  assert.equal(parseScopeFile('{"other":1}'), undefined);
  assert.equal(parseScopeFile('{"projectDir":""}'), undefined);
});

// ---------------------------------------------------------------------------
// Scan: sorting, liveness, scope fallback, malformed files
// ---------------------------------------------------------------------------

test("scan: newest first, dead pids excluded, scope.json fills a missing projectDir", () => {
  const tree = registry([{
    hash: "aaaaaaaaaaaaaaaa",
    projectDir: "C:/repo/alpha",
    clients: [
      client(300, 5_000),
      client(100, 9_000),
      // No projectDir of its own — the scope file must supply it.
      { name: "200-c.json", text: JSON.stringify({ pid: 200, id: "200-c" }), mtimeMs: 7_000 },
    ],
  }]);
  const result = getExternalOmpClients({
    rootDir: ROOT,
    fs: makeFs(tree),
    isPidAlive: (pid) => pid !== 300,
  });

  assert.equal(result.supported, true);
  assert.deepEqual(result.clients.map((found) => found.pid), [100, 200], "dead 300 dropped, newest first");
  assert.equal(result.clients[0].projectDir, "C:/repo/alpha");
  assert.equal(result.clients[1].projectDir, "C:/repo/alpha", "scope.json projectDir is the fallback");
  assert.equal(result.clients[0].startedAt, new Date(9_000).toISOString());
  assert.equal(result.clients[1].clientId, "200-c");
});

test("scan: a client file's own projectDir wins over the scope's", () => {
  const tree = registry([{
    hash: "bbbbbbbbbbbbbbbb",
    projectDir: "C:/repo/scope",
    clients: [client(10, 1_000, { projectDir: "C:/repo/own" })],
  }]);
  const result = getExternalOmpClients({ rootDir: ROOT, fs: makeFs(tree), isPidAlive: () => true });
  assert.equal(result.supported, true);
  assert.equal(result.clients[0].projectDir, "C:/repo/own");
});

test("scan: malformed, unreadable and non-json entries are ignored, never fatal", () => {
  const tree = registry([
    {
      hash: "cccccccccccccccc",
      projectDir: "C:/repo/gamma",
      clients: [
        { name: "1-a.json", text: "{not json", mtimeMs: 10 },
        { name: "2-b.json", text: '{"pid":"nope","id":"2-b"}', mtimeMs: 20 },
        { name: "3-c.json", text: '{"pid":3}', mtimeMs: 30 },
        { name: "4-d.json", text: clientJson(4, "4-d"), mtimeMs: 40 },
        { name: "5-e.json", text: clientJson(5, "5-e"), mtimeMs: 50 },
        // No projectDir of its own — the scope file supplies it (kept).
        { name: "6-f.json", text: JSON.stringify({ pid: 6, id: "6-f" }), mtimeMs: 60 },
      ],
    },
    {
      hash: "dddddddddddddddd",
      projectDir: "C:/repo/delta",
      clients: [
        // The scope.json is unreadable below: with no projectDir anywhere this
        // client cannot be labelled honestly and is dropped.
        { name: "7-g.json", text: JSON.stringify({ pid: 7, id: "7-g" }), mtimeMs: 70 },
        { name: "8-h.json", text: clientJson(8, "8-h", "C:/repo/own"), mtimeMs: 80 },
      ],
    },
  ]);
  // A stray non-.json entry at a scope's clients dir, an unparseable scope.json
  // and one file that vanishes between the directory listing and the read.
  tree.dirs[join(ROOT, "cccccccccccccccc", "clients")].push("notes.txt");
  tree.files[join(ROOT, "dddddddddddddddd", "scope.json")] = { text: "{broken", mtimeMs: 1 };
  const fs = makeFs(tree);
  const inner = fs.readFile;
  const result = getExternalOmpClients({
    rootDir: ROOT,
    fs: { ...fs, readFile: (file) => (file.endsWith("5-e.json") ? (() => { throw new Error("gone"); })() : inner(file)) },
    isPidAlive: () => true,
  });

  assert.equal(result.supported, true);
  // Newest first: 8-h has its own project, 6-f is labelled by its scope,
  // 4-d has its own project on the file. 1/2/3 are unparseable, 5-e vanished,
  // 7-g has no project anywhere.
  assert.deepEqual(result.clients.map((found) => found.pid), [8, 6, 4]);
  assert.equal(result.clients[0].projectDir, "C:/repo/own");
  assert.equal(result.clients[1].projectDir, "C:/repo/gamma");
});

test("scan: caps honour ≤20 per scope dir (newest kept) and ≤100 overall", () => {
  // Per-scope cap: one scope with 25 clients keeps the 20 newest.
  const soloFiles = [];
  for (let i = 0; i < 25; i += 1) soloFiles.push(client(i, i + 1));
  const solo = registry([{ hash: "solo", projectDir: "C:/repo/solo", clients: soloFiles }]);
  const soloResult = getExternalOmpClients({ rootDir: ROOT, fs: makeFs(solo), isPidAlive: () => true });

  assert.equal(soloResult.supported, true);
  assert.equal(EXTERNAL_CLIENTS_MAX_PER_SCOPE, 20);
  assert.equal(soloResult.clients.length, EXTERNAL_CLIENTS_MAX_PER_SCOPE, "per-scope cap");
  assert.deepEqual(
    soloResult.clients.map((found) => found.pid),
    [24, 23, 22, 21, 20, 19, 18, 17, 16, 15, 14, 13, 12, 11, 10, 9, 8, 7, 6, 5],
    "the five oldest files never appear",
  );

  // Overall cap: 7 scopes × 25 clients = 175 candidates → 100 rows.
  const scopes = [];
  for (let scope = 0; scope < 7; scope += 1) {
    const clients = [];
    for (let i = 0; i < 25; i += 1) clients.push(client(i + scope * 1000, i + 1));
    scopes.push({ hash: `scope${scope}`, projectDir: `C:/repo/s${scope}`, clients });
  }
  const result = getExternalOmpClients({ rootDir: ROOT, fs: makeFs(registry(scopes)), isPidAlive: () => true });

  assert.equal(result.supported, true);
  assert.equal(EXTERNAL_CLIENTS_MAX_FILES, 100);
  assert.equal(result.clients.length, EXTERNAL_CLIENTS_MAX_FILES, "overall cap");
  // Only files inside the newest-20 window of their scope can appear; the
  // overall cap is what stops the later scopes from adding rows.
  for (const found of result.clients) {
    const withinScope = found.pid % 1000;
    assert.ok(withinScope >= 5 && withinScope <= 24, `pid ${found.pid} is inside the newest-20 window`);
  }
  // Newest-first across the whole registry.
  const mtimes = result.clients.map((found) => Date.parse(found.startedAt));
  assert.deepEqual(mtimes, [...mtimes].sort((a, b) => b - a));
});

test("scan: missing registry → supported:false not_found; other fs errors degrade too", () => {
  const missing = getExternalOmpClients({ rootDir: join("/", "nope"), fs: makeFs(), isPidAlive: () => true });
  assert.deepEqual(missing, { supported: false, reason: "not_found" });

  const denied = getExternalOmpClients({
    rootDir: ROOT,
    fs: {
      readdir: () => {
        const error = new Error("EACCES: permission denied");
        error.code = "EACCES";
        throw error;
      },
      readFile: () => "",
      mtimeMs: () => null,
    },
  });
  assert.equal(denied.supported, false);
  assert.match(denied.reason, /EACCES/);
});

test("scan: a scope without a clients dir is skipped, not an error", () => {
  const globalScope = join(ROOT, "global");
  const result = getExternalOmpClients({
    rootDir: ROOT,
    fs: makeFs({ dirs: { [ROOT]: ["global"], [globalScope]: ["scope.json"] } }),
    isPidAlive: () => true,
  });
  assert.deepEqual(result, { supported: true, clients: [] });
});

test("filterOwnedClients: ompweb's own children are dropped, order preserved", () => {
  const clients = [
    { pid: 1, clientId: "1", projectDir: "C:/a", startedAt: "2026-09-23T00:00:00.000Z" },
    { pid: 2, clientId: "2", projectDir: "C:/b", startedAt: "2026-09-23T00:00:00.000Z" },
    { pid: 3, clientId: "3", projectDir: "C:/c", startedAt: "2026-09-23T00:00:00.000Z" },
  ];
  assert.deepEqual(filterOwnedClients(clients, [2]).map((found) => found.pid), [1, 3]);
  assert.deepEqual(filterOwnedClients(clients, new Set([1, 3])).map((found) => found.pid), [2]);
  assert.deepEqual(filterOwnedClients(clients, []).map((found) => found.pid), [1, 2, 3]);
  // Never mutates its input.
  assert.equal(clients.length, 3);
  assert.deepEqual(filterOwnedClients([], [1]), []);
});

test("getExternalOmpClients: no deps never throws and answers a Tier-B shape", () => {
  resetExternalClientsCacheForTests();
  const first = getExternalOmpClients();
  assert.equal(typeof first.supported, "boolean");
  if (first.supported) {
    assert.ok(Array.isArray(first.clients));
    for (const found of first.clients) {
      assert.equal(typeof found.pid, "number");
      assert.equal(typeof found.clientId, "string");
      assert.equal(typeof found.projectDir, "string");
      assert.equal(typeof found.startedAt, "string");
    }
  } else {
    assert.equal(typeof first.reason, "string");
  }
  // Second call inside the 5 s window is the cache — same verdict, no throw.
  const second = getExternalOmpClients();
  assert.deepEqual(second, first);
  // Callers cannot poison the cache through the returned array.
  if (second.supported) second.clients.push({ pid: -1, clientId: "junk", projectDir: "", startedAt: "" });
  assert.deepEqual(getExternalOmpClients(), first);
  resetExternalClientsCacheForTests();
});

// ---------------------------------------------------------------------------
// Read-only source pin: this module may never write anywhere (the registry is
// omp's, and the board is an observation surface).
// ---------------------------------------------------------------------------

test("source pin: the module has no write path (fs writes / mkdir / chmod / signalling)", () => {
  const writeCall = /\b(?:writeFileSync|writeFile|appendFileSync|appendFile|renameSync|rmSync|rmdirSync|unlinkSync|truncateSync|writeSync|createWriteStream|mkdirSync|chmodSync|copyFileSync|symlinkSync)\b/;
  assert.equal(writeCall.test(MODULE_SOURCE), false, "no fs write call may exist in native-clients.ts");
  // Liveness probing is `process.kill(pid, 0)` only — a signal-carrying call
  // (a real kill) is forbidden, as is any process-control API.
  const killCalls = MODULE_SOURCE.match(/process\.kill\([^)]*\)/g) ?? [];
  assert.ok(killCalls.length >= 1, "the liveness probe exists");
  for (const call of killCalls) {
    assert.equal(call.replace(/\s+/g, " "), "process.kill(pid, 0)", "only the signal-less 0 probe is allowed");
  }
  assert.doesNotMatch(MODULE_SOURCE, /\b(?:execFile|execSync|spawnSync|spawn|fork|taskkill|SIGTERM|SIGKILL)\b/);
  assert.doesNotMatch(MODULE_SOURCE, /@oh-my-pi|@earendil-works/);
  // The registry it reads is named exactly once, under the config root.
  assert.match(MODULE_SOURCE, /join\(getConfigRoot\(\), "run", "daemons"\)/);
});
