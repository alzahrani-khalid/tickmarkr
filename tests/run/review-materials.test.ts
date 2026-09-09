import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { FakeAdapter } from "../../src/adapters/fake.js";
import { shq } from "../../src/adapters/types.js";
import { report } from "../../src/cli/commands/report.js";
import { extractPromptNonce } from "../../src/gates/llm.js";
import { runDaemon } from "../../src/run/daemon.js";
import { Journal, structuredFindings } from "../../src/run/journal.js";
import { COMMIT, setupRepo, T } from "../helpers/tmprepo.js";

test("daemon carries repair materials into re-review and journals their certified closure", async () => {
  const note = "src/mark.ts `select` loses the selected identity after prepend.";
  const [finding] = structuredFindings("review", `- [material] ${note}`);
  const fixture = setupRepo([T("T1")], {
    tasks: { T1: [
      { shell: `mkdir -p src && echo one > src/mark.ts && ${COMMIT} initial`, result: { ok: true, summary: "initial" } },
      { shell: `echo two >> src/mark.ts && ${COMMIT} repair`, result: { ok: true, summary: "repaired" } },
    ] },
  });
  const prompts: string[] = [];
  class ClosingReviewer extends FakeAdapter {
    headlessCommand(promptFile: string, model: string): string {
      const prompt = readFileSync(promptFile, "utf8");
      if (!prompt.startsWith("TICKMARKR-REVIEW")) return super.headlessCommand(promptFile, model);
      prompts.push(prompt);
      const initial = prompts.length === 1;
      const verdict = {
        nonce: extractPromptNonce(prompt), approve: !initial,
        findings: initial ? [{ note, severity: "material" }] : [],
        resolved: prompt.includes("## Prior materials this attempt must close") ? [finding.fingerprint] : [],
        reraised: [],
      };
      return `printf '%s\\n' ${shq(JSON.stringify(verdict))}`;
    }
  }
  const runId = "run-material-closure";
  await runDaemon(fixture.repo, { adapters: [new ClosingReviewer(fixture.scriptPath)], runId });
  const events = Journal.open(fixture.repo, runId).read();
  const repair = events.find((event) => event.event === "task-dispatch" && event.data.retryMode === "repair");
  expect(repair?.data.carriedFindings).toContainEqual(finding);
  expect(prompts[0]).not.toContain("## Prior materials this attempt must close");
  expect(prompts[1]).toContain(note);
  expect(prompts[1]).toContain(finding.fingerprint);
  const approval = events.find((event) => event.event === "gate-result" && event.data.gate === "review"
    && event.data.pass === true && Array.isArray(event.data.resolved) && event.data.resolved.length > 0);
  expect(approval?.data.resolved).toEqual([finding.fingerprint]);
  expect(approval?.data.reraised).toEqual([]);
  expect(await report([runId, "--md"], fixture.repo)).toContain(`resolved: ${finding.fingerprint}`);
});
