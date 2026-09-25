// Q-1 (OBS-926): the print branch's quota test reads the output tail exactly as the interactive
// branch reads the banner rows; every quota-failover row carries the matched bytes and their
// offset; a graph pin is never left on a quota match alone.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { QUOTA_RE, shq } from "../../src/adapters/types.js";
import { runDaemon } from "../../src/run/daemon.js";
import { Journal } from "../../src/run/journal.js";
import { COMMIT, setupRepo, T } from "../helpers/tmprepo.js";

const fixture = (name: string) => fileURLToPath(new URL(`../fixtures/quota/${name}`, import.meta.url));
const dump = (name: string) => `cat ${shq(fixture(name))}; exit 1`;
// OBS-1162: each task's retry commits its OWN file — two tasks sharing ok.txt let a retry find
// nothing to commit once the other's ok.txt reached the integration tip.
const okStep = (id: string) => ({ shell: `echo ok > ${id}.txt && ${COMMIT} ${id}`, result: { ok: true, summary: `ok ${id}` } });
const OK_STEP = okStep("T1");
const RETRY = { action: "retry", notes: "a no-trailer exit is not a channel verdict" };
const events = (repo: string, runId: string) => Journal.open(repo, runId).read();

describe("Q-1 quota failover", () => {
  test("the two verbatim run 3522 streams under tests fixtures quota exiting nonzero fail over neither task while a stream whose final rows carry a rate-limit body does, and the failover row names the matched bytes and their offset, so a quota test over the whole stream that fails over on a diff line number 41985 bytes before the end fails", async () => {
    // the negatives match QUOTA_RE somewhere in the body — that is the whole hazard
    for (const f of ["run3522-T2-a0.out", "run3522-T2-a2.out"]) expect(QUOTA_RE.test(readFileSync(fixture(f), "utf8"))).toBe(true);
    const { repo, fake } = setupRepo(
      [T("T1"), T("T2")],
      { tasks: { T1: [{ shell: dump("run3522-T2-a0.out") }, okStep("T1")], T2: [{ shell: dump("run3522-T2-a2.out") }, okStep("T2")] }, consult: RETRY },
    );
    const s = await runDaemon(repo, { adapters: [fake], runId: "run-q1-neg" });
    expect(s.done).toEqual(["T1", "T2"]);
    expect(events(repo, "run-q1-neg").some((e) => e.event === "quota-failover")).toBe(false);

    const pos = setupRepo([T("T1")], { tasks: { T1: [{ shell: dump("rate-limit-429.out") }, OK_STEP] } });
    const s2 = await runDaemon(pos.repo, { adapters: [pos.fake], runId: "run-q1-pos" });
    expect(s2.done).toEqual(["T1"]);
    const row = events(pos.repo, "run-q1-pos").find((e) => e.event === "quota-failover" && e.taskId === "T1");
    expect(row).toBeDefined();
    const d = row!.data as { from: string; to: string | null; matched: string; offset: number; stream: string; streamBytes: number };
    expect(d.to).not.toBeNull();
    expect(d.to).not.toBe(d.from);
    expect(d.matched).toMatch(QUOTA_RE);
    // the offset is a byte offset into the journaled stream file — the record alone locates the bytes
    const stream = readFileSync(join(Journal.open(pos.repo, "run-q1-pos").dir, d.stream));
    expect(stream.subarray(d.offset, d.offset + Buffer.byteLength(d.matched)).toString()).toBe(d.matched);
    expect(stream.length).toBe(d.streamBytes);
    expect(d.streamBytes - d.offset).toBeLessThan(400); // the match sits in the final rows, never 41985 bytes up
  });

  test("a task pinned to its channel whose nonzero exit carries a rate-limit tail without a channel-attributed error stays on the pin with a journaled refusal naming it, while the same tail on an unpinned task fails over, so a pin left on a quota match alone fails", async () => {
    const tail = { shell: "echo 'usage limit reached for this model'; exit 1" };
    // one task per repo: two no-trailer windows on one channel demote it run-wide (OBS-57), which
    // would move the pinned task for a reason that is not the one under test
    const pinned = setupRepo([T("T1", { routingHints: { pin: { via: "fake", model: "fake-1" } } })], { tasks: { T1: [tail, OK_STEP] }, consult: RETRY });
    const s = await runDaemon(pinned.repo, { adapters: [pinned.fake], runId: "run-q1-pin" });
    expect(s.done).toEqual(["T1"]);
    const evs = events(pinned.repo, "run-q1-pin");
    const channelOf = (e: { data: unknown }) => { const a = (e.data as { assignment: { adapter: string; model: string } }).assignment; return `${a.adapter}:${a.model}`; };
    // pinned: no failover, a refusal naming the pin, every dispatch on the pin
    expect(evs.some((e) => e.event === "quota-failover")).toBe(false);
    const refusal = evs.find((e) => e.event === "quota-failover-refused");
    expect(refusal).toBeDefined();
    expect((refusal!.data as { pin: string; matched: string }).pin).toBe("fake:fake-1");
    expect((refusal!.data as { matched: string }).matched).toMatch(QUOTA_RE);
    const dispatches = evs.filter((e) => e.event === "task-dispatch");
    expect(dispatches.length).toBeGreaterThanOrEqual(2);
    for (const e of dispatches) expect(channelOf(e)).toBe("fake:fake-1");
    expect(channelOf(evs.find((e) => e.event === "task-done")!)).toBe("fake:fake-1");

    // unpinned: the same tail fails over to another channel
    const free = setupRepo([T("T1")], { tasks: { T1: [tail, OK_STEP] }, consult: RETRY });
    const s2 = await runDaemon(free.repo, { adapters: [free.fake], runId: "run-q1-free" });
    expect(s2.done).toEqual(["T1"]);
    const evs2 = events(free.repo, "run-q1-free");
    const qf = evs2.find((e) => e.event === "quota-failover");
    expect(qf).toBeDefined();
    expect((qf!.data as { to: string | null }).to).toBe("fake:fake-2");
    expect(evs2.some((e) => e.event === "quota-failover-refused")).toBe(false);
  });

  test("a pinned task stays on its pin across repeated quota-only tails — no cap, no consult reroute, no demotion off the pin", async () => {
    const tail = { shell: "echo 'usage limit reached for this model'; exit 1" };
    const { repo, fake } = setupRepo([T("T1", { routingHints: { pin: { via: "fake", model: "fake-1" } } })], { tasks: { T1: [tail, tail, tail, OK_STEP] }, consult: RETRY });
    const s = await runDaemon(repo, { adapters: [fake], runId: "run-q1-pin3" });
    expect(s.done).toEqual(["T1"]);
    const evs = events(repo, "run-q1-pin3");
    expect(evs.filter((e) => e.event === "quota-failover-refused")).toHaveLength(3);
    expect(evs.some((e) => e.event === "quota-failover")).toBe(false);
    expect(evs.some((e) => e.event === "channel-demotion")).toBe(false);
    expect(evs.some((e) => e.event === "consult")).toBe(false);
    const dispatches = evs.filter((e) => e.event === "task-dispatch");
    expect(dispatches).toHaveLength(4);
    for (const e of dispatches) expect((e.data as { assignment: { adapter: string; model: string } }).assignment).toMatchObject({ adapter: "fake", model: "fake-1" });
  });
});
