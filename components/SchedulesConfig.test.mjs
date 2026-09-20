import assert from "node:assert/strict";
import "../tests/setup-dom.mjs";
import test, { afterEach } from "node:test";
import { fileURLToPath } from "node:url";
import React from "react";
import { act, cleanup, render, waitFor } from "@testing-library/react/pure.js";
import { createJiti } from "jiti";

// ============================================================================
// SchedulesConfig (Settings → Scheduled Prompts) regression tests.
//
// The audited hang: the tab stayed on "Loading schedules…" forever. Root cause
// was a StrictMode unsafe mounted flag — the cleanup-only reset left
// mountedRef.current === false after React 18's setup → cleanup → setup
// remount simulation, so every refresh() bailed before setJobs and the
// spinner never resolved. These tests mount under <React.StrictMode> to pin
// both the success path (spinner → empty state) and the failure path
// (spinner → visible error row, never an eternal spinner).
// ============================================================================

const jiti = createJiti(import.meta.url, {
  jsx: { runtime: "automatic" },
  tsconfigPaths: true,
  alias: {
    "@/components/ui/toast": fileURLToPath(new URL("../hooks/__fixtures__/toast-stub.mjs", import.meta.url)),
    "next/navigation": fileURLToPath(new URL("./__fixtures__/next-navigation-stub.mjs", import.meta.url)),
    "@/": fileURLToPath(new URL("../", import.meta.url)),
  },
});

const { SchedulesConfig } = await jiti.import("./SchedulesConfig.tsx");

const realFetch = globalThis.fetch;

afterEach(() => {
  cleanup();
  globalThis.fetch = realFetch;
});

function okSchedules(jobs = []) {
  return async (url) => {
    if (String(url).startsWith("/api/schedules")) {
      return new Response(JSON.stringify({ success: true, data: { paused: false, jobs } }), { status: 200 });
    }
    return new Response(JSON.stringify({}), { status: 200 });
  };
}

test("REGRESSION strict-mode mount resolves the job list (no eternal spinner)", async () => {
  globalThis.fetch = okSchedules([]);
  const view = render(React.createElement(React.StrictMode, null,
    React.createElement(SchedulesConfig),
  ));
  await waitFor(() => {
    assert.match(view.container.textContent ?? "", /No schedules yet/);
  }, { timeout: 2000 });
  assert.doesNotMatch(view.container.textContent ?? "", /Loading schedules/);
});

test("failed load surfaces a visible error row with retry, never a spinner", async () => {
  globalThis.fetch = async () => new Response(JSON.stringify({ error: "boom", code: "boom" }), { status: 500 });
  const view = render(React.createElement(React.StrictMode, null,
    React.createElement(SchedulesConfig),
  ));
  await waitFor(() => {
    assert.match(view.container.textContent ?? "", /Could not load schedules: boom/);
  }, { timeout: 2000 });
  assert.doesNotMatch(view.container.textContent ?? "", /Loading schedules/);
  assert.ok(view.getByRole("button", { name: "Retry" }), "retry button present");

  // Retry recovers into the normal empty state.
  globalThis.fetch = okSchedules([]);
  await act(async () => {
    view.getByRole("button", { name: "Retry" }).click();
  });
  await waitFor(() => {
    assert.match(view.container.textContent ?? "", /No schedules yet/);
  }, { timeout: 2000 });
});
