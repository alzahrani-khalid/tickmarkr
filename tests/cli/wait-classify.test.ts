import { appendFileSync, closeSync, mkdirSync, openSync, renameSync, truncateSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { classifyWake, JournalTail, type WakeCursor } from "../../src/cli/commands/wait.js";
import { type JournalEvent } from "../../src/run/journal.js";
import { makeTestTempDir } from "../helpers/tmprepo.js";

const ts = "2026-10-28T00:00:00.000Z";
const row = (event: string, data: Record<string, unknown> = {}): JournalEvent => ({ event, ts, data });
const encode = (rows: JournalEvent[]) => rows.map(row => JSON.stringify(row)).join("\n") + "\n";
const racingPid = 2_147_483_000;
function tailFixture(rows: JournalEvent[]) {
  const dir = makeTestTempDir("wake-");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "journal.jsonl");
  writeFileSync(path, encode(rows));
  const fd = openSync(path, "r");
  return { path, fd, tail: new JournalTail(path, fd), append: (rows: JournalEvent[]) => appendFileSync(path, encode(rows)) };
}
afterEach(() => vi.restoreAllMocks());

test("test: wait's exported wake classification returns run end, park, task failure and daemon death with wait's precedence and physical row order over a closed table, including a death proven only after a re-read, so a second precedence or a death taken without the re-read fails", () => {
  const entries = [["task-human", "park"], ["task-failed", "task-failed"], ["run-end", "run-end"]] as const;
  for (const a of entries) for (const b of entries) {
    if (a === b) continue;
    const f = tailFixture([row("run-start", { pid: process.pid })]);
    try {
      const cursor: WakeCursor = {};
      expect(classifyWake(f.tail, cursor)).toBeUndefined();
      appendFileSync(f.path, "\ninvalid\n");
      f.append([row("phase-start"), row(a[0]), row(b[0])]);
      expect(classifyWake(f.tail, cursor)).toEqual({ cause: a[1], line: 5 });
      // The next call must classify an ALREADY READ row rather than only the new byte batch.
      expect(classifyWake(f.tail, cursor)).toEqual({ cause: b[1], line: 6 });
    } finally { closeSync(f.fd); }
  }
  for (const mode of ["dead", "park", "failure", "end", "park-end", "resume", "replace", "truncate"] as const) {
    const f = tailFixture([row("run-start", { pid: racingPid })]);
    const original = process.kill.bind(process);
    let probes = 0;
    const kill = vi.spyOn(process, "kill").mockImplementation((pid, sig) => {
      if (pid !== racingPid || sig !== 0) return original(pid, sig);
      if (++probes === 1) {
        if (mode === "park") f.append([row("task-human")]);
        if (mode === "failure") f.append([row("task-failed")]);
        if (mode === "end") f.append([row("run-end")]);
        if (mode === "park-end") f.append([row("task-human"), row("run-end")]);
        if (mode === "resume") f.append([row("run-resume", { pid: process.pid })]);
        if (mode === "replace") { renameSync(f.path, `${f.path}.old`); writeFileSync(f.path, encode([row("run-end")])); }
        if (mode === "truncate") truncateSync(f.path, 0);
      }
      throw Object.assign(new Error("dead"), { code: "ESRCH" });
    });
    try {
      const cursor: WakeCursor = {};
      if (mode === "replace" || mode === "truncate") expect(() => classifyWake(f.tail, cursor)).toThrow("journal replaced or truncated");
      else {
        const result = classifyWake(f.tail, cursor);
        expect(result).toEqual(mode === "resume" ? undefined : {
          cause: mode === "dead" ? "daemon-death" : mode === "failure" ? "task-failed" : mode === "end" ? "run-end" : "park",
          line: mode === "dead" ? 1 : 2,
        });
        if (mode === "park-end") expect(classifyWake(f.tail, cursor)).toEqual({ cause: "run-end", line: 3 });
      }
      expect(probes).toBe(1);
    } finally { kill.mockRestore(); closeSync(f.fd); }
  }
  for (const [rows, cursor, expected] of [
    [[row("run-start"), row("task-human"), row("run-end")], {}, { cause: "run-end", line: 3 }],
    [[row("run-start"), row("task-human"), row("run-end")], { after: 1 }, { cause: "park", line: 2 }],
    [[row("run-start"), row("run-end"), row("run-resume")], {}, undefined],
    [[row("run-start")], {}, undefined],
  ] as Array<[JournalEvent[], WakeCursor, unknown]>) {
    const f = tailFixture(rows);
    try { expect(classifyWake(f.tail, cursor)).toEqual(expected); }
    finally { closeSync(f.fd); }
  }
  const f = tailFixture([row("run-start", { pid: process.pid })]);
  try {
    const cursor: WakeCursor = {};
    expect(classifyWake(f.tail, cursor)).toBeUndefined();
    appendFileSync(f.path, JSON.stringify(row("run-end")));
    expect(classifyWake(f.tail, cursor)).toBeUndefined();
    appendFileSync(f.path, "\n");
    expect(classifyWake(f.tail, cursor)).toEqual({ cause: "run-end", line: 2 });
  } finally { closeSync(f.fd); }
});
