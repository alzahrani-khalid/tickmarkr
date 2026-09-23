import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { shq } from "../adapters/types.js";
import type { TickmarkrConfig } from "../config/config.js";
import {
  type Baseline,
  beginGateEvidence,
  type GateEvidenceOptions,
  ceilingKillResult,
  classifyFreshRunnerOutput,
  classifyRunnerOutput,
  fileCountDeficit,
  waitForCalmWindow,
  effectiveCeilingMs,
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
import { tickmarkrDir } from "../graph/graph.js";
import { describeCapacity, gitHead, linkNodeModules, resolveIntegrationBranch, resolvedCapacity, sameCapacity, sh, shGit, shGitOk, WORKTREES_DIR } from "./git.js";
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
  /** Absolute directory against which the original receipt artifact paths resolve. */
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
  /** D-131: carried from a persisted per-gate verdict — this cycle did NOT execute the command. */
  reused?: true;
  /**
   * OBS-534: what a nonzero exit is evidence OF, taken from the battery's own readers — `ceilingKillResult`
   * for a kill, the shared runner classifier for everything else. `infra` means nothing was verified.
   */
  cause?: FailureClassification;
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

const sanitize = (branch: string) => branch.replace(/[^\w.-]+/g, "-");

export async function ensureIntegration(repo: string, branch: string, baseRef: string): Promise<string> {
  branch = await resolveIntegrationBranch(repo, branch);
  const dir = join(tickmarkrDir(repo), WORKTREES_DIR, sanitize(branch));
  if (!existsSync(join(dir, ".git"))) {
    const exists = (await shGit(`git rev-parse --verify refs/heads/${shq(branch)}`, repo)).code === 0;
    if (exists) {
      await shGitOk(`git worktree add ${shq(dir)} ${shq(branch)}`, repo);
    } else {
      await shGitOk(`git worktree add -b ${shq(branch)} ${shq(dir)} ${shq(baseRef)}`, repo);
    }
  }
  linkNodeModules(repo, dir);
  return dir;
}

export function integrationHead(intWt: string): Promise<string> {
  return gitHead(intWt);
}

export async function mergeTask(
  intWt: string,
  taskBranch: string,
  message: string,
  gatedCommit: string,
): Promise<{ ok: boolean; conflict?: string; tipMoved?: { gatedCommit: string; branchTip: string } }> {
  const tip = await shGit(`git rev-parse --verify ${shq(`refs/heads/${taskBranch}`)}`, intWt);
  if (tip.code !== 0) return { ok: false, conflict: tip.stderr || tip.stdout };
  const branchTip = tip.stdout.trim();
  if (branchTip !== gatedCommit) return { ok: false, tipMoved: { gatedCommit, branchTip } };

  // Merge the verified hash, not the mutable branch name: a move after the comparison cannot land ungated content.
  const r = await shGit(`git merge --no-ff ${shq(gatedCommit)} -m ${shq(message)}`, intWt);
  if (r.code === 0) return { ok: true };
  const conflict = (await shGit("git status --porcelain", intWt)).stdout
    .split("\n")
    .filter((l) => l.startsWith("UU") || l.startsWith("AA"))
    .join("\n") || r.stderr || r.stdout;
  await shGit("git merge --abort", intWt);
  return { ok: false, conflict };
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
    if (hit && id && hit.pass && !isInfraResult(hit)) {
      results.push({
        gate,
        cmd,
        pass: hit.pass,
        ...reusedTipEvidence(hit.meta ?? {}),
        exitCode: hit.exitCode ?? 0,
        fingerprints: (hit.meta?.fingerprints as string[] | undefined) ?? [],
        ...(hit.meta?.forgiven ? { forgiven: true } : {}),
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
    if (gate === "test" && isVitestTestCommand(cmd, intWt)) {
      const outcome = await evaluateManifestedTest(cmd, intWt, {
        baselineDurations: entry?.fileDurations,
        longestFile: entry?.longestFile,
        overallCeilingMs: effectiveCeilingMs(entry),
        artifactDir: runDir,
        evidence: { artifactDir: runDir, runId: runDir, ...evidenceOptions },
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
      const evidence = beginGateEvidence(intWt, gate, cmd, { artifactDir: runDir, runId: runDir, ...evidenceOptions });
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
    const { failing, unreadable } = freshFailures(entry, stripped);
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
    const baselineRed = entry !== undefined && entry.infra !== true && (entry.exitCode ?? 1) !== 0;
    // Battery parity on the infra rule too (T9): infrastructure-only output means the runner never
    // completed a suite — nothing was verified, so nothing is forgivable, however familiar its
    // fingerprints. Stricter-than-battery edge kept: unreadable output never forgives.
    // T7: the SECOND reader of a baseline entry, and the same rule as the battery's (baseline.ts).
    // Evidence crosses a session boundary here — the capture that would forgive this red is very
    // often the previous session's — so a capture taken under a different resolved capacity forgives
    // nothing at the tip either. An absent capacity is a pre-T7 baseline and keeps today's verdict.
    const comparable = sameCapacity(entry?.capacity, r.capacity);
    const forgiven = r.code !== 0 && baselineRed && failing.length === 0 && !unreadable && cause !== "infra"
      && comparable;
    const pass = !deficit && (r.code === 0 || greenTeardown || forgiven);
    if (!pass) writeTipLog(artifact, raw);
    const tipResult: TipVerifyResult = {
      gate,
      cmd,
      pass,
      evidenceReceipt, evidenceReceipts,
      exitCode: r.code,
      fingerprints: r.code !== 0 && !greenTeardown ? fingerprint(stripped) : [],
      details: `${cause === "infra" ? "infra; " : ""}${rerun ? `${rerun}: ` : ""}` + (deficit?.replace(/^infra; /, "") ?? (r.code === 0 ? "exit 0"
        : greenTeardown ? `exit ${r.code} after a green suite summary; only the runner's teardown fingerprint followed it`
        : forgiven ? `exit ${r.code} but only baseline-recorded failures (forgiven vs baseline)`
        : !comparable && baselineRed && failing.length === 0
          ? `exit ${r.code}; every failure is baseline-recorded, but that capture ran under `
            + `${describeCapacity(entry?.capacity)} and this verification ran under ${describeCapacity(r.capacity)} `
            + `— forgiveness across a changed capacity is not evidence`
          : `exit ${r.code}`)),
      ...(forgiven && !deficit ? { forgiven: true } : {}),
      ...(cause ? { cause } : {}),
      ...(pass ? {} : { artifact }),
    };
    results.push(tipResult);
  }
  // Recheck through the Git runner before publishing: cancellation disables further
  // spawns in the daemon child, and a command that changed the tree invalidates reuse.
  const completedTree = pending.size ? await getWorktreeTree(intWt) : undefined;
  for (const result of results) {
    if (!result.reused && result.evidenceReceipt) result.originRunRoot = resolve(evidenceOptions.artifactDir ?? runDir);
    const id = pending.get(result.gate);
    if (id && id.tree === completedTree && !isInfraResult(result)) {
      store.set(id, { ...result, meta: {
        fingerprints: result.fingerprints, forgiven: result.forgiven,
        reportPath: result.reportPath, spawnedCommand: result.spawnedCommand,
        artifact: result.artifact,
        evidenceReceipt: result.evidenceReceipt, evidenceReceipts: result.evidenceReceipts,
        evidenceAbsence: result.evidenceAbsence, originRunRoot: result.originRunRoot,
        nonce: result.nonce, stdoutPath: result.stdoutPath, stderrPath: result.stderrPath,
      } });
    }
  }
  return results;
}
