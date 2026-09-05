import { spawnSync } from "node:child_process";
import type { TickmarkrConfig } from "../config/config.js";
import type { Task } from "../graph/schema.js";
import { parseWorkerResult, type ClassifiedWorkerResult } from "./prompt.js";
import {
  type Assignment,
  type AuthHealth,
  type BillingChannel,
  channelsFromConfig,
  type Invocation,
  shq,
  type WorkerAdapter,
} from "./types.js";

export const QWEN_VERSION_IDENTITY = /^\d+\.\d+\.\d+/;
const QWEN_SKIP_UPDATE = "QWEN_CODE_SKIP_UPDATE_CHECK_ONCE=true";

interface DecodedQwenEvents {
  assistantText: string;
  failure?: string;
}

function decodeQwenEvents(events: readonly unknown[]): DecodedQwenEvents {
  const text: string[] = [];
  let failed = false;
  let resultText: string | undefined;
  let errorText: string | undefined;
  let denialText: string | undefined;

  for (const event of events) {
    if (!event || typeof event !== "object") continue;
    if ("type" in event && event.type === "assistant" && "message" in event) {
      const message = event.message;
      if (message && typeof message === "object" && "content" in message && Array.isArray(message.content)) {
        for (const content of message.content) {
          if (!content || typeof content !== "object" || !(("type" in content) && content.type === "text")) continue;
          if ("text" in content && typeof content.text === "string") text.push(content.text);
        }
      }
    }

    if ("is_error" in event && event.is_error === true) failed = true;
    if ("type" in event && event.type === "result") {
      if (!(("subtype" in event) && event.subtype === "success")) failed = true;
      if ("result" in event && typeof event.result === "string" && event.result.trim()) {
        resultText ??= event.result.trim();
      }
      // A no-auth host answers `result/error_during_execution` with the cause under `error.message`
      // (verbatim: .planning/assessments/2026-09-04-qwen-live-worker-form/no-auth-home.stdout).
      const error = "error" in event ? event.error : undefined;
      if (error && typeof error === "object" && "message" in error && typeof error.message === "string" && error.message.trim()) {
        errorText ??= error.message.trim();
      }
    }

    if ("permission_denials" in event && Array.isArray(event.permission_denials) && event.permission_denials.length > 0) {
      failed = true;
      denialText ??= event.permission_denials.map(String).join(", ");
    }

    if (!("stats" in event) || !event.stats || typeof event.stats !== "object" || !("models" in event.stats)) continue;
    const models = event.stats.models;
    if (!models || typeof models !== "object") continue;
    for (const model of Object.values(models)) {
      if (!model || typeof model !== "object" || !("api" in model)) continue;
      const api = model.api;
      if (!api || typeof api !== "object" || !("totalErrors" in api)) continue;
      if (typeof api.totalErrors === "number" && api.totalErrors > 0) failed = true;
    }
  }

  const assistantText = text.join("\n");
  const apiError = assistantText.match(/\[API Error:[^\n]*/)?.[0];
  if (apiError) failed = true;
  if (!failed) return { assistantText };
  return {
    assistantText,
    failure: apiError ?? errorText ?? resultText ?? (denialText ? `qwen permission denied: ${denialText}` : "qwen reported a startup failure"),
  };
}

// OBS-903: the daemon hands the adapter the WHOLE captured stream, never qwen's bare stdout — the
// launch script's banner and TICKMARKR_EXIT line sit around it and the subprocess driver appends stderr
// (the headless yolo warning) into the same buffer. The event array is located, not assumed: the bare
// buffer first, then the outermost `[{` … `}]` span. A live PONG completion read as "unparseable" and
// merged only through the harvest path until this (clause-4 probe, RULING-222-42).
function eventArray(raw: string): unknown[] | undefined {
  const start = raw.indexOf("[{");
  const end = raw.lastIndexOf("}]");
  for (const text of [raw.trim(), start !== -1 && end > start ? raw.slice(start, end + 2) : ""]) {
    if (!text.startsWith("[")) continue;
    try {
      const parsed: unknown = JSON.parse(text);
      if (Array.isArray(parsed)) return parsed;
    } catch { /* try the next shape */ }
  }
  return undefined;
}

// Decode qwen's JSON envelope before scanning only decoded assistant text for the worker trailer.
export function parseQwenResult(raw: string, nonce: string): ClassifiedWorkerResult {
  const malformed: ClassifiedWorkerResult = {
    ok: false,
    summary: raw.trim() ? "unparseable qwen JSON event stream" : "qwen produced no JSON event stream",
    deviations: [],
    raw,
    cause: raw.trim() ? "malformed-verdict" : "empty-output",
  };
  const parsed = eventArray(raw);
  if (!parsed) return malformed;

  const decoded = decodeQwenEvents(parsed);
  if (decoded.failure !== undefined) {
    return {
      ok: false,
      summary: decoded.failure,
      deviations: [],
      raw,
      cause: "startup-failure",
    };
  }
  return { ...parseWorkerResult(decoded.assistantText, nonce), raw };
}

function probeQwen(): AuthHealth {
  const result = spawnSync("qwen", ["--version"], { encoding: "utf8", timeout: 10_000 });
  if (result.error || result.status !== 0) return { installed: false, authed: false, models: [] };
  const version = (result.stdout || result.stderr).trim().split("\n")[0] ?? "";
  if (!QWEN_VERSION_IDENTITY.test(version)) {
    return { installed: false, authed: false, models: [], note: `qwen binary identity mismatch: ${version || "empty version"}` };
  }
  return {
    installed: true,
    authed: true,
    version,
    models: [],
    note: "auth assumed; verified at dispatch (qwen reports API failures inside exit-0 success envelopes)",
  };
}

export const qwen: WorkerAdapter = {
  id: "qwen",
  vendor: "alibaba",
  probeCwd: "neutral",
  probe: async () => probeQwen(),
  channels: (cfg: TickmarkrConfig): BillingChannel[] => channelsFromConfig("qwen", cfg),
  hardcodedFlags: { binary: "qwen", flags: ["--safe-mode", "--approval-mode", "-m", "-o", "-p"] },
  headlessCommand: (promptFile: string, model: string) =>
    `${QWEN_SKIP_UPDATE} qwen --safe-mode --approval-mode yolo -m ${shq(model)} -o json -p '' < ${shq(promptFile)}`,
  // OBS-905: qwen has NO interactive form. The `-i "$(cat prompt)"` TUI launch put the whole prompt in
  // argv (the OBS-889 leak-and-census shape) and produced a rendered transcript the JSON decoder above
  // can never read — under the herdr driver every qwen task read "unparseable" and merged only by harvest.
  // The headless form runs in the visible pane and the same parser reads it in every driver; the daemon's
  // mode-fallback branch (daemon.ts, `icmd === null`) journals the choice once per run.
  interactiveCommand: () => null,
  invoke(task: Task, _cwd: string, assignment: Assignment, ctx: { promptFile: string }): Invocation {
    return { command: this.headlessCommand(ctx.promptFile, assignment.model) };
  },
  parse: parseQwenResult,
  trustDialog: {
    kind: "none",
    reason: "qwen 0.21.15 showed no workspace-trust prompt in a fresh repository during the recorded interactive probe (.planning/assessments/2026-09-03-qwen-cli-probe/README.md, 2026-09-03); enabling security.folderTrust falsifies this declaration",
  },
};
