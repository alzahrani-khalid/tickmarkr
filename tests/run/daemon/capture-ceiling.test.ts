import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { stringify } from "yaml";
import { afterEach, expect, test, vi } from "vitest";
import { graphDefinitionHash, loadGraph } from "../../../src/graph/graph.js";
import { runDaemon } from "../../../src/run/daemon.js";
import * as git from "../../../src/run/git.js";
import { Journal } from "../../../src/run/journal.js";
import { setupRepo, T } from "../../helpers/tmprepo.js";

const minute = 60_000;
const commands = { build: "daemon-ceiling-build", test: "daemon-ceiling-test", lint: "daemon-ceiling-lint" };
afterEach(() => vi.restoreAllMocks());

test("test: the daemon's run-start capture and a resume's recapture of an absent baseline each scale every command's ceiling from the newest recorded baseline and keep thirty minutes without one, so a capture site that ignores it fails", async () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  const original = git.sh;
  const seen: Array<{ command: string; cwd: string; timeout: number | undefined }> = [];
  vi.spyOn(git, "sh").mockImplementation(async (cmd, cwd, timeout, opts) => {
    if (!Object.values(commands).includes(cmd)) return original(cmd, cwd, timeout, opts);
    seen.push({ command: cmd, cwd, timeout });
    return { code: 0, stdout: "", stderr: "", durationMs: 1_000 };
  });
  for (const resume of [false, true]) {
    for (const withPrior of [false, true]) {
      const { repo, fake } = setupRepo([T("T1", { humanGate: true, ...(resume ? { status: "human" } : {}) })], { tasks: {} }, stringify({ gates: commands }));
      const baseRef = await git.gitHead(repo);
      if (withPrior) {
        const older = Journal.create(repo, "run-20260101-000000");
        older.append("run-start", undefined, { baseRef, commands });
        writeFileSync(join(older.dir, "baseline.json"), JSON.stringify({ commands: {
          build: { durationMs: 10 * 60 * minute }, test: { ceilingMs: 200 * minute }, lint: { ceilingMs: 200 * minute },
        } }));
        const newest = Journal.create(repo, "run-20260102-000000");
        newest.append("run-start", undefined, { baseRef, commands });
        writeFileSync(join(newest.dir, "baseline.json"), JSON.stringify({ commands: {
          build: { durationMs: 2_000_000 }, test: { durationMs: 28 * minute, ceilingMs: 84 * minute }, lint: null,
        } }));
        // Later runs whose capture never completed cannot erase the newest recorded measurement.
        const torn = Journal.create(repo, "run-20260103-000000");
        torn.append("run-start", undefined, { baseRef, commands });
        writeFileSync(join(torn.dir, "baseline.json"), '{"commands":');
        Journal.create(repo, "run-20260104-000000").append("run-start", undefined, { baseRef, commands });
      }
      const runId = "run-20261029-000000";
      if (resume) {
        const interrupted = Journal.create(repo, runId);
        interrupted.append("baseline-start", undefined, { baseRef, commands });
        interrupted.append("run-start", undefined, { baseRef, commands, graphDefinitionHash: graphDefinitionHash(loadGraph(repo)) });
        expect(existsSync(join(interrupted.dir, "baseline.json"))).toBe(false);
      }
      seen.length = 0;
      await runDaemon(repo, { adapters: [fake], runId, resume });
      expect(seen.map(row => [row.command, row.timeout])).toEqual([
        [commands.build, withPrior ? 6_000_000 : 30 * minute],
        [commands.test, withPrior ? 84 * minute : 30 * minute],
        [commands.lint, 30 * minute],
      ]);
      expect(seen.every(row => resume ? row.cwd !== repo : row.cwd === repo)).toBe(true);
      const journal = Journal.open(repo, runId);
      const captured = JSON.parse(readFileSync(join(journal.dir, "baseline.json"), "utf8"));
      expect(captured.provenance.baseRef).toBe(baseRef);
      expect(Object.keys(captured.commands)).toEqual(Object.keys(commands));
      expect(journal.read().filter(row => row.event === "baseline-recapture-complete")).toHaveLength(resume ? 1 : 0);
    }
  }
}, 120_000);
