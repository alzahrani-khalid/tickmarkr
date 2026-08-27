import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, expect, test } from "vitest";
import { shq } from "../../src/adapters/types.js";
import { beat } from "../../src/cli/commands/beat.js";
import { status } from "../../src/cli/commands/status.js";
import { tickmarkrDir } from "../../src/graph/graph.js";
import { runDaemon } from "../../src/run/daemon.js";
import {
  supervisionBeatPath,
  supervisionStandDownPath,
  supervisionStatus,
} from "../../src/run/supervision.js";
import { COMMIT, makeTestTempDir, setupRepo, T } from "../helpers/tmprepo.js";

// D10: this suite observes the two legitimate authors independently. The daemon enters only through
// runDaemon and is never given a supervision writer; a supervising seat enters only through the
// shipped beat verb. If either author writes the other's record, the disk assertions expose it.

const activeChildren = new Set<ChildProcess>();
afterEach(() => {
  for (const child of activeChildren) child.kill("SIGKILL");
  activeChildren.clear();
});

const waitFor = async (
  predicate: () => boolean,
  label: string,
  timeoutMs: number,
  detail: () => string = () => "",
): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${label}${detail()}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
};

interface LiveRunFixture {
  repo: string;
  scriptPath: string;
  stop: string;
}

/** A real run held inside its worker until the observer has read a live status frame. */
const liveRunFixture = (): LiveRunFixture => {
  const stop = join(makeTestTempDir("tickmarkr-sup-stop-"), "stop");
  const { repo, scriptPath } = setupRepo(
    [T("T1")],
    { tasks: { T1: [{
      shell: `while [ ! -f ${shq(stop)} ]; do sleep 0.05; done; echo done > done.txt && ${COMMIT} done`,
      result: { ok: true, summary: "done" },
    }] } },
  );
  return { repo, scriptPath, stop };
};

const spawnDaemon = (fixture: LiveRunFixture, runId: string): { child: ChildProcess; stderr: () => string } => {
  const root = join(import.meta.dirname, "..", "..");
  const daemonUrl = pathToFileURL(join(root, "src", "run", "daemon.ts")).href;
  const fakeUrl = pathToFileURL(join(root, "src", "adapters", "fake.ts")).href;
  const childCode = `
    import { runDaemon } from ${JSON.stringify(daemonUrl)};
    import { FakeAdapter } from ${JSON.stringify(fakeUrl)};
    await runDaemon(${JSON.stringify(fixture.repo)}, {
      adapters: [new FakeAdapter(${JSON.stringify(fixture.scriptPath)})],
      runId: ${JSON.stringify(runId)},
    });
  `;
  const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", childCode], {
    stdio: ["ignore", "ignore", "pipe"],
  });
  activeChildren.add(child);
  let err = "";
  child.stderr?.on("data", (chunk: Buffer) => { err += chunk.toString(); });
  return { child, stderr: () => err ? `\nchild stderr:\n${err}` : "" };
};

test("test: a run driven to its own end through the production entry leaves the orchestrator tier reading never-armed in the same frame that names that run's daemon process alive; a run that arms the tier for itself reports a supervising seat nobody occupies and fails", async () => {
  const fixture = liveRunFixture();
  const runId = "run-no-daemon-supervision";
  const { child, stderr } = spawnDaemon(fixture, runId);
  const journalPath = join(tickmarkrDir(fixture.repo), "runs", runId, "journal.jsonl");
  await waitFor(
    () => existsSync(journalPath) && readFileSync(journalPath, "utf8").includes('"event":"worker-launch"'),
    "the production run to reach its held worker",
    90_000,
    stderr,
  );

  const liveFrame = await status([], fixture.repo);
  expect(liveFrame).toContain(`daemon pid ${child.pid} alive`);
  expect(liveFrame.split("\n").find((line) => line.includes("supervision:")))
    .toContain("orchestrator ABSENT");
  expect(existsSync(supervisionBeatPath(fixture.repo, "orchestrator"))).toBe(false);

  writeFileSync(fixture.stop, "stop\n");
  await waitFor(() => child.exitCode !== null, "the production run to reach its own run-end", 120_000, stderr);
  activeChildren.delete(child);
  expect(child.exitCode, stderr()).toBe(0);
  expect(readFileSync(journalPath, "utf8")).toContain('"event":"run-end"');
  expect(supervisionStatus(fixture.repo, "orchestrator").state).toBe("ABSENT");
  expect(existsSync(supervisionStandDownPath(fixture.repo, "orchestrator"))).toBe(false);
}, 150_000);

test("test: a seat's beat written through the shipped verb before a run is byte-identical after that run ends and its tier still names that seat as armed; a second writer that overwrites or stands down that record reports a live seat as gone and fails", async () => {
  const fixture = setupRepo([T("T1", { humanGate: true })], { tasks: {} });
  const seat = "ORCH-w1:p1";
  await beat(["orchestrator", "--seat", seat], fixture.repo);
  const beatPath = supervisionBeatPath(fixture.repo, "orchestrator");
  const before = readFileSync(beatPath);
  const beforeStat = statSync(beatPath);

  await runDaemon(fixture.repo, {
    adapters: [fixture.fake],
    runId: "run-preserves-seat-beat",
  });

  expect(readFileSync(beatPath)).toEqual(before);
  expect(statSync(beatPath).mtimeMs).toBe(beforeStat.mtimeMs);
  expect(existsSync(supervisionStandDownPath(fixture.repo, "orchestrator"))).toBe(false);
  expect(supervisionStatus(fixture.repo, "orchestrator"))
    .toMatchObject({ state: "ARMED", seat });
  expect(await status([], fixture.repo)).toContain(`orchestrator ARMED (${seat})`);
}, 120_000);
