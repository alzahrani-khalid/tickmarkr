import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { TickmarkrConfig } from "../config/config.js";
import type { Task } from "../graph/schema.js";
import { parseWorkerResult } from "./prompt.js";
import { type Assignment, type AuthHealth, type BillingChannel, type ContextUsage, type Invocation, type SessionRef, shq, type TokenUsage, TokenUsageSchema, type WorkerAdapter, type WorkerResult } from "./types.js";

export interface FakeScript {
  // a step without `result` emits no trailer — scripts stall/quota scenarios.
  // `usage` (v1.7 SPEND-01): scripted synthetic token counts the step writes as a timestamped disk
  // record; collectUsage reads it POST-HOC, cursor-sliced. The whole suite trusts the fake, so it must
  // honor sinceMs exactly like a real adapter — ignoring the cursor is the bug this milestone fixes.
  tasks: Record<string, Array<{ shell: string; result?: { ok: boolean; summary: string; deviations?: string[] }; usage?: { input: number; output: number; cacheRead?: number; cacheWrite?: number; reasoning?: number } }>>;
  // Phase 47 (GATE-09): `judge` accepts a single value OR an array served sequentially per JUDGE
  // prompt (garbage-then-good / double-garbage fixtures). Scope drafting shares this fixture cursor;
  // a review/consult prompt between two judge calls never bumps it.
  // Single-value scripts are byte-identical to the pre-array behavior (array branch never taken).
  judge?: unknown;
  review?: unknown;
  consult?: unknown;
}

// ponytail: deterministic scripted adapter — the whole integration suite runs on it, zero tokens.
export class FakeAdapter implements WorkerAdapter {
  id = "fake";
  vendor = "fake-a";
  private script: FakeScript;
  private attempts = new Map<string, number>();

  constructor(private scriptPath: string) {
    this.script = JSON.parse(readFileSync(scriptPath, "utf8"));
  }

  async probe(): Promise<AuthHealth> {
    return {
      installed: true, authed: true, version: "fake", models: ["fake-1", "fake-2"],
      modelAuth: {
        "fake-1": { authed: true, probedAt: "1970-01-01T00:00:00.000Z" },
        "fake-2": { authed: true, probedAt: "1970-01-01T00:00:00.000Z" },
      },
    };
  }

  channels(_cfg: TickmarkrConfig): BillingChannel[] {
    return [
      { adapter: "fake", vendor: "fake-a", model: "fake-1", channel: "sub", tier: "frontier" },
      { adapter: "fake", vendor: "fake-b", model: "fake-2", channel: "api", tier: "frontier" },
    ];
  }

  private judgeIdx = 0; // Phase 47: per-instance judge verdict cursor — advances only on TICKMARKR-JUDGE prompts

  headlessCommand(promptFile: string, _model: string): string {
    // Phase 47 (GATE-09): detect role at COMMAND-BUILD time. runHeadless/runViaDriver write the prompt
    // file BEFORE calling headlessCommand, so it exists here. The counter advances ONLY when the prompt
    // contains TICKMARKR-JUDGE — a review/consult prompt never touches it (research Pitfall 3).
    let prompt = "";
    let isJudge = false;
    try {
      prompt = readFileSync(promptFile, "utf8");
      isJudge = /TICKMARKR-(?:JUDGE|SCOPE)/.test(prompt);
    } catch {
      // unreadable promptFile: can't detect role; serve static values (legacy headless-call behavior)
    }
    const serve = (key: "judge" | "review" | "consult") => {
      let val = this.script[key];
      if (key === "judge" && isJudge && Array.isArray(val)) {
        // array served sequentially per judge prompt, clamped to last (steps[min(n,len-1)] idiom)
        val = (val as unknown[])[Math.min(this.judgeIdx, (val as unknown[]).length - 1)];
        this.judgeIdx++;
      }
      if (key === "judge" && isJudge && val && typeof val === "object" && !Array.isArray(val)) {
        const verdict = val as { pass?: unknown; criteria?: unknown };
        if (verdict.pass === true && Array.isArray(verdict.criteria) && verdict.criteria.length === 0) {
          const items = prompt.match(/## Acceptance criteria \(judge\)\n([\s\S]*?)\n\n## Diff/)?.[1]
            .split("\n").filter((line) => line.startsWith("- ")).map((line) => line.slice(2)) ?? [];
          val = { ...verdict, criteria: items.map((criterion) => ({ criterion, met: true, reason: "scripted fake pass" })) };
        }
      }
      const p = join(dirname(this.scriptPath), `${key}.json`);
      writeFileSync(p, JSON.stringify(val ?? {}, null, 1));
      return p;
    };
    return `bash -c 'grep -Eq "TICKMARKR-(JUDGE|SCOPE)" ${shq(promptFile)} && cat ${shq(serve("judge"))}; grep -q TICKMARKR-REVIEW ${shq(promptFile)} && cat ${shq(serve("review"))}; grep -q TICKMARKR-CONSULT ${shq(promptFile)} && cat ${shq(serve("consult"))}; true'`;
  }

  resumeCommand(_sessionId: string, promptFile: string, model: string): string {
    return this.interactiveCommand(promptFile, model) ?? this.headlessCommand(promptFile, model);
  }

  private stepCommand(taskId: string, n: number, nonce: string): string {
    const steps = this.script.tasks[taskId] ?? [];
    const step = steps[Math.min(n, steps.length - 1)] ?? {
      shell: "true",
      result: { ok: false, summary: `fake script has no entry for ${taskId}` },
    };
    // SPEND-01: synthetic usage as a TIMESTAMPED disk record the fake's own reader picks up post-hoc —
    // never a trailer, never pane text. node stamps a real ms-precision ISO time (bash 3.2 on darwin has
    // no ms clock) so the record lands at/after this attempt's dispatch and clears the sinceMs cursor.
    // Written BEFORE the trailer echo (same order real CLIs use: session-store rows land during work,
    // completion marker last) so an interactive harvest on the trailer never races the usage writer.
    // Still after the step's `git add`/commit ⇒ stays untracked ⇒ invisible to scope/evidence gates.
    const usageWrite = step.usage
      ? `; node -e ${shq(`require("fs").writeFileSync(".tickmarkr-usage.json", JSON.stringify({timestamp:new Date().toISOString(), usage:${JSON.stringify(step.usage)}}))`)}`
      : "";
    const base = !step.result
      ? `bash -c ${shq(step.shell)}` // no trailer: scripted stall/quota
      : `bash -c ${shq(step.shell)}${usageWrite}; echo ${shq(`TICKMARKR_RESULT_${nonce} ` + JSON.stringify({ deviations: [], ...step.result }))}`;
    return base;
  }

  // SPEND-01: read the cwd-keyed usage record from DISK (never a pane), honoring the attempt cursor.
  // A record stamped before sinceMs, an unparseable stamp, or a bad usage shape all fail OPEN to
  // undefined ⇒ unmetered — never 0, never a thrown error that could fail a healthy task.
  collectUsage(cwd: string, sinceMs: number): TokenUsage | undefined {
    try {
      const rec = JSON.parse(readFileSync(join(cwd, ".tickmarkr-usage.json"), "utf8"));
      const ts = Date.parse(rec?.timestamp);
      if (!Number.isFinite(ts) || ts < sinceMs) return undefined; // cursor honored, fail-open
      const p = TokenUsageSchema.safeParse(rec?.usage);
      return p.success ? p.data : undefined;
    } catch {
      return undefined; // no record / unreadable ⇒ unmetered
    }
  }

  // v1.23 T1: fake has no knowable session store — always null (unknown). Callers must NOT coerce
  // null to 0 or treat it as over-threshold (telemetry fail-open).
  contextUsage(_session: SessionRef): ContextUsage | null {
    return null;
  }

  // the run nonce lives in the prompt writePrompt handed us; echo a matching trailer so
  // parseWorkerResult(output, nonce) succeeds exactly as before the nonce existed
  private nonceFor(promptFile: string): string {
    try {
      return /TICKMARKR_RESULT_([0-9a-z]+)/.exec(readFileSync(promptFile, "utf8"))?.[1] ?? "";
    } catch {
      return "";
    }
  }

  invoke(task: Task, _cwd: string, _a: Assignment, ctx: { promptFile: string }): Invocation {
    const n = this.attempts.get(task.id) ?? 0;
    this.attempts.set(task.id, n + 1);
    return { command: this.stepCommand(task.id, n, this.nonceFor(ctx.promptFile)) };
  }

  // task + attempt come from writePrompt's `<taskId>-a<n>.md` contract — interactiveCommand has no task arg
  interactiveCommand(promptFile: string, _model: string): string | null {
    const m = /([A-Za-z0-9_-]+)-a(\d+)\.md$/.exec(promptFile);
    return m ? this.stepCommand(m[1], Number(m[2]), this.nonceFor(promptFile)) : null;
  }

  parse(output: string, nonce: string): WorkerResult {
    return parseWorkerResult(output, nonce);
  }
}
