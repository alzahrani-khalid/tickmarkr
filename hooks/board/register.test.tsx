import { expect, mock, test } from "claude-code/testing";
import type { TestBody } from "claude-code/testing";
import type { StatusSnapshot } from "./state";

type Engine = Parameters<TestBody>[0];
type On = Parameters<TestBody>[1];
type Found = { text?: string; props: Record<string, unknown>; children: Found[] };
const NOW = Date.parse("2026-10-27T10:00:00.000Z");
const COMMAND = "tickmarkr approve run-board T2441 --waive --gate review --park 93@2026-10-27T10:00:00.000Z";
const SNAPSHOT: StatusSnapshot = {
  version: 1, runId: "run-board", sequence: 100, observedAt: new Date(NOW).toISOString(), daemon: "alive", lifecycle: "COMPLETE",
  verdict: { green: true, fatal: false, currentTip: "passed", outstanding: { known: true, debt: 0, checks: [] }, buckets: { failed: [], human: [], blocked: [], pending: [] } },
  approvalWindow: null,
  tasks: [{
    id: "T2441", title: "A task card", deps: [], state: "merged",
    gates: { build: "passed", lint: "passed", evidence: "passed", scope: "passed", acceptance: "passed", review: "passed", test: "passed" },
    tries: { round: 2, budget: 3, launches: 5 }, seats: { worker: "codex:sol", judge: "claude:fable", reviewer: null },
    startedAt: new Date(NOW - 120_000).toISOString(), endedAt: new Date(NOW - 60_000).toISOString(),
    now: { phase: "merged", since: null, blocker: null, nextAction: null },
  }],
  // Deliberately adversarial: the board must use the verdict and command list independently.
  parks: [{ taskId: "T2441", kind: "gate-fail", reason: "review", token: "93@2026-10-27T10:00:00.000Z", commands: [{ verb: "waive", command: COMMAND }], noDecision: null }],
};
const result = (snapshot: unknown = SNAPSHOT) => ({ exitCode: 0, stdout: JSON.stringify(snapshot), stderr: "", isStdoutTruncated: false, isStderrTruncated: false });

function world(on: On) {
  const clock = mock.clock(on, { now: NOW });
  const copied: string[] = [];
  const calls: { argv: readonly string[]; cwd?: string }[] = [];
  const statuses: string[] = [];
  const answer: { run: () => ReturnType<typeof result> | Promise<ReturnType<typeof result>> } = { run: () => result() };
  on("session.start", (_$, e) => ({ cwd: e.cwd }));
  on("session.cwd", () => ({ value: "/work/session" }));
  on("command.register", (_$, e) => ({ value: { command: e.name } }));
  on("process.run", async (_$, e) => {
    calls.push({ argv: e.argv, cwd: e.init?.cwd });
    return { value: await answer.run() };
  });
  on("ui.open", () => ({ value: { isPlaced: true } }));
  on("ui.status", (_$, e) => { statuses.push(e.text ?? ""); return { value: undefined }; });
  on("ui.copy", (_$, e) => { copied.push(e.text); return { value: { isCopied: true } }; });
  return { clock, copied, calls, statuses, answer };
}

async function mount($: Engine, surface: "terminal" | "desktop") {
  await $.command.run({ command: "tickmarkr-board", args: "" } as never);
  const ui = await $.ui.mount({ plugin: "tickmarkr", surface, component: "Pane", requestId: "tickmarkr-board", props: {} as never });
  await ui.resize({ columns: 180, rows: 80, in: "board" });
  return ui;
}

for (const surface of ["terminal", "desktop"] as const) {
  for (const failure of ["exit", "json", "version", "reject"] as const) {
    test(`${surface}: ${failure} replaces prior GREEN and Copy with an unreadable board`, async ($, on) => {
      const w = world(on);
      await $.session.start({ surface, isInteractive: true, cwd: "/work/session" });
      const ui = await mount($, surface);
      const before = await ui.find({ key: "headline", in: "board" }) as unknown as Found;
      expect(before.text).toBe("● GREEN");
      expect(before.children[0]!.props.color).toBe("success");
      expect(await ui.find({ key: "copy-T2441-0", in: "board" })).toBeDefined();
      await ui.press({ key: "copy-T2441-0" });
      expect(w.copied).toEqual([COMMAND]);

      const why = { exit: "code 19", json: "malformed status JSON", version: "unsupported status version: 9", reject: "status process rejected:" }[failure];
      w.answer.run = () => {
        if (failure === "reject") throw new Error("refused");
        if (failure === "exit") return { ...result(), exitCode: 19 };
        if (failure === "json") return { ...result(), stdout: "{broken" };
        return result({ ...SNAPSHOT, version: 9 });
      };
      await w.clock.advance(5000);
      const after = await ui.find({ key: "headline", in: "board" }) as unknown as Found;
      expect(after.text).toContain("STATUS UNREADABLE — ");
      expect(after.text).toContain(why);
      expect(after.children[0]!.props.color).toBe("error");
      expect(await ui.findAll({ type: "Button", in: "board" })).toHaveLength(0);
      expect(await ui.find({ key: "tasks", in: "board" })).toBeUndefined();
      // An old surface can still post its old command: the engine rechecks CURRENT state.
      await ui.post({ copy: COMMAND }, { in: "board" });
      expect(w.copied).toEqual([COMMAND]);
      expect(w.statuses[w.statuses.length - 1]).toContain(why);
      for (const call of w.calls) expect(call).toEqual({ argv: ["tickmarkr", "status", "--json"], cwd: "/work/session" });

      w.answer.run = () => result();
      await w.clock.advance(5000);
      expect((await ui.find({ key: "headline", in: "board" }) as unknown as Found).text).toBe("● GREEN");
      expect(await ui.find({ key: "copy-T2441-0", in: "board" })).toBeDefined();
    });
  }

  test(`${surface}: responsive cards retain snapshot order, badge width, tries and the approval countdown`, async ($, on) => {
    const w = world(on);
    const first = { ...SNAPSHOT.tasks[0]!, id: "T9", title: "First", state: "human" as const, endedAt: null };
    w.answer.run = () => result({ ...SNAPSHOT, lifecycle: "RUNNING", verdict: { ...SNAPSHOT.verdict, green: false }, tasks: [first, ...SNAPSHOT.tasks], approvalWindow: { opensAt: new Date(NOW).toISOString(), closesAt: new Date(NOW + 80_000).toISOString(), parked: ["T9"] } });
    const ui = await mount($, surface);
    const tasks = await ui.find({ key: "tasks", in: "board" }) as unknown as Found;
    expect(tasks.children.map(child => child.props.key)).toEqual(["card-T9", "card-T2441"]);
    expect((await ui.find({ key: "badge-T2441", in: "board" }) as unknown as Found).props.width).toBe(surface === "desktop" ? 9 : 6);
    expect((await ui.find({ key: "tries-T2441", in: "board" }) as unknown as Found).text).toBe("tries 2/3 · 5 in all");
    for (const [columns, width] of [[180, 88], [123, 60], [122, 120], [40, 38]] as const) {
      await ui.resize({ columns, rows: 80, in: "board" });
      expect((await ui.find({ key: "card-T2441", in: "board" }) as unknown as Found).props.width).toBe(width);
    }
    await ui.advance(1000);
    const texts = await ui.findAll({ type: "Text", in: "board" }) as unknown as Found[];
    expect(texts.some(text => text.text === "approval window closes in 1:19 — then the run ends PARTIAL")).toBe(true);
    expect(texts.some(text => text.text === `waive: ${COMMAND}`)).toBe(true);
  });
}

test("a slow status read never overlaps a timer or command read", async ($, on) => {
  const w = world(on);
  await $.session.start({ surface: "terminal", isInteractive: true, cwd: "/work/session" });
  let release!: (value: ReturnType<typeof result>) => void;
  w.answer.run = () => new Promise(resolve => { release = resolve; });
  const command = $.command.run({ command: "tickmarkr-board", args: "" } as never);
  await w.clock.settle();
  const count = w.calls.length;
  await w.clock.advance(15000);
  expect(w.calls).toHaveLength(count);
  release(result());
  await command;
  w.answer.run = () => result();
  await w.clock.advance(5000);
  expect(w.calls).toHaveLength(count + 1);
});

test("session start runs no status read and sets no status line; opening the board starts exactly one poll, even opened twice, and the session's end stops it", async ($, on) => {
  const w = world(on);
  on("session.end", (_$, e) => ({ sessionId: e.sessionId }));
  await $.session.start({ surface: "terminal", isInteractive: true, cwd: "/work/session" });
  await w.clock.advance(15000);
  expect(w.calls).toHaveLength(0);
  expect(w.statuses).toHaveLength(0);
  await $.command.run({ command: "tickmarkr-board", args: "" } as never);
  await $.command.run({ command: "tickmarkr-board", args: "" } as never);
  expect(w.calls).toHaveLength(2);
  await w.clock.advance(15000);
  expect(w.calls).toHaveLength(5);
  expect(w.statuses[w.statuses.length - 1]).toBe("tickmarkr · GREEN · 1/1 merged · NEEDS YOU T2441");
  await $.session.end({ reason: "prompt_input_exit", sessionId: "board-session", resume: { id: "board-session" } });
  await w.clock.advance(15000);
  expect(w.calls).toHaveLength(5);
});
