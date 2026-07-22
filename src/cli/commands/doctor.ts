import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { allAdapters, detectCandidateClis, flagDriftWarnings, probeAll, probeModels, readAutoPrefer, servableExclusions, servabilityLine, writeDoctor } from "../../adapters/registry.js";
import { BANNER, dim, fail, kvRow, legend, ok, rule, statusRow, title } from "../../brand.js";
import { tickmarkrDir, stateDirName } from "../../graph/graph.js";
import { declaredModelWindow, hasWindowsConfig, modelLints, suggestOverlay, ttyVisual } from "../../adapters/model-lints.js";
import { DEFAULT_CONFIG, loadConfig, overlayPreferShapes } from "../../config/config.js";
import { HerdrDriver } from "../../drivers/herdr.js";
import type { WorkerAdapter } from "../../adapters/types.js";
import { disallowedBy, excludedChannels, exclusionLine, preferRanks } from "../../route/preference.js";

const visual = () => process.stdout.isTTY === true && process.env.NO_COLOR === undefined;
const alignedStatusRow = (verdict: "pass" | "fail" | "warn", key: string, value: string) =>
  `  ${statusRow(verdict, kvRow(key, value).slice(2))}`;
const attentionRow = (text: string) => `  ${statusRow("warn", text)}`;

export type DoctorOpts = { banner?: boolean };

export async function doctor(
  _argv: string[],
  cwd = process.cwd(),
  adapters: WorkerAdapter[] = allAdapters(),
  opts: DoctorOpts = {},
): Promise<string> {
  const cfg = loadConfig(cwd);
  // banner at START — the logo greets the operator before the ~60s probe wait, never trailing it (operator report 2026-07-17)
  if (opts.banner !== false && visual()) process.stdout.write(BANNER);
  // stderr, live: auth probes are real LLM calls (up to 30s per configured model) and the CLI
  // otherwise prints nothing until the end — silence here reads as a hang (v1.33.1)
  console.error("probing installed agent CLIs — one short LLM call per configured model, may take a minute...");
  const probeProgressTTY = process.stderr.isTTY === true;
  const health = await probeAll(adapters);
  // MODEL-02: detect models where the adapter exposes a list surface, BEFORE writing doctor.json (write once, below).
  // Fail OPEN — the inverse of gates' fail-closed: detection is advisory, so a broken list surface NEVER fails doctor.
  for (const a of adapters) {
    if (!a.listModels || !health[a.id].installed) continue;
    try {
      health[a.id].models = await a.listModels();
      // MODEL-05: prefer the source's own fetch time (codex's cache fetched_at) so the staleness lint
      // measures real knowledge age, not run time. opencode reads its own offline cache too but exposes
      // no fetch timestamp, so it still stamps now — its staleness lint is best-effort until it surfaces one.
      if (health[a.id].models.length) health[a.id].modelsDetectedAt = a.listModelsFetchedAt?.() ?? new Date().toISOString();
    } catch { /* fail open: leave models as-is, doctor stays healthy */ }
  }
  await probeModels(cfg, cwd, adapters, health, probeProgressTTY
    ? (adapter, model, status, durationMs) => console.error(`  ${adapter}:${model} ${status} (${(durationMs / 1000).toFixed(1)}s)`)
    : undefined);
  writeDoctor(cwd, health);
  const rows = adapters.map((a) => {
    const h = health[a.id];
    const state = !h.installed ? "not installed" : `${h.version ?? "installed"}${h.note ? ` (${h.note})` : ""}`;
    return alignedStatusRow(h.installed ? "pass" : "fail", a.id, state);
  });
  // v1.48 T1: advisory sweep for known agent CLIs with no adapter — never written to doctor.json health.
  rows.push(...detectCandidateClis().map(({ binary, version }) =>
    alignedStatusRow("warn", binary, `detected: ${version ?? "version unknown"} (no tickmarkr adapter — not routable)`),
  ));
  const herdr = HerdrDriver.available();
  rows.push(alignedStatusRow(herdr ? "pass" : "fail", "herdr", herdr ? "driver available (HERDR_ENV=1)" : "not detected — subprocess driver will be used"));
  // v1.22 T5: workspace-trust pre-flight — per installed adapter: trusted | seeded | action-required | n/a.
  // action-required names the exact one-time command (or dialog) the operator must run once.
  rows.push(legend("workspace trust:"));
  for (const a of adapters) {
    if (!health[a.id]?.installed) continue;
    if (!a.trust) {
      rows.push(`  ${dim("=")} ${kvRow(a.id, "trust: n/a").slice(2)}`);
      continue;
    }
    try {
      const v = a.trust(cwd);
      if (v.status === "trusted") rows.push(alignedStatusRow("pass", a.id, "trust: trusted"));
      else if (v.status === "seeded") rows.push(alignedStatusRow("pass", a.id, "trust: seeded"));
      else rows.push(alignedStatusRow("warn", a.id, `trust: action-required — run ONCE: ${v.command}`));
    } catch (e) {
      // fail closed on the trust line only — never abort the rest of doctor
      rows.push(alignedStatusRow("warn", a.id, `trust: action-required — run ONCE: (trust check failed: ${e instanceof Error ? e.message : String(e)})`));
    }
  }
  for (const [role, sel] of [["judge", cfg.judge], ["consult", cfg.consult]] as const) {
    if (!health[sel.adapter]?.installed) {
      rows.push(attentionRow(`${role} runs on ${sel.adapter}:${sel.model} — NOT installed; that gate will fail closed until you install it or remap cfg.${role}`));
    }
  }
  rows.push(...modelLints(cfg, health, adapters, { tty: ttyVisual(), stateDir: stateDirName(cwd), overlayPreferShapes: overlayPreferShapes(cwd) }).map(attentionRow));
  const excluded = excludedChannels(cfg, adapters, health);
  if (excluded.length) rows.push(attentionRow(exclusionLine(excluded)));
  // HYG-07(a): doctor just probed fresh (probeAll above), so servability attribution is current by construction.
  const servable = servableExclusions(cfg, adapters, health);
  if (servable.length) rows.push(attentionRow(servabilityLine(servable)));
  // v1.65 T3: hardcoded-flag drift — advisory warn rows only. Runs AFTER writeDoctor so the verdicts
  // can never leak into doctor.json, and discoverChannels/routing never read them.
  rows.push(...flagDriftWarnings(adapters, health).map(attentionRow));
  // MODEL-05/06: print-only drift fragment; advisory, whole-line-commented additions, tickmarkr NEVER applies it.
  // TTY gets a one-line summary + the fragment as a file (the full dump drowned everything else,
  // v1.33.1 onboarding); machine/CI surface keeps the inline dump — layout is pinned by tests.
  const frag = suggestOverlay(cfg, health, adapters, stateDirName(cwd));
  let drift = "";
  if (frag) {
    if (visual()) {
      const overlayPath = join(tickmarkrDir(cwd), "doctor-overlay.yaml");
      writeFileSync(overlayPath, frag);
      drift = `\n  ${statusRow("warn", `model drift: unclassified models detected — paste-ready overlay written to ${overlayPath} ${dim("(advisory; tickmarkr never applies it)")}`)}`;
    } else {
      drift = `\nmodel drift — paste-ready overlay (advisory; tickmarkr never applies):\n${frag}`;
    }
  }
  // T4: model-status table — one row per CLASSIFIED model (tiers config) with tier, auth verdict
  // (reason + date when unauthed), operator-deny flag, and prefer rank across the routing map.
  // Unclassified listed models (detected via listModels but never tiered) compress to one count line
  // per adapter — they aren't routable, so they don't earn table rows.
  const trunc = (s: string, n: number) => (s.length <= n ? s : `${s.slice(0, n - 1)}…`);
  const dateOf = (iso: string) => iso.slice(0, 10);
  const showWindows = hasWindowsConfig(cfg);
  const modelStatus = adapters.flatMap((a) => {
    const h = health[a.id];
    if (!h?.installed) return [];
    const classified = cfg.tiers[a.id]?.models ?? {};
    const models = Object.keys(classified);
    const unclassified = (h.models ?? []).filter((m) => !(m in classified));
    if (!models.length && !unclassified.length) return [];
    const w = Math.max(8, ...models.map((m) => m.length));
    const rows: string[] = [`  ${dim(a.id)}`];
    for (const m of models) {
      const v = h.modelAuth?.[m];
      const auth = !v
        ? dim("unknown")
        : v.authed
          ? ok("authed")
          : `${fail("unauthed:")} ${trunc(v.reason ?? "probe failed", 40)} (${dateOf(v.probedAt)})`;
      const d = disallowedBy({ adapter: a.id, model: m }, cfg.routing);
      const denied = d?.by === "deny" ? d.entry : "—";
      const pref = preferRanks({ adapter: a.id, model: m }, cfg).map((p) => `${p.shape}#${p.rank}`).join(",") || "—";
      const windowCol = showWindows
        ? ` ${String(declaredModelWindow(cfg, a.id, m) ?? "—").padEnd(8)}`
        : "";
      rows.push(`    ${m.padEnd(w)} ${classified[m].padEnd(8)}${windowCol} ${auth}  ${dim("denied=")}${denied}  ${dim("prefer=")}${pref}`);
    }
    if (unclassified.length) rows.push(`    ${dim(`(${unclassified.length} more listed, unclassified)`)}`);
    return rows;
  });
  const autoPrefer = readAutoPrefer(cwd);
  const preferStatus = autoPrefer
    ? Object.keys(cfg.routing.map).flatMap((shape) => {
        const auto = autoPrefer[shape];
        if (!Array.isArray(auto)) return [];
        const seed = DEFAULT_CONFIG.routing.map[shape]?.prefer ?? [];
        if (!auto.length && !seed.length) return []; // nothing derived, nothing seeded — an empty line is noise
        return [`    ${dim(`prefer ${shape} (auto):`)} ${auto.join(" > ")} ${dim("— seed was")} [${seed.join(", ")}]`];
      })
    : [];
  const modelSummary = modelStatus.length || preferStatus.length
    ? `\n${legend("model status:")}\n${[...modelStatus, ...preferStatus].join("\n")}`
    : "";
  const header = visual()
    ? `${statusRow("pass", `${title("tickmarkr doctor")} ${legend("· capability matrix")}`)}\n${rule()}`
    : "tickmarkr doctor — capability matrix:";
  return `${header}\n${rows.join("\n")}${modelSummary}${drift}\nwrote ${stateDirName(cwd)}/doctor.json`;
}
