/** The version 1 `tickmarkr status --json` wire contract; no repository runtime imports. */
export type Gate = "unknown" | "not-run" | "disabled" | "queued" | "running" | "passed" | "failed";
export type Task = {
  id: string;
  title: string;
  deps: string[];
  state: "unknown" | "pending" | "running" | "completed" | "merged" | "failed" | "human" | "blocked";
  gates: Record<"build" | "test" | "lint" | "evidence" | "scope" | "acceptance" | "review", Gate>;
  tries: { round: number | null; budget: number; launches: number };
  seats: { worker: string | null; judge: string | null; reviewer: string | null };
  startedAt: string | null;
  endedAt: string | null;
  now: { phase: string | null; since: string | null; blocker: string | null; nextAction: string | null };
};
export type DecisionCommand = { verb: "approve" | "waive" | "uphold" | "recheck"; command: string };
export type Park = {
  taskId: string;
  kind: string | null;
  reason: string | null;
  token: string | null;
  commands: DecisionCommand[];
  noDecision: string | null;
};
export type StatusSnapshot = {
  version: 1;
  runId: string;
  sequence: number;
  observedAt: string;
  daemon: "alive" | "dead" | "unknown";
  lifecycle: "PENDING" | "RUNNING" | "PARTIAL" | "APPROVED" | "COMPLETE" | "UNKNOWN";
  verdict: {
    green: boolean;
    fatal: boolean;
    currentTip: "passed" | "not required" | "pending" | "failed" | "unknown";
    buckets: { failed: string[] | null; human: string[] | null; blocked: string[] | null; pending: string[] | null };
    outstanding: { known: true; debt: number; checks: string[] } | { known: false; reason: string };
  };
  approvalWindow: { opensAt: string; closesAt: string; parked: string[] } | null;
  tasks: Task[];
  parks: Park[];
};
export type BoardState = { snapshot: StatusSnapshot } | { error: string };

declare module "claude-code" {
  interface PluginState {
    tickmarkr: { board: BoardState };
  }
}
