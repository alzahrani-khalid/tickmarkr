import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { allAdapters, probeAll, readDoctor, rolePools } from "../../adapters/registry.js";
import { channelKey, type Assignment, type BillingChannel } from "../../adapters/types.js";
import { loadConfig } from "../../config/config.js";
import { captureBaseline, detectGateCommands, type Baseline } from "../../gates/baseline.js";
import { runGates } from "../../gates/run-gates.js";
import type { GateResult } from "../../gates/types.js";
import { getTask, loadGraph } from "../../graph/graph.js";
import { GATE_NAMES, type AcceptanceItem, type GateName, type Task } from "../../graph/schema.js";
import { linkNodeModules, removeWorktree, shGit, shGitOk } from "../../run/git.js";

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

export async function verify(argv: string[], cwd = process.cwd()): Promise<{ out: string; code: number }> {
  const { values } = parseArgs({
    args: argv,
    options: {
      base: { type: "string", default: "main" },
      criteria: { type: "string" },
      task: { type: "string" },
      files: { type: "string", multiple: true },
      author: { type: "string" },
      baseline: { type: "string" },
      json: { type: "boolean", default: false },
      "no-review": { type: "boolean", default: false },
      "no-acceptance": { type: "boolean", default: false },
    },
    allowPositionals: false,
  });

  const cfg = loadConfig(cwd);
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
    const t = getTask(loadGraph(cwd), values.task);
    if (!t) throw new Error(`--task ${values.task}: no such task in .tickmarkr/graph.json`);
    acceptance = t.acceptance;
    if (!files.length) files = t.files;
    goal = t.goal;
  } else if (values.criteria) {
    acceptance = parseCriteria(readFileSync(values.criteria, "utf8"));
    if (!acceptance.length) throw new Error(`--criteria ${values.criteria}: no criteria found (bullets or command:/test:/judge: lines)`);
  }

  const wantAcceptance = acceptance.length > 0 && !values["no-acceptance"];
  const wantReview = !values["no-review"];
  const gates = GATE_NAMES.filter((g): g is GateName =>
    (g !== "acceptance" || wantAcceptance) && (g !== "review" || wantReview));

  const task: Task = {
    id: "VERIFY", title: "standalone verification", goal, shape: "implement", complexity: 5,
    deps: [], files, context: [], acceptance: acceptance.length ? acceptance : ["(deterministic verification only)"],
    gates, humanGate: false, status: "pending",
    evidence: { commits: [], artifacts: [], gateResults: [] },
  };

  const commands = detectGateCommands(cwd, cfg);

  // Baseline: --baseline file > cached capture for this merge-base > fresh capture on a detached
  // temp worktree of the merge-base (so pre-existing failures on base are forgiven, exactly as a run).
  // ALL verify state (cache, base worktree, artifacts) lives OUTSIDE the repo: verify gates the repo
  // root itself, so any file it wrote there would trip the battery's own dirty-worktree refusal.
  // ponytail: tmpdir means the baseline cache dies on reboot/cleanup — worst case is one re-capture.
  const stateDir = join(tmpdir(), "tickmarkr-verify", createHash("sha256").update(cwd).digest("hex").slice(0, 12));
  mkdirSync(stateDir, { recursive: true });
  let baseline: Baseline;
  const cachePath = join(stateDir, `baseline-${mergeBase.slice(0, 12)}.json`);
  if (values.baseline) {
    baseline = JSON.parse(readFileSync(values.baseline, "utf8")) as Baseline;
  } else if (existsSync(cachePath)) {
    console.error(`verify: reusing cached baseline for ${mergeBase.slice(0, 12)} (${cachePath})`);
    baseline = JSON.parse(readFileSync(cachePath, "utf8")) as Baseline;
  } else {
    const baseDir = join(stateDir, `base-${mergeBase.slice(0, 12)}`);
    console.error(`verify: capturing baseline at merge-base ${mergeBase.slice(0, 12)} (one-time per base; cached at ${cachePath})`);
    await shGit(`git worktree remove --force '${baseDir}'`, cwd); // stale leftover from an interrupted run
    await shGitOk(`git worktree add --detach '${baseDir}' '${mergeBase}'`, cwd);
    try {
      linkNodeModules(cwd, baseDir, { force: true });
      baseline = await captureBaseline(baseDir, commands);
      writeFileSync(cachePath, JSON.stringify(baseline, null, 2));
    } finally {
      await removeWorktree(cwd, baseDir);
    }
  }

  // LLM seats only when a semantic gate will run.
  let channels: BillingChannel[] = [];
  let judgeChannels: BillingChannel[] | undefined;
  let author: Assignment = HUMAN_AUTHOR;
  const adapters = allAdapters();
  if (wantAcceptance || wantReview) {
    const health = readDoctor(cwd) ?? (await probeAll(adapters));
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
    } else {
      channels = [...channels, HUMAN_CHANNEL];
    }
    if (wantReview && !channels.some((c) => c.vendor !== "human")) {
      throw new Error("review gate needs at least one authed LLM channel (run `tickmarkr doctor`) — or pass --no-review");
    }
  }

  const artifactDir = join(stateDir, new Date().toISOString().replace(/[:.]/g, "-"));
  mkdirSync(artifactDir, { recursive: true });

  const { results } = await runGates(task, {
    worktree: cwd, baseRef: mergeBase,
    result: { ok: true, summary: "standalone verify — no worker claims to trust", deviations: [], raw: "" },
    author, commands, baseline, channels, ...(judgeChannels ? { judgeChannels } : {}), adapters, cfg,
    pipeline: "v185", artifactDir,
    onGate: (e) => {
      if (e.phase === "start") console.error(`verify: → ${e.gate} (${e.index}/${e.total})`);
      else console.error(`verify: ${e.result.pass ? "✓" : "✗"} ${e.result.gate} — ${e.result.details.split("\n")[0] ?? ""}`);
    },
  });

  const green = results.length > 0 && results.every((r) => r.pass || r.meta?.skipped === true);
  if (values.json) {
    return { out: JSON.stringify({ base: baseTip, head, mergeBase, green, results }, null, 2), code: green ? 0 : 2 };
  }
  const lines = results.map((r: GateResult) =>
    `${r.pass ? "PASS" : "FAIL"} ${r.gate}\n${r.details.split("\n").map((l) => `  ${l}`).join("\n")}`);
  const verdict = green
    ? `verify GREEN — ${results.length} gate(s) passed on ${mergeBase.slice(0, 12)}..${head.slice(0, 12)} (merge is a human decision)`
    : `verify RED — first failure decides; artifacts in ${artifactDir}`;
  return { out: [...lines, "", verdict].join("\n"), code: green ? 0 : 2 };
}
