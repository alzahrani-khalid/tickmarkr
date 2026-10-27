import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { shq, type WorkerAdapter } from "../../src/adapters/types.js";
import { DEFAULT_CONFIG } from "../../src/config/config.js";
import { SubprocessDriver } from "../../src/drivers/subprocess.js";
import type { ExecutorDriver, Slot } from "../../src/drivers/types.js";
import { runLlmDetailed } from "../../src/gates/llm.js";
import { classifyVerdictCause } from "../../src/gates/verdict-cause.js";
import { consult, type Dossier } from "../../src/run/consult.js";
import { shell } from "../../src/run/git.js";
import { reapSeatTree, seatShellCeiling, workerReapHost, type ReapProcess } from "../../src/run/stall.js";

afterEach(() => vi.restoreAllMocks());
const pause = (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check: () => boolean | Promise<boolean>, label: string) {
  const end = Date.now() + 8_000;
  while (Date.now() < end) { if (await check()) return; await pause(); }
  throw new Error(`did not observe ${label}`);
}
function running(pid: number): boolean {
  try { return !execFileSync("ps", ["-p", String(pid), "-o", "stat="], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim().startsWith("Z"); }
  catch { return false; }
}
function adapter(command: string): WorkerAdapter {
  return { id: "seat-fixture", headlessCommand: () => command } as unknown as WorkerAdapter;
}
const dossier: Dossier = { taskId: "T3", trigger: "stall", transcript: "", diff: "", journalTail: "", gates: [] };

// A real tool starts a new session/group and a further child. All pipes are closed so neither
// shell pipe ownership nor its group can accidentally make the detached tool disappear.
function fixture(dir: string, name: string, release?: string) {
  const ready = join(dir, `${name}.json`);
  const tool = `const{spawn}=require('child_process');const fs=require('fs');const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});fs.writeFileSync(${JSON.stringify(ready)},JSON.stringify({tool:process.pid,child:child.pid,parent:process.ppid}));setInterval(()=>{},1000)`;
  const root = `const{spawn}=require('child_process');const fs=require('fs');spawn(process.execPath,['-e',${JSON.stringify(tool)}],{detached:true,stdio:'ignore'});console.log('seat wrote before ceiling');${release ? `const t=setInterval(()=>{if(fs.existsSync(${JSON.stringify(release)})){clearInterval(t);process.exit(0)}},20)` : 'setInterval(()=>{},1000)'}`;
  return { ready, command: `${shq(process.execPath)} -e ${shq(root)}` };
}
function receipt(path: string): { tool: number; child: number; parent: number } | undefined {
  try { return JSON.parse(readFileSync(path, "utf8")); } catch { return undefined; }
}
function cleanupReceipt(path: string) {
  const row = receipt(path);
  if (!row) return;
  for (const pid of [row.child, row.tool, row.parent]) if (pid > 1 && pid !== process.pid) {
    try { process.kill(pid, "SIGKILL"); } catch { /* already reaped */ }
  }
}
async function closeProcess(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
  try { process.kill(-child.pid!, "SIGKILL"); } catch { child.kill("SIGKILL"); }
  await closed;
}

test("a headless review seat killed at its ceiling also kills the process group its tool detached, whose leader is reparented when the seat dies, and that group's child, while a gate suite the daemon runs in the same worktree and a process in another worktree survive, so a seat close that signals only its dispatch group fails", async () => {
  const dir = mkdtempSync(join(tmpdir(), "seat-headless-"));
  const seat = fixture(dir, "review");
  const other = mkdtempSync(join(tmpdir(), "seat-other-worktree-"));
  const bait = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { cwd: other, detached: true, stdio: "ignore" });
  let gatePid: number | undefined;
  const gate = shell(`exec ${shq(process.execPath)} -e 'setInterval(()=>{},1000)'`, process.cwd(), 20_000,
    false, { onSpawn: (pid) => { gatePid = pid; } });
  const realIdentity = workerReapHost.identity;
  const realKill = workerReapHost.kill;
  const kills: number[] = [];
  let rootKilled = false;
  let reparented = false;
  const snapshots = vi.spyOn(workerReapHost, "snapshot");
  vi.spyOn(workerReapHost, "kill").mockImplementation((pid) => {
    kills.push(pid);
    const ready = receipt(seat.ready);
    if (pid < 0 && ready && pid !== -ready.tool) rootKilled = true;
    realKill(pid);
  });
  vi.spyOn(workerReapHost, "identity").mockImplementation(async (pid) => {
    if (rootKilled && pid === receipt(seat.ready)?.tool && !reparented) {
      await until(() => {
        try { return Number(execFileSync("ps", ["-p", String(pid), "-o", "ppid="], { encoding: "utf8" }).trim()) === 1; }
        catch { return false; }
      }, "detached tool reparented after the seat group dies");
      reparented = true;
    }
    return realIdentity(pid);
  });
  try {
    const result = await runLlmDetailed(adapter(seat.command), "fixture", "TICKMARKR-REVIEW", process.cwd(), undefined, 3_000);
    const row = receipt(seat.ready)!;
    expect(row).toBeDefined();
    expect(result.timedOut).toBe(true);
    expect(reparented).toBe(true);
    expect(snapshots.mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(workerReapHost.kill).mock.invocationCallOrder[0]!);
    await until(() => !running(row.tool) && !running(row.child), "both detached processes gone");
    expect(kills).toContain(-row.tool);
    for (const pid of [gatePid!, bait.pid!]) {
      expect(running(pid)).toBe(true);
      expect(kills).not.toContain(pid);
      expect(kills).not.toContain(-pid);
    }
  } finally {
    vi.restoreAllMocks();
    cleanupReceipt(seat.ready);
    if (gatePid) { try { process.kill(-gatePid, "SIGKILL"); } catch { /* exited */ } }
    await gate;
    await closeProcess(bait);
    rmSync(dir, { recursive: true, force: true });
    rmSync(other, { recursive: true, force: true });
  }
}, 20_000);

test("a pane review, judge or consult seat that its caller closes kills a detached child of its tool before the pane closes, and a gate pane seat that exited on its own still kills the detached child its accountant recorded, while a kept pane's processes are left alone, so a pane close that orphans tool processes fails", async () => {
  const dir = mkdtempSync(join(tmpdir(), "seat-panes-"));
  const paths: string[] = [];
  const pending = new Set<{ driver: SubprocessDriver; slot: Slot }>();
  try {
    for (const role of ["review", "judge", "consult", "exited", "kept"] as const) {
      const release = role === "exited" ? join(dir, "release") : undefined;
      const seat = fixture(dir, role, release);
      paths.push(seat.ready);
      const driver = new SubprocessDriver();
      let closed = false;
      let entry: { driver: SubprocessDriver; slot: Slot };
      const proxy: ExecutorDriver = {
        id: "fixture-pane", interactive: false,
        slot: async (cwd, name) => { const slot = await driver.slot(cwd, name); entry = { driver, slot }; pending.add(entry); return slot; },
        run: async (slot, cmd) => { await driver.run(slot, cmd); await until(() => !!receipt(seat.ready), "pane tool ready"); },
        waitOutput: async (slot, pattern, ms, opts) => {
          // Accounting has started before a gate wait. Let at least one subsequent poll retain the
          // detached leader and its child before allowing the script to finish on its own.
          if (release) {
            await pause(250);
            writeFileSync(release, "exit");
            expect(await driver.waitOutput(slot, pattern, 5_000, opts)).toBe(true);
            await until(() => !running(receipt(seat.ready)!.parent), "seat exited before caller close");
          }
          return true;
        },
        read: (slot, lines) => driver.read(slot, lines),
        waitAgentStatus: (...args) => driver.waitAgentStatus(...args),
        status: (slot) => driver.status(slot), notify: async () => {}, worktree: async () => dir,
        close: async (slot) => {
          const row = receipt(seat.ready)!;
          await until(() => !running(row.tool) && !running(row.child), "tools dead before pane close");
          closed = true;
          await driver.close(slot);
          pending.delete(entry);
        },
      };
      const keep = role === "kept";
      if (role === "consult") {
        const cfg = structuredClone(DEFAULT_CONFIG);
        cfg.consult.adapter = "seat-fixture";
        cfg.visibility.llm = "pane";
        await consult(dossier, cfg, [adapter(seat.command)], proxy, process.cwd(), dir);
      } else {
        await runLlmDetailed(adapter(seat.command), "fixture", role === "judge" ? "TICKMARKR-JUDGE" : "TICKMARKR-REVIEW", process.cwd(), { driver: proxy, name: role, keep }, 5_000);
      }
      if (keep) {
        expect(closed).toBe(false);
        expect(running(receipt(seat.ready)!.tool)).toBe(true);
        expect(running(receipt(seat.ready)!.child)).toBe(true);
      } else expect(closed).toBe(true);
    }
  } finally {
    for (const path of paths) cleanupReceipt(path);
    for (const { driver, slot } of pending) await driver.close(slot);
    rmSync(dir, { recursive: true, force: true });
  }
}, 20_000);

function row(pid: number, ppid: number, group = pid, command = "tool"): ReapProcess {
  return { pid, ppid, group, identity: `${pid}:birth`, command, session: "seat" };
}
function fakeHost(rows: ReapProcess[]) {
  vi.spyOn(workerReapHost, "snapshot").mockResolvedValue(rows);
  const identity = vi.spyOn(workerReapHost, "identity").mockImplementation(async (pid) => rows.find((r) => r.pid === pid)?.identity);
  const kill = vi.spyOn(workerReapHost, "kill").mockImplementation(() => {});
  return { identity, kill };
}

test("with an identity changed between census and signal the seat reaper signals nothing it reached through it: not a reused root pid's tree, not a reused member, and not that member's group, nor the daemon or its ancestors, and nothing when the process table is unreadable, so a reaper trusting its census or killing by group alone fails", async () => {
  const rows = [row(process.pid, 80, 70), row(80, 1, 70), row(100, process.pid), row(101, 100), row(102, 101, 101)];
  let host = fakeHost(rows);
  host.identity.mockImplementation(async (pid) => pid === 100 ? "100:replacement" : rows.find((r) => r.pid === pid)?.identity);
  expect(await reapSeatTree({ root: { pid: 100, identity: "100:birth" } })).toEqual([]);
  expect(host.kill).not.toHaveBeenCalled();
  vi.restoreAllMocks();

  host = fakeHost(rows);
  let rootReads = 0;
  host.identity.mockImplementation(async (pid) => pid === 100 && ++rootReads > 1
    ? "100:replacement" : rows.find((r) => r.pid === pid)?.identity);
  await reapSeatTree({ root: { pid: 100, identity: "100:birth" } });
  expect(host.kill).not.toHaveBeenCalled(); // replacement after seed validation, before the signal
  vi.restoreAllMocks();

  host = fakeHost(rows);
  host.identity.mockImplementation(async (pid) => pid === 101 ? "101:replacement" : rows.find((r) => r.pid === pid)?.identity);
  await reapSeatTree({ root: { pid: 100, identity: "100:birth" } });
  expect(host.kill).toHaveBeenCalledWith(-100);
  for (const pid of [101, -101, 102, process.pid, -70, 80, -80, 1, -1]) expect(host.kill).not.toHaveBeenCalledWith(pid);
  vi.restoreAllMocks();

  host = fakeHost(rows);
  let memberReads = 0;
  host.identity.mockImplementation(async (pid) => pid === 101 && ++memberReads >= 3
    ? "101:replacement" : rows.find((r) => r.pid === pid)?.identity);
  await reapSeatTree({ root: { pid: 100, identity: "100:birth" } });
  for (const pid of [101, -101, 102, -102]) expect(host.kill).not.toHaveBeenCalledWith(pid);
  vi.restoreAllMocks();

  host = fakeHost(rows);
  await reapSeatTree({ recorded: new Map([[process.pid, `${process.pid}:birth`], [80, "80:birth"]]) });
  expect(host.kill).not.toHaveBeenCalled();
  vi.mocked(workerReapHost.snapshot).mockResolvedValue(undefined);
  expect(await reapSeatTree({ root: { pid: 100, identity: "100:birth" } })).toBeNull();
  expect(host.kill).not.toHaveBeenCalled();
});

test("a headless seat reaped at its ceiling is reported timed out with the bytes it wrote before the kill, as a ceiling kill is reported today, so a reap that changes the seat's verdict or its timeout label fails", async () => {
  // Pin the host table at the OS seam; the shell, timer, SIGKILL and captured streams are real.
  // Separate integration cases above exercise the host's actual ps census and detached ancestry.
  let root: number | undefined;
  const exists = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  vi.spyOn(workerReapHost, "identity").mockImplementation(async (pid) => {
    root ??= pid;
    return exists(pid) ? `${pid}:birth` : undefined;
  });
  vi.spyOn(workerReapHost, "snapshot").mockImplementation(async () => [
    row(process.pid, 1, process.pid), ...(root && exists(root) ? [row(root, process.pid)] : []),
  ]);
  const command = `${shq(process.execPath)} -e ${shq("process.stdout.write('seat prose before kill');process.stderr.write('stderr before kill');setInterval(()=>{},1000)")}`;
  const result = await runLlmDetailed(adapter(command), "fixture", "review", process.cwd(), undefined, 500);
  expect(result).toMatchObject({ timedOut: true, exitCode: 1 });
  expect(result.output).toContain("seat prose before kill");
  expect(result.output).toContain("stderr before kill");
  expect(classifyVerdictCause(result.output, "deadbeef", "approve", result)).toBe("timeout");
  const legacy = await shell("printf legacy; sleep 30", process.cwd(), 500);
  expect(legacy.timedOut).toBe(true);
  expect(legacy.stdout).toBe("legacy");
});

test("a seat shell's own backstop and post-exit signals recheck the leader's spawn identity, so a pid reused after spawn and its group survive them on the review and consult seats, while a seat leader that keeps its identity is still killed at the backstop (D-2174)", async () => {
  // Every later identity read names another process: the pid was reused after spawn. The real process stands in for it.
  let reused = false;
  const born = new Set<number>();
  vi.spyOn(workerReapHost, "identity").mockImplementation(async (pid) => {
    if (reused && born.has(pid)) return `${pid}:replacement`;
    born.add(pid);
    return `${pid}:birth`;
  });
  const dir = mkdtempSync(join(tmpdir(), "seat-shell-reuse-"));
  const pids = join(dir, "pids");
  const spawned = () => { try { return readFileSync(pids, "utf8").trim().split("\n").map(Number); } catch { return []; } };
  const forever = `exec ${shq(process.execPath)} -e 'setInterval(()=>{},1000)'`;
  try {
    // Backstop: the shell's own ceiling signals only a leader still bearing its spawn identity.
    for (const reuse of [false, true]) {
      reused = reuse;
      const ceiling = seatShellCeiling(60_000);
      let leader: number | undefined;
      const r = await shell(forever, process.cwd(), 500, false, {
        onSpawn: (pid) => { leader = pid; ceiling.onSpawn(pid); }, ownsLeader: ceiling.ownsLeader,
      });
      await ceiling.stop();
      expect(r.timedOut).toBe(true);
      if (reuse) {
        expect(running(leader!)).toBe(true);
        process.kill(-leader!, "SIGKILL");
      } else await until(() => !running(leader!), "an owned seat leader killed at the backstop");
    }
    // Post-exit reap: the seat exits while its group's child still holds the pipe; that group is no longer provably the seat's.
    reused = true;
    const holder = `const{spawn}=require('child_process');const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:['ignore','inherit','inherit']});require('fs').appendFileSync(${JSON.stringify(pids)},c.pid+'\\n');console.log('seat answered');process.exit(0)`;
    const command = `${shq(process.execPath)} -e ${shq(holder)}`;
    const cfg = structuredClone(DEFAULT_CONFIG);
    cfg.consult.adapter = "seat-fixture";
    cfg.visibility.llm = "headless";
    const [review] = await Promise.all([
      runLlmDetailed(adapter(command), "fixture", "TICKMARKR-REVIEW", process.cwd(), undefined, 60_000),
      consult(dossier, cfg, [adapter(command)], new SubprocessDriver(), process.cwd(), dir),
    ]);
    expect(review).toMatchObject({ timedOut: false, exitCode: 0 });
    expect(review.output).toContain("seat answered");
    expect(spawned().length).toBeGreaterThanOrEqual(2);
    for (const pid of spawned()) expect(running(pid)).toBe(true);
  } finally {
    for (const pid of spawned()) { try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ } }
    rmSync(dir, { recursive: true, force: true });
  }
}, 20_000);

test("seat ownership uses exact markers and birth receipts, spares a foreign group member, and bounds survivor censuses", async () => {
  const rows = [row(process.pid, 80, 70), row(80, 1, 70), row(100, process.pid, 70, "bash /seat/dispatch.sh"),
    row(101, 100, 200), row(102, process.pid, 200, "foreign suite"), row(103, process.pid, 300, "echo bash /seat/dispatch.sh")];
  let host = fakeHost(rows);
  const inspect = vi.spyOn(workerReapHost, "inspect");
  expect(await reapSeatTree({ marker: "/seat/dispatch.sh" })).toEqual([100, 101]);
  expect(host.kill).toHaveBeenCalledWith(100);
  expect(host.kill).toHaveBeenCalledWith(101);
  for (const pid of [-70, -200, -300, 102, 103, process.pid, 80]) expect(host.kill).not.toHaveBeenCalledWith(pid);
  expect(workerReapHost.snapshot).toHaveBeenCalledTimes(6); // one initial census, at most five fresh reads
  expect(inspect).not.toHaveBeenCalled(); // neither same cwd nor a different worktree grants ownership
  vi.restoreAllMocks();

  const orphaned = [row(process.pid, 1, 70), row(101, 1, 101), row(102, 101, 101)];
  host = fakeHost(orphaned);
  await reapSeatTree({ recorded: new Map([[101, "101:birth"]]) });
  expect(host.kill).toHaveBeenCalledWith(-101);
  expect(host.kill).toHaveBeenCalledWith(102);
  vi.restoreAllMocks();

  host = fakeHost(orphaned);
  expect(await reapSeatTree({ recorded: new Map([[101, "101:old-birth"]]) })).toEqual([]);
  expect(host.kill).not.toHaveBeenCalled();
  vi.restoreAllMocks();

  host = fakeHost(rows);
  vi.mocked(workerReapHost.snapshot).mockResolvedValueOnce(rows).mockResolvedValue(undefined);
  expect(await reapSeatTree({ marker: "/seat/dispatch.sh" })).toBeNull();
  expect(workerReapHost.snapshot).toHaveBeenCalledTimes(2);
  expect(host.kill.mock.calls).toEqual([[101], [100]]);
});
