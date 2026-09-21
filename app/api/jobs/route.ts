import { NextResponse } from "next/server";
import {
  getCollabPeers,
  getJobs,
  getProcesses,
} from "@/lib/omp/native-jobs";
import type {
  CollabPeerRow,
  JobRow,
  NativeJobsSection,
  ProcessRow,
} from "@/lib/omp/native-jobs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/jobs?refresh=1 — native jobs / processes / collab peers
 * (BUILD-PLAN-3 P14.2, R3-13 + R3-23): three INDEPENDENT read-only probes of
 * the installed omp CLI. Each section is either its parsed rows or
 * `{ unsupported: true, reason }` (Tier B) — a failing section never fails
 * the endpoint, so this route cannot 500 on a bad CLI.
 *
 * READ-ONLY BY CONTRACT: this route exports GET only — no POST/PUT/DELETE
 * exists, and no stop/kill/restart of any job or process is reachable through
 * omp-web (the roadmap's safe-controls phase, P14.3, is deliberately out of
 * this slice). The `note` field states this on the wire so clients can
 * surface it.
 */
export async function GET(req: Request) {
  const refreshParam = new URL(req.url).searchParams.get("refresh");
  const refresh = refreshParam === "1" || refreshParam === "true";

  const [jobs, processes, collabPeers] = await Promise.all([
    getJobs({ refresh }),
    getProcesses({ refresh }),
    getCollabPeers({ refresh }),
  ]);

  const data: {
    jobs: NativeJobsSection<JobRow>;
    processes: NativeJobsSection<ProcessRow>;
    collabPeers: NativeJobsSection<CollabPeerRow>;
    note: string;
  } = {
    jobs,
    processes,
    collabPeers,
    note: "read-only: observation only — omp-web exposes no job/process mutation endpoints",
  };

  return NextResponse.json(
    { success: true, data },
    { headers: { "Cache-Control": "no-store" } },
  );
}
