# Sample project — vendored GSD fixture input

This file exists so the sibling phase's `07-01-PLAN.md` can cite a repo-relative `<context>` path that
is **part of the fixture itself**. It previously cited `.planning/PROJECT.md`, which resolved only
inside the private development checkout: the public export strips `.planning/` at any depth, so the
compiler's context-reachability refusal (v1.96 T3) correctly failed eight tests on the exported tree
and the release ritual's pre-tag proof caught it. A vendored fixture must carry its own inputs.

Nothing here is read by an assertion — the fixture only needs the path to resolve. The prose stands in
for the project brief a real GSD plan would point a worker at.

## Objective

Ship a small feature end to end, with each plan in the phase owning one objective sentence.

## Constraints

- One plan, one objective.
- A plan's `<context>` block promises the worker can read every repo-relative path it lists.
