import { chmodSync, existsSync, mkdirSync, readFileSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { stringify } from "yaml";
import { shq } from "../../src/adapters/types.js";
import * as gateCache from "../../src/gates/cache.js";
import { environmentFingerprint } from "../../src/gates/cache.js";
import { commandsHash, runDaemon, verifyIntegrationTipCached } from "../../src/run/daemon.js";
import { gitHead, resolvedCapacity, type RunCapacity, VERIFICATION_PROTOCOL } from "../../src/run/git.js";
import { Journal, type JournalEvent } from "../../src/run/journal.js";
import { COMMIT, makeRepo, makeTestTempDir, setupRepo, T } from "../helpers/tmprepo.js";

beforeEach(() => {
  vi.stubEnv("npm_config_ignore_scripts", "false");
  vi.stubEnv("TZ", "UTC");
});
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

const lines = (file: string): string[] => existsSync(file) ? readFileSync(file, "utf8").trim().split("\n").filter(Boolean) : [];
const stamp = (repo: string, capacity = resolvedCapacity()) => environmentFingerprint({ worktree: repo, scope: "tip", capacity });
const cycle = (events: JournalEvent[]) => events.slice(events.map(e => e.event).lastIndexOf("tip-verify-start"));
const cached = (events: JournalEvent[]) => events.filter(e => e.event === "tip-verify-cached");

function fixture() {
  const calls = join(makeTestTempDir("tip-env-calls-"), "calls.log");
  const repo = makeRepo({ ".gitignore": "node_modules\n.tickmarkr\n" });
  const commands = { build: `printf 'build\\n' >> ${shq(calls)}`, lint: `printf 'lint\\n' >> ${shq(calls)}` };
  const events: JournalEvent[] = [];
  // Queue row 24 (D-2134): no persistent verdict store answers these cycle-cache probes.
  const journal = {
    dir: makeTestTempDir("tip-env-journal-"),
    read: () => events,
    append: (event: string, taskId: string | undefined, data: Record<string, unknown>) => {
      events.push({ ts: new Date().toISOString(), event, taskId, data } as JournalEvent);
    },
  } as unknown as Journal;
  const verify = () => verifyIntegrationTipCached(repo, commands, journal);
  return { calls, repo, commands, events, journal, verify };
}

function expectStamped(events: JournalEvent[], expected: ReturnType<typeof stamp>) {
  const rows = events.filter(e => ["tip-verify-start", "tip-verify", "tip-verify-failed", "tip-verify-cached"].includes(e.event));
  expect(rows.length).toBeGreaterThan(0);
  for (const row of rows) expect(row.data.tipEnvironment).toEqual(expected);
}

test("test: the integration tip verification run again on an unmoved tip with nothing changed carries the first green without running a command, then runs its commands again once only the session's time zone, only its node options or only its PATH changes, so a carry keyed on tip, commands and capacity alone fails", async () => {
  for (const key of ["TZ", "NODE_OPTIONS", "PATH"] as const) {
    const prior = process.env[key];
    const f = fixture();
    expect(await f.verify()).toBe(false);
    expect(lines(f.calls)).toEqual(["build", "lint"]);
    expect(await f.verify()).toBe(false);
    expect(lines(f.calls)).toEqual(["build", "lint"]);
    expect(cached(f.events)).toHaveLength(1);
    const first = stamp(f.repo);
    expectStamped(f.events, first);

    const changed = key === "TZ" ? "Pacific/Honolulu" : key === "NODE_OPTIONS"
      ? [prior, "--no-warnings"].filter(Boolean).join(" ") : `${makeTestTempDir("tip-env-path-")}:${prior}`;
    vi.stubEnv(key, changed);
    const next = stamp(f.repo);
    expect(next.fingerprint).not.toBe(first.fingerprint);
    expect(await f.verify()).toBe(false);
    expect(lines(f.calls)).toEqual(["build", "lint", "build", "lint"]);
    expect(cached(f.events)).toHaveLength(1);
    expectStamped(cycle(f.events), next);
    expect(await f.verify()).toBe(false);
    expect(lines(f.calls)).toHaveLength(4);
    expect(cached(f.events)).toHaveLength(2);
    if (prior === undefined) delete process.env[key]; else process.env[key] = prior;
  }
});

test("test: the integration tip verification runs its commands again after the session's npm lifecycle policy flips, and after a dependency link is added or retargeted in the repository's installed packages, while a changed file inside an unchanged linked package still carries as the declared residual, so a carry blind to lifecycle or links fails", async () => {
  const f = fixture();
  const modules = join(f.repo, "node_modules");
  for (const name of ["a", "b"]) {
    mkdirSync(join(modules, ".store", name), { recursive: true });
    writeFileSync(join(modules, ".store", name, "index.js"), "module.exports = 1;\n");
  }
  expect(await f.verify()).toBe(false);
  expect(await f.verify()).toBe(false);
  expect(lines(f.calls)).toHaveLength(2);
  expect(cached(f.events)).toHaveLength(1);
  const initial = stamp(f.repo);

  vi.stubEnv("npm_config_ignore_scripts", "true");
  expect(await f.verify()).toBe(false);
  expect(lines(f.calls)).toHaveLength(4);
  expect(stamp(f.repo).parts.verification.lifecycle).toBe("ignore-scripts");
  expect(stamp(f.repo).fingerprint).not.toBe(initial.fingerprint);

  symlinkSync(".store/a", join(modules, "linked"), "dir");
  expect(await f.verify()).toBe(false);
  expect(lines(f.calls)).toHaveLength(6);
  unlinkSync(join(modules, "linked"));
  symlinkSync(".store/b", join(modules, "linked"), "dir");
  expect(await f.verify()).toBe(false);
  expect(lines(f.calls)).toHaveLength(8);
  expect(cached(f.events)).toHaveLength(1);

  // Queue row 24 (D-2134 Q7): equal lockfile and links deliberately leave package content drift unmeasured.
  const beforeContent = stamp(f.repo);
  writeFileSync(join(modules, ".store", "b", "index.js"), "module.exports = 2;\n");
  expect(stamp(f.repo)).toEqual(beforeContent);
  expect(await f.verify()).toBe(false);
  expect(lines(f.calls)).toHaveLength(8);
  expect(cached(f.events)).toHaveLength(2);
  expectStamped(cycle(f.events), beforeContent);

  // Queue row 24 (D-2134): even a matching historical stamp cannot carry an outside dependency link.
  unlinkSync(join(modules, "linked"));
  symlinkSync(makeTestTempDir("tip-env-outside-"), join(modules, "linked"), "dir");
  for (const row of cycle(f.events)) row.data.tipEnvironment = stamp(f.repo);
  for (let attempt = 0; attempt < 2; attempt++) {
    expect(await f.verify()).toBe(true);
    expect(lines(f.calls)).toHaveLength(8);
    expect(cached(f.events)).toHaveLength(2);
    const refused = cycle(f.events).filter(e => e.event === "tip-verify-failed");
    expect(refused).toHaveLength(2);
    for (const row of refused) expect(row.data.details).toContain("dependency links resolve outside");
    for (const row of cycle(f.events)) expect(row.data.tipEnvironment).toBeUndefined();
  }
});

test("dependency inventory refusals journal infra tip failures before npm policy probes on fresh and previously green cycles", async () => {
  const bin = makeTestTempDir("tip-env-refusal-npm-");
  const probes = join(bin, "probes.log");
  writeFileSync(join(bin, "npm"), `#!/bin/sh\nprintf 'probe\\n' >> ${shq(probes)}\nprintf 'false\\n'\n`);
  chmodSync(join(bin, "npm"), 0o755);
  vi.stubEnv("PATH", `${bin}:${process.env.PATH}`);

  for (const detached of [false, true]) {
    vi.stubEnv("npm_config_ignore_scripts", "false");
    const f = fixture();
    const tip = await gitHead(f.repo);
    const verify = detached ? async () => (await verifyIntegrationTipCached(f.repo, f.commands, f.journal,
      { identity: { repo: f.repo, branch: "main", expected: tip } })).failed : f.verify;
    expect(await verify()).toBe(false);
    expect(await verify()).toBe(false);
    expect(cached(f.events)).toHaveLength(1);

    const modules = join(f.repo, "node_modules");
    mkdirSync(modules);
    symlinkSync(".store/removed", join(modules, "linked"), "dir");
    vi.stubEnv("npm_config_ignore_scripts", "");
    vi.stubEnv("NPM_CONFIG_IGNORE_SCRIPTS", "");
    for (let attempt = 0; attempt < 2; attempt++) {
      expect(await verify()).toBe(true);
      expect(lines(f.calls)).toEqual(["build", "lint"]);
      expect(cached(f.events)).toHaveLength(1);
      const rows = cycle(f.events);
      expect(rows[0]!.event).toBe("tip-verify-start");
      expect(rows[0]!.data.cached).toBe(false);
      const refused = rows.filter(e => e.event === "tip-verify-failed");
      expect(refused.map(e => e.data.gate)).toEqual(["build", "lint"]);
      for (const row of refused) {
        expect(row.data).toMatchObject({ cause: "infra", evidenceAbsence: "not-started" });
        expect(row.data.details).toContain("cannot inventory dependency links");
      }
      for (const row of rows) expect(row.data.tipEnvironment).toBeUndefined();
      expect(lines(probes)).toEqual([]);
    }
  }
});

test("a daemon close with nothing to verify leaves dangling dependency links unmeasured on the first close and resume", async () => {
  const { repo, fake } = setupRepo([T("T1", { humanGate: true })], {});
  const exclude = join(repo, ".git", "info", "exclude");
  writeFileSync(exclude, readFileSync(exclude, "utf8") + "\nnode_modules\n");
  const modules = join(repo, "node_modules");
  mkdirSync(modules);
  symlinkSync(".store/removed", join(modules, "linked"), "dir");
  const measured = vi.spyOn(gateCache, "environmentFingerprint");
  const runId = "run-tip-environment-idle";
  for (const resume of [false, true]) {
    const summary = await runDaemon(repo, { adapters: [fake], runId, resume, approvalWindowMs: 0 });
    expect(summary.tipProof).toEqual({ kind: "incomplete" });
    const events = Journal.open(repo, runId).read();
    expect(events.at(-1)!.event).toBe("run-end");
    expect(events.at(-1)!.data.fatal).toBeUndefined();
    expect(events.filter(e => e.event.startsWith("tip-verify"))).toEqual([]);
    expect(measured).not.toHaveBeenCalled();
  }
});

test("test: a recorded green cycle whose rows carry a valid stamp of another Node version or of another verification protocol, carry no stamp, carry a malformed stamp, whose start and verdict rows disagree, or whose lifecycle could not be measured though the stamps are equal, is verified again rather than carried, so an absent stamp read as compatible or an unknown lifecycle compared as equal fails", async () => {
  type Stamp = ReturnType<typeof stamp>;
  const cases: Array<[string, (current: Stamp, repo: string) => [unknown, unknown, unknown]]> = [
    ["other Node", (_current, repo) => {
      const other = environmentFingerprint({ worktree: repo, scope: "tip", capacity: resolvedCapacity(), nodeRuntime: "v0.0.1" });
      return [other, other, other];
    }],
    ["other protocol", (current, repo) => {
      const other = environmentFingerprint({ worktree: repo, scope: "tip", capacity: resolvedCapacity(),
        verification: { ...current.parts.verification, protocol: `${VERIFICATION_PROTOCOL}-other` } });
      return [other, other, other];
    }],
    ["missing", () => [undefined, undefined, undefined]],
    ["missing start", current => [undefined, current, current]],
    ["missing verdict", current => [current, current, undefined]],
    ...[null, "bad stamp", [], {}, { fingerprint: 7 }].map((bad): [string, (current: Stamp) => [unknown, unknown, unknown]] =>
      [JSON.stringify(bad), () => [bad, bad, bad]]),
    ["matching fingerprint without parts", current => [current, { fingerprint: current.fingerprint }, current]],
    ["matching fingerprint with malformed parts", current => [current, current, { ...current, parts: { ...current.parts, capacity: {} } }]],
    ["matching fingerprint without lifecycle", current => [current, { ...current, parts: { ...current.parts, verification: {} } }, current]],
    ["start disagrees", (current, repo) => [environmentFingerprint({ worktree: repo, scope: "tip", nodeRuntime: "v0.0.1" }), current, current]],
    ["verdict disagrees", (current, repo) => [current, current, environmentFingerprint({ worktree: repo, scope: "tip", nodeRuntime: "v0.0.1" })]],
  ];
  for (const [label, recorded] of cases) {
    const f = fixture();
    const current = stamp(f.repo);
    const stamps = recorded(current, f.repo);
    const tip = await gitHead(f.repo);
    const cmdHash = commandsHash(f.commands);
    f.journal.append("tip-verify-start", undefined, { tip, cmdHash, gates: Object.keys(f.commands), capacity: resolvedCapacity(), tipEnvironment: stamps[0] });
    for (const [index, [gate, cmd]] of Object.entries(f.commands).entries()) {
      f.journal.append("tip-verify", undefined, { gate, cmd, tip, cmdHash, pass: true, exitCode: 0, capacity: resolvedCapacity(), tipEnvironment: stamps[index + 1] });
    }
    expect({ label, failed: await f.verify(), calls: lines(f.calls) }).toEqual({ label, failed: false, calls: ["build", "lint"] });
    expect(cached(f.events), label).toHaveLength(0);
    expectStamped(cycle(f.events), current);
    expect(await f.verify()).toBe(false);
    expect(lines(f.calls), label).toHaveLength(2);
    expect(cached(f.events), label).toHaveLength(1);
  }

  // Queue row 24 (D-2134): measure a genuinely unknown npm policy; equal stamps remain incomparable.
  const f = fixture();
  const bin = makeTestTempDir("tip-env-npm-");
  writeFileSync(join(bin, "npm"), "#!/bin/sh\nprintf 'unmeasured\\n'\n");
  chmodSync(join(bin, "npm"), 0o755);
  vi.stubEnv("PATH", `${bin}:${process.env.PATH}`);
  vi.stubEnv("npm_config_ignore_scripts", "");
  vi.stubEnv("NPM_CONFIG_IGNORE_SCRIPTS", "");
  const unknown = stamp(f.repo);
  expect(unknown.parts.verification.lifecycle).toBe("unknown");
  for (let attempt = 0; attempt < 2; attempt++) {
    expect(await f.verify()).toBe(false);
    expectStamped(f.events, unknown);
  }
  expect(lines(f.calls)).toEqual(["build", "lint", "build", "lint"]);
  expect(cached(f.events)).toHaveLength(0);
});

test("test: a daemon run resumed on its unmoved verified tip carries the tip green when nothing changed and runs the tip commands again when the resumed session's time zone differs, so a daemon close that ignores the stamp fails", async () => {
  const calls = join(makeTestTempDir("tip-env-daemon-"), "calls.log");
  const command = `case "$PWD" in */tip-verify-*) printf '%s\\n' "$TZ" >> ${shq(calls)} ;; esac`;
  const { repo, fake } = setupRepo([T("T1"), T("T2", { humanGate: true })], {
    tasks: { T1: [{ shell: `echo landed > work.txt && ${COMMIT} work`, result: { ok: true, summary: "done" } }] },
  }, stringify({ concurrency: 1, gates: { lint: command } }));
  const runId = "run-tip-environment";
  const run = (resume = false) => runDaemon(repo, { adapters: [fake], runId, resume, approvalWindowMs: 0 });
  const events = () => Journal.open(repo, runId).read();

  const first = await run();
  expect(first.done).toEqual(["T1"]);
  expect(first.tipProof?.kind).toBe("fresh");
  expect(lines(calls)).toEqual(["UTC"]);
  const original = cycle(events()).find(e => e.event === "tip-verify-start")!;
  const tip = original.data.tip;
  const current = stamp(repo, original.data.capacity as RunCapacity);
  expectStamped(cycle(events()), current);

  const same = await run(true);
  expect(same.tipProof?.kind).toBe("reused");
  expect(lines(calls)).toEqual(["UTC"]);
  expect(cached(events())).toHaveLength(1);
  expectStamped(cycle(events()), current);

  vi.stubEnv("TZ", "Pacific/Honolulu");
  const changed = await run(true);
  expect(changed.tipProof?.kind).toBe("fresh");
  expect(changed.tipVerify).toBe("passed");
  expect(lines(calls)).toEqual(["UTC", "Pacific/Honolulu"]);
  expect(cached(events())).toHaveLength(1);
  const latest = cycle(events());
  expect(latest[0]!.data.tip).toBe(tip);
  expect(latest[0]!.data.cached).toBe(false);
  expectStamped(latest, stamp(repo, latest[0]!.data.capacity as RunCapacity));

  // Queue row 24 (D-2134): a stale npm link refuses the resumed battery without turning its close fatal.
  const exclude = join(repo, ".git", "info", "exclude");
  writeFileSync(exclude, readFileSync(exclude, "utf8") + "\nnode_modules\n");
  const modules = join(repo, "node_modules");
  mkdirSync(modules);
  symlinkSync(".store/removed", join(modules, "linked"), "dir");
  const refused = await run(true);
  expect(refused.tipVerify).toBe("failed");
  expect(refused.tipProof?.kind).toBe("failed");
  expect(lines(calls)).toEqual(["UTC", "Pacific/Honolulu"]);
  expect(events().at(-1)!.data.fatal).toBeUndefined();
  const failure = cycle(events()).find(e => e.event === "tip-verify-failed")!;
  expect(failure.data).toMatchObject({ gate: "lint", cause: "infra", evidenceAbsence: "not-started" });
  expect(failure.data.details).toContain("cannot inventory dependency links");
  expect(failure.data.tipEnvironment).toBeUndefined();
}, 120_000);
