// Row 417; D-2187 add.77: run and resume probe each configured provider endpoint before the first dispatch. A down one
// prints its line on stderr and journals one endpoint-down row; the run still starts. The production run and resume
// commands are driven to their end with the fake adapter; the codex config sits under a temporary CODEX_HOME and every
// listener is opened and closed here on 127.0.0.1.
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { join } from "node:path";
import { format } from "node:util";
import { afterEach, expect, test, vi } from "vitest";
import { writeDoctor } from "../../src/adapters/registry.js";
import { resume } from "../../src/cli/commands/resume.js";
import { endpointPreflight, run } from "../../src/cli/commands/run.js";
import { graphDefinitionHash, loadGraph, saveGraph, setStatus, tickmarkrDir } from "../../src/graph/graph.js";
import { gitHead } from "../../src/run/git.js";
import { Journal, type JournalEvent } from "../../src/run/journal.js";
import { authedModels, COMMIT, makeTestTempDir, setupRepo, T } from "../helpers/tmprepo.js";

const servers: Server[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const s of servers.splice(0)) await new Promise<void>((r) => s.close(() => r()));
});

const FAKE_DOCTOR = { fake: { installed: true, authed: true, models: [], modelAuth: authedModels(["fake-1", "fake-2"]) } };
const listen = async (): Promise<number> => {
  const server = createServer((s) => s.destroy());
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return (server.address() as { port: number }).port;
};
const closed = async (): Promise<number> => {
  const port = await listen();
  await new Promise<void>((r) => servers.pop()!.close(() => r()));
  return port;
};
const codexHome = (baseUrl: string) => {
  const home = makeTestTempDir("endpoint-preflight-codex-");
  writeFileSync(join(home, "config.toml"), `model_provider = "cpa-gui"\n[model_providers.cpa-gui]\nbase_url = ${JSON.stringify(baseUrl)}\n`);
  vi.stubEnv("CODEX_HOME", home);
};
function stderr() {
  const chunks: string[] = [];
  for (const name of ["log", "info"] as const) vi.spyOn(console, name).mockImplementation(() => undefined);
  for (const name of ["warn", "error"] as const) vi.spyOn(console, name).mockImplementation((...a: unknown[]) => { chunks.push(`${format(...a)}\n`); });
  vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => { chunks.push(String(chunk)); return true; });
  return () => chunks.join("").split("\n").filter((l) => l.startsWith("endpoint "));
}

async function runToEnd() {
  vi.stubEnv("HOME", makeTestTempDir("endpoint-preflight-home-"));
  const { repo, scriptPath } = setupRepo([T("T1")], { tasks: { T1: [{ shell: `echo ok > ok.txt && ${COMMIT} ok`, result: { ok: true, summary: "ok" } }] } });
  writeDoctor(repo, FAKE_DOCTOR);
  vi.stubEnv("TICKMARKR_FAKE_SCRIPT", scriptPath);
  const lines = stderr();
  const result = await run(["--driver", "subprocess"], repo);
  const err = lines();
  vi.restoreAllMocks();
  const runs = join(tickmarkrDir(repo), "runs");
  const [runId] = readdirSync(runs);
  return { result, err, events: Journal.open(repo, runId!).read() };
}

async function resumeToEnd() {
  const { repo } = setupRepo([T("T1")], { tasks: {} });
  saveGraph(repo, setStatus(loadGraph(repo), "T1", "failed"));
  writeDoctor(repo, FAKE_DOCTOR);
  const j = Journal.create(repo, "run-red");
  j.append("run-start", undefined, { baseRef: await gitHead(repo), commands: {}, graphDefinitionHash: graphDefinitionHash(loadGraph(repo)) });
  j.append("task-dispatch", "T1");
  j.append("task-failed", "T1", { error: "boom" });
  writeFileSync(join(j.dir, "baseline.json"), JSON.stringify({ commands: {} }));
  const before = Journal.open(repo, "run-red").read().length;
  const lines = stderr();
  const result = await resume(["run-red", "--driver", "subprocess"], repo);
  const err = lines();
  vi.restoreAllMocks();
  return { result, err, events: Journal.open(repo, "run-red").read().slice(before) };
}

const downRows = (events: JournalEvent[]) => events.filter((e) => e.event === "endpoint-down");

test("run and resume print the down line on stderr and journal one endpoint down row before dispatch and still start", async () => {
  const dead = await closed();
  // userinfo, path, query and fragment never reach stderr or the row: the shown url is scheme, host and port only
  const url = `http://127.0.0.1:${dead}`;
  const line = `endpoint codex: ${url} down (ECONNREFUSED) — every codex seat will fail as transport until it answers`;
  codexHome(`http://user:s3cret@127.0.0.1:${dead}/v1?key=tok3n#frag`);

  const fresh = await runToEnd();
  expect(fresh.result.code, fresh.result.out).toBe(0);
  expect(fresh.err).toEqual([line]);
  expect(JSON.stringify(fresh.events)).not.toMatch(/s3cret|tok3n|frag/);
  expect(downRows(fresh.events).map((e) => e.data)).toEqual([{ adapter: "codex", url, reason: "ECONNREFUSED" }]);
  const names = fresh.events.map((e) => e.event);
  expect(names.indexOf("endpoint-down")).toBeGreaterThan(names.indexOf("run-start"));
  expect(names.indexOf("endpoint-down")).toBeLessThan(names.indexOf("task-dispatch"));
  expect(names).toContain("task-dispatch");

  const resumed = await resumeToEnd();
  expect(resumed.result.out).toMatch(/resumed run-red/);
  expect(resumed.err).toEqual([line]);
  expect(downRows(resumed.events).map((e) => e.data)).toEqual([{ adapter: "codex", url, reason: "ECONNREFUSED" }]);
  const resumedNames = resumed.events.map((e) => e.event);
  expect(resumedNames.indexOf("endpoint-down")).toBeGreaterThan(resumedNames.indexOf("run-resume"));
  expect(resumedNames.indexOf("run-resume")).toBeGreaterThanOrEqual(0);

  // control: a listener this test opened — run and resume print and journal nothing, and the run starts as before
  codexHome(`http://127.0.0.1:${await listen()}/v1`);
  const quiet = await runToEnd();
  expect(quiet.result.code, quiet.result.out).toBe(0);
  expect(quiet.err).toEqual([]);
  expect(downRows(quiet.events)).toEqual([]);
  const quietResume = await resumeToEnd();
  expect(quietResume.err).toEqual([]);
  expect(downRows(quietResume.events)).toEqual([]);
}, 240_000);

// Review finding (row 417): a credential-bearing base_url that does not parse reaches neither stderr nor the journal.
test("a credential bearing unparseable endpoint reaches neither stderr nor the persisted endpoint down row", async () => {
  const { repo } = setupRepo([T("T1")], { tasks: {} });
  const codexConfigPath = join(makeTestTempDir("endpoint-preflight-secret-"), "config.toml");
  writeFileSync(codexConfigPath, 'model_provider = "p"\n[model_providers.p]\nbase_url = "user:s3cret@127.0.0.1:8317/v1?key=tok3n#frag"\n');
  const lines = stderr();
  const journal = Journal.create(repo, "run-secret");
  const driver: { journalWith?: (a: (event: string, taskId?: string, data?: Record<string, unknown>) => void) => void } = {};
  const narrate = await endpointPreflight(driver as never, () => undefined, { env: {}, settingsPath: join(repo, "no-settings.json"), codexConfigPath });
  driver.journalWith!(journal.append.bind(journal));
  narrate({ event: "run-start" } as JournalEvent);
  const err = lines();
  vi.restoreAllMocks();
  expect(err).toEqual(["endpoint codex: <unparseable base_url> down (unparseable) — every codex seat will fail as transport until it answers"]);
  const persisted = readFileSync(join(Journal.open(repo, "run-secret").dir, "journal.jsonl"), "utf8");
  expect(Journal.open(repo, "run-secret").read().filter((e) => e.event === "endpoint-down").map((e) => e.data))
    .toEqual([{ adapter: "codex", url: "<unparseable base_url>", reason: "unparseable" }]);
  for (const leak of ["s3cret", "tok3n", "user:"]) {
    expect(persisted, leak).not.toContain(leak);
    expect(err.join("\n"), leak).not.toContain(leak);
  }
});

// Row 435; D-2187 add.130: the Claude base URL whose host carries the gateway credential is withheld on run's and
// resume's preflight — the line on stderr and the endpoint-down row name no part of it, and nothing is resolved. Under
// vitest the process environment never names a Claude endpoint, so the production preflight is driven with the
// gateway's inputs, once for each journal opener (run-start for run, run-resume for resume).
test("run and resume journal a withheld endpoint row whose url names no part of the base url", async () => {
  const credential = "sk-tkr-SECRET-0435";
  const baseUrl = `http://user:pw@${credential}.invalid:9/v1?q=1#f`;
  const dns = (await import("node:dns")).default;
  for (const opener of ["run-start", "run-resume"] as const) {
    const { repo } = setupRepo([T("T1")], { tasks: {} });
    const lookups = vi.spyOn(dns, "lookup");
    const lines = stderr();
    const journal = Journal.create(repo, `run-${opener}`);
    const driver: { journalWith?: (a: (event: string, taskId?: string, data?: Record<string, unknown>) => void) => void } = {};
    const seam = { env: { ANTHROPIC_BASE_URL: baseUrl, ANTHROPIC_AUTH_TOKEN: credential }, settingsPath: join(repo, "no-settings.json"), codexConfigPath: join(repo, "no-codex.toml") };
    const narrate = await endpointPreflight(driver as never, () => undefined, seam);
    driver.journalWith!(journal.append.bind(journal));
    narrate({ event: opener } as JournalEvent);
    const err = lines();
    expect(lookups, opener).not.toHaveBeenCalled(); // no name resolution, so no connect
    vi.restoreAllMocks();
    expect(err, opener).toEqual(["endpoint claude-code: withheld — the base URL carries the gateway credential: not probed"]);
    expect(Journal.open(repo, `run-${opener}`).read().filter((e) => e.event === "endpoint-down").map((e) => e.data), opener)
      .toEqual([{ adapter: "claude-code", url: "<withheld base url>", reason: "withheld" }]);
    const persisted = readFileSync(join(Journal.open(repo, `run-${opener}`).dir, "journal.jsonl"), "utf8").toLowerCase();
    for (const part of [credential.toLowerCase(), ".invalid", "user:pw", "/v1", "q=1", "http://"]) {
      expect(persisted, part).not.toContain(part);
      expect(err.join("\n").toLowerCase(), part).not.toContain(part);
    }
  }
});
