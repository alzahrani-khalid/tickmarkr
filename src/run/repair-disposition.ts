import type { ScopeCollateralVerdict } from "../compile/collateral.js";
import type { GateResult } from "../gates/types.js";
import { filesGlob } from "../graph/files-glob.js";

/** Pure decision table of the scope-red disposition (OBS-1077, OBS-1074 residual): no filesystem,
 * process, clock or journal. The caller supplies the inventory and performs every side effect. */

export type RepairDispositionKind = "fund-repair" | "scope-request" | "authoring" | "none";

export interface RepairDisposition {
  kind: RepairDispositionKind;
  /** validated inventory paths only — the sole paths a caller may put in an executable command */
  paths: string[];
  reason: string;
  /** which evidence decided: a gate name, "worker" for a refusal, absent for the ordinary disposition */
  source?: string;
  /** an independent classification that kept priority over path prose */
  blocker?: "infra" | "scope-collateral";
  /** candidates that bound to nothing, or to more than one path; evidence, never approval advice */
  diagnostics: ScopeHintDiagnostic[];
}

export interface ScopeHintDiagnostic {
  candidate: string;
  kind: "unresolved" | "ambiguous";
  matches: string[];
  reason: string;
}

export interface ScopeHintResolution {
  resolved: string[];
  diagnostics: ScopeHintDiagnostic[];
}

export interface RepairDispositionInput {
  /** the failing gate results (passing rows are ignored) */
  results: readonly GateResult[];
  files: readonly string[];
  /** the worker's refusal summary — present only when the worker reported ok:false */
  refusalSummary?: string;
  /** task tree plus diff, deleted tracked paths included */
  inventory: Iterable<string>;
}

const failed = (g: GateResult) => !(g.pass || g.meta?.skipped === true) || g.meta?.infra === true;
const REFUSAL_RE = /outside|out.of.scope|allowlist|scope expansion|not (?:in|own)|unowned/i;

/** Lexing never starts in the middle of a word (same lexer as the daemon's scope-red disposition). */
export const namedPaths = (text: string): string[] => [...text.matchAll(/(?:^|[\s`'"])((?:[A-Za-z0-9_@.()[\]-]+\/)+[A-Za-z0-9_@.[\]-]+|[A-Za-z0-9_@-]+(?:\.[A-Za-z0-9_-]+)+)(?=$|[\s`'"),:;.!?])/g)]
  .map((match) => match[1]!.replace(/^\.\//, "").replace(/\.$/, ""))
  .filter((path) => !path.split("/").includes(".."));

/** Binds candidates to the SUPPLIED inventory and nothing else: an exact path, else a unique
 * path-suffix. Anything unbound or bound twice comes back as a non-executable diagnostic. */
export function resolveScopeHints(candidates: Iterable<string>, inventory: Iterable<string>): ScopeHintResolution {
  const known = new Set(inventory);
  const resolved = new Set<string>();
  const diagnostics: ScopeHintDiagnostic[] = [];
  for (const candidate of new Set(candidates)) {
    if (known.has(candidate)) { resolved.add(candidate); continue; }
    const matches = [...known].filter((path) => path.endsWith(`/${candidate}`)).sort();
    if (matches.length === 1) resolved.add(matches[0]!);
    else diagnostics.push(matches.length === 0
      ? { candidate, kind: "unresolved", matches, reason: `scope hint resolves to nothing in the task tree: ${candidate}` }
      : { candidate, kind: "ambiguous", matches, reason: `scope hint ${candidate} matches ${matches.length} paths: ${matches.join(", ")}` });
  }
  return { resolved: [...resolved].sort(), diagnostics };
}

export function classifyRepairDisposition(input: RepairDispositionInput): RepairDisposition {
  const reds = input.results.filter(failed);
  const none = (reason: string, extra: Partial<RepairDisposition> = {}): RepairDisposition =>
    ({ kind: "none", paths: [], reason, diagnostics: [], ...extra });

  // Independent classifications first: prose naming a path never erases them.
  const infra = reds.find((g) => g.meta?.infra === true);
  if (infra) return none(`${infra.gate}: infra red keeps its own classification`, { source: infra.gate, blocker: "infra" });
  const verdict = reds.find((g) => g.gate === "scope")?.meta?.collateral as ScopeCollateralVerdict | undefined;
  if (verdict) {
    return verdict.authoring
      ? { kind: "authoring", paths: [...verdict.predicted], reason: verdict.repair, source: "scope", blocker: "scope-collateral", diagnostics: [] }
      : none("scope: collateral verdict has unpredicted offenders — ordinary chargeable disposition", { source: "scope", blocker: "scope-collateral" });
  }
  if (input.files.length === 0) return none("task declares no files[]");

  const allowed = filesGlob([...input.files]);
  const inventory = [...input.inventory];
  const unowned = (text: string) => {
    const r = resolveScopeHints(namedPaths(text).filter((path) => !allowed(path)), inventory);
    return { paths: r.resolved.filter((path) => !allowed(path)), diagnostics: r.diagnostics };
  };
  const owned = (text: string) => resolveScopeHints(namedPaths(text), inventory).resolved.some(allowed);

  const refusal = input.refusalSummary !== undefined && REFUSAL_RE.test(input.refusalSummary)
    ? unowned(input.refusalSummary) : { paths: [], diagnostics: [] };
  // A test gate names where the ASSERTION lives — a detection site, not the code that needs fixing.
  const sites = reds.filter((g) => g.gate === "test").map((g) => unowned(g.details));
  const others = reds.filter((g) => g.gate !== "test");
  const hints = others.map((g) => unowned(g.details));
  const diagnostics = [refusal, ...sites, ...hints].flatMap((r) => r.diagnostics)
    .filter((d, i, all) => all.findIndex((o) => o.candidate === d.candidate) === i);
  const uniq = (rs: { paths: string[] }[]) => [...new Set(rs.flatMap((r) => r.paths))].sort();

  if (refusal.paths.length) {
    return { kind: "scope-request", paths: refusal.paths, source: "worker", diagnostics,
      reason: `worker refusal names unowned paths: ${refusal.paths.join(", ")}` };
  }
  const repair = uniq(hints);
  if (repair.length && !others.some((g) => owned(g.details))) {
    const review = others.some((g) => g.gate === "review");
    return { kind: review ? "scope-request" : "authoring", paths: repair, source: others[0]!.gate, diagnostics,
      reason: `files[] repair hint: ${repair.join(", ")}` };
  }
  const detection = uniq(sites);
  if (detection.length) {
    return { kind: "fund-repair", paths: detection, source: "test", diagnostics,
      reason: `test gate names a detection site, not an out-of-scope repair: ${detection.join(", ")}` };
  }
  // Unknown attribution never blocks funding: the ordinary chargeable disposition applies.
  return none("no attributable out-of-scope repair — ordinary chargeable disposition", { diagnostics });
}
