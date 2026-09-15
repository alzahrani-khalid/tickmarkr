// Consolidated TASKS view — the `status` board rebuilt in the watch redesign's language.
//
// 2026-08-05: parameterised by runId + graph so it can watch a LIVE run, not just the frozen
// v1.85 capture it was designed against. THE APPROVED OUTPUT IS PRESERVED: with no env set the
// defaults are exactly the pairing this was built and signed off on (v1.85's journal + v1.85's
// graph, kept byte-identical at overseer/graph-v185-safety-backup.json), and the header counts that
// used to be typed in are now DERIVED from that journal — which reproduces them (13 done, 20
// resumes, 94 escalations). A frozen figure in a design demo is still a frozen figure.
//
//   frozen contract :  COLS=150 node .overseer/design-prototypes/tasks-redesign.mjs
//   live run        :  COLS=150 TKR_RUN=run-20260804-234615 TKR_GRAPH=.tickmarkr/graph.json \
//                      TKR_BUDGET=95/29/9 node .overseer/design-prototypes/tasks-redesign.mjs
//
// TKR_BUDGET is dispatch/human/checkpoint ceilings; it adds one row and is absent by default, so
// the signed-off frame is unchanged without it.
import { readFileSync, readdirSync, existsSync, statSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
// FIXTURE COPY (BD-1): root, run and clock come from the environment so the committed board fixture
// renders the same frame on every machine; the graph sits at the prototype's own root-relative path
// (board-fixture.ts writes it there); see frame.150.txt. The
// design prototype is not linted; this copy is, and the sibling .oxlintrc.json keeps it verbatim.
const ROOT = process.env.TKR_ROOT ?? "/Users/khalidalzahrani/Desktop/CodingSpace/tickmarkr";
const NOW = () => Number(process.env.TKR_NOW ?? Date.now());
const RUN_ID = process.env.TKR_RUN ?? "run-20260801-122155";
const RUN = `${ROOT}/.tickmarkr/runs/${RUN_ID}`;
const GRAPH_PATH = `${ROOT}/${process.env.TKR_GRAPH ?? ".tickmarkr/overseer/graph-v185-safety-backup.json"}`;
const W = Number(process.env.COLS ?? 150);

const E = "\x1b[", R = `${E}0m`;
const c = (n) => (s) => `${E}38;5;${n}m${s}${R}`;
const bg = (f, b) => (s) => `${E}38;5;${f};48;5;${b}m${s}${R}`;
const bold = (s) => `${E}1m${s}${E}22m`;
const chrome = c(238), mute = c(243), body = c(252), faint = c(240);
const accent = c(75);                       // structure + focus. green is freed.
const pass = c(71), fail = c(174), warn = c(179), park = c(140);
const vw = (s) => s.replace(/\x1b\[[0-9;]*m/g, "").length;
const pad = (s, n) => s + " ".repeat(Math.max(0, n - vw(s)));
const lpad = (s, n) => " ".repeat(Math.max(0, n - vw(s))) + s;
const rule = (n = W) => chrome("─".repeat(n));

const graph = JSON.parse(readFileSync(GRAPH_PATH, "utf8"));
// A live run has no journal at all during baseline capture, and a surface that CRASHES there is the
// worst possible answer to "what is happening?" — it reads as broken tooling, not as a quiet phase.
const ev = existsSync(`${RUN}/journal.jsonl`)
  ? readFileSync(`${RUN}/journal.jsonl`, "utf8").trim().split("\n")
    .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean)
  : [];

// GATES — fixed order, fixed width, header aligned to the cells. This is the whole point.
const GATES = ["build", "test", "lint", "evidence", "scope", "acceptance", "review"];
const CELL = 3;                              // every gate occupies exactly 3 columns

// ── AREA — derived from files[], never declared (consult ruling 2026-08-06) ──────────────────────────
// SET semantics, never a vote. One files[] entry may be a file, a glob, or a brace expression, so
// `src/config/{config,fleet-overlay}.ts` is ONE entry and TWO files: counting lets a rewrite of the same
// scope change the label without changing the task. GATE is kept apart from RUN on purpose — "gates never
// trust worker claims" is the product's central boundary, and a taxonomy that files the runner with the
// verifier erases it on the surface whose job is to show it.
const AREAS = [
  ["SPEC",  [/^src\/(compile|graph|plan)\//]],
  ["FLEET", [/^src\/(route|config|adapters)\//]],
  ["RUN",   [/^src\/(run|drivers|eval)\//]],
  ["GATE",  [/^src\/gates\//]],
  ["UI",    [/^src\/(cli|tui|report)\//, /^src\/brand\.ts/]],
  ["DOCS",  [/^(docs|skills)\//]],
  ["REPO",  [/^(scripts|schema)\//, /^\.github\//, /^tests\/(lint|repo|helpers)\//, /^(vitest\.config|package\.json|tsconfig)/]],
];
const AREA_ORDER = AREAS.map(([n]) => n);
// A brace group expands before matching, or `src/{run,gates}/x.ts` matches nothing and vanishes silently.
const expandBraces = (p) => {
  const m = /^(.*?)\{([^}]*)\}(.*)$/.exec(p);
  return m ? m[2].split(",").flatMap((alt) => expandBraces(`${m[1]}${alt.trim()}${m[3]}`)) : [p];
};
const areaOf = (path) => {
  for (const [name, res] of AREAS) if (res.some((re) => re.test(path))) return name;
  return null;
};
/** {codes, unmapped} — abstentions applied, set semantics, misses reported rather than dropped. */
function areasFor(task) {
  const files = (task.files ?? []).flatMap(expandBraces);
  const unmapped = [];
  const hit = new Set(), softTest = new Set(), softCli = new Set();
  for (const f of files) {
    // tests/X mirrors src/X, but tests follow the PROOF, not the domain: a docs task proven in
    // tests/gates/ is not a gates task. They abstain unless they are all there is.
    const mirrored = f.replace(/^tests\//, "src/");
    const a = areaOf(f) ?? areaOf(mirrored);
    if (!a) { unmapped.push(f); continue; }
    if (/^tests\//.test(f)) softTest.add(a);
    // src/cli/commands/ is a fan-out over every domain, not a domain of its own.
    else if (/^src\/cli\//.test(f)) softCli.add(a);
    else hit.add(a);
  }
  let codes = [...hit];
  if (!codes.length) codes = [...softCli];
  if (!codes.length) codes = [...softTest];
  codes.sort((x, y) => AREA_ORDER.indexOf(x) - AREA_ORDER.indexOf(y));
  return { codes, unmapped };
}
const gateOf = {}, attempts = {}, reviews = {}, channel = {}, parked = {}, retries = {};
for (const e of ev) {
  const t = e.taskId; if (!t) continue;
  if (e.event === "gate-result") (gateOf[t] ??= {})[e.data.gate] = e.data.pass;
  if (e.event === "task-dispatch") { attempts[t] = (attempts[t] ?? 0) + 1;
    const a = e.data?.assignment; if (a) channel[t] = `${a.adapter}:${a.model}`; }
  if (e.event === "task-human") parked[t] = (parked[t] ?? 0) + 1;
  if (e.event === "review-retry") retries[t] = (retries[t] ?? 0) + 1;
}
// Review ROUNDS come from the journal, not from `review-raw-*` files. Those are written at exactly one
// site — src/gates/review.ts:495, inside the branch entered only when extractVerdictJson FAILS — so they
// count UNPARSEABLE VERDICTS, not rounds. Measured on run-20260805-164546: 23 real rounds across 16 tasks
// against 4 raw files across 2. The old line rendered T4 as 1 (truth 2) and zero for fourteen tasks that
// drew rounds, while T21's 3 was right BY COINCIDENCE — three parse failures colliding with three genuine
// rounds. That coincidence is what made it worse than the zero it replaced: a plausible number does not
// read as broken, so a seat spot-checking T21 against the journal would confirm it and stop.
// Positive control, free and on disk: this run must render T4 2 and T30 3. A version showing T4 1 has
// inherited the defect. Matches the product's own reviewRoundsSinceApproval (src/run/journal.ts:87-95),
// which the daemon parks on — so this counts the same thing the run itself enforces.
for (const e of ev) if (e.event === "gate-result" && e.data?.gate === "review" && e.taskId) reviews[e.taskId] = (reviews[e.taskId] ?? 0) + 1;

// ── header: ONE status owner, no bar, no duplicate counts, no 6-row logo ─────
// Every count derived. The run that produced the signed-off frame still renders it.
const n = (e) => ev.filter((x) => x.event === e).length;
const seen = new Set(ev.map((e) => e.taskId).filter(Boolean));
const doneIds = new Set(ev.filter((e) => e.event === "task-done").map((e) => e.taskId));
// Elapsed spans the journal when there is one; before the first event it spans the lock's own start.
let lockStart;
try { lockStart = JSON.parse(readFileSync(`${ROOT}/.tickmarkr/graph.lock`, "utf8")).startedAt; } catch { /* none */ }
const t0 = ev.length ? new Date(ev[0].ts) : new Date(lockStart ?? NOW());
const t1 = ev.length ? new Date(ev[ev.length - 1].ts) : new Date();
const hm = (ms) => `${Math.floor(ms / 3.6e6)}h${String(Math.floor((ms % 3.6e6) / 6e4)).padStart(2, "0")}m`;
const dur = (ms) => (ms < 6e4 ? `${Math.max(1, Math.round(ms / 1e3))}s` : ms < 3.6e6 ? `${Math.round(ms / 6e4)}m` : `${(ms / 3.6e6).toFixed(1)}h`);
const ago = (ms) => (ms < 6e4 ? "just now" : ms < 3.6e6 ? `${Math.round(ms / 6e4)}m ago` : `${Math.round(ms / 3.6e6)}h ago`);
// Liveness from the lock's OWN pid, never from a name pattern: the lock names its holder.
let lockPid, lockRun;
try {
  const lk = JSON.parse(readFileSync(`${ROOT}/.tickmarkr/graph.lock`, "utf8"));
  lockPid = lk.pid; lockRun = lk.runId;
} catch { /* no lock */ }
const daemonAlive = (() => { try { process.kill(lockPid, 0); return true; } catch { return false; } })();
const live = lockRun === RUN_ID && daemonAlive;


// ── OUTPUT INVARIANTS (2026-08-05) ───────────────────────────────────────────
// The in-place repaint STACKED frames instead of overwriting them, and both causes are invariants
// this frame never enforced:
//   1. a line wider than the pane WRAPS, so the rendered line count exceeds out.length;
//   2. a frame taller than the pane SCROLLS, so the next cursor-home writes below the previous frame
//      instead of over it, and every tick appends another copy.
// Enforced here, once, at the boundary — rather than per-section, where the next added section forgets.
const clip = (s, n) => {
  let out = "", vis = 0, i = 0;
  while (i < s.length) {
    if (s[i] === "\x1b") { const m = /^\x1b\[[0-9;]*m/.exec(s.slice(i)); if (m) { out += m[0]; i += m[0].length; continue; } }
    if (vis >= n) return `${out}\x1b[0m`;
    out += s[i]; vis += 1; i += 1;
  }
  return out;
};
const fit = (lines, w, rows) => {
  const clipped = lines.map((l) => clip(l, w));
  // rows - 1, not rows: a frame occupying every row advances the cursor past the last one, the pane
  // scrolls by one, and the next cursor-home repaint starts one line lower — which is what made the
  // header drift off the top and the frames appear to stack.
  const cap = rows ? rows - 1 : 0;
  if (!cap || clipped.length <= cap) return clipped;
  // Drop from the BOTTOM, which is where the least decision-relevant material lives: the chart and
  // legend before the task table, and never the NOW/WAITING/BUDGET header an operator reads first.
  const keep = clipped.slice(0, cap - 1);
  return [...keep, clip(`${chrome(`  … ${clipped.length - keep.length} more lines than this pane has rows`)}`, w)];
};
const ROWS = Number(process.env.TKR_ROWS ?? 0);

const out = [];
// Narrow panes drop the two least decision-relevant segments rather than wrapping: a wrapped header
// is worse than a shorter one, because it pushes NOW off the first screen the operator looks at.
const wide = W >= 118;
out.push(`${bg(16, 2)(" tickmarkr ")} ${bold(RUN_ID)}  ${chrome("│")}  ` +
  `${pass(`${doneIds.size}/${graph.tasks.length} done`)}  ` +
  (wide
    ? `${chrome("│")}  ${warn(`${n("run-resume")} restarts`)}  ${chrome("│")}  ${fail(`${n("escalation")} escalations`)}  `
    : `${chrome("│")}  ${fail(`${n("escalation")} esc`)}  `) +
  `${chrome("│")}  ${mute(`${hm(t1 - t0)}${wide ? ` · ${ago(NOW() - t1)}` : ""}`)}` +
  `${live ? `  ${chrome("│")}  ${pass("● LIVE")}` : ""}`);
out.push("");

// ── NOW / WAITING FOR ────────────────────────────────────────────────────────
// The signed-off frame was designed against a FINISHED run (13/13 done), so it never needed to say
// what was happening this instant — and pointed at a live run that is exactly its blind spot: an
// operator reads 24 rows of state and cannot tell whether the machine is working, parked, or dead.
// Gated on TKR_LIVE so the frozen contract renders byte-identically without it.
if (process.env.TKR_LIVE) {
  const last = ev[ev.length - 1];
  const lastAge = last ? NOW() - new Date(last.ts) : undefined;
  const lastOf = (name) => [...ev].reverse().find((e) => e.event === name);
  const endEv = lastOf("run-end");
  const ended = endEv && (!last || endEv === last);
  const humanEv = lastOf("task-human");
  let now, waiting;

  if (!ev.length) {
    now = live
      ? `${warn("BASELINE CAPTURE")}  ${mute("recording which failures are pre-existing, so a worker is not blamed for them")}`
      : `${fail("NO JOURNAL AND NO LIVE DAEMON")}  ${mute("nothing is running")}`;
    waiting = live
      ? `${body("the machine")} ${mute("— silent by design; the full suite runs before the first dispatch, ~5 min. Journal not written yet.")}`
      : `${body("you")} ${mute("— start a run, or investigate why the daemon exited before writing a journal")}`;
  } else if (ended) {
    const d = endEv.data ?? {};
    // TIP VERIFY IS PART OF THE VERDICT, and this panel used to omit it entirely: a run that ended RED
    // rendered byte-identically to one that ended green. The project's own law says a run is green only
    // when run-end exists AND tip verify is not failed — and the surface whose whole job is to report the
    // run's verdict was reporting half of it. THREE states, because "ended with no tip verify at all" is
    // not the same as verified green and must never borrow its colour.
    const tvFailed = ev.filter((e) => e.event === "tip-verify-failed");
    const tvPassed = ev.filter((e) => e.event === "tip-verify");
    const tipState = tvFailed.length ? "failed" : tvPassed.length ? "passed" : "absent";
    const tally = `${(d.done ?? []).length} merged · ${(d.human ?? []).length} parked · ${(d.blocked ?? []).length} dep-blocked`;
    // contract correction (RULING-231-19 §2): green needs the FOUR buckets — failed, human, blocked,
    // pending — every one present and empty; a passed tip alone never borrows the colour.
    const BUCKETS = ["failed", "human", "blocked", "pending"];
    const parkedIn = BUCKETS.filter((k) => Array.isArray(d[k]) && d[k].length).map((k) => `${k} ${d[k].join(",")}`);
    const unknownIn = BUCKETS.filter((k) => !Array.isArray(d[k])).map((k) => `${k} bucket unknown`);
    now = tipState === "failed"
      ? `${fail("RUN ENDED — TIP VERIFY FAILED")}  ${mute(`${[...new Set(tvFailed.map((e) => e.data?.gate).filter(Boolean))].join(" ")} · ${tally}`)}`
      : parkedIn.length || unknownIn.length
      ? `${fail("RUN ENDED — NOT GREEN")}  ${mute(`${[...parkedIn, ...unknownIn].join(" · ")} · ${tally}`)}`
      : tipState === "passed"
      ? `${pass("RUN ENDED — GREEN")}  ${mute(`tip passed · ${tally}`)}`
      : `${warn("RUN ENDED — TIP NOT VERIFIED")}  ${mute(`no tip-verify recorded · ${tally}`)}`;
    waiting = (d.human ?? []).length
      ? `${accent("the OVERSEER")} ${mute(`— ${(d.human ?? []).join(", ")} parked on a human gate. Nothing moves until it is released or the run is restarted.`)}`
      : `${accent("the OVERSEER")} ${mute("— the run is over; read the record before starting another")}`;
  } else if (!live) {
    now = `${fail("DAEMON GONE WITH NO run-end")}  ${mute(`last event ${ago(lastAge)}: ${last.event}${last.taskId ? " · " + last.taskId : ""}`)}`;
    waiting = `${fail("investigation")} ${mute("— this is a crash, not a park. Do not resume before reading the tail.")}`;
  } else if (humanEv && humanEv === last) {
    const why = String(humanEv.data?.reason ?? "").split("\n")[0].slice(0, 96);
    now = `${park("PARKED")}  ${mute(`${humanEv.taskId} · human gate · nothing will move until it is released`)}`;
    waiting = `${accent("the OVERSEER")}  ${body(why)}`;
  } else if (last.event === "tip-verify-start") {
    // TIP VERIFY is RUN-scoped: it carries no taskId, so every task-derived field below is stale by
    // construction. Without this branch the panel fell through to WORKER RUNNING, clocked the last
    // worker-launch (45m old) and the last worker-status (44m old), and rendered a RED "past the stall
    // window" over a run that was two minutes into a normal verify. The comment twelve lines down already
    // states the rule — "clocking the wrong phase is how a healthy gate reads as a stalled worker" — and
    // the code did exactly that, because the rule was applied to gates and never to run-scoped phases.
    // The false alarm is the dangerous direction: it is what gets a healthy run killed.
    const gates = (last.data?.gates ?? []).join(" ");
    now = `${warn("TIP VERIFY")}  ${mute(`${gates || "build test lint"} on the merged tip · ${dur(NOW() - new Date(last.ts))} in`)}`;
    waiting = `${body("the machine")}  ${mute(wide ? "verifying the integration branch; run-end follows. No worker is running — the heartbeat clock does not apply." : "tip verify")}`;
  } else {
    const wl = lastOf("worker-launch"), disp = lastOf("task-dispatch");
    const tid = last.taskId ?? disp?.taskId;
    const chan = disp?.data?.assignment ? `${disp.data.assignment.adapter}:${disp.data.assignment.model}` : "—";
    const att = disp?.data?.attempt;
    const phase = lastOf("phase-start");
    // The journal records the phase as "gate:build", not "build" — comparing against the bare gate
    // name silently never matched, so the surface said WORKER RUNNING while a gate was executing.
    // Caught because build passed and NOW did not change. Strip the namespace, and keep the raw value
    // in the label so a future rename of the prefix shows up instead of failing quiet again.
    const phaseName = String(phase?.data?.phase ?? "").replace(/^gate:/, "");
    const inGate = phase && GATES.includes(phaseName) && (!wl || new Date(phase.ts) > new Date(wl.ts));
    // A run-scoped event this panel does not model must NAME ITSELF rather than fall through to the
    // most task-shaped label available. The fallthrough is the defect, not the missing branch: an
    // unmodelled state rendered as WORKER RUNNING is a confident wrong answer, and it clocks timers that
    // belong to a different subject. Unknown states are rare and loud; wrong ones are silent.
    const runScoped = !last.taskId && !tid;
    now = runScoped
      ? `${warn(last.event.replace(/-/g, " ").toUpperCase())}  ${mute(`run-scoped · ${dur(NOW() - new Date(last.ts))} in · no task attached`)}`
      : inGate
      ? `${warn(`GATE ${phaseName.toUpperCase()}`)}  ${mute(`${tid} · ${dur(NOW() - new Date(phase.ts))} in`)}`
      : `${pass("WORKER RUNNING")}  ${mute(`${tid} · attempt ${att ?? "?"} · ${chan} · ${dur(NOW() - new Date((wl ?? last).ts))} in`)}`;
    // The shipped board's one element this frame lacked, and the one I would not have thought of: a
    // STALL clock. Elapsed says the worker is young; silence says whether it is still breathing.
    // Proxy is the last worker-status heartbeat — named as a proxy, because it is journal signal and
    // not the pane's own output, and a surface that overstates its instrument is the defect it exists
    // to catch. Amber past the 25-minute stall window the worker contract declares.
    const beat = lastOf("worker-status") ?? wl;
    const quiet = beat ? NOW() - new Date(beat.ts) : undefined;
    const stall = quiet === undefined ? "" : quiet > 25 * 6e4 ? fail(`no signal ${ago(quiet).replace(" ago", "")} — past the stall window`)
      : quiet > 6e5 ? warn(`no signal ${ago(quiet).replace(" ago", "")}`) : mute(`signal ${ago(quiet)}`);
    // A gate produces no journal events until it finishes, so the worker heartbeat is stale BY DESIGN
    // once gates start. Clocking the wrong phase is how a healthy gate reads as a stalled worker.
    waiting = runScoped
      ? `${body("the machine")}  ${mute(`(${last.event}) — no worker is attached; the heartbeat clock does not apply.`)}`
      : inGate
      ? `${body("the machine")}  ${mute(`gate ${phaseName} running ${dur(NOW() - new Date(phase.ts))}`)}  ${mute(wide ? "— a gate emits nothing until it finishes; the full suite is ~5 min." : "")}`
      : `${body("the machine")}  ${stall}  ${mute(wide ? `(${last.event}) — a worker heartbeats; silence here is the signal.` : `(${last.event})`)}`;
  }
  // PULSE TARGET. The label animates only while something is genuinely running, and the animation is
  // done by the DRIVER recolouring this one cell — not by re-rendering the frame, which would either
  // cost a node process every 250ms or reintroduce the flash. So the renderer publishes the cell's
  // coordinates and the label text; nothing else needs to know about the animation.
  const nowPrefix = `  ${accent("▌")} ${bold("NOW")}        `;
  out.push(`${nowPrefix}${now}`);
  if (process.env.TKR_LIVE && process.env.TKR_PULSE_FILE) {
    const activeLabel = /^(GATE [A-Z]+|WORKER RUNNING|BASELINE CAPTURE)/.exec(
      now.replace(/\x1b\[[0-9;]*m/g, ""),
    )?.[1];
    try {
      writeFileSync(process.env.TKR_PULSE_FILE, activeLabel
        ? `${out.length} ${vw(nowPrefix) + 1} ${activeLabel}\n`
        : "");
    } catch { /* the pulse is decoration; never let it break the frame */ }
  }
  out.push(`    ${faint("WAITING ON")} ${waiting}`);
  out.push("");
}
// The budget is the decision this surface exists to serve: a ceiling reached is a PARK, not a note.
// ENGAGEMENT COST, not per-journal cost. A restarted run gets a fresh journal, so a budget read from
// one journal under-reports by every prior attempt — measured: 5/95 shown while 10 dispatches had been
// spent on one task across two runs of the same graph. That is the instrument lying about the exact
// number it exists to defend. Runs join on run-start.graphDefinitionHash, which the daemon calls the
// engagement identity; `supersedes` is null here because the prior run had already ended, so lineage
// cannot be read from the journals and must be derived.
const RUNS_DIR = `${ROOT}/.tickmarkr/runs`;
const myHash = ev.find((e) => e.event === "run-start")?.data?.graphDefinitionHash;
let carried = { d: 0, h: 0, e: 0, runs: 0 };
// A recompile CHANGES graphDefinitionHash, so hash-join sees one slice and calls it the milestone.
// The sound engagement key is git ancestry: a prior run belongs here iff its integration branch is
// already merged into my baseRef. Kept separate from `carried` ON PURPOSE — the budget cap is a
// per-graph parity ceiling, and folding three runs of dispatches into it would render a false BREACH.
const myBase = ev.find((e) => e.event === "run-start")?.data?.baseRef;
const lineage = { runs: 0, merged: new Set() };
// Ancestry ALONE is far too permissive: every integration branch ever merged to trunk is an ancestor of
// my baseRef, so the naive test matched 51 runs and reported them as this milestone. An inclusion rule
// excludes nothing while looking precise. The second half of the key is the spec branch's fork point —
// a run belongs only if it was cut AFTER this milestone's branch left trunk.
// If no trunk is found the engagement line is SUPPRESSED rather than guessed: no number beats a wrong one.
let forkPoint = null;
if (myBase) {
  for (const trunk of ["main", "master"]) {
    try {
      forkPoint = execFileSync("git", ["merge-base", trunk, myBase], { cwd: ROOT, encoding: "utf8" }).trim();
      break;
    } catch { /* trunk absent under this name */ }
  }
}
if (myHash) {
  const cutoff = NOW() - 14 * 864e5;   // bound the scan; older engagements cannot be this one
  for (const dir of readdirSync(RUNS_DIR)) {
    if (dir === RUN_ID) continue;
    const j = `${RUNS_DIR}/${dir}/journal.jsonl`;
    if (!existsSync(j) || statSync(j).mtimeMs < cutoff) continue;
    let txt;
    try { txt = readFileSync(j, "utf8"); } catch { continue; }
    const first = txt.slice(0, txt.indexOf("\n") + 1 || undefined);
    let h;
    try { h = JSON.parse(first)?.data?.graphDefinitionHash; } catch { continue; }
    if (h === myHash) {
      carried.runs += 1;
      for (const line of txt.split("\n")) {
        if (line.includes('"event":"task-dispatch"')) carried.d += 1;
        else if (line.includes('"event":"task-human"')) carried.h += 1;
        else if (line.includes('"event":"escalation"')) carried.e += 1;
      }
      continue;
    }
    let branch;
    try { branch = JSON.parse(first)?.data?.branch; } catch { continue; }
    if (!branch || !myBase || !forkPoint) continue;
    try { execFileSync("git", ["merge-base", "--is-ancestor", branch, myBase], { cwd: ROOT, stdio: "ignore" }); }
    catch { continue; }
    // predates this milestone's branch -> a different engagement entirely
    try { execFileSync("git", ["merge-base", "--is-ancestor", branch, forkPoint], { cwd: ROOT, stdio: "ignore" }); continue; }
    catch { /* not an ancestor of the fork = cut after it = ours */ }
    lineage.runs += 1;
    for (const line of txt.split("\n")) {
      if (!line.includes('"event":"merge"')) continue;
      try { const e = JSON.parse(line); if (e.event === "merge" && e.taskId) lineage.merged.add(e.taskId); } catch { /* partial line */ }
    }
  }
}
if (process.env.TKR_BUDGET) {
  const [dCap, hCap, ckpt] = process.env.TKR_BUDGET.split("/").map(Number);
  const d = n("task-dispatch") + carried.d, h = n("task-human") + carried.h;
  const gauge = (v, cap) => (v > cap ? fail(`${v}/${cap} BREACHED`) : v > cap * 0.8 ? warn(`${v}/${cap}`) : body(`${v}/${cap}`));
  out.push(`  ${accent("▌")} ${bold("BUDGET")}   ${wide ? mute("v1.85 parity is the FAILURE condition, not the target") + "   " : ""}` +
    `${faint("dispatch")} ${gauge(d, dCap)}   ${faint("human")} ${gauge(h, hCap)}   ` +
    `${faint("checkpoint")} ${doneIds.size >= ckpt ? warn(`${doneIds.size}/${ckpt} GO/NO-GO DUE`) : body(`${doneIds.size}/${ckpt}`)}` +
    (carried.runs ? `   ${faint(`+${carried.d} carried / ${carried.runs} superseded`)}` : ""));
  out.push("");
}
const engLanded = new Set([...lineage.merged, ...doneIds]);
// Total = everything ever landed + everything still live in THIS graph. Derived, never a stored constant:
// the union of task ids ever SEEN over-counts, because ids retired at a recompile never landed.
const engTotal = engLanded.size + (graph.tasks.length - doneIds.size);
out.push(`  ${accent("▌")} ${bold("TASKS")}   ${mute(`${doneIds.size} of ${graph.tasks.length} merged in this graph`)}` +
  (lineage.runs ? mute(` · ${engLanded.size} of ${engTotal} landed across the engagement (${lineage.runs + 1} runs)`) : "") +
  // contract correction (RULING-231-19 §2): declaration order — acceptance ‖ review run concurrently.
  (wide ? mute(" · rows in dispatch order · gates left→right in declaration order") : ""));
out.push("");

// ── aligned gate header: each label truncated to the cell it owns ────────────
// Dependencies are first-class graph structure, not a transient waiting-state note. Keep them in
// their own scan column; the two prose columns remain elastic so the gate matrix never moves.
const AREA_W = 16;                                 // 15 content cells + separator
const DEPS_W = 14;                                 // dependency ids, compacted only when they cannot fit
const FIXED = 4 + 5 + AREA_W + DEPS_W + CELL * GATES.length + 2 + 5;  // indent + id + area + deps + matrix + gap + att
const NOTE_RESERVE = 28;
const elastic = Math.max(30, W - FIXED - NOTE_RESERVE);
const LBL = Math.min(46, Math.max(18, Math.round(elastic * 0.62)));
const CHAN = Math.min(26, Math.max(12, elastic - LBL));
const gateHead = GATES.map((g) => faint(pad(g.slice(0, CELL - 1), CELL))).join("");
out.push(`    ${pad("", 5)}${pad(faint("area"), AREA_W)}${pad(faint("deps"), DEPS_W)}${pad(faint("task"), LBL)}${gateHead}  ${pad(faint("channel"), CHAN)}${pad(faint("att"), 5)}${faint("note")}`);
out.push(`    ${chrome("─".repeat(Math.min(W - 4, 5 + LBL + CELL * GATES.length + 2 + CHAN + 5 + 30)))}`);

const areaTally = new Set(), unmappedPaths = new Set();
for (const t of graph.tasks) {
  const g = gateOf[t.id] ?? {};
  // `acceptance` and `review` are the only optional gates, so an empty cell means one of TWO things —
  // not run YET, or never declared for this task. One glyph for both is the silence this milestone is named
  // for. task.gates carries the declaration, so they are distinguishable and now drawn apart.
  const declared = new Set(t.gates ?? GATES);
  const strip = GATES.map((k) => {
    const v = g[k];
    return pad(v === true ? pass("✔") : v === false ? fail("✖") : !declared.has(k) ? faint("─") : faint("·"), CELL);
  }).join("");
  const unrun = GATES.filter((k) => declared.has(k) && g[k] === undefined).length;
  const failed = GATES.filter((k) => g[k] === false).length;
  // interesting rows earn weight; boring rows recede. that is the hierarchy.
  const hot = (parked[t.id] ?? 0) > 3 || failed > 0 || unrun > 2;
  const id = hot ? accent(bold(pad(t.id, 5))) : mute(pad(t.id, 5));
  const { codes: acodes, unmapped: aun } = areasFor(t);
  acodes.forEach((c) => areaTally.add(c));
  aun.forEach((u) => unmappedPaths.add(u));
  // An UNMAPPED path is actionable data, not absence: `—` is reserved for a genuinely empty files[].
  let alabel = acodes.length ? acodes.join("+") : (aun.length ? "UNMAPPED" : "—");
  if (alabel.length > AREA_W - 2) {
    let keep = [], n = acodes.length;
    for (const c of acodes) { if ([...keep, c].join("+").length + 3 > AREA_W - 2) break; keep.push(c); }
    alabel = `${keep.join("+")}+${n - keep.length}`;   // never cut a code mid-word
  }
  const area = pad(hot ? body(alabel) : faint(alabel), AREA_W);
  const depIds = t.deps ?? [];
  const depText = depIds.length ? depIds.join(",") : "—";
  const depLabel = depText.length <= DEPS_W - 2
    ? depText
    : depIds.length > 1 ? `${depIds[0]}+${depIds.length - 1}` : `${depIds[0].slice(0, DEPS_W - 3)}…`;
  const deps = pad(faint(depLabel), DEPS_W);
  const title = hot ? body(pad(t.title.slice(0, LBL - 2), LBL)) : faint(pad(t.title.slice(0, LBL - 2), LBL));
  const note = [
    (parked[t.id] ?? 0) >= 3 ? park(`◍ parked ×${parked[t.id]}`) : "",
    (reviews[t.id] ?? 0) > 2 ? warn(`↻ ${reviews[t.id]} review rounds`) : "",
    failed ? fail(`✖ ${GATES.filter((k) => g[k] === false).join(",")}`) : "",
    // "N gates never ran" was 24 of 25 rows and said nothing an operator can act on. What they need
    // is WHY a task has not started — which dep is holding it — and that is derivable from the graph.
    !attempts[t.id]
      ? (() => {
        const blockers = (t.deps ?? []).filter((d) => !doneIds.has(d));
        if (!blockers.length) return faint("queued");
        // A wrapped row is worse than a summarised one: wrapping breaks the column alignment the gate
        // matrix depends on, and alignment is what makes the matrix readable at a glance.
        const room = Math.max(10, W - FIXED - LBL - CHAN);
        let shown = blockers, dropped = 0;
        while (shown.length > 1 && `waiting on ${shown.join(", ")}`.length + (dropped ? 5 : 0) > room) {
          shown = shown.slice(0, -1); dropped = blockers.length - shown.length;
        }
        return faint(`waiting on ${shown.join(", ")}${dropped ? ` +${dropped}` : ""}`);
      })()
      // A dispatched task with no gate results yet is IN FLIGHT, not neglected. "7 gates never ran"
      // read as an indictment of the one task actually working, which is the opposite of the truth;
      // NOW already names it, so the row says what phase it reached and stops there.
      : unrun === declared.size ? faint("in flight")
        : unrun > 2 ? faint(`${declared.size - unrun}/${declared.size} gates run`) : "",
  ].filter(Boolean).join(mute(" · "));
  out.push(`    ${id}${area}${deps}${title}${strip}  ${pad(mute((channel[t.id] ?? "—").slice(0, CHAN - 2)), CHAN)}${pad(mute(String(attempts[t.id] ?? 0)), 5)}${note}`);
}
out.push("");
// Tasks that LANDED IN EARLIER RUNS are removed from the spec at recompile so the next run does not redo
// them — correct, and it made them vanish from the only surface anyone watches. "24 of 29" told the
// operator ten tasks existed somewhere and named none of them, so the honest question "where did T1 go?"
// had no answer on the board. Names, not just a count: a number you cannot resolve to items is a claim.
if (lineage.merged.size) {
  const prior = [...lineage.merged].sort((a, b) => (parseInt(a.slice(1), 10) || 0) - (parseInt(b.slice(1), 10) || 0));
  out.push(`    ${faint("landed")}  ${mute(`${prior.length} in earlier runs, retired from this graph:`)} ${prior.map((id) => faint(id)).join(" ")}`);
}
out.push(`    ${faint("area")}    ${AREA_ORDER.map((a) => (areaTally.has(a) ? body(a) : faint(a))).join(mute(" · "))}${unmappedPaths.size ? mute("   ") + fail(`${unmappedPaths.size} unmapped`) : ""}`);
if (unmappedPaths.size) out.push(`    ${pad("", 8)}${fail("UNMAPPED")} ${mute([...unmappedPaths].slice(0, 3).join("  "))}${unmappedPaths.size > 3 ? mute(`  +${unmappedPaths.size - 3}`) : ""}`);
out.push(`    ${faint("gates")}   ${GATES.map((k) => `${body(k.slice(0, CELL - 1))} ${mute(k)}`).join("  ")}`);
out.push(`    ${faint("     ")}   ${pass("✔")} ${mute("passed")}   ${fail("✖")} ${mute("failed")}   ${faint("·")} ${mute("pending")}   ${faint("─")} ${mute("not declared (acceptance and review are the optional two)")}`);
out.push("");
// the gap is stated, never silently skipped — derived, so it cannot go stale
const retired = [...seen].filter((id) => !graph.tasks.some((t) => t.id === id)).sort();
for (const id of retired) out.push(`    ${faint(id)}  ${faint("— not in this graph (retired at compile)")}`);
if (retired.length) out.push("");
out.push(rule());
out.push("");
// ── where the run actually spent itself, per task — the thing the old board hid ──
const worst = graph.tasks.map((t) => ({ id: t.id, p: parked[t.id] ?? 0, r: reviews[t.id] ?? 0, a: attempts[t.id] ?? 0 }))
  .sort((x, y) => (y.p + y.r + y.a) - (x.p + x.r + x.a)).slice(0, 4);
out.push(`  ${accent("▌")} ${bold("WHERE THE EFFORT WENT")}   ${mute(`dispatches · review rounds · human parks — top ${worst.length} of ${graph.tasks.length} tasks`)}`);
out.push("");
const maxTot = Math.max(...worst.map((w) => w.a + w.r + w.p), 1);
for (const w of worst) {
  const barw = Math.min(46, Math.max(16, W - 60));
  const seg = (n, col) => col("█".repeat(Math.max(0, Math.round((n / maxTot) * barw))));
  out.push(`    ${accent(pad(w.id, 6))}${seg(w.a, accent)}${seg(w.r, warn)}${seg(w.p, park)}  ` +
    `${mute(`${w.a} dispatch`)}${mute(" · ")}${warn(`${w.r} review`)}${mute(" · ")}${park(`${w.p} park`)}`);
}
out.push("");
out.push(`    ${mute("legend")}  ${accent("█")} ${faint("dispatch")}  ${warn("█")} ${faint("review round")}  ${park("█")} ${faint("human park")}`);
out.push("");
// The prototype's key hints are the DESIGN's aspiration; in a live pane nothing handles them, and a
// footer advertising keys that do nothing is the same class of lie as a green gate that never ran.
out.push(process.env.TKR_LIVE
  ? chrome(` redraw: SIGWINCH + 2s tick · width ${W} · read-only surface, no keys handled yet`)
  : chrome(" ↑↓ move · ↵ task detail · g gate detail · j journal · f fleet · / filter · r refresh 5s · q quit"));
// Repaint IN PLACE for a live pane: cursor home, every line erasing to end-of-line as it is
// rewritten, then erase-to-end-of-screen for a frame that shrank. One write() call, so the terminal
// never shows a half-drawn frame. A `clear`-then-repaint loop is what makes a 2s refresh FLASH — the
// blank moment between the erase and the paint is the flicker, and it carries no information.
// Plain output without TKR_LIVE keeps the signed-off frame byte-identical.
process.stdout.write(process.env.TKR_LIVE
  ? `\x1b[H${fit(out, W, ROWS).map((l) => `${l}\x1b[K`).join("\n")}\x1b[J`
  : `${out.join("\n")}\n`);
