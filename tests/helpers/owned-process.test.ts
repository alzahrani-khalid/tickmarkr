import { type ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { expect, test, vi } from "vitest";
import * as lifecycle from "../../src/run/beat-lifecycle.js";
import { alive, exited, psTable, runOwned, TeardownLedger, teardownTree, type Proc } from "./owned-process.js";

const sleeper = () => spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { detached: true, stdio: "ignore" });
const reap = async (child: ChildProcess) => {
  if (exited(child)) return;
  const done = once(child, "exit");
  child.kill("SIGKILL");
  await done;
};

test("test: a teardown ledger used as both beat suites use it holds every child and every non-child pid they register, each pid with the identity the production identity reader read at registration, and at teardown signals a child only while unreaped and a pid only while that identity still reads the same, so a reaped child and a registered pid now held by a live stand-in receive no signal and the stand-in survives, while every unreaped child and live matching owner is killed through the caller's guard", async () => {
  const ledger = new TeardownLedger();
  const children = [sleeper(), sleeper()];
  const owner = sleeper();
  const standIns = [sleeper(), sleeper(), sleeper(), sleeper(), sleeper()];
  const reaped = [spawn(process.execPath, ["-e", ""], { stdio: "ignore" }), sleeper()];
  const realIdentity = lifecycle.readProcessIdentity;
  const identity = vi.spyOn(lifecycle, "readProcessIdentity");
  try {
    await Promise.all([once(reaped[0]!, "exit"), reap(reaped[1]!)]);
    expect(reaped[0]!.exitCode).toBe(0);
    expect(reaped[1]!.signalCode).toBe("SIGKILL");
    // Deterministic pid wrap: the reaped handles now name live stand-ins. Their exit state must win.
    reaped.forEach((child, i) => Object.defineProperty(child, "pid", { value: standIns[i]!.pid }));
    for (const child of [...children, ...reaped]) ledger.addChild(child);
    const owners = [owner, ...standIns.slice(2)];
    for (const child of owners) ledger.addPid(child.pid!);
    expect(ledger.children).toEqual([...children, ...reaped]);
    expect([...ledger.pids.keys()]).toEqual(owners.map((child) => child.pid));
    const registered = new Map(ledger.pids);
    owners.forEach((child, i) => {
      expect(identity.mock.calls[i]).toEqual([child.pid]);
      expect(identity.mock.results[i]!.value).toEqual(registered.get(child.pid!));
      expect(registered.get(child.pid!)).toEqual(realIdentity(child.pid!));
      expect(typeof registered.get(child.pid!)).toBe("object");
    });
    // Each of the production reader's three identity fields independently rejects a replacement.
    const fields = ["birth", "command", "cwd"] as const;
    identity.mockImplementation((pid) => {
      const current = realIdentity(pid);
      const i = standIns.slice(2).findIndex((child) => child.pid === pid);
      return i < 0 || typeof current !== "object" ? current : { ...current, [fields[i]!]: `replacement-${fields[i]}` };
    });
    const guarded: number[] = [];
    const realKill = process.kill.bind(process);
    const signals: number[] = [];
    const kill = vi.spyOn(process, "kill").mockImplementation((pid, sig) => {
      if (sig === "SIGKILL") signals.push(pid);
      return realKill(pid, sig);
    });
    try {
      await ledger.teardown((pid, sig) => {
        if (pid <= 0 || pid === process.pid || pid === process.ppid) throw new Error(`unsafe cleanup ${pid}`);
        guarded.push(pid);
        process.kill(pid, sig);
      });
      expect(guarded).toEqual([...children, owner].map((child) => child.pid));
      expect(signals).toEqual(guarded);
      expect(children.every(exited)).toBe(true);
      expect(lifecycle.readProcessIdentity(owner.pid!)).toBe("DEAD");
      expect(standIns.every((child) => alive(child.pid!))).toBe(true);
      expect(ledger.children).toEqual([]);
      expect(ledger.pids.size).toBe(0);
    } finally { kill.mockRestore(); }
  } finally {
    identity.mockRestore();
    await Promise.all([...children, owner, ...standIns, ...reaped].map(reap));
  }
});

test("test: an owned teardown stops and kills a recorded descendant or the group it leads only when a read within that teardown shows the pid with its recorded start time, and a root's group only while the root is unreaped or an identified member holds it, so a live stand-in holding a recorded pid or a reaped root's number is neither stopped nor killed nor reported as a survivor, while identified descendants, a detached group and a child the tracker recorded before discovery failed still die", async () => {
  const standIns = [sleeper(), sleeper(), sleeper()];
  const root = spawn(process.execPath, ["-e", ""], { detached: true, stdio: "ignore" });
  const realKill = process.kill.bind(process);
  const signals: Array<[number, NodeJS.Signals]> = [];
  const kill = vi.spyOn(process, "kill").mockImplementation((pid, sig) => {
    if (sig === "SIGSTOP" || sig === "SIGKILL") signals.push([pid, sig]);
    return realKill(pid, sig);
  });
  try {
    await once(root, "exit");
    Object.defineProperty(root, "pid", { value: standIns[0]!.pid });
    for (const unreadable of [false, true]) {
      const owned = sleeper();
      try {
        const rows = await psTable();
        const row = (child: ChildProcess) => rows.find((p) => p.pid === child.pid)!;
        const known = new Map<number, Proc>([standIns[0]!, standIns[1]!].map((child) => [child.pid!, {
          ...row(child), startTime: "Thu Jan  1 00:00:00 1970",
        }]));
        known.set(owned.pid!, row(owned));
        let reads = 0;
        const result = await teardownTree(root, { known, ps: async () => {
          reads++;
          if (unreadable) throw new Error("unreadable teardown census");
          // A replacement's child must not become owned through the remembered parent number either.
          return (await psTable()).map((p) => p.pid === standIns[2]!.pid ? { ...p, ppid: standIns[1]!.pid! } : p);
        } });
        expect(reads).toBeGreaterThan(0);
        expect(result.survivors).toEqual([]);
        expect(result.unresolved).toBe(unreadable ? "process discovery failed: unreadable teardown census" : undefined);
        expect(alive(owned.pid!)).toBe(false);
        expect(signals).toContainEqual([-owned.pid!, "SIGKILL"]);
        if (!unreadable) expect(signals).toContainEqual([owned.pid!, "SIGSTOP"]);
        for (const standIn of standIns) {
          expect(signals.filter(([pid]) => Math.abs(pid) === standIn.pid)).toEqual([]);
          expect(alive(standIn.pid!)).toBe(true);
        }
      } finally { await reap(owned); }
    }

    // A real tracker discovers the detached child before the first teardown census fails.
    const marker = randomUUID();
    const cancel = new AbortController();
    let tracked: Proc | undefined;
    const run = await runOwned(process.execPath, ["-e", `
      const child = require('node:child_process').spawn('sleep', ['60'], { detached: true, stdio: 'ignore' });
      child.unref(); console.log(child.pid); setInterval(() => {}, 1000);
    `], {
      ms: 30_000, signal: cancel.signal, env: { ...process.env, TKR_OWNED_BY: marker },
      ps: async (o) => {
        if (o.phase === "teardown") throw new Error("discovery failed after tracking");
        const rows = await psTable(o);
        const parent = rows.find((p) => p.ppid === process.pid && p.tags?.includes(marker));
        tracked = rows.find((p) => p.ppid === parent?.pid && p.pgid === p.pid);
        if (tracked) cancel.abort();
        return rows;
      },
    });
    expect(tracked).toBeDefined();
    expect(run.why).toBe("cancelled");
    expect(run.unresolved).toBe("process discovery failed: discovery failed after tracking");
    expect(run.tree).toContainEqual(tracked);
    expect(run.survivors).toEqual([]);
    expect(alive(tracked!.pid)).toBe(false);
    expect(signals).toContainEqual([-tracked!.pid, "SIGKILL"]);
    expect(signals).toContainEqual([-run.pid!, "SIGKILL"]);

    // An exited root still owns its old group when an identified member remains in that group.
    const grouped = await runOwned(process.execPath, ["-e", `
      const child = require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
      child.unref(); console.log(child.pid);
    `], { ms: 30_000 });
    expect(grouped).toMatchObject({ why: "settled", exitCode: 0, survivors: [] });
    expect(grouped.unresolved).toBeUndefined();
    expect(grouped.tree.some((p) => p.pid === Number(grouped.out.trim()) && p.pgid === grouped.pid)).toBe(true);
    expect(signals).toContainEqual([-grouped.pid!, "SIGKILL"]);
    expect(alive(Number(grouped.out.trim()))).toBe(false);
  } finally {
    kill.mockRestore();
    await Promise.all([...standIns, root].map(reap));
  }
}, 90_000);
