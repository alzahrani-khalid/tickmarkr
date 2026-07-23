import { readFileSync } from "node:fs";
import { PassThrough } from "node:stream";
import { describe as d, expect, test } from "vitest";
import { writeDoctor } from "../../src/adapters/registry.js";
import { FleetStaging } from "../../src/tui/staging.js";
import { runStudioInk } from "../../src/tui/ink/studio-app.js";
import type { FleetEditable } from "../../src/config/config.js";
import { makeRepo } from "../helpers/tmprepo.js";

const describe = d.skip;

// Every fixture in this file is built inline in memory — no tmpdir, no repo, no files. That is
// the point: the view's render path consumes injected data only.
function fixture(): FleetViewData {
  return {
    doctorAgeMs: 12 * 60_000,
    adapters: [
      {
        adapter: "claude-code",
        models: [
          { model: "fable", tier: "frontier", channel: "sub" },
          { model: "sonnet", tier: "mid", channel: "sub" },
        ],
      },
      {
        adapter: "pi",
        models: [{ model: "zai/glm-5.2", tier: "mid", channel: "sub" }],
      },
    ],
    health: {
      "claude-code": {
        installed: true,
        authed: true,
        version: "2.1.205",
        models: ["fable", "sonnet"],
        modelAuth: {
          fable: { authed: true, probedAt: "2026-07-21T10:00:00.000Z" },
          sonnet: { authed: false, reason: "probe timed out after 60000ms", probedAt: "2026-07-21T10:01:00.000Z" },
        },
      },
      pi: {
        installed: true,
        authed: true,
        version: "0.80.3",
        models: ["zai/glm-5.2"],
        modelAuth: {
          "zai/glm-5.2": { authed: true, probedAt: "2026-07-21T09:00:00.000Z" },
        },
      },
    },
    denyAdapters: [],
    denyModels: ["pi:zai/glm-5.2"],
    notes: {
      denyModels: {
        "pi:zai/glm-5.2": "OBS-57: hangs at finish without a trailer — remove after no-trailer demotion ships",
      },
    },
    telemetry: [
      {
        taskId: "t1", shape: "implement", adapter: "pi", model: "zai/glm-5.2", channel: "sub",
        attempts: 1, outcome: "done", durationMs: 120_000, runId: "run-20260720-101112",
      },
      {
        taskId: "t2", shape: "implement", adapter: "pi", model: "zai/glm-5.2", channel: "sub",
        attempts: 2, outcome: "failed", durationMs: 240_000, overrun: true, gateFails: 1, runId: "run-20260721-101112",
      },
      {
        taskId: "t3", shape: "tests", adapter: "claude-code", model: "sonnet", channel: "sub",
        attempts: 1, outcome: "done", durationMs: 60_000, runId: "run-20260721-101112",
      },
    ],
  };
}

const VIEW_SRC = () => readFileSync(new URL("../../src/tui/views/fleet-view.ts", import.meta.url), "utf8");
const PROPS = { cols: 80, rows: 40 };

async function renderInStudio(
  view?: ReturnType<typeof createFleetView>,
  repoRoot?: string,
): Promise<string> {
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
  output.columns = PROPS.cols;
  output.rows = PROPS.rows;
  const writes: string[] = [];
  const write = output.write.bind(output);
  output.write = ((chunk: string | Uint8Array, ...args: unknown[]) => {
    writes.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
    return Reflect.apply(write, output, [chunk, ...args]) as boolean;
  }) as typeof output.write;

  const done = runStudioInk({
    input: input as unknown as NodeJS.ReadStream,
    output: output as unknown as NodeJS.WriteStream,
    views: view ? [view] : undefined,
    repoRoot,
    debug: true,
  });
  await new Promise((resolve) => setTimeout(resolve, 30));
  input.write("q");
  await done;
  return writes.join("\n").replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");
}

describe("fleet view — the harness roster", () => {
  test("the fleet view renders the discovered channel and seat substance the previous fleet view rendered", async () => {
    const repo = makeRepo({ "keep.txt": "x" });
    writeDoctor(repo, {
      codex: {
        installed: true,
        authed: true,
        version: "0.99.0",
        models: ["gpt-5.6-sol"],
        modelAuth: {
          "gpt-5.6-sol": { authed: true, probedAt: "2026-07-23T12:00:00.000Z" },
        },
      },
    });
    const text = await renderInStudio(undefined, repo);

    expect(text).toContain("Fleet view — harness roster");
    expect(text).toContain("codex");
    expect(text).toContain("gpt-5.6-sol");
    expect(text).toContain("[frontier]");
    expect(text).toContain("sub");
    expect(text).toContain("authed");
    expect(text).toContain("doctor cache:");
  });

  test("the roster shows adapters with models tier badges and auth state from the doctor cache", () => {
    const lines = createFleetView(fixture()).render(PROPS);
    const text = lines.join("\n");
    expect(text).toContain("claude-code");
    expect(text).toContain("pi");
    expect(text).toContain("fable");
    expect(text).toContain("sonnet");
    expect(text).toContain("zai/glm-5.2");
    // tier badges ride each model row
    expect(text).toContain("[frontier]");
    expect(text).toContain("[mid]");
    // auth state from the doctor cache, with the cache age on the header
    expect(text).toContain("2.1.205");
    expect(text).toContain("authed");
    expect(text).toContain("unauthed: probe timed out after 60000ms (2026-07-21)");
    expect(text).toContain("doctor cache: 12m old");
  });

  test("a denied channel renders its provenance note beside the denied marker", () => {
    const lines = createFleetView(fixture()).render(PROPS);
    const row = lines.find((l) => l.includes("zai/glm-5.2") && l.includes("denied"));
    expect(row).toBeDefined();
    expect(row!).toContain("✗ denied");
    expect(row!).toContain("OBS-57: hangs at finish without a trailer");
    // beside = after, on the same row
    expect(row!.indexOf("denied")).toBeLessThan(row!.indexOf("OBS-57"));

    // an adapter-level deny reaches every channel under it, carrying the ADAPTER's note: a channel
    // the router can never pick must never read as available on its own row
    const f = fixture();
    f.denyAdapters = ["claude-code"];
    f.notes = { ...f.notes, denyAdapters: { "claude-code": "OBS-12: quota exhausted until reset" } };
    const inherited = createFleetView(f).render(PROPS).find((l) => l.includes("fable"));
    expect(inherited).toBeDefined();
    expect(inherited!).toContain("✗ denied");
    expect(inherited!).toContain("OBS-12: quota exhausted until reset");
  });

  test("the detail panel shows the selected channel's health digest from recent journals", () => {
    const view = createFleetView(fixture());
    // rows: 0 claude-code header, 1 fable, 2 sonnet, 3 pi header, 4 zai/glm-5.2
    for (let i = 0; i < 4; i++) view.key("down");
    expect(view.selectedChannel()).toBe("pi:zai/glm-5.2");
    const text = view.render(PROPS).join("\n");
    expect(text).toContain("── pi:zai/glm-5.2 ──");
    expect(text).toContain("tier mid · sub · authed (probed 2026-07-21) · denied");
    expect(text).toContain(
      "journals: 2 tasks · 3 attempts · 1 done · 1 failed · median 3.0m · 1 gate-fails · 1 overrun · 0 quota failovers",
    );
    expect(text).toContain("last outcome: failed");

    // a channel with no journal rows says so rather than inventing zeroes, and an unauthed reading
    // already carries its probe date — the panel must not print the same day a second time
    const sonnet = createFleetView(fixture());
    sonnet.key("down");
    sonnet.key("down");
    expect(sonnet.selectedChannel()).toBe("claude-code:sonnet");
    const panel = sonnet.render(PROPS).join("\n");
    expect(panel).toContain("unauthed: probe timed out after 60000ms (2026-07-21) · enabled");
    expect(panel).not.toContain("(2026-07-21) (probed");

    // a channel with no journal rows says so rather than inventing a row of zeroes
    sonnet.key("up");
    expect(sonnet.selectedChannel()).toBe("claude-code:fable");
    expect(sonnet.render(PROPS).join("\n")).toContain("journals: no recent telemetry for this channel");
  });

  test("expand and collapse toggles an adapter's model rows", () => {
    const view = createFleetView(fixture());
    expect(view.expanded("claude-code")).toBe(true);
    expect(view.render(PROPS).join("\n")).toContain("fable");

    view.key("left"); // cursor starts on the claude-code header row
    expect(view.expanded("claude-code")).toBe(false);
    const collapsed = view.render(PROPS).join("\n");
    expect(collapsed).toContain("claude-code");
    expect(collapsed).not.toContain("fable");
    expect(collapsed).not.toContain("sonnet");

    view.key("right");
    expect(view.expanded("claude-code")).toBe(true);
    expect(view.render(PROPS).join("\n")).toContain("fable");

    // space toggles the same adapter off again
    view.key("space");
    expect(view.expanded("claude-code")).toBe(false);
    expect(view.render(PROPS).join("\n")).not.toContain("fable");
  });

  test("the view renders from injected fixture data with no filesystem access inside the render path", () => {
    // the fixture is plain in-memory data; rendering it must produce the full roster
    const text = createFleetView(fixture()).render(PROPS).join("\n");
    expect(text).toContain("Fleet view — harness roster");
    expect(text).toContain("zai/glm-5.2");
    // and the module itself can never reach the filesystem: no fs import of any form
    const src = VIEW_SRC();
    expect(src).not.toMatch(/from\s+["'](?:node:)?fs["']/);
    expect(src).not.toMatch(/require\(\s*["'](?:node:)?fs["']\s*\)/);
    expect(src).not.toMatch(/\b(readFileSync|writeFileSync|appendFileSync|existsSync|readdirSync|statSync)\b/);
  });

  test("the health digest derives from journal telemetry rather than any new state file", () => {
    // the fold consumes TelemetryRow-shaped journal rows directly and recomputes deterministically
    const digest = foldChannelHealth(fixture().telemetry);
    expect(foldChannelHealth(fixture().telemetry)).toEqual(digest);
    expect(digest.get("pi:zai/glm-5.2")).toEqual({
      key: "pi:zai/glm-5.2",
      tasks: 2,
      attempts: 3,
      done: 1,
      failed: 1,
      human: 0,
      overruns: 1,
      quotaFailovers: 0,
      gateFails: 1,
      medianDurationMs: 180_000,
      lastOutcome: "failed",
    });
    // the module's only telemetry source is the journal's TelemetryRow type — no state-file reads
    const src = VIEW_SRC();
    expect(src).toMatch(/import\s+type\s*\{[^}]*TelemetryRow[^}]*\}\s*from\s*["'][^"']*journal\.js["']/);
  });
});

// v1.67 T3: the write path. The roster stages deny/allow toggles and tier overrides into the
// shared FleetStaging buffer (never disk), renders the buffer's current state, and marks rows
// whose staged state differs from saved.
describe("fleet view — staged roster edits", () => {
  /** A staging model whose loaded state mirrors the injected fixture's saved state. */
  function stagedFixture(): { data: FleetViewData; staging: FleetStaging } {
    const data = fixture();
    const tiers: FleetEditable["tiers"] = {};
    for (const a of data.adapters) {
      tiers[a.adapter] = {};
      for (const m of a.models) tiers[a.adapter][m.model] = { tier: m.tier };
    }
    const staging = new FleetStaging({
      denyAdapters: [...data.denyAdapters],
      denyModels: [...data.denyModels],
      tiers,
      map: {},
      floors: {},
    });
    return { data, staging };
  }

  test("toggling deny on a channel stages the deny and renders the row as staged", () => {
    const { data, staging } = stagedFixture();
    const view = createFleetView(data, staging);

    view.toggleDenyChannel("claude-code:sonnet");

    // the edit landed in the staging buffer — the loaded (saved) state is untouched
    expect(staging.current.denyModels).toContain("claude-code:sonnet");
    expect(staging.loadedState.denyModels).not.toContain("claude-code:sonnet");
    expect(staging.isDirty).toBe(true);

    // the row renders the staged deny AND is visibly distinct from saved state
    const row = view.render(PROPS).find((l) => l.includes("sonnet"));
    expect(row).toBeDefined();
    expect(row!).toContain("✗ denied");
    expect(row!).toContain("● staged");
    // an untouched row carries no staged marker
    const fable = view.render(PROPS).find((l) => l.includes("fable"));
    expect(fable!).not.toContain("● staged");

    // toggling back stages the allow: identical to saved ⇒ the row is no longer staged
    view.toggleDenyChannel("claude-code:sonnet");
    expect(staging.current.denyModels).not.toContain("claude-code:sonnet");
    const unstage = view.render(PROPS).find((l) => l.includes("sonnet"));
    expect(unstage!).not.toContain("✗ denied");
    expect(unstage!).not.toContain("● staged");

    // the allow direction stages too: lifting pi's saved deny marks that row
    view.toggleDenyChannel("pi:zai/glm-5.2");
    expect(staging.current.denyModels).not.toContain("pi:zai/glm-5.2");
    const lifted = view.render(PROPS).find((l) => l.includes("zai/glm-5.2"));
    expect(lifted!).not.toContain("✗ denied");
    expect(lifted!).toContain("● staged");
  });

  test("a tier override stages into the buffer and renders marked", () => {
    const { data, staging } = stagedFixture();
    const view = createFleetView(data, staging);

    view.stageTierOverride("claude-code:sonnet", "frontier");

    // staged into the buffer; the loaded state still says mid
    expect(staging.current.tiers["claude-code"]?.["sonnet"]?.tier).toBe("frontier");
    expect(staging.loadedState.tiers["claude-code"]?.["sonnet"]?.tier).toBe("mid");

    // the badge renders the staged tier, marked as an unsaved edit
    const row = view.render(PROPS).find((l) => l.includes("sonnet"));
    expect(row!).toContain("[frontier]");
    expect(row!).not.toContain("[mid]");
    expect(row!).toContain("● staged");
    // untouched channels keep their saved tier with no marker
    const zai = view.render(PROPS).find((l) => l.includes("zai/glm-5.2"));
    expect(zai!).toContain("[mid]");
    expect(zai!).not.toContain("● staged");
  });

  test("a staged deny conflicting with a staged pin surfaces a conflict marker", () => {
    const { data, staging } = stagedFixture();
    const view = createFleetView(data, staging);

    // the routing view stages a pin on claude-code:fable for implement (same shared buffer)
    staging.apply((buffer) => {
      buffer.map.implement = { pin: { via: "claude-code", model: "fable" } };
    });
    // no conflict while the channel stays allowed
    expect(view.render(PROPS).find((l) => l.includes("fable"))!).not.toContain("conflict");

    // the fleet view stages a deny on that very channel — the staged pin now routes into a deny
    view.toggleDenyChannel("claude-code:fable");

    const row = view.render(PROPS).find((l) => l.includes("fable"))!;
    expect(row).toContain("✗ denied");
    expect(row).toContain("● staged");
    expect(row).toContain("! conflict: pinned for implement");
  });

  test("reverting the buffer restores the roster rendering to saved state", () => {
    const { data, staging } = stagedFixture();
    const view = createFleetView(data, staging);
    const savedRender = view.render(PROPS);

    view.toggleDenyChannel("claude-code:sonnet");
    view.stageTierOverride("claude-code:fable", "cheap");
    expect(view.render(PROPS).join("\n")).toContain("● staged");
    expect(view.render(PROPS)).not.toEqual(savedRender);

    staging.revert();

    expect(staging.isDirty).toBe(false);
    const restored = view.render(PROPS);
    expect(restored).toEqual(savedRender);
    expect(restored.join("\n")).not.toContain("● staged");
  });

  test("conflict detection reads both views' staged state from the shared staging model", () => {
    const { data, staging } = stagedFixture();
    // the fleet view attaches to the SAME staging model the routing view stages pins into
    const view = createFleetView(data, staging);

    // the saved state holds NEITHER side: no pin anywhere, and fable is not denied
    expect(staging.loadedState.map).toEqual({});
    expect(staging.loadedState.denyModels).not.toContain("claude-code:fable");
    expect(stagedConflicts(staging)).toEqual([]);

    // the fleet view stages its edit first, through the view's own seam: deny the channel —
    // with no staged pin in the shared model yet, detection still reads no conflict
    view.toggleDenyChannel("claude-code:fable");
    expect(staging.current.denyModels).toContain("claude-code:fable");
    expect(stagedConflicts(staging)).toEqual([]);

    // the routing view stages its edit into the same shared buffer: pin implement to that channel
    staging.apply((buffer) => {
      buffer.map.implement = { pin: { via: "claude-code", model: "fable" } };
    });

    // NOW the conflict reads — detection saw BOTH views' staged state in the one shared staging
    // model: the fleet side's staged deny and the routing side's staged pin
    expect(stagedConflicts(staging)).toEqual([{ channelKey: "claude-code:fable", shapes: ["implement"] }]);
    expect(view.render(PROPS).find((l) => l.includes("fable"))!).toContain("! conflict: pinned for implement");

    // a staged pin on an allowed channel adds no conflict — only deny ∩ pin counts
    staging.apply((buffer) => {
      buffer.map.tests = { pin: { via: "claude-code", model: "sonnet" } };
    });
    expect(stagedConflicts(staging)).toEqual([{ channelKey: "claude-code:fable", shapes: ["implement"] }]);
  });
});
