import assert from "node:assert/strict";
import test from "node:test";

async function loadSubject() {
  return import("./device-capabilities.ts");
}

/** A minimal env with every capability present. */
function fullEnvironment(overrides = {}) {
  return {
    navigator: {
      setAppBadge: async () => {},
      clearAppBadge: async () => {},
      serviceWorker: { ready: Promise.resolve({}) },
    },
    window: {
      showOpenFilePicker: async () => [],
      matchMedia: (query) => ({ matches: query.includes("standalone") }),
    },
    SyncManager: class SyncManager {},
    ...overrides,
  };
}

test("empty environment reports every capability unsupported", async () => {
  const { getDeviceCapabilities } = await loadSubject();
  assert.deepEqual(getDeviceCapabilities({}), {
    appBadging: { supported: false },
    shareTarget: { supported: false, standalone: false },
    backgroundSync: { supported: false },
    fileSystemAccess: { supported: false },
  });
});

test("capability table detects each support", async () => {
  const { getDeviceCapabilities } = await loadSubject();
  const caps = getDeviceCapabilities(fullEnvironment());
  assert.equal(caps.appBadging.supported, true);
  assert.equal(caps.shareTarget.supported, true);
  assert.equal(caps.shareTarget.standalone, true);
  assert.equal(caps.backgroundSync.supported, true);
  assert.equal(caps.fileSystemAccess.supported, true);
});

test("app badging needs BOTH setAppBadge and clearAppBadge", async () => {
  const { appBadgingSupported } = await loadSubject();
  assert.equal(appBadgingSupported({ navigator: { setAppBadge: () => {}, clearAppBadge: () => {} } }), true);
  assert.equal(appBadgingSupported({ navigator: { setAppBadge: () => {} } }), false);
  assert.equal(appBadgingSupported({ navigator: { clearAppBadge: () => {} } }), false);
  assert.equal(appBadgingSupported({ navigator: { setAppBadge: "yes", clearAppBadge: "yes" } }), false);
  assert.equal(appBadgingSupported({}), false);
});

test("standalone display mode comes from matchMedia or the iOS legacy marker", async () => {
  const { detectStandaloneDisplayMode } = await loadSubject();
  assert.equal(
    detectStandaloneDisplayMode({ window: { matchMedia: (q) => ({ matches: q === "(display-mode: standalone)" }) } }),
    true,
  );
  // A non-standalone media query must NOT match.
  assert.equal(
    detectStandaloneDisplayMode({ window: { matchMedia: () => ({ matches: false }) } }),
    false,
  );
  assert.equal(detectStandaloneDisplayMode({ navigator: { standalone: true } }), true);
  assert.equal(detectStandaloneDisplayMode({ navigator: { standalone: "true" } }), false);
  assert.equal(detectStandaloneDisplayMode({}), false);
});

test("share target reports the standalone proxy and never claims window.share", async () => {
  const { shareTargetCapability } = await loadSubject();
  // window.share must be irrelevant — it is the INVOCATION api, not the target.
  assert.deepEqual(shareTargetCapability({ navigator: { share: () => {} } }), {
    supported: false,
    standalone: false,
  });
  assert.deepEqual(shareTargetCapability({ window: { matchMedia: () => ({ matches: true }) } }), {
    supported: true,
    standalone: true,
  });
});

test("background sync needs serviceWorker AND the SyncManager global", async () => {
  const { backgroundSyncSupported } = await loadSubject();
  const syncManager = class SyncManager {};
  assert.equal(backgroundSyncSupported({ navigator: { serviceWorker: { ready: {} } }, SyncManager: syncManager }), true);
  // Missing SyncManager global.
  assert.equal(backgroundSyncSupported({ navigator: { serviceWorker: { ready: {} } } }), false);
  // Missing serviceWorker.
  assert.equal(backgroundSyncSupported({ SyncManager: syncManager }), false);
  // serviceWorker that is not an object.
  assert.equal(backgroundSyncSupported({ navigator: { serviceWorker: "sw" }, SyncManager: syncManager }), false);
});

test("file system access requires an invocable showOpenFilePicker", async () => {
  const { fileSystemAccessSupported } = await loadSubject();
  assert.equal(fileSystemAccessSupported({ window: { showOpenFilePicker: () => {} } }), true);
  assert.equal(fileSystemAccessSupported({ window: { showOpenFilePicker: undefined } }), false);
  assert.equal(fileSystemAccessSupported({ window: {} }), false);
  assert.equal(fileSystemAccessSupported({}), false);
});

test("throwing environment access degrades to unsupported, never throws", async () => {
  const { appBadgingSupported, detectStandaloneDisplayMode, backgroundSyncSupported, fileSystemAccessSupported } =
    await loadSubject();
  const throwing = {
    get navigator() {
      throw new Error("boom");
    },
  };
  assert.equal(appBadgingSupported(throwing), false);
  assert.equal(detectStandaloneDisplayMode(throwing), false);
  assert.equal(backgroundSyncSupported(throwing), false);
  assert.equal(fileSystemAccessSupported(throwing), false);
});

test("getDeviceCapabilities tolerates a omitted environment argument", async () => {
  const { getDeviceCapabilities } = await loadSubject();
  // Shape contract under the real (possibly absent) browser globals.
  const caps = getDeviceCapabilities();
  for (const key of ["appBadging", "shareTarget", "backgroundSync", "fileSystemAccess"]) {
    assert.equal(typeof caps[key].supported, "boolean");
  }
  assert.equal(typeof caps.shareTarget.standalone, "boolean");
});

test("applyAppBadge sets a floored positive count", async () => {
  const { applyAppBadge } = await loadSubject();
  const calls = [];
  const env = {
    navigator: {
      setAppBadge: (count) => calls.push(["set", count]),
      clearAppBadge: () => calls.push(["clear"]),
    },
  };
  assert.equal(applyAppBadge(7, env), true);
  assert.deepEqual(calls, [["set", 7]]);
  assert.equal(applyAppBadge(2.9, env), true);
  assert.deepEqual(calls, [["set", 7], ["set", 2]]);
});

test("applyAppBadge clears on zero, negative, and NaN counts", async () => {
  const { applyAppBadge } = await loadSubject();
  const calls = [];
  const env = {
    navigator: {
      setAppBadge: (count) => calls.push(["set", count]),
      clearAppBadge: () => calls.push(["clear"]),
    },
  };
  assert.equal(applyAppBadge(0, env), true);
  assert.equal(applyAppBadge(-3, env), true);
  assert.equal(applyAppBadge(Number.NaN, env), true);
  assert.deepEqual(calls, [["clear"], ["clear"], ["clear"]]);
});

test("applyAppBadge swallows sync throws and rejected promises silently", async () => {
  const { applyAppBadge } = await loadSubject();
  // Sync throw.
  assert.equal(
    applyAppBadge(3, { navigator: { setAppBadge: () => { throw new Error("boom"); }, clearAppBadge: () => {} } }),
    false,
  );
  // Rejected promise: must not produce an unhandled rejection.
  const rejections = [];
  process.on("unhandledRejection", (error) => rejections.push(error));
  assert.equal(
    applyAppBadge(3, {
      navigator: {
        setAppBadge: () => Promise.reject(new Error("nope")),
        clearAppBadge: () => Promise.resolve(),
      },
    }),
    true,
  );
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(rejections, []);
});

test("applyAppBadge returns false when unsupported and never throws on a missing navigator", async () => {
  const { applyAppBadge } = await loadSubject();
  assert.equal(applyAppBadge(5, {}), false);
  assert.equal(applyAppBadge(5, { navigator: undefined }), false);
});
