import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { attach } from "../../src/acp/attach.js";
import { statusSnapshot } from "../../src/cli/commands/status-snapshot.js";
import { graphDefinitionHash, saveGraph } from "../../src/graph/graph.js";
import { validateGraph } from "../../src/graph/schema.js";
import { owedCriteria, owedSubject, rangePatch, rangePatches, type JournalEvent, type OwedCheck } from "../../src/run/journal.js";
import { validateAgentMessage } from "../helpers/acp-schema.js";
import { makeRepo, T } from "../helpers/tmprepo.js";

vi.mock("node:fs", async original => {
  const actual = await original<typeof import("node:fs")>();
  return { ...actual, readFileSync: vi.fn(actual.readFileSync) };
});
const ts = "2026-10-28T00:00:00.000Z";
const row = (event: string, taskId?: string, data: Record<string, unknown> = {}): JournalEvent => ({ ts, event, taskId, data });
const encode = (rows: JournalEvent[]) => rows.map(row => JSON.stringify(row)).join("\n") + "\n";
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: "pipe" }).trim();
afterEach(() => { vi.restoreAllMocks(); vi.clearAllMocks(); });

test("test: the final message's first line is green only when a fresh final status read is green, by every row of the closed verdict table, discharge evidence invalidated with no journal growth and a failing final read included, so a verdict from an earlier read fails", async () => {
  const cwd = makeRepo({ "work.txt": "before\n" });
  const graph = validateGraph({ version: 1, spec: { source: "native", paths: ["spec.md"], hash: "verdict" }, tasks: [T("T1")] });
  saveGraph(cwd, graph);
  const base = git(cwd, "rev-parse", "HEAD");
  fs.writeFileSync(join(cwd, "work.txt"), "after\n");
  git(cwd, "add", "work.txt");
  git(cwd, "commit", "--no-gpg-sign", "-m", "work");
  const head = git(cwd, "rev-parse", "HEAD");
  const originalRead = vi.mocked(fs.readFileSync).getMockImplementation()!;
  const modes = ["clean", "invalid", "parked", "failed", "fatal", "owing", "discharged", "invalidate", "read-fails", "dead", "unreadable"] as const;
  for (const mode of modes) {
    const runId = `run-${mode}`;
    const dir = join(cwd, ".tickmarkr", "runs", runId);
    fs.mkdirSync(dir, { recursive: true });
    const path = join(dir, "journal.jsonl");
    const obligation: OwedCheck = {
      version: 1, id: `owed-${mode}`, runId, taskId: "T1", gate: "review", base, head,
      subject: owedSubject(cwd, base, head), patch: rangePatch(cwd, base, head), patches: rangePatches(cwd, base, head),
      criteria: owedCriteria(graph.tasks[0]!.acceptance), files: ["work.txt"], authors: ["codex:gpt-5"],
      declared: [{ key: "codex:gpt-5", vendor: "openai" }, { key: "claude-code:sonnet", vendor: "anthropic" }],
      cause: "review risk", evidence: "verify exact range", disposition: "accepted-risk", known: true,
    };
    const rows = [row("run-start", undefined, { graphDefinitionHash: graphDefinitionHash(graph), pid: mode === "dead" ? 2_147_483_000 : process.pid }), row("task-dispatch", "T1", { attempt: 0 })];
    if (["owing", "discharged", "invalidate", "read-fails"].includes(mode)) rows.push(
      row("gate-result", "T1", { gate: "review", pass: false }), row("task-human", "T1", { kind: "gate-fail" }),
      row("task-approved", "T1", { release: "gate-satisfied", gate: "review", park: { line: 4, ts }, obligation }),
      row("recheck-battery", "T1"));
    if (mode === "parked") rows.push(row("task-human", "T1", { kind: "human-gate" }));
    else if (mode === "failed") rows.push(row("task-failed", "T1"));
    else rows.push(row("task-done", "T1"), row("merge", "T1", { commit: head }));
    if (mode !== "dead") rows.push(row("run-end", undefined, { failed: mode === "failed" ? ["T1"] : [],
      human: mode === "parked" ? ["T1"] : [], blocked: [], pending: [], tipVerify: "passed",
      ...(mode === "fatal" ? { fatal: true, phase: "merge", error: "failed" } : {}),
      owedChecks: { known: true, debt: 0 }, // Historical green bait must never decide this turn.
    }));
    fs.writeFileSync(path, encode(rows) + (mode === "invalid" ? "not-json\n" : ""));
    const proofPath = join(dir, "proof.json");
    if (["discharged", "invalidate", "read-fails"].includes(mode)) {
      const proof = Buffer.from(JSON.stringify({ head, mergeBase: base, green: true, files: obligation.files, criteria: obligation.criteria,
        gateRows: [{ gate: "review", pass: true, meta: { reviewer: "claude-code:sonnet", vendor: "anthropic", provider: "anthropic" } }] }));
      fs.writeFileSync(proofPath, proof);
      fs.appendFileSync(path, encode([row("owed-check-discharged", "T1", { ids: [obligation.id], gates: ["review"], mapping: "exact", mergeBase: base, head,
        criteria: obligation.criteria, artifactPath: "proof.json", artifactSha256: createHash("sha256").update(proof).digest("hex"),
        reviewer: { key: "claude-code:sonnet", vendor: "anthropic" }, authorChannels: [{ key: "codex:gpt-5", vendor: "openai" }] })]));
      expect(statusSnapshot(cwd, runId).verdict.green, `${mode}: initially green`).toBe(true);
    }
    const journalBefore = fs.readFileSync(path);
    const updates: any[] = [];
    let reads = 0;
    vi.mocked(fs.readFileSync).mockImplementation(((...args: any[]) => {
      if (args[0] === path) {
        reads++;
        if (reads === 2) {
          if (mode === "invalidate") fs.appendFileSync(proofPath, " ");
          if (mode === "read-fails") throw new Error("final read fails");
          if (mode === "unreadable") fs.truncateSync(path, 0);
        }
      }
      return (originalRead as any)(...args);
    }) as typeof fs.readFileSync);
    const signal = new AbortController();
    const result = await attach({ cwd, runId, signal: signal.signal, session: { tools: new Map() },
      send: update => {
        validateAgentMessage({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "s", update } });
        updates.push(update);
      }, sleep: async () => { throw new Error("terminal observation failed to end"); } });
    vi.mocked(fs.readFileSync).mockImplementation(originalRead);
    expect(result).toEqual({ stopReason: "end_turn" });
    const messages = updates.filter(update => update.sessionUpdate === "agent_message_chunk");
    expect(messages, mode).toHaveLength(1);
    const final = messages[0].content.text;
    const green = mode === "clean" || mode === "discharged";
    expect(final.split("\n")[0] === "GREEN — every clause holds", mode).toBe(green);
    if (!green) expect(final, mode).toMatch(/^NOT GREEN — /u);
    const counts = final.split("\n")[1];
    for (const name of ["done", "failed", "parked", "blocked", "pending", "tip", "owed"]) expect(counts, mode).toContain(`${name} `);
    if (mode === "fatal") expect(final).toContain("fatal run end");
    if (mode === "invalidate") {
      expect(final).toContain("artifact hash mismatch");
      expect(fs.readFileSync(path)).toEqual(journalBefore);
    }
    if (mode === "read-fails" || mode === "unreadable") { expect(final).toContain("unreadable"); expect(counts).toContain("owed unknown"); }
    if (mode === "dead") expect(final).toContain(`tickmarkr resume ${runId}`);
    expect(reads, mode).toBeGreaterThanOrEqual(2);
  }
});
