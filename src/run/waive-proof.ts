import type { JournalEvent } from "./journal.js";
import { executedFullTest } from "./recovery.js";

/**
 * Row 418 (D-2187 add.84, add.100): the proof a seatless review INFRA park must carry before a
 * `--waive --gate review` may release it. Pure: it reads the journal and writes nothing.
 *
 * The parked candidate is named by the SUBJECT TOKEN its parked gate round recorded on its review row
 * (`commit` + `attempt`), never by a raw Git SHA, and every row it reads is joined on that token within
 * that attempt — a green from an earlier attempt on the same token is not this round's proof. The test
 * must be a POSITIVELY EXECUTED full suite that passed (recovery.ts `executedFullTest`: a started
 * invocation's receipt, not skipped, reused, replayed or a selected screen) with no later test row on
 * the subject that is red, skipped, infra or owed. Every other enabled gate but review must have PASSED:
 * a generic satisfied fold reads a legacy `skipped: true, pass: true` row as satisfied, so it is no proof.
 */
export type WaiveProof =
  | { ok: true; subject: string; attempt: number }
  | { ok: false; missing: string; reason: string };

const LIFECYCLE = new Set(["task-dispatch", "task-approved", "task-human"]);

type Row = Pick<JournalEvent, "event" | "taskId" | "data">;

/** Passed outright: not red, skipped, infra or owed. */
const passed = (d: Record<string, unknown>): boolean =>
  d.pass === true && d.skipped !== true && d.infra !== true && d.gateOwed === undefined && d.testOwed !== true;

const lastIndex = <T>(xs: readonly T[], f: (x: T) => boolean): number => {
  for (let i = xs.length - 1; i >= 0; i--) if (f(xs[i]!)) return i;
  return -1;
};

export function waiveProof(events: readonly Row[], taskId: string, enabledGates: readonly string[]): WaiveProof {
  const parkAt = lastIndex(events, (e) => e.taskId === taskId && e.event === "task-human");
  if (parkAt < 0 || events[parkAt]!.data.kind !== "infra") return { ok: false, missing: "park", reason: "no infra park on the task" };
  // The lifecycle boundary: an earlier park, approval or dispatch ends the rows this park can read, so an
  // earlier dispatch's review and green gates never satisfy a new dispatch's park.
  const own = events.slice(0, parkAt);
  const start = lastIndex(own, (e) => e.taskId === taskId && LIFECYCLE.has(e.event)) + 1;
  const before = own.slice(start).filter((e) => e.taskId === taskId && e.event === "gate-result");
  const review = before[lastIndex(before, (e) => e.data.gate === "review")];
  const subject = review?.data.commit;
  const attempt = review?.data.attempt;
  if (typeof subject !== "string" || subject === "" || typeof attempt !== "number") {
    return { ok: false, missing: "review", reason: "the parked review row names no subject token" };
  }
  // The subject join: this attempt, this token — nothing read across attempts or subjects.
  const rows = before.filter((e) => e.data.commit === subject && e.data.attempt === attempt).map((e) => e.data);

  // The test gate is mandatory, so it is always owed here whatever `enabledGates` says.
  const tests = rows.filter((d) => d.gate === "test");
  const green = lastIndex(tests, (d) => passed(d) && executedFullTest(d));
  if (green < 0) return { ok: false, missing: "test", reason: "no executed full test passed on the parked subject" };
  // The later-row check: a red, skipped, infra or owed test row after the green on the subject undoes it.
  if (tests.slice(green + 1).some((d) => !passed(d))) {
    return { ok: false, missing: "test", reason: "a later test row on the parked subject is red, skipped, infra or owed" };
  }
  for (const gate of enabledGates) {
    if (gate === "test" || gate === "review") continue;
    const last = rows[lastIndex(rows, (d) => d.gate === gate)];
    if (!last || !passed(last)) return { ok: false, missing: gate, reason: `${gate} did not pass on the parked subject` };
  }
  return { ok: true, subject, attempt };
}
