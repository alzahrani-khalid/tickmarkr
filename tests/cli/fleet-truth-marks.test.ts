import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { expect, onTestFinished, test } from "vitest";
import { stringify } from "yaml";
import { writeDoctor } from "../../src/adapters/registry.js";
import { channelsFromConfig, type AuthHealth, type WorkerAdapter } from "../../src/adapters/types.js";
import { assembleFleetEditor, type FleetIO } from "../../src/cli/commands/fleet.js";
import { loadConfig, type TickmarkrConfig } from "../../src/config/config.js";
import { exclusionCollector } from "../../src/route/preference.js";
import { modelMark, railMark, runFleetInkEditor, type FleetEditorState } from "../../src/tui/ink/fleet-app.js";
import { makeRepo, makeTestTempDir } from "../helpers/tmprepo.js";

// OBSERVER D-2178 add.77 F3/F9/F10/F11: exercise the production evidence assembler,
// renderer, reach picker and reviewed writer; no live doctor or routing changes.
const DOWN = "\x1b[B";
const LEFT = "\x1b[D";
const REACH_IN = " \r";
const REACH_ALL = ` ${DOWN}${DOWN}\r`;
const strip = (text: string) => text.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");
const at = new Date().toISOString();
const probed = { authed: true, probedAt: at };

async function session(
  routing: Partial<TickmarkrConfig["routing"]> = {},
  verdict: Partial<AuthHealth> = {},
) {
  const repo = makeRepo({ "keep.txt": "x", ".tickmarkr/config.yaml": "# user fleet\n" });
  const globalDir = makeTestTempDir("fleet-truth-");
  const userPath = join(globalDir, "config.yaml");
  writeFileSync(userPath, stringify({
    tiers: Object.fromEntries(["agy", "omp"].map((id) => [id, { vendor: id, channel: "sub", models: { A: "mid", B: "cheap" } }])),
    routing,
  }));
  const adapters: WorkerAdapter[] = ["agy", "omp"].map((id) => ({
    id, vendor: id,
    channels: (cfg) => channelsFromConfig(id, cfg),
    probe: async () => { throw new Error("truth marks use recorded doctor verdicts only"); },
    headlessCommand: () => id,
    interactiveCommand: () => null,
    invoke: () => ({ command: id }),
    parse: () => ({ ok: false, summary: "unused", deviations: [], raw: "" }),
  }));
  writeDoctor(repo, Object.fromEntries(adapters.map(({ id }) => [id, {
    installed: true, authed: true, version: "cached", models: ["A", "B"],
    modelAuth: { A: probed, B: probed }, ...(id === "agy" ? verdict : {}),
  }])));
  const input = new PassThrough() as PassThrough & {
    isTTY: boolean; setRawMode: () => void; ref: () => typeof input; unref: () => typeof input;
  };
  input.isTTY = true;
  input.setRawMode = () => {};
  input.ref = input.unref = () => input;
  const writes: string[] = [];
  const output = {
    isTTY: true, columns: 160, rows: 60,
    write(chunk: string) { writes.push(strip(chunk)); return true; },
    on() { return output; }, off() { return output; }, removeListener() { return output; },
  } as unknown as NodeJS.WriteStream;
  const assembled = await assembleFleetEditor(repo, adapters, { input, output, debug: true } as FleetIO, { globalDir });
  if ("unavailable" in assembled) throw new Error(assembled.unavailable);
  let staged: FleetEditorState | undefined;
  const review = assembled.props.reviewOverlay;
  assembled.props.reviewOverlay = (state) => {
    staged = structuredClone(state);
    return review(state);
  };
  const done = runFleetInkEditor(assembled.props);
  let closed = false;
  const close = async () => {
    if (closed) return;
    input.write("\x03");
    await done;
    closed = true;
    input.destroy();
  };
  onTestFinished(close);
  const settle = async () => {
    for (let idle = 0, turns = 0; idle < 5 && turns < 500; turns++) {
      const count = writes.length;
      await new Promise((resolve) => setTimeout(resolve, 2));
      idle = count === writes.length ? idle + 1 : 0;
    }
  };
  const key = async (bytes: string) => {
    for (const token of bytes.match(/\x1b\[[0-9;]*[A-Za-z~]|[\s\S]/g) ?? []) {
      input.write(token);
      await settle();
    }
  };
  await settle();
  return {
    props: assembled.props, key, close,
    frame: () => writes.findLast((text) => text.includes("tickmarkr fleet")) ?? "",
    get staged() { return staged; },
    rail: (id = "agy") => key(LEFT + DOWN.repeat(id === "agy" ? 3 : 4)),
    async save() {
      await key("w");
      expect(staged).toBeDefined();
      input.write("y");
      const result = await done;
      closed = true;
      input.destroy();
      expect(assembled.commit(result)).toBe(`fleet: wrote ${userPath}`);
      return loadConfig(repo, { globalDir });
    },
    userText: () => readFileSync(userPath, "utf8"),
  };
}

test("closed table — an adapter whose doctor verdict is signed out with no per-model verdicts renders every one of its model rows with the fail glyph and a detail naming the signed-out adapter, while an authed adapter's verdictless row keeps its tier glyph, so a row healthier than its adapter fails", async () => {
  for (const entry of [
    { authed: false, modelAuth: {}, denied: false },
    { authed: false, modelAuth: undefined, denied: true },
    { authed: true, modelAuth: {}, denied: false },
  ]) {
    const s = await session(entry.denied ? { deny: { adapters: ["agy"] } } : {}, {
      authed: entry.authed, modelAuth: entry.modelAuth, note: "login expired",
      models: ["A", "B", "Group-low", "Group-high"],
    });
    const rows = s.props.modelGroups.find((group) => group.adapter === "agy")!.rows;
    expect(rows.map((row) => row.model)).toEqual(expect.arrayContaining(["A", "B", "Group"]));
    await s.rail();
    await s.key("\r");
    for (const row of rows) {
      const mark = entry.authed ? (row.tier ? "on" : "unknown") : "fail";
      expect(modelMark({ ...row, reach: entry.denied ? "out-all" : "in" }), row.model).toBe(mark);
      const glyph = entry.authed ? (row.tier ? "✓" : "?") : "✗";
      expect(s.frame(), row.model).toMatch(new RegExp(`${glyph === "?" ? "\\?" : glyph} agy/${row.model}\\s`));
      if (!entry.authed) {
        expect(row.evidence).toMatchObject({ unauthedAdapter: "agy", unauthed: "agy adapter signed out — login expired" });
        expect(s.frame()).toContain("agy adapter signed out");
      } else expect(row.evidence?.unauthed).toBeUndefined();
      await s.key(DOWN);
    }
    if (!entry.authed) {
      await s.key("\x1b[A".repeat(rows.length));
      await s.key(" ");
      expect(s.frame()).toContain("reach · agy:A");
      expect(s.frame()).toContain("agy adapter signed out — login expired");
      expect(s.frame()).toContain("out only; re-probe with tickmarkr doctor before setting in");
      await s.key("\r");
      expect(s.frame()).toContain("cannot set in");
      expect(s.frame()).toContain("agy adapter signed out — login expired");
      await s.key("w");
      expect(s.frame()).toContain("no staged edits");
    }
    await s.close();
  }
  // An explicit model verdict retains today's precedence even when the adapter is signed out.
  const own = await session({}, { authed: false, modelAuth: { A: probed, B: { ...probed, authed: false, reason: "model denied" } } });
  const ownRows = own.props.modelGroups[0].rows;
  expect(ownRows[0].evidence?.unauthedAdapter).toBeUndefined();
  expect(modelMark({ ...ownRows[0], reach: "in" })).toBe("on");
  expect(modelMark({ ...ownRows[1], reach: "in" })).toBe("fail");
  expect(modelMark({ ...ownRows[1], reach: "out-all" })).toBe("off");
});

test("closed table — the rail glyph reads in for all-in, partial for mixed, out for all-out and failed for a signed-out adapter, and the rail shows the legend line, so bare-id membership deciding the mark fails", async () => {
  const table = [
    { routing: {}, authed: true, reach: "in", partial: false, mark: "on", glyph: "✓" },
    { routing: { deny: { models: ["agy:A"] } }, authed: true, reach: "out-all", partial: true, mark: "warn", glyph: "!" },
    { routing: { deny: { models: ["agy:A", "agy:B"] } }, authed: true, reach: "out-all", partial: false, mark: "off", glyph: "○" },
    { routing: { allow: { adapters: ["omp"] } }, authed: true, reach: "out-allow", partial: false, mark: "off", glyph: "○" },
    { routing: { deny: { workers: { adapters: ["agy"] } } }, authed: true, reach: "out-workers", partial: false, mark: "warn", glyph: "!" },
    { routing: { deny: { adapters: ["agy"] } }, authed: false, reach: "out-all", partial: false, mark: "fail", glyph: "✗" },
  ] as const;
  for (const row of table) {
    expect(railMark({ reach: row.reach, partial: row.partial }, row.authed)).toBe(row.mark);
    const s = await session(row.routing as Partial<TickmarkrConfig["routing"]>, { authed: row.authed });
    const rail = s.frame().split("\n").find((line) => /[✓!○✗] agy\s+\d/.test(line));
    expect(rail, s.frame()).toContain(`${row.glyph} agy`);
    expect(s.frame().split("\n").filter((line) => line.includes("rail:"))).toEqual([
      " rail: ✓ in · ! partial · ○ out · ✗ signed out",
    ]);
    await s.close();
  }
  expect(railMark({ reach: "unknown", partial: false }, true)).toBe("fail");
});

test("an adapter whose bare id is held in the allow out-set while one of its channels computes in accepts out for all seats and stages it, while an adapter whose every channel is already out refuses with the already-out notice, so a refusal that never reads the computed reach fails", async () => {
  // Only A has a model verdict, so scope-blind discovery's universe excludes B. The allow
  // complement holds agy's bare id, yet the cached B row is explicitly admitted by the policy.
  const mixed = await session({ allow: { models: ["agy:B", "omp"] } }, { modelAuth: { A: probed } });
  expect(mixed.props.initialAllowOut).toContain("agy");
  expect(mixed.frame()).toMatch(/✓ agy\/B\s+cheap\s+in/);
  await mixed.rail();
  await mixed.key(REACH_ALL);
  expect(mixed.frame()).not.toContain("agy is already out");
  expect(mixed.frame()).toContain("to routing.deny.adapters");
  expect(mixed.frame()).toMatch(/○ agy\/B\s+cheap\s+out/);
  const cfg = await mixed.save();
  expect(mixed.staged?.denyAdapters).toContain("agy");
  expect(mixed.staged?.allowOut).not.toContain("agy");
  for (const model of ["A", "B"]) {
    for (const role of ["worker", "judge", "review", "consult"] as const) {
      expect(exclusionCollector({ adapter: "agy", model }, cfg.routing, role), `${role} ${model}`).not.toEqual([]);
    }
  }
  for (const routing of [{ allow: { adapters: ["omp"] } }, { deny: { adapters: ["agy"] } }, { deny: { models: ["agy:A", "agy:B"] } }]) {
    const allOut = await session(routing);
    const before = allOut.userText();
    await allOut.rail();
    await allOut.key(REACH_ALL);
    expect(allOut.frame()).toContain("agy is already out · all seats");
    await allOut.key("w");
    expect(allOut.frame()).toContain("no staged edits");
    expect(allOut.userText()).toBe(before);
    await allOut.close();
  }
});

test("admitting an adapter reports that it was added to routing.allow.adapters and removing a deny reports the removal from routing.deny.adapters, so a message that says cleared for an addition fails", async () => {
  const admission = await session({ allow: { adapters: ["omp"] } });
  await admission.rail();
  await admission.key(REACH_IN);
  expect(admission.frame()).toContain("space: added agy to routing.allow.adapters");
  expect(admission.frame()).not.toContain("cleared agy");
  const admitted = await admission.save();
  expect(exclusionCollector({ adapter: "agy", model: "A" }, admitted.routing, "worker")).toEqual([]);

  const removal = await session({ deny: { adapters: ["omp"] } });
  await removal.rail("omp");
  await removal.key(REACH_IN);
  expect(removal.frame()).toContain("space: removed omp from routing.deny.adapters");
  expect(removal.frame()).not.toContain("cleared omp");
  const removed = await removal.save();
  expect(removed.routing.deny?.adapters ?? []).not.toContain("omp");
});
