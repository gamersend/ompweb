import { NextResponse } from "next/server";
import { collectDelegatedSessions } from "@/lib/delegation-ledger";
import { loadHandoffs } from "@/lib/handoffs";
import {
  buildLineageGraph,
  type LineageDelegationInput,
  type LineageHandoffInput,
  type LineageSessionInput,
} from "@/lib/lineage";
import { getRunningRpcSessionIds } from "@/lib/rpc-manager";
import { listAllSessions } from "@/lib/session-reader";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// ============================================================================
// GET /api/lineage (Phase P13 / roadmap R3-12) — the session dependency graph:
// fork parents from the session list, delegation edges from the durable
// ledger, handoff pairs from the manifest, plus the live running-id set so
// the board can badge live nodes.
//
// Read-only. Every source degrades to [] independently — a missing ledger or
// a failed session scan never 500s; the graph just renders what exists. No
// transcript text: session ids, titles, and relationship shape only.
// ============================================================================

export async function GET(): Promise<NextResponse> {
  let sessions: LineageSessionInput[] = [];
  try {
    sessions = (await listAllSessions()).map((session) => ({
      id: session.id,
      parentSession: session.parentSessionId ?? null,
      title: session.name,
    }));
  } catch {
    // degraded: render the graph from the other sources only
  }

  const delegations: LineageDelegationInput[] = [];
  try {
    // Map<toSession, most-recent entry> → flat from/to pairs (newest-first
    // iteration order, matching the ledger's sort).
    for (const entry of collectDelegatedSessions().values()) {
      delegations.push({ fromSession: entry.fromSession, toSession: entry.toSession, tsMs: entry.tsMs });
    }
  } catch {
    // degraded: no delegation edges
  }

  const handoffs: LineageHandoffInput[] = [];
  try {
    for (const record of loadHandoffs().handoffs) {
      handoffs.push({ fromSession: record.fromSession, toSession: record.toSession, state: record.state });
    }
  } catch {
    // degraded: no handoff pairs
  }

  let runningSessionIds: string[] = [];
  try {
    runningSessionIds = getRunningRpcSessionIds();
  } catch {
    // degraded: no live badges
  }

  try {
    const graph = buildLineageGraph({ sessions, delegations, handoffs });
    return NextResponse.json(
      { success: true, data: { graph, runningSessionIds } },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    // Unreachable in practice (the builder is total), kept for envelope parity.
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error), code: "lineage_failed" },
      { status: 500, headers: { "Cache-Control": "no-store" } },
    );
  }
}
