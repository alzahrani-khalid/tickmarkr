import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { graph, ev, resumed, rawOf } from "../../operator-state/fixture.js";
import { graphDefinitionHash, saveGraph } from "../../../../src/graph/graph.js";
import { validateGraph } from "../../../../src/graph/schema.js";

export const LONG_TASK_ID = `T${"x".repeat(63)}`;
export const FINAL_VERDICT_LINE = "第200行 cafe\u0301 — paging reached the complete verdict";

export function shellFixture() {
  const cwd = mkdtempSync(join(tmpdir(), "final-shell-"));
  const runId = "run-20260905-000000";
  const path = join(cwd, ".tickmarkr", "runs", runId);
  mkdirSync(path, { recursive: true });
  const shellGraph = validateGraph({
    ...graph,
    tasks: [...graph.tasks, {
      ...graph.tasks[0]!,
      id: LONG_TASK_ID,
      title: "组合文字 cafe\u0301 — sixty-four-cell identity fixture",
      deps: [],
    }],
  });
  const verdict = Array.from({ length: 200 }, (_, index) =>
    index === 199 ? FINAL_VERDICT_LINE : `verdict line ${index + 1}`
  ).join("\n");
  const events = resumed.map((event, index) => index === 0
    ? { ...event, data: { ...event.data, graphDefinitionHash: graphDefinitionHash(shellGraph) } }
    : event);
  // Both semantic colours are real mounted rows. They precede run-resume, so
  // the fixture still proves CURRENT TIP PENDING rather than manufacturing a
  // terminal tip merely to make a colour visible.
  events.splice(3, 0,
    ev("gate-result", { gate: "review", pass: false, details: verdict }, "T1"),
    ev("gate-result", { gate: "build", disabled: true }, LONG_TASK_ID),
  );
  saveGraph(cwd, shellGraph);
  writeFileSync(join(path, "journal.jsonl"), rawOf(events));
  return { cwd, runId, close: () => rmSync(cwd, { recursive: true, force: true }) };
}
