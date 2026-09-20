import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";
import { fileURLToPath } from "node:url";

// Contract test for the 6c `?format=md` branch of the session export route:
// same fixture discipline as session-routes.test.mjs (throwaway agent dir +
// real session files resolved through the session path cache).
const jiti = createJiti(import.meta.url, {
  alias: {
    "@/": fileURLToPath(new URL("../", import.meta.url)),
  },
});
const exportRoute = await jiti.import("../app/api/sessions/[id]/export/route.ts");
const { invalidateSessionListCache } = await jiti.import("./session-reader.ts");

const getExport = (id, query = "") => exportRoute.GET(
  new Request(`http://localhost/api/sessions/${id}/export${query}`),
  { params: Promise.resolve({ id }) },
);

/** Point the omp agent dir at a throwaway location for the duration of `run`. */
async function withAgentDir(run) {
  const agentDir = mkdtempSync(join(tmpdir(), "omp-web-export-route-"));
  const projectDir = join(agentDir, "sessions", "-project");
  mkdirSync(projectDir, { recursive: true });
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  invalidateSessionListCache();
  try {
    await run(projectDir);
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    invalidateSessionListCache();
    rmSync(agentDir, { recursive: true, force: true });
  }
}

function writeSessionFile(dir, name, header, entries = []) {
  const filePath = join(dir, name);
  const lines = [JSON.stringify({ type: "session", version: 3, ...header })];
  for (const entry of entries) lines.push(JSON.stringify(entry));
  writeFileSync(filePath, `${lines.join("\n")}\n`);
  return filePath;
}

const ENTRY = (id, parentId, message) => ({ type: "message", id, parentId, timestamp: "2026-09-19T00:00:00.000Z", message });

function fixtureEntries() {
  return [
    ENTRY("u1", null, { role: "user", content: "please run the tests" }),
    ENTRY("a1", "u1", {
      role: "assistant",
      provider: "acme",
      model: "model-x",
      stopReason: "stop",
      content: [
        { type: "thinking", thinking: "check package.json" },
        { type: "text", text: "Running now." },
        { type: "toolCall", id: "call_1", name: "bash", arguments: { command: "npm test" } },
      ],
    }),
    ENTRY("t1", "a1", {
      role: "toolResult",
      toolCallId: "call_1",
      toolName: "bash",
      content: [{ type: "text", text: "3 passed" }],
    }),
  ];
}

test("export route ?format=md renders the session in-process as markdown", async () => {
  await withAgentDir(async (dir) => {
    writeSessionFile(dir, "2026-09-19_test-session.jsonl", {
      id: "md-session",
      title: "Test session",
      cwd: "/project",
      timestamp: "2026-09-19T00:00:00.000Z",
    }, fixtureEntries());

    const res = await getExport("md-session", "?format=md");
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /text\/markdown/);
    const disposition = res.headers.get("content-disposition") ?? "";
    assert.match(disposition, /filename="omp-session-2026-09-19_test-session\.md"/);
    assert.match(disposition, /\.md/);

    const md = await res.text();
    assert.match(md, /^# Test session\n/);
    assert.match(md, /- Session: md-session/);
    assert.match(md, /## User\n\nplease run the tests/);
    // File-format tool calls ({id,name,arguments}) come out NORMALIZED.
    assert.match(md, /```tool:bash\n\{\n  "toolCallId": "call_1",\n  "toolName": "bash",\n  "input": \{\n    "command": "npm test"\n  \}\n}\n```/);
    assert.match(md, /<summary>Tool result: bash<\/summary>/);
    assert.match(md, /<summary>Thinking<\/summary>/);
  });
});

test("export route ?format=md keeps blob image refs instead of base64", async () => {
  await withAgentDir(async (dir) => {
    writeSessionFile(dir, "2026-09-19_blob-session.jsonl", {
      id: "blob-session",
      title: "Blob session",
      cwd: "/project",
      timestamp: "2026-09-19T00:00:00.000Z",
    }, [
      ENTRY("u1", null, {
        role: "user",
        content: [
          { type: "text", text: "screenshot attached" },
          { type: "image", data: "blob:sha256:deadbeef", mimeType: "image/png" },
        ],
      }),
    ]);

    const res = await getExport("blob-session", "?format=md");
    assert.equal(res.status, 200);
    const md = await res.text();
    assert.match(md, /!\[image\]\(blob:sha256:deadbeef\)/);
    assert.ok(!md.includes("base64,"));
  });
});

test("export route ?format=md returns 404 for unknown sessions", async () => {
  await withAgentDir(async () => {
    const res = await getExport("does-not-exist", "?format=md");
    assert.equal(res.status, 404);
    const body = await res.json();
    assert.equal(body.code, "session_not_found");
  });
});

test("export route keeps the HTML branch (omp shell-out) when format is absent", async () => {
  await withAgentDir(async (dir) => {
    writeSessionFile(dir, "2026-09-19_html-session.jsonl", {
      id: "html-session",
      title: "HTML session",
      cwd: "/project",
      timestamp: "2026-09-19T00:00:00.000Z",
    }, fixtureEntries());
    // Force the "omp not installed" path regardless of the host: a real omp
    // on PATH would make this test shell out. A nonexistent override resolves
    // to null without ever spawning anything (first resolveOmpBin call in
    // this process, so no prior cache hit can bypass the override).
    const previousOverride = process.env.OMP_WEB_OMP_BIN;
    process.env.OMP_WEB_OMP_BIN = join(tmpdir(), "omp-web-missing-omp-binary");
    try {
      const res = await getExport("html-session");
      assert.equal(res.status, 500);
      const body = await res.json();
      assert.equal(body.code, "omp_not_found");
    } finally {
      if (previousOverride === undefined) delete process.env.OMP_WEB_OMP_BIN;
      else process.env.OMP_WEB_OMP_BIN = previousOverride;
    }
  });
});
