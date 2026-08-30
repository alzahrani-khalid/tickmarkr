import { allAdapters, discoverChannels, doctorAgeMs, modelAuthExclusions, probeAll, readDoctor, servableExclusions, servabilityLine } from "../../adapters/registry.js";
import { formatModelAuthLine, contextWindowLints, modelLints, preferEntryLints, ttyVisual, type RoutedAssignment } from "../../adapters/model-lints.js";
import { GLYPHS, dim, rule, title, warn } from "../../brand.js";
import { parseArgs } from "node:util";
import { collateralLints, sourceScopeLints } from "../../compile/collateral.js";
import { classifyContextPath } from "../../compile/native.js";
import { DEFAULT_CONFIG, overlayPreferShapes, ROUTING_MODES, type RoutingMode, TIER_RANK } from "../../config/config.js";
import { loadGraph } from "../../graph/graph.js";
import { renderAcceptanceItem, type Task } from "../../graph/schema.js";
import { resolveRunMode } from "../../run/daemon.js";
import { excludedChannels, exclusionLine } from "../../route/preference.js";
import { staffLedEvidence } from "../../route/profile.js";
import { route, RoutingError } from "../../route/router.js";
import { auditNamedTestOracles, listVitestTests, type VitestListResult } from "../../gates/acceptance.js";
import { modelId } from "../../gates/review.js";
import { loadRoutingProfile } from "../../run/journal.js";
import { harnessLine, resolveHarness } from "../harness.js";
import { shq, type BillingChannel, type WorkerAdapter } from "../../adapters/types.js";
import { shGit } from "../../run/git.js";

// T4 (v1.50): TTY-only brand pass — the title helper frames the routing table, lint/unroutable
// markers carry the attention glyph, section labels dim to chrome (the doctor/status system).
// Gated on ttyVisual(): the non-TTY surface returns untouched (byte-pinned, machine-consumable).
const stylizePlan = (out: string): string => {
  if (!ttyVisual()) return out;
  return out.split("\n").map((line, i) => {
    if (i === 0) return `${title(line)}\n${rule()}`;
    if (/^(routing|context window|scope) lints:$/.test(line)) return dim(line);
    return line
      .replace(/^(\s+)! /, (_, s: string) => `${s}${warn(GLYPHS.attention)} `)
      .replace(/^(  \S+\s+\S+\s+)!! /, (_, p: string) => `${p}${warn("!!")} `);
  }).join("\n");
};

const fleetCanCrossVendorReview = (channels: BillingChannel[]) => {
  for (let i = 0; i < channels.length; i++)
    for (let j = 0; j < channels.length; j++)
      if (i !== j && channels[i].vendor !== channels[j].vendor && modelId(channels[i].model) !== modelId(channels[j].model)) return true;
  return false;
};

export type PlanOpts = {
  listTests?: (cwd: string) => Promise<VitestListResult>;
};

type TaskInputFinding = {
  taskId: string;
  severity: "refuse" | "warn";
  detail: string;
};

const NAMED_CRITERION_PATH = /(?:^|[\s("'`])((?:src|tests|fixtures|scripts)\/[A-Za-z0-9_@{}*?.,/+-]+\.(?:tsx|ts|jsx|json|js|mjs|cjs|md|txt))(?![A-Za-z0-9])/g;

async function taskInputFindings(tasks: readonly Task[], cwd: string): Promise<TaskInputFinding[]> {
  const pathsByTask = tasks.map((task) => {
    const paths = new Set(task.files.map((path) => path.replace(/^\.\//, "")));
    for (const item of task.acceptance) {
      const texts = typeof item === "string"
        ? [item]
        : [renderAcceptanceItem(item), ...Object.values(item).filter((value): value is string => typeof value === "string")];
      for (const text of texts) {
        for (const match of text.matchAll(NAMED_CRITERION_PATH)) paths.add(match[1]!);
      }
    }
    return { task, paths: [...paths] };
  });
  if (pathsByTask.every(({ paths }) => paths.length === 0)) return [];

  const [tree, diff] = await Promise.all([
    shGit("git ls-tree --full-tree -r --name-only -z HEAD", cwd),
    shGit("git diff --name-only -z HEAD --", cwd),
  ]);
  if (tree.code !== 0 || diff.code !== 0) return [];

  const tracked = new Set(tree.stdout.split("\0").filter(Boolean));
  const changed = new Set(diff.stdout.split("\0").filter(Boolean));
  const findings: TaskInputFinding[] = [];
  for (const { task, paths } of pathsByTask) {
    for (const path of paths) {
      const state = classifyContextPath(path, tracked, cwd);
      if (state.kind === "untracked") {
        findings.push({
          taskId: task.id,
          severity: "refuse",
          detail: `task path ${JSON.stringify(path)} exists in the working tree but no commit holds it`,
        });
      } else if (
        state.kind === "ok"
        && (changed.has(path) || [...changed].some((candidate) => candidate.startsWith(`${path}/`)))
      ) {
        findings.push({
          taskId: task.id,
          severity: "warn",
          detail: `tracked path ${JSON.stringify(path)} differs from HEAD — run git restore -- ${shq(path)} to discard the divergence, or commit it before dispatch`,
        });
      }
    }
  }
  return findings;
}

// v1.89 T4: harnessFrom is the resolver's INPUT — a caller (the byte-pinned goldens) fixes the location
// and keeps this machine's absolute paths out of a fixture. The default is the INVOKED entrypoint,
// `process.argv[1]`: the bin symlink a global install puts on PATH, which resolves to dist/cli/index.js.
// It is NOT `import.meta.url` — that names dist/cli/commands/plan.js, an internal module of the harness
// rather than the harness that was invoked, so the banner would identify the wrong file entirely.
export async function plan(
  argv: string[],
  cwd = process.cwd(),
  adapters: WorkerAdapter[] = allAdapters(),
  harnessFrom: string | undefined = process.argv[1],
  opts: PlanOpts = {},
): Promise<string> {
  // ponytail: hardcoded 24h TTL — promote to config when an operator asks. mtime is the signal because
  // doctor.json has no probe timestamp and a schema field would break the existing-files compat invariant.
  const DOCTOR_STALE_MS = 24 * 60 * 60 * 1000;
  // v1.51 T2: plan previews any mode without a config edit — same source precedence as run
  // (flag > spec front-matter > repo > global > default), same preset compiler.
  const { values } = parseArgs({ args: argv, options: { mode: { type: "string" } }, allowPositionals: true });
  if (values.mode !== undefined && !(ROUTING_MODES as readonly string[]).includes(values.mode)) {
    throw new Error(`--mode must be one of ${ROUTING_MODES.join(" | ")} (got ${values.mode})`);
  }
  const g = loadGraph(cwd);
  const oracleRefusals = new Map<string, string[]>();
  if (g.tasks.some((task) => task.acceptance.some((item) => typeof item === "object" && item.oracle === "test"))) {
    const listing = await (opts.listTests ?? listVitestTests)(cwd);
    for (const task of g.tasks) {
      const refusals: string[] = [];
      if (listing.status === "failed") {
        if (task.acceptance.some((item) => typeof item === "object" && item.oracle === "test")) {
          refusals.push(`acceptance oracle unresolved — runner listing failed: ${listing.error.split("\n")[0]}`);
        }
      } else {
        for (const audit of auditNamedTestOracles(task.acceptance, listing.tests)) {
          if (audit.matches.length === 0) {
            refusals.push(`acceptance oracle ${JSON.stringify(audit.criterion)} matches zero runner-listed test names`);
          } else if (audit.matches.length > 1) {
            refusals.push(`acceptance oracle ${JSON.stringify(audit.criterion)} matches ${audit.matches.length} runner-listed test names`);
          }
        }
      }
      if (refusals.length) oracleRefusals.set(task.id, refusals);
    }
  }
  const inputFindings = await taskInputFindings(g.tasks, cwd);
  const inputRefusals = new Map<string, string[]>();
  for (const finding of inputFindings) {
    if (finding.severity !== "refuse") continue;
    inputRefusals.set(finding.taskId, [...(inputRefusals.get(finding.taskId) ?? []), finding.detail]);
  }
  const { cfg, mode, source } = resolveRunMode(cwd, { flag: values.mode as RoutingMode | undefined, spec: g.mode });
  // readDoctor cache path: staleness line only fires here (probeAll fallback is fresh by construction).
  const cached = readDoctor(cwd);
  const health = cached ?? (await probeAll(adapters));
  const channels = discoverChannels(cfg, adapters, health);
  // VIS-04 trust ramp (VALIDATION 13-01-11): preview:true bypasses the routing.learned:off short-circuit so
  // the static-vs-learned comparison renders even when the daemon's learned routing is off. Cold ⇒ undefined ⇒
  // output byte-identical to today.
  const profile = loadRoutingProfile(cwd, cfg, { preview: true });
  // T10: the headline row names the channel the run would actually DISPATCH. The daemon builds its profile
  // without preview, so routing.learned: off means it dispatches the static pick — the preview profile may
  // only feed the "learned would pick" comparison line below, never the row itself. Scoped to the switch:
  // with learned on, dispatchProfile === profile and the surface is byte-identical to before.
  const dispatchProfile = cfg.routing.learned === "off" ? undefined : profile;
  let deviations = 0;
  // v1.51 T4: the mode is never invisible — the header names the resolved mode, its winning
  // source, and the explore posture; each task row carries a floor-derivation line below.
  // v1.89 T4: the harness names itself ABOVE the routing table — the table is only as trustworthy as the
  // binary that produced it, and version equality cannot tell an installed package from a checkout.
  const lines: string[] = [
    `tickmarkr plan — dry run (${channels.length} channels available)`,
    `mode: ${mode.mode} (${source}) · explore ${cfg.routing.explore?.mode ?? "on"}`,
    harnessLine(resolveHarness(harnessFrom)),
    "",
  ];
  const derivation = (shape: string): string | null => {
    const floor = cfg.routing.floors[shape];
    return floor ? `    floor ${floor} ← ${mode.provenance[shape] ?? "config floors"}` : null;
  };
  const excluded = excludedChannels(cfg, adapters, health);
  if (excluded.length) lines.push(exclusionLine(excluded), "");
  const servable = servableExclusions(cfg, adapters, health);
  if (servable.length) lines.push(servabilityLine(servable), "");
  // T2 (2026-07-13): per-model unauthed verdicts from doctor — one lint per exclusion (reason + date).
  const modelUnauthed = modelAuthExclusions(cfg, adapters, health);
  if (modelUnauthed.length) lines.push(formatModelAuthLine(modelUnauthed, ttyVisual()), "");
  const unauthed = adapters.filter((a) => health[a.id]?.installed && !health[a.id]?.authed).map((a) => a.id);
  if (unauthed.length) lines.push(`installed but unauthed: ${unauthed.join(", ")} — channels excluded from routing`, "");
  if (cached) {
    const age = doctorAgeMs(cwd);
    if (age !== null && age > DOCTOR_STALE_MS) {
      lines.push(`doctor.json is ${Math.floor(age / 3_600_000)}h old — run 'tickmarkr doctor' to refresh (servability/auth may have changed)`, "");
    }
  }
  // HYG-07(a)/T2 pin honesty: append the drop reason when a pin/miss message names a filtered channel —
  // servable (not served) or model-auth (unauthed). Floor-failure errors name only surviving channels, so
  // these never fire there; the standalone exclusion lines above carry that attribution.
  const exclusionReason = (msg: string): string => {
    const s = servable.find((x) => msg.includes(x.key));
    if (s) return ` — ${s.key} is unservable (not in ${s.adapter}'s served model list)`;
    const m = modelUnauthed.find((x) => msg.includes(x.key));
    if (m) return ` — ${m.key} is unauthed (${m.reason}, probed ${m.probedAt.split("T")[0]})`;
    return "";
  };
  // v1.51 T1: mode-resolution lints (shadowed deltas, below-integrity operator floors) surface here every run.
  const lints: string[] = [...mode.lints];
  // v1.51 T5: staff-led economics guard — when the MODE (never an explicit operator line) lowered a
  // shape's floor and warm evidence shows the cheap band materially under the mid incumbent, say so.
  // Advisory only: no floor is raised here or anywhere on prediction — raises stay evidence-triggered
  // (task-hint floors, the in-run retry ladder), each journaled with provenance.
  if (mode.mode === "staff-led") {
    const fmtScore = (s: number) => `${s < 0 ? "" : "+"}${s.toFixed(3)}`;
    for (const [shape, floor] of Object.entries(cfg.routing.floors)) {
      const dflt = DEFAULT_CONFIG.routing.floors[shape];
      if (mode.provenance[shape] !== "mode staff-led" || !dflt || TIER_RANK[floor] >= TIER_RANK[dflt]) continue;
      const ev = staffLedEvidence(profile, shape, channels);
      if (ev) {
        lints.push(
          `staff-led may cost more than risk-based on ${shape} (cheap best ${fmtScore(ev.cheapBest)} vs mid ${fmtScore(ev.midBest)}, n=${ev.n}) — advisory only, floor stays ${floor}`,
        );
      }
    }
  }
  for (const [role, sel] of [["judge", cfg.judge], ["consult", cfg.consult]] as const) {
    if (!health[sel.adapter]?.installed) lints.push(`${role}: ${sel.adapter}:${sel.model} not installed — that gate/consult will fail closed`);
  }
  lints.push(...modelLints(cfg, health, adapters, { tty: ttyVisual() })); // health may be pre-v1.5/probeAll-fallback — no-detection branch covers both
  // v1.54 T3: dead-steering sweep — advisory only, renders with the routing lints, never alters routing.
  lints.push(...preferEntryLints(cfg, health, overlayPreferShapes(cwd)));
  // The guard here was `channels.length && !fleetCanCrossVendorReview(channels)`, so the review lint went
  // SILENT at zero channels — the first-run state, where review.required is set and nothing can route at all.
  // Deleting that clause outright is worse than the silence: it fires "no cross-vendor reviewer pair in fleet"
  // when there IS no fleet. An empty fleet and a single-vendor fleet are different faults with different
  // repairs — install or auth ANY adapter vs. add a second VENDOR — so they are two lints, not one clause.
  // The pair text stays byte-identical: tests/fixtures/brand-surfaces/plan-lints.txt pins it and this task
  // does not own that fixture, so the pair lint keeps naming the waiver as the repair it can offer inline.
  if (cfg.review.required && channels.length === 0) {
    lints.push("review: review.required is set but no channel can route — the fleet is empty; install or authenticate an adapter");
  } else if (cfg.review.required && !fleetCanCrossVendorReview(channels)) {
    lints.push("review: no cross-vendor reviewer pair in fleet — set review.required: false to waive");
  }

  let cost = 0;
  const routed: RoutedAssignment[] = [];
  for (const t of g.tasks) {
    const refusals = [...(oracleRefusals.get(t.id) ?? []), ...(inputRefusals.get(t.id) ?? [])];
    if (refusals.length) {
      lines.push(`  ${t.id.padEnd(6)} ${t.shape.padEnd(10)} !! pre-dispatch refusal — ${refusals.join("; ")}`);
      continue;
    }
    try {
      const r = route(t, cfg, channels, dispatchProfile);
      routed.push({ taskId: t.id, adapter: r.assignment.adapter, model: r.assignment.model });
      for (const l of r.lints) {
        const suf = exclusionReason(l);
        lints.push(suf ? `${l}${suf}` : l);
      }
      const est = r.assignment.channel === "sub" ? 0 : cfg.pricing[r.assignment.tier];
      cost += est;
      lines.push(
        `  ${t.id.padEnd(6)} ${t.shape.padEnd(10)} c${String(t.complexity).padEnd(3)}→ ${r.assignment.adapter}:${r.assignment.model} [${r.assignment.channel}/${r.assignment.tier}]${t.timeoutMinutes !== undefined ? ` (timeout ${t.timeoutMinutes}m)` : ""}${t.humanGate ? " (human gate)" : ""}${est ? ` ~$${est.toFixed(2)}` : ""} — ${r.provenance}`,
      );
      const d = derivation(t.shape);
      if (d) lines.push(d);
      if (r.deviation) {
        deviations++;
        const d = r.deviation;
        lines.push(`    ⇄ static would pick ${d.static} — learned picked ${d.chosen} (score ${d.score.toFixed(3)} n=${d.n} vs ${d.staticScore.toFixed(3)})`);
      } else if (dispatchProfile !== profile && profile) {
        // learned off: the row above already names the static dispatch pick; the preview keeps its
        // value by naming what learned routing WOULD have picked instead (same scores, same shape).
        const pv = route(t, cfg, channels, profile);
        if (pv.deviation) {
          deviations++;
          const d = pv.deviation;
          lines.push(`    ⇄ learned would pick ${d.chosen} (score ${d.score.toFixed(3)} n=${d.n} vs ${d.staticScore.toFixed(3)}) — routing.learned: off keeps the static pick`);
        }
      }
    } catch (e) {
      if (!(e instanceof RoutingError)) throw e;
      const msg = `${e.message}${exclusionReason(e.message)}`;
      lines.push(`  ${t.id.padEnd(6)} ${t.shape.padEnd(10)} !! ${msg}`);
      const d = derivation(t.shape);
      if (d) lines.push(d);
      lints.push(`${t.id}: unroutable — ${msg}`);
    }
  }
  const inputWarnings = inputFindings.filter((finding) => finding.severity === "warn");
  if (inputWarnings.length) {
    lines.push("", "input warnings:", ...inputWarnings.map((finding) => `  ! ${finding.taskId}: ${finding.detail}`));
  }
  lines.push("", `est. cost (API channels only, rough): ~$${cost.toFixed(2)} + judge/review/consult calls`);
  // VIS-04: summary only when a profile is active AND something deviates. Labeled by the switch — off = preview.
  if (profile && deviations) {
    lines.push(cfg.routing.learned === "off"
      ? `learned routing (preview — currently OFF): ${deviations}/${g.tasks.length} tasks would deviate from static (set routing.learned: on to adopt)`
      : `learned routing: ${deviations}/${g.tasks.length} tasks deviate from static (routing.learned: off to disable)`);
  }
  if (lints.length) lines.push("", "routing lints:", ...lints.map((l) => `  ! ${l}`));
  // v1.47 T3: advisory only — never blocks plan or --route-strict (run refuses on route().lints only)
  const windowLints = contextWindowLints(g.tasks, routed, cfg, cwd);
  if (windowLints.length) lines.push("", "context window lints:", ...windowLints.map((l) => `  ! ${l}`));
  // OBS-12/13/14/21 + OBS-76: advisory only — never blocks --route-strict (run refuses on routing lints only)
  const scopeLints = [...collateralLints(g.tasks, cwd), ...sourceScopeLints(g.tasks, cwd)];
  if (scopeLints.length) lines.push("", "scope lints:", ...scopeLints.map((l) => `  ! ${l}`));
  return stylizePlan(lines.join("\n"));
}
