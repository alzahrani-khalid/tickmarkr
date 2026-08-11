<!-- tickmarkr:spec -->
<!-- provenance: v1.89 T41 amendment 10422761 repaired the stale 52/64 asserting-test catch-22 -->

## T41: Render the normalized numerator
- goal: Change the stale demo gate numerator to its normalized value
- files: src/tui/cockpit/derive.ts, tests/compile/authoring-lints.test.ts
- acceptance:
  - judge: the tracked demo renders `52/64` after skipped outcomes leave the pass numerator
