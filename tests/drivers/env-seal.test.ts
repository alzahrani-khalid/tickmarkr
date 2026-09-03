import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { HerdrDriver } from "../../src/drivers/herdr.js";
import { DEFAULT_FORK_CAP, FORK_CAP_ENV } from "../../src/run/git.js";
import {
  HERDR_CONTROL_VARS,
  herdrSealShellPrefix,
  sealHerdrEnv,
  SubprocessDriver,
} from "../../src/drivers/subprocess.js";

// v1.22 T3 / OBS-843: workers/judges/reviews/consults must not inherit an addressable operator
// host session. Regression for the herdr watch-tab leak and Orca terminal-identity leak classes.

function makeStub(): { bin: string; log: string; cwd: string } {
  const dir = mkdtempSync(join(tmpdir(), "tickmarkr-env-seal-"));
  const log = join(dir, "log.txt");
  const bin = join(dir, "herdr");
  const cwd = mkdtempSync(join(tmpdir(), "tickmarkr-env-seal-cwd-"));
  writeFileSync(
    bin,
    `#!/usr/bin/env bash
echo "$@" >> '${log}'
case "$1 $2" in
  "agent start") echo '{"result":{"agent":{"pane_id":"w1:p9"}}}' ;;
  "tab create") echo '{"result":{"tab":{"tab_id":"w1:t1"},"root_pane":{"pane_id":"w1:p0"}}}' ;;
  "pane split") echo '{"result":{"pane":{"pane_id":"w1:p7"}}}' ;;
  "pane layout") echo '{"result":{"layout":{"area":{"width":222},"panes":[{"pane_id":"w1:p42","rect":{"width":222}}]}}}' ;;
  "agent get") echo '{"result":{"agent":{"pane_id":"w1:p42"}}}' ;;
  "agent rename") echo '{}' ;;
  "tab rename") echo '{}' ;;
  *) echo '{}' ;;
esac
`,
  );
  chmodSync(bin, 0o755);
  return { bin, log, cwd };
}

describe("sealHerdrEnv (pure)", () => {
  test("strips host-addressing keys and leaves descriptive and hook keys", () => {
    const sealed = sealHerdrEnv({
      PATH: "/usr/bin",
      HERDR_ENV: "1",
      HERDR_SOCKET_PATH: "/tmp/herdr.sock",
      ORCA_TERMINAL_HANDLE: "term-secret",
      ORCA_PANE_KEY: "pane-secret",
      ORCA_TAB_ID: "tab-secret",
      TERM_PROGRAM: "Orca",
      ORCA_AGENT_HOOK_STATUS: "installed",
      HERDR_WORKSPACE_ID: "wTEST",
      HOME: "/home/op",
    });
    for (const key of HERDR_CONTROL_VARS) expect(sealed[key]).toBeUndefined();
    expect(sealed.PATH).toBe("/usr/bin");
    expect(sealed.HERDR_WORKSPACE_ID).toBe("wTEST");
    expect(sealed.HOME).toBe("/home/op");
    expect(sealed.TERM_PROGRAM).toBe("Orca");
    expect(sealed.ORCA_AGENT_HOOK_STATUS).toBe("installed");
  });

  test("does not mutate the input env object", () => {
    const input: NodeJS.ProcessEnv = { HERDR_ENV: "1", HERDR_SOCKET_PATH: "/s", KEEP: "1" };
    sealHerdrEnv(input);
    expect(input.HERDR_ENV).toBe("1");
    expect(input.HERDR_SOCKET_PATH).toBe("/s");
  });

  test("HERDR_CONTROL_VARS is exactly the host-addressing set", () => {
    expect([...HERDR_CONTROL_VARS]).toEqual([
      "HERDR_ENV",
      "HERDR_SOCKET_PATH",
      "ORCA_TERMINAL_HANDLE",
      "ORCA_PANE_KEY",
      "ORCA_TAB_ID",
    ]);
  });

  test("herdrSealShellPrefix unsets every control var", () => {
    const p = herdrSealShellPrefix();
    for (const k of HERDR_CONTROL_VARS) expect(p).toContain(`unset ${k}`);
  });
});

test("test: the sealed worker environment a subprocess run child and a herdr seed receive carries none of HERDR_ENV HERDR_SOCKET_PATH ORCA_TERMINAL_HANDLE ORCA_PANE_KEY and ORCA_TAB_ID while it keeps TERM_PROGRAM and every ORCA_AGENT_HOOK variable whereas a seal that strips only the herdr pair or strips TERM_PROGRAM fails", async () => {
  const hooks = ["ORCA_AGENT_HOOK_STATUS", "ORCA_AGENT_HOOK_CUSTOM"] as const;
  const fixture: NodeJS.ProcessEnv = {
    HERDR_ENV: "1",
    HERDR_SOCKET_PATH: "/tmp/herdr-secret.sock",
    ORCA_TERMINAL_HANDLE: "term-secret-value",
    ORCA_PANE_KEY: "pane-secret-value",
    ORCA_TAB_ID: "tab-secret-value",
    TERM_PROGRAM: "Orca",
    ORCA_AGENT_HOOK_STATUS: "installed",
    ORCA_AGENT_HOOK_CUSTOM: "keep-custom",
  };
  const sealed = sealHerdrEnv(fixture);
  for (const key of HERDR_CONTROL_VARS) expect(sealed[key]).toBeUndefined();
  expect(sealed.TERM_PROGRAM).toBe("Orca");
  for (const key of hooks) expect(sealed[key]).toBe(fixture[key]);

  // Adjacent controls: the old pair-only seal leaks Orca addressing, while stripping descriptive
  // TERM_PROGRAM loses required host context.
  const pairOnly = { ...fixture };
  delete pairOnly.HERDR_ENV;
  delete pairOnly.HERDR_SOCKET_PATH;
  expect(pairOnly.ORCA_TERMINAL_HANDLE).toBe("term-secret-value");
  const stripsTermProgram = { ...sealed };
  delete stripsTermProgram.TERM_PROGRAM;
  expect(stripsTermProgram.TERM_PROGRAM).not.toBe(fixture.TERM_PROGRAM);

  const touched = [...HERDR_CONTROL_VARS, "TERM_PROGRAM", ...hooks, "HERDR_WORKSPACE_ID"] as const;
  const previous = touched.map((key) => [key, process.env[key]] as const);
  for (const [key, value] of Object.entries({ ...fixture, HERDR_WORKSPACE_ID: "wSEAL" })) {
    process.env[key] = value;
  }
  try {
    const subprocess = new SubprocessDriver();
    const childSlot = await subprocess.slot("/tmp", "seal-all-hosts");
    const presenceChecks = HERDR_CONTROL_VARS.map(
      (key) => `printf '${key}=%s\\n' "$(printenv ${key} >/dev/null 2>&1 && echo PRESENT || echo MISSING)"`,
    ).join("; ");
    await subprocess.run(
      childSlot,
      `${presenceChecks}; printf 'TERM_PROGRAM=%s\\n' "$TERM_PROGRAM"; ` +
        hooks.map((key) => `printf '${key}=%s\\n' "$${key}"`).join("; ") +
        "; printf 'DONE\\n'",
    );
    expect(await subprocess.waitOutput(childSlot, "DONE", 5000)).toBe(true);
    const childOutput = await subprocess.read(childSlot, 30);
    for (const key of HERDR_CONTROL_VARS) expect(childOutput).toContain(`${key}=MISSING`);
    expect(childOutput).toContain("TERM_PROGRAM=Orca");
    expect(childOutput).toContain("ORCA_AGENT_HOOK_STATUS=installed");
    expect(childOutput).toContain("ORCA_AGENT_HOOK_CUSTOM=keep-custom");
    await subprocess.close(childSlot);

    const { bin, log, cwd } = makeStub();
    const herdr = new HerdrDriver(bin);
    await herdr.slot(cwd, "T1-worker-fake-a0-r");
    const seed = readFileSync(log, "utf8").split("\n").find((line) => line.includes("export HERDR_WORKSPACE_ID"));
    expect(seed).toBeDefined();
    for (const key of HERDR_CONTROL_VARS) expect(seed).toContain(`unset ${key}`);
    expect(seed).not.toContain("unset TERM_PROGRAM");
    for (const key of hooks) expect(seed).not.toContain(`unset ${key}`);
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

describe("vitest process seal (ambient inheritance dies at the boundary)", () => {
  test("suite process has no HERDR_ENV and no HERDR_SOCKET_PATH from the invoking shell", () => {
    // vitest.config.ts deletes these before workers fork. Individual tests may re-set them in a
    // try/finally (pickDriver oracle) — this assertion is about ambient inheritance at suite start
    // of THIS file, which never re-sets them.
    expect(process.env.HERDR_ENV).toBeUndefined();
    expect(process.env.HERDR_SOCKET_PATH).toBeUndefined();
  });
});

describe("SubprocessDriver child env seal (worker/judge/review/consult print path)", () => {
  const prev: Record<string, string | undefined> = {};
  beforeEach(() => {
    for (const k of HERDR_CONTROL_VARS) {
      prev[k] = process.env[k];
      process.env[k] = k === "HERDR_ENV" ? "1" : "/tmp/tickmarkr-env-seal-test.sock";
    }
  });
  afterEach(() => {
    for (const k of HERDR_CONTROL_VARS) {
      if (prev[k] === undefined) delete process.env[k];
      else process.env[k] = prev[k];
    }
  });

  test("run() child sees neither HERDR_ENV nor HERDR_SOCKET_PATH", async () => {
    const d = new SubprocessDriver();
    const slot = await d.slot("/tmp", "seal-worker");
    // printenv exits 1 when unset — report presence as YES/NO so the assertion is exit-code free.
    await d.run(
      slot,
      `printf 'ENV=%s\\n' "$(printenv HERDR_ENV >/dev/null 2>&1 && echo YES || echo NO)"; ` +
        `printf 'SOCK=%s\\n' "$(printenv HERDR_SOCKET_PATH >/dev/null 2>&1 && echo YES || echo NO)"; ` +
        `printf 'DONE\\n'`,
    );
    expect(await d.waitOutput(slot, "DONE", 5000)).toBe(true);
    const out = await d.read(slot, 20);
    expect(out).toMatch(/ENV=NO/);
    expect(out).toMatch(/SOCK=NO/);
    await d.close(slot);
  });

  test("daemon process.env is untouched after a sealed child run", async () => {
    const d = new SubprocessDriver();
    const slot = await d.slot("/tmp", "seal-parent");
    await d.run(slot, "true");
    expect(await d.waitAgentStatus(slot, "done", 5000)).toBe(true);
    expect(process.env.HERDR_ENV).toBe("1");
    expect(process.env.HERDR_SOCKET_PATH).toBe("/tmp/tickmarkr-env-seal-test.sock");
    await d.close(slot);
  });
});

describe("HerdrDriver pane seed seal (worker/judge/review/consult pane path)", () => {
  let _wsPrev: string | undefined;
  beforeEach(() => {
    _wsPrev = process.env.HERDR_WORKSPACE_ID;
    process.env.HERDR_WORKSPACE_ID = "wSEAL";
  });
  afterEach(() => {
    if (_wsPrev !== undefined) process.env.HERDR_WORKSPACE_ID = _wsPrev;
    else delete process.env.HERDR_WORKSPACE_ID;
  });

  test("tabSlot seed unsets HERDR_ENV and HERDR_SOCKET_PATH (worker/judge/review/consult)", async () => {
    const { bin, log, cwd } = makeStub();
    const d = new HerdrDriver(bin);
    // judge/review/consult/worker all share tabSlot (or group→tabSlot) for first placement
    await d.slot(cwd, "judge · T1");
    const calls = readFileSync(log, "utf8");
    const seed = calls.split("\n").find((l) => l.includes("export HERDR_WORKSPACE_ID"));
    expect(seed).toBeDefined();
    expect(seed).toContain("unset HERDR_ENV");
    expect(seed).toContain("unset HERDR_SOCKET_PATH");
  });

  test("joinGroup seed also seals (second worker in a group tab)", async () => {
    const { bin, log, cwd } = makeStub();
    const d = new HerdrDriver(bin, 3);
    await d.slot(cwd, "T1-worker-fake-a0-r", { group: "workers" });
    await d.slot(cwd, "T2-worker-fake-a0-r", { group: "workers" });
    const seeds = readFileSync(log, "utf8").split("\n").filter((l) => l.includes("export HERDR_WORKSPACE_ID"));
    expect(seeds.length).toBe(2);
    for (const s of seeds) {
      expect(s).toContain("unset HERDR_ENV");
      expect(s).toContain("unset HERDR_SOCKET_PATH");
    }
  });

  test("tabSlot seed carries the default fork cap into a fresh worker pane", async () => {
    const before = process.env[FORK_CAP_ENV];
    delete process.env[FORK_CAP_ENV];
    try {
      const { bin, log, cwd } = makeStub();
      const d = new HerdrDriver(bin);
      await d.slot(cwd, "T1-worker-fake-a0-r");
      const seed = readFileSync(log, "utf8").split("\n").find((l) => l.includes("export HERDR_WORKSPACE_ID"));
      expect(seed).toMatch(new RegExp(`export ${FORK_CAP_ENV}='?${DEFAULT_FORK_CAP}'?;`));
    } finally {
      if (before === undefined) delete process.env[FORK_CAP_ENV];
      else process.env[FORK_CAP_ENV] = before;
    }
  });

  test("tabSlot seed carries an operator-set fork cap unchanged", async () => {
    const before = process.env[FORK_CAP_ENV];
    process.env[FORK_CAP_ENV] = "3";
    try {
      const { bin, log, cwd } = makeStub();
      const d = new HerdrDriver(bin);
      await d.slot(cwd, "T1-worker-fake-a0-r");
      const seed = readFileSync(log, "utf8").split("\n").find((l) => l.includes("export HERDR_WORKSPACE_ID"));
      expect(seed).toMatch(new RegExp(`export ${FORK_CAP_ENV}='?3'?;`));
      expect(seed).not.toMatch(new RegExp(`export ${FORK_CAP_ENV}='?${DEFAULT_FORK_CAP}'?;`));
    } finally {
      if (before === undefined) delete process.env[FORK_CAP_ENV];
      else process.env[FORK_CAP_ENV] = before;
    }
  });

  test("daemon-side herdr CLI calls are not sealed through child spawn env (driver keeps process.env)", async () => {
    // HerdrDriver.herdr() uses sh() with no env override — the daemon process retains HERDR_ENV so
    // its own pane/tab reconciliation can talk to the live session. Prove the control vars still
    // exist on process.env after a slot() cycle (seed only mutates the pane shell, not us).
    process.env.HERDR_ENV = "1";
    process.env.HERDR_SOCKET_PATH = "/tmp/daemon-keeps.sock";
    try {
      const { bin, cwd } = makeStub();
      const d = new HerdrDriver(bin);
      await d.slot(cwd, "review · T3");
      expect(process.env.HERDR_ENV).toBe("1");
      expect(process.env.HERDR_SOCKET_PATH).toBe("/tmp/daemon-keeps.sock");
    } finally {
      delete process.env.HERDR_ENV;
      delete process.env.HERDR_SOCKET_PATH;
    }
  });
});
