import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { renderAcceptanceItem, type Task } from "../graph/schema.js";
import type { WorkerResult } from "./types.js";

export function buildTaskPrompt(task: Task, feedback = "", nonce = ""): string {
  const list = (xs: string[]) => xs.map((x) => `- ${x}`).join("\n");
  return `You are an autonomous coding worker dispatched by tickmarkr into an isolated git worktree.

## Task ${task.id}: ${task.title}
Goal: ${task.goal}

## Acceptance criteria (you will be judged against these, verbatim)
${list(task.acceptance.map(renderAcceptanceItem))}
${task.files.length ? `\n## File scope — touch ONLY paths matching:\n${list(task.files)}\n` : ""}${task.context.length ? `\n## Context (read these first)\n${list(task.context)}\n` : ""}
## Rules
- Work only inside the current directory (your isolated worktree). Never push. Never switch branches.
- Make small atomic git commits as you go (git add + git commit, conventional messages).
- Touch ONLY paths matching the file scope. Out-of-scope edits FAIL the scope gate unless the operator's config allowlists that path — declaring a deviation never passes the gate. If you cannot complete the task without an out-of-scope edit, stop and report ok:false explaining why in "summary". List any out-of-scope paths you did touch, each with a reason, in "deviations" (journaled for the operator's audit).
- Do not ask questions; you are unattended. Make the smallest correct change.
${feedback ? `\n## Previous attempt failed gates — fix these specifically\n${feedback}\n` : ""}
When finished, end your final message with exactly one line (no code fence):
TICKMARKR_RESULT_${nonce} {"ok":true|false,"summary":"<one sentence>","deviations":["<path or reason>"]}
`;
}

export function writePrompt(dir: string, task: Task, attempt: number, feedback = "", nonce = ""): string {
  const p = join(dir, "prompts", `${task.id}-a${attempt}.md`);
  mkdirSync(join(dir, "prompts"), { recursive: true });
  writeFileSync(p, buildTaskPrompt(task, feedback, nonce));
  return p;
}

// v1.2 interactive completion anchor: matches a real trailer in any key order — even hard-wrapped
// across lines by a TUI renderer ([\s\S] bridges newlines between tokens) — but never the template
// line above, whose literal `true|false` is not a bool followed by , or }. v1.4: the run-tagged nonce
// anchors it so displayed source/diffs (which can't know the nonce) can never premature-harvest.
export function trailerPattern(nonce: string): string {
  return `TICKMARKR_RESULT_${nonce} \\{[\\s\\S]{0,120}?"ok":\\s*(true|false)\\s*[,}]`;
}

function trailerTokenPositions(raw: string, nonce: string): number[] {
  const token = `TICKMARKR_RESULT_${nonce}`;
  const positions: number[] = [];
  for (let i = raw.indexOf(token); i !== -1; i = raw.indexOf(token, i + 1)) positions.push(i);
  return positions;
}

// v1.65 T1: the parse boundary's own no-trailer sentinel summaries. classifyDeadChannel keys on
// these — a result carrying any other summary is a PARSED trailer, i.e. the worker speaking.
export const NO_TRAILER_SUMMARY = "worker produced no TICKMARKR_RESULT trailer";
export const UNPARSEABLE_TRAILER_SUMMARY = "unparseable TICKMARKR_RESULT trailer";

export function parseWorkerResult(raw: string, nonce: string): WorkerResult {
  const fail = (summary: string) => ({ ok: false, summary, deviations: [], raw });
  const positions = trailerTokenPositions(raw, nonce);
  if (positions.length === 0) return fail(NO_TRAILER_SUMMARY);
  // TUIs echo the prompt template, redraw lines, and HARD-wrap the JSON with per-line margins
  // (cursor does; recent-unwrapped can't rejoin hard newlines). Scan occurrences backward — last
  // parseable wins — joining wrapped lines, stripping margin/box chrome, and growing the candidate
  // one closing brace at a time (summaries may themselves contain `}`).
  for (let idx = positions.length - 1; idx >= 0; idx--) {
    const at = positions[idx];
    const open = raw.indexOf("{", at);
    if (open !== -1) {
      const joined = raw
        .slice(open, open + 2000)
        .split("\n")
        .map((l) => l.replace(/^[\s│|]+/, "").replace(/[\s│|]+$/, ""))
        .join("");
      for (let end = joined.indexOf("}"); end !== -1; end = joined.indexOf("}", end + 1)) {
        try {
          const j = JSON.parse(joined.slice(0, end + 1));
          return {
            ok: j.ok === true,
            summary: String(j.summary ?? ""),
            deviations: Array.isArray(j.deviations) ? j.deviations.map(String) : [],
            raw,
          };
        } catch {
          /* not yet balanced, or template/garbage — grow the candidate or scan back */
        }
      }
    }
  }
  return fail(UNPARSEABLE_TRAILER_SUMMARY);
}

// v1.65 T1: typed dead-channel reasons — CLI-reported terminal failures meaning this channel was
// never going to answer (OBS-57 unreliable serving, v1.44 T2 outage, v1.45 T3 crawl). Classified
// HERE, at the worker-result parsing boundary, from the dead worker's own output; the daemon
// consumes the type and fails over exactly like quota — free reroute, no escalation-ladder step,
// channel excluded for the run. "timeout" is the CLI reporting its own request/connection timeout;
// the harness stall reap is NOT a dead channel (OBS-82: mid-work hangs recover via consult).
export type DeadChannelReason = "auth-required" | "setup-required" | "provider-outage" | "timeout";

// Signatures anchor distinctive CLI-error phrasing — never bare fragments or bare status-code
// numbers (the QUOTA_RE Pitfall-3 lesson): these run only over no-trailer output, but a stalled
// worker's harvested pane can still contain ordinary work text.
const AUTH_RE = /not logged in|please (?:log ?in|sign in)|please run [^\n]{0,30}log ?in|authentication[ _](?:required|failed|error)|invalid (?:api key|credentials)|api key (?:is )?(?:not set|missing|invalid|required)|credentials? (?:have )?expired|401 unauthorized/i;
const SETUP_RE = /command not found|not recognized as an internal or external command|spawn \S+ ENOENT|missing required config|workspace trust (?:required|not granted)/i;
const OUTAGE_RE = /unable to reach the model provider|cannot reach the model provider|model provider.{0,40}(?:unavailable|unreachable)|service (?:is )?temporarily unavailable|upstream connect error|overloaded_error/i;
const TIMEOUT_RE = /\bETIMEDOUT\b|request timed out|connection timed out|deadline exceeded|timed out waiting for/i;

export function classifyDeadChannel(result: WorkerResult): DeadChannelReason | undefined {
  // A parsed trailer — ok:true OR ok:false — is the worker speaking: genuine work outcomes walk
  // the normal gate/ladder path even when their transcript mentions auth/outage/timeout text.
  if (result.ok || (result.summary !== NO_TRAILER_SUMMARY && result.summary !== UNPARSEABLE_TRAILER_SUMMARY)) return undefined;
  if (AUTH_RE.test(result.raw)) return "auth-required";
  if (SETUP_RE.test(result.raw)) return "setup-required";
  if (OUTAGE_RE.test(result.raw)) return "provider-outage";
  if (TIMEOUT_RE.test(result.raw)) return "timeout";
  return undefined;
}
