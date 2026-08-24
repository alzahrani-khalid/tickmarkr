import { parseArgs } from "node:util";
import { loadConfig } from "../../config/config.js";
import { parseDriverOverride, pickDriver } from "../../drivers/index.js";
import { loadGraph } from "../../graph/graph.js";
import { type RunSummary, formatSummary, runDaemon } from "../../run/daemon.js";
import { denyPreferCollisionLine, denyPreferCollisions } from "../../route/preference.js";
import { narrationSink, bindNarration } from "./run.js";

const summaryGreen = (s: RunSummary) =>
  s.failed.length === 0 && s.human.length === 0 && s.blocked.length === 0 && s.pending.length === 0
  && s.tipVerify !== "failed";

export async function resume(argv: string[], cwd = process.cwd()): Promise<{ out: string; code: number }> {
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      "graph-changed": { type: "boolean" },
      "retry-failed": { type: "boolean" },
      driver: { type: "string" },
    },
    allowPositionals: true,
  });
  const runId = positionals[0];
  if (!runId) throw new Error("usage: tickmarkr resume <run-id> [--graph-changed] [--retry-failed] [--driver <auto|herdr|subprocess|orca>]");
  const driverOverride = parseDriverOverride(values.driver);
  // T3: --graph-changed is the operator's audited release of the engagement-identity guard (Sol #2 /
  // Fable F2) — the daemon refuses a mismatched/unbound journal unless this is set, then journals a
  // graph-rehash event naming both hashes. Strip the flag before runId resolution so a bare id still wins.
  const graphChanged = values["graph-changed"] ?? false;
  const retryFailed = values["retry-failed"] ?? false;
  const cfg = loadConfig(cwd);
  // v1.87 T3 (OBS-162, twice-carried workaround): the preflight runs AFTER the graph is read and
  // sees only the shapes the resumed graph carries. A deny∩prefer collision on a shape no resumed
  // task uses is a config fact the run would never resolve — it must not refuse the only
  // crash-recovery path. doctor still walks the whole map.
  const graph = loadGraph(cwd);
  const collisions = denyPreferCollisions(cfg, graph.tasks.map((t) => t.shape));
  if (collisions.length) {
    throw new Error(collisions.map(denyPreferCollisionLine).join("; "));
  }
  const narrate = narrationSink(runId);
  const s = await runDaemon(cwd, {
    runId,
    resume: true,
    graphChanged,
    retryFailed,
    // bound to the same sink the daemon gets, so a driver-journaled recovery reaches this rail too
    driver: bindNarration(pickDriver(cfg, driverOverride), narrate),
    // v1.99 T2: the ONE narration sink — the quiet rail on a TTY, the raw journal formatter on a
    // pipe. A resumed run meets the same surface a fresh one does; printing the raw formatter here
    // would leave `resume` as the last place the old unfiltered dump survives. Bound to the run id
    // the operator named, so a resumed run's lifecycle rows name THIS run and not a generic word.
    narrate,
  });
  const out = `resumed ${s.runId} — ${formatSummary(s)}`;
  return { out, code: summaryGreen(s) ? 0 : 2 };
}
