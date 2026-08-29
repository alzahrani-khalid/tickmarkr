import { type ChildProcess, spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test, vi } from "vitest";
import { status } from "../src/cli/commands/status.js";
import { saveGraph, tickmarkrDir } from "../src/graph/graph.js";
import { validateGraph } from "../src/graph/schema.js";
import {
  SUPERVISION_BEAT_MS,
  SUPERVISION_STALE_MS,
  supervisionBeatPath,
  supervisionStandDownPath,
  supervisionStatus,
} from "../src/run/supervision.js";

// SUP-05: the context watcher is the first SUPERVISED watcher this skill ships, and the tier it beats
// was born broken four ways — one shared tier for two seats, a beat on the poll cadence rather than the
// supervision one, an exit at warn that never reached the act, and a beat written after an EMPTY read.
// Every test below drives the REAL shipped script (the seat-send.test.ts idiom) against a fake `herdr`
// and a fake `tickmarkr` on PATH, and reads the result back through the REAL supervision reader and the
// REAL `status` surface — the defect is that the BOARD lies, so a test that asserted on the script's
// own stdout alone would prove nothing an operator sees.

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = join(ROOT, "skills/tickmarkr-overseer/scripts/watch-context.sh");
const TWIN = join(ROOT, ".claude/skills/tickmarkr-overseer/scripts/watch-context.sh");

/** The model banner is the statusline location that owns the context percentage. */
const MARKED = (pct: number) => `  claude-opus-5  ${pct}%  main*  ~/repo`;
const NO_PCT = "  claude-opus-5  main*  ~/repo  (no gauge rendered)";
/**
 * OBS-785: a REAL statusline, captured verbatim from a live seat on 2026-08-29, not composed here.
 * The invented `MARKED` format above is why the shipped selector could be green in tests and blind on
 * every real pane: it begins with the vendor id, while a real line begins with a GLYPH and names the
 * model "Opus 5". Three independent properties defeated the merged regex — the line-start anchor, the
 * missing `opus` alternative, and CASE. Keep this byte-exact; normalising it re-opens the hole.
 * It also carries `\u2211 1.2M tok` (cumulative SPEND) and `\u2b22 9/9` (a fleet counter), the two
 * fields OBS-780 records being misread as a context percentage.
 */
const REAL_CAPTURED_STATUSLINE =
  "  \u2733 Opus 5 (1M context) \u2502 \u2442 fix/obs-769-cross-run-pane-close \u2502 "
  + "\u23f8 parked 8/9 T9\u23f8 tip\u2713 \u2502 \u2211 1.2M tok \u2502 \u2b22 9/9 \u2502 \u2588\u2588\u258a\u2500\u2500\u2500\u2500\u2500 35% \u2502 \u25b8 tickmarkr";

const TRUNCATED_LIVE_RUN = `  claude-opus-5  live-run=${"task-routing-and-gate-status/".repeat(8)}`;

const seedRepo = (): string => {
  const repo = mkdtempSync(join(tmpdir(), "tickmarkr-watch-context-"));
  saveGraph(repo, validateGraph({
    version: 1, spec: { source: "prd", paths: ["p"], hash: "h" },
    tasks: [{ id: "T1", title: "a", goal: "a", shape: "implement", complexity: 3, acceptance: ["a"] }],
  }));
  const dir = join(tickmarkrDir(repo), "runs", "run-ctx");
  mkdirSync(dir, { recursive: true });
  writeFileSync(dir + "/journal.jsonl",
    JSON.stringify({ ts: new Date().toISOString(), event: "run-start", data: { pid: process.pid } }) + "\n");
  return repo;
};

interface Stub {
  dir: string;
  log: string;
  screen: string;
  /** Rewrite what every seat's statusline renders — the live seat changing under the watcher. */
  render: (line: string) => void;
}

/**
 * `herdr` renders whatever the screen file currently holds; `tickmarkr` records its invocation with a
 * millisecond stamp AND writes the record the product reader parses. The stub writes into the path the
 * PRODUCT computes (supervisionBeatPath), never a path of its own invention, and every assertion below
 * reads those bytes back through the product's reader — so a payload shape the reader would reject
 * fails these tests rather than passing them.
 */
function makeStub(repo: string, screenLine: string): Stub {
  const dir = mkdtempSync(join(tmpdir(), "tickmarkr-watch-context-bin-"));
  const log = join(dir, "calls.log");
  const screen = join(dir, "screen.txt");
  writeFileSync(log, "");
  writeFileSync(screen, screenLine + "\n");
  const beatDir = dirname(supervisionBeatPath(repo, "overseer-context"));

  const herdr = join(dir, "herdr");
  writeFileSync(herdr, `#!/usr/bin/env bash
echo "$(date +%s) $@" >> '${log}'
case "$1 $2" in
  "agent read") cat '${screen}' ;;
  *) echo '{}' ;;
esac
`);
  chmodSync(herdr, 0o755);

  const cli = join(dir, "tickmarkr");
  writeFileSync(cli, `#!${process.execPath}
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, Date.now() + " " + args.join(" ") + "\\n");
if (args[0] !== "beat") process.exit(0);
const tier = args[1];
const seat = args[args.indexOf("--seat") + 1];
// mirrors the real verb: no seat, no record (tests/cli/beat.test.ts owns that contract itself)
if (!tier || !args.includes("--seat") || !seat || seat.startsWith("--")) {
  console.error("beat: --seat <identity> required");
  process.exit(1);
}
const dir = ${JSON.stringify(beatDir)};
fs.mkdirSync(dir, { recursive: true });
const base = { tier, seat, pid: process.pid };
if (args.includes("--stand-down")) {
  fs.writeFileSync(dir + "/" + tier + ".standdown",
    JSON.stringify({ ...base, disarmedAt: new Date().toISOString() }) + "\\n");
} else {
  fs.rmSync(dir + "/" + tier + ".standdown", { force: true });
  fs.writeFileSync(dir + "/" + tier + ".beat",
    JSON.stringify({ ...base, beatAt: new Date().toISOString() }) + "\\n");
}
`);
  chmodSync(cli, 0o755);
  return { dir, log, screen, render: (line: string) => writeFileSync(screen, line + "\n") };
}

const live: ChildProcess[] = [];
afterEach(() => {
  for (const p of live.splice(0)) if (p.exitCode === null) p.kill("SIGKILL");
});
interface Watcher {
  proc: ChildProcess;
  out: () => string;
  exited: Promise<number | null>;
}

/** args: role target warn act handoff poll cap */
function watch(stub: Stub, repo: string, args: string[], env: NodeJS.ProcessEnv = {}): Watcher {
  const proc = spawn("bash", [SCRIPT, ...args], {
    cwd: repo,
    env: { ...process.env, ...env, PATH: `${stub.dir}:${process.env.PATH}` },
    stdio: ["ignore", "pipe", "pipe"],
  });
  live.push(proc);
  let out = "";
  proc.stdout?.on("data", (c) => { out += String(c); });
  proc.stderr?.on("data", (c) => { out += String(c); });
  const exited = new Promise<number | null>((res) => proc.on("exit", (code) => res(code)));
  return { proc, out: () => out, exited };
}

const calls = (stub: Stub): string[] => readFileSync(stub.log, "utf8").split("\n").filter(Boolean);
const beats = (stub: Stub, tier: string): number[] =>
  calls(stub)
    .filter((l) => new RegExp(`^\\d+ beat ${tier} --seat`).test(l) && !l.includes("--stand-down"))
    .map((l) => Number(l.split(" ")[0]));

const supervisionLine = (out: string): string => out.split("\n").find((l) => l.includes("supervision:"))!;

/** Age a record past the ceiling — the only way a stopped watcher's last beat reads STALE. */
const expire = (path: string) => {
  const dead = new Date(Date.now() - SUPERVISION_STALE_MS - 1_000);
  utimesSync(path, dead, dead);
};

describe("watch-context.sh supervision (SUP-05)", () => {
  test("test: status renders the surviving context watcher armed and the killed one stale in the same frame after exactly one of the two supervising seats has its watcher killed; one shared context tier whose surviving beats keep the dead seat's row armed fails", async () => {
    const repo = seedRepo();
    const stub = makeStub(repo, MARKED(20));
    const orch = watch(stub, repo, ["orchestrator", "ORCH-w1:p1", "60", "75", "", "1", "600"]);
    const ovsr = watch(stub, repo, ["overseer", "OVSR-w1:p2", "60", "75", "", "1", "600"]);

    // both seats' context is watched, and each tier is armed by ITS OWN watcher naming ITS OWN seat
    await vi.waitFor(() => {
      expect(supervisionStatus(repo, "orchestrator-context").state).toBe("ARMED");
      expect(supervisionStatus(repo, "overseer-context").state).toBe("ARMED");
    }, { timeout: 15_000, interval: 100 });

    // EXACTLY ONE of the two watchers dies, the way a seat's watcher actually dies: no stand-down, no
    // notice, nothing recorded — the survivor keeps beating right through it.
    orch.proc.kill("SIGKILL");
    await orch.exited;
    const dead = supervisionBeatPath(repo, "orchestrator-context");
    expect(existsSync(supervisionStandDownPath(repo, "orchestrator-context")))
      .toBe(false); // a killed watcher records nothing — STALE, never DISARMED
    expire(dead);
    const frozen = statSync(dead).mtimeMs;

    // ONE frame, both readings. A single shared `context` tier would have exactly one record here, and
    // the surviving seat's beats would land on it — rendering the dead seat's row ARMED.
    const line = supervisionLine(await status([], repo));
    expect(line).toContain("orchestrator-context STALE");
    expect(line).toMatch(/overseer-context ARMED \(OVSR-w1:p2\)/u);
    expect(line).not.toContain("orchestrator-context ARMED");

    // and the survivor keeps beating without ever touching the dead seat's record: two beats later the
    // dead row is byte-for-byte where it was, which is what a per-seat tier buys and a shared one cannot.
    const before = beats(stub, "overseer-context").length;
    await vi.waitFor(() => expect(beats(stub, "overseer-context").length).toBeGreaterThan(before + 1),
      { timeout: 15_000, interval: 100 });
    expect(statSync(dead).mtimeMs).toBe(frozen);
    expect(supervisionStatus(repo, "orchestrator-context").state).toBe("STALE");
    expect(supervisionStatus(repo, "overseer-context").state).toBe("ARMED");
    ovsr.proc.kill("SIGKILL");
  }, 60_000);

  test("test: every gap between consecutive beats a healthy context watcher writes stays inside the supervision beat interval even where its percentage poll interval is set far above that interval; a watcher beating once per poll leaves its tier stale for the remainder of every cycle and fails", async () => {
    const repo = seedRepo();
    const stub = makeStub(repo, MARKED(20));
    // The shipped default: a 120s poll, twelve times the supervision beat interval. Beating once per
    // poll would leave this tier STALE for 110 of every 120 seconds while the watcher was perfectly
    // healthy — the reading that sends a supervisor after a watcher that never stopped.
    const w = watch(stub, repo, ["overseer", "OVSR-w1:p2", "60", "75", "", "120", "600"]);
    await vi.waitFor(() => expect(beats(stub, "overseer-context").length).toBeGreaterThanOrEqual(3),
      { timeout: 45_000, interval: 200 });
    w.proc.kill("SIGKILL");

    const stamps = beats(stub, "overseer-context");
    const gaps = stamps.slice(1).map((t, i) => t - stamps[i]!);
    expect(gaps.length).toBeGreaterThanOrEqual(2);
    for (const gap of gaps) expect(gap).toBeLessThan(SUPERVISION_BEAT_MS);
    // and the poll cadence is not what produced them: one poll interval has not even elapsed yet
    expect(stamps[stamps.length - 1]! - stamps[0]!).toBeLessThan(120_000);
  }, 60_000);

  test("test: the percentage is read from a REAL captured statusline that begins with a glyph and names Opus, so a selector that is green against an invented banner cannot ship blind to every live seat", async () => {
    const repo = seedRepo();
    const handoff = join(repo, "HANDOFF.md");
    writeFileSync(handoff, "safe state\n");
    const stub = makeStub(repo, REAL_CAPTURED_STATUSLINE);
    const w = watch(stub, repo, ["overseer", "OVSR-w1:p2", "1", "1", handoff, "1", "600"]);

    // The whole defect was reporting UNREADABLE on a line a human reads at a glance.
    await vi.waitFor(() => expect(w.out()).toContain("CONTEXT_ACT"), { timeout: 20_000, interval: 100 });
    expect(w.out()).not.toContain("CONTEXT_UNREADABLE");
    // 35 is the gauge, not the 1.2M spend total and not the 9/9 fleet counter beside it.
    expect(w.out()).toContain("35%");
    w.proc.kill("SIGKILL");
  }, 30_000);

  test("test: a pane whose statusline carries no percentage field reports unreadable and orders nothing", async () => {
    const repo = seedRepo();
    const handoff = join(repo, "HANDOFF.md");
    writeFileSync(handoff, "safe state\n");
    const stub = makeStub(repo, NO_PCT);
    const w = watch(stub, repo, ["overseer", "OVSR-w1:p2", "1", "1", handoff, "1", "600"],
      { TKR_AUTO_CLEAR: "1", TKR_CLEAR_SETTLE_S: "0" });

    await vi.waitFor(() => expect(w.out()).toContain("CONTEXT_UNREADABLE"), { timeout: 20_000, interval: 100 });
    expect(w.out()).not.toContain("CONTEXT_WARN");
    expect(w.out()).not.toContain("CONTEXT_ACT");
    expect(calls(stub).filter((line) => line.includes("agent prompt"))).toEqual([]);
    expect(beats(stub, "overseer-context").length).toBeGreaterThan(0);
    w.proc.kill("SIGKILL");
  }, 30_000);

  test("test: a pane whose statusline carries no percentage field but whose scrollback contains an earlier percentage still reports unreadable, so a borrowed number cannot become a crossing", async () => {
    const repo = seedRepo();
    const handoff = join(repo, "HANDOFF.md");
    writeFileSync(handoff, "safe state\n");
    const stub = makeStub(repo, `earlier progress report: 91%\n${NO_PCT}`);
    const w = watch(stub, repo, ["overseer", "OVSR-w1:p2", "1", "1", handoff, "1", "600"],
      { TKR_AUTO_CLEAR: "1", TKR_CLEAR_SETTLE_S: "0" });

    await vi.waitFor(() => expect(w.out()).toContain("CONTEXT_UNREADABLE"), { timeout: 20_000, interval: 100 });
    expect(w.out()).not.toContain("CONTEXT_WARN");
    expect(w.out()).not.toContain("CONTEXT_ACT");
    expect(calls(stub).filter((line) => line.includes("agent prompt"))).toEqual([]);
    w.proc.kill("SIGKILL");
  }, 30_000);

  test("test: a statusline carrying a long live-run segment that pushes the percentage past the visible width reports unreadable rather than declining to beat, so the tier stops ageing to stale during exactly the work the watcher exists to cover", async () => {
    const repo = seedRepo();
    const stub = makeStub(repo, TRUNCATED_LIVE_RUN);
    const w = watch(stub, repo, ["overseer", "OVSR-w1:p2", "60", "75", "", "1", "600"]);

    await vi.waitFor(() => expect(w.out()).toContain("CONTEXT_UNREADABLE"), { timeout: 20_000, interval: 100 });
    expect(beats(stub, "overseer-context").length).toBeGreaterThan(0);
    expect(supervisionStatus(repo, "overseer-context").state).toBe("ARMED");
    expect(w.out()).not.toContain("CONTEXT_ACT");
    w.proc.kill("SIGKILL");
  }, 30_000);

  test("test: a percentage sequence rising through the warn threshold to the act threshold emits a warn line naming the file it will re-brief from and afterwards performs the act; a watcher exiting at warn never reaches the act and fails", async () => {
    const repo = seedRepo();
    const handoff = join(repo, "HANDOFF.md");
    writeFileSync(handoff, "everything this seat holds, on disk\n");
    const stub = makeStub(repo, MARKED(40));
    const w = watch(stub, repo, ["overseer", "OVSR-w1:p2", "60", "75", handoff, "1", "600"],
      { TKR_AUTO_CLEAR: "1", TKR_CLEAR_SETTLE_S: "0" });

    stub.render(MARKED(65)); // through the warn threshold
    await vi.waitFor(() => expect(w.out()).toContain("CONTEXT_WARN"), { timeout: 20_000, interval: 100 });
    expect(w.out()).toContain(handoff); // the warn names the file the act will re-brief from
    expect(w.proc.exitCode).toBeNull(); // the exit at warn is the defect: the act is on the far side

    stub.render(MARKED(80)); // on to the act threshold, which the shipped watcher never reached
    expect(await w.exited).toBe(0);
    expect(w.out()).toContain("CONTEXT_CLEARED");
    const prompts = calls(stub).filter((l) => l.includes("agent prompt"));
    expect(prompts.some((l) => l.includes("/clear"))).toBe(true);
    expect(prompts.some((l) => l.includes(handoff))).toBe(true); // re-briefed, not merely cleared
  }, 60_000);

  test("test: each of the context watcher's three terminal exits records a stand-down so status reads that tier disarmed rather than dead; an exit that only stops beating ages the tier to stale and fails", async () => {
    const fresh = (): string => {
      const repo = seedRepo();
      const handoff = join(repo, "HANDOFF.md");
      writeFileSync(handoff, "on disk\n");
      return repo;
    };

    // EXIT 1 — the act, with a fresh handoff: a clear is safe and the watcher's job is done.
    const actRepo = fresh();
    const actStub = makeStub(actRepo, MARKED(80));
    const act = watch(actStub, actRepo, ["overseer", "OVSR-w1:p2", "60", "75", join(actRepo, "HANDOFF.md"), "1", "600"]);
    expect(await act.exited).toBe(0);
    expect(act.out()).toContain("CONTEXT_ACT ");

    // EXIT 2 — the act with NO fresh handoff: it refuses to clear, and it is still leaving.
    const unsafeRepo = fresh();
    const unsafeStub = makeStub(unsafeRepo, MARKED(80));
    const unsafe = watch(unsafeStub, unsafeRepo, ["orchestrator", "ORCH-w1:p1", "60", "75", "", "1", "600"]);
    expect(await unsafe.exited).toBe(0);
    expect(unsafe.out()).toContain("CONTEXT_ACT_UNSAFE");

    // EXIT 3 — the cap: nothing crossed, the watch simply ran out.
    const capRepo = fresh();
    const capStub = makeStub(capRepo, MARKED(10));
    const cap = watch(capStub, capRepo, ["overseer", "OVSR-w1:p2", "60", "75", "", "1", "1"]);
    expect(await cap.exited).toBe(0);
    expect(cap.out()).toContain("WATCH_CAP_REACHED");

    for (const [repo, tier] of [
      [actRepo, "overseer-context"], [unsafeRepo, "orchestrator-context"], [capRepo, "overseer-context"],
    ] as const) {
      expect(existsSync(supervisionStandDownPath(repo, tier))).toBe(true);
      const line = supervisionLine(await status([], repo));
      expect(line).toContain(`${tier} DISARMED`);
      expect(line).not.toContain(`${tier} ARMED`);
      // and it STAYS a hand-off rather than ageing into a death once the ceiling passes
      expect(supervisionStatus(repo, tier, Date.now() + SUPERVISION_STALE_MS + 1_000).state).toBe("DISARMED");
    }
  }, 90_000);

  test("the diff anchors the percentage read to the model banner rather than widening a bare numeric pattern, and leaves both copies of the script byte-identical", () => {
    const shipped = readFileSync(SCRIPT);
    const source = shipped.toString("utf8");
    expect(shipped.byteLength).toBeGreaterThan(0);
    expect(source).toContain("banner=$(printf '%s\\n' \"$screen\"");
    expect(source).toContain("\"$banner\" | grep -oE '[0-9]+%'");
    expect(source).not.toContain("\"$screen\" | grep -oE '[0-9]+%'");
    // OBS-793: the `.claude/` twin is a PRIVATE-TREE convenience that the export deliberately
    // excludes (`scripts/export-public.sh`, `:(exclude).claude`), so it does not exist in the shipped
    // tree, in the public repository, or in any consumer checkout. Assert byte-identity wherever the
    // twin IS present — which is every seat that edits either copy — and skip where it cannot be.
    // An UNGUARDED read passes here and throws ENOENT in the shipped tree: v2.1.7's first public CI
    // run failed on exactly this line, on BOTH ubuntu and macos, while the private suite was green.
    if (existsSync(TWIN)) expect(readFileSync(TWIN)).toEqual(shipped);
  });
});
