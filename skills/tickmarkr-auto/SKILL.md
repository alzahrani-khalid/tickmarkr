---
name: tickmarkr-auto
description: 'Run a repository’s requested specs autonomously with tickmarkr. Triggers: "/tickmarkr-auto", "run these specs with tickmarkr", "autonomous tickmarkr run".'
argument-hint: "[spec-or-directory ...]"
metadata:
  installed-by: tickmarkr
---

# tickmarkr-auto — run repository specs autonomously

Use this to execute a requested sequence of repository specs. It is SDD-agnostic: each target can be any file or directory accepted by `tickmarkr compile`.

Use the canonical loop skill's [cockpit, parked decisions and printed twins](../tickmarkr-loop/SKILL.md#cockpit-parked-decisions-and-printed-twins)
for each target: delivered views are **1 Home, 4 Run, 5 Evidence**; Fleet/Bootstrap and
Plan/Health remain follow-ons with CLI entries. The recorded 1/3 merged, human T2, blocked
T3 case stays PARTIAL despite tip pass. Review the Run confirmation, read back the appended
`task-approved` receipt, and explicitly launch `tickmarkr resume <runId>` with the detached launch below when no live owner exists;
approval records permission and never dispatches work itself. A waive needs an `OOB: executed`
read at the task head (the walkthrough's record example); a static CLEAN never funds one. Non-TTY readers keep `status`,
`report` and default-watch line output, with `--watch --plain` as the TTY fallback.
Keep `name: tickmarkr-auto` and its sibling loop link intact.

`<skills-dir>` is the skills directory holding this skill.

## Two-tier by default — role check before the loop

`<label>` means the version only in the tickmarkr source repository (`package.json` named `tickmarkr`); elsewhere it means the mission or run, never the installed binary version.

When working in a multi-agent terminal environment (herdr or Orca), decide your role before starting:

- **Orchestrator:** your session was started to execute the mission. Rename your own tab/pane `ORCH · <label>` (short labels: ≤20 chars, `ROLE · token`) and run the loop below.
- **Supervisor with a live orchestrator:** do not start a second run. Relay the mission to the existing orchestrator with a [verified handoff](#verified-handoffs-agent-to-agent-messaging), then supervise it as OVERSEER.
- **Primary session without an orchestrator:** rename your own tab `OVERSEER · <label>` and your agent `overseer`, spawn one child orchestration session with your host's launch form, label its tab `ORCH · <label>` and name its agent, give it the mission and these rules verbatim, then supervise it. Do not drive a duplicate single-tier run yourself. Before spawning, retire any PREVIOUS orchestrator through [mission-end teardown](#mission-end-teardown-queue-row-240-d-2138-add1-r3-add4).
  - **On herdr (`HERDR_ENV=1`)**: **spawning on current herdr is two-step** — the one-shot `agent start --cwd/--tab/--no-focus` form was removed in the herdr CLI redesign and now fails with `unknown option` (OBS-138). First create the pane: `herdr tab create --workspace <ws> --cwd <repo> --label "ORCH · <label>"` (tab create does not steal focus unless `--focus` is passed; parse `result.root_pane.pane_id` from its JSON), then start the agent in it:
    - **Claude Code:** `herdr agent start orchestrator --kind claude --pane <root-pane-id> -- --permission-mode bypassPermissions`
    - **Codex:** `herdr agent start orchestrator --kind codex --pane <root-pane-id> -- --dangerously-bypass-approvals-and-sandbox` — the unsandboxed flag is REQUIRED, not optional: codex's `workspace-write` sandbox keeps `.git` refs read-only, so a sandboxed orchestrator's `tickmarkr run` dies at integration-branch creation (`git worktree add` cannot lock the ref). Do not downgrade this flag; the herdr pane and repo scope are the containment.
    - **Auxiliary seats run as the CLI's interactive TUI in their visible pane — never headless** (`claude -p` / `codex exec`): headless buffers output until exit so the pane renders idle for the entire run, is blind to SessionStart hook errors (a broken and a fixed hook both return green), and gives a stall watcher no midpoint — silent-time equals lifetime. Headless is for exit-code probes only (a quota check that wants `rc`), never for work anyone must watch.
  - **On Orca (`TERM_PROGRAM=Orca` and non-empty `ORCA_TERMINAL_HANDLE`)**: spawn it with `orca terminal create --worktree path:<repo> --title "ORCH · <label>" --command "<agent-cmd>" --json` and parse `result.terminal.handle` from the create receipt. **Auxiliary seats run as the CLI's interactive TUI in their visible terminal — never headless**, for the reasons the herdr branch gives.
  - **Auxiliary agents you spawn (consultants, reviewers, scouts) follow the same forms.** Never launch a claude session in plan mode or default permission mode for autonomous work — both stall on per-command approval prompts nobody is watching; claude is always `--permission-mode bypassPermissions` (tickmarkr's own adapter uses exactly this for workers, judges, and consults). A read-only codex consultant may use `--sandbox read-only`; any codex session that must touch git needs the unsandboxed flag above.

With neither herdr nor Orca there is no role to decide and no seat to spawn: follow [On a plain host (neither herdr nor Orca)](#on-a-plain-host-neither-herdr-nor-orca) and run the loop directly, single-tier.

In a multi-tier session, the tiers clear each other at 50% context or more, after writing a handoff. A new spec or run is a mission boundary: write the handoff and clear before taking the next mission. Copy this duty into every brief and handoff. On a single-tier plain host, write your handoff and ask the operator to clear the session.

## On a plain host (neither herdr nor Orca)

Neither `HERDR_ENV=1` nor the Orca markers are set: the Claude Desktop Code tab, a plain terminal, any
agent session that owns no panes (queue row 192; D-2102). The role check above does not apply.

- **This session runs SINGLE-TIER as the orchestrator.** There are no seats, no pane briefs, no tab
  canon and no board: run every step of [the per-spec loop](#per-spec-loop) yourself and skip every
  On herdr and On Orca scope.
- **An empty mission is asked for, never assumed.** With no target named, ask the operator what to run
  end-to-end before compiling anything; there is no other tier to relay it to.
- **Run and resume launch through the anchor-free lines** of the
  [detached launch](#host-owned-daemon-and-detached-beats): the same `node` detach with no address, one
  line for `tickmarkr run` and one for `tickmarkr resume <runId>`. The daemon places no board, so a
  missing board is never a fault; confirm the launch from the lock pid as that section says.
- **Run-end and parks are watched through the host's background wait**, never a foreground wait past
  the host's ten-minute tool cap: the cap kills that wait, ends the turn and leaves the run unwatched.
  Start the wait as a background task whose exit wakes this session, on journal lines after a baseline
  taken at arm time and on the lock holder's death:
  `n=$(wc -l < <journal>); until tail -n +$((n + 1)) <journal> | grep -qE '"event":"(run-end|task-human|task-failed|consult-verdict)"' || ! kill -0 <pid>; do sleep 20; done`
  (`<journal>` is `<state-dir>/runs/<runId>/journal.jsonl`, `<pid>` the lock pid). On every wake read
  CURRENT `tickmarkr status <runId>` first, then re-arm.
- **The operator's view is `tickmarkr status <runId>`**, plus its live `status --watch --plain` form,
  `tickmarkr status <runId> --watch --plain`, in a read-only Terminal tab beside this session.
- **Reviews and judges run headless.** The subprocess driver runs every worker, judge and review as a
  headless CLI call with no pane to watch: read their verdicts from the journal, the gate evidence and
  `tickmarkr status <runId>`, never from a screen.
- **Sessions hand off through the host's cross-session message tool**, confirmed by the peer's reply:
  there is no composer to read back, so a message no peer answered is not a handoff.
- **Keep a permission mode that never stalls per command** for the whole run (for example
  `bypassPermissions`): nobody answers a per-command approval prompt in an unattended session.

## Stand-down (mission end and retirement)

At each terminal state (green, failed, or parked), finish the execution record beside the source spec.
The ORCH's artifact is this execution record. Append its named terminal marker BEFORE the record commit
(queue row 240; D-2138 add.1 R3): `printf '\n<!-- tickmarkr:orch-end %s -->\n' "<runId>" >> "<execution-record>"`.
Verify the final line is `<!-- tickmarkr:orch-end <runId> -->`, then commit that record when tracked
and notify the operator. Stop every monitor and background task you started, sweep your watcher
heartbeat/beat files, print a final stand-down line, and leave nothing queued in your input box.
After that stand-down, write `pids/<seat>.stood-down` with `mission=<mission>` as the brief requires.
The supervisor reads back the stand-down and exactly that execution record's end marker, then closes
the retired ORCH at its recorded address using the host's exact command and ownership proof below;
a plain host has no spawned terminal to close. Ghost-text suggestions are UI, not queued input.

## Mission-end teardown (queue row 240; D-2138 add.1 R3, add.4)

**The spawner closes the seat it created.** Manual closes and watcher closes follow this same law:
close only once its artifact and terminal marker are on disk, its stand-down is read back, and no
next mission is named for it. An agent's `done` signal, a bare handle, or a title alone is never enough.
The ORCH's artifact is the execution record ending in `<!-- tickmarkr:orch-end <runId> -->`;
the supervisor reads exactly that record and that run's marker before retiring the orchestrator.
Keep a reused seat only with its next mission named and a `/clear` at the mission boundary.
Keep the latest settled consult round only while the mission continues; at mission end apply this
same close or reuse rule. A dedicated consultant tab may outlive the orchestrator tab during that
continuing mission, never indefinitely after the mission ends.

**Record ownership at spawn**, beside watcher pids under `<state-dir>/overseer/pids/<seat>.handle`:
write `host`, `address`, `title`, `checkout`, and `mission`, one `key=value` per line, from the create
receipt; use the actual tab title and checkout. This is the spawn ledger, not a list reconstructed
from titles. Record an owned tab as `tab=<tab-id>` when the seat owns it. Every spawned seat's brief
ends with: after stand-down, write `pids/<seat>.stood-down` containing `mission=<mission>`.
On every new assignment, including named-next-mission reuse, rewrite the ledger's `mission` and
delete the old stood-down file BEFORE that mission starts (D-2138 add.6 V01). Read back the stood-down
file and require its mission to equal the ledger's current mission; an earlier mission's stand-down
never retires the reused seat.

**Before every close, first match the spawn record against the live tab title and checkout**, at its
recorded address. A mismatch closes nothing. Never close a tab you did not create, a recycled handle
now showing an operator's terminal, a seat matched by title alone, or your own launching terminal.
A stale or mismatched Orca handle permits read-only re-resolution by title and checkout to read the
seat; never close the replacement by title, never rewrite ownership from a title-only match.

- **On herdr (`HERDR_ENV=1`)**: verify `herdr pane list`: the recorded address equals `pane_id`,
  the recorded title equals `label`, and the recorded checkout equals `cwd` (filesystem identity).
  Only then use `herdr pane close <pane>` at the recorded address. Prove the pane absent from
  `herdr pane list`; for a seat owning its tab, use `herdr tab close <tab>` at its recorded tab id
  after the final owned pane closes, and prove the tab absent from `herdr tab list`. A shared tab
  with a pending sibling stays open. Never assume emptied tabs disappear without checking.
- **On Orca (`TERM_PROGRAM=Orca` and non-empty `ORCA_TERMINAL_HANDLE`)**: verify ownership with
  `orca terminal list --include-visual-layouts --json`: the spawn record's address is the leaf handle,
  its title is the live TAB title (never the shell's pane title), and its checkout matches the layout
  worktree and terminal row. An unbound checkout or truncated listing is unverifiable and closes nothing.
  Only then use `orca terminal close --terminal <handle> --json` with the recorded handle. Require
  `result.close.handle` equal to that handle, or the documented live-terminal refusal
  `ok:false`, `error.code:runtime_error`, `error.message:tab_not_found` from that same runtime.
  Prove the handle absent from `orca terminal list --json` AND its owned tab absent from
  `orca terminal list --include-visual-layouts --json` after its final terminal closes, in the same
  runtime as the pre-close listing. A surviving owned tab is a spec question, never permission to
  close by title. The Orca smoke e2e asserts this tab leg; a receipt alone is no close proof.

## Invariants

- Never run two tickmarkr runs in the same repository concurrently.
- Never let tickmarkr merge work to the main branch. New work consolidates on `tickmarkr/<runId>`.
- Do not edit a generated graph to force an outcome; correct the source spec and compile again.
- Gates independently verify evidence, scope, acceptance criteria, and review. A worker's completion claim is not evidence.
- Treat missing or unparseable machine results and verdicts as failures. Never bypass a failed gate or merge partial work without a human decision.

## Act by default

Run every requested target in order without seeking routine confirmation. Stop only for a blocked agent interaction, a genuinely unresolved stalled task, a designed human gate, or a failed run that needs a human decision. Diagnose from the journal and evidence first; self-release and resume only after fixing and verifying a harness defect.

## Binary preflight (before compile or run)

Before starting, on every host including a plain one (herdr, Orca or neither), read and follow the PROJECT MEMORY duty under [the `tickmarkr-overseer` skill's Setup](../tickmarkr-overseer/SKILL.md#setup).

**Spec-authoring law ships in the spec template** that `tickmarkr init` writes: the hard bounds and which
  direction each moves, what makes a criterion real, and why an absence or a source-text grep is never a
  criterion. Read it before authoring or repairing acceptance items.

Before `tickmarkr compile` or `tickmarkr run`:

1. Run `tickmarkr version --check` and **stop immediately on a non-zero exit**.
2. In a consumer repository, it compares installed agent guidance with this binary's packaged block and skills, never the app's manifest version. Refresh drifted guidance with `tickmarkr init --agent --force`.
3. Only in the tickmarkr source repository (`package.json` named `tickmarkr`), the check compares its version with the binary. If the binary and repository do not **agree on the entire version** (including the patch; e.g. binary `2.1.0` vs repo `2.1.1`), **stop immediately** and tell the operator to update the global install (`npm i -g tickmarkr@latest`), or to install this repository's build as a REAL COPY — `npm pack`, then `npm i -g ./<tarball>`. Do not compile, plan, or run on hope.
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

Never report "briefed" or "relayed" without the confirmation your host gives:

- **On herdr (`HERDR_ENV=1`)**: when relaying missions between agents in a multi-agent terminal, **never use bare send-text** (`herdr agent send` / pane send-text) — it writes text without pressing Enter, so handoffs sit unsubmitted (OBS-39). Use one of:
  - `herdr pane run <pane> "<message>"` — text plus Enter in the target shell
  - `herdr notification show "<message>"` — OS-level delivery for the operator

  Confirm delivery by reading the TARGET composer afterward; if the sent text still sits unsubmitted after ~15 s, retry the Enter only when that composer read shows the staged text and no permission prompt or numbered choice holds focus — an Enter sent onto an active prompt approves it or picks a choice instead of submitting the message (OBS-1119). Under that guard, send-keys enter to that pane once and read again (OBS-975); when a prompt or choice holds focus instead, resolve it first and re-read before retrying. Never report "relayed" without read-back.
- **On Orca (`TERM_PROGRAM=Orca` and non-empty `ORCA_TERMINAL_HANDLE`)**: send with `orca terminal send --terminal <handle> --text "<message>" --enter --wait-submit 15 --json` and treat it as delivered only when `result.send.prompt.stages` carries a `turn_started` stage — `accepted: true` proves input acceptance, not a started turn.
- With neither host, hand off through the host's cross-session message tool, confirmed by the peer's reply ([On a plain host (neither herdr nor Orca)](#on-a-plain-host-neither-herdr-nor-orca)).

## Per-spec loop

1. **Prepare** — confirm the target list. Run the [binary preflight](#binary-preflight-before-compile-or-run). Check `git status`, confirm no tickmarkr run is active, and work from a non-main branch.
2. **Compile** — run `tickmarkr compile <spec-or-directory>`. Fix source-spec defects instead of editing the generated graph.
3. **Plan** — run `tickmarkr plan`. Review routes, capability-floor warnings, and human gates before execution.
   - `tickmarkr approve <runId> <taskId>` — release a human gate
4. **Run** — launch `tickmarkr run` using the [detached launch](#host-owned-daemon-and-detached-beats), and start detached beats with their run-end stop items. A watch ending the seat's turn is no watch: keep a **blocking journal consumer** alive for the run's terminal events, and never rely on a `Monitor`-only wake. Watch the run journal rather than polling agents: the consumer takes a line baseline at arm time, then wakes ONCE on `run-end`, `task-human`, `task-failed` or `consult-verdict`. A run-end record is history, never green; the debt clause is yours — read CURRENT `tickmarkr status <runId>` (step 5). Re-arm after every wake. ⛔ Never `tail -F | grep -m1` (run-end is the journal's last line, so tail never notices the broken pipe and the watcher hangs forever) and never a pane-level done wait (it fires on every agent turn end, not mission end). ⚠ A bare whole-file `grep -q '"event":"run-end"'` is the trap the watcher exists to avoid: on a resume it matches the PREVIOUS run's run-end and returns instantly, so a re-armed watcher reads as coverage that does not exist. Resolve blocked interactions in the relevant agent session. The consumer is host-specific; with neither host it is the background wait of [On a plain host (neither herdr nor Orca)](#on-a-plain-host-neither-herdr-nor-orca).
   - **On herdr (`HERDR_ENV=1`)**: the consumer is the shipped watcher — `<skills-dir>/tickmarkr-overseer/scripts/watch-journal.sh <state-dir>/runs 20 28800`, which grades the run-end summary's execution clauses for you, `EXECUTION COMPLETE` or `NOT GREEN`, never green — or a foreground `until grep` on the run's terminal events; ensure it is re-armed at most every twenty minutes.
   - **On Orca (`TERM_PROGRAM=Orca` and non-empty `ORCA_TERMINAL_HANDLE`)**: the consumer is that same shipped journal watcher or a foreground `until grep` on the run's terminal events; ensure it is re-armed at most every twenty minutes.
5. **Verify and consolidate** — continue only after a green run. A run is green only when ALL of these hold: the run-end event exists in the journal and is not fatal, tip verify is not "failed", the run-end summary's `failed`, `human`, `blocked` and `pending` buckets are every one of them empty, AND the owed checks in CURRENT `tickmarkr status <runId>` are outstanding empty AND known (`outstanding 0`; `outstanding unknown` is never empty). The shorter "run-end plus tip verify" form is NOT sufficient: a run ending `done=[T1,T3,T4] human=[T2] tipVerify=passed` is a closed PARTIAL run — three of four delivered, one parked — and calling it green is how a park becomes invisible. Empty execution buckets are not sufficient either (D-660): a run ending with every execution bucket empty and `tipVerify=passed` after an operator waived one review still owes that accepted-risk review check — status reads `outstanding 1 (T7 review)`, and `tickmarkr run` and `resume` exit 0 on execution alone — so it is execution complete, not green. Read the debt from CURRENT status, never from the run-end record: a `tickmarkr verify --record <runId>` discharge that lands after run-end moves current status to `outstanding 0` while the historical run-end row still carries 1, and only then is that run green; a legacy waiver without a recorded obligation reads `outstanding unknown` and is never green. A fatal run-end is never green either: the crash record (`fatal: true`) names its phase and error, every task it left running or gated sits in `pending` or `blocked`, and even with every bucket empty status and report lead with the crash and read `outstanding unknown` until the run is resumed; from then on the resumed engagement owns the debt. Never report green to the operator, tab titles, or records until every clause holds; when one does not, name the bucket that is not empty, the outstanding checks, or the unknown debt. Tickmarkr consolidates accepted work on `tickmarkr/<runId>` and never signs off to the main branch. A human controls any later release merge.
   - `tickmarkr verify --base <ref>` — run the gate battery standalone against merge-base(base, HEAD)..HEAD: no daemon, no retries, one fail-closed verdict (`--criteria <file>` or `--task <id>` adds the semantic gates; `--no-review` for deterministic-only)
6. **Record** — `tickmarkr report <runId> --md` prints Markdown to stdout; redirect explicitly beside the spec (for example `tickmarkr report <runId> --md > feature.record.md`) then follow [stand-down](#stand-down-mission-end-and-retirement) to append the ORCH end marker before committing the execution record when tracked.
7. **Continue** — move to the next requested target. If a target fails or is parked, stop with the journal evidence rather than silently skipping it.

## Host-owned daemon and detached beats

Launch the daemon DETACHED, with no pane of its own: one `tickmarkr run` or `tickmarkr resume <runId>`
process in its own session, its stdout and stderr appended to `<state-dir>/daemon.log`, and on
herdr or Orca the ORCH's recorded address as its board anchor, so the daemon self-places its one
board beside the ORCH in the ORCH tab; with neither host it carries no address and places no board.
Never launch it in a visible split, pane or tab, as an agent harness background task, or tied to
an agent session: the launching shell may end, and the daemon keeps running and logging. The
detach wrapper is `node`, which tickmarkr already requires — no private script, no extra visible
daemon pane and no CLI log flag:

```bash
# On Orca: <ORCH handle> is the ORCH terminal handle
cd <repo> && ORCA_TERMINAL_HANDLE="<ORCH handle>" node -e "require('child_process').spawn(process.argv[1], process.argv.slice(2), { detached: true, stdio: 'inherit' }).unref()" tickmarkr run >> <state-dir>/daemon.log 2>&1 < /dev/null
cd <repo> && ORCA_TERMINAL_HANDLE="<ORCH handle>" node -e "require('child_process').spawn(process.argv[1], process.argv.slice(2), { detached: true, stdio: 'inherit' }).unref()" tickmarkr resume <runId> >> <state-dir>/daemon.log 2>&1 < /dev/null
# On herdr: <ORCH pane id> is the ORCH pane id
cd <repo> && HERDR_PANE_ID="<ORCH pane id>" node -e "require('child_process').spawn(process.argv[1], process.argv.slice(2), { detached: true, stdio: 'inherit' }).unref()" tickmarkr run >> <state-dir>/daemon.log 2>&1 < /dev/null
cd <repo> && HERDR_PANE_ID="<ORCH pane id>" node -e "require('child_process').spawn(process.argv[1], process.argv.slice(2), { detached: true, stdio: 'inherit' }).unref()" tickmarkr resume <runId> >> <state-dir>/daemon.log 2>&1 < /dev/null
# On a plain host (neither herdr nor Orca): the same detach with no address
cd <repo> && node -e "require('child_process').spawn(process.argv[1], process.argv.slice(2), { detached: true, stdio: 'inherit' }).unref()" tickmarkr run >> <state-dir>/daemon.log 2>&1 < /dev/null
cd <repo> && node -e "require('child_process').spawn(process.argv[1], process.argv.slice(2), { detached: true, stdio: 'inherit' }).unref()" tickmarkr resume <runId> >> <state-dir>/daemon.log 2>&1 < /dev/null
```

- **On Orca (`TERM_PROGRAM=Orca` and non-empty `ORCA_TERMINAL_HANDLE`)**: run the
  `ORCA_TERMINAL_HANDLE` lines; `<ORCH handle>` is the ORCH's own `$ORCA_TERMINAL_HANDLE`.
- **On herdr (`HERDR_ENV=1`)**: run the `HERDR_PANE_ID` lines; `<ORCH pane id>` is the ORCH's own
  `$HERDR_PANE_ID`.
- With neither host, run the two lines that carry no address
  ([On a plain host (neither herdr nor Orca)](#on-a-plain-host-neither-herdr-nor-orca)).

After any launch, read this repository's lock pid from `<state-dir>/graph.lock` and confirm it:
`kill -0 <pid>` succeeds, `ps -o pgid= -p <pid>` prints that same pid (its own session group;
ppid 1 is never proof on its own), walk its ppid chain and verify no agent session is an ancestor,
and read `<state-dir>/daemon.log`. No live holder means the launch failed: read the log, fix the
cause and run the same line again — never a second daemon beside a live holder, and never a
visible split to watch it.

- **On herdr (`HERDR_ENV=1`)**: the daemon-placed board is the live surface.
- **On Orca (`TERM_PROGRAM=Orca` and non-empty `ORCA_TERMINAL_HANDLE`)**: the daemon-placed board is the live surface.

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
