// P22.3 static architecture/privacy audit (same style as check-envelopes.mjs).
//
// Walks lib/, app/, components/, hooks/, bin/ (never node_modules, .next,
// tests, docs, or *.test.* files) and fails on any of:
//
//   1. forbidden-imports   — `@oh-my-pi/*` / `@earendil-works/*` anywhere.
//                            They are Bun-only and cannot run in Node/Next
//                            (the porting contract in DESIGN.md).
//   2. omp-owned-writes    — fs write calls (writeFileSync/renameSync/rmSync/
//                            createWriteStream/…) whose line, or a line within
//                            ±2 of it, names an omp-OWNED path (agent.db,
//                            stats.db, config.yml, config.json, sessions/,
//                            agent/…). ompweb must only ever write its own
//                            `web-*.json` / `web-*.jsonl` stores, snippets.json,
//                            projects.json, usage.db, and checkpoints/ under
//                            the agent dir — anything else touching omp's data
//                            is a corruption risk. Two detection tiers:
//                              A. write call ±2 lines of an omp path literal
//                              B. any non-comment omp path literal in a file
//                                 that contains a write call (catches paths
//                                 carried in variables to the write site)
//                            Matches that resolve to an ompweb-owned filename
//                            token (web-*, snippets.json, projects.json,
//                            usage.db, checkpoints/…) are auto-allowed; the
//                            remaining (small) hit list is judged by the
//                            explicit ALLOWLIST below, each entry with a reason.
//   3. secrets-in-logs     — console.* lines containing api_key/token/password/
//                            bearer/sk-… shapes. Values must never reach logs;
//                            naming a VARIABLE or an env-var NAME in guidance
//                            text is the only tolerated form (explicitly
//                            allowlisted with reasons below).
//   4. live-media-server   — Realtime/gpt-live-1/webrtc/getUserMedia under
//                            app/api/**. Server routes must never touch live
//                            audio/video media — the /live signaling route
//                            legitimately shells `omp token openai-codex` and
//                            the status route echoes the pinned model NAME
//                            (metadata only); both are allowlisted by file.
//   5. budget-enforcement  — spend-cap / budget-stop / auto-stop-on-cost
//                            wording anywhere in code. This feature does not
//                            exist; its appearance would mean a half-shipped
//                            mutation the user never asked for (docs only).
//   6. npm-publish         — `npm|yarn|bun publish` anywhere in code. Releases
//                            go through CI; a local publish would ship
//                            unreviewed work.
//
// Exit 1 on any finding that is neither auto-allowed nor explicitly
// allowlisted. 100% of hits must be fixed or allowlisted with a reason —
// no silent ignores.
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = fileURLToPath(new URL("../", import.meta.url));

export const DEFAULT_ROOTS = ["lib", "app", "components", "hooks", "bin"];
const SKIP_DIRS = new Set(["node_modules", ".next", "tests", "docs", ".git"]);
const SOURCE_FILE_RE = /\.(?:ts|tsx|js|mjs)$/;
const TEST_FILE_RE = /\.test\.(?:mjs|ts|tsx|js)$/;

/* ------------------------------- detectors -------------------------------- */

const FORBIDDEN_IMPORT_RE = /@oh-my-pi\/|@earendil-works\//;
const WRITE_CALL_RE = /\b(?:writeFileSync|appendFileSync|renameSync|rmSync|unlinkSync|truncateSync|writeSync|createWriteStream)\b/;
/** omp-OWNED path fragments (Tier A — full pattern). */
const OMP_OWNED_PATH_RE = /agent\.db|stats\.db|config\.yml|config\.json|sessions[\\/]|agent[\\/]/i;
/** Tier B drops bare `sessions/` — route URLs (/api/sessions/[id]) made it
 *  noise-only; the write-window tier A still watches for it. */
const OMP_OWNED_PATH_NO_SESSIONS_RE = /agent\.db|stats\.db|config\.yml|config\.json|agent[\\/]/i;
const CONSOLE_RE = /\bconsole\s*\.\s*(?:log|error|warn|info|debug|trace|fatal)\b/;
const SECRETISH_RE = /(?:api[_-]?key|token|password|bearer\s|sk-[A-Za-z0-9]{8})/i;
const LIVE_MEDIA_RE = /Realtime|gpt-live-1|webrtc|getUserMedia/i;
const BUDGET_RE = /spend[_ -]?cap|budget[_ -]?stop|auto[_ -]?stop.*(budget|cost)/i;
const PUBLISH_RE = /npm publish|yarn publish|bun publish/i;

const isCommentLine = (line) => {
  const trimmed = line.trim();
  return trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*");
};

/** Does the omp-owned path match sit inside an ompweb-OWNED filename token?
 *  e.g. the `config.json` inside `web-notify-config.json`, or the `agent/`
 *  of `~/.omp/agent/web-goals.json`. */
function isOmpwebOwnedToken(line, matched) {
  const ownedTail = /^(?:web-[\w.-]+|snippets\.json|projects\.json|usage\.db|checkpoints[\\/])/i;
  const ownedToken = /^(?:web-[\w.-]+|snippets\.json|projects\.json|usage\.db)$/i;
  const idx = line.indexOf(matched);
  if (idx < 0) return false;
  if (/^agent[\\/]/i.test(matched)) {
    return ownedTail.test(line.slice(idx + matched.length));
  }
  let start = idx;
  while (start > 0 && /[\w.\-/\\]/.test(line[start - 1])) start--;
  return ownedToken.test(line.slice(start, idx + matched.length));
}

/* ------------------------------- allowlist -------------------------------- */
// Every entry: a verified false positive, with the reason it is safe.
// `match` null = whole file allowlisted for the category.

export const ALLOWLIST = [
  // ── omp-owned writes ────────────────────────────────────────────────────────
  {
    category: "omp-owned-writes",
    file: "lib/omp/model-roles.ts",
    match: "config.yml",
    reason: "Sanctioned native-config editor (AGENTS: model-roles.ts reads/writes role selectors in the user's omp config.yml via /api/model-roles). Deliberate, documented feature — atomic YAML edit that preserves unrelated keys.",
  },
  {
    category: "omp-owned-writes",
    file: "lib/omp/mcp-config.ts",
    match: "config.json",
    reason: "Read-only discovery: the line adds a PROJECT-level dotfile config.json to a candidate list for reading MCP servers (filter(existsSync); only ever readFileSync/statSync). Writes in this file target the project mcp.json, not this path.",
  },
  // ── secrets in logs ─────────────────────────────────────────────────────────
  {
    category: "secrets-in-logs",
    file: "bin/omp-web.js",
    match: "OMP_WEB_PASSWORD (or --password)",
    reason: "Names the env var / flag so the operator can set it — prints no value.",
  },
  {
    category: "secrets-in-logs",
    file: "bin/omp-web.js",
    match: "protect the password and session cookie",
    reason: "Security guidance text; the word 'password', not a credential.",
  },
  {
    category: "secrets-in-logs",
    file: "bin/omp-web-launchd.js",
    match: "password is stored in plain text in the plist (mode 600)",
    reason: "Warns the operator where the secret lives (file permissions advice); prints no value.",
  },
  {
    category: "secrets-in-logs",
    file: "bin/omp-web-systemd.js",
    match: "(port/hostname/password — no reinstall needed)",
    reason: "Echoes the env FILE PATH and lists the keys it holds; never a value.",
  },
  {
    category: "secrets-in-logs",
    file: "bin/omp-web-systemd.js",
    match: "password is stored in the env file (mode 600)",
    reason: "Where-the-secret-lives notice; prints no value.",
  },
  // ── live-media server paths ─────────────────────────────────────────────────
  {
    category: "live-media-server",
    file: "app/api/live/signaling/route.ts",
    match: null,
    reason: "The sanctioned /live signaling route: one OAuth'd `omp token openai-codex` shell for SDP exchange. No audio/video/WebRTC traffic ever flows through the server (AGENTS live-voice contract, test-enforced in lib/live-source.test.mjs).",
  },
  {
    category: "live-media-server",
    file: "app/api/live/status/route.ts",
    match: null,
    reason: "Metadata-only gate probe; echoes the pinned model NAME 'gpt-live-1-codex' so the UI can show availability. No media handling.",
  },
];

function allowlisted(category, rel, line, matched) {
  for (const entry of ALLOWLIST) {
    if (entry.category !== category || entry.file !== rel) continue;
    if (entry.match === null) return true;
    if (line.includes(entry.match)) return true;
    if (matched !== undefined && (matched.includes(entry.match) || entry.match.includes(matched))) return true;
  }
  return false;
}

/* --------------------------------- scanner --------------------------------- */

export function walkFiles(dir, baseDir = dir, out = []) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      walkFiles(full, baseDir, out);
    } else if (entry.isFile() && SOURCE_FILE_RE.test(entry.name) && !TEST_FILE_RE.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

function pushFinding(findings, seen, category, rel, lineNo, line, matched) {
  const key = `${category}\u0000${rel}\u0000${lineNo}\u0000${matched ?? ""}`;
  if (seen.has(key)) return;
  seen.add(key);
  findings.push({ category, rel, line: lineNo, text: line.trim(), matched });
}

/** Scan one directory root set. Returns RAW findings (before allowlisting).
 *  `bypassAllowlist` also disables the explicit ALLOWLIST (the auto ompweb-
 *  owned token rule still applies) — used by the tests to prove every
 *  allowlist entry corresponds to a real detector hit. */
export function scanRoots(baseDir, roots = DEFAULT_ROOTS, { bypassAllowlist = false } = {}) {
  const findings = [];
  const seen = new Set();
  for (const root of roots) {
    for (const full of walkFiles(join(baseDir, root), baseDir)) {
      const rel = relative(baseDir, full).replaceAll("\\", "/");
      const lines = readFileSync(full, "utf8").split(/\r?\n/);
      const fileHasWriteCall = lines.some((line) => WRITE_CALL_RE.test(line));

      for (let i = 0; i < lines.length; i += 1) {
        const line = lines[i];

        if (FORBIDDEN_IMPORT_RE.test(line)) {
          pushFinding(findings, seen, "forbidden-imports", rel, i + 1, line, line.match(FORBIDDEN_IMPORT_RE)[0]);
        }

        // omp-owned writes — tier A: omp path literal within ±2 lines of a write call.
        const ownedA = line.match(new RegExp(OMP_OWNED_PATH_RE.source, "gi"));
        if (ownedA) {
          const nearWrite = [i - 2, i - 1, i, i + 1, i + 2].some(
            (j) => j >= 0 && j < lines.length && WRITE_CALL_RE.test(lines[j]),
          );
          if (nearWrite) {
            for (const matched of ownedA) {
              if (isOmpwebOwnedToken(line, matched)) continue;
              if (!bypassAllowlist && allowlisted("omp-owned-writes", rel, line, matched)) continue;
              pushFinding(findings, seen, "omp-owned-writes", rel, i + 1, line, matched);
            }
          }
        }
        // tier B: non-comment omp path literal anywhere in a write-capable file.
        if (fileHasWriteCall && !isCommentLine(line)) {
          const ownedB = line.match(new RegExp(OMP_OWNED_PATH_NO_SESSIONS_RE.source, "gi"));
          for (const matched of ownedB ?? []) {
            if (isOmpwebOwnedToken(line, matched)) continue;
            if (!bypassAllowlist && allowlisted("omp-owned-writes", rel, line, matched)) continue;
            pushFinding(findings, seen, "omp-owned-writes", rel, i + 1, line, matched);
          }
        }

        if (CONSOLE_RE.test(line) && SECRETISH_RE.test(line)) {
          if (bypassAllowlist || !allowlisted("secrets-in-logs", rel, line)) {
            pushFinding(findings, seen, "secrets-in-logs", rel, i + 1, line, line.match(SECRETISH_RE)[0]);
          }
        }

        if (rel.startsWith("app/api/") && LIVE_MEDIA_RE.test(line)) {
          if (bypassAllowlist || !allowlisted("live-media-server", rel, line)) {
            pushFinding(findings, seen, "live-media-server", rel, i + 1, line, line.match(LIVE_MEDIA_RE)[0]);
          }
        }

        if (BUDGET_RE.test(line)) {
          pushFinding(findings, seen, "budget-enforcement", rel, i + 1, line, line.match(BUDGET_RE)[0]);
        }

        if (PUBLISH_RE.test(line)) {
          pushFinding(findings, seen, "npm-publish", rel, i + 1, line, line.match(PUBLISH_RE)[0]);
        }
      }
    }
  }
  return findings;
}

export const CATEGORIES = [
  "forbidden-imports",
  "omp-owned-writes",
  "secrets-in-logs",
  "live-media-server",
  "budget-enforcement",
  "npm-publish",
];

/** Full audit: findings + per-category counts. Findings returned are the
 *  NON-allowlisted ones only; allowlisted hits are counted separately. */
export function runAudit({ baseDir = repoRoot, roots = DEFAULT_ROOTS } = {}) {
  const findings = scanRoots(baseDir, roots);
  return {
    findings,
    byCategory: Object.fromEntries(CATEGORIES.map((category) => [
      category,
      findings.filter((finding) => finding.category === category).length,
    ])),
  };
}

/* ---------------------------------- main ----------------------------------- */

function main() {
  const { findings, byCategory } = runAudit();
  if (findings.length > 0) {
    console.error(`privacy audit FAILED — ${findings.length} unallowlisted finding(s):`);
    for (const finding of findings) {
      console.error(`  - [${finding.category}] ${finding.rel}:${finding.line} (${finding.matched})`);
      console.error(`      ${finding.text.slice(0, 160)}`);
    }
  }
  const files = DEFAULT_ROOTS.reduce(
    (count, root) => count + walkFiles(join(repoRoot, root), repoRoot).length,
    0,
  );
  const summary = CATEGORIES.map(
    (category) => `${category}: ${byCategory[category]} flagged`,
  ).join(", ");
  if (findings.length === 0) {
    console.log(`privacy audit OK — ${files} files checked; ${summary}; ${ALLOWLIST.length} verified allowlist entr${ALLOWLIST.length === 1 ? "y" : "ies"}`);
    return 0;
  }
  return 1;
}

const invokedDirectly = process.argv[1]
  && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (invokedDirectly) process.exitCode = main();
