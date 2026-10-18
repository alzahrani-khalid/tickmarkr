import { execFileSync, spawn } from "node:child_process";
import { closeSync, cpSync, existsSync, openSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, test, vi } from "vitest";
import { FakeAdapter } from "../../src/adapters/fake.js";
import { shq } from "../../src/adapters/types.js";
import { compile } from "../../src/cli/commands/compile.js";
import { graphPath, saveGraph, tickmarkrDir } from "../../src/graph/graph.js";
import { validateGraph } from "../../src/graph/schema.js";
import { runDaemon } from "../../src/run/daemon.js";
import { acquireRunLock, isPidLive, releaseRunLock, repositoryClaimPath } from "../../src/run/lock.js";
import { COMMIT, makeRepo, makeTestTempDir, T } from "../helpers/tmprepo.js";

// Queue row 194 (D-2102): one live run per repository across its main checkout M and its session
// worktrees W (nested at M/.claude/worktrees/<name>, as Claude Desktop lays them out). Zero-token: fake
// adapter, scratch repositories, and real holder processes that take the lock through acquireRunLock.

// The reclaim seam: `beforeUnlink` runs once at the instant a taker unlinks the claim at `path` — after it
// validated that claim dead, before the unlink executes — so another checkout's process can race it there.
const reclaim = vi.hoisted(() => ({ path: undefined as string | undefined, beforeUnlink: undefined as (() => void) | undefined }));
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const unlinkSync = ((path: Parameters<typeof actual.unlinkSync>[0]) => {
    const run = reclaim.beforeUnlink;
    if (run && String(path) === reclaim.path) { reclaim.beforeUnlink = undefined; run(); }
    return actual.unlinkSync(path);
  }) as typeof actual.unlinkSync;
  return { ...actual, unlinkSync, default: { ...actual, unlinkSync } };
});

const TSX = join(import.meta.dirname, "..", "..", "node_modules", ".bin", "tsx");
const LOCK_SRC = pathToFileURL(join(import.meta.dirname, "..", "..", "src", "run", "lock.ts")).href;
const lockOf = (checkout: string) => join(tickmarkrDir(checkout), "graph.lock");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
// every reclaim marker beside the repository claim
const markers = (claim: string) => readdirSync(dirname(claim)).filter((name) => name.startsWith(`${basename(claim)}.reclaim.`));

function sessionPair(name = "s1"): { M: string; W: string } {
  const M = realpathSync(makeRepo({ "base.txt": "base\n" }));
  const W = join(M, ".claude", "worktrees", name);
  execFileSync("git", ["-C", M, "worktree", "add", "-q", "-b", `session-${name}`, W], { stdio: "ignore" });
  return { M, W };
}

interface Holder { pid: number; release(): Promise<void>; kill(): Promise<void> }

// A separate process holding a run lock exactly as runDaemon takes it. SIGTERM releases; SIGKILL leaves
// its graph.lock and claim behind with a provably dead pid.
async function holdRun(checkout: string, runId: string): Promise<Holder> {
  const script = `import { acquireRunLock, releaseRunLock } from ${JSON.stringify(LOCK_SRC)};
const checkout = ${JSON.stringify(checkout)};
acquireRunLock(checkout, ${JSON.stringify(runId)});
process.on("SIGTERM", () => { releaseRunLock(checkout); process.exit(0); });
process.stdout.write("held " + process.pid + "\\n");
setInterval(() => {}, 1000);`;
  const child = spawn(TSX, ["--eval", script], { stdio: ["ignore", "pipe", "pipe"] });
  let err = "";
  child.stderr.on("data", (d) => { err += d; });
  const exited = new Promise<void>((ok) => child.once("exit", () => ok()));
  const pid = await new Promise<number>((ok, fail) => {
    let out = "";
    child.stdout.on("data", (d) => { out += d; const m = /held (\d+)/.exec(out); if (m) ok(Number(m[1])); });
    void exited.then(() => fail(new Error(`holder exited before holding: ${err}`)));
  });
  const gone = async () => {
    await exited;
    for (let i = 0; i < 250 && isPidLive(pid); i++) await sleep(20);
    expect(isPidLive(pid)).toBe(false);
  };
  return {
    pid,
    release: async () => { process.kill(pid, "SIGTERM"); await gone(); },
    kill: async () => { process.kill(pid, "SIGKILL"); await gone(); },
  };
}

// A contender process started while this process is blocked inside a synchronous acquire: it reports
// "held <pid>" (and keeps holding) or "refused: <message>" (and exits) to a file this process polls. Its
// pid is the one it reports (tsx's launcher is a separate process); 0 once it refused and exits itself.
const PAUSE = new Int32Array(new SharedArrayBuffer(4));
function contendSync(checkout: string, runId: string): { pid: number; outcome: string } {
  const out = join(makeTestTempDir("tickmarkr-contender-"), "out.txt");
  const fd = openSync(out, "w");
  const script = `import { acquireRunLock } from ${JSON.stringify(LOCK_SRC)};
try { acquireRunLock(${JSON.stringify(checkout)}, ${JSON.stringify(runId)}); process.stdout.write("held " + process.pid + "\\n"); setInterval(() => {}, 1000); }
catch (e) { process.stdout.write("refused: " + e.message + "\\n"); }`;
  const child = spawn(TSX, ["--eval", script], { stdio: ["ignore", fd, fd] });
  closeSync(fd);
  for (const end = Date.now() + 30_000; Date.now() < end; Atomics.wait(PAUSE, 0, 0, 20)) {
    const outcome = readFileSync(out, "utf8");
    if (/^(held|refused)/m.test(outcome)) return { pid: Number(/^held (\d+)/m.exec(outcome)?.[1] ?? 0), outcome };
  }
  child.kill("SIGKILL");
  throw new Error(`contender never reported: ${readFileSync(out, "utf8")}`);
}

// A reclaimer from `checkout` SIGKILLed at the instant it unlinks the dead claim at `claim` — after it took
// the reclaim marker and validated that claim dead — leaving the marker behind with a provably dead pid.
async function reclaimThenDie(checkout: string, claim: string): Promise<void> {
  const script = `import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
const unlink = fs.unlinkSync;
fs.unlinkSync = (path) => { if (String(path) === ${JSON.stringify(claim)}) process.kill(process.pid, "SIGKILL"); return unlink(path); };
syncBuiltinESMExports();
process.stdout.write("reclaimer " + process.pid + "\\n");
import(${JSON.stringify(LOCK_SRC)}).then(({ acquireRunLock }) => { acquireRunLock(${JSON.stringify(checkout)}, "run-reclaimer"); process.stdout.write("survived\\n"); });`;
  const child = spawn(TSX, ["--eval", script], { stdio: ["ignore", "pipe", "pipe"] });
  let out = "", err = "";
  child.stdout.on("data", (d) => { out += d; });
  child.stderr.on("data", (d) => { err += d; });
  await new Promise<void>((ok) => child.once("exit", () => ok()));
  const pid = Number(/reclaimer (\d+)/.exec(out)?.[1]);
  expect(pid, err).toBeGreaterThan(0);
  expect(out, err).not.toMatch(/survived/);
  for (let i = 0; i < 250 && isPidLive(pid); i++) await sleep(20);
  expect(isPidLive(pid)).toBe(false);
}

// A fresh one-task graph whose worker copies the repository claim it runs under to `seen`.
function daemonFixture(checkout: string, seen: string): FakeAdapter {
  saveGraph(checkout, validateGraph({ version: 1, spec: { source: "prd", paths: ["p"], hash: "h" }, tasks: [T("T1")] }));
  writeFileSync(join(tickmarkrDir(checkout), "config.yaml"), "judge: { adapter: fake, model: fake-1 }\nconsult: { adapter: fake, model: fake-1 }\n");
  const scriptPath = join(makeTestTempDir("tickmarkr-script-"), "s.json");
  writeFileSync(scriptPath, JSON.stringify({
    judge: { pass: true, criteria: [{ criterion: "c1", met: true, reason: "ok" }] },
    review: { approve: true, issues: [] },
    tasks: { T1: [{ shell: `cp ${shq(repositoryClaimPath(checkout)!)} ${shq(seen)} && echo x > f.txt && ${COMMIT} x`, result: { ok: true, summary: "x" } }] },
  }));
  return new FakeAdapter(scriptPath);
}

describe("repository run claim across a main checkout and its session worktrees (queue row 194)", () => {
  test("test: a compile in a session worktree nested at its main checkout's .claude/worktrees directory proceeds and writes only the worktree's graph while a live run in the main checkout holds the repository claim, and the mirror holds for a compile in the main checkout while a session worktree's run lives, while a compile in the checkout whose own run lives still refuses on its graph lock, so a compile refused by another checkout's run or one let past its own checkout's live run fails", async () => {
    const { M, W } = sessionPair();
    for (const checkout of [M, W]) cpSync("fixtures/sample.prd.md", join(checkout, "feature.prd.md"));
    const claim = repositoryClaimPath(M)!;
    expect(repositoryClaimPath(W)).toBe(claim);

    acquireRunLock(M, "run-main");
    try {
      expect(JSON.parse(readFileSync(claim, "utf8"))).toMatchObject({ runId: "run-main", checkout: M });
      await compile(["feature.prd.md"], W);
      expect(existsSync(graphPath(W))).toBe(true);
      expect(existsSync(graphPath(M))).toBe(false);
      await expect(compile(["feature.prd.md"], M)).rejects.toThrow(/graph\.lock held by pid .*run-main/);
      expect(existsSync(graphPath(M))).toBe(false);
    } finally {
      releaseRunLock(M);
    }

    rmSync(graphPath(W));
    acquireRunLock(W, "run-session");
    try {
      expect(JSON.parse(readFileSync(claim, "utf8"))).toMatchObject({ runId: "run-session", checkout: W });
      await compile(["feature.prd.md"], M);
      expect(existsSync(graphPath(M))).toBe(true);
      expect(existsSync(graphPath(W))).toBe(false);
      await expect(compile(["feature.prd.md"], W)).rejects.toThrow(/graph\.lock held by pid .*run-session/);
      expect(existsSync(graphPath(W))).toBe(false);
    } finally {
      releaseRunLock(W);
    }
    expect(existsSync(claim)).toBe(false);
  }, 60_000);

  test("test: the run daemon started in either checkout refuses a live holder from the other checkout before it writes a journal, naming that checkout's path, its run id and its pid, its own graph lock released afterwards, while with no holder, with a holder killed without releasing and with a live run in an independent repository the daemon takes the claim and leaves none behind when the run ends, the independent repository's claim untouched and released on its own, so a lock still kept per checkout, a machine-wide claim, a claim that never reclaims a dead holder or one a finished run strands fails", async () => {
    const { M, W } = sessionPair();
    const claim = repositoryClaimPath(M)!;
    const refusedScript = join(makeTestTempDir("tickmarkr-script-"), "s.json");
    writeFileSync(refusedScript, "{}");
    const fake = new FakeAdapter(refusedScript);

    // C1, both directions: refused before any journal, naming the other checkout, its run id and pid
    for (const [taker, other] of [[W, M], [M, W]] as const) {
      const holder = await holdRun(other, "run-other");
      try {
        const refused = runDaemon(taker, { adapters: [fake], runId: "run-taker" });
        await expect(refused).rejects.toThrow(claim);
        await expect(refused).rejects.toThrow(`pid ${holder.pid} (run run-other) in checkout ${other}`);
        expect(existsSync(join(taker, ".tickmarkr", "runs", "run-taker"))).toBe(false);
        expect(existsSync(lockOf(taker))).toBe(false);
        expect(JSON.parse(readFileSync(claim, "utf8"))).toMatchObject({ pid: holder.pid, runId: "run-other", checkout: other });
      } finally {
        await holder.release();
      }
      expect(existsSync(claim)).toBe(false);
    }

    const runs: Array<{ name: string; arrange: () => Promise<(() => Promise<void>) | void> }> = [
      { name: "no holder", arrange: async () => {} },
      { name: "holder killed without releasing", arrange: async () => {
        const holder = await holdRun(M, "run-killed");
        await holder.kill();
        expect(JSON.parse(readFileSync(claim, "utf8"))).toMatchObject({ pid: holder.pid, runId: "run-killed" });
      } },
      { name: "live run in an independent repository", arrange: async () => {
        const R = realpathSync(makeRepo({ "r.txt": "r\n" }));
        const rClaim = repositoryClaimPath(R)!;
        expect(rClaim).not.toBe(claim);
        const holder = await holdRun(R, "run-independent");
        return async () => {
          expect(JSON.parse(readFileSync(rClaim, "utf8"))).toMatchObject({ pid: holder.pid, runId: "run-independent", checkout: R });
          await holder.release();
          expect(existsSync(rClaim)).toBe(false);
        };
      } },
    ];
    for (const [index, { name, arrange }] of runs.entries()) {
      const after = await arrange();
      const seen = join(makeTestTempDir("tickmarkr-seen-"), "claim.json");
      const runId = `run-session-${index}`;
      const summary = await runDaemon(W, { adapters: [daemonFixture(W, seen)], runId });
      expect(summary.done, name).toEqual(["T1"]);
      expect(JSON.parse(readFileSync(seen, "utf8")), name).toMatchObject({ pid: process.pid, runId, checkout: W });
      expect(existsSync(claim), name).toBe(false);
      expect(existsSync(lockOf(W)), name).toBe(false);
      if (after) await after();
    }
  }, 180_000);

  test("test: an unparseable repository claim refuses naming the claim's path from either checkout, and a directory enclosed by no git checkout takes only its own graph lock exactly as before, so a claim reclaimed while unreadable or a lock that refuses outside a repository fails", () => {
    const { M, W } = sessionPair();
    const claim = repositoryClaimPath(M)!;
    writeFileSync(claim, "not json {{{");
    for (const checkout of [M, W]) {
      expect(() => acquireRunLock(checkout, "run-x")).toThrow(claim);
      expect(existsSync(lockOf(checkout))).toBe(false);
      expect(readFileSync(claim, "utf8")).toBe("not json {{{");
    }

    const loose = makeTestTempDir("tickmarkr-loose-");
    expect(repositoryClaimPath(loose)).toBeUndefined();
    expect(acquireRunLock(loose, "run-loose")).toEqual({});
    try {
      expect(JSON.parse(readFileSync(lockOf(loose), "utf8"))).toMatchObject({ pid: process.pid, runId: "run-loose" });
      expect(() => acquireRunLock(loose, "run-second")).toThrow(/graph\.lock held by pid/);
    } finally {
      releaseRunLock(loose);
    }
    expect(existsSync(lockOf(loose))).toBe(false);
    expect(() => { acquireRunLock(loose, "run-again"); releaseRunLock(loose); }).not.toThrow();
  });

  test("two checkouts reclaiming one dead claim at once leave exactly one holder: a taker paused between validating the dead claim and unlinking it never deletes the other checkout's live replacement (queue row 194)", async () => {
    for (const [taker, other] of [["W", "M"], ["M", "W"]] as const) {
      const pair = sessionPair(`race-${taker}`);
      const claim = repositoryClaimPath(pair.M)!;
      const dead = await holdRun(pair[other], "run-dead");
      await dead.kill();
      let contender: { pid: number; outcome: string } | undefined;
      reclaim.path = claim;
      reclaim.beforeUnlink = () => { contender = contendSync(pair[other], "run-contender"); };
      try {
        expect(acquireRunLock(pair[taker], "run-taker")).toEqual({});
        expect(contender?.outcome, taker).toMatch(/^refused: .*being reclaimed/);
        expect(JSON.parse(readFileSync(claim, "utf8")), taker).toMatchObject({ pid: process.pid, runId: "run-taker", checkout: pair[taker] });
        expect(markers(claim), taker).toEqual([]);
      } finally {
        reclaim.beforeUnlink = undefined;
        if (contender?.pid && isPidLive(contender.pid)) process.kill(contender.pid, "SIGKILL");
        releaseRunLock(pair[taker]);
      }
      expect(existsSync(claim), taker).toBe(false);
    }
  }, 60_000);

  test("a reclaimer killed holding the reclaim marker, after validating the dead claim and before unlinking it, strands nothing: the next run from either checkout reclaims the dead claim with no hand removal and leaves no marker behind (queue row 194)", async () => {
    for (const [taker, other] of [["W", "M"], ["M", "W"]] as const) {
      const pair = sessionPair(`killed-${taker}`);
      const claim = repositoryClaimPath(pair.M)!;
      const dead = await holdRun(pair[other], "run-dead");
      await dead.kill();
      await reclaimThenDie(pair[other], claim); // strands the first marker
      await reclaimThenDie(pair[taker], claim); // passes over it, strands the next
      expect(JSON.parse(readFileSync(claim, "utf8")), taker).toMatchObject({ pid: dead.pid, runId: "run-dead" });
      expect(markers(claim), taker).toHaveLength(2);
      acquireRunLock(pair[taker], "run-recover"); // reclaims the reclaimer's own dead graph.lock too
      try {
        expect(JSON.parse(readFileSync(claim, "utf8")), taker).toMatchObject({ pid: process.pid, runId: "run-recover", checkout: pair[taker] });
        expect(markers(claim), taker).toEqual([]);
      } finally {
        releaseRunLock(pair[taker]);
      }
      expect(existsSync(claim), taker).toBe(false);
      expect(() => { acquireRunLock(pair[other], "run-after"); releaseRunLock(pair[other]); }, taker).not.toThrow();
    }
  }, 90_000);
});
