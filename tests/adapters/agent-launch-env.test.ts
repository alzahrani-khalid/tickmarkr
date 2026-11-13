// Queue row 439 (D-2187 add.176, add.179): every launch of an adapter's CLI by the product starts without the Artificial
// Analysis key, whatever command reaches it, while the parent keeps the key, payload shells receive it and an unlisted
// canary still reaches every child. Each cell runs the production function named in the contract's closed case table
// against a `#!/bin/sh` stand-in (shell builtins only) that records its first argument and PRESENT or ABSENT for the key
// and the canary — never a value.
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { SHIPPED_CLI_CATALOG, isNativeCliDrive, type CliEntry, type DeclarativeCliDrive } from "../../src/adapters/catalog.js";
import { ARTIFICIAL_ANALYSIS_KEY_NAME, lookupArtificialAnalysisKey } from "../../src/adapters/catalog-remote.js";
import { claudeCode, statedClaudeIdentity } from "../../src/adapters/claude-code.js";
import { codex } from "../../src/adapters/codex.js";
import { codexSandbox } from "../../src/adapters/codex-commit-check.js";
import { cursorAgent } from "../../src/adapters/cursor-agent.js";
import { grok } from "../../src/adapters/grok.js";
import { kimi } from "../../src/adapters/kimi.js";
import { opencode } from "../../src/adapters/opencode.js";
import { pi } from "../../src/adapters/pi.js";
import { parseWorkerResult } from "../../src/adapters/prompt.js";
import { qwen } from "../../src/adapters/qwen.js";
import { declarativeAdapter, probeHelpText, probeVersionShell } from "../../src/adapters/registry.js";
import { shq, type AuthHealth, type BillingChannel, type WorkerAdapter } from "../../src/adapters/types.js";
import { DEFAULT_CONFIG } from "../../src/config/config.js";
import { dispatchFixture } from "../../src/eval/dispatch.js";
import { sh } from "../../src/run/git.js";
import { makeTestTempDir } from "../helpers/tmprepo.js";

afterEach(() => {
  vi.unstubAllEnvs();
});

const KEY = ARTIFICIAL_ANALYSIS_KEY_NAME;
const DUMMY = "row439-dummy-not-a-key";
const CANARY = "TICKMARKR_ROW439_CANARY";
const TOOL_PATH = process.env.PATH ?? "";
const VITEST_VALUE = process.env.VITEST;
// Every record file this suite wrote, for the closure cell.
const RECORD_FILES: string[] = [];

const arm = () => { vi.stubEnv(KEY, DUMMY); vi.stubEnv(CANARY, "1"); };
// A boolean comparison inside the test: the value is never printed.
const parentKeepsKey = () => expect(process.env[KEY] === DUMMY).toBe(true);
const ABSENT = (label: string) => `${label} key=ABSENT canary=PRESENT`;
const PRESENT = (label: string) => `${label} key=PRESENT canary=PRESENT`;

/** One stand-in per name in its own bin directory, each recording to `<name>.rec`. */
function standIns(names: string[], opts: { linkSh?: boolean } = {}) {
  const dir = makeTestTempDir("row439-");
  const bin = join(dir, "bin");
  mkdirSync(bin);
  for (const name of names) {
    const rec = join(dir, `${name}.rec`);
    RECORD_FILES.push(rec);
    writeFileSync(join(bin, name), [
      "#!/bin/sh",
      `k=ABSENT; [ -n "\${${KEY}+x}" ] && k=PRESENT`,
      `c=ABSENT; [ -n "\${${CANARY}+x}" ] && c=PRESENT`,
      `printf '%s key=%s canary=%s\\n' "\${1:-none}" "$k" "$c" >> ${shq(rec)}`,
      "exit 0",
      "",
    ].join("\n"));
    chmodSync(join(bin, name), 0o755);
  }
  if (opts.linkSh) symlinkSync("/bin/sh", join(bin, "sh"));
  const records = (name: string): string[] => {
    const rec = join(dir, `${name}.rec`);
    return existsSync(rec) ? readFileSync(rec, "utf8").split("\n").filter(Boolean) : [];
  };
  return { dir, bin, path: (name: string) => join(bin, name), records };
}

/** A disposable HOME whose login profile prepends `bin` to PATH and, when asked, exports the dummy key. */
function profileHome(bin: string, exportKey: boolean): string {
  const home = makeTestTempDir("row439-home-");
  writeFileSync(join(home, ".bash_profile"),
    `${exportKey ? `export ${KEY}=${shq(DUMMY)}\n` : ""}export PATH=${shq(bin)}:"$PATH"\n`);
  return home;
}

/** The payload control: the tool PATH back, the stand-in by absolute path through a plain `sh` reads the key PRESENT. */
async function payloadControl(s: ReturnType<typeof standIns>, name: string): Promise<void> {
  vi.stubEnv("PATH", TOOL_PATH);
  if (VITEST_VALUE !== undefined) vi.stubEnv("VITEST", VITEST_VALUE);
  vi.stubEnv("HOME", makeTestTempDir("row439-home-"));
  const r = await sh(`${shq(s.path(name))} control`, process.cwd());
  expect(r.code).toBe(0);
  expect(s.records(name).at(-1)).toBe(PRESENT("control"));
}

/** The in-process catalog key lookup answers from the parent's environment with the dummy (a boolean, never printed). */
const lookupAnswers = () => {
  const lookup = lookupArtificialAnalysisKey();
  expect(lookup.ok && lookup.source === "environment" && lookup.key === DUMMY).toBe(true);
};

/**
 * One launch cell: PATH stubbed to the stand-in directory alone for the call; right after it the parent keeps the key and
 * the lookup answers, the launch records ABSENT with the canary PRESENT, then the same stand-in's payload control reads
 * PRESENT without the key being stubbed again, and the parent and the lookup still hold.
 */
async function launchCell(s: ReturnType<typeof standIns>, name: string, labels: string[], launch: () => unknown): Promise<void> {
  vi.stubEnv("PATH", s.bin);
  const before = s.records(name).length;
  await launch();
  parentKeepsKey();
  lookupAnswers();
  expect(s.records(name).slice(before)).toEqual(labels.map(ABSENT));
  await payloadControl(s, name);
  parentKeepsKey();
  lookupAnswers();
}

describe("queue row 439: adapter CLI launches withhold the Artificial Analysis key", () => {
  test("the stated identity turn reached under an empty VITEST starts its stand-in without the Artificial Analysis key while the parent keeps it and a plain payload shell receives it", async () => {
    const s = standIns(["claude"]);
    arm();
    vi.stubEnv("VITEST", "");
    vi.stubEnv("PATH", s.bin);
    statedClaudeIdentity(process.cwd(), "opus");
    parentKeepsKey();
    lookupAnswers();
    expect(s.records("claude")).toEqual([ABSENT("-p")]);
    await payloadControl(s, "claude");
    parentKeepsKey();
    lookupAnswers();
  });

  test("every adapter version help listing and sandbox probe and the kimi provider listing start their stand-ins without the key while the parent keeps it", async () => {
    const names = ["claude", "codex", "qwen", "kimi", "opencode", "pi", "grok", "cursor-agent"];
    const s = standIns(names, { linkSh: true });
    arm();
    const worktree = makeTestTempDir("row439-wt-");
    await launchCell(s, "claude", ["--version"], () => claudeCode.probe());
    await launchCell(s, "codex", ["--version"], () => codex.probe());
    await launchCell(s, "qwen", ["--version"], () => qwen.probe());
    await launchCell(s, "opencode", ["--help"], () => probeHelpText("opencode"));
    await launchCell(s, "kimi", ["--help"], () => kimi.interactiveSeed!.launch("kimi-model"));
    await launchCell(s, "opencode", ["models"], () => opencode.listModels!());
    await launchCell(s, "grok", ["models"], () => grok.listModels!());
    await launchCell(s, "cursor-agent", ["--list-models"], () => cursorAgent.listModels!());
    await launchCell(s, "pi", ["--version", "--list-models"], () => pi.probe());
    await launchCell(s, "pi", ["--list-models"], () => pi.listModels!());
    await launchCell(s, "codex", ["sandbox"], () => codexSandbox({
      worktree, commonDir: join(worktree, "common"), branch: "row439-probe", control: join(worktree, "control"),
      lock: join(worktree, "lock"), token: "row439-token", hostileHook: join(worktree, "hook"), hostileRoot: join(worktree, "root"),
    }));

    // Row 11: the provider listing runs through a login shell, which re-derives PATH from the profile.
    vi.stubEnv("PATH", TOOL_PATH);
    vi.stubEnv("HOME", profileHome(s.bin, false));
    await kimi.listModels!();
    parentKeepsKey();
    lookupAnswers();
    expect(s.records("kimi").at(-1)).toBe(ABSENT("provider"));
    const plain = await sh("kimi control", process.cwd());
    expect(plain.code).toBe(0);
    expect(s.records("kimi").at(-1)).toBe(PRESENT("control"));
    parentKeepsKey();
    lookupAnswers();
  });

  test("the login shell resolver version probe and a declarative model listing start without the key their profile exports while a plain shell under that profile keeps it", async () => {
    const name = "tkr439-standin";
    const s = standIns([name]);
    arm();
    vi.stubEnv("HOME", profileHome(s.bin, true));
    const health = probeVersionShell(name);
    parentKeepsKey();
    lookupAnswers();
    expect(health.installed).toBe(true);
    expect(s.records(name)).toEqual([ABSENT("--version")]);
    const plainAfterProbe = await sh(`${name} control`, process.cwd());
    expect(plainAfterProbe.code).toBe(0);
    expect(s.records(name).at(-1)).toBe(PRESENT("control"));
    parentKeepsKey();
    const agy = SHIPPED_CLI_CATALOG.find((c) => c.id === "agy")!;
    if (!agy.drive || isNativeCliDrive(agy.drive)) throw new Error("expected agy's declarative drive");
    const adapter = declarativeAdapter({ ...(agy as CliEntry & { drive: DeclarativeCliDrive }), binary: name });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await adapter.listModelsResult!();
    parentKeepsKey();
    lookupAnswers();
    expect(s.records(name).at(-1)).toBe(ABSENT("models"));
    // The profile ran and exported the key: a plain shell under it hands the key to the same stand-in.
    const plain = await sh(`${name} control`, process.cwd());
    expect(plain.code).toBe(0);
    expect(s.records(name).at(-1)).toBe(PRESENT("control"));
    parentKeepsKey();
    lookupAnswers();
  });

  test("the eval dispatch worker starts without the key while its fixture oracle and the parent keep it", async () => {
    const s = standIns(["agent"]);
    arm();
    const root = mkdtempSync(join(tmpdir(), "tickmarkr-row439-fx-"));
    try {
      const dir = join(root, "fx");
      mkdirSync(join(dir, "start"), { recursive: true });
      mkdirSync(join(dir, "solution"), { recursive: true });
      writeFileSync(join(dir, "start", "a.txt"), "start");
      writeFileSync(join(dir, "solution", "a.txt"), "expected");
      writeFileSync(join(dir, "spec.md"), `<!-- tickmarkr:spec -->
# Fixture

## T1: fix a.txt
- goal: a.txt contains expected
- shape: implement
- acceptance:
  - command: ${s.path("agent")} oracle
`);
      const channel: BillingChannel = { adapter: "row439-stub", vendor: "row439-stub", model: "m1", channel: "sub", tier: "frontier" };
      const health: AuthHealth = { installed: true, authed: true, models: ["m1"], modelAuth: { m1: { authed: true, probedAt: "1970-01-01T00:00:00.000Z" } } };
      const stub: WorkerAdapter = {
        id: "row439-stub",
        vendor: "row439-stub",
        probe: async () => health,
        channels: () => [channel],
        headlessCommand: () => "true",
        interactiveCommand: () => null,
        invoke: () => ({ command: `${shq(s.path("agent"))} worker` }),
        parse: parseWorkerResult,
      };
      const results = await dispatchFixture({
        fixture: { id: "fx", path: dir, startDir: join(dir, "start"), solutionDir: join(dir, "solution") },
        channels: [channel], adapters: [stub], health: { "row439-stub": health }, cfg: DEFAULT_CONFIG,
      });
      expect(results).toHaveLength(1);
      expect(results[0]!.skipped).toBe(false);
      parentKeepsKey();
      lookupAnswers();
      expect(s.records("agent")).toEqual([ABSENT("worker"), PRESENT("oracle")]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("after every launch the catalog key lookup still answers from the parent environment and every stand-in record holds presence only", async () => {
    const s = standIns(["claude"]);
    arm();
    vi.stubEnv("PATH", s.bin);
    await claudeCode.probe();
    vi.stubEnv("PATH", TOOL_PATH);
    expect(s.records("claude")).toEqual([ABSENT("--version")]);
    parentKeepsKey();
    lookupAnswers();
    const lines = RECORD_FILES.filter(existsSync).flatMap((f) => readFileSync(f, "utf8").split("\n").filter(Boolean));
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      expect(/^\S+ key=(PRESENT|ABSENT) canary=(PRESENT|ABSENT)$/.test(line)).toBe(true);
      expect(line.includes(DUMMY)).toBe(false);
    }
  });
});
