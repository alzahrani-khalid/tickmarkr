import { execFileSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { describe, expect, test } from "vitest";
import { FakeAdapter } from "../../src/adapters/fake.js";
import { shq } from "../../src/adapters/types.js";
import { SubprocessDriver } from "../../src/drivers/subprocess.js";
import { type ExecutorDriver, type Slot } from "../../src/drivers/types.js";
import { saveGraph, tickmarkrDir } from "../../src/graph/graph.js";
import { validateGraph } from "../../src/graph/schema.js";
import { runDaemon } from "../../src/run/daemon.js";
import { Journal } from "../../src/run/journal.js";
import { makeRepo, makeTestTempDir, T } from "../helpers/tmprepo.js";

const git = (repo: string, args: string[]): string =>
  execFileSync("git", args, { cwd: repo, encoding: "utf8" });

const gitOptional = (repo: string, args: string[]): string => {
  try {
    return git(repo, args);
  } catch {
    return "";
  }
};

const put = (root: string, path: string, content: string): void => {
  mkdirSync(join(root, dirname(path)), { recursive: true });
  writeFileSync(join(root, path), content);
};

const commitPaths = (repo: string, message: string, paths: string[]): void => {
  git(repo, ["add", ...paths]);
  git(repo, ["commit", "--no-gpg-sign", "-m", message]);
};

const scriptPath = (script: object): string => {
  const dir = makeTestTempDir("tickmarkr-context-script-");
  const path = join(dir, "s.json");
  writeFileSync(path, JSON.stringify({
    judge: { pass: true, criteria: [{ criterion: "c1", met: true, reason: "ok" }] },
    review: { approve: true, issues: [] },
    ...script,
  }));
  return path;
};

const setupContextRepo = (
  tasks: unknown[],
  buildScript: (repo: string) => object,
): { repo: string; fake: FakeAdapter } => {
  const repo = makeRepo({ "base.txt": "base\n" });
  saveGraph(repo, validateGraph({ version: 1, spec: { source: "prd", paths: ["p"], hash: "h" }, tasks }));
  writeFileSync(
    join(tickmarkrDir(repo), "config.yaml"),
    "judge: { adapter: fake, model: fake-1 }\nconsult: { adapter: fake, model: fake-1 }\n",
  );
  return { repo, fake: new FakeAdapter(scriptPath(buildScript(repo))) };
};

const promptPath = (repo: string, runId: string, taskId = "T1", attempt = 0): string =>
  join(tickmarkrDir(repo), "runs", runId, "prompts", `${taskId}-a${attempt}.md`);

const promptContextEntries = (prompt: string): string[] => {
  const block = /## Context \(read these first\)\n([\s\S]*?)(?:\n## |\nWhen finished|$)/.exec(prompt)?.[1] ?? "";
  return block.split("\n").filter((line) => line.startsWith("- ")).map((line) => line.slice(2));
};

const contextRoot = (repo: string, runId: string): string => join(tickmarkrDir(repo), "runs", runId, "context");

const isInside = (root: string, path: string): boolean => {
  const rel = relative(resolve(root), resolve(path));
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !rel.startsWith("/"));
};

const listFiles = (root: string): string[] => {
  if (!existsSync(root)) return [];
  const out: string[] = [];
  const visit = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      const stat = lstatSync(path);
      if (stat.isDirectory()) visit(path);
      else if (stat.isFile()) out.push(path);
    }
  };
  visit(root);
  return out.sort();
};

const readTreeText = (root: string): string =>
  listFiles(root).map((path) => readFileSync(path, "utf8")).join("\n");

const readTreeTextOutside = (root: string, excluded: string): string =>
  listFiles(root).filter((path) => !isInside(excluded, path)).map((path) => readFileSync(path, "utf8")).join("\n");

const contextMaterializedEvents = (repo: string, runId: string) =>
  Journal.open(repo, runId).read().filter((event) => event.event === "context-materialized");

const contextMissingEvents = (repo: string, runId: string) =>
  Journal.open(repo, runId).read().filter((event) => event.event === "context-missing");

const readPromptContextShell = (repo: string, runId: string, out = "observed.txt"): string => {
  const code = `
const fs = require("fs");
const prompt = fs.readFileSync(${JSON.stringify(promptPath(repo, runId))}, "utf8");
const match = /## Context \\(read these first\\)\\n([\\s\\S]*?)(?:\\n## |\\nWhen finished|$)/.exec(prompt);
const entries = (match ? match[1] : "").split("\\n").filter((line) => line.startsWith("- ")).map((line) => line.slice(2));
const bytes = entries.map((entry) => fs.readFileSync(entry, "utf8")).join("---\\n");
fs.writeFileSync(${JSON.stringify(out)}, bytes);
`;
  return `node -e ${shq(code)} && git add ${shq(out)} && git commit --no-gpg-sign -m observed`;
};

const simpleCommitShell = (path = "done.txt"): string =>
  `printf ok > ${shq(path)} && git add ${shq(path)} && git commit --no-gpg-sign -m done`;

const commitLateContextDriver = (repo: string, paths: Record<string, string>): ExecutorDriver => {
  const inner = new SubprocessDriver();
  let committed = false;
  return {
    id: "late-context",
    interactive: false,
    slot: inner.slot.bind(inner),
    run: inner.run.bind(inner),
    waitOutput: inner.waitOutput.bind(inner),
    waitAgentStatus: inner.waitAgentStatus.bind(inner),
    status: inner.status.bind(inner),
    read: inner.read.bind(inner),
    notify: inner.notify.bind(inner),
    close: inner.close.bind(inner),
    async worktree(root: string, branch: string, baseRef: string) {
      if (!committed && branch.includes("--")) {
        committed = true;
        for (const [path, content] of Object.entries(paths)) put(repo, path, content);
        commitPaths(repo, "late context", Object.keys(paths));
      }
      return inner.worktree(root, branch, baseRef);
    },
  };
};

const fileSnapshot = (paths: string[]): string =>
  paths.sort().map((path) => {
    if (!existsSync(path)) return `${path}\0missing`;
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) return `${path}\0link\0${readlinkSync(path)}`;
    if (stat.isFile()) return `${path}\0file\0${readFileSync(path).toString("hex")}`;
    return `${path}\0other`;
  }).join("\0");

const trackedTreeSnapshot = (repo: string): string => {
  const paths = git(repo, ["ls-files", "-z"]).split("\0").filter(Boolean);
  return paths.map((path) => `${path}\0${fileSnapshot([join(repo, path)])}`).join("\0");
};

const gitIgnoreSnapshot = (repo: string, worktree: string): string => {
  const common = resolve(worktree, git(worktree, ["rev-parse", "--git-common-dir"]).trim());
  const gitDir = resolve(worktree, git(worktree, ["rev-parse", "--git-dir"]).trim());
  const trackedIgnores = git(repo, ["ls-files", "-z"])
    .split("\0")
    .filter((path) => path === ".gitignore" || path.endsWith("/.gitignore"))
    .map((path) => join(repo, path));
  const configuredExcludes = gitOptional(worktree, ["config", "--get-all", "--path", "core.excludesFile"])
    .split("\n")
    .filter(Boolean)
    .map((path) => resolve(worktree, path));
  return fileSnapshot([...new Set([
    ...trackedIgnores,
    join(common, "config"),
    join(gitDir, "config.worktree"),
    join(common, "info", "exclude"),
    join(gitDir, "info", "exclude"),
    ...configuredExcludes,
  ])]);
};

const filesystemSnapshot = (root: string): string => {
  const paths: string[] = [];
  const visit = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      if (name === ".git") continue;
      const path = join(dir, name);
      const stat = lstatSync(path);
      if (stat.isDirectory()) visit(path);
      else paths.push(path);
    }
  };
  visit(root);
  return fileSnapshot(paths);
};

describe("runDaemon context materialization", () => {
  test("test: two context paths committed after baseRef sharing one basename with distinct bytes are each materialized before dispatch under the run state context subtree byte-identical to their own committed blobs at distinct contained destinations and each rewritten prompt entry reads back its own bytes while a basename-keyed destination that lets the second entry overwrite or alias the first fails", async () => {
    const runId = "run-context-two";
    const left = "left bytes\n";
    const right = "right bytes\n";
    const { repo, fake } = setupContextRepo(
      [T("T1", { files: ["observed.txt"], context: ["docs/a/shared.md", "notes/b/shared.md"] })],
      (r) => ({ tasks: { T1: [{ shell: readPromptContextShell(r, runId), result: { ok: true, summary: "read" } }] } }),
    );

    const summary = await runDaemon(repo, {
      adapters: [fake],
      runId,
      driver: commitLateContextDriver(repo, { "docs/a/shared.md": left, "notes/b/shared.md": right }),
    });

    expect(summary.done).toEqual(["T1"]);
    const root = contextRoot(repo, runId);
    const promptEntries = promptContextEntries(readFileSync(promptPath(repo, runId), "utf8"));
    expect(promptEntries).toHaveLength(2);
    expect(new Set(promptEntries).size).toBe(2);
    expect(promptEntries.every((entry) => isInside(root, entry))).toBe(true);
    expect(promptEntries.map((entry) => readFileSync(entry, "utf8"))).toEqual([left, right]);
    expect(git(repo, ["show", `${summary.branch}:observed.txt`])).toBe(`${left}---\n${right}`);
  });

  test("test: every materialized byte lands inside the dedicated run state context subtree and a filesystem observation of the worker worktree the operator's tracked tree outside that subtree and every git ignore configuration shows each unchanged while an oracle that infers no-write from clean git porcelain alone or a mechanism that mutates the shared info exclude fails", async () => {
    const runId = "run-context-boundary";
    const byte = "boundary materialized bytes\n";
    const repoHolder = setupContextRepo(
      [T("T1", { files: ["done.txt"], context: ["late/boundary.txt"] })],
      () => ({ tasks: { T1: [{ shell: simpleCommitShell(), result: { ok: true, summary: "done" } }] } }),
    );
    const excludesFile = join(makeTestTempDir("tickmarkr-context-excludes-"), "core-excludes");
    writeFileSync(excludesFile, "excluded-by-core\n");
    git(repoHolder.repo, ["config", "core.excludesFile", excludesFile]);
    const observed: {
      beforeWorktree?: string;
      afterWorktree?: string;
      beforeTracked?: string;
      afterTracked?: string;
      beforeIgnores?: string;
      afterIgnores?: string;
    } = {};
    const driver: ExecutorDriver = (() => {
      const inner = commitLateContextDriver(repoHolder.repo, { "late/boundary.txt": byte });
      return {
        ...inner,
        async worktree(root: string, branch: string, baseRef: string) {
          const wt = await inner.worktree(root, branch, baseRef);
          if (branch.includes("--")) {
            observed.beforeWorktree = filesystemSnapshot(wt);
            observed.beforeTracked = trackedTreeSnapshot(repoHolder.repo);
            observed.beforeIgnores = gitIgnoreSnapshot(repoHolder.repo, wt);
          }
          return wt;
        },
        async run(slot: Slot, cmd: string) {
          observed.afterWorktree = filesystemSnapshot(slot.cwd);
          observed.afterTracked = trackedTreeSnapshot(repoHolder.repo);
          observed.afterIgnores = gitIgnoreSnapshot(repoHolder.repo, slot.cwd);
          await inner.run(slot, cmd);
        },
      };
    })();

    const summary = await runDaemon(repoHolder.repo, { adapters: [repoHolder.fake], runId, driver });

    expect(summary.done).toEqual(["T1"]);
    expect(observed.beforeWorktree).toBeDefined();
    expect(observed.beforeTracked).toBeDefined();
    expect(observed.beforeIgnores).toBeDefined();
    expect(observed.afterWorktree).toBeDefined();
    expect(observed.afterTracked).toBeDefined();
    expect(observed.afterIgnores).toBeDefined();
    expect(observed.afterWorktree).toBe(observed.beforeWorktree);
    expect(observed.afterTracked).toBe(observed.beforeTracked);
    expect(observed.afterIgnores).toBe(observed.beforeIgnores);
    const files = listFiles(contextRoot(repoHolder.repo, runId));
    expect(files.every((path) => isInside(contextRoot(repoHolder.repo, runId), path))).toBe(true);
    expect(files.map((path) => readFileSync(path, "utf8"))).toEqual([byte]);
    expect(readTreeTextOutside(join(tickmarkrDir(repoHolder.repo), "runs", runId), contextRoot(repoHolder.repo, runId))).not.toContain(byte);
    expect(git(repoHolder.repo, ["status", "--porcelain", "--untracked-files=no"]).trim()).toBe("");
  });

  test("materialized context refuses a symlinked destination ancestor before writing committed bytes", async () => {
    const runId = "run-context-parent-symlink";
    const byte = "parent symlink escape bytes\n";
    const escapeDir = makeTestTempDir("tickmarkr-context-escape-");
    const repoHolder = setupContextRepo(
      [T("T1", { files: ["done.txt"], context: ["late/escape.txt"] })],
      () => ({ tasks: { T1: [{ shell: simpleCommitShell(), result: { ok: true, summary: "done" } }] } }),
    );
    const driver: ExecutorDriver = (() => {
      const inner = commitLateContextDriver(repoHolder.repo, { "late/escape.txt": byte });
      return {
        ...inner,
        async worktree(root: string, branch: string, baseRef: string) {
          const wt = await inner.worktree(root, branch, baseRef);
          if (branch.includes("--")) {
            mkdirSync(join(contextRoot(repoHolder.repo, runId), "T1"), { recursive: true });
            symlinkSync(escapeDir, join(contextRoot(repoHolder.repo, runId), "T1", "a0"), "dir");
          }
          return wt;
        },
      };
    })();

    const summary = await runDaemon(repoHolder.repo, { adapters: [repoHolder.fake], runId, driver });

    expect(summary.failed).toEqual(["T1"]);
    expect(summary.done).toEqual([]);
    expect(readTreeText(escapeDir)).not.toContain(byte);
    expect(contextMaterializedEvents(repoHolder.repo, runId)).toEqual([]);
    expect(Journal.open(repoHolder.repo, runId).read().find((event) => event.event === "task-failed")?.data.error)
      .toContain("destination ancestor is a symlink");
  });

  test("test: a literal context path absent from the committed daemon tree journals a context-missing event naming the path and the prompt omits it while a prompt embedding a path no surface can read fails", async () => {
    const runId = "run-context-missing-literal";
    const missing = "missing/context.txt";
    const unreadable = "base.txt/nested.md";
    const { repo, fake } = setupContextRepo(
      [T("T1", { files: ["done.txt"], context: [missing, unreadable] })],
      () => ({ tasks: { T1: [{ shell: simpleCommitShell(), result: { ok: true, summary: "done" } }] } }),
    );

    const summary = await runDaemon(repo, { adapters: [fake], runId });

    expect(summary.done).toEqual(["T1"]);
    expect(contextMissingEvents(repo, runId).map((event) => event.data.path).sort()).toEqual([missing, unreadable].sort());
    const prompt = readFileSync(promptPath(repo, runId), "utf8");
    expect(prompt).not.toContain(missing);
    expect(prompt).not.toContain(unreadable);
    expect(promptContextEntries(prompt)).toEqual([]);
  });

  test("test: a context path present at baseRef is left to the tracked worktree copy with nothing materialized or rewritten while an unconditional rewrite that shadows tracked context fails", async () => {
    const runId = "run-context-base";
    const path = "docs/stable.md";
    const bytes = "tracked base bytes\n";
    const { repo, fake } = setupContextRepo(
      [T("T1", { files: ["observed.txt"], context: [path] })],
      (r) => ({ tasks: { T1: [{ shell: readPromptContextShell(r, runId), result: { ok: true, summary: "read" } }] } }),
    );
    put(repo, path, bytes);
    commitPaths(repo, "base context", [path]);

    const summary = await runDaemon(repo, { adapters: [fake], runId });

    expect(summary.done).toEqual(["T1"]);
    const prompt = readFileSync(promptPath(repo, runId), "utf8");
    expect(promptContextEntries(prompt)).toEqual([path]);
    expect(contextMaterializedEvents(repo, runId)).toEqual([]);
    expect(listFiles(contextRoot(repo, runId))).toEqual([]);
    expect(git(repo, ["show", `${summary.branch}:observed.txt`])).toBe(bytes);
  });

  test("test: a glob or directory context entry that resolves in the worker worktree keeps its shipped prompt form with no context-missing event and one resolving to nothing journals context-missing naming the entry and is omitted from the prompt while a materializer that journals missing for every non-literal entry or treats a resolving glob as a missing literal fails", async () => {
    const runId = "run-context-glob-dir";
    const keptDir = "ctx/dir";
    const keptGlob = "ctx/glob/*.md";
    const ignoredGlob = "ctx/ignored/*.md";
    const missingGlob = "ctx/none/*.md";
    const missingDir = "ctx/missing-dir/";
    const { repo, fake } = setupContextRepo(
      [T("T1", { files: ["done.txt"], context: [keptDir, keptGlob, ignoredGlob, missingGlob, missingDir] })],
      () => ({ tasks: { T1: [{ shell: simpleCommitShell(), result: { ok: true, summary: "done" } }] } }),
    );
    put(repo, ".gitignore", "ctx/ignored/*.md\n");
    put(repo, "ctx/dir/a.md", "dir\n");
    put(repo, "ctx/glob/one.md", "glob\n");
    commitPaths(repo, "base glob context", [".gitignore", "ctx/dir/a.md", "ctx/glob/one.md"]);
    const driver: ExecutorDriver = (() => {
      const inner = new SubprocessDriver();
      return {
        id: "ignored-context",
        interactive: false,
        slot: inner.slot.bind(inner),
        run: inner.run.bind(inner),
        waitOutput: inner.waitOutput.bind(inner),
        waitAgentStatus: inner.waitAgentStatus.bind(inner),
        status: inner.status.bind(inner),
        read: inner.read.bind(inner),
        notify: inner.notify.bind(inner),
        close: inner.close.bind(inner),
        async worktree(root: string, branch: string, baseRef: string) {
          const wt = await inner.worktree(root, branch, baseRef);
          if (branch.includes("--")) put(wt, "ctx/ignored/ignored.md", "ignored but readable\n");
          return wt;
        },
      };
    })();

    const summary = await runDaemon(repo, { adapters: [fake], runId, driver });

    expect(summary.done).toEqual(["T1"]);
    expect(promptContextEntries(readFileSync(promptPath(repo, runId), "utf8"))).toEqual([keptDir, keptGlob, ignoredGlob]);
    const missing = contextMissingEvents(repo, runId).map((event) => event.data.path).sort();
    expect(missing).toEqual([missingDir, missingGlob].sort());
    expect(contextMaterializedEvents(repo, runId)).toEqual([]);
  });

  test("test: the source binds to the normalized repository-relative regular-file blob and the destination to a keyed filename inside the context subtree so a traversal segment a symlink and an existing checkout-only file are each omitted with context-missing journaled and their bytes appearing nowhere in the run state subtree the prompt the worker input or any journal or error text while the committed-after-baseRef control still materializes byte-identically", async () => {
    const runId = "run-context-secure-source";
    const traversalSecret = "TRAVERSAL-SECRET";
    const internalTraversalSecret = "INTERNAL-TRAVERSAL-SECRET";
    const symlinkSecret = "SYMLINK-SECRET";
    const checkoutOnlySecret = "CHECKOUT-ONLY-SECRET";
    const control = "CONTROL-BYTES\n";
    const bracketBytes = "BRACKET-LITERAL-BYTES\n";
    const braceBytes = "BRACE-LITERAL-BYTES\n";
    const internalTraversal = "safe/../late/traversal.txt";
    const bracketPath = "app/[id]/page.tsx";
    const bracePath = "config/{prod,dev}/settings.json";
    const repoHolder = setupContextRepo(
      [T("T1", {
        files: ["done.txt"],
        context: [
          "../outside-secret.txt",
          internalTraversal,
          "links/secret-link.txt",
          "checkout-only.txt",
          "late/control.txt",
          bracketPath,
          bracePath,
        ],
      })],
      () => ({ tasks: { T1: [{ shell: simpleCommitShell(), result: { ok: true, summary: "done" } }] } }),
    );
    put(repoHolder.repo, "app/i/page.tsx", "bracket pattern sibling\n");
    put(repoHolder.repo, "config/prod/settings.json", "brace pattern sibling\n");
    commitPaths(repoHolder.repo, "base pattern siblings", ["app/i/page.tsx", "config/prod/settings.json"]);
    const outside = join(dirname(repoHolder.repo), "outside-secret.txt");
    writeFileSync(outside, traversalSecret);
    const driver: ExecutorDriver = (() => {
      const inner = new SubprocessDriver();
      let committed = false;
      return {
        id: "secure-context",
        interactive: false,
        slot: inner.slot.bind(inner),
        waitOutput: inner.waitOutput.bind(inner),
        waitAgentStatus: inner.waitAgentStatus.bind(inner),
        status: inner.status.bind(inner),
        read: inner.read.bind(inner),
        notify: inner.notify.bind(inner),
        close: inner.close.bind(inner),
        async run(slot: Slot, cmd: string) {
          rmSync(join(slot.cwd, "checkout-only.txt"), { force: true });
          await inner.run(slot, cmd);
        },
        async worktree(root: string, branch: string, baseRef: string) {
          if (!committed && branch.includes("--")) {
            committed = true;
            mkdirSync(join(repoHolder.repo, "links"), { recursive: true });
            symlinkSync(symlinkSecret, join(repoHolder.repo, "links/secret-link.txt"));
            put(repoHolder.repo, "late/traversal.txt", internalTraversalSecret);
            put(repoHolder.repo, "late/control.txt", control);
            put(repoHolder.repo, bracketPath, bracketBytes);
            put(repoHolder.repo, bracePath, braceBytes);
            writeFileSync(join(repoHolder.repo, "checkout-only.txt"), checkoutOnlySecret);
            commitPaths(repoHolder.repo, "late secure context", [
              "links/secret-link.txt",
              "late/traversal.txt",
              "late/control.txt",
              bracketPath,
              bracePath,
            ]);
          }
          const wt = await inner.worktree(root, branch, baseRef);
          if (branch.includes("--")) writeFileSync(join(wt, "checkout-only.txt"), checkoutOnlySecret);
          return wt;
        },
      };
    })();

    const summary = await runDaemon(repoHolder.repo, { adapters: [repoHolder.fake], runId, driver });

    expect(summary.done).toEqual(["T1"]);
    const root = contextRoot(repoHolder.repo, runId);
    const prompt = readFileSync(promptPath(repoHolder.repo, runId), "utf8");
    const entries = promptContextEntries(prompt);
    expect(entries).toHaveLength(3);
    expect(entries.every((entry) => isInside(root, entry))).toBe(true);
    expect(new Set(entries).size).toBe(3);
    const materialized = new Map(contextMaterializedEvents(repoHolder.repo, runId)
      .map((event) => [String(event.data.path), String(event.data.destination)]));
    expect([...materialized.keys()]).toEqual(["late/control.txt", bracketPath, bracePath]);
    expect(readFileSync(materialized.get("late/control.txt")!, "utf8")).toBe(control);
    expect(readFileSync(materialized.get(bracketPath)!, "utf8")).toBe(bracketBytes);
    expect(readFileSync(materialized.get(bracePath)!, "utf8")).toBe(braceBytes);
    expect(contextMissingEvents(repoHolder.repo, runId).map((event) => event.data.path).sort()).toEqual([
      "../outside-secret.txt",
      internalTraversal,
      "checkout-only.txt",
      "links/secret-link.txt",
    ].sort());
    const runState = readTreeText(join(tickmarkrDir(repoHolder.repo), "runs", runId));
    const workerInput = [
      prompt,
      readFileSync(promptPath(repoHolder.repo, runId).replace(/\.md$/, ".sh"), "utf8"),
    ].join("\n");
    const journalText = readFileSync(join(tickmarkrDir(repoHolder.repo), "runs", runId, "journal.jsonl"), "utf8");
    for (const secret of [traversalSecret, internalTraversalSecret, symlinkSecret, checkoutOnlySecret]) {
      expect(runState).not.toContain(secret);
      expect(prompt).not.toContain(secret);
      expect(workerInput).not.toContain(secret);
      expect(journalText).not.toContain(secret);
    }
  });
});
