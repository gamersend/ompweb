import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  alias: {
    "@/": new URL("../", import.meta.url).pathname,
  },
});
const { PUT, GET } = await jiti.import("../app/api/files/[...path]/route.ts");
const { EDITOR_MAX_BYTES } = await jiti.import("../lib/file-types.ts");
const { allowFileRoot } = await jiti.import("../lib/file-access.ts");
const { NextRequest } = await jiti.import("next/server");

let root;
let allowedDir;
let foreignDir;
let savedRootsCache;

/** The allow-root set is environment-derived (real session cwds), so tests
 *  pin the in-process cache to exactly the fixture roots. Restored after. */
function pinRoots() {
  globalThis.__piAllowedRootsCache = {
    roots: new Set([allowedDir.replace(/\\/g, "/")]),
    expiresAt: Date.now() + 60_000,
  };
}

async function putFile(absPath, body) {
  pinRoots();
  const segments = absPath.replace(/\\/g, "/").split("/").filter(Boolean);
  const request = new NextRequest("http://localhost/api/files/x", {
    method: "PUT",
    body: typeof body === "string" ? body : JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
  return PUT(request, { params: Promise.resolve({ path: segments }) });
}

async function getEdit(absPath) {
  pinRoots();
  const segments = absPath.replace(/\\/g, "/").split("/").filter(Boolean);
  const request = new NextRequest("http://localhost/api/files/x?type=edit");
  return GET(request, { params: Promise.resolve({ path: segments }) });
}

test("files PUT route guards", async (t) => {
  root = mkdtempSync(join(tmpdir(), "omp-web-files-put-"));
  t.after(() => {
    rmSync(root, { recursive: true, force: true });
    globalThis.__piAllowedRootsCache = savedRootsCache;
  });
  savedRootsCache = globalThis.__piAllowedRootsCache;
  allowedDir = join(root, "allowed");
  foreignDir = join(root, "foreign");
  mkdirSync(allowedDir, { recursive: true });
  mkdirSync(foreignDir, { recursive: true });
  allowFileRoot(allowedDir.replace(/\\/g, "/"));
  pinRoots();

  await t.test("writes the exact bytes atomically and returns size + mtime", async () => {
    const target = join(allowedDir, "edit-me.ts");
    writeFileSync(target, "old\n");
    const content = "\uFEFFconst x = 1;\r\nconst s = \"π\";\r\n";
    const res = await putFile(target, { content });
    assert.equal(res.status, 200);
    const data = await res.json();
    // Bytes-as-sent: BOM and CRLF must survive the round trip untouched.
    assert.equal(readFileSync(target, "utf-8"), content);
    assert.equal(data.size, Buffer.byteLength(content, "utf8"));
    assert.ok(!Number.isNaN(Date.parse(data.mtime)), "mtime must be an ISO date");
    // Atomic swap: no temp leftovers in the target directory.
    assert.deepEqual(readdirSync(allowedDir).filter((n) => n.endsWith(".tmp")), []);
  });

  await t.test("rejects paths outside the allow roots", async () => {
    const target = join(foreignDir, "no.txt");
    writeFileSync(target, "x\n");
    const res = await putFile(target, { content: "y\n" });
    assert.equal(res.status, 403);
    assert.equal((await res.json()).code, "access_denied");
    assert.equal(readFileSync(target, "utf-8"), "x\n");
  });

  await t.test("refuses a symlink/junction parent that escapes the roots", async (t2) => {
    const inside = join(allowedDir, "outside-link");
    const outside = mkdtempSync(join(tmpdir(), "omp-web-put-escape-"));
    t2.after(() => rmSync(outside, { recursive: true, force: true }));
    writeFileSync(join(outside, "secret.txt"), "keep\n");
    try {
      symlinkSync(outside, inside, "junction");
    } catch {
      t2.skip("symlink/junction creation is not permitted on this host");
      return;
    }
    const res = await putFile(join(inside, "secret.txt"), { content: "pwn\n" });
    assert.equal(res.status, 403);
    assert.equal(readFileSync(join(outside, "secret.txt"), "utf-8"), "keep\n");
  });

  await t.test("refuses a symlinked destination file", async (t2) => {
    const realFile = join(allowedDir, "real.txt");
    writeFileSync(realFile, "real\n");
    const link = join(allowedDir, "link.txt");
    try {
      symlinkSync(realFile, link, "file");
    } catch {
      t2.skip("symlink creation is not permitted on this host");
      return;
    }
    const res = await putFile(link, { content: "swap\n" });
    assert.equal(res.status, 403);
    assert.equal((await res.json()).code, "symlink_not_allowed");
    assert.equal(readFileSync(realFile, "utf-8"), "real\n");
  });

  await t.test("enforces the 2 MB content cap after decoding", async () => {
    const target = join(allowedDir, "big.txt");
    writeFileSync(target, "x\n");
    const res = await putFile(target, { content: "a".repeat(EDITOR_MAX_BYTES + 1) });
    assert.equal(res.status, 413);
    assert.equal((await res.json()).code, "file_too_large_edit");
    // Newlines double on the wire but the decoded cap is checked on the real
    // content bytes: 2MB+1 newlines must still trip the post-decode limit.
    const res2 = await putFile(target, { content: "\n".repeat(EDITOR_MAX_BYTES + 1) });
    assert.equal(res2.status, 413);
    // Exactly at the cap is allowed.
    const res3 = await putFile(target, { content: "a".repeat(EDITOR_MAX_BYTES) });
    assert.equal(res3.status, 200);
  });

  await t.test("bounds the wire body before decoding", async () => {
    const target = join(allowedDir, "huge.txt");
    writeFileSync(target, "x\n");
    // JSON-escaped body exceeds the wire budget (cap*4 + 64KB headroom).
    const res = await putFile(target, { content: "\n".repeat(EDITOR_MAX_BYTES * 3 + 128 * 1024) });
    assert.equal(res.status, 413);
  });

  await t.test("rejects binary extensions with 403", async () => {
    const target = join(allowedDir, "logo.png");
    writeFileSync(target, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const res = await putFile(target, { content: "text" });
    assert.equal(res.status, 403);
    assert.equal((await res.json()).code, "file_not_editable");
    const editRes = await getEdit(target);
    assert.equal(editRes.status, 403);
  });

  await t.test("404s missing files and 400s directory targets", async () => {
    const missing = join(allowedDir, "missing.txt");
    assert.equal((await putFile(missing, { content: "x" })).status, 404);
    const dir = join(allowedDir, "a-dir");
    mkdirSync(dir, { recursive: true });
    const res = await putFile(dir, { content: "x" });
    assert.equal(res.status, 400);
    assert.equal((await res.json()).code, "not_a_file");
  });

  await t.test("400s malformed bodies", async () => {
    const target = join(allowedDir, "edit-me.ts");
    const badJson = await putFile(target, "{not json");
    assert.equal(badJson.status, 400);
    const noContent = await putFile(target, { data: "x" });
    assert.equal(noContent.status, 400);
  });

  await t.test("GET type=edit serves text content with mtime inside the cap", async () => {
    const target = join(allowedDir, "edit-me.ts");
    const res = await getEdit(target);
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.language, "typescript");
    assert.ok(data.content.startsWith("\uFEFFconst x = 1;"));
    assert.ok(!Number.isNaN(Date.parse(data.mtime)));
  });

  await t.test("GET type=edit 413s over the cap", async () => {
    const big = join(allowedDir, "too-big.txt");
    writeFileSync(big, "a".repeat(EDITOR_MAX_BYTES + 1));
    const res = await getEdit(big);
    assert.equal(res.status, 413);
    assert.equal((await res.json()).code, "file_too_large_edit");
  });
});
