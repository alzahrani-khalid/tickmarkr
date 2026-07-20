import { parseArgs } from "node:util";
import { allAdapters, discoverChannels, probeAll, readDoctor } from "../../adapters/registry.js";
import { ROUTING_MODES, type RoutingMode } from "../../config/config.js";
import { pickDriver } from "../../drivers/index.js";
import { loadGraph } from "../../graph/graph.js";
import { type RunSummary, formatSummary, resolveRunMode, runDaemon } from "../../run/daemon.js";
import { route, type ExploreContext, NO_EXPLORE_ENV } from "../../route/router.js";
import { formatJournalNarration, loadRoutingProfile, type JournalEvent } from "../../run/journal.js";
import { ttyVisual } from "../../adapters/model-lints.js";
import { statusRow, type Verdict } from "../../brand.js";

// T4 (v1.50): lifecycle verdict glyphs on the live narration stream — glyph-first, message text
// unchanged (the doctor/status visual system). TTY-gated: the piped narration surface stays
// byte-identical to formatJournalNarration.
const NARRATION_VERDICTS: Record<string, Verdict> = {
  "task-dispatch": "neutral",
  "task-done": "pass",
  "task-failed": "fail",
  "task-human": "warn",
};

export const narrationLine = (event: JournalEvent): string => {
  const line = formatJournalNarration(event);
  const verdict = NARRATION_VERDICTS[event.event];
  return verdict !== undefined && ttyVisual() ? statusRow(verdict, line) : line;
};

const summaryGreen = (s: RunSummary) =>
  s.failed.length === 0 && s.human.length === 0 && s.blocked.length === 0 && s.pending.length === 0
  && s.tipVerify !== "failed";

// v1.51 T2: --quality is a pure compatibility alias for `--mode partner-led` (this run only). It
// carries no one-band floor raise of its own — and since the OBS-89 rip (v1.60) route() no longer
// reads the retired TICKMARKR_QUALITY env at all, so no downstream code can raise a floor on its
// behalf (proven in mode-sources).
const QUALITY_ALIAS_NOTICE =
  "tickmarkr: --quality is a compatibility alias for --mode partner-led (this run only) — "
  + "the v1.47 one-band floor raise is retired (deprecated); use --mode partner-led";

export async function run(argv: string[], cwd = process.cwd()): Promise<{ out: string; code: number }> {
  const { values } = parseArgs({
    args: argv,
    options: {
      concurrency: { type: "string" },
      driver: { type: "string" },
      "route-strict": { type: "boolean" },
      "no-explore": { type: "boolean" },
      mode: { type: "string" },
      quality: { type: "boolean" },
      supersedes: { type: "string" },
    },
  });
  if (values.concurrency !== undefined) {
    const n = Number(values.concurrency);
    if (!Number.isInteger(n) || n <= 0) throw new Error(`--concurrency must be a positive integer (got ${values.concurrency})`);
  }
  if (values.quality && values.mode !== undefined) {
    throw new Error("--quality is a compatibility alias for --mode partner-led and cannot be combined with an explicit --mode — pass one or the other");
  }
  if (values.mode !== undefined && !(ROUTING_MODES as readonly string[]).includes(values.mode)) {
    throw new Error(`--mode must be one of ${ROUTING_MODES.join(" | ")} (got ${values.mode})`);
  }
  if (values.quality) console.warn(QUALITY_ALIAS_NOTICE);
  const flagMode = (values.mode as RoutingMode | undefined) ?? (values.quality ? "partner-led" : undefined);
  const graph = loadGraph(cwd);
  const { cfg, conflict } = resolveRunMode(cwd, { flag: flagMode, spec: graph.mode });
  if (conflict) {
    // Loud, never silent: live intent (the flag) may override compiled intent (the spec) — strict refuses.
    if (values["route-strict"]) throw new Error(`--route-strict: refusing to dispatch — ${conflict}`);
    console.warn(`tickmarkr: !! ${conflict}`);
  }
  const noExplore = !!values["no-explore"];
  const exploreCtx: ExploreContext | undefined = noExplore ? { noExplore } : undefined;
  if (noExplore) process.env[NO_EXPLORE_ENV] = "1";
  try {
    if (values["route-strict"]) {
      const adapters = allAdapters();
      const health = readDoctor(cwd) ?? (await probeAll(adapters));
      const channels = discoverChannels(cfg, adapters, health);
      // no preview: the strict pre-flight routes through exactly what the daemon will use (honors the switch)
      const profile = loadRoutingProfile(cwd, cfg);
      const lints = graph.tasks.flatMap((t) => route(t, cfg, channels, profile, undefined, undefined, exploreCtx).lints);
      if (lints.length) throw new Error(`--route-strict: routing lints present, refusing to dispatch:\n${lints.join("\n")}`);
    }
    const s = await runDaemon(cwd, {
      concurrency: values.concurrency ? Number(values.concurrency) : undefined,
      driver: pickDriver(cfg, values.driver as "auto" | "herdr" | "subprocess" | undefined),
      mode: flagMode,
      supersedes: values.supersedes,
      narrate: (event) => console.log(narrationLine(event)),
    });
    const out = `run ${s.runId} finished — ${formatSummary(s)} (merge to main is a human decision)`;
    return { out, code: summaryGreen(s) ? 0 : 2 };
  } finally {
    if (noExplore) delete process.env[NO_EXPLORE_ENV];
  }
}
