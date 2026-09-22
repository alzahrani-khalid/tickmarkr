import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { writeDoctor } from "../../src/adapters/registry.js";
import type { BillingChannel, WorkerAdapter } from "../../src/adapters/types.js";
import { doctor } from "../../src/cli/commands/doctor.js";
import { plan } from "../../src/cli/commands/plan.js";
import type { VitestListResult } from "../../src/gates/acceptance.js";
import { compileNative } from "../../src/compile/native.js";
import { loadGraph, saveGraph } from "../../src/graph/graph.js";
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

function nativePreflightRepo(acceptance: string[], files: string[], repoFiles: Record<string, string> = {}): string {
  const spec = `<!-- tickmarkr:spec -->
# Oracle landing fixture
## T1: preflight
- goal: Check oracle landings
- shape: chore
- complexity: 2
- files: ${files.join(", ")}
- acceptance:
${acceptance.map((item) => `  - ${item}`).join("\n")}
`;
  const repo = preflightRepo(["placeholder"], [], { ...repoFiles, "spec.md": spec });
  const compiled = compileNative(join(repo, "spec.md"));
  saveGraph(repo, compiled);
  expect(loadGraph(repo)).toEqual(compiled);
  return repo;
}

test("test: plan over a compiled native spec reports a zero match criterion whose declared landing is a suite the task owns by exact path or by glob as pending authorship naming that suite, so an owned landing printed as a refusal fails", async () => {
  for (const ownership of ["tests/landing.test.ts", "tests/**/*.test.ts", "tests/{landing,other}.test.ts"]) {
    for (const exists of [false, true]) {
      const landing = "tests/landing.test.ts";
      const criterion = "new criterion";
      const repo = nativePreflightRepo(
        [`test: ${criterion} | suite: ${landing}`],
        [ownership],
        exists ? { [landing]: 'test("a different title", () => {});\n' } : {},
      );
      expect(loadGraph(repo).tasks[0]!.acceptance).toEqual([{ oracle: "test", test: criterion, landing }]);
      const output = await planned(repo, exists ? ["test: a different title"] : []);
      expect(output).toContain(`acceptance oracle "${criterion}" not yet written (worker authors ${landing})`);
      expect(output).not.toContain("pre-dispatch refusal");
      expect(output).not.toContain("matches zero runner-listed test names");
      expect(output).toMatch(/T1.*→ fake:fake-1/);
      // An already resolved title needs neither a refusal nor an authorship advisory.
      const resolved = await planned(repo, [`test: ${criterion}`]);
      expect(resolved).not.toContain("pre-dispatch refusal");
      expect(resolved).not.toContain("not yet written");
    }
  }
});

test("test: an unmatched criterion declaring no landing or an unowned landing stays refused despite an unrelated owned absent suite, so unrelated ownership that grants pending authorship fails", async () => {
  for (const ownership of ["tests/owned.test.ts", "tests/owned/**/*.test.ts"]) {
    const owned = ownership.includes("**") ? "tests/owned/new.test.ts" : ownership;
    const repo = nativePreflightRepo([
      `test: owned criterion | suite: ${owned}`,
      "test: no landing criterion",
      "test: unowned criterion | suite: tests/unowned.test.ts",
    ], [ownership]);
    const output = await planned(repo, []);
    const row = output.split("\n").find((line) => /^\s+T1\s/.test(line));
    expect(row).toContain("pre-dispatch refusal");
    for (const criterion of ["no landing criterion", "unowned criterion"]) {
      expect(output).toContain(`acceptance oracle "${criterion}" matches zero runner-listed test names`);
      expect(output).not.toContain(`acceptance oracle "${criterion}" not yet written`);
    }
  }
});

test("test: a failed runner listing or a title matching two listed tests stays a refusal whatever landing the criterion declares, so a landing that hides an unresolved listing or an ambiguous title fails", async () => {
  for (const landing of [undefined, "tests/owned.test.ts", "tests/unowned.test.ts"]) {
    const criterion = "unresolved criterion";
    const repo = nativePreflightRepo(
      [`test: ${criterion}${landing ? ` | suite: ${landing}` : ""}`],
      ["tests/owned.test.ts"],
    );
    const failed = await plan([], repo, [adapter], undefined, {
      listTests: async () => ({ status: "failed", error: "runner unavailable\nsecondary detail" }),
    });
    expect(failed).toContain("pre-dispatch refusal");
    expect(failed).toContain("acceptance oracle unresolved — runner listing failed: runner unavailable");
    expect(failed).not.toContain("secondary detail");
    expect(failed).not.toContain("not yet written");
    const ambiguous = await planned(repo, [`test: ${criterion}`, `nested > test: ${criterion}`]);
    expect(ambiguous).toContain("pre-dispatch refusal");
    expect(ambiguous).toContain(`acceptance oracle "${criterion}" matches 2 runner-listed test names`);
    expect(ambiguous).not.toContain("not yet written");
  }
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

test("test: a graph whose test-oracle criterion matches no runner-listed test makes the doctor row report fail and name how many oracles resolved out of how many were audited; a row that reports pass whenever the listing itself succeeded fails", async () => {
  const repo = preflightRepo([
    { oracle: "test", test: "first oracle" },
    { oracle: "test", test: "second oracle" },
    { oracle: "test", test: "missing oracle" },
  ]);

  const output = await doctor(["--"], repo, [adapter], {
    banner: false,
    listTests: listed("test: first oracle", "test: second oracle"),
  });

  expect(output).toMatch(/✗ acceptance-oracles\s+2\/3 resolved/);
  expect(output).not.toMatch(/✓ acceptance-oracles/);
});

test("test: a runner listing that fails makes the doctor row report fail and carry the runner's own first error line; a row that treats an unavailable listing as nothing to audit reports pass on no evidence and fails", async () => {
  const repo = preflightRepo([{ oracle: "test", test: "unavailable oracle" }]);
  const output = await doctor(["--"], repo, [adapter], {
    banner: false,
    listTests: async () => ({ status: "failed", error: "runner unavailable\nsecondary detail" }),
  });

  expect(output).toMatch(/✗ acceptance-oracles\s+runner listing failed — runner unavailable/);
  expect(output).not.toMatch(/✓ acceptance-oracles/);
  expect(output).not.toContain("secondary detail");
});

test("test: a task naming a tracked path that is clean at HEAD produces no input finding at all, while the same path modified in the working tree produces exactly one finding of warn severity; a preflight that cannot separate those two outcomes cannot tell a legal input from a divergent one and fails", async () => {
  const repo = preflightRepo(
    ["plain criterion"],
    ["src/tracked.ts"],
    { "src/tracked.ts": "export const value = 1;\n" },
  );

  const clean = await plan([], repo, [adapter]);
  writeFileSync(join(repo, "src/tracked.ts"), "export const value = 2;\n");
  const dirty = await plan([], repo, [adapter]);

  expect(clean).not.toContain("input warnings:");
  expect(clean).not.toContain("pre-dispatch refusal");
  expect(clean).not.toContain('tracked path "src/tracked.ts" differs from HEAD');
  expect(dirty).not.toContain("pre-dispatch refusal");
  expect(dirty.match(/input warnings:/g)).toHaveLength(1);
  expect(dirty.match(/tracked path "src\/tracked\.ts" differs from HEAD/g)).toHaveLength(1);
});

test("test: a task naming an untracked path produces exactly one finding of refuse severity; the plan refuses on it; the warn case does not refuse; a preflight whose enumerated warn outcome shares refuse's behaviour fails", async () => {
  const untrackedRepo = preflightRepo(["plain criterion"], ["src/local-only.ts"]);
  mkdirSync(join(untrackedRepo, "src"), { recursive: true });
  writeFileSync(join(untrackedRepo, "src/local-only.ts"), "export const local = true;\n");
  const untracked = await plan([], untrackedRepo, [adapter]);

  const dirtyRepo = preflightRepo(
    ["plain criterion"],
    ["src/tracked.ts"],
    { "src/tracked.ts": "export const value = 1;\n" },
  );
  writeFileSync(join(dirtyRepo, "src/tracked.ts"), "export const value = 2;\n");
  const dirty = await plan([], dirtyRepo, [adapter]);

  expect(untracked.match(/pre-dispatch refusal/g)).toHaveLength(1);
  expect(untracked.match(/task path "src\/local-only\.ts" exists in the working tree but no commit holds it/g)).toHaveLength(1);
  expect(untracked).not.toContain("input warnings:");
  expect(dirty).not.toContain("pre-dispatch refusal");
  expect(dirty.match(/input warnings:/g)).toHaveLength(1);
  expect(dirty.match(/tracked path "src\/tracked\.ts" differs from HEAD/g)).toHaveLength(1);
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
