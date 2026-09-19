import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { compareToBaseline, resetCalmWindowForTests, setCalmWindowForTests, type Baseline } from "../../src/gates/baseline.js";
import { DEFAULT_CONFIG } from "../../src/config/config.js";
import { validateGraph } from "../../src/graph/schema.js";
import { runGates } from "../../src/gates/run-gates.js";
import { gitHead, shGitOk } from "../../src/run/git.js";
import type { ManifestGateOutcome } from "../../src/gates/test-manifest.js";
import { failureDisposition, reserveInfrastructureRetry, type VerificationRetryCause } from "../../src/run/recovery.js";
import type { JournalEvent } from "../../src/run/journal.js";
import { makeRepo } from "../helpers/tmprepo.js";

const manifest = vi.hoisted(() => ({ calls: 0, outcomes: [] as ManifestGateOutcome[] }));
vi.mock("../../src/gates/test-manifest.js", async (original) => {
  const actual = await original<typeof import("../../src/gates/test-manifest.js")>();
  return { ...actual, evaluateManifestedTest: async (...args: Parameters<typeof actual.evaluateManifestedTest>) => {
    if (!manifest.outcomes.length) return actual.evaluateManifestedTest(...args);
    return manifest.outcomes[Math.min(manifest.calls++, manifest.outcomes.length - 1)];
  } };
});
afterEach(() => { manifest.calls = 0; manifest.outcomes = []; });

beforeEach(() => setCalmWindowForTests({ loadProvider: () => 0 }));
afterEach(() => resetCalmWindowForTests());
const baseline: Baseline = { commands: { test: { exitCode: 0, fingerprints: [] } } };
function fixture(body: string) {
  const repo = makeRepo({ "run.sh": `echo run >> calls\n${body}\n` });
  const rows: JournalEvent[] = [];
  const append = (event: string, taskId: string, data: Record<string, unknown>) => rows.push({ event, taskId, data, ts: new Date().toISOString() });
  const authorize = (subject: string) => (cause: "infra" | "host-starved") =>
    reserveInfrastructureRetry(rows, "T1", subject, append, cause === "infra" ? "infrastructure" : "host-starved");
  const run = (subject: string, measured = baseline) => compareToBaseline(repo, { test: "bash run.sh" }, measured, ["test"], { authorizeRetry: authorize(subject) });
  return { repo, rows, run, count: () => readFileSync(join(repo, "calls"), "utf8").trim().split("\n").length };
}

test("transient EAGAIN reruns once and carries the absorbed retry receipt", async () => {
  const f = fixture('if [ "$(wc -l < calls)" -eq 1 ]; then echo "Error: spawn EAGAIN"; exit 1; fi\nexit 0');
  const [result] = await f.run("subject-a");
  expect(result.pass).toBe(true);
  expect(result.meta?.runnerInfraRerun).toMatchObject({ waitedMs: expect.any(Number) });
  expect(f.count()).toBe(2);
  expect(f.rows.filter((e) => e.event === "infra-retry-reserved")).toHaveLength(1);
});

const timeoutBody = 'sleep 0.03; printf "FAIL tests/a.test.ts > timeout\\nError: Test timed out in 20000ms.\\n"; exit 1';
const fastBaseline: Baseline = { commands: { test: { exitCode: 0, fingerprints: [], durationMs: 1 } } };

test.each(["", undefined, 42])("a malformed historical retry subject %j prevents new reservations", (subject) => {
  const rows: JournalEvent[] = [{ event: "infra-retry-reserved", taskId: "T1", ts: "2026-09-15T00:00:00Z",
    data: { subject, cause: "host-starved" } }];
  const append = vi.fn();
  expect(reserveInfrastructureRetry(rows, "T1", "new-subject", append)).toBe(false);
  expect(append).toHaveBeenCalledWith("infra-retry-denied", "T1", expect.objectContaining({ reason: "invalid-accounting" }));
});

test("persistent OBS-896 timeouts keep their behavioral disposition and share the infrastructure allowance across resume and causes", async () => {
  const f = fixture(timeoutBody);
  const [red] = await f.run("subject-a", fastBaseline);
  expect(f.count()).toBe(2);
  expect(red.meta?.hostStarvedRerun).toBeDefined();
  expect(failureDisposition(red)).toBe("behavioral");
  expect(f.rows[0].data.cause).toBe("host-starved");
  // Reconstructing the authorizer against the same journal cannot refill the subject budget,
  // even when the next failure uses the other recovery path.
  writeFileSync(join(f.repo, "run.sh"), 'echo run >> calls\necho "Error: spawn EAGAIN"; exit 1\n');
  await f.run("subject-a");
  expect(f.count()).toBe(3);
  await f.run("subject-b");
  expect(f.count()).toBe(5);
  await f.run("subject-c");
  expect(f.count()).toBe(6);
  expect(f.rows.filter(e => e.event === "infra-retry-reserved").map(e => e.data.cause))
    .toEqual(["host-starved", "infrastructure"]);
});

test("host-starved eligibility never extends to mixed assertions, normal-duration failures or unavailable calm admission", async () => {
  const mixed = fixture(timeoutBody.replace("exit 1", 'echo "AssertionError: expected 1 to be 2"; exit 1'));
  expect(failureDisposition((await mixed.run("subject", fastBaseline))[0])).toBe("behavioral");
  expect(mixed.count()).toBe(1);
  expect(mixed.rows).toEqual([]);
  const normal = fixture(timeoutBody);
  await normal.run("subject", { commands: { test: { exitCode: 0, fingerprints: [], durationMs: 100_000 } } });
  expect(normal.count()).toBe(1);
  expect(normal.rows).toEqual([]);
  setCalmWindowForTests({ loadProvider: () => 100, calmLoad: () => 1, maxWaitMs: 5, pollMs: 1 });
  const busy = fixture(timeoutBody);
  const [red] = await busy.run("subject", fastBaseline);
  expect(red.meta?.recoveryBlocked).toMatch(/calm window/);
  expect(failureDisposition(red)).toBe("behavioral");
  expect(busy.count()).toBe(1);
  expect(busy.rows).toEqual([]);
});

test("runGates preserves the existing eligible host-starved retry under bounded policy with its true cause", async () => {
  const repo = makeRepo({ ".gitignore": "calls\n.tickmarkr/\n", "run.sh":
    `echo run >> calls\nif [ "$(wc -l < calls)" -eq 1 ]; then ${timeoutBody}; fi\nexit 0\n` });
  const baseRef = await gitHead(repo);
  writeFileSync(join(repo, "work.txt"), "work\n");
  await shGitOk("git add -A && git commit --no-gpg-sign -m work", repo);
  const rows: JournalEvent[] = [];
  const authorization = vi.fn((subject: string, cause?: VerificationRetryCause) => reserveInfrastructureRetry(rows, "T1", subject,
    (event, taskId, data) => rows.push({ event, taskId, data, ts: new Date().toISOString() }), cause));
  const task = validateGraph({ version: 1, spec: { source: "prd", paths: ["p"], hash: "h" }, tasks: [
    { id: "T1", title: "t", goal: "g", shape: "implement", complexity: 3, acceptance: ["a"], files: ["**"],
      gates: ["build", "test", "lint", "evidence", "scope"] },
  ] }).tasks[0];
  const { results } = await runGates(task, {
    worktree: repo, baseRef, commands: { test: "bash run.sh" }, baseline: fastBaseline,
    author: { adapter: "fake", model: "fake-1", channel: "sub", tier: "frontier" }, channels: [], adapters: [],
    result: { ok: true, summary: "", deviations: [], raw: "" }, cfg: structuredClone(DEFAULT_CONFIG),
    authorizeInfraRetry: authorization,
  });
  expect(results.every(result => result.pass)).toBe(true);
  expect(authorization).toHaveBeenCalledExactlyOnceWith(expect.any(String), "host-starved");
  expect(rows.filter(e => e.event === "infra-retry-reserved")).toHaveLength(1);
  expect(rows[0].data.cause).toBe("host-starved");
  expect(readFileSync(join(repo, "calls"), "utf8").trim().split("\n")).toHaveLength(2);
});

test("persistent infrastructure stays red; rebuilt authorizers cannot refill one-subject or two-task allowances", async () => {
  const f = fixture('echo "Error: spawn EAGAIN"; exit 1');
  const [first] = await f.run("subject-a");
  expect(first.meta).toMatchObject({ classification: "infra", infra: true, runnerInfraRerun: expect.any(Object) });
  expect(f.count()).toBe(2);
  const [denied] = await f.run("subject-a");
  expect(denied.meta?.recoveryBlocked).toMatch(/allowance/);
  expect(f.count()).toBe(3);
  await f.run("subject-b");
  expect(f.count()).toBe(5);
  await f.run("subject-c");
  expect(f.count()).toBe(6);
  expect(f.rows.filter((e) => e.event === "infra-retry-reserved")).toHaveLength(2);
});

test("mixed concrete regression and EAGAIN never purchases an infrastructure retry", async () => {
  const f = fixture('echo "AssertionError: expected 1 to be 2"; echo "Error: spawn EAGAIN"; exit 1');
  const [result] = await f.run("subject-a");
  expect(result.pass).toBe(false);
  expect(result.meta?.classification).toBe("regression");
  expect(result.meta?.infra).not.toBe(true);
  expect(f.count()).toBe(1);
  expect(f.rows).toHaveLength(0);
});

test("unavailable calm window dispatches no retry and does not consume an execution reservation", async () => {
  setCalmWindowForTests({ loadProvider: () => 100, calmLoad: () => 1, maxWaitMs: 5, pollMs: 1 });
  const f = fixture('echo "Error: spawn EAGAIN"; exit 1');
  const [result] = await f.run("subject-a");
  expect(result.meta?.recoveryBlocked).toMatch(/calm window unavailable/);
  expect(f.count()).toBe(1);
  expect(f.rows.filter((e) => e.event === "infra-retry-reserved")).toHaveLength(0);
});


test.each(["allowed", "denied", "busy"])("manifest path records its report receipts and reserves only after calm readiness; outcome=%s", async (mode) => {
  const allow = mode === "allowed";
  if (mode === "busy") setCalmWindowForTests({ loadProvider: () => 100, calmLoad: () => 1, maxWaitMs: 5, pollMs: 1 });
  const repo = makeRepo({ "tests/a.test.ts": "export {};\n" });
  const baseRef = await gitHead(repo);
  writeFileSync(join(repo, "tests/a.test.ts"), "export const work = true;\n");
  await shGitOk("git add -A && git commit --no-gpg-sign -m work", repo);
  manifest.outcomes = [
    { pass: false, kind: "infra", details: "Error: spawn EAGAIN", classification: "infra", meta: { classification: "infra", infra: true }, exitCode: 1, reportPath: "/reports/first.json" },
    { pass: true, kind: "pass", details: "complete", meta: {}, exitCode: 0, reportPath: "/reports/final.json" },
  ];
  const authorization = vi.fn((_subject: string) => allow);
  const task = validateGraph({ version: 1, spec: { source: "prd", paths: ["p"], hash: "h" }, tasks: [
    { id: "T1", title: "t", goal: "g", shape: "implement", complexity: 3, acceptance: ["a"], gates: ["build", "test", "lint", "evidence", "scope"] },
  ] }).tasks[0];
  const { results } = await runGates(task, {
    worktree: repo, baseRef, commands: { test: "vitest run" }, baseline,
    author: { adapter: "fake", model: "fake-1", channel: "sub", tier: "frontier" }, channels: [], adapters: [],
    result: { ok: true, summary: "", deviations: [], raw: "" }, cfg: structuredClone(DEFAULT_CONFIG),
    authorizeInfraRetry: authorization,
  });
  expect(authorization).toHaveBeenCalledTimes(mode === "busy" ? 0 : 1);
  if (mode !== "busy") expect(authorization.mock.calls[0][0]).toEqual(expect.any(String));
  expect(manifest.calls).toBe(allow ? 2 : 1);
  const result = results.find((r) => r.gate === "test")!;
  expect(result.pass).toBe(allow);
  if (allow) expect(result.meta).toMatchObject({ reportPath: "/reports/final.json", runnerInfraRerun: { count: 1, waitedMs: expect.any(Number), firstReportPath: "/reports/first.json" } });
  else expect(result.meta).toMatchObject({ reportPath: "/reports/first.json", recoveryBlocked: expect.stringMatching(mode === "busy" ? /calm window/ : /allowance/) });
});
