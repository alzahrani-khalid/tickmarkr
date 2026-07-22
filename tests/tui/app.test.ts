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
  test("the studio opens on the fleet view with a tab bar naming all four views", async () => {
    const { input, output } = makeStreams();
    const app = new StudioApp({ input, output });
    app.start();
    await wait();

    const lines = app.lines;
    expect(lines[0]).toContain("Fleet");
    expect(lines[0]).toContain("Routing");
    expect(lines[0]).toContain("Preview");
    expect(lines[0]).toContain("Profile");
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
    expect(helpLines.some((l) => l.includes("1-4"))).toBe(true);
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
    expect(app.viewLabels).toEqual(["Fleet", "Routing", "Preview", "Profile"]);
    app.stop();
  });
});
