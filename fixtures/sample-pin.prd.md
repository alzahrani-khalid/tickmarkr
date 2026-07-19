# Sample PRD: pinned delivery

## T1: Implement pinned compiler work
- shape: implement
- complexity: 7
- files: src/compiler.ts, src/types.ts
- pin: claude-code sonnet
- acceptance:
  - compiler returns a graph

## T2: Verify pinned compiler work
- shape: tests
- deps: T1
- files: tests/compiler.test.ts
- humanGate: true
- acceptance:
  - tests reject malformed input
  - reviewer approves the output
