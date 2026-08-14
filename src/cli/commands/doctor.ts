import { writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { detectPackageManager, turboContinueFindings } from "../../gates/baseline.js";
import { version } from "./version.js";
import { allAdapters, binaryShadowWarnings, detectCandidateClis, flagDriftWarnings, modelAliasExclusions, modelAliasLine, probeAll, probeModels, resolveShellBinary, servableExclusions, servabilityLine, writeDoctor } from "../../adapters/registry.js";
import { CLAUDE_ALIAS_IDENTITY_STAMPS, claudeCode, type ClaudeAlias, resolveClaudeAliasIdentity } from "../../adapters/claude-code.js";
import { BANNER, dim, fail, kvRow, legend, ok, rule, statusRow, title } from "../../brand.js";
import { tickmarkrDir, stateDirName } from "../../graph/graph.js";
import { catalogModelAdvisory, catalogTierRanking, declaredModelWindow, hasWindowsConfig, modelLints, suggestOverlay, ttyVisual } from "../../adapters/model-lints.js";
import { loadConfig, overlayPreferShapes } from "../../config/config.js";
import { HerdrDriver } from "../../drivers/herdr.js";
import type { WorkerAdapter } from "../../adapters/types.js";
import { kimi, type KimiDoctorTurnResult, probeKimiDoctorTurn } from "../../adapters/kimi.js";
import { denyPreferCollisionLine, denyPreferCollisions, disallowedBy, excludedChannels, exclusionLine, preferRanks } from "../../route/preference.js";
import { LIVEBENCH_TABLE_DATE, readCachedCatalog, refreshCatalogCommand, type CatalogReadResult } from "../../adapters/catalog-remote.js";

/** Where a newer `table_<date>.csv` is discovered — the deployed site builds filenames by
 *  concatenation and publishes no index, so the release listing is the only enumerable surface. */
export const LIVEBENCH_RELEASES_URL = "https://api.github.com/repos/LiveBench/livebench.github.io/contents/public";
export const LIVEBENCH_TABLE_MAX_AGE_DAYS = 90;

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
  /** init's between-acts surface: status rows only — the model matrix and inline drift stay
   *  behind `tickmarkr doctor` (files are still written; only the RETURNED string shrinks). */
  compact?: boolean;
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
 * ponytail: ceilings — comment LINES are stripped before judgment (line-granular; see
 * stripComments), but an include built from variables is still judged by its literal
 * text, and a trailing same-line comment survives the strip. Each costs one advisory
 * row, nothing more.
 */
type RunnerInfo = {
  kind: "jest" | "vitest";
  /** config file relative path when one exists; jest may instead live in the package.json block */
  configPath?: string;
  pkgJestBlock: boolean;
};

function detectRunner(cwd: string): RunnerInfo | undefined {
  const readIf = (p: string): string => (existsSync(join(cwd, p)) ? readFileSync(join(cwd, p), "utf8") : "");
  let pkg: { scripts?: Record<string, string>; jest?: unknown } = {};
  try { pkg = JSON.parse(readIf("package.json") || "{}") as typeof pkg; } catch { /* unparseable manifest: judge config files alone */ }
  const jestConfig = ["jest.config.js", "jest.config.cjs", "jest.config.mjs", "jest.config.ts", "jest.config.json"].find((p) => existsSync(join(cwd, p)));
  const vitestConfig = ["vitest.config.ts", "vitest.config.js", "vitest.config.mts", "vitest.config.mjs", "vitest.config.cts"].find((p) => existsSync(join(cwd, p)));
  const testScript = pkg.scripts?.test ?? "";
  if (jestConfig !== undefined || pkg.jest !== undefined || /\bjest\b/.test(testScript)) {
    return { kind: "jest", configPath: jestConfig, pkgJestBlock: pkg.jest !== undefined };
  }
  if (vitestConfig !== undefined || /\bvitest\b/.test(testScript)) {
    return { kind: "vitest", configPath: vitestConfig, pkgJestBlock: false };
  }
  return undefined;
}

export function runnerIgnoreFinding(cwd: string): { verdict: "pass" | "warn"; detail: string } | undefined {
  const readIf = (p: string): string => (existsSync(join(cwd, p)) ? readFileSync(join(cwd, p), "utf8") : "");
  const runner = detectRunner(cwd);
  if (!runner) return undefined;
  const isJest = runner.kind === "jest";
  const jestConfig = isJest ? runner.configPath : undefined;
  const vitestConfig = isJest ? undefined : runner.configPath;
  let pkg: { jest?: unknown } = {};
  try { pkg = JSON.parse(readIf("package.json") || "{}") as typeof pkg; } catch { /* judged above */ }

  // Comment LINES are stripped before judgment: a commented-out ignore must not
  // false-pass, and a prose comment mentioning .tickmarkr must not false-warn the
  // anchor probe. Stripping is LINE-granular on purpose: in-line regex stripping ate
  // glob strings — `'**/*.d.ts'` contains `/*` and later globs contain `*/`, so a
  // naive block-comment regex deleted the middle of real configs and false-PASSED a
  // repo-wide vitest include (caught on Intl-Dossier's config; shipped briefly in
  // 1.90.1). Trailing same-line comments survive — acceptable: they can only make the
  // probe more conservative on lines that also carry code.
  const stripComments = (s: string): string => s.split("\n").filter((l) => {
    const t = l.trimStart();
    return !(t.startsWith("//") || t.startsWith("/*") || t.startsWith("*"));
  }).join("\n");
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

/**
 * Q134s (doctor --fix): the WRITE half of Q122s/Q130s. Doctor's advisory row cost two
 * repos a hand-edit (SentioQ run 2 paid a whole run first); --fix applies the ignore
 * where a safe textual edit exists and refuses loudly otherwise.
 *
 * Safety contract: only three write shapes, each verified by re-running
 * runnerIgnoreFinding afterward — a write that does not turn the row green is
 * REVERTED and reported as manual. Never touches package.json (jest block → manual).
 * ponytail: text-level edits, same ceilings as the finding; the verify-then-revert
 * loop is what makes them safe to ship.
 */
export function applyRunnerIgnore(cwd: string): { action: "none" | "wrote" | "manual"; detail: string } {
  const finding = runnerIgnoreFinding(cwd);
  if (!finding) return { action: "none", detail: "no recognized test runner" };
  if (finding.verdict === "pass") return { action: "none", detail: finding.detail };
  const runner = detectRunner(cwd);
  if (!runner?.configPath) {
    // package.json jest block, or a runner detected only via the test script: hand edit.
    return { action: "manual", detail: finding.detail };
  }
  const file = join(cwd, runner.configPath);
  const original = readFileSync(file, "utf8");
  let text = original;
  if (runner.kind === "jest") {
    // 1) Replace unanchored poison entries in place (the SentioQ run-2 shape).
    text = text.replace(/(["'])\/?\.tickmarkr\/?\1/g, '"<rootDir>/\\\\.tickmarkr/"');
    if (text === original && !/\.tickmarkr/.test(text)) {
      const arr = /testPathIgnorePatterns(["']?)\s*:\s*\[/;
      if (arr.test(text)) {
        // 2) Existing ignore array: prepend the anchored entry.
        text = text.replace(arr, (m) => `${m}"<rootDir>/\\\\.tickmarkr/", `);
        if (runner.configPath.endsWith(".json")) text = text.replace(/,(\s*)\]/g, "$1]");
      } else {
        // 3) No array: add the property, preserving jest's default /node_modules/ ignore.
        const anchor = /(module\.exports\s*=\s*\{|export\s+default\s+\{|export\s+default\s+defineConfig\(\{)/g;
        if ((text.match(anchor) ?? []).length === 1) {
          text = text.replace(anchor, (m) => `${m}\n  testPathIgnorePatterns: ["/node_modules/", "<rootDir>/\\\\.tickmarkr/"],`);
        }
      }
    }
  } else if (!/\.tickmarkr/.test(text)) {
    // vitest: add the glob to every exclude array — test.exclude is the target;
    // coverage.exclude gaining it is correct behavior, not collateral.
    const arr = /exclude\s*:\s*\[/g;
    if (arr.test(text)) text = text.replace(arr, (m) => `${m}'.tickmarkr/**', `);
  }
  if (text === original) return { action: "manual", detail: finding.detail };
  writeFileSync(file, text);
  const after = runnerIgnoreFinding(cwd);
  if (after?.verdict === "pass") {
    return { action: "wrote", detail: `wrote ${runner.configPath} — ${after.detail}` };
  }
  writeFileSync(file, original); // verify failed: never leave a half-fix behind
  return { action: "manual", detail: finding.detail };
}

/**
 * Q140s(b) / operator directive (D-OBS-10): the repo's package manager must resolve in
 * THIS process's environment — the same class of environment the daemon spawns gates
 * into. Dossier run 1: pnpm lived only in the operator's interactive PATH; every gate
 * died on `Unable to find package manager binary` / `spawnSync pnpm ENOENT`, the reds
 * were baseline-forgiven, and no suite ever ran. A which(1)-grade check at doctor time
 * turns that into preflight information.
 */
export function packageManagerFinding(
  cwd: string,
  probe: (pm: string) => boolean = (pm) => spawnSync(pm, ["--version"], { stdio: "ignore", shell: false }).error === undefined,
): { verdict: "pass" | "fail"; detail: string } | undefined {
  if (!existsSync(join(cwd, "package.json"))) return undefined;
  const pm = detectPackageManager(cwd);
  if (probe(pm)) return { verdict: "pass", detail: `${pm} (detected) resolves in this environment` };
  return {
    verdict: "fail",
    detail: `repo uses ${pm} but the binary does not resolve in this environment — every auto-detected gate command will die before running any suite (fix: corepack enable, or install ${pm} on the daemon's PATH)`,
  };
}

/**
 * Q142s: tickmarkr guarded every binary except its own. Exhibit (operator machine,
 * 2026-08-12): an orphaned npm-prefix root at ~/.local held tickmarkr AND tkr at
 * 1.85.0 beside the live 1.90.3 — two seats disagreed about the tool's version and
 * were BOTH right about their own PATH order (a consultant reported "no verify
 * command" — verify shipped in 1.90.0 — while the overseer saw it present). Checks
 * EVERY bin name the package declares: the first sweep of that machine missed `tkr`.
 */
export function selfShadowFinding(
  ownVersion: string,
  cwd = process.cwd(),
  resolve: (bin: string, cwd: string) => { resolved?: string; all: string[] } = resolveShellBinary,
  versionOf: (path: string) => string | undefined = (p) => {
    const r = spawnSync(p, ["version"], { encoding: "utf8", timeout: 5_000, shell: false });
    return r.status === 0 ? r.stdout.trim().split("\n")[0] : undefined;
  },
): { verdict: "pass" | "fail"; detail: string } | undefined {
  const hits = new Map<string, string>(); // path -> version
  for (const bin of ["tickmarkr", "tkr"]) {
    for (const p of resolve(bin, cwd).all) {
      if (!hits.has(p)) hits.set(p, versionOf(p) ?? "?");
    }
  }
  if (hits.size === 0) return undefined; // no install on PATH (repo checkout) — nothing to shadow
  const stale = [...hits].filter(([, v]) => v !== ownVersion);
  if (stale.length === 0) {
    return { verdict: "pass", detail: `single install root at ${ownVersion} (${[...hits.keys()].join(", ")})` };
  }
  const listing = stale.map(([p, v]) => `${p} → ${v}`).join(", ");
  // One mismatched hit and it's the one running? Impossible — it would report ownVersion.
  // Mismatch therefore means a SECOND root: a shell or daemon with a different PATH
  // order runs a different tickmarkr than this one, silently.
  return {
    verdict: "fail",
    detail: `stale tickmarkr/tkr binaries on PATH: ${listing} (running ${ownVersion}) — a seat with different PATH order silently runs the old binary; remove the stale install root`,
  };
}

/**
 * §4.4: `LIVEBENCH_TABLE_DATE` is a hand-bumped constant, and a constant nobody lints is a stale
 * constant — the pinned table ages silently while every tier suggestion keeps citing it. Warns past
 * 90 days, naming the pinned date and the listing where a newer table is discovered.
 * ponytail: a LINT, never a fetch — doctor stays cache-only (T17); the operator (or RELEASING.md's
 * release-time check) reads the listing and bumps the constant.
 */
export function liveBenchStalenessFinding(now: Date): string | undefined {
  const pinnedMs = Date.parse(`${LIVEBENCH_TABLE_DATE.replace(/_/g, "-")}T00:00:00Z`);
  const days = Math.floor((now.getTime() - pinnedMs) / 86_400_000);
  if (!Number.isFinite(days) || days <= LIVEBENCH_TABLE_MAX_AGE_DAYS) return undefined;
  return `LiveBench table pinned at ${LIVEBENCH_TABLE_DATE} is ${days} days old (>${LIVEBENCH_TABLE_MAX_AGE_DAYS}d) — list ${LIVEBENCH_RELEASES_URL} for a newer table_<date>.csv and bump LIVEBENCH_TABLE_DATE (advisory — tickmarkr never fetches that listing)`;
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
  // Operator directive 2026-08-12 (declutter): long per-model lists render only when asked for.
  const listAllModels = _argv.includes("--models");
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
    // OBS-503: a crash-on-version verdict carries its reason in note — print it instead of the lie.
    const state = !h.installed ? (h.note ?? "not installed") : `${h.version ?? "installed"}${h.note ? ` (${h.note})` : ""}`;
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
  // Q134s: `doctor --fix` writes the ignore when a safe edit exists (verified, else reverted).
  const runnerIgnore = runnerIgnoreFinding(cwd);
  if (runnerIgnore) {
    if (_argv.includes("--fix") && runnerIgnore.verdict === "warn") {
      const fixed = applyRunnerIgnore(cwd);
      rows.push(fixed.action === "wrote"
        ? alignedStatusRow("pass", "test-runner", fixed.detail)
        : alignedStatusRow("warn", "test-runner", `--fix could not edit safely — apply by hand: ${fixed.detail}`));
    } else {
      rows.push(alignedStatusRow(runnerIgnore.verdict, "test-runner", runnerIgnore.detail));
    }
  }
  // Q140s(b): the repo's package manager must resolve where gates spawn (D-OBS-10).
  const pmRow = packageManagerFinding(cwd);
  if (pmRow) rows.push(alignedStatusRow(pmRow.verdict, "package-manager", pmRow.detail));
  // GATE-FIX-4 §3 (dossier, 2026-08-13): an early-abort runner leaves later packages unverified
  // yet baseline-forgiven — surface it BEFORE a run pays for it.
  for (const f of turboContinueFindings(cwd, cfg)) {
    rows.push(alignedStatusRow("warn", `gates.${f.gate}`, f.detail));
  }
  // Q142s: tickmarkr's own binary gets the shadow check every adapter binary already had.
  const shadowRow = selfShadowFinding(await version(), cwd);
  if (shadowRow) rows.push(alignedStatusRow(shadowRow.verdict, "tickmarkr-binary", shadowRow.detail));
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
  // OBS-505 residue: advisory lints collect apart from the capability/trust rows so the compact
  // init journey can elide them behind the doctor pointer (one measured lint line ran 282 chars —
  // pure wrap noise between two TUIs). Full doctor output is byte-identical: they rejoin in order.
  const lintRows: string[] = [];
  const liveBenchStale = liveBenchStalenessFinding(opts.catalogNow?.() ?? new Date());
  if (liveBenchStale) lintRows.push(attentionRow(liveBenchStale));
  lintRows.push(...modelLints(cfg, health, adapters, { tty: ttyVisual(), stateDir: stateDirName(cwd), overlayPreferShapes: overlayPreferShapes(cwd) }).map(attentionRow));
  const excluded = excludedChannels(cfg, adapters, health);
  if (excluded.length) lintRows.push(attentionRow(exclusionLine(excluded)));
  lintRows.push(...denyPreferCollisions(cfg).map((c) => attentionRow(denyPreferCollisionLine(c))));
  const aliasExcluded = modelAliasExclusions(cfg, adapters, health);
  if (aliasExcluded.length) lintRows.push(attentionRow(modelAliasLine(aliasExcluded)));
  lintRows.push(...binaryShadowWarnings(adapters, health, cwd).map(attentionRow));
  // HYG-07(a): doctor just probed fresh (probeAll above), so servability attribution is current by construction.
  const servable = servableExclusions(cfg, adapters, health);
  if (servable.length) lintRows.push(attentionRow(servabilityLine(servable)));
  // v1.65 T3: hardcoded-flag drift — advisory warn rows only. Runs AFTER writeDoctor so the verdicts
  // can never leak into doctor.json, and discoverChannels/routing never read them.
  lintRows.push(...flagDriftWarnings(adapters, health).map(attentionRow));
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
        lintRows.push(attentionRow(
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
  const unclassifiedByAdapter = new Map(adapters.flatMap((a) => {
    const h = health[a.id];
    if (!h?.installed) return [];
    const classified = cfg.tiers[a.id]?.models ?? {};
    return [[a.id, (h.models ?? []).filter((m) => !(m in classified))] as const];
  }));
  // Every model under advisory in THIS report bands against one universe, built before any row
  // renders — otherwise an adapter's band would depend on where it sits in the iteration.
  const catalogRanking = catalogTierRanking(cfg, catalog, [...unclassifiedByAdapter].flatMap(([adapter, models]) =>
    models.map((model) => ({ adapter, model, resolvedModel: resolvedCatalogModel(adapter, model) }))), resolvedCatalogModel);
  const modelStatus = adapters.flatMap((a) => {
    const h = health[a.id];
    if (!h?.installed) return [];
    const classified = cfg.tiers[a.id]?.models ?? {};
    const models = Object.keys(classified);
    const unclassified = unclassifiedByAdapter.get(a.id) ?? [];
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
      const advisories = unclassified.map((model) =>
        catalogModelAdvisory(cfg, catalog, a.id, model, resolvedCatalogModel(a.id, model), catalogRanking));
      // Q128s exhibit #4 / operator directive 2026-08-12: ~600 per-model advisory rows buried the six
      // decision-grade flags on a real machine. Default view keeps ONLY rows that ask the operator for a
      // decision (tier suggestions); the no-decision bulk (uncovered + covered evidence-only) compresses
      // to one counted line per adapter. `doctor --models` restores every row — asked-for, not ambient.
      const decisive = advisories.filter((adv) => adv.suggestion);
      const bulk = advisories.filter((adv) => !adv.suggestion);
      const shown = listAllModels ? advisories : decisive;
      for (const advisory of shown) rows.push(`    ${dim(`catalog · ${advisory.display}`)}`);
      if (!listAllModels && bulk.length) {
        const uncovered = bulk.filter((adv) => adv.coverage === "uncovered").length;
        const evidenceOnly = bulk.length - uncovered;
        const parts = [
          ...(uncovered ? [`${uncovered} uncovered by ${catalog.source === "cache" ? "cached catalogs" : "vendored catalog"}`] : []),
          ...(evidenceOnly ? [`${evidenceOnly} covered without a tier suggestion`] : []),
        ];
        rows.push(`    ${dim(`catalog · ${parts.join(" · ")} — tickmarkr doctor --models lists each`)}`);
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
  if (opts.compact) {
    // Operator field report 2026-08-13: the full matrix mid-init-journey is clutter between two
    // TUIs. Every file side effect above already happened; the pointer line is the contract.
    // Advisory lints elide with the matrix (OBS-505 residue) — capability, trust, and fail-closed
    // judge/consult rows stay; the counted pointer names what moved behind `tickmarkr doctor`.
    const elided = [
      ...(lintRows.length ? [`${lintRows.length} advisory lint${lintRows.length === 1 ? "" : "s"}`] : []),
      "model matrix",
    ].join(" and ");
    return `${header}\n${rows.join("\n")}\n  ${dim(`${elided} elided — \`tickmarkr doctor\` prints them in full${drift ? "; drift overlay written" : ""}`)}\nwrote ${stateDirName(cwd)}/doctor.json`;
  }
  return `${header}\n${[...rows, ...lintRows].join("\n")}${modelSummary}${drift}\nwrote ${stateDirName(cwd)}/doctor.json`;
}
