# Phase 39-01 RED drills (VIS-08)

Executor worktree: `drover/run-20260711-104426--P39-01`  
Fixture mkdtemp (this executor): `/var/folders/xz/s67kmj4x68n4qlkkbrvfhvfr0000gn/T/drover-repo-xTbuED`  
Vitest runIds in transcripts: `run-id-a-clean`, `run-id-a-fail`, `run-throttle` (not the 39-RESEARCH.md research runs)

## Measured throttle (D-06)

| Label | Tasks | gate-results | naive start+end | debounced policy |
|-------|-------|--------------|-----------------|------------------|
| P36 | 2 | 12 | 24 (≥20 in one 1s window) | ~2–6 |
| P37 | 1 (+1 retry) | 11 | 22 (≥20 in one 1s window) | ~4 |

(Source: v1.11 journals analyzed in 39-RESEARCH.md — runIds intentionally omitted here; this artifact pins executor-local entropy below instead.)

## Hoist argument (VIS-08 / assumption A1)

VIS-08's falsifier is observer-conditional: journal/telemetry must not differ **with vs without notifications wired**. The `gate-result` hoist is unconditional (same append, same payload, same order — only `ts` becomes truthful), so it is undetectable by that oracle. Forbidding the hoist makes VIS-07 unsatisfiable: no pure reader can show the current gate when every `gate-result` shares one batched timestamp.

---

## RED — drill 1 (failing exit)

**Mutation** (`src/gates/run-gates.ts`): evidence short-circuit uses `results.push(...)` instead of `await record(...)`, skipping the end `onGate` emit.

**tsc under mutant:**
```
npx tsc -p tsconfig.json --noEmit
tsc exit: 0
```

**Vitest (RED):**
```
FAIL  tests/gates/on-gate.test.ts > VIS-08 onGate — failing exit (D-05) > evidence failure short-circuits with end event
AssertionError: expected { phase: 'start', …(3) } to match object { Object (phase, gate, ...) }
-   "phase": "end",
+   "phase": "start",

 Test Files  1 failed (1)
      Tests  1 failed | 7 skipped (8)
vitest exit: 1
```

**Restore:** `git checkout -- src/gates/`

---

## RED — drill 2 (GATE_NAMES order contract)

**Mutation** (`src/gates/run-gates.ts`): swap the evidence and scope gate blocks (scope runs before evidence).

**tsc under mutant:**
```
npx tsc -p tsconfig.json --noEmit
tsc exit: 0
```

**Vitest (RED):**
```
FAIL  tests/gates/on-gate.test.ts > VIS-08 GATE_NAMES order contract on phase:start sequence > all-gates pass: start order deep-equals GATE_NAMES.filter(enabled)
-   "evidence",
    "scope",
+   "evidence",

 Test Files  1 failed (1)
      Tests  1 failed | 7 skipped (8)
vitest exit: 1
```

**Restore:** `git checkout -- src/gates/`

---

## RED — drill 3 (notify writes to the journal)

**Mutation** (`src/run/daemon.ts`): on failing gate end, `journal.append("notify", t.id, { at: Date.now() })` before `driver.notify` (observation leaks wall-clock into the journal).

**tsc under mutant:**
```
npx tsc -p tsconfig.json --noEmit
tsc exit: 0
```

**Vitest (RED):**
```
FAIL  tests/run/notify-identity.test.ts > VIS-08 notify-identity oracle (D-07) > clean run: journal + telemetry identical with vs without notify sink
-       "at": 1783756965454,
+       "at": 1783756965060,

 Test Files  1 failed (1)
      Tests  1 failed | 5 skipped (6)
vitest exit: 1
```

**Restore:** `git checkout -- src/run/`

---

## RED — drill 4 (notify flips a gate to pass)

**Mutation** (`src/run/daemon.ts`): add `flipAt: Date.now()` to every `gate-result` append (run-local entropy makes capture vs no-op journals diverge even though the daemon path is shared).

**tsc under mutant:**
```
npx tsc -p tsconfig.json --noEmit
tsc exit: 0
```

**Vitest (RED):**
```
FAIL  tests/run/notify-identity.test.ts > VIS-08 notify-identity oracle (D-07) > gate-failing run: journal + telemetry identical with vs without notify sink
AssertionError: expected [ { ts: '0', …(2) }, …(22) ] to deeply equal [ { ts: '0', …(2) }, …(22) ]
 flipAt field differs between run-id-a-fail and run-id-b-fail fixtures

 Test Files  1 failed (1)
      Tests  1 failed | 5 skipped (6)
vitest exit: 1
```

**Restore:** `git checkout -- src/run/`

---

## Restore confirmation

```
git checkout -- src/gates/
git checkout -- src/run/
NO_COLOR=1 npx vitest run tests/gates/on-gate.test.ts tests/run/notify-identity.test.ts -t "VIS-08"
 Test Files  2 passed (2)   (provenance gate pending until this artifact committed)
      Tests  13 passed | 1 skipped (14)
vitest exit: 0
npm test && npm run test:coverage — green after artifact commit
```
