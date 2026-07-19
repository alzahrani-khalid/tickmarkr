import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { writeDoctor } from "../../src/adapters/registry.js";
import { DEFAULT_CONFIG } from "../../src/config/config.js";
import { plan } from "../../src/cli/commands/plan.js";
import { report } from "../../src/cli/commands/report.js";
import { narrationLine } from "../../src/cli/commands/run.js";
import { saveGraph } from "../../src/graph/graph.js";
import { validateGraph } from "../../src/graph/schema.js";
import { formatJournalNarration, Journal, type JournalEvent } from "../../src/run/journal.js";
import { authedModels, makeRepo } from "../helpers/tmprepo.js";

// T4 (v1.50): plan, run narration, and report join the doctor/status visual system through the
// src/brand.ts helpers. Golden files in tests/fixtures/brand-surfaces/ were generated from the
// pre-change code — the non-TTY/markdown surfaces must stay byte-identical to them.

const ttyDesc = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
const noColor0 = process.env.NO_COLOR;
const setTTY = (v: boolean) => Object.defineProperty(process.stdout, "isTTY", { value: v, configurable: true });
const onTTY = () => { setTTY(true); delete process.env.NO_COLOR; };

// v1.51 T4: goldens now carry the plan mode header — isolate XDG so an operator's global
// routing.mode declaration can never shift the pinned source layer ("default") at the gate.
let xdg0: string | undefined;
beforeEach(() => {
  xdg0 = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "tickmarkr-brand-xdg-"));
});

afterEach(() => {
  if (ttyDesc) Object.defineProperty(process.stdout, "isTTY", ttyDesc);
  else delete (process.stdout as { isTTY?: boolean }).isTTY;
  if (noColor0 === undefined) delete process.env.NO_COLOR;
  else process.env.NO_COLOR = noColor0;
  if (xdg0 === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = xdg0;
});

const golden = (name: string) => readFileSync(join(import.meta.dirname, "../fixtures/brand-surfaces", name), "utf8");

const verifiedDefaultModels = (id: string) => authedModels(Object.keys(DEFAULT_CONFIG.tiers[id]?.models ?? {}));

const DOCTOR5 = Object.fromEntries(
  ["claude-code", "codex", "cursor-agent", "opencode", "pi"].map((id) => [id, { installed: true, authed: true, models: [], modelAuth: verifiedDefaultModels(id) }]),
);

function mkBasicRepo(): string {
  const repo = makeRepo({ "keep.txt": "x\n" });
  saveGraph(repo, validateGraph({
    version: 1, spec: { source: "prd", paths: ["p"], hash: "h" },
    tasks: [{ id: "T1", title: "t", goal: "g", shape: "chore", complexity: 2, acceptance: ["a"] }],
  }));
  writeDoctor(repo, DOCTOR5);
  return repo;
}

// only claude-code installed, both frontier models unauthed, migration floor frontier ⇒ the plan
// output carries an unroutable `!!` row AND a `  ! T1: unroutable` routing lint (the golden pins both)
const DOCTOR_FABLE_UNAUTHED = {
  "claude-code": {
    installed: true, authed: true, models: ["fable", "opus", "sonnet", "haiku"],
    modelAuth: {
      fable: { authed: false, reason: "HTTP 403: forbidden", probedAt: "2026-07-13T09:12:00Z" },
      opus: { authed: false, reason: "insufficient credit", probedAt: "2026-07-13T09:12:00Z" },
      sonnet: { authed: true, probedAt: "2026-07-13T09:12:00Z" },
      haiku: { authed: true, probedAt: "2026-07-13T09:12:00Z" },
    },
  },
};

function mkLintRepo(): string {
  const repo = makeRepo({ "keep.txt": "x\n" });
  saveGraph(repo, validateGraph({
    version: 1, spec: { source: "prd", paths: ["p"], hash: "h" },
    tasks: [{ id: "T1", title: "t", goal: "g", shape: "migration", complexity: 2, acceptance: ["a"] }],
  }));
  writeDoctor(repo, DOCTOR_FABLE_UNAUTHED);
  return repo;
}

function mkReportRepo(): string {
  const repo = makeRepo({ "keep.txt": "x\n" });
  const j = Journal.create(repo, "run-brand-pin");
  writeFileSync(join(j.dir, "journal.jsonl"), [
    { ts: "2026-07-18T10:00:00.000Z", event: "run-start", data: { baseRef: "abc123def456" } },
    { ts: "2026-07-18T10:00:01.000Z", event: "task-dispatch", taskId: "T1", data: { assignment: { adapter: "fake", model: "fake-1", channel: "sub", tier: "cheap" }, attempt: 0, provenance: "floor cheap" } },
    { ts: "2026-07-18T10:00:02.000Z", event: "gate-result", taskId: "T1", data: { gate: "build", pass: true, details: "exit 0" } },
    { ts: "2026-07-18T10:00:03.000Z", event: "gate-result", taskId: "T1", data: { gate: "test", pass: false, details: "1 failed" } },
    { ts: "2026-07-18T10:00:04.000Z", event: "consult-verdict", taskId: "T1", data: { action: "retry", notes: "fix the test" } },
    { ts: "2026-07-18T10:00:05.000Z", event: "task-done", taskId: "T1", data: { attempts: 2 } },
    { ts: "2026-07-18T10:00:06.000Z", event: "merge", taskId: "T1", data: { branch: "tickmarkr/run-brand-pin--T1", commit: "deadbeef" } },
    { ts: "2026-07-18T10:01:30.000Z", event: "run-end", data: { runId: "run-brand-pin", branch: "tickmarkr/run-brand-pin", done: ["T1"], failed: [], human: [], blocked: [], pending: [] } },
  ].map((e) => JSON.stringify(e)).join("\n") + "\n");
  return repo;
}

// a representative slice of the lifecycle stream — prefixed events and untouched bystanders
const NARRATION_EVENTS: JournalEvent[] = [
  { ts: "t", event: "run-start", data: { pid: 1, baseRef: "abc123def456" } },
  { ts: "t", event: "task-dispatch", taskId: "T1", data: { assignment: { adapter: "fake", model: "fake-1" }, attempt: 0 } },
  { ts: "t", event: "gate-result", taskId: "T1", data: { gate: "test", pass: false } },
  { ts: "t", event: "task-done", taskId: "T1", data: { summary: "ok" } },
  { ts: "t", event: "task-failed", taskId: "T2", data: { error: "boom" } },
  { ts: "t", event: "task-human", taskId: "T3", data: { reason: "quota exhausted on every eligible channel" } },
  { ts: "t", event: "run-end", data: { done: ["T1"], failed: ["T2"] } },
];

describe("T4 v1.50 brand pass — plan, run narration, report", () => {
  test("plan non-tty output is byte-identical to the golden fixture (regenerated for the v1.51 T4 mode header + derivation lines)", async () => {
    setTTY(false);
    expect(await plan([], mkBasicRepo())).toBe(golden("plan-basic.txt"));
    expect(await plan([], mkLintRepo())).toBe(golden("plan-lints.txt"));
  });

  test("a plan lint renders the attention glyph on a tty", async () => {
    onTTY();
    const out = await plan([], mkLintRepo());
    expect(out.startsWith("\x1b[1mtickmarkr plan — dry run")).toBe(true); // title frame
    expect(out).toContain("\x1b[2m─"); // rule under the title
    expect(out).toContain("\x1b[33m!\x1b[0m T1: unroutable"); // attention glyph, amber, on the lint
    expect(out).toContain("\x1b[33m!!\x1b[0m "); // unroutable row marker shares the semantics
    expect(out).toContain("\x1b[2mrouting lints:\x1b[0m"); // section label is chrome
  });

  test("run narration non-tty output is byte-identical to before this change", () => {
    setTTY(false);
    for (const e of NARRATION_EVENTS) expect(narrationLine(e), e.event).toBe(formatJournalNarration(e));
    // literal pin — the exact pre-change bytes of a lifecycle line
    expect(narrationLine({ ts: "t", event: "task-failed", taskId: "T2", data: { error: "boom" } }))
      .toBe("task-failed — T2 — boom");
  });

  test("a failed task narration line renders the fail token on a tty", () => {
    onTTY();
    expect(narrationLine({ ts: "t", event: "task-failed", taskId: "T2", data: { error: "boom" } }))
      .toBe("\x1b[31m✗\x1b[0m task-failed — T2 — boom");
    // the other lifecycle verdicts: dispatch neutral, done ok (brand green), human attention
    expect(narrationLine({ ts: "t", event: "task-dispatch", taskId: "T1", data: {} }))
      .toBe("\x1b[2m-\x1b[0m task-dispatch — T1");
    expect(narrationLine({ ts: "t", event: "task-done", taskId: "T1", data: { summary: "ok" } }))
      .toBe("\x1b[38;5;41m✓\x1b[0m task-done — T1 — ok");
    expect(narrationLine({ ts: "t", event: "task-human", taskId: "T3", data: { reason: "gate" } }))
      .toBe("\x1b[33m!\x1b[0m task-human — T3 — gate");
    // non-lifecycle events carry no glyph even on a tty
    expect(narrationLine({ ts: "t", event: "run-start", data: { pid: 1 } })).toBe("run-start — pid 1");
  });

  test("report markdown output is byte-identical to before this change", async () => {
    setTTY(false);
    expect(await report(["run-brand-pin", "--md"], mkReportRepo())).toBe(golden("report-md.md"));
    onTTY(); // --md is a document surface — byte-identical even on a tty
    expect(await report(["run-brand-pin", "--md"], mkReportRepo())).toBe(golden("report-md.md"));
  });

  test("report tty text summary gains the title frame without altering message content", async () => {
    const repo = mkReportRepo();
    setTTY(false);
    const plain = await report(["run-brand-pin"], repo);
    onTTY();
    const tty = await report(["run-brand-pin"], repo);
    expect(tty.startsWith("\x1b[1mtickmarkr engagement — run-brand-pin\x1b[0m\n\x1b[2m─")).toBe(true);
    expect(tty.replace(/\x1b\[[0-9;]*m/g, "").split("\n").filter((l) => !/^─+$/.test(l)).join("\n")).toBe(plain);
  });
});
