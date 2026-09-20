import "../tests/setup-dom.mjs";
import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react/pure.js";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const {
  computeUnreadCount,
  NOTIFY_LAST_READ_STORAGE_KEY,
  NOTIFY_POLL_INTERVAL_MS,
  rowNotificationCopy,
  shouldFireBrowserNotification,
  useNotifyFeed,
} = await jiti.import("./useNotifyFeed.ts");

afterEach(() => {
  cleanup();
  localStorage.removeItem(NOTIFY_LAST_READ_STORAGE_KEY);
});

// ─── pure helpers ────────────────────────────────────────────────────────────

const row = (id, ts, kind = "agent_end") => ({
  id,
  ts,
  kind,
  sessionId: "s1",
  sessionTitle: "Fix the login flow",
  projectRoot: "/repo",
  title: "Fix the login flow — run completed",
  body: "done",
  delivered: false,
});

test("computeUnreadCount: no cursor counts everything, cursor counts newer rows, pruned cursor counts nothing", () => {
  const rows = [row("e3", "3"), row("e2", "2"), row("e1", "1")];
  assert.equal(computeUnreadCount(rows, null), 3);
  assert.equal(computeUnreadCount(rows, "e2"), 1);
  assert.equal(computeUnreadCount(rows, "e3"), 0);
  assert.equal(computeUnreadCount(rows, "gone"), 0, "pruned cursor → nothing unread");
  assert.equal(computeUnreadCount([], null), 0);
});

test("shouldFireBrowserNotification: browser on + granted + hidden + not quiet", () => {
  const base = { browserEnabled: true, permission: "granted", hidden: true, quietHours: false };
  assert.equal(shouldFireBrowserNotification(base), true);
  assert.equal(shouldFireBrowserNotification({ ...base, browserEnabled: false }), false);
  assert.equal(shouldFireBrowserNotification({ ...base, permission: "default" }), false);
  assert.equal(shouldFireBrowserNotification({ ...base, permission: "denied" }), false);
  assert.equal(shouldFireBrowserNotification({ ...base, hidden: false }), false, "a visible tab shows the bell, not a popup");
  assert.equal(shouldFireBrowserNotification({ ...base, quietHours: true }), false);
});

test("rowNotificationCopy localizes known kinds and falls back to server strings", () => {
  const copy = rowNotificationCopy(row("e1", "1", "agent_end"));
  assert.equal(copy.title, "Fix the login flow — run completed");
  assert.equal(copy.body, "done");
  const guardrail = rowNotificationCopy(row("e2", "2", "guardrail"));
  assert.equal(guardrail.title, "Fix the login flow — spend guardrail");
  const unknown = rowNotificationCopy(row("e3", "3", "totally-new-kind"));
  assert.equal(unknown.title, "Fix the login flow — run completed", "unset kind keys fall back to row.title");
});

// ─── hook integration (poll → gate → delivered) ──────────────────────────────

function installNotificationShim(permission) {
  const created = [];
  class FakeNotification {
    constructor(title, options) {
      created.push({ title, options });
      this.onclick = null;
      this.close = () => {};
    }
  }
  FakeNotification.permission = permission;
  FakeNotification.requestPermission = async () => permission;
  const previous = Object.getOwnPropertyDescriptor(globalThis, "Notification");
  const shim = FakeNotification;
  Object.defineProperty(globalThis, "Notification", { configurable: true, writable: true, value: shim });
  Object.defineProperty(window, "Notification", { configurable: true, writable: true, value: shim });
  teardowns.push(() => {
    if (previous) Object.defineProperty(globalThis, "Notification", previous);
    else delete globalThis.Notification;
    delete window.Notification;
  });
  return created;
}

const teardowns = [];
afterEach(() => {
  while (teardowns.length) teardowns.pop()();
});

/** `hidden` is the DOCUMENT state: setVisibility(true) = background tab. */
function setVisibility(hidden) {
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => (hidden ? "hidden" : "visible") });
  Object.defineProperty(document, "hidden", { configurable: true, get: () => hidden });
}

function withFetchMock(t, handler) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    calls.push({ url, init });
    return handler(url, init);
  };
  t.after(() => {
    globalThis.fetch = original;
  });
  return calls;
}

const jsonResponse = (body) => ({ ok: true, status: 200, json: async () => body });

test("the hook polls every 20s only while visible and refreshes on visibility/online", async () => {
  assert.equal(NOTIFY_POLL_INTERVAL_MS, 20_000);
  const hook = await jiti.import("./useNotifyFeed.ts");
  const source = await (await import("node:fs/promises")).readFile(new URL("./useNotifyFeed.ts", import.meta.url), "utf8");
  // Poll ticks are gated on document.visibilityState (hidden tabs skip).
  assert.match(source, /document\.visibilityState !== "visible"\) return;/);
  assert.match(source, /setInterval\(tick, NOTIFY_POLL_INTERVAL_MS\)/);
  // online + visibilitychange refreshes, matching the useAgentSession discipline.
  assert.match(source, /addEventListener\("visibilitychange", onVisible\)/);
  assert.match(source, /addEventListener\("online", onOnline\)/);
  // Permission is requested ONLY through the exported gesture callback.
  assert.match(source, /requestBrowserPermission = useCallback/);
  assert.ok(!/Notification\.requestPermission\(\)/.test(source.split("requestBrowserPermission = useCallback")[0]), "no permission request before the toggle handler definition");
  void hook;
});

test("initial fetch hydrates the feed without notifications; later new rows ping + mark delivered", async (t) => {
  setVisibility(false);
  const created = installNotificationShim("granted");
  let poll = 0;
  const rowFor = (n) => row(`new-${n}`, `2026-09-19T00:0${n}:00.000Z`, n === 1 ? "approval" : "agent_end");
  const calls = withFetchMock(t, (url, init) => {
    if (init?.method === "POST") return jsonResponse({ success: true, data: { updated: 1 } });
    poll += 1;
    const rows = poll === 1 ? [row("hydrate-1", "2026-09-19T00:00:00.000Z")] : [rowFor(poll - 1)];
    return jsonResponse({
      success: true,
      data: {
        rows,
        config: { version: 1, browser: true, webhook: { enabled: false, provider: "generic", events: ["agent_end"], configured: false, host: null, url: "" } },
        webhookDeliveries: { sent: 0, failed: 0 },
      },
    });
  });

  const { result } = renderHook(() => useNotifyFeed());
  await new Promise((resolve) => setTimeout(resolve, 1500));
  await waitFor(() => assert.equal(result.current.rows.length, 1));
  assert.equal(created.length, 0, "history hydration never raises OS notifications");
  assert.equal(result.current.unreadCount, 1);

  // A visible tab sees the bell, not a popup.
  await act(async () => {
    await result.current.refresh();
  });
  assert.equal(created.length, 0, "visible tab: no popup");
  assert.equal(result.current.rows.length, 2);

  // Hidden + granted + browser on + not quiet → ping for the new row only…
  setVisibility(true);
  await act(async () => {
    await result.current.refresh();
  });
  assert.equal(created.length, 1);
  assert.equal(created[0].options.tag, "new-2");
  assert.match(created[0].title, /run completed/);
  // …and the delivered bookkeeping POST fires.
  await waitFor(() => {
    const delivered = calls.filter((call) => call.init?.method === "POST" && String(call.init.body).includes("delivered"));
    assert.equal(delivered.length, 1);
    assert.match(String(delivered[0].init.body), /new-2/);
  });
});

test("quiet hours and the browser toggle suppress the ping while the feed still fills", async (t) => {
  setVisibility(false);
  const created = installNotificationShim("granted");
  const today = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  const from = `${pad((today.getHours() + 23) % 24)}:00`;
  const to = `${pad((today.getHours() + 1) % 24)}:00`;
  let poll = 0;
  withFetchMock(t, () => {
    poll += 1;
    return jsonResponse({
      success: true,
      data: {
        rows: poll === 1
          ? [row("q-hydrate", "2026-09-19T00:00:00.000Z")]
          : [row("q-new", "2026-09-19T00:01:00.000Z")],
        config: {
          version: 1,
          browser: poll === 1,
          webhook: { enabled: false, provider: "generic", events: ["agent_end"], configured: false, host: null, url: "" },
          quietHours: { from, to },
        },
        webhookDeliveries: { sent: 0, failed: 0 },
      },
    });
  });

  const { result } = renderHook(() => useNotifyFeed());
  await waitFor(() => assert.equal(result.current.rows.length, 1));
  setVisibility(true);
  await act(async () => {
    await result.current.refresh();
  });
  await waitFor(() => assert.equal(result.current.rows.length, 2));
  assert.equal(created.length, 0, "quiet hours (window covering now) suppress the browser ping");
});

test("requestBrowserPermission is the only permission path and updates hook state", async (t) => {
  setVisibility(false);
  installNotificationShim("default");
  withFetchMock(t, () => jsonResponse({ success: true, data: { rows: [], config: null, webhookDeliveries: { sent: 0, failed: 0 } } }));
  const { result } = renderHook(() => useNotifyFeed());
  await waitFor(() => assert.equal(result.current.browserPermission, "default"));
  let granted;
  await act(async () => {
    granted = await result.current.requestBrowserPermission();
  });
  assert.equal(granted, "default", "the shim's static permission flows back through the hook");
});
