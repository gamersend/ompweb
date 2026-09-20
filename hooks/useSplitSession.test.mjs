import "../tests/setup-dom.mjs";
import assert from "node:assert/strict";
import test, { afterEach, beforeEach } from "node:test";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import { createJiti } from "jiti";
import { act, cleanup, render, renderHook } from "@testing-library/react/pure.js";
import { createElement } from "react";

// ============================================================================
// Split view (Phase 12) tests.
//
// The one known plumbing risk for split view was same-session SSE fan-out:
// does a session wrapper deliver events to N attached UIs? These tests pin
// the verdict with a REAL AgentSessionWrapper (two onEvent subscribers, the
// same shape two ChatWindow mounts produce), the SSE route's per-connection
// listener contract, and two full useAgentSession instances mounted against
// one session id (independent state, no run-id cross-bleed).
// ============================================================================

const jiti = createJiti(import.meta.url, {
  tryNative: false,
  alias: {
    "@/components/ui/toast": fileURLToPath(new URL("./__fixtures__/toast-stub.mjs", import.meta.url)),
    "@/": fileURLToPath(new URL("../", import.meta.url)),
  },
});

const { AgentSessionWrapper } = await jiti.import("../lib/rpc-manager.ts");
const { useSplitSession, transientSplitSession } = await jiti.import("./useSplitSession.ts");
const { useAgentSession } = await jiti.import("./useAgentSession.ts");
const { selectSessionHistory } = await jiti.import("@/lib/session-sync");

// ---------------------------------------------------------------------------
// 1. Wrapper-level fan-out (same session × 2, real AgentSessionWrapper)
// ---------------------------------------------------------------------------

function fanOutWrapper(t) {
  let emitFrame;
  const wrapper = new AgentSessionWrapper({
    isAlive: true,
    onFrame(listener) {
      emitFrame = listener;
      return () => {};
    },
    sendCommand: async () => ({}),
    sendFrame() {},
    dispose: async () => {},
  }, process.cwd());
  wrapper.start();
  t.after(() => wrapper.destroyAndWait());
  return { wrapper, emit: (event) => emitFrame(event) };
}

test("AgentSessionWrapper fans out to N subscribers (same session mounted twice)", (t) => {
  const { wrapper, emit } = fanOutWrapper(t);

  const paneA = [];
  const paneB = [];
  const offA = wrapper.onEvent((event) => paneA.push(event));
  wrapper.onEvent((event) => paneB.push(event));

  emit({ type: "agent_start" });
  emit({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "hi" }] } });
  emit({ type: "agent_end", isTerminal: true });

  assert.equal(paneA.length, 3, "pane A received every frame");
  assert.equal(paneB.length, 3, "pane B received every frame");
  assert.deepEqual(paneA.map((e) => e.type), paneB.map((e) => e.type), "identical frame order");
  // The wrapper-stamped cursor must be identical on both subscribers: each
  // pane's catch-up cursor sees the same stream.
  assert.deepEqual(paneA.map((e) => e.web), paneB.map((e) => e.web), "identical web cursors");
  // Note: the wrapper deliberately emits ONE object to all listeners (each SSE
  // subscriber serializes independently), so object identity is not the
  // contract — delivery, order, and cursor equality are.

  // Pane A closes: B must keep receiving (the split pane outlives the main).
  offA();
  emit({ type: "agent_start" });
  emit({ type: "agent_end", isTerminal: true });
  assert.equal(paneA.length, 3, "detached pane A receives nothing more");
  assert.equal(paneB.length, 5, "remaining pane B still live");
});

test("SSE events route attaches one listener per connection (fan-out contract)", async () => {
  const source = await readFile(new URL("../app/api/agent/[id]/events/route.ts", import.meta.url), "utf8");
  // Every GET opens its own stream and attaches its own wrapper listener —
  // the route never guards on "already has a listener" nor replaces one.
  assert.match(source, /session\.onEvent\(/, "per-connection listener attach");
  assert.match(source, /const detach = session\.onEvent/, "detach handle kept for cleanup");
  assert.match(source, /unsubscribe\(\)/, "listener detached on disconnect");
  assert.match(source, /if \(!session\) return new Response\("Session is not managed by omp-web"/, "observer-only: no second child spawn");
});

// ---------------------------------------------------------------------------
// 2. useSplitSession glue (session resolution + splitLeaf anchor)
// ---------------------------------------------------------------------------

function jsonResponse(status, value) {
  return { ok: status >= 200 && status < 300, status, json: async () => value };
}

test("useSplitSession resolves the split id into a SessionInfo from the session list", async () => {
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (url) => {
    calls.push(String(url));
    return jsonResponse(200, {
      sessions: [{ path: "/p/x.jsonl", id: "s1", cwd: "/repo", name: "Split me", created: "2026-01-01T00:00:00.000Z", modified: "2026-01-01T00:00:00.000Z", messageCount: 4, firstMessage: "hello" }],
    });
  });
  try {
    const onClose = () => {};
    const { result } = renderHook(() => useSplitSession({ sessionId: "s1", leafId: null, onClose }));
    assert.ok(result.current.session, "transient session mounted immediately");
    assert.equal(result.current.session.id, "s1");
    await act(async () => {});
    assert.equal(result.current.session.name, "Split me", "resolved record replaces the transient one");
    assert.ok(calls.every((url) => url.startsWith("/api/sessions")), "resolution uses the session list endpoint");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("REGRESSION same-session split: the first render already carries the transient session", async () => {
  // The pane's useAgentSession mount effect runs once and latches on the
  // session id — if useSplitSession only sets the transient record in an
  // effect (after the pane's first render), that effect saw session=null and
  // never fires loadSession: the pane hangs on "Loading session…" forever.
  // The fix is lazy state init, so the very FIRST render must carry the id.
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => jsonResponse(200, { sessions: [] }));
  const renders = [];
  function Probe({ sessionId }) {
    const { session } = useSplitSession({ sessionId, leafId: null, onClose: () => {} });
    renders.push(session);
    return null;
  }
  try {
    renderHook(() => Probe({ sessionId: "s-split" }));
    assert.ok(renders[0], "first render already has a session record");
    assert.equal(renders[0].id, "s-split");
    assert.equal(renders[0].path, "", "transient shape");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("useSplitSession falls back to a transient record when resolution fails", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => jsonResponse(500, {}));
  try {
    const { result } = renderHook(() => useSplitSession({ sessionId: "s2", leafId: null, onClose: () => {} }));
    await act(async () => {});
    assert.ok(result.current.session, "pane still mounts");
    assert.equal(result.current.session.id, "s2");
    assert.equal(result.current.session.path, "", "transient shape");
    assert.equal(result.current.anchor, null);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("useSplitSession turns splitLeaf changes into monotonic anchor requests", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => jsonResponse(200, { sessions: [] }));
  try {
    const onClose = () => {};
    const { result, rerender } = renderHook(({ leafId }) => useSplitSession({ sessionId: "s3", leafId, onClose }), {
      initialProps: { leafId: null },
    });
    assert.equal(result.current.anchor, null, "no leaf → no anchor");

    await act(async () => { rerender({ leafId: "e1" }); });
    assert.deepEqual(result.current.anchor, { entryId: "e1", seq: 1 });

    await act(async () => { rerender({ leafId: "e2" }); });
    assert.equal(result.current.anchor.entryId, "e2");
    assert.equal(result.current.anchor.seq, 2, "seq is monotonic so the hop re-fires");

    await act(async () => { rerender({ leafId: null }); });
    assert.equal(result.current.anchor, null);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("transientSplitSession builds a mountable SessionInfo shape", () => {
  const info = transientSplitSession("s9", "/repo");
  assert.equal(info.id, "s9");
  assert.equal(info.path, "");
  assert.equal(info.cwd, "/repo");
  assert.equal(info.messageCount, 0);
  assert.ok(info.created, "timestamps present");
});

// ---------------------------------------------------------------------------
// 3. Two full useAgentSession instances on ONE session id (split reality):
//    independent state, no run-id cross-bleed.
// ---------------------------------------------------------------------------

class FakeEventSource {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSED = 2;
  constructor(url) {
    this.url = String(url);
    this.readyState = FakeEventSource.CONNECTING;
    this.onopen = null;
    this.onmessage = null;
    this.onerror = null;
    this.closedByCaller = false;
    world.esInstances.push(this);
  }
  open() {
    if (this.closedByCaller) return;
    this.readyState = FakeEventSource.OPEN;
    this.onopen?.({});
    const sid = this.url.match(/\/api\/agent\/([^/]+)/)?.[1];
    this.onmessage?.({ data: JSON.stringify({ type: "connected", web: world.streams.get(sid) ?? { streamId: `stream-${sid}`, sequence: 0 } }) });
  }
  emit(event, { persist = true } = {}) {
    if (this.closedByCaller) return;
    const sid = this.url.match(/\/api\/agent\/([^/]+)/)?.[1];
    const previous = world.streams.get(sid) ?? { streamId: `stream-${sid}`, sequence: 0 };
    const web = event.web ?? { ...previous, sequence: previous.sequence + 1 };
    world.streams.set(sid, web);
    if (event.type === "agent_start") this.running = true;
    this.onmessage?.({ data: JSON.stringify({ ...event, web }) });
    // The real omp child persists each message once; only one pane's stream
    // is designated to write the shared fake disk (the others are pure
    // fan-out receivers of the same wrapper event).
    if (event.type === "message_end" && persist && this.running) appendEntry(sid, event.message);
    if (event.type === "agent_end" && event.isTerminal !== false) this.running = false;
  }
  close() {
    this.closedByCaller = true;
    this.readyState = FakeEventSource.CLOSED;
  }
}

function safeParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

const world = {
  esInstances: [],
  calls: [],
  sessions: new Map(),
  agents: new Map(),
  streams: new Map(),
};

async function fetchStub(url, init = {}) {
  const method = (init.method ?? "GET").toUpperCase();
  const u = String(url);
  world.calls.push({ method, url: u, body: typeof init.body === "string" ? safeParse(init.body) : null });

  let m;
  if ((m = u.match(/\/api\/sessions\/([^/?#]+)\/context/)) && method === "GET") {
    const sid = decodeURIComponent(m[1]);
    const params = new URL(u, "http://localhost").searchParams;
    const f = world.sessions.get(sid);
    if (!f) return jsonResponse(404, {});
    if (params.get("boundary") === "1") return jsonResponse(200, { entryIds: [...f.entryIds] });
    if (params.get("forEntry")) {
      // findLeafForEntry stand-in: the leaf is the stored one for any entry.
      const context = { todoPhases: [], thinkingLevel: "off", model: null, ...f };
      return jsonResponse(200, { context, leafId: f.leafId });
    }
    const context = { todoPhases: [], thinkingLevel: "off", model: null, ...f };
    if (!params.has("sync")) return jsonResponse(200, { context });
    return jsonResponse(200, {
      ...selectSessionHistory(context, params.has("cursor") ? JSON.parse(params.get("cursor")) : null),
      sessionId: sid,
      leafId: params.get("leafId") ?? f.leafId,
    });
  }
  if ((m = u.match(/\/api\/sessions\/([^/?#]+)\/state/))) {
    const a = world.agents.get(decodeURIComponent(m[1])) ?? { running: false, state: {} };
    return jsonResponse(200, { running: a.running, state: a.state });
  }
  if (/\/api\/sessions\/[^/?#]+\/subagents/.test(u)) return jsonResponse(200, { subagents: [] });
  if ((m = u.match(/\/api\/sessions\/([^/?#]+)/)) && method === "GET") {
    const f = world.sessions.get(decodeURIComponent(m[1]));
    if (!f) return jsonResponse(404, {});
    return jsonResponse(200, {
      sessionId: decodeURIComponent(m[1]), filePath: "/fixture/session.jsonl", tree: [],
      leafId: f.leafId,
      context: { todoPhases: [], thinkingLevel: "off", model: null, ...f },
    });
  }
  if (/^\/api\/models/.test(u)) return jsonResponse(200, { models: {}, modelList: [], defaultModel: null });
  if ((m = u.match(/\/api\/agent\/([^/?#]+)/))) {
    const sid = decodeURIComponent(m[1]);
    if (method === "GET") {
      const a = world.agents.get(sid) ?? { running: false, state: {} };
      return jsonResponse(200, { running: a.running, state: a.state });
    }
    if (method === "POST") {
      const body = typeof init.body === "string" ? safeParse(init.body) : null;
      if (body?.type === "get_subagents") return jsonResponse(200, { success: true, data: { subagents: [] } });
      return jsonResponse(200, { success: true, data: {} });
    }
  }
  return jsonResponse(404, {});
}

const overrides = [
  [globalThis, "EventSource", { value: FakeEventSource }],
  [globalThis, "fetch", { value: fetchStub }],
  [document, "hidden", { get: () => true }],
  [document, "visibilityState", { get: () => "hidden" }],
  [window, "matchMedia", {
    value: (media) => Object.assign(new window.EventTarget(), { matches: false, media }),
  }],
].map(([target, key, replacement]) => ({
  target, key, replacement, original: Object.getOwnPropertyDescriptor(target, key),
}));

beforeEach(() => {
  world.esInstances.length = 0;
  world.calls.length = 0;
  world.sessions.clear();
  world.agents.clear();
  world.streams.clear();
  localStorage.clear();
  sessionStorage.clear();
  for (const { target, key, replacement } of overrides) {
    Object.defineProperty(target, key, { configurable: true, ...replacement });
  }
});

afterEach(() => {
  try {
    cleanup();
  } finally {
    for (const { target, key, original } of overrides) {
      if (original) Object.defineProperty(target, key, original);
      else delete target[key];
    }
    localStorage.clear();
    sessionStorage.clear();
  }
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function settle(ms = 120) {
  await act(async () => {
    await sleep(ms);
  });
}

function sessionInfo(sid) {
  return {
    id: sid,
    path: "",
    cwd: "/workspace",
    name: `session ${sid}`,
    created: "2026-01-01T00:00:00.000Z",
    modified: "2026-01-01T00:00:00.000Z",
    messageCount: 1,
    firstMessage: "loaded question",
  };
}

const userMsg = (id, text) => ({ role: "user", id, content: text, timestamp: 1 });
const assistantMsg = (id, text) => ({
  role: "assistant",
  id,
  provider: "test",
  model: "test-model",
  content: [{ type: "text", text }],
});

function primeSession(sid, messages) {
  world.sessions.set(sid, {
    leafId: String(messages.length),
    messages,
    entryIds: messages.map((_, i) => `e${i}`),
  });
  world.agents.set(sid, { running: false, state: {} });
}

function appendEntry(sid, message) {
  const previous = world.sessions.get(sid);
  world.sessions.set(sid, {
    leafId: String(previous.messages.length),
    messages: [...previous.messages, message],
    entryIds: [...previous.entryIds, `e${previous.entryIds.length}`],
  });
}

async function mountPane(sid) {
  // Snapshot the ES index BEFORE mounting: each mount creates exactly one
  // EventSource for this sid, and both panes share the same URL shape —
  // index-based capture is the only way to tell the two streams apart.
  const esIndex = world.esInstances.length;
  const { result, unmount } = renderHook(() => useAgentSession({
    session: sessionInfo(sid), newSessionCwd: null,
  }));
  await settle();
  return {
    unmount,
    es() {
      return world.esInstances[esIndex];
    },
    get latest() {
      return result.current;
    },
  };
}

test("same session in two panes: fan-out delivers to both, send state never bleeds across instances", async () => {
  primeSession("s1", [userMsg("u0", "loaded question")]);
  const paneA = await mountPane("s1");

  // Pane A hydrated idle: one message, no SSE yet (an idle session connects
  // its stream on first send — the mount path only attaches when a run is
  // already live).
  assert.equal(paneA.latest.loading, false);
  assert.equal(paneA.latest.messages.length, 1);

  // Pane A sends a prompt: its optimistic bubble + run bookkeeping move, and
  // exactly ONE prompt command is dispatched (shared wrapper).
  let sendPromise;
  await act(async () => {
    sendPromise = paneA.latest.handleSend("from pane A");
    await sleep(30);
  });
  const esA = paneA.es();
  assert.ok(esA, "pane A connected its stream for the send");
  await act(async () => {
    esA.open();
    await sendPromise;
  });
  assert.equal(
    world.calls.filter((c) => c.method === "POST" && c.body?.type === "prompt").length,
    1,
    "exactly one prompt command for one send",
  );
  // Pane A's optimistic bubble lives inside its `messages` (confirmed + 1);
  // pane B's confirmed view is untouched by A's send — no cross-bleed.
  assert.equal(paneA.latest.messages.length, 2, "pane A shows its optimistic bubble");
  assert.equal(paneA.latest.messages.at(-1)?.role, "user");
  assert.equal(paneA.latest.agentRunning, true);

  // Pane B mounts while the run is live — the split-opened-during-a-run case.
  // Its mount path attaches a SECOND SSE stream (the fan-out under test).
  world.agents.set("s1", { running: true, state: { isStreaming: true } });
  const paneB = await mountPane("s1");
  const esB = paneB.es();
  assert.ok(esB && esB !== esA, "one EventSource per pane, two connections total");
  await act(async () => {
    esB.open();
    await sleep(30);
  });
  // B hydrated its own view independently: confirmed history only — A's
  // optimistic bubble is instance-local state and never crossed over.
  assert.equal(paneB.latest.messages.length, 1, "pane B never shows A's optimistic bubble");
  assert.equal(paneB.latest.agentRunning, true, "B sees the live run through its own stream");

  // Wrapper fan-out: the SAME frames are delivered to both streams (this is
  // exactly what AgentSessionWrapper.emit does with N listeners). agent_start
  // opens the run on both; the user echo is persisted to the (shared) session
  // file and reaches each pane through its own catch-up read.
  await act(async () => {
    const start = { type: "agent_start" };
    esA.emit(start);
    esB.emit({ ...start });
    await Promise.resolve();
  });
  await act(async () => {
    const frame = { type: "message_end", message: userMsg("u1", "from pane A") };
    esA.emit(frame);
    esB.emit({ ...frame }, { persist: false });
    await Promise.resolve();
  });
  await settle(60);
  assert.equal(paneA.latest.messages.length, 2, "A: old pair + echoed user (bubble replaced)");
  assert.equal(paneB.latest.messages.length, 2, "B appended the same user turn");

  // The reply streams to both panes and both settle to idle together.
  await act(async () => {
    esA.emit({ type: "message_end", message: assistantMsg("a2", "done") });
    esB.emit({ type: "message_end", message: assistantMsg("a2", "done") }, { persist: false });
    esA.emit({ type: "agent_end", isTerminal: true });
    esB.emit({ type: "agent_end", isTerminal: true });
    await Promise.resolve();
  });
  await settle();
  assert.equal(paneA.latest.agentRunning, false, "run ended in pane A");
  assert.equal(paneB.latest.agentRunning, false, "run ended in pane B too");
  assert.equal(paneA.latest.messages.length, 3, "A has the full exchange");
  assert.equal(paneB.latest.messages.length, 3, "B has the full exchange");
  assert.equal(paneA.latest.messages.at(-1)?.content?.[0]?.text, "done");
  assert.equal(paneB.latest.messages.at(-1)?.content?.[0]?.text, "done");

  paneA.unmount();
  paneB.unmount();
});

// ---------------------------------------------------------------------------
// 4. SPA transition regression: the split id appearing on an ALREADY-OPEN app.
//    A fresh page load (?session=X&split=X) initializes useSplitSession with
//    the id present, so the keyed pane mounts with a session record and its
//    one-shot useAgentSession mount effect loads. The in-app path is the trap:
//    the hook has been mounted with sessionId=null since app start, and the
//    id only appears on a later render — the pane MUST still see a session
//    record on that render, or its load effect latches on null forever and
//    the pane hangs on "Loading session…".
// ---------------------------------------------------------------------------

test("REGRESSION SPA split transition: the session record exists on the FIRST render after the id appears", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => jsonResponse(200, { sessions: [] }));
  const renders = [];
  function Probe({ sessionId }) {
    const { session } = useSplitSession({ sessionId, leafId: null, onClose: () => {} });
    renders.push(session ? session.id : null);
    return null;
  }
  try {
    const view = render(createElement(Probe, { sessionId: null }));
    assert.deepEqual(renders, [null], "hook mounted with no split renders no session");

    // The in-app click: sessionId flips null → id on an already-mounted hook.
    view.rerender(createElement(Probe, { sessionId: "s-late" }));
    assert.equal(renders[1], "s-late", "the FIRST render after the id carries a session record");
  } finally {
    globalThis.fetch = originalFetch;
    cleanup();
  }
});

test("REGRESSION SPA split transition: keyed pane mounts after the id appears and its loading gate flips", async () => {
  primeSession("s-spa", [userMsg("u0", "already loaded"), assistantMsg("a1", "the reply")]);
  const paneRenders = [];
  // The split pane, mirroring AppShell's <ChatWindow session={splitSession}>.
  function Pane({ session }) {
    const { loading, messages } = useAgentSession({ session, newSessionCwd: null });
    paneRenders.push({ hasSession: !!session, loading, messageCount: messages.length });
    return null;
  }
  // AppShell's lifetime: useSplitSession stays mounted from app start; the
  // keyed pane only mounts once splitActive (id present) — exactly the render
  // whose `session` value decides whether the load effect ever fires.
  function Harness({ splitSessionId }) {
    const { session } = useSplitSession({ sessionId: splitSessionId, leafId: null, onClose: () => {} });
    return splitSessionId ? createElement(Pane, { session }) : null;
  }
  try {
    const view = render(createElement(Harness, { splitSessionId: null }));
    await settle();
    assert.deepEqual(paneRenders, [], "no pane mounted before the split id appears");

    // The in-app "Split right" click.
    view.rerender(createElement(Harness, { splitSessionId: "s-spa" }));
    await settle();

    assert.ok(paneRenders.length > 0, "pane mounted after the split id appeared");
    assert.ok(paneRenders[0].hasSession, "pane's first render already carries the split session");
    const last = paneRenders.at(-1);
    assert.equal(last.loading, false, "loading gate flipped once the transcript arrived");
    assert.equal(last.messageCount, 2, "transcript hydrated in the split pane");
    assert.ok(
      world.calls.some((c) => c.method === "GET" && /\/api\/sessions\/s-spa\?/.test(c.url)),
      "the pane issued its own initial loadSession fetch",
    );
  } finally {
    cleanup();
  }
});
