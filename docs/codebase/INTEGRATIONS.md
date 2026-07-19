# External Integrations

**Analysis Date:** 2026-07-18

> Tickmarkr is a spec-driven orchestration harness for AI coding **agent CLIs**. It deliberately has no
> database, no backend services, and no network APIs — this is a stated invariant in `CLAUDE.md`
> ("state is files + git only"). What would normally be "external integrations" in a web app are,
> here, **subprocess CLIs**: seven AI coding-agent CLIs it dispatches work to, plus the `herdr` terminal
> multiplexer CLI it optionally uses as an execution driver. Every integration in this document is a
> local binary invoked with `spawn`/`bash -lc`, never an HTTP call.

## APIs & External Services

**AI coding-agent CLIs (the "workers"):**

Tickmarkr never calls a vendor HTTP API directly. It shells out to a locally installed CLI, which handles its own auth/billing with the vendor. Each adapter implements the same `WorkerAdapter` interface (`src/adapters/types.ts:10-20`): `probe()`, `channels()`, `headlessCommand()`, `interactiveCommand()`, `invoke()`, `parse()`.

- **claude-code** (`claude` binary) - vendor `anthropic` - `src/adapters/claude-code.ts`
  - Headless: `claude -p "$(cat <prompt>)" --model <model> --permission-mode acceptEdits --output-format text`
  - Interactive: `claude --model <model> --permission-mode acceptEdits "$(cat <prompt>)"`
  - Also the default adapter for `plan`/`spec` shape tasks, the acceptance judge, and the stall-consult role (`src/config/config.ts:218-219,320-322`)
- **codex** (`codex` binary) - vendor `openai` - `src/adapters/codex.ts`
  - Headless: `codex exec --sandbox workspace-write --model <model> "$(cat <prompt>)"`
  - Interactive: `codex -a never -s workspace-write --model <model> "$(cat <prompt>)"`
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
- `HERDR_ENV=1` - enables the herdr visible-pane driver
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
