// v1.51 T4: the mode is never invisible — plan opens with a mode header and per-task floor
// derivations, and every daemon dispatch provenance line begins with the mode and its source
// (a pinned dispatch additionally names the mode its pin bypassed).
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { writeDoctor } from "../../src/adapters/registry.js";
import { FakeAdapter } from "../../src/adapters/fake.js";
import { DEFAULT_CONFIG } from "../../src/config/config.js";
import { fleet, type FleetIO } from "../../src/cli/commands/fleet.js";
import { plan } from "../../src/cli/commands/plan.js";
import { tickmarkrDir, saveGraph } from "../../src/graph/graph.js";
import { validateGraph } from "../../src/graph/schema.js";
import { runDaemon } from "../../src/run/daemon.js";
import { Journal } from "../../src/run/journal.js";
import { COMMIT, T, authedModels, makeRepo, setupRepo } from "../helpers/tmprepo.js";

const verifiedDefaultModels = (id: string) => authedModels(Object.keys(DEFAULT_CONFIG.tiers[id]?.models ?? {}));

const DOCTOR5 = Object.fromEntries(
  ["claude-code", "codex", "cursor-agent", "opencode", "pi"].map((id) => [id, { installed: true, authed: true, models: [], modelAuth: verifiedDefaultModels(id) }]),
);

function mkPlanRepo(shape = "chore"): string {
  const repo = makeRepo({ "keep.txt": "x\n" });
  saveGraph(repo, validateGraph({
    version: 1, spec: { source: "prd", paths: ["p"], hash: "h" },
    tasks: [{ id: "T1", title: "t", goal: "g", shape, complexity: 2, acceptance: ["a"] }],
  }));
  writeDoctor(repo, DOCTOR5);
  return repo;
}

// plan() has no global-dir flag — point XDG at an empty dir so the operator's real
// global config (a possible routing.mode declaration) never leaks into these pins.
let xdgBefore: string | undefined;
beforeEach(() => {
  xdgBefore = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "tickmarkr-modevis-xdg-"));
});
afterEach(() => {
  if (xdgBefore === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = xdgBefore;
});

describe("v1.51 T4 plan mode visibility", () => {
  test("plan prints a mode header naming the mode and its winning source", async () => {
    const repo = mkPlanRepo();
    const out = await plan([], repo);
    expect(out.split("\n")[1]).toBe("mode: risk-based (default) · explore on");
    // a repo-declared mode wins and the header names the layer
    writeFileSync(join(tickmarkrDir(repo), "config.yaml"), "routing:\n  mode: staff-led\n");
    const repoOut = await plan([], repo);
    expect(repoOut.split("\n")[1]).toBe("mode: staff-led (repo config) · explore on");
    // the run flag beats the repo layer; partner-led resolves the explore posture off
    const flagOut = await plan(["--mode", "partner-led"], repo);
    expect(flagOut.split("\n")[1]).toBe("mode: partner-led (run flag) · explore off");
  });

  test("plan prints a derivation line for a task whose floor came from the mode", async () => {
    const repo = mkPlanRepo("implement");
    writeFileSync(join(tickmarkrDir(repo), "config.yaml"), "routing:\n  mode: staff-led\n");
    const out = await plan([], repo);
    expect(out).toContain("    floor cheap ← mode staff-led");
    // an explicit operator floor derives from config floors, never the mode
    writeFileSync(join(tickmarkrDir(repo), "config.yaml"), "routing:\n  mode: staff-led\n  floors:\n    implement: frontier\n");
    const explicit = await plan([], repo);
    expect(explicit).toContain("    floor frontier ← config floors");
    expect(explicit).not.toContain("← mode staff-led");
  });

  test("an unroutable task still carries its floor derivation line", async () => {
    // migration floor frontier under the default mode; only cheap/mid channels authed ⇒ unroutable
    const repo = makeRepo({ "keep.txt": "x\n" });
    saveGraph(repo, validateGraph({
      version: 1, spec: { source: "prd", paths: ["p"], hash: "h" },
      tasks: [{ id: "T1", title: "t", goal: "g", shape: "migration", complexity: 2, acceptance: ["a"] }],
    }));
    writeDoctor(repo, {
      "claude-code": {
        installed: true, authed: true, models: ["sonnet", "haiku"],
        modelAuth: authedModels(["sonnet", "haiku"]),
      },
    });
    const out = await plan([], repo);
    expect(out).toMatch(/T1.*!!/);
    expect(out).toContain("    floor frontier ← mode risk-based");
  });
});

describe("v1.51 T4 dispatch provenance mode visibility", () => {
  const gdir = () => mkdtempSync(join(tmpdir(), "tickmarkr-modevis-g-"));
  const okScript = { tasks: { T1: [{ shell: `echo one > t1.txt && ${COMMIT} t1`, result: { ok: true, summary: "t1" } }] } };
  const dispatchProvenance = (repo: string, runId: string): string => {
    const e = Journal.open(repo, runId).read().find((ev) => ev.event === "task-dispatch");
    expect(e).toBeDefined();
    return e!.data.provenance as string;
  };

  test("a pinned dispatch provenance names the mode it bypassed", async () => {
    const { repo, fake } = setupRepo(
      [T("T1")],
      okScript,
      "routing:\n  map:\n    implement:\n      pin: { via: fake, model: fake-1 }\n",
    );
    const s = await runDaemon(repo, { adapters: [fake], runId: "run-t4-pin", globalDir: gdir() });
    expect(s.done).toEqual(["T1"]);
    const p = dispatchProvenance(repo, s.runId);
    expect(p.startsWith("mode risk-based (default)")).toBe(true);
    expect(p).toContain("pin bypasses mode risk-based");
    expect(p).toContain("pin fake:fake-1 (config routing.map)");
  });

  test("an auto-routed dispatch provenance begins with the mode and its source and claims no bypass", async () => {
    const { repo, fake } = setupRepo([T("T1")], okScript, "routing:\n  mode: staff-led\n");
    const s = await runDaemon(repo, { adapters: [fake], runId: "run-t4-auto", globalDir: gdir() });
    expect(s.done).toEqual(["T1"]);
    const p = dispatchProvenance(repo, s.runId);
    expect(p).toMatch(/^mode staff-led \(repo config\) · /);
    expect(p).not.toContain("bypasses");
  });
});

// ── v1.56 T3: the fleet mode selector's estimated spend context ─────────────
// Minimal fleet TUI driver: raw bytes on a PassThrough decode through node's own keypress
// path (the production seam). Frames on the walk: 0 probe, 1 CLIs, 2 models, 3 mode, then
// one frame per mode-screen keypress. The fake fleet is fake-1 (sub, frontier) + fake-2
// (api, frontier); the DEFAULT map pins plan and spec to claude-code:fable, which cannot
// route here, so every fixture re-pins them onto a fake channel — all nine shapes route.
const FLEET_TIERS = "tiers:\n  fake:\n    vendor: fake\n    channel: sub\n    models:\n      fake-1: mid\n";
const PINS_TO = (m: string) =>
  `  map:\n    plan:\n      pin: { via: fake, model: ${m} }\n    spec:\n      pin: { via: fake, model: ${m} }\n`;
type TestFleetInput = PassThrough & { isTTY: boolean; setRawMode: (mode: boolean) => void };
const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");

const fleetRepo = (routingYaml = `routing:\n${PINS_TO("fake-1")}`) => {
  const repo = makeRepo({ "keep.txt": "x\n" });
  mkdirSync(join(repo, ".tickmarkr"), { recursive: true });
  writeFileSync(join(repo, ".tickmarkr", "config.yaml"), FLEET_TIERS + routingYaml);
  writeDoctor(repo, {
    fake: { installed: true, authed: true, version: "fake", models: ["fake-1", "fake-2"], modelAuth: authedModels(["fake-1", "fake-2"]) },
  });
  const script = join(repo, "fake.json");
  writeFileSync(script, JSON.stringify({ tasks: {} }));
  return { repo, adapter: new FakeAdapter(script) };
};

const driveFleet = async (repo: string, adapter: FakeAdapter, bytes: string): Promise<string[]> => {
  const input = new PassThrough() as TestFleetInput;
  input.isTTY = true;
  input.setRawMode = () => {};
  const writes: string[] = [];
  const io: FleetIO = {
    input,
    output: { isTTY: true, write: (chunk: string) => { writes.push(chunk); } },
  };
  const p = fleet(["--global-dir", mkdtempSync(join(tmpdir(), "tickmarkr-modevis-fleet-g-"))], repo, [adapter], io);
  input.write(bytes);
  expect(await p).toBe("fleet: quit without writing");
  return writes;
};

const mixLine = (frame: string) => stripAnsi(frame).split("\n").find((l) => l.trimStart().startsWith("mix:"));

describe("v1.56 T3 fleet mode spend visibility", () => {
  test("the highlighted mode shows a tier mix line covering all nine shapes", async () => {
    const { repo, adapter } = fleetRepo();
    const writes = await driveFleet(repo, adapter, "\r\r\r\x1b[Bq");
    // frame 3 = the mode screen (risk-based highlighted), frame 4 = after the down (staff-led);
    // both carry a mix line whose tier counts sum to all nine shapes
    for (const frame of [writes[3], writes[4]]) {
      const mix = mixLine(frame);
      expect(mix).toBeDefined();
      const counts = [...mix!.matchAll(/(\d+) (?:cheap|mid|frontier)/g)].map((m) => Number(m[1]));
      expect(counts.reduce((a, b) => a + b, 0)).toBe(9);
    }
    expect(mixLine(writes[3])).toContain("mix: 9 frontier — all sub (flat-rate quota)");
  });

  test("the mode spend line shows no dollar total when every routed shape is on a subscription channel", async () => {
    const { repo, adapter } = fleetRepo();
    const writes = await driveFleet(repo, adapter, "\r\r\rq");
    const mix = mixLine(writes[3]);
    expect(mix).toContain("all sub (flat-rate quota)");
    expect(mix).not.toContain("$");
  });

  test("the mode spend line shows a rough api dollar total when shapes route to api channels", async () => {
    // denying the sub channel forces every preview shape onto fake-2 (api, frontier):
    // 9 × the default pricing-table frontier rate ($2.50) = $22.50
    const { repo, adapter } = fleetRepo(`routing:\n  deny:\n    models: [fake:fake-1]\n${PINS_TO("fake-2")}`);
    const writes = await driveFleet(repo, adapter, "\r\r\rq");
    const mix = mixLine(writes[3]);
    expect(mix).toContain("9 api");
    expect(mix).toContain("est. cost (API shapes only, rough): ~$22.50");
    expect(mix).not.toContain("sub (flat-rate quota)");
  });
});
