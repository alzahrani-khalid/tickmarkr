# tickmarkr engagement

- **runId:** run-brand-pin
- **base ref:** abc123def456
- **branch:** tickmarkr/run-brand-pin
- **done:** 1
- **failed:** 0
- **human:** 0
- **verification:** passed — tip proof: reused — commit deadbeef; build: cached (reused) — carried, not re-run; test: verified fresh; lint: cached (reused) — carried, not re-run

## Usage & efficiency

- **fake:fake-1** — attempts/windows: 1; tokens: not measurable; price: not measurable; basis: no telemetry row
- **wall-clock:** 1m 30s
- **first-attempt rate:** not measurable
- **gate failures:** test: 1
- **consults:** 1
- **escalations:** 0

## Wall budget

- **window:** 1m 30s — each instant counted once, by priority interruption › test › semantics › worker › queue › other-gate › residual; task-time sums concurrent spans
- **interruption:** 0s (0%) · task-time 0s
- **test:** unknown — 1 row without a duration
- **semantics:** 0s (0%) · task-time 0s
- **worker:** unknown — 1 dispatch without a launch row
- **queue:** 0s (0%) · task-time 0s
- **other-gate:** unknown — 1 row without a duration
- **residual:** 1m 30s (100%) — unattributed, not proven idle
- **gate evidence:** fresh 0 · replay 0 · reuse 0 · unknown 2
- **suite telemetry (baseline test capture):** not recorded — this run's baseline holds no test capture

## Channels

- **fake:fake-1** — worker: 1, review: 0, consult: 0; tokens: unknown; money: unknown

## Audit trail

## T1

- **opinion:** unqualified opinion
- **attempts:** 1
- **channels tried:** fake:fake-1
- **routing:** floor cheap
- **route deviation:** —
- **tickmarks:**
  - build: pass — exit 0
  - test: fail — 1 failed
- **National Office:**
  - retry — fix the test
- **consolidation branch:** tickmarkr/run-brand-pin--T1
- **consolidation commit:** deadbeef
