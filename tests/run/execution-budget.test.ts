import { afterEach, expect, test, vi } from "vitest";
import { ExecutionBudgetExceeded, executionSignal, remainingExecutionMs, withExecutionBudget, withoutExecutionBudget, type ExecutionBudgetEvent } from "../../src/run/execution-budget.js";
import { shell } from "../../src/run/git.js";

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const fixture = (limitMs = 2500, rows: ExecutionBudgetEvent[] = []) => ({
  rows,
  opts: { taskId: "T1", limitMs, readEvents: () => rows,
    append: (event: string, taskId: string, data: Record<string, unknown>) => { rows.push({ event, taskId, data }); } },
});
afterEach(() => { vi.useRealTimers(); });

test("parallel and nested operations charge one monotonic interval; parked/offline time is excluded", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
  const { opts, rows } = fixture();
  const work = withExecutionBudget(opts, async () => {
    expect(rows[0].event).toBe("execution-budget-reserved");
    await Promise.all([delay(600), withExecutionBudget(opts, () => delay(800))]);
    expect(remainingExecutionMs()).toBe(1700);
  });
  await vi.advanceTimersByTimeAsync(800);
  await work;
  expect(rows.at(-1)?.data.usedMs).toBe(800);
  expect(vi.getTimerCount()).toBe(0);
  await vi.advanceTimersByTimeAsync(100000);
  await withExecutionBudget(opts, async () => { expect(remainingExecutionMs()).toBe(1700); });
  expect(executionSignal()).toBeUndefined();
});

test("interrupted reservations stay charged on resume, without charging offline interval", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
  const { opts } = fixture(1500, [{ event: "execution-budget-reserved", taskId: "T1", data: { id: "interrupted", reservedMs: 1000, limitMs: 1500 } }]);
  await vi.advanceTimersByTimeAsync(1000000);
  await withExecutionBudget(opts, async () => { expect(remainingExecutionMs()).toBe(500); });
});

test("reservation boundaries remain prepaid and exhaust exactly once with cleanup", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
  const { opts, rows } = fixture(125000);
  const work = withExecutionBudget(opts, async () => {
    await new Promise<void>((resolve) => executionSignal()!.addEventListener("abort", () => resolve(), { once: true }));
  });
  const observed = work.catch((error: unknown) => error);
  await vi.advanceTimersByTimeAsync(60000);
  expect(rows.filter((e) => e.event.endsWith("reserved")).map((e) => e.data.reservedMs)).toEqual([60000, 60000]);
  await vi.advanceTimersByTimeAsync(65000);
  expect(await observed).toBeInstanceOf(ExecutionBudgetExceeded);
  expect(rows.filter((e) => e.event.endsWith("reserved")).map((e) => e.data.reservedMs)).toEqual([60000, 60000, 5000]);
  expect(vi.getTimerCount()).toBe(0);
  await expect(withExecutionBudget(opts, async () => {})).rejects.toBeInstanceOf(ExecutionBudgetExceeded);
});

test.each([NaN, Infinity, -1, "2", null])("corrupt accounting fails closed: %s", async (usedMs) => {
  const { opts } = fixture(2500, [
    { event: "execution-budget-reserved", taskId: "T1", data: { id: "r", reservedMs: 1000, limitMs: 2500 } },
    { event: "execution-budget-settled", taskId: "T1", data: { id: "r", usedMs, limitMs: 2500 } },
  ]);
  const run = vi.fn();
  await expect(withExecutionBudget(opts, run)).rejects.toBeInstanceOf(ExecutionBudgetExceeded);
  expect(run).not.toHaveBeenCalled();
});

test("journal reservation failure prevents execution and does not leave a timer", async () => {
  vi.useFakeTimers();
  const { opts } = fixture();
  opts.append = () => { throw new Error("disk unavailable"); };
  const run = vi.fn();
  await expect(withExecutionBudget(opts, run)).rejects.toThrow("disk unavailable");
  expect(run).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});

test("shell inherits budget cancellation and preserves an explicit abort signal", async () => {
  const { opts } = fixture(80);
  await expect(withExecutionBudget(opts, async () => {
    await shell("sleep 30", "/tmp", 30000);
  })).rejects.toBeInstanceOf(ExecutionBudgetExceeded);
  const controller = new AbortController();
  controller.abort(new Error("caller stopped"));
  await expect(withExecutionBudget(fixture().opts, async () => {
    await shell("exit 99", "/tmp", 30000, false, { signal: controller.signal });
  })).rejects.toThrow("caller stopped");
});

test("renewal persistence failure aborts the active operation and clears the timer", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
  const { opts } = fixture(125000);
  const append = opts.append;
  let reservations = 0;
  opts.append = (event, taskId, data) => {
    if (event === "execution-budget-reserved" && ++reservations === 2) throw new Error("journal failed");
    append(event, taskId, data);
  };
  const outcome = withExecutionBudget(opts, () => new Promise<void>((resolve) => {
    executionSignal()!.addEventListener("abort", () => resolve(), { once: true });
  })).catch((error: unknown) => error);
  await vi.advanceTimersByTimeAsync(60000);
  expect(await outcome).toMatchObject({ message: "journal failed" });
  expect(vi.getTimerCount()).toBe(0);
});

test("changed ceilings and duplicate settlements cannot replenish an existing task", async () => {
  const { opts, rows } = fixture();
  await withExecutionBudget(opts, async () => {});
  await expect(withExecutionBudget({ ...opts, limitMs: 5000 }, async () => {})).rejects.toBeInstanceOf(ExecutionBudgetExceeded);
  rows.push(rows.at(-1)!);
  await expect(withExecutionBudget(opts, async () => {})).rejects.toBeInstanceOf(ExecutionBudgetExceeded);
});

test.each(["complete", "signal"])("delayed timers cannot refund consumed time on %s", async (mode) => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  let now = 0;
  const clock = vi.spyOn(performance, "now").mockImplementation(() => now);
  const { opts, rows } = fixture(10000);
  try {
    await expect(withExecutionBudget(opts, async () => {
      now = 12000; // monotonic time advances while no timer callback can run
      if (mode === "signal") expect(executionSignal()?.aborted).toBe(true);
    })).rejects.toBeInstanceOf(ExecutionBudgetExceeded);
    expect(rows.filter((e) => e.event === "execution-budget-reserved").reduce((sum, e) => sum + Number(e.data.reservedMs), 0)).toBe(10000);
    await expect(withExecutionBudget(opts, async () => {})).rejects.toBeInstanceOf(ExecutionBudgetExceeded);
    expect(vi.getTimerCount()).toBe(0);
  } finally { clock.mockRestore(); }
});

test("completion accounts a delayed interval below the ceiling before refunding", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  let now = 0;
  const clock = vi.spyOn(performance, "now").mockImplementation(() => now);
  const { opts } = fixture(10000);
  try {
    await withExecutionBudget(opts, async () => { now = 6500; });
    now = 999999; // subsequent offline interval is not execution
    await withExecutionBudget(opts, async () => { expect(remainingExecutionMs()).toBe(3500); });
  } finally { clock.mockRestore(); }
});


test("bounded cleanup can exit the context without clearing its aborted parent", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
  const { opts } = fixture(100);
  const outcome = withExecutionBudget(opts, async () => {
    await new Promise<void>((resolve) => executionSignal()!.addEventListener("abort", () => resolve(), { once: true }));
    await withoutExecutionBudget(async () => {
      expect(executionSignal()).toBeUndefined();
      await delay(20);
      expect(remainingExecutionMs()).toBeUndefined();
    });
    expect(executionSignal()?.aborted).toBe(true);
  }).catch((error: unknown) => error);
  await vi.advanceTimersByTimeAsync(120);
  expect(await outcome).toBeInstanceOf(ExecutionBudgetExceeded);
  await expect(withExecutionBudget(opts, async () => {})).rejects.toBeInstanceOf(ExecutionBudgetExceeded);
});


test.each([300000, 36000000])("long execution uses coarse reservations and reads history only at entry: %s ms", async (limitMs) => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
  const { opts, rows } = fixture(limitMs);
  const read = vi.fn(opts.readEvents);
  opts.readEvents = read;
  const outcome = withExecutionBudget(opts, () => new Promise<void>((resolve) => {
    executionSignal()!.addEventListener("abort", () => resolve(), { once: true });
  })).catch((error: unknown) => error);
  await vi.advanceTimersByTimeAsync(limitMs);
  expect(await outcome).toBeInstanceOf(ExecutionBudgetExceeded);
  const reservations = rows.filter((e) => e.event === "execution-budget-reserved");
  const slice = Math.max(60000, limitMs / 100);
  expect(reservations).toHaveLength(Math.ceil(limitMs / slice));
  expect(reservations.length).toBeLessThanOrEqual(100);
  expect(rows.filter((e) => e.event === "execution-budget-settled")).toHaveLength(1);
  expect(read).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBe(0);
});

test("a mid-slice interruption consumes the unused reservation on resume without charging offline time", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
  const initial = fixture(65000);
  const work = withExecutionBudget(initial.opts, () => delay(15000));
  await vi.advanceTimersByTimeAsync(10000);
  // Capture exactly the durable bytes a restarted process would see if this process died now.
  const interrupted = structuredClone(initial.rows);
  expect(interrupted).toHaveLength(1);
  expect(interrupted[0].data.reservedMs).toBe(60000);
  await vi.advanceTimersByTimeAsync(5000);
  await work; // clean up the simulated original; its later settlement is absent from the snapshot
  await vi.advanceTimersByTimeAsync(86400000);
  const { opts, rows } = fixture(65000, interrupted);
  await withExecutionBudget(opts, async () => {
    expect(remainingExecutionMs()).toBe(5000);
    expect(rows.at(-1)?.data.reservedMs).toBe(5000);
  });
});

test("delayed completion catches up beyond the coarse reservation and cannot refill on resume", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  let now = 0;
  const clock = vi.spyOn(performance, "now").mockImplementation(() => now);
  const { opts, rows } = fixture(180000);
  try {
    await expect(withExecutionBudget(opts, async () => { now = 200000; })).rejects.toBeInstanceOf(ExecutionBudgetExceeded);
    expect(rows.filter((e) => e.event === "execution-budget-reserved").map((e) => e.data.reservedMs)).toEqual([60000, 120000]);
    await expect(withExecutionBudget(opts, async () => {})).rejects.toBeInstanceOf(ExecutionBudgetExceeded);
  } finally { clock.mockRestore(); }
});
