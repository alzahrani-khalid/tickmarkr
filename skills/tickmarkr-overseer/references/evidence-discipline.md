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

10a. **A CONTROL NAMES THE PROPERTY IT VERIFIES, NEVER AN INSTANCE OF IT** — and when it names an
    instance, the seat that wrote it must correct the CONTROL rather than let it stop lawful work.
    Measured 2026-08-24: a ruling armed *"the dispatch must resolve to `codex:gpt-5.6-terra` — anything
    else, STOP"*, when the property the control existed to prove was *"a lawful channel OUTSIDE the
    task's tried set, admitted by the amended floor."* Marginal-cost routing correctly picked a
    cheaper mid-tier channel that satisfied the property completely — never tried, proven on the same
    run — and the letter of the control said halt. **An over-specified control converts a working
    mechanism into a false stop, and the seat under it will obey.** Write the property; if you catch
    yourself naming a channel, a model, a pid or a hash, ask what that instance is standing in for.
    The converse holds too: **a control loose enough to pass on the wrong thing is worse** — the fix is
    precision about the property, not about the example.
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
    **STATE THE LIFETIME, because an unstated one is read as the mission's.** Every watcher a seat arms —
    journal, artifact, dialog, beat loop — records its own pid and arming seat. **A same-process `/clear`
    keeps every background task alive**; it does not retire even one watcher. A crash may orphan or kill
    tasks according to how they were launched, while adopt and stand-down are explicit kill-by-recorded-pid
    transitions. A handoff must therefore inventory real pids, not infer process lifetime from the context
    lifecycle. The inverse failure is
    the same root read the other way: a DETACHED loop outlives its seat and holds a tier `ARMED` with
    nobody home (OBS-583). Neither direction may be assumed; the lifetime is a property of how the watcher
    was launched, and it belongs in writing next to every claim that one is armed.
    **A seat's background tasks are bound to the seat's life (D-302 add.3).** An ad-hoc background task —
    an analysis heredoc, a one-shot shell — dies with the seat that launched it. Record its pid and kill
    that pid at stand-down, the same recorded-pid act as any other task this seat owns. Leave it attached
    to the seat so it is not reparented to pid 1 and left running after the seat is gone. A watcher this
    skill explicitly labels detached, with its heartbeat file, is the process that may outlive the seat.
    **Forbid the home-wide recursive glob by name:** `glob.glob('~/**/.tickmarkr/runs/*/journal.jsonl', recursive=True)`.
    That heredoc walked the whole home (`~/**`, every worktree, `node_modules`, Library) and ran orphaned
    for 30 hours at 100% CPU after its seat was gone. No seat glob starts at `~` or `$HOME`.
    **And EVERY process-table probe has an idiom that defeats it, so the rule above needs the one test
    that survives all of them. Lead with this; it is not the last resort, it is the first move:**

    > ### A REAL WATCHER DOES NOT EXIT BETWEEN TWO READS.
    > Read the process table twice, a second or two apart, and keep only what appears in both —
    > `kill -0 <pid>` on each candidate is the cheap form. Nothing else is needed to kill a phantom.

    It works because it tests a **property of the thing you are hunting** (a watcher persists) rather than
    a **property of your probe** (how its argv happens to look). A probe-shaped exclusion has to enumerate
    every way a probe can look; the liveness test does not care what the probe looked like — which is why
    it is immune to both failures below instead of to one of them.
    **Measured 2026-08-31 (OBS-807), twice inside one hour, by two seats independently on one machine.**
    One seat swept for inherited watchers with a loop of `pgrep -f "<script>.sh"` and got **eight
    live-looking pids**; the other probed `pgrep -f "tickmarkr beat orchestrator"` and got **pid 14680**.
    **All nine were the probing shell's own argv, and one `kill -0` sweep one command later killed all
    nine at once** — no cwd resolution, no argv parsing, no per-hit judgement. Two supporting tells, both
    free: phantom pids arrive **sequential** (6781, 6786, 6791 … one per iteration of the probing loop),
    and a phantom's `argv` reads **empty** by the time you inspect it.
    ⛔ **Both seats were following this skill's own previous text correctly when they produced a phantom.**
    That text named `pgrep -f` as the *remedy* for `grep -v grep`. A remedy with that recurrence rate is
    not a remedy; it is a second trap wearing the first one's clothes.

    **The two idioms, and the direction each one lies in — you still need to know these, because the
    liveness test tells you a hit is REAL, not that it is YOURS:**
    - `ps … | grep <token> | grep -v grep` fails toward ***not there***. A poll-grep watcher carries the
      word `grep` in its own argv, so the filter whose job is removing the *probing* grep removes the
      *watched* one. Measured 2026-08-06 against a positive control (OBS-415):
      `ps -eo pid,ppid,etime,command | grep -F <token>` returned **4 matches**, and adding `| grep -v grep`
      returned **0**. The seat concluded its watcher had died silently, reported that to the operator, and
      filed it as a defect — and was corrected forty minutes later when the watcher fired normally, having
      been alive throughout. Two hypotheses (`ps` truncation; multi-column truncation) were formed and
      killed by measurement first, and the first falsification was itself run against the wrong `ps` form.
    - `pgrep -f <token>` fails toward ***there twice***, because it matches the **argv of the shell running
      it**. Measured 2026-08-25: a load-ceiling wake was investigated, a second `npm test` "outside the
      gate's worktree" was found, and it was the probe; the escalation would have been a false
      contamination alarm during a task's last attempt. **This is the worse direction, because *there
      twice* gets ACTED ON** — reported to the operator as a defect, or swept.

    **FALLBACK, for a hit that SURVIVES two reads and still might be yours:** resolve each surviving pid's
    own `cwd` (`lsof -a -p <pid> -d cwd`) and count only what belongs to the tree you are asking about, or
    match a pattern the target has and the probe cannot — the binary's real path rather than the words you
    typed. This costs one `lsof` per candidate plus a judgement call, which is why it is second and not
    first: after two reads there are usually no candidates left to spend it on.

    ⚠ **AND A ZERO IS NOT ABSENCE UNTIL A POSITIVE CONTROL SAYS SO.** Rule 11 demands this of every guard
    whose failure is silence, and a process probe is exactly that guard: *no matches* and *my filter is
    broken* are byte-identical outputs. **Before you report a watcher dead, a tree clean, or a machine
    idle, run the same probe once against something you KNOW is alive** — a watcher you just armed, a
    `sleep 300` you just launched — and see it come back non-empty. The `grep -v grep` case above was
    caught by exactly this and by nothing else.
    The general rule: **an exclusion filter is exactly as
    dangerous as an over-broad inclusion filter, and it fails in the direction that reads as "not there" —
    which is the direction that gets acted on.**
    Two corollaries: **handling a fire-and-exit watcher's wake and re-arming it are the same act.** The wake
    handling line is incomplete until it names the new recorded pid and two successful process-table reads;
    never defer the arm to the turn's end. And **a handoff that re-arms one tier's watchers must say which
    tier's it did NOT re-arm.**
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
    ⚠ **AND THE COMMONEST WRONG INPUT IS A BASE REF: after the first merge, a task's diff against the
    run's `baseRef` is NEVER that task's diff.** Workers branch from the INTEGRATION TIP, so once any task
    has merged, `git diff baseRef..HEAD` in a later worktree reports that task PLUS every task merged
    before it, and the number looks entirely plausible. Diff from the task's OWN base — the integration
    commit it branched from — and say which base you used whenever you quote a size.
    **Measured 2026-08-28 in one run, twice, in both directions.** A supervising seat quoted "712
    insertions across 7 files" for a task whose real contribution was **300 across 2**; the surplus was two
    other tasks' merged work. On the next task the same trap was **larger** — 920 across 11 versus a true
    167 across 4 — and it was caught only because the other tier had just been burned by it. A scope
    judgement, a cost claim, or a review-size argument built on the baseRef diff is measuring three tasks
    and calling it one.
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
    **And it arrives SIDEWAYS as often as from above: a REVIEWER'S SUPPLIED FIX is itself an unreviewed
    artifact.** When a review returns not just findings but *replacements* — rewritten criteria, corrected
    clauses, patch text — those enter carrying the authority of the scrutiny that produced them, and every
    party downstream treats them as the OUTPUT of review rather than an input requiring it. **A corrective
    artifact is the least-audited thing in a repair pipeline.**
    **Measured 2026-08-07.** A cross-vendor review supplied 40 replacement criteria. An authoring seat
    applied them byte-exact — correctly, having been told to defend the original wherever it disagreed —
    and one replacement was **unsatisfiable against a schema the reviewer had never opened**: it demanded a
    task id carrying wide/combining Unicode where the schema restricts ids to `^[A-Za-z][A-Za-z0-9_-]*$`
    and the named production entry revalidates on load. It was the **fourth** unsatisfiable universal of
    that milestone and it was **introduced by the fix for the first three.**
    Two things follow, and the second is the cheap one:
    - **Re-run the sweep the finding came from, against the fix.** A repair pass is where new instances of
      the class enter — many clauses rewritten at once, several near a hard bound, compressions made under
      a ceiling.
    - **Send the confirmation round BACK TO THE SEAT THAT FOUND THE DEFECT**, not to a fresh one. It is the
      stated exception to one-fresh-pane-per-round and this is what earns it: the author recognised its own
      work and said so unprompted — *"this is my round-1 replacement defect, not a misapplication."* A
      stranger would have had to re-derive the whole artifact to reach the same place.
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
    ⚠ **AND NAMING THE SUBJECT SET IS STILL NOT ENOUGH — the hazard also arrives from the opposite
    direction.** A criterion that named its subjects correctly, twice, by hash and by enumeration, was
    voided anyway when two of those subjects were re-scoped underneath it hours later (OBS-804): not a
    document reaching for new work, but **the work moving out from under a document that has no way to
    notice.** So a pre-commitment states a THIRD thing — **what VOIDS it** — and the seat that re-scopes a
    named subject names the sealed documents it just invalidated. Form and both duties:
    *The release criterion, and the two clauses without which it grades work it never saw*, above.
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
26. **A QUEUE ASSEMBLED BY READING THE PREVIOUS QUEUE CANNOT RECOVER WHAT THE PREVIOUS QUEUE DROPPED.**
    Scoping a milestone from the queue alone inherits every omission silently, and an omission has no line
    to object to. **Read the most recent SHIP AUDIT beside the queue, and diff them.**
    **Measured 2026-08-07.** A `tickmarkr watch` redesign was signed off, then a ship audit classified it
    *"standing in for the product … not named in Seed 1"* — the audit **explicitly noticed it had not been
    queued** — and it still reached no queue. Two milestones shipped over it. The operator found it by
    looking at his own screen: *"two watchers and none of them is the new redesign."* The same audit
    carries **seven** such scripts, one of them noting *"nobody has noticed this one."*
    An audit that names a gap **is not a queue**. Every entry it classifies as standing in for the product
    gets one of three written answers — **queued, shipped, or no-ship with the condition that removes it** —
    and *"recorded in an audit"* is none of them.
27. **THE SEAT THAT RECORDS IS NOT THEREBY THE SEAT THAT SHIPS.** `.planning/`, `.tickmarkr/`, `.overseer/`
    and `~/.claude/` reach **nobody**; the tarball is `files: [dist, schema, skills, fixtures]`. A ruling,
    an observation and a memory entry are all invisible to users, so a lesson written only there is a
    lesson the next operator re-earns at full price.
    **Ask of every finding, at the moment it is made: which of `src/**` or `skills/**` carries this?**
    If the answer is neither, it is operator-local and must say so in writing **with the condition that
    changes it.** Prefer `src/**` — a rule in prose is obeyed by whoever read it, while a rule in code is
    obeyed by everyone. `skills/**` is the right home only for what the runtime genuinely cannot enforce,
    such as a host modal the harness cannot see.
    **And do not let a live run become the reason to defer the write.** Verify the claim instead of
    assuming it: no task owning the tree, a clean checkout, and workers running off a pinned `baseRef` in
    their own worktrees means a `skills/` commit is invisible to the run — which is exactly what a check
    showed after this seat had already deferred one on the strength of a plausible worry.
28. **A VERDICT APPLIES TO A CLAIM, NOT TO A CELL.** A drill that verifies one sentence lends its verdict
    word to whatever shares the row, and the undrilled half then travels with the authority of the drilled
    half. **Split a cell into its claims before you rely on any of them, and ask of each: was THIS the one
    that was tested?**
    **Measured 2026-08-07.** A recount marked rank 5 *"KEPT, corrected"* in the **verified** column, and the
    cell said two things: *it catches OBS-409* (drilled — true) and *"no product change prevents"* OBS-410
    *because the statusline is operator-local* (never drilled — **false**). The premise was right and the
    inference was wrong: operator-local means the product currently offers nothing to call, not that
    nothing can reach it. The remedy — `status` emitting a compact line an external statusline can call, so
    journal interpretation happens once inside the product — was invisible for as long as the cell read as
    settled. **A second seat then re-derived the drilled half, found it true, and inherited the other half
    unexamined**, which is how one undrilled inference survived two independent reviews.
    A verdict is not a property of a table row. Ask which claim earned it.
29. **A HEARTBEAT THE OTHER TIER CANNOT FIND IS NOT DISK-READABLE LIVENESS.** Writing a beat file proves
    nothing if the seat that must read it has to be told where to look; that is a report with extra steps,
    and it fails in the direction that reads as *dead*.
    **Measured 2026-08-07.** An orchestrator armed four watcher tiers with fresh beat files and reported
    them armed. The supervising seat probed from disk and the process table, found nothing, and correctly
    concluded nothing was armed — the beats were in a session-private scratchpad only the writer knew. The
    same hour, a fifth tier never beat at all because its supervisor had been launched before the argument
    that enables it, and **armed-and-blind is byte-identical to armed** from the writer's side.
    **Write beats to a conventional path inside the repository the other tier already reads**, one file per
    tier, and state the path when you report. Then have the reader name the tiers that are ABSENT, never
    the ones present: a list of what IS armed is producible by a seat whose watchers are all dead.
    **And a beat OUTLIVES its mission unless something sweeps it.** Namespace beats per phase/leg and
    sweep them at stand-down: measured 2026-08-17, a beats directory held SEVEN stale beats from prior
    phases beside four live tiers, and a stale beat beside live ones reads as coverage to anyone globbing
    the directory — the outliving-its-trigger failure (rule 11) in file form. Only age distinguishes a
    frozen beat from a live one, so the reader states ages, and the writer removes what it retires.
30. **A JOURNAL WATCHER ON A RESUMABLE RUN MUST SCOPE TO THE CURRENT ENGAGEMENT.** A resumed run's journal
    still contains the PREVIOUS `run-end`. A watcher that greps the whole file for its terminal event finds
    that old one immediately, concludes the run is over, and exits — on every resume, which is exactly when
    supervision matters most. Capture the journal's line count when you arm, and read only what follows.
    **Measured 2026-08-07.** An orchestrator re-armed four tiers over a live resume and reported them
    armed. The watcher exited instantly on the prior `run-end`, its supervisor re-execed it into the same
    instant exit every five seconds, and then the supervisor's own loop condition ended it. What caught it
    was not the process check — it was that the heartbeats were **STALE rather than ABSENT**: files present,
    ages climbing 38s → 63s. A frozen beat and a live beat are the same file; only the age distinguishes
    them, which is why [29] says to read the age and why a status must carry both polarities.
    **The general rule this instance serves: a watcher keyed on a HISTORICAL record reads history as
    current state.** Ask of any terminal condition — could this have been true before I armed? If yes, the
    watcher is not watching, it is remembering.
31. **A DIGEST OF A LIVE RUN IS STALE AT THE MOMENT IT IS WRITTEN, AND ITS MTIME WILL HIDE THAT.**
    Authoring a successor spec — a restart, a next milestone, a re-scope — from a hand-maintained summary
    of findings works only while nothing is still producing findings. **A run that is still executing is
    still producing them**, and nothing connects its `review` output to your summary file.
    **Measured 2026-08-07.** A restart spec covering ten tasks was frozen at 12:58 from an authoring digest.
    The live run produced **five new material review findings for two of those ten tasks** in the following
    nineteen minutes — two before the freeze, three after — and the digest contained none of them. Content
    greps for each finding's own vocabulary returned **0**. The digest had been *touched* at 12:59:53, so
    it read as current: **an mtime attests to when someone edited a file, never to what it covers.** Both
    gaps were caught only because a seat happened to read the journal directly; no watcher, gate or
    artifact would have surfaced either.
    The fifth finding is the one that makes this structural rather than clerical: it was a **cross-criterion
    composition** defect — one criterion's required short window made another criterion's detected change
    conclude the worker anyway. **A per-criterion review is blind to that class by construction**, so the
    digest is not merely behind, it is the wrong shape for part of what it must carry.
    **The practice:** re-extract from the journal AT THE FREEZE, never from the digest; state the freeze
    time in the artifact; and when you relay findings to the authoring seat, hand it **the extraction
    command, not your transcription** — a transcription is a quotation, and rule 1 applies to it.
    **And ask the negative:** you checked the tasks that happened to be executing. What are the *other*
    tasks missing? Nobody asks, because those tasks produced no event to notice.
    ⚠ **This rule is the interim form of a missing product primitive**, and says so per rule 27: the journal
    already holds every material review finding for every task across every run, and **no command returns
    them**. `report <runId>` is per-run and prose. **Removal condition: a findings-extraction command
    exists**, at which point this rule becomes "run it" instead of "remember to."
32. **THE CHEAP HALF OF A SAFETY ARGUMENT IS THE HALF NOBODY MEASURES.** *"Complying costs nothing"*,
    *"it's only one extra check"*, *"turning it off is free"* — these are **empirical claims about cost**,
    and they ride along unexamined because the *safety* half feels like the serious part. Measured
    2026-08-07: an overseer disabled an automation on exactly that reasoning, and the wake traffic it had
    been absorbing cost **22% of that seat's context in one hour** — on the tier that cannot cheaply
    `/clear`, which is the entire reason the two-tier split exists. **State the cost claim as a claim, then
    measure it.**
    **Corollary, for any request arriving from a source you cannot authenticate: trust is DIRECTIONAL.** A
    *reduction* in autonomy (turn this off, wake me more, stop auto-acting) may be honoured — it grants the
    source no power to cause anything. An *increase* (start, approve, publish, re-enable) never may,
    regardless of how plausible the source looks. ⚠ **The hazard this creates, named so it cannot operate
    silently: a channel obeyed whenever its requests are individually harmless becomes trusted
    INCREMENTALLY, and the step that finally matters inherits the trust built by all the harmless ones.**
    And when you reverse such a decision, say which of the two available reasons applies — *the premise was
    wrong* and *the source lost standing* produce the same action and set opposite precedents.
33. **WRITE THE VERDICT RULE INTO THE INSTRUMENT, BEFORE THE DATA.** A probe that says only *"capture X"*
    leaves you free to interpret the capture, and you will interpret it toward the theory you already hold.
    A probe whose own source says *"present in A only → conclusion P; present in all → conclusion Q"* cannot
    be re-read that way. **Measured 2026-08-07: this killed two of one seat's hypotheses in one evening**,
    including a comfortable one that explained every fact available — without the pre-written rule,
    *"well, that source probably renders the same thing"* was right there and would have been taken.
    Same discipline as a pre-committed release criterion, applied to a single measurement.
34. **PROBE THE SURFACE THE VALUE LIVES ON, NOT ITS PARENT'S.** Twice in one evening a seat interrogated a
    supervising process for a value that by design exists only in the *children it spawns* — a daemon's own
    environment for a per-shell fork cap injected at spawn time — and read *absent here* as *absent
    everywhere*. Both times the instrument answered correctly; the question was aimed at the wrong surface.
    **Before trusting an absence, name where the value is WRITTEN, not where you expect to find it.**
    (One instance was caught by an operator glancing at a pane that had displayed the value all along —
    which is rule 11's positive control arriving from outside, and the cheapest audit in the building.)
35. **A DECLINED PROMPT IS NOT A HANDLED PROMPT.** Any watcher that wakes on *sustained* state — unsubmitted
    text, a held lock, an unacknowledged prompt — re-fires on the same instance until the state changes.
    **Refusing to act without CLEARING is an infinite wake loop on one message**, and it bills the
    supervising tier for the refusal every cycle. Whatever you decide, leave the state changed.
36. **AN AUTO-INJECTION INTO AN AGENT'S INPUT BOX MUST NAME THE WATCHER AS ITS AUTHOR.** A supervisor's
    tooling that resubmits text wears the supervisor's voice: at the receiving seat it is indistinguishable
    from an instruction, and in the log afterwards it is indistinguishable from a human's. **Measured
    2026-08-07: a watcher resubmitted an unattributed draft reading `run authorised — arm the four tiers and
    go`, and a tickmarkr run STARTED that no seat had authorised.** The refusal list built to prevent
    exactly that was a denylist of phrasings and the phrasing missed it.
    Three things follow. **Prefer an ALLOWLIST of provably inert shapes** (a notification request can be
    submitted by anyone; an instruction cannot) — a denylist must enumerate every phrasing of every
    dangerous act and will be patched after each escape, forever. **Mark the injection with the watcher's
    identity**, so no record can later attribute it to a person. And **when an injected line agrees with
    what you were about to decide, that is the dangerous case, not the safe one** — a line that contradicts
    you gets caught; one that agrees gets executed and remembered as your own decision.

37. **A TASK THAT CHANGES AN OBSERVABLE CONTRACT GETS SPIKED BEFORE ITS `files[]` IS SCOPED — AND THE
    SPIKE'S REDS ARE THE BLOCKER SET. A SWEEP IS NOT.** An observable contract is execution order,
    event-stream order, a diagnostic or output SET, a CLI surface, a serialised format, or a timing
    measurement. Implement it as a **throwaway spike**, run the **FULL** suite, read the reds, *then*
    scope. Adopted 2026-08-30 (RULING-219-11). **All four parts ship together or the rule is misapplied:**
    - **The trigger question:** *could a test this task does not own be asserting the thing I am changing?*
      **"I'd have to grep to know" is a YES.**
    - **The caveat:** a spike measures **ONE implementation**. It converts *unknown* → *measured for one
      specimen*, never *unknown* → *known*. **A worker taking a different route can still red on unowned
      collateral, and that is still a PLAN defect, never a retry.**
    - **The MEASURED cost: 518 s implement + 831 s suite = 1,348 s ≈ 22.5 min.** ⛔ ***"Far cheaper" is
      WITHDRAWN.*** Run 3131 died at ~20 min, so **on the direct leg the two are EQUAL**; the spike wins
      only on what it AVOIDS downstream — a halt, a sweep, a re-scope, five rulings, a second compile and
      plan. ⚡ **Therefore it pays only where a late plan defect is EXPENSIVE TO UNWIND.** Where a defect
      would surface and fix cheaply, **the spike is pure overhead: do not run it.** That the economics and
      the trigger name the same class, derived independently — one from a stopwatch, one from a taxonomy —
      is the best evidence this rule is real, and it is why neither half may be quoted without the other.
    - **The sweep matrix, as the REASON a better sweep is not the remedy** (RULING-219-09): concept **2/3**,
      symbol **1/3**, union **3/3 on files but only 2/3 on ACTIONABLE SIGNAL** — `gate-telemetry`'s single
      symbol hit is an order-INSENSITIVE sorted comparison at `:54` that correct triage *discards*, while
      the failing test at `:101` references it not at all. ⚠ **Rigorous triage makes that discard MORE
      likely, not less.** The sweep does not fail from sloppiness, so it cannot be fixed with care.

    **Corroboration from the same halt:** of 13 stale-order carriers, the **9** answered from real
    execution were all proven; the only **2** labelled *"inspection, not execution"* were exactly the 2 the
    suite never reached. **Evidence quality tracked execution coverage with no exceptions**, while every
    sweep-based estimate — *"~15"*, *"13"*, *"union 3/3"* — was wrong, and one 512 s suite run gave the
    right answer (**3**) first time.
