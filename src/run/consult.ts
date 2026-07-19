import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getAdapter } from "../adapters/registry.js";
import type { WorkerAdapter } from "../adapters/types.js";
import type { TickmarkrConfig } from "../config/config.js";
import type { ExecutorDriver, Slot } from "../drivers/types.js";
import { bannerShell, paneDispatchCommand } from "../brand.js";
import { augmentFakeVerdictOutput, extractVerdictJson, gateExitTrailer, gatePaneName, generateVerdictNonce, verdictNonceLine } from "../gates/llm.js";
import type { GateResult } from "../gates/types.js";
import { sh } from "./git.js";

export interface ConsultVerdict {
  action: "retry" | "reroute" | "decompose" | "human";
  notes: string;
  // OBS-37a: structured retry guidance — rendered as bullets in worker prompts, never quoted prose.
  reason?: string;
  guidance?: string;
  // OBS-20: optional adapter-scoped ban on reroute for environmental CLI failures
  // ("the CLI is blocked"), not model-quality misses. Daemon expands the task tried-list
  // with every channel of this adapter before nextChannel — never a router change (D-03).
  excludeAdapter?: string;
}

const MAX_RETRY_GUIDANCE_LINES = 10;

function guidanceParts(text: string): string[] {
  return text.split(/\n+/).flatMap((line) => line.split(/(?<=[.!?])\s+/)).map((s) => s.trim()).filter(Boolean);
}

// OBS-37a: retry worker prompts get structured bullets only — never the consult's raw notes prose
// (herdr false-blocked when consult verdict text was echoed verbatim in a cursor worker prompt).
export function renderRetryGuidance(v: ConsultVerdict): string {
  const lines: string[] = [`Action: ${v.action}`];
  if (v.reason) lines.push(`Reason: ${v.reason}`);
  const body = v.guidance ?? (v.reason ? "" : v.notes);
  for (const part of guidanceParts(body)) lines.push(part);
  return lines.slice(0, MAX_RETRY_GUIDANCE_LINES).map((l) => `- ${l}`).join("\n");
}

const LANDED_COMMIT_PREMISE_RE = /\b(?:already\s+committed|is\s+already\s+committed|landed\s+commit|implementation\s+is\s+already)\b/i;
const COMMIT_HASH_RE = /\b[0-9a-f]{7,40}\b/gi;

// OBS-58: name prior attempt commits by hash and drop consult premises about landed work that the
// fresh worktree does not satisfy — regenerated against post-recreation state, not inherited verbatim.
export function augmentRetryBrief(
  feedback: string,
  opts: { attempted: string[]; carried: string[]; present: Set<string> },
): string {
  const { attempted, carried, present } = opts;
  const named = [...new Set([...attempted, ...carried])];
  const presentLower = new Set([...present].map((h) => h.toLowerCase()));
  const parts: string[] = [];
  if (named.length > 0) {
    parts.push(
      "## Prior attempt commits (by hash)\n"
      + named.map((h) => `- ${h}${presentLower.has(h.toLowerCase()) ? " — present in this worktree" : " — not in this worktree"}`).join("\n"),
    );
  }
  let body = feedback.trim();
  if (body && LANDED_COMMIT_PREMISE_RE.test(body)) {
    const falseHash = [...body.matchAll(COMMIT_HASH_RE)].some((m) => !presentLower.has(m[0].toLowerCase()));
    const falseLanded = carried.length === 0 && attempted.length > 0;
    if (falseHash || falseLanded) {
      body = body
        .split("\n")
        .filter((line) => !LANDED_COMMIT_PREMISE_RE.test(line))
        .join("\n")
        .trim();
      const correction = carried.length > 0
        ? `Prior attempt work is present at: ${carried.join(", ")}.`
        : attempted.length > 0
          ? "Prior attempt commits could not be carried forward onto this worktree — re-land the work or continue from the integration tip."
          : "No prior attempt commits are present in this worktree — implement from the integration tip.";
      body = body ? `${correction}\n\n${body}` : correction;
    }
  }
  if (body) parts.push(body);
  return parts.join("\n\n");
}

export interface Dossier {
  taskId: string;
  trigger: string;
  journalTail: string;
  transcript: string;
  diff: string;
  gates: GateResult[];
}

const ACTIONS = ["retry", "reroute", "decompose", "human"] as const;

export function buildDossierPrompt(d: Dossier, nonce: string): string {
  return `TICKMARKR-CONSULT
You are a senior engineering consult for the tickmarkr orchestrator. A worker task hit trouble.
Read the dossier and return a verdict. Be decisive; cost is the lowest priority, quality the highest.

## Task: ${d.taskId} — trigger: ${d.trigger}

## Gate results
${d.gates.map((g) => `- [${g.pass ? "pass" : "FAIL"}] ${g.gate}: ${g.details}`).join("\n") || "(none)"}

## Failure context / diff
${d.diff || "(none)"}

## Worker transcript (tail)
${d.transcript || "(none)"}

## Journal (recent events)
${d.journalTail}

Verdict meanings: retry = same assignment with your notes as feedback; reroute = different CLI/model;
decompose = task too big, needs human re-planning; human = a person must look at this.

On reroute only, optional excludeAdapter is an adapter id (e.g. "cursor-agent") that bans EVERY
channel of that adapter for this task. Use it for environmental failures ("the CLI is blocked",
trust dialog, broken install) — not when a single model produced bad code. Omit for model-level
reroutes so other models of the same adapter remain eligible.

${verdictNonceLine(nonce)}

Respond with ONLY this JSON:
{"nonce": "${nonce}", "action": "retry" | "reroute" | "decompose" | "human", "reason": "why this action", "guidance": "imperative steps for the worker (newline-separated ok)", "excludeAdapter"?: "<adapter-id>"}
`;
}

let consultSeq = 0;

export async function consult(
  d: Dossier,
  cfg: TickmarkrConfig,
  adapters: WorkerAdapter[],
  driver: ExecutorDriver,
  cwd: string,
  runDir: string,
  // T2 ownership contract: runId names the consult pane canonically (tickmarkr:consult:<task>:0:<runId>)
  // via SlotOpts.owned; without it the legacy gatePaneName shape survives (non-daemon callers/tests).
  // v1.54 T1: channels — the daemon's doctor-filtered live channel list; prefer-seat liveness is
  // judged against it only (never rebuilt from config, which would select installed-but-unauthed seats).
  opts: { keep?: boolean; onSlot?: (slot: Slot) => void; runId?: string; channels?: Array<{ adapter: string }> } = {},
): Promise<ConsultVerdict> {
  const n = ++consultSeq;
  const nonce = generateVerdictNonce();
  const dir = join(runDir, "consults");
  mkdirSync(dir, { recursive: true });
  const promptFile = join(dir, `${d.taskId}-${n}.md`);
  writeFileSync(promptFile, buildDossierPrompt(d, nonce));

  // One seat = the WHOLE invoke-and-parse unit, both visibility branches (OBS-69 class: a headless-only
  // failover would leave the production pane path hard-failing on seat one). null = no parseable verdict.
  const invokeSeat = async (seatAdapter: string, seatModel: string, seatIdx: number): Promise<ConsultVerdict | null> => {
    const adapter = getAdapter(seatAdapter, adapters);
    let out: string;
    if (cfg.visibility.llm === "headless") {
      const r = await sh(adapter.headlessCommand(promptFile, seatModel), cwd, cfg.consult.stallMinutes * 60_000);
      out = r.stdout + r.stderr;
    } else {
      // T8: role-first pane name for fleet visibility (consult · T2); consultSeq stays on the dossier artifact only
      const slot = await driver.slot(cwd, gatePaneName("consult", d.taskId), {
        label: `CONSULT ${d.taskId}`,
        ...(opts.runId ? { owned: { role: "consult" as const, taskId: d.taskId, attempt: 0, runId: opts.runId } } : {}),
      });
      opts.onSlot?.(slot);
      const scriptPath = join(dir, `${d.taskId}-${n}${seatIdx > 0 ? `-s${seatIdx}` : ""}.sh`);
      // OBS-50: visible consult panes get the brand banner; headless path above stays banner-free (machine-parsed stdout)
      writeFileSync(scriptPath, [
        "export BASH_SILENCE_DEPRECATION_WARNING=1",
        bannerShell(),
        adapter.headlessCommand(promptFile, seatModel),
        gateExitTrailer(nonce),
      ].join("\n"));
      try {
        await driver.run(slot, paneDispatchCommand(scriptPath));
        // nonce-suffixed exit only: a dossier quoting tickmarkr's own exit literal must not false-complete.
        await driver.waitOutput(slot, `TICKMARKR_EXIT_${nonce}:\\d`, cfg.consult.stallMinutes * 60_000, { regex: true });
        out = await driver.read(slot, 300);
      } finally {
        // a failed seat must not leak its pane before the next seat opens under the same name
        if (!opts.keep) await driver.close(slot);
      }
    }
    out = augmentFakeVerdictOutput(adapter, out, nonce);

    const v = extractVerdictJson<ConsultVerdict>(out, nonce);
    if (!v || !ACTIONS.includes(v.action)) return null;
    // fail-closed exclusion: only a non-empty string survives. Malformed values (number/array/object/
    // empty) are dropped — the verdict stays a normal channel-level reroute/retry/…, never a crash
    // and never silently forced to human. Unknown adapter ids pass through; the daemon treats a
    // zero-match expansion as channel-level reroute.
    const raw = (v as { excludeAdapter?: unknown }).excludeAdapter;
    const excludeAdapter = typeof raw === "string" && raw.length > 0 ? raw : undefined;
    const reason = typeof (v as { reason?: unknown }).reason === "string" ? (v as { reason: string }).reason : undefined;
    const guidance = typeof (v as { guidance?: unknown }).guidance === "string" ? (v as { guidance: string }).guidance : undefined;
    const notes = String((v as { notes?: unknown }).notes ?? guidance ?? reason ?? "");
    return {
      action: v.action,
      notes,
      ...(reason ? { reason } : {}),
      ...(guidance ? { guidance } : {}),
      ...(excludeAdapter ? { excludeAdapter } : {}),
    };
  };

  // v1.54 T1: ranked seat failover. Walk consult.prefer (adapter:model entries) to the first entry
  // whose adapter is in the live channel set; a failed seat or unparseable verdict falls to the next;
  // the pinned consult.adapter/model is always the final seat. No channels provided (non-daemon
  // callers) ⇒ empty live set ⇒ pin only, byte-identical to pre-v1.54 behavior. Failover changes
  // only WHICH seat answers — per-seat parsing and the fail-safe human action below are untouched.
  const live = new Set((opts.channels ?? []).map((c) => c.adapter));
  const seats = (cfg.consult.prefer ?? [])
    .map((entry) => ({ adapter: entry.slice(0, entry.indexOf(":")), model: entry.slice(entry.indexOf(":") + 1) }))
    .filter((s) => live.has(s.adapter));
  seats.push({ adapter: cfg.consult.adapter, model: cfg.consult.model });

  for (const [i, seat] of seats.entries()) {
    try {
      const v = await invokeSeat(seat.adapter, seat.model, i);
      if (v) return v;
    } catch {
      // failed seat (unknown adapter, dead driver/pane, shell error) — fall to the next entry
    }
  }
  return { action: "human", notes: "consult verdict unparseable — failing safe to human" };
}
