import { describe, expect, test } from "vitest";
import { PassThrough } from "node:stream";
import { StudioApp } from "../../src/tui/app.js";
import type { InputStream } from "../../src/tui/input.js";
import type { OutputStream } from "../../src/tui/engine.js";

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

describe("studio app", () => {
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
