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
4. **Run** — run `tickmarkr run`. Watch the run journal for its terminal events rather than polling agents, using the shipped watcher — `.claude/skills/tickmarkr-overseer/scripts/watch-journal.sh <state-dir>/runs 20 28800` — which takes a line baseline at arm time, then wakes ONCE on `run-end`, `task-human`, `task-failed` or `consult-verdict` and grades the run-end summary against every green clause for you. Re-arm after every wake. ⛔ Never `tail -F | grep -m1` (run-end is the journal's last line, so tail never notices the broken pipe and the watcher hangs forever) and never a pane-level done wait (it fires on every agent turn end, not mission end). ⚠ A bare whole-file `grep -q '"event":"run-end"'` is the trap the watcher exists to avoid: on a resume it matches the PREVIOUS run's run-end and returns instantly, so a re-armed watcher reads as coverage that does not exist. Resolve blocked interactions in the agent session; do not turn them into proxy questions.
5. **Verify and consolidate** — accept only a green run. A run is green when the run-end event exists in the journal, the tip verify is not "failed", and the summary's `failed`, `human`, `blocked` and `pending` buckets are all empty — a run with a parked task is partial, not green. Tickmarkr consolidates accepted task work on `tickmarkr/<runId>`; it never signs off to the main branch. A human may later merge that integration branch through the repository's normal release process.
6. **Record** — write `tickmarkr report <runId> --md` beside the source spec and commit the execution record when the repository tracks those records. Then [stand down](#stand-down-mission-end-and-retirement).
