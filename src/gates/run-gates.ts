import { readFileSync } from "node:fs";
import { posix } from "node:path";
import { type Assignment, type BillingChannel, channelKey, shq, type WorkerAdapter, type WorkerResult } from "../adapters/types.js";
import { type TickmarkrConfig, TIER_RANK } from "../config/config.js";
import { getAdapter } from "../adapters/registry.js";
import { GATE_NAMES, type GateName, type Task } from "../graph/schema.js";
import { acceptanceGate } from "./acceptance.js";
import { type Baseline, compareToBaseline } from "./baseline.js";
import { evidenceGate } from "./evidence.js";
import { captureLlmOutput, type GateVia } from "./llm.js";
import { marginalCostRank } from "../route/router.js";
import { reviewGate } from "./review.js";
import { scopeGate } from "./scope.js";
import type { GateResult } from "./types.js";
import { shGit } from "../run/git.js";
import { type JudgeInvocationEvidence, withJudgeInvocationEvidence } from "../run/journal.js";

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
  const sequence = GATE_NAMES.filter((g) => enabled(g));
  const total = sequence.length;
  const indexOf = (gate: GateName) => sequence.indexOf(gate) + 1;

  const record = async (result: GateResult) => {
    results.push(result);
    await ctx.onGate?.({ phase: "end", gate: result.gate as GateName, result });
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
      await ctx.onGate?.({ phase: "end", gate: "test", result: held });
    }
    return {
      results: [...results].sort((a, b) => GATE_NAMES.indexOf(a.gate as GateName) - GATE_NAMES.indexOf(b.gate as GateName)),
      commits,
    };
  };

  const toolGates = (["build", "test", "lint"] as const).filter(enabled);

  // build/test/lint vs the shared baseline
  const runBattery = async (commands: Record<string, string>, selected?: string[]): Promise<void> => {
    if (!toolGates.length) return;
    if (!v185) {
      // ponytail: compareToBaseline batches build/test/lint — their starts are emitted at iteration,
      // not at true execution start. They are collectively sub-second (measured), so the debounce
      // suppresses them anyway; split compareToBaseline only if a tool gate ever gets slow.
      const toolResults = await compareToBaseline(ctx.worktree, commands, ctx.baseline, toolGates);
      for (const r of toolResults) {
        await emitStart(r.gate as GateName);
        await record(r);
      }
      return;
    }
    // T4 (OBS-265): one command at a time, stopping at the first red — a failed build no longer buys
    // the full vitest suite before anyone reads its verdict.
    for (const g of toolGates) {
      await emitStart(g);
      const [r] = await compareToBaseline(ctx.worktree, commands, ctx.baseline, [g]);
      if (g === "test" && selected) {
        const screened = { ...r!, meta: { ...r!.meta, selectedTests: selected } };
        // green: held (see heldTest) so the full suite below can supersede it with ONE verdict.
        if (!screened.pass) await record(screened);
        else {
          heldTest = screened;
          results.push(screened);
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

  const scopeResult = (): Promise<GateResult> =>
    scopeGate(ctx.worktree, ctx.baseRef, task.files, ctx.result, ctx.cfg.scope?.allowDeviations ?? []);

  const runGate = async (gate: GateName, compute: () => Promise<GateResult>): Promise<void> => {
    await emitStart(gate);
    await record(await compute());
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
      screened.push(await compute());
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
    const judgeAdapter = getAdapter(ctx.cfg.judge.adapter, ctx.adapters);
    const jvia = ctx.via
      ? { driver: ctx.via.driver, keep: ctx.via.keep, onSlot: ctx.via.onSlot, name: ctx.via.nameFor("judge", judgeAdapter.id), label: ctx.via.labelFor("judge") }
      : undefined;
    // v1.19 (T2): testCmd threads the detected test runner to the gate so named-test oracles run
    // deterministically (filtered via -t) before any LLM judge dispatch.
    const invocations: JudgeInvocationEvidence[] = [];
    const invokeJudge = async (
      adapter: WorkerAdapter,
      model: string,
      via: typeof jvia,
    ): Promise<GateResult> => {
      const started = Date.now();
      const captured = await captureLlmOutput(() =>
        acceptanceGate(
          task,
          ctx.worktree,
          ctx.baseRef,
          { adapter, model },
          via,
          { testCmd: ctx.commands.test, diffCap: ctx.cfg.gates.diffCap },
        ));
      const channel = channelKey({ adapter: adapter.id, model });
      const unparseable = captured.value.meta?.unparseable === true;
      // acceptanceGate has exactly one runLlm call. Keep the map shape so a future deterministic early
      // return (zero outputs) stays telemetry-free instead of manufacturing a judge invocation.
      for (const output of captured.outputs) {
        invocations.push({
          taskId: task.id,
          channel,
          outcome: unparseable ? "failed" : "done",
          judgeOutcome: unparseable ? "unparseable" : "parseable",
          durationMs: Date.now() - started,
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
      const crossAdapter = pick(ctx.channels.filter((c) => c.adapter !== flakedAdapter));
      const sameAdapter = pick(ctx.channels.filter((c) => c.adapter === flakedAdapter && channelKey(c) !== flakedKey));
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
    return { result: a, invocations };
  };

  // cross-vendor review
  const runReview = async (): Promise<GateResult> => {
    let rv = await reviewGate(task, ctx.worktree, ctx.baseRef, ctx.author, ctx.channels, ctx.adapters, ctx.cfg, ctx.via, ctx.excludeReviewers, ctx.artifactDir);
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
      const second = await reviewGate(
        task, ctx.worktree, ctx.baseRef, ctx.author, ctx.channels, ctx.adapters, ctx.cfg,
        retryVia, [...(ctx.excludeReviewers ?? []), flaked], ctx.artifactDir,
      );
      if (second.meta?.noEligibleReviewer !== true) {
        const retried = typeof second.meta?.reviewer === "string" ? second.meta.reviewer : "none";
        rv = { ...second, meta: { ...second.meta, reviewRetry: { flaked, retried } } };
      }
    }
    return rv;
  };

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
    const judging = enabled("acceptance") ? runAcceptance() : undefined;
    const reviewing = enabled("review") ? runReview() : undefined;
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
      const judged = await runAcceptance();
      await withJudgeInvocationEvidence(judged.invocations, () => record(judged.result));
      if (failed()) return done();
    }
    if (enabled("review")) {
      await emitStart("review");
      await record(await runReview());
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
    const [full] = await compareToBaseline(ctx.worktree, ctx.commands, ctx.baseline, ["test"]);
    const merged = { ...full!, meta: { ...full!.meta, fullSuite: true, selectedTests: selected } };
    results[results.findIndex((r) => r.gate === "test")] = merged;
    heldTest = undefined;
    await ctx.onGate?.({ phase: "end", gate: "test", result: merged });
  }
  return done();
}
