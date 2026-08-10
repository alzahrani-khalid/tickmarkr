import { userInfo } from "node:os";
import { GATE_NAMES } from "../../graph/schema.js";
import { ATTEMPT_CAP_RELEASE, GATE_SATISFIED_RELEASE, Journal, RECHECK_RELEASE, REVIEW_UPHELD_RELEASE } from "../../run/journal.js";
import { acquireApprovalSerialization, runLockOwner } from "../../run/lock.js";

// GATE-08 (v1.12): approve a parked human gate so the next `tickmarkr resume <runId>` dispatches it.
//
// The approval is a JOURNAL EVENT (task-approved) carrying who and when — it touches ONLY the
// append-only journal. Writing it into tickmarkr's compiled graph artifact would be silently erased by
// the next recompile (which re-emits humanGate:true from the plan frontmatter) — Phase 42 D-02.
//
// v1.24 OBS-18: when the park kind is attempt-cap (not a humanGate pre-dispatch park), the event
// also carries `release: "attempt-cap"`. replayResumeState zeros the attempt budget on that marker so
// resume dispatches instead of re-parking in the same tick; tried-list is preserved. Unknown kinds
// receive no release and remain fail-closed to a human rather than being inferred from prose.
//
// Fail-closed (D-05): unknown runId, unknown taskId, a not-parked task, and a double-approve are all
// LOUD refusals that name the reason and append NO event — never a silent no-op. A handler throw
// becomes `tickmarkr approve: <message>` at exit 1 (src/cli/index.ts dispatch).
//
// Who/when is truthful, not dressed-up auth (D-03): default actor os.userInfo().username; --by overrides
// for delegated approval; optional --reason; the event's ts (stamped by Journal.append) is the when.
// OBS-189: `--uphold` is the second decision a review park offers. Plain approve accepts the diff the
// reviewer rejected (gate-satisfied); --uphold sides WITH the reviewer and funds ONE fixed worker
// attempt carrying the findings — the park costs an attempt, never the run.
//
// T14: the runtime ACCEPTS an approval against a live daemon exactly as against a finished run —
// daemon.ts builds its approved set once at startup and never re-reads it (deliberate: replay
// determinism). So the accepted decision may be inert for that run, and until now the only disclosure
// was a "run resume" suggestion inside this string, restated nowhere afterwards. The run lock already
// records the owning pid, so the answer is available and was simply not consulted: every approval now
// closes on a DISPOSITION drawn from a two-token vocabulary printed in a JSON status line, and the
// run's completion record names every approval that never reached a dispatch. Liveness comes from
// lock.ts's runLockOwner — the same
// inspect() the acquire/unlock decision table uses, never a second `process.kill(pid, 0)` here, and
// never the lock FILE's presence (a stale lock whose recorded pid is dead is not a live run).
//
export type ApprovalStatus = "deferred-live" | "recorded-no-owner";

/** The production command registered in COMMANDS; its returned bytes are what the CLI prints. */
export async function approve(argv: string[], cwd = process.cwd()): Promise<string> {
  const { runId, taskId, by, reason, uphold, recheck, reviewRoundCeiling } = parseArgs(argv);
  if (uphold && recheck) throw new Error("--uphold and --recheck are different decisions — pass one");
  const serialization = await acquireApprovalSerialization(cwd, runId);

  try {
  // Journal.open throws `no journal for <runId> at <dir>` on an unknown run — that IS the refusal.
  const journal = Journal.open(cwd, runId);

  const status = journal.replayStatuses().get(taskId);
  if (status === undefined) {
    throw new Error(`task ${taskId} has no events in run ${runId} — unknown task or never dispatched`);
  }
  if (status !== "human") {
    // a silent no-op would be worse than a loud refusal — name the actual status (D-05)
    throw new Error(`task ${taskId} is ${status}, not a parked human gate — refusing (a silent no-op would be worse)`);
  }

  // OBS-18: only the most recent task-human for this task decides whether this approval grants a
  // fresh attempt budget. The closed daemon-issued kind, never a human prose string, controls release.
  const events = journal.read();
  let lastHumanIndex = -1;
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i]!.event === "task-human" && events[i]!.taskId === taskId) {
      lastHumanIndex = i;
      break;
    }
  }
  const lastHuman = events[lastHumanIndex];
  if (uphold) {
    // Fail-closed on the DATA: uphold applies only when the newest failed gate is the review gate —
    // any other gate has no reviewer to uphold. Never inferred from the park's prose.
    const lastFailed = events.slice(0, lastHumanIndex).reverse().find((e) =>
      e.event === "gate-result" && e.taskId === taskId && e.data.pass === false
      && typeof e.data.gate === "string" && (GATE_NAMES as readonly string[]).includes(e.data.gate),
    )?.data.gate as string | undefined;
    if (lastFailed !== "review") {
      throw new Error(`--uphold applies to a review rejection; ${taskId}'s last failed gate is ${lastFailed ?? "none"} — refusing`);
    }
    journal.append("task-approved", taskId, {
      by,
      ...(reason ? { reason } : {}),
      via: "cli",
      release: REVIEW_UPHELD_RELEASE,
      gate: "review",
      ...(reviewRoundCeiling === undefined ? {} : { reviewRoundCeiling }),
    });
    return disposition(cwd, runId, `upheld the reviewer for ${taskId} in ${runId} — by ${by}; run \`tickmarkr resume ${runId}\` to dispatch a fixed attempt carrying the findings`, serialization.contended);
  }
  const capPark = lastHuman?.data.kind === ATTEMPT_CAP_RELEASE;
  const gateFailPark = lastHuman?.data.kind === "gate-fail";
  if (recheck) {
    // OBS-203: fail-closed on the PARK KIND — only a gate-fail park has a gate to re-run. Refusing
    // elsewhere keeps --recheck from becoming a silent budget reset on a pre-dispatch human gate.
    if (!gateFailPark) {
      throw new Error(`--recheck applies to a gate-fail park; ${taskId}'s park kind is ${lastHuman?.data.kind ?? "none"} — refusing`);
    }
    journal.append("task-approved", taskId, {
      by,
      ...(reason ? { reason } : {}),
      via: "cli",
      release: RECHECK_RELEASE,
      ...(reviewRoundCeiling === undefined ? {} : { reviewRoundCeiling }),
    });
    return disposition(cwd, runId, `re-checking ${taskId} in ${runId} — by ${by}; no gate marked satisfied, run \`tickmarkr resume ${runId}\` to re-dispatch against the full gate suite`, serialization.contended);
  }
  const failedGate = gateFailPark
    ? events.slice(0, lastHumanIndex).reverse().find((e) =>
        e.event === "gate-result" && e.taskId === taskId && e.data.pass === false
        && typeof e.data.gate === "string" && (GATE_NAMES as readonly string[]).includes(e.data.gate),
      )?.data.gate as string | undefined
    : undefined;
  if (gateFailPark && !failedGate) {
    throw new Error(`task ${taskId} is parked on gate-fail but has no failed gate result — refusing to infer one`);
  }

  journal.append("task-approved", taskId, {
    by,
    ...(reason ? { reason } : {}),
    via: "cli",
    ...(reviewRoundCeiling === undefined ? {} : { reviewRoundCeiling }),
    ...(capPark ? { release: ATTEMPT_CAP_RELEASE } : {}),
    ...(failedGate ? { release: GATE_SATISFIED_RELEASE, gate: failedGate } : {}),
  });
  return disposition(cwd, runId, `approved ${taskId} in ${runId} — by ${by}; run \`tickmarkr resume ${runId}\` to ${failedGate ? "continue past the approved gate" : "dispatch it"}`, serialization.contended);
  } finally {
    serialization.release();
  }
}

// The status is command OUTPUT, not a typed sibling result: the registered approve function returns
// one primitive string and the dispatcher prints those bytes unchanged. A compact sentinel followed
// by JSON makes the contract unambiguous to machines without widening the shared command result type.
// No-lock approvals keep their historical one-line result for the cockpit; a dead recorded owner and
// a command delayed behind terminalization both emit recorded-no-owner.
function disposition(cwd: string, runId: string, message: string, contended: boolean): string {
  const owner = runLockOwner(cwd);
  const resume = `tickmarkr resume ${runId}`;
  if (!owner && !contended) return message;
  const status: ApprovalStatus = owner?.live ? "deferred-live" : "recorded-no-owner";
  const record = {
    status,
    resume,
    ...(owner?.pid === undefined ? {} : { ownerPid: owner.pid }),
    ...(owner?.runId === undefined ? {} : { ownerRunId: owner.runId }),
  };
  return `${message}\nTICKMARKR_APPROVAL ${JSON.stringify(record)}`;
}

interface ParsedArgs {
  runId: string;
  taskId: string;
  by: string;
  reason?: string;
  uphold: boolean;
  recheck: boolean;
  reviewRoundCeiling?: number;
}

const USAGE = "usage: tickmarkr approve <run-id> <task-id> [--uphold|--recheck] [--review-rounds <positive-integer>] [--by <name>] [--reason <text>]";

// hand-parsed argv — no CLI framework (house style). Positionals are runId then taskId; decision,
// ceiling, actor and reason are flags. Throws usage on missing positionals (mirrors resume.ts/unlock.ts).
function parseArgs(argv: string[]): ParsedArgs {
  const positionals: string[] = [];
  let by: string | undefined;
  let reason: string | undefined;
  let uphold = false;
  let recheck = false;
  let reviewRoundCeiling: number | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--by") {
      by = argv[++i];
      if (!by) throw new Error(USAGE);
    } else if (a === "--reason") {
      reason = argv[++i];
      if (!reason) throw new Error(USAGE);
    } else if (a === "--uphold") {
      uphold = true;
    } else if (a === "--recheck") {
      recheck = true;
    } else if (a === "--review-rounds") {
      const value = argv[++i];
      if (value === undefined) throw new Error(USAGE);
      if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value))) {
        throw new Error("--review-rounds must be a positive integer");
      }
      reviewRoundCeiling = Number(value);
    } else {
      positionals.push(a);
    }
  }
  const [runId, taskId] = positionals;
  if (!runId || !taskId) {
    throw new Error(USAGE);
  }
  return { runId, taskId, by: by ?? userInfo().username, reason, uphold, recheck, reviewRoundCeiling };
}
