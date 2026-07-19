// v1.51 T2: mode sources, the quality alias, and the journal record.
// Source precedence: run flag > spec front-matter > repo config > global config > default.
// --quality is a compatibility alias for one-run partner-led; the v1.47 one-band raise is retired.
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { writeDoctor } from "../../src/adapters/registry.js";
import { plan } from "../../src/cli/commands/plan.js";
import { run } from "../../src/cli/commands/run.js";
import { CompileError } from "../../src/compile/common.js";
import { compileNative } from "../../src/compile/native.js";
import { DEFAULT_CONFIG, ROUTING_MODES, loadConfig } from "../../src/config/config.js";
import { loadGraph, saveGraph, tickmarkrDir } from "../../src/graph/graph.js";
import { GRAPH_ROUTING_MODES, SHAPES, validateGraph } from "../../src/graph/schema.js";
import { resolveRunMode, runDaemon } from "../../src/run/daemon.js";
import { Journal } from "../../src/run/journal.js";
import { COMMIT, T, authedModels, makeRepo, setupRepo } from "../helpers/tmprepo.js";

const FAKE_ONLY_DOCTOR = {
  fake: { installed: true, authed: true, models: [], modelAuth: authedModels(["fake-1", "fake-2"]) },
  "claude-code": { installed: false, authed: false, models: [] },
  codex: { installed: false, authed: false, models: [] },
  "cursor-agent": { installed: false, authed: false, models: [] },
  opencode: { installed: false, authed: false, models: [] },
  pi: { installed: false, authed: false, models: [] },
};

// config-only fixture (no git needed): isolated global dir so the operator's real config never leaks in
function cfgRepo(yaml: string, globalYaml?: string) {
  const globalDir = mkdtempSync(join(tmpdir(), "tickmarkr-modesrc-g-"));
  if (globalYaml !== undefined) writeFileSync(join(globalDir, "config.yaml"), globalYaml);
  const repo = mkdtempSync(join(tmpdir(), "tickmarkr-modesrc-r-"));
  mkdirSync(join(repo, ".tickmarkr"), { recursive: true });
  if (yaml !== undefined) writeFileSync(join(repo, ".tickmarkr", "config.yaml"), yaml);
  return { repo, globalDir };
}

const nativeSpec = (frontMatter: string) => `<!-- tickmarkr:spec -->
${frontMatter}
## T1: thing
- shape: implement
- complexity: 3
- acceptance:
  - test: x
`;

const graphWithMode = (mode: string) => validateGraph({
  version: 1, mode, spec: { source: "prd", paths: ["p"], hash: "h" },
  tasks: [T("T1")],
});

const runStartOf = (repo: string, out: string) => {
  const runId = out.match(/run (run-[\d-]+) finished/)?.[1];
  expect(runId).toBeDefined();
  const start = Journal.open(repo, runId!).read().find((e) => e.event === "run-start");
  expect(start).toBeDefined();
  return start!;
};

describe("v1.51 T2 mode sources", () => {
  afterEach(() => {
    delete process.env.TICKMARKR_FAKE_SCRIPT;
    vi.restoreAllMocks();
  });

  test("the run mode flag overrides a repo config mode", () => {
    const { repo, globalDir } = cfgRepo("routing:\n  mode: staff-led\n");
    const flagged = resolveRunMode(repo, { flag: "partner-led", globalDir });
    expect(flagged.mode.mode).toBe("partner-led");
    expect(flagged.source).toBe("run flag");
    for (const shape of SHAPES) expect(flagged.cfg.routing.floors[shape]).toBe("frontier");
    // without the flag, the repo config mode stands (and its source says so)
    const base = resolveRunMode(repo, { globalDir });
    expect(base.mode.mode).toBe("staff-led");
    expect(base.source).toBe("repo config");
    expect(base.cfg.routing.floors.implement).toBe("cheap");
  });

  test("a spec front-matter mode overrides repo config and loses to the run flag", () => {
    const dir = mkdtempSync(join(tmpdir(), "tickmarkr-modesrc-spec-"));
    const file = join(dir, "spec.md");
    writeFileSync(file, nativeSpec("mode: partner-led\n"));
    const graph = compileNative(file);
    expect(graph.mode).toBe("partner-led");
    // the declaration survives the graph.json round trip
    const repoFs = makeRepo({ "a.txt": "x\n" });
    saveGraph(repoFs, graph);
    expect(loadGraph(repoFs).mode).toBe("partner-led");

    const { repo, globalDir } = cfgRepo("routing:\n  mode: staff-led\n");
    const specWins = resolveRunMode(repo, { spec: graph.mode, globalDir });
    expect(specWins.mode.mode).toBe("partner-led");
    expect(specWins.source).toBe("spec");
    for (const shape of SHAPES) expect(specWins.cfg.routing.floors[shape]).toBe("frontier");
    const flagWins = resolveRunMode(repo, { flag: "risk-based", spec: graph.mode, globalDir });
    expect(flagWins.mode.mode).toBe("risk-based");
    expect(flagWins.source).toBe("run flag");
    expect(flagWins.cfg.routing.floors).toEqual(DEFAULT_CONFIG.routing.floors);
  });

  test("a run flag below the spec-declared mode prints a conflict warning", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { repo, scriptPath } = setupRepo(
      [T("T1")],
      { tasks: { T1: [{ shell: `echo one > t1.txt && ${COMMIT} t1`, result: { ok: true, summary: "t1" } }] } },
    );
    saveGraph(repo, graphWithMode("partner-led"));
    writeDoctor(repo, FAKE_ONLY_DOCTOR);
    process.env.TICKMARKR_FAKE_SCRIPT = scriptPath;

    const r = await run(["--driver", "subprocess", "--mode", "staff-led"], repo);
    expect(r.code).toBe(0); // the run flag wins — loudly, never silently
    const warned = warn.mock.calls.flat().join("\n");
    expect(warned).toMatch(/!! mode conflict: run flag staff-led selects a mode below the spec-declared partner-led — the run flag wins this run/);
    expect(runStartOf(repo, r.out).data).toMatchObject({ mode: "staff-led", modeSource: "run flag" });
  });

  test("route-strict refuses when the run flag conflicts below the spec-declared mode", async () => {
    const { repo } = setupRepo([T("T1")], { tasks: {} });
    saveGraph(repo, graphWithMode("partner-led"));
    await expect(run(["--route-strict", "--mode", "staff-led"], repo))
      .rejects.toThrow(/--route-strict: refusing to dispatch — mode conflict: run flag staff-led selects a mode below the spec-declared partner-led/);
    // a flag at or above the spec mode is no conflict — strict does not refuse on the mode
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { repo: repo2, scriptPath } = setupRepo(
      [T("T1")],
      { tasks: { T1: [{ shell: `echo one > t1.txt && ${COMMIT} t1`, result: { ok: true, summary: "t1" } }] } },
    );
    saveGraph(repo2, graphWithMode("staff-led"));
    writeDoctor(repo2, FAKE_ONLY_DOCTOR);
    process.env.TICKMARKR_FAKE_SCRIPT = scriptPath;
    const r = await run(["--route-strict", "--driver", "subprocess", "--mode", "partner-led"], repo2);
    expect(r.code).toBe(0);
    expect(warn.mock.calls.flat().join("\n")).not.toMatch(/mode conflict/);
  });

  test("the quality flag routes one run as partner-led and prints the alias notice", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    // the worker shell fails if the retired v1.47 QUALITY_ENV seam were still engaged mid-run
    const { repo, scriptPath } = setupRepo(
      [T("T1")],
      { tasks: { T1: [{ shell: `[ -z "$TICKMARKR_QUALITY" ] && echo one > t1.txt && ${COMMIT} t1`, result: { ok: true, summary: "t1" } }] } },
    );
    writeDoctor(repo, FAKE_ONLY_DOCTOR);
    process.env.TICKMARKR_FAKE_SCRIPT = scriptPath;

    const r = await run(["--driver", "subprocess", "--quality"], repo);
    expect(r.code).toBe(0); // green ⇒ the retired one-band-raise env seam never fired
    const warned = warn.mock.calls.flat().join("\n");
    expect(warned).toMatch(/--quality is a compatibility alias for --mode partner-led/);
    expect(warned).toMatch(/one-band floor raise is retired/);
    expect(runStartOf(repo, r.out).data).toMatchObject({ mode: "partner-led", modeSource: "run flag" });
  });

  test("combining the quality flag with a mode flag is an error", async () => {
    const repo = makeRepo({ "a.txt": "x\n" });
    await expect(run(["--quality", "--mode", "risk-based"], repo))
      .rejects.toThrow(/--quality is a compatibility alias for --mode partner-led and cannot be combined with an explicit --mode/);
    // erroring before any graph or config is touched — no run state is created
    await expect(run(["--quality", "--mode", "partner-led"], repo)).rejects.toThrow(/cannot be combined/);
  });

  test("quality carries no residual one-band-raise semantics anywhere", async () => {
    process.env.TICKMARKR_QUALITY = "1";
    try {
      const { repo, fake } = setupRepo(
        [T("T1")],
        { tasks: { T1: [{ shell: `echo one > t1.txt && ${COMMIT} t1`, result: { ok: true, summary: "t1" } }] } },
      );
      const s = await runDaemon(repo, { adapters: [fake], runId: "run-retired-quality-env" });
      expect(s.done).toEqual(["T1"]);
      const dispatch = Journal.open(repo, s.runId).read().find((e) => e.event === "task-dispatch");
      expect(dispatch?.data.provenance).not.toMatch(/--quality|→frontier/);
      const start = Journal.open(repo, s.runId).read().find((e) => e.event === "run-start");
      expect(start?.data).toMatchObject({ mode: "risk-based", modeSource: "default" });
    } finally {
      delete process.env.TICKMARKR_QUALITY;
    }
  });

  test("the journal records the resolved mode and its source at run start", async () => {
    const { repo, scriptPath } = setupRepo(
      [T("T1")],
      { tasks: { T1: [{ shell: `echo one > t1.txt && ${COMMIT} t1`, result: { ok: true, summary: "t1" } }] } },
      "routing:\n  mode: staff-led\n",
    );
    writeDoctor(repo, FAKE_ONLY_DOCTOR);
    process.env.TICKMARKR_FAKE_SCRIPT = scriptPath;

    const r = await run(["--driver", "subprocess"], repo);
    expect(r.code).toBe(0);
    const start = runStartOf(repo, r.out);
    expect(start.data.mode).toBe("staff-led");
    expect(start.data.modeSource).toBe("repo config");
  });
});

describe("v1.51 T2 mode-source edges", () => {
  test("graph mode names stay in parity with config ROUTING_MODES", () => {
    expect(GRAPH_ROUTING_MODES).toEqual(ROUTING_MODES);
  });

  test("a run-flag mode resolves through the same preset compiler as a config-declared mode", () => {
    // identical overlays except one declares the mode in config, the other gets it as a flag —
    // floors, explore, lints, and provenance must be indistinguishable (no duplicated mode math).
    const overlay = "routing:\n  floors:\n    implement: frontier\n    tests: null\n  explore:\n    mode: on\n";
    const flagged = (() => {
      const { repo, globalDir } = cfgRepo(overlay);
      return resolveRunMode(repo, { flag: "staff-led", globalDir });
    })();
    const declared = (() => {
      const { repo, globalDir } = cfgRepo(`routing:\n  mode: staff-led\n  floors:\n    implement: frontier\n    tests: null\n  explore:\n    mode: on\n`);
      return resolveRunMode(repo, { globalDir });
    })();
    expect(flagged.cfg).toEqual(declared.cfg);
    expect(flagged.mode.provenance).toEqual(declared.mode.provenance);
    expect(flagged.mode.lints).toEqual(declared.mode.lints);
    expect(flagged.mode.lints.join("\n")).toMatch(/overrides mode staff-led/);
  });

  test("a global config mode loses to repo and is recorded as the source when it wins", () => {
    const { repo, globalDir } = cfgRepo("", "routing:\n  mode: partner-led\n");
    const globalWins = resolveRunMode(repo, { globalDir });
    expect(globalWins.mode.mode).toBe("partner-led");
    expect(globalWins.source).toBe("global config");
    const { repo: repo2, globalDir: g2 } = cfgRepo("routing:\n  mode: risk-based\n", "routing:\n  mode: partner-led\n");
    const repoWins = resolveRunMode(repo2, { globalDir: g2 });
    expect(repoWins.mode.mode).toBe("risk-based");
    expect(repoWins.source).toBe("repo config");
    const { repo: repo3, globalDir: g3 } = cfgRepo("");
    const dflt = resolveRunMode(repo3, { globalDir: g3 });
    expect(dflt.mode.mode).toBe("risk-based");
    expect(dflt.source).toBe("default");
  });

  test("an invalid mode flag on run and plan errors naming the three modes", async () => {
    const repo = makeRepo({ "a.txt": "x\n" });
    await expect(run(["--mode", "economy"], repo)).rejects.toThrow(/partner-led \| risk-based \| staff-led \(got economy\)/);
    await expect(plan(["--mode", "economy"], repo)).rejects.toThrow(/partner-led \| risk-based \| staff-led \(got economy\)/);
  });

  test("an invalid spec front-matter mode fails compile loudly", () => {
    const dir = mkdtempSync(join(tmpdir(), "tickmarkr-modesrc-bad-"));
    const file = join(dir, "spec.md");
    writeFileSync(file, nativeSpec("mode: economy\n"));
    expect(() => compileNative(file)).toThrow(CompileError);
    expect(() => compileNative(file)).toThrow(/partner-led, risk-based, staff-led/);
    // a mode line after the first task heading is task prose, not front-matter
    const file2 = join(dir, "spec2.md");
    writeFileSync(file2, `<!-- tickmarkr:spec -->\n\n## T1: thing\n- shape: implement\n- complexity: 3\n- acceptance:\n  - test: x\n\nmode: partner-led\n`);
    expect(compileNative(file2).mode).toBeUndefined();
  });

  test("plan --mode previews the mode through the preset compiler", async () => {
    const repo = makeRepo({ "keep.txt": "x\n" });
    saveGraph(repo, validateGraph({
      version: 1, spec: { source: "prd", paths: ["p"], hash: "h" },
      tasks: [{ id: "T1", title: "t", goal: "g", shape: "implement", complexity: 2, acceptance: ["a"] }],
    }));
    // an explicit repo floor shadows the previewed mode's delta — the lint names the flagged mode
    writeFileSync(join(tickmarkrDir(repo), "config.yaml"), "routing:\n  floors:\n    implement: frontier\n");
    const verified = (id: string) => authedModels(Object.keys(loadConfig(repo).tiers[id]?.models ?? {}));
    writeDoctor(repo, Object.fromEntries(
      ["claude-code", "codex", "cursor-agent", "opencode", "pi"].map((id) => [
        id, { installed: true, authed: true, models: [], modelAuth: verified(id) },
      ]),
    ));
    const out = await plan(["--mode", "staff-led"], repo);
    expect(out).toMatch(/overrides mode staff-led — shadowed delta: implement mid→cheap/);
  });
});
