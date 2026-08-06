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
0a. **READ THE PROJECT MEMORY BEFORE YOU START — it already contains discipline you are about to re-earn.**
   `~/.claude/projects/<cwd-slug>/memory/` (slug = the absolute cwd with `/` → `-`). Read `MEMORY.md`, then
   `ls` the topic entries and open every one whose name concerns METHOD or DISCIPLINE rather than a shipped
   milestone — names like `*-discipline`, `*-drill`, `*-parity`, `*-least-permission`, `context-reset-*`,
   `consults-*`, `agent-*`.
   **Earned 2026-08-04, expensively.** That directory held `…-falsification-drill-discipline.md`, written
   three weeks earlier: *"a gate or grep-pin is assumed WRONG until a falsification drill proves it bites…
   run the drill that should redden it and SEE the red before trusting green."* That is Evidence discipline
   rule 11 below, verbatim in substance. Nothing surfaced it, so an orchestrator and an overseer re-derived
   it independently, twice, inside one hour — and the overseer then filed it as a NEW rule into a
   mission-scoped brief. **A memory that exists and is never opened costs more than one that was never
   written, because everyone assumes the lesson is somewhere.** Entries may predate a project rename; search
   by concept, not by the current product name.
1. Load the `herdr` skill. `herdr pane list` to map the workspace — the focused pane is yours. Rename your
   tab OVERSEER; create ONE tab ORCHESTRATOR.
   **Live tab labels (standing operator rule, 2026-07-12):** on every decision or state change (role
   handoff, task done/merged, run end) rename the affected tabs — and keep labels SHORT: the role as the
   main name plus at most ONE hot-state token. Vocabulary: ORCH carries the milestone and progress
   fraction (`ORCH · v1.19 4/5`, updated on every task-done); tickmarkr opens ONE TAB PER TASK, labelled
   with the task id and holding that task's worker plus its judge/review/consult panes (tickmarkr
   updates it). Never long context strings or ✓-chains.
2. **Orchestrator**: Launch the orchestrator with your agent host. Spawning on current herdr is two-step — the one-shot `agent start --cwd` form was removed in the herdr CLI redesign and now fails with `unknown option` (OBS-138): first create the pane with `herdr tab create --workspace <ws> --cwd <repo> --label "ORCH · <version>"` and parse `result.root_pane.pane_id` from its JSON, then start the agent in it. For Claude Code, use `herdr agent start orchestrator --kind claude --pane <root-pane-id> -- --permission-mode bypassPermissions` (append `--model <m>` after the `--` if the operator has a policy). For Codex, use `herdr agent start orchestrator --kind codex --pane <root-pane-id> -- --dangerously-bypass-approvals-and-sandbox` (add `--model <m>` to specify the model). The unsandboxed flag is REQUIRED: codex's `workspace-write` sandbox keeps `.git` refs read-only, so a sandboxed orchestrator's `tickmarkr run` dies at integration-branch creation — do not downgrade it. Workers you never spawn — tickmarkr spawns its own visible worker panes. Auxiliary agents you do spawn (consultants, reviewers, scouts) follow the same forms: never launch a claude session in plan mode or default permission mode for autonomous work — both stall on per-command approval prompts nobody is watching; claude is always `--permission-mode bypassPermissions`, and a read-only codex consultant may use `--sandbox read-only`.
3. **Standing instructions travel as a brief FILE, never as pane text** — PTY input truncates at ~1024B and a
   truncated brief silently drops policy. Write the full brief to `<repo>/.tickmarkr/overseer/ORCH-BRIEF.md`
   (inside the tickmarkr state dir — already self-gitignored, no exclude step needed), then send one line:
   `herdr pane run <orch> "Read .tickmarkr/overseer/ORCH-BRIEF.md and follow it exactly."` The brief MUST contain: the
   mission, the pane mechanics below, rules 1–2, and require a verbatim one-sentence acknowledgment of the
   human-checkpoint rule before anything is dispatched.
   **⚠ HARVEST BEFORE YOU DELETE.** At mission end the brief dir goes — but a long mission accumulates
   *method guards* in that brief (how to know a thing, not what is true of this spec), and deleting them
   re-earns each one at full price on the next mission. So before removing the dir: lift every durable,
   mission-independent guard into **this skill** (Evidence discipline, below) or the project's `CLAUDE.md`,
   and only then delete. A guard's home must outlive the mission that earned it. The project ledger does
   NOT count as that home — `CLAUDE.md` itself says planning records are read-only archives and current
   guidance belongs in the memory file or the shipped docs.
4. Arm the watcher (Supervision). Report the hierarchy map (pane ids + names) to the user.

## Supervising tickmarkr as the executor — WHO DOES WHAT

When the mission runs `/tickmarkr-auto` (tickmarkr dispatches the workers), supervision changes shape —
and the first thing to get right is that **almost none of it is yours**.

**THE ORCHESTRATOR OWNS THE LOOP. You rule and record. You do not drive.**

| | ORCHESTRATOR | OVERSEER |
|---|---|---|
| `compile` · `plan` · `run` · `resume` | **owns** | never |
| journal watchers, live surface, dialog watchers | **owns** | watches the ORCHESTRATOR, not the run |
| orphan sweeps, worker pane hygiene | **owns** | — |
| reading a gate failure and assembling its evidence | **owns** | reads the file it writes |
| **deciding** a gate, spend, or ship | never | **owns** |
| executing `tickmarkr approve` after a ruling | **owns** | never |
| git writes, the ledger, records, the operator | never | **owns** |

**Why this is a rule and not a preference — it has a measured cost.** On 2026-08-04 an OVERSEER ran the
loop itself: compile, plan, run, resume, approve, sweeps, even source fixes. The operator caught it —
*"you are doing the job of the orchestrator, the orchestrator is the one should be taking care of the
gates"* — and the receipt was a pair of numbers: **the ORCHESTRATOR sat at 369K tokens while the OVERSEER
burned 747K.** Collapsing two tiers into one does not just waste a seat; it **burns the context of the
seat that cannot be replaced cheaply**, because the orchestrator can `/clear` against a brief while the
overseer holds the mission's judgment. A tier collapse is therefore a context leak with a delay fuse.

**The tell, and you will not notice it from inside:** if you are typing `tickmarkr resume`, or reading a
journal tail to decide what happens next, or sweeping orphans — you have taken the loop. Hand it back.

### What the ORCHESTRATOR does, and what you require of it

- **A live surface.** `tickmarkr run` is stdout-silent until run-end by design, and the run spawns its own
  watch board (`role: "watch"`, one per run) — **look for that pane before building anything.** Do NOT use
  `tickmarkr status --watch` as the surface: `status <runId>` has reported the WRONG run, so a board built
  on it shows a previous milestone's numbers under the current run's id.
- **The journal is the source of truth**, not panes. Watchers go on `run-end` / `task-human` /
  `task-failed` / `consult-verdict`; never sleep-poll inside an agent turn. **Never key a watcher on an
  agent's `done`** — that is turn end and fires the moment a seat finishes acknowledging you.
- **Daemon liveness ≠ journal activity.** A dead daemon emits no events, so journal watchers sleep through
  its death. Liveness comes from the lock's OWN pid (`kill -0`), never a command-name grep. Recovery is
  `tickmarkr resume <runId>` — **the orchestrator's command, not yours** — and note that resume REPLAYS the
  journal's `baseRef`, so a fix landed on the base branch is unreachable by the running run.
- **SWEEPING A WORKER ORPHANS ITS CLEANUP, NOT JUST ITS WORK — kill the process GROUP.** Measured
  2026-08-06: a worker running a legitimate load experiment had spawned CPU burners and held a trailing
  `kill` line. It was SIGTERM'd as an orphan; **the cleanup never ran**, and **59 surviving burner shells
  drove load to 243** — which then timed out a 2.4-second test at 20 seconds, failed the run's tip-verify,
  and was initially blamed on an unrelated known defect. Seven workers were swept that day under a rule
  that treats sweeping as pure hygiene, and nothing in it looks for pending cleanup.
  **The fix is mechanical, not vigilance:** kill the process GROUP so forked children die with the parent,
  and identify the target **by PID from a parse — never by name pattern.** A pattern matching a script path
  also matches any supervisor carrying that path in its own argv, so `pgrep -f <script>` kills the watchdog
  along with the watched (measured the same day, on the overseer's own dialog watcher).
  **After any sweep, verify what SURVIVED, not just what died** — the supervisor, the daemon, and the
  current attempt's worker.
- **Gate quiet ≠ idle.** Between `worker-result` and the batched `gate-result`s, shell gates plus a
  headless judge/review run with little visible signal. Clock the CURRENT phase: a worker heartbeat is
  stale by design once gates start, and clocking the wrong one makes a healthy gate read as a stalled
  worker — the false alarm that gets a good run killed.
- **Classify gate failures before reacting.** The same fingerprint across DIFFERENT workers, or a
  scope/test catch-22 (attempt N edits a file → scope fails; attempt N+1 leaves it → test fails), is a
  PLAN defect. So is any blocker OUTSIDE the task's `files[]` — no worker can fix it and a retry is
  knowingly wasted. A cross-vendor review rejection with concrete findings is a REAL defect; let the
  ladder work.
- **Dialog watchers go stale per attempt.** Every retry may spawn a new pane; re-arm on each
  `task-dispatch`.

### What YOU do

Read the evidence file the orchestrator writes, rule on it against your pre-committed release criterion,
record the ruling with what it set aside, and hand the ruling back for execution. That is the whole job,
and it is the only work that cannot be delegated — which is exactly why nothing else should occupy you.

**And before you write the ruling: check that YOUR REMEDY is buildable inside the task's `files[]`.** The
orchestrator is told to classify a blocker outside a task's scope as a plan defect. Nothing tells the
OVERSEER that *its own instruction* can be that defect — so it arrives carrying your authority and is not
re-examined.

**Measured 2026-08-06.** A ruling directed a task to make a function parameter required. Verified
afterwards: two callers pass one argument, in a file **no task in the graph owned**. The worker would have
been trapped — edit it and fail `scope`, leave it and fail `build` — and the failure would have surfaced
as a worker defect at the next park. Worse, the unowned file was exactly the relation that task existed to
detect: **the ruling would have made the worker commit the violation the task was being built to catch.**

> Run the callers before you write the remedy: locate the symbol, **enumerate** every caller and asserting
> test, classify each against `files[]`, and resolve who owns the out-of-scope ones. A sweep for this class
> then found **five of six remaining tasks exposed**, so it is a shape, not an accident.

### Context is a supervised resource, for BOTH tiers

Arm a context watcher on the orchestrator at spawn time and treat a threshold wake as a first-class event:
finish the step, write a handoff, `/clear` **plus a fresh brief — never `/compact`**, because a compaction
is a lossy summary nobody trusts while a clean session re-oriented from disk-verifiable state is reliable.
**Do the same for yourself before you are forced to**: write the handoff while your judgment is still
good, not after. If your own context cannot be read by the watcher, say so to the operator and ask for the
number — an unmeasured budget is not a small budget.

## Pane mechanics that bite

- **Verified send protocol**: `herdr agent send` writes WITHOUT Enter, and `pane run`'s Enter can be swallowed
  by bracketed-paste on long payloads. Robust sequence: read the pane (bare prompt required) → send-text →
  sleep 2–3s → send-keys Enter → read back (input empty / agent `working`). Never report "briefed" without
  the read-back. Long content goes in a brief file, never pane text.
  **PROBE THE READ-BACK WITH THE SHORTEST DISTINCTIVE TOKEN — a commit hash, a pid, an OBS id — NEVER a
  sentence.** A long phrase crosses the pane's render wrap boundary, so grepping for it returns zero on a
  message that arrived intact, and **a badly-probed successful send is byte-identical to a truncated one.**
  Both natural reactions to that false negative are wrong: re-sending duplicates the message into the
  target's queue, and escalating reports a delivery failure that never happened. Measured 2026-08-06
  (OBS-396): a grep for the full sentence returned 0 while a grep for one word of the same sentence
  returned 1. This trap lives *inside* the verification step above, which is why it survives — the rule
  that is supposed to catch dropped sends is the rule that manufactures the phantom.
- **Guard-before-Enter** (race-safe prompt answering): chain with `&&` — pane get shows `blocked` && pane
  read shows the expected option under the cursor && only then send-keys. If no longer `blocked`, someone
  already answered; do nothing.
- **AGENT NAMES ARE GLOBAL ACROSS WORKSPACES — verify a seat you spawned by PANE ID, never by name.**
  Names must be unique among live agents *everywhere*, not within your workspace, so another workspace can
  already hold `opus`, `sol`, `reviewer` or `orch`. When it does, your `agent start` **fails**, your pane
  is left a bare shell, and `agent list` / `agent read` / `agent prompt` for that name then resolve to the
  **stranger's seat**. Measured 2026-08-06 (OBS-392): a spawn of `fable` collided with a live seat in
  another workspace; `agent list` reported `fable -> blocked` and it was read as *this* seat coming up
  blocked. It was an operator research session sitting on a *"Resume full session?"* prompt. One more
  command would have submitted a brief into it. **Namespace every name you pick** (`fable-v187`, not
  `fable`), **treat a failed `agent start` as fatal at the call site** rather than inferring it later from
  a status read — the status read is exactly what the collision corrupts — and print the `workspace_id`
  and `cwd` columns before dispatching to any name. Same class as the liveness rule: a matcher broader
  than the thing it names finds things that are not it, and its output is shaped exactly like a right
  answer.
- **A dead pane accepts your dispatch and reports success.** `herdr wait agent-status` exits 1 on timeout, 0
  on match — but ALSO 0 (with an error JSON) when the pane is GONE. So does `pane run`: sending to a vanished
  pane prints `{"error":{"code":"pane_not_found"}}` and **still exits 0**, so `pane run … >/dev/null && echo
  sent` reports a delivery that never happened. Never chain `wait && act` or trust a send's exit status —
  confirm the pane exists and read it back. An orchestrator's pane can vanish mid-mission without any event
  reaching you; the first symptom is a dispatch into nothing.
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

**⚠ THIS WATCHER KEYS ON `agent_status`, AND `agent_status` IS A PROXY THAT FAILS IN BOTH DIRECTIONS.**
Measured 2026-08-06 on ONE pane inside TEN MINUTES: a worker wedged behind a CLI's modal trust prompt
reported **`idle`** (not `blocked`), and the same pane minutes later reported **`done`** while demonstrably
mid-work — reading files, context climbing. So a status-keyed watcher can both **sleep through a wedged
worker** and **fire on a working one**, and neither failure announces itself. The bundled watcher inherits
this; so does any `herdr wait agent-status`. It is still worth arming — it catches vanished panes and real
blocks — but **never treat its silence as evidence a worker is healthy.**
Two keys that do not lie, in order of strength:
- **The daemon's own waiter.** What `herdr pane wait-output` is matching on tells you the phase from the
  harness's state machine rather than from a status field: a `--match` on a readiness banner means the
  worker has not launched; a `--regex` on the completion trailer means it is running. That is how a stuck
  launch was distinguished from a slow one, and it beats reading the pane.
- **Pane CONTENT.** A rendered prompt pattern is the condition itself; `agent_status` is the harness's
  opinion about the agent. The repo's own `trust-sweeper` scans content and caught a trust modal at
  04:40 that a status-keyed dialog watcher missed at 16:04 — same class, same day, same machine.
**The product fix for the modal case is adapter parity, not a sweeper:** the claude-code adapter passes
`--strict-mcp-config` precisely so MCP-trust modals cannot stall a worker. An adapter lacking that flag
will keep producing this stall, and a sweeper that has been running since 04:40 is evidence the gap was
visible and got swept instead of fixed.

**Every seat you spawn gets an ARTIFACT watcher armed in the SAME call that spawns it** — bundled, and
keyed on the deliverable rather than the seat:

```bash
.claude/skills/tickmarkr-overseer/scripts/watch-artifacts.sh <MARKER> <cap-s> <poll-s> <file>...
```

It wakes when every named file exists AND ends with its terminal marker, and on timeout it reports each
file as READY / PARTIAL / ABSENT so a quiet arm still proves the watcher was alive. Tell each seat, in its
brief, the exact marker its report must end with — you cannot watch for a marker you never demanded.

**Arm it in the same call as the spawn, not the next one.** A watcher armed "after I finish this step"
leaves a gap exactly as wide as however long you stay busy, and you will be busy — you just spawned work.
**Measured 2026-08-06 (OBS-369): two consult verdicts, 30KB and 12.8KB, sat COMPLETE with their markers
while the overseer hand-polled and reported them as still running. The operator had to ask.** Project
memory has carried this rule since before that session and the operator had already flagged it twice; it
was re-earned a third time because nothing in this skill made it a spawn-time step. It is one now.

**Never key a watcher on an agent's `done`.** `done` is TURN end, not mission end — a briefed seat flips to
`done` the moment it finishes acknowledging you, and a watcher waiting on "not working" wakes instantly and
reports a deliverable that does not exist. Key it on the artifact instead: the deliverable file existing **and
containing its terminal marker**, or `blocked`, or the pane being gone. Those are the three states that
actually require you. The same applies to a run: the journal's `run-end` event is the signal, never an
orchestrator turn boundary.

## Specialist pipeline rules

- **Dedicated consultant tab**: Consultants (agents spawned to gather synthesis input for decisions like SCOPER analysis or architectural reviews) must run in a DEDICATED tab separate from the ORCHESTRATOR tab. When the orchestrator stands down, the consultant panes should persist so their assessments remain available for review and reference.
- **Scoper worktree rule**: The SCOPER (or any worktree-based specialist synthesizing into the spec pipeline) must do ALL git operations in a dedicated worktree (e.g., `git worktree add /private/tmp/tkr-scoper-v155 -b spec/...`), never switching the main checkout's branch. This prevents race conditions between the specialist's branch operations and the orchestrator's shipping logic.
- **One fresh pane per consult ROUND** (operator rule, 2026-08-04): every consult round spawns a NEW pane in
  the consult tab rather than re-prompting the seat that answered last round — unless there is a stated
  reason to reuse. Two payoffs: each round starts with a clean context window instead of inheriting the
  previous round's, which is what fills a long mission's seats and forces mid-mission `/clear`; and the
  prior round's pane persists as a readable record of what that seat actually saw and said. Reuse only when
  continuity of the seat's own reasoning is the point, and say so when you do.
- **CLOSE WHAT YOU SPAWNED** (operator observation, 2026-08-04: *"orch doesn't auto close the panes that he
  created when no more needed"*). Panes accumulate silently — one mission reached **15 panes and 10 tabs**,
  ten of them holding live agent sessions for work that had been on disk and fully consumed for hours.
  Neither seat cleaned up, because neither had been told to.
  - **Whoever spawns a pane owns closing it.** The orchestrator closes its workers; the overseer closes the
    consultants and sweeps it spawned. The overseer sweeps whatever is left at mission end.
  - **Verify the deliverable is ON DISK before closing** — a pane is the only place an unwritten finding
    exists, and an agent that rendered "Done" without writing its artifact did not deliver (the
    trust-disk-over-transcripts rule — cited by NAME, because a renumbered list orphans a "rule N").
    **Non-empty is the FLOOR, not the test: completeness is the artifact's own TERMINAL MARKER.** One
    consult verdict was 10KB on disk while its seat still read `working` — size proved it had started, and
    only the closing `VERDICT:` line proved it had finished. Require the terminal marker a report is
    supposed to end with, per seat, then close.
  - **A pane is not an archive; the report is.** Once a worker's findings are written and synthesized, its
    transcript adds nothing the report does not.
  - **KEEP: the active seat, and the most recent SETTLED consult round.** That last one earns its place —
    re-prompting the seat that found a defect to confirm its own fix is cheaper and stricter than briefing
    a fresh one, which is the stated-reason exception above. Close consult rounds only once a later round
    has re-derived their findings.
  - Emptied tabs disappear on their own; do not close tabs by hand.
  - **CLOSE IT AUTOMATICALLY, because remembering is what fails.** `watch-artifacts.sh` already fires on
    the one signal that means a seat is finished — the artifact plus its terminal marker — so hand it the
    panes too: `TKR_CLOSE_PANES="w1:p1,w1:p2" watch-artifacts.sh …`. It closes them on completion and
    **never on timeout**, where the seats are still working. Closing on the marker cannot reap a seat
    mid-write, which is exactly why `done` would be the wrong trigger.

- **MEASURE BEFORE EVERY SPLIT, AND JOIN *DOWN* WHEN A RIGHT-SPLIT WOULD GO UNDER THE FLOOR.**
  **Operator-observed 2026-08-06, with a screenshot:** five consult panes in one tab rendered **14 columns
  wide each** out of 220 — every one unreadable, including the two that had finished hours earlier.
  **This rule's own earlier wording said to "split the newest pane; the tree stays balanced", and that
  remedy is wrong** — an OVERSEER followed it the next session and measured `110/55/55`, which is the
  exact split the old text cited as the *failure*. Corrected, with the measurement:
  - **Direction is decided by arithmetic, not by which pane you pick.** The driver's floor is real and
    derived from measurement — `TRAILER_SAFE_FLOOR_COLS = 108` (`src/drivers/herdr.ts:13`, *"narrowest
    safe 53 → floor 108"*), and it splits right only while `paneWidth/2 ≥ 108 + 2` (`herdr.ts:494`),
    otherwise **down**. Apply the same test by hand: `herdr pane layout --pane <id>`, halve the width,
    and if the halves fall under the floor, split `--direction down`.
  - **Binary splits cannot produce an even 3-column row at any width.** 220 goes to 110/55/55 whichever
    pane you split. **At a 220-col terminal the width-derived cap is TWO side-by-side panes**; a third
    seat goes below one of them, or into its own tab. "Three panes" is a *height* heuristic
    (tickmarkr's own `workersPerTab: 3` assumes ~50 rows) and it does not authorise a third column.
  - **A finished seat keeps its width.** Panes are a fixed budget — every seat you do not close is taken
    out of the readability of the ones still working. There is no rebalance command, so the fix is
    closing, not resizing.
  **The general lesson, which is why this correction is worth its lines: a prose rule that restates a
  measurement without carrying the number reproduces the defect at full price.** The floor lives in
  `src/`; every seat that hand-splits panes is outside it and re-learns this by hand.

## Non-negotiable rules

1. **Do not drive the run.** The ORCHESTRATOR owns `compile`/`plan`/`run`/`resume`, the watchers, the
   sweeps, and assembling gate evidence. You rule, record, and talk to the operator. Measured cost of
   ignoring this: one OVERSEER at 747K tokens beside an idle ORCHESTRATOR at 369K, doing one tier's work
   in the seat that cannot cheaply `/clear`. **The tell is your own hands** — typing `tickmarkr resume`,
   tailing a journal to decide the next move, sweeping orphans. Hand it back.
2. **Takeover rule**: only act on a worker if it needs input AND the orchestrator is not `working`.
3. **Human checkpoints**: any gate marked `autonomous: false` or asking for product/visual sign-off is
   NEVER auto-answered — regardless of how obviously correct the highlighted option looks. Leave it
   blocked and bring the user the decision WITH evidence.
   **When the mission delegates authority, the carve-out is the IRREVERSIBLE CREDENTIAL-BEARING ACT
   ITSELF — not every decision upstream of it.** `npm publish`, `git tag`, a push to a public remote run
   under the operator's name and account, and *"in charge" is not an npm token*. **Everything upstream is
   yours**: whether a fix warrants a patch release, what rides which milestone, what to spend, what order
   to ship in. Announce it with its cost basis and ACT.
   **Earned 2026-08-06, at a measured price.** An OVERSEER holding a written delegation asked the operator
   *"patch release ahead of the milestone, or fold it in?"* — a SCHEDULING question, no credential
   anywhere near it, about a fix that did not yet exist. The operator was away **8.5 hours**. The run
   ended, parked seven tasks and went unwatched; the context watcher fired and exited unread. Operator,
   verbatim: *"why did you wait for me to decide earlier? you should have taken the decision your self ..
   I delegated this to you, remember?"*
   **The tell: if no credential, tag or public remote is touched by the ACTION you are about to take, it
   is not the carve-out — decide it.** And a blocking ask is never the only option: route it through a
   cross-vendor consult and rule, which is what a pre-committed release criterion already prescribes.
   **A supervising seat that blocks is not neutral — it is unwatched.** Waiting has a running cost the
   question never displays, and that cost lands on the run, not on the seat that waited.
4. **Trust disk over transcripts**: verify artifacts on disk before building on them; a subagent killed
   mid-flight still renders "Done" without writing its artifact.
5. **Report concisely on every state change**: what happened, who handled it, what's next. Lead with the
   outcome. **Surface product decisions — and under a standing delegation, MAKE them and say you did.**
   Without a delegation, surface and wait. With one, deciding IS the job; report the ruling and its basis
   rather than the question. Say *"I decided"*, never *"you approved"* — a record implying a signature it
   never received is this rule's own defect class running in the opposite direction.
6. **Log every abnormality** to `.planning/OBSERVATIONS.md` (or the project's ledger), even mid-run.
7. **Every fix is evaluated for shipping.** The tarball is `files: [dist, schema, skills, fixtures]` — so
   `src/**` and `skills/**` reach users while `.overseer/**` and `.tickmarkr/**` reach nobody. Before
   calling a fix done, ask where it lands: a local overlay or a scaffold script standing in for a source
   fix helps ONE operator and leaves every other user with the defect. If an overlay is the interim, it
   says so in writing and names its removal condition.

---

## Briefing a seat to audit a security-shaped check — phrasing matters

**Earned 2026-08-04.** A consult seat was asked to *"hunt one more forged pass"* on an authorization gate.
Its provider cut the session off mid-work — *"We take extra caution with cybersecurity requests"* — and the
report was never written. The seat had already found the real defect (a timezone-dependent clock) and that
finding was recovered only by reading its pane before closing it.

**The work is legitimate; the framing is what trips the filter.** Ask for completeness, not exploitation:

- ✗ "find a forged pass", "bypass this", "attack the gate", "how would you defeat it"
- ✓ **"enumerate every input this check depends on, and confirm each one is bound"**
- ✓ "which of these inputs can a caller still control?"
- ✓ "state what this check does NOT establish"

That phrasing produces the same findings — the timezone hole IS an unbound input — without asking a model to
generate an attack. **And read the pane before closing a seat that ended without its artifact:** a refusal
mid-work leaves real findings in the transcript and nowhere else, which is the one case where the pane, not
the report, is the deliverable.

## Evidence discipline — the durable core

Distilled from a v1.86 spec-repair mission that produced 31 numbered rules, ~90 audit findings and nine
errors authored by the supervising seat itself. **Every line below was earned by a defect, most of them
twice.** They are mission-independent on purpose: nothing here names a task, a line number or a figure.

**Rot**

1. **A quotation is exact bytes.** `grep` it before attributing it; if it does not hit, it is not a
   quotation. A fabricated quotation is the only error that presents itself as primary evidence, so the
   natural check is already answered on its face.
2. **A verified quotation ROTS** — the source moves underneath it. Pin it (`as written at <sha/time>`) or
   re-verify. Documenting a repair is the highest-risk case: the edit you describe is the edit that
   falsifies your description.
3. **A FINDING rots exactly like a quotation, and carries more authority while doing it** — a quotation
   invites checking; *"the consultant found X"* invites action. Re-derive the premise before acting. A
   *dissolved* finding gets marked SUPERSEDED, never silently dropped.
4. **Before editing a line, sweep for the records that QUOTE it** — rule 2 used prospectively, which is the
   only time it is cheap. **And the dual, from the mutating end: any repair to a CONDITION a document
   DESCRIBES must sweep the descriptions in the same edit.** Fixing the world falsifies the prose about the
   world, and that prose is nobody's assigned target — it is collateral. Four occurrences in one phase; twice
   the fix was right and only the record was wrong, which is the version that survives review because the
   change itself is defensible. **Keep the defect's record when you resolve it** — a passage that flagged a
   risk which was then relied upon anyway is more instructive than a clean line saying "resolved".
5. **Never freeze a moving number.** A figure describing anything under active edit is a quotation on a
   timer; record the derivation command, not the value. A count over a population your own work adds to is
   self-invalidating — state a floor.

**Scope of a result**

6. **Every gate, tool and verdict states what it does NOT establish.** A green gate is a claim about form
   until its negative scope says otherwise. This applies to a *seat's own verdict* as much as to a tool:
   an unchecked cite in a task with no finding is unchecked, not confirmed.
   **THE PRESENCE OF A ROW IS NOT EVIDENCE THAT THE WORK HAPPENED — READ ITS QUALIFYING FIELDS.** Three
   instances in one run (2026-08-06), which is what makes it a law and not an anecdote: a `gate-result`
   for `test` carrying `selectedTests` — a PASS over a 16-test subset, not the suite; a `phase-start` for
   a gate with no result row at all, where *deferred* and *dropped* are indistinguishable; and a
   `tip-verify` row with `cached: true`, whose own source comment says it *"keeps it honest about not
   having re-run the command."* **In the first and third the product had already provided the qualifier
   and the reader ignored it** — an OVERSEER read per-gate `tip-verify` rows as proof of a real verify
   while the distinguishing field sat in its own tool output, and was corrected by the ORCHESTRATOR from
   the same lines. So decompose the blame honestly, because the two halves ship to different places:
   **rows that are never emitted are a PRODUCT defect; rows misread past their qualifiers are a READER
   defect**, and no amount of product work fixes the second. Before quoting any row as evidence of an
   action, ask what field on it would tell you the action was skipped, cached, subsetted or deferred —
   and if you cannot name the field, you have not read the record, you have counted it.
7. **Never aggregate per-axis PASSes into "it is clean."** Carrying the PASS and dropping the scope
   manufactures a clean bill nobody issued.
8. **Never exclude a path from a search whose purpose is to find a counterexample there** — and an
   INCLUSION list excludes just as effectively, while being harder to see because every entry is
   individually justified. Cite the line you actually verified.
9. **A name-keyed sweep answers "is the name absent", not "is the concept absent."** Sweep the mechanism's
   vocabulary, and one level further: sweep for what the mechanism *does to* its consumers, not who calls
   it — a thing the harness *applies* to consumers is named by them in no vocabulary at all. Expect
   over-return; discriminating hits is the cost of the method.
10. **A hit proves BYTES, not attribution** — and N hits can be ONE origin copied N times.

**Instruments**

11. **For any guard whose failure is SILENCE — detector, lint, watcher, gate, alarm branch — the acceptance
    test is a POSITIVE CONTROL, not a clean run.** A zero cannot distinguish *nothing is broken* from *the
    instrument is blind* from *the check does not exist*. Remove the condition it should catch and confirm
    it FIRES; only then trust its quiet. **A comment asserting the check is enough to make its own author
    believe it ran.**
    **This rule is the oldest one here and the most re-earned.** Project memory has carried it since
    2026-07-14 as the *falsification drill* — *"eleven gate/pin defects in v1.7 alone, every one caught by a
    drill rather than by a passing test"*, including a `grep -c` gate that exits 0 whether tests pass or
    fail. Prefer a **compile-time guarantee** (a required parameter → a type error) over a grep-pin whenever
    the choice exists: a grep-pin guarding a silent default is a hope. Read step 0a — this is what happens
    when nobody opens the memory.
    **Turn this rule on your own WATCHERS, because they are the guard you are least likely to aim it at.**
    A journal watcher armed on `run-end`/`task-human`/`task-failed` is *supposed* to stay silent through a
    clean merge — so a dead watcher and a correctly-quiet one emit byte-identical evidence from inside the
    seat that owns it, and they diverge only at the first event the wake was actually for. **Watcher
    liveness is proved by the PROCESS TABLE, never by its silence, and never by the report of the seat that
    owns it** — "watchers alive" is the one claim a seat cannot verify about itself. Measured 2026-08-06:
    an orchestrator sat `idle` through three merges and two dispatches with no journal watcher in the
    process table, while its own last report read *"daemon, board, sweeper, watcher all alive"* (OBS-366).
    Two corollaries: **re-arm a wake-and-exit watcher as the same turn's LAST act**, not the next turn's
    first — the gap between them is unwatched and its width is however long the seat stays busy; and **a
    handoff that re-arms one tier's watchers must say which tier's it did NOT re-arm.**
    **That first corollary prescribes DISCIPLINE, and discipline is the wrong fix — measured 2026-08-06.**
    One orchestrator lapsed its journal tier **31 minutes**, then, after diagnosing it and fully intending
    to re-arm, lapsed it again for 3 minutes **while actively thinking about watchers**. Its own diagnosis
    is the durable one: *"I still serialize re-arming behind whatever I am doing."* **A watcher whose
    liveness depends on its owner being free is not armed, it is SCHEDULED.** The structural fix, which
    then survived a wake with zero action from the seat: wrap every wake-and-exit watcher in a supervisor
    that re-execs it, **detached (`ppid 1`) so it outlives the seat and not merely the seat's turn**, and
    have it write a **heartbeat file** so the supervising tier proves liveness *from disk* instead of
    asking the seat that owns it. Decouple **coverage** from **notification**: when the notifier later
    broke, coverage held and nothing was lost — the failure the design was built for.
    **And never convert instrument silence into a WORLD claim.** *"No watcher has fired since X"* is a
    statement about your instrument; *"no state change"* is a statement about the run, and they have
    different truth conditions. A terminal-event watcher is silent through every **non-terminal** change
    **by design**, so its silence is evidence about a narrow event class and **never** about progress.
    Measured the same day: an orchestrator reported *"no state change"* while five events, a completed
    worker and a passing gate sat unread — it had asserted from memory one read-cycle behind a reading
    that was about to arrive. Say the instrument sentence, or **re-read and then say the world one**.
    **A watcher has TWO failure modes, and the second is invisible from inside: never armed, and
    OUTLIVING ITS TRIGGER.** A watcher aimed at an event that can no longer occur **reads as coverage and
    is worse than none** — the process table shows it alive and the seat that armed it remembers arming
    it. When a decision cancels the event a watcher waits on, stand it down **in the same act**. (Earned
    2026-08-06: an orchestrator did exactly this, unprompted, the moment a ruling cancelled the recompile
    its standby watcher was waiting for.)
    **And ASK the negative, explicitly — it is the question that produces gaps.** *"Which tier's watchers
    did you NOT re-arm?"* A handoff reporting what IS armed produces a list; a handoff required to name
    what is not armed produced, in one answer: a run's live surface that had **died mid-run** and was
    found only in the post-run audit, and a worker-liveness tier that had **never been armed**, leaving
    the daemon both the supervised thing and the sole watcher of its own workers.
12. **Check which QUANTIFIER the claim uses before quoting a derivation for it.** "The path is N" needs a
    maximum; *"both chains"*, *"the only consumer"*, *"exactly one owner"* need an ENUMERATION — and a
    max-with-tie-break silently answers the first question when you asked the second.
13. **Derive mechanically; hand-derived sets are wrong.** Prefer the real parser's output over a
    re-implementation, and a property over an enumeration. State what the mechanism cannot establish.
    **And make every instrument PRINT WHAT IT ACTED ON.** A tool that does not name its target cannot be
    caught answering about the wrong thing: a dry-compile helper that silently ignored its path argument
    returned the same verdict for two different files, and a seat read one answer as two results and
    concluded both forms were valid. The tell is unavailable unless the tool volunteers it. Corollary —
    an instrument that takes an input must be handed a DELIBERATELY BAD one before its clean runs are
    worth anything (rule 11 applied to tools, not just to gates).
14. **A unit is not a measurement.** A configured timeout is a KILL CEILING, not a duration — never compare
    it to a wall clock or quote it to an operator as an estimate.
15. **Verify through the path that LOADS, not the path you edited.** Mirrored trees and symlinks mean your
    check can confirm a shadow copy; `sed -i` on a tracked symlink silently replaces it with a regular file.
16. **Never edit a script with a live instance** — bash reads by byte offset, so even a comment-only
    insertion corrupts the running process. Cancel, edit, syntax-check, re-arm, in that order.

**Propagation**

17. **A confirmed single-site or single-axis miss is a CLASS, not an instance.** Re-run the same sweep shape
    on every sibling; ask what other dimension the fixtures hold constant. **A ruling that fixes one
    instance of a class it just defined is incomplete by construction** — the sweep is part of the ruling.
18. **When a boundary moves, every clause referencing the old boundary moves with it.** Neither clause ever
    looks wrong alone, so single-clause review cannot catch this class. Disambiguate any term used at two
    levels.
19. **A METHOD GUARD found by one seat must be promoted to where every seat reads it, in the same pass that
    reads it.** Otherwise it is re-earned at full price — and the second earning is worse, because by then
    the wrong answer carries a citation.

**Authority**

20. **Open the file the instruction is about, even when the instruction comes from above.** A ruling reads
    as settled, and that is exactly when it goes unchecked. Overseer rulings are wrong at roughly the rate
    of everyone else's.
21. **State the verification standard alongside the instruction**, or the defect appears at the seam.
22. **An overclaimed self-criticism is the least-audited sentence you will write** — a harsh line invites no
    check, so it ships unverified. Including in a section like this one.
23. **A pre-commitment needs a TRIGGER and a SUBJECT SET. Naming only the trigger is a live hazard.**
    A bound was rewritten mid-mission to make its CONDITION mechanically checkable — and that rewrite was
    already the product of one near-miss. It was **still** incomplete: a third task later parked with
    **both halves of the condition present**, and the bound did not apply, because that task was not in
    its subject set. A seat reading only the trigger would have closed the milestone on a task the
    pre-commitment was never about. **State both: what fires it, and what it is ABOUT.** A correct trigger
    with an unstated subject executes on the first thing matching its shape, carrying the authority of the
    decision it was written for.
24. **A REMEDIATION is believed where a guard would be drilled.** Rule 11 says a guard whose failure is
    silence needs a positive control. **Nobody applies that to a FIX**, because a fix is not an
    instrument — so a shipped remediation is remembered as coverage and never re-read. One was recalled as
    *"the reaper shipped in v1.78"*; its own changelog said it reaps only what a helper **tracks**,
    *"without a broad migration"*, and measurement found the untracked majority behaving exactly as it had
    been left. **Ask of any remembered fix: what did it actually cover, in its own words, at the time?**
25. **The fabrication lives in the INDEX line, not the body — and the index is what everyone loads.**
    In that same case the memory body said *"expect regrowth until the product fix ships."* The one-line
    summary said *"reaper shipped."* **The accurate body was never opened, because the index had already
    answered the question.** Audit index and summary lines against the bodies they point at; a compression
    that drops a qualifier is indistinguishable from a fact.
