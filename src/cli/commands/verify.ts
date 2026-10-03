import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { allAdapters, probeAll, readDoctor, rolePools, writeDoctor } from "../../adapters/registry.js";
import { channelKey, type Assignment, type AuthHealth, type BillingChannel, type WorkerAdapter } from "../../adapters/types.js";
import { loadConfig, type TickmarkrConfig } from "../../config/config.js";
import { captureBaseline, detectGateCommands, staleFileCountCommands, type Baseline, type GateEvidenceOptions } from "../../gates/baseline.js";
import { getVerdictStore, runnerInputsHash, type StoredVerdictRecord } from "../../gates/cache.js";
import { modelProvider } from "../../gates/review.js";
import { runGates } from "../../gates/run-gates.js";
import type { GateResult } from "../../gates/types.js";
import { getTask, loadGraph } from "../../graph/graph.js";
import { GATE_NAMES, type AcceptanceItem, type GateName, type Task } from "../../graph/schema.js";
import { executionSignal } from "../../run/execution-budget.js";
import { linkNodeModules, removeWorktree, shGit, shGitOk } from "../../run/git.js";
import { foldOwedChecks, integrationMapped, owedCriteria, Journal, OWED_DISCHARGE_EVENT, type OwedCheck, type OwedFold } from "../../run/journal.js";
import { withRepositoryLease } from "../../run/lease.js";
import { isPidLive } from "../../run/lock.js";
import { recordLaunchServices } from "../../run/launchservices-check.js";

/**
 * tickmarkr verify — the gate battery as a standalone command (OPERATING-MODEL-2026-08-11 item 3).
 *
 * Runs the existing seven-gate pipeline against `merge-base(--base, HEAD)..HEAD` of the CURRENT
 * checkout in two phases: build/lint against a captured base baseline, evidence, scope, then
 * acceptance ‖ review, all unleased; then, under the repository lease, the test suite against its
 * own base baseline. No daemon, no worktree lifecycle, no retries, no approvals, no resumable state: one
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

/** Repository content plus the effective runner inputs the daemon hashes; never a checkout path. */
export function baselineCachePath(cwd: string, baseSha: string, commands: Record<string, string>): string {
  const lockParts: Array<string | Buffer> = [];
  for (const file of LOCKFILES) {
    const path = join(cwd, file);
    lockParts.push(file, existsSync(path) ? readFileSync(path) : "<absent>");
  }
  const commandParts = Object.entries(commands).sort(([a], [b]) => a.localeCompare(b)).map(([name, command]) => `${name}\0${command}\0`);
  return join(realpathSync(tmpdir()), "tickmarkr-verify", "cache",
    `baseline-${baseSha.slice(0, 12)}-${hashParts(lockParts)}-${hashParts(commandParts)}-${runnerInputsHash()}.json`);
}

const verdictlessCommands = (baseline: Baseline, commands: Record<string, string>): string[] =>
  Object.keys(commands).filter((name) => baseline.commands[name]?.exitCode === undefined);

export function excludeAuthorProvider(channels: BillingChannel[], author: BillingChannel): BillingChannel[] {
  const provider = modelProvider(author.model, author.vendor);
  return [author, ...channels.filter((candidate) => candidate !== author && modelProvider(candidate.model, candidate.vendor) !== provider)];
}

/**
 * G (D-874): `--author` names who wrote the diff so review can EXCLUDE it — it never asks for a seat. So
 * it resolves against installed identities (an installed adapter's doctor-listed or configured model),
 * not against the review pool, whose role allow/deny, model-auth and tier gates say nothing about
 * authorship. A pool member resolves to itself, unchanged. Anything else is an author-only identity: its
 * vendor is the configured declaration (the model's override, else the adapter entry's; the adapter's own
 * only when config has no entry), never inferred, and an unseeded model carries no tier of its own — it
 * holds the human sentinel's frontier floor, so the reviewer floor is never lowered. Same-vendor, so it
 * can never be seated. An identity nothing declares refuses by name.
 */
function authorIdentity(claim: string, cfg: TickmarkrConfig, adapters: WorkerAdapter[], health: Record<string, AuthHealth>, pool: BillingChannel[]): BillingChannel {
  const [adapter = "", ...rest] = claim.split(":");
  const model = rest.join(":");
  const member = pool.find((c) => c.adapter === adapter && c.model === model);
  if (member) return member;
  const a = adapters.find((x) => x.id === adapter);
  const h = health[adapter];
  const seeded = a?.channels(cfg).find((c) => c.model === model);
  const entry = cfg.tiers[adapter];
  const vendor = seeded?.vendor ?? (entry ? entry.modelOverrides?.[model]?.vendor ?? entry.vendor : a?.vendor);
  const why = !a ? `no registered adapter "${adapter}"`
    : !h?.installed ? `doctor does not record ${adapter} as installed`
    : !seeded && !h.models?.includes(model) ? `${adapter} neither lists "${model}" in doctor nor configures it`
    : !vendor ? `no vendor is declared for ${adapter}:${model}`
    : undefined;
  if (why) {
    throw new Error(`--author ${claim} does not name a discoverable author identity (${why}) — name an installed adapter's doctor-listed or configured model as <adapter>:<model>, or human`);
  }
  return seeded ?? { adapter, vendor: vendor!, model, channel: entry?.modelOverrides?.[model]?.channel ?? entry?.channel ?? "sub", tier: "frontier" };
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

export async function verify(argv: string[], cwd = process.cwd(), options: { evidence?: GateEvidenceOptions } = {}): Promise<{ out: string; code: number }> {
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
  const fileRoot = (file: typeof STATE_FILES[number]) =>
    existsSync(join(cwd, ".tickmarkr", file)) ? cwd : stateRoot;
  if (resolve(stateRoot) !== resolve(cwd)) {
    console.error(`verify: state files resolved read-only from ${join(stateRoot, ".tickmarkr")} (linked worktree; per-file origins: `
      + STATE_FILES.map(file => `${file}: ${join(fileRoot(file), ".tickmarkr", file)} (${fileRoot(file) === cwd ? "local" : "common root"})`).join("; ") + ")");
  }
  const cfg = loadConfig(fileRoot("config.yaml"));
  const head = (await shGitOk("git rev-parse HEAD", cwd)).trim();
  // Git appends every move of HEAD to its reflog — one a gate command makes and undoes itself included —
  // so the log as of this capture is the subject's witness: any later difference is a move (fail closed).
  const headLogPath = resolve(cwd, (await shGitOk("git rev-parse --git-path logs/HEAD", cwd)).trim());
  const headLog = () => { try { return readFileSync(headLogPath, "utf8"); } catch { return ""; } };
  const headLogAtCapture = headLog();
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
    const t = getTask(loadGraph(fileRoot("graph.json")), values.task);
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
  const candidateDirt = async (): Promise<string | undefined> => {
    const status = await shGit("GIT_OPTIONAL_LOCKS=0 git status --porcelain --untracked-files=all", cwd);
    const dirt = status.code !== 0
      ? `git status failed (exit ${status.code}) — the worktree cannot be proven clean`
      : status.stdout.split("\n").map((l) => l.trimEnd())
        .filter((l) => l.trim() && !/^.. \.tickmarkr-[^/]*$/.test(l)).join("\n");
    return dirt ? `${DIRTY_WHY}:\n${dirt}` : undefined;
  };
  const dirt = await candidateDirt();
  if (dirt) throw new Error(dirt);

  // C1: a --record into a run that owes checks is a discharge attempt, bound before any seat or
  // capture is spent. It must name the exact obligation — its run, task, immutable range (or that
  // range's validated integration merge), required gate and unchanged criteria — or it refuses with
  // exit 2 and the check stays outstanding. Unknown debt refuses outright: nothing proves it paid.
  const recordJournal = values.record ? Journal.open(stateRoot, values.record) : undefined;
  const owedBefore = recordJournal ? foldOwedChecks(recordJournal.read(), cwd) : undefined;
  const debtLine = (fold: OwedFold) => `owed checks for ${values.record}: debt ${fold.debt}`
    + (fold.outstanding.length ? ` — outstanding ${fold.outstanding.map((o) => `${o.taskId}/${o.gate} ${o.id}`).join(", ")}` : "")
    + (fold.unknown.length ? ` — unknown: ${fold.unknown.map((u) => `${u.taskId ?? "?"}${u.gate ? `/${u.gate}` : ""} ${u.reason}`).join("; ")}` : "");
  const refuseDischarge = (why: string) => ({ out: `verify --record refused: ${why}\n${debtLine(owedBefore!)}`, code: 2 });
  let owed: OwedCheck[] = [];
  let mapping: "exact" | "integration" = "exact";
  if (owedBefore && (!owedBefore.known || owedBefore.outstanding.length > 0)) {
    if (!owedBefore.known) return refuseDischarge("the run's owed-check debt is unknown (legacy, missing or malformed evidence)");
    const own = owedBefore.outstanding.filter((o) => o.runId === values.record && o.taskId === values.task);
    if (!own.length) return refuseDischarge(`run ${values.record} owes no check for task ${values.task ?? "(no --task)"}`);
    owed = own.filter((o) => o.base === mergeBase && o.head === head);
    if (!owed.length) {
      const events = recordJournal!.read();
      owed = own.filter((o) => integrationMapped(cwd, events, o, mergeBase, head));
      mapping = "integration";
    }
    if (!owed.length) return refuseDischarge(`${mergeBase.slice(0, 12)}..${head.slice(0, 12)} is neither an owed check's exact range nor a validated integration merge of it (ambiguous or rewritten history is refused)`);
    // The evidence is the obligation's own: its task's scope against a baseline this invocation captures.
    if (values.files?.length) return refuseDischarge(`a discharge gates the recorded scope of ${values.task}; --files cannot replace it`);
    if (values.baseline) return refuseDischarge("a discharge captures its own baseline; --baseline cannot supply one");
    for (const o of owed) {
      if (JSON.stringify(files) !== JSON.stringify(o.files)) return refuseDischarge(`check ${o.id} bound another file scope than ${values.task}'s current one`);
      if (!gates.includes(o.gate)) return refuseDischarge(`check ${o.id} requires the ${o.gate} gate, which this invocation skips`);
      if (owedCriteria(acceptance) !== o.criteria) return refuseDischarge(`check ${o.id} bound other acceptance criteria than ${values.task}'s current ones`);
    }
  }

  // LLM seats only when a semantic gate will run.
  let channels: BillingChannel[] = [];
  let judgeChannels: BillingChannel[] | undefined;
  let author: Assignment = HUMAN_AUTHOR;
  let carriedAuthors: string[] = [];
  const adapters = allAdapters();
  if (wantAcceptance || wantReview) {
    const health = readDoctor(fileRoot("doctor.json")) ?? (await probeAll(adapters));
    const pools = rolePools(cfg, adapters, health);
    judgeChannels = pools.judge;
    channels = pools.review;
    // Resolved before either branch so an undiscoverable claim refuses here, ahead of any capture —
    // even where recorded authors bind and the claim is otherwise ignored.
    const claimed = values.author && values.author !== "human" ? authorIdentity(values.author, cfg, adapters, health, channels) : undefined;
    if (owed.length) {
      // The run's lifetime patch authors bind the reviewer's exclusions; --author never overrides
      // them. An author the pool cannot resolve leaves review unseatable, which fails closed.
      carriedAuthors = [...new Set(owed.flatMap((o) => o.authors))];
      if (values.author) console.error(`verify: --author ${values.author} ignored — ${values.record}'s recorded patch authors (${carriedAuthors.join(", ")}) bind this discharge`);
      const first = channels.find((c) => channelKey(c) === carriedAuthors[0]);
      if (first) author = { adapter: first.adapter, model: first.model, channel: first.channel, tier: first.tier };
    } else if (claimed) {
      author = { adapter: claimed.adapter, model: claimed.model, channel: claimed.channel, tier: claimed.tier };
      channels = excludeAuthorProvider(channels, claimed);
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

  // T5 (D): only the full suite and its baseline need the repository's runner lease. build/lint
  // (baseline and candidate), evidence, scope and judge ‖ review run first and unleased, so a red
  // there ends verify without queueing behind another worktree's suite. Each command subset keeps
  // its own baseline cache identity; the rows of both phases fold into ONE AND verdict and ONE
  // artifact. With no test command there is no suite to lease: the skipped test row stays up front.
  // (tipTest is a tip-verify command runGates never executes here, so neither subset captures it.)
  const subsetOf = (names: readonly string[]) => Object.fromEntries(Object.entries(commands).filter(([name]) => names.includes(name)));
  const cheapCommands = subsetOf(["build", "lint"]);
  const leased = gates.filter((g) => g === "test" && commands.test !== undefined);
  // The suite's base capture rebuilds first in its own worktree: a suite that reads ignored build
  // outputs (dist/) must meet them at base as the candidate does, or its unchanged failures read as
  // new. So build belongs to the suite subset's capture — and to its cache identity.
  const suiteCommands = leased.length ? subsetOf(["build", "test"]) : {};
  // A prior verdictless capture is announced before any gate runs, whichever phase will recapture it.
  if (!values.baseline) {
    for (const subset of [cheapCommands, suiteCommands]) {
      if (Object.keys(subset).length && existsSync(`${baselineCachePath(cwd, mergeBase, subset)}.verdictless`)) {
        console.error(`verify: prior baseline recorded no verdict and was not cached; recapturing merge-base ${mergeBase.slice(0, 12)} for ${Object.keys(subset).join(", ")}`);
      }
    }
  }

  async function baselineFor(subset: Record<string, string>): Promise<Baseline> {
    if (values.baseline) return JSON.parse(readFileSync(values.baseline, "utf8")) as Baseline;
    const names = Object.keys(subset);
    if (!names.length) return { commands: {} };
    const cachePath = baselineCachePath(cwd, mergeBase, subset);
    const verdictlessMarker = `${cachePath}.verdictless`;
    mkdirSync(dirname(cachePath), { recursive: true });
    let cached: Baseline | undefined;
    if (existsSync(cachePath)) {
      try {
        cached = JSON.parse(readFileSync(cachePath, "utf8")) as Baseline;
      } catch {
        console.error(`verify: cached baseline at ${cachePath} is unreadable; it will be recaptured`);
      }
      const missing = cached ? verdictlessCommands(cached, subset) : [];
      if (missing.length) {
        console.error(`verify: cached baseline recorded no verdict for ${missing.join(", ")}; it was not reusable and will be recaptured`);
        cached = undefined;
      }
      // OBS-1044: a cached vitest count that is a stdout sum may be inflated by nested runner echo;
      // applying it would manufacture a deficit. Only a manifest-derived count is a floor.
      const stale = cached ? staleFileCountCommands(cached, subset, cwd) : [];
      if (stale.length) {
        console.error(`verify: cached baseline's file count for ${stale.join(", ")} is not manifest-derived; it will be recaptured`);
        cached = undefined;
      }
      if (!cached) rmSync(cachePath, { force: true });
    }
    if (cached) {
      console.error(`verify: reusing cached baseline for ${mergeBase.slice(0, 12)} (${names.join(", ")}: ${cachePath})`);
      return cached;
    }
    console.error(`verify: capturing baseline at merge-base ${mergeBase.slice(0, 12)} for ${names.join(", ")} (cached by base, lockfile, command and effective runner hashes at ${cachePath})`);
    // Unleased captures of the SAME checkout overlap, so each owns a unique base worktree and removes
    // only its own; the pid in the name lets a later verify sweep what a killed one left behind.
    for (const entry of readdirSync(stateDir)) {
      const owner = /^base-[0-9a-f]{12}-(\d+)-\w{6}$/.exec(entry)?.[1];
      if (owner && !isPidLive(Number(owner))) await removeWorktree(cwd, join(stateDir, entry));
    }
    const baseDir = mkdtempSync(join(stateDir, `base-${mergeBase.slice(0, 12)}-${process.pid}-`));
    try {
      await shGitOk(`git worktree add --detach '${baseDir}' '${mergeBase}'`, cwd);
      linkNodeModules(cwd, baseDir, { force: true });
      const baseline = await captureBaseline(baseDir, subset);
      if (baseline.refusal) return baseline;
      const missing = verdictlessCommands(baseline, subset);
      if (missing.length) {
        writeFileSync(verdictlessMarker, JSON.stringify({ base: mergeBase, commands: missing }) + "\n");
        rmSync(cachePath, { force: true });
      } else {
        writeFileSync(cachePath, JSON.stringify(baseline, null, 2));
        rmSync(verdictlessMarker, { force: true });
      }
      return baseline;
    } finally {
      await removeWorktree(cwd, baseDir);
    }
  }

  const gateRun = async (phaseGates: GateName[], baseline: Baseline): Promise<GateResult[]> => (await runGates({ ...task, gates: phaseGates }, {
    worktree: cwd, baseRef: mergeBase,
    result: { ok: true, summary: "standalone verify — no worker claims to trust", deviations: [], raw: "" },
    author, ...(carriedAuthors.length ? { carriedAuthors } : {}), commands, baseline, channels, ...(judgeChannels ? { judgeChannels } : {}), adapters, cfg,
    evidence: options.evidence,
    verificationScope: "standalone", artifactDir, stateDir: stagedStateDir,
    onGate: async (e) => {
      // Every gate boundary re-validates (and latches) the subject: see subjectChange below.
      if (e.phase !== "note") await subjectChange();
      if (e.phase === "start") console.error(`verify: → ${e.gate} (${e.index}/${e.total})`);
      else if (e.phase === "note") console.error(`verify: note ${e.gate} ${e.name} ${JSON.stringify(e.payload)}`);
      else console.error(`verify: ${e.result.pass ? "✓" : "✗"} ${e.result.gate} — ${e.result.details.split("\n")[0] ?? ""}`);
    },
  })).results;
  const isGreen = (rows: GateResult[]) => rows.length > 0 && rows.every((r) => r.pass || r.meta?.skipped === true);

  const cheapBaseline = await baselineFor(cheapCommands);
  if (cheapBaseline.refusal) return { out: cheapBaseline.refusal, code: 1 };
  // Unleased verifies of one checkout can start in the same millisecond: the timestamp only orders
  // the directories, the exclusive suffix makes each invocation's artifact its own.
  const artifactDir = mkdtempSync(join(stateDir, `${new Date().toISOString().replace(/[:.]/g, "-")}-`));
  // The store keys a green on the tree its command STARTED from, so a build that committed a fix would
  // publish a green "for" the unfixed tree — and a verify killed before any cleanup would leave it for a
  // later verify or discharge to reuse. So this invocation's gates read and write a store private to it:
  // seeded only with verdicts a completed subject validation published, and published from only after
  // every phase's subject check held (below). A killed invocation's staging is never read again.
  const sharedVerdicts = getVerdictStore(join(stateRoot, ".tickmarkr"));
  const stagedStateDir = join(artifactDir, "staged-verdicts");
  const staged = getVerdictStore(stagedStateDir);
  const storedRows = (dir: string) => readdirSync(dir).filter((f) => f.startsWith("verdict-") && f.endsWith(".json")).flatMap((file) => {
    try { return [{ file, record: JSON.parse(readFileSync(join(dir, file), "utf8")) as StoredVerdictRecord }]; } catch { return []; }
  });
  for (const { file, record } of storedRows(sharedVerdicts.dir)) {
    if (typeof record.verdict?.meta?.validatedSubject === "string") copyFileSync(join(sharedVerdicts.dir, file), join(staged.dir, file));
  }
  // The subject is immutable: every row must answer for `head` on a clean tree. A gate command that
  // commits or dirties the candidate (a build step landing a fix) measured other bytes than the verdict,
  // artifact and any discharge name, so each phase AND each gate boundary (onGate start/end) is checked.
  // The first change LATCHES: a later gate restoring HEAD (lint resetting the build's commit) or the
  // tree never un-refuses it, and HEAD's reflog witnesses a move a single command made and undid.
  // HEAD is re-read through the same reader that captured `head`, so both sides compare like for like.
  let subjectLatch: string | undefined;
  const subjectChange = async (): Promise<string | undefined> => {
    const now = await shGitOk("git rev-parse HEAD", cwd).then((out) => out.trim(), () => undefined);
    const why = now === undefined ? "HEAD is unreadable"
      : now !== head ? `HEAD moved from ${head.slice(0, 12)} to ${now.slice(0, 12)}`
      : headLog() !== headLogAtCapture ? `HEAD moved and was restored to ${head.slice(0, 12)} (its reflog recorded the move)`
      : await candidateDirt();
    if (why) subjectLatch ??= why;
    return subjectLatch;
  };
  const refusedSubject = (why: string) => `refusing the verdict: the candidate changed while its gates ran, so no one subject carries every gate — ${why}`;
  const cheapGates = gates.filter((g) => !leased.includes(g));
  const changedBefore = await subjectChange();
  let results: GateResult[] = changedBefore
    ? [{ gate: cheapGates[0]!, pass: false, details: refusedSubject(changedBefore), meta: { subjectChanged: changedBefore } }]
    : await gateRun(cheapGates, cheapBaseline);
  const changedAfter = changedBefore ? undefined : await subjectChange();
  if (changedAfter) results = results.map((r) => ({ ...r, pass: false, details: `${refusedSubject(changedAfter)}\n${r.details}`, meta: { ...r.meta, subjectChanged: changedAfter } }));

  if (leased.length && isGreen(results)) {
    // ...and the suite must measure those same bytes: its green may only join the AND verdict if they still hold.
    const refused = (why: string) => `refusing the suite verdict: the candidate changed between semantic completion and suite completion, so no one subject carries every gate — ${why}`;
    // OBS-1042: one runner root per repository across every linked worktree — the suite baseline and
    // the candidate suite run under a reservation keyed on the common git dir; a waiter says who holds it.
    const suite = await withRepositoryLease(cwd, async (): Promise<GateResult[]> => {
      const before = await subjectChange();
      if (before) return [{ gate: "test", pass: false, details: refused(before), meta: { subjectChanged: before } }];
      const baseline = await baselineFor(suiteCommands);
      // The earlier gates already answered: a refused suite baseline is the test gate's red, and it
      // joins their rows in the one verdict and artifact rather than discarding them.
      if (baseline.refusal) return [{ gate: "test", pass: false, details: baseline.refusal, meta: { infra: true, classification: "infra", retryable: false, kind: "workspace-dependency" } }];
      const rows = await gateRun(leased, baseline);
      const after = await subjectChange();
      return after ? rows.map((r) => ({ ...r, pass: false, details: `${refused(after)}\n${r.details}`, meta: { ...r.meta, subjectChanged: after } })) : rows;
    }, {
      signal: executionSignal(),
      onWait: (holder) => {
        console.error(`verify: waiting for the repository's runner lease held by pid ${holder.pid} in ${holder.cwd}`);
        recordJournal?.append("suite-wait", values.task ?? "VERIFY", { holderPid: holder.pid, holderCwd: holder.cwd });
      },
    });
    results = [...results, ...suite].sort((a, b) => GATE_NAMES.indexOf(a.gate as GateName) - GATE_NAMES.indexOf(b.gate as GateName));
  }

  // The last boundary. A change latched anywhere above refuses every row (so nothing is discharged) and
  // publishes nothing; otherwise every gate answered for `head` on a clean tree, and this invocation's
  // fresh verdicts are published, stamped with the subject they were validated against.
  const changedAtEnd = await subjectChange();
  if (changedAtEnd) {
    results = results.map((r) => r.meta?.subjectChanged ? r : { ...r, pass: false, details: `${refusedSubject(changedAtEnd)}\n${r.details}`, meta: { ...r.meta, subjectChanged: changedAtEnd } });
  } else {
    for (const { record } of storedRows(staged.dir)) {
      if (record.verdict?.meta?.runDir === artifactDir) sharedVerdicts.set(record.identity, { ...record.verdict, meta: { ...record.verdict.meta, validatedSubject: head } });
    }
  }
  rmSync(stagedStateDir, { recursive: true, force: true });

  const green = isGreen(results);
  const reviewRows = results.filter((result) => result.gate === "review");
  const reviewFindings = reviewRows.flatMap((result) => result.details.split("\n").flatMap((line) => {
    const match = /^- \[([^\]]+)\] (.*)$/.exec(line);
    return match ? [{ classification: match[1], note: match[2], reviewer: result.meta?.reviewer }] : [];
  }));
  const artifactPath = join(artifactDir, "verify-results.json");
  // `criteria` is the digest of the acceptance this invocation measured: a discharge's fold binds it.
  const artifactBytes = Buffer.from(JSON.stringify({ base: baseTip, head, mergeBase, green, files, criteria: owedCriteria(acceptance), gateRows: results, reviewFindings }, null, 2) + "\n");
  let artifactSha256: string | null = null;
  let artifactAvailability: "available" | "capture-failed" = "capture-failed";
  try {
    writeFileSync(artifactPath, artifactBytes, { flag: "wx" });
    artifactSha256 = createHash("sha256").update(artifactBytes).digest("hex");
    artifactAvailability = "available";
    console.error(`verify: artifacts written to ${artifactPath}`);
  } catch {
    console.error(`verify: evidence capture failed for ${artifactPath}`);
  }
  const review = reviewRows.at(-1);
  // C1: ONE discharge row names what the fold re-reads — the artifact by hash, the range mapping, the
  // criteria and each resolved channel — and it is appended only when the fold, the single decider,
  // already accepts it: verify never writes a proof that would turn known debt into unknown debt.
  let dischargeRefusal: string | undefined;
  if (recordJournal && owed.length) {
    const facts = (key: string) => channels.find((c) => channelKey(c) === key);
    const reviewer = typeof review?.meta?.reviewer === "string" ? facts(review.meta.reviewer) : undefined;
    const authorChannels = carriedAuthors.map(facts).filter((c): c is BillingChannel => c !== undefined);
    const data = {
      ids: owed.map((o) => o.id), gates: owed.map((o) => o.gate), mapping, mergeBase, head, criteria: owedCriteria(acceptance),
      ...(mapping === "integration" ? { patch: owed[0]!.patch } : {}),
      artifactPath, artifactSha256,
      ...(reviewer ? { reviewer: { key: channelKey(reviewer), vendor: reviewer.vendor } } : {}),
      authorChannels: authorChannels.map((c) => ({ key: channelKey(c), vendor: c.vendor })),
    };
    const candidate = green && artifactAvailability === "available"
      ? foldOwedChecks([...recordJournal.read(), { ts: new Date().toISOString(), event: OWED_DISCHARGE_EVENT, taskId: values.task, data }], cwd)
      : undefined;
    if (!green) dischargeRefusal = "the verdict is not green";
    else if (!candidate) dischargeRefusal = "the results artifact is unavailable";
    else if (!candidate.known || !owed.every((o) => candidate.discharged.includes(o.id))) dischargeRefusal = candidate.unknown.at(-1)?.reason ?? "the proof does not discharge the check";
    else recordJournal.append(OWED_DISCHARGE_EVENT, values.task, data);
  }
  const owedAfter = recordJournal ? foldOwedChecks(recordJournal.read(), cwd) : undefined;
  const code = green && !dischargeRefusal ? 0 : 2;
  const owedLines = owedAfter && (owed.length || owedAfter.acceptedRisk.length || !owedAfter.known)
    ? [...(dischargeRefusal ? [`verify --record refused discharge: ${dischargeRefusal}`] : []), debtLine(owedAfter)] : [];
  if (recordJournal && review) {
    recordJournal.append("review-leg2", values.task ?? "VERIFY", {
      base: baseTip, head, mergeBase, author: channelKey(author), artifactPath, artifactSha256, artifactAvailability,
      ...review,
    });
  }
  // A1 (D-787/D-789): one bounded launchservicesd identity read AFTER the verdict is final, so a suite
  // that restarted the daemon is caught and the verdict, exit code and retries never depend on it.
  // It rides the doctor.json verify read; with none there it creates no state file.
  const doctorRoot = fileRoot("doctor.json");
  const priorDoctor = readDoctor(doctorRoot);
  const launchServices = priorDoctor ? await recordLaunchServices(priorDoctor, priorDoctor) : undefined;
  if (launchServices && launchServices.health !== priorDoctor) {
    // Evidence only, not a probe: keep doctor.json's mtime (the auth-cache freshness signal, doctorAgeMs),
    // and a failed write is an advisory diagnostic — the verdict below is returned regardless.
    const doctorFile = join(doctorRoot, ".tickmarkr", "doctor.json");
    try {
      const { atime, mtime } = statSync(doctorFile);
      writeDoctor(doctorRoot, launchServices.health);
      utimesSync(doctorFile, atime, mtime);
    } catch (e) {
      console.error(`verify: launchservicesd evidence not persisted (${e instanceof Error ? e.message : String(e)}) (advisory — verdict unchanged)`);
    }
  }
  if (launchServices?.line) console.error(`verify: ${launchServices.line}`);
  if (values.json) {
    return { out: JSON.stringify({ base: baseTip, head, mergeBase, green, artifactPath, artifactSha256, artifactAvailability, results,
      ...(owedAfter && owedLines.length ? { owed: { debt: owedAfter.debt, discharged: dischargeRefusal ? [] : owed.map((o) => o.id), ...(dischargeRefusal ? { refused: dischargeRefusal } : {}) } } : {}),
    }, null, 2), code };
  }
  const lines = results.map((r: GateResult) =>
    `${r.pass ? "PASS" : "FAIL"} ${r.gate}\n${r.details.split("\n").map((l) => `  ${l}`).join("\n")}`);
  const verdict = green
    ? `verify GREEN — ${results.length} gate(s) passed on ${mergeBase.slice(0, 12)}..${head.slice(0, 12)} (merge is a human decision; artifacts: ${artifactPath})`
    : `verify RED — first failure decides; artifacts: ${artifactPath}`;
  return { out: [...lines, "", verdict, ...owedLines].join("\n"), code };
}
