import { NextResponse } from "next/server";
import { getMemoryDiagnose, getMemoryStats, getTtsrRules } from "@/lib/omp/native-memory";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/native-memory?refresh=1 — read-only omp-native memory + TTSR
 * inspectors (P17 / R3-20 + R3-21): aggregate `memory stats`, diagnostics
 * `memory diagnose`, and TTSR rule LIST metadata. Raw memory content is
 * NEVER read (`memory view` is intentionally absent) and nothing here
 * mutates omp memory or TTSR state. Each section degrades independently to
 * { supported: false, reason } — this route never 500s.
 */
export async function GET(req: Request) {
  const refreshParam = new URL(req.url).searchParams.get("refresh");
  const refresh = refreshParam === "1" || refreshParam === "true";

  const [stats, diagnose, ttsr] = await Promise.all([
    getMemoryStats({ refresh }).catch((error: unknown) => ({
      supported: false as const,
      reason: error instanceof Error ? error.message : "stats_failed",
    })),
    getMemoryDiagnose({ refresh }).catch((error: unknown) => ({
      supported: false as const,
      reason: error instanceof Error ? error.message : "diagnose_failed",
    })),
    getTtsrRules({ refresh }).catch((error: unknown) => ({
      supported: false as const,
      reason: error instanceof Error ? error.message : "ttsr_failed",
    })),
  ]);

  return NextResponse.json(
    {
      success: true,
      data: {
        stats,
        diagnose,
        ttsr,
        note: "Read-only: omp memory content is never fetched and omp memory/TTSR state is never mutated.",
      },
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
