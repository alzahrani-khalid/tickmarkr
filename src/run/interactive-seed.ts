import type { Assignment, WorkerAdapter } from "../adapters/types.js";
import type { ExecutorDriver, Slot } from "../drivers/types.js";

export interface InteractiveSeedResult {
  output: string;
  seedFailed: boolean;
  seedError?: string;
}

// v1.69 T6: launch-then-seed handoff for adapters whose real TUI cannot be argv-seeded.
// Both the launch command and the seed line are delivered through the driver's existing `run`
// primitive (pane-run on herdr). After the seed line is injected we read the pane back and
// treat a seed that is still sitting in the input box as a hard failure (OBS-105 discipline).
export async function runInteractiveSeed(opts: {
  driver: Pick<ExecutorDriver, "run" | "waitOutput" | "read">;
  slot: Slot;
  adapter: WorkerAdapter;
  assignment: Assignment;
  promptFile: string;
  taskTimeoutMinutes: number;
}): Promise<InteractiveSeedResult> {
  const seed = opts.adapter.interactiveSeed!;
  await opts.driver.run(opts.slot, seed.launch(opts.assignment.model));

  const ready = await opts.driver.waitOutput(
    opts.slot,
    seed.readinessMatch,
    opts.taskTimeoutMinutes * 60_000,
  );
  if (!ready) {
    const output = await opts.driver.read(opts.slot, 1000);
    return { output, seedFailed: true, seedError: `readiness pattern not seen: ${seed.readinessMatch}` };
  }

  const seedText = seed.seedLine(opts.promptFile);
  await opts.driver.run(opts.slot, seedText);

  let output = "";
  for (let attempt = 0; attempt < 5; attempt++) {
    await new Promise((r) => setTimeout(r, 200));
    output = await opts.driver.read(opts.slot, 1000);
    const bottom = output.trimEnd().split("\n").pop() ?? "";
    if (!bottom.includes(seedText)) {
      return { output, seedFailed: false };
    }
  }
  return { output, seedFailed: true, seedError: "seed line never left the input box" };
}
