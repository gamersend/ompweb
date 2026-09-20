import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const {
  MEM0_DEFAULT_BASE,
  MEM0_DEFAULT_USER,
  MEM0_TIMEOUT_MS,
  MEM0_DEADLINE_MS,
  MEM0_MAX_LIMIT,
  Mem0Error,
  resolveMem0Config,
  searchMemory,
  writeMemoryNote,
  probeMem0Health,
  splitMemoryCards,
} = await jiti.import("./memory/mem0.ts");

const SOURCE = readFileSync(new URL("./memory/mem0.ts", import.meta.url), "utf8");
const BASE = "https://mem0.test.example";

// ─── source-contract: the timing contract is the extension's, verbatim ──────

test("client keeps the extension's timing contract (20s abort, 22s deadline)", () => {
  assert.equal(MEM0_TIMEOUT_MS, 20_000);
  assert.equal(MEM0_DEADLINE_MS, 22_000);
  assert.match(SOURCE, /MEM0_TIMEOUT_MS = 20_000/);
  assert.match(SOURCE, /MEM0_DEADLINE_MS = 22_000/);
  // Every upstream call must carry the abort signal.
  const abortCount = (SOURCE.match(/AbortSignal\.timeout\(MEM0_TIMEOUT_MS\)/g) ?? []).length;
  assert.ok(abortCount >= 2, "search/note/health must all use AbortSignal.timeout");
  // Never logs bodies, never writes to disk.
  assert.doesNotMatch(SOURCE, /console\.(log|info|debug)/);
  assert.doesNotMatch(SOURCE, /writeFile|appendFile|createWriteStream/);
});

// ─── config resolution ───────────────────────────────────────────────────────

test("resolveMem0Config defaults to the extension's base and user", () => {
  const config = resolveMem0Config({});
  assert.equal(config.base, MEM0_DEFAULT_BASE);
  assert.equal(config.base, "https://mem0.u.red.mba");
  assert.equal(config.user, MEM0_DEFAULT_USER);
  assert.equal(config.user, "blaze");
  assert.equal(config.enabled, true);
});

test("resolveMem0Config strips trailing slashes from OMP_MEM0_URL", () => {
  assert.equal(resolveMem0Config({ OMP_MEM0_URL: "http://127.0.0.1:8800/" }).base, "http://127.0.0.1:8800");
  assert.equal(resolveMem0Config({ OMP_MEM0_URL: "http://127.0.0.1:8800///" }).base, "http://127.0.0.1:8800");
});

test("resolveMem0Config disables on the kill switch or an explicitly empty URL", () => {
  assert.equal(resolveMem0Config({ OMP_WEB_DISABLE_MEMORY: "1" }).enabled, false);
  // Kill switch wins even with a URL present; base falls back to the default.
  const killed = resolveMem0Config({ OMP_WEB_DISABLE_MEMORY: "1", OMP_MEM0_URL: "http://x" });
  assert.equal(killed.enabled, false);
  assert.equal(killed.base, MEM0_DEFAULT_BASE);
  // Explicitly empty URL = not configured (distinct from unset).
  assert.equal(resolveMem0Config({ OMP_MEM0_URL: "" }).enabled, false);
  assert.equal(resolveMem0Config({ OMP_MEM0_URL: "   " }).enabled, false);
  assert.equal(resolveMem0Config({}).enabled, true);
});

test("resolveMem0Config reads OMP_MEM0_USER with a blaze fallback", () => {
  assert.equal(resolveMem0Config({ OMP_MEM0_USER: "hermes" }).user, "hermes");
  assert.equal(resolveMem0Config({ OMP_MEM0_USER: "  " }).user, "blaze");
});

// ─── search contract (injected fetch) ────────────────────────────────────────

function okResponse(body, status = 200) {
  return { ok: status < 400, status, text: async () => typeof body === "string" ? body : JSON.stringify(body) };
}

test("searchMemory POSTs the extension's /search payload", async () => {
  const calls = [];
  const fetchImpl = async (input, init) => {
    calls.push({ input, init });
    return okResponse({ result: "- found it" });
  };
  const text = await searchMemory({ base: BASE, user: "blaze", enabled: true }, "lan registry", { fetchImpl });
  assert.equal(text, "- found it");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].input, `${BASE}/search`);
  assert.equal(calls[0].init.method, "POST");
  assert.equal(calls[0].init.headers["Content-Type"], "application/json");
  assert.deepEqual(JSON.parse(calls[0].init.body), { query: "lan registry", user_id: "blaze", limit: 10 });
});

test("searchMemory honors the user override and clamps limit", async () => {
  const bodies = [];
  const fetchImpl = async (input, init) => {
    bodies.push(JSON.parse(init.body));
    return okResponse({ result: "x" });
  };
  const config = { base: BASE, user: "blaze", enabled: true };
  await searchMemory(config, "q", { fetchImpl, user: "hermes", limit: 999 });
  await searchMemory(config, "q", { fetchImpl, limit: 0 });
  assert.equal(bodies[0].user_id, "hermes");
  assert.equal(bodies[0].limit, MEM0_MAX_LIMIT);
  assert.equal(bodies[1].limit, 1);
});

test("searchMemory falls back through result/written/error/raw like the extension", async () => {
  const config = { base: BASE, user: "u", enabled: true };
  const fetchImpl = async () => okResponse("plain text body");
  assert.equal(await searchMemory(config, "q", { fetchImpl }), "plain text body");
  const noteShape = async () => okResponse({ written: "/vault/note.md" });
  assert.equal(await searchMemory(config, "q", { fetchImpl: noteShape }), "/vault/note.md");
});

test("searchMemory maps upstream failures to stable error codes", async () => {
  const config = { base: BASE, user: "u", enabled: true };
  await assert.rejects(
    searchMemory(config, "q", { fetchImpl: async () => okResponse({ error: "error: nope" }) }),
    (e) => e instanceof Mem0Error && e.code === "memory_bad_request",
  );
  await assert.rejects(
    searchMemory(config, "q", { fetchImpl: async () => okResponse("error: exploded") }),
    (e) => e instanceof Mem0Error && e.code === "memory_bad_request",
  );
  await assert.rejects(
    searchMemory(config, "q", { fetchImpl: async () => okResponse("nope", 400) }),
    (e) => e instanceof Mem0Error && e.code === "memory_bad_request",
  );
  await assert.rejects(
    searchMemory(config, "q", { fetchImpl: async () => okResponse("boom", 500) }),
    (e) => e instanceof Mem0Error && e.code === "memory_unreachable",
  );
  await assert.rejects(
    searchMemory(config, "q", { fetchImpl: async () => { throw new Error("ECONNREFUSED"); } }),
    (e) => e instanceof Mem0Error && e.code === "memory_unreachable",
  );
});

// ─── note contract ───────────────────────────────────────────────────────────

test("writeMemoryNote POSTs /note with title and content", async () => {
  const calls = [];
  const fetchImpl = async (input, init) => {
    calls.push({ input, body: JSON.parse(init.body) });
    return okResponse({ written: "/vault/T.md" });
  };
  const text = await writeMemoryNote(
    { base: BASE, user: "blaze", enabled: true },
    { title: "T", content: "C", fetchImpl },
  );
  assert.equal(text, "/vault/T.md");
  assert.equal(calls[0].input, `${BASE}/note`);
  assert.deepEqual(calls[0].body, { title: "T", content: "C" });
});

// ─── 22s deadline (mock timers; the fetch never settles) ─────────────────────

test("searchMemory rejects memory_unreachable past the overall deadline", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const never = () => new Promise(() => {});
  const pending = searchMemory({ base: BASE, user: "u", enabled: true }, "q", { fetchImpl: never });
  const assertion = assert.rejects(
    pending,
    (e) => e instanceof Mem0Error && e.code === "memory_unreachable",
  );
  t.mock.timers.tick(MEM0_DEADLINE_MS + 1);
  await assertion;
  t.mock.timers.reset();
});

test("a fetch that resolves inside the deadline is not cut off", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const slowish = async () => {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    return okResponse({ result: "in time" });
  };
  const pending = searchMemory({ base: BASE, user: "u", enabled: true }, "q", { fetchImpl: slowish });
  t.mock.timers.tick(1000);
  assert.equal(await pending, "in time");
  t.mock.timers.reset();
});

// ─── health probe ────────────────────────────────────────────────────────────

test("probeMem0Health GETs /health and reports ok", async () => {
  const calls = [];
  const fetchImpl = async (input) => {
    calls.push(input);
    return okResponse({ ok: true, service: "mem0" });
  };
  assert.equal(await probeMem0Health({ base: BASE, user: "u", enabled: true }, fetchImpl), true);
  assert.equal(calls[0], `${BASE}/health`);
  assert.equal(await probeMem0Health({ base: BASE, user: "u", enabled: true }, async () => okResponse({ ok: false })), false);
  assert.equal(await probeMem0Health({ base: BASE, user: "u", enabled: true }, async () => okResponse("bad", 500)), false);
  assert.equal(await probeMem0Health({ base: BASE, user: "u", enabled: true }, async () => { throw new Error("down"); }), false);
});

// ─── splitMemoryCards (display grouping, pure) ───────────────────────────────

test("splitMemoryCards keeps prose as a single card", () => {
  assert.deepEqual(splitMemoryCards(""), []);
  assert.deepEqual(splitMemoryCards("   \n  "), []);
  assert.deepEqual(splitMemoryCards("just one paragraph"), ["just one paragraph"]);
});

test("splitMemoryCards splits on horizontal rules", () => {
  const cards = splitMemoryCards("section one\n\n---\n\nsection two\n\n---\n\nsection three");
  assert.deepEqual(cards, ["section one", "section two", "section three"]);
});

test("splitMemoryCards splits bullet lists one card per item, keeping continuations", () => {
  const md = [
    "- first entry",
    "- second entry",
    "  continued detail line",
    "",
    "- third entry",
  ].join("\n");
  const cards = splitMemoryCards(md);
  assert.deepEqual(cards, [
    "- first entry",
    "- second entry\n  continued detail line",
    "- third entry",
  ]);
});

test("splitMemoryCards handles numbered lists and trailing blanks", () => {
  const cards = splitMemoryCards("1. alpha\n\n2. beta\n\n\n");
  assert.deepEqual(cards, ["1. alpha", "2. beta"]);
});

test("splitMemoryCards returns one card for a single-item list", () => {
  assert.deepEqual(splitMemoryCards("- only entry"), ["- only entry"]);
});
