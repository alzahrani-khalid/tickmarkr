import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { execSync } from "node:child_process";
import { afterEach, describe, expect, test, vi } from "vitest";
import { claudeCode } from "../../src/adapters/claude-code.js";
import { codex } from "../../src/adapters/codex.js";
import { cursorAgent } from "../../src/adapters/cursor-agent.js";
import { FakeAdapter } from "../../src/adapters/fake.js";
import { grok } from "../../src/adapters/grok.js";
import { opencode } from "../../src/adapters/opencode.js";
import { pi } from "../../src/adapters/pi.js";
import { discoverChannels, modelAuthExclusions, probeAll, probeModels, readAutoPrefer, readDoctor, writeDoctor, deriveAutoPrefer } from "../../src/adapters/registry.js";
import { DEFAULT_CONFIG } from "../../src/config/config.js";
import { modelAuthed, type WorkerAdapter } from "../../src/adapters/types.js";
import { doctor } from "../../src/cli/commands/doctor.js";
import { makeRepo } from "../helpers/tmprepo.js";

const stub = (id: string) =>
  ({ id, vendor: "x", probe: async () => ({ installed: true, authed: true, models: [] }) }) as unknown as WorkerAdapter;

// Pinned at v1.34 T3: non-TTY doctor stdout must stay byte-identical when probe progress is stderr-only.
const NON_TTY_DOCTOR_PIN = `tickmarkr doctor — capability matrix:
  ✓ claude-code    installed
  ✓ codex          installed
  ✓ cursor-agent   installed
  ✓ opencode       installed
  ✓ pi             installed
  ✗ herdr          not detected — subprocess driver will be used
workspace trust:
  = claude-code    trust: n/a
  = codex          trust: n/a
  = cursor-agent   trust: n/a
  = opencode       trust: n/a
  = pi             trust: n/a
  ! claude-code: no model-list surface — seeds stamped 2026-07-09; verify manually
  ! codex: no model-list surface — seeds stamped 2026-07-09; verify manually
  ! cursor-agent: no model-list surface — seeds stamped 2026-07-09; verify manually
  ! opencode: no model-list surface — seeds stamped 2026-07-09; verify manually
  ! pi: no model-list surface — seeds stamped 2026-07-09; verify manually
  ! routing seed names dead adapter 'cursor-agent' for shape 'implement' — auto-prefer is routing around it
  ! routing seed names dead adapter 'codex' for shape 'implement' — auto-prefer is routing around it
  ! routing seed names dead adapter 'opencode' for shape 'tests' — auto-prefer is routing around it
model status:
  claude-code
    fable    frontier unauthed: headless probe unavailable (2026-07-15)  denied=—  prefer=—
    opus     frontier unauthed: headless probe unavailable (2026-07-15)  denied=—  prefer=—
    sonnet   mid      unauthed: headless probe unavailable (2026-07-15)  denied=—  prefer=—
    haiku    cheap    unauthed: headless probe unavailable (2026-07-15)  denied=—  prefer=—
  codex
    gpt-5.6-sol   frontier unauthed: headless probe unavailable (2026-07-15)  denied=—  prefer=implement#1
    gpt-5.5       frontier unauthed: headless probe unavailable (2026-07-15)  denied=—  prefer=implement#1
    gpt-5.6-terra mid      unauthed: headless probe unavailable (2026-07-15)  denied=—  prefer=implement#1
    gpt-5.6-luna  cheap    unauthed: headless probe unavailable (2026-07-15)  denied=—  prefer=implement#1
  cursor-agent
    composer-2.5      mid      unauthed: headless probe unavailable (2026-07-15)  denied=—  prefer=implement#0
    composer-2.5-fast cheap    unauthed: headless probe unavailable (2026-07-15)  denied=—  prefer=implement#0
  opencode
    zai-coding-plan/glm-5.2 mid      unauthed: headless probe unavailable (2026-07-15)  denied=—  prefer=tests#0
  pi
    zai/glm-5.2 mid      unauthed: headless probe unavailable (2026-07-15)  denied=—  prefer=—
    prefer implement (auto):  — seed was [cursor-agent, codex]
    prefer tests (auto):  — seed was [opencode]
wrote .tickmarkr/doctor.json`;

// Intercept only the hang sentinel so probeModels timeout path is zero-token and fast; real sh for everything else.
vi.mock("../../src/run/git.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/run/git.js")>();
  return {
    ...actual,
    sh: vi.fn((cmd: string, cwd: string, timeoutMs?: number) => {
      if (typeof cmd === "string" && cmd.includes("__PROBE_TIMEOUT__")) {
        return Promise.resolve({ code: 1, stdout: "", stderr: "", timedOut: true });
      }
      return actual.sh(cmd, cwd, timeoutMs);
    }),
  };
});

describe("doctor cache hardening", () => {
  test("a corrupt doctor.json is tolerated and triggers a re-probe instead of a crash", async () => {
    const repo = mkdtempSync(join(tmpdir(), "tickmarkr-corrupt-doctor-"));
    mkdirSync(join(repo, ".tickmarkr"));
    writeFileSync(join(repo, ".tickmarkr", "doctor.json"), "{");
    writeFileSync(join(repo, "fake.json"), JSON.stringify({ tasks: {} }));
    const fake = new FakeAdapter(join(repo, "fake.json"));

    const health = await probeAll([fake]);
    expect(readDoctor(repo)).toBeNull();
    expect(health.fake.installed).toBe(true);
  });

  test("doctor.json writes land via tmp-plus-rename", () => {
    const repo = mkdtempSync(join(tmpdir(), "tickmarkr-atomic-doctor-"));
    writeDoctor(repo, { fake: { installed: true, authed: true, models: [] } });
    expect(readDoctor(repo)?.fake.installed).toBe(true);
    expect(existsSync(join(repo, ".tickmarkr", "doctor.json.tmp"))).toBe(false);
  });
});

describe("model auth probes", () => {
  test("probes only classified fake models and records the per-model verdict", async () => {
    const repo = mkdtempSync(join(tmpdir(), "tickmarkr-auth-probe-"));
    const script = join(repo, "fake.json");
    writeFileSync(script, JSON.stringify({ tasks: {} }));
    const fake = new FakeAdapter(script);
    const calls: string[] = [];
    vi.spyOn(fake, "headlessCommand").mockImplementation((_prompt, model) => {
      calls.push(model);
      return model === "fake-denied" ? "printf 'HTTP 403: auth denied'; exit 1" : "printf OK";
    });
    const cfg = structuredClone(DEFAULT_CONFIG);
    cfg.tiers.fake = { vendor: "fake", channel: "sub", models: { "fake-1": "mid", "fake-denied": "cheap" } };
    const health = await probeAll([fake]);

    await probeModels(cfg, repo, [fake], health);

    // v1.52 T4 / OBS-72: the failing model is probed twice — once concurrent, once serial.
    expect(calls).toEqual(["fake-1", "fake-denied", "fake-denied"]);
    expect(calls).not.toContain("fake-2");
    expect(health.fake.modelAuth).toMatchObject({
      "fake-1": { authed: true },
      "fake-denied": { authed: false, reason: "HTTP 403: auth denied" },
    });
    expect(health.fake.modelAuth?.["fake-denied"].probedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  test("retries a timed-out probe once when its retry succeeds", async () => {
    const repo = mkdtempSync(join(tmpdir(), "tickmarkr-auth-retry-success-"));
    const script = join(repo, "fake.json");
    writeFileSync(script, JSON.stringify({ tasks: {} }));
    const fake = new FakeAdapter(script);
    let calls = 0;
    vi.spyOn(fake, "headlessCommand").mockImplementation(() => ++calls === 1 ? "echo __PROBE_TIMEOUT__; sleep 999" : "printf OK");
    const cfg = structuredClone(DEFAULT_CONFIG);
    cfg.tiers.fake = { vendor: "fake", channel: "sub", models: { "fake-flaky": "mid" } };
    const health = await probeAll([fake]);

    await probeModels(cfg, repo, [fake], health);

    expect(calls).toBe(2);
    expect(health.fake.modelAuth?.["fake-flaky"].authed).toBe(true);
  });

  test("records a double-timeout after retrying once", async () => {
    const repo = mkdtempSync(join(tmpdir(), "tickmarkr-auth-timeout-"));
    const script = join(repo, "fake.json");
    writeFileSync(script, JSON.stringify({ tasks: {} }));
    const fake = new FakeAdapter(script);
    const command = vi.spyOn(fake, "headlessCommand").mockReturnValue("echo __PROBE_TIMEOUT__; sleep 999");
    const cfg = structuredClone(DEFAULT_CONFIG);
    cfg.tiers.fake = { vendor: "fake", channel: "sub", models: { "fake-hang": "mid" } };
    const health = await probeAll([fake]);

    await probeModels(cfg, repo, [fake], health);

    expect(command).toHaveBeenCalledTimes(2);
    expect(health.fake.modelAuth?.["fake-hang"]).toMatchObject({
      authed: false,
      reason: "probe timed out twice (60000ms)",
    });
  });

  // v1.21 T2 rule, retitled to the v1.52 T4 criterion — behavior unchanged.
  test("a repeat timeout still skips the retry per the prior-timeout rule", async () => {
    const repo = mkdtempSync(join(tmpdir(), "tickmarkr-auth-repeat-timeout-"));
    const script = join(repo, "fake.json");
    writeFileSync(script, JSON.stringify({ tasks: {} }));
    const fake = new FakeAdapter(script);
    const command = vi.spyOn(fake, "headlessCommand").mockReturnValue("echo __PROBE_TIMEOUT__; sleep 999");
    const cfg = structuredClone(DEFAULT_CONFIG);
    cfg.tiers.fake = { vendor: "fake", channel: "sub", models: { "fake-dead": "mid" } };
    const health = await probeAll([fake]);
    writeDoctor(repo, {
      fake: { installed: true, authed: true, models: [], modelAuth: { "fake-dead": { authed: false, reason: "probe timed out twice (30000ms)", probedAt: "2026-07-01T00:00:00.000Z" } } },
    });

    await probeModels(cfg, repo, [fake], health);

    expect(command).toHaveBeenCalledTimes(1);
    expect(health.fake.modelAuth?.["fake-dead"]).toMatchObject({
      authed: false,
      reason: "probe timed out (repeat — retry skipped) (60000ms)",
    });
  });

  test("T2: still retries once when the prior doctor.json verdict was authed, not a timeout", async () => {
    const repo = mkdtempSync(join(tmpdir(), "tickmarkr-auth-prior-authed-"));
    const script = join(repo, "fake.json");
    writeFileSync(script, JSON.stringify({ tasks: {} }));
    const fake = new FakeAdapter(script);
    const command = vi.spyOn(fake, "headlessCommand").mockReturnValue("echo __PROBE_TIMEOUT__; sleep 999");
    const cfg = structuredClone(DEFAULT_CONFIG);
    cfg.tiers.fake = { vendor: "fake", channel: "sub", models: { "fake-flake": "mid" } };
    const health = await probeAll([fake]);
    writeDoctor(repo, {
      fake: { installed: true, authed: true, models: [], modelAuth: { "fake-flake": { authed: true, probedAt: "2026-07-01T00:00:00.000Z" } } },
    });

    await probeModels(cfg, repo, [fake], health);

    expect(command).toHaveBeenCalledTimes(2);
    expect(health.fake.modelAuth?.["fake-flake"]).toMatchObject({
      authed: false,
      reason: "probe timed out twice (60000ms)",
    });
  });

  test("T2: with no prior doctor.json, a timing-out probe still retries once", async () => {
    const repo = mkdtempSync(join(tmpdir(), "tickmarkr-auth-no-prior-"));
    const script = join(repo, "fake.json");
    writeFileSync(script, JSON.stringify({ tasks: {} }));
    const fake = new FakeAdapter(script);
    const command = vi.spyOn(fake, "headlessCommand").mockReturnValue("echo __PROBE_TIMEOUT__; sleep 999");
    const cfg = structuredClone(DEFAULT_CONFIG);
    cfg.tiers.fake = { vendor: "fake", channel: "sub", models: { "fake-first": "mid" } };
    const health = await probeAll([fake]);

    await probeModels(cfg, repo, [fake], health);

    expect(command).toHaveBeenCalledTimes(2);
    expect(health.fake.modelAuth?.["fake-first"]).toMatchObject({
      authed: false,
      reason: "probe timed out twice (60000ms)",
    });
  });

  test("T2: caps per-adapter probe concurrency at 2", async () => {
    const repo = mkdtempSync(join(tmpdir(), "tickmarkr-auth-concurrency-"));
    const script = join(repo, "fake.json");
    writeFileSync(script, JSON.stringify({ tasks: {} }));
    const fake = new FakeAdapter(script);
    let inflight = 0;
    let maxInflight = 0;
    vi.spyOn(fake, "headlessCommand").mockImplementation((_prompt, model) => `printf ${model}`);
    const gitMock = await import("../../src/run/git.js");
    const shMock = gitMock.sh as unknown as ReturnType<typeof vi.fn>;
    const priorImpl = shMock.getMockImplementation();
    shMock.mockImplementation(async (_cmd: string, _cwd: string, _timeoutMs?: number) => {
      inflight++;
      maxInflight = Math.max(maxInflight, inflight);
      await new Promise((r) => setTimeout(r, 20));
      inflight--;
      return { code: 0, stdout: "OK", stderr: "", timedOut: false };
    });
    const cfg = structuredClone(DEFAULT_CONFIG);
    cfg.tiers.fake = { vendor: "fake", channel: "sub", models: { m1: "mid", m2: "mid", m3: "mid", m4: "mid", m5: "mid" } };
    const health = await probeAll([fake]);

    try {
      await probeModels(cfg, repo, [fake], health);
    } finally {
      if (priorImpl) shMock.mockImplementation(priorImpl);
    }

    expect(maxInflight).toBeLessThanOrEqual(2);
    expect(Object.keys(health.fake.modelAuth ?? {})).toHaveLength(5);
  });

  // v1.52 T4 / OBS-72: a "conclusive" failure inside the concurrent batch may be adapter
  // self-contention — every first-pass failure now earns exactly one serial re-probe, and only the
  // retry's outcome is stored (supersedes the v1.21 "does not retry a conclusive auth failure" rule).
  test("a probe that fails in the concurrent batch retries once serially before its verdict is stored", async () => {
    const repo = mkdtempSync(join(tmpdir(), "tickmarkr-serial-retry-"));
    const script = join(repo, "fake.json");
    writeFileSync(script, JSON.stringify({ tasks: {} }));
    const fake = new FakeAdapter(script);
    let calls = 0;
    vi.spyOn(fake, "headlessCommand").mockImplementation(() =>
      ++calls === 1 ? "printf 'transient contention error'; exit 1" : "printf 'HTTP 403: auth denied'; exit 1");
    const cfg = structuredClone(DEFAULT_CONFIG);
    cfg.tiers.fake = { vendor: "fake", channel: "sub", models: { "fake-flap": "mid" } };
    const health = await probeAll([fake]);
    const stored: string[] = [];

    await probeModels(cfg, repo, [fake], health, (_adapter, model) => stored.push(model));

    expect(calls).toBe(2);
    // one verdict, stored after the retry — never one per attempt
    expect(stored).toEqual(["fake-flap"]);
    expect(health.fake.modelAuth?.["fake-flap"]).toMatchObject({ authed: false, reason: "HTTP 403: auth denied" });
  });

  test("a probe that succeeds on the serial retry is recorded authed", async () => {
    const repo = mkdtempSync(join(tmpdir(), "tickmarkr-serial-retry-ok-"));
    const script = join(repo, "fake.json");
    writeFileSync(script, JSON.stringify({ tasks: {} }));
    const fake = new FakeAdapter(script);
    let calls = 0;
    vi.spyOn(fake, "headlessCommand").mockImplementation(() =>
      ++calls === 1 ? "printf 'HTTP 403: auth denied'; exit 1" : "printf OK");
    const cfg = structuredClone(DEFAULT_CONFIG);
    cfg.tiers.fake = { vendor: "fake", channel: "sub", models: { "fake-contended": "mid" } };
    const health = await probeAll([fake]);

    await probeModels(cfg, repo, [fake], health);

    expect(calls).toBe(2);
    expect(health.fake.modelAuth?.["fake-contended"].authed).toBe(true);
  });

  test("the serial retry runs with one probe in flight", async () => {
    const repo = mkdtempSync(join(tmpdir(), "tickmarkr-serial-retry-flight-"));
    const script = join(repo, "fake.json");
    writeFileSync(script, JSON.stringify({ tasks: {} }));
    const fake = new FakeAdapter(script);
    vi.spyOn(fake, "headlessCommand").mockImplementation((_prompt, model) => `probe ${model}`);
    const gitMock = await import("../../src/run/git.js");
    const shMock = gitMock.sh as unknown as ReturnType<typeof vi.fn>;
    const priorImpl = shMock.getMockImplementation();
    const attempts = new Map<string, number>();
    let inflight = 0;
    let firstPassDone = 0;
    let retryMaxInflight = 0;
    let retryStartedBeforeDrain = false;
    shMock.mockImplementation(async (cmd: string) => {
      const model = String(cmd).split(" ").pop() ?? "";
      const n = (attempts.get(model) ?? 0) + 1;
      attempts.set(model, n);
      inflight++;
      if (n === 2) {
        retryMaxInflight = Math.max(retryMaxInflight, inflight);
        if (firstPassDone < 4) retryStartedBeforeDrain = true;
      }
      await new Promise((r) => setTimeout(r, 10));
      inflight--;
      if (n === 1) firstPassDone++;
      return { code: 1, stdout: "contention", stderr: "", timedOut: false };
    });
    const cfg = structuredClone(DEFAULT_CONFIG);
    cfg.tiers.fake = { vendor: "fake", channel: "sub", models: { m1: "mid", m2: "mid", m3: "mid", m4: "mid" } };
    const health = await probeAll([fake]);

    try {
      await probeModels(cfg, repo, [fake], health);
    } finally {
      if (priorImpl) shMock.mockImplementation(priorImpl);
    }

    expect([...attempts.values()]).toEqual([2, 2, 2, 2]);
    expect(retryMaxInflight).toBe(1);
    expect(retryStartedBeforeDrain).toBe(false);
  });

  test("a stored failure reason carries the tail of the probe output", async () => {
    const repo = mkdtempSync(join(tmpdir(), "tickmarkr-reason-tail-"));
    const script = join(repo, "fake.json");
    writeFileSync(script, JSON.stringify({ tasks: {} }));
    const fake = new FakeAdapter(script);
    const long = `HEAD-MARKER ${"x".repeat(300)} tail-error: not inside a trusted directory`;
    vi.spyOn(fake, "headlessCommand").mockReturnValue(`printf %s "${long}"; exit 1`);
    const cfg = structuredClone(DEFAULT_CONFIG);
    cfg.tiers.fake = { vendor: "fake", channel: "sub", models: { "fake-tail": "mid" } };
    const health = await probeAll([fake]);

    await probeModels(cfg, repo, [fake], health);

    const reason = health.fake.modelAuth?.["fake-tail"].reason;
    expect(reason?.endsWith("tail-error: not inside a trusted directory")).toBe(true);
    expect(reason).not.toContain("HEAD-MARKER");
    // v1.55 T3: word-boundary trim means at most the cap, no longer exactly it.
    expect(reason!.length).toBeLessThanOrEqual(240);
  });

  test("a probe failure reason longer than the cap starts at a word boundary", async () => {
    const repo = mkdtempSync(join(tmpdir(), "tickmarkr-reason-boundary-"));
    const script = join(repo, "fake.json");
    writeFileSync(script, JSON.stringify({ tasks: {} }));
    const fake = new FakeAdapter(script);
    // 11-char cycle: the raw 240-char tail slice deterministically lands mid-word.
    const long = `${"abcdefghij ".repeat(40)}tail-error: quota exhausted`;
    vi.spyOn(fake, "headlessCommand").mockReturnValue(`printf %s "${long}"; exit 1`);
    const cfg = structuredClone(DEFAULT_CONFIG);
    cfg.tiers.fake = { vendor: "fake", channel: "sub", models: { "fake-boundary": "mid" } };
    const health = await probeAll([fake]);

    await probeModels(cfg, repo, [fake], health);

    const reason = health.fake.modelAuth?.["fake-boundary"].reason;
    expect(reason!.length).toBeLessThanOrEqual(240);
    expect(reason!.endsWith("tail-error: quota exhausted")).toBe(true);
    // the reason is an untouched suffix of the output that opens on a fresh word
    expect(long.endsWith(reason!)).toBe(true);
    expect(long[long.length - reason!.length - 1]).toBe(" ");
    expect(reason!.startsWith("abcdefghij ")).toBe(true);
  });

  test("a short probe failure reason is stored unchanged", async () => {
    const repo = mkdtempSync(join(tmpdir(), "tickmarkr-reason-short-"));
    const script = join(repo, "fake.json");
    writeFileSync(script, JSON.stringify({ tasks: {} }));
    const fake = new FakeAdapter(script);
    const short = "HTTP 403: auth denied for model grok-composer";
    vi.spyOn(fake, "headlessCommand").mockReturnValue(`printf %s "${short}"; exit 1`);
    const cfg = structuredClone(DEFAULT_CONFIG);
    cfg.tiers.fake = { vendor: "fake", channel: "sub", models: { "fake-short": "mid" } };
    const health = await probeAll([fake]);

    await probeModels(cfg, repo, [fake], health);

    expect(health.fake.modelAuth?.["fake-short"].reason).toBe(short);
  });

  test("codex model probes run with concurrency one", async () => {
    // the codex adapter declares it...
    expect(codex.probeConcurrency).toBe(1);
    // ...and the registry honors an adapter-declared cap over the default of 2.
    const repo = mkdtempSync(join(tmpdir(), "tickmarkr-probe-conc-one-"));
    const script = join(repo, "fake.json");
    writeFileSync(script, JSON.stringify({ tasks: {} }));
    const fake = new FakeAdapter(script);
    (fake as WorkerAdapter & { probeConcurrency: number }).probeConcurrency = 1;
    vi.spyOn(fake, "headlessCommand").mockImplementation((_prompt, model) => `printf ${model}`);
    const gitMock = await import("../../src/run/git.js");
    const shMock = gitMock.sh as unknown as ReturnType<typeof vi.fn>;
    const priorImpl = shMock.getMockImplementation();
    let inflight = 0;
    let maxInflight = 0;
    shMock.mockImplementation(async () => {
      inflight++;
      maxInflight = Math.max(maxInflight, inflight);
      await new Promise((r) => setTimeout(r, 10));
      inflight--;
      return { code: 0, stdout: "OK", stderr: "", timedOut: false };
    });
    const cfg = structuredClone(DEFAULT_CONFIG);
    cfg.tiers.fake = { vendor: "fake", channel: "sub", models: { m1: "mid", m2: "mid", m3: "mid" } };
    const health = await probeAll([fake]);

    try {
      await probeModels(cfg, repo, [fake], health);
    } finally {
      if (priorImpl) shMock.mockImplementation(priorImpl);
    }

    expect(maxInflight).toBe(1);
    expect(Object.keys(health.fake.modelAuth ?? {})).toHaveLength(3);
  });

  test("requires a verdict by default but can retain pre-probe compatibility", () => {
    const repo = mkdtempSync(join(tmpdir(), "tickmarkr-auth-legacy-"));
    mkdirSync(join(repo, ".tickmarkr"));
    writeFileSync(join(repo, ".tickmarkr", "doctor.json"), JSON.stringify({ fake: { installed: true, authed: true, models: [] } }));

    expect(modelAuthed(readDoctor(repo)?.fake, "fake-1")).toBe(false);
    expect(modelAuthed(readDoctor(repo)?.fake, "fake-1", true)).toBe(true);
  });

  // v1.27 T2: bare "auth" substrings are not failures; exit 0 so only AUTH_FAILURE_RE can mark unauthed.
  test("benign auth substrings do not produce a failure verdict", async () => {
    const repo = mkdtempSync(join(tmpdir(), "tickmarkr-auth-benign-"));
    const script = join(repo, "fake.json");
    writeFileSync(script, JSON.stringify({ tasks: {} }));
    const fake = new FakeAdapter(script);
    const benign: Record<string, string> = {
      "oauth-ok": "OAuth token ok",
      authored: "authored by",
      "auth-mode": "provider: openai auth mode chatgpt",
    };
    vi.spyOn(fake, "headlessCommand").mockImplementation((_prompt, model) =>
      `printf ${JSON.stringify(benign[model] ?? "OK")}`);
    const cfg = structuredClone(DEFAULT_CONFIG);
    cfg.tiers.fake = {
      vendor: "fake",
      channel: "sub",
      models: Object.fromEntries(Object.keys(benign).map((m) => [m, "mid" as const])),
    };
    const health = await probeAll([fake]);

    await probeModels(cfg, repo, [fake], health);

    for (const model of Object.keys(benign)) {
      expect(health.fake.modelAuth?.[model], model).toMatchObject({ authed: true });
    }
  });

  test("conclusive auth-failure strings still produce failure verdicts", async () => {
    const repo = mkdtempSync(join(tmpdir(), "tickmarkr-auth-fail-"));
    const script = join(repo, "fake.json");
    writeFileSync(script, JSON.stringify({ tasks: {} }));
    const fake = new FakeAdapter(script);
    const failing: Record<string, string> = {
      "code-401": "401",
      unauthorized: "unauthorized",
      "authn-failed": "authentication failed",
      "credit-out": "credit exhausted",
    };
    // exit 0: only AUTH_FAILURE_RE (not nonzero exit) may mark unauthed
    vi.spyOn(fake, "headlessCommand").mockImplementation((_prompt, model) =>
      `printf ${JSON.stringify(failing[model] ?? "OK")}`);
    const cfg = structuredClone(DEFAULT_CONFIG);
    cfg.tiers.fake = {
      vendor: "fake",
      channel: "sub",
      models: Object.fromEntries(Object.keys(failing).map((m) => [m, "mid" as const])),
    };
    const health = await probeAll([fake]);

    await probeModels(cfg, repo, [fake], health);

    for (const [model, text] of Object.entries(failing)) {
      expect(health.fake.modelAuth?.[model]?.authed, model).toBe(false);
      expect(health.fake.modelAuth?.[model]?.reason, model).toContain(text);
    }
  });
});

describe("model auth discovery", () => {
  const adapter = {
    id: "fake",
    channels: () => [{ adapter: "fake", vendor: "fake", model: "fake-1", channel: "sub" as const, tier: "mid" as const }],
  } as unknown as WorkerAdapter;

  test("excludes a model without a verdict and tells the operator to run doctor", () => {
    const health = { fake: { installed: true, authed: true, models: [] } };

    expect(discoverChannels(DEFAULT_CONFIG, [adapter], health)).toEqual([]);
    expect(modelAuthExclusions(DEFAULT_CONFIG, [adapter], health)).toEqual([
      { key: "fake:fake-1", adapter: "fake", reason: "no model auth verdict — run tickmarkr doctor", probedAt: "not recorded" },
    ]);
  });

  test("allows legacy unknown models only when configured", () => {
    const legacyCfg = structuredClone(DEFAULT_CONFIG);
    legacyCfg.routing.allowUnverifiedModels = true;
    const health = { fake: { installed: true, authed: true, models: [] } };

    expect(discoverChannels(legacyCfg, [adapter], health).map((c) => c.model)).toEqual(["fake-1"]);
  });

  test("keeps an explicitly unauthed model excluded in either mode", () => {
    const legacyCfg = structuredClone(DEFAULT_CONFIG);
    legacyCfg.routing.allowUnverifiedModels = true;
    const health = {
      fake: {
        installed: true,
        authed: true,
        models: [],
        modelAuth: { "fake-1": { authed: false, reason: "HTTP 403", probedAt: "2026-07-16T00:00:00.000Z" } },
      },
    };

    expect(discoverChannels(DEFAULT_CONFIG, [adapter], health)).toEqual([]);
    expect(discoverChannels(legacyCfg, [adapter], health)).toEqual([]);
  });
});

describe("v1.34 T3 probe progress", () => {
  afterEach(() => vi.useRealTimers());

  test("doctor.json model verdicts carry a durationMs field", async () => {
    const repo = mkdtempSync(join(tmpdir(), "tickmarkr-auth-duration-"));
    const script = join(repo, "fake.json");
    writeFileSync(script, JSON.stringify({ tasks: {} }));
    const fake = new FakeAdapter(script);
    vi.spyOn(fake, "headlessCommand").mockImplementation((_prompt, model) =>
      model === "fake-denied" ? "printf 'HTTP 403: auth denied'; exit 1" : "printf OK",
    );
    const cfg = structuredClone(DEFAULT_CONFIG);
    cfg.tiers.fake = { vendor: "fake", channel: "sub", models: { "fake-1": "mid", "fake-denied": "cheap" } };
    const health = await probeAll([fake]);

    await probeModels(cfg, repo, [fake], health);

    for (const model of ["fake-1", "fake-denied"]) {
      expect(health.fake.modelAuth?.[model].durationMs, model).toEqual(expect.any(Number));
      expect(health.fake.modelAuth?.[model].durationMs, model).toBeGreaterThanOrEqual(0);
    }
  });

  test("test: doctor non-tty output is byte-identical to before this change", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-15T12:00:00.000Z"));
    const repo = makeRepo({ "keep.txt": "x" });
    mkdirSync(join(repo, ".tickmarkr"), { recursive: true });
    writeFileSync(join(repo, ".tickmarkr", "config.yaml"), "");
    const stderrTTY = Object.getOwnPropertyDescriptor(process.stderr, "isTTY");
    const stdoutTTY = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
    const pathPrev = process.env.PATH;
    const emptyPath = mkdtempSync(join(tmpdir(), "tickmarkr-pin-path-"));
    try {
      const git = execSync("which git", { encoding: "utf8" }).trim();
      process.env.PATH = `${emptyPath}:${dirname(git)}`;
    } catch {
      process.env.PATH = emptyPath;
    }
    const stderrSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    Object.defineProperty(process.stderr, "isTTY", { configurable: true, value: false });
    Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: false });
    try {
      const out = await doctor(["--"], repo, ["claude-code", "codex", "cursor-agent", "opencode", "pi"].map(stub));
      expect(out).toBe(NON_TTY_DOCTOR_PIN);
      expect(stderrSpy.mock.calls.map((c) => c[0]).join("\n")).toBe(
        "probing installed agent CLIs — one short LLM call per configured model, may take a minute...",
      );
      expect(out).not.toMatch(/fake:\S+ (ok|timeout|failed) \(\d+\.\ds\)/);
    } finally {
      stderrSpy.mockRestore();
      if (pathPrev !== undefined) process.env.PATH = pathPrev;
      else delete process.env.PATH;
      if (stderrTTY) Object.defineProperty(process.stderr, "isTTY", stderrTTY);
      else delete (process.stderr as { isTTY?: boolean }).isTTY;
      if (stdoutTTY) Object.defineProperty(process.stdout, "isTTY", stdoutTTY);
      else delete (process.stdout as { isTTY?: boolean }).isTTY;
    }
  });

  test("TTY probe progress lines go to stderr only, never stdout", async () => {
    const repo = mkdtempSync(join(tmpdir(), "tickmarkr-auth-progress-"));
    const script = join(repo, "fake.json");
    writeFileSync(script, JSON.stringify({ tasks: {} }));
    const fake = new FakeAdapter(script);
    vi.spyOn(fake, "headlessCommand").mockImplementation((_prompt, model) =>
      model === "fake-hang" ? "echo __PROBE_TIMEOUT__; sleep 999" : "printf OK",
    );
    const cfg = structuredClone(DEFAULT_CONFIG);
    cfg.tiers.fake = { vendor: "fake", channel: "sub", models: { "fake-1": "mid", "fake-hang": "cheap" } };
    const health = await probeAll([fake]);
    const progress: string[] = [];
    const stderrSpy = vi.spyOn(console, "error").mockImplementation((msg) => progress.push(String(msg)));

    await probeModels(cfg, repo, [fake], health, (adapter, model, status, durationMs) => {
      progress.push(`  ${adapter}:${model} ${status} (${(durationMs / 1000).toFixed(1)}s)`);
    });

    expect(progress.some((l) => /fake:fake-1 ok \(\d+\.\ds\)/.test(l))).toBe(true);
    expect(progress.some((l) => /fake:fake-hang timeout \(\d+\.\ds\)/.test(l))).toBe(true);
    expect(progress.every((l) => !l.startsWith("tickmarkr doctor"))).toBe(true);
    stderrSpy.mockRestore();
  });
});

describe("OBS-31 probeCwd", () => {
  test("neutral probeCwd runs model probes from an existing empty directory, not the repo root", async () => {
    const repo = mkdtempSync(join(tmpdir(), "tickmarkr-probe-neutral-"));
    const script = join(repo, "fake.json");
    writeFileSync(script, JSON.stringify({ tasks: {} }));
    const fake = new FakeAdapter(script);
    (fake as WorkerAdapter & { probeCwd: "neutral" }).probeCwd = "neutral";
    vi.spyOn(fake, "headlessCommand").mockReturnValue("printf OK");
    const cfg = structuredClone(DEFAULT_CONFIG);
    cfg.tiers.fake = { vendor: "fake", channel: "sub", models: { "fake-1": "mid" } };
    const health = await probeAll([fake]);
    const cwds: string[] = [];
    const gitMock = await import("../../src/run/git.js");
    const shMock = gitMock.sh as unknown as ReturnType<typeof vi.fn>;
    const priorImpl = shMock.getMockImplementation();
    shMock.mockImplementation(async (_cmd: string, cwd: string) => {
      cwds.push(cwd);
      return { code: 0, stdout: "OK", stderr: "", timedOut: false };
    });

    try {
      await probeModels(cfg, repo, [fake], health);
    } finally {
      if (priorImpl) shMock.mockImplementation(priorImpl);
    }

    expect(cwds).toHaveLength(1);
    expect(cwds[0]).not.toBe(repo);
    expect(readdirSync(cwds[0])).toEqual([]);
  });

  test("default probeCwd runs model probes from the repo root", async () => {
    const repo = mkdtempSync(join(tmpdir(), "tickmarkr-probe-repo-"));
    const script = join(repo, "fake.json");
    writeFileSync(script, JSON.stringify({ tasks: {} }));
    const fake = new FakeAdapter(script);
    vi.spyOn(fake, "headlessCommand").mockReturnValue("printf OK");
    const cfg = structuredClone(DEFAULT_CONFIG);
    cfg.tiers.fake = { vendor: "fake", channel: "sub", models: { "fake-1": "mid" } };
    const health = await probeAll([fake]);
    const cwds: string[] = [];
    const gitMock = await import("../../src/run/git.js");
    const shMock = gitMock.sh as unknown as ReturnType<typeof vi.fn>;
    const priorImpl = shMock.getMockImplementation();
    shMock.mockImplementation(async (_cmd: string, cwd: string) => {
      cwds.push(cwd);
      return { code: 0, stdout: "OK", stderr: "", timedOut: false };
    });

    try {
      await probeModels(cfg, repo, [fake], health);
    } finally {
      if (priorImpl) shMock.mockImplementation(priorImpl);
    }

    expect(cwds).toEqual([repo]);
  });

  test("scan-heavy adapters declare neutral probeCwd; repo-trust adapters do not", () => {
    expect(claudeCode.probeCwd).toBe("neutral");
    expect(opencode.probeCwd).toBe("neutral");
    expect(pi.probeCwd).toBe("neutral");
    expect(grok.probeCwd).toBe("neutral");
    expect(codex.probeCwd).toBeUndefined();
    expect(cursorAgent.probeCwd).toBeUndefined();
  });
});

describe("OBS-30 autoPrefer", () => {
  const adapters = [cursorAgent, codex, grok];

  test("deriveAutoPrefer for implement orders grok/cursor ahead and omits codex", () => {
    const cfg = structuredClone(DEFAULT_CONFIG);
    const health: Record<string, import("../../src/adapters/types.js").AuthHealth> = {
      "cursor-agent": {
        installed: true, authed: true, models: ["composer-2.5"],
        modelAuth: { "composer-2.5": { authed: true, probedAt: "2026-07-15T00:00:00.000Z", durationMs: 5000 } },
      },
      grok: {
        installed: true, authed: true, models: ["grok-4.5"],
        modelAuth: { "grok-4.5": { authed: true, probedAt: "2026-07-15T00:00:00.000Z", durationMs: 1000 } },
      },
      codex: {
        installed: true, authed: true, models: ["gpt-5.6-terra"],
        modelAuth: { "gpt-5.6-terra": { authed: false, reason: "HTTP 403", probedAt: "2026-07-15T00:00:00.000Z", durationMs: 2000 } },
      },
    };
    const autoPrefer = deriveAutoPrefer(cfg, adapters, health);
    expect(autoPrefer.implement).toEqual(["grok", "cursor-agent"]);
    expect(autoPrefer.implement).not.toContain("codex");
    expect(autoPrefer.derivedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  test("probeModels + writeDoctor persist autoPrefer to doctor.json", async () => {
    const repo = mkdtempSync(join(tmpdir(), "tickmarkr-autoprefer-"));
    const script = join(repo, "fake.json");
    writeFileSync(script, JSON.stringify({ tasks: {} }));
    const fake = new FakeAdapter(script);
    vi.spyOn(fake, "headlessCommand").mockReturnValue("printf OK");
    const cfg = structuredClone(DEFAULT_CONFIG);
    cfg.routing.map.implement = { tier: "mid", prefer: ["cursor-agent", "codex"] };
    cfg.tiers.fake = { vendor: "fake", channel: "sub", models: { "fake-1": "mid" } };
    const health = await probeAll([fake]);
    await probeModels(cfg, repo, [fake], health);
    writeDoctor(repo, health);
    const autoPrefer = readAutoPrefer(repo);
    expect(autoPrefer?.implement).toContain("fake");
    expect(autoPrefer?.derivedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(readDoctor(repo)?.fake?.modelAuth?.["fake-1"]?.authed).toBe(true);
  });
});
