import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const {
  deriveCapabilities,
  normalizeAvailableCommands,
  parseRpcReady,
  supportsProtocol,
} = await jiti.import("./rpc-capabilities.ts");

// ---------------------------------------------------------------------------
// Fixture loader: every file in tests/fixtures/rpc must parse and satisfy the
// structural contract for its family. This is the P1 "one command checks all
// sanitized fixtures" gate — npm test picks it up via the lib/omp glob.
// ---------------------------------------------------------------------------

const FIXTURES_DIR = join(import.meta.dirname, "..", "..", "tests", "fixtures", "rpc");

function loadFixtures() {
  const out = new Map();
  for (const name of readdirSync(FIXTURES_DIR).filter((f) => f.endsWith(".json")).sort()) {
    out.set(name, JSON.parse(readFileSync(join(FIXTURES_DIR, name), "utf8")));
  }
  return out;
}

const SECRET_PATTERNS = [/sk-[A-Za-z0-9]{8,}/, /Bearer\s+[A-Za-z0-9._-]{12,}/i, /ghp_[A-Za-z0-9]{16,}/];

test("rpc fixtures parse, stay secret-free, and satisfy their family shape", async () => {
  const fixtures = loadFixtures();
  assert.ok(fixtures.size >= 6, `expected the full fixture set, found ${fixtures.size}`);
  for (const [name, fixture] of fixtures) {
    const raw = JSON.stringify(fixture);
    for (const pattern of SECRET_PATTERNS) {
      assert.doesNotMatch(raw, pattern, `${name} looks like it carries a credential`);
    }
  }

  // ready fixtures
  for (const name of ["ready-v1.json", "ready-stale-v1.json"]) {
    const ready = parseRpcReady(fixtures.get(name));
    assert.ok(ready, `${name} must parse as a ready frame`);
    assert.equal(ready.protocolVersion, 1);
    assert.ok(ready.supportedProtocolVersions.length >= 1);
    assert.equal(ready.maxFrameBytes, 1048576);
  }
  // command fixtures
  const commands = normalizeAvailableCommands(fixtures.get("commands-update.json"));
  assert.ok(commands.length >= 10, "commands-update fixture should carry the wave-3 families");
  for (const command of commands) {
    assert.match(command.name, /^[A-Za-z0-9_-]{1,64}$/);
    assert.equal(typeof command.source, "string");
  }
  const malformed = normalizeAvailableCommands(fixtures.get("commands-update-malformed.json"));
  assert.deepEqual(malformed.map((command) => command.name), ["valid_command"],
    "malformed entries are dropped and duplicates collapse to the first");
  // event fixtures: shape only — {type: string} objects, unknown stays visible
  const events = fixtures.get("events-samples.json").events;
  assert.ok(Array.isArray(events) && events.length >= 5);
  for (const event of events) {
    assert.equal(typeof event.type, "string", "every event sample carries a type");
  }
  // error fixture
  const error = fixtures.get("error-unsupported.json");
  assert.equal(typeof error.code, "string");
});

// ---------------------------------------------------------------------------
// Capability guard table: supported / missing / malformed / disconnected /
// stale-version / unknown-name, per P1.2's acceptance matrix.
// ---------------------------------------------------------------------------

const WANTED = [
  { name: "task_batch" },
  { name: "jobs" },
  { name: "fresh", known: false },
];

test("capability table: supported, missing, unknown, malformed, disconnected, stale", () => {
  const fixtures = loadFixtures();
  const ready = parseRpcReady(fixtures.get("ready-v1.json"));
  const commands = normalizeAvailableCommands(fixtures.get("commands-update.json"));

  const connected = deriveCapabilities({ transport: "connected", ready, commands, wanted: WANTED });
  assert.deepEqual(
    connected.map((capability) => [capability.name, capability.supported, capability.reason ?? null]),
    [
      ["task_batch", true, null],
      ["jobs", true, null],
      // known:false → we do not render it even though the child might ship it
      ["fresh", false, "unknown_command"],
    ],
  );

  const missing = deriveCapabilities({
    transport: "connected",
    ready,
    commands: commands.filter((command) => command.name !== "jobs"),
    wanted: WANTED,
  });
  assert.equal(missing.find((capability) => capability.name === "jobs").reason, "missing_command");

  const malformed = deriveCapabilities({ transport: "connected", ready: null, commands, wanted: WANTED });
  for (const capability of malformed) assert.equal(capability.reason, "malformed_response");

  const disconnected = deriveCapabilities({ transport: "disconnected", ready, commands, wanted: WANTED });
  for (const capability of disconnected) assert.equal(capability.reason, "transport_disconnected");
});

test("protocol negotiation math over ready fixtures", () => {
  const fixtures = loadFixtures();
  const current = parseRpcReady(fixtures.get("ready-v1.json"));
  const stale = parseRpcReady(fixtures.get("ready-stale-v1.json"));
  assert.equal(supportsProtocol(current, 2), true);
  assert.equal(supportsProtocol(stale, 2), false, "a v1-only child cannot take a v2 negotiation");
  assert.equal(supportsProtocol(null, 1), false);
});

test("malformed and invalid in-memory cases degrade, never throw", () => {
  // intentionally invalid in-memory cases (never committed as fixtures)
  assert.equal(parseRpcReady(undefined), null);
  assert.equal(parseRpcReady({ protocolVersion: "1", supportedProtocolVersions: [1] }), null);
  assert.equal(parseRpcReady({ protocolVersion: 1, supportedProtocolVersions: [] }), null);
  assert.equal(parseRpcReady({ type: "ready" }), null);
  assert.deepEqual(normalizeAvailableCommands(null), []);
  assert.deepEqual(normalizeAvailableCommands({ commands: "nope" }), []);
  assert.deepEqual(normalizeAvailableCommands([null, 1, { name: "ok", source: "builtin" }]).map((c) => c.name), ["ok"]);
  // long descriptions are capped, never passed through wholesale
  const [capped] = normalizeAvailableCommands({ commands: [{ name: "x", source: "s", description: "d".repeat(500) }] });
  assert.equal(capped.description.length, 200);
});
