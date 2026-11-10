// Queue rows 353 and 367 R3 (D-2187 condition 2): the probe failure format table, every cell fed from the
// committed captured fixtures through the production probe loop (probeModels → the shared classifier).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { classifyProbeReply, probeModels } from "../../src/adapters/registry.js";
import { channelsFromConfig, modelAuthed, type AuthHealth, type WorkerAdapter } from "../../src/adapters/types.js";
import { DEFAULT_CONFIG, type TickmarkrConfig } from "../../src/config/config.js";
import { makeRepo } from "../helpers/tmprepo.js";

const FIXTURES = join(__dirname, "..", "fixtures", "probe-failures", "2026-11-08");
const read = (cell: string, stream: "stdout" | "stderr" | "rc") => readFileSync(join(FIXTURES, `${cell}.${stream}`), "utf8");
const captured = (cell: string) => ({ code: Number(read(cell, "rc").trim()), stdout: read(cell, "stdout"), stderr: read(cell, "stderr") });
type Runner = { code: number; stdout: string; stderr: string; timedOut?: boolean };

// The runner seam only: each probe command names its cell; the rest of the probe loop is production.
const runners = new Map<string, Runner>();
vi.mock("../../src/run/git.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/run/git.js")>();
  return {
    ...actual,
    sh: vi.fn((cmd: string, cwd: string, timeoutMs?: number) => {
      if (!cmd.startsWith("__PROBE_CELL__:")) return actual.sh(cmd, cwd, timeoutMs);
      const runner = runners.get(cmd.slice("__PROBE_CELL__:".length));
      return runner ? Promise.resolve(runner) : Promise.reject(new Error(`no cell ${cmd}`));
    }),
  };
});

const clapLine = "error: unexpected argument '--no-daemon' found";
const signedOut = captured("signed-out-empty-home");
const CELLS: Record<string, Runner> = {
  "launch-fault-argv": captured("launch-fault-argv"),
  "launch-fault-argv-claude": captured("launch-fault-argv-claude"),
  "timeout-stdin-held": { ...captured("timeout-stdin-held"), timedOut: true },
  "signed-out-empty-home": signedOut,
  "unknown-model": captured("unknown-model"),
  // bait: the codex launch-fault line after the signed-out banner lines, exit 1
  "bait-later-line": { ...signedOut, stderr: `${signedOut.stderr}${read("launch-fault-argv", "stderr")}` },
  // bait: the launch-fault text in stdout, exit 1 and exit 0
  "bait-stdout": { code: 1, stdout: read("launch-fault-argv", "stderr"), stderr: "" },
  "bait-exit-0": { code: 0, stdout: "", stderr: read("launch-fault-argv", "stderr") },
  // bait: the same two placements with exit 0 — the line after the signed-out banner lines, and in stdout
  "bait-later-line-exit-0": { ...signedOut, code: 0, stderr: `${signedOut.stderr}${read("launch-fault-argv", "stderr")}` },
  "bait-stdout-exit-0": { code: 0, stdout: read("launch-fault-argv", "stderr"), stderr: "" },
  // bait: the signed-out text with the runner's timer kill
  "bait-signed-out-timer": { ...signedOut, timedOut: true },
};

test("the probe failure format table classifies each captured fixture as launch fault timeout signed out or unserved model and each bait row keeps its base class", async () => {
  for (const [cell, runner] of Object.entries(CELLS)) runners.set(cell, runner);
  const repo = makeRepo({ "keep.txt": "x\n" });
  const cfg = structuredClone(DEFAULT_CONFIG);
  cfg.tiers = { cells: { vendor: "fixture", channel: "sub", models: Object.fromEntries(Object.keys(CELLS).map((cell) => [cell, "mid"])) } };
  const adapter = {
    id: "cells", vendor: "fixture",
    channels: (c: TickmarkrConfig) => channelsFromConfig("cells", c),
    probe: async () => ({ installed: true, authed: true, models: [] }),
    headlessCommand: (_prompt: string, model: string) => `__PROBE_CELL__:${model}`,
    interactiveCommand: () => null,
    invoke: () => ({ command: "unused" }),
    parse: () => ({ ok: false, summary: "unused", deviations: [], raw: "" }),
  } as unknown as WorkerAdapter;
  const health: Record<string, AuthHealth> = { cells: { installed: true, authed: true, models: [] } };
  await probeModels(cfg, repo, [adapter], health);
  const verdict = (cell: string) => health.cells.modelAuth![cell];
  const classOf = (cell: string) => {
    const v = verdict(cell);
    return { authed: v.authed, cause: v.cause, failure: v.failure };
  };

  // The two captured argv-parser shapes: clap (codex, exit 2) and commander (claude, exit 1).
  expect(verdict("launch-fault-argv")).toMatchObject({ authed: false, failure: "launch-fault", reason: clapLine });
  expect(verdict("launch-fault-argv-claude")).toMatchObject({
    authed: false, failure: "launch-fault", reason: "error: unknown option '--tickmarkr-no-such-flag'",
  });
  // The runner's own timer kill: a timeout whose reason names the probe budget.
  expect(verdict("timeout-stdin-held")).toMatchObject({ authed: false, failure: "timeout" });
  expect(verdict("timeout-stdin-held").reason).toMatch(/^probe timed out .*60000ms/);
  // Controls: the signed-out 401 stays unauthenticated with no failure field; the unserved model stays unknown-model.
  expect(classOf("signed-out-empty-home")).toEqual({ authed: false, cause: undefined, failure: undefined });
  expect(verdict("signed-out-empty-home").reason).toContain("401 Unauthorized");
  expect(verdict("unknown-model")).toMatchObject({ authed: false, cause: "unknown-model", reason: "unknown model id" });
  expect(verdict("unknown-model").failure).toBeUndefined();
  // Bait rows keep their base class: the text alone never makes a launch fault.
  expect(classOf("bait-later-line")).toEqual({ authed: false, cause: undefined, failure: undefined });
  expect(classOf("bait-stdout")).toEqual({ authed: false, cause: undefined, failure: undefined });
  expect(classOf("bait-exit-0")).toEqual({ authed: true, cause: undefined, failure: undefined });
  // exit 0: the signed-out banner still reads as the base's sign-out; the stdout copy alone is a healthy reply
  expect(classOf("bait-later-line-exit-0")).toEqual({ authed: false, cause: undefined, failure: undefined });
  // the base's reason is the output's tail, never the rejected line a launch fault would carry
  expect(verdict("bait-later-line-exit-0").reason).toContain("For more information, try '--help'.");
  expect(verdict("bait-later-line-exit-0").reason).not.toBe(clapLine);
  expect(classOf("bait-stdout-exit-0")).toEqual({ authed: true, cause: undefined, failure: undefined });
  // ...while the timer kill is a timeout whatever the text says.
  expect(verdict("bait-signed-out-timer")).toMatchObject({ authed: false, failure: "timeout" });

  // Every failure class stays unroutable, exactly like the base's unauthenticated verdict.
  for (const cell of ["launch-fault-argv", "launch-fault-argv-claude", "timeout-stdin-held", "bait-signed-out-timer"]) {
    expect(modelAuthed(health.cells, cell, true), cell).toBe(false);
  }

  // The shared classifier reads the same cells directly with the same answers (the Kimi turn's seam).
  for (const [cell, r] of Object.entries(CELLS)) {
    const reply = classifyProbeReply(r.code, r.stdout, r.stderr, r.timedOut);
    expect({ authed: reply.authed, cause: reply.cause, failure: reply.failure }, cell).toEqual(classOf(cell));
  }
  // A launch-fault line must start its line: indented or mid-line text is not the captured shape.
  expect(classifyProbeReply(2, "", `  ${clapLine}\n`).failure).toBeUndefined();
  expect(classifyProbeReply(2, "", `codex: ${clapLine}\n`).failure).toBeUndefined();
});
