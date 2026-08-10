import { expect, test } from "vitest";
import { GATE_NAMES, type GateName } from "../../src/graph/schema.js";
import {
  ROLE_INVOCATION_ROLES,
  foldPairIntegrity,
  trackJournalRows,
  type JournalSourceRow,
  type RoleInvocationRole,
  type TrackedJournalRow,
} from "../../src/run/protocol.js";

const ts = (index: number) => `2026-08-09T10:00:${String(index).padStart(2, "0")}.000Z`;

const tracked = (runId: string, raws: unknown[], firstIndex = 0): TrackedJournalRow[] =>
  trackJournalRows(runId, raws.map((raw, offset): JournalSourceRow => ({
    sourceIndex: firstIndex + offset,
    raw,
  })));

// Deliberately top-level and titled verbatim: acceptance selects the full Vitest-visible name.
test("pair-integrity fold ranges over gate phases and worker, judge, review and consult invocations keyed by run, task, attempt and role, where one start plus one terminal closes, one start stays open, and duplicate or terminal-without-start rows fail closed, so event-name counting without structural identity fails", () => {
  let clock = 0;
  const gateRows: unknown[] = [];
  for (const gate of GATE_NAMES) {
    const taskId = `T-${gate}`;
    gateRows.push(
      { ts: ts(clock++), event: "gate-phase-start", taskId, data: { attempt: 0, gate } },
      { ts: ts(clock++), event: "gate-result", taskId, data: { attempt: 0, gate, outcome: { kind: "passed" } } },
    );
  }

  const roleStart = (taskId: string, attempt: number, role: RoleInvocationRole) => ({
    ts: ts(clock++), event: "role-invocation-start", taskId, data: { attempt, role },
  });
  const roleTerminal = (taskId: string, attempt: number, role: RoleInvocationRole) => ({
    ts: ts(clock++), event: "role-invocation-terminal", taskId,
    data: { attempt, role, outcome: "completed", reason: "the invocation returned" },
  });

  const runA = [
    ...gateRows,
    // Closed worker control.
    roleStart("T-worker", 0, "worker"),
    roleTerminal("T-worker", 0, "worker"),
    // A start is observable as open, not fabricated into success.
    roleStart("T-judge", 0, "judge"),
    // A second terminal for the same structural identity poisons the pair.
    roleStart("T-review", 0, "review"),
    roleTerminal("T-review", 0, "review"),
    roleTerminal("T-review", 0, "review"),
    // A later start cannot retroactively legalize a terminal that arrived without one.
    roleTerminal("T-consult", 0, "consult"),
    roleStart("T-consult", 0, "consult"),
    // Attempt is also identity: these two rows deliberately do not close one another.
    roleStart("T-attempt", 1, "worker"),
    roleTerminal("T-attempt", 2, "worker"),
  ];
  const runB = [
    // Same task, attempt and role as run A: run identity keeps both valid rather than duplicate.
    roleStart("T-worker", 0, "worker"),
    roleTerminal("T-worker", 0, "worker"),
  ];

  const rows = [
    ...tracked("run-a", runA),
    ...tracked("run-b", runB, runA.length),
  ];
  expect(rows.every((row) => row.kind === "decision")).toBe(true);

  const folded = foldPairIntegrity(rows);
  const pair = (runId: string, taskId: string, attempt: number, role: string) =>
    folded.pairs.find((candidate) => candidate.identity.runId === runId
      && candidate.identity.taskId === taskId
      && candidate.identity.attempt === attempt
      && candidate.identity.role === role)!;

  for (const gate of GATE_NAMES) {
    expect(pair("run-a", `T-${gate}`, 0, `gate:${gate}`).state, gate).toBe("closed");
  }
  expect(pair("run-a", "T-worker", 0, "worker").state).toBe("closed");
  expect(pair("run-b", "T-worker", 0, "worker").state).toBe("closed");
  expect(pair("run-a", "T-judge", 0, "judge").state).toBe("open");
  expect(pair("run-a", "T-review", 0, "review").state).toBe("invalid");
  expect(pair("run-a", "T-consult", 0, "consult").state).toBe("invalid");
  expect(pair("run-a", "T-attempt", 1, "worker").state).toBe("open");
  expect(pair("run-a", "T-attempt", 2, "worker").state).toBe("invalid");

  expect(new Set(folded.pairs
    .map(({ identity }) => identity.role)
    .filter((role): role is RoleInvocationRole => (ROLE_INVOCATION_ROLES as readonly string[]).includes(role))))
    .toEqual(new Set(ROLE_INVOCATION_ROLES));
  expect(new Set(folded.pairs
    .map(({ identity }) => identity.role)
    .filter((role): role is `gate:${GateName}` => role.startsWith("gate:"))))
    .toEqual(new Set(GATE_NAMES.map((gate) => `gate:${gate}`)));
  expect(folded.issues.map(({ kind }) => kind).sort()).toEqual([
    "duplicate-terminal",
    "terminal-without-start",
    "terminal-without-start",
  ]);
});
