import { randomUUID } from "crypto";
import { execFile } from "child_process";
import { mkdirSync, readFileSync, rmSync, statSync } from "fs";
import { tmpdir } from "os";
import { basename, join } from "path";
import { promisify } from "util";
import { NextResponse } from "next/server";
import { resolveOmpBin } from "@/lib/omp/omp-cli";
import { apiErrorResponse, resolveSessionPathOr404 } from "@/lib/api-utils";
import { getContentDisposition } from "@/lib/content-disposition";
import { MAX_SESSION_LOAD_BYTES } from "@/lib/omp/session-files";
import { SessionFileTooLargeError, buildSessionContext, getSessionEntries, readSessionHeader } from "@/lib/session-reader";
import { sessionToMarkdown } from "@/lib/session-markdown";

const execFileAsync = promisify(execFile);

export const runtime = "nodejs";

/**
 * Render a session to self-contained HTML by shelling out to the user's omp
 * binary: `omp --export <sessionPath> <outPath>` (the output path is the first
 * positional argument; verified against oh-my-pi main.ts/flag-tables.ts).
 */
async function exportSession(filePath: string, outputPath: string): Promise<void> {
  const bin = resolveOmpBin();
  if (!bin) {
    throw new Error("omp binary not found. Install oh-my-pi or set OMP_WEB_OMP_BIN.");
  }
  await execFileAsync(bin, ["--export", filePath, outputPath], {
    cwd: tmpdir(),
    timeout: 60_000,
    maxBuffer: 4 * 1024 * 1024,
    windowsHide: true,
  });
}

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const url = new URL(req.url);
  const inline = url.searchParams.get("inline") === "1";
  const format = url.searchParams.get("format");

  try {
    const resolved = await resolveSessionPathOr404(id);
    if ("response" in resolved) return resolved.response;
    const filePath = resolved.filePath;

    // `?format=md` renders in-process from the session file itself — no omp
    // shell-out, no temp file. Entries stay UN-resolved so image blobs keep
    // their `blob:sha256:` refs (the markdown embeds refs, not base64).
    if (format === "md") {
      try {
        if (statSync(filePath).size > MAX_SESSION_LOAD_BYTES) {
          throw new SessionFileTooLargeError(filePath);
        }
        const context = buildSessionContext(getSessionEntries(filePath));
        const header = readSessionHeader(filePath);
        const markdown = sessionToMarkdown(context, {
          title: header?.title || `Session ${id}`,
          sessionId: header?.id ?? id,
          cwd: header?.cwd,
          created: header?.timestamp,
          model: context.model ? `${context.model.provider}/${context.model.modelId}` : null,
        });
        return new Response(markdown, {
          headers: {
            "Content-Type": "text/markdown; charset=utf-8",
            "Content-Disposition": getContentDisposition(`omp-session-${basename(filePath, ".jsonl")}.md`, inline, "session.md"),
            "Cache-Control": "no-cache",
          },
        });
      } catch (error) {
        if (error instanceof SessionFileTooLargeError) {
          return NextResponse.json({ error: error.message, code: error.code }, { status: 413 });
        }
        throw error;
      }
    }

    const tempDir = join(tmpdir(), "omp-web-export");
    mkdirSync(tempDir, { recursive: true });

    const sessionBase = basename(filePath, ".jsonl");
    const fileName = `omp-session-${sessionBase}.html`;
    const outputPath = join(tempDir, `${randomUUID()}.html`);

    try {
      await exportSession(filePath, outputPath);

      const html = readFileSync(outputPath, "utf8");
      return new Response(html, {
        headers: {
          "Content-Type": "text/html; charset=utf-8",
          "Content-Disposition": getContentDisposition(fileName, inline, "session.html"),
          "Cache-Control": "no-cache",
        },
      });
    } finally {
      rmSync(outputPath, { force: true });
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("omp binary not found")) {
      return NextResponse.json({ error: message, code: "omp_not_found" }, { status: 500 });
    }
    return apiErrorResponse(error);
  }
}
