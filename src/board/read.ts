// The run board's reader (queue rows 331 and 332): a port of the operator's run board reader, the frozen oracle
// tests/fixtures/board/reference/summarize.py lines 425–560 (history_p50, suite_progress, expand, release_status and
// main), under tests/fixtures/board/PORT-RULES.md rules R1–R13. It reads files only: never git, never a process (R10).
// The one call beyond the file system is the lock's `process.kill(pid, 0)` liveness probe (R5), which spawns nothing.
import { readdirSync, readFileSync, realpathSync, statSync, lstatSync, type Dirent } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, resolve } from "node:path";
import { TaskSchema } from "../graph/schema.js";
import { summarize, tsEpoch, type PhaseHistory, type SuiteProgress } from "./summarize.js";
import { runTruth, type RunTruth } from "./run-truth.js";

export type ReleaseStage = { name: string; state: "pending" | "running" | "done" | "failed"; detail: string };
export type ReleaseSnapshot = {
  version: string; dir: string; ciRun: string | null; mirror: string | null; status: string; conclusion: string; polledAt: string;
  stages: ReleaseStage[];
};
/** Wire contract version 1 (R1): a full snapshot, or exactly the empty answer. */
export type RunBoard = (RunTruth & { // R13 (queue row 398): the summary with run-truth applied
  version: 1; readAt: string; release: ReleaseSnapshot | null; spec: string | null;
  /** R12 (queue row 393, D-2187 add.16): the release card's version when it is newer than this ended run, else null */
  supersededBy: string | null;
}) | { version: 1; empty: string };

// ---- Python semantics the reader needs (S1–S5; summarize.ts keeps its own copies private) ----

type Dict = Record<string, unknown>;
const isDict = (x: unknown): x is Dict => typeof x === "object" && x !== null && !Array.isArray(x);
const truthy = (x: unknown): boolean =>
  !(x === null || x === undefined || x === false || x === 0 || x === "" || (Array.isArray(x) && !x.length) || (isDict(x) && !Object.keys(x).length));
/** Python `d.get(k)`: no prototype membership; a non-dict throws. */
function get(d: unknown, k: string): unknown {
  if (!isDict(d)) throw new TypeError(`no attribute 'get' on ${JSON.stringify(d)}`);
  return Object.hasOwn(d, k) ? d[k] : null;
}
/** A dict key: a list or dict is unhashable; True and False are the keys 1 and 0. */
function hashable(x: unknown): unknown {
  if (Array.isArray(x) || isDict(x)) throw new TypeError("unhashable type");
  return x === true ? 1 : x === false ? 0 : x;
}
/** Python `len()`: a list's items, a dict's keys, a string's code points; anything else throws. */
function pyLen(x: unknown): number {
  if (Array.isArray(x)) return x.length;
  if (isDict(x)) return Object.keys(x).length;
  if (typeof x === "string") return [...x].length;
  throw new TypeError("object has no len()");
}

/** Strings by code point, never localeCompare (S5). */
function byCodePoint(a: string, b: string): number {
  for (let i = 0; ; ) {
    const x = a.codePointAt(i);
    const y = b.codePointAt(i);
    if (x === undefined || y === undefined) return x === y ? 0 : x === undefined ? -1 : 1;
    if (x !== y) return x - y;
    i += x > 0xffff ? 2 : 1;
  }
}

// str.isspace(); `\S` and strip() follow it, never JavaScript's whitespace (which adds U+FEFF and drops U+001C–U+001F).
const PY_WS = "\\t-\\r\\x1c-\\x20\\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000";
const LEAD_WS = new RegExp(`^[${PY_WS}]+`, "u");
const TRAIL_WS = new RegExp(`[${PY_WS}]+$`, "u");
const NON_WS = `[^${PY_WS}]`;
const IS_WS = new RegExp(`^[${PY_WS}]$`, "u");
const startsJson = (l: string): boolean => l.replace(LEAD_WS, "").startsWith("{");

/** A Unicode decimal digit's value: its offset in its run of ten consecutive Nd code points. */
function digitValue(cp: number): number {
  let k = 0;
  while (cp - k > 0 && /\p{Nd}/u.test(String.fromCodePoint(cp - k - 1))) k++;
  return k % 10;
}

/** Python `int()` (S2): numbers truncate toward zero; a string goes as CPython takes it (non-ASCII whitespace and
 *  decimal digits become ASCII, then ASCII whitespace around a sign and digits with single underscores). */
function pyInt(x: unknown): number {
  let n: number;
  if (typeof x === "boolean") n = Number(x);
  else if (typeof x === "number") n = Math.trunc(x);
  else if (typeof x === "string") {
    const ascii = x.replace(/[^\0-\x7e]/gu, (c) => IS_WS.test(c) ? " "
      : /^\p{Nd}$/u.test(c) ? String(digitValue(c.codePointAt(0) as number)) : "?");
    const m = /^[\t\n\v\f\r ]*([+-]?[0-9]+(?:_[0-9]+)*)[\t\n\v\f\r ]*$/.exec(ascii);
    if (!m) throw new TypeError(`invalid literal for int(): ${JSON.stringify(x)}`);
    n = Number(m[1].replaceAll("_", ""));
  } else throw new TypeError(`int() cannot convert ${JSON.stringify(x)}`);
  if (!Number.isSafeInteger(n)) throw new RangeError(`integer outside ±(2^53−1): ${n}`);
  return n === 0 ? 0 : n;
}

// ---- times (S1) ----

const two = (n: number): string => String(n).padStart(2, "0");
/** `datetime.fromtimestamp(t).strftime("%H:%M")` in the process's local zone. */
function hm(t: number): string {
  const d = new Date(Math.floor(Math.round(t * 1e6) / 1000));
  return `${two(d.getHours())}:${two(d.getMinutes())}`;
}
function dur(sec: number): string {
  const s = Math.trunc(Math.max(0, sec));
  return s >= 3600 ? `${Math.floor(s / 3600)}h ${two(Math.floor((s % 3600) / 60))}m` : s >= 60 ? `${Math.floor(s / 60)}m` : `${s}s`;
}

// ---- files and paths, with posixpath's string rules so a path reads back as it was given ----

const lexists = (p: string): boolean => { try { return lstatSync(p, { throwIfNoEntry: false }) !== undefined; } catch { return false; } };
const isDir = (p: string): boolean => { try { return statSync(p, { throwIfNoEntry: false })?.isDirectory() ?? false; } catch { return false; } };
const isFile = (p: string): boolean => { try { return statSync(p, { throwIfNoEntry: false })?.isFile() ?? false; } catch { return false; } };
const mtimeNs = (p: string): bigint | null => { try { return statSync(p, { bigint: true, throwIfNoEntry: false })?.mtimeNs ?? null; } catch { return null; } };
/** A path's PHYSICAL target (queue row 394, D-2187 add.52): libc realpath, as the kernel and Python resolve it, never
 *  node's realpathSync, which collapses `..` as text first (so `A/alias/..`, alias -> B/src, would read as A, not B).
 *  A path that does not exist is its longest existing prefix's real path with the rest appended. */
const realOr = (p: string): string => {
  try { return realpathSync.native(p); } catch {
    const up = dirname(p);
    return up === p ? resolve(p) : resolve(realOr(up), basename(p));
  }
};
/** A session path made absolute. A `..` segment names the parent of what the kernel reaches, so such a path is its
 *  physical target (D-2187 add.52); any other keeps its spelling, tidied (R2 shows its roots as the session spells them). */
const sessionPath = (cwd: string): string => (/(^|\/)\.\.(\/|$)/.test(cwd) ? realOr(cwd) : resolve(cwd));
const read = (p: string): string => readFileSync(p, "utf8");
/** Lines split on LF only (R4). */
const lfLines = (text: string): string[] => text.split("\n");

function pySplit(p: string): [string, string] {
  const i = p.lastIndexOf("/") + 1;
  const head = p.slice(0, i);
  return [head && !/^\/+$/.test(head) ? head.replace(/\/+$/, "") : head, p.slice(i)];
}
const pyJoin = (a: string, b: string): string => (b.startsWith("/") ? b : a === "" || a.endsWith("/") ? a + b : `${a}/${b}`);
/** os.path.join, never node's join: no `..` collapses as text, so every read goes where the kernel goes (D-2187 add.52). */
const join = (...parts: string[]): string => parts.reduce(pyJoin);

// ---- expand (R3): ~, then glob.glob's rules, each pattern's matches sorted by code point ----

const MAGIC = /[*?[]/;
const esc = (c: string): string => `\\u{${(c.codePointAt(0) as number).toString(16)}}`;

/** One `[...]` body (code points) as fnmatch.translate builds it (R3), so no class can make an invalid expression: a
 *  `-` after the first member (after `!` for a negated set), and not right after a range's end, joins its neighbours as
 *  a range; a trailing `-` is literal; a reversed range is dropped. Nothing left never matches, a lone `!` matches any
 *  one character, and every member is escaped, so `-`, `\`, `^`, `[` and `&&` are literals. */
function bracket(body: readonly string[]): string {
  let chunks: string[][] = [];
  let from = 0;
  for (let k = body[0] === "!" ? 2 : 1; (k = body.indexOf("-", k)) >= 0; k += 3) {
    chunks.push(body.slice(from, k));
    from = k + 1;
  }
  const rest = body.slice(from);
  if (rest.length || !chunks.length) chunks.push(rest);
  else chunks = [...chunks.slice(0, -1), [...chunks[chunks.length - 1], "-"]];
  for (let k = chunks.length - 1; k > 0; k--) { // a reversed range a-b (a > b by code point) matches nothing: drop it
    const [left, right] = [chunks[k - 1], chunks[k]];
    if ((left[left.length - 1].codePointAt(0) as number) > (right[0].codePointAt(0) as number)) {
      chunks = [...chunks.slice(0, k - 1), [...left.slice(0, -1), ...right.slice(1)], ...chunks.slice(k + 1)];
    }
  }
  const members = chunks.flat();
  if (!members.length) return "(?!)";
  if (members.length === 1 && members[0] === "!") return "[^]";
  const neg = members[0] === "!";
  const head = neg ? [chunks[0].slice(1), ...chunks.slice(1)] : chunks;
  return `[${neg ? "^" : ""}${head.map((c) => c.map(esc).join("")).join("-")}]`;
}

/** fnmatch.translate over one segment: `*` and `?` match within it, `[...]` and `[!...]` are classes, an unclosed `[`
 *  is literal. `**` is a single-segment `*` (glob without recursive). */
function fnmatch(pat: string): RegExp {
  const cs = [...pat];
  let re = "";
  for (let i = 0; i < cs.length; ) {
    const c = cs[i++];
    if (c === "*") re += "[^]*";
    else if (c === "?") re += "[^]";
    else if (c === "[") {
      let j = i;
      if (cs[j] === "!") j++;
      if (cs[j] === "]") j++;
      while (j < cs.length && cs[j] !== "]") j++;
      if (j >= cs.length) { re += "\\["; continue; }
      re += bracket(cs.slice(i, j));
      i = j + 1;
    } else re += esc(c);
  }
  return new RegExp(`^(?:${re})$`, "u");
}

/** glob._glob1: the names in `dir` matching one segment pattern; a wildcard never consumes a leading dot. */
function globIn(dir: string, pattern: string, dironly: boolean): string[] {
  let entries: Dirent[];
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return []; }
  const re = fnmatch(pattern);
  const dirEntry = (e: Dirent) => e.isDirectory() || (e.isSymbolicLink() && isDir(join(dir, e.name)));
  return entries.filter((e) => (pattern[0] === "." || e.name[0] !== ".") && re.test(e.name) && (!dironly || dirEntry(e))).map((e) => e.name);
}

/** glob._iglob, non-recursive: segments never cross a separator; a literal path must exist. */
function glob(pat: string, dironly = false): string[] {
  const [dir, base] = pySplit(pat);
  if (!MAGIC.test(pat)) return (base ? lexists(pat) : isDir(dir)) ? [pat] : [];
  const dirs = dir !== pat && MAGIC.test(dir) ? glob(dir, true) : [dir];
  return dirs.flatMap((d) => (MAGIC.test(base) ? globIn(d, base, dironly) : (base ? lexists(pyJoin(d, base)) : isDir(d)) ? [base] : [])
    .map((n) => pyJoin(d, n)));
}

function expand(cwd: string, patterns: readonly string[]): string[] {
  const home = (p: string) => (p === "~" || p.startsWith("~/") ? homedir().replace(/\/+$/, "") + p.slice(1) || "/" : p);
  const base = cwd.replace(/[*?[]/g, "[$&]"); // glob.escape: a relative pattern's folder is literal
  return patterns.map(home).flatMap((p) => glob(isAbsolute(p) ? p : pyJoin(base, p)).sort(byCodePoint));
}

/** Each real path once, first occurrence kept (R3). */
function once(paths: readonly string[]): string[] {
  const seen = new Set<string>();
  return paths.filter((p) => {
    const k = realOr(p);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

// ---- R2: the repository's checkouts, from git's own files ----

/** A git pointer file's path (after `prefix`, trailing CR and LF stripped) joined to `base` unnormalized, then read
 *  physically first (queue row 394, D-2187 add.52): its tidy spelling only when that names the same real path, else the
 *  real path, so `A/alias/../.git` (alias -> B/src) is B's `.git`, never A's. Null when absent. */
function pointer(file: string, prefix: string, base: string): string | null {
  let text: string;
  try { text = read(file).replace(/[\r\n]+$/, ""); } catch { return null; }
  if (!text.startsWith(prefix) || text.length === prefix.length) return null;
  const raw = join(base, text.slice(prefix.length));
  const real = realOr(raw);
  return realOr(resolve(raw)) === real ? resolve(raw) : real;
}

/** The checkout enclosing `path` (the nearest `.git` entry, a submodule's included), its git directory (null for an
 *  unreadable `.git` file, whose common directory is then that entry itself) and its common directory. Null outside
 *  every checkout, a bare repository included (R2). */
function enclosing(path: string): { checkout: string; gitDir: string | null; common: string } | null {
  let checkout = path;
  while (!lexists(join(checkout, ".git"))) {
    if (dirname(checkout) === checkout) return null;
    checkout = dirname(checkout);
  }
  const dotGit = join(checkout, ".git");
  const gitDir = isDir(dotGit) ? dotGit : pointer(dotGit, "gitdir: ", checkout);
  return { checkout, gitDir, common: gitDir === null ? dotGit : pointer(join(gitDir, "commondir"), "", gitDir) ?? gitDir };
}

/** The git-file worktree walk (R2), never running git: the enclosing checkout, the main checkout when the common
 *  directory is a `.git`, then each `<common>/worktrees/<name>/gitdir` checkout whose `.git` entry still exists.
 *  Outside a repository (a bare one included) it is `<cwd>` alone. */
function checkouts(cwd: string): string[] {
  const at = enclosing(cwd);
  if (at === null) return [cwd];
  if (at.gitDir === null) return [at.checkout];
  const { checkout, common } = at;
  const admins = join(common, "worktrees");
  let names: string[] = [];
  try { names = readdirSync(admins).sort(byCodePoint); } catch { /* no linked worktrees */ }
  const linked = names.flatMap((n) => {
    const target = pointer(join(admins, n, "gitdir"), "", join(admins, n));
    return target !== null && mtimeNs(target) !== null ? [dirname(target)] : []; // a missing or stale entry is skipped
  });
  return [checkout, ...(basename(common) === ".git" ? [dirname(common)] : []), ...linked];
}

// ---- R11 (queue row 394, D-2187 add.16, add.29 and add.52): only the session's own project, identity read from git's own files ----

type Identity = { common: string; readable: boolean; hop: string | null };

/** The origin URL by R11's closed FORMAT table (D-2187 add.29), a whitelist and never a git-config parser: the one
 *  `url = <value>` line under the line that is exactly `[remote "origin"]`, its value bare (no quote or backslash; a
 *  whitespace-prefixed trailing `#` or `;` comment stripped, so a `#` or `;` with none before it, and inner whitespace,
 *  stay in the value) or one fully double-quoted string with no quote or backslash inside. Every other input is
 *  UNREADABLE (null): no config, any continuation line, an include or includeIf section, origin's section spelled any
 *  other way (the single-line form included), a header line that is not wholly `[name]` or `[name "sub"]` (trailing
 *  text included), no url line, two url lines, or a value in neither form (partial quotes, escapes, only a comment). */
function originUrl(common: string): string | null {
  let text: string;
  try { text = read(join(common, "config")); } catch { return null; }
  const lines = text.split(/\r?\n/);
  if (lines.some((l) => l.endsWith("\\"))) return null; // a continuation folds the next line, a header included, into a value
  let inOrigin = false;
  const urls: string[] = [];
  for (const line of lines) {
    const t = line.trim();
    if (t.startsWith("[")) {
      inOrigin = t === '[remote "origin"]';
      if (inOrigin) continue;
      const head = /^\[\s*([A-Za-z0-9.-]+)(?:\s+"([^"\\]*)")?\s*\]$/.exec(t); // the whole line
      if (!head) return null;
      const [section, ...dotted] = head[1].toLowerCase().split(".");
      const sub = head[2] ?? dotted.join(".");
      if (section === "include" || section === "includeif" || (section === "remote" && sub === "origin")) return null;
    } else if (inOrigin && /^url(?![A-Za-z0-9-])/i.test(t)) urls.push(t);
  }
  const value = urls.length === 1 ? /^url\s*=(.*)$/.exec(urls[0])?.[1].trim() : undefined;
  if (value === undefined) return null;
  const quoted = /^"([^"\\]+)"$/.exec(value);
  if (quoted) return quoted[1];
  const bare = value.replace(/(?:^|\s)[#;].*$/, "").trim(); // the first whitespace-prefixed comment, to the line's end
  return bare && !/["\\]/.test(bare) ? bare : null;
}

/** What an origin read by the FORMAT table says (D-2187 add.29 row 4, add.52 points 2b and 3): an ABSOLUTE local path
 *  is a hop to the PHYSICAL common directory of the checkout enclosing its real path (that real path outside every
 *  checkout); a network URL (a `scheme://` URL other than `file://`, or an scp-like `host:path` whose first `:` has no
 *  `/` before it) is readable but never matches, so its hop is null; anything else (a relative path, a `file://` URL,
 *  an absolute path that does not resolve) is UNREADABLE (null). No URL is normalized: none is ever compared. */
function originHop(url: string): { hop: string | null } | null {
  if (url.startsWith("/")) {
    let real: string;
    try { real = realpathSync.native(url); } catch { return null; } // `..` resolved physically (D-2187 add.52)
    const at = enclosing(real);
    return { hop: at ? realOr(at.common) : real };
  }
  const scheme = /^([a-z][a-z0-9+.-]*):\/\//i.exec(url);
  if (scheme) return scheme[1].toLowerCase() === "file" ? null : { hop: null };
  const colon = url.indexOf(":");
  return colon > 0 && !url.slice(0, colon).includes("/") ? { hop: null } : null;
}

/** The project of a checkout walk's result: its physical common directory, whether its config is READABLE by the FORMAT
 *  table, and its local origin's hop; null outside every checkout. */
function identity(at: ReturnType<typeof enclosing>): Identity | null {
  if (at === null) return null;
  const url = originUrl(at.common);
  const origin = url === null ? null : originHop(url);
  return { common: realOr(at.common), readable: origin !== null, hop: origin?.hop ?? null };
}

/** R11's narrowed rule (queue row 394, D-2187 add.52), which replaces every earlier one: the same project ONLY when the
 *  physical common directories are equal, or, with BOTH configs readable, one side's absolute local origin hops to the
 *  other's common directory (one hop, never a chain). A network URL never matches; UNREADABLE on either side is the
 *  common directory alone, checked first. */
const sameProject = (a: Identity, b: Identity): boolean => a.common === b.common
  || (a.readable && b.readable && (a.hop === b.common || b.hop === a.common));

/** The given paths split into the session's project and the rest; a session outside every repository counts all (R3).
 *  The session path and each given path are read at their physical targets (D-2187 add.29, add.52), so a symlink counts as the
 *  project it points into, never the one it sits in or its spelling; R2's own roots are read the same way. */
function ownProject(cwd: string, paths: readonly string[]): { counted: string[]; ignored: string[] } {
  const own = identity(enclosing(realOr(cwd)));
  if (own === null) return { counted: [...paths], ignored: [] };
  const keep = paths.map((p) => { const id = identity(enclosing(realOr(p))); return id !== null && sameProject(own, id); });
  return { counted: paths.filter((_, i) => keep[i]), ignored: paths.filter((_, i) => !keep[i]) };
}

/** R2's state roots, of the session's own project (queue row 394, D-2187 add.29). The walk starts at `<cwd>` as given
 *  when its physical target sits in the same checkout (or both sit outside every checkout), so its spelling is kept;
 *  a symlink into another checkout, or out of every checkout, walks from the real path, since the target decides. A
 *  root that is itself a symlink to another project's state, or out of every checkout, is ignored like a given root. */
function ownCheckoutRoots(at: string): { counted: string[]; ignored: string[] } {
  const lexical = enclosing(at);
  const physical = enclosing(realOr(at));
  const same = lexical === null || physical === null ? lexical === physical : realOr(lexical.checkout) === realOr(physical.checkout);
  return ownProject(at, checkouts(same ? at : realOr(at)).map((c) => join(c, ".tickmarkr")));
}

/** The state roots in search order: the session's own R2 roots (always first), then each given root's expansion (R3)
 *  that is the session's own project (R11); `ignored` names every root another project's, R2's first; `repo` is R2's
 *  counted roots (R6a's history pool). */
function searchRoots(cwd: string, roots: readonly string[]): { counted: string[]; ignored: string[]; repo: string[] } {
  const at = sessionPath(cwd);
  const repo = ownCheckoutRoots(at);
  const given = ownProject(at, expand(at, roots));
  return { counted: once([...repo.counted, ...given.counted]), ignored: once([...repo.ignored, ...given.ignored]), repo: repo.counted };
}

/** The state roots, searched in this order: the repository's checkouts (R2), then each counted given root (R3, R11). */
export function stateRoots(cwd: string, roots: readonly string[]): string[] {
  return searchRoots(cwd, roots).counted;
}

// ---- history_p50 (R6) and suite_progress (R7) ----

/** Typical phase times over the newest six other journals across `pool`, runs folders in pool order (R6, R6a). */
function historyP50(pool: readonly string[], exclude: string): PhaseHistory {
  const w: number[] = [];
  const sem: number[] = [];
  const test: number[] = [];
  // The whole pool sorts by mtime, then by run-folder name, so the later name wins a tie whichever checkout holds it (R4).
  const journals = pool.flatMap((runsDir) => globIn(runsDir, "*", true).filter((n) => n !== exclude)
    .flatMap((n) => { const j = join(runsDir, n, "journal.jsonl"); const t = mtimeNs(j); return t === null ? [] : [{ j, t, n }]; }))
    .sort((a, b) => (a.t < b.t ? -1 : a.t > b.t ? 1 : byCodePoint(a.n, b.n)));
  for (const { j } of journals.slice(-6)) {
    const openW = new Map<unknown, number>();
    const openS = new Map<unknown, [number, number]>();
    for (const line of lfLines(read(j))) {
      if (!line.startsWith("{")) continue;
      try {
        const e = JSON.parse(line);
        const ev = get(e, "event");
        const tid = get(e, "taskId");
        const d = truthy(get(e, "data")) ? get(e, "data") : {};
        const t = () => tsEpoch(get(e, "ts"));
        if (ev === "phase-start" && get(d, "phase") === "worker") {
          const at = t();
          openW.set(hashable(tid), at);
        } else if (ev === "worker-result" && openW.has(hashable(tid))) {
          const at = t();
          w.push(at - (openW.get(hashable(tid)) as number));
          openW.delete(hashable(tid));
        } else if (ev === "phase-start" && get(d, "phase") === "judge") {
          const at = t();
          openS.set(hashable(tid), [at, 0]);
        } else if (ev === "gate-result" && ["acceptance", "review"].includes(get(d, "gate") as string) && openS.has(hashable(tid))) {
          // every verdict's ts is read before it counts, so a malformed one leaves the round as it was (R6)
          const at = t();
          const [start, seen] = openS.get(hashable(tid)) as [number, number];
          if (seen + 1 === 2) { // both verdicts in: the round lasted until the later one
            sem.push(at - start);
            openS.delete(hashable(tid));
          } else openS.set(hashable(tid), [start, seen + 1]);
        } else if (ev === "gate-result" && get(d, "gate") === "test" && truthy(get(d, "pass"))) {
          const ms = truthy(get(d, "durationMs")) ? get(d, "durationMs") : 0;
          if (typeof ms !== "number" && typeof ms !== "boolean") throw new TypeError("'>' not supported");
          if (Number(ms) > 60000) test.push(Number(ms) / 1000);
        }
      } catch { continue; } // a malformed line is skipped whole: each branch reads what it uses before changing state (R6)
    }
  }
  const p50 = (xs: number[]) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] : null); // the upper middle
  return { worker: p50(w), semantics: p50(sem), test: p50(test) };
}

function suiteProgress(runDir: string): Record<string, SuiteProgress> {
  const out = new Map<string, SuiteProgress>();
  for (const name of globIn(runDir, "test-manifest-report-*.json.job.json", false).sort(byCodePoint)) { // the last job by name wins
    const jobPath = join(runDir, name);
    try {
      const job = JSON.parse(read(jobPath));
      if (get(job, "state") !== "running") continue;
      const rep = JSON.parse(read(jobPath.slice(0, -".job.json".length)));
      const done = truthy(get(rep, "completed")) ? get(rep, "completed") : {};
      if (!isDict(done)) throw new TypeError("completed has no items()");
      const requested = truthy(get(rep, "requested")) ? get(rep, "requested") : [];
      const progress = { done: Object.keys(done).length, total: pyLen(requested),
        failing: Object.keys(done).filter((k) => isDict(done[k]) && get(done[k], "status") === "failed").sort(byCodePoint) };
      const subject = truthy(get(job, "subject")) ? get(job, "subject") : {};
      const tid = hashable(get(subject, "taskId"));
      if (typeof tid === "string") out.set(tid, progress); // any other key matches no task id
    } catch { continue; } // an unreadable or malformed pair (a report mid-write) reads at the next poll (R7)
  }
  return Object.fromEntries(out);
}

// ---- R5: the lock, matched by the run folder's name ----

function lockState(root: string, runName: string): { pid: number | null; alive: boolean | null } {
  let lock: unknown;
  try { lock = JSON.parse(read(join(root, "graph.lock"))); } catch { return { pid: null, alive: false }; }
  if (!isDict(lock)) return { pid: null, alive: false };
  // the folder name, never the journal's runId: a lock for another run says nothing about this one
  if (get(lock, "runId") !== runName) return { pid: null, alive: null };
  let pid: number;
  try { pid = pyInt(Object.hasOwn(lock, "pid") ? lock.pid : undefined); } catch { return { pid: null, alive: false }; }
  try {
    process.kill(pid, 0); // zero and negative pids are probed as Python's os.kill probes them
    return { pid, alive: true };
  } catch {
    return { pid, alive: false };
  }
}

// ---- R9: input validation, before summarizing ----

const RUN_ID = /^run-[A-Za-z0-9][A-Za-z0-9_-]*$/; // parseRunId's rule (src/run/journal.ts; importing it would load git)

function validateGraph(graph: unknown): void {
  const tasks = isDict(graph) && Object.hasOwn(graph, "tasks") ? graph.tasks : [];
  if (!Array.isArray(tasks)) throw new Error("graph.json: tasks is not a list");
  const deps = new Map<string, unknown[]>();
  for (const t of tasks) {
    const id = isDict(t) && Object.hasOwn(t, "id") ? t.id : undefined;
    if (typeof id !== "string" || !TaskSchema.shape.id.safeParse(id).success) throw new Error(`graph.json: unsafe task id ${JSON.stringify(id)}`);
    const ds = isDict(t) && Object.hasOwn(t, "deps") ? t.deps : [];
    if (!Array.isArray(ds)) throw new Error(`graph.json: task ${id} deps is not a list`);
    deps.set(id, ds);
  }
  for (const [id, ds] of deps) {
    for (const d of ds) if (typeof d !== "string" || !deps.has(d)) throw new Error(`graph.json: task ${id} depends on unknown task ${JSON.stringify(d)}`);
  }
  // ponytail: O(n²) peel of tasks whose deps are all gone; a graph is tens of tasks
  const left = new Map(deps);
  for (let peeled = true; peeled; ) {
    peeled = false;
    for (const [id, ds] of left) if (ds.every((d) => !left.has(d as string))) { left.delete(id); peeled = true; }
  }
  if (left.size) throw new Error(`graph.json: dependency cycle among ${[...left.keys()].join(", ")}`);
}

/** The run id summarize will report (its run-start, run-resume and run-end rules), falling back to the run folder's
 *  name, checked before summarizing. A non-string value summarize would render through str() can never pass. */
function validRunId(events: readonly Dict[], folder: string): string {
  let id: unknown = "";
  for (const e of events) {
    const ev = get(e, "event");
    const d = Object.hasOwn(e, "data") ? e.data : {};
    if (!isDict(d)) continue; // summarize rejects that event itself
    if ((ev === "run-start" || ev === "run-resume") && !truthy(id)) {
      const v = Object.hasOwn(d, "runId") ? d.runId : "";
      id = typeof v === "string" ? v : JSON.stringify(v);
    }
    if (ev === "run-end" && Object.hasOwn(d, "runId")) id = d.runId;
  }
  const runId = truthy(id) ? id : folder;
  if (typeof runId !== "string" || !RUN_ID.test(runId)) throw new Error(`unsafe run id ${JSON.stringify(runId)}`);
  return runId;
}

// ---- R8 and R8a: the release card ----

const CI_HEAD = /^--- CI run (\p{Nd}+) on ([\p{L}\p{N}_]+) \((?:release|recut) ([\p{L}\p{N}_]+)\)/u;
const POLL = new RegExp(`^(\\p{Nd}{4}-\\p{Nd}\\p{Nd}-\\p{Nd}\\p{Nd}T${NON_WS}+Z) (${NON_WS}+)(?: (${NON_WS}+))?$`, "u");
const NPM_VERSION = new RegExp(`NPM_VERSION=(${NON_WS}*)`, "u");

/** release_status over one folder (R8). Without a ci-watch.log the CI part is pending (R8a). */
function releaseCard(folder: string, now: number): ReleaseSnapshot {
  const dir = pySplit(pyJoin(folder, "ci-watch.log"))[0];
  const text = (name: string): string | null => (isFile(pyJoin(dir, name)) ? read(pyJoin(dir, name)) : null);
  const log = text("ci-watch.log");
  let card = { ciRun: null as string | null, mirror: null as string | null, status: "pending", conclusion: "", polledAt: "" };
  let ci: [ReleaseStage["state"], string] = ["pending", ""];
  if (log !== null) {
    // universal newlines, as Python's text-mode file iteration reads it; the watcher writes a trailing space, so trim
    const lines = log.split(/\r\n|\r|\n/).filter((l) => l.replace(LEAD_WS, "")).map((l) => l.replace(TRAIL_WS, ""));
    const last = lines.reduce((at, l, i) => (l.startsWith("--- CI run ") ? i : at), -1); // the last section wins, malformed or not
    const head = last >= 0 ? CI_HEAD.exec(lines[last]) : null;
    const polls = lines.slice(last + 1).map((l) => POLL.exec(l)).filter((m): m is RegExpExecArray => m !== null);
    const [status, conclusion] = polls.length ? [polls[polls.length - 1][2], polls[polls.length - 1][3] ?? ""] : ["unknown", ""];
    const since = polls.length ? tsEpoch(polls[0][1]) : null;
    card = { ciRun: head?.[1] ?? null, mirror: head?.[2] ?? null, status, conclusion,
      polledAt: polls.length ? hm(tsEpoch(polls[polls.length - 1][1])) : "" };
    ci = status !== "completed" ? ["running", since ? dur(now - since) : ""] : conclusion === "success" ? ["done", "green"] : ["failed", conclusion || "red"];
  }
  const script = text("tag-and-publish.sh") || "";
  const v = /(?<![\p{L}\p{N}_])V=v?([\p{Nd}.]+)/u.exec(script) ?? /(\p{Nd}+\.\p{Nd}+\.\p{Nd}+)/u.exec(dir.slice(dir.lastIndexOf("/") + 1));
  const version = v ? v[1] : "";
  const tagLog = text("tag-and-publish.log");
  const pub = text("publish.log") || "";
  const tag: [ReleaseStage["state"], string] = tagLog === null ? ["pending", ""] : tagLog.includes("TAG-PUSHED") ? ["done", ""] : ["failed", "stopped"];
  const npm = NPM_VERSION.exec(pub);
  const pubState: [ReleaseStage["state"], string] = npm && npm[1] === version ? ["done", npm[1]]
    : pub.includes("RELEASE-DONE completed failure") ? ["failed", "release red"] : tag[0] === "done" ? ["running", ""] : ["pending", ""];
  return { version, dir, ...card, stages: [
    { name: "CI", state: ci[0], detail: ci[1] },
    { name: "tag", state: tag[0], detail: tag[1] },
    { name: "npm", state: pubState[0], detail: pubState[1] },
    { name: "main", state: text("backup-push.log") !== null ? "done" : "pending", detail: "" },
  ] };
}

/** The expanded release folders, split into the session's project and the rest (R11). */
function releaseFolders(cwd: string, releases: readonly string[]): { counted: string[]; ignored: string[] } {
  const at = sessionPath(cwd);
  return ownProject(at, once(expand(at, releases)));
}

/** The card follows the release being worked on (R8a): among the counted folders holding a regular file, the one
 *  whose newest file is newest (`t`), the later name winning a tie. Null when none holds a file. */
function chooseRelease(dirs: readonly string[]): { dir: string; t: bigint; name: string } | null {
  let best: { dir: string; t: bigint; name: string } | null = null;
  for (const dir of dirs) {
    let names: string[];
    try { names = readdirSync(dir); } catch { continue; }
    const times = names.filter((n) => isFile(join(dir, n))).map((n) => mtimeNs(join(dir, n))).filter((t): t is bigint => t !== null);
    if (!times.length) continue;
    const t = times.reduce((a, b) => (b > a ? b : a));
    const name = basename(dir);
    if (!best || t > best.t || (t === best.t && byCodePoint(name, best.name) > 0)) best = { dir, t, name };
  }
  return best;
}

/** The release card (R8a) over the session's own project's release folders (R11). */
export function readRelease(cwd: string, releases: readonly string[], now: number): ReleaseSnapshot | null {
  const best = chooseRelease(releaseFolders(cwd, releases).counted);
  return best && releaseCard(best.dir, now);
}

// ---- main ----

/** The spec a run builds (R1, queue row 335): its graph's first spec path's file name without `.spec.md`, else null. */
function specName(graph: unknown): string | null {
  const spec = isDict(graph) && Object.hasOwn(graph, "spec") ? graph.spec : undefined;
  const paths = isDict(spec) && Object.hasOwn(spec, "paths") ? spec.paths : undefined;
  return Array.isArray(paths) && typeof paths[0] === "string" ? basename(paths[0]).replace(/\.spec\.md$/, "") : null;
}

/** The newest run across the state roots, as wire contract version 1 (R1), at `now` (epoch seconds). Invalid input
 *  throws a nonempty error (R9). */
export function readRunBoard(cwd: string, roots: readonly string[], releases: readonly string[], now: number): RunBoard {
  const { counted: searched, ignored, repo } = searchRoots(cwd, roots);
  const releaseDirs = releaseFolders(cwd, releases);
  let best: { root: string; runs: string; name: string; t: bigint } | null = null;
  for (const root of searched) {
    const runs = join(root, "runs");
    if (!isDir(runs)) continue;
    for (const name of readdirSync(runs).sort(byCodePoint)) { // name order, then the newest mtime; the later name wins a tie (R4)
      const t = mtimeNs(join(runs, name, "journal.jsonl"));
      if (t !== null && (!best || t > best.t || (t === best.t && byCodePoint(name, best.name) > 0))) best = { root, runs, name, t };
    }
  }
  if (!best) {
    const foreign = [...ignored, ...releaseDirs.ignored]; // R11: never searched, but named so the empty board says why
    const under = searched.length ? ` under ${searched.join(", ")}` : ""; // every R2 root may be another project's (row 394)
    return { version: 1, empty: `no tickmarkr run${under}${foreign.length ? `; ignored as another project's: ${foreign.join(", ")}` : ""}` };
  }
  const runDir = join(best.runs, best.name);
  // The line is the --park token. The reader numbers every line itself, overriding any `_line` the journal carries, so
  // each park line is a positive integer before summarizing (R9).
  const events: Dict[] = lfLines(read(join(runDir, "journal.jsonl")))
    .flatMap((l, i) => (startsJson(l) ? [{ ...JSON.parse(l), _line: i + 1 }] : []));
  const graphPath = join(runDir, "graph.json");
  const graph: unknown = mtimeNs(graphPath) !== null ? JSON.parse(read(graphPath)) : { tasks: [] };
  const telPath = join(runDir, "telemetry.jsonl");
  const telemetry = mtimeNs(telPath) !== null ? lfLines(read(telPath)).filter(startsJson).map((l) => JSON.parse(l)) : [];
  validateGraph(graph); // R9: task ids, dependencies and the run id are checked before summarize sees them
  const runId = validRunId(events, best.name);
  const { pid, alive } = lockState(best.root, best.name);
  // R6a (queue row 334): a run in one of the repository's checkouts reads history from every checkout's runs folder, so
  // a fresh worktree still gets the repository's typical times; a run under a named root reads only its own folder.
  const pool = repo.includes(best.root) ? once(repo).map((r) => join(r, "runs")) : [best.runs];
  const hist = historyP50(pool, best.name);
  // R13 (queue row 398, D-2187 add.24): a run that cannot finish says so and names its roots, and each failed task
  // adds its retry entry beside the park entries
  const summary = runTruth(summarize(events, graph, pid, alive, now, hist, telemetry, suiteProgress(runDir)), events);
  const needsYou = summary.needsYou.map((n) => ({ ...n, cmd: n.cmd.replaceAll("{run}", () => runId) }));
  const at = new Date(Math.floor(now) * 1000);
  const readAt = `${two(at.getHours())}:${two(at.getMinutes())}:${two(at.getSeconds())}`;
  // R6b (queue row 334): without a worker sample every phase would schedule at 0 s and floor at a minute, so no ETA.
  // R13 (queue row 398, D-2187 add.24): a run that cannot finish promises no time, so it needs no sample and keeps its
  // stop and roots (its critical path is the graph's alone)
  const eta = summary.eta?.cannotFinish || (hist.worker !== null && hist.worker !== undefined) ? summary.eta : null;
  const chosen = chooseRelease(releaseDirs.counted);
  const release = chosen && releaseCard(chosen.dir, now);
  // R12 (queue row 393): an ended run older than the chosen card's newest file is not the newest run the release made
  const supersededBy = release && chosen && summary.ended && summary.endEpoch !== null
    && chosen.t > BigInt(Math.round(summary.endEpoch * 1000)) * 1_000_000n ? release.version || chosen.name : null; // ms-exact ts
  return { version: 1, ...summary, runId, needsYou, eta, readAt, release, spec: specName(graph), supersededBy };
}
