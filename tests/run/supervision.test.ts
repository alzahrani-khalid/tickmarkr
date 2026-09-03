import * as cp from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { beat } from "../../src/cli/commands/beat.js";
import { tickmarkrDir } from "../../src/graph/graph.js";
import {
  SUPERVISION_BEAT_MS,
  SUPERVISION_STALE_MS,
  SUPERVISION_TIERS,
  armSupervision,
  beatSupervision,
  readSupervision,
  readTierLiveness,
  supervisionBeatPath,
  supervisionStatus,
  supervisionText,
} from "../../src/run/supervision.js";

// SUP-02 tripwire, hoisted over the WHOLE module graph this file imports — supervision.ts included.
// Every way node has of listing or naming processes goes through node:child_process, so a future
// `spawnSync("pgrep", …)` or `execSync("ps -o args= …")` inside the derivation throws here instead of
// passing. Spying on process.kill alone could not see any of these, which is why they are stubbed
// rather than merely asserted about.
vi.mock("node:child_process", () => {
  const forbid = (fn: string) => (...args: unknown[]) => {
    throw new Error(`supervision ran ${fn}(${String(args[0])}) — a process-list/process-name probe`);
  };
  const mocked = {
    spawn: forbid("spawn"), spawnSync: forbid("spawnSync"),
    exec: forbid("exec"), execSync: forbid("execSync"),
    execFile: forbid("execFile"), execFileSync: forbid("execFileSync"),
    fork: forbid("fork"),
  };
  return { ...mocked, default: mocked };
});

// SUP-01/SUP-02. The failure of this instrument is SILENCE, so a clean run establishes nothing:
// every state below is produced deliberately. ABSENT is reached by writing nothing at all, STALE by
// backdating a real record past the real ceiling, ARMED by beating and reading with the real clock.

const mkRepo = () => mkdtempSync(join(tmpdir(), "tickmarkr-supervision-"));

/** Age a tier's existing record past the ceiling — the ONLY way a live watcher goes STALE. */
const expireBeat = (repo: string, tier: (typeof SUPERVISION_TIERS)[number]) => {
  const dead = new Date(Date.now() - SUPERVISION_STALE_MS - 1_000);
  utimesSync(supervisionBeatPath(repo, tier), dead, dead);
};

/** A beat written by hand so its payload can contradict its file state (SUP-02 discriminator). */
const writeBeat = (repo: string, tier: (typeof SUPERVISION_TIERS)[number], payload: string) => {
  const p = supervisionBeatPath(repo, tier);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, payload);
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("supervision tier liveness", () => {
  test("test: a tier with a heartbeat written inside the staleness ceiling reads ARMED, and the same tier reads STALE once that ceiling has passed without another beat", () => {
    const repo = mkRepo();
    beatSupervision(repo, "orchestrator", "ORCH-w1:p1");

    // fresh, real clock
    const fresh = readTierLiveness(repo, "orchestrator");
    expect(fresh.state).toBe("ARMED");
    expect(fresh.beatAgeMs).toBeLessThan(SUPERVISION_STALE_MS);

    // The far edge of the ceiling is still inside it — the boundary is not off by one beat. The beat
    // time is PINNED into the record's mtime and both reads are taken against that one number: no
    // second clock reading can slip a millisecond between them and flake this assertion.
    const beatAt = 1_700_000_000_000;
    utimesSync(supervisionBeatPath(repo, "orchestrator"), new Date(beatAt), new Date(beatAt));
    expect(readTierLiveness(repo, "orchestrator", beatAt + SUPERVISION_STALE_MS).state).toBe("ARMED");
    expect(readTierLiveness(repo, "orchestrator", beatAt + SUPERVISION_STALE_MS + 1).state).toBe("STALE");

    // the ceiling passes with no further beat: same tier, same file, real clock
    expireBeat(repo, "orchestrator");
    const died = readTierLiveness(repo, "orchestrator");
    expect(died.state).toBe("STALE");
    expect(died.beatAgeMs).toBeGreaterThan(SUPERVISION_STALE_MS);

    // and a beat brings the same tier back — STALE is a reading, not a latch
    beatSupervision(repo, "orchestrator", "ORCH-w1:p1");
    expect(readTierLiveness(repo, "orchestrator").state).toBe("ARMED");
  });

  test("test: a tier that never wrote a heartbeat reads ABSENT, and ABSENT is a distinct value from STALE rather than sharing its rendering or its code path", () => {
    const repo = mkRepo();

    // reachable with nothing written at all — not even the directory that would hold a record
    const absent = readTierLiveness(repo, "overseer");
    expect(absent.state).toBe("ABSENT");
    expect(existsSync(join(tickmarkrDir(repo), "supervision"))).toBe(false); // the reader created nothing

    // ABSENT carries no age; STALE always carries one — the two do not share a shape
    expect(absent.beatAgeMs).toBeUndefined();
    beatSupervision(repo, "overseer", "OVSR-w1:p2");
    expireBeat(repo, "overseer");
    const stale = readTierLiveness(repo, "overseer");
    expect(stale.state).toBe("STALE");
    expect(stale.beatAgeMs).toBeGreaterThan(SUPERVISION_STALE_MS);
    expect(stale.state).not.toBe(absent.state);

    // distinct RENDERING too, not merely a distinct value in the object
    expect(supervisionText([absent])).toContain("overseer ABSENT");
    expect(supervisionText([stale])).toContain("overseer STALE");
    expect(supervisionText([absent])).not.toBe(supervisionText([stale]));

    // a repo that does not exist at all is still ABSENT rather than an error or a healthy default
    expect(readTierLiveness(join(repo, "no-such-repo"), "watch").state).toBe("ABSENT");
  });

  test("a record that exists but yields no beat reads UNREADABLE — neither never-armed nor healthy", () => {
    const repo = mkRepo();

    // A DIRECTORY at the beat path stats fine and is not a heartbeat. Calling it ARMED would make any
    // stat-able inode a live watcher.
    mkdirSync(supervisionBeatPath(repo, "watch"), { recursive: true });
    expect(readTierLiveness(repo, "watch").state).toBe("UNREADABLE");
    expect(readTierLiveness(repo, "watch").beatAgeMs).toBeUndefined();

    // A stat that FAILS for any reason other than "nothing is there" is likewise not evidence that the
    // tier never armed (ENAMETOOLONG here; EACCES and EIO take the same branch).
    expect(readTierLiveness(join(repo, "x".repeat(300)), "overseer").state).toBe("UNREADABLE");

    // four distinct readings, four distinct renderings — no state is folded into another
    const states = ["ABSENT", "STALE", "ARMED", "UNREADABLE"] as const;
    const rendered = states.map((state) => supervisionText([{ tier: "watch", state }]));
    expect(new Set(rendered).size).toBe(states.length);
  });

  test("test: the derivation reads only files and never consults a process list or matches a process name", () => {
    const repo = mkRepo();
    // kill(pid,0) is the cheapest process-table probe there is; it must never fire.
    const kill = vi.spyOn(process, "kill").mockImplementation(() => {
      throw new Error("supervision consulted the process table");
    });

    // Both records name a pid that CONTRADICTS their file state. A derivation that consulted the
    // process table would answer these the other way round; the file state decides both.
    const nonexistent = 999_999_999; // above every platform's pid_max — no such process, ever
    writeBeat(repo, "watch", JSON.stringify({ tier: "watch", pid: nonexistent }));
    writeBeat(repo, "overseer", JSON.stringify({ tier: "overseer", seat: "OVSR-w1:p2", pid: process.pid }));
    expireBeat(repo, "overseer");

    expect(readTierLiveness(repo, "watch").state).toBe("ARMED"); // dead pid, fresh beat
    expect(readTierLiveness(repo, "overseer").state).toBe("STALE"); // live pid, expired beat

    // There is no name in the record to match against an argv, and an unreadable payload is still a
    // beat: the state survives bytes no process-name matcher could parse.
    writeBeat(repo, "watch", "not json at all — grep would find nothing here\n");
    expect(readTierLiveness(repo, "watch").state).toBe("ARMED");

    expect(kill).not.toHaveBeenCalled();
    // and the hoisted node:child_process tripwire above never fired — no ps, no pgrep, no argv match
    for (const fn of ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"] as const) {
      expect(() => (cp[fn] as (...a: unknown[]) => unknown)("ps")).toThrow(/process-list/); // the stub IS armed
    }
  });

  test("the staleness ceiling is a multiple of the beat interval and both are named constants, cited from the changed lines", () => {
    expect(SUPERVISION_BEAT_MS).toBeGreaterThan(0);
    expect(SUPERVISION_STALE_MS % SUPERVISION_BEAT_MS).toBe(0);
    expect(SUPERVISION_STALE_MS / SUPERVISION_BEAT_MS).toBe(6); // lock.ts's ratio: five beats may be missed
  });

  test("armSupervision is the watcher-owned loop the beat interval drives, and expiry starts when it stops", async () => {
    const repo = mkRepo();
    const beat = supervisionBeatPath(repo, "overseer");
    // Production writer, production loop — only the interval is compressed so the test is not slow.
    const armed = armSupervision(repo, "overseer", 20, "OVSR-w1:p2");
    try {
      expect(readTierLiveness(repo, "overseer").state).toBe("ARMED"); // armed at instant zero, not one interval later
      const first = readFileSync(beat, "utf8");
      // the loop re-beats on its own: a second payload lands with nobody touching the file by hand
      await vi.waitFor(() => expect(readFileSync(beat, "utf8")).not.toBe(first), { timeout: 2_000, interval: 10 });
    } finally {
      armed.disarm();
    }

    // Nothing beats after the watcher stops: the SAME record it last wrote ages out past the real
    // ceiling and reads STALE — armed-then-died, told apart from never-armed by the record's presence.
    const last = statSync(beat).mtimeMs;
    expect(readTierLiveness(repo, "overseer", last + SUPERVISION_STALE_MS).state).toBe("ARMED");
    expect(readTierLiveness(repo, "overseer", last + SUPERVISION_STALE_MS + 1).state).toBe("STALE");
    expect(readTierLiveness(repo, "watch").state).toBe("ABSENT"); // an unarmed tier stayed unarmed
  });

  test("test: an obligation recorded at a threshold crossing survives a stand-down written after it, so firing the alarm cannot clear the duty the alarm raised", async () => {
    const repo = mkRepo();
    tickmarkrDir(repo); // the CLI writer now requires pre-existing repository state
    await beat([
      "overseer-context", "--seat", "OVSR-w1:p2", "--arm-id", "arm-before-clear",
      "--pct", "55", "--threshold-pct", "50",
    ], repo);
    const raised = supervisionStatus(repo, "overseer-context");
    expect(raised.clearOwedSince).toMatch(/^\d{4}-\d{2}-\d{2}T/u);

    await beat(["overseer-context", "--seat", "OVSR-w1:p2", "--stand-down"], repo);
    expect(supervisionStatus(repo, "overseer-context")).toMatchObject({
      state: "DISARMED",
      clearOwedSince: raised.clearOwedSince,
    });
  });

  test("test: a beat carrying a new arm identity below the threshold discharges the obligation; a beat reusing the previous arm identity does not", () => {
    const repo = mkRepo();
    beatSupervision(repo, "overseer-context", "OVSR-w1:p2", {
      armId: "arm-before-clear", pct: 55, thresholdPct: 50,
    });
    const owedSince = supervisionStatus(repo, "overseer-context").clearOwedSince;

    beatSupervision(repo, "overseer-context", "OVSR-w1:p2", {
      armId: "arm-before-clear", pct: 3, thresholdPct: 50,
    });
    expect(supervisionStatus(repo, "overseer-context").clearOwedSince).toBe(owedSince);

    // A replacement firing at its own lower threshold inherits the latch instead of clearing it just
    // because its reading is below the old threshold. It cannot discharge its own duty afterward.
    beatSupervision(repo, "overseer-context", "OVSR-w1:p2", {
      armId: "firing-replacement", pct: 45, thresholdPct: 40,
    });
    expect(supervisionStatus(repo, "overseer-context").clearOwedSince).toBe(owedSince);

    beatSupervision(repo, "overseer-context", "OVSR-w1:p2", {
      armId: "firing-replacement", pct: 3, thresholdPct: 40,
    });
    expect(supervisionStatus(repo, "overseer-context").clearOwedSince).toBe(owedSince);

    beatSupervision(repo, "overseer-context", "OVSR-w1:p2", {
      armId: "cleared-replacement", pct: 3, thresholdPct: 40,
    });
    expect(supervisionStatus(repo, "overseer-context").clearOwedSince).toBeUndefined();
  });

  test("readSupervision returns every known tier in the declared order, beaten or not", () => {
    const repo = mkRepo();
    beatSupervision(repo, "watch");
    const all = readSupervision(repo);
    expect(all.map((t) => t.tier)).toEqual([...SUPERVISION_TIERS]);
    expect(all.filter((t) => t.state === "ABSENT")).toHaveLength(SUPERVISION_TIERS.length - 1);
    expect(all.find((t) => t.tier === "watch")?.state).toBe("ARMED");
  });

  test("test: a record naming no seat on either supervising tier reads as unreadable evidence while the same record naming one reads armed for that seat; a reader accepting an anonymous record on those tiers reports coverage no seat is providing and fails", () => {
    const repo = mkRepo();
    for (const [tier, seat] of [["orchestrator", "ORCH-w1:p1"], ["overseer", "OVSR-w1:p2"]] as const) {
      writeBeat(repo, tier, JSON.stringify({ tier, pid: 424242, beatAt: new Date().toISOString() }) + "\n");
      const anonymous = readTierLiveness(repo, tier);
      expect(anonymous.state, tier).toBe("UNREADABLE");
      expect(anonymous.seat, tier).toBeUndefined();

      writeBeat(repo, tier, JSON.stringify({ tier, seat, pid: 424242, beatAt: new Date().toISOString() }) + "\n");
      expect(readTierLiveness(repo, tier)).toMatchObject({ tier, state: "ARMED", seat });
    }
  });

  test("test: an attempt to write a supervising tier's beat without a seat identity is refused before anything is written so the tier is left exactly as it was found; a writer recording an anonymous beat there re-opens the hole the reader just closed and fails", () => {
    const repo = mkRepo();
    for (const [tier, seat] of [["orchestrator", "ORCH-w1:p1"], ["overseer", "OVSR-w1:p2"]] as const) {
      beatSupervision(repo, tier, seat);
      const path = supervisionBeatPath(repo, tier);
      const before = readFileSync(path);
      const beforeStat = statSync(path);

      expect(() => beatSupervision(repo, tier)).toThrow(/seat identity/);

      expect(readFileSync(path)).toEqual(before);
      expect(statSync(path).mtimeMs).toBe(beforeStat.mtimeMs);
      expect(readTierLiveness(repo, tier)).toMatchObject({ tier, state: "ARMED", seat });
    }
  });
});
