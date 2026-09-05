import { createHash } from "node:crypto";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test, vi } from "vitest";
import { DEFAULT_CONFIG } from "../../src/config/config.js";
import { CLAUDE_ALIAS_IDENTITY_STAMPS } from "../../src/adapters/claude-code.js";
import {
  SHIPPED_CLI_CATALOG,
  catalogEntries,
  discoverCliEntries,
  loadOperatorCliCatalog,
  parseOperatorCliCatalog,
  projectCliEntries,
  type CliEntry,
} from "../../src/adapters/catalog.js";
import {
  adaptersFromCliEntries, allAdapters, CANDIDATE_CLI_CATALOG, discoverChannels, parseHerdrCliNames,
} from "../../src/adapters/registry.js";
import type { AuthHealth, WorkerAdapter } from "../../src/adapters/types.js";

const advisory = (id: string, binary = id): CliEntry => ({
  id,
  binary,
  identity: ".+",
  vendor: null,
});

const driven = (id: string, binary = id): CliEntry => ({
  id,
  binary,
  identity: `^${id} `,
  vendor: "fixture-vendor",
  drive: {
    headless: `${binary} run --model {model} --prompt-file {promptFile}`,
    interactive: `${binary} --model {model} --prompt-file {promptFile}`,
    // v1.89 T1: a fixture CLI nobody launches has no pane to capture — it says so rather than
    // inventing a fingerprint the daemon would press a key on.
    trustDialog: { kind: "none", reason: "catalog fixture — no binary is ever launched" },
  },
});

const operatorYaml = (entry: CliEntry): string => `
clis:
  - id: ${entry.id}
    binary: ${entry.binary}
    identity: ${JSON.stringify(entry.identity)}
    vendor: ${entry.vendor === null ? "null" : entry.vendor}
`;

const discoverySources = (): Array<{ source: string; entries: CliEntry[]; id: string }> => {
  const catalog = advisory("catalog-fixture");
  const operator = advisory("operator-fixture");
  return [
    {
      source: "catalog entry",
      entries: catalogEntries({ shipped: [catalog], operatorYaml: null, herdrNames: [] }),
      id: catalog.id,
    },
    {
      source: "operator YAML",
      entries: catalogEntries({ shipped: [], operatorYaml: operatorYaml(operator), herdrNames: [] }),
      id: operator.id,
    },
    {
      source: "herdr nomination",
      entries: catalogEntries({ shipped: [], operatorYaml: null, herdrNames: ["herdr-fixture"] }),
      id: "herdr-fixture",
    },
  ];
};

describe("declarative CLI catalog", () => {
  test("test: no advisory-only entry is ever executed, proven member by member over the closed set of discovery sources — a catalog-entry fixture with no drive block, an operator-YAML fixture with no drive block, and a herdr-nominated-name fixture — each resolved for presence only, and each proven unexecuted by an injected exec tracker recording zero invocations rather than by the absence of a version string in a rendered row", () => {
    for (const { source, entries, id } of discoverySources()) {
      const execute = vi.fn();
      const resolveBinary = vi.fn((binary: string) => ({ resolved: `/fixture/bin/${binary}`, all: [`/fixture/bin/${binary}`] }));

      const discovered = discoverCliEntries(entries, { resolveBinary, execute });

      expect(discovered.present, source).toEqual([{ id, binary: id, path: `/fixture/bin/${id}`, routable: false }]);
      expect(resolveBinary, source).toHaveBeenCalledTimes(1);
      expect(execute, source).toHaveBeenCalledTimes(0);
    }
  });

  test("test: an entry with no drive block appears in NO discovered channel and in NO routing table, proven member by member over those same three discovery sources, so routability and presence are separately witnessed rather than inferred from one another", () => {
    for (const { source, entries, id } of discoverySources()) {
      const projected = projectCliEntries(entries);
      const catalogAdapters = adaptersFromCliEntries(entries);
      const adapters = allAdapters({ cliEntries: entries });
      const health: Record<string, AuthHealth> = {
        [id]: {
          installed: true,
          authed: true,
          models: ["fixture-model"],
          modelAuth: { "fixture-model": { authed: true, probedAt: "1970-01-01T00:00:00.000Z" } },
        },
      };

      expect(projected.routable, source).toEqual([]);
      expect(catalogAdapters.map((adapter) => adapter.id), source).not.toContain(id);
      expect(adapters.map((adapter) => adapter.id), source).not.toContain(id);
      expect(discoverChannels(DEFAULT_CONFIG, catalogAdapters, health), source).toEqual([]);
    }
  });

  test("test: both the routable and advisory projections derive from one array, proven by adding a single catalog entry and observing exactly one projection change with no second list edited", () => {
    const shipped = projectCliEntries(SHIPPED_CLI_CATALOG);
    expect(allAdapters({ cliEntries: SHIPPED_CLI_CATALOG }).map((adapter) => adapter.id)).toEqual(shipped.routable.map((entry) => entry.id));
    expect(CANDIDATE_CLI_CATALOG).toEqual(shipped.advisory.map((entry) => entry.binary));

    const entries: CliEntry[] = [advisory("advisory-base")];
    const beforeDrive = projectCliEntries(entries);
    entries.push(driven("driven-added"));
    const afterDrive = projectCliEntries(entries);

    expect(afterDrive.advisory).toEqual(beforeDrive.advisory);
    expect(afterDrive.routable.map((entry) => entry.id)).toEqual([
      ...beforeDrive.routable.map((entry) => entry.id),
      "driven-added",
    ]);

    const beforeAdvisory = projectCliEntries(entries);
    entries.push(advisory("advisory-added"));
    const afterAdvisory = projectCliEntries(entries);
    expect(afterAdvisory.routable).toEqual(beforeAdvisory.routable);
    expect(afterAdvisory.advisory.map((entry) => entry.id)).toEqual([
      ...beforeAdvisory.advisory.map((entry) => entry.id),
      "advisory-added",
    ]);

    const [adapter] = adaptersFromCliEntries([driven("driven-added")]);
    expect(adapter?.headlessCommand("/tmp/prompt file.md", "vendor/model")).toBe(
      "driven-added run --model 'vendor/model' --prompt-file '/tmp/prompt file.md'",
    );
  });

  test("test: two entries claiming one binary reject both for routing rather than resolving by registration order, and a herdr-nominated name failing the token pattern is rejected rather than passed to a shell", () => {
    const first = driven("first", "shared-bin");
    const second = driven("second", "shared-bin");
    const forward = projectCliEntries([first, second]);
    const reverse = projectCliEntries([second, first]);

    expect(forward.routable).toEqual([]);
    expect(reverse.routable).toEqual([]);
    expect(forward.conflicts).toEqual([{ binary: "shared-bin", ids: ["first", "second"] }]);
    expect(adaptersFromCliEntries([first, second])).toEqual([]);

    const entries = catalogEntries({
      shipped: [],
      operatorYaml: null,
      herdrNames: ["valid-name", "bad; touch /tmp/pwned", "also_bad"],
    });
    const resolveBinary = vi.fn((binary: string) => ({ resolved: `/fixture/bin/${binary}`, all: [`/fixture/bin/${binary}`] }));
    const execute = vi.fn();
    const discovered = discoverCliEntries(entries, { resolveBinary, execute });

    expect(entries.map((entry) => entry.id)).toEqual(["valid-name"]);
    expect(discovered.present.map((entry) => entry.id)).toEqual(["valid-name"]);
    expect(resolveBinary).toHaveBeenCalledTimes(1);
    expect(resolveBinary).toHaveBeenCalledWith("valid-name");
    expect(execute).not.toHaveBeenCalled();
  });

  test("operator YAML is zod-validated and the shipped candidate-name compatibility view is derived", () => {
    expect(parseOperatorCliCatalog(operatorYaml(advisory("yaml-fixture")))).toEqual([advisory("yaml-fixture")]);
    expect(() => parseOperatorCliCatalog(operatorYaml(advisory("bad_name")))).toThrow(/id/i);
    expect(() => parseOperatorCliCatalog(`
clis:
  - id: incomplete-drive
    binary: incomplete-drive
    identity: ".+"
    vendor: fixture-vendor
    drive:
      headless: "incomplete-drive {promptFile}"
      interactive: null
      trustDialog: { kind: none, reason: "fixture CLI — no captured pane" }
`)).toThrow(/headless.*\{model\}/i);
    expect(() => loadOperatorCliCatalog("repo-relative-clis.yaml")).toThrow(/absolute/i);
    // omp carries a drive contract now; the advisory class keeps a shipped instance in gemini, so
    // the compatibility view is still derived from a populated projection rather than an empty one.
    expect(SHIPPED_CLI_CATALOG.some((entry) => entry.binary === "omp" && entry.drive !== undefined)).toBe(true);
    expect(SHIPPED_CLI_CATALOG.some((entry) => entry.binary === "gemini" && entry.drive === undefined)).toBe(true);
  });

  test("an operator YAML drive block creates a declarative adapter and Herdr help nominates tokens only", () => {
    const yaml = `
clis:
  - id: yaml-driven
    binary: yaml-driven
    identity: "^yaml-driven "
    vendor: fixture-vendor
    drive:
      headless: "yaml-driven run --model {model} --prompt-file {promptFile}"
      interactive: null
      trustDialog:
        kind: none
        reason: "operator fixture CLI — no captured pane"
`;
    const entries = parseOperatorCliCatalog(yaml);
    const [adapter] = adaptersFromCliEntries(entries);

    expect(adapter?.id).toBe("yaml-driven");
    expect(adapter?.interactiveCommand("/tmp/prompt.md", "fixture/model")).toBeNull();
    expect(allAdapters({ operatorYaml: yaml }).map((candidate) => candidate.id)).toContain("yaml-driven");
    expect(parseHerdrCliNames("[possible values: valid-one, bad_name, valid-two, x;no]")).toEqual([
      "valid-one",
      "valid-two",
    ]);
  });
});

// v1.89 T2: omp is constructed through the SHIPPED catalog on every assertion below — never from a
// literal drive block copied into the test — so a contract that only exists in an operator's
// ~/.config/tickmarkr/clis.yaml cannot satisfy any of them.
const shippedOmp = (): { entry: CliEntry; adapter: WorkerAdapter } => {
  const entry = SHIPPED_CLI_CATALOG.find((candidate) => candidate.id === "omp");
  const adapter = allAdapters({ cliEntries: SHIPPED_CLI_CATALOG }).find((candidate) => candidate.id === "omp");
  if (!entry || !adapter) throw new Error("shipped omp entry is not routable");
  return { entry, adapter };
};

// Deliberately NOT shq() from the source under test: quoting proven against production's own helper
// would agree with itself if that helper regressed.
const independentlySingleQuote = (value: string): string => `'${value.replaceAll("'", `'\\''`)}'`;

test("the shipped catalog entry for omp yields a routable adapter whose headless and interactive commands both render the prompt file and the model shell-quoted, exercised with a model id carrying a provider prefix and one carrying a shell metacharacter, so quoting is what is proven rather than the absence of anything to quote", () => {
  const { adapter } = shippedOmp();
  const promptFile = "/tmp/omp prompt's evidence.md";
  const models = [
    "anthropic/claude-opus-5",
    "anthropic/model'; printf SHELL_METACHAR_MUST_STAY_DATA",
  ];

  for (const model of models) {
    const suffix = `--model ${independentlySingleQuote(model)} @${independentlySingleQuote(promptFile)}`;
    expect(adapter.interactiveCommand(promptFile, model), model).toBe(`omp ${suffix}`);
    expect(adapter.headlessCommand(promptFile, model), model).toBe(`omp -p ${suffix}`);
  }
});

test("constructing omp through the shipped catalog records interactive argv \"omp --model <quoted-model> @<quoted-prompt>\" and headless argv \"omp -p --model <quoted-model> @<quoted-prompt>\"; execute both production command renderers so a null fallback or copied headless template produces the wrong recorded mode token", () => {
  const { adapter } = shippedOmp();
  const promptFile = "/tmp/recorded omp prompt.md";
  const model = "openai-codex/gpt-5.6-sol";

  const recorded = [
    { mode: "interactive", argv: adapter.interactiveCommand(promptFile, model) },
    { mode: "headless", argv: adapter.headlessCommand(promptFile, model) },
  ];

  expect(recorded).toEqual([
    { mode: "interactive", argv: "omp --model 'openai-codex/gpt-5.6-sol' @'/tmp/recorded omp prompt.md'" },
    { mode: "headless", argv: "omp -p --model 'openai-codex/gpt-5.6-sol' @'/tmp/recorded omp prompt.md'" },
  ]);
});

test("construct omp through the shipped catalog and compare its vendor, trust declaration and identity regex against the recorded omp/17.2.10 banner. Repeat with a wrong vendor and nonmatching banner so copied fields, dead declarations or banner-blind review fail", async () => {
  const { adapter } = shippedOmp();
  const recording = {
    vendor: "mixed",
    banner: "omp/17.2.10",
    trustDialog: {
      kind: "none",
      reason: "omp 17.2.10 showed no workspace-trust prompt during the recorded interactive probe (PROBE-omp-v189.md, 2026-08-07)",
    },
  } as const;

  // The identity leg goes through the PRODUCTION consumer — declarativeAdapter's probe() gating a
  // real `omp --version` on PATH — never through a regex this test applies itself. Deleting the
  // identity check in registry.ts therefore turns the nonmatching banner green and fails here.
  const binDir = mkdtempSync(join(tmpdir(), "tickmarkr-omp-identity-"));
  const executable = join(binDir, "omp");
  writeFileSync(executable, "#!/bin/sh\nprintf '%s\\n' \"$TICKMARKR_OMP_BANNER\"\n");
  chmodSync(executable, 0o755);
  const bashEnv = join(binDir, "bash-env");
  writeFileSync(bashEnv, `export PATH='${binDir}':"$PATH"\n`);
  const bashEnvBefore = process.env.BASH_ENV;
  const bannerBefore = process.env.TICKMARKR_OMP_BANNER;

  try {
    process.env.BASH_ENV = bashEnv;
    const probeBanner = async (banner: string) => {
      process.env.TICKMARKR_OMP_BANNER = banner;
      return await adapter.probe();
    };
    const matchesRecording = async (observation: typeof recording): Promise<boolean> => {
      const health = await probeBanner(observation.banner);
      return adapter.vendor === observation.vendor
        && JSON.stringify(adapter.trustDialog) === JSON.stringify(observation.trustDialog)
        && health.installed && health.authed && health.version === observation.banner;
    };

    expect(adapter.trustDialog).toEqual(recording.trustDialog);
    expect([
      await matchesRecording(recording),
      await matchesRecording({ ...recording, vendor: "anthropic" }),
      await matchesRecording({ ...recording, banner: "gateway/17.2.10" }),
    ]).toEqual([true, false, false]);
    // Pin HOW the nonmatching banner is rejected: an installed binary whose identity failed, not a
    // missing one — a probe that stopped reading the banner would report authed with no note.
    expect(await probeBanner("gateway/17.2.10")).toMatchObject({
      installed: true,
      authed: false,
      version: "gateway/17.2.10",
      note: "identity mismatch for omp",
    });
    expect(await probeBanner(recording.banner)).toMatchObject({
      installed: true,
      authed: true,
      note: "auth assumed; verified at dispatch (failover on auth/quota errors)",
    });
  } finally {
    if (bashEnvBefore === undefined) delete process.env.BASH_ENV;
    else process.env.BASH_ENV = bashEnvBefore;
    if (bannerBefore === undefined) delete process.env.TICKMARKR_OMP_BANNER;
    else process.env.TICKMARKR_OMP_BANNER = bannerBefore;
  }
});

test("the fable alias stamp reads claude-fable-5-1 with a dated comment and the roster-digest pins for claude-code and qwen are repinned to the new tuples as the diff shows in the changed hunks", () => {
  // The codex tuple embeds codexMcpSuppressionFlags(), which by design reads the operator's
  // $CODEX_HOME/config.toml at render time. Pin CODEX_HOME to an empty location so the recorded
  // digests are the zero-config rendering on every machine — the original pin hashed the author's
  // private MCP server names and went red the day that config changed (release 1.89.0 proof).
  vi.stubEnv("CODEX_HOME", "/var/empty/tickmarkr-hermetic-codex-home");
  type RegistryTuple = {
    routable: boolean;
    vendor: string | null;
    command: { interactive: string | null; headless: string } | null;
    trust: WorkerAdapter["trustDialog"] | null;
    identity: string;
  };
  const recordRegistry = (entries: readonly CliEntry[]): Record<string, RegistryTuple> => {
    const adapters = new Map(adaptersFromCliEntries(entries).map((adapter) => [adapter.id, adapter]));
    return Object.fromEntries(entries.map((entry) => {
      const adapter = adapters.get(entry.id);
      return [entry.id, {
        routable: adapter !== undefined,
        vendor: adapter?.vendor ?? entry.vendor,
        command: adapter ? {
          interactive: adapter.interactiveCommand("/tmp/registry prompt.md", "provider/model"),
          headless: adapter.headlessCommand("/tmp/registry prompt.md", "provider/model"),
        } : null,
        trust: adapter?.trustDialog ?? null,
        identity: entry.identity,
      }];
    }));
  };
  const beforeEntries: CliEntry[] = SHIPPED_CLI_CATALOG.map((entry) => entry.id === "qwen"
    ? { id: "qwen", binary: "qwen", identity: ".+", vendor: null }
    : entry);
  const before = recordRegistry(beforeEntries);
  const after = recordRegistry(SHIPPED_CLI_CATALOG);
  // Pin the complete recorded tuple bytes, not merely before-vs-after equality: deriving both
  // sides from a blanket policy change would otherwise let the same wrong value agree with itself.
  const digestMap = (map: Record<string, RegistryTuple>): Record<string, string> => Object.fromEntries(
    Object.entries(map).map(([id, tuple]) => [
      id,
      createHash("sha256").update(JSON.stringify(tuple)).digest("hex"),
    ]),
  );
  const expectedBeforeDigests = {
    // 2026-09-03: repinned when claude moved its print prompt to stdin, pane forms gained the
    // promptSuggestionEnabled settings pair, and Fable's stamp advanced to 5.1.
    "claude-code": "c00cb8c0fc0e03ca99857237b98d73d59e223f4d2ec5156bc7500fc778c707d0",
    // 2026-09-05 (OBS-889): repinned when headless prompts moved to stdin and TUI fallback became explicit.
    // 2026-09-05 (OBS-930): repinned when the interactive form became the real TUI launch with the
    // prompt as the last positional (the argv-safe shape the claude adapter uses).
    codex: "ac955b630139704f37697deefdb8c10424a4842ce747d168b03bc81be02d24ed",
    "cursor-agent": "b7ce2cbb18f5ccb2749739ffcc80c2d036b72193554189e4f07eff11ce16d8de",
    opencode: "15ce06482a58b5096642974bf4f9a1c3031b62b4aa4de46e6d8038f6cb94ad82",
    pi: "d8c6ab42a4052ee982ead3e119d02d4df8734429b36a129a9e926cf1c2f8c3b7",
    grok: "e8ad783fecb4f8cace029446707028f6fd304f25c315d8b76c4f392644cb8d3e",
    kimi: "2cdc23a0fa58ff0d677b1762575e47775539a83efa4938e4f0a62e90de1e5799",
    gemini: "461d1b3b0e974957b000d94d812fcda355b360908d6d6446d70c4a8d29ccd9be",
    qwen: "461d1b3b0e974957b000d94d812fcda355b360908d6d6446d70c4a8d29ccd9be",
    aider: "461d1b3b0e974957b000d94d812fcda355b360908d6d6446d70c4a8d29ccd9be",
    goose: "461d1b3b0e974957b000d94d812fcda355b360908d6d6446d70c4a8d29ccd9be",
    amp: "461d1b3b0e974957b000d94d812fcda355b360908d6d6446d70c4a8d29ccd9be",
    droid: "461d1b3b0e974957b000d94d812fcda355b360908d6d6446d70c4a8d29ccd9be",
    auggie: "461d1b3b0e974957b000d94d812fcda355b360908d6d6446d70c4a8d29ccd9be",
    crush: "461d1b3b0e974957b000d94d812fcda355b360908d6d6446d70c4a8d29ccd9be",
    "prime-agent": "459d0095ae0262ff6fce15db214b6f133d23ee11f922f09558d46dea5faa6f82",
    omp: "560517184e55bcd06d48db486e8b31ac5606fb38c75d5a58db8dc82820326a71",
    agy: "b1f724e78c4e7cb04ee8ce27bf7285dbd15dde4c3dffada16dad7cc3bc75f040",
  };

  expect(CLAUDE_ALIAS_IDENTITY_STAMPS.fable).toBe("claude-fable-5-1");
  expect(before.qwen).toEqual({ routable: false, vendor: null, command: null, trust: null, identity: ".+" });
  expect(after.qwen).toMatchObject({ routable: true, vendor: "alibaba", identity: "^\\d+\\.\\d+\\.\\d+" });
  expect(Object.keys(after)).toEqual(Object.keys(before));
  expect(digestMap(before)).toEqual(expectedBeforeDigests);
  // 2026-09-04 (OBS-902): repinned when qwen headless gained --safe-mode. Only qwen's tuple moved.
  expect(digestMap(after)).toEqual({ ...expectedBeforeDigests, qwen: "c92184732fd47b178be17282c5ea4784911d85a7f7f82a8ec39df1bb65c5af78" });
  for (const id of Object.keys(before).filter((candidate) => candidate !== "qwen")) {
    expect(after[id], id).toEqual(before[id]);
  }
  vi.unstubAllEnvs();
});
