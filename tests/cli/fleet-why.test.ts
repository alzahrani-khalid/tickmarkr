import { mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { PassThrough } from "node:stream";
import { describe, expect, test } from "vitest";

import * as registry from "../../src/adapters/registry.js";
import { FakeAdapter } from "../../src/adapters/fake.js";
import { channelsFromConfig, type WorkerAdapter } from "../../src/adapters/types.js";
import { assembleFleetEditor, fleet, type FleetIO } from "../../src/cli/commands/fleet.js";
import { loadConfig } from "../../src/config/config.js";
import {
  projectFleetWhy,
  renderFleetWhy,
  type FleetWhyValue,
} from "../../src/config/fleet-why.js";
import { disallowedBy } from "../../src/route/preference.js";
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

function ttyIO(rows = 60): { io: FleetIO; input: TestInput; frames: string[] } {
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
    rows,
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

function mechanismsRepo(): { repoRoot: string; globalDir: string; adapter: WorkerAdapter } {
  const repoRoot = makeRepo({ "keep.txt": "x" });
  const globalDir = mkdtempSync(join(tmpdir(), "tickmarkr-fleet-why-mechanisms-g-"));
  mkdirSync(join(repoRoot, ".tickmarkr"), { recursive: true });
  writeFileSync(join(repoRoot, ".tickmarkr", "config.yaml"), [
    "tiers:",
    "  fake:",
    "    vendor: fake",
    "    channel: sub",
    "    models:",
    "      fake-1: cheap", // in allow, IN pool, but below the implement floor
    "      fake-2: mid", // in allow, in every pool
    "      fake-3: frontier", // in allow, in every pool
    "      fake-4: mid", // in allow, but unauthed (doctor)
    "      fake-5: mid", // NOT in allow — the deny∩prefer collision target
    "      fake-6: mid", // NOT in allow AND explicitly denied — first-match provenance target
    "routing:",
    "  allow:",
    "    models: [fake:fake-1, fake:fake-2, fake:fake-3, fake:fake-4]",
    "  deny:",
    "    models: [fake:fake-6]",
    "  floors:",
    "    implement: mid",
    "  map:",
    "    spec:", // bare key ⇒ null: tombstones the DEFAULT_CONFIG seed pin for "spec"
    "    tests:",
    "      pin: { via: fake, model: fake-3 }",
    "    docs:",
    "      pool: { mode: any, channels: [fake:fake-2, fake:fake-3] }",
    "    chore:",
    "      prefer: [fake:fake-2]",
    "    refactor:",
    "      prefer: [fake:fake-5]",
    "  explore:",
    "    mode: off",
    "  learned: off",
    "",
  ].join("\n"));
  const scriptPath = join(repoRoot, "fake.json");
  writeFileSync(scriptPath, JSON.stringify({ tasks: {} }));
  // channels() reads cfg.tiers directly (unlike FakeAdapter's hardcoded pair) so every tier
  // band above actually reaches the pool this task's floor/pool/pin mechanisms filter.
  const adapter: WorkerAdapter = {
    id: "fake",
    vendor: "fake",
    probe: async () => ({ installed: true, authed: true, models: [] }),
    channels: (cfg) => channelsFromConfig("fake", cfg),
    headlessCommand: () => "fake",
    interactiveCommand: () => null,
    invoke: () => ({ command: "fake" }),
    parse: () => ({ ok: false, summary: "unused", deviations: [], raw: "" }),
    listModels: async () => [],
  };
  registry.writeDoctor(repoRoot, {
    fake: {
      installed: true,
      authed: true,
      version: "fake",
      models: ["fake-1", "fake-2", "fake-3", "fake-4", "fake-5", "fake-6"],
      modelAuth: {
        "fake-1": { authed: true, probedAt: "2026-09-12T00:00:00.000Z" },
        "fake-2": { authed: true, probedAt: "2026-09-12T00:00:00.000Z" },
        "fake-3": { authed: true, probedAt: "2026-09-12T00:00:00.000Z" },
        "fake-4": { authed: false, reason: "quota exceeded", probedAt: "2026-09-12T00:00:00.000Z" },
        "fake-5": { authed: true, probedAt: "2026-09-12T00:00:00.000Z" },
        "fake-6": { authed: true, probedAt: "2026-09-12T00:00:00.000Z" },
      },
    },
  });
  const fresh = new Date(Date.now() - 60_000);
  utimesSync(join(tickmarkrDir(repoRoot), "doctor.json"), fresh, fresh);
  return { repoRoot, globalDir, adapter };
}

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

  test("test: a channel excluded by allow, by a pin or pool, by a floor, by an unauthed probe, by a tombstone, by an explore or learned knob, by a task hint, by a deny∩prefer collision and by first-match provenance each render a reason or the not-manageable caption on their row, so a row that shows an exclusion with no reason fails", async () => {
    const { repoRoot, globalDir, adapter } = mechanismsRepo();

    const assembled = await assembleFleetEditor(repoRoot, [adapter], {}, { globalDir });
    if ("unavailable" in assembled) throw new Error(assembled.unavailable);
    const { candidatesForShape, initialMap } = assembled.props;
    const deny = {
      adapters: assembled.props.initialDenyAdapters,
      models: assembled.props.initialDenyModels,
      workersAdapters: assembled.props.initialDenyWorkersAdapters ?? [],
      workersModels: assembled.props.initialDenyWorkersModels ?? [],
    };
    const pick = (shape: string) => candidatesForShape(shape as Parameters<typeof candidatesForShape>[0], "risk-based", initialMap, deny);
    const noteFor = (shape: string) => pick(shape).excludedNote ?? "";
    // LEG2-T3 finding 1: the reason renders on the CHANNEL's own ledger row, not only in an aggregate
    const rowFor = (shape: string, key: string) =>
      (pick(shape).ledger ?? []).find((line) => line.startsWith(`${key.replace(":", "/")} — `)) ?? "";

    // no channel the picker leaves out is left without a row naming why
    for (const shape of ["implement", "tests", "docs", "chore", "refactor", "spec"]) {
      const offered = new Set(pick(shape).rows.map((row) => row.id));
      for (const model of ["fake-1", "fake-2", "fake-3", "fake-4", "fake-5", "fake-6"]) {
        if (!offered.has(`fake:${model}`)) expect(rowFor(shape, `fake:${model}`), `${shape} fake:${model}`).not.toBe("");
      }
    }
    // 1. allow — the channel's row names the allowlist that does not admit it
    expect(rowFor("implement", "fake:fake-5")).toContain("fake/fake-5 — routing.allow (not admitted)");
    // 2. pin — a channel that is not the pin names the pin, not manageable here
    expect(rowFor("tests", "fake:fake-2")).toContain("not routing.map.tests.pin (fake:fake-3) — not manageable here");
    // 2. pool — a channel outside the declared pool names the pool, not manageable here
    expect(rowFor("docs", "fake:fake-1")).toContain("outside routing.map.docs.pool — not manageable here");
    // 3. floor — the below-floor channel names the shape's floor
    expect(rowFor("implement", "fake:fake-1")).toContain("below routing.floors.implement (mid) — not manageable here");
    // 4. unauthed probe — the unauthed channel's row points at the doctor re-probe
    expect(rowFor("implement", "fake:fake-4")).toContain("unauthed (quota exceeded) — re-probe with tickmarkr doctor");
    // 7. task hint — the channel a shape's prefer names carries the not-manageable caption
    expect(rowFor("chore", "fake:fake-2")).toContain("task hint: routing.map.chore.prefer names it — not manageable here");
    // 8. deny∩prefer — the collided channel's row carries the standing lint, with the ACTUAL scope
    // (fake-5 is outside the allowlist; nothing denies it)
    expect(rowFor("refactor", "fake:fake-5")).toContain("deny∩prefer: routing.map.refactor.prefer fake:fake-5 fully disallowed by routing.allow");
    // 9. first-match provenance — a channel both denied and outside the allowlist lists BOTH scopes
    expect(rowFor("implement", "fake:fake-6")).toContain("fake/fake-6 — routing.deny.models (fake:fake-6); routing.allow (not admitted)");
    expect(disallowedBy({ adapter: "fake", model: "fake-6" }, loadConfig(repoRoot, { globalDir }).routing)).toEqual({ by: "deny", entry: "fake:fake-6" });
    // 5. tombstone and 6. explore/learned knobs mask or tune a whole shape rather than one channel —
    // each keeps its not-manageable caption row
    expect(noteFor("spec")).toContain("tombstone: routing.map.spec: null masks a lower layer's declaration — not manageable here");
    expect(noteFor("implement")).toContain("explore: routing.explore.mode is off — a global knob, not manageable here");
    expect(noteFor("implement")).toContain("learned: routing.learned is off — a global knob, not manageable here");
    // the aggregate bucket line stays beside the rows
    expect(noteFor("implement")).toContain("denied in config");
  });
  test("round 2 finding 4: on a 24-row terminal every channel's ledger row in the shape picker is reachable by navigation — none is elided behind the aggregate captions", async () => {
    const { repoRoot, globalDir, adapter } = mechanismsRepo();
    const { io, input, frames } = ttyIO(24);
    const done = fleet(["--global-dir", globalDir], repoRoot, [adapter], io);
    // rail → Shapes → close the first-entry presets overlay → docs (5th shape) → open its picker,
    // then walk the cursor down past every candidate and every ledger row
    const keys = ["\x1b[D", "\x1b[B", "\r", "\x1b", ...Array(4).fill("\x1b[B"), "p", ...Array(14).fill("\x1b[B"), "\x1b", "q", "q"];
    for (const key of keys) {
      input.write(key); // one key per macrotask: a bare Esc must not merge into the next arrow's sequence
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(await done).toBe("fleet: quit without writing");
    const all = stripAnsi(frames.join(""));
    expect(all).toContain("pool · docs"); // docs declares a pool, so its picker opens as the pool chain
    for (const row of [
      "fake/fake-1 — outside routing.map.docs.pool — not manageable here",
      "fake/fake-4 — unauthed (quota exceeded) — re-probe with tickmarkr doctor",
      "fake/fake-5 — routing.allow (not admitted); outside routing.map.docs.pool — not manageable here",
      "fake/fake-6 — routing.deny.models (fake:fake-6); routing.allow (not admitted); outside routing.map.docs.pool",
    ]) {
      expect(all, row).toContain(row);
    }
  });
});
