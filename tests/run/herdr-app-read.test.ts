import { afterAll, expect, test } from "vitest";
import { newestPark, permittedDecisionVerbs } from "../../src/cli/commands/approve.js";
import { HerdrAppDriver, OWNER_LABEL } from "../../src/drivers/herdr-app.js";
import { parseOwnedName } from "../../src/drivers/types.js";
import { runDaemon } from "../../src/run/daemon.js";
import { Journal } from "../../src/run/journal.js";
import { FakeHerdrApp } from "../helpers/fake-herdr-app.js";
import { COMMIT, makeTestTempDir, reapTestTempDirs, setupRepo, T } from "../helpers/tmprepo.js";

// Row 360; D-2184 add.19: the real app driver and JSON client consume an executable hc fake. Only the fake
// adapter runs; the fault is an exit-zero response cut inside its JSON string, not a CLI or verdict failure.
afterAll(() => reapTestTempDirs());

function readFault(f: FakeHerdrApp, role: "worker" | "judge" | "review", persistent: boolean) {
  let elapsed = 0;
  const app = new HerdrAppDriver({ hcBin: f.hc, appBin: f.app, env: { PATH: process.env.PATH }, pollMs: 20,
    time: { now: () => elapsed, sleep: async (ms) => { elapsed += ms; await new Promise((resolve) => setTimeout(resolve, 1)); } } });
  const run = app.run.bind(app);
  const faulted: string[] = [];
  app.run = async (slot, command) => {
    await run(slot, command);
    if (parseOwnedName(slot.name)?.role !== role) return;
    const terminal = Object.values(f.read().terminals).find((t) => t.labels[OWNER_LABEL] === slot.name)!;
    faulted.push(terminal.address);
    f.rule({ match: ["read", terminal.address, ...(persistent ? [] : ["--lines", "1000"])],
      output: '{"complete":true,"how":"history","text":"cut', once: !persistent });
  };
  return { app, faulted };
}

const fixture = () => setupRepo([T("T1", { files: ["work.txt"] })], {
  tasks: { T1: [{ shell: `echo work > work.txt && ${COMMIT} work`, result: { ok: true, summary: "done" } }] },
}, "visibility: { llm: pane, keepPanes: run }\n");

test("row 360: one truncated hc history read followed by valid JSON completes the pane review normally with no task-failed row", async () => {
  const { repo, fake } = fixture();
  const f = new FakeHerdrApp(makeTestTempDir("hcapp-read-once-"), { execute: true });
  const { app, faulted } = readFault(f, "review", false);
  const runId = "run-hc-read-once";
  try {
    const result = await runDaemon(repo, { adapters: [fake], driver: app, runId, approvalWindowMs: 0 });
    expect(result.done).toEqual(["T1"]);
    expect(faulted).toHaveLength(1);
    const rows = Journal.open(repo, runId).read();
    expect(rows.some((row) => row.event === "gate-result" && row.data.gate === "review" && row.data.pass === true)).toBe(true);
    expect(rows.filter((row) => row.event === "task-failed" || row.event === "review-no-verdict")).toEqual([]);
    expect(f.hcCalls("read").filter((argv) => argv[1] === faulted[0] && argv.includes("1000")).length).toBeGreaterThanOrEqual(2);
  } finally { f.reap(); }
}, 90_000);

test("row 360: persistently truncated worker, judge and review pane reads park infra without task-failed rows and remain recoverable", async () => {
  for (const role of ["worker", "judge", "review"] as const) {
    const { repo, fake } = fixture();
    const f = new FakeHerdrApp(makeTestTempDir(`hcapp-read-${role}-`), { execute: true });
    const { app, faulted } = readFault(f, role, true);
    const runId = `run-hc-read-${role}`;
    try {
      const result = await runDaemon(repo, { adapters: [fake], driver: app, runId, approvalWindowMs: 0 });
      expect(result.human, role).toEqual(["T1"]);
      expect(result.done, role).toEqual([]);
      expect(faulted.length, role).toBeGreaterThan(0);
      const rows = Journal.open(repo, runId).read();
      expect(rows.filter((row) => row.event === "task-failed"), role).toEqual([]);
      expect(rows.filter((row) => row.event === "task-human").at(-1)?.data.kind, role).toBe("infra");
      expect(permittedDecisionVerbs(newestPark(rows, "T1")), role).toContain("recheck");
      if (role === "worker") {
        expect(rows.some((row) => row.event === "held-probe"), role).toBe(true);
        expect(rows.some((row) => row.event === "worktree-preserved"), role).toBe(true);
      } else if (role === "review") {
        expect(rows.find((row) => row.event === "review-no-verdict")?.data, role).toMatchObject({ cause: "no-verdict", infra: true });
        expect(rows.some((row) => row.event === "gate-result" && row.data.gate === "acceptance" && row.data.pass === true), role).toBe(true);
        expect(rows.some((row) => row.event === "gate-result" && row.data.gate === "review" && row.data.pass === true), role).toBe(false);
      } else {
        const acceptance = rows.find((row) => row.event === "gate-result" && row.data.gate === "acceptance");
        expect(acceptance?.data, role).toMatchObject({ pass: false, infra: true });
        expect(String(acceptance?.data.details), role).toContain("judge pane unreadable");
        expect(String(acceptance?.data.details), role).toContain("no verdict; failing closed");
      }
    } finally { f.reap(); }
  }
}, 180_000);
