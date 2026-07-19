---
phase: defective-bare
plan: 01
type: execute
wave: 1
depends_on: []
files_modified:
  # NOTE: no entry equals "01-SUMMARY.md" or ends with "/01-SUMMARY.md".
  # `99-01-SUMMARY.md` ENDS WITH the bare name as a substring but is a NEAR-MISS:
  # it equals "99-01-SUMMARY.md", not "01-SUMMARY.md", and does not end with "/01-SUMMARY.md".
  # This is the seed for Task 2's substring-containment drill (Drill B): under a correct
  # basename-precise fallback it throws; under a loose `f.includes(bare)` it would pass (bug).
  - tests/fixtures/scope-seam/defective-bare/99-01-SUMMARY.md
  - tests/fixtures/scope-seam/defective-bare/notes.md
autonomous: true

must_haves:
  truths:
    - "A bare write directive whose basename matches NO files_modified entry (not even by substring near-miss) is rejected — the fallback is basename-precise."
---

<objective>
Vendored trap: a bare-filename write directive whose basename is matched by NO files_modified entry (including a deliberate substring near-miss) must keep throwing, today and after the HARD-09 fix.</objective>

<tasks>

<task type="auto">
  <name>Trap task</name>
  <action>Write `01-SUMMARY.md` describing the trap result.</action>
  <done>Document the defective-bare trap in the plan's SUMMARY.</done>
</task>

</tasks>
