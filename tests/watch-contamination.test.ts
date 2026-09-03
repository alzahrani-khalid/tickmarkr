import { spawn, type ChildProcess } from "node:child_process";
import { appendFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, expect, test, vi } from "vitest";

const SCRIPT = resolve("skills/tickmarkr-overseer/scripts/watch-contamination.sh");
const live: ChildProcess[] = [];

afterEach(() => {
  for (const proc of live.splice(0)) if (proc.exitCode === null) proc.kill("SIGKILL");
});

const row = (taskId: string, gate: string, details: string) => JSON.stringify({
  event: "gate-result",
  taskId,
  data: { gate, pass: false, details },
}) + "\n";

test("test: watch-contamination fires on an infra fingerprint on a runner-emitted line of a failed test build or lint gate and stays quiet when the same fingerprint appears only inside a review finding or the secondary fingerprint list whereas the shipped matcher that greps any details text fails", async () => {
  const repo = mkdtempSync(join(tmpdir(), "tickmarkr-watch-contamination-"));
  const journal = join(repo, "journal.jsonl");
  writeFileSync(journal, "");
  const proc = spawn("bash", [SCRIPT, journal, "999999", "1", "12"], {
    cwd: repo,
    env: { ...process.env, TKR_ARMING_SEAT: "overseer" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  live.push(proc);
  let output = "";
  proc.stdout?.on("data", (chunk) => { output += String(chunk); });
  proc.stderr?.on("data", (chunk) => { output += String(chunk); });

  appendFileSync(journal, row("T-review", "review", "finding quotes Error: [vitest-worker]: Timeout calling onTaskUpdate"));
  appendFileSync(journal, row("T-secondary", "test", [
    "AssertionError: expected true to be false",
    "new failure fingerprints vs baseline (secondary):",
    "Error: [vitest-worker]: Timeout calling onTaskUpdate",
  ].join("\n")));
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 1_400));
  expect(proc.exitCode).toBeNull();
  expect(output).not.toContain("CONTAMINATED_VERDICT");

  appendFileSync(journal, row("T-runner", "lint", "lint runner exited\nError: spawn EAGAIN while starting worker"));
  await vi.waitFor(() => expect(proc.exitCode).toBe(0), { timeout: 4_000, interval: 50 });
  expect(output).toContain("CONTAMINATED_VERDICT task=T-runner gate=lint");
  expect(output.match(/CONTAMINATED_VERDICT/g)).toHaveLength(1);
});
