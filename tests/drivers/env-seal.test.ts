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

// v1.22 T3: workers/judges/reviews/consults must not inherit the operator's herdr session.
// Regression for OBS-17 (watch-tab / temp-fixture pane leak via HERDR_ENV leak into children).

describe("sealHerdrEnv (pure)", () => {
  test("strips HERDR_ENV and HERDR_SOCKET_PATH; leaves other keys", () => {
    const sealed = sealHerdrEnv({
      PATH: "/usr/bin",
      HERDR_ENV: "1",
      HERDR_SOCKET_PATH: "/tmp/herdr.sock",
      HERDR_WORKSPACE_ID: "wTEST",
      HOME: "/home/op",
    });
    expect(sealed.HERDR_ENV).toBeUndefined();
    expect(sealed.HERDR_SOCKET_PATH).toBeUndefined();
    expect(sealed.PATH).toBe("/usr/bin");
    expect(sealed.HERDR_WORKSPACE_ID).toBe("wTEST");
    expect(sealed.HOME).toBe("/home/op");
  });

  test("does not mutate the input env object", () => {
    const input: NodeJS.ProcessEnv = { HERDR_ENV: "1", HERDR_SOCKET_PATH: "/s", KEEP: "1" };
    sealHerdrEnv(input);
    expect(input.HERDR_ENV).toBe("1");
    expect(input.HERDR_SOCKET_PATH).toBe("/s");
  });

  test("HERDR_CONTROL_VARS is exactly the control-plane pair", () => {
    expect([...HERDR_CONTROL_VARS]).toEqual(["HERDR_ENV", "HERDR_SOCKET_PATH"]);
  });

  test("herdrSealShellPrefix unsets every control var", () => {
    const p = herdrSealShellPrefix();
    for (const k of HERDR_CONTROL_VARS) expect(p).toContain(`unset ${k}`);
  });
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
