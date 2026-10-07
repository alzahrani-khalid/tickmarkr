---
name: tickmarkr-loop
description: 'Run one repository spec autonomously with tickmarkr. Triggers: "/tickmarkr-loop", "run this spec with tickmarkr", "tickmarkr the spec".'
---

# tickmarkr-loop — run one spec autonomously

Use this for any spec that `tickmarkr compile` accepts. It is SDD-agnostic: use the repository's requested spec format and keep the execution record beside that source spec.

## Two-tier by default — role check before the loop

When working in a multi-agent terminal environment, decide your role before starting:

- **Orchestrator:** your session was started to execute the mission. Rename your own tab/pane `ORCH · <version>` (short labels: ≤20 chars, `ROLE · token`) and run the loop below.
- **Supervisor with a live orchestrator:** do not start a second run. Relay the mission to the existing orchestrator with a [verified handoff](#verified-handoffs-agent-to-agent-messaging), then supervise it as OVERSEER.
- **Primary session without an orchestrator:** rename your own tab `OVERSEER · <version>` and your agent `overseer`, spawn one child orchestration session with your host's launch form, label its tab `ORCH · <version>` and name its agent, give it the mission and these rules verbatim, then supervise it. Do not drive a duplicate single-tier run yourself. Before spawning, confirm any PREVIOUS orchestrator has [stood down](#stand-down-mission-end-and-retirement) and close its tab.
  - **Spawning on current herdr is two-step** — the one-shot `agent start --cwd/--tab/--no-focus` form was removed in the herdr CLI redesign and now fails with `unknown option` (OBS-138). First create the pane: `herdr tab create --workspace <ws> --cwd <repo> --label "ORCH · <version>"` (tab create does not steal focus unless `--focus` is passed; parse `result.root_pane.pane_id` from its JSON), then start the agent in it:
  - **Claude Code:** `herdr agent start orchestrator --kind claude --pane <root-pane-id> -- --permission-mode bypassPermissions`
  - **Codex:** `herdr agent start orchestrator --kind codex --pane <root-pane-id> -- --dangerously-bypass-approvals-and-sandbox` — the unsandboxed flag is REQUIRED, not optional: codex's `workspace-write` sandbox keeps `.git` refs read-only, so a sandboxed orchestrator's `tickmarkr run` dies at integration-branch creation (`git worktree add` cannot lock the ref). Do not downgrade this flag; the herdr pane and repo scope are the containment.
  - **Auxiliary agents you spawn (consultants, reviewers, scouts) follow the same forms.** Never launch a claude session in plan mode or default permission mode for autonomous work — both stall on per-command approval prompts nobody is watching; claude is always `--permission-mode bypassPermissions` (tickmarkr's own adapter uses exactly this for workers, judges, and consults). A read-only codex consultant may use `--sandbox read-only`; any codex session that must touch git needs the unsandboxed flag above.
  - **Auxiliary seats run as the CLI's interactive TUI in their visible pane — never headless** (`claude -p` / `codex exec`): headless buffers output until exit so the pane renders idle for the entire run, is blind to SessionStart hook errors (a broken and a fixed hook both return green), and gives a stall watcher no midpoint — silent-time equals lifetime. Headless is for exit-code probes only (a quota check that wants `rc`), never for work anyone must watch.

Outside a multi-agent terminal environment, run the loop directly.

## Invariants

- Never run two tickmarkr runs in the same repository concurrently.
- Never let tickmarkr merge work to the main branch. New work consolidates on `tickmarkr/<runId>`.
- Do not edit the compiled graph to force an outcome; fix the source spec and compile again.
- Gates verify commits, diffs, acceptance criteria, and reviews independently. Never trust a worker's claim that work is complete.
- Treat missing or unparseable machine results and verdicts as failures. Do not release, resume, or merge around failed gates.
- A task changing what the daemon DOES must own every surface that TELLS the operator what the daemon does.

## Act by default

Proceed through the loop without seeking routine confirmation. Stop only for a blocked agent interaction, a genuinely unresolved stalled task, or a designed human gate. Diagnose from the journal and available evidence before escalating; if a harness defect is fixed and verified, resume the run.

## Binary preflight (before compile or run)

Before `tickmarkr compile` or `tickmarkr run`, compare the installed binary against the repository's `package.json` version:

1. Run `tickmarkr version` (one line, machine-parseable).
2. Read the `version` field from the repository's `package.json`.
3. If the binary and repository do not **agree on the entire version** (including the patch; e.g. binary `2.1.0` vs repo `2.1.1`), **stop immediately** and tell the operator to update the global install (`npm i -g tickmarkr@latest`), or to install this repository's build as a REAL COPY — `npm pack`, then `npm i -g ./<tarball>`. Do not compile, plan, or run on hope.
   > ⚠ **Never `npm i -g .` on the repository directory, and never link it.** npm SYMLINKS a directory install, which makes the working tree itself the machine-wide binary: every later build — including a gate's own `npm run build` — silently hot-swaps the CLI for every repository on the machine, with no version change to notice it by. Measured 2026-08-29: a verify build gate rewrote the shared binary while another repository's daemon was mid-run against it, and a positive control that rebuilds at a pre-fix ref would have installed the very defect it was proving fixed, machine-wide (OBS-771). Verify an install by comparing the global and repo **inodes** — they must DIFFER — never by `tickmarkr version`, which cannot go red when nothing is bumped.

A stale binary silently skips daemon gates shipped in newer releases — the v1.38 run exposed this when a global `1.36.0` binary missed the daemon tip-verify gate entirely (OBS-38). Preflight failure is always stop-and-report; never proceed-and-hope.

### No run may be live in THIS repository

The version check above is only half the preflight. Before `compile` or `run`, confirm no run is already
live **in this repository**:

1. Lead with this repository's own `.tickmarkr/graph.lock`. Read its recorded holder pid.
2. Treat the lock as held by a LIVE run until `kill -0 <pid>` proves that holder dead.
3. **Never require a machine-wide process pattern to be empty.** A lawful run in another repository — or
   the probing shell's own argv — matches such a pattern, so an empty result is not evidence of safety
   and a non-empty one is not evidence of danger.
4. If you use a process probe as secondary evidence, exclude the probing process itself, resolve every
   candidate's own working directory (for example `lsof -a -p <pid> -d cwd`), and count only candidates
   whose cwd is **this repository root**.

The invariant this protects is per-repository — *never run two tickmarkr runs in the same repository
concurrently* — so a machine-wide check answers a question nobody asked and blocks work that is lawful.

## Verified handoffs (agent-to-agent messaging)

When relaying missions between agents in a multi-agent terminal, **never use bare send-text** (`herdr agent send` / pane send-text) — it writes text without pressing Enter, so handoffs sit unsubmitted (OBS-39).

Use one of:

- `herdr pane run <pane> "<message>"` — text plus Enter in the target shell
- `herdr notification show "<message>"` — OS-level delivery for the operator

After sending, **confirm delivery** by reading the target pane and verifying the message landed (input empty, agent status `working`, or notification acknowledged). Never report "briefed" or "relayed" without read-back confirmation.

## Dedicated consultant tab rule

When spawning consultants (agents gathering synthesis input for decisions like SCOPER analysis or architectural reviews), create them in a DEDICATED tab separate from the ORCHESTRATOR tab. This ensures that when the orchestrator stands down, the consultant panes persist and their assessments remain available for review and reference.

## Stand-down (mission end and retirement)

- **Orchestrator, on terminal state** (green, failed, or parked), after the record commit and operator notification: stop every monitor and background task you started, sweep the heartbeat/beat files your watchers wrote (a stale beat beside a live one reads as coverage to whoever globs the directory), print one final stand-down line, and leave NOTHING queued in your input box. A finished session with an armed watcher or pre-filled input is a loaded gun — a retired v1.40 orchestrator sat idle with "merge … tag, publish" unsent in its input; one stray Enter would have shipped a duplicate release.
- **Supervisor, when a mission completes** (and always before spawning the next orchestrator): verify the orchestrator stood down, then close its tab. Seeming input-box text in a retired pane can be the TUI's dim ghost-text suggestion, not queued input — confirm with an ANSI read (dim escape around the text) or type-one-char-and-read-back before treating it as the loaded gun; close the tab either way. The journal, execution record, OBS ledger, and memory hold the story; pane scrollback is disposable. Never leave a retired agent idle with watchers armed.

## The loop

1. **Prepare** — start from the requested spec. Run the [binary preflight](#binary-preflight-before-compile-or-run). Check `git status`, confirm no tickmarkr run is active, and work from a non-main branch.
2. **Compile** — run `tickmarkr compile <spec>`. Correct compilation errors in the spec, never in the generated graph.
3. **Plan** — run `tickmarkr plan`. Review the routing table, capability-floor warnings, and every human gate, including work that each gate blocks.
4. **Run** — launch `tickmarkr run` using the [detached launch](#host-owned-daemon-and-detached-beats), and start detached beats with their run-end stop items. A watch ending the seat's turn is no watch: keep a **blocking journal consumer** alive for the run's terminal events — the shipped watcher below, or a foreground `until grep` on the run's terminal events — and ensure it is re-armed at most every twenty minutes. Never rely on a `Monitor`-only wake. Watch the run journal rather than polling agents, using the shipped watcher — `.claude/skills/tickmarkr-overseer/scripts/watch-journal.sh <state-dir>/runs 20 28800` — which takes a line baseline at arm time, then wakes ONCE on `run-end`, `task-human`, `task-failed` or `consult-verdict` and grades the run-end summary's execution clauses for you — `EXECUTION COMPLETE` or `NOT GREEN`, never green, because a run-end record is history; the debt clause is yours — read CURRENT `tickmarkr status <runId>` (step 5). Re-arm after every wake. ⛔ Never `tail -F | grep -m1` (run-end is the journal's last line, so tail never notices the broken pipe and the watcher hangs forever) and never a pane-level done wait (it fires on every agent turn end, not mission end). ⚠ A bare whole-file `grep -q '"event":"run-end"'` is the trap the watcher exists to avoid: on a resume it matches the PREVIOUS run's run-end and returns instantly, so a re-armed watcher reads as coverage that does not exist. Resolve blocked interactions in the agent session; do not turn them into proxy questions.
5. **Verify and consolidate** — accept only a green run. A run is green when the run-end event exists in the journal, the tip verify is not "failed", the summary's `failed`, `human`, `blocked` and `pending` buckets are all empty, and CURRENT `tickmarkr status <runId>` reads its owed checks outstanding empty AND known (`outstanding 0`) — a run with a parked task is partial, not green. Empty execution buckets alone are not green either (D-660): every bucket empty and the tip passed, but an operator waived one review, leaves one accepted-risk review check owed — status reads `outstanding 1 (T7 review)` and `run`/`resume` still exit 0 on execution alone, so the run is execution complete, not green. It turns green only when a `tickmarkr verify --record <runId>` discharge moves CURRENT status to `outstanding 0`, including a discharge landing after run-end — the historical run-end record keeps the old count, so never read debt from it; `outstanding unknown` is never green. Tickmarkr consolidates accepted task work on `tickmarkr/<runId>`; it never signs off to the main branch. A human may later merge that integration branch through the repository's normal release process.
6. **Record** — `tickmarkr report <runId> --md` prints Markdown to stdout. Redirect it explicitly beside the source spec (for example `tickmarkr report <runId> --md > feature.record.md`) and commit the execution record when the repository tracks those records. Then [stand down](#stand-down-mission-end-and-retirement).

## Host-owned daemon and detached beats

Launch the daemon DETACHED, with no pane of its own: one `tickmarkr run` or `tickmarkr resume <runId>`
process in its own session, its stdout and stderr appended to `<state-dir>/daemon.log`, and the
ORCH's recorded address as its board anchor, so the daemon self-places its one board beside the
ORCH in the ORCH tab. Never launch it in a visible split, pane or tab, as an agent harness
background task, or tied to an agent session: the launching shell may end, and the daemon keeps
running and logging. The detach wrapper is `node`, which tickmarkr already requires — no private
script, no extra visible daemon pane and no CLI log flag:

```bash
# On Orca: <ORCH handle> is the ORCH terminal handle
cd <repo> && ORCA_TERMINAL_HANDLE="<ORCH handle>" node -e "require('child_process').spawn(process.argv[1], process.argv.slice(2), { detached: true, stdio: 'inherit' }).unref()" tickmarkr run >> <state-dir>/daemon.log 2>&1 < /dev/null
cd <repo> && ORCA_TERMINAL_HANDLE="<ORCH handle>" node -e "require('child_process').spawn(process.argv[1], process.argv.slice(2), { detached: true, stdio: 'inherit' }).unref()" tickmarkr resume <runId> >> <state-dir>/daemon.log 2>&1 < /dev/null
# On herdr: <ORCH pane id> is the ORCH pane id
cd <repo> && HERDR_PANE_ID="<ORCH pane id>" node -e "require('child_process').spawn(process.argv[1], process.argv.slice(2), { detached: true, stdio: 'inherit' }).unref()" tickmarkr run >> <state-dir>/daemon.log 2>&1 < /dev/null
cd <repo> && HERDR_PANE_ID="<ORCH pane id>" node -e "require('child_process').spawn(process.argv[1], process.argv.slice(2), { detached: true, stdio: 'inherit' }).unref()" tickmarkr resume <runId> >> <state-dir>/daemon.log 2>&1 < /dev/null
```

- **On Orca (`TERM_PROGRAM=Orca` and non-empty `ORCA_TERMINAL_HANDLE`)**: run the
  `ORCA_TERMINAL_HANDLE` lines; `<ORCH handle>` is the ORCH's own `$ORCA_TERMINAL_HANDLE`.
- **On herdr (`HERDR_ENV=1`)**: run the `HERDR_PANE_ID` lines; `<ORCH pane id>` is the ORCH's own
  `$HERDR_PANE_ID`.

After either launch, read this repository's lock pid from `<state-dir>/graph.lock` and confirm it:
`kill -0 <pid>` succeeds, `ps -o pgid= -p <pid>` prints that same pid (its own session group;
ppid 1 is never proof on its own), walk its ppid chain and verify no agent session is an ancestor,
and read `<state-dir>/daemon.log`. No live holder means the launch failed: read the log, fix the
cause and run the same line again — never a second daemon beside a live holder, and never a
visible split to watch it; the daemon-placed board is the live surface.

Detached beats are product-owned, one per (tier, seat), from the repository root, through the
shipped lifecycle verbs — never a hand-rolled setsid plus nohup wrapper, pidfile or shell loop:

```bash
cd <repo> && tickmarkr beat start <tier> --seat <seat>
cd <repo> && tickmarkr beat status <tier> --seat <seat>
cd <repo> && tickmarkr beat stop <tier> --seat <seat>
```

`start` launches the `--loop` child in its own session, logs to `<state-dir>/supervision/<tier>.log`,
records its pid, birth, argv and cwd, and exits 0 only after it reads back that exact child's own
advancing beat. A repeat start for the same (tier, seat) is an "already running" no-op; a stale,
dead, foreign, reused-pid, unreadable or busy tier is a nonzero refusal that changes nothing.
Verify ppid 1 is never proof on its own — an orphan of a dying session shows it too; `status`
is the check: it reads the recorded process identity and beat freshness, writes nothing, and exits
nonzero for STALE, MISMATCH or UNREADABLE. `stop` signals only that recorded pid after its
generation and identity still match, and reads back DISARMED. Never put beats in a harness
background task or a visible tab. Include a run-end `beat stop` item for every beat started, also
on failure, park or handoff, and require its DISARMED read-back.

**Legacy beat migration.** `beat start` refuses a legacy (pre-lifecycle, unowned) arm nonzero and
prints its exit under the RECORDED seat; `beat stop` refuses it too, so a stop followed by a start
is a dead end, never a migration. When the refusal names `stop pid <N> first`, that pid is the old
`--loop` writer: stop exactly that pid yourself (`kill <N>`, then confirm `kill -0 <N>` fails) —
tickmarkr never signals a process it did not launch. Then run the printed step under the seat it
names, start again and read back ARMED:

```bash
cd <repo> && tickmarkr beat <tier> --seat <recorded seat> --stand-down
cd <repo> && tickmarkr beat start <tier> --seat <seat>
cd <repo> && tickmarkr beat status <tier> --seat <seat>
```

**Crash recovery.** A crashed owner, a writer killed inside its claimed tick or a killed recovery
taker leaves its claim, removal lock or stage directory behind. `beat status` only observes: it
exits nonzero, names the dead pids, prints the command that recovers them and changes no file —
status never recovers. Run the command it prints; the next ordinary `stop` or `start` recovers what
was left, with a notice naming each dead pid, and the start reads back ARMED:

```bash
cd <repo> && tickmarkr beat status <tier> --seat <seat>
cd <repo> && tickmarkr beat stop <tier> --seat <seat>
cd <repo> && tickmarkr beat start <tier> --seat <seat>
```

Never delete a claim, lock or stage file by hand. A live or unprovable holder refuses BUSY naming
it: wait for that holder to finish or exit, then run the same command.

Keep only watchers that must WAKE the seat in the harness. Re-arm them on each wake and at
their harness cap; daemon and beat lifetimes must not depend on that cap.

## Cockpit, parked decisions and printed twins

The shipped cockpit is **1 Home, 4 Run, 5 Evidence**: `tickmarkr ui [runId]` defaults to
Home on the latest journal, or empty Home with no run. `tickmarkr ui <runId> --view run`
and `--view evidence` select delivered views; `tickmarkr ui --setup <runId>` opens Run
Parks for that run. Fleet/Bootstrap and Plan/Health are follow-ons; keys 2/3/6 are not
installed. Continue using `fleet`, `init`, `plan` and `doctor` as CLI workflows.

Walk the recorded partial-human-park case before declaring green: **1/3 merged**, human
T2, blocked T3, tip passed is **PARTIAL**. T2 is a `humanGate: true` park before dispatch.
In Run select T2, press `a` Actions, choose Approve with Enter, then read the confirmation's
run/task, original park `#L`, actor/reason, exact argv, consequence and enactor. Only `y`
confirms; `n`/Esc cancel; Enter never confirms. Read the receipt's appended `task-approved`
line and actor/reason back from the journal. Approval records permission, never dispatch,
a passed gate or task completion. With no live owner it says **approved; resume required**:
exit the observer and launch `tickmarkr resume <runId>` explicitly with the same detached launch above. A matching live daemon
enacts at its next task boundary; if a different live run owns the repository lock, wait
for that run to end before resuming this one.

For a non-TTY decision, the same command is
`tickmarkr approve <runId> T2 --park <line>@<ts> --by operator --reason 'ready to proceed'`,
naming the park token `tickmarkr status <runId>` prints; check its receipt and explicitly
resume. Every decision binds to one park (a waive also to its failed gate:
`tickmarkr approve <runId> T2 --waive --park <line>@<ts> --gate review`); once a newer park
opens, a stale token, unbound release or mismatched gate refuses — the daemon journals
`approval-refused` and never waives the newer gate. A failed task keeps its recheck with its
own bound failure token: status prints `failed — T3 — failure <line>@<ts>`, then
`tickmarkr approve <runId> T3 --recheck --park <line>@<ts>` re-gates its landed commits. Preserve resume refusals and repair the named source/config issue
(including deny/prefer conflicts); never edit the compiled graph to force a result. Resume
makes CURRENT TIP PENDING; historical GATES RAN does not prove completion. The completed
case has 3/3 recorded merges, a latest run-end, a nonfailed known tip result, empty
`failed`, `human`, `blocked`, `pending` buckets, and CURRENT status reading `outstanding 0`
— owed checks outstanding empty AND known. Replay D-660 before calling it green: the same
3/3 with every bucket empty, after T2's review was waived, reads `outstanding 1 (T2 review)`;
`resume` exits 0 and its final line says `execution complete; outstanding 1 (T2 review)`, not
`verified`. It is green only once `tickmarkr verify --record <runId>` discharges that check and
CURRENT status reads `outstanding 0` — even after run-end, whose record still carries 1.
`outstanding unknown` (a legacy waiver) is never green. A mismatched graph is “not comparable.”

Run offers only validated park verbs: human/attempt-cap/other non-gate parks allow approve;
infra allows approve or `--recheck`; review gate-fail allows `--waive`, `--uphold` or
`--recheck`; other gate-fail allows waive/recheck. Waive satisfies only the identified
failed gate, uphold funds a fixed attempt carrying review findings, and recheck reruns the
declared battery without satisfying a gate. A waive needs EXECUTED evidence: mark every
out-of-band (OOB) read behind it `OOB: static` (diff and source read, nothing run) or
`OOB: executed` (the finding's claim run at the task's head commit, exit code and log on file).
Static CLEAN never backs a waive — a static read that missed an executed material defect looks
like one that found none, and a static read relabelled executed is a false record. When the
finding's reproduction, executed at the task head, fails, the ruling is uphold or recheck; waive
only when it passes and the record names it, keeping the park/gate binding and the owed check
(`outstanding 1 (T2 review)` until `tickmarkr verify --record <runId>`):
`D-NNN WAIVE T2 review — park <line>@<ts> --gate review — OOB: executed — <reproduction> at <task-head-sha>: exit 0, log <path>`. A stall park that recorded a `reapFailure`
(unreadable or surviving worker census) allows approve or `--recheck --park <line>@<ts>`:
recheck re-verifies that attempt's owned census and gates its harvested commits with no
worker only with an explicitly recorded empty survivors array (`[]`) — a missing,
unreadable or surviving census
re-parks the stall under a new token — while plain approve dispatches a worker. An
ordinary stall park (no `reapFailure`) stays approve-only; `--recheck` refuses it. Attempt-cap approval resets the budget while
retaining routing exclusions. Tombstones and failures without identified gate evidence
are diagnostic-only. Decisions cannot be undone; stale or duplicate decisions refuse.

Use `tickmarkr status <runId>` and `tickmarkr status <runId> --oneline` for preserved
snapshots. `tickmarkr status <runId> --watch` opens Run on a TTY and uses line output on
non-TTY; `--watch --plain` keeps the line/ANSI fallback even on a TTY. `--watch --events`
replays and follows projected decision JSON documents on stdout; `--jsonl` and
`--decision-events` are aliases. Keep stderr keepalives separate, never `2>&1`; raw
`journal.jsonl` remains distinct. Webhooks require explicit opt-in. `report` retains text,
learning preview and comparison warnings; `report --md` stays stdout, `--compare
<baseline-runId>` compares records, `--bundle <path>` writes a proof bundle, and `stats`
reports all runs without a run ID. Keep `fleet --print` and `fleet --why` separate.
Absent usage/cost evidence remains “not measurable.”

Manual UI keeps a receipt at run-end and observes a later resume of that same run. The
daemon-owned board by default gracefully stops its own watch presence before closing its owned pane;
unconfirmed cleanup is reported; `visibility.keepPanes: forever` preserves panes. It preserves Herdr grouping, short titles and placement
beside the caller without taking focus. `q`, Ctrl-C and SIGTERM restore raw/pointer/title/
alternate-screen state and release only this observer's presence. `?` opens shortcuts,
Tab/Shift-Tab traverse visible focus, and Esc closes the deepest overlay. Text input keeps
`q1?` literal. Evidence retains original `#L` pointers and full verdict paging with stable
selection while Follow is off; Run's `o` focuses only a verified owned pane, otherwise
showing its evidence diagnostic. Missing historical reviewer-floor metadata stays unknown.

For inert guidance use `tickmarkr ui --help`, `tickmarkr eval --help`,
`tickmarkr unlock --help` and `tickmarkr profile reset --help`. Before `--`, help returns
without UI/probes/writes; after `--`, arguments are literal data. Displayed examples do
not execute. Recovery uses `unlock <runId>` for a matching dead lock or `unlock --garbage`
for malformed bytes, with confirmation (`--yes` for non-TTY) and identity recheck; live,
inaccessible or changed holders refuse. `doctor --cached`, `--probe-preflight`,
`--fix-only` and `--refresh-catalog` distinguish cached reads, budget disclosure, local
repair and catalog refresh; default doctor and `--fix` still probe. `scope <intent-file>
--preview` performs no probes, model calls or writes; authoring requires confirmation or
`--yes`. These actions remain CLI entries until their follow-on views ship.

**macOS host failure: a launchservicesd restart (D-787/D-789).** If GUI apps suddenly read "The
application … is not open anymore" during a local suite, launchservicesd crashed and respawned with an
empty app registry. That was measured on 2026-09-30: `0x1000600b` Mach port exhaustion under node
`process.title` check-ins, crash at 17:15:00Z and respawn at 17:15:09Z. `tickmarkr doctor` and standalone
`tickmarkr verify` record the daemon's pid/start through the separate `src/run/launchservices-check.ts`
module: one bounded `/bin/ps` read with a 5000 ms kill ceiling. doctor's wiring is five lines in
`src/cli/commands/doctor.ts`. The identity lives on the first `doctor.json` record, and one advisory
prints and persists when it changed. Unknown evidence keeps the prior identity, and verdicts and retries
never change. Confirm the identity with `/bin/ps -o pid=,lstart= -p "$(pgrep -x launchservicesd)"`: it
is young beside Dock and Finder. Confirm the log with `/usr/bin/log show --start '<that lstart minus two
minutes>'`, looking for `0x1000600b` then `Successfully spawned launchservicesd`. Type the full path: a bare
`log` is a zsh builtin that prints nothing. Then quit and relaunch the affected apps, or log out /
restart once the run is stood down; a restart ends agent sessions and wipes `/private/tmp`.

Keep this skill's canonical identity `tickmarkr-loop`; sibling skills link to this
walkthrough. In this repository `skills/` is canonical and installed `.claude/skills/`
files resolve to it; change the canonical source, never create a second help skill.
