import { lstatSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { join } from "node:path";
import { filesGlob, literalParens } from "../graph/files-glob.js";
import type { Pin, Task } from "../graph/schema.js";

// v2.5.8 T14 (agreement C2): the declared-pin sweep. Unlike the advisory collateral walker
// (collateral.ts) this scan CERTIFIES, so it is complete or it refuses: every file on disk the glob matches, any extension,
// read whole, no file or byte cap. A cause it cannot rule out (unreadable, truncated, empty surface)
// is an error, never a silent skip. It reports only — it never widens files[].

/** The file-system seam: tests substitute it to stage an unreadable file or a truncated read. */
export interface PinScanIo {
  size(abs: string): number;
  read(abs: string): Buffer;
  /** stat-following; throws like statSync (ENOENT for a broken link). */
  isDirectory(abs: string): boolean;
  /** stat-following: a regular file (or a link resolving to one) — never a FIFO, socket or device. */
  isFile(abs: string): boolean;
}

const NODE_IO: PinScanIo = {
  size: (abs) => statSync(abs).size,
  read: (abs) => readFileSync(abs),
  isDirectory: (abs) => statSync(abs).isDirectory(),
  isFile: (abs) => statSync(abs).isFile(),
};

export interface LiteralHit {
  path: string;
  line: number;
}

const cause = (error: unknown): string => (error instanceof Error ? error.message : String(error));

const patternsOf = (pin: Pin): string[] => (pin.kind === "literal" ? [pin.glob] : pin.paths);

/** Leading segments with no glob syntax at all (never the last): every match of the pattern sits under them. */
const literalBase = (pattern: string): string => {
  const segs = literalParens(pattern).split("/");
  const wild = segs.findIndex((s) => !/^[\w.-]+$/.test(s) || s === "..");
  return segs.slice(0, Math.min(wild < 0 ? segs.length : wild, segs.length - 1)).join("/");
};

interface WalkCause {
  /** The path the walk could not see beneath. */
  at: string;
  why: string;
  /** True when `at` itself may be a file (an entry nobody could stat), so a pin matching it is affected too. */
  maybeFile: boolean;
}

interface Walked {
  paths: string[];
  /** Why this walk is not the whole surface; each refuses exactly the pins that could match at or beneath it. */
  causes: WalkCause[];
}

/**
 * picomatch's brace semantics are expansion (`{a,b/c}/x` ≡ `a/x`, `b/c/x`; `\,` and `\{` are literal):
 * every top-level comma-holding brace is expanded until none remains, so a slash inside a brace is an
 * honest segment boundary. A brace with no top-level comma (`{a}`, `{1..3}`) is left for filesGlob.
 */
function expandBraces(pattern: string): string[] {
  let depth = 0;
  let open = -1;
  let alts: string[] = [];
  let last = -1;
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === "\\") i++;
    else if (c === "{") {
      if (depth++ === 0) { open = i; last = i + 1; alts = []; }
    } else if (c === "," && depth === 1) {
      alts.push(pattern.slice(last, i));
      last = i + 1;
    } else if (c === "}" && depth > 0 && --depth === 0) {
      if (!alts.length) continue; // no top-level comma: a literal or range brace, not an alternation
      alts.push(pattern.slice(last, i));
      const head = pattern.slice(0, open);
      const tail = pattern.slice(i + 1);
      return alts.flatMap((a) => expandBraces(head + a + tail));
    }
  }
  return [pattern];
}

/** Split on "/" where it is a segment boundary; null when a slash is escaped or sits inside brackets. */
function segmentsOf(pattern: string): string[] | null {
  const out = [""];
  let depth = 0;
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === "\\") {
      if (pattern[i + 1] === "/") return null;
      out[out.length - 1] += c + (pattern[++i] ?? "");
    } else if (c === "/") {
      if (depth) return null;
      out.push("");
    } else {
      if (c === "[") depth++;
      else if (c === "]" && depth) depth--;
      out[out.length - 1] += c;
    }
  }
  return out;
}

/**
 * Does `alt` (brace-free) match EVERY path beneath `d`? Only a trailing globstar right after a matched prefix
 * proves it; a globstar before that may swallow any run of `d`'s segments (`**\/cache/**` covers fixtures/cache/loop).
 */
function coversBeneath(alt: string, d: string[]): boolean {
  const segs = segmentsOf(alt);
  if (!segs) return false;
  const covers = (si: number, di: number): boolean => {
    if (si >= segs.length) return false;
    if (segs[si] === "**") {
      if (si === segs.length - 1) return true;
      for (let k = di; k <= d.length; k++) if (covers(si + 1, k)) return true;
      return false;
    }
    if (di >= d.length) return false;
    // the prefix is matched as ONE pattern: a standalone `!cache` segment would read as a negation
    return filesGlob(segs.slice(0, si + 1).join("/"))(d.slice(0, di + 1).join("/")) && covers(si + 1, di + 1);
  };
  return covers(0, 0);
}

/**
 * Could `pattern` match a path strictly beneath directory `dir`? Matcher-consistent by construction:
 * braces are expanded the way picomatch reads them, then every segment prefix is decided by filesGlob itself,
 * and only an exact `**` segment is a globstar (`**.txt` is one ordinary segment). A leading `!` matches
 * every path its body does not, so it reaches beneath `dir` unless some branch of the body provably covers
 * all of it. What still cannot be split soundly (an escaped or bracketed slash) answers yes rather than certify blind.
 */
function reachesBeneath(pattern: string, dir: string): boolean {
  const p = pattern.replace(/^\.\//, "");
  const d = dir ? dir.split("/") : [];
  if (p.startsWith("!")) return !expandBraces(literalParens(p.slice(1))).some((alt) => coversBeneath(alt, d));
  return expandBraces(literalParens(p)).some((alt) => {
    const segs = segmentsOf(alt);
    if (!segs) return true;
    for (let i = 0; i < d.length; i++) {
      if (i >= segs.length) return false;
      if (segs[i] === "**") return true;
      // the prefix is matched as ONE pattern: a standalone `!cache` segment would read as a negation
      if (!filesGlob(segs.slice(0, i + 1).join("/"))(d.slice(0, i + 1).join("/"))) return false;
    }
    return segs.length > d.length;
  });
}

/**
 * Every non-directory path at or under `base`, decided later by filesGlob alone. NOTHING is pruned:
 * not .git, not node_modules, not ignored files, not the state dir — the declared glob is the only
 * narrowing (the literal base is exact: no match can sit outside it). A directory symlink is
 * followed so matches behind it are listed under the symlink's own path; a link back into its own
 * ancestry has no finite listing, so it refuses by name instead of being skipped.
 * ponytail: a rootless glob such as ** / *.txt walks node_modules too; narrow the glob if that is slow.
 */
function walkAll(repoRoot: string, base: string, io: PinScanIo): Walked {
  const out: Walked = { paths: [], causes: [] };
  const visit = (rel: string, chain: string[]) => {
    const abs = join(repoRoot, rel);
    let isDir: boolean;
    try {
      isDir = io.isDirectory(abs);
    } catch (error) {
      try {
        // only a confirmed ENOENT is a known non-directory: a broken link stays a candidate whose read names the cause
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          if (lstatSync(abs, { throwIfNoEntry: false })) out.paths.push(rel);
          return;
        }
      } catch { /* the lstat failed too: fall through to the refusal */ }
      // anything else may be a directory hiding obligations: never a candidate that a glob could filter away
      out.causes.push({ at: rel, why: `unstattable path ${rel || "."} (${cause(error)})`, maybeFile: true });
      return;
    }
    if (!isDir) {
      if (rel) out.paths.push(rel);
      return;
    }
    try {
      const real = realpathSync(abs);
      if (chain.includes(real)) {
        out.causes.push({ at: rel, why: `symlink cycle at ${rel} cannot be enumerated`, maybeFile: false });
        return;
      }
      for (const name of readdirSync(abs).sort()) visit(rel ? `${rel}/${name}` : name, [...chain, real]);
    } catch (error) {
      out.causes.push({ at: rel, why: `unlistable directory ${rel || "."} (${cause(error)})`, maybeFile: false });
    }
  };
  visit(base, []);
  return out;
}

/** Whole-file read, or a thrown cause: a short read is never evidence of absence. */
function readWhole(repoRoot: string, rel: string, io: PinScanIo): string {
  const abs = join(repoRoot, rel);
  let size: number;
  let bytes: Buffer;
  try {
    // a FIFO, socket or device has no finite whole to read: refuse it by kind before any read could block
    if (!io.isFile(abs)) throw new Error(`unsupported file ${rel} (not a regular file)`);
    size = io.size(abs);
    bytes = io.read(abs);
  } catch (error) {
    throw new Error(`unreadable file ${rel} (${cause(error)})`);
  }
  if (bytes.length !== size) throw new Error(`truncated read of ${rel} (${bytes.length} of ${size} bytes)`);
  return bytes.toString("utf8");
}

/** Each line of `content` holding `text`, 1-based. */
export function literalHits(path: string, content: string, text: string): LiteralHit[] {
  return content.split("\n").flatMap((line, i) => (line.includes(text) ? [{ path, line: i + 1 }] : []));
}

const pinName = (pin: Pin): string =>
  pin.kind === "literal" ? `literal ${JSON.stringify(pin.text)} in ${pin.glob}` : `fixture pin ${pin.paths.join(", ")}`;

/**
 * One line per uncovered obligation or uncertifiable scan; empty means every declared pin is covered
 * by the task that declares it. Ownership by any OTHER task — merged predecessor or downstream — is
 * named in the diagnostic and is no substitute.
 */
export function retiredLiteralErrors(
  tasks: ReadonlyArray<Pick<Task, "id" | "files" | "pins">>,
  repoRoot: string,
  io: PinScanIo = NODE_IO,
): string[] {
  const declaring = tasks.filter((t) => t.pins?.length);
  if (!declaring.length) return [];
  const walks = new Map<string, Walked>();
  const walked = (base: string): Walked => walks.get(base) ?? walks.set(base, walkAll(repoRoot, base, io)).get(base)!;
  const owns = new Map(tasks.map((t) => [t.id, filesGlob(t.files.map((f) => f.replace(/^\.\//, "")))]));
  const errors: string[] = [];
  for (const task of declaring) {
    const owner = (path: string): string => {
      const others = tasks.filter((t) => t.id !== task.id && owns.get(t.id)!(path)).map((t) => t.id);
      return others.length
        ? `owned by ${others.join(", ")}, which is no substitute: add it to ${task.id}.files[]`
        : `owned by no task: add it to ${task.id}.files[]`;
    };
    for (const pin of task.pins!) {
      const matches = filesGlob(patternsOf(pin));
      const found = [...new Set(patternsOf(pin).map((p) => literalBase(p.replace(/^\.\//, ""))))].map(walked);
      // a cause refuses only a pin that could match at or beneath it: a cycle under fixtures/sub never refuses fixtures/*.txt
      const affects = (c: WalkCause) => (c.maybeFile && matches(c.at)) || patternsOf(pin).some((p) => reachesBeneath(p, c.at));
      const causes = [...new Set(found.flatMap((w) => w.causes).filter(affects).map((c) => c.why))];
      for (const why of causes) errors.push(`${task.id}: ${pinName(pin)} refuses certification: ${why}`);
      const refused = causes.length > 0;
      const surface = [...new Set(found.flatMap((w) => w.paths))].filter(matches).sort();
      if (!surface.length) {
        if (refused) continue; // the refusal above already names why nothing was certified
        errors.push(`${task.id}: ${pinName(pin)} refuses certification: empty search surface (the pattern matches no file)`);
        continue;
      }
      for (const path of surface) {
        const owned = owns.get(task.id)!(path);
        // both kinds certify a whole-file read first: an owned fixture nobody could read is not evidence
        let content: string;
        try {
          content = readWhole(repoRoot, path, io);
        } catch (error) {
          errors.push(`${task.id}: ${pinName(pin)} refuses certification: ${cause(error)}`);
          continue;
        }
        if (pin.kind === "fixture") {
          if (!owned) errors.push(`${task.id}: ${pinName(pin)} obligates ${path}, outside ${task.id}.files[] (${owner(path)})`);
          continue;
        }
        const hits = literalHits(path, content, pin.text);
        if (owned) continue;
        for (const hit of hits) {
          errors.push(`${task.id}: ${pinName(pin)} still appears at ${hit.path}:${hit.line}, outside ${task.id}.files[] (${owner(path)})`);
        }
      }
    }
  }
  return errors;
}
