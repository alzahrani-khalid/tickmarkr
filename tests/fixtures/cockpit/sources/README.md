# cockpit/sources — vendored capture sources for the v1.80 studio-cockpit demo

**Provenance:** except for the source-specific refresh recorded below, these are byte-for-byte
copies taken 2026-07-25 from the live, gitignored `.tickmarkr/` tree of this repository at commit
`285ca5b8`, by the orchestrator at spec-authoring time. Vendored at spec time for the same reason
the pre-v1.13 `journal-corpus` was vendored at plan time: tickmarkr workers execute in isolated git
worktrees that **cannot see** the gitignored live `.tickmarkr/runs/` or `.tickmarkr/doctor.json`, so
a capture the workers could perform themselves does not exist. Freezing them here is what makes the
fixture law satisfiable at all.

**These are captures. They are data, not text.** Per the v1.80 design contract §11 and
`docs/codebase/TESTING.md`, a frame or source fixture is captured verbatim from the real surface and
committed as-is. **Never hand-edit a file in this directory** — not to tidy it, not to shorten it,
not to make an assertion pass. A hand-authored, flush-left fixture let a recognition test pass for
four consecutive versions while live recognition was broken the entire time (2026-07-24). Editing a
capture to satisfy a test re-commits that defect. If a fixture is wrong for the job, capture a
different real one and record its provenance here.

**Do NOT regenerate from live `.tickmarkr/`** — that defeats the frozen-corpus property (HYG-06:
never fixture against live, mutating state). These files are frozen as of the date above.

## What each capture carries, and why it was chosen

| file | source | why |
|---|---|---|
| `run-20260724-231138.journal.jsonl` | v1.79 signal-truth engagement, 214 events | The **healthy-but-eventful** run cockpit source. Carries 5 `escalation` events, dispatch attempts up to 3, a `failover-deviation`, a `consult-verdict`, 64 `gate-result`s and a passing `tip-verify`. This is the capture that exercises design-contract §6.1's two incident-derived requirements — `escalated N` in the status strip, and attempt + adapter always on screen — against real events rather than invented ones. |
| `run-20260724-194619.journal.jsonl` | earlier 2026-07-24 engagement, 94 events | The **tip-verify-failure** source. Carries a `tip-verify-failed` event, a `run-resume`, and **two** `run-end` events whose `tipVerify` values differ (`failed`, then `passed` after re-verification). This is simultaneously the OBS-146 fixture (a watch surface that hid a tip-verify failure) and the §8 fail-closed fixture (when the `tip-verify` event and `run-end.tipVerify` disagree, the surface must show FAILED). Both properties are present in real captured data; neither had to be authored. |
| `doctor.json` | live doctor cache, 7 harnesses + `autoPrefer` | The setup cockpit source (§6.2). Real detection results across `claude-code`, `codex`, `cursor-agent`, `grok`, `kimi`, `opencode`, `pi` — including denied and unauthenticated channels, so the `glyph + word` state rendering and the inline denial reasons render from real states rather than a designed happy path. |
| `run-20260725-025004.interrupted.journal.jsonl` | the v1.80 demo run halted deliberately 12 min in, 7 events | The **interrupted-run** source, and the corpus's first NEGATIVE fixture. Carries `run-start`, three `task-dispatch` and three `phase-start` events for T1/T2/T3 — dispatched work, **no `run-end`**, and a daemon that no longer exists. The surface must render these tasks as *interrupted*, never as *running*: the halted run's own watch pane reported `daemon pid 5706 dead` while still showing all three as running with elapsed ticking, contradicting itself in a single frame. Same fail-closed principle as a tip-verify disagreement. **Verified byte-identical to `.tickmarkr/runs/run-20260725-025004/journal.jsonl`** before vendoring — the fixture law binds negative fixtures exactly as it binds positive ones, and a hand-authored "must not render as running" frame would re-commit the defect in the opposite direction. |
| `config.global.yaml` | fresh `tickmarkr init` output, built from commit `f1f8256b`, 75 lines | The **base** half of the setup cockpit's base-vs-overlay pair (§4, §6.2). Recaptured 2026-07-25 by building the checkout and running `node dist/cli/index.js init --global-dir <empty temporary directory>`; the missing global config made the current product write its unmodified `configTemplate()` bytes. A copied `doctor.json` cache prevented live probes and supplied no configuration. |
| `config.repo.yaml` | live repo overlay, `.tickmarkr/config.yaml`, 106 lines | The **overlay** half of that pair, and the source for the Fleet, Gates, Consults and Reviewers sections (§6.2). Carries a real deny list with observation-cited provenance, dated tier citations, a judge pin, a `diffCap`, and steering `prefer` chains — so the inline denial reasons and the overlay diff render from a genuinely rich real config rather than a designed sample. Vendored 2026-07-25 with the same amendment. |

## The two config captures carry no secrets, and that was verified before vendoring

Both were read in full and scanned for credentials, tokens and keys before being copied. Neither
carries any: the fresh global capture is the product's commented template with no active settings,
and the repo capture is gates, judge, routing and tiers with provenance comments. The
`~/.claude.json` mention inside the global capture's comments is a filesystem path in prose, not a
credential. **A coverage gap is never a reason to commit a secret** — had either file carried one
it would not have been vendored, and the spec would have narrowed its promise instead.

Their relationship is the real one the product implements, not an arrangement invented for the demo:
the fresh commented base parses as an empty global layer, then `loadConfigWithMode` layers the repo
overlay over that base over built-in defaults. `unifiedYamlDiff` is the existing renderer for the
captured byte difference. The demo therefore gets a genuine fresh-base-vs-live-overlay pair, and the
overlay-diff panel has real bytes on both sides.

## Scan exemptions that already apply here

`tests/repo/readme-hero.test.ts`'s logo-duplication scan skips `fixtures/` by design: a capture that
happens to contain a rendered banner is recorded terminal output, not a second source of truth, and
must never be hand-edited to satisfy a scan. That exemption is what allows a verbatim capture to be
committed unmodified.
