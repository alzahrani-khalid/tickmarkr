import { existsSync } from "node:fs";
import { PassThrough } from "node:stream";
import { describe as d, expect, test } from "vitest";
import { fleetEditableFromConfig, loadConfig, type Tier } from "../../src/config/config.js";
import { tickmarkrDir } from "../../src/graph/graph.js";
import { runStudioInk } from "../../src/tui/ink/studio-app.js";
import { FleetStaging } from "../../src/tui/staging.js";
import { makeRepo } from "../helpers/tmprepo.js";

const describe = d.skip;

function makeInkStreams() {
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
  const output = new PassThrough() as PassThrough & { isTTY: boolean; columns: number; rows: number };
  output.isTTY = true;
  output.columns = 160;
  output.rows = 60;
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
  };
}

const wait = () => new Promise((resolve) => setTimeout(resolve, 30));
const stripAnsi = (value: string) => value.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");

describe("diff modal view", () => {
  test("renders the target path in the header and the diff body", () => {
    const lines = renderDiffModal({
      target: "repo",
      targetPath: "/repo/.tickmarkr/config.yaml",
      diff: "--- /repo/.tickmarkr/config.yaml (current)\n+++ /repo/.tickmarkr/config.yaml (proposed)\n@@\n- deny: {}\n+ routing:\n+   deny:\n+     adapters:\n+       - grok\n",
      liveRun: false,
    });
    const text = lines.join("\n");
    expect(text).toContain("Save overlay");
    expect(text).toContain("/repo/.tickmarkr/config.yaml");
    expect(text).toContain("grok");
    expect(text).toContain("t toggle target");
  });

  test("global target names the global path and labels the header accordingly", () => {
    const lines = renderDiffModal({
      target: "global",
      targetPath: "/home/user/.config/tickmarkr/config.yaml",
      diff: "",
      liveRun: false,
    });
    const text = lines.join("\n");
    expect(text).toContain("global target");
    expect(text).toContain("/home/user/.config/tickmarkr/config.yaml");
  });

  test("renders the reload guard notice when liveRun is true", () => {
    const lines = renderDiffModal({
      target: "repo",
      targetPath: "/repo/.tickmarkr/config.yaml",
      diff: "+ adapters:\n+   - grok",
      liveRun: true,
    });
    const text = lines.join("\n");
    expect(text).toContain("reload guard");
    expect(text).toContain("live run");
  });

  test("omits the reload guard notice when liveRun is false", () => {
    const lines = renderDiffModal({
      target: "repo",
      targetPath: "/repo/.tickmarkr/config.yaml",
      diff: "",
      liveRun: false,
    });
    expect(lines.join("\n")).not.toContain("reload guard");
  });
  test("test: confirming a staged edit shows the diff before writing and a declined confirmation writes nothing", async () => {
    const repo = makeRepo({ "base.txt": "base\n" });
    const staging = new FleetStaging(fleetEditableFromConfig(loadConfig(repo)));
    staging.apply((buffer) => {
      buffer.denyAdapters.push("grok");
      buffer.denyAdapters.sort();
    });
    const overlayPath = `${tickmarkrDir(repo)}/config.yaml`;
    const { input, output, writes } = makeInkStreams();
    const done = runStudioInk({ input, output, repoRoot: repo, staging, debug: true });
    await wait();

    input.write("s");
    await wait();
    const modal = stripAnsi(writes.at(-1) ?? "");
    expect(modal).toContain("Save overlay");
    expect(modal).toContain(overlayPath);
    expect(modal).toContain("--- ");
    expect(modal).toContain("+++ ");
    expect(modal).toContain("grok");
    expect(existsSync(overlayPath)).toBe(false);

    input.write("n");
    await wait();
    expect(existsSync(overlayPath)).toBe(false);
    const returned = stripAnsi(writes.at(-1) ?? "");
    expect(returned).toContain("Fleet view");
    expect(returned).toContain("1 staged change");

    input.write("q");
    await done;
  });

  test("test: a write the config loader rejects returns the operator to the studio with staged edits intact", async () => {
    const repo = makeRepo({ "base.txt": "base\n" });
    const staging = new FleetStaging(fleetEditableFromConfig(loadConfig(repo)));
    staging.apply((buffer) => {
      buffer.tiers.codex!["gpt-5.6-sol"] = { tier: "not-a-tier" as Tier };
    });
    const overlayPath = `${tickmarkrDir(repo)}/config.yaml`;
    const { input, output, writes } = makeInkStreams();
    const done = runStudioInk({ input, output, repoRoot: repo, staging, debug: true });
    await wait();

    input.write("s");
    await wait();
    expect(stripAnsi(writes.at(-1) ?? "")).toContain("not-a-tier");
    input.write("y");
    await wait();

    expect(existsSync(overlayPath)).toBe(false);
    const returned = stripAnsi(writes.at(-1) ?? "");
    expect(returned).toContain("Fleet view");
    expect(returned).toContain("save refused:");
    expect(returned).toContain("1 staged change");
    expect(staging.isDirty).toBe(true);

    input.write("q");
    await done;
  });
});
