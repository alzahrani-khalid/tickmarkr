import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { CliEntrySchema, isNativeCliDrive, SHIPPED_CLI_CATALOG, type CliEntry, type DeclarativeCliDrive } from "../../src/adapters/catalog.js";
import * as registry from "../../src/adapters/registry.js";
import { classifyProbeReply, declarativeAdapter, formatDoctorReport, parseDeclaredModels, readDoctor } from "../../src/adapters/registry.js";
import { type WorkerAdapter } from "../../src/adapters/types.js";
import { doctor } from "../../src/cli/commands/doctor.js";
import { DEFAULT_CONFIG, loadConfig } from "../../src/config/config.js";
import * as git from "../../src/run/git.js";
import { makeTestTempDir } from "../helpers/tmprepo.js";

// PROBE-agy-v190.md records this banner and id<TAB>label shape. Label-only lines and
// padding below ensure no display word can be mistaken for an id, even when it passes MODEL_ID_RE.
const AGY_CAPTURE = [
  "Fetching available models...",
  "gemini-3.6-flash-low\tGemini 3.6 Flash Low",
  "claude-sonnet-4-6\tClaude Sonnet 4.6",
  "",
  "Claude",
  "gpt-oss-120b-medium\tGPT OSS 120B Medium",
].join("\n");
const CAPTURE_IDS = ["gemini-3.6-flash-low", "claude-sonnet-4-6", "gpt-oss-120b-medium"];

function entry(id: string): CliEntry & { drive: DeclarativeCliDrive } {
  const found = SHIPPED_CLI_CATALOG.find((candidate) => candidate.id === id)!;
  if (!found.drive || isNativeCliDrive(found.drive)) throw new Error(`expected declarative drive for ${id}`);
  return found as CliEntry & { drive: DeclarativeCliDrive };
}

const resolveBinary = (binary: string) => ({ resolved: `/fixture/${binary}`, all: [`/fixture/${binary}`] });
const reply = (stdout = "OK", code = 0, stderr = "") => ({ stdout, stderr, code });

function fixtureAdapter(adapter: WorkerAdapter, installed = true): WorkerAdapter {
  return {
    ...adapter,
    hardcodedFlags: undefined,
    trust: undefined,
    probe: async () => ({ installed, authed: installed, models: [] }),
    headlessCommand: () => "fixture-probe",
  };
}

function repoFor(id: string, models: string[]): string {
  const root = makeTestTempDir("gateway-");
  mkdirSync(join(root, ".tickmarkr"));
  const seedModels = DEFAULT_CONFIG.tiers[id]?.models ?? {};
  writeFileSync(join(root, ".tickmarkr", "config.yaml"), JSON.stringify({
    tiers: { [id]: { vendor: "mixed", channel: "sub", models: { ...Object.fromEntries(Object.keys(seedModels).map((m) => [m, null])), ...Object.fromEntries(models.map((m) => [m, "mid"])) } } },
  }));
  return root;
}

async function report(adapter: WorkerAdapter, models: string[]) {
  const root = repoFor(adapter.id, models);
  const output = await doctor(["--all"], root, [adapter], {
    banner: false, resolveOrcaBinary: () => undefined,
  });
  return { output, root, health: readDoctor(root)![adapter.id] };
}

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(registry, "detectCandidateClis").mockReturnValue([]);
  vi.spyOn(git, "sh").mockResolvedValue(reply());
});
afterEach(() => vi.restoreAllMocks());

test("test: closed table — the id-tab parser over agy's captured output (banner line, tab rows, a blank line, a label-only line) yields exactly the tab-row ids, so banner or label words admitted as ids fail", () => {
  expect(parseDeclaredModels(AGY_CAPTURE, "id-tab")).toEqual({ models: CAPTURE_IDS });
  for (const [raw, expected] of [
    ["Fetching available models...\nClaude\n\n", []],
    [`${AGY_CAPTURE}\nclaude-sonnet-4-6\tDuplicate label\textra column`, CAPTURE_IDS],
    ["\tNo id\nbad;id\tUnsafe\nanother/id\tLabel words", ["another/id"]],
  ] as const) {
    expect(parseDeclaredModels(raw, "id-tab").models, raw).toEqual(expected);
  }
  expect(CliEntrySchema.parse(entry("agy")).drive).toMatchObject({
    listModels: { argv: ["models"], parser: "id-tab", timeoutMs: 45000 },
  });
});

test("test: closed table — probe replies naming an unknown model id (grok's invalid params form, agy's offered-list form, a plain not found form) record cause unknown-model and doctor prints that the model is not served by the adapter, while a quota or auth reply keeps today's reason, so a raw tail for an unknown id fails", async () => {
  const model = "retired-model-with-an-id-longer-than-forty-characters";
  const cases = [
    { id: "grok", output: 'Invalid params: unknown model id', unknown: true },
    { id: "agy", output: `Error: Model '${model}' is not available. Available models:\n${"Claude Sonnet 4.6\nGemini Flash\n".repeat(20)}`, unknown: true },
    { id: "gateway", output: `Model '${model}' not found`, unknown: true },
    { id: "gateway", output: "quota exceeded; try again later", unknown: false },
    { id: "gateway", output: "authentication failed: please sign in", unknown: false },
  ];
  for (const row of cases) {
    const classified = classifyProbeReply(1, "", row.output);
    expect(classified, row.output).toEqual(row.unknown
      ? { authed: false, cause: "unknown-model", reason: "unknown model id" }
      : { authed: false, reason: row.output });
    vi.mocked(git.sh).mockResolvedValue(reply("", 1, row.output));
    const base = declarativeAdapter({ ...entry("agy"), id: row.id }, { resolveBinary, run: () => reply(AGY_CAPTURE) });
    const adapter = fixtureAdapter(base);
    const { output, health, root } = await report(adapter, [model]);
    expect(health.authed).toBe(true); // A bad model never signs the adapter out.
    expect(health.modelAuth?.[model]).toMatchObject(classified);
    const cached = formatDoctorReport(root, loadConfig(root), { [row.id]: health }, [adapter]);
    if (row.unknown) {
      for (const text of [output, cached]) expect(text).toContain(`${model} is not served by ${row.id}`);
      expect(health.modelAuth?.[model].reason).not.toContain("Claude Sonnet");
    } else {
      expect(health.modelAuth?.[model].cause).toBeUndefined();
      expect(output).toContain("unauthed:");
      expect(output).not.toContain("is not served by");
    }
  }
  for (const output of ["Model 'old' is unserved", "Model old is unavailable", "Model old does not exist"]) {
    expect(classifyProbeReply(1, output, "").cause, output).toBe("unknown-model");
  }
  expect(classifyProbeReply(0, "OK", "")).toEqual({ authed: true });
  expect(classifyProbeReply(1, "unknown model id", "", true)).toEqual({ authed: false, reason: "probe timed out after 60000ms" });
});

test("test: closed table — a succeeded listing that differs from the configured ids prints both drift counts with names, a failed or timed-out or missing listing prints listing unavailable with no drift line, a declarative surface's succeeded empty listing reports zero offered and a native adapter's empty array infers nothing, while agy no longer prints the seeds-stamped line, so drift inferred from a failed listing or silent drift fails", async () => {
  const configured = Array.from({ length: 7 }, (_, i) => `gone-${i}`);
  const offered = Array.from({ length: 7 }, (_, i) => `new-${i}`);
  const cases = [
    { name: "succeeded", run: () => reply(offered.map((m) => `${m}\tLabel`).join("\n")), available: true, count: 7 },
    { name: "failed", run: () => reply(AGY_CAPTURE, 1), available: false },
    { name: "timed out", run: () => reply(AGY_CAPTURE, 1, "timed out"), available: false },
    { name: "missing binary", run: () => { throw new Error("must not run"); }, missing: true, available: false },
    { name: "thrown listing", run: () => { throw new Error("spawn failed"); }, available: false },
    { name: "succeeded empty", run: () => reply(""), available: true, count: 0 },
    { name: "missing adapter", run: () => { throw new Error("must not run"); }, absent: true, available: false },
  ];
  for (const row of cases) {
    const base = declarativeAdapter(entry("agy"), {
      resolveBinary: row.missing ? () => ({ all: [] }) : resolveBinary, run: row.run,
    });
    const adapter = fixtureAdapter(base, !row.absent);
    const { output, health } = await report(adapter, configured);
    expect(output, row.name).not.toContain("agy: no model-list surface");
    expect(output, row.name).not.toContain("seeds stamped");
    if (row.available) {
      expect(health.modelListing?.status, row.name).toBe("succeeded");
      expect(output, row.name).toContain(`agy: model listing — ${row.count} offered; configured-not-offered: 7 (gone-0, gone-1, gone-2, gone-3, gone-4, +2 more)`);
      expect(output, row.name).toContain(row.count
        ? "agy: offered-not-configured: 7 (new-0, new-1, new-2, new-3, new-4, +2 more)"
        : "agy: offered-not-configured: 0");
      expect(health.modelsDetectedAt, row.name).toBeDefined();
    } else {
      expect(health.modelListing?.status, row.name).toBe("unavailable");
      expect(output, row.name).toContain("agy: model listing unavailable");
      expect(output, row.name).not.toContain("configured-not-offered");
      expect(output, row.name).not.toContain("offered-not-configured");
      expect(output, row.name).not.toContain("CLI no longer reports");
      expect(health.models, row.name).toEqual([]);
      expect(health.modelsDetectedAt, row.name).toBeUndefined();
    }
  }
  for (const id of ["opencode", "pi", "kimi"]) {
    const native = SHIPPED_CLI_CATALOG.find((candidate) => candidate.id === id)!;
    if (!isNativeCliDrive(native.drive)) throw new Error(`expected native adapter ${id}`);
    const adapter = { ...fixtureAdapter(native.drive.adapter), listModels: async () => [] };
    const { output, health } = await report(adapter, ["gone"]);
    expect(output, id).toContain(`${id}: model listing unavailable`);
    expect(output, id).not.toContain("configured-not-offered");
    expect(output, id).not.toContain("offered-not-configured");
    expect(health.modelsDetectedAt, id).toBeUndefined();
    const succeeded = await report({ ...adapter, listModels: async () => ["gone", "new-native"] }, ["gone"]);
    expect(succeeded.output, id).toContain(`${id}: model listing — 2 offered; configured-not-offered: 0`);
    expect(succeeded.output, id).toContain(`${id}: offered-not-configured: 1 (new-native)`);
  }
});

test("test: the production agy listing runs with its 45 second budget through an injected runner while another declarative adapter keeps the 15 second default, so an agy listing killed at 15 seconds fails", async () => {
  const cwd = makeTestTempDir("gateway-listing-");
  vi.spyOn(process, "cwd").mockReturnValue(cwd);
  const run = vi.fn((_cmd: string, _cwd: string, timeoutMs = 0) => timeoutMs > 15800 ? reply(AGY_CAPTURE) : reply("", 1));
  const agy = declarativeAdapter(entry("agy"), { resolveBinary, run });
  expect(await agy.listModels!()).toEqual(CAPTURE_IDS);
  expect(run).toHaveBeenLastCalledWith("'/fixture/agy' 'models'", cwd, 45000);
  const ompRun = vi.fn(() => reply('{"models":[{"selector":"vendor/model"}]}'));
  const omp = declarativeAdapter(entry("omp"), { resolveBinary, run: ompRun });
  expect(await omp.listModels!()).toEqual(["vendor/model"]);
  expect(ompRun).toHaveBeenLastCalledWith("'/fixture/omp' 'models' 'ls' '--json'", cwd, 15000);
});
