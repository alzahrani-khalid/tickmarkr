import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { writeDoctor } from "../../src/adapters/registry.js";
import { channelsFromConfig, type WorkerAdapter } from "../../src/adapters/types.js";
import { assembleFleetEditor, type FleetIO } from "../../src/cli/commands/fleet.js";
import { loadConfig } from "../../src/config/config.js";
import { disallowedBy } from "../../src/route/preference.js";
import { runFleetInkEditor, type FleetEditorState } from "../../src/tui/ink/fleet-app.js";
import { makeRepo, makeTestTempDir } from "../helpers/tmprepo.js";

const K = { left: "\x1b[D", right: "\x1b[C", down: "\x1b[B", up: "\x1b[A", enter: "\r", esc: "\x1b", tab: "\t", space: " " };
type Entry = "probe" | "presets";
type Reach = "in" | "out-workers" | "out-all" | "out-allow";
const cleanups: Array<() => Promise<void>> = [];

beforeEach(() => {
  vi.stubEnv("HOME", makeTestTempDir("fleet-truth-home-"));
  vi.stubEnv("XDG_CONFIG_HOME", makeTestTempDir("fleet-truth-xdg-"));
  vi.stubEnv("FORCE_COLOR", "0");
});
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  vi.unstubAllEnvs();
});

function adapter(id: string): WorkerAdapter {
  return {
    id, vendor: id,
    probe: async () => ({ installed: true, authed: true, models: [] }),
    channels: (cfg) => channelsFromConfig(id, cfg),
    headlessCommand: () => id,
    interactiveCommand: () => null,
    invoke: () => ({ command: id }),
    parse: () => ({ ok: false, summary: "unused", deviations: [], raw: "" }),
  };
}

async function session(opts: { entry?: Entry; pool?: "any" | "ordered"; failed?: boolean; greyed?: boolean; reach?: Reach } = {}) {
  const repo = makeRepo({ "keep.txt": "x" });
  const globalDir = makeTestTempDir("fleet-truth-user-");
  mkdirSync(join(repo, ".tickmarkr"), { recursive: true });
  writeFileSync(join(globalDir, "config.yaml"), [
    "tiers:",
    "  fake:",
    "    vendor: fake",
    "    channel: sub",
    "    models:",
    "      fake-1: frontier",
    "      fake-2: frontier",
    "      fake-3: frontier",
    "  other:",
    "    vendor: other",
    "    channel: sub",
    "    models:",
    "      other-1: frontier",
    "routing:",
    "  mode: risk-based",
    ...(opts.greyed || opts.reach === "out-workers" || opts.reach === "out-all" ? [
      "  deny:",
      ...(opts.reach === "out-all" ? ["    models: [fake:fake-1]"] : []),
      ...(opts.greyed || opts.reach === "out-workers" ? [
        "    workers:", `      models: [${[opts.greyed ? "fake:fake-2" : "", opts.reach === "out-workers" ? "fake:fake-1" : ""].filter(Boolean).join(", ")}]`,
      ] : []),
    ] : []),
    ...(opts.reach === "out-allow" ? ["  allow:", "    models: [fake:fake-2, fake:fake-3, other:other-1]"] : []),
    ...(opts.pool ? [
      "  map:", "    plan:", "      pool:", `        mode: ${opts.pool}`,
      "        channels: [fake:fake-1, fake:fake-2, fake:fake-3]",
    ] : []),
    "",
  ].join("\n"));
  const probedAt = new Date().toISOString();
  writeDoctor(repo, Object.fromEntries(([
    ["fake", ["fake-1", "fake-2", "fake-3"]],
    ["other", ["other-1"]],
  ] as Array<[string, string[]]>).map(([id, models]) => [id, {
    installed: true, authed: true, version: "fixture", models,
    modelAuth: Object.fromEntries(models.map((model) => [model, {
      authed: !(opts.failed && model === "fake-1"), probedAt,
      ...(opts.failed && model === "fake-1" ? { reason: "quota exceeded" } : {}),
    }])),
  }])));

  const input = Object.assign(new PassThrough(), {
    isTTY: true, setRawMode() {}, ref() { return this; }, unref() { return this; },
  });
  const frames: string[] = [];
  const output = {
    isTTY: true, columns: 200, rows: 60,
    write(chunk: string) {
      const frame = chunk.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");
      if (frame.trim()) frames.push(frame);
      return true;
    },
    on() {}, off() {}, removeListener() {},
  };
  const assembled = await assembleFleetEditor(repo, [adapter("fake"), adapter("other")], {
    input, output, debug: true,
  } as FleetIO, { globalDir, entry: opts.entry });
  if ("unavailable" in assembled) throw new Error(assembled.unavailable);
  const reviewed: FleetEditorState[] = [];
  const review = assembled.props.reviewOverlay;
  assembled.props.reviewOverlay = (state) => {
    reviewed.push(structuredClone(state));
    return review(state);
  };
  const done = runFleetInkEditor(assembled.props);
  cleanups.push(async () => { input.write("\x03"); await done; input.destroy(); });
  const last = () => frames.at(-1) ?? "";
  const until = async (ready: () => boolean, label: string) => {
    const deadline = Date.now() + 5_000;
    while (!ready()) {
      if (Date.now() > deadline) throw new Error(`never rendered ${label}:\n${last()}`);
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
  };
  const key = async (bytes: string) => {
    for (const part of bytes.match(/\x1b\[[0-9;]*[A-Za-z~]|[\s\S]/g) ?? []) {
      const mark = frames.length;
      input.write(part);
      await until(() => frames.length > mark, `a frame after ${JSON.stringify(part)}`);
    }
  };
  await until(() => last().includes("All models"), "the browser");
  return {
    key, last, frames, reviewed, repo, globalDir,
    async close() { input.write("\x03"); await done; },
    async write() {
      input.write("y");
      const result = await done;
      expect(result.kind).toBe("write");
      expect(assembled.commit(result)).toMatch(/^fleet: wrote /);
      return loadConfig(repo, { globalDir });
    },
  };
}

test("test: moving the rail cursor shows that entry's pane without Enter, and right arrow focuses the shown pane, so a pane that lags the cursor fails", async () => {
  for (const entry of ["probe", "presets"] as const) {
    const s = await session({ entry });
    await s.key(K.left + K.down);
    expect(s.last()).toContain("Shapes  routed under risk-based");
    await s.key(K.right);
    expect(s.last()).toMatch(/Enter\s+edit pool/);
    await s.key(K.enter);
    expect(s.last()).toContain("pin · plan");
    await s.key(K.esc + K.left + K.down);
    expect(s.last()).toContain("Steering  review · consult · judge");
    await s.key(K.down);
    expect(s.last()).toMatch(/│ fake\s+3\s+│/);
    expect(s.last()).not.toContain("other/other-1");
    await s.key(K.down);
    expect(s.last()).toContain("other/other-1");
    expect(s.last()).not.toContain("fake/fake-1");
    await s.key(K.up);
    expect(s.last()).toContain("fake/fake-1");
    await s.key(K.right + K.space);
    expect(s.last()).toContain("reach · fake:fake-1");
    await s.key(K.esc + K.left + K.up + K.up + K.up);
    expect(s.last()).toContain("fake/fake-1");
    expect(s.last()).toContain("other/other-1");
    await s.close();
  }
});

test("REVIEW-REPRO: an unauthed out-all row must not widen to out-workers", async () => {
  const s = await session({ failed: true, reach: "out-all" });
  expect(s.last()).toMatch(/fake\/fake-1\s+frontier\s+out all/);
  await s.key(K.space + K.down + K.enter);
  const notice = s.last();
  // An unrelated healthy-row edit makes the unchanged exclusion reviewable and writable.
  await s.key(K.down + K.space + K.down + K.enter + "w");
  const cfg = await s.write();
  expect(cfg.routing.deny?.models ?? []).toContain("fake:fake-1");
  expect(s.reviewed.at(-1)?.denyModels).toContain("fake:fake-1");
  expect(s.reviewed.at(-1)?.denyWorkersModels).not.toContain("fake:fake-1");
  for (const role of ["worker", "judge", "review", "consult"] as const) {
    expect(disallowedBy({ adapter: "fake", model: "fake-1" }, cfg.routing, role), role).not.toBeNull();
  }
  expect(notice).toContain("quota exceeded");
  expect(notice).toContain("cannot set out · workers");
});

test("failed model reach edits never admit a seat across every starting reach and picker choice, while healthy rows can widen", async () => {
  const roles = ["worker", "judge", "review", "consult"] as const;
  // Closed transition table: both auth verdicts × four policy states × three picker choices.
  for (const failed of [true, false]) {
    for (const reach of ["in", "out-workers", "out-all", "out-allow"] as const) {
      for (const [at, choice] of (["in", "out-workers", "out-all"] as const).entries()) {
        const label = `${failed ? "failed" : "healthy"}: ${reach} -> ${choice}`;
        const s = await session({ failed, reach });
        const initial = loadConfig(s.repo, { globalDir: s.globalDir });
        const admitted = (cfg: typeof initial) => roles.filter((role) =>
          disallowedBy({ adapter: "fake", model: "fake-1" }, cfg.routing, role) === null);
        const before = admitted(initial);
        await s.key(K.space + K.down.repeat(at) + K.enter);
        const notice = s.last();
        // Force review and publication even when the target edit was refused or already applied.
        await s.key(K.down + K.space + K.down + K.enter + "w");
        const cfg = await s.write();
        const refused = failed && (choice === "in" || (choice === "out-workers" && (reach === "out-all" || reach === "out-allow")));
        const expected = refused ? reach : choice;
        const expectedSeats = expected === "in" ? [...roles] : expected === "out-workers" ? roles.slice(1) : [];
        expect(admitted(cfg), label).toEqual(expectedSeats);
        if (failed) expect(admitted(cfg).filter((role) => !before.includes(role)), label).toEqual([]);
        if (refused) {
          expect(notice, label).toContain("cannot set");
          expect(notice, label).toContain("quota exceeded");
          expect(s.reviewed.at(-1)?.denyWorkersModels.includes("fake:fake-1"), label).toBe(reach === "out-workers");
          if (reach === "out-all") expect(s.reviewed.at(-1)?.denyModels, label).toContain("fake:fake-1");
        }
      }
    }
  }
});

test("test: Enter on the Shapes rail entry opens the Shapes list on the first and every later entry, and m still opens the routing-mode chooser, so a first-entry presets hijack fails", async () => {
  for (const entry of ["probe", "presets"] as const) {
    const s = await session({ entry });
    expect(s.last()).not.toContain("routing mode");
    await s.key(K.left + K.down + K.enter);
    expect(s.last()).toContain("Shapes  routed under risk-based");
    expect(s.last()).toMatch(/Enter\s+edit pool/);
    expect(s.frames.join("")).not.toContain("routing mode");
    await s.key("m");
    expect(s.last()).toContain("routing mode");
    for (const mode of ["partner-led", "risk-based", "staff-led"]) expect(s.last()).toContain(mode);
    await s.key(K.esc + K.left + K.down + K.enter + K.left + K.up + K.enter);
    expect(s.last()).toMatch(/Enter\s+edit pool/);
    expect(s.last()).not.toContain("routing mode");
    await s.key(K.enter);
    expect(s.last()).toContain("pin · plan");
    await s.close();
  }
});

test("test: in the candidates overlay the move keys reorder the selected member and the staged pool keeps that order through review and write, while the Shapes footer names editing the pool, so a pool that can only be reordered by drop and re-add fails", async () => {
  for (const pool of ["any", "ordered"] as const) {
    // A carried, greyed member is still reorderable without lifting its deny.
    const s = await session({ pool, greyed: pool === "ordered" });
    await s.key(K.left + K.down + K.enter);
    expect(s.last()).toMatch(/Enter\s+edit pool/);
    await s.key(K.enter);
    expect(s.last()).toContain("[/]");
    expect(s.last()).toContain("move member up/down");
    // Select fake-2 by its displayed row, whether offered or greyed.
    while (!s.last().split("\n").some((line) => line.includes("❯") && /fake[/:]fake-2/.test(line))) await s.key(K.down);
    await s.key("[");
    expect(s.last()).toMatch(/❯\s+1\s+.*fake[/:]fake-2/);
    await s.key("]");
    expect(s.last()).toMatch(/❯\s+2\s+.*fake[/:]fake-2/);
    await s.key("[" + K.tab);
    expect(s.last()).toContain("pool mode");
    await s.key(K.esc);
    expect(s.last()).toMatch(/❯\s+1\s+.*fake[/:]fake-2/);
    await s.key(K.tab + K.enter);
    await s.key(K.enter); // reopening preserves the staged order
    expect(s.last()).toMatch(/1\s+.*fake[/:]fake-2/);
    await s.key(K.esc + "w");
    const channels = ["fake:fake-2", "fake:fake-1", "fake:fake-3"];
    expect(s.reviewed.at(-1)?.map.plan.pool).toEqual({ mode: pool, channels });
    const cfg = await s.write();
    expect(cfg.routing.map.plan.pool).toEqual({ mode: pool, channels });
    expect(cfg.routing.deny?.workers?.models ?? []).toEqual(pool === "ordered" ? ["fake:fake-2"] : []);
    expect(readFileSync(join(s.globalDir, "config.yaml"), "utf8")).toContain("fake:fake-2");
  }
});

test("test: an unauthed model row accepts out for workers and out for all seats with a warning naming its failed verdict and still refuses in, so a broken model that cannot be taken out, or one admitted while unauthed, fails", async () => {
  for (const out of ["workers", "all"] as const) {
    const s = await session({ failed: true });
    await s.key(K.space);
    expect(s.last()).toContain("reach · fake:fake-1");
    expect(s.last()).toContain("quota exceeded");
    await s.key(K.enter); // even an initially policy-in row cannot be admitted via this control
    expect(s.last()).toContain("cannot set in");
    await s.key(K.space + K.down + (out === "all" ? K.down : "") + K.enter);
    expect(s.last()).toContain("quota exceeded");
    expect(s.last()).toContain(out === "workers" ? "set out · workers" : "set out · all seats");
    expect(s.last()).toMatch(out === "workers" ? /fake\/fake-1\s+frontier\s+out workers/ : /fake\/fake-1\s+frontier\s+out all/);
    await s.key(K.space + K.enter);
    expect(s.last()).toContain("quota exceeded");
    expect(s.last()).toContain("cannot set in");
    await s.key("w");
    expect(s.reviewed.at(-1)?.[out === "workers" ? "denyWorkersModels" : "denyModels"]).toEqual(["fake:fake-1"]);
    const cfg = await s.write();
    expect(cfg.routing.deny?.workers?.models ?? []).toEqual(out === "workers" ? ["fake:fake-1"] : []);
    expect(cfg.routing.deny?.models ?? []).toEqual(out === "all" ? ["fake:fake-1"] : []);
  }
});
