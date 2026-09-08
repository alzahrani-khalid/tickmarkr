```
       ▄▖
     ▄█▀
▗▄ ▄█▀             tickmarkr
 ▝█▛               spec in, verified work out.
```

# tickmarkr

**Assertions are free. Tickmarks are earned.**

tickmarkr is a spec-driven orchestration harness for AI coding agent CLIs. You write a spec with
acceptance criteria; the engine routes tasks to the best installed agent CLI (claude-code, codex,
cursor-agent, opencode, grok, pi, kimi) by cost and capability, dispatches work in git worktrees for
change isolation — as interactive TUIs when running under [herdr](https://herdr.dev), headless
subprocesses otherwise, or in [Orca](https://onorca.dev) terminals when auto detects both Orca
markers (name that driver explicitly outside one) — and independently verifies each committed
result by checking for no new
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
tickmarkr report <runId> --md  # Markdown on stdout; redirect to save beside the spec
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

`tickmarkr ui [runId]` opens one cockpit with **1 Home, 4 Run, 5 Evidence**. Without a
run ID it selects the latest journal; an empty repository opens Home. Use
`tickmarkr ui <runId> --view run` or `--view evidence` to open a delivered view directly.
`tickmarkr ui --setup <runId>` opens Run Parks and preserves the requested run identity.
Fleet/Bootstrap and Plan/Health are explicit follow-ons: keys 2/3/6 are not installed.
Use the existing `tickmarkr fleet`, `tickmarkr init`, `tickmarkr plan` and `tickmarkr doctor`
commands for those workflows.

`?` opens the shortcut sheet; Tab/Shift-Tab move focus through visible regions, Enter opens
selection, and Esc closes the deepest overlay. `q` quits; text-entry mode keeps `q1?`
literal. Run shows every task in the matching graph, its recorded attempt/path/pane/alarm,
and current-attempt gate evidence. `o` requests focus of the recorded owned pane when the
driver supports it; unavailable panes leave an evidence diagnostic. Evidence keeps original
journal `#L` identities, full verdict paging, and a stable selection with Follow off.

```bash
tickmarkr status <runId>        # preserved printed engagement state
tickmarkr status <runId> --oneline # compact snapshot, then exit
tickmarkr status <runId> --watch # TTY: Run cockpit; non-TTY: line output
tickmarkr status <runId> --watch --plain # preserved line/ANSI fallback, including on a TTY
tickmarkr resume <runId>       # continue an engagement from the local execution log
tickmarkr approve <runId> <taskId>   # append permission for a non-gate park; see below
tickmarkr report <runId>       # cost/quality report
tickmarkr report <runId> --md > feature.record.md # explicit file write beside your spec
tickmarkr profile              # show the learned routing profile
tickmarkr profile --explain <shape> <channel>  # why a channel ranks where it does for a shape
```

For machines, `tickmarkr status <runId> --watch --events` replays and follows projected
decision events as one JSON document per stdout line. `--jsonl` and `--decision-events`
are aliases; keep stderr keepalives separate (never `2>&1`). This projection is distinct
from raw `journal.jsonl`. Webhook delivery remains opt-in via `--webhook <url>`.
Preserved printed twins also include separate `fleet --print` and `fleet --why` outputs,
`plan`, `doctor`, `report --compare <baseline-runId>`, `report --bundle <path>` (an explicit
proof-bundle write), and `stats` (all runs, no run ID). Report retains its learning preview
and comparison warnings; absent metering stays “not measurable,” never an invented $0.

A manual cockpit keeps its final receipt at run-end and follows a later resume of that run.
By default, the daemon-owned board requests graceful shutdown at run-end and closes only its owned pane
after checking its watch presence stood down; unconfirmed cleanup is reported. The existing
`visibility.keepPanes: forever` debug override preserves panes. Herdr keeps
task/gate grouping, short titles, and the board beside its caller without taking focus.
Quitting or orderly signals restore raw mode, pointer tracking, title and alternate screen,
and release only that observer's presence. Green tasks land on `tickmarkr/<runId>`;
merge to your mainline is always your call.

### Escalation and consults

When gates or tasks stall, tickmarkr escalates to a frontier-model consult for a structured verdict.
The consult can recommend rerouting (exclude a failed channel/adapter and try the next ranked option)
or human approval if deadlock persists. Exclusions persist across resume — a task that escalated
away from a failing adapter will never retry it in subsequent `tickmarkr resume` calls.

### Approving tasks

The recorded partial-human-park case has **1/3 merged**, human T2, blocked T3, and a
passed tip verify. It is **PARTIAL**, not green: T2's `humanGate: true` parks it **before
dispatch**. In Run (`4`, or `tickmarkr ui --setup <runId>`), select T2, press `a` for
Actions, choose Approve with Enter, and review the confirmation: run/task, original park
`#L`, actor/reason, exact `tickmarkr approve` argv, append-only consequence and enactor.
Only `y` confirms; `n`/Esc cancel, and Enter never confirms.

Read the receipt's newly appended `task-approved` line, actor/reason and disposition back
from the journal. Approval records permission; it does not dispatch work, pass a gate or
mark the task done. With no live owner the receipt says **approved; resume required**.
Exit the observer and run `tickmarkr resume <runId>` explicitly. A matching live daemon
can enact the release at its next task boundary; a different live run must end before this
one resumes. Keep any resume refusal and its remediation visible, including a deny/prefer
config conflict; repair the source/config as directed, never edit the compiled graph to
force success. After resume, CURRENT TIP is PENDING until fresh evidence arrives. Completion
requires the latest run-end, a nonfailed known tip result, and empty `failed`, `human`,
`blocked` and `pending` buckets; the completed case has 3/3 recorded merges. An unrelated
graph says “not comparable” and supplies no borrowed denominator. Historical GATES RAN
does not establish current completion.

The CLI twin for the same decision is
`tickmarkr approve <runId> T2 --by operator --reason 'ready to proceed'`, followed by the
receipt check and explicit resume above. Other parks have different permitted decisions:

| Park | Decision and effect |
|---|---|
| Human gate / other non-gate park | Plain approve records permission to dispatch. |
| Attempt cap | Plain approve grants a fresh attempt budget; prior routing exclusions remain. |
| Infrastructure | Plain approve or `--recheck`; recheck reruns the declared battery and satisfies no gate. |
| Failed review gate | `--waive` satisfies only that identified gate; `--uphold` funds one fixed attempt carrying findings; `--recheck` reruns the battery. |
| Other failed gate | `--waive` or `--recheck`; plain approve refuses. |
| Tombstone / gate failure without identifying evidence | Diagnostic only; no invented decision. |

Decisions are append-only and cannot be undone. Unknown tasks, duplicate decisions and
changed parks refuse; no success receipt is claimed without reading back the append.

### Help and recovery

`tickmarkr ui --help`, `tickmarkr eval --help`, `tickmarkr unlock --help` and
`tickmarkr profile reset --help` print guidance without opening a UI, seeding fixtures,
unlocking or resetting history. Help flags are recognized before `--`; arguments after
it are literal data. Help examples describe operations; printing them never executes them.

Recovery remains explicit: `unlock <runId>` targets a matching provably dead lock;
`unlock --garbage` handles malformed lock bytes without inventing a run ID. Both require
confirmation (`--yes` for non-TTY) and refuse live, inaccessible or changed holders.
`doctor --cached` reads cached diagnostics; `doctor --probe-preflight` discloses probe
counts/files; `doctor --fix-only` repairs locally without model probes or catalog refresh.
Default doctor and `--fix` still probe. `doctor --refresh-catalog` refreshes only the catalog.
`scope <intent-file> --preview` is a local, non-writing preview; authoring requires TTY
confirmation or `--yes` and can make model calls.

## Choosing your fleet: `tickmarkr fleet`

Configure which agent CLIs and models tickmarkr may route before your first run:

```bash
tickmarkr doctor          # probe auth + capabilities (run after install or credential changes)
tickmarkr fleet           # interactive fleet browser (requires a TTY) — review diff to write
tickmarkr fleet --print   # effective fleet state (repo > global > defaults), non-interactive
tickmarkr plan            # lint the resolved routing table against your spec
tickmarkr run             # dispatch with the fleet you confirmed
```

`tickmarkr doctor` probes and records health; `tickmarkr fleet` edits routing config. The browser is one
two-pane surface: the left rail lists views (**All models**, **Shapes**, **Steering**) and every
installed agent CLI with its auth state and model count; the right pane is a searchable model list
with tier, context, price, and probe-latency columns. `Space` allows/denies, `Enter` classifies an
unclassified model (with a required benchmark-provenance note) or pins a classified one to a shape,
`m` opens the routing-mode presets, and `w` renders the unified diff of your repo config overlay.
Nothing is written until you confirm the diff with `y`; quitting leaves config unchanged. The
Shapes view pins from a candidate picker ranked by the production router.

Routing-mode semantics, pin/floor/prefer precedence, review and consult steering syntax,
provenance rules, and `--quality` / `--mode` flags are documented in
**[FLEET.md](https://github.com/alzahrani-khalid/tickmarkr/blob/main/FLEET.md)** (advanced reference).

## Steering

The fleet browser's **Steering** view sets `review.prefer` and `consult.prefer`; routing modes
(`risk-based`, `partner-led`, `staff-led`) are applied from the presets overlay (`m`). Full
grammar — including when review
prefer may name a **bare adapter** versus `adapter:model`, and why consult prefer entries
require **`adapter:model`** form — plus `tickmarkr run --supersedes` rerun control, is in
**[FLEET.md](https://github.com/alzahrani-khalid/tickmarkr/blob/main/FLEET.md)**.

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

### Orca: a detected-or-named execution surface

[Orca](https://onorca.dev) is the third execution surface. `auto` resolves herdr first when
`HERDR_ENV=1`, then Orca only when both Orca-authored markers `TERM_PROGRAM=Orca` and
`ORCA_TERMINAL_HANDLE` are present, then subprocess. This environment-only choice executes no
binary or runtime probe. Outside an Orca terminal, name it explicitly with `--driver orca` or
`driver: orca` in config. Once selected either way, an unreachable Orca stays a loud Orca driver
failure and is never silently replaced by a hidden subprocess worker.

What Orca supplies is terminals. What tickmarkr keeps is everything that decides whether work
ships: **it creates and owns the git worktree** for every task (Orca is told which checkout to bind
its terminal to, and never makes one), **it runs the full gate battery** — build, test, lint,
evidence, scope, acceptance, review — against the commits that land there, and **it holds merge
authority**, consolidating only green tasks onto the run's `tickmarkr/<runId>` integration branch.
Orca is given no say over any of the three. Merging that branch to your mainline remains your call,
exactly as with every other driver.

tickmarkr borrows audit-firm vocabulary for its roles: **you** are the *Partner* (final sign-off),
workers are the *field team*, the acceptance judge is the *EQR* (engagement quality reviewer), and
the frontier-model consult is the *National Office*. The terms below use that vocabulary:

### Tab vocabulary

- **`<taskId>`**: one tab per TASK. A task's worker pane and every gate pane it earns — judge, review,
  consult — live together in that task's tab, so everything happening to one task is in one place. The
  tab header shows the task token plus one state glyph:
  - ↻ — the member is a retry attempt (attempt > 0)
  - ✋ — the driver detected the member is blocked
  - (bare token) — member is running normally
- **cleanup · <taskId>**: overflow/teardown generation tabs. When a new generation starts (on retry escalation), a new cleanup tab
  opens labeled with the newest live member's task ID; it auto-closes when the generation completes
- **watch**: a single owned pane running `tickmarkr ui <runId> --view run` — the same Run cockpit opened by TTY `status --watch`

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

Tabs use short human labels (at most 20 characters); panes carry durable ownership names:
- `<taskId>` — the task's tab, holding its worker and its judge/review/consult panes
- `cleanup · <taskId>` — teardown generation tab for overflow attempts
- `tickmarkr:watch:run:0:<runId>` — daemon-owned Run board
- `tickmarkr:<role>:<taskId>:<attempt>:<runId>` — durable judge, review, consult and worker pane names; display titles may be shorter

Reconciliation stays within the run's workspace. It can retire another run's panes only
when this repository's journal evidence proves that run ended; live or unknown runs and
other workspaces remain protected. Pane names outside the ownership contract are **foreign**.
Board replacement additionally checks repository/run ownership and its acknowledged watch
presence; matching a short tab label is never sufficient.

**Desired-state reconciliation**: A pure function computes the exact set of panes that should exist from the local journal at any moment:
- Worker panes for all in-flight task attempts
- Gate panes for unread judge/review/consult verdicts
- The watch pane (if running)
- Empty set (after engagement end)

The daemon reconciles at every safe point:
1. **Run start** — reconcile this run and older runs proven ended in this repository
2. **Resume** — reconcile the restarted journal state and close panes for superseded attempts
3. **After terminal events** (task done, failed, human gate) — close the corresponding worker/gate pane and its emptied tab
4. **At engagement end** — close remaining owned panes and tabs, with graceful board shutdown

`visibility.keepPanes: forever` disables this sweep. Reconciliation failures (herdr
unavailable, a pane vanished mid-sweep) do not replace gate verdicts; unconfirmed board
cleanup is journaled and reported.

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

- **[/tickmarkr-loop](skills/tickmarkr-loop/SKILL.md)** — compile a spec, review the routing plan, run the engagement, and commit the Markdown record
- **[/tickmarkr-auto](skills/tickmarkr-auto/SKILL.md)** — autonomous multi-phase runs (GSD milestones, etc.)

These are optional — the CLI works standalone. Skills are repo-scoped and ship in the npm tarball for agents working in projects that have run `tickmarkr init --agent`.
The canonical sources live in `skills/`; this repository's installed `.claude/skills/` links
resolve there. The [overseer skill](skills/tickmarkr-overseer/SKILL.md) links to the same
loop walkthrough for cockpit and decision guidance; skill names remain unchanged.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for development setup, the green bar (build/test/lint), and
design invariants. Pull requests welcome; non-trivial changes should include test coverage.

**Boundaries:** this repo is a squashed export of private development — each release is a verified
snapshot, not a live mirror of every commit. Before tickmarkr 2.0, minor versions may break with every
break noted in [CHANGELOG.md](CHANGELOG.md). Support is best effort for the latest version only;
accepted contributions are credited via `Co-authored-by:` on the release commit. Details in
[CONTRIBUTING.md](CONTRIBUTING.md).

## Documentation

- **[FLEET.md](https://github.com/alzahrani-khalid/tickmarkr/blob/main/FLEET.md)** — routing modes, steering syntax, tier provenance, and run flags (advanced reference)
- **[LICENSE](LICENSE)** — MIT license
- **[CONTRIBUTING.md](CONTRIBUTING.md)** — development setup and contribution guidelines
- **[SECURITY.md](SECURITY.md)** — security policy and private vulnerability reporting
- **[CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md)** — Contributor Covenant
