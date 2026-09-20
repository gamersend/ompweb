import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const {
  FLAG_NAMES,
  FLAGS_ENV_VAR,
  FLAGS_STORAGE_KEY,
  defaultFlagValue,
  isEnabled,
  parseFlagList,
  readFlags,
  setNativeStatsProbe,
} = await jiti.import("./feature-flags.ts");

test("parseFlagList keeps only known flag names, deduped and case-insensitive", () => {
  assert.deepEqual(parseFlagList("terminal, split,,scheduler"), ["terminal", "split", "scheduler"]);
  assert.deepEqual(parseFlagList("  TERMINAL  "), ["terminal"]);
  assert.deepEqual(parseFlagList("terminal terminal"), ["terminal"]);
  assert.deepEqual(parseFlagList("bogus,split"), ["split"], "unknown names are dropped");
  assert.deepEqual(parseFlagList(""), []);
  assert.deepEqual(parseFlagList(null), []);
  assert.deepEqual(parseFlagList(undefined), []);
});

test("readFlags merges env ∪ localStorage over defaults; union never disables", () => {
  const env = { [FLAGS_ENV_VAR]: "terminal" };
  assert.deepEqual(
    Object.entries(readFlags(env)).filter(([, v]) => v).map(([k]) => k).sort(),
    ["scheduler", "split", "terminal"],
    "env flag + default-on flags (split ships enabled, P12)",
  );
  // localStorage adds a flag env does not carry.
  const withStorage = { localStorage: { getItem: (key) => (key === FLAGS_STORAGE_KEY ? "herdrAttach" : null) } };
  const merged = readFlagsWithStorage(env, withStorage);
  assert.deepEqual(
    Object.entries(merged).filter(([, v]) => v).map(([k]) => k).sort(),
    ["herdrAttach", "scheduler", "split", "terminal"],
  );
});

test("flag precedence: env enables what storage omits and vice versa", () => {
  const envOnly = { [FLAGS_ENV_VAR]: "terminal" };
  const storageOnly = { getItem: (key) => (key === FLAGS_STORAGE_KEY ? "split" : null) };
  const merged = readFlagsWithStorage(envOnly, { localStorage: storageOnly });
  assert.equal(merged.terminal, true, "env-only flag is on");
  assert.equal(merged.split, true, "storage-only flag is on");
  assert.equal(merged.scheduler, true, "scheduler ships enabled by default (P11)");
  assert.equal(merged.herdrAttach, false, "flags defaulting off stay off");
});

test("herdrAttach defaults on only with OMP_WEB_HERDR_BIN; nativeStats follows its probe", () => {
  assert.equal(defaultFlagValue("herdrAttach", {}), false);
  assert.equal(defaultFlagValue("herdrAttach", { OMP_WEB_HERDR_BIN: "/usr/bin/herdr" }), true);
  assert.equal(defaultFlagValue("nativeStats", {}), false);

  setNativeStatsProbe(() => true);
  try {
    assert.equal(defaultFlagValue("nativeStats", {}), true);
  } finally {
    setNativeStatsProbe(null);
  }
  assert.equal(defaultFlagValue("nativeStats", {}), false, "probe cleared");
  setNativeStatsProbe(() => {
    throw new Error("fs exploded");
  });
  try {
    assert.equal(defaultFlagValue("nativeStats", {}), false, "a throwing probe degrades to off");
  } finally {
    setNativeStatsProbe(null);
  }
});

test("terminal defaults on; OMP_WEB_DISABLE_TERMINAL=1 is the kill switch", () => {
  assert.equal(defaultFlagValue("terminal", {}), true, "terminal ships enabled (P13)");
  assert.equal(defaultFlagValue("terminal", { OMP_WEB_DISABLE_TERMINAL: "0" }), true, "only the exact kill value disables");
  assert.equal(defaultFlagValue("terminal", { OMP_WEB_DISABLE_TERMINAL: "1" }), false, "kill switch disarms the flag");
  assert.equal(readFlags({ OMP_WEB_DISABLE_TERMINAL: "1" }).terminal, false, "kill switch wins over everything");
});

test("isEnabled guards entry points against a supplied FlagSet or a fresh read", () => {
  assert.equal(isEnabled("terminal", { terminal: true, split: false, scheduler: false, herdrAttach: false, nativeStats: false }), true);
  assert.equal(isEnabled("terminal", { terminal: false, split: false, scheduler: false, herdrAttach: false, nativeStats: false }), false);
  const env = { [FLAGS_ENV_VAR]: "" };
  // split (P12), scheduler (P11) and terminal (P13) ship enabled; the rest
  // ship dark.
  const SHIP_ENABLED = new Set(["split", "scheduler", "terminal"]);
  for (const name of FLAG_NAMES) {
    assert.equal(isEnabled(name, readFlags(env)), SHIP_ENABLED.has(name), `${name} default matches its phase contract`);
  }
});

function readFlagsWithStorage(env, storage) {
  const originalDescriptor = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    writable: true,
    value: { localStorage: storage.localStorage },
  });
  try {
    return readFlags(env);
  } finally {
    if (originalDescriptor) Object.defineProperty(globalThis, "window", originalDescriptor);
    else delete globalThis.window;
  }
}
