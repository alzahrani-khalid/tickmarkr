import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { type CodexCommitProbe, probeCodexCommit } from "../../src/adapters/codex-commit-check.js";
import { preserveWorktree, resetSpawnForTests, setSpawnForTests, sh, shell, shGit, shGitOk, shOk } from "../../src/run/git.js";
import { GitTrustRefusal, INERT_HOOKS_PATH, trustedCommonDir } from "../../src/run/git-trust.js";
import {
  captureOwedCheck, foldOwedChecks, GATE_SATISFIED_RELEASE, type JournalEvent, OWED_DISCHARGE_EVENT,
  owedAuthors, type OwedProofMemo, owedSubject, rangePatch, rangePatches,
} from "../../src/run/journal.js";
import { makeRepo, makeTestTempDir } from "../helpers/tmprepo.js";

// v2.6.7 T4 (GHSA-2): owned temporary ordinary repositories and REAL linked worktrees; a printed common-dir
// path is never repository identity, so every hostile row compares complete ref maps in BOTH repositories.

// Raw controls run with no forced config inherited from an enclosing protected shell (a gate battery's suite).
const rawEnv = (extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => {
  const env = { ...process.env, ...extra };
  if (!("GIT_CONFIG_PARAMETERS" in extra)) delete env.GIT_CONFIG_PARAMETERS;
  return env;
};
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", env: rawEnv() }).trim();
const refMap = (repo: string) => git(repo, "for-each-ref", "--format=%(refname) %(objectname)") + `\nHEAD ${git(repo, "rev-parse", "HEAD")}`;
const witnessScript = (dir: string, name: string, witness: string, exit = 0): string => {
  const path = join(dir, name);
  writeFileSync(path, `#!/bin/sh\nprintf '%s\\n' "${name} $*" >> '${witness}'\nexit ${exit}\n`, { mode: 0o755 });
  return path;
};
const read = (path: string) => (existsSync(path) ? readFileSync(path, "utf8") : "");

interface Fixture { repo: string; common: string; linked: string; gitdir: string; hostile: string; hostileCommon: string; scratch: string }
const fixture = (): Fixture => {
  const repo = makeRepo({ "a.txt": "one\n", "sub/b.txt": "two\n" });
  const scratch = makeTestTempDir("git-trust-");
  const linked = join(scratch, "task");
  git(repo, "worktree", "add", "-q", "-b", "task", linked, "HEAD");
  const common = realpathSync(join(repo, ".git"));
  const hostile = makeRepo({ "evil.txt": "evil\n" });
  return { repo, common, linked, gitdir: join(common, "worktrees", "task"), hostile, hostileCommon: realpathSync(join(hostile, ".git")), scratch };
};

/** A seat deletes its own commondir and plants standalone repository metadata: raw git takes the gitdir as the repo. */
const plantStandalone = (gitdir: string) => {
  rmSync(join(gitdir, "commondir"));
  mkdirSync(join(gitdir, "objects"), { recursive: true });
  writeFileSync(join(gitdir, "config"), "[core]\n\trepositoryformatversion = 0\n");
};
const unplantStandalone = (gitdir: string, commondir: string) => {
  rmSync(join(gitdir, "objects"), { recursive: true, force: true });
  rmSync(join(gitdir, "config"), { force: true });
  writeFileSync(join(gitdir, "commondir"), commondir);
};
/**
 * commondir bytes that name the REAL common directory to a reader that trims or lexically normalizes, while git —
 * which keeps a leading space and resolves a symlink before `..` — follows a seat-planted symlink to the hostile
 * common directory. Each returns its restore. No race: the metadata is stationary.
 */
const GIT_PATH_BYPASSES: Record<string, (f: Fixture, original: string) => () => void> = {
  "leading space": (f, original) => {
    const parent = join(f.gitdir, ` ${dirname(f.common)}`);
    mkdirSync(parent, { recursive: true });
    symlinkSync(f.hostileCommon, join(parent, basename(f.common)));
    writeFileSync(join(f.gitdir, "commondir"), ` ${f.common}\n`);
    return () => { rmSync(join(f.gitdir, " "), { recursive: true }); writeFileSync(join(f.gitdir, "commondir"), original); };
  },
  "symlink before ..": (f, original) => {
    const deep = join(f.hostileCommon, "t4", "a", "b");
    mkdirSync(deep, { recursive: true });
    symlinkSync(deep, join(f.gitdir, "s"));
    writeFileSync(join(f.gitdir, "commondir"), "s/../../..\n");
    return () => { rmSync(join(f.gitdir, "s")); rmSync(join(f.hostileCommon, "t4"), { recursive: true }); writeFileSync(join(f.gitdir, "commondir"), original); };
  },
};

type Wrapper = { name: string; run: (cmd: string, cwd: string) => Promise<string> };
const ok = async (r: Promise<{ code: number; stdout: string; stderr: string }>) => {
  const res = await r;
  if (res.code !== 0) throw new Error(`exit ${res.code}: ${res.stderr}`);
  return res.stdout;
};
const WRAPPERS: Wrapper[] = [
  { name: "shell login=false", run: (c, cwd) => ok(shell(c, cwd, 60_000, false)) },
  { name: "shell login=true", run: (c, cwd) => ok(shell(c, cwd, 60_000, true)) },
  { name: "shell explicit env", run: (c, cwd) => ok(shell(c, cwd, 60_000, false, { env: { ...process.env, TKR_T4_EXPLICIT: "1" } })) },
  { name: "sh", run: (c, cwd) => ok(sh(c, cwd)) },
  { name: "shOk", run: (c, cwd) => shOk(c, cwd) },
  { name: "shGit", run: (c, cwd) => ok(shGit(c, cwd)) },
  { name: "shGitOk", run: (c, cwd) => shGitOk(c, cwd) },
];

/** Every wrapper must refuse naming `path` BEFORE spawning: the command's own witness stays absent. */
const expectRefusals = async (cwd: string, path: string, f: Fixture, why: string, refs = true) => {
  const before = refs ? [refMap(f.repo), refMap(f.hostile)] : [];
  const spawned = join(f.scratch, "spawned");
  for (const w of WRAPPERS) {
    const refusal = await w.run(`touch '${spawned}' && git status --porcelain`, cwd).then(() => undefined, (e: unknown) => e);
    expect(refusal, `${why}: ${w.name}`).toBeInstanceOf(GitTrustRefusal);
    expect((refusal as GitTrustRefusal).path, `${why}: ${w.name}`).toBe(path);
    expect((refusal as GitTrustRefusal).message).toContain(path);
    expect(existsSync(spawned), `${why}: ${w.name} spawned`).toBe(false);
  }
  if (refs) expect([refMap(f.repo), refMap(f.hostile)], why).toEqual(before);
};
const expectClean = async (cwd: string, why: string) => {
  const raw = execFileSync("sh", ["-c", "git status --porcelain && git diff"], { cwd, encoding: "utf8", env: rawEnv() });
  for (const w of WRAPPERS) {
    const out = await w.run("git status --porcelain && git diff", cwd);
    expect(out.trim(), `${why}: ${w.name}`).toBe(raw.trim());
  }
};

afterEach(() => resetSpawnForTests());

describe("v2.6.7 T4 closed invocation trust table", () => {
  test("production shell wrappers satisfy the closed invocation trust table C1 C2 R1 R3 G2 versus cached trust or refusal", async () => {
    const f = fixture();
    // C1: a clean ordinary checkout and a cwd below its root behave as before — outputs, add and index identity
    writeFileSync(join(f.repo, "a.txt"), "one changed\n");
    await expectClean(f.repo, "C1 root");
    await expectClean(join(f.repo, "sub"), "C1 below root");
    await shGitOk("git add a.txt", f.repo);
    expect(git(f.repo, "diff", "--cached", "--name-only")).toBe("a.txt");
    // unrelated non-Git commands in a temporary non-repository still run
    const plain = makeTestTempDir("git-trust-plain-");
    for (const w of WRAPPERS) expect((await w.run("echo plain", plain)).trim(), w.name).toBe("plain");

    // C2: a clean real linked worktree, root and below, plus the extension-disabled/present-file and
    // extension-enabled/absent-file controls — refusing every enabled extension fails here
    writeFileSync(join(f.linked, "a.txt"), "linked change\n");
    await expectClean(f.linked, "C2 root");
    await expectClean(join(f.linked, "sub"), "C2 below root");
    git(f.repo, "config", "extensions.worktreeConfig", "false");
    writeFileSync(join(f.gitdir, "config.worktree"), "[core]\n\tfsmonitor = false\n");
    await expectClean(f.linked, "C2 disabled extension, present config.worktree");
    rmSync(join(f.gitdir, "config.worktree"));
    git(f.repo, "config", "extensions.worktreeConfig", "true");
    await expectClean(f.linked, "C2 enabled extension, absent config.worktree");
    expect(trustedCommonDir(join(f.linked, "sub"))).toBe(f.common);

    // R1: absolute and relative redirects to the hostile common directory refuse naming commondir and the mismatch
    const commondir = join(f.gitdir, "commondir");
    const original = readFileSync(commondir, "utf8");
    writeFileSync(commondir, `${f.hostileCommon}\n`);
    await expectRefusals(f.linked, commondir, f, "R1 absolute");
    const refusal = await shGit("git status", f.linked).catch((e: GitTrustRefusal) => e);
    expect((refusal as GitTrustRefusal).message).toContain(`resolves to ${f.hostileCommon}, not the expected common directory ${f.common}`);
    writeFileSync(commondir, `${relative(f.gitdir, f.hostileCommon)}\n`);
    await expectRefusals(f.linked, commondir, f, "R1 relative");
    // a different relative spelling resolving to the expected real common directory succeeds
    writeFileSync(commondir, "../../../.git/\n");
    await expectClean(f.linked, "R1 real respelled");
    writeFileSync(commondir, original);
    // R1 deleted: the raw control takes the seat-writable gitdir as its own repository; authority stays the real
    // common directory (the layout decides, not commondir's presence) and every wrapper refuses naming commondir
    plantStandalone(f.gitdir);
    expect(git(f.linked, "rev-parse", "--path-format=absolute", "--git-common-dir")).toBe(f.gitdir);
    expect(trustedCommonDir(f.linked)).toBe(f.common);
    await expectRefusals(f.linked, commondir, f, "R1 deleted");
    unplantStandalone(f.gitdir, original);
    // R1 path semantics: commondir read as git reads it — the raw control follows the planted symlink to the
    // hostile repository (and reads its blob), every wrapper refuses naming commondir before spawning
    for (const [why, plant] of Object.entries(GIT_PATH_BYPASSES)) {
      const restore = plant(f, original);
      expect(git(f.linked, "rev-parse", "--path-format=absolute", "--git-common-dir"), why).toBe(f.hostileCommon);
      expect(git(f.linked, "cat-file", "blob", `${git(f.hostile, "rev-parse", "HEAD")}:evil.txt`), why).toBe("evil");
      expect(trustedCommonDir(f.linked), why).toBe(f.common);
      await expectRefusals(f.linked, commondir, f, `R1 ${why}`);
      restore();
      await expectClean(f.linked, `R1 ${why} restored`);
    }

    // R3: trusted common config enables the extension and the linked gitdir holds config.worktree
    const worktreeConfig = join(f.gitdir, "config.worktree");
    writeFileSync(worktreeConfig, "[core]\n\tfsmonitor = false\n");
    await expectRefusals(f.linked, worktreeConfig, f, "R3");
    // an unparseable authority never becomes clean authority
    const config = readFileSync(join(f.common, "config"), "utf8");
    expect(config).toContain("worktreeConfig = true");
    const refsBefore = [refMap(f.repo), refMap(f.hostile)]; // raw git itself cannot read the unparseable repository
    writeFileSync(join(f.common, "config"), config.replace("worktreeConfig = true", "worktreeConfig = maybe"));
    await expectRefusals(f.linked, join(f.common, "config"), f, "R3 unparseable authority", false);
    writeFileSync(join(f.common, "config"), config);
    expect([refMap(f.repo), refMap(f.hostile)]).toEqual(refsBefore);
    rmSync(worktreeConfig);

    // G2: clean, hostile, restored in the SAME worktree for every wrapper and every variant — no cached verdict
    const variants = {
      commondir: { path: commondir, make: () => writeFileSync(commondir, `${f.hostileCommon}\n`), restore: () => writeFileSync(commondir, original) },
      "deleted commondir": { path: commondir, make: () => plantStandalone(f.gitdir), restore: () => unplantStandalone(f.gitdir, original) },
      "config.worktree": { path: worktreeConfig, make: () => writeFileSync(worktreeConfig, "[core]\n\tfsmonitor = false\n"), restore: () => rmSync(worktreeConfig) },
    };
    for (const [variant, { path, make, restore }] of Object.entries(variants)) {
      for (const w of WRAPPERS) {
        expect((await w.run("git rev-parse --show-toplevel", f.linked)).trim(), `${variant} ${w.name} call 1`).toBe(realpathSync(f.linked));
        make();
        await expect(w.run("git rev-parse --show-toplevel", f.linked), `${variant} ${w.name} call 2`).rejects.toMatchObject({ name: "GitTrustRefusal", path });
        restore();
        expect((await w.run("git rev-parse --show-toplevel", f.linked)).trim(), `${variant} ${w.name} call 3`).toBe(realpathSync(f.linked));
      }
    }

    // G2: a resource-refused spawn whose metadata turns hostile before the retry is checked again and refused
    let spawns = 0;
    setSpawnForTests(((..._args: unknown[]) => {
      spawns++;
      const child = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter; kill: () => boolean; pid?: number };
      Object.assign(child, { stdout: new EventEmitter(), stderr: new EventEmitter(), kill: () => true });
      setImmediate(() => {
        writeFileSync(commondir, `${f.hostileCommon}\n`); // the seat rewrites its gitdir between attempts
        child.emit("error", Object.assign(new Error("spawn EAGAIN"), { code: "EAGAIN" }));
      });
      return child;
    }) as unknown as Parameters<typeof setSpawnForTests>[0]);
    await expect(shell("git status", f.linked, 60_000, false, { env: { ...process.env } })).rejects.toMatchObject({ name: "GitTrustRefusal", path: commondir });
    expect(spawns).toBe(1);
    // restored metadata runs again: the refusal was not cached either
    resetSpawnForTests();
    writeFileSync(commondir, original);
    expect((await shGitOk("git rev-parse --show-toplevel", f.linked)).trim()).toBe(realpathSync(f.linked));
  }, 240_000);

  test("production preserveWorktree enforces R2 with identical dirty payload creating a recoverable clean snapshot versus path-naming hostile refusal and unchanged real and hostile ref maps", async () => {
    const f = fixture();
    writeFileSync(join(f.linked, "a.txt"), "tracked dirty\n");
    writeFileSync(join(f.linked, "untracked.txt"), "untracked payload\n");
    const commondir = join(f.gitdir, "commondir");
    const original = readFileSync(commondir, "utf8");
    const before = [refMap(f.repo), refMap(f.hostile)];

    const hostile: Array<[string, () => void, () => void]> = [
      ["redirected", () => writeFileSync(commondir, `${f.hostileCommon}\n`), () => writeFileSync(commondir, original)],
      ["deleted", () => plantStandalone(f.gitdir), () => unplantStandalone(f.gitdir, original)],
      ...Object.entries(GIT_PATH_BYPASSES).map(([why, plant]): [string, () => void, () => void] => {
        let restore = () => {};
        return [why, () => { restore = plant(f, original); }, () => restore()];
      }),
    ];
    for (const [why, make, restore] of hostile) {
      make();
      const refusal = await preserveWorktree(f.linked).then(() => undefined, (e: unknown) => e);
      expect(refusal, why).toBeInstanceOf(GitTrustRefusal);
      expect((refusal as GitTrustRefusal).path, why).toBe(commondir);
      expect([refMap(f.repo), refMap(f.hostile)], why).toEqual(before);
      expect(git(f.repo, "for-each-ref", "refs/tickmarkr/preserved"), why).toBe("");
      // nothing was recorded in the seat-writable gitdir either
      expect(existsSync(join(f.gitdir, "refs", "tickmarkr")), why).toBe(false);
      restore();
    }

    // the identical payload under clean metadata: a nonempty recovery ref whose tree restores the exact bytes
    writeFileSync(commondir, original);
    const ref = await preserveWorktree(f.linked);
    expect(ref).toMatch(/^refs\/tickmarkr\/preserved\/[0-9a-f]{40}$/);
    expect(git(f.repo, "show", `${ref}:a.txt`)).toBe("tracked dirty");
    expect(git(f.repo, "show", `${ref}:untracked.txt`)).toBe("untracked payload");
    expect(git(f.repo, "show", `${ref}:sub/b.txt`)).toBe("two");
    expect(refMap(f.hostile)).toBe(before[1]);
    // the checkout itself is untouched by preservation
    expect(readFileSync(join(f.linked, "untracked.txt"), "utf8")).toBe("untracked payload\n");
  }, 120_000);

  test("production shell wrappers enforce E1 with actual fsmonitor false and inert hooks despite inherited config versus raw controls writing hook and fsmonitor process witnesses", async () => {
    const f = fixture();
    const bin = makeTestTempDir("git-trust-bin-");
    const hooks = join(bin, "hooks");
    mkdirSync(hooks);
    const fsWitness = join(bin, "fsmonitor.witness");
    const hookWitness = join(bin, "hook.witness");
    const fsmonitor = witnessScript(bin, "fsmonitor", fsWitness, 1);
    witnessScript(hooks, "pre-commit", hookWitness);
    witnessScript(join(f.common, "hooks"), "post-commit", hookWitness);
    // stationary trusted metadata plus repo config and inherited GIT_CONFIG_COUNT / GIT_CONFIG_PARAMETERS that conflict
    git(f.repo, "config", "core.fsmonitor", fsmonitor);
    const inherited = {
      GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "core.hooksPath", GIT_CONFIG_VALUE_0: hooks,
      GIT_CONFIG_PARAMETERS: `'core.fsmonitor=${fsmonitor}'`, TKR_T4_CAPABILITY: "kept",
    };
    const commit = ["-c", "user.name=t", "-c", "user.email=t@t.invalid", "commit", "-q", "--no-gpg-sign", "--allow-empty", "-m"];

    // raw controls: the same status and hook-triggering commit write nonempty process witnesses
    for (const cwd of [f.repo, f.linked]) {
      execFileSync("git", ["status", "--porcelain"], { cwd, env: rawEnv(inherited) });
      execFileSync("git", [...commit, "raw"], { cwd, env: rawEnv(inherited) });
    }
    expect(read(fsWitness)).toContain("fsmonitor");
    expect(read(hookWitness)).toContain("pre-commit");
    rmSync(fsWitness); rmSync(hookWitness);

    const parentBefore = { ...process.env };
    for (const cwd of [f.repo, f.linked]) {
      for (const w of WRAPPERS) {
        const explicit = w.name === "shell explicit env";
        const run = explicit
          ? (c: string) => ok(shell(c, cwd, 60_000, false, { env: rawEnv(inherited) }))
          : (c: string) => w.run(c, cwd);
        if (!explicit) Object.assign(process.env, inherited);
        try {
          const headBefore = git(cwd, "rev-parse", "HEAD");
          expect((await run("git config core.fsmonitor")).trim(), w.name).toBe("false");
          expect((await run("git config core.hooksPath")).trim(), w.name).toBe(INERT_HOOKS_PATH);
          await run(`git status --porcelain && git ${commit.map((a) => `'${a}'`).join(" ")} protected`);
          // the protected commit still lands its expected object and ref; no witness byte is added
          expect(git(cwd, "rev-parse", "HEAD^"), w.name).toBe(headBefore);
          expect(git(cwd, "log", "-1", "--format=%s"), w.name).toBe("protected");
          expect(git(cwd, "-c", "core.fsmonitor=false", "status", "--porcelain"), w.name).toBe("");
          if (explicit) expect((await run("printf %s \"$TKR_T4_CAPABILITY\"")), w.name).toBe("kept");
        } finally {
          for (const k of Object.keys(inherited)) delete process.env[k];
          Object.assign(process.env, parentBefore);
        }
        expect(read(fsWitness), `${w.name} fsmonitor`).toBe("");
        expect(read(hookWitness), `${w.name} hook`).toBe("");
      }
    }
    // the parent environment survives the protected children
    expect(process.env.GIT_CONFIG_PARAMETERS).toBe(parentBefore.GIT_CONFIG_PARAMETERS);
  }, 240_000);
});

describe("v2.6.7 T4 closed raw-consumer table", () => {
  test("production seat-run raw Git consumers satisfy the closed raw-consumer table including G2 versus hostile metadata accepted as clean evidence", async () => {
    const f = fixture();
    const base = git(f.repo, "rev-parse", "HEAD");
    // a text and a binary commit on the task branch (from inside the seat-run linked checkout)
    writeFileSync(join(f.linked, "a.txt"), "one\ntask text\n");
    writeFileSync(join(f.linked, "blob.bin"), Buffer.from([0, 1, 2, 255, 0, 7, 9]));
    git(f.linked, "add", "-A");
    git(f.linked, "-c", "user.name=t", "-c", "user.email=t@t.invalid", "commit", "-q", "--no-gpg-sign", "-m", "task text and binary");
    writeFileSync(join(f.linked, "c.txt"), "three\n");
    git(f.linked, "add", "-A");
    git(f.linked, "-c", "user.name=t", "-c", "user.email=t@t.invalid", "commit", "-q", "--no-gpg-sign", "-m", "task second");
    const head = git(f.linked, "rev-parse", "HEAD");
    // the task's own recorded integration merge: first parent the integration tip, second the waived series
    git(f.repo, "-c", "user.name=t", "-c", "user.email=t@t.invalid", "commit", "-q", "--no-gpg-sign", "--allow-empty", "-m", "integration");
    const mergeBase = git(f.repo, "rev-parse", "HEAD");
    git(f.repo, "-c", "user.name=t", "-c", "user.email=t@t.invalid", "merge", "-q", "--no-ff", "--no-gpg-sign", "-m", "merge task", head);
    const merged = git(f.repo, "rev-parse", "HEAD");

    // the pre-change implementation, byte for byte (plain execFileSync git, no trust check, no driver flags)
    const pre = (cwd: string, args: string[], input?: string) => execFileSync("git", args, { cwd, encoding: "utf8", env: rawEnv(), ...(input === undefined ? {} : { input }) });
    const prePatch = (cwd: string, diff: string) => pre(cwd, ["patch-id", "--verbatim"], diff).trim().split(/\s+/)[0] || undefined;
    const preSubject = (cwd: string) => createHash("sha256").update(pre(cwd, ["log", "--reverse", "--format=%T%x00%an%x00%ae%x00%cn%x00%ce%x00%B%x1e", `${base}..${head}`])).digest("hex");
    const preRange = (cwd: string) => prePatch(cwd, pre(cwd, ["diff", "--binary", base, head])) ?? "empty";
    const preSeries = (cwd: string) => pre(cwd, ["rev-list", "--reverse", `${base}..${head}`]).trim().split("\n")
      .map((c) => prePatch(cwd, pre(cwd, ["show", "--format=", "--binary", c]))).filter(Boolean);

    const events: JournalEvent[] = [
      { ts: "2026-10-03T00:00:00.000Z", event: "task-dispatch", taskId: "T1", data: { assignment: { adapter: "codex", model: "m" } } },
      { ts: "2026-10-03T00:00:01.000Z", event: "gate-result", taskId: "T1", data: { gate: "acceptance", pass: false, commit: owedSubject(f.repo, base, head) } },
    ];
    const obligation = captureOwedCheck({
      cwd: f.repo, runId: "run-t4", taskId: "T1", gate: "acceptance", cause: "D-T4", acceptance: ["a"], files: ["a.txt"],
      declared: [{ key: "codex:m", vendor: "openai" }], taskRef: head, integrationRef: base, events,
    });
    expect(obligation.known).toBe(true);
    const artifactPath = join(f.scratch, "verify.json");
    writeFileSync(artifactPath, JSON.stringify({ head: merged, mergeBase, green: true, criteria: obligation.criteria, files: obligation.files, gateRows: [{ gate: "acceptance", pass: true }] }));
    const folded: JournalEvent[] = [...events,
      { ts: "2026-10-03T00:00:02.000Z", event: "task-approved", taskId: "T1", data: { release: GATE_SATISFIED_RELEASE, gate: "acceptance", obligation } },
      { ts: "2026-10-03T00:00:03.000Z", event: "merge", taskId: "T1", data: { commit: merged } },
      { ts: "2026-10-03T00:00:03.500Z", event: "task-done", taskId: "T1", data: {} },
      { ts: "2026-10-03T00:00:04.000Z", event: OWED_DISCHARGE_EVENT, taskId: "T1", data: {
        ids: [obligation.id], mapping: "integration", mergeBase, head: merged, criteria: obligation.criteria,
        artifactPath, artifactSha256: createHash("sha256").update(readFileSync(artifactPath)).digest("hex"),
      } },
    ];
    const identity = (cwd: string) => ({
      subject: owedSubject(cwd, base, head), patch: rangePatch(cwd, base, head), patches: rangePatches(cwd, base, head),
      authors: owedAuthors(events, "T1", cwd, base, head), fold: JSON.stringify(foldOwedChecks(folded, cwd)),
    });

    // clean: ordinary and seat-run linked cwd values equal the pre-change implementation; the fold is known zero debt
    const clean = identity(f.repo);
    expect(clean).toMatchObject({ subject: preSubject(f.repo), patch: preRange(f.repo), patches: preSeries(f.repo), authors: ["codex:m"] });
    expect(clean.patches).toHaveLength(2);
    expect(JSON.parse(clean.fold)).toMatchObject({ known: true, debt: 0, discharged: [obligation.id] });
    expect(identity(f.linked)).toEqual(clean);
    expect(identity(f.linked).patch).toBe(preRange(f.linked));
    // a store-scoped proof memo populated through a clean fold: a memo hit runs no git, so trust is re-derived first
    const memo: OwedProofMemo = new Set();
    expect(JSON.stringify(foldOwedChecks(folded, f.linked, memo))).toBe(clean.fold);
    expect(memo.size).toBe(1);

    // hostile: an enabled config.worktree carrying an external diff driver; the raw control runs it
    const witness = join(f.scratch, "ext-diff.witness");
    const extDiff = witnessScript(f.scratch, "ext-diff", witness);
    const worktreeConfig = join(f.gitdir, "config.worktree");
    const commondir = join(f.gitdir, "commondir");
    const original = readFileSync(commondir, "utf8");
    git(f.repo, "config", "extensions.worktreeConfig", "true");
    writeFileSync(worktreeConfig, `[diff]\n\texternal = ${extDiff}\n`);
    pre(f.linked, ["diff", base, head]);
    expect(read(witness)).toContain("ext-diff");
    rmSync(witness);
    const before = [refMap(f.repo), refMap(f.hostile)];

    // G2 per helper: call 1 clean, call 2 hostile (every variant), call 3 restored — in the SAME worktree
    const helpers: Array<[string, () => unknown]> = [
      ["owedSubject", () => owedSubject(f.linked, base, head)],
      ["rangePatch", () => rangePatch(f.linked, base, head)],
      ["rangePatches", () => rangePatches(f.linked, base, head)],
    ];
    const variants = {
      "config.worktree": { path: worktreeConfig, hostile: () => writeFileSync(worktreeConfig, `[diff]\n\texternal = ${extDiff}\n`), restore: () => rmSync(worktreeConfig, { force: true }) },
      commondir: { path: commondir, hostile: () => writeFileSync(commondir, `${f.hostileCommon}\n`), restore: () => writeFileSync(commondir, original) },
      "deleted commondir": { path: commondir, hostile: () => plantStandalone(f.gitdir), restore: () => unplantStandalone(f.gitdir, original) },
    };
    for (const [variant, { path, hostile, restore }] of Object.entries(variants)) {
      restore();
      expect(JSON.stringify(foldOwedChecks(folded, f.linked, memo)), `${variant} memo call 1`).toBe(clean.fold);
      for (const [name, call] of helpers) {
        const first = call();
        hostile();
        expect(call, `${variant} ${name}`).toThrow(GitTrustRefusal);
        try { call(); } catch (e) { expect((e as GitTrustRefusal).path, `${variant} ${name}`).toBe(path); }
        restore();
        expect(call(), `${variant} ${name} restored`).toEqual(first);
      }
      // owed authors and the fold never accept hostile metadata as clean evidence: unknown, never known zero debt
      hostile();
      expect(owedAuthors(events, "T1", f.linked, base, head)[0]).toMatch(/^unknown author \(GitTrustRefusal: git trust refusal: /);
      for (const fold of [foldOwedChecks(folded, f.linked, memo), foldOwedChecks(folded, f.linked)]) {
        expect(fold, variant).toMatchObject({ known: false, debt: "unknown" });
        expect(fold.discharged, variant).toEqual([]);
        expect(fold.unknown[0]!.reason, variant).toContain(path);
      }
      expect(memo.size, `${variant} the immutable proof stays cached`).toBe(1);
      restore();
      expect(JSON.stringify(foldOwedChecks(folded, f.linked)), variant).toBe(clean.fold);
      expect(JSON.stringify(foldOwedChecks(folded, f.linked, memo)), `${variant} memo call 3`).toBe(clean.fold);
    }
    expect(read(witness)).toBe("");
    expect([refMap(f.repo), refMap(f.hostile)]).toEqual(before);

    // probeCodexCommit: a fake seat rewrites its REAL fixture metadata before returning OR throwing
    const probeRepo = makeRepo({ "keep.txt": "x\n" });
    const probeWitness = join(f.scratch, "probe-fsmonitor.witness");
    const probeFsmonitor = witnessScript(f.scratch, "probe-fsmonitor", probeWitness, 1);
    const commitAsProbe = (p: CodexCommitProbe) => {
      writeFileSync(p.control, p.token);
      execFileSync("git", ["add", "--", p.control], { cwd: p.worktree, env: rawEnv() });
      execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t.invalid", "commit", "-q", "--no-gpg-sign", "-m", `tickmarkr-probe ${p.token}`], { cwd: p.worktree, env: rawEnv() });
    };
    const receipts = "control=ok\ncommit=ok\nhook=denied\nroot=denied\n";
    const probeBefore = [refMap(probeRepo), refMap(f.hostile)];
    // the clean probe verdict is unchanged: allowed, and its own ref goes
    expect((await probeCodexCommit(probeRepo, async (p) => { commitAsProbe(p); return receipts; })).status).toBe("allowed");
    expect([refMap(probeRepo), refMap(f.hostile)]).toEqual(probeBefore);
    git(probeRepo, "config", "extensions.worktreeConfig", "true");
    let offending = "";
    const plant = (p: CodexCommitProbe, file: string, bytes: string) => {
      offending = join(realpathSync(dirname(p.lock)), file);
      writeFileSync(offending, bytes);
    };
    const seats: Array<[string, (p: CodexCommitProbe) => Promise<string>]> = [
      ["commondir then return", async (p) => { commitAsProbe(p); plant(p, "commondir", `${f.hostileCommon}\n`); return receipts; }],
      ["config.worktree then throw", async (p) => { commitAsProbe(p); plant(p, "config.worktree", `[core]\n\tfsmonitor = ${probeFsmonitor}\n`); throw new Error("Command failed: exit 3"); }],
      ["config.worktree then return", async (p) => { commitAsProbe(p); plant(p, "config.worktree", `[core]\n\tfsmonitor = ${probeFsmonitor}\n`); return receipts; }],
    ];
    for (const [name, seat] of seats) {
      const result = await probeCodexCommit(probeRepo, seat);
      expect(result.status, name).toBe("unknown");
      expect(result.detail, name).toContain(offending);
      expect(result.detail, name).toContain("git trust refusal");
      expect(read(probeWitness), name).toBe("");
      expect([refMap(probeRepo), refMap(f.hostile)], name).toEqual(probeBefore);
    }
  }, 300_000);
});
