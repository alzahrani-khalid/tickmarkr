import * as childProcess from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, afterEach, describe, expect, test, vi } from "vitest";
import { CLAUDE_ALIAS_IDENTITY_STAMPS, type ClaudeAlias, resolveClaudeAliasIdentity } from "../../src/adapters/claude-code.js";
import { codex, hasCodexTrustedProject, seedCodexTrust } from "../../src/adapters/codex.js";
import { ARTIFICIAL_ANALYSIS_CATALOG_URL, CATALOG_REFRESH_TIMEOUT_MS, LIVEBENCH_CATEGORIES_URL, LIVEBENCH_TABLE_DATE, LIVEBENCH_TABLE_URL, MODELS_DEV_CATALOG_URL, readCachedCatalog, refreshCatalogCommand } from "../../src/adapters/catalog-remote.js";
import type { CodexCommitProbe, CodexSandbox } from "../../src/adapters/codex-commit-check.js";
import { FakeAdapter } from "../../src/adapters/fake.js";
import * as registry from "../../src/adapters/registry.js";
import { channelsFromConfig, type TrustVerdict, type WorkerAdapter } from "../../src/adapters/types.js";
import { BANNER, TOKENS } from "../../src/brand.js";
import { doctor } from "../../src/cli/commands/doctor.js";
import { fleet } from "../../src/cli/commands/fleet.js";
import { compile as compileCommand } from "../../src/cli/commands/compile.js";
import { plan as planCommand } from "../../src/cli/commands/plan.js";
import { run as runCommand } from "../../src/cli/commands/run.js";
import { resume } from "../../src/cli/commands/resume.js";
import { loadConfig } from "../../src/config/config.js";
import * as orcaDriver from "../../src/drivers/orca.js";
import { graphDefinitionHash, loadGraph } from "../../src/graph/graph.js";
import { route } from "../../src/route/router.js";
import { gitHead } from "../../src/run/git.js";
import { Journal } from "../../src/run/journal.js";
import { authedModels, makeRepo, setupRepo, T } from "../helpers/tmprepo.js";

const {
  discoverChannels,
  invalidConfiguredModels,
  modelAliasExclusions,
  probeVersionShell,
} = registry;

const stub = (id: string) =>
  ({ id, vendor: "x", probe: async () => ({ installed: true, authed: true, models: [] }) }) as unknown as WorkerAdapter;

const ADAPTERS5 = ["claude-code", "codex", "cursor-agent", "opencode", "pi"].map(stub);
const retiredBanner = `${["dro", "vr"].join("")} —`;

test("test: doctor run over a state directory whose recent journals hold two demotion rows for one channel prints that channel with the count and the recorded cause, while a state directory whose journals hold no demotion row prints no such line, so a doctor that omits a twice-demoted channel fails", async () => {
  const withDemotions = makeRepo({ "keep.txt": "x" });
  for (const [runId, taskId] of [["run-20260911-000001-0000000000000001", "T1"], ["run-20260911-000002-0000000000000002", "T2"]] as const) {
    Journal.create(withDemotions, runId).append("review-pool-demotion", taskId, {
      reviewer: "qwen:qwen3.8-max", cause: "silent", seatAuthoredBytes: 0,
    });
  }
  const output = await doctor(["--"], withDemotions, [stub("fixture")], { banner: false });
  expect(output).toMatch(/qwen:qwen3\.8-max\s+2 review seats demoted · cause silent/);

  const withoutDemotions = makeRepo({ "keep.txt": "x" });
  Journal.create(withoutDemotions, "run-20260911-000003-0000000000000003")
    .append("run-start", undefined, { branch: "test" });
  const quiet = await doctor(["--"], withoutDemotions, [stub("fixture")], { banner: false });
  expect(quiet).not.toContain("recent review-seat demotions:");
  expect(quiet).not.toContain("review seats demoted");
});

test("doctor shows unreadable review history as unknown versus a measured zero, so inventing a clean history from a corrupt journal fails", async () => {
  const reviewedOnce = (repo: string) => {
    const journal = Journal.create(repo, "run-20260920-000001-0000000000000001");
    journal.append("run-start", undefined, { branch: "test" });
    journal.append("gate-result", "T1", { gate: "review", pass: true, reviewer: "qwen:qwen3.8-max", details: "ok" });
    journal.append("run-end", undefined, {});
  };
  const measured = makeRepo({ "keep.txt": "x" });
  reviewedOnce(measured);
  const clean = await doctor(["--"], measured, [stub("fixture")], { banner: false });
  expect(clean).toMatch(/qwen:qwen3\.8-max\s+0 review no-verdicts in the last 1 completed run$/m);
  expect(clean).not.toContain("unknown — ");

  // a newer journal whose middle row is torn: its review events cannot be counted, so no zero is claimed
  const corrupt = makeRepo({ "keep.txt": "x" });
  reviewedOnce(corrupt);
  const tornDir = join(corrupt, ".tickmarkr", "runs", "run-20260920-000002-0000000000000002");
  mkdirSync(tornDir, { recursive: true });
  writeFileSync(join(tornDir, "journal.jsonl"), [
    JSON.stringify({ ts: "2026-09-20T00:00:02.000Z", event: "run-start", data: {} }),
    '{"ts":"2026-09-20T00:00:03.000Z","event":"review-no-verdict","data":{"reviewer":"qwen:qwe',
    JSON.stringify({ ts: "2026-09-20T00:00:04.000Z", event: "run-end", data: {} }),
    "",
  ].join("\n"));
  const unknown = await doctor(["--"], corrupt, [stub("fixture")], { banner: false });
  expect(unknown).toMatch(/qwen:qwen3\.8-max\s+unknown — at least 0 in the last 1 completed run; 1 run journal unreadable/);
  expect(unknown).toMatch(/unreadable\s+unknown — run-20260920-000002-0000000000000002 did not parse/);
  expect(unknown).not.toMatch(/qwen:qwen3\.8-max\s+0 review no-verdicts/);
});

describe("OBS-141 kimi doctor turn probe", () => {
  const stubKimi = (authed: boolean, note: string) =>
    ({
      id: "kimi",
      vendor: "moonshot",
      probe: async () => ({ installed: true, authed, version: "0.29.0", models: [], note }),
      headlessCommand: vi.fn(() => "printf OK"),
    }) as unknown as WorkerAdapter;

  test("test: a healthy auth file with a failing model turn reports unhealthy with the turn failure named", async () => {
    const repo = makeRepo({ "keep.txt": "x" });
    const turnProbe = vi.fn().mockResolvedValue({
      ok: false,
      evidence: "[config.invalid] Model \"kimi-code/kimi-for-coding\" is not configured",
    });

    const adapter = stubKimi(true, "auth file valid");
    const out = await doctor(["--"], repo, [adapter], { banner: false, kimiTurnProbe: turnProbe });
    const saved = JSON.parse(readFileSync(join(repo, ".tickmarkr", "doctor.json"), "utf8"));

    expect(turnProbe).toHaveBeenCalledOnce();
    expect(turnProbe).toHaveBeenCalledWith(repo);
    expect(adapter.headlessCommand).not.toHaveBeenCalled();
    expect(saved.kimi).toMatchObject({
      authed: false,
      note: expect.stringContaining("[config.invalid]"),
    });
    expect(out).toMatch(/✗ kimi\s+0\.29\.0.*model turn failed.*\[config\.invalid\]/);
  });

  test("test: a missing or invalid auth file reports unhealthy without attempting any turn", async () => {
    const turnProbe = vi.fn();

    for (const note of ["auth file missing", "auth file invalid"]) {
      const repo = makeRepo({ "keep.txt": "x" });
      const adapter = stubKimi(false, note);
      const out = await doctor(["--"], repo, [adapter], { banner: false, kimiTurnProbe: turnProbe });
      const saved = JSON.parse(readFileSync(join(repo, ".tickmarkr", "doctor.json"), "utf8"));

      expect(saved.kimi).toMatchObject({ authed: false, note });
      expect(out).toMatch(new RegExp(`✗ kimi\\s+0\\.29\\.0.*${note}`));
      expect(adapter.headlessCommand).not.toHaveBeenCalled();
    }
    expect(turnProbe).not.toHaveBeenCalled();
  });

  test("test: a healthy auth file with a passing turn reports healthy naming the turn evidence", async () => {
    const repo = makeRepo({ "keep.txt": "x" });
    const turnProbe = vi.fn().mockResolvedValue({
      ok: true,
      evidence: "model turn returned OK with kimi-code/kimi-for-coding",
    });

    const out = await doctor(["--"], repo, [
      stubKimi(true, "auth file valid"),
    ], { banner: false, kimiTurnProbe: turnProbe });
    const saved = JSON.parse(readFileSync(join(repo, ".tickmarkr", "doctor.json"), "utf8"));

    expect(turnProbe).toHaveBeenCalledOnce();
    expect(saved.kimi).toMatchObject({
      authed: true,
      note: expect.stringContaining("model turn returned OK with kimi-code/kimi-for-coding"),
    });
    expect(out).toMatch(/✓ kimi\s+0\.29\.0.*model turn returned OK with kimi-code\/kimi-for-coding/);
  });
});

const withOverlay = (repo: string, yaml: string) => {
  mkdirSync(join(repo, ".tickmarkr"), { recursive: true });
  writeFileSync(join(repo, ".tickmarkr", "config.yaml"), yaml);
};

// Candidate-CLI sweep is covered in doctor-candidate-cli.test.ts; stubbing here avoids nine
// real PATH probes per doctor() call (flaky vitest worker RPC timeouts under full-suite load).
beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("catalog fetch unavailable in test"); }));
  vi.spyOn(registry, "detectCandidateClis").mockReturnValue([]);
  // Queue row 102 (D-1626): the same for the two environment rows no test here reads. Unstubbed, every doctor()
  // ran a login-shell lookup of tickmarkr and tkr plus a full-CLI `version` per install found (the self-shadow row,
  // pinned in doctor-runner-ignore.test.ts), and `orca status --json` against the developer's LIVE Orca, also via
  // ORCA_CLI_COMMAND (the orca row, pinned in doctor-orca.test.ts). Only doctor.ts's imported bindings are
  // replaced: registry's internal resolution (probeVersionShell, binaryShadowWarnings — OBS-117 below) stays real.
  vi.spyOn(registry, "resolveShellBinary").mockReturnValue({ all: [] });
  vi.spyOn(orcaDriver, "resolveOrcaCliBinary").mockReturnValue(undefined);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// HYG-07(a): a stub whose probe reports a servable list, with channels() wired so servableExclusions
// can compute the drop exactly as discoverChannels would.
const stubServable = (id: string, servable: string[]) =>
  ({ id, vendor: "x", probe: async () => ({ installed: true, authed: true, models: [], servable }), channels: (cfg: any) => channelsFromConfig(id, cfg) }) as unknown as WorkerAdapter;

describe("V-10 fleet preference visibility (doctor)", () => {
  test("V-10c: active deny shows the same exclusion line as plan", async () => {
    const repo = makeRepo({ "keep.txt": "x" });
    withOverlay(repo, "routing:\n  deny:\n    adapters: [pi]\n");
    const out = await doctor(["--"], repo, ADAPTERS5);
    expect(out).toMatch(/^tickmarkr doctor — capability matrix:/);
    expect(out).not.toContain(retiredBanner);
    expect(out).toContain("pi:zai/glm-5.2");
    expect(out).toMatch(/! routing preference active: 3 channel\(s\) excluded/);
    expect(out).toMatch(/deny: pi/);
  });

  test("V-10c: no preference — exclusion line absent", async () => {
    const repo = makeRepo({ "keep.txt": "x" });
    const out = await doctor(["--"], repo, ADAPTERS5);
    expect(out).not.toMatch(/routing preference active:/);
  });
});

describe("HYG-07(a) servable attribution in doctor", () => {
  test("servable-dropped channel is a named truth in doctor output", async () => {
    const repo = makeRepo({ "keep.txt": "x" });
    withOverlay(repo, `tiers:
  pi:
    vendor: zhipu
    channel: sub
    models:
      zai/glm-5.2: mid
      anthropic/claude-opus-4-5: frontier
`);
    // pi serves only zai/glm-5.2; the other model is unservable → attributed. doctor probes fresh, so the
    // attribution is current by construction (no staleness line in doctor — only plan has one).
    const adapters = ["claude-code", "codex", "cursor-agent", "opencode"].map(stub)
      .concat([stubServable("pi", ["zai/glm-5.2"])]);
    const out = await doctor(["--"], repo, adapters);
    expect(out).toMatch(/servability: 3 channel\(s\) unservable/);
    expect(out).toContain("pi:anthropic/claude-opus-4-5");
    expect(out).toContain("not in pi's served model list");
  });

  test("no servable field → no servability line (compat)", async () => {
    const repo = makeRepo({ "keep.txt": "x" });
    const out = await doctor(["--"], repo, ADAPTERS5);
    expect(out).not.toMatch(/servability:/);
  });
});

describe("model status table (T4)", () => {
  const mkFake = (script: string) => {
    const fake = new FakeAdapter(script);
    vi.spyOn(fake, "headlessCommand").mockImplementation((_prompt, model) =>
      model === "fake-denied" ? "printf 'credit exhausted'; exit 1" : "printf OK",
    );
    return fake;
  };
  const fakeTiers = `tiers:
  fake:
    vendor: fake
    channel: sub
    models:
      fake-1: mid
      fake-denied: cheap
`;

  test("classified models render tier, auth verdict (reason+date when unauthed), denied, prefer; probes persist", async () => {
    const repo = makeRepo({ "keep.txt": "x" });
    const script = join(repo, "fake.json");
    writeFileSync(script, JSON.stringify({ tasks: {} }));
    withOverlay(repo, fakeTiers);
    const out = await doctor(["--"], repo, [mkFake(script)]);
    const saved = JSON.parse(readFileSync(join(repo, ".tickmarkr", "doctor.json"), "utf8"));

    expect(out).toMatch(/model status:/);
    expect(out).toMatch(/fake-1\s+mid\s+authed [\d.]+s\s+denied=—\s+prefer=—/);
    // unauthed carries BOTH reason and probe date
    expect(out).toMatch(/fake-denied\s+cheap\s+unauthed: credit exhausted \(\d{4}-\d{2}-\d{2}\)\s+denied=—\s+prefer=—/);
    expect(saved.fake.modelAuth["fake-1"].authed).toBe(true);
    expect(saved.fake.modelAuth["fake-denied"]).toMatchObject({ authed: false, reason: "credit exhausted" });
  });

  test("test: a channel whose doctor record carries the probe-error errno EMFILE renders probe error (EMFILE) on its doctor row and never the unauthed wording while a channel recording authed false without an errno still renders unauthed whereas a renderer that folds both into one wording fails", async () => {
    const repo = makeRepo({ "keep.txt": "x" });
    const script = join(repo, "fake.json");
    writeFileSync(script, JSON.stringify({ tasks: {} }));
    withOverlay(repo, fakeTiers);
    const fake = mkFake(script);
    vi.spyOn(fake, "headlessCommand").mockImplementation((_prompt, model) =>
      model === "fake-1"
        ? "printf 'spawn EMFILE' >&2; exit 1"
        : "printf 'credit exhausted'; exit 1",
    );

    const out = await doctor(["--"], repo, [fake]);
    const saved = JSON.parse(readFileSync(join(repo, ".tickmarkr", "doctor.json"), "utf8"));
    const probeErrorRow = out.split("\n").find((line) => line.includes("fake-1"))!;
    const unauthedRow = out.split("\n").find((line) => line.includes("fake-denied"))!;

    expect(saved.fake.modelAuth["fake-1"]).toMatchObject({ probeError: "EMFILE" });
    expect(probeErrorRow).toContain("probe error (EMFILE)");
    expect(probeErrorRow).not.toContain("unauthed");
    expect(saved.fake.modelAuth["fake-denied"]).toMatchObject({ authed: false });
    expect(saved.fake.modelAuth["fake-denied"]).not.toHaveProperty("probeError");
    expect(unauthedRow).toContain("unauthed:");
    expect(unauthedRow).not.toContain("probe error");
  });

  test("denied model shows the deny entry as a flag", async () => {
    const repo = makeRepo({ "keep.txt": "x" });
    const script = join(repo, "fake.json");
    writeFileSync(script, JSON.stringify({ tasks: {} }));
    withOverlay(repo, `${fakeTiers}routing:
  deny:
    models: [fake:fake-1]
`);
    const out = await doctor(["--"], repo, [mkFake(script)]);
    // the denied flag names the matched entry; fake-denied (not denied) stays denied=—
    expect(out).toMatch(/fake-1\s+mid\s+authed [\d.]+s\s+denied=fake:fake-1\s+prefer=—/);
    expect(out).toMatch(/fake-denied[\s\S]*denied=—/);
  });

  test("prefer rank reflects the routing map", async () => {
    const repo = makeRepo({ "keep.txt": "x" });
    const script = join(repo, "fake.json");
    writeFileSync(script, JSON.stringify({ tasks: {} }));
    withOverlay(repo, `${fakeTiers}routing:
  map:
    implement:
      prefer: [fake]
`);
    const out = await doctor(["--"], repo, [mkFake(script)]);
    expect(out).toMatch(/fake-1[\s\S]*prefer=implement#0/);
  });

  test("unclassified listed models compress to one count line, never rows", async () => {
    const repo = makeRepo({ "keep.txt": "x" });
    const script = join(repo, "fake.json");
    writeFileSync(script, JSON.stringify({ tasks: {} }));
    withOverlay(repo, fakeTiers);
    const out = await doctor(["--"], repo, [mkFake(script)]);
    // fake-2 is listed (probe) but never tiered → a count line only, never its own row
    expect(out).toMatch(/\(1 more listed, unclassified\)/);
    expect(out).not.toMatch(/^\s+fake-2\s/m);
  });

  test("no-decision catalog advisories collapse to one counted line; --models restores every row", async () => {
    const repo = makeRepo({ "keep.txt": "x" });
    const script = join(repo, "fake.json");
    writeFileSync(script, JSON.stringify({ tasks: {} }));
    withOverlay(repo, fakeTiers);

    // fake-2 is unclassified and uncovered (no catalog cache) — a no-decision row, collapsed by default
    const collapsed = await doctor(["--"], repo, [mkFake(script)], { catalog: readCachedCatalog(repo) });
    expect(collapsed).toMatch(/catalog · 1 uncovered by vendored catalog — tickmarkr doctor --models lists each/);
    expect(collapsed).not.toMatch(/catalog · fake-2/);

    const listed = await doctor(["--models"], repo, [mkFake(script)], { catalog: readCachedCatalog(repo) });
    expect(listed).toMatch(/catalog · fake-2 — uncovered by vendored catalog; no tier suggestion/);
    expect(listed).not.toMatch(/lists each/);
  });

  test("a turbo gate without --continue warns naming the abort hazard; --continue silences it", async () => {
    const repo = makeRepo({
      "keep.txt": "x",
      // the dossier shape: the gate command is `npm run -s test`, turbo hides one level down
      "package.json": JSON.stringify({ name: "t", scripts: { test: "turbo run test" } }),
    });
    const script = join(repo, "fake.json");
    writeFileSync(script, JSON.stringify({ tasks: {} }));
    withOverlay(repo, fakeTiers);

    const warned = await doctor(["--"], repo, [mkFake(script)]);
    expect(warned).toMatch(/gates\.test.*runs turbo without --continue/);
    expect(warned).toMatch(/verify forwarding first/);

    writeFileSync(join(repo, "package.json"), JSON.stringify({ name: "t", scripts: { test: "turbo run test --continue" } }));
    const silent = await doctor(["--"], repo, [mkFake(script)]);
    expect(silent).not.toMatch(/runs turbo without --continue/);
  });

  test("a model window declared in config renders in the doctor matrix", async () => {
    const repo = makeRepo({ "keep.txt": "x" });
    const script = join(repo, "fake.json");
    writeFileSync(script, JSON.stringify({ tasks: {} }));
    withOverlay(repo, `${fakeTiers}    windows:
      fake-1: 200000
`);
    const out = await doctor(["--"], repo, [mkFake(script)]);
    expect(out).toMatch(/fake-1\s+mid\s+200k\s+authed [\d.]+s/);
  });

});

// v1.22 T5: workspace-trust pre-flight
describe("workspace trust pre-flight (T5)", () => {
  const stubTrust = (id: string, v: TrustVerdict | undefined) =>
    ({
      id,
      vendor: "x",
      probe: async () => ({ installed: true, authed: true, models: [] }),
      ...(v ? { trust: () => v } : {}),
    }) as unknown as WorkerAdapter;

  test("doctor reports trusted, seeded, action-required, and n/a per adapter", async () => {
    const repo = makeRepo({ "keep.txt": "x" });
    const adapters = [
      stubTrust("codex", { status: "seeded" }),
      stubTrust("cursor-agent", {
        status: "action-required",
        command: 'accept the cursor-agent "Workspace Trust Required" dialog (Enter)',
      }),
      stubTrust("claude-code", { status: "trusted" }),
      stubTrust("pi", undefined), // no trust hook → n/a
    ];
    const out = await doctor(["--"], repo, adapters);
    expect(out).toMatch(/workspace trust:/);
    expect(out).toMatch(/✓ codex\s+trust: seeded/);
    expect(out).toMatch(/✓ claude-code\s+trust: trusted/);
    expect(out).toMatch(/! cursor-agent\s+trust: action-required — run ONCE: accept the cursor-agent "Workspace Trust Required" dialog \(Enter\)/);
    expect(out).toMatch(/= n\/a \(1\): pi/);
  });

  test("codex config without the repo root entry gets exactly one projects entry seeded, idempotently", () => {
    const home = mkdtempSync(join(tmpdir(), "codex-trust-"));
    const cfg = join(home, "config.toml");
    writeFileSync(cfg, 'model = "gpt-test"\n');
    const repo = makeRepo({ "keep.txt": "x" });

    const v1 = seedCodexTrust(repo, cfg);
    expect(v1.status).toBe("seeded");
    const text1 = readFileSync(cfg, "utf8");
    // exactly one correctly-formed projects entry for the realpath'd root
    const headers = text1.match(/\[projects\."[^"]+"\]/g) ?? [];
    expect(headers).toHaveLength(1);
    expect(text1).toMatch(/trust_level\s*=\s*"trusted"/);
    expect(hasCodexTrustedProject(text1, realpathSync(repo))).toBe(true);

    const v2 = seedCodexTrust(repo, cfg);
    expect(v2.status).toBe("trusted");
    const text2 = readFileSync(cfg, "utf8");
    // still exactly one entry — idempotent
    expect(text2.match(/\[projects\."[^"]+"\]/g)).toHaveLength(1);
    expect(text2.match(/trust_level\s*=\s*"trusted"/g)).toHaveLength(1);
  });
});

const withTTY = async (fn: () => Promise<void>) => {
  const stdoutTTY = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
  const noColor = process.env.NO_COLOR;
  delete process.env.NO_COLOR;
  Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: true });
  try {
    await fn();
  } finally {
    if (noColor !== undefined) process.env.NO_COLOR = noColor;
    else delete process.env.NO_COLOR;
    if (stdoutTTY) Object.defineProperty(process.stdout, "isTTY", stdoutTTY);
    else delete (process.stdout as { isTTY?: boolean }).isTTY;
  }
};

describe("T2 doctor brand surface", () => {
  const modelOutput = async () => {
    const repo = makeRepo({ "keep.txt": "x" });
    const script = join(repo, "fake.json");
    writeFileSync(script, JSON.stringify({ tasks: {} }));
    withOverlay(repo, `tiers:
  fake:
    vendor: fake
    channel: sub
    models:
      fake-1: mid
      fake-denied: cheap
`);
    const fake = new FakeAdapter(script);
    vi.spyOn(fake, "headlessCommand").mockImplementation((_prompt, model) =>
      model === "fake-denied" ? "printf 'credit exhausted'; exit 1" : "printf OK",
    );
    let out = "";
    let failToken = "";
    let okToken = "";
    await withTTY(async () => {
      const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
      try {
        out = await doctor(["--"], repo, [fake]);
        failToken = TOKENS.fail("unauthed:");
        okToken = TOKENS.ok("authed");
      } finally {
        writeSpy.mockRestore();
      }
    });
    return { out, failToken, okToken };
  };

  test("test: the doctor tty surface contains no ansi escape produced outside brand helpers", async () => {
    const repo = makeRepo({ "keep.txt": "x" });
    let out = "";
    let allowed = new Set<string>();
    await withTTY(async () => {
      const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
      try {
        out = await doctor(["--"], repo, ADAPTERS5);
        allowed = new Set(Object.values(TOKENS).flatMap((token) =>
          [...token("x").matchAll(/\x1b\[[0-9;]*m/g)].map(([sgr]) => sgr),
        ));
      } finally {
        writeSpy.mockRestore();
      }
    });
    for (const [sgr] of out.matchAll(/\x1b\[[0-9;]*m/g)) expect(allowed.has(sgr), sgr).toBe(true);
  });

  test("test: an unauthed model row renders the fail token on a tty", async () => {
    const { out, failToken } = await modelOutput();
    expect(out).toContain(failToken);
  });

  test("test: an authed model row renders the ok token on a tty", async () => {
    const { out, okToken } = await modelOutput();
    expect(out).toContain(okToken);
  });
});

// v1.65 T3: hardcoded-flag drift surface — advisory warn rows read from a real `<binary> --help`
// spawn (temp shell scripts stand in for installed CLIs; no agent CLI runs, zero tokens).
describe("hardcoded flag drift (v1.65 T3)", () => {
  const helpBin = (lines: string[]) => {
    const p = join(mkdtempSync(join(tmpdir(), "tickmarkr-helpbin-")), "fakecli");
    writeFileSync(p, `#!/bin/sh\ncat <<'EOF'\n${lines.join("\n")}\nEOF\n`, { mode: 0o755 });
    return p;
  };
  const stubFlags = (id: string, binary: string, flags: string[], installed = true) =>
    ({
      id,
      vendor: "x",
      probe: async () => ({ installed, authed: installed, models: [] }),
      hardcodedFlags: { binary, flags },
    }) as unknown as WorkerAdapter;

  test("test: an installed binary whose help output lacks a declared flag produces a doctor warning naming the adapter and the flag", async () => {
    const repo = makeRepo({ "keep.txt": "x" });
    const bin = helpBin(["Usage: fakecli [options]", "  -p, --print      print mode", "  --model <model>  choose model"]);
    const out = await doctor(["--"], repo, [stubFlags("claude-code", bin, ["-p", "--model", "--output-format"])]);
    expect(out).toMatch(/! flag drift: claude-code hardcodes --output-format/);
    expect(out).toContain(`${bin} --help no longer lists it`);
    // still-listed flags draw no warning; a short flag inside a longer one ("-p" ⊄ "--print") counts as listed
    expect(out).not.toMatch(/flag drift: claude-code hardcodes -p /);
    expect(out).not.toMatch(/flag drift: claude-code hardcodes --model/);
  });

  test("test: a binary whose help lists every declared flag produces no drift warning", async () => {
    const repo = makeRepo({ "keep.txt": "x" });
    const bin = helpBin(["Usage: fakecli [options]", "  -p, --print", "  --model <model>", "  --output-format <fmt>"]);
    const out = await doctor(["--"], repo, [stubFlags("claude-code", bin, ["-p", "--model", "--output-format"])]);
    expect(out).not.toMatch(/flag drift:/);
  });

  test("test: an unavailable binary produces no drift warning beyond the existing auth reporting", async () => {
    const repo = makeRepo({ "keep.txt": "x" });
    const gone = join(mkdtempSync(join(tmpdir(), "tickmarkr-nobin-")), "not-a-cli");
    const adapters = [
      stubFlags("claude-code", gone, ["-p", "--model"], false), // CLI not installed at all
      stubFlags("codex", gone, ["--sandbox"]), // probe says installed, but the help binary is gone
    ];
    const out = await doctor(["--"], repo, adapters);
    // the existing reporting still names the uninstalled CLI; drift never piles on for either case
    expect(out).toMatch(/✗ claude-code\s+not installed/);
    expect(out).not.toMatch(/flag drift:/);
  });
});

describe("OBS-145 resolved alias identity drift", () => {
  const claudeAliasAdapter = () =>
    ({
      id: "claude-code",
      vendor: "anthropic",
      probe: async () => ({ installed: true, authed: true, models: [] }),
      channels: (cfg: any) => channelsFromConfig("claude-code", cfg),
      headlessCommand: vi.fn(() => "printf OK"),
    }) as unknown as WorkerAdapter;

  const onlyOpus = `tiers:
  claude-code:
    vendor: anthropic
    channel: sub
    models:
      fable: null
      opus: frontier
      sonnet: null
      haiku: null
`;

  test("test: an alias whose resolved identity differs from its stamped identity produces a drift warning naming both identities and the reclassification policy", async () => {
    const repo = makeRepo({ "keep.txt": "x" });
    withOverlay(repo, onlyOpus);

    const out = await doctor(["--"], repo, [claudeAliasAdapter()], {
      banner: false,
      resolveClaudeAliasIdentity: () => "claude-opus-5",
    });

    expect(out).toContain("claude-code:opus");
    expect(out).toContain(CLAUDE_ALIAS_IDENTITY_STAMPS.opus);
    expect(out).toContain("claude-opus-5");
    expect(out).toContain("reclassify per benchmark policy");
  });

  test("test: an alias whose resolved identity matches its stamp produces no warning", async () => {
    const repo = makeRepo({ "keep.txt": "x" });
    withOverlay(repo, onlyOpus);

    const out = await doctor(["--"], repo, [claudeAliasAdapter()], {
      banner: false,
      resolveClaudeAliasIdentity: () => CLAUDE_ALIAS_IDENTITY_STAMPS.opus,
    });

    expect(out).not.toContain("resolved-identity drift:");
  });

  test("test: a drift warning changes no tier, no channel availability, and no routing decision", async () => {
    const repo = makeRepo({ "keep.txt": "x" });
    withOverlay(repo, `${onlyOpus}routing:
  map:
    implement:
      pin: { via: claude-code, model: opus }
`);
    const adapter = claudeAliasAdapter();
    const configPath = join(repo, ".tickmarkr", "config.yaml");
    const beforeBytes = readFileSync(configPath, "utf8");
    const beforeCfg = loadConfig(repo);
    const beforeChannels = adapter.channels(beforeCfg);
    const task = {
      id: "T2", title: "identity drift", goal: "prove advisory behavior",
      shape: "implement", complexity: 3, acceptance: ["advisory"],
    } as any;
    const beforeRoute = route(task, beforeCfg, beforeChannels);

    const out = await doctor(["--"], repo, [adapter], {
      banner: false,
      resolveClaudeAliasIdentity: () => "claude-opus-5",
    });

    const afterCfg = loadConfig(repo);
    const afterChannels = adapter.channels(afterCfg);
    expect(out).toContain("resolved-identity drift:");
    expect(readFileSync(configPath, "utf8")).toBe(beforeBytes);
    expect(afterCfg.tiers).toEqual(beforeCfg.tiers);
    expect(afterChannels).toEqual(beforeChannels);
    expect(route(task, afterCfg, afterChannels)).toEqual(beforeRoute);
  });
});

describe("OBS-117 doctor binary resolution + model-alias validation (T5)", () => {
  const stubBinary = (id: string, binary: string, installed = true, version = "1.0.0") =>
    ({
      id,
      vendor: "x",
      probe: async () => ({ installed, authed: installed, models: [], version }),
      hardcodedFlags: { binary, flags: ["--version"] },
    }) as unknown as WorkerAdapter;

  const stubListModels = (id: string, models: string[], detectedAt = "2026-07-22T12:00:00.000Z") =>
    ({
      id,
      vendor: "x",
      probe: async () => ({ installed: true, authed: true, models, modelsDetectedAt: detectedAt }),
      channels: (cfg: any) => channelsFromConfig(id, cfg),
      listModels: async () => models,
    }) as unknown as WorkerAdapter;

  test("doctor resolves an adapter's binary through the same shell resolution a dispatched worker pane uses rather than a bare process spawn", () => {
    const binDir = mkdtempSync(join(tmpdir(), "tickmarkr-shellbin-"));
    const bin = join(binDir, "fakecli");
    writeFileSync(bin, "#!/bin/sh\necho shell-resolved 9.9.9\n", { mode: 0o755 });
    const pathBefore = process.env.PATH;
    vi.stubEnv("PATH", `${binDir}:${pathBefore}`);
    try {
      const shell = probeVersionShell("fakecli", binDir);
      const bare = childProcess.spawnSync("fakecli", ["--version"], { encoding: "utf8" });
      expect(shell.installed).toBe(true);
      expect(shell.version).toBe("shell-resolved 9.9.9");
      const registrySrc = readFileSync(join(import.meta.dirname, "../../src/adapters/registry.ts"), "utf8");
      expect(registrySrc).toContain('spawnSync("bash", ["-lc"');
      expect(bare.status).toBe(0);
      expect((bare.stdout || bare.stderr).trim().split("\n")[0]).toBe(shell.version);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  test("OBS-503: a resolved binary whose --version crashes under the worker shell reports the crash — never a bare 'not installed' — and probeAll carries the reason into health", async () => {
    const binDir = mkdtempSync(join(tmpdir(), "tickmarkr-crashbin-"));
    const bin = join(binDir, "crashcli");
    // Live shape 2026-08-13: pi (#!/usr/bin/env node) resolved a stale /usr/local/bin/node v20
    // under bash -lc and crashed in undici, while the operator's interactive shell ran it fine.
    writeFileSync(bin, "#!/bin/sh\necho 'TypeError: webidl.util.markAsUncloneable is not a function' >&2\nexit 1\n", { mode: 0o755 });
    vi.stubEnv("PATH", `${binDir}:${process.env.PATH}`);
    try {
      const shell = probeVersionShell("crashcli", binDir);
      expect(shell.installed).toBe(false);
      expect(shell.authed).toBe(false);
      expect(shell.note).toContain(bin);
      expect(shell.note).toContain("exited 1");
      expect(shell.note).toContain("markAsUncloneable");

      // The shell verdict's note must REPLACE the adapter probe's own success note — storing
      // "auth verified …" beside installed:false is the self-contradiction doctor.json held.
      const adapter = {
        id: "crashcli",
        vendor: "x",
        probe: async () => ({ installed: true, authed: true, version: "0.84.1", models: [], note: "auth verified via crashcli --list-models" }),
        hardcodedFlags: { binary: "crashcli", flags: [] },
      } as unknown as WorkerAdapter;
      const health = await registry.probeAll([adapter], { cwd: binDir });
      expect(health.crashcli.installed).toBe(false);
      expect(health.crashcli.note).toContain("exited 1");
      expect(health.crashcli.note).not.toContain("auth verified");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  test("OBS-505 residue: compact doctor elides advisory lints behind a counted pointer while full doctor still prints each — capability and trust rows stay on both surfaces", async () => {
    const repo = makeRepo({ "keep.txt": "x" });
    // A stub with no listModels surface triggers the "no model-list surface" advisory lint.
    const adapter = {
      id: "lintcli",
      vendor: "x",
      probe: async () => ({ installed: true, authed: true, version: "1.0.0", models: [] }),
      channels: (cfg: Parameters<typeof channelsFromConfig>[1]) => channelsFromConfig("lintcli", cfg),
    } as unknown as WorkerAdapter;

    const full = await doctor(["--"], repo, [adapter], { banner: false });
    expect(full).toContain("lintcli: no model-list surface");

    const compact = await doctor(["--"], repo, [adapter], { banner: false, compact: true });
    expect(compact).not.toContain("no model-list surface");
    expect(compact).toMatch(/\d+ advisory lints? and model matrix elided — `tickmarkr doctor` prints them in full/);
    expect(compact).toContain("lintcli");
    expect(compact).toContain("1.0.0");
  });

  test("doctor warns when more than one install of the same adapter binary is resolvable on the machine", async () => {
    const repo = makeRepo({ "keep.txt": "x" });
    const dir1 = mkdtempSync(join(tmpdir(), "kimi-shadow-1-"));
    const dir2 = mkdtempSync(join(tmpdir(), "kimi-shadow-2-"));
    const bin1 = join(dir1, "kimi");
    const bin2 = join(dir2, "kimi");
    writeFileSync(bin1, "#!/bin/sh\necho kimi shadow 1.0.0\n", { mode: 0o755 });
    writeFileSync(bin2, "#!/bin/sh\necho kimi shadow 1.0.0\n", { mode: 0o755 });
    vi.stubEnv("PATH", `${dir1}:${dir2}:${process.env.PATH}`);
    try {
      const out = await doctor(["--"], repo, [stubBinary("kimi", "kimi")], { banner: false });
      expect(out).toMatch(/binary shadow: kimi/);
      expect(out).toContain(bin1);
      expect(out).toContain(bin2);
      expect(out).toMatch(/installs on PATH/);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  test("a configured model alias absent from the adapter CLI's own reported model list is marked invalid rather than treated as dispatchable", async () => {
    const repo = makeRepo({ "keep.txt": "x" });
    withOverlay(repo, `tiers:
  kimi:
    vendor: moonshot
    channel: sub
    models:
      kimi-code/k3: frontier
      kimi-code/kimi-for-coding: mid
      kimi-code/kimi-for-coding-highspeed: null
`);
    const models = ["kimi-code/k3"];
    const adapter = stubListModels("kimi", models);
    const health = { kimi: { installed: true, authed: true, models, modelsDetectedAt: "2026-07-22T12:00:00.000Z", modelAuth: { "kimi-code/k3": { authed: true, probedAt: "2026-07-22T12:00:00.000Z" }, "kimi-code/kimi-for-coding": { authed: true, probedAt: "2026-07-22T12:00:00.000Z" } } } };
    expect(invalidConfiguredModels({ tiers: { kimi: { vendor: "moonshot", channel: "sub", models: { "kimi-code/k3": "frontier", "kimi-code/kimi-for-coding": "mid" } } } } as any, "kimi", health.kimi)).toEqual(["kimi-code/kimi-for-coding"]);
    expect(discoverChannels({ tiers: { kimi: { vendor: "moonshot", channel: "sub", models: { "kimi-code/k3": "frontier", "kimi-code/kimi-for-coding": "mid" } } }, routing: { map: {}, floors: {}, allow: undefined, deny: undefined } } as any, [adapter], health).map((c) => c.model)).toEqual(["kimi-code/k3"]);
    const out = await doctor(["--"], repo, [adapter], { banner: false });
    expect(out).toMatch(/model alias: 1 channel\(s\) invalid/);
    expect(out).toContain("kimi-code/kimi-for-coding");
    expect(out).toContain("not in kimi's reported model list");
  });

  test("a configured model alias present in the adapter CLI's own reported model list is treated as dispatchable unchanged", async () => {
    const repo = makeRepo({ "keep.txt": "x" });
    withOverlay(repo, `tiers:
  kimi:
    vendor: moonshot
    channel: sub
    models:
      kimi-code/k3: frontier
      kimi-code/kimi-for-coding: null
      kimi-code/kimi-for-coding-highspeed: null
`);
    const models = ["kimi-code/k3"];
    const adapter = stubListModels("kimi", models);
    const cfg = { tiers: { kimi: { vendor: "moonshot", channel: "sub", models: { "kimi-code/k3": "frontier" } } }, routing: { map: {}, floors: {}, allow: undefined, deny: undefined } } as any;
    const health = { kimi: { installed: true, authed: true, models, modelsDetectedAt: "2026-07-22T12:00:00.000Z", modelAuth: { "kimi-code/k3": { authed: true, probedAt: "2026-07-22T12:00:00.000Z" } } } };
    expect(discoverChannels(cfg, [adapter], health).map((c) => c.model)).toEqual(["kimi-code/k3"]);
    expect(modelAliasExclusions(cfg, [adapter], health)).toEqual([]);
    const out = await doctor(["--"], repo, [adapter], { banner: false });
    expect(out).not.toMatch(/model alias:/);
  });
});

describe("T3 brand banner (TTY gate)", () => {
  const withoutTTY = async (fn: () => Promise<void>) => {
    const stdoutTTY = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
    Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: false });
    try {
      await fn();
    } finally {
      if (stdoutTTY) Object.defineProperty(process.stdout, "isTTY", stdoutTTY);
      else delete (process.stdout as { isTTY?: boolean }).isTTY;
    }
  };

  test("TTY stdout emits the banner at start, before the report body returns", async () => {
    const repo = makeRepo({ "keep.txt": "x" });
    await withTTY(async () => {
      const writes: string[] = [];
      const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
        writes.push(String(chunk));
        return true;
      });
      const out = await doctor(["--"], repo, ADAPTERS5);
      writeSpy.mockRestore();
      expect(writes.some((w) => w.includes("spec in, verified work out."))).toBe(true);
      expect(out.startsWith(BANNER)).toBe(false); // the start write is the single emission — body stays banner-free
      expect(out).toContain("capability matrix");
    });
  });

  test("non-TTY stdout is byte-identical to pre-T3 (no banner prefix)", async () => {
    const repo = makeRepo({ "keep.txt": "x" });
    let out: string;
    await withoutTTY(async () => {
      out = await doctor(["--"], repo, ADAPTERS5);
    });
    expect(out!.startsWith(BANNER)).toBe(false);
    expect(out!).toMatch(/^tickmarkr doctor — capability matrix:/);
    const repo2 = makeRepo({ "keep.txt": "x" });
    let out2: string;
    await withoutTTY(async () => {
      out2 = await doctor(["--"], repo2, ADAPTERS5);
    });
    expect(out2!).toBe(out!);
  });
});

describe("T7 deny∩prefer static preflight (doctor + resume)", () => {
  afterEach(() => { delete process.env.TICKMARKR_FAKE_SCRIPT; });

  test("a prefer chain naming only channels fully covered by routing.deny is flagged by doctor before any run starts", async () => {
    const repo = makeRepo({ "keep.txt": "x" });
    withOverlay(repo, `routing:
  deny:
    adapters: [cursor-agent, codex]
  map:
    implement:
      prefer: [cursor-agent, codex]
`);
    const out = await doctor(["--"], repo, ADAPTERS5, { banner: false });
    expect(out).toMatch(/deny∩prefer: routing\.map\.implement\.prefer cursor-agent > codex fully disallowed by routing\.deny \(cursor-agent\)/);
  });

  test("a pin naming a channel covered by routing.deny is flagged by doctor before any run starts", async () => {
    const repo = makeRepo({ "keep.txt": "x" });
    withOverlay(repo, `routing:
  deny:
    adapters: [claude-code]
  map:
    plan:
      pin: { via: claude-code, model: fable }
`);
    const out = await doctor(["--"], repo, ADAPTERS5, { banner: false });
    expect(out).toMatch(/deny∩prefer: routing\.map\.plan\.pin claude-code:fable is disallowed by routing\.deny \(claude-code\)/);
  });

  test("a prefer chain with at least one non-denied channel is not flagged", async () => {
    const repo = makeRepo({ "keep.txt": "x" });
    withOverlay(repo, `routing:
  deny:
    adapters: [codex]
  map:
    implement:
      prefer: [cursor-agent, codex]
`);
    const out = await doctor(["--"], repo, ADAPTERS5, { banner: false });
    expect(out).not.toMatch(/deny∩prefer:/);
  });

  test("resuming a run whose config carries a deny-prefer collision is flagged before the daemon dispatches another task", async () => {
    const { repo, scriptPath } = setupRepo(
      [T("T1")],
      { tasks: { T1: [{ shell: "echo one", result: { ok: true, summary: "t1" } }] } },
      `routing:
  deny:
    adapters: [fake]
  map:
    implement:
      prefer: [fake]
`,
    );
    process.env.TICKMARKR_FAKE_SCRIPT = scriptPath;
    const j = Journal.create(repo, "run-deny-prefer");
    const baseRef = await gitHead(repo);
    j.append("run-start", undefined, { baseRef, commands: {}, graphDefinitionHash: graphDefinitionHash(loadGraph(repo)) });
    j.append("task-dispatch", "T1", { assignment: { adapter: "fake", model: "fake-1" }, attempt: 0 });
    writeFileSync(join(j.dir, "baseline.json"), JSON.stringify({ commands: {} }));

    await expect(resume(["run-deny-prefer"], repo)).rejects.toThrow(/deny∩prefer: routing\.map\.implement\.prefer fake fully disallowed/);
    const events = Journal.open(repo, "run-deny-prefer").read();
    expect(events.some((e) => e.event === "run-resume")).toBe(false);
    expect(events.filter((e) => e.event === "task-dispatch")).toHaveLength(1);
  });
});

test("test: doctor and fleet print one line naming what each catalog leg did after an auto-refresh in which one leg updated and one failed whereas a surface that prints retained cache beside a rewritten cache fails", async () => {
  const cache = (repo: string) => {
    mkdirSync(join(repo, ".tickmarkr"), { recursive: true });
    writeFileSync(join(repo, ".tickmarkr", "catalog-cache.json"), JSON.stringify({
      schemaVersion: 1,
      fetchedAt: "2026-09-01T00:00:00.000Z",
      modelsDev: { anthropic: { id: "anthropic", models: { seed: { id: "seed", cost: { input: 1, output: 2 } } } } },
      legFetchedAt: { modelsDev: "2026-09-01T00:00:00.000Z", liveBench: "2026-09-01T00:00:00.000Z" },
    }));
  };
  const response = (body: unknown, status = 200) => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => String(body),
  });
  const routes = () => vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    if (url.startsWith(MODELS_DEV_CATALOG_URL)) return response({ anthropic: { id: "anthropic", models: { fresh: { id: "fresh", cost: { input: 1, output: 2 } } } } });
    if (url.startsWith(LIVEBENCH_TABLE_URL)) return response("", 500);
    throw new Error(`unexpected ${url}`);
  });
  const now = () => new Date("2026-09-20T00:00:00.000Z");
  vi.stubEnv("ARTIFICIAL_ANALYSIS_API_KEY", "");

  const doctorRepo = makeRepo({ "keep.txt": "x" });
  cache(doctorRepo);
  const doctorOut = await doctor(["--"], doctorRepo, [stub("probe")], { banner: false, catalogNow: now, catalogFetcher: routes() });
  const doctorLines = doctorOut.split("\n").filter((line) => line.includes("model catalog auto-refresh"));
  expect(doctorLines).toHaveLength(1);
  expect(doctorLines[0]).toContain("models.dev updated");
  expect(doctorLines[0]).toContain("Artificial Analysis skipped");
  expect(doctorLines[0]).toContain("LiveBench failed");
  expect(doctorLines[0]).not.toContain("retained cache");

  const fleetRepo = makeRepo({ "keep.txt": "x" });
  cache(fleetRepo);
  const fleetOut = await fleet(["--print"], fleetRepo, [], { catalogFetcher: routes(), catalogNow: now });
  const fleetLines = (fleetOut as string).split("\n").filter((line) => line.includes("fleet: catalog auto-refresh"));
  expect(fleetLines).toHaveLength(1);
  expect(fleetLines[0]).toContain("models.dev updated");
  expect(fleetLines[0]).toContain("Artificial Analysis skipped");
  expect(fleetLines[0]).toContain("LiveBench failed");
  expect(fleetLines[0]).not.toContain("retained cache");
});

test("doctor reports every catalog leg when an automatic refresh fully fails", async () => {
  const repo = makeRepo({ "keep.txt": "x" });
  const fetcher = vi.fn(async () => { throw new Error("offline"); });
  vi.stubEnv("ARTIFICIAL_ANALYSIS_API_KEY", "");

  const out = await doctor(["--"], repo, [stub("probe")], {
    banner: false,
    catalogFetcher: fetcher,
    catalogNow: () => new Date("2026-09-20T00:00:00.000Z"),
  });

  expect(fetcher.mock.calls.map(([url]) => String(url))).toEqual([
    MODELS_DEV_CATALOG_URL,
    LIVEBENCH_TABLE_URL,
  ]);
  const refreshLines = out.split("\n").filter((line) => line.includes("model catalog auto-refresh"));
  expect(refreshLines).toHaveLength(1);
  expect(refreshLines[0]).toContain("models.dev failed");
  expect(refreshLines[0]).toContain("Artificial Analysis skipped");
  expect(refreshLines[0]).toContain("LiveBench failed");
  expect(readCachedCatalog(repo).source).toBe("vendored");
});

test("test: a repository with no catalog cache file treats the vendored snapshot as stale for the refresh trigger so doctor and fleet attempt the keyless legs whereas a trigger that never fires on the vendored source fails", async () => {
  const response = (body: unknown) => ({ ok: true, status: 200, json: async () => body, text: async () => String(body) });
  const routes = () => vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    if (url.startsWith(MODELS_DEV_CATALOG_URL)) return response({ anthropic: { id: "anthropic", models: { fresh: { id: "fresh", cost: { input: 1, output: 2 } } } } });
    if (url.startsWith(LIVEBENCH_TABLE_URL)) return response("model,javascript,typescript,python,code_generation,code_completion\nfresh,1,2,3,4,5\n");
    if (url.startsWith(LIVEBENCH_CATEGORIES_URL)) return response({ "Agentic Coding": ["javascript", "typescript", "python"], Coding: ["code_generation", "code_completion"] });
    throw new Error(`unexpected ${url}`);
  });
  vi.stubEnv("ARTIFICIAL_ANALYSIS_API_KEY", "");

  const doctorRepo = makeRepo({ "keep.txt": "x" });
  const doctorFetch = routes();
  vi.stubGlobal("fetch", doctorFetch);
  await doctor(["--"], doctorRepo, [stub("probe")], { banner: false });
  expect(doctorFetch.mock.calls.map(([url]) => String(url))).toEqual([
    MODELS_DEV_CATALOG_URL,
    LIVEBENCH_TABLE_URL,
    LIVEBENCH_CATEGORIES_URL,
  ]);

  const fleetRepo = makeRepo({ "keep.txt": "x" });
  const fleetFetch = routes();
  vi.stubGlobal("fetch", fleetFetch);
  await fleet(["--print"], fleetRepo, []);
  expect(fleetFetch.mock.calls.map(([url]) => String(url))).toEqual([
    MODELS_DEV_CATALOG_URL,
    LIVEBENCH_TABLE_URL,
    LIVEBENCH_CATEGORIES_URL,
  ]);
});

test("test: doctor and fleet against a catalog cache older than seven days invoke the keyless models.dev and LiveBench legs with a ten-second timeout and print one reason line when a leg fails while the same commands against a fresh cache and plan compile and run against the stale one invoke no fetch and the AA leg is invoked only with a key whereas a doctor that refreshes with a key alone or a plan that fetches fails", async () => {
  const cache = (repo: string, fetchedAt: string) => {
    mkdirSync(join(repo, ".tickmarkr"), { recursive: true });
    writeFileSync(join(repo, ".tickmarkr", "catalog-cache.json"), JSON.stringify({
      schemaVersion: 1,
      fetchedAt,
      modelsDev: { anthropic: { id: "anthropic", models: { seed: { id: "seed", cost: { input: 1, output: 2 } } } } },
    }));
  };
  const response = (body: unknown, status = 200) => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => String(body),
  });
  const routes = (failLiveBench = false) => vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    if (url.startsWith(MODELS_DEV_CATALOG_URL)) return response({ anthropic: { id: "anthropic", models: { fresh: { id: "fresh", cost: { input: 1, output: 2 } } } } });
    if (url.startsWith(LIVEBENCH_TABLE_URL)) return failLiveBench
      ? response("", 500)
      : response("model,javascript,typescript,python,code_generation,code_completion\nfresh,1,2,3,4,5\n");
    if (url.startsWith(LIVEBENCH_CATEGORIES_URL)) return response({ "Agentic Coding": ["javascript", "typescript", "python"], Coding: ["code_generation", "code_completion"] });
    if (url.startsWith(ARTIFICIAL_ANALYSIS_CATALOG_URL)) return response({ pagination: { has_more: false }, data: [] });
    throw new Error(`unexpected ${url}`);
  });
  const now = () => new Date("2026-09-20T00:00:00.000Z");
  const staleAt = "2026-09-01T00:00:00.000Z";
  vi.stubEnv("ARTIFICIAL_ANALYSIS_API_KEY", "");

  const doctorRepo = makeRepo({ "keep.txt": "x" });
  cache(doctorRepo, staleAt);
  const doctorFetch = routes(true);
  const doctorOut = await doctor(["--"], doctorRepo, [stub("probe")], { banner: false, catalogNow: now, catalogFetcher: doctorFetch });
  const doctorUrls = doctorFetch.mock.calls.map(([url]) => String(url));
  expect(doctorUrls).toEqual([MODELS_DEV_CATALOG_URL, LIVEBENCH_TABLE_URL]);
  expect(doctorOut.split("\n").filter((line) => line.includes("catalog auto-refresh —"))).toHaveLength(1);
  expect(doctorOut).toContain("LiveBench HTTP 500");
  expect(CATALOG_REFRESH_TIMEOUT_MS).toBe(10_000);
  expect(doctorFetch.mock.calls.every(([, init]) => (init as RequestInit).signal instanceof AbortSignal)).toBe(true);

  const fleetRepo = makeRepo({ "keep.txt": "x" });
  cache(fleetRepo, staleAt);
  const fleetFetch = routes(true);
  const fleetOut = await fleet(["--print"], fleetRepo, [], { catalogFetcher: fleetFetch, catalogNow: now });
  expect(fleetFetch.mock.calls.map(([url]) => String(url))).toEqual([
    MODELS_DEV_CATALOG_URL,
    LIVEBENCH_TABLE_URL,
  ]);
  expect(fleetOut.split("\n").filter((line) => line.includes("fleet: catalog auto-refresh —"))).toEqual([
    expect.stringContaining("# fleet: catalog auto-refresh — catalog refresh: models.dev updated"),
  ]);
  expect(fleetOut as string).toContain("LiveBench failed");
  expect(fleetFetch.mock.calls.some(([url]) => String(url).startsWith(ARTIFICIAL_ANALYSIS_CATALOG_URL))).toBe(false);

  const keyedRepo = makeRepo({ "keep.txt": "x" });
  cache(keyedRepo, staleAt);
  const keyedFetch = routes();
  vi.stubEnv("ARTIFICIAL_ANALYSIS_API_KEY", "key");
  await doctor(["--"], keyedRepo, [stub("probe")], { banner: false, catalogNow: now, catalogFetcher: keyedFetch });
  expect(keyedFetch.mock.calls.some(([url]) => String(url).startsWith(ARTIFICIAL_ANALYSIS_CATALOG_URL))).toBe(true);
  vi.stubEnv("ARTIFICIAL_ANALYSIS_API_KEY", "");

  const freshRepo = makeRepo({
    "tickmarkr.spec.md": "<!-- tickmarkr:spec -->\n## T1: no fetch\n- acceptance:\n  - command: true\n",
  });
  cache(freshRepo, "2026-09-19T00:00:00.000Z");
  const noFetch = routes();
  await doctor(["--"], freshRepo, [stub("probe")], { banner: false, catalogNow: now, catalogFetcher: noFetch });
  expect(noFetch).not.toHaveBeenCalled();
  await fleet(["--print"], freshRepo, [], { catalogFetcher: noFetch, catalogNow: now });
  expect(noFetch).not.toHaveBeenCalled();

  vi.stubEnv("ARTIFICIAL_ANALYSIS_API_KEY", "");
  cache(freshRepo, staleAt);
  const globalFetch = vi.fn(async () => { throw new Error("catalog fetch forbidden"); });
  vi.stubGlobal("fetch", globalFetch);
  await compileCommand(["tickmarkr.spec.md"], freshRepo, undefined);
  await expect(planCommand([], freshRepo, [], undefined)).resolves.toBeTypeOf("string");
  const { repo: runRepo, scriptPath } = setupRepo([T("T1")], {
    tasks: {
      T1: [{
        shell: "printf run > run.txt && git add run.txt && git commit --no-gpg-sign -m run",
        result: { ok: true, summary: "run" },
      }],
    },
  });
  cache(runRepo, staleAt);
  registry.writeDoctor(runRepo, {
    fake: { installed: true, authed: true, models: [], modelAuth: authedModels(["fake-1", "fake-2"]) },
  });
  process.env.TICKMARKR_FAKE_SCRIPT = scriptPath;
  try {
    await expect(runCommand(["--driver", "subprocess"], runRepo)).resolves.toMatchObject({ code: 0 });
  } finally {
    delete process.env.TICKMARKR_FAKE_SCRIPT;
  }
  expect(globalFetch).not.toHaveBeenCalled();
});

describe("§4.4 LiveBench table staleness lint", () => {
  // Dates derive from the constant under test: bumping LIVEBENCH_TABLE_DATE must not need a test edit.
  const pinnedMs = Date.parse(`${LIVEBENCH_TABLE_DATE.replace(/_/g, "-")}T00:00:00Z`);
  const clockAt = (daysPast: number) => () => new Date(pinnedMs + daysPast * 86_400_000);

  test("test: doctor under an injected clock 91 days past the pinned LiveBench table date prints a staleness lint naming the pinned date and the github contents url and prints none at 89 days, so an unlinted stale constant or an always-on warning fails", async () => {
    const repo = makeRepo({ "keep.txt": "x" });
    const adapters = [stub("lintcli")];

    const stale = await doctor(["--"], repo, adapters, { banner: false, catalogNow: clockAt(91) });
    expect(stale).toContain(LIVEBENCH_TABLE_DATE);
    expect(stale).toContain("https://api.github.com/repos/LiveBench/livebench.github.io/contents/public");
    expect(stale).toMatch(/91 days old/);
    expect(stale).toContain("bump LIVEBENCH_TABLE_DATE");

    // One day short of the 90-day window on either side of the boundary: silent.
    for (const daysPast of [0, 89, 90]) {
      const fresh = await doctor(["--"], repo, adapters, { banner: false, catalogNow: clockAt(daysPast) });
      expect(fresh, `${daysPast}d`).not.toContain(LIVEBENCH_TABLE_DATE);
      expect(fresh, `${daysPast}d`).not.toContain("api.github.com/repos/LiveBench");
    }
  });
});

test("Production doctor --fix-only repairs a seeded supported runner-ignore defect and reports the actual diff/result with adapters present and zero fake probe calls. Normal explicitly requested doctor probing still invokes the configured fake probe and records its result. A PATH with all CLIs removed, an unchanged broken runner reported repaired or fix-only falling through into probes fails.", async () => {
  const repo = makeRepo({
    "package.json": JSON.stringify({ scripts: { test: "vitest run" } }),
    "vitest.config.ts": `export default { test: { include: ["**/*.test.ts"], exclude: ["node_modules"] } };`,
  });
  withOverlay(repo, `tiers:
  fixture:
    vendor: fixture
    channel: sub
    models:
      fixture-1: mid
`);
  const probe = vi.fn(async () => ({ installed: true, authed: true, models: [] }));
  const modelCall = vi.fn(() => "printf OK");
  const adapter = {
    id: "fixture",
    vendor: "fixture",
    probe,
    headlessCommand: modelCall,
  } as unknown as WorkerAdapter;

  const repaired = await doctor(["--fix-only"], repo, [adapter], { banner: false });
  expect(probe).not.toHaveBeenCalled();
  expect(modelCall).not.toHaveBeenCalled();
  expect(repaired).toContain("repair result: wrote");
  expect(repaired).toContain("repair verification: pass");
  expect(repaired).toContain("repair diff:");
  expect(repaired).toContain(".tickmarkr/**");
  expect(readFileSync(join(repo, "vitest.config.ts"), "utf8")).toContain(".tickmarkr/**");

  const probed = await doctor(["--probe"], repo, [adapter], { banner: false });
  expect(probe).toHaveBeenCalledOnce();
  expect(modelCall).toHaveBeenCalledOnce();
  expect(probed).toContain("fixture-1");
  const cached = JSON.parse(readFileSync(join(repo, ".tickmarkr", "doctor.json"), "utf8"));
  expect(cached.fixture.modelAuth["fixture-1"].authed).toBe(true);
});

test("Production doctor’s probe preflight exposes configured model-call scope, cache policy and affected destinations plus the catalog-only alternative before executing probes, while its cached diagnostic interface returns source/age and unknown/unavailable states with zero calls. The same seeded adapter is positively callable by explicit probe. Cached navigation incrementing its counter or a never-probed model displayed as passed fails.", async () => {
  const repo = makeRepo({ "keep.txt": "x" });
  withOverlay(repo, `tiers:
  fixture:
    vendor: fixture
    channel: sub
    models:
      fixture-1: mid
      fixture-2: cheap
`);
  const probe = vi.fn(async () => ({ installed: true, authed: true, models: [] }));
  const modelCall = vi.fn(() => "printf OK");
  const adapter = {
    id: "fixture",
    vendor: "fixture",
    probe,
    headlessCommand: modelCall,
  } as unknown as WorkerAdapter;

  const preflight = await doctor(["--probe-preflight"], repo, [adapter], { banner: false });
  expect(preflight).toContain("configured model-call scope: 2 models — fixture:fixture-1, fixture:fixture-2");
  expect(preflight).toContain("cache policy:");
  expect(preflight).toContain("affected destinations: .tickmarkr/doctor.json");
  expect(preflight).toContain("catalog-only alternative: tickmarkr doctor --refresh-catalog");
  expect(probe).not.toHaveBeenCalled();
  expect(modelCall).not.toHaveBeenCalled();

  const unavailable = await doctor(["--cached"], repo, [adapter], { banner: false });
  expect(unavailable).toContain("cache source: unavailable");
  expect(unavailable).toContain("cache age: unavailable");
  expect(unavailable).toContain("fixture:fixture-1 unknown (cache unavailable)");
  expect(unavailable).not.toContain("fixture:fixture-1 passed");
  expect(probe).not.toHaveBeenCalled();
  expect(modelCall).not.toHaveBeenCalled();

  const active = await doctor(["--probe"], repo, [adapter], { banner: false });
  expect(active).toContain("fixture-1");
  expect(probe).toHaveBeenCalledOnce();
  expect(modelCall).toHaveBeenCalledTimes(2);

  const cached = await doctor(["--cached"], repo, [adapter], { banner: false });
  expect(cached).toContain("cache source: .tickmarkr/doctor.json");
  expect(cached).toMatch(/cache age: \d+m/);
  expect(cached).toContain("fixture:fixture-1 passed (cached");
  expect(probe).toHaveBeenCalledOnce();
  expect(modelCall).toHaveBeenCalledTimes(2);

  registry.writeDoctor(repo, {
    fixture: { installed: false, authed: false, modelAuth: {} },
  });
  const unavailableAdapter = await doctor(["--cached"], repo, [adapter], { banner: false });
  expect(unavailableAdapter).toContain("fixture:fixture-1 unavailable (adapter not installed)");
  expect(probe).toHaveBeenCalledOnce();
  expect(modelCall).toHaveBeenCalledTimes(2);
});

describe("OBS-1143 an unknown alias identity stays conservatively denied", () => {
  const opusDenyCfg = `tiers:
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
  const spec = "<!-- tickmarkr:spec -->\n## T1: Keep the widget observable\n- goal: Keep widgetValue observable through widgetValue.\n- shape: implement\n- complexity: 2\n- files: src/widget.ts, tests/widget.test.ts\n- acceptance:\n  - test: widgetValue returns one | suite: tests/widget.test.ts\n";
  const refusal = "routing.map.implement.pool claude-code:opus fully disallowed by routing.deny (claude-code:claude-opus-5)";
  const opusAdapter = () => ({
    id: "claude-code",
    vendor: "anthropic",
    probe: async () => ({ installed: true, authed: true, models: [] }),
    channels: (cfg: any) => channelsFromConfig("claude-code", cfg),
    headlessCommand: vi.fn(() => "printf OK"),
  }) as unknown as WorkerAdapter;
  const repoFor = () => {
    const repo = makeRepo({ "feature.spec.md": spec, "src/widget.ts": "export const widgetValue = () => 1;\n" });
    withOverlay(repo, opusDenyCfg);
    return repo;
  };
  const strictCompile = (repo: string) => compileCommand(["feature.spec.md", "--strict", "--dry-run"], repo, undefined);

  test("test: doctor and strict compile preserve conservative denial for an unknown opus identity versus the allowed observed identity, so treating an unknown alias as proven newer fails", async () => {
    // no doctor cache at all: compile reads what is cached and never spends a probe to learn more
    const uncached = repoFor();
    const probeAll = vi.spyOn(registry, "probeAll");
    await expect(strictCompile(uncached)).rejects.toThrow(refusal);
    expect(probeAll).not.toHaveBeenCalled();
    probeAll.mockRestore();

    for (const [identity, admitted] of [[undefined, false], ["claude-opus-5-5", true]] as const) {
      const repo = repoFor();
      const out = await doctor(["--"], repo, [opusAdapter()], { banner: false, resolveClaudeAliasIdentity: () => identity });
      const saved = JSON.parse(readFileSync(join(repo, ".tickmarkr", "doctor.json"), "utf8"));
      expect(saved["claude-code"].modelAuth?.opus?.identity).toBe(identity);
      if (admitted) {
        expect(out).not.toContain("deny∩prefer:");
        expect(out).toMatch(/opus\s+frontier\s.*denied=—/);
        await expect(strictCompile(repo)).resolves.toMatch(/validated feature\.spec\.md/);
      } else {
        expect(out).toContain(`deny∩prefer: ${refusal}`);
        expect(out).toMatch(/opus\s+frontier\s.*denied=claude-code:claude-opus-5/);
        await expect(strictCompile(repo)).rejects.toThrow(refusal);
      }
    }
  }, 60_000);
});

describe("B1a codex retirement notices (doctor)", () => {
  // The notice as the installed codex 0.159.0 cache carries it (models_cache.json fetched 2026-09-29T16:09Z).
  const NOTICE = {
    model: "gpt-5.6-sol",
    migration_markdown: "GPT-5.5 retires on October 14, 2026. Switch to GPT-5.6 Sol to continue working in Codex.",
    retirement_at: "2026-10-14T19:00:00Z",
  };
  // The production codex adapter and its cache reader (via CODEX_HOME), minus every surface that would
  // touch the machine: no version binary, no headless probe command (zero tokens), no trust store.
  const cacheCodex = {
    ...codex,
    probe: async () => ({ installed: true, authed: true, version: "codex-cli fixture", models: [] }),
    hardcodedFlags: undefined,
    headlessCommand: undefined,
    trust: undefined,
  } as unknown as WorkerAdapter;
  const repoWithGpt55 = () => {
    const repo = makeRepo({ "keep.txt": "x" });
    withOverlay(repo, "tiers:\n  codex:\n    models:\n      gpt-5.5: frontier\n");
    return repo;
  };
  // every configured codex id is listed with upgrade:null unless `entry` says otherwise for gpt-5.5
  const codexHome = (repo: string, cache: "missing" | "malformed" | ((slug: string) => Record<string, unknown>)) => {
    const home = mkdtempSync(join(tmpdir(), "tickmarkr-b1a-codex-home-"));
    if (cache === "malformed") writeFileSync(join(home, "models_cache.json"), "{ not valid json");
    else if (cache !== "missing") {
      const models = Object.keys(loadConfig(repo).tiers.codex?.models ?? {})
        .map((slug) => ({ slug, visibility: "list", upgrade: null, ...cache(slug) }));
      writeFileSync(join(home, "models_cache.json"), JSON.stringify({ fetched_at: "2026-09-29T16:09:00Z", models }));
    }
    return home;
  };
  const doctorAt = async (repo: string, home: string, iso: string) => {
    vi.stubEnv("CODEX_HOME", home);
    try {
      return await doctor(["--"], repo, [cacheCodex], { banner: false, now: () => new Date(iso) });
    } finally {
      vi.unstubAllEnvs();
    }
  };
  const retiringCache = (slug: string) => (slug === "gpt-5.5" ? { upgrade: NOTICE } : {});

  test("doctor distinguishes gpt-5.5 retiring before 2026-10-14T19:00:00Z from retired at or after that injected instant and names successor gpt-5.6-sol; listed-clean hidden malformed or missing caches retain their respective known or unknown diagnostics", async () => {
    const repo = repoWithGpt55();
    const home = codexHome(repo, retiringCache);

    const before = await doctorAt(repo, home, "2026-10-14T18:59:59.999Z");
    expect(before).toContain("codex: gpt-5.5 retires 2026-10-14T19:00:00Z per the CLI's notice; successor gpt-5.6-sol");
    expect(before).not.toContain("gpt-5.5 retired");
    // the other listed ids carry upgrade:null — known clean, so neither a notice nor an unknown line
    expect(before).not.toMatch(/codex: gpt-5\.6-sol retir/);
    expect(before).not.toContain("retirement unknown");

    for (const iso of ["2026-10-14T19:00:00.000Z", "2026-10-20T00:00:00.000Z"]) {
      const after = await doctorAt(repo, home, iso);
      expect(after, iso).toContain("codex: gpt-5.5 retired 2026-10-14T19:00:00Z per the CLI's notice; successor gpt-5.6-sol");
      expect(after, iso).not.toContain("gpt-5.5 retires");
    }

    // listed-clean: gpt-5.5 listed with upgrade:null is known clean — no notice, no unknown, no tombstone
    const clean = await doctorAt(repo, codexHome(repo, () => ({})), "2026-10-20T00:00:00.000Z");
    expect(clean).not.toMatch(/gpt-5\.5 retir/);
    expect(clean).not.toContain("retirement unknown");
    expect(clean).not.toContain("tiers lists gpt-5.5");

    // hidden: v2.6.9 (queue row 64) — the CLI hides a model before retiring it, so the dated notice on the hidden
    // entry speaks in place of the bare missing-listing advisory
    const hidden = await doctorAt(repo, codexHome(repo, (slug) => (slug === "gpt-5.5" ? { visibility: "hide", upgrade: NOTICE } : {})), "2026-10-01T00:00:00.000Z");
    expect(hidden).toContain("codex: gpt-5.5 retires 2026-10-14T19:00:00Z per the CLI's notice (the CLI no longer lists it); successor gpt-5.6-sol");
    expect(hidden).not.toContain("tiers lists gpt-5.5");
    expect(hidden).not.toContain("retirement unknown");

    // a malformed notice on a listed id is unknown for that id — never clean, never a guessed date
    const badNotice = await doctorAt(repo, codexHome(repo, (slug) => (slug === "gpt-5.5" ? { upgrade: { model: "gpt-5.6-sol", retirement_at: "mid-October" } } : {})), "2026-10-01T00:00:00.000Z");
    expect(badNotice).toContain("codex: retirement unknown for gpt-5.5 — the CLI's notice is absent or unreadable");
    expect(badNotice).not.toMatch(/gpt-5\.5 retir/);

    // a malformed or missing cache file is unknown for the whole listing
    for (const cache of ["malformed", "missing"] as const) {
      const unknown = await doctorAt(repo, codexHome(repo, cache), "2026-10-20T00:00:00.000Z");
      expect(unknown, cache).toContain("codex: no detection data — run tickmarkr doctor");
      expect(unknown, cache).not.toMatch(/gpt-5\.5 retir/);
      expect(unknown, cache).not.toContain("tiers lists gpt-5.5");
    }
  });
});

describe("v2.6.5 T3 — Codex linked-worktree commit probe", () => {
  test("doctor reports linked-worktree git metadata protected only when an injected Codex sandbox writes the ordinary control but denies index.lock while allowed metadata and unreadable probes remain distinct", async () => {
    const control = (p: CodexCommitProbe) => writeFileSync(p.control, p.token);
    // v2.6.6 T9 (K): the receipts are a real fixture-branch commit plus two denied shared-metadata members
    const commit = (p: CodexCommitProbe) => {
      control(p);
      childProcess.execFileSync("git", ["add", "--", p.control], { cwd: p.worktree });
      childProcess.execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t.invalid", "commit", "-q", "--no-gpg-sign", "-m", `tickmarkr-probe ${p.token}`], { cwd: p.worktree });
    };
    const sandboxes: Record<string, CodexSandbox> = {
      protected: async (p) => { control(p); return "control=ok\ncommit=fail\nhook=denied\nroot=denied\n"; },
      allowed: async (p) => { commit(p); return "control=ok\ncommit=ok\nhook=denied\nroot=denied\n"; },
      // the sandbox ran and the control landed, but nothing readable says what happened to the metadata
      unknown: async (p) => { control(p); return "control=ok\n"; },
      // a denial claim without the positive control is a sandbox that never ran, not a protected verdict
      "unknown ": async () => "commit=fail\nhook=denied\nroot=denied\n",
    };
    const rows: Record<string, string> = {};
    for (const [want, codexSandbox] of Object.entries(sandboxes)) {
      const repo = makeRepo({ "keep.txt": "x" });
      const out = await doctor(["--"], repo, [stub("codex")], { banner: false, codexSandbox });
      const saved = JSON.parse(readFileSync(join(repo, ".tickmarkr", "doctor.json"), "utf8"));
      expect(saved.codex.codexCommit, want).toBe(want.trim());
      rows[want] = out.split("\n").find((l) => l.includes("linked-worktree")) ?? "";
      expect(out, want).not.toMatch(/--add-dir|writable_roots/);
    }
    expect(rows.protected).toContain("linked-worktree git metadata protected — the sandbox wrote an ordinary worktree file but denied the linked-worktree commit; a Codex worker cannot commit in its worktree");
    expect(rows.allowed).toContain("linked-worktree commit probe: commit allowed, shared hooks/config denied");
    expect(rows.allowed).not.toContain("protected");
    expect(rows.unknown).toContain("linked-worktree commit probe unknown — the sandbox result for the shared-metadata members was unreadable");
    expect(rows["unknown "]).toContain("linked-worktree commit probe unknown — the sandbox did not write the ordinary control file");

    // a codex-id stub with no injected sandbox: no probe, no field, no output
    const repo = makeRepo({ "keep.txt": "x" });
    const out = await doctor(["--"], repo, [stub("codex")], { banner: false });
    expect(JSON.parse(readFileSync(join(repo, ".tickmarkr", "doctor.json"), "utf8")).codex).not.toHaveProperty("codexCommit");
    expect(out).not.toContain("linked-worktree");
  });
});

describe("v2.6.5 T9 (H) discovery coverage and sourced alias identities", () => {
  const response = (body: unknown, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body, text: async () => String(body) });
  const now = () => new Date("2026-09-30T12:00:00.000Z");
  const freshCache = (repo: string) => {
    mkdirSync(join(repo, ".tickmarkr"), { recursive: true });
    const at = now().toISOString();
    writeFileSync(join(repo, ".tickmarkr", "catalog-cache.json"), JSON.stringify({
      schemaVersion: 1,
      fetchedAt: at,
      modelsDev: { fakeco: { id: "fakeco", models: { "seen-model": { id: "seen-model", cost: { input: 1, output: 2 } } } } },
      legFetchedAt: { modelsDev: at, liveBench: at },
    }));
  };
  const routes = () => vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    if (url.startsWith(MODELS_DEV_CATALOG_URL)) {
      return response({ fakeco: { id: "fakeco", models: {
        "seen-model": { id: "seen-model", cost: { input: 1, output: 2 } },
        "new-model": { id: "new-model", cost: { input: 3, output: 4 } },
      } } });
    }
    if (url.startsWith(LIVEBENCH_TABLE_URL)) return response("model,javascript,typescript,python,code_generation,code_completion\nnew-model,1,2,3,4,5\n");
    if (url.startsWith(LIVEBENCH_CATEGORIES_URL)) return response({ "Agentic Coding": ["javascript", "typescript", "python"], Coding: ["code_generation", "code_completion"] });
    throw new Error(`unexpected ${url}`);
  });
  // discovery is injected: the adapter's own model-list surface reports these ids
  const lister = (models: string[]) => ({
    id: "fakeco", vendor: "fakeco",
    probe: async () => ({ installed: true, authed: true, models: [] }),
    listModels: async () => models,
    channels: (cfg: any) => channelsFromConfig("fakeco", cfg),
    headlessCommand: () => "printf OK",
  }) as unknown as WorkerAdapter;
  const modelsDevCalls = (fetcher: ReturnType<typeof routes>) =>
    fetcher.mock.calls.filter(([url]) => String(url).startsWith(MODELS_DEV_CATALOG_URL)).length;

  test("test: doctor refreshes catalog coverage once after injected discovery adds an uncovered model despite a fresh initial cache while an already-covered discovery performs no extra fetch and failed refresh stays unknown", async () => {
    vi.stubEnv("ARTIFICIAL_ANALYSIS_API_KEY", "");
    expect(readCachedCatalog((() => { const r = makeRepo({ "keep.txt": "x" }); freshCache(r); return r; })(), { now }).stale).toBe(false);

    const added = makeRepo({ "keep.txt": "x" });
    freshCache(added);
    const addedFetch = routes();
    const addedOut = await doctor(["--models"], added, [lister(["seen-model", "new-model"])], { banner: false, catalogNow: now, catalogFetcher: addedFetch });
    expect(modelsDevCalls(addedFetch)).toBe(1);
    expect(addedOut).toContain("catalog coverage refreshed once after discovery added 1 uncovered model(s) (fakeco:new-model); now covered");
    expect(addedOut).toContain("models.dev id=new-model");
    // the same discovery again is no longer an addition: no second fetch, so no per-run refresh loop
    await doctor(["--"], added, [lister(["seen-model", "new-model"])], { banner: false, catalogNow: now, catalogFetcher: addedFetch });
    expect(modelsDevCalls(addedFetch)).toBe(1);

    // an operator classification never establishes catalog coverage: a configured model the fresh cache misses still earns the one refresh
    const configured = makeRepo({ "keep.txt": "x" });
    withOverlay(configured, "tiers:\n  fakeco:\n    vendor: fakeco\n    channel: sub\n    models:\n      seen-model: cheap\n      new-model: mid\n");
    freshCache(configured);
    const configuredFetch = routes();
    const configuredOut = await doctor(["--"], configured, [lister(["seen-model", "new-model"])], { banner: false, catalogNow: now, catalogFetcher: configuredFetch });
    expect(modelsDevCalls(configuredFetch)).toBe(1);
    expect(configuredOut).toContain("catalog coverage refreshed once after discovery added 1 uncovered model(s) (fakeco:new-model); now covered");
    expect(loadConfig(configured).tiers.fakeco?.models["new-model"]).toBe("mid");

    const covered = makeRepo({ "keep.txt": "x" });
    freshCache(covered);
    const coveredFetch = routes();
    const coveredOut = await doctor(["--"], covered, [lister(["seen-model"])], { banner: false, catalogNow: now, catalogFetcher: coveredFetch });
    expect(coveredFetch).not.toHaveBeenCalled();
    expect(coveredOut).not.toContain("catalog coverage");

    const failed = makeRepo({ "keep.txt": "x" });
    freshCache(failed);
    const failedFetch = vi.fn(async () => { throw new Error("offline"); });
    const failedOut = await doctor(["--models"], failed, [lister(["seen-model", "new-model"])], { banner: false, catalogNow: now, catalogFetcher: failedFetch });
    expect(failedFetch.mock.calls.filter(([url]) => String(url).startsWith(MODELS_DEV_CATALOG_URL))).toHaveLength(1);
    expect(failedOut).toContain("catalog coverage unknown for fakeco:new-model — the one post-discovery refresh failed: catalog refresh: models.dev failed (offline");
    expect(failedOut).not.toContain("now covered");
    expect(failedOut).not.toContain("models.dev id=new-model");
    // the unknown carries into the catalog advisory row and the suggested overlay — never "uncovered"
    expect(failedOut).toContain("catalog · new-model — catalog coverage unknown (post-discovery refresh failed); no tier suggestion");
    expect(failedOut.split("\n").find((l) => l.includes("# new-model: ???"))).toContain("catalog coverage unknown (post-discovery refresh failed)");
    expect(failedOut).not.toContain("uncovered by cached catalogs");
    // a repeat doctor fetches nothing (new-model is no longer an addition) and the unknown persists — never relabeled uncovered
    const repeatOut = await doctor(["--models"], failed, [lister(["seen-model", "new-model"])], { banner: false, catalogNow: now, catalogFetcher: failedFetch });
    expect(failedFetch.mock.calls.filter(([url]) => String(url).startsWith(MODELS_DEV_CATALOG_URL))).toHaveLength(1);
    expect(repeatOut).toContain("catalog · new-model — catalog coverage unknown (post-discovery refresh failed); no tier suggestion");
    expect(repeatOut.split("\n").find((l) => l.includes("# new-model: ???"))).toContain("catalog coverage unknown (post-discovery refresh failed)");
    expect(repeatOut).not.toContain("uncovered by cached catalogs");
    // a later successful refresh (any path) supersedes the unknown with real coverage evidence
    const later = () => new Date("2026-09-30T13:00:00.000Z");
    expect((await refreshCatalogCommand({ repoRoot: failed, fetcher: routes(), now: later })).updated).toBe(true);
    const settledOut = await doctor(["--models"], failed, [lister(["seen-model", "new-model"])], { banner: false, catalogNow: later, catalogFetcher: failedFetch });
    expect(settledOut).toContain("models.dev id=new-model");
    expect(settledOut).not.toContain("coverage unknown");
    // the default view's counted summary keeps it unknown too, still from the one failed fetch
    const failedDefault = makeRepo({ "keep.txt": "x" });
    freshCache(failedDefault);
    const failedDefaultFetch = vi.fn(async () => { throw new Error("offline"); });
    const failedDefaultOut = await doctor(["--"], failedDefault, [lister(["seen-model", "new-model"])], { banner: false, catalogNow: now, catalogFetcher: failedDefaultFetch });
    expect(failedDefaultFetch.mock.calls.filter(([url]) => String(url).startsWith(MODELS_DEV_CATALOG_URL))).toHaveLength(1);
    expect(failedDefaultOut).toContain("catalog · 1 coverage unknown after a failed refresh · 1 covered without a tier suggestion");
    expect(failedDefaultOut).not.toContain("uncovered by cached catalogs");
  });

  const claudeAliasAdapter = () => ({
    id: "claude-code", vendor: "anthropic",
    probe: async () => ({ installed: true, authed: true, models: [] }),
    channels: (cfg: any) => channelsFromConfig("claude-code", cfg),
    headlessCommand: vi.fn(() => "printf OK"),
  }) as unknown as WorkerAdapter;
  const aliasOverlay = (sonnetTier: string) => `tiers:
  claude-code:
    vendor: anthropic
    channel: sub
    models:
      fable: null
      opus: frontier
      sonnet: ${sonnetTier}
      haiku: null
`;
  // the fake CLI answers the stated-identity probe; the production resolver reads the store first, then asks it
  const doctorWithFakeCli = async (repo: string, answers: Partial<Record<ClaudeAlias, string>>) =>
    doctor(["--"], repo, [claudeAliasAdapter()], {
      banner: false,
      resolveClaudeAliasIdentity: (cwd, alias) => resolveClaudeAliasIdentity(cwd, alias, (_cwd, asked) => answers[asked]),
    });

  test("test: doctor fake CLI sonnet→claude-sonnet-5-5 resolves the Sonnet/Opus 5-5 sourced tier/price/window table versus stale five-date drift or unknown/disagreeing identities", async () => {
    const current = makeRepo({ "keep.txt": "x" });
    withOverlay(current, aliasOverlay("mid"));
    const out = await doctorWithFakeCli(current, { sonnet: "claude-sonnet-5-5", opus: "claude-opus-5-5" });
    expect(out).toContain("identity record: claude-code:sonnet → claude-sonnet-5-5 · $2/$10 per Mtok (API) · window 1000000/128000 · sourced 2026-09-30");
    expect(out).toContain("INFERRED tier mid by continuity of the existing sonnet=mid configuration");
    expect(out).toContain("identity record: claude-code:opus → claude-opus-5-5 · $4/$20 per Mtok (API) · window 1000000/128000 · sourced 2026-09-30");
    expect(out).toContain("INFERRED tier frontier by continuity of the existing opus=frontier configuration");
    expect(out).not.toContain("resolved-identity drift: claude-code:sonnet");
    expect(registry.readDoctor(current)?.["claude-code"]?.modelAuth?.sonnet?.identity).toBe("claude-sonnet-5-5");

    const stale = makeRepo({ "keep.txt": "x" });
    withOverlay(stale, aliasOverlay("mid"));
    const staleOut = await doctorWithFakeCli(stale, { sonnet: "claude-sonnet-5", opus: "claude-opus-5-5" });
    expect(staleOut).toContain("resolved-identity drift: claude-code:sonnet resolved to claude-sonnet-5, stamped identity claude-sonnet-5-5");
    expect(staleOut).toContain("identity record: claude-code:sonnet → claude-sonnet-5 has no sourced record — tier/price/window unknown");
    expect(staleOut).not.toContain("$2/$10");

    const unknown = makeRepo({ "keep.txt": "x" });
    withOverlay(unknown, aliasOverlay("mid"));
    const unknownOut = await doctorWithFakeCli(unknown, {});
    expect(unknownOut).toContain("identity record: claude-code:opus, sonnet identity unknown — no sourced tier/price/window applies");
    expect(unknownOut).not.toContain("INFERRED");

    const disagreeing = makeRepo({ "keep.txt": "x" });
    withOverlay(disagreeing, aliasOverlay("mid"));
    const disagreeingOut = await doctorWithFakeCli(disagreeing, { sonnet: "claude-opus-5-5", opus: "claude-opus-7" });
    expect(disagreeingOut).toContain("identity record: claude-code:sonnet → claude-opus-5-5 disagrees with the sonnet family — tier/price/window unknown");
    expect(disagreeingOut).toContain("identity record: claude-code:opus → claude-opus-7 has no sourced record — tier/price/window unknown");
    expect(disagreeingOut).not.toContain("INFERRED");
  });

  test("test: doctor prints an inferred model classification for confirmation without writing configuration while a separately confirmed Fleet choice remains the routing authority", async () => {
    const repo = makeRepo({ "keep.txt": "x" });
    // the operator's Fleet-confirmed classification promotes sonnet above the continuity inference
    withOverlay(repo, aliasOverlay("frontier"));
    const configPath = join(repo, ".tickmarkr", "config.yaml");
    const beforeBytes = readFileSync(configPath, "utf8");
    const adapter = claudeAliasAdapter();
    const beforeCfg = loadConfig(repo);
    const task = { id: "T9", title: "authority", goal: "g", shape: "implement", complexity: 3, acceptance: ["a"], routingHints: { floor: "frontier" } } as any;
    const beforeRoute = route(task, beforeCfg, adapter.channels(beforeCfg));

    const out = await doctorWithFakeCli(repo, { sonnet: "claude-sonnet-5-5", opus: "claude-opus-5-5" });

    expect(out).toContain("INFERRED tier mid by continuity of the existing sonnet=mid configuration, not derived from the name or price — inference for operator confirmation (tickmarkr fleet); doctor writes no configuration · routing authority: configured claude-code:sonnet=frontier");
    const afterCfg = loadConfig(repo);
    expect(readFileSync(configPath, "utf8")).toBe(beforeBytes);
    expect(afterCfg.tiers["claude-code"]?.models.sonnet).toBe("frontier");
    expect(adapter.channels(afterCfg).find((c) => c.model === "sonnet")?.tier).toBe("frontier");
    expect(route(task, afterCfg, adapter.channels(afterCfg))).toEqual(beforeRoute);
  });
});
