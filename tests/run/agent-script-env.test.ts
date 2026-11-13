// Queue row 439, second half; D-2187 add.176 (RULING-C 1 to 3): the key seal travels with the command tickmarkr builds —
// the worker dispatch script's own prefix line and the interactive seed's sealed, intent-recorded launch — so a worker
// starts without the Artificial Analysis key in any terminal, created, adopted or recovered. Every cell runs production
// code, captures the script or line, and executes it in a shell carrying a dummy key and a canary. A stand-in records
// only NAMES and PRESENT or ABSENT, never a value.
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import { ARTIFICIAL_ANALYSIS_KEY_NAME } from "../../src/adapters/catalog-remote.js";
import { claudeCode } from "../../src/adapters/claude-code.js";
import { KIMI_INPUT_BOX, runKimiInteractiveSeed } from "../../src/adapters/kimi.js";
import { shq, type Assignment, type InteractiveSeed, type WorkerAdapter } from "../../src/adapters/types.js";
import { paneDispatchCommand } from "../../src/brand.js";
import { agentEnvShellPrefix } from "../../src/drivers/agent-env.js";
import { HerdrDriver } from "../../src/drivers/herdr.js";
import { checkoutProofLine, OrcaDriver } from "../../src/drivers/orca.js";
import { SubprocessDriver } from "../../src/drivers/subprocess.js";
import { formatOwnedName, type Slot } from "../../src/drivers/types.js";
import { runDaemon } from "../../src/run/daemon.js";
import { runInteractiveSeed } from "../../src/run/interactive-seed.js";
import { FakeOrca } from "../helpers/fake-orca.js";
import { COMMIT, makeTestTempDir, setupRepo, T } from "../helpers/tmprepo.js";

const KEY = ARTIFICIAL_ANALYSIS_KEY_NAME;
const CANARY = "TICKMARKR_ROW439_CANARY";
const DUMMY = "row439-dummy-key";
const REFUSAL = "tickmarkr: the Artificial Analysis key is still in the agent's environment, so the agent does not start (queue row 367)";

afterEach(() => vi.unstubAllEnvs());

/** A presence-only stand-in: builtins only, one `<label> key=… canary=…` line, never a value. Outside a harness shell
 *  (the daemon's own execution of the same script) it records nothing and lets the scripted fake work proceed. */
function standIn(dir: string) {
  const bin = join(dir, "row439-agent");
  const record = join(dir, "row439-record.txt");
  writeFileSync(bin, `#!/bin/sh
[ -n "$TICKMARKR_ROW439_HARNESS" ] || exit 0
if [ -n "\${${KEY}+x}" ]; then k=PRESENT; else k=ABSENT; fi
if [ -n "\${${CANARY}+x}" ]; then c=PRESENT; else c=ABSENT; fi
printf '%s key=%s canary=%s\\n' "$1" "$k" "$c" >> ${shq(record)}
exit 1
`);
  chmodSync(bin, 0o755);
  writeFileSync(record, "");
  return { bin, record, lines: () => readFileSync(record, "utf8").split("\n").filter(Boolean) };
}

/** One outer shell carrying the key and the canary runs `body`; it then reports whether IT still holds the key. */
function harness(body: string, opts: { path?: string; cwd?: string } = {}) {
  const r = spawnSync("/bin/bash", ["-c", `${body}\nrc=$?\nif [ -n "\${${KEY}+x}" ]; then echo parent=PRESENT; else echo parent=ABSENT; fi\nexit $rc`], {
    cwd: opts.cwd, encoding: "utf8", timeout: 30_000,
    env: { ...process.env, PATH: opts.path ?? process.env.PATH, [KEY]: DUMMY, [CANARY]: "1", TICKMARKR_ROW439_HARNESS: "1" },
  });
  const out = `${r.stdout}${r.stderr}`;
  expect(out).not.toContain(DUMMY);
  return { out, status: r.status, parent: /parent=(\w+)/.exec(r.stdout)?.[1] };
}

// The worker scripts runDaemon writes, captured at delivery, with the checkout each one cds into.
interface Captured { label: string; script: string; text: string; cwd: string }
let fresh: Captured;
let resumed: Captured;
let agent: ReturnType<typeof standIn>;

async function captureWorkerScripts(): Promise<Captured[]> {
  vi.stubEnv("HOME", makeTestTempDir("row439-home-"));
  const { repo, fake } = setupRepo([T("T1")], { tasks: { T1: [
    { shell: "true", result: { ok: true, summary: "first attempt needs work" } },
    { shell: `echo done > done.txt && ${COMMIT} done`, result: { ok: true, summary: "done" } },
  ] } });
  agent = standIn(makeTestTempDir("row439-agent-"));
  const adapter: WorkerAdapter = fake;
  // A resumeCommand adapter whose context is unknown reaches the resume branch on the second attempt.
  adapter.contextUsage = claudeCode.contextUsage;
  adapter.resumeUnknownContext = true;
  const label = (name: string, cmd: string) => `${shq(agent.bin)} ${name} && ${cmd}`;
  const invoke = fake.invoke.bind(fake);
  fake.invoke = (...a) => ({ ...invoke(...a), command: label("fresh", invoke(...a).command) });
  const interactive = fake.interactiveCommand.bind(fake);
  fake.interactiveCommand = (p, m) => { const c = interactive(p, m); return c === null ? null : label("fresh", c); };
  const resume = fake.resumeCommand.bind(fake);
  fake.resumeCommand = (id, p, m) => label("resume", resume(id, p, m));
  const captured: Captured[] = [];
  const keep = makeTestTempDir("row439-scripts-");
  class Capture extends SubprocessDriver {
    override interactive = true;
    override async run(slot: Slot, command: string) {
      const m = /^bash '(.+)'$/.exec(command);
      if (m && slot.name.includes("-worker-")) {
        const script = join(keep, `worker-${captured.length}.sh`);
        copyFileSync(m[1], script);
        const text = readFileSync(script, "utf8");
        captured.push({ label: /'\S+row439-agent' (\w+)/.exec(text)?.[1] ?? "", script, text, cwd: slot.cwd });
      }
      await super.run(slot, command);
    }
  }
  await runDaemon(repo, { adapters: [adapter], runId: "run-row439", driver: new Capture() });
  return captured;
}

/** Run a captured worker script by path in the harness shell (its checkout may have been removed after the run). */
function runScript(c: Captured, opts: { path?: string } = {}) {
  mkdirSync(c.cwd, { recursive: true });
  return harness(`/bin/bash ${shq(c.script)}`, opts);
}

beforeAll(async () => {
  const scripts = await captureWorkerScripts();
  fresh = scripts.find((s) => s.label === "fresh")!;
  resumed = scripts.find((s) => s.label === "resume")!;
}, 120_000);

const BASE_ORDER = [/^cd '/, /^export /, /^unset TICKMARKR_SEAT/, /^worker_pgid=/, /^if \[ -n "\$worker_pgid"/, /^ps -o sess=/,
  /^ps -o pid=,lstart=/, /^export BASH_SILENCE_DEPRECATION_WARNING=1$/, /./, /TICKMARKR_DISPATCH_/];

describe("worker dispatch script", () => {
  test("the worker dispatch script on the fresh and resume branches starts its agent without the key while the canary and the parent keep theirs", () => {
    expect(fresh).toBeDefined();
    expect(resumed).toBeDefined();
    for (const c of [fresh, resumed]) {
      const lines = c.text.split("\n");
      const at = lines.indexOf(agentEnvShellPrefix());
      // The prefix is its own line, right before the agent command; every base line keeps its base order.
      expect(at).toBeGreaterThan(0);
      expect(lines[at + 1]).toContain(`row439-agent' ${c.label} && `);
      const base = lines.filter((_, i) => i !== at);
      BASE_ORDER.forEach((re, i) => expect(base[i]).toMatch(re));
      expect(base[BASE_ORDER.length]).toContain("row439-agent");
      const before = agent.lines().length;
      const r = runScript(c);
      expect(agent.lines().slice(before)).toEqual([`${c.label} key=ABSENT canary=PRESENT`]);
      expect(r.parent).toBe("PRESENT");
    }
  });

  test("a worker script or seed launch that cannot remove the key prints its refusal and never starts the agent", async () => {
    // PATH holding no env: the prefix cannot prove the key gone.
    const noEnv = makeTestTempDir("row439-noenv-");
    for (const c of [fresh, resumed]) {
      const before = agent.lines().length;
      const r = runScript(c, { path: noEnv });
      expect(r.status).toBe(126);
      expect(r.out).toContain(REFUSAL);
      expect(agent.lines().slice(before)).toEqual([]);
    }
    // The seed launch line, captured from runInteractiveSeed, refuses the same way.
    const { launch } = await captureSeed();
    const before = agent.lines().length;
    const r = harness(`/bin/bash -c ${shq(launch)}`, { path: noEnv });
    expect(r.status).toBe(126);
    expect(r.out).toContain(REFUSAL);
    expect(agent.lines().slice(before)).toEqual([]);
  });
});

async function captureSeed() {
  const seed: InteractiveSeed = {
    launch: (model: string) => `${shq(agent.bin)} seed-${model}`,
    readinessMatch: "TUI ready",
    seedLine: (promptFile: string) => `Read ${promptFile} and do exactly what it says.`,
  };
  const runs: string[] = [];
  let buf = "";
  const slot: Slot = { id: "p1", name: "row439-seed", cwd: "/tmp" };
  const driver = {
    run: async (_s: Slot, cmd: string) => {
      runs.push(cmd);
      buf += runs.length === 1 ? "TUI ready\n> " : `\n${cmd}\n[submitted]\n`;
    },
    waitOutput: async (_s: Slot, pattern: string) => buf.includes(pattern),
    read: async () => buf,
  };
  const assignment: Assignment = { adapter: "fake", model: "fake-1", channel: "sub", tier: "mid" };
  const promptFile = "/tmp/row439-prompt.md";
  const result = await runInteractiveSeed({
    driver, slot, adapter: { interactiveSeed: seed } as unknown as WorkerAdapter, assignment, promptFile, taskTimeoutMinutes: 0.1,
  });
  return { result, runs, launch: runs[0]!, seedText: seed.seedLine(promptFile) };
}

describe("interactive seed launch", () => {
  test("the seed launch line starts its agent without the key while the seed text typed afterwards is byte-equal to the base", async () => {
    const { result, runs, launch, seedText } = await captureSeed();
    expect(result.seedFailed).toBe(false);
    expect(runs).toHaveLength(2);
    expect(launch.startsWith(agentEnvShellPrefix())).toBe(true);
    expect(runs[1]).toBe(seedText);
    const before = agent.lines().length;
    const r = harness(`/bin/bash -c ${shq(launch)}`);
    expect(agent.lines().slice(before)).toEqual(["seed-fake-1 key=ABSENT canary=PRESENT"]);
    expect(r.parent).toBe("PRESENT");
  });

  test("the herdr driver delivers the prefixed seed launch as a shell line and never as a typed turn", async () => {
    const root = makeTestTempDir("row439-herdr-");
    // The presence-only stand-in plays kimi: silent outside the harness shell (help probe, the fake pane's own run).
    const kimiBin = join(root, "kimi");
    copyFileSync(agent.bin, kimiBin);
    chmodSync(kimiBin, 0o755);
    const runs = join(root, "pane-runs");
    mkdirSync(runs);
    vi.stubEnv("PATH", `${root}:/bin:/usr/bin`);
    vi.stubEnv("HERDR_WORKSPACE_ID", "wTEST");
    const herdr = join(root, "herdr");
    const log = join(root, "herdr-calls.txt");
    const pane = join(root, "pane.txt");
    const slotName = "T3-worker-kimi-a0-launch";
    const box = (text: string) => `Model: k3\\nSend /help for help information.\\n╭──────────╮\\n│ > ${text} │\\n╰──────────╯\\n`;
    writeFileSync(pane, box("").replace(/\\n/g, "\n"));
    writeFileSync(log, "");
    writeFileSync(herdr, `#!/bin/sh
printf '%s\\n' "$*" >> '${log}'
case "$1 $2" in
  "tab create") printf '{"result":{"tab":{"tab_id":"w1:t1"},"root_pane":{"pane_id":"w1:p9"}}}\\n' ;;
  "pane list") printf '{"result":{"panes":[{"pane_id":"w1:p9","label":"${slotName}","tab_id":"w1:t1","workspace_id":"wTEST"}]}}\\n' ;;
  "pane run") n=$(ls '${runs}' | wc -l | tr -d ' '); printf '%s' "$4" > '${runs}'/run-$n; /bin/bash -c "$4" >/dev/null 2>&1 || :; printf '{}\\n' ;;
  "pane read") /bin/cat '${pane}' ;;
  "pane send-text") printf '${box("%s")}' "$4" > '${pane}'; printf '{}\\n' ;;
  "pane send-keys") printf '${box("")}' > '${pane}'; printf '{}\\n' ;;
  *) printf '{}\\n' ;;
esac
`);
    chmodSync(herdr, 0o755);
    const driver = new HerdrDriver(herdr);
    const slot = await driver.slot(root, slotName);
    const assignment: Assignment = { adapter: "kimi", model: "kimi-code/k3", channel: "sub", tier: "frontier" };
    const result = await runKimiInteractiveSeed({ driver, slot, assignment, promptFile: "/tmp/prompt.md", taskTimeoutMinutes: 0.1 });
    expect(result.seedFailed).toBe(false);
    const calls = readFileSync(log, "utf8").split("\n");
    const launches = calls.filter((l) => l.startsWith("pane run w1:p9 ") && l.includes("kimi ") && l.includes("-m "));
    expect(launches.length).toBeGreaterThan(0);
    expect(launches.every((l) => l.includes("typeset +x"))).toBe(true);
    // The raw adapter matcher stays anchored: only the recorded launch intent keeps the sealed line a shell line.
    expect(KIMI_INPUT_BOX.launchCommand?.(`${agentEnvShellPrefix()}kimi --auto -m 'kimi-code/k3'`)).toBe(false);
    expect(calls.some((l) => l.startsWith("pane send-text w1:p9 ") && (l.includes("typeset") || l.includes("kimi ")))).toBe(false);
    expect(calls).toContain("pane send-text w1:p9 Read /tmp/prompt.md and do exactly what it says.");
    // Every captured shell line that launches kimi, replayed in a shell carrying the dummy key and the canary.
    const shellLines = readdirSync(runs).sort().map((f) => readFileSync(join(runs, f), "utf8")).filter((l) => l.includes("kimi -y -m "));
    expect(shellLines.length).toBeGreaterThan(0);
    for (const line of shellLines) {
      const before = agent.lines().length;
      const r = harness(`/bin/bash -c ${shq(line)}`, { path: `${root}:/bin:/usr/bin` });
      expect(agent.lines().slice(before)).toEqual(["-y key=ABSENT canary=PRESENT"]);
      expect(r.parent).toBe("PRESENT");
    }
  });
});

describe("Orca worker terminal", () => {
  test("an Orca worker replayed through its complete create command then a later delivery in the outer shell and a dispatch into an adopted terminal start every agent without the key", async () => {
    const checkout = join(makeTestTempDir("row439-orca-"), "checkout");
    mkdirSync(checkout, { recursive: true });
    const name = formatOwnedName({ role: "worker", taskId: "T1", attempt: 0, runId: "run-row439" });

    // Created: the first run creates the terminal (the complete --command, inCheckout() included); the second sends.
    const created = new FakeOrca({ echoSends: false, trackedWorktrees: [checkout] });
    const orca = new OrcaDriver({ pollMs: 5, exec: created.exec });
    const slot = await orca.slot(checkout, name, { group: "workers" });
    mkdirSync(fresh.cwd, { recursive: true });
    mkdirSync(resumed.cwd, { recursive: true });
    await orca.run(slot, paneDispatchCommand(fresh.script));
    await orca.run(slot, paneDispatchCommand(resumed.script));
    const create = created.calls.find((a) => a[1] === "create")!;
    const createCommand = create[create.indexOf("--command") + 1]!;
    const later = [...created.sent.values()].flat();
    expect(later).toEqual([paneDispatchCommand(resumed.script)]);
    let before = agent.lines().length;
    // One outer shell session runs both, as the terminal's own shell would.
    const r = harness(`${createCommand}\n${later[0]}`, { cwd: checkout });
    expect(agent.lines().slice(before)).toEqual(["fresh key=ABSENT canary=PRESENT", "resume key=ABSENT canary=PRESENT"]);
    expect(r.parent).toBe("PRESENT");

    // Adopted: a terminal that already exists (no create in this test) receives the next dispatch.
    const handle = "term_row439";
    const adopted = new FakeOrca({
      echoSends: false, trackedWorktrees: [checkout],
      terminals: [{ handle, title: name, worktree: checkout, lines: [checkoutProofLine(checkout)] }],
    });
    const orca2 = new OrcaDriver({ pollMs: 5, exec: adopted.exec });
    const bound = await orca2.adopt({ id: "x", name, cwd: checkout, group: "workers" });
    await orca2.run(bound, paneDispatchCommand(fresh.script));
    expect(adopted.countOf("create")).toBe(0);
    const sent = adopted.sent.get(handle) ?? [];
    expect(sent).toEqual([paneDispatchCommand(fresh.script)]);
    before = agent.lines().length;
    const r2 = harness(sent[0]!, { cwd: checkout });
    expect(agent.lines().slice(before)).toEqual(["fresh key=ABSENT canary=PRESENT"]);
    expect(r2.parent).toBe("PRESENT");
  });
});
