import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync, readFileSync, renameSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test, vi } from "vitest";
import { status } from "../../src/cli/commands/status.js";
import { saveGraph } from "../../src/graph/graph.js";
import { validateGraph } from "../../src/graph/schema.js";
import {
  SUPERVISION_STALE_MS,
  SUPERVISION_TIERS,
  armSupervision,
  readSupervision,
  supervisionBeatPath,
  supervisionStandDownPath,
  supervisionStatus,
  supervisionText,
  type TierLiveness,
} from "../../src/run/supervision.js";

// T7: `status --watch` IS the `watch` tier. Nothing else in the harness can beat it, so before this
// the board rendered ABSENT about itself forever — one of five states, in every frame ever drawn, and
// a word that can only take one value is a word every reader learns to skip.
//
// The two directions are asserted by DIFFERENT instruments on purpose:
//   life  — the board's own first printed frame, plus an independent read of the record on disk;
//   death — the record STOPPING, in real time, at an arming interval this fixture chooses.
// The death direction may NOT be asserted by moving a reader's clock past the staleness ceiling: that
// forces the aged state whether or not beating stopped, so a one-shot beat, a live board and a LEAKED
// interval are all indistinguishable to it. A leaked interval is the dangerous shape here — it makes a
// dead board read ARMED, which is the over-claiming direction, the one an operator acts on.

const mkRepo = (tag: string) => mkdtempSync(join(tmpdir(), `tickmarkr-${tag}-`));

const seed = (repo: string) => {
  saveGraph(repo, validateGraph({
    version: 1,
    spec: { source: "prd", paths: ["p"], hash: "h" },
    tasks: [{ id: "T1", title: "a", goal: "a", shape: "implement", complexity: 3, acceptance: ["a"] }],
  }));
  return repo;
};

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * A real board redraws forever; the suite's own reporter shares this stdout. One spy per test, and
 * never one per board — a second board's restore would hand the stream back mid-run.
 *
 * It CAPTURES rather than discards, because the board's own printed bytes are the only evidence for
 * the first criterion. A test that rebuilds the line from a record it read itself is not reading the
 * frame: arming moved to after the first print would leave such a test green and the operator's
 * screenshot still saying ABSENT.
 */
const pane = () => {
  const printed: string[] = [];
  const spy = vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
    printed.push(typeof chunk === "string" ? chunk : String(chunk));
    return true;
  });
  // Title escapes and clear codes are writes too; a FRAME is a write carrying the supervision row.
  return { frames: () => printed.filter((c) => c.includes("supervision:")), restore: () => spy.mockRestore() };
};

/**
 * A LIVE board: the unbounded loop an operator actually runs, never the bounded reader the rest of the
 * suite drives. Its `sleep` is the seam the host aborts through — `kill()` ends the board the way
 * closing a pane does, from outside its own loop.
 */
const openBoard = (repo: string, supervisionBeatMs: number, frameMs = 40) => {
  let killed = false;
  let drew!: () => void;
  // `sleep` runs only AFTER a frame has been written, and arming runs before the loop — so this
  // resolving is proof that THIS board is armed, which a shared beat file's existence is not.
  const firstFrame = new Promise<void>((resolve) => { drew = resolve; });
  const closed = status(["--watch"], repo, {
    supervisionBeatMs,
    sleep: async () => {
      drew();
      if (killed) throw new Error("board closed");
      await delay(frameMs);
      if (killed) throw new Error("board closed");
    },
  }).catch(() => undefined);
  return {
    kill: async () => { killed = true; await closed; },
    drawn: () => firstFrame,
    /** Resolves once the board has written its first beat — the record, not a promise about it. */
    beating: async () => {
      for (let i = 0; i < 200 && !existsSync(supervisionBeatPath(repo, "watch")); i++) await delay(10);
      return statSync(supervisionBeatPath(repo, "watch")).mtimeMs;
    },
  };
};

/** A REAL board process, so SIGKILL means what it means: no finally, no stand-down, nothing recorded. */
const spawnBoard = async (repo: string): Promise<ChildProcess> => {
  // repo root via import.meta, never process.cwd(): this suite only ever touches its mkdtemp fixtures.
  const root = fileURLToPath(new URL("../..", import.meta.url));
  const child = spawn(
    process.execPath,
    ["--import", join(root, "node_modules", "tsx", "dist", "loader.mjs"), join(root, "src", "cli", "index.ts"), "status", "--watch"],
    { cwd: repo, stdio: "ignore" },
  );
  await once(child, "spawn");
  return child;
};

const wideBoard = () => {
  // 120 columns wraps the supervision legend mid-`watch ARMED`; the assertion is about what the row
  // SAYS, not about the width at which it folds, so the fixture picks a terminal that fits it.
  const columns = Object.getOwnPropertyDescriptor(process.stdout, "columns");
  Object.defineProperty(process.stdout, "columns", { configurable: true, value: 200 });
  return () => {
    if (columns) Object.defineProperty(process.stdout, "columns", columns);
    else delete (process.stdout as { columns?: number }).columns;
  };
};

const tierOf = (tiers: readonly TierLiveness[], tier: string) => tiers.find((t) => t.tier === tier)!;

describe("SUP-06 the live board reports its own tier", () => {
  const cleanup: (() => Promise<void> | void)[] = [];
  afterEach(async () => {
    for (const stop of cleanup.splice(0)) await stop();
  });

  test("test: a live board's own first printed frame renders its tier armed while the tiers nothing beats render absent in that same frame, and an independent reader of the record agrees; a surface arming every tier the moment a board opens fails", async () => {
    const repo = seed(mkRepo("board-arms"));
    const restore = wideBoard();
    const printed = pane();
    // The board is aborted through its FIRST sleep, so it prints exactly one frame — and that frame is
    // frame one, not a later one that a late arming would also have reached. Read the record from the
    // same seam: between frame one and frame two the board is live, which is the only moment at which
    // "this board's tier is armed" is a claim about anything.
    let live: TierLiveness[] | undefined;
    let beats: string[] | undefined;
    try {
      await status(["--watch"], repo, {
        sleep: async () => {
          live = readSupervision(repo);
          beats = SUPERVISION_TIERS.filter((t) => existsSync(supervisionBeatPath(repo, t)));
          throw new Error("board closed");
        },
      }).catch(() => undefined);
    } finally { printed.restore(); restore(); }

    // THE BOARD'S OWN BYTES — what the operator screenshotted, never a line this test rebuilt after
    // the fact. Exactly one frame was drawn, and it is the first, so arming one interval late (or any
    // time after this print) leaves this assertion looking at `watch ABSENT`.
    const frames = printed.frames();
    expect(frames).toHaveLength(1);
    expect(frames[0]).toContain("watch ARMED");
    // ...while every tier nothing beats says ABSENT in that same frame: a surface that armed every
    // tier the moment a board opened would print five ARMED rows here.
    for (const tier of SUPERVISION_TIERS.filter((t) => t !== "watch")) {
      expect(frames[0]).toContain(`${tier} ABSENT`);
    }

    // And an INDEPENDENT reader of the record on disk agrees with the frame, tier by tier — the board
    // wrote one record, its own, so a surface arming everything would leave five here too.
    expect(beats).toEqual(["watch"]);
    expect(tierOf(live!, "watch").state).toBe("ARMED");
    for (const tier of SUPERVISION_TIERS.filter((t) => t !== "watch")) {
      expect(tierOf(live!, tier).state).toBe("ABSENT");
    }
    expect(supervisionText(live!)).toContain("watch ARMED");
  });

  // The stand-down marker speaks for the TIER, and boards overlap the moment an operator opens a
  // second pane. A first-one-out marker would render the surviving board's own tier DISARMED — a live
  // board reporting itself down, which is the same lie in the other direction.
  test("a second live board keeps the tier armed when the first board closes, and the last board out is the one that records the stand-down", async () => {
    const repo = seed(mkRepo("board-overlap"));
    const printed = pane();
    cleanup.push(() => printed.restore());
    // An arming interval far longer than this test: nothing here can be rescued by a later beat, so
    // ARMED below can only come from the closing board withholding a marker it must not write.
    const first = openBoard(repo, 60_000);
    const second = openBoard(repo, 60_000);
    cleanup.push(() => second.kill());
    await first.drawn();
    await second.drawn();

    await first.kill(); // a CLEAN close — the path that records a hand-off
    expect(supervisionStatus(repo, "watch").state).toBe("ARMED");
    expect(existsSync(supervisionStandDownPath(repo, "watch"))).toBe(false);

    await second.kill();
    expect(supervisionStatus(repo, "watch").state).toBe("DISARMED");
  });

  test("a last-out stand-down survives an older foreign beat after that beat loses freshness", () => {
    const repo = seed(mkRepo("board-overlap-last-beater-first"));
    // Synchronous arming fixes the record order: B owns the last beat, then closes before A. A is the
    // last watcher out and therefore publishes the valid tier-wide hand-off with its own arm id.
    const first = armSupervision(repo, "watch", 60_000);
    const second = armSupervision(repo, "watch", 60_000);
    second.disarm();
    expect(existsSync(supervisionStandDownPath(repo, "watch"))).toBe(false);
    first.disarm();
    expect(existsSync(supervisionStandDownPath(repo, "watch"))).toBe(true);

    const lastBeat = statSync(supervisionBeatPath(repo, "watch")).mtimeMs;
    // While B's differing-id beat is fresh it still fences the arming-vs-rename race. It cannot do so
    // forever: once stale, A's newer clean stand-down is the final record and must read DISARMED.
    expect(supervisionStatus(repo, "watch", lastBeat + SUPERVISION_STALE_MS).state).toBe("ARMED");
    expect(supervisionStatus(repo, "watch", lastBeat + SUPERVISION_STALE_MS + 1).state).toBe("DISARMED");
  });

  test("a stand-down already in flight cannot mask a board that arms between the peer check and rename", () => {
    const repo = seed(mkRepo("board-arm-disarm-race"));
    const marker = supervisionStandDownPath(repo, "watch");

    // Save the first board's valid marker, then replay its atomic publication AFTER the second board
    // has armed. This is the deterministic filesystem order of the old TOCTOU: A checked no peer,
    // B published beat + presence, then A's already-prepared rename landed last.
    const first = armSupervision(repo, "watch", 60_000);
    first.disarm();
    const olderBoardMarker = readFileSync(marker, "utf8");
    const second = armSupervision(repo, "watch", 60_000);
    try {
      const tmp = `${marker}.interleaving.tmp`;
      writeFileSync(tmp, olderBoardMarker);
      renameSync(tmp, marker);

      // Timestamp ordering alone says DISARMED here. While its beat is fresh, the armed-watcher fence
      // says whose marker this is, so the newer board remains ARMED. Do not move only the reader's
      // clock past the ceiling here: that would declare the live board's beat stale without allowing
      // its interval to publish the later-timestamp beat that permanently outranks this old marker.
      expect(supervisionStatus(repo, "watch").state).toBe("ARMED");
    } finally {
      second.disarm();
    }
  });

  test("test: the record a killed board leaves stops advancing across a real span of several arming intervals while a live board's advances across the same span; a case reading the state at a reader's clock moved past the ceiling reports the aged state for a leaked timer too and fails", async () => {
    const beatMs = 100; // the arming interval is the FIXTURE's choice, not the shipped ten seconds
    const dead = seed(mkRepo("board-dead"));
    const alive = seed(mkRepo("board-alive"));

    const printed = pane();
    cleanup.push(() => printed.restore());
    const killedBoard = openBoard(dead, beatMs);
    const liveBoard = openBoard(alive, beatMs);
    cleanup.push(() => liveBoard.kill());
    await killedBoard.beating();
    const liveAtStart = await liveBoard.beating();
    await killedBoard.kill();
    // Stamped AFTER the close, so it is the record AS IT STANDS at death — reading it before the kill
    // would race the board's own next beat and fail a correct implementation.
    const deadAtDeath = statSync(supervisionBeatPath(dead, "watch")).mtimeMs;

    // A REAL span of several arming intervals — no injected clock anywhere. The reader's `now` is left
    // alone precisely because moving it past the ceiling ages the record for a leaked interval too.
    await delay(beatMs * 7);

    // The dead board's record is the same bytes at the same instant it stopped: a leaked interval in a
    // host that outlived the board would still be writing here, and this is where that is caught.
    expect(statSync(supervisionBeatPath(dead, "watch")).mtimeMs).toBe(deadAtDeath);
    expect(statSync(supervisionBeatPath(alive, "watch")).mtimeMs).toBeGreaterThan(liveAtStart);
  }, 20_000);

  test("test: a killed board's tier reads armed-then-lost carrying an age; a tier nothing ever armed reads never-armed carrying none; a reader folding the two into one word loses the distinction the tier exists to make: it fails", async () => {
    const repo = seed(mkRepo("board-killed"));
    const child = await spawnBoard(repo);
    for (let i = 0; i < 400 && !existsSync(supervisionBeatPath(repo, "watch")); i++) await delay(25);
    expect(existsSync(supervisionBeatPath(repo, "watch"))).toBe(true);
    child.kill("SIGKILL");
    await once(child, "exit");
    // SIGKILL records nothing: this is a death, not a hand-off, and DISARMED would be the wrong word.
    expect(existsSync(supervisionStandDownPath(repo, "watch"))).toBe(false);
    const aged = new Date(Date.now() - SUPERVISION_STALE_MS - 1_000);
    utimesSync(supervisionBeatPath(repo, "watch"), aged, aged);

    const lost = supervisionStatus(repo, "watch");
    const never = supervisionStatus(repo, "overseer");

    expect(lost.state).toBe("STALE");
    expect(lost.beatAgeMs).toBeGreaterThan(SUPERVISION_STALE_MS);
    expect(never.state).toBe("ABSENT");
    expect(never.beatAgeMs).toBeUndefined();
    // The distinction survives the fold into words as well as into fields: a reader that answered one
    // word for both would send nobody to look at the seat that died, or send everybody to a seat that
    // was never staffed.
    expect(lost.state).not.toBe(never.state);
    expect(supervisionText([lost, never])).toBe("supervision: watch STALE · overseer ABSENT");
  }, 30_000);
});
