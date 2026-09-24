import { appendFileSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { claudeCode } from "../../../src/adapters/claude-code.js";
import type { WorkerAdapter } from "../../../src/adapters/types.js";
import { SubprocessDriver } from "../../../src/drivers/subprocess.js";
import type { Slot } from "../../../src/drivers/types.js";
import { runDaemon } from "../../../src/run/daemon.js";
import { Journal } from "../../../src/run/journal.js";
import { COMMIT, makeTestTempDir, setupRepo, T } from "../../helpers/tmprepo.js";

afterEach(() => vi.unstubAllEnvs());

type Scenario = "growth" | "other" | "no-reader" | "unreadable" | "lost-reader" | "throws" | "launch-failed";
async function scenario(kind: Scenario) {
  const home = makeTestTempDir("resume-home-");
  vi.stubEnv("HOME", home);
  const { repo, fake } = setupRepo([T("T1")], { tasks: { T1: [
    { shell: "true", result: { ok: true, summary: "first attempt needs work" } },
    { shell: `echo done > done.txt && ${COMMIT} done`, result: { ok: true, summary: "done" } },
  ] } });
  const adapter: WorkerAdapter = fake;
  adapter.contextUsage = claudeCode.contextUsage;
  // Unreadable baselines must still reach the resume branch to exercise unknown identity.
  adapter.resumeUnknownContext = true;
  if (kind !== "no-reader") adapter.readSessionTranscript = kind === "throws"
    ? () => { throw new Error("reader unavailable"); } : claudeCode.readSessionTranscript;
  const runId = `run-resume-${kind}`;
  let requested = "";
  let transcript = "";
  const resume = fake.resumeCommand.bind(fake);
  fake.resumeCommand = (id, prompt, model) => {
    expect(id).toBe(requested);
    return resume(id, prompt, model);
  };
  const initial = `${JSON.stringify({ message: { usage: { input_tokens: 500 } } })}\n`;
  class Driver extends SubprocessDriver {
    override interactive = true;
    override async slot(cwd: string, name: string) {
      const slot = await super.slot(cwd, name);
      if (name.includes("-worker-") && !requested) {
        requested = name;
        // Independent path construction: punctuation in the worktree slug and a temporary home
        // force the production Claude reader to resolve the exact requested file.
        transcript = join(home, ".claude", "projects", realpathSync(cwd).replace(/[^A-Za-z0-9]/g, "-"), `${name}.jsonl`);
        mkdirSync(dirname(transcript), { recursive: true });
        writeFileSync(transcript, initial);
        if (kind === "unreadable") {
          rmSync(transcript);
          mkdirSync(transcript); // EISDIR even under a privileged test runner
        }
      }
      return slot;
    }
    override async run(slot: Slot, command: string) {
      if (slot.name.includes("-worker-") && slot.name !== requested) {
        const rows = Journal.open(repo, runId).read();
        expect(rows.find((row) => row.event === "worker-resume-requested")?.data.sessionId).toBe(requested);
        expect(rows.filter((row) => row.event === "worker-launch")).toHaveLength(1);
        expect(rows.some((row) => row.event === "worker-resume-identity")).toBe(false);
        if (kind === "launch-failed") throw new Error("scripted launch failed");
      }
      await super.run(slot, command);
    }
    override async waitOutput(slot: Slot, pattern: string, ms: number, opts?: { regex?: boolean }) {
      if (slot.name.includes("-worker-") && slot.name !== requested) {
        expect(Journal.open(repo, runId).read().filter((row) => row.event === "worker-launch")).toHaveLength(2);
        if (kind === "growth") appendFileSync(transcript, '{"type":"assistant","message":"continued"}\n');
        if (kind === "other") appendFileSync(join(dirname(transcript), "fresh-fallback.jsonl"), '{"type":"assistant"}\n');
        if (kind === "lost-reader") rmSync(transcript, { force: true });
      }
      return super.waitOutput(slot, pattern, ms, opts);
    }
  }
  await runDaemon(repo, { adapters: [adapter], runId, driver: new Driver() });
  return { rows: Journal.open(repo, runId).read(), requested, transcript, initial };
}

test("test: through the claude code adapter's own transcript reader under a temporary home a worker resume journals the requested session id the runtime launch and confirmed identity when that session's transcript grew after launch, so a resume recorded as continued on the request alone fails", async () => {
  const { rows, requested, initial } = await scenario("growth");
  const request = rows.findIndex((row) => row.event === "worker-resume-requested");
  const launch = rows.findIndex((row) => row.event === "worker-launch" && row.data.retryMode === "resume");
  const identity = rows.findIndex((row) => row.event === "worker-resume-identity");
  expect(request).toBeGreaterThan(-1);
  expect(launch).toBeGreaterThan(request);
  expect(identity).toBeGreaterThan(launch);
  for (const index of [request, launch, identity]) expect(rows[index]!.data.sessionId).toBe(requested);
  expect(rows[request]!.data.baselineBytes).toBe(Buffer.byteLength(initial));
  expect(rows[identity]!.data.identity).toBe("confirmed");
  expect(rows[identity]!.data.observedBytes).toBeGreaterThan(Buffer.byteLength(initial));
  expect(rows[identity]!.data.assumption).toBe("external runtime appends to the requested session's own transcript");
}, 30_000);

test("test: a resumed launch whose requested transcript did not grow while another session's did journals identity unconfirmed, so a silent fresh session fallback fails", async () => {
  const { rows, transcript, initial } = await scenario("other");
  expect(readFileSync(transcript, "utf8")).toBe(initial);
  expect(readFileSync(join(dirname(transcript), "fresh-fallback.jsonl"), "utf8").length).toBeGreaterThan(0);
  expect(rows.filter((row) => row.event === "worker-resume-identity").map((row) => row.data.identity)).toEqual(["unconfirmed"]);
}, 30_000);

test("test: a resume through an adapter with no transcript reader or over an unreadable transcript journals identity unknown and never confirmed, so a missing reader normalized to confirmed fails", async () => {
  for (const kind of ["no-reader", "unreadable", "lost-reader", "throws"] as const) {
    const { rows } = await scenario(kind);
    expect(rows.filter((row) => row.event === "worker-launch" && row.data.retryMode === "resume")).toHaveLength(1);
    expect(rows.filter((row) => row.event === "worker-resume-identity").map((row) => row.data.identity)).toEqual(["unknown"]);
  }
}, 60_000);

test("test: a resume whose launch failed journals the request with no launch fact, so a launch recorded before the runtime started fails", async () => {
  const { rows, requested } = await scenario("launch-failed");
  expect(rows.filter((row) => row.event === "worker-resume-requested").map((row) => row.data.sessionId)).toEqual([requested]);
  expect(rows.filter((row) => row.event === "worker-launch" && row.data.retryMode === "resume")).toEqual([]);
  expect(rows.filter((row) => row.event === "worker-resume-identity")).toEqual([]);
}, 30_000);
