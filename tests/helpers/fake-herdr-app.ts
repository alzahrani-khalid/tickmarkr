import { chmodSync, mkdirSync, readFileSync, renameSync, rmdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// Queue row 340; D-2180 — executable stand-ins for `hc` (herdr-core 0.1.17) and `herdr-app` (0.1.12). Both are real
// files invoked by explicit absolute path (never PATH, never a login shell). One JSON state file backs both; every
// invocation's argv is appended to a log. Response bodies follow the captured shapes in
// specs/v2.20.0-herdr-app-captures.json; tests feed captured bytes verbatim through `rule`. With `execute`, `hc run`
// really runs the terminal's argv with the CORE's environment plus the fresh pair/scope hc injects — the client's own
// environment is deliberately NOT forwarded (the captured client-only FOO probe).

export interface FakeTerm {
  address: string; argv: string[]; cwd: string; labels: Record<string, string>; state: "live" | "finished";
  parent: string | null; die_with_parent: boolean; notify: boolean; keep: boolean; reported: boolean;
  status: { state: string; app?: string } | null; exit_code: number | null; signal: number | null; reason: string | null;
  pid: number | null; turn: number;
  screen: { text: string; complete: boolean; how?: string; why?: string };
  history: { text: string; complete: boolean; how?: string; why?: string };
  /** Applied to the terminal when it receives `hc send` (a program reacting to input). */
  onSend?: Partial<FakeTerm>;
  /** When false, `hc send` does not echo the text onto the screen. */
  echo?: boolean;
  /** A split board whose argv really runs (detached, its own process group): it reads finished once that pid is gone. */
  spawned?: boolean;
}
export interface FakeRule {
  tool?: "hc" | "herdr-app";
  /** Tokens that must appear in argv, in order (an empty list matches every call of the tool). */
  match: string[];
  output?: string; stderr?: string; exit?: number; sleepMs?: number; signal?: NodeJS.Signals;
  once?: boolean;
  /** Merged into (or creating) terminals before the rule answers. */
  mutate?: Record<string, Partial<FakeTerm>>;
  /** Removes these terminals before the rule answers. */
  remove?: string[];
  /** Replaces the core identity before the rule answers. */
  coreId?: string;
  /** Writes these files (path → content) before the rule answers: a change racing the call. */
  write?: Record<string, string>;
  /** After its effects, the call proceeds as it would without the rule (stderr/exit are ignored); a set "output"
   *  then replaces the call's own response — it took effect, but its receipt is lost or malformed. With "sleepMs" the
   *  process lingers that long after the call took effect (the state lock released): its receipt is not yet received. */
  pass?: boolean;
  /** Window rows of these addresses keep their pane but lose their terminal field (app `cleared`). */
  clear?: string[];
  /** Merged into the window layout before the rule answers: a layout change racing the call. */
  app?: Partial<FakeApp>;
}
/**
 * The app window over the core (T3, contract P): a terminal created with a herdr.space label of a listed space is
 * shown there — in the tab its herdr.tab label names, else a new tab — gains that herdr.tab label, and has keep turned
 * on (captured Q4-split-get). `ls` and `do tab.rename` answer from this layout; without a window herdr-app prints the
 * captured Q6 refusal. Undefined keeps the pre-T3 behaviour: herdr-app answers only scripted rules. A pane id is
 * `p<address>` unless `panes` names another. `do pane.split --pane P --argv JSON` (T4, contract B) creates the next terminal right after P in P's
 * tab, carrying that space/tab and keep/notify as captured (Q4-split, Q4-split-get) and the split pane's cwd; with
 * `execute` its argv runs detached in the core's environment plus the injected pair/scope.
 */
export interface FakeApp {
  window: boolean;
  spaces: { id: string; name: string; tabs: { id: string; name: string; terminals: string[] }[] }[];
  nextTab: number;
  /** false: the window never maps new terminals (no tab label, no layout row) — a mapping that never arrives. */
  maps?: boolean;
  /** false: a shown terminal appears in the layout but gains no herdr.tab label (only the exact app row maps it). */
  tabLabel?: boolean;
  /** Addresses whose window row `ls` reports with an EMPTY terminal field (the pane `p<address>` survives). */
  cleared?: string[];
  /** Pane ids by address, overriding `p<address>` (a pane the window re-mapped). */
  panes?: Record<string, string>;
}
export interface FakeState {
  core: { id: string; version: string; pid: number };
  next: number; socket: string;
  terminals: Record<string, FakeTerm>;
  rules: FakeRule[];
  execute: boolean;
  coreEnv: Record<string, string>;
  /** Merged into every terminal `hc run` creates without `execute`. */
  spawn: Partial<FakeTerm>;
  /** Every program a split really spawned, so reap() ends it even after its terminal record was finished or removed. */
  spawnedPids?: number[];
  /** Ignore --no-parent (a CLI that parents the task terminal under its launcher). */
  forceParent?: string;
  app?: FakeApp;
}
export interface FakeCall { tool: string; argv: string[] }

/** The k-th address hc hands out (k >= 1). hc counts in base 30 over digits plus consonants and skips any number whose
 * first character is a letter: t1..t9, t10..t19, t1b..t1z, t20 (measured on hc 0.1.18; queue row 340, D-2180).
 * Self-contained: its source is also inlined into the fake executables. */
export function hcAddress(k: number): string {
  const digits = "0123456789bcdfghjkmnpqrstvwxyz";
  for (let n = 1, seen = 0; ; n++) {
    let e = "";
    for (let x = n; x > 0; x = Math.floor(x / 30)) e = digits[x % 30] + e;
    if (/^[0-9]/.test(e) && ++seen === k) return "t" + e;
  }
}

const SCRIPT = String.raw`
const fs = require("fs"), cp = require("child_process");
const argv = process.argv.slice(2);
fs.appendFileSync(LOG, JSON.stringify({ tool: TOOL, argv }) + "\n");
// Concurrent invocations (parallel tasks under a real daemon) read-modify-write one state file: serialize them with a
// mkdir lock, released before any scripted sleep/signal and while an executed terminal runs; a stale lock is broken.
const LOCK = STATE + ".lock", nap = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
let held = false;
const lock = () => { for (;;) { try { fs.mkdirSync(LOCK); held = true; return; } catch (e) {
  if (e.code !== "EEXIST") throw e;
  try { if (Date.now() - fs.statSync(LOCK).mtimeMs > 5000) fs.rmdirSync(LOCK); } catch {}
  nap(3);
} } };
const unlock = () => { if (held) { held = false; try { fs.rmdirSync(LOCK); } catch {} } };
process.on("exit", unlock);
lock();
let s = JSON.parse(fs.readFileSync(STATE, "utf8"));
// Atomic (tmp + rename): the tests read STATE without the lock while a fake call saves it (queue row 340; D-2180).
const save = () => { const tmp = STATE + ".tmp" + process.pid; fs.writeFileSync(tmp, JSON.stringify(s)); fs.renameSync(tmp, STATE); };
// A spawned board whose program is gone has finished, as hc reports a terminal whose program exited.
for (const x of Object.values(s.terminals)) if (x.spawned && x.state === "live") { try { process.kill(x.pid, 0); } catch { Object.assign(x, { state: "finished", reason: "exited" }); save(); } }
// A passing rule with "output" lets the call take effect but replaces its response (a lost or malformed receipt).
const out = (o) => process.stdout.write(r && r.pass && r.output !== undefined ? r.output : JSON.stringify(o) + "\n");
const fail = (kind, message, code) => { process.stderr.write(JSON.stringify({ error: { kind, message } }) + "\n"); process.exitCode = code; };
const sub = (m) => { let i = 0; for (const a of argv) if (i < m.length && a === m[i]) i++; return i === m.length; };
const blank = (address) => ({ address, argv: [], cwd: "/", labels: {}, state: "live", parent: null, die_with_parent: false, notify: false,
  keep: false, reported: false, status: null, exit_code: null, signal: null, reason: null, pid: 90000, turn: 0,
  screen: { text: "", complete: true }, history: { text: "", complete: true } });
const ri = s.rules.findIndex((r) => (r.tool || "hc") === TOOL && sub(r.match)), r = s.rules[ri];
if (r) {
  if (r.once) s.rules.splice(ri, 1);
  for (const [a, m] of Object.entries(r.mutate || {})) s.terminals[a] = Object.assign(s.terminals[a] || blank(a), m);
  for (const a of r.remove || []) delete s.terminals[a];
  if (r.coreId) s.core.id = r.coreId;
  if (r.clear && s.app) s.app.cleared = [...(s.app.cleared || []), ...r.clear];
  if (r.app && s.app) Object.assign(s.app, r.app);
  for (const [p, c] of Object.entries(r.write || {})) fs.writeFileSync(p, c);
  save();
  if (r.pass && r.sleepMs) process.on("exit", () => nap(r.sleepMs)); // after the unlock handler registered above
}
if (r && !r.pass) {
  unlock();
  if (r.sleepMs) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, r.sleepMs);
  if (r.output) process.stdout.write(r.output);
  if (r.stderr) process.stderr.write(r.stderr);
  if (r.signal) process.kill(process.pid, r.signal);
  process.exitCode = r.exit || 0;
  return;
}
if (TOOL !== "hc" && s.app && !s.app.window) {
  process.stderr.write("herdr-app: no Herdr window at " + s.socket + ": No such file or directory (os error 2)\n"); process.exitCode = 2; return;
}
const paneOf = (a) => (s.app.panes || {})[a] || "p" + a;
if (TOOL !== "hc" && s.app && argv[0] === "ls") {
  out({ spaces: s.app.spaces.map((sp) => ({ id: sp.id, name: sp.name, folder: "/", machine: null, active: true,
    tabs: sp.tabs.map((tb, i) => ({ id: tb.id, name: tb.name, active: i === 0, settled: false,
      terminals: tb.terminals.map((a) => ({ terminal: (s.app.cleared || []).includes(a) ? "" : a, pane: paneOf(a), status: null, app: null, name: null, sub_agents: [] })) })) })), recent: [] });
  return;
}
if (TOOL !== "hc" && s.app && argv[0] === "do" && argv[1] === "tab.rename") {
  const id = argv[argv.indexOf("--id") + 1], tb = s.app.spaces.flatMap((sp) => sp.tabs).find((x) => x.id === id);
  if (!tb) { out({ error: "no tab " + id }); process.exitCode = 1; return; }
  tb.name = argv[argv.indexOf("--name") + 1]; save(); out({ ok: true }); return;
}
if (TOOL !== "hc" && s.app && argv[0] === "do" && argv[1] === "pane.split") {
  const pane = argv[argv.indexOf("--pane") + 1];
  let space, tb, split;
  for (const sp of s.app.spaces) for (const x of sp.tabs) for (const a of x.terminals) if (paneOf(a) === pane) { space = sp.id; tb = x; split = a; }
  if (!tb) { out({ error: "no pane " + pane }); process.exitCode = 1; return; }
  const program = JSON.parse(argv[argv.indexOf("--argv") + 1]), address = hcAddress(++s.next);
  const term = Object.assign(blank(address), { argv: program, cwd: (s.terminals[split] || {}).cwd || "/", labels: { "herdr.space": space, "herdr.tab": tb.id },
    keep: true, notify: true, pid: 90000 + s.next });
  tb.terminals.splice(tb.terminals.indexOf(split) + 1, 0, address);
  if (s.execute) {
    const env = Object.assign({}, s.coreEnv, { HC_TERMINAL_ID: address, HC_TERMINAL_SOCKET: s.socket, HC_SCOPE: "scope-own-" + address });
    const c = cp.spawn(program[0], program.slice(1), { cwd: term.cwd, env, detached: true, stdio: "ignore" });
    c.unref();
    Object.assign(term, { pid: c.pid, spawned: true });
    if (Number.isInteger(c.pid) && c.pid > 0) s.spawnedPids = (s.spawnedPids || []).concat(c.pid); // a failed spawn has no pid
  }
  s.terminals[address] = term; save(); out({ pane: paneOf(address), terminal: address }); return;
}
if (TOOL !== "hc") { process.stderr.write("herdr-app: no fake rule for " + argv.join(" ") + "\n"); process.exitCode = 2; return; }
const [cmd, ...rest] = argv;
const pos = rest.filter((a) => !a.startsWith("-"));
const record = (t) => { const { screen, history, onSend, echo, ...r } = t; return Object.assign({ cols: 200, rows: 120, rm: false, title: "" }, r); };
const t = s.terminals[pos[0]];
const missing = () => fail("not_found", "no terminal \"" + pos[0] + "\"", 3);
switch (cmd) {
  case "server": {
    const all = Object.values(s.terminals);
    out({ core: { id: s.core.id, name: "host" }, finished: all.filter((x) => x.state === "finished").length, holder: null, holders: [],
      installed_by: null, live: all.filter((x) => x.state === "live").length, pid: s.core.pid, uptime_ms: 20, version: s.core.version });
    break;
  }
  case "run": {
    const sep = argv.indexOf("--"), opts = argv.slice(1, sep), program = argv.slice(sep + 1);
    const labels = {};
    opts.forEach((a, i) => { if (a === "--label") { const v = opts[i + 1], k = v.indexOf("="); labels[v.slice(0, k)] = v.slice(k + 1); } });
    const address = hcAddress(++s.next);
    const parented = !opts.includes("--no-parent") || s.forceParent;
    const term = Object.assign(blank(address), { argv: program, cwd: opts[opts.indexOf("--cwd") + 1], labels,
      parent: parented ? (s.forceParent || "t0") : null, die_with_parent: !!parented, notify: !opts.includes("--no-notify"), pid: 90000 + s.next });
    if (s.execute) {
      const env = Object.assign({}, s.coreEnv, { HC_TERMINAL_ID: address, HC_TERMINAL_SOCKET: s.socket, HC_SCOPE: "scope-own-" + address });
      s.terminals[address] = Object.assign({}, term); save(); unlock(); // the address is taken before the program runs
      const r = cp.spawnSync(program[0], program.slice(1), { cwd: term.cwd, env, encoding: "utf8" });
      lock(); s = JSON.parse(fs.readFileSync(STATE, "utf8"));
      const text = ((r.stdout || "") + (r.stderr || "")).replace(/\n$/, "");
      Object.assign(term, { state: "finished", exit_code: r.status, reason: "exited", screen: { text, complete: true }, history: { text, complete: true } });
    } else Object.assign(term, s.spawn);
    const sp = s.app && s.app.window && s.app.maps !== false && s.app.spaces.find((x) => x.id === labels["herdr.space"]);
    if (sp) {
      let tb = sp.tabs.find((x) => x.id === labels["herdr.tab"]);
      if (!tb) { tb = { id: "tb" + (++s.app.nextTab), name: String(sp.tabs.length + 1), terminals: [] }; sp.tabs.push(tb); }
      tb.terminals.push(address);
      Object.assign(term, { labels: s.app.tabLabel === false ? term.labels : Object.assign({}, term.labels, { "herdr.tab": tb.id }), keep: true });
    }
    s.terminals[address] = term;
    save();
    out({ address, agent: program[0] || "sh", cwd: term.cwd, name: null, state: term.state, turn: 0 });
    break;
  }
  case "get": case "label": case "keep": case "kill": {
    if (!t) return missing();
    if (cmd === "kill" && t.state === "live") {
      if (t.spawned) try { process.kill(-t.pid, "SIGKILL"); } catch {}
      Object.assign(t, { state: "finished", reason: "killed", signal: 1 });
    }
    if (cmd === "keep") t.keep = !rest.includes("--off");
    if (cmd === "label") for (const p of pos.slice(1)) { const k = p.indexOf("="); t.labels[p.slice(0, k)] = p.slice(k + 1); }
    save(); out(record(t)); break;
  }
  case "rm": {
    if (!t) return missing();
    if (t.state === "live") return fail("live", pos[0] + " is still running", 11);
    delete s.terminals[pos[0]];
    if (s.app) for (const sp of s.app.spaces) sp.tabs = sp.tabs.map((tb) => Object.assign(tb, { terminals: tb.terminals.filter((a) => a !== pos[0]) })).filter((tb) => tb.terminals.length);
    save(); out({ removed: pos[0] }); break;
  }
  case "ls":
    out({ hidden_finished: 0, terminals: Object.values(s.terminals).filter((x) => rest.includes("--all") || x.state === "live")
      .map((x) => Object.assign({ address: x.address, agent: "bash", cwd: x.cwd, name: null, state: x.state, turn: x.turn }, x.status ? { status: x.status.state } : {})) });
    break;
  case "read": {
    if (!t) return missing();
    const screenOnly = rest[rest.indexOf("--lines") + 1] === "0", r = screenOnly ? t.screen : t.history;
    out(Object.assign({ text: r.text, complete: r.complete, how: r.how || (screenOnly ? "screen" : "history") }, r.why ? { why: r.why } : {}));
    break;
  }
  case "send": {
    if (!t) return missing();
    if (t.state !== "live") return fail("finished", pos[0] + " has finished", 11);
    if (t.echo !== false) { t.screen.text += "\n" + pos[1]; t.history.text += "\n" + pos[1]; }
    // status is the one the input MET (captured Q3-status-working: idle, for a program that turned working on it).
    const started = t.onSend ? true : null, met = t.status ? t.status.state : null;
    if (t.onSend) Object.assign(t, t.onSend);
    save(); out({ started, status: met, turn: t.turn }); break;
  }
  case "keys":
    if (!t) return missing();
    out({ status: t.status ? t.status.state : null, turn: t.turn }); break;
  case "wait":
    if (!t) return missing();
    out({ children: [], ended: t.state === "finished", exit_code: t.exit_code, reason: t.state === "finished" ? "exit" : "timeout",
      signal: t.signal, status: t.status ? t.status.state : null, terminal: t.address, turn: t.turn });
    break;
  default: process.stderr.write("hc: fake has no " + cmd + "\n"); process.exitCode = 2;
}
`;

export class FakeHerdrApp {
  readonly hc: string;
  readonly app: string;
  readonly statePath: string;
  readonly logPath: string;

  constructor(readonly dir: string, init: Partial<FakeState> = {}) {
    this.hc = join(dir, "hc");
    this.app = join(dir, "herdr-app");
    this.statePath = join(dir, "fake-state.json");
    this.logPath = join(dir, "fake-calls.jsonl");
    writeFileSync(join(dir, "package.json"), '{"type":"commonjs"}\n');
    writeFileSync(this.logPath, "");
    this.write({
      core: { id: "f191f9b1503d40cb5c557bf9f3701747", version: "0.1.17", pid: 83545 },
      next: 0, socket: join(dir, "hc.sock"), terminals: {}, rules: [], execute: false,
      coreEnv: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: dir }, spawn: {}, ...init,
    });
    for (const [file, tool] of [[this.hc, "hc"], [this.app, "herdr-app"]] as const) {
      // The whole body runs inside a function so a handled case can `return`.
      writeFileSync(file, `#!${process.execPath}\n"use strict";\nconst TOOL = ${JSON.stringify(tool)}, STATE = ${JSON.stringify(this.statePath)}, LOG = ${JSON.stringify(this.logPath)};\nconst hcAddress = ${hcAddress.toString()};\n(() => {${SCRIPT}})();\n`);
      chmodSync(file, 0o755);
    }
  }

  read(): FakeState { return JSON.parse(readFileSync(this.statePath, "utf8")) as FakeState; }
  /** Atomic (tmp + rename), as the fakes save: read() takes no lock, so it must never see a half-written file. */
  write(state: FakeState): void { const tmp = `${this.statePath}.tmp${process.pid}`; writeFileSync(tmp, JSON.stringify(state)); renameSync(tmp, this.statePath); }
  /** Under the fakes' own state lock: a concurrent call's read-modify-write never clobbers the change. */
  update(fn: (s: FakeState) => void): void {
    const lock = this.statePath + ".lock";
    for (const until = Date.now() + 10_000; ;) {
      try { mkdirSync(lock); break; } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EEXIST" || Date.now() > until) throw e;
        try { if (Date.now() - statSync(lock).mtimeMs > 5000) rmdirSync(lock); } catch { /* released meanwhile */ } // stale, as the fakes break it
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 3);
      }
    }
    try { const s = this.read(); fn(s); this.write(s); } finally { rmdirSync(lock); }
  }
  term(address: string): FakeTerm { return this.read().terminals[address]; }
  setTerm(address: string, patch: Partial<FakeTerm>): void { this.update((s) => { Object.assign(s.terminals[address], patch); }); }
  rule(...rules: FakeRule[]): void { this.update((s) => { s.rules.push(...rules); }); }
  clearRules(): void { this.update((s) => { s.rules = []; }); }
  calls(): FakeCall[] { return readFileSync(this.logPath, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as FakeCall); }
  clearCalls(): void { writeFileSync(this.logPath, ""); }
  /** argv of every hc call whose first token is `cmd`. */
  hcCalls(cmd: string): string[][] { return this.calls().filter((c) => c.tool === "hc" && c.argv[0] === cmd).map((c) => c.argv); }
  /** SIGKILL every spawned board's process group still recorded live (never a finished one: its pid may be reused). */
  reap(): void {
    const st = this.read();
    const pids = new Set([...(st.spawnedPids ?? []), ...Object.values(st.terminals).filter((t) => t.spawned).map((t) => t.pid)]);
    // Only a real child pid: -0 (or -NaN) would signal this runner's own process group.
    for (const pid of pids) if (Number.isInteger(pid) && (pid as number) > 0) try { process.kill(-(pid as number), "SIGKILL"); } catch { /* already gone */ }
  }
}
