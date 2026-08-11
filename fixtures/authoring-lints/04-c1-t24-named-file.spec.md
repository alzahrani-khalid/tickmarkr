<!-- tickmarkr:spec -->
<!-- provenance: v1.89 T24 amendment 46e744bf repaired the vacuous-grace asserting-test catch-22 -->

## T24: Replace the vacuous grace oracle
- goal: Replace the helper-only grace proof with the production daemon oracle
- files: src/run/daemon.ts, tests/compile/authoring-lints.test.ts
- acceptance:
  - judge: `tests/run/worktree-evidence.test.ts` carries the production runDaemon differential
