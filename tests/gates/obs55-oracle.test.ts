import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { describe, expect, test } from "vitest";
import { FakeAdapter } from "../../src/adapters/fake.js";
import { acceptanceGate, testFiltered } from "../../src/gates/acceptance.js";
import { validateGraph } from "../../src/graph/schema.js";
import { makeRepo } from "../helpers/tmprepo.js";

function noCall(): FakeAdapter {
  const dir = mkdtempSync(join(tmpdir(), "tickmarkr-judge-"));
  const p = join(dir, "s.json");
  writeFileSync(p, JSON.stringify({ tasks: {}, judge: "DEFINITELY NOT JSON" }));
  return new FakeAdapter(p);
}

const repoRoot = process.cwd();
const base = execSync("git rev-parse HEAD", { cwd: repoRoot, encoding: "utf8" }).trim();

// ponytail: dedicated passing name so acceptance oracles can pin a real vitest match without touching the full suite.
describe("OBS-55 oracle fixtures", () => {
  test("OBS55_MATCH_PASS — oracle fixture passing", () => {
    expect(true).toBe(true);
  });
});

// OBS-62: criterion strings with regex metachars must match verbatim-titled tests once escaped.
describe("OBS-62 oracle fixtures", () => {
  test("init points at existing specs when specs/*.spec.md already exist", () => {
    expect(true).toBe(true);
  });
});

const oracleTask = (testName: string) => validateGraph({
  version: 1, spec: { source: "prd", paths: ["p"], hash: "h" },
  tasks: [{ id: "T1", title: "t", goal: "g", shape: "implement", complexity: 3,
    acceptance: [{ oracle: "test", test: testName }] }],
}).tasks[0];

// vitest-shaped stdout stubs for tmp-repo tests that lack a real runner
const stubRan = (summary: string) => `bash -c 'printf "%s\\n" "${summary}"'`;
const stubFail = (summary: string) => `bash -c 'printf "%s\\n" "${summary}" >&2; exit 1'`;

// real-runner tests pin the nested vitest to THIS file: `npm test` alone collects all 114
// suite files (~19s on 18 cores, >20s vitest cap on 2-core CI — OBS-59). One file keeps the
// runner real, exercises `--` composition, and cannot recurse (the -t filter skips these
// async tests in the nested run).
const oneFileCmd = "npm test -- --configLoader runner tests/gates/obs55-oracle.test.ts";

describe("OBS-55 — test oracle match verification", () => {
  test("a test oracle whose name filter matches zero tests fails closed even when the runner exits 0", async () => {
    const filter = "OBS55_ZERO_MATCH_UNIQUE_NAME";
    const r = await acceptanceGate(
      oracleTask(filter),
      repoRoot, base, { adapter: noCall(), model: "fake-1" }, undefined, { testCmd: oneFileCmd },
    );
    expect(r.pass).toBe(false);
    expect(r.details).toMatch(/matched zero tests/i);
  }, 60_000);

  test("the zero-match failure message names the test filter that matched nothing", async () => {
    const filter = "OBS55_ZERO_MATCH_UNIQUE_NAME";
    const r = await acceptanceGate(
      oracleTask(filter),
      repoRoot, base, { adapter: noCall(), model: "fake-1" }, undefined, { testCmd: oneFileCmd },
    );
    expect(r.pass).toBe(false);
    expect(r.details).toContain(filter);
  }, 60_000);

  test("a test oracle with a matching passing test still passes", async () => {
    const r = await acceptanceGate(
      oracleTask("OBS55_MATCH_PASS"),
      repoRoot, base, { adapter: noCall(), model: "fake-1" }, undefined, { testCmd: oneFileCmd },
    );
    expect(r.pass).toBe(true);
    expect(r.details).toContain("OBS55_MATCH_PASS");
  }, 60_000);

  test("a test oracle with a matching failing test still fails", async () => {
    const repo = makeRepo({ "x.txt": "x\n" });
    const b = execSync("git rev-parse HEAD", { cwd: repo, encoding: "utf8" }).trim();
    const name = "OBS55_MATCH_FAIL";
    const r = await acceptanceGate(
      oracleTask(name),
      repo, b, { adapter: noCall(), model: "fake-1" }, undefined,
      { testCmd: stubFail("      Tests  1 failed | 0 skipped (1)") },
    );
    expect(r.pass).toBe(false);
    expect(r.details).toContain(name);
    expect(r.details).toMatch(/exit/);
  });

  test("testFiltered composes a base command already containing `--` without dropping the name filter", () => {
    const cmd = testFiltered("npm test -- --maxWorkers=6", "OBS55_MATCH_PASS");
    expect(cmd).toBe("npm test -- --maxWorkers=6 -t 'OBS55_MATCH_PASS'");
    expect(cmd).not.toMatch(/\s--\s-t\b/);
  });

  test("no code path lets a zero-matched test run count as an oracle pass", async () => {
    const repo = makeRepo({ "x.txt": "x\n" });
    const b = execSync("git rev-parse HEAD", { cwd: repo, encoding: "utf8" }).trim();
    const r = await acceptanceGate(
      oracleTask("nothing"),
      repo, b, { adapter: noCall(), model: "fake-1" }, undefined,
      { testCmd: stubRan("      Tests  0 passed | 99 skipped (99)") },
    );
    expect(r.pass).toBe(false);
    expect(r.details).toMatch(/matched zero tests/i);
  });
});

// OBS-62: escape regex metachars in -t filters so verbatim-titled tests match; zero-match stays fail-closed.
describe("OBS-62 — test oracle regex escaping", () => {
  const metacharCriterion = "init points at existing specs when specs/*.spec.md already exist";
  const metacharZeroMatch = "no test named specs/*.spec.md [unique-zm]";

  test("a criterion containing regex metachars matches its verbatim titled test", async () => {
    const r = await acceptanceGate(
      oracleTask(metacharCriterion),
      repoRoot, base, { adapter: noCall(), model: "fake-1" }, undefined, { testCmd: oneFileCmd },
    );
    expect(r.pass).toBe(true);
    expect(r.details).toContain(metacharCriterion);
  }, 60_000);

  test("a criterion containing regex metachars that matches no test still fails closed", async () => {
    const r = await acceptanceGate(
      oracleTask(metacharZeroMatch),
      repoRoot, base, { adapter: noCall(), model: "fake-1" }, undefined, { testCmd: oneFileCmd },
    );
    expect(r.pass).toBe(false);
    expect(r.details).toMatch(/matched zero tests/i);
    expect(r.details).toContain(metacharZeroMatch);
  }, 60_000);

  test("testFiltered regex-escapes metachars in the -t pattern", () => {
    const cmd = testFiltered("npm test", metacharCriterion);
    expect(cmd).toContain(String.raw`specs/\*\.spec\.md`);
  });
});
