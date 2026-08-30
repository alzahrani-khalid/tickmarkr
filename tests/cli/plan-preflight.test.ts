import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { writeDoctor } from "../../src/adapters/registry.js";
import type { BillingChannel, WorkerAdapter } from "../../src/adapters/types.js";
import { doctor } from "../../src/cli/commands/doctor.js";
import { plan } from "../../src/cli/commands/plan.js";
import type { VitestListResult } from "../../src/gates/acceptance.js";
import { saveGraph } from "../../src/graph/graph.js";
import { validateGraph, type AcceptanceItem } from "../../src/graph/schema.js";
import { makeRepo } from "../helpers/tmprepo.js";

const channels: BillingChannel[] = [
  { adapter: "fake", vendor: "fake-a", model: "fake-1", channel: "sub", tier: "frontier" },
  { adapter: "fake", vendor: "fake-b", model: "fake-2", channel: "api", tier: "frontier" },
];
const adapter = {
  id: "fake",
  vendor: "fake-a",
  probe: async () => ({ installed: true, authed: true, models: [] }),
  channels: () => channels,
} as unknown as WorkerAdapter;

function preflightRepo(
  acceptance: AcceptanceItem[],
  files: string[] = [],
  repoFiles: Record<string, string> = { "keep.txt": "x\n" },
): string {
  const repo = makeRepo(repoFiles);
  saveGraph(repo, validateGraph({
    version: 1,
    spec: { source: "prd", paths: ["fixture"], hash: "fixture" },
    tasks: [{
      id: "T1",
      title: "preflight",
      goal: "preflight",
      shape: "chore",
      complexity: 2,
      files,
      acceptance,
    }],
  }));
  const probedAt = "2026-08-30T00:00:00.000Z";
  writeDoctor(repo, {
    fake: {
      installed: true,
      authed: true,
      models: [],
      modelAuth: {
        "fake-1": { authed: true, probedAt },
        "fake-2": { authed: true, probedAt },
      },
    },
  });
  return repo;
}

function listed(...names: string[]): (cwd: string) => Promise<VitestListResult> {
  return async () => ({
    status: "listed",
    tests: names.map((name, index) => ({ name, file: `/fixture-${index}.test.ts`, projectName: "suite" })),
  });
}

async function planned(repo: string, names: string[]): Promise<string> {
  return plan([], repo, [adapter], undefined, { listTests: listed(...names) });
}

test("test: plan refuses a graph whose acceptance item matches zero of the runner listed test names and refuses one whose item matches two, each verdict read from the refusal plan emits", async () => {
  const criterion = "oracle resolution fixture";
  const repo = preflightRepo([{ oracle: "test", test: criterion }]);

  const zero = await planned(repo, []);
  const many = await planned(repo, [`test: ${criterion}`, `nested > test: ${criterion}`]);

  expect(zero).toContain("pre-dispatch refusal");
  expect(zero).toContain(`acceptance oracle ${JSON.stringify(criterion)} matches zero runner-listed test names`);
  expect(many).toContain("pre-dispatch refusal");
  expect(many).toContain(`acceptance oracle ${JSON.stringify(criterion)} matches 2 runner-listed test names`);
});

test("test: a criterion matching exactly one runner listed test name plans without refusal and reports a passing oracle row in doctor, so a resolved oracle is distinguishable from an unresolved one", async () => {
  const criterion = "one resolved oracle fixture";
  const repo = preflightRepo([{ oracle: "test", test: criterion }]);
  const listTests = listed(`suite > test: ${criterion}`);

  const plannedOutput = await plan([], repo, [adapter], undefined, { listTests });
  const doctorOutput = await doctor(["--"], repo, [adapter], { banner: false, listTests });

  expect(plannedOutput).not.toContain("pre-dispatch refusal");
  expect(doctorOutput).toMatch(/✓ acceptance-oracles\s+1\/1 resolved/);
});

test("test: plan refuses a graph whose task names a path the working tree holds and no commit holds, naming that path", async () => {
  const repo = preflightRepo(["plain criterion"], ["src/local-only.ts"]);
  mkdirSync(join(repo, "src"), { recursive: true });
  writeFileSync(join(repo, "src/local-only.ts"), "export const local = true;\n");

  const output = await plan([], repo, [adapter]);

  expect(output).toContain("pre-dispatch refusal");
  expect(output).toContain('task path "src/local-only.ts" exists in the working tree but no commit holds it');
});

test("test: plan accepts a graph whose task names a path absent from the working tree and from every commit, and warns without refusing when a tracked path's working copy differs", async () => {
  const absentRepo = preflightRepo(["plain criterion"], ["src/future.ts"]);
  const absent = await plan([], absentRepo, [adapter]);

  const dirtyRepo = preflightRepo(
    ["plain criterion"],
    ["src/tracked.ts"],
    { "src/tracked.ts": "export const value = 1;\n" },
  );
  writeFileSync(join(dirtyRepo, "src/tracked.ts"), "export const value = 2;\n");
  const dirty = await plan([], dirtyRepo, [adapter]);

  expect(absent).not.toContain("pre-dispatch refusal");
  expect(dirty).not.toContain("pre-dispatch refusal");
  expect(dirty).toContain('tracked path "src/tracked.ts" differs from HEAD');
  expect(dirty).toContain("git restore -- 'src/tracked.ts'");
});

test("test: a graph whose acceptance items are every one of them a plain string and whose tasks declare no files plans without refusal, so neither new refusal fires on the fixture corpus that predates them", async () => {
  const repo = preflightRepo(["first plain criterion", "second plain criterion"]);
  const output = await plan([], repo, [adapter], undefined, {
    listTests: async () => { throw new Error("plain acceptance must not list tests"); },
  });

  expect(output).not.toContain("pre-dispatch refusal");
  expect(output).not.toContain("!!");
  expect(output).not.toContain("input warnings:");
  expect(output).toMatch(/T1.*fake:fake-1/);
});
