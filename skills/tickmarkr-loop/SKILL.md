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
  - **Claude Code:** `herdr agent start orchestrator --cwd <repo> --no-focus -- claude --permission-mode bypassPermissions`
  - **Codex:** `herdr agent start orchestrator --cwd <repo> --no-focus -- codex --ask-for-approval never --sandbox workspace-write`

Outside a multi-agent terminal environment, run the loop directly.

## Invariants

- Never run two tickmarkr runs in the same repository concurrently.
- Never let tickmarkr merge work to the main branch. New work consolidates on `tickmarkr/<runId>`.
- Do not edit the compiled graph to force an outcome; fix the source spec and compile again.
- Gates verify commits, diffs, acceptance criteria, and reviews independently. Never trust a worker's claim that work is complete.
- Treat missing or unparseable machine results and verdicts as failures. Do not release, resume, or merge around failed gates.

## Act by default

Proceed through the loop without seeking routine confirmation. Stop only for a blocked agent interaction, a genuinely unresolved stalled task, or a designed human gate. Diagnose from the journal and available evidence before escalating; if a harness defect is fixed and verified, resume the run.

## Binary preflight (before compile or run)

Before `tickmarkr compile` or `tickmarkr run`, compare the installed binary against the repository's `package.json` version:

1. Run `tickmarkr version` (one line, machine-parseable).
2. Read the `version` field from the repository's `package.json`.
3. If the binary is **older on major.minor** than the repo (e.g. binary `1.36.x` vs repo `1.38.x`), **stop immediately** and tell the operator to update the global install (`npm i -g tickmarkr@latest`) or link the repo binary. Do not compile, plan, or run on hope.

A stale binary silently skips daemon gates shipped in newer releases — the v1.38 run exposed this when a global `1.36.0` binary missed the daemon tip-verify gate entirely (OBS-38). Preflight failure is always stop-and-report; never proceed-and-hope.

## Verified handoffs (agent-to-agent messaging)

When relaying missions between agents in a multi-agent terminal, **never use bare send-text** (`herdr agent send` / pane send-text) — it writes text without pressing Enter, so handoffs sit unsubmitted (OBS-39).

Use one of:

- `herdr pane run <pane> "<message>"` — text plus Enter in the target shell
- `herdr notification show "<message>"` — OS-level delivery for the operator

After sending, **confirm delivery** by reading the target pane and verifying the message landed (input empty, agent status `working`, or notification acknowledged). Never report "briefed" or "relayed" without read-back confirmation.

## Dedicated consultant tab rule

When spawning consultants (agents gathering synthesis input for decisions like SCOPER analysis or architectural reviews), create them in a DEDICATED tab separate from the ORCHESTRATOR tab. This ensures that when the orchestrator stands down, the consultant panes persist and their assessments remain available for review and reference.

## Stand-down (mission end and retirement)

- **Orchestrator, on terminal state** (green, failed, or parked), after the record commit and operator notification: stop every monitor and background task you started, print one final stand-down line, and leave NOTHING queued in your input box. A finished session with an armed watcher or pre-filled input is a loaded gun — a retired v1.40 orchestrator sat idle with "merge … tag, publish" unsent in its input; one stray Enter would have shipped a duplicate release.
- **Supervisor, when a mission completes** (and always before spawning the next orchestrator): verify the orchestrator stood down, then close its tab. Seeming input-box text in a retired pane can be the TUI's dim ghost-text suggestion, not queued input — confirm with an ANSI read (dim escape around the text) or type-one-char-and-read-back before treating it as the loaded gun; close the tab either way. The journal, execution record, OBS ledger, and memory hold the story; pane scrollback is disposable. Never leave a retired agent idle with watchers armed.

## The loop

1. **Prepare** — start from the requested spec. Run the [binary preflight](#binary-preflight-before-compile-or-run). Check `git status`, confirm no tickmarkr run is active, and work from a non-main branch.
2. **Compile** — run `tickmarkr compile <spec>`. Correct compilation errors in the spec, never in the generated graph.
3. **Plan** — run `tickmarkr plan`. Review the routing table, capability-floor warnings, and every human gate, including work that each gate blocks.
4. **Run** — run `tickmarkr run`. Watch the run journal for its terminal event rather than repeatedly polling agents. Use a self-terminating poll — `until grep -q '"event":"run-end"' <state-dir>/runs/<runId>/journal.jsonl; do sleep 20; done` — never `tail -F | grep -m1` (run-end is the journal's last line, so tail never notices the broken pipe and the watcher hangs forever) and never a pane-level done wait (it fires on every agent turn end, not mission end). Resolve blocked interactions in the agent session; do not turn them into proxy questions.
5. **Verify and consolidate** — accept only a green run. A run is green when the run-end event exists in the journal AND the tip verify is not "failed". Tickmarkr consolidates accepted task work on `tickmarkr/<runId>`; it never signs off to the main branch. A human may later merge that integration branch through the repository's normal release process.
6. **Record** — write `tickmarkr report <runId> --md` beside the source spec and commit the execution record when the repository tracks those records. Then [stand down](#stand-down-mission-end-and-retirement).
