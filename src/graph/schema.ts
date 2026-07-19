import { z } from "zod";

export const SHAPES = ["plan", "spec", "implement", "tests", "docs", "migration", "ui", "refactor", "chore"] as const;
// v1.51 T2: spec-declared routing mode. Mirrors config ROUTING_MODES literally — config.ts imports this
// module, so a runtime import back would be circular; parity is pinned by test (tests/cli/mode-sources).
export const GRAPH_ROUTING_MODES = ["partner-led", "risk-based", "staff-led"] as const;
export const STATUSES = ["pending", "running", "gated", "failed", "done", "human"] as const;
export const GATE_NAMES = ["build", "test", "lint", "evidence", "scope", "acceptance", "review"] as const;
const MANDATORY_GATES = ["build", "test", "lint", "evidence", "scope"] as const;
export const TIERS = ["cheap", "mid", "frontier"] as const;
// v1.19 acceptance oracles: command (exit code), test (named test), judge (LLM, free-text rubric).
// A plain string is the read-old/write-new compat form — semantically a judge oracle (spec §2).
export const ORACLES = ["command", "test", "judge"] as const;

export type Shape = (typeof SHAPES)[number];
export type TaskStatus = (typeof STATUSES)[number];
export type GateName = (typeof GATE_NAMES)[number];
export type Oracle = (typeof ORACLES)[number];

// Typed acceptance oracle: command carries the thing to run, test the test name, judge free text.
// Anything else (a typed object naming an unknown oracle) fails validation loudly here.
export const AcceptanceItemSchema = z.union([
  z.string().min(1),
  z.object({ oracle: z.literal("command"), command: z.string().min(1) }),
  z.object({ oracle: z.literal("test"), test: z.string().min(1) }),
  z.object({ oracle: z.literal("judge"), text: z.string().min(1) }),
]);
export type AcceptanceItem = z.infer<typeof AcceptanceItemSchema>;

// Shared text rendering of one acceptance item — every consumer (worker prompt, acceptance gate,
// review gate) renders typed items as text through THIS helper. Rendering only; oracle execution is T2.
export function renderAcceptanceItem(item: AcceptanceItem): string {
  if (typeof item === "string") return item;
  if (item.oracle === "command") return `$ ${item.command}`;
  if (item.oracle === "test") return `test: ${item.test}`;
  return item.text; // judge — bare text, byte-identical to a plain-string judge criterion
}

export const TaskSchema = z.object({
  // ids land in git branch names and herdr pane names — branch-safe characters only, bounded
  // length (refs hit filesystem limits), and never "--" (the task-branch separator, locked
  // decision 10) or a trailing dash. T1-style from prd/speckit; P07-01-style from gsd (v1.3).
  id: z
    .string()
    .max(64)
    .regex(/^[A-Za-z][A-Za-z0-9_-]*$/, "task ids look like T1 or P07-01 (letter start; letters/digits/-/_)")
    .refine((id) => !id.includes("--") && !id.endsWith("-"), 'task ids may not contain "--" or end with "-"'),
  title: z.string().min(1),
  goal: z.string().min(1),
  shape: z.enum(SHAPES),
  complexity: z.number().int().min(1).max(10),
  deps: z.array(z.string()).default([]),
  files: z.array(z.string()).default([]),
  context: z.array(z.string()).default([]),
  acceptance: z.array(AcceptanceItemSchema).min(1, "acceptance[] is required and must be non-empty"),
  // v1.19: purely advisory plan-time blast radius — NO gate reads this (the run-time scope gate stays
  // authoritative fail-closed). Optional + best-effort: paths required, confidence/reason may be absent.
  scopeHints: z
    .array(
      z.object({
        paths: z.array(z.string()),
        confidence: z.number().min(0).max(1).optional(),
        reason: z.string().optional(),
      }),
    )
    .optional(),
  gates: z
    .array(z.enum(GATE_NAMES))
    .default(["build", "test", "lint", "evidence", "scope", "acceptance", "review"])
    .superRefine((gates, ctx) => {
      for (const gate of MANDATORY_GATES) {
        if (!gates.includes(gate)) {
          ctx.addIssue({
            code: "custom",
            message: `${gate} is a mandatory fail-closed gate invariant and cannot be omitted from task gates`,
          });
        }
      }
    }),
  routingHints: z
    .object({
      pin: z.object({ via: z.string(), model: z.string() }).optional(),
      floor: z.enum(TIERS).optional(),
      source: z.string().optional(),
      escalate: z.boolean().optional(),
    })
    .optional(),
  humanGate: z.boolean().default(false),
  // v1.39 OBS-37b: per-task worker window override; absent ⇒ config taskTimeoutMinutes.
  timeoutMinutes: z.number().positive().optional(),
  status: z.enum(STATUSES).default("pending"),
  evidence: z
    .object({
      commits: z.array(z.string()).default([]),
      artifacts: z.array(z.string()).default([]),
      gateResults: z.array(z.unknown()).default([]),
    })
    .default({ commits: [], artifacts: [], gateResults: [] }),
});

export const RunGraphSchema = z
  .object({
    version: z.literal(1),
    // v1.51 T2: spec front-matter mode — the spec author's routing-mode declaration. Source
    // precedence: run flag > this > repo config > global config > default (risk-based).
    mode: z.enum(GRAPH_ROUTING_MODES).optional(),
    spec: z.object({
      source: z.enum(["speckit", "gsd", "prd", "native", "taskmaster"]),
      paths: z.array(z.string()),
      hash: z.string(),
    }),
    tasks: z.array(TaskSchema).min(1),
  })
  .superRefine((g, ctx) => {
    const ids = new Set<string>();
    for (const t of g.tasks) {
      if (ids.has(t.id)) ctx.addIssue({ code: "custom", message: `duplicate task id ${t.id}` });
      ids.add(t.id);
    }
    for (const t of g.tasks)
      for (const d of t.deps)
        if (!ids.has(d)) ctx.addIssue({ code: "custom", message: `${t.id} depends on unknown task ${d}` });
    const cycle = findCycle(g.tasks);
    if (cycle) ctx.addIssue({ code: "custom", message: `dependency cycle: ${cycle.join(" -> ")}` });
  });

export type Task = z.infer<typeof TaskSchema>;
export type RunGraph = z.infer<typeof RunGraphSchema>;

export class GraphValidationError extends Error {
  constructor(public issues: string[]) {
    super(`invalid RunGraph:\n  - ${issues.join("\n  - ")}`);
    this.name = "GraphValidationError";
  }
}

export function validateGraph(data: unknown): RunGraph {
  const r = RunGraphSchema.safeParse(data);
  if (!r.success) {
    throw new GraphValidationError(
      r.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`),
    );
  }
  return r.data;
}

function findCycle(tasks: ReadonlyArray<{ id: string; deps: string[] }>): string[] | null {
  const deps = new Map(tasks.map((t) => [t.id, t.deps]));
  const state = new Map<string, 1 | 2>();
  const stack: string[] = [];
  const visit = (id: string): string[] | null => {
    state.set(id, 1);
    stack.push(id);
    for (const d of deps.get(id) ?? []) {
      if (state.get(d) === 1) return [...stack.slice(stack.indexOf(d)), d];
      if (!state.has(d) && deps.has(d)) {
        const c = visit(d);
        if (c) return c;
      }
    }
    state.set(id, 2);
    stack.pop();
    return null;
  };
  for (const t of tasks) {
    if (!state.has(t.id)) {
      const c = visit(t.id);
      if (c) return c;
    }
  }
  return null;
}
