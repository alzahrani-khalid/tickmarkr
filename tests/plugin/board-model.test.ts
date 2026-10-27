import { expect, test } from "vitest";
import { badgeWidth, copyAllowed, countdownText, etaText, headline, needsYou, readState, triesText, visible } from "../../hooks/board/model.js";
import type { BoardState, Park, StatusSnapshot, Task } from "../../hooks/board/state.js";

const NOW = Date.parse("2026-10-27T10:00:00.000Z");
const iso = (seconds: number) => new Date(NOW + seconds * 1000).toISOString();
const command = "tickmarkr approve run-board T2441 --waive --gate review --park 93@2026-10-27T10:00:00.000Z";
const park = (taskId = "T2441"): Park => ({
  taskId, kind: "gate-fail", reason: "review round cap", token: "93@2026-10-27T10:00:00.000Z",
  commands: [{ verb: "waive", command }, { verb: "recheck", command: command.replace("--waive", "--recheck") }], noDecision: null,
});
const task = (id: string, patch: Partial<Task> = {}): Task => ({
  id, title: `Task ${id}`, deps: [], state: "pending",
  gates: { build: "unknown", test: "unknown", lint: "unknown", evidence: "unknown", scope: "unknown", acceptance: "unknown", review: "unknown" },
  tries: { round: null, budget: 3, launches: 0 }, seats: { worker: null, judge: null, reviewer: null },
  startedAt: null, endedAt: null, now: { phase: null, since: null, blocker: null, nextAction: null }, ...patch,
});
const snapshot = (patch: Partial<StatusSnapshot> = {}): StatusSnapshot => ({
  version: 1, runId: "run-board", sequence: 100, observedAt: iso(0), daemon: "alive", lifecycle: "COMPLETE",
  verdict: { green: true, fatal: false, currentTip: "passed", buckets: { failed: [], human: [], blocked: [], pending: [] }, outstanding: { known: true, debt: 0, checks: [] } },
  approvalWindow: null, tasks: [task("T2441", { state: "merged", startedAt: iso(-100), endedAt: iso(-50) })], parks: [], ...patch,
});
const state = (snap: StatusSnapshot): BoardState => readState({ exitCode: 0, stdout: JSON.stringify(snap) });

test("test: the board headline reads green only when the snapshot's verdict is green, and a parked, partial, owing, fatal, unknown-debt or daemon-down snapshot reads its own non-green word in the error colour even when every task merged and the run-end buckets are empty, so a board reading green from those buckets fails", () => {
  expect(headline(state(snapshot()))).toEqual({ word: "GREEN", color: "success" });
  const base = snapshot();
  const red = { ...base.verdict, green: false };
  const cases: [string, StatusSnapshot, string][] = [
    ["parked", snapshot({ lifecycle: "PARTIAL", verdict: red, parks: [park()] }), "PARTIAL"],
    ["partial", snapshot({ lifecycle: "PARTIAL", verdict: red }), "PARTIAL"],
    ["owing", snapshot({ lifecycle: "PARTIAL", verdict: { ...red, outstanding: { known: true, debt: 2, checks: ["review"] } } }), "PARTIAL · owes 2"],
    ["fatal", snapshot({ lifecycle: "PARTIAL", verdict: { ...red, fatal: true } }), "PARTIAL"],
    ["unknown-debt", snapshot({ lifecycle: "UNKNOWN", verdict: { ...red, outstanding: { known: false, reason: "legacy waiver" } } }), "UNKNOWN · owed unknown"],
    ["daemon-down", snapshot({ lifecycle: "RUNNING", daemon: "dead", verdict: red }), "DAEMON DOWN"],
    ["complete without verdict", snapshot({ verdict: red }), "COMPLETE"],
  ];
  for (const [label, snap, word] of cases) {
    expect(snap.tasks.every(task => task.state === "merged"), label).toBe(true);
    expect(Object.values(snap.verdict.buckets).every(ids => ids?.length === 0), label).toBe(true);
    expect(headline(state(snap)), label).toEqual({ word, color: "error" });
  }
  expect(headline(state(snapshot({ lifecycle: "RUNNING", verdict: red })))).toEqual({ word: "RUNNING", color: "warning" });
  for (const lifecycle of ["PENDING", "APPROVED", "UNKNOWN"] as const) {
    expect(headline(state(snapshot({ lifecycle, verdict: red })))).toEqual({ word: lifecycle, color: "error" });
  }
});

test("test: the board lays cards in the snapshot's task order with a badge as wide as the longest id plus one, never under six cells, and writes tries as round over budget adding the launches in all only when they exceed the round, so a five-character id that wraps or launches hiding a resume fails", () => {
  const tasks = [task("T9"), task("T2441"), task("T2")];
  const read = state(snapshot({ tasks }));
  expect("snapshot" in read && read.snapshot.tasks.map(task => task.id)).toEqual(["T9", "T2441", "T2"]);
  expect(badgeWidth(tasks.map(task => task.id), 1)).toBe(6);
  expect(badgeWidth(tasks.map(task => task.id), 1.3)).toBe(9);
  expect(badgeWidth(["T123456"], 1)).toBe(8);
  expect(badgeWidth(["T123456"], 2)).toBe(12);
  expect(badgeWidth([], 1)).toBe(6);
  expect(badgeWidth(["T1"], 1.3)).toBe(6);
  expect(badgeWidth(["T😀😀😀😀"], 1)).toBe(6);
  expect(triesText(task("T1"))).toBe("–");
  for (const [round, budget, launches, text] of [[1, 3, 1, "1/3"], [2, 4, 2, "2/4"], [2, 3, 7, "2/3 · 7 in all"], [1, 3, 5, "1/3 · 5 in all"]] as const) {
    expect(triesText(task("T1", { tries: { round, budget, launches } }))).toBe(text);
  }
});

test("test: the needs-you lane lists every open park with the exact commands of its snapshot entry, the copy check admits only those commands, and the countdown states the minutes and seconds left and that the run then ends partial, so a copy of a command the snapshot never offered fails", () => {
  const parks = [park(), { ...park("T3"), kind: "scope-request", reason: "needs files", commands: [], noDecision: "provide --files and --reason" },
    { ...park("T2"), kind: "human-gate", commands: [{ verb: "approve" as const, command: "tickmarkr approve run-board T2 --park 99@2026-10-27T10:00:00.000Z" }] }];
  const s = state(snapshot({ parks, approvalWindow: { opensAt: iso(-10), closesAt: iso(80), parked: parks.map(p => p.taskId) } }));
  expect(needsYou(s)).toEqual(parks.map(p => ({ task: p.taskId, kind: p.kind, reason: p.reason, commands: p.commands })));
  for (const p of parks) for (const offered of p.commands) expect(copyAllowed(s, offered.command)).toBe(true);
  for (const bait of ["tickmarkr approve run-board T2441", command + " ", command.replace("93@", "92@"), command.replace("--waive", "--uphold"), ""]) expect(copyAllowed(s, bait)).toBe(false);
  expect(countdownText(s, NOW)).toBe("approval window closes in 1:20 — then the run ends PARTIAL");
  expect(countdownText(s, NOW + 1000)).toBe("approval window closes in 1:19 — then the run ends PARTIAL");
  for (const now of [NOW + 80_000, NOW + 90_000]) expect(countdownText(s, now)).toBe("approval window closing — the run ends PARTIAL unless released");
  expect(countdownText(state(snapshot()), NOW)).toBeNull();
});

test("test: the estimate multiplies the median merged task duration by the unmerged tasks on the longest unmerged dependency chain, names the parked tasks that stop the clock, reads unknown before the first merge and is absent after the run ends, so an estimate from a fixed guess fails", () => {
  const merged = (id: string, seconds: number) => task(id, { state: "merged", startedAt: iso(-10_000), endedAt: iso(-10_000 + seconds) });
  const tasks = [merged("M1", 60), merged("M2", 120), merged("M3", 1200),
    task("T4", { deps: ["T3"] }), task("T3", { deps: ["T2"] }), task("T2", { deps: ["M1"] }), task("T5"), task("T6")];
  const snap = snapshot({ lifecycle: "RUNNING", tasks, parks: [park("T2"), park("T5")] });
  expect(etaText(state(snap), NOW)).toBe("ETA 6m 00s · clock stopped on T2, T5");
  expect(etaText(state(snap), NOW + 100_000)).toBe("ETA 6m 00s · clock stopped on T2, T5");
  expect(etaText(state({ ...snap, tasks: [merged("M1", 10), merged("M2", 20), task("T1")] }), NOW)).toBe("ETA 15s · clock stopped on T2, T5");
  expect(etaText(state({ ...snap, parks: [], tasks: [merged("M1", 3750), task("T1")] }), NOW)).toBe("ETA 1h 02m");
  // A merged task breaks a remaining chain; wide independent work is not added to its length.
  expect(etaText(state({ ...snap, parks: [], tasks: [merged("M1", 60), task("A"), { ...merged("M2", 60), deps: ["A"] }, task("B", { deps: ["M2"] }), task("C")] }), NOW)).toBe("ETA 1m 00s");
  expect(etaText(state({ ...snap, tasks: [task("T1")] }), NOW)).toBe("ETA unknown until the first merge");
  expect(etaText(state({ ...snap, tasks: [merged("M1", 60)], parks: [] }), NOW)).toBe("ETA 0s");
  for (const lifecycle of ["PARTIAL", "COMPLETE", "APPROVED", "UNKNOWN", "PENDING"] as const) expect(etaText(state({ ...snap, lifecycle }), NOW)).toBeNull();
});

test("test: a status read that exits non-zero, prints malformed JSON, names another version or whose process call rejects replaces a green board state with an unreadable state whose headline is not green and states why and whose copy check admits nothing, so a board keeping a previous green fails", () => {
  const green = state(snapshot({ parks: [park()] }));
  expect(headline(green)).toEqual({ word: "GREEN", color: "success" });
  expect(copyAllowed(green, command)).toBe(true);
  const failures = [
    [readState({ exitCode: 17, stdout: JSON.stringify(snapshot()) }), "code 17"],
    [readState({ exitCode: 0, stdout: "{broken" }), "malformed status JSON"],
    [readState({ exitCode: 0, stdout: JSON.stringify({ ...snapshot(), version: 2 }) }), "unsupported status version: 2"],
    [readState({ rejected: new Error("permission denied") }), "status process rejected: Error: permission denied"],
    [readState({ exitCode: 0, stdout: "null" }), "unsupported status version: undefined"],
  ] as const;
  for (const [failure, why] of failures) {
    let current = green;
    current = failure;
    expect(current).not.toHaveProperty("snapshot");
    expect(headline(current).word).toContain(`STATUS UNREADABLE — `);
    expect(headline(current).word).toContain(why);
    expect(headline(current).color).toBe("error");
    expect(needsYou(current)).toEqual([]);
    expect(copyAllowed(current, command)).toBe(false);
    expect(countdownText(current, NOW)).toBeNull();
    expect(etaText(current, NOW)).toBeNull();
  }
  expect(headline(state(snapshot())).color).toBe("success");
});

test("test: a park whose reason carries an OSC 52 clipboard write and a CSI cursor-up and erase, and whose task id, kind and status version carry controls, displays every C0 control but tab and newline, DEL and every C1 control as visible text with no ESC or BEL byte, while the copy check still admits exactly the snapshot's original command bytes, so a board passing a raw control to the terminal fails", () => {
  const ESC = String.fromCharCode(27);
  const BEL = String.fromCharCode(7);
  const slash = String.fromCharCode(92);
  const raw = (text: string) => text.includes(ESC) || text.includes(BEL);
  const reason = `review red ${ESC}]52;c;dG91Y2ggL3RtcC9vd25lZA==${BEL}${ESC}[1A${ESC}[2K all clear`;
  const hostileCommand = `${command} ${ESC}]52;c;eA==${BEL}`;
  const parks = [{ ...park(), kind: `gate-fail${ESC}[2J`, reason }, { ...park(`T9${ESC}[2J`), commands: [{ verb: "waive" as const, command: hostileCommand }] }];
  const s = state(snapshot({ lifecycle: "RUNNING", verdict: { ...snapshot().verdict, green: false }, tasks: [task("T1", { state: "merged", startedAt: iso(-100), endedAt: iso(-50) }), task("T2")], parks }));
  const [first, second] = needsYou(s);
  expect(first!.reason).toBe(`review red ${slash}x1b]52;c;dG91Y2ggL3RtcC9vd25lZA==${slash}x07${slash}x1b[1A${slash}x1b[2K all clear`);
  expect(first!.kind).toBe(`gate-fail${slash}x1b[2J`);
  expect(second!.task).toBe(`T9${slash}x1b[2J`);
  const unreadable = readState({ exitCode: 0, stdout: JSON.stringify({ ...snapshot(), version: `9${ESC}]52;c;eA==${BEL}` }) });
  for (const text of [first!.task, first!.kind!, first!.reason!, second!.task, etaText(s, NOW)!, headline(s).word, headline(unreadable).word]) expect(raw(text), text).toBe(false);
  expect(etaText(s, NOW)).toBe(`ETA 50s · clock stopped on T2441, T9${slash}x1b[2J`);
  // Copy compares the snapshot's original bytes, never the display text.
  expect(first!.commands).toEqual(park().commands);
  expect(copyAllowed(s, command)).toBe(true);
  expect(copyAllowed(s, hostileCommand)).toBe(true);
  expect(copyAllowed(s, visible(hostileCommand))).toBe(false);
  // The closed table: C0 but tab and newline, DEL and C1 become escapes; everything else is untouched.
  const cases: [number, string][] = [[0, "x00"], [8, "x08"], [11, "x0b"], [13, "x0d"], [27, "x1b"], [31, "x1f"], [127, "x7f"], [128, "u0080"], [155, "u009b"], [159, "u009f"]];
  for (const [code, shown] of cases) expect(visible(`a${String.fromCharCode(code)}b`), shown).toBe(`a${slash}${shown}b`);
  for (const code of [9, 10, 32, 126, 160, 233]) expect(visible(`a${String.fromCharCode(code)}b`)).toBe(`a${String.fromCharCode(code)}b`);
});
