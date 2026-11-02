// `tickmarkr board --json`: the run board as one JSON line for the Claude Code pane, through the real dispatcher.
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { readRunBoard } from "../../src/board/read.js";
import { commandHelp } from "../../src/cli/help.js";
import { dispatch, USAGE } from "../../src/cli/index.js";

vi.mock("../../src/board/read.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../src/board/read.js")>();
  return { ...real, readRunBoard: vi.fn(real.readRunBoard) };
});
const read = vi.mocked(readRunBoard);
const PRIVATE_ID = /queue rows?\s+\d+|\bD-\d+|\bOBS-\d+/i;

const scratch: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  read.mockClear();
  for (const d of scratch.splice(0)) rmSync(d, { recursive: true, force: true });
});
/** A temp folder that is its own repository, with the process working directory stubbed to it (never the live tree). */
function repo(): string {
  const d = mkdtempSync(join(tmpdir(), "tkr-board-cmd-"));
  scratch.push(d);
  mkdirSync(join(d, ".git"));
  vi.spyOn(process, "cwd").mockReturnValue(d);
  return d;
}
function put(path: string, body: string, mtime?: number): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body);
  if (mtime !== undefined) utimesSync(path, mtime, mtime);
}
const run = (root: string, id: string, mtime: number) =>
  put(join(root, "runs", id, "journal.jsonl"), JSON.stringify({ ts: "2026-11-01T00:00:00Z", event: "run-start", data: { runId: id } }) + "\n", mtime);
const board = async (...argv: string[]) => dispatch("board", argv);
const oneLine = (out: string): Record<string, unknown> => {
  expect(out).not.toContain("\n");
  return JSON.parse(out);
};

test("the board command in a temp repository prints one parseable line with version 1 and a readAt, passes repeated root and release flags through, prints exactly the empty shape with exit 0, and exits 1 without the json flag, with an unknown option, with a positional and with a flag missing its value", async () => {
  const d = repo();
  // empty: no journal anywhere
  const empty = await board("--json");
  expect(empty.code).toBe(0);
  expect(oneLine(empty.out)).toStrictEqual({ version: 1, empty: `no tickmarkr run under ${join(d, ".tickmarkr")}` });

  const a = join(d, "s", "a", ".tickmarkr");
  const b = join(d, "s", "b", ".tickmarkr");
  run(a, "run-20261101-000000-0000000000000001", 1000);
  run(b, "run-20261101-000000-0000000000000002", 2000);
  put(join(d, "rel", "2.18.0", "backup-push.log"), "ok\n", 1000);
  put(join(d, "rel", "2.19.0", "backup-push.log"), "ok\n", 2000);

  const before = Date.now() / 1000;
  const both = await board("--json", "--root", "s/a/.tickmarkr", "--release", "rel/2.18.0", "--root", "s/b/.tickmarkr", "--release", "rel/2.19.0");
  const after = Date.now() / 1000;
  expect(both.code, both.out).toBe(0);
  const snap = oneLine(both.out);
  expect(snap.version).toBe(1);
  expect(snap.readAt).toMatch(/^\d\d:\d\d:\d\d$/);
  expect(snap.runId).toBe("run-20261101-000000-0000000000000002");
  expect((snap.release as { version: string }).version).toBe("2.19.0");
  expect(read).toHaveBeenLastCalledWith(d, ["s/a/.tickmarkr", "s/b/.tickmarkr"], ["rel/2.18.0", "rel/2.19.0"], expect.any(Number));
  const now = read.mock.lastCall![3];
  expect(now).toBeGreaterThanOrEqual(before);
  expect(now).toBeLessThanOrEqual(after);

  // the control: each flag's first value alone selects the older run and release, so both values reached the reader
  const first = oneLine((await board("--json", "--root", "s/a/.tickmarkr", "--release", "rel/2.18.0")).out);
  expect([first.runId, (first.release as { version: string }).version]).toEqual(["run-20261101-000000-0000000000000001", "2.18.0"]);

  read.mockClear();
  for (const argv of [[], ["--root", "s/a/.tickmarkr"], ["--json", "--nope"], ["--json", "extra"], ["--json", "--root"], ["--json", "--release"]]) {
    const r = await board(...argv);
    expect(r.code, argv.join(" ")).toBe(1);
    expect(r.out.replace("tickmarkr board:", "").trim(), argv.join(" ")).not.toBe("");
  }
  expect(read).not.toHaveBeenCalled();
});

test("the root usage and the board help name the json, root and release flags, the help holds no private id, and board help exits 0 without reading any run", async () => {
  const line = USAGE.split("\n").find((l) => /^ {2}board /.test(l));
  const help = commandHelp("board");
  for (const text of [line ?? "", help]) for (const flag of ["--json", "--root", "--release"]) expect(text).toContain(flag);
  expect(help).not.toMatch(PRIVATE_ID);
  expect(line).not.toMatch(PRIVATE_ID);

  // a run whose graph refuses: any read exits 1, so the control proves a read would be seen
  const d = repo();
  run(join(d, ".tickmarkr"), "run-20261101-000000-0000000000000003", 1000);
  put(join(d, ".tickmarkr", "runs", "run-20261101-000000-0000000000000003", "graph.json"), JSON.stringify({ tasks: [{ id: "T1; touch pwned", title: "x" }] }));
  const control = await board("--json");
  expect(control.code).toBe(1);
  expect(control.out).toMatch(/unsafe task id/);
  read.mockClear();
  for (const argv of [["--help"], ["-h"], ["--json", "--help"], ["--json", "-h", "--root", "x"]]) {
    expect(await board(...argv), argv.join(" ")).toEqual({ out: help, code: 0 });
  }
  expect(read).not.toHaveBeenCalled();
});
