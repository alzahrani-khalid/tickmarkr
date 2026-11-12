// Queue row 417; D-2187 add.77, add.99, add.100: a reconnect-only reviewer or judge stream fails fast as transport on
// the headless and the pane dispatch path. Fixtures are the contract's verbatim captured shapes (run …2493 and …1173).
import { execSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { FakeAdapter } from "../../src/adapters/fake.js";
import { QWEN_HARNESS_BANNER_ROWS } from "../../src/adapters/qwen.js";
import { shq, type Assignment, type BillingChannel, type WorkerAdapter } from "../../src/adapters/types.js";
import { DEFAULT_CONFIG } from "../../src/config/config.js";
import type { ExecutorDriver, Slot } from "../../src/drivers/types.js";
import { captureBaseline } from "../../src/gates/baseline.js";
import {
  type GateVia,
  resetGateCpuAccountantFactoryForTests,
  resetGateInactivityWindowMsForTests,
  setGateCpuAccountantFactoryForTests,
  setGateInactivityWindowMsForTests,
} from "../../src/gates/llm.js";
import { reviewGate } from "../../src/gates/review.js";
import { runGates } from "../../src/gates/run-gates.js";
import { classifyStreamLine, TransportWatch } from "../../src/gates/transport-death.js";
import { validateGraph } from "../../src/graph/schema.js";
import { makeRepo } from "../helpers/tmprepo.js";

const WAITING = "ERROR: Reconnecting... waiting for network";
const OLD_SHAPE = ["ERROR: Reconnecting... 2/5", "ERROR: Reconnecting... 3/5", "ERROR: Reconnecting... 4/5", "ERROR: Reconnecting... 5/5"];
const HARNESS = ["hook: SessionStart", "hook: SessionStart Completed", "hook: UserPromptSubmit", "hook: UserPromptSubmit Completed", "warning: proxy 127.0.0.1:8317 is configured"];
// A live `codex exec` stream's header block and `user` row (codex-cli 0.167.0, contract amendment A; D-2187 add.123).
const CODEX_HEADER = ["Reading additional input from stdin...", "OpenAI Codex v0.167.0", "--------", "workdir: /Users/x/clones/tkr-287-deliver",
  "model: gpt-6.1-sol", "provider: openai", "approval: never", "sandbox: read-only", "reasoning effort: xhigh", "reasoning summaries: none",
  "session id: 01a1c5de-fdf7-7370-93a1-d846223f1d37", "--------", "user"];
const MODEL = ["I am reading the diff now.", "The change edits src/work.ts."];

const task = validateGraph({
  version: 1,
  spec: { source: "prd", paths: ["p"], hash: "h" },
  tasks: [{ id: "T1", title: "transport", goal: "fail a dead reviewer fast", shape: "implement", complexity: 8,
    files: ["src/work.ts"], acceptance: ["works"] }],
}).tasks[0];
const author: Assignment = { adapter: "author", model: "author-1", channel: "sub", tier: "frontier" };
const channels: BillingChannel[] = [
  { ...author, vendor: "author-vendor" },
  { adapter: "fake", vendor: "review-vendor", model: "fake-2", channel: "api", tier: "frontier" },
];

function scriptPath(extra: object = {}): string {
  const p = join(mkdtempSync(join(tmpdir(), "tickmarkr-transport-")), "script.json");
  writeFileSync(p, JSON.stringify({ tasks: {}, ...extra }));
  return p;
}

function repoWithCommit(head = ""): { repo: string; base: string } {
  const repo = makeRepo({ "src/work.ts": `${head}export const value = 1;\n` });
  const base = execSync("git rev-parse HEAD", { cwd: repo, encoding: "utf8" }).trim();
  writeFileSync(join(repo, "src/work.ts"), `${head}export const value = 2;\n`);
  execSync("git add -A && git commit -m work --no-gpg-sign", { cwd: repo });
  return { repo, base };
}

// Headless: the CLI echoes the brief, prints its harness lines, then each stream line `gap` seconds apart.
const emit = (lines: readonly string[]) => lines.map((line) => `printf '%s\\n' ${shq(line)} >&2`).join("; ");
const drip = (lines: readonly string[], gap: number) => lines.map((line) => `${emit([line])}; sleep ${gap}`).join("; ");
// An echoing seat is the LIVE codex stream: the header block and `user` row, the whole brief, the harness lines, the tail.
class ShellSeat extends FakeAdapter {
  constructor(private readonly tail: string, private readonly echoBrief = true, private readonly header = CODEX_HEADER) { super(scriptPath()); }
  override headlessCommand(promptFile: string): string {
    const echo = this.echoBrief ? `${emit(this.header)}; cat ${shq(promptFile)} >&2; ` : "";
    return `${echo}${emit(HARNESS)}; ${this.tail.replaceAll("$PROMPT", shq(promptFile))}`;
  }
}

// Pane: the seat's accumulated stream is a function of the read count. Each read writes it whole to the dispatch's seat
// log (what the script's tee appends) and returns the newest `rows` rows, as a pane's snapshot does.
class StreamPane implements ExecutorDriver {
  id = "stream-pane";
  interactive = true;
  reads = 0;
  closed = false;
  private nonce = "";
  constructor(private readonly seat: PaneSeat, private readonly frame: (read: number, nonce: string) => string[], private readonly echoBrief = true,
    private readonly terminator = "\n") {}
  async slot(cwd: string, name: string): Promise<Slot> { return { id: name, name, cwd }; }
  async run(): Promise<void> {}
  async waitOutput(_slot: Slot, pattern: string, timeoutMs: number): Promise<boolean> {
    this.nonce = /TICKMARKR_EXIT_([0-9a-f]+):/.exec(pattern)?.[1] ?? "";
    await new Promise((done) => setTimeout(done, Math.min(timeoutMs, 10)));
    return false;
  }
  async waitAgentStatus(): Promise<boolean> { return true; }
  async status(): Promise<"unknown"> { return "unknown"; }
  async read(_slot: Slot, rows = 400): Promise<string> {
    const brief = this.echoBrief ? readFileSync(this.seat.promptFile, "utf8").split("\n") : [];
    const stream = [...brief, ...this.frame(this.reads++, this.nonce)];
    const seatRows = stream.filter((row) => !row.startsWith("TICKMARKR_EXIT_"));
    writeFileSync(join(dirname(this.seat.promptFile), "seat.log"), seatRows.map((row) => `${row}\n`).join(""));
    return stream.slice(-rows).join("\n") + this.terminator;
  }
  async notify(): Promise<void> {}
  async close(): Promise<void> { this.closed = true; }
  async worktree(): Promise<string> { return ""; }
}
class PaneSeat extends FakeAdapter {
  promptFile = "";
  constructor() { super(scriptPath()); }
  override headlessCommand(promptFile: string): string { this.promptFile = promptFile; return "true"; }
}
const briefRows = (seat: PaneSeat) => readFileSync(seat.promptFile, "utf8").split("\n");
const paneVia = (driver: ExecutorDriver): GateVia => ({ driver, nameFor: () => "transport", labelFor: () => "REVIEW T1" });
const times = (n: number, line: string) => Array.from({ length: n }, () => line);

async function review(adapter: WorkerAdapter, timeoutMs: number, via?: GateVia, head = "") {
  const { repo, base } = repoWithCommit(head);
  const cfg = structuredClone(DEFAULT_CONFIG);
  cfg.review.timeoutMs = timeoutMs;
  const artifacts = mkdtempSync(join(tmpdir(), "tickmarkr-transport-raw-"));
  const started = Date.now();
  const row = await reviewGate(task, repo, base, author, channels, [adapter], cfg, via, undefined, artifacts);
  const ms = Date.now() - started;
  const rawFile = readdirSync(artifacts).find((f) => f.startsWith("review-raw-"));
  const raw = rawFile ? readFileSync(join(artifacts, rawFile), "utf8") : "";
  const transportLines = raw.split("\n").filter((line) => classifyStreamLine(line) === "transport").length;
  return { row, ms, raw, transportLines };
}

beforeEach(() => {
  // The check interval follows the gate wait slice (30 s in production); this seam makes it 10 ms.
  setGateInactivityWindowMsForTests(40);
  setGateCpuAccountantFactoryForTests(() => ({
    async start() {}, async stop() {}, read: () => ({ cpu: undefined, gaps: 0 }),
  }));
});
afterEach(() => {
  resetGateInactivityWindowMsForTests();
  resetGateCpuAccountantFactoryForTests();
});

describe("row 417: transport death detection", () => {
  test("each captured reconnect only stream fails the dispatch as transport after its third transport line on the headless and the pane path", async () => {
    // …2493, headless: seventeen waiting-for-network lines would run to the 20 s ceiling; the third one ends it.
    const dead = await review(new ShellSeat(`${drip(times(17, WAITING), 0.4)}; sleep 30`), 20_000);
    expect(dead.row.meta).toMatchObject({ noVerdict: true, cause: "transport" });
    expect(dead.ms).toBeLessThan(10_000);
    expect(dead.transportLines).toBe(3);
    expect(dead.row.details).not.toContain("killed at configured review timeout");

    // …1173, headless: the counted shape `2/5` to `5/5`, then the process exits.
    const old = await review(new ShellSeat(`${drip(OLD_SHAPE, 0.4)}; exit 1`), 20_000);
    expect(old.row.meta).toMatchObject({ cause: "transport" });
    expect(old.transportLines).toBe(3);

    // …2493, pane: one more transport line per read; the read that shows the third one closes the seat.
    const seat = new PaneSeat();
    const pane = new StreamPane(seat, (read) => [...CODEX_HEADER, ...briefRows(seat), ...HARNESS, ...times(Math.min(read, 17), WAITING)], false);
    const viaPane = await review(seat, 20_000, paneVia(pane));
    expect(viaPane.row.meta).toMatchObject({ cause: "transport" });
    expect(viaPane.ms).toBeLessThan(10_000);
    expect(pane.reads).toBe(4); // reads 0..3; read 3 is the first to hold three lines
    expect(pane.closed).toBe(true);
  }, 60_000);

  test("a reconnect that succeeds in one check and a pane stream whose earlier model lines left the snapshot are never failed fast", async () => {
    // Three transport lines then model lines, all in the one write a single check reads: never killed, base timeout.
    const succeeds = await review(new ShellSeat(`${emit([...times(4, WAITING), ...MODEL])}; sleep 30`), 1_500);
    expect(succeeds.row.meta).toMatchObject({ cause: "truncated" });
    expect(succeeds.ms).toBeGreaterThanOrEqual(1_500);

    const seatA = new PaneSeat();
    const paneA = new StreamPane(seatA, (read) => [...HARNESS, ...times(read === 0 ? 0 : 4, WAITING), ...(read === 0 ? [] : MODEL)]);
    const paneSucceeds = await review(seatA, 600, paneVia(paneA));
    expect(paneSucceeds.row.meta).toMatchObject({ cause: "truncated" });
    expect(paneSucceeds.ms).toBeGreaterThanOrEqual(600);

    // Model lines read at the first check, then 450 noise rows push them out of the 400-row snapshot, then three
    // transport lines: the accumulated fact still holds the model line, so the stream runs to its ceiling as at the base.
    const seatB = new PaneSeat();
    const paneB = new StreamPane(seatB, (read) => read === 0 ? MODEL : [...MODEL, ...times(450, ""), ...times(3, WAITING)]);
    const forgotten = await review(seatB, 600, paneVia(paneB));
    expect(forgotten.row.meta).toMatchObject({ cause: "truncated" });
    expect(forgotten.ms).toBeGreaterThanOrEqual(600);
    expect(paneB.reads).toBeGreaterThan(4);

    // The same snapshot read without the earlier check IS reconnect-only: the guard above is the accumulation.
    const tail = new TransportWatch("");
    tail.observe([...times(450, ""), ...times(3, WAITING)].join("\n") + "\n");
    expect(tail.dead).toBe(true);
  }, 60_000);

  test("a reconnect only stream of one or two lines that exits or times out records the transport cause on both paths", async () => {
    const exitsOne = await review(new ShellSeat(`${emit([WAITING])}; exit 1`), 20_000);
    expect(exitsOne.row.meta).toMatchObject({ cause: "transport" });
    expect(exitsOne.row.details).not.toContain("killed at configured review timeout");
    const timesOutTwo = await review(new ShellSeat(`${emit(times(2, WAITING))}; sleep 30`), 800);
    expect(timesOutTwo.row.meta).toMatchObject({ cause: "transport" });
    expect(timesOutTwo.ms).toBeGreaterThanOrEqual(800);

    const seatA = new PaneSeat();
    const paneExit = new StreamPane(seatA, (read, nonce) => read === 0 ? HARNESS : [...HARNESS, WAITING, `TICKMARKR_EXIT_${nonce}:1`]);
    const paneExits = await review(seatA, 20_000, paneVia(paneExit));
    expect(paneExits.row.meta).toMatchObject({ cause: "transport" });
    expect(paneExits.ms).toBeLessThan(10_000);

    const seatB = new PaneSeat();
    const paneTimeout = new StreamPane(seatB, () => [...HARNESS, WAITING, WAITING]);
    const paneTimesOut = await review(seatB, 600, paneVia(paneTimeout));
    expect(paneTimesOut.row.meta).toMatchObject({ cause: "transport" });
    expect(paneTimesOut.ms).toBeGreaterThanOrEqual(600);
  }, 60_000);

  test("a silent stream and a slow model stream keep the base timeout policy while a reconnect only judge stream fails over as before", async () => {
    class Silent extends FakeAdapter { override headlessCommand(): string { return "sleep 30"; } }
    const silent = await review(new Silent(scriptPath()), 600);
    expect(silent.row.meta).toMatchObject({ cause: "silent" });
    expect(silent.ms).toBeGreaterThanOrEqual(600);
    const seatSilent = new PaneSeat();
    const paneSilent = await review(seatSilent, 600, paneVia(new StreamPane(seatSilent, () => [], false)));
    expect(paneSilent.row.meta).toMatchObject({ cause: "silent" });

    const slow = await review(new ShellSeat(`${drip(times(20, "still reading the diff"), 0.1)}; sleep 30`), 1_200);
    expect(slow.row.meta).toMatchObject({ cause: "truncated" });
    expect(slow.ms).toBeGreaterThanOrEqual(1_200);
    // Transport lines, one model line, then a slow stream: the model line ends reconnect-only for good.
    const recovered = await review(new ShellSeat(`${emit(times(2, WAITING))}; sleep 0.2; ${emit([MODEL[0]!])}; ${drip(times(4, WAITING), 0.1)}; sleep 30`), 1_200);
    expect(recovered.row.meta).toMatchObject({ cause: "truncated" });
    expect(recovered.ms).toBeGreaterThanOrEqual(1_200);

    // Judge: the …2493 shape on the configured judge seat fails fast, then GATE-09's failover passes as at the base.
    class DeadJudge extends ShellSeat { override id = "dead"; override vendor = "dead-v"; }
    const { repo, base } = repoWithCommit();
    const good = new FakeAdapter(scriptPath({ judge: [{ pass: true, criteria: [{ criterion: "c1", met: true, reason: "r", evidence: { path: "src/work.ts", line: 1 } }] }] }));
    const cfg = structuredClone(DEFAULT_CONFIG);
    cfg.judge.adapter = "dead";
    cfg.judge.model = "dead-1";
    const pool: BillingChannel[] = [
      { adapter: "dead", vendor: "dead-v", model: "dead-1", channel: "sub", tier: "frontier" },
      { adapter: "fake", vendor: "fake-a", model: "fake-1", channel: "api", tier: "frontier" },
    ];
    const started = Date.now();
    const { results } = await runGates(
      validateGraph({ version: 1, spec: { source: "prd", paths: ["p"], hash: "h" },
        tasks: [{ id: "T1", title: "t", goal: "g", shape: "implement", complexity: 8, acceptance: ["a"], files: [],
          gates: ["build", "test", "lint", "evidence", "scope", "acceptance"] }] }).tasks[0],
      { worktree: repo, baseRef: base, author, result: { ok: true, summary: "", deviations: [], raw: "" },
        commands: {}, baseline: await captureBaseline(repo, {}), channels: [{ ...author, vendor: "author-vendor" }, ...pool],
        judgeChannels: pool, adapters: [new DeadJudge(`${drip(times(17, WAITING), 0.3)}; sleep 30`), good], cfg },
    );
    const acceptance = results.find((r) => r.gate === "acceptance")!;
    expect(acceptance.pass).toBe(true);
    expect(acceptance.meta?.judgeRetry).toMatchObject({ flaked: "dead:dead-1", retried: "fake:fake-1" });
    expect(Date.now() - started).toBeLessThan(30_000);
  }, 90_000);
});

// Repair (reviews of 351fb0f9a and 19c506bf1): both paths read an append-only seat log, never a pane snapshot; Orca's
// snapshots carry no trailing LF; a brief row is removed only inside an evident echo; identical noise across rollovers.
describe("row 417: transport death over the accumulated seat log and the echoed brief", () => {
  const RETRY = "warning: retrying request";
  const briefHead = (seat: PaneSeat) => readFileSync(seat.promptFile, "utf8").split("\n")[0]!;

  test("prefix shaped model rows in the same or an earlier check keep the base timeout on unterminated snapshots", async () => {
    for (const last of ["ERROR", "warning:", "hook:"]) {
      // Same check: three reconnect rows and a final MODEL row whose shape prefixes a TRANSPORT or NOISE form.
      const seatA = new PaneSeat();
      const paneA = new StreamPane(seatA, (read) => [...HARNESS, ...(read === 0 ? [] : [...times(3, WAITING), last])], true, "");
      const sameCheck = await review(seatA, 600, paneVia(paneA));
      expect(sameCheck.row.meta).toMatchObject({ cause: "truncated" });
      expect(sameCheck.ms).toBeGreaterThanOrEqual(600);
      // Earlier check: that row alone, then three reconnect rows after it.
      const seatB = new PaneSeat();
      const paneB = new StreamPane(seatB, (read) => [...HARNESS, last, ...times(Math.min(read, 3), WAITING)], true, "");
      const earlier = await review(seatB, 600, paneVia(paneB));
      expect(earlier.row.meta).toMatchObject({ cause: "truncated" });
      expect(earlier.ms).toBeGreaterThanOrEqual(600);
    }
    // Unterminated snapshots still fail a reconnect-only stream fast.
    const seatC = new PaneSeat();
    const paneC = new StreamPane(seatC, (read) => [...HARNESS, ...times(Math.min(read, 3), WAITING)], true, "");
    const dead = await review(seatC, 20_000, paneVia(paneC));
    expect(dead.row.meta).toMatchObject({ cause: "transport" });
    expect(paneC.reads).toBe(4);
    // Headless: an unfinished pipe write after three reconnect rows holds the kill; complete, it is a MODEL line.
    const unfinished = await review(new ShellSeat(`${emit(times(3, WAITING))}; printf 'ERROR' >&2; sleep 30`), 1_200);
    expect(unfinished.row.meta).toMatchObject({ cause: "truncated" });
    expect(unfinished.ms).toBeGreaterThanOrEqual(1_200);
  }, 120_000);

  test("brief rows printed without an evident echo are the seat's own on both paths and pipes", async () => {
    // No echo; an opening fence (a brief row) then three reconnect rows: MODEL evidence, base timeout.
    const fence = ["```", ...times(3, WAITING)];
    const seatA = new PaneSeat();
    let briefHasFence = false;
    const paneA = new StreamPane(seatA, (read) => {
      briefHasFence ||= readFileSync(seatA.promptFile, "utf8").split("\n").includes("```");
      return [...HARNESS, ...(read === 0 ? ["```"] : fence)];
    }, false);
    const fenced = await review(seatA, 600, paneVia(paneA));
    expect(briefHasFence).toBe(true);
    expect(fenced.row.meta).toMatchObject({ cause: "truncated" });
    expect(fenced.ms).toBeGreaterThanOrEqual(600);
    const fencedHeadless = await review(new ShellSeat(`${emit(fence)}; sleep 30`, false), 1_200);
    expect(fencedHeadless.row.meta).toMatchObject({ cause: "truncated" });

    // No echo; the seat prints the brief's own heading row, then three reconnect rows.
    const seatB = new PaneSeat();
    const paneB = new StreamPane(seatB, (read) => [...HARNESS, briefHead(seatB), ...times(Math.min(read, 3), WAITING)], false);
    const heading = await review(seatB, 600, paneVia(paneB));
    expect(heading.row.meta).toMatchObject({ cause: "truncated" });
    expect(heading.ms).toBeGreaterThanOrEqual(600);
    const headingHeadless = await review(new ShellSeat(`head -n 1 $PROMPT >&2; ${emit(times(3, WAITING))}; sleep 30`, false), 1_200);
    expect(headingHeadless.row.meta).toMatchObject({ cause: "truncated" });

    // The brief holds a literal reconnect row; with no echo the seat's one reconnect row and exit are transport.
    const seatC = new PaneSeat();
    const paneC = new StreamPane(seatC, (read, nonce) => [...HARNESS, WAITING, ...(read === 0 ? [] : [`TICKMARKR_EXIT_${nonce}:1`])], false);
    const oneRow = await review(seatC, 20_000, paneVia(paneC), `${WAITING}\n`);
    expect(oneRow.row.meta).toMatchObject({ cause: "transport" });
    const oneRowHeadless = await review(new ShellSeat(`${emit([WAITING])}; exit 1`, false), 20_000, undefined, `${WAITING}\n`);
    expect(oneRowHeadless.row.meta).toMatchObject({ cause: "transport" });

    // Separate pipes: one reconnect row on stdout, the whole brief (holding that row) echoed on stderr.
    const pipes = await review(new ShellSeat(`printf '%s\\n' ${shq(WAITING)}; exit 1`), 20_000, undefined, `${WAITING}\n`);
    expect(pipes.row.meta).toMatchObject({ cause: "transport" });

    // A real echo is still removed: echoed brief with the reconnect row, then three reconnect rows, fails fast.
    const seatD = new PaneSeat();
    const paneD = new StreamPane(seatD, (read) => [...HARNESS, ...times(Math.min(read, 3), WAITING)]);
    const echoed = await review(seatD, 20_000, paneVia(paneD), `${WAITING}\n`);
    expect(echoed.row.meta).toMatchObject({ cause: "transport" });
    expect(paneD.reads).toBe(4);
  }, 120_000);

  test("identical noise across snapshot rollovers still counts each reconnect once and a repeated read adds nothing", async () => {
    // Each read appends 450 identical noise rows and one reconnect row: every 400-row snapshot is the same text.
    const stream = (read: number) => Array.from({ length: Math.min(read, 3) }, () => [...times(450, RETRY), WAITING]).flat();
    const seat = new PaneSeat();
    const pane = new StreamPane(seat, (read) => [...HARNESS, ...stream(read)]);
    const dead = await review(seat, 20_000, paneVia(pane));
    expect(dead.row.meta).toMatchObject({ cause: "transport" });
    expect(pane.reads).toBe(4);
    expect(pane.closed).toBe(true);

    const watch = new TransportWatch("");
    const log = [...HARNESS, WAITING, WAITING].join("\n") + "\n";
    for (let i = 0; i < 5; i++) watch.observe(log);
    expect(watch.reconnectOnly).toBe(true);
    expect(watch.dead).toBe(false);
  }, 60_000);

  test("bounded: over every reconnect only prefix and every model row position the kill matches the closed rule", () => {
    // Generalised: for streams of up to five rows from {TRANSPORT, NOISE, MODEL} read one row per check, the watch
    // is dead exactly when no MODEL row has been read and at least three TRANSPORT rows have.
    const alphabet = [WAITING, "warning: x", "hook: SessionStart", "```", "ERROR"];
    const all = (n: number): string[][] => n === 0 ? [[]] : all(n - 1).flatMap((rest) => alphabet.map((a) => [a, ...rest]));
    for (let n = 1; n <= 5; n++) for (const rows of all(n)) {
      const watch = new TransportWatch("TICKMARKR-REVIEW head\n```\nERROR");
      for (let k = 1; k <= rows.length; k++) {
        watch.observe(rows.slice(0, k).join("\n") + "\n");
        const read = rows.slice(0, k).map(classifyStreamLine);
        const expected = !read.includes("model") && read.filter((kind) => kind === "transport").length >= 3;
        expect(watch.dead).toBe(expected);
      }
    }
  });
});

// Repair (OBSERVER ruling D-2187 add.120): the reading is a pure function of the whole append-only log — no MODEL
// latch — and a declared adapter harness banner row is NOISE wherever it appears.
describe("row 417: the reading is a pure function of the whole seat log", () => {
  const BANNER = QWEN_HARNESS_BANNER_ROWS[0];
  class BannerShellSeat extends ShellSeat { harnessBannerRows = QWEN_HARNESS_BANNER_ROWS; }
  class BannerPaneSeat extends PaneSeat { harnessBannerRows = QWEN_HARNESS_BANNER_ROWS; }

  test("one transport row then the brief echoed across two checks then two transport rows is transport on both paths", async () => {
    // Pane, exiting: the brief lands half at one check and whole at the next, then two more reconnect rows and exit.
    const echoFrames = (seat: PaneSeat, read: number): string[] => {
      const brief = briefRows(seat);
      return [WAITING, ...(read === 0 ? [] : read === 1 ? brief.slice(0, Math.ceil(brief.length / 2)) : brief)];
    };
    const seatA = new PaneSeat();
    const paneA = new StreamPane(seatA, (read, nonce) => [...echoFrames(seatA, read),
      ...(read >= 3 ? [WAITING, WAITING, `TICKMARKR_EXIT_${nonce}:1`] : [])], false);
    const exits = await review(seatA, 20_000, paneVia(paneA));
    expect(exits.row.meta).toMatchObject({ cause: "transport" });
    expect(exits.ms).toBeLessThan(10_000);
    // Pane, still live at its third reconnect row: failed fast.
    const seatB = new PaneSeat();
    const paneB = new StreamPane(seatB, (read) => [...echoFrames(seatB, read), ...times(Math.max(0, Math.min(read - 2, 2)), WAITING)], false);
    const live = await review(seatB, 20_000, paneVia(paneB));
    expect(live.row.meta).toMatchObject({ cause: "transport" });
    expect(live.ms).toBeLessThan(10_000);
    expect(paneB.closed).toBe(true);

    // Headless: the same stream, the brief split across two writes a check apart.
    const split = `${emit([WAITING])}; sleep 0.3; awk 'NR<=3' $PROMPT >&2; sleep 0.3; awk 'NR>3' $PROMPT >&2; sleep 0.3`;
    const headlessExits = await review(new ShellSeat(`${split}; ${emit(times(2, WAITING))}; exit 1`, false), 20_000);
    expect(headlessExits.row.meta).toMatchObject({ cause: "transport" });
    const headlessLive = await review(new ShellSeat(`${split}; ${drip(times(2, WAITING), 0.2)}; sleep 30`, false), 20_000);
    expect(headlessLive.row.meta).toMatchObject({ cause: "transport" });
    expect(headlessLive.ms).toBeLessThan(10_000);
  }, 120_000);

  test("the whole brief echo then a declared harness banner row then three transport rows fails fast on both paths", async () => {
    const seat = new BannerPaneSeat();
    const pane = new StreamPane(seat, (read) => [BANNER, ...times(Math.min(read, 3), WAITING)]);
    const viaPane = await review(seat, 20_000, paneVia(pane));
    expect(viaPane.row.meta).toMatchObject({ cause: "transport" });
    expect(viaPane.ms).toBeLessThan(10_000);
    expect(pane.closed).toBe(true);

    const headless = await review(new BannerShellSeat(`${emit([BANNER])}; ${drip(times(3, WAITING), 0.2)}; sleep 30`), 20_000);
    expect(headless.row.meta).toMatchObject({ cause: "transport" });
    expect(headless.ms).toBeLessThan(10_000);
    // The banner text is NOISE only as the adapter's declaration: an adapter that declares none reads it as MODEL.
    const undeclared = await review(new ShellSeat(`${emit([BANNER])}; ${emit(times(3, WAITING))}; sleep 30`), 1_200);
    expect(undeclared.row.meta).toMatchObject({ cause: "truncated" });
  }, 120_000);
});

// Repair (review of a4228da68): the seat log never holds the pane preamble, so it is never cut by the preamble walk —
// a first MODEL row shaped like the identity or START row stays MODEL on both paths.
describe("row 417: a first seat row shaped like pane preamble is the seat's own", () => {
  const FIRSTS = ["tickmarkr", "review · checking the diff", "TICKMARKR_START_response"];
  class BareSeat extends FakeAdapter {
    constructor(private readonly tail: string) { super(scriptPath()); }
    override headlessCommand(): string { return this.tail; }
  }

  test("a preamble shaped first model row keeps the base timeout and never records transport on both paths", async () => {
    for (const first of FIRSTS) {
      const watch = new TransportWatch("TICKMARKR-REVIEW\nVERDICT_NONCE: 12345678\n");
      watch.observe([first, ...times(3, WAITING)].join("\n") + "\n");
      expect(watch.dead).toBe(false);

      const seat = new PaneSeat();
      const pane = new StreamPane(seat, (read) => [first, ...times(Math.min(read, 3), WAITING)], false);
      const viaPane = await review(seat, 600, paneVia(pane));
      expect(viaPane.row.meta).toMatchObject({ cause: "truncated" });
      expect(viaPane.ms).toBeGreaterThanOrEqual(600);

      const live = await review(new BareSeat(`${emit([first])}; ${drip(times(3, WAITING), 0.1)}; sleep 30`), 1_200);
      expect(live.row.meta).toMatchObject({ cause: "truncated" });
      expect(live.ms).toBeGreaterThanOrEqual(1_200);
      const exits = await review(new BareSeat(`${emit([first, WAITING])}; exit 1`), 20_000);
      expect(exits.row.meta?.cause).not.toBe("transport");
    }
  }, 120_000);
});

// Repair (OBSERVER ruling D-2187 add.123, contract amendment A): the brief gets the log's normalization, the codex
// header rows are NOISE by their exact patterns only, and an altered echo is never removed.
describe("row 417: amendment A reading of the brief and the codex header", () => {
  const COLOUR_CR = "// \u001b[31mred\u001b[0m left\rright\n";

  test("a brief holding a colour control sequence and a bare CR echoed whole then three transport rows is transport on both paths", async () => {
    const seat = new PaneSeat();
    let raw = "";
    const pane = new StreamPane(seat, (read) => {
      raw = readFileSync(seat.promptFile, "utf8");
      return times(Math.min(read, 3), WAITING);
    });
    const viaPane = await review(seat, 20_000, paneVia(pane), COLOUR_CR);
    expect(raw).toContain("\u001b[31m");
    expect(raw).toContain("left\rright");
    expect(viaPane.row.meta).toMatchObject({ cause: "transport" });
    expect(viaPane.ms).toBeLessThan(10_000);
    expect(pane.reads).toBe(4);
    const seatExit = new PaneSeat();
    const paneExit = new StreamPane(seatExit, (read, nonce) => [WAITING, ...(read === 0 ? [] : [`TICKMARKR_EXIT_${nonce}:1`])]);
    expect((await review(seatExit, 20_000, paneVia(paneExit), COLOUR_CR)).row.meta).toMatchObject({ cause: "transport" });

    const live = await review(new ShellSeat(`${drip(times(3, WAITING), 0.2)}; sleep 30`), 20_000, undefined, COLOUR_CR);
    expect(live.row.meta).toMatchObject({ cause: "transport" });
    expect(live.ms).toBeLessThan(10_000);
    const exits = await review(new ShellSeat(`${emit([WAITING])}; exit 1`), 20_000, undefined, COLOUR_CR);
    expect(exits.row.meta).toMatchObject({ cause: "transport" });
  }, 120_000);

  test("an echo with one line cut short or re-wrapped is never removed and is never failed fast on both paths", async () => {
    const seat = new PaneSeat();
    const pane = new StreamPane(seat, (read) => {
      const [first, ...rest] = briefRows(seat);
      return [...CODEX_HEADER, first!.slice(0, -3), ...rest, ...HARNESS, ...times(Math.min(read, 3), WAITING)];
    }, false);
    const cut = await review(seat, 600, paneVia(pane));
    expect(cut.row.meta).toMatchObject({ cause: "truncated" });
    expect(cut.ms).toBeGreaterThanOrEqual(600);

    const rewrap = `${emit(CODEX_HEADER)}; awk 'NR==1{print substr($0,1,10); print substr($0,11); next}{print}' $PROMPT >&2; ${emit(HARNESS)}`;
    const rewrapped = await review(new ShellSeat(`${rewrap}; ${drip(times(3, WAITING), 0.1)}; sleep 30`, false), 1_200);
    expect(rewrapped.row.meta).toMatchObject({ cause: "truncated" });
    expect(rewrapped.ms).toBeGreaterThanOrEqual(1_200);
  }, 120_000);

  test("a codex header holding a row the formats do not name is never failed fast and never transport on both paths", async () => {
    const header = [...CODEX_HEADER.slice(0, -1), "plan: pro", "user"];
    const seat = new PaneSeat();
    const pane = new StreamPane(seat, (read) => [...header, ...briefRows(seat), ...HARNESS, ...times(Math.min(read, 3), WAITING)], false);
    const viaPane = await review(seat, 600, paneVia(pane));
    expect(viaPane.row.meta).toMatchObject({ cause: "truncated" });
    expect(viaPane.ms).toBeGreaterThanOrEqual(600);

    const live = await review(new ShellSeat(`${drip(times(3, WAITING), 0.1)}; sleep 30`, true, header), 1_200);
    expect(live.row.meta).toMatchObject({ cause: "truncated" });
    expect(live.ms).toBeGreaterThanOrEqual(1_200);
    const exits = await review(new ShellSeat(`${emit([WAITING])}; exit 1`, true, header), 20_000);
    expect(exits.row.meta?.cause).not.toBe("transport");
  }, 120_000);
});

// Repair (review of 7005eb8ab): the headless ended reading is the seat log in its write order, never stdout then stderr.
describe("row 417: the headless ended reading keeps the seat log's order across both pipes", () => {
  test("an echo split across stdout and stderr and a reconnect row interrupting an echo read in write order", async () => {
    // Brief head on stderr, brief tail and one reconnect row on stdout: the log is the whole echo then TRANSPORT.
    const split = await review(new ShellSeat(
      `awk 'NR<=3' $PROMPT >&2; sleep 0.2; awk 'NR>3' $PROMPT; sleep 0.2; printf '%s\\n' ${shq(WAITING)}; sleep 0.2; exit 1`, false), 20_000);
    expect(split.row.meta).toMatchObject({ cause: "transport" });
    // Brief head on stdout, a reconnect row on stderr, brief tail on stdout: the echo is interrupted, so it is MODEL.
    const interrupted = await review(new ShellSeat(
      `awk 'NR<=3' $PROMPT; sleep 0.2; ${emit([WAITING])}; sleep 0.2; awk 'NR>3' $PROMPT; sleep 0.2; exit 1`, false), 20_000);
    expect(interrupted.row.meta?.cause).not.toBe("transport");
  }, 60_000);
});
