import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type RunGraph, type Task, type TaskStatus, validateGraph } from "./schema.js";

export function stateDirName(_repoRoot: string): string {
  return ".tickmarkr";
}

export function graphPath(repoRoot: string): string {
  return join(repoRoot, stateDirName(repoRoot), "graph.json");
}

// T3 (Sol #2 / Fable F2): ONE canonical engagement identity over COMPILED TASK DEFINITIONS only.
// status/evidence are runtime-mutated (the daemon flips status, accumulates evidence every attempt) so
// they are excluded — the identity survives a status flip or evidence growth but changes the instant a
// task definition changes (goal/acceptance/deps/gates/etc.). Shared by status AND resume through the
// single comparator in journal.ts (engagementComparable) so the journal↔graph join is decided once.
// ponytail: sha256 truncated to 16 hex — stable, grep-friendly; promote to full digest only if a
// collision ever bites (engagement ids are not a trust boundary, collisions just force a re-run).
export function graphDefinitionHash(g: RunGraph): string {
  const definitions = g.tasks.map(({ status: _status, evidence: _evidence, ...def }) => def);
  return createHash("sha256").update(JSON.stringify({ version: g.version, spec: g.spec, tasks: definitions })).digest("hex").slice(0, 16);
}

export function tickmarkrDir(repoRoot: string): string {
  const dir = join(repoRoot, stateDirName(repoRoot));
  mkdirSync(dir, { recursive: true });
  const gi = join(dir, ".gitignore");
  if (!existsSync(gi)) writeFileSync(gi, "*\n");
  return dir;
}

export function loadGraph(repoRoot: string): RunGraph {
  const p = graphPath(repoRoot);
  if (!existsSync(p)) throw new Error(`no graph at ${p} — run \`tickmarkr compile <src>\` first`);
  return validateGraph(JSON.parse(readFileSync(p, "utf8")));
}

export function saveGraph(repoRoot: string, g: RunGraph): void {
  tickmarkrDir(repoRoot);
  const p = graphPath(repoRoot);
  // Temp file MUST be a sibling of graph.json: rename(2) is atomic only within one filesystem
  // (never os.tmpdir()). pid-suffix so a racing writer can't clobber our in-flight temp (HARD-04).
  const tmp = `${p}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(g, null, 2) + "\n");
    renameSync(tmp, p); // atomic same-volume (APFS included) — a reader never sees a torn document
  } catch (e) {
    rmSync(tmp, { force: true }); // no .tmp litter behind a failed write
    throw e;
  }
}

export function getTask(g: RunGraph, id: string): Task {
  const t = g.tasks.find((t) => t.id === id);
  if (!t) throw new Error(`unknown task ${id}`);
  return t;
}

export function setStatus(g: RunGraph, id: string, status: TaskStatus): RunGraph {
  getTask(g, id);
  return { ...g, tasks: g.tasks.map((t) => (t.id === id ? { ...t, status } : t)) };
}

export function addEvidence(
  g: RunGraph,
  id: string,
  patch: { commits?: string[]; artifacts?: string[]; gateResults?: unknown[] },
): RunGraph {
  getTask(g, id);
  return {
    ...g,
    tasks: g.tasks.map((t) =>
      t.id === id
        ? {
            ...t,
            evidence: {
              commits: [...t.evidence.commits, ...(patch.commits ?? [])],
              artifacts: [...t.evidence.artifacts, ...(patch.artifacts ?? [])],
              gateResults: [...t.evidence.gateResults, ...(patch.gateResults ?? [])],
            },
          }
        : t,
    ),
  };
}

export function readyTasks(g: RunGraph): Task[] {
  const done = new Set(g.tasks.filter((t) => t.status === "done").map((t) => t.id));
  return g.tasks.filter((t) => t.status === "pending" && t.deps.every((d) => done.has(d)));
}

export function isComplete(g: RunGraph): boolean {
  return g.tasks.every((t) => t.status === "done");
}

export function isStalled(g: RunGraph): boolean {
  const running = g.tasks.some((t) => t.status === "running" || t.status === "gated");
  return !isComplete(g) && !running && readyTasks(g).length === 0;
}

// parked = a terminal-for-now state that strands every downstream task (D-02/D-06)
const isParked = (t: Task) => t.status === "human" || t.status === "failed";

// closureReaches: true iff the transitive dep-closure of `taskId` contains a task matching `pred`.
// Walks FORWARD along Task.deps with an iterative stack + visited-set; cycles are impossible
// (validateGraph rejects them at load), so a visited-set is for efficiency, not safety. Pure —
// depends on RunGraph alone, never daemon/run state (D-06).
export function closureReaches(g: RunGraph, taskId: string, pred: (t: Task) => boolean): boolean {
  const byId = new Map(g.tasks.map((t) => [t.id, t] as const));
  const visited = new Set<string>();
  const stack: string[] = [...(byId.get(taskId)?.deps ?? [])];
  while (stack.length) {
    const id = stack.pop()!;
    if (visited.has(id)) continue;
    visited.add(id);
    const t = byId.get(id);
    if (!t) continue; // unknown deps are rejected at validate; defensive only
    if (pred(t)) return true;
    for (const d of t.deps) if (!visited.has(d)) stack.push(d);
  }
  return false;
}

// blockedTasks: pending tasks whose dep-closure reaches a parked (human|failed) task —
// "not-yet-run AND structurally unreachable" — the truthful bucket the operator must see (VIS-01).
export function blockedTasks(g: RunGraph): Task[] {
  return g.tasks.filter((t) => t.status === "pending" && closureReaches(g, t.id, isParked));
}

// pendingTasks: pending tasks whose closure does NOT reach a parked task — still runnable
// in principle (deps pending/running). Distinct from blocked so the buckets never lie mid-quiesce.
export function pendingTasks(g: RunGraph): Task[] {
  return g.tasks.filter((t) => t.status === "pending" && !closureReaches(g, t.id, isParked));
}

// attributeBlocked: for every blockedTasks(g) member, BFS forward over deps (level order, not
// closureReaches' DFS) to find its NEAREST parked (human|failed) ancestor and count it there.
// A task under two parked roots attributes to the nearer one only — never double-counted (D-04).
export function attributeBlocked(g: RunGraph): Map<string, number> {
  const byId = new Map(g.tasks.map((t) => [t.id, t] as const));
  const counts = new Map<string, number>();
  for (const t of blockedTasks(g)) {
    const visited = new Set<string>();
    const queue: string[] = [...t.deps];
    let root: string | undefined;
    while (queue.length) {
      const id = queue.shift()!;
      if (visited.has(id)) continue;
      visited.add(id);
      const dep = byId.get(id);
      if (!dep) continue;
      if (isParked(dep)) { root = dep.id; break; }
      for (const d of dep.deps) if (!visited.has(d)) queue.push(d);
    }
    if (root) counts.set(root, (counts.get(root) ?? 0) + 1);
  }
  return counts;
}
