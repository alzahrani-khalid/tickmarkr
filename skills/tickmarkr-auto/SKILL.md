---
name: tickmarkr-auto
description: 'Run a repository’s requested specs autonomously with tickmarkr. Triggers: "/tickmarkr-auto", "run these specs with tickmarkr", "autonomous tickmarkr run".'
argument-hint: "[spec-or-directory ...]"
---

# tickmarkr-auto — run repository specs autonomously

Use this to execute a requested sequence of repository specs. It is SDD-agnostic: each target can be any file or directory accepted by `tickmarkr compile`.

## Two-tier by default — role check before the loop

When working in a multi-agent terminal environment, decide your role before starting:

- **Orchestrator:** your session was started to execute the mission. Rename your own tab/pane `ORCH · <version>` (short labels: ≤20 chars, `ROLE · token`) and run the loop below.
- **Supervisor with a live orchestrator:** do not start a second run. Relay the mission to the existing orchestrator with a [verified handoff](#verified-handoffs-agent-to-agent-messaging), then supervise it as OVERSEER.
- **Primary session without an orchestrator:** rename your own tab `OVERSEER · <version>` and your agent `overseer`, spawn one child orchestration session with your host's launch form, label its tab `ORCH · <version>` and name its agent, give it the mission and these rules verbatim, then supervise it. Do not drive a duplicate single-tier run yourself. Before spawning, confirm any PREVIOUS orchestrator has stood down (monitors stopped, input box empty — dim ghost-text suggestions are UI, not queued input; ANSI-verify before alarming) and close its tab — the journal, records, and ledger hold the story; scrollback is disposable.
  - **Claude Code:** `herdr agent start orchestrator --cwd <repo> --no-focus -- claude --permission-mode bypassPermissions`
  - **Codex:** `herdr agent start orchestrator --cwd <repo> --no-focus -- codex --ask-for-approval never --sandbox workspace-write`

Outside a multi-agent terminal environment, run the loop directly.

## Stand-down (mission end and retirement)

On each mission's terminal state, after the record commit and operator notification: the orchestrator stops every monitor and background task it started, prints one final stand-down line, and leaves nothing queued in its input box. A finished session with an armed watcher or pre-filled input is a loaded gun.

## Invariants

- Never run two tickmarkr runs in the same repository concurrently.
- Never let tickmarkr merge work to the main branch. New work consolidates on `tickmarkr/<runId>`.
- Do not edit a generated graph to force an outcome; correct the source spec and compile again.
- Gates independently verify evidence, scope, acceptance criteria, and review. A worker's completion claim is not evidence.
- Treat missing or unparseable machine results and verdicts as failures. Never bypass a failed gate or merge partial work without a human decision.

## Act by default

Run every requested target in order without seeking routine confirmation. Stop only for a blocked agent interaction, a genuinely unresolved stalled task, a designed human gate, or a failed run that needs a human decision. Diagnose from the journal and evidence first; self-release and resume only after fixing and verifying a harness defect.

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

## Per-spec loop

1. **Prepare** — confirm the target list. Run the [binary preflight](#binary-preflight-before-compile-or-run). Check `git status`, confirm no tickmarkr run is active, and work from a non-main branch.
2. **Compile** — run `tickmarkr compile <spec-or-directory>`. Fix source-spec defects instead of editing the generated graph.
3. **Plan** — run `tickmarkr plan`. Review routes, capability-floor warnings, and human gates before execution.
4. **Run** — run `tickmarkr run`. Watch the run journal for its terminal event rather than polling agents — a self-terminating poll (`until grep -q '"event":"run-end"' <state-dir>/runs/<runId>/journal.jsonl; do sleep 20; done`), never `tail -F | grep -m1` (wedges on the journal's final line) and never a pane-level done wait (turn-end flaps). Resolve blocked interactions in the relevant agent session.
5. **Verify and consolidate** — continue only after a green run. A run is green when the run-end event exists in the journal AND the tip verify is not "failed". Tickmarkr consolidates accepted work on `tickmarkr/<runId>` and never signs off to the main branch. A human controls any later release merge.
6. **Record** — write `tickmarkr report <runId> --md` beside the source spec and commit the execution record when the repository tracks those records.
7. **Continue** — move to the next requested target. If a target fails or is parked, stop with the journal evidence rather than silently skipping it.
