import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { shq } from "../adapters/types.js";
import type { TickmarkrConfig } from "../config/config.js";
import {
  type Baseline,
  baselineEntryRefusal,
  type BaselineProvenance,
  beginGateEvidence,
  type GateEvidenceOptions,
  ceilingKillResult,
  classifyFreshRunnerOutput,
  classifyRunnerOutput,
  fileCountDeficit,
  waitForCalmWindow,
  effectiveCeilingMs,
  classifiedFileDurations,
  type FailureClassification,
  fingerprint,
  freshFailures,
} from "../gates/baseline.js";
import { evaluateManifestedTest, isVitestTestCommand } from "../gates/test-manifest.js";
import {
  computeVerificationIdentity,
  formatReusedDetails,
  getVerdictStore,
  getWorktreeTree,
  resolveStateDir,
  isInfraResult,
  type VerificationIdentity,
} from "../gates/cache.js";
import { dependencyLinkRefusal, describeCapacity, resolveIntegrationBranch, resolvedCapacity, sameCapacity, sh, shGit } from "./git.js";
import { executionSignal } from "./execution-budget.js";
import type { GateEvidenceReceipt } from "./protocol.js";

// Diagnostic convenience logs are observational, just like receipt persistence.
function writeTipLog(path: string, text: string): void {
  try { writeFileSync(path, text); } catch { /* the command verdict remains authoritative */ }
}

export interface TipVerifyResult {
  evidenceReceipt?: GateEvidenceReceipt;
  evidenceReceipts?: GateEvidenceReceipt[];
  evidenceAbsence?: "provenance-refused" | "not-started" | "historical-cache";
  /** Directory the evidence setup returned; receipt artifact paths resolve against it. */
  originRunRoot?: string;
  nonce?: string;
  stdoutPath?: string;
  stderrPath?: string;
  gate: string;
  cmd: string;
  pass: boolean;
  exitCode: number;
  fingerprints: string[];
  details: string;
  artifact?: string;
  reportPath?: string;
  spawnedCommand?: string;
  /** Q121s: nonzero exit whose failures are ALL baseline-recorded — forgiven exactly as the battery forgives. */
  forgiven?: boolean;
  /** OBS-1123: the capture that recorded the forgiven fingerprints; absent for a legacy baseline that never said. */
  baselineProvenance?: BaselineProvenance;
  /** D-131: carried from a persisted per-gate verdict — this cycle did NOT execute the command. */
  reused?: true;
  /**
   * OBS-534: what a nonzero exit is evidence OF, taken from the battery's own readers — `ceilingKillResult`
   * for a kill, the shared runner classifier for everything else. `infra` means nothing was verified.
   */
  cause?: FailureClassification;
  /** 2.8.1 T1: with `deferVerdicts`, the verdict-store write this result would have made, left to the caller. */
  deferredVerdict?: { id: VerificationIdentity; verdict: TipVerifyResult & { meta: Record<string, unknown> } };
}

/** Carry execution evidence without minting an invocation or rebasing its artifact paths. */
export function reusedTipEvidence(source: Partial<TipVerifyResult>): Partial<TipVerifyResult> {
  return {
    reused: true,
    ...(source.evidenceReceipt ? { evidenceReceipt: source.evidenceReceipt } : {}),
    ...(source.evidenceReceipts ? { evidenceReceipts: source.evidenceReceipts } : {}),
    ...(source.originRunRoot ? { originRunRoot: source.originRunRoot } : {}),
    ...(!source.evidenceReceipt
      ? { evidenceAbsence: source.evidenceAbsence ?? "historical-cache" }
      : source.evidenceAbsence ? { evidenceAbsence: source.evidenceAbsence } : {}),
    ...(source.nonce !== undefined ? { nonce: source.nonce } : {}),
    ...(source.stdoutPath !== undefined ? { stdoutPath: source.stdoutPath } : {}),
    ...(source.stderrPath !== undefined ? { stderrPath: source.stderrPath } : {}),
  };
}

export function integrationBranch(cfg: TickmarkrConfig, runId: string): string {
  return `${cfg.integrationBranchPrefix}${runId}`;
}

/**
 * 2.8.1 T2 (ANL-023 §7.2): creates the integration ref create-only at `baseRef` (the empty old value means "must not
 * exist") and returns the published tip E. The run keeps no checkout of the branch: every later publication is a
 * compare-and-swap of the ref from `repo` (mergeTask). An existing or uncreatable ref throws — the fatal path's text.
 */
export async function ensureIntegration(repo: string, branch: string, baseRef: string): Promise<string> {
  branch = await resolveIntegrationBranch(repo, branch);
  // ponytail: no --create-reflog (ANL-023 §7.2 names it): the repository's own core.logAllRefUpdates decides, because
  // nothing reads this reflog (X10) and run-end-integration's E-P10 builds its no-reflog legacy branch through a fresh
  // run with logging disabled. Add the flag back once that fixture builds its legacy branch by hand.
  const r = await shGit(`git update-ref --no-deref -m ${shq("tickmarkr: run start")} ${shq(`refs/heads/${branch}`)} ${shq(baseRef)} ""`, repo);
  if (r.code !== 0) throw new Error(`integration branch ${branch} already exists or cannot be created: ${(r.stderr || r.stdout).trim()}`);
  return baseRef;
}

/** 2.8.1 T1 (ANL-023 §7.1): the closed states of the integration ref, as R(ref) reads them. */
export type IntegrationRefState =
  | { kind: "regular"; commit: string }
  | { kind: "missing" }
  | { kind: "symbolic"; target: string; commit?: string } // no commit: the target names none (dangling)
  | { kind: "unreadable"; read: string };

export type IntegrationLeg = "symbolic" | "missing" | "value" | "unreadable";

/**
 * R(ref): the integration ref read from `repo` through the own-git runner, never its reflog. The exact ref only —
 * a descendant ref (`refs/heads/<branch>/x`) is not this ref, and a ref that exists but names no commit is unreadable.
 */
export async function readIntegrationRef(repo: string, branch: string): Promise<IntegrationRefState> {
  const ref = `refs/heads/${branch}`;
  const unreadable = (cmd: string, r: { code: number; stderr: string; stdout: string }): IntegrationRefState =>
    ({ kind: "unreadable", read: `${cmd} exited ${r.code}${(r.stderr || r.stdout).trim() ? `: ${(r.stderr || r.stdout).trim()}` : ""}` });
  const symbolic = await shGit(`git symbolic-ref -q ${shq(ref)}`, repo);
  if (symbolic.code !== 0 && symbolic.code !== 1) return unreadable("git symbolic-ref", symbolic);
  const commit = await shGit(`git rev-parse --verify -q ${shq(`${ref}^{commit}`)}`, repo);
  if (commit.code !== 0 && commit.code !== 1) return unreadable("git rev-parse", commit);
  const found = commit.code === 0 ? commit.stdout.trim() : undefined;
  if (symbolic.code === 0) return { kind: "symbolic", target: symbolic.stdout.trim(), ...(found ? { commit: found } : {}) };
  if (found) return { kind: "regular", commit: found };
  const exists = await shGit(`git show-ref --verify -q ${shq(ref)}`, repo);
  return exists.code === 1 ? { kind: "missing" } : unreadable("git show-ref", exists);
}

/** I(x): holds iff the ref is regular at x; otherwise the leg, with the state the repair text is chosen by. */
export async function checkIntegrationIdentity(repo: string, branch: string, expected: string):
Promise<{ ok: true; state: IntegrationRefState } | { ok: false; leg: IntegrationLeg; state: IntegrationRefState }> {
  const state = await readIntegrationRef(repo, branch);
  if (state.kind === "regular" && state.commit === expected) return { ok: true, state };
  return { ok: false, leg: state.kind === "regular" ? "value" : state.kind, state };
}

/**
 * The repair text (shared by run end's failure row, the merge park and the resume refusal): backticked commands run
 * from the repository root in order, stopping at the first that fails. A found commit is preserved create-only under
 * refs/tickmarkr/found/<runId>/<F> before a no-deref compare-and-swap restores the ref; a symbolic found ref or one
 * already holding another commit stops the sequence before the restore. Dangling and unreadable print no command.
 */
export function integrationRepairText(state: IntegrationRefState, branch: string, runId: string, expected: string): string {
  const ref = `refs/heads/${branch}`;
  const byHand = `inspect ${ref} and restore it to ${expected} by hand`;
  const found = state.kind === "regular" ? state.commit : state.kind === "symbolic" ? state.commit : undefined;
  if (found) {
    const keep = `refs/tickmarkr/found/${runId}/${found}`;
    return `\`test -z "$(git symbolic-ref -q ${keep})"\` then \`test "$(git rev-parse -q --verify ${keep})" = ${found} || git update-ref --no-deref ${keep} ${found} ""\` then \`git update-ref --no-deref ${ref} ${expected} ${found}\``;
  }
  if (state.kind === "missing") return `\`git update-ref --no-deref ${ref} ${expected} ""\``;
  if (state.kind === "symbolic") return `symbolic to ${state.target}, which names no commit; ${byHand}`;
  return state.kind === "unreadable" ? `${ref} is unreadable (${state.read}); ${byHand}` : byHand;
}

type GitResult = { code: number; stdout: string; stderr: string };
/** The merge's git steps after the identity check, in order; `publish` is the compare-and-swap. */
export type MergeStep = "ancestry" | "merge-tree" | "commit-tree" | "publish";
/** Test-only: runs before each step; a returned result replaces that step's git result (never `publish`'s). */
export type MergeSeam = (step: MergeStep) => Promise<GitResult | void> | GitResult | void;
export interface IntegrationMove {
  branch: string; expected: string; found: string | null; leg: IntegrationLeg; target?: string; stage: "check" | "publish";
}
export type MergeOutcome =
  | { ok: true; commit: string; from: string }
  | { ok: true; alreadyMerged: string }
  | { ok: false; tipMoved: { gatedCommit: string; branchTip: string } }
  | { ok: false; conflict: string }
  | { ok: false; integrationMoved: IntegrationMove; state: IntegrationRefState }
  | { ok: false; alreadyIntegrated: { gated: string; tip: string } }
  | { ok: false; infra: { step: MergeStep; message: string } };

/**
 * 2.8.1 T2 (ANL-023 §7.2): publishes `gated` onto the integration ref by compare-and-swap from the stored tip
 * `expected`, all git from `repo` — no checkout. (1) the task-tip check; (2) I(expected); (3) ancestry; (4) merge-tree;
 * (5) commit-tree; (6) `update-ref --no-deref` from `expected`; (7) `onPublished(M)` in the same synchronous
 * continuation as (6)'s result, so the caller's rows land in publication order. `merged` is the task's recorded merge
 * commits, newest first: a gated commit already in the history is done only through its own recorded merge.
 * `ancestorOnly` (a replay that ran no gates): a gated commit not in E is refused `infra`, never published.
 */
export async function mergeTask(
  repo: string,
  { branch, expected, merged = [], ancestorOnly = false }: { branch: string; expected: string; merged?: readonly string[]; ancestorOnly?: boolean },
  taskBranch: string,
  message: string,
  gated: string,
  onPublished: (commit: string) => void,
  seam?: MergeSeam,
): Promise<MergeOutcome> {
  const tip = await shGit(`git rev-parse --verify ${shq(`refs/heads/${taskBranch}`)}`, repo);
  if (tip.code !== 0) return { ok: false, conflict: tip.stderr || tip.stdout };
  const branchTip = tip.stdout.trim();
  if (branchTip !== gated) return { ok: false, tipMoved: { gatedCommit: gated, branchTip } };

  const moved = (leg: IntegrationLeg, state: IntegrationRefState, stage: IntegrationMove["stage"]): MergeOutcome => ({
    ok: false, state, integrationMoved: { branch, expected, leg, stage,
      found: (state.kind === "regular" || state.kind === "symbolic" ? state.commit : undefined) ?? null,
      ...(state.kind === "symbolic" ? { target: state.target } : {}) },
  });
  const infra = (step: MergeStep, r: GitResult): MergeOutcome =>
    ({ ok: false, infra: { step, message: (r.stderr || r.stdout).trim() || `exit ${r.code}` } });
  const run = async (step: MergeStep, cmd: string): Promise<GitResult> => (await seam?.(step)) || shGit(cmd, repo);

  const held = await checkIntegrationIdentity(repo, branch, expected);
  if (!held.ok) return moved(held.leg, held.state, "check");
  const ancestry = await run("ancestry", `git merge-base --is-ancestor ${shq(gated)} ${shq(expected)}`);
  if (ancestry.code === 0) {
    // Ancestor or equal tip: only the task's own recorded merge (second parent = gated) makes it done. A resume replay
    // hands the task's own gated commit here, never a tip recreated on E (runDaemon's resume gate replay).
    for (const commit of merged) {
      const second = await shGit(`git rev-parse --verify -q ${shq(`${commit}^2`)}`, repo);
      if (second.code !== 0) break; // a failed read (no second parent, no such object) is never passed over: fail closed
      if (second.stdout.trim() === gated) return { ok: true, alreadyMerged: commit };
    }
    return { ok: false, alreadyIntegrated: { gated, tip: expected } };
  }
  if (ancestry.code !== 1) return infra("ancestry", ancestry);
  // A caller that skipped the gates on its own ancestry proof (a resume replay) never reaches construction.
  if (ancestorOnly) return infra("ancestry", { code: 1, stdout: "", stderr: `${gated} is not in ${expected}; an ungated replay publishes nothing` });
  const tree = await run("merge-tree", `git merge-tree --write-tree ${shq(expected)} ${shq(gated)}`);
  if (tree.code === 1) return { ok: false, conflict: (tree.stdout || tree.stderr).trim() };
  if (tree.code !== 0) return infra("merge-tree", tree);
  const made = await run("commit-tree",
    `git commit-tree ${shq(tree.stdout.split("\n")[0]!.trim())} -p ${shq(expected)} -p ${shq(gated)} -m ${shq(message)}`);
  if (made.code !== 0) return infra("commit-tree", made);
  const commit = made.stdout.trim();
  await seam?.("publish");
  const published = await shGit(`git update-ref --no-deref -m ${shq(message)} ${shq(`refs/heads/${branch}`)} ${shq(commit)} ${shq(expected)}`, repo);
  if (published.code === 0) {
    onPublished(commit); // no await between the compare-and-swap's result and the caller's rows
    return { ok: true, commit, from: expected };
  }
  const state = await readIntegrationRef(repo, branch);
  if (state.kind === "regular" && state.commit === expected) return infra("publish", published);
  return moved(state.kind === "regular" ? "value" : state.kind, state, "publish");
}

// OBS-34 ruled strict exit-code verify; Q121s (TRIAL T-OBS-1) narrows it: a red whose failure
// fingerprints are ALL recorded in the run's baseline is forgiven with the battery's own math
// (freshFailures) — on any repo whose main carries a pre-existing red, strict verify made a green
// terminus unreachable by construction and misattributed the red to the last merged task.
// Fail-closed edges kept: no baseline → strict; baseline green for that gate → strict; any fresh
// fingerprint, or output with no recognizable failure shape, → failed.
export async function verifyIntegrationTip(
  intWt: string,
  commands: Record<string, string>,
  runDir: string,
  baseline?: Baseline,
  evidenceOptions: GateEvidenceOptions = {},
  { deferVerdicts = false }: { deferVerdicts?: boolean } = {},
): Promise<TipVerifyResult[]> {
  const results: TipVerifyResult[] = [];
  let runStartCommands: Record<string, string> | undefined;
  let journalFound = false;
  let hasRunEvidenceOrMalformed = false;
  const journalPath = join(runDir, "journal.jsonl");
  if (existsSync(journalPath)) {
    journalFound = true;
    try {
      const raw = readFileSync(journalPath, "utf8").trim();
      if (!raw) {
        hasRunEvidenceOrMalformed = true;
      } else {
        const lines = raw.split("\n");
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const parsed = JSON.parse(line);
            if (parsed.event === "run-start" && parsed.data?.commands) {
              runStartCommands = parsed.data.commands as Record<string, string>;
              break;
            }
            if (parsed.event && !parsed.event.startsWith("tip-verify")) {
              hasRunEvidenceOrMalformed = true;
            }
          } catch {
            // Recover valid rows: skip malformed rows while searching for run-start
            hasRunEvidenceOrMalformed = true;
          }
        }
      }
    } catch {
      hasRunEvidenceOrMalformed = true;
    }
  }

  const gatesToRun: Array<[string, string]> = [];
  for (const [gate, cmd] of Object.entries(commands)) {
    if (gate === "tipTest") continue;
    if (gate === "test") {
      gatesToRun.push(["test", commands.tipTest ?? cmd]);
    } else {
      gatesToRun.push([gate, cmd]);
    }
  }
  if (!commands.test && commands.tipTest) {
    gatesToRun.push(["test", commands.tipTest]);
  }

  const dependencyRefusal = dependencyLinkRefusal(intWt);
  if (dependencyRefusal) {
    for (const [gate, cmd] of gatesToRun.length ? gatesToRun : [["build", ""]]) {
      const artifact = join(runDir, `tip-verify-${gate}.log`);
      writeTipLog(artifact, dependencyRefusal + "\n");
      results.push({ gate, cmd, pass: false, exitCode: 1, fingerprints: [],
        cause: "infra", details: dependencyRefusal, evidenceAbsence: "not-started", artifact });
    }
    return results;
  }

  if (journalFound && hasRunEvidenceOrMalformed && runStartCommands === undefined) {
    for (const [gate, cmd] of gatesToRun) {
      const artifact = join(runDir, `tip-verify-${gate}.log`);
      const details = `tip verify could not establish command provenance: run-start evidence missing or malformed in journal`;
      writeTipLog(artifact, details + "\n");
      results.push({
        gate,
        cmd,
        pass: false,
        exitCode: 1,
        fingerprints: [],
        details,
        evidenceAbsence: "provenance-refused",
        artifact,
      });
    }
    return results;
  }

  const stateDir = resolveStateDir(intWt, runDir);
  const store = getVerdictStore(stateDir);
  // Publish only after the entire verification completes. The daemon kills a cancelled
  // verifier process, so completed early gates must remain in memory until then.
  const pending = new Map<string, VerificationIdentity>();
  // D-267 (1): each fresh receipt's origin is the root its own beginGateEvidence returned.
  const evidenceRoots = new Map<string, string>();

  for (const [gate, cmd] of gatesToRun) {
    if (runStartCommands !== undefined) {
      const expectedCmd = gate === "test"
        ? (runStartCommands.tipTest ?? runStartCommands.test)
        : runStartCommands[gate];
      if (expectedCmd === undefined || cmd !== expectedCmd) {
        const artifact = join(runDir, `tip-verify-${gate}.log`);
        const details = `tip verify command "${cmd}" for gate "${gate}" was not named in run-start row`;
        writeTipLog(artifact, details + "\n");
        results.push({
          gate,
          cmd,
          pass: false,
          exitCode: 1,
          fingerprints: [],
          details,
          evidenceAbsence: "provenance-refused",
          artifact,
        });
        continue;
      }
    }
    // Leg-2 T3 M1 (RULING-230-15): the entry is chosen by the RECORDED identity — the same provenance the
    // command was validated against above — never the current config. After a resume whose config task
    // command converged on the recorded tip command, the current-config test read "no distinct tip" and
    // forgave a tip red against the TASK entry. Only standalone verify (no run-start row) has no record.
    const identity = runStartCommands ?? commands;
    const hasTipCommand = Boolean(identity.tipTest && identity.tipTest !== identity.test);
    const entry = gate === "test" && (hasTipCommand || (!identity.test && identity.tipTest))
      ? baseline?.commands.tipTest
      : baseline?.commands[gate];
    // A distinct tipTest selects a different forgiveness entry even when the command
    // converges with the task command. Include that effective entry in the identity.
    const verificationBaseline = baseline ? { commands: { ...baseline.commands } } : undefined;
    if (verificationBaseline) {
      if (entry) verificationBaseline.commands[gate] = entry;
      else delete verificationBaseline.commands[gate];
    }
    // A tip verifier may reuse only a completed green from its own scope.
    const id = await computeVerificationIdentity({
      worktree: intWt,
      gate,
      scope: "tip",
      command: cmd,
      baseline: verificationBaseline,
      selectedSet: undefined,
      capacity: resolvedCapacity(),
    });
    // Persistent reuse requires the run's durable journal. Without it there is no
    // recorded cycle provenance to reconcile with the caller's capacity checks.
    const hit = journalFound ? store.get(id) : undefined;
    // S19m4: a forgiven test green written before the tip read kill text never proves the suite completed.
    const killTextUnread = gate === "test" && hit?.meta?.forgiven === true && hit.meta.killTextRead !== true;
    if (hit && id && hit.pass && !isInfraResult(hit) && !killTextUnread) {
      results.push({
        gate,
        cmd,
        pass: hit.pass,
        ...reusedTipEvidence(hit.meta ?? {}),
        exitCode: hit.exitCode ?? 0,
        fingerprints: (hit.meta?.fingerprints as string[] | undefined) ?? [],
        ...(hit.meta?.forgiven ? { forgiven: true } : {}),
        ...(hit.meta?.forgiven && hit.meta.baselineProvenance ? { baselineProvenance: hit.meta.baselineProvenance as BaselineProvenance } : {}),
        details: formatReusedDetails(hit.details, id),
        ...(hit.meta?.reportPath ? { reportPath: hit.meta.reportPath as string } : {}),
        ...(hit.meta?.spawnedCommand ? { spawnedCommand: hit.meta.spawnedCommand as string } : {}),
        ...(hit.meta?.artifact ? { artifact: hit.meta.artifact as string } : {}),
      });
      continue;
    }
    if (id && journalFound) pending.set(gate, id);
    // VL-1: tip verify and standalone verify read the SAME invocation-bound report the gate would —
    // a detected vitest test command never reaches the stdout-count/file-count path below (this
    // gate's own manifest is always the FULL suite; verify has no selected screen to hold). A
    // scripted test command that is not the detected runner falls through unchanged.
    const evidenceSetup: GateEvidenceOptions = { artifactDir: runDir, runId: runDir, ...evidenceOptions };
    if (gate === "test" && isVitestTestCommand(cmd, intWt)) {
      // D-267 (1): stamp the root the evidence setup returned, then give that exact root to every
      // manifested invocation. Do not reconstruct it from the caller's options: the receipt's
      // artifact paths are relative to the root returned by beginGateEvidence.
      const evidence = beginGateEvidence(intWt, gate, cmd, evidenceSetup);
      const manifestedEvidence: GateEvidenceOptions = { ...evidenceSetup, artifactDir: evidence.root };
      evidenceRoots.set(gate, evidence.root);
      const outcome = await evaluateManifestedTest(cmd, intWt, {
        baselineDurations: classifiedFileDurations(entry),
        longestFile: entry?.longestFile,
        overallCeilingMs: effectiveCeilingMs(entry),
        artifactDir: runDir,
        evidence: manifestedEvidence,
      });
      const artifact = join(runDir, `tip-verify-${gate}.log`);
      if (!outcome.pass) writeTipLog(artifact, outcome.details);
      results.push({
        gate,
        cmd,
        pass: outcome.pass,
        evidenceReceipt: outcome.evidenceReceipt,
        evidenceReceipts: outcome.evidenceReceipts,
        ...(!outcome.evidenceReceipt ? { evidenceAbsence: "not-started" as const } : {}),
        nonce: outcome.meta.nonce as string | undefined,
        stdoutPath: outcome.meta.stdoutPath as string | undefined,
        stderrPath: outcome.meta.stderrPath as string | undefined,
        exitCode: outcome.exitCode,
        reportPath: outcome.reportPath,
        spawnedCommand: outcome.meta.spawnedCommand as string,
        fingerprints: (outcome.meta as Record<string, unknown>).failingTests as string[] | undefined ?? [],
        details: outcome.details,
        ...(outcome.classification ? { cause: outcome.classification } : {}),
        ...(outcome.pass ? {} : { artifact }),
      });
      continue;
    }
    // OBS-534: the ceiling is the BATTERY's, derived by effectiveCeilingMs from the same baseline entry
    // this loop already reads for forgiveness two lines down — never the flat DEFAULT_SHELL_TIMEOUT_MS
    // `sh` defaults to. A suite whose capture measured 600007ms carries a recorded 1800021ms ceiling;
    // running it under 600000ms here SIGKILLed a green tip three times while every per-task gate passed.
    const ceilingMs = effectiveCeilingMs(entry);
    const evidenceReceipts: GateEvidenceReceipt[] = [];
    const execute = async () => {
      const evidence = beginGateEvidence(intWt, gate, cmd, evidenceSetup);
      evidenceRoots.set(gate, evidence.root);
      try {
        const result = await sh(cmd, intWt, ceilingMs, { env: evidenceOptions.env, onReceipt: receipt => evidence.observe(receipt) });
        evidenceReceipts.push(...evidence.history, evidence.finish(result.stdout, result.stderr));
        return result;
      } catch (error) {
        const receipt = evidence.finish();
        if (receipt.termination.kind !== "not-started" || executionSignal()?.aborted) throw error;
        evidenceReceipts.push(...evidence.history, receipt);
        return { code: -1, stdout: "", stderr: String(error) };
      }
    };
    let r = await execute();
    let raw = r.stdout + "\n" + r.stderr;
    let stripped = raw.split(intWt).join("");
    let rerun: string | undefined;
    if (evidenceReceipts.at(-1)?.termination.kind !== "not-started" && gate === "test" && !r.timedOut && !fileCountDeficit(entry, stripped)
      && classifyFreshRunnerOutput(entry, stripped, r.code) === "infra") {
      const waitedMs = await waitForCalmWindow();
      rerun = `runner-infra rerun after waiting ${waitedMs}ms for a calm load window`;
      r = await execute();
      raw = r.stdout + "\n" + r.stderr;
      stripped = raw.split(intWt).join("");
    }
    const evidenceReceipt = evidenceReceipts.at(-1)!;
    if (evidenceReceipt.termination.kind === "not-started") {
      results.push({ gate, cmd, pass: false, exitCode: r.code, fingerprints: [],
        details: `infra; command failed to launch: ${r.stderr}`, cause: "infra",
        evidenceReceipt, evidenceReceipts, evidenceAbsence: "not-started" });
      continue;
    }
    const artifact = join(runDir, `tip-verify-${gate}.log`);
    // Battery parity on the ceiling too (baseline.ts Q24): the kill is read BEFORE the exit code is
    // interpreted at all. A SIGKILLed battery never returned a verdict, so no line of its partial
    // output is one — fingerprinting it is what produced the `<unrecognized failure output>` an
    // operator cannot act on. The kill reader's own text (ceiling + elapsed) and cause replace it.
    const killed = ceilingKillResult(gate, r, ceilingMs);
    if (killed) {
      writeTipLog(artifact, raw);
      results.push({
        gate,
        cmd,
        pass: false,
        evidenceReceipt, evidenceReceipts,
        exitCode: r.code,
        fingerprints: [],
        details: `${rerun ? `infra; ${rerun}: ` : ""}${killed.details}`,
        cause: killed.meta?.classification as FailureClassification,
        artifact,
      });
      continue;
    }
    const verdict = freshFailures(entry, stripped, gate === "test");
    const { failing, unreadable } = verdict;
    // S22: a missing or unreadable entry forgives nothing; the red names it rather than a bare exit code.
    const refusal = baselineEntryRefusal(gate, verdict);
    const deficit = fileCountDeficit(entry, stripped);
    const cause = deficit ? "infra" : classifyFreshRunnerOutput(entry, stripped, r.code);
    const greenTeardown = classifyRunnerOutput(stripped, r.code) === "green-teardown";
    // `?? 1` is the battery's own default (baseline.ts compareToBaseline): an exitCode-less legacy
    // entry reads as red-at-baseline there, so it must read the same here or old baselines silently
    // lose forgiveness. OBS-534 (T2): a capture killed at its ceiling now records a CAUSE and no
    // verdict, and that default must not launder the missing exit code back into red-at-baseline.
    // Only a recorded verdict is forgivable, so this reads the same predicate the battery does
    // (baseline.ts `baselineRed`) — `infra` first, the legacy default only after it. freshFailures
    // already drops the killed capture's flushed fingerprints, but it cannot close this alone: an
    // output whose only shape is a diagnostic HEADING (vitest's "Unhandled Errors" banner) is
    // fingerprintable yet OBS-42-exempt from rejecting, so `failing` comes back empty, `unreadable`
    // false and the cause reads "regression" — every other guard satisfied, and a real red forgiven
    // against a capture that never finished asking the question.
    const baselineRed = verdict.baselineRed;
    // Battery parity on the infra rule too (T9): infrastructure-only output means the runner never
    // completed a suite — nothing was verified, so nothing is forgivable, however familiar its
    // fingerprints. Stricter-than-battery edge kept: unreadable output never forgives.
    // T7: the SECOND reader of a baseline entry, and the same rule as the battery's (baseline.ts).
    // Evidence crosses a session boundary here — the capture that would forgive this red is very
    // often the previous session's — so a capture taken under a different resolved capacity forgives
    // nothing at the tip either. An absent capacity is a pre-T7 baseline and keeps today's verdict.
    const comparable = sameCapacity(entry?.capacity, r.capacity);
    const forgivable = r.code !== 0 && baselineRed && failing.length === 0 && !unreadable && cause !== "infra"
      && comparable;
    // S19m4 (battery parity): kill text beside forgivable failures means the suite never completed — red, infra.
    const killLine = forgivable && !greenTeardown && !deficit ? verdict.killLine : undefined;
    const forgiven = forgivable && killLine === undefined;
    const rowCause = killLine !== undefined ? "infra" : cause;
    const pass = !deficit && (r.code === 0 || greenTeardown || forgiven);
    if (!pass) writeTipLog(artifact, raw);
    const tipResult: TipVerifyResult = {
      gate,
      cmd,
      pass,
      evidenceReceipt, evidenceReceipts,
      exitCode: r.code,
      fingerprints: r.code !== 0 && !greenTeardown ? fingerprint(stripped) : [],
      details: `${rowCause === "infra" ? "infra; " : ""}${rerun ? `${rerun}: ` : ""}` + (deficit?.replace(/^infra; /, "") ?? (r.code === 0 ? "exit 0"
        : greenTeardown ? `exit ${r.code} after a green suite summary; only the runner's teardown fingerprint followed it`
        : forgiven ? `exit ${r.code} but only baseline-recorded failures (forgiven vs baseline)`
        : killLine !== undefined ? `exit ${r.code}; every failure is baseline-recorded, but the runner printed kill text — `
          + `it never completed a suite, so nothing is forgiven: ${killLine}`
        : !comparable && baselineRed && failing.length === 0
          ? `exit ${r.code}; every failure is baseline-recorded, but that capture ran under `
            + `${describeCapacity(entry?.capacity)} and this verification ran under ${describeCapacity(r.capacity)} `
            + `— forgiveness across a changed capacity is not evidence`
          : `exit ${r.code}`))
        // S22: every red here names a missing or unreadable entry beside its own cause, deficit included
        + (!pass && refusal ? `; ${refusal}` : ""),
      ...(forgiven && !deficit ? { forgiven: true, ...(baseline?.provenance ? { baselineProvenance: baseline.provenance } : {}) } : {}),
      ...(rowCause ? { cause: rowCause } : {}),
      ...(pass ? {} : { artifact }),
    };
    results.push(tipResult);
  }
  // Recheck through the Git runner before publishing: cancellation disables further
  // spawns in the daemon child, and a command that changed the tree invalidates reuse.
  const completedTree = pending.size ? await getWorktreeTree(intWt) : undefined;
  for (const result of results) {
    if (!result.reused && result.evidenceReceipt) {
      const evidenceRoot = evidenceRoots.get(result.gate);
      if (evidenceRoot === undefined) throw new Error(`tip verify receipt for ${result.gate} has no evidence root from its evidence setup`);
      result.originRunRoot = evidenceRoot;
    }
    const id = pending.get(result.gate);
    if (id && id.tree === completedTree && !isInfraResult(result)) {
      const verdict = { ...result, meta: {
        fingerprints: result.fingerprints, forgiven: result.forgiven, baselineProvenance: result.baselineProvenance,
        ...(result.forgiven && result.gate === "test" ? { killTextRead: true } : {}),
        reportPath: result.reportPath, spawnedCommand: result.spawnedCommand,
        artifact: result.artifact,
        evidenceReceipt: result.evidenceReceipt, evidenceReceipts: result.evidenceReceipts,
        evidenceAbsence: result.evidenceAbsence, originRunRoot: result.originRunRoot,
        nonce: result.nonce, stdoutPath: result.stdoutPath, stderrPath: result.stderrPath,
      } };
      // 2.8.1 T1: a deferring caller (run end) writes the verdict itself, only after its closing identity check.
      if (deferVerdicts) result.deferredVerdict = { id, verdict };
      else store.set(id, verdict);
    }
  }
  return results;
}
