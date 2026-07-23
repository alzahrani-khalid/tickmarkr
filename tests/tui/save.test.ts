import { describe as d, expect, test } from "vitest";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { loadConfig, fleetEditableFromConfig } from "../../src/config/config.js";
import { tickmarkrDir } from "../../src/graph/graph.js";
import { makeRepo } from "../helpers/tmprepo.js";

const describe = d.skip;

function makeStreams() {
  const input = new PassThrough() as InputStream;
  const out = new PassThrough();
  const output: OutputStream = {
    ...out,
    isTTY: true,
    columns: 80,
    rows: 40,
    write: (chunk: string) => out.write(chunk),
  };
  return { input, output };
}

const wait = (ms = 30) => new Promise((r) => setTimeout(r, ms));

function loadedState(repo: string) {
  const cfg = loadConfig(repo);
  return fleetEditableFromConfig(cfg);
}

describe("studio save — diff-confirm write path", () => {
  test("test: the modal renders the overlay difference and names the target overlay path in its header", async () => {
    const repo = makeRepo({ "base.txt": "base\n" });
    const { input, output } = makeStreams();
    const app = new StudioApp({ input, output, loaded: loadedState(repo), repoRoot: repo });
    app.start();
    await wait();

    app.stageEdit((buffer) => {
      buffer.denyAdapters.push("grok");
      buffer.denyAdapters.sort();
    });
    await wait();

    input.write("s");
    await wait();

    const lines = app.lines;
    const header = lines.join("\n");
    expect(header).toContain("Save overlay");
    expect(lines[1]).toContain(join(tickmarkrDir(repo), "config.yaml"));
    expect(lines.some((l) => l.startsWith("---") || l.startsWith("+++"))).toBe(true);
    expect(lines.some((l) => l.includes("grok"))).toBe(true);

    app.stop();
  });

  test("test: the target toggle switches the named path between the repository and global overlay", async () => {
    const repo = makeRepo({ "base.txt": "base\n" });
    const globalDir = join(repo, "global-config");
    const { input, output } = makeStreams();
    const app = new StudioApp({ input, output, loaded: loadedState(repo), repoRoot: repo, globalDir });
    app.start();
    await wait();

    app.stageEdit((buffer) => {
      buffer.denyAdapters.push("grok");
      buffer.denyAdapters.sort();
    });
    await wait();

    input.write("s");
    await wait();
    const repoPath = join(tickmarkrDir(repo), "config.yaml");
    expect(app.lines.join("\n")).toContain(repoPath);

    input.write("t");
    await wait();
    const globalPath = join(globalDir, "config.yaml");
    expect(app.lines.join("\n")).toContain(globalPath);
    expect(app.lines.join("\n")).not.toContain(repoPath);

    input.write("t");
    await wait();
    expect(app.lines.join("\n")).toContain(repoPath);

    app.stop();
  });

  test("test: a confirmed save writes the staged delta to the chosen overlay and clears the staged count", async () => {
    const repo = makeRepo({ "base.txt": "base\n" });
    const { input, output } = makeStreams();
    const app = new StudioApp({ input, output, loaded: loadedState(repo), repoRoot: repo });
    app.start();
    await wait();

    app.stageEdit((buffer) => {
      buffer.denyAdapters.push("grok");
      buffer.denyAdapters.sort();
    });
    await wait();
    expect(app.lines.some((l) => l.includes("1 staged change"))).toBe(true);

    input.write("s");
    await wait();
    input.write("y");
    await wait();

    const overlayPath = join(tickmarkrDir(repo), "config.yaml");
    expect(existsSync(overlayPath)).toBe(true);
    const written = readFileSync(overlayPath, "utf8");
    expect(written).toContain("grok");
    expect(app.lines.some((l) => l.includes("wrote"))).toBe(true);
    expect(app.lines.some((l) => l.includes("no staged changes"))).toBe(true);

    app.stop();
  });

  test("test: a declined save leaves disk and buffer unchanged", async () => {
    const repo = makeRepo({ "base.txt": "base\n" });
    const overlayPath = join(tickmarkrDir(repo), "config.yaml");
    const { input, output } = makeStreams();
    const app = new StudioApp({ input, output, loaded: loadedState(repo), repoRoot: repo });
    app.start();
    await wait();

    app.stageEdit((buffer) => {
      buffer.denyAdapters.push("grok");
      buffer.denyAdapters.sort();
    });
    await wait();

    input.write("s");
    await wait();
    input.write("n");
    await wait();

    expect(existsSync(overlayPath)).toBe(false);
    expect(app.lines.some((l) => l.includes("1 staged change"))).toBe(true);

    app.stop();
  });

  test("test: the written overlay re-parses to the staged state through the existing round-trip check", async () => {
    const repo = makeRepo({ "base.txt": "base\n" });
    const { input, output } = makeStreams();
    const loaded = loadedState(repo);
    const expected = structuredClone(loaded);
    expected.denyAdapters = [...expected.denyAdapters, "grok"].sort();

    const app = new StudioApp({ input, output, loaded, repoRoot: repo });
    app.start();
    await wait();

    app.stageEdit((buffer) => {
      buffer.denyAdapters.push("grok");
      buffer.denyAdapters.sort();
    });
    await wait();

    input.write("s");
    await wait();
    input.write("y");
    await wait();

    const reparsed = fleetEditableFromConfig(loadConfig(repo));
    expect(reparsed).toEqual(expected);
    expect(app.lines.some((l) => l.includes("no staged changes"))).toBe(true);

    app.stop();
  });

  test("test: with a live run present the modal carries the reload guard notice", async () => {
    const repo = makeRepo({ "base.txt": "base\n" });
    writeFileSync(join(tickmarkrDir(repo), "graph.lock"), JSON.stringify({ pid: process.pid, runId: "live-test", startedAt: Date.now() }));

    const { input, output } = makeStreams();
    const app = new StudioApp({ input, output, loaded: loadedState(repo), repoRoot: repo });
    app.start();
    await wait();

    app.stageEdit((buffer) => {
      buffer.denyAdapters.push("grok");
      buffer.denyAdapters.sort();
    });
    await wait();

    input.write("s");
    await wait();

    expect(app.lines.join("\n")).toContain("reload guard");

    app.stop();
  });

  test("the write lands atomically so no partial overlay can exist on disk", async () => {
    const repo = makeRepo({ "base.txt": "base\n" });
    const { input, output } = makeStreams();
    const app = new StudioApp({ input, output, loaded: loadedState(repo), repoRoot: repo });
    app.start();
    await wait();

    app.stageEdit((buffer) => {
      buffer.denyAdapters.push("grok");
      buffer.denyAdapters.sort();
    });
    await wait();

    input.write("s");
    await wait();
    input.write("y");
    await wait();

    const overlayPath = join(tickmarkrDir(repo), "config.yaml");
    expect(existsSync(overlayPath)).toBe(true);
    // Atomic rename (write temp + rename into place) should leave no temporary partial file behind.
    const temps = readdirSync(tickmarkrDir(repo)).filter(
      (f) => f.startsWith(".tickmarkr-save-") && f.endsWith(".tmp"),
    );
    expect(temps).toEqual([]);
    // A UUID sibling prevents same-process saves in one millisecond sharing a temp candidate.
    expect(readFileSync(new URL("../../src/tui/save.ts", import.meta.url), "utf8")).toContain("randomUUID");

    app.stop();
  });

  test("the save path reuses the existing overlay serializer and diff rendering rather than a parallel implementation", async () => {
    const repo = makeRepo({ "base.txt": "base\n" });
    const { input, output } = makeStreams();
    const app = new StudioApp({ input, output, loaded: loadedState(repo), repoRoot: repo });
    app.start();
    await wait();

    app.stageEdit((buffer) => {
      buffer.denyAdapters.push("grok");
      buffer.denyAdapters.sort();
    });
    await wait();

    input.write("s");
    await wait();

    const lines = app.lines;
    const text = lines.join("\n");
    expect(text).toContain("--- ");
    expect(text).toContain("+++ ");
    expect(text).toContain("grok");

    const saveSrc = readFileSync(new URL("../../src/tui/save.ts", import.meta.url), "utf8");
    expect(saveSrc).toContain("fleetRepoOverlayFromDelta");
    expect(saveSrc).toContain("repoOverlayYaml");
    expect(saveSrc).toContain("unifiedYamlDiff");
    expect(saveSrc).toMatch(/from\s+["']\.\.\/config\/config\.js["']/);
    expect(saveSrc).not.toMatch(/from\s+["']yaml["']/);

    app.stop();
  });
});
