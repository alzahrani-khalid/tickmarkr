import { renderMarkdownRecord } from "../../src/cli/commands/report.js";
import { approve } from "../../src/cli/commands/approve.js";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { SubprocessDriver } from "../../src/drivers/subprocess.js";
import {
  forgivenFingerprints, formatForgiven, formatSummary, formatTipProof, recordFatalRunEnd, runDaemon, runEndTipProof,
} from "../../src/run/daemon.js";
import { Journal, type JournalEvent } from "../../src/run/journal.js";
import { COMMIT, makeTestTempDir, setupRepo, T } from "../helpers/tmprepo.js";

const TIP = "a".repeat(40);
const ev = (event: string, data: Record<string, unknown> = {}): JournalEvent => ({ ts: "2026-09-22T00:00:00.000Z", event, data });
const start = (cached: boolean, gates = ["build", "test"]) => ev("tip-verify-start", { tip: TIP, cmdHash: "h", gates, cached });
const pass = (gate: string, cached = false) => ev("tip-verify", { gate, pass: true, tip: TIP, cmdHash: "h", ...(cached ? { cached: true } : {}) });
const green = [start(false), pass("build"), pass("test"), ev("run-end", { tipVerify: "passed" })];

/** One partial run (T2 parks on its human gate, so the integration worktree survives) and its journal + close notifications. */
async function partialRun(runId: string) {
  const { repo, fake } = setupRepo([T("T1"), T("T2", { humanGate: true })],
    { tasks: { T1: [{ shell: `echo one > t1.txt && ${COMMIT} t1`, result: { ok: true, summary: "t1" } }] } });
  writeFileSync(join(repo, "package.json"), JSON.stringify({ scripts: { test: "node -e \"process.exit(0)\"" } }));
  const notifies: string[] = [];
  const driver = new SubprocessDriver();
  driver.notify = async (message) => { notifies.push(message); };
  const run = (resume: boolean) => runDaemon(repo, { adapters: [fake], driver, runId, resume, approvalWindowMs: 0 });
  return { repo, notifies, run };
}

test("test: a close after an eligible cached verification records and announces reused proof naming its verified commit, so inferring reuse from an unchanged commit despite an ineligible cache key fails", async () => {
  // Same commit, but the start row declared the cache ineligible and the commands really ran: fresh, never reused.
  expect(runEndTipProof([...green, start(false), pass("build"), pass("test")])).toEqual({ kind: "fresh", tip: TIP, gates: [{ gate: "build", kind: "fresh" }, { gate: "test", kind: "fresh" }] });
  // Cached verdict rows without the cache row (or the reverse) prove neither kind.
  expect(runEndTipProof([...green, start(true), pass("build", true), pass("test", true)]).kind).toBe("incomplete");
  expect(runEndTipProof([...green, start(false), ev("tip-verify-cached", { tip: TIP }), pass("build"), pass("test")]).kind).toBe("incomplete");

  const { repo, notifies, run } = await partialRun("run-proof-reused");
  await run(false);
  const resumed = await run(true);
  const events = Journal.open(repo, "run-proof-reused").read();
  const cachedRow = events.findLast((e) => e.event === "tip-verify-cached")!;
  expect(cachedRow).toBeDefined();
  const end = events.findLast((e) => e.event === "run-end")!;
  expect(end.data.tipVerify).toBe("passed");
  expect(end.data.tipProof).toEqual({ kind: "reused", tip: cachedRow.data.tip, gates: [{ gate: "test", kind: "reused" }] });
  expect(resumed.tipProof).toEqual(end.data.tipProof);
  expect(notifies.at(-1)).toContain(`tip proof: reused — carried from verified commit ${(cachedRow.data.tip as string).slice(0, 12)}`);
}, 120_000);

test("test: a close whose latest cycle failed or was cancelled before completing records and announces failed or incomplete proof despite an earlier green cycle, so an unfinished cycle reported as reused green fails", async () => {
  const failed = runEndTipProof([...green, start(false), pass("build"), ev("tip-verify-failed", { gate: "test", tip: TIP, cmdHash: "h" })]);
  expect(failed).toEqual({ kind: "failed", tip: TIP });
  expect(formatTipProof(failed)).toContain("tip proof: failed");
  for (const unfinished of [
    [...green, start(true), ev("tip-verify-cached", { tip: TIP }), pass("build", true), ev("tip-verify-cancelled", { reason: "approval" })],
    [...green, start(false), pass("build"), ev("tip-verify-cancelled", { reason: "approval" })],
    [...green, start(false), pass("build")], // killed mid-battery
    [...green, start(true)],
  ]) {
    const proof = runEndTipProof(unfinished);
    expect(proof).toEqual({ kind: "incomplete", tip: TIP });
    expect(formatTipProof(proof)).toContain("tip proof: incomplete");
    expect(formatTipProof(proof)).not.toMatch(/reused|fresh/);
  }
  // No delimited cycle at all is not evidence of anything.
  expect(runEndTipProof([pass("build"), pass("test")])).toEqual({ kind: "incomplete" });

  // A close that never enters tip verification (nothing done) still records and announces exactly one proof.
  const { repo, fake } = setupRepo([T("T1", { humanGate: true })], {});
  const notifies: string[] = [];
  const driver = new SubprocessDriver();
  driver.notify = async (message) => { notifies.push(message); };
  const summary = await runDaemon(repo, { adapters: [fake], driver, runId: "run-proof-skipped", approvalWindowMs: 0 });
  const end = Journal.open(repo, "run-proof-skipped").read().findLast((e) => e.event === "run-end")!;
  expect(end.data.tipVerify).toBeUndefined();
  expect(end.data.tipProof).toEqual({ kind: "incomplete" });
  expect(summary.tipProof).toEqual(end.data.tipProof);
  expect(notifies.at(-1)).toContain("tip proof: incomplete");
}, 60_000);

test("test: a close after successful execution of every tip command records and announces fresh proof, so a successful fresh verification presented as reused fails", async () => {
  expect(runEndTipProof(green)).toEqual({ kind: "fresh", tip: TIP, gates: [{ gate: "build", kind: "fresh" }, { gate: "test", kind: "fresh" }] });
  expect(formatTipProof({ kind: "fresh", tip: TIP })).not.toContain("reused");

  const { repo, notifies, run } = await partialRun("run-proof-fresh");
  const summary = await run(false);
  const events = Journal.open(repo, "run-proof-fresh").read();
  const startRow = events.findLast((e) => e.event === "tip-verify-start")!;
  expect(events.some((e) => e.event === "tip-verify-cached")).toBe(false);
  const end = events.findLast((e) => e.event === "run-end")!;
  expect(end.data.tipVerify).toBe("passed"); // the legacy enum is kept beside the additive field
  expect(end.data.tipProof).toEqual({ kind: "fresh", tip: startRow.data.tip, gates: [{ gate: "test", kind: "fresh" }] });
  expect(summary.tipProof).toEqual(end.data.tipProof);
  expect(notifies.at(-1)).toContain("tip proof: fresh — every tip command ran and passed on");
  expect(notifies.at(-1)).not.toContain("reused");
}, 60_000);

/** tipTest is green wherever T1's t1.txt is absent (the baseline capture), so only the integration tip can see it red. */
function flaggedRun(runId: string, testCmd: (flag: string) => string) {
  const flag = join(makeTestTempDir("tickmarkr-flag-"), "flag");
  const { repo, fake } = setupRepo([T("T1"), T("T2", { humanGate: true })],
    { tasks: { T1: [{ shell: `echo one > t1.txt && ${COMMIT} t1`, result: { ok: true, summary: "t1" } }] } },
    `gates: { build: 'node -e ""', test: 'node -e ""', tipTest: 'test ! -e t1.txt || ${testCmd(flag)}' }\n`);
  const notifies: string[] = [];
  const driver = new SubprocessDriver();
  driver.notify = async (message) => { notifies.push(message); };
  const run = (resume: boolean) => runDaemon(repo, { adapters: [fake], driver, runId, resume, approvalWindowMs: 0 });
  return { repo, flag, notifies, run };
}

// D-131 regression 1: the whole-cycle cache is ineligible (the previous cycle was red), yet verifyIntegrationTip
// carries build forward from its persisted verdict and executes only test — never "every command ran".
test("a cycle that reuses one persisted per-gate verdict and executes the rest is recorded as reused, never fresh", async () => {
  expect(runEndTipProof([...green, start(false), pass("build", true), pass("test")])).toEqual({ kind: "reused", tip: TIP, gates: [{ gate: "build", kind: "reused" }, { gate: "test", kind: "fresh" }] });

  const { repo, flag, notifies, run } = flaggedRun("run-proof-mixed", (f) => `test -e "${f}"`);
  await run(false);
  const red = Journal.open(repo, "run-proof-mixed").read().findLast((e) => e.event === "run-end")!;
  expect(red.data.tipProof).toMatchObject({ kind: "failed" });
  writeFileSync(flag, "");
  await run(true);
  const events = Journal.open(repo, "run-proof-mixed").read();
  const cycle = events.slice(events.map((e) => e.event).lastIndexOf("tip-verify-start"));
  expect(cycle[0]!.data.cached).toBe(false);
  expect(cycle.some((e) => e.event === "tip-verify-cached")).toBe(false);
  expect(cycle.find((e) => e.event === "tip-verify" && e.data.gate === "build")!.data.cached).toBe(true);
  expect(cycle.find((e) => e.event === "tip-verify" && e.data.gate === "test")!.data.cached).toBeUndefined();
  expect(events.findLast((e) => e.event === "run-end")!.data.tipProof).toMatchObject({ kind: "reused" });
  expect(notifies.at(-1)).toContain("tip proof: reused");
}, 120_000);

// D-131 regression 2: the verifier subprocess dies after tip-verify-start; the fatal close still names one proof.
test("a fatal close after tip-verify-start records and announces incomplete proof despite an earlier green cycle", async () => {
  // Pure: the fatal engagement's unfinished cycle inherits nothing from the engagement before it.
  const { repo: scratch } = setupRepo([T("T1")], {});
  const journal = Journal.create(scratch, "run-proof-fatal-pure");
  for (const e of [ev("run-start"), ...green, ev("run-resume"), start(false), pass("build")]) journal.append(e.event, undefined, e.data);
  expect(recordFatalRunEnd(journal, "run-proof-fatal-pure", "b", new Error("boom"))).toEqual({ kind: "incomplete", tip: TIP });
  expect(journal.read().at(-1)!.data).toMatchObject({ fatal: true, tipProof: { kind: "incomplete", tip: TIP } });

  // Daemon: at the tip the command kills its own verifier subprocess (and only that — never an in-process caller).
  const { repo, notifies, run } = flaggedRun("run-proof-fatal", () => `{ ps -o command= -p $PPID | grep -q input-type=module && kill -9 $PPID; exit 1; }`);
  await expect(run(false)).rejects.toThrow();
  const events = Journal.open(repo, "run-proof-fatal").read();
  const end = events.findLast((e) => e.event === "run-end")!;
  const startRow = events.findLast((e) => e.event === "tip-verify-start")!;
  expect(end.data.fatal).toBe(true);
  expect(end.data.tipProof).toEqual({ kind: "incomplete", tip: startRow.data.tip });
  expect(notifies.at(-1)).toContain("run crashed — tip proof: incomplete");
}, 120_000);

const mixedCycle = [start(false, ["build", "test", "lint"]), pass("build", true), pass("test"), pass("lint", true)];
const recordOf = (cycle: JournalEvent[]) => renderMarkdownRecord("run-gate-proof", [
  ev("run-start"), ...cycle, ev("run-end", { tipVerify: "passed", done: [], failed: [] }),
]).split("\n").find(line => line.startsWith("- **verification:**"))!;

test("test: a tip cycle whose test ran fresh over reused build and lint verdicts records a per gate proof naming each gate's own kind whereas an all fresh cycle names every gate fresh, so one reused kind for the whole cycle fails", () => {
  const mixed = runEndTipProof(mixedCycle);
  expect(mixed).toEqual({ kind: "reused", tip: TIP, gates: [
    { gate: "build", kind: "reused" }, { gate: "test", kind: "fresh" }, { gate: "lint", kind: "reused" },
  ] });
  expect(formatTipProof(mixed)).toContain("test: verified fresh");
  expect(formatTipProof(mixed)).toContain("build: cached (reused) — carried");
  const fresh = runEndTipProof([start(false, ["build", "test", "lint"]), pass("build"), pass("test"), pass("lint")]);
  expect(fresh.kind).toBe("fresh");
  expect(fresh.gates).toEqual(["build", "test", "lint"].map(gate => ({ gate, kind: "fresh" })));
  for (const gate of ["build", "test", "lint"]) expect(formatTipProof(fresh)).toContain(`${gate}: verified fresh`);
});

test("test: the markdown record of that run names the test as verified fresh and lists build and lint as carried, so a header reading cached not re-run over a freshly tested tip fails", () => {
  const header = recordOf(mixedCycle);
  expect(header).toContain("verification:** passed — tip proof: reused");
  expect(header).toContain("test: verified fresh");
  for (const gate of ["build", "lint"]) expect(header).toContain(`${gate}: cached (reused) — carried, not re-run`);
  // An open resume cannot replace the closed cycle's proof.
  const events = [ev("run-start"), ...mixedCycle, ev("run-end", { tipVerify: "passed" }), start(true)];
  expect(renderMarkdownRecord("run-gate-proof", events)).toContain(header);
});

test("test: a whole cycle carried from a verified tip still reads cached for every gate and a failed cycle reads failed, so a per gate proof that upgrades a carried gate to fresh fails", () => {
  const carried = [start(true, ["build", "test", "lint"]), ev("tip-verify-cached", { tip: TIP }),
    ...["build", "test", "lint"].map(gate => pass(gate, true))];
  const proof = runEndTipProof(carried);
  expect(proof.kind).toBe("reused");
  expect(proof.gates).toEqual(["build", "test", "lint"].map(gate => ({ gate, kind: "reused" })));
  const header = recordOf(carried);
  for (const gate of ["build", "test", "lint"]) {
    expect(header).toContain(`${gate}: cached (reused) — carried`);
    expect(formatTipProof(proof)).toContain(`${gate}: cached (reused) — carried`);
  }
  expect(header).not.toContain("verified fresh");
  const failed = [...carried, start(false), pass("build", true), ev("tip-verify-failed", { gate: "test", tip: TIP })];
  expect(runEndTipProof(failed).kind).toBe("failed");
  expect(formatTipProof(runEndTipProof(failed))).toContain("tip proof: failed");
  expect(recordOf(failed)).toContain("FAILED");
});

// OBS-1123: a red baseline the build keeps printing, plus a second red only where the work created new.txt.
const KNOWN_RED = "FAIL tests/known.test.ts > pre-existing red";
const NEW_RED = "FAIL tests/new.test.ts > introduced by this run";
const RED_BUILD = `printf '%s\\n' '${KNOWN_RED}'; if [ -f new.txt ]; then printf '%s\\n' '${NEW_RED}'; fi; exit 1`;
const RED_BUILD_CFG = `gates: { build: ${JSON.stringify(RED_BUILD)} }\n`;
const ISO_TIME = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;
const UNKNOWN = "baseline provenance unknown (legacy: no capture identity or time recorded)";

const runEnd = (repo: string, runId: string) => Journal.open(repo, runId).read().findLast((e) => e.event === "run-end")!;
const capturedProvenance = (repo: string, runId: string) => {
  const baseline = JSON.parse(readFileSync(join(Journal.open(repo, runId).dir, "baseline.json"), "utf8"));
  const p = baseline.provenance as { baseRef: string; capturedAt: string };
  return { baseline, provenance: p, dated: `baseline ${p.baseRef.slice(0, 12)} captured ${p.capturedAt}` };
};

test("test: production run-end and markdown records attribute each forgiven task or tip fingerprint to its baseline time versus legacy unknown provenance, so a bare label or invented date fails", async () => {
  const runId = "run-forgiven-provenance";
  const { repo, fake } = setupRepo([T("T1"), T("T2", { humanGate: true })], { tasks: {
    T1: [{ shell: `echo one > t1.txt && ${COMMIT} t1`, result: { ok: true, summary: "t1" } }],
    T2: [{ shell: `echo two > t2.txt && ${COMMIT} t2`, result: { ok: true, summary: "t2" } }],
  } }, RED_BUILD_CFG);
  const run = (resume: boolean) => runDaemon(repo, { adapters: [fake], runId, resume, approvalWindowMs: 0 });

  const first = await run(false);
  const { baseline, provenance, dated } = capturedProvenance(repo, runId);
  const events = Journal.open(repo, runId).read();
  // The capture's own identity and publication time, stamped beside the measurement.
  expect(provenance.baseRef).toBe(events.find((e) => e.event === "run-start")!.data.baseRef);
  expect(provenance.capturedAt).toMatch(ISO_TIME);
  expect(Date.parse(provenance.capturedAt)).toBeGreaterThanOrEqual(Date.parse(events.find((e) => e.event === "baseline-start")!.ts));
  expect(first.done).toEqual(["T1"]);
  expect(runEnd(repo, runId).data.forgiven).toEqual([
    { taskId: "T1", gate: "build", fingerprints: [KNOWN_RED], baseline: provenance },
    { gate: "build", fingerprints: [KNOWN_RED], baseline: provenance },
  ]);
  expect(first.forgiven).toEqual(runEnd(repo, runId).data.forgiven);
  const text = formatSummary(first);
  expect(text).toContain(`forgiven vs baseline — T1 build: ${KNOWN_RED} — ${dated}`);
  expect(text).toContain(`forgiven vs baseline — tip build: ${KNOWN_RED} — ${dated}`);
  const md = renderMarkdownRecord(runId, events);
  expect(md).toContain(`- **forgiven vs baseline:**\n  - T1 build: ${KNOWN_RED} — ${dated}\n  - tip build: ${KNOWN_RED} — ${dated}\n`);
  expect(md).toContain(`(forgiven); forgiven vs baseline: ${KNOWN_RED} — ${dated}`);

  // A baseline.json written before provenance existed: T2's gates and the tip forgive against it on resume.
  const { provenance: _dropped, ...legacy } = baseline;
  writeFileSync(join(Journal.open(repo, runId).dir, "baseline.json"), JSON.stringify(legacy));
  await approve([runId, "T2", "--by", "test"], repo);
  const second = await run(true);
  expect(second.done.sort()).toEqual(["T1", "T2"]);
  expect(runEnd(repo, runId).data.forgiven).toEqual([
    { taskId: "T1", gate: "build", fingerprints: [KNOWN_RED], baseline: provenance }, // its row keeps its capture
    { taskId: "T2", gate: "build", fingerprints: [KNOWN_RED] },
    { gate: "build", fingerprints: [KNOWN_RED] },
  ]);
  const later = Journal.open(repo, runId).read();
  const records = [
    formatSummary(second).split("\n").filter((l) => l.startsWith("forgiven vs baseline — ")),
    renderMarkdownRecord(runId, later).split("\n").filter((l) => /^ {2}- (T\d|tip) build: /.test(l)),
  ];
  for (const lines of records) {
    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain(`T1 build: ${KNOWN_RED} — ${dated}`);
    for (const line of lines.slice(1)) {
      expect(line).toMatch(/(T2|tip) build: /);
      expect(line).toContain(`${KNOWN_RED} — ${UNKNOWN}`);
      expect(line).not.toMatch(ISO_TIME); // never a date borrowed from the row, the run or the resume
    }
  }

  // A row from before structured forgiveness is still named forgiven, with nothing it never recorded.
  const legacyRow = { ts: "2026-09-22T00:00:00.000Z", event: "gate-result", taskId: "T0",
    data: { gate: "lint", pass: true, details: "exit 1 but only pre-existing failures (forgiven)" } };
  expect(forgivenFingerprints([legacyRow])).toEqual([{ taskId: "T0", gate: "lint" }]);
  expect(formatForgiven(forgivenFingerprints([legacyRow])[0]!)).toBe(`T0 lint: fingerprints not recorded — ${UNKNOWN}`);
  expect(renderMarkdownRecord("run-legacy", [legacyRow])).toContain(`(forgiven); forgiven vs baseline: fingerprints not recorded — ${UNKNOWN}`);

  // A fatal close keeps what the greens before it carried: the verifier dies at the tip after T1's forgiven build.
  const fatalId = "run-forgiven-fatal";
  const killTip = "test ! -e t1.txt || { ps -o command= -p $PPID | grep -q input-type=module && kill -9 $PPID; exit 1; }";
  const crash = setupRepo([T("T1"), T("T2", { humanGate: true })],
    { tasks: { T1: [{ shell: `echo one > t1.txt && ${COMMIT} t1`, result: { ok: true, summary: "t1" } }] } },
    `gates: { build: ${JSON.stringify(RED_BUILD)}, test: 'node -e ""', tipTest: ${JSON.stringify(killTip)} }\n`);
  await expect(runDaemon(crash.repo, { adapters: [crash.fake], runId: fatalId, approvalWindowMs: 0 })).rejects.toThrow();
  const crashed = Journal.open(crash.repo, fatalId).read();
  const fatalEnd = crashed.findLast((e) => e.event === "run-end")!;
  const fatalCapture = capturedProvenance(crash.repo, fatalId);
  expect(fatalEnd.data.fatal).toBe(true);
  const fatalForgiven = fatalEnd.data.forgiven as ReturnType<typeof forgivenFingerprints>;
  expect(fatalForgiven).toEqual(forgivenFingerprints(crashed.slice(0, crashed.lastIndexOf(fatalEnd))));
  expect(fatalForgiven[0]).toEqual({ taskId: "T1", gate: "build", fingerprints: [KNOWN_RED], baseline: fatalCapture.provenance });
  const fatalMd = renderMarkdownRecord(fatalId, crashed);
  for (const f of fatalForgiven) expect(fatalMd).toContain(`  - ${formatForgiven(f)}\n`);
  expect(fatalMd).toContain(`  - T1 build: ${KNOWN_RED} — ${fatalCapture.dated}\n`);
}, 240_000);

test("test: production reports distinguish a baseline-forgiven fingerprint from a newly introduced red on the same task, so displaying the new regression as forgiven fails", async () => {
  const runId = "run-forgiven-vs-new";
  const { repo, fake } = setupRepo([T("T1")], { tasks: { T1: [
    { shell: `echo new > new.txt && ${COMMIT} regress`, result: { ok: true, summary: "introduces a red" } },
    { shell: `rm -f new.txt && echo fixed > fixed.txt && ${COMMIT} fix`, result: { ok: true, summary: "removes it" } },
  ] } }, RED_BUILD_CFG);
  const summary = await runDaemon(repo, { adapters: [fake], runId, approvalWindowMs: 0 });
  const { provenance, dated } = capturedProvenance(repo, runId);
  const events = Journal.open(repo, runId).read();
  const builds = events.filter((e) => e.event === "gate-result" && e.taskId === "T1" && e.data.gate === "build");
  const red = builds.find((e) => e.data.pass === false)!;
  expect(red.data).toMatchObject({ freshFingerprints: [NEW_RED], forgivenFingerprints: [KNOWN_RED], baselineProvenance: provenance });
  expect(builds.at(-1)!.data).toMatchObject({ pass: true, forgivenFingerprints: [KNOWN_RED], baselineProvenance: provenance });
  expect(builds.at(-1)!.data.freshFingerprints).toBeUndefined();

  const md = renderMarkdownRecord(runId, events);
  const redLine = md.split("\n").find((l) => l.startsWith("  - build: fail"))!;
  expect(redLine).toContain(`; new red (not in baseline): ${NEW_RED}; forgiven vs baseline: ${KNOWN_RED} — ${dated}`);
  expect(redLine.slice(redLine.indexOf("forgiven vs baseline:"))).not.toContain(NEW_RED);
  const greenLine = md.split("\n").findLast((l) => l.startsWith("  - build: pass"))!;
  expect(greenLine).toContain(`forgiven vs baseline: ${KNOWN_RED} — ${dated}`);
  expect(greenLine).not.toContain(NEW_RED);

  // The standing record names what the green carried — the baseline's red, never the one the work introduced.
  expect(summary.done).toEqual(["T1"]);
  const forgiven = [
    { taskId: "T1", gate: "build", fingerprints: [KNOWN_RED], baseline: provenance },
    { gate: "build", fingerprints: [KNOWN_RED], baseline: provenance },
  ];
  expect(runEnd(repo, runId).data.forgiven).toEqual(forgiven);
  expect(summary.forgiven).toEqual(forgiven);
  expect(formatSummary(summary)).toContain(`forgiven vs baseline — T1 build: ${KNOWN_RED} — ${dated}`);
  expect(formatSummary(summary)).not.toContain(NEW_RED);
  const header = md.slice(md.indexOf("- **forgiven vs baseline:**"), md.indexOf("## Usage & efficiency"));
  expect(header).toContain(`  - T1 build: ${KNOWN_RED} — ${dated}`);
  expect(header).not.toContain(NEW_RED);
}, 180_000);
