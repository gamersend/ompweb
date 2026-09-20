#!/usr/bin/env node
/**
 * Generates the AGENTS.md File Map counts line (BUILD-PLAN-2 Phase 0).
 *
 *   node scripts/gen-file-map.mjs           # print the counts line to stdout
 *   node scripts/gen-file-map.mjs --check   # exit 1 if the line between the
 *                                           # generated-counts markers in
 *                                           # AGENTS.md has drifted
 *
 * Pure Node stdlib (like scripts/gen-icons.mjs) — no new dependencies.
 * Counts follow the File Map's own listing rules: colocated *.test.mjs files
 * are omitted, and lib subdirectories are named in the "plus" list rather
 * than folded into the top-level lib figure.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const agentsPath = join(root, "AGENTS.md");

const BEGIN = "<!-- BEGIN GENERATED FILE-MAP COUNTS -->";
const END = "<!-- END GENERATED FILE-MAP COUNTS -->";

/** lib subdirectories named in the counts line, in canonical order. */
const LIB_SUBDIRS = [
  "omp",
  "i18n",
  "search",
  "notify",
  "push",
  "checkpoints",
  "snippets",
  "insights",
  "scheduler",
  "terminal",
  "live",
  "memory",
];

function listTopLevel(dir, extensions) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter(
      (entry) =>
        entry.isFile() &&
        !entry.name.includes(".test.") &&
        extensions.some((ext) => entry.name.endsWith(ext)),
    )
    .map((entry) => entry.name);
}

function walkApiRoutes(dir) {
  if (!existsSync(dir)) return 0;
  let count = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) count += walkApiRoutes(join(dir, entry.name));
    else if (entry.name === "route.ts") count += 1;
  }
  return count;
}

function computeCounts() {
  const apiRoutes = walkApiRoutes(join(root, "app", "api"));
  const components = listTopLevel(join(root, "components"), [".ts", ".tsx"]).length;
  const hooks = listTopLevel(join(root, "hooks"), [".ts"]).length;
  const libModules = listTopLevel(join(root, "lib"), [".ts"]).length;
  const binScripts = listTopLevel(join(root, "bin"), [".js"]).length;
  const libSubdirs = LIB_SUBDIRS.filter((name) =>
    existsSync(join(root, "lib", name)),
  ).map((name) => `\`lib/${name}/\``);
  return { apiRoutes, components, hooks, libModules, binScripts, libSubdirs };
}

function countsLine({
  apiRoutes,
  components,
  hooks,
  libModules,
  binScripts,
  libSubdirs,
}) {
  return (
    `Counts: ${apiRoutes} API routes, ${components} components, ${hooks} hooks, ` +
    `${libModules} lib modules plus ${libSubdirs.join(" + ")}, ` +
    `${binScripts} \`bin/\` scripts.`
  );
}

function checkAgentsMd(line) {
  const text = readFileSync(agentsPath, "utf8");
  const begin = text.indexOf(BEGIN);
  const end = text.indexOf(END);
  if (begin === -1 || end === -1 || end < begin) {
    console.error(
      `file-map:check: ${BEGIN} / ${END} markers not found in AGENTS.md`,
    );
    return 1;
  }
  const current = text.slice(begin + BEGIN.length, end).trim();
  if (current === line) {
    console.log("file-map:check: AGENTS.md counts are current.");
    return 0;
  }
  console.error("file-map:check: AGENTS.md counts have drifted.");
  console.error(`  expected: ${line}`);
  console.error(`  found:    ${current}`);
  console.error(
    "  Fix: run `node scripts/gen-file-map.mjs` and paste the line between the generated-counts markers in AGENTS.md.",
  );
  return 1;
}

const line = countsLine(computeCounts());
if (process.argv.includes("--check")) {
  process.exit(checkAgentsMd(line));
}
console.log(line);
