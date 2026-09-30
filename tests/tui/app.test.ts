import { afterEach, describe, expect, test, vi } from "vitest";
import { appendFileSync, chmodSync, mkdirSync, mkdtempSync, renameSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { ttyInput } from "../helpers/tty-input.js";
import { render } from "ink";
import { createElement, Fragment, type ReactElement, type ReactNode } from "react";
import { ui } from "../../src/cli/commands/ui.js";
import * as componentsHub from "../../src/tui/ink/components.js";
import {
  FleetListScreen,
  FleetReviewScreen,
  TextLines,
  ToggleMark,
} from "../../src/tui/ink/components.js";
import { APPEND_RACE_OBSERVATIONS, JournalTail, type TailSnapshot } from "../../src/tui/cockpit/live-store.js";
import { runLiveCockpit } from "../../src/tui/cockpit/live.js";
import type { ShellDelivery } from "../../src/tui/cockpit/live-runtime.js";
import { deriveHomeView, HomeView } from "../../src/tui/cockpit/home-view.js";
import { readOperatorState } from "../../src/run/operator-state.js";
import { graph, partial } from "../fixtures/operator-state/fixture.js";

// Interpose only at the journal's descriptor boundary: stat, appends, replacements and reads stay real.
// `beforeOpen` runs between the tail's stat and its fstat; `open` holds every journal descriptor not yet closed.
const fsHooks = vi.hoisted(() => ({
  journal: undefined as string | undefined,
  beforeOpen: undefined as (() => void) | undefined,
  afterFstat: undefined as (() => void) | undefined,
  open: new Set<number>(),
  opened: 0,
}));
vi.mock("node:fs", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs")>();
  return {
    ...fs,
    openSync: (...args: Parameters<typeof fs.openSync>) => {
      const journal = fsHooks.journal !== undefined && String(args[0]) === fsHooks.journal;
      if (journal) fsHooks.beforeOpen?.();
      const fd = fs.openSync(...args);
      if (journal) { fsHooks.open.add(fd); fsHooks.opened++; }
      return fd;
    },
    fstatSync: ((fd: number, options?: { bigint?: boolean }) => {
      const st = fs.fstatSync(fd, options as { bigint: true });
      if (fsHooks.open.has(fd)) fsHooks.afterFstat?.();
      return st;
    }) as typeof fs.fstatSync,
    closeSync: (fd: number) => { fsHooks.open.delete(fd); return fs.closeSync(fd); },
  };
});

/** Upper bound on any wait for a production frame; a poll that reaches it rejects with the last frame drawn. */
const FRAME_POLL_MS = 2000;
const tick = () => new Promise((r) => setTimeout(r, 5));
/** Poll the production frames until `settled` holds; never a fixed sleep. Rejects at the bound with the last frame. */
async function untilFrame(frame: () => string, settled: (frame: string) => boolean, want: string, timeoutMs = FRAME_POLL_MS): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const current = frame();
    if (settled(current)) return current;
    if (Date.now() >= deadline) throw new Error(`frame never reached ${want} within ${timeoutMs} ms; last frame:\n${current}`);
    await tick();
  }
}
const shows = (text: string) => (frame: string) => frame.includes(text);

function makeInkStreams() {
  let raw = false;
  const input = ttyInput({ onRawMode: mode => { raw = mode; } });

  const output = new PassThrough() as PassThrough & {
    isTTY: boolean;
    columns: number;
    rows: number;
  };
  output.isTTY = true;
  output.columns = 100;
  output.rows = 40;
  const writes: string[] = [];
  const write = output.write.bind(output);
  output.write = ((chunk: string | Uint8Array, ...args: unknown[]) => {
    writes.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
    return Reflect.apply(write, output, [chunk, ...args]) as boolean;
  }) as typeof output.write;
  return {
    input: input as unknown as NodeJS.ReadStream,
    output: output as unknown as NodeJS.WriteStream,
    writes,
    raw: () => raw,
  };
}

const stripAnsi = (value: string) => value.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");

/**
 * Mount `node` and return the LATEST frame once it shows the requested final view. Only the latest frame is
 * polled: a matching frame that was drawn and then superseded before observation must not satisfy the wait.
 * `supersede` rerenders to that element before the poll starts, standing in for such a superseding render.
 */
async function drawFrame(node: ReactElement, finalView: string, timeoutMs?: number, supersede?: ReactElement): Promise<string> {
  const { input, output, writes } = makeInkStreams();
  const app = render(node, {
    stdin: input,
    stdout: output,
    exitOnCtrlC: false,
    patchConsole: false,
    debug: true,
  });
  try {
    if (supersede) app.rerender(supersede);
    return await untilFrame(() => stripAnsi(writes.at(-1) ?? ""), shows(finalView), JSON.stringify(finalView), timeoutMs);
  } finally {
    app.unmount();
  }
}

describe("studio app", () => {
  test("test: the components hub still draws through the production render path with the studio-app, staging and save modules gone, proven member by member over the closed set of its exported surfaces — FleetListScreen, ToggleMark and TextLines — each drawn into a real frame", async () => {
    // The dead modules are gone: reaching them rejects at module resolution.
    await expect(import("../../src/tui/staging.js")).rejects.toThrow();
    await expect(import("../../src/tui/save.js")).rejects.toThrow();
    await expect(import("../../src/tui/ink/studio-app.js")).rejects.toThrow();

    expect(Object.keys(componentsHub).sort()).toEqual([
      "FleetListScreen",
      "FleetReviewScreen",
      "TextLines",
      "ToggleMark",
      "windowRows",
    ]);

    // Member by member over the closed set, each drawn into a real frame.
    const list = await drawFrame(createElement(FleetListScreen, {
      title: "hub list title",
      legend: "hub list legend",
      cursor: 0,
      rows: [{ id: "row-1", content: "hub list row" as ReactNode }],
    }), "❯ hub list row");
    expect(list).toContain("hub list title");
    expect(list).toContain("hub list legend");
    expect(list).toContain("❯ hub list row");

    const toggles = await drawFrame(createElement(Fragment, null,
      createElement(ToggleMark, { active: true }),
      createElement(ToggleMark, { active: false }),
    ), "○");
    expect(toggles).toContain("✓");
    expect(toggles).toContain("○");

    const lines = await drawFrame(createElement(TextLines, {
      lines: ["hub line one", "hub line two"],
    }), "hub line two");
    expect(lines).toContain("hub line one");
    expect(lines).toContain("hub line two");

    const review = await drawFrame(createElement(FleetReviewScreen, {
      title: "hub review title",
      legend: "hub review legend",
      diff: "-before\n+after",
    }), "+after");
    expect(review).toContain("hub review title");
    expect(review).toContain("hub review legend");
    expect(review).toContain("-before");
    expect(review).toContain("+after");
  });

  test("test: home and app key navigation waits for the requested final view while a render that never reaches that view rejects at the bounded poll with its last frame", async () => {
    // Home: each key waits for the view it requests — the next park's label — not for a clock.
    const model = deriveHomeView({ operator: readOperatorState({ events: partial, graph }), seats: { active: 0, eligible: 3 } });
    const [firstPark, nextPark] = model.needsYou.map(t => t.label) as [string, string];
    expect(model.needsYou.map(t => t.id)).toEqual(["T2", "T3"]);
    const io = makeInkStreams();
    const opened: string[] = [];
    const app = render(createElement(HomeView, { model, focused: true, onOpenPark: id => opened.push(id), onOpenDiagnostic: () => {}, onOpenEvidence: () => {} }),
      { stdin: io.input, stdout: io.output, exitOnCtrlC: false, patchConsole: false, debug: true });
    const frame = () => stripAnsi(io.writes.at(-1) ?? "");
    try {
      await untilFrame(frame, shows(firstPark), "the first park");
      io.input.write("\x1B[B");
      const next = await untilFrame(frame, shows(nextPark), "the next park");
      expect(next).not.toContain(firstPark);
      io.input.write("\r");
      await untilFrame(frame, () => opened.length === 1, "the park callback");
      expect(opened).toEqual(["T3"]);
      // A view the render never reaches rejects at the bound, carrying the last frame drawn.
      const before = Date.now();
      await expect(untilFrame(frame, shows("HOME / COMPLETE"), "a complete home", 80)).rejects.toThrow(/never reached a complete home within 80 ms; last frame:\n[\s\S]*T3 blocked/);
      expect(Date.now() - before).toBeGreaterThanOrEqual(75);
    } finally { app.unmount(); }

    // App hub: the same wait drives the components' final view, and a row that is never drawn rejects
    // with the frame that was.
    const list = await drawFrame(createElement(FleetListScreen, {
      title: "hub list title", legend: "hub list legend", cursor: 1,
      rows: [{ id: "row-1", content: "first row" as ReactNode }, { id: "row-2", content: "second row" as ReactNode }],
    }), "❯ second row");
    expect(list).toContain("first row");
    await expect(drawFrame(createElement(FleetListScreen, {
      title: "hub list title", legend: "hub list legend", cursor: 0,
      rows: [{ id: "row-1", content: "only row" as ReactNode }],
    }), "❯ absent row", 80)).rejects.toThrow(/never reached "❯ absent row" within 80 ms; last frame:\n[\s\S]*❯ only row/);
    // A frame that matched but was superseded before observation is not the final view: cursor 1 is drawn,
    // then the production screen synchronously moves to cursor 0. The wait must reject with the cursor-0
    // frame that is current, never resolve on the stale cursor-1 frame (a poll over every frame drawn did).
    const rows = [{ id: "row-1", content: "first row" as ReactNode }, { id: "row-2", content: "second row" as ReactNode }];
    await expect(drawFrame(
      createElement(FleetListScreen, { title: "hub list title", legend: "hub list legend", cursor: 1, rows }),
      "❯ second row", 80,
      createElement(FleetListScreen, { title: "hub list title", legend: "hub list legend", cursor: 0, rows }),
    )).rejects.toThrow(/never reached "❯ second row" within 80 ms; last frame:\n[\s\S]*❯ first row/);
  });

  test("the retired public demo refuses without mounting a substitute app", async () => {
    const demo = makeInkStreams();
    expect(await ui(["--demo"], { input: demo.input, output: demo.output })).toEqual({ out: "tickmarkr ui: unknown flag --demo", code: 1 });
    expect(demo.writes).toEqual([]);
    expect(demo.raw()).toBe(false);
  });

  test("test: launching the studio without a terminal prints the existing line-mode guidance and renders no interactive frame", async () => {
    const input = new PassThrough() as InputStream;
    input.isTTY = false;
    const writes: string[] = [];
    const output: OutputStream = {
      isTTY: false,
      columns: 80,
      rows: 24,
      write: (chunk: string) => {
        writes.push(chunk);
        return true;
      },
    };

    const result = await ui([], { input, output });

    expect(result).toEqual({
      out: "tickmarkr ui: the cockpit requires a TTY — use `tickmarkr fleet --print` or `tickmarkr status --watch` for line-mode output",
      code: 1,
    });
    expect(writes).toEqual([]);
  });
});

const dirs: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  Object.assign(fsHooks, { journal: undefined, beforeOpen: undefined, afterFstat: undefined, opened: 0 });
  fsHooks.open.clear();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const record = (text: string) => JSON.stringify({ ts: new Date().toISOString(), event: "worker-nudge", taskId: "T1", data: { text } }) + "\n";

/** A real engagement journal the hooks watch by path. */
function seededRun() {
  const repo = mkdtempSync(join(tmpdir(), "tickmarkr-ui-race-")); dirs.push(repo);
  const runId = "run-20260929-120000";
  const journal = join(repo, ".tickmarkr", "runs", runId, "journal.jsonl");
  mkdirSync(join(journal, ".."), { recursive: true });
  writeFileSync(journal, JSON.stringify({ ts: new Date().toISOString(), event: "run-start", data: { branch: "spec/race", pid: process.pid } }) + "\n" + record("seeded"));
  fsHooks.journal = journal;
  return { repo, runId, journal };
}

/** The next `count` journal opens each land one appended record between the tail's stat and its fstat. */
function raceAppends(journal: string, count: number, label: string): () => number {
  let left = count;
  fsHooks.beforeOpen = () => { if (left > 0) appendFileSync(journal, record(`${label} ${count - --left}`)); };
  return () => left;
}

async function mountLive(repo: string, runId: string) {
  const io = makeInkStreams();
  let delivery: ShellDelivery | undefined;
  const mounted = runLiveCockpit({ input: io.input, output: io.output, cwd: repo, runId, binaryVersion: "fixture",
    refreshMs: 3_600_000, onDelivery: value => { delivery = value; } });
  await expect.poll(() => delivery, { timeout: 5000 }).toBeDefined();
  return { io, mounted, delivery: delivery! };
}

describe("ui journal append races", () => {
  test("test: ui startup survives three hooked stat-to-fstat appends on its first poll as pending without rows rather than exiting while live refresh keeps its last good snapshot pending after three racing observations until a stable poll recovers the appended rows", async () => {
    expect(APPEND_RACE_OBSERVATIONS).toBe(3);
    const { repo, runId, journal } = seededRun();
    const polls = vi.spyOn(JournalTail.prototype, "poll");
    const startupLeft = raceAppends(journal, 3, "startup");
    const io = makeInkStreams();
    const done = ui([runId], { input: io.input, output: io.output }, repo);
    await expect.poll(() => stripAnsi(io.writes.join("")), { timeout: 5000 }).toContain(runId);
    expect(startupLeft()).toBe(0);
    const first = polls.mock.results[0]!.value as TailSnapshot;
    expect(first).toMatchObject({ status: "pending", lines: 0, history: [], offset: 0, error: undefined });
    io.input.write("q");
    await expect(done).resolves.toBe("ui: closed");
    fsHooks.beforeOpen = undefined;

    const live = await mountLive(repo, runId);
    try {
      const good = live.delivery.snapshot().store.journal;
      expect(good).toMatchObject({ status: "readable", lines: 5 });
      appendFileSync(journal, record("before race"));
      const refreshLeft = raceAppends(journal, 3, "refresh");
      expect(live.delivery.refresh()).toBe(true);
      expect(refreshLeft()).toBe(0);
      const kept = live.delivery.snapshot().store.journal;
      expect(kept).toMatchObject({ status: "pending", lines: good.lines, offset: good.offset, generation: good.generation,
        lastSuccessfulReadAt: good.lastSuccessfulReadAt, error: undefined });
      expect(kept.history).toEqual(good.history);
      fsHooks.beforeOpen = undefined;
      expect(live.delivery.refresh()).toBe(true);
      const recovered = live.delivery.snapshot().store.journal;
      expect(recovered).toMatchObject({ status: "readable", lines: good.lines + 4, generation: good.generation, backlogBytes: 0 });
      expect(recovered.history.slice(-4).map(row => row.event?.data.text)).toEqual(["before race", "refresh 1", "refresh 2", "refresh 3"]);
    } finally { live.io.input.write("q"); }
    await expect(live.mounted).resolves.toBeUndefined();
    expect(fsHooks.open.size).toBe(0);
  });

  test("test: ui startup or live refresh preserves unreadable EISDIR EACCES or foreign replacement outcomes; successful retry exhausted retry or truncation closes every opened JournalTail descriptor", async () => {
    const refused = async (run: ReturnType<typeof seededRun>) => {
      const io = makeInkStreams();
      const result = await ui([run.runId], { input: io.input, output: io.output }, run.repo) as { out: string; code: number };
      expect(result.code).toBe(1);
      expect(io.writes).toEqual([]);
      expect(fsHooks.open.size).toBe(0);
      return result.out;
    };
    // EISDIR: a directory where the journal belongs is refused, never retried as a race.
    const directory = seededRun(); rmSync(directory.journal); mkdirSync(directory.journal);
    expect(await refused(directory)).toContain("journal source is not a regular file");
    // EACCES: the open itself fails. Root reads through a 000 mode, so only a non-root host can hold it.
    if (process.getuid?.() !== 0) {
      const locked = seededRun(); chmodSync(locked.journal, 0o000);
      try { expect(await refused(locked)).toMatch(/EACCES/); } finally { chmodSync(locked.journal, 0o644); }
    }
    // Foreign replacement between stat and fstat: another inode, not an append.
    const replace = (journal: string, text: string) => { let once = true; fsHooks.beforeOpen = () => {
      if (!once) return; once = false; writeFileSync(`${journal}.next`, record(text)); renameSync(`${journal}.next`, journal);
    }; };
    const foreign = seededRun(); replace(foreign.journal, "foreign startup");
    expect(await refused(foreign)).toContain("journal changed before read");

    const refreshed = seededRun();
    const live = await mountLive(refreshed.repo, refreshed.runId);
    appendFileSync(refreshed.journal, record("grown")); replace(refreshed.journal, "foreign refresh");
    try {
      expect(live.delivery.refresh()).toBe(true);
      expect(live.delivery.snapshot().store.journal).toMatchObject({ status: "unreadable", error: { error: expect.stringContaining("journal changed before read") } });
    } finally { live.io.input.write("q"); }
    await expect(live.mounted).rejects.toThrow(/journal changed before read/);
    expect(fsHooks.open.size).toBe(0);
    fsHooks.beforeOpen = undefined;

    // Descriptor cleanup, observation by observation.
    const tails = seededRun();
    fsHooks.opened = 0; raceAppends(tails.journal, 1, "retry");
    expect(new JournalTail(tails.journal).poll()).toMatchObject({ status: "readable", lines: 3 });
    expect(fsHooks.opened).toBe(2); expect(fsHooks.open.size).toBe(0);
    fsHooks.opened = 0; raceAppends(tails.journal, 3, "exhaust");
    expect(new JournalTail(tails.journal).poll()).toMatchObject({ status: "pending", lines: 0, error: undefined });
    expect(fsHooks.opened).toBe(3); expect(fsHooks.open.size).toBe(0);
    fsHooks.beforeOpen = undefined; fsHooks.opened = 0;
    fsHooks.afterFstat = () => { fsHooks.afterFstat = undefined; truncateSync(tails.journal, 0); };
    expect(new JournalTail(tails.journal).poll()).toMatchObject({ status: "unreadable", error: { error: "journal truncated during read" } });
    expect(fsHooks.opened).toBe(1); expect(fsHooks.open.size).toBe(0);
  });
});
