<!-- tickmarkr:spec -->
<!-- provenance: the shape of .planning/phases/99-arabic-coverage as compiled on 2026-08-18 into
     run-20260818-185710-0000000000000011 (41 tasks). OBS-535's fix — files[] is write scope, not
     payload — was measured against that graph (41 unreadable-payload lints to 0; 31 overflow lints
     when the window is forced to 50k) and against nothing in this repo, because no fixture carried
     its shape. This one does, at five tasks instead of forty-one.

     The four shape features that made every task on that graph skip its context-window comparison,
     each present below:
       1. a brace-glob write scope (`scripts/{a,b}`) — a set, not a document; unmeasurable as one file
       2. an output declared in files[] (`*-SUMMARY.md`) — absent from the base tree BY CONSTRUCTION
       3. a wave-1 artifact consumed by a TRANSITIVE dependent (T3 reads what T1 writes, via T2)
       4. the same artifact cited by a task with NO producer upstream (T4) — the actionable class,
          which on the real graph was 17 tasks citing a self-gitignored tree (RULING-P99-14)
     T5 adds the class no commit can ever satisfy: a ref under a gitignored directory.

     Compile this fixture from a NON-REPO directory. compileNative's context reachability check
     (native.ts:684) fails open when git cannot answer, and T3/T4/T5 deliberately cite paths absent
     from any base tree — that absence is the fixture's whole subject. -->

## T1: Land the instruments the later waves measure with
- goal: Write the two audit instruments and this task's own summary, so a later wave has something to read
- shape: implement
- files: scripts/{audit-strict.mjs,census.mjs}, .planning/payload-shape/T1-SUMMARY.md
- context: docs/payload-shape/PLAN.md
- complexity: 3
- acceptance:
  - command: node -e "process.exit(0)"
  - judge: both instruments exist and the summary records what they measured

## T2: Rewrite the localisation sources the instruments flag
- goal: Apply the instrument's findings across the localisation sources named in the write scope
- shape: implement
- deps: T1
- files: src/i18n/{ar/common.json,en/common.json,ar/dossier.json,en/dossier.json,ar/intake.json,en/intake.json,ar/tasks.json,en/tasks.json,ar/settings.json,en/settings.json}, .planning/payload-shape/T2-SUMMARY.md
- context: docs/payload-shape/PLAN.md, scripts/audit-strict.mjs
- complexity: 5
- acceptance:
  - judge: every key src/i18n/ar/common.json shares with its en counterpart carries a non-empty Arabic value, and .planning/payload-shape/T2-SUMMARY.md records the count it rewrote

## T3: Close the census the second instrument opens
- goal: Read the census instrument written two waves back and close its remaining senses
- shape: implement
- deps: T2
- files: src/i18n/{ar/common.json,en/common.json}, .planning/payload-shape/T3-SUMMARY.md
- context: docs/payload-shape/PLAN.md, scripts/census.mjs
- complexity: 4
- acceptance:
  - judge: the census reports no unresolved sense for any rewritten key

## T4: Report on the audit without depending on the task that writes it
- goal: Summarise the audit's findings for the operator record
- shape: chore
- files: .planning/payload-shape/T4-SUMMARY.md
- context: docs/payload-shape/PLAN.md, scripts/audit-strict.mjs
- complexity: 2
- acceptance:
  - judge: .planning/payload-shape/T4-SUMMARY.md states both the flagged-site count and the total key count it was measured against

## T5: Apply the standing ruling to the rewritten sources
- goal: Enforce the ruling's terminology decisions across the sources T2 rewrote
- shape: chore
- deps: T2, T3
- files: src/i18n/{ar/common.json,en/common.json}
- context: docs/payload-shape/PLAN.md, .state/RULING-TERMINOLOGY.md
- complexity: 2
- acceptance:
  - judge: no file under src/i18n/ar contains the string "Dossier" or "Engagement" in Latin script
