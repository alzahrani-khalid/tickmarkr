// Queue row 439, second half; D-2187 add.176 (RULING-C 1): the judge, review and scope seat script runLlm's pane path
// writes, and the consult pane script, each run the agent key prefix as their own line before the agent command, so a
// seat starts without the Artificial Analysis key in any terminal. Each cell runs production code with a pane driver
// stub, captures the written script, and executes it in a shell carrying a dummy key and a canary. The stand-in records
// only NAMES and PRESENT or ABSENT, never a value.
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import { ARTIFICIAL_ANALYSIS_KEY_NAME } from "../../src/adapters/catalog-remote.js";
import { FakeAdapter } from "../../src/adapters/fake.js";
import { shq } from "../../src/adapters/types.js";
import { DEFAULT_CONFIG } from "../../src/config/config.js";
import { agentEnvShellPrefix } from "../../src/drivers/agent-env.js";
import { SubprocessDriver } from "../../src/drivers/subprocess.js";
import type { ExecutorDriver } from "../../src/drivers/types.js";
import { gateExitTrailer, runLlm } from "../../src/gates/llm.js";
import { consult, type Dossier } from "../../src/run/consult.js";
import { makeTestTempDir } from "../helpers/tmprepo.js";

const KEY = ARTIFICIAL_ANALYSIS_KEY_NAME;
const CANARY = "TICKMARKR_ROW439_CANARY";
const DUMMY = "row439-dummy-key";
const REFUSAL = "tickmarkr: the Artificial Analysis key is still in the agent's environment, so the agent does not start (queue row 367)";

afterEach(() => vi.unstubAllEnvs());

/** A presence-only stand-in: builtins only, one `<label> key=… canary=…` line, never a value; silent outside the harness. */
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
  return { bin, lines: () => readFileSync(record, "utf8").split("\n").filter(Boolean) };
}

/** One outer shell carrying the key and the canary runs `body`; it then reports whether IT still holds the key. */
function harness(body: string, opts: { path?: string } = {}) {
  const r = spawnSync("/bin/bash", ["-c", `${body}\nrc=$?\nif [ -n "\${${KEY}+x}" ]; then echo parent=PRESENT; else echo parent=ABSENT; fi\nexit $rc`], {
    encoding: "utf8", timeout: 30_000,
    env: { ...process.env, PATH: opts.path ?? process.env.PATH, [KEY]: DUMMY, [CANARY]: "1", TICKMARKR_ROW439_HARNESS: "1" },
  });
  const out = `${r.stdout}${r.stderr}`;
  expect(out).not.toContain(DUMMY);
  return { out, status: r.status, parent: /parent=(\w+)/.exec(r.stdout)?.[1] };
}

interface Captured { label: string; text: string; script: string; nonce: string }
const seats: Captured[] = [];
let consultSeat: Captured;
let agent: ReturnType<typeof standIn>;

/** A pane driver stub over the subprocess driver that keeps a copy of every dispatched script. */
function paneStub(keep: string, label: () => string): { driver: ExecutorDriver; captured: Captured[] } {
  const inner = new SubprocessDriver();
  const captured: Captured[] = [];
  const driver: ExecutorDriver = {
    id: "pane-stub", interactive: false,
    slot: inner.slot.bind(inner),
    run: async (slot, line) => {
      const path = /^bash '(.+)'$/.exec(line)?.[1];
      if (path) {
        const script = join(keep, `seat-${label()}.sh`);
        copyFileSync(path, script);
        const text = readFileSync(script, "utf8");
        captured.push({ label: label(), text, script, nonce: /EXIT_([0-9a-f]+):%s/.exec(text)?.[1] ?? "" });
      }
      return inner.run(slot, line);
    },
    waitOutput: inner.waitOutput.bind(inner), waitAgentStatus: inner.waitAgentStatus.bind(inner),
    read: inner.read.bind(inner), notify: async () => {}, close: inner.close.bind(inner),
    worktree: inner.worktree.bind(inner), status: inner.status.bind(inner),
  };
  return { driver, captured };
}

beforeAll(async () => {
  vi.stubEnv(KEY, DUMMY);
  const dir = makeTestTempDir("row439-seat-");
  agent = standIn(makeTestTempDir("row439-seat-agent-"));
  let label = "";
  // FakeAdapter reads its script synchronously in the constructor, so the file exists first.
  writeFileSync(join(dir, "fake.json"), JSON.stringify({ tasks: {} }));
  const fake = new FakeAdapter(join(dir, "fake.json"));
  // The stand-in by absolute path, then a verdict carrying the prompt's nonce so each seat completes.
  fake.headlessCommand = (promptFile) => `${shq(agent.bin)} ${label}; node -e ${shq(`
    const p = require('fs').readFileSync(process.argv[1], 'utf8');
    const nonce = /VERDICT_NONCE: ([0-9a-f]+)/.exec(p)?.[1];
    console.log(JSON.stringify({nonce, action:'retry', notes:'seat'}));
  `)} ${shq(promptFile)}`;
  const { driver, captured } = paneStub(makeTestTempDir("row439-seat-scripts-"), () => label);
  for (const [prefix, role] of [["TICKMARKR-JUDGE", "judge"], ["TICKMARKR-REVIEW", "review"], ["TICKMARKR-SCOPE", "scope"]]) {
    label = role;
    await runLlm(fake, "fake-1", `${prefix}\n## Task T1: seal\nVERDICT_NONCE: abc12345`, dir, { driver, name: "seat" }, 10_000);
  }
  label = "consult";
  const cfg = structuredClone(DEFAULT_CONFIG);
  cfg.visibility.llm = "pane";
  cfg.consult = { adapter: "fake", model: "fake-1", stallMinutes: 1 };
  const dossier: Dossier = { taskId: "T1", trigger: "gate-fail", journalTail: "", transcript: "", diff: "", gates: [] };
  expect(await consult(dossier, cfg, [fake], driver, dir, dir)).toMatchObject({ action: "retry" });
  // The parent never lost its key to any launch.
  expect(process.env[KEY]).toBe(DUMMY);
  seats.push(...captured.filter((c) => c.label !== "consult"));
  consultSeat = captured.find((c) => c.label === "consult")!;
}, 60_000);

/** The prefix is its own line right before the agent command; removing it leaves the base script, trailer last. */
function expectSealed(c: Captured, marker: string[]) {
  const lines = c.text.split("\n");
  const at = lines.indexOf(agentEnvShellPrefix());
  expect(at, c.label).toBeGreaterThan(0);
  // The agent command follows the prefix (a gate seat's tee wrapper may open on the line between); none precedes it.
  expect(lines.slice(0, at).some((l) => l.includes("row439-agent")), c.label).toBe(false);
  expect(lines.slice(at + 1, at + 4).some((l) => l.includes(`row439-agent' ${c.label}; `)), c.label).toBe(true);
  const base = lines.filter((_, i) => i !== at);
  expect(base[0]).toBe("export BASH_SILENCE_DEPRECATION_WARNING=1");
  for (const m of marker) expect(base.slice(0, at), c.label).toContain(m);
  expect(base[base.length - 1]).toBe(gateExitTrailer(c.nonce));
  expect(base.filter((l) => l.includes("row439-agent"))).toHaveLength(1);
}

function runSeat(c: Captured, opts: { path?: string } = {}) {
  const before = agent.lines().length;
  const r = harness(`/bin/bash ${shq(c.script)}`, opts);
  return { ...r, records: agent.lines().slice(before) };
}

describe("seat scripts", () => {
  test("the judge review and scope seat scripts start their agent without the key while the canary and the parent keep theirs", () => {
    expect(seats.map((c) => c.label)).toEqual(["judge", "review", "scope"]);
    for (const c of seats) {
      expectSealed(c, ["unset TICKMARKR_SEAT", `export TICKMARKR_SEAT=${c.label}`]);
      const r = runSeat(c);
      expect(r.records, c.label).toEqual([`${c.label} key=ABSENT canary=PRESENT`]);
      expect(r.parent).toBe("PRESENT");
    }
  });

  test("the consult seat script starts its agent without the key while the canary and the parent keep theirs", () => {
    expect(consultSeat).toBeDefined();
    expectSealed(consultSeat, ["export TICKMARKR_SEAT=consult"]);
    const r = runSeat(consultSeat);
    expect(r.records).toEqual(["consult key=ABSENT canary=PRESENT"]);
    expect(r.parent).toBe("PRESENT");
  });

  test("a seat script that cannot remove the key prints its refusal and never starts the agent", () => {
    // PATH holding no env: the prefix cannot prove the key gone.
    const noEnv = makeTestTempDir("row439-seat-noenv-");
    for (const c of [...seats, consultSeat]) {
      const r = runSeat(c, { path: noEnv });
      expect(r.status, c.label).toBe(126);
      expect(r.out).toContain(REFUSAL);
      expect(r.records).toEqual([]);
    }
  });
});
