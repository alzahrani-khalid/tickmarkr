# Releasing tickmarkr

## One-time setup (operator)

Before the first automated publish, configure **npm trusted publishing** for the `tickmarkr` package:

1. Open the package on npm → **Publishing access** → **Trusted publishers**.
2. Add a GitHub Actions trusted publisher:
   - **Organization or user:** `alzahrani-khalid`
   - **Repository:** `tickmarkr`
   - **Workflow filename:** `release.yml`
3. Save. No `NPM_TOKEN` GitHub secret is required — the workflow authenticates via OIDC (`permissions: id-token: write`).

## Release flow

1. Bump `version` in `package.json` and commit.
2. Tag and push a `v*` tag (e.g. `v1.58.0`):

   ```bash
   git tag -a v1.58.0 -m "v1.58.0"
   git push origin v1.58.0
   ```

3. [`.github/workflows/release.yml`](.github/workflows/release.yml) runs on the tag push:
   - `npm ci`
   - `npm run build`
   - `npm run lint`
   - `npm test`
   - `npm publish --provenance --access public` (only if all checks pass)

Publish is fail-closed: a failing build, lint, or test blocks publication.

## Public GitHub export (squashed snapshot)

The public `tickmarkr` repository is a **squashed** export — no `.planning/`, `specs/`, `.tickmarkr/`, operator history, or private documentation. The private development repository retains full history; the public repository follows an append-only model with one commit per release.

### Prerequisites

- Clean working tree (`git status` shows no changes).
- OSS table-stakes files present at HEAD (`LICENSE`, `CONTRIBUTING.md`, `SECURITY.md`, `CODE_OF_CONDUCT.md`).

### Export

```bash
bash scripts/export-public.sh
```

The script:

1. Refuses to run on a dirty working tree (exits non-zero, writes nothing).
2. Archives `HEAD` into a fresh temp directory, excluding:
   - `.planning/` (private planning and operational records)
   - `specs/` (private specification files — a stub is generated for compiler tests)
   - `.tickmarkr/`, `.overseer/`, `.claude/` (private state and configuration)
   - internal documentation (private reference pages and archived analysis only)
   - `ASSESSMENT-*.md`, `CLAUDE.md`, `.gitignore` (private operator files)
   - internal measurement scripts
   - any `*.local.*` files
3. Generates a `.gitignore` covering `node_modules/`, `dist/`, `coverage/`, `.tickmarkr/`, environment files, and editor/OS debris.
4. `git init` + one orphan commit: `tickmarkr <version> — public export`
5. Prints the export path and runs leak checks:
   - scans for retired vocabulary in committed history
   - obvious secret-pattern scan (API keys, private keys, tokens)
6. **Never pushes** and never mutates the operator's checkout.

### Public documentation included

The export ships these public reference pages from `docs/codebase/`:
- `ARCHITECTURE.md` — system design and module organization
- `CLI-DESIGN.md` — command-line interface design decisions
- `CONVENTIONS.md` — code style and file-naming conventions
- `INTEGRATIONS.md` — agent CLI integration points
- `STACK.md` — runtime dependencies and versions
- `STRUCTURE.md` — repository structure with relative paths
- `TESTING.md` — test framework, organization, and patterns

Private documentation pages (`.planning/`, `docs/superpowers/`, `docs/analysis/`, and `CONCERNS.md`) remain in the private repository.

### Publish to GitHub — append-only model

The public repository maintains **append-only history** with one commit per release. Instead of force-pushing, each export is committed on top of a persistent clone:

1. Clone the public repository (one time):
   ```bash
   git clone git@github.com:alzahrani-khalid/tickmarkr.git tickmarkr-public-mirror
   cd tickmarkr-public-mirror
   ```

2. For each release, sync the export into the persistent clone and commit:
   ```bash
   # From the export directory printed by export-public.sh
   cd /path/to/export
   
   # Copy the export tree into the public mirror
   cd /path/to/tickmarkr-public-mirror
   rm -rf -- */ *.* .* 2>/dev/null; true
   cd /path/to/export && git ls-files | tar --files-from - -c | (cd /path/to/tickmarkr-public-mirror && tar -xf -)
   
   # Verify the diff
   git diff --stat
   
   # Commit on top of main (one commit per release)
   git add -A
   git commit -m "tickmarkr $(grep -m1 'version' ../path/to/private/package.json | sed 's/.*"\([^"]*\)".*/\1/') — public export"
   
   # Push to main (normal fast-forward, never force-push)
   git push origin main
   ```

The public history is fully reviewable and fork-friendly: every external fork has a stable merge-base, and each release is a single diffable commit pinned by a tag.

**Do not force-push:** Public history is append-only. Force-pushing orphans external forks and invalidates open pull requests. Each release is one new commit on top of `main`.
