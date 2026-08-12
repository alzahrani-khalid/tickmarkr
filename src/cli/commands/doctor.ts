import { writeFileSync } from "node:fs";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { allAdapters, binaryShadowWarnings, detectCandidateClis, flagDriftWarnings, modelAliasExclusions, modelAliasLine, probeAll, probeModels, servableExclusions, servabilityLine, writeDoctor } from "../../adapters/registry.js";
import { CLAUDE_ALIAS_IDENTITY_STAMPS, claudeCode, type ClaudeAlias, resolveClaudeAliasIdentity } from "../../adapters/claude-code.js";
import { BANNER, dim, fail, kvRow, legend, ok, rule, statusRow, title } from "../../brand.js";
import { tickmarkrDir, stateDirName } from "../../graph/graph.js";
import { catalogModelAdvisory, declaredModelWindow, hasWindowsConfig, modelLints, suggestOverlay, ttyVisual } from "../../adapters/model-lints.js";
import { loadConfig, overlayPreferShapes } from "../../config/config.js";
import { HerdrDriver } from "../../drivers/herdr.js";
import type { WorkerAdapter } from "../../adapters/types.js";
import { kimi, type KimiDoctorTurnResult, probeKimiDoctorTurn } from "../../adapters/kimi.js";
import { denyPreferCollisionLine, denyPreferCollisions, disallowedBy, excludedChannels, exclusionLine, preferRanks } from "../../route/preference.js";
import { readCachedCatalog, refreshCatalogCommand, type CatalogReadResult } from "../../adapters/catalog-remote.js";

const visual = () => process.stdout.isTTY === true && process.env.NO_COLOR === undefined;
const alignedStatusRow = (verdict: "pass" | "fail" | "warn", key: string, value: string) =>
  `  ${statusRow(verdict, kvRow(key, value).slice(2))}`;
const attentionRow = (text: string) => `  ${statusRow("warn", text)}`;

export type DoctorOpts = {
  banner?: boolean;
  kimiTurnProbe?: (cwd: string) => Promise<KimiDoctorTurnResult>;
  resolveClaudeAliasIdentity?: (cwd: string, alias: ClaudeAlias) => string | undefined;
  catalog?: CatalogReadResult;
  catalogNow?: () => Date;
};

/**
 * Q122s (TRIAL T-OBS-3): tickmarkr provisions run worktrees INSIDE the repo
 * (.tickmarkr/worktrees.noindex/). A target repo whose test runner collects with
 * repo-wide globs (jest's default `**​/__tests__/**` shape, vitest's default include)
 * scans every suite once per live worktree — duplicate-suite interference red the
 * baseline AND tip-verify on SentioQ's first external run, a class invisible to
 * dogfooding (this repo's own includes are rooted at tests/).
 *
 * Q130s (TRIAL T-OBS-6): the ignore must be <rootDir>-anchored. Jest
 * testPathIgnorePatterns are REGEXES matched against the ABSOLUTE test path; an
 * unanchored "/.tickmarkr/" also matches every suite INSIDE a worktree provisioned at
 * <repo>/.tickmarkr/worktrees.noindex/… — jest discovers nothing there and the whole
 * gate battery fails closed (SentioQ run 2: 10 dispatches, 0 merges). Anchored
 * patterns resolve <rootDir> to the worktree itself and stay inert. Vitest
 * include/exclude globs match root-relative paths, so they cannot self-match, but the
 * prescribed shape is root-anchored anyway.
 *
 * Text-level heuristic, advisory only — never enters health/doctor.json or routing.
 * ponytail: ceilings — comments are stripped before judgment, but an include built
 * from variables is still judged by its literal text, and a pattern string containing
 * `//` would be truncated by the line-comment strip. Each costs one advisory row,
 * nothing more.
 */
export function runnerIgnoreFinding(cwd: string): { verdict: "pass" | "warn"; detail: string } | undefined {
  const readIf = (p: string): string => (existsSync(join(cwd, p)) ? readFileSync(join(cwd, p), "utf8") : "");
  const pkgText = readIf("package.json");
  let pkg: { scripts?: Record<string, string>; jest?: unknown } = {};
  try { pkg = JSON.parse(pkgText || "{}") as typeof pkg; } catch { /* unparseable manifest: judge config files alone */ }
  const jestConfig = ["jest.config.js", "jest.config.cjs", "jest.config.mjs", "jest.config.ts", "jest.config.json"].find((p) => existsSync(join(cwd, p)));
  const vitestConfig = ["vitest.config.ts", "vitest.config.js", "vitest.config.mts", "vitest.config.mjs", "vitest.config.cts"].find((p) => existsSync(join(cwd, p)));
  const testScript = pkg.scripts?.test ?? "";
  const isJest = jestConfig !== undefined || pkg.jest !== undefined || /\bjest\b/.test(testScript);
  const isVitest = !isJest && (vitestConfig !== undefined || /\bvitest\b/.test(testScript));
  if (!isJest && !isVitest) return undefined;

  // Comments are stripped before judgment: a commented-out ignore must not false-pass,
  // and a prose comment mentioning .tickmarkr must not false-warn the anchor probe.
  const stripComments = (s: string): string => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
  const configText = stripComments(isJest
    ? `${jestConfig ? readIf(jestConfig) : ""}${pkg.jest ? JSON.stringify(pkg.jest) : ""}`
    : vitestConfig ? readIf(vitestConfig) : "");
  if (/\.tickmarkr|worktrees\.noindex/.test(configText)) {
    // Q130s self-match probe: erase every <rootDir>-anchored token (through the end of
    // its quoted string); any surviving mention is a pattern that would also match
    // inside a provisioned worktree (jest regex-vs-absolute-path semantics only).
    const unanchored = configText.replace(/<rootDir>[^"'`\s]*/g, "");
    if (isJest && /\.tickmarkr|worktrees\.noindex/.test(unanchored)) {
      return {
        verdict: "warn",
        detail: `jest ignore for .tickmarkr/ is not <rootDir>-anchored — testPathIgnorePatterns are regexes against ABSOLUTE paths, so inside run worktrees (provisioned under .tickmarkr/worktrees.noindex/) it matches EVERY suite and the test gate fails closed; use "<rootDir>/\\\\.tickmarkr/" in ${jestConfig ?? "the package.json jest block"}`,
      };
    }
    return { verdict: "pass", detail: `${isJest ? "jest" : "vitest"} config ignores .tickmarkr/ — run worktrees stay out of the suite` };
  }
  // Rooted collection globs never reach .tickmarkr/…; only repo-wide `**/`-style patterns (or
  // runner defaults, which are repo-wide) can collect worktree copies.
  const repoWide = configText === "" || /["'`]\*\*\//.test(configText);
  if (!repoWide) {
    return { verdict: "pass", detail: `${isJest ? "jest" : "vitest"} collection globs are rooted — run worktrees are not collectable` };
  }
  const remedy = isJest
    ? `add "<rootDir>/\\\\.tickmarkr/" to testPathIgnorePatterns in ${jestConfig ?? "the package.json jest block"}`
    : `add ".tickmarkr/**" to test.exclude in ${vitestConfig ?? "a vitest config"}`;
  return {
    verdict: "warn",
    detail: `${isJest ? "jest" : "vitest"} collects repo-wide and will scan .tickmarkr/ run worktrees (duplicate suites, false reds) — ${remedy}`,
  };
}

export async function doctor(
  _argv: string[],
  cwd = process.cwd(),
  adapters: WorkerAdapter[] = allAdapters(),
  opts: DoctorOpts = {},
): Promise<string> {
  if (_argv.length === 1 && _argv[0] === "--refresh-catalog") {
    const refreshed = await refreshCatalogCommand({ repoRoot: cwd, now: opts.catalogNow });
    return refreshed.updated
      ? `tickmarkr doctor --refresh-catalog: model catalog refreshed${refreshed.warning ? `; ${refreshed.warning}` : ""}`
      : `tickmarkr doctor --refresh-catalog: catalog refresh unavailable — ${refreshed.warning ?? "unknown failure"}; retained ${refreshed.catalog.source} catalog`;
  }
  const cfg = loadConfig(cwd);
  // T17: synchronous/cache-only by operator ruling. The only network-bearing catalog function is the
  // separately invoked refreshCatalogCommand; ordinary doctor never calls it.
  const catalog = opts.catalog ?? readCachedCatalog(cwd, { now: opts.catalogNow });
  // banner at START — the logo greets the operator before the ~60s probe wait, never trailing it (operator report 2026-07-17)
  if (opts.banner !== false && visual()) process.stdout.write(BANNER);
  // stderr, live: auth probes are real LLM calls (up to 30s per configured model) and the CLI
  // otherwise prints nothing until the end — silence here reads as a hang (v1.33.1)
  console.error("probing installed agent CLIs — one short LLM call per configured model, may take a minute...");
  const probeProgressTTY = process.stderr.isTTY === true;
  const health = await probeAll(adapters, { cwd });
  const kimiAdapter = adapters.find((a) => a.id === kimi.id);
  const kimiTurnEnabled = kimiAdapter !== undefined
    && (kimiAdapter === kimi || opts.kimiTurnProbe !== undefined);
  if (kimiTurnEnabled) {
    const h = health.kimi;
    if (h.installed && h.authed) {
      let turn: KimiDoctorTurnResult;
      try {
        turn = await (opts.kimiTurnProbe ?? probeKimiDoctorTurn)(cwd);
      } catch (e) {
        turn = { ok: false, evidence: e instanceof Error ? e.message : String(e) };
      }
      health.kimi = {
        ...h,
        authed: turn.ok,
        note: `${h.note ? `${h.note}; ` : ""}${turn.ok ? turn.evidence : `model turn failed: ${turn.evidence}`}`,
      };
    }
  }
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
  // A free Kimi auth failure or failed earned-green turn must not spend more probes. Every other
  // adapter keeps the exact existing model-sweep path.
  const modelProbeAdapters = kimiTurnEnabled && health.kimi.authed === false
    ? adapters.filter((a) => a !== kimiAdapter)
    : adapters;
  await probeModels(cfg, cwd, modelProbeAdapters, health, probeProgressTTY
    ? (adapter, model, status, durationMs) => console.error(`  ${adapter}:${model} ${status} (${(durationMs / 1000).toFixed(1)}s)`)
    : undefined);
  writeDoctor(cwd, health);
  const rows = adapters.map((a) => {
    const h = health[a.id];
    const state = !h.installed ? "not installed" : `${h.version ?? "installed"}${h.note ? ` (${h.note})` : ""}`;
    const healthy = h.installed && (a.id !== kimi.id || h.authed);
    return alignedStatusRow(healthy ? "pass" : "fail", a.id, state);
  });
  if (catalog.warning) {
    rows.push(attentionRow(`model catalog cache unreadable — ${catalog.warning}; using vendored fallback (advisory — routing unchanged)`));
  }
  // v1.48 T1 / v1.86 T12: advisory sweep for known agent CLIs with no drive contract. Presence is
  // resolved through the worker's login shell; advisory targets are never executed or written to health.
  rows.push(...detectCandidateClis({ cwd }).map(({ binary, path }) =>
    alignedStatusRow("warn", binary, `detected at ${path} (no drive contract — not routable)`),
  ));
  const herdr = HerdrDriver.available();
  rows.push(alignedStatusRow(herdr ? "pass" : "fail", "herdr", herdr ? "driver available (HERDR_ENV=1)" : "not detected — subprocess driver will be used"));
  // Q122s: the target repo's runner must not scan tickmarkr's own worktrees (advisory row).
  const runnerIgnore = runnerIgnoreFinding(cwd);
  if (runnerIgnore) rows.push(alignedStatusRow(runnerIgnore.verdict, "test-runner", runnerIgnore.detail));
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
  rows.push(...denyPreferCollisions(cfg).map((c) => attentionRow(denyPreferCollisionLine(c))));
  const aliasExcluded = modelAliasExclusions(cfg, adapters, health);
  if (aliasExcluded.length) rows.push(attentionRow(modelAliasLine(aliasExcluded)));
  rows.push(...binaryShadowWarnings(adapters, health, cwd).map(attentionRow));
  // HYG-07(a): doctor just probed fresh (probeAll above), so servability attribution is current by construction.
  const servable = servableExclusions(cfg, adapters, health);
  if (servable.length) rows.push(attentionRow(servabilityLine(servable)));
  // v1.65 T3: hardcoded-flag drift — advisory warn rows only. Runs AFTER writeDoctor so the verdicts
  // can never leak into doctor.json, and discoverChannels/routing never read them.
  rows.push(...flagDriftWarnings(adapters, health).map(attentionRow));
  // OBS-145: resolved-identity drift is the same class of display-only doctor warning. Stamps live
  // beside the alias-owning adapter; the comparison runs only for configured floating aliases and
  // never enters health/doctor.json, config, channel discovery, learned profiles, or route().
  const identityResolver = opts.resolveClaudeAliasIdentity
    ?? (adapters.includes(claudeCode) ? resolveClaudeAliasIdentity : undefined);
  if (identityResolver && health["claude-code"]?.installed) {
    const configured = cfg.tiers["claude-code"]?.models ?? {};
    for (const [alias, stampedIdentity] of Object.entries(CLAUDE_ALIAS_IDENTITY_STAMPS) as [ClaudeAlias, string][]) {
      if (!(alias in configured)) continue;
      let resolvedIdentity: string | undefined;
      try {
        resolvedIdentity = identityResolver(cwd, alias);
      } catch {
        continue; // advisory source failure is unknown, never a doctor failure
      }
      if (resolvedIdentity && resolvedIdentity !== stampedIdentity) {
        rows.push(attentionRow(
          `resolved-identity drift: claude-code:${alias} resolved to ${resolvedIdentity}, stamped identity ${stampedIdentity} — reclassify per benchmark policy (advisory — routing unchanged)`,
        ));
      }
    }
  }
  const resolvedCatalogModel = (adapter: string, model: string): string | undefined => {
    if (adapter !== "claude-code" || !identityResolver || !(model in CLAUDE_ALIAS_IDENTITY_STAMPS)) return undefined;
    try {
      return identityResolver(cwd, model as ClaudeAlias);
    } catch {
      return undefined;
    }
  };
  // MODEL-05/06: print-only drift fragment; advisory, whole-line-commented additions, tickmarkr NEVER applies it.
  // TTY gets a one-line summary + the fragment as a file (the full dump drowned everything else,
  // v1.33.1 onboarding); machine/CI surface keeps the inline dump — layout is pinned by tests.
  const frag = suggestOverlay(cfg, health, adapters, stateDirName(cwd), {
    catalog,
    resolvedModel: resolvedCatalogModel,
  });
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
    if (unclassified.length) {
      // Keep the historical count as an index, but it is no longer the whole report: every model gets
      // a cache-backed evidence or explicit uncovered line. Neither branch changes cfg, health, or route().
      rows.push(`    ${dim(`(${unclassified.length} more listed, unclassified)`)}`);
      for (const model of unclassified) {
        const advisory = catalogModelAdvisory(cfg, catalog, a.id, model, resolvedCatalogModel(a.id, model));
        rows.push(`    ${dim(`catalog · ${advisory.display}`)}`);
      }
    }
    return rows;
  });
  const modelSummary = modelStatus.length
    ? `\n${legend("model status:")}\n${modelStatus.join("\n")}`
    : "";
  const header = visual()
    ? `${statusRow("pass", `${title("tickmarkr doctor")} ${legend("· capability matrix")}`)}\n${rule()}`
    : "tickmarkr doctor — capability matrix:";
  return `${header}\n${rows.join("\n")}${modelSummary}${drift}\nwrote ${stateDirName(cwd)}/doctor.json`;
}
