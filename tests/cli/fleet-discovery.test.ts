import { mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { expect, test, vi } from "vitest";
import { parse } from "yaml";

import { fleetUnclassifiedModels, modelLints, suggestOverlay } from "../../src/adapters/model-lints.js";
import * as registry from "../../src/adapters/registry.js";
import { MODEL_ID_RE, type AuthHealth, type WorkerAdapter } from "../../src/adapters/types.js";
import { assembleFleetEditor, fleet, type FleetIO } from "../../src/cli/commands/fleet.js";
import { readCachedCatalog } from "../../src/adapters/catalog-remote.js";
import {
  DEFAULT_CONFIG,
  TierEntrySchema,
  fleetRepoOverlayFromDelta,
  loadConfig,
  repoOverlayYaml,
  type FleetEditable,
} from "../../src/config/config.js";
import {
  runFleetInkEditor,
  type FleetEditorState,
  type FleetModelGroup,
} from "../../src/tui/ink/fleet-app.js";
import { tickmarkrDir } from "../../src/graph/graph.js";
import { makeRepo } from "../helpers/tmprepo.js";

const KEYS = {
  enter: "\r",
  escape: "\x1b",
  backspace: "\x7f",
  down: "\x1b[B",
  left: "\x1b[D",
  q: "q",
  t: "t",
  n: "n",
  w: "w",
  y: "y",
} as const;

// browser rail: All models · Shapes · Steering · one row per adapter — scoping the single
// adapter is ← (rail) + ↓×3 + Enter, the precondition for the n (add-model) hotkey
const SCOPE_FIRST_ADAPTER = KEYS.left + KEYS.down.repeat(3) + KEYS.enter;

const editable = (over: Partial<FleetEditable> = {}): FleetEditable => ({
  denyAdapters: [],
  denyModels: [],
  tiers: {},
  map: {},
  floors: {},
  ...over,
});

const installed = (models: string[], modelsDetectedAt?: string): AuthHealth => ({
  installed: true,
  authed: true,
  models,
  ...(modelsDetectedAt ? { modelsDetectedAt } : {}),
});

const declaredAdapter = (id = "nova"): WorkerAdapter => ({
  id,
  vendor: "declared-vendor",
  probe: async () => ({ installed: true, authed: true, models: [] }),
  channels: () => [],
  headlessCommand: () => "nova",
  interactiveCommand: () => null,
  invoke: () => ({ command: "nova" }),
  parse: () => ({ ok: false, summary: "unused", deviations: [], raw: "" }),
  listModels: async () => [],
});

type TestInput = PassThrough & {
  isTTY: boolean;
  setRawMode: (mode: boolean) => void;
  ref: () => TestInput;
  unref: () => TestInput;
};

function terminal() {
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
    if (token === undefined) {
      pumping = false;
      return;
    }
    directWrite(token);
    setImmediate(pump);
  };
  input.write = ((chunk: string | Uint8Array) => {
    const text = typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    pending.push(...(text.match(/\x1b\[[0-9;]*[A-Za-z~]|[\s\S]/g) ?? []));
    if (!pumping) {
      pumping = true;
      setImmediate(pump);
    }
    return true;
  }) as typeof input.write;

  const writes: string[] = [];
  const output = {
    isTTY: true,
    columns: 120,
    rows: 60,
    write(chunk: string) {
      if (chunk && writes.at(-1) !== chunk) writes.push(chunk);
      return true;
    },
    on() { return output; },
    off() { return output; },
    removeListener() { return output; },
  };
  return { input, output: output as unknown as NodeJS.WriteStream, writes };
}

const stripAnsi = (text: string) => text.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");

async function driveInk(
  modelGroups: FleetModelGroup[],
  bytes: string,
  overrides: Partial<Parameters<typeof runFleetInkEditor>[0]> = {},
) {
  const io = terminal();
  const adapter = declaredAdapter(modelGroups[0]?.adapter ?? "nova");
  const health: Record<string, AuthHealth> = {
    [adapter.id]: { installed: true, authed: true, version: "1.0", models: [] },
  };
  let reviewed: FleetEditorState | undefined;
  const modePreview = vi.fn(() => ["COST PREVIEW COMPUTED"]);
  const done = runFleetInkEditor({
    ageMs: 0,
    adapters: [adapter],
    health,
    initialDenyAdapters: [],
    initialDenyModels: [],
    modelGroups,
    initialMode: "risk-based",
    modeOptions: [{ id: "risk-based", gloss: "risk-tiered" }],
    initialMap: {},
    modePreview,
    shapeRows: () => [],
    candidatesForShape: () => ({ rows: [] }),
    preferOptionsForShape: () => [],
    initialSteering: {},
    steeringOptionsFor: () => [],
    reviewOverlay: (state) => {
      reviewed = structuredClone(state);
      return { kind: "empty" };
    },
    reloadGuard: () => null,
    input: io.input as unknown as NodeJS.ReadStream,
    output: io.output,
    debug: true,
    ...overrides,
  });
  io.input.write(bytes);
  const result = await done;
  return { ...io, result, reviewed, modePreview };
}

test("test: classifying a model for an adapter with no default tier seed writes a fragment that reloads, proven over the closed set of first-touch shapes — a no-seed fixture, a seed-without-windows fixture, a seed-with-windows fixture, and a seed-carrying-an-unknown-entry-key fixture whose unknown subtree is asserted DEEP-EQUAL across the YAML serialize-and-reread boundary this task owns, so retaining the key while nulling or emptying its nested value fails, and whose loss through the SCHEMA boundary is asserted as the known and unchanged behaviour rather than as a defect this task fixes — and the pre-fix fragment fails schema validation on both vendor and channel", () => {
  const preFix = TierEntrySchema.safeParse({ models: { "nova-1": "mid" } });
  expect(preFix.success).toBe(false);
  expect(preFix.error?.issues.map((issue) => issue.path.join("."))).toEqual(
    expect.arrayContaining(["vendor", "channel"]),
  );

  const unknown = { nested: { keep: [1, { exact: "bytes-to-data" }], enabled: false } };
  const fixtures: Array<[string, Record<string, unknown>]> = [
    ["no seed", {}],
    ["seed without windows", {
      tiers: { nova: { vendor: "declared-vendor", channel: "sub", models: {} } },
    }],
    ["seed with windows", {
      tiers: { nova: { vendor: "declared-vendor", channel: "sub", windows: { "nova-1": 64_000 }, models: {} } },
    }],
    ["seed with an unknown entry key", {
      tiers: { nova: { vendor: "declared-vendor", channel: "sub", future: unknown, models: {} } },
    }],
  ];
  const initial = editable();
  const edited = editable({ tiers: { nova: { "nova-1": { tier: "mid" } } } });
  const build = fleetRepoOverlayFromDelta as unknown as (
    initial: FleetEditable,
    edited: FleetEditable,
    existing: Record<string, unknown>,
    firstTouch: Record<string, { vendor: string; channel: "sub" | "api" }>,
  ) => Record<string, unknown>;

  for (const [name, existing] of fixtures) {
    const fragment = build(initial, edited, existing, {
      nova: { vendor: "declared-vendor", channel: "sub" },
    });
    const yaml = repoOverlayYaml(fragment);
    const reread = parse(yaml);
    expect(reread.tiers.nova.vendor, name).toBe("declared-vendor");
    expect(reread.tiers.nova.channel, name).toBe("sub");
    expect(reread.tiers.nova.models["nova-1"], name).toBe("mid");

    const repo = makeRepo({ "keep.txt": "x" });
    const globalDir = mkdtempSync(join(tmpdir(), "tickmarkr-t16-global-"));
    mkdirSync(join(repo, ".tickmarkr"), { recursive: true });
    writeFileSync(join(repo, ".tickmarkr", "config.yaml"), yaml);
    expect(loadConfig(repo, { globalDir }).tiers.nova.models["nova-1"], name).toBe("mid");

    if (name === "seed with an unknown entry key") {
      expect(reread.tiers.nova.future).toEqual(unknown);
      const schemaValue = TierEntrySchema.parse(reread.tiers.nova) as Record<string, unknown>;
      expect(schemaValue).not.toHaveProperty("future");
    }
  }
});

test("test: an installed adapter with detected models and no tiers block contributes untiered rows to the fleet models list, and no row carries a tier the operator did not choose", () => {
  const cfg = structuredClone(DEFAULT_CONFIG);
  const adapter = declaredAdapter();
  const health = {
    nova: {
      installed: true,
      authed: true,
      models: ["nova-1", "nova-2"],
      modelsDetectedAt: "2026-08-05T12:00:00.000Z",
    },
  };

  const rows = fleetUnclassifiedModels(cfg, health, [adapter]);
  expect(rows).toEqual([
    { adapter: "nova", model: "nova-1", detectedAt: "2026-08-05" },
    { adapter: "nova", model: "nova-2", detectedAt: "2026-08-05" },
  ]);
  for (const row of rows) expect(row).not.toHaveProperty("tier");
  expect(modelLints(cfg, health, [adapter])).toContain(
    "nova: reports 2 model(s) not in tiers (nova-1, nova-2) — classify before routing (benchmark policy)",
  );
  expect(suggestOverlay(cfg, health, [adapter])).toContain("# nova-1: ???");
});

test("test: a cursor-agent list carrying claude-fable-5-1 only as low medium high xhigh and max variants yields one unclassified row naming the base with its variants and a classify of it writes claude-fable-5-1-max and says so while a base the CLI lists bare is written bare and two configured ids are never collapsed whereas a filter that drops every variant fails", async () => {
  const variants = ["low", "medium", "high", "xhigh", "max"].map((effort) => `claude-fable-5-1-${effort}`);
  const config = structuredClone(DEFAULT_CONFIG);
  config.tiers["cursor-agent"] = { vendor: "anthropic", channel: "sub", models: {} };
  const adapter = declaredAdapter("cursor-agent");
  const variantHealth = { "cursor-agent": installed(variants, "2026-09-03T12:00:00.000Z") };
  const collapsed = fleetUnclassifiedModels(config, variantHealth, [adapter]);

  expect(collapsed).toEqual([{
    adapter: "cursor-agent",
    model: "claude-fable-5-1",
    detectedAt: "2026-09-03",
    variants,
    classifyModel: "claude-fable-5-1-max",
  }]);
  expect(variants.filter((model) => !/-(low|medium|high|xhigh|max)$/.test(model))).toEqual([]);

  const classifiedVariant = await driveInk(
    [{ adapter: "cursor-agent", vendor: "declared-vendor", channel: "sub", rows: collapsed }],
    KEYS.t + KEYS.enter + KEYS.enter + "LiveBench max effort" + KEYS.enter + KEYS.w,
  );
  expect(stripAnsi(classifiedVariant.writes.join(""))).toContain("writes claude-fable-5-1-max");
  expect(stripAnsi(classifiedVariant.writes.join(""))).not.toContain("cursor-agent/claude-fable-5-1-max");
  expect(classifiedVariant.reviewed?.classifications[0].model).toBe("claude-fable-5-1-max");

  const withBare = fleetUnclassifiedModels(config, {
    "cursor-agent": installed([variants[0], "claude-fable-5-1", variants[4]], "2026-09-03T12:00:00.000Z"),
  }, [adapter]);
  expect(withBare).toEqual([{
    adapter: "cursor-agent",
    model: "claude-fable-5-1",
    detectedAt: "2026-09-03",
    variants: [variants[0], variants[4]],
  }]);
  const classifiedBare = await driveInk(
    [{ adapter: "cursor-agent", vendor: "declared-vendor", channel: "sub", rows: withBare }],
    KEYS.t + KEYS.enter + KEYS.enter + "LiveBench bare" + KEYS.enter + KEYS.w,
  );
  expect(classifiedBare.reviewed?.classifications[0].model).toBe("claude-fable-5-1");

  const configured = await driveInk([{
    adapter: "cursor-agent",
    rows: [
      { model: variants[0], tier: "cheap" },
      { model: variants[4], tier: "frontier" },
    ],
  }], KEYS.q);
  const configuredFrame = stripAnsi(configured.writes[0] ?? "");
  expect(configuredFrame).toContain(variants[0]);
  expect(configuredFrame).toContain(variants[4]);
});

test("test: three omp ids resolving to one models.dev model fold under the first-listed id with a times-three count and the hidden-count line names folds apart from retired hides while unclassified rows order by suggestion present then detectedAt then score then id whereas a screen that renders the sensor's raw order fails", async () => {
  const repo = makeRepo({ "keep.txt": "x" });
  mkdirSync(join(repo, ".tickmarkr"), { recursive: true });
  writeFileSync(join(repo, ".tickmarkr", "config.yaml"), `tiers:
  omp:
    vendor: anthropic
    channel: api
    models:
      google/gemini-3.8-flash: null
      zai/glm-5.3: null
      alibaba/qwen3.8-max: null
`);
  const gatewayIds = ["gateway-z/same-model", "gateway-a/same-model", "gateway-m/same-model"];
  registry.writeDoctor(repo, {
    omp: installed(gatewayIds, "2026-09-03T12:00:00.000Z"),
  });
  writeFileSync(join(repo, ".tickmarkr", "catalog-cache.json"), JSON.stringify({
    schemaVersion: 1,
    fetchedAt: "2026-09-03T00:00:00.000Z",
    modelsDev: {
      anthropic: {
        id: "anthropic",
        models: {
          "same-model": { id: "same-model", cost: { input: 1, output: 4 }, limit: { context: 200_000 } },
        },
      },
    },
  }));
  const assembled = await assembleFleetEditor(repo, [declaredAdapter("omp")], {}, {
    globalDir: mkdtempSync(join(tmpdir(), "tickmarkr-fold-global-")),
    catalog: readCachedCatalog(repo, { now: () => new Date("2026-09-03T12:00:00.000Z") }),
  });
  if ("unavailable" in assembled) throw new Error(assembled.unavailable);
  const folded = assembled.props.modelGroups[0].rows;
  expect(folded).toHaveLength(1);
  expect(folded[0]).toMatchObject({ model: gatewayIds[0], foldedModels: gatewayIds });

  const screen = await driveInk([{
    adapter: "omp",
    rows: [
      { model: "raw-first-no-suggestion", detectedAt: "2026-09-04", score: 999 },
      { model: "z-score-low-newer", detectedAt: "2026-09-03", score: 10, suggestion: { tier: "mid", note: "new" }, foldedModels: gatewayIds },
      { model: "a-score-high-older", detectedAt: "2026-09-02", score: 90, suggestion: { tier: "frontier", note: "high" } },
      { model: "b-score-low-older", detectedAt: "2026-09-02", score: 20, suggestion: { tier: "cheap", note: "low" } },
      { model: "retired-embedding", detectedAt: "2026-09-05" },
    ],
  }], KEYS.q);
  const frame = stripAnsi(screen.writes[0] ?? "");
  expect(frame.indexOf("z-score-low-newer")).toBeLessThan(frame.indexOf("a-score-high-older"));
  expect(frame.indexOf("a-score-high-older")).toBeLessThan(frame.indexOf("b-score-low-older"));
  expect(frame.indexOf("b-score-low-older")).toBeLessThan(frame.indexOf("raw-first-no-suggestion"));
  expect(frame).toContain("×3");
  expect(frame).toContain("2 same-model gateway ids folded");
  expect(frame).toContain("1 retired/preview/non-worker hidden");
});

test("test: the channel a first classification needs is asked rather than inferred, and no cost preview is computed from a channel the operator did not answer", async () => {
  // t on the unclassified row opens the classify overlay at its channel stage (adapter
  // first-touch); Esc cancels the flow, q quits — no Enter-walk exists in the browser.
  const run = await driveInk(
    [{ adapter: "nova", rows: [{ model: "nova-1", detectedAt: "2026-08-05" }] }],
    KEYS.t + KEYS.escape + KEYS.q,
  );
  const rendered = stripAnsi(run.writes.join(""));
  expect(rendered).toContain("classify · nova:nova-1");
  expect(rendered).toContain("how is this CLI billed?");
  expect(rendered).toContain("sub");
  expect(rendered).toContain("api");
  expect(run.modePreview).not.toHaveBeenCalled();
  expect(run.reviewed).toBeUndefined();
});

test("test: a free-text model id is accepted only when it matches the id pattern and is routed through the same classify path as a detected model", async () => {
  expect(MODEL_ID_RE.test("bad model")).toBe(false);
  expect(MODEL_ID_RE.test("custom/model-1")).toBe(true);
  // channel Enter (sub) → tier Enter (cheap) → typed provenance note → w funnels the staged
  // classification into reviewOverlay (the injected stub returns "empty", ending the app)
  const finishClassification = KEYS.enter + KEYS.enter + "manual evidence" + KEYS.enter + KEYS.w;
  const manual = await driveInk(
    [{ adapter: "nova", rows: [] }],
    SCOPE_FIRST_ADAPTER + KEYS.n + "bad model" + KEYS.enter
      + KEYS.backspace.repeat("bad model".length) + "custom/model-1" + KEYS.enter
      + finishClassification,
  );
  const detected = await driveInk(
    [{ adapter: "nova", rows: [{ model: "detected-model" }] }],
    KEYS.t + finishClassification,
  );

  expect(stripAnsi(manual.writes.join(""))).toContain("model id must match");
  expect(manual.reviewed?.classifications).toHaveLength(1);
  expect(detected.reviewed?.classifications).toHaveLength(1);
  expect({ ...manual.reviewed!.classifications[0], model: "same-model" }).toEqual({
    ...detected.reviewed!.classifications[0],
    model: "same-model",
  });
});

test("test: the two new screens are titled by name and no frame in this task carries a step number, proven over the closed set of new screens — a channel-ask fixture and an add-model fixture", async () => {
  const channel = await driveInk(
    [{ adapter: "nova", rows: [{ model: "nova-1" }] }],
    KEYS.t + KEYS.escape + KEYS.q,
  );
  const addModel = await driveInk(
    [{ adapter: "nova", rows: [] }],
    SCOPE_FIRST_ADAPTER + KEYS.n + KEYS.escape + KEYS.q,
  );
  const closedSet = [
    ["classify · nova:nova-1", channel.writes],
    ["add model · nova", addModel.writes],
  ] as const;
  for (const [title, writes] of closedSet) {
    const frames = writes.map(stripAnsi).filter((frame) => frame.includes(title));
    expect(frames.length, title).toBeGreaterThan(0);
    for (const frame of frames) expect(frame, title).not.toMatch(/\bstep \d/);
  }
});

test("no classification the operator made is lost between the keystroke and the reloaded config", async () => {
  const repo = makeRepo({ "keep.txt": "x" });
  const globalDir = mkdtempSync(join(tmpdir(), "tickmarkr-t16-global-"));
  const adapter = declaredAdapter();
  registry.writeDoctor(repo, {
    nova: {
      installed: true,
      authed: true,
      version: "1.0",
      models: ["nova-1"],
      modelsDetectedAt: "2026-08-05T12:00:00.000Z",
    },
  });
  const now = new Date();
  utimesSync(join(tickmarkrDir(repo), "doctor.json"), now, now);
  const io = terminal();
  const result = fleet(
    ["--global-dir", globalDir],
    repo,
    [adapter],
    { input: io.input, output: io.output } as FleetIO,
  );
  // t → classify: channel ↓Enter (api) · tier ↓Enter (mid) · typed provenance note ·
  // then w opens the real review diff and y confirms the guarded write.
  io.input.write(
    KEYS.t + KEYS.down + KEYS.enter + KEYS.down + KEYS.enter
      + "AA Index 54" + KEYS.enter + KEYS.w + KEYS.y,
  );
  expect(await result).toMatch(/^fleet: wrote /);

  const written = readFileSync(join(repo, ".tickmarkr", "config.yaml"), "utf8");
  const parsed = parse(written);
  expect(parsed.tiers?.nova).toMatchObject({
    vendor: "declared-vendor",
    channel: "api",
    models: { "nova-1": "mid" },
  });
  expect(loadConfig(repo, { globalDir }).tiers.nova).toMatchObject({
    vendor: "declared-vendor",
    channel: "api",
    models: { "nova-1": "mid" },
  });
});
