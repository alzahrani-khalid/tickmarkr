import { describe, expect, test } from "vitest";
import { PassThrough } from "node:stream";
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

async function drawFrame(node: ReactElement): Promise<string> {
  const { input, output, writes } = makeInkStreams();
  const app = render(node, {
    stdin: input,
    stdout: output,
    exitOnCtrlC: false,
    patchConsole: false,
    debug: true,
  });
  try {
    await wait();
    return stripAnsi(writes.join(""));
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
    }));
    expect(list).toContain("hub list title");
    expect(list).toContain("hub list legend");
    expect(list).toContain("❯ hub list row");

    const toggles = await drawFrame(createElement(Fragment, null,
      createElement(ToggleMark, { active: true }),
      createElement(ToggleMark, { active: false }),
    ));
    expect(toggles).toContain("✓");
    expect(toggles).toContain("○");

    const lines = await drawFrame(createElement(TextLines, {
      lines: ["hub line one", "hub line two"],
    }));
    expect(lines).toContain("hub line one");
    expect(lines).toContain("hub line two");

    const review = await drawFrame(createElement(FleetReviewScreen, {
      title: "hub review title",
      legend: "hub review legend",
      diff: "-before\n+after",
    }));
    expect(review).toContain("hub review title");
    expect(review).toContain("hub review legend");
    expect(review).toContain("-before");
    expect(review).toContain("+after");
  });

  test("test: the path that draws from a committed capture is asserted by running the command and observing what it draws, rather than by reading the command's own source text", async () => {
    const demo = makeInkStreams();
    demo.output.columns = 140;
    const done = ui(["--demo"], {
      input: demo.input,
      output: demo.output,
    });
    try {
      await expect.poll(
        () => stripAnsi(demo.writes.join("")),
        { interval: 10, timeout: 2_000 },
      ).toContain("run-20260724-231138");
      const frame = stripAnsi(demo.writes.join(""));
      expect(frame).toContain("VIEWS");
      expect(frame).toContain("RUN");
      expect(frame).toContain("tip-verify");
      // the demo's default committed capture, observed in the drawn header
      expect(frame).toContain("run-20260724-231138");
      expect(frame).not.toContain("Fleet view");
    } finally {
      demo.input.write("q");
      await expect(done).resolves.toBe("ui: closed");
    }
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
