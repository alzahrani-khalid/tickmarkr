import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { render } from "ink";
import { createElement } from "react";
import { describe, expect, test } from "vitest";
import { ui } from "../../src/cli/commands/ui.js";
import type { JournalEvent } from "../../src/run/journal.js";
import {
  deriveLiveRunCockpitData,
  loadEngagementSource,
  selectEngagementRunId,
} from "../../src/tui/cockpit/live.js";
import { RunCockpitFrame } from "../../src/tui/cockpit/run-cockpit.js";

const REPO_ROOT = join(import.meta.dirname, "../..");
/** A run id that exists only in committed captures, never in a live journal. */
const COMMITTED_CAPTURE_ID = "run-20260724-231138";

const ev = (
  event: string,
  data: Record<string, unknown> = {},
  ts: string,
  taskId?: string,
): JournalEvent => ({ ts, event, ...(taskId ? { taskId } : {}), data });

const rawOf = (events: readonly JournalEvent[]): string =>
  events.map((event) => JSON.stringify(event)).join("\n") + "\n";

const stripAnsi = (value: string): string =>
  value.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");

async function frameFor(raw: string, now?: () => number): Promise<string> {
  const output = new PassThrough() as PassThrough & {
    isTTY: boolean;
    columns: number;
    rows: number;
  };
  output.isTTY = true;
  output.columns = 140;
  output.rows = 40;
  const writes: string[] = [];
  const write = output.write.bind(output);
  output.write = ((chunk: string | Uint8Array, ...args: unknown[]) => {
    writes.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
    return Reflect.apply(write, output, [chunk, ...args]) as boolean;
  }) as typeof output.write;

  let painted!: () => void;
  const firstPaint = new Promise<void>((resolve) => {
    painted = resolve;
  });
  const app = render(createElement(RunCockpitFrame, {
    data: deriveLiveRunCockpitData(
      { fileName: "run-live-test.journal.jsonl", raw },
      "9.8.7",
      now,
    ),
    columns: 140,
    rows: 40,
  }), {
    stdout: output as unknown as NodeJS.WriteStream,
    debug: true,
    patchConsole: false,
    onRender: painted,
  });
  await firstPaint;
  const frame = stripAnsi(writes.at(-1) ?? "").trimEnd();
  app.unmount();
  return frame;
}

function seedJournal(repo: string, runId: string, raw: string): void {
  const dir = join(repo, ".tickmarkr", "runs", runId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "journal.jsonl"), raw);
}

describe("live cockpit", () => {
  test("test: an engagement whose daemon is alive renders as running, and one whose daemon is gone renders as interrupted rather than as running", async () => {
    const start = Date.parse("2026-07-26T12:00:00.000Z");
    const at = (seconds: number) => new Date(start + seconds * 1_000).toISOString();
    const dispatch = (ts: string) =>
      ev("task-dispatch", { assignment: { adapter: "codex", model: "gpt-9" } }, ts, "T1");

    const alive = await frameFor(rawOf([
      ev("run-start", { branch: "spec/live", pid: process.pid }, at(0)),
      dispatch(at(5)),
    ]));
    expect(alive).toContain("running");
    expect(alive).not.toContain("interrupted");

    const dead = spawnSync("true").pid!; // reaped-dead foreign pid → kill(pid,0) ESRCH
    const gone = await frameFor(rawOf([
      ev("run-start", { branch: "spec/live", pid: dead }, at(0)),
      dispatch(at(5)),
    ]));
    expect(gone).toContain("interrupted");
    expect(gone).not.toContain("running");
  });

  test("test: the header states how long ago the engagement's last event arrived, so an engagement that has stopped moving reads as stale rather than as current", async () => {
    const nowMs = Date.parse("2026-07-26T12:00:00.000Z");
    const now = () => nowMs;
    const ago = (seconds: number) => new Date(nowMs - seconds * 1_000).toISOString();

    const stale = rawOf([
      ev("run-start", { branch: "spec/stale", pid: process.pid }, ago(600)),
      ev("task-dispatch", { assignment: { adapter: "codex", model: "gpt-9" } }, ago(600), "T1"),
    ]);
    const staleData = deriveLiveRunCockpitData(
      { fileName: "run-stale.journal.jsonl", raw: stale },
      "9.8.7",
      now,
    );
    expect(staleData.elapsed).toContain("last event 10m ago");
    expect(await frameFor(stale, now)).toContain("last event 10m ago");

    const fresh = rawOf([
      ev("run-start", { branch: "spec/fresh", pid: process.pid }, ago(3)),
    ]);
    expect(await frameFor(fresh, now)).toContain("last event 3s ago");
  });

  test("the engagement selection rule lives in one function: an explicit reference wins, otherwise the newest journaled run", () => {
    const repo = mkdtempSync(join(tmpdir(), "tickmarkr-live-select-"));
    expect(selectEngagementRunId(repo)).toBeNull();

    seedJournal(repo, "run-20260726-100000", '{"ts":"2026-07-26T10:00:00.000Z","event":"run-start","data":{}}\n');
    seedJournal(repo, "run-20260726-110000", '{"ts":"2026-07-26T11:00:00.000Z","event":"run-start","data":{}}\n');
    expect(selectEngagementRunId(repo)).toBe("run-20260726-110000");
    expect(selectEngagementRunId(repo, "run-20260726-100000")).toBe("run-20260726-100000");
    expect(() => selectEngagementRunId(repo, "../escape")).toThrow();
  });

  test("loadEngagementSource returns the journal bytes of the named engagement and throws when they cannot be read", () => {
    const repo = mkdtempSync(join(tmpdir(), "tickmarkr-live-load-"));
    seedJournal(repo, "run-20260726-171700", '{"ts":"2026-07-26T17:17:00.000Z","event":"run-start","data":{}}\n');

    const source = loadEngagementSource(repo, "run-20260726-171700");
    expect(source.fileName).toBe("run-20260726-171700.journal.jsonl");
    expect(source.raw).toContain('"run-start"');

    expect(() => loadEngagementSource(repo, "run-20260726-171701")).toThrow();
  });
});

function makeInkStreams(columns = 140, rows = 40) {
  let raw = false;
  const input = new PassThrough() as PassThrough & {
    isTTY: boolean;
    setRawMode: (mode: boolean) => void;
    ref: () => NodeJS.ReadStream;
    unref: () => NodeJS.ReadStream;
  };
  input.isTTY = true;
  input.setRawMode = (mode) => {
    raw = mode;
  };
  input.ref = () => input as unknown as NodeJS.ReadStream;
  input.unref = () => input as unknown as NodeJS.ReadStream;

  const output = new PassThrough() as PassThrough & {
    isTTY: boolean;
    columns: number;
    rows: number;
  };
  output.isTTY = true;
  output.columns = columns;
  output.rows = rows;
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

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function commandFrame(io: { writes: string[] }): Promise<string> {
  for (let attempts = 0; attempts < 40; attempts += 1) {
    const frame = stripAnsi(io.writes.join(""));
    if (frame.trim().length > 0) return frame;
    await wait(50);
  }
  return stripAnsi(io.writes.join(""));
}

const mkRepo = () => mkdtempSync(join(tmpdir(), "tickmarkr-ui-"));

describe("ui command (live cockpit)", () => {
  test("test: the command renders the cockpit surface and no longer reaches the retired studio module", async () => {
    const repo = mkRepo();
    seedJournal(repo, "run-20260726-171700", rawOf([
      ev("run-start", { branch: "spec/ui-live", pid: process.pid }, new Date().toISOString()),
      ev("task-dispatch", { assignment: { adapter: "codex", model: "gpt-9" } }, new Date().toISOString(), "T1"),
    ]));

    const io = makeInkStreams();
    const done = ui([], { input: io.input, output: io.output }, repo);
    const frame = await commandFrame(io);

    expect(frame).toContain("VIEWS");
    expect(frame).toContain("RUN");
    expect(frame).toContain("KEYS");
    expect(frame).toContain("run-20260726-171700");
    // the retired studio's vocabulary, not the cockpit's
    expect(frame).not.toContain("Fleet view");
    expect(frame).not.toContain("Routing");
    expect(frame).not.toContain("Preview");

    io.input.write("q");
    await expect(done).resolves.toBe("ui: closed");
    expect(io.raw()).toBe(false);
  });

  test("test: the surface is derived from the journal bytes of a real engagement rather than from any committed capture", async () => {
    const repo = mkRepo();
    seedJournal(repo, "run-20990102-030405", rawOf([
      ev("run-start", { branch: "spec/branch-no-capture-owns", pid: process.pid }, new Date().toISOString()),
      ev("task-dispatch", { assignment: { adapter: "noprovider", model: "model-zero" } }, new Date().toISOString(), "T9"),
    ]));

    const io = makeInkStreams();
    const done = ui([], { input: io.input, output: io.output }, repo);
    const frame = await commandFrame(io);

    expect(frame).toContain("run-20990102-030405");
    expect(frame).toContain("spec/branch-no-capture-owns");
    expect(frame).toContain("noprovider:model-zero");
    expect(frame).not.toContain(COMMITTED_CAPTURE_ID);

    io.input.write("q");
    await done;
  });

  test("test: when no engagement can be read the command refuses with a message and a non-zero status rather than drawing an empty surface", async () => {
    const repo = mkRepo(); // no .tickmarkr at all
    const io = makeInkStreams();

    const result = await ui([], { input: io.input, output: io.output }, repo);

    expect(result).toMatchObject({ code: 1 });
    expect((result as { out: string }).out).toContain("no engagement");
    expect(io.writes.join("")).toBe("");
  });

  test("test: when the journal bytes are unreadable the command refuses rather than rendering a plausible surface derived from nothing", async () => {
    const repo = mkRepo();
    seedJournal(repo, "run-20260726-171700", "not json at all\n{broken\n");
    const io = makeInkStreams();

    const result = await ui([], { input: io.input, output: io.output }, repo);

    expect(result).toMatchObject({ code: 1 });
    expect((result as { out: string }).out).toContain("run-20260726-171700");
    expect(io.writes.join("")).toBe("");
  });

  test("test: the bare command opens the most recently started engagement, decided in exactly one place, and an explicit engagement reference given on the command line overrides it", async () => {
    const repo = mkRepo();
    seedJournal(repo, "run-20260726-100000", rawOf([
      ev("run-start", { branch: "spec/older", pid: process.pid }, new Date().toISOString()),
    ]));
    seedJournal(repo, "run-20260726-110000", rawOf([
      ev("run-start", { branch: "spec/newer", pid: process.pid }, new Date().toISOString()),
    ]));

    const bare = makeInkStreams();
    const bareDone = ui([], { input: bare.input, output: bare.output }, repo);
    const bareFrame = await commandFrame(bare);
    expect(bareFrame).toContain("run-20260726-110000");
    expect(bareFrame).toContain("spec/newer");
    expect(bareFrame).not.toContain("run-20260726-100000");
    bare.input.write("q");
    await bareDone;

    const explicit = makeInkStreams();
    const explicitDone = ui(["run-20260726-100000"], {
      input: explicit.input,
      output: explicit.output,
    }, repo);
    const explicitFrame = await commandFrame(explicit);
    expect(explicitFrame).toContain("run-20260726-100000");
    expect(explicitFrame).toContain("spec/older");
    explicit.input.write("q");
    await explicitDone;
  });

  test("test: every committed frame is byte-identical after this task, so wiring live data moved no rendered appearance", () => {
    const diff = spawnSync(
      "git",
      ["diff", "--exit-code", "HEAD", "--", "tests/fixtures/cockpit"],
      { cwd: REPO_ROOT, encoding: "utf8" },
    );
    expect(diff.status).toBe(0);
  });
});
