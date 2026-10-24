import { expect, test } from "vitest";
import { status } from "../../src/cli/commands/status.js";
import { graphDefinitionHash, loadGraph } from "../../src/graph/graph.js";
import { Journal } from "../../src/run/journal.js";
import { setupRepo, T } from "../helpers/tmprepo.js";

test("status of a run whose task's newest acceptance row records the judge as not independent names that task's judge as not independent, while a run whose rows carry no such record prints no such note, so a record that no operator surface shows fails", async () => {
  const { repo } = setupRepo([T("T1"), T("T2"), T("T3")], {});
  const journal = Journal.create(repo, "run-judge-status");
  journal.append("run-start", undefined, { graphDefinitionHash: graphDefinitionHash(loadGraph(repo)) });
  const verdict = (task: string, flagged: boolean) => journal.append("gate-result", task, {
    gate: "acceptance", pass: true, ...(flagged ? { judgeIndependent: false } : {}),
  });
  verdict("T1", true);
  verdict("T2", true);
  verdict("T2", false);
  verdict("T3", false);
  journal.append("gate-result", "T1", { gate: "review", pass: true });
  for (const tty of [false, true]) {
    const descriptor = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
    Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: tty });
    try {
      const output = (await status([], repo)).replace(/\x1b\[[0-9;]*m/g, "");
      expect(output).toContain("T1 judge not independent");
      expect(output).not.toContain("T2 judge not independent");
      expect(output).not.toContain("T3 judge not independent");
    } finally {
      if (descriptor) Object.defineProperty(process.stdout, "isTTY", descriptor);
      else Reflect.deleteProperty(process.stdout, "isTTY");
    }
  }
  expect(await status(["--oneline"], repo)).toContain("T1 judge not independent");
  verdict("T1", false);
  expect(await status([], repo)).not.toContain("judge not independent");
  expect(await status(["--oneline"], repo)).not.toContain("judge not independent");
  const clean = setupRepo([T("T1")], {});
  const cleanJournal = Journal.create(clean.repo, "run-clean-status");
  cleanJournal.append("run-start", undefined, { graphDefinitionHash: graphDefinitionHash(loadGraph(clean.repo)) });
  cleanJournal.append("gate-result", "T1", { gate: "acceptance", pass: true });
  expect(await status([], clean.repo)).not.toContain("judge not independent");
});
