import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, expect, test, vi } from "vitest";
import { FakeAdapter } from "../../src/adapters/fake.js";
import { doctorAgeMs, initDoctorReuse, readDoctor, writeDoctor } from "../../src/adapters/registry.js";
import { channelsFromConfig, type AuthHealth } from "../../src/adapters/types.js";
import { doctor, doctorProbePreflight, probeScope } from "../../src/cli/commands/doctor.js";
import { fleet, type FleetIO } from "../../src/cli/commands/fleet.js";
import { commandHelp } from "../../src/cli/help.js";
import { DEFAULT_CONFIG, loadConfig } from "../../src/config/config.js";

const roots: string[] = [];
const old = "2020-01-02T03:04:05.000Z";
const root = () => {
  const path = mkdtempSync(join(tmpdir(), "doctor-scope-"));
  roots.push(path);
  return path;
};
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function fixture() {
  const repo = root();
  const globalDir = root();
  vi.stubEnv("XDG_CONFIG_HOME", globalDir);
  const state = join(repo, ".tickmarkr");
  mkdirSync(state);
  const cfg = structuredClone(DEFAULT_CONFIG);
  cfg.tiers = {
    fake: { vendor: "fake-a", channel: "sub", models: { "fake-1": "mid", "fake-2": "cheap" } },
    other: { vendor: "other", channel: "sub", models: { "other-1": "mid", "other-2": "cheap" } },
    kimi: { vendor: "moonshot", channel: "sub", models: { "kimi-code/k3": "mid", "kimi-code/other": "cheap" } },
  };
  cfg.judge = { adapter: "fake", model: "fake-1" };
  cfg.consult = { adapter: "fake", model: "fake-1", stallMinutes: 15, prefer: ["fake:fake-1"] };
  const save = () => writeFileSync(join(state, "config.yaml"), JSON.stringify({ ...cfg,
    tiers: { ...Object.fromEntries(Object.keys(DEFAULT_CONFIG.tiers).map((id) => [id, null])), ...Object.fromEntries(Object.entries(cfg.tiers).map(([id, tier]) => [id, { ...tier,
      models: { ...Object.fromEntries(Object.keys(DEFAULT_CONFIG.tiers[id]?.models ?? {}).map((m) => [m, null])), ...tier.models },
    }])) },
  }));
  save();
  const adapters = ["fake", "other", "kimi"].map((id) => {
    const script = join(repo, `${id}.json`);
    writeFileSync(script, JSON.stringify({ tasks: {} }));
    const adapter = new FakeAdapter(script);
    adapter.id = id;
    const call = adapter.headlessCommand.bind(adapter);
    vi.spyOn(adapter, "headlessCommand").mockImplementation((prompt, model) => call(prompt, model));
    return adapter;
  });
  const health: Record<string, AuthHealth> = Object.fromEntries(Object.entries(cfg.tiers).map(([id, tier]) => [id, {
    installed: true, authed: true, models: Object.keys(tier.models), version: `cached-${id}`,
    modelAuth: Object.fromEntries(Object.keys(tier.models).map((model) => [model, { authed: false, reason: `cached ${model}`, probedAt: old }])),
  }]));
  writeDoctor(repo, health);
  const path = join(state, "doctor.json");
  const stale = new Date(old);
  utimesSync(path, stale, stale);
  vi.spyOn(console, "error").mockImplementation(() => {});
  return { repo, globalDir, cfg, save, adapters, health, path };
}
const calls = (adapters: FakeAdapter[]) => adapters.flatMap((adapter) => vi.mocked(adapter.headlessCommand).mock.calls.map(([, model]) => `${adapter.id}:${model}`)).sort();
const runDoctor = (f: ReturnType<typeof fixture>, args: string[], extra = {}) => doctor(args, f.repo, f.adapters, { banner: false, resolveOrcaBinary: () => undefined, ...extra });

function aliasFixture(adapter = "claude-code", model = "opus") {
  const f = fixture();
  f.cfg.tiers = {
    fake: { ...f.cfg.tiers.fake, models: { "fake-1": "mid" } },
    [adapter]: { vendor: "anthropic", channel: "sub", models: { [model]: "frontier" } },
  };
  f.cfg.review.prefer = [];
  f.save();
  const alias = f.adapters[1];
  alias.id = adapter;
  vi.spyOn(alias, "probe").mockResolvedValue({ installed: true, authed: true, models: [] });
  vi.spyOn(alias, "channels").mockImplementation((cfg) => channelsFromConfig(adapter, cfg));
  vi.mocked(alias.headlessCommand).mockImplementation(() => "printf OK");
  f.adapters = [f.adapters[0], alias];
  f.health = {
    fake: { installed: true, authed: true, models: ["fake-1"], modelAuth: {
      "fake-1": { authed: true, probedAt: new Date().toISOString() },
    } },
    [adapter]: { installed: true, authed: true, models: [model], modelAuth: {
      [model]: { authed: true, probedAt: old },
    } },
  };
  writeDoctor(f.repo, f.health);
  return { ...f, alias };
}

test("plain doctor discloses, probes and resolves an unknown opus alias whose observed identity admits it past a family deny", async () => {
  const f = aliasFixture();
  f.cfg.routing.deny = { models: ["claude-code:claude-opus-5"] };
  f.save();
  delete f.health["claude-code"];
  writeDoctor(f.repo, f.health);
  const resolveIdentity = vi.fn(() => "claude-opus-5-5");

  expect.soft(probeScope(f.cfg)).toContainEqual({ adapter: "claude-code", model: "opus" });
  expect.soft(await runDoctor(f, ["--probe-preflight"])).toContain("scope: 2 models — claude-code:opus, fake:fake-1");
  await runDoctor(f, [], { resolveClaudeAliasIdentity: resolveIdentity });

  expect.soft(f.alias.headlessCommand).toHaveBeenCalledTimes(1);
  expect.soft(resolveIdentity).toHaveBeenCalledExactlyOnceWith(f.repo, "opus");
  expect.soft(readDoctor(f.repo)!["claude-code"].modelAuth?.opus).toMatchObject({ authed: true, identity: "claude-opus-5-5" });
});

test("recorded routable opus identities keep init reuse and fleet pick stale and the fleet consent count includes their old verdict", async () => {
  for (const policy of ["allow", "deny"] as const) {
    for (const storage of ["modelAuth", "modelIdentities"] as const) {
      const f = aliasFixture();
      f.cfg.routing[policy] = { models: [policy === "allow" ? "claude-code:claude-opus-5-5" : "claude-code:claude-opus-5"] };
      f.save();
      if (storage === "modelAuth") f.health["claude-code"].modelAuth!.opus.identity = "claude-opus-5-5";
      else f.health["claude-code"].modelIdentities = { opus: "claude-opus-5-5" };
      writeDoctor(f.repo, f.health); // fresh mtime must not hide this routable model's old probe
      const context = `${policy}: ${storage}`;

      expect.soft(doctorAgeMs(f.repo, f.cfg), context).toBeGreaterThan(60 * 60_000);
      expect.soft(initDoctorReuse(f.repo, false, f.cfg).reuse, context).toBe(false);
      expect.soft(await fleet(["--pick", "consult", "--global-dir", f.globalDir], f.repo, f.adapters), context)
        .toMatchObject({ code: 1, out: expect.stringContaining("stale") });
      expect.soft(await runDoctor(f, ["--probe-preflight"]), context).toContain("scope: 2 models — claude-code:opus, fake:fake-1");

      const before = readFileSync(f.path, "utf8");
      const input = Object.assign(new PassThrough(), { isTTY: true, setRawMode: vi.fn() });
      const writes: string[] = [];
      const probe = vi.fn(async () => "unused");
      const editor = vi.fn(async () => ({ kind: "quit" as const }));
      try {
        await fleet(["--global-dir", f.globalDir], f.repo, f.adapters, {
          input, output: { isTTY: true, write: (s) => {
            writes.push(s);
            if (s.includes("[p] probe now")) queueMicrotask(() => input.write("q"));
          } }, doctor: probe, runEditor: editor,
        });
        expect.soft(writes.join(""), context).toContain("2 configured models in default scope");
        expect.soft(probe, context).not.toHaveBeenCalled();
        expect.soft(editor, context).not.toHaveBeenCalled();
        expect.soft(readFileSync(f.path, "utf8"), context).toBe(before);
      } finally {
        input.destroy();
      }
    }
  }
});

// D-2178 add.137: one test per row — the 24 rows ran serial doctor rounds in ONE test (12–17.5 s of the 20 s budget
// locally) and timed out in public CI under suite load.
const reachabilityRows = [
    { policy: { deny: { models: ["old"] } }, identity: "new", included: true },
    { policy: { deny: { models: ["new"] } }, identity: "new", included: false },
    { policy: { allow: { models: ["new"] } }, identity: "new", included: true },
    { policy: { allow: { models: ["old"] } }, identity: "new", included: false },
    { policy: { deny: { models: ["old"] } }, identity: undefined, included: true },
    { policy: { allow: { models: ["new"] } }, identity: undefined, included: true },
    { policy: { deny: { adapters: ["adapter"] } }, identity: undefined, included: false },
    { policy: { deny: { models: ["alias"] } }, identity: undefined, included: false },
    { policy: { allow: { models: ["unrelated"] } }, identity: undefined, included: false },
    { policy: { allow: { models: ["new"] }, deny: { models: ["new"] } }, identity: "new", included: false },
    { policy: { allow: { models: ["new"] }, deny: { models: ["old"] } }, identity: undefined, included: true },
    { policy: { allow: { models: ["old"] }, deny: { models: ["old"] } }, identity: undefined, included: false },
];
const reachabilityCases = (["claude-code:opus", "gateway:orbit"] as const).flatMap((pair) => {
  const [adapter, model] = pair.split(":");
  return reachabilityRows.map((row, index) => [`${adapter} row ${index}`, { adapter, model, row, index }] as const);
});

test.each(reachabilityCases)("default probe reachability follows observed or unresolved identities across alias families, policy lists and routing map entries — %s", async (_label, { adapter, model, row, index }) => {
  const f = aliasFixture(adapter, model);
  const identities: Record<string, string> = {
    old: `${adapter}:vendor-${model}-5`, new: `${adapter}:vendor-${model}-5-5`,
    adapter, alias: `${adapter}:${model}`, unrelated: `${adapter}:different-5`,
  };
  Object.assign(f.cfg.routing, JSON.parse(JSON.stringify(row.policy), (_key, value) => identities[value] ?? value));
  f.cfg.routing.map = {
    plan: { pin: { via: adapter, model } },
    implement: { prefer: [`${adapter}:${model}`] },
    tests: { pool: { mode: "any", channels: [`${adapter}:${model}`] } },
  };
  f.save();
  const identity = row.identity ? identities[row.identity].slice(adapter.length + 1) : undefined;
  if (index % 2 && identity) f.health[adapter].modelIdentities = { [model]: identity };
  else if (identity) f.health[adapter].modelAuth![model].identity = identity;
  writeDoctor(f.repo, f.health);
  const context = `${adapter}: ${JSON.stringify(row)}`;
  const resolveIdentity = vi.fn(() => identity ?? `vendor-${model}-5-5`);

  expect.soft(initDoctorReuse(f.repo, false, f.cfg).reuse, context).toBe(!row.included);
  expect.soft(await runDoctor(f, ["--probe-preflight"]), context).toContain(`scope: ${row.included ? 2 : 1} model`);
  await runDoctor(f, [], { resolveClaudeAliasIdentity: resolveIdentity });

  expect.soft(calls(f.adapters), context).toEqual(["fake:fake-1", ...(row.included ? [`${adapter}:${model}`] : [])].sort());
  expect.soft(resolveIdentity, context).toHaveBeenCalledTimes(adapter === "claude-code" && row.included ? 1 : 0);
  const verdict = readDoctor(f.repo)![adapter].modelAuth?.[model];
  if (row.included) expect.soft(verdict?.probedAt, context).not.toBe(old);
  else expect.soft(verdict, context).toEqual(f.health[adapter].modelAuth![model]);
});

test("test: closed table — a stale cache in a TTY prompts with the configured model count and each answer does what it names (probe runs the injected doctor once; cached opens the editor with no doctor call; quit exits with no write and no call), and a non-TTY plain run refuses as today, and fleet help names the stale-cache probe beside the fresh flag, so a probe that runs unasked fails", async () => {
  for (const answer of ["p", "c", "q", "non-TTY"] as const) {
    const f = fixture();
    const before = readFileSync(f.path, "utf8");
    const input = Object.assign(new PassThrough(), { isTTY: answer !== "non-TTY", setRawMode: vi.fn() });
    const writes: string[] = [];
    const probe = vi.fn(async () => {
      const now = new Date().toISOString();
      writeDoctor(f.repo, Object.fromEntries(Object.entries(f.health).map(([id, h]) => [id, { ...h,
        modelAuth: Object.fromEntries(h.models.map((m) => [m, { authed: true, probedAt: now }])),
      }])));
      return "injected probe";
    });
    const editor = vi.fn(async () => ({ kind: "quit" as const }));
    const result = await fleet(["--global-dir", f.globalDir], f.repo, f.adapters, {
      input, output: { isTTY: answer !== "non-TTY", write: (s) => {
        writes.push(s);
        if (s.includes("[p] probe now")) queueMicrotask(() => input.write(answer));
      } }, doctor: probe, runEditor: editor,
    });
    if (answer === "non-TTY") {
      expect(result).toEqual({ code: 1, out: expect.stringContaining("requires a TTY") });
      expect(writes).toEqual([]);
    } else {
      expect(writes.join("")).toContain("6 configured models in default scope");
      expect(writes.join("")).toContain("[c] open with cached verdicts");
      expect(writes.join("")).toContain("[q] quit");
      expect(result).toBe("fleet: quit without writing");
    }
    expect(probe).toHaveBeenCalledTimes(answer === "p" ? 1 : 0);
    expect(editor).toHaveBeenCalledTimes(answer === "p" || answer === "c" ? 1 : 0);
    if (answer !== "p") expect(readFileSync(f.path, "utf8")).toBe(before);
    expect(calls(f.adapters)).toEqual([]);
    input.destroy();
  }
  const help = commandHelp("fleet");
  expect(help).toContain("plain TTY run asks before probing models when the cache is stale");
  expect(help).toMatch(/--fresh[^\n]*stale-cache probe/);
});

test("test: doctor with an adapter scope probes only that adapter's models through the fake adapter and the written doctor.json keeps every other adapter's verdicts and probedAt byte-identical, so a wholesale replacement fails", async () => {
  const f = fixture();
  await runDoctor(f, ["--adapter", "fake"]);
  expect(calls(f.adapters)).toEqual(["fake:fake-1", "fake:fake-2"]);
  const after = readDoctor(f.repo)!;
  for (const id of ["other", "kimi"]) expect(JSON.stringify(after[id])).toBe(JSON.stringify(f.health[id]));
  expect(after.fake.modelAuth!["fake-1"].authed).toBe(true);
  expect(after.fake.modelAuth!["fake-2"].probedAt).not.toBe(old);
});

test("doctor --adapter other reports the installed cached judge and consult without false NOT installed warnings", async () => {
  const f = fixture();
  f.health.fake.modelAuth!["fake-1"].authed = true;
  writeDoctor(f.repo, f.health);
  const cached = JSON.stringify(readDoctor(f.repo)!.fake);

  const out = await runDoctor(f, ["--adapter", "other"]);

  expect(JSON.stringify(readDoctor(f.repo)!.fake)).toBe(cached);
  expect(calls(f.adapters)).toEqual(["other:other-1", "other:other-2"]);
  for (const role of ["judge", "consult"]) {
    expect.soft(out).not.toContain(`${role} runs on fake:fake-1 — NOT installed; that gate will fail closed`);
  }
});

test("scoped doctor role warnings follow merged installed, unavailable and absent verdicts across adapter and model selections", async () => {
  const selections = [
    ["--adapter", "other"],
    ["--model", "other:other-1"],
    ["--model", "other:other-1", "--model", "other:other-2"],
  ];
  const verdicts = [
    { judge: true, consult: true, registered: true },
    { judge: false, consult: true, registered: true },
    { judge: true, consult: false, registered: true },
    { judge: undefined, consult: undefined, registered: true },
    { judge: true, consult: true, registered: false },
  ];
  for (const args of selections) {
    for (const row of verdicts) {
      const f = fixture();
      f.cfg.consult = { adapter: "kimi", model: "kimi-code/other", stallMinutes: 15 };
      f.save();
      for (const [role, id] of [["judge", "fake"], ["consult", "kimi"]] as const) {
        if (row[role] === undefined) delete f.health[id];
        else f.health[id].installed = row[role];
      }
      if (!row.registered) f.adapters = f.adapters.filter((a) => a.id === "other");
      writeDoctor(f.repo, f.health);
      const prior = readDoctor(f.repo)!;

      const out = await runDoctor(f, args);

      const after = readDoctor(f.repo)!;
      const context = `${args.join(" ")}: ${JSON.stringify(row)}`;
      for (const [role, id, model] of [["judge", "fake", "fake-1"], ["consult", "kimi", "kimi-code/other"]] as const) {
        expect.soft(JSON.stringify(after[id]), context).toBe(JSON.stringify(prior[id]));
        const warning = `${role} runs on ${id}:${model} — NOT installed; that gate will fail closed`;
        expect.soft(out.includes(warning), context).toBe(row[role] !== true);
      }
      const expected = args[0] === "--adapter" || args.length > 2 ? ["other:other-1", "other:other-2"] : ["other:other-1"];
      expect.soft(calls(f.adapters), context).toEqual(expected);
    }
  }
});

test("test: doctor with a model scope probes exactly that model, even when routing denies it, keeps its sibling models' verdicts and times, and leaves the cache age of every untouched adapter as old as before, so a partial refresh that freshens the whole cache fails", async () => {
  const f = fixture();
  f.cfg.routing.deny = { models: ["fake:fake-2"] };
  f.save();
  const before = initDoctorReuse(f.repo, false, f.cfg).ageMs!;
  await runDoctor(f, ["--model", "fake:fake-2"]);
  expect(calls(f.adapters)).toEqual(["fake:fake-2"]);
  const after = readDoctor(f.repo)!;
  expect(JSON.stringify(after.fake.modelAuth!["fake-1"])).toBe(JSON.stringify(f.health.fake.modelAuth!["fake-1"]));
  expect(after.fake.modelAuth!["fake-2"].authed).toBe(true);
  for (const id of ["other", "kimi"]) {
    expect(JSON.stringify(after[id])).toBe(JSON.stringify(f.health[id]));
    const scopedCfg = { ...f.cfg, tiers: { [id]: f.cfg.tiers[id] } };
    expect(doctorAgeMs(f.repo, scopedCfg)).toBeGreaterThanOrEqual(before);
  }
  expect(initDoctorReuse(f.repo, false, f.cfg)).toMatchObject({ reuse: false, health: null });
  expect(initDoctorReuse(f.repo, false, f.cfg).ageMs).toBeGreaterThanOrEqual(before);
  expect(await fleet(["--pick", "consult", "--global-dir", f.globalDir], f.repo, f.adapters)).toMatchObject({ code: 1, out: expect.stringContaining("stale") });
});

test("test: kimi's separate turn runs when kimi-code/k3 is in scope and not for a denied kimi, another adapter's selection or a model-only selection of another kimi model, so a probe that still pays for the fixed model out of scope fails", async () => {
  const table = [
    { args: [], deny: false, expected: 1 },
    { args: [], deny: true, expected: 0 },
    { args: ["--adapter", "fake"], deny: false, expected: 0 },
    { args: ["--model", "kimi:kimi-code/other"], deny: false, expected: 0 },
    { args: ["--adapter", "kimi"], deny: true, expected: 1 },
    { args: ["--all"], deny: true, expected: 1 },
  ];
  for (const row of table) {
    const f = fixture();
    if (row.deny) f.cfg.routing.deny = { adapters: ["kimi"] };
    f.save();
    const turn = vi.fn(async () => ({ ok: true, evidence: "fixed model OK" }));
    await runDoctor(f, row.args, { kimiTurnProbe: turn });
    expect(turn).toHaveBeenCalledTimes(row.expected);
    if (row.deny && !row.args.length) expect(calls(f.adapters).some((c) => c.startsWith("kimi:"))).toBe(false);
  }
});

test("test: a default probe skips a denied adapter's models and a model outside routing.allow, still probes a review preference that routing would not pick, and the all flag probes every configured model, so a probe of unreachable channels by default fails", async () => {
  const f = fixture();
  f.cfg.routing.deny = { adapters: ["kimi"] };
  f.cfg.routing.allow = { models: ["fake:fake-1"] };
  f.cfg.review.prefer = ["other:other-2"];
  f.save();
  const cfg = loadConfig(f.repo);
  expect(probeScope(cfg)).toEqual([{ adapter: "fake", model: "fake-1" }, { adapter: "other", model: "other-2" }]);
  const disclosure = doctorProbePreflight(f.repo, cfg, f.adapters);
  expect(disclosure).toContain("scope: 2 models — fake:fake-1, other:other-2");
  expect(disclosure).toContain("routing-reachable channels plus review, consult and judge preferences");
  await runDoctor(f, []);
  expect(calls(f.adapters)).toEqual(["fake:fake-1", "other:other-2"]);
  for (const adapter of f.adapters) vi.mocked(adapter.headlessCommand).mockClear();
  await runDoctor(f, ["--all"]);
  expect(calls(f.adapters)).toEqual(["fake:fake-1", "fake:fake-2", "kimi:kimi-code/k3", "kimi:kimi-code/other", "other:other-1", "other:other-2"]);
  for (const adapter of f.adapters) vi.mocked(adapter.headlessCommand).mockClear();
  await runDoctor(f, ["--adapter", "other", "--model", "fake:fake-2", "--model", "fake:fake-2"]);
  expect(calls(f.adapters)).toEqual(["fake:fake-2", "other:other-1", "other:other-2"]);
});

test("worker-only model denies keep role-reachable verdicts stale until a default doctor refresh actually probes them", async () => {
  const f = fixture();
  f.cfg.tiers = {
    fake: { ...f.cfg.tiers.fake, models: { "fake-1": "mid" } },
    other: { ...f.cfg.tiers.other, models: { "other-1": "mid" } },
  };
  f.cfg.review.prefer = undefined;
  f.cfg.routing.deny = { workers: { models: ["other:other-1"] } };
  f.adapters = f.adapters.filter((a) => a.id !== "kimi");
  f.save();
  f.health.other.modelAuth!["other-1"].authed = true;
  writeDoctor(f.repo, f.health);

  // Refresh only the worker channel. The old other verdict still belongs to the
  // review/judge/consult pools, despite the report's newly written file mtime.
  await runDoctor(f, ["--model", "fake:fake-1"]);
  expect.soft(doctorAgeMs(f.repo, f.cfg)).toBeGreaterThan(60 * 60_000);
  expect.soft(initDoctorReuse(f.repo, false, f.cfg).reuse).toBe(false);
  expect.soft(await fleet(["--pick", "consult", "--global-dir", f.globalDir], f.repo, f.adapters))
    .toMatchObject({ code: 1, out: expect.stringContaining("stale") });
  const beforeConsent = readFileSync(f.path, "utf8");
  const input = Object.assign(new PassThrough(), { isTTY: true, setRawMode: vi.fn() });
  const writes: string[] = [];
  const probe = vi.fn(async () => "unused");
  const editor = vi.fn(async () => ({ kind: "quit" as const }));
  try {
    await fleet(["--global-dir", f.globalDir], f.repo, f.adapters, {
      input, output: { isTTY: true, write: (s) => {
        writes.push(s);
        if (s.includes("[p] probe now")) queueMicrotask(() => input.write("q"));
      } }, doctor: probe, runEditor: editor,
    });
    expect.soft(writes.join("")).toContain("2 configured models in default scope");
    expect.soft(probe).not.toHaveBeenCalled();
    expect.soft(editor).not.toHaveBeenCalled();
    expect.soft(readFileSync(f.path, "utf8")).toBe(beforeConsent);
  } finally {
    input.destroy();
  }
  for (const adapter of f.adapters) vi.mocked(adapter.headlessCommand).mockClear();

  await runDoctor(f, []);

  expect.soft(calls(f.adapters)).toEqual(["fake:fake-1", "other:other-1"]);
  const verdict = readDoctor(f.repo)!.other.modelAuth!["other-1"];
  expect.soft(verdict.authed).toBe(true);
  expect.soft(verdict.probedAt).not.toBe(old);
  expect(initDoctorReuse(f.repo, false, f.cfg).reuse).toBe(true);
  expect(doctorAgeMs(f.repo, f.cfg)).toBeLessThan(60_000);
});

test("default doctor scope covers any routable role across worker denies, global exclusions and allowlists", async () => {
  const all = ["fake:fake-1", "fake:fake-2", "kimi:kimi-code/k3", "kimi:kimi-code/other", "other:other-1", "other:other-2"];
  const rows: { deny: NonNullable<typeof DEFAULT_CONFIG.routing.deny>; allow?: typeof DEFAULT_CONFIG.routing.allow; expected: string[] }[] = [
    { deny: { workers: { adapters: ["other", "kimi"] } }, expected: all },
    { deny: { workers: { models: ["other-1", "kimi:kimi-code/k3"] } }, expected: all },
    { deny: { workers: { adapters: ["other", "kimi"] }, models: ["other:other-2", "kimi:kimi-code/k3"] },
      expected: ["fake:fake-1", "fake:fake-2", "kimi:kimi-code/other", "other:other-1"] },
    { deny: { workers: { adapters: ["other", "kimi"] } }, allow: { adapters: ["fake", "kimi"] },
      expected: ["fake:fake-1", "fake:fake-2", "kimi:kimi-code/k3", "kimi:kimi-code/other"] },
    { deny: { workers: { models: ["other:other-1", "kimi:kimi-code/k3"] } },
      allow: { models: ["fake:fake-1", "other:other-1", "kimi:kimi-code/k3"] },
      expected: ["fake:fake-1", "kimi:kimi-code/k3", "other:other-1"] },
    { deny: { adapters: ["other", "kimi"] }, expected: ["fake:fake-1", "fake:fake-2"] },
  ];
  for (const row of rows) {
    const f = fixture();
    f.cfg.routing.deny = row.deny;
    f.cfg.routing.allow = row.allow;
    f.cfg.review.prefer = undefined;
    f.save();
    const context = JSON.stringify(row);
    const preflight = await runDoctor(f, ["--probe-preflight"]);
    expect.soft(preflight, context).toContain(`scope: ${row.expected.length} models`);
    for (const key of row.expected) expect.soft(preflight, context).toContain(key);
    const turn = vi.fn(async () => ({ ok: true, evidence: "fixed model OK" }));

    await runDoctor(f, [], { kimiTurnProbe: turn });

    expect.soft(calls(f.adapters), context).toEqual(row.expected);
    expect.soft(turn, context).toHaveBeenCalledTimes(row.expected.includes("kimi:kimi-code/k3") ? 1 : 0);
    const after = readDoctor(f.repo)!;
    for (const key of row.expected) {
      const [adapter, model] = key.split(":");
      expect.soft(after[adapter].modelAuth![model], `${context}: ${key}`).toMatchObject({ authed: true });
      expect.soft(after[adapter].modelAuth![model].probedAt, `${context}: ${key}`).not.toBe(old);
    }
    expect.soft(initDoctorReuse(f.repo, false, f.cfg).reuse, context).toBe(true);
    expect.soft(doctorAgeMs(f.repo, f.cfg), context).toBeLessThan(60_000);
  }
});

test("cache reuse uses the oldest existing default-scope verdict with file-age fallback for legacy or unprobed adapters", () => {
  const f = fixture();
  const now = new Date().toISOString();
  const freshHealth = structuredClone(f.health);
  for (const h of Object.values(freshHealth)) for (const verdict of Object.values(h.modelAuth!)) verdict.probedAt = now;
  freshHealth.kimi.modelAuth!["kimi-code/k3"].probedAt = old;
  writeDoctor(f.repo, freshHealth);
  expect(initDoctorReuse(f.repo, false, f.cfg).reuse).toBe(false);
  f.cfg.routing.deny = { adapters: ["kimi"] };
  expect(initDoctorReuse(f.repo, false, f.cfg).reuse).toBe(true);
  delete freshHealth.other.modelAuth;
  writeDoctor(f.repo, freshHealth);
  const stale = new Date(old);
  utimesSync(f.path, stale, stale);
  expect(initDoctorReuse(f.repo, false, f.cfg).reuse).toBe(false);
  freshHealth.other.modelAuth = { "other-1": { authed: true } as never };
  writeDoctor(f.repo, freshHealth);
  utimesSync(f.path, stale, stale);
  expect(initDoctorReuse(f.repo, false, f.cfg).reuse).toBe(false);
});

test("a full doctor refresh clears an unavailable adapter's unrefreshable history so init can reuse the cache and fleet can pick consult", async () => {
  const f = fixture();
  vi.spyOn(f.adapters[1], "probe").mockResolvedValue({ installed: false, authed: false, models: [] });

  await runDoctor(f, []);

  expect(initDoctorReuse(f.repo, false, f.cfg).reuse).toBe(true);
  expect(doctorAgeMs(f.repo, f.cfg)).toBeLessThan(60_000);
  expect(JSON.parse(await fleet(["--pick", "consult", "--global-dir", f.globalDir], f.repo, f.adapters) as string))
    .toMatchObject({ role: "consult", adapter: "fake", model: "fake-1" });
  expect(calls(f.adapters)).not.toContain("other:other-1");
});

test("two full doctor refreshes after Kimi credential failure let init reuse the cache and fleet pick consult", async () => {
  const f = fixture();
  for (const verdict of Object.values(f.health.kimi.modelAuth!)) verdict.authed = true;
  writeDoctor(f.repo, f.health);
  utimesSync(f.path, new Date(old), new Date(old));
  vi.spyOn(f.adapters[2], "probe").mockResolvedValue({ installed: true, authed: false, models: [], note: "no valid credentials" });
  const turn = vi.fn(async () => ({ ok: true, evidence: "unused" }));

  for (const round of [1, 2]) {
    await runDoctor(f, [], { kimiTurnProbe: turn });

    expect(initDoctorReuse(f.repo, false, f.cfg).reuse, `round ${round}`).toBe(true);
    expect(doctorAgeMs(f.repo, f.cfg)).toBeLessThan(60_000);
    expect(JSON.parse(await fleet(["--pick", "consult", "--global-dir", f.globalDir], f.repo, f.adapters) as string))
      .toMatchObject({ role: "consult", adapter: "fake", model: "fake-1" });
    expect(readDoctor(f.repo)!.kimi).toMatchObject({ installed: true, authed: false });
    expect(Object.keys(readDoctor(f.repo)!.kimi.modelAuth ?? {})).toEqual([]);
  }
  expect(turn).not.toHaveBeenCalled();
  expect(calls(f.adapters).some((c) => c.startsWith("kimi:"))).toBe(false);
});

test("skipped Kimi model sweeps release in-scope history across default, all, adapter and model refreshes while preserving untouched cache ages", async () => {
  const selections = [
    { args: [], selected: ["kimi-code/k3", "kimi-code/other"] },
    { args: ["--all"], selected: ["kimi-code/k3", "kimi-code/other"] },
    { args: ["--adapter", "kimi"], selected: ["kimi-code/k3", "kimi-code/other"] },
    { args: ["--model", "kimi:kimi-code/k3"], selected: ["kimi-code/k3"] },
    { args: ["--adapter", "fake"], selected: [] },
  ];
  for (const failure of ["credentials", "turn", "unregistered"] as const) {
    for (const { args, selected } of selections) {
      const f = fixture();
      for (const [id, h] of Object.entries(f.health)) {
        for (const verdict of Object.values(h.modelAuth!)) {
          verdict.authed = true;
          if (id !== "kimi") verdict.probedAt = new Date().toISOString();
        }
      }
      writeDoctor(f.repo, f.health);
      utimesSync(f.path, new Date(old), new Date(old));
      vi.spyOn(f.adapters[2], "probe").mockResolvedValue({ installed: true, authed: failure !== "credentials", models: [], note: failure });
      if (failure === "unregistered") f.adapters = f.adapters.filter((a) => a.id !== "kimi");
      const turn = vi.fn(async () => ({ ok: false, evidence: "earned-green turn failed" }));

      await runDoctor(f, args, { kimiTurnProbe: turn });

      const context = `${failure}: ${args.join(" ") || "default"}`;
      const reusable = selected.length === 2;
      expect(initDoctorReuse(f.repo, false, f.cfg).reuse, context).toBe(reusable);
      const pick = await fleet(["--pick", "consult", "--global-dir", f.globalDir], f.repo, f.adapters);
      if (reusable) {
        expect(doctorAgeMs(f.repo, f.cfg), context).toBeLessThan(60_000);
        expect(JSON.parse(pick as string), context).toMatchObject({ adapter: "fake", model: "fake-1" });
      } else {
        expect(doctorAgeMs(f.repo, f.cfg), context).toBeGreaterThan(60 * 60_000);
        expect(pick, context).toMatchObject({ code: 1, out: expect.stringContaining("stale") });
      }
      const after = readDoctor(f.repo)!;
      for (const model of ["kimi-code/k3", "kimi-code/other"]) {
        if (selected.includes(model)) expect(after.kimi?.modelAuth?.[model], context).toBeUndefined();
        else expect(JSON.stringify(after.kimi?.modelAuth?.[model]), context).toBe(JSON.stringify(f.health.kimi.modelAuth![model]));
      }
      if (!selected.length) expect(JSON.stringify(after.kimi), context).toBe(JSON.stringify(f.health.kimi));
      expect(turn, context).toHaveBeenCalledTimes(failure === "turn" && selected.length ? 1 : 0);
      expect(calls(f.adapters).some((c) => c.startsWith("kimi:")), context).toBe(false);
    }
  }
});

test("unavailable adapters release only the selected history across full, adapter and model refreshes while untouched verdicts still control reuse", async () => {
  const selections = [
    { args: [], selected: ["other-1", "other-2"] },
    { args: ["--all"], selected: ["other-1", "other-2"] },
    { args: ["--adapter", "other"], selected: ["other-1", "other-2"] },
    { args: ["--model", "other:other-1"], selected: ["other-1"] },
    { args: ["--adapter", "fake"], selected: [] },
  ];
  for (const note of ["not installed", "--version crashed (exit 139)"]) {
    for (const { args, selected } of selections) {
      const f = fixture();
      // All other channels are fresh; any retained old verdict belongs to this adapter.
      for (const [id, h] of Object.entries(f.health)) {
        for (const verdict of Object.values(h.modelAuth!)) {
          verdict.authed = true;
          if (id !== "other") verdict.probedAt = new Date().toISOString();
        }
      }
      writeDoctor(f.repo, f.health);
      utimesSync(f.path, new Date(old), new Date(old));
      vi.spyOn(f.adapters[1], "probe").mockResolvedValue({ installed: false, authed: false, models: [], note });

      await runDoctor(f, args);

      const context = `${note}: ${args.join(" ") || "default"}`;
      const reusable = selected.length === 2;
      expect(initDoctorReuse(f.repo, false, f.cfg).reuse, context).toBe(reusable);
      const pick = await fleet(["--pick", "consult", "--global-dir", f.globalDir], f.repo, f.adapters);
      if (reusable) expect(JSON.parse(pick as string), context).toMatchObject({ adapter: "fake", model: "fake-1" });
      else expect(pick, context).toMatchObject({ code: 1, out: expect.stringContaining("stale") });
      const after = readDoctor(f.repo)!;
      for (const model of ["other-1", "other-2"]) {
        if (selected.includes(model)) expect(after.other.modelAuth?.[model], context).toBeUndefined();
        else expect(after.other.modelAuth?.[model], context).toEqual(f.health.other.modelAuth![model]);
      }
      if (!selected.length) expect(JSON.stringify(after.other), context).toBe(JSON.stringify(f.health.other));
      expect(calls(f.adapters).some((c) => c.startsWith("other:")), context).toBe(false);
    }
  }
});

test("fleet opens the recorded verdicts after a consented or fresh probe even when untouched channels remain stale", async () => {
  for (const args of [[], ["--fresh"]]) {
    const f = fixture();
    vi.spyOn(f.adapters[1], "probe").mockResolvedValue({ installed: false, authed: false, models: [] });
    const input = Object.assign(new PassThrough(), { isTTY: true, setRawMode: vi.fn() });
    const writes: string[] = [];
    // Exercise a real scoped doctor run: unselected cached channels remain old, but
    // consenting to a completed probe still permits opening its recorded results.
    const probe = vi.fn<typeof doctor>((argv, cwd, adapters, opts) => doctor([...argv, "--model", "fake:fake-1"], cwd, adapters,
      { ...opts, resolveOrcaBinary: () => undefined }));
    const editor = vi.fn<NonNullable<FleetIO["runEditor"]>>(async () => ({ kind: "quit" as const }));
    try {
      const result = await fleet([...args, "--global-dir", f.globalDir], f.repo, [f.adapters[0], f.adapters[1]], {
        input, output: { isTTY: true, write: (s) => {
          writes.push(s);
          if (s.includes("[p] probe now")) queueMicrotask(() => input.write("p"));
        } }, doctor: probe, runEditor: editor,
      });

      expect(result).toBe("fleet: quit without writing");
      expect(probe).toHaveBeenCalledTimes(1);
      expect(editor).toHaveBeenCalledTimes(1);
      expect(initDoctorReuse(f.repo, false, f.cfg).reuse).toBe(false);
      expect(editor.mock.calls[0][0].health.kimi).toEqual(f.health.kimi);
      expect(writes.join("").includes("[p] probe now")).toBe(!args.length);
    } finally {
      input.destroy();
    }
  }
});
