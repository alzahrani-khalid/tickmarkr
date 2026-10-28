import { closeSync, constants, existsSync, openSync } from "node:fs";
import { join } from "node:path";
import { stateDirName } from "../graph/graph.js";
import { Journal, parseRunId, visibleControls } from "../run/journal.js";
import { runLockOwner } from "../run/lock.js";
import { statusSnapshot, type StatusSnapshot } from "../cli/commands/status-snapshot.js";
import { classifyWake, JournalTail, type Wake, type WakeCursor } from "../cli/commands/wait.js";
import { createParkPresentation } from "./parks.js";

type Update = Record<string, unknown>;
export type AttachSession = { tools: Map<string, string> };
export type AttachOptions = {
  cwd: string; runId?: string; signal: AbortSignal; session: AttachSession;
  send: (update: Update) => void;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
};
const stateTable = {
  unknown: ["pending", "pending", ""], pending: ["pending", "pending", ""], blocked: ["pending", "pending", ""],
  running: ["in_progress", "in_progress", ""], completed: ["in_progress", "in_progress", ""],
  merged: ["completed", "completed", ""], human: ["pending", "pending", "[needs you] "], failed: ["pending", "failed", "[failed] "],
} as const;
// Keep copyable command whitespace intact while making terminal controls visible.
const safeText = (text: string) => text.replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/gu, visibleControls);

function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    const done = () => { clearTimeout(timer); signal.removeEventListener("abort", done); resolve(); };
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
    if (signal.aborted) done();
  });
}

/** Presentation only: buckets, parks and the green rule belong to statusSnapshot. */
export function finalMessage(state?: StatusSnapshot, reason?: string): string {
  const verdict = state?.verdict;
  const count = (name: keyof StatusSnapshot["verdict"]["buckets"]) => verdict?.buckets[name]?.length ?? "unknown";
  const first = reason ? `NOT GREEN — ${reason}` : verdict?.green ? "GREEN — every clause holds"
    : `NOT GREEN — ${verdict?.fatal ? "fatal run end" : verdict?.outstanding.known === false ? verdict.outstanding.reason : "current status does not satisfy every clause"}`;
  return [first, `done ${state ? state.tasks.filter(task => task.state === "merged").length : "unknown"}; failed ${count("failed")}; parked ${count("human")}; blocked ${count("blocked")}; pending ${count("pending")}; tip ${verdict?.currentTip ?? "unknown"}; owed ${verdict?.outstanding.known ? verdict.outstanding.debt : "unknown"}${verdict?.fatal ? "; fatal run end" : ""}`].map(visibleControls).join("\n");
}

/** Watch without owning the run. Only wait's classifier can supply a terminal observation. */
export async function attach(options: AttachOptions): Promise<{ stopReason: "end_turn" | "cancelled" }> {
  const { cwd, signal, send, session } = options;
  const message = (text: string) => send({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: safeText(text) } });
  let fd: number | undefined;
  try {
    const owner = options.runId === undefined ? runLockOwner(cwd) : undefined;
    const selected = options.runId ?? (owner?.live ? owner.runId : undefined) ?? Journal.latestRunId(cwd, { withJournal: true });
    if (!selected) { message("No journalled run to attach to."); return { stopReason: "end_turn" }; }
    // A mistyped id (`/attach 4099`) is a usage problem, never an unreadable journal of some run.
    let runId: string;
    try { runId = parseRunId(selected); } catch { message(`Not a run id: ${visibleControls(selected)}`); return { stopReason: "end_turn" }; }
    const path = join(cwd, stateDirName(cwd), "runs", runId, "journal.jsonl");
    if (!existsSync(path)) { message(`No journal for ${runId}; nothing to watch yet.`); return { stopReason: "end_turn" }; }
    fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
    const tail = new JournalTail(path, fd);
    const cursor: WakeCursor = {};
    const alerts: string[] = [];
    const parks = createParkPresentation(cwd, runId, text => alerts.push(text));
    const flushAlerts = () => { for (const text of alerts.splice(0)) message(text); };
    let plan: string | undefined;
    let warned = false;
    const render = (state: StatusSnapshot) => {
      const entries = state.tasks.map(task => {
        const [status, , prefix] = stateTable[task.state];
        return { content: visibleControls(`${prefix}${task.id} · ${task.title}`), priority: "medium", status };
      });
      const nextPlan = JSON.stringify(entries);
      if (plan !== nextPlan) { send({ sessionUpdate: "plan", entries }); plan = nextPlan; }
      const blocks = parks.render(state);
      state.tasks.forEach((task, index) => {
        const toolCallId = `${runId}/${task.id}`;
        const detail = visibleControls(`state ${task.state}; gates ${Object.entries(task.gates).map(([gate, status]) => `${gate} ${status}`).join(", ")}; tries ${task.tries.round ?? "unknown"}/${task.tries.budget}, launches ${task.tries.launches}; seats worker ${task.seats.worker ?? "unknown"}, judge ${task.seats.judge ?? "unknown"}, reviewer ${task.seats.reviewer ?? "unknown"}; phase ${task.now.phase ?? "unknown"}; window ${state.approvalWindow ? `${state.approvalWindow.opensAt} to ${state.approvalWindow.closesAt}` : "none"}`);
        const block = blocks.get(task.id);
        const text = block ? `${detail}\n${safeText(block)}` : detail;
        const tool = { toolCallId, title: entries[index]!.content, kind: "execute", status: stateTable[task.state][1],
          content: [{ type: "content", content: { type: "text", text } }] };
        const encoded = JSON.stringify(tool);
        const previous = session.tools.get(toolCallId);
        if (previous !== encoded) {
          send({ sessionUpdate: previous === undefined ? "tool_call" : "tool_call_update", ...tool });
          session.tools.set(toolCallId, encoded);
        }
      });
    };
    for (;;) {
      if (signal.aborted) return { stopReason: "cancelled" };
      // Intentionally re-read the whole journal, including owed artifacts, on EVERY tick.
      try { render(statusSnapshot(cwd, runId)); }
      catch {
        if (!warned) { message("Status unavailable; still watching."); warned = true; }
      }
      let terminal: Wake | undefined;
      for (let wake = classifyWake(tail, cursor); wake; wake = classifyWake(tail, cursor)) {
        if (wake.cause === "run-end" || wake.cause === "daemon-death") { terminal = wake; break; }
      }
      parks.windows(tail.events, tail.completeLineCount);
      if (terminal) {
        let final: StatusSnapshot | undefined;
        let fault: string | undefined;
        try { final = statusSnapshot(cwd, runId); render(final); }
        catch { fault = "final status unreadable"; }
        // A snapshot opens the path independently: never accept replacement/truncated bytes.
        tail.read();
        if (signal.aborted) return { stopReason: "cancelled" };
        // When attaching to an already closed run, its last new alert can share the final
        // receipt. Each park still gets one message, and the verdict remains the first line.
        const lastAlert = alerts.pop();
        flushAlerts();
        message([finalMessage(final, terminal.cause === "daemon-death"
          ? `daemon dead at journal line ${terminal.line}; tickmarkr resume ${runId}` : fault),
          ...(lastAlert === undefined ? [] : [lastAlert])].join("\n"));
        return { stopReason: "end_turn" };
      }
      flushAlerts();
      await (options.sleep ?? pause)(1000, signal);
    }
  } catch (fault) {
    if (signal.aborted) return { stopReason: "cancelled" };
    message(finalMessage(undefined, `unreadable journal: ${fault instanceof Error ? fault.message : String(fault)}`));
    return { stopReason: "end_turn" };
  } finally { if (fd !== undefined) closeSync(fd); }
}
