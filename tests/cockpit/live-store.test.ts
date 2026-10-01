import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, chmodSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { setTimeout as sleep } from "node:timers/promises";
import { afterEach, expect, test, vi } from "vitest";
import { graphDefinitionHash } from "../../src/graph/graph.js";
import { validateGraph } from "../../src/graph/schema.js";
import { APPROVAL_REFUSED, captureOwedCheck, GATE_SATISFIED_RELEASE, OWED_DISCHARGE_EVENT, owedSubject, type JournalEvent } from "../../src/run/journal.js";
import { readOperatorState } from "../../src/run/operator-state.js";
import { boardFrame, renderBoard, stripBoardAnsi } from "../../src/tui/cockpit/board.js";
import { createLiveStore, journalBasis, JournalTail, STORE_LIMITS, type LiveStore } from "../../src/tui/cockpit/live-store.js";
import { decidedLiveStore, runConsolidatedCockpit, type ShellDelivery } from "../../src/tui/cockpit/live-runtime.js";
import { ttyInput } from "../helpers/tty-input.js";
import { graph, partial, rawOf, ev } from "../fixtures/operator-state/fixture.js";

// I2: a pass-through git counter — every integration re-proof starts with one `show -s --format=%P <head>`.
const git = vi.hoisted(() => ({ proofs: 0 }));
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  const execFileSync = ((file: string, args?: readonly string[], options?: object) => {
    if (file === "git" && args?.includes("--format=%P")) git.proofs++;
    return actual.execFileSync(file, args as string[], options as never);
  }) as typeof actual.execFileSync;
  return { ...actual, default: { ...actual, execFileSync }, execFileSync };
});
// I2: a pass-through fs with one-shot faults on the complete-journal (readLedger) open: a writer that runs
// between the tail's observation and that read, and an EMFILE on one path.
const fsFault = vi.hoisted(() => ({ emfile: undefined as string | undefined, beforeLedger: undefined as (() => void) | undefined }));
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const openSync = ((path: string, ...rest: unknown[]) => {
    const ledger = (fsFault.emfile !== undefined || fsFault.beforeLedger !== undefined) && new Error().stack?.includes("readLedger");
    if (ledger && fsFault.beforeLedger) { const write = fsFault.beforeLedger; fsFault.beforeLedger = undefined; write(); }
    if (ledger && fsFault.emfile !== undefined && path === fsFault.emfile) {
      fsFault.emfile = undefined;
      throw Object.assign(new Error(`EMFILE: too many open files, open '${path}'`), { code: "EMFILE" });
    }
    return (actual.openSync as (...args: unknown[]) => number)(path, ...rest);
  }) as typeof actual.openSync;
  return { ...actual, default: { ...actual, openSync }, openSync };
});
const dirs: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function fixture() {
  const cwd = mkdtempSync(join(tmpdir(), "operator-state-")); dirs.push(cwd);
  const state = join(cwd, ".tickmarkr"); const runId = "run-20260905-000000";
  const run = join(state, "runs", runId); mkdirSync(run, { recursive: true });
  const path = join(run, "journal.jsonl"); writeFileSync(path, rawOf(partial));
  writeFileSync(join(state, "graph.json"), JSON.stringify(graph));
  return { cwd, state, runId, path };
}

test("The production-facing tail interface reads append bytes once, carries torn multibyte UTF-8 until newline and keeps original journal line identities through malformed complete rows, same-size in-place rewrite, truncation and inode replacement. Its snapshots distinguish pending incomplete tails from malformed complete records and expose unreadable/corrupt input with source and error while a valid seeded journal stays readable. A malformed record becoming empty success, stale rows surviving rewrite, or selected #L becoming a filtered ordinal fails.", () => {
  const { path } = fixture(); const tail = new JournalTail(path);
  const seeded = tail.poll(1000); expect(seeded.status).toBe("readable"); expect(seeded.lines).toBe(7);
  const bytes = Buffer.from(JSON.stringify(ev("worker-nudge", { text: "你好🌍" })) + "\n");
  const cut = bytes.indexOf(Buffer.from("🌍")) + 2;
  appendFileSync(path, bytes.subarray(0, cut));
  const torn = tail.poll(2000); expect(torn.status).toBe("pending"); expect(torn.pending).toEqual({ line: 8, bytes: cut }); expect(torn.malformedCount).toBe(0);
  expect(tail.poll(2500).bytesRead).toBe(torn.bytesRead);
  appendFileSync(path, bytes.subarray(cut, -1)); expect(tail.poll(3000).pending).toBeDefined();
  appendFileSync(path, "\n"); const joined = tail.poll(4000);
  expect(joined.history.at(-1)).toMatchObject({ line: 8, id: `${path}#L8`, event: { data: { text: "你好🌍" } } });
  expect(joined.bytesRead - seeded.bytesRead).toBe(bytes.length);
  appendFileSync(path, "{malformed}\n\n" + rawOf([ev("worker-nudge")]));
  const corrupt = tail.poll(5000); expect(corrupt.status).toBe("corrupt"); expect(corrupt.errors[0]).toMatchObject({ source: path, line: 9 }); expect(corrupt.errors[0]!.error).toBeTruthy();
  expect(corrupt.history.at(-1)!.id).toBe(`${path}#L11`);
  expect(tail.page(9, 3).map(r => [r.line, !!r.error])).toEqual([[9, true], [10, false], [11, false]]);
  const same = rawOf([ev("run-start", { text: "aaaa" })]); writeFileSync(path, same); tail.poll();
  writeFileSync(path, same.replace("aaaa", "bbbb")); const rewrite = tail.poll();
  expect(rewrite.history).toHaveLength(1); expect(rewrite.history[0]!.event!.data.text).toBe("bbbb"); expect(rewrite.errors).toEqual([]);
  const oldGeneration = rewrite.generation; const replacement = path + ".replacement";
  writeFileSync(replacement, same.replace("aaaa", "cccc")); renameSync(replacement, path);
  expect(tail.poll().generation).toBeGreaterThan(oldGeneration); expect(tail.page(1)[0]!.event!.data.text).toBe("cccc");
  expect(() => tail.page(1, 1, oldGeneration)).toThrow(/replaced/);
  writeFileSync(path, ""); expect(tail.poll()).toMatchObject({ lines: 0, history: [], pending: undefined });
  rmSync(path); mkdirSync(path); expect(tail.poll()).toMatchObject({ status: "unreadable", error: { source: path } });
  const missing = new JournalTail(path + "missing").poll(); expect(missing.status).toBe("unreadable"); expect(missing.error!.error).toMatch(/ENOENT/);
});

test("The exported store independently delivers changed graph/config/cache identity, clock/beat expiry, dead versus EPERM lock probes, input and resize while journal bytes remain static, marking observations delayed after two one-second target intervals. After 10000 appended events bounded history still pages an early multiline verdict by original #L and retains durable task/merge facts and errors. Repeated whole-file reads on idle, growth-only invalidation or evicted evidence becoming unreachable fails.", async () => {
  const f = fixture(); let now = Date.now();
  mkdirSync(join(f.state, "supervision")); const beat = join(f.state, "supervision", "orchestrator.beat");
  writeFileSync(beat, JSON.stringify({ seat: "orch" })); utimesSync(beat, new Date(now), new Date(now));
  writeFileSync(join(f.state, "graph.lock"), JSON.stringify({ pid: 123456, runId: f.runId, startedAt: now }));
  const kill = vi.spyOn(process, "kill").mockImplementation(() => { throw Object.assign(new Error("protected"), { code: "EPERM" }); });
  const store = createLiveStore({ ...f, now: () => now }); let deliveries = 0; const unsubscribe = store.subscribe(() => { deliveries++; });
  const opening = store.snapshot(); expect(opening.lock).toMatchObject({ state: "alive", alive: true });
  expect(opening.operator).toMatchObject({ merged: 1, planned: 3 });
  expect(opening.supervision[0]!.state).toBe("ARMED");
  now += 1000; store.refresh(); expect(store.snapshot().delayed).toBe(false);
  expect(store.snapshot().journal.bytesRead).toBe(opening.journal.bytesRead);
  now += 61000; store.refresh(); expect(store.snapshot().delayed).toBe(true); expect(store.snapshot().supervision[0]!.state).toBe("STALE");
  kill.mockImplementation(() => { throw Object.assign(new Error("dead"), { code: "ESRCH" }); }); now += 1000; store.refresh(); expect(store.snapshot().lock.state).toBe("dead"); expect(store.snapshot().delayed).toBe(false);
  const foreign = structuredClone(graph); foreign.tasks[0]!.goal = "changed"; writeFileSync(join(f.state, "graph.json"), JSON.stringify(foreign));
  writeFileSync(join(f.state, "config.yaml"), "mode: risk-based\n"); writeFileSync(join(f.state, "doctor.json"), '{"revision":1}'); store.refresh();
  const changed = store.snapshot(); expect(changed.graph.identity).not.toBe(opening.graph.identity); expect(changed.operator.comparable).toBe(false); expect(changed.config.value).toBe("mode: risk-based\n"); expect(changed.cache.value).toEqual({ revision: 1 });
  writeFileSync(join(f.state, "doctor.json"), "{bad");
  store.refresh();
  expect(store.snapshot().cache.status).toBe("unreadable");
  expect(store.snapshot().cache.value).toBeUndefined();
  expect(store.snapshot().cache.identity).toBeUndefined();
  writeFileSync(join(f.state, "doctor.json"), '{"revision":2}'); store.refresh(); expect(store.snapshot().cache.value).toEqual({ revision: 2 });
  writeFileSync(join(f.state, "graph.json"), JSON.stringify(graph));
  store.input(); store.resize(80, 24); expect(store.snapshot()).toMatchObject({ inputSequence: 1, viewport: { columns: 80, rows: 24 } }); expect(deliveries).toBeGreaterThan(5);
  expect(store.snapshot().operator.sequence).toBe(store.snapshot().sequence);
  expect(store.snapshot().journal.bytesRead).toBe(opening.journal.bytesRead);
  appendFileSync(f.path, "malformed complete record\n"); store.refresh();
  appendFileSync(f.path, rawOf(Array.from({ length: 10000 }, () => ev("worker-nudge", {}, "T1"))));
  do { now += 1000; store.refresh(); } while (store.snapshot().journal.backlogBytes);
  const final = store.snapshot(); expect(final.journal.history.length).toBeLessThanOrEqual(STORE_LIMITS.history); expect(final.journal.history[0]!.line).toBeGreaterThan(3);
  expect(final.operator).toMatchObject({ merged: 1, planned: 3, green: false }); expect(final.operator.tasks[0]!.mergeEvidence!.id).toBe(`${f.path}#L4`);
  expect(final.journal.malformedCount).toBe(1); expect(final.errors).toEqual(expect.arrayContaining([expect.objectContaining({ source: f.path, line: 8 })]));
  expect(store.page(3, 1)[0]).toMatchObject({ id: `${f.path}#L3`, event: { data: { details: "First verdict\nSecond line\n第三行" } } });
  expect(store.page(8, 1)[0]!.error).toBeTruthy();
  for (let i = 0; i < 30; i++) { now += 1000; store.refresh(); }
  const one = store.requestRefresh(); for (let i = 0; i < 100; i++) expect(store.requestRefresh()).toBe(one);
  expect(store.diagnostics().pendingReads).toBe(1); await one;
  expect(store.diagnostics()).toMatchObject({ pendingReads: 0, metrics: STORE_LIMITS.metrics });
  const removers = Array.from({ length: STORE_LIMITS.subscribers - 1 }, () => store.subscribe(() => {})); expect(() => store.subscribe(() => {})).toThrow(/limit/); removers.forEach(remove => remove());
  unsubscribe(); store.dispose(); expect(store.diagnostics().subscriptions).toBe(0);
});


test("test: the live board renders the complete matching 1.8 MiB plan versus named unreadability above its graph cap or noncomparability for a mismatched hash, so inheriting the journal record cap fails", () => {
  const f = fixture();
  const large = structuredClone(graph);
  large.tasks = Array.from({ length: 120 }, (_, i) => ({ ...structuredClone(graph.tasks[0]!), id: `T${i + 1}`, title: `Plan task ${i + 1}`, goal: "x".repeat(15_500) }));
  const raw = JSON.stringify(large);
  expect(Buffer.byteLength(raw)).toBeGreaterThan(1.8 * 1024 * 1024);
  expect(Buffer.byteLength(raw)).toBeLessThan(1.9 * 1024 * 1024);
  writeFileSync(join(f.state, "graph.json"), raw);
  writeFileSync(f.path, rawOf([ev("run-start", { graphDefinitionHash: graphDefinitionHash(large) }), ev("task-dispatch", {}, "T1")]));
  const store = createLiveStore(f);
  const frame = () => boardFrame({ runId: f.runId, snapshot: store.snapshot().operator, graph: store.snapshot().graph.value, now: 0, colour: false }, 180);
  const rendered = () => renderBoard({ runId: f.runId, snapshot: store.snapshot().operator, graph: store.snapshot().graph.value, now: 0, colour: false }, 180).join("\n");
  try {
    expect(store.snapshot().graph.status).toBe("readable");
    expect(store.snapshot().operator.planned).toBe(120);
    expect(frame().rows.map(r => r.id)).toEqual(large.tasks.map(t => t.id));
    expect(rendered()).toContain("Plan task 120");
    // A valid graph beyond its own finite bound must evict the cached good value.
    const oversized = structuredClone(large);
    oversized.tasks[0]!.goal = "x".repeat(STORE_LIMITS.graphBytes);
    writeFileSync(join(f.state, "graph.json"), JSON.stringify(oversized)); store.refresh();
    expect(store.snapshot().graph).toMatchObject({ status: "unreadable" });
    expect(store.snapshot().graph.value).toBeUndefined();
    expect(store.snapshot().operator.planned).toBeUndefined();
    expect(rendered()).toContain(`graph unreadable: source exceeds ${STORE_LIMITS.graphBytes} byte cap`);
    expect(frame().rows.map(r => r.id)).toEqual(["T1"]);
    large.tasks[0]!.goal += "changed";
    writeFileSync(join(f.state, "graph.json"), JSON.stringify(large)); store.refresh();
    expect(store.snapshot().graph.status).toBe("readable");
    expect(rendered()).toContain("graph not comparable");
    expect(rendered()).not.toContain("Plan task 120");
    expect(store.snapshot().operator.planned).toBeUndefined();
    expect(STORE_LIMITS.recordBytes).toBe(1024 * 1024);
    appendFileSync(f.path, rawOf([ev("worker-nudge", { text: "x".repeat(STORE_LIMITS.recordBytes) }, "T1")]));
    do { store.refresh(); } while (store.snapshot().journal.backlogBytes);
    expect(store.snapshot().journal.errors.at(-1)?.error).toContain("record exceeds 1048576 bytes");
  } finally { store.dispose(); }
});

/* I1 — unfinished gate cells settle to unknown at terminal boundaries. Cells, declaration order:
 * build test lint evidence scope acceptance review. T1: build passed, test queued, acceptance running,
 * review failed. T2 (the sibling): build passed, test running, lint queued. */
const START = ev("run-start", { graphDefinitionHash: graphDefinitionHash(graph) });
const UNFINISHED = [
  START,
  ev("task-dispatch", { attempt: 0 }, "T1"),
  ev("gate-result", { gate: "build", pass: true }, "T1"),
  ev("gate-result", { gate: "review", pass: false, details: "requested changes" }, "T1"),
  ev("suite-wait", { gate: "test", count: 2 }, "T1"),
  ev("gate-start", { gate: "acceptance" }, "T1"),
  ev("task-dispatch", { attempt: 0 }, "T2"),
  ev("gate-result", { gate: "build", pass: true }, "T2"),
  ev("suite-wait", { gate: "lint" }, "T2"),
  ev("gate-start", { gate: "test" }, "T2"),
];
const RUN_END = ev("run-end", { done: [], failed: [], human: ["T1"], blocked: [], pending: ["T2", "T3"], tipVerify: "not required" });
type Liveness = "alive" | "dead" | "eperm" | "foreign" | "unreadable" | "absent";
function liveStoreOf(events: ReturnType<typeof ev>[], liveness: Liveness) {
  const f = fixture();
  writeFileSync(f.path, rawOf(events));
  const lock = join(f.state, "graph.lock");
  if (liveness === "unreadable") writeFileSync(lock, "{ not a lock");
  else if (liveness !== "absent") writeFileSync(lock, JSON.stringify({ pid: 424242, runId: liveness === "foreign" ? "run-other" : f.runId, startedAt: Date.now() }));
  vi.spyOn(process, "kill").mockImplementation(() => {
    if (liveness === "alive") return true;
    throw Object.assign(new Error(liveness), { code: liveness === "eperm" ? "EPERM" : "ESRCH" });
  });
  const store = createLiveStore(f);
  const snap = store.snapshot();
  store.dispose();
  return { f, snap };
}
/** The fold's cells and the board's painted strip for one task — both must agree. */
const cellsOf = ({ snap }: ReturnType<typeof liveStoreOf>, id: string) => {
  const task = snap.operator.tasks.find(t => t.id === id)!;
  const strip = stripBoardAnsi(boardFrame({ runId: "r", snapshot: snap.operator, graph: snap.graph.value, now: 0, colour: false }, 150).rows.find(r => r.id === id)!.strip).replace(/ /g, "");
  return { states: Object.values(task.gates).map(g => g.state).join(" "), strip, activity: task.gateActivity };
};

test("test: production live store/board settle running/queued cells on task-human task-failed and task-blocked while preserving an active sibling; run-end and dead matching daemon settle all unfinished cells; measured passed/failed cells survive every row", () => {
  const open = liveStoreOf(UNFINISHED, "alive");
  expect(cellsOf(open, "T1")).toMatchObject({ states: "passed queued not-run not-run not-run running failed", strip: "✔Q···R✖" });
  expect(cellsOf(open, "T2")).toMatchObject({ states: "passed running queued not-run not-run not-run not-run", strip: "✔RQ····" });
  for (const terminal of ["task-human", "task-failed", "task-blocked"]) {
    const parked = liveStoreOf([...UNFINISHED, ev(terminal, { kind: "human-gate", reason: "fixture" }, "T1")], "alive");
    expect(parked.snap.lock.state, terminal).toBe("alive");
    expect(cellsOf(parked, "T1"), terminal).toEqual({ states: "passed unknown not-run not-run not-run unknown failed", strip: "✔?···?✖", activity: undefined });
    // The sibling is still under measurement: its running and queued cells stay exactly as recorded.
    expect(cellsOf(parked, "T2"), terminal).toMatchObject({ states: "passed running queued not-run not-run not-run not-run", strip: "✔RQ····", activity: { state: "running", gate: "test" } });
  }
  const ended = liveStoreOf([...UNFINISHED, RUN_END], "alive");
  const dead = liveStoreOf(UNFINISHED, "dead");
  expect(dead.snap.lock.state).toBe("dead");
  for (const [row, settled] of [["run-end", ended], ["dead matching daemon", dead]] as const) {
    expect(cellsOf(settled, "T1"), row).toEqual({ states: "passed unknown not-run not-run not-run unknown failed", strip: "✔?···?✖", activity: undefined });
    expect(cellsOf(settled, "T2"), row).toEqual({ states: "passed unknown unknown not-run not-run not-run not-run", strip: "✔??····", activity: undefined });
    // The cell keeps the journal row that started it, never a fabricated one.
    expect(settled.snap.operator.tasks[1]!.gates.test!.evidence!.line, row).toBe(10);
  }
  // A resume re-dispatch measures afresh: the settled cells reset and a new start reads running again.
  const resumed = liveStoreOf([...UNFINISHED, RUN_END, ev("run-resume"), ev("task-dispatch", { attempt: 1 }, "T2"), ev("gate-start", { gate: "build" }, "T2")], "alive");
  expect(cellsOf(resumed, "T2").strip).toBe("R······");
  expect(cellsOf(resumed, "T1").strip).toBe("✔?···?✖");
});

test("test: production live store distinguishes dead matching daemon from alive foreign unreadable and EPERM liveness so uncertain ownership cannot settle unrelated active cells", () => {
  const states: Record<Liveness, string> = { dead: "dead", alive: "alive", eperm: "alive", foreign: "foreign", unreadable: "unreadable", absent: "absent" };
  for (const liveness of Object.keys(states) as Liveness[]) {
    const observed = liveStoreOf(UNFINISHED, liveness);
    expect(observed.snap.lock.state, liveness).toBe(states[liveness]);
    const settles = liveness === "dead";
    expect(cellsOf(observed, "T2"), liveness).toMatchObject(settles
      ? { states: "passed unknown unknown not-run not-run not-run not-run", strip: "✔??····", activity: undefined }
      : { states: "passed running queued not-run not-run not-run not-run", strip: "✔RQ····", activity: { state: "running", gate: "test" } });
    expect(cellsOf(observed, "T1").strip, liveness).toBe(settles ? "✔?···?✖" : "✔Q···R✖");
  }
});

// ── I2: every completion headline requires known-empty CURRENT owed-check debt ─────────────────────
const owedGraph = validateGraph({ version: 1, spec: { paths: ["owed.md"], hash: "owed", source: "native" }, tasks: [{ id: "T1", title: "Owed task", goal: "g", shape: "implement", complexity: 1, deps: [], files: [], acceptance: ["fixture"] }] });
const OWED_TS = "2026-09-05T00:00:00.000Z";
const sha = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
/** A real git repository with one waived task range, its integration merge, and a second merge of the same range. */
function owedFixture({ filler = 0 } = {}) {
  const cwd = mkdtempSync(join(tmpdir(), "owed-store-")); dirs.push(cwd);
  const g = (...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  g("init", "-q", "-b", "main"); g("config", "user.email", "t@example.com"); g("config", "user.name", "t"); g("config", "commit.gpgsign", "false");
  writeFileSync(join(cwd, "a.txt"), "base\n"); g("add", "a.txt"); g("commit", "-qm", "base");
  const base = g("rev-parse", "HEAD");
  g("checkout", "-qb", "task"); writeFileSync(join(cwd, "b.txt"), "work\n"); g("add", "b.txt"); g("commit", "-qm", "work");
  const head = g("rev-parse", "HEAD");
  g("checkout", "-q", "main"); g("merge", "-q", "--no-ff", "-m", "merge T1", "task");
  const merge = g("rev-parse", "HEAD");
  g("checkout", "-qb", "again", base); g("merge", "-q", "--no-ff", "-m", "merge T1 again", "task");
  const again = g("rev-parse", "HEAD"); g("checkout", "-q", "main");
  const runId = "run-20260905-000000";
  const run = join(cwd, ".tickmarkr", "runs", runId); mkdirSync(run, { recursive: true });
  writeFileSync(join(cwd, ".tickmarkr", "graph.json"), JSON.stringify(owedGraph));
  const path = join(run, "journal.jsonl");
  const opened = [
    ev("run-start", { graphDefinitionHash: graphDefinitionHash(owedGraph) }),
    ev("task-dispatch", { attempt: 0, assignment: { adapter: "fake", model: "fake-1" } }, "T1"),
    ev("gate-result", { gate: "acceptance", pass: false, commit: owedSubject(cwd, base, head) }, "T1"),
    ev("task-human", { kind: "gate-failed" }, "T1"),
    ev("run-end", { done: [], failed: [], human: ["T1"], blocked: [], pending: [], tipVerify: "passed" }),
  ];
  // The obligation approve writes into the waive row, captured from the real range.
  const obligation = captureOwedCheck({ cwd, runId, taskId: "T1", gate: "acceptance", cause: "operator accepted risk", acceptance: ["fixture"], files: [],
    declared: [{ key: "fake:fake-1", vendor: "fake" }], taskRef: "task", integrationRef: base, events: opened });
  const waive = ev("task-approved", { release: GATE_SATISFIED_RELEASE, gate: "acceptance", park: { line: 4, ts: OWED_TS }, obligation }, "T1");
  const ended = [...opened, waive, ev("run-resume"), ...Array.from({ length: filler }, () => ev("worker-nudge", {})),
    ev("task-done", {}, "T1"), ev("merge", { commit: merge }, "T1"), ev("tip-verify", { pass: true }),
    ev("run-end", { done: ["T1"], failed: [], human: [], blocked: [], pending: [], tipVerify: "passed" })];
  writeFileSync(path, rawOf(ended));
  const artifact = (mergeBase: string, at: string) => {
    const file = join(run, `verify-${at.slice(0, 12)}.json`);
    writeFileSync(file, JSON.stringify({ head: at, mergeBase, green: true, files: [], criteria: obligation.criteria, gateRows: [{ gate: "acceptance", pass: true }] }));
    return file;
  };
  const discharge = (mapping: "exact" | "integration", mergeBase: string, at: string, artifactPath = artifact(mergeBase, at)): JournalEvent => ev(OWED_DISCHARGE_EVENT, {
    ids: [obligation.id], gates: ["acceptance"], mapping, mergeBase, head: at, criteria: obligation.criteria,
    artifactPath, artifactSha256: sha(readFileSync(artifactPath)), authorChannels: [],
  }, "T1");
  /** An unbound approval the daemon refused: the raw fold reads it as a release, the decided wrapper refolds without it. */
  const refused = (): JournalEvent[] => {
    const line = readFileSync(path, "utf8").split("\n").filter(Boolean).length + 1;
    return [ev("task-approved", {}, "T1"), ev(APPROVAL_REFUSED, { lines: [line] }, "T1")];
  };
  return { cwd, runId, path, run, base, head, merge, again, obligation, ended, artifact, discharge, refused, append: (rows: JournalEvent[]) => appendFileSync(path, rawOf(rows)) };
}
type Owed = ReturnType<typeof owedFixture>;
/** The store, its decided wrapper, and a decided wrapper over a journal holding a refused decision (the refold path). */
function owedViews(f: Owed) {
  const store = createLiveStore({ cwd: f.cwd, runId: f.runId });
  const decided = decidedLiveStore(store);
  const refusedRun = `${f.runId.slice(0, -1)}1`;
  const refusedPath = join(f.cwd, ".tickmarkr", "runs", refusedRun, "journal.jsonl");
  mkdirSync(join(refusedPath, ".."), { recursive: true });
  // The twin journal is the base journal plus a refused decision; it is replaced (new inode) only when it differs.
  const mirror = () => {
    const want = readFileSync(f.path, "utf8") + rawOf(f.refused());
    let have: string | undefined;
    try { have = readFileSync(refusedPath, "utf8"); } catch { /* first write */ }
    if (have !== want) { writeFileSync(`${refusedPath}.next`, want); renameSync(`${refusedPath}.next`, refusedPath); }
  };
  mirror();
  const refusedStore = createLiveStore({ cwd: f.cwd, runId: refusedRun });
  const refold = decidedLiveStore(refusedStore);
  const board = (s: LiveStore) => renderBoard({ runId: f.runId, snapshot: s.snapshot().operator, graph: owedGraph, now: Date.now(), colour: false }, 150).find(l => l.includes("RUN ENDED"))!;
  return {
    store, decided, refusedStore, refold, board, mirror, refusedRun,
    refresh: () => { mirror(); store.refresh(); refusedStore.refresh(); },
    /** lifecycle and debt through the store, the decided wrapper and the decided refold, plus both boards. */
    read: () => ({
      lifecycles: [store.snapshot().operator.lifecycle, decided.snapshot().operator.lifecycle, refold.snapshot().operator.lifecycle],
      debts: [store.snapshot().operator.debt, decided.snapshot().operator.debt, refold.snapshot().operator.debt],
      boards: [board(decided), board(refold)],
    }),
  };
}
/** The production cockpit mounted on the Run board: what it draws, and how many frames it committed. */
async function mountOwedCockpit(f: Owed) {
  const input = ttyInput();
  let text = "";
  const output = new Writable({ write(chunk, _encoding, next) { text += String(chunk); next(); } }) as NodeJS.WriteStream;
  Object.assign(output, { isTTY: true, columns: 180, rows: 40 });
  let delivery!: ShellDelivery;
  const done = runConsolidatedCockpit({ cwd: f.cwd, runId: f.runId, input, output, binaryVersion: "fixture", refreshMs: 2 ** 30,
    initialView: "run", observeRun: false, environment: { NO_COLOR: "1" }, onShellDelivery: d => { delivery = d; } }).then(() => undefined, e => e as Error);
  await sleep(60);
  if (!delivery) throw await done;
  return {
    delivery,
    /** Refresh once and return what the cockpit wrote since the last take. Waits for the redraw itself
     *  (a coverage-instrumented render outlives any fixed sleep); an idle refresh waits out the bound. */
    tick: async () => {
      text = "";
      const before = delivery.frames();
      delivery.refresh();
      for (const end = Date.now() + 2000; delivery.frames() === before && Date.now() < end;) await sleep(10);
      await sleep(40);
      return stripBoardAnsi(text);
    },
    close: async () => { delivery.key({ input: "c", key: { ctrl: true } }); await done; input.destroy(); output.destroy(); },
  };
}
const allComplete = { lifecycles: ["COMPLETE", "COMPLETE", "COMPLETE"], debts: [0, 0, 0], boards: [expect.stringContaining("RUN ENDED — GREEN"), expect.stringContaining("RUN ENDED — GREEN")] };
const allPartial = (debt: number | "unknown") => ({ lifecycles: ["PARTIAL", "PARTIAL", "PARTIAL"], debts: [debt, debt, debt],
  boards: [expect.stringContaining(`RUN ENDED — NOT GREEN  outstanding ${debt}`), expect.stringContaining(`RUN ENDED — NOT GREEN  outstanding ${debt}`)] });

test("test: production live store and decided wrapper show PARTIAL for one real accepted-risk obligation after execution end while a valid eligible discharge yields COMPLETE and board RUN ENDED GREEN from the same authority", () => {
  const f = owedFixture();
  expect(f.obligation).toMatchObject({ known: true, disposition: "accepted-risk", authors: ["fake:fake-1"], base: f.base, head: f.head });
  const v = owedViews(f);
  // Execution ended green — every bucket empty, tip passed — yet one accepted-risk check is owed.
  expect(v.store.snapshot().operator).toMatchObject({ buckets: { failed: [], human: [], blocked: [], pending: [] }, currentTip: "passed", merged: 1, planned: 1, green: false, outstanding: ["T1 acceptance"] });
  expect(v.read()).toEqual(allPartial(1));
  expect(v.read().boards[0]).toContain("outstanding 1 (T1 acceptance)");
  f.append([f.discharge("exact", f.base, f.head)]); v.refresh();
  expect(v.read()).toEqual(allComplete);
  expect(v.decided.snapshot().operator).toMatchObject({ green: true, outstanding: [] });
});

test("test: production live store and decided wrapper refuse COMPLETE for absent legacy malformed or unreadable debt while an explicitly known empty fold allows completion", () => {
  // Explicitly known empty: no waiver at all.
  const clean = owedFixture();
  writeFileSync(clean.path, rawOf(clean.ended.filter(e => e.event !== "task-approved")));
  expect(owedViews(clean).read()).toEqual(allComplete);
  // Legacy (no obligation on the waive row) and malformed obligations are unknown debt, never zero.
  for (const obligation of [undefined, { version: 1, known: true, id: "x" }]) {
    const f = owedFixture();
    writeFileSync(f.path, rawOf(f.ended.map(e => e.event === "task-approved" ? { ...e, data: { ...e.data, obligation } } : e)));
    expect(owedViews(f).read(), String(obligation)).toEqual(allPartial("unknown"));
  }
  // Unreadable discharge evidence: the artifact path is not a readable file.
  const f = owedFixture();
  const unreadable = f.artifact(f.base, f.head);
  const row = f.discharge("exact", f.base, f.head, unreadable);
  chmodSync(unreadable, 0o000);
  f.append([row]);
  try { expect(owedViews(f).read()).toEqual(allPartial("unknown")); } finally { chmodSync(unreadable, 0o644); }
  // Absent debt: a fold handed no authority, or a decided refold over a snapshot without one, never completes.
  const v = owedViews(f);
  expect(v.read()).toEqual(allComplete);
  const snap = v.refusedStore.snapshot();
  expect(decidedLiveStore({ ...v.refusedStore, snapshot: () => ({ ...snap, owed: undefined }) }).snapshot().operator).toMatchObject({ lifecycle: "PARTIAL", debt: "unknown", green: false });
  const events = readFileSync(f.path, "utf8").split("\n").filter(Boolean).map(l => JSON.parse(l) as JournalEvent);
  expect(readOperatorState({ events, graph: owedGraph })).toMatchObject({ lifecycle: "PARTIAL", debt: "unknown", green: false });
});

test("test: production live store and decided wrapper revoke COMPLETE after discharge artifact removal or content alteration with unchanged journal bytes while an unchanged valid artifact stays complete", () => {
  const f = owedFixture();
  const file = f.artifact(f.base, f.head);
  f.append([f.discharge("exact", f.base, f.head, file)]);
  const v = owedViews(f);
  const journal = readFileSync(f.path);
  const original = readFileSync(file);
  for (let i = 0; i < 3; i++) { v.refresh(); expect(v.read()).toEqual(allComplete); }
  writeFileSync(file, original.toString().replace('"green":true', '"green":false')); v.refresh();
  expect(v.read()).toEqual(allPartial("unknown"));
  writeFileSync(file, original); v.refresh();
  expect(v.read()).toEqual(allComplete);
  rmSync(file); v.refresh();
  expect(v.read()).toEqual(allPartial("unknown"));
  expect(readFileSync(f.path).equals(journal)).toBe(true);
});

test("a mounted cockpit redraws a revoked completion under unchanged journal bytes and stays idle while nothing visible moves", async () => {
  const f = owedFixture();
  const file = f.artifact(f.base, f.head);
  f.append([f.discharge("exact", f.base, f.head, file)]);
  const original = readFileSync(file);
  const m = await mountOwedCockpit(f);
  try {
    expect(m.delivery.snapshot().store.operator.lifecycle).toBe("COMPLETE");
    const settled = m.delivery.frames();
    expect(await m.tick()).toBe("");
    expect(m.delivery.frames()).toBe(settled);
    rmSync(file);
    expect(await m.tick()).toContain("RUN ENDED — NOT GREEN  outstanding unknown");
    expect(m.delivery.snapshot().store.operator).toMatchObject({ lifecycle: "PARTIAL", debt: "unknown" });
    expect(m.delivery.frames()).toBe(settled + 1);
    writeFileSync(file, original);
    expect(await m.tick()).toContain("RUN ENDED — GREEN");
    expect(m.delivery.frames()).toBe(settled + 2);
  } finally { await m.close(); }
});

test("an in-place prefix rewrite followed by growth refolds the existing production store and its decided wrappers to match fresh stores over the same bytes, never staying COMPLETE", () => {
  const f = owedFixture();
  f.append([f.discharge("exact", f.base, f.head)]);
  const v = owedViews(f);
  expect(v.read()).toEqual(allComplete);
  const twin = v.refusedStore.snapshot().journal.source;
  // The consumed run-end (not the last line) moves T1 from done to human at equal length, then one row is
  // appended on the same inode: the tail sees only growth and would keep folding the old run-end.
  const done = '"done":["T1"],"failed":[],"human":[]', parked = '"done":[],"failed":[],"human":["T1"]';
  expect(parked.length).toBe(done.length);
  for (const path of [f.path, twin]) {
    const raw = readFileSync(path, "utf8");
    expect(raw.split(done).length).toBe(2);
    writeFileSync(path, raw.replace(done, parked) + rawOf([ev("worker-nudge", {})]));
  }
  v.store.refresh(); v.refusedStore.refresh();
  const fresh = createLiveStore({ cwd: f.cwd, runId: f.runId }), freshTwin = createLiveStore({ cwd: f.cwd, runId: v.refusedRun });
  const views = { existing: [v.store, v.decided, v.refold], fresh: [fresh, decidedLiveStore(fresh), decidedLiveStore(freshTwin)] };
  const facts = (stores: LiveStore[]) => stores.map(s => {
    const { lifecycle, green, debt, buckets, currentTip } = s.snapshot().operator;
    return { lifecycle, green, debt, buckets, currentTip, board: v.board(s) };
  });
  const parkedRun = { lifecycle: "PARTIAL", green: false, debt: 0, buckets: { failed: [], human: ["T1"], blocked: [], pending: [] }, currentTip: "passed",
    board: expect.stringContaining("RUN ENDED — NOT GREEN  human T1") };
  expect(facts(views.fresh)).toEqual([parkedRun, parkedRun, parkedRun]);
  expect(facts(views.existing)).toEqual(facts(views.fresh));
  // The existing tail refolded the whole file under a new generation; a further refresh stays settled.
  expect(v.store.snapshot().journal.generation).toBeGreaterThan(fresh.snapshot().journal.generation);
  v.store.refresh(); v.refusedStore.refresh();
  expect(facts(views.existing)).toEqual(facts(views.fresh));
});

test("test: production live store and decided wrapper retain an obligation older than the 256-row tail window while a later valid range-bound discharge clears it and torn unreadable complete-journal evidence stays non-green", () => {
  const f = owedFixture({ filler: STORE_LIMITS.history + 44 });
  const v = owedViews(f);
  const history = v.store.snapshot().journal.history;
  expect(history.length).toBeLessThanOrEqual(STORE_LIMITS.history);
  expect(history.some(r => r.event?.event === "task-approved")).toBe(false);
  expect(v.read()).toEqual(allPartial(1));
  // A discharge naming another range does not bind the obligation; the waived range does.
  f.append([f.discharge("exact", f.base, f.merge)]); v.refresh();
  expect(v.read()).toEqual(allPartial("unknown"));
  writeFileSync(f.path, rawOf([...f.ended, f.discharge("exact", f.base, f.head)])); v.refresh();
  expect(v.read()).toEqual(allComplete);
  // A torn tail and a malformed complete row are unreadable evidence: never green.
  appendFileSync(f.path, '{"ts":"2026-09-05T00:00:00.000Z","event":"worker-nudge"'); v.store.refresh();
  expect(v.decided.snapshot().operator).toMatchObject({ lifecycle: "UNKNOWN", green: false });
  appendFileSync(f.path, "\n"); v.store.refresh();
  expect(v.decided.snapshot().operator).toMatchObject({ lifecycle: "UNKNOWN", green: false });
  expect(renderBoard({ runId: f.runId, snapshot: v.decided.snapshot().operator, graph: owedGraph, now: Date.now(), colour: false }, 150).join("\n")).not.toContain("RUN ENDED — GREEN");
  // An equal-length in-place rewrite between the tail's read and the complete-journal read (the waiver padded
  // to `{}`) is another file version: unknown debt, never COMPLETE; the next refresh reads the file corrupt.
  const r = owedFixture();
  const rv = owedViews(r);
  expect(rv.read()).toEqual(allPartial(1));
  appendFileSync(r.path, rawOf([ev("worker-nudge", {})]));
  const raw = readFileSync(r.path, "utf8");
  const waiver = raw.split("\n").find(l => l.includes('"task-approved"'))!;
  fsFault.beforeLedger = () => writeFileSync(r.path, raw.replace(waiver, "{}".padEnd(waiver.length)));
  rv.store.refresh();
  expect(fsFault.beforeLedger).toBeUndefined();
  for (const s of [rv.store, rv.decided]) expect(s.snapshot().operator).toMatchObject({ lifecycle: "PARTIAL", debt: "unknown", green: false });
  expect(rv.board(rv.decided)).toContain("RUN ENDED — NOT GREEN  outstanding unknown");
  rv.store.refresh();
  for (const s of [rv.store, rv.decided]) expect(s.snapshot().operator).toMatchObject({ lifecycle: "UNKNOWN", green: false });
  // D-857: the decided wrapper reads the very journal version the store observed. An equal-length legacy-waiver
  // rewrite between the store's observation and the decided read is unknown debt, never COMPLETE or GREEN — on
  // the plain wrapper and on the refold path alike; the next observation re-reads, and an unchanged version completes.
  const d = owedFixture();
  d.append([d.discharge("exact", d.base, d.head)]);
  const dv = owedViews(d);
  const paths = [d.path, dv.refusedStore.snapshot().journal.source];
  const originals = paths.map(path => readFileSync(path, "utf8"));
  const legacy = (raw: string) => {
    const line = raw.split("\n").find(l => l.includes('"task-approved"') && l.includes('"obligation"'))!;
    const row = JSON.parse(line) as JournalEvent;
    return raw.replace(line, JSON.stringify({ ...row, data: { ...row.data, obligation: undefined } }).padEnd(line.length));
  };
  paths.forEach((path, i) => writeFileSync(path, legacy(originals[i]!)));
  expect(paths.map(path => readFileSync(path).length)).toEqual(originals.map(raw => Buffer.byteLength(raw)));
  // Unbound, each wrapper serves only its store's own observation (the refold path's raw fold reads the
  // refused decision as a release): debt unknown and never COMPLETE or GREEN.
  for (const s of [dv.decided, dv.refold]) {
    expect(s.snapshot().operator).toMatchObject({ debt: "unknown", outstanding: [], green: false });
    expect(s.snapshot().operator.lifecycle).not.toBe("COMPLETE");
    expect(dv.board(s)).toContain("RUN ENDED — NOT GREEN  outstanding unknown");
  }
  dv.refresh();
  expect(dv.read()).toEqual(allPartial("unknown"));
  paths.forEach((path, i) => writeFileSync(path, originals[i]!)); dv.refresh();
  expect(dv.read()).toEqual(allComplete);
});

test("test: production live store and decided wrapper satisfy every row of the goal's closed memo table while a stale fold result never yields COMPLETE", async () => {
  const f = owedFixture();
  const file = f.artifact(f.base, f.merge);
  f.append([f.discharge("integration", f.base, f.merge, file)]);
  git.proofs = 0;
  const v = owedViews(f);
  expect(v.read()).toEqual(allComplete);
  const proofs = git.proofs; // one per store: the store and its refused-run twin each own a memo
  expect(proofs).toBe(2);
  // (1) unchanged observations reuse the integration re-proof, with fresh artifact reads.
  v.refresh(); v.refresh();
  expect(git.proofs).toBe(proofs);
  writeFileSync(file, "{}"); v.refresh();
  expect(v.read()).toEqual(allPartial("unknown"));
  expect(git.proofs).toBe(proofs);
  f.artifact(f.base, f.merge); v.refresh();
  expect(v.read()).toEqual(allComplete);
  // (2) a changed range re-proves once.
  f.append([ev("merge", { commit: f.again }, "T1"), f.discharge("integration", f.base, f.again)]); v.refresh();
  expect(v.read()).toEqual(allComplete);
  expect(git.proofs).toBe(proofs + 2);
  v.refresh(); v.refresh();
  expect(git.proofs).toBe(proofs + 2);
  // (3) two overlapping refreshes share one fold.
  const sequence = v.store.snapshot().sequence;
  const first = v.store.requestRefresh(), second = v.decided.requestRefresh();
  expect(second).toBe(first);
  await Promise.all([first, second]);
  expect(v.store.snapshot().sequence).toBe(sequence + 1);
  expect(v.store.diagnostics().pendingReads).toBe(0);
  // Merge eligibility is rechecked every fold: without the merge row the memoised proof does not discharge.
  writeFileSync(f.path, readFileSync(f.path, "utf8").replace(`"commit":"${f.merge}"`, `"commit":"${"0".repeat(40)}"`)); v.refresh();
  expect(v.read().debts).toEqual(["unknown", "unknown", "unknown"]);
  writeFileSync(f.path, readFileSync(f.path, "utf8").replace(`"commit":"${"0".repeat(40)}"`, `"commit":"${f.merge}"`)); v.refresh();
  expect(v.read()).toEqual(allComplete);
  // (4) a stale fold result is unknown debt: one computed over another journal basis never completes.
  const snap = v.refusedStore.snapshot();
  const stale = { ...snap.owed!, basis: `${journalBasis(snap.journal)}:previous` };
  expect(snap.owed!.fold).toMatchObject({ known: true, debt: 0 });
  expect(decidedLiveStore({ ...v.refusedStore, snapshot: () => ({ ...snap, owed: stale }) }).snapshot().operator).toMatchObject({ lifecycle: "PARTIAL", debt: "unknown", green: false });
  const events = readFileSync(f.path, "utf8").split("\n").filter(Boolean).map(l => JSON.parse(l) as JournalEvent);
  expect(readOperatorState({ events, graph: owedGraph, owed: stale, basis: journalBasis(snap.journal) })).toMatchObject({ lifecycle: "PARTIAL", debt: "unknown" });
  expect(readOperatorState({ events, graph: owedGraph, owed: snap.owed, basis: journalBasis(snap.journal) })).toMatchObject({ lifecycle: "COMPLETE", debt: 0 });
  // An operational git failure is no proof and is never memoised: once git answers again the same stores complete.
  const h = owedFixture();
  h.append([h.discharge("integration", h.base, h.merge)]);
  renameSync(join(h.cwd, ".git"), join(h.cwd, ".git-hidden"));
  const hidden = owedViews(h);
  expect(hidden.read()).toEqual(allPartial("unknown"));
  renameSync(join(h.cwd, ".git-hidden"), join(h.cwd, ".git"));
  hidden.refresh();
  expect(hidden.read()).toEqual(allComplete);
  // Nor is a refused proof: a shallow object store shows the merge parentless; once its history is complete
  // the same stores re-prove the unchanged range and complete.
  const s = owedFixture();
  s.append([s.discharge("integration", s.base, s.merge)]);
  writeFileSync(join(s.cwd, ".git", "shallow"), `${s.merge}\n`);
  const shallow = owedViews(s);
  expect(shallow.read()).toEqual(allPartial("unknown"));
  rmSync(join(s.cwd, ".git", "shallow"));
  shallow.refresh();
  expect(shallow.read()).toEqual(allComplete);
  // Likewise a failed complete-journal read is never cached: one EMFILE, then normal I/O completes on the next refresh.
  const io = owedFixture();
  io.append([io.discharge("exact", io.base, io.head)]);
  fsFault.emfile = io.path;
  const faulted = owedViews(io);
  expect(fsFault.emfile).toBeUndefined();
  for (const s of [faulted.store, faulted.decided]) expect(s.snapshot().operator).toMatchObject({ lifecycle: "PARTIAL", debt: "unknown", green: false });
  faulted.refresh();
  expect(faulted.read()).toEqual(allComplete);
});
