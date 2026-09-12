import { isolatedBuild } from "../fixtures/screen-soak/isolated-build.js";
import { spawnSync } from "node:child_process";
import { appendFileSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { saveGraph } from "../../src/graph/graph.js";
import { graph, partial, rawOf, ev } from "../fixtures/operator-state/fixture.js";
import { makeRepo } from "../helpers/tmprepo.js";
import { observer, root } from "../fixtures/screen-soak/test-support.js";

const entries = partial.map(row => row.event === "task-dispatch" ? { ...row, data: { ...row.data, assignment: { adapter: "fake", model: "fixture", vendor: "fake", channel: "sub", tier: "cheap" } } } : row);
function seed(repo: string, id: string, rows = entries) {
  const dir = join(repo, ".tickmarkr", "runs", id); mkdirSync(dir, { recursive: true });
  const path = join(dir, "journal.jsonl"); writeFileSync(path, rawOf(rows)); return path;
}

test("The production dispatcher’s ui [id] --view run, ui --setup [id] and TTY status --watch reach C1’s Run for that exact ID, with --setup opening Parks. Implicit no-run UI opens useful Home, invalid explicit ID refuses and a newer run cannot redirect an explicit observer. Plain/non-TTY watch and event/jsonl/decision-events aliases preserve replay/schema/stdout-stderr/keepalive contracts through pure lazy-import paths. A mounted demo substitute, accidental Ink import on print, paid navigation probe or invented deferred view fails.", async () => {
  const repo = makeRepo({ "base.txt": "fixture" }); saveGraph(repo, graph);
  const path = seed(repo, "run-observed");
  for (const [command, args, wanted] of [
    ["ui", ["run-observed", "--view", "run"], "RUN / PARTIAL"],
    ["ui", ["--setup", "run-observed"], "PARK / T2"],
    ["status", ["run-observed", "--watch"], "RUN / PARTIAL"],
  ] as const) {
    const run = await observer(repo, command, [...args]);
    try {
      await expect.poll(() => run.snapshot().stdout, { timeout: 5000 }).toContain(wanted);
      expect(run.snapshot().stdout).toContain("1 Home");
      expect(run.snapshot().stdout).toContain("5 Evidence");
      expect(run.snapshot().presence).toHaveLength(1);
      seed(repo, "run-zz-newer", [ev("run-start"), ev("task-dispatch", { attempt: 0 }, "FOREIGN")]);
      appendFileSync(path, rawOf([ev("run-resume"), ev("task-dispatch", { attempt: 0 }, "T2")]));
      run.send({ key: "4" });
      await expect.poll(() => run.snapshot().stdout, { timeout: 5000 }).toContain("RUN / RUNNING");
      expect(run.snapshot().stdout).not.toContain("FOREIGN");
      run.send({ key: "q" }); await run.exited;
      expect(run.snapshot().result).toEqual({ out: command === "ui" ? "ui: closed" : "", code: 0 });
      expect(run.snapshot().raw).toBe(false);
    } finally { await run.close(); }
    writeFileSync(path, rawOf(entries));
  }
  const parks = await observer(repo, "ui", ["--setup", "run-observed"]);
  // One key per message, each acknowledged by the frame that proves it landed. Ink hands a multi-byte
  // chunk to the handler as ONE unknown key ("a\r" opens nothing; "n"+"a\r" coalesced to "na\r" is a
  // no-op that leaves the first confirm open), and the 40 KB stdout tail still holds the earlier
  // confirm, so a whole-tail poll is satisfied before the key is even read. Frame-acknowledged, not
  // budget-widened (OBS-959/960/962).
  const frame = () => { const out = parks.snapshot().stdout; return out.slice(Math.max(0, out.lastIndexOf("\x1b[2J"))); };
  try {
    await expect.poll(frame, { timeout: 5000 }).toContain("decisions: approve");
    expect(frame()).toContain("no live owner");
    parks.send({ key: "a" });
    await expect.poll(frame, { timeout: 5000 }).toContain("Actions — Enter reviews");
    parks.send({ key: "\r" });
    await expect.poll(frame, { timeout: 5000 }).toContain("tickmarkr approve run-observed T2 --by operator");
    const before = readFileSync(path, "utf8");
    parks.send({ key: "n" });
    await expect.poll(frame, { timeout: 5000 }).not.toContain("y approve");
    parks.send({ key: "a" });
    await expect.poll(frame, { timeout: 5000 }).toContain("Actions — Enter reviews");
    parks.send({ key: "\r" });
    await expect.poll(frame, { timeout: 5000 }).toContain("y approve");
    expect(readFileSync(path, "utf8")).toBe(before);
    parks.send({ key: "y" });
    await expect.poll(frame, { timeout: 5000 }).toContain("Decision recorded");
    const approvals = readFileSync(path, "utf8").trim().split("\n").map(line => JSON.parse(line)).filter(row => row.event === "task-approved");
    expect(approvals).toHaveLength(1);
    expect(approvals[0]).toMatchObject({ taskId: "T2", data: { by: "operator" } });
    parks.send({ key: "q" }); await parks.exited;
  } finally { await parks.close(); }
  writeFileSync(path, rawOf(entries));
  const empty = makeRepo({ "base.txt": "fixture" });
  const home = await observer(empty, "ui", []);
  try {
    await expect.poll(() => home.snapshot().stdout, { timeout: 5000 }).toContain("HOME");
    expect(home.snapshot().stdout).toContain("No run recorded yet.");
    expect(home.snapshot().stdout).toContain("fleet");
    expect(home.snapshot().presence).toEqual([]);
    home.send({ key: "q" }); await home.exited;
  } finally { await home.close(); }
  for (const args of [["run-missing"], ["../run-observed"], ["--view", "fleet"], ["--demo"]]) {
    const refused = await observer(repo, "ui", args);
    await refused.exited;
    expect(refused.snapshot().result?.code).toBe(1);
    expect(refused.snapshot().stdout).toBe("");
  }
  // Use the actual built dispatcher with a module-resolution tripwire. A print
  // path importing Ink/React fails before it can return a plausible document.
  const forbidden = join(root, "tests/fixtures/screen-soak/ink-forbidden.mjs");
  const print = spawnSync(process.execPath, ["--experimental-loader", forbidden, join(isolatedBuild(), "dist/cli/index.js"), "status", "run-observed"], { cwd: repo, encoding: "utf8", env: process.env });
  expect(print.status, print.stderr).toBe(0);
  expect(print.stdout).toContain("run-observed");
  for (const flag of ["--plain", "--events", "--jsonl", "--decision-events"]) {
    const stream = await observer(repo, "status", ["run-observed", "--watch", flag], false, { NODE_OPTIONS: `--experimental-loader ${forbidden}` });
    try {
      await expect.poll(() => stream.snapshot().stdout, { timeout: 5000 }).not.toBe("");
      if (flag !== "--plain") {
        const rows = stream.snapshot().stdout.trim().split("\n").map(line => JSON.parse(line));
        expect(rows.every(row => row.version === 1 && row.runId === "run-observed" && row.evidence.includes("#L"))).toBe(true);
        expect(rows.some(row => row.type === "run-end")).toBe(true);
        expect(rows.map(row => row.sequence)).toEqual(rows.map(row => row.sequence).sort((a, b) => a - b));
        await expect.poll(() => stream.snapshot().stderr, { timeout: 5000 }).toContain("status: keepalive");
        expect(stream.snapshot().stdout).not.toContain("keepalive");
      } else expect(stream.snapshot().stdout).toContain("run-observed");
    } finally { await stream.close(); }
  }
  expect(readdirSync(join(repo, ".tickmarkr", "supervision")).filter(name => name.startsWith("watch.live."))).toEqual([]);
}, 90000);
