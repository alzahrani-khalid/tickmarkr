import { parseArgs } from "node:util";
import { readDoctor } from "../../adapters/registry.js";
import { loadConfig } from "../../config/config.js";
import { captureHost, parseDriverOverride, pickDriver, preflightHostDriver } from "../../drivers/index.js";
import { loadGraph } from "../../graph/graph.js";
import { formatSummary, runDaemon } from "../../run/daemon.js";
import { denyPreferCollisionLine, denyPreferCollisions } from "../../route/preference.js";
import { endpointPreflight, finalRail, narrationSink, bindNarration, summaryGreen } from "./run.js";
import { assertRefsWritable } from "../../run/git.js";

export async function resume(argv: string[], cwd = process.cwd()): Promise<{ out: string; code: number }> {
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      "graph-changed": { type: "boolean" },
      "retry-failed": { type: "boolean" },
      readmit: { type: "string", multiple: true },
      driver: { type: "string" },
    },
    allowPositionals: true,
  });
  const runId = positionals[0];
  if (!runId) throw new Error("usage: tickmarkr resume <run-id> [--graph-changed] [--retry-failed] [--readmit <adapter:model>]... [--driver <auto|herdr|subprocess|orca|herdr-app>]");
  const driverOverride = parseDriverOverride(values.driver);
  // T3: --graph-changed is the operator's audited release of the engagement-identity guard (Sol #2 /
  // Fable F2) — the daemon refuses a mismatched/unbound journal unless this is set, then journals a
  // graph-rehash event naming both hashes. Strip the flag before runId resolution so a bare id still wins.
  const graphChanged = values["graph-changed"] ?? false;
  const retryFailed = values["retry-failed"] ?? false;
  // Queue row 397 (D-2187 add.23): each --readmit names one run-wide excluded channel as adapter:model.
  const readmit = values.readmit ?? [];
  const malformed = readmit.find((channel) => !/^[^:\s]+:\S+$/u.test(channel));
  if (malformed !== undefined) throw new Error(`tickmarkr resume --readmit takes <adapter:model>, got ${JSON.stringify(malformed)}`);
  const cfg = loadConfig(cwd);
  // v1.87 T3 (OBS-162, twice-carried workaround): the preflight runs AFTER the graph is read and
  // sees only the shapes the resumed graph carries. A deny∩prefer collision on a shape no resumed
  // task uses is a config fact the run would never resolve — it must not refuse the only
  // crash-recovery path. doctor still walks the whole map. OBS-1143: aliases are judged by the
  // identity doctor cached — the same one the daemon's discovery routes with.
  const graph = loadGraph(cwd);
  const collisions = denyPreferCollisions(cfg, graph.tasks.map((t) => t.shape), readDoctor(cwd));
  if (collisions.length) {
    throw new Error(collisions.map(denyPreferCollisionLine).join("; "));
  }
  await assertRefsWritable(cwd, "resume");
  // Queue row 340 (D-2180): the ONE host snapshot; selection, evidence and the daemon's scope warning all read it.
  const snapshot = captureHost();
  await preflightHostDriver(cfg, driverOverride, snapshot.host, cwd);
  const driver = pickDriver(cfg, driverOverride, snapshot.host);
  const narrate = await endpointPreflight(driver, narrationSink(runId));
  const s = await runDaemon(cwd, {
    runId,
    resume: true,
    graphChanged,
    retryFailed,
    readmit,
    // bound to the same sink the daemon gets, so a driver-journaled recovery reaches this rail too
    driver: bindNarration(driver, narrate),
    inheritedHcScope: snapshot.inheritedScope,
    // v1.99 T2: the ONE narration sink — the quiet rail on a TTY, the raw journal formatter on a
    // pipe. A resumed run meets the same surface a fresh one does; printing the raw formatter here
    // would leave `resume` as the last place the old unfiltered dump survives. Bound to the run id
    // the operator named, so a resumed run's lifecycle rows name THIS run and not a generic word.
    narrate,
  });
  const out = `resumed ${s.runId} — ${formatSummary(s)}${finalRail(s, cwd)}`;
  return { out, code: summaryGreen(s) ? 0 : 2 };
}
