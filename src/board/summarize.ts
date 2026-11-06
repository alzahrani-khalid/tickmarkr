// The run board's summarizer (queue rows 331 and 332): a port of the operator's run board summarizer, the frozen oracle
// tests/fixtures/board/reference/summarize.py lines 15–422 (constants through summarize), under tests/fixtures/board/PORT-RULES.md
// rules S1–S7. It is pure: no file, process or clock — the caller passes events, graph, lock, now, history and suites.
// Names follow the reference so the two read side by side; every Python idiom goes through a helper below that keeps
// Python's semantics (truthiness, `or`, `get`, `int`, `round`, `str`, `splitlines`, code-point slices and order).

export type AttemptPart = { text: string; tone: "pass" | "fail" | "wait" | "open"; reason?: string; since?: number };
export type AttemptLine = { att: number; start: string; parts: AttemptPart[] };
export type TaskRow = {
  id: string;
  title: string;
  state: "pending" | "worker" | "waiting" | "gates" | "parked" | "done" | "failed";
  attempt: number;
  dispatched: boolean;
  budget: number;
  launches: number;
  gates: Record<string, "pass" | "fail">;
  note: string;
  deps: string[];
  blocks: string[];
  worker: string;
  judge: string;
  reviewer: string;
  suiteWaiting: boolean;
  now: string;
  nowSince: number | null;
  history: AttemptLine[];
  startEpoch: number | null;
  endEpoch: number | null;
  startedAt: string;
  endedAt: string;
  tokens: { input: number; output: number; cacheRead: number } | null;
};
export type NeedsYou = { task: string; kind: string; reason: string; since: number; blocks: string[]; cmd: string };
export type RunSummary = {
  runId: string;
  alive: boolean | null;
  pid: number | null;
  elapsedMin: number;
  ended: { done: string[]; failed: string[]; human: string[]; blocked: string[]; pending: string[]; tipVerify: string | null; owed: number | null } | null;
  tasks: TaskRow[];
  needsYou: NeedsYou[];
  approvalWindow: { closesAt: number; parked: string[] } | null;
  eta: { cleanMin: number; oneRepairMin: number; criticalPath: string[]; stoppedBy: string[] } | null;
  atEpoch: number;
  startEpoch: number | null;
  endEpoch: number | null;
};
export type SuiteProgress = { done: number; total: number; failing: string[] };
export type PhaseHistory = { worker?: number | null; semantics?: number | null; test?: number | null };

// A decoded JSON value used the way the reference uses it: every access goes through the Python-semantics helpers.
type Py = any;
type Span = { kind: string; att: number; t0: number; t1: number | null; outcome: string; [k: string]: Py };

// ---- Python semantics (S2–S5) ----

const PY_SPACE = new Set([9, 10, 11, 12, 13, 0x1c, 0x1d, 0x1e, 0x1f, 0x20, 0x85, 0xa0, 0x1680, 0x2000, 0x2001, 0x2002, 0x2003, 0x2004,
  0x2005, 0x2006, 0x2007, 0x2008, 0x2009, 0x200a, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000]); // str.isspace()
const PY_LINE_BREAK = new Set([10, 11, 12, 13, 0x1c, 0x1d, 0x1e, 0x85, 0x2028, 0x2029]); // str.splitlines()
const isSpace = (s: string, i: number): boolean => PY_SPACE.has(s.charCodeAt(i));

const isDict = (x: Py): boolean => typeof x === "object" && x !== null && !Array.isArray(x);

/** Python truthiness: None, False, zero, and empty strings, lists and dicts are false. */
function truthy(x: Py): boolean {
  if (x === null || x === undefined || x === false || x === 0 || x === "") return false;
  if (Array.isArray(x)) return x.length > 0;
  if (isDict(x)) return Object.keys(x).length > 0;
  return true;
}

/** Python `a or b`: an operand, never `??`. Only for a right operand that is safe to evaluate eagerly. */
const or = (a: Py, b: Py): Py => (truthy(a) ? a : b);

/** Python `d.get(k, default)`: the default only when the key is absent; no prototype membership; a non-dict throws. */
function get(d: Py, k: Py, dflt: Py = null): Py {
  if (!isDict(d)) throw new TypeError(`${pyType(d)} has no attribute 'get'`);
  return typeof k === "string" && Object.hasOwn(d, k) ? d[k] : dflt;
}

/** Python `d[k]`: a missing key throws. */
function item(d: Py, k: Py): Py {
  if (!isDict(d) || typeof k !== "string" || !Object.hasOwn(d, k)) throw new TypeError(`KeyError: ${str(k)}`);
  return d[k];
}

/** A value used as a dict key or set member: a list or dict is unhashable in Python, so it throws. */
function key(x: Py): Py {
  if (Array.isArray(x) || isDict(x)) throw new TypeError(`unhashable type: '${pyType(x)}'`);
  return x;
}

const has = (m: Map<Py, unknown> | Set<Py>, k: Py): boolean => m.has(key(k));

/** Python `rows[k]` on a Map: a missing key throws. */
function must<V>(m: Map<Py, V>, k: Py): V {
  if (!has(m, k)) throw new TypeError(`KeyError: ${str(k)}`);
  return m.get(k) as V;
}

const mapGet = <V>(m: Map<Py, V>, k: Py, dflt: V): V => (has(m, k) ? (m.get(k) as V) : dflt);

function pyType(x: Py): string {
  return x === null || x === undefined ? "NoneType" : Array.isArray(x) ? "list" : typeof x;
}

/** Iterating a value as Python does: a list's items, a string's code points, a dict's keys; anything else throws. */
function iter(x: Py): Py[] {
  if (Array.isArray(x)) return x;
  if (typeof x === "string") return [...x];
  if (isDict(x)) return Object.keys(x);
  throw new TypeError(`'${pyType(x)}' object is not iterable`);
}

const list = (x: Py): Py[] => [...iter(x)];
const len = (x: Py): number => iter(x).length;

/** An integer result that must stay exact (S2); a zero result is positive zero. */
function safe(n: number): number {
  if (!Number.isSafeInteger(n)) throw new RangeError(`integer outside ±(2^53−1): ${n}`);
  return n === 0 ? 0 : n;
}

/** A number taking part in arithmetic, as Python allows: a number or a bool. */
function num(x: Py): number {
  if (typeof x === "boolean") return Number(x);
  if (typeof x !== "number") throw new TypeError(`unsupported operand type: '${pyType(x)}'`);
  return Number.isInteger(x) ? safe(x) : x;
}

/** Python `a + b + …` and `a - b`, left to right: Python's integers are exact, so every partial result JavaScript
 *  holds as an integer must stay within ±(2^53−1) before it is used (S2). */
const plus = (...xs: number[]): number => xs.reduce((acc, x) => num(acc + x), 0);
const minus = (a: number, b: number): number => num(a - b);

/** S2: every integer in the input must be exact. JSON.parse already rounded any larger one, so it throws here, before
 *  any of it is read, echoed or summed. */
function exactInput(...xs: Py[]): void {
  const seen = new Set<object>();
  const stack = [...xs];
  while (stack.length) {
    const x = stack.pop();
    if (typeof x === "number") num(x);
    else if (typeof x === "object" && x !== null && !seen.has(x)) {
      seen.add(x);
      for (const v of Object.values(x)) stack.push(v);
    }
  }
}

/** S2: a zero result is positive zero. The summary echoes input values (the lock pid, now, task ids and titles, run-end
 *  lists) and JSON.parse reads "-0" as negative zero, so the returned summary is a copy with every one made positive. */
// ponytail: recursion, so a cyclic input (never JSON) overflows the stack and throws
const positiveZero = (x: Py): Py => typeof x === "number" ? (x === 0 ? 0 : x) : Array.isArray(x) ? x.map(positiveZero)
  : isDict(x) ? Object.fromEntries(Object.entries(x).map(([k, v]) => [k, positiveZero(v)])) : x;

/** A Unicode decimal digit's value. Unicode assigns decimal digits (Nd) only in runs of ten ascending from zero, so
 *  the value is the digit's offset in its run of consecutive Nd code points, mod 10. */
function decimalValue(cp: number): number {
  let k = 0;
  while (cp - k > 0 && /\p{Nd}/u.test(String.fromCodePoint(cp - k - 1))) k++;
  return k % 10;
}

/** Python `int()`: numbers truncate toward zero; anything else but a string throws. A string goes as CPython takes
 *  it: each non-ASCII whitespace becomes a space and each non-ASCII decimal digit its ASCII digit (any other non-ASCII
 *  character fails), then only ASCII whitespace (tab, LF, VT, FF, CR, space — never U+001C–U+001F) is skipped around a
 *  sign and digits with single underscores between them. */
function int(x: Py): number {
  if (typeof x === "number") return safe(Math.trunc(x));
  if (typeof x === "boolean") return Number(x);
  // ponytail: Nd follows this engine's Unicode version; a Python on an older one refuses digits added since
  const ascii = typeof x === "string"
    ? x.replace(/[^\0-\x7e]/gu, (c) => {
      const cp = c.codePointAt(0) as number;
      return PY_SPACE.has(cp) ? " " : /^\p{Nd}$/u.test(c) ? String(decimalValue(cp)) : "?";
    })
    : "";
  const m = /^[\t\n\v\f\r ]*([+-]?[0-9]+(?:_[0-9]+)*)[\t\n\v\f\r ]*$/.exec(ascii);
  if (!m) throw new TypeError(`invalid literal for int(): ${JSON.stringify(x)}`);
  return safe(Number(m[1].replaceAll("_", "")));
}

/** Python `round(x)`: round half to even, an exact integer, positive zero. */
export function roundHalfEven(x: number): number {
  const f = Math.floor(x);
  const diff = x - f;
  return safe(diff > 0.5 ? f + 1 : diff < 0.5 ? f : f % 2 === 0 ? f : f + 1);
}

/** Python `str()` and f-string rendering: None, True, False; a JSON number as JavaScript `String(n)` (S4). */
function str(x: Py): string {
  if (x === null || x === undefined) return "None";
  if (x === true) return "True";
  if (x === false) return "False";
  if (typeof x === "number") return String(num(x));
  if (typeof x === "string") return x;
  return JSON.stringify(x); // ponytail: list or dict text is out of scope (S4); Python's repr is not ported
}

function strip(s: string): string {
  let a = 0;
  let b = s.length;
  while (a < b && isSpace(s, a)) a++;
  while (b > a && isSpace(s, b - 1)) b--;
  return s.slice(a, b);
}

function splitlines(s: string): string[] {
  const out: string[] = [];
  let from = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (!PY_LINE_BREAK.has(c)) continue;
    out.push(s.slice(from, i));
    if (c === 13 && s.charCodeAt(i + 1) === 10) i++;
    from = i + 1;
  }
  if (from < s.length) out.push(s.slice(from));
  return out;
}

/** Python `s.split(None, 1)[-1]` on a stripped, nonempty string. */
function afterFirstWord(s: string): string {
  let i = 0;
  while (i < s.length && !isSpace(s, i)) i++;
  if (i === s.length) return s;
  while (isSpace(s, i)) i++;
  return s.slice(i);
}

function partition(s: string, sep: string): [string, string, string] {
  const i = s.indexOf(sep);
  return i < 0 ? [s, "", ""] : [s.slice(0, i), sep, s.slice(i + sep.length)];
}

/** Python `s[a:b]`, counted in code points. */
const cut = (s: string, b: number): string => [...s].slice(0, b).join("");

/** Strings by code point (never localeCompare), numbers and bools numerically; mixed kinds throw as in Python. */
function cmp(a: Py, b: Py): number {
  if (typeof a === "string" && typeof b === "string") {
    for (let i = 0; ; ) {
      const x = a.codePointAt(i);
      const y = b.codePointAt(i);
      if (x === undefined || y === undefined) return x === y ? 0 : x === undefined ? -1 : 1;
      if (x !== y) return x - y;
      i += x > 0xffff ? 2 : 1;
    }
  }
  const n = (v: Py) => typeof v === "number" || typeof v === "boolean";
  if (n(a) && n(b)) return Math.sign(Number(a) - Number(b));
  throw new TypeError(`'<' not supported between '${pyType(a)}' and '${pyType(b)}'`);
}

function cmpTuple(a: Py[], b: Py[]): number {
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    const c = cmp(a[i], b[i]);
    if (c !== 0) return c;
  }
  return a.length - b.length;
}

// ---- times (S1) ----

// The offset is Z, ±HH, ±HHMM or ±HH:MM, as Python 3.14's fromisoformat (the goldens' generator) reads it (D-2178 add.210).
const ISO = /^(\d{4})-(\d\d)-(\d\d)T(\d\d):(\d\d)(?::(\d\d)(?:\.\d{1,3})?)?(?:Z|[+-](\d\d)(?::?(\d\d))?)$/;

/** Epoch seconds of an S1 timestamp; the reader shares it, so both read one closed set of forms. */
export function tsEpoch(ts: Py): number {
  const m = typeof ts === "string" ? ISO.exec(ts) : null;
  const [y, mo, d, h, mi, s, oh, om] = (m ?? []).slice(1).map((v) => Number(v ?? 0));
  const leap = y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0);
  const days = mo === 2 ? (leap ? 29 : 28) : [4, 6, 9, 11].includes(mo) ? 30 : 31;
  const ms = m && mo >= 1 && mo <= 12 && d >= 1 && d <= days && h < 24 && mi < 60 && s < 60 && oh < 24 && om < 60 ? Date.parse((ts as string).replace(/([+-]\d\d):?(\d\d)?$/, (_, hh: string, mm?: string) => `${hh}:${mm ?? "00"}`)) : NaN;
  if (!Number.isFinite(ms)) throw new RangeError(`not an offset-bearing ISO timestamp with at most millisecond precision: ${str(ts)}`);
  return ms / 1000;
}

const two = (n: number): string => String(n).padStart(2, "0");
/** `datetime.fromtimestamp(t)`: rounded to the microsecond, read in the process's local time zone. */
const local = (t: number): Date => new Date(Math.floor(Math.round(t * 1e6) / 1000));

function hm(t: number): string {
  const d = local(t);
  return `${two(d.getHours())}:${two(d.getMinutes())}`;
}

function stamp(t: number): string {
  const d = local(t);
  return `${String(d.getFullYear()).padStart(4, "0")}-${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}`;
}

function dur(sec: Py): string {
  const s = int(Math.max(0, num(sec)));
  return s >= 3600 ? `${Math.floor(s / 3600)}h ${two(Math.floor((s % 3600) / 60))}m` : s >= 60 ? `${Math.floor(s / 60)}m` : `${s}s`;
}

// ---- reference lines 15–43 ----

const GATES = ["build", "lint", "evidence", "scope", "acceptance", "review", "test"];
const CHECKS = ["build", "lint", "evidence", "scope"];
const SEMANTIC_KIND = { acceptance: "accept", review: "review", test: "test" };
const TONE = { pass: "pass", harvested: "pass", fail: "fail", open: "open" };
const MARK = { pass: "✓", harvested: "✓ harvested", fail: "✖", open: "◉" };
const SINCE = "{since}"; // the pane fills it from `since` every second, so a running duration ticks between polls

function firstRedLine(d: Py): string {
  const lines = splitlines(str(get(d, "details", ""))).map(strip).filter((l) => l);
  // an unclean checkout: its reason is the stray paths, not the raw git-status line
  if (lines.length && lines[0].startsWith("refusing to gate a dirty worktree")) return "unclean checkout: " + lines.slice(1).map(afterFirstWord).join(", ");
  const hit = lines.find((l) => l.startsWith("FAIL ")) || (lines.length > 1 && lines[0].endsWith(":") ? lines[1] : lines.length ? lines[0] : "");
  return hit.startsWith("FAIL ") ? hit.slice(5) : hit;
}

/** `[i.get("channel") for i in d.get("invocations") or [] if isinstance(i, dict) and i.get("channel")]` */
const channels = (d: Py): Py[] => iter(or(get(d, "invocations"), [])).filter((i) => isDict(i) && truthy(get(i, "channel"))).map((i) => get(i, "channel"));

// ---- spans: each task's phases per attempt, open ones running to now (reference lines 46–152) ----

/** The reference's `tr` dict: summarize's private accumulator, so `spans` and `open` share span objects (S5). */
class Track {
  spans = new Map<Py, Span[]>();
  open = new Map<Py, Map<string, Span>>();
  marks = new Map<Py, Py[]>();
  att = new Map<Py, number>();
  window: { closesAt: number; parked: Py[] } | null = null;
  start: number | null = null;
  end: number | null = null;
  conc: Py = 1;

  constructor(ids: Py[]) {
    for (const k of ids) {
      this.spans.set(k, []);
      this.open.set(k, new Map());
      this.marks.set(k, []);
      this.att.set(k, 0);
    }
  }

  feed(e: Py, line: Py, t: number): void {
    const ev = get(e, "event");
    const tid = get(e, "taskId");
    const d = or(get(e, "data"), {});
    if (ev === "run-start" || ev === "run-resume") {
      if (ev === "run-resume" && this.end !== null) {
        this.end = null; // S7: the earlier run-end closed its spans, but this leg is live again.
        this.window = null;
      }
      this.start = this.start || t;
      this.conc = get(or(get(d, "effectivePolicy"), {}), "concurrency", this.conc);
    } else if (ev === "approval-window-start") {
      this.window = { closesAt: plus(t, num(or(get(d, "windowMs"), 0)) / 1000), parked: list(or(get(d, "parked"), [])) };
    } else if (ev === "approval-window-expired") {
      this.window = null;
    } else if (ev === "run-end") {
      this.end = t;
      for (const [k, open] of this.open) for (const kind of Array.from(open.keys())) this.stop(k, kind, t, kind === "park" ? "unresolved" : "cut");
    }
    if (!has(this.open, tid)) return;
    const open = must(this.open, tid);
    const phase = ev === "phase-start" ? get(d, "phase") : undefined;
    if (ev === "task-dispatch") {
      this.att.set(tid, safe(int(get(d, "attempt", 0)) + 1));
      this.stop(tid, "queue", t);
      this.release(tid, t);
      if (get(d, "retryMode") === "repair" || must(this.att, tid) > 1) must(this.marks, tid).push({ kind: "retry", t });
    } else if (phase === "worker") {
      const a = or(get(d, "assignment"), {});
      this.start_(tid, "worker", t, { label: truthy(get(a, "model")) ? `${str(get(a, "adapter"))}:${str(get(a, "model"))}` : "" });
    } else if (ev === "worker-result") {
      this.stop(tid, "worker", t, truthy(get(d, "ok")) ? "pass" : get(d, "cause") === "clean-exit-no-trailer" ? "harvested" : "fail");
      this.start_(tid, "wait", t, { label: "awaiting gates" });
    } else if (ev === "baseline-wait" && open.has("wait")) {
      must(open, "wait").label = "the baseline suite";
    } else if (phase === "gates") {
      for (const kind of ["wait", "queue"]) this.stop(tid, kind, t, "pass");
      this.release(tid, t);
      this.start_(tid, "checks", t);
    } else if (phase === "judge" || phase === "review") {
      this.stop(tid, "checks", t);
      this.start_(tid, phase === "judge" ? "accept" : "review", t);
    } else if (phase === "gate:test") {
      if (get(d, "index") !== null) {
        this.stop(tid, "checks", t);
        this.start_(tid, "test", t);
      } else {
        this.stop(tid, "suitewait", t);
      }
    } else if (ev === "suite-wait" && !open.has("suitewait")) {
      this.start_(tid, "suitewait", t, { parent: get(d, "gate") === "test" ? "test" : "accept" });
    } else if (ev === "suite-admitted") {
      this.stop(tid, "suitewait", t);
    } else if (ev === "gate-result") {
      const g = get(d, "gate");
      const ok = truthy(get(d, "pass"));
      if (CHECKS.includes(g) && !ok) this.stop(tid, "checks", t, "fail", { note: `${str(g)} ✖ ${firstRedLine(d)}` });
      const kind = get(SEMANTIC_KIND, key(g));
      if (truthy(kind)) {
        const sw = open.get("suitewait");
        if (sw && get(sw, "parent") === kind) this.stop(tid, "suitewait", t);
        const inv = channels(d);
        this.stop(tid, kind, t, ok ? "pass" : "fail", {
          seat: or(get(d, "reviewer"), inv.length ? inv[inv.length - 1] : null),
          findings: len(or(get(d, "findings"), [])),
          note: ok ? "" : `${str(g)} ✖ ${firstRedLine(d)}`,
        });
      }
    } else if (ev === "repair-attempt") {
      must(this.marks, tid).push({ kind: "repair", t, of: get(d, "of") });
    } else if (ev === "task-human") {
      for (const kind of Array.from(open.keys())) this.stop(tid, kind, t, "cut");
      this.start_(tid, "park", t, { label: str(or(get(d, "kind"), "park")), line, ts: item(e, "ts") });
    } else if (ev === "task-approved") {
      this.release(tid, t, { note: `${str(or(get(d, "by"), "operator"))}: ${str(or(get(d, "release"), "release"))}` });
      this.start_(tid, "queue", t);
    } else if (ev === "task-done") {
      must(this.marks, tid).push({ kind: "merge", t });
      for (const kind of Array.from(open.keys())) this.stop(tid, kind, t);
    }
  }

  /** A dispatch, a gate round or an approval releases the task's park: the open one, and also the last one a run-end
   *  left unresolved, which a resume released by dispatching the task again (else the board says it still needs you). */
  release(tid: Py, t: number, kw: Record<string, Py> = {}): void {
    this.stop(tid, "park", t, "released", kw);
    const spans = must(this.spans, tid);
    let last: Span | undefined;
    for (let i = spans.length - 1; i >= 0 && !last; i--) if (spans[i].kind === "park") last = spans[i];
    if (last && last.outcome === "unresolved") Object.assign(last, { outcome: "released", note: "resumed", ...kw });
  }

  /** The reference's `start` (renamed: `start` is the run's start epoch here). */
  start_(tid: Py, kind: string, t: number, kw: Record<string, Py> = {}): void {
    this.stop(tid, kind, t, "cut"); // a phase that starts again supersedes its open predecessor
    const sp: Span = { kind, att: must(this.att, tid), t0: t, t1: null, outcome: "open", ...kw };
    must(this.spans, tid).push(sp);
    must(this.open, tid).set(kind, sp);
  }

  stop(tid: Py, kind: string, t: number, outcome = "pass", kw: Record<string, Py> = {}): void {
    const open = must(this.open, tid);
    const sp = open.get(kind);
    if (!sp) return;
    open.delete(kind);
    Object.assign(sp, { t1: t, outcome, ...kw });
  }
}

/** When a full suite actually started: the end of the suite-slot wait inside its gate, else the gate's start. */
function admittedAt(spans: Span[], test: Span): number {
  const q = spans.filter((sp) => sp.kind === "suitewait" && get(sp, "parent") === "test" && sp.t1 && sp.t0 >= test.t0).map((sp) => sp.t1 as number);
  return q.length ? Math.max(...q) : test.t0;
}

const openKinds = (spans: Span[]): Map<string, Span> => new Map(spans.filter((sp) => sp.outcome === "open").map((sp) => [sp.kind, sp]));

// ---- now_sentence (reference lines 158–198) ----

/** What the task is doing, for how long ({since}, ticking from the returned epoch), against its typical time. */
function nowSentence(r: Py, spans: Span[], rows: Map<Py, Py>, openByTask: Map<Py, Map<string, Span>>, now: number, hist: Py,
  conc: Py, busy: number, suite: Py): [string, number | null] {
  const op = openKinds(spans);
  const typ = (k: string): string => (truthy(get(hist, k)) ? ` (typ ${dur(item(hist, k))})` : "");
  // ponytail: the reference's private _merged is always endEpoch (task-done sets both), so endEpoch stands in for it
  if (r.state === "done") return ["merged" + (r.endEpoch ? ` ${hm(r.endEpoch)}` : "") + ` · ${safe(r.attempt + 1)} attempt(s)`, null];
  if (r.state === "failed") return [`failed — ${r.note}`, null];
  let park: Span | undefined;
  if (r.state === "parked") {
    park = op.get("park");
    for (let i = spans.length - 1; i >= 0 && !park; i--) if (spans[i].kind === "park" && spans[i].outcome === "unresolved") park = spans[i];
  }
  if (park) return [`parked ${SINCE} · ${str(park.label)}` + (r.blocks.length ? ` · blocks ${r.blocks.join(" → ")}` : ""), park.t0]; // an unresolved park outlives the run
  const sw = op.get("suitewait");
  if (sw) {
    const what = get(sw, "parent") === "test" ? "full suite" : "acceptance oracle";
    const holders = [...openByTask].filter(([k, o]) => k !== r.id && o.has("test") && !o.has("suitewait")).map(([k]) => k);
    return [`${what} waits ${SINCE} for the suite slot` + (holders.length ? ` (held by ${holders.join(", ")} full suite)` : ""), sw.t0];
  }
  const test = op.get("test");
  if (test) {
    const failing = truthy(suite) ? item(suite, "failing") : null;
    const prog = truthy(suite) ? ` · ${str(item(suite, "done"))}/${str(item(suite, "total"))} files` + (truthy(failing) ? `, ${len(failing)} failing` : "") : "";
    return [`full suite running ${SINCE}${typ("test")}${prog}`, admittedAt(spans, test)];
  }
  if (op.has("accept") || op.has("review")) {
    const s = (op.get("accept") || op.get("review")) as Span;
    const left = ([["accept", "acceptance"], ["review", "review"]] as const).filter(([k]) => op.has(k)).map(([, n]) => n);
    return [`${left.join(" ‖ ")} running ${SINCE}${typ("semantics")}`, s.t0];
  }
  if (op.has("checks")) return ["build · lint · evidence · scope", null];
  const wait = op.get("wait");
  if (wait) return [`worker done · waiting ${SINCE} for ${str(wait.label)}`, wait.t0];
  const w = op.get("worker");
  if (w) return [`worker a${w.att}${w.att > 1 ? " (repair)" : ""} ${SINCE} on ${str(w.label || r.worker)}${typ("worker")}`, w.t0];
  const queue = op.get("queue");
  if (queue) return [`released ${SINCE} ago · ${r.note || "restarting"}`, queue.t0];
  const chain: Py[] = [];
  for (let cur = r; ; ) {
    const waits = cur.deps.filter((d: Py) => must(rows, d).state !== "done");
    if (!waits.length) break;
    // the reference walks a dependency cycle forever; a cycle is invalid input (R9), so it throws
    if (chain.includes(waits[0])) throw new Error(`dependency cycle through ${str(waits[0])}`);
    chain.push(waits[0]);
    cur = must(rows, waits[0]);
  }
  if (chain.length) return ["waits on " + chain.join(" ← "), null];
  return [`queued for a worker slot (${busy}/${str(conc)} busy)`, null];
}

// ---- attempt_lines (reference lines 201–255) ----

/** One line per attempt, phases in order. Each part: short words, a tone, the red `reason` apart (the pane puts it
 *  last), and for a running part `{since}` with the epoch it ticks from. */
function attemptLines(spans: Span[], now: number): AttemptLine[] {
  const byAtt = new Map<number, Span[]>(); // first-seen order (S5), never an object's integer-key order
  for (const sp of [...spans].sort((a, b) => a.t0 - b.t0)) {
    if (!byAtt.has(sp.att)) byAtt.set(sp.att, []);
    must(byAtt, sp.att).push(sp);
  }
  const out: AttemptLine[] = [];
  for (const [att, sps] of byAtt) {
    const parts: AttemptPart[] = [];
    for (const sp of sps) {
      const k = sp.kind;
      const o = sp.outcome;
      const took = minus(sp.t1 || now, sp.t0);
      const d = sp.t1 ? dur(took) : SINCE;
      let tone = get(TONE, o, "wait");
      const mark = get(MARK, o, "");
      let part: Partial<AttemptPart> & { text: string } | null = null;
      if (k === "worker") {
        part = { text: strip(`worker ${d} ${mark}`) };
      } else if (k === "wait" && (took >= 60 || !sp.t1)) {
        part = { text: `${str(sp.label)} ${d}` };
        tone = sp.t1 ? "wait" : "open";
      } else if (k === "checks") {
        const [gate, , why] = partition(str(or(get(sp, "note"), "")), " ✖ ");
        part = o === "fail" ? { text: `${gate} ✖`, reason: why } : { text: strip(`checks ${mark}`) };
      } else if ((k === "accept" || k === "review") && o !== "cut") {
        const seat = k === "review" && truthy(get(sp, "seat")) ? ` ${str(sp.seat)}` : "";
        const name = k === "accept" ? "acceptance" : "review";
        const why = partition(str(or(get(sp, "note"), "")), " ✖ ")[2];
        part = o === "fail" ? { text: `${name} ✖ ${d}${seat}`, reason: why } : { text: `${name} ${mark} ${d}${seat}`.replaceAll("  ", " ") };
      } else if (k === "suitewait" && get(sp, "parent") !== "test" && (took >= 60 || !sp.t1)) {
        part = { text: `suite queue ${d}` };
        tone = sp.t1 ? "wait" : "open";
      } else if (k === "test") {
        // the suite's own queue reads before it, as it happened; a suite still queued has not started
        const waits = sps.filter((q) => q.kind === "suitewait" && get(q, "parent") === "test" && q.t0 >= sp.t0);
        const queued = waits.reduce((sum, q) => plus(sum, minus(q.t1 || now, q.t0)), 0);
        const queuedOpen = waits.find((q) => !q.t1);
        if (queuedOpen) {
          parts.push({ text: `suite queue ${SINCE}`, tone: "open", since: queuedOpen.t0 });
          continue;
        }
        if (queued >= 60) parts.push({ text: `suite queue ${dur(queued)}`, tone: "wait" });
        const ran = sp.t1 ? dur(minus(took, queued)) : SINCE;
        part = { text: `full suite ${mark} ${ran}`, ...(o === "fail" ? { reason: partition(str(or(get(sp, "note"), "")), " ✖ ")[2] } : {}) };
        if (!sp.t1) part.since = admittedAt(sps, sp);
      } else if (k === "park") {
        part = { text: `PARK ${str(sp.label)} ${d}` + (o === "released" && truthy(get(sp, "note")) ? ` → ${str(sp.note)}` : "") };
        tone = o === "open" || o === "unresolved" ? "fail" : "wait";
      }
      if (part) {
        part.tone = tone;
        if (part.text.includes(SINCE) && !Object.hasOwn(part, "since")) part.since = sp.t0;
        parts.push(part as AttemptPart);
      }
    }
    out.push({ att, start: hm(sps[0].t0), parts });
  }
  return out;
}

// ---- closure and eta (reference lines 258–316) ----

function closure(tid: Py, deps: Map<Py, Py[]>): Set<Py> {
  const seen = new Set<Py>();
  const stack = [...mapGet(deps, tid, [])];
  while (stack.length) {
    const x = stack.pop();
    if (has(seen, x)) continue;
    seen.add(x);
    stack.push(...mapGet(deps, x, []));
  }
  return seen;
}

/** List-schedule the remaining work on `conc` worker slots at typical phase times, full suites one at a time (the
 *  daemon admits a suite only while none is live), plus a tip-verify suite; the pessimistic run adds a repair round per task. */
function eta(rows: Map<Py, Py>, spans: Map<Py, Span[]>, now: number, hist: Py, conc: Py): NonNullable<RunSummary["eta"]> {
  const [w, s, t] = ["worker", "semantics", "test"].map((k) => num(or(get(hist, k), 0)));

  const remaining = (r: Py, pess: boolean): number => {
    const sps = must(spans, r.id);
    const op = openKinds(sps);
    const extra = pess ? plus(w, s, t) : 0;
    const test = op.get("test");
    if (test) {
      const sw = op.get("suitewait");
      if (sw && get(sw, "parent") === "test") return plus(t, extra);
      return plus(Math.max(60, minus(t, minus(now, admittedAt(sps, test)))), extra);
    }
    if (op.has("accept") || op.has("review")) {
      return plus(Math.max(60, minus(s, minus(now, ((op.get("accept") || op.get("review")) as Span).t0))), t, extra);
    }
    const worker = op.get("worker");
    if (worker) return plus(Math.max(60, minus(w, minus(now, worker.t0))), s, t, extra);
    return plus(w, s, t, extra);
  };

  const out: number[] = [];
  const active = (r: Py): boolean => r.state === "worker" || r.state === "waiting" || r.state === "gates";
  const inTest = (r: Py): boolean => must(spans, r.id).some((sp) => sp.kind === "test" && sp.outcome === "open");
  for (const pess of [false, true]) {
    const finish = new Map<Py, number>();
    const running: number[] = [];
    let suiteFree = now;
    let clock = now;
    const left = [...rows.values()].filter((r) => r.state !== "done" && r.state !== "failed");
    while (left.length) {
      const ready = left.filter((r) => active(r) || r.deps.every((d: Py) => must(rows, d).state === "done" || mapGet(finish, d, 1e18) <= clock));
      ready.sort((a, b) => cmpTuple([!active(a), !inTest(a), -a.blocks.length, a.id], [!active(b), !inTest(b), -b.blocks.length, b.id]));
      if (ready.length && (active(ready[0]) || running.length < num(conc))) {
        const r = ready[0];
        left.splice(left.indexOf(r), 1);
        const rem = remaining(r, pess);
        const testPart = Math.min(rem, t);
        const end = plus(Math.max(minus(plus(clock, rem), testPart), suiteFree), testPart);
        suiteFree = end;
        finish.set(r.id, end);
        running.push(end);
        continue;
      }
      if (!running.length) break; // a dependency cycle or a task nothing will release: no estimate past it
      clock = Math.min(...running);
      running.splice(running.indexOf(clock), 1);
    }
    out.push(minus(plus(finish.size ? Math.max(...finish.values()) : now, t), now));
  }
  const by = new Map<Py, Py[]>([...rows].map(([k, v]) => [k, v.deps]));
  let tail: Py = null;
  let best: Py[] = [];
  for (const r of rows.values()) {
    const key = [closure(r.id, by).size, r.id];
    if (tail === null || cmpTuple(key, best) > 0) [tail, best] = [r, key]; // max() keeps the first maximal element
  }
  const crit: Py[] = [];
  while (tail) {
    if (crit.includes(tail.id)) throw new Error(`dependency cycle through ${str(tail.id)}`); // the reference loops forever (R9)
    crit.unshift(tail.id);
    tail = tail.deps.length ? must(rows, tail.deps[0]) : null;
  }
  return { cleanMin: roundHalfEven(out[0] / 60), oneRepairMin: roundHalfEven(out[1] / 60), criticalPath: crit,
    stoppedBy: [...rows.values()].filter((r) => r.state === "parked").map((r) => r.id) };
}

// ---- summarize (reference lines 319–422) ----

/** The run as the board draws it, at `now` (epoch seconds). Events carry `_line`, their 1-based journal line (S6). */
export function summarize(events: readonly unknown[], graph: unknown, lockPid: number | null, alive: boolean | null, now: number,
  hist: PhaseHistory | null = null, telemetry: readonly unknown[] = [], suites: Record<string, SuiteProgress> | null = null): RunSummary {
  exactInput(events, graph, lockPid, now, hist, telemetry, suites);
  const h = or(hist, {});
  const tasks = iter(get(graph, "tasks", []));
  const titles = new Map<Py, Py>(tasks.map((t) => [key(item(t, "id")), get(t, "title", "")]));
  const deps = new Map<Py, Py[]>(tasks.map((t) => [key(item(t, "id")), list(get(t, "deps", []))]));
  const rows = new Map<Py, Py>();
  for (const tid of titles.keys()) {
    rows.set(tid, { id: tid, title: titles.get(tid), state: "pending", attempt: 0, dispatched: false, budget: 3, gates: {}, note: "",
      deps: must(deps, tid), blocks: [...titles.keys()].filter((k) => closure(k, deps).has(tid)).sort(cmp), worker: "", judge: "",
      reviewer: "", suiteWaiting: false, startEpoch: null, endEpoch: null, launches: 0 });
  }
  const tr = new Track([...rows.keys()]);
  const lastFail = new Map<Py, string>();
  let runId: Py = "";
  let ended: Py = null;
  events.forEach((e: Py, i) => {
    const ev = get(e, "event");
    const tid = get(e, "taskId");
    const d = get(e, "data", {});
    tr.feed(e, get(e, "_line", i + 1), tsEpoch(item(e, "ts")));
    if ((ev === "run-start" || ev === "run-resume") && !truthy(runId)) runId = str(get(d, "runId", ""));
    if (ev === "run-end") {
      ended = Object.fromEntries(["done", "failed", "human", "blocked", "pending"].map((k) => [k, get(d, k, [])]));
      ended.tipVerify = get(d, "tipVerify");
      const oc = or(get(d, "owedChecks"), {});
      ended.owed = truthy(get(oc, "known")) ? len(or(get(oc, "outstanding"), [])) : null;
      runId = get(d, "runId", runId);
    } else if (ev === "run-resume" && ended !== null) {
      ended = null; // S7: a reopening resume supersedes the earlier run-end record.
    }
    const row = truthy(tid) ? mapGet(rows, tid, undefined) : undefined;
    if (row === undefined) return;
    if (ev === "task-dispatch" || ev === "repair-dispatch") {
      Object.assign(row, { state: "worker", note: ev === "repair-dispatch" ? "repair" : "", dispatched: true });
      if (ev === "task-dispatch") {
        row.startEpoch = row.startEpoch || tsEpoch(item(e, "ts"));
        row.attempt = int(get(d, "attempt", row.attempt));
        const a = or(get(d, "assignment"), {});
        if (truthy(get(a, "adapter")) && truthy(get(a, "model"))) row.worker = `${str(item(a, "adapter"))}:${str(item(a, "model"))}`;
      }
    } else if (ev === "worker-launch") {
      row.launches = safe(row.launches + 1); // every worker the run started for this task, across resumes and upheld rounds
    } else if (ev === "worker-result") {
      Object.assign(row, { state: "waiting", note: "" });
    } else if (ev === "phase-start" && get(d, "phase") === "gates") {
      Object.assign(row, { state: "gates", gates: {}, note: "" });
    } else if (ev === "gate-result" && GATES.includes(get(d, "gate"))) {
      const gate: string = item(d, "gate");
      if (row.state !== "done" && row.state !== "failed") row.state = "gates";
      row.gates[gate] = truthy(get(d, "pass")) ? "pass" : "fail";
      if (gate === "test") row.suiteWaiting = false;
      if (!truthy(get(d, "pass"))) lastFail.set(tid, cut(`${gate} ✖ ${firstRedLine(d)}`, 70));
      const inv = channels(d);
      if (gate === "acceptance" && inv.length) row.judge = inv[inv.length - 1];
      if (gate === "review" && (truthy(get(d, "reviewer")) || inv.length)) row.reviewer = str(or(get(d, "reviewer"), inv[inv.length - 1]));
    } else if (ev === "suite-wait") {
      row.suiteWaiting = true;
    } else if (ev === "suite-admitted" || (ev === "phase-start" && truthy(get(d, "admitted")))) {
      row.suiteWaiting = false;
    } else if (ev === "repair-attempt" && truthy(get(d, "of"))) {
      row.budget = safe(1 + int(item(d, "of")));
    } else if (ev === "task-human") {
      const why = mapGet(lastFail, tid, "");
      Object.assign(row, { state: "parked", suiteWaiting: false, note: cut(cut(str(get(d, "reason", "")), 60) + (why ? ` · ${why}` : ""), 110) });
    } else if (ev === "task-approved") {
      Object.assign(row, { state: "pending", note: "approved: " + str(get(d, "release", "")) });
    } else if (ev === "task-done") {
      Object.assign(row, { state: "done", note: "", endEpoch: tsEpoch(item(e, "ts")) });
    } else if (ev === "task-failed") {
      Object.assign(row, { state: "failed", note: cut(str(get(d, "error", get(d, "reason", ""))), 90) });
    }
  });
  const at = Math.min(now, tr.end || now);
  const openByTask = new Map([...tr.open].map(([k, v]) => [k, new Map(v)]));
  const busy = [...rows.values()].filter((r) => r.state === "worker" || r.state === "waiting" || r.state === "gates").length;
  for (const tl of iter(telemetry)) { // usage rows land at task end and carry no time: credit them once the task is done or the run ended
    const r = mapGet(rows, get(tl, "taskId"), undefined);
    if (r && get(tl, "shape") === "implement" && truthy(get(tl, "tokens")) && (r.state === "done" || ended)) {
      const tok = r.tokens || { input: 0, output: 0, cacheRead: 0 };
      const used = item(tl, "tokens");
      r.tokens = Object.fromEntries(Object.keys(tok).map((k) => [k, safe(tok[k] + int(or(get(used, k), 0)))]));
    }
  }
  for (const [k, r] of rows) {
    [r.now, r.nowSince] = nowSentence(r, must(tr.spans, k), rows, openByTask, at, h, tr.conc, busy, get(or(suites, {}), k));
    r.history = attemptLines(must(tr.spans, k), at);
    if (!Object.hasOwn(r, "tokens")) r.tokens = null;
    // local wall-clock text for the card (the board's module has no time zone of its own)
    r.startedAt = r.startEpoch ? stamp(r.startEpoch) : "";
    r.endedAt = r.endEpoch ? hm(r.endEpoch) : "";
  }
  const needs: NeedsYou[] = [];
  for (const [k, r] of rows) {
    for (const sp of must(tr.spans, k)) {
      if (sp.kind === "park" && (sp.outcome === "open" || sp.outcome === "unresolved")) {
        needs.push({ task: k, kind: sp.label, reason: r.note, since: sp.t0, blocks: r.blocks,
          cmd: `tickmarkr approve {run} ${str(k)} --park ${str(sp.line)}@${str(sp.ts)}` });
      }
    }
  }
  return positiveZero({
    runId,
    alive,
    pid: lockPid,
    elapsedMin: tr.start ? int(minus(at, tr.start) / 60) : 0,
    ended,
    tasks: [...rows.values()], // the graph's own order (the spec's), never a text sort that puts T4 after T33
    needsYou: needs,
    approvalWindow: tr.window && needs.length && !ended ? tr.window : null,
    eta: ended || !rows.size ? null : eta(rows, tr.spans, at, h, tr.conc),
    atEpoch: at,
    startEpoch: tr.start,
    endEpoch: tr.end,
  });
}
