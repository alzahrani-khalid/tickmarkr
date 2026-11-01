// v2.8.4 T1 (D-2008): coverage converts V8 output through the AST (`experimentalAstAwareRemapping`), so a sharded merge
// counts every branch as the serial run does. The option is experimental, so vitest and @vitest/coverage-v8 are pinned
// to exactly 3.2.7 everywhere they are declared or resolved. The resolution is read from a REAL Vitest run of the
// production configuration in a scratch tree (the whole src/ and scripts/, the real config and setup file), through a
// reporter that records what the running Vitest resolved at init.
import { copyFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, test } from "vitest";
import { ownedFailures, runOwned } from "../helpers/owned-process.js";

const ROOT = join(import.meta.dirname, "../..");
const PINNED = "3.2.7";
const NAMES = ["vitest", "@vitest/coverage-v8"] as const;

// what the running Vitest resolved — its own version, the coverage provider it loaded and the resolved coverage options —
// then that the probe ran and the provider produced a coverage map
const RESOLVED_REPORTER = `import { writeFileSync } from "node:fs";
export default class {
  record = {};
  write(fields) {
    Object.assign(this.record, fields);
    writeFileSync(process.env.COVERAGE_RESOLVED, JSON.stringify(this.record));
  }
  onInit(ctx) {
    const provider = ctx.coverageProvider;
    this.write({
      vitest: ctx.version, provider: provider?.name, providerVersion: provider?.version,
      remapping: provider?.options?.experimentalAstAwareRemapping,
      resolved: { provider: ctx.config.coverage.provider, enabled: ctx.config.coverage.enabled,
        remapping: ctx.config.coverage.experimentalAstAwareRemapping, reporter: ctx.config.coverage.reporter.map(([name]) => name) },
    });
  }
  onTestRunEnd(modules) {
    this.write({ ran: modules.map((module) => [module.moduleId.slice(module.moduleId.lastIndexOf("/tests/") + 1), module.state()]) });
  }
  onCoverage(coverage) {
    this.write({ coveredFiles: coverage.files().length });
  }
}
`;

type Resolved = {
  vitest: string; provider: string; providerVersion: string; remapping: unknown;
  resolved: { provider: string; enabled: boolean; remapping: unknown; reporter: string[] };
  ran: [string, string][]; coveredFiles: number;
};

async function resolvedIn(layout: "local" | "ci"): Promise<Resolved> {
  const tree = mkdtempSync(join(tmpdir(), `tickmarkr-coverage-${layout}-`));
  try {
    for (const directory of ["src", "scripts"]) cpSync(join(ROOT, directory), join(tree, directory), { recursive: true });
    for (const file of ["package.json", "tsconfig.json", "vitest.config.ts", "tests/setup.ts", "tests/helpers/tmprepo.ts"]) {
      mkdirSync(dirname(join(tree, file)), { recursive: true });
      copyFileSync(join(ROOT, file), join(tree, file));
    }
    symlinkSync(join(ROOT, "node_modules"), join(tree, "node_modules"), "dir");
    mkdirSync(join(tree, "tests/probe"), { recursive: true });
    writeFileSync(join(tree, "tests/probe/probe.test.ts"), 'import { test } from "vitest";\ntest("probe", () => {});\n');
    writeFileSync(join(tree, "resolved-reporter.mjs"), RESOLVED_REPORTER);
    const record = join(tree, "resolved.json");
    const env: NodeJS.ProcessEnv = { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0", COVERAGE_RESOLVED: record };
    for (const key of ["TICKMARKR_CI_LEAN_REPORTERS", "VITEST_MAX_FORKS", "TICKMARKR_CI_RECORD", "TICKMARKR_CI_COVERAGE_BLOB"]) delete env[key];
    if (layout === "ci") env.TICKMARKR_CI_LEAN_REPORTERS = "1";
    // the probe covers no floored file, so the production floors red the run; the record is written at init either way
    const run = await runOwned(process.execPath, [join(ROOT, "node_modules/vitest/vitest.mjs"), "run", "--configLoader", "runner",
      "--config", "vitest.config.ts", "--reporter", "./resolved-reporter.mjs", "--coverage", "tests/probe/probe.test.ts"], { cwd: tree, env, ms: 120_000 });
    const failures = ownedFailures(run, `vitest ${layout}`);
    if (failures.length > 0) throw new Error(`${failures.join("; ")}\n${run.out}\n${run.err}`);
    return JSON.parse(readFileSync(record, "utf8")) as Resolved;
  } finally {
    rmSync(tree, { recursive: true, force: true });
  }
}

type Declarations = Partial<Record<"dependencies" | "devDependencies" | "peerDependencies" | "optionalDependencies", Record<string, string>>>;
const DECLARATION_KEYS = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"] as const;

describe("coverage remapping and its pinned Vitest", () => {
  test("test: a real Vitest run of the production configuration resolves coverage on the v8 provider with AST-aware remapping enabled in both the local and the CI-guard layouts, and vitest and its v8 coverage provider are exactly version 3.2.7 in package.json, in both lockfile root declarations, in both resolved lockfile entries and as the packages that run, so a configuration without the option, a range declaration or any other version anywhere fails", { timeout: 300_000 }, async () => {
    const local = await resolvedIn("local");
    const ci = await resolvedIn("ci");
    for (const [layout, run] of [["local", local], ["ci", ci]] as const) {
      expect([run.provider, run.remapping, run.resolved.provider, run.resolved.enabled, run.resolved.remapping], layout)
        .toEqual(["v8", true, "v8", true, true]);
      expect([run.vitest, run.providerVersion], `${layout}: the packages that run`).toEqual([PINNED, PINNED]);
      expect(run.ran, `${layout}: the probe ran`).toEqual([["tests/probe/probe.test.ts", "passed"]]);
      expect(run.coveredFiles, `${layout}: the provider produced a coverage map`).toBeGreaterThan(0);
    }
    // the two layouts are really two: the CI guard writes json-summary alone, the local layout its full reporters
    expect(ci.resolved.reporter).toEqual(["json-summary"]);
    expect(local.resolved.reporter).not.toEqual(["json-summary"]);

    const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as Declarations;
    const lock = JSON.parse(readFileSync(join(ROOT, "package-lock.json"), "utf8")) as { packages: Record<string, Declarations & { version?: string }> };
    for (const name of NAMES) {
      expect(pkg.devDependencies?.[name], `package.json ${name}`).toBe(PINNED);
      expect(lock.packages[""]!.devDependencies?.[name], `lockfile root ${name}`).toBe(PINNED);
      expect(lock.packages[`node_modules/${name}`]?.version, `lockfile entry ${name}`).toBe(PINNED);
    }
    // anywhere: every resolved entry of either package and every declaration of either name, in package.json and in
    // every lockfile entry, is exactly the pin — a nested copy or a range left behind fails
    const entries = Object.entries(lock.packages).filter(([key]) => NAMES.some((name) => key.endsWith(`node_modules/${name}`)));
    expect(entries.map(([key, entry]) => `${key}@${entry.version}`).sort()).toEqual(NAMES.map((name) => `node_modules/${name}@${PINNED}`).sort());
    const declarations = [["package.json", pkg] as const, ...Object.entries(lock.packages)].flatMap(([where, entry]) =>
      DECLARATION_KEYS.flatMap((key) => NAMES.filter((name) => entry[key]?.[name] !== undefined).map((name) => [where, key, name, entry[key]![name]])));
    expect(declarations.length, "package.json, the lockfile root and the provider's peer declaration").toBeGreaterThanOrEqual(5);
    expect(declarations.filter(([, , , version]) => version !== PINNED)).toEqual([]);
  });
});
