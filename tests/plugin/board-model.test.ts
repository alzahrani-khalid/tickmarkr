import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test } from "vitest";
import {
  EMPTY_HEAD, EMPTY_TAIL, NEEDS_VERSION, boardArgs, boardStatusLine, copyTarget, parseBoard, shown, view, visible,
} from "../../hooks/board/model.js";
import type { BoardState, RunSnapshot, TaskRow } from "../../hooks/board/state.js";

// Fixed wire fixtures: the reference summarizer's own output (tests/fixtures/board/goldens.json) as wire version 1.
type Golden = { expected: Record<string, unknown> };
const GOLDENS = JSON.parse(readFileSync(resolve(import.meta.dirname, "../fixtures/board/goldens.json"), "utf8")) as {
  cases: Golden[]; io: Golden[];
};
const wire = (summary: Record<string, unknown>): RunSnapshot =>
  ({ release: null, spec: null, ...summary, version: 1, readAt: "10:00:00" }) as unknown as RunSnapshot;
const ok = (body: unknown) => ({ exitCode: 0, stdout: `${JSON.stringify(body)}\n`, stderr: "" });
const CONTROL = /[\x00-\x08\x0b-\x1f\x7f-\x9f]/;
const strings = (value: unknown): string[] => typeof value === "string" ? [value]
  : value !== null && typeof value === "object" ? Object.values(value).flatMap(strings) : [];

const BASE = wire(GOLDENS.io[0]!.expected);
const task = (id: string, state: TaskRow["state"]): TaskRow => ({ ...BASE.tasks[0]!, id, state });
const need = (taskId: string, cmd: string) => ({ task: taskId, kind: "gate-fail", reason: "review", since: 1, blocks: [], cmd });

test("copyTarget returns the raw command for its shown form and undefined for an ambiguous collision between a literal backslash and a control byte, an unknown text and a non-string, and parseBoard returns one state for version 1, the empty shape, a rejection, a nonzero exit with and without stderr, truncated output, misshapen JSON and another version", () => {
  // copyTarget: exactly one distinct raw cmd whose shown form is the posted text
  const raw = "tickmarkr approve run-1 T1 --park 7@x\x1b]52;c;cXdu\x07";
  const literal = "tickmarkr approve run-1 T2 --park 8@x\\x1b";
  const byte = "tickmarkr approve run-1 T2 --park 8@x\x1b";
  expect(visible(literal)).toBe(visible(byte));
  const snap: RunSnapshot = { ...BASE, needsYou: [need("T1", raw), need("T1", raw), need("T2", literal), need("T2", byte)] };
  expect(copyTarget(snap, visible(raw))).toBe(raw);
  expect(copyTarget(snap, visible(byte))).toBeUndefined(); // the literal backslash and the ESC byte collide
  for (const posted of ["tickmarkr approve run-1 T9", raw, "", visible(raw) + " "]) expect(copyTarget(snap, posted), posted).toBeUndefined();
  for (const posted of [undefined, null, 7, { copy: visible(raw) }, [visible(raw)]]) expect(copyTarget(snap, posted)).toBeUndefined();
  expect(copyTarget(null, visible(raw))).toBeUndefined();
  expect(copyTarget({ ...snap, needsYou: [] }, visible(raw))).toBeUndefined(); // a stale post

  // parseBoard: exactly one of snapshot, empty or error, each a complete replacement
  const one = (state: BoardState, kind: keyof BoardState) => {
    expect(Object.keys(state).sort()).toEqual(["empty", "error", "snapshot"]);
    for (const key of ["snapshot", "empty", "error"] as const) expect(state[key] === null, `${kind}: ${key}`).toBe(key !== kind);
    if (state.error !== null) expect(state.error).not.toMatch(CONTROL);
    return state;
  };
  const every = [...GOLDENS.io, ...GOLDENS.cases].map(golden => wire(golden.expected));
  expect(every.length).toBeGreaterThan(100);
  for (const body of every) expect(one(parseBoard(ok(body)), "snapshot").snapshot).toEqual(body);
  expect(one(parseBoard(ok({ version: 1, empty: "no tickmarkr run under /w/.tickmarkr" })), "empty").empty)
    .toBe("no tickmarkr run under /w/.tickmarkr");

  const errorOf = (ran: Parameters<typeof parseBoard>[0]) => one(parseBoard(ran), "error").error;
  expect(errorOf({ rejected: new Error("spawn tickmarkr ENOENT") })).toBe("spawn tickmarkr ENOENT");
  expect(errorOf({ rejected: "timed out\x1b[2K" })).toBe("timed out\\x1b[2K");
  expect(errorOf({ exitCode: 1, stdout: "", stderr: "warming up\nboard: unknown option '--json'\n\n  \n" })).toBe("board: unknown option '--json'");
  expect(errorOf({ exitCode: 1, stdout: "", stderr: "bad \x07bell\n" })).toBe("bad \\x07bell");
  for (const stderr of ["", " \n\n", undefined]) {
    expect(errorOf({ exitCode: 2, stdout: ok(BASE).stdout, stderr })).toBe("tickmarkr board exited 2; install tickmarkr 2.19.0 or later");
  }
  const text = ok(BASE).stdout;
  expect(errorOf({ exitCode: 0, stdout: text.slice(0, text.length >> 1), stderr: "" })).toMatch(/^tickmarkr board printed malformed JSON/);
  expect(errorOf({ exitCode: 0, stdout: text, stderr: "", isStdoutTruncated: true })).toBe("tickmarkr board output was cut short");
  for (const body of ["{broken", "", "not json"]) expect(errorOf({ exitCode: 0, stdout: body, stderr: "" })).toMatch(/malformed JSON/);
  const misshapen: unknown[] = [
    null, 1, "text", [BASE],
    { version: 1 }, { version: 1, empty: 7 }, { version: 1, empty: "none", runId: "run-1" },
    { ...BASE, tasks: "T1" }, { ...BASE, readAt: undefined }, { ...BASE, release: undefined }, { ...BASE, spec: undefined }, { ...BASE, spec: 7 },
    { ...BASE, tasks: [{ ...BASE.tasks[0]!, history: [{ att: 1, start: "07:09", parts: [{ text: "x", tone: "red" }] }] }] },
    { ...BASE, tasks: [{ ...BASE.tasks[0]!, state: "merged" }] },
    { ...BASE, needsYou: [{ ...need("T1", "cmd"), cmd: 7 }] },
    { ...BASE, release: { version: "2.19.0", stages: [] } },
  ];
  for (const body of misshapen) expect(errorOf(ok(body)), JSON.stringify(body)?.slice(0, 80)).toMatch(/misshapen/);
  for (const version of [0, 2, "1", null, undefined]) {
    expect(errorOf(ok({ ...BASE, version }))).toBe(NEEDS_VERSION);
    expect(errorOf(ok({ version, empty: "no tickmarkr run under /w" }))).toBe(NEEDS_VERSION);
  }
});

test("boardArgs maps trimmed comma lists to root and release flags and ignores blanks, boardStatusLine over shown live, ended and daemon-down snapshots includes the done count and needs-you tasks, and view of empty and error states shows only visible strings and the specified empty guidance", () => {
  expect(boardArgs({ stateRoots: " ~/a/.tickmarkr , ,/b/*/.tickmarkr,", releaseRoots: " /rel/release-* ,, " }))
    .toEqual(["--root", "~/a/.tickmarkr", "--root", "/b/*/.tickmarkr", "--release", "/rel/release-*"]);
  expect(boardArgs({ stateRoots: ["  /x ", ""], releaseRoots: [] })).toEqual(["--root", "/x"]);
  for (const options of [undefined, {}, { stateRoots: "", releaseRoots: " , " }]) expect(boardArgs(options)).toEqual([]);

  const tainted = "T2\x1b]0;owned\x07";
  const tasks = [task("T1", "done"), task(tainted, "parked"), task("T3", "gates"), task("T4", "pending")];
  const release = { version: "2.19.0", dir: "/rel", ciRun: "1", mirror: null, status: "completed", conclusion: "success", polledAt: "10:00",
    stages: [{ name: "CI", state: "done" as const, detail: "" }] };
  const live = { ...BASE, runId: "run-20261102-100040-0000000000000576", alive: true, ended: null, tasks, needsYou: [need(tainted, "c")], release };
  const lines = {
    live: boardStatusLine(shown(live)),
    ended: boardStatusLine(shown({ ...live, needsYou: [], release: null, ended: { done: ["T1"], failed: [], human: [], blocked: [], pending: [], tipVerify: "passed", owed: 0 } })),
    down: boardStatusLine(shown({ ...live, alive: false, release: { ...release, stages: [{ name: "CI", state: "failed" as const, detail: "" }] } })),
  };
  expect(lines.live).toBe("tkr 0576 live · 1/4 done · NEEDS YOU T2\\x1b]0;owned\\x07 · T2\\x1b]0;owned\\x07 parked, T3 gates · 2.19.0 CI green");
  expect(lines.ended).toBe("tkr 0576 ended · 1/4 done · T2\\x1b]0;owned\\x07 parked, T3 gates");
  expect(lines.down).toBe("tkr 0576 daemon down · 1/4 done · NEEDS YOU T2\\x1b]0;owned\\x07 · T2\\x1b]0;owned\\x07 parked, T3 gates · 2.19.0 CI failed");
  // the raw snapshot gives the same visible line: boardStatusLine itself passes through visible
  expect(boardStatusLine(live)).toBe(lines.live);
  for (const line of Object.values(lines)) expect(line).not.toMatch(CONTROL);

  const empty = view({ snapshot: null, empty: "no tickmarkr run under /w/.tickmarkr, /w/wt/\x1b[31mred/.tickmarkr", error: null });
  expect(empty).toEqual({ text: `${EMPTY_HEAD}\nSearched /w/.tickmarkr, /w/wt/\\x1b[31mred/.tickmarkr\n${EMPTY_TAIL}` });
  expect(EMPTY_HEAD).toBe("No tickmarkr runs found.");
  expect(EMPTY_TAIL).toBe("Compile a spec and review its plan, then run tickmarkr run. This board refreshes every 5 seconds.");
  const failed = view(parseBoard({ exitCode: 1, stdout: "", stderr: "board: cannot read \x9b2J/x\n" }));
  expect(failed).toEqual({ text: "board: cannot read \\u009b2J/x" });
  expect(view({ snapshot: null, empty: null, error: "raw \x07 error" })).toEqual({ text: "raw \\x07 error" });
  expect(view({ snapshot: null, empty: null, error: null })).toEqual({ text: "Waiting for the first read of the run…" });
  for (const state of [empty, failed]) expect("text" in state && state.text).not.toMatch(CONTROL);

  const board = view({ snapshot: live, empty: null, error: null }, "devicons", 1.5);
  expect(board).toEqual({ props: { snap: shown(live), error: null, marks: "devicons", fit: 1.5 } });
  for (const text of strings("props" in board && board.props)) expect(text).not.toMatch(CONTROL);
  expect(view({ snapshot: live, empty: null, error: null })).toEqual({ props: { snap: shown(live), error: null, marks: "glyph" } });
});
