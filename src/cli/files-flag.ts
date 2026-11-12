// Queue row 411 (D-2187 add.65, add.70): approve --files parsing and the grant surface slot, kept out of
// approve.ts so that file stays under its size bound. The daemon reads the same grant fold for its
// diff-cap remedy, so the two surfaces never disagree on whether a task holds a grant.
import picomatch from "picomatch";
import { literalParens } from "../graph/files-glob.js";
import { effectiveEvents, ScopeAmendmentSchema, SCOPE_LAPSE_EVENT, type JournalEvent } from "../run/journal.js";

const FILES_GLOB_OPTIONS: picomatch.PicomatchOptions = { dot: true };
const FILES_REMEDY = "remedy: write each path out, and put ? where a file's name holds a brace or a comma";

/**
 * Row 411 (D-2187 add.65, add.70, add.148): a scope-request --files value is read by TWO readers that must
 * agree. The COUNT knows three characters only (`{` opens, `}` closes, `,` at depth zero separates). The
 * matcher's own parser reads the same value for two facts: its comma tokens in order with their kind
 * (separator `,` or alternation `|`), and its closing-brace tokens of value exactly `}`. A value both
 * readers accept splits where the count says; any other is refused whole, naming it. The parse is for
 * agreement, never a match. `{ dot: true }` repeats filesGlob's options: a ruled, stated duplication
 * (D-2187 add.148) until queue row 437 moves this parse behind the matcher module.
 */
export function readFilesValue(value: string): string[] {
  const parts: string[] = [];
  const kinds: string[] = [];
  let depth = 0, start = 0, closes = 0, balanced = true;
  for (let i = 0; i < value.length; i++) {
    const c = value[i];
    if (c === "{") depth++;
    else if (c === "}") { closes++; if (depth === 0) balanced = false; else depth--; }
    else if (c === ",") {
      kinds.push(depth === 0 ? "," : "|");
      if (depth === 0) { parts.push(value.slice(start, i)); start = i + 1; }
    }
  }
  parts.push(value.slice(start));
  if (!balanced || depth !== 0) throw new Error(`--files value ${value} has an unbalanced brace — ${FILES_REMEDY}`);
  const tokens = picomatch.parse(literalParens(value), FILES_GLOB_OPTIONS).tokens;
  const commas = tokens.filter((t) => t.type === "comma").map((t) => t.output);
  const braceCloses = tokens.filter((t) => t.type === "brace" && t.value === "}").length;
  if (commas.length !== kinds.length || commas.some((kind, i) => kind !== kinds[i]) || braceCloses !== closes) {
    throw new Error(`--files value ${value} holds a brace or comma that is not one to the matcher (it sits in an escape, a quote or a character class) — ${FILES_REMEDY}`);
  }
  return parts;
}

/** The task's active grants: effective scope amendments a recorded lapse row does not name (row 409). */
function activeGrants(events: readonly JournalEvent[], taskId: string) {
  const lapsed = new Set(events.filter((e) => e.event === SCOPE_LAPSE_EVENT && e.taskId === taskId).map((e) => String(e.data.park)));
  return effectiveEvents(events)
    .filter((e) => e.event === "task-approved" && e.taskId === taskId && e.data.amendment !== undefined)
    .map((e) => ScopeAmendmentSchema.parse(e.data.amendment))
    .filter((a) => !lapsed.has(String(a.parkLine)));
}

export const hasActiveGrant = (events: readonly JournalEvent[], taskId: string): boolean => activeGrants(events, taskId).length > 0;

/**
 * Row 411: the files[] approve's bound check measures — the compiled patterns (the first active grant's
 * beforeFiles, else the current files[]) plus ONE slot standing for every grant together, whatever
 * their count or path count. Compile's own bound is unchanged.
 */
export function grantSlotFiles(events: readonly JournalEvent[], taskId: string, current: readonly string[]): string[] {
  const compiled = activeGrants(events, taskId)[0]?.beforeFiles ?? current;
  return [...compiled, "<approved grants>"];
}

const GATE_DIFF_CAP_REMEDY = "split the task, or raise gates.diffCap";
/** Row 411: a granted task cannot be split (its definition fingerprint refuses), so only the raise is executable. */
export const grantedDiffCapReason = (reason: string): string =>
  reason.replaceAll(GATE_DIFF_CAP_REMEDY, "raise gates.diffCap, then approve --recheck");
