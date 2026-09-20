/**
 * Pure session → Markdown renderer (6c). Input is the display context built by
 * `buildSessionContext` plus the session's header metadata; output is a
 * portable Markdown document.
 *
 * Contract (BUILD-PLAN 6c):
 * - title + meta block up top;
 * - user/assistant sections;
 * - toolCalls as ` ```tool:<name> ` fenced NORMALIZED JSON (the renderer
 *   receives already-normalized messages from buildSessionContext, and fences
 *   are sized so tool input containing backticks cannot break them);
 * - toolResults and thinking collapse into `<details>` with a 4 KB body cap;
 * - the active compaction renders as a blockquote;
 * - image blobs render as `![image](blob:<ref>)` — never inlined base64.
 */

import type {
  AgentMessage,
  AssistantContentBlock,
  AssistantMessage,
  CustomMessage,
  ImageContent,
  SessionContext,
  ToolResultMessage,
  UserMessage,
} from "./types";

export const MARKDOWN_DETAILS_BODY_CAP = 4096;

export interface SessionMarkdownMeta {
  title: string;
  sessionId?: string;
  cwd?: string;
  created?: string;
  /** "provider/modelId" resolved on the selected branch, when known. */
  model?: string | null;
}

interface RenderOptions {
  /** Body cap for <details> sections (tool results, thinking). */
  detailsBodyCap?: number;
}

function isImageBlock(block: AssistantContentBlock | { type: string }): block is ImageContent {
  return (block as { type: string }).type === "image";
}

/** `![image](blob:<ref>)` — blob refs stay refs; inline base64 is never
 *  inlined into the export (megabytes of payload would make the document
 *  unusable); URL-backed images keep their URL. */
function imageMarkdown(block: ImageContent): string {
  if (typeof block.data === "string" && block.data.startsWith("blob:")) {
    return `![image](${block.data})`;
  }
  if (block.source?.type === "url" && typeof block.source.url === "string" && block.source.url) {
    return `![image](${block.source.url})`;
  }
  return "![image](blob:inline-base64)";
}

/** Text of a string-or-blocks content, with images rendered as refs. */
function contentToText(content: string | Array<TextBlockLike>): string {
  if (typeof content === "string") return content;
  const parts: string[] = [];
  for (const block of content) {
    if (block.type === "text" && typeof block.text === "string") parts.push(block.text);
    else if (isImageBlock(block)) parts.push(imageMarkdown(block));
  }
  return parts.join("\n\n");
}

type TextBlockLike = { type: string; text?: string };

/** Cut at a code-point boundary so a cap never splits a surrogate pair. */
function capBody(body: string, cap: number): string {
  const trimmed = body.replace(/^\n+|\n+$/g, "");
  if (trimmed.length <= cap) return trimmed;
  const kept = [...trimmed.slice(0, cap)].join("");
  return `${kept}\n\n*[truncated — ${trimmed.length.toLocaleString("en-US")} characters total]*`;
}

/** CommonMark fence: one longer than the longest backtick run inside, so tool
 *  payloads that contain code fences cannot break out of their own. */
function fencedBlock(info: string, body: string): string {
  const longest = body.match(/`{3,}/g)?.reduce((max, run) => Math.max(max, run.length), 0) ?? 0;
  const fence = "`".repeat(Math.max(3, longest + 1));
  return `${fence}${info}\n${body}\n${fence}`;
}

function detailsSection(summary: string, body: string, cap: number): string {
  return [
    "<details>",
    `<summary>${escapeHtmlSummary(summary)}</summary>`,
    "",
    capBody(body, cap),
    "",
    "</details>",
  ].join("\n");
}

/** Summaries are author-controlled (tool names, ids); keep them on one line
 *  and inert as HTML by stripping angle brackets. */
function escapeHtmlSummary(summary: string): string {
  return summary.replace(/[<>&\n\r]/g, (ch) => (
    ch === "<" ? "&lt;" : ch === ">" ? "&gt;" : ch === "&" ? "&amp;" : " "
  ));
}

function renderUser(message: UserMessage): string[] {
  const out = ["## User", ""];
  const text = contentToText(message.content).trim();
  if (text) out.push(text);
  else out.push("*(no text)*");
  return out;
}

function renderAssistant(message: AssistantMessage, options: Required<Pick<RenderOptions, "detailsBodyCap">>): string[] {
  const out: string[] = ["## Assistant", ""];
  const content = Array.isArray(message.content) ? message.content : [];
  for (const block of content) {
    if (block.type === "text") {
      if (typeof block.text === "string" && block.text.trim()) {
        out.push(block.text, "");
      }
    } else if (block.type === "thinking") {
      const thinking = typeof block.thinking === "string" ? block.thinking : "";
      if (thinking.trim()) {
        out.push(detailsSection("Thinking", thinking, options.detailsBodyCap), "");
      }
    } else if (block.type === "toolCall") {
      // Normalized block shape ({toolCallId, toolName, input}) — the same
      // normalization every other ompweb reader applies (lib/normalize.ts).
      const payload = JSON.stringify({ toolCallId: block.toolCallId, toolName: block.toolName, input: block.input }, null, 2);
      out.push(fencedBlock(`tool:${block.toolName || "unknown"}`, payload), "");
    } else if (isImageBlock(block)) {
      out.push(imageMarkdown(block), "");
    }
  }
  if (message.stopReason && message.stopReason !== "stop") {
    out.push(`*(stopped: ${message.stopReason}${message.errorMessage ? ` — ${message.errorMessage}` : ""})*`, "");
  }
  return out;
}

function renderToolResult(message: ToolResultMessage, cap: number): string[] {
  const name = message.toolName || message.toolCallId || "tool";
  const summary = `Tool result: ${name}${message.isError ? " (error)" : ""}`;
  const parts: string[] = [];
  const content = Array.isArray(message.content) ? message.content : [];
  for (const block of content) {
    if (block.type === "text" && typeof block.text === "string") parts.push(block.text);
    else if (isImageBlock(block)) parts.push(imageMarkdown(block));
  }
  return [detailsSection(summary, parts.join("\n\n") || "(no output)", cap), ""];
}

function renderCustom(message: CustomMessage): string[] {
  const text = contentToText(message.content).replace(/^\n+|\n+$/g, "");
  if (!text) return [];
  // The active compaction summary renders as the blockquote the plan asks
  // for; other omp custom messages (developer notes, python runs, file
  // mentions) stay visible as labeled italic blockquotes.
  if (message.customType === "compaction") {
    return [text.split("\n").map((line) => `> ${line}`).join("\n"), ""];
  }
  return [`> *${escapeHtmlSummary(message.customType)}*: ${text.split("\n").join("\n> ")}`, ""];
}

function renderMessage(message: AgentMessage, options: Required<Pick<RenderOptions, "detailsBodyCap">>): string[] {
  switch (message.role) {
    case "user": return renderUser(message);
    case "assistant": return renderAssistant(message, options);
    case "toolResult": return renderToolResult(message, options.detailsBodyCap);
    case "custom": return renderCustom(message);
    default: return [];
  }
}

/** Render the display context of one session branch to Markdown. Pure: no fs,
 *  no clock, no randomness — the same context always yields the same text. */
export function sessionToMarkdown(context: SessionContext, meta: SessionMarkdownMeta, options: RenderOptions = {}): string {
  const detailsBodyCap = options.detailsBodyCap ?? MARKDOWN_DETAILS_BODY_CAP;
  const opts = { detailsBodyCap };

  const out: string[] = [`# ${meta.title}`, ""];

  const metaLines: string[] = [];
  if (meta.sessionId) metaLines.push(`- Session: ${meta.sessionId}`);
  if (meta.cwd) metaLines.push(`- Project: ${meta.cwd}`);
  if (meta.created) metaLines.push(`- Created: ${meta.created}`);
  if (meta.model) metaLines.push(`- Model: ${meta.model}`);
  if (metaLines.length > 0) {
    out.push(...metaLines, "", "---", "");
  }

  const messages = Array.isArray(context.messages) ? context.messages : [];
  messages.forEach((message, index) => {
    if (!message) return;
    const rendered = renderMessage(message, opts);
    if (rendered.length === 0) return;
    // entryIds is parallel to messages; the per-section marker keeps forks and
    // navigation targets traceable from the exported file.
    const entryId = Array.isArray(context.entryIds) ? context.entryIds[index] : undefined;
    if (entryId) out.push(`<a id="entry-${entryId}"></a>`, "");
    out.push(...rendered);
  });

  return `${out.join("\n").replace(/\n+$/g, "")}\n`;
}
