import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { canWebShare, shareFileRecommended, shareText } = await jiti.import("./web-share.ts");

// Minimal AbortError-shaped rejection (a DOMException look-alike is enough —
// the mapping only needs the thrown value, never its class).
function rejectWithAbort() {
  const err = new Error("The user aborted a request.");
  err.name = "AbortError";
  return Promise.reject(err);
}

test("canWebShare detects the share function", () => {
  assert.equal(canWebShare(undefined), false, "no navigator at all");
  assert.equal(canWebShare({}), false, "navigator without share");
  assert.equal(canWebShare({ share: "not a function" }), false, "share that is not callable");
  assert.equal(canWebShare({ share: async () => {} }), true);
});

test("canWebShare survives a throwing navigator access", () => {
  const hostile = new Proxy({}, {
    get() {
      throw new Error("no navigator for you");
    },
  });
  assert.equal(canWebShare(hostile), false);
});

test("the real (Node) default navigator has no share — the production default path degrades to unsupported", async () => {
  assert.equal(canWebShare(), false);
  assert.equal(await shareText("t", "x"), "unsupported");
});

test("shareText maps resolve → shared and forwards {title, text}", async () => {
  let seen;
  const outcome = await shareText("Session export", "markdown body", {
    navigator: {
      share: async (data) => {
        seen = data;
      },
    },
  });
  assert.equal(outcome, "shared");
  assert.deepEqual(seen, { title: "Session export", text: "markdown body" });
});

test("shareText maps AbortError → cancelled (user closed the sheet)", async () => {
  const outcome = await shareText("t", "x", {
    navigator: { share: () => rejectWithAbort() },
  });
  assert.equal(outcome, "cancelled");
});

test("shareText maps every other rejection → cancelled and never throws", async () => {
  assert.equal(await shareText("t", "x", { navigator: { share: () => Promise.reject(new TypeError("bad")) } }), "cancelled");
  assert.equal(await shareText("t", "x", { navigator: { share: () => Promise.reject("not an error") } }), "cancelled");
  assert.equal(await shareText("t", "x", { navigator: { share: () => { throw new Error("sync"); } } }), "cancelled");
});

test("shareText reports unsupported when share is missing, without invoking anything", async () => {
  const outcome = await shareText("t", "x", { navigator: {} });
  assert.equal(outcome, "unsupported");
});

test("shareFileRecommended requires share + canShare + a File constructor", () => {
  const FileCtor = class {
    constructor(parts, name, options) {
      this.parts = parts;
      this.name = name;
      this.type = options?.type;
    }
  };
  const md = "# session\ncontent";
  const env = {
    navigator: {
      share: async () => {},
      canShare: (data) => {
        const file = data.files[0];
        return file instanceof FileCtor && file.type === "text/markdown";
      },
    },
    FileCtor,
  };
  assert.equal(shareFileRecommended(md, "session.md", env), true);

  assert.equal(
    shareFileRecommended(md, "session.md", { navigator: { canShare: () => true }, FileCtor }),
    false,
    "canShare without share is not enough",
  );
  assert.equal(
    shareFileRecommended(md, "session.md", { navigator: { share: async () => {} }, FileCtor }),
    false,
    "share without canShare is not enough",
  );
  assert.equal(
    shareFileRecommended(md, "session.md", { navigator: { share: async () => {}, canShare: () => false }, FileCtor }),
    false,
    "canShare answering false blocks it",
  );
});

test("shareFileRecommended with NO File constructor anywhere → false", () => {
  // Node 20+ exposes a global File; hide it for this branch, restore after.
  const hadFile = "File" in globalThis;
  const realFile = globalThis.File;
  delete globalThis.File;
  try {
    assert.equal(
      shareFileRecommended("md", "x.md", { navigator: { share: async () => {}, canShare: () => true } }),
      false,
    );
  } finally {
    if (hadFile) globalThis.File = realFile;
  }
});

test("shareFileRecommended hands canShare a text/markdown File of the markdown", () => {
  let constructed = null;
  let shared = null;
  class FileLike {
    constructor(parts, name, options) {
      this.parts = parts;
      this.name = name;
      this.type = options?.type;
      constructed = { parts, name, type: options?.type };
    }
  }
  const md = "# hello";
  const outcome = shareFileRecommended(md, "export.md", {
    navigator: {
      share: async () => {},
      canShare: (data) => {
        shared = data.files;
        return true;
      },
    },
    FileCtor: FileLike,
  });
  assert.equal(outcome, true);
  assert.equal(shared.length, 1);
  assert.ok(shared[0] instanceof FileLike);
  assert.deepEqual(constructed, { parts: [md], name: "export.md", type: "text/markdown" });
});

test("shareFileRecommended never throws — hostile canShare or File still yields false", () => {
  const env = {
    navigator: {
      share: async () => {},
      canShare: () => {
        throw new Error("boom");
      },
    },
    FileCtor: class {
      constructor() {
        throw new Error("boom");
      }
    },
  };
  assert.equal(shareFileRecommended("md", "x.md", env), false);
});
