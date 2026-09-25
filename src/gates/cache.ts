import { createHash } from "node:crypto";
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { tmpdir } from "node:os";
import type { Baseline } from "./baseline.js";
import type { GateResult } from "./types.js";
import { checkoutIncarnation, describeCapacity, inventoryDependencyLinks, type RunCapacity, resolvedCapacity, shGit, type VerificationProtocol, verificationProtocol } from "../run/git.js";
import { shq } from "../adapters/types.js";

export const DEFAULT_VERDICT_CACHE_BOUND = 128;
let testCacheBound: number | undefined;

export function setVerdictCacheBoundForTests(bound: number | undefined): void {
  testCacheBound = bound;
}

export function resetVerdictCacheBoundForTests(): void {
  testCacheBound = undefined;
  globalStoreSequence = 0;
}

export const LOCKFILES = [
  "package-lock.json",
  "npm-shrinkwrap.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "bun.lock",
  "bun.lockb",
] as const;

export function lockfileHash(worktree: string): string {
  const hash = createHash("sha256");
  let found = false;
  for (const file of LOCKFILES) {
    const p = join(worktree, file);
    if (existsSync(p)) {
      found = true;
      try {
        hash.update(file).update("\0").update(readFileSync(p)).update("\0");
      } catch {
        hash.update(file).update("\0unreadable\0");
      }
    }
  }
  return found ? hash.digest("hex").slice(0, 16) : "no-lockfile";
}

export function canonicalJson(obj: unknown): string {
  if (obj === null || typeof obj !== "object") return JSON.stringify(obj);
  if (Array.isArray(obj)) return "[" + obj.map(canonicalJson).join(",") + "]";
  const keys = Object.keys(obj as Record<string, unknown>).sort();
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + canonicalJson((obj as Record<string, unknown>)[k])).join(",") + "}";
}

export function baselineIdentity(baseline?: Baseline): string {
  if (!baseline) return "none";
  // Measurements control execution budgets, not which failures the baseline forgives.
  const commands = Object.fromEntries(Object.entries(baseline.commands).map(([gate, entry]) => {
    const {
      durationMs: _duration, fileDurationSumMs: _sum, impliedParallelism: _parallelism,
      longestFile: _longest, fileDurations: _files, ceilingMs: _ceiling, ...evidence
    } = entry;
    return [gate, evidence];
  }));
  return createHash("sha256").update(canonicalJson(commands)).digest("hex").slice(0, 16);
}

// The tree the command actually ran against: HEAD plus every tracked change and ordinary untracked
// path (a fixture that flips an uncommitted package.json changes the verdict). Built through a
// disposable index, as preserveWorktree does, so the checkout's real index is never touched.
export async function getWorktreeTree(worktree: string): Promise<string> {
  const scratch = mkdtempSync(join(tmpdir(), "tickmarkr-verdict-index-"));
  const withIndex = (cmd: string) => `GIT_INDEX_FILE=${shq(join(scratch, "index"))} ${cmd}`;
  try {
    const read = await shGit(withIndex("git read-tree HEAD"), worktree);
    if (read.code !== 0) return "";
    const add = await shGit(withIndex("git add -A -- ."), worktree);
    if (add.code !== 0) return "";
    const tree = await shGit(withIndex("git write-tree"), worktree);
    return tree.code === 0 ? tree.stdout.trim() : "";
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

export interface GateEnvironmentInput {
  nodeRuntime?: string;
  lockfile?: string;
  worktree?: string;
  capacity?: RunCapacity;
  selectedSet?: readonly string[];
  scope?: VerificationScope;
  /** R41: the verification protocol + runner lifecycle policy; defaults to this process's. */
  verification?: VerificationProtocol;
}

export interface EnvironmentParts {
  nodeRuntime: string;
  lockfile: string;
  capacity: RunCapacity;
  selectedSet?: readonly string[];
  verification: VerificationProtocol;
}

export function environmentFingerprint(env: GateEnvironmentInput): { fingerprint: string; parts: EnvironmentParts } {
  const nodeRuntime = env.nodeRuntime ?? process.version;
  const lockfile = env.lockfile ?? (env.worktree ? lockfileHash(env.worktree) : "no-lockfile");
  const cap = env.capacity ?? resolvedCapacity();
  const capacity: RunCapacity = { forkCap: cap.forkCap, cores: cap.cores };
  const selectedSet = env.selectedSet ? [...env.selectedSet].sort() : undefined;
  const verification = env.verification ?? verificationProtocol(process.env, env.worktree ?? process.cwd());
  // Admitted links still affect resolution. Normalize against the classified root so relocating
  // an otherwise identical checkout (including its dependency store) preserves the identity.
  const resolution = env.worktree ? inventoryDependencyLinks(env.worktree).map(({ link, target, classification }) => ({
    link,
    classification,
    target: classification === "outside" ? target : relative(realpathSync(
      classification === "worktree" ? env.worktree! : join(env.worktree!, "node_modules"),
    ), target),
  })).sort((a, b) => a.link < b.link ? -1 : a.link > b.link ? 1 : 0) : [];

  // R41: the protocol and the EFFECTIVE lifecycle are IN the hashed payload, so every entry written
  // before this stamp — green or red — keys differently and is never answered; no store surgery is
  // needed. `source` is provenance (kept in parts, printed on the row) and never enters the key: an
  // explicit `false` and an npmrc `false` are the same policy for the child that ran.
  const payload = canonicalJson({
    nodeRuntime,
    lockfile,
    capacity,
    resolution,
    selectedSet: selectedSet ?? null,
    scope: env.scope ?? "battery",
    verification: { protocol: verification.protocol, lifecycle: verification.lifecycle },
  });
  const fingerprint = createHash("sha256").update(payload).digest("hex").slice(0, 16);
  return {
    fingerprint,
    parts: { nodeRuntime, lockfile, capacity, selectedSet, verification },
  };
}

export type VerificationScope = "battery" | "tip" | "standalone";

export interface VerificationIdentity {
  /** the gate the verdict answers — build/lint/test may share one command and are still three verdicts */
  gate?: string;
  /** which verifier produced it: a battery gate row or an integration-tip row (own report, own forgiveness rule) */
  scope?: VerificationScope;
  /** Checkout location is diagnostic metadata; build outputs additionally require an incarnation. */
  worktree?: string;
  tree: string;
  /** Build success also promises local outputs, which die with the checkout. */
  checkoutIncarnation?: string;
  command: string;
  baseline: string;
  environment: string;
  envParts?: EnvironmentParts;
}

export async function computeVerificationIdentity(params: {
  worktree: string;
  gate: string;
  scope?: VerificationScope;
  command: string;
  baseline?: Baseline;
  selectedSet?: readonly string[];
  capacity?: RunCapacity;
  tree?: string;
  lockfile?: string;
  nodeRuntime?: string;
  verification?: VerificationProtocol;
}): Promise<VerificationIdentity | undefined> {
  const tree = params.tree ?? (await getWorktreeTree(params.worktree));
  if (!tree) return undefined;
  const incarnation = params.gate === "build" ? checkoutIncarnation(params.worktree) : undefined;
  if (params.gate === "build" && !incarnation) return undefined;
  const baseline = baselineIdentity(params.baseline);
  const env = environmentFingerprint({
    worktree: params.worktree,
    selectedSet: params.selectedSet,
    capacity: params.capacity,
    lockfile: params.lockfile,
    nodeRuntime: params.nodeRuntime,
    scope: params.scope,
    verification: params.verification,
  });

  return {
    gate: params.gate,
    scope: params.scope ?? "battery",
    worktree: realpathSync(params.worktree),
    tree,
    ...(incarnation ? { checkoutIncarnation: incarnation } : {}),
    command: params.command,
    baseline,
    environment: env.fingerprint,
    envParts: env.parts,
  };
}

export function verificationIdentityKey(id: VerificationIdentity): string {
  const cmdHash = createHash("sha256").update(id.command).digest("hex").slice(0, 16);
  const gate = id.gate ?? "gate";
  // Lint/test remain content-addressed. Builds also promise outputs in this physical checkout.
  // Scope continues to separate each verifier's evidence policy.
  const workingTree = createHash("sha256").update(id.tree)
    .update(id.gate === "build" ? `\0checkout:${id.checkoutIncarnation ?? "unbound"}` : "").digest("hex");
  return `${id.scope ?? "battery"}-${gate}-${workingTree}-${cmdHash}-${id.baseline}-${id.environment}`;
}

export function formatReusedDetails(originalDetails: string, id: VerificationIdentity): string {
  const unadorned = originalDetails.replace(/^reused verdict \(identity: [^)]+\):\s*/, "");
  const envDesc = id.envParts
    ? ` [node=${id.envParts.nodeRuntime}, lockfile=${id.envParts.lockfile}, capacity=${describeCapacity(id.envParts.capacity)}${id.envParts.selectedSet ? `, selected=${id.envParts.selectedSet.join(",")}` : ""}, protocol=${id.envParts.verification.protocol}, lifecycle=${id.envParts.verification.lifecycle} (${id.envParts.verification.source})]`
    : "";
  const gate = id.gate ?? "gate";
  const prefix = `reused ${id.scope === "tip" ? "tip " : ""}verdict (identity: gate=${gate} tree=${id.tree}${id.worktree ? ` worktree=${id.worktree}` : ""} command=${id.command} baseline=${id.baseline} env=${id.environment}${envDesc})`;
  return `${prefix}: ${unadorned}`;
}

declare module "./types.js" {
  interface GateResult {
    originRunRoot?: string;
  }
}

export interface CachedVerdict {
  evidenceReceipt?: GateResult["evidenceReceipt"];
  evidenceReceipts?: GateResult["evidenceReceipts"];
  originRunRoot?: string;
  gate: string;
  pass: boolean;
  details: string;
  exitCode?: number;
  meta?: Record<string, unknown>;
  capacity?: RunCapacity;
}

// A reused GREEN names the reuse in its details. A reused RED keeps the fresh verdict's details
// byte-for-byte: the daemon's fingerprint cap (identicalGateFailures) compares normalized details
// across attempts, so a red whose details carried a reuse note would never read as the identical
// failure it is and would buy a free retry — the reuse is named on the row's meta and on the
// gate-reused-verdict note run-gates emits beside it, which the daemon journals as its own row.
export function formatReusedRow(cached: CachedVerdict, id: VerificationIdentity): GateResult {
  const reusedDetails = formatReusedDetails(cached.details, id);
  return {
    gate: id.gate ?? cached.gate,
    pass: cached.pass,
    details: cached.pass ? reusedDetails : cached.details,
    capacity: cached.capacity,
    ...(cached.evidenceReceipt ? { evidenceReceipt: cached.evidenceReceipt } : {}),
    ...(cached.evidenceReceipts ? { evidenceReceipts: cached.evidenceReceipts } : {}),
    ...(cached.originRunRoot ? { originRunRoot: cached.originRunRoot } : {}),
    meta: {
      ...cached.meta,
      reused: true,
      reusedDetails,
      verificationIdentity: reusedIdentity(id),
    },
  };
}

export function reusedIdentity(id: VerificationIdentity): Record<string, unknown> {
  return {
    gate: id.gate ?? "gate",
    scope: id.scope ?? "battery",
    tree: id.tree,
    ...(id.checkoutIncarnation ? { checkoutIncarnation: id.checkoutIncarnation } : {}),
    ...(id.worktree ? { worktree: id.worktree } : {}),
    command: id.command,
    baseline: id.baseline,
    environment: id.environment,
    key: verificationIdentityKey(id),
  };
}

export function isInfraResult(result: GateResult | { meta?: Record<string, unknown>; details?: string; cause?: string; exitCode?: number }): boolean {
  if (result.meta?.infra === true) return true;
  if (result.meta?.classification === "infra") return true;
  if (result.meta?.kind === "ceiling-kill" || result.meta?.kind === "hang") return true;
  if ("cause" in result && result.cause === "infra") return true;
  if (typeof result.details === "string") {
    const d = result.details.toLowerCase();
    if (d.startsWith("infra;") || d.startsWith("infra: ") || d.includes("infrastructure blocked execution")) {
      return true;
    }
  }
  return false;
}

export function resolveStateDir(worktree: string, artifactDir?: string): string {
  if (artifactDir) {
    const idx = artifactDir.lastIndexOf("/.tickmarkr");
    if (idx !== -1) {
      return artifactDir.slice(0, idx + "/.tickmarkr".length);
    }
  }
  const idx = worktree.lastIndexOf("/.tickmarkr");
  if (idx !== -1) {
    return worktree.slice(0, idx + "/.tickmarkr".length);
  }
  if (existsSync(join(worktree, ".tickmarkr"))) {
    return join(worktree, ".tickmarkr");
  }
  try {
    const commonDir = execSync("git rev-parse --git-common-dir", { cwd: worktree, encoding: "utf8" }).trim();
    const resolved = resolve(worktree, commonDir);
    const commonRoot = realpathSync(dirname(resolved));
    if (existsSync(join(commonRoot, ".tickmarkr"))) {
      return join(commonRoot, ".tickmarkr");
    }
  } catch {
    // ignore
  }
  return join(worktree, ".tickmarkr");
}

export function resolveVerdictStoreDir(stateDir: string): string {
  mkdirSync(stateDir, { recursive: true });
  const gi = join(stateDir, ".gitignore");
  if (!existsSync(gi)) {
    try {
      writeFileSync(gi, "*\n");
    } catch {
      // ignore
    }
  }
  const dir = join(stateDir, "verdicts");
  mkdirSync(dir, { recursive: true });
  return dir;
}

export interface StoredVerdictRecord {
  key: string;
  identity: VerificationIdentity;
  verdict: CachedVerdict;
  timestamp: number;
  sequence: number;
}

let globalStoreSequence = 0;

export function resetGlobalStoreSequenceForTests(): void {
  globalStoreSequence = 0;
}


export class VerdictStore {
  readonly dir: string;

  constructor(dir: string) {
    this.dir = dir;
  }

  private initSequenceFromDisk(): void {
    if (!existsSync(this.dir)) return;
    try {
      for (const f of readdirSync(this.dir)) {
        if (f.startsWith("verdict-") && f.endsWith(".json")) {
          try {
            const raw = JSON.parse(readFileSync(join(this.dir, f), "utf8")) as StoredVerdictRecord;
            if (raw && typeof raw.sequence === "number" && raw.sequence > globalStoreSequence) {
              globalStoreSequence = raw.sequence;
            }
          } catch {
            // ignore
          }
        }
      }
    } catch {
      // ignore
    }
  }

  // R41: an identity whose lifecycle policy could not be measured is never answered and never
  // stored — an unknown policy is not comparable to anything, so the battery runs the command.
  private static unknownPolicy(id: VerificationIdentity): boolean {
    return id.envParts?.verification?.lifecycle === "unknown";
  }

  get(id?: VerificationIdentity): CachedVerdict | undefined {
    if (!id || !id.tree || VerdictStore.unknownPolicy(id)) return undefined;
    const key = verificationIdentityKey(id);
    const p = join(this.dir, `verdict-${key}.json`);
    if (existsSync(p)) {
      try {
        const raw = JSON.parse(readFileSync(p, "utf8")) as StoredVerdictRecord;
        if (raw && raw.verdict) return raw.verdict;
      } catch {
        return undefined;
      }
    }
    return undefined;
  }

  set(id: VerificationIdentity | undefined, verdict: GateResult | CachedVerdict): boolean {
    if (!id || !id.tree || VerdictStore.unknownPolicy(id)) return false;
    if (isInfraResult(verdict)) return false;

    mkdirSync(this.dir, { recursive: true });
    this.initSequenceFromDisk();
    const key = verificationIdentityKey(id);
    const bound = testCacheBound ?? DEFAULT_VERDICT_CACHE_BOUND;

    const record: StoredVerdictRecord = {
      key,
      identity: id,
      verdict: {
        gate: verdict.gate ?? id.gate ?? "gate",
        pass: verdict.pass,
        details: verdict.details,
        ...("exitCode" in verdict ? { exitCode: verdict.exitCode } : {}),
        ...(verdict.capacity ? { capacity: verdict.capacity } : {}),
        ...(verdict.meta ? { meta: verdict.meta } : {}),
        ...(verdict.evidenceReceipt ? { evidenceReceipt: verdict.evidenceReceipt } : {}),
        ...(verdict.evidenceReceipts ? { evidenceReceipts: verdict.evidenceReceipts } : {}),
        ...(verdict.originRunRoot ? { originRunRoot: verdict.originRunRoot }
          : typeof verdict.meta?.runDir === "string" ? { originRunRoot: resolve(verdict.meta.runDir) } : {}),
      },
      timestamp: Date.now(),
      sequence: ++globalStoreSequence,
    };

    const finalPath = join(this.dir, `verdict-${key}.json`);
    const tmpPath = join(this.dir, `verdict-${key}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`);

    writeFileSync(tmpPath, JSON.stringify(record, null, 2) + "\n");
    try {
      renameSync(tmpPath, finalPath);
    } finally {
      try {
        unlinkSync(tmpPath);
      } catch {
        // Already renamed, or best-effort cleanup after a failed replacement.
      }
    }

    this.evictOldest(bound);
    return true;
  }


  size(): number {
    if (!existsSync(this.dir)) return 0;
    return readdirSync(this.dir).filter((f) => f.startsWith("verdict-") && f.endsWith(".json")).length;
  }

  clear(): void {
    globalStoreSequence = 0;
    if (!existsSync(this.dir)) return;
    for (const f of readdirSync(this.dir)) {
      if (f.startsWith("verdict-")) {
        try {
          unlinkSync(join(this.dir, f));
        } catch {
          // ignore
        }
      }
    }
  }

  evictOldest(bound?: number): number {
    const limit = bound ?? testCacheBound ?? DEFAULT_VERDICT_CACHE_BOUND;
    const dir = this.dir;
    if (!existsSync(dir)) return 0;
    const files = readdirSync(dir).filter((f) => f.startsWith("verdict-") && f.endsWith(".json"));
    if (files.length <= limit) return 0;

    const entries: Array<{ file: string; sequence: number; timestamp: number }> = [];
    for (const file of files) {
      const p = join(dir, file);
      try {
        const raw = JSON.parse(readFileSync(p, "utf8")) as StoredVerdictRecord;
        entries.push({
          file,
          sequence: typeof raw.sequence === "number" ? raw.sequence : 0,
          timestamp: typeof raw.timestamp === "number" ? raw.timestamp : 0,
        });
      } catch {
        entries.push({ file, sequence: -1, timestamp: -1 });
      }
    }

    entries.sort((a, b) => {
      // Each write seeds its sequence from disk, including in a fresh process.
      // Wall-clock corrections must not make the newest write the oldest entry.
      if (a.sequence !== b.sequence) return a.sequence - b.sequence;
      return a.timestamp - b.timestamp;
    });

    let evicted = 0;
    while (entries.length > limit) {
      const oldest = entries.shift()!;
      try {
        unlinkSync(join(dir, oldest.file));
        evicted++;
      } catch {
        // ignore
      }
    }
    return evicted;
  }
}

export function getVerdictStore(stateDir: string, options?: { bound?: number }): VerdictStore {
  if (options?.bound !== undefined) {
    setVerdictCacheBoundForTests(options.bound);
  }
  return new VerdictStore(resolveVerdictStoreDir(stateDir));
}
