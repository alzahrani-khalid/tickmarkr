import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { dispatch, USAGE } from "../../src/cli/index.js";
import { parse } from "yaml";
import { compile } from "../../src/cli/commands/compile.js";
import { doctor } from "../../src/cli/commands/doctor.js";
import { init } from "../../src/cli/commands/init.js";
import { plan } from "../../src/cli/commands/plan.js";
import { report } from "../../src/cli/commands/report.js";
import { resume } from "../../src/cli/commands/resume.js";
import { run } from "../../src/cli/commands/run.js";
import { status } from "../../src/cli/commands/status.js";
import { allAdapters, writeDoctor } from "../../src/adapters/registry.js";
import * as registry from "../../src/adapters/registry.js";
import { suggestOverlay } from "../../src/adapters/model-lints.js";
import { DEFAULT_CONFIG, ConfigError, loadConfig } from "../../src/config/config.js";
import type { AuthHealth, WorkerAdapter } from "../../src/adapters/types.js";
import { graphDefinitionHash, loadGraph, saveGraph, tickmarkrDir } from "../../src/graph/graph.js";
import { validateGraph } from "../../src/graph/schema.js";
import { gitHead } from "../../src/run/git.js";
import { runDaemon } from "../../src/run/daemon.js";
import { Journal } from "../../src/run/journal.js";
import { SubprocessDriver } from "../../src/drivers/subprocess.js";
import { COMMIT, authedModels, makeRepo, setupRepo, T } from "../helpers/tmprepo.js";
import { spawnCli, assertCliSuccess, assertCliExit, type BuiltCliResult } from "../helpers/built-cli.js";
import vitestConfig, { DIST_COUPLED_TESTS } from "../../vitest.config.js";

// only fake is installed+authed, so discoverChannels yields fake channels ONLY — routing can never
// pick a real CLI, and no real binary is invoked. Paired with TICKMARKR_FAKE_SCRIPT this keeps the
// through-the-CLI resume/run happy paths deterministic and zero-token.
const FAKE_ONLY_DOCTOR = {
  fake: { installed: true, authed: true, models: [], modelAuth: authedModels(["fake-1", "fake-2"]) },
  "claude-code": { installed: false, authed: false, models: [] },
  codex: { installed: false, authed: false, models: [] },
  "cursor-agent": { installed: false, authed: false, models: [] },
  opencode: { installed: false, authed: false, models: [] },
  pi: { installed: false, authed: false, models: [] },
};

const DOCTOR = {
  "claude-code": { installed: true, authed: true, models: [], modelAuth: authedModels(Object.keys(DEFAULT_CONFIG.tiers["claude-code"].models)) },
  codex: { installed: false, authed: false, models: [] },
  "cursor-agent": { installed: true, authed: true, models: [], modelAuth: authedModels(Object.keys(DEFAULT_CONFIG.tiers["cursor-agent"].models)) },
  opencode: { installed: true, authed: true, models: [], modelAuth: authedModels(Object.keys(DEFAULT_CONFIG.tiers.opencode.models)) },
};

function repoWithPrd(): string {
  const repo = makeRepo({ "keep.txt": "x\n" });
  cpSync("fixtures/sample.prd.md", join(repo, "feature.prd.md"));
  return repo;
}

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const ENTRY = join(ROOT, "dist/cli/index.js");

describe("tickmarkr help", () => {
  beforeEach(() => {
    process.env.TICKMARKR_BUILT_CLI_ENTRY = ENTRY;
  });
  test.each(["help", "-h", "--help"])("%s prints USAGE on stdout and exits 0", async (cmd) => {
    const r = await dispatch(cmd, []);
    expect(r.out).toBe(USAGE);
    expect(r.code).toBe(0);
  });

  test("unknown command prints USAGE and exits 1", async () => {
    const r = await dispatch("nonexistent", []);
    expect(r.out).toBe(USAGE);
    expect(r.code).toBe(1);
  });

  test("built CLI: help/-h/--help exit 0 with USAGE on stdout", () => {
    for (const cmd of ["help", "-h", "--help"]) {
      const r = spawnCli([cmd]);
      assertCliSuccess(r, `help: ${cmd}`);
      expect(r.stderr).toBe("");
      expect(r.stdout).toBe(`${USAGE}\n`);
    }
  });

  test("built CLI: unknown command exits 1 with USAGE on stdout", () => {
    const r = spawnCli(["nonexistent"]);
    assertCliExit(r, 1, "unknown command");
    expect(r.stdout).toBe(`${USAGE}\n`);
  });
});

describe("tickmarkr compile", () => {
  test("writes .tickmarkr/graph.json and reports task count", async () => {
    const repo = repoWithPrd();
    const out = await compile(["feature.prd.md"], repo);
    expect(out).toContain("3 tasks");
    expect(existsSync(join(tickmarkrDir(repo), "graph.json"))).toBe(true);
  });

  test("acceptance-less spec fails loudly (CompileError propagates)", async () => {
    const repo = makeRepo({ "bad.md": "## T1: no acceptance\n- shape: chore\n" });
    await expect(compile(["bad.md"], repo)).rejects.toThrow(/acceptance/);
  });

  test("--type native forces the native front-end", async () => {
    const repo = repoWithPrd();
    const out = await compile(["feature.prd.md", "--type", "native"], repo);
    expect(out).toContain("source native");
    expect(JSON.parse(readFileSync(join(tickmarkrDir(repo), "graph.json"), "utf8")).spec.source).toBe("native");
  });

  test("missing source usage names the native type", async () => {
    await expect(compile([])).rejects.toThrow(/speckit\|prd\|gsd\|native/);
  });
});

describe("tickmarkr plan (dry-run, no dispatch)", () => {
  test("prints routing table with assignment per task + floor lints + cost estimate", async () => {
    const repo = repoWithPrd();
    await compile(["feature.prd.md"], repo);
    writeDoctor(repo, {
      "claude-code": { installed: true, authed: true, models: [], modelAuth: authedModels(Object.keys(DEFAULT_CONFIG.tiers["claude-code"].models)) },
      codex: { installed: false, authed: false, models: [] },
      "cursor-agent": { installed: true, authed: true, models: [], modelAuth: authedModels(Object.keys(DEFAULT_CONFIG.tiers["cursor-agent"].models)) },
      opencode: { installed: true, authed: true, models: [], modelAuth: authedModels(Object.keys(DEFAULT_CONFIG.tiers.opencode.models)) },
    });
    const out = await plan([], repo);
    expect(out).toContain("T1");
    expect(out).toMatch(/cursor-agent|opencode|claude-code/); // an assignment resolved
    expect(out).toMatch(/est\. cost/i);
    expect(out).not.toContain("undefined");
    expect(out).toMatch(/marginal-cost auto|task hint|config routing\.map/); // per-task provenance segment
  });

  test("pin-miss graph: plan shows routing lints + provenance; --route-strict refuses to dispatch", async () => {
    const repo = makeRepo({ "a.txt": "x" });
    saveGraph(repo, validateGraph({
      version: 1, spec: { source: "prd", paths: ["p"], hash: "h" },
      tasks: [{
        id: "T1", title: "t", goal: "g", shape: "implement", complexity: 3, acceptance: ["a"],
        routingHints: { pin: { via: "gemini", model: "flash" }, source: "02-03-PLAN.md" },
      }],
    }));
    writeDoctor(repo, DOCTOR);
    const out = await plan([], repo);
    expect(out).toContain("routing lints:");
    expect(out).toMatch(/unavailable/);
    expect(out).not.toContain("undefined");
    // strict mode: widened refusal is deliberate — any routing lint blocks dispatch
    await expect(run(["--route-strict"], repo)).rejects.toThrow(/refusing to dispatch/);
    expect(existsSync(join(tickmarkrDir(repo), "runs"))).toBe(false); // rejected before any task ran
  });

  test("plan warns when the judge/consult adapter is not installed", async () => {
    const repo = repoWithPrd();
    await compile(["feature.prd.md"], repo);
    writeDoctor(repo, {
      "claude-code": { installed: false, authed: false, models: [] }, // default judge+consult live here
      codex: { installed: false, authed: false, models: [] },
      "cursor-agent": { installed: true, authed: true, models: [], modelAuth: authedModels(Object.keys(DEFAULT_CONFIG.tiers["cursor-agent"].models)) },
      opencode: { installed: true, authed: true, models: [], modelAuth: authedModels(Object.keys(DEFAULT_CONFIG.tiers.opencode.models)) },
    });
    const out = await plan([], repo);
    expect(out).toMatch(/judge: claude-code:fable not installed/);
    expect(out).toMatch(/fail closed/);
  });
});

describe("tickmarkr resume", () => {
  afterEach(() => { delete process.env.TICKMARKR_FAKE_SCRIPT; }); // no fake-adapter leak into sibling suites

  const dispatchFailedRun = async (runId: string) => {
    const { repo, fake, scriptPath } = setupRepo(
      [T("T1")],
      { tasks: { T1: [{ shell: `echo retried > retried.txt && ${COMMIT} retried`, result: { ok: true, summary: "retried" } }] } },
      "driver: subprocess\n",
    );
    writeDoctor(repo, FAKE_ONLY_DOCTOR);
    process.env.TICKMARKR_FAKE_SCRIPT = scriptPath;
    const inner = new SubprocessDriver();
    const failingDriver = {
      id: "dispatch-refusal",
      interactive: false,
      status: inner.status.bind(inner),
      slot: inner.slot.bind(inner),
      async run() { throw new Error("delivery refused"); },
      waitOutput: inner.waitOutput.bind(inner),
      waitAgentStatus: inner.waitAgentStatus.bind(inner),
      read: inner.read.bind(inner),
      notify: inner.notify.bind(inner),
      close: inner.close.bind(inner),
      worktree: inner.worktree.bind(inner),
    };
    const failed = await runDaemon(repo, { adapters: [fake], runId, driver: failingDriver });
    expect(failed.failed).toEqual(["T1"]);
    expect(Journal.open(repo, runId).read().find((e) => e.event === "task-failed")?.data)
      .toMatchObject({ kind: "dispatch", attempts: 0 });
    return repo;
  };

  test("TICKMARKR_FAKE_SCRIPT selects the fake adapter script path", () => {
    const dir = mkdtempSync(join(tmpdir(), "tickmarkr-fake-env-"));
    const scriptPath = join(dir, "fake.json");
    writeFileSync(scriptPath, JSON.stringify({ tasks: {} }));
    process.env.TICKMARKR_FAKE_SCRIPT = scriptPath;
    expect((allAdapters()[0] as unknown as { scriptPath: string }).scriptPath).toBe(scriptPath);
  });

  test("no run id → usage error (never spins up a phantom run)", async () => {
    const repo = makeRepo({ "a.txt": "x" });
    await expect(resume([], repo)).rejects.toThrow(/usage: tickmarkr resume/);
  });

  test("happy path: continues a prior run from its journal via the fake adapter (zero tokens)", async () => {
    const { repo, scriptPath } = setupRepo(
      [T("T1"), T("T2", { deps: ["T1"] })],
      { tasks: {
        T1: [{ shell: "echo SHOULD-NOT-RUN && exit 1", result: { ok: false, summary: "must not run" } }],
        T2: [{ shell: `echo two > t2.txt && ${COMMIT} t2`, result: { ok: true, summary: "t2" } }],
      } },
    );
    writeDoctor(repo, FAKE_ONLY_DOCTOR);
    process.env.TICKMARKR_FAKE_SCRIPT = scriptPath; // registry prepends FakeAdapter for the real CLI entry
    // hand-craft a prior interrupted run: T1 done, baseline saved, run-start journaled
    const j = Journal.create(repo, "run-x");
    const baseRef = await gitHead(repo);
    j.append("run-start", undefined, { baseRef, commands: {}, graphDefinitionHash: graphDefinitionHash(loadGraph(repo)) });
    j.append("task-dispatch", "T1");
    j.append("task-done", "T1");
    writeFileSync(join(j.dir, "baseline.json"), JSON.stringify({ commands: {} }));

    const { out } = await resume(["run-x"], repo);
    expect(out).toMatch(/resumed run-x/); // resume.ts formats the summary the operator sees
    expect(out).toMatch(/done: 2/); // T1 replayed done + T2 dispatched through the CLI entry → both done
  });

  test("test: a resume invoked with the retry option re-attempts a task that failed at dispatch with a fresh dispatch", async () => {
    const runId = "run-retry-dispatch";
    const repo = await dispatchFailedRun(runId);

    const { out, code } = await resume([runId, "--retry-failed"], repo);

    expect(code).toBe(0);
    expect(out).toMatch(/done: 1/);
    const events = Journal.open(repo, runId).read();
    const resumeIdx = events.findIndex((e) => e.event === "run-resume");
    const dispatches = events.slice(resumeIdx + 1).filter((e) => e.event === "task-dispatch" && e.taskId === "T1");
    expect(dispatches).toHaveLength(1);
    expect(dispatches[0]!.data).toMatchObject({ attempt: 0, retryMode: "fresh" });
  }, 30_000);

  test("test: a resume without the retry option treats dispatch-failed tasks exactly as before", async () => {
    const runId = "run-no-retry-dispatch";
    const repo = await dispatchFailedRun(runId);

    const { out, code } = await resume([runId], repo);

    expect(code).toBe(2);
    expect(out).toMatch(/failed: 1/);
    const events = Journal.open(repo, runId).read();
    const resumeIdx = events.findIndex((e) => e.event === "run-resume");
    expect(events.slice(resumeIdx + 1).filter((e) => e.event === "task-dispatch" && e.taskId === "T1")).toHaveLength(0);
  }, 30_000);
});

describe("tickmarkr run (flag branches, fake adapter, zero tokens)", () => {
  afterEach(() => { delete process.env.TICKMARKR_FAKE_SCRIPT; });

  test("--concurrency + explicit --driver run a 1-task graph to a green summary", async () => {
    const { repo, scriptPath } = setupRepo(
      [T("T1")],
      { tasks: { T1: [{ shell: `echo one > t1.txt && ${COMMIT} t1`, result: { ok: true, summary: "t1" } }] } },
    );
    writeDoctor(repo, FAKE_ONLY_DOCTOR);
    process.env.TICKMARKR_FAKE_SCRIPT = scriptPath;

    const { out } = await run(["--concurrency", "1", "--driver", "subprocess"], repo);
    expect(out).toMatch(/finished/); // covers the concurrency ternary + explicit-driver branch (run.ts:30-31)
    expect(out).toMatch(/merge to main is a human decision/);
  });
});

// v1.53 T5: --supersedes — explicit rerun escalation recorded on both runs. The prior journal is
// append-only (byte-prefix asserted); the new run-start stamps the relationship; resume refuses the dead run.
describe("tickmarkr run --supersedes", () => {
  afterEach(() => { delete process.env.TICKMARKR_FAKE_SCRIPT; });

  const greenRepo = () => {
    const { repo, scriptPath } = setupRepo(
      [T("T1")],
      { tasks: { T1: [{ shell: `echo one > t1.txt && ${COMMIT} t1`, result: { ok: true, summary: "t1" } }] } },
    );
    writeDoctor(repo, FAKE_ONLY_DOCTOR);
    process.env.TICKMARKR_FAKE_SCRIPT = scriptPath;
    return repo;
  };

  test("run with a supersedes flag appends a superseded event to the prior run journal naming the new run", async () => {
    const repo = greenRepo();
    const prior = Journal.create(repo, "run-prior");
    prior.append("run-start", undefined, { baseRef: "x", commands: {} });
    const before = readFileSync(join(prior.dir, "journal.jsonl"), "utf8");

    const { out } = await run(["--supersedes", "run-prior", "--driver", "subprocess"], repo);
    const newId = /run (run-\S+) finished/.exec(out)![1]!;

    const after = readFileSync(join(prior.dir, "journal.jsonl"), "utf8");
    expect(after.startsWith(before)).toBe(true); // gains ONLY an appended event — nothing above it rewritten
    const added = after.slice(before.length).trim().split("\n");
    expect(added).toHaveLength(1);
    const event = JSON.parse(added[0]!);
    expect(event.event).toBe("superseded");
    expect(event.data.by).toBe(newId);
  });

  test("run with a supersedes flag records the prior run id in its own run start event", async () => {
    const repo = greenRepo();
    Journal.create(repo, "run-prior").append("run-start", undefined, { baseRef: "x", commands: {} });

    const { out } = await run(["--supersedes", "run-prior", "--driver", "subprocess"], repo);
    const newId = /run (run-\S+) finished/.exec(out)![1]!;

    const start = Journal.open(repo, newId).read().find((e) => e.event === "run-start")!;
    expect(start.data.supersedes).toBe("run-prior");
  });

  test("a supersedes flag naming an unknown run id fails before any run starts", async () => {
    const repo = greenRepo();
    await expect(run(["--supersedes", "run-nope", "--driver", "subprocess"], repo)).rejects.toThrow(/no journal for run-nope/);
    expect(existsSync(join(tickmarkrDir(repo), "runs"))).toBe(false); // no journal, no baseline — nothing started
  });

  test("resuming a superseded run fails naming the superseding run", async () => {
    const repo = greenRepo();
    const j = Journal.create(repo, "run-x");
    j.append("run-start", undefined, { baseRef: "x", commands: {}, graphDefinitionHash: graphDefinitionHash(loadGraph(repo)) });
    j.append("superseded", undefined, { by: "run-y" });
    await expect(resume(["run-x"], repo)).rejects.toThrow(/superseded by run-y/);
  });
});

describe("tickmarkr status + report", () => {
  test("status reads graph + latest journal; report aggregates telemetry", async () => {
    const repo = repoWithPrd();
    await compile(["feature.prd.md"], repo);
    const j = Journal.create(repo, "run-cli");
    j.append("run-start", undefined, { baseRef: "x", commands: {}, graphDefinitionHash: graphDefinitionHash(loadGraph(repo)) });
    j.append("task-dispatch", "T1", { assignment: { adapter: "fake", model: "fake-1", channel: "sub", tier: "frontier" }, attempt: 0 });
    j.append("task-done", "T1");
    j.telemetry({ taskId: "T1", shape: "implement", adapter: "fake", model: "fake-1", channel: "sub", attempts: 1, outcome: "done", durationMs: 5 });
    const st = await status([], repo);
    expect(st).toContain("T1");
    expect(st).toContain("done");
    const rp = await report(["run-cli"], repo);
    expect(rp).toContain("tickmarkr engagement — run-cli");
    expect(rp).toContain("engagement summary — audit trail:");
    expect(rp).toContain("fake:fake-1");
    expect(rp).toMatch(/tickmark rate|National Office|spend/i);
  });
});

describe("tickmarkr init", () => {
  test("writes repo overlay + global config + native spec template (custom dir) and runs doctor", async () => {
    const repo = makeRepo({ "a.txt": "x" });
    const globalDir = mkdtempSync(join(tmpdir(), "tickmarkr-init-g-"));
    const probe = vi.fn(async () => ({ installed: true, authed: true, models: [] }));
    const adapters = [{ id: "init-stub", vendor: "test", probe }] as unknown as WorkerAdapter[];
    const allAdaptersSpy = vi.spyOn(registry, "allAdapters").mockReturnValue(adapters);
    let out: string;
    try {
      out = await init(["--global-dir", globalDir], repo);
    } finally {
      allAdaptersSpy.mockRestore();
    }
    expect(existsSync(join(tickmarkrDir(repo), "config.yaml"))).toBe(true);
    expect(existsSync(join(globalDir, "config.yaml"))).toBe(true);
    expect(existsSync(join(tickmarkrDir(repo), "doctor.json"))).toBe(true);
    expect(existsSync(join(repo, "tickmarkr.spec.md"))).toBe(true); // template written at repo root
    expect(out).toContain("init-stub");
    expect(probe).toHaveBeenCalledOnce(); // injected adapter only — no installed CLI is probed
    expect(out).toContain("next: edit tickmarkr.spec.md, then tickmarkr compile tickmarkr.spec.md && tickmarkr plan && tickmarkr run");
    expect(out).toContain("environments:");
    expect(out).toContain(
      "the full cockpit — every worker, judge, and consult is a visible pane you can watch and unblock · https://herdr.dev",
    );
    expect(out).toContain(
      "tickmarkr init --agent installs the /tkr skills + AGENTS.md so Claude Code (or any agent CLI) drives the loop natively",
    );
    expect(out).toContain("no herdr? same fail-closed gates, headless subprocess driver");
    const retired = ["dro", "vr"].join("");
    expect(out).not.toMatch(new RegExp(`next:.*\\b${retired}\\b`));
    const spec = readFileSync(join(repo, "tickmarkr.spec.md"), "utf8");
    expect(spec).toContain("<!-- tickmarkr:spec -->");

    // skip-if-exists: a hand-edited spec survives a re-init untouched (never overwrites)
    writeFileSync(join(repo, "tickmarkr.spec.md"), "<!-- tickmarkr:spec -->\n## T1: kept\n- acceptance:\n  - kept\n");
    const out2 = await init(["--global-dir", globalDir], repo);
    expect(out2).toMatch(/kept existing.*tickmarkr\.spec\.md/);
    expect(readFileSync(join(repo, "tickmarkr.spec.md"), "utf8")).toContain("## T1: kept");
  });
});

describe("tickmarkr doctor — model detection (injectable adapters seam, zero-token)", () => {
  // minimal WorkerAdapter stubs: doctor only touches id/probe/listModels — cast keeps the fixture lean (ponytail).
  const stub = (id: string, listModels?: () => Promise<string[]>) =>
    ({ id, vendor: "x", probe: async () => ({ installed: true, authed: true, models: [] }), listModels }) as unknown as WorkerAdapter;

  test("resolving listModels persists models + modelsDetectedAt; a throwing one fails open", async () => {
    const repo = makeRepo({ "a.txt": "x" });
    const okAdapter = stub("ok-list", async () => ["m1", "m2"]);
    const badAdapter = stub("bad-list", async () => { throw new Error("list surface broke"); });
    const out = await doctor(["--"], repo, [okAdapter, badAdapter]); // never throws — detection is advisory
    expect(out).toMatch(/capability matrix/);
    const dj = JSON.parse(readFileSync(join(tickmarkrDir(repo), "doctor.json"), "utf8"));
    expect(dj["ok-list"].models).toEqual(["m1", "m2"]);
    expect(typeof dj["ok-list"].modelsDetectedAt).toBe("string"); // stamp written AFTER the loop, into the single writeDoctor
    expect(dj["bad-list"].models).toEqual([]); // fail-open: unchanged
    expect(dj["bad-list"].modelsDetectedAt).toBeUndefined();
  });
});

describe("tickmarkr doctor — model drift suggestion fragment (MODEL-05/06/07)", () => {
  const stub = (id: string, listModels?: () => Promise<string[]>) =>
    ({ id, vendor: "x", probe: async () => ({ installed: true, authed: true, models: [] }), listModels }) as unknown as WorkerAdapter;
  const installed = (models: string[], at?: string): AuthHealth => ({ installed: true, authed: true, models, ...(at ? { modelsDetectedAt: at } : {}) });
  // codex seeds fable-adjacent frontier gpt-5.6-sol; a real CLI that drops it must surface a tombstone (LIVE-CHECK finding 5)
  const CODEX_DRIFT = ["gpt-5.5", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-5.7-nova"];

  test("wiring: doctor prints the fragment on drift; omits it entirely when detection matches config", async () => {
    const driftRepo = makeRepo({ "a.txt": "x" });
    const out = await doctor(["--"], driftRepo, [stub("codex", async () => CODEX_DRIFT)]);
    expect(out).toContain("paste-ready overlay");
    expect(out).toContain("tiers:");
    expect(out).toContain("gpt-5.6-sol: null");

    const cleanRepo = makeRepo({ "a.txt": "x" });
    const clean = await doctor(["--"], cleanRepo, [stub("codex", async () => ["gpt-5.6-sol", "gpt-5.5", "gpt-5.6-terra", "gpt-5.6-luna"])]);
    expect(clean).not.toContain("paste-ready overlay");
    expect(clean).not.toContain("tiers:");
  });

  test("never-writes (MODEL-05 posture): repo overlay byte-identical after doctor; only doctor.json is tickmarkr's write", async () => {
    const repo = makeRepo({ "a.txt": "x" });
    mkdirSync(join(repo, ".tickmarkr"), { recursive: true });
    const overlay = join(repo, ".tickmarkr", "config.yaml");
    writeFileSync(overlay, "concurrency: 2\n");
    const before = readFileSync(overlay);
    // drill 2026-07-10: adding writeFileSync(overlay, frag) to doctor.ts turns this red (never-writes)
    await doctor(["--"], repo, [stub("codex", async () => ["gpt-5.5"])]); // heavy drift → fragment produced
    expect(readFileSync(overlay).equals(before)).toBe(true);
    // tickmarkr's only writes under .tickmarkr are doctor.json (+ tickmarkrDir's own .gitignore); config.yaml is never touched
    expect(readdirSync(tickmarkrDir(repo)).sort()).toEqual([".gitignore", "config.yaml", "doctor.json"]);
  });

  test("round-trip (MODEL-07 tie): doctor's own fragment loads — tombstone applies, addition inert, uncommented ??? / typo tier fails loud", () => {
    // pins the PASTE FLOW; the enum boundary itself is pinned at tests/config/config.test.ts:91 — not duplicated here.
    const base = loadConfig(makeRepo({ "a.txt": "x" }), { globalDir: mkdtempSync(join(tmpdir(), "tickmarkr-rt-g-")) });
    const frag = suggestOverlay(base, { codex: installed(CODEX_DRIFT, "2026-07-10T09:00:00.000Z") }, allAdapters());

    const write = (yaml: string) => {
      const repo = makeRepo({ "a.txt": "x" });
      const globalDir = mkdtempSync(join(tmpdir(), "tickmarkr-rt-g-"));
      mkdirSync(join(repo, ".tickmarkr"), { recursive: true });
      writeFileSync(join(repo, ".tickmarkr", "config.yaml"), yaml);
      return { repo, globalDir };
    };

    // paste verbatim → loads clean, tombstone applied, commented addition never materializes
    const { repo, globalDir } = write(frag);
    const cfg = loadConfig(repo, { globalDir });
    expect("gpt-5.6-sol" in cfg.tiers.codex.models).toBe(false);
    expect("gpt-5.7-nova" in cfg.tiers.codex.models).toBe(false);
    // sanity: the fragment really did carry both a tombstone and a commented addition
    const parsed = parse(frag) as { tiers: { codex: { models: Record<string, unknown> } } };
    expect(parsed.tiers.codex.models["gpt-5.6-sol"]).toBeNull();

    // operator uncomments the addition WITHOUT classifying → ??? is not a tier → fail loud
    const uncommented = write(frag.replace(/# (gpt-5\.7-nova): \?\?\?/, "$1: ???"));
    expect(() => loadConfig(uncommented.repo, { globalDir: uncommented.globalDir })).toThrow(ConfigError);
    // …or fat-fingers the tier → fail loud
    const typo = write(frag.replace(/# (gpt-5\.7-nova): \?\?\?/, "$1: fronteir"));
    expect(() => loadConfig(typo.repo, { globalDir: typo.globalDir })).toThrow(ConfigError);
  });
});

describe("built-cli helper (OBS-96 piece 1)", () => {
  test("test: a forced non-zero exit from the built CLI in a test using the shared helper produces a failure message containing the exit status and the child's stderr", () => {
    const failed: BuiltCliResult = {
      status: 1,
      signal: null,
      stderr: "fatal error: something went wrong",
      stdout: "",
      durationMs: 1500,
    };
    expect(() => assertCliSuccess(failed, "forced failure")).toThrow(/exit status: 1[\s\S]*fatal error: something went wrong/);
  });

  test("test: a forced non-zero exit from the built CLI in a test using the shared helper produces a failure message containing the elapsed wall-clock duration", () => {
    const failed: BuiltCliResult = {
      status: 1,
      signal: null,
      stderr: "error output",
      stdout: "",
      durationMs: 14500,
    };
    expect(() => assertCliSuccess(failed, "slow failure")).toThrow(/elapsed: 14500ms/);
  });

  test("test: every built-CLI assertion in both test files runs through the shared helper rather than a raw spawnSync assertion", () => {
    for (const rel of ["tests/cli/cli.test.ts", "tests/cli/version.test.ts"]) {
      const src = readFileSync(join(ROOT, rel), "utf8");
      expect(src).not.toMatch(/\bspawnSync\s*\(/);
      expect(src).toMatch(/\bassertCli(Success|Exit)\s*\(/);
    }
  });

  test("the helper's failure message alone is enough to distinguish a slow cold-contention failure from a fast genuine regression without re-running anything", () => {
    const slow: BuiltCliResult = { status: 1, signal: null, stderr: "test timeout error", stdout: "", durationMs: 75000 };
    const fast: BuiltCliResult = { status: 1, signal: null, stderr: "assertion failed: expected 5 to be 10", stdout: "", durationMs: 800 };
    const slowMsg = captureAssertFail(() => assertCliSuccess(slow, "cold contention"));
    const fastMsg = captureAssertFail(() => assertCliSuccess(fast, "real bug"));
    expect(slowMsg).toContain("elapsed: 75000ms");
    expect(fastMsg).toContain("elapsed: 800ms");
    expect(slowMsg).toMatch(/elapsed: (\d+)ms/);
    expect(fastMsg).toMatch(/elapsed: (\d+)ms/);
    expect(Number(slowMsg.match(/elapsed: (\d+)ms/)![1])).toBeGreaterThan(30000);
    expect(Number(fastMsg.match(/elapsed: (\d+)ms/)![1])).toBeLessThan(5000);
  });
});

describe("OBS-96 fix (piece 3) — dist mid-suite rewrite race", () => {
  // The rig's telemetry (scripts/repro-obs96.mjs REPRO_RECORD) captured the contended resource:
  // bin.test.ts:37 rewrites ROOT dist (tsc truncate-then-write) while forks here + version.test.ts
  // spawn node dist/cli/index.js and import a mid-rewrite module (dist/route/router.js, empty →
  // SyntaxError, exit 1, no stdout). A first run in a freshly built dist passes iff the writer can
  // never overlap the readers, so this pins the scheduling contract that makes that true — and its
  // closure over the whole test tree, so a future dist reader/writer outside the set turns it red.
  //
  // Fix verification record (2026-07-19, this host — darwin arm64 18-way):
  //   pre-fix c20c22f: rig cold attempt reproduced the target signature (probe crashes both files,
  //     missingDist:false, warm-control 1200 reads / 0 crashes green) — the rig is live, not an artifact;
  //   post-fix fd1f7dc: 5/5 independently cold rig attempts — cold `npm test` exit 0, failedFiles [],
  //     `✓ |built-cli| cli.test.ts + version.test.ts + bin.test.ts` serialized at the tail of each run;
  //     the rig's part-(b) probe still crashes by construction (it spawns its own concurrent
  //     `npm run build` writers OUTSIDE vitest — the raw mechanism, which no suite scheduling can or
  //     should mask) and each probe red's paired warm control stayed green, so those reds are the
  //     manufactured race, not a suite regression.
  interface ProjectEntry {
    test: {
      name?: string;
      pool?: string;
      include?: string[];
      exclude?: string[];
      poolOptions?: { forks?: { singleFork?: boolean } };
    };
  }

  test("test: the full suite passes on a first run in a freshly built dist directory with no prior warm run in the same process", () => {
    // the rig-evidenced set: the one mid-suite dist writer + the two spawnCli readers
    expect([...DIST_COUPLED_TESTS].sort()).toEqual(["tests/cli/bin.test.ts", "tests/cli/cli.test.ts", "tests/cli/version.test.ts"]);

    // 1) they run in ONE fork, files sequential, after the parallel fan-out — writer ∦ readers
    const projects = (vitestConfig as { test?: { projects?: ProjectEntry[] } }).test?.projects ?? [];
    const builtCli = projects.find((p) => p.test.name === "built-cli");
    expect(builtCli).toBeDefined();
    expect(builtCli!.test.include).toEqual(DIST_COUPLED_TESTS);
    expect(builtCli!.test.poolOptions?.forks?.singleFork).toBe(true);
    expect(builtCli!.test.pool).toBeUndefined(); // forks is the default pool — singleFork applies

    // 2) every OTHER project excludes all three, so no parallel fork can also pick them up
    for (const p of projects) {
      if (p.test.name === "built-cli") continue;
      for (const f of DIST_COUPLED_TESTS) expect(p.test.exclude).toContain(f);
    }

    // 3) closure: every test file that spawns the built CLI or rebuilds ROOT dist mid-suite is in
    // the serialized set — nothing dist-coupled can run in a parallel fork
    const testFiles = readdirSync(join(ROOT, "tests"), { recursive: true, encoding: "utf8" })
      .filter((p) => p.endsWith(".test.ts"))
      .map((p) => join("tests", p));
    expect(testFiles.length).toBeGreaterThan(30); // the sweep saw the real tree
    const distCoupled = testFiles.filter((rel) => {
      const src = readFileSync(join(ROOT, rel), "utf8");
      return /TICKMARKR_BUILT_CLI_ENTRY|helpers\/built-cli|\bspawnCli\s*\(/.test(src) || /\[\s*["']run["'],\s*["']build["']\s*\]/.test(src);
    });
    expect(distCoupled.sort()).toEqual([...DIST_COUPLED_TESTS].sort());
  });
});

function captureAssertFail(fn: () => void): string {
  try {
    fn();
  } catch (e) {
    return String(e);
  }
  return "";
}
