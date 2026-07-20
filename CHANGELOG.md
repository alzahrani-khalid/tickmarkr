# Changelog

This changelog documents breaking changes and major releases. **For per-release details, see [GitHub Releases](https://github.com/alzahrani-khalid/tickmarkr/releases).**

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
