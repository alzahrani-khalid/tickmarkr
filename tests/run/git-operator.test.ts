import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { FakeAdapter } from "../../src/adapters/fake.js";
import { probeCodexCommit } from "../../src/adapters/codex-commit-check.js";
import { writeDoctor } from "../../src/adapters/registry.js";
import { approve } from "../../src/cli/commands/approve.js";
import { compile } from "../../src/cli/commands/compile.js";
import { init } from "../../src/cli/commands/init.js";
import { plan } from "../../src/cli/commands/plan.js";
import { compileGsd } from "../../src/compile/gsd.js";
import { compileNative } from "../../src/compile/native.js";
import { graphDefinitionHash, loadGraph, saveGraph } from "../../src/graph/graph.js";
import { validateGraph } from "../../src/graph/schema.js";
import { gitSync, WORKTREES_DIR } from "../../src/run/git.js";
import { GitTrustRefusal } from "../../src/run/git-trust.js";
import { Journal } from "../../src/run/journal.js";
import { authedModels, makeRepo, makeTestTempDir, T } from "../helpers/tmprepo.js";

// Queue row 2 item b (D-1042, D-2112, D-2114): real operator calls, real repositories and live plants.
const realGit = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
const rawEnv = (): NodeJS.ProcessEnv => {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (/^GIT_(?:CONFIG_(?:PARAMETERS|COUNT|KEY_\d+|VALUE_\d+)|DIR|COMMON_DIR|WORK_TREE|REFERENCE_BACKEND|REF_STORAGE_FORMAT|INDEX_FILE|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES)$/.test(key)) delete env[key];
  return env;
};
const raw = (cwd: string, ...args: string[]): string => execFileSync(realGit, args, {
  cwd, env: rawEnv(), encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
}).trim();
const put = (file: string, text: string) => { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, text); };
const read = (file: string) => existsSync(file) ? readFileSync(file, "utf8") : "";
const quote = (text: string) => `'${text.replace(/'/g, `'\\''`)}'`;
const runId = "run-operator";
const integration = `tickmarkr/${runId}`;
const taskRef = `${integration}--T1`;
const preservedRef = "refs/heads/operator-preserved";
const skill = ".agents/skills/tickmarkr-loop/SKILL.md";
const nativeSpec = "specs/operator.spec.md";
const phase = join(".planning", "phases", "01-operator");
const nativeText = (context = "owned.txt") => `<!-- tickmarkr:spec -->\n# Operator fixture\n## T1: Inspect the operator boundary\n- goal: Exercise protected operator git\n- shape: chore\n- files: owned-link, tests/probe.test.ts\n- context: ${context}\n- acceptance:\n  - command: printf 'visible' # \`visible\`\n`;
const fakeConfig = `tiers:\n  fake:\n    vendor: fake-a\n    channel: sub\n    models:\n      fake-1: frontier\n    windows:\n      fake-1: 128000\nrouting:\n  map:\n    chore: { pin: { via: fake, model: fake-1 } }\njudge: { adapter: fake, model: fake-1 }\nconsult: { adapter: fake, model: fake-1 }\ndriver: subprocess\n`;

type Site = "init" | "remove" | "recheck" | "preserved" | "missing" | "stale-preserved" | "scope" | "native" | "gsd" | "plan" | "doctor";
const sites: Site[] = ["init", "remove", "recheck", "preserved", "missing", "stale-preserved", "scope", "native", "gsd", "plan", "doctor"];
interface Fixture { main: string; repo: string; common: string; gitdir: string; base: string; tip: string; fake: FakeAdapter; removed?: string }
function fixture(site: Site, linked = false): Fixture {
  const main = realpathSync(makeRepo({
    "owned.txt": "this tree's committed context\n", "target.txt": "target\n", "needed.txt": "sibling\n",
    [skill]: "stale tracked skill\n", [nativeSpec]: nativeText(),
    "tests/probe.test.ts": "test('visible', () => expect('visible').toBe('visible'));\n",
    [`${phase}/01-01-PLAN.md`]: "---\nphase: 01-operator\nplan: '01'\nfiles_modified: [target.txt]\n---\n<objective>Exercise operator git.</objective>\n<context>\n@owned.txt\n</context>\n<tasks>\n<task type=\"auto\"><name>Inspect</name><done>operator is protected</done></task>\n</tasks>\n",
  }));
  symlinkSync("target.txt", join(main, "owned-link"));
  raw(main, "add", "owned-link");
  raw(main, "commit", "-q", "--no-gpg-sign", "-m", "link");
  const base = raw(main, "rev-parse", "HEAD");
  if (site === "scope") {
    raw(main, "checkout", "-q", "-b", "sibling-work");
    put(join(main, "needed.txt"), "merged sibling\n");
    raw(main, "add", "needed.txt");
    raw(main, "commit", "-q", "--no-gpg-sign", "-m", "sibling");
    raw(main, "checkout", "-q", "main");
    raw(main, "merge", "-q", "--no-ff", "--no-gpg-sign", "-m", "merge sibling", "sibling-work");
  } else raw(main, "commit", "-q", "--allow-empty", "--no-gpg-sign", "-m", "landed work");
  const tip = raw(main, "rev-parse", "HEAD");
  raw(main, "branch", integration, base);
  if (site !== "missing") raw(main, "branch", taskRef, tip);
  raw(main, "branch", "operator-preserved", site === "stale-preserved" ? base : tip);
  let repo = main;
  if (linked) {
    repo = join(realpathSync(makeTestTempDir("operator-linked-")), "checkout");
    raw(main, "worktree", "add", "-q", "-b", "linked-operator", repo, tip);
  }
  const common = realpathSync(join(main, ".git"));
  const gitdir = realpathSync(raw(repo, "rev-parse", "--absolute-git-dir"));
  saveGraph(repo, validateGraph({ version: 1, spec: { source: "native", paths: [nativeSpec], hash: "operator" }, tasks: [
    T("T1", { shape: "chore", files: ["owned.txt"], context: [site === "plan" ? "absent-context.txt" : "owned.txt"], acceptance: [{ oracle: "command", command: "true" }] }),
    T("T2", { shape: "chore", files: ["needed.txt"], acceptance: [{ oracle: "command", command: "true" }] }),
  ] }));
  put(join(repo, ".tickmarkr/config.yaml"), fakeConfig);
  put(join(repo, ".tickmarkr/fake.json"), JSON.stringify({ tasks: {} }));
  const fake = new FakeAdapter(join(repo, ".tickmarkr/fake.json"));
  writeDoctor(repo, { fake: { installed: true, authed: true, models: ["fake-1", "fake-2"], modelAuth: authedModels(["fake-1", "fake-2"]) } });
  if (["recheck", "preserved", "missing", "stale-preserved", "scope"].includes(site)) {
    const journal = Journal.create(repo, runId);
    journal.append("run-start", undefined, { graphDefinitionHash: graphDefinitionHash(loadGraph(repo)) });
    if (site === "scope") {
      journal.append("task-done", "T2", {});
      journal.append("merge", "T2", { commit: tip, from: base });
      journal.append("task-human", "T1", { kind: "scope-request", paths: ["needed.txt"], graphDefinitionHash: graphDefinitionHash(loadGraph(repo)) });
    } else {
      if (site !== "recheck") journal.append("worktree-preserved", "T1", { ref: preservedRef });
      journal.append("task-failed", "T1", { reason: "gate failed" });
    }
  }
  let removed: string | undefined;
  if (site === "remove" && !linked) {
    removed = join(repo, ".tickmarkr", WORKTREES_DIR, "removable");
    raw(main, "worktree", "add", "-q", "-b", "removable", removed, tip);
  }
  return { main, repo, common, gitdir, base, tip, fake, removed };
}
async function invoke(site: Site, f: Fixture): Promise<unknown> {
  switch (site) {
    case "init": return init(["--global-dir", makeTestTempDir("operator-global-"), "--agent", "--docs", "--yes"], f.repo);
    case "remove": return init(["--remove"], f.repo);
    case "scope": return approve([runId, "T1", "--files", "needed.txt", "--by", "operator"], f.repo);
    case "recheck": case "preserved": case "missing": case "stale-preserved": return approve([runId, "T1", "--recheck", "--by", "operator"], f.repo);
    case "native": return compileNative(join(f.repo, nativeSpec));
    case "gsd": return compileGsd(join(f.repo, phase), f.repo);
    case "plan": return plan([], f.repo, [f.fake]);
    case "doctor": return probeCodexCommit(f.repo, async (p) => {
      writeFileSync(p.control, p.token);
      return "control=ok\ncommit=fail\nhook=denied\nroot=denied\n";
    });
  }
}
function assertOutcome(site: Site, result: unknown, linked = false): void {
  if (site === "doctor") expect(result).toMatchObject({ status: "protected" });
  else if (site === "native" || site === "gsd") expect(result).toMatchObject({ version: 1, tasks: expect.any(Array) });
  else if (site === "plan") expect(result).toContain("absent-context.txt");
  else if (site === "init") expect(result).toContain("skipped existing tracked");
  else if (site === "remove" && !linked) expect(result).toContain("deleted state directory");
  else if (site === "scope") expect(result).toContain("approved files[]");
  else expect(result).toContain("re-checking failed T1");
}

type Plant = "fsmonitor" | "worktree-config" | "includeIf" | "hook";
const plants: Plant[] = ["fsmonitor", "worktree-config", "includeIf", "hook"];
function plant(f: Fixture, kind: Plant): { marker: string; refused?: string } {
  const dir = makeTestTempDir("operator-plant-");
  const marker = join(dir, "fired");
  const program = join(dir, "monitor");
  writeFileSync(program, `#!/bin/sh\nprintf fired > ${quote(marker)}\nprintf 'token\\0'\n`, { mode: 0o755 });
  if (kind === "fsmonitor") raw(f.main, "config", "core.fsmonitor", program);
  if (kind === "worktree-config") {
    raw(f.main, "config", "extensions.worktreeConfig", "true");
    put(join(f.gitdir, "config.worktree"), `[core]\n\tfsmonitor = ${program}\n`);
  }
  if (kind === "includeIf") {
    const included = join(dir, "included.config");
    put(included, `[core]\n\tfsmonitor = ${program}\n`);
    raw(f.main, "config", `includeIf.gitdir:${f.common}.path`, included);
  }
  if (kind === "hook") writeFileSync(join(f.common, "hooks/post-checkout"), `#!/bin/sh\nprintf fired > ${quote(marker)}\n`, { mode: 0o755 });
  return { marker, ...(kind === "worktree-config" ? { refused: join(f.gitdir, "config.worktree") } : {}) };
}

interface Call { args: string[]; cwd: string; parameters?: string; gitdir?: string; common?: string; worktree?: string; backend?: string; format?: string; locale?: string; view?: { headLock: boolean; refs: string; worktrees: string } }
// Queue row 2 item b: PATH records the child boundary; the trust module's own config reads and probe remain unchanged.
function recorder({ honour = false, race }: { honour?: boolean; race?: string } = {}) {
  const dir = makeTestTempDir("operator-git-");
  const log = join(dir, "calls.jsonl");
  writeFileSync(join(dir, "git"), `#!${process.execPath}\nconst fs = require('fs'), cp = require('child_process');
const args = process.argv.slice(2), env = {...process.env};
const backend = env.GIT_REFERENCE_BACKEND;
let view;
if (backend && backend.startsWith('files://') && fs.existsSync(backend.slice(8) + '/HEAD.lock')) {
  const root = backend.slice(8);
  view = {headLock: fs.existsSync(root + '/HEAD.lock'), refs: fs.readlinkSync(root + '/refs'), worktrees: fs.readlinkSync(root + '/worktrees')};
}
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({args, cwd:fs.realpathSync('.'), parameters:env.GIT_CONFIG_PARAMETERS, gitdir:env.GIT_DIR, common:env.GIT_COMMON_DIR, worktree:env.GIT_WORK_TREE, backend, format:env.GIT_REF_STORAGE_FORMAT, locale:env.LC_ALL, view}) + '\\n');
if (${honour} && args[0] === 'symbolic-ref' && args[1] === 'refs/tickmarkr/ref-pin-probe') {process.stdout.write('refs/tickmarkr/ref-pin-honoured\\n'); process.exit(0);}
const result = cp.spawnSync(${JSON.stringify(realGit)}, args, {env, encoding:'utf8'});
if (${JSON.stringify(race ?? "")} && args[0] === 'rev-parse' && args[1] === '--show-toplevel') {
  const path = ${JSON.stringify(race ?? "")}; const bytes = fs.readFileSync(path); fs.unlinkSync(path); fs.writeFileSync(path, bytes);
}
if (result.stdout) process.stdout.write(result.stdout);
if (result.stderr) process.stderr.write(result.stderr);
process.exit(result.status === null ? 1 : result.status);
`, { mode: 0o755 });
  return { dir, calls: (): Call[] => read(log).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)) };
}
async function recording<T>(r: ReturnType<typeof recorder>, body: () => Promise<T>): Promise<T> {
  const path = process.env.PATH;
  process.env.PATH = `${r.dir}:${path}`;
  try { return await body(); } finally { process.env.PATH = path; }
}
const operatorCalls = (calls: Call[]) => calls.filter((c) => !(c.args[0] === "config" && c.args[1] === "--file") && !(c.args[0] === "symbolic-ref" && c.args[1] === "refs/tickmarkr/ref-pin-probe"));
function forced(calls: Call[], label: string): void {
  expect(calls.length, label).toBeGreaterThan(0);
  for (const c of calls) {
    const parameters = c.parameters ?? "";
    expect(parameters, `${label}: ${c.args.join(" ")}`).toMatch(/'core\.fsmonitor=false' 'core\.hooksPath=\/dev\/null'(?: 'gc\.auto=0' 'maintenance\.auto=false')?$/);
    expect(parameters.lastIndexOf("core.hooksPath=/dev/null"), label).toBeGreaterThan(parameters.indexOf("core.hooksPath=/hostile"));
  }
}
const hasCall = (calls: Call[], args: string[]) => calls.some((c) => JSON.stringify(c.args) === JSON.stringify(args));

beforeEach(() => {
  for (const key of Object.keys(process.env)) if (/^GIT_/.test(key)) vi.stubEnv(key, undefined);
  vi.stubEnv("XDG_CONFIG_HOME", makeTestTempDir("operator-xdg-"));
  vi.stubEnv("GIT_CONFIG_NOSYSTEM", "1");
  vi.stubEnv("GIT_CONFIG_GLOBAL", "/dev/null");
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

test("with each plant in place, a local fsmonitor setting, a linked worktree's per-worktree config under the worktree-config extension, a conditionally included config and a post-checkout hook, init, init remove, approve, native and GSD compile, plan and doctor's probe leave the plant's marker unwritten while raw git in the same fixture writes it, so raw operator git fails", async () => {
  for (const kind of plants) {
    for (const site of sites) {
      const label = `${kind} / ${site}`;
      const f = fixture(site, kind === "worktree-config");
      const { marker, refused } = plant(f, kind);
      expect(existsSync(marker), label).toBe(false);
      if (refused) {
        if (site === "doctor") expect(await invoke(site, f), label).toMatchObject({ status: "unknown", detail: expect.stringContaining(refused) });
        else await expect(invoke(site, f), label).rejects.toThrow(refused);
      } else assertOutcome(site, await invoke(site, f));
      expect(existsSync(marker), label).toBe(false);
      if (kind === "hook") raw(f.repo, "checkout", "-q", "-b", "raw-control");
      else raw(f.repo, "status", "--porcelain");
      expect(read(marker), `raw positive control: ${label}`).toBe("fired");
    }
  }
}, 240_000);

test("a recording git sees every listed operator site reached, including approve's merged-sibling and preserved-ref present or missing paths and native compile's test-index grep and symlink blob read, each git carrying the fsmonitor and hooks settings forced last, even under an inherited hostile hooks parameter, or refused before spawning, so an unreached or unprotected site fails", async () => {
  vi.stubEnv("GIT_CONFIG_PARAMETERS", "'core.hooksPath=/hostile' 'core.fsmonitor=/hostile-monitor'");
  vi.stubEnv("GIT_CONFIG_COUNT", "1");
  vi.stubEnv("GIT_CONFIG_KEY_0", "core.hooksPath");
  vi.stubEnv("GIT_CONFIG_VALUE_0", "/hostile-count");
  for (const site of sites) {
    const f = fixture(site);
    const r = recorder();
    const result = await recording(r, async () => {
      if (site !== "doctor") return invoke(site, f);
      return probeCodexCommit(f.repo, async (p) => {
        writeFileSync(p.control, p.token);
        expect(gitSync(p.worktree, ["add", "--", p.control]).status).toBe(0);
        expect(gitSync(p.worktree, ["-c", "user.name=operator", "-c", "user.email=operator@test.invalid", "commit", "-q", "--no-gpg-sign", "-m", `tickmarkr-probe ${p.token}`]).status).toBe(0);
        return "control=ok\ncommit=ok\nhook=denied\nroot=denied\n";
      });
    });
    if (site === "doctor") expect(result).toMatchObject({ status: "allowed" });
    else assertOutcome(site, result);
    const calls = operatorCalls(r.calls());
    forced(calls, site);
    const saw = (...args: string[]) => expect(hasCall(calls, args), `${site}: ${args.join(" ")}`).toBe(true);
    if (site === "init") saw("ls-files", "--error-unmatch", "--", skill);
    if (site === "remove") {
      saw("rev-parse", "--git-dir"); saw("rev-parse", "--git-common-dir"); saw("rev-parse", "--is-inside-work-tree");
      saw("worktree", "list", "--porcelain"); saw("worktree", "remove", "--force", "--force", f.removed!); saw("worktree", "prune");
      for (const call of calls) {
        expect(call.gitdir).toBeUndefined(); expect(call.common).toBeUndefined(); expect(call.worktree).toBeUndefined(); expect(call.locale).toBe("C");
      }
    }
    if (["recheck", "preserved", "missing", "stale-preserved"].includes(site)) {
      saw("rev-list", "--count", `${integration}..${site === "preserved" || site === "missing" ? preservedRef : taskRef}`);
      if (site !== "recheck") saw("rev-parse", "--verify", taskRef);
      if (site === "preserved" || site === "stale-preserved") saw("merge-base", "--is-ancestor", taskRef, preservedRef);
      if (site === "missing" || site === "stale-preserved") expect(calls.filter((c) => JSON.stringify(c.args) === JSON.stringify(["rev-parse", "--verify", taskRef]))).toHaveLength(2);
    }
    if (site === "scope") { saw("rev-parse", "--verify", taskRef); saw("merge-base", "--is-ancestor", f.tip, taskRef); }
    if (site === "native") {
      saw("rev-parse", "--show-toplevel"); saw("ls-tree", "--full-tree", "-r", "--name-only", "-z", "HEAD");
      saw("ls-tree", "--full-tree", "-r", "-z", "--end-of-options", "HEAD");
      saw("cat-file", "blob", raw(f.repo, "rev-parse", "HEAD:owned-link"));
      saw("grep", "-I", "-n", "-e", "", "HEAD", "--", "tests/*.test.ts", "tests/**/*.test.ts");
      saw("ls-files", "-z", "--cached", "--others", "--exclude-standard");
      expect(calls.filter((c) => c.args[0] === "cat-file")[0].cwd).toBe(join(f.repo, "specs"));
    }
    if (site === "gsd") { saw("rev-parse", "--show-toplevel"); saw("ls-tree", "--full-tree", "-r", "--name-only", "-z", "HEAD"); }
    if (site === "plan") { saw("rev-parse", "--show-toplevel"); saw("ls-tree", "--full-tree", "-r", "-l", "-z", "HEAD"); saw("check-ignore", "-q", "--", "absent-context.txt"); }
    if (site === "doctor") {
      saw("rev-parse", "--path-format=absolute", "--git-common-dir"); saw("rev-parse", "--verify", "HEAD^{commit}");
      const add = calls.find((c) => c.args[0] === "worktree" && c.args[1] === "add")!;
      expect(add).toBeDefined();
      const branch = add.args[3], checkout = add.args[4];
      saw("rev-parse", "--absolute-git-dir"); saw("rev-parse", "--verify", "--quiet", `refs/heads/${branch}^{commit}`);
      expect(calls.some((c) => c.args[0] === "log" && c.args[2] === "--format=%P %s")).toBe(true);
      expect(calls.some((c) => c.args[0] === "cat-file" && c.args[2].endsWith(":tickmarkr-codex-commit-control"))).toBe(true);
      saw("worktree", "remove", "--force", checkout);
      expect(calls.some((c) => c.args[0] === "update-ref" && c.args[1] === "-d" && c.args[2] === `refs/heads/${branch}`)).toBe(true);
      expect(raw(f.repo, "for-each-ref", "refs/heads/tickmarkr-probe-*")).toBe("");
    }
  }
  // Queue row 2 item b: remove keeps its discovery environment stripped even when the caller redirects git.
  const f = fixture("remove"), foreign = fixture("native"), r = recorder();
  vi.stubEnv("GIT_DIR", foreign.gitdir); vi.stubEnv("GIT_COMMON_DIR", foreign.common); vi.stubEnv("GIT_WORK_TREE", foreign.repo);
  await recording(r, () => invoke("remove", f));
  for (const c of operatorCalls(r.calls())) {
    expect(c.gitdir).toBeUndefined(); expect(c.common).toBeUndefined(); expect(c.worktree).toBeUndefined(); expect(c.locale).toBe("C");
  }
  expect(existsSync(join(foreign.repo, ".tickmarkr/config.yaml"))).toBe(true);
}, 240_000);

test("each command in a linked worktree whose commondir names a foreign repository fails naming that commondir, doctor's probe reporting unknown with it, and a compile run from another checkout refuses a hostile linked worktree's spec by its commondir yet reads an intact one's own tree, so swallowed refusals or checks of the caller's cwd fail", async () => {
  const foreign = fixture("native");
  for (const site of sites) {
    const f = fixture(site, true);
    const commondir = join(f.gitdir, "commondir");
    writeFileSync(commondir, `${foreign.common}\n`);
    const r = recorder();
    await recording(r, async () => {
      if (site === "doctor") expect(await invoke(site, f)).toMatchObject({ status: "unknown", detail: expect.stringContaining(commondir) });
      else await expect(invoke(site, f), site).rejects.toThrow(commondir);
    });
    expect(operatorCalls(r.calls()), `${site}: refused before child`).toEqual([]);
    expect(read(commondir)).toBe(`${foreign.common}\n`);
  }
  // Queue row 2 item b: compile's source checkout, not its caller, supplies git authority and committed context.
  const target = fixture("native", true);
  put(join(target.repo, "linked-only.txt"), "only the linked checkout's tree\n");
  put(join(target.repo, nativeSpec), nativeText("linked-only.txt"));
  raw(target.repo, "add", "linked-only.txt", nativeSpec);
  raw(target.repo, "commit", "-q", "--no-gpg-sign", "-m", "linked tree context");
  expect(raw(target.main, "ls-tree", "HEAD", "linked-only.txt")).toBe("");
  expect(compileNative(join(target.repo, nativeSpec)).tasks[0].context).toContain("linked-only.txt");
  expect(await compile([join(target.repo, nativeSpec), "--type", "native", "--dry-run"], foreign.repo)).toContain("1 tasks, source native");
  const commondir = join(target.gitdir, "commondir");
  writeFileSync(commondir, `${foreign.common}\n`);
  await expect(compile([join(target.repo, nativeSpec), "--type", "native", "--dry-run"], foreign.repo)).rejects.toThrow(commondir);
  expect(() => compileNative(join(target.repo, nativeSpec))).toThrow(commondir);
  expect(() => compileGsd(join(target.repo, phase))).toThrow(commondir);
}, 240_000);

test("the synchronous helper in a linked checkout runs git pinned to the target's trusted gitdir, common directory and worktree root, refuses a result whose commondir changed while its child ran and releases its ref view, while compile and plan in a healthy linked worktree still succeed, so a helper that only appends the forced pair fails", async () => {
  const f = fixture("native", true), foreign = fixture("native");
  const r = recorder({ honour: true });
  const nested = join(f.repo, "specs");
  const env = { ...process.env, GIT_DIR: foreign.gitdir, GIT_COMMON_DIR: foreign.common, GIT_WORK_TREE: foreign.repo,
    GIT_REFERENCE_BACKEND: "files:///hostile", GIT_REF_STORAGE_FORMAT: "reftable", GIT_CONFIG_PARAMETERS: "'core.hooksPath=/hostile'" };
  const result = await recording(r, async () => gitSync(nested, ["rev-parse", "--show-toplevel"], { env: { ...env, PATH: process.env.PATH } }));
  expect(result.status).toBe(0); expect(result.stdout.trim()).toBe(f.repo);
  const [child] = operatorCalls(r.calls());
  expect(child).toMatchObject({ cwd: nested, gitdir: f.gitdir, common: f.common, worktree: f.repo, view: {
    headLock: true, refs: join(f.common, "refs"), worktrees: join(f.common, "worktrees"),
  } });
  expect(child.format).toBeUndefined(); expect(child.backend).toMatch(/^files:\/\//);
  expect(existsSync(child.backend!.slice(8))).toBe(false);
  forced([child], "synchronous pin");
  const fail = recorder({ honour: true });
  const missing = await recording(fail, async () => gitSync(nested, ["rev-parse", "--verify", "refs/heads/absent"]));
  expect(missing.status).not.toBe(0);
  expect(existsSync(operatorCalls(fail.calls())[0].backend!.slice(8))).toBe(false);
  const commondir = join(f.gitdir, "commondir"), before = read(commondir);
  const raced = recorder({ honour: true, race: commondir });
  await recording(raced, async () => {
    try {
      gitSync(nested, ["rev-parse", "--show-toplevel"]);
      expect.fail("the changed commondir must refuse the child result");
    } catch (error) {
      expect(error).toBeInstanceOf(GitTrustRefusal);
      expect((error as GitTrustRefusal).path).toBe(commondir);
    }
  });
  expect(read(commondir)).toBe(before);
  const [racedChild] = operatorCalls(raced.calls());
  expect(racedChild.view?.headLock).toBe(true);
  expect(existsSync(racedChild.backend!.slice(8))).toBe(false);
  // A fresh call after a successful pre-check must still refuse before spawning when trust changes.
  writeFileSync(commondir, `${foreign.common}\n`);
  const refused = recorder({ honour: true });
  await recording(refused, async () => { expect(() => gitSync(nested, ["rev-parse", "HEAD"])).toThrow(commondir); });
  expect(operatorCalls(refused.calls())).toEqual([]);
  writeFileSync(commondir, before);
  expect(compileNative(join(f.repo, nativeSpec)).tasks[0].id).toBe("T1");
  const healthy = fixture("plan", true);
  expect(await invoke("plan", healthy)).toContain("absent-context.txt");
  expect(await compile([nativeSpec, "--type", "native", "--dry-run"], healthy.repo)).toContain("1 tasks, source native");
}, 240_000);
