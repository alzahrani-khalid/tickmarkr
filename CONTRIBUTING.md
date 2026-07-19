# Contributing to tickmarkr

## Public repository

This repository is the public face of tickmarkr: a **squashed export of private development**.
Each npm release lands here as a verified snapshot (one commit per release, append-only history).
Issues and pull requests belong on this repo; accepted changes run through the same verification
gates as all tickmarkr work in the private pipeline and ship in the next release export.

**Contribution credit:** when your pull request is accepted, your authorship is preserved via a
`Co-authored-by:` trailer on the release commit that carries your change into this repository.

## Versioning

Before the next major version (currently pre-2.0), **minor versions may break** APIs, config, or
behavior without a major bump. Every intentional break is documented in [CHANGELOG.md](CHANGELOG.md).
If you depend on tickmarkr programmatically or in CI, pin a specific version and read the changelog
before upgrading.

## Support

Support is **best effort for the latest version only** — no SLA, no guaranteed response time.
Older releases receive security fixes at maintainer discretion only. Agent CLI authentication,
billing, and vendor-specific issues belong upstream; tickmarkr support covers the harness itself on
macOS and Linux (WSL untested).

## Development Setup

```bash
git clone <your fork>
cd tickmarkr
npm install
npm run build   # tsc → dist/
npm link        # exposes tickmarkr/tkr bins
```

## The Green Bar

All changes must pass:

```bash
npm run build   # TypeScript compilation (strict mode)
npm test        # Unit + integration tests (zero-token fake adapter only)
npm run lint    # oxlint linting
```

Coverage floor: `src/{graph,route,gates,run}/**` must stay at lines 80% / functions 80% / branches 70%. Run `npm run test:coverage` locally before opening a PR.

## Design Invariants

Every change to tickmarkr must respect these five immutable rules — they are not implementation details, but the contract the gates enforce:

1. **`acceptance[]` required on every task** — a spec is invalid without explicit acceptance criteria
2. **New engagements consolidate to `tickmarkr/<runId>` branches only** — never main; sign-off is always the operator's call
3. **Gates never trust worker claims** — tickmarkr independently verifies everything
4. **State is files + git only** — no database, no external services
5. **Machine-parseable verdicts** — worker/judge/review/consult prompts end with structured JSON trailers; parse defensively, fail closed

These invariants are law at the codebase boundary. When contributing, respect them exactly.

## Spec-Driven Workflow

tickmarkr itself uses the same methodology it enforces: write a native spec (`.tickmarkr.spec.md`, marked with `<!-- tickmarkr:spec -->`), give every task real `acceptance[]` criteria, then compile/plan/run it and let the gates independently verify the diff before merge. Small fixes and docs can go straight to a PR; non-trivial changes sketch as specs first.

## Testing

- **`npm test`** — vitest unit + integration; uses a deterministic fake adapter, spends zero tokens
- **`npm run test:coverage`** — same suite with coverage measurement
- **`npm run e2e`** (opt-in) — real-CLI end-to-end testing; does spend tokens, requires an installed agent CLI

Tests in `tests/e2e/` are opt-in because they consume real API quota. Core logic tests belong in `tests/` and must never call a real agent CLI.

## Filing Issues

For bugs or rough edges: open a GitHub issue with reproduction steps. For systemic abnormalities discovered during real engagements (surprising or recurring behavior), the maintainer logs these as numbered observations (`OBS-NN`) in `.planning/OBSERVATIONS.md` with status (`OPEN` / `CLOSED-FIXED` / `CLOSED-MITIGATED`) and closure details.

## Adding a Worker Adapter

New agent CLI support is one new file implementing the `WorkerAdapter` interface in `src/adapters/types.ts` — id, vendor, probe, channels, headlessCommand, interactiveCommand, invoke, and parse. Use an existing adapter as a template (e.g., `src/adapters/codex.ts`), then register it with one line in `src/adapters/registry.ts`. No other file needs to know about it.

## Code Standards

- TypeScript strict mode, no ESLint or Prettier configured — match the surrounding file's style: 2-space indent, double quotes, semicolons, trailing commas
- Lines run long by design; dense single-line object literals and chained operations are normal
- `npm run build` (tsc) is the only enforced static check
- Avoid comments unless the WHY is non-obvious; well-named identifiers are self-documenting
- No unrequested abstractions: one implementation = no interface, one product = no factory, one value = no config
- Deletion over addition; the simplest working change wins — but only once you understand the problem end-to-end

## License

By contributing, you agree that your contributions will be licensed under the MIT License (see LICENSE file).
