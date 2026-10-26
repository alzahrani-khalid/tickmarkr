import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { stringify } from "yaml";
import { expect, test, vi } from "vitest";
import { approve } from "../../src/cli/commands/approve.js";
import * as gates from "../../src/gates/run-gates.js";
import { graphDefinitionHash, loadGraph } from "../../src/graph/graph.js";
import { GATE_NAMES } from "../../src/graph/schema.js";
import { runDaemon } from "../../src/run/daemon.js";
import { createWorktree, gitHead } from "../../src/run/git.js";
import { Journal, pendingRepairFindings } from "../../src/run/journal.js";
import { COMMIT, setupRepo, T } from "../helpers/tmprepo.js";

async function postWaiveRed(kind: "test" | "lint" | "outside" | "review" | "infra" | "build") {
  const location = kind === "outside" ? "outside.test.ts" : "inside.test.ts";
  const failingGate = kind === "lint" || kind === "build" ? kind : "test";
  const red = kind === "infra" ? "Error: spawn EAGAIN" : `FAIL ${location} > guards\nAssertionError: expected ready to be true`;
  const commands = { build: "true", test: "true", lint: "true",
    ...(kind === "review" ? {} : { [failingGate]: `if test -f work.ts && ! grep -q repaired work.ts; then printf '%s\\n' '${red}'; exit 1; fi` }),
  };
  const { repo, fake } = setupRepo([T("T1", {
    complexity: 8, files: ["work.ts", "inside.test.ts"], gates: [...GATE_NAMES],
    acceptance: [{ oracle: "command", command: "true" }],
  })], {
    review: { approve: kind !== "review", issues: kind === "review" ? ["work.ts: guard still missing"] : [] },
    tasks: { T1: [{ shell: `echo 'export const repaired = true;' > work.ts && ${COMMIT} repaired`, result: { ok: true, summary: "repaired guard" } }] },
  }, stringify({ gates: commands }));
  const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" });
  for (const name of ["inside.test.ts", "outside.test.ts"]) writeFileSync(join(repo, name), "// scripted detection site\n");
  git(repo, "add", "inside.test.ts", "outside.test.ts");
  git(repo, "commit", "--no-gpg-sign", "-m", "detection sites");
  const baseRef = await gitHead(repo);
  const runId = `run-post-waive-${kind}`;
  const branch = `tickmarkr/${runId}`;
  git(repo, "branch", branch, baseRef);
  const wt = await createWorktree(repo, `${branch}--T1`, baseRef);
  writeFileSync(join(wt, "work.ts"), "export const ready = false;\n");
  git(wt, "add", "work.ts");
  git(wt, "commit", "--no-gpg-sign", "-m", "landed work");
  const subject = createHash("sha256").update(git(wt, "log", "--reverse",
    "--format=%T%x00%an%x00%ae%x00%cn%x00%ce%x00%B%x1e", `${baseRef}..HEAD`)).digest("hex");
  const journal = Journal.create(repo, runId);
  journal.append("run-start", undefined, { baseRef, branch, commands, graphDefinitionHash: graphDefinitionHash(loadGraph(repo)) });
  // The live loop funds a repair before its review-round cap parks. That intent never launched.
  for (let attempt = 0; attempt < 2; attempt++) {
    journal.append("task-dispatch", "T1", { assignment: { adapter: "fake", model: "fake-1", channel: "sub", tier: "frontier" }, attempt });
    journal.append("worker-launch", "T1", { attempt });
    journal.append("worker-result", "T1", { ok: true, summary: "landed", deviations: [] });
    journal.phaseStart("T1", "gates");
    journal.append("gate-result", "T1", { gate: "review", pass: false, commit: subject, details: "guard missing" });
    journal.append("repair-attempt", "T1", { repair: attempt + 1, gates: ["review"], findings: "review: guard missing" });
  }
  // A different gate's waive leaves review in the suffix, exercising the post-waive review park.
  const waived = kind === "review" ? "scope" : "review";
  if (waived === "scope") journal.append("gate-result", "T1", { gate: waived, pass: false, commit: subject, details: "scope disputed" });
  journal.append("task-human", "T1", { kind: "gate-fail", reason: "review round cap (2) reached this engagement" });
  expect(pendingRepairFindings(journal.read(), "T1")).toBe("review: guard missing");
  await approve([runId, "T1", "--waive"], repo);
  expect(pendingRepairFindings(journal.read(), "T1")).toBeUndefined();
  writeFileSync(join(journal.dir, "baseline.json"), JSON.stringify({
    commands: Object.fromEntries(Object.keys(commands).map((name) => [name, { exitCode: 0, fingerprints: [] }])),
  }));
  const original = gates.runGates;
  // The shell supplies the real assertion; inject only the manifest's complete file attribution.
  // This avoids running a nested Vitest suite to exercise the daemon's outside-scope decision.
  const spy = vi.spyOn(gates, "runGates").mockImplementation((task, ctx, ...rest) => original(task, {
    ...ctx, onGate: async (e) => {
      if (e.phase === "end" && e.result.gate === "test" && !e.result.pass && kind !== "infra") {
        e.result.meta = { ...e.result.meta, classification: "regression", failingFiles: [location], fullSuite: true };
        e.result.details += "\nclassification: regression; runner-level diagnostic: never-started 0; reporter errors 0; runner vitest";
      }
      await ctx.onGate?.(e);
    },
  }, ...rest));
  const before = journal.read().length;
  try {
    const summary = await runDaemon(repo, { adapters: [fake], runId, resume: true });
    return { summary, events: journal.read().slice(before).filter((e) => e.taskId === "T1"), journal, subject };
  } finally { spy.mockRestore(); }
}

test("test: after a review-round-cap park that funded a repair it never launched and a review waive, the production daemon funds the ordinary repair for a worker test red on the same commit, while a post-waive red wholly outside the declared files parks out of scope and a post-waive review red keeps its park, so offering only waive or recheck fails", async () => {
  for (const kind of ["test", "lint", "outside", "review", "infra", "build"] as const) {
    const { summary, events, journal, subject } = await postWaiveRed(kind);
    const funded = events.filter((e) => e.event === "repair-attempt");
    const dispatches = events.filter((e) => e.event === "task-dispatch");
    const park = events.find((e) => e.event === "task-human");
    if (kind === "test" || kind === "lint") {
      expect(summary.done, kind).toEqual(["T1"]);
      expect(park, kind).toBeUndefined();
      expect(funded, kind).toHaveLength(1);
      expect(funded[0]!.data).toMatchObject({ repair: 1, charge: 1, gates: [kind], commits: 1 });
      expect(dispatches, kind).toHaveLength(1);
      expect(dispatches[0]!.data.retryMode).toBe("repair");
      const red = events.find((e) => e.event === "gate-result" && e.data.gate === kind && e.data.pass === false)!;
      expect(red.data.commit).toBe(subject);
      const prompt = readFileSync(join(journal.dir, "prompts", "T1-a2.md"), "utf8");
      expect(prompt).toContain("AssertionError");
      expect(prompt).toContain("inside.test.ts");
    } else {
      expect(summary.human, `${kind}: ${JSON.stringify(events.filter((e) => ["task-failed", "task-human", "repair-attempt"].includes(e.event)))}`).toEqual(["T1"]);
      expect(funded, kind).toEqual([]);
      expect(dispatches, kind).toEqual([]);
      expect(park?.data.kind).toBe(kind === "infra" ? "infra" : "gate-fail");
      if (kind === "outside") expect(park?.data.reason).toContain("outside files[]");
      if (kind === "review" || kind === "build") expect(park?.data.reason).toContain("post-approval gate failed");
    }
  }
}, 240_000);
