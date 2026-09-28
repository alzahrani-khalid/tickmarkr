import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, realpathSync, statSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { writeDoctor } from "../../src/adapters/registry.js";
import { verify } from "../../src/cli/commands/verify.js";
import { DEFAULT_CONFIG, DEFAULT_EVIDENCE_QUOTA_BYTES, loadConfig } from "../../src/config/config.js";
import { beginGateEvidence, compareToBaseline } from "../../src/gates/baseline.js";
import { runGates } from "../../src/gates/run-gates.js";
import { validateGraph } from "../../src/graph/schema.js";
import { verifyIntegrationTipCached } from "../../src/run/daemon.js";
import { gitHead } from "../../src/run/git.js";
import { Journal } from "../../src/run/journal.js";
import { GateEvidenceReceiptSchema, type EvidenceArtifact, type GateEvidenceReceipt } from "../../src/run/protocol.js";
import { EVICTION_TOMBSTONE_LIMIT, EVICTION_TOMBSTONES_FILE, resolveReceipt, resolveReceiptRedaction } from "../../src/run/receipt-resolver.js";
import { COMMIT, makeRepo, makeTestTempDir, T } from "../helpers/tmprepo.js";

const sha = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");
/** What a restarted reader sees: the receipt as the journal serialised it, resolved from disk alone. */
const afterRestart = (r: GateEvidenceReceipt, root: string) => {
  const reread = JSON.parse(JSON.stringify(r)) as GateEvidenceReceipt;
  return [resolveReceipt(reread.stdout, root), resolveReceipt(reread.stderr, root)].map(x => x.ok ? "available" : x.reason);
};
const retainedBytes = (root: string) => {
  try { return readdirSync(join(root, "gate-evidence")).reduce((n, f) => n + statSync(join(root, "gate-evidence", f)).size, 0); }
  catch { return 0; }
};

afterEach(() => { vi.restoreAllMocks(); });

test("production receipt resolution exposes HOME/TMPDIR substitutions as nonmaterial versus token assignment secret-environment redactions as material using one count per original span, so double counting or secret metadata fails", async () => {
  const artifactDir = realpathSync(makeTestTempDir("evidence-redaction-"));
  const home = "/Users/receipt-home-fixture", tmp = "/private/var/receipt-tmp-fixture/T/";
  const token = "ghp_Abcdefghijklmnopqrstuvwxyz123456789";
  const secret = `${home}/.credentials-value`; // a secret that CONTAINS the benign HOME value: one span, secret wins
  const env = { ...process.env, HOME: home, TMPDIR: tmp, SERVICE_TOKEN: token, RECEIPT_SECRET: secret };
  const run = async (text: string, runEnv: NodeJS.ProcessEnv = env) => {
    const repo = makeRepo({ "out.txt": text });
    const [row] = await compareToBaseline(repo, { build: "cat out.txt" }, { commands: {} }, ["build"], { evidence: { artifactDir, env: runEnv } });
    const receipt = GateEvidenceReceiptSchema.parse(row!.evidenceReceipt);
    return { receipt, bytes: readFileSync(join(artifactDir, receipt.stdout.path), "utf8") };
  };

  const benign = await run(`cache at ${home}/.cache and scratch at ${tmp}build.log`);
  expect(benign.bytes).toBe("cache at $HOME/.cache and scratch at $TMPDIRbuild.log");
  expect(resolveReceiptRedaction(benign.receipt)).toEqual({ material: false, counts: { token: 0, assignment: 0, secretEnv: 0, benignEnv: 2 } });
  expect(afterRestart(benign.receipt, artifactDir)).toEqual(["available", "available"]);

  // The token is also an environment value and the assignment's value is the secret: each span counts once.
  const material = await run(`auth ${token} api_key=${secret} again ${secret} home ${home}/x`);
  expect(material.bytes).toBe("auth [REDACTED] [REDACTED] again [REDACTED] home $HOME/x");
  expect(resolveReceiptRedaction(material.receipt)).toEqual({ material: true, counts: { token: 1, assignment: 1, secretEnv: 1, benignEnv: 1 } });
  // Precedence binds overlapping spans, not match order: an assignment whose value is a token counts as
  // the token, a benign TMPDIR overlapping a secret's tail is the secret, and a short HOME still substitutes.
  // C-14: the gate runs in a login shell with this env. bash stays silent when ~/.bash_profile is missing but
  // prints any other open error, so an unreadable real HOME (/root on Linux CI) put "/root" on stderr as a
  // second count. A short HOME that does not exist is silent on every host.
  const shortHome = "/nx/home";
  const overlap = await run(`token=${token} /tmp/prefix-secret ${shortHome}/.cache`,
    { ...process.env, HOME: shortHome, TMPDIR: "/tmp/prefix", SERVICE_SECRET: "prefix-secret" });
  expect(overlap.bytes).toBe("[REDACTED] [REDACTED] $HOME/.cache");
  expect(resolveReceiptRedaction(overlap.receipt)).toEqual({ material: true, counts: { token: 1, assignment: 0, secretEnv: 1, benignEnv: 1 } });
  // An identical span (a secret whose value IS the HOME value) is the secret: withheld, never $HOME.
  const identical = await run(`cwd ${shortHome} and ${shortHome}/.cache`, { ...process.env, HOME: shortHome, SERVICE_SECRET: shortHome });
  expect(identical.bytes).toBe("cwd [REDACTED] and [REDACTED]/.cache");
  expect(resolveReceiptRedaction(identical.receipt)).toEqual({ material: true, counts: { token: 0, assignment: 0, secretEnv: 2, benignEnv: 0 } });
  // A longer secret starting inside a shorter one is one span, withheld whole: no tail leaks.
  const tail = await run("abcd1234efgh", { ...process.env, HOME: home, TMPDIR: tmp, A_SECRET: "abcd1234", B_SECRET: "cd1234efgh" });
  expect(tail.bytes).toBe("[REDACTED]");
  expect(resolveReceiptRedaction(tail.receipt)).toEqual({ material: true, counts: { token: 0, assignment: 0, secretEnv: 1, benignEnv: 0 } });
  // C-11 (D-673): nested or identical HOME/TMPDIR values are one benign location named by the containing value,
  // never a secret; only a partial overlap of two different benign values is ambiguous and withheld.
  const nested = await run("/Users/u/tmp/x and /Users/u/y", { ...process.env, HOME: "/Users/u", TMPDIR: "/Users/u/tmp" });
  expect(nested.bytes).toBe("$TMPDIR/x and $HOME/y");
  expect(resolveReceiptRedaction(nested.receipt)).toEqual({ material: false, counts: { token: 0, assignment: 0, secretEnv: 0, benignEnv: 2 } });
  const same = await run("/tmp/f", { ...process.env, HOME: "/tmp", TMPDIR: "/tmp" });
  expect(same.bytes).toMatch(/^\$(HOME|TMPDIR)\/f$/);
  expect(resolveReceiptRedaction(same.receipt)).toEqual({ material: false, counts: { token: 0, assignment: 0, secretEnv: 0, benignEnv: 1 } });
  // Metadata is counts only: no value the classifier saw is recorded anywhere in the receipt.
  const serialised = JSON.stringify(material.receipt);
  for (const value of [token, secret, home, tmp]) expect(serialised).not.toContain(value);

  // A receipt whose counts contradict its material bit is not trusted as nonmaterial.
  const forged = { ...material.receipt, redaction: { material: false, counts: { token: 1, assignment: 0, secretEnv: 0, benignEnv: 0 } } };
  expect(GateEvidenceReceiptSchema.safeParse(forged).success).toBe(false);
  expect(resolveReceiptRedaction(forged)).toEqual({ material: true, counts: null });
});

test("production task standalone tip gates resolve quota evictions as expired after restart for zero tiny default eight-MiB quotas versus unexplained deletion as missing, so a caller ignoring the configured quota fails", async () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  const line = "x".repeat(63); // echo adds the newline: 64 bytes per stdout artifact
  const commands = { build: `echo ${line}`, test: `echo ${line}`, lint: `echo ${line}` };
  const tiny = 100; // holds one 64-byte invocation, so each later one evicts the one before
  // Fill a run root to exactly the default quota with 512 old 16-KiB artifacts: the first new byte evicts the oldest.
  const seedDefault = (root: string): EvidenceArtifact => {
    mkdirSync(join(root, "gate-evidence"), { recursive: true });
    let oldest!: EvidenceArtifact;
    for (let i = 0; i < DEFAULT_EVIDENCE_QUOTA_BYTES / 16384; i++) {
      const path = `gate-evidence/seed-${String(i).padStart(3, "0")}-stdout.log`, bytes = Buffer.alloc(16384, i % 251);
      writeFileSync(join(root, path), bytes);
      utimesSync(join(root, path), 1_000 + i, 1_000 + i);
      if (i === 0) oldest = { path, availability: "available", sha256: sha(bytes), retainedBytes: bytes.length, droppedBytes: 0, truncated: false };
    }
    return oldest;
  };
  const repoFor = (quota: number | undefined) => {
    const repo = makeRepo({ "a.txt": "a\n", ".gitignore": ".tickmarkr/\n" });
    mkdirSync(join(repo, ".tickmarkr"), { recursive: true });
    writeFileSync(join(repo, ".tickmarkr", "config.yaml"),
      `gates:\n  build: "${commands.build}"\n  test: "${commands.test}"\n  lint: "${commands.lint}"\n${quota === undefined ? "" : `  evidenceQuotaBytes: ${quota}\n`}`);
    return repo;
  };
  // The receipts each production path minted, in execution order, and the root they resolve under.
  const paths = {
    async task(quota: number | undefined) {
      const repo = repoFor(quota), cfg = loadConfig(repo);
      expect(cfg.gates.evidenceQuotaBytes).toBe(quota ?? DEFAULT_EVIDENCE_QUOTA_BYTES);
      const root = realpathSync(makeTestTempDir("evidence-task-"));
      const seed = quota === undefined ? seedDefault(root) : undefined;
      const task = { ...validateGraph({ version: 1, spec: { source: "native", paths: ["s"], hash: "h" }, tasks: [T("T1")] }).tasks[0]!, gates: ["build" as const, "lint" as const] };
      const { results } = await runGates(task, {
        worktree: repo, baseRef: await gitHead(repo), commands: { build: commands.build, lint: commands.lint },
        baseline: { commands: { build: { exitCode: 0, fingerprints: [] }, lint: { exitCode: 0, fingerprints: [] } } },
        author: { adapter: "fake", model: "fake-1", channel: "sub", tier: "frontier" },
        result: { ok: true, summary: "", deviations: [], raw: "" }, channels: [], adapters: [], cfg,
        artifactDir: root, stateDir: makeTestTempDir("evidence-task-state-"),
      });
      expect(results.map(r => r.pass)).toEqual([true, true]);
      return { root, receipts: results.map(r => r.evidenceReceipt!), seed };
    },
    async standalone(quota: number | undefined) {
      const repo = repoFor(quota);
      writeDoctor(repo, { fake: { installed: false, authed: false, models: [] } });
      execSync("git checkout -q -b feature", { cwd: repo });
      writeFileSync(join(repo, "a.txt"), "b\n");
      execSync(`${COMMIT} change`, { cwd: repo });
      const out = await verify(["--no-review", "--json"], repo);
      expect(out.code, out.out).toBe(0);
      const parsed = JSON.parse(out.out) as { artifactPath: string; results: { gate: string; evidenceReceipt?: GateEvidenceReceipt }[] };
      const receipts = parsed.results.filter(r => r.evidenceReceipt).map(r => r.evidenceReceipt!);
      expect(receipts).toHaveLength(3);
      return { root: realpathSync(dirname(parsed.artifactPath)), receipts, seed: undefined };
    },
    async tip(quota: number | undefined) {
      const repo = repoFor(quota), cfg = loadConfig(repo);
      const journal = Journal.create(repo, `run-evidence-${quota ?? "default"}`);
      const tipCommands = { build: commands.build, lint: commands.lint };
      journal.append("run-start", undefined, { commands: tipCommands });
      const root = realpathSync(journal.dir);
      const seed = quota === undefined ? seedDefault(root) : undefined;
      // The daemon's own call shape: the configured quota rides beside the battery.
      expect(await verifyIntegrationTipCached(repo, tipCommands, journal, { evidence: { quotaBytes: cfg.gates.evidenceQuotaBytes } })).toBe(false);
      const receipts = journal.read().filter(e => e.event === "tip-verify").map(e => (e.data as { evidenceReceipt: GateEvidenceReceipt }).evidenceReceipt);
      expect(receipts).toHaveLength(2);
      return { root, receipts, seed };
    },
  };

  for (const [name, execute] of Object.entries(paths)) {
    // Zero quota: nothing is retained, every artifact is expired at birth, and no gate changes verdict.
    const zero = await execute(0);
    for (const r of zero.receipts) expect(afterRestart(r, zero.root), name).toEqual(["expired", "expired"]);
    expect(retainedBytes(zero.root), name).toBe(0);

    // Tiny quota: only the newest stdout survives; every earlier one was evicted and is tombstoned as
    // expired (row order is not execution order, so the survivor is counted rather than assumed).
    const small = await execute(tiny);
    const states = small.receipts.map(r => afterRestart(r, small.root));
    expect(states.filter(s => s[0] === "available"), name).toEqual([["available", "available"]]);
    expect(states.filter(s => s[0] !== "available"), name).toEqual(Array(small.receipts.length - 1).fill(["expired", "available"]));
    const last = small.receipts[states.findIndex(s => s[0] === "available")]!;
    expect(retainedBytes(small.root), name).toBeLessThanOrEqual(tiny);
    // An unexplained deletion is missing, never expired.
    unlinkSync(join(small.root, last.stdout.path));
    expect(afterRestart(last, small.root), name).toEqual(["missing", "available"]);

    // Default eight MiB: fresh receipts stay available; a full root evicts its oldest artifact as expired.
    const standard = await execute(undefined);
    for (const r of standard.receipts) expect(afterRestart(r, standard.root), name).toEqual(["available", "available"]);
    if (standard.seed) {
      expect(resolveReceipt(standard.seed, standard.root), name).toEqual({ ok: false, path: standard.seed.path, reason: "expired" });
      expect(resolveReceipt({ ...standard.seed, path: "gate-evidence/seed-001-stdout.log" }, standard.root), name).toMatchObject({ ok: false, reason: "hash-mismatch" });
      expect(retainedBytes(standard.root), name).toBeLessThanOrEqual(DEFAULT_EVIDENCE_QUOTA_BYTES);
    }
    unlinkSync(join(standard.root, standard.receipts[0]!.stdout.path));
    expect(afterRestart(standard.receipts[0]!, standard.root), name).toEqual(["missing", "available"]);

    // Resuming that populated root at zero quota evicts what it already retains, tombstoned as expired.
    const survivor = standard.receipts[1]!;
    beginGateEvidence(standard.root, "build", "true", { artifactDir: standard.root, quotaBytes: 0, subjectCommit: "resume" }).finish("resumed output\n");
    expect(retainedBytes(standard.root), name).toBe(0);
    expect(afterRestart(survivor, standard.root), name).toEqual(["expired", "available"]);
  }
  expect(DEFAULT_CONFIG.gates.evidenceQuotaBytes).toBe(8 * 1024 * 1024);
}, 180_000);

test("production receipt resolution retains legacy material metadata and the newest 256 identity-bound tombstones after 257 evictions versus rejecting a stale tombstone for a replacement artifact, so unbounded retention or false expiry fails", () => {
  const cwd = makeTestTempDir("evidence-tombstones-cwd-");
  const mint = (root: string, text: string, nonce?: string) =>
    beginGateEvidence(cwd, "build", "true", { artifactDir: root, quotaBytes: 64, subjectCommit: "subject" }, nonce).finish(text);

  // Legacy receipts carry `material` alone: it is kept exactly as recorded, never recounted or cleared.
  const root = realpathSync(makeTestTempDir("evidence-tombstones-"));
  const receipts = Array.from({ length: 258 }, (_, i) => mint(root, `invocation ${String(i).padStart(3, "0")}`.padEnd(64, ".")));
  for (const material of [true, false]) {
    const legacy = { ...receipts[0]!, redaction: { material } };
    expect(GateEvidenceReceiptSchema.safeParse(legacy).success).toBe(true);
    expect(resolveReceiptRedaction(legacy)).toEqual({ material, counts: null });
  }

  // 257 evictions, 256 tombstones: the oldest eviction is no longer explained and reads missing.
  const tombstones = JSON.parse(readFileSync(join(root, EVICTION_TOMBSTONES_FILE), "utf8")) as { path: string }[];
  expect(tombstones).toHaveLength(EVICTION_TOMBSTONE_LIMIT);
  expect(tombstones.map(t => t.path)).toEqual(receipts.slice(1, 257).map(r => r.stdout.path));
  expect(afterRestart(receipts[0]!, root)).toEqual(["missing", "available"]);
  for (const r of receipts.slice(1, 257)) expect(afterRestart(r, root)).toEqual(["expired", "available"]);
  expect(afterRestart(receipts[257]!, root)).toEqual(["available", "available"]);

  // A replacement artifact at an evicted path does not inherit that path's tombstone.
  const reused = realpathSync(makeTestTempDir("evidence-replacement-"));
  const original = mint(reused, "original bytes".padEnd(64, "."), "fixed-nonce");
  mint(reused, "evicts the original".padEnd(64, "."));
  const replacement = mint(reused, "replacement bytes".padEnd(64, "."), "fixed-nonce");
  expect(replacement.stdout.path).toBe(original.stdout.path);
  unlinkSync(join(reused, replacement.stdout.path));
  expect(afterRestart(original, reused)).toEqual(["expired", "available"]);
  expect(afterRestart(replacement, reused)).toEqual(["missing", "available"]);
});
