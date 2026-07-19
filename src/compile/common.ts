import { createHash } from "node:crypto";
import picomatch from "picomatch";
import type { Shape } from "../graph/schema.js";

export class CompileError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = "CompileError";
  }
}

export function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

export function inferShape(description: string): Shape {
  if (/\btests?\b|\btesting\b/i.test(description)) return "tests";
  if (/\bdocs?\b|\bdocument(ation)?\b/i.test(description)) return "docs";
  if (/migrat/i.test(description)) return "migration";
  if (/\b(ui|screen|component)\b/i.test(description)) return "ui";
  if (/refactor/i.test(description)) return "refactor";
  return "implement";
}

export interface WriteDirective {
  path: string;
  directive: string;
  // HARD-09: set when the plan named a bare filename (no "/") — its plan-time meaning is
  // "this file in my own directory", which survives archive relocation; `path` (joined against
  // the plan's CURRENT dir) does not.
  bare?: string;
}

// DOCUMENTED LIMIT: a write demand in freeform prose with no backticked path after a write verb
// is NOT caught here (zero such cases across 87 real acceptance criteria). The runtime scope gate
// is the backstop — weakened because it passes anything a worker declares as a deviation.
export function assertWriteScope(source: string, taskId: string, files: string[], writes: WriteDirective[]): void {
  // #1 over-fire landmine: empty files[] is unrestricted — mirrors scope.ts:12
  if (!files.length) return;
  const inScope = picomatch(files, { dot: true }); // byte-identical options to src/gates/scope.ts:15
  for (const { path, directive, bare } of writes) {
    const normalized = path.replace(/^\.\//, "");
    if (inScope(normalized)) continue;
    // HARD-09: relocation-invariant self-write check. A bare-name directive is scoped iff SOME
    // files_modified entry names that exact filename (literal suffix — no second matcher semantics;
    // one matcher, per the v1.11 byte-identity decision with src/gates/scope.ts). v1.9-29's P30-02
    // shape has NO entry with the SUMMARY's basename anywhere → still rejected. Moreover v1.9-29's
    // four directives all carry a full slashed path (bare is never set), so it never reaches here.
    //
    // DOCUMENTED LIMIT A: a files_modified entry naming the same basename in a DIFFERENT directory
    // satisfies the fallback although the write lands in the phase dir. Zero such cases in the real
    // corpus (every observed self-write entry lives in the plan's own dir); the now-fixed runtime
    // scope gate (src/gates/scope.ts) is the backstop.
    // DOCUMENTED LIMIT B: a relocated plan whose self-write scope is a GLOB rather than a literal
    // still over-fires. Zero such cases exist (all corpus files_modified entries are literal paths).
    if (bare && files.some((f) => f === bare || f.endsWith(`/${bare}`))) continue;
    throw new CompileError(
      `${source}: task ${taskId} write directive orders a path outside files_modified.\n` +
        `  directive: ${directive.trim()}\n` +
        `  path: ${normalized}\n` +
        `  remedy: add the path to files_modified, or drop the directive.`,
    );
  }
}
