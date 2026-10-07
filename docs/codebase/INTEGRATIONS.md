# External Integrations

**Analysis Date:** 2026-07-18

> Tickmarkr is a spec-driven orchestration harness for AI coding **agent CLIs**. It deliberately has no
> database, no backend services, and no network APIs — this is a stated invariant in `CLAUDE.md`
> ("state is files + git only"). What would normally be "external integrations" in a web app are,
> here, **subprocess CLIs**: seven AI coding-agent CLIs it dispatches work to, plus the `herdr` terminal
> multiplexer CLI it optionally uses as an execution driver and the `orca` CLI it uses as an
> auto-detected-inside-Orca or explicitly named one. Every integration in this document is a
> local binary invoked with `spawn`/`bash -lc`, never an HTTP call.

## APIs & External Services

**AI coding-agent CLIs (the "workers"):**

Tickmarkr never calls a vendor HTTP API directly. It shells out to a locally installed CLI, which handles its own auth/billing with the vendor. Each adapter implements the same `WorkerAdapter` interface (`src/adapters/types.ts:10-20`): `probe()`, `channels()`, `headlessCommand()`, `interactiveCommand()`, `invoke()`, `parse()`.

- **claude-code** (`claude` binary) - vendor `anthropic` - `src/adapters/claude-code.ts`
  - Headless: `claude -p "$(cat <prompt>)" --model <model> --permission-mode acceptEdits --output-format text`
  - Interactive: `claude --model <model> --permission-mode acceptEdits "$(cat <prompt>)"` — same size fallback as codex (OBS-931): over `promptArgvCeiling()` the builder returns `null` and the headless row runs in the pane; `resumeCommand` keeps the inline shape.
  - Also the default adapter for `plan`/`spec` shape tasks, the acceptance judge, and the stall-consult role (`src/config/config.ts:218-219,320-322`)
- **codex** (`codex` binary) - vendor `openai` - `src/adapters/codex.ts`
  - Headless: `codex exec --sandbox workspace-write --dangerously-bypass-hook-trust --disable plugins -c 'mcp_servers={}' --model '<model>' - < '<prompt>'` — prompt on stdin (OBS-889). `headlessCommand` is GRANTLESS (v2.6.7 T4, D-1046): judge, review (`src/gates/llm.ts`), consult (`src/run/consult.ts`) and the model probe launch it with no `writable_roots` argument at all, because those seats read the checkout and never commit.
  - Worker headless (`invoke()`): `codex exec --sandbox workspace-write --dangerously-bypass-hook-trust --disable plugins -c 'mcp_servers={}' -c "sandbox_workspace_write.writable_roots=[$(tkr_common=$(git rev-parse --path-format=absolute --git-common-dir); tkr_gitdir=$(git rev-parse --absolute-git-dir); if [ "$tkr_gitdir" != "$tkr_common" ]; then printf '"%s",' "$tkr_gitdir"; fi; printf '"%s/objects","%s/refs","%s/logs"' "$tkr_common" "$tkr_common" "$tkr_common")]" --model '<model>' - < '<prompt>'` — the same form plus the worker grant, built by a module-private worker builder; it is what a headless Codex worker launches and what the daemon runs in the pane when the interactive row below returns `null` (the real worker fallback). Zero-config rendering: per dispatch, `codexMcpSuppressionFlags()` also appends `-c 'mcp_servers.<name>.enabled=false'` for every server named in the operator's `$CODEX_HOME/config.toml`.
  - Interactive: `codex -a never -s workspace-write --dangerously-bypass-hook-trust --disable plugins -c 'mcp_servers={}' -c "sandbox_workspace_write.writable_roots=[$(tkr_common=$(git rev-parse --path-format=absolute --git-common-dir); tkr_gitdir=$(git rev-parse --absolute-git-dir); if [ "$tkr_gitdir" != "$tkr_common" ]; then printf '"%s",' "$tkr_gitdir"; fi; printf '"%s/objects","%s/refs","%s/logs"' "$tkr_common" "$tkr_common" "$tkr_common")]" --model '<model>' "$(cat '<prompt>')"` — the real TUI (OBS-930): the prompt is the `[PROMPT]` positional because codex's TUI has no file/stdin form, and it is the LAST argument. Argv-safe since `countLiveSuites` reads a command's first four tokens only (OBS-889). `CODEX_INPUT_BOX` (captured composer, `tests/fixtures/codex-input-box`) declares the editor for the herdr driver. Same per-dispatch MCP suppression as the headless row. Size fallback (OBS-930 Linux): the inlined prompt is one argv string and Linux caps one at 131072 bytes, so a prompt file over `promptArgvCeiling()` (`src/adapters/types.ts`: linux 120000, others 900000) makes `interactiveCommand` return `null` and the daemon journals `worker-mode-fallback` and runs the worker headless row (`invoke()`, grant included) in the pane.
  - Git metadata grant (`CODEX_GIT_GRANT`, v2.6.6 K / D-912): the two WORKER rows (worker headless and interactive) carry ONE shell fragment the launching shell expands at the worktree cwd — the worktree's own gitdir (only when it differs from the common dir), `<common>/objects`, `<common>/refs` and `<common>/logs`: exactly what a linked-worktree branch commit writes. No common-root fallback: an ordinary checkout gets no gitdir root and its commit fails closed, and `packed-refs` is never granted. Only Codex workers carry it: judge, review (`src/gates/llm.ts`) and consult (`src/run/consult.ts`) launch the grantless headless row, so the grant is a security boundary for workers, and a non-worker seat gets no writable git metadata at all. The shipped `[common]` grant (≤ 2.6.5) and D-910's `[common, gitdir]` let a sandboxed seat write `<common>/hooks` and `<common>/config`, which unsandboxed git later runs. K closes that shared hooks/config grant only; it does not claim a complete sandbox boundary.
  - Doctor's worker-grant probe (`src/adapters/codex-commit-check.ts`) executes those exact bytes through `sh` at a throwaway linked worktree under `codex sandbox` (zero tokens): an ordinary control file, a real commit on a unique fixture branch, and two unique non-hook files — one in `<common>/hooks`, one in the common root — that must stay unwritten. The closed table persists as `codexCommit` in doctor.json: `allowed` (branch commit landed, both hostile members denied), `protected` (commit denied, controls readable), `escape` (ANY hostile member written) and `unknown` (unreadable or contradictory receipts, including a foreign change to the probe branch). The probe deletes only its own fixture ref and reflog, through an old-value check, and never touches real hooks or config. `escape` is a BLOCKING security warning: doctor's codex row fails and plan prints it beneath every Codex worker row and, once, for Codex judge/review/consult seats — those seats launch grantless, but they run against the shared metadata a worker's grant let the sandbox write, so for those non-worker roles only `escape` adds a plan line. Routing never reads the verdict, and run does not refuse on it.
  - Seat-run checkout Git (v2.6.7 T4, `src/run/git-trust.ts`): a worker's grant makes its linked gitdir seat-writable, so host Git in that checkout re-derives authority on EVERY covered invocation, caching no verdict — the expected common directory comes from the seat-denied gitfile and an ordinary `<common>/worktrees/<name>` layout (`trustedCommonDir(cwd)`), never from the mutable `commondir`. The shell wrappers (`shell` login false/true, `sh`, `shOk`, `shGit`, `shGitOk`, every pre-spawn retry included), `preserveWorktree`, the journal's owed-identity git (and every owed-check fold, before a memoised proof can answer) and doctor's post-sandbox probe git throw `GitTrustRefusal` naming the file before spawning when `commondir` is missing or resolves anywhere else (the linked layout, not `commondir`'s presence, decides that a checkout is linked) or when the trusted common config enables `extensions.worktreeConfig` and the linked gitdir holds `config.worktree`. Owed `diff`/`show`/`log` add `--no-ext-diff --no-textconv`. `linkNodeModules` writes only the independently derived real `info/exclude`.
  - Caller-scoped git config (v2.6.8 T2, `src/run/git.ts`): ownership follows the ENTRY, never `login` or the command text. `shGit`/`shGitOk` are tickmarkr's OWN git: only their children get `core.fsmonitor=false` and `core.hooksPath=/dev/null` appended last to `GIT_CONFIG_PARAMETERS` (named keys only, not arbitrary executable drivers), whatever the repository or an inherited `GIT_CONFIG_COUNT`/`GIT_CONFIG_PARAMETERS` says. Evidence (`git rev-list`, `git diff --stat`), review (`changedPaths`, `mirrorsVersionOnly`, `fetchTaskDiff` full and `-U0`), Herdr adoption (`git rev-parse --show-toplevel`) and the verification job's job-identity HEAD read (`git rev-parse HEAD`) read through that entry. `shell`, `sh` and `shOk` are PAYLOAD entries — gate build/test/lint commands, test and command acceptance oracles and every suite they launch — and keep the operator's own git config, so a suite's own hooks fire under its configured settings. Users on tickmarkr ≥ 2.6.8 therefore need no suite-side scrub: the old remedy (a suite that needs real hooks clears the forced pair from `GIT_CONFIG_PARAMETERS` for its own git) is retired. This repository's own `tests/setup.ts` D-1196 containment stays only because this suite is still gated by an INSTALLED ≤ 2.6.7 harness that forces the pair and forwards its token into every shell; it is harness-only, not a user remedy, and its removal is a 2.6.9 repository leg once a ≥ 2.6.8 harness runs this suite.
  - Local verification-job ownership (v2.6.8 T2, `src/run/verification-job.ts`): a child shell carries `TICKMARKR_VERIFICATION_JOB_TOKEN` only inside a process-local verification job, stamped with that job's freshly minted report id; outside one, an inherited (foreign) token is dropped from the child, never forwarded, and the parent environment is unchanged. A nested `verify` launched from a parent job's payload mints its own job, so its receipts and its reap census name only its own members; the outer owner still reaps the nested shells through its reservation's capability and recorded birth-checked process groups: a nested verify registers its shells in the reservation FILE, never in the owner's in-memory holder, so before the outer job ends it carries every group that file records back to the reservation's in-process owner — its own reservation, or an enclosing `withRepositoryLease` one it reused — even when the outer job's own process census fails (that failure still fails the job), and that owner's release reaps them, so a token-less descendant a nested verify leaves behind cannot outlive the release even when no later owner shell refreshes the owner's roots.
  - Own-git pin (v2.6.8 T2, `ownGitPin` in `src/run/git-trust.ts`): in a linked checkout every own-git attempt (each EAGAIN retry re-derives it) gets, child-only, `GIT_DIR`, `GIT_COMMON_DIR` and `GIT_WORK_TREE` set to the canonical gitdir, trusted common directory and worktree root derived by that attempt's trust check — never `process.env`, never a payload, never a cached pin; an ordinary checkout or a non-repository gets none. The pin is chosen by the caller's ENTRY and never by the command text: tickmarkr reads no word of an own-git command, so every command — `git worktree add` in any spelling, quoted path arguments named `worktree` or `add` included — runs exactly as written, and `-C` gives no authority to leave the pinned checkout. A `commondir` rewritten between the check and the child, by a live worker or a surviving descendant, is then followed for neither config, hooks, `info/` nor objects.
  - Default own-git ref-store pin (v2.6.8 T2): git's ref store resolves shared refs through the gitdir's `commondir` FILE even under `GIT_COMMON_DIR`, so by DEFAULT every own-git child in a linked checkout also gets `GIT_REFERENCE_BACKEND=files://<view>`, overriding any inherited `GIT_REFERENCE_BACKEND`; an inherited `GIT_REF_STORAGE_FORMAT` is removed. `<view>` is a private directory of that attempt whose `refs`, `packed-refs`, `logs`, `worktrees` and `HEAD` link into the TRUSTED common directory, beside a `HEAD.lock` nothing removes; it is deleted once the child exits, and the child's output names the trusted common directory, never the view. No caller opts in and no inherited `GIT_CONFIG_PARAMETERS`/`GIT_CONFIG_COUNT` value can switch it off: across a rewritten `commondir`, HEAD, branch, status, diff and index reads return the real repository, and every ref write — `update-ref`, a commit, `branch -m`, `pack-refs`, `preserveWorktree`'s recovery ref, the daemon's replayed cherry-picks and preserved refs, `mergeTask`'s merge — lands only in the trusted store. git decides "linked" from the `commondir` file alone, so a `commondir` REMOVED before the child starts makes git treat the view as the repository: then no HEAD-relative write (commit, merge, cherry-pick, reset, checkout, `update-ref HEAD`) can take the view's `HEAD.lock`, and neither the main checkout's branch, its HEAD nor the task branch moves (the same lock refuses a write of the MAIN worktree's HEAD from a linked checkout's own git). Own-git children also run with `gc.auto=0` and `maintenance.auto=false`, so no detached gc or maintenance outlives the view it would read refs through. Only the files ref format can be viewed: a trusted common config whose `extensions.refStorage` names any other format is refused by name with `GitTrustRefusal`, never run unpinned. Before such a child spawns, the `git` its `PATH` resolves must prove it honours the pin (a fresh probe repository whose refs lack a ref that only the pinned probe store holds); a git that ignores `GIT_REFERENCE_BACKEND` is refused by name with `GitTrustRefusal`, never run unpinned. Then, for every own-git child, the attempt stamps `commondir` (device, inode, ctime) before reading it and, once the child exits, refuses the result with `GitTrustRefusal` naming `commondir` when that stamp moved in ANY way — rewritten, restored, removed or replaced — so a raced result is never returned. A `commondir` that is a symbolic link is refused before any child spawns. Users on tickmarkr ≥ 2.6.8 need no caller-owned config scrub for this: the pin is the product's.
  - Worktree capability (v2.6.8 T2): the capability is declared by the caller at its call site — never derived from the command, its tokens, login or cwd — and no call site leaves any pin. Exactly the five creating call sites declare it. `createWorktree`'s `worktree add -B` (`src/run/git.ts`) and `ensureIntegration`'s existing-branch add and `-b` add (`src/run/merge.ts`) declare `{ createsWorktree: "branch" }` through `shGit`/`shGitOk`: git writes a branch add's new HEAD as the symbolic branch ref, which the pin leaves intact, so their branch is created or moved only in the trusted store and they run exactly as written. Under ANY ref-store payload git stubs a DETACHED add's new HEAD as `ref: refs/heads/.invalid` and checks out nothing, so the daemon's baseline recapture (`src/run/daemon.ts`) and standalone `verify`'s base worktree (`src/cli/commands/verify.ts`) declare the detached capability by calling `addDetachedWorktree(cwd, dir, commitish)` (`src/run/git.ts`), whose every step is pinned: the commit-ish — a SHA, a branch name or `HEAD`, resolved in the CALLER's checkout, so a linked root's `HEAD` is the linked HEAD — is resolved to an object id under the default pin; the checkout is added `--no-checkout --detach` at that object id, so no ref decides what it checks out, with its ref store pinned to the trusted common directory itself (it writes no ref of the caller's checkout); then, pinned to the NEW checkout's own authority, its HEAD is written as that id, git's `refs/heads/.invalid` stub ref is deleted and the checkout is populated. A step raced by a `commondir` change is refused by name with the trusted commit read and nothing taken from the rewritten store. Rollback keeps the authority the operation derived once from the trusted layout (gitfile and `<common>/worktrees/<name>`, never `commondir`): every one of the five adds declares what it creates, and an add refused after its child ran removes, before the refusal returns, its checkout directory, its trusted registration and the branch it created (deleted) or moved (restored to the value read before the add) — through that trusted common directory as an ordinary repository (`GIT_DIR` naming it, every inherited common-dir, work-tree, ref-backend, index and object redirect removed), never the caller's checkout, so it completes while the caller's `commondir` STAYS hostile and the hostile store is left byte-identical. That rollback is cleanup, so it runs outside the task's execution budget — a budget that expired after the add registered never refuses or skips it — with each step bounded by the command timeout; a step that fails is reported on the refusal (still a `GitTrustRefusal` naming `commondir`), never swallowed. `removeWorktree` — the callers' `finally` removal of those checkouts and the dead-owner sweeps — removes through the same trusted common directory, derived once from the caller's layout, outside any execution budget, and throws a failed step instead of ignoring it, so it too never refuses or skips a removal because the caller's `commondir` is hostile or the budget expired.
  - NAMED RESIDUALS, the complete set — not protected: when the trusted common config already enables `extensions.worktreeConfig`, a `config.worktree` planted AFTER the check can still be read (the present-file check alone does not close that race); the user's own Git follows whatever metadata a seat planted; and operator-invoked raw Git (`init`, `approve`, `compile`, model lints) and the remaining raw read-only lookups (`codex.ts` grant discovery, `codex-commit-check.ts`'s probe worktree) remain outside this release (D-1042, 2.6.9).
  - Model ids in `DEFAULT_CONFIG.tiers.codex` are live-verified against the installed CLI's `models_cache.json` (see comment block at `src/config/config.ts:244-249`)
- **cursor-agent** (`cursor-agent` binary) - vendor `cursor` - `src/adapters/cursor-agent.ts`
  - Headless: `cursor-agent -p "$(cat <prompt>)" --model <model> --force --output-format text`
  - Interactive: `cursor-agent --model <model> --force --trust "$(cat <prompt>)"` (`--trust` needed because every task runs in a fresh worktree and the trust dialog would otherwise block unattended dispatch)
- **opencode** (`opencode` binary) - vendor `mixed` (routes to Kimi K2 / GLM-4.7 under the hood) - `src/adapters/opencode.ts`
  - Headless: `opencode run -m <model> "$(cat <prompt>)"`
  - Interactive: `opencode -m <model> --prompt "$(cat <prompt>)"`
- **pi** (`pi` binary) - vendor `mixed` (scoped models via openai/glm-5.2) - `src/adapters/pi.ts`
  - Headless: `pi -p "$(cat <prompt>)" --model <model> --permission-mode acceptEdits --output-format text`
  - Interactive: `pi --model <model> --permission-mode acceptEdits "$(cat <prompt>)"`
- **grok** (`grok` binary) - vendor `xai` - `src/adapters/grok.ts`
  - Headless: `grok -p "$(cat <prompt>)" --model <model> --permission-mode acceptEdits --output-format text`
  - Interactive: `grok --model <model> --permission-mode acceptEdits "$(cat <prompt>)"`
- **kimi** (`kimi` binary) - vendor `moonshot` - `src/adapters/kimi.ts`
  - Headless: `kimi -p "$(cat <prompt>)" --model <model> --permission-mode acceptEdits --output-format text`
  - Interactive: `kimi --model <model> --permission-mode acceptEdits "$(cat <prompt>)"`

**Auth/health probing:**
- `probeVersion(bin)` runs `<bin> --version` with a 10s timeout; installed+exit 0 is treated as "authed assumed", with real auth/quota failures only detected later from CLI output at dispatch time (`src/adapters/claude-code.ts:31-40`, note field: "auth assumed; verified at dispatch")
- Quota/auth exhaustion is never predicted, only detected reactively from output via `QUOTA_RE = /rate.?limit|quota|usage limit|out of credits|insufficient credit|\b429\b/i` (`src/adapters/types.ts:172`)
- `tickmarkr doctor` probes all adapters in parallel and writes the capability matrix to `.tickmarkr/doctor.json` (`src/adapters/registry.ts:77-80,300-310`, `src/cli/commands/doctor.ts`)

**Test-only adapter:**
- `fake` (`src/adapters/fake.ts`) - `FakeAdapter` reads a JSON script (`TICKMARKR_FAKE_SCRIPT` env var) and replays scripted shell output + a synthetic `TICKMARKR_RESULT` trailer instead of invoking any real CLI. The entire vitest suite runs on this, zero tokens spent. Not present unless the env var is set.

## Driving Skills (Orchestration)

Tickmarkr can be driven by a top-level agent CLI — either Claude Code or Codex — using portable workflow skills that discover repository guidance and execute the compile → plan → run → report loop. This is an alternative to subprocess-driven automation; the choice is orthogonal to the worker-adapter routing.

**Portable skill installation:**
- Run `tickmarkr init --agent` in your repository. This installs three reusable orchestration skills:
  - `tickmarkr-loop` — run a single spec autonomously
  - `tickmarkr-auto` — run multiple specs autonomously
  - `tickmarkr-overseer` — supervise a two-tier orchestrator/supervisor setup (optional, herdr-only)
- Skills are installed to the discoverable location for each host: `.agents/skills/` for Codex, `.claude/skills/` for Claude Code (or both, if both are present). Each host also receives repository guidance: `AGENTS.md` for Codex, `CLAUDE.md` for Claude Code.

**Explicit skill invocation:**
- **Claude Code:** `/tickmarkr-loop`, `/tickmarkr-auto` (slash-command invocation)
- **Codex:** `$tickmarkr-loop`, `$tickmarkr-auto` (dollar-sign invocation in a message)

Codex also recognizes implicit skill triggers based on the skill description's keywords (e.g., "run this spec with tickmarkr").

**Repository guidance vs. reusable skills:**
- **Persistent repository guidance** (`CLAUDE.md` or `AGENTS.md`): Automatically loaded by the agent on every session, contains durable repository-specific rules, workflows, and operating procedures. Generated by `tickmarkr init --agent --docs`; persists independently of skill versions.
- **Reusable invoked skills** (`/tickmarkr-loop`, `$tickmarkr-loop`, etc.): portable workflows that route to the agent's installed skill library, designed to work across different repositories. Updated when the tickmarkr package is updated.

**Claude Code driver support remains unchanged:**
The native Claude Code integration remains fully supported. Repositories with `.claude/skills` continue to discover and invoke `/tickmarkr-loop` and `/tickmarkr-auto` via Claude Code's native `/` slash-command interface. No changes are required to existing Claude Code workflows.

## Terminal / Execution Driver

**herdr (terminal multiplexer CLI):**
- Optional integration, gated by `HERDR_ENV=1` (`src/drivers/herdr.ts:50-51`); when absent, tickmarkr falls back to `SubprocessDriver` (invisible child processes, `src/drivers/subprocess.ts`)
- `HerdrDriver` (`src/drivers/herdr.ts`) shells out to the `herdr` binary for every lifecycle step of a visible, named agent pane:
  - `herdr agent start <name> --cwd <dir> --no-focus -- bash` - open a pane (`:31-37`)
  - `herdr agent get <name>` - resolve current pane id from the durable agent name, since pane ids compact when panes close (`:20-29,65-73`)
  - `herdr pane run <pane> <cmd>` - dispatch a command into the pane (`:39-43`)
  - `herdr wait output <pane> --match <pattern> [--regex] --timeout <ms>` - block for a completion marker (`:45-53`)
  - `herdr wait agent-status <pane> --status <status> --timeout <ms>` - block for herdr's own agent-status detection (`:55-63`)
  - `herdr pane read <pane> --source recent-unwrapped --lines <n>` - scrape pane output (`:75-79`)
  - `herdr notification show <msg> --sound <sound>` - OS-level notification, e.g. paging the operator when a pane is "blocked" (`:81-83`)
  - `herdr pane close <pane>` - best-effort teardown (`:85-88`)
- Every LLM call site (worker, acceptance judge, cross-vendor review, stall-consult) can run as a visible named herdr pane when `visibility.llm: "pane"` is set (`DEFAULT_CONFIG` defaults to `"headless"`, `src/config/config.ts:325`); headless is the default, pane is the opt-in (`src/gates/llm.ts` `runHeadless` vs `runViaDriver`)

**orca (Orca app CLI) — detected inside Orca, explicitly named elsewhere:**
- `auto` resolves `HerdrDriver` first when `HERDR_ENV=1`, then `OrcaDriver` only when both Orca-authored markers `TERM_PROGRAM=Orca` and `ORCA_TERMINAL_HANDLE` are present, then `SubprocessDriver` (`orcaHostDetected`, `src/drivers/index.ts`). Selection reads environment only: it executes no binary or runtime probe. Outside an Orca terminal, select it explicitly by name with `--driver orca` or `driver: orca` (validated at the argv boundary by `parseDriverOverride`). Once Orca is selected either way, an unreachable runtime fails loudly on Orca and is never substituted with a hidden subprocess worker
- `OrcaDriver` (`src/drivers/orca.ts`) shells out to the `orca` binary for terminal lifecycle only — `terminal create|list|read|send|wait|show|close` plus `status` for runtime identity — all through one shared envelope parser that fails closed on an `ok:false` refusal (`ORCA_RESPONSE_FAMILIES`, `:35-36`)
- `--worktree` takes a **selector**, so every call names `path:<abs>` and verifies the checkout that came back; letting `active`/`current` resolve whatever the UI has focused would hand orca the isolation the worktree exists for (`src/drivers/orca.ts` header, T2)
- **tickmarkr retains worktrees, gates and merge authority; orca supplies visible terminals only:**
  - *Worktrees* — `OrcaDriver.worktree()` (`src/drivers/orca.ts:960-962`) calls tickmarkr's own `createWorktree` (`src/run/git.ts:214-221`) and hands orca the resulting path as a `path:` selector; orca never creates, moves or removes a checkout
  - *Gates* — the seven-gate battery (`build test lint evidence scope acceptance review`, `src/graph/schema.ts`, driven by `src/gates/run-gates.ts`) runs in tickmarkr's own process against the commits in that worktree, identically under every driver; a driver has no gate seam to influence
  - *Merge* — only green tasks are consolidated, by `mergeTask` (`src/run/merge.ts:59`), onto the run-scoped `tickmarkr/<runId>` branch (`integrationBranch`, `:34-36`) and never onto `main` (CLAUDE.md invariant); orca has no merge path
- Smoke-tested against a real Orca by `tests/e2e/orca-smoke.e2e.test.ts`, which is doubly self-gated (`TICKMARKR_E2E=1` **and** the production reachability probe), launches no agent CLI, and reports the absence of either as a runner-visible vitest skip of its live leg (`ctx.skip()`, counted under `skipped`) rather than as a pass

## Data Storage

**Databases:**
- None. No SQL/NoSQL database, no ORM.

**State store (git + filesystem, in place of a database):**
- `git` itself - the only "database". Task isolation = one git worktree + branch per task (`createWorktree`, `src/run/git.ts:31-36`); task completion = a merge into a run-scoped integration branch `tickmarkr/<runId>` (`src/run/merge.ts:6-22`, never `main` — see CLAUDE.md invariant); gates read state via `git diff`/`git status` against a captured baseline (`src/gates/baseline.ts`, `src/gates/scope.ts`, `src/gates/evidence.ts`)
- `.tickmarkr/graph.json` - the compiled `RunGraph` (tasks, deps, status, evidence), read/written directly as JSON, no locking beyond single-daemon-process assumption (`src/graph/graph.ts`)
- `.tickmarkr/runs/<runId>/journal.jsonl` - append-only event ledger used to resume a run and replay task statuses (`src/run/journal.ts:58-88`)
- `.tickmarkr/runs/<runId>/telemetry.jsonl` - append-only per-task cost/outcome rows for `tickmarkr report` (`src/run/journal.ts:90-107`)
- `.tickmarkr/doctor.json` - last `tickmarkr doctor` capability-probe snapshot (`src/adapters/registry.ts:300-310`)
- `.tickmarkr/worktrees.noindex/<branch>/` - working directories for task and integration-branch worktrees (OBS-49: `.noindex` suffix keeps macOS Spotlight off worktree churn)
- The entire `.tickmarkr/` directory is auto-gitignored the first time it's created (`tickmarkrDir()` writes a `.gitignore` containing `*`, `src/graph/graph.ts:9-13`) — none of this state is ever committed to the host repo's own history

**File Storage:**
- Local filesystem only. No object storage (S3-equivalent), no CDN.

**Caching:**
- None.

## Authentication & Identity

**Auth Provider:**
- None inside tickmarkr. Each agent CLI (`claude`, `codex`, `cursor-agent`, `opencode`, `pi`, `grok`, `kimi`) owns its own vendor authentication (subscription login or API key) entirely out-of-band; tickmarkr only detects *whether* a CLI is installed and responds successfully to `--version`/first dispatch (`src/adapters/claude-code.ts:31-40`). Tickmarkr itself never stores, reads, or transmits a credential.

## Monitoring & Observability

**Error Tracking:**
- None (no Sentry/Bugsnag/etc.). Failures surface as gate results (`GateResult`, `src/gates/types.ts`) written into `.tickmarkr/graph.json` evidence and the run journal.

**Logs:**
- `console.log`/`console.error` to stdout/stderr only (e.g. `src/cli/index.ts:32-37`, `SubprocessDriver.notify`, `src/drivers/subprocess.ts:66-68`)
- Structured history lives in the journal/telemetry JSONL files described above, not in a logging service

## CI/CD & Deployment

**Hosting:**
- None — tickmarkr is a CLI tool, not a hosted service. Distributed as the npm package `tickmarkr` (`package.json:2,9`).

**CI Pipeline:**
- `.github/workflows/ci.yml` - on push/PR to `main` or `milestone/**` branches: runs `npm ci`, `npm run build`, `npm run lint`, `npm test`, `npm run test:coverage`, and an export-public selftest to verify the public snapshot builds and tests independently (`scripts/export-public.sh`). Coverage thresholds enforced on `src/{graph,route,gates,run}` at lines/functions 80%, branches 70% (`vitest.config.ts:32`).
- `npm test` — vitest unit+integration with fake adapter only, no tokens spent; coverage floors enforced on `src/{graph,route,gates,run}`
- `npm run e2e` — real-CLI end-to-end (`TICKMARKR_E2E=1`, spends tokens; needs ≥1 agent CLI installed), run manually per `CLAUDE.md`

## Environment Configuration

**Required env vars:**
- None required for basic operation (`compile`/`plan`/`doctor` work with zero env vars).

**Optional env vars:**
- `HERDR_ENV=1` - makes auto select the herdr visible-pane driver before any other host
- `TERM_PROGRAM=Orca` together with `ORCA_TERMINAL_HANDLE` - makes auto select Orca; outside an Orca terminal, name `--driver orca` explicitly
- `TICKMARKR_FAKE_SCRIPT=<path>` - enables the deterministic fake adapter (tests only)
- `TICKMARKR_E2E=1` - unskips the real-CLI e2e suite
- `XDG_CONFIG_HOME=<dir>` - relocates the global config directory

**Secrets location:**
- N/A — tickmarkr holds no secrets. `.env*` files are absent from the repo. Agent-CLI credentials (Anthropic/OpenAI/Cursor logins or API keys) live wherever each respective CLI stores them (outside tickmarkr's control and outside this repo).

## Webhooks & Callbacks

**Incoming:**
- None. Tickmarkr has no listener/server process.

**Outgoing:**
- None (no HTTP calls anywhere in `src/` — confirmed by absence of `fetch`/`http`/`https`/`axios`/`WebSocket` usage). The closest analogue to a "callback" is the machine-parseable trailer contract each agent must emit in its final message — `TICKMARKR_RESULT {"ok":..., "summary":..., "deviations":[...]}` for workers (`src/adapters/prompt.ts:22-24,39-73`), and bare JSON verdicts for the judge/review/consult roles (`TICKMARKR-JUDGE` in `src/gates/acceptance.ts:22-38`, `TICKMARKR-REVIEW` in `src/gates/review.ts:48-63`, `TICKMARKR-CONSULT` in `src/run/consult.ts:24-47`) — all parsed defensively and made to fail closed on malformed output, per the `CLAUDE.md` invariant.

---

*Integration audit: 2026-07-18*
