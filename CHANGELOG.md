# Changelog

This changelog documents breaking changes and major releases. **For per-release details, see [GitHub Releases](https://github.com/alzahrani-khalid/tickmarkr/releases).**

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
