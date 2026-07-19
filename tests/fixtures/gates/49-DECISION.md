# 49-DECISION — FIN-01 (OBS-06: reroute "finisher" briefs are advisory-only)

**Verdict (stated up front):** **(a) documented-accept — FIN-01 CLOSED.** Consult-reroute briefs stay
advisory; the existing fail-closed gate chain IS the enforcement. No production code changes ship. The
"nothing to build" claim is itself checked (HARD-06 discipline) by `tests/gates/finisher-incident.test.ts`.

This file derives exclusively from one read-only oracle the worker cannot rewrite: the vendored, frozen
journal corpus `tests/fixtures/journal-corpus/run-20260711-185020.jsonl` (Phase 46 D-04, HYG-06
reference-only — do NOT regenerate from live `.drover/runs/`).

> **How to re-check any quote below.** Every fenced `jsonl` block is a byte-exact substring of the corpus,
> asserted by `tests/gates/finisher-incident.test.ts` (SC1 anti-paraphrase). Reproduce any line yourself:
> ```bash
> sed -n '44p' tests/fixtures/journal-corpus/run-20260711-185020.jsonl   # the reroute verdict
> sed -n '52p' tests/fixtures/journal-corpus/run-20260711-185020.jsonl   # the scope PASS
> sed -n '53p' tests/fixtures/journal-corpus/run-20260711-185020.jsonl   # the acceptance FAIL
> ```
> A single drifted character reddens the test — paraphrasing `OBSERVATIONS.md` cannot satisfy it (T-49-01).

---

## 1. The incident, quoted verbatim from the corpus (1-based line numbers)

**L44 — the consult-verdict `action:"reroute"` for P43-03: the finisher brief (OBS-06's "advisory" brief).**
The consult (a frontier model) routed off a channel that kept burning its window re-running the suite, onto
a "purely mechanical" finisher. This brief is the exact text OBS-06 calls "not enforced":

```jsonl
Reroute to a different, instruction-following CLI with a purely mechanical finisher brief: the worktree for P43-03 already contains the completed, verified fix — do NOT re-implement, re-measure, or re-run the full suite; inspect existing state, run only `npx vitest run tests/drivers/trailer-width.test.ts` as a sanity check, commit everything uncommitted, and emit the DROVER_RESULT trailer immediately.
```

**L45 — the consult-reroute failover-deviation** (static routing wanted `claude-code:sonnet`, the learned
profile picked `cursor-agent:composer-2.5`):

```jsonl
{"ts":"2026-07-11T18:52:43.674Z","event":"failover-deviation","taskId":"P43-03","data":{"site":"consult-reroute","static":"claude-code:sonnet","chosen":"cursor-agent:composer-2.5"}}
```

**L46 — attempt-4 task-dispatch on cursor-agent (the finisher dispatch).** The finisher promptly ignored
the brief and re-implemented + re-measured + re-ran the full suite anyway:

```jsonl
"assignment":{"adapter":"cursor-agent","model":"composer-2.5","channel":"sub","tier":"mid"},"attempt":4
```

**L48 — the worker-result `ok:true`: the finisher's success-claiming trailer.** The gates must verify this
claim independently and never trust it (drover invariant); the trailer's `ok:true` is never a pass signal:

```jsonl
{"ok":true,"summary":"Measured trailer safety down to 10 cols
```

**L52 — gate-result scope `pass:true`: the deterministic gate was structurally blind.** The finisher's
rogue edits (including `herdr.test.ts` expectations, per OBS-06) were INSIDE `task.files`, so the
picomatch scope gate passed — only the probabilistic acceptance judge stood between the rogue
re-implementation and a merge:

```jsonl
{"ts":"2026-07-11T19:03:48.129Z","event":"gate-result","taskId":"P43-03","data":{"gate":"scope","pass":true,"details":"all 27 changed files in scope"}}
```

**L53 — gate-result acceptance `pass:false`: the provenance gap that actually caught the incident.** This
is the byte-exact `"gate":"acceptance","pass":false` record, and the substance of the failure — the
finisher's re-implementation drove a headless `claude -p` probe through a pane instead of the real
interactive TUI, so the measurement could not exhibit the very hard-wrap failure the task was about:

```jsonl
"gate":"acceptance","pass":false
```

```jsonl
the probe ran `claude -p ... --output-format text` (headless) in the pane — not the agent's interactive TUI
```

**L54 / L61 — escalation, then a second consult-verdict corroborating that attempt 4 failed on substance**
(not on a process/pacing technicality):

```jsonl
"step":"escalate","attempt":5
```

```jsonl
attempt 4's trailer-emitting run failed acceptance on substance
```

---

## 2. Both-sides rationale (weighed honestly, not pre-decided)

### FOR (a) documented-accept

- **The acceptance gate DID catch the incident (L53).** No harm merged. The system worked exactly as
  designed: a rogue finisher produced defective work, and the substance-checking judge failed it on a real
  provenance gap (`headless` probe, not the interactive TUI) — not on a process technicality.
- **"Gates never trust workers" is already the enforcement doctrine** (CLAUDE.md invariant;
  `src/gates/scope.ts` HARD-08 comment; the whole gate chain re-verifies every claim). A consult brief is a
  routing *recommendation* from a frontier model, not a contract drover enforces against the worker. The
  outcome is verified (acceptance), not the process (did the worker follow the brief).
- **The L52 blind spot is narrower than it looks.** A finisher scope profile (b) would catch "edited a file
  outside the finisher allowlist" — a *proxy* for harm. The acceptance gate checks the *actual* harm: does
  the diff substantively satisfy every criterion? In this incident the rogue edit produced a headless probe
  that acceptance rejected on substance. A finisher whose rogue work happens to be substantively correct
  has, by definition, produced work that passes the bar drover actually enforces.
- **(b) carries real enforcement cost on a milestone-shared seam.** It requires: a `daemon.ts` touch on
  the consult-reroute path (this milestone's most-contended file — the Phase 48 ONE-PLAN collision rule was
  *specifically* about `daemon.ts`), pre-finisher worktree HEAD capture (new mutable state), a
  `scopeGate` profile param (a new seam on the gate), AND additive-only journal data so the 31-fixture
  corpus replays byte-identically. That is a substantial surface for a LOW-severity, **once-observed**
  incident that was already caught.
- **Ponytail bias.** The simplest thing that works IS the existing gate chain. HARD-06 precedent (v1.11):
  a mutation-proven no-op close is a legal outcome — provided the close is itself checked. §3 is that check.

### FOR (b) finisher scope profile

- **L52 proves the deterministic gate was structurally blind.** The finisher's edits were inside
  `task.files`, so only the probabilistic LLM judge stood between the rogue re-implementation and a merge.
  A diff-vs-pre-finisher-HEAD profile is deterministic and cheap, and would have reddened at L52 on the
  `herdr.test.ts` expectation edits.
- **The seam is real and localized.** `daemon.ts` already journals `consult-verdict` + `failover-deviation`
  on reroute, so tagging the next dispatch is additive; `scopeGate` already takes `baseRef`, so a second
  call with a pre-finisher HEAD + allowlist is a contained extension.

### The weighing — why (a)

The decisive fact is that the incident was caught by the *deeper* check. (b)'s deterministic profile would
have caught the *proxy* (an out-of-allowlist edit) earlier at L52; (a)'s acceptance gate caught the
*substance* (defective work) at L53. Drover's entire architecture verifies outcomes, not process — a
finisher brief is advisory by design, and the moment we start enforcing process-fidelity to a consult's
prose we are no longer "gates never trust workers", we are "gates trust the consult's brief". The blind
spot (a) accepts is real but narrow: it is only reachable when a finisher's rogue work is **both**
in-`task.files` **and** substantively satisfies `acceptance[]` — at which point the work passes the bar
drover actually enforces. The cost of (b) — a daemon.ts seam, new journal state, a gate profile param, and
a corpus-replay compat surface — is not justified for a LOW-severity, once-observed, already-caught
incident. Accept, document the ceiling, and revisit only if a second OBS-06-shape incident lands.

---

## 3. The recorded decision

**(a) documented-accept.** FIN-01 is CLOSED. Consult-reroute briefs stay advisory; the fail-closed gate
chain (build → test → evidence → scope → acceptance → review) IS the enforcement. No production code
changed: `src/gates/scope.ts`, `src/run/daemon.ts`, `tests/gates/scope.test.ts`, and
`tests/run/daemon.test.ts` are byte-untouched (see `49-01-SUMMARY.md` for `git diff --stat`).

**Ponytail ceiling (named):** a future finisher whose rogue work happens to (i) stay inside `task.files`
AND (ii) substantively satisfy every `acceptance[]` criterion will merge — because, by definition, it has
produced work that meets drover's enforced bar. The deterministic scope gate cannot see in-`task.files`
rogue edits (L52); only the acceptance judge stands in that path, and a judge is probabilistic. This is
the accepted trade for not adding a finisher-specific seam to the milestone's shared `daemon.ts`.

**Revisit trigger:** a second OBS-06-shape incident (a rerouted finisher ignoring its brief, passing scope
on in-`task.files` edits, and either merging or only being caught by acceptance) reopens this decision
toward (b). Until then, the doctrine in `docs/finisher-enforcement.md` governs.

### What shipped for (a)

- `docs/finisher-enforcement.md` — the doctrine (consult briefs are advisory; gates are the enforcement;
  ceiling + revisit trigger).
- `tests/gates/finisher-incident.test.ts` — the HARD-06 "nothing to build is itself checked" pin:
  - SC1 corpus byte-match (L44/L45/L46/L48/L52/L53/L54/L61),
  - SC1 anti-paraphrase (every fenced `jsonl` block here is a byte-exact corpus substring),
  - SC4 incident-shape red-capability: build/test/evidence/scope green + worker `ok:true` + judged
    `pass:false` → `runGates` FAILS (nothing merges); the same fixture with `pass:true` passes — the
    judged verdict is the SOLE backstop, exactly the enforcement (a) accepts. The worker's
    success-claiming trailer never overrides the gate.

### What stayed byte-untouched (the unchosen branch's files)

`src/gates/scope.ts`, `src/run/daemon.ts`, `tests/gates/scope.test.ts`, `tests/run/daemon.test.ts` — no
finisher profile, no dispatch tagging, no pre-finisher HEAD capture, no `scopeGate` signature change. The
31-fixture corpus replays byte-identically by construction (nothing in the journal/replay path changed).

---

## 4. Failure doctrine (negative check)

The verdict in §3 is not narration — it is the logical consequence of the artifact facts in §1. Had **any**
of the following held, (a) would be **wrong** and FIN-01 would reopen toward (b):

- L53's acceptance gate had **passed** (the rogue finisher's defective work would have merged on a
  probabilistic judge's pass with no deterministic backstop — the L52 blind spot made real);
- the SC4 incident-shape pin could not be made red-capable (i.e. the gate class that caught the incident
  could be weakened later without a test reddening — T-49-03);
- a second OBS-06-shape incident were already on record (one is a data point; two is a pattern that
  overrides the ponytail bias);
- (b)'s cost were dominated by a seam that does not exist (it is not — the daemon/gate seams are real,
  which is exactly why the decision is "accept and document the ceiling" rather than "the cost is
  illusory").

This section is doctrine text only; the pass derives solely from the on-disk artifacts quoted in §1 and the
red-capable pin in `tests/gates/finisher-incident.test.ts`.
