import { readFileSync, readdirSync } from "node:fs";
import { basename, extname, join } from "node:path";
import { filesGlob } from "../graph/files-glob.js";
import type { Task } from "../graph/schema.js";
import { collateralHits } from "./collateral.js";

export type OwnershipFinding =
  | { code: "unowned-test"; test: string; taskIds: string[]; detail: string }
  | { code: "test-path-outside-allowlist"; taskId: string; test: string; path: string; detail: string }
  | { code: "unordered-context-write"; taskId: string; ownerTaskId: string; path: string; detail: string };

type TestSource = { path: string; text: string };

const normalize = (path: string): string => path.replace(/^\.\//, "").split("\\").join("/");

function testSources(repoRoot: string): TestSource[] {
  const root = join(repoRoot, "tests");
  try {
    return readdirSync(root, { recursive: true, encoding: "utf8" })
      .filter((path) => path.endsWith(".test.ts"))
      .sort()
      .flatMap((path) => {
        try {
          return [{ path: `tests/${normalize(path)}`, text: readFileSync(join(root, path), "utf8") }];
        } catch {
          return [];
        }
      });
  } catch {
    return [];
  }
}

// Conventional, not universal: status-watch-alive.test.ts is dedicated to status.ts even though it
// reaches that command through the CLI entry point. Keep this heuristic advisory until authored-graph
// measurements establish its false-positive rate.

function namedSourceTasks(test: string, tasks: readonly Task[]): string[] {
  const stem = basename(test).replace(/\.test\.ts$/, "");
  const ids = new Set<string>();
  for (const task of tasks) {
    for (const entry of task.files.map(normalize).filter((path) => path.startsWith("src/") && !/[*?{[]/.test(path))) {
      const source = basename(entry, extname(entry));
      if (stem === source || stem.startsWith(`${source}-`)) ids.add(task.id);
    }
  }
  return [...ids];
}

function repositoryPaths(text: string): string[] {
  const paths = new Set<string>();
  for (const match of text.matchAll(/["'`]((?:src|tests|fixtures|scripts|skills|docs|\.claude)\/[^"'`\s]+)["'`]/g)) {
    paths.add(normalize(match[1]));
  }
  return [...paths].sort();
}

function dependencyOrdered(a: Task, b: Task, byId: ReadonlyMap<string, Task>): boolean {
  const reaches = (from: Task, target: string): boolean => {
    const seen = new Set<string>();
    const pending = [...from.deps];
    while (pending.length > 0) {
      const id = pending.pop()!;
      if (id === target) return true;
      if (seen.has(id)) continue;
      seen.add(id);
      pending.push(...(byId.get(id)?.deps ?? []));
    }
    return false;
  };
  return reaches(a, b.id) || reaches(b, a.id);
}

/**
 * Advisory cross-task ownership check. Findings are data: callers may report them, but this checker
 * never throws and never changes the graph.
 */
export function ownershipFindings(tasks: readonly Task[], repoRoot: string): OwnershipFinding[] {
  const sources = testSources(repoRoot);
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const indexed = tasks.map((task) => {
    const files = task.files.map(normalize);
    const context = task.context.map(normalize);
    return {
      task,
      owns: files.length === 0 ? () => false : filesGlob(files),
      allows: files.length === 0 ? () => true : filesGlob([...files, ...context]),
    };
  });
  const owners = (path: string) => indexed.filter(({ owns }) => owns(path));

  const predictedBy = new Map<string, Set<string>>();
  for (const [taskId, hits] of collateralHits(tasks, repoRoot)) {
    for (const hit of hits) {
      const ids = predictedBy.get(hit) ?? new Set<string>();
      ids.add(taskId);
      predictedBy.set(hit, ids);
    }
  }
  for (const source of sources) {
    const ids = predictedBy.get(source.path) ?? new Set<string>();
    for (const taskId of namedSourceTasks(source.path, tasks)) ids.add(taskId);
    if (ids.size > 0) predictedBy.set(source.path, ids);
  }

  const findings: OwnershipFinding[] = [];
  for (const [test, taskIds] of predictedBy) {
    if (owners(test).length === 0) {
      const ids = [...taskIds].sort();
      findings.push({
        code: "unowned-test",
        test,
        taskIds: ids,
        detail: `${test} is a dedicated test of source owned by ${ids.join(", ")} but no task owns the test`,
      });
    }
  }

  for (const source of sources) {
    for (const owner of owners(source.path)) {
      for (const path of repositoryPaths(source.text)) {
        if (!owner.allows(path)) {
          findings.push({
            code: "test-path-outside-allowlist",
            taskId: owner.task.id,
            test: source.path,
            path,
            detail: `${source.path} owned by ${owner.task.id} references ${path} outside that task's files[] and context[]`,
          });
        }
      }
    }
  }

  for (const reader of indexed) {
    for (const entry of reader.task.context.map(normalize)) {
      for (const owner of owners(entry)) {
        if (owner.task.id === reader.task.id || dependencyOrdered(reader.task, owner.task, byId)) continue;
        findings.push({
          code: "unordered-context-write",
          taskId: reader.task.id,
          ownerTaskId: owner.task.id,
          path: entry,
          detail: `${reader.task.id} names ${entry} as context while ${owner.task.id} owns it for writing, with no dependency order between them`,
        });
      }
    }
  }

  return findings.sort((a, b) => `${a.code}:${"test" in a ? a.test : a.path}:${"taskId" in a ? a.taskId : ""}`.localeCompare(`${b.code}:${"test" in b ? b.test : b.path}:${"taskId" in b ? b.taskId : ""}`));
}

export function renderOwnershipFinding(finding: OwnershipFinding): string {
  return `tickmarkr: ownership-lint[${finding.code}]: ${finding.detail}`;
}
