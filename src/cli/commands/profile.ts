import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "../../config/config.js";
import { tickmarkrDir, stateDirName } from "../../graph/graph.js";
import {
  cellOf, cellSummary, explorationBonus, EXPLORE_CAP, learnedScore, learnedScoreTerms,
  MIN_SAMPLES, PRIOR_K, REF_MS, cellsOf,
} from "../../route/profile.js";
import {
  Journal, loadRoutingProfile, parseRunId, readProfileCursor, readProfileDiscounts,
  appendProfileDiscount, profileDiscountsPath, RUNS_WINDOW,
} from "../../run/journal.js";

// tickmarkr profile — inspect (show), forget (reset), and discount poisoned evidence (v1.46 T5).
// Read-only class like plan/status/report except discount append. `reset` writes ONE cursor scalar.
export async function profile(argv: string[], cwd = process.cwd()): Promise<string> {
  if (argv[0] === "reset") return reset(cwd);
  if (argv[0] === "discount") return discount(argv.slice(1), cwd);
  if (argv[0] === "discounts") return listDiscounts(cwd);
  if (argv[0] === "--explain" || argv.includes("--explain")) return explain(argv, cwd);
  return show(cwd);
}

// Non-destructive reset (T-13-06): a one-line runId cutoff at .tickmarkr/profile-since. NEVER deletes,
// truncates, or rotates any telemetry — the profile is derived (PROF-01), so there is nothing to delete;
// the cursor only bounds loadRoutingProfile's telemetry window. tickmarkrDir guarantees .tickmarkr exists and
// blanket-gitignores it, so the cursor is never git-addable. Opaque string: used only in a runId > compare.
function reset(cwd: string): string {
  const cursor = Journal.latestRunId(cwd) ?? ""; // empty repo ⇒ empty cursor ⇒ readProfileCursor === undefined
  const stateDir = stateDirName(cwd);
  const path = join(tickmarkrDir(cwd), "profile-since");
  writeFileSync(path, cursor + "\n");
  return [
    cursor
      ? `profile reset — learned routing now forgets runs at or before ${cursor}.`
      : `profile reset — no runs yet; wrote an empty cursor.`,
    `  wrote ${stateDir}/profile-since (telemetry is UNTOUCHED — report/resume still see every run).`,
    `  to un-reset: delete ${stateDir}/profile-since.`,
  ].join("\n");
}

function parseDiscountArgs(argv: string[]): { runId: string; taskId?: string; weight: 0 | 0.5; reason: string } {
  let runId: string | undefined;
  let taskId: string | undefined;
  let weight: 0 | 0.5 | undefined;
  let reason: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--weight" && argv[i + 1]) {
      const w = argv[++i];
      if (w !== "0" && w !== "0.5") throw new Error(`profile discount --weight must be 0 or 0.5 (got ${w})`);
      weight = w === "0" ? 0 : 0.5;
    } else if (argv[i] === "--reason" && argv[i + 1]) {
      reason = argv[++i];
    } else if (!argv[i].startsWith("--") && runId === undefined) {
      runId = parseRunId(argv[i]);
    } else if (!argv[i].startsWith("--") && taskId === undefined) {
      taskId = argv[i];
    }
  }
  if (!runId) throw new Error("profile discount requires <runId>");
  if (weight === undefined) throw new Error("profile discount requires --weight 0|0.5");
  if (!reason?.trim()) throw new Error("profile discount requires --reason (a discount is an evidence claim)");
  return { runId, taskId, weight, reason: reason.trim() };
}

function discount(argv: string[], cwd: string): string {
  const mark = parseDiscountArgs(argv);
  appendProfileDiscount(cwd, mark);
  const stateDir = stateDirName(cwd);
  const scope = mark.taskId ? `${mark.runId} task ${mark.taskId}` : mark.runId;
  return [
    `profile discount — marked ${scope} at weight ${mark.weight}.`,
    `  reason: ${mark.reason}`,
    `  wrote ${stateDir}/profile-discounts (append-only).`,
    `  list: tickmarkr profile discounts`,
  ].join("\n");
}

function listDiscounts(cwd: string): string {
  const marks = readProfileDiscounts(cwd);
  const path = profileDiscountsPath(cwd);
  if (!marks.length) {
    return existsDiscountsFile(cwd)
      ? `profile discounts — ${path}\n  (no valid marks)`
      : `profile discounts — no ${stateDirName(cwd)}/profile-discounts file yet.`;
  }
  const lines = marks.map((m) => {
    const scope = m.taskId ? `${m.runId} ${m.taskId}` : m.runId;
    return `  ${scope.padEnd(28)} weight=${m.weight}  # ${m.reason}`;
  });
  return [`profile discounts — ${path}`, ...lines].join("\n");
}

function existsDiscountsFile(cwd: string): boolean {
  try {
    readFileSync(profileDiscountsPath(cwd));
    return true;
  } catch {
    return false;
  }
}

const fmtSigned = (n: number) => (n >= 0 ? `+${n.toFixed(3)}` : n.toFixed(3));

function explain(argv: string[], cwd: string): string {
  const rest = argv[0] === "--explain" ? argv.slice(1) : argv.filter((a) => a !== "--explain");
  const shape = rest[0];
  const chKey = rest[1];
  const channel = rest[2] ?? "sub";
  if (!shape || !chKey) throw new Error("profile --explain requires <shape> <channel>");

  const cfg = loadConfig(cwd);
  const p = loadRoutingProfile(cwd, cfg, { preview: true });
  const tuning = { availWeight: cfg.routing.learnedTuning?.availWeight };
  const cell = cellOf(p, shape, chKey, channel);
  const terms = learnedScoreTerms(p, shape, chKey, channel, tuning);
  const score = learnedScore(p, shape, chKey, channel, tuning);
  const header = `${shape} × ${chKey} (${channel})`;

  if (!cell) {
    return [
      header,
      `  quality   ${fmtSigned(terms.quality)}   (no cell — neutral)`,
      `  perf      ${fmtSigned(terms.perf)}`,
      `  avail     ${fmtSigned(terms.avail)}`,
      `  overrun   ${fmtSigned(terms.overrun)}`,
      `  score     ${fmtSigned(score)}`,
    ].join("\n");
  }

  const s = cellSummary(cell);
  const disc = s.discounted > 0 ? `, ${s.discounted} rows discounted` : "";
  const qualityDetail = s.cold
    ? `n_eff ${s.nEff} < ${MIN_SAMPLES} (cold)`
    : `q̂=(qSum ${cell.qSum} + ${PRIOR_K})/(n ${cell.n} + ${2 * PRIOR_K}) − 0.5  n_raw ${s.nRaw}${disc}`;
  const perfDetail = cell.doneMedianMs === undefined || s.cold
    ? `cold`
    : `median ${Math.round(cell.doneMedianMs / 60_000)}m vs ref ${REF_MS / 60_000}m  done=${cell.doneCount}`;
  const availDetail = `quotaHits ${cell.quotaHits} / dispatches ${cell.dispatches}`;
  const overrunDetail = `overruns ${cell.overruns ?? 0} / dispatches ${cell.dispatches}`;
  const explore = cell.dispatches >= EXPLORE_CAP
    ? `spent  dispatches ${cell.dispatches} ≥ cap ${EXPLORE_CAP}`
    : `remaining ${s.exploreRemaining}  bonus ${explorationBonus(cell).toFixed(3)}`;

  return [
    header,
    `  quality   ${fmtSigned(terms.quality)}   ${qualityDetail}`,
    `  perf      ${fmtSigned(terms.perf)}   ${perfDetail}`,
    `  avail     ${fmtSigned(terms.avail)}   ${availDetail}`,
    `  overrun   ${fmtSigned(terms.overrun)}   ${overrunDetail}`,
    `  score     ${fmtSigned(score)}   (deciding only below prefer/cost/tier — ROUTE-08)`,
    `  explore   ${explore}`,
  ].join("\n");
}

// Inspection surface: preview:true bypasses the routing.learned:off short-circuit so `show` renders the
// profile even under the default off — same trust ramp as `tickmarkr plan`. The routing path stays inert.
function show(cwd: string): string {
  const cfg = loadConfig(cwd);
  const cursor = readProfileCursor(cwd);
  const p = loadRoutingProfile(cwd, cfg, { preview: true });
  const header = [
    `tickmarkr profile`,
    `  routing.learned: ${cfg.routing.learned}${cfg.routing.learned === "off" ? " (preview — routing is inert)" : ""}`,
    `  runs window: ${RUNS_WINDOW}`,
    ...(cursor ? [`  reset cursor: ${cursor}`] : []),
  ];
  if (!p || p.cells.size === 0) {
    // preview bypasses the switch ⇒ undefined here means data, not policy: no telemetry, or all behind the cursor.
    header.push("", cursor
      ? `  empty profile — no telemetry after the reset cursor (delete ${stateDirName(cwd)}/profile-since to see earlier runs).`
      : `  empty profile — no telemetry yet.`);
    return header.join("\n");
  }
  const rows = [...cellsOf(p)].map(({ shape, chKey, channel, cell }) => {
    const quality = cell.n > 0 ? (cell.qSum / cell.n).toFixed(2) : "-";
    const median = cell.doneMedianMs === undefined ? "-" : `${Math.round(cell.doneMedianMs)}ms`;
    // VIS-04/ROUTE-15 — preview must match routing's tuning, never the bare module default.
    const score = learnedScore(p, shape, chKey, channel, { availWeight: cfg.routing.learnedTuning?.availWeight }).toFixed(3);
    const cold = cell.n < MIN_SAMPLES ? `  cold (n<${MIN_SAMPLES})` : "";
    const disc = (cell.discounted ?? 0) > 0 ? `  disc=${cell.discounted}` : "";
    return `  ${shape.padEnd(10)} ${chKey.padEnd(28)} ${channel.padEnd(4)} n=${String(cell.n).padEnd(3)} q=${quality.padEnd(5)} ${median.padEnd(9)} disp=${String(cell.dispatches).padEnd(3)} score=${score}${disc}${cold}`;
  });
  return [...header, "", "  shape      channel                      class obs   quality  median    dispatch  score", ...rows].join("\n");
}
