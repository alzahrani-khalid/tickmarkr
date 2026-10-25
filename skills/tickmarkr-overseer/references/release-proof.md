#### The release criterion, and the two clauses without which it grades work it never saw

**A pre-commitment is a file. A re-scope is a different file. Nothing joins them** — so a criterion
survives its own subject's rewrite and keeps grading, which is **worse than having no criterion at all**:
it carries the authority of a seal over work the seal never saw. Both clauses below, or the join stays
broken in the direction the missing half covers.

**Measured 2026-08-30 (OBS-804).** `RELEASE-CRITERION-v2.1.8.md` was sealed at 10:18:25, nine minutes
before its run, with zero gate results in existence — an honest pre-commitment that named its trigger AND
enumerated its subject set, exactly as rule 23 demands. **Two of its four named subjects were then
materially edited underneath it**: T3 narrowed at 11:49:58, T1 rewritten at 13:37:59 — *three hours and
nineteen minutes after sealing*. The run that actually delivered the work was, in the criterion's own
vocabulary, both *"a re-plan"* and *"a follow-on run"* — **two of its own named exclusions. The document
excluded the only run that ever ran it.** Three of five clauses had already graded MET before anyone asked
the subject question, and it was caught because a downstream seat refused to decide a ruling that was not
its own — **not because any instrument detected it.**

**Every sealed criterion carries a VOID CONDITIONS section. It is not optional and it is not boilerplate:**

```markdown
## SUBJECT
<what this criterion is ABOUT — see the identity rule below>

## TRIGGER
<what fires the grading>

## CLAUSES
1. …

## VOID CONDITIONS — this document is VOID, with no ruling required, if any of these occur
- any subject named above is re-scoped, narrowed, widened, split, merged or re-owned
- the work is delivered by a run this document's own exclusions would exclude
- <the specific things that would make these clauses grade something else>
```

> **Naming a subject does not freeze it. A pre-commitment must name what VOIDS it, not only what it
> covers — and a re-scope of any named subject voids it AUTOMATICALLY, with no ruling required.**
> A void condition that needs a ruling to fire is not a void condition; it is a second thing to forget.

**⚡ ONE QUALIFICATION, PROSPECTIVE ONLY: A FUTURE SEAL MAY DECLARE THAT AN AUDITED FILES-ONLY AMENDMENT
DOES NOT VOID IT — AND THAT DECLARATION HAS TO BE IN THE SEAL, WRITTEN AT ISSUE (v2.5.7 ledger D-80, D-83;
OBS-1078).** The automatic-void rule above is QUALIFIED for seals issued after this clause, never deleted:
it still fires on its own terms for every seal that does not carry the declaration. A requirements seal may
declare, prospectively, that exactly one narrow class of change does not void it — an **AUDITED FILES-ONLY
AMENDMENT**: a recorded amendment to a task's `files[]` and nothing else, which leaves all four of these
UNTOUCHED.

1. **the ACCEPTANCE TEXT** — every criterion's own words, byte for byte, a `test:` leaf title included;
2. **the TASK IDENTITY** — which task is which: its id, its shape, its deps, the suites it owns;
3. **the RUN IDENTITY** — the run, its base and its `baseRef`, the integration branch and its tip commit;
4. **the SAFETY REQUIREMENTS** — the gates, bounds, refusals and contamination rules the run is held to.

**Replay it both ways, because the clause is a procedure and not a mood:**
- *A seal carrying that declaration, then an audited amendment adding one owned path to a task's `files[]`,
  with all four invariants read and found unchanged* → **THE SEAL IS KEPT.** No successor seal and no
  re-grade of what it already sealed: the declaration was the seal's own pre-commitment about this exact
  change, made before the change existed — the only moment such a commitment can honestly be made. Read the
  four invariants BEFORE ruling, and record the read beside the amendment.
- *The same seal, then an amendment that changes the RUN IDENTITY — a new run id, a re-cut `baseRef`, a
  different integration tip* → **THE SEAL IS VOID, on its own declaration's terms.** Run identity is one of
  the four, so *"files-only"* does not describe that amendment; moving any one of the four puts the change
  outside the declared class, and **any other change of any kind needs a SUCCESSOR SEAL** — a new document,
  sealed before the work it grades, naming the subject as it now stands.

**Three limits, and each one has been argued around:**
- **The declaration is never retroactive and never inferred.** A seal issued BEFORE this change — one whose
  own text does not carry the declaration — **stays governed by the existing void conditions above,
  unmodified: any re-scope, narrowing, widening, split, merge or re-ownership of a named subject voids it
  AUTOMATICALLY, with no ruling required.** So *"the acceptance text never changed, therefore the seal
  still holds"* is **REFUSED** for such a seal once its SUBJECT has moved: unchanged acceptance text alone
  preserves nothing over a changed subject, because a seal grades the subject it named, not the sentences
  it happened to be written in. Retrofitting the declaration onto an already-sealed document is itself an
  amendment to a sealed subject — write the successor seal instead.
- **A files-only clause confers no amendment authority.** It says nothing about whether the amendment is
  LAWFUL: compile's unit bounds still refuse an over-bound `files[]`, and no seal can widen what compile
  will certify.
- **AUDITED means recorded, or it did not happen.** The approval row carrying the amended files, the
  before-and-after `files[]`, and the four-invariant read are what let the next seat replay your ruling
  instead of trusting it. An unrecorded *"files-only"* amendment is indistinguishable from a re-scope, and
  is voided as one.

**⚡ IDENTIFY THE SUBJECT BY WHAT THE CLAIM IS ABOUT. Half of the failure above was a category error, and
it is the cheap half to fix:** a graph hash identifies a **PLAN**, and a plan is recompiled, re-cut and
re-owned as a matter of course. **A criterion about a SHIPPED TREE names the COMMIT** — or the tag, or the
export tree hash — **never a graph hash, never a run id, never a task list.** Ask what a reader would have
to hold in their hand to check the clause: if it is bytes, name the bytes.

**⚡ A GREEN LEG BESIDE A GREEN PARENT IS NO PROOF OF THEIR UNION: THE RELEASE PROOF BINDS TO THE MERGED
CANDIDATE'S COMMIT, AND IS VOID THE MOMENT THAT SUBJECT MOVES (v2.5.7 ledger D-80, D-83; OBS-1078).** The
subject of a release proof is never *"the run"* and never *"the fix leg"* — it is the **MERGED candidate**:
the one commit that carries the run's work AND every leg merged into it. Name that commit's sha in the
proof, in the same act as the grade, and the proof is bound to that sha alone. **When the subject moves — a
later merge, a new integration tip, an amended or re-cut commit, a fresh export, a re-tag — the proof is
VOID, and the new subject is graded from scratch**, its tracked test set included, since that set is
recomputed from the merged tree and not from either parent. Two greens assembled into one verdict are two
claims about two trees that never contained each other: the union's own conflict resolutions, its ordering
and its collected test set are exactly what neither green observed — which is why `RELEASING.md` step 4
hands the grader the mirror's `HEAD` and the grader refuses a run of any other head before a single record
is downloaded. This is the void-condition duty pointed at bytes: **a proof that names no commit cannot
notice its subject leaving.**

**THE RECIPROCAL DUTY, and it is yours because you write both documents:** when you issue a ruling that
re-scopes, narrows, splits or re-owns anything, **the ruling must name every sealed document its subject
appears in** — and say, in the ruling, whether each one is now void. You are the only seat that can do
this: the criterion cannot watch for the ruling, and the product cannot know that an English document
elsewhere sealed a claim about a graph it is recompiling. **A re-scope ruling that names no sealed
documents is asserting there are none. Check before you assert it.**

#### The one operational duty that IS yours: a verdict produced under starvation is not a verdict

**Operator, 2026-08-07: *"that is the kind of job I need overseer to be vigilant about."*** Do not read the
tier rule as forbidding this. Deciding gates is your column, so **checking the conditions under which the
evidence was produced is part of ruling on it**, not run-driving.

**Measured that day, inside one run.** A worker reported *"73 concurrent vitest processes — that's the
starvation source"* while trying to explain a failure in a file it did not own. Confirmed from this seat:
load **35.26 / 44.24 / 42.35**, **65** vitest processes, **zero** orphans — so a sweep would have gained
nothing — and the oldest suite had been running **55 minutes**. Four reds were on the board and they had
completely different standing:

| red | truth |
|---|---|
| `test` — `Error: [vitest-worker]: Timeout calling "onTaskUpdate"` | **infra.** Not a test failure at all |
| `test` — `1 failed \| 210 passed`, in a file outside the task's `files[]` | **1 of 3074** under load — suspect |
| `review` — *"acceptance criterion 1 fails in the shipped path (fixture-overfit)"* | **real defect** |
| `review` — *"echo-not-implement: … never called by production code"* | **real defect** |

**Separating them is the entire skill, and the trap is symmetric.** Retrying an infra red burns an attempt
**and adds load** — the symptom fuels the cause. But a rule that discounted every red under load would have
discounted the two review findings, which are exactly the defect classes the gates exist to catch.
**Vigilance here means CLASSIFYING reds, never discounting them.**

##### On herdr (`HERDR_ENV=1`) — contamination watcher

**Arm the instrument; do not promise attention.** This seat's own law — *a watcher whose liveness depends
on its owner being free is scheduled, not armed* — applies to itself:

```bash
<skill-dir>/scripts/watch-contamination.sh <journal> <load-ceiling> <poll-s> <cap-s>
```

It wakes on a new **failed runner `test`, `build`, or `lint`** `gate-result` carrying an infrastructure
fingerprint in the runner-emitted failure lines, or on sustained load above a ceiling, and prints one
wake reason. It deliberately ignores the same tokens inside review findings, acceptance prose, and the
secondary fingerprint echo list: quoted discussion of contamination is not contamination. **Two triggers,
because one is provably not enough:** run
against the four reds above, the fingerprint trigger caught the `vitest-worker` timeout and correctly
refused to launder either review rejection — and **missed** the 1-of-3074 case, whose text looks like an
ordinary assertion failure. Only the load ceiling catches that one. A single-signal version reads as
coverage and misses the subtler half.

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

##### On Orca (`TERM_PROGRAM=Orca` and non-empty `ORCA_TERMINAL_HANDLE`) — contamination evidence

Watch journal gate-result events and load evidence through a file consumer; inspect the seat with `orca terminal read --terminal <handle> --screen --json`. Classify infrastructure failures separately from review findings and record the evidence in files.

