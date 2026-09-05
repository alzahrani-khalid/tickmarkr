import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { type RunGraph, type Task, type TaskStatus, validateGraph } from "./schema.js";

export function stateDirName(_repoRoot: string): string {
  return ".tickmarkr";
}

export function graphPath(repoRoot: string): string {
  return join(repoRoot, stateDirName(repoRoot), "graph.json");
}

// OBS-904: a refused compile must leave durable negative evidence without changing graph.json.
// RunGraphSchema intentionally strips/rejects non-graph state, so this record is a sibling rather
// than a graph field. Its presence wins over an otherwise valid prior graph until a successful
// non-dry compile replaces that graph and clears the record.
export interface CompileRefusalRecord {
  refusedAt: string;
  source: string;
  error: string;
}

export function compileRefusalPath(repoRoot: string): string {
  return join(repoRoot, stateDirName(repoRoot), "compile-refusal.json");
}

export function readCompileRefusal(repoRoot: string): CompileRefusalRecord | undefined {
  const path = compileRefusalPath(repoRoot);
  if (!existsSync(path)) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(
      `compile refusal record at ${path} is unreadable: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (
    typeof value !== "object" || value === null
    || typeof (value as Record<string, unknown>).refusedAt !== "string"
    || typeof (value as Record<string, unknown>).source !== "string"
    || typeof (value as Record<string, unknown>).error !== "string"
  ) {
    throw new Error(`compile refusal record at ${path} is malformed`);
  }
  return value as CompileRefusalRecord;
}

export function saveCompileRefusal(repoRoot: string, record: CompileRefusalRecord): void {
  tickmarkrDir(repoRoot);
  const path = compileRefusalPath(repoRoot);
  const tmp = `${path}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(record, null, 2) + "\n");
    renameSync(tmp, path);
  } catch (error) {
    rmSync(tmp, { force: true });
    throw error;
  }
}

export function clearCompileRefusal(repoRoot: string): void {
  rmSync(compileRefusalPath(repoRoot), { force: true });
}

export interface OnDiskSpecHash {
  path: string;
  hash: string;
}

/**
 * Re-hash the exact single source file recorded by CLI compiles. Native and PRD record the source
 * markdown; Spec Kit records its tasks.md. GSD combines several plan bodies and is deliberately not
 * reconstructed here. A missing file is the one fail-open case: the refusal record is the fail-closed
 * evidence for failed recompiles, while moved/deleted source files need not strand a compiled graph.
 */
export function onDiskSpecHash(_repoRoot: string, graph: RunGraph): OnDiskSpecHash | undefined {
  if (graph.spec.source === "gsd") return undefined;
  if (graph.spec.paths.length !== 1) return undefined;
  const recorded = graph.spec.paths[0]!;
  // CLI compilation records an absolute source. Relative paths belong to legacy/programmatic
  // graphs whose resolution context is unknowable here, so preserve their prior fail-open behavior.
  if (!isAbsolute(recorded)) return undefined;
  const path = recorded;
  try {
    const content = readFileSync(path);
    return { path, hash: createHash("sha256").update(content).digest("hex") };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new Error(`cannot verify compiled spec hash from ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
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

// OBS-543: cross-run evidence belongs to the artifact one task describes, not to the whole compiled
// graph. A sibling task, dependency, routing hint or status change therefore cannot expire a useful
// finding; changing the goal, write surface or acceptance contract does. Keep the full digest here:
// unlike graphDefinitionHash this value is persisted beside evidence and is the fail-closed join a
// later run uses, so there is no benefit in making collision diagnosis less explicit.
export function taskContentDigest(task: Pick<Task, "goal" | "files" | "acceptance">): string {
  return createHash("sha256")
    .update(JSON.stringify({ goal: task.goal, files: task.files, acceptance: task.acceptance }))
    .digest("hex");
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
  const subject = getTask(g, id);
  const digest = taskContentDigest(subject);
  // This is the graph-evidence boundary where a gate result meets the task it measured. Stamp a
  // copy, never mutate the gate result runGates returned: callers still use that live object for
  // predicates, while durable evidence gains the content identity a later run can compare.
  const gateResults = (patch.gateResults ?? []).map((result) =>
    result !== null && typeof result === "object" && !Array.isArray(result)
      ? { ...result, taskContentDigest: digest }
      : result,
  );
  return {
    ...g,
    tasks: g.tasks.map((t) =>
      t.id === id
        ? {
            ...t,
            evidence: {
              commits: [...t.evidence.commits, ...(patch.commits ?? [])],
              artifacts: [...t.evidence.artifacts, ...(patch.artifacts ?? [])],
              gateResults: [...t.evidence.gateResults, ...gateResults],
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
