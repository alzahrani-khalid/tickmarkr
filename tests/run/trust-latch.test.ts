import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { KIMI_TRUST_DIALOG } from "../../src/adapters/kimi.js";
import {
  KIMI_TRUST_PANE, type InteractiveSeed, type TrustDialog, type WorkerAdapter,
} from "../../src/adapters/types.js";
import { DeliveryReadinessError } from "../../src/drivers/herdr.js";
import { SubprocessDriver } from "../../src/drivers/subprocess.js";
import type { ExecutorDriver } from "../../src/drivers/types.js";
import { runDaemon } from "../../src/run/daemon.js";
import { Journal } from "../../src/run/journal.js";
import { setupRepo, T } from "../helpers/tmprepo.js";

// v1.89 T19 / OBS-406. T1 owns WHICH declaration may be answered; this file owns WHEN and HOW OFTEN.
// The unit under test is therefore a whole `runDaemon` lifecycle — launch, pre-readiness seed, seed
// injection, the run loop's own trust check, and the tail — with every keypress the driver ever
// receives counted. A matcher called directly proves nothing here: the defect was never in the
// matcher, it was in a per-slot latch that started `false` after the seed had already pressed Enter.

const SEED: InteractiveSeed = {
  launch: (model: string) => `launch-tui --model ${model}`,
  readinessMatch: "TUI ready",
  seedLine: (promptFile: string) => `Read ${promptFile} and do exactly what it says.`,
};

const READY_PANE = "banner\nTUI ready\n> ";
// The pane the worker sits on AFTER the seed lands: still carrying the recorded modal's bytes, the
// way a folder-trust prompt lingers behind a second dialog. This is the pane that must NOT be keyed.
const LINGERING_PANE = `${KIMI_TRUST_PANE}\nworking on the task`;
const AUTO_CLEAR_MS = 300;

// `clearOn: "key"` — the recorded kimi ordering: nothing reaches the readiness banner until the modal
// is answered. `clearOn: "time"` — the same modal-then-banner ordering for an adapter that declares no
// dialog: the banner arrives on its own, so the lifecycle runs to completion and the run loop is
// genuinely entered rather than short-circuited by a failed seed.
// `keyThrows` — the ORACLE round 7 asked for: the send records the key and then rejects, leaving the
// modal up. A rejection is not evidence the keystroke was not delivered, so this is the shape that
// turns "answered" into a question; the answer must be one key either way.
function makeModalSeedDriver(
  promptFile: string,
  opts: { clearOn: "key" | "time"; keyThrows?: boolean; seedLineThrows?: boolean },
) {
  const keys: string[] = [];
  const keyedSlots: string[] = [];
  const runs: string[] = [];
  const seedCmd = SEED.seedLine(promptFile);
  const inner = new SubprocessDriver();
  let pane = "";
  let phase: "pre" | "modal" | "ready" | "seeded" | "done" = "pre";
  let modalSince = 0;
  let nonce = "";
  let blockedSlices = 0;
  // Review round 8 (material): "the run loop ran" must be proven by something ONLY the run loop
  // does. Counting pane reads did not — `runInteractiveSeed` reads the pane itself to verify the
  // seed left the input box, so a regression that seeded and then never entered the loop scored the
  // same. `status()` is called nowhere in the seed path, so a recorded status observation IS the
  // loop, and the reads collected after the first one are the loop's own trust-check phase.
  const statuses: string[] = [];
  const readsAfterStatus: string[] = [];

  const settle = () => {
    if (phase === "modal" && opts.clearOn === "time" && Date.now() - modalSince >= AUTO_CLEAR_MS) {
      phase = "ready";
      pane = READY_PANE;
    }
  };

  const driver: ExecutorDriver = {
    id: "modal-seed-spy",
    interactive: true,
    slot: async (cwd, name) => ({ id: "p1", name, cwd }),
    run: async (_s, cmd) => {
      runs.push(cmd);
      if (cmd.startsWith("launch-tui ")) {
        phase = "modal";
        modalSince = Date.now();
        pane = KIMI_TRUST_PANE;
      } else if (cmd === seedCmd) {
        // Round 8 (material): the delivery the daemon makes AFTER the trust key, and the one that
        // leaves runInteractiveSeed by throwing rather than returning. Everything the seed learned
        // about the answer is lost with the result the daemon never receives.
        if (opts.seedLineThrows) throw new DeliveryReadinessError(1_234, pane);
        nonce = /TICKMARKR_RESULT_([0-9a-z]+)/i.exec(readFileSync(promptFile, "utf8"))?.[1] ?? "";
        phase = "seeded";
        pane = LINGERING_PANE;
      }
    },
    waitOutput: async (_s, pattern, ms, o) => {
      const end = Date.now() + ms;
      for (;;) {
        settle();
        if (o?.regex ? new RegExp(pattern).test(pane) : pane.includes(pattern)) return true;
        if (Date.now() >= end) return false;
        await new Promise((r) => setTimeout(r, Math.min(20, Math.max(1, end - Date.now()))));
      }
    },
    waitAgentStatus: async () => true,
    read: async (_s, lines) => {
      settle();
      const text = pane.split("\n").slice(-lines).join("\n");
      if (statuses.length > 0) readsAfterStatus.push(text);
      return text;
    },
    status: async () => {
      settle();
      const observe = (st: string) => { statuses.push(st); return st; };
      if (phase === "modal") return observe("blocked");
      if (phase !== "seeded") return observe("working");
      // Give the run loop a couple of blocked slices on the lingering pane, then let the worker
      // finish so the lifecycle reaches its tail instead of only its stall window.
      if (++blockedSlices > 2) {
        phase = "done";
        pane = `working\nTICKMARKR_RESULT_${nonce} {"ok":true,"summary":"seeded past the modal","deviations":[]}\n`;
      }
      return observe("blocked");
    },
    sendKey: async (s, key) => {
      keys.push(key);
      keyedSlots.push(s.name);
      // Dispatched, THEN the transport fails — the keystroke may already be in the slot. The modal
      // is deliberately left standing so a caller that reads the rejection as "no key was sent"
      // matches the same fingerprint on its next poll and presses Enter a second time.
      if (opts.keyThrows) throw new Error("pane send-keys: transport closed after dispatch");
      if (phase === "modal") {
        phase = "ready";
        pane = READY_PANE;
      }
    },
    notify: async () => {},
    close: async () => {},
    worktree: inner.worktree.bind(inner),
  };

  // `blockedTrustChecks` is the load-bearing observable: pane texts the DAEMON LOOP read back after
  // it had already observed a blocked worker, that still carry the modal's fingerprint. Each one is
  // a slice in which the loop held its latch instead of pressing Enter — and the bytes are the
  // driver's own return value, not a constant this file wrote.
  return {
    driver, keys, keyedSlots, runs, seedCmd, statuses,
    blockedTrustChecks: () =>
      statuses.includes("blocked")
        ? readsAfterStatus.filter((text) => text.includes(KIMI_TRUST_DIALOG.fingerprint))
        : [],
  };
}

async function runSeedLifecycle(
  runId: string, trustDialog: TrustDialog, clearOn: "key" | "time",
  fail: { keyThrows?: boolean; seedLineThrows?: boolean } = {},
) {
  const { repo, fake } = setupRepo(
    [T("T1")],
    {
      tasks: { T1: [{ shell: "true", result: { ok: true, summary: "seeded past the modal" } }] },
      // The seeded worker never runs the fake shell, so gates fail on evidence and the consult parks
      // T1 for a human — the run ends cleanly and the whole lifecycle, tail included, is counted.
      consult: { action: "human", notes: "operator must unblock" },
    },
    "visibility:\n  worker: interactive\ntaskTimeoutMinutes: 0.05\n",
  );
  const promptFile = `${repo}/.tickmarkr/runs/${runId}/prompts/T1-a0.md`;
  const seeded = fake as unknown as { interactiveSeed: InteractiveSeed; trustDialog: TrustDialog };
  seeded.interactiveSeed = SEED;
  seeded.trustDialog = trustDialog;

  const spy = makeModalSeedDriver(promptFile, { clearOn, ...fail });
  const summary = await runDaemon(repo, { adapters: [fake as WorkerAdapter], runId, driver: spy.driver });
  return { ...spy, repo, summary, promptFile };
}

test("exactly ONE key is sent to a slot across a full daemon lifecycle, proven by the seed carrying its answer out to the daemon per-slot latch and a later blocked pane still containing the same fingerprint receiving no second key, because a latch initialized false after the seed answers approves whatever modal is showing next", async () => {
  const run = await runSeedLifecycle("run-trust-latch-one", KIMI_TRUST_DIALOG, "key");

  // The modal was answered in the launch window — the seed line only exists because it was.
  expect(run.runs).toContain(run.seedCmd);
  expect(run.keys).toEqual([KIMI_TRUST_DIALOG.key]);
  expect(run.keyedSlots).toHaveLength(1);
  expect(new Set(run.keyedSlots).size).toBe(1);

  // ...and the daemon RUN LOOP then held its per-slot latch against a blocked pane that STILL
  // carries the same fingerprint. Both halves are required: a blocked status the seed path never
  // asks for, and reads after it whose own bytes match. Without the carry-out this is the second
  // Enter, landing on whatever is showing.
  expect(run.statuses).toContain("blocked");
  expect(run.blockedTrustChecks().length).toBeGreaterThan(0);
  expect(run.keys).toHaveLength(1);

  // The answer is on the record where it happened, so a live run can be audited for it.
  const answers = Journal.open(run.repo, "run-trust-latch-one").read()
    .filter((e) => e.event === "trust-auto-answer");
  expect(answers).toHaveLength(1);
  expect(answers[0]?.data.phase).toBe("seed");

  // SECOND ARM — the send REJECTS after dispatching, with the modal left standing. Round 7
  // (material): a latch spent only on a resolved send is a latch a failed transport reopens, and
  // the retry is a second Enter inside a single launch — the count is one whether or not the first
  // one landed. The seed then honestly fails closed on readiness instead of hammering the pane.
  const ambiguous = await runSeedLifecycle(
    "run-trust-latch-throw", KIMI_TRUST_DIALOG, "key", { keyThrows: true },
  );
  expect(ambiguous.keys).toEqual([KIMI_TRUST_DIALOG.key]);
  expect(ambiguous.keyedSlots).toHaveLength(1);
  expect(ambiguous.runs).not.toContain(ambiguous.seedCmd); // readiness never came: no seed injected
  // ...and the ambiguity is carried out as ANSWERED, so no later half of the lifecycle re-presses it.
  expect(Journal.open(ambiguous.repo, "run-trust-latch-throw").read()
    .filter((e) => e.event === "trust-auto-answer").map((e) => e.data.phase)).toEqual(["seed"]);

  // THIRD ARM — round 8 (material): the launch does not only END by returning. The trust key lands,
  // then the seed-line delivery throws DeliveryReadinessError and the daemon leaves the attempt
  // through its catch, with no seed result to read a latch out of. A latch initialized from the
  // RETURN VALUE is therefore never initialized on this path and the answer is never journaled — an
  // audit trail that reports zero keys on a slot that took one. One key per launch, one record per
  // key, on the path that never returns.
  const thrown = await runSeedLifecycle(
    "run-trust-latch-seedthrow", KIMI_TRUST_DIALOG, "key", { seedLineThrows: true },
  );
  const thrownAnswers = Journal.open(thrown.repo, "run-trust-latch-seedthrow").read()
    .filter((e) => e.event === "trust-auto-answer");
  expect(thrown.keys.length).toBeGreaterThan(0);
  expect(thrown.keys).toEqual(thrown.keys.map(() => KIMI_TRUST_DIALOG.key));
  // Every launch answered once and recorded once — counted per launch, since the escalation ladder
  // relaunches on a fresh slot and each fresh slot legitimately meets the folder prompt again.
  expect(thrownAnswers.map((e) => e.data.phase)).toEqual(thrown.keys.map(() => "seed"));
}, 90_000);

test("an adapter declaring no dialog receives no key at any point in the lifecycle, exercised through the production seed path and the run loop rather than a matcher called directly", async () => {
  const noDialog: TrustDialog = { kind: "none", reason: "this adapter renders no workspace-trust prompt" };
  // Same recorded pane, same driver, same daemon — only the declaration differs. The banner arrives
  // without a key, so the seed SUCCEEDS and the run loop is entered on a blocked, fingerprint-bearing
  // pane: both halves of the lifecycle get the chance to press Enter, and neither may take it.
  const run = await runSeedLifecycle("run-trust-latch-none", noDialog, "time", {});

  expect(run.runs).toContain(run.seedCmd); // the production seed path ran end to end
  // ...and so did the run loop: it observed a blocked worker and read back panes still carrying the
  // recorded fingerprint — the exact slices in which a declaring adapter WOULD have been keyed.
  expect(run.statuses).toContain("blocked");
  expect(run.blockedTrustChecks().length).toBeGreaterThan(0);
  expect(run.keys).toEqual([]);
  expect(run.keyedSlots).toEqual([]);
  expect(Journal.open(run.repo, "run-trust-latch-none").read()
    .some((e) => e.event === "trust-auto-answer")).toBe(false);
}, 60_000);
