// Queue rows 331 and 332: src/board/read.ts against the frozen reference's io and release goldens (tests/fixtures/board,
// read-only), plus the rules the reference cannot show: the git-file worktree walk, the lock and input validation.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { readRelease, readRunBoard, stateRoots } from "../../src/board/read.js";

const fixtures = join(import.meta.dirname, "../fixtures/board");
type Layout = { path: string; mtime: number; text?: string; from?: string; cut?: number };
type Io = { name: string; tz: string; now: number; layout: Layout[]; args: string[]; expected: Record<string, unknown> };
type Rel = { name: string; tz: string; now: number; dir: string; files: Record<string, string>; expected: unknown };
type Sel = { name: string; tz: string; now: number; dirs: Record<string, { files: Record<string, string>; mtime: number }>; args: string[]; expected: unknown };
const goldens: { io: Io[]; release: Rel[]; releaseSelection: Sel[] } = JSON.parse(readFileSync(join(fixtures, "goldens.json"), "utf8"));

const savedTz = process.env.TZ;
const scratch: string[] = [];
afterEach(() => {
  if (savedTz === undefined) delete process.env.TZ;
  else process.env.TZ = savedTz;
  vi.restoreAllMocks();
  for (const d of scratch.splice(0)) rmSync(d, { recursive: true, force: true });
});
/** A fresh folder that is its own repository (an empty `.git` folder), so the walk never reaches an enclosing checkout. */
function temp(repo = true): string {
  const d = mkdtempSync(join(tmpdir(), "tkr-board-read-"));
  scratch.push(d);
  if (repo) mkdirSync(join(d, ".git"));
  return d;
}
function put(path: string, body: string, mtime?: number): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body);
  if (mtime !== undefined) utimesSync(path, mtime, mtime);
}
const lfLines = (text: string): string[] => (text.endsWith("\n") ? text.slice(0, -1) : text).split("\n");
function materialize(tmp: string, layout: Layout[]): void {
  for (const f of layout) {
    const full = f.from === undefined ? "" : readFileSync(join(fixtures, "runs", f.from), "utf8");
    put(join(tmp, f.path), f.text ?? (f.cut === undefined ? full : lfLines(full).slice(0, f.cut).join("\n") + "\n"), f.mtime);
  }
}
/** Find the selected golden journal by its reported id and newest mtime, then inspect its materialized prefix. */
function selectedJournal(tmp: string, c: Io, runId: string): { event: string }[] {
  const candidates = c.layout.filter((f) => f.path.endsWith("/journal.jsonl")).map((f) => {
    const events = lfLines(readFileSync(join(tmp, f.path), "utf8")).filter((line) => line.startsWith("{")).map((line) => JSON.parse(line));
    let id = "";
    for (const e of events) {
      if ((e.event === "run-start" || e.event === "run-resume") && !id) id = e.data?.runId || "";
      if (e.event === "run-end" && e.data && Object.hasOwn(e.data, "runId")) id = e.data.runId;
    }
    return { events, id: id || basename(dirname(f.path)), mtime: f.mtime };
  }).filter((f) => f.id === runId).sort((a, b) => b.mtime - a.mtime);
  expect(candidates.length, c.name).toBeGreaterThan(0);
  return candidates[0].events;
}
function isReopened(events: { event: string }[]): boolean {
  let sawEnd = false;
  let reopened = false;
  for (const { event } of events) {
    if (event === "run-end") { sawEnd = true; reopened = false; }
    else if (event === "run-resume" && sawEnd) reopened = true;
  }
  return reopened;
}
const placeholder = (x: unknown, tmp: string): unknown => JSON.parse(JSON.stringify(x).replaceAll(tmp, "{root}"));
function argsOf(args: string[], tmp: string): [string[], string[]] {
  const a = args.map((s) => s.replaceAll("{root}", tmp));
  const at = a.indexOf("--release");
  return at < 0 ? [a, []] : [a.slice(0, at), a.slice(at + 1)];
}
function runGolden(read: typeof readRunBoard, c: Io): void {
  const tmp = temp();
  materialize(tmp, c.layout);
  process.env.TZ = c.tz;
  const [roots, releases] = argsOf(c.args, tmp);
  const got = read(tmp, roots, releases, c.now) as Record<string, unknown>;
  expect(got.version, c.name).toBe(1);
  expect(got.readAt, c.name).toMatch(/^\d\d:\d\d:\d\d$/);
  if (isReopened(selectedJournal(tmp, c, got.runId as string))) {
    expect(got.ended, c.name).toBeNull();
    expect(got.endEpoch, c.name).toBeNull();
    expect(got.atEpoch, c.name).toBe(c.now);
    return;
  }
  const { version: _v, readAt: _r, spec, ...rest } = got;
  expect(spec, c.name).toBeNull(); // the fixture graphs record no spec path (R1, queue row 335)
  expect(placeholder(rest, tmp), c.name).toStrictEqual(c.expected);
}
const journal = (runId: string, ts = "2026-11-01T00:00:00Z") => JSON.stringify({ ts, event: "run-start", data: { runId } }) + "\n";

test("every golden io case, materialized under a temp folder with its mtimes and read with its args at its now in its tz, deep-equals its expected object once the temp path becomes the root placeholder and the top-level version and readAt are removed, and every golden release and releaseSelection case through the release reader deep-equals its expected card", () => {
  expect([goldens.io.length, goldens.release.length, goldens.releaseSelection.length]).toEqual([5, 12, 4]);
  for (const c of goldens.io) runGolden(readRunBoard, c);
  for (const c of goldens.release) {
    const tmp = temp();
    for (const [name, text] of Object.entries(c.files)) put(join(tmp, c.dir, name), text);
    process.env.TZ = c.tz;
    expect(placeholder(readRelease(tmp, [join(tmp, c.dir)], c.now), tmp), c.name).toStrictEqual(c.expected);
  }
  for (const c of goldens.releaseSelection) {
    const tmp = temp();
    for (const [dir, { files, mtime }] of Object.entries(c.dirs)) {
      mkdirSync(join(tmp, dir), { recursive: true });
      for (const [name, text] of Object.entries(files)) put(join(tmp, dir, name), text, mtime);
    }
    process.env.TZ = c.tz;
    expect(placeholder(readRelease(tmp, argsOf(c.args, tmp)[0], c.now), tmp), c.name).toStrictEqual(c.expected);
  }
});

test("a reader snapshot of the failed-task journal after its reopening resume reports the live S7 fields", () => {
  const tmp = temp();
  const root = join(tmp, ".tickmarkr");
  const run = join(root, "runs", "run-20260916-094901-0000000000000091");
  put(join(run, "journal.jsonl"), lfLines(readFileSync(join(fixtures, "runs", "failed-task", "journal.jsonl"), "utf8")).slice(0, 428).join("\n") + "\n");
  put(join(run, "graph.json"), readFileSync(join(fixtures, "runs", "failed-task", "graph.json"), "utf8"));
  const now = Date.parse("2026-09-16T18:00:00.000Z") / 1000;
  const got = readRunBoard(tmp, [], [], now) as { ended: unknown; endEpoch: unknown; atEpoch: unknown };
  expect([got.ended, got.endEpoch, got.atEpoch]).toEqual([null, null, now]);
});

test("plain-file repositories select the newest run starting from either checkout, once with the main checkout newer and once with the linked one newer, resolve relative gitdir and commondir paths, skip a stale worktree entry and stop at a submodule", () => {
  const tmp = temp(false);
  const main = join(tmp, "main");
  const linked = join(tmp, "linked");
  const admin = join(main, ".git", "worktrees", "lnk");
  put(join(admin, "gitdir"), "../../../../linked/.git\n"); // relative to the administrative folder
  put(join(admin, "commondir"), "../..\r\n"); // relative to the git directory; CR and LF stripped
  put(join(main, ".git", "worktrees", "gone", "gitdir"), join(tmp, "gone", ".git") + "\n"); // stale: its checkout is gone
  put(join(linked, ".git"), "gitdir: ../main/.git/worktrees/lnk\n"); // relative to the checkout
  mkdirSync(join(linked, "src", "deep"), { recursive: true });
  const mainJournal = join(main, ".tickmarkr", "runs", "run-20261101-000000-0000000000000001", "journal.jsonl");
  const linkedJournal = join(linked, ".tickmarkr", "runs", "run-20261101-000000-0000000000000002", "journal.jsonl");
  put(mainJournal, journal("run-20261101-000000-0000000000000001"));
  put(linkedJournal, journal("run-20261101-000000-0000000000000002"));
  expect(stateRoots(main, [])).toEqual([join(main, ".tickmarkr"), join(linked, ".tickmarkr")]);
  expect(stateRoots(join(linked, "src", "deep"), [])).toEqual([join(linked, ".tickmarkr"), join(main, ".tickmarkr")]);
  const runIdFrom = (cwd: string) => (readRunBoard(cwd, [], [], 1793000000) as { runId: string }).runId;
  for (const [mainTime, linkedTime, want] of [[2000, 1000, "1"], [1000, 2000, "2"]] as const) {
    utimesSync(mainJournal, mainTime, mainTime);
    utimesSync(linkedJournal, linkedTime, linkedTime);
    expect([runIdFrom(main), runIdFrom(join(linked, "src", "deep"))]).toEqual([`run-20261101-000000-000000000000000${want}`,
      `run-20261101-000000-000000000000000${want}`]);
  }
  // a submodule's .git file is the nearest entry: its own module directory has no worktrees and no main checkout
  const sub = join(main, "sub");
  put(join(sub, ".git"), "gitdir: ../.git/modules/sub\n");
  mkdirSync(join(main, ".git", "modules", "sub"), { recursive: true });
  expect(stateRoots(join(sub), [])).toEqual([join(sub, ".tickmarkr")]);
  expect(readRunBoard(sub, [], [], 1793000000)).toStrictEqual({ version: 1, empty: `no tickmarkr run under ${join(sub, ".tickmarkr")}` });
});

test("a lock for another run gives null pid and alive, a missing or malformed lock gives alive false, and a matching lock with a numeric-string pid, zero or a negative pid probes the mocked kill, where a throw gives false", () => {
  const tmp = temp();
  const root = join(tmp, "s", ".tickmarkr");
  // the folder's name differs from the journal's runId: the lock is matched by the folder's
  put(join(root, "runs", "run-folder", "journal.jsonl"), journal("run-journal-id"));
  const probed: Array<[number, unknown]> = [];
  vi.spyOn(process, "kill").mockImplementation(((pid: number, signal: unknown) => {
    probed.push([pid, signal]);
    if (pid < 0) throw Object.assign(new Error("kill ESRCH"), { code: "ESRCH" });
    return true;
  }) as typeof process.kill);
  const lockWith = (text: string | null) => {
    rmSync(join(root, "graph.lock"), { force: true });
    if (text !== null) put(join(root, "graph.lock"), text);
    const got = readRunBoard(tmp, [root], [], 1793000000) as { pid: unknown; alive: unknown };
    return [got.pid, got.alive];
  };
  expect(lockWith(JSON.stringify({ runId: "run-journal-id", pid: 5 }))).toEqual([null, null]);
  expect(lockWith(JSON.stringify({ runId: "run-other", pid: 5 }))).toEqual([null, null]);
  expect(probed).toEqual([]);
  for (const bad of [null, "{", "[1]", JSON.stringify({ runId: "run-folder" }), JSON.stringify({ runId: "run-folder", pid: "4x2" }),
    JSON.stringify({ runId: "run-folder", pid: null })]) expect(lockWith(bad), String(bad)).toEqual([null, false]);
  expect(probed).toEqual([]);
  expect(lockWith(JSON.stringify({ runId: "run-folder", pid: " 4_2\n" }))).toEqual([42, true]);
  expect(lockWith(JSON.stringify({ runId: "run-folder", pid: 0 }))).toEqual([0, true]);
  expect(lockWith(JSON.stringify({ runId: "run-folder", pid: -7 }))).toEqual([-7, false]);
  expect(probed).toEqual([[42, 0], [0, 0], [-7, 0]]);
});

test("with every process-spawning export of the node built-in mocked to throw, readRunBoard over the golden main layout still returns its snapshot, while an unsafe task id, an unsafe run id and a cyclic graph each give an error without hanging", async () => {
  const spawned: string[] = [];
  const throwing = (o: Record<string, unknown>): Record<string, unknown> => Object.fromEntries(Object.entries(o).map(([k, v]) =>
    [k, typeof v === "function" ? () => { spawned.push(k); throw new Error(`spawned via ${k}`); } : v]));
  const mocked = async (id: string) => {
    const real = await vi.importActual<Record<string, unknown>>(id);
    return { ...throwing(real), default: throwing(real.default as Record<string, unknown>) };
  };
  vi.resetModules();
  vi.doMock("node:child_process", () => mocked("node:child_process"));
  vi.doMock("child_process", () => mocked("child_process"));
  try {
    const fresh = await import("../../src/board/read.js");
    const cp = await import("node:child_process");
    expect(() => cp.execFileSync("git", ["status"])).toThrow(/spawned via execFileSync/); // the control: the mock is live
    spawned.length = 0;
    runGolden(fresh.readRunBoard, goldens.io.find((c) => c.name === "main/Asia/Riyadh") as Io);
    const tmp = temp();
    const root = join(tmp, ".tickmarkr");
    const runDir = join(root, "runs", "run-20261101-000000-0000000000000003");
    const board = (graph: unknown, runId = "run-20261101-000000-0000000000000003") => {
      put(join(runDir, "journal.jsonl"), journal(runId));
      put(join(runDir, "graph.json"), JSON.stringify(graph));
      return () => fresh.readRunBoard(tmp, [], [], 1793000000);
    };
    expect(board({ tasks: [{ id: "T1", title: "ok" }] })()).toMatchObject({ version: 1, runId: "run-20261101-000000-0000000000000003" });
    expect(board({ tasks: [{ id: "T1; touch pwned", title: "x" }] })).toThrow(/unsafe task id/);
    expect(board({ tasks: [{ id: "T1", title: "x" }] }, "run-x; touch pwned")).toThrow(/unsafe run id/);
    expect(board({ tasks: [{ id: "T1", title: "x", deps: ["T2"] }, { id: "T2", title: "y", deps: ["T1"] }] })).toThrow(/dependency cycle among T1, T2/);
    expect(board({ tasks: [{ id: "T1", title: "x", deps: ["T9"] }] })).toThrow(/unknown task "T9"/);
    expect(spawned).toEqual([]);
  } finally {
    vi.doUnmock("node:child_process");
    vi.doUnmock("child_process");
    vi.resetModules();
  }
});

test("readAt equals now formatted in the local zone, globs never cross a separator, an explicit leading dot matches a hidden folder while a wildcard does not, a folder named twice is read once, and no journal gives exactly the empty shape", () => {
  const tmp = temp();
  const now = 1793000090.75;
  put(join(tmp, "r", ".tickmarkr", "runs", "run-20261101-000000-0000000000000004", "journal.jsonl"), journal("run-20261101-000000-0000000000000004"));
  for (const [tz, offsetH] of [["UTC", 0], ["Asia/Riyadh", 3]] as const) {
    process.env.TZ = tz;
    const want = new Date((Math.floor(now) + offsetH * 3600) * 1000).toISOString().slice(11, 19);
    expect((readRunBoard(tmp, [join(tmp, "r", ".tickmarkr")], [], now) as { readAt: string }).readAt, tz).toBe(want);
  }
  for (const d of ["g/a/.tickmarkr", "g/a/b/.tickmarkr", "g/ab/.tickmarkr", "w/.hidden/.tickmarkr", "w/vis/.tickmarkr"]) mkdirSync(join(tmp, d), { recursive: true });
  const given = (...patterns: string[]) => stateRoots(tmp, patterns).slice(1); // the first is the repository's own root
  expect(stateRoots(tmp, [])).toEqual([join(tmp, ".tickmarkr")]);
  expect(given(`${tmp}/g/a*b/.tickmarkr`, `${tmp}/g/a?b/.tickmarkr`)).toEqual([join(tmp, "g/ab/.tickmarkr")]);
  expect(given(`${tmp}/g/**/.tickmarkr`)).toEqual([join(tmp, "g/a/.tickmarkr"), join(tmp, "g/ab/.tickmarkr")]);
  expect(given(`${tmp}/w/*/.tickmarkr`)).toEqual([join(tmp, "w/vis/.tickmarkr")]);
  expect(given(`${tmp}/w/.*/.tickmarkr`)).toEqual([join(tmp, "w/.hidden/.tickmarkr")]);
  expect(given(`${tmp}/w/[.]hidden/.tickmarkr`, `${tmp}/w/?hidden/.tickmarkr`)).toEqual([]);
  expect(given("w/v[!x]s/.tickmarkr")).toEqual([join(tmp, "w/vis/.tickmarkr")]); // relative to cwd
  symlinkSync(join(tmp, "w", "vis"), join(tmp, "alias"));
  const vis = join(tmp, "w/vis/.tickmarkr");
  expect(given(vis, vis, `${tmp}/w/*/.tickmarkr`, `${tmp}/w/vis/../vis/.tickmarkr`, `${tmp}/alias/.tickmarkr`)).toEqual([vis]);
  mkdirSync(join(tmp, ".tickmarkr"));
  expect(stateRoots(tmp, [join(tmp, ".tickmarkr"), `${tmp}/.tickmarkr`])).toEqual([join(tmp, ".tickmarkr")]);
  expect(given("~")).toEqual([homedir()]);
  const empty = readRunBoard(tmp, [`${tmp}/w/*/.tickmarkr`, `${tmp}/missing/.tickmarkr`], [`${tmp}/rel-*`], now);
  expect(empty).toStrictEqual({ version: 1, empty: `no tickmarkr run under ${join(tmp, ".tickmarkr")}, ${vis}` });
  expect(Object.keys(empty)).toEqual(["version", "empty"]);
});

// Python 3.14.7 `fnmatch.fnmatchcase` (glob's segment match is `fnmatch.filter`, R3) over the six one-character names
// a b z - ! ], for every "[body]" whose body is one to three of those characters: "<pattern>=<the names it matches>".
const BRACKET_ORACLE = `
[a]=a [b]=b [z]=z [-]=- [!]= []]=] [aa]=a [ab]=ab [az]=az [a-]=a- [a!]=a! [a]]= [ba]=ab [bb]=b [bz]=bz [b-]=b-
[b!]=b! [b]]= [za]=az [zb]=bz [zz]=z [z-]=z- [z!]=z! [z]]= [-a]=a- [-b]=b- [-z]=z- [--]=- [-!]=-! [-]]=
[!a]=bz-!] [!b]=az-!] [!z]=ab-!] [!-]=abz!] [!!]=abz-] [!]]=abz-! []a]=a] []b]=b] []z]=z] []-]=-] []!]=!] []]]=
[aaa]=a [aab]=ab [aaz]=az [aa-]=a- [aa!]=a! [aa]]= [aba]=ab [abb]=ab [abz]=abz [ab-]=ab- [ab!]=ab! [ab]]=
[aza]=az [azb]=abz [azz]=az [az-]=az- [az!]=az! [az]]= [a-a]=a [a-b]=ab [a-z]=abz [a--]= [a-!]= [a-]]= [a!a]=a!
[a!b]=ab! [a!z]=az! [a!-]=a-! [a!!]=a! [a!]]= [a]a]= [a]b]= [a]z]= [a]-]= [a]!]= [a]]]= [baa]=ab [bab]=ab
[baz]=abz [ba-]=ab- [ba!]=ab! [ba]]= [bba]=ab [bbb]=b [bbz]=bz [bb-]=b- [bb!]=b! [bb]]= [bza]=abz [bzb]=bz
[bzz]=bz [bz-]=bz- [bz!]=bz! [bz]]= [b-a]= [b-b]=b [b-z]=bz [b--]= [b-!]= [b-]]= [b!a]=ab! [b!b]=b! [b!z]=bz!
[b!-]=b-! [b!!]=b! [b!]]= [b]a]= [b]b]= [b]z]= [b]-]= [b]!]= [b]]]= [zaa]=az [zab]=abz [zaz]=az [za-]=az-
[za!]=az! [za]]= [zba]=abz [zbb]=bz [zbz]=bz [zb-]=bz- [zb!]=bz! [zb]]= [zza]=az [zzb]=bz [zzz]=z [zz-]=z-
[zz!]=z! [zz]]= [z-a]= [z-b]= [z-z]=z [z--]= [z-!]= [z-]]= [z!a]=az! [z!b]=bz! [z!z]=z! [z!-]=z-! [z!!]=z!
[z!]]= [z]a]= [z]b]= [z]z]= [z]-]= [z]!]= [z]]]= [-aa]=a- [-ab]=ab- [-az]=az- [-a-]=a- [-a!]=a-! [-a]]=
[-ba]=ab- [-bb]=b- [-bz]=bz- [-b-]=b- [-b!]=b-! [-b]]= [-za]=az- [-zb]=bz- [-zz]=z- [-z-]=z- [-z!]=z-! [-z]]=
[--a]=a-] [--b]=ab-] [--z]=abz-] [---]=- [--!]= [--]]= [-!a]=a-! [-!b]=b-! [-!z]=z-! [-!-]=-! [-!!]=-! [-!]]=
[-]a]= [-]b]= [-]z]= [-]-]= [-]!]= [-]]]= [!aa]=bz-!] [!ab]=z-!] [!az]=b-!] [!a-]=bz!] [!a!]=bz-] [!a]]=
[!ba]=z-!] [!bb]=az-!] [!bz]=a-!] [!b-]=az!] [!b!]=az-] [!b]]= [!za]=b-!] [!zb]=a-!] [!zz]=ab-!] [!z-]=ab!]
[!z!]=ab-] [!z]]= [!-a]=bz!] [!-b]=az!] [!-z]=ab!] [!--]=abz!] [!-!]=abz] [!-]]= [!!a]=bz-] [!!b]=az-]
[!!z]=ab-] [!!-]=abz] [!!!]=abz-] [!!]]= [!]a]=bz-! [!]b]=az-! [!]z]=ab-! [!]-]=abz! [!]!]=abz- [!]]]= []aa]=a]
[]ab]=ab] []az]=az] []a-]=a-] []a!]=a!] []a]]= []ba]=ab] []bb]=b] []bz]=bz] []b-]=b-] []b!]=b!] []b]]= []za]=az]
[]zb]=bz] []zz]=z] []z-]=z-] []z!]=z!] []z]]= []-a]=a] []-b]=ab] []-z]=abz] []--]= []-!]= []-]]= []!a]=a!]
[]!b]=b!] []!z]=z!] []!-]=-!] []!!]=!] []!]]= []]a]= []]b]= []]z]= []]-]= []]!]= []]]]=`.trim().split(/\s+/).map((pair) => [pair.slice(0, pair.lastIndexOf("=")), pair.slice(pair.lastIndexOf("=") + 1)] as const);

test("a bracket class follows Python fnmatch: a reversed range matches nothing, a negated empty range matches any one character, a hyphen after a range end is literal, and every bracket over the six-name alphabet matches as Python does", () => {
  const tmp = temp();
  for (const n of ["a", "b", "z", "-", "!", "]", "foo\n"]) mkdirSync(join(tmp, n));
  const sorted = (s: string) => [...s].sort().join("");
  const matched = (pattern: string) => sorted(stateRoots(tmp, [pattern]).slice(1).map((p) => p.slice(tmp.length + 1)).join(""));
  // the review's reproducers: each of the first three threw a SyntaxError from an invalid JavaScript range
  expect([matched("[z-a]"), matched("[!z-a]"), matched("[a--b]"), matched("f*o")]).toEqual(["", sorted("abz-!]"), "b", ""]);
  expect([matched("[a-b-z]"), matched("[!a-]"), matched("[--!]"), matched("[a-z-a]")]).toEqual(["-abz", sorted("bz!]"), "", "-abz"]); // Python 3.14.7
  expect(BRACKET_ORACLE.length).toBe(6 + 36 + 216);
  for (const [pattern, names] of BRACKET_ORACLE) expect(matched(pattern), pattern).toBe(sorted(names));
});

test("a malformed history line is skipped whole: a semantic verdict with a bad timestamp, first or second, leaves its round as it was, and a malformed copy of any history line at any position leaves the eta as the clean history gives it", () => {
  const tmp = temp();
  const runs = join(tmp, ".tickmarkr", "runs");
  put(join(runs, "run-current", "journal.jsonl"), journal("run-current"), 2000);
  put(join(runs, "run-current", "graph.json"), JSON.stringify({ tasks: [{ id: "T1", title: "one" }] }));
  const at = (min: number) => `2026-11-01T00:${String(min).padStart(2, "0")}:00Z`;
  const ev = (event: string, ts: string, data: Record<string, unknown>) => ({ event, ts, taskId: "T1", data });
  const etaOf = (history: readonly unknown[]): unknown => {
    put(join(runs, "run-history", "journal.jsonl"), history.map((e) => JSON.stringify(e) + "\n").join(""), 1000);
    return (readRunBoard(tmp, [], [], Date.parse(at(30)) / 1000) as { eta: unknown }).eta;
  };
  const round = [ev("phase-start", at(10), { phase: "judge" }), ev("gate-result", at(11), { gate: "acceptance" }), ev("gate-result", at(13), { gate: "review" })];
  const clean = [ev("phase-start", at(0), { phase: "worker" }), ev("worker-result", at(10), {}), ...round,
    ev("gate-result", at(14), { gate: "test", pass: true, durationMs: 90000 })];
  const want = etaOf(clean);
  expect(want).not.toEqual(etaOf([])); // the control: the history moves the eta
  expect(etaOf([round[0], { ...round[1], ts: "bad" }, round[1], round[2]])).toEqual(etaOf(round)); // a bad first verdict
  expect(etaOf([round[0], round[1], { ...round[2], ts: "bad" }, round[2]])).toEqual(etaOf(round)); // a bad second verdict
  // Each line spoiled three ways, at every position. A test result reads neither its ts nor its taskId, so those two
  // copies stay well formed: an equal sample, which leaves the p50 where it was.
  for (const e of clean) {
    for (const bad of [{ ...e, ts: "bad" }, { ...e, data: 7 }, { ...e, taskId: ["T1"] }]) {
      for (let p = 0; p <= clean.length; p++) expect(etaOf([...clean.slice(0, p), bad, ...clean.slice(p)]), `${JSON.stringify(bad)} at ${p}`).toEqual(want);
    }
  }
});

test("input validation runs before summarize: an unsafe run id, an unsafe task id or a cyclic graph throws with summarize never called, the run id follows summarize's own rules, and a journal's own _line never reaches a park command", async () => {
  const calls: unknown[] = [];
  vi.resetModules();
  vi.doMock("../../src/board/summarize.js", async () => {
    const real = await vi.importActual<typeof import("../../src/board/summarize.js")>("../../src/board/summarize.js");
    return { ...real, summarize: (...args: Parameters<typeof real.summarize>) => { const out = real.summarize(...args); calls.push(out.runId); return out; } };
  });
  try {
    const fresh = await import("../../src/board/read.js");
    const tmp = temp();
    const runDir = join(tmp, ".tickmarkr", "runs", "run-folder");
    const board = (events: readonly unknown[], tasks: readonly unknown[] = [{ id: "T1", title: "one" }]) => {
      calls.length = 0;
      put(join(runDir, "journal.jsonl"), events.map((e) => JSON.stringify(e) + "\n").join(""));
      put(join(runDir, "graph.json"), JSON.stringify({ tasks }));
      return () => fresh.readRunBoard(tmp, [], [], 1793000000) as { runId: string; needsYou: Array<{ cmd: string }> };
    };
    const run = (event: string, data: Record<string, unknown>) => ({ ts: "2026-11-01T00:00:00Z", event, data });
    for (const [events, tasks, error] of [
      [[run("run-start", { runId: "run-x; touch pwned" })], undefined, /unsafe run id/],
      [[run("run-start", { runId: null }), run("run-resume", { runId: "run-good" })], undefined, /unsafe run id/], // str(None) is kept
      [[run("run-start", { runId: "run-a" }), run("run-end", { runId: 5 })], undefined, /unsafe run id/],
      [[run("run-start", { runId: "run-a" })], [{ id: "T1; touch pwned", title: "x" }], /unsafe task id/],
      [[run("run-start", { runId: "run-a" })], [{ id: "T1", title: "x", deps: ["T2"] }, { id: "T2", title: "y", deps: ["T1"] }], /dependency cycle/],
    ] as const) {
      expect(board(events, tasks), String(error)).toThrow(error);
      expect(calls, String(error)).toEqual([]);
    }
    for (const [events, want] of [
      [[run("run-start", { runId: "run-a" }), run("run-end", { runId: "" })], "run-folder"],
      [[run("run-start", {}), run("run-resume", { runId: "run-b" })], "run-b"],
      [[run("run-start", { runId: "run-a" }), run("run-resume", { runId: "bad id" })], "run-a"],
      [[run("run-start", { runId: "run-a" }), run("run-end", { runId: "run-c" })], "run-c"],
    ] as const) {
      expect(board(events)().runId, want).toBe(want);
      expect([calls.length, (calls[0] as string) || "run-folder"], want).toEqual([1, want]); // the same id summarize reports
    }
    for (const line of [-3, 0, "1; touch pwned", 2.5]) {
      const got = board([run("run-start", { runId: "run-a" }), { ...run("task-human", { kind: "human" }), taskId: "T1", _line: line }])();
      expect(got.needsYou.map((n) => n.cmd), String(line)).toEqual(["tickmarkr approve run-a T1 --park 2@2026-11-01T00:00:00Z"]);
    }
  } finally {
    vi.doUnmock("../../src/board/summarize.js");
    vi.resetModules();
  }
});

// Queue row 334 (R6a, R6b) and row 335 (R1 spec): deliberate differences from the reference, which read history only
// from the run's own runs folder (a fresh worktree's ETA read "1m – 1m") and never named the spec a run builds.
const T0 = 1793000000;
const LIVE = "run-20261102-040923-0000000000000427";
const SIBLINGS: [string, string][] = [
  ["run-20260901-000000-0000000000000001", "repairs-and-parks/journal.jsonl"], ["run-20260902-000000-0000000000000002", "failed-task/journal.jsonl"],
  ["run-20260903-000000-0000000000000003", "clean-pass/journal.jsonl"], ["run-20260904-000000-0000000000000004", "synthetic-edges/journal.jsonl"],
];
function liveRun(state: string, graph?: string): void {
  materialize(state, [{ path: `runs/${LIVE}/journal.jsonl`, from: "clean-pass/journal.jsonl", cut: 66, mtime: T0 }]);
  put(join(state, "runs", LIVE, "graph.json"), graph ?? readFileSync(join(fixtures, "runs", "clean-pass", "graph.json"), "utf8"), T0);
}
const history = (state: string): void =>
  materialize(state, SIBLINGS.map(([rid, src], k) => ({ path: `runs/${rid}/journal.jsonl`, from: src, mtime: T0 - 1000 * (k + 1) })));
const etaAt = (cwd: string, roots: string[] = []): unknown => (readRunBoard(cwd, roots, [], T0 + 90) as { eta: unknown }).eta;
/** A main checkout with one linked worktree, as git writes them. */
function repoWithWorktree(): { main: string; linked: string } {
  const tmp = temp(false);
  const main = join(tmp, "main");
  const linked = join(tmp, "linked");
  put(join(main, ".git", "worktrees", "lnk", "gitdir"), join(linked, ".git") + "\n");
  put(join(main, ".git", "worktrees", "lnk", "commondir"), "../..\n");
  put(join(linked, ".git"), `gitdir: ${join(main, ".git", "worktrees", "lnk")}\n`);
  return { main, linked };
}

test("history pools every repository checkout's runs: a run in a fresh linked worktree gets the ETA it would get with the main checkout's earlier runs beside it (R6a)", () => {
  const solo = temp();
  liveRun(join(solo, ".tickmarkr"));
  history(join(solo, ".tickmarkr"));
  const beside = etaAt(solo);
  expect(beside).not.toBeNull();
  const { main, linked } = repoWithWorktree();
  liveRun(join(linked, ".tickmarkr"));
  history(join(main, ".tickmarkr"));
  expect(etaAt(linked)).toStrictEqual(beside);
  expect(etaAt(main)).toStrictEqual(beside); // the run is found and pooled from the main checkout too
});

test("pooled history keeps R4's order across checkouts: with more than six equal-mtime earlier runs split between two checkouts, every cwd gets the ETA of the same runs held in one folder (R6a)", () => {
  const worker = (sec: number) => [
    { ts: "2026-10-01T00:00:00.000Z", event: "phase-start", taskId: "T1", data: { phase: "worker" } },
    { ts: new Date(Date.parse("2026-10-01T00:00:00.000Z") + sec * 1000).toISOString(), event: "worker-result", taskId: "T1", data: {} },
  ].map((e) => JSON.stringify(e)).join("\n") + "\n";
  const early = ["run-20260901-000000-0000000000000001", "run-20260901-000000-0000000000000002", "run-20260901-000000-0000000000000003", "run-20260901-000000-0000000000000004"];
  const late = ["run-20260905-000000-0000000000000005", "run-20260905-000000-0000000000000006", "run-20260905-000000-0000000000000007", "run-20260905-000000-0000000000000008"];
  const runs = (state: string, names: string[], sec: number) => { for (const n of names) put(join(state, "runs", n, "journal.jsonl"), worker(sec), T0 - 1000); };
  const solo = temp();
  liveRun(join(solo, ".tickmarkr"));
  runs(join(solo, ".tickmarkr"), early, 60);
  runs(join(solo, ".tickmarkr"), late, 6000);
  const one = etaAt(solo);
  expect(one).not.toBeNull();
  const { main, linked } = repoWithWorktree();
  liveRun(join(main, ".tickmarkr"));
  runs(join(main, ".tickmarkr"), late, 6000);
  runs(join(linked, ".tickmarkr"), early, 60);
  expect(etaAt(main)).toStrictEqual(one);
  expect(etaAt(linked)).toStrictEqual(one);
});

test("with no earlier run in any pooled folder the snapshot carries no ETA, and a named root outside the repository reads only its own runs (R6b)", () => {
  const fresh = temp();
  liveRun(join(fresh, ".tickmarkr"));
  expect(etaAt(fresh)).toBeNull();
  const { main } = repoWithWorktree();
  history(join(main, ".tickmarkr"));
  const elsewhere = join(temp(false), "named", ".tickmarkr");
  liveRun(elsewhere);
  utimesSync(join(elsewhere, "runs", LIVE, "journal.jsonl"), T0 + 50, T0 + 50); // newer than every sibling, so it is the run read
  const board = readRunBoard(main, [elsewhere], [], T0 + 90) as { runId: string; eta: unknown };
  expect(board.runId).toBe(LIVE);
  expect(board.eta).toBeNull();
});

test("the snapshot names the spec its graph records: the first spec path's file name without .spec.md, else null (R1, queue row 335)", () => {
  const base = JSON.parse(readFileSync(join(fixtures, "runs", "clean-pass", "graph.json"), "utf8"));
  const table: [unknown, string | null][] = [
    [{ paths: ["/r/specs/v2.19.0-run-board.spec.md", "/r/specs/other.spec.md"] }, "v2.19.0-run-board"],
    [{ paths: ["notes.md"] }, "notes.md"], [undefined, null], [{ paths: [] }, null], [{ paths: [7] }, null], [{}, null],
  ];
  for (const [spec, want] of table) {
    const tmp = temp();
    liveRun(join(tmp, ".tickmarkr"), JSON.stringify(spec === undefined ? base : { ...base, spec }));
    expect((readRunBoard(tmp, [], [], T0 + 90) as { spec: unknown }).spec, JSON.stringify(spec)).toBe(want);
  }
});
