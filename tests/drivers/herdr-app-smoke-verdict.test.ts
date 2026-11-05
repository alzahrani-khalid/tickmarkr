import { execFile, spawn } from "node:child_process";
import fs, { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, vi } from "vitest";
import { buildRecord, type CiRecord } from "../../scripts/ci/reporter.js";
import { fakeHost, liveHost, HERDR_APP_LIVE_TITLE, REQUIRED_OBSERVATIONS, runSmoke, smokeVerdict, type SmokeEvidence } from "../e2e/herdr-app-smoke.e2e.test.js";
import { makeTestTempDir } from "../helpers/tmprepo.js";

// Queue row 340; D-2180, closed CASE R. Importing the e2e module registers no tests here:
// the only live leaf stays in its own file, and every host below has explicit executable fake paths.
test("test: smoke availability satisfies the closed skip table while every post-start failure stays failed and missing observations cannot mint green", { timeout: 120_000 }, async () => {
  const h = fakeHost();
  let good: SmokeEvidence;
  try {
    good = await runSmoke(h);
    expect(smokeVerdict(good)).toEqual({ status: "passed", reasons: [] });
    expect(Object.keys(good.observations).sort()).toEqual([...REQUIRED_OBSERVATIONS].sort());
    for (const key of REQUIRED_OBSERVATIONS) {
      for (const value of [undefined, false, "true"]) {
        const observations = { ...good.observations, [key]: value };
        if (value === undefined) delete observations[key];
        expect(smokeVerdict({ ...good, observations } as SmokeEvidence), `${key}: ${value}`).toMatchObject({ status: "failed", reasons: expect.arrayContaining([`missing observation: ${key}`]) });
      }
    }
  } finally { await h.dispose(); }

  for (const [gate, installed, reason] of [[false, true, "TICKMARKR_E2E is not 1"], [false, false, "TICKMARKR_E2E is not 1"], [true, false, "hc is missing before private-core creation"]] as const) {
    const unavailable = fakeHost();
    try {
      expect(smokeVerdict(await runSmoke(unavailable, gate, installed))).toEqual({ status: "skipped", reasons: [reason] });
      expect(unavailable.fake.calls()).toEqual([]); // even status can start a core: no probe when skipping
    } finally { await unavailable.dispose(); }
  }
  const preexisting = fakeHost("preexisting");
  try {
    const refused = await runSmoke(preexisting);
    expect(smokeVerdict(refused).status).toBe("failed");
    expect(refused.preexisting).toBe(true);
    expect(refused.startAttempted).toBeUndefined();
    expect(preexisting.fake.calls()).toEqual([]); // never adopt, signal, kill, rm or even status
  } finally { await preexisting.dispose(); }

  for (const phase of ["start", "setup", "transport", "assertion", "cleanup"]) {
    const broken = fakeHost(phase);
    try {
      const result = await runSmoke(broken);
      expect(result.errors.join("\n"), phase).toContain(phase === "start" ? "start receipt lost" : phase === "transport" ? "read response family failed" : `injected ${phase} failure`);
      expect(result.startAttempted, phase).toBe(true);
      expect(smokeVerdict(result).status, phase).toBe("failed");
      expect(result.observations.terminalsAbsent, phase).toBe(true);
      expect(result.observations.childAbsent, phase).toBe(true);
      expect(result.observations.coreAbsent, phase).toBe(phase === "cleanup" ? undefined : true);
      // A later availability loss cannot turn a post-start failure into a skip.
      expect(smokeVerdict({ ...result, gate: false, installed: false }).status, phase).toBe("failed");
      expect(broken.fake.read().terminals, phase).toEqual({});
    } finally { await broken.dispose(); }
  }
});

/** Exercise liveHost's actual HcClient timeouts, socket ownership check and SIGTERM cleanup.
 * Only scratch allocation is redirected: this executable fake never launches hc or launchd.
 * The fake core is our direct child, so even a failed regression is reaped in finally. */
async function delayedPrivateStart(delayMs: number, receipt: "valid" | "malformed" | "nonzero") {
  const dir = makeTestTempDir("hs-");
  const hc = join(dir, "fake-hc.cjs");
  const request = join(dir, "requested");
  const ready = join(dir, "ready.json");
  const calls = join(dir, "calls.jsonl");
  const sigterm = join(dir, "sigterm");
  writeFileSync(hc, `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify(args)+'\\n');
if (args.join(' ') === 'ls --all --json') {
  console.log(JSON.stringify({terminals:[],hidden_finished:0}));
} else if (args.join(' ') === 'server status --json') {
  if (!fs.existsSync(${JSON.stringify(request)})) {
    fs.writeFileSync(${JSON.stringify(request + ".tmp")}, JSON.stringify({socket:process.env.HC_SOCKET,nonce:process.env.TKR_SMOKE_CORE}));
    fs.renameSync(${JSON.stringify(request + ".tmp")}, ${JSON.stringify(request)});
    if (${JSON.stringify(receipt)} !== 'valid') {
      process.stdout.write('{'); process.exit(${receipt === "nonzero" ? 1 : 0});
    }
  } else if (!fs.existsSync(process.env.HC_SOCKET)) {
    throw new Error('status must not run before the recovering socket exists');
  }
  const poll = setInterval(() => {
    if (fs.existsSync(${JSON.stringify(ready)})) {
      clearInterval(poll); process.stdout.write(fs.readFileSync(${JSON.stringify(ready)}));
    }
  }, 20);
} else { throw new Error('unexpected fake command: '+args.join(' ')); }
`, { mode: 0o700 });
  const allocation = vi.spyOn(fs, "mkdtempSync").mockReturnValueOnce(dir);
  syncBuiltinESMExports();
  let h: ReturnType<typeof liveHost>;
  try { h = liveHost(hc, "/"); } finally { allocation.mockRestore(); syncBuiltinESMExports(); }
  const core = spawn(process.execPath, ["-e", `
    const fs = require('node:fs'), net = require('node:net');
    const poll = setInterval(() => {
      if (!fs.existsSync(${JSON.stringify(request)})) return;
      clearInterval(poll);
      const {socket,nonce} = JSON.parse(fs.readFileSync(${JSON.stringify(request)},'utf8'));
      setTimeout(() => {
        const server = net.createServer();
        server.listen(socket, () => {
          fs.writeFileSync(${JSON.stringify(ready + ".tmp")}, JSON.stringify({core:{id:nonce},version:'fake',pid:process.pid,live:0,finished:0}));
          fs.renameSync(${JSON.stringify(ready + ".tmp")}, ${JSON.stringify(ready)});
        });
        process.on('SIGTERM', () => { fs.writeFileSync(${JSON.stringify(sigterm)}, ''); server.close(() => process.exit(0)); });
      }, ${delayMs});
    }, 20);
  `], { stdio: "ignore" });
  const exited = new Promise<void>((resolve, reject) => { core.once("exit", () => resolve()); core.once("error", reject); });
  try {
    // Stop after the identity receipt: terminal/OSC cases use the existing full fake lifecycle.
    // Only setup throws: runSmoke's finally checkpoint("cleanup") must reach liveHost.stop.
    h.checkpoint = (phase) => { if (phase === "setup") throw new Error("fixture stops after private core verification"); };
    const evidence = await runSmoke(h);
    if (evidence.observations.coreAbsent) await exited;
    const receiptFile = join(dir, receipt === "valid" ? "started.json" : "recovered.json");
    return {
      evidence,
      receipt: existsSync(receiptFile) ? JSON.parse(readFileSync(receiptFile, "utf8")) : undefined,
      expected: { pid: core.pid, coreId: h.nonce, socket: h.socket, session: `tkr-${h.nonce}` },
      socketAbsent: !existsSync(h.socket),
      coreExited: core.exitCode !== null || core.signalCode !== null,
      // Graceful exit from the SIGTERM handler, read before the fixture's SIGKILL fallback below.
      stopped: { sigterm: existsSync(sigterm), code: core.exitCode, signal: core.signalCode },
      calls: readFileSync(calls, "utf8").trim().split("\n").map((s) => JSON.parse(s) as string[]),
    };
  } finally {
    if (core.exitCode === null && core.signalCode === null) core.kill("SIGKILL");
    await exited;
  }
}

test("liveHost retains the starting core identity and finally cleans up after the captured launchd handshake delay", { timeout: 70_000 }, async () => {
  const capture = JSON.parse(readFileSync(new URL("../fixtures/herdr-app/captures.json", import.meta.url), "utf8")).captures["R1-private-start"];
  const handshakeSeconds = Number(/handshake within (\d+) s/.exec(capture.stderr)?.[1]);
  expect(handshakeSeconds).toBe(10);
  const result = await delayedPrivateStart(handshakeSeconds * 1000 + 200, "valid");
  expect(result.evidence.errors).toEqual(["fixture stops after private core verification"]);
  expect(result.evidence.observations).toMatchObject({ privateCore: true, terminalsAbsent: true, childAbsent: true, coreAbsent: true });
  expect(result.receipt).toMatchObject(result.expected);
  expect(result.coreExited && result.socketAbsent).toBe(true);
  expect(result.stopped).toEqual({ sigterm: true, code: 0, signal: null });
});

test("liveHost recovers delayed sockets after lost startup receipts without retrying startup or turning failures green", { timeout: 160_000 }, async () => {
  // Bounded generalisation: immediate, beyond the old 8 s bound, and beyond the captured
  // 10 s handshake; both malformed zero-exit and nonzero receipts remain failures.
  for (const [delay, receipt] of [[0, "malformed"], [8_500, "nonzero"], [12_000, "malformed"]] as const) {
    const result = await delayedPrivateStart(delay, receipt);
    expect(result.evidence.errors, `${delay}: ${receipt}`).toHaveLength(1);
    expect(result.evidence.errors[0]).toContain("status response family failed");
    expect(smokeVerdict(result.evidence).status).toBe("failed");
    expect(result.evidence.observations.privateCore).toBeUndefined();
    expect(result.evidence.observations).toMatchObject({ terminalsAbsent: true, childAbsent: true, coreAbsent: true });
    expect(result.receipt).toMatchObject(result.expected);
    expect(result.coreExited && result.socketAbsent).toBe(true);
    expect(result.stopped, `${delay}: ${receipt}`).toEqual({ sigterm: true, code: 0, signal: null });
    expect(result.calls.every((args) => ["server status --json", "ls --all --json"].includes(args.join(" ")))).toBe(true);
  }
});

test("child cleanup re-proves the nonce child immediately before any signal and never kills a reused pid", async () => {
  const h = fakeHost();
  const stranger = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], { stdio: "ignore" });
  const gone = new Promise((done) => stranger.once("exit", done));
  const proof = join(h.dir, "child.json");
  try {
    await new Promise((done) => stranger.once("spawn", done));
    // child.json still names this nonce, but its pid now belongs to an unrelated process.
    writeFileSync(proof, JSON.stringify({ pid: stranger.pid, nonce: h.nonce, scope: false, anchor: "t", socket: h.socket }));
    await expect(h.stopChild()).rejects.toThrow("no longer the nonce child; no signal sent");
    await new Promise((done) => setTimeout(done, 100));
    expect({ code: stranger.exitCode, signal: stranger.signalCode }).toEqual({ code: null, signal: null });
  } finally {
    rmSync(proof, { force: true });
    stranger.kill("SIGKILL"); await gone;
    await h.dispose();
  }
});

const FILE = "tests/e2e/herdr-app-smoke.e2e.test.ts";
const ROOT = fileURLToPath(new URL("../..", import.meta.url));
/** Exercise the production reporter's fullName/result mapping before the real CLI grades its bytes. */
function record(): CiRecord {
  const module = {
    moduleId: join(ROOT, FILE), project: { name: "suite" }, state: () => "passed", diagnostic: () => ({ duration: 1 }),
    children: { allTests: () => [
      { fullName: HERDR_APP_LIVE_TITLE, result: () => ({ state: "passed" }) },
      { fullName: "fake lifecycle", result: () => ({ state: "passed" }) },
    ] },
  };
  return buildRecord(ROOT, "a".repeat(40), undefined, [module] as unknown as Parameters<typeof buildRecord>[3]);
}
async function verdict(paths: string[], required = `${FILE}::${HERDR_APP_LIVE_TITLE}`): Promise<{ code: number | null; stdout: string }> {
  const env = { ...process.env };
  delete env.TICKMARKR_CI_RECORD;
  return new Promise((done, reject) => {
    execFile(process.execPath, ["--import", join(ROOT, "node_modules/tsx/dist/loader.mjs"), join(ROOT, "scripts/ci/cli.ts"), "verdict", "--require-test", required, ...paths],
      { env, timeout: 10_000, killSignal: "SIGKILL", maxBuffer: 1 << 20, encoding: "utf8" }, (error, stdout, stderr) => {
        const e = error as (Error & { code?: number | string; signal?: string }) | null;
        if (e && (typeof e.code !== "number" || e.signal)) reject(new Error(`${e.message}\n${stderr}`));
        else done({ code: e?.code as number ?? 0, stdout });
      });
  });
}

test("test: required-live-test grading satisfies the closed record-verdict table while skipped absent failed and unreadable records cannot establish live proof", { timeout: 90_000 }, async () => {
  const dir = makeTestTempDir("hc-verdict-");
  let n = 0;
  const grade = async (doc: unknown, outcome: string, code: number, defect?: string) => {
    const path = join(dir, `${n++}.json`);
    writeFileSync(path, typeof doc === "string" ? doc : JSON.stringify(doc));
    const result = await verdict([path]);
    expect(result.code, result.stdout).toBe(code);
    expect(result.stdout).toContain(`RECORD_VERDICT verdict=${outcome} `);
    if (defect) expect(result.stdout).toContain(`"kind":"${defect}"`);
    return path;
  };
  const good = record();
  const goodPath = await grade(good, "CLEAN", 0);
  expect(good.tests.find((t) => t.name === HERDR_APP_LIVE_TITLE)?.state).toBe("passed");
  for (const state of ["skipped", "failed", "pending"] as const) {
    const doc = record(); doc.tests.find((t) => t.name === HERDR_APP_LIVE_TITLE)!.state = state;
    await grade(doc, "RED", 1, "required-not-passed"); // file and shell may still say passed
  }
  for (const variant of ["absent", "fake-only", "decorated-title", "wrong-file"] as const) {
    const doc = record();
    if (variant === "absent") doc.tests = [];
    else if (variant === "fake-only") doc.tests = doc.tests.filter((t) => t.name !== HERDR_APP_LIVE_TITLE);
    else if (variant === "decorated-title") doc.tests.find((t) => t.name === HERDR_APP_LIVE_TITLE)!.name = `suite > ${HERDR_APP_LIVE_TITLE}`;
    else doc.tests.find((t) => t.name === HERDR_APP_LIVE_TITLE)!.file = "tests/drivers/herdr-app-smoke-verdict.test.ts";
    await grade(doc, "RED", 1, "required-absent");
  }
  const rpc = record();
  rpc.unhandled.push({ name: "Error", message: '[vitest-worker]: Timeout calling "onTaskUpdate"', type: "Unhandled Error" });
  await grade(rpc, "RPC_ONLY", 0);
  rpc.tests.find((t) => t.name === HERDR_APP_LIVE_TITLE)!.state = "skipped";
  await grade(rpc, "RED", 1, "required-not-passed");
  const failedFile = record(); failedFile.files[0]!.state = "failed";
  await grade(failedFile, "RED", 1, "failed");
  const interrupted = record(); interrupted.reason = "interrupted";
  await grade(interrupted, "RED", 1, "interrupted");
  const cleanupError = record(); cleanupError.unhandled.push({ name: "Error", message: "private core cleanup failed", type: "Unhandled Error" });
  await grade(cleanupError, "RED", 1, "unhandled");
  for (const malformed of ["{", "", { ...good, schema: "tickmarkr-ci-record/1" }, { ...good, head: null }, { ...good, tests: [{ name: HERDR_APP_LIVE_TITLE, state: "passed" }] }]) {
    await grade(malformed, "UNREADABLE", 2);
  }
  const unreadable = join(dir, "directory.json"); mkdirSync(unreadable);
  for (const paths of [[], [join(dir, "missing.json")], [unreadable], [goodPath, unreadable]]) {
    const result = await verdict(paths);
    expect(result.code, result.stdout).toBe(2);
    expect(result.stdout).toContain("RECORD_VERDICT verdict=UNREADABLE ");
  }
  // A good sibling never launders a skipped required leaf in another record.
  const skipped = record(); skipped.tests.find((t) => t.name === HERDR_APP_LIVE_TITLE)!.state = "skipped";
  const skippedPath = await grade(skipped, "RED", 1);
  expect((await verdict([goodPath, skippedPath])).code).toBe(1);
  // Pin the documented invocation to the exported, top-level live title.
  const docs = readFileSync(join(ROOT, "docs/codebase/INTEGRATIONS.md"), "utf8");
  expect(docs).toContain(`--require-test "${FILE}::${HERDR_APP_LIVE_TITLE}"`);
  expect(docs).toContain("TICKMARKR_E2E=1");
  expect(docs).toContain("TICKMARKR_CI_RECORD");
});
