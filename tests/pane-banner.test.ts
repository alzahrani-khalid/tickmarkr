import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  BANNER, PANE_IDENTITY_ENV, TICKMARKR_EXIT_TRAILER, bannerShell, paneDispatchScript, paneIdentityLine,
} from "../src/brand.js";
import { HerdrDriver } from "../src/drivers/herdr.js";
import { SubprocessDriver } from "../src/drivers/subprocess.js";
import { formatOwnedName, isForeignName, parseOwnedName, type ExecutorDriver } from "../src/drivers/types.js";
import { gateExitTrailer } from "../src/gates/llm.js";
import { runDaemon } from "../src/run/daemon.js";
import { COMMIT, setupRepo, T } from "./helpers/tmprepo.js";

// T5: every pane tickmarkr opens wears the brand — the dispatch banner renders the logo plus ONE dim
// identity line (role · task · attempt · run) seeded from the pane's T1 owned name. Parsed surfaces
// (exit trailer, ownership names) are byte-pinned against the pre-change format.

describe("pane banner (T5)", () => {
  test("the exit trailer format is byte-identical to before this change", () => {
    expect(TICKMARKR_EXIT_TRAILER).toBe("printf '\\nTICKMARKR_''EXIT:%s\\n' $?");
    expect(gateExitTrailer("abc12345")).toBe("printf '\\nTICKMARKR_''EXIT_abc12345:%s\\n' $?");
    // the OBS-50 bootstrap script still ends on the same trailer line
    expect(paneDispatchScript(["echo hi"])).toBe(
      `export BASH_SILENCE_DEPRECATION_WARNING=1\necho hi\n${TICKMARKR_EXIT_TRAILER}`,
    );
  });

  test("pane ownership names are byte-identical to before this change", () => {
    for (const role of ["worker", "judge", "review", "consult", "watch", "other"] as const) {
      const owned = { role, taskId: "T5", attempt: 1, runId: "run-20260718-024700" };
      expect(formatOwnedName(owned)).toBe(`tickmarkr:${role}:T5:1:run-20260718-024700`);
      expect(parseOwnedName(formatOwnedName(owned))).toEqual(owned);
    }
    expect(formatOwnedName({ role: "worker", taskId: "T5", attempt: 0, runId: "run-x" }))
      .toBe("tickmarkr:worker:T5:0:run-x");
    // foreign names still never parse — reconcile's ownership decision is untouched
    expect(isForeignName("judge · T5")).toBe(true);
    expect(parseOwnedName("narrator-watch-123")).toBeNull();
  });

  test("the pane banner script renders the logo followed by one dim identity line", () => {
    const identity = "worker · T5 · attempt 0 · run-20260718-024700";
    const out = execFileSync("bash", ["-c", bannerShell()], {
      encoding: "utf8",
      env: { ...process.env, [PANE_IDENTITY_ENV]: identity },
    });
    // byte-exact: the pinned logo block (incl. its trailing blank line), then exactly one dim line
    expect(out).toBe(`${BANNER}\n\x1b[2m${identity}\x1b[0m\n`);
    expect(out.split("\n").filter((l) => l.includes(identity))).toHaveLength(1);
    // an unseeded pane (subprocess driver) still renders one dim line — the bare product name
    const env = { ...process.env };
    delete env[PANE_IDENTITY_ENV];
    const fallback = execFileSync("bash", ["-c", bannerShell()], { encoding: "utf8", env });
    expect(fallback).toBe(`${BANNER}\n\x1b[2mtickmarkr\x1b[0m\n`);
    // the header stays a single shell one-liner (one printf; ESC carried as %b escapes, never raw)
    expect(bannerShell()).not.toContain("\n");
    expect(bannerShell()).not.toContain("\x1b");
  });

  test("paneIdentityLine formats role · task · attempt · run through the T1 contract", () => {
    expect(paneIdentityLine({ role: "consult", taskId: "T2", attempt: 0, runId: "run-1" }))
      .toBe("consult · T2 · attempt 0 · run-1");
    expect(paneIdentityLine({ role: "judge", taskId: "T4", attempt: 1, runId: "run-1" }))
      .toBe("judge · T4 · attempt 1 · run-1");
    // a legacy name without a run id omits the run segment rather than rendering an empty one
    expect(paneIdentityLine({ role: "judge", taskId: "T4", attempt: 0, runId: "" }))
      .toBe("judge · T4 · attempt 0");
  });
});

// minimal stub herdr binary (same shape as tests/drivers/env-seal.test.ts) to capture the pane seed
function makeStub(): { bin: string; log: string; cwd: string } {
  const dir = mkdtempSync(join(tmpdir(), "tickmarkr-pane-banner-"));
  const log = join(dir, "log.txt");
  const bin = join(dir, "herdr");
  const cwd = mkdtempSync(join(tmpdir(), "tickmarkr-pane-banner-cwd-"));
  writeFileSync(
    bin,
    `#!/usr/bin/env bash
echo "$@" >> '${log}'
case "$1 $2" in
  "agent start") echo '{"result":{"agent":{"pane_id":"w1:p9"}}}' ;;
  "tab create") echo '{"result":{"tab":{"tab_id":"w1:t1"},"root_pane":{"pane_id":"w1:p0"}}}' ;;
  *) echo '{}' ;;
esac
`,
  );
  chmodSync(bin, 0o755);
  return { bin, log, cwd };
}

describe("herdr pane identity seed (T5)", () => {
  async function withWs(fn: () => Promise<void>): Promise<void> {
    const prev = process.env.HERDR_WORKSPACE_ID;
    process.env.HERDR_WORKSPACE_ID = "wSEAL";
    try {
      await fn();
    } finally {
      if (prev !== undefined) process.env.HERDR_WORKSPACE_ID = prev;
      else delete process.env.HERDR_WORKSPACE_ID;
    }
  }

  test("slot() seeds the banner identity from the pane's owned name", async () => {
    await withWs(async () => {
      const { bin, log, cwd } = makeStub();
      const d = new HerdrDriver(bin);
      await d.slot(cwd, "legacy-fallback", { owned: { role: "worker", taskId: "T5", attempt: 0, runId: "run-x" } });
      const calls = readFileSync(log, "utf8");
      expect(calls).toContain(`export ${PANE_IDENTITY_ENV}='worker · T5 · attempt 0 · run-x'`);
      // the workspace seed + env seal ride the same line, unchanged
      const seed = calls.split("\n").find((l) => l.includes("export HERDR_WORKSPACE_ID"))!;
      expect(seed).toContain("unset HERDR_ENV");
      expect(seed).toContain("unset HERDR_SOCKET_PATH");
    });
  });

  test("a legacy pane name seeds a legacy-derived identity line", async () => {
    await withWs(async () => {
      const { bin, log, cwd } = makeStub();
      const d = new HerdrDriver(bin);
      await d.slot(cwd, "judge · T4");
      expect(readFileSync(log, "utf8")).toContain(`export ${PANE_IDENTITY_ENV}='judge · T4 · attempt 0'`);
    });
  });
});

describe("worker/judge header parity (T5)", () => {
  test("the worker dispatch and the judge dispatch script carry the identical brand header", async () => {
    const { repo, fake } = setupRepo(
      [T("T1")],
      { tasks: { T1: [{ shell: `echo b > b.txt && ${COMMIT} b`, result: { ok: true, summary: "branded" } }] } },
      "visibility:\n  llm: pane\n",
    );
    const inner = new SubprocessDriver();
    const commands: string[] = [];
    const driver: ExecutorDriver = {
      id: "spy",
      interactive: false,
      slot: inner.slot.bind(inner),
      run: async (s, c) => { commands.push(c); return inner.run(s, c); },
      waitOutput: inner.waitOutput.bind(inner),
      waitAgentStatus: inner.waitAgentStatus.bind(inner),
      read: inner.read.bind(inner),
      notify: async () => {},
      close: inner.close.bind(inner),
      worktree: inner.worktree.bind(inner),
      status: inner.status.bind(inner),
    } as ExecutorDriver;
    const s = await runDaemon(repo, { adapters: [fake], runId: "run-wb", driver });
    expect(s.done).toEqual(["T1"]);
    // the worker pane opens with the banner one-liner before the agent command and exit trailer
    const workerCmd = commands.find((c) => c.includes("TICKMARKR_''EXIT_"))!;
    expect(workerCmd.startsWith(`${bannerShell()}; `)).toBe(true);
    // judge/review panes dispatch a script holding the SAME one-liner — one header shape for the fleet
    const gateCmd = commands.find((c) => c.startsWith("bash '"))!;
    const script = readFileSync(gateCmd.slice(6, -1), "utf8");
    expect(script).toContain(bannerShell());
  }, 30_000);
});
