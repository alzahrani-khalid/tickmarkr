<!-- drovr:spec -->
# Native spec: compiler delivery

## T1: Build the native compiler
- goal: Compile the complete native task surface
- shape: implement
- deps: none
- files: src/compile/native.ts, src/compile/index.ts
- context: docs/native.md, src/graph/schema.ts
- complexity: 8
- humanGate: true
- pin: claude-code opus
- floor: frontier
- gates:
  - build
  - test
  - lint
  - evidence
  - scope
  - acceptance
- acceptance:
  - every native field reaches the graph
  - malformed fields fail loudly

## T2: Test native detection
- goal: Keep native and generic markdown routing distinct
- shape: tests
- deps: T1
- files: tests/compile/native.test.ts
- context: fixtures/sample.native.md
- complexity: 3
- humanGate: false
- acceptance:
  - marked markdown selects native
  - marker-less markdown stays PRD
