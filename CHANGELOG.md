# Changelog

This changelog documents breaking changes and major releases. **For per-release details, see [GitHub Releases](https://github.com/alzahrani-khalid/tickmarkr/releases).**

## v2.4.1 — the records tell the truth

**v2.4.1** — a patch release with no new adapter, driver or design row: the rows the daemon writes say what the
adapter decoded and the stream it decoded is on disk, the drivers name what they close, the CLI's diagnostics name
the lock and the seats, a refused compile cannot be run on hope, the gates tell a starved host from a red through one
classifier on both sides, the fleet says what each catalog leg did, a qwen worker turn costs what the worker needs,
and the laws the previous release paid for are installed in the overseer skill with its grader shipped beside them.
Delivered by one gated run (9/9 green at width 1; halted and resumed seven times — two contention parks, one
config-drift stop, three `files[]` amendments and one review-ceiling halt, each a recorded ruling) with a
cross-provider review on every task, followed by a post-run frontier re-review of the three tasks whose only
approval had come from a Gemini seat: it found four material defects behind two of those approvals, and they were
corrected on a fix branch gated round by round (`verify --base <previous tip>`, non-Gemini review) before the merge.

- **The worker-result row says what the adapter decoded.** The cause comes from the adapter's own parse
  (`startup-failure` is a cause), a trailer decoded from a JSON envelope reads `finished: true`, the decoded stream is
  persisted under the run's `prompts/` and named by the row's `stream` field, a stall-timeout harvest terminates the
  worker's process group before it reads the tree, and a superseded attempt's pane is reconciled. (T1)
- **Drivers name what they close and bound what they hold.** A worker close journals `pane-close` with the slot and
  the pane or tab it held; an Orca projection older than the pending grace is dropped and journaled `project-unplaced`;
  `describe`'s type names the absence it can return. (T2)
- **CLI diagnostics name the lock, the seats and the reason.** `doctor` reports a qwen failure by the adapter's decoded
  API error, not the tail of its event stream; `plan` prints the judge and review seats each task will spend on and
  bills them in the footer; `init` and `status` derive "active run" from the lock, so an abandoned run with no run-end
  row no longer reads live; the status stream's exit sequence is flushed before the process ends. (T3)
- **A refused compile cannot be run on hope.** A refused compile leaves no runnable graph behind and `run`/`plan`
  compare the graph's recorded spec-and-config hash with the tree; authoring lints are structured rather than
  reverse-parsed from their own prose; a malformed `config.yaml` fails the overlay gate closed; the fence lint reads
  the checkout once. (T4)
- **The gates know a starved host from a red.** One classifier serves the daemon and `verify`; a test verdict whose
  fresh failures are all timeout-class at twice the baseline's duration waits for a calm window and reruns once before
  any repair is charged; a tail-birpc-only exit 1 is infrastructure on both sides; reap errors surface. (T5)
- **Fleet truth: what each catalog leg did.** Each leg persists on its own success with one stated retry policy;
  `doctor` and `fleet` print the leg line on every refresh; `fleet` forwards its fetcher and clock so a failed refresh
  is not retried inside the same command; a repo with no cache file auto-refreshes. The post-run re-review corrected
  four defects here: the vendored snapshot is never written to the cache as fetched (models.dev is the spine), a keyless
  Artificial Analysis leg no longer pins the catalog stale forever, an all-legs-failed refresh reports itself, and a leg
  fetched then discarded is reported as discarded, never as updated. (T6 + Leg-2)
- **A qwen worker turn costs what the worker needs.** The headless form runs under `--safe-mode` — 17.8k input tokens
  for a one-word prompt against 59.5k with the operator's global configuration, the same sixty-four tools — the
  API-error marker is found inside any text block, and the replay fixtures ship with the package. (T7)
- **Routing, consult and version hygiene.** One provider-identity function serves routing and review; consult's
  excluded provider comes from the task's own dispatch; the codex adapter passes the prompt on stdin, not in argv;
  `version` prints the build identity beside the semver so a patched local build cannot pass for the published one; the
  export-boundary tests pin their pair structurally. (T8)
- **The laws are installed, and the grader ships.** The overseer skill's checklists carry the release laws that were
  only rulings before; `watch-context.sh` acts only on an idle target with an empty or dim-only prompt line, verifies
  the clear before the re-brief, and (post-run fix) compares the receipt banner-to-banner so a misconfigured window
  cannot fire it early; `grade-ci.sh` ships under the skill's scripts with its two controls as a test; the release
  guide's proof includes lint, grades CI from job logs and re-reads the registry. (T10)

## v2.4 — seen, scored and truthful

**v2.4.0** — the fleet is seen and scored from live catalogs instead of a stamped seed table, the qwen CLI
joins it as a native drive, routing names the blast radius of every deny and prefer entry and scopes bans and
reroutes by the provider that actually served a model, the gate's children are reaped and every gate row says
what it measured, and the release instruments run under the daemon's own rules. Delivered by one gated run
(10/10 green at width 1; halted and resumed five times — once for a classifier fix, four times for `files[]` amendments, each a recorded ruling)
with a cross-provider review on every task.

- **The board and the journal say what the daemon did.** A `task-dispatch` row carries the exclusion set the
  router honoured, a `resume-restore` counts as an enactment, and the status board renders a `prior graph`
  marker on tasks whose gates ran before an audited `--graph-changed` rehash. (T1)
- **The orca driver's capabilities are real and the board projects onto Orca.** `sendKey` maps enter and
  ctrl+c onto the CLI's own verbs and refuses anything else loudly; `nudge` proves idle, submits and reads its
  echo back; the narrator opens a watch terminal and `project` sets the workspace status on the task's own
  checkout; a receipt with no capture is validated by envelope and says so. (T2)
- **Routing truth: blast radius, identity scoping, a ceiling key, seeds.** `plan` prints the seats every
  deny or allow entry reaches, an inert prefer entry per role pool, the review pool's provider breadth, and a
  refusal when a flat deny leaves the judge seat channel-less; fingerprint bans and tried-lists key on the
  provider/model identity so an alias or gateway cannot evade them; `review.timeoutMs` (default 900000) is the
  review ceiling; worker reroute and the stall-consult exclusion are provider-scoped; the seed table gains
  GLM 5.3, Gemini 3.8 Flash, Qwen 3.8 Max and Fable 5.1 with dated sources and window entries. (T3)
- **Authoring lints catch the criteria that cannot be graded.** A preservation-worded criterion citing a
  symbol absent from the task's files, a `mode:` disagreeing with the repo overlay, and an out-of-scope
  implication without a `scope-waiver:` fail compile; `--strict` promotes every lint to an error. (T4)
- **The status surface is stream-clean.** The event stream writes one JSON document per event to stdout and
  its keepalive to stderr, the board's liveness line carries `load1`, and an unbounded watch uses the
  alternate screen while a bounded render never does. (T5)
- **The gate's children are reaped.** A process group still alive two seconds after its shell exited is
  reaped and the shell result carries `reapedGroup: true`. (T6)
- **Every gate row says what it measured.** Gate rows carry `load1Max` and `load1Mean` sampled through the
  gate's duration and `reapedGroup` when the shell result does; the review ceiling reads `review.timeoutMs`
  and its kill row names the configured value; the reviewer picker rotates least-recently-used among eligible
  cross-provider channels and the row names the seat it took; the placement audit asserts the sealed-launch
  property structurally. (T8)
- **Fleet truth: seen, scored, seeded, refreshed.** The evidence join keys on the fleet id's own bare
  suffix, variants collapse to one row per base model, unclassified rows sort by suggestion and fold gateway
  duplicates with a count, and `doctor` and `fleet` refresh the keyless models.dev and LiveBench legs when the
  cache is older than seven days — ten-second timeout, fail-open with one reason line — while `plan`,
  `compile` and `run` never fetch. (T9)
- **The qwen CLI joins the fleet, and every worker launches clean.** A native `qwen` drive delivers the
  prompt file on stdin, passes the approval mode and JSON output, and parses the decoded envelope fail-closed
  (an API error inside an exit-0 stream is a startup failure, never a success); `claude-code` headless
  delivers its prompt on stdin and declares every hardcoded flag; the worker prompt states that no background
  process may outlive the worker and no suite may run beside another; the fable stamp reads
  `claude-fable-5-1`. (T10)
- **The release instruments run where the daemon's rules run.** `verify-export.sh` caps the candidate's
  suite at the daemon's fork cap, the exporter declares its allowlist as data the manifest test reads, and a
  repo test scans every test file for reads of export-excluded roots and demands a named skip guard or an
  allowlisted reason. (T11)
- **Compile lists its lint corpus once.** The fence lint resolves each task's `files[]` from one `git ls-files` per
  compile instead of walking the whole checkout per task (dot-directories included), and the ownership pass indexes
  `src/` once per pass — the committed-spec corpus compiles in under 4 s where the merged run took 35 s. Found by the
  release's own merged-main suite; the run's worktree-hosted gates could not see it. (OBS-898, post-run fix)
- **The qwen drive reads the stream the daemon actually hands it.** The parser locates the JSON event array inside
  the captured worker stream (the launch banner before it, the driver's interleaved stderr, the exit marker after it)
  instead of assuming the bare array, and a no-auth `error_during_execution` result names its `error.message` as the
  startup-failure cause. Found by the release's live qwen probe: a real completion had read as unparseable and merged
  only through the harvest path. (OBS-903, post-run fix)
- **A qwen worker never carries its prompt in argv.** The drive has no interactive form: under every driver the
  headless command runs (prompt on stdin, JSON events out) in the worker's pane, like omp's, so the same parser reads
  every transcript. The pane shows the launch and the final event stream rather than a live TUI. Found by the live
  probe under the herdr driver. (OBS-905, post-run fix)

## v2.3 — orca, detected and complete

**v2.3.0** — tickmarkr detects the Orca terminal and drives it end to end, the daemon's escalation ladder
charges only what ran, and every instrument that speaks for a run — doctor, init, plan, compile, verify, the
visible consult and the supervision scripts — says what actually happened. Delivered by one gated run
(10/10 green; halted and resumed once at width 1, no spec amendment) with a cross-provider review on every task.

- **`auto` resolves herdr, then orca, then subprocess.** Inside an Orca-spawned PTY (`TERM_PROGRAM=Orca` with
  `ORCA_TERMINAL_HANDLE`) the driver is orca; the sealed worker env carries neither the herdr nor the Orca handle,
  so a worker can never inherit host identity. (T1)
- **The orca driver's lifecycle matches the installed Orca.** A fresh checkout is adopted before a terminal is
  bound, the read leg uses the screen rather than the fragmenting stream, and a `screen-unavailable` read answers
  `unknown` instead of guessing; the fake-orca fixture replays the refused-then-adopted and screen-unavailable
  sequences. (T2)
- **The ladder charges what ran.** A recheck of any park kind runs the whole declared battery on the parked
  commit before a worker is bought, and the daemon's five riders are journaled. (T3)
- **Doctor names hook coverage and the lever, renders a probe error, and beat resolves the root.** The orca row
  says which adapters Orca has status hooks for and names the install lever, a probe-error row renders its
  errno, and `beat` resolves the repository root from any worktree. (T4)
- **The reviewer is shown the task, and a killed or flaked reviewer says so.** A ceiling-killed or startup-dead
  reviewer is classified as such rather than as a malformed verdict, the review gate grades the task's own range,
  and the retry pool excludes what actually failed. (T5)
- **`init` tells the truth and never reverts source.** `init --force` refuses to overwrite tracked source inside
  the tickmarkr repository, the environments footer matches `auto`, and the shipped agent-docs block no longer
  carries this repository's development law into consumers. (T6)
- **The supervision skill's instruments read what they claim.** `seat-send.sh` probes the prompt line before it
  sends and defers on a human draft, the context watcher reads the banner below the input rule for every seat
  kind, and both skill trees are byte-identical by test. (T7)
- **The visible consult is visible.** With `visibility.llm: pane` the consult runs the adapter's interactive form
  in its labelled pane and the verdict is still harvested through the nonce trailer; headless output is
  byte-identical. (T8)
- **`plan` and `compile` tell the truth about a fresh spec.** A fresh `test:` criterion no longer renders as a
  pre-dispatch refusal that hides routing, and the collateral sweep no longer flags a path a task legitimately
  adds. (T9)
- **`verify` tells the truth from any worktree.** State is read from the git common dir, `--task` warns when the
  range carries another task's merge, an exit-127 head fails closed, a verdictless baseline is never cached,
  artifacts are persisted, and `--author` fails over across providers. (T10)

## v2.2.1 — record truth

**v2.2.1** — the run record, the review row, the approval, the baseline and the vendor stamp each say what
actually happened, and the release ritual proves the exported tree before a tag exists. Delivered by one
gated run (7/8) resumed once after a plan amendment (8/8), with a true cross-provider verify on the one task
whose in-run review resolved to the same provider.

- **A channel's vendor is its model's.** The pi adapter no longer stamps one vendor on every channel, so the
  review picker's diversity filter excludes the provider it means to exclude (T2).
- **The review gate says what happened.** A reviewer that returned nothing, timed out, or was failed over to
  another model is recorded as such in the gate row, never as a silent approve (T1).
- **The run record keeps what it knows.** `run-start` carries the driver, dist fingerprint and channel map;
  prompts written over a prior engagement's brief are preserved beside it; `report` reads them back (T3).
- **`approve` tells the truth about who enacts.** The approval record names the seat and the disposition
  the daemon will act on (T5).
- **The baseline tells the truth.** A baseline capture that could not produce a verdict is recorded as
  infra and the gate grades the head absolutely instead of forgiving against nothing (T6).
- **A dead probe is not an unauthed channel.** A model probe that dies on EMFILE or a spawn error keeps the
  channel's last known auth verdict and records the errno; a real 403 still marks it unauthed (T8).
- **Orca on the installed version.** The Orca driver pins fixture 1.4.195 and accepts both elapsed-wait
  transport shapes (T4).
- **The spec template's laws and the release ritual's proofs.** The template states the surface-ownership
  law and the semicolon rule; maintainers run the suite inside the export candidate before a push, from the
  private repo (that tooling is not part of this package); `watch-context.sh` clears only supervising
  roles (T7).

## v2.2 — what a revived worker is told

**v2.2.0** — a released, revived, or re-dispatched task is told the truth about its own state, and the
daemon acts on approvals while it is alive. Delivered by one gated run (6/6) plus true cross-vendor
verifies on the tasks whose in-run reviews turned out to be same-vendor; one of those verifies rejected
and its fix went through the standalone battery before anything reached `main`.

- **`approve` states its disposition before acting.** A plain approve of a gate-fail park refuses instead
  of silently marking the failed gate satisfied; the closed verb set (`approve`, `--waive`, `--uphold`,
  `--recheck`) maps to one disposition each, printed before the record is appended, and the setup cockpit
  offers only the verbs that apply to the park it shows.
- **The live daemon consumes approvals at task boundaries.** An approval accepted while the run is live
  dispatches the released task at the next boundary instead of waiting hours for a resume; run-end records
  `approvalDisposition` (`complete`, or `outstanding` naming the tasks) so an accepted-but-never-dispatched
  approval can no longer hide. The approve command and the cockpit say so — a live run is never told to
  resume; the `deferred-live` status token is unchanged for scripts that parse it.
- **An uphold funds what it claims and a waiver never rides forward** — the replayed satisfied-gate fold is
  pinned at the daemon level: a funded fixed attempt carries the findings; a waived gate does not survive
  into the next attempt.
- **A revived worker is told what the consult prescribed.** A consult verdict that parks a task journals
  its guidance, and the next dispatch of that task carries it in the brief instead of starting blind.
- **A promised context path exists where the worker reads it.** Context entries committed after the base
  are materialized into the run state before dispatch, byte-identical to their committed blobs; an entry
  that resolves to nothing, a traversal segment anywhere in the path, a symlink, or an unreadable ancestor
  is omitted with a journaled `context-missing` rather than aborting dispatch; literal paths containing
  `[`, `]`, `{` or `}` are files, not patterns.
- **Compile lint expands braces before naming directories**, so a `files[]` entry like
  `tests/{run,cli}/x.test.ts` no longer warns about a new top-level directory named `{run,cli}`.

## v2.1 — the orca driver

**v2.1.9** — the record keeps what it knows. The theme is that supervision surfaces stop asserting things
the product cannot know, and a sweep records what it did.

- **A pane sweep records what it closed, what it failed to close, and refuses to close a live seat.**
  Reconcile now journals one event per pane close, each carrying that pane's own id, the owned name parsed
  from its label, and the runId it received; a close that fails is journaled against the pane it was
  attempting, so the path records the action or its failure and never neither. A pane whose label an armed
  supervision beat names is left alone.
- **The spike-scoping rule ships where spec-authoring law already lives** — in the spec template `init`
  writes, rather than only in operator notes.
- **The overseer skill ships the journal watcher it already prescribed.** The bundled watcher now covers
  all four events it told you to watch (`run-end`, `task-human`, `task-failed`, `consult-verdict`) instead
  of prescribing them and shipping none.
- **The context watcher reads context FILL from the session record, not the rendered screen** — and names
  the mechanism: fill and cumulative spend differ by a factor that grows with session length, so a
  cumulative figure read as a percentage misreports a fresh session as nearly full.
- **Void conditions on pre-commitments, a two-reads liveness test for process probes, and a
  rename-replace rule** for editing a watcher script while watchers are armed (a bash script read by byte
  offset is corrupted by an in-place edit, comment-only included).

**v2.1.7** — one answer, everywhere: nine gated tasks on one run, closed green 9/9 with tip verify
passed and every bucket empty. The theme is that the supervision surfaces stopped disagreeing with each
other — one accessor decides what a gate outcome means, every reader routes through it, and the records
a supervisor reads stop asserting things the product cannot know.

- **A task that cannot pass is refused before a worker starts.** Compile now reports cross-task ownership
  collisions — a source file whose dedicated test no task owns, and multi-owned files that are not
  dependency-ordered. It found an unowned test on its first run that two reviewers had missed by hand.
- **One accessor decides what a gate outcome means, and every surface routes through it.** The journal,
  the statistics, the narration and the board derived the same row independently and could drift apart;
  a held selected-test screen now reads as a screen everywhere rather than sharing the word `passed`
  with a full-suite green.
- **A supervision record cannot manufacture a death.** The beat record's process id read dead on a live
  tier essentially always — a one-shot write cannot complete unless the process it names is exiting — so
  liveness is read from beat freshness, and the field says what it is.
- **The watch tier tells the truth about itself**, and a crashed run's own panes are reclaimed again
  without ever reaching another run's: reclamation is authorised by a repository-scoped snapshot of runs
  proven ended, so a cosmetic sweep still cannot close a live worker's pane.
- **The context watcher refuses to guess.** A watcher that cannot read a percentage reports unreadable
  and says so, instead of borrowing a number from scrollback or a fleet counter. It also stopped being
  blind on every real seat: its banner selector required a vendor id at line start and a lowercase name,
  while the rendered line begins with a glyph and reads `Opus`.
- **A teardown RPC timeout is infrastructure, not a regression.** `[vitest-worker]: Timeout calling …`
  is the same fixed-window birpc death the classifier already forgave one layer down. The release gate
  had forgiven this fingerprint since 2026-08-11 while the classifier charged it, so the product billed
  a worker for the failure the release workflow was written to excuse.
  ⚠ Historical journal rows written before the infra stamp existed carry that evidence only in their
  text, and now count as real reds rather than infra reds — a deliberate trade for cross-reader
  agreement, not an oversight.

**v2.1.6** — the harness tells you what it already knows: four gated tasks on one run, closed green
4/4 with tip verify passed and every bucket empty. The theme is that the daemon already held the facts
its operator was guessing at, and now says them out loud.

- **A test-gate red that is infrastructure alone costs the worker no attempt.** Fresh infra failures are
  classified rather than charged, so a machine that ran out of file descriptors no longer spends a
  task's repair budget. Infrastructure signatures now enter the fingerprint diff too, so a signature
  like birpc's assertion-free RPC death cannot collapse to a content-free marker before the fresh-failure
  path can ask the same classifier.
- **An unambiguously dead worker is parked for a human, not waited out.** A dead pane observation is
  confirmed and its process tree reconfirmed before the daemon acts, and the park names the command that
  releases it — replacing a silent stall-timeout with a decision the operator can act on.
- **The preserved ref and the upheld feedback are surfaced where a reader already looks.** Recovery facts
  reach the journal and the status board instead of living only in a worktree nobody opens, and preserved
  diff revisions are quoted so a ref with shell-significant characters survives the round trip.
- **`tickmarkr stats` answers which channel delivers, across every run.** Routing history stops being a
  per-run anecdote.

**v2.1.5** — review-channel parity: the reviewer is shown what the task declared, a reviewer that
says nothing costs nothing, and every suite verdict carries the capacity it was measured under. Seven
tasks, one gated run, cross-vendor throughout; two reached the review cap on real findings and merged
on upheld attempts.

- **The reviewer is shown the scope the task declared.** The review prompt was built without it, so a
  reviewer graded a diff against a boundary it could not see.
- **A review that passes does not drop what it deferred.** A pass carried its material findings and
  discarded its deferrals, which is where "documented limitation" quietly became "closed".
- **A silent reviewer costs no attempt, is named, and cannot grade below the task's floor.** A reviewer
  that returned nothing had been charged to the worker as a failed attempt.
- **The scope lints read the read dependencies a task declared**, so a task that only reads a file is
  no longer told to declare write authority over it.
- **A baseline captured while the machine was starved forgives nothing.** A baseline taken under load
  recorded pre-existing failures that were not pre-existing, and forgave real ones thereafter.
- **A bare run of the suite gets the fork budget every lane already pins**, so an unpinned invocation
  no longer competes with itself for cores.
- **A gate verdict carries the capacity it was measured under, and no reuse crosses a changed one.**
  Two greens from different fork caps were indistinguishable in the evidence, and a cached verdict
  could be reused across a capacity change.

Alongside the run, the supervision skill's own instruments: the mutual-clear protocol gains a return
leg — a returning seat announces itself with its watcher inventory, and a clear order carries an
expected-return deadline, because until now a cleared seat and a dead one produced the same silence.
Its context watcher no longer refuses auxiliary seats, and alarms when it goes blind instead of ageing
quietly.

**v2.1.4** — the suite tells the truth, the release proves it before the tag, and nothing destroys work
it is holding. Eight tasks across two gated runs, cross-vendor throughout; three of them reached the
review cap on real findings and merged on upheld attempts.

- **Timing assertions assert the property that was measured.** Three exact-zero process-CPU assertions
  and one read-the-frame-too-early assertion had made the full suite non-deterministic under its own
  parallel load — the same assertions that turned public CI red on six consecutive releases.
- **The built-CLI suite rebuilds when its entry is stale**, not only when it is missing, so new
  assertions are never graded against yesterday's binary.
- **A live-board test survives the width at which its header wraps.** The one CI-only red 2.1.3 shipped
  was deterministic: a six-digit process id wrapped the board's fact column into the brand lockup.
- **The release proves the suite before the irreversible act.** The runbook now pushes the mirror, waits
  for the full-suite `CI (public)` run to be green on that exact commit, and only then tags; the
  artifact-scoped publish gate says what it does and does not prove.
- **Work the engine is holding is preserved before the engine destroys it.** A worker that dies with
  uncommitted changes leaves a durable ref — via a temporary index outside the repository, because
  `git stash create -u` silently omits untracked files — journaled before the worktree is recreated.
- **An unresolved review finding travels on every later dispatch**, not only on a funded repair inside
  the repair budget, and it retires when a later review passes.
- **The live board reports on its own supervision tier, in both directions**: armed while it lives,
  armed-then-lost when it dies, never-armed when nothing beat it.
- **One writer per supervision tier.** The run daemon no longer arms the orchestrator tier itself; a
  seatless record on a supervising tier reads unreadable, never armed.

**v2.1.3** — a milestone about supervision telling the truth about itself. Eight tasks, all gated green,
cross-vendor throughout.

- The **context tier names the seat it is watching**, beats only what it actually read, and stands down
  when it leaves. A beat that outlived its session used to hold a tier `ARMED` with nobody home; a
  supervising tier can now tell *armed* from *armed-and-seatless*.
- **`status` never reports a phase the daemon is not alive to be in.** It previously contradicted itself
  — narrating a live phase from a journal whose daemon had died.
- **Every lane that runs the suite divides the machine the same way.** Three workflows invoked the test
  runner with three different fork budgets; the odd one out was `release.yml`, which is the one the
  public export ships.
- **The daemon suite splits without losing a test.** `tests/run/daemon.test.ts` was 4,641 lines; it is now
  four focused files (`retry`, `harvest`, `fleet-and-gates`, `stall`) with the same assertions.
- **The baseline records what it measured and classifies what it read**, so a gate can tell a pre-existing
  failure from one the diff introduced, and an infrastructure red from a real one.
- **A spawn the machine refused is retried**, and where it still lands it is named rather than reported as
  a worker defect.
- **An adapter reports the model it was actually served.** A session whose served model differs from the
  pinned one now says so — and the advisory survives a `--list-models` that times out or exits nonzero,
  which is exactly when an operator most needs it. A malformed advisory record no longer aborts `doctor`.
- **The release path refuses a mirror whose identity guard is not installed**, closing the personal
  address that reached tag author and committer fields.


**v2.1.2** — a patch about the distance between what a record claims and what it checked. `verify
--criteria` no longer prints a green `scope` row for an allowlist it never applied — it omits the gate
rather than crediting one that gated nothing. The scaffolded version preflight now checks *this*
repository's own run lock instead of requiring a machine-wide process pattern to be empty (a lawful run
in another repository, or the probing shell's own argv, both matched it), and it compares the **entire**
version rather than `major.minor`, so a binary one patch behind is a stop. And the overseer guidance
gains the rule that an inherited watcher claim is a claim, not a watcher: a handoff records the arming,
while the process died with the seat that armed it.

**v2.1.1** — a patch that fixes what was making this repository's own gates unreliable, plus two
operator-facing cockpit corrections.

- The run board is placed to the RIGHT of the orchestrator pane instead of stacked above it, and the
  effort bars draw one uniform glyph so rows cannot render at different heights. Both are visible
  changes to the live board.
- `captureBaseline` gets its own thirty-minute ceiling. It previously inherited the 600s shell
  default while every consumer of its result sized its own ceiling separately, so on any repository
  whose suite runs longer than ten minutes the capture was killed every time, recorded no
  fingerprints, and left every gate forgiving nothing. It now also says so when it is killed.
- The `VITEST_MAX_FORKS` budget the daemon writes into every child is finally read, and the cap is
  derived from processes rather than forks — one fork can hold a daemon and that daemon's git child,
  so counting forks under-counted what the fork table sees. Cap scales with the machine.
- `seat-send.sh` no longer reports a delivered message as unsent when the receiving TUI echoes it.

tickmarkr can drive [Orca](https://orca.computer) worktrees the way it drives herdr panes: a second
execution surface behind the same driver contract, chosen explicitly rather than inferred. Session
and read integrity, terminal placement and reconcile ownership, driver selection with the doctor
row, a real-orca smoke, and guided-init discovery all ship. Nothing on the herdr path changes
shape, and the run/merge contract is untouched.

The run board is also fixed: it read the swap-confirmation flag at `result.changed` while herdr
answers `result.swap.changed`, so every successful board placement was judged failed and the split
was discarded — the board died at birth on every run, journal-silent. The test fixture had
hand-written that same invented shape, so the suite validated the defect instead of catching it;
the fixture is now a verbatim capture and carries the pre-fix expression as a falsification control.

**Known in this release, fixed in 2.1.1:**

- **Live worker liveness under the orca driver is not wired.** Orca is selectable and runs work, but
  `tickmarkr status --watch` shows no worker liveness for orca runs — the shipped path cannot yet
  resolve an orca worker through its journaled locator. Runs, gates and merges are unaffected.
- **Under herdr 0.8.0, a healthy interactive worker can be falsely concluded.** Alt-screen panes
  read empty through the scrollback sources, so the daemon's output high-water never advances; the
  silence nudge fires and the stall timeout concludes "no trailer" on a worker that is still
  committing. **Workaround: set `driver: subprocess` in `.tickmarkr/config.yaml`** — worker panes
  become invisible, gates and merges are unaffected. Do not pin herdr back; the fix belongs here.
- **Long or verbose workers can exit without their machine trailer.** This is fail-closed, not a
  correctness break: a missing trailer is treated as an untrusted claim and the engine runs every
  gate itself. It surfaces as `clean-exit-no-trailer` in the journal.

## v2.0 — evidence consulted, watch quieted, velocity measured

Three unpublished milestones ship together as the 2.0 marker release; nothing here breaks the CLI
surface or the on-disk run contract.

**v1.98 — evidence loop.** The harness already recorded the evidence and did not consult it; now it
does. Review findings survive their journal and are carried forward to the next attempt, gate
failures get a cause taxonomy before anything is retried, collateral predictions outlive plan time,
and the CPU accountant is read by the kill path that runs beside it.

**v1.99 — quiet live watch.** The run board redraws at 500ms with a nonblocking single-flight
scrape, always shows the running version directly below the brand, and adopts the operator's exact
five-color live palette with attention states distinguished by glyph (█/▒/▓), never by color alone.
The raw journal wall is replaced by a compact styled event rail that launches below the board in a
72/28 full-width vertical stack; TTY narration suppresses contact/status noise while piped output
stays byte-identical.

**v2.0 — velocity.** Dead review and judge channels are concluded by a measured 12-minute
inactivity policy (window derived from 96 journaled healthy invocations, p95 + 1m; stated
false-kill exposure at most 4.2% on the output leg, and only a live channel's CPU can extend the
wait) instead of burning the full 15-minute ceiling — a dead reviewer pair now costs 24 minutes,
not 30, with recalibration driven by data the same release starts collecting: every gate-result row
carries duration, start/end load, capacity, and per-invocation review/judge spans. Invocation
clocks bracket only the adapter dispatch, so the new telemetry cannot be poisoned by gate overhead.

## v1.97 — the approved task board

The daemon-owned run board now renders the operator-approved task table instead of the evolved
two-line cards: one themed-green `tickmarkr` chip; explicit area, dependency, task, seven-gate,
channel, attempt, and note columns; and the existing typed WHERE THE EFFORT WENT fold. Dependencies
are structural for every task rather than appearing only as a waiting note, while unfinished reverse
dependents remain named in the note column. Narrow terminals stack the same facts instead of dropping
them, and every fit still goes through the cockpit's grapheme-cell width authority.

This is a clean watch-surface cutover. The old four-row banner and card frame no longer wrap
`status` on a TTY; non-TTY status bytes remain the machine-readable form. The daemon lifecycle is
unchanged and now pinned explicitly by a test at the boundary: the run-id-bound board opens only
after `run-start` is in the journal, before the first worker, and the run-end reconciliation remains
the owner of its pane. No manual `tickmarkr ui` pane stands in for the run board. No breaking changes.

## v1.96 — dispatch truth

This release is about the gap between what the harness claims and what it measured. `beatSupervision` and `SUPERVISION_BEAT_MS` had shipped with no caller, so `status` printed `orchestrator ARMED / overseer ABSENT / watch ABSENT` through an entire trial run while a real overseer worked it — two thirds of a supervision claim were constants dressed as measurements. `tickmarkr beat <tier>` now calls the shipped seam, the overseer skill's watcher loop calls the verb, and a tier's row renders armed, stale past the staleness ceiling of six beat intervals, or stood down — with the staleness boundary read off the shipped constant rather than asserted by the spec that described it.

`tickmarkr verify` stops paying for its refusals. It had refused the same candidate twice — a dirty worktree, then a missing authed review channel — each time *after* a full ~10-minute baseline capture (602s, then 590s), because `captureBaseline` ran before either precondition was evaluated. Every precondition knowable from cheap local state is now validated in one phase ahead of the capture, with the existing messages and fail-closed semantics unchanged, and the cleanliness check enumerates every offending path (including untracked ones, which `git status --porcelain` hides when the operator's config sets `status.showUntrackedFiles=no`).

Infra classification now reads execution rather than prose: whether a failure is infrastructure is decided by an oracle's own execution evidence, never by a judge's description of it. The gsd compiler refuses unreachable context references exactly as the native compiler already did — a parity gap, not a missing mechanism — and the authoring law now states, per driver, which side of a run inherits the operator's environment, so a spec author can no longer discover the asymmetry from a failing worker.

One task was descoped in place rather than shipped: an `envFile` credential seam came back with a secret-disclosure regression — values, credentials included, interpolated into a multiplexer's `pane run` argv and therefore into the pane transcript — plus a hand-rolled dotenv parser that silently corrupted values it could not parse. A credential channel is a design with a threat model, not a config key, and it does not get designed at the end of a milestone. The authoring law that the original incident actually needed shipped instead, for the price of a paragraph.

Known and filed, not fixed here: the dead-channel fast-kill concludes without consulting the CPU accountant the same loop already builds (a worker was declared dead while its own process tree held 219s of CPU running the suite the harness told it to budget), an undeliverable liveness nudge lifts that kill's hold, a signal-killed acceptance oracle is still reported as a content failure, and a merge still does not make a task done. No breaking changes.

## v1.95 — verifier parity

The verifier could not verify this repository, and had not been able to for four consecutive runs. `verifyIntegrationTip` ran the integration tip's battery with no ceiling argument — inheriting the flat 600s shell default — while holding the very baseline whose entry carried the derived `ceilingMs` of 1,800,021ms, and it never read the ceiling-kill result that `compareToBaseline` had always read. So every per-task gate passed while the tip was SIGKILLed at 601.7s, 601.6s, 601.9s and 601.7s, each time fingerprinted as `<unrecognized failure output>`. The suite genuinely needs about 712s under load: the flat ceiling was mathematically incapable of passing, and the fix was proven by the run it repaired — the same commands on the same machine ran 712.7s to completion with the tip verified, then verified twice more.

A ceiling-killed baseline capture is now recorded as infrastructure rather than a red, keeping its duration so the derived ceiling still scales with the machine it measured, and an infra baseline forgives nothing — a suite that never finished cannot license a later failure. A third task was descoped on measured evidence: its refusal classifier called five of eight realistic judge refusals infrastructure, including an evaluated product defect, which would have taught the run to forgive real defects. No breaking changes.

## v1.94 — the approved board

This approved-board release finishes the tasks-redesign port at the shipped surface instead of replacing the operator-ratified two-line card with its prototype. The WHERE THE EFFORT WENT panel now closes the board with the four tasks carrying the most combined dispatch, review, and park work, folded from typed journal events and fitted through the cockpit's display-cell width authority. Task cards answer dependency truth in both directions: the blockers a waiting task needs and the unfinished dependents this task will unblock, with completed dependents falling away and the existing detail priority deciding what narrower frames shed.

The watch pane is self-placing and run-bound. The daemon measures the supervising seat, funds the board's clean width first and places it beside that seat when the terminal can carry both, falling back to a full-width pane below rather than squeezing it; the command pins the board to the run id that spawned it instead of following whichever journal is newest. The shipped pane is now the surface the overseer looks for, so no hand-placed or hand-rolled overlay stands in for the product. No breaking changes.

## v1.93 — steering truth

A skills-only release, and the first one authored by watching the supervision stack fail in production twice in one night. Every law in it was paid for by a measured incident in a live two-tier milestone run, then shipped into the trees the package actually carries — closing the gap the release is named for: lessons recorded in operator memory that never reached the shipped skill, re-earned at full price by every fresh hierarchy.

The engine is now the overseer skill's declared default executor. A mission that names a milestone, phase, or spec runs `compile → plan → run → report` with the journal as the record; the supervised `/gsd:*` flow is the exception requiring a recorded operator order with its costs named. The drift this closes was real and unruled: a repository's milestones silently left the engine between two briefs, the bypass propagated six phases through adopt-time precedent, and the question "which model ran each task" — one `jq` line against a journal — became session-file archaeology over twelve seats running eleven-twelfths on one model. When the exception is genuinely ordered, every seat spawn now appends one JSON line (seat, pane, adapter, model, role, brief) to a `seats.jsonl` ledger that stands in for the journal's assignment records, with the engine as its stated removal condition.

Delivery truth: a content probe — token, tail, or full text — cannot verify delivery at all, because `herdr pane read` includes the input box and an unsubmitted message renders identically to a submitted one. A freeze hold was "verified delivered" by three independent content methods while sitting unsubmitted; the receiving seat stopped nineteen minutes later without ever reading it. The new `seat-send.sh` verifies submission on the only state that discriminates — the prompt line — refuses oversize payloads (PTY front-truncation), refuses to stomp a foreign draft (with SGR-dim ghost discrimination), retries a swallowed Enter exactly once, never auto-resends, and delivers freeze-class directives through a bounded verified interrupt, because a message to a working seat is a queued message, the queue drains only at turn boundaries, and a queued hold is not a hold.

Visibility: the five-tab operator canon ships in the skill (ORCH tab is the orchestrator, watch board, and journal feed — never a work seat); GSD's in-process teammates trap is named as the mechanism that makes a seat unwatchable and unsteerable at once (measured: ≈855k tokens of invisible subagent burn in one planning leg); auxiliary seats run as interactive TUIs, never headless `-p`; and seat diversity is bought from the live doctor capability matrix at every dispatch, verifier first. Watchers tightened to match: artifact watchers print an unfinished file's actual last line (a seat reporting the wrong marker for its own artifact left a watcher hanging on a complete file), the pending-input watcher's cap line carries one final unsustained read with styled bytes, auto-supersede injections name their author, and heartbeat files are swept at stand-down so a stale beat can't read as coverage.

No engine changes; no breaking changes.

## v1.92 — the fleet browser

The six-step fleet wizard is gone. `tickmarkr fleet` (and init's act 3) now opens one full-screen two-pane browser on the alternate screen: a left rail with the three views (All models, Shapes, Steering) and every installed agent CLI with its auth glyph and model count; a right pane with a search box and a model table whose columns finally render the evidence the assembler always had — tier band, context window, $/Mtok (or `sub`), and doctor's probe latency. Space allows/denies, Enter classifies an unclassified model or pins a classified one to a shape, `m` applies a routing preset (with the same mix/floor preview), `w` shows the unified overlay diff, and `y` writes through the unchanged guarded funnel. Search is an explicit mode so letters and hotkeys never collide: `/` enters it (every printable then belongs to the query — searching "kimi" can't move the cursor, "mid" can't open presets), Enter commits the filter with all hotkeys live on the narrowed list, Esc cancels. The shape candidate picker multi-selects: Space builds an ordered prefer chain from the ranked rows — economy failover that routes down the chain and falls back to normal cost/tier ranking — while Enter alone still pins one channel, and an applied chain evicts the pin it would otherwise be dead under. Every preview — the candidate picker, the routed-under shape rows, the preset mix line — ranks under the SESSION'S staged deny state, not the on-disk one: a model denied this session leaves the picker immediately, an un-denied one reappears without a relaunch, and the picker can no longer offer a channel whose selection would compile into a deny∩pin contradiction. Enter on a denied model row refuses with the remedy named instead of staging that contradiction. The wizard's semantics all survived the move — first-touch vendor/channel provenance, required benchmark notes, catalog-suggested bulk staging, retired-model hiding, the reload guard bounce — but they are overlays on one surface instead of a fixed walk, so nothing asks the same question twice and Esc never discards staged work inside init. Init's act 1 wears the same frame, doctor compresses its trust n/a roster to one line, groups advisory lints under a counted `attention` header, prints compact context windows plus per-model probe latency, and replaces twenty scrolling probe lines with one rewriting counter. Scrollback stays clean: the browser restores the primary screen on exit, leaving only the command and its one-line result.

Shapes gain pools: a map entry's `pool` declares the shape's own candidate set, where `any` runs the economy engine inside your selection (cost, then tier) and `ordered` is strict failover — first live entry wins — and an exhausted pool fails loud at plan, exactly like a pin. Fleet scoping is now membership: Space toggles models in or out of the fleet, and the editor writes the minimal `routing.allow` form (presence activates fail-closed), tombstoning the deny scopes it replaces. The browser opens on fleet scoping — the models view — and the routing-presets overlay raises on your first entry into Shapes instead of at launch.

The browser shipped through a dual independent review (two frontier agents driving the live TUI) and a hardening pass of sixteen recorded findings (OBS-517..532). The serious one: a denied model whose auth probe failed was silently un-denied by the next membership write — deny entries the probe universe cannot express are now preserved verbatim through both write legs, with their operator rationale comments intact, and deny still beats the adapter-level allow on reload. The review diff scrolls (it used to hide its tail on the one surface that asks for approval), the editor re-renders live on terminal resize, quitting with staged edits warns before discarding, the header counts staged work, an unauthed model renders its failed probe verdict instead of a healthy row, pools round-trip through the picker (reopening seeds the staged chain; `a` reverts the whole declaration), and the candidate picker attributes every channel it cannot offer — staged out, denied, unauthed, or unclassified — instead of omitting them silently. A stale probe cache no longer refuses the editor: `tickmarkr fleet` runs doctor itself when the cache is old, and `--fresh` forces the probe; a write that classifies never-probed models names that step. Flow-sequence formatting churn is gone from untouched config lines, and writes after a classification tell you when `fleet --fresh` is the missing step to make them routable.

## v1.91 — evidence tiering

Tier suggestions stop wearing a costume. Before this release every "intelligence" tier suggestion in a keyless install was price inference in disguise — the Artificial Analysis leg only fetched behind an API key nobody was told to set (D-1), and even with the key, the absolute `index >= 65 → frontier` cut was unreachable after AA's v4 rescale left the #1 model on the whole leaderboard at 63 (D-2): no model in existence could be suggested frontier.

The catalog gains a keyless LiveBench leg as the default evidence path: the pinned `table_<date>.csv` and `categories_<date>.json` fetched from `livebench.ai` (never the stale GitHub mirror), aggregates derived from the published categories file rather than a hardcoded column list, fleet ids matched by boundary-respecting prefix with the highest-effort row winning, and a failed or zero-row fetch preserved as a failed probe instead of an empty fleet. Evidence rows now carry `agenticCodingScore`, `codingScore`, the table date, AA's coding index — and `catalogId`, the matched catalog record's own `provider/id` identity, so rankings can never inherit scores through a caller's spelling, a stripped namespace, or a broad model family.

Tier suggestions are now fleet-relative: models rank against the fleet's own same-basis evidence (LiveBench agentic coding first, then the AA index with its version recorded in the provenance note, then the unchanged price fallback), top third frontier, middle mid, bottom cheap — immune to the next vendor rescale by construction. A basis needs at least three evidenced members before it bands anything, the vendored fallback catalog is refused as suggestion evidence outright, and suggestions remain strictly advisory: the review-diff consent gate is untouched. Doctor lints the pinned LiveBench table once it ages past 90 days, the release ritual checks upstream for a newer table, and `ARTIFICIAL_ANALYSIS_API_KEY` is finally documented where operators actually look. No breaking changes.

## v1.90 — external truth

The first release shaped by real external use instead of self-hardening: a two-week trial running tickmarkr as the executor on a production Expo app surfaced, in its first nineteen minutes, defect classes forty releases of dogfooding could never see — and this release ships their fixes plus the command that makes the verifier usable without the run loop.

`tickmarkr verify` runs the full seven-gate battery standalone against `merge-base(--base, HEAD)..HEAD`: build/test/lint against a captured (and cached) merge-base baseline, then evidence, scope, and the acceptance judge alongside cross-vendor review — no daemon, no worktree lifecycle, no retries, no resumable state; one invocation, one immutable candidate, one fail-closed machine-readable verdict. Verify keeps all of its state outside the repo it gates, criteria come from a compiled task or a plain criteria file, and human-authored diffs get a review seat via the human-author sentinel while `--author` gives true cross-vendor exclusion.

Three trial-found classes are fixed. Scope and every other files[] consumer now match through one shared matcher in which parens are literal path characters, so Expo Router and Next.js group directories like `(app)` — which previously compiled to a regex capture group and made their paths unmatchable by construction — scope correctly. Tip verification forgives failure fingerprints recorded in the run's own baseline using the battery's exact forgiveness math, so a repo whose main carries a pre-existing red can still earn a green terminus — while infrastructure-only output, fresh fingerprints, unreadable output, and forgiven-cycle cache reuse all still fail closed. And doctor gains a test-runner row that warns, with the exact config line to add, when a repo-wide-collecting jest or vitest would scan tickmarkr's own run worktrees — the duplicate-suite interference that falsely reddened the trial's first run. No breaking changes.

## v1.89 — verification honesty, the foundation

This release makes the harness stop lying to itself about what its own records mean, and it folds in the v1.87 and v1.88 lines. One typed outcome vocabulary — passed, failed, skipped, declined, held, unavailable, infra, each non-verdict carrying its reason — now governs every read of gate truth: legacy journal rows are normalized read-side before any surface counts them, so a skip can never again be tallied as a pass and 333 historical misread rows count honestly. Decision events validate against closed schemas on append and on load, failing closed before writers migrate, so unknown history stays opaque instead of deciding anything. Every spec source format crosses one canonical plan with a typed base seam; a task's declared base containment is measured from git evidence rather than worker claims; captured artifacts carry manifest provenance under their own cap. The watch board's claims are derived from the run's own record — graph-hash comparability, tip state, pane locators only for panes that can still exist — and a compact one-line status form lets external statuslines call the product instead of re-implementing journal reads. Native compile fails loudly on task-shaped headings it once silently absorbed, the criterion-law block in the scaffolded template now states the top-level-test law and the evidence-discipline rules reviewers enforce, and the supervision heartbeat instrument distinguishes armed, stale, disarmed, and unreadable from disk. No breaking changes to the CLI surface; journals written by earlier versions are read, normalized, and never rewritten. **One breaking change to the spec surface (OBS-488):** the native compiler now refuses any line inside a task block that no parse rule consumes, instead of silently dropping it — wrapped acceptance criteria that previously compiled to first-line stubs now compile whole, and directives misplaced below a task heading (such as a `mode:` line, the OBS-394 silent-override class) fail compile loudly instead of being ignored. Specs that relied on the compiler discarding unrecognized task-block lines must move that text into a field, a list item, or above the first task heading.

## v1.88 — the leak that ships

A short line between milestones: the temp-directory leak was re-scoped beyond the four call sites its first spec named and fixed with its test-removals as one atomic change, and the collateral-detection truncation defects found in the v1.87 close were repaired. No breaking changes.

## v1.87 — policy truth

Fleet lints that go silent when the fleet is broken now speak; channel pools are role-scoped with every configured seat checked; resume stops refusing on shapes the graph never uses; and a gateway's `--json` model list became readable. Shipped to npm as 1.87.0. No breaking changes.

## v1.86 — silence is the problem

This release is about mechanisms whose zero cannot be told from an absence — a gate that returned no findings, a gate that never ran, and a gate that does not exist all look identical from the outside, and this milestone makes them distinguishable one surface at a time. The review gate stops reporting a silent verdict as agreement. Classified causes are trusted at parse boundaries instead of being re-derived locally, a malformed worker cause survives to the consumer that routes on it, and the fake adapter authors nonce verdicts so a fixture can no longer pass by resembling one. The GSD compile path fails closed on truths: a typed truth that validates minus a key was coerced rather than accepted and is now rejected, a present-empty truths list is recognized as legitimate producer output rather than a fault, dropped own-properties are detected, and the renderer survives a recursive alias. The repeat-failure detector stops erasing what distinguishes two failures — base-moved runner tallies are masked by provenance and summary-line shape together, never by digit class, so exit statuses, appended codes and differing failed counts stay identity-bearing and a legitimate retry is no longer banned by a false cap.

The fleet learns to say where routing came from and to stop guessing: a declarative CLI catalog and a cited model-window catalog replace inferred capability, per-model vendor overrides are declarable, context windows are validated only where seeded and enforced where declared, first-touch model classification asks instead of assuming, models are discovered without tier seeds, and effective routing sources are explained rather than implied. Fleet writes preserve what the operator wrote — deny tombstone comments, overlay routing metadata, and first-touch entries all survive a rewrite. Map-pin floor lints tell the truth, doctor exposes cache-only catalog evidence, and the status board renders task titles.

Cockpit capture equality no longer depends on the release version: active golden and machine-surface comparisons canonicalize only the exact first-line version token on both sides, while committed fixtures remain verbatim captures; retired rendered frames, declared-retired anchors, and colour evidence remain outside equality, and every other byte still rejects drift. Retired TUI suites are proven silent before being removed, so a deleted suite cannot be mistaken for a passing one, and documentation truth is decoupled from per-directory test counts. Lint closes the chainable-modifier grammar, resolves bindings lexically, and shuts the todo and suite-root evasions. Launch intent is carried through pane dispatch so a launch is no longer misclassified as an interactive turn, a scrolled pane self-heals on any geometry change, `init` reports an installed skill as current only when it is byte-current rather than merely present, and herdr opens one tab per task holding that task's worker alongside its judge, review and consult panes.

**Scope note.** The compile-time ownership and symbol-coupling detectors this milestone's thesis calls for did not ship. They are deferred to v1.87 together with their dependents, after a pre-release review found several of their acceptance criteria unsatisfiable as written. The behaviour they were to enforce is documented but not yet mechanically checked.

## v1.85 — speed and truth

This release makes the run loop fast where it was ceremonial and honest where it was silent, without loosening a single gate. The gate pipeline stops paying for order: evidence and scope screen before any battery command runs, the battery short-circuits at its first red, judge and review run as parallel siblings that construct and publish their verdicts independently, a selected-test round may screen non-final rounds while the merge-candidate round always re-earns the full suite, and an unmoved verified tip skips re-verification only for an identical SHA and command hash whose last cycle was completely green. Transport now delivers or retries itself: shell and bootstrap dispatches go through atomic pane-run with a per-dispatch START nonce, the durable acknowledgment gates the launch it acknowledges so an ack miss can never double-launch, a fresh pane takes a wedged slot's name only after the close postcondition is proven, and the positional-transcript success inference is gone — no delivery is acknowledged by inference where a causal acknowledgment exists. Finished work is harvested, never redone; a dead or silent worker is noticed in minutes through progress-keyed stall detection; retries repair with the reviewer's findings in hand and two normalized-identical failures of one gate force a consult with the identical retry banned. The review gate's skip branch now says skipped — with a policy id, journaled, treated by merge as non-failure rather than a green pass — and participation is keyed on what the diff actually touches, promoting to full review the moment a docs-leaf diff exits its closed class, while claude-code's declared input box makes the merged liveness nudge deliverable by the real driver. The compiler refuses the task shapes that cost nine review rounds — surface, goal-density, and unowned-symbol lints calibrated against the corpus that produced them — and the baseline gate fingerprints failures instead of matching vocabulary. The cockpit's folds tell the truth: parked is parked, done is done, and the fixture corpus is a verbatim capture of the current version. It ships with npm 12's pack output parsed as readily as npm 11's, and the contract sweep proving the domain without out-running its clock.

## v1.84 — the pointer bundle

This release gives the cockpit a mouse without surrendering an inch of the plan's authority or the keyboard's sovereignty. Clicks, the wheel, and hover act on the drawn run surface, and every hit resolves through planFrame's regions — the same plan the conformance oracle pins — via one resolver; no pointer path re-derives or caches geometry the renderer did not commit, so a click acts on what the operator actually saw, even mid-batch on a scrolled list. Pointer reporting is a loan the surface always repays: enabled only on an interactive terminal, released on every exit path including thrown failures and termination signals, and never emitted on the CI or non-tty surfaces; the enable is owned by a single borrow/release owner around the complete live lifecycle. The keyboard remains a complete interface — every pointer action has an advertised key producing the identical drawn frame, proven by driving both and comparing painted output, and pointer reports are a separate input class no key handler ever receives, with the byte demultiplexer preserving input order within a chunk and passing bare ESC through untouched. Hover highlights exactly the element the plan-resolver would return for a click at that cell — hover and click share one resolver, so the highlight cannot lie, and no highlight byte reaches any golden, anchor, or colour capture. Dragging a panel boundary sets a session-only override that flows into planFrame as an input: the plan recomputes, the renderer draws it unmodified, conformance holds on every resized layout, and a relaunch draws the default.

## v1.83 — plan-authoritative watch

This release ships the v1.82 operator-model line and the v1.83 watch-and-setup redesign as one version. The cockpit now draws from a single authoritative frame plan: `planFrame` owns every row and column at every terminal size, the renderer consumes it unmodified, and a conformance oracle fails any drawn cell that disagrees with the plan — the two-layout-models defect class is retired structurally rather than test-by-test. The appearance oracle moved from point fixtures to a property sweep over the whole contract domain, with superseded goldens retired by declaration (pinned to the regenerable manifest, never deleted) and the machine surfaces staying byte-compared. The sidebar separates its menu from its vitals, the second tab is named DECISIONS for what it actually is — journal-parked human decisions with approve and uphold as its only writes, with a truthful empty state and read-only tombstone rows — and the tip-verify strip reports the latest verification cycle, so a mid-run failure that a later cycle recovered draws as recovery instead of permanent red, while the log rows keep the failure history visible. The width migration is complete and enforced by a detector that flags every shape of hand-rolled width arithmetic across the cockpit, proven against a fixture of each shape.

## v1.81 — cockpit-product

This cockpit-product release routes `tickmarkr ui` to the cockpit and makes its keys real. The bare command opens the most recently started engagement, an explicit run reference always overrides it, and when no engagement exists — or its journal is unreadable, or stdout is not a TTY, or a flag is unknown — the command refuses with a reason before drawing anything, rather than inventing a plausible screen. The keybar is now generated from the key-handler registry, so an advertised key cannot be dead by construction: the advertisement is derived from the wiring. Every key acts on the drawn frame — help opens an overlay, filter opens a prompt, follow follows, selection narrows the rows — and each key's test asserts painted output, not a state field whose name echoes the label. The run and setup surfaces share one registry, the frozen appearance pin held byte-identical throughout, and the readiness classifier in the herdr driver no longer misreads a timed-out late pane read as a protocol failure — the defect that had masqueraded as a CI flake for three releases.

## v1.80 — surface-truth

This surface-truth release gives tickmarkr a studio cockpit and then makes that cockpit honest about the run it draws. The run and setup surfaces render from real captured journals through a frozen appearance pin, and every committed frame is a verbatim capture of a run that actually happened. Content now fills the container it was given: the journal draws as much history as its panel has rows rather than a fixed three, detail bands are sized by what they carry instead of fixed widths, and no wrapped line opens with a bare separator. Journal rows carry the outcome of the event they name rather than inheriting their task's final verdict, so a failure inside a task that later succeeded reads as a failure instead of a green pass — the surface can no longer claim work went well while the evidence says otherwise. Verified delivery gained the ability to see an occupied input box: a submit check that could not recognise a multi-row editor previously fell through to positional evidence that is always true for an interface drawing status chrome beneath its prompt, so a prompt that was typed but never submitted read as delivered.

## v1.79 — signal-truth

This signal-truth release makes every operator-facing signal accurate, current, and precisely addressed. Status and watch now render tip-verify as a first-class phase, naming failed gates and re-verify attempts without showing terminal green while verification is failed or pending. Doctor warns on resolved-identity drift when a model alias moves beyond its dated classification, while leaving routing unchanged. The remaining legacy wall-clock bounds use controlled time or load-proof margins. A stable JSONL decision-event stream carries the exact approve command and evidence pointer, with an optional fire-and-forget webhook sink. Verdicts can also carry line-anchored review feedback into retry and consult prompts; malformed optional comments fail open on the extra without weakening the verdict.

## v1.78 — evidence-literacy

This evidence-literacy release teaches the verifier and its tests to read the legitimate evidence classes reality produces. Launch submission now accepts a prompt-prefixed execution echo as positive shell-stage evidence; once seen, the launch submit window hands responsibility to readiness machinery instead of demanding first paint, while no echo and no paint continue to fail-closed. Driver timing oracles use controlled time through injected settle and clock seams rather than racing wall-clock bounds, and the signal-reaper and build-provisioning tests use controlled time or load-proof deadlines. Test-temp hygiene gets an owner: the shared helper tracks the temp repos it creates, and shared setup reaps tracked temp dirs at suite end, covering the dominant leak classes without a broad migration.

## v1.77 — readiness-truth

This readiness-truth release stops treating a painted interface as one that is listening. Delivery now gates on bounded interactive readiness: an adapter with a declared input box must show that box painted and stable, while an adapter without one must show a stable clean line; `readinessMatch` remains launch-liveness evidence, never permission to type. Submission verification accepts positive evidence only — the prompt echoed into the transcript, or the box emptied while remaining visible — so an absent prompt can no longer false-green. The submit window derives from the observed readiness timing, and a pane that never becomes interactive fails closed in the named READINESS phase with its waited duration and pane evidence journaled. A READINESS failure consumes a normal fresh attempt because cold-start variance can recover in a new pane, while structural driver errors remain immediately terminal. Every wait stays bounded and every uncertain path stays fail-closed.

## v1.76 — earned green

This earned-green release moves five green signals to the layer where they can actually fail, so a shallower layer's success can no longer stand in for a deeper one's. Worker delivery now verifies submission, not just typing: after the driver presses Enter it confirms the seed left the input box — the delivery line or declared input box no longer holds the typed prompt, or the prompt echoed into the transcript — through the existing settle-read seams before any bounded re-press, so a kimi TUI that swallows the Enter is caught and re-pressed instead of sitting verified-but-unsubmitted, while already-submitting panes (claude, codex, cursor) see no added latency and verification always precedes a re-press so a slow-but-successful submit is never double-submitted. The kimi launch now speaks the 0.29.0 contract: it passes the full config.toml model key rather than the dropped bare-suffix -m alias that the TUI accepted at launch and then killed config.invalid on the first turn, with the banner-parse mapping kept consistent with what the banner now prints. Doctor earns kimi's green with a real turn, not a file read: kimi health now spends a minimal real model turn — the codex candidate-sweep precedent — so a dead model contract surfaces in doctor instead of mid-run, and npm test stays zero-token because the turn probe runs only inside a real doctor invocation. The stall watchdog measures progress, not repaints: stall detection keys on progress the worker actually made — seed submitted, transcript grew, context advanced — rather than raw pane output, so an idle TUI's spinner and ANSI chrome repaints no longer read as liveness, with the preferred failure direction explicit — a spurious consult is recoverable, a silent watchdog is not, so when in doubt it fires. And the picker escape test settles on the fact it asserts: the escape-path assertion settles on cursor-row identity instead of sampling a racing last write, so a single frame race no longer taxes a release a full CI cycle. Nothing here weakens a refusal, a page, or a gate — fail-closed stays fail-closed.

## v1.75 — interface literacy

This interface-literacy release teaches three seams to read the interface in front of them, so a guard or surface can no longer turn healthy reality into failure or silence. The delivery clear-guard now recognizes an adapter-declared input box: the adapter owns the declaration of what its TUI input box looks like — the same declare-then-consult seam the trust dialog already uses — and the clear-guard accepts a declared, recognized input box as a legitimate delivery target, so Kimi Code's steady-state bordered input box no longer refuses fail-closed as an unclean shell line. Adapters that declare nothing keep exactly today's shell-line model, and a declared box that never matches still refuses. The trust auto-answer now covers claude and codex: claude-code and codex declare their workspace-trust dialogs through the existing trustDialog seam, so a worker no longer stalls silently at a dialog the daemon was built to answer — once-per-slot semantics, the blocked/idle precondition, and cursor's declaration are unchanged, and any dialog outside the declared set still pages the operator rather than auto-guessing. And fleet --print now renders the review and consult steering blocks with the same fidelity the editor already has, so config the run demonstrably loads and applies is no longer silently omitted from the print surface.

## v1.74 — harness truth

This harness-truth release closes four places where a guard, surface, or ledger turned verified reality into something false-looking, all born in one supervised cycle. Status now honors a journaled graph-rehash: after an audited mid-run recompile (`resume --graph-changed`) the comparability guard reads the rehash event instead of rendering a "not comparable" banner beside a correct done count, gate results recorded under the prior hash render as prior-graph results with channel attribution intact instead of blanking to empty circles, and status advice never walks an operator into starting a second run against a live engagement — recompiles with no journaled rehash still fail closed. The acceptance diff cap measures judge-relevant content: deletions are summarized as file-level facts while the full anti-flooding cap stays on added and modified content, so a deletion-heavy retirement task is no longer structurally fenced from its own judge. The pane delivery clear-guard settles before judging — bounded consecutive-stable reads in the OBS-111 settle-retry lineage, with no adapter fingerprints, no fixed sleeps, and zero added latency for already-stable panes — so a mid-paint welcome box no longer reads as corruption while truly-corrupted lines still refuse. And judge verdict failures leave evidence: a flaked or unparseable verdict captures the redacted judge transcript through the existing redaction seam on failure paths only, healthy runs grow no journal weight, and telemetry gains judge rows.

## v1.73 — studio migration + liveness rendering

This studio-migration and liveness-rendering release finishes the Ink adoption the fleet editor beached: all five Studio views (fleet, routing, preview, profile, runs) plus the consult dossier and diff-confirmation surface render as components reusing the beachhead component library, and the hand-rolled engine — frame renderer, keypress decoder, input stream, and the legacy view modules — is deleted with no surviving importer. The Studio stays a surface over existing fleet and run machinery, never a new control plane: the write path remains the single diff-confirm plus reload-guard funnel, a rejected write returns to the studio with staged edits intact, and non-interactive launches keep their line-mode guidance. Liveness ends "busy reads as idle": the daemon journals phase-start events for worker dispatch, each named gate, the acceptance judge, review, and merge, so `status --watch` and the runs cockpit render a per-task spinner and ticking elapsed driven by watcher-local clocks, worker liveness from last-output age, and a terminal title naming the hot phase — the journal stays an append-only ledger with no heartbeat, and older journals replay identically. Seeded fixes ride along: the daemon installs changed dependencies into the gate-visible module tree before gates run, dispatched workers inherit the fork cap for their self-checks, `approve` on a gate-fail park records a gate-satisfied marker that resume honors while resume gains an explicit dispatch retry, pane-slot allocation and delivery execute as one critical section per dispatch, and deny gains an additive worker scope so a channel can be worker-denied while staying eligible as judge or review.

## v1.72 — component-runtime migration + picker-everywhere

This component-runtime-migration and picker-everywhere release adopts Ink (the React terminal renderer) as tickmarkr's interactive UI runtime, starting with the fleet editor (`tickmarkr fleet`) as the beachhead: all six fleet editor screens now render as components, the diff-confirm and reload-guard write path is preserved as the single overlay writer, and the legacy openTerm/askTyped engine is deleted from the fleet command. Closed vocabularies are picked, never typed — adapters, models, tiers, seats, and prefer chains — while free text survives only for genuinely free fields; ordered multi-select makes selection order the chain order, the consult picker offers full adapter-and-model seats and the review picker additionally offers bare adapters, and a rejected overlay write returns the operator to the editor with staged edits intact. The daemon and every non-interactive path never import the UI runtime, and `--print` output stays byte-identical.

## v1.71 — failure-severity-rendering + kimi-seeding-hardening

This failure-severity-rendering and kimi-seeding-hardening release ships a two-tier task status vocabulary that distinguishes recoverable infrastructure dispatch failures (warn rendering) from verified work failures (terminal red), typed delivery-failure causes in task attempt history, early liveness classification for empty worker panes, seed-mode model-verification fixtures, serialized interactiveSeed delivery with narrow-pane safeguards, doctor and resume preflight checks for deny∩prefer routing contradictions, and journal dead-channel replay at resume.

## v1.70 — evidence/comparison + review-convergence

This evidence/comparison release ships an evidence-addressed judge verdict schema with path/line citations, run-start environment identity, `report --compare` with comparability guards and cost/gate/duration deltas, and `report --bundle` proof packets with task outcomes, evidence citations, content hashes, and secret redaction. The review-convergence contract classifies material and minor findings, records defer-with-rationale decisions, and parks tasks at the review round cap; nested infrastructure tests also gain load-margin timeout budgets.

## v1.69 — eval-lab + kimi-seeding

This eval-lab and kimi-seeding release ships checked-in fixtures with fail-as-shipped and pass-with-reference selfchecks, identical cross-channel prompts, incremental JSON reports with identity stamping, and a held-out known-fail judge canary. It also adds kimi launch-then-seed TUI workers with readiness checks, model and session banner confirmation, and pane cleanup after harvest.

## v1.68 — runs cockpit

This runs-cockpit release ships the fifth Fleet Studio tab with a journal timeline and run-level now-line, per-task gate ladder rendered through the status glyph vocabulary, attempt history naming typed failure reasons, a consult dossier viewer listing verdicts with persisted prompt content, a live per-channel cost ticker and tip-verify state line reusing the cost-signal formatter, human-gate approve routed through the existing approve path, interactive-harvest settle-retry at the parse boundary (OBS-111), and a default fork-cap for gate and verify children (OBS-110).

## v1.67 — fleet studio write path

This fleet-studio-write release adds staged-changes editing for fleet customization (pins, floors, prefer chain, allow/deny toggles, mode selection), a YAML diff modal that shows the overlay delta before atomic overlay write, live-run reload guards that surface "changes apply on next run" for active executions, and a repo↔global target toggle to draft changes in global config or workspace scope.

## v1.66 — fleet studio

This fleet-studio release ships a dependency-free terminal UI engine with alternate-screen rendering and incremental line repaint, the `tickmarkr ui` full-screen app exposing read-only Fleet, Routing, Preview, and Profile views, picker-parity candidate inspection so the studio never disagrees with the router, a plan dry-run preview with per-task routing consequences and cost signals, learned-routing profile inspection that names when a pin overrides a higher-scored channel, and retires the OBS-77 askTyped line-mode flow in favor of modal text input.

## v1.65 — fleet resilience

This fleet-resilience release adds typed worker-failure taxonomy for precise failover classification, quota-style free failover routing that limits retry burden, a transcript noise filter to clean consult dossiers, a doctor flag-drift warning to flag stale disable/allow policies, the quirk registry convention for provenance-tracked disable reasons, and macOS CI lanes for platform-specific workloads.

## v1.64 — gate integrity

This gate-integrity release adds a completion-faking checklist to judge and review prompts, requires quoted evidence from the judged diff, warns on vacuous command oracles at baseline, redacts secrets at journal and consult-dossier persistence seams, and closes status-watch narrators during run-end reconciliation.

## v1.63 — runtime integrity

The signal-reaper suite now runs in a serialized vitest project so its fixed fire deadline survives full-suite fork fan-out (OBS-98). Fatal setup errors after run-start append a terminal journal event before the daemon exits, status renders the recorded cause, and a baseline where every configured command is missing surfaces a wrong-environment warning (OBS-99). Compile refuses the pristine scaffold template init writes unchanged (OBS-100). Skills carry the OBS-99/101 verified-handoff and version-preflight fixes already on main.

## v1.62 — dispatch integrity

Worker dispatch now delivers a per-attempt script, never an inline line (OBS-85, verified pane delivery), eliminating paste-timing interleave corruption in codex channels. OBS-97 probe correctly handles brace glob patterns and single-character wildcards.

## v1.61 — review residue

The v1.60 pre-merge review panel's nine carried findings, retired: the mirror-publish
script's failure-recovery path is behaviorally tested and its diagnostics pinned; the
OBS-96 reproduction record names its amplified mechanism probe honestly; parked
human-gate tasks say so in `status`; FLEET.md's routing-precedence wording matches
route(); the fleet config module is split under the size ceiling; and compile now
rejects a `test:` acceptance oracle whose file scope cannot host a collectable test
(OBS-97).

## v1.60 — fleet integrity

Provenance notes survive unrelated fleet writes; the retired quality-env preview path is removed from routing; step-3 fleet editing re-prompts instead of hard-exiting; gate cells read at a glance; fresh-clone first-run test contention is fixed evidence-first; private release publish is guarded to the public repo identity; RELEASING.md matches the two-repository ritual.

## v1.59 — initial public OSS release and codex driving-agent support

v1.59 is the first public release on GitHub. Private development history (v1.0–v1.59) was squashed into a single import commit for the public repository; the private development repository retains complete history. Public repository history is append-only from this point forward (one commit per release).

- **Export boundary, fail-closed**: a dual-context allowlist manifest test verifies the public tree in both the private repository and the exported tree; nothing under `.planning/` or `specs/` ships (test inputs vendored into `tests/fixtures/`).
- **Codex as a driving agent**: `tickmarkr init --agent` installs the driving skills (`tickmarkr-loop`, `tickmarkr-auto`, `tickmarkr-overseer` with its pane watcher) into `.agents/skills/` with `AGENTS.md` guidance — the codex CLI now drives the loop as a first-class alternative to Claude Code, with per-host launch instructions in each skill.
- **Community surface**: issue and pull-request templates, support boundaries (solo project, best-effort, latest-version-only), a pre-2.0 versioning statement, and GitHub-only security/conduct reporting.
- **Standalone `npm test`** now provisions the build first — a fresh clone's first test run is green.

## v1.58 — OSS readiness groundwork

### Breaking changes in v1.38–v1.58

#### v1.38 — State directory and config locations

- `tickmarkr` now uses `.tickmarkr/` for on-disk state. Repositories created before v1.38 must migrate their existing state directory to `.tickmarkr/` before upgrading. Repositories with no existing state get a fresh `.tickmarkr/` on the next run; old state is not merged automatically.
- Global config is read only from `~/.config/tickmarkr/` (or `$XDG_CONFIG_HOME/tickmarkr/`). Move any existing global overlay to this path before upgrading.
- Native spec marker changed to `<!-- tickmarkr:spec -->`. Older markers are rejected at compile time.
- Resuming runs that started before v1.38 is not supported. Finish or discard in-flight pre-v1.38 engagements before upgrading.

#### v1.30–v1.37 — Tool versioning

- Configuration, state directory, and command-line interfaces stabilized.
- Binary names standardized; use `tickmarkr` and `tkr` for all work.

### Recent major features (v1.39–v1.58)

- **v1.51+**: Routing modes and tier matching — routes tasks to the most cost-effective channel within capability floors.
- **v1.52+**: Integrity hardening — enhanced gate verification and run-state assertions.
- **v1.54+**: Steering and failover improvements — more reliable task routing and error recovery.
- **v1.55+**: Docs-truth tests — automated verification that exported documentation remains accurate with code changes.
- **v1.56–v1.58**: OSS readiness — export boundary enforcement, public CI configuration, GitHub issue/PR templates, and append-only public history model.

## v1.38 — breaking changes (detailed)

### State directory

tickmarkr always uses `.tickmarkr/` for on-disk state. Repositories created before v1.38 must move their existing state directory to `.tickmarkr/` before upgrading. A repository with no migrated state gets a fresh `.tickmarkr/` on the next run; old state is not merged automatically.

### Global config

Global config is read only from `~/.config/tickmarkr/` (or `$XDG_CONFIG_HOME/tickmarkr/`). Move any existing global overlay to the current path before upgrading.

### Native spec marker

Native specs must start with `<!-- tickmarkr:spec -->`. Older markers are rejected at compile time.

### Resume

Resuming runs that started before v1.38 is not supported. Finish or discard in-flight pre-v1.38 engagements before upgrading.
