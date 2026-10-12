import { shq } from "../adapters/types.js";
import { shGit } from "../run/git.js";

/**
 * Queue row 142 (ANL-021 P7, limited to three facts; D-1843, D-1844): a diff made only of a pure rename, an empty new
 * file or a mode-only change carries no changed hunk, so the acceptance judge had nothing to cite. These facts come
 * from TYPED git measurement, read beside the patch text and never from it: no diff --git, rename, mode or new file
 * header line of the patch is ever an authority here, so a file whose content spells those headers creates nothing.
 *
 * Measurement: the worktree HEAD is resolved to one commit, then tickmarkr's own-git runner reads
 * `git diff --raw -z --no-abbrev -M <baseRef>..<commit>` with stdout captured as BYTES. -M forces rename detection
 * whatever diff.renames says in repository, global or inherited (GIT_CONFIG_*) configuration, and no copy option is
 * passed; nothing else is configured. -z makes git print every path verbatim (never C-quoted, so core.quotePath is
 * irrelevant), and the bytes are split on NUL before any decoding, so no name can move a record boundary.
 *
 * Closed record grammar, every field NUL-terminated:
 *   ':' oldmode SP newmode SP oldhash SP newhash SP status NUL path NUL [path NUL — exactly when status is R or C]
 * modes are six octal digits, hashes 40 or 64 lowercase hex, status one of A C D M R T U X, and R and C (only they)
 * carry exactly three score digits. A header outside the grammar, an empty path or a truncated record ends the read
 * with NO facts at all. Each path is decoded by a FATAL UTF-8 decoder (BOM kept): a name that is not valid UTF-8
 * makes its record no fact, so a lossy U+FFFD rendering can never authorize a valid U+FFFD-named file beside it.
 *
 * The closed fact table — each fact is line 0 of its exact path:
 *   pure rename       R100, equal blob ids and equal modes; the fact names the destination (never the source)
 *   empty add         A whose blob id equals this repository's empty blob (git hash-object -t blob /dev/null)
 *   mode-only change  M, equal blob ids, modes 100644 and 100755 exchanged
 * Every other record is no fact: binary adds and modifications (git's binary decision follows worker-writable
 * attributes, and the judge cannot read the content), deletions (an empty file's included), renames below 100 or with
 * a mode change, copies, type changes and every other status. A non-zero or killed read gives no facts, and so does a
 * HEAD that resolves to another commit after the judged diff was read (operationFactsAtHead).
 */
export type OperationFactKind = "pure rename" | "empty add" | "mode-only change";
export interface OperationFact { kind: OperationFactKind; path: string }
export type OperationFactsRead =
  | { ok: true; commit: string; facts: OperationFact[] }
  | { ok: false; error: string };

const RECORD_HEADER = /^:([0-7]{6}) ([0-7]{6}) ([0-9a-f]{40}|[0-9a-f]{64}) ([0-9a-f]{40}|[0-9a-f]{64}) ([RC][0-9]{3}|[ADMTUX])$/;
const EXECUTABLE_EXCHANGE = new Set(["100644", "100755"]);

function decodeName(bytes: Buffer): string | null {
  try { return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes); } catch { return null; }
}

/** The facts in raw `-z` output, or null when any record falls outside the closed grammar. */
export function parseOperationFacts(raw: Buffer, emptyBlob: string): OperationFact[] | null {
  const fields: Buffer[] = [];
  for (let start = 0; start < raw.length; ) {
    const end = raw.indexOf(0, start);
    if (end < 0) return null; // a field git did not terminate: truncated output
    fields.push(raw.subarray(start, end));
    start = end + 1;
  }
  const facts: OperationFact[] = [];
  for (let i = 0; i < fields.length; ) {
    // latin1 maps each byte to one code point, so a non-ASCII byte can never satisfy the ASCII header grammar
    const header = RECORD_HEADER.exec(fields[i]!.toString("latin1"));
    if (!header) return null;
    const [, oldMode, newMode, oldId, newId, status] = header;
    const count = status[0] === "R" || status[0] === "C" ? 2 : 1;
    const paths = fields.slice(i + 1, i + 1 + count);
    if (paths.length !== count || paths.some((path) => path.length === 0)) return null;
    i += 1 + count;
    const names = paths.map(decodeName);
    if (names.some((name) => name === null)) continue;
    const path = names[count - 1]!;
    if (status === "R100" && oldId === newId && oldMode === newMode) facts.push({ kind: "pure rename", path });
    else if (status === "A" && newId === emptyBlob) facts.push({ kind: "empty add", path });
    else if (status === "M" && oldId === newId && oldMode !== newMode && EXECUTABLE_EXCHANGE.has(oldMode) && EXECUTABLE_EXCHANGE.has(newMode)) {
      facts.push({ kind: "mode-only change", path });
    }
  }
  return facts;
}

async function resolveHead(worktree: string): Promise<string | null> {
  const head = await shGit("git rev-parse --verify --end-of-options 'HEAD^{commit}'", worktree);
  return head.code === 0 && !head.timedOut ? head.stdout.trim() : null;
}

/** Reads the typed operation facts of `<baseRef>..HEAD`, bound to the commit HEAD resolved to. Never throws. */
export async function readOperationFacts(worktree: string, baseRef: string): Promise<OperationFactsRead> {
  try {
    const commit = await resolveHead(worktree);
    if (!commit) return { ok: false, error: "HEAD did not resolve to a commit" };
    // --no-filters: the empty blob is git's, never a clean filter's output under a worker-written attribute
    const empty = await shGit("git hash-object -t blob --no-filters /dev/null", worktree);
    if (empty.code !== 0 || empty.timedOut) return { ok: false, error: `git hash-object exited ${empty.code}` };
    const raw = await shGit(`git diff --raw -z --no-abbrev -M ${shq(`${baseRef}..${commit}`)} --`, worktree, undefined, {}, { bytes: true });
    if (raw.code !== 0 || raw.signalExit || raw.timedOut || !raw.stdoutBytes) {
      return { ok: false, error: `git diff --raw exited ${raw.code}${raw.signalExit ? " (killed)" : ""}` };
    }
    const facts = parseOperationFacts(raw.stdoutBytes, empty.stdout.trim());
    return facts ? { ok: true, commit, facts } : { ok: false, error: "a raw diff record is outside the closed grammar" };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/** The read's facts only while HEAD still resolves to the commit they measured; call it after the judged diff is read. */
export async function operationFactsAtHead(worktree: string, read: OperationFactsRead): Promise<OperationFact[]> {
  if (!read.ok) return [];
  try { return (await resolveHead(worktree)) === read.commit ? read.facts : []; } catch { return []; }
}
