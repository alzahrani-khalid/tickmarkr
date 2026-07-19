import { existsSync, writeFileSync } from "node:fs";
import { userInfo } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { approve } from "../../src/cli/commands/approve.js";
import { tickmarkrDir } from "../../src/graph/graph.js";
import { runDaemon } from "../../src/run/daemon.js";
import { gitHead } from "../../src/run/git.js";
import { Journal } from "../../src/run/journal.js";
import { COMMIT, setupRepo, T } from "../helpers/tmprepo.js";

const countApproved = (dir: string, runId: string): number =>
  Journal.open(dir, runId).read().filter((e) => e.event === "task-approved").length;

describe("tickmarkr approve — fail-closed human gate approval (GATE-08, zero-token)", () => {
  test("unknown runId is a loud refusal; no journal directory is created", async () => {
    const { repo } = setupRepo([T("T1", { humanGate: true })], { tasks: {} });
    await expect(approve(["run-nope", "T1"], repo)).rejects.toThrow(/no journal for run-nope/i);
    expect(existsSync(join(tickmarkrDir(repo), "runs", "run-nope"))).toBe(false);
  });

  test("unknown taskId is a loud refusal; zero task-approved events appended", async () => {
    const { repo, fake } = setupRepo(
      [T("T1", { humanGate: true })],
      { tasks: { T1: [{ shell: `echo ok > ok.txt && ${COMMIT} ok`, result: { ok: true, summary: "t1" } }] } },
    );
    await runDaemon(repo, { adapters: [fake], runId: "run-a" });
    await expect(approve(["run-a", "T_NOPE"], repo)).rejects.toThrow(/T_NOPE.*no events/);
    expect(countApproved(repo, "run-a")).toBe(0);
  });

  test("not-parked task is a loud refusal naming the actual status; zero events appended", async () => {
    const { repo, fake } = setupRepo(
      [T("T1")],
      { tasks: { T1: [{ shell: `echo ok > ok.txt && ${COMMIT} ok`, result: { ok: true, summary: "t1" } }] } },
    );
    const s = await runDaemon(repo, { adapters: [fake], runId: "run-b" });
    expect(s.done).toEqual(["T1"]); // T1 is done, not parked
    await expect(approve(["run-b", "T1"], repo)).rejects.toThrow(/T1 is done, not a parked human gate/);
    expect(countApproved(repo, "run-b")).toBe(0);
  });

  test("success appends who/when (default OS user) and prints the next step", async () => {
    const { repo, fake } = setupRepo(
      [T("T1", { humanGate: true })],
      { tasks: { T1: [{ shell: `echo ok > ok.txt && ${COMMIT} ok`, result: { ok: true, summary: "t1" } }] } },
    );
    await runDaemon(repo, { adapters: [fake], runId: "run-c" }); // T1 parks
    const out = await approve(["run-c", "T1"], repo);
    expect(out).toContain(userInfo().username);
    expect(out).toContain("tickmarkr resume run-c");
    const ev = Journal.open(repo, "run-c").read().filter((e) => e.event === "task-approved");
    expect(ev).toHaveLength(1);
    expect(ev[0].taskId).toBe("T1");
    expect(ev[0].data.by).toBe(userInfo().username);
    expect(Date.parse(ev[0].ts)).toBeGreaterThan(0); // the event's ts is the when
  });

  test("--by and --reason are recorded verbatim", async () => {
    const { repo, fake } = setupRepo(
      [T("T1", { humanGate: true })],
      { tasks: { T1: [{ shell: `echo ok > ok.txt && ${COMMIT} ok`, result: { ok: true, summary: "t1" } }] } },
    );
    await runDaemon(repo, { adapters: [fake], runId: "run-d" });
    await approve(["run-d", "T1", "--by", "orchestrator-on-behalf", "--reason", "reviewed diff"], repo);
    const ev = Journal.open(repo, "run-d").read().find((e) => e.event === "task-approved")!;
    expect(ev.data.by).toBe("orchestrator-on-behalf");
    expect(ev.data.reason).toBe("reviewed diff");
  });

  test("double-approve is refused (replayed status is now pending, not parked)", async () => {
    const { repo, fake } = setupRepo(
      [T("T1", { humanGate: true })],
      { tasks: { T1: [{ shell: `echo ok > ok.txt && ${COMMIT} ok`, result: { ok: true, summary: "t1" } }] } },
    );
    await runDaemon(repo, { adapters: [fake], runId: "run-e" });
    await approve(["run-e", "T1"], repo); // first approval — replayed status is now "pending"
    await expect(approve(["run-e", "T1"], repo)).rejects.toThrow(/T1 is pending, not a parked human gate/);
    expect(countApproved(repo, "run-e")).toBe(1); // exactly one event — approvals cannot stack
  });

  test("missing positionals is a loud usage refusal", async () => {
    const { repo } = setupRepo([T("T1", { humanGate: true })], { tasks: {} });
    await expect(approve([], repo)).rejects.toThrow(/usage: tickmarkr approve/);
    await expect(approve(["run-x"], repo)).rejects.toThrow(/usage: tickmarkr approve/);
  });

  test("GATE-08 end-to-end through the real command: park → approve() → resume → done", async () => {
    // proves the command and the daemon agree on the event name and semantics (not a journal append,
    // but the actual exported approve() function).
    const { repo, fake } = setupRepo(
      [T("T1", { humanGate: true })],
      { tasks: { T1: [{ shell: `echo ok > ok.txt && ${COMMIT} ok`, result: { ok: true, summary: "t1" } }] } },
    );
    const s1 = await runDaemon(repo, { adapters: [fake], runId: "run-e2e" });
    expect(s1.human).toEqual(["T1"]);
    await approve(["run-e2e", "T1"], repo);
    const s2 = await runDaemon(repo, { adapters: [fake], runId: "run-e2e", resume: true });
    expect(s2.done).toEqual(["T1"]);
  });

  // v1.24 OBS-18 / GATE-08 non-regression: humanGate parks (attempts 0) stamp NO release field —
  // event shape stays {by, via} (+ optional reason), identical to pre-v1.24.
  test("humanGate approve stamps no release field (GATE-08 byte-stable)", async () => {
    const { repo, fake } = setupRepo(
      [T("T1", { humanGate: true })],
      { tasks: { T1: [{ shell: `echo ok > ok.txt && ${COMMIT} ok`, result: { ok: true, summary: "t1" } }] } },
    );
    await runDaemon(repo, { adapters: [fake], runId: "run-hg-rel" });
    await approve(["run-hg-rel", "T1", "--by", "op"], repo);
    const ev = Journal.open(repo, "run-hg-rel").read().find((e) => e.event === "task-approved")!;
    expect(ev.data.by).toBe("op");
    expect(ev.data.via).toBe("cli");
    expect(ev.data.release).toBeUndefined(); // no attempt-cap grant on a pre-dispatch humanGate park
  });

  // v1.24 OBS-18: approve of a task whose last task-human is an attempt-cap park stamps release.
  test("attempt-cap park approve stamps release:attempt-cap", async () => {
    const { repo } = setupRepo(
      [T("T1")],
      { tasks: { T1: [{ shell: `echo ok > ok.txt && ${COMMIT} ok`, result: { ok: true, summary: "t1" } }] } },
    );
    // seed a cap-park journal (status human) without burning 10 real attempts in the suite
    const j = Journal.create(repo, "run-cap-rel");
    const baseRef = await gitHead(repo);
    j.append("run-start", undefined, { baseRef, commands: {} });
    const a = { adapter: "fake", model: "fake-1", channel: "sub", tier: "frontier" };
    for (let i = 0; i < 10; i++) j.append("task-dispatch", "T1", { assignment: a, attempt: i });
    j.append("task-human", "T1", { reason: "attempt cap (10) reached", kind: "attempt-cap" });
    writeFileSync(join(j.dir, "baseline.json"), JSON.stringify({ commands: {} }));

    await approve(["run-cap-rel", "T1", "--by", "op"], repo);
    const ev = Journal.open(repo, "run-cap-rel").read().find((e) => e.event === "task-approved")!;
    expect(ev.data.release).toBe("attempt-cap");
    expect(ev.data.by).toBe("op");
    // resume state: fresh budget + tried preserved
    const st = Journal.open(repo, "run-cap-rel").replayResumeState().get("T1")!;
    expect(st.attempts).toBe(0);
    expect(st.tried).toEqual(["fake:fake-1"]);
  });

  test("approve resolves a park by its kind and not by prose matching", async () => {
    const { repo } = setupRepo([T("T1")], { tasks: {} });
    const j = Journal.create(repo, "run-kind-rel");
    j.append("task-human", "T1", { reason: "a completely unrelated message", kind: "attempt-cap" });
    await approve(["run-kind-rel", "T1"], repo);
    expect(Journal.open(repo, "run-kind-rel").read().find((e) => e.event === "task-approved")?.data.release).toBe("attempt-cap");
  });

  test("an unknown park kind still requires a human", async () => {
    const { repo } = setupRepo([T("T1")], { tasks: {} });
    const j = Journal.create(repo, "run-unknown-kind");
    j.append("task-human", "T1", { reason: "attempt cap (10) reached", kind: "future-kind" });
    await approve(["run-unknown-kind", "T1"], repo);
    const approved = Journal.open(repo, "run-unknown-kind").read().find((e) => e.event === "task-approved")!;
    expect(approved.data.release).toBeUndefined();
  });
});
