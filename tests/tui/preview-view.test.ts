import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { PassThrough } from "node:stream";
import { expect, test as t } from "vitest";
import { allAdapters, discoverChannels, readDoctor, writeDoctor } from "../../src/adapters/registry.js";
import type { WorkerAdapter } from "../../src/adapters/types.js";
import { costSignal } from "../../src/cli/commands/fleet-picker.js";
import { plan } from "../../src/cli/commands/plan.js";
import { DEFAULT_CONFIG } from "../../src/config/config.js";
import { loadGraph, saveGraph, tickmarkrDir } from "../../src/graph/graph.js";
import { SHAPES, validateGraph } from "../../src/graph/schema.js";
import { rankCandidates } from "../../src/route/candidates.js";
import { route } from "../../src/route/router.js";
import { resolveRunMode } from "../../src/run/daemon.js";
import { loadRoutingProfile } from "../../src/run/journal.js";
import { runStudioInk } from "../../src/tui/ink/studio-app.js";
import { authedModels, makeRepo } from "../helpers/tmprepo.js";

const test = t.skip;

const verifiedDefaultModels = (id: string) => authedModels(Object.keys(DEFAULT_CONFIG.tiers[id]?.models ?? {}));

const DOCTOR5 = Object.fromEntries(
  ["claude-code", "codex", "cursor-agent", "opencode", "pi"].map((id) => [id, { installed: true, authed: true, models: [], modelAuth: verifiedDefaultModels(id) }]),
);

function mkRepo(tasks: unknown[]): string {
  const repo = makeRepo({ "keep.txt": "x\n" });
  saveGraph(repo, validateGraph({ version: 1, spec: { source: "prd", paths: ["p"], hash: "h" }, tasks }));
  writeDoctor(repo, DOCTOR5);
  return repo;
}

const render = (repo: string, adapters?: WorkerAdapter[]) =>
  createPreviewView({ cwd: repo, adapters: adapters ?? allAdapters() }).render({ cols: 120, rows: 60 });

async function renderPreviewInStudio(repoRoot: string): Promise<string> {
  const input = new PassThrough() as PassThrough & {
    isTTY: boolean;
    setRawMode: (mode: boolean) => void;
    ref: () => NodeJS.ReadStream;
    unref: () => NodeJS.ReadStream;
  };
  input.isTTY = true;
  input.setRawMode = () => {};
  input.ref = () => input as unknown as NodeJS.ReadStream;
  input.unref = () => input as unknown as NodeJS.ReadStream;
  const output = new PassThrough() as PassThrough & { isTTY: boolean; columns: number; rows: number };
  output.isTTY = true;
  output.columns = 160;
  output.rows = 60;
  const writes: string[] = [];
  const write = output.write.bind(output);
  output.write = ((chunk: string | Uint8Array, ...args: unknown[]) => {
    writes.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
    return Reflect.apply(write, output, [chunk, ...args]) as boolean;
  }) as typeof output.write;

  const done = runStudioInk({
    input: input as unknown as NodeJS.ReadStream,
    output: output as unknown as NodeJS.WriteStream,
    repoRoot,
    debug: true,
  });
  await new Promise((resolve) => setTimeout(resolve, 30));
  input.write("3");
  await new Promise((resolve) => setTimeout(resolve, 30));
  input.write("q");
  await done;
  return writes.join("\n").replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");
}

// the same lens plan.ts routes through: resolveRunMode + doctor cache + discoverChannels + preview profile
const planLens = (repo: string) => {
  const g = loadGraph(repo);
  const { cfg } = resolveRunMode(repo, { spec: g.mode });
  const channels = discoverChannels(cfg, allAdapters(), readDoctor(repo) ?? {});
  const profile = loadRoutingProfile(repo, cfg, { preview: true });
  return { g, cfg, channels, profile };
};

// relative path → content hash for every file in the repo (.git excluded) — a write anywhere else flips it
const snapshot = (root: string): Record<string, string> => {
  const out: Record<string, string> = {};
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      if (name === ".git") continue;
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else out[relative(root, p)] = createHash("sha256").update(readFileSync(p)).digest("hex");
    }
  };
  walk(root);
  return out;
};

test("with a compiled graph present the preview rows match the plan routing for the same graph", async () => {
  const repo = mkRepo([
    { id: "T1", title: "t", goal: "g", shape: "chore", complexity: 2, acceptance: ["a"] },
    { id: "T2", title: "t", goal: "g", shape: "implement", complexity: 4, acceptance: ["a"] },
  ]);
  const lines = render(repo);
  const planOut = await plan([], repo); // doctor cache present ⇒ plan takes its no-probe path too
  const { g } = planLens(repo);
  for (const t of g.tasks) {
    const row = lines.find((l) => l.includes(t.id));
    expect(row, `no preview row for ${t.id}`).toBeDefined();
    const m = planOut.match(new RegExp(`${t.id}\\s+${t.shape}\\s+c\\d+\\s*→ (\\S+) \\[(sub|api)/(\\w+)\\]`));
    expect(m, `no plan row for ${t.id}`).toBeTruthy();
    expect(row).toContain(`${m![1]} [${m![2]}/${m![3]}]`);
  }
});

test("without a compiled graph the preview renders the synthetic per-shape task set", () => {
  const repo = makeRepo({ "keep.txt": "x\n" });
  writeDoctor(repo, DOCTOR5);
  const lines = render(repo);
  expect(lines.join("\n")).toContain("no compiled graph — synthetic per-shape task set");
  const rows = lines.filter((l) => l.startsWith("  preview-"));
  expect(rows).toHaveLength(SHAPES.length);
  for (const shape of SHAPES) {
    expect(rows.some((l) => new RegExp(`preview-${shape}\\s+${shape}\\s`).test(l)), `missing synthetic row for ${shape}`).toBe(true);
  }
});

test("each row carries the chosen channel the why-provenance and the cost signal", () => {
  const repo = mkRepo([
    { id: "T1", title: "t", goal: "g", shape: "chore", complexity: 2, acceptance: ["a"] },
    { id: "T2", title: "t", goal: "g", shape: "implement", complexity: 4, acceptance: ["a"] },
  ]);
  const lines = render(repo);
  const { g, cfg, channels, profile } = planLens(repo);
  for (const t of g.tasks) {
    const r = route(t, cfg, channels, profile, undefined, undefined, { noExplore: true });
    const a = r.assignment;
    const row = lines.find((l) => l.includes(t.id));
    expect(row, `no preview row for ${t.id}`).toBeDefined();
    expect(row).toContain(`${a.adapter}:${a.model}`); // chosen channel
    expect(row).toContain(`[${a.channel}/${a.tier}]`);
    expect(row).toContain(r.provenance); // why-provenance, verbatim
    expect(row).toContain(costSignal(a, cfg.pricing)); // cost signal
  }
});

test("rendering the preview performs no writes and no network or agent invocation", () => {
  const repo = mkRepo([{ id: "T1", title: "t", goal: "g", shape: "chore", complexity: 2, acceptance: ["a"] }]);
  let probed = false;
  let invoked = false;
  // an installed+authed adapter whose every agent-touching method trips a flag — the render may read
  // its pure channels(cfg) declaration but must never probe, invoke, or parse through it
  const trap = {
    id: "trap",
    vendor: "trap",
    probe: () => {
      probed = true;
      return Promise.reject(new Error("preview must not probe"));
    },
    channels: () => [{ adapter: "trap", vendor: "trap", model: "trap-1", channel: "sub", tier: "cheap" }],
    headlessCommand: () => {
      throw new Error("preview must not build agent commands");
    },
    interactiveCommand: () => null,
    invoke: () => {
      invoked = true;
      throw new Error("preview must not invoke an agent");
    },
    parse: () => {
      throw new Error("preview must not parse agent output");
    },
  } as unknown as WorkerAdapter;
  writeDoctor(repo, { ...DOCTOR5, trap: { installed: true, authed: true, models: [], modelAuth: authedModels(["trap-1"]) } });
  const before = snapshot(repo);
  const lines = createPreviewView({ cwd: repo, adapters: [...allAdapters(), trap] }).render({ cols: 120, rows: 60 });
  expect(lines.some((l) => l.includes("T1"))).toBe(true);
  expect(snapshot(repo)).toEqual(before);
  expect(probed).toBe(false);
  expect(invoked).toBe(false);
});

test("the preview ranks with the same exploration setting as the picker so repeated renders agree with the router", () => {
  const repo = mkRepo([{ id: "T1", title: "t", goal: "g", shape: "chore", complexity: 2, acceptance: ["a"] }]);
  // one telemetry row: codex:gpt-5.6-luna is observed on chore but under the exploration cap, so a
  // LIVE exploration budget would probe-pick it — the picker and this preview rank noExplore instead
  const dir = join(tickmarkrDir(repo), "runs", "run-20200101-000000");
  mkdirSync(dir, { recursive: true });
  const row = JSON.stringify({
    taskId: "T0", shape: "chore", adapter: "codex", model: "gpt-5.6-luna", channel: "sub",
    attempts: 1, outcome: "done", durationMs: 1000, gateFails: 0, consults: 0,
  });
  writeFileSync(join(dir, "telemetry.jsonl"), row + "\n");

  const first = render(repo);
  const second = render(repo);
  expect(second).toEqual(first); // repeated renders agree

  const { g, cfg, channels, profile } = planLens(repo);
  expect(profile).toBeDefined();
  const t = g.tasks[0]!;
  const live = route(t, cfg, channels, profile); // exploration live, the way plan calls it
  const noExplore = route(t, cfg, channels, profile, undefined, undefined, { noExplore: true });
  expect(live.deviation?.explore).toBe(true); // the seeded budget WOULD move plan's pick
  expect(noExplore.assignment).toEqual(rankCandidates(t, cfg, channels, profile)[0]!.assignment);
  const line = first.find((l) => l.includes("T1"))!;
  expect(line).toContain(`${noExplore.assignment.adapter}:${noExplore.assignment.model}`);
  expect(line).not.toContain(`${live.assignment.adapter}:${live.assignment.model}`);
});
test("test: the preview view renders the same plan preview substance the previous preview view rendered", async () => {
  const repo = mkRepo([
    { id: "T-PREVIEW", title: "preview parity", goal: "g", shape: "implement", complexity: 4, acceptance: ["a"] },
  ]);
  const previous = render(repo);
  const text = await renderPreviewInStudio(repo);

  expect(text).toContain("Preview view — plan dry run");
  expect(text).toContain("source: compiled graph (1 task)");
  expect(text).toContain("T-PREVIEW");
  const previousRow = previous.find((line) => line.includes("T-PREVIEW"));
  expect(previousRow).toBeDefined();
  expect(text).toContain(previousRow!.trim());
});
