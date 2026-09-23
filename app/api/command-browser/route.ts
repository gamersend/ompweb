import { NextResponse } from "next/server";
import { runUtilityCommand } from "@/lib/omp/rpc-utility";
import { buildCommandIndex, type CommandBrowserIndex } from "@/lib/command-browser";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Command-browser data source (P16 / R3-19): the full `get_available_commands`
 * surface of the installed omp, for the read-only browser dialog.
 *
 * Transport discipline: this goes through the shared short-lived utility omp
 * process (lib/omp/rpc-utility.ts) — never a user session and never a raw
 * child spawn — and ANY failure (omp binary missing, child dead, timeout)
 * degrades to a 200 carrying `transport_disconnected` so the dialog can show
 * its explanation state. Never a 500. The browser executes nothing; this is a
 * metadata listing only.
 */

const CACHE_TTL_MS = 60_000;
// Shorter than the utility seam's 60s default: a wedged transport should
// degrade the dialog within seconds, not hold the request for a minute.
const COMMAND_TIMEOUT_MS = 15_000;

interface CommandBrowserCache {
  at: number;
  data: CommandBrowserIndex;
}

declare global {
  var __ompCommandBrowserCache: CommandBrowserCache | undefined;
}

function degradedDisconnected(): CommandBrowserIndex {
  return { supported: false, reason: "transport_disconnected", commands: [] };
}

export async function GET() {
  const cached = globalThis.__ompCommandBrowserCache;
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) {
    return NextResponse.json({ success: true, data: cached.data }, { headers: { "Cache-Control": "no-store" } });
  }
  let data: CommandBrowserIndex;
  try {
    const payload = await runUtilityCommand<{ commands?: unknown }>(
      { type: "get_available_commands" },
      COMMAND_TIMEOUT_MS,
    );
    const raw = Array.isArray(payload?.commands) ? payload.commands : Array.isArray(payload) ? payload : [];
    data = buildCommandIndex(raw, "connected");
  } catch {
    data = degradedDisconnected();
  }
  globalThis.__ompCommandBrowserCache = { at: Date.now(), data };
  return NextResponse.json({ success: true, data }, { headers: { "Cache-Control": "no-store" } });
}
