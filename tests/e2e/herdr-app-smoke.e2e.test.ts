import { execFile, execFileSync, spawn, type ChildProcess } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { shq } from "../../src/adapters/types.js";
import { HcClient, type HcStatus } from "../../src/drivers/hc-client.js";
import { HerdrAppDriver, OWNER_LABEL, REPO_LABEL } from "../../src/drivers/herdr-app.js";
import { herdrAppBinary } from "../../src/drivers/index.js";
import { type Slot } from "../../src/drivers/types.js";
import { FakeHerdrApp } from "../helpers/fake-herdr-app.js";
import { makeRepo, makeTestTempDir } from "../helpers/tmprepo.js";

// Queue row 340; D-2180, contract R. Only OBSERVER runs the live leaf after the worker run.
// The same lifecycle below drives explicit executable fakes in ordinary gates. A fake pass is
// regression coverage, never a real-core attestation. No app CLI is needed by this headless probe.
export const HERDR_APP_LIVE_TITLE = "private real hc core proves the complete headless driver lifecycle and cleanup";
export const REQUIRED_OBSERVATIONS = [
  "privateCore", "ownership", "unparented", "quotedCommand", "normalTrailer", "normalDrain",
  "altExitTrailer", "altExitDrain", "altReturnTrailer", "altReturnDrain", "coreEnvironment",
  "ownScope", "scopeClearedSurvival", "idle", "working", "blocked", "key", "confirmedSend",
  "hidden", "leftoverReclaimed", "foreignSpared", "terminalsAbsent", "childAbsent", "coreAbsent",
] as const;
type Observation = typeof REQUIRED_OBSERVATIONS[number];
export type SmokeEvidence = {
  gate: boolean; installed: boolean; startAttempted?: boolean; preexisting?: boolean;
  observations: Partial<Record<Observation, boolean>>; errors: string[];
};
export function smokeVerdict(e: SmokeEvidence): { status: "passed" | "skipped" | "failed"; reasons: string[] } {
  // Once start was attempted, even a failed status receipt may have started a core. Never skip it.
  if (!e.startAttempted && !e.preexisting && e.errors.length === 0) {
    if (!e.gate) return { status: "skipped", reasons: ["TICKMARKR_E2E is not 1"] };
    if (!e.installed) return { status: "skipped", reasons: ["hc is missing before private-core creation"] };
  }
  const reasons = [...e.errors];
  if (e.preexisting) reasons.push("pre-existing private core refused; never adopted or killed");
  if (!e.gate || !e.installed || !e.startAttempted) reasons.push("private core was not started under the live prerequisites");
  for (const key of REQUIRED_OBSERVATIONS) if (e.observations[key] !== true) reasons.push(`missing observation: ${key}`);
  return { status: reasons.length ? "failed" : "passed", reasons };
}
const pause = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));
async function until(check: () => boolean | Promise<boolean>, why: string, ms = 8_000): Promise<void> {
  const end = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() >= end) throw new Error(`deadline: ${why}`);
    await pause(40);
  }
}
function check(value: unknown, why: string): asserts value { if (!value) throw new Error(why); }
const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch (e) { if ((e as NodeJS.ErrnoException).code === "ESRCH") return false; throw e; } };
const nodeCommand = (source: string) => `${shq(process.execPath)} -e ${shq(source)}`;
const errorText = (e: unknown) => e instanceof Error ? e.message : String(e);
type Kind = "normal" | "altExit" | "altReturn" | "interactive" | "anchor" | "leftover";
interface ChildProof { pid: number; nonce: string; scope: boolean; anchor: string; socket: string }
export interface SmokeHost {
  dir: string; repo: string; socket: string; nonce: string; client: HcClient; driver: HerdrAppDriver; newDriver(): HerdrAppDriver;
  fresh(): Promise<boolean>; start(): Promise<HcStatus>; verify(core: HcStatus): Promise<void>;
  stop(core: HcStatus): Promise<void>; recover(): Promise<HcStatus | undefined>;
  before(kind: Kind): Promise<void>; created(kind: Kind, address: string): Promise<void>;
  child(): ChildProof | undefined; stopChild(): Promise<void>;
  checkpoint?(phase: string): void;
}

/** Production smoke lifecycle; every success bit is written only after its observation. Cleanup
 * errors join assertion/transport errors rather than replacing them, and finally always runs. */
export async function runSmoke(h: SmokeHost, gate = true, installed = true): Promise<SmokeEvidence> {
  const e: SmokeEvidence = { gate, installed, observations: {}, errors: [] };
  if (smokeVerdict(e).status === "skipped") return e;
  const mark = (key: Observation) => { e.observations[key] = true; };
  const slots: Slot[] = [];
  const addresses = new Map<Slot, string>();
  const raw = new Map<string, Record<string, string>>();
  let core: HcStatus | undefined;
  const attempt = async (body: () => Promise<void>) => { try { await body(); } catch (error) { e.errors.push(errorText(error)); } };
  try {
    if (!(await h.fresh())) { e.preexisting = true; throw new Error("private socket/state already exists"); }
    e.startAttempted = true;
    core = await h.start();
    await h.verify(core);
    mark("privateCore");
    h.checkpoint?.("setup");
    const create = async (kind: Kind, command: string): Promise<Slot> => {
      await h.before(kind);
      const slot = await h.driver.slot(h.repo, `smoke-${kind}`, { owned: { role: "other", taskId: kind, attempt: 0, runId: `run-${h.nonce}` } });
      slots.push(slot); // retain even if run loses its receipt
      await h.driver.run(slot, command);
      const matches = [];
      for (const row of (await h.client.list()).terminals) {
        const t = await h.client.get(row.address);
        if (t.labels[OWNER_LABEL] === slot.name) matches.push(t);
      }
      check(matches.length === 1, "creation ownership must be unique");
      const t = matches[0]!;
      check(t.cwd === realpathSync(h.repo) && t.labels[REPO_LABEL] === realpathSync(join(h.repo, ".git")), "canonical ownership/cwd");
      check(t.parent === null && !t.dieWithParent && !t.notify, "no-parent/no-notify required");
      check(!t.labels["herdr.space"] && !t.labels["herdr.tab"], "private terminal must execute hidden");
      mark("ownership"); mark("unparented"); mark("hidden");
      addresses.set(slot, t.address);
      await h.created(kind, t.address);
      return slot;
    };
    const trailer = `TICKMARKR_RESULT_${h.nonce} {"ok":true}`;
    const quoted = "'\" $() ` ; \\ λ\n".repeat(400);
    const digest = createHash("sha256").update(quoted).digest("hex");
    for (const kind of ["normal", "altExit", "altReturn"] as const) {
      const source = `const crypto=require('node:crypto'); const payload=${JSON.stringify(quoted)};` +
        (kind === "normal" ? "" : "process.stdout.write('\\x1b[?1049h\\x1b[H\\x1b[2J');") +
        (kind === "altReturn" ? "process.stdout.write('alternate screen\\r\\n\\x1b[?1049l');" : "") +
        `console.log('HASH='+crypto.createHash('sha256').update(payload).digest('hex'));` +
        `console.log('CLIENT='+(process.env.TKR_SMOKE_CLIENT_ONLY===undefined?'NO':'YES'));` +
        `console.log('CORE='+process.env.TKR_SMOKE_CORE);console.log('OWN_SCOPE='+(!!process.env.HC_SCOPE));` +
        `console.log('TICKMARKR_RES'+'ULT_${h.nonce} {"ok":true}');`;
      const slot = await create(kind, nodeCommand(source));
      await until(async () => (await h.driver.transportState(slot)).closed, `${kind} exit`);
      h.checkpoint?.("transport");
      const text = await h.driver.read(slot, 1000);
      check(text.includes(trailer), `${kind}: retained read trailer`);
      check(await h.driver.waitOutput(slot, trailer, 5_000), `${kind}: literal trailer after exit`);
      check(await h.driver.waitOutput(slot, `TICKMARKR_RESULT_${h.nonce} \\{"ok":true\\}`, 5_000, { regex: true }), `${kind}: regex trailer after exit`);
      mark(kind === "normal" ? "normalTrailer" : kind === "altExit" ? "altExitTrailer" : "altReturnTrailer");
      const t = (await h.client.list()).terminals.find((r) => r.address === addresses.get(slot));
      check(t, "slot must pin its terminal address");
      const history = await h.client.read(t.address, 1000);
      const screen = await h.client.read(t.address, 0);
      check(screen.complete && screen.how === "screen", `${kind}: complete final screen`);
      const transport = await h.driver.transportState(slot);
      check(transport.closed && transport.exitCode === 0 && transport.signal === null, `${kind}: successful worker exit and closed transport`);
      if (kind === "altExit") check(!history.complete, "altExit: incomplete history must not hide drain");
      mark(kind === "normal" ? "normalDrain" : kind === "altExit" ? "altExitDrain" : "altReturnDrain");
      check(text.includes(`HASH=${digest}`), "multi-KB quoted argv changed"); mark("quotedCommand");
      check(text.includes("CLIENT=NO") && text.includes(`CORE=${h.nonce}`), "child must use core environment, not client exports"); mark("coreEnvironment");
      check(text.includes("OWN_SCOPE=true"), "fresh worker scope must survive seal"); mark("ownScope");
    }
    const blockedFile = join(h.dir, "blocked");
    const interactive = await create("interactive", nodeCommand(String.raw`
      const fs=require("node:fs");
      const status=s=>process.stdout.write('\x1b]7501;state='+s+':app=pi\x1b\\');
      status('idle'); console.log('screen says blocked; only OSC decides');
      require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
        if (!line.trim()) return;
        status('working'); console.log('ACK '+line);
        const poll=setInterval(()=>{ if (fs.existsSync(${JSON.stringify(blockedFile)})) { clearInterval(poll); status('blocked'); } },40);
      });
      setTimeout(()=>process.exit(0),60000);
    `));
    check(await h.driver.waitAgentStatus(interactive, "idle", 5_000), "OSC idle"); mark("idle");
    await h.driver.sendKey(interactive, "Enter"); mark("key");
    await h.driver.run(interactive, `hello-${h.nonce}`);
    check(await h.driver.waitOutput(interactive, `ACK hello-${h.nonce}`, 5_000), "confirmed send must reach interactive program"); mark("confirmedSend");
    check(await h.driver.waitAgentStatus(interactive, "working", 5_000), "OSC working"); mark("working");
    writeFileSync(blockedFile, "blocked");
    h.checkpoint?.("blocked");
    check(await h.driver.waitAgentStatus(interactive, "blocked", 5_000), "OSC blocked"); mark("blocked");

    // A raw private anchor keeps its own injected HC pair/scope. Its daemon-like child is
    // spawned detached THROUGH env -u HC_SCOPE, preserving the private pair at exec time.
    await h.before("anchor");
    const childFile = join(h.dir, "child.json");
    const childSource = `const fs=require('node:fs');fs.writeFileSync(${JSON.stringify(childFile + '.tmp')},JSON.stringify({pid:process.pid,nonce:${JSON.stringify(h.nonce)},scope:('HC_SCOPE' in process.env),anchor:process.env.HC_TERMINAL_ID,socket:process.env.HC_TERMINAL_SOCKET}));fs.renameSync(${JSON.stringify(childFile + '.tmp')},${JSON.stringify(childFile)});setTimeout(()=>process.exit(0),60000);`;
    const anchorSource = `require('node:child_process').spawn('/usr/bin/env',['-u','HC_SCOPE',${JSON.stringify(process.execPath)},'-e',${JSON.stringify(childSource)}],{detached:true,stdio:'ignore'}).unref();setTimeout(()=>process.exit(0),60000);`;
    const anchorLabels = { "smoke.nonce": h.nonce };
    const anchor = await h.client.run(["--bg", "--no-parent", "--no-notify", "--cwd", realpathSync(h.repo), "--label", `smoke.nonce=${h.nonce}`, "--", process.execPath, "-e", anchorSource]);
    raw.set(anchor.address, anchorLabels);
    await h.created("anchor", anchor.address);
    await until(() => !!h.child(), "detached child proof");
    const child = h.child()!;
    check(child.nonce === h.nonce && Number.isSafeInteger(child.pid) && child.pid > 0 && !child.scope && child.anchor === anchor.address && child.socket === h.socket, "scope-cleared child must retain private anchor pair");
    check(alive(child.pid), "detached child initially alive");
    await h.client.kill(anchor.address);
    check((await h.client.get(anchor.address)).state === "finished", "anchor scope killed");
    await pause(750);
    check(alive(child.pid), "scope-cleared child survives anchor kill"); mark("scopeClearedSurvival");

    // Reclaim an owned leftover while protecting a lookalike foreign repo.
    const leftover = await create("leftover", "true");
    const recovered = h.newDriver();
    const adopted = await recovered.adopt(leftover);
    const foreignLabels = { [OWNER_LABEL]: leftover.name, [REPO_LABEL]: `${realpathSync(join(h.repo, ".git"))}-foreign`, "smoke.nonce": h.nonce };
    const foreign = await h.client.run(["--bg", "--no-parent", "--no-notify", "--cwd", realpathSync(h.repo), ...Object.entries(foreignLabels).flatMap(([k,v]) => ["--label", `${k}=${v}`]), "--", "true"]);
    raw.set(foreign.address, foreignLabels);
    // Same name alone cannot authorize control. The recovered binding closes only its pinned address.
    await recovered.close(adopted); slots.splice(slots.indexOf(leftover), 1);
    check(!(await h.client.list()).terminals.some((r) => r.address === addresses.get(leftover)), "owned leftover reclaimed"); mark("leftoverReclaimed");
    check((await h.client.get(foreign.address)).labels[REPO_LABEL] === foreignLabels[REPO_LABEL], "foreign terminal spared"); mark("foreignSpared");
    h.checkpoint?.("assertion");
  } catch (error) { e.errors.push(errorText(error)); }
  finally {
    if (e.startAttempted) {
      await attempt(async () => { core ??= await h.recover(); check(core, "starting core identity unavailable for cleanup"); await h.verify(core); });
      if (core) {
        // Each operation rechecks the private core; never kill by an unverified reused address.
        for (const slot of slots.reverse()) await attempt(async () => { await h.verify(core!); await h.driver.close(slot); });
        for (const [address, labels] of raw) await attempt(async () => {
          await h.verify(core!);
          const t = await h.client.get(address);
          check(Object.entries(labels).every(([k,v]) => t.labels[k] === v) && t.cwd === realpathSync(h.repo), "raw fixture ownership changed");
          if (t.state === "live") await h.client.kill(address);
          await h.client.rm(address);
        });
      }
      await attempt(async () => { await h.stopChild(); mark("childAbsent"); });
      if (core) {
        await attempt(async () => {
          await h.verify(core!);
          const list = await h.client.list();
          check(list.hiddenFinished === 0 && list.terminals.length === 0, "final terminal absence"); mark("terminalsAbsent");
        });
        await attempt(async () => { h.checkpoint?.("cleanup"); await h.stop(core!); mark("coreAbsent"); });
      }
    }
  }
  return e;
}

/** No shell is used for administrative calls, including socket ownership evidence. */
function command(bin: string, argv: string[], env?: NodeJS.ProcessEnv): Promise<string> {
  return new Promise((done, reject) => execFile(bin, argv, { env, encoding: "utf8", timeout: 8_000, killSignal: "SIGKILL", maxBuffer: 1 << 20 }, (error, out) => error ? reject(error) : done(out)));
}
function privateEnv(dir: string, socket: string, nonce: string): NodeJS.ProcessEnv {
  // An allowlist prevents inherited addressing, tokens, hooks and client-only exports reaching the core.
  return { PATH: process.env.PATH, HOME: join(dir, "home"), HC_SESSION: `tkr-${nonce}`, HC_SOCKET: socket,
    XDG_CONFIG_HOME: join(dir, "config"), XDG_STATE_HOME: join(dir, "state"), XDG_RUNTIME_DIR: join(dir, "runtime"),
    TKR_SMOKE_CORE: nonce, TERM: "xterm-256color" };
}
async function stopOwnedChild(h: Pick<SmokeHost, "child" | "nonce">): Promise<void> {
  const child = h.child();
  if (!child) return; // no child launched before an earlier failure
  check(child.nonce === h.nonce && child.pid > 0, "child pid ownership");
  if (alive(child.pid)) {
    // A remembered pid is not an identity: re-prove the nonce child immediately before signalling.
    const argv = await command("ps", ["-ww", "-o", "command=", "-p", String(child.pid)]).catch(() => "");
    if (argv.includes(h.nonce)) process.kill(child.pid, "SIGKILL");
    else if (alive(child.pid)) throw new Error(`child pid ${child.pid} is no longer the nonce child; no signal sent`);
  }
  await until(() => !alive(child.pid), "owned child exited");
}

// R1-private-start waits out a 10 s launchd detach handshake before removing its job
// and starting directly. Startup and lost-receipt recovery need room for that fallback;
// ordinary calls (including verification after the socket exists) retain their 8 s bound.
const PRIVATE_CORE_START_TIMEOUT_MS = 45_000;
/** `lsof -Fn` name rows prove a pid holds the socket, in the producing platform's grammar. macOS prints
 * the bare path, so only exact equality counts there. Linux appends exactly the socket type and, on newer
 * lsof, its state (`n<path> type=STREAM (LISTEN)`), so only that suffix is accepted there. A longer path
 * never matches on either platform. The one residual ambiguity (an old Linux lsof printing no suffix for a
 * socket literally named `<path> type=STREAM`) needs a second socket inside this probe's private mkdtemp
 * directory, which only the private core writes (queue row 340; D-2180). */
const LINUX_UNIX_SUFFIX = /^ type=[A-Z]+(?: \([A-Z_]+\))?$/;
export const lsofOwnsSocket = (rows: string, socket: string, platform: NodeJS.Platform = process.platform): boolean =>
  rows.split("\n").some((row) => row === `n${socket}`
    || (platform === "linux" && row.startsWith(`n${socket}`) && LINUX_UNIX_SUFFIX.test(row.slice(socket.length + 1))));
export function liveHost(hcBin: string, root: string): SmokeHost {
  check(isAbsolute(root), "TICKMARKR_HC_PROBE_ROOT must be an absolute durable seats probe directory");
  const base = realpathSync(root);
  check(!/^\/(?:private\/)?(?:tmp|var\/folders)(?:\/|$)/.test(base), "live probe must not use temporary storage");
  const dir = mkdtempSync(join(base, "r-"));
  const socket = join(dir, "s");
  check(Buffer.byteLength(socket) < 100, "private socket exceeds macOS Unix socket limit; choose a shorter seats probe root");
  const nonce = randomBytes(5).toString("hex");
  const env = privateEnv(dir, socket, nonce);
  for (const p of [env.HOME, env.XDG_CONFIG_HOME, env.XDG_STATE_HOME, env.XDG_RUNTIME_DIR]) mkdirSync(p!, { mode: 0o700 });
  const repo = join(dir, "repo"); mkdirSync(repo);
  execFileSync("git", ["init", "-q", repo], { env, stdio: "pipe" });
  const coreClient = new HcClient({ hcBin, env, timeoutMs: 8_000 });
  const clientEnv = { ...env, TKR_SMOKE_CLIENT_ONLY: "client" };
  // A deliberately nonexistent app path makes accidental window calls fail locally, never target the operator.
  const appBin = join(dir, "no-app-window");
  const client = new HcClient({ hcBin, appBin, env: clientEnv, timeoutMs: 8_000 });
  const newDriver = () => new HerdrAppDriver({ hcBin, appBin, env: clientEnv, pollMs: 40, readinessMs: 5_000, confirmMs: 5_000, callTimeoutMs: 8_000 });
  const driver = newDriver();
  const socketPid = async (pid: number) => {
    check(existsSync(socket), "private socket absent; refuse auto-start during cleanup");
    const rows = await command("lsof", ["-a", "-p", String(pid), "-U", "-Fn"]);
    check(lsofOwnsSocket(rows, socket), "starting core pid does not own the private socket");
  };
  const h: SmokeHost = {
    dir, repo, socket, nonce, client, driver, newDriver,
    fresh: async () => !existsSync(socket),
    start: async () => { const core = await coreClient.status(PRIVATE_CORE_START_TIMEOUT_MS); writeFileSync(join(dir, "started.json"), JSON.stringify({ ...core, socket, session: env.HC_SESSION })); return core; },
    recover: async () => {
      // A lost status receipt can leave a starting core. Wait for that private socket;
      // never call status on an absent socket, which could create a replacement core.
      await until(() => existsSync(socket), "starting private socket for cleanup", PRIVATE_CORE_START_TIMEOUT_MS);
      const core = await coreClient.status();
      await socketPid(core.pid);
      writeFileSync(join(dir, "recovered.json"), JSON.stringify({ ...core, socket, session: env.HC_SESSION }));
      return core;
    },
    verify: async (core) => {
      await socketPid(core.pid); // before status, which otherwise might auto-start another core
      const current = await coreClient.status();
      check(current.coreId === core.coreId && current.pid === core.pid, "private core identity changed");
    },
    stop: async (core) => {
      await h.verify(core);
      process.kill(core.pid, "SIGTERM"); // never server stop/restart, never an operator core
      await until(() => !alive(core.pid), "private core exited");
      check(!existsSync(socket), "private core socket remains after exit");
    },
    before: async () => {}, created: async () => {},
    child: () => { const p = join(dir, "child.json"); return existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) as ChildProof : undefined; },
    stopChild: () => stopOwnedChild(h),
  };
  return h;
}

/** Fake boundary effects only: all driver calls and lifecycle assertions remain the production ones.
 * Short payloads really execute using the fake core's base environment. Captured full-screen reads
 * model the renderer; fake interactive replies model OSC/input without opening a real terminal. */
export function fakeHost(failure?: string): SmokeHost & { fake: FakeHerdrApp; dispose(): Promise<void> } {
  const dir = makeTestTempDir("hc-smoke-");
  const repo = makeRepo({ "README.md": "private smoke fixture\n" });
  const nonce = randomBytes(5).toString("hex");
  const socket = join(dir, "s");
  const captures = (JSON.parse(readFileSync(new URL("../fixtures/herdr-app/captures.json", import.meta.url), "utf8")) as {
    captures: Record<string, { stdout?: string; output: string }>;
  }).captures;
  const capturedRead = (key: string): { complete: boolean; how: string; why?: string } => {
    const capture = captures[key]!;
    return JSON.parse(capture.stdout ?? capture.output) as { complete: boolean; how: string; why?: string };
  };
  const f = new FakeHerdrApp(dir, { socket, execute: true, coreEnv: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: dir, TKR_SMOKE_CORE: nonce } });
  const env = { PATH: process.env.PATH, HC_SESSION: `tkr-${nonce}`, HC_SOCKET: socket, TKR_SMOKE_CLIENT_ONLY: "client" };
  const client = new HcClient({ hcBin: f.hc, appBin: f.app, env });
  const newDriver = () => new HerdrAppDriver({ hcBin: f.hc, appBin: f.app, env, pollMs: 20, readinessMs: 2_000, confirmMs: 2_000 });
  const driver = newDriver();
  let anchorProcess: ChildProcess | undefined, stopped = false, interactiveAddress: string | undefined;
  const h: SmokeHost & { fake: FakeHerdrApp; dispose(): Promise<void> } = {
    dir, repo, socket, nonce, client, driver, newDriver, fake: f,
    fresh: async () => failure !== "preexisting",
    start: async () => { if (failure === "start") throw new Error("start receipt lost"); return client.status(); },
    recover: () => client.status(),
    verify: async (core) => { check(!stopped && (await client.status()).coreId === core.coreId, "fake core identity"); },
    stop: async (core) => { await h.verify(core); stopped = true; },
    checkpoint: (phase) => { if (phase === "blocked" && interactiveAddress) f.setTerm(interactiveAddress, { status: { state: "blocked" } }); if (failure === phase && phase !== "transport") throw new Error(`injected ${phase} failure`); },
    before: async (kind) => { f.update((s) => {
      s.execute = !["interactive", "anchor"].includes(kind);
      s.spawn = kind === "interactive" ? { reported: true, status: { state: "idle" }, screen: { text: "screen says blocked", complete: true }, onSend: { status: { state: "working" } } } : {};
    }); },
    created: async (kind, address) => {
      if (kind === "normal" && failure === "transport") f.rule({ match: ["read", address, "--lines", "0"], output: "{", once: true });
      if (kind === "altExit" || kind === "altReturn") {
        const t = f.term(address);
        const text = t.history.text.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "");
        const capture = kind === "altExit" ? "R1-alt-exit" : "R1-alt-return";
        // Captured alt-exit history is incomplete; alt-return history can be complete.
        // Both must retain the executed nonce and independently prove a complete final screen.
        f.setTerm(address, { history: { ...capturedRead(`${capture}-history`), text }, screen: { ...capturedRead(`${capture}-screen`), text } });
      }
      if (kind === "interactive") {
        f.rule({ match: ["send", address], pass: true, once: true, mutate: { [address]: { onSend: { status: { state: "working" }, screen: { text: `ACK hello-${nonce}`, complete: true }, history: { text: `ACK hello-${nonce}`, complete: true } } } } });
        interactiveAddress = address;
      }
      if (kind === "anchor") {
        const terminal = f.term(address);
        anchorProcess = spawn(terminal.argv[0]!, terminal.argv.slice(1), {
          cwd: terminal.cwd, detached: true, stdio: "ignore",
          env: { ...f.read().coreEnv, HC_TERMINAL_ID: address, HC_TERMINAL_SOCKET: socket, HC_SCOPE: `scope-own-${address}` },
        });
        await new Promise<void>((done, reject) => { anchorProcess!.once("spawn", done); anchorProcess!.once("error", reject); });
        f.setTerm(address, { pid: anchorProcess.pid!, spawned: true });
      }
    },
    child: () => { const p = join(dir, "child.json"); return existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) as ChildProof : undefined; },
    stopChild: () => stopOwnedChild(h),
    dispose: async () => { await stopOwnedChild(h); f.reap(); if (anchorProcess) await until(() => anchorProcess!.exitCode !== null || anchorProcess!.signalCode !== null, "fake anchor reaped"); rmSync(dir, { recursive: true, force: true }); rmSync(repo, { recursive: true, force: true }); },
  };
  return h;
}

// The control suite imports the pure reducer/shared lifecycle. Do not register another live leaf
// in that file (which would otherwise allow two live cores during an opt-in invocation).
if (expect.getState().testPath === fileURLToPath(import.meta.url)) {
  test("test: fake-driven leaves in the e2e file exercise the production smoke lifecycle while a missing observation or cleanup cannot establish proof", { timeout: 90_000 }, async () => {
    const h = fakeHost();
    let evidence: SmokeEvidence;
    try {
      evidence = await runSmoke(h);
      expect(smokeVerdict(evidence)).toEqual({ status: "passed", reasons: [] });
      expect(h.fake.calls().every((c) => c.tool === "hc")).toBe(true);
      expect(h.fake.hcCalls("keys").some((args) => args.includes("enter"))).toBe(true);
      expect(h.fake.hcCalls("send").every((args) => !args.includes("--force"))).toBe(true);
      for (const key of REQUIRED_OBSERVATIONS) {
        const observations = { ...evidence.observations }; delete observations[key];
        expect(smokeVerdict({ ...evidence, observations }).status, key).toBe("failed");
      }
    } finally { await h.dispose(); }
    const broken = fakeHost("cleanup");
    try {
      const result = await runSmoke(broken);
      expect(smokeVerdict(result).status).toBe("failed");
      expect(result.observations.coreAbsent).toBeUndefined();
      expect(result.observations.terminalsAbsent).toBe(true);
      expect(result.observations.childAbsent).toBe(true);
    } finally { await broken.dispose(); }
  });

  test("a malformed post-start transport still cleans up and never becomes an availability skip", async () => {
    const h = fakeHost("transport");
    try {
      const result = await runSmoke(h);
      expect(smokeVerdict(result).status).toBe("failed");
      expect(result.errors.join("\n")).toContain("read response family failed");
      expect(result.observations).toMatchObject({ terminalsAbsent: true, childAbsent: true, coreAbsent: true });
      expect(h.fake.hcCalls("rm")).toHaveLength(1);
    } finally { await h.dispose(); }
  });

  test(HERDR_APP_LIVE_TITLE, { timeout: 180_000 }, async (ctx) => {
    const gate = process.env.TICKMARKR_E2E === "1";
    if (!gate) { ctx.skip("TICKMARKR_E2E is not 1; real-core release proof is OBSERVER-only"); return; }
    const hc = herdrAppBinary("hc"); // filesystem resolution only; no installed executable in ordinary gates
    if (!hc) { ctx.skip("hc is missing before private-core creation"); return; }
    const root = process.env.TICKMARKR_HC_PROBE_ROOT;
    check(root, "set TICKMARKR_HC_PROBE_ROOT to an existing durable seats probe directory");
    const h = liveHost(realpathSync(hc), root);
    let evidence: SmokeEvidence | undefined;
    try {
      evidence = await runSmoke(h);
      expect(smokeVerdict(evidence), JSON.stringify(evidence)).toEqual({ status: "passed", reasons: [] });
    } finally {
      // Keep failed scratch evidence for OBSERVER; never remove state while cleanup is unproven.
      if (evidence && smokeVerdict(evidence).status === "passed") rmSync(h.dir, { recursive: true, force: true });
    }
  });
}
