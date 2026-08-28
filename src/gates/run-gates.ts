import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { loadavg, tmpdir } from "node:os";
import { join, posix } from "node:path";
import { type Assignment, type BillingChannel, channelKey, shq, type WorkerAdapter, type WorkerResult } from "../adapters/types.js";
import { type TickmarkrConfig, TIER_RANK } from "../config/config.js";
import { getAdapter } from "../adapters/registry.js";
import { GATE_NAMES, type GateName, type Task } from "../graph/schema.js";
import { acceptanceGate } from "./acceptance.js";
import { type Baseline, compareToBaseline } from "./baseline.js";
import { evidenceGate } from "./evidence.js";
import { captureLlmOutput, type GateVia } from "./llm.js";
import { disallowedBy } from "../route/preference.js";
import { marginalCostRank } from "../route/router.js";
import { reviewGate } from "./review.js";
import { scopeGate } from "./scope.js";
import type { GateResult } from "./types.js";
import { shGit } from "../run/git.js";
import { type JudgeInvocationEvidence, withJudgeInvocationEvidence } from "../run/journal.js";

// v2.0 T2 (OBS-554): the host one-minute load average — the decision variable the parked load-aware
// scheduler would key on. Injectable so a test can state the load a gate ran under; production always
// reads os.loadavg. Windows reports [0,0,0] and that is what gets recorded: an honest "unmeasurable
// here" beats a number this module would have to invent.
export type LoadProvider = () => number;
const productionLoadProvider: LoadProvider = () => loadavg()[0] ?? 0;
let loadProvider: LoadProvider = productionLoadProvider;

/** Test seam — inject deterministic load samples; production always reads os.loadavg. */
export function setLoadProviderForTests(provider: LoadProvider): void {
  loadProvider = provider;
}

export function resetLoadProviderForTests(): void {
  loadProvider = productionLoadProvider;
}

interface LlmDispatchClock {
  channel: string;
  preparedAt: number;
  startedAtPath: string;
  completedAtPath: string;
  dir: string;
}

interface LlmDispatchSpan {
  channel: string;
  durationMs: number;
}

/**
 * Instrument the adapter command itself, which is the first adapter-owned operation runLlm performs.
 * acceptanceGate/reviewGate deliberately retain ownership of deterministic oracles, policy checks,
 * diff reads and prompt construction; none of that preprocessing belongs to an LLM invocation span.
 *
 * Both stamps are written by the same shell immediately around the adapter command. That excludes
 * pane-slot acquisition as well as runLlm's scratch cleanup and verdict parsing, without changing
 * llm.ts's output contract. The subshell keeps an adapter command's `exit` from bypassing the end
 * stamp, and the original exit status is preserved.
 */
function instrumentLlmAdapter(adapter: WorkerAdapter, clocks: LlmDispatchClock[]): WorkerAdapter {
  return new Proxy(adapter, {
    get(target, property) {
      if (property === "headlessCommand") {
        return (promptFile: string, model: string): string => {
          const command = target.headlessCommand(promptFile, model);
          const dir = mkdtempSync(join(tmpdir(), "tickmarkr-gate-invocation-"));
          const startedAtPath = join(dir, "started-at");
          const completedAtPath = join(dir, "completed-at");
          clocks.push({
            channel: channelKey({ adapter: target.id, model }),
            preparedAt: Date.now(),
            startedAtPath,
            completedAtPath,
            dir,
          });
          const stamp = (path: string) => `${shq(process.execPath)} -e ${shq('require("node:fs").writeFileSync(process.argv[1], String(Date.now()))')} ${shq(path)}`;
          // End with a status-bearing subshell, not `exit`: pane mode appends its nonce-bound
          // completion trailer on the next script line and must remain able to run it.
          return `${stamp(startedAtPath)}; ( ${command} ); __tickmarkr_invocation_status=$?; ${stamp(completedAtPath)}; (exit $__tickmarkr_invocation_status)`;
        };
      }
      const value: unknown = Reflect.get(target, property, target);
      // Real adapters may use private fields; bind their methods to the target rather than the Proxy.
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

function finishLlmDispatches(clocks: LlmDispatchClock[]): LlmDispatchSpan[] {
  return clocks.map((clock) => {
    let startedAt = clock.preparedAt;
    let completedAt = Date.now();
    try {
      const stampedStart = Number(readFileSync(clock.startedAtPath, "utf8"));
      const stamped = Number(readFileSync(clock.completedAtPath, "utf8"));
      if (Number.isFinite(stampedStart)) startedAt = stampedStart;
      if (Number.isFinite(stamped) && stamped >= startedAt) completedAt = stamped;
    } catch {
      // A killed command may never reach its stamp; the gate return is the honest upper boundary.
    } finally {
      rmSync(clock.dir, { recursive: true, force: true });
    }
    return { channel: clock.channel, durationMs: completedAt - startedAt };
  });
}

async function captureLlmDispatches<T>(
  adapters: WorkerAdapter[],
  run: (instrumented: WorkerAdapter[]) => Promise<T>,
): Promise<{ value: T; outputs: string[]; invocations: LlmDispatchSpan[] }> {
  const clocks: LlmDispatchClock[] = [];
  try {
    const captured = await captureLlmOutput(() => run(adapters.map((a) => instrumentLlmAdapter(a, clocks))));
    return { ...captured, invocations: finishLlmDispatches(clocks) };
  } catch (error) {
    finishLlmDispatches(clocks);
    throw error;
  }
}

/**
 * One gate's own measurement, taken WHERE THE GATE RUNS. `durationMs` sums that gate's execution
 * intervals and nothing between them, so the composite `test` gate (a selected screen, then other
 * gates, then the full suite) reports the two suites' cost rather than the span containing them —
 * and no consumer has to re-derive a duration by subtracting journal timestamps, which measures the
 * queue as well as the work. The load samples bracket the FIRST interval's start and the LAST
 * interval's end: start is what a scheduler would have decided on, end is the state it left behind.
 */
export interface GateTelemetry {
  durationMs: number;
  load1Start: number;
  load1End: number;
}

export type GateEvent =
  // T4 (OBS-265): `parentAt` stamps the two verdict gates that a round launches TOGETHER — judge and
  // review share one parent timestamp, so a surface can tell "ran in parallel" from "ran in sequence"
  // without inferring it from wall-clock. Deterministic gates carry no parent: they are the sequence.
  | { phase: "start"; gate: GateName; index: number; total: number; parentAt?: number }
  | { phase: "end"; gate: GateName; result: GateResult };

export interface GateContext {
  worktree: string;
  baseRef: string;
  result: WorkerResult;
  author: Assignment;
  commands: Record<string, string>;
  baseline: Baseline;
  channels: BillingChannel[];
  // v1.87 T2: the judge-role pool for the GATE-09 failover pick. Absent ⇒ `channels`, so every
  // pre-existing caller keeps its present behaviour; the daemon passes its judge-scoped pool.
  judgeChannels?: BillingChannel[];
  adapters: WorkerAdapter[];
  cfg: TickmarkrConfig;
  via?: GateVia; // v1.1: present → judge/review run as visible named agents through the driver
  excludeReviewers?: string[]; // v1.1: reviewer channels that produced garbage for this task (failover)
  artifactDir?: string; // OBS-196: run dir for raw reviewer-output persistence on unparseable verdicts
  // T4 (OBS-265): "v185" runs the pipeline mechanics this milestone buys — the cheap git checks as a
  // pre-battery screen, a battery that stops at its first red, and judge ‖ review. The daemon always
  // asks for it. The default is the frozen serial walk the gate fixtures outside this task's file
  // scope still pin (tests/gates/judge-retry.test.ts, on-gate.test.ts) — the branch dies with them.
  pipeline?: "v185" | "legacy";
  // T4: this round may run only the tests covering its own diff. The daemon clears it once a test
  // gate has failed for this task. Never a licence to merge on a subset: the merge-candidate round
  // re-runs the FULL suite on the same gated commit before this function reports green.
  selectTests?: boolean;
  // OBS-547: this task's slice of the run's ONE full collateral map (uncapped, computed at run start
  // in the daemon). The gate classifies its red against it; absent ⇒ no classification.
  collateral?: ReadonlyArray<string>;
  onGate?: (e: GateEvent) => void | Promise<void>;
}

const TEST_FILE_RE = /(?:^|\/)[^/]*\.(?:test|spec)\.[cm]?[jt]sx?$/;
// relative specifiers only — `from "./x.js"`, `import("./x.js")`, `require("./x.js")`
const IMPORT_RE = /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*)["'](\.[^"']*)["']/g;
const SELECTION_FILE_CAP = 3000;

/**
 * T4: the tests covering this round's diff, or undefined when the diff cannot be attributed with
 * certainty — a rename or delete (the old path's coverage is gone), or a changed file no test
 * reaches. Coverage: a test file covers itself; a test covers every file reachable from it through
 * relative imports, directly or transitively.
 *
 * ponytail: ceiling — relative specifiers only (no tsconfig paths, no bare aliases, no computed
 * specifiers), and an import cycle contributes only what it had resolved when re-entered. So this
 * CAN miss. The miss is bounded by construction, not by care: the merge-candidate round re-runs the
 * full suite on the same commit, so a miss costs one round and can never merge. Teach it a resolver
 * (tsconfig paths, package exports) if selection ever misses often enough to be worth a round.
 */
async function coveringTests(worktree: string, baseRef: string): Promise<string[] | undefined> {
  const diff = await shGit(`git diff --name-status ${shq(baseRef)} HEAD`, worktree);
  if (diff.code !== 0) return undefined;
  const changed: string[] = [];
  for (const line of diff.stdout.split("\n")) {
    if (!line.trim()) continue;
    const parts = line.split("\t");
    const status = parts[0] ?? "";
    // R (rename) and D (delete): whatever used to cover the old path is unattributable now — full suite.
    if (!status || status[0] === "R" || status[0] === "D" || parts.length < 2) return undefined;
    changed.push(parts[parts.length - 1]!);
  }
  if (!changed.length) return undefined;
  const listed = await shGit("git ls-files", worktree);
  if (listed.code !== 0) return undefined;
  const tracked = listed.stdout.split("\n").filter(Boolean);
  if (tracked.length > SELECTION_FILE_CAP) return undefined; // ponytail: a huge repo pays the full suite rather than a long scan
  const trackedSet = new Set(tracked);
  const tests = tracked.filter((p) => TEST_FILE_RE.test(p));
  if (!tests.length) return undefined;

  const resolveSpec = (from: string, spec: string): string | undefined => {
    const base = posix.join(posix.dirname(from), spec);
    // ESM-TS writes ".js" for a ".ts" source; a directory specifier means its index.
    const candidates = [base, base.replace(/\.js$/, ".ts"), base.replace(/\.jsx$/, ".tsx"),
      `${base}.ts`, `${base}.tsx`, `${base}.js`, `${base}/index.ts`, `${base}/index.js`];
    return candidates.find((c) => trackedSet.has(c));
  };
  const reachCache = new Map<string, Set<string>>();
  const reachOf = (file: string): Set<string> => {
    const cached = reachCache.get(file);
    if (cached) return cached;
    const out = new Set<string>();
    reachCache.set(file, out); // cycle guard: a re-entered file contributes what it has so far
    let src: string;
    try {
      src = readFileSync(posix.join(worktree, file), "utf8");
    } catch {
      return out;
    }
    for (const m of src.matchAll(IMPORT_RE)) {
      const dep = m[1] ? resolveSpec(file, m[1]) : undefined;
      if (!dep || out.has(dep)) continue;
      out.add(dep);
      for (const t of reachOf(dep)) out.add(t);
    }
    return out;
  };

  const selected = new Set<string>();
  for (const file of changed) {
    if (TEST_FILE_RE.test(file)) {
      selected.add(file);
      continue;
    }
    const covering = tests.filter((t) => reachOf(t).has(file));
    if (!covering.length) return undefined; // nothing covers this file — only the full suite can speak for it
    for (const t of covering) selected.add(t);
  }
  return [...selected].sort();
}

/**
 * The configured test command narrowed to these files. Mirrors testFiltered's `--` rule (acceptance.ts:104):
 * npm/yarn/pnpm/npx script wrappers need one `--` to forward positional filters to the underlying runner;
 * a command that already has `--` takes them directly. Every path is quoted — config flows into a shell.
 */
export function testCommandForFiles(testCmd: string, files: string[]): string {
  const wrapped = /^\s*(?:npm|yarn|pnpm|npx)\b/.test(testCmd);
  const fwd = wrapped && !/\s--\s/.test(testCmd) ? " --" : "";
  return `${testCmd}${fwd} ${files.map(shq).join(" ")}`;
}

export async function runGates(
  task: Task,
  ctx: GateContext,
): Promise<{ results: GateResult[]; commits: string[] }> {
  const results: GateResult[] = [];
  let commits: string[] = [];
  const shapeGates = ctx.cfg.gates.byShape?.[task.shape];
  const enabled = (g: GateName) =>
    task.gates.includes(g) && (g !== "acceptance" && g !== "review" || shapeGates?.[g] !== false);
  const failed = () => results.some((r) => !r.pass);
  const v185 = ctx.pipeline === "v185";
  // T4 (OBS-265): a GREEN selected-test run is a screen, not the round's verdict — the merge-candidate
  // round re-runs the full suite on the same commit and THAT is what the round reports. Held here so
  // exactly one `test` gate-result ever leaves a round, always carrying which suite spoke for it.
  // (A RED screen IS the verdict: the round ends there, so it is recorded immediately.)
  let heldTest: GateResult | undefined;
  // v2.0 T2 (OBS-554): this round's per-gate measurement. Every interval a gate actually spends
  // executing is added HERE, at the call site that runs it, so a gate that runs twice (the test
  // gate's screen and its full suite) sums to its own cost and never to the span between them.
  const spans = new Map<string, GateTelemetry>();
  // The test gate's two halves, kept apart as well as summed: `durationMs` alone cannot say whether
  // a slow round was a slow subset or a slow full suite, and the parked scheduler's threshold is
  // defined over the full-suite cost.
  let selectedDurationMs: number | undefined;
  let fullDurationMs: number | undefined;
  const measure = async <T>(gate: string, run: () => Promise<T>): Promise<T> => {
    const at = Date.now();
    const load1Start = loadProvider();
    try {
      return await run();
    } finally {
      const prior = spans.get(gate);
      spans.set(gate, {
        durationMs: (prior?.durationMs ?? 0) + (Date.now() - at),
        load1Start: prior?.load1Start ?? load1Start,
        load1End: loadProvider(),
      });
    }
  };
  // The measurement is attached at the ONE seam every result leaves this function through, so a
  // path that forgets to measure is visibly missing its telemetry rather than carrying a fabricated
  // zero. The daemon lifts these off `meta` onto the gate-result row (src/run/daemon.ts).
  const withTelemetry = (result: GateResult): GateResult => {
    const span = spans.get(result.gate);
    if (!span) return result;
    return {
      ...result,
      meta: {
        ...result.meta,
        ...span,
        ...(result.gate === "test" && selectedDurationMs !== undefined ? { selectedDurationMs } : {}),
        ...(result.gate === "test" && fullDurationMs !== undefined ? { fullDurationMs } : {}),
      },
    };
  };

  const sequence = GATE_NAMES.filter((g) => enabled(g));
  const total = sequence.length;
  const indexOf = (gate: GateName) => sequence.indexOf(gate) + 1;

  // The stamp lands here, on the ONE object that is both pushed and published, so the round's record
  // and its event stream carry byte-identical results — an invariant the fixtures pin.
  const record = async (result: GateResult) => {
    const stamped = withTelemetry(result);
    results.push(stamped);
    await ctx.onGate?.({ phase: "end", gate: stamped.gate as GateName, result: stamped });
  };

  const emitStart = async (gate: GateName, parentAt?: number) => {
    await ctx.onGate?.({ phase: "start", gate, index: indexOf(gate), total, ...(parentAt === undefined ? {} : { parentAt }) });
  };

  // The returned array stays in GATE_NAMES order however few gates a short-circuiting round reached.
  // A round that ends before its merge-candidate stage flushes the held screen on the way out, so a
  // green subset run is still journaled exactly once — as a selected run, which is what it was.
  const done = async () => {
    if (heldTest) {
      const held = heldTest;
      heldTest = undefined;
      await ctx.onGate?.({ phase: "end", gate: "test", result: held }); // stamped when it was held
    }
    const sorted = [...results].sort((a, b) => GATE_NAMES.indexOf(a.gate as GateName) - GATE_NAMES.indexOf(b.gate as GateName));
    // v1.87 T5: no round returns a MERGEABLE GREEN on a dirty tree. The battery is not the only gate
    // that executes shell in this worktree — the acceptance gate runs command and named-test oracles
    // (acceptance.ts:264,275) and both verdict gates dispatch a vendor CLI here — so the last word on
    // cleanliness has to be the round's last act rather than the battery's. `results` is what the
    // daemon merges on (daemon.ts `results.every(gateSatisfied)`), so the withdrawal lands there; the
    // journal keeps both the green and its retraction, the honest record of a verdict that did not
    // survive its own round.
    const last = sorted[sorted.length - 1];
    if (last && sorted.every((r) => r.pass || r.meta?.skipped === true)) {
      const dirt = await dirtyWorktree();
      if (dirt) {
        const refusal = withTelemetry(dirtyRoundRefusal(last.gate as GateName, dirt));
        results[results.indexOf(last)] = refusal;
        sorted[sorted.length - 1] = refusal;
        await ctx.onGate?.({ phase: "end", gate: refusal.gate as GateName, result: refusal });
      }
    }
    return { results: sorted, commits };
  };

  const toolGates = (["build", "test", "lint"] as const).filter(enabled);

  /**
   * v1.87 T5: the shell gates run their commands against the WORKING TREE, while evidence, scope,
   * the judged diff and the merge all read COMMITS. Uncommitted work is therefore visible to
   * build/test/lint and invisible to everything that decides what ships — a green battery on a dirty
   * tree certifies a tree nobody will ever merge, and the committed diff it stands for was never run.
   *
   * That is not gatable-with-a-caveat, so the battery refuses it rather than gating it and hoping.
   * An unreadable `git status` is refused on the same rule: a tree that cannot be proven clean is not
   * proven clean. Returns the dirt (porcelain lines) to name in the refusal, or undefined when clean.
   *
   * The one exemption is tickmarkr's OWN droppings — root-level `.tickmarkr-*` (the adapters' usage
   * record). The harness wrote those, not the worker; they are not work anyone meant to merge, and
   * refusing a tree for the harness's own litter would fail every metered run. Nothing else is
   * exempt: an untracked source file is uncommitted work by every reading git offers.
   */
  const dirtyWorktree = async (): Promise<string | undefined> => {
    const r = await shGit("GIT_OPTIONAL_LOCKS=0 git status --porcelain", ctx.worktree);
    if (r.code !== 0) return `git status failed (exit ${r.code}) — the worktree cannot be proven clean`;
    const entries = r.stdout
      .split("\n")
      .map((l) => l.trimEnd())
      .filter((l) => l.trim() && !/^.. \.tickmarkr-[^/]*$/.test(l));
    return entries.length ? entries.join("\n") : undefined;
  };

  const DIRTY_WHY = `refusing to gate a dirty worktree: the shell gates run against the working tree while `
    + `evidence, scope and the merge read commits, so these uncommitted changes would be gated `
    + `and never merged (and the committed diff would never be run)`;

  // `left` names the command that CREATED the dirt when one did; a round-entry refusal has no culprit.
  const dirtyRefusal = (gate: GateName, dirt: string, left?: string): GateResult => ({
    gate,
    pass: false,
    details: DIRTY_WHY
      + (left ? `. The ${gate} command (${left}) left them behind, so every gate after it would judge a tree nobody will merge:\n` : `:\n`)
      + dirt,
    meta: { dirtyWorktree: true, ...(left ? { dirtiedBy: gate } : {}) },
  });

  // The round-end withdrawal (see `done`). It blames no command: whatever dirtied the tree ran after
  // the last cleanliness check, and naming a culprit this function cannot identify would be a worse
  // record than naming the fact. `gate` is the verdict being withdrawn, not an accusation about who wrote.
  const dirtyRoundRefusal = (gate: GateName, dirt: string): GateResult => ({
    gate,
    pass: false,
    details: `${DIRTY_WHY}. Every gate of this round was satisfied and the round ended dirty — something after `
      + `the last cleanliness check (the acceptance gate's command/test oracles, or a verdict gate's `
      + `vendor CLI) wrote into the worktree — so this mergeable result is withdrawn rather than merged. `
      + `Uncommitted at round end:\n${dirt}`,
    meta: { dirtyWorktree: true, dirtyAtRoundEnd: true },
  });

  // build/test/lint vs the shared baseline
  const runBattery = async (commands: Record<string, string>, selected?: string[]): Promise<void> => {
    if (!toolGates.length) return;
    if (!v185) {
      // ponytail: compareToBaseline batches build/test/lint — their starts are emitted at iteration,
      // not at true execution start. They are collectively sub-second (measured), so the debounce
      // suppresses them anyway; split compareToBaseline only if a tool gate ever gets slow.
      // ponytail: legacy runs build/test/lint in ONE compareToBaseline call, so there is one interval
      // to measure and each of its gates carries it. Split it only if this branch ever stops batching.
      const batchAt = Date.now();
      const batchLoadStart = loadProvider();
      const toolResults = await compareToBaseline(ctx.worktree, commands, ctx.baseline, toolGates);
      const batch: GateTelemetry = { durationMs: Date.now() - batchAt, load1Start: batchLoadStart, load1End: loadProvider() };
      for (const g of toolGates) spans.set(g, batch);
      // The same refusal AFTER the commands, because a green command can dirty the tree the check
      // above just proved clean. Batched, legacy cannot say WHICH command did it, so the refusal
      // lands on the last gate that had one — the round dies there either way. A red battery is
      // reported as the red it is: the round already ends, and the command output is the better lead.
      const dirt = toolResults.every((r) => r.pass) ? await dirtyWorktree() : undefined;
      const blame = dirt ? [...toolGates].reverse().find((g) => commands[g]) : undefined;
      for (const r of toolResults) {
        await emitStart(r.gate as GateName);
        await record(r.gate === blame ? dirtyRefusal(blame!, dirt!, commands[blame!]!) : r);
      }
      return;
    }
    // T4 (OBS-265): one command at a time, stopping at the first red — a failed build no longer buys
    // the full vitest suite before anyone reads its verdict.
    for (const g of toolGates) {
      await emitStart(g);
      const [r] = await measure(g, () => compareToBaseline(ctx.worktree, commands, ctx.baseline, [g]));
      // the screen's interval IS the test gate's first interval, so the split needs no second clock
      if (g === "test" && selected) selectedDurationMs = spans.get("test")!.durationMs;
      // The pre-battery check proves the tree clean ONCE; a command that exits 0 having rewritten a
      // tracked file makes it dirty again, and every gate after it — including the next shell gate,
      // which would then run against bytes HEAD does not hold — inherits that. So re-check after each
      // command, the last one included, and fail the gate whose command did it. (A red command needs
      // no check: it already ends the round, and its own output is the truer verdict.)
      if (r!.pass && commands[g]) {
        const dirt = await dirtyWorktree();
        if (dirt) {
          await record(dirtyRefusal(g, dirt, commands[g]!));
          return;
        }
      }
      if (g === "test" && selected) {
        const screened = { ...r!, meta: { ...r!.meta, selectedTests: selected } };
        // green: held (see heldTest) so the full suite below can supersede it with ONE verdict.
        if (!screened.pass) await record(screened);
        else {
          heldTest = withTelemetry(screened);
          results.push(heldTest);
        }
      } else {
        await record(r!);
      }
      if (failed()) return;
    }
  };

  // The two sub-second git checks, as pure verdicts: no journal, no results push. Both read committed
  // state only (commits ahead of base, `git diff --name-only base..HEAD`), so neither can be moved by
  // anything the battery does to the worktree — which is what lets the screen below trust them early.
  const evidenceResult = async (): Promise<GateResult> => {
    const e = await evidenceGate(ctx.worktree, ctx.baseRef);
    commits = e.commits;
    return { gate: e.gate, pass: e.pass, details: e.details };
  };

  /**
   * v1.87 T5: the allowlist is read ONCE — at entry, before any gate of this round runs — copied out
   * of `ctx.cfg` and frozen. Both halves are the enforcement: the copy means a later write to the
   * daemon's live config object cannot reach the gate mid-round (the screen at line ~296 and the
   * canonical scope gate below are two separate reads of it), and the freeze means nothing this file
   * hands to `scopeGate` can be widened in flight either. Nothing anywhere writes it back.
   *
   * The boundary, stated rather than implied: this binds the allowlist for the lifetime of a round,
   * which is the largest unit this function owns. It cannot speak for a `tickmarkr resume`, which is
   * a new process whose config the daemon resolves afresh (src/run/daemon.ts) — binding an allowlist
   * across a restart would have to live there, is outside this task's file scope, and is claimed
   * neither here nor in the worker prompt. What the prompt does claim is what holds: a WORKER has no
   * way to change this list, mid-round or otherwise.
   */
  const allowDeviations = [...(ctx.cfg.scope?.allowDeviations ?? [])];
  Object.freeze(allowDeviations);

  const scopeResult = (): Promise<GateResult> =>
    scopeGate(ctx.worktree, ctx.baseRef, task.files, ctx.result, allowDeviations,
      ctx.collateral ? { taskId: task.id, predicted: ctx.collateral } : undefined);

  const runGate = async (gate: GateName, compute: () => Promise<GateResult>): Promise<void> => {
    await emitStart(gate);
    await record(await measure(gate, compute));
  };

  /**
   * T4 (OBS-265): the deterministic git checks run BEFORE the battery, as a screen — they answer
   * "is this diff worth starting a ~3.7m tool battery for?" before the first command runs. A red
   * screen IS the round's verdict: what it produced is journaled (in the order it ran) and the round
   * ends there, so a drive-by out-of-scope edit costs <1s instead of the whole battery.
   *
   * A green screen changes nothing downstream. The recorded sequence stays GATE_NAMES order, so the
   * journal, `tickmarkr report`, the surfaces, and resume's GATE_NAMES walk over already-satisfied
   * gates all keep reading exactly one order.
   *
   * ponytail: the price of that is re-reading two git checks (~40ms) in their canonical positions
   * rather than teaching every consumer of the gate stream a second order. Both reads see the same
   * commits — the battery never moves HEAD — so the screen cannot disagree with the gate it screens
   * for. Charge it only when there IS a battery command to protect.
   */
  const screenBlocks = async (): Promise<boolean> => {
    if (!toolGates.some((g) => ctx.commands[g])) return false;
    const screened: GateResult[] = [];
    for (const [gate, compute] of [["evidence", evidenceResult], ["scope", scopeResult]] as const) {
      if (!enabled(gate)) continue;
      screened.push(await measure(gate, compute));
      if (screened[screened.length - 1]!.pass) continue;
      for (const r of screened) {
        await emitStart(r.gate as GateName);
        await record(r);
      }
      return true;
    }
    return false;
  };

  // acceptance judge — LLM spend, so everything deterministic has already passed when this runs
  const runAcceptance = async (): Promise<{ result: GateResult; invocations: JudgeInvocationEvidence[] }> => {
    // v1.87 T2: the judge is a configured seat like any other — check it against the operator's
    // policy BEFORE spending a dispatch on it. disallowedBy carries the whole deny grammar (adapter,
    // model, or adapter:model), so a model-scoped deny cannot slip past an adapter-id-only read.
    const judgeDenied = disallowedBy({ adapter: ctx.cfg.judge.adapter, model: ctx.cfg.judge.model }, ctx.cfg.routing, "judge");
    if (judgeDenied) {
      return {
        result: {
          gate: "acceptance",
          pass: false,
          details: `judge ${channelKey({ adapter: ctx.cfg.judge.adapter, model: ctx.cfg.judge.model })} is disallowed by routing.${judgeDenied.by} (${judgeDenied.entry}) — remove the ${judgeDenied.by} entry or re-point cfg.judge at an allowed channel`,
          meta: { judgeDisallowed: { by: judgeDenied.by, entry: judgeDenied.entry } },
        },
        invocations: [],
      };
    }
    const judgeAdapter = getAdapter(ctx.cfg.judge.adapter, ctx.adapters);
    const jvia = ctx.via
      ? { driver: ctx.via.driver, keep: ctx.via.keep, onSlot: ctx.via.onSlot, name: ctx.via.nameFor("judge", judgeAdapter.id), label: ctx.via.labelFor("judge") }
      : undefined;
    // v1.19 (T2): testCmd threads the detected test runner to the gate so named-test oracles run
    // deterministically (filtered via -t) before any LLM judge dispatch.
    const invocations: JudgeInvocationEvidence[] = [];
    // v2.0 T2 (OBS-554): one entry per JUDGE DISPATCH — primary and the GATE-09 retry alike. The gate's
    // own durationMs is the pair's envelope and cannot answer what the parked ceiling recalibration
    // asks ("how long does ONE healthy judge invocation take?"), so the invocations are kept apart.
    // Separate from `invocations` above deliberately: that array is transcript evidence and records
    // one entry per CAPTURED OUTPUT, so a dispatch that produced none contributes nothing to it.
    const invocationSpans: Array<{ channel: string; durationMs: number }> = [];
    const invokeJudge = async (
      adapter: WorkerAdapter,
      model: string,
      via: typeof jvia,
    ): Promise<GateResult> => {
      const captured = await captureLlmDispatches([adapter], ([instrumented]) =>
        acceptanceGate(
          task,
          ctx.worktree,
          ctx.baseRef,
          { adapter: instrumented!, model },
          via,
          { testCmd: ctx.commands.test, diffCap: ctx.cfg.gates.diffCap },
        ));
      // The instrumented adapter is reached only by runLlm. Deterministic oracles and diff-cap exits
      // never call headlessCommand, so they produce no clock and cannot manufacture an invocation.
      invocationSpans.push(...captured.invocations);
      const unparseable = captured.value.meta?.unparseable === true;
      // acceptanceGate has exactly one runLlm call. Keep the map shape so a future deterministic early
      // return (zero outputs) stays telemetry-free instead of manufacturing a judge invocation.
      for (const [index, output] of captured.outputs.entries()) {
        const span = captured.invocations[index];
        if (!span) continue;
        invocations.push({
          taskId: task.id,
          channel: span.channel,
          outcome: unparseable ? "failed" : "done",
          judgeOutcome: unparseable ? "unparseable" : "parseable",
          durationMs: span.durationMs,
          ...(unparseable ? { transcript: output } : {}),
        });
      }
      return captured.value;
    };
    let a = await invokeJudge(judgeAdapter, ctx.cfg.judge.model, jvia);
    // GATE-09: an unparseable judge verdict retries the JUDGE exactly once on a failover channel — never
    // the worker (run-20260711-185020 P43-03 L70-72 billed a judge flake as a worker attempt). The flaked
    // first verdict NEVER enters results (no false gate-result journal event, no operator notify, no stale
    // failed() short-circuit — research Pitfall 5). Detection is meta-only (D-03), never string-matching
    // details. The v1.1 badReviewers precedent's TIMING can't transfer: its failover lands on the NEXT
    // worker attempt — exactly what this fix forbids; only its meta-carries-channel pattern is mirrored.
    // Straight-line single `if` — NO loop/counter/knob: exactly-once by construction (a knob is a
    // fail-closed weakening vector); a second garbage verdict fails the gate closed exactly as today.
    // T6: exclusion mirrors consult reroute semantics — the flaked channel's whole adapter is banned, not
    // just its exact channel key, so an outage window cannot re-select the vendor being routed around.
    // If no other adapter is live, the exclusion degrades to a channel-level reroute within the same
    // adapter so a single-adapter fleet still retries (matching the daemon's unknown-excludeAdapter
    // degradation path).
    if (a.meta?.unparseable === true && typeof a.meta.judge === "string") {
      const flakedKey = a.meta.judge;
      const flakedAdapter = flakedKey.slice(0, flakedKey.indexOf(":"));
      const pick = (pool: BillingChannel[]) => pool
        // pickReviewer's sort (review.ts:37): TIER_RANK desc, marginalCostRank asc — proven ordering; both
        // symbols already imported by a sibling gate file.
        .sort((x, y) => TIER_RANK[y.tier] - TIER_RANK[x.tier] || marginalCostRank(x) - marginalCostRank(y))[0];
      // v1.87 T2: the failover seat obeys the same policy the primary judge just passed — a denied
      // channel is refused here too, never reached by falling through the exclusion arms below.
      const judgePool = (ctx.judgeChannels ?? ctx.channels).filter((c) => disallowedBy(c, ctx.cfg.routing, "judge") === null);
      const crossAdapter = pick(judgePool.filter((c) => c.adapter !== flakedAdapter));
      const sameAdapter = pick(judgePool.filter((c) => c.adapter === flakedAdapter && channelKey(c) !== flakedKey));
      // Prefer a different adapter; if the fleet only has one adapter, retry on a different channel of
      // that adapter; if the fleet has only one channel, fall back to the original judge config.
      const retry = crossAdapter ?? sameAdapter ?? { adapter: ctx.cfg.judge.adapter, model: ctx.cfg.judge.model };
      const retryAdapter = getAdapter(retry.adapter, ctx.adapters);
      const retryJvia = ctx.via
        // unconditional -r1 suffix: under keepPanes:forever a same-channel retry cannot collide with the
        // still-open first pane (herdr agent_name_taken regression, research Pitfall 4)
        ? { driver: ctx.via.driver, keep: ctx.via.keep, onSlot: ctx.via.onSlot, name: ctx.via.nameFor("judge", retryAdapter.id) + "-r1", label: ctx.via.labelFor("judge") }
        : undefined;
      // the retry IS a second acceptanceGate call: one code path, one parser, zero new parse leniency.
      a = await invokeJudge(retryAdapter, retry.model, retryJvia);
      a = { ...a, meta: { ...a.meta, judgeRetry: { flaked: flakedKey, retried: channelKey({ adapter: retry.adapter, model: retry.model }) } } };
    }
    // No dispatch, no key: a deterministic-oracle round writes no `invocations` field rather than an
    // empty array a reader could mistake for "measured, and it cost nothing".
    return { result: invocationSpans.length ? { ...a, meta: { ...a.meta, invocations: invocationSpans } } : a, invocations };
  };

  // cross-vendor review
  const runReview = async (): Promise<GateResult> => {
    // v2.0 T2: per-dispatch spans, exactly as the judge keeps them. A round that re-asks a second
    // seat spends two invocations, and one blended span cannot tell a slow reviewer from two.
    // A pick that found NO eligible seat dispatched nothing, so it contributes no invocation.
    const invocations: Array<{ channel: string; durationMs: number }> = [];
    // Dispatch is PROVEN, never inferred: captureLlmOutput records one output per runLlm return, so an
    // empty capture means reviewGate returned before asking anyone — a policy skip, a pre-dispatch diff
    // cap, or no eligible seat. Reading `noEligibleReviewer` alone missed the first two and invented
    // an "unknown" span for each.
    const dispatch = async (run: (adapters: WorkerAdapter[]) => Promise<GateResult>): Promise<GateResult> => {
      const captured = await captureLlmDispatches(ctx.adapters, run);
      invocations.push(...captured.invocations);
      return captured.value;
    };
    let rv = await dispatch((adapters) => reviewGate(task, ctx.worktree, ctx.baseRef, ctx.author, ctx.channels, adapters, ctx.cfg, ctx.via, ctx.excludeReviewers, ctx.artifactDir));
    // OBS-193: an unparseable review verdict retries the REVIEW exactly once on a different reviewer —
    // never the worker (GATE-09's judge-retry shape: straight-line single `if`, meta-only detection,
    // the flaked verdict never enters results). The exclusion rides reviewGate's own excludeReviewers
    // parameter, so pickReviewer's diversity rules still govern the retry seat; a fleet with no second
    // eligible seat keeps the ORIGINAL result so the recorded cause stays truthful (OBS-196).
    if (rv.meta?.unparseable === true && typeof rv.meta.reviewer === "string") {
      const flaked = rv.meta.reviewer;
      const retryVia = ctx.via
        ? { ...ctx.via, nameFor: (role: "judge" | "review", adapter: string) => ctx.via!.nameFor(role, adapter) + "-r1" }
        : undefined;
      const second = await dispatch((adapters) => reviewGate(
        task, ctx.worktree, ctx.baseRef, ctx.author, ctx.channels, adapters, ctx.cfg,
        retryVia, [...(ctx.excludeReviewers ?? []), flaked], ctx.artifactDir,
      ));
      if (second.meta?.noEligibleReviewer !== true) {
        const retried = typeof second.meta?.reviewer === "string" ? second.meta.reviewer : "none";
        rv = {
          ...second,
          // `details` is lifted onto the journal's gate-result row; meta.reviewRetry is not. Keep the
          // re-route visible in the result text a reader actually opens, including on a red retry.
          details: `review re-route: ${flaked} produced no parseable verdict; replaced by ${retried}\n${second.details}`,
          meta: { ...second.meta, reviewRetry: { flaked, retried } },
        };
      } else if (task.routingHints?.floor) {
        // Preserve the original no-answer cause when no replacement exists, but name the declared
        // floor that correctly refused a lower-tier fallback.
        rv = { ...rv, details: `${rv.details}\nreview re-route refused: ${second.details}` };
      }
    }
    return invocations.length ? { ...rv, meta: { ...rv.meta, invocations } } : rv;
  };

  // v1.87 T5: the refusal is the FIRST thing a round does, whatever that round is configured to run.
  // Guarding only the configured build/test/lint commands left the hole this repairs: the battery is
  // not the only gate that executes shell in this worktree — the acceptance gate runs command and
  // named-test oracles — so a task with NO tool command configured skipped the check entirely and its
  // oracles judged uncommitted state, on a commit whose diff nobody had run. One check at the top, and
  // no shell-executing gate path is reachable on a dirty tree. It lands on the first gate of this
  // round's sequence: the round dies there, exactly as it does on a red command.
  // The check runs BEFORE any gate, so on a clean tree it belongs to no gate: charging every round's
  // first gate for it would inflate the one measurement the parked recalibrations key on. It becomes
  // that gate's interval only on the path where it IS what the gate did — the refusal below.
  const entryAt = Date.now();
  const entryLoad = loadProvider();
  const entryDirt = sequence.length ? await dirtyWorktree() : undefined;
  if (entryDirt) {
    spans.set(sequence[0]!, { durationMs: Date.now() - entryAt, load1Start: entryLoad, load1End: loadProvider() });
    await emitStart(sequence[0]!);
    await record(dirtyRefusal(sequence[0]!, entryDirt));
    return done();
  }

  if (v185 && await screenBlocks()) return done();

  // A non-final round may run only the tests covering its own diff; the merge-candidate round below
  // pays the full suite anyway, so a selection that misses costs a round and can never merge.
  const selected = v185 && ctx.selectTests && enabled("test") && ctx.commands.test
    ? await coveringTests(ctx.worktree, ctx.baseRef)
    : undefined;
  await runBattery(
    selected ? { ...ctx.commands, test: testCommandForFiles(ctx.commands.test!, selected) } : ctx.commands,
    selected,
  );
  if (failed()) return done();
  if (enabled("evidence")) {
    await runGate("evidence", evidenceResult);
    if (failed()) return done();
  }
  if (enabled("scope")) {
    await runGate("scope", scopeResult);
    if (failed()) return done();
  }

  if (v185 && (enabled("acceptance") || enabled("review"))) {
    // Judge and review are launched TOGETHER (96m of serialization over 5 runs). Enforcement is
    // unchanged — it is still the AND of both, both still fail closed, and neither reads the other's
    // verdict: each gets the same commit and the same brief it always got, and neither promise is
    // reachable from inside the other. Only the waiting is gone.
    const parentAt = Date.now();
    // Both starts are emitted before either gate is launched, so the stream's order is the round's
    // order and not a race between two dispatches. BOTH ARE IN FLIGHT BEFORE EITHER IS AWAITED:
    // whichever adapter is slower no longer decides when the other one runs.
    if (enabled("acceptance")) await emitStart("acceptance", parentAt);
    if (enabled("review")) await emitStart("review", parentAt);
    const judging = enabled("acceptance") ? measure("acceptance", runAcceptance) : undefined;
    const reviewing = enabled("review") ? measure("review", runReview) : undefined;
    // Attach BOTH publication handlers before awaiting either. Dispatch concurrency alone is not
    // enough: an acceptance-first await withholds a completed review behind a slow/hung judge and a
    // process death can lose that already-earned verdict. The returned result is still sorted into
    // GATE_NAMES order by done(); the event stream truthfully records each independent completion.
    const judged = judging?.then((outcome) =>
      withJudgeInvocationEvidence(outcome.invocations, () => record(outcome.result)));
    const reviewed = reviewing?.then((outcome) => record(outcome));
    await Promise.all([judged, reviewed]);
    if (failed()) return done();
  } else if (!v185) {
    // Legacy serial walk — frozen, and reachable only from the fixtures that pin it.
    if (enabled("acceptance")) {
      await emitStart("acceptance");
      const judged = await measure("acceptance", runAcceptance);
      await withJudgeInvocationEvidence(judged.invocations, () => record(judged.result));
      if (failed()) return done();
    }
    if (enabled("review")) {
      await emitStart("review");
      await record(await measure("review", runReview));
    }
    return done();
  }

  // The merge-candidate round: every other gate is green, so THIS round is the one that can merge —
  // the full suite runs on the exact gated commit before the pipeline reports green. Nothing merges
  // on a subset (spec: "nothing merges without a complete green suite"). Its verdict SUPERSEDES the
  // held screen rather than joining it: one `test` entry in the record, one `test` end event in the
  // stream, and `fullSuite` says which suite spoke while `selectedTests` keeps what the screen ran.
  if (selected) {
    await emitStart("test");
    // This is the last shell command a round can run — the judge's named-test oracle (acceptance.ts)
    // may have run one before it, and every gate between the battery and here reads commits only, so
    // a clean tree HERE is what makes "the gated commit is the tested tree" true at merge time.
    const [full] = await measure("test", () => compareToBaseline(ctx.worktree, ctx.commands, ctx.baseline, ["test"]));
    fullDurationMs = spans.get("test")!.durationMs - (selectedDurationMs ?? 0);
    const dirt = full!.pass ? await dirtyWorktree() : undefined;
    const merged = withTelemetry(dirt
      ? dirtyRefusal("test", dirt, ctx.commands.test!)
      : { ...full!, meta: { ...full!.meta, fullSuite: true, selectedTests: selected } });
    results[results.findIndex((r) => r.gate === "test")] = merged;
    heldTest = undefined;
    await ctx.onGate?.({ phase: "end", gate: "test", result: merged });
  }
  return done();
}
