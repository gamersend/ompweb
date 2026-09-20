import { WEB_SLASH_COMMANDS } from "@/lib/web-slash-commands";
import { snippetsForProject } from "@/lib/snippets/scope";
import { parsePlaceholders } from "@/lib/snippets/placeholders";

export type SlashCommandSource = "builtin" | "snippet" | "extension" | "prompt" | "skill" | "ompBuiltin";

export type SlashCommandPaletteItem = {
  name: string;
  description?: string;
  /** Bracketed argument hint rendered after the command name, e.g. "[goal]". */
  argumentHint?: string;
  source: SlashCommandSource;
  /** Snippet scope: project snippets carry their canonical root for the
   *  project/global badge; undefined for non-snippet sources. */
  projectRoot?: string | null;
};

/**
 * Minimal snippet shape the palette needs (structural — client code never
 * imports the fs-backed store module).
 */
export interface SnippetScopeItem {
  id: string;
  name: string;
  body: string;
  projectRoot: string | null;
}

/** The reserved /snippets manager entry. Because "snippets" is a reserved
 *  command name, a palette row with source "snippet" and this name is always
 *  the manager entry, never a user snippet. */
export const SNIPPETS_MANAGE_COMMAND_NAME = "snippets";

/** First line of a body, capped for the two-line palette row preview. */
function snippetPreview(body: string): string {
  const firstLine = body.split("\n", 1)[0] ?? "";
  return firstLine.length > 120 ? `${firstLine.slice(0, 119)}…` : firstLine;
}

/**
 * Palette rows for the user's snippet library, filtered as-you-type by the
 * same generic name/description matcher as every other source.
 *
 * No-shadow rule: fixed commands always win. `snippetsForProject` drops any
 * snippet whose name collides with a reserved builtin command, so the menu
 * can never offer a row that lib/snippets' resolveSlash would refuse —
 * enforced here in addition to the write-time rejection in
 * lib/snippets/scope.ts (which a hand-edited store file could bypass).
 */
export function buildSnippetSlashCommands(snippets: readonly SnippetScopeItem[], projectRoot: string | null): SlashCommandPaletteItem[] {
  return snippetsForProject(snippets, projectRoot)
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((snippet) => ({
      name: snippet.name,
      description: snippetPreview(snippet.body),
      ...(parsePlaceholders(snippet.body).length > 0
        ? { argumentHint: parsePlaceholders(snippet.body).map((placeholder) => `$${placeholder}`).join(" ") }
        : {}),
      source: "snippet" as const,
      projectRoot: snippet.projectRoot,
    }));
}

export function isDormantSkillCommand(command: SlashCommandPaletteItem, dormantNames: Set<string>): boolean {
  return command.source === "skill" && dormantNames.has(command.name);
}

export const BUILTIN_SLASH_COMMAND_DEFS: { name: string; descriptionKey: string; argumentHintKey?: string }[] = [
  // Web-native prompt-composing commands (goal/plan/... are TUI-only in omp and
  // never execute over the RPC prompt path — see lib/web-slash-commands.ts).
  ...WEB_SLASH_COMMANDS.map((command) => ({
    name: command.name,
    descriptionKey: command.descriptionKey,
    argumentHintKey: command.argumentHintKey,
  })),
  { name: "compact", descriptionKey: "chatInput.cmdCompact" },
  { name: "reload", descriptionKey: "chatInput.cmdReload" },
  { name: "name", descriptionKey: "chatInput.cmdName" },
  { name: "session", descriptionKey: "chatInput.cmdSession" },
  { name: "copy", descriptionKey: "chatInput.cmdCopy" },
  // Live voice: opens the browser-direct Codex live panel (server only
  // brokers the handshake; media + transcripts never touch it).
  { name: "live", descriptionKey: "chatInput.cmdLive" },
];

export const CLIENT_BUILTIN_COMMAND_NAMES = new Set(BUILTIN_SLASH_COMMAND_DEFS.map((def) => def.name));

export const SLASH_SOURCES: SlashCommandSource[] = ["builtin", "snippet", "extension", "prompt", "skill", "ompBuiltin"];

export const SLASH_SOURCE_GROUP_LABEL_KEYS: Record<SlashCommandSource, string> = {
  builtin: "chatInput.groupBuiltin",
  snippet: "snippets.groupLabel",
  extension: "chatInput.groupExtensions",
  prompt: "chatInput.groupPrompts",
  skill: "chatInput.groupSkills",
  ompBuiltin: "chatInput.groupOmpBuiltin",
};

export const SLASH_SOURCE_ORDER: Record<SlashCommandSource, number> = {
  builtin: 0,
  snippet: 1,
  extension: 2,
  prompt: 3,
  skill: 4,
  ompBuiltin: 5,
};

export function slashMatchRank(command: SlashCommandPaletteItem, query: string): number {
  const name = command.name.toLowerCase();
  const description = command.description?.toLowerCase() ?? "";
  if (name === query) return 0;
  if (name.startsWith(query)) return 1;
  if (name.includes(query)) return 2;
  if (description.includes(query)) return 3;
  return 4;
}
