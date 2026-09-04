import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { allAdapters, probeAll, readDoctor, rolePools } from "../../adapters/registry.js";
import { channelKey, type Assignment, type BillingChannel } from "../../adapters/types.js";
import { loadConfig } from "../../config/config.js";
import { captureBaseline, detectGateCommands, type Baseline } from "../../gates/baseline.js";
import { modelProvider } from "../../gates/review.js";
import { runGates } from "../../gates/run-gates.js";
import type { GateResult } from "../../gates/types.js";
import { getTask, loadGraph } from "../../graph/graph.js";
import { GATE_NAMES, type AcceptanceItem, type GateName, type Task } from "../../graph/schema.js";
import { linkNodeModules, removeWorktree, shGit, shGitOk } from "../../run/git.js";
import { Journal } from "../../run/journal.js";

/**
 * tickmarkr verify — the gate battery as a standalone command (OPERATING-MODEL-2026-08-11 item 3).
 *
 * Runs the existing seven-gate pipeline (build/test/lint against a captured base baseline, then
 * evidence, scope, acceptance ‖ review) against `merge-base(--base, HEAD)..HEAD` of the CURRENT
 * checkout. No daemon, no worktree lifecycle, no retries, no approvals, no resumable state: one
 * invocation, one immutable candidate, one machine-readable verdict. A verifier failure costs one
 * rerun. Same fail-closed guarantees — this is a thin caller of runGates, not a second pipeline.
 */

// "- test: x" / "test: x" → typed oracle; plain lines → judge criterion (native.ts's exact grammar).
const ORACLE_LINE = /^(command|test|judge):\s*(.+)$/;

export function parseCriteria(text: string): AcceptanceItem[] {
  return text
    .split("\n")
    .map((l) => l.trim().replace(/^-\s+/, ""))
    .filter((l) => l && !l.startsWith("#"))
    .map((l): AcceptanceItem => {
      const m = ORACLE_LINE.exec(l);
      if (!m) return l;
      const body = m[2]!.trim();
      return m[1] === "command" ? { oracle: "command", command: body }
        : m[1] === "test" ? { oracle: "test", test: body }
        : { oracle: "judge", text: body };
    });
}

// The human-author sentinel: pickReviewer resolves the author IN the channel list and excludes that
// vendor (fail-closed when unresolvable). A human/plain-session diff has no vendor to exclude, so
// verify models the author as a "human" vendor channel — resolvable, excludes nothing real.
export const HUMAN_CHANNEL: BillingChannel = { adapter: "human", vendor: "human", model: "human", channel: "sub", tier: "frontier" };
export const HUMAN_AUTHOR: Assignment = { adapter: "human", model: "human", channel: "sub", tier: "frontier" };

// The battery's own dirty-worktree refusal, mirrored from run-gates.ts:220-232 — that check lives in
// a closure this command cannot reach, and verify may not reshape it. run-gates stays the authority:
// it re-checks at round entry and after every gate command, so a copy that ever drifted could only
// refuse EARLY with a stale sentence — never let a dirty tree through.
const DIRTY_WHY = `refusing to gate a dirty worktree: the shell gates run against the working tree while `
  + `evidence, scope and the merge read commits, so these uncommitted changes would be gated `
  + `and never merged (and the committed diff would never be run)`;

// GATE-FIX-4 defect 1 (false-RED on macOS): os.tmpdir() returns /var/folders/…, a symlink into
// /private/var — so a baseline captured under the repo path and a head battery run under the tmp
// path disagree on every path-bearing fingerprint, and verify reds a green diff. graph.ts's
// saveGraph carries the standing precedent ("never os.tmpdir()" — rename(2) atomicity there, path
// identity here): tmpdir is fine for verify's disposable state, but only through realpathSync so
// every path verify hands to gates is already canonical. Exported for the unit test that pins the
// realpath (CI cannot rely on the macOS symlink).
export function verifyStateDir(cwd: string): string {
  return join(realpathSync(tmpdir()), "tickmarkr-verify", createHash("sha256").update(cwd).digest("hex").slice(0, 12));
}

const STATE_FILES = ["graph.json", "doctor.json", "config.yaml"] as const;
const LOCKFILES = ["package-lock.json", "npm-shrinkwrap.json", "pnpm-lock.yaml", "yarn.lock", "bun.lock", "bun.lockb"] as const;

/** Linked worktrees share operational state with the repository that owns the common git dir. */
export async function verifyStateRoot(cwd: string): Promise<string> {
  const commonDir = resolve(cwd, (await shGitOk("git rev-parse --git-common-dir", cwd)).trim());
  const commonRoot = realpathSync(dirname(commonDir));
  if (commonRoot === realpathSync(cwd)) return cwd;
  const localState = join(cwd, ".tickmarkr");
  const commonState = join(commonRoot, ".tickmarkr");
  return STATE_FILES.some((file) => !existsSync(join(localState, file)) && existsSync(join(commonState, file)))
    ? commonRoot
    : cwd;
}

const hashParts = (parts: Array<string | Buffer>): string => {
  const hash = createHash("sha256");
  for (const part of parts) hash.update(part);
  return hash.digest("hex").slice(0, 12);
};

/** Cache identity is repository content, never a checkout path. */
export function baselineCachePath(cwd: string, baseSha: string, commands: Record<string, string>): string {
  const lockParts: Array<string | Buffer> = [];
  for (const file of LOCKFILES) {
    const path = join(cwd, file);
    lockParts.push(file, existsSync(path) ? readFileSync(path) : "<absent>");
  }
  const commandParts = Object.entries(commands).sort(([a], [b]) => a.localeCompare(b)).map(([name, command]) => `${name}\0${command}\0`);
  return join(realpathSync(tmpdir()), "tickmarkr-verify", "cache",
    `baseline-${baseSha.slice(0, 12)}-${hashParts(lockParts)}-${hashParts(commandParts)}.json`);
}

const verdictlessCommands = (baseline: Baseline, commands: Record<string, string>): string[] =>
  Object.keys(commands).filter((name) => baseline.commands[name]?.exitCode === undefined);

export function excludeAuthorProvider(channels: BillingChannel[], author: BillingChannel): BillingChannel[] {
  const provider = modelProvider(author.model, author.vendor);
  return [author, ...channels.filter((candidate) => candidate !== author && modelProvider(candidate.model, candidate.vendor) !== provider)];
}

function recordedMerges(repoRoot: string): Array<{ runId: string; taskId: string; commit: string }> {
  const runs = join(repoRoot, ".tickmarkr", "runs");
  if (!existsSync(runs)) return [];
  const rows: Array<{ runId: string; taskId: string; commit: string }> = [];
  for (const runId of readdirSync(runs).filter((name) => name.startsWith("run-")).sort().reverse()) {
    const path = join(runs, runId, "journal.jsonl");
    if (!existsSync(path)) continue;
    for (const line of readFileSync(path, "utf8").split("\n").filter(Boolean)) {
      try {
        const row = JSON.parse(line) as { event?: string; taskId?: string; data?: { commit?: string } };
        if (row.event === "merge" && row.taskId && row.data?.commit) rows.push({ runId, taskId: row.taskId, commit: row.data.commit });
      } catch { /* torn journal tail is not a merge record */ }
    }
  }
  return rows;
}

async function warnWideTaskRange(cwd: string, stateRoot: string, taskId: string, mergeBase: string): Promise<void> {
  const inRange = new Set((await shGitOk(`git rev-list --merges '${mergeBase}..HEAD'`, cwd)).trim().split("\n").filter(Boolean));
  const merges = recordedMerges(stateRoot).filter((row) => inRange.has(row.commit));
  const own = merges.find((row) => row.taskId === taskId);
  const others = own ? merges.filter((row) => row.taskId !== taskId) : [];
  if (own && others.length) {
    console.error(`verify: WARNING --task ${taskId} range also carries merge commit(s) for ${others.map((row) => `${row.taskId} ${row.commit.slice(0, 12)}`).join(", ")}; ${taskId}'s own merge ${own.commit} is the intended HEAD`);
  }
}

export const VERIFY_HELP = `usage: tickmarkr verify [--base <ref>] [--criteria <file> | --task <id>] [--json]
The final verdict and JSON result are written to stdout; progress and diagnostics are written to stderr.
Do not merge stdout and stderr (for example with 2>&1): doing so corrupts the verdict stream.`;

export async function verify(argv: string[], cwd = process.cwd()): Promise<{ out: string; code: number }> {
  if (argv.some((arg) => arg === "--help" || arg === "-h")) return { out: VERIFY_HELP, code: 0 };
  const { values } = parseArgs({
    args: argv,
    options: {
      base: { type: "string", default: "main" },
      criteria: { type: "string" },
      task: { type: "string" },
      files: { type: "string", multiple: true },
      author: { type: "string" },
      baseline: { type: "string" },
      record: { type: "string" },
      json: { type: "boolean", default: false },
      "no-review": { type: "boolean", default: false },
      "no-acceptance": { type: "boolean", default: false },
    },
    allowPositionals: false,
  });

  const stateRoot = await verifyStateRoot(cwd);
  if (resolve(stateRoot) !== resolve(cwd)) {
    console.error(`verify: state files graph.json, doctor.json and config.yaml resolved read-only from ${join(stateRoot, ".tickmarkr")} (linked worktree)`);
  }
  const cfg = loadConfig(stateRoot);
  const head = (await shGitOk("git rev-parse HEAD", cwd)).trim();
  const baseTip = (await shGitOk(`git rev-parse '${values.base}'`, cwd).catch(() => {
    throw new Error(`--base ${values.base} is not a resolvable ref — pass --base <ref> naming the branch this diff targets`);
  })).trim();
  const mergeBase = (await shGitOk(`git merge-base '${baseTip}' HEAD`, cwd)).trim();
  if (mergeBase === head) {
    throw new Error(`nothing to verify — HEAD is contained in ${values.base} (merge-base == HEAD). Commit work on a branch first.`);
  }

  // Criteria: an explicit compiled task, a criteria file, or none (deterministic gates + review only).
  let acceptance: AcceptanceItem[] = [];
  let files = values.files ?? [];
  let goal = `independent verification of the ${values.base}..HEAD diff`;
  if (values.task) {
    const t = getTask(loadGraph(stateRoot), values.task);
    acceptance = t.acceptance;
    if (!files.length) files = t.files;
    goal = t.goal;
  } else if (values.criteria) {
    acceptance = parseCriteria(readFileSync(values.criteria, "utf8"));
    if (!acceptance.length) throw new Error(`--criteria ${values.criteria}: no criteria found (bullets or command:/test:/judge: lines)`);
  }

  if (values.task) await warnWideTaskRange(cwd, stateRoot, values.task, mergeBase);

  const wantAcceptance = acceptance.length > 0 && !values["no-acceptance"];
  const wantReview = !values["no-review"];
  // A gate that enforced nothing must not print a green row. `files` has exactly three sources —
  // explicit --files, a compiled task's own files[], or nothing — and only the third leaves the
  // allowlist empty, where scopeGate passes as "no file scope declared — unrestricted"
  // (scope.ts:41). An honest `details` string is no defence: the ROW is what gets quoted, and
  // quoting it launders a check that never ran. So scope filters on availability exactly as
  // acceptance and review do below — the report omits the gate rather than crediting one that
  // gated no allowlist. (Narrowing the empty allowlist to the changed set is the same green row by
  // another mechanism, and hides the same fact.)
  const gates = GATE_NAMES.filter((g): g is GateName =>
    (g !== "acceptance" || wantAcceptance) && (g !== "review" || wantReview) && (g !== "scope" || files.length > 0));

  const task: Task = {
    id: "VERIFY", title: "standalone verification", goal, shape: "implement", complexity: 5,
    deps: [], files, context: [], acceptance: acceptance.length ? acceptance : ["(deterministic verification only)"],
    gates, humanGate: false, status: "pending",
    evidence: { commits: [], artifacts: [], gateResults: [] },
  };

  const commands = detectGateCommands(cwd, cfg);

  // PRECONDITIONS (OBS-541) — every check that can refuse this candidate, evaluated together and
  // BEFORE the baseline capture below. Both read cheap local state (one `git status`, the doctor
  // cache), and both used to be read AFTER the capture: the dirty tree by runGates' own round-entry
  // refusal, the review seat by the resolution that sat under it. That cost one full capture per
  // refusal — measured at 602s and 590s on two refusals of the same candidate — to learn something
  // knowable in 50ms. Messages, exit taxonomy and fail-closed semantics are unchanged; only the
  // order is. Anything else that can refuse before a gate runs belongs in this phase, above capture.
  // `--untracked-files=all` is load-bearing twice over: it overrides a repo/user
  // `status.showUntrackedFiles=no` (under which untracked work is INVISIBLE and a dirty tree would
  // capture and gate GREEN), and it enumerates nested files individually instead of collapsing them
  // to a bare `?? dir/`, so the refusal names every offending path. The `.tickmarkr-*` exemption is
  // unaffected — the harness's droppings are root-level files, never directories.
  const status = await shGit("GIT_OPTIONAL_LOCKS=0 git status --porcelain --untracked-files=all", cwd);
  const dirt = status.code !== 0
    ? `git status failed (exit ${status.code}) — the worktree cannot be proven clean`
    : status.stdout.split("\n").map((l) => l.trimEnd())
      .filter((l) => l.trim() && !/^.. \.tickmarkr-[^/]*$/.test(l)).join("\n");
  if (dirt) throw new Error(`${DIRTY_WHY}:\n${dirt}`);

  // LLM seats only when a semantic gate will run.
  let channels: BillingChannel[] = [];
  let judgeChannels: BillingChannel[] | undefined;
  let author: Assignment = HUMAN_AUTHOR;
  const adapters = allAdapters();
  if (wantAcceptance || wantReview) {
    const health = readDoctor(stateRoot) ?? (await probeAll(adapters));
    const pools = rolePools(cfg, adapters, health);
    judgeChannels = pools.judge;
    channels = pools.review;
    if (values.author && values.author !== "human") {
      const [adapter, ...rest] = values.author.split(":");
      const model = rest.join(":");
      const c = channels.find((ch) => ch.adapter === adapter && ch.model === model);
      if (!c) {
        throw new Error(`--author ${values.author} does not name a discoverable review channel — one of: ${channels.map(channelKey).join(", ") || "(none)"}`);
      }
      author = { adapter: c.adapter, model: c.model, channel: c.channel, tier: c.tier };
      channels = excludeAuthorProvider(channels, c);
    } else {
      channels = [...channels, HUMAN_CHANNEL];
    }
    if (wantReview && !channels.some((c) => c.vendor !== "human")) {
      throw new Error("review gate needs at least one authed LLM channel (run `tickmarkr doctor`) — or pass --no-review");
    }
  }

  // Baseline: --baseline file > cached capture for this merge-base > fresh capture on a detached
  // temp worktree of the merge-base (so pre-existing failures on base are forgiven, exactly as a run).
  // ALL verify state (cache, base worktree, artifacts) lives OUTSIDE the repo: verify gates the repo
  // root itself, so any file it wrote there would trip the battery's own dirty-worktree refusal.
  // ponytail: tmpdir means the baseline cache dies on reboot/cleanup — worst case is one re-capture.
  const stateDir = verifyStateDir(cwd);
  mkdirSync(stateDir, { recursive: true });
  let baseline: Baseline;
  const cachePath = baselineCachePath(cwd, mergeBase, commands);
  const verdictlessMarker = `${cachePath}.verdictless`;
  mkdirSync(dirname(cachePath), { recursive: true });
  if (values.baseline) {
    baseline = JSON.parse(readFileSync(values.baseline, "utf8")) as Baseline;
  } else {
    let cached: Baseline | undefined;
    if (existsSync(cachePath)) {
      cached = JSON.parse(readFileSync(cachePath, "utf8")) as Baseline;
      const missing = verdictlessCommands(cached, commands);
      if (missing.length) {
        console.error(`verify: cached baseline recorded no verdict for ${missing.join(", ")}; it was not reusable and will be recaptured`);
        rmSync(cachePath, { force: true });
        cached = undefined;
      }
    }
    if (cached) {
      console.error(`verify: reusing cached baseline for ${mergeBase.slice(0, 12)} (${cachePath})`);
      baseline = cached;
    } else {
      if (existsSync(verdictlessMarker)) {
        console.error(`verify: prior baseline recorded no verdict and was not cached; recapturing merge-base ${mergeBase.slice(0, 12)}`);
      } else {
        console.error(`verify: capturing baseline at merge-base ${mergeBase.slice(0, 12)} (cached by base, lockfile and command hashes at ${cachePath})`);
      }
      const baseDir = join(stateDir, `base-${mergeBase.slice(0, 12)}`);
      await shGit(`git worktree remove --force '${baseDir}'`, cwd); // stale leftover from an interrupted run
      await shGitOk(`git worktree add --detach '${baseDir}' '${mergeBase}'`, cwd);
      try {
        linkNodeModules(cwd, baseDir, { force: true });
        baseline = await captureBaseline(baseDir, commands);
        const missing = verdictlessCommands(baseline, commands);
        if (missing.length) {
          writeFileSync(verdictlessMarker, JSON.stringify({ base: mergeBase, commands: missing }) + "\n");
          rmSync(cachePath, { force: true });
        } else {
          writeFileSync(cachePath, JSON.stringify(baseline, null, 2));
          rmSync(verdictlessMarker, { force: true });
        }
      } finally {
        await removeWorktree(cwd, baseDir);
      }
    }
  }

  const recordJournal = values.record ? Journal.open(stateRoot, values.record) : undefined;
  const artifactDir = join(stateDir, new Date().toISOString().replace(/[:.]/g, "-"));
  mkdirSync(artifactDir, { recursive: true });

  const { results } = await runGates(task, {
    worktree: cwd, baseRef: mergeBase,
    result: { ok: true, summary: "standalone verify — no worker claims to trust", deviations: [], raw: "" },
    author, commands, baseline, channels, ...(judgeChannels ? { judgeChannels } : {}), adapters, cfg,
    pipeline: "v185", artifactDir,
    onGate: (e) => {
      if (e.phase === "start") console.error(`verify: → ${e.gate} (${e.index}/${e.total})`);
      else if (e.phase === "note") console.error(`verify: note ${e.gate} ${e.name} ${JSON.stringify(e.payload)}`);
      else console.error(`verify: ${e.result.pass ? "✓" : "✗"} ${e.result.gate} — ${e.result.details.split("\n")[0] ?? ""}`);
    },
  });

  const green = results.length > 0 && results.every((r) => r.pass || r.meta?.skipped === true);
  const reviewRows = results.filter((result) => result.gate === "review");
  const reviewFindings = reviewRows.flatMap((result) => result.details.split("\n").flatMap((line) => {
    const match = /^- \[([^\]]+)\] (.*)$/.exec(line);
    return match ? [{ classification: match[1], note: match[2], reviewer: result.meta?.reviewer }] : [];
  }));
  const artifactPath = join(artifactDir, "verify-results.json");
  writeFileSync(artifactPath, JSON.stringify({ base: baseTip, head, mergeBase, green, gateRows: results, reviewFindings }, null, 2) + "\n");
  console.error(`verify: artifacts written to ${artifactPath}`);
  const review = reviewRows.at(-1);
  if (recordJournal && review) {
    recordJournal.append("review-leg2", values.task ?? "VERIFY", {
      base: baseTip, head, mergeBase, author: channelKey(author), artifactPath,
      ...review,
    });
  }
  if (values.json) {
    return { out: JSON.stringify({ base: baseTip, head, mergeBase, green, artifactPath, results }, null, 2), code: green ? 0 : 2 };
  }
  const lines = results.map((r: GateResult) =>
    `${r.pass ? "PASS" : "FAIL"} ${r.gate}\n${r.details.split("\n").map((l) => `  ${l}`).join("\n")}`);
  const verdict = green
    ? `verify GREEN — ${results.length} gate(s) passed on ${mergeBase.slice(0, 12)}..${head.slice(0, 12)} (merge is a human decision; artifacts: ${artifactPath})`
    : `verify RED — first failure decides; artifacts: ${artifactPath}`;
  return { out: [...lines, "", verdict].join("\n"), code: green ? 0 : 2 };
}
