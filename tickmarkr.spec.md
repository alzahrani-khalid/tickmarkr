<!-- tickmarkr:spec -->
# tickmarkr native spec

Your starting point for a tickmarkr native spec. Edit this file, then run:
  tickmarkr compile tickmarkr.spec.md && tickmarkr plan && tickmarkr run

Each task is a "## Tn: Title" heading with "- field: value" bullets.
acceptance is required on every task (a nested list of observable outcomes).

<!--
  Fields available per task:
    goal:        outcome the task must achieve (defaults to the title if omitted)
    shape:       plan | spec | implement | tests | docs | migration | ui | refactor | chore
                 (auto-inferred from the title if omitted)
    deps:        comma-separated task ids this depends on, or "none"
    files:       comma-separated repo paths this task may touch
    context:     comma-separated paths the task should read for background
    complexity:  integer 1 to 10 (default 5)
    humanGate:   true | false — pauses for a human review before merging this task
    pin:         "via model" — pin an exact channel, e.g. "claude-code opus"
    floor:       cheap | mid | frontier — minimum capability tier for routing
    gates:       nested list, any of build | test | lint | evidence | scope | acceptance | review
    acceptance:  nested list (REQUIRED, non-empty). Each item is either a typed oracle or plain text:
                 - command: <shell>   (oracle: command — exit code)
                 - test: <name>       (oracle: test — named test)
                 - judge: <rubric>    (oracle: judge — LLM-judged, free text)
                 - <plain text>       (compat: compiles as judge oracle, warns)
-->

## T1: Scaffold the feature
- goal: Lay the groundwork for the feature
- shape: implement
- files: src/feature.ts
- context: docs/design.md
- complexity: 4
- acceptance:
  - feature module exists and exports its entry point
  - npm test stays green

## T2: Cover it with tests
- goal: Add tests for the feature
- shape: tests
- deps: T1
- files: tests/feature.test.ts
- complexity: 3
- floor: cheap
- acceptance:
  - new tests pass
  - coverage floor holds
