import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { afterEach, expect, test, vi } from "vitest";

const ROOT = resolve("skills/tickmarkr-overseer/scripts");
const live: ChildProcess[] = [];

afterEach(() => {
  for (const proc of live.splice(0)) if (proc.exitCode === null) proc.kill("SIGKILL");
});

test("test: each watch script writes its own pid to a file under the state dir's overseer pids directory named by the arming seat and the script so a seat retiring its watchers reads those files and a partner seat's watcher on the same journal path keeps running whereas a pattern kill over the journal path fails", async () => {
  const repo = mkdtempSync(join(tmpdir(), "tickmarkr-watch-pids-"));
  const stateDir = join(repo, ".tickmarkr");
  const pidsDir = join(stateDir, "overseer", "pids");
  const journal = join(repo, "journal.jsonl");
  const artifact = join(repo, "REPORT.md");
  writeFileSync(journal, "");
  writeFileSync(artifact, "still working\n");

  const herdr = join(repo, "herdr-stub");
  const tickmarkr = join(repo, "tickmarkr-stub");
  writeFileSync(herdr, `#!/usr/bin/env bash
case "$1 $2" in
  "agent get") echo '{"result":{"agent":{"agent_status":"idle"}}}' ;;
  "agent list") echo '{"result":{"agents":[]}}' ;;
  "agent read") printf '%s\n' '────────────────' 'gpt-5.6-sol 1%' ;;
  *) echo '{}' ;;
esac
`);
  writeFileSync(tickmarkr, "#!/usr/bin/env bash\nexit 0\n");
  chmodSync(herdr, 0o755);
  chmodSync(tickmarkr, 0o755);
  const launch = (script: string, args: string[], seat: string) => {
    const shimDir = join(repo, `bin-${seat}-${script}`);
    // mkdir via the spawned shell keeps this fixture focused on the scripts' own filesystem contract.
    const command = `mkdir -p '${shimDir}' && ln -sf '${herdr}' '${shimDir}/herdr' && ln -sf '${tickmarkr}' '${shimDir}/tickmarkr' && exec bash '${join(ROOT, script)}' "$@"`;
    const proc = spawn("bash", ["-c", command, "watch", ...args], {
      cwd: repo,
      env: {
        ...process.env,
        HOME: repo,
        PATH: `${shimDir}:${process.env.PATH}`,
        TKR_STATE_DIR: stateDir,
        TKR_ARMING_SEAT: seat,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    live.push(proc);
    return proc;
  };

  const artifactWatch = launch("watch-artifacts.sh", ["REPORT-END", "20", "1", artifact], "orch");
  const pendingWatch = launch("watch-pending-input.sh", ["w1:p1", "1", "20", "2"], "orch");
  const contextWatch = launch("watch-context.sh", ["overseer", "w1:p1", "80", "90", "", "1", "20"], "orch");
  const contaminationA = launch("watch-contamination.sh", [journal, "999999", "1", "20"], "orch");
  const contaminationB = launch("watch-contamination.sh", [journal, "999999", "1", "20"], "partner");

  await vi.waitFor(() => expect(readdirSync(pidsDir)).toHaveLength(5), { timeout: 5_000, interval: 50 });
  const files = readdirSync(pidsDir).sort();
  for (const script of ["watch-artifacts", "watch-pending-input", "watch-context", "watch-contamination"]) {
    expect(files.some((file) => file.startsWith(`orch-${script}-`) && file.endsWith(".pid")), script).toBe(true);
  }
  expect(files.some((file) => file.startsWith("partner-watch-contamination-") && file.endsWith(".pid"))).toBe(true);

  const ownFile = files.find((file) => file.startsWith("orch-watch-contamination-"))!;
  const partnerFile = files.find((file) => file.startsWith("partner-watch-contamination-"))!;
  const ownPid = Number(readFileSync(join(pidsDir, ownFile), "utf8").trim());
  const partnerPid = Number(readFileSync(join(pidsDir, partnerFile), "utf8").trim());
  expect(ownPid).toBe(contaminationA.pid);
  expect(partnerPid).toBe(contaminationB.pid);
  process.kill(ownPid, "SIGKILL");
  await vi.waitFor(() => expect(contaminationA.signalCode).toBe("SIGKILL"), { timeout: 3_000, interval: 50 });
  expect(() => process.kill(partnerPid, 0)).not.toThrow();

  for (const [proc, script] of [
    [artifactWatch, "watch-artifacts.sh"],
    [pendingWatch, "watch-pending-input.sh"],
    [contextWatch, "watch-context.sh"],
  ] as const) {
    const pidFile = files.find((file) => file.includes(`-${basename(script, ".sh")}-`) && Number(readFileSync(join(pidsDir, file), "utf8").trim()) === proc.pid);
    expect(pidFile, script).toBeDefined();
  }
});

test("the pending-input cap routes its final prompt-line read through the ghost discriminator", () => {
  const repo = mkdtempSync(join(tmpdir(), "tickmarkr-pending-cap-"));
  const herdr = join(repo, "herdr");
  writeFileSync(herdr, `#!/usr/bin/env bash
case "$1 $2" in
  "agent get") echo '{"result":{"agent":{"agent_status":"idle"}}}' ;;
  "agent read")
    case "$*" in
      *--format*ansi*) printf '  ❯ \\033[2mghost suggestion\\033[0m\\n' ;;
      *) printf '  ❯ ghost suggestion\\n' ;;
    esac ;;
esac
`);
  chmodSync(herdr, 0o755);
  const output = execFileSync("bash", [join(ROOT, "watch-pending-input.sh"), "w1:p1", "1", "0", "2"], {
    cwd: repo,
    env: { ...process.env, PATH: `${repo}:${process.env.PATH}`, TKR_ARMING_SEAT: "overseer" },
    encoding: "utf8",
  });
  expect(output).toContain("final read: autosuggest ghost ignored");
  expect(output).not.toContain("final read (UNSUSTAINED");
});
