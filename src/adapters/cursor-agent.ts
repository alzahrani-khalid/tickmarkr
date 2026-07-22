import { spawnSync } from "node:child_process";
import type { TickmarkrConfig } from "../config/config.js";
import type { Task } from "../graph/schema.js";
import { probeVersion } from "./claude-code.js";
import { parseWorkerResult } from "./prompt.js";
import { type Assignment, type BillingChannel, channelsFromConfig, type Invocation, MODEL_ID_RE, shq, type TrustDialog, type WorkerAdapter } from "./types.js";

// v1.22 T5 / OBS-19: cursor's interactive TUI parks on this exact dialog for every fresh worktree
// (--trust is print-only). No durable trusted-folders store is seedable from doctor; the daemon
// auto-answers Enter once per slot when the pane matches this fingerprint.
export const CURSOR_TRUST_DIALOG: TrustDialog = {
  fingerprint: "Workspace Trust Required",
  key: "Enter",
};

// v1.5 MODEL-01: pure parser for `cursor-agent --list-models` (header "Available models", blank,
// then "id - Display Name" per line). Live-verified 2026-07-10, cursor-agent 2026.07.08.
// Token before " - "; `auto` is KEPT (raw persistence — lint-side filtering is Plan 08-02).
export function parseCursorModels(raw: string): string[] {
  return raw.trim().split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && l !== "Available models")
    .map((l) => l.split(" - ")[0].trim())
    .filter((id) => MODEL_ID_RE.test(id));
}

// SPEND-08: collectUsage is DELIBERATELY ABSENT — won't-implement-with-documented-reason,
// consistent with `.planning/REQUIREMENTS.md` SPEND-08 and `.planning/ROADMAP.md` Phase 29 Success
// Criterion #2 (operator disposition logged `.overseer/DECISIONS.md` 2026-07-11). Evidence:
// `.planning/phases/29-fleet-metering/29-RESEARCH.md` (cursor-agent 2026.07.09 exhaustive on-disk probe).
// NO billing usage in any store — `chats/<md5(cwd)>/store.db` = schema-less protobuf whose token-shaped
// varints decode to context-window occupancy, not billing tokens; `agent-transcripts/*.jsonl` = text-only
// (no usage, no per-record timestamp, no cwd); `ai-tracking` = code attribution only. The known
// `result.usage.*` is stdout-only behind `--print --trust`: a stdout tee is NOT "the adapter's own
// on-disk session store" (metering honesty invariant, REQUIREMENTS.md) AND is unavailable in the
// default interactive worker mode; a guessed protobuf parser is banned (SPEND-10 discipline). Consequence:
// cursor channels report honestly `unmetered`. Revisit if a future cursor-agent version persists usage
// on disk (re-probe is one ls + one sqlite3 .tables away).
export const cursorAgent: WorkerAdapter = {
  id: "cursor-agent",
  vendor: "cursor",
  probe: async () => probeVersion("cursor-agent"),
  channels: (cfg: TickmarkrConfig): BillingChannel[] => channelsFromConfig("cursor-agent", cfg),
  // v1.65 T3: every flag the command builders below hardcode — verified in `cursor-agent --help` 2026-07-22.
  hardcodedFlags: { binary: "cursor-agent", flags: ["-p", "--model", "--force", "--output-format"] },
  headlessCommand: (promptFile: string, model: string) =>
    `cursor-agent -p "$(cat ${shq(promptFile)})" --model ${shq(model)} --force --output-format text`,
  // NO --trust here: cursor rejects it outside --print ("--trust can only be used with --print/headless
  // mode", exit 1 — v1.4 phase-1 incident). Fresh worktrees therefore show the trust dialog; v1.22 T5
  // auto-answers it once per slot via trustDialog (OBS-19 burned 4×35m attempts without this).
  interactiveCommand: (promptFile: string, model: string) =>
    `cursor-agent --model ${shq(model)} --force "$(cat ${shq(promptFile)})"`,
  invoke(task: Task, _cwd: string, a: Assignment, ctx: { promptFile: string }): Invocation {
    return { command: this.headlessCommand(ctx.promptFile, a.model) };
  },
  parse: parseWorkerResult,
  // v1.22 T5: no writable durable store for interactive trust (headless --trust is non-persistent and
  // print-only). Doctor names the dialog; the daemon auto-answers it via trustDialog once per slot.
  trust: () => ({
    status: "action-required",
    command: 'accept the cursor-agent "Workspace Trust Required" dialog (Enter) — tickmarkr auto-answers once per slot',
  }),
  trustDialog: CURSOR_TRUST_DIALOG,
  // v1.5 MODEL-01: fail OPEN to [] (advisory detection, unlike gates). --list-models may touch the
  // network (1.35s wall vs 0.34s CPU, RESEARCH A1); 15s timeout + fail-open covers offline.
  // Live-verified 2026-07-10, cursor-agent 2026.07.08.
  listModels: async () => {
    const r = spawnSync("cursor-agent", ["--list-models"], { encoding: "utf8", timeout: 15000 });
    return r.error || r.status !== 0 ? [] : parseCursorModels(r.stdout || "");
  },
};
