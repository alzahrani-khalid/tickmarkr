```
              ▄▄████
          ▄▄████▀▀
████▄▄▄▄████▀▀     tickmarkr
  ▀▀████▀▀         spec in, verified work out.
```

# tickmarkr

**Assertions are free. Tickmarks are earned.**

tickmarkr is a spec-driven orchestration harness for AI coding agent CLIs. You write a spec with
acceptance criteria; the engine routes tasks to the best installed agent CLI (claude-code, codex,
cursor-agent, opencode, grok, pi, kimi) by cost and capability, dispatches work in git worktrees for
change isolation — as interactive TUIs when running under [herdr](https://herdr.dev), headless
subprocesses otherwise — and independently verifies each committed result by checking for no new
baseline failures per task, then strictly verifying the integration tip. Green tasks consolidate onto a
`tickmarkr/<runId>` branch; merging to your mainline is always your call, never automated. Engage
with full visibility into routing decisions, worker progress, and gate verdicts — or run headless
and review the local execution log afterward.

Here, **isolated git worktrees** means change isolation: each task gets its own worktree and branch
so its diff is separated from sibling tasks. It is not a process sandbox or host-containment boundary.

## Invariants

These are law; the codebase fails closed around them:

- `acceptance[]` required on every task; compile fails without it
- new engagements consolidate to a `tickmarkr/<runId>` branch — never main
- gates never trust worker claims; each task is checked for no new baseline failures and the merged
  integration tip is strictly re-verified
- state is files + git only; no DB, no services
- worker/judge/review/consult prompts end with machine-parseable trailers
  (structured JSON verdicts); parse defensively, fail closed

Any agent (or human) operating this repo must respect the same five rules above — they are not
merely internal implementation details, they are the contract the gates enforce.

## Install

```bash
npm i -g tickmarkr
```

This installs two identical bins: `tickmarkr` and its short alias `tkr` — use whichever you
prefer, every example below works with either.

**Requirements:**

- **macOS or Linux.** Every command shells out through `bash`, so native Windows is not
  supported — use WSL (untested).
- Node ≥ 20 and `git` on PATH.
- At least one agent CLI on PATH (`claude`, `codex`, `cursor-agent`, `opencode`, `grok`, `pi`,
  or `kimi`), authenticated through its own login. tickmarkr never handles vendor API keys itself.

Then verify your fleet:

```bash
tickmarkr doctor   # probes installed adapters, herdr, auth; prints the capability matrix
```

**Expect `doctor` (and `init`, which runs it) to take a while on first run:** auth detection is
one real, short LLM call per configured model per installed CLI — honest, but not instant. A
machine with three CLIs and several models each can take a minute or more; each probe is capped
at 60s.

`doctor` also sweeps a catalog of known agent CLIs that have no adapter yet and prints an
advisory `detected — no adapter; not routable` row for any found on PATH — a freshly installed
harness is visible the day it lands, and never routed until an adapter ships for it.

## Quickstart (5 minutes)

```bash
tickmarkr init                 # guided setup + doctor; scaffolds config and spec template
# edit tickmarkr.spec.md        # write your tasks and acceptance criteria
tickmarkr compile tickmarkr.spec.md # spec → task graph (fails without acceptance criteria)
tickmarkr plan                 # dry-run routing decisions + cost estimate
tickmarkr run                  # execute, route to best CLI, gate every result (--concurrency N)
tickmarkr report <runId> --md  # engagement record in Markdown
```

That's the flow: `init` scaffolds config, you write tasks with `acceptance[]` criteria, `compile`
validates and builds the graph, `plan` shows routing decisions and cost, `run` dispatches work to
installed CLIs and checks each task for no new baseline failures before strictly verifying the
integration tip, and `report` documents the outcome. All
green tasks land on `tickmarkr/<runId>` — merge to your mainline is your decision.

## Agent-ready repos: `tickmarkr init --agent`

`tickmarkr init --agent` composes with the base `init` above and additionally installs the
consumer-facing skills (`tickmarkr-loop`, `tickmarkr-auto`) that ship in the npm tarball, so a
coding agent working in your repo knows how to drive tickmarkr without reading its source:

```bash
tickmarkr init --agent            # installs .claude/skills/tickmarkr-{loop,auto}, offers CLAUDE.md/AGENTS.md notes
tickmarkr init --agent --force    # also overwrite skill files that already exist
tickmarkr init --agent --docs     # also append the agent-docs section without an interactive prompt
```

Consent rules — every write is additive, never destructive:

- an existing `.claude/skills/tickmarkr-{loop,auto}/SKILL.md` is left untouched unless you answer
  yes to a per-file prompt, or pass `--force`
- a short "tickmarkr" section (the loop commands + the invariants above) is appended to `CLAUDE.md`
  — or `AGENTS.md` if that exists and `CLAUDE.md` doesn't — only after you say yes, or pass `--docs`;
  it's wrapped in `<!-- tickmarkr:agent-docs begin/end -->` markers and never inserted twice
- declining a prompt still lets the rest of `init` complete
- non-interactive shells (no TTY) never prompt: missing skills are installed, everything else is
  skipped, and the summary names exactly what was skipped and which flag would enable it

## Monitor and supervise

```bash
tickmarkr status               # engagement state (--watch to follow live)
tickmarkr resume <runId>       # continue an engagement from the local execution log
tickmarkr approve <runId> <taskId>   # approve a parked task (--reason to document)
tickmarkr report <runId>       # cost/quality report
tickmarkr profile              # show the learned routing profile
tickmarkr profile --explain <shape> <channel>  # why a channel ranks where it does for a shape
```

Green tasks land on `tickmarkr/<runId>`; merge to your mainline is always your call.

### Escalation and consults

When gates or tasks stall, tickmarkr escalates to a frontier-model consult for a structured verdict.
The consult can recommend rerouting (exclude a failed channel/adapter and try the next ranked option)
or human approval if deadlock persists. Exclusions persist across resume — a task that escalated
away from a failing adapter will never retry it in subsequent `tickmarkr resume` calls.

### Approving tasks

`tickmarkr approve` unblocks two task states:

**Human gates** (attempt budget ≥ 1):
- The task finished with a result but gates require human judgment (`humanGate: true` in the spec)
- Approving records the Partner's verdict and the task proceeds to merge

**Attempt-budget exhaustion**:
- The task has burned its full attempt budget without reaching a conclusive result
- Approving grants a fresh attempt budget, routing around all previously-failed channels and adapters

## Choosing your fleet: `tickmarkr fleet`

`tickmarkr doctor` is a pure sensor; `tickmarkr fleet` is the actuator. It walks six steps —
probe data, agent CLIs, model tiers, routing mode, shape routing with a candidate picker, and
steering preferences — and ends in a unified diff of your config overlay that is written **only
on explicit confirm**. Pressing Enter through every step writes nothing. Assigning a tier to a
model that has no classification yet requires a typed benchmark-provenance note, stored as a
config comment beside the assignment.

The shape routing step (step 5/6) features an **arrow-driven candidate picker** that ranks
available channels by the production router's own logic, showing economics (tier + channel
cost signals for API and sub channels) and the router's rationale for each rank. This replaces
typed pin entry with verifiable suggestions. Step 4/6 shows an estimated spend context line
across all shapes under each routing mode's resolved floors, also derived from the same preview
routing machinery.

```bash
tickmarkr fleet          # interactive editor (requires a TTY)
tickmarkr fleet --print  # effective fleet state (repo > global > defaults), non-interactive — good for CI drift checks
```

Routing obeys a strict precedence — **pin > prefer > floors > marginal-cost auto**:

- **pin** a shape to an exact channel: `map: { plan: { via: claude-code, model: fable } }`
- **prefer**-rank adapters per shape: `map: { implement: { prefer: [cursor-agent, codex] } }`
- **floors** set the minimum capability band per shape (`migration: frontier`, `tests: cheap`);
  auto-routing then picks the cheapest authed channel at or above the floor
- **deny/allow** bench models or whole adapters without touching tiers (see `deny.models` below)
- **tiers** classify models into bands — only classified, doctor-authed models ever route

More levers, all optional and absent-safe (absent config keeps default behavior):

- `routing.explore` — fence the exploration budget: `mode: off`, `excludeShapes`,
  `excludeComplexityAtOrAbove`, and a per-channel `cap`; `run --no-explore` disables
  exploration probes for a single run
- `tiers.<adapter>.windows` — declare context-window sizes per model; doctor grows a window
  column and `plan` warns (advisory, never blocking) when a task's payload estimate exceeds
  the routed model's window
- `routing.sla` — per-shape latency expectations, surfaced as advisory plan lints against the
  learned performance profile
- `run --quality` — compatibility alias for `run --mode partner-led` for that run; it disables
  exploration and records the selected mode in routing provenance

## Steering: routing modes, reviewer preferences, and reruns

### Routing modes

`routing.mode` is a preset that compiles into floor assignments at config load time. The router never sees the mode itself; it receives resolved floors only.

Three routing modes are available:

- **`risk-based`** (default): byte-identical to pre-v1.51 routing. Absent `mode` key resolves as risk-based.
- **`partner-led`**: resolves every non-overridden shape to a `frontier` floor and disables exploration — use when quality is paramount and cost is secondary.
- **`staff-led`**: lowers each mode default by one tier (e.g., `implement` and `refactor` become `cheap` instead of `mid`) while keeping the preset floor for the integrity set (`plan`, `spec`, `migration`, `ui`) at `frontier`.

Explicit `routing.floors` entries beat mode-preset deltas and are linted during plan if they shadow the mode's delta; an explicit integrity floor below `frontier` is also linted. The mode is compiled once at config load and never consulted during routing.

### Review preferences

`review.prefer` is an ordered list of reviewer seats for the cross-vendor code-review gate. Entries are matched by diversity (never the same vendor or model as the original worker), and routing reorders the available channels only — it does not admit unauthed or denied channels.

```yaml
review:
  prefer: [codex, kimi]           # bare adapter: inherits model from the routed channel
  prefer: [codex:gpt-5.6-sol, kimi:kimi-code/k3]  # adapter:model explicit
  prefer: [codex, kimi:kimi-code/k3]  # mixed: bare and explicit
```

**Grammar**: review prefer entries may name a bare adapter (inheriting the model from the current channel) or an explicit `adapter:model` pair. Bare adapters rank every diversity-eligible channel for that adapter; explicit pairs rank one diversity-eligible channel.

### Consult preferences

`consult.prefer` is a ranked failover list of seats for escalations on deadlock or gate stalls. Unlike review, a consult seat has no channel to inherit a model from, so entries **must be explicit `adapter:model` pairs**.

```yaml
consult:
  adapter: claude-code
  model: fable
  prefer: [codex:gpt-5.6-sol, kimi:kimi-code/k3]   # adapter:model ONLY
```

The daemon walks the preference list to the first live adapter, then the pinned `consult.adapter:model` pair as the final fallback. Failed or unparseable verdicts fall to the next entry.

**Grammar**: consult prefer entries require `adapter:model` form — a bare adapter name is invalid and fails config load. Every entry must declare both the adapter and the model because a consult seat runs independently with no channel context.

### Rerun control: --supersedes

`tickmarkr run --supersedes <prior-runId>` marks the current run as a rerun of a prior engagement. The current task graph is used for the rerun; compile it fresh first if the spec changed. The prior runId is recorded in the new journal, and the prior journal records the successor, for audit trails and change attribution.

Use this when you modify the spec or worker logic and want to mark an intentional rerun while preserving the relationship in both run journals.

## Model scoping and auth detection

Each agent CLI exposes a list of available models. tickmarkr's routing works only with **classified** models — those you explicitly enter into the config under `tiers`. The `tickmarkr doctor` command probes these models to detect auth status and records the results, which routing consumes to avoid 401/403 dispatch failures.

**Model terminology**:

- **Listed models**: All models a CLI advertises as available (e.g., pi advertises both `zai/glm-5.2` and `anthropic/claude-opus-4-8`, but not all are authed)
- **Scoped models**: Listed models with an explicit provider prefix (e.g., `zai/glm-5.2`, `zai-coding-plan/glm-5.2`). The design rule is to classify scoped models primarily, not unscoped listed models
- **Classified models**: Models you've entered into `tiers` — the routing-eligible set, regardless of scope

When you run `tickmarkr doctor`, it:
1. Probes each classified model exactly once (one minimal headless API call per model per adapter)
2. Records results locally: `authed: true` or `authed: false` with the failure reason and probe timestamp
3. Prints a model-status table for classified models only, showing tier, auth verdict, denial status, and prefer rank

**Routing and auth**:
- Routing discovers channels only from authed classified models (unauthed channels are dropped)
- `tickmarkr plan` lints each excluded model, naming the probe reason and timestamp
- If a task's floor can only be satisfied by unauthed models, the plan fails loudly — never a silent fallback

**When to re-run doctor**:
- After classifying new scoped models into tiers (e.g., onboarding a new vendor or aggregator CLI)
- Before a run, if credentials may have changed (API key rotation, quota reset, subscription renewal)

**Operator model control — deny.models**:
You can bench a classified model without removing it from tiers:
```yaml
routing:
  deny:
    models:
      - pi:zai/glm-5.2            # stays in tiers, never routes (key is adapter:model)
      - cursor-agent:composer-2.5 # reason in git commit
```
`tickmarkr plan` lints denied models identically to unauthed ones. Re-enable by deleting one line.

## Run output and local execution log

When you execute `tickmarkr run`, the daemon records every event in an append-only local journal:
task dispatch, gate verdicts, worker status, and merges. Narration streams to stdout; you can also
`--watch` or tail the journal directly. If interrupted, `tickmarkr resume <runId>` replays the journal
and continues from the last stable state — deterministic, not ephemeral.

## Usage and cost

Every engagement record includes a **Usage & efficiency** section showing token/window consumption, cost estimates,
and first-attempt success rate. Cost reporting follows strict honesty rules and never infers absent data:

### Cost model — two channel economics

**API channels** (real marginal cost):
- Formula: `tokens × price`
- Pricing data sourced from [LiteLLM model prices](https://github.com/BerriAI/litellm/blob/main/litellm/model_prices_and_context_window.json)
- Each estimate carries its basis: input tokens, output tokens, cache reads (if applicable), rate per Mtok, and rate date

**Subscription channels** (flat monthly, no marginal token cost):
- Two metrics reported when computable:
  - **Amortized window cost**: `plan monthly cost ÷ usable windows per month` — a range accounting for time-varying quotas
  - **API-equivalent counterfactual**: `metered tokens × API price of the same/nearest model` — e.g., a $100/month Claude Max user
    who consumes tokens worth $500 API-equivalent has paid $500 API-equivalent for flat $100
- Both metrics appear in the report alongside their sample count and range bounds

### Honesty rules (no guessing allowed)

- **Ranges, never single numbers**: quota multipliers and monthly-window variation make subscription costs a range, not a point estimate
- **"Not measurable" never becomes $0**: if a channel lacks pricing or metering data, the report explicitly states "not measurable"
- **Basis always shown**: every cost figure prints the token count, rate used, and date so estimates can be audited
- **No network calls**: pricing config is operator-maintained locally, seeded with dated
  comments and LiteLLM's JSON file named as the copy-from source; tickmarkr never calls home to fetch rates
- **Attribution from journal**: token counts come from tickmarkr's own telemetry spans in the local journal, never from provider invoices or dashboards

## Visibility: optional supervised workspace

When running under [herdr](https://herdr.dev), tickmarkr creates a labeled pane-and-tab workspace
for real-time visibility (optional — omit `--driver herdr` or run headless if preferred).

tickmarkr borrows audit-firm vocabulary for its roles: **you** are the *Partner* (final sign-off),
workers are the *field team*, the acceptance judge is the *EQR* (engagement quality reviewer), and
the frontier-model consult is the *National Office*. The terms below use that vocabulary:

### Tab vocabulary

- **WORKERS**: the primary generation tab showing active field-team tasks. The tab header shows a live token (task ID) plus one state glyph:
  - ↻ — the member is a retry attempt (attempt > 0)
  - ✋ — the driver detected the member is blocked
  - (bare token) — member is running normally
- **cleanup · <taskId>**: overflow/teardown generation tabs. When a new generation starts (on retry escalation), a new cleanup tab
  opens labeled with the newest live member's task ID; it auto-closes when the generation completes
- **watch**: a single pane running `tickmarkr status --watch` — the senior's glanceable engagement monitor

### Pane naming (when visibility.llm = pane)

- **judge · <taskId>**: the EQR evaluating acceptance criteria
- **review · <taskId>**: the cross-vendor code review gate
- **consult · <taskId>**: National Office escalation on deadlock (gates or worker stall)

### Notification tiers

Only operator-decision events notify (with sound):

- ✓ Gate failure escalations (move to next channel, human approval needed)
- ✓ National Office verdicts (deadlock resolved or escalation recommended)
- ✓ Human gates (task parked, awaiting `tickmarkr approve`)
- ✓ Quota failover (channel exhausted, routed to next)
- ✓ Engagement end (unqualified or qualified opinion)

Routine events do NOT notify:
- ✗ Task dispatch (tab already shows progress)
- ✗ Task done (tab state updated, already visible)

This keeps the Partner focused on decisions that require attention, not noise.

### Reconciliation model: level-triggered pane lifecycle

tickmarkr closes exactly what it owns and no longer needs, no matter how any process died.

Every pane and tab tickmarkr creates receives a **parseable ownership name** encoding the pane's role, task, attempt, and run:
- `WORKERS` — active worker generation tab
- `cleanup · <taskId>` — teardown generation tab for overflow attempts
- `watch` — status monitor pane
- `<role> · <taskId> · A<attempt> · R<runId>` — judge, review, consult, and worker panes (formats like `judge · task-abc123 · A1 · Rrun-20260713-175532`)

tickmarkr creates all owned panes only within the run's workspace; any tickmarkr-owned panes discovered outside the run's workspace (from prior runs or placement bugs) are reconciled and closed. Any pane not matching the ownership contract is **foreign** — created by you or another tool — and is never closed automatically.

**Desired-state reconciliation**: A pure function computes the exact set of panes that should exist from the local journal at any moment:
- Worker panes for all in-flight task attempts
- Gate panes for unread judge/review/consult verdicts
- The watch pane (if running)
- Empty set (after engagement end)

The daemon reconciles at every safe point:
1. **Run start** — clean up any orphaned panes from crashed earlier runs of the same repo
2. **Resume** — reconcile the restarted journal state and close panes for superseded attempts
3. **After terminal events** (task done, failed, human gate) — close the corresponding worker/gate pane and its emptied tab
4. **At engagement end** — close all remaining owned panes and tabs

Reconciliation failures (herdr unavailable, a pane vanished mid-sweep) never fail the engagement — visibility is cosmetic, gates are law.

### Workspace trust

tickmarkr creates fresh git worktrees for change isolation. That is separate from each CLI's own
workspace-trust behavior:

- `tickmarkr doctor` invokes each installed adapter's trust hook where supported and seeds trust where possible
- Some CLIs show a "Workspace Trust" dialog; tickmarkr auto-answers only a recognized fingerprint once per slot
- Other blocked dialogs page you for manual approval

## Spec formats

tickmarkr compiles several formats into its internal task graph. The most common:

| Format | Example |
|---|---|
| **tickmarkr native** (default) | `tickmarkr init` template with native spec marker |
| **Markdown PRD** | Any `.md` file with task sections and `acceptance[]` criteria |
| **Spec Kit** | A [Spec Kit](https://github.com/github/spec-kit) spec directory |
| **GSD** | A GSD `.planning/` phase plan |

Compile fails loudly if it cannot recognize the format or if `acceptance[]` is missing. Use
`--type native|prd|speckit|gsd` to force a specific format.

## Acceptance criteria (assertions)

Every task requires explicit `acceptance[]` criteria; compile fails without them. Three oracle types:

- **`command <cmd>`** — pass if exit code 0; most reliable
- **`test <name>`** — run a named test from your suite (must exist)
- **`judge <rubric>`** — LLM verdict against your rubric; fail-closed, never overrides failed command/test

At runtime, the **scope gate** derives `git diff --name-only` from the task base and compares it with
the spec-declared files. Out-of-scope edits fail unless the operator config explicitly allowlists
them; worker-declared deviations are recorded as notes, not authority.

## Claude Code integration

If you clone this repo and use Claude Code, project skills are installed in `.claude/skills/`:

- **`/tickmarkr-loop`** — compile a spec, review the routing plan, run the engagement, and commit the Markdown record
- **`/tickmarkr-auto`** — autonomous multi-phase runs (GSD milestones, etc.)

These are optional — the CLI works standalone. Skills are repo-scoped and ship in the npm tarball for agents working in projects that have run `tickmarkr init --agent`.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for development setup, the green bar (build/test/lint), and
design invariants. Pull requests welcome; non-trivial changes should include test coverage.

**Boundaries:** this repo is a squashed export of private development — each release is a verified
snapshot, not a live mirror of every commit. Before tickmarkr 2.0, minor versions may break with every
break noted in [CHANGELOG.md](CHANGELOG.md). Support is best effort for the latest version only;
accepted contributions are credited via `Co-authored-by:` on the release commit. Details in
[CONTRIBUTING.md](CONTRIBUTING.md).

## Documentation

- **[LICENSE](LICENSE)** — MIT license
- **[CONTRIBUTING.md](CONTRIBUTING.md)** — development setup and contribution guidelines
- **[SECURITY.md](SECURITY.md)** — security policy and private vulnerability reporting
- **[CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md)** — Contributor Covenant
