import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, sep } from "node:path";
import { TEST_REPORTER_SOURCE } from "./test-reporter.js";
import { shq } from "../adapters/types.js";
import type { BaselineFileDuration } from "./baseline.js";
import { FORK_CAP_ENV, ROUTING_ENV_SEAMS, SUITE_PARENT_ENV, shell, resolvedCapacity } from "../run/git.js";

/**
 * VL-1 (OBS-985 lineage): a test gate's completion must be the runner's OWN report, never a stdout
 * count. `fileCountDeficit` (baseline.ts) reads a summary LINE — a selected screen's smaller count
 * looked identical to a truncated full suite (OBS-985's shipped defect). This module is the
 * independent validator: it names a MANIFEST (the files the runner is expected to collect), binds a
 * report to ONE invocation with a nonce, and trusts nothing the runner did not certify per file.
 */

/** Parse the supported simple shell invocation, retaining quoted argument values. Shell programs
 * are deliberately outside this contract: forwarding reporter options to their last command is unsafe. */
function shellTokens(command: string): string[] {
  return command.match(/(?:[^\s'"\\&|;<>]+|'[^']*'|"(?:\\.|[^"\\])*"|\\.)+|[&|;<>]+/g) ?? [];
}
function words(command: string): string[] {
  const tokens = shellTokens(command);
  return tokens.map((token) => token.replace(/'([^']*)'|"((?:\\.|[^"\\])*)"|\\(.)/g,
    (_all, single, double, escaped) => single ?? (double !== undefined ? double.replace(/\\(["\\$`])/g, "$1") : escaped)));
}
const namesRunner = (body: string) => /(?:^|[\s/\\'";&|])vitest(?:\.mjs)?(?=$|[\s'";&|])/.test(body);
function scriptInvocation(cmd: string, cwd: string): { body: string; trailing: string[]; environment: string[]; npm: boolean } | undefined {
  const argv = words(cmd);
  const raw = shellTokens(cmd);
  let manager = 0;
  while (/^[A-Za-z_][A-Za-z_0-9]*=/.test(argv[manager] ?? "")) manager++;
  if (!["npm", "pnpm", "yarn"].includes(argv[manager])) return undefined;
  const offset = manager + (["run", "run-script"].includes(argv[manager + 1]) ? 2 : 1);
  const name = ["t", "tst"].includes(argv[offset]) ? "test" : argv[offset];
  try {
    const body = JSON.parse(readFileSync(join(cwd, "package.json"), "utf8")).scripts?.[name];
    return typeof body === "string" ? { body, trailing: raw.slice(offset + 1).filter((a) => a !== "--"), environment: raw.slice(0, manager), npm: argv[manager] === "npm" } : undefined;
  } catch { return undefined; }
}
export function isVitestTestCommand(cmd: string, cwd: string): boolean {
  return namesRunner(scriptInvocation(cmd, cwd)?.body ?? cmd);
}

function runnerInvocation(cmd: string, cwd: string): { listing: string; separator: string } {
  const script = scriptInvocation(cmd, cwd);
  const body = script?.body ?? cmd;
  if ([body, cmd].some((text) => shellTokens(text).some((token) => /^[&|;<>]+$/.test(token)) || /[`\n]|\$\(/.test(text)))
    throw new Error("vitest command is compound or contains unsupported shell syntax");
  const args = words(body);
  const raw = shellTokens(body);
  let i = 0;
  while (/^[A-Za-z_][A-Za-z_0-9]*=/.test(args[i] ?? "")) i++;
  const env = [...(script?.environment ?? []), ...raw.slice(0, i)];
  let runner = args[i];
  const prefix: string[] = [];
  if (runner === "node") { prefix.push(runner); runner = args[++i]; }
  else if (runner === "npx") { runner = args[++i]; }
  if (!runner || !/(?:^|[/\\])vitest(?:\.mjs)?$/.test(runner))
    throw new Error("vitest script body is not a supported direct runner invocation");
  const binary = runner === "vitest" ? join(cwd, "node_modules/.bin/vitest") : isAbsolute(runner) ? runner : join(cwd, runner);
  if (!existsSync(binary)) throw new Error(`vitest binary does not exist: ${binary}`);
  const forwarded = [...raw.slice(i + 1), ...(script?.trailing ?? [])];
  if (forwarded[0] === "run") forwarded.shift();
  const collection = forwarded.filter((a) => a !== "--run" && a !== "--watch" && a !== "--");
  return {
    listing: [...env, ...prefix.map(shq), shq(binary), "list", ...collection, "--json"].join(" "),
    separator: script?.npm && !/(?:^|\s)--(?:\s|$)/.test(cmd) ? " --" : "",
  };
}

/** One identity for every path this module compares: repo-relative, forward-slash. `vitest list
 * --json` and `TestModule.moduleId` both hand back an absolute filesystem path already resolved
 * through any symlink in it (e.g. macOS's `/var` -> `/private/var`, under which every OS temp dir —
 * and so every test fixture worktree — lives); `cwd` as tickmarkr holds it may not be. Resolving cwd
 * before computing the relative path is what makes the two actually comparable. Manifests built from
 * a selected-test screen are already repo-relative and pass through unchanged. */
export function toManifestPath(file: string, cwd: string): string {
  if (!isAbsolute(file)) return file.replace(/^\.\//, "").split(sep).join("/");
  let resolvedCwd = cwd;
  try { resolvedCwd = realpathSync(cwd); } catch { /* cwd unreadable — best effort with the given path */ }
  return relative(resolvedCwd, file).split(sep).join("/");
}

export interface TestReportCompletion {
  at: number;
  status: "passed" | "failed";
  /** Failure fingerprints for this file; absent/empty on a passed file. */
  failures?: string[];
}

/** The runner's own machine report — requested/started/completed are the runner's claims about ITSELF. */
export interface TestReport {
  nonce: string;
  requested: string[];
  started: Record<string, number>;
  completed: Record<string, TestReportCompletion>;
  /** Files the reporter observed complete MORE than once — `completed`'s object keys cannot show
   * this themselves (a second write silently overwrites the first), so the reporter records the
   * evidence separately before it is lost. */
  duplicateCompletions?: string[];
  /** Written last, once, when the runner reaches its own terminal state. Its absence means the run
   * never certified completion — killed, crashed, or still in flight — and is never a verdict. */
  certificate?: { at: number; exitCode: number };
}

function isTestReportShape(v: unknown): v is TestReport {
  if (typeof v !== "object" || v === null) return false;
  const r = v as Record<string, unknown>;
  if (typeof r.nonce !== "string" || !Array.isArray(r.requested) || typeof r.started !== "object" || r.started === null || typeof r.completed !== "object" || r.completed === null) return false;
  if (!r.requested.every((f) => typeof f === "string")) return false;
  if (Object.values(r.started as Record<string, unknown>).some((v) => typeof v !== "number")) return false;
  for (const c of Object.values(r.completed as Record<string, unknown>)) {
    if (typeof c !== "object" || c === null) return false;
    const cc = c as Record<string, unknown>;
    if (typeof cc.at !== "number" || (cc.status !== "passed" && cc.status !== "failed")) return false;
  }
  if (r.duplicateCompletions !== undefined) {
    if (!Array.isArray(r.duplicateCompletions) || !r.duplicateCompletions.every((f) => typeof f === "string")) return false;
  }
  if (r.certificate !== undefined) {
    if (typeof r.certificate !== "object" || r.certificate === null) return false;
    const cert = r.certificate as Record<string, unknown>;
    if (typeof cert.at !== "number" || typeof cert.exitCode !== "number") return false;
  }
  return true;
}

/** Reads and structurally validates the report; a missing or malformed file is `undefined` — never a partial parse. */
export function readTestReport(path: string): TestReport | undefined {
  if (!existsSync(path)) return undefined;
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    return isTestReportShape(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

export type ManifestVerdictKind = "pass" | "infra" | "work" | "fail-closed";

export interface ManifestVerdict {
  kind: ManifestVerdictKind;
  pass: boolean;
  details: string;
  meta: Record<string, unknown>;
}

/**
 * The independent validator: given the manifest THIS invocation was asked to prove, its bound nonce
 * and the independently observed process exit code, decide the
 * verdict from the report alone. `killedFile` short-circuits every report-shaped check — a job this
 * module killed for a per-file hang never reaches its report.
 */
export function verifyManifestReport(opts: {
  manifest: readonly string[];
  nonce: string;
  exitCode: number | undefined;
  report: TestReport | undefined;
  killedFile?: string;
  hangBudgetMs?: number;
}): ManifestVerdict {
  const { manifest, nonce, exitCode, report, killedFile, hangBudgetMs } = opts;

  if (killedFile !== undefined) {
    return {
      kind: "infra",
      pass: false,
      details: `infra hang: "${killedFile}" started and did not complete within its ${hangBudgetMs}ms budget — killed, its process group is gone`,
      meta: { classification: "infra", infra: true, kind: "hang", file: killedFile, hangBudgetMs },
    };
  }

  if (!report) {
    return {
      kind: "fail-closed",
      pass: false,
      details: `exit ${exitCode ?? "unknown"} with no invocation-bound test report — a gate that trusts the exit code alone is exactly what this gate refuses to be; failing closed naming the missing report`,
      meta: { classification: "infra", infra: true, missingReport: true },
    };
  }

  if (report.nonce !== nonce) {
    return {
      kind: "fail-closed",
      pass: false,
      details: `test report carries nonce "${report.nonce}" — this invocation's nonce is "${nonce}"; a report from another invocation is never a verdict, failing closed`,
      meta: { classification: "infra", infra: true, staleNonce: report.nonce, expectedNonce: nonce },
    };
  }

  const requestedCounts = new Map<string, number>();
  for (const f of report.requested) requestedCounts.set(f, (requestedCounts.get(f) ?? 0) + 1);
  const duplicated = [...requestedCounts.entries()].find(([, n]) => n > 1)?.[0];
  if (duplicated !== undefined) {
    return {
      kind: "fail-closed",
      pass: false,
      details: `test report names "${duplicated}" more than once in its requested set — a file counted twice is not a trustworthy completion record; failing closed`,
      meta: { classification: "infra", infra: true, duplicateFile: duplicated },
    };
  }

  if (report.duplicateCompletions?.length) {
    const dup = report.duplicateCompletions[0]!;
    return {
      kind: "fail-closed",
      pass: false,
      details: `"${dup}" completed more than once in this report — a duplicate completion record (evidence the reporter preserved despite the later write overwriting it) is never a verdict; failing closed`,
      meta: { classification: "infra", infra: true, duplicateCompletion: dup },
    };
  }

  const uncorroborated = Object.keys(report.completed).find((f) => !(f in report.started) || !report.requested.includes(f));
  if (uncorroborated !== undefined) {
    return {
      kind: "fail-closed",
      pass: false,
      details: `"${uncorroborated}" is marked completed without a matching requested/started record — an unattributed completion is never a verdict; failing closed`,
      meta: { classification: "infra", infra: true, unattributedCompletion: uncorroborated },
    };
  }

  if (!report.certificate) {
    const pending = manifest.find((f) => f in report.started && !(f in report.completed));
    return {
      kind: "infra",
      pass: false,
      details: pending !== undefined
        ? `the job was killed after its last file record but before its terminal certificate — never a verdict; last incomplete file was "${pending}"`
        : `the job was killed after its last file record but before its terminal certificate — never a verdict`,
      meta: { classification: "infra", infra: true, missingCertificate: true, ...(pending !== undefined ? { file: pending } : {}) },
    };
  }

  const failures = Object.values(report.completed).filter((c) => c.status === "failed")
    .flatMap((c) => c.failures?.length ? c.failures : ["<unnamed failure>"]);
  if (failures.length) return { kind: "work", pass: false,
    details: `test report names failing fingerprint(s):\n${failures.join("\n")}`,
    meta: { classification: "regression", failingTests: failures, processExit: exitCode } };

  if (exitCode === undefined) {
    return {
      kind: "fail-closed",
      pass: false,
      details: `the process did not terminate with an exit code (likely killed by a signal) though a certificate naming exit ${report.certificate.exitCode} is present — a passing verdict requires a clean process termination; failing closed naming both`,
      meta: { classification: "infra", infra: true, missingProcessExit: true, certificateExit: report.certificate.exitCode },
    };
  }

  if (report.certificate.exitCode !== exitCode) {
    return {
      kind: "fail-closed",
      pass: false,
      details: `report certificate names exit ${report.certificate.exitCode} but the process exited ${exitCode} — a report that contradicts the exit code is never a verdict; failing closed naming both`,
      meta: { classification: "infra", infra: true, certificateExit: report.certificate.exitCode, processExit: exitCode },
    };
  }

  if (exitCode !== 0) return {
    kind: "fail-closed", pass: false,
    details: `report has no failed tests but the process exited ${exitCode}; failing closed naming the successful report and nonzero exit`,
    meta: { classification: "infra", infra: true, processExit: exitCode },
  };

  const unexpectedRequested = report.requested.find((f) => !manifest.includes(f));
  const unexpectedStarted = Object.keys(report.started).find((f) => !report.requested.includes(f) || !manifest.includes(f));
  if (unexpectedRequested ?? unexpectedStarted) {
    const file = unexpectedRequested ?? unexpectedStarted!;
    return {
      kind: "fail-closed", pass: false,
      details: `"${file}" is outside the invocation's requested/start lifecycle — a report must certify exactly this manifest; failing closed`,
      meta: { classification: "infra", infra: true, unexpectedLifecycleFile: file },
    };
  }

  const pending = manifest.find((f) => f in report.started && !(f in report.completed));
  if (pending !== undefined) {
    return {
      kind: "infra",
      pass: false,
      details: `"${pending}" started and never completed — an infra result naming the file`,
      meta: { classification: "infra", infra: true, file: pending, incomplete: true },
    };
  }

  const missing = manifest.find((f) => !(f in report.completed));
  if (missing !== undefined) {
    return {
      kind: "infra",
      pass: false,
      details: `"${missing}" is in the manifest but absent from the report — an infra result naming the file`,
      meta: { classification: "infra", infra: true, file: missing, missingFromReport: true },
    };
  }

  return {
    kind: "pass",
    pass: true,
    details: `invocation-bound test report succeeded — ${manifest.length} manifest file(s) present exactly once`,
    meta: { manifestFiles: manifest.length },
  };
}

/** How much longer than its baseline measurement one file may legitimately run before it is a hang. */
export const FILE_HANG_SLACK = 3;
export const DEFAULT_FILE_HANG_BUDGET_MS = 60_000;

const usable = (n: number | undefined): n is number => n !== undefined && Number.isFinite(n) && n > 0;
export function fileHangBudgetMs(file: string, baselineDurations?: readonly BaselineFileDuration[] | null,
  ceilingMs = DEFAULT_FILE_HANG_BUDGET_MS, longestFile?: BaselineFileDuration | null): number {
  const ceiling = usable(ceilingMs) ? ceilingMs : DEFAULT_FILE_HANG_BUDGET_MS;
  const timings = baselineDurations?.filter((d) => usable(d.durationMs)) ?? [];
  const longest = Math.max(0, ...timings.map((d) => d.durationMs), usable(longestFile?.durationMs) ? longestFile.durationMs : 0);
  if (!longest) return ceiling;
  const known = timings.find((d) => d.file === file)?.durationMs;
  return Math.min(ceiling, known === undefined ? FILE_HANG_SLACK * longest : Math.max(FILE_HANG_SLACK * known, longest));
}

export interface ManifestRunResult {
  exitCode: number | undefined;
  stdout: string;
  stderr: string;
  report: TestReport | undefined;
  killedFile?: string;
  hangBudgetMs?: number;
  /** The child's own pid (its process GROUP id too, since it is spawned detached) — for a caller
   * that wants to prove the group is really gone after a hang kill (`process.kill(-pid, 0)` throws). */
  pid?: number;
}

/** Supervise the configured command and poll the runner's atomic lifecycle snapshots. Every
 * timeout kills the detached process group, including descendants holding the output pipes. */
export function runManifestedTest(
  cmd: string,
  cwd: string,
  opts: {
    manifest: readonly string[];
    nonce: string;
    reportPath: string;
    env?: NodeJS.ProcessEnv;
    baselineDurations?: readonly BaselineFileDuration[] | null;
    longestFile?: BaselineFileDuration | null;
    pollMs?: number;
    overallCeilingMs?: number;
  },
): Promise<ManifestRunResult> {
  const pollMs = opts.pollMs ?? 20;
  const overallCeilingMs = usable(opts.overallCeilingMs) ? opts.overallCeilingMs : DEFAULT_FILE_HANG_BUDGET_MS;
  const env: NodeJS.ProcessEnv = { ...(opts.env ?? process.env), TICKMARKR_TEST_REPORT: opts.reportPath, TICKMARKR_TEST_NONCE: opts.nonce };
  const controller = new AbortController();
  let pid: number | undefined;
  let killedFile: string | undefined;
  let hangBudgetMs: number | undefined;
  let poll: ReturnType<typeof setInterval> | undefined;
  const checkHang = (atCeiling = false) => {
    const report = readTestReport(opts.reportPath);
    if (!report || report.nonce !== opts.nonce) return;
    const now = Date.now();
    for (const file of opts.manifest) {
      const startedAt = report.started[file];
      if (startedAt === undefined || file in report.completed) continue;
      const budget = fileHangBudgetMs(file, opts.baselineDurations, overallCeilingMs, opts.longestFile);
      if (now - startedAt >= budget || (atCeiling && budget === overallCeilingMs)) {
        killedFile = file;
        hangBudgetMs = budget;
        if (!atCeiling) controller.abort();
        return;
      }
    }
  };
  return shell(cmd, cwd, overallCeilingMs, false, {
    env, signal: controller.signal, onTimeout: () => checkHang(true),
    onSpawn: (childPid) => {
      pid = childPid;
      // Neither the per-file clocks nor the command ceiling includes lease queue time.
      clearInterval(poll);
      poll = setInterval(checkHang, pollMs);
    },
  }).then((result) => ({
    exitCode: result.signalExit ? undefined : result.code,
    stdout: result.stdout, stderr: result.stderr,
    report: readTestReport(opts.reportPath), killedFile, hangBudgetMs, pid,
  })).finally(() => { clearInterval(poll); });
}

export interface ManifestGateOutcome {
  pass: boolean;
  kind: ManifestVerdictKind;
  details: string;
  classification?: "infra" | "regression";
  meta: Record<string, unknown>;
  exitCode: number;
  reportPath: string;
}

/** One configured runner execution, and its own collection under the same arguments and environment.
 * The installed runner is trusted (R28 add.1 option B); the nonce catches stale artifacts, not forgery. */
export async function evaluateManifestedTest(cmd: string, cwd: string, opts: {
  baselineDurations?: readonly BaselineFileDuration[] | null;
  longestFile?: BaselineFileDuration | null;
  overallCeilingMs?: number;
  artifactDir?: string;
}): Promise<ManifestGateOutcome> {
  const dir = opts.artifactDir ?? mkdtempSync(join(tmpdir(), "tickmarkr-test-report-"));
  const nonce = randomBytes(16).toString("hex");
  const reportPath = join(dir, `test-manifest-report-${nonce}.json`);
  const reporterPath = join(dir, `test-reporter-${nonce}.mjs`);
  let spawnedCommand = cmd;
  const env: NodeJS.ProcessEnv = { ...process.env, PATH: `${join(cwd, "node_modules/.bin")}:${process.env.PATH ?? ""}`,
    [FORK_CAP_ENV]: String(resolvedCapacity().forkCap), [SUITE_PARENT_ENV]: String(process.pid) };
  for (const key of ROUTING_ENV_SEAMS) delete env[key];
  // A gate can itself be tested under Vitest. Do not give the child the outer worker identity.
  for (const key of Object.keys(env)) if (["VITEST", "TEST", "VITEST_WORKER_ID", "VITEST_POOL_ID"].includes(key)) delete (env as NodeJS.ProcessEnv)[key];
  try {
    const invocation = runnerInvocation(cmd, cwd);
    const listed = await runManifestedTest(invocation.listing, cwd, {
      manifest: [], nonce, reportPath: join(dir, `listing-${nonce}.json`), env,
      overallCeilingMs: opts.overallCeilingMs ?? DEFAULT_FILE_HANG_BUDGET_MS,
    });
    if (listed.exitCode !== 0) throw new Error(`vitest cannot list files (exit ${listed.exitCode ?? "signal"}): ${listed.stderr || listed.stdout}`);
    let files: string[];
    try {
      const rows: unknown = JSON.parse(listed.stdout.slice(listed.stdout.indexOf("[")));
      if (!Array.isArray(rows) || !rows.every((r) => typeof r?.file === "string")) throw new Error("invalid listing");
      files = [...new Set(rows.map((r) => toManifestPath(r.file, cwd)))].sort();
    } catch { throw new Error(`vitest cannot list files: invalid JSON listing: ${listed.stdout}`); }
    if (!files.length) throw new Error("vitest cannot list files: empty manifest");
    writeFileSync(reporterPath, TEST_REPORTER_SOURCE);
    spawnedCommand = `${cmd}${invocation.separator} --reporter=${shq(reporterPath)} --outputFile=${shq(reportPath)}`;
    const invoked = await runManifestedTest(spawnedCommand, cwd, {
      manifest: files, nonce, reportPath, env,
      baselineDurations: opts.baselineDurations?.map((d) => ({ ...d, file: toManifestPath(d.file, cwd) })),
      longestFile: opts.longestFile,
      overallCeilingMs: opts.overallCeilingMs ?? DEFAULT_FILE_HANG_BUDGET_MS,
      pollMs: 20,
    });
    const verdict = verifyManifestReport({ manifest: files, nonce, exitCode: invoked.exitCode,
      report: invoked.report, killedFile: invoked.killedFile, hangBudgetMs: invoked.hangBudgetMs });
    return { pass: verdict.pass, kind: verdict.kind,
      details: verdict.details + (!invoked.report && invoked.stderr ? `\nvitest reporter: ${invoked.stderr}` : ""),
      classification: verdict.meta.classification as "infra" | "regression" | undefined,
      meta: { ...verdict.meta, nonce, manifest: files, spawnedCommand, processExit: invoked.exitCode, pid: invoked.pid },
      exitCode: invoked.exitCode ?? -1, reportPath };
  } catch (error) {
    return { pass: false, kind: "infra", classification: "infra", exitCode: -1, reportPath,
      details: error instanceof Error ? error.message : String(error),
      meta: { classification: "infra", infra: true, manifestDiscoveryFailed: true, spawnedCommand } };
  }
}
