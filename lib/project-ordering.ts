import { comparableProjectPath } from "./comparable-path";
import type { ManagedProject, SessionInfo } from "./types";
import { workspaceKeyOf } from "./workspace-memory";

// ============================================================================
// Pure ordering/grouping helpers shared between the sidebar and unit tests.
// All keys are canonical projectRoot paths (worktrees collapse into their main
// repo via resolveProject), so worktree sessions group under their project.
//
// Two project orders are supported. With no activity map (the default, and
// what AppShell's palette options use) the list is ordered by when each project
// was added (addedAt desc = most recently added first), NOT by session
// activity: activity changes on every session refresh (agent runs, message
// edits, unread transitions) and would make project rows jump around
// constantly. Registration order is stable — it only changes when the user
// explicitly adds a project. Session-discovered projects (no addedAt) follow
// the registered ones in path order, which is also stable.
//
// Callers that pass an activity map opt in to recency-first ordering: manual
// sortOrder still wins (an explicit user order is never overridden), then
// projects with the newest session activity come first. The sidebar's
// "Sort: recent activity" mode is the ONLY caller — the map is always optional
// so every other caller keeps the stable registration order.
// ============================================================================

/** Sort projects by manual order, then most-recent session activity (only when
 *  `activityByProject` is passed), then most-recently-added (addedAt desc),
 *  then path for a deterministic order.
 *
 *  Ordering rules, in precedence order:
 *   1. Projects with a manual `sortOrder` come first, ascending — an explicit
 *      user order always beats derived ordering.
 *   2. With an activity map: projects that HAVE activity sort above those
 *      without; among projects with activity, newest timestamp first.
 *   3. Projects with `addedAt` sort above session-discovered ones (no
 *      addedAt); among registered projects, newest first.
 *   4. Path, so equal-rank rows never shuffle.
 *
 *  Activity keys are the case-folded comparable form of the project path —
 *  pass `comparableProjectPath(project.path)`. Non-finite timestamps are
 *  ignored (treated as "no activity"). Omitting the map reproduces the
 *  registration order exactly. */
export function sortManagedProjects(
  projects: ManagedProject[],
  activityByProject?: ReadonlyMap<string, number>,
): ManagedProject[] {
  const activityOf = (path: string): number | undefined => {
    const value = activityByProject?.get(comparableProjectPath(path));
    return typeof value === "number" && Number.isFinite(value) ? value : undefined;
  };
  return [...projects].sort((a, b) => {
    const aManual = a.sortOrder !== undefined;
    const bManual = b.sortOrder !== undefined;
    if (aManual !== bManual) return aManual ? -1 : 1;
    if (aManual && bManual && a.sortOrder !== b.sortOrder) return a.sortOrder! - b.sortOrder!;
    if (activityByProject) {
      const aActivity = activityOf(a.path);
      const bActivity = activityOf(b.path);
      const aHasActivity = aActivity !== undefined;
      const bHasActivity = bActivity !== undefined;
      if (aHasActivity !== bHasActivity) return aHasActivity ? -1 : 1;
      if (aHasActivity && bHasActivity && aActivity !== bActivity) return bActivity - aActivity;
    }
    const aHas = a.addedAt !== undefined;
    const bHas = b.addedAt !== undefined;
    if (aHas !== bHas) return aHas ? -1 : 1;
    if (aHas && bHas) {
      const byAdded = b.addedAt!.localeCompare(a.addedAt!);
      if (byAdded !== 0) return byAdded;
    }
    return a.path.localeCompare(b.path);
  });
}

/** Newest session modification time per project, keyed by the case-folded
 *  comparable project path (the key shape `sortManagedProjects` and
 *  `projectActivityCounts` expect). Sessions with an unparseable `modified`
 *  are skipped, and a project with no sessions simply has no entry — callers
 *  read "missing" as "no activity". */
export function projectRecency(sessions: SessionInfo[]): Map<string, number> {
  const recency = new Map<string, number>();
  for (const session of sessions) {
    const key = workspaceKeyOf(session);
    if (!key) continue;
    const ts = Date.parse(session.modified);
    if (!Number.isFinite(ts)) continue;
    const folded = comparableProjectPath(key);
    const current = recency.get(folded);
    if (current === undefined || ts > current) recency.set(folded, ts);
  }
  return recency;
}

/** Running/unread session counts per project, for the activity indicators on
 *  project rows. Keys are the case-folded comparable form of the projectRoot
 *  so casing-only differences (Windows/NTFS) still resolve — callers must
 *  look up with comparableProjectPath(project.path). */
export function projectActivityCounts(
  sessions: SessionInfo[],
  runningIds: Iterable<string>,
  unreadIds: Iterable<string>,
): Map<string, { running: number; unread: number }> {
  const running = new Set(runningIds);
  const unread = new Set(unreadIds);
  const result = new Map<string, { running: number; unread: number }>();
  for (const session of sessions) {
    const key = workspaceKeyOf(session);
    if (!key) continue;
    const folded = comparableProjectPath(session.projectKey ?? key);
    const current = result.get(folded) ?? { running: 0, unread: 0 };
    if (running.has(session.id)) current.running += 1;
    if (unread.has(session.id)) current.unread += 1;
    result.set(folded, current);
  }
  return result;
}

/** Group sessions under their project. Every project in `projects` gets an
 *  entry (possibly empty) so empty managed projects render their empty state.
 *  Buckets are keyed by the exact project path for callers; sessions are
 *  matched through a case-folded lookup (Windows/NTFS is case-insensitive and
 *  session-file cwds can carry different casing than the registered path), so
 *  casing-only differences land in the right bucket instead of silently
 *  dropping the session from the sidebar. */
export function groupSessionsByProject(
  projects: ManagedProject[],
  sessions: SessionInfo[],
): Map<string, SessionInfo[]> {
  const grouped = new Map<string, SessionInfo[]>();
  const bucketByKey = new Map<string, SessionInfo[]>();
  for (const project of projects) {
    const bucket: SessionInfo[] = [];
    grouped.set(project.path, bucket);
    bucketByKey.set(comparableProjectPath(project.path), bucket);
  }
  for (const session of sessions) {
    const key = workspaceKeyOf(session);
    if (!key) continue;
    // workspaceKeyOf already prefers projectKey, so this IS the session's
    // key; bucketByKey covers every registered project under its case-folded
    // path, and an exact-case fallback here could only hit when the folded
    // lookup already did — otherwise it silently dropped the session.
    const bucket = bucketByKey.get(comparableProjectPath(key));
    if (bucket) bucket.push(session);
  }
  return grouped;
}

// ============================================================================
// Cross-project recency rail (sidebar "Recent" section)
// ============================================================================

/** Rows shown at rest — the small always-in-view slice of the newest work. */
export const RECENT_SESSIONS_REST_LIMIT = 8;
/** Rows shown while a filter is active: a result set, not a glance. */
export const RECENT_SESSIONS_FILTER_LIMIT = 30;

export interface RecentSessionsOptions {
  /** Case-insensitive substring match over the session name + first message —
   *  the same fields the workspace list filters on. */
  query?: string;
  /** Keep only sessions that are currently running. */
  runningOnly?: boolean;
  runningIds?: Iterable<string>;
  /** Shown-row cap. Defaults to RECENT_SESSIONS_FILTER_LIMIT while a filter is
   *  active (query or runningOnly), RECENT_SESSIONS_REST_LIMIT otherwise. */
  limit?: number;
}

/** The newest sessions across EVERY project, newest first — the flat list that
 *  makes "the conversation I want" findable without knowing which workspace it
 *  lives in. Returns the capped rows plus the total number of matches, so the
 *  caller can render a "+N older" hint without walking the list twice.
 *
 *  `filtered` is intentionally reported via the returned `total` +
 *  `items.length` difference; the caller owns the label ("Recent" vs
 *  "Matches") because it owns the filter controls. */
export function recentSessions(
  sessions: SessionInfo[],
  options: RecentSessionsOptions = {},
): { items: SessionInfo[]; total: number } {
  const query = (options.query ?? "").trim().toLowerCase();
  const runningOnly = options.runningOnly === true;
  const running = runningOnly ? new Set(options.runningIds ?? []) : null;
  const filtering = query.length > 0 || runningOnly;
  const requested = options.limit;
  const limit = typeof requested === "number" && Number.isFinite(requested) && requested > 0
    ? Math.floor(requested)
    : (filtering ? RECENT_SESSIONS_FILTER_LIMIT : RECENT_SESSIONS_REST_LIMIT);
  const matches = sessions.filter((session) => {
    if (running && !running.has(session.id)) return false;
    if (query) {
      const name = (session.name ?? "").toLowerCase();
      const first = session.firstMessage.toLowerCase();
      if (!name.includes(query) && !first.includes(query)) return false;
    }
    return true;
  });
  matches.sort(byModifiedDesc);
  return { items: matches.slice(0, limit), total: matches.length };
}

/** Newest first, unparseable timestamps last, id as the tie-break so two
 *  sessions sharing a timestamp never swap between renders. */
function byModifiedDesc(a: SessionInfo, b: SessionInfo): number {
  const aTs = Date.parse(a.modified);
  const bTs = Date.parse(b.modified);
  const aOk = Number.isFinite(aTs);
  const bOk = Number.isFinite(bTs);
  if (aOk && bOk) {
    if (aTs !== bTs) return bTs - aTs;
  } else if (aOk !== bOk) {
    return aOk ? -1 : 1;
  }
  return a.id.localeCompare(b.id);
}

// ============================================================================
// Project sort mode (persisted sidebar preference)
// ============================================================================

/** "recent" = newest session activity first (the sidebar default — the whole
 *  point is finding the conversation you were just in); "added" = the stable
 *  registration order (manual sortOrder → addedAt desc → path). */
export type ProjectSortMode = "recent" | "added";

export const PROJECT_SORT_STORAGE_KEY = "omp-web:sidebar-project-sort";
export const DEFAULT_PROJECT_SORT_MODE: ProjectSortMode = "recent";

interface SortModeStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function resolveSortStorage(storage?: SortModeStorage | null): SortModeStorage | null {
  if (storage !== undefined) return storage;
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage ?? null;
  } catch {
    return null;
  }
}

/** Read the persisted sort mode. Anything unrecognized (absent, corrupt,
 *  hand-edited) falls back to "recent" — storage can never break the sidebar. */
export function loadProjectSortMode(storage?: SortModeStorage | null): ProjectSortMode {
  const resolved = resolveSortStorage(storage);
  if (!resolved) return DEFAULT_PROJECT_SORT_MODE;
  try {
    const raw = resolved.getItem(PROJECT_SORT_STORAGE_KEY);
    return raw === "added" || raw === "recent" ? raw : DEFAULT_PROJECT_SORT_MODE;
  } catch {
    return DEFAULT_PROJECT_SORT_MODE;
  }
}

/** Persist the sort mode; every storage failure (quota, privacy mode) is
 *  silently ignored — the in-memory mode still applies for this session. */
export function saveProjectSortMode(mode: ProjectSortMode, storage?: SortModeStorage | null): void {
  const resolved = resolveSortStorage(storage);
  if (!resolved) return;
  try {
    resolved.setItem(PROJECT_SORT_STORAGE_KEY, mode);
  } catch {
    // ignore storage quota / privacy-mode errors
  }
}

/**
 * Batched updates that CLEAR every project's manual order: a null `sortOrder`
 * is the registry's documented "no manual rank" value (see the applyProject
 * Updates contract), so the list falls back to the derived order (recent
 * activity, then addedAt, then path). Used by the sidebar's "reset order"
 * action — a drag-reorder persists a rank for EVERY project, which pins the
 * list and makes the recent/added toggle inert until the ranks are cleared.
 *
 * Update order mirrors the caller's list order purely for deterministic
 * payloads in tests; the server applies every entry in one atomic save.
 */
export function buildOrderResetUpdates(
  projects: Array<Pick<ManagedProject, "path">>,
): { updates: Array<{ cwd: string; sortOrder: null }> } {
  return { updates: projects.map((project) => ({ cwd: project.path, sortOrder: null })) };
}

/** True when any project carries a manual rank (the list is pinned). */
export function hasManualProjectOrder(projects: Array<Pick<ManagedProject, "sortOrder">>): boolean {
  return projects.some((project) => project.sortOrder !== undefined);
}
