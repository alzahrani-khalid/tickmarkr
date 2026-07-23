import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { PassThrough } from "node:stream";
import { ui } from "../../src/cli/commands/ui.js";
import {
  runStudioInk,
  type RunsCockpitData,
  type StudioInkView,
} from "../../src/tui/ink/studio-app.js";

function makeStreams() {
  const input = new PassThrough() as InputStream;
  const out = new PassThrough();
  const output: OutputStream = {
    ...out,
    isTTY: true,
    columns: 80,
    rows: 24,
    write: (chunk: string) => out.write(chunk),
  };
  return { input, output };
}

const wait = (ms = 30) => new Promise((r) => setTimeout(r, ms));

function makeInkStreams() {
  let raw = false;
  const input = new PassThrough() as PassThrough & {
    isTTY: boolean;
    setRawMode: (mode: boolean) => void;
    ref: () => NodeJS.ReadStream;
    unref: () => NodeJS.ReadStream;
  };
  input.isTTY = true;
  input.setRawMode = (mode) => { raw = mode; };
  input.ref = () => input as unknown as NodeJS.ReadStream;
  input.unref = () => input as unknown as NodeJS.ReadStream;

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
const inkViews: StudioInkView[] = ["Fleet", "Routing", "Preview", "Profile", "Runs"].map((label) => ({
  id: label.toLowerCase(),
  label,
  render: () => [`${label} substance`],
}));
const graph = {
  version: 1,
  spec: { source: "prd", paths: ["p"], hash: "h" },
  tasks: [{ id: "T1", goal: "Live task.", status: "running" }],
} as RunsCockpitData["graph"];
const journalEvent = (event: string, data: Record<string, unknown>, ts: string) => ({ ts, event, taskId: "T1", data });
const runs = (
  events: RunsCockpitData["events"],
  prompts?: RunsCockpitData["prompts"],
): RunsCockpitData => ({ runId: "run-test", graph, events, prompts });

async function openRuns(data: RunsCockpitData, clock = Date.now) {
  const io = makeInkStreams();
  const done = runStudioInk({ ...io, runsData: data, clock, debug: true });
  await wait();
  io.input.write("5");
  await wait();
  return { ...io, done, frame: () => stripAnsi(io.writes.at(-1) ?? "") };
}

describe("studio app", () => {
  test("launching the studio without a terminal prints the existing line-mode guidance and renders no interactive frame", async () => {
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
      out: "tickmarkr ui: studio requires a TTY — use `tickmarkr fleet --print` or `tickmarkr status --watch` for line-mode output",
      code: 1,
    });
    expect(writes).toEqual([]);
  });

  test("the shell switches between views with the same key bindings the previous shell used", async () => {
    const command = readFileSync(new URL("../../src/cli/commands/ui.ts", import.meta.url), "utf8");
    expect(command).toContain('await import("../../tui/ink/studio-app.js")');
    const { input, output, writes } = makeInkStreams();
    const done = runStudioInk({ input, output, views: inkViews, debug: true });
    await wait();
    expect(stripAnsi(writes.at(-1) ?? "")).toContain("Fleet substance");

    input.write("2");
    await wait();
    expect(stripAnsi(writes.at(-1) ?? "")).toContain("Routing substance");

    input.write("\t");
    await wait();
    expect(stripAnsi(writes.at(-1) ?? "")).toContain("Preview substance");

    input.write("1");
    await wait();
    expect(stripAnsi(writes.at(-1) ?? "")).toContain("Fleet substance");

    input.write("q");
    await done;
  });

  test("test: the cockpit renders a running task's current phase with an elapsed indication that advances between frames and never an idle presentation for a running task", async () => {
    let now = Date.parse("2026-07-23T12:00:10.000Z");
    const runsData = runs([journalEvent(
      "phase-start", { phase: "gate:test" }, "2026-07-23T12:00:05.000Z",
    )]);
    const studio = await openRuns(runsData, () => now);
    const first = studio.frame();
    expect(first).toContain("gate:test · 5s");
    expect(first).not.toMatch(/\bidle\b/);

    now += 2_000;
    await wait(300);
    const second = studio.frame();
    expect(second).toContain("gate:test · 7s");
    expect(second).not.toBe(first);
    studio.input.write("q");
    await studio.done;
  });

  test("test: the consult dossier stays reachable from the cockpit and renders its substance through the component runtime", async () => {
    const runsData = runs([journalEvent(
      "consult-verdict", { action: "retry", reason: "rerun lint" }, "2026-07-23T12:00:02.000Z",
    )], { T1: ["## Persisted consult\nInspect the failed gate."] });
    const studio = await openRuns(runsData);
    expect(studio.frame()).toContain("1 consult verdict");
    studio.input.write("d");
    await wait();
    expect(studio.frame()).toMatch(/Consult dossier — T1[\s\S]*retry — rerun lint[\s\S]*Inspect the failed gate\./);
    studio.input.write("q");
    await studio.done;
  });

  test("test: quitting the studio from any view leaves the terminal usable with no orphaned input listeners", async () => {
    for (let active = 0; active < inkViews.length; active++) {
      const { input, output, raw } = makeInkStreams();
      const done = runStudioInk({ input, output, views: inkViews, debug: true });
      await wait();
      if (active > 0) {
        input.write(String(active + 1));
        await wait();
      }
      input.write("q");
      await done;
      expect(raw()).toBe(false);
      expect(input.listenerCount("data")).toBe(0);
      expect(input.listenerCount("keypress")).toBe(0);
    }
  });

  describe.skip("retired hand-rolled Studio assertions", () => {
  test("the tab bar names five views including Runs and a number key switches the active view to it", async () => {
    const { input, output } = makeStreams();
    const app = new StudioApp({ input, output });
    app.start();
    await wait();

    const lines = app.lines;
    expect(lines[0]).toContain("Fleet");
    expect(lines[0]).toContain("Routing");
    expect(lines[0]).toContain("Preview");
    expect(lines[0]).toContain("Profile");
    expect(lines[0]).toContain("Runs");

    input.write("5");
    await wait();
    expect(app.lines.some((l) => l.includes("no run loaded"))).toBe(true);

    app.stop();
  });

  test("the studio opens on the fleet view with a tab bar naming all five views", async () => {
    const { input, output } = makeStreams();
    const app = new StudioApp({ input, output });
    app.start();
    await wait();

    const lines = app.lines;
    expect(lines[0]).toContain("Fleet");
    expect(lines[0]).toContain("Routing");
    expect(lines[0]).toContain("Preview");
    expect(lines[0]).toContain("Profile");
    expect(lines[0]).toContain("Runs");
    expect(lines.some((l) => l.includes("Fleet view"))).toBe(true);

    app.stop();
  });

  test("number keys and tab cycling switch the active view", async () => {
    const { input, output } = makeStreams();
    const app = new StudioApp({ input, output });
    app.start();
    await wait();

    input.write("2");
    await wait();
    expect(app.lines.some((l) => l.includes("Routing view"))).toBe(true);

    input.write("\t");
    await wait();
    expect(app.lines.some((l) => l.includes("Preview view"))).toBe(true);

    input.write("4");
    await wait();
    expect(app.lines.some((l) => l.includes("Profile view"))).toBe(true);

    input.write("1");
    await wait();
    expect(app.lines.some((l) => l.includes("Fleet view"))).toBe(true);

    app.stop();
  });

  test("the help overlay lists the bindings and closes on escape", async () => {
    const { input, output } = makeStreams();
    const app = new StudioApp({ input, output });
    app.start();
    await wait();

    input.write("?");
    await wait();
    const helpLines = app.lines;
    expect(helpLines.some((l) => l.includes("Key bindings"))).toBe(true);
    expect(helpLines.some((l) => l.includes("1-5"))).toBe(true);
    expect(helpLines.some((l) => l.includes("tab"))).toBe(true);
    expect(helpLines.some((l) => l.includes("esc"))).toBe(true);

    input.write("\x1b");
    await wait();
    expect(app.lines.some((l) => l.includes("Fleet view"))).toBe(true);
    expect(app.lines.some((l) => l.includes("Key bindings"))).toBe(false);

    app.stop();
  });

  test("a mutation key shows the read-only notice instead of changing anything", async () => {
    const { input, output } = makeStreams();
    const app = new StudioApp({ input, output });
    app.start();
    await wait();

    input.write("r");
    await wait();
    expect(app.lines.some((l) => l.includes("read-only"))).toBe(true);
    expect(app.lines.some((l) => l.includes("Fleet view"))).toBe(true);
    expect(app.lines.some((l) => l.includes("Routing view"))).toBe(false);

    app.stop();
  });

  test("each view is a separate module the shell registers so later view work never edits the shell", () => {
    const { input, output } = makeStreams();
    const app = new StudioApp({ input, output });
    app.start();
    expect(app.viewLabels).toEqual(["Fleet", "Routing", "Preview", "Profile", "Runs"]);
    app.stop();
  });

  test("the status bar shows the staged-change count and clears when the buffer is reverted", async () => {
    const { input, output } = makeStreams();
    const app = new StudioApp({ input, output });
    app.start();
    await wait();

    expect(app.lines.some((l) => l.includes("no staged changes"))).toBe(true);

    app.stageEdit((buffer) => {
      buffer.denyAdapters.push("grok");
      buffer.denyAdapters.sort();
    });
    await wait();
    expect(app.lines.some((l) => l.includes("1 staged change"))).toBe(true);
    expect(app.lines.some((l) => l.includes("no staged changes"))).toBe(false);

    input.write("u");
    await wait();
    expect(app.lines.some((l) => l.includes("no staged changes"))).toBe(true);
    expect(app.lines.some((l) => l.includes("1 staged change"))).toBe(false);

    app.stop();
  });

  test("quitting with staged changes asks for confirmation and a clean quit exits immediately", async () => {
    const clean = makeStreams();
    const cleanApp = new StudioApp({ input: clean.input, output: clean.output });
    cleanApp.start();
    await wait();
    clean.input.write("q");
    await wait();
    await expect(cleanApp.exited).resolves.toBeUndefined();

    const dirty = makeStreams();
    const dirtyApp = new StudioApp({ input: dirty.input, output: dirty.output });
    dirtyApp.start();
    await wait();

    dirtyApp.stageEdit((buffer) => {
      buffer.denyAdapters.push("grok");
      buffer.denyAdapters.sort();
    });
    await wait();
    expect(dirtyApp.lines.some((l) => l.includes("1 staged change"))).toBe(true);

    dirty.input.write("q");
    await wait();
    expect(dirtyApp.lines.some((l) => l.includes("Quit with 1 staged change"))).toBe(true);

    dirty.input.write("y");
    await wait();
    await expect(dirtyApp.exited).resolves.toBeUndefined();
  });
  });
});
