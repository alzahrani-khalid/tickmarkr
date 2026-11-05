import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { claudeCode, CLAUDE_TRUST_DIALOG, CLAUDE_TRUST_OPTION_ROWS } from "../../src/adapters/claude-code.js";
import { CODEX_TRUST_DIALOG } from "../../src/adapters/codex.js";
import {
  CLAUDE_TRUST_PANE, matchesTrustDialog, shq, type CapturedTrustDialog, type InteractiveSeed, type TrustDialog, type WorkerAdapter,
} from "../../src/adapters/types.js";
import { HerdrDriver } from "../../src/drivers/herdr.js";
import { HcUnavailableError, HerdrAppDriver, OWNER_LABEL } from "../../src/drivers/herdr-app.js";
import { OrcaDriver } from "../../src/drivers/orca.js";
import { SubprocessDriver } from "../../src/drivers/subprocess.js";
import { formatOwnedName, type ExecutorDriver, type Slot } from "../../src/drivers/types.js";
import { resetGateCpuAccountantFactoryForTests, runViaDriver, setGateCpuAccountantFactoryForTests, verdictNonceLine } from "../../src/gates/llm.js";
import {
  resetAttemptHardTimeoutMsForTests, resetWorkerStartupWindowMsForTests, runDaemon, setAttemptHardTimeoutMsForTests, setWorkerStartupWindowMsForTests,
} from "../../src/run/daemon.js";
import { runInteractiveSeed, SeedReadinessError } from "../../src/run/interactive-seed.js";
import { Journal } from "../../src/run/journal.js";
import { answerTrustDialog, claudeTrustSelection, type TrustAnswer } from "../../src/run/trust-dialog.js";
import { FakeHerdrApp, type FakeRule, type FakeTerm } from "../helpers/fake-herdr-app.js";
import { cursorModalExec, FakeOrca } from "../helpers/fake-orca.js";
import { makeRepo, makeTestTempDir, reapTestTempDirs, setupRepo, T } from "../helpers/tmprepo.js";

// Queue row 342; D-2180 — contract C. Claude Code 2.1.318's workspace-trust dialog defaults to "No, exit", so a bare
// Enter exits the seat. Every frame here is OBSERVER's verbatim hc capture (tests/fixtures/claude-trust, the public
// copy of specs/v2.20.0-claude-trust-captures.json) or one of that artifact's explicitly derived frames; no terminal
// text is invented. Every hc/herdr/orca is a fake reached by explicit path.

afterAll(() => reapTestTempDirs());

const ARTIFACT_URL = new URL("../fixtures/claude-trust/captures.json", import.meta.url);
const SPEC_ARTIFACT = new URL("../../specs/v2.20.0-claude-trust-captures.json", import.meta.url);
const ARTIFACT = JSON.parse(readFileSync(ARTIFACT_URL, "utf8")) as {
  files: Record<string, string>;
  duplicateControl: { files: string[]; identical: boolean };
  derivedFrames: Record<"stacked_mcp" | "prose_only_question" | "after_down_nbsp", { text: string }>;
};
const screenOf = (file: string): string => (JSON.parse(ARTIFACT.files[file]!) as { text: string }).text;
const BEFORE = screenOf("02-read-dialog.json");
const AFTER = screenOf("04-read-after-down.json");
const MCP = screenOf("not-trust-mcp-dialog/02-read-dialog.json");
const STACKED = ARTIFACT.derivedFrames.stacked_mcp.text;
const PROSE = ARTIFACT.derivedFrames.prose_only_question.text;
const NBSP = ARTIFACT.derivedFrames.after_down_nbsp.text;
/** The captured `hc keys` answer (03-keys-down.json), served verbatim for every scripted key. */
const KEYS_OK = ARTIFACT.files["03-keys-down.json"]!;
// Test-only selection controls, each one edit of a captured frame: the two option rows in swapped order.
const SWAPPED = BEFORE.replace(`${CLAUDE_TRUST_OPTION_ROWS.noSelected[0]}\n${CLAUDE_TRUST_OPTION_ROWS.noSelected[1]}`,
  `${CLAUDE_TRUST_OPTION_ROWS.noSelected[1]}\n${CLAUDE_TRUST_OPTION_ROWS.noSelected[0]}`);

const captured = (d: TrustDialog): CapturedTrustDialog => { if (d.kind === "none") throw new Error("captured dialog expected"); return d; };
const CLAUDE = captured(CLAUDE_TRUST_DIALOG);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const SEED: InteractiveSeed = {
  launch: (model: string) => `launch-tui --model ${model}`,
  readinessMatch: "TUI ready",
  seedLine: (promptFile: string) => `Read ${promptFile} and do exactly what it says.`,
};
const seatOf = (trustDialog: TrustDialog) => ({ trustDialog, interactiveSeed: SEED }) as unknown as WorkerAdapter;
const ASSIGNMENT = { adapter: "claude-code", model: "sonnet", channel: "sub" as const, tier: "frontier" as const };

/** A real driver's pane read and key verbs standing in for a boundary's scripted ones (the classic herdr fake below). */
type PaneIo = { read: (slot: Slot, lines: number) => Promise<string>; sendKey: (slot: Slot, key: string) => Promise<void> };
/** After Down: one replacement frame, or a frame chosen by the milliseconds elapsed since Down was sent. */
type AfterDown = string | ((msSinceDown: number) => string);

// ── boundary 1: the daemon's worker wait, a scripted pane whose frame Down replaces ───────────────────────────────
/** A failed submit: `enterError` is thrown by the scripted Enter (the driver's own error class decides its meaning). */
type SubmitOpts = { dialog?: TrustDialog; enterError?: Error };
async function daemonBoundary(runId: string, first: string, afterDown?: AfterDown, io?: PaneIo, submit: SubmitOpts = {}) {
  const { repo, fake } = setupRepo([T("T1")], {
    tasks: { T1: [{ shell: "sleep 30", result: { ok: true, summary: "never reached" } }] },
    consult: { action: "human", notes: "operator must answer the dialog" },
  }, "taskTimeoutMinutes: 0.05\n");
  (fake as { trustDialog?: TrustDialog }).trustDialog = submit.dialog ?? CLAUDE_TRUST_DIALOG;
  let frame = first;
  let downAt: number | undefined;
  const keys: string[] = [];
  const notified: string[] = [];
  const inner = new SubprocessDriver();
  const driver: ExecutorDriver = {
    id: "trust-boundary", interactive: true,
    slot: async (cwd, name) => ({ id: "p1", name, cwd }),
    run: async () => {},
    waitOutput: async () => { await sleep(20); return false; },
    waitAgentStatus: async () => true,
    read: async (s, n) => io ? io.read(s, n) : typeof afterDown === "function" && downAt !== undefined ? afterDown(Date.now() - downAt) : frame,
    status: async () => "blocked",
    sendKey: async (s, key) => {
      keys.push(key);
      if (key === "Down") { downAt = Date.now(); if (typeof afterDown === "string") frame = afterDown; }
      if (key === "Enter" && submit.enterError) throw submit.enterError;
      await io?.sendKey(s, key);
    },
    notify: async (msg) => { notified.push(msg); },
    close: async () => {},
    worktree: inner.worktree.bind(inner),
  };
  await runDaemon(repo, { adapters: [fake], runId, driver });
  return { keys, notified, events: Journal.open(repo, runId).read() };
}

// ── boundary 2: the interactive seed's startup wait ───────────────────────────────────────────────────────────────
async function seedBoundary(first: string, afterDown?: string, opts: { downThrows?: boolean; readBackThrows?: boolean; io?: PaneIo; firstReadDelayMs?: number } & SubmitOpts = {}) {
  let frame = "";
  let reads = 0;
  let downSent = false;
  let readsAfterDown = 0;
  const keys: string[] = [];
  const answers: TrustAnswer[] = [];
  const slot: Slot = { id: "p1", name: "T1-worker-claude-code-a0-seed", cwd: "/tmp" };
  const error = await runInteractiveSeed({
    driver: {
      run: async (_s, cmd) => { if (cmd.startsWith("launch-tui ")) frame = first; },
      waitOutput: async (_s, pattern, ms) => { await sleep(Math.min(ms, 30)); return frame.includes(pattern); },
      read: async (s, n) => {
        if (reads++ === 0 && opts.firstReadDelayMs) await sleep(opts.firstReadDelayMs);
        if (downSent) { readsAfterDown++; if (opts.readBackThrows) throw new Error("terminal unreadable"); }
        return opts.io ? opts.io.read(s, n) : frame;
      },
      sendKey: async (s, key) => {
        keys.push(key);
        if (key === "Down") { downSent = true; if (opts.downThrows) throw new Error("send refused"); if (afterDown !== undefined) frame = afterDown; }
        if (key === "Enter") { if (opts.enterError) throw opts.enterError; frame = "TUI ready"; }
        await opts.io?.sendKey(s, key);
      },
    },
    slot, adapter: seatOf(opts.dialog ?? CLAUDE_TRUST_DIALOG), assignment: ASSIGNMENT, promptFile: "/tmp/trust-seed.md", taskTimeoutMinutes: 0.02,
    onTrustAnswered: (answer) => { answers.push(answer); },
  }).then(() => undefined, (e: unknown) => e);
  return { keys, answers, error, readsAfterDown };
}

// ── boundary 3: a gate seat's pane startup ────────────────────────────────────────────────────────────────────────
/** firstReadDelayMs: the seat's FIRST frame read (the trust match) completes only after this delay. */
async function seatBoundary(first: string, afterDown?: string, io?: PaneIo, opts: { firstReadDelayMs?: number; timeoutMs?: number } & SubmitOpts = {}) {
  const nonce = "abc123ef";
  let reads = 0;
  const verdict = `{"nonce":"${nonce}","pass":true,"criteria":[]}\nTICKMARKR_EXIT_${nonce}:0`;
  let frame = first;
  const keys: string[] = [];
  const notified: string[] = [];
  const slot: Slot = { id: "s1", name: "judge · T1", cwd: "/tmp" };
  const driver: ExecutorDriver = {
    id: "trust-seat", interactive: true,
    slot: async () => slot, run: async () => {},
    waitOutput: async () => frame === verdict, waitAgentStatus: async () => false, status: async () => "blocked",
    read: async (s, n) => {
      if (reads++ === 0 && opts.firstReadDelayMs) await sleep(opts.firstReadDelayMs);
      return io ? io.read(s, n) : frame;
    },
    sendKey: async (s, key) => {
      keys.push(key); if (key === "Down" && afterDown !== undefined) frame = afterDown;
      if (key === "Enter") { if (opts.enterError) throw opts.enterError; frame = verdict; }
      await io?.sendKey(s, key);
    },
    notify: async (msg) => { notified.push(msg); }, close: async () => {}, worktree: async () => "/tmp",
  };
  setGateCpuAccountantFactoryForTests(() => ({ start: async () => {}, read: () => ({ cpu: { ms: 0, resolutionMs: 1 }, gaps: 0 }), stop: async () => {} }));
  try {
    const out = await runViaDriver({ ...claudeCode, streamTurn: undefined, ...(opts.dialog ? { trustDialog: opts.dialog } : {}) }, "sonnet", `TICKMARKR-JUDGE\n## Task T1: x\n${verdictNonceLine(nonce)}`, "/tmp", { driver, name: "judge · T1" }, opts.timeoutMs ?? 50);
    return { keys, notified, out, nonce };
  } finally {
    resetGateCpuAccountantFactoryForTests();
  }
}

// ── the REAL HerdrAppDriver over the executable hc fake, driven through the production seed boundary ────────────
/** "owner-after-yes": Down paints the captured after-Down frame; the read-back serves it and then the owner changes, so
 * the Enter preflight (`hc get`) refuses before `hc keys` runs — a submit refused BEFORE dispatch. */
type DownEffect = { screen: string } | "foreign-owner" | "gone" | "owner-after-yes";
// A 60 s seed budget: under a loaded full suite every hc call is a cold node spawn, and the 6 s budget let the first
// trust read land after the deadline (no Down at all). A refused seat is then ENDED (finished, drained screen), so the
// readiness wait after the refusal proves drain at once instead of sleeping out the budget; no key follows either way.
async function appSeed(first: string, onDown: DownEffect, minutes = 1) {
  const f = new FakeHerdrApp(makeTestTempDir("hcapp-trust-"));
  const repo = makeRepo({ "a.txt": "a" });
  const d = new HerdrAppDriver({ hcBin: f.hc, appBin: f.app, env: { PATH: process.env.PATH }, pollMs: 50, readinessMs: 1_500, confirmMs: 1_000 });
  const screen = (text: string): FakeTerm["screen"] => ({ text, complete: true, how: "screen" });
  f.update((s) => { s.spawn = { state: "live", reported: true, status: { state: "blocked" }, screen: screen(first) }; });
  const name = formatOwnedName({ role: "worker", taskId: "T1", attempt: 0, runId: "run-app-trust" });
  const foreign = { labels: { [OWNER_LABEL]: "tickmarkr:worker:T9:0:run-someone-else" } };
  const downMutation: Record<string, Partial<FakeTerm>> | undefined = typeof onDown === "object" ? { t1: { screen: screen(onDown.screen) } }
    : onDown === "foreign-owner" ? { t1: foreign } : onDown === "owner-after-yes" ? { t1: { screen: screen(AFTER) } } : undefined;
  f.rule(
    { match: ["keys", "t1", "down"], once: true, output: KEYS_OK, ...(downMutation ? { mutate: downMutation } : {}), ...(onDown === "gone" ? { remove: ["t1"] } : {}) },
    { match: ["keys", "t1", "enter"], once: true, output: KEYS_OK,
      mutate: { t1: { screen: screen("TUI ready"), history: { text: "TUI ready", complete: true }, status: { state: "idle" } } } },
  );
  const slot = await d.slot(repo, name);
  const answers: TrustAnswer[] = [];
  // Every hc call is the real driver's; owner-after-yes only arms the fake once Down has been answered, so the next
  // rendered read (the read-back) is served the captured after-Down read and moves the owner.
  const sendKey = onDown !== "owner-after-yes" ? d.sendKey.bind(d) : async (s: Slot, key: string) => {
    await d.sendKey(s, key);
    if (key === "Down") f.rule({ match: ["read", "t1", "--lines", "0"], once: true, output: ARTIFACT.files["04-read-after-down.json"]!, mutate: { t1: foreign } });
  };
  const error = await runInteractiveSeed({
    driver: { run: d.run.bind(d), waitOutput: d.waitOutput.bind(d), read: d.read.bind(d), sendKey },
    slot, adapter: seatOf(CLAUDE_TRUST_DIALOG), assignment: ASSIGNMENT, promptFile: join(repo, "prompt.md"), taskTimeoutMinutes: minutes,
    onTrustAnswered: (answer) => {
      answers.push(answer);
      if (answer.outcome === "refused" && f.read().terminals.t1) f.setTerm("t1", { state: "finished", exit_code: 1, reason: "exited" });
    },
  }).then(() => undefined, (e: unknown) => e);
  // The ordered trail of rendered screen reads and keys the driver issued for the owned terminal.
  const trail = f.calls().filter((c) => c.tool === "hc" && c.argv[1] === "t1"
    && (c.argv[0] === "keys" || (c.argv[0] === "read" && c.argv[c.argv.indexOf("--lines") + 1] === "0")))
    .map((c) => (c.argv[0] === "keys" ? `keys ${c.argv[2]}` : "screen"));
  return { f, answers, error, trail, keys: f.hcCalls("keys") };
}

// ── the REAL HerdrAppDriver over the executable hc fake, driven through the daemon's worker wait (review park 1159) ──
/** The Enter's fate after the captured selected-Yes read: its preflight's `hc server status` or `hc get` exits
 * nonzero (armed the instant the read-back returns, so `hc keys` is never spawned), or `hc keys` itself exits nonzero. */
type EnterFailure = "status" | "get" | "keys";
async function appDaemon(runId: string, failure: EnterFailure) {
  const { repo, fake } = setupRepo([T("T1")], {
    tasks: { T1: [{ shell: "sleep 30", result: { ok: true, summary: "never reached" } }] },
    consult: { action: "human", notes: "operator must answer the dialog" },
  }, "taskTimeoutMinutes: 0.05\n");
  (fake as { trustDialog?: TrustDialog }).trustDialog = CLAUDE_TRUST_DIALOG;
  const f = new FakeHerdrApp(makeTestTempDir("hcapp-trust-daemon-"));
  const screen = (text: string): FakeTerm["screen"] => ({ text, complete: true, how: "screen" });
  f.update((s) => { s.spawn = { state: "live", reported: true, status: { state: "blocked" }, screen: screen(BEFORE) }; });
  const stderr = "hc: refused\n";
  f.rule(
    { match: ["keys", "t1", "down"], once: true, output: KEYS_OK, mutate: { t1: { screen: screen(AFTER) } } },
    ...(failure === "keys" ? [{ match: ["keys", "t1", "enter"], exit: 1, stderr }] : []),
  );
  const preflight: FakeRule | undefined = failure === "status" ? { match: ["server", "status"], exit: 1, stderr }
    : failure === "get" ? { match: ["get", "t1"], exit: 1, stderr } : undefined;
  const d = new HerdrAppDriver({ hcBin: f.hc, appBin: f.app, env: { PATH: process.env.PATH }, runId, pollMs: 50, readinessMs: 1_500, confirmMs: 1_000 });
  const notified: string[] = [];
  d.notify = async (msg) => { notified.push(msg); };
  // Every hc call is the real driver's. The test only ARMS the preflight failure once the post-Down read-back of t1 has
  // returned (the selected-Yes proof), and disarms it once the Enter attempt ends.
  let downSent = false;
  let armed = false;
  const realSendKey = d.sendKey.bind(d);
  d.sendKey = async (s, key) => {
    try { await realSendKey(s, key); } finally {
      if (key === "Down") downSent = true;
      if (key === "Enter" && armed) f.update((st) => { st.rules = st.rules.filter((r) => JSON.stringify(r.match) !== JSON.stringify(preflight!.match)); });
    }
  };
  const realSlot = d.slot.bind(d);
  d.slot = async (...args: Parameters<HerdrAppDriver["slot"]>) => {
    const s = await realSlot(...args);
    const readScreen = s.readScreen;
    if (readScreen) s.readScreen = async () => {
      const text = await readScreen();
      if (downSent && !armed && preflight && claudeTrustSelection(text, "yes")) { armed = true; f.rule(preflight); }
      return text;
    };
    return s;
  };
  await runDaemon(repo, { adapters: [fake], runId, driver: d });
  return { keys: f.hcCalls("keys").filter((k) => k[1] === "t1"), notified, armed, events: Journal.open(repo, runId).read() };
}

// ── classic herdr by explicit path: `pane read` serves the current frame, `pane send-keys <p> down` swaps in the
// after-Down frame. readFailsAfterDown: every later read still PRINTS that frame on stdout but EXITS NONZERO — the
// failed read whose stdout must never become selection evidence (review finding on HerdrDriver.read).
function classicHerdr(afterDown: string, readFailsAfterDown = false) {
  const dir = makeTestTempDir("herdr-classic-trust-");
  const frame = join(dir, "frame.txt");
  const after = join(dir, "after.txt");
  const fail = join(dir, "read-fails");
  const log = join(dir, "herdr.log");
  const bin = join(dir, "herdr");
  writeFileSync(frame, BEFORE);
  writeFileSync(after, afterDown);
  writeFileSync(log, "");
  writeFileSync(bin, `#!/bin/bash
printf '%s\\n' "$*" >> ${shq(log)}
case "$1 $2" in
  "pane list") echo '{"result":{"panes":[]}}' ;;
  "pane send-keys") if [ "$4" = down ]; then cp ${shq(after)} ${shq(frame)}; ${readFailsAfterDown ? `touch ${shq(fail)};` : ""} fi; echo '{}' ;;
  "pane read") cat ${shq(frame)}; if [ -f ${shq(fail)} ]; then echo 'herdr: pane read failed' >&2; exit 1; fi ;;
  *) echo '{}' ;;
esac
`);
  chmodSync(bin, 0o755);
  const d = new HerdrDriver(bin);
  const io: PaneIo = { read: (slot, lines) => d.read(slot, lines), sendKey: (slot, key) => d.sendKey!(slot, key) };
  /** The key token of every `pane send-keys` the driver issued, in order. */
  const sent = () => readFileSync(log, "utf8").split("\n").filter((l) => l.startsWith("pane send-keys")).map((l) => l.split(" ").pop());
  return { d, io, sent, log };
}

describe("Claude trust answers verify the selected option (contract C; queue row 342; D-2180)", () => {
  test("the real app driver emits down then re-reads before enter for captured Claude trust while invalid selection never submits", async () => {
    // Base case: the captured dialog, the captured after-Down frame. Down is `hc keys t1 down`, then a rendered
    // re-read of the same owned terminal, and only then `hc keys t1 enter`.
    const ok = await appSeed(BEFORE, { screen: AFTER });
    expect(ok.answers).toEqual([{ outcome: "answered" }]);
    expect(ok.keys).toEqual([["keys", "t1", "down", "--json"], ["keys", "t1", "enter", "--json"]]);
    const down = ok.trail.indexOf("keys down");
    const enter = ok.trail.indexOf("keys enter");
    expect(ok.trail.slice(0, down)).toContain("screen"); // the match was on the rendered frame
    expect(down).toBeGreaterThan(-1);
    expect(enter).toBeGreaterThan(down + 1);
    expect(ok.trail.slice(down + 1, enter).every((step) => step === "screen")).toBe(true);
    expect(ok.trail.slice(down + 1, enter).length).toBeGreaterThan(0);

    // Invalid selection never submits on the real driver: Down landing on a stacked MCP modal, a cursor already on
    // Yes (uncaptured), the older 2.1.218 frame, and an owner that changed or vanished before the re-read.
    // owner changed after the selected-Yes read: the read-back proved Yes, then the Enter preflight refused the terminal
    // before `hc keys` ran — refused (paged), never an accepted trust (review: ownership refusal claims no trust).
    for (const [label, first, onDown, downs, reason] of [
      ["Down then a stacked MCP modal", BEFORE, { screen: STACKED }, 1, "read-back did not prove Yes selected"],
      ["cursor already on Yes", AFTER, { screen: AFTER }, 0, undefined],
      ["older 2.1.218 frame", CLAUDE_TRUST_PANE, { screen: AFTER }, 0, undefined],
      ["owner changed after Down", BEFORE, "foreign-owner", 1, undefined],
      ["terminal gone after Down", BEFORE, "gone", 1, undefined],
      ["owner changed after the selected-Yes read", BEFORE, "owner-after-yes", 1, "Enter not delivered: herdr-app keys: t1 is not this slot's terminal"],
    ] as const) {
      const r = await appSeed(first, onDown);
      expect(r.keys.filter((k) => k[2] === "enter"), label).toEqual([]);
      expect(r.keys, label).toEqual(downs ? [["keys", "t1", "down", "--json"]] : []);
      expect(r.answers.map((a) => a.outcome), label).toEqual(["refused"]);
      if (reason) expect(r.answers[0]?.outcome === "refused" && r.answers[0].reason, label).toContain(reason);
      if (onDown === "owner-after-yes") expect(r.trail.slice(r.trail.indexOf("keys down") + 1), label).toEqual(["screen"]);
      // The launch fails rather than seeding: readiness never came (or the terminal is no longer this slot's).
      expect(r.error, label).toBeInstanceOf(Error);
    }

    // The dispatch boundary through the daemon (review park 1159): after the captured selected-Yes read, an Enter whose
    // preflight `hc server status` or `hc get` exits nonzero never spawns `hc keys` — refused, paged, no Enter
    // key, no trust-auto-answer. Control: `hc keys` itself exiting nonzero after spawn is unconfirmed (still paged).
    for (const failure of ["status", "get"] as const) {
      const r = await appDaemon(`run-app-trust-${failure}-fails`, failure);
      expect(r.armed, failure).toBe(true);
      expect(r.keys, failure).toEqual([["keys", "t1", "down", "--json"]]);
      expect(r.events.filter((e) => e.event === "trust-auto-answer"), failure).toEqual([]);
      const refusals = r.events.filter((e) => e.event === "trust-answer-refused").map((e) => String(e.data.reason));
      expect(refusals, failure).toEqual([expect.stringContaining(`Enter not delivered: ${failure === "status" ? "status" : "terminal"} response family failed`)]);
      expect(r.notified.filter((m) => m.includes(`trust dialog left unanswered (${refusals[0]})`)), failure).toHaveLength(1);
    }
    const control = await appDaemon("run-app-trust-keys-fails", "keys");
    expect(control.keys).toEqual([["keys", "t1", "down", "--json"], ["keys", "t1", "enter", "--json"]]);
    expect(control.events.filter((e) => e.event === "trust-answer-refused")).toEqual([]);
    const unconfirmed = control.events.filter((e) => e.event === "trust-auto-answer").map((e) => String(e.data.unconfirmed));
    expect(unconfirmed).toEqual([expect.stringContaining("Enter not delivered: keys response family failed")]);
    expect(control.notified.filter((m) => m.includes(`trust dialog answer unconfirmed (${unconfirmed[0]})`))).toHaveLength(1);
  }, 240_000);

  test("all three production trust-answer boundaries reject a trust frame followed by a stacked MCP modal and prose-only question text without Enter", async () => {
    // Every rejected frame still carries the exact fingerprint, so each boundary's existing matcher DOES fire.
    for (const frame of [STACKED, PROSE]) expect(matchesTrustDialog(frame, CLAUDE_TRUST_DIALOG)).toBe(true);
    const cases = [
      { label: "trust frame, then a stacked MCP modal after Down", first: BEFORE, afterDown: STACKED, keys: ["Down"] },
      { label: "stacked MCP modal over stale trust text", first: STACKED, afterDown: undefined, keys: [] },
      { label: "prose-only question text", first: PROSE, afterDown: undefined, keys: [] },
    ];

    // 1. The daemon's worker wait: no Enter, a refusal on the record (never a trust-auto-answer) and an operator page.
    for (const [i, c] of cases.entries()) {
      const r = await daemonBoundary(`run-trust-boundary-${i}`, c.first, c.afterDown);
      expect(r.keys, `daemon: ${c.label}`).toEqual(c.keys);
      expect(r.events.filter((e) => e.event === "trust-auto-answer"), `daemon: ${c.label}`).toEqual([]);
      expect(r.events.filter((e) => e.event === "trust-answer-refused"), `daemon: ${c.label}`).toHaveLength(1);
      expect(r.notified.some((m) => m.includes("trust dialog left unanswered")), `daemon: ${c.label}`).toBe(true);
    }
    // 2. The interactive seed: the refusal is carried out explicitly and readiness never arrives.
    for (const c of cases) {
      const r = await seedBoundary(c.first, c.afterDown);
      expect(r.keys, `seed: ${c.label}`).toEqual(c.keys);
      expect(r.answers.map((a) => a.outcome), `seed: ${c.label}`).toEqual(["refused"]);
      expect(r.error, `seed: ${c.label}`).toBeInstanceOf(SeedReadinessError);
    }
    // 3. A gate seat's pane startup: no Enter, the operator is paged, and no verdict is manufactured.
    for (const c of cases) {
      const r = await seatBoundary(c.first, c.afterDown);
      expect(r.keys, `seat: ${c.label}`).toEqual(c.keys);
      expect(r.notified.some((m) => m.includes("trust dialog left unanswered")), `seat: ${c.label}`).toBe(true);
      expect(r.out, `seat: ${c.label}`).not.toContain(`TICKMARKR_EXIT_${r.nonce}`);
    }

    // Controls — the same three boundaries answer the captured dialog with Down then Enter, so the rejections above are
    // the predicate's, not a boundary that stopped answering.
    const daemon = await daemonBoundary("run-trust-boundary-ok", BEFORE, AFTER);
    expect(daemon.keys).toEqual(["Down", "Enter"]);
    expect(daemon.events.filter((e) => e.event === "trust-auto-answer")).toHaveLength(1);
    expect(daemon.events.filter((e) => e.event === "trust-answer-refused")).toEqual([]);
    const seed = await seedBoundary(BEFORE, AFTER);
    expect(seed.keys).toEqual(["Down", "Enter"]);
    expect(seed.answers).toEqual([{ outcome: "answered" }]);
    expect(seed.error).toBeUndefined();
    const seat = await seatBoundary(BEFORE, AFTER);
    expect(seat.keys).toEqual(["Down", "Enter"]);
    expect(seat.out).toContain(`TICKMARKR_EXIT_${seat.nonce}:0`);
  }, 180_000);

  test("driver-specific Claude key handling satisfies the closed selector table while failed read-back never sends Enter or retries", async () => {
    // Provenance: the fixture is the spec artifact's public copy; every derived frame is what the artifact says it is.
    if (existsSync(SPEC_ARTIFACT)) expect(readFileSync(ARTIFACT_URL, "utf8")).toBe(readFileSync(SPEC_ARTIFACT, "utf8"));
    expect(ARTIFACT.duplicateControl.identical).toBe(true);
    expect(ARTIFACT.files[ARTIFACT.duplicateControl.files[0]!]).toBe(ARTIFACT.files[ARTIFACT.duplicateControl.files[1]!]);
    expect(STACKED).toBe(AFTER + MCP);
    expect(NBSP).toBe(AFTER.replace(" ❯ Yes, I trust this folder", " ❯ Yes, I trust this folder"));
    const half = PROSE.slice(0, PROSE.length / 2);
    expect(PROSE).toBe(half + half);
    expect(BEFORE).toContain(half);
    expect(PROSE).not.toContain("❯");

    // The bottom-anchored predicate over every captured or derived frame.
    expect(claudeTrustSelection(BEFORE, "no")).toBe(true);
    expect(claudeTrustSelection(BEFORE, "yes")).toBe(false);
    expect(claudeTrustSelection(AFTER, "yes")).toBe(true);
    expect(claudeTrustSelection(AFTER, "no")).toBe(false);
    expect(claudeTrustSelection(NBSP, "yes")).toBe(true); // caret-padding-only normalisation
    for (const frame of [STACKED, PROSE, MCP, CLAUDE_TRUST_PANE, SWAPPED, `${AFTER}\n trailing prose`]) {
      expect(claudeTrustSelection(frame, "yes"), frame.slice(-60)).toBe(false);
      expect(claudeTrustSelection(frame, "no"), frame.slice(-60)).toBe(false);
    }
    // Only the caret's padding normalises: an NBSP in the leading indent is not the captured row.
    expect(claudeTrustSelection(AFTER.replace(" ❯ Yes", " ❯ Yes"), "yes")).toBe(false);

    // The closed selector table through the shared answer, one scripted terminal per row.
    type Row = { label: string; first: string; dialog?: CapturedTrustDialog; afterDown?: string; deadline?: number;
      downThrows?: boolean; readBackThrows?: boolean; enterError?: Error; keys: string[]; outcome: TrustAnswer["outcome"]; readsAfterDown?: number };
    // A failed submit is never an accepted trust: the driver's refusal to address the terminal (raised before any key)
    // is refused; any other rejection may follow a dispatch and is unconfirmed. Both keep the latch spent, never retried.
    const NOT_OURS = new HcUnavailableError("keys", "t1 is not this slot's terminal (owner changed)");
    const AFTER_DISPATCH = new Error("dispatched, then refused");
    const CODEX_Q = "Do you trust the contents of this directory?";
    const rows: Row[] = [
      { label: "captured default No then Yes", first: BEFORE, afterDown: AFTER, keys: ["Down", "Enter"], outcome: "answered", readsAfterDown: 1 },
      { label: "derived NBSP-padded caret after Down", first: BEFORE, afterDown: NBSP, keys: ["Down", "Enter"], outcome: "answered" },
      { label: "Down send failed", first: BEFORE, downThrows: true, keys: ["Down"], outcome: "refused", readsAfterDown: 0 },
      { label: "read-back unreadable", first: BEFORE, readBackThrows: true, keys: ["Down"], outcome: "refused", readsAfterDown: 1 },
      { label: "deadline already expired", first: BEFORE, afterDown: AFTER, deadline: Date.now() - 1, keys: [], outcome: "refused" },
      { label: "selected Yes not proven before the deadline (unchanged frame)", first: BEFORE, afterDown: BEFORE, deadline: Date.now() + 400, keys: ["Down"], outcome: "refused" },
      { label: "Down then a changed modal", first: BEFORE, afterDown: STACKED, keys: ["Down"], outcome: "refused", readsAfterDown: 1 },
      { label: "cursor already on Yes", first: AFTER, keys: [], outcome: "refused" },
      { label: "unknown option order", first: SWAPPED, keys: [], outcome: "refused" },
      { label: "older 2.1.218 frame", first: CLAUDE_TRUST_PANE, keys: [], outcome: "refused" },
      { label: "Enter dispatched then rejected after proof", first: BEFORE, afterDown: AFTER, enterError: AFTER_DISPATCH, keys: ["Down", "Enter"], outcome: "unconfirmed" },
      { label: "Enter refused before dispatch after proof", first: BEFORE, afterDown: AFTER, enterError: NOT_OURS, keys: ["Down", "Enter"], outcome: "refused" },
      { label: "another adapter keeps its single key", first: CODEX_Q, dialog: captured(CODEX_TRUST_DIALOG), keys: ["Enter"], outcome: "answered" },
      { label: "another adapter's key dispatched then rejected", first: CODEX_Q, dialog: captured(CODEX_TRUST_DIALOG), enterError: AFTER_DISPATCH, keys: ["Enter"], outcome: "unconfirmed" },
      { label: "another adapter's key refused before dispatch", first: CODEX_Q, dialog: captured(CODEX_TRUST_DIALOG), enterError: NOT_OURS, keys: ["Enter"], outcome: "refused" },
    ];
    for (const row of rows) {
      let frame = row.first;
      let downSent = false;
      let readsAfterDown = 0;
      const keys: string[] = [];
      const answer = await answerTrustDialog({
        dialog: row.dialog ?? CLAUDE, frame: row.first, deadline: row.deadline ?? Date.now() + 5_000, pollMs: 50,
        read: async () => { if (downSent) { readsAfterDown++; if (row.readBackThrows) throw new Error("unreadable"); } return frame; },
        sendKey: async (key) => {
          keys.push(key);
          if (key === "Down") { downSent = true; if (row.downThrows) throw new Error("send refused"); if (row.afterDown !== undefined) frame = row.afterDown; }
          if (key === "Enter" && row.enterError) throw row.enterError;
        },
      });
      expect(keys, row.label).toEqual(row.keys);
      expect(answer.outcome, row.label).toBe(row.outcome);
      if (row.enterError) expect(answer, row.label).toEqual({ outcome: row.outcome, reason: `Enter not delivered: ${row.enterError.message}` });
      if (row.readsAfterDown !== undefined) expect(readsAfterDown, row.label).toBe(row.readsAfterDown);
    }
    // No trust match, no key: the captured MCP control and a blank fingerprint never reach the answer at all.
    expect(matchesTrustDialog(MCP, CLAUDE_TRUST_DIALOG)).toBe(false);
    expect(matchesTrustDialog(BEFORE, { fingerprint: " ", key: "Enter" })).toBe(false);

    // A failed read-back through the production seed never sends Enter and never re-sends Down.
    const unreadable = await seedBoundary(BEFORE, AFTER, { readBackThrows: true });
    expect(unreadable.keys).toEqual(["Down"]);
    expect(unreadable.answers).toEqual([{ outcome: "refused", reason: "read-back unreadable: terminal unreadable" }]);
    expect(unreadable.error).toBeInstanceOf(Error);
    const undelivered = await seedBoundary(BEFORE, AFTER, { downThrows: true });
    expect(undelivered.keys).toEqual(["Down"]);
    expect(undelivered.answers).toEqual([{ outcome: "refused", reason: "Down not delivered: send refused" }]);

    // Through ALL THREE production boundaries, Claude's verified Enter and Codex's single Enter (the captured frames): a
    // failed submit is never recorded or narrated as an accepted trust — the daemon writes the refusal (or an
    // `unconfirmed` key record) and pages, the seed carries the outcome out, the gate seat pages and fabricates no
    // verdict. One key sequence each; nothing is retried.
    const CODEX_FRAME = readFileSync(new URL("../fixtures/codex-input-box/trust-dialog.txt", import.meta.url), "utf8");
    let submitRun = 0;
    for (const [dialog, first, afterDown, sent] of [
      [CLAUDE_TRUST_DIALOG, BEFORE, AFTER, ["Down", "Enter"]],
      [CODEX_TRUST_DIALOG, CODEX_FRAME, undefined, ["Enter"]],
    ] as const) {
      expect(matchesTrustDialog(first, dialog)).toBe(true);
      for (const [enterError, outcome] of [[NOT_OURS, "refused"], [AFTER_DISPATCH, "unconfirmed"]] as const) {
        const label = `${captured(dialog).fingerprint.slice(0, 24)} / ${outcome}`;
        const reason = `Enter not delivered: ${enterError.message}`;
        const d = await daemonBoundary(`run-trust-submit-${submitRun++}`, first, afterDown, undefined, { dialog, enterError });
        expect(d.keys, `daemon ${label}`).toEqual(sent);
        expect(d.events.filter((e) => e.event === "trust-auto-answer" && e.data.unconfirmed === undefined), `daemon ${label}`).toEqual([]);
        expect(d.events.filter((e) => e.event === (outcome === "refused" ? "trust-answer-refused" : "trust-auto-answer"))
          .map((e) => e.data[outcome === "refused" ? "reason" : "unconfirmed"]), `daemon ${label}`).toEqual([reason]);
        expect(d.notified.some((m) => m.includes(`(${reason})`)), `daemon ${label}`).toBe(true);
        const seed = await seedBoundary(first, afterDown, { dialog, enterError });
        expect(seed.keys, `seed ${label}`).toEqual(sent);
        expect(seed.answers, `seed ${label}`).toEqual([{ outcome, reason }]);
        expect(seed.error, `seed ${label}`).toBeInstanceOf(SeedReadinessError);
        const seat = await seatBoundary(first, afterDown, undefined, { dialog, enterError });
        expect(seat.keys, `seat ${label}`).toEqual(sent);
        expect(seat.notified.some((m) => m.includes(`(${reason})`)), `seat ${label}`).toBe(true);
        expect(seat.out, `seat ${label}`).not.toContain(`TICKMARKR_EXIT_${seat.nonce}`);
      }
    }

    // Herdr app: Down is `hc keys <owned> down` (the base case is the first test); a re-read that cannot prove the
    // owned terminal sends nothing more.
    const gone = await appSeed(BEFORE, "gone");
    expect(gone.keys).toEqual([["keys", "t1", "down", "--json"]]);

    // Classic herdr: logical Down becomes lowercase `down`; every other key passes byte-identical; Enter only after
    // the read-back proves Yes. A read that EXITS NONZERO never earns it — even when its stdout is the captured
    // selected-Yes frame (the review's counterexample): a failed read is no frame at all.
    const classic = async (afterDown: string, readFails = false) => {
      const h = classicHerdr(afterDown, readFails);
      const slot: Slot = { id: "w1:p9", name: "T1-worker-claude-code-a0-classic", cwd: makeTestTempDir("herdr-classic-cwd-") };
      const answer = await answerTrustDialog({ dialog: CLAUDE, frame: await h.d.read(slot, 80), read: () => h.d.read(slot, 80),
        sendKey: (key) => h.d.sendKey!(slot, key), deadline: Date.now() + 10_000, pollMs: 50 });
      return { ...h, answer, slot };
    };
    const ok = await classic(AFTER);
    expect(ok.answer).toEqual({ outcome: "answered" });
    expect(ok.sent()).toEqual(["down", "Enter"]);
    expect(readFileSync(ok.log, "utf8")).toContain("pane send-keys w1:p9 down\n");
    for (const key of ["Enter", "C-u", "Up", "down", "Escape"]) await ok.d.sendKey(ok.slot, key);
    expect(ok.sent().slice(2)).toEqual(["Enter", "C-u", "Up", "down", "Escape"]);
    const failed = await classic(AFTER, true);
    expect(failed.answer.outcome).toBe("refused");
    expect(failed.sent()).toEqual(["down"]);
    // The failing read printed the selected-Yes frame and exited nonzero; the driver hands no caller that stdout.
    expect(await failed.d.read(failed.slot, 80)).toBe("");
    // Through ALL THREE production boundaries over the real classic driver: Down, then the failed read-back — no Enter.
    const daemonClassic = classicHerdr(AFTER, true);
    const daemonRun = await daemonBoundary("run-trust-classic-failed-read", BEFORE, undefined, daemonClassic.io);
    expect(daemonClassic.sent(), "daemon").toEqual(["down"]);
    expect(daemonRun.events.filter((e) => e.event === "trust-auto-answer"), "daemon").toEqual([]);
    expect(daemonRun.events.filter((e) => e.event === "trust-answer-refused"), "daemon").toHaveLength(1);
    expect(daemonRun.notified.some((m) => m.includes("trust dialog left unanswered")), "daemon").toBe(true);
    const seedClassic = classicHerdr(AFTER, true);
    const seedRun = await seedBoundary(BEFORE, undefined, { io: seedClassic.io });
    expect(seedClassic.sent(), "seed").toEqual(["down"]);
    expect(seedRun.answers.map((a) => a.outcome), "seed").toEqual(["refused"]);
    expect(seedRun.error, "seed").toBeInstanceOf(SeedReadinessError);
    const seatClassic = classicHerdr(AFTER, true);
    // The seat's budget now starts before its first read, which here spawns the fake herdr: a realistic 2 s budget.
    const seatRun = await seatBoundary(BEFORE, undefined, seatClassic.io, { timeoutMs: 2_000 });
    expect(seatClassic.sent(), "seat").toEqual(["down"]);
    expect(seatRun.notified.some((m) => m.includes("trust dialog left unanswered")), "seat").toBe(true);

    // The daemon's deadline is the worker's ORIGINAL startup deadline capped by the attempt's, never extended. A dialog
    // first met after the startup window gets no Down at all; a read-back that only proves Yes after the attempt's hard
    // deadline gets no Enter.
    setWorkerStartupWindowMsForTests(1);
    try {
      const late = await daemonBoundary("run-trust-late-dialog", BEFORE, AFTER);
      expect(late.keys, "late dialog").toEqual([]);
      expect(late.events.filter((e) => e.event === "trust-auto-answer"), "late dialog").toEqual([]);
      expect(late.events.filter((e) => e.event === "trust-answer-refused").map((e) => e.data.reason), "late dialog")
        .toEqual(["startup deadline expired before Down"]);
      expect(late.notified.some((m) => m.includes("trust dialog left unanswered")), "late dialog").toBe(true);
    } finally {
      resetWorkerStartupWindowMsForTests();
    }
    const HARD_MS = 4_000;
    setAttemptHardTimeoutMsForTests(HARD_MS);
    try {
      // Down lands after the attempt started, so Yes painted HARD_MS after Down is painted after the hard deadline.
      const crossing = await daemonBoundary("run-trust-hard-deadline", BEFORE, (since) => (since >= HARD_MS ? AFTER : BEFORE));
      expect(crossing.keys, "read-back crossing the hard deadline").toEqual(["Down"]);
      expect(crossing.events.filter((e) => e.event === "trust-auto-answer"), "hard deadline").toEqual([]);
      expect(crossing.events.filter((e) => e.event === "trust-answer-refused").map((e) => e.data.reason), "hard deadline")
        .toEqual(["startup deadline expired before Yes was proven"]);
    } finally {
      resetAttemptHardTimeoutMsForTests();
    }
    // Every caller's startup deadline is fixed BEFORE its first frame read and never recomputed (review park 978): a
    // captured-No read that completes after the budget sends no Down and no Enter. The gate seat's budget is its
    // launch-time min(timeout, first-liveness); the seed's is its launch-time readiness deadline (0.02 min here); the
    // daemon's is the late-dialog case above. Control: the SAME delayed read finishing inside the budget proceeds
    // Down → re-read → Enter as captured.
    const SEAT_BUDGET_MS = 1_000;
    const seatLate = await seatBoundary(BEFORE, AFTER, undefined, { firstReadDelayMs: SEAT_BUDGET_MS + 100, timeoutMs: SEAT_BUDGET_MS });
    expect(seatLate.keys, "seat: first read ends after its budget").toEqual([]);
    expect(seatLate.notified.some((m) => m.includes("trust dialog left unanswered (startup deadline expired before Down)")), "seat late").toBe(true);
    expect(seatLate.out, "seat late").not.toContain(`TICKMARKR_EXIT_${seatLate.nonce}`);
    const seatInTime = await seatBoundary(BEFORE, AFTER, undefined, { firstReadDelayMs: 100, timeoutMs: SEAT_BUDGET_MS });
    expect(seatInTime.keys, "seat: first read ends inside its budget").toEqual(["Down", "Enter"]);
    expect(seatInTime.notified, "seat in time").toEqual([]);
    expect(seatInTime.out, "seat in time").toContain(`TICKMARKR_EXIT_${seatInTime.nonce}:0`);
    const seedLate = await seedBoundary(BEFORE, AFTER, { firstReadDelayMs: 1_300 });
    expect(seedLate.keys, "seed: first read ends after its budget").toEqual([]);
    expect(seedLate.answers, "seed late").toEqual([]);
    expect(seedLate.error, "seed late").toBeInstanceOf(SeedReadinessError);
    const seedInTime = await seedBoundary(BEFORE, AFTER, { firstReadDelayMs: 100 });
    expect(seedInTime.keys, "seed: first read ends inside its budget").toEqual(["Down", "Enter"]);
    expect(seedInTime.answers, "seed in time").toEqual([{ outcome: "answered" }]);

    // Orca has no Down verb: the shipped bare-Enter exit becomes a refusal and an operator page, never a fallback Enter.
    const wt = "/tmp/orca-claude-trust/T1";
    const fake = new FakeOrca({ trackedWorktrees: [wt], echoSends: false, pageSize: 120 }); // the captured 120-row screen
    const modal = cursorModalExec(fake, { launch: "launch-tui", screen: BEFORE, ready: "TUI ready" });
    const orca = new OrcaDriver({ pollMs: 20, exec: modal.exec });
    const orcaSlot = await orca.slot(wt, formatOwnedName({ role: "worker", taskId: "T1", attempt: 0, runId: "run-orca-claude" }));
    const orcaAnswers: TrustAnswer[] = [];
    const orcaError = await runInteractiveSeed({
      driver: { run: orca.run.bind(orca), waitOutput: orca.waitOutput.bind(orca), read: orca.read.bind(orca), sendKey: orca.sendKey.bind(orca) },
      slot: orcaSlot, adapter: seatOf(CLAUDE_TRUST_DIALOG), assignment: ASSIGNMENT, promptFile: "/tmp/orca-claude-trust/prompt.md",
      taskTimeoutMinutes: 0.03, onTrustAnswered: (answer) => { orcaAnswers.push(answer); },
    }).then(() => undefined, (e: unknown) => e);
    expect(orcaSlot.readScreen).toBeTypeOf("function");
    expect(modal.enters()).toBe(0);
    expect(orcaAnswers).toHaveLength(1);
    expect(orcaAnswers[0]).toMatchObject({ outcome: "refused", reason: expect.stringMatching(/^Down not delivered: .*no terminal key verb/) });
    expect(orcaError).toBeInstanceOf(SeedReadinessError);
  }, 240_000);
});
