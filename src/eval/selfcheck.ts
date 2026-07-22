import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_CONFIG } from "../config/config.js";
import { compileSource } from "../compile/index.js";
import { detectGateCommands } from "../gates/baseline.js";
import { testFiltered } from "../gates/acceptance.js";
import { renderAcceptanceItem, type AcceptanceItem, type Task } from "../graph/schema.js";
import { sh } from "../run/git.js";
import type { Fixture } from "./fixtures.js";

export interface SelfcheckRunResult {
  pass: boolean;
  details: string;
}

export interface SelfcheckResult {
  fixtureId: string;
  specPath: string;
  start: SelfcheckRunResult;
  solution: SelfcheckRunResult;
  valid: boolean;
  invalidReason?: string;
}

function findSpec(fixtureDir: string): string | undefined {
  const direct = join(fixtureDir, "spec.md");
  if (existsSync(direct)) return direct;
  for (const ent of readdirSync(fixtureDir, { withFileTypes: true })) {
    if (!ent.isFile()) continue;
    const { name } = ent;
    if (
      name.endsWith(".native.md") ||
      name.endsWith(".prd.md") ||
      name.endsWith(".spec.md") ||
      name === "tasks.md"
    ) {
      return join(fixtureDir, name);
    }
  }
  return undefined;
}

function isDeterministic(item: AcceptanceItem): item is
  | { oracle: "command"; command: string }
  | { oracle: "test"; test: string } {
  return typeof item === "object" && (item.oracle === "command" || item.oracle === "test");
}

// Mirrors the vitest/jest summary parser in src/gates/acceptance.ts so the selfcheck uses the same
// fail-closed rule for named-test oracles: exit 0 is vacuous if the name filter matched zero tests.
function testsRan(output: string): number | null {
  const lines = output.replace(/\x1b\[[\d;#]*[A-Za-z]/g, "").split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!.trim();
    const m = line.match(/^Tests\s+(.+?)\s*\(\d+\)\s*$/);
    if (!m) continue;
    let ran = 0;
    for (const chunk of m[1].split("|").map((s) => s.trim())) {
      const n = chunk.match(/^(\d+)\s+(passed|failed)\b/);
      if (n) ran += Number(n[1]);
    }
    return ran;
  }
  return null;
}

function tail(out: string, n = 8): string {
  const t = out.trim();
  if (!t) return "";
  return "\n" + t.split("\n").slice(-n).join("\n");
}

async function runDeterministicAcceptance(
  task: Task,
  cwd: string,
): Promise<SelfcheckRunResult> {
  const testCmd = detectGateCommands(cwd, DEFAULT_CONFIG).test;
  const passed: string[] = [];

  for (const item of task.acceptance) {
    if (!isDeterministic(item)) continue;

    if (item.oracle === "command") {
      const r = await sh(item.command, cwd);
      if (r.code !== 0) {
        return {
          pass: false,
          details: `oracle failed: ${renderAcceptanceItem(item)} (exit ${r.code})${tail(r.stderr || r.stdout)}`,
        };
      }
      passed.push(`✓ ${renderAcceptanceItem(item)} (exit 0)`);
    } else {
      if (!testCmd) {
        return {
          pass: false,
          details: `oracle failed: ${renderAcceptanceItem(item)} — no test command detected (failing closed)`,
        };
      }
      const r = await sh(testFiltered(testCmd, item.test), cwd);
      const out = (r.stderr || "") + "\n" + (r.stdout || "");
      if (r.code !== 0) {
        return {
          pass: false,
          details: `oracle failed: ${renderAcceptanceItem(item)} (exit ${r.code})${tail(r.stderr || r.stdout)}`,
        };
      }
      const ran = testsRan(out);
      if (ran === null || ran < 1) {
        return {
          pass: false,
          details: `oracle failed: ${renderAcceptanceItem(item)} — name filter matched zero tests (filter: ${item.test})${tail(out)}`,
        };
      }
      passed.push(`✓ ${renderAcceptanceItem(item)} (exit 0)`);
    }
  }

  return {
    pass: true,
    details: passed.length ? passed.join("\n") : "no deterministic acceptance oracles",
  };
}

/**
 * Run the fixture selfcheck: compile the fixture's own spec and run its deterministic acceptance
 * oracles (command/test) against both the starting tree and the reference solution tree.
 *
 * The fixture is valid only when the starting tree fails the acceptance check and the reference
 * solution tree passes the identical check — mechanizing the starting-state-must-fail principle
 * already applied to shell-runnable oracles.
 */
export async function runSelfcheck(fixture: Fixture): Promise<SelfcheckResult> {
  const specPath = findSpec(fixture.path);
  if (!specPath) {
    return {
      fixtureId: fixture.id,
      specPath: "",
      start: { pass: false, details: "no spec found" },
      solution: { pass: false, details: "no spec found" },
      valid: false,
      invalidReason: "fixture has no spec (expected spec.md or a recognized spec file)",
    };
  }

  let task: Task;
  try {
    const graph = compileSource(specPath);
    if (graph.tasks.length !== 1) {
      return {
        fixtureId: fixture.id,
        specPath,
        start: { pass: false, details: "spec has more than one task" },
        solution: { pass: false, details: "spec has more than one task" },
        valid: false,
        invalidReason: `fixture spec must contain exactly one task (found ${graph.tasks.length})`,
      };
    }
    task = graph.tasks[0]!;
    const runnable = task.acceptance.some(isDeterministic);
    if (!runnable) {
      return {
        fixtureId: fixture.id,
        specPath,
        start: { pass: false, details: "no deterministic oracles" },
        solution: { pass: false, details: "no deterministic oracles" },
        valid: false,
        invalidReason: "fixture has no shell-runnable acceptance oracle (command: or test:)",
      };
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      fixtureId: fixture.id,
      specPath,
      start: { pass: false, details: message },
      solution: { pass: false, details: message },
      valid: false,
      invalidReason: `fixture spec failed to compile: ${message}`,
    };
  }

  const start = await runDeterministicAcceptance(task, fixture.startDir);
  const solution = await runDeterministicAcceptance(task, fixture.solutionDir);

  let valid = true;
  let invalidReason: string | undefined;
  if (start.pass) {
    valid = false;
    invalidReason = "starting tree already passes the acceptance check";
  } else if (!solution.pass) {
    valid = false;
    invalidReason = "reference tree still fails the acceptance check";
  }

  return {
    fixtureId: fixture.id,
    specPath,
    start,
    solution,
    valid,
    invalidReason,
  };
}
