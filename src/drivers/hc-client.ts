import { execFile } from "node:child_process";

// Queue row 340; D-2180 — the ONE JSON client for the Herdr app's two CLIs: `hc` (herdr-core terminals) and
// `herdr-app` (spaces/tabs/panes). Every call is argv (no shell, no login profile), bounded by a deadline and an
// output cap; a timed-out call is killed and awaited before it answers. Only the closed consumed fields of each
// response family are validated; unknown extra fields are allowed. Every failure names its family and keeps bounded
// diagnostics (operation, exit, signal, timeout, stdout, stderr). A failed mutation is never replayed, and no parser
// guesses text, ids or focused targets. Only unreadable read responses permit bounded re-reads (row 360; D-2184 add.19).

export const HC_FAMILIES = ["status", "run", "ls", "terminal", "read", "send", "keys", "wait", "rm"] as const;
export const APP_FAMILIES = ["app-ls", "pane-split", "tab-rename"] as const;
export type HcFamily = (typeof HC_FAMILIES)[number];
export type AppFamily = (typeof APP_FAMILIES)[number];

export const HC_CALL_TIMEOUT_MS = 15_000;
export const HC_PLACEMENT_TIMEOUT_MS = 30_000;
export const HC_OUTPUT_CAP = 8 * 1024 * 1024;
const DIAG_CAP = 2_048;
/** A LOCAL terminal address (a remote `machine/t7` is out of scope). hc numbers terminals in digits plus consonants and
 * never starts with a letter, so t19 is followed by t1b and t1z by t20 (measured on hc 0.1.18; queue row 340, D-2180). */
export const ADDRESS_RE = /^t[0-9][0-9a-z]*$/;
/** The plain-stderr refusal herdr-app prints when no window owns its socket (captured, herdr-app 0.1.12). */
const NO_WINDOW_RE = /no Herdr window/;
export const WINDOW_UNAVAILABLE = "window_unavailable";

export type TermState = "live" | "finished";
export interface HcStatus { coreId: string; version: string; pid: number; live: number; finished: number }
export interface HcRunReceipt { address: string; cwd: string; state: TermState; name: string | null }
export interface HcListRow { address: string; cwd: string; state: TermState; status?: string; name?: string | null }
export interface HcList { terminals: HcListRow[]; hiddenFinished: number }
export interface HcTerminal {
  address: string; cwd: string; labels: Record<string, string>; state: TermState; parent: string | null;
  dieWithParent: boolean; notify: boolean; keep: boolean; reported: boolean;
  status: { state: string; app?: string; msg?: string } | null;
  exitCode: number | null; signal: number | null; reason: string | null; pid: number | null;
}
/** how: "stitched" is a full-screen app read by scrolling it (hc 0.1.18 schema; queue row 340, D-2180). */
export interface HcRead { text: string; complete: boolean; how: "screen" | "history" | "stitched"; why?: string }
export interface HcSend { started: boolean | null; status: string | null; turn: number }
export interface HcKeys { status: string | null; turn: number }
export interface HcWait {
  ended: boolean; reason: string; terminal: string | null; status: string | null;
  exitCode: number | null; signal: number | null; turn: number; children: unknown[];
}
export interface HcRemoved { removed: string }
export interface AppLayout { spaces: { id: string; tabs: { id: string; name: string; terminals: { terminal: string; pane: string }[] }[] }[] }
export interface AppSplit { pane: string; terminal: string }
export interface AppRenamed { ok: true }

interface Parsed {
  status: HcStatus; run: HcRunReceipt; ls: HcList; terminal: HcTerminal; read: HcRead; send: HcSend; keys: HcKeys;
  wait: HcWait; rm: HcRemoved; "app-ls": AppLayout; "pane-split": AppSplit; "tab-rename": AppRenamed;
}

export interface HcDiagnostics { op: string; exit: number | null; signal: string | null; timedOut: boolean; stdout: string; stderr: string }

export class HcError extends Error {
  constructor(readonly family: HcFamily | AppFamily, readonly reason: string, readonly diagnostics: HcDiagnostics, readonly kind?: string) {
    const d = diagnostics;
    super(`${family} response family failed — ${reason} [op ${d.op}; exit ${d.exit ?? "none"}; signal ${d.signal ?? "none"}; ` +
      `timedOut ${d.timedOut}]${d.stderr ? `\nstderr: ${d.stderr}` : ""}${d.stdout ? `\nstdout: ${d.stdout}` : ""}`);
    this.name = "HcError";
  }
}

/** Row 360; D-2184 add.19: an unreadable transport response supplies no pane text or verdict. */
export class HcReadUnavailableError extends HcError {
  constructor(reason: string, diagnostics: HcDiagnostics) {
    super("read", reason, diagnostics);
    this.name = "HcReadUnavailableError";
  }
}

// ---- closed field validation ---------------------------------------------------------------------------------
class Shape extends Error {}
type O = Record<string, unknown>;
const isObj = (v: unknown): v is O => typeof v === "object" && v !== null && !Array.isArray(v);
const obj = (v: unknown, at: string): O => { if (!isObj(v)) throw new Shape(`${at} is not an object`); return v; };
const arr = (o: O, k: string): unknown[] => { if (!Array.isArray(o[k])) throw new Shape(`${k} is not an array`); return o[k] as unknown[]; };
function str(o: O, k: string, nonEmpty = false): string {
  const v = o[k];
  if (typeof v !== "string" || (nonEmpty && !v)) throw new Shape(`${k} is not a ${nonEmpty ? "nonempty " : ""}string`);
  return v;
}
const strOrNull = (o: O, k: string): string | null => (o[k] === null ? null : str(o, k));
const optStr = (o: O, k: string): string | undefined => (o[k] === undefined ? undefined : str(o, k));
function bool(o: O, k: string): boolean { if (typeof o[k] !== "boolean") throw new Shape(`${k} is not a boolean`); return o[k] as boolean; }
const boolOrNull = (o: O, k: string): boolean | null => (o[k] === null ? null : bool(o, k));
function int(o: O, k: string, min = -Infinity): number {
  const v = o[k];
  if (typeof v !== "number" || !Number.isInteger(v) || v < min) throw new Shape(`${k} is not an integer${min > -Infinity ? ` >= ${min}` : ""}`);
  return v;
}
const intOrNull = (o: O, k: string): number | null => (o[k] === null ? null : int(o, k));
function addr(o: O, k: string): string { const v = str(o, k, true); if (!ADDRESS_RE.test(v)) throw new Shape(`${k} is not a local terminal address`); return v; }
function state(o: O): TermState { const v = o.state; if (v !== "live" && v !== "finished") throw new Shape("state is not live/finished"); return v; }
function labels(o: O): Record<string, string> {
  const l = obj(o.labels, "labels");
  for (const [k, v] of Object.entries(l)) if (typeof v !== "string") throw new Shape(`label ${k} is not a string`);
  return { ...(l as Record<string, string>) };
}
function status(o: O): HcTerminal["status"] {
  if (o.status === null) return null;
  const s = obj(o.status, "status");
  const app = optStr(s, "app"), msg = optStr(s, "msg");
  return { state: str(s, "state"), ...(app !== undefined ? { app } : {}), ...(msg !== undefined ? { msg } : {}) };
}

const PARSE: { [F in keyof Parsed]: (o: O) => Parsed[F] } = {
  status: (o) => {
    const core = obj(o.core, "core");
    return { coreId: str(core, "id", true), version: str(o, "version", true), pid: int(o, "pid", 1), live: int(o, "live", 0), finished: int(o, "finished", 0) };
  },
  run: (o) => ({ address: addr(o, "address"), cwd: str(o, "cwd"), state: state(o), name: o.name === undefined ? null : strOrNull(o, "name") }),
  ls: (o) => ({
    hiddenFinished: int(o, "hidden_finished", 0),
    terminals: arr(o, "terminals").map((t, i) => {
      const r = obj(t, `terminals[${i}]`);
      const st = optStr(r, "status");
      return { address: str(r, "address"), cwd: str(r, "cwd"), state: state(r), ...(st !== undefined ? { status: st } : {}),
        ...(r.name !== undefined ? { name: strOrNull(r, "name") } : {}) };
    }),
  }),
  terminal: (o) => ({
    address: str(o, "address"), cwd: str(o, "cwd"), labels: labels(o), state: state(o), parent: strOrNull(o, "parent"),
    dieWithParent: bool(o, "die_with_parent"), notify: bool(o, "notify"), keep: bool(o, "keep"), reported: bool(o, "reported"),
    status: status(o), exitCode: intOrNull(o, "exit_code"), signal: intOrNull(o, "signal"), reason: strOrNull(o, "reason"), pid: intOrNull(o, "pid"),
  }),
  read: (o) => {
    const how = o.how;
    if (how !== "screen" && how !== "history" && how !== "stitched") throw new Shape("how is not screen/history/stitched");
    const why = optStr(o, "why");
    return { text: str(o, "text"), complete: bool(o, "complete"), how, ...(why !== undefined ? { why } : {}) };
  },
  send: (o) => ({ started: boolOrNull(o, "started"), status: strOrNull(o, "status"), turn: int(o, "turn", 0) }),
  keys: (o) => ({ status: strOrNull(o, "status"), turn: int(o, "turn", 0) }),
  wait: (o) => ({
    ended: bool(o, "ended"), reason: str(o, "reason"), terminal: strOrNull(o, "terminal"), status: strOrNull(o, "status"),
    exitCode: intOrNull(o, "exit_code"), signal: intOrNull(o, "signal"), turn: int(o, "turn", 0), children: [...arr(o, "children")],
  }),
  rm: (o) => ({ removed: str(o, "removed", true) }),
  "app-ls": (o) => ({
    spaces: arr(o, "spaces").map((sp, i) => {
      const s = obj(sp, `spaces[${i}]`);
      return { id: str(s, "id"), tabs: arr(s, "tabs").map((tb, j) => {
        const t = obj(tb, `tabs[${j}]`);
        return { id: str(t, "id"), name: str(t, "name"), terminals: arr(t, "terminals").map((tm, k) => {
          const m = obj(tm, `terminals[${k}]`);
          return { terminal: str(m, "terminal"), pane: str(m, "pane") };
        }) };
      }) };
    }),
  }),
  "pane-split": (o) => ({ pane: str(o, "pane", true), terminal: str(o, "terminal", true) }),
  "tab-rename": (o) => { if (o.ok !== true) throw new Shape("ok is not exactly true"); return { ok: true }; },
};

// ---- the client ----------------------------------------------------------------------------------------------
interface Raw { stdout: string; stderr: string; exit: number | null; signal: string | null; timedOut: boolean; capped: boolean; spawnError?: string }

export interface HcClientOpts {
  hcBin: string;
  appBin?: string;
  /** The client's environment: the launcher's HC_TERMINAL_ID/SOCKET select its core. Never forwarded to terminals. */
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  /** Ceiling for herdr-app placement calls (default 30 s). */
  placementTimeoutMs?: number;
  outputCap?: number;
  /** Clock shared with a caller's deadline; injectable for bounded read recovery. */
  now?: () => number;
}

const clip = (s: string): string => (s.length > DIAG_CAP ? `${s.slice(0, DIAG_CAP)}…[${s.length - DIAG_CAP} more bytes]` : s);

export class HcClient {
  private readonly timeoutMs: number;
  private readonly cap: number;
  constructor(private readonly o: HcClientOpts) {
    this.timeoutMs = o.timeoutMs ?? HC_CALL_TIMEOUT_MS;
    this.cap = o.outputCap ?? HC_OUTPUT_CAP;
  }

  private exec(bin: string, args: string[], timeoutMs: number): Promise<Raw> {
    return new Promise((done) => {
      // execFile answers on 'close', so a killed child (timeout or output cap) has been reaped before we return.
      execFile(bin, args, { env: this.o.env ?? process.env, timeout: timeoutMs, killSignal: "SIGKILL", maxBuffer: this.cap, encoding: "utf8" },
        (error, stdout, stderr) => {
          const e = error as (Error & { code?: number | string; killed?: boolean; signal?: NodeJS.Signals | null }) | null;
          const capped = e?.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER";
          done({
            stdout: String(stdout ?? ""), stderr: String(stderr ?? ""),
            exit: !e ? 0 : typeof e.code === "number" ? e.code : null,
            signal: e?.signal ?? null, timedOut: !!e?.killed && !capped, capped,
            spawnError: e && typeof e.code === "string" && !capped ? e.message : undefined,
          });
        });
    });
  }

  private async call<F extends keyof Parsed>(bin: string, family: F, args: string[], timeoutMs: number): Promise<Parsed[F]> {
    const r = await this.exec(bin, args, timeoutMs);
    const diag: HcDiagnostics = { op: `${bin.split("/").pop()} ${args.slice(0, 2).join(" ")}`, exit: r.exit, signal: r.signal, timedOut: r.timedOut, stdout: clip(r.stdout), stderr: clip(r.stderr) };
    const fail = (reason: string, kind?: string): never => { throw new HcError(family, reason, diag, kind); };
    const unreadable = (reason: string): never => {
      if (family === "read") throw new HcReadUnavailableError(reason, diag);
      return fail(reason);
    };
    if (r.spawnError) fail(`could not be invoked (${r.spawnError})`);
    if (r.capped) fail(`output exceeded the ${this.cap}-byte cap (killed)`);
    if (r.timedOut) fail(`timed out after ${timeoutMs} ms (killed)`);
    if (r.signal) fail(`ended by signal ${r.signal}`);
    if (r.exit !== 0) {
      // A plausible success body on a nonzero exit still fails; the structured error (stderr for hc, either stream for
      // herdr-app) only names the refusal. Plain stderr is diagnostic text, never parsed as success.
      const kind = errorKind(r.stderr) ?? errorKind(r.stdout) ?? (NO_WINDOW_RE.test(r.stderr) ? WINDOW_UNAVAILABLE : undefined);
      fail(`exited ${r.exit}${kind ? ` (${kind})` : ""}`, kind);
    }
    const text = r.stdout.trim();
    if (!text) unreadable("empty response");
    let parsed: unknown;
    try { parsed = JSON.parse(text); } catch (e) { unreadable(`malformed JSON (${(e as Error).message})`); }
    if (!isObj(parsed)) unreadable("response is not a JSON object");
    const body = parsed as O;
    if ("error" in body) fail(`error body on exit 0 (${errorKind(text) ?? "unstructured"})`);
    try { return PARSE[family](body); } catch (e) { if (e instanceof Shape) unreadable(e.message); throw e; }
  }

  hc<F extends HcFamily>(family: F, args: string[], timeoutMs = this.timeoutMs): Promise<Parsed[F]> {
    // --json is explicit on every hc family, even when piped (hc read is text without it) — and always before a
    // `--` program separator, so it never becomes the terminal's own argv.
    const sep = args.indexOf("--");
    const argv = sep < 0 ? [...args, "--json"] : [...args.slice(0, sep), "--json", ...args.slice(sep)];
    return this.call(this.o.hcBin, family, argv, timeoutMs);
  }

  app<F extends AppFamily>(family: F, args: string[], timeoutMs = this.o.placementTimeoutMs ?? HC_PLACEMENT_TIMEOUT_MS): Promise<Parsed[F]> {
    return this.call(this.o.appBin ?? "herdr-app", family, args, timeoutMs);
  }

  // Every method takes an optional per-call bound: a caller with a deadline passes its remaining time, so no call
  // (and no evidence it returns) outlives that deadline.
  status(ms?: number): Promise<HcStatus> { return this.hc("status", ["server", "status"], ms); }
  run(args: string[], ms?: number): Promise<HcRunReceipt> { return this.hc("run", ["run", ...args], ms); }
  list(ms?: number): Promise<HcList> { return this.hc("ls", ["ls", "--all"], ms); }
  async get(address: string, ms?: number): Promise<HcTerminal> { return pinned("terminal", address, await this.hc("terminal", ["get", address], ms)); }
  async kill(address: string, ms?: number): Promise<HcTerminal> { return pinned("terminal", address, await this.hc("terminal", ["kill", address], ms)); }
  async keepOff(address: string, ms?: number): Promise<HcTerminal> { return pinned("terminal", address, await this.hc("terminal", ["keep", address, "--off"], ms)); }
  async label(address: string, pairs: string[], ms?: number): Promise<HcTerminal> { return pinned("terminal", address, await this.hc("terminal", ["label", address, ...pairs], ms)); }
  async read(address: string, lines: number, ms?: number): Promise<HcRead> {
    if (!Number.isInteger(lines) || lines < 0) throw new Error(`hc read: lines must be a nonnegative integer, got ${lines}`);
    // Row 360; D-2184 add.19: at most two re-reads, sharing the ORIGINAL call budget. Refusals, timeouts, signals,
    // output caps and every mutation retain their existing behavior; malformed bytes never become an empty pane.
    const now = this.o.now ?? Date.now;
    const deadline = now() + (ms ?? this.timeoutMs);
    let last: HcReadUnavailableError | undefined;
    for (let attempt = 0; ; attempt++) {
      const left = deadline - now();
      if (left <= 0) {
        throw last ?? new HcReadUnavailableError("read deadline reached before a call could be issued",
          { op: "hc read", exit: null, signal: null, timedOut: false, stdout: "", stderr: "" });
      }
      try { return await this.hc("read", ["read", address, "--lines", String(lines)], left); }
      catch (error) {
        if (last && error instanceof HcError && error.diagnostics.timedOut) {
          throw new HcReadUnavailableError(`read recovery budget exhausted (${error.reason})`, error.diagnostics);
        }
        if (!(error instanceof HcReadUnavailableError) || attempt === 2) throw error;
        last = error;
      }
    }
  }
  send(address: string, text: string, ms?: number): Promise<HcSend> { return this.hc("send", ["send", address, text], ms); } // never --force
  keys(address: string, keys: string[], ms?: number): Promise<HcKeys> { return this.hc("keys", ["keys", address, ...keys], ms); }
  /**
   * One bounded wait slice; its result is a wake reason, never proof of a state. `boundMs` (the caller's remaining
   * deadline) caps the whole subprocess and the slice with it; without one the slice gets one ordinary call ceiling.
   */
  wait(address: string, sliceMs: number, boundMs?: number): Promise<HcWait> {
    const bound = boundMs ?? Math.max(0, sliceMs) + this.timeoutMs;
    const slice = Math.min(Math.max(0, sliceMs), bound);
    return this.hc("wait", ["wait", address, "--timeout", (slice / 1000).toFixed(3)], bound);
  }
  async rm(address: string): Promise<HcRemoved> {
    const r = await this.hc("rm", ["rm", address]);
    if (r.removed !== address) throw new HcError("rm", `removed ${r.removed}, not the targeted ${address}`, { op: "hc rm", exit: 0, signal: null, timedOut: false, stdout: "", stderr: "" });
    return r;
  }
}

/** A get/kill/keep/label for a pinned address must answer for that same address. */
function pinned(family: "terminal", address: string, t: HcTerminal): HcTerminal {
  if (t.address !== address) throw new HcError(family, `answered for ${t.address}, not the pinned ${address}`, { op: "hc get", exit: 0, signal: null, timedOut: false, stdout: "", stderr: "" });
  return t;
}

/** The structured error kind of an hc (`{error:{kind,message}}`) or herdr-app (`{error:"..."}`) body, else undefined. */
function errorKind(text: string): string | undefined {
  try {
    const v: unknown = JSON.parse(text.trim());
    if (!isObj(v)) return undefined;
    if (typeof v.error === "string") return "app_error";
    if (isObj(v.error) && typeof v.error.kind === "string" && typeof v.error.message === "string") return v.error.kind;
  } catch { /* plain text is diagnostic only */ }
  return undefined;
}
