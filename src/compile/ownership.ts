import { readFileSync, readdirSync } from "node:fs";
import { basename, extname, join, posix } from "node:path";
import { filesGlob } from "../graph/files-glob.js";
import type { Task } from "../graph/schema.js";
import { collateralHits } from "./collateral.js";

export type OwnershipCorroboration =
  | { kind: "direct-import"; source: string }
  | { kind: "command-entry-spawn"; source: string; entry: "src/cli/index.ts" };

export type OwnershipFinding =
  | { code: "unowned-test"; test: string; taskIds: string[]; corroboration?: OwnershipCorroboration; detail: string }
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

// Conventional, not universal: a name match supplies candidates only. Compile may refuse one when the
// test itself also supplies one of the two corroborating edges below; the raw name mapping stays data.
type NamedSource = { taskId: string; source: string; fromGlob: boolean };

function sourceFiles(repoRoot: string): string[] {
  const root = join(repoRoot, "src");
  try {
    return readdirSync(root, { recursive: true, encoding: "utf8" })
      .filter((path) => /\.(?:[cm]?[jt]sx?)$/.test(path))
      .map((path) => `src/${normalize(path)}`)
      .sort();
  } catch {
    return [];
  }
}

// OBS-898: `allSources` is indexed once per ownership pass by the caller, never per test source.
function namedSources(test: string, tasks: readonly Task[], allSources: readonly string[]): NamedSource[] {
  const stem = basename(test).replace(/\.test\.ts$/, "");
  const matches = new Map<string, NamedSource>();
  for (const task of tasks) {
    for (const entry of task.files.map(normalize).filter((path) => path.startsWith("src/"))) {
      const fromGlob = /[*?{[]/.test(entry);
      const entries = fromGlob ? allSources.filter(filesGlob(entry)) : [entry];
      for (const sourcePath of entries) {
        const source = basename(sourcePath, extname(sourcePath));
        if (stem === source || stem.startsWith(`${source}-`)) {
          matches.set(`${task.id}:${sourcePath}`, { taskId: task.id, source: sourcePath, fromGlob });
        }
      }
    }
  }
  return [...matches.values()];
}

const moduleKey = (path: string): string => normalize(path).replace(/\.(?:[cm]?[jt]sx?)$/, "");

function directImportSpecifiers(text: string): string[] {
  // Comments cannot create an edge. Keep strings intact because they are the import target.
  const source = text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  const specifiers = new Set<string>();
  for (const match of source.matchAll(/\bimport\s+(?:type\s+)?(?:[\w$*{},\s]+?\s+from\s+)?["']([^"']+)["']/g)) {
    specifiers.add(match[1]);
  }
  for (const match of source.matchAll(/\bimport\s*\(\s*["']([^"']+)["']\s*\)/g)) {
    specifiers.add(match[1]);
  }
  return [...specifiers];
}

function directlyImports(test: TestSource, source: string): boolean {
  // DIRECT is load-bearing: do not walk through imported helpers. src/run/journal.ts alone has 84
  // test importers in the measured tree, so transitive closure would recreate the raw alarm flood.
  const target = moduleKey(source);
  return directImportSpecifiers(test.text).some((specifier) => {
    const imported = specifier.startsWith(".")
      ? posix.normalize(posix.join(posix.dirname(test.path), specifier))
      : specifier.startsWith("src/") ? specifier : "";
    return imported !== "" && moduleKey(imported) === target;
  });
}

function invokesChildProcessSpawn(text: string): boolean {
  const source = text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  const bindings = new Set<string>();
  for (const match of source.matchAll(/\bimport\s*{([^}]*)}\s*from\s*["'](?:node:)?child_process["']/g)) {
    for (const member of match[1].split(",")) {
      const binding = member.trim().match(/^spawn(?:Sync)?(?:\s+as\s+([A-Za-z_$][\w$]*))?$/);
      if (binding) bindings.add(binding[1] ?? member.trim());
    }
  }
  for (const match of source.matchAll(/\bimport\s*\*\s*as\s*([A-Za-z_$][\w$]*)\s*from\s*["'](?:node:)?child_process["']/g)) {
    if (new RegExp(`\\b${match[1]}\\.spawn(?:Sync)?\\s*\\(`).test(source)) return true;
  }
  return [...bindings].some((binding) => new RegExp(`\\b${binding}\\s*\\(`).test(source));
}

function mentionsCommandEntry(text: string): boolean {
  return /(?:^|\/)src\/cli\/index\.(?:ts|js)\b/.test(text)
    || /["'`]src["'`]\s*,\s*["'`]cli["'`]\s*,\s*["'`]index\.(?:ts|js)["'`]/.test(text);
}

function corroboration(test: TestSource, matches: readonly NamedSource[]): OwnershipCorroboration | undefined {
  // A .test.ts-shaped collateral fixture is not by itself a dedicated test. Requiring a runner leaf
  // keeps import-only scan fixtures advisory while every executable subject in the measured union stays.
  const executable = test.text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  if (!/\b(?:test|it)(?:\.(?:concurrent|each|fails|only|skip|todo))*\s*\(/.test(executable)) return undefined;
  for (const match of matches) {
    if (directlyImports(test, match.source)) return { kind: "direct-import", source: match.source };
  }
  if (invokesChildProcessSpawn(test.text) && mentionsCommandEntry(test.text)) {
    const command = matches.find(({ source }) => /^src\/cli\/commands\/[^/]+\.(?:[cm]?[jt]sx?)$/.test(source));
    if (command) return { kind: "command-entry-spawn", source: command.source, entry: "src/cli/index.ts" };
  }
  return undefined;
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
 * Cross-task ownership evidence. Findings are data: this checker never throws or changes the graph;
 * the compile seam promotes only a corroborated unowned-test finding and reports every other shape.
 */
export function ownershipFindings(tasks: readonly Task[], repoRoot: string): OwnershipFinding[] {
  const sources = testSources(repoRoot);
  const sourceByPath = new Map(sources.map((source) => [source.path, source]));
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
      if (!sourceByPath.has(hit)) continue;
      const ids = predictedBy.get(hit) ?? new Set<string>();
      ids.add(taskId);
      predictedBy.set(hit, ids);
    }
  }
  const globOwnedTests = new Map<string, Set<string>>();
  const allSources = sourceFiles(repoRoot);
  for (const source of sources) {
    const ids = predictedBy.get(source.path) ?? new Set<string>();
    for (const named of namedSources(source.path, tasks, allSources)) {
      ids.add(named.taskId);
      if (named.fromGlob) {
        const owners = globOwnedTests.get(source.path) ?? new Set<string>();
        owners.add(named.taskId);
        globOwnedTests.set(source.path, owners);
      }
    }
    if (ids.size > 0) predictedBy.set(source.path, ids);
  }

  const findings: OwnershipFinding[] = [];
  for (const [test, taskIds] of predictedBy) {
    if (owners(test).length === 0 && !(globOwnedTests.get(test)?.size)) {
      const ids = [...taskIds].sort();
      const source = sourceByPath.get(test)!;
      const evidence = corroboration(source, namedSources(test, tasks, allSources));
      findings.push({
        code: "unowned-test",
        test,
        taskIds: ids,
        ...(evidence ? { corroboration: evidence } : {}),
        detail: `${test} is a dedicated test of source owned by ${ids.join(", ")} but no task owns the test`
          + (evidence?.kind === "direct-import" ? `; it imports ${evidence.source} directly`
            : evidence?.kind === "command-entry-spawn"
              ? `; it spawns ${evidence.entry} to exercise ${evidence.source}` : ""),
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

export function blocksCompile(finding: OwnershipFinding): boolean {
  return finding.code === "unowned-test" && finding.corroboration !== undefined;
}
