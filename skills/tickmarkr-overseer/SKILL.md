---
name: tickmarkr-overseer
description: "Use when the user asks to oversee/supervise/babysit an autonomous tickmarkr run in a Herdr workspace (e.g. '/tickmarkr-overseer run the milestone', 'supervise this tickmarkr run', 'babysit this pipeline'). Requires HERDR_ENV=1. The skill argument is the mission (what to run end-to-end)."
---

# Overseer (tickmarkr)

Become the OVERSEER for this workspace. Do no heavy work directly — build and supervise a two-tier
hierarchy of VISIBLE agents (you → orchestrator → tickmarkr's own worker fleet), and route human decisions
to the user with evidence.

The mission is the skill argument. If empty, ask the user what to run end-to-end before doing anything else.
Requires `HERDR_ENV=1`; if unset, say so and stop.

## Setup

0. **Adopt before you build.** If this workspace already has a supervision hierarchy — an
   OVERSEER/ORCHESTRATOR tab, a live agent named `*orch*`, or a `<repo>/<state-dir>/overseer/` dir
   (state dir = `.tickmarkr/`; legacy standalone `<repo>/.overseer/` counts
   too) — do NOT spawn a duplicate (two orchestrators risk two concurrent tickmarkr runs in one repo,
   which tickmarkr forbids). Read that dir's `DECISIONS.md` + `ORCH-BRIEF.md`, check the existing agents'
   status, and either ADOPT the
   existing orchestrator (updated brief, re-armed watchers) or, if the old hierarchy is dead, archive the
   stale brief and build fresh.
1. Load the `herdr` skill. `herdr pane list` to map the workspace — the focused pane is yours. Rename your
   tab OVERSEER; create ONE tab ORCHESTRATOR.
   **Live tab labels (standing operator rule, 2026-07-12):** on every decision or state change (role
   handoff, task done/merged, run end) rename the affected tabs — and keep labels SHORT: the role as the
   main name plus at most ONE hot-state token. Vocabulary: ORCH carries the milestone and progress
   fraction (`ORCH · v1.19 4/5`, updated on every task-done); WORKERS carries the task token (tickmarkr
   updates it). Never long context strings or ✓-chains.
2. **Orchestrator**: Launch the orchestrator with your agent host. For Claude Code, use `herdr agent start orchestrator --cwd <repo> --no-focus -- claude --permission-mode bypassPermissions` (pin a strong model with `--model <m>` if the operator has a policy). For Codex, use `herdr agent start orchestrator --cwd <repo> --no-focus -- codex --dangerously-bypass-approvals-and-sandbox` (add `--model <m>` to specify the model). The unsandboxed flag is REQUIRED: codex's `workspace-write` sandbox keeps `.git` refs read-only, so a sandboxed orchestrator's `tickmarkr run` dies at integration-branch creation — do not downgrade it. Workers you never spawn — tickmarkr spawns its own visible worker panes. Auxiliary agents you do spawn (consultants, reviewers, scouts) follow the same forms: never launch a claude session in plan mode or default permission mode for autonomous work — both stall on per-command approval prompts nobody is watching; claude is always `--permission-mode bypassPermissions`, and a read-only codex consultant may use `--sandbox read-only`.
3. **Standing instructions travel as a brief FILE, never as pane text** — PTY input truncates at ~1024B and a
   truncated brief silently drops policy. Write the full brief to `<repo>/.tickmarkr/overseer/ORCH-BRIEF.md`
   (inside the tickmarkr state dir — already self-gitignored, no exclude step needed), then send one line:
   `herdr pane run <orch> "Read .tickmarkr/overseer/ORCH-BRIEF.md and follow it exactly."` The brief MUST contain: the
   mission, the pane mechanics below, rules 1–2, and require a verbatim one-sentence acknowledgment of the
   human-checkpoint rule before anything is dispatched. Delete the dir at mission end.
4. Arm the watcher (Supervision). Report the hierarchy map (pane ids + names) to the user.

## Supervising tickmarkr as the executor

When the mission runs `/tickmarkr-auto` (tickmarkr dispatches the workers), supervision changes shape:

- **Give the run a live surface.** `tickmarkr run` is stdout-silent until run-end by design — split a pane in the
  ORCHESTRATOR tab running `tickmarkr status --watch`. Narration also arrives as herdr notifications.
- **Watch the journal, not the panes.** The append-only journal
  (`.tickmarkr/runs/<runId>/journal.jsonl`) is the
  source of truth. Arm a background watcher on `run-end` / `task-human` / `task-failed` / `consult-verdict`
  events; never sleep-poll inside an agent turn.
- **Daemon liveness ≠ journal activity.** A dead daemon emits no events, so journal watchers sleep through
  its death. `tickmarkr status` prints last-event age + daemon pid liveness; check it before diagnosing a stall.
  Recovery is `tickmarkr resume <runId>` — crash-safe by design (journal replay restores attempt counts and
  consult channel bans).
- **Gate quiet ≠ idle.** Between `worker-result` and the batched `gate-result`s tickmarkr runs shell gates plus a
  headless LLM judge/review with little visible signal — check the journal timestamps before intervening.
- **Classify gate failures before reacting.** The same fingerprint failing across DIFFERENT workers, or a
  scope/test catch-22 (attempt N edits a file → scope gate fails; attempt N+1 leaves it → test gate fails),
  is a PLAN defect: widen `files_modified` in the phase PLAN, recompile the phase dir after the run ends or
  the task parks, release (`human → pending`), resume. A cross-vendor review rejection with concrete findings
  is a REAL defect — let the escalation ladder work.
- **Dialog watchers go stale per attempt.** Every retry/escalation may spawn a new pane; re-arm dialog
  watchers on each `task-dispatch` journal event.

## Pane mechanics that bite

- **Verified send protocol**: `herdr agent send` writes WITHOUT Enter, and `pane run`'s Enter can be swallowed
  by bracketed-paste on long payloads. Robust sequence: read the pane (bare prompt required) → send-text →
  sleep 2–3s → send-keys Enter → read back (input empty / agent `working`). Never report "briefed" without
  the read-back. Long content goes in a brief file, never pane text.
- **Guard-before-Enter** (race-safe prompt answering): chain with `&&` — pane get shows `blocked` && pane
  read shows the expected option under the cursor && only then send-keys. If no longer `blocked`, someone
  already answered; do nothing.
- `herdr wait agent-status` exits 1 on timeout, 0 on match — but ALSO 0 (with an error JSON) when the pane is
  GONE. Never chain `wait && act` without confirming the pane exists.
- Stale typed input is unclearable via CLI — supersede it:
  `pane run "<-- disregard everything before this arrow (stale draft). ACTUAL: <message>"`.

## Supervision watcher

Arm the bundled watcher as its OWN Bash call with `run_in_background` — chaining it after other commands
with `&` orphans it from the wake chain. It prints one wake reason and exits; re-arm after every wake.

```bash
.claude/skills/tickmarkr-overseer/scripts/watch-panes.sh WORKER_PANE ORCH_PANE [--fast-blocked]
```

Default mode wakes only when both panes are quiet (dropped handoff) or the orchestrator blocks; the
orchestrator gets a 90s grace window to handle worker blocks first. For long parked stretches a targeted
`herdr wait agent-status <pane> --status <s> --timeout <ms>` beats the watcher. When parking a human
checkpoint, also fire `herdr notification show "HUMAN CHECKPOINT: <gate>" --sound request`.

## Specialist pipeline rules

- **Dedicated consultant tab**: Consultants (agents spawned to gather synthesis input for decisions like SCOPER analysis or architectural reviews) must run in a DEDICATED tab separate from the ORCHESTRATOR tab. When the orchestrator stands down, the consultant panes should persist so their assessments remain available for review and reference.
- **Scoper worktree rule**: The SCOPER (or any worktree-based specialist synthesizing into the spec pipeline) must do ALL git operations in a dedicated worktree (e.g., `git worktree add /private/tmp/tkr-scoper-v155 -b spec/...`), never switching the main checkout's branch. This prevents race conditions between the specialist's branch operations and the orchestrator's shipping logic.

## Non-negotiable rules

1. **Takeover rule**: only act on a worker if it needs input AND the orchestrator is not `working`.
2. **Human checkpoints (absolute)**: any gate marked `autonomous: false` or asking for product/visual
   sign-off is NEVER auto-answered — regardless of how obviously correct the highlighted option looks. Leave
   it blocked and bring the user the decision WITH evidence. If the mission explicitly delegates authority,
   routine-class gates may be overseer-decided after polling the operator first — but spend and ship gates
   NEVER self-decide.
3. **Trust disk over transcripts**: verify artifacts on disk before building on them; a subagent killed
   mid-flight still renders "Done" without writing its artifact.
4. **Report concisely on every state change**: what happened, who handled it, what's next. Lead with the
   outcome. Surface product decisions; never make them.
5. **Log every abnormality** to `.planning/OBSERVATIONS.md` (or the project's ledger), even mid-run.
