<!-- tickmarkr:spec -->
# wrapped-acceptance fixture

Verbatim capture of specs/v1.90-verification-honesty.spec.md T61 (run-551, OBS-488): every
wrapped criterion below compiled to its first physical line under 1.87.0 — c3's tail is the
lone word "seam". deps/floor are neutralized so the fixture compiles standalone; the
acceptance block is byte-for-byte the captured shape.

## T61: the nudge grace oracle reaches every conclusion through the seam
- goal: The carried grace-oracle mission re-authored (recorded residual: tests-shape with no src
  scope — an arm unsatisfiable under the landed law routes its fix to the classification task it
  depends on, never to an out-of-scope edit here). A production runDaemon oracle whose worker never commits exercises every
  liveness conclusion with CPU arriving only through T60's seam, and the superseded vacuous grace
  expectations in the existing worker-nudge suite are rewritten in place. Arms differ only in nudge
  delivery and classification. A status flip to blocked cannot erase an armed grace.
- shape: tests
- deps: none
- files: tests/run/nudge-grace.test.ts, tests/run/worker-nudge.test.ts
- complexity: 5
- acceptance:
  - test: with unchanged worktree and `flat` classification a delivered nudge holds its whole grace
    through a blocked status flip and concludes at expiry, while the no-nudge control concludes at
    the base deadline, so a recomputed or erased grace fails
  - test: the same oracle with `moving` classification survives both deadlines and with an
    unreadable gap survives to the rolling timeout, so any conclusion that skips the classification
    seam fails
  - judge: every worktree and CPU input in the suite arrives from the launch observation or the T60
    seam
  - judge: cite the rewritten worker-nudge expectations
