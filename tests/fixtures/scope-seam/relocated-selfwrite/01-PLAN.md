---
phase: relocated-selfwrite
plan: 01
type: execute
wave: 1
depends_on: []
files_modified:
  # STALE-BY-RELOCATION, in miniature: the literal names the SUMMARY under an OLD (archived-away)
  # directory that is NOT this fixture's own dir. Today the bare directive joins against THIS dir
  # while files_modified names the OLD dir → divergent → throws (over-fire). After the HARD-09 fix,
  # the basename fallback sees files_modified contains an entry ending with "/01-SUMMARY.md"
  # → compiles clean (relocation-invariant). The stale dir literal points at an archived-style path,
  # NEVER a live phase directory under the active phases tree (HYG-06 fragility class — Phase 44).
  - .planning/milestones/v1.0-phases/99-relocated-away/01-SUMMARY.md
autonomous: true

must_haves:
  truths:
    - "A bare write directive whose basename IS listed in files_modified under a stale (relocated-away) directory literal compiles clean via the relocation-invariant basename fallback."
---

<objective>
Vendored trap: a bare-filename write directive whose basename IS listed in files_modified, but under a stale directory literal that is NOT the plan's own dir (the over-fire shape, in miniature). Throws today; compiles clean after the HARD-09 basename fallback.</objective>

<tasks>

<task type="auto">
  <name>Trap task</name>
  <action>Write `01-SUMMARY.md` describing the trap result.</action>
  <done>Document the relocated-selfwrite trap in the plan's SUMMARY.</done>
</task>

</tasks>
