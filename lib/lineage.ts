// ============================================================================
// Agent lineage + dependency graph (Phase P13 / roadmap R3-12).
//
// One PURE builder that combines the three relationship sources ompweb
// already records — fork parents (SessionHeader.parentSession / SessionInfo
// parentSessionId), the durable delegation ledger (web-delegations.json) and
// the handoff manifest (web-handoffs.json) — into a small, cycle-safe graph
// the runs board can render as an indented list.
//
// Fully pure: no fs, no DOM, no clock. The route feeds it data; tests feed it
// literals. Deleted parents (a fork whose parent .jsonl no longer exists)
// become explicit "missing" placeholder nodes instead of silently dropping
// the edge, and reference cycles are detected with a visited-set DFS — nodes
// inside a cycle are still returned, the walk always terminates.
// ============================================================================

/** Session cap: over this, the builder keeps the first 500 and flags
 *  `truncated`. Callers pass sessions newest-first (listAllSessions order),
 *  so "first 500" is "the 500 most recent". */
export const LINEAGE_MAX_SESSIONS = 500;

export interface LineageSessionInput {
  id: string;
  /** Fork parent session id (SessionInfo.parentSessionId), null when direct. */
  parentSession?: string | null;
  title?: string;
}

export interface LineageDelegationInput {
  fromSession: string;
  toSession: string;
  tsMs?: number;
}

export interface LineageHandoffInput {
  fromSession: string;
  toSession: string;
  state?: string;
}

export interface LineageNode {
  id: string;
  /** "missing" = referenced by an edge but absent from the session list
   *  (deleted .jsonl or cut by the cap) — rendered explicitly, never dropped. */
  kind: "session" | "missing";
  title?: string;
  /** Fork parents (ids this session was forked from). */
  parents: string[];
  /** Fork children (sessions forked FROM this one). */
  children: string[];
  /** Most recent delegation source INTO this node (first wins — the ledger is
   *  newest-first, so the first occurrence is the most recent delivery). */
  delegatedFrom?: string;
  /** Session ids this node delegated work TO. */
  delegatedTo?: string[];
  hasParent: boolean;
}

export interface LineageEdge {
  from: string;
  to: string;
  kind: "fork" | "delegation";
}

export interface LineageGraph {
  nodes: LineageNode[];
  /** Deduped edges (same from/to/kind collapses to one), in first-seen order. */
  edges: LineageEdge[];
  /** Each cycle as node ids in loop order (first element = where the back
   *  edge landed). A node can appear in several distinct cycles. */
  cycles: string[][];
  /** True when sessions exceeded LINEAGE_MAX_SESSIONS and the tail was cut. */
  truncated: boolean;
}

export interface LineageInput {
  sessions: LineageSessionInput[];
  delegations: LineageDelegationInput[];
  handoffs?: LineageHandoffInput[];
}

function validId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

export function buildLineageGraph(input: LineageInput): LineageGraph {
  const truncated = Array.isArray(input.sessions) && input.sessions.length > LINEAGE_MAX_SESSIONS;
  const sessions = (Array.isArray(input.sessions) ? input.sessions : []).slice(0, LINEAGE_MAX_SESSIONS);

  // Nodes keyed by id (duplicate ids merge); insertion order is preserved.
  const nodes = new Map<string, LineageNode>();
  const ensureNode = (id: string): LineageNode => {
    let node = nodes.get(id);
    if (!node) {
      node = { id, kind: "missing", parents: [], children: [], hasParent: false };
      nodes.set(id, node);
    }
    return node;
  };

  for (const session of sessions) {
    if (!validId(session?.id)) continue;
    const node = ensureNode(session.id);
    node.kind = "session";
    if (typeof session.title === "string" && session.title.length > 0) node.title = session.title;
  }

  const edges: LineageEdge[] = [];
  const edgeKeys = new Set<string>();
  const pushEdge = (from: string, to: string, kind: LineageEdge["kind"]): void => {
    const key = `${from}\u0000${to}\u0000${kind}`;
    if (edgeKeys.has(key)) return;
    edgeKeys.add(key);
    edges.push({ from, to, kind });
  };

  // Fork edges: parentSession → this session. Unknown parents stay explicit
  // "missing" nodes so a deleted parent renders instead of vanishing. Parent
  // / child lists dedupe so repeated (merged) session entries stay clean.
  for (const session of sessions) {
    if (!validId(session?.id) || !validId(session.parentSession)) continue;
    const child = ensureNode(session.id);
    const parent = ensureNode(session.parentSession);
    if (!child.parents.includes(parent.id)) child.parents.push(parent.id);
    child.hasParent = true;
    if (!parent.children.includes(child.id)) parent.children.push(child.id);
    pushEdge(parent.id, child.id, "fork");
  }

  // Delegation edges (from → to). The handoff manifest overlaps the ledger
  // almost fully (same delivery identity) — its pairs only ADD edges the
  // ledger does not already carry; the from/to/kind dedupe collapses overlaps.
  const delegationInputs = Array.isArray(input.delegations) ? input.delegations : [];
  const handoffInputs = Array.isArray(input.handoffs) ? input.handoffs : [];
  for (const link of [...delegationInputs, ...handoffInputs]) {
    if (!validId(link?.fromSession) || !validId(link?.toSession)) continue;
    const from = ensureNode(link.fromSession);
    const to = ensureNode(link.toSession);
    pushEdge(from.id, to.id, "delegation");
    to.delegatedFrom = to.delegatedFrom ?? from.id;
    from.delegatedTo = from.delegatedTo ?? [];
    if (!from.delegatedTo.includes(to.id)) from.delegatedTo.push(to.id);
  }

  const nodeList = [...nodes.values()];

  // Cycle detection: iterative DFS with a visited set + on-stack marking.
  // Nodes in a cycle stay in the output; the walk always terminates.
  const adjacency = new Map<string, string[]>();
  for (const node of nodeList) {
    const targets: string[] = [];
    for (const edge of edges) {
      if (edge.from !== node.id) continue;
      // Only follow edges whose target still exists as a node (always true —
      // pushEdge ensures both endpoints) and is not a self-loop duplicate.
      targets.push(edge.to);
    }
    adjacency.set(node.id, targets);
  }

  const cycles: string[][] = [];
  const visited = new Set<string>();
  const onStack = new Set<string>();
  const stack: string[] = [];

  const dfs = (startId: string): void => {
    // Explicit frame stack — recursion depth is bounded by node count, but an
    // iterative walk keeps worst-case memory flat and avoids stack limits.
    const frames: Array<{ id: string; next: number }> = [{ id: startId, next: 0 }];
    visited.add(startId);
    onStack.add(startId);
    stack.push(startId);
    while (frames.length > 0) {
      const frame = frames[frames.length - 1];
      const targets = adjacency.get(frame.id) ?? [];
      if (frame.next < targets.length) {
        const targetId = targets[frame.next];
        frame.next += 1;
        if (onStack.has(targetId)) {
          // Back edge: the cycle runs from where the target was pushed onto
          // the stack through the current top.
          const start = stack.indexOf(targetId);
          cycles.push(stack.slice(start).concat(targetId));
          continue;
        }
        if (visited.has(targetId)) continue;
        visited.add(targetId);
        onStack.add(targetId);
        stack.push(targetId);
        frames.push({ id: targetId, next: 0 });
        continue;
      }
      // Frame exhausted: pop.
      frames.pop();
      stack.pop();
      onStack.delete(frame.id);
    }
  };

  for (const node of nodeList) {
    if (!visited.has(node.id)) dfs(node.id);
  }

  return { nodes: nodeList, edges, cycles, truncated };
}
