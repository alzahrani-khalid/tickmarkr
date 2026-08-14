import * as childProcess from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, afterEach, describe, expect, test, vi } from "vitest";
import { CLAUDE_ALIAS_IDENTITY_STAMPS } from "../../src/adapters/claude-code.js";
import { hasCodexTrustedProject, seedCodexTrust } from "../../src/adapters/codex.js";
import { LIVEBENCH_TABLE_DATE } from "../../src/adapters/catalog-remote.js";
import { FakeAdapter } from "../../src/adapters/fake.js";
import * as registry from "../../src/adapters/registry.js";
import { channelsFromConfig, type TrustVerdict, type WorkerAdapter } from "../../src/adapters/types.js";
import { BANNER, TOKENS } from "../../src/brand.js";
import { doctor } from "../../src/cli/commands/doctor.js";
import { resume } from "../../src/cli/commands/resume.js";
import { loadConfig } from "../../src/config/config.js";
import { graphDefinitionHash, loadGraph } from "../../src/graph/graph.js";
import { route } from "../../src/route/router.js";
import { gitHead } from "../../src/run/git.js";
import { Journal } from "../../src/run/journal.js";
import { makeRepo, setupRepo, T } from "../helpers/tmprepo.js";

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
  vi.spyOn(registry, "detectCandidateClis").mockReturnValue([]);
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
    expect(out).toMatch(/! routing preference active: 1 channel\(s\) excluded/);
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
    expect(out).toMatch(/servability: 1 channel\(s\) unservable/);
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
    expect(out).toMatch(/fake-1\s+mid\s+authed\s+denied=—\s+prefer=—/);
    // unauthed carries BOTH reason and probe date
    expect(out).toMatch(/fake-denied\s+cheap\s+unauthed: credit exhausted \(\d{4}-\d{2}-\d{2}\)\s+denied=—\s+prefer=—/);
    expect(saved.fake.modelAuth["fake-1"].authed).toBe(true);
    expect(saved.fake.modelAuth["fake-denied"]).toMatchObject({ authed: false, reason: "credit exhausted" });
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
    expect(out).toMatch(/fake-1\s+mid\s+authed\s+denied=fake:fake-1\s+prefer=—/);
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
    const collapsed = await doctor(["--"], repo, [mkFake(script)]);
    expect(collapsed).toMatch(/catalog · 1 uncovered by vendored catalog — tickmarkr doctor --models lists each/);
    expect(collapsed).not.toMatch(/catalog · fake-2/);

    const listed = await doctor(["--models"], repo, [mkFake(script)]);
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
    expect(out).toMatch(/fake-1\s+mid\s+200000\s+authed/);
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
    expect(out).toMatch(/= pi\s+trust: n\/a/);
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
