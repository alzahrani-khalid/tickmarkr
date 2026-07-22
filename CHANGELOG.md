# Changelog

This changelog documents breaking changes and major releases. **For per-release details, see [GitHub Releases](https://github.com/alzahrani-khalid/tickmarkr/releases).**

## v1.68 — runs cockpit

This runs-cockpit release ships the fifth Fleet Studio tab with a journal timeline and run-level now-line, per-task gate ladder rendered through the status glyph vocabulary, attempt history naming typed failure reasons, a consult dossier viewer listing verdicts with persisted prompt content, a live per-channel cost ticker and tip-verify state line reusing the cost-signal formatter, human-gate approve routed through the existing approve path, interactive-harvest settle-retry at the parse boundary (OBS-111), and a default fork-cap for gate and verify children (OBS-110).

## v1.67 — fleet studio write path

This fleet-studio-write release adds staged-changes editing for fleet customization (pins, floors, prefer chain, allow/deny toggles, mode selection), a YAML diff modal that shows the overlay delta before atomic overlay write, live-run reload guards that surface "changes apply on next run" for active executions, and a repo↔global target toggle to draft changes in global config or workspace scope.

## v1.66 — fleet studio

This fleet-studio release ships a dependency-free terminal UI engine with alternate-screen rendering and incremental line repaint, the `tickmarkr ui` full-screen app exposing read-only Fleet, Routing, Preview, and Profile views, picker-parity candidate inspection so the studio never disagrees with the router, a plan dry-run preview with per-task routing consequences and cost signals, learned-routing profile inspection that names when a pin overrides a higher-scored channel, and retires the OBS-77 askTyped line-mode flow in favor of modal text input.

## v1.65 — fleet resilience

This fleet-resilience release adds typed worker-failure taxonomy for precise failover classification, quota-style free failover routing that limits retry burden, a transcript noise filter to clean consult dossiers, a doctor flag-drift warning to flag stale disable/allow policies, the quirk registry convention for provenance-tracked disable reasons, and macOS CI lanes for platform-specific workloads.

## v1.64 — gate integrity

This gate-integrity release adds a completion-faking checklist to judge and review prompts, requires quoted evidence from the judged diff, warns on vacuous command oracles at baseline, redacts secrets at journal and consult-dossier persistence seams, and closes status-watch narrators during run-end reconciliation.

## v1.63 — runtime integrity

The signal-reaper suite now runs in a serialized vitest project so its fixed fire deadline survives full-suite fork fan-out (OBS-98). Fatal setup errors after run-start append a terminal journal event before the daemon exits, status renders the recorded cause, and a baseline where every configured command is missing surfaces a wrong-environment warning (OBS-99). Compile refuses the pristine scaffold template init writes unchanged (OBS-100). Skills carry the OBS-99/101 verified-handoff and version-preflight fixes already on main.

## v1.62 — dispatch integrity

Worker dispatch now delivers a per-attempt script, never an inline line (OBS-85, verified pane delivery), eliminating paste-timing interleave corruption in codex channels. OBS-97 probe correctly handles brace glob patterns and single-character wildcards.

## v1.61 — review residue

The v1.60 pre-merge review panel's nine carried findings, retired: the mirror-publish
script's failure-recovery path is behaviorally tested and its diagnostics pinned; the
OBS-96 reproduction record names its amplified mechanism probe honestly; parked
human-gate tasks say so in `status`; FLEET.md's routing-precedence wording matches
route(); the fleet config module is split under the size ceiling; and compile now
rejects a `test:` acceptance oracle whose file scope cannot host a collectable test
(OBS-97).

## v1.60 — fleet integrity

Provenance notes survive unrelated fleet writes; the retired quality-env preview path is removed from routing; step-3 fleet editing re-prompts instead of hard-exiting; gate cells read at a glance; fresh-clone first-run test contention is fixed evidence-first; private release publish is guarded to the public repo identity; RELEASING.md matches the two-repository ritual.

## v1.59 — initial public OSS release and codex driving-agent support

v1.59 is the first public release on GitHub. Private development history (v1.0–v1.59) was squashed into a single import commit for the public repository; the private development repository retains complete history. Public repository history is append-only from this point forward (one commit per release).

- **Export boundary, fail-closed**: a dual-context allowlist manifest test verifies the public tree in both the private repository and the exported tree; nothing under `.planning/` or `specs/` ships (test inputs vendored into `tests/fixtures/`).
- **Codex as a driving agent**: `tickmarkr init --agent` installs the driving skills (`tickmarkr-loop`, `tickmarkr-auto`, `tickmarkr-overseer` with its pane watcher) into `.agents/skills/` with `AGENTS.md` guidance — the codex CLI now drives the loop as a first-class alternative to Claude Code, with per-host launch instructions in each skill.
- **Community surface**: issue and pull-request templates, support boundaries (solo project, best-effort, latest-version-only), a pre-2.0 versioning statement, and GitHub-only security/conduct reporting.
- **Standalone `npm test`** now provisions the build first — a fresh clone's first test run is green.

## v1.58 — OSS readiness groundwork

### Breaking changes in v1.38–v1.58

#### v1.38 — State directory and config locations

- `tickmarkr` now uses `.tickmarkr/` for on-disk state. Repositories created before v1.38 must migrate their existing state directory to `.tickmarkr/` before upgrading. Repositories with no existing state get a fresh `.tickmarkr/` on the next run; old state is not merged automatically.
- Global config is read only from `~/.config/tickmarkr/` (or `$XDG_CONFIG_HOME/tickmarkr/`). Move any existing global overlay to this path before upgrading.
- Native spec marker changed to `<!-- tickmarkr:spec -->`. Older markers are rejected at compile time.
- Resuming runs that started before v1.38 is not supported. Finish or discard in-flight pre-v1.38 engagements before upgrading.

#### v1.30–v1.37 — Tool versioning

- Configuration, state directory, and command-line interfaces stabilized.
- Binary names standardized; use `tickmarkr` and `tkr` for all work.

### Recent major features (v1.39–v1.58)

- **v1.51+**: Routing modes and tier matching — routes tasks to the most cost-effective channel within capability floors.
- **v1.52+**: Integrity hardening — enhanced gate verification and run-state assertions.
- **v1.54+**: Steering and failover improvements — more reliable task routing and error recovery.
- **v1.55+**: Docs-truth tests — automated verification that exported documentation remains accurate with code changes.
- **v1.56–v1.58**: OSS readiness — export boundary enforcement, public CI configuration, GitHub issue/PR templates, and append-only public history model.

## v1.38 — breaking changes (detailed)

### State directory

tickmarkr always uses `.tickmarkr/` for on-disk state. Repositories created before v1.38 must move their existing state directory to `.tickmarkr/` before upgrading. A repository with no migrated state gets a fresh `.tickmarkr/` on the next run; old state is not merged automatically.

### Global config

Global config is read only from `~/.config/tickmarkr/` (or `$XDG_CONFIG_HOME/tickmarkr/`). Move any existing global overlay to the current path before upgrading.

### Native spec marker

Native specs must start with `<!-- tickmarkr:spec -->`. Older markers are rejected at compile time.

### Resume

Resuming runs that started before v1.38 is not supported. Finish or discard in-flight pre-v1.38 engagements before upgrading.
