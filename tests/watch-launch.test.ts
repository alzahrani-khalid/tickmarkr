import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test } from "vitest";

// A GO with no run behind it is a silent failure until someone notices (2026-09-11: a sandbox-rooted
// orchestrator stopped at a path denial; nobody looked for three hours). The launch watcher is the
// noticing. It is shipped in skills/ and installed byte-identically under .claude/skills/.
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = join(ROOT, "skills/tickmarkr-overseer/scripts/watch-launch.sh");
const TWIN = join(ROOT, ".claude/skills/tickmarkr-overseer/scripts/watch-launch.sh");

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

/** A fake `herdr` on PATH that records every argv line, so delivery is asserted from bytes, not trust. */
const fakeHerdr = (): { bin: string; log: string } => {
  const bin = mkdtempSync(join(tmpdir(), "watch-launch-bin-")); dirs.push(bin);
  const log = join(bin, "herdr.log");
  writeFileSync(join(bin, "herdr"), `#!/bin/sh\nprintf '%s\\n' "$*" >> "${log}"\n`);
  chmodSync(join(bin, "herdr"), 0o755);
  return { bin, log };
};

const run = (args: string[], bin: string) =>
  spawnSync("bash", [SCRIPT, ...args], { encoding: "utf8", env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } });

describe("watch-launch.sh (a GO has a deadline)", () => {
  // OBS-878 class: .claude/skills is export-excluded, so the twin check must skip by existence on the
  // exported tree instead of reading a path that is absent there (tests/repo/tests-read-exported-paths).
  test.skipIf(!existsSync(TWIN))("the installed twin is byte-identical to the canonical script (skipped on the exported tree: .claude/skills is absent)", () => {
    expect(readFileSync(TWIN, "utf8")).toBe(readFileSync(SCRIPT, "utf8"));
  });

  // Ceilings here are budgets for the slowest runner (single-fork ubuntu under coverage): a 1 s poll
  // against a lock written after ~1 s, and a 2 s deadline, leave whole seconds of slack each.
  test("test: a lock that appears before the deadline ends the watch with LAUNCH_OK and the lock's contents, exit 0, and no delivery is made", () => {
    const { bin, log } = fakeHerdr();
    const wt = mkdtempSync(join(tmpdir(), "watch-launch-wt-")); dirs.push(wt);
    const lock = join(wt, "graph.lock");
    // spawnSync blocks the event loop, so the lock is written by a detached shell, not a timer.
    spawnSync("sh", ["-c", `(sleep 1; printf '%s\\n' '{"pid":4242,"runId":"run-x"}' > "${lock}") >/dev/null 2>&1 &`]);
    const r = run([lock, "10", "wZ:pTEST", "1"], bin);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/^LAUNCH_OK \d\d:\d\d:\d\dZ \{"pid":4242,"runId":"run-x"\}$/m);
    expect(existsSync(log)).toBe(false);
  }, 20_000);

  test("test: no lock by the deadline prints LAUNCH_OVERDUE, delivers the message to the overseer pane with `pane run` AND as a notification, and exits 3", () => {
    const { bin, log } = fakeHerdr();
    const wt = mkdtempSync(join(tmpdir(), "watch-launch-wt-")); dirs.push(wt);
    const r = run([join(wt, "graph.lock"), "2", "wZ:pTEST", "1"], bin);
    expect(r.status).toBe(3);
    expect(r.stdout).toContain("LAUNCH_OVERDUE");
    const delivered = readFileSync(log, "utf8");
    expect(delivered).toMatch(/^pane run wZ:pTEST LAUNCH OVERDUE .*no lock at .*graph\.lock after 2s/m);
    expect(delivered).toMatch(/^notification show LAUNCH OVERDUE /m);
  }, 20_000);

  test("missing arguments exit 64 with the usage line, so an unarmed watcher can never look armed", () => {
    const { bin } = fakeHerdr();
    const r = run(["only-one-arg"], bin);
    expect(r.status).toBe(64);
    expect(r.stderr).toContain("usage: watch-launch.sh");
  });
});
