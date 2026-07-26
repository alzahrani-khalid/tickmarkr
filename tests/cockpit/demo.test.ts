import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { PassThrough } from "node:stream";
import { createElement, type ReactNode } from "react";
import { render } from "ink";
import { describe, expect, test } from "vitest";
import { writeDoctor } from "../../src/adapters/registry.js";
import { init } from "../../src/cli/commands/init.js";
import {
  captureCockpitOutput,
  findGoldenFrameMismatches,
  regenerateGoldenFrames,
} from "../../src/tui/cockpit/capture.js";
import {
  loadDemoCaptures,
  runCockpitDemo,
} from "../../src/tui/cockpit/demo.js";
import {
  deriveSetupCockpitData,
} from "../../src/tui/cockpit/setup-cockpit.js";
import { makeRepo } from "../helpers/tmprepo.js";

const SOURCES = join(import.meta.dirname, "../fixtures/cockpit/sources");
const CAPTURE_FILES = readdirSync(SOURCES)
  .filter((name) => name !== "README.md")
  .sort();
const DEMO_KEYS = {
  surface: "v",
  capture: "c",
  quit: "q",
} as const;
const stripAnsi = (value: string) =>
  value.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");
const wait = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms));

function demoStreams(columns: number, rows: number) {
  const input = new PassThrough() as PassThrough & {
    isTTY: boolean;
    setRawMode: (mode: boolean) => void;
    ref: () => NodeJS.ReadStream;
    unref: () => NodeJS.ReadStream;
  };
  input.isTTY = true;
  input.setRawMode = () => {};
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
    writes.push(
      typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"),
    );
    return Reflect.apply(write, output, [chunk, ...args]) as boolean;
  }) as typeof output.write;
  return {
    input: input as unknown as NodeJS.ReadStream,
    output: output as unknown as NodeJS.WriteStream,
    writes,
  };
}

async function openDemo(columns = 140, rows = 60) {
  const io = demoStreams(columns, rows);
  const done = runCockpitDemo({
    input: io.input,
    output: io.output,
    binaryVersion: "9.8.7",
    debug: true,
  });
  for (let attempt = 0; io.writes.length === 0 && attempt < 50; attempt += 1) {
    await wait(10);
  }
  return {
    ...io,
    done,
    frame: () => stripAnsi(io.writes.at(-1) ?? ""),
    async press(input: string) {
      const before = io.writes.length;
      io.input.write(input);
      for (
        let attempt = 0;
        io.writes.length === before && attempt < 50;
        attempt += 1
      ) {
        await wait(10);
      }
      return stripAnsi(io.writes.at(-1) ?? "");
    },
    // The quit key is the only thing that ends the Ink app, so an unbounded `await done` turns any
    // missed keystroke into a bare 20s vitest timeout that says nothing about why. Bound it,
    // escalate to ending stdin, and if it still will not exit, fail with a diagnosis, not a
    // stopwatch:
    // a hang and a slow runner look identical in the timeout message, and they need opposite fixes.
    async close() {
      let exited = false;
      const settled = done.then(() => { exited = true; });
      for (let attempt = 0; !exited && attempt < 60; attempt += 1) {
        io.input.write(DEMO_KEYS.quit);
        await Promise.race([settled, wait(50)]);
      }
      if (!exited) {
        io.input.end();
        await Promise.race([settled, wait(2000)]);
      }
      if (!exited) {
        throw new Error(
          `demo did not exit after 60 quit keys and an stdin end — writes=${io.writes.length}, `
          + `lastFrameChars=${(io.writes.at(-1) ?? "").length}`,
        );
      }
      await done;
    },
  };
}

function committedGoldenFrames(): Map<string, string> {
  const directory = join(import.meta.dirname, "../fixtures/cockpit/frames");
  return new Map(
    readdirSync(directory).map((fileName) => [
      fileName,
      readFileSync(join(directory, fileName), "utf8"),
    ]),
  );
}

async function renderComponent(node: ReactNode, columns = 140): Promise<string> {
  const output = new PassThrough() as PassThrough & {
    isTTY: boolean;
    columns: number;
    rows: number;
  };
  output.isTTY = true;
  output.columns = columns;
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
  const app = render(node, {
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

async function loadFrame(binaryVersion = "9.8.7") {
  const demo = await import("../../src/tui/cockpit/demo.js");
  const cockpit = await import("../../src/tui/cockpit/run-cockpit.js");
  const captures = demo.loadDemoCaptures();
  const source = captures.journals.find((journal) =>
    journal.fileName === "run-20260724-231138.journal.jsonl"
  )!;
  const data = cockpit.deriveRunCockpitData(source, binaryVersion);
  const frame = await renderComponent(createElement(cockpit.RunCockpitFrame, {
    data,
    columns: 140,
  }));
  return { cockpit, captures, data, demo, frame, source };
}

describe("cockpit demo captures", () => {
  test("test: the captured base configuration is byte-identical to the configuration the current binary writes for a fresh install", async () => {
    const repo = makeRepo({ "keep.txt": "x\n" });
    writeDoctor(repo, {
      fake: { installed: true, authed: true, models: [] },
    });
    const globalDir = mkdtempSync(
      join(tmpdir(), "tickmarkr-cockpit-fresh-global-"),
    );

    await init(["--global-dir", globalDir], repo);

    expect(
      readFileSync(join(SOURCES, "config.global.yaml"), "utf8"),
    ).toBe(readFileSync(join(globalDir, "config.yaml"), "utf8"));
  });

  test("test: no vendored capture names a product this repository no longer ships", () => {
    const retiredProduct = ["dro", "vr"].join("");

    for (const fileName of CAPTURE_FILES) {
      expect(
        readFileSync(join(SOURCES, fileName), "utf8"),
        fileName,
      ).not.toContain(retiredProduct);
    }
  });

  test("test: the base capture and the overlay capture still layer into a difference the overlay panel can draw", async () => {
    const data = deriveSetupCockpitData(loadDemoCaptures(), "9.8.7");
    const firstAddition = data.overlayDiff
      .split("\n")
      .find((line) => line.startsWith("+") && !line.startsWith("+++"));
    const demo = await openDemo();
    const setup = await demo.press(DEMO_KEYS.surface);

    expect(data.config.gates.test).toBe("npm test");
    expect(firstAddition).toBeTypeOf("string");
    expect(setup).toContain("OVERLAY DIFF");
    expect(setup).toContain(firstAddition);
    await demo.close();
  });

  test("test: the demo receives the terminal's row count as well as its column count, and the arrangement it draws changes at each contracted height tier boundary", async () => {
    const frames: string[] = [];
    for (const rows of [14, 18, 24, 40]) {
      const demo = await openDemo(140, rows);
      const frame = demo.frame();
      expect(frame).toContain("v9.8.7");
      expect(frame.split("\n").length).toBeLessThanOrEqual(rows);
      frames.push(frame);
      await demo.close();
    }

    expect(new Set(frames)).toHaveLength(4);
  });

  test("test: below the contracted row floor or column floor the demo emits the plain renderer rather than a frame, exactly as the surface does elsewhere", async () => {
    for (const [columns, rows] of [[39, 14], [40, 13]] as const) {
      const expected = demoStreams(columns, rows);
      const elsewhere = await captureCockpitOutput({
        cockpit: "run",
        output: expected.output,
        binaryVersion: "9.8.7",
        columns,
        rows,
        interactive: true,
        colour: false,
        ci: false,
      });
      const demo = await openDemo(columns, rows);

      await expect(demo.done).resolves.toBeUndefined();
      expect(demo.writes.join("")).toBe(elsewhere.output);
      expect(demo.writes.join("")).not.toMatch(/[\u2500-\u257f]/u);
    }
  });

  test("test: one key switches between the run surface and the setup surface, and the setup surface is drawn by the component the setup tests already cover rather than by anything newly drawn", async () => {
    const demo = await openDemo();
    expect(demo.frame()).toContain("VIEWS");

    const setup = await demo.press(DEMO_KEYS.surface);

    expect(setup).toContain("SETUP");
    expect(setup).toContain("HARNESSES");
    expect(setup).toContain("OVERLAY DIFF");
    const source = readFileSync(
      join(import.meta.dirname, "../../src/tui/cockpit/demo.ts"),
      "utf8",
    );
    expect(source).toContain("SetupCockpitFrame");
    expect(source).not.toMatch(/function\s+\w*Setup\w*Frame/);
    await demo.close();
  });

  test("test: one key cycles the committed captures, and every capture the loader reads is reachable rather than only the eventful engagement", async () => {
    const captures = loadDemoCaptures();
    const demo = await openDemo();
    const reached = new Set<string>();

    expect(demo.frame()).toContain("run-20260724-231138");
    reached.add("run-20260724-231138.journal.jsonl");
    expect(await demo.press(DEMO_KEYS.capture)).toContain("run-20260725-025004");
    reached.add("run-20260725-025004.interrupted.journal.jsonl");
    expect(await demo.press(DEMO_KEYS.capture)).toContain("run-20260724-194619");
    reached.add("run-20260724-194619.journal.jsonl");

    const setup = await demo.press(DEMO_KEYS.surface);
    expect(setup).toContain("cursor-agent");
    expect(setup).toContain("config.repo.yaml");
    reached.add(captures.doctor.fileName);
    reached.add(captures.config.global.fileName);
    reached.add(captures.config.repo.fileName);

    expect([...reached].sort()).toEqual(
      captures.files.map((capture) => capture.fileName).sort(),
    );
    await demo.close();
  });

  test("test: the interrupted capture renders its dispatched tasks as interrupted on the demo path, not only in isolation", async () => {
    const demo = await openDemo();
    const interrupted = await demo.press(DEMO_KEYS.capture);

    for (const taskId of ["T1", "T2", "T3"]) {
      expect(interrupted).toContain(`${taskId} interrupted`);
    }
    expect(interrupted).not.toContain(" running ");
    await demo.close();
  });

  test("test: the capture whose two tip verification sources disagree renders that verification as failed on the demo path, not only in isolation", async () => {
    const demo = await openDemo();
    await demo.press(DEMO_KEYS.capture);
    const failed = await demo.press(DEMO_KEYS.capture);

    expect(failed).toContain("tip-verify FAILED");
    await demo.close();
  });

  test("test: the demo binds nothing beyond surface switching, capture cycling and quit, so no navigation, selection or panel cycling exists behind any key", async () => {
    const demoModule = await import("../../src/tui/cockpit/demo.js");
    expect(Reflect.get(demoModule, "DEMO_KEYS")).toEqual({
      surface: "v",
      capture: "c",
      quit: "q",
    });
    const demo = await openDemo();
    const initial = demo.frame();
    const before = demo.writes.length;

    demo.input.write("\u001b[A\u001b[B\r\t ?f/a rsnp");
    await wait(50);

    expect(demo.writes.length).toBe(before);
    expect(demo.frame()).toBe(initial);
    await demo.close();
  });

  test("test: regenerating every committed golden frame reproduces it byte for byte, so this task altered no rendered output", async () => {
    const regenerated = await regenerateGoldenFrames();

    expect(
      findGoldenFrameMismatches(regenerated, committedGoldenFrames()),
    ).toEqual([]);
  });

  test("test: the demo draws the run cockpit entirely from the committed capture sources, starting no run, tailing nothing and probing nothing", async () => {
    const { frame } = await loadFrame();
    const demoSource = readFileSync(
      join(import.meta.dirname, "../../src/tui/cockpit/demo.ts"),
      "utf8",
    );

    expect(frame).toContain("RUN");
    expect(frame).toContain("JOURNAL");
    expect(demoSource).not.toMatch(/\bJournal\b|readDoctor|loadConfig|watch|tail|probe|spawn/);
  });

  test("test: one loader reads every committed capture, the engagement journals and the detection cache and the configuration pair alike, so no second loader is needed for the other cockpit", async () => {
    const { captures } = await loadFrame();

    expect(captures.files.map((capture) => capture.fileName).sort()).toEqual(CAPTURE_FILES);
    expect(captures.journals).toHaveLength(3);
    expect(captures.doctor.fileName).toBe("doctor.json");
    expect(captures.config.global.fileName).toBe("config.global.yaml");
    expect(captures.config.repo.fileName).toBe("config.repo.yaml");
  });

  test("test: the frame composes the contracted regions of the run surface, each drawn through the shared component vocabulary rather than through text joined before rendering", async () => {
    const { frame } = await loadFrame();
    const source = readFileSync(
      join(import.meta.dirname, "../../src/tui/cockpit/run-cockpit.tsx"),
      "utf8",
    );

    for (const region of [
      "VIEWS",
      "RUN",
      "TASKS",
      "GATES",
      "PASS RATE",
      "PROGRESS",
      "JOURNAL",
      "KEYS",
      "tip-verify",
      "Move",
    ]) {
      expect(frame).toContain(region);
    }
    for (const component of [
      "BodyText",
      "CockpitGrid",
      "JournalRowPanel",
      "Keybar",
      "Panel",
      "ProgressMeter",
      "StatTile",
      "StatusStrip",
    ]) {
      expect(source).toContain(component);
    }
    expect(source).not.toContain(".join(");
  });

  test("test: the version the header shows is resolved from the running binary rather than from the repository manifest, and is accompanied by the preflight indicator", async () => {
    const { frame } = await loadFrame("9.8.7");
    const repositoryVersion = JSON.parse(
      readFileSync(join(import.meta.dirname, "../../package.json"), "utf8"),
    ).version as string;

    expect(frame).toContain("v9.8.7 · binary ✓");
    expect(frame).not.toContain(`v${repositoryVersion} · binary ✓`);
  });

  test("test: the run reference and the spec branch the header identifies itself with equal the values independently derived from the captured source rather than read from any summary line it contains", async () => {
    const { cockpit, source } = await loadFrame();
    const expectedRunId = basename(source.fileName).replace(/\.journal\.jsonl$/, "");
    const expectedBranch = (source.events.find((event) => event.event === "run-start")
      ?.data.branch) as string;
    const poisoned = {
      ...source,
      events: source.events.map((event) =>
        event.event === "run-end"
          ? { ...event, data: { ...event.data, runId: "summary-lie", branch: "summary/lie" } }
          : event
      ),
    };

    const data = cockpit.deriveRunCockpitData(poisoned, "9.8.7");

    expect(data.runId).toBe(expectedRunId);
    expect(data.branch).toBe(expectedBranch);
    expect(data.runId).not.toBe("summary-lie");
    expect(data.branch).not.toBe("summary/lie");
  });

  test("test: the header states the run status and an elapsed reading, the elapsed asserted by the form it takes rather than against a clock the test does not control", async () => {
    const { frame } = await loadFrame();

    expect(frame).toMatch(/\b(done|failed|interrupted|running) · \d{2}:\d{2}:\d{2}\b/);
  });

  test("test: the nav column lists its contracted entries and marks the current one, separately from any step indicator the other surface carries", async () => {
    const { frame } = await loadFrame();

    expect(frame).toMatch(/❯\s+Run/);
    for (const entry of ["Tasks", "Gates", "Journal", "Fleet"]) {
      expect(frame).toContain(entry);
    }
    expect(frame).not.toMatch(/\bstep\s+\d/i);
  });

  test("the demo reaches no live source and mutates no configuration", async () => {
    const before = Object.fromEntries(CAPTURE_FILES.map((fileName) => [
      fileName,
      readFileSync(join(SOURCES, fileName), "utf8"),
    ]));

    await loadFrame();

    const after = Object.fromEntries(CAPTURE_FILES.map((fileName) => [
      fileName,
      readFileSync(join(SOURCES, fileName), "utf8"),
    ]));
    expect(after).toEqual(before);
  });

  test("the frame is assembled from the shared component vocabulary rather than from a second set of renderers local to the surface", async () => {
    const { cockpit } = await loadFrame();

    expect(cockpit.RunCockpitFrame).toBeTypeOf("function");
    expect(Object.keys(cockpit).filter((name) => name.endsWith("Renderer"))).toEqual([]);
  });
});
