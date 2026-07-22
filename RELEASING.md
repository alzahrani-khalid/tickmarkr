# Releasing tickmarkr

## The two-repository split — how it was actually executed

Development happens in the **private** repository (`alzahrani-khalid/tickmarkr-dev`); publishing
happens from the **public** repository (`alzahrani-khalid/tickmarkr`). The split was executed as a
rename dance, in this order:

1. The private repository was originally named `alzahrani-khalid/tickmarkr`. It was **renamed to
   `alzahrani-khalid/tickmarkr-dev` first**, and every local checkout's `origin` was repointed to
   the new name.
2. With the `tickmarkr` name freed, the **public `alzahrani-khalid/tickmarkr` repository was
   created fresh** and seeded with a squashed export (see below).
3. The npm **trusted-publisher binding was re-saved** against the new public repository — required
   because of how the binding actually pins (next section).

### Trusted publishing follows repository identity, not name

npm's trusted-publisher binding follows the repository **identity** (GitHub's immutable internal
repository ID), not the `owner/name` string. When the private repository was renamed, the saved
binding silently followed the renamed `tickmarkr-dev` repository; the first publish from the newly
created public `tickmarkr` repository failed with `E404` until the binding was **re-saved** against
the public repository. After any repository rename or re-creation, the binding must be re-saved:

1. Open the package on npm → **Publishing access** → **Trusted publishers**.
2. Save the GitHub Actions trusted publisher against the repository that actually publishes:
   - **Organization or user:** `alzahrani-khalid`
   - **Repository:** `tickmarkr` (the public repository)
   - **Workflow filename:** `release.yml`
3. Save. No `NPM_TOKEN` GitHub secret is required — the workflow authenticates via OIDC
   (`permissions: id-token: write`).

**Symptom to remember:** a publish that fails with `E404` from a workflow that previously worked is
the trusted-publisher binding pointing at the wrong repository identity — re-save it.

## Release flow (guarded — publishes only from the public repository)

[`.github/workflows/release.yml`](.github/workflows/release.yml) is a shared tracked file: the
export ships it verbatim, so the identical workflow exists in both repositories. Its publish job
carries a repository-identity guard:

```yaml
if: github.repository == 'alzahrani-khalid/tickmarkr'
```

A `v*` tag pushed in the private `tickmarkr-dev` repository therefore **skips the publish job
entirely** — no billing, no doomed OIDC publish. Tagging the private repository does not release
anything; publication happens only when the tag is pushed in the public repository.

Per release:

1. In the private repository: bump `version` in `package.json`, commit, and run the export in
   mirror publish mode (below). Review the mirror commit, then push the mirror's `main`.
2. In the **public** repository (the mirror), tag the export commit and push the tag:

   ```bash
   git tag -a v1.70.0 -m "v1.70.0"
   git push origin v1.70.0
   ```

3. The tag push runs `release.yml` in the public repository:
   - `npm install -g npm@11` (OIDC trusted publishing needs a current npm)
   - `npm ci`
   - `npm run build`
   - `npm run lint`
   - `npm test`
   - `npm publish --provenance --access public` (only if all checks pass)

Publish is fail-closed: a failing build, lint, or test blocks publication.

## Post-publish local sync (mandatory)

A successful publish is not done until the operator machine runs it. Immediately after the
registry shows the new version:

1. `npm i -g tickmarkr@latest` — registry propagation can lag a minute; if the next step still
   shows the prior release, wait and retry once.
2. `tickmarkr version` must report exactly the just-published version. A mismatch is a hard
   stop: diagnose the publish or the install — never leave the machine half-updated (a stale
   binary silently skips daemon gates; see the version preflight in the agent docs).
3. `tickmarkr init --agent --force --docs` in every active tickmarkr workspace (this
   repository and each consumer repository) to refresh the scaffolded `.agents`/`.claude`
   skills and agent-docs blocks to the shipped versions. The `--agent` flag is required:
   plain `init --force` skips the skill install entirely when scaffolds already exist
   (verified live on the first run of this ritual). Stale scaffolded skills in a consumer
   repository have carried defective launch guidance before (OBS-99) — the refresh closes
   that class.

## Public GitHub export (squashed snapshot)

The public `tickmarkr` repository is a **squashed** export — no `.planning/`, `specs/`,
`.tickmarkr/`, operator history, or private documentation. The private development repository retains full history; the public repository follows an append-only model with one commit per release.

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

The public repository maintains **append-only history** with one commit per release. Instead of force-pushing, each export is committed on top of a persistent clone by the script itself:

1. Clone the public repository (one time):

   ```bash
   git clone git@github.com:alzahrani-khalid/tickmarkr.git tickmarkr-public-mirror
   ```

2. For each release, run the export in mirror publish mode:

   ```bash
   bash scripts/export-public.sh --onto /path/to/tickmarkr-public-mirror
   ```

   After building and leak-checking the export exactly as above (a leak aborts before the mirror
   is touched), `--onto`:
   - fetches the mirror's `origin` and **resets the mirror clone to its own `origin/main`**
     (`git reset --hard origin/main`) before applying anything;
   - removes the mirror's tracked files with `git rm` only — it never runs a filesystem delete
     against the mirror, so the mirror's own `.git` metadata directory is never at risk (the
     retired manual recipe's `rm -rf -- */ *.* .*` glob could match `.git`);
   - extracts the export's committed tree on top;
   - records a single commit on top of `main` — `tickmarkr <version> — public export`, with the
     version read from the export's own `package.json`;
   - **never pushes**.

3. Review the mirror commit, then push manually:

   ```bash
   git -C /path/to/tickmarkr-public-mirror show --stat
   git -C /path/to/tickmarkr-public-mirror push origin main   # normal fast-forward, never force-push
   ```

The public history is fully reviewable and fork-friendly: every external fork has a stable merge-base, and each release is a single diffable commit pinned by a tag.

**Do not force-push:** Public history is append-only. Force-pushing orphans external forks and invalidates open pull requests. Each release is one new commit on top of `main`.
