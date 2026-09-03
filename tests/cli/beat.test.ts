import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test, vi } from "vitest";
import { beat } from "../../src/cli/commands/beat.js";
import { dispatch } from "../../src/cli/index.js";
import { status } from "../../src/cli/commands/status.js";
import { saveGraph, tickmarkrDir } from "../../src/graph/graph.js";
import { validateGraph } from "../../src/graph/schema.js";
import {
  SUPERVISION_BEAT_MS,
  SUPERVISION_STALE_MS,
  readSupervision,
  readTierLiveness,
  supervisionBeatPath,
  supervisionText,
} from "../../src/run/supervision.js";

// SUP-04: the writer verb. Every assertion below is made through `status`'s rendered line rather than
// through the module's own reader — the defect this task exists to close is that the SURFACE claimed
// three tiers while one writer existed, so a test that read the module back would prove nothing about
// what an operator sees. Real temp repos, real files: the beat is file state, and faking it would fake
// the instrument.

const mkRepo = () => mkdtempSync(join(tmpdir(), "tickmarkr-beat-"));

const seedRepo = (repo: string) => {
  saveGraph(repo, validateGraph({
    version: 1, spec: { source: "prd", paths: ["p"], hash: "h" },
    tasks: [{ id: "T1", title: "a", goal: "a", shape: "implement", complexity: 3, acceptance: ["a"] }],
  }));
  const dir = join(tickmarkrDir(repo), "runs", "run-beat");
  mkdirSync(dir, { recursive: true });
  writeFileSync(dir + "/journal.jsonl",
    JSON.stringify({ ts: new Date().toISOString(), event: "run-start", data: { pid: process.pid } }) + "\n");
  return repo;
};

const supervisionLine = (out: string) => out.split("\n").find((l) => l.includes("supervision:"))!;

describe("SUP-04 tickmarkr beat", () => {
  test("test: beating the overseer tier makes status render that tier armed, so a supervision row that stays absent while a seat beats fails", async () => {
    const repo = seedRepo(mkRepo());
    // control first: with nothing beating, the row an overseer would occupy reads ABSENT — the exact
    // line the P99 run printed for a whole milestone while a live overseer watched it.
    expect(supervisionLine(await status([], repo))).toContain("overseer ABSENT");

    const out = await beat(["overseer", "--seat", "OVSR-w1:p2"], repo);

    expect(out).toContain("overseer");
    const line = supervisionLine(await status([], repo));
    expect(line).toContain("overseer ARMED");
    expect(line).not.toContain("overseer ABSENT");
    // the verb writes ONE tier: a beat that armed every row would make the surface unfalsifiable
    expect(line).toContain("watch ABSENT");
  });

  test("test: a beat record written by a one-shot beat names its writer under a field whose name states the writer has exited, and liveness derives from beat freshness alone, so two reads seconds apart cannot disagree about a tier that never stopped", async () => {
    const repo = seedRepo(mkRepo());
    await beat(["overseer", "--seat", "OVSR-w1:p2"], repo);

    const path = supervisionBeatPath(repo, "overseer");
    const record = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    expect(record.exitedWriterPid).toBe(process.pid);
    expect(record).not.toHaveProperty("pid");

    const writtenAt = statSync(path).mtimeMs;
    expect(readTierLiveness(repo, "overseer", writtenAt + 1_000).state).toBe("ARMED");
    expect(readTierLiveness(repo, "overseer", writtenAt + 3_000).state).toBe("ARMED");
  });

  test("test: a tier whose newest beat has aged past the staleness ceiling of six beat intervals renders stale, while one aged past a single interval still renders armed, so a renderer that alarms on one missed beat or never leaves absent fails", async () => {
    const repo = seedRepo(mkRepo());
    await beat(["overseer", "--seat", "OVSR-w1:p2"], repo);

    // BOTH sides of the module's forgiveness window, because each side falsifies a DIFFERENT renderer.
    // One interval past the last beat the seat has missed its cadence and nothing more: a renderer that
    // ALARMS here is the false-positive half — SUPERVISION_STALE_MS is SIX beat intervals (lock.ts's
    // ratio: five may be missed before alarm), and the command's own message names that ceiling rather
    // than the cadence, so no surface promises a flip at one. It may not read ABSENT either: ABSENT is
    // reserved, by construction, for a tier nobody ever armed.
    const missedOne = new Date(Date.now() - SUPERVISION_BEAT_MS - 1_000);
    utimesSync(supervisionBeatPath(repo, "overseer"), missedOne, missedOne);
    const early = supervisionLine(await status([], repo));
    expect(early).not.toContain("overseer ABSENT");
    expect(early).toContain("overseer ARMED");

    // Past the ceiling, the seat has stopped for good — the never-leaves-absent half, and the queue's
    // own red control: STALE says armed-then-lost, ABSENT would say nobody was ever watching.
    const stopped = new Date(Date.now() - SUPERVISION_STALE_MS - 1_000);
    utimesSync(supervisionBeatPath(repo, "overseer"), stopped, stopped);

    const line = supervisionLine(await status([], repo));

    expect(line).toContain("overseer STALE");
    expect(line).not.toContain("overseer ABSENT");
    expect(line).not.toContain("overseer ARMED");
  });

  test("test: beating with the stand-down flag stops the row claiming armed, so a stood-down tier still rendering armed fails", async () => {
    const repo = seedRepo(mkRepo());
    // The normal beat must leave NOTHING beating behind it, or this whole assertion is worthless: a
    // recurring beater surviving the invocation would rewrite the beat ten seconds after the
    // stand-down and flip DISARMED back to ARMED, with the immediate check below none the wiser.
    const scheduled = vi.spyOn(globalThis, "setInterval");
    await beat(["overseer", "--seat", "OVSR-w1:p2"], repo);
    expect(scheduled).not.toHaveBeenCalled();
    scheduled.mockRestore();
    expect(supervisionLine(await status([], repo))).toContain("overseer ARMED");

    await beat(["overseer", "--stand-down", "--seat", "OVSR-w1:p2"], repo);

    const line = supervisionLine(await status([], repo));
    expect(line).not.toContain("overseer ARMED");
    expect(line).toContain("overseer DISARMED"); // a recorded hand-off, not a death ageing out as STALE
    // and it still reads stood down once the beat interval has passed — the same renderer `status`
    // uses, read at a later instant, so nothing here is true only in the millisecond after the call
    const later = supervisionText(readSupervision(repo, Date.now() + 3 * SUPERVISION_BEAT_MS));
    expect(later).toContain("overseer DISARMED");
    expect(later).not.toContain("overseer ARMED");
    // and arming again after a stand-down is not blocked by the marker left behind
    await beat(["overseer", "--seat", "OVSR-w1:p2"], repo);
    expect(supervisionLine(await status([], repo))).toContain("overseer ARMED");
  });

  test("a beat that cannot be written fails the command instead of announcing a tier it never armed", async () => {
    const repo = seedRepo(mkRepo());
    // Something occupying the beat path is the cheapest instance of the whole write-failure class
    // (permissions, a full disk, a vanished repo): `status` renders UNREADABLE for it. The verb must
    // not disagree with the surface — a swallowed failure would print `overseer ARMED` about state
    // that was never recorded, which is the same fail-open the tier exists to catch, one layer up.
    mkdirSync(supervisionBeatPath(repo, "overseer"), { recursive: true });

    await expect(beat(["overseer", "--seat", "OVSR-w1:p2"], repo)).rejects.toThrow();

    expect(supervisionLine(await status([], repo))).toContain("overseer UNREADABLE");
  });

  test("an unknown tier is refused with the usage line rather than writing a beat nobody reads", async () => {
    const repo = seedRepo(mkRepo());
    await expect(beat(["nonesuch"], repo)).rejects.toThrow(/orchestrator-context/);
    await expect(beat([], repo)).rejects.toThrow(/no tier/);
    expect(supervisionLine(await status([], repo))).toContain("overseer ABSENT");
  });

  test("test: the beat verb refuses a tier carrying no declared seat identity and writes no beat file; a beat that declares one makes status name that seat beside the tier's state; a record holding only the tier its one-shot process id and an instant leaves armed unattributable and fails", async () => {
    const refusedRepo = seedRepo(mkRepo());
    const refusedPath = supervisionBeatPath(refusedRepo, "overseer-context");

    await expect(beat(["overseer-context"], refusedRepo)).rejects.toThrow(/--seat <identity>/);
    expect(existsSync(refusedPath)).toBe(false);
    expect(supervisionLine(await status([], refusedRepo))).toContain("overseer-context ABSENT");

    const named = await beat(["overseer-context", "--seat", "OVSR-w1:p2"], refusedRepo);
    expect(named).toContain("ARMED as OVSR-w1:p2");
    expect(supervisionLine(await status([], refusedRepo)))
      .toContain("overseer-context ARMED (OVSR-w1:p2)");

    // The measured false-positive shape: tier + a one-shot pid + an instant cannot identify a seat.
    // Something does occupy the path, so the reader reports it as unreadable evidence rather than
    // claiming either ARMED coverage or that the tier was never armed.
    const legacyRepo = seedRepo(mkRepo());
    const legacyPath = supervisionBeatPath(legacyRepo, "orchestrator-context");
    mkdirSync(join(tickmarkrDir(legacyRepo), "supervision"), { recursive: true });
    writeFileSync(legacyPath, JSON.stringify({
      tier: "orchestrator-context", pid: 424242, beatAt: new Date().toISOString(),
    }) + "\n");
    const line = supervisionLine(await status([], legacyRepo));
    expect(line).toContain("orchestrator-context UNREADABLE");
    expect(line).not.toContain("orchestrator-context ARMED");
  });

  test("test: a beat issued from a subdirectory of a repository lands in that repository's root supervision file and a beat issued from a directory under no repository exits non-zero naming the missing state dir and creates no supervision tree whereas the shipped beat that writes relative to cwd and prints ARMED fails", async () => {
    const repo = seedRepo(mkRepo());
    const nested = join(repo, "packages", "worker", "src");
    mkdirSync(nested, { recursive: true });

    const armed = await beat(["overseer", "--seat", "OVSR-w1:p2"], nested);
    expect(armed).toContain("overseer ARMED");
    expect(existsSync(supervisionBeatPath(repo, "overseer"))).toBe(true);
    expect(existsSync(join(nested, ".tickmarkr", "supervision"))).toBe(false);

    const outside = mkRepo();
    const outsideChild = join(outside, "some", "directory");
    mkdirSync(outsideChild, { recursive: true });
    const refused = await dispatch("beat", ["overseer", "--seat", "OVSR-w1:p2"], {
      beat: (argv) => beat(argv, outsideChild),
    });
    expect(refused.code).toBe(1);
    expect(refused.out).toMatch(/missing \.tickmarkr\/ state dir/);
    expect(existsSync(join(outside, ".tickmarkr"))).toBe(false);
    expect(existsSync(join(outsideChild, ".tickmarkr", "supervision"))).toBe(false);
  });
});
