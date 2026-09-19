import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";

export class ExecutionBudgetExceeded extends Error {
  constructor(public readonly taskId: string, reason = "automated execution ceiling exhausted") {
    super(`${taskId}: ${reason}`);
    this.name = "ExecutionBudgetExceeded";
  }
}
export interface ExecutionBudgetEvent { event: string; taskId?: string; data: Record<string, unknown> }
export interface ExecutionBudgetOptions {
  limitMs: number;
  taskId: string;
  readEvents: () => readonly ExecutionBudgetEvent[];
  append: (event: string, taskId: string, data: Record<string, unknown>) => void;
}
interface Budget {
  taskId: string;
  limitMs: number;
  signal: AbortSignal;
  remaining: () => number;
  check: () => void;
}
const context = new AsyncLocalStorage<Budget>();
const MIN_SLICE_MS = 60_000;
const finite = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n) && n >= 0;

function consumed(opts: ExecutionBudgetOptions): number {
  const reservations = new Map<string, { reserved: number; used?: number }>();
  for (const e of opts.readEvents()) {
    if (e.taskId !== opts.taskId || !["execution-budget-reserved", "execution-budget-settled"].includes(e.event)) continue;
    const d = e.data;
    if (!d || d.limitMs !== opts.limitMs || typeof d.id !== "string" || !d.id) {
      throw new ExecutionBudgetExceeded(opts.taskId, "invalid execution budget accounting");
    }
    if (e.event === "execution-budget-reserved") {
      if (!finite(d.reservedMs) || d.reservedMs === 0 || reservations.has(d.id)) {
        throw new ExecutionBudgetExceeded(opts.taskId, "invalid execution reservation");
      }
      reservations.set(d.id, { reserved: d.reservedMs });
    } else {
      const prior = reservations.get(d.id);
      if (!prior || prior.used !== undefined || !finite(d.usedMs) || d.usedMs > prior.reserved) {
        throw new ExecutionBudgetExceeded(opts.taskId, "invalid execution settlement");
      }
      prior.used = d.usedMs;
    }
  }
  const total = [...reservations.values()].reduce((sum, r) => sum + (r.used ?? r.reserved), 0);
  if (!finite(total) || total > opts.limitMs) throw new ExecutionBudgetExceeded(opts.taskId, "invalid execution total");
  return total;
}

export const executionSignal = (): AbortSignal | undefined => {
  const budget = context.getStore();
  budget?.check();
  return budget?.signal;
};
/** Cleanup only: the caller must bound cleanup and must not authorize task work here. */
export const withoutExecutionBudget = <T>(run: () => T): T => context.exit(run);
export const remainingExecutionMs = (): number | undefined => context.getStore()?.remaining();

/** One wall-clock interval around task execution, shared by parallel children. Cancellation is
 * cooperative: callers must stop on executionSignal(), and this wrapper waits for their cleanup.
 * Durable slices are bought before work: at least one minute or 1% of the task ceiling, capped
 * by what remains. This avoids a per-second journal stream. An interrupted slice stays fully
 * charged, conservatively consuming its unused portion; daemon-offline time is never charged. */
export async function withExecutionBudget<T>(opts: ExecutionBudgetOptions, run: () => Promise<T>): Promise<T> {
  if (!finite(opts.limitMs) || opts.limitMs === 0 || !opts.taskId) throw new ExecutionBudgetExceeded(opts.taskId, "invalid execution ceiling");
  const parent = context.getStore();
  if (parent) {
    if (parent.taskId !== opts.taskId || parent.limitMs !== opts.limitMs) throw new ExecutionBudgetExceeded(opts.taskId, "nested execution budget mismatch");
    parent.check();
    parent.signal.throwIfAborted();
    return run();
  }
  const prior = consumed(opts);
  const available = opts.limitMs - prior;
  const sliceMs = Math.max(MIN_SLICE_MS, opts.limitMs / 100);
  if (available <= 0) throw new ExecutionBudgetExceeded(opts.taskId);
  const controller = new AbortController();
  const start = performance.now();
  let reserved = 0;
  let current: { id: string; before: number; amount: number } | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const elapsed = () => Math.max(0, performance.now() - start);
  const remaining = () => Math.max(0, available - elapsed());
  const stop = (error: unknown) => controller.abort(error instanceof Error ? error : new ExecutionBudgetExceeded(opts.taskId));
  const buy = (amount: number) => {
    if (amount <= 0) return;
    const next = { id: randomUUID(), before: reserved, amount };
    opts.append("execution-budget-reserved", opts.taskId, { id: next.id, limitMs: opts.limitMs, reservedMs: amount });
    current = next;
    reserved += amount;
  };
  // JS timers cannot preempt a blocked event loop. Charge elapsed overruns before another
  // observable operation or completion; expiration consumes the whole allowance across resume.
  const check = () => {
    try {
      const used = Math.min(available, elapsed());
      if (used > reserved) buy(used - reserved);
      if (used >= available) stop(new ExecutionBudgetExceeded(opts.taskId));
    } catch (error) { stop(error); }
  };
  const reserve = () => {
    if (elapsed() >= available) check();
    if (controller.signal.aborted) return;
    buy(Math.min(available - reserved, Math.max(sliceMs, elapsed() - reserved + sliceMs)));
    timer = setTimeout(() => {
      try { reserve(); } catch (error) { stop(error); }
    }, Math.max(0, reserved - elapsed()));
  };
  reserve();
  controller.signal.throwIfAborted();
  const budget: Budget = { taskId: opts.taskId, limitMs: opts.limitMs, signal: controller.signal, remaining, check };
  try {
    return await context.run(budget, async () => {
      controller.signal.throwIfAborted();
      const result = await run();
      check();
      controller.signal.throwIfAborted();
      return result;
    });
  } catch (error) {
    check();
    controller.signal.throwIfAborted();
    throw error;
  } finally {
    clearTimeout(timer);
    check();
    if (current) {
      const usedMs = Math.min(current.amount, Math.max(0, elapsed() - current.before));
      opts.append("execution-budget-settled", opts.taskId, { id: current.id, limitMs: opts.limitMs, usedMs });
    }
    controller.signal.throwIfAborted();
  }
}
