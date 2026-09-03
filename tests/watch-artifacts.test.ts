import { createHash } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { appendFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, expect, test, vi } from "vitest";

const SCRIPT = resolve("skills/tickmarkr-overseer/scripts/watch-artifacts.sh");
const live: ChildProcess[] = [];

afterEach(() => {
  for (const proc of live.splice(0)) if (proc.exitCode === null) proc.kill("SIGKILL");
});

test("test: watch-artifacts armed with --changed-from on an artifact that already carries its end marker does not fire until the file's content differs from the armed baseline and then fires once whereas the shipped watcher that fires instantly on the pre-existing marker fails", async () => {
  const repo = mkdtempSync(join(tmpdir(), "tickmarkr-watch-artifact-"));
  const artifact = join(repo, "REPORT.md");
  const initial = "old finding\nREPORT-END\n";
  writeFileSync(artifact, initial);
  const baseline = createHash("sha1").update(initial).digest("hex");

  const proc = spawn("bash", [SCRIPT, "--changed-from", baseline, "REPORT-END", "8", "0.1", artifact], {
    cwd: repo,
    env: { ...process.env, TKR_ARMING_SEAT: "overseer" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  live.push(proc);
  let output = "";
  proc.stdout?.on("data", (chunk) => { output += String(chunk); });
  proc.stderr?.on("data", (chunk) => { output += String(chunk); });

  await new Promise((resolveDelay) => setTimeout(resolveDelay, 450));
  expect(proc.exitCode).toBeNull();
  expect(output).not.toContain("WAKE:");

  appendFileSync(artifact, "revised evidence\nREPORT-END\n");
  await vi.waitFor(() => expect(proc.exitCode).toBe(0), { timeout: 5_000, interval: 50 });
  expect(output.match(/WAKE:/g)).toHaveLength(1);
  expect(output).toContain("artifact(s) complete");
});
