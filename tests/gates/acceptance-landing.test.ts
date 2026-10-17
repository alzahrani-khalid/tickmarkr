import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { FakeAdapter } from "../../src/adapters/fake.js";
import { shq } from "../../src/adapters/types.js";
import { acceptanceGate, testFilterPattern } from "../../src/gates/acceptance.js";
import { validateGraph } from "../../src/graph/schema.js";
import { makeRepo } from "../helpers/tmprepo.js";

// Queue row 179 (D-2018, D-2019): a test criterion's declared suite file is the only file that can satisfy it.

const install = join(process.cwd(), "node_modules");
const TITLE = "greets the landed caller";
// npm separators read as shell words: a quoted or escaped `--` already is one, a ` -- ` inside an assignment's value is not
const SEPARATORS = ['npm test "--"', "npm test '--'", "npm test \\--", "LABEL=' -- ' npm test"];
const WRAPPERS = ["npm test --", "npx vitest run --globals --configLoader runner", "CI=1 npm test", '"npm" test', "LABEL=hello\\ world npm test", ...SEPARATORS];
const passing = (title: string) => `test(${JSON.stringify(title)}, () => expect(1).toBe(1));\n`;

// judge would fail closed IF consulted: every criterion here is deterministic, so it never is.
function noCall(): FakeAdapter {
  const dir = mkdtempSync(join(tmpdir(), "tickmarkr-judge-"));
  writeFileSync(join(dir, "s.json"), JSON.stringify({ tasks: {}, judge: "DEFINITELY NOT JSON" }));
  return new FakeAdapter(join(dir, "s.json"));
}

function gate(repo: string, testCmd: string, title: string, landing?: string) {
  const task = validateGraph({
    version: 1, spec: { source: "native", paths: ["spec.md"], hash: "h" },
    tasks: [{ id: "T1", title: "t", goal: "g", shape: "implement", complexity: 3,
      acceptance: [{ oracle: "test", test: title, ...(landing ? { landing } : {}) }] }],
  }).tasks[0]!;
  return acceptanceGate(task, repo, "HEAD", { adapter: noCall(), model: "fake-1" }, undefined, { testCmd });
}

/** A real Vitest repository; its config appends to started.receipt each time the runner loads it, so a case
 * can prove the runner did, or never did, start. The runner loader keeps Vite from bundling the config into
 * the shared (symlinked) node_modules. */
function realRepo(files: Record<string, string>) {
  const repo = makeRepo({
    ".gitignore": "node_modules/\n*.receipt\n",
    "package.json": JSON.stringify({ type: "module", scripts: { test: "vitest run --globals --configLoader runner" } }),
    "vitest.config.mjs": 'import { appendFileSync } from "node:fs";\nappendFileSync(process.cwd() + "/started.receipt", "started\\n");\nexport default {};\n',
    ...files,
  });
  symlinkSync(install, join(repo, "node_modules"), "dir");
  const receipt = join(repo, "started.receipt");
  return { repo, started: () => existsSync(receipt), reset: () => rmSync(receipt, { force: true }) };
}

/** A stand-in `vitest` that records its argv, prints a passing count, exits 0 and writes the per-file report
 * the case names (or none); `script` is the package.json test script that reaches it. */
function stubRepo(script = "vitest run --globals") {
  const repo = makeRepo({
    ".gitignore": "node_modules/\n*.receipt\nmode\n",
    "package.json": JSON.stringify({ scripts: { test: script } }),
    "tests/a.test.ts": passing(TITLE),
  });
  const receipt = join(repo, "started.receipt");
  mkdirSync(join(repo, "node_modules/.bin"), { recursive: true });
  writeFileSync(join(repo, "node_modules/.bin/vitest"), `#!/usr/bin/env node
const fs = require('fs');
fs.writeFileSync(${JSON.stringify(receipt)}, JSON.stringify(process.argv.slice(2)));
const mode = fs.readFileSync(${JSON.stringify(join(repo, "mode"))}, 'utf8').trim();
const file = 'tests/a.test.ts', now = Date.now();
const report = { nonce: mode === 'stale' ? 'another-invocation' : process.env.TICKMARKR_TEST_NONCE, requested: [file],
  started: { [file]: now }, completed: { [file]: { at: now, status: 'passed', failures: [], tests: { passed: 1, failed: 0, skipped: 0 } } },
  certificate: { at: now, exitCode: 0, errors: 0, diagnostics: [] } };
if (mode === 'uncertified') delete report.certificate;
if (mode !== 'missing' && process.env.TICKMARKR_TEST_REPORT) fs.writeFileSync(process.env.TICKMARKR_TEST_REPORT, JSON.stringify(report));
console.log(' Test Files  1 passed (1)\\n      Tests  1 passed (1)');
`);
  chmodSync(join(repo, "node_modules/.bin/vitest"), 0o755);
  return {
    repo,
    mode: (m: string) => { rmSync(receipt, { force: true }); writeFileSync(join(repo, "mode"), m); },
    argv: (): string[] | undefined => existsSync(receipt) ? JSON.parse(readFileSync(receipt, "utf8")) : undefined,
  };
}

describe("acceptance test oracle with a declared suite file (queue row 179)", () => {
  test("an acceptance test criterion whose suite file holds its passing test passes through a real Vitest run of that file and names the file on its passing line, while the same criterion fails as a work verdict naming the suite file, without the test command ever starting, when the suite file is absent from the worktree or is a directory, and fails when the suite file exists without that title although another test file holds a passing test of exactly that title, so an oracle that selects the title across the whole suite or checks only that the path exists fails", async () => {
    const f = realRepo({ "tests/a.test.ts": passing(TITLE), "tests/b.test.ts": passing("another title") });

    const green = await gate(f.repo, "npm test", TITLE, "tests/a.test.ts");
    expect(green.pass).toBe(true);
    expect(green.details).toContain(`✓ test: ${TITLE} (exit 0) in tests/a.test.ts`);
    expect(f.started()).toBe(true); // the start detector fires on a real run

    // the file, the filter and the reporter all reach the runner whatever the wrapper: a trailing `--` is not
    // doubled, npx gets no npm-script `--`, and an npm script behind an assignment — escaped or not — or under a
    // quoted manager word still gets its one `--`
    for (const cmd of WRAPPERS) {
      const wrapped = await gate(f.repo, cmd, TITLE, "tests/a.test.ts");
      expect({ cmd, ...wrapped }).toMatchObject({ cmd, pass: true });
      expect(wrapped.details).toContain(`✓ test: ${TITLE} (exit 0) in tests/a.test.ts`);
    }

    f.reset();
    const absent = await gate(f.repo, "npm test", TITLE, "tests/missing.test.ts");
    expect(absent.pass).toBe(false);
    expect(absent.details).toContain("tests/missing.test.ts");
    expect(absent.details).toContain("never started");
    expect(absent.meta?.infra).not.toBe(true);
    expect(f.started()).toBe(false);

    mkdirSync(join(f.repo, "tests/dir.test.ts"));
    const directory = await gate(f.repo, "npm test", TITLE, "tests/dir.test.ts");
    expect(directory.pass).toBe(false);
    expect(directory.details).toContain("tests/dir.test.ts");
    expect(directory.details).toContain("not a regular file");
    expect(directory.meta?.infra).not.toBe(true);
    expect(f.started()).toBe(false);
    rmSync(join(f.repo, "tests/dir.test.ts"), { recursive: true });

    // the title exists elsewhere: a whole-suite selection finds it, the suite file does not hold it
    const suiteWide = await gate(f.repo, "npm test", TITLE);
    expect(suiteWide.pass).toBe(true);
    const elsewhere = await gate(f.repo, "npm test", TITLE, "tests/b.test.ts");
    expect(elsewhere.pass).toBe(false);
    expect(elsewhere.details).toContain("no passing test of that title in tests/b.test.ts");
    expect(elsewhere.meta?.infra).not.toBe(true);
  }, 120_000);

  test("a passing test of the criterion's exact title in a file whose path ends with the suite file's path under a deeper directory never satisfies the criterion, whether or not the suite file also holds a passing test of it, because the runner's own per-file report must show a test body run in the suite file and in no other module, so an oracle that trusts the runner's file filter fails", async () => {
    const f = realRepo({ "tests/a.test.ts": passing(TITLE), "tests/deep/tests/a.test.ts": passing(TITLE) });

    const both = await gate(f.repo, "npm test", TITLE, "tests/a.test.ts");
    expect(both.pass).toBe(false);
    expect(both.details).toContain("outside tests/a.test.ts, in tests/deep/tests/a.test.ts");
    expect(both.meta?.infra).not.toBe(true);

    writeFileSync(join(f.repo, "tests/a.test.ts"), passing("another title"));
    const deeperOnly = await gate(f.repo, "npm test", TITLE, "tests/a.test.ts");
    expect(deeperOnly.pass).toBe(false);
    expect(deeperOnly.details).toContain("in tests/deep/tests/a.test.ts");
    expect(deeperOnly.meta?.infra).not.toBe(true);

    // the file filter still selects the deeper module, but no body of this title runs there: the suite file alone passes
    writeFileSync(join(f.repo, "tests/a.test.ts"), passing(TITLE));
    writeFileSync(join(f.repo, "tests/deep/tests/a.test.ts"), passing("another title"));
    const alone = await gate(f.repo, "npm test", TITLE, "tests/a.test.ts");
    expect(alone.pass).toBe(true);
    expect(alone.details).toContain("in tests/a.test.ts");

    // one deeper module in two projects: its body passes in the first, then — later, after a delay — skips in the
    // second, whose completion overwrites the first's counters; only the reporter's repeated-completion record is left
    const ran = join(f.repo, "deep-body.receipt");
    writeFileSync(join(f.repo, "vitest.config.mjs"), `export default { test: { projects: [
  { test: { name: "all", include: ["tests/**/*.test.ts"] } },
  { test: { name: "deep", include: ["tests/deep/**/*.test.ts"], env: { SKIP_DEEP: "1" } } },
] } };\n`);
    writeFileSync(join(f.repo, "tests/a.test.ts"), `import { expect, test } from "vitest";\n${passing(TITLE)}`);
    writeFileSync(join(f.repo, "tests/deep/tests/a.test.ts"), `import { appendFileSync } from "node:fs";
import { expect, test } from "vitest";
if (process.env.SKIP_DEEP) await new Promise((r) => setTimeout(r, 1500));
test.skipIf(process.env.SKIP_DEEP === "1")(${JSON.stringify(TITLE)}, () => { appendFileSync(${JSON.stringify(ran)}, "ran\\n"); expect(1).toBe(1); });
`);
    const projects = await gate(f.repo, "npm test", TITLE, "tests/a.test.ts");
    expect(existsSync(ran)).toBe(true); // the deeper body did execute
    expect(projects.pass).toBe(false);
    expect(projects.details).toContain("outside tests/a.test.ts, in tests/deep/tests/a.test.ts");
    expect(projects.meta?.infra).not.toBe(true);
  }, 120_000);

  test("a Vitest oracle run that exits zero and prints a passing count but whose per-file report is missing, carries another invocation's nonce or never reaches its run-end certificate fails closed as unverified, as does a script body the reporter cannot be forwarded to, so an oracle that falls back to the printed count fails", async () => {
    const s = stubRepo();
    s.mode("good");
    const certified = await gate(s.repo, "npm test", TITLE, "tests/a.test.ts");
    expect(certified.pass).toBe(true);
    // every wrapper spelling hands the runner the file ahead of the filter, then the reporter options
    for (const cmd of ["npm test", "npm test --", "npx vitest run --globals", "CI=1 npm test", '"npm" test', "LABEL=hello\\ world npm test", ...SEPARATORS]) {
      s.mode("good");
      expect({ cmd, ...(await gate(s.repo, cmd, TITLE, "tests/a.test.ts")) }).toMatchObject({ cmd, pass: true });
      const argv = s.argv() ?? [];
      expect({ cmd, argv: argv.slice(0, 5) }).toEqual({ cmd, argv: ["run", "--globals", "tests/a.test.ts", "-t", testFilterPattern(TITLE)] });
      expect(argv.slice(5).map((a) => a.split("=")[0])).toEqual(["--reporter", "--outputFile"]);
    }

    for (const mode of ["missing", "stale", "uncertified"]) {
      s.mode(mode);
      const r = await gate(s.repo, "npm test", TITLE, "tests/a.test.ts");
      expect(s.argv()).toBeDefined(); // it ran, exited 0 and printed its passing count
      expect(r.pass).toBe(false);
      expect(r.details).toContain("unverified, failing closed");
      expect(r.meta).toMatchObject({ infra: true, classification: "infra" });
    }
    // the printed count alone is what today's suite-wide selection reads, and it is there
    s.mode("missing");
    expect((await gate(s.repo, "npm test", TITLE)).pass).toBe(true);

    const compound = stubRepo("vitest run --globals && echo done");
    compound.mode("good");
    const unforwardable = await gate(compound.repo, "npm test", TITLE, "tests/a.test.ts");
    expect(unforwardable.pass).toBe(false);
    expect(unforwardable.details).toContain("reporter cannot be forwarded");
    expect(unforwardable.details).toContain("unverified, failing closed");
    expect(unforwardable.meta).toMatchObject({ infra: true });
    expect(compound.argv()).toBeUndefined();
  }, 120_000);

  test("a configured test command that is not a Vitest invocation receives the suite file as its file argument ahead of the title filter and passes on a positive run count, and fails as a work verdict without being started when the suite file is absent or is a directory, while a criterion that declares no suite file keeps selecting its title across the whole suite under either runner, so an oracle that drops the file argument, accepts a directory or refuses a suite-less criterion fails", async () => {
    const repo = makeRepo({ "tests/a.test.ts": "// any runner\n", "package.json": JSON.stringify({ scripts: { test: "node runner.cjs" } }) });
    const receipt = join(repo, "argv.receipt");
    const count = join(repo, "count.txt");
    writeFileSync(join(repo, "runner.cjs"), `const fs = require('fs');
fs.writeFileSync(${JSON.stringify(receipt)}, JSON.stringify(process.argv.slice(2)));
const n = fs.readFileSync(${JSON.stringify(count)}, 'utf8').trim();
console.log('      Tests  ' + n + ' passed (' + n + ')');
`);
    const cmd = `node ${shq(join(repo, "runner.cjs"))}`;
    const argv = (): string[] | undefined => existsSync(receipt) ? JSON.parse(readFileSync(receipt, "utf8")) : undefined;
    const run = async (landing?: string, n = "1", command = cmd) => {
      rmSync(receipt, { force: true });
      writeFileSync(count, n);
      return gate(repo, command, TITLE, landing);
    };
    const pattern = testFilterPattern(TITLE);

    const landed = await run("tests/a.test.ts");
    expect(landed.pass).toBe(true);
    expect(landed.details).toContain("in tests/a.test.ts");
    expect(argv()).toEqual(["tests/a.test.ts", "-t", pattern]);
    // an npm script reaches that runner with its one `--`, under a quoted manager word or an escaped assignment too
    for (const npm of ["npm test", '"npm" test', "LABEL=hello\\ world npm test", "npm test --", ...SEPARATORS]) {
      expect({ npm, ...(await run("tests/a.test.ts", "1", npm)) }).toMatchObject({ npm, pass: true });
      expect({ npm, argv: argv() }).toEqual({ npm, argv: ["tests/a.test.ts", "-t", pattern] });
    }
    const zero = await run("tests/a.test.ts", "0");
    expect(zero.pass).toBe(false);
    expect(zero.details).toContain("matched zero tests");

    const absent = await run("tests/missing.test.ts");
    expect(absent.pass).toBe(false);
    expect(absent.details).toContain("tests/missing.test.ts");
    expect(absent.meta?.infra).not.toBe(true);
    expect(argv()).toBeUndefined();

    mkdirSync(join(repo, "tests/dir.test.ts"));
    const directory = await run("tests/dir.test.ts");
    expect(directory.pass).toBe(false);
    expect(directory.details).toContain("tests/dir.test.ts");
    expect(directory.meta?.infra).not.toBe(true);
    expect(argv()).toBeUndefined();

    const suiteless = await run();
    expect(suiteless.pass).toBe(true);
    expect(argv()).toEqual(["-t", pattern]);

    const s = stubRepo();
    s.mode("missing");
    const vitestSuiteless = await gate(s.repo, "npm test", TITLE);
    expect(vitestSuiteless.pass).toBe(true);
    expect(s.argv()).toEqual(["run", "--globals", "-t", pattern]);
  }, 120_000);
});
