import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import type { Readable } from "node:stream";
import { AcpError, createAcpPeer, isObject } from "./peer.js";
import { attach, finalMessage, type AttachSession } from "./attach.js";
import { listRuns } from "../run/runs-list.js";
import { launchDaemon, runCli } from "../run/launch.js";
import { runLockOwner } from "../run/lock.js";
import { statusSnapshot } from "../cli/commands/status-snapshot.js";
import { parseRunId, visibleControls } from "../run/journal.js";

const invalid = (): never => { throw new AcpError(-32602, "Invalid params"); };
const metadata = (value: unknown) => value === undefined || value === null || isObject(value);
const unreadTypes = new Set(["image", "audio", "resource", "resource_link"]);
// The shape session/new mints. A console session holds only its cwd, so one from this process or an earlier one resumes
// idle (ACP-RESUME-001): a client restoring a thread by the id it was given must not be told the session is gone.
const consoleId = /^acp-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// Match the pinned v1 TextContent/Annotations shapes without coercing any field. Other
// recognized content kinds are intentionally opaque: no decoding, fetching or execution.
function contentBlock(value: unknown): boolean {
  if (!isObject(value)) return false;
  if (value.type !== "text") return typeof value.type === "string" && unreadTypes.has(value.type);
  if (typeof value.text !== "string" || !metadata(value._meta)) return false;
  const annotations = value.annotations;
  if (annotations === undefined || annotations === null) return true;
  if (!isObject(annotations) || !metadata(annotations._meta)) return false;
  return (annotations.audience === undefined || annotations.audience === null
      || (Array.isArray(annotations.audience) && annotations.audience.every((role) => role === "user" || role === "assistant")))
    && (annotations.lastModified === undefined || annotations.lastModified === null || typeof annotations.lastModified === "string")
    && (annotations.priority === undefined || annotations.priority === null
      || (typeof annotations.priority === "number" && Number.isFinite(annotations.priority)));
}

// Child output keeps its spacing (plan's routing table is column-aligned) inside a fence longer than any backtick run it holds;
// controls still print as visible escapes, as in attach.
export const preformatted = (output: string): string => {
  const body = output.replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/gu, visibleControls).replace(/\n+$/u, "");
  let longest = 0; // a loop, not a spread: output may hold more backtick runs than a call can take arguments
  for (const run of body.matchAll(/`+/gu)) longest = Math.max(longest, run[0].length);
  const fence = "`".repeat(Math.max(3, longest + 1));
  return `${fence}text\n${body}\n${fence}`;
};

type Session = AttachSession & { cwd: string; runId?: string; turn?: AbortController };

const availableCommands = [
  { name: "attach", description: "Watch a run", input: { hint: "[run]" } },
  { name: "status", description: "Read a run's current status", input: { hint: "[run]" } },
  { name: "compile", description: "Compile a spec after checking the CLI version", input: { hint: "<spec>" } },
  { name: "plan", description: "Preview routing after checking the CLI version" },
  { name: "run", description: "Launch a detached run and watch it" },
  { name: "resume", description: "Resume a detached run and watch it", input: { hint: "<run id>" } },
];

export function createAcpAgent(options: {
  input: Readable;
  write: (line: string) => void;
  stderr?: (text: string) => void;
  env?: NodeJS.ProcessEnv;
  reply?: (cwd: string, text: string, signal: AbortSignal) => string | Promise<string>;
}) {
  let initialized = false;
  let ended = false;
  const launchDirectory = process.cwd();
  const env = options.env ?? process.env;
  const sessions = new Map<string, Session>();
  // ACP clients append consecutive agent_message_chunk texts into one message, and every chunk acp sends is a whole paragraph
  // (an alert, a launch line, a verdict), so each ends with a blank line: the next one never runs into its last line.
  const send = (sessionId: string, update: Record<string, unknown>) => peer.notify("session/update", { sessionId,
    update: update.sessionUpdate === "agent_message_chunk" && isObject(update.content) && typeof update.content.text === "string"
      ? { ...update, content: { ...update.content, text: `${update.content.text}\n\n` } } : update });
  const selectedRun = (session: Session) => {
    if (session.runId) return session.runId;
    const owner = runLockOwner(session.cwd);
    return (owner?.live ? owner.runId : undefined) ?? listRuns(session.cwd)[0]?.runId;
  };
  // Peer responses are written in a microtask. Defer lifecycle updates to the next turn so
  // the answer always precedes commands and replay, even for an already-ended run.
  const afterAnswer = (sessionId: string, session: Session, replay = false) => {
    setImmediate(() => {
      if (ended || sessions.get(sessionId) !== session) return;
      send(sessionId, { sessionUpdate: "available_commands_update", availableCommands });
      if (replay) {
        const controller = new AbortController();
        void attach({ cwd: session.cwd, runId: session.runId, session, signal: controller.signal,
          send: update => { if (update.sessionUpdate !== "agent_message_chunk") send(sessionId, update); },
          sleep: async () => { controller.abort(); },
        });
      }
    });
  };
  const sessionFor = (params: unknown): [string, Session] => {
    if (!isObject(params) || typeof params.sessionId !== "string") return invalid();
    const session = sessions.get(params.sessionId);
    if (!session) return invalid();
    return [params.sessionId, session];
  };
  const peer = createAcpPeer({
    ...options,
    onEnd: () => { ended = true; for (const session of sessions.values()) session.turn?.abort(); },
    isInitialized: () => initialized,
    requests: {
      initialize(params) {
        if (!isObject(params) || !Number.isInteger(params.protocolVersion)
          || (params.protocolVersion as number) < 0 || (params.protocolVersion as number) > 65535) return invalid();
        const { version } = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as { version: string };
        initialized = true;
        return {
          protocolVersion: 1,
          agentInfo: { name: "tickmarkr", version },
          authMethods: [],
          agentCapabilities: { loadSession: false, sessionCapabilities: { list: {}, resume: {}, close: {} } },
        };
      },
      "session/new"(params) {
        if (!isObject(params) || typeof params.cwd !== "string" || !isAbsolute(params.cwd) || !Array.isArray(params.mcpServers)) return invalid();
        const sessionId = `acp-${randomUUID()}`;
        const session: Session = { cwd: params.cwd, tools: new Map() };
        sessions.set(sessionId, session);
        afterAnswer(sessionId, session);
        return { sessionId };
      },
      "session/list"(params) {
        if (params === undefined) params = {};
        if (!isObject(params) || (params.cwd != null && (typeof params.cwd !== "string" || !isAbsolute(params.cwd)))
          || (params.cursor != null && typeof params.cursor !== "string")) return invalid();
        const cwd = typeof params.cwd === "string" ? params.cwd : launchDirectory;
        const runs = listRuns(cwd);
        const cursor = params.cursor == null ? -1 : runs.findIndex(run => run.runId === params.cursor);
        if (params.cursor != null && cursor === -1) return invalid();
        const page = runs.slice(cursor + 1, cursor + 51);
        return { sessions: page.map(({ runId, ...run }) => ({ sessionId: runId, cwd, ...run })),
          ...(cursor + 1 + page.length < runs.length ? { nextCursor: page.at(-1)!.runId } : {}) };
      },
      "session/resume"(params) {
        if (!isObject(params) || typeof params.sessionId !== "string" || typeof params.cwd !== "string" || !isAbsolute(params.cwd)
          || (params.mcpServers !== undefined && !Array.isArray(params.mcpServers))) return invalid();
        const isRun = listRuns(params.cwd).some(run => run.runId === params.sessionId);
        if (!isRun && !consoleId.test(params.sessionId)) throw new AcpError(-32002, "Session not found");
        const previous = sessions.get(params.sessionId);
        if (previous?.turn) throw new AcpError(-32600, "Session has an active turn");
        const session: Session = { cwd: params.cwd, ...(isRun ? { runId: params.sessionId } : {}), tools: new Map() };
        sessions.set(params.sessionId, session);
        afterAnswer(params.sessionId, session, isRun);
        return {};
      },
      "session/close"(params) {
        const [sessionId, session] = sessionFor(params);
        session.turn?.abort();
        sessions.delete(sessionId);
        return {};
      },
      async "session/prompt"(params) {
        const [sessionId, session] = sessionFor(params);
        if (session.turn) throw new AcpError(-32600, "Session has an active turn");
        if (!isObject(params) || !Array.isArray(params.prompt) || !params.prompt.every(contentBlock)) return invalid();
        const text = params.prompt.filter((block) => block.type === "text").map((block) => block.text).join("\n");
        const turn = new AbortController();
        session.turn = turn;
        try {
          // Yield so cancellation in the same input batch can end this running turn.
          await new Promise<void>((resolve) => setImmediate(resolve));
          if (turn.signal.aborted) return { stopReason: "cancelled" };
          const words = text.trim().split(/\s+/u);
          const message = (text: string) => send(sessionId, { sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: text.split("\n").map(visibleControls).join("\n") } });
          if (words[0] === "/run" || words[0] === "/resume") {
            const verb = words[0] === "/run" ? "run" : "resume";
            let runId: string | undefined;
            let valid = words.length === (verb === "run" ? 1 : 2);
            if (verb === "resume" && valid) {
              try { runId = parseRunId(words[1]!); } catch { valid = false; }
            }
            if (!valid) {
              message(`Usage: /${verb}${verb === "resume" ? " <run id>" : ""}`);
              return { stopReason: "end_turn" };
            }
            const launched = await launchDaemon({ cwd: session.cwd, verb, runId, env,
              cancelled: () => turn.signal.aborted });
            if (turn.signal.aborted || launched.status === "cancelled") return { stopReason: "cancelled" };
            if (launched.status === "refused") {
              message(launched.message);
              return { stopReason: "end_turn" };
            }
            session.runId = launched.runId;
            send(sessionId, { sessionUpdate: "session_info_update", title: launched.runId });
            message(`Run ${launched.runId}: pid ${launched.pid}; driver ${launched.driver}; log ${launched.logPath}`);
            return await attach({ cwd: session.cwd, runId: session.runId, signal: turn.signal, session,
              send: update => send(sessionId, update) });
          }
          if (words[0] === "/status") {
            if (words.length > 2 || words[1]?.startsWith("-")) message("Usage: /status [run]");
            else {
              const runId = words[1] ?? selectedRun(session);
              try {
                if (!runId) throw new Error("No journalled run.");
                const state = statusSnapshot(session.cwd, runId);
                message([`Run: ${state.runId}`, `Lifecycle: ${state.lifecycle}`, `Daemon: ${state.daemon}`, finalMessage(state),
                  ...state.parks.map(park => `${park.taskId}: ${park.commands.map(command => command.command).join("; ")}${park.noDecision ? `; ${park.noDecision}` : ""}`)].join("\n"));
              } catch (fault) { message(`Status unavailable: ${fault instanceof Error ? fault.message : String(fault)}`); }
            }
            return { stopReason: "end_turn" };
          }
          if (words[0] === "/compile" || words[0] === "/plan") {
            const command = words[0].slice(1);
            if (words.length !== (command === "compile" ? 2 : 1) || words.slice(1).some(word => word.startsWith("-"))) {
              message(`Usage: /${command}${command === "compile" ? " <spec>" : ""}`);
            } else {
              const check = await runCli(session.cwd, ["version", "--check"], env, turn.signal);
              if (turn.signal.aborted) return { stopReason: "cancelled" };
              const result = check.exitCode === 0 ? await runCli(session.cwd, [command, ...words.slice(1)], env, turn.signal) : check;
              if (turn.signal.aborted) return { stopReason: "cancelled" };
              send(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text",
                text: `${check.exitCode === 0 ? command : "version --check"} exited ${result.exitCode}\n${preformatted(result.output)}` } });
            }
            return { stopReason: "end_turn" };
          }
          const command = /^\/attach(?:\s+(\S+))?\s*$/u.exec(text.trim());
          if (command || (session.runId && !text.trim().startsWith("/"))) {
            // An explicit attachment selects this turn's run without changing its binding.
            const runId = command?.[1] ?? selectedRun(session);
            return await attach({ cwd: session.cwd, runId, signal: turn.signal, session,
              send: update => send(sessionId, update) });
          }
          const reply = await (options.reply?.(session.cwd, text, turn.signal)
            ?? `Session directory: ${session.cwd}\nCommands: /attach [run], /status [run], /compile <spec>, /plan, /run, /resume <run id>, initialize, session/new, session/list, session/resume, session/close, session/prompt, session/cancel.`);
          if (turn.signal.aborted) return { stopReason: "cancelled" };
          message(reply);
          return { stopReason: "end_turn" };
        } catch (fault) {
          if (turn.signal.aborted) return { stopReason: "cancelled" };
          throw fault;
        } finally { delete session.turn; }
      },
    },
    notifications: {
      "session/cancel"(params) {
        const [, session] = sessionFor(params);
        session.turn?.abort();
      },
    },
  });
  return peer;
}
