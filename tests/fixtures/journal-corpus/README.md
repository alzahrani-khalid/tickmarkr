# journal-corpus — vendored pre-v1.13 journal corpus (Phase 46, D-04 obligation 2)

Provenance: byte-for-byte copies of `.tickmarkr/runs/<runId>/journal.jsonl` for all 31 runs on disk
at Phase 46 plan time (run-20260708-014223 … run-20260712-010826, 1,497 lines total), vendored
2026-07-12 from the tickmarkr repo at commit 9695b31's working tree. Vendored at PLAN time because
(a) tickmarkr worktrees cannot see the gitignored live `.tickmarkr/runs/` and (b) the corpus must be
frozen PRE-v1.13 — runs created while executing Phase 46 itself must not enter the compat oracle
(HYG-06: never fixture against live, mutating state).

`expected-statuses.json` is the machine-generated output of TODAY's (pre-Phase-46)
`Journal.replayStatuses()` over these 31 fixtures — per runId, per taskId, sorted keys. It is the
"before" side of ROADMAP Phase 46 success criterion 3 ("old journals replay byte-identically").
Generated with tsx against `src/run/journal.ts` as of the same commit; the corpus test re-derives
the "after" side from the same fixtures and machine-diffs.

Do NOT regenerate from live `.tickmarkr/runs/` — that defeats the frozen-corpus property.
