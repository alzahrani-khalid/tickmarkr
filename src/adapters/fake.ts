import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { TickmarkrConfig } from "../config/config.js";
import type { Task } from "../graph/schema.js";
import { parseWorkerResult } from "./prompt.js";
import { type Assignment, type AuthHealth, type BillingChannel, type ContextUsage, type Invocation, type SessionRef, shq, type TokenUsage, TokenUsageSchema, type TrustDialog, type WorkerAdapter, type WorkerResult } from "./types.js";

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
  // v1.89 T1 / OBS-414: the scripted adapter runs `bash -c` — it has no TUI, so no prompt of any
  // kind can render. Daemon tests that exercise the auto-answer seam assign a captured declaration
  // to this field explicitly; that assignment is the falsifier for the claim made here.
  trustDialog: TrustDialog = {
    kind: "none",
    reason: "the zero-token scripted adapter dispatches a bash command and renders no TUI, so no trust prompt exists to capture",
  };
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
    // v1.85 T4: the role THIS prompt is, when it can be told. The three scratch files are shared per
    // script path, so a build that writes a role it is not can clobber a concurrently-dispatched
    // sibling's file between that sibling's build and its `cat` — which is exactly what a round that
    // launches judge and review together does. Writing only the matching role removes the race: the
    // other roles' `grep` guards below can never fire for this prompt, so their files are never read.
    let role: "judge" | "review" | "consult" | undefined;
    try {
      prompt = readFileSync(promptFile, "utf8");
      isJudge = /TICKMARKR-(?:JUDGE|SCOPE)/.test(prompt);
      role = isJudge ? "judge" : /TICKMARKR-REVIEW/.test(prompt) ? "review" : /TICKMARKR-CONSULT/.test(prompt) ? "consult" : undefined;
    } catch {
      // unreadable promptFile: can't detect role; serve static values (legacy headless-call behavior)
    }
    const nonce = this.nonceFor(promptFile);
    const serve = (key: "judge" | "review" | "consult") => {
      if (role !== undefined && key !== role) return join(dirname(this.scriptPath), `${key}.json`);
      let val = this.script[key];
      if (key === "judge" && isJudge && Array.isArray(val)) {
        // array served sequentially per judge prompt, clamped to last (steps[min(n,len-1)] idiom)
        val = (val as unknown[])[Math.min(this.judgeIdx, (val as unknown[]).length - 1)];
        this.judgeIdx++;
      }
      // Legacy zero-token judge scripts may omit per-criterion evidence. Shape that scripted response
      // here, where the fake authors it, instead of teaching the shared LLM transport about adapter ids.
      if (key === "judge" && prompt.startsWith("TICKMARKR-JUDGE") && val && typeof val === "object" && !Array.isArray(val)) {
        const verdict = val as { pass?: unknown; criteria?: unknown };
        if (verdict.pass === true && Array.isArray(verdict.criteria) && verdict.criteria.length === 0) {
          const items = prompt.match(/## Acceptance criteria \(judge\)\n([\s\S]*?)\n\n## Diff/)?.[1]
            .split("\n").filter((line) => line.startsWith("- ")).map((line) => line.slice(2)) ?? [];
          val = { ...verdict, criteria: items.map((criterion) => ({ criterion, met: true, reason: "scripted fake pass" })) };
        }
      }
      if (key === "judge" && isJudge && val && typeof val === "object" && !Array.isArray(val)) {
        const verdict = val as Record<string, unknown>;
        const line = /```diff\n([\s\S]*?)```/.exec(prompt)?.[1].split("\n").find((candidate) => candidate.trim());
        if (line && Array.isArray(verdict.criteria)) {
          val = {
            ...verdict,
            criteria: verdict.criteria.map((row) =>
              row && typeof row === "object" && !("evidence" in row) ? { ...row, evidence: line } : row),
          };
        }
      }
      // The configured fake adapter binds the nonce read from this prompt before one object is emitted.
      // Renamed subclasses model other CLIs and retain their own producer contract. Missing nonces stay
      // missing so the classifier can distinguish silence from participation.
      if (this.id === "fake" && nonce && val && typeof val === "object" && !Array.isArray(val)) {
        const { nonce: _scriptedNonce, ...verdict } = val as Record<string, unknown>;
        val = { nonce, ...verdict };
      }
      // Concurrent gates share one FakeAdapter script. A nonce-specific response path keeps one call's
      // responder-authored bytes from being replaced by a sibling between command construction and cat.
      const responseNonce = this.id === "fake" ? nonce : "";
      const p = join(dirname(this.scriptPath), `${key}${responseNonce ? `-${responseNonce}` : ""}.json`);
      const json = JSON.stringify(val ?? {}, null, 1)
        .split("\n").map((line) => line.trim()).join(" ")
        .replace(/^\{ /, "{").replace(/ \}$/, "}");
      writeFileSync(p, json);
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
      const prompt = readFileSync(promptFile, "utf8");
      return /VERDICT_NONCE:\s*([0-9a-f]+)/i.exec(prompt)?.[1]
        ?? /TICKMARKR_RESULT_([0-9a-z]+)/.exec(prompt)?.[1]
        ?? "";
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
