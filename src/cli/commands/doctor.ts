import { writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { Script } from "node:vm";
import { existsSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { extname, join, normalize, resolve } from "node:path";
import { detectPackageManager, turboContinueFindings } from "../../gates/baseline.js";
import { version } from "./version.js";
import { allAdapters, binaryShadowWarnings, detectCandidateClis, doctorAgeMs, flagDriftWarnings, formatDoctorProbeTimeoutNote, modelAliasExclusions, modelAliasLine, probeAll, probeModels, probeScope, type ProbeScopeOpts, readDoctor, resolveShellBinary, servableExclusions, servabilityLine, writeDoctor } from "../../adapters/registry.js";
import { CLAUDE_ALIAS_IDENTITY_STAMPS, claudeCode, type ClaudeAlias, resolveClaudeAliasIdentity } from "../../adapters/claude-code.js";
import { shq } from "../../adapters/types.js";
import { BANNER, compactTokens, dim, fail, kvRow, legend, ok, rule, statusRow, title } from "../../brand.js";
import { graphPath, loadGraph, tickmarkrDir, stateDirName } from "../../graph/graph.js";
import { catalogModelAdvisory, catalogTierRanking, declaredModelWindow, hasWindowsConfig, modelLints, modelListingLints, suggestOverlay, ttyVisual } from "../../adapters/model-lints.js";
import { loadConfig, overlayPreferShapes } from "../../config/config.js";
import { HerdrDriver } from "../../drivers/herdr.js";
import { classifyHost } from "../../drivers/index.js";
import { canonicalWorktreePath, ORCA_FIXTURE_VERSION, parseEnvelope, resolveOrcaCliBinary } from "../../drivers/orca.js";
import { localeFinding, protectedFolderFinding } from "../../drivers/host-env.js";
import type { WorkerAdapter } from "../../adapters/types.js";
import { kimi, type KimiDoctorTurnResult, probeKimiDoctorTurn } from "../../adapters/kimi.js";
import { type CodexSandbox, recordCodexCommit } from "../../adapters/codex-commit-check.js";
import { codex } from "../../adapters/codex.js";
import { denyPreferCollisionLine, denyPreferCollisions, disallowedBy, excludedChannels, exclusionLine, observedSeat, preferRanks } from "../../route/preference.js";
import { CATALOG_REFRESH_TIMEOUT_MS, LIVEBENCH_TABLE_DATE, formatCatalogRefreshLegs, readCachedCatalog, refreshCatalogCommand, type CatalogFetcher, type CatalogReadResult } from "../../adapters/catalog-remote.js";
import { sh, type ShResult } from "../../run/git.js";
import { auditNamedTestOracles, listVitestTests, type VitestListResult } from "../../gates/acceptance.js";
import { readReviewNoVerdictHistory, reviewNoVerdictRows } from "../../run/journal.js";
import { checkModelDiscovery } from "../../adapters/model-discovery-check.js";
import { LAUNCHSERVICES_PORT_ADVISORY, probeLaunchServicesPorts, recordLaunchServices } from "../../run/launchservices-check.js";

/** Where a newer `table_<date>.csv` is discovered — the deployed site builds filenames by
 *  concatenation and publishes no index, so the release listing is the only enumerable surface. */
export const LIVEBENCH_RELEASES_URL = "https://api.github.com/repos/LiveBench/livebench.github.io/contents/public";
export const LIVEBENCH_TABLE_MAX_AGE_DAYS = 90;

const initialFetch = globalThis.fetch;
const visual = () => process.stdout.isTTY === true && process.env.NO_COLOR === undefined;
const alignedStatusRow = (verdict: "pass" | "fail" | "warn", key: string, value: string) =>
  `  ${statusRow(verdict, kvRow(key, value).slice(2))}`;
const attentionRow = (text: string) => `  ${statusRow("warn", text)}`;

type ReviewDemotionSummary = { reviewer: string; count: number; causes: Record<string, number> };

// Use the routing profile's established 50-run recency horizon without importing journal machinery
// into doctor. Torn/malformed rows are ignored one at a time: diagnostics must survive a killed write.
export function recentReviewDemotions(cwd: string, lastRuns = 50): ReviewDemotionSummary[] {
  const runs = join(cwd, stateDirName(cwd), "runs");
  if (!existsSync(runs)) return [];
  const grouped = new Map<string, ReviewDemotionSummary>();
  const ids = readdirSync(runs, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith("run-")
      && existsSync(join(runs, entry.name, "journal.jsonl")))
    .map((entry) => entry.name).sort().slice(-lastRuns);
  for (const id of ids) {
    const lines = readFileSync(join(runs, id, "journal.jsonl"), "utf8").split("\n");
    for (const line of lines) {
      if (!line.trim()) continue;
      let row: unknown;
      try { row = JSON.parse(line); } catch { continue; }
      if (!row || typeof row !== "object") continue;
      const event = row as { event?: unknown; data?: unknown };
      if (event.event !== "review-pool-demotion" || !event.data || typeof event.data !== "object") continue;
      const data = event.data as { reviewer?: unknown; cause?: unknown };
      if (typeof data.reviewer !== "string" || !data.reviewer.trim()) continue;
      const cause = typeof data.cause === "string" && data.cause.trim() ? data.cause : "unknown";
      const summary = grouped.get(data.reviewer) ?? { reviewer: data.reviewer, count: 0, causes: {} };
      summary.count++;
      summary.causes[cause] = (summary.causes[cause] ?? 0) + 1;
      grouped.set(data.reviewer, summary);
    }
  }
  return [...grouped.values()].sort((a, b) => a.reviewer.localeCompare(b.reviewer));
}

export type DoctorOpts = {
  banner?: boolean;
  /** Fleet discloses and probes the same effective configuration, including --global-dir. */
  globalDir?: string;
  kimiTurnProbe?: (cwd: string) => Promise<KimiDoctorTurnResult>;
  codexSandbox?: CodexSandbox;
  resolveClaudeAliasIdentity?: (cwd: string, alias: ClaudeAlias) => string | undefined;
  catalog?: CatalogReadResult;
  catalogNow?: () => Date;
  catalogFetcher?: CatalogFetcher;
  /** init's between-acts surface: status rows only — the model matrix and inline drift stay
   *  behind `tickmarkr doctor` (files are still written; only the RETURNED string shrinks). */
  compact?: boolean;
  /** Test seam for the same `orca status --json` transport production invokes. */
  orcaStatusProbe?: (cwd: string, binary: string) => Promise<ShResult>;
  /** Test seam for Orca's authoritative per-agent hook coverage listing. */
  orcaHooksStatusProbe?: (cwd: string, binary: string) => Promise<ShResult>;
  /** Environment used only to explain whether auto-selection applies in this terminal. */
  orcaEnv?: NodeJS.ProcessEnv | Record<string, string | undefined>;
  /** Test seam for shell-path discovery; absence remains a normal doctor row, never an exception. */
  resolveOrcaBinary?: (cwd: string) => string | undefined;
  /** Test seam for the runner-owned JSON listing used by the acceptance-oracle report row. */
  listTests?: (cwd: string) => Promise<VitestListResult>;
  /** Clock for model-knowledge lints (retirement notices, knowledge age); absent = the wall clock. */
  now?: () => Date;
};

type OrcaCapability = { verdict: "pass" | "fail" | "warn"; detail: string };

const ORCA_HOOK_ADAPTERS: Readonly<Record<string, string>> = {
  claude: "claude-code",
  "claude-code": "claude-code",
  codex: "codex",
  cursor: "cursor-agent",
  "cursor-agent": "cursor-agent",
  grok: "grok",
  kimi: "kimi",
  opencode: "opencode",
  pi: "pi",
};

function orcaSelectionDetail(env: NodeJS.ProcessEnv | Record<string, string | undefined>): string {
  const inside = env.TERM_PROGRAM === "Orca" && !!env.ORCA_TERMINAL_HANDLE?.trim();
  return inside
    ? "auto picks orca in this Orca terminal"
    : "not an Orca terminal; auto picks orca only inside one; use --driver orca";
}

async function orcaHookCoverage(
  cwd: string,
  binary: string,
  opts: Pick<DoctorOpts, "orcaStatusProbe" | "orcaHooksStatusProbe">,
): Promise<string> {
  // A supplied status transport is a hermetic boundary: do not escape it to a real binary for the
  // second command. Tests (and embedders) that want coverage supply the matching hook transport.
  if (opts.orcaHooksStatusProbe === undefined && opts.orcaStatusProbe !== undefined) {
    return "hooks status unavailable";
  }
  let response: ShResult;
  try {
    response = await (opts.orcaHooksStatusProbe ?? ((probeCwd, executable) =>
      sh(`${shq(executable)} agent hooks status --json`, probeCwd, 10_000)))(cwd, binary);
    if (response.code !== 0 || response.timedOut) return "hooks status unavailable";
    // Until the driver's response-family expansion lands, this still uses its one strict envelope
    // parser. Coverage comes only from this command's `statuses[].state`; managedHooksPresent and
    // local agent config files are deliberately not alternative oracles.
    const envelope = parseEnvelope("status", response.stdout);
    const statuses = envelope.result.statuses;
    if (!Array.isArray(statuses)) return "hooks status unavailable";
    const coverage = new Map<string, "hooked" | "unhooked">();
    for (const raw of statuses) {
      if (typeof raw !== "object" || raw === null || Array.isArray(raw)) continue;
      const row = raw as Record<string, unknown>;
      const adapter = typeof row.agent === "string" ? ORCA_HOOK_ADAPTERS[row.agent] : undefined;
      if (!adapter) continue;
      if (row.state === "installed") coverage.set(adapter, "hooked");
      else if (row.state === "not_installed") coverage.set(adapter, "unhooked");
    }
    return coverage.size
      ? `hooks: ${[...coverage].map(([adapter, state]) => `${adapter} ${state}`).join(", ")}`
      : "hooks: no tickmarkr adapter status reported";
  } catch {
    return "hooks status unavailable";
  }
}

/**
 * Orca's status body is deliberately interpreted by T1's one shared envelope parser. Doctor owns
 * only capability presentation: it may classify an absent executable, but it never invents a second
 * permissive JSON reader for a malformed or refused status response.
 *
 * Capability-row `detail` stays hermetic — never `OrcaError.message`, which embeds volatile CLI
 * stderr (Electron timestamps), so the row is byte-stable across runs.
 */
export async function probeOrcaCapability(
  cwd: string,
  opts: Pick<DoctorOpts, "orcaStatusProbe" | "orcaHooksStatusProbe" | "resolveOrcaBinary" | "orcaEnv"> = {},
): Promise<OrcaCapability> {
  const binary = opts.resolveOrcaBinary
    ? opts.resolveOrcaBinary(cwd)
    : resolveOrcaCliBinary(cwd, { resolve: (bin, dir) => resolveShellBinary(bin, dir) });
  if (!binary) return { verdict: "fail", detail: "CLI not installed" };

  let response: ShResult;
  try {
    response = await (opts.orcaStatusProbe ?? ((probeCwd, executable) =>
      sh(`${shq(executable)} status --json`, probeCwd, 10_000)))(cwd, binary);
  } catch {
    // The seam (or the shell) never reaching a verdict is a failed probe, never an exception out of
    // doctor: an absent or sick runtime must still render its row.
    return { verdict: "fail", detail: "CLI installed but runtime probe failed" };
  }

  try {
    // Do this before accepting the process result: Orca's documented refused transport is rc=1
    // with an ok:false envelope on stdout, and parseEnvelope preserves that refusal fail-closed.
    const envelope = parseEnvelope("status", response.stdout);
    if (response.code !== 0 || response.timedOut) {
      return {
        verdict: "fail",
        detail: `CLI installed but runtime probe failed — orca status exited ${response.code}${response.timedOut ? " after timeout" : ""}`,
      };
    }
    const runtime = envelope.result.runtime;
    const reachable = typeof runtime === "object" && runtime !== null && !Array.isArray(runtime)
      ? (runtime as Record<string, unknown>).reachable
      : undefined;
    if (reachable === true) {
      const hooks = await orcaHookCoverage(cwd, binary, opts);
      const selection = orcaSelectionDetail(opts.orcaEnv ?? process.env);
      const appVersion = typeof runtime === "object" && runtime !== null && !Array.isArray(runtime)
        ? (runtime as Record<string, unknown>).appVersion
        : undefined;
      if (typeof appVersion !== "string" || !appVersion) {
        return { verdict: "warn", detail: `runtime reachable (${envelope.runtimeId}, appVersion absent; fixture pin ${ORCA_FIXTURE_VERSION}); ${hooks} — ${selection}` };
      }
      const detail = `runtime reachable (${envelope.runtimeId}, appVersion ${appVersion}; fixture pin ${ORCA_FIXTURE_VERSION}); ${hooks} — ${selection}`;
      return { verdict: appVersion === ORCA_FIXTURE_VERSION ? "pass" : "warn", detail };
    }
    if (reachable === false) return { verdict: "fail", detail: "CLI installed but runtime unreachable" };
    return { verdict: "fail", detail: "CLI installed but runtime probe failed — status carries no reachability proof" };
  } catch {
    // Only the shared parser reads this body. Every shape it rejects — unparseable, non-object,
    // ok:false refusal, no result, or absent/`none` `_meta.runtimeId` — is a FAILED probe, never
    // an unreachable-runtime claim: a doctor that re-read those bytes with its own permissive
    // reader would call malformed metadata "installed but unreachable". Unreachable is proven only
    // by a well-formed envelope that says `reachable:false` (the shape a live orca CLI emits with
    // its runtime down — tests/helpers/fake-orca.ts).
    return { verdict: "fail", detail: "CLI installed but runtime probe failed" };
  }
}

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
 * Queue row 197 (D-2102 add.1; the claim is add.30's): an agent session's worktrees nest at
 * <repo>/.claude/worktrees/<name>/ (Vitest 3.2.7 globs with dot: true, so its default include collects
 * them). The row reports ONLY whether the config's own ignore list — jest testPathIgnorePatterns, vitest
 * test.exclude — literally carries the CANONICAL session-worktree entry beside the state dir's; it never
 * claims to prove what the runner collects. A missing entry, a rooted include, an unanchored entry (Q130s:
 * jest reads its ignores against absolute paths, so one inside a worktree self-matches) and a config
 * doctor cannot read warn, naming the entry and the file. Reading means locating that literal list: the
 * file parses cleanly (add.29, see unclean), is simple and static (add.22, see staticExport), no other
 * file configures the runner beside it, the settings keys that locate the list are plain (add.25, see
 * settingsOf), its values decode strictly (add.28, see literalList), and it declares no projects (each
 * carries its own list). Only collection settings count, never coverage or cache ones (D-2102 add.8).
 * A jest ignore entry is judged only inside a whitelist, and then by executing it as jest reads it against a
 * probe suite inside each worktree root and in the main checkout (add.33, see selfMatching); a jest rootDir
 * other than the config's own directory leaves the config unread, since it re-roots <rootDir>. A defineConfig
 * or defineProject call reads as an identity wrapper only when the runner's own module binds it (add.34). The
 * top level and the path objects are read through a whitelist, and every evaluated value must compile as
 * JavaScript (add.35, see staticExport, bindingsOf and settingsOf). The exported config must be pure data, and
 * the file must parse with a real parser in a child process (add.37, see pureData and realParse).
 *
 * Advisory only — never enters health/doctor.json or routing.
 * ponytail: ceilings — text-level; a config doctor cannot locate the list in reads as a warn, never a
 * pass. A spurious warn costs one config line; a false pass is the defect.
 */
type RunnerInfo = {
  kind: "jest" | "vitest";
  /** config file relative path when one exists; jest may instead live in the package.json block */
  configPath?: string;
  pkgJestBlock: boolean;
};

/** A file's text, "" when absent, or the error code when it cannot be read (D-2102 add.31: never a throw). */
function readText(cwd: string, p: string): { text: string; error?: string } {
  if (!existsSync(join(cwd, p))) return { text: "" };
  try { return { text: readFileSync(join(cwd, p), "utf8") }; } catch (e) { return { text: "", error: (e as NodeJS.ErrnoException).code ?? "unreadable" }; }
}

function detectRunner(cwd: string): RunnerInfo | undefined {
  const readIf = (p: string): string => readText(cwd, p).text;
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

// Vitest 3.2.7's configDefaults.exclude, written out so an exclude doctor adds keeps the runner's defaults.
const VITEST_DEFAULT_EXCLUDE = ["**/node_modules/**", "**/dist/**", "**/cypress/**", "**/.{idea,git,cache,output,temp}/**",
  "**/{karma,rollup,webpack,vite,vitest,jest,ava,babel,nyc,cypress,tsup,build,eslint,prettier}.config.*"];
// Queue row 197 (D-2102 add.15, add.30): the canonical entries, as string values.
const CANONICAL = {
  jest: { state: "<rootDir>/\\.tickmarkr/", session: "<rootDir>/\\.claude/worktrees/", ignore: "testPathIgnorePatterns" },
  vitest: { state: ".tickmarkr/**", session: ".claude/worktrees/**", ignore: "test.exclude" },
} as const;
type Dir = "state" | "session";
const DIRS = ["state", "session"] as const;
const SCANS: Record<Dir, string> = { state: ".tickmarkr/ run worktrees", session: ".claude/worktrees/ session worktrees" };
const INSIDE: Record<Dir, string> = {
  state: "inside run worktrees (provisioned under .tickmarkr/worktrees.noindex/)",
  session: "inside a session worktree (.claude/worktrees/<name>/)",
};
const STRING_LITERAL = /^(["'])(?:\\.|(?!\1)[^\\\n])*\1$/;
// The one spread with a known value: Vitest 3.2.7's own default exclude list (it holds neither entry).
// The ECMAScript line terminators: a line comment ends at any of them (queue row 197 review, D-2102 add.31).
const LINE_END = /[\n\r\u2028\u2029]/;
/** The offset of the first line terminator at or after `from`, or the end of `text`. */
const lineEnd = (text: string, from: number): number => {
  const at = text.slice(from).search(LINE_END);
  return at < 0 ? text.length : from + at;
};
// Whitespace and commas between members or elements (comments are already blanked).
const BETWEEN = /^[\s,]*/;


// Comments are blanked (offsets kept, so the writer can splice the original) before judgment: a
// commented-out ignore must not false-pass, and a prose comment mentioning .tickmarkr must not
// false-warn the anchor probe. The scan skips string literals on purpose: regex stripping ate glob
// strings — `'**/*.d.ts'` contains `/*` and later globs contain `*/`, so a naive block-comment regex
// deleted the middle of real configs and false-PASSED a repo-wide vitest include (caught on
// Intl-Dossier's config; shipped briefly in 1.90.1). Queue row 197: a block comment's inner lines
// are blanked too, so entries commented out between its delimiters never read as live.
function blankComments(s: string): string {
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    let end = i + 1;
    if (c === '"' || c === "'" || c === "`") {
      for (; end < s.length && s[end] !== c && (c === "`" || !LINE_END.test(s[end])); end++) if (s[end] === "\\") end++;
      end = Math.min(end + 1, s.length);
    } else if (c === "\\") end = i + 2;
    else if (s.startsWith("//", i)) end = lineEnd(s, i);
    else if (s.startsWith("/*", i)) end = s.indexOf("*/", i + 2) < 0 ? s.length : s.indexOf("*/", i + 2) + 2;
    const chunk = s.slice(i, end);
    out += c === "/" && (s[i + 1] === "/" || s[i + 1] === "*") ? chunk.replace(/[^\n\r\u2028\u2029]/g, " ") : chunk;
    i = end - 1;
  }
  return out;
}

/** Offset of the first top-level , ) ] or } at or after `start` (strings skipped, brackets nested). */
function scanValue(text: string, start: number): number {
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (c === '"' || c === "'" || c === "`") {
      for (i++; i < text.length && text[i] !== c; i++) if (text[i] === "\\") i++;
    } else if ("([{".includes(c)) depth++;
    else if (")]}".includes(c) && depth-- === 0) return i;
    else if (c === "," && depth === 0) return i;
  }
  return text.length;
}

/** The offset just past the bracket opened at `open` (strings skipped, brackets nested). */
function closing(text: string, open: number): number {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    const c = text[i];
    if (c === '"' || c === "'" || c === "`") {
      for (i++; i < text.length && text[i] !== c; i++) if (text[i] === "\\") i++;
    } else if ("([{".includes(c)) depth++;
    else if (")]}".includes(c) && --depth === 0) return i + 1;
  }
  return text.length;
}

/** The top-level elements of an array literal's source (offsets into it); undefined for any other expression. */
function arrayElements(value: string): { text: string; start: number }[] | undefined {
  if (!value.startsWith("[") || closing(value, 0) !== value.length) return undefined;
  const out: { text: string; start: number }[] = [];
  for (let pos = 1; pos < value.length - 1;) {
    pos += BETWEEN.exec(value.slice(pos, value.length - 1))?.[0].length ?? 0;
    if (pos >= value.length - 1) break;
    const end = Math.min(scanValue(value, pos), value.length - 1);
    out.push({ text: value.slice(pos, end).trimEnd(), start: pos });
    pos = end > pos ? end : pos + 1;
  }
  return out;
}

/** `key` is the key as written (a quoted key's body, escapes unresolved); "" for a member without one. */
type Member = { key: string; start: number; value: string };

/** The members directly inside the object literal opened at `open`; a spread, shorthand, method or computed key has key "". */
function members(text: string, open: number): Member[] {
  const close = closing(text, open) - 1;
  const out: Member[] = [];
  for (let i = open + 1; i < close;) {
    i += BETWEEN.exec(text.slice(i, close))?.[0].length ?? 0;
    if (i >= close) break;
    const key = /^(?:(["'])((?:\\.|(?!\1)[^\\\n])*)\1|((?:[A-Za-z_$]|\\u[0-9a-fA-F]{4}|\\u\{[0-9a-fA-F]+\})(?:[\w$]|\\u[0-9a-fA-F]{4}|\\u\{[0-9a-fA-F]+\})*))\s*:\s*/.exec(text.slice(i, close));
    const start = i + (key?.[0].length ?? 0);
    const stop = Math.min(scanValue(text, start), close);
    out.push({ key: key ? key[3] ?? key[2] : "", start, value: text.slice(start, stop).trimEnd() });
    i = stop > i ? stop : i + 1;
  }
  return out;
}

/**
 * D-2102 add.25 (c′) and add.28: a settings key's or a string value's escapes decoded strictly — \xHH,
 * \uHHHH, \u{H…} and \n \t \r \b \f \v \0 \' \" \\ — or undefined for any other escape (an octal, a line
 * continuation, any other character).
 */
function decodeString(raw: string): string | undefined {
  let bad = false;
  const SINGLE: Record<string, string> = { n: "\n", t: "\t", r: "\r", b: "\b", f: "\f", v: "\v", "0": "\0" };
  const out = raw.replace(/\\(?:x([0-9a-fA-F]{2})|u([0-9a-fA-F]{4})|u\{([0-9a-fA-F]{1,6})\}|([ntrbfv'"\\]|0(?![0-9]))|[\s\S]?)/g, (_, x, u, cp, single) => {
    const code = x ?? u ?? cp;
    if (code !== undefined && parseInt(code, 16) <= 0x10ffff) return String.fromCodePoint(parseInt(code, 16));
    if (single !== undefined) return SINGLE[single] ?? single;
    bad = true;
    return "";
  });
  return bad ? undefined : out;
}

/**
 * The named members of a PATH object (the exported config, its `test` object), and why they cannot be read
 * literally (D-2102 add.25, add.35): every member must be `<plain identifier | plain string>: <value>` and every
 * key must appear once — a spread, a computed, escaped or shorthand key, a method or getter, `__proto__` or a
 * repeated key reads unverifiable. Values off the path are only compiled; the keys of nested value maps
 * (transform, moduleNameMapper, alias…) are data and are never read here.
 */
function settingsOf(text: string, open: number, keys: readonly string[], what: string): { get: (key: string) => Member | undefined; computed?: string } {
  const all = members(text, open);
  const found = new Map<string, Member>();
  const seen = new Set<string>();
  let computed: string | undefined;
  for (const m of all) {
    if (m.key === "" || m.key.includes("\\")) computed ??= `${what} has a member that is not a plain key and value`;
    else if (m.key === "__proto__") computed ??= `${what} sets __proto__`;
    else if (seen.has(m.key)) computed ??= `${m.key} is set twice`;
    seen.add(m.key);
    if (keys.includes(m.key)) found.set(m.key, m);
  }
  return { get: (key) => found.get(key), computed };
}

/**
 * D-2102 add.28: what a decoded value may still escape. A jest regex may use \. \/ \- and \\ outside a
 * character class only; a glob or a path may hold no backslash at all.
 */
function plainEscapes(value: string, form: "regex" | "path"): boolean {
  if (form === "path") return !value.includes("\\");
  let inClass = false;
  for (let i = 0; i < value.length; i++) {
    const c = value[i];
    if (c === "\\") {
      if (inClass || i + 1 >= value.length || !"./-\\".includes(value[i + 1])) return false;
      i++;
    } else if (inClass) inClass = c !== "]";
    else if (c === "[") inClass = true;
  }
  return true;
}

/**
 * A setting's literal strings, each decoded strictly (D-2102 add.28) so every check reads the value the
 * runner reads: undefined when absent, "computed" for any other expression, "escape" for an escape the
 * decoder or the value's form does not allow.
 */
function literalList(value: string | undefined, form: "regex" | "path" = "path", defaults: ReadonlySet<string> = new Set()): string[] | undefined | "computed" | "escape" {
  if (value === undefined) return undefined;
  const elements = STRING_LITERAL.test(value) ? [{ text: value, start: 0 }] : arrayElements(value);
  if (!elements?.every((e) => STRING_LITERAL.test(e.text) || defaultsSpread(e.text, defaults))) return "computed";
  const out: string[] = [];
  for (const e of elements.filter((e) => STRING_LITERAL.test(e.text))) {
    const decoded = decodeString(e.text.slice(1, -1));
    if (decoded === undefined || !plainEscapes(decoded, form)) return "escape";
    out.push(decoded);
  }
  return out;
}
/** The spread of Vitest's own default excludes, `...<configDefaults>.exclude`, through a bound configDefaults. */
const defaultsSpread = (element: string, defaults: ReadonlySet<string>): boolean =>
  defaults.has(/^\.\.\.\s*([A-Za-z_$][\w$]*)\.exclude$/.exec(element)?.[1] ?? "");

/** Why a literalList result is unreadable, for a setting shown as `name`. */
const unreadableList = (list: ReturnType<typeof literalList>, name: string): string | undefined =>
  list === "computed" ? `${name} is not a literal` : list === "escape" ? `${name} holds an escape doctor does not read` : undefined;

const NOT_ONE_OBJECT = "is not one object literal";
// D-2102 add.34: the modules whose defineConfig / defineProject return their one object argument unchanged.
const WRAPPER_MODULES: Record<RunnerInfo["kind"], readonly string[]> = { vitest: ["vitest/config", "vitest", "vite"], jest: ["jest"] };
/** Local names bound to an identity wrapper, by a static import or a const require of the runner's own module. */
type Wrappers = ReadonlySet<string>;

/**
 * The offset of the object literal a value is COMPLETELY — itself, or the one argument of an identity wrapper
 * call — at `start` in its text, or why it is not: `a && b`, a conditional, a trailing operator, and any call
 * whose callee is not one of `wrappers` (a custom, local, re-exported or unresolved defineConfig included).
 */
function objectIn(value: string, start: number, wrappers: Wrappers): number | string {
  const call = /^([A-Za-z_$][\w$]*)\(\s*/.exec(value);
  if (call && !wrappers.has(call[1])) return `the call ${call[1]}(…) is not an identity wrapper imported from the runner`;
  const lead = call?.[0].length ?? 0;
  if (value[lead] !== "{") return NOT_ONE_OBJECT;
  const rest = value.slice(closing(value, lead)).trim();
  return rest === (lead ? ")" : "") ? start + lead : NOT_ONE_OBJECT;
}

const ID = "[A-Za-z_$][\\w$]*";
// D-2102 add.37: the only value imports doctor reads — named bindings from the runner's own module (an import of
// any other module runs that module's code). `import type` binds no value and is checked by the real parse.
const NAMED_IMPORT = /^import\s+\{([^}]*)\}\s*from\s*(["'])([^"'\n]+)\2$/;
const REQUIRE = new RegExp(`^const\\s+\\{([^}]*)\\}\\s*=\\s*require\\(\\s*(["'])([^"'\\n]+)\\2\\s*\\)$`);
// The modules whose configDefaults is Vitest's own default data (D-2102 add.37 follow-up).
const DEFAULTS_MODULES: readonly string[] = ["vitest/config", "vitest"];
// What any other code a config would run reads as (D-2102 add.37).
const RUNS = "it runs code doctor does not read";

/**
 * The value names one named import, or one const require, of the runner's own module binds, and the identity
 * wrappers among them (D-2102 add.34, add.35, add.37); "invalid" for a malformed specifier list; "runs" for an
 * import doctor does not read; undefined for any other statement. A wrapper is trusted only by name, as a value.
 */
type Bound = { names: string[]; wrappers: string[]; defaults: string[] };

function bindingsOf(statement: string, kind: RunnerInfo["kind"]): Bound | "invalid" | "runs" | undefined {
  const named = (list: string, rename: RegExp, dataModule: boolean): Bound | "invalid" => {
    const out: Bound = { names: [], wrappers: [], defaults: [] };
    const specs = list.split(",").map((x) => x.trim());
    if (specs.length > 1 && specs[specs.length - 1] === "") specs.pop(); // one trailing comma
    for (const spec of specs) {
      const m = rename.exec(spec);
      if (!m) return "invalid";
      if (m[1]) continue; // a `type` specifier binds no value
      const local = m[3] ?? m[2];
      out.names.push(local);
      if (m[2] === "defineConfig" || m[2] === "defineProject") out.wrappers.push(local);
      if (m[2] === "configDefaults" && dataModule) out.defaults.push(local);
    }
    return out;
  };
  if (/^import(?=[\s{*'"])/.test(statement)) {
    const m = NAMED_IMPORT.exec(statement);
    if (!m || !WRAPPER_MODULES[kind].includes(m[3])) return "runs";
    return named(m[1], new RegExp(`^(type\\s+)?(${ID})(?:\\s+as\\s+(${ID}))?$`), DEFAULTS_MODULES.includes(m[3]));
  }
  const r = REQUIRE.exec(statement);
  if (!r || !WRAPPER_MODULES[kind].includes(r[3])) return undefined;
  return named(r[1], new RegExp(`^()(${ID})(?:\\s*:\\s*(${ID}))?$`), DEFAULTS_MODULES.includes(r[3]));
}

/**
 * D-2102 add.37: whether `value` is PURE DATA, read with a small strict grammar — string, number, boolean and
 * null literals, a template with no `${`, `process.env.<NAME>`, an identifier naming an earlier pure-data
 * const, arrays of pure data, and objects whose every member is `<plain identifier | string>: <pure data>`
 * with each key once, at every level. Nothing else reads: no call, `new`, function or arrow, operator but a
 * unary minus on a number, `this`, `arguments`, spread, computed key, getter, method, shorthand or `__proto__`.
 * ponytail: the declared cost — a config that calls anything beyond the runner's own defineConfig or
 * defineProject (a plugin, a helper, a ternary on the environment) warns, queue row 208.
 */
function pureData(value: string, consts: ReadonlySet<string>, defaults: ReadonlySet<string> = new Set()): boolean {
  let i = 0;
  const ws = (): void => { while (i < value.length && /\s/.test(value[i])) i++; };
  const take = (re: RegExp): RegExpExecArray | null => {
    const m = re.exec(value.slice(i));
    if (m) i += m[0].length;
    return m;
  };
  let path: string[] = [];
  const list = (close: string, item: () => boolean): boolean => {
    i++;
    ws();
    if (value[i] === close) { i++; return true; }
    for (;;) {
      if (!item()) return false;
      ws();
      if (value[i] === ",") { i++; ws(); if (value[i] === close) { i++; return true; } continue; }
      if (value[i] === close) { i++; return true; }
      return false;
    }
  };
  const datum = (): boolean => {
    ws();
    const c = value[i];
    if (c === '"' || c === "'") return take(/^(["'])(?:\\[\s\S]|(?!\1)[^\\\n\r])*\1/) !== null;
    if (c === "`") return take(/^`(?:\\[\s\S]|[^\\`$]|\$(?!\{))*`/) !== null;
    if (c === "[") {
      // The one spread pure data admits: Vitest's own default excludes, as an element of test.exclude, from a
      // configDefaults bound by a named import of "vitest/config" or "vitest" (the docs' own spelling).
      const inExclude = path.join(".") === "test.exclude";
      return list("]", () => {
        ws();
        const spread = inExclude ? /^\.\.\.\s*([A-Za-z_$][\w$]*)\.exclude(?![\w$.([])/.exec(value.slice(i)) : null;
        if (spread && defaults.has(spread[1])) { i += spread[0].length; return true; }
        return datum();
      });
    }
    if (c === "{") {
      const seen = new Set<string>();
      return list("}", () => {
        ws();
        const k = take(/^(?:([A-Za-z_$][\w$]*)|(["'])((?:\\[\s\S]|(?!\2)[^\\\n\r])*)\2)\s*:/);
        if (!k) return false;
        const key = k[1] ?? decodeString(k[3]);
        if (key === undefined || key === "__proto__" || seen.has(key)) return false;
        seen.add(key);
        const outer = path;
        path = [...outer, key];
        const ok = datum();
        path = outer;
        return ok;
      });
    }
    if (take(/^-?(?:0[xX][\da-fA-F](?:_?[\da-fA-F])*|0[oO][0-7](?:_?[0-7])*|0[bB][01](?:_?[01])*|(?:\d(?:_?\d)*)?\.?\d(?:_?\d)*(?:[eE][+-]?\d+)?)n?(?![\w$.])/)) return true;
    const word = /^(?:process\.env\.[A-Za-z_$][\w$]*|[A-Za-z_$][\w$]*)(?![\w$.([`])/.exec(value.slice(i))?.[0];
    if (word && (["true", "false", "null"].includes(word) || word.startsWith("process.env.") || consts.has(word))) { i += word.length; return true; }
    return false;
  };
  if (!datum()) return false;
  ws();
  return i === value.length;
}

/**
 * The top-level statements of a (comment-blanked) module: each ends at a `;` or a line break outside
 * strings and brackets, unless the line ends in an operator or the next one continues the expression.
 */
function topLevel(text: string): { start: number; text: string }[] {
  const out: { start: number; text: string }[] = [];
  let [depth, start] = [0, -1];
  const end = (at: number) => {
    const raw = text.slice(start, at);
    if (raw.trim()) out.push({ start: start + raw.length - raw.trimStart().length, text: raw.trim() });
    start = -1;
  };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (start < 0) {
      if (/[\s;]/.test(c)) continue;
      start = i;
    }
    if (c === '"' || c === "'" || c === "`") {
      for (i++; i < text.length && text[i] !== c; i++) if (text[i] === "\\") i++;
    } else if ("([{".includes(c)) depth++;
    else if (")]}".includes(c)) depth--;
    else if (depth === 0 && c === ";") end(i);
    else if (depth === 0 && LINE_END.test(c) && !/[-=+*/%&|^!?:,.<>([{]$/.test(text.slice(start, i).trimEnd())
      && !/^(?:[-.?:&|+*/%=,<>()[\]{}`]|as\b|satisfies\b|in\b|instanceof\b)/.test(text.slice(i + 1).trimStart())) end(i);
  }
  if (start >= 0) end(text.length);
  return out;
}

/**
 * D-2102 add.22: the offset of the exported config object when the file is SIMPLE AND STATIC, else why
 * not. The top level holds only imports, type-only declarations and exactly one export (`export default`
 * or `module.exports =`) of a supported literal — an object, or defineConfig/defineProject around one — or
 * of one binding declared to such a literal; a TypeScript config is read with its types already erased. `module`, `exports` and that
 * binding occur nowhere else, so no alias, bracket access or later assignment can change what the read saw.
 */
type Exported = { open: number; wrappers: Wrappers; defaults: ReadonlySet<string> };

function staticExport(text: string, json: boolean, kind: RunnerInfo["kind"]): Exported | string {
  const wrappers = new Set<string>();
  const defaults = new Set<string>();
  const literal = (value: string, start: number): Exported | string => {
    const open = objectIn(value, start, wrappers);
    return typeof open === "number" ? { open, wrappers, defaults } : open === NOT_ONE_OBJECT ? `the export ${NOT_ONE_OBJECT}` : open;
  };
  if (json) {
    const open = objectIn(text.trim(), text.search(/\S/), wrappers);
    return typeof open === "number" ? { open, wrappers, defaults } : `the config ${NOT_ONE_OBJECT}`;
  }
  // D-2102 add.35, a whitelist: the top level holds only imports in the strict grammar (type-only included),
  // at most one `const { … } = require(<the runner's module>)`, `const <ident>[: T] = <expr>` lines, and EXACTLY
  // ONE export of an object or an identity wrapper around one, directly or through one such const. Any other
  // statement — let or var, a function or class, an expression, a second export, exports.default,
  // `export { x as default }`, a reassignment — reads unverifiable.
  const other = RUNS;
  let exported: { start: number; value: string; cjs: boolean } | undefined;
  const consts = new Map<string, { start: number; value: string }>();
  const bound = new Map<string, number>(); // every value name a top-level statement binds, and how often
  const values: string[] = []; // every expression a top-level statement evaluates
  let requires = 0;
  for (const { start, text: t } of topLevel(text)) {
    const b = bindingsOf(t, kind);
    if (b === "invalid") return "invalid syntax";
    if (b === "runs") return RUNS;
    if (b) {
      for (const name of b.names) bound.set(name, (bound.get(name) ?? 0) + 1);
      for (const name of b.wrappers) wrappers.add(name);
      if (kind === "vitest") for (const name of b.defaults) defaults.add(name);
      if (!/^import/.test(t)) {
        if (++requires > 1) return "the config requires the runner's module more than once";
        values.push(t.slice(t.indexOf("=") + 1));
      }
      continue;
    }
    const exp = /^(?:export\s+default|(module)\.exports\s*=)\s*/.exec(t);
    const decl = /^const\s+([A-Za-z_$][\w$]*)\s*=\s*/.exec(t);
    if (exp) {
      if (exported) return "the config exports more than once";
      exported = { start: start + exp[0].length, value: t.slice(exp[0].length), cjs: exp[1] !== undefined };
      values.push(exported.value);
    } else if (decl) {
      consts.set(decl[1], { start: start + decl[0].length, value: t.slice(decl[0].length) });
      bound.set(decl[1], (bound.get(decl[1]) ?? 0) + 1);
      values.push(t.slice(decl[0].length));
    } else return other;
  }
  if (!exported) return "the config has no export";
  // Wrapper trust through require holds only for the unbound CommonJS global, so a file that binds require,
  // module or exports itself — or binds any name twice — is unread.
  const shadow = ["require", "module", "exports"].find((name) => bound.has(name));
  if (shadow) return `the config binds its own ${shadow}`;
  const twice = [...bound].find(([, n]) => n > 1)?.[0];
  if (twice) return `the config binds ${twice} more than once`;
  const id = /^[A-Za-z_$][\w$]*$/.exec(exported.value.trim())?.[0];
  const value = id ? consts.get(id) : exported;
  if (!value) return `the export of ${id}`;
  // Balanced brackets are not syntax: every evaluated expression must compile as JavaScript (compiled, never
  // run). A TypeScript config arrives here with its types already erased to whitespace (D-2102 add.39, see
  // realParse), so no TypeScript form is skipped or stripped by hand.
  for (const v of values) {
    try { new Script(`(${v}\n)`); } catch { return "invalid syntax"; }
  }
  // D-2102 add.37: the exported config is pure data — every const, and the export itself (or the one argument
  // of an identity wrapper around it), read with the pure-data grammar; a const may name only earlier consts.
  const earlier = new Set<string>();
  for (const [name, c] of consts) {
    if (!pureData(c.value, earlier, name === id ? defaults : undefined)) return RUNS;
    earlier.add(name);
  }
  const shown = exported.value;
  const call = /^([A-Za-z_$][\w$]*)\(([\s\S]*)\)$/.exec(shown);
  if (call && !wrappers.has(call[1])) return `the call ${call[1]}(…) is not an identity wrapper imported from the runner`;
  if (!pureData(call ? call[2] : shown, earlier, defaults)) return RUNS;
  return literal(value.value, value.start);
}

// D-2102 add.33: the jest ignore entries doctor judges, by a whitelist — ANCHORED: one leading <rootDir>, then
// only [A-Za-z0-9_./-] or "\." and no ".." segment (so "<rootDir>/.next/" reads); LITERAL: no <rootDir>, only
// [A-Za-z0-9_/-] or "\." (a bare "." is a wildcard). Every other entry is opaque and leaves the config unread.
const ANCHORED_ENTRY = /^<rootDir>(?:[A-Za-z0-9_./-]|\\\.)*$/;
const LITERAL_ENTRY = /^(?:[A-Za-z0-9_/-]|\\\.)*$/;
const judged = (entry: string): boolean =>
  (ANCHORED_ENTRY.test(entry) && !/(?:^|\/)\.\.(?:\/|$)/.test(entry.slice("<rootDir>".length))) || LITERAL_ENTRY.test(entry);
// The exact unanchored spellings the SentioQ run-2 shape used (Q130s), which --fix replaces with the canonical twin.
const POISON: Record<Dir, RegExp> = { state: /^\/?\\?\.tickmarkr\/?$/, session: /^\/?\\?\.claude\/worktrees\/?$/ };
const WORKTREE_DIRS: Record<Dir, string> = { state: ".tickmarkr/worktrees.noindex", session: ".claude/worktrees" };
const PROBE = "tkr-doctor-probe";

/** Jest's reading of an ignore entry under `rootDir`: a leading <rootDir> resolved as jest-config does, then a RegExp. */
const jestIgnore = (entry: string, rootDir: string): RegExp =>
  new RegExp(entry.startsWith("<rootDir>") ? resolve(rootDir, normalize(`./${entry.slice("<rootDir>".length)}`)) : entry);

/**
 * D-2102 add.33: the first ignore entry that SELF-MATCHES (Q130s), found by executing it as jest reads it — it
 * matches a probe suite inside a run or session worktree, rooted there, but not the same suite in the main
 * checkout at `root` (probed at src/ and, for a literal, along its own tail: add.34, see literalTails). It
 * classifies the ignore list only; it never claims what the runner collects.
 * ponytail: residual — a literal keyed on a worktree NAME that does not exist yet is not probed (queue row
 * 208); the names probed are a fixed one plus every directory present under each worktree root.
 */
function selfMatching(entries: string[], root: string): { pattern: string; dir: Dir } | undefined {
  const file = `${PROBE}.test.ts`;
  for (const pattern of entries) {
    for (const dir of DIRS) {
      if (POISON[dir].test(pattern)) return { pattern, dir };
      const base = join(root, WORKTREE_DIRS[dir]);
      let present: string[] = [];
      try { present = readdirSync(base, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name); } catch { /* none yet */ }
      for (const name of [PROBE, ...present]) {
        const tree = join(base, name);
        try {
          for (const rel of [`src/${file}`, ...literalTails(pattern, `${tree}/`, root, file)]) {
            if (jestIgnore(pattern, tree).test(`${tree}/${rel}`) && !jestIgnore(pattern, root).test(`${root}/${rel}`)) return { pattern, dir };
          }
        } catch { return { pattern, dir }; } // a root path that does not compile as a regex: judged self-matching
      }
    }
  }
  return undefined;
}

/**
 * D-2102 add.34: the probe paths a LITERAL entry's own tail builds — wherever the end of `tree` (with its "/")
 * begins the literal and that occurrence reaches past `root`, the rest of the literal becomes the path below
 * the tree, so an entry like "worktrees/feature-x/test/" is probed at feature-x/test/ and not only at src/.
 */
function literalTails(pattern: string, tree: string, root: string, file: string): string[] {
  if (pattern.startsWith("<rootDir>")) return [];
  const literal = pattern.replace(/\\\./g, ".");
  const out: string[] = [];
  for (let i = 0; i < tree.length; i++) {
    const tail = tree.slice(i);
    if (literal.length > tail.length && literal.startsWith(tail) && i + literal.length > root.length) out.push(`${literal.slice(tail.length)}${file}`);
  }
  return out;
}

/**
 * D-2102 add.22 and add.29: why the source is not one clean parse, else undefined — a "/" outside strings
 * and comments (a regex literal or a division: doctor parses neither), an unclosed string or comment, a
 * template with a substitution, or an unmatched or unclosed bracket. The end of the file never closes anything.
 */
function unclean(text: string): string | undefined {
  const stack: string[] = [];
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (text.startsWith("//", i)) i = lineEnd(text, i); else if (text.startsWith("/*", i)) {
      const end = text.indexOf("*/", i + 2);
      if (end < 0) return "an unclosed comment";
      i = end + 1;
    } else if (c === "/") return "a / outside strings and comments (a regex literal or a division)";
    else if (c === "\\") return RUNS; // D-2102 add.37: an escaped identifier spells a name doctor would not see
    else if (c === '"' || c === "'" || c === "`") {
      let j = i + 1;
      for (; j < text.length && text[j] !== c; j++) {
        if (text[j] === "\\") j++;
        else if (c !== "`" && LINE_END.test(text[j])) return "an unclosed string";
        else if (c === "`" && text.startsWith("${", j)) return "a template literal with a substitution";
      }
      if (j >= text.length) return "an unclosed string";
      i = j;
    } else if ("([{".includes(c)) stack.push(c);
    else if (")]}".includes(c) && stack.pop() !== "([{"[")]}".indexOf(c)]) return "an unmatched closing bracket";
  }
  return stack.length ? "an unclosed bracket" : undefined;
}

/**
 * The config's own literal ignore list (D-2102 add.30) — jest testPathIgnorePatterns, vitest test.exclude —
 * located through a clean parse of a simple static file, or why doctor could not read it. `entries` is
 * undefined when the config sets no list (the runner's default, which holds neither canonical entry);
 * `target` is the literal array and `top` the exported object, for the writer.
 */
type IgnoreList = {
  file: string; key: string; json: boolean; unreadable?: string; entries?: string[]; target?: Member; top?: number; open?: number;
  /** the configDefaults bindings whose `.exclude` spread the vitest exclude may hold */
  defaults?: ReadonlySet<string>;
  /** a jest ignore entry that self-matches inside a run or session worktree (D-2102 add.33) */
  floating?: { pattern: string; dir: Dir };
};

// D-2102 add.37 and add.39: the one child that reads the source on stdin, erases TypeScript types (when this Node
// has stripTypeScriptTypes; its default strip mode replaces each type with whitespace, so offsets stay put) and
// parses the result as a module (vm.SourceTextModule, never linked or evaluated), then as a script (vm.Script,
// never run), reporting {"ok":true,"text":<stripped>} or {"ok":false,"why":"no-strip"|"syntax"} on stdout. It
// runs with --no-warnings, so 22.x's ExperimentalWarning never reaches doctor's output; no temp file is written.
const PARSE_CHILD = `(() => {
  const fs = require("node:fs"), vm = require("node:vm"), mod = require("node:module");
  const [ext, strip] = process.argv.slice(1);
  const out = (r) => process.stdout.write(JSON.stringify(r));
  let code = fs.readFileSync(0, "utf8");
  if (/^\\.(?:m|c)?ts$/.test(ext)) {
    if (strip === "absent" || typeof mod.stripTypeScriptTypes !== "function") return out({ ok: false, why: "no-strip" });
    try { code = mod.stripTypeScriptTypes(code); } catch { return out({ ok: false, why: "syntax" }); }
  }
  let parsed = false;
  if (typeof vm.SourceTextModule === "function") {
    try { new vm.SourceTextModule(code); parsed = true; } catch {}
  }
  if (!parsed) {
    try { new vm.Script(code); parsed = true; } catch {}
  }
  out(parsed ? { ok: true, text: code } : { ok: false, why: "syntax" });
})()`;
// ponytail: verdicts are memoized by exact bytes (and extension and seam), so one doctor run's reads before and
// after a repair, and its re-reads of unchanged bytes, parse once; the memo is dropped past 64 entries.
const parsed = new Map<string, { text: string } | { why: string }>();

/** D-2102 add.39: the seams for a Node without stripTypeScriptTypes, and for a child that does not answer in time. */
export type ParseSeam = { strip?: "absent"; timeoutMs?: number };

/**
 * D-2102 add.37 and add.39: the config's text with its TypeScript types erased (offsets unchanged), once a real
 * parser accepts it — or why not. The source reaches PARSE_CHILD on stdin through process.execPath with no shell
 * and no temp file. A spawn error, a timeout, a non-zero exit, a missing or malformed answer, or erased text of
 * another length reads "doctor could not check <file>'s syntax"; a TypeScript config on a Node without
 * stripTypeScriptTypes (below 22.13) reads unverifiable; nothing here throws.
 */
export function realParse(source: string, configPath: string, seam: ParseSeam = {}): { text: string } | { why: string } {
  const ext = extname(configPath) || ".js";
  const key = `${seam.strip ?? ""}\0${seam.timeoutMs ?? ""}\0${ext}\0${source}`;
  const hit = parsed.get(key);
  if (hit) return hit;
  const unchecked = { why: `doctor could not check ${configPath}'s syntax` };
  let result: { text: string } | { why: string } = unchecked;
  try {
    const r = spawnSync(process.execPath, ["--no-warnings", "--experimental-vm-modules", "-e", PARSE_CHILD, ext, seam.strip ?? "auto"], {
      input: source, encoding: "utf8", env: {}, timeout: seam.timeoutMs ?? 10_000, maxBuffer: 4 * (source.length + 1024 * 1024), shell: false,
    });
    let verdict: { ok?: unknown; why?: unknown; text?: unknown } | undefined;
    try { verdict = JSON.parse(r.stdout ?? "") as typeof verdict; } catch { verdict = undefined; }
    if (r.error || r.status !== 0 || !verdict) result = unchecked;
    else if (verdict.ok === true && typeof verdict.text === "string") result = verdict.text.length === source.length ? { text: verdict.text } : unchecked;
    else if (verdict.why === "no-strip") result = { why: "this Node has no stripTypeScriptTypes to read a TypeScript config" };
    else if (verdict.why === "syntax") result = { why: "invalid syntax" };
  } catch {
    result = unchecked;
  }
  if (parsed.size >= 64) parsed.clear();
  parsed.set(key, result);
  return result;
}

// Out of claim (D-2102 add.30, add.35, queue row 207): a Vite plugin's config hook and a jest preset change what
// the runner resolves, not the config's own literal list, so this reader neither follows nor warns on them.
function ignoreList(cwd: string, runner: RunnerInfo): IgnoreList {
  const isJest = runner.kind === "jest";
  let pkg: { jest?: unknown } = {};
  try { pkg = JSON.parse(readText(cwd, "package.json").text || "{}") as typeof pkg; } catch { /* judged by detectRunner */ }
  const config = runner.configPath ? readText(cwd, runner.configPath) : { text: isJest && pkg.jest ? JSON.stringify(pkg.jest) : "" };
  const source = config.text;
  const json = !runner.configPath || runner.configPath.endsWith(".json");
  const base = { file: runner.configPath ?? (isJest ? "the package.json jest block" : "a vitest config"), key: CANONICAL[runner.kind].ignore, json };
  const unreadable = (why: string): IgnoreList => ({ ...base, unreadable: why });
  if (config.error) return unreadable(config.error);
  // D-2102 add.22: another file the runner may read instead of, or beside, this one.
  const present = (stem: string): string[] => ["ts", "mts", "cts", "js", "mjs", "cjs", "json"].map((e) => `${stem}.${e}`).filter((f) => existsSync(join(cwd, f)));
  const external = isJest ? [] : [...present("vitest.workspace"), ...present("vitest.projects")];
  if (external.length) return unreadable(`${external[0]} declares projects beside it`);
  const configs = isJest ? [...present("jest.config"), ...(pkg.jest !== undefined ? ["the package.json jest block"] : [])] : present("vitest.config");
  if (configs.length > 1) return unreadable(`${configs.join(" and ")} both configure ${runner.kind}`);
  if (!source.trim()) return base; // no config: the runner's default list
  // D-2102 add.32: a JSON config is read only once JSON.parse accepts it — jest reads it with JSON.parse.
  if (json) {
    try { JSON.parse(source); } catch { return unreadable("invalid JSON"); }
  }
  // D-2102 add.39: a TypeScript config is read only through its type-erased text (same offsets, so the writer
  // edits the original bytes in place); a JavaScript one is read as written and parsed for real last.
  const path = runner.configPath ?? "config.js";
  const ts = /\.(?:m|c)?ts$/.test(path);
  const erased = ts ? realParse(source, path) : undefined;
  if (erased && "why" in erased) return unreadable(erased.why);
  const plain = erased?.text ?? source;
  const dirty = unclean(plain);
  if (dirty) return unreadable(dirty);
  const text = blankComments(plain);
  const exported = staticExport(text, json, runner.kind);
  if (typeof exported === "string") return unreadable(exported);
  if (!json && !ts) {
    const parse = realParse(source, path);
    if ("why" in parse) return unreadable(parse.why);
  }
  const top = exported.open;
  // Projects carry their own ignore lists, which the config's own list does not speak for.
  const read = (open: number, keys: string[], what: string, key: string, form: "regex" | "path"): IgnoreList => {
    const s = settingsOf(text, open, keys, what);
    if (s.computed) return unreadable(s.computed);
    if (s.get("projects") ?? s.get("workspace")) return unreadable("it declares projects, each with its own ignore list");
    const target = s.get(key);
    const entries = literalList(target?.value, form, isJest ? undefined : exported.defaults);
    if (typeof entries === "string") return unreadable(unreadableList(entries, base.key) ?? entries);
    if (!isJest) return { ...base, entries, target, top, open, defaults: exported.defaults };
    // D-2102 add.32 and add.33: an entry outside the whitelist can spell a worktree directory without its
    // letters in a row (a class, a group, a bare-dot wildcard), so a config holding one is unread while it
    // stays; the canonical entries are anchored. The exact SentioQ spellings stay judged, so --fix replaces them.
    const opaque = (entries ?? []).find((e) => !judged(e) && !POISON.state.test(e) && !POISON.session.test(e));
    if (opaque !== undefined) return unreadable(`testPathIgnorePatterns entry ${JSON.stringify(opaque)} holds regex syntax doctor does not read`);
    // D-2102 add.33: a rootDir other than the config's own directory re-roots <rootDir>, canonical entries included.
    const rootDir = literalList(s.get("rootDir")?.value);
    if (typeof rootDir === "string" || (rootDir && (rootDir.length !== 1 || !/^(?:\.\/?|<rootDir>\/?)$/.test(rootDir[0])))) {
      return unreadable(typeof rootDir === "string" ? "rootDir is not a literal, so doctor cannot tell whether it re-roots <rootDir>"
        : `rootDir ${JSON.stringify(rootDir.join(", "))} re-roots <rootDir> away from ${base.file}'s own directory`);
    }
    let root = cwd;
    try { root = realpathSync(cwd); } catch { /* judged from cwd as given */ }
    return { ...base, entries, target, top, open, floating: selfMatching(entries ?? [], root) };
  };
  if (isJest) return read(top, ["testPathIgnorePatterns", "projects", "rootDir"], "the config", "testPathIgnorePatterns", "regex");
  const outer = settingsOf(text, top, ["test"], "the config");
  if (outer.computed) return unreadable(outer.computed);
  const test = outer.get("test");
  if (!test) return { ...base, entries: undefined, top };
  const open = objectIn(test.value, test.start, exported.wrappers);
  if (typeof open === "string") return unreadable(open === NOT_ONE_OBJECT ? `test ${NOT_ONE_OBJECT}` : open);
  return { ...read(open, ["exclude", "projects", "workspace"], "test", "exclude", "path"), top };
}

export function runnerIgnoreFinding(cwd: string): { verdict: "pass" | "warn"; detail: string } | undefined {
  const runner = detectRunner(cwd);
  if (!runner) return undefined;
  const name = runner.kind;
  const quoted = (d: Dir): string => JSON.stringify(CANONICAL[name][d]);
  const list = ignoreList(cwd, runner);
  const where = `${list.key} in ${list.file}`;
  if (list.unreadable) {
    return { verdict: "warn", detail: `doctor could not read ${list.file} (${list.unreadable}); add ${quoted("session")} to ${list.key}, with ${quoted("state")} beside it` };
  }
  // Q130s, and queue row 197 for the session worktree: a run started inside a worktree carries the
  // directories above the checkout in every absolute test path.
  const float = list.floating;
  if (float) {
    const what = float.dir === "state" ? ".tickmarkr/" : ".claude/worktrees/";
    return {
      verdict: "warn",
      detail: `jest ignore for ${what} is not <rootDir>-anchored: ${JSON.stringify(float.pattern)} — testPathIgnorePatterns are regexes against ABSOLUTE paths, so ${INSIDE[float.dir]} it matches the checkout's own suites and the test gate fails closed; use ${quoted("state")} and ${quoted("session")} in ${where}`,
    };
  }
  const missing = DIRS.filter((d) => !(list.entries ?? []).includes(CANONICAL[name][d]));
  if (missing.length) {
    const [first, second] = missing.map(quoted);
    return {
      verdict: "warn",
      detail: `${where} does not carry ${missing.map(quoted).join(" or ")}, so ${name} may scan ${missing.map((d) => SCANS[d]).join(" and ")} (duplicate suites, false reds) — add ${first} to ${where}${second ? `, with ${second} beside it` : ""}`,
    };
  }
  return { verdict: "pass", detail: `${where} carries ${quoted("session")} beside ${quoted("state")} — doctor reads this literal list only and does not prove what ${name} collects` };
}

/**
 * Q134s (doctor --fix): the WRITE half of Q122s/Q130s. Doctor's advisory row cost two
 * repos a hand-edit (SentioQ run 2 paid a whole run first); --fix applies the ignore
 * where a safe textual edit exists and refuses loudly otherwise.
 *
 * Safety contract (queue row 197; D-2102 add.8 and add.30): the canonical entries the config's own literal
 * ignore list lacks go into that array as complete string-literal elements (never a coverage array or a
 * scalar), beside the state dir's canonical entry, else first; a jest element that is exactly an unanchored
 * entry for either directory (the SentioQ run-2 shape) is replaced by its canonical twin; a jest config with
 * no testPathIgnorePatterns gets the property, preserving jest's default /node_modules/ ignore, as before
 * this change (a JSON config with its key quoted), and a vitest config without test.exclude gets one that
 * keeps Vitest 3.2.7's default excludes ahead of the two entries — inside a new test object where it has
 * none (D-2102 add.31). A config doctor could not read or any other element is manual with the file
 * byte-unchanged. The write is verified by
 * re-running the same rule on the written file (and JSON.parse for a .json config); a write that does not
 * turn the row green is REVERTED byte-for-byte and reported as manual. Never touches package.json.
 */
export function applyRunnerIgnore(cwd: string): { action: "none" | "wrote" | "manual"; detail: string } {
  const finding = runnerIgnoreFinding(cwd);
  if (!finding) return { action: "none", detail: "no recognized test runner" };
  if (finding.verdict === "pass") return { action: "none", detail: finding.detail };
  const runner = detectRunner(cwd);
  const manual = { action: "manual" as const, detail: finding.detail };
  // package.json jest block, or a runner detected only via the test script: hand edit.
  if (!runner?.configPath) return manual;
  const list = ignoreList(cwd, runner);
  if (list.unreadable) return manual;
  const kind = runner.kind;
  const canon = CANONICAL[kind];
  const file = join(cwd, runner.configPath);
  const read = readText(cwd, runner.configPath);
  if (read.error) return manual;
  const original = read.text;
  const edits: { at: number; remove: number; insert: string }[] = [];
  const entries = (...values: string[]): string => `[${values.map((v) => JSON.stringify(v)).join(", ")}]`;
  /** Insert `member` first in the object literal opened at `open`, in the object's own layout. */
  const addMember = (open: number, member: string): void => {
    const lead = /^\s*/.exec(original.slice(open + 1))?.[0] ?? "";
    const empty = original[open + 1 + lead.length] === "}";
    const gap = /[\n\r]/.test(lead) ? lead.replace(/^[^\n\r]*/, "") : " ";
    edits.push({ at: open + 1, remove: 0, insert: `${gap}${member}${empty ? "" : ","}` });
  };
  const target = list.target;
  if (target) {
    const elements = arrayElements(target.value);
    if (!elements?.every((e) => STRING_LITERAL.test(e.text) || defaultsSpread(e.text, list.defaults ?? new Set()))) return manual;
    const at = (i: number): number => target.start + elements[i].start;
    const values = elements.map((e) => {
      const value = STRING_LITERAL.test(e.text) ? decodeString(e.text.slice(1, -1)) : undefined;
      if (kind !== "jest" || value === undefined) return value;
      return POISON.state.test(value) ? canon.state : POISON.session.test(value) ? canon.session : value;
    });
    values.forEach((v, i) => {
      if (v !== undefined && v !== decodeString(elements[i].text.slice(1, -1))) edits.push({ at: at(i), remove: elements[i].text.length, insert: JSON.stringify(v) });
    });
    const add = DIRS.filter((d) => !values.includes(canon[d])).map((d) => JSON.stringify(canon[d])).join(", ");
    const state = values.indexOf(canon.state);
    if (add) {
      edits.push(state >= 0 ? { at: at(state) + elements[state].text.length, remove: 0, insert: `, ${add}` }
        : elements.length ? { at: at(0), remove: 0, insert: `${add}, ` }
        : { at: target.start + 1, remove: 0, insert: add });
    }
  } else if (kind === "jest" && list.top !== undefined) {
    // No ignore property: add it whole, preserving jest's default /node_modules/ ignore (the 2.8.4 repair;
    // a JSON config gets the quoted key, D-2102 add.31).
    addMember(list.top, `${list.json ? '"testPathIgnorePatterns"' : "testPathIgnorePatterns"}: ${entries("/node_modules/", canon.state, canon.session)}`);
  } else if (kind === "vitest" && list.top !== undefined) {
    // No test.exclude (D-2102 add.31): add it, keeping Vitest's own defaults ahead of the two entries; with
    // no test object at all, add that.
    const exclude = `exclude: ${entries(...VITEST_DEFAULT_EXCLUDE, canon.state, canon.session)}`;
    if (list.open !== undefined) addMember(list.open, exclude);
    else addMember(list.top, `test: { ${exclude} }`);
  }
  if (!edits.length) return manual; // no safe target, or a self-match no canonical entry can fix
  // Last offset first; at one offset the replacement precedes the insertion before it.
  const text = [...edits].sort((a, b) => b.at - a.at || b.remove - a.remove)
    .reduce((t, e) => t.slice(0, e.at) + e.insert + t.slice(e.at + e.remove), original);
  let after: ReturnType<typeof runnerIgnoreFinding>;
  try {
    writeFileSync(file, text);
    if (runner.configPath.endsWith(".json")) JSON.parse(text);
    after = runnerIgnoreFinding(cwd);
  } catch { after = undefined; }
  if (after?.verdict === "pass") return { action: "wrote", detail: `wrote ${runner.configPath} — ${after.detail}` };
  try { writeFileSync(file, original); } catch { /* the write itself failed, so the file is unchanged */ } // verify failed: never leave a half-fix behind
  return manual;
}

type EnvLike = NodeJS.ProcessEnv | Record<string, string | undefined>;

/**
 * Queue row 196 (D-2102 add.1): the host decides where seats run. herdr or Orca markers (classifyHost)
 * name that driver; with neither, seats run headless on the subprocess driver with no daemon board.
 * Only the exact claude-desktop entry point names Claude Desktop — a cli entry point is a terminal seat
 * and no Claude variable alone is a host. Panes configured where no pane host exists cannot be honored.
 */
export function hostRows(env: EnvLike, llm: "pane" | "headless"): { verdict: "pass" | "warn"; key: string; detail: string }[] {
  const host = classifyHost(env as NodeJS.ProcessEnv);
  if (host !== "none") {
    return [{ verdict: "pass", key: "host", detail: `${host === "herdr" ? "herdr" : "Orca"} — auto selects the ${host} driver` }];
  }
  const name = env.CLAUDE_CODE_ENTRYPOINT === "claude-desktop" ? "Claude Desktop" : "no herdr or Orca host";
  return [
    { verdict: "pass", key: "host", detail: `${name} — seats run headless on the subprocess driver with no daemon board` },
    ...(llm === "pane"
      ? [{ verdict: "warn" as const, key: "visibility", detail: "visibility.llm is pane, but panes cannot be honored on this host — run under herdr or Orca, or set visibility.llm: headless" }]
      : []),
  ];
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
 * ponytail: the listing itself is never fetched; the operator (or RELEASING.md's release-time
 * check) reads it and bumps the constant.
 */
export function liveBenchStalenessFinding(now: Date): string | undefined {
  const pinnedMs = Date.parse(`${LIVEBENCH_TABLE_DATE.replace(/_/g, "-")}T00:00:00Z`);
  const days = Math.floor((now.getTime() - pinnedMs) / 86_400_000);
  if (!Number.isFinite(days) || days <= LIVEBENCH_TABLE_MAX_AGE_DAYS) return undefined;
  return `LiveBench table pinned at ${LIVEBENCH_TABLE_DATE} is ${days} days old (>${LIVEBENCH_TABLE_MAX_AGE_DAYS}d) — list ${LIVEBENCH_RELEASES_URL} for a newer table_<date>.csv and bump LIVEBENCH_TABLE_DATE (advisory — tickmarkr never fetches that listing)`;
}

type ConfiguredModel = { adapter: string; model: string };

// Registry owns the shared pure scope so cache readers do not load CLI diagnostics.
export { probeScope, type ProbeScopeOpts } from "../../adapters/registry.js";

function probeScopeArgs(argv: string[]): ProbeScopeOpts {
  const opts: ProbeScopeOpts = { all: argv.includes("--all") };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i].split("=", 1)[0];
    if (flag !== "--adapter" && flag !== "--model") continue;
    const value = argv[i].includes("=") ? argv[i].slice(flag.length + 1) : argv[++i];
    if (!value || value.startsWith("--")) throw new Error(`doctor: ${flag} requires a value`);
    (opts[flag === "--adapter" ? "adapter" : "model"] ??= []).push(value);
  }
  return opts;
}

function configuredModels(cfg: ReturnType<typeof loadConfig>, adapters?: WorkerAdapter[]): ConfiguredModel[] {
  const allowed = adapters ? new Set(adapters.map((adapter) => adapter.id)) : undefined;
  return Object.entries(cfg.tiers).flatMap(([adapter, tier]) =>
    allowed && !allowed.has(adapter) ? [] :
    Object.keys(tier.models ?? {}).map((model) => ({ adapter, model })),
  );
}

function cacheAge(ageMs: number | null): string {
  return ageMs === null ? "unavailable" : `${Math.floor(ageMs / 60_000)}m`;
}

/**
 * A no-call disclosure for the action that normal doctor performs.  This is deliberately built
 * from config and cached identities: opening it never makes adapter or model calls.
 */
export function doctorProbePreflight(
  cwd = process.cwd(),
  cfg = loadConfig(cwd),
  adapters: WorkerAdapter[] = allAdapters(),
  opts: ProbeScopeOpts = {},
): string {
  const models = probeScope(cfg, opts, readDoctor(cwd)).filter((c) => adapters.some((a) => a.id === c.adapter));
  const scope = models.length
    ? models.map(({ adapter, model }) => `${adapter}:${model}`).join(", ")
    : "none (no configured models)";
  const state = stateDirName(cwd);
  return [
    "tickmarkr doctor — probe preflight:",
    `probe selection: ${opts.all ? "all configured models" : opts.adapter?.length || opts.model?.length ? "explicit adapter/model selection" : "routing-reachable channels plus review, consult and judge preferences"}`,
    `configured model-call scope: ${models.length} model${models.length === 1 ? "" : "s"} — ${scope}`,
    `cache policy: probing merges selected verdicts into ${state}/doctor.json, preserving other verdicts and their probedAt; each installed in-scope model receives one bounded call, with a serial retry only after a first failure (a prior timeout skips that retry)`,
    `affected destinations: ${state}/doctor.json (adapter and model verdict cache); temporary probe prompts are removed`,
    "catalog-only alternative: tickmarkr doctor --refresh-catalog refreshes the catalog cache without adapter or model probes",
  ].join("\n");
}

/**
 * Health surfaces use this cache-only reader.  It intentionally receives adapters only to render
 * their configured identities; it never invokes adapter.probe(), listModels(), or a model command.
 */
export function cachedDoctorDiagnostics(
  cwd = process.cwd(),
  adapters: WorkerAdapter[] = allAdapters(),
  cfg = loadConfig(cwd),
): string {
  const health = readDoctor(cwd);
  const age = doctorAgeMs(cwd);
  const configured = configuredModels(cfg, adapters);
  const state = stateDirName(cwd);
  const knownAdapters = new Set(adapters.map((adapter) => adapter.id));
  const rows = configured.map(({ adapter, model }) => {
    const cachedAdapter = health?.[adapter];
    const cachedModel = cachedAdapter?.modelAuth?.[model];
    const status = !health
      ? "unknown (cache unavailable)"
      : !knownAdapters.has(adapter)
        ? "unknown (adapter unavailable to this reader)"
        : !cachedAdapter
          ? "unknown (adapter absent from cache)"
          : !cachedAdapter.installed
            ? "unavailable (adapter not installed)"
            : !cachedAdapter.authed
              ? "unavailable (adapter not authenticated)"
              : !cachedModel
                ? "unknown (never probed)"
                : cachedModel.authed
                  ? `passed (cached ${cachedModel.probedAt})`
                  : `failed (cached ${cachedModel.reason ?? "probe failed"})`;
    return `  ${adapter}:${model} ${status}`;
  });
  return [
    "tickmarkr doctor — cached diagnostics:",
    `cache source: ${health ? `${state}/doctor.json` : "unavailable"}`,
    `cache age: ${cacheAge(age)}`,
    "cache policy: read-only; adapter and model probes were not called",
    ...(rows.length ? ["configured model status:", ...rows] : ["configured model status: none (no configured models)"]),
  ].join("\n");
}

const RUNNER_CONFIG_PATHS = [
  "jest.config.js",
  "jest.config.cjs",
  "jest.config.mjs",
  "jest.config.ts",
  "jest.config.json",
  "vitest.config.ts",
  "vitest.config.js",
  "vitest.config.mts",
  "vitest.config.mjs",
  "vitest.config.cts",
] as const;

function runnerConfigSnapshot(cwd: string): Map<string, string> {
  // An unreadable config is not snapshotted: the writer never edits a file it could not read (D-2102 add.31).
  return new Map(RUNNER_CONFIG_PATHS.flatMap((path) => {
    const read = readText(cwd, path);
    return existsSync(join(cwd, path)) && !read.error ? [[path, read.text] as const] : [];
  }));
}

function actualTextDiff(path: string, before: string, after: string): string {
  const oldLines = before.split("\n");
  const newLines = after.split("\n");
  let start = 0;
  while (start < oldLines.length && start < newLines.length && oldLines[start] === newLines[start]) start += 1;
  let oldEnd = oldLines.length;
  let newEnd = newLines.length;
  while (oldEnd > start && newEnd > start && oldLines[oldEnd - 1] === newLines[newEnd - 1]) {
    oldEnd -= 1;
    newEnd -= 1;
  }
  return [
    `--- ${path} (before)`,
    `+++ ${path} (after)`,
    ...oldLines.slice(start, oldEnd).map((line) => `-${line}`),
    ...newLines.slice(start, newEnd).map((line) => `+${line}`),
  ].join("\n");
}

/** Repair is an actuator, but never a reason to run the paid diagnostic sensor. */
export function doctorFixOnly(cwd = process.cwd()): string {
  const before = runnerConfigSnapshot(cwd);
  const finding = runnerIgnoreFinding(cwd);
  const repair = finding?.verdict === "warn"
    ? applyRunnerIgnore(cwd)
    : { action: "none" as const, detail: finding?.detail ?? "no recognized test runner" };
  const verified = runnerIgnoreFinding(cwd);
  const diffs = [...before].flatMap(([path, original]) => {
    const current = readText(cwd, path);
    return current.error || current.text === original ? [] : [actualTextDiff(path, original, current.text)];
  });
  const result = repair.action === "wrote" && verified?.verdict !== "pass"
    ? "invalid repair result (verification did not pass)"
    : `${repair.action} — ${repair.detail}`;
  return [
    "tickmarkr doctor --fix-only — repair-only:",
    "model probes: skipped (repair-only; adapters were not called)",
    "catalog: untouched",
    `repair result: ${result}`,
    `repair verification: ${verified?.verdict ?? "unavailable"}`,
    "repair diff:",
    ...(diffs.length ? diffs : ["(no runner-config bytes changed)" ]),
  ].join("\n");
}

export async function doctor(
  _argv: string[],
  cwd = process.cwd(),
  adapters: WorkerAdapter[] = allAdapters(),
  opts: DoctorOpts = {},
): Promise<string> {
  const scopeOpts = probeScopeArgs(_argv);
  if (_argv.includes("--fix-only")) return doctorFixOnly(cwd);
  if (_argv.includes("--cached") || _argv.includes("--cached-only")) {
    return cachedDoctorDiagnostics(cwd, adapters);
  }
  if (_argv.includes("--probe-preflight") || _argv.includes("--preflight")) {
    return doctorProbePreflight(cwd, loadConfig(cwd, { globalDir: opts.globalDir }), adapters, scopeOpts);
  }
  if (_argv.length === 1 && (_argv[0] === "--refresh-catalog" || _argv[0] === "--catalog-only")) {
    const refreshed = await refreshCatalogCommand({ repoRoot: cwd, fetcher: opts.catalogFetcher, now: opts.catalogNow });
    return refreshed.updated
      ? `tickmarkr doctor --refresh-catalog: model catalog refreshed — ${formatCatalogRefreshLegs(refreshed.legs)}${refreshed.warning ? `; ${refreshed.warning}` : ""}`
      : `tickmarkr doctor --refresh-catalog: catalog refresh unavailable — ${formatCatalogRefreshLegs(refreshed.legs)}${refreshed.warning ? `; ${refreshed.warning}` : ""}`;
  }
  // Operator directive 2026-08-12 (declutter): long per-model lists render only when asked for.
  const listAllModels = _argv.includes("--models");
  const cfg = loadConfig(cwd, { globalDir: opts.globalDir });
  const priorHealth = readDoctor(cwd);
  const scope = probeScope(cfg, scopeOpts, priorHealth);
  const explicitSelection = !!(scopeOpts.adapter?.length || scopeOpts.model?.length);
  if (explicitSelection && !scopeOpts.all) adapters = adapters.filter((a) => scope.some((c) => c.adapter === a.id));
  let catalog = opts.catalog ?? readCachedCatalog(cwd, { now: opts.catalogNow });
  let catalogRefreshLine: string | undefined;
  // RULING-222-17 reverses cache-only for these two operator-facing commands only. The refresh
  // remains age-guarded; compile, plan, and run never import this path.
  const catalogRefreshAllowed = process.env.VITEST !== "true"
    || opts.catalogFetcher !== undefined
    || opts.catalogNow !== undefined
    || globalThis.fetch !== initialFetch;
  if (!opts.catalog && catalog.stale && catalogRefreshAllowed) {
    const refreshed = await refreshCatalogCommand({
      repoRoot: cwd,
      fetcher: opts.catalogFetcher,
      timeoutMs: CATALOG_REFRESH_TIMEOUT_MS,
      now: opts.catalogNow,
    });
    catalog = refreshed.catalog;
    catalogRefreshLine = formatCatalogRefreshLegs(refreshed.legs);
  }
  // banner at START — the logo greets the operator before the ~60s probe wait, never trailing it (operator report 2026-07-17)
  if (opts.banner !== false && visual()) process.stdout.write(BANNER);
  // stderr, live: disclose the paid boundary before the first adapter/model call. The separate
  // --probe-preflight route exposes these same bytes without crossing that boundary.
  console.error(`${doctorProbePreflight(cwd, cfg, adapters, scopeOpts)}\nprobing installed agent CLIs — one short LLM call per in-scope model, may take a minute...`);
  const probeProgressTTY = process.stderr.isTTY === true;
  let health = await probeAll(adapters, { cwd });
  for (const [id, h] of Object.entries(health)) {
    // A missing or crashing CLI cannot refresh model probes. Its current absence supersedes
    // that history, allowing reuse to fall back to this report's mtime instead of staying stale.
    if (!h.installed) {
      delete h.modelAuth;
      continue;
    }
    // In-scope history must be replaced by this run's model verdicts. A skipped sweep
    // (including Kimi's auth/turn short-circuit) then falls back to the report's mtime,
    // while models outside the selection keep their verdicts and original times.
    if (priorHealth?.[id]?.modelAuth) {
      const untouched = Object.entries(priorHealth[id].modelAuth).filter(([model]) =>
        !scope.some((c) => c.adapter === id && c.model === model));
      h.modelAuth = { ...Object.fromEntries(untouched), ...h.modelAuth };
    }
  }
  const kimiAdapter = adapters.find((a) => a.id === kimi.id);
  const kimiTurnEnabled = kimiAdapter !== undefined
    && scope.some((c) => c.adapter === kimi.id && c.model === "kimi-code/k3")
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
  await recordCodexCommit(adapters, health, cwd, opts.codexSandbox);
  // MODEL-02: detect models where the adapter exposes a list surface, BEFORE writing doctor.json (write once, below).
  // Fail OPEN — the inverse of gates' fail-closed: detection is advisory, so a broken list surface NEVER fails doctor.
  for (const a of adapters) {
    if (!a.listModels) continue;
    const h = health[a.id];
    h.models = [];
    delete h.modelsDetectedAt;
    h.modelListing = { status: "unavailable" };
    if (!h.installed) continue;
    try {
      const listing = a.listModelsResult ? await a.listModelsResult() : undefined;
      const models = listing?.models ?? await a.listModels();
      h.modelListing = listing
        ? { status: listing.status, ...(listing.reason ? { reason: listing.reason } : {}) }
        : { status: models.length ? "succeeded" : "unavailable" };
      h.models = h.modelListing.status === "succeeded" ? models : [];
      // MODEL-05: prefer the source's own fetch time (codex's cache fetched_at) so the staleness lint
      // measures real knowledge age, not run time. opencode reads its own offline cache too but exposes
      // no fetch timestamp, so it still stamps now — its staleness lint is best-effort until it surfaces one.
      if (h.modelListing.status === "succeeded") h.modelsDetectedAt = a.listModelsFetchedAt?.() ?? new Date().toISOString();
      // v2.6.4 T2 (B1a): the CLI's retirement notices ride into doctor.json beside the list they describe;
      // an unreadable source leaves the field absent, which every reader treats as unknown.
      const retirements = a.listModelsRetirements?.();
      if (retirements) health[a.id].modelRetirements = retirements;
      const hidden = a.listModelsHidden?.(); // v2.6.9 (D-1526): the CLI's hidden flag, read by routing
      if (hidden) health[a.id].modelsHidden = hidden;
    } catch { /* unavailable: no drift may be inferred; doctor stays healthy */ }
  }
  // A free Kimi auth failure or failed earned-green turn must not spend more probes. Every other
  // adapter keeps the exact existing model-sweep path.
  const modelProbeAdapters = kimiTurnEnabled && health.kimi.authed === false
    ? adapters.filter((a) => a !== kimiAdapter)
    : adapters;
  // One rewriting stderr line instead of a scrolling line per model (operator report 2026-08-14:
  // 20 probe lines buried the journey). Totals print once at the end; non-TTY stays silent.
  let probeOk = 0;
  let probeBad = 0;
  await probeModels(cfg, cwd, modelProbeAdapters, health, probeProgressTTY
    ? (adapter, model, status, durationMs) => {
      if (status === "ok") probeOk += 1;
      else probeBad += 1;
      process.stderr.write(`\r\x1b[2K  probed ${probeOk + probeBad} channels · ${probeOk} ok${probeBad ? ` · ${probeBad} failed` : ""} · ${adapter}:${model} ${status} (${(durationMs / 1000).toFixed(1)}s)`);
    }
    : undefined, scopeOpts);
  if (probeProgressTTY && probeOk + probeBad > 0) {
    process.stderr.write(`\r\x1b[2K  probed ${probeOk + probeBad} channels · ${probeOk} ok${probeBad ? ` · ${probeBad} failed` : ""}\n`);
  }
  const identityResolver = opts.resolveClaudeAliasIdentity
    ?? (adapters.some((a) => a.id === claudeCode.id) ? resolveClaudeAliasIdentity : undefined);
  const aliasDriftFindings: string[] = [];
  // Single pre-write snapshot of the resolver's outcome per alias (including undefined/failure).
  // Catalog rendering below reads only this map — never calls the resolver again — so a transient
  // resolver that succeeds on a later call can never produce a result that stays display-only
  // while doctor.json and discovery keep the earlier undefined/failed outcome.
  const resolvedIdentitySnapshot: Partial<Record<ClaudeAlias, string | undefined>> = {};
  if (identityResolver && health["claude-code"]?.installed) {
    const configured = cfg.tiers["claude-code"]?.models ?? {};
    for (const [alias, stampedIdentity] of Object.entries(CLAUDE_ALIAS_IDENTITY_STAMPS) as [ClaudeAlias, string][]) {
      if (!(alias in configured) || !scope.some((c) => c.adapter === claudeCode.id && c.model === alias)) continue;
      let resolvedIdentity: string | undefined;
      try {
        resolvedIdentity = identityResolver(cwd, alias);
      } catch {
        resolvedIdentitySnapshot[alias] = undefined;
        continue; // advisory source failure is unknown, never a doctor failure
      }
      resolvedIdentitySnapshot[alias] = resolvedIdentity;
      if (resolvedIdentity) {
        if (!health["claude-code"].modelAuth) {
          health["claude-code"].modelAuth = {};
        }
        const existing = health["claude-code"].modelAuth[alias] ?? {
          authed: true,
          probedAt: new Date().toISOString(),
        };
        health["claude-code"].modelAuth[alias] = {
          ...existing,
          identity: resolvedIdentity,
        };
      }
      if (resolvedIdentity && resolvedIdentity !== stampedIdentity) {
        aliasDriftFindings.push(
          `resolved-identity drift: claude-code:${alias} resolved to ${resolvedIdentity}, stamped identity ${stampedIdentity} — reclassify per benchmark policy (advisory — routing unchanged)`,
        );
      }
    }
  }
  const discovery = await checkModelDiscovery({ cwd, cfg, adapters, health, catalog, resolved: resolvedIdentitySnapshot, mayRefresh: !opts.catalog && !catalogRefreshLine && catalogRefreshAllowed, fetcher: opts.catalogFetcher, now: opts.catalogNow });
  catalog = discovery.catalog;
  aliasDriftFindings.push(...discovery.findings);
  const portProbe = await probeLaunchServicesPorts();
  const launchServices = await recordLaunchServices(readDoctor(cwd), health, portProbe.observation);
  // Only scoped runs merge with the prior report. A full refresh must not revive
  // adapters absent from this run (for example, a no-longer-registered CLI).
  writeDoctor(cwd, launchServices.health, explicitSelection && !scopeOpts.all ? scope : undefined);
  // A scoped probe's report must use the merged verdict set it just wrote. In particular,
  // an unselected judge or consult adapter is not missing merely because it was not probed.
  if (explicitSelection && !scopeOpts.all) health = readDoctor(cwd) ?? health;
  const rows = adapters.map((a) => {
    const h = health[a.id];
    // OBS-503: a crash-on-version verdict carries its reason in note — print it instead of the lie.
    const state = !h.installed ? (h.note ?? "not installed") : `${h.version ?? "installed"}${h.note ? ` (${h.note})` : ""}`;
    // v2.6.6 T9 (K): a Codex sandbox escape is a BLOCKING security warning — never a passing row
    const healthy = h.installed && (a.id !== kimi.id || h.authed) && !(a.id === codex.id && h.codexCommit === "escape");
    return alignedStatusRow(healthy ? "pass" : "fail", a.id, state);
  });
  const ports = portProbe.ports;
  const portLine = ports.status === "non-darwin" ? "launchservicesd ports: not applicable"
    : ports.status === "read" ? `launchservicesd pid ${ports.pid}: ${ports.count} ports`
    : `launchservicesd pid ${ports.status === "unknown" ? ports.pid ?? "unknown" : "unknown"}: ports unknown`;
  if (ports.status !== "skipped") {
    rows.push(alignedStatusRow(ports.status === "read" && ports.count < LAUNCHSERVICES_PORT_ADVISORY || ports.status === "non-darwin"
      ? "pass" : "warn", "launchservicesd", portLine));
  }
  const reviewDemotions = recentReviewDemotions(cwd);
  if (reviewDemotions.length) {
    rows.push(legend("recent review-seat demotions:"));
    for (const demotion of reviewDemotions) {
      const causes = Object.entries(demotion.causes)
        .map(([cause, count]) => `${cause}${count === demotion.count ? "" : ` ×${count}`}`).join(", ");
      rows.push(alignedStatusRow("warn", demotion.reviewer,
        `${demotion.count} review seat${demotion.count === 1 ? "" : "s"} demoted · cause ${causes}`));
    }
  }
  // OBS-1052(3): measured, never inferred — an unreadable journal renders unknown, not a clean zero.
  const noVerdictRows = reviewNoVerdictRows(readReviewNoVerdictHistory(cwd));
  if (noVerdictRows.length) {
    rows.push(legend("review no-verdict history:"));
    for (const row of noVerdictRows) rows.push(alignedStatusRow(row.verdict, row.channel, row.value));
  }
  if (existsSync(graphPath(cwd))) {
    try {
      const graph = loadGraph(cwd);
      const items = graph.tasks.flatMap((task) => task.acceptance);
      if (items.some((item) => typeof item === "object" && item.oracle === "test")) {
        const listing = await (opts.listTests ?? listVitestTests)(cwd);
        if (listing.status === "failed") {
          rows.push(alignedStatusRow("fail", "acceptance-oracles", `runner listing failed — ${listing.error.split("\n")[0]}`));
        } else {
          const audited = auditNamedTestOracles(items, listing.tests);
          const resolved = audited.filter((row) => row.matches.length === 1).length;
          const verdict = resolved === audited.length ? "pass" : "fail";
          rows.push(alignedStatusRow(
            verdict,
            "acceptance-oracles",
            `${resolved}/${audited.length} resolved — each resolved oracle's shipped filter matches exactly one runner-listed test`,
          ));
        }
      }
    } catch (error) {
      rows.push(alignedStatusRow("fail", "acceptance-oracles", `graph unreadable — ${error instanceof Error ? error.message : String(error)}`));
    }
  }
  if (catalog.warning) {
    rows.push(attentionRow(`model catalog cache unreadable — ${catalog.warning}; using vendored fallback (advisory — routing unchanged)`));
  }
  if (catalogRefreshLine) {
    rows.push(attentionRow(`model catalog auto-refresh — ${catalogRefreshLine}`));
  }
  // v1.48 T1 / v1.86 T12: advisory sweep for known agent CLIs with no drive contract. Presence is
  // resolved through the worker's login shell; advisory targets are never executed or written to health.
  rows.push(...detectCandidateClis({ cwd }).map(({ binary, path }) =>
    alignedStatusRow("warn", binary, `detected at ${path} (no drive contract — not routable)`),
  ));
  const herdr = HerdrDriver.available();
  rows.push(alignedStatusRow(herdr ? "pass" : "fail", "herdr", herdr ? "driver available (HERDR_ENV=1)" : "not detected — subprocess driver will be used"));
  // Queue rows 196 and 197 (D-2102 add.1): where seats run, and the locale every gate inherits.
  for (const row of hostRows(process.env, cfg.visibility.llm)) rows.push(alignedStatusRow(row.verdict, row.key, row.detail));
  const locale = localeFinding(process.env);
  rows.push(alignedStatusRow(locale.verdict, "locale", locale.detail));
  const root = canonicalWorktreePath(cwd);
  const folders = protectedFolderFinding(root, canonicalWorktreePath(join(root, stateDirName(cwd))),
    process.platform, process.env.HOME ? canonicalWorktreePath(process.env.HOME) : undefined);
  if (folders) rows.push(alignedStatusRow(folders.verdict, "folders", folders.detail));
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
  // Declutter (operator report 2026-08-14): n/a trust rows carried zero decisions — nine of them
  // drowned the one action-required line. They compress to a single dim roster; actionable rows keep
  // their own verdict lines.
  const trustNa: string[] = [];
  for (const a of adapters) {
    if (!health[a.id]?.installed) continue;
    if (!a.trust) {
      trustNa.push(a.id);
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
  if (trustNa.length) rows.push(`  ${dim("=")} ${dim(`n/a (${trustNa.length}): ${trustNa.join(", ")}`)}`);
  // Capability is diagnostic only: auto-selection is decided from terminal identity markers, never
  // from this runtime probe, and a failed probe cannot silently substitute another driver.
  const orca = await probeOrcaCapability(cwd, opts);
  rows.push(legend("execution runtime:"));
  rows.push(alignedStatusRow(orca.verdict, "orca", orca.detail));
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
  lintRows.push(...modelLints(cfg, health, adapters, { tty: ttyVisual(), stateDir: stateDirName(cwd), overlayPreferShapes: overlayPreferShapes(cwd), now: opts.now?.() }).map(attentionRow));
  lintRows.push(...modelListingLints(cfg, health, adapters).map(attentionRow));
  const excluded = excludedChannels(cfg, adapters, health);
  if (excluded.length) lintRows.push(attentionRow(exclusionLine(excluded, listAllModels)));
  lintRows.push(...denyPreferCollisions(cfg, undefined, health).map((c) => attentionRow(denyPreferCollisionLine(c))));
  const aliasExcluded = modelAliasExclusions(cfg, adapters, health);
  if (aliasExcluded.length) lintRows.push(attentionRow(modelAliasLine(aliasExcluded)));
  lintRows.push(...binaryShadowWarnings(adapters, health, cwd).map(attentionRow));
  // HYG-07(a): doctor just probed fresh (probeAll above), so servability attribution is current by construction.
  const servable = servableExclusions(cfg, adapters, health);
  if (servable.length) lintRows.push(attentionRow(servabilityLine(servable)));
  // v1.65 T3: hardcoded-flag drift — advisory warn rows only. Runs AFTER writeDoctor so the verdicts
  // can never leak into doctor.json, and discoverChannels/routing never read them.
  lintRows.push(...flagDriftWarnings(adapters, health).map(attentionRow));
  // OBS-145: resolved-identity drift is advisory display warning.
  lintRows.push(...aliasDriftFindings.map(attentionRow));
  if (launchServices.line) lintRows.push(attentionRow(launchServices.line));
  const resolvedCatalogModel = (adapter: string, model: string): string | undefined => {
    if (adapter !== "claude-code" || !(model in CLAUDE_ALIAS_IDENTITY_STAMPS)) return undefined;
    return resolvedIdentitySnapshot[model as ClaudeAlias];
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
  // D-1518: configured tiers use the same suggestion (and tierBandOf) as unclassified rows.
  // Check every configured model, including adapters absent from the installed status table.
  for (const [adapter, entry] of Object.entries(cfg.tiers)) {
    for (const [model, tier] of Object.entries(entry.models)) {
      const { suggestion } = catalogModelAdvisory(cfg, catalog, adapter, model, resolvedCatalogModel(adapter, model), catalogRanking);
      if (suggestion && tier !== suggestion.tier) {
        lintRows.push(attentionRow(`tier drift: ${adapter}:${model} configured ${tier}; ${suggestion.provenanceNote} (advisory — routing unchanged)`));
      }
    }
  }
  const modelStatus = adapters.flatMap((a) => {
    const h = health[a.id];
    if (!h?.installed) return [];
    const classified = cfg.tiers[a.id]?.models ?? {};
    const models = Object.keys(classified);
    const unclassified = unclassifiedByAdapter.get(a.id) ?? [];
    if (!models.length && !unclassified.length) return [];
    const w = Math.max(8, ...models.map((m) => m.length));
    const rows: string[] = [`  ${dim(a.id)}`];
    let timeoutNotePrinted = false;
    for (const m of models) {
      const v = h.modelAuth?.[m];
      // probe wall clock (ProbedModelAuth.durationMs) — pre-v1.91 doctor.json rows lack it
      const probedMs = (v as { durationMs?: number } | undefined)?.durationMs;
      const probed = probedMs !== undefined ? dim(` ${(probedMs / 1000).toFixed(1)}s`) : "";
      const auth = !v
        ? dim("unknown")
        : v.probeError
          ? `${fail(`probe error (${v.probeError})`)}${probed}`
          : v.authed
          ? `${ok("authed")}${probed}`
          : v.cause === "unknown-model"
          ? `${fail(`${m} is not served by ${a.id}`)} (${dateOf(v.probedAt)})`
          : `${fail("unauthed:")} ${trunc(v.reason ?? "probe failed", 40)} (${dateOf(v.probedAt)})`;
      const d = disallowedBy(observedSeat(health, a.id, m), cfg.routing);
      const denied = d?.by === "deny" ? d.entry : "—";
      const pref = preferRanks({ adapter: a.id, model: m }, cfg).map((p) => `${p.shape}#${p.rank}`).join(",") || "—";
      const window = declaredModelWindow(cfg, a.id, m);
      const windowCol = showWindows
        ? ` ${(window !== undefined ? compactTokens(window) : "—").padEnd(5)}`
        : "";
      rows.push(`    ${m.padEnd(w)} ${classified[m].padEnd(8)}${windowCol} ${auth}  ${dim("denied=")}${denied}  ${dim("prefer=")}${pref}`);
      const timeoutNote = !timeoutNotePrinted && formatDoctorProbeTimeoutNote(a, v);
      if (timeoutNote) {
        rows.push(timeoutNote);
        timeoutNotePrinted = true;
      }
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
      for (const advisory of shown) rows.push(`    ${dim(`catalog · ${advisory.display} · adapter: ${a.id}`)}`);
      if (!listAllModels && bulk.length) {
        const uncovered = bulk.filter((adv) => adv.coverage === "uncovered").length;
        const unknown = bulk.filter((adv) => adv.coverage === "unknown").length;
        const evidenceOnly = bulk.length - uncovered - unknown;
        const parts = [
          ...(uncovered ? [`${uncovered} uncovered by ${catalog.source === "cache" ? "cached catalogs" : "vendored catalog"}`] : []),
          ...(unknown ? [`${unknown} coverage unknown after a failed refresh`] : []),
          ...(evidenceOnly ? [`${evidenceOnly} covered without a tier suggestion`] : []),
        ];
        rows.push(`    ${dim(`catalog · ${parts.join(" · ")} — tickmarkr doctor --models lists each · adapter: ${a.id}`)}`);
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
  // Attention rows earn a counted section header so the matrix, the lints, and the model table
  // read as three sections instead of one undifferentiated wall (operator report 2026-08-14).
  const lintSection = lintRows.length
    ? `\n${legend(`attention (${lintRows.length}):`)}\n${lintRows.join("\n")}`
    : "";
  return `${header}\n${rows.join("\n")}${lintSection}${modelSummary}${drift}\nwrote ${stateDirName(cwd)}/doctor.json`;
}
