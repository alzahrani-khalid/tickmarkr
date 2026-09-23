import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { PassThrough } from "node:stream";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { z } from "zod";

import { DENY_SCOPES, DenyBlockSchema, denyBlockFrom, denyEntriesAt, denyScopesOf, fleetEditableFromConfig, loadConfig } from "../../src/config/config.js";
import { makeRepo } from "../helpers/tmprepo.js";

// OBS-1099 add.1 / OBS-1065: the deny scopes the fleet edits are DERIVED from the routing schema's
// shape, never listed by hand — one scope per string-array leaf of routing.deny, nested blocks walked.

// a raw-mode terminal for one production browser session: keys are pumped one token per tick so
// Ink sees each press on its own (the same shape tests/cli/fleet-reach.test.ts drives with)
function terminal() {
  type TestInput = PassThrough & { isTTY: boolean; setRawMode: (mode: boolean) => void; ref: () => TestInput; unref: () => TestInput };
  const input = new PassThrough() as TestInput;
  input.isTTY = true;
  input.setRawMode = () => {};
  input.ref = () => input;
  input.unref = () => input;
  const directWrite = input.write.bind(input);
  const pending: string[] = [];
  let pumping = false;
  const pump = () => {
    const token = pending.shift();
    if (token === undefined) { pumping = false; return; }
    directWrite(token);
    setImmediate(pump);
  };
  input.write = ((chunk: string | Uint8Array) => {
    const text = typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    pending.push(...(text.match(/\x1b\[[0-9;]*[A-Za-z~]|[\s\S]/g) ?? []));
    if (!pumping) { pumping = true; setImmediate(pump); }
    return true;
  }) as typeof input.write;
  const writes: string[] = [];
  const output = {
    isTTY: true, columns: 200, rows: 60,
    write(chunk: string) { if (chunk && writes.at(-1) !== chunk) writes.push(chunk); return true; },
    on() { return output; }, off() { return output; }, removeListener() { return output; },
  };
  return { input, output: output as unknown as NodeJS.WriteStream, writes };
}

test("test: the exported deny scope enumeration is derived from the routing schema shape so extending that shape with one more deny list in the test yields one more scope, so a hand written list a new scope leaves unchanged fails", async () => {
  // the shipped enumeration IS the production schema's shape, walked by the production seam
  expect(DENY_SCOPES).toEqual(denyScopesOf(DenyBlockSchema));
  expect(DENY_SCOPES.map((scope) => scope.key)).toEqual(["denyAdapters", "denyModels", "denyWorkersAdapters", "denyWorkersModels"]);

  // review (fixture-overfit): extend the PRODUCTION shape BEFORE config.ts derives the enumeration
  // Fleet consumes. The one `.extend` call that builds DenyBlockSchema (the augmentation carrying
  // `workers`) gains one more deny list while the module re-evaluates; the reloaded module's
  // DENY_SCOPES — the very export fleet-app/fleet-overlay import — must carry the new scope, and its
  // reader must surface a list authored there. Four hand-written records could never grow here.
  const proto = Object.getPrototypeOf(z.object({})) as object;
  const original = Object.getOwnPropertyDescriptor(proto, "extend")!;
  Object.defineProperty(proto, "extend", {
    ...original,
    get(this: z.ZodObject<z.ZodRawShape>) {
      const extend = original.get!.call(this) as (shape: z.ZodRawShape) => z.ZodObject<z.ZodRawShape>;
      return (shape: z.ZodRawShape) =>
        extend.call(this, "workers" in shape ? { ...shape, judges: z.array(z.string()).optional() } : shape);
    },
  });
  try {
    vi.resetModules();
    const fresh = await import("../../src/config/config.js");
    expect(fresh.DENY_SCOPES).toHaveLength(DENY_SCOPES.length + 1);
    expect(fresh.DENY_SCOPES.map((scope) => scope.dotted)).toEqual([...DENY_SCOPES.map((scope) => scope.dotted), "routing.deny.judges"]);
    expect(fresh.DENY_SCOPES.find((scope) => scope.dotted === "routing.deny.judges")).toEqual({ key: "denyJudges", path: ["routing", "deny", "judges"], dotted: "routing.deny.judges" });
    // the reader ranges over that grown enumeration: the new list rides under its derived key
    const grown = makeRepo({ "config.yaml": "routing:\n  deny:\n    judges: [fake:fake-2]\n" });
    const editable = fresh.fleetEditableFromConfig(fresh.loadConfig(grown, { globalDir: grown }));
    expect((editable as Record<string, unknown>).denyJudges).toEqual(["fake:fake-2"]);

    // review (fixture-overfit, rounds 3–4): the Fleet boundary itself runs against the grown export —
    // a PRODUCTION browser session (the fleet command, Ink, the reach picker, the confirm, the writer)
    // opens a repo denying fake-2 through the grown scope alone, renders it out with that scope named
    // on its row, lifts it through the owning row's reach picker, and writes: the file loses exactly
    // routing.deny.judges while the sibling routing.deny.models keeps its entry. No dummy set or
    // hand-carried field anywhere could pass this — every site between the schema and the file is a
    // loop over the enumeration, and the browser's own deny discovery ranges over it too.
    const { fleet } = await import("../../src/cli/commands/fleet.js");
    const { channelsFromConfig } = await import("../../src/adapters/types.js");
    const registry = await import("../../src/adapters/registry.js");
    const repo = makeRepo({ "keep.txt": "x" });
    mkdirSync(join(repo, ".tickmarkr"), { recursive: true });
    const overlay = "tiers:\n  fake:\n    vendor: fake\n    channel: sub\n    models:\n      fake-1: mid\n      fake-2: mid\n"
      + "routing:\n  deny:\n    judges: [fake:fake-2]  # the grown scope\n    models: [fake:fake-1]  # a sibling the write keeps\n";
    writeFileSync(join(repo, ".tickmarkr", "config.yaml"), overlay);
    registry.writeDoctor(repo, {
      fake: {
        installed: true,
        authed: true,
        version: "fake",
        models: ["fake-1", "fake-2"],
        modelAuth: { "fake-1": { authed: true, probedAt: "2026-09-12T00:00:00.000Z" }, "fake-2": { authed: true, probedAt: "2026-09-12T00:00:00.000Z" } },
      },
    });
    const adapter = {
      id: "fake",
      vendor: "fake",
      probe: async () => ({ installed: true, authed: true, models: [] }),
      channels: (c: Parameters<typeof channelsFromConfig>[1]) => channelsFromConfig("fake", c),
      headlessCommand: () => "fake",
      interactiveCommand: () => null,
      invoke: () => ({ command: "fake" }),
      parse: () => ({ ok: false, summary: "unused", deviations: [], raw: "" }),
      listModels: async () => [],
    } as unknown as Parameters<typeof fleet>[2][number];
    const io = terminal();
    // cursor opens on fake-1; ↓ to fake-2 (the row the grown scope excludes), Space opens the reach
    // picker on `in`, Enter takes it, w stages the write, y confirms
    const done = fleet(["--global-dir", grown], repo, [adapter], { input: io.input, output: io.output, debug: true } as unknown as Parameters<typeof fleet>[3]);
    io.input.write("\x1b[B" + " " + "\r" + "w" + "y");
    const out = await done;
    expect(out).toMatch(/^fleet: wrote /);
    const frames = io.writes.map((f) => f.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, ""));
    const lines = frames.flatMap((f) => f.split("\n")).map((line) => line.trim());
    expect(lines.find((line) => line.includes("reach: out") && line.includes("routing.deny.judges (fake:fake-2)")), "the grown scope renders on its row").toBeDefined();
    expect(lines.find((line) => line.includes("space: cleared fake:fake-2 from routing.deny.judges")), "the reach picker lifted it from the grown scope").toBeDefined();
    const after = fresh.loadConfig(repo, { globalDir: grown }).routing as unknown as { deny?: Record<string, unknown> };
    expect(after.deny?.judges, "the writer removed exactly the grown scope").toBeUndefined();
    expect(after.deny?.models, "the sibling scope kept its entry").toEqual(["fake:fake-1"]);
    expect(readFileSync(join(repo, ".tickmarkr", "config.yaml"), "utf8")).toContain("a sibling the write keeps");
    // and the two writer seams alone, with no browser in front: the grown scope is written and tombstoned by key
    const { renderFleetOverlayWrite, fleetRepoOverlayFromDelta } = await import("../../src/config/fleet-overlay.js");
    const initial = { ...fresh.fleetEditableFromConfig(fresh.loadConfig(repo, { globalDir: grown, repoOverlayText: overlay })) } as Record<string, unknown>;
    const lifted = { ...initial, denyJudges: [] };
    const bytes = renderFleetOverlayWrite(overlay, { initial, edited: lifted } as Parameters<typeof renderFleetOverlayWrite>[1]);
    const written = fresh.loadConfig(repo, { globalDir: grown, repoOverlayText: bytes }).routing as unknown as { deny?: Record<string, unknown> };
    expect(written.deny?.judges).toBeUndefined();
    expect(written.deny?.models).toEqual(["fake:fake-1"]);
    const delta = fleetRepoOverlayFromDelta(initial as never, { ...initial, denyJudges: ["fake:fake-1"] } as never) as { routing?: { deny?: Record<string, unknown> } };
    expect(delta.routing?.deny?.judges).toEqual(["fake:fake-1"]);
    // flat scopes are one membership write: the sibling is restated with its own list, never cleared
    expect(delta.routing?.deny?.models, "the flat sibling keeps its list").toEqual(["fake:fake-1"]);
  } finally {
    Object.defineProperty(proto, "extend", original);
    vi.resetModules();
  }

  // extend the PRODUCTION schema by one more list ⇒ the same seam yields exactly one more scope,
  // the shipped scopes unchanged before it, the new one derived (key, path, dotted)
  const extended = DenyBlockSchema.extend({ judges: z.array(z.string()).optional() });
  const scopes = denyScopesOf(extended);
  expect(scopes).toHaveLength(DENY_SCOPES.length + 1);
  expect(scopes.slice(0, DENY_SCOPES.length)).toEqual(DENY_SCOPES);
  expect(scopes[DENY_SCOPES.length]).toEqual({ key: "denyJudges", path: ["routing", "deny", "judges"], dotted: "routing.deny.judges" });

  // and one more nested block on the production schema ⇒ its leaves join too
  const nested = denyScopesOf(DenyBlockSchema.extend({ judge: DenyBlockSchema.shape.workers }));
  expect(nested).toHaveLength(DENY_SCOPES.length + 2);
  expect(nested.map((scope) => scope.dotted)).toEqual([...DENY_SCOPES.map((scope) => scope.dotted), "routing.deny.judge.adapters", "routing.deny.judge.models"]);
  expect(nested.find((scope) => scope.dotted === "routing.deny.judge.adapters")?.key).toBe("denyJudgeAdapters");

  // the reader ranges over the enumeration: every scope's authored list rides under its key
  const repo = makeRepo({ "keep.txt": "x" });
  const cfg = loadConfig(repo, { globalDir: repo });
  const lists = { denyAdapters: ["a"], denyModels: ["m"], denyWorkersAdapters: ["wa"], denyWorkersModels: ["wm"] };
  const routing = { ...cfg.routing, deny: denyBlockFrom(lists) };
  expect(routing.deny).toEqual({ adapters: ["a"], models: ["m"], workers: { adapters: ["wa"], models: ["wm"] } });
  for (const scope of DENY_SCOPES) expect(denyEntriesAt(routing, scope), scope.dotted).toEqual(lists[scope.key]);
  const editable = fleetEditableFromConfig({ ...cfg, routing });
  for (const scope of DENY_SCOPES) expect(editable[scope.key], scope.dotted).toEqual(lists[scope.key]);
});
