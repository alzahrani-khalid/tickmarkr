import { userInfo } from "node:os";
import { ATTEMPT_CAP_RELEASE, Journal } from "../../run/journal.js";

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
export async function approve(argv: string[], cwd = process.cwd()): Promise<string> {
  const { runId, taskId, by, reason } = parseArgs(argv);

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
  const lastHuman = journal.read().filter((e) => e.event === "task-human" && e.taskId === taskId).at(-1);
  const capPark = lastHuman?.data.kind === ATTEMPT_CAP_RELEASE;

  journal.append("task-approved", taskId, {
    by,
    ...(reason ? { reason } : {}),
    via: "cli",
    ...(capPark ? { release: ATTEMPT_CAP_RELEASE } : {}),
  });
  return `approved ${taskId} in ${runId} — by ${by}; run \`tickmarkr resume ${runId}\` to dispatch it`;
}

interface ParsedArgs {
  runId: string;
  taskId: string;
  by: string;
  reason?: string;
}

// hand-parsed argv — no CLI framework (house style). Flags --by <name> and --reason <text>; positionals
// are runId then taskId. Throws usage on missing positionals (mirrors resume.ts/unlock.ts).
function parseArgs(argv: string[]): ParsedArgs {
  const positionals: string[] = [];
  let by: string | undefined;
  let reason: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--by") {
      by = argv[++i];
      if (!by) throw new Error("usage: tickmarkr approve <run-id> <task-id> [--by <name>] [--reason <text>]");
    } else if (a === "--reason") {
      reason = argv[++i];
      if (!reason) throw new Error("usage: tickmarkr approve <run-id> <task-id> [--by <name>] [--reason <text>]");
    } else {
      positionals.push(a);
    }
  }
  const [runId, taskId] = positionals;
  if (!runId || !taskId) {
    throw new Error("usage: tickmarkr approve <run-id> <task-id> [--by <name>] [--reason <text>]");
  }
  return { runId, taskId, by: by ?? userInfo().username, reason };
}
