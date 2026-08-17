import { mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { PassThrough } from "node:stream";
import { describe, expect, test } from "vitest";

import * as registry from "../../src/adapters/registry.js";
import { FakeAdapter } from "../../src/adapters/fake.js";
import { fleet, type FleetIO } from "../../src/cli/commands/fleet.js";
import {
  projectFleetWhy,
  renderFleetWhy,
  type FleetWhyValue,
} from "../../src/config/fleet-why.js";
import { tickmarkrDir } from "../../src/graph/graph.js";
import { makeRepo } from "../helpers/tmprepo.js";

const repoWith = (overlay = "") => {
  const repoRoot = makeRepo({ "keep.txt": "x" });
  const globalDir = mkdtempSync(join(tmpdir(), "tickmarkr-fleet-why-global-"));
  if (overlay) {
    mkdirSync(join(repoRoot, ".tickmarkr"), { recursive: true });
    writeFileSync(join(repoRoot, ".tickmarkr", "config.yaml"), overlay);
  }
  return { repoRoot, globalDir };
};

const project = (
  values: FleetWhyValue[],
  overlay = "",
  global = "",
) => {
  const { repoRoot, globalDir } = repoWith(overlay);
  if (global) writeFileSync(join(globalDir, "config.yaml"), global);
  return projectFleetWhy(values, { repoRoot, globalDir });
};

type TestInput = PassThrough & {
  isTTY: true;
  setRawMode: (mode: boolean) => void;
  ref: () => TestInput;
  unref: () => TestInput;
};

function ttyIO(): { io: FleetIO; input: TestInput; frames: string[] } {
  const input = new PassThrough() as TestInput;
  input.isTTY = true;
  input.setRawMode = () => {};
  input.ref = () => input;
  input.unref = () => input;
  const directWrite = input.write.bind(input);
  input.write = ((chunk: string | Uint8Array) => {
    const text = typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    for (const key of text.match(/\x1b\[[0-9;]*[A-Za-z~]|[\s\S]/g) ?? []) {
      setImmediate(() => directWrite(key));
    }
    return true;
  }) as typeof input.write;
  const frames: string[] = [];
  const output = {
    isTTY: true,
    columns: 120,
    rows: 60,
    write: (chunk: string) => {
      frames.push(chunk);
      return true;
    },
    on: () => {},
    off: () => {},
    removeListener: () => {},
  };
  return { io: { input, output, debug: true }, input, frames };
}

function stampFakeDoctor(repoRoot: string): FakeAdapter {
  const script = join(repoRoot, "fake.json");
  writeFileSync(script, JSON.stringify({ tasks: {} }));
  registry.writeDoctor(repoRoot, {
    fake: {
      installed: true,
      authed: true,
      version: "fake",
      models: ["fake-1"],
      modelsDetectedAt: "2026-08-05T00:00:00.000Z",
      modelAuth: { "fake-1": { authed: true, probedAt: "2026-08-05T00:00:00.000Z" } },
    },
  });
  const fresh = new Date(Date.now() - 60_000);
  utimesSync(join(tickmarkrDir(repoRoot), "doctor.json"), fresh, fresh);
  return new FakeAdapter(script);
}

const stripAnsi = (text: string) => text.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");

const FAKE_TIERS = `tiers:
  fake:
    vendor: fake
    channel: sub
    models:
      fake-1: mid
`;

async function fleetWhyText(overlay: string, global = ""): Promise<string> {
  const { repoRoot, globalDir } = repoWith(overlay);
  if (global) writeFileSync(join(globalDir, "config.yaml"), global);
  const output = await fleet(["--why", "--global-dir", globalDir], repoRoot, [stampFakeDoctor(repoRoot)]);
  return String(output);
}

const sourceFor = (output: string, shape: string) =>
  output.split("\n").find((line) => line.startsWith(`${shape} `))?.match(/source: (\S+)/)?.[1];

describe("fleet --why", () => {
  test("test: every value reports the layer that sourced it, proven member by member over the closed set of layers — a repo-overlay fixture, a global-config fixture, a seed-default fixture and an operator-pinned fixture", async () => {
    const repo = await fleetWhyText(`${FAKE_TIERS}routing:\n  floors:\n    implement: mid\n`);
    const global = await fleetWhyText(FAKE_TIERS, "routing:\n  floors:\n    implement: mid\n");
    const seed = await fleetWhyText(FAKE_TIERS);

    const { repoRoot, globalDir } = repoWith(FAKE_TIERS);
    const adapter = stampFakeDoctor(repoRoot);
    const { io, input, frames } = ttyIO();
    const editing = fleet(["--global-dir", globalDir], repoRoot, [adapter], io);
    // the presets overlay (auto-raised on first Shapes entry) eats jj+Enter as a MODE change —
    // staged work, so the quit guard takes a second q
    input.write("\x1b[D\x1b[B\r" + "jjp\r" + "qq");
    expect(await editing).toBe("fleet: quit without writing");
    const pinned = stripAnsi(frames.join(""))
      .split("\n")
      .filter((line) => line.includes("implement") && line.includes("source:"))
      .at(-1);

    expect({
      repo: sourceFor(repo, "implement"),
      global: sourceFor(global, "implement"),
      seed: sourceFor(seed, "implement"),
      pinned: pinned?.match(/source: (\S+)/)?.[1],
    }).toEqual({
      repo: "repo-overlay",
      global: "global-config",
      seed: "seed-default",
      pinned: "operator-pinned",
    });
  });

  test("test: the text renderer and the Shapes screen report the same source for the same value, proven by both resolving through the one projection module and neither computing a layer itself", async () => {
    const { repoRoot, globalDir } = repoWith(`${FAKE_TIERS}routing:
  floors:
    implement: mid
`);
    const adapter = stampFakeDoctor(repoRoot);
    const text = await fleet(["--why", "--global-dir", globalDir], repoRoot, [adapter]);
    expect(typeof text).toBe("string");
    const textRow = String(text).split("\n").find((line) => line.includes("implement"));

    const { io, input, frames } = ttyIO();
    const editing = fleet(["--global-dir", globalDir], repoRoot, [adapter], io);
    // the q must not race the Shapes repaint — under parallel-fork load Ink coalesces frames and
    // a one-chunk nav+quit could unmount before the shapes list ever painted (the recurring flake)
    const shapesPainted = () =>
      stripAnsi(frames.join("")).split("\n").some((line) => line.includes("implement") && line.includes("source:"));
    input.write("\x1b[D\x1b[B\r" + "\x1b");
    for (let i = 0; i < 400 && !shapesPainted(); i++) await new Promise((resolve) => setTimeout(resolve, 5));
    input.write("q");
    expect(await editing).toBe("fleet: quit without writing");
    const shapeRow = stripAnsi(frames.join(""))
      .split("\n")
      .find((line) => line.includes("implement") && line.includes("source:"));

    expect(textRow).toContain("source: repo-overlay");
    expect(shapeRow).toContain("source: repo-overlay");
    const commandSource = readFileSync(
      join(import.meta.dirname, "../../src/cli/commands/fleet.ts"),
      "utf8",
    );
    expect(commandSource).toContain('from "../../config/fleet-why.js"');
    expect(commandSource).toContain("projectFleetWhy(");
    expect(commandSource).toContain("renderFleetWhy(");
    expect(commandSource).not.toContain("fleetKeyLayer");
    expect(commandSource).not.toMatch(/source:\s*(?:repo-overlay|global-config|seed-default|operator-pinned|defaulted)/);
  });

  test("test: a setup point renders a command the operator can copy and run verbatim, and renders nothing when no action is available", () => {
    const command = `node -e 'process.stdout.write("ready")'`;
    const [action, settled] = project([
      { id: "migration", effective: "unroutable", setupCommand: command },
      { id: "docs", effective: "fake:fake-1", declaredAt: "routing.floors.docs" },
    ]);

    expect(action.label).toContain(`setup: ${command}`);
    const renderedCommand = action.label.split("\n").find((line) => line.trimStart().startsWith("setup:"))
      ?.trimStart().slice("setup: ".length);
    expect(renderedCommand).toBe(command);
    const ran = spawnSync("bash", ["-lc", renderedCommand!], { encoding: "utf8" });
    expect({ status: ran.status, stdout: ran.stdout }).toEqual({ status: 0, stdout: "ready" });
    expect(settled.label).not.toContain("setup:");
  });

  test("test: a value with no declared source reports as defaulted rather than as configured", async () => {
    const output = await fleetWhyText(`${FAKE_TIERS}routing:\n  floors:\n    chore: null\n`);
    const row = output.split("\n").find((line) => line.startsWith("chore "));

    expect(row).toContain("source: defaulted");
    expect(row).not.toContain("configured");
  });

  test("no fleet surface THIS TASK SHIPS states an effective value without stating what produced it", () => {
    const rows = project([
      { id: "implement", effective: "fake:fake-1", declaredAt: "routing.floors.implement" },
      { id: "migration", effective: "unroutable", setupCommand: "tickmarkr fleet" },
    ]);

    expect(rows.every((row) => row.label.includes(row.effective) && row.label.includes("source:"))).toBe(true);
    expect(renderFleetWhy(rows).split("\n").filter((line) => line.includes("→")))
      .toEqual(rows.map((row) => row.label.split("\n")[0]));
  });
});
