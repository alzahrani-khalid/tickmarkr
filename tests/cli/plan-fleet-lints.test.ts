import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { writeDoctor } from "../../src/adapters/registry.js";
import { channelsFromConfig, type WorkerAdapter } from "../../src/adapters/types.js";
import { compile } from "../../src/cli/commands/compile.js";
import { doctor } from "../../src/cli/commands/doctor.js";
import { plan } from "../../src/cli/commands/plan.js";
import { resume } from "../../src/cli/commands/resume.js";
import { saveGraph } from "../../src/graph/graph.js";
import { validateGraph } from "../../src/graph/schema.js";
import { authedModels, makeRepo } from "../helpers/tmprepo.js";

// The pair text is byte-pinned by tests/fixtures/brand-surfaces/plan-lints.txt (a fixture this task does not
// own), so the two lints are separated by their own texts and repairs rather than by rewording that one.
const ZERO_CHANNEL_LINT = "review: review.required is set but no channel can route — the fleet is empty; install or authenticate an adapter";
const CROSS_VENDOR_PAIR_LINT = "review: no cross-vendor reviewer pair in fleet — set review.required: false to waive";

const NO_CHANNELS_DOCTOR = {
  "claude-code": { installed: false, authed: false, models: [] },
  codex: { installed: false, authed: false, models: [] },
  "cursor-agent": { installed: false, authed: false, models: [] },
  opencode: { installed: false, authed: false, models: [] },
  pi: { installed: false, authed: false, models: [] },
};

const SINGLE_VENDOR_DOCTOR = {
  ...NO_CHANNELS_DOCTOR,
  "claude-code": {
    installed: true,
    authed: true,
    models: [],
    modelAuth: authedModels(["fable", "opus", "sonnet", "haiku"]),
  },
};

function repoWithDoctor(health: Parameters<typeof writeDoctor>[1]): string {
  const repo = makeRepo({ "keep.txt": "x\n" });
  saveGraph(repo, validateGraph({
    version: 1,
    spec: { source: "prd", paths: ["p"], hash: "h" },
    tasks: [{ id: "T1", title: "t", goal: "g", shape: "chore", complexity: 2, acceptance: ["a"] }],
  }));
  writeDoctor(repo, health);
  return repo;
}

describe("plan review fleet lints", () => {
  test("test: with review.required and zero discovered channels, plan lints that no channel can route instead of staying silent", async () => {
    const out = await plan([], repoWithDoctor(NO_CHANNELS_DOCTOR));

    expect(out).toContain(ZERO_CHANNEL_LINT);
    expect(out).not.toContain(CROSS_VENDOR_PAIR_LINT);
  });

  test("test: with review.required and a non-empty single-vendor fleet, the cross-vendor pair lint still fires and the zero-channel lint does not", async () => {
    const out = await plan([], repoWithDoctor(SINGLE_VENDOR_DOCTOR));

    expect(out).toContain(CROSS_VENDOR_PAIR_LINT);
    expect(out).not.toContain(ZERO_CHANNEL_LINT);
  });

  test("test: the zero-channel lint and the pair lint are distinct texts, each naming its own repair", async () => {
    const zeroChannelOut = await plan([], repoWithDoctor(NO_CHANNELS_DOCTOR));
    const singleVendorOut = await plan([], repoWithDoctor(SINGLE_VENDOR_DOCTOR));

    expect(ZERO_CHANNEL_LINT).not.toBe(CROSS_VENDOR_PAIR_LINT);
    // an empty fleet is repaired by making ANY channel routable — never by naming a vendor pair it cannot have
    expect(zeroChannelOut).toContain(ZERO_CHANNEL_LINT);
    expect(ZERO_CHANNEL_LINT).toContain("install or authenticate an adapter");
    expect(zeroChannelOut).not.toContain("cross-vendor reviewer pair");
    // a single-vendor fleet is repaired at the vendor dimension, or waived — never by installing anything
    expect(singleVendorOut).toContain(CROSS_VENDOR_PAIR_LINT);
    expect(CROSS_VENDOR_PAIR_LINT).toContain("set review.required: false to waive");
    expect(singleVendorOut).not.toContain("install or authenticate an adapter");
  });

  test("test: with review.required and differently stamped channels that both resolve to OpenAI, the cross-vendor pair lint fires", async () => {
    const codexAdapter: WorkerAdapter = {
      id: "codex",
      channels: () => [
        { adapter: "codex", model: "gpt-6-astra", vendor: "openai", channel: "sub", tier: "frontier" },
      ],
      async probe() {
        return {
          installed: true, authed: true, version: "fake",
          models: ["gpt-6-astra"],
          modelAuth: authedModels(["gpt-6-astra"]),
        };
      },
      async runWorker() { return { ok: true, summary: "ok" }; },
    };

    const ompAdapter: WorkerAdapter = {
      id: "omp",
      channels: () => [
        { adapter: "omp", model: "openai-codex/gpt-5.6-sol", vendor: "mixed", channel: "sub", tier: "frontier" },
      ],
      async probe() {
        return {
          installed: true, authed: true, version: "fake",
          models: ["openai-codex/gpt-5.6-sol"],
          modelAuth: authedModels(["openai-codex/gpt-5.6-sol"]),
        };
      },
      async runWorker() { return { ok: true, summary: "ok" }; },
    };

    const repo = repoWithDoctor({
      codex: await codexAdapter.probe(),
      omp: await ompAdapter.probe(),
    });
    const out = await plan([], repo, [codexAdapter, ompAdapter]);

    expect(out).toContain(CROSS_VENDOR_PAIR_LINT);
    expect(out).not.toContain(ZERO_CHANNEL_LINT);

    // with a third channel resolving to a different provider, the pair lint does not fire
    const ompDiverseAdapter: WorkerAdapter = {
      ...ompAdapter,
      channels: () => [
        { adapter: "omp", model: "openai-codex/gpt-5.6-sol", vendor: "mixed", channel: "sub", tier: "frontier" },
        { adapter: "omp", model: "zai/glm-5.3", vendor: "mixed", channel: "sub", tier: "frontier" },
      ],
      async probe() {
        return {
          installed: true, authed: true, version: "fake",
          models: ["openai-codex/gpt-5.6-sol", "zai/glm-5.3"],
          modelAuth: authedModels(["openai-codex/gpt-5.6-sol", "zai/glm-5.3"]),
        };
      },
    };
    const diverseRepo = repoWithDoctor({
      codex: await codexAdapter.probe(),
      omp: await ompDiverseAdapter.probe(),
    });
    const diverseOut = await plan([], diverseRepo, [codexAdapter, ompDiverseAdapter]);
    expect(diverseOut).not.toContain(CROSS_VENDOR_PAIR_LINT);
  });
});

// OBS-1143 add.1: deny claude-code:claude-opus-5 must not refuse the floating alias opus once doctor
// observed it serving claude-opus-5-5 — and must still refuse it when it serves claude-opus-5.
const OPUS_DENY_CFG = `tiers:
  claude-code:
    vendor: anthropic
    channel: sub
    models:
      fable: null
      opus: frontier
      sonnet: null
      haiku: null
routing:
  deny:
    models: [claude-code:claude-opus-5]
  map:
    implement: { pool: { mode: any, channels: [claude-code:opus] } }
`;
const OPUS_SPEC = "<!-- tickmarkr:spec -->\n## T1: Keep the widget observable\n- goal: Keep widgetValue observable through widgetValue.\n- shape: implement\n- complexity: 2\n- files: src/widget.ts, tests/widget.test.ts\n- acceptance:\n  - test: widgetValue returns one | suite: tests/widget.test.ts\n";
const OPUS_POOL_REFUSAL = "routing.map.implement.pool claude-code:opus fully disallowed by routing.deny (claude-code:claude-opus-5)";
const claudeOpusAdapter = () => ({
  id: "claude-code",
  vendor: "anthropic",
  probe: async () => ({ installed: true, authed: true, models: [] }),
  channels: (cfg: Parameters<typeof channelsFromConfig>[1]) => channelsFromConfig("claude-code", cfg),
  headlessCommand: () => "printf OK",
}) as unknown as WorkerAdapter;

function opusDenyRepo(): string {
  const repo = makeRepo({ "feature.spec.md": OPUS_SPEC, "src/widget.ts": "export const widgetValue = () => 1;\n" });
  mkdirSync(join(repo, ".tickmarkr"), { recursive: true });
  writeFileSync(join(repo, ".tickmarkr", "config.yaml"), OPUS_DENY_CFG);
  return repo;
}

describe("OBS-1143 deny decisions read the observed alias identity", () => {
  test("test: strict compile resume preflight and doctor admit opus with observed identity claude-opus-5-5 versus refusing claude-opus-5 under the same deny, so one identity-blind alias refusal fails", async () => {
    const runId = "run-20260926-000000-0000000000001143";
    for (const [identity, admitted] of [["claude-opus-5-5", true], ["claude-opus-5", false]] as const) {
      const repo = opusDenyRepo();
      // doctor records the identity it observed; compile and resume read only that cache, never a probe
      const doctorOut = await doctor(["--"], repo, [claudeOpusAdapter()], { banner: false, resolveClaudeAliasIdentity: () => identity });
      saveGraph(repo, validateGraph({
        version: 1,
        spec: { source: "prd", paths: ["p"], hash: "h" },
        tasks: [{ id: "T1", title: "t", goal: "g", shape: "implement", complexity: 2, acceptance: ["a"] }],
      }));
      const compiled = () => compile(["feature.spec.md", "--strict", "--dry-run"], repo);
      const resumed = () => resume([runId, "--driver", "subprocess"], repo);
      if (admitted) {
        expect(doctorOut).not.toContain("deny∩prefer:");
        expect(doctorOut).toMatch(/opus\s+frontier\s.*denied=—/);
        await expect(compiled()).resolves.toMatch(/validated feature\.spec\.md/);
        // past the preflight the daemon itself runs — and stops only at the absent journal
        await expect(resumed()).rejects.toThrow(`no journal for ${runId}`);
      } else {
        expect(doctorOut).toContain(`deny∩prefer: ${OPUS_POOL_REFUSAL}`);
        expect(doctorOut).toMatch(/opus\s+frontier\s.*denied=claude-code:claude-opus-5/);
        await expect(compiled()).rejects.toThrow(OPUS_POOL_REFUSAL);
        await expect(resumed()).rejects.toThrow(`deny∩prefer: ${OPUS_POOL_REFUSAL}`);
      }
    }
  }, 60_000);
});

// OBS-1144: a pool carrying one denied entry routes its admitted remainder in either mode; only a pool
// with no admitted entry left refuses. B (claude-code:opus) is declared FIRST, so ordered must skip it.
const poolSkipCfg = (mode: "any" | "ordered", channels: string) => `tiers:
  claude-code:
    vendor: anthropic
    channel: sub
    models:
      fable: null
      opus: frontier
      sonnet: frontier
      haiku: null
routing:
  deny:
    models: [claude-code:opus]
  map:
    implement: { pool: { mode: ${mode}, channels: [${channels}] } }
`;

function poolSkipRepo(cfg: string): string {
  const repo = makeRepo({ "feature.spec.md": OPUS_SPEC, "src/widget.ts": "export const widgetValue = () => 1;\n" });
  mkdirSync(join(repo, ".tickmarkr"), { recursive: true });
  writeFileSync(join(repo, ".tickmarkr", "config.yaml"), cfg);
  writeDoctor(repo, {
    ...NO_CHANNELS_DOCTOR,
    "claude-code": { installed: true, authed: true, models: [], modelAuth: authedModels(["opus", "sonnet"]) },
  });
  saveGraph(repo, validateGraph({
    version: 1,
    spec: { source: "prd", paths: ["p"], hash: "h" },
    tasks: [{ id: "T1", title: "t", goal: "g", shape: "implement", complexity: 2, acceptance: ["a"] }],
  }));
  return repo;
}

describe("OBS-1144 pools route the admitted remainder", () => {
  test("test: strict compile and plan route surviving A from pool A plus denied B in either pool mode naming skipped B versus refusing an exhausted pool, so discarding the admitted remainder fails", async () => {
    const skippedB = "routing.map.implement.pool entry claude-code:opus is disallowed by routing.deny (claude-code:opus) — skipped — routes the admitted remainder claude-code:sonnet";
    for (const mode of ["any", "ordered"] as const) {
      const repo = poolSkipRepo(poolSkipCfg(mode, "claude-code:opus, claude-code:sonnet"));
      const compiled = await compile(["feature.spec.md", "--strict", "--dry-run"], repo);
      expect(compiled).toMatch(/validated feature\.spec\.md/);
      expect(compiled).toContain(`pool notes:\n  ! ${skippedB}`);
      const planned = await plan([], repo);
      expect(planned).toMatch(/T1\s+implement\s+c2\s*→ claude-code:sonnet \[sub\/frontier\]/);
      expect(planned).toContain(`pool ${mode} claude-code:sonnet (config routing.map; skipped claude-code:opus (disallowed by routing.deny (claude-code:opus)))`);
      expect(planned).not.toContain("T1: unroutable");
    }
    for (const mode of ["any", "ordered"] as const) {
      const exhausted = poolSkipRepo(poolSkipCfg(mode, "claude-code:opus"));
      await expect(compile(["feature.spec.md", "--strict", "--dry-run"], exhausted))
        .rejects.toThrow("routing.map.implement.pool claude-code:opus fully disallowed by routing.deny (claude-code:opus)");
      const planned = await plan([], exhausted);
      expect(planned).toContain("T1: unroutable — T1: routing.map.implement.pool is exhausted — no admitted entry remains: claude-code:opus (disallowed by routing.deny (claude-code:opus))");
      expect(planned).not.toMatch(/→ claude-code:/);
    }
  }, 60_000);
});
