import { tmpdir } from "node:os";
import { join } from "node:path";
import { graphDefinitionHash } from "../../../src/graph/graph.js";
import { validateGraph } from "../../../src/graph/schema.js";
import type { JournalEvent } from "../../../src/run/journal.js";
export const graph = validateGraph({ version: 1, spec: { paths: ["fixture.md"], hash: "fixture-a", source: "native" }, tasks: ["T1", "T2", "T3"].map((id, i) => ({ id, title: `Task ${id}`, goal: "Synthetic task", shape: "implement", complexity: 1, deps: i ? [`T${i}`] : [], files: [], acceptance: ["fixture"] })) });
export const ev = (event: string, data: Record<string, unknown> = {}, taskId?: string): JournalEvent => ({ ts: "2026-09-05T00:00:00.000Z", event, data, ...(taskId ? { taskId } : {}) });
export const partial = [
  ev("run-start", { graphDefinitionHash: graphDefinitionHash(graph), branch: "fixture" }),
  ev("task-dispatch", { attempt: 0 }, "T1"),
  ev("gate-result", { gate: "review", pass: true, details: "First verdict\nSecond line\n第三行" }, "T1"),
  ev("merge", { commit: "abc" }, "T1"),
  ev("task-human", { kind: "human-gate" }, "T2"),
  ev("tip-verify", { pass: true }),
  ev("run-end", { done: ["T1"], failed: [], human: ["T2"], blocked: ["T3"], pending: [], tipVerify: "passed" }),
];
export const approved = [...partial, ev("task-approved", {}, "T2")];
export const resumed = [...approved, ev("run-resume"), ev("task-dispatch", { attempt: 0, worktree: "/recorded/T2", pane: "p2", alarmMs: 45000 }, "T2")];
export const complete = [...resumed, ev("merge", {}, "T2"), ev("merge", {}, "T3"), ev("tip-verify", { pass: true }), ev("run-end", { done: ["T1", "T2", "T3"], failed: [], human: [], blocked: [], pending: [], tipVerify: "passed" })];
export const rawOf = (events: readonly JournalEvent[]) => events.map(e => JSON.stringify(e)).join("\n") + "\n";

export const ORDINARY_HEAP_CAPTURE_PATH = process.env.TICKMARKR_HEAP_CAPTURE_PATH || join(tmpdir(), "tickmarkr-operator-heap-ordinary.json");
export const heapHarnessPath = new URL("./heap-runner.mjs", import.meta.url).pathname;
